import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { StorageFailure } from "@memhtml/contracts/errors"
import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { makeGit } from "@memhtml/store"
import { makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Result } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { DatabaseShape } from "../src/database.js"
import { makeGitPort, toDiffEntry, toStatusEntry } from "../src/git-adapter.js"
import type { GitPort } from "../src/git-port.js"
import { makeIndexer } from "../src/indexer.js"
import { makeFakeEmbedder, memoryHtml, withDb } from "./harness.js"

/**
 * The adapter, bound to `@memhtml/store`'s REAL `GitShape` over a real repository.
 *
 * This suite exists because of the phantom-port lesson: a declared port with no proven implementation
 * is worse than a missing one. `GitShape` and `GitPort` are genuinely incompatible — different return
 * types, different change vocabularies, a different error class — so "the store satisfies the port" is
 * a claim that has to be executed, not asserted by a structural type that would have accepted a
 * near-miss.
 */

const AT = "2026-08-01T12:00:00Z"

/** The production wiring, exactly as the CLI composes it. */
const portFor = (root: string): GitPort =>
  makeGitPort({
    git: makeGit(root),
    readFile: (path) => Effect.promise(() => readFile(join(root, path), "utf8")),
    fail: (operation) =>
      Effect.fail(StorageFailure.make({ operation: `git.${operation}` })) as never
  })

interface Fixture {
  readonly root: string
  readonly cleanup: () => Promise<void>
  readonly git: ReturnType<typeof makeGit>
}

const newFixture = async (): Promise<Fixture> => {
  const fixture = await Effect.runPromise(makeFixtureRepo())
  return { root: fixture.root, cleanup: fixture.cleanup, git: fixture.git }
}

/**
 * Write files with `node:fs` and commit them through the store's own `add`/`commit`.
 *
 * `GitShape` is a git client, not a filesystem, so it has no `writeFile` — seeding is the caller's
 * job. Committing through the store's real methods is what keeps the adapter the only translation
 * under test.
 */
const commit = (
  fixture: Fixture,
  files: ReadonlyArray<readonly [string, string]>,
  message: string
) =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      for (const [path, html] of files) {
        const full = join(fixture.root, path)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, html, "utf8")
      }
    })
    yield* fixture.git.add(files.map(([path]) => path))
    yield* fixture.git.commit(message)
  }).pipe(Effect.orDie)

/** Overwrite a working-tree file without staging it, so `status` reports it dirty. */
const writeDirty = (fixture: Fixture, path: string, html: string) =>
  Effect.promise(async () => {
    const full = join(fixture.root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, html, "utf8")
  })

describe("the store's GitShape satisfies the indexer's GitPort", () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await newFixture()
  })

  afterEach(() => fixture.cleanup())

  it("reads HEAD", async () => {
    const head = await Effect.runPromise(portFor(fixture.root).revParseHead())
    expect(head).toMatch(/^[0-9a-f]{40}$/)
  })

  it("lists the tree's blobs with their shas", async () => {
    await Effect.runPromise(
      commit(fixture, [["areas/notes/a.html", memoryHtml({ title: "A", claim: "C." })]], "add a")
    )
    const entries = await Effect.runPromise(
      portFor(fixture.root).lsTreeR("HEAD", ["areas", "projects", "resources", "archive"])
    )
    const entry = entries.find((candidate) => candidate.path === "areas/notes/a.html")
    expect(entry).toBeDefined()
    expect(entry?.blobSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it("decodes cat-file bytes to text, including multi-byte characters", async () => {
    const html = memoryHtml({ title: "Déployé", claim: "Le café naïve — 日本語." })
    await Effect.runPromise(commit(fixture, [["areas/notes/utf8.html", html]], "add utf8"))
    const port = portFor(fixture.root)
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const entries = yield* port.lsTreeR("HEAD", ["areas"])
        const entry = entries.find((candidate) => candidate.path === "areas/notes/utf8.html")
        const blobs = yield* port.catFileBatch([entry?.blobSha ?? ""])
        return blobs.get(entry?.blobSha ?? "")
      })
    )
    // The store yields Uint8Array; a naive per-byte decode would mangle these.
    expect(outcome).toContain("Déployé")
    expect(outcome).toContain("日本語")
  })

  it("reports the archive move as a rename carrying its source path", async () => {
    await Effect.runPromise(
      commit(fixture, [["areas/notes/a.html", memoryHtml({ title: "A", claim: "C." })]], "add a")
    )
    const before = await Effect.runPromise(portFor(fixture.root).revParseHead())
    await Effect.runPromise(
      Effect.gen(function* () {
        // `git mv` will not create the destination's parent, so the archive year directory is made
        // first — the same order the store's own archive path follows.
        yield* Effect.promise(() =>
          mkdir(join(fixture.root, "archive/2026/areas/notes"), { recursive: true })
        )
        yield* fixture.git.mv("areas/notes/a.html", "archive/2026/areas/notes/a.html")
        yield* fixture.git.commit("archive a")
      }).pipe(Effect.orDie)
    )
    const after = await Effect.runPromise(portFor(fixture.root).revParseHead())
    const diffs = await Effect.runPromise(portFor(fixture.root).diffNameStatus(before, after))

    // `fromPath` is what lets the indexer re-point the row instead of deleting it, which is the
    // difference between reusing an embedding and paying Bedrock again.
    expect(diffs).toEqual([
      {
        status: "R",
        path: "archive/2026/areas/notes/a.html",
        fromPath: "areas/notes/a.html"
      }
    ])
  })

  it("reports a modify and a delete with the right letters", async () => {
    await Effect.runPromise(
      commit(
        fixture,
        [
          ["areas/notes/keep.html", memoryHtml({ title: "Keep", claim: "C." })],
          ["areas/notes/gone.html", memoryHtml({ title: "Gone", claim: "Another claim." })]
        ],
        "seed"
      )
    )
    const before = await Effect.runPromise(portFor(fixture.root).revParseHead())
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* writeDirty(
          fixture,
          "areas/notes/keep.html",
          memoryHtml({ title: "Keep", claim: "A revised claim." })
        )
        yield* Effect.promise(() => rm(join(fixture.root, "areas/notes/gone.html")))
        yield* fixture.git.run(["add", "-A"])
        yield* fixture.git.commit("edit one, delete one")
      }).pipe(Effect.orDie)
    )
    const after = await Effect.runPromise(portFor(fixture.root).revParseHead())
    const diffs = await Effect.runPromise(portFor(fixture.root).diffNameStatus(before, after))

    // No add in this range, so there is nothing for git to pair the delete with — see the next test
    // for why an add and a delete in ONE range cannot be asserted separately.
    expect(
      [...diffs]
        .sort((left, right) => (left.path < right.path ? -1 : 1))
        .map((diff) => [diff.status, diff.path])
    ).toEqual([
      ["D", "areas/notes/gone.html"],
      ["M", "areas/notes/keep.html"]
    ])
  })

  it("reports a plain add", async () => {
    await Effect.runPromise(
      commit(fixture, [["areas/notes/a.html", memoryHtml({ title: "A", claim: "C." })]], "add a")
    )
    const before = await Effect.runPromise(portFor(fixture.root).revParseHead())
    await Effect.runPromise(
      commit(fixture, [["areas/notes/b.html", memoryHtml({ title: "B", claim: "D." })]], "add b")
    )
    const after = await Effect.runPromise(portFor(fixture.root).revParseHead())
    expect(await Effect.runPromise(portFor(fixture.root).diffNameStatus(before, after))).toEqual([
      { status: "A", path: "areas/notes/b.html" }
    ])
  })

  /**
   * Measured 2026-08-02 against real git: ANY delete-and-add pair of memory files in one diff range
   * is reported as a rename, because the format's `<head>` boilerplate — doctype, charset, the
   * `memhtml-*` meta block — dominates the similarity score even when the two claims share no words.
   *
   * This is why the previous two tests cover D and A in separate ranges. It is also harmless, and the
   * test after this one proves it: the indexer re-projects a rename's DESTINATION from the tree, so a
   * spurious pairing moves a row and then immediately overwrites it with the destination's real
   * content. Nothing downstream may gate on the similarity percentage.
   */
  it("pairs ANY delete-and-add of memory files into a rename, boilerplate being the reason", async () => {
    await Effect.runPromise(
      commit(
        fixture,
        [
          [
            "areas/notes/wildebeest.html",
            memoryHtml({ title: "Wildebeest", claim: "Wildebeest migrate across the Serengeti." })
          ]
        ],
        "seed"
      )
    )
    const before = await Effect.runPromise(portFor(fixture.root).revParseHead())
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* writeDirty(
          fixture,
          "areas/notes/bm25.html",
          memoryHtml({
            title: "Ascending bm25",
            claim: "A stronger bm25 match scores more negative."
          })
        )
        yield* Effect.promise(() => rm(join(fixture.root, "areas/notes/wildebeest.html")))
        yield* fixture.git.run(["add", "-A"])
        yield* fixture.git.commit("unrelated delete plus unrelated add")
      }).pipe(Effect.orDie)
    )
    const after = await Effect.runPromise(portFor(fixture.root).revParseHead())
    const diffs = await Effect.runPromise(portFor(fixture.root).diffNameStatus(before, after))

    // Two claims with no shared vocabulary, and git still calls it a rename.
    expect(diffs).toEqual([
      {
        status: "R",
        path: "areas/notes/bm25.html",
        fromPath: "areas/notes/wildebeest.html"
      }
    ])
  })

  it("pairs a similar delete-and-add into ONE rename, which is why nothing may gate on similarity 100", async () => {
    await Effect.runPromise(
      commit(fixture, [["areas/notes/a.html", memoryHtml({ title: "A", claim: "C." })]], "add a")
    )
    const before = await Effect.runPromise(portFor(fixture.root).revParseHead())
    await Effect.runPromise(
      Effect.gen(function* () {
        // Not a `git mv`: the file is deleted and a near-identical one written elsewhere, which is
        // what a hand-edited archive move looks like. `-M` still reports it as a rename, so the
        // indexer preserves the embedding — the outcome the content-keyed chunk id exists for.
        yield* writeDirty(
          fixture,
          "areas/notes/b.html",
          memoryHtml({ title: "A", claim: "C.", tags: ["moved"] })
        )
        yield* Effect.promise(() => rm(join(fixture.root, "areas/notes/a.html")))
        yield* fixture.git.run(["add", "-A"])
        yield* fixture.git.commit("hand-moved a to b")
      }).pipe(Effect.orDie)
    )
    const after = await Effect.runPromise(portFor(fixture.root).revParseHead())
    const diffs = await Effect.runPromise(portFor(fixture.root).diffNameStatus(before, after))
    expect(diffs).toEqual([
      { status: "R", path: "areas/notes/b.html", fromPath: "areas/notes/a.html" }
    ])
  })

  it("reports an uncommitted edit as dirty and not deleted", async () => {
    await Effect.runPromise(
      commit(fixture, [["areas/notes/a.html", memoryHtml({ title: "A", claim: "C." })]], "add a")
    )
    await Effect.runPromise(
      writeDirty(fixture, "areas/notes/a.html", memoryHtml({ title: "A", claim: "Uncommitted." }))
    )
    const status = await Effect.runPromise(portFor(fixture.root).statusPorcelainV2())
    expect(status).toContainEqual({ path: "areas/notes/a.html", deleted: false })
  })

  it("reports an uncommitted deletion as deleted", async () => {
    await Effect.runPromise(
      commit(fixture, [["areas/notes/a.html", memoryHtml({ title: "A", claim: "C." })]], "add a")
    )
    await Effect.runPromise(Effect.promise(() => rm(join(fixture.root, "areas/notes/a.html"))))
    const status = await Effect.runPromise(portFor(fixture.root).statusPorcelainV2())
    expect(status).toContainEqual({ path: "areas/notes/a.html", deleted: true })
  })

  it("hashes a working-tree file to the sha it would carry in the tree", async () => {
    const html = memoryHtml({ title: "A", claim: "C." })
    await Effect.runPromise(commit(fixture, [["areas/notes/a.html", html]], "add a"))
    const port = portFor(fixture.root)
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const hashed = yield* port.hashObject("areas/notes/a.html")
        const entries = yield* port.lsTreeR("HEAD", ["areas"])
        return {
          hashed,
          inTree: entries.find((entry) => entry.path === "areas/notes/a.html")?.blobSha
        }
      })
    )
    // This equality is what makes the change key free: no separate content comparison is needed.
    expect(outcome.hashed).toBe(outcome.inTree)
  })

  it("reads a working-tree file as text", async () => {
    const html = memoryHtml({ title: "A", claim: "The claim." })
    await Effect.runPromise(commit(fixture, [["areas/notes/a.html", html]], "add a"))
    const read = await Effect.runPromise(
      portFor(fixture.root).readWorkingFile("areas/notes/a.html")
    )
    expect(read).toBe(html)
  })

  it("turns a rejection into the port's typed failure, carrying only the operation", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(portFor(fixture.root).readWorkingFile("areas/notes/absent.html"))
    )
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) {
      expect(outcome.failure._tag).toBe("StorageFailure")
      expect(outcome.failure.operation).toBe("git.readWorkingFile")
      // No stderr, no path: a subprocess message can carry a hunk, and it must not reach an agent.
      expect(Object.keys(outcome.failure).sort()).toEqual(["_tag", "operation"])
    }
  })
})

describe("an unborn HEAD", () => {
  it("is a refusal rather than a null the indexer would diff against", async () => {
    const fixture = await Effect.runPromise(makeFixtureRepo({ init: false }))
    try {
      await Effect.runPromise(fixture.git.run(["init", "-b", "main", "."]).pipe(Effect.orDie))
      const outcome = await Effect.runPromise(Effect.result(portFor(fixture.root).revParseHead()))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) expect(outcome.failure.operation).toBe("git.revParseHead")
    } finally {
      await fixture.cleanup()
    }
  })
})

/**
 * The `copied` mapping, which real git will not reliably produce (`-C` is off by default and a copy
 * needs a similarity match), asserted directly on the total function.
 *
 * This is the case that would corrupt the index if it were folded in with `renamed`: the indexer moves
 * a rename's source row to the destination, and a copy's source is still a live file.
 */
describe("toDiffEntry", () => {
  it("maps a rename to R with its source", () => {
    expect(toDiffEntry({ kind: "renamed", path: "b.html", fromPath: "a.html" })).toEqual({
      status: "R",
      path: "b.html",
      fromPath: "a.html"
    })
  })

  it("maps a COPY to A, because a copy's source is still in the tree", () => {
    expect(toDiffEntry({ kind: "copied", path: "b.html", fromPath: "a.html" })).toEqual({
      status: "A",
      path: "b.html"
    })
  })

  it("degrades a source-less rename to an add rather than moving an unknown path", () => {
    expect(toDiffEntry({ kind: "renamed", path: "b.html", fromPath: null })).toEqual({
      status: "A",
      path: "b.html"
    })
  })

  it("treats a type change as a content replacement", () => {
    expect(toDiffEntry({ kind: "typechanged", path: "a.html", fromPath: null })).toEqual({
      status: "M",
      path: "a.html"
    })
  })

  it("is total over the six change kinds", () => {
    const kinds = ["added", "modified", "deleted", "renamed", "copied", "typechanged"] as const
    for (const kind of kinds) {
      expect(toDiffEntry({ kind, path: "a.html", fromPath: "b.html" }).path).toBe("a.html")
    }
  })
})

describe("toStatusEntry", () => {
  it("drops an ignored path, which is not a change", () => {
    expect(toStatusEntry({ kind: "ignored", path: ".memhtml/index.db", xy: "" })).toEqual([])
  })

  it("drops an unmerged path, because neither side is the tree's answer yet", () => {
    expect(toStatusEntry({ kind: "unmerged", path: "areas/a.html", xy: "UU" })).toEqual([])
  })

  it("reads deletion off either half of the xy code", () => {
    expect(toStatusEntry({ kind: "changed", path: "a.html", xy: "D." })).toEqual([
      { path: "a.html", deleted: true }
    ])
    expect(toStatusEntry({ kind: "changed", path: "a.html", xy: ".D" })).toEqual([
      { path: "a.html", deleted: true }
    ])
    expect(toStatusEntry({ kind: "changed", path: "a.html", xy: ".M" })).toEqual([
      { path: "a.html", deleted: false }
    ])
  })

  it("keeps an untracked path, which is a brand-new memory not yet committed", () => {
    expect(toStatusEntry({ kind: "untracked", path: "areas/a.html", xy: "" })).toEqual([
      { path: "areas/a.html", deleted: false }
    ])
  })
})

/**
 * The end-to-end proof: the indexer, driven by the store's real git service through the adapter, over
 * a repo the store itself scaffolded.
 *
 * Everything above checks one method. This checks that the composition works — which is the thing a
 * phantom port hides, because each individual signature can typecheck while the whole never runs.
 */
describe("the indexer over the store's own git service", () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await newFixture()
  })

  afterEach(() => fixture.cleanup())

  const indexerFor = (db: DatabaseShape) =>
    makeIndexer({
      db,
      git: portFor(fixture.root),
      embedWatermark: EMBED_WATERMARK,
      embedDim: EMBED_DIM,
      embeddings: makeFakeEmbedder(),
      now: () => AT
    })

  it("rebuilds a store-scaffolded repo and skips its generated artifacts", async () => {
    await Effect.runPromise(
      commit(
        fixture,
        [
          ["areas/oncall/a.html", memoryHtml({ title: "Drain the VIP", claim: "Drain first." })],
          ["projects/memhtml/b.html", memoryHtml({ title: "bm25", claim: "One column." })]
        ],
        "seed two memories"
      )
    )

    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const report = yield* indexerFor(db).rebuild({ embed: true })
        const paths = yield* db.all<{ path: string; workspace: string | null }>(
          "SELECT path, workspace FROM files ORDER BY path"
        )
        const embeddings = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        return { report, paths, embeddings: embeddings?.n }
      })
    )

    expect(outcome.report.skipped).toEqual([])
    expect(outcome.paths).toEqual([
      { path: "areas/oncall/a.html", workspace: null },
      { path: "projects/memhtml/b.html", workspace: "memhtml" }
    ])
    // `initRepo` scaffolds README.html plus per-directory listings; none of them may be indexed.
    expect(outcome.report.filesIndexed).toBe(2)
    expect(outcome.embeddings).toBe(2)
  })

  it("survives a spuriously paired rename: the destination is re-projected from the tree", async () => {
    await Effect.runPromise(
      commit(
        fixture,
        [
          [
            "areas/notes/wildebeest.html",
            memoryHtml({ title: "Wildebeest", claim: "Wildebeest migrate across the Serengeti." })
          ]
        ],
        "seed"
      )
    )

    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const indexer = indexerFor(db)
        yield* indexer.rebuild({ embed: true })

        // Git reports this unrelated delete-plus-add as ONE rename — the format's head boilerplate
        // dominates the similarity score. The indexer must still land the right rows.
        yield* Effect.gen(function* () {
          yield* writeDirty(
            fixture,
            "areas/notes/bm25.html",
            memoryHtml({
              title: "Ascending bm25",
              claim: "A stronger bm25 match scores more negative."
            })
          )
          yield* Effect.promise(() => rm(join(fixture.root, "areas/notes/wildebeest.html")))
          yield* fixture.git.run(["add", "-A"])
          yield* fixture.git.commit("unrelated delete plus unrelated add")
        }).pipe(Effect.orDie)

        yield* indexer.update({ embed: true })
        return yield* db.all<{ path: string; gist: string }>(
          "SELECT path, gist FROM files ORDER BY path"
        )
      })
    )

    // Exactly the tree's content: the vanished path is gone and the new one carries its OWN claim, not
    // the claim of the file git paired it with. The move re-points a row and the re-projection
    // immediately overwrites it from the destination's real blob, which is what makes the similarity
    // heuristic something nothing downstream has to gate on.
    expect(outcome).toEqual([
      {
        path: "areas/notes/bm25.html",
        gist: "A stronger bm25 match scores more negative."
      }
    ])
  })

  it("carries an archive move through the adapter with the embedding intact", async () => {
    await Effect.runPromise(
      commit(fixture, [["areas/oncall/a.html", memoryHtml({ title: "A", claim: "C." })]], "add a")
    )

    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const indexer = indexerFor(db)
        yield* indexer.rebuild({ embed: true })
        const chunkBefore = yield* db.get<{ chunk_id: string }>(
          "SELECT chunk_id FROM chunks WHERE path = ?",
          ["areas/oncall/a.html"]
        )

        yield* Effect.gen(function* () {
          yield* Effect.promise(() =>
            mkdir(join(fixture.root, "archive/2026/areas/oncall"), { recursive: true })
          )
          yield* fixture.git.mv("areas/oncall/a.html", "archive/2026/areas/oncall/a.html")
          yield* fixture.git.commit("archive a")
        }).pipe(Effect.orDie)

        const report = yield* indexer.update({ embed: true })
        const moved = yield* db.get<{ path: string; archived: number }>(
          "SELECT path, archived FROM files"
        )
        const embedding = yield* db.get<{ n: number }>(
          "SELECT count(*) AS n FROM embeddings WHERE chunk_id = ?",
          [chunkBefore?.chunk_id ?? ""]
        )
        return { report, moved, embedding: embedding?.n }
      })
    )

    expect(outcome.report.renamed).toBe(1)
    expect(outcome.moved).toEqual({ path: "archive/2026/areas/oncall/a.html", archived: 1 })
    expect(outcome.embedding).toBe(1)
  })
})
