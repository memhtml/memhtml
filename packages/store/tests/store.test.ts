import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { DirtyTree, InvalidMemory, PathNotFound, WriteConflict } from "@memhtml/contracts/errors"
import { archivePathFor, originalPathFor } from "@memhtml/contracts/paths"
import { contentHash, readMeta } from "@memhtml/html"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { PROMPT_TRAILER, SESSION_TRAILER } from "../src/plumbing.js"
import { expandRoot, isoSecond, makeStore } from "../src/store.js"
import {
  configureIdentity,
  type FixtureRepo,
  makeFixtureRepo,
  mapDedupeLookup,
  recordingMoveCallback,
  writeInput
} from "../src/testing.js"

/**
 * Store operations against real git repos.
 *
 * Where a criterion is about git's own behavior, the assertion reads git — not the store's
 * return value. A store that reported `created: true` while committing nothing would satisfy
 * every shape assertion and none of these.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const runErr = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error("expected a failure, got a value")
  return result.failure
}

const repos: Array<FixtureRepo> = []

const fixture = async (options?: Parameters<typeof makeFixtureRepo>[0]): Promise<FixtureRepo> => {
  const repo = await run(makeFixtureRepo(options))
  repos.push(repo)
  return repo
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

/** The number of commits reachable from HEAD. What proves "one commit per operation". */
const commitCount = async (repo: FixtureRepo): Promise<number> =>
  Number((await run(repo.git.run(["rev-list", "--count", "HEAD"]))).trim())

/** The subject of the newest commit. */
const lastSubject = async (repo: FixtureRepo): Promise<string> =>
  (await run(repo.git.run(["log", "-1", "--format=%s"]))).trim()

/**
 * Every `.html` file on disk under the PARA directories, excluding the scaffold's own root
 * `README.html`. What proves a refused write left NO file behind at any candidate path — including
 * a collision-ordinal one, and including an untracked file `ls-tree` cannot see.
 */
const candidatePathsOnDisk = async (repo: FixtureRepo): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(repo.root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name).slice(repo.root.length + 1))
    .filter((path) => path !== "README.html")
    .sort()
}

describe("writeMemory", () => {
  it("creates a file at the placementFor path and makes exactly one commit", async () => {
    const repo = await fixture()
    const before = await commitCount(repo)

    const result = await run(
      repo.store.writeMemory(
        writeInput({
          title: "Prod rollbacks drain the VIP",
          memoryType: "procedural",
          tags: ["deploy"]
        })
      )
    )

    // `procedural` with a tag and no workspace routes to `resources/<primary-tag>/`, and a
    // non-episodic type gets a bare slug.
    expect(result.path).toBe("resources/deploy/prod-rollbacks-drain-the-vip.html")
    expect(result.created).toBe(true)
    expect(result.deduped).toBe(false)
    expect(await commitCount(repo)).toBe(before + 1)
    expect(await lastSubject(repo)).toBe("memhtml(write): Prod rollbacks drain the VIP")

    // The tree is clean: the write staged and committed everything it wrote.
    expect(await run(repo.store.dirtyPaths())).toEqual([])
    // And the file is in the COMMIT, not merely on disk.
    const entries = await run(repo.git.lsTreeR("HEAD", [result.path]))
    expect(entries.map((entry) => entry.path)).toEqual([result.path])
  })

  it("date-prefixes an episodic filename and routes an unplaceable memory to the inbox", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemory(writeInput({ title: "The VIP drained late", memoryType: "episodic" }))
    )
    expect(result.path).toMatch(/^areas\/inbox\/\d{8}-the-vip-drained-late\.html$/)
  })

  it("routes a workspace write to its project directory", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemory(writeInput({ title: "A fact", workspace: "Checkout API" }))
    )
    expect(result.path).toBe("projects/checkout-api/a-fact.html")
  })

  it("routes a person-entity semantic memory to the people directory", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemory(
        writeInput({ title: "Sanju reviews infra", entities: ["person:sanju"] })
      )
    )
    expect(result.path).toBe("resources/people/sanju-reviews-infra.html")
  })

  it("honors an explicit valid path verbatim", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemory(writeInput({ path: "areas/oncall/named.html" }))
    )
    expect(result.path).toBe("areas/oncall/named.html")
  })

  describe("an explicit path that is already occupied", () => {
    /**
     * Nothing in this corpus is ever removed: eviction is a `git mv` into `archive/<YYYY>/`, which
     * is what makes `git log --follow` read through a memory's whole life. A write that replaced the
     * file at an explicit path would delete a memory with no archive, no supersedes link, and no
     * trace in the history beyond a content change — the one operation the design has no undo for.
     */
    it("fails with WriteConflict and leaves the occupant byte-identical", async () => {
      const repo = await fixture()
      // A NEIGHBOUR in the same directory, so the assertions below cannot pass by accident on a
      // store that refuses (or clobbers) every path under `areas/oncall/`.
      const neighbour = await run(
        repo.store.writeMemory(
          writeInput({ path: "areas/oncall/neighbour.html", claim: "The neighbouring fact." })
        )
      )
      const occupied = await run(
        repo.store.writeMemory(
          writeInput({
            path: "areas/oncall/rollback-order.html",
            title: "Rollback order",
            claim: "Revert the deploy, then drain the VIP."
          })
        )
      )
      const before = await readFile(join(repo.root, occupied.path), "utf8")
      const neighbourBefore = await readFile(join(repo.root, neighbour.path), "utf8")
      const commitsBefore = await commitCount(repo)
      const headBefore = await run(repo.git.revParseHead())

      const failure = await runErr(
        repo.store.writeMemory(
          writeInput({
            path: occupied.path,
            title: "Rollback order",
            claim: "Drain the VIP, THEN revert the deploy."
          })
        )
      )

      expect(failure).toBeInstanceOf(WriteConflict)
      const conflict = failure as WriteConflict
      expect(conflict.path).toBe(occupied.path)
      // `theirSha` is the blob that is actually there, read from git rather than fabricated, so a
      // caller can fetch exactly the content that refused it. `ourSha` is empty because this write
      // had no base: it never read the file it would have replaced.
      expect(conflict.theirSha).toBe(await run(repo.git.hashObject(occupied.path)))
      expect(conflict.ourSha).toBe("")

      // The original bytes, to the byte — and no commit, no stage, nothing for git to report.
      expect(await readFile(join(repo.root, occupied.path), "utf8")).toBe(before)
      expect(await readFile(join(repo.root, neighbour.path), "utf8")).toBe(neighbourBefore)
      expect(await commitCount(repo)).toBe(commitsBefore)
      expect(await run(repo.git.revParseHead())).toBe(headBefore)
      expect(await run(repo.store.dirtyPaths())).toEqual([])
    })

    it("still writes to an explicit path nothing holds, with no collision suffix", async () => {
      // The mutation-proof pair: the guard must refuse an OCCUPIED path and only that. An explicit
      // path silently answered as `…-2.html` would hand the caller a path with no file behind it.
      const repo = await fixture()
      await run(repo.store.writeMemory(writeInput({ path: "areas/oncall/taken.html" })))
      const free = await run(
        repo.store.writeMemory(
          writeInput({ path: "areas/oncall/free.html", claim: "A different claim." })
        )
      )
      expect(free.path).toBe("areas/oncall/free.html")
      expect(free.created).toBe(true)
      expect(await run(repo.store.dirtyPaths())).toEqual([])
    })
  })

  it("writes a parseable file whose stamped hash matches the article it wrote", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemory(
        writeInput({
          title: "A parseable memory",
          claim: "The claim.",
          body: ["Some elaboration."],
          entities: ["service:checkout-api"],
          tags: ["deploy", "oncall"],
          importance: 8,
          confidence: 0.9
        })
      )
    )
    const read = await run(repo.store.readMemory(result.path))
    expect(read.doc.title).toBe("A parseable memory")
    expect(read.doc.article.gist).toBe("The claim.")
    expect(read.doc.entities).toEqual(["service:checkout-api"])
    expect(read.doc.tags).toEqual(["deploy", "oncall"])
    expect(read.doc.metas.importance).toBe(8)
    expect(read.doc.metas.confidence).toBe(0.9)
    // The stamped hash agrees with a fresh recomputation, so the indexer's first read confirms
    // rather than corrects it.
    expect(read.doc.metas.contentHash).toBe(contentHash(read.html))
    expect(read.doc.metas.contentHash).toBe(result.contentHash)
  })

  it("stamps session provenance into BOTH the file head and the commit trailers", async () => {
    // Design §7: the link exists in both planes — file-borne so it survives an index rebuild,
    // and commit-borne so a sleep run can attribute a night's writes without reading files.
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemory(
        writeInput({ sessionId: "sess-1", promptId: "pr_01JQ8", turnUuid: "turn-9" })
      )
    )
    const read = await run(repo.store.readMemory(result.path))
    expect(read.doc.metas.sessionId).toBe("sess-1")
    expect(read.doc.metas.promptId).toBe("pr_01JQ8")
    expect(read.doc.metas.turnUuid).toBe("turn-9")

    const body = await run(repo.git.run(["log", "-1", "--format=%B"]))
    expect(body).toContain(`${SESSION_TRAILER}: sess-1`)
    expect(body).toContain(`${PROMPT_TRAILER}: pr_01JQ8`)
  })

  it("cannot be made to forge a trailer from a newline in a session id", async () => {
    /**
     * A session id is agent-supplied and reaches `git commit --trailer` verbatim, so a newline in it
     * would end that trailer line and begin another. Asserted through GIT's own trailer parser, not
     * the message text: `sleep resume` reads these keys back with `%(trailers:key=…)`, and the
     * failure being excluded is a commit that answers a key no write ever stamped.
     */
    const repo = await fixture()
    await run(
      repo.store.writeMemory(writeInput({ sessionId: `sess-1\n${PROMPT_TRAILER}: forged` }))
    )

    const forged = await run(repo.git.logTrailers("HEAD~1..HEAD", PROMPT_TRAILER))
    expect(forged.map((record) => record.values)).toEqual([[]])
    const session = await run(repo.git.logTrailers("HEAD~1..HEAD", SESSION_TRAILER))
    expect(session.map((record) => record.values)).toEqual([[`sess-1 ${PROMPT_TRAILER}: forged`]])
  })

  it("appends a collision ordinal rather than overwriting a same-titled memory", async () => {
    const repo = await fixture()
    const first = await run(repo.store.writeMemory(writeInput({ title: "Same title" })))
    // A different claim, so the content hash differs and dedup does not intervene.
    const second = await run(
      repo.store.writeMemory(writeInput({ title: "Same title", claim: "A different claim." }))
    )
    expect(first.path).toBe("areas/inbox/same-title.html")
    expect(second.path).toBe("areas/inbox/same-title-2.html")
    // Both survive: the first was not clobbered.
    expect((await run(repo.store.readMemory(first.path))).doc.article.gist).toBe(
      "The claim this memory asserts."
    )
  })

  describe("content-hash dedup", () => {
    it("returns the existing path, writes no file, and makes NO commit", async () => {
      // The criterion, asserted against git rather than against the return value: a second
      // write of identical content must leave the tree byte-identical.
      const dedupe = mapDedupeLookup()
      const repo = await fixture({ hooks: { dedupeLookup: dedupe.lookup } })

      const first = await run(repo.store.writeMemory(writeInput()))
      expect(first.created).toBe(true)
      dedupe.byHash.set(first.contentHash, first.path)

      const headBefore = await run(repo.git.revParseHead())
      const commitsBefore = await commitCount(repo)
      const treeBefore = await run(repo.git.lsTreeR("HEAD"))

      const second = await run(repo.store.writeMemory(writeInput({ title: "A different title" })))

      expect(second.deduped).toBe(true)
      expect(second.created).toBe(false)
      expect(second.path).toBe(first.path)
      expect(second.existingPath).toBe(first.path)
      expect(second.commitSha).toBeNull()

      // No commit, no new file, and — the assertion a fake would miss — a CLEAN tree. A
      // write-then-check implementation would leave the duplicate on disk as an untracked file.
      expect(await commitCount(repo)).toBe(commitsBefore)
      expect(await run(repo.git.revParseHead())).toBe(headBefore)
      expect(await run(repo.git.lsTreeR("HEAD"))).toEqual(treeBefore)
      expect(await run(repo.store.dirtyPaths())).toEqual([])
    })

    it("asks about the hash of the article alone, so a different title still dedupes", async () => {
      // The hash scope is `<article>`. Two writes with the same claim and different titles are
      // the same fact, and the dedupe question is asked about exactly that.
      const dedupe = mapDedupeLookup()
      const repo = await fixture({ hooks: { dedupeLookup: dedupe.lookup } })
      const first = await run(repo.store.writeMemory(writeInput({ title: "One title" })))
      dedupe.byHash.set(first.contentHash, first.path)
      const second = await run(repo.store.writeMemory(writeInput({ title: "Quite another" })))
      expect(second.deduped).toBe(true)
    })

    it("writes normally when the lookup finds nothing", async () => {
      const dedupe = mapDedupeLookup()
      const repo = await fixture({ hooks: { dedupeLookup: dedupe.lookup } })
      const result = await run(repo.store.writeMemory(writeInput()))
      expect(result).toMatchObject({ created: true, deduped: false })
    })

    it("writes normally with no lookup wired at all", async () => {
      const repo = await fixture()
      expect(await run(repo.store.writeMemory(writeInput()))).toMatchObject({ created: true })
    })
  })
})

describe("readMemory", () => {
  it("fails with PathNotFound for a path with no file", async () => {
    const repo = await fixture()
    const failure = await runErr(repo.store.readMemory("areas/x/absent.html"))
    expect(failure).toBeInstanceOf(PathNotFound)
    expect((failure as PathNotFound).path).toBe("areas/x/absent.html")
  })

  it("normalizes a leading slash, so a link href reads directly", async () => {
    // `<link href>` carries the document-reference form with a leading slash; `files.path` is
    // the git-tree form without one. Accepting both is what keeps the conversion at one place.
    const repo = await fixture()
    const written = await run(repo.store.writeMemory(writeInput()))
    const read = await run(repo.store.readMemory(`/${written.path}`))
    expect(read.path).toBe(written.path)
  })

  it("fails with InvalidMemory on a file that is not a memory", async () => {
    const repo = await fixture()
    await writeFile(join(repo.root, "areas/inbox/bogus.html"), "<p>no head at all</p>", "utf8")
    const failure = await runErr(repo.store.readMemory("areas/inbox/bogus.html"))
    expect(failure).toBeInstanceOf(InvalidMemory)
  })
})

describe("correctMemory", () => {
  it("supersedes toward the target, archives it, and reads through with log --follow", async () => {
    const repo = await fixture()
    const original = await run(
      repo.store.writeMemory(
        writeInput({ title: "Rollback order", claim: "Revert the deploy, then drain the VIP." })
      )
    )
    const afterWrite = await commitCount(repo)
    const base = await run(repo.git.revParseHead())

    const corrected = await run(
      repo.store.correctMemory(original.path, {
        ...writeInput({
          title: "Rollback order, corrected",
          claim: "Drain the VIP, THEN revert the deploy."
        }),
        reason: "the original had the order backwards"
      })
    )

    // ONE commit for both halves. A correction is one fact about the corpus, and a split would
    // leave a window where a superseding file's target is still active.
    expect(await commitCount(repo)).toBe(afterWrite + 1)
    expect(await lastSubject(repo)).toBe("memhtml(correct): Rollback order, corrected")

    // The new file carries memhtml-supersedes toward the target's ARCHIVE path — where the file
    // actually is once this commit lands, so the href is not dangling in the commit that made it.
    const fresh = await run(repo.store.readMemory(corrected.path))
    expect(fresh.doc.links).toEqual([{ rel: "supersedes", href: `/${corrected.archivedPath}` }])
    expect(corrected.archivedPath).toBe(archivePathFor(original.path, 2026))
    expect(originalPathFor(corrected.archivedPath)).toBe(original.path)

    // The old file is archived, stamped, and points back at its replacement.
    const archived = await run(repo.store.readMemory(corrected.archivedPath))
    expect(archived.doc.metas.status).toBe("archived")
    expect(archived.doc.metas.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(archived.doc.metas.supersededBy).toBe(`/${corrected.path}`)
    // The original path holds nothing now.
    expect(await runErr(repo.store.readMemory(original.path))).toBeInstanceOf(PathNotFound)

    // `git log --follow` reads through the archive move: the archived path's history reaches
    // back to the commit that created the pre-archive file.
    const followed = await run(
      repo.git.run(["log", "--follow", "--format=%H", "--", corrected.archivedPath])
    )
    const shas = followed.trim().split("\n")
    expect(shas.length).toBeGreaterThanOrEqual(2)
    expect(shas).toContain(original.commitSha)

    // The move is detected as a RENAME. It is NOT R100 and cannot be: the same commit stamps
    // four meta lines, and similarity is computed between the two trees. Measured 59-87 on real
    // memory files, so the assertion is "a rename above the 50% detection floor", and nothing
    // in the system depends on the score — `originalPathFor` is the authoritative inverse.
    const changes = await run(repo.git.diffNameStatus(base ?? "", "HEAD"))
    const rename = changes.find((change) => change.kind === "renamed")
    expect(rename?.fromPath).toBe(original.path)
    expect(rename?.path).toBe(corrected.archivedPath)
    expect(rename?.similarity ?? 0).toBeGreaterThanOrEqual(50)
  })

  it("keeps the archive diff proportional to the stamps, on a hand-authored file", async () => {
    // A hand-authored head — aligned columns, metas not in META_ORDER — is the realistic
    // input: `docs/format.md`'s own example looks like this, and
    // so does anything a human edited. Round-tripping it through parse→serialize preserves the
    // hash but REWRITES the whole head (realigned, reordered), turning a four-line bookkeeping
    // stamp into a whole-file rewrite in `git diff`. A diff nobody reads is a diff nobody
    // reviews, and the sleep cycle's whole review flow rests on these staying small.
    const repo = await fixture()
    const handAuthored = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hand authored</title>
<meta name="memhtml-type"         content="procedural">
<meta name="memhtml-status"       content="active">
<meta name="memhtml-created"      content="2026-08-02T14:03:11Z">
<meta name="memhtml-updated"      content="2026-08-02T14:03:11Z">
<meta name="memhtml-tag"          content="deploy">
<meta name="memhtml-confidence"   content="0.90">
<meta name="memhtml-entity"       content="service:checkout-api">
</head>
<body>
<article>
<p><mark>A hand-authored claim.</mark></p>
</article>
</body>
</html>
`
    await mkdir(join(repo.root, "areas/oncall"), { recursive: true })
    await writeFile(join(repo.root, "areas/oncall/hand.html"), handAuthored, "utf8")
    await run(repo.git.add(["areas/oncall/hand.html"]))
    await run(repo.git.commit("memhtml(write): hand authored"))
    const base = await run(repo.git.revParseHead())

    await run(repo.store.archiveMemory("areas/oncall/hand.html", "evicted"))

    // Three stamps land: memhtml-status is replaced in place, memhtml-updated in place, memhtml-archived is
    // inserted. So at most four changed lines plus the rename header — never the whole head.
    const numstat = await run(repo.git.run(["diff", "-M", "--numstat", base ?? "", "HEAD"]))
    const [added, removed] = (numstat.trim().split("\t").slice(0, 2) as [string, string]).map(
      Number
    )
    expect(added).toBeLessThanOrEqual(4)
    expect(removed).toBeLessThanOrEqual(3)

    // The untouched head lines keep their hand-authored alignment byte for byte.
    const archived = await readFile(
      join(repo.root, archivePathFor("areas/oncall/hand.html", 2026)),
      "utf8"
    )
    expect(archived).toContain('<meta name="memhtml-confidence"   content="0.90">')
    expect(archived).toContain('<meta name="memhtml-entity"       content="service:checkout-api">')
    expect(archived).toContain('<meta name="memhtml-tag"          content="deploy">')
  })

  it("leaves the article of the archived file byte-identical", async () => {
    // The stamps go through `setMeta`, which splices by source offset — so the article's bytes,
    // and therefore the content hash and the dedupe key, cannot move on an archive.
    const repo = await fixture()
    const original = await run(repo.store.writeMemory(writeInput()))
    const beforeHtml = await readFile(join(repo.root, original.path), "utf8")
    const beforeArticle = beforeHtml.slice(beforeHtml.indexOf("<article>"))

    const corrected = await run(
      repo.store.correctMemory(original.path, writeInput({ title: "A correction" }))
    )
    const afterHtml = await readFile(join(repo.root, corrected.archivedPath), "utf8")
    expect(afterHtml.slice(afterHtml.indexOf("<article>"))).toBe(beforeArticle)
    expect(contentHash(afterHtml)).toBe(contentHash(beforeHtml))
    // The claimed hash still agrees, because the archive never touched the article.
    expect(readMeta(afterHtml, "memhtml-content-hash")).toBe(contentHash(afterHtml))
  })

  it("refuses to correct a path with no file, before writing anything", async () => {
    const repo = await fixture()
    const before = await commitCount(repo)
    const failure = await runErr(
      repo.store.correctMemory("areas/x/absent.html", writeInput({ title: "A correction" }))
    )
    expect(failure).toBeInstanceOf(PathNotFound)
    // Nothing was written and nothing was committed: no orphan superseding file exists.
    expect(await commitCount(repo)).toBe(before)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("notifies the move callback exactly once, with both paths", async () => {
    const recorder = recordingMoveCallback()
    const repo = await fixture({ hooks: { onMove: recorder.onMove } })
    const original = await run(repo.store.writeMemory(writeInput()))
    const corrected = await run(
      repo.store.correctMemory(original.path, writeInput({ title: "A correction" }))
    )
    expect(recorder.moves).toEqual([[original.path, corrected.archivedPath]])
  })

  it("stamps the validity hand-off: target's valid-until == correction's valid-from, min-wins", async () => {
    const repo = await fixture()
    const original = await run(
      repo.store.writeMemory(writeInput({ title: "Old fact", claim: "The old order." }))
    )
    const corrected = await run(
      repo.store.correctMemory(original.path, {
        ...writeInput({ title: "New fact", claim: "The new order." }),
        validFrom: "2025-02-01T00:00:00Z"
      })
    )

    // supersedeMemories' exact semantics on the single-pair correction path: the window closes
    // where the replacement's opens, both stamped in the correction's ONE commit.
    const archived = await run(repo.store.readMemory(corrected.archivedPath))
    expect(archived.doc.metas.validUntil).toBe("2025-02-01T00:00:00Z")
    const fresh = await run(repo.store.readMemory(corrected.path))
    expect(fresh.doc.metas.validFrom).toBe("2025-02-01T00:00:00Z")

    // Min-wins: a target already bounded EARLIER keeps its own bound.
    const bounded = await run(
      repo.store.writeMemory(
        writeInput({
          title: "Bounded fact",
          claim: "A bounded claim.",
          validUntil: "2024-01-01T00:00:00Z"
        })
      )
    )
    const rebound = await run(
      repo.store.correctMemory(bounded.path, {
        ...writeInput({ title: "Bounded fact, corrected", claim: "The re-stated claim." }),
        validFrom: "2025-06-01T00:00:00Z"
      })
    )
    const keptBound = await run(repo.store.readMemory(rebound.archivedPath))
    expect(keptBound.doc.metas.validUntil).toBe("2024-01-01T00:00:00Z")
  })

  it("corrects in place when the caller names the target's own path, archiving the ORIGINAL bytes", async () => {
    /**
     * The target is the one occupied path a correction may name: this commit moves it into the
     * archive, so the corrected fact can land where the old one lived. The archive must carry the
     * ORIGINAL article — a correction that wrote its own bytes to the shared path before the move
     * would archive the replacement and lose the fact the archive exists to keep.
     */
    const repo = await fixture()
    const original = await run(
      repo.store.writeMemory(
        writeInput({
          path: "areas/oncall/ceiling.html",
          title: "Pool ceiling",
          claim: "The pool ceiling is 64."
        })
      )
    )
    const before = await commitCount(repo)

    const corrected = await run(
      repo.store.correctMemory(original.path, {
        ...writeInput({ title: "Pool ceiling", claim: "The pool ceiling is 128." }),
        path: original.path
      })
    )

    expect(corrected.path).toBe(original.path)
    expect(corrected.archivedPath).toBe(archivePathFor(original.path, 2026))
    expect(await commitCount(repo)).toBe(before + 1)

    // The archived file holds the fact that was there, and the shared path now holds the new one.
    const archived = await run(repo.store.readMemory(corrected.archivedPath))
    expect(archived.doc.article.gist).toBe("The pool ceiling is 64.")
    expect(archived.doc.metas.status).toBe("archived")
    const fresh = await run(repo.store.readMemory(corrected.path))
    expect(fresh.doc.article.gist).toBe("The pool ceiling is 128.")
    expect(fresh.doc.links).toEqual([{ rel: "supersedes", href: `/${corrected.archivedPath}` }])
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("refuses an explicit path a THIRD memory holds, leaving the target active", async () => {
    const repo = await fixture()
    const target = await run(
      repo.store.writeMemory(writeInput({ title: "The target", claim: "The old fact." }))
    )
    const bystander = await run(
      repo.store.writeMemory(
        writeInput({ path: "areas/oncall/bystander.html", claim: "Someone else's fact." })
      )
    )
    const bystanderBefore = await readFile(join(repo.root, bystander.path), "utf8")
    const before = await commitCount(repo)

    const failure = await runErr(
      repo.store.correctMemory(target.path, {
        ...writeInput({ title: "The correction", claim: "The new fact." }),
        path: bystander.path
      })
    )

    expect(failure).toBeInstanceOf(WriteConflict)
    expect((failure as WriteConflict).path).toBe(bystander.path)
    // The bystander is untouched and the target is still active: the correction refused whole.
    expect(await readFile(join(repo.root, bystander.path), "utf8")).toBe(bystanderBefore)
    expect((await run(repo.store.readMemory(target.path))).doc.metas.status).toBe("active")
    expect(await commitCount(repo)).toBe(before)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })
})

/**
 * The render gate: `checkMemory` runs on the bytes `renderTemplate` produced, and a violation is
 * a refusal rather than a commit.
 *
 * This is the guard behind `articleHtml`. That field hands the caller the article verbatim, so
 * the caller — not the template — owns constraint 1, and a caller that forgets the `<mark>` would
 * otherwise put a file in git that the indexer silently declines to project: in the tree, absent
 * from every search. Every assertion here about "nothing happened" reads git, not the return
 * value, because the failure mode being excluded is a partial write that left the file on disk.
 */
describe("the render gate refuses a file checkMemory rejects", () => {
  /** Article markup with prose but no claim span — constraint 1's exact violation. */
  const NO_MARK = "<p>No mark at all.</p>"

  it("fails writeMemory with InvalidMemory naming the missing <mark>", async () => {
    const repo = await fixture()
    const failure = await runErr(
      repo.store.writeMemory(writeInput({ claim: "", articleHtml: NO_MARK }))
    )
    expect(failure).toBeInstanceOf(InvalidMemory)
    expect((failure as InvalidMemory).reason).toContain("no <mark>")
  })

  it("writes no file, stages nothing, and commits nothing on a refusal", async () => {
    const repo = await fixture()
    const commitsBefore = await commitCount(repo)
    const headBefore = await run(repo.git.revParseHead())
    const treeBefore = await run(repo.git.lsTreeR("HEAD"))

    await runErr(repo.store.writeMemory(writeInput({ claim: "", articleHtml: NO_MARK })))

    // Refused BEFORE the path was even chosen, so no candidate path can hold a file. Checked on
    // disk rather than in the tree: an untracked leftover is invisible to `ls-tree` and is
    // exactly what a write-then-check implementation would produce.
    expect(await candidatePathsOnDisk(repo)).toEqual([])
    expect(await commitCount(repo)).toBe(commitsBefore)
    expect(await run(repo.git.revParseHead())).toBe(headBefore)
    expect(await run(repo.git.lsTreeR("HEAD"))).toEqual(treeBefore)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("fails correctMemory too, leaving the target active and unarchived", async () => {
    const repo = await fixture()
    const original = await run(repo.store.writeMemory(writeInput({ title: "Still correct" })))
    const commitsBefore = await commitCount(repo)

    const failure = await runErr(
      repo.store.correctMemory(
        original.path,
        writeInput({ title: "A bad correction", claim: "", articleHtml: NO_MARK })
      )
    )
    expect(failure).toBeInstanceOf(InvalidMemory)
    expect((failure as InvalidMemory).reason).toContain("no <mark>")

    // The worst outcome a partial correction can produce is an archived target with no live
    // replacement — the memory would vanish from `memhtml list` because a WRITE failed.
    expect(await commitCount(repo)).toBe(commitsBefore)
    expect((await run(repo.store.readMemory(original.path))).doc.metas.status).toBe("active")
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("passes valid articleHtml through verbatim, unescaped, and commits it", async () => {
    // The mutation-proof pair for the refusal above: the same code path, markup that satisfies
    // the constraints, and the rich elements `articleHtml` exists for reaching disk as MARKUP.
    // If `<time` arrived escaped, the gate would be passing bytes the indexer reads as prose.
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemory(
        writeInput({
          title: "An authored article",
          claim: "",
          articleHtml:
            '<p><mark>Claim.</mark> <time datetime="2023-05-20T02:21:00Z">then</time></p>'
        })
      )
    )
    const onDisk = await readFile(join(repo.root, result.path), "utf8")
    expect(onDisk).toContain('<time datetime="2023-05-20T02:21:00Z">')
    expect(onDisk).not.toContain("&lt;time")
    // Round-trips: the gate accepted bytes the parser also accepts, and the claim came from the
    // authored `<mark>` rather than from the empty `claim` field.
    expect((await run(repo.store.readMemory(result.path))).doc.article.gist).toBe("Claim.")
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })
})

describe("archiveMemory", () => {
  it("moves to the archive path with the archive stamps in one commit", async () => {
    const repo = await fixture()
    const written = await run(repo.store.writeMemory(writeInput()))
    const before = await commitCount(repo)
    const base = await run(repo.git.revParseHead())

    const result = await run(repo.store.archiveMemory(written.path, "superseded by policy"))

    expect(result.archivePath).toBe(archivePathFor(written.path, 2026))
    expect(await commitCount(repo)).toBe(before + 1)
    expect(await lastSubject(repo)).toContain("memhtml(archive):")
    expect(await lastSubject(repo)).toContain("superseded by policy")

    const archived = await run(repo.store.readMemory(result.archivePath))
    expect(archived.doc.metas.status).toBe("archived")
    expect(archived.doc.metas.archivedAt).toBeDefined()
    // No supersededBy: an eviction replaces the memory with nothing.
    expect(archived.doc.metas.supersededBy).toBeUndefined()

    const rename = (await run(repo.git.diffNameStatus(base ?? "", "HEAD"))).find(
      (change) => change.kind === "renamed"
    )
    expect(rename?.fromPath).toBe(written.path)
    expect(rename?.similarity ?? 0).toBeGreaterThanOrEqual(50)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("archives into a year partition that does not exist yet", async () => {
    // `git mv` refuses a destination whose parent is absent, and the year partition is new every
    // January. Asserted by archiving into an empty repo, where `archive/2026/` does not exist.
    const repo = await fixture()
    const written = await run(repo.store.writeMemory(writeInput()))
    const result = await run(repo.store.archiveMemory(written.path, "eviction"))
    expect(result.archivePath.startsWith("archive/2026/")).toBe(true)
  })

  it("fails with PathNotFound for a path with no file", async () => {
    const repo = await fixture()
    expect(await runErr(repo.store.archiveMemory("areas/x/absent.html", "why"))).toBeInstanceOf(
      PathNotFound
    )
  })
})

describe("supersedeMemories", () => {
  it("returns a null sha and commits nothing for an empty pair list", async () => {
    // The write path calls this unconditionally shaped — the guard that nothing consolidated
    // means nothing committed lives HERE, not at every caller.
    const repo = await fixture()
    const before = await commitCount(repo)
    const result = await run(repo.store.supersedeMemories([]))
    expect(result).toEqual({ commitSha: null, archived: [] })
    expect(await commitCount(repo)).toBe(before)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("archives the loser toward the winner and links the winner toward the ARCHIVE path, one commit", async () => {
    const repo = await fixture()
    const loser = await run(
      repo.store.writeMemory(writeInput({ title: "Old ceiling", claim: "The pool ceiling is 64." }))
    )
    const winner = await run(
      repo.store.writeMemory(
        writeInput({ title: "New ceiling", claim: "The pool ceiling is 128." })
      )
    )
    const before = await commitCount(repo)

    const result = await run(
      repo.store.supersedeMemories([{ winnerPath: winner.path, loserPath: loser.path }])
    )

    // ONE commit for the pair: the archive move, its stamps, and the winner's link together.
    expect(await commitCount(repo)).toBe(before + 1)
    expect(result.commitSha).not.toBeNull()
    expect(await lastSubject(repo)).toContain("memhtml(consolidate):")
    expect(result.archived).toEqual([
      { loserPath: loser.path, archivePath: archivePathFor(loser.path, 2026) }
    ])

    // The loser is archived, stamped, and points at the WINNER's live path.
    const archived = await run(repo.store.readMemory(archivePathFor(loser.path, 2026)))
    expect(archived.doc.metas.status).toBe("archived")
    expect(archived.doc.metas.supersededBy).toBe(`/${winner.path}`)
    expect(await runErr(repo.store.readMemory(loser.path))).toBeInstanceOf(PathNotFound)

    // The winner's link points at the loser's ARCHIVE path — where the file is once this commit
    // lands — so no commit ever contains the dangling pre-archive href.
    const fresh = await run(repo.store.readMemory(winner.path))
    expect(fresh.doc.links).toEqual([
      { rel: "supersedes", href: `/${archivePathFor(loser.path, 2026)}` }
    ])
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("fails with PathNotFound for a missing loser BEFORE any staging", async () => {
    const repo = await fixture()
    const winner = await run(repo.store.writeMemory(writeInput()))
    const before = await commitCount(repo)

    const failure = await runErr(
      repo.store.supersedeMemories([{ winnerPath: winner.path, loserPath: "areas/x/absent.html" }])
    )

    expect(failure).toBeInstanceOf(PathNotFound)
    // Nothing was staged and nothing committed: the tree is byte-identical.
    expect(await commitCount(repo)).toBe(before)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("closes the loser's validity window at the winner's valid-from and opens the winner's", async () => {
    const repo = await fixture()
    const loser = await run(
      repo.store.writeMemory(writeInput({ title: "Old ceiling", claim: "The pool ceiling is 64." }))
    )
    // The winner's article carries an EVENT time, which is the middle rung of the coalesce:
    // no explicit memhtml-valid-from, so the <time datetime> is the winner's valid-from moment.
    const winner = await run(
      repo.store.writeMemory(
        writeInput({
          title: "New ceiling",
          claim: "",
          articleHtml:
            '<p><mark>The pool ceiling is 128.</mark> Raised on <time datetime="2025-02-01T00:00:00Z">that day</time>.</p>'
        })
      )
    )

    await run(repo.store.supersedeMemories([{ winnerPath: winner.path, loserPath: loser.path }]))

    // The loser's window closes exactly where the winner's opens: one moment, both ends stamped,
    // so an as-of query never finds both valid and never finds neither.
    const archived = await run(repo.store.readMemory(archivePathFor(loser.path, 2026)))
    expect(archived.doc.metas.validUntil).toBe("2025-02-01T00:00:00Z")
    const fresh = await run(repo.store.readMemory(winner.path))
    expect(fresh.doc.metas.validFrom).toBe("2025-02-01T00:00:00Z")
    // The stamps are head-plane splices: the winner's article bytes — and its dedupe key — held.
    expect(fresh.doc.metas.contentHash).toBe(winner.contentHash)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("falls back to the operation's own instant when the winner states no time at all", async () => {
    const repo = await fixture()
    const loser = await run(repo.store.writeMemory(writeInput({ title: "Old fact" })))
    const winner = await run(
      repo.store.writeMemory(writeInput({ title: "New fact", claim: "A newer claim." }))
    )

    await run(repo.store.supersedeMemories([{ winnerPath: winner.path, loserPath: loser.path }]))

    const archived = await run(repo.store.readMemory(archivePathFor(loser.path, 2026)))
    const fresh = await run(repo.store.readMemory(winner.path))
    // The bottom rung: no explicit valid-from, no <time datetime>, so both ends carry the
    // supersede's own instant — the archive stamp already records the same moment.
    expect(fresh.doc.metas.validFrom).toBe(archived.doc.metas.archivedAt)
    expect(archived.doc.metas.validUntil).toBe(fresh.doc.metas.validFrom)
  })

  it("keeps a loser's EARLIER stated bound — min-wins — and a winner's own valid-from", async () => {
    const repo = await fixture()
    // The loser already states its fact stopped being true in 2024; the winner's valid-from is
    // 2025. A fact cannot outlive its earliest stated bound, so the 2024 value survives.
    const loser = await run(
      repo.store.writeMemory(
        writeInput({
          title: "Old ceiling",
          claim: "The pool ceiling is 64.",
          validUntil: "2024-06-01T00:00:00Z"
        })
      )
    )
    const winner = await run(
      repo.store.writeMemory(
        writeInput({
          title: "New ceiling",
          claim: "The pool ceiling is 128.",
          validFrom: "2025-02-01T00:00:00Z"
        })
      )
    )

    await run(repo.store.supersedeMemories([{ winnerPath: winner.path, loserPath: loser.path }]))

    const archived = await run(repo.store.readMemory(archivePathFor(loser.path, 2026)))
    expect(archived.doc.metas.validUntil).toBe("2024-06-01T00:00:00Z")
    // The winner's explicit valid-from is the top rung of the coalesce and is never rewritten.
    const fresh = await run(repo.store.readMemory(winner.path))
    expect(fresh.doc.metas.validFrom).toBe("2025-02-01T00:00:00Z")
  })

  it("overwrites a loser's LATER stated bound with the winner's earlier valid-from", async () => {
    const repo = await fixture()
    // Min-wins in the other direction: the loser claimed validity until 2027, but the corpus now
    // says a newer fact took over in 2025 — the supersede is the earlier bound and it wins.
    const loser = await run(
      repo.store.writeMemory(
        writeInput({
          title: "Old ceiling",
          claim: "The pool ceiling is 64.",
          validUntil: "2027-01-01T00:00:00Z"
        })
      )
    )
    const winner = await run(
      repo.store.writeMemory(
        writeInput({
          title: "New ceiling",
          claim: "The pool ceiling is 128.",
          validFrom: "2025-02-01T00:00:00Z"
        })
      )
    )

    await run(repo.store.supersedeMemories([{ winnerPath: winner.path, loserPath: loser.path }]))

    const archived = await run(repo.store.readMemory(archivePathFor(loser.path, 2026)))
    expect(archived.doc.metas.validUntil).toBe("2025-02-01T00:00:00Z")
  })
})

describe("linkMemories", () => {
  it("adds the link, commits once, and is idempotent on a re-run", async () => {
    const repo = await fixture()
    const source = await run(repo.store.writeMemory(writeInput({ title: "The source" })))
    const target = await run(
      repo.store.writeMemory(writeInput({ title: "The target", claim: "Another claim." }))
    )
    const before = await commitCount(repo)

    const first = await run(repo.store.linkMemories(source.path, "relates_to", target.path))
    expect(first.commitSha).not.toBeNull()
    expect(await commitCount(repo)).toBe(before + 1)

    const read = await run(repo.store.readMemory(source.path))
    expect(read.doc.links).toEqual([{ rel: "relates_to", href: `/${target.path}` }])

    // Re-running writes nothing and commits nothing — which is what makes the sleep conflict
    // phase's nightly re-promotion of one corroborated edge cost one commit in total.
    const second = await run(repo.store.linkMemories(source.path, "relates_to", target.path))
    expect(second.commitSha).toBeNull()
    expect(await commitCount(repo)).toBe(before + 1)
    expect((await run(repo.store.readMemory(source.path))).doc.links).toHaveLength(1)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("leaves the content hash untouched, because a link is a head edit", async () => {
    const repo = await fixture()
    const source = await run(repo.store.writeMemory(writeInput({ title: "The source" })))
    const target = await run(
      repo.store.writeMemory(writeInput({ title: "The target", claim: "Another claim." }))
    )
    const before = await readFile(join(repo.root, source.path), "utf8")
    await run(repo.store.linkMemories(source.path, "part_of", target.path))
    const after = await readFile(join(repo.root, source.path), "utf8")
    expect(contentHash(after)).toBe(contentHash(before))
    expect(after.slice(after.indexOf("<article>"))).toBe(before.slice(before.indexOf("<article>")))
  })

  it("refuses a self-loop, which the edges CHECK constraint would also refuse", async () => {
    const repo = await fixture()
    const written = await run(repo.store.writeMemory(writeInput()))
    const failure = await runErr(repo.store.linkMemories(written.path, "relates_to", written.path))
    expect(failure).toBeInstanceOf(InvalidMemory)
  })

  it("fails with PathNotFound when the source does not exist", async () => {
    const repo = await fixture()
    const target = await run(repo.store.writeMemory(writeInput()))
    expect(
      await runErr(repo.store.linkMemories("areas/x/absent.html", "supports", target.path))
    ).toBeInstanceOf(PathNotFound)
  })
})

describe("linkMemories keeps the task graph and the memory graph apart", () => {
  /** A task and a memory in one repo, which is the state every case below needs. */
  const pair = async () => {
    const repo = await fixture()
    const taskA = await run(
      repo.store.writeMemory(
        writeInput({
          title: "Wire the discrimination gate",
          claim: "The pre-merge gate is unsupplied.",
          memoryType: "task"
        })
      )
    )
    const taskB = await run(
      repo.store.writeMemory(
        writeInput({
          title: "Regenerate the agent doc",
          claim: "The committed doc drifted from the command table.",
          memoryType: "task"
        })
      )
    )
    const memory = await run(
      repo.store.writeMemory(writeInput({ title: "A remembered fact", claim: "A claim." }))
    )
    return { repo, taskA: taskA.path, taskB: taskB.path, memory: memory.path }
  }

  it("refuses a memory-class rel with a task at either endpoint", async () => {
    /**
     * The failure this prevents: every memory-graph query filters `edge_class = 'memory'`, so a
     * `relates_to` between a memory and a task would put a work item into PageRank, MMR, and the
     * retention bridge count — an agent's to-do list reweighting the retention of its knowledge.
     * The `edges` CHECK cannot catch it: it pairs a rel with its class, and `relates_to` under
     * `memory` is a perfectly well-formed edge whatever the files at its ends are.
     */
    const { repo, taskA, memory } = await pair()
    const before = await commitCount(repo)

    const outbound = await runErr(repo.store.linkMemories(memory, "relates_to", taskA))
    expect(outbound).toBeInstanceOf(InvalidMemory)
    expect((outbound as InvalidMemory).reason).toContain("never enters the memory graph")

    const inbound = await runErr(repo.store.linkMemories(taskA, "supports", memory))
    expect(inbound).toBeInstanceOf(InvalidMemory)

    // Refused before any write: the tree is byte-identical and there is nothing to unstage.
    expect(await commitCount(repo)).toBe(before)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
    expect((await run(repo.store.readMemory(memory))).doc.links).toEqual([])
  })

  it("admits a task rel between two tasks, and commits it once", async () => {
    const { repo, taskA, taskB } = await pair()
    const before = await commitCount(repo)

    const result = await run(repo.store.linkMemories(taskA, "blocks", taskB))
    expect(result.commitSha).not.toBeNull()
    expect(await commitCount(repo)).toBe(before + 1)
    expect((await run(repo.store.readMemory(taskA))).doc.links).toEqual([
      { rel: "blocks", href: `/${taskB}` }
    ])
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("refuses a task rel pointing at a memory, in either direction", async () => {
    // A memory that `blocks` something asserts work nothing advances and nothing can close.
    const { repo, taskA, memory } = await pair()
    const outbound = await runErr(repo.store.linkMemories(taskA, "blocks", memory))
    expect(outbound).toBeInstanceOf(InvalidMemory)
    expect((outbound as InvalidMemory).reason).toContain("both endpoints must be tasks")
    expect(await runErr(repo.store.linkMemories(memory, "subtask_of", taskA))).toBeInstanceOf(
      InvalidMemory
    )
  })

  it("leaves a memory-to-memory rel and a provenance rel untouched", async () => {
    /**
     * The guard has to be narrow. `from_session` points at a trace rather than a memory file, so
     * neither endpoint rule applies — and a task legitimately came from a session, which is the
     * one cross-type link that must keep working.
     */
    const { repo, taskA, memory } = await pair()
    const second = await run(
      repo.store.writeMemory(writeInput({ title: "Another fact", claim: "A second claim." }))
    )
    expect(
      (await run(repo.store.linkMemories(memory, "relates_to", second.path))).commitSha
    ).not.toBeNull()
    expect(
      (await run(repo.store.linkMemories(taskA, "from_session", "traces/s1.html"))).commitSha
    ).not.toBeNull()
  })
})

describe("dirtyPaths and requireCleanTree", () => {
  it("passes on the clean tree every store operation leaves behind", async () => {
    const repo = await fixture()
    await run(repo.store.writeMemory(writeInput()))
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
  })

  it("fails with DirtyTree naming the uncommitted paths", async () => {
    // Sleep refuses to start on a dirty tree. The contaminating state is an agent's own
    // in-flight edit, which is the ordinary case rather than a rare one.
    const repo = await fixture()
    const written = await run(repo.store.writeMemory(writeInput()))
    await writeFile(join(repo.root, written.path), "<p>edited outside the store</p>", "utf8")

    const failure = await runErr(repo.store.requireCleanTree())
    expect(failure).toBeInstanceOf(DirtyTree)
    expect((failure as DirtyTree).paths).toEqual([written.path])
  })

  it("reports an untracked file as dirty", async () => {
    const repo = await fixture()
    await writeFile(join(repo.root, "areas/inbox/stray.html"), "<p>stray</p>", "utf8")
    expect(await run(repo.store.dirtyPaths())).toEqual(["areas/inbox/stray.html"])
  })

  it("does not report the gitignored databases as dirty", async () => {
    const repo = await fixture()
    await writeFile(join(repo.root, ".memhtml/index.db"), "bytes", "utf8")
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })
})

describe("mergeBranch", () => {
  it("surfaces a racing same-file edit as WriteConflict carrying both shas", async () => {
    // The design's concurrency criterion, against the state that produces it: two clones of one
    // bare repo, each editing the same memory in place, and the loser merging. `linkMemories` is
    // that edit — a head-plane splice both sides make at the same offset, each toward its own
    // session trace, which is two agents recording provenance on one shared memory.
    const origin = await fixture({ init: false })
    await run(origin.git.run(["init", "--bare", "-b", "main", "."]))

    const ours = await fixture({ init: false })
    await run(ours.git.run(["clone", origin.root, "."]))
    await run(configureIdentity(ours.git))
    const oursStore = makeStore(ours.git)
    const shared = await run(
      oursStore.writeMemory(writeInput({ path: "areas/oncall/contested.html" }))
    )
    await run(ours.git.run(["push", "origin", "HEAD:main"]))

    const theirs = await fixture({ init: false })
    await run(theirs.git.run(["clone", origin.root, "."]))
    await run(configureIdentity(theirs.git))
    const theirsStore = makeStore(theirs.git)

    await run(oursStore.linkMemories(shared.path, "from_session", "traces/ours.html"))
    await run(ours.git.run(["push", "origin", "HEAD:main"]))

    await run(theirsStore.linkMemories(shared.path, "from_session", "traces/theirs.html"))
    await run(theirs.git.run(["fetch", "origin"]))

    const failure = await runErr(theirsStore.mergeBranch("origin/main"))

    expect(failure).toBeInstanceOf(WriteConflict)
    const conflict = failure as WriteConflict
    expect(conflict.path).toBe("areas/oncall/contested.html")
    // BOTH shas, and they are real distinct blob shas rather than placeholders.
    expect(conflict.ourSha).toMatch(/^[0-9a-f]{40}$/)
    expect(conflict.theirSha).toMatch(/^[0-9a-f]{40}$/)
    expect(conflict.ourSha).not.toBe(conflict.theirSha)

    // The shas resolve to the two competing versions — read from git, so a fabricated pair fails.
    const blobs = await run(theirs.git.catFileBatch([conflict.ourSha, conflict.theirSha]))
    const bodyOf = (sha: string) => Buffer.from(blobs.get(sha) ?? new Uint8Array()).toString("utf8")
    expect(bodyOf(conflict.ourSha)).toContain("/traces/theirs.html")
    expect(bodyOf(conflict.theirSha)).toContain("/traces/ours.html")

    // The merge is aborted, so the caller's recovery (re-read, reapply) starts from a clean
    // tree rather than from a half-merged index full of conflict markers.
    expect(await run(theirsStore.dirtyPaths())).toEqual([])
    expect(await run(theirs.git.unmergedStages())).toEqual([])
  })

  it("surfaces an add/add race, where there is no base stage to fall back on", async () => {
    // Two agents independently writing the same fact at the same path. Git has no stage 1 here,
    // so a conflict reader that expected a base would come up empty on the commonest race of all.
    const origin = await fixture({ init: false })
    await run(origin.git.run(["init", "--bare", "-b", "main", "."]))

    const ours = await fixture({ init: false })
    await run(ours.git.run(["clone", origin.root, "."]))
    await run(configureIdentity(ours.git))
    const oursStore = makeStore(ours.git)
    await run(oursStore.writeMemory(writeInput({ path: "areas/oncall/seed.html" })))
    await run(ours.git.run(["push", "origin", "HEAD:main"]))

    const theirs = await fixture({ init: false })
    await run(theirs.git.run(["clone", origin.root, "."]))
    await run(configureIdentity(theirs.git))
    const theirsStore = makeStore(theirs.git)

    const contested = "areas/oncall/both-invent-this.html"
    await run(oursStore.writeMemory(writeInput({ path: contested, claim: "Our version." })))
    await run(ours.git.run(["push", "origin", "HEAD:main"]))
    await run(theirsStore.writeMemory(writeInput({ path: contested, claim: "Their version." })))
    await run(theirs.git.run(["fetch", "origin"]))

    const conflict = (await runErr(theirsStore.mergeBranch("origin/main"))) as WriteConflict
    expect(conflict).toBeInstanceOf(WriteConflict)
    expect(conflict.path).toBe(contested)
    expect(conflict.ourSha).toMatch(/^[0-9a-f]{40}$/)
    expect(conflict.theirSha).toMatch(/^[0-9a-f]{40}$/)
    // There is genuinely no base: stage 1 is absent, and the store still reports both sides.
    const stages = await run(theirs.git.unmergedStages())
    expect(stages).toEqual([])
  })

  it("succeeds silently when the two sides touched different memories", async () => {
    // Two agents writing different files never interact — the design's premise for why an
    // ordinary write needs no lock.
    const repo = await fixture()
    await run(repo.git.checkoutBranch("side", { create: true }))
    await run(repo.store.writeMemory(writeInput({ path: "areas/oncall/side.html" })))

    await run(repo.git.checkoutBranch("main"))
    await run(
      repo.store.writeMemory(
        writeInput({ path: "areas/oncall/main.html", claim: "A different claim." })
      )
    )

    expect(await run(repo.store.mergeBranch("side"))).toBeUndefined()
    expect(await run(repo.store.readMemory("areas/oncall/side.html"))).toBeDefined()
    expect(await run(repo.store.readMemory("areas/oncall/main.html"))).toBeDefined()
  })
})

/**
 * A failed commit leaves a CLEAN tree, for every singular operation.
 *
 * This is the failure mode with the longest reach in the system: `requireCleanTree` is sleep's
 * preflight, so one uncompensated write leaves a staged file behind and every nightly run from then
 * on refuses to start. The assertion is therefore `requireCleanTree` itself, plus the bytes, plus
 * `git status` — not the return value, which is an error either way.
 *
 * Driven by a git service whose `commit` fails, because the real binary cannot be made to fail on
 * demand at that step. Everything else — the write, the `mv`, the stage, the reset, the restore —
 * is the real store against the real repo, so the compensation runs against actual on-disk and
 * index state.
 */
describe("a failed commit is compensated, for every singular operation", () => {
  /** A git whose `commit` exits non-zero, with every other command the real binary. */
  const failingCommit = (git: FixtureRepo["git"]): FixtureRepo["git"] => ({
    ...git,
    commit: () => git.run(["commit", "--this-is-not-a-flag"]).pipe(Effect.asVoid) as never
  })

  it("leaves no written file and no staged path behind a failed writeMemory", async () => {
    const repo = await fixture()
    const neighbour = await run(
      repo.store.writeMemory(writeInput({ title: "The neighbour", claim: "Another fact." }))
    )
    const commitsBefore = await commitCount(repo)
    const store = makeStore(failingCommit(repo.git))

    await runErr(store.writeMemory(writeInput({ title: "Never committed", claim: "One." })))

    // The path the write chose holds nothing, the tree is clean, and sleep can still start.
    expect(await candidatePathsOnDisk(repo)).toEqual([neighbour.path])
    expect(await run(repo.store.dirtyPaths())).toEqual([])
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
    expect(await commitCount(repo)).toBe(commitsBefore)
  })

  it("puts the target back where it was behind a failed correctMemory", async () => {
    const repo = await fixture()
    const original = await run(
      repo.store.writeMemory(writeInput({ title: "Rollback order", claim: "The old order." }))
    )
    const before = await readFile(join(repo.root, original.path), "utf8")
    const commitsBefore = await commitCount(repo)
    const store = makeStore(failingCommit(repo.git))

    await runErr(
      store.correctMemory(
        original.path,
        writeInput({ title: "Rollback order, corrected", claim: "The new order." })
      )
    )

    /**
     * The worst state this package can produce, and the one being excluded: the target archived and
     * staged, the correction half-written, and every later sleep run refused. The target's bytes are
     * restored exactly, including the head stamps the archive pass would have added.
     */
    expect(await readFile(join(repo.root, original.path), "utf8")).toBe(before)
    expect((await run(repo.store.readMemory(original.path))).doc.metas.status).toBe("active")
    expect(await runErr(repo.store.readMemory(archivePathFor(original.path, 2026)))).toBeInstanceOf(
      PathNotFound
    )
    expect(await candidatePathsOnDisk(repo)).toEqual([original.path])
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
    expect(await commitCount(repo)).toBe(commitsBefore)
  })

  it("puts the moved file back behind a failed archiveMemory", async () => {
    const repo = await fixture()
    const written = await run(repo.store.writeMemory(writeInput()))
    const before = await readFile(join(repo.root, written.path), "utf8")
    const commitsBefore = await commitCount(repo)
    const store = makeStore(failingCommit(repo.git))

    await runErr(store.archiveMemory(written.path, "eviction that failed"))

    // A half-moved archive is a memory that is neither active nor archived: `git mv` staged the
    // rename, so the file is gone from its own path and the index disagrees with HEAD.
    expect(await readFile(join(repo.root, written.path), "utf8")).toBe(before)
    expect(await runErr(repo.store.readMemory(archivePathFor(written.path, 2026)))).toBeInstanceOf(
      PathNotFound
    )
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
    expect(await commitCount(repo)).toBe(commitsBefore)
  })

  it("restores the pre-link bytes behind a failed linkMemories", async () => {
    const repo = await fixture()
    const source = await run(repo.store.writeMemory(writeInput({ title: "The source" })))
    const target = await run(
      repo.store.writeMemory(writeInput({ title: "The target", claim: "Another claim." }))
    )
    const before = await readFile(join(repo.root, source.path), "utf8")
    const store = makeStore(failingCommit(repo.git))

    await runErr(store.linkMemories(source.path, "relates_to", target.path))

    // A link is an edit to a file that already exists, so the compensation rewrites rather than
    // removes: the source is still there, still linkless, and still clean.
    expect(await readFile(join(repo.root, source.path), "utf8")).toBe(before)
    expect((await run(repo.store.readMemory(source.path))).doc.links).toEqual([])
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
  })

  it("puts every pair back behind a failed supersedeMemories", async () => {
    const repo = await fixture()
    const loser = await run(
      repo.store.writeMemory(writeInput({ title: "Old ceiling", claim: "The pool ceiling is 64." }))
    )
    const winner = await run(
      repo.store.writeMemory(writeInput({ title: "New ceiling", claim: "The ceiling is 128." }))
    )
    const loserBefore = await readFile(join(repo.root, loser.path), "utf8")
    const winnerBefore = await readFile(join(repo.root, winner.path), "utf8")
    const store = makeStore(failingCommit(repo.git))

    await runErr(store.supersedeMemories([{ winnerPath: winner.path, loserPath: loser.path }]))

    expect(await readFile(join(repo.root, loser.path), "utf8")).toBe(loserBefore)
    expect(await readFile(join(repo.root, winner.path), "utf8")).toBe(winnerBefore)
    expect(await runErr(repo.store.readMemory(archivePathFor(loser.path, 2026)))).toBeInstanceOf(
      PathNotFound
    )
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
  })

  it("compensates an INTERRUPTED archive, which is what a client timeout leaves", async () => {
    /**
     * An interruption is not a typed failure, and it is the likeliest way this state arises in
     * production: an MCP client that times out or disconnects interrupts the tool's fiber wherever it
     * happens to be, which can be after `git mv` staged the rename and before the commit. A
     * compensation attached to the failure channel alone would never run.
     *
     * Driven by a git whose `commit` never returns, so the interruption lands at exactly that point.
     */
    const repo = await fixture()
    const written = await run(repo.store.writeMemory(writeInput()))
    const before = await readFile(join(repo.root, written.path), "utf8")
    const commitsBefore = await commitCount(repo)
    const hangingGit = { ...repo.git, commit: () => Effect.never as never }
    const store = makeStore(hangingGit)

    await runErr(store.archiveMemory(written.path, "eviction").pipe(Effect.timeout(200)))

    expect(await readFile(join(repo.root, written.path), "utf8")).toBe(before)
    expect(await runErr(repo.store.readMemory(archivePathFor(written.path, 2026)))).toBeInstanceOf(
      PathNotFound
    )
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
    expect(await commitCount(repo)).toBe(commitsBefore)
  })
})

/**
 * Two concurrent mutations through ONE store serialize.
 *
 * Both races this closes are in-process, and the MCP server runs its tools with unbounded
 * concurrency over one store, so this is the shape of its ordinary traffic. Without a permit
 * `freePathFor`'s disk probe interleaves with a sibling's `writeFileAt` (both are handed the same
 * path, and the second write replaces the first), and git's single `.git/index` interleaves too, so
 * one commit picks up the other's staged file and the other commits nothing.
 */
describe("concurrent mutations", () => {
  it("gives two same-titled concurrent writes distinct paths and two distinct commits", async () => {
    const repo = await fixture()
    const before = await commitCount(repo)

    const [first, second] = await run(
      Effect.all(
        [
          repo.store.writeMemory(writeInput({ title: "Same title", claim: "One fact." })),
          repo.store.writeMemory(writeInput({ title: "Same title", claim: "A different fact." }))
        ],
        { concurrency: 2 }
      )
    )

    // Two files, two commits, and neither claim lost: the pair of paths is `x` and `x-2` in some
    // order, since which fiber takes the permit first is not fixed.
    expect(new Set([first.path, second.path])).toEqual(
      new Set(["areas/inbox/same-title.html", "areas/inbox/same-title-2.html"])
    )
    expect(first.commitSha).not.toBeNull()
    expect(second.commitSha).not.toBeNull()
    expect(first.commitSha).not.toBe(second.commitSha)
    expect(await commitCount(repo)).toBe(before + 2)

    const claims = await Promise.all(
      [first.path, second.path].map(
        async (path) => (await run(repo.store.readMemory(path))).doc.article.gist
      )
    )
    expect([...claims].sort()).toEqual(["A different fact.", "One fact."])
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("keeps a concurrent write and archive from sharing one commit", async () => {
    // The git-index half of the race, across two DIFFERENT operations: an archive's `git mv` landing
    // inside a write's staging window would put the moved file into the write's commit, and the
    // archive would then commit nothing and report a null sha.
    const repo = await fixture()
    const existing = await run(
      repo.store.writeMemory(writeInput({ title: "To be evicted", claim: "A stale fact." }))
    )
    const before = await commitCount(repo)

    const [written, archived] = await run(
      Effect.all(
        [
          repo.store.writeMemory(writeInput({ title: "Fresh fact", claim: "Newly learned." })),
          repo.store.archiveMemory(existing.path, "eviction")
        ],
        { concurrency: 2 }
      )
    )

    expect(written.commitSha).not.toBeNull()
    expect(archived.commitSha).not.toBeNull()
    expect(written.commitSha).not.toBe(archived.commitSha)
    expect(await commitCount(repo)).toBe(before + 2)
    // Each commit holds exactly its own operation's change.
    const writeCommit = await run(
      repo.git.run(["show", "--name-status", "--format=", written.commitSha ?? ""])
    )
    expect(writeCommit).toContain(written.path)
    expect(writeCommit).not.toContain(archived.archivePath)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })
})

describe("expandRoot", () => {
  it("expands a leading tilde, which only a shell would otherwise do", async () => {
    // This value arrives from an MCP client config and a cron line as well as from a shell, and
    // neither of those expands `~` — a literal `./~` directory would be the silent result.
    const { homedir } = await import("node:os")
    expect(expandRoot("~/memhtml")).toBe(join(homedir(), "memhtml"))
    expect(expandRoot("~")).toBe(homedir())
  })

  it("leaves an absolute path alone and resolves a relative one", () => {
    expect(expandRoot("/srv/memory")).toBe("/srv/memory")
    expect(expandRoot("  /srv/memory  ")).toBe("/srv/memory")
    expect(expandRoot("relative/memory")).toBe(join(process.cwd(), "relative/memory"))
  })

  it("does not expand a tilde inside a path segment", () => {
    expect(expandRoot("/srv/~backup/memory")).toBe("/srv/~backup/memory")
  })
})

describe("isoSecond", () => {
  it("formats to whole seconds with a Z suffix, the shape every memhtml-* meta carries", () => {
    expect(isoSecond(Date.UTC(2026, 7, 2, 14, 3, 11, 456))).toBe("2026-08-02T14:03:11Z")
  })
})
