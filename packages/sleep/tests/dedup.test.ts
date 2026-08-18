import { archivePathFor, originalPathFor } from "@memhtml/contracts/paths"
import { contentHash, readMeta } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { PhaseEnv } from "../src/env.js"
import { dedupMerge } from "../src/phases/dedup-merge.js"
import { instantFor } from "../src/run.js"
import { DEDUP_CORPUS, type Fixture, withFixture } from "./fixture.js"

/**
 * The dedup-merge phase, and specifically its VETO.
 *
 * The corpus carries a true duplicate AND a negation-flipped near-twin whose cosine is HIGHER than the
 * duplicate's (0.9907 against 0.9277, measured). So the veto's effect is observable: without it, the
 * flipped pair merges — and because the merge keeps the OLDER file, it would restore exactly the claim
 * the newer memory was written to correct. That is why the fixture holds a neighbor and not just a
 * subject.
 */

const DATE = "2026-08-02"

const envFor = (fixture: Fixture, dryRun = false): PhaseEnv => {
  const instant = instantFor(DATE)
  return {
    deps: fixture.deps,
    runId: `sleep/${DATE}`,
    branch: `sleep/${DATE}`,
    baseSha: "",
    date: DATE,
    at: instant.at,
    atMillis: instant.millis,
    dryRun
  }
}

/**
 * A path's bytes at HEAD, or `undefined` when HEAD does not hold it.
 *
 * Reads `git show` through the store's own `run`, NOT through `fixture.raw`: `raw` is `orDie`, so a
 * missing path becomes a DEFECT that `orElseSucceed` cannot catch — the test would crash where it
 * means to observe an absence, which is half of what a veto assertion is.
 */
const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

const KEEPER = "areas/oncall/drain-the-vip-first.html"
const DUPLICATE = "areas/oncall/vip-drain-precedes-revert.html"
const SAFE = "areas/deploy/blue-green-is-safe.html"
const NOT_SAFE = "areas/deploy/blue-green-is-not-safe.html"

describe("dedup-merge", () => {
  it("merges the true duplicate with a supersedes link and vetoes the negation flip", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const env = envFor(fixture)
          const outcome = yield* dedupMerge(env)

          /**
           * The corpus holds THREE candidate pairs above the threshold: two true duplicates and the
           * negation flip. Exactly one is vetoed, and the count is asserted alongside the per-file
           * observations below — the counter alone would not say WHICH pair was refused.
           */
          expect(outcome.counts.vetoed).toBe(1)
          expect(outcome.counts.merged).toBe(2)
          expect(outcome.commitSha).not.toBeNull()

          // The DUPLICATE moved into the archive, under the year the run's own date names.
          const archived = archivePathFor(DUPLICATE, 2026)
          expect(yield* atHead(fixture, archived)).toBeDefined()
          expect(yield* atHead(fixture, DUPLICATE)).toBeUndefined()
          expect(originalPathFor(archived)).toBe(DUPLICATE)

          // The keeper is the OLDER file, and it gained a supersedes toward the ARCHIVE path — not
          // toward the pre-archive path, which would dangle in the same commit that made it dangle.
          const keeper = yield* atHead(fixture, KEEPER)
          expect(keeper).toContain(`<link rel="memhtml-supersedes" href="/${archived}">`)

          // The archived file points back, and carries the archive stamps.
          const dropped = yield* atHead(fixture, archived)
          expect(readMeta(dropped ?? "", "memhtml-status")).toBe("archived")
          expect(readMeta(dropped ?? "", "memhtml-archived")).toBe(`${DATE}T00:00:00Z`)
          expect(dropped).toContain(`content="/${KEEPER}"`)

          /**
           * THE VETO. Both halves of the flipped pair are still live at their original paths, and
           * neither gained a supersedes. This is the assertion the whole fixture exists to make.
           */
          expect(yield* atHead(fixture, SAFE)).toBeDefined()
          expect(yield* atHead(fixture, NOT_SAFE)).toBeDefined()
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-supersedes")
          expect(yield* atHead(fixture, NOT_SAFE)).not.toContain("memhtml-supersedes")
          expect(yield* atHead(fixture, archivePathFor(NOT_SAFE, 2026))).toBeUndefined()
          expect(yield* atHead(fixture, archivePathFor(SAFE, 2026))).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("keeps the keeper's content hash unchanged: the supersedes link is a HEAD edit", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, KEEPER)
          yield* dedupMerge(envFor(fixture))
          const after = yield* atHead(fixture, KEEPER)

          expect(after).not.toBe(before)
          /**
           * The bytes changed and the ARTICLE hash did not. That is what the byte-splice head editors
           * buy: a `<link>` addition provably cannot move the dedup key, so a merge cannot make the
           * keeper collide with — or stop colliding with — another file's content.
           */
          expect(contentHash(after ?? "")).toBe(contentHash(before ?? ""))
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("counts on a dry run and writes nothing", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* dedupMerge(envFor(fixture, true))

          // The counts are REAL on a dry run — including the veto. Only the writes are withheld.
          expect(outcome.counts.merged).toBe(2)
          expect(outcome.counts.vetoed).toBe(1)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("is a fixed point on a second run: the merged duplicate is no longer a candidate", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))
          // Re-index so the phase sees the post-merge corpus, exactly as the next night's run would.
          yield* fixture.reindex()
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          const second = yield* dedupMerge(envFor(fixture))
          expect(second.counts.merged).toBe(0)
          expect(second.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})
