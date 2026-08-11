import { contentHash, type MemoryDoc, parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  authoredEdgesFor,
  disclosureTextFor,
  entityRowsFor,
  FILE_COLUMNS,
  ftsTextFor,
  projectFile,
  wordCountOf,
  workspaceOf
} from "../src/project.js"
import { memoryHtml } from "./harness.js"

/**
 * The row projection, as a pure function. Everything asserted here is what makes a fresh rebuild and
 * the incremental path produce identical rows: the projection is the ONE place a `MemoryDoc` becomes
 * SQL, so there is no second implementation to disagree with.
 */

const AT = "2026-08-01T12:00:00Z"

const parse = (html: string) => Effect.runSync(parseMemory(html))

const project = (path: string, html: string) =>
  projectFile({
    path,
    blobSha: "blob-1",
    contentHash: contentHash(parse(html).article.html),
    doc: parse(html),
    indexedAt: AT
  })

describe("workspaceOf", () => {
  it("reads the slug directly under projects/", () => {
    expect(workspaceOf("projects/memhtml/a.html")).toBe("memhtml")
    expect(workspaceOf("projects/memhtml/nested/a.html")).toBe("memhtml")
  })

  it("is null outside the projects bucket", () => {
    for (const path of ["areas/x/a.html", "resources/x/a.html", "archive/2026/areas/x/a.html"]) {
      expect(workspaceOf(path)).toBeNull()
    }
  })

  it("is null for a file sitting directly in projects/ with no slug directory", () => {
    expect(workspaceOf("projects/a.html")).toBeNull()
  })
})

describe("wordCountOf", () => {
  it("counts whitespace-delimited runs, the tokenization FTS and the embedder both use", () => {
    expect(wordCountOf("one two three")).toBe(3)
    expect(wordCountOf("  spaced   out \n words ")).toBe(3)
    expect(wordCountOf("")).toBe(0)
    expect(wordCountOf("   ")).toBe(0)
  })
})

describe("ftsTextFor", () => {
  it("joins title, gist, and body with newlines", () => {
    const doc = parse(memoryHtml({ title: "A title", claim: "The claim.", body: "The prose." }))
    const text = ftsTextFor(doc)
    expect(text.split("\n")[0]).toBe("A title")
    expect(text).toContain("The claim.")
    expect(text).toContain("The prose.")
  })

  it("separates the parts so a term at one boundary cannot fuse with the next", () => {
    const doc = parse(memoryHtml({ title: "alpha", claim: "beta." }))
    // Space-joining would make "alpha beta" a matchable phrase neither field states.
    expect(ftsTextFor(doc)).toContain("alpha\n")
  })

  /**
   * The empty part is no longer reachable through the PARSER — `@memhtml/html` constraint 1 now refuses
   * an empty `<mark>`, so `parseMemory` cannot hand this function a doc with `gist: ""`. It is still
   * reachable through the OTHER producer of a `MemoryDoc`: `newMemoryDoc` builds the pre-write doc
   * with `gist: ""` (the extractions come back on the next read), and `gist` is a plain
   * `Schema.String` besides. So the filter stays load-bearing and is tested on a doc built directly,
   * which is also the honest shape of the test — this is a unit test of a projection, not of a parse.
   *
   * This test previously reached an empty gist via `claim: "<code>x</code>"`, relying on the gist
   * rule excluding `<code>`. That file now fails the gate, which is the point of the new constraint:
   * a memory whose indexed gist would be empty must not be writable at all.
   */
  it("drops an empty part rather than emitting a blank line", () => {
    const parsed = parse(memoryHtml({ title: "A title", claim: "The claim.", body: "Prose." }))
    const gistless: MemoryDoc = { ...parsed, article: { ...parsed.article, gist: "" } }
    expect(ftsTextFor(gistless)).not.toContain("\n\n")
    expect(ftsTextFor(gistless).split("\n")).toEqual(["A title", parsed.article.bodyText])
  })
})

describe("disclosureTextFor", () => {
  const doc = () =>
    parse(
      memoryHtml({
        title: "T",
        claim: "The load-bearing claim.",
        body: "Ordinary prose after the claim.",
        facets: [{ name: "Applies to", value: "ALB deploys" }],
        citations: ["checkout-api sev2"],
        details: { summary: "How this was learned", body: "The provenance narrative." },
        aside: "A scope caveat that is not the claim."
      })
    )

  it("leads with the claim", () => {
    expect(disclosureTextFor(doc()).split("\n")[0]).toBe("The load-bearing claim.")
  })

  it("includes the <summary> headline, which is Tier 2", () => {
    expect(disclosureTextFor(doc())).toContain("How this was learned")
  })

  it("excludes the <details> body, which is Tier 3 and reaches an agent only through memory_read", () => {
    expect(disclosureTextFor(doc())).not.toContain("The provenance narrative")
  })

  it("excludes the <aside>, because quoting a caveat presents the exception as the rule", () => {
    expect(disclosureTextFor(doc())).not.toContain("A scope caveat")
  })

  it("includes the facets as name: value and the citations", () => {
    const text = disclosureTextFor(doc())
    expect(text).toContain("Applies to: ALB deploys")
    expect(text).toContain("checkout-api sev2")
  })

  it("is a strict subset of what body_text carries", () => {
    const parsed = doc()
    // body_text is the search surface and holds everything; disclosure is narrower by construction.
    expect(parsed.article.bodyText).toContain("The provenance narrative")
    expect(parsed.article.bodyText).toContain("A scope caveat")
  })
})

describe("entityRowsFor", () => {
  it("splits a type:name reference at the first colon", () => {
    const doc = parse(
      memoryHtml({ title: "T", claim: "C.", entities: ["service:checkout-api", "person:sanju"] })
    )
    expect(entityRowsFor(doc)).toEqual([
      { entityType: "service", entityName: "checkout-api" },
      { entityType: "person", entityName: "sanju" }
    ])
  })

  it("keeps a name that itself contains colons", () => {
    const doc = parse(memoryHtml({ title: "T", claim: "C.", entities: ["url:https://x.test/a"] }))
    expect(entityRowsFor(doc)).toEqual([{ entityType: "url", entityName: "https://x.test/a" }])
  })

  it("files a separator-less entity under `unknown` rather than dropping it", () => {
    const doc = parse(memoryHtml({ title: "T", claim: "C.", entities: ["checkout-api"] }))
    // The name is still a real handle a query can use; dropping it loses a hand-authored file's only
    // entity.
    expect(entityRowsFor(doc)).toEqual([{ entityType: "unknown", entityName: "checkout-api" }])
  })

  it("promotes every <dfn> term to a concept: entity", () => {
    const doc = parse(
      memoryHtml({ title: "T", claim: "C.", definedTerms: ["relevance order", "watermark"] })
    )
    expect(entityRowsFor(doc)).toEqual([
      { entityType: "concept", entityName: "relevance order" },
      { entityType: "concept", entityName: "watermark" }
    ])
  })

  it("promotes every <code data-lang> to a lang: entity", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        codeBlocks: [
          { code: "const x = 1", lang: "ts" },
          { code: "print(1)", lang: "py" }
        ]
      })
    )
    expect(entityRowsFor(doc)).toEqual([
      { entityType: "lang", entityName: "ts" },
      { entityType: "lang", entityName: "py" }
    ])
  })

  it("deduplicates two blocks in the same language into one lang: row", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        codeBlocks: [
          { code: "a", lang: "ts" },
          { code: "b", lang: "ts" }
        ]
      })
    )
    // A duplicate would fail the (path, type, name) primary key and roll back the whole batch.
    expect(entityRowsFor(doc)).toEqual([{ entityType: "lang", entityName: "ts" }])
  })

  it("claims no lang: row for an untagged block", () => {
    const doc = parse(memoryHtml({ title: "T", claim: "C.", codeBlocks: [{ code: "plain" }] }))
    expect(entityRowsFor(doc)).toEqual([])
  })

  it("deduplicates a term the author also wrote as a meta", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        entities: ["concept:watermark"],
        definedTerms: ["watermark"]
      })
    )
    // A duplicate would fail the (path, type, name) primary key and roll back the whole batch.
    expect(entityRowsFor(doc)).toEqual([{ entityType: "concept", entityName: "watermark" }])
  })
})

describe("authoredEdgesFor", () => {
  it("strips the leading slash off every href", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        links: [
          { rel: "memhtml-part-of", href: "/areas/arcs/x.html" },
          { rel: "memhtml-supersedes", href: "/archive/2026/areas/y.html" }
        ]
      })
    )
    const edges = authoredEdgesFor(doc, "areas/a.html", "sha256:aaa", AT)
    // findings-t1.md:22 — the href is the document-reference form; `edges` stores the git-tree form,
    // and the slashed form makes every join against `files.path` return nothing.
    expect(edges.map((edge) => edge.params[2])).toEqual([
      "areas/arcs/x.html",
      "archive/2026/areas/y.html"
    ])
  })

  it("derives the edge class from the rel rather than trusting a second field", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        links: [
          { rel: "memhtml-part-of", href: "/areas/arcs/x.html" },
          { rel: "memhtml-about-person", href: "/resources/people/sanju.html" }
        ]
      })
    )
    const edges = authoredEdgesFor(doc, "areas/a.html", "sha256:aaa", AT)
    expect(edges.map((edge) => edge.params[3])).toEqual(["memory", "person"])
  })

  it("drops a self-loop, which the table CHECK would otherwise fail the whole batch on", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        links: [{ rel: "memhtml-part-of", href: "/areas/a.html" }]
      })
    )
    // One hand-authored file pointing at itself must not fail the indexing of every file beside it.
    expect(authoredEdgesFor(doc, "areas/a.html", "sha256:aaa", AT)).toEqual([])
  })

  it("deduplicates a repeated (rel, dst) pair", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        links: [
          { rel: "memhtml-part-of", href: "/areas/arcs/x.html" },
          { rel: "memhtml-part-of", href: "/areas/arcs/x.html" }
        ]
      })
    )
    expect(authoredEdgesFor(doc, "areas/a.html", "sha256:aaa", AT)).toHaveLength(1)
  })

  it("marks every authored edge derived=0 with authored provenance", () => {
    const doc = parse(
      memoryHtml({
        title: "T",
        claim: "C.",
        links: [{ rel: "memhtml-part-of", href: "/areas/arcs/x.html" }]
      })
    )
    const sql = authoredEdgesFor(doc, "areas/a.html", "sha256:aaa", AT)[0]?.sql ?? ""
    // `derived = 0` is the firewall: the retention penalty counts only authored contradictions.
    expect(sql).toContain("0, 1.0, 'authored'")
  })
})

describe("projectFile", () => {
  it("binds one value per named column", () => {
    const projection = project("areas/oncall/a.html", memoryHtml({ title: "T", claim: "C." }))
    const insert = projection.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(insert?.params).toHaveLength(FILE_COLUMNS.length)
    // A mismatch binds every subsequent value to the wrong column while every CHECK still passes.
    expect(insert?.sql.match(/\?/g)).toHaveLength(FILE_COLUMNS.length)
  })

  it("reads archived from the PATH, not from memhtml-status", () => {
    const stale = project(
      "archive/2026/areas/a.html",
      memoryHtml({ title: "T", claim: "C.", status: "active" })
    )
    const insert = stale.writes.find((write) => write.sql.includes("INSERT INTO files"))
    const archivedAt = FILE_COLUMNS.indexOf("archived")
    const originAt = FILE_COLUMNS.indexOf("origin_path")
    // The path IS the state: eviction is the git mv, so a mis-stamped head must not let an archived
    // file re-enter retrieval and break the partial unique index's dedup guarantee.
    expect(insert?.params[archivedAt]).toBe(1)
    expect(insert?.params[originAt]).toBe("areas/a.html")
  })

  it("leaves origin_path null for an active file", () => {
    const active = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const insert = active.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(insert?.params[FILE_COLUMNS.indexOf("origin_path")]).toBeNull()
  })

  it("binds a task's status and due date, and nulls both on every other type", () => {
    const task = project(
      "areas/inbox/tasks/t.html",
      memoryHtml({
        title: "T",
        claim: "C.",
        memoryType: "task",
        taskStatus: "blocked",
        dueAt: "2026-08-09"
      })
    )
    const taskInsert = task.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(taskInsert?.params[FILE_COLUMNS.indexOf("task_status")]).toBe("blocked")
    expect(taskInsert?.params[FILE_COLUMNS.indexOf("due_at")]).toBe("2026-08-09")
    expect(taskInsert?.params[FILE_COLUMNS.indexOf("memory_type")]).toBe("task")

    const memory = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const memoryInsert = memory.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(memoryInsert?.params[FILE_COLUMNS.indexOf("task_status")]).toBeNull()
    expect(memoryInsert?.params[FILE_COLUMNS.indexOf("due_at")]).toBeNull()
  })

  it("keeps a task's chunk keyed on its content hash like any other memory", () => {
    // A task is chunked and embeddable exactly as a memory is — the exclusions are in the read
    // path, not the write path, so `memory_search --type task` has vectors to rank when asked.
    const task = project(
      "areas/inbox/tasks/t.html",
      memoryHtml({ title: "T", claim: "C.", memoryType: "task", taskStatus: "todo" })
    )
    expect(task.chunks).toHaveLength(1)
    expect(task.chunks[0]?.ordinal).toBe(0)
  })

  it("upserts the files row on its path rather than deleting it", () => {
    const projection = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const insert = projection.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(insert?.sql).toContain("ON CONFLICT(path) DO UPDATE SET")
    // Deleting the row would cascade the chunks away and take their embeddings with them.
    expect(projection.writes.some((write) => write.sql.startsWith("DELETE FROM files"))).toBe(false)
  })

  it("clears the multi-row children so the projection is idempotent", () => {
    const projection = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const deletes = projection.writes
      .filter((write) => write.sql.startsWith("DELETE FROM"))
      .map((write) => write.sql.split(" ")[2])
    expect(deletes).toEqual([
      "file_tags",
      "file_entities",
      "file_facets",
      "file_citations",
      "chunks",
      "edges"
    ])
  })

  it("deletes only the chunks whose body is no longer this file's", () => {
    const projection = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const chunkDelete = projection.writes.find((write) =>
      write.sql.startsWith("DELETE FROM chunks")
    )
    // A blanket delete would re-embed the whole file on any meta-only edit — which is exactly what the
    // hash's invariance under head edits exists to prevent.
    expect(chunkDelete?.sql).toContain("content_hash <> ?")
    expect(chunkDelete?.params[1]).toBe(projection.contentHash)
  })

  it("clears only its OWN authored edges, never an inbound one", () => {
    const projection = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const edgeDelete = projection.writes.find((write) => write.sql.startsWith("DELETE FROM edges"))
    // An inbound edge is another file's assertion; dropping it would rewrite someone else's document.
    expect(edgeDelete?.sql).toContain("src_path = ?")
    expect(edgeDelete?.sql).toContain("derived = 0")
    expect(edgeDelete?.sql).not.toContain("dst_path")
  })

  it("upserts a chunk on its content-derived id, which is what a rename rides on", () => {
    const projection = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const chunkInsert = projection.writes.find((write) =>
      write.sql.startsWith("INSERT INTO chunks")
    )
    expect(chunkInsert?.sql).toContain("ON CONFLICT(chunk_id) DO UPDATE SET path = excluded.path")
  })

  it("normalizes the path it was handed", () => {
    expect(project("/areas//a.html", memoryHtml({ title: "T", claim: "C." })).path).toBe(
      "areas/a.html"
    )
  })

  it("falls back to defaults the files table owns when the head states none", () => {
    const projection = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const insert = projection.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(insert?.params[FILE_COLUMNS.indexOf("confidence")]).toBe(1.0)
    expect(insert?.params[FILE_COLUMNS.indexOf("importance")]).toBe(5)
    expect(insert?.params[FILE_COLUMNS.indexOf("author")]).toBe("agent")
    expect(insert?.params[FILE_COLUMNS.indexOf("reprieves")]).toBe(0)
    expect(insert?.params[FILE_COLUMNS.indexOf("needs_revision")]).toBe(0)
  })

  it("is deterministic: the same inputs yield the same writes", () => {
    const html = memoryHtml({
      title: "T",
      claim: "C.",
      tags: ["a", "b"],
      entities: ["service:x"],
      facets: [{ name: "n", value: "v" }],
      links: [{ rel: "memhtml-part-of", href: "/areas/arcs/x.html" }]
    })
    expect(project("areas/a.html", html)).toEqual(project("areas/a.html", html))
  })
})

describe("frame_key at projection", () => {
  /** The `frame_key` value bound by a projection of one claim. */
  const keyFor = (claim: string, over: { readonly memoryType?: string } = {}) => {
    const projection = project(
      "areas/oncall/a.html",
      memoryHtml({
        title: "T",
        claim,
        ...(over.memoryType === undefined ? {} : { memoryType: over.memoryType }),
        ...(over.memoryType === "task" ? { taskStatus: "todo" } : {})
      })
    )
    const insert = projection.writes.find((write) => write.sql.includes("INSERT INTO files"))
    return insert?.params[FILE_COLUMNS.indexOf("frame_key")]
  }

  it("binds the frame key derived from the claim", () => {
    expect(keyFor("The capital of India is New Delhi.")).toBe("the capital of india is")
  })

  it("binds NULL when the claim states no frame shape", () => {
    // The guards fail closed, and NULL is the common case. `files_frame_key_active` skips these rows
    // entirely, which is what keeps the index the size of the keyed corpus.
    expect(keyFor("Water is wet.")).toBeNull()
    expect(keyFor("Priya adopted a dog named Waffles.")).toBeNull()
  })

  it("keys the GIST, not the body — a linking token in supporting prose must not decide the slot", () => {
    /**
     * The claim has no frame shape; the BODY does, twice over. If the projection keyed `body_text` or
     * `fts_text` instead of the gist, this row would take a key describing prose the memory never
     * asserts — and two memories whose bodies happened to share a sentence shape would be reported as
     * contradicting each other.
     *
     * (Verified by mutation: `frameKeyOf(doc.article.gist)` → `frameKeyOf(doc.article.bodyText)` in
     * `project.ts` makes this test fail with `"the owner of the deploy runbook is"`.)
     */
    const projection = project(
      "areas/oncall/a.html",
      memoryHtml({
        title: "T",
        claim: "Reversibility wins.",
        body: "The owner of the deploy runbook is Priya."
      })
    )
    const insert = projection.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(insert?.params[FILE_COLUMNS.indexOf("frame_key")]).toBeNull()
  })

  it("keys a TASK's claim too — the exclusion lives in the index and the lookup, not here", () => {
    /**
     * Deliberately NOT type-conditional. The write path stays uniform and both exclusions of tasks
     * are stated once each, in `files_frame_key_active`'s predicate and in `activeFramesFor`'s — the
     * same division `task_status` and the FTS text already follow. A `memory_type === 'task'` branch
     * here would be a third statement of the same rule, free to drift from the other two.
     */
    expect(keyFor("The capital of India is New Delhi.", { memoryType: "task" })).toBe(
      "the capital of india is"
    )
  })

  it("still binds one value per named column now that frame_key is among them", () => {
    // The list drives the column names, the placeholder count, AND the upsert's assignments, so this
    // is what makes adding a column a one-line change rather than a three-place one.
    const projection = project("areas/a.html", memoryHtml({ title: "T", claim: "C." }))
    const insert = projection.writes.find((write) => write.sql.includes("INSERT INTO files"))
    expect(FILE_COLUMNS).toContain("frame_key")
    expect(insert?.params).toHaveLength(FILE_COLUMNS.length)
    expect(insert?.sql).toContain("frame_key = excluded.frame_key")
  })

  it("is deterministic across projections of the same claim, and normalizes case and whitespace", () => {
    // Pure lexical: no clock, no random, no model. This is the property a rebuild's identical keys
    // rest on at the unit level; `indexer.test.ts` proves it end to end over a real repo.
    expect(keyFor("The capital of India is New Delhi.")).toBe(
      keyFor("THE   Capital of India   is New Delhi")
    )
  })
})
