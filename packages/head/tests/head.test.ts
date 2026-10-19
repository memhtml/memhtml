import { contentHash } from "@memhtml/html"
import type { FixtureRepo } from "@memhtml/store/testing"
import { HashMap } from "effect"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"

import { advanceHead, type HeadVersion, isCandidatePath, loadHead } from "../src/index.js"
import {
  BROKEN_HTML,
  blobAt,
  type Change,
  type Corpus,
  commitChanges,
  makeCorpus,
  memoryFor,
  run,
  treePaths
} from "./helpers.js"

/**
 * Versions against real temp repos.
 *
 * Every count here is asserted against a number derived without the head: the tree as `ls-tree`
 * reports it, the blob sha as `ls-tree` reports it. A census that only reported `size` would read a
 * bug in the eligibility filter as a fact about the corpus.
 *
 * Guards and the one-line mutation that fails each (each run once, see the report):
 * - `isCandidatePath`: drop the `index.html` exclusion, and "counts every eligible file" fails on
 *   `skipped` (2 instead of 1) and on the census equation.
 * - `insertRecord` active-only: drop the `!record.archived` branch, and "keeps archived records out
 *   of byContentHash and byFrameKey" fails.
 * - `advanceHead` sharing: replace the delta with `loadHead(git, to)`, and "shares every untouched
 *   record by reference" fails on `toBe`.
 */

const corpora: Array<Corpus> = []

afterEach(async () => {
  await Promise.all(corpora.splice(0).map((corpus) => corpus.repo.cleanup()))
})

const corpus = async (count: number, extra: ReadonlyArray<Change> = []): Promise<Corpus> => {
  const built = await makeCorpus(count, extra)
  corpora.push(built)
  return built
}

/** The eligibility rule restated from the tree, not from the head: `.html`, not `index.html`, not state. */
const eligible = async (repo: FixtureRepo, sha: string): Promise<ReadonlyArray<string>> =>
  (await treePaths(repo, sha)).filter(
    (path) =>
      path.endsWith(".html") &&
      !path.startsWith(".memhtml/") &&
      !path.endsWith("/index.html") &&
      path !== "index.html"
  )

describe("isCandidatePath", () => {
  it("admits memory files and refuses artifacts and state", () => {
    expect(isCandidatePath("areas/inbox/a.html")).toBe(true)
    expect(isCandidatePath("archive/2025/areas/inbox/a.html")).toBe(true)
    expect(isCandidatePath("README.html")).toBe(true)
    expect(isCandidatePath("index.html")).toBe(false)
    expect(isCandidatePath("areas/index.html")).toBe(false)
    expect(isCandidatePath(".memhtml/state/x.html")).toBe(false)
    expect(isCandidatePath("sitemap.xml")).toBe(false)
    expect(isCandidatePath("areas/inbox/.gitkeep")).toBe(false)
  })
})

describe("loadHead", () => {
  it("counts every eligible file: records equal the independent ls-tree count minus skipped (300-file fixture, timed)", async () => {
    const { repo, sha } = await corpus(300, [
      { path: "areas/inbox/broken.html", html: BROKEN_HTML },
      { path: "index.html", html: "<!doctype html><html><body>generated</body></html>" },
      { path: "sitemap.xml", html: "<urlset/>" }
    ])
    const started = performance.now()
    const head = await run(loadHead(repo.git, sha))
    const elapsedMs = performance.now() - started
    console.info(
      `loadHead(300 files + scaffold): ${elapsedMs.toFixed(0)} ms, size=${head.size}, skipped=${head.skipped}`
    )

    const candidates = await eligible(repo, sha)
    expect(candidates).toContain("areas/inbox/broken.html")
    expect(candidates).toContain("README.html")
    expect(head.sha).toBe(sha)
    expect(head.parent).toBeNull()
    // The scaffold's README.html is memory-shaped but predates the format's constraints, which is
    // exactly the live-store case the skip list exists for: counted, never thrown.
    const skippedPaths = head.skippedFiles.map((skip) => skip.path).sort()
    expect(skippedPaths).toEqual(["README.html", "areas/inbox/broken.html"])
    expect(head.skipped).toBe(2)
    expect(head.size).toBe(candidates.length - head.skipped)
    expect([...head.paths()].sort()).toEqual(
      candidates.filter((path) => !skippedPaths.includes(path)).sort()
    )
    expect(head.get("index.html")).toBeUndefined()
    expect(elapsedMs).toBeLessThan(10_000)
    // Measured 235 ms on 2026-09-23 (load average 7); the timeout is for the fixture's 300 file
    // writes plus `git add` and `git commit` under a loaded host, not for the load itself.
  }, 30_000)

  it("answers every index from the parsed records", async () => {
    const { repo, sha, files } = await corpus(30)
    const head = await run(loadHead(repo.git, sha))
    const eleven = files[11]
    if (eleven === undefined) throw new Error("fixture has 30 files")

    expect(head.byContentHash(contentHash(eleven.html))).toBe(eleven.path)
    expect(head.byFrameKey("the capital of country11 is")).toEqual([eleven.path])
    // File 12 links to file 11.
    expect(head.inbound(`/${eleven.path}`)).toEqual([memoryFor(12).path])
    // crop4 is named by every index congruent to 4 mod 7 that is not archived-or-not (byEntity is all records).
    const crop4 = files
      .filter((_, index) => index % 7 === 4)
      .map((file) => file.path)
      .sort()
    expect(head.byEntity("topic:crop4")).toEqual(crop4)
    expect(head.byEntity("topic:nobody")).toEqual([])
    expect(head.inbound("/nowhere.html")).toEqual([])
    expect(head.byFrameKey("no such frame")).toEqual([])
  })

  it("keeps archived records out of byContentHash and byFrameKey but in records, inbound, and byEntity", async () => {
    const { repo, sha, files } = await corpus(20)
    const head = await run(loadHead(repo.git, sha))
    const archived = files[9]
    if (archived === undefined) throw new Error("fixture has 20 files")
    expect(archived.path.startsWith("archive/")).toBe(true)

    expect(head.get(archived.path)?.archived).toBe(true)
    expect(head.byContentHash(contentHash(archived.html))).toBeUndefined()
    expect(head.byFrameKey("the capital of country9 is")).toEqual([])
    expect(head.byEntity("place:country9")).toEqual([archived.path])
    // File 10 links to the archived file 9; the edge is still visible.
    expect(head.inbound(`/${archived.path}`)).toEqual([memoryFor(10).path])
  })
})

describe("advanceHead", () => {
  it("shares every untouched record by reference after a one-file edit", async () => {
    const { repo, sha, files } = await corpus(40)
    const before = await run(loadHead(repo.git, sha))
    const edited = memoryFor(7)
    const next = await commitChanges(repo, [
      { path: edited.path, html: edited.html.replace("grows crop0", "grows cropX") }
    ])
    const after = await run(advanceHead(repo.git, before, next))

    expect(after.sha).toBe(next)
    expect(after.parent).toBe(before)
    expect(after.size).toBe(before.size)
    for (const file of files) {
      if (file.path === edited.path) continue
      expect(after.get(file.path)).toBe(before.get(file.path))
    }
    expect(after.get(edited.path)).not.toBe(before.get(edited.path))
    expect(after.get(edited.path)?.bodyText).toContain("cropX")
    expect(after.get(edited.path)?.blobSha).toBe(await blobAt(repo, next, edited.path))
    // The parent is immutable: its record still reads the old body.
    expect(before.get(edited.path)?.bodyText).toContain("grows crop0")
    // The lexical index moved the edited path from the old token to the new one and nothing else.
    expect(HashMap.has(after.lexical.postings, "cropx")).toBe(true)
    expect(HashMap.has(before.lexical.postings, "cropx")).toBe(false)
  })

  it("removes a deleted file, adds a new one, and re-parses a repaired skip", async () => {
    const { repo, sha } = await corpus(12, [{ path: "areas/inbox/broken.html", html: BROKEN_HTML }])
    const v1 = await run(loadHead(repo.git, sha))
    // README.html plus the broken file.
    expect(v1.skipped).toBe(2)

    const fresh = { path: "areas/inbox/fresh.html", html: memoryFor(500).html }
    const repaired = memoryFor(501)
    const gone = memoryFor(5)
    const sha2 = await commitChanges(repo, [
      { path: gone.path, html: null },
      fresh,
      { path: "areas/inbox/broken.html", html: repaired.html }
    ])
    const v2 = await run(advanceHead(repo.git, v1, sha2))

    expect(v2.get(gone.path)).toBeUndefined()
    expect(v1.get(gone.path)).toBeDefined()
    expect(v2.get(fresh.path)?.claim).toBe("The capital of Country500 is City500.")
    expect(v2.get("areas/inbox/broken.html")?.claim).toBe("The capital of Country501 is City501.")
    expect(v2.skippedFiles.map((skip) => skip.path)).toEqual(["README.html"])
    expect(v2.size).toBe(v1.size + 1)
    // The deleted file's edges and hash are gone from the active indexes.
    expect(v2.byContentHash(contentHash(gone.html))).toBeUndefined()
    expect(v2.byFrameKey("the capital of country5 is")).toEqual([])
    expect(v2.byEntity("place:country5")).toEqual([])
    // File 6 still links to file 5; inbound reports the edge because file 6 is unchanged.
    expect(v2.inbound(`/${gone.path}`)).toEqual([memoryFor(6).path])

    // Breaking a file counts it as skipped; a second advance over a no-op commit keeps that.
    const sha3 = await commitChanges(repo, [{ path: fresh.path, html: BROKEN_HTML }])
    const v3 = await run(advanceHead(repo.git, v2, sha3))
    expect(v3.skippedFiles.map((skip) => skip.path).sort()).toEqual(["README.html", fresh.path])
    expect(v3.get(fresh.path)).toBeUndefined()
    const sha4 = await commitChanges(repo, [], "empty")
    const v4 = await run(advanceHead(repo.git, v3, sha4))
    expect(v4.sha).toBe(sha4)
    expect(v4.skipped).toBe(2)
    expect(v4.get(memoryFor(6).path)).toBe(v3.get(memoryFor(6).path))
  }, 30_000)

  it("returns the same version when asked to advance to its own sha", async () => {
    const { repo, sha } = await corpus(3)
    const head = await run(loadHead(repo.git, sha))
    expect(await run(advanceHead(repo.git, head, sha))).toBe(head)
  })

  it("property: over random edit sets, untouched records are shared and touched ones match git", async () => {
    const count = 30
    const built = await corpus(count)
    const { repo } = built
    let current: HeadVersion = await run(loadHead(repo.git, built.sha))
    let generation = 0

    const edit = fc.record({
      index: fc.integer({ min: 0, max: count - 1 }),
      kind: fc.constantFrom("modify", "delete", "restore", "break")
    })

    await fc.assert(
      fc.asyncProperty(fc.array(edit, { minLength: 0, maxLength: 5 }), async (edits) => {
        generation += 1
        const changes = new Map<string, Change>()
        for (const { index, kind } of edits) {
          const file = memoryFor(index)
          const html =
            kind === "delete"
              ? null
              : kind === "break"
                ? BROKEN_HTML
                : kind === "restore"
                  ? file.html
                  : file.html.replace("Region", `Region gen${generation}`)
          changes.set(file.path, { path: file.path, html })
        }
        const touched = new Set(changes.keys())
        const before = current
        const next = await commitChanges(repo, [...changes.values()], `gen ${generation}`)
        const after = await run(advanceHead(repo.git, before, next))
        current = after

        expect(after.sha).toBe(next)
        for (const path of before.paths()) {
          if (!touched.has(path)) expect(after.get(path)).toBe(before.get(path))
        }
        for (const path of touched) {
          const blob = await blobAt(repo, next, path)
          const record = after.get(path)
          if (blob === null) {
            expect(record).toBeUndefined()
          } else if (after.skippedFiles.some((skip) => skip.path === path)) {
            expect(record).toBeUndefined()
          } else {
            expect(record?.blobSha).toBe(blob)
          }
        }
        // The delta agrees with a from-scratch load of the same commit.
        const fresh = await run(loadHead(repo.git, next))
        expect([...after.paths()].sort()).toEqual([...fresh.paths()].sort())
        expect(after.skipped).toBe(fresh.skipped)
        for (const path of fresh.paths()) {
          expect(after.get(path)?.blobSha).toBe(fresh.get(path)?.blobSha)
        }
        expect(HashMap.size(after.lexical.lengths)).toBe(HashMap.size(fresh.lexical.lengths))
        expect(after.lexical.totalLength).toBe(fresh.lexical.totalLength)
      }),
      { numRuns: 12 }
    )
  }, 60_000)
})
