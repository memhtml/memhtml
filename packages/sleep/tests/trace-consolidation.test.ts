import { isSlug, SLUG_MAX_LENGTH } from "@memhtml/contracts/slug"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { TRAILER_COUNTS, TRAILER_PHASE, TRAILER_RUN } from "../src/contract.js"
import type { PhaseEnv } from "../src/env.js"
import {
  TRACE_MIN_BYTES,
  TRACE_SESSIONS_PER_RUN,
  traceConsolidation
} from "../src/phases/trace-consolidation.js"
import { instantFor } from "../src/run.js"
import { sessionManifestRows } from "../src/sql.js"
import {
  candidate,
  candidates,
  consolidatorFailure,
  partiallyRead,
  scriptedConsolidator
} from "../src/testing.js"
import {
  consolidationWatermarks,
  DEDUP_CORPUS,
  type Fixture,
  memoryHtml,
  seedSessionLink,
  seedTrace,
  withFixture
} from "./fixture.js"

/**
 * Trace consolidation v2, against a real repo and a real database.
 *
 * The scripted consolidator stands in for the eve agent and nothing else is faked: git is a temp-dir
 * repo driven by the store's own subprocess wrapper, the database carries the shipped migrations, and
 * the transcripts are real files outside that repo. Every assertion about a commit reads GIT.
 *
 * Two things this suite is built to avoid, both from `.erpaval`:
 *
 * The cross-phase-contamination lesson says a phase fixture must carry the writes of the phases that
 * run before it. trace-consolidation is phase twelve, so the corpus here is `DEDUP_CORPUS` — the same
 * one every other phase test uses — and the full-run test in `run.test.ts` is what exercises the phase
 * downstream of eleven real predecessors.
 *
 * The vacuous-lock lesson says a guard is a comment until it has been seen to fail. Every case below
 * that locks a behavior names the mutation that breaks it, and the packet records the runs.
 */

const DATE = "2026-08-08"

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

const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/** Every path added between two revisions. What proves WHICH files a phase created. */
const addedPaths = (fixture: Fixture, from: string): Effect.Effect<ReadonlyArray<string>> =>
  fixture.deps.git.diffNameStatus(from, "HEAD").pipe(
    Effect.map((changes) =>
      changes.filter((change) => change.kind === "added").map((change) => change.path)
    ),
    Effect.orDie
  )

const headSha = (fixture: Fixture): Effect.Effect<string> =>
  fixture.raw("rev-parse", "HEAD").pipe(Effect.map((text) => text.trim()))

const commitCount = (fixture: Fixture): Effect.Effect<number> =>
  fixture.raw("rev-list", "--count", "HEAD").pipe(Effect.map((text) => Number(text.trim())))

/** One commit's full message, for asserting on the body a reviewer reads. */
const messageOf = (fixture: Fixture, sha: string): Effect.Effect<string> =>
  fixture.raw("log", "-1", "--format=%B", sha)

/** A memory path's filename stem, which is the slug the length budget applies to. */
const stemOf = (path: string): string => {
  const filename = path.slice(path.lastIndexOf("/") + 1)
  return filename.replace(/\.html$/, "")
}

describe("trace-consolidation degradation", () => {
  it("is skipped with a reason, not failed, when no consolidator is bound", async () => {
    /**
     * INV-3's base case, mirroring `conflict-detection`'s "no model bound" exactly. This is the shape
     * CI takes — no Bedrock credentials, so `layerConsolidatorPort` binds nothing — and it must read
     * as skipped rather than as a degradation or a failure.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.detail).toBe("no consolidator bound")
          expect(outcome.counts.consolidated).toBe(0)
          expect(outcome.counts.candidates).toBe(0)
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect(yield* headSha(fixture)).toBe(before)
          // And no watermark: an unbound phase must not claim to have read anything.
          expect(yield* consolidationWatermarks(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("keeps the run green when the consolidator itself fails, naming the failure class", async () => {
    /**
     * TRACE-4 verbatim: credentials present but the call failed. The phase returns `ok` — the runner
     * only records `failed` when a phase's error channel fires — with `consolidated: 0` and a detail
     * carrying the `_tag`, so an operator can tell an unreachable agent from an empty answer.
     *
     * (Mutation: replacing the `Effect.result` around `consolidate` with a bare `yield*` makes the
     * phase's error channel fire; the runner then reports `failed` and this case fails.)
     */
    const consolidator = scriptedConsolidator(() =>
      consolidatorFailure("ConsolidatorRunFailed", "the turn exceeded its budget")
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.detail).toBe("consolidator unavailable: ConsolidatorRunFailed")
          expect(outcome.counts.consolidated).toBe(0)
          // The batch WAS selected and handed over: the failure is the agent's, not the query's.
          expect(outcome.counts.batch).toBe(1)
          expect(outcome.commitSha).toBeNull()
          expect(yield* headSha(fixture)).toBe(before)

          /**
           * NOTHING IS WATERMARKED. A failed call must leave the session unconsolidated, or the
           * transcript is lost — marked read with no memory to show for it and nothing saying so.
           */
          expect(yield* consolidationWatermarks(fixture)).toEqual([])
          // And nothing is left staged for a later phase's commit to absorb.
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("reports a barren answer differently from a failed one, both green", async () => {
    /**
     * The two `consolidated: 0` outcomes an operator must be able to distinguish. "The agent read ten
     * transcripts and found nothing above the bar" is a successful night; "the agent could not be
     * asked" is not. A phase that folded both into one detail would make the difference unreadable.
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.detail).toBeUndefined()
          expect(outcome.counts.candidates).toBe(0)
          expect(outcome.counts.written).toBe(0)
          expect(outcome.commitSha).toBeNull()

          /**
           * The barren session IS watermarked, which the failed case above shows is not automatic. The
           * agent read it and correctly found nothing; re-reading it every night forever would mean
           * the batch never advances past a quiet session.
           */
          expect(yield* consolidationWatermarks(fixture)).toEqual([
            { session_id: "session-a", run_id: `sleep/${DATE}` }
          ])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})

describe("trace-consolidation happy path", () => {
  it("lands ONE COMMIT PER CANDIDATE, each carrying the full trailer block", async () => {
    /**
     * TRACE-1 and TRACE-3 together: candidates become memories, and each is its own reviewable commit
     * on the sleep branch — which is what puts it behind the discrimination gate, since `merge`'s
     * `preMergeGate` runs over the whole branch.
     */
    const consolidator = scriptedConsolidator(() =>
      candidates(
        [
          candidate({
            claim:
              "Partial indexes on this driver need the predicate restated in the query to be chosen.",
            gist: "Three separate lookups planned as SCAN until the redundant IS NOT NULL clause was added, across two different tables.",
            kind: "error_pattern",
            entities: ["service:sqlite"]
          }),
          candidate({
            claim: "Fixture corpora go stale one phase before the phase under test.",
            gist: "Four separate debugging sessions ended at a preceding phase's write rather than the phase being tested.",
            kind: "agent_insight"
          })
        ],
        5
      )
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* seedTrace(fixture, { sessionId: "session-b" })
          const base = yield* headSha(fixture)
          const commitsBefore = yield* commitCount(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.candidates).toBe(2)
          expect(outcome.counts.written).toBe(2)
          expect(outcome.counts.skipped).toBe(0)
          expect(outcome.commitSha).not.toBeNull()
          // `llmCalls` is the agent's own count, passed through rather than assumed to be one.
          expect(outcome.llmCalls).toBe(5)

          // TWO commits for two candidates, asserted against git rather than against the report.
          expect(yield* commitCount(fixture)).toBe(commitsBefore + 2)

          // Both files exist at ordinary memory paths, and BOTH sessions were handed over.
          const added = yield* addedPaths(fixture, base)
          expect(added).toHaveLength(2)
          for (const path of added) {
            expect(path.endsWith(".html")).toBe(true)
            expect(path.startsWith("archive/")).toBe(false)
          }

          /**
           * Every commit carries all three trailers, and `Memhtml-Counts` is parseable JSON — which is
           * what `sleep resume` and `sleep review` read. A commit missing `Memhtml-Phase` would be a
           * commit a resume cannot see, so the phase would re-execute forever.
           */
          const range = `${base}..HEAD`
          for (const key of [TRAILER_RUN, TRAILER_PHASE, TRAILER_COUNTS]) {
            const records = yield* fixture.deps.git.logTrailers(range, key).pipe(Effect.orDie)
            expect(records, key).toHaveLength(2)
          }
          const phases = yield* fixture.deps.git
            .logTrailers(range, TRAILER_PHASE)
            .pipe(Effect.orDie)
          expect(phases.every((one) => one.values[0] === "trace-consolidation")).toBe(true)
          const counts = yield* fixture.deps.git
            .logTrailers(range, TRAILER_COUNTS)
            .pipe(Effect.orDie)
          for (const record of counts) {
            const parsed = JSON.parse(record.values[0] ?? "") as Record<string, number>
            expect(parsed.batch).toBe(2)
            expect(parsed.candidates).toBe(2)
          }

          // Both sessions are watermarked, under this run.
          expect(yield* consolidationWatermarks(fixture)).toEqual([
            { session_id: "session-a", run_id: `sleep/${DATE}` },
            { session_id: "session-b", run_id: `sleep/${DATE}` }
          ])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("writes an ordinary memory whose body holds the CLAIM and no transcript span", async () => {
    /**
     * The trace plane's central invariant, and the one this phase could most easily break. `.memhtml`
     * holds no session content: the distilled claim reaches the corpus and the verbatim evidence does
     * NOT, however convenient it would be as supporting prose.
     *
     * (Mutation: adding the evidence quotes to `body` fails this case on the `not.toContain` lines
     * while every count assertion in this file still passes — which is exactly how quietly that would
     * ship.)
     */
    const QUOTE_A = "SPECIFIC-VERBATIM-SPAN-ALPHA that must never reach the corpus"
    const QUOTE_B = "SPECIFIC-VERBATIM-SPAN-BETA that must never reach the corpus"
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({
          claim: "Partial indexes on this driver need their predicate restated in the query.",
          gist: "The distilled prose, which IS allowed in the body.",
          kind: "error_pattern",
          entities: ["service:sqlite", "person:sanju"],
          evidence: [
            { sessionId: "session-a", quote: QUOTE_A },
            { sessionId: "session-b", quote: QUOTE_B }
          ]
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* seedTrace(fixture, { sessionId: "session-b" })
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))
          const [path] = yield* addedPaths(fixture, base)
          expect(path).toBeDefined()

          const html = yield* atHead(fixture, path ?? "")
          expect(html).toBeDefined()

          // NO transcript span in the file, at the BYTE level — not merely absent from the parsed body.
          expect(html).not.toContain(QUOTE_A)
          expect(html).not.toContain(QUOTE_B)

          const doc = yield* parseMemory(html ?? "")
          // The claim is the `<mark>`, so it is what `files.gist` and Tier 1 disclosure will hold.
          expect(doc.article.gist).toContain("Partial indexes on this driver")
          expect(doc.article.bodyText).toContain("The distilled prose")
          expect(doc.article.bodyText).not.toContain("SPECIFIC-VERBATIM-SPAN")
          // An ordinary memory: the sleep author, the candidate's own kind, the entities it named.
          expect(doc.metas.author).toBe("agent:sleep")
          expect(doc.metas.memoryType).toBe("error_pattern")
          expect(doc.metas.status).toBe("active")
          expect(doc.entities).toContain("service:sqlite")

          /**
           * The evidence IS in the commit message, which is where a reviewer needs it — a commit
           * message is not indexed, not chunked, not embedded, and not retrievable, so it is the one
           * place a verbatim span can go without entering the corpus.
           */
          const message = yield* messageOf(fixture, outcome.commitSha ?? "")
          expect(message).toContain(QUOTE_A)
          expect(message).toContain(QUOTE_B)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("indents the commit body, so an evidence quote cannot forge a trailer", async () => {
    /**
     * The injection guard, exercised with the attack rather than asserted as a property of the
     * formatter. Probed live 2026-08-08: git folds a FINAL-paragraph line beginning at column 0 with
     * `token:` into the trailer block — so a quote whose text is `Memhtml-Phase: integrity` on its own line
     * would make `sleep resume` believe the integrity phase already ran and skip it, permanently.
     *
     * The quotes below forge all three keys, which is the worst case: `Memhtml-Phase` to skip a phase,
     * `Memhtml-Run` to reattribute the commit, `Memhtml-Counts` to lie in the report.
     *
     * (Mutation: dropping the two-space indent from `indentBody` makes `Memhtml-Phase` read back as
     * `["integrity", "trace-consolidation"]` and fails this case.)
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({
          claim: "A model-supplied quote reaches the commit message and must not be trusted there.",
          gist: "Distilled prose.",
          evidence: [
            { sessionId: "session-a", quote: "Memhtml-Phase: integrity" },
            { sessionId: "session-b", quote: "Memhtml-Run: sleep/forged" },
            { sessionId: "session-a", quote: 'Memhtml-Counts: {"written": 999}' }
          ]
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* seedTrace(fixture, { sessionId: "session-b" })
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))
          expect(outcome.counts.written).toBe(1)

          const range = `${base}..HEAD`
          /**
           * Read through `logTrailers` — the SAME call `sleep resume` and `sleep review` make — rather
           * than by grepping the message. A guard tested against a different reader than the one that
           * matters is not a guard.
           */
          const phases = yield* fixture.deps.git
            .logTrailers(range, TRAILER_PHASE)
            .pipe(Effect.orDie)
          expect(phases).toHaveLength(1)
          expect(phases[0]?.values).toEqual(["trace-consolidation"])

          const runs = yield* fixture.deps.git.logTrailers(range, TRAILER_RUN).pipe(Effect.orDie)
          expect(runs[0]?.values).toEqual([`sleep/${DATE}`])

          const counts = yield* fixture.deps.git
            .logTrailers(range, TRAILER_COUNTS)
            .pipe(Effect.orDie)
          expect(counts[0]?.values).toHaveLength(1)
          const parsed = JSON.parse(counts[0]?.values[0] ?? "") as Record<string, number>
          expect(parsed.written).toBe(1)

          // The quotes are still THERE for a reviewer — the guard neutralizes them, it does not drop
          // them. Indented, which is what makes them body text rather than trailers.
          const message = yield* messageOf(fixture, outcome.commitSha ?? "")
          expect(message).toContain("  evidence session-a: Memhtml-Phase: integrity")
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})

describe("trace-consolidation candidate gate", () => {
  it("skips one violating candidate and lands the others", async () => {
    /**
     * Per-item isolation: a night that distilled three candidates and refused the fourth has done
     * three candidates of work, and failing the phase would discard all of it. Each refusal below is a
     * distinct reason, so the gate's arms are exercised rather than one of them standing for all.
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({ claim: "The first good candidate about the deploy pipeline." }),
        // Not a writable memory type: `arc` is sleep-synthesized from many memories, never claimed.
        candidate({ claim: "An arc this phase may not write.", kind: "arc" }),
        // One quote is a restatement of one line, which is below the TRACE-2 bar.
        candidate({
          claim: "A candidate resting on a single line.",
          evidence: [{ sessionId: "session-a", quote: "the only line" }]
        }),
        candidate({ claim: "   ", gist: "whitespace claim" }),
        /**
         * A claim that slugs to nothing. `slugify` folds to `[a-z0-9-]`, so an all-CJK claim reduces
         * to `SLUG_FALLBACK` — and every such candidate, on unrelated subjects, would file under the
         * one `untitled` stem. A path is the id here, so an id carrying no subject is not one a
         * reviewer or a later correction can address.
         *
         * (Mutation: dropping the `slugify(titleFor(claim)) === SLUG_FALLBACK` arm from `refusalFor`
         * writes `areas/inbox/untitled.html` and fails this case on both counts.)
         */
        candidate({ claim: "日本語のみの主張", gist: "prose whose claim slugs to nothing" }),
        candidate({ claim: "The second good candidate about the retry budget." })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.candidates).toBe(6)
          expect(outcome.counts.written).toBe(2)
          expect(outcome.counts.skipped).toBe(4)
          // Two commits for the two that cleared the gate; the four refusals wrote no file at all.
          expect(yield* addedPaths(fixture, base)).toHaveLength(2)
          // And nothing landed on the fallback stem, which is the shape a missing slug gate takes.
          expect(yield* atHead(fixture, "areas/inbox/untitled.html")).toBeUndefined()

          /**
           * The session is STILL watermarked. A batch whose candidates were mostly refused has still
           * been read, and the refusals are about the candidates rather than about the transcripts —
           * re-reading them would produce the same refusals at the same cost.
           */
          expect(yield* consolidationWatermarks(fixture)).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("gives two candidates with the same leading clause two different paths", async () => {
    /**
     * The in-run collision case. The phase writes several files before any commit, so it cannot ask
     * git what it has staged, and two claims sharing a leading clause slug identically — the second
     * write would silently overwrite the first and one memory would vanish with every count still
     * reading 2.
     *
     * (Mutation: dropping the `claimed` set from `freePath` makes both candidates take one path;
     * `written` still reports 2 and only the added-paths assertion fails.)
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({ claim: "The retry budget is exhausted. First variant." }),
        candidate({ claim: "The retry budget is exhausted. Second variant." })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))
          expect(outcome.counts.written).toBe(2)

          const added = yield* addedPaths(fixture, base)
          expect(added).toHaveLength(2)
          expect(new Set(added).size).toBe(2)
          // Both files really hold content, so "two paths" is not two names for one write.
          for (const path of added) {
            expect(yield* atHead(fixture, path)).toBeDefined()
          }
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("leaves a file already ON DISK at the candidate's path untouched, taking -2 instead", async () => {
    /**
     * The CROSS-RUN collision, which the in-run case above cannot reach and which the earlier
     * `claimed`-only probe let through. Reproduced live 2026-08-08: a repeat claim on a later night
     * slugs to the stem a previous night — or a human correction — already occupies, and the write
     * landed as a MODIFY over it. Nothing anywhere said so: `written: 1`, `skipped: 0`,
     * `conflicts: 0`, and the replaced bytes recoverable only from git history nobody was told to
     * read.
     *
     * The frame-conflict assist cannot substitute for this guard, twice over: it never suppresses a
     * write by design (INV-1), and the file it would name IS the victim.
     *
     * The victim is seeded with a claim carrying a HAND-CORRECTION marker, so the assertion is that
     * a human's edit survives rather than merely that two files exist. And its bytes are compared
     * exactly, because a same-path write that happened to render identically would pass a weaker
     * check.
     *
     * The claim is deliberately long enough that its slug lands EXACTLY on `SLUG_MAX_LENGTH`, so the
     * `-2` this test forces is also the case where a plainly concatenated suffix overflows the
     * budget to 82 characters and stops being a slug at all. One fixture, both guards.
     *
     * (Mutation: dropping the `readFileBytes` probe from `freePath` — leaving the `claimed` check
     * alone — makes the second run overwrite the seeded file and fails this case. Replacing
     * `withCollisionOrdinal` with plain concatenation fails the `isSlug` assertion below.)
     */
    const REPEATED_CLAIM =
      "The retry budget for the payments gateway circuit breaker is exhausted long before " +
      "the breaker itself opens on a rollback."
    const consolidator = scriptedConsolidator(() =>
      candidates([candidate({ claim: REPEATED_CLAIM, gist: "The pattern, distilled again." })])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // Night one: the phase writes the claim itself, so the occupied path is the one the
          // shipped placement rules really produce rather than one this test guessed at.
          yield* seedTrace(fixture, { sessionId: "session-night-one" })
          const beforeFirst = yield* headSha(fixture)
          const first = yield* traceConsolidation(envFor(fixture))
          expect(first.counts.written).toBe(1)

          const [victimPath] = yield* addedPaths(fixture, beforeFirst)
          expect(victimPath).toBeDefined()

          // The stem is at the length ceiling, which is what makes the `-2` below a budget case.
          expect(stemOf(victimPath ?? "")).toHaveLength(SLUG_MAX_LENGTH)

          // A human then corrects it in place. This is the state that must survive night two.
          const corrected = memoryHtml({
            title: "The retry budget for the payments gateway circuit breaker is exhausted",
            claim: REPEATED_CLAIM,
            body: "HAND-CORRECTED-BY-A-REVIEWER: the breaker opens at five, not three.",
            memoryType: "semantic",
            createdAt: "2026-08-01T00:00:00Z"
          })
          yield* fixture.commit([{ path: victimPath ?? "", html: corrected }], "correct by hand")
          const beforeSecond = yield* headSha(fixture)

          // Night two: a new session, the same claim back from the agent.
          yield* seedTrace(fixture, { sessionId: "session-night-two" })
          const second = yield* traceConsolidation(envFor(fixture))
          expect(second.counts.written).toBe(1)

          /**
           * The victim's bytes are BYTE-IDENTICAL to the hand correction, and the new memory sits at
           * its own path. Asserted through git rather than the filesystem, because what a reviewer
           * merges is the tree.
           */
          expect(yield* atHead(fixture, victimPath ?? "")).toBe(corrected)

          const added = yield* addedPaths(fixture, beforeSecond)
          expect(added).toHaveLength(1)
          expect(added[0]).not.toBe(victimPath)
          // The `-2` ordinal, in the same directory: the placement rule did not move, the stem did.
          expect(added[0]).toMatch(/-2\.html$/)
          /**
           * And the suffix landed INSIDE the length budget. The victim's stem is already at
           * `SLUG_MAX_LENGTH`, so plain concatenation would produce 82 characters — a filename
           * `isSlug` rejects, which every other path in the corpus satisfies.
           */
          const suffixedStem = stemOf(added[0] ?? "")
          expect(suffixedStem.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
          expect(isSlug(suffixedStem)).toBe(true)
          expect(yield* atHead(fixture, added[0] ?? "")).toContain("The pattern, distilled again.")

          /**
           * And the second commit is an ADDITION, not a modification. `diffNameStatus` is what
           * `addedPaths` reads, so a phase that had overwritten the victim would show `modified`
           * here and add nothing — which is exactly how quietly the original bug shipped.
           */
          const changes = yield* fixture.deps.git
            .diffNameStatus(beforeSecond, "HEAD")
            .pipe(Effect.orDie)
          expect(changes.filter((change) => change.kind === "modified")).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})

describe("trace-consolidation conflict assist", () => {
  /**
   * A live memory occupying a frame key, plus a candidate whose claim occupies the SAME key with a
   * different value. Both go through `frameKeyOf`, so the pair is a real collision under the shipped
   * rule rather than one this test asserts by fiat.
   */
  const FRAMED_CLAIM = "The owner of the deploy runbook is Priya."
  const CANDIDATE_CLAIM = "The owner of the deploy runbook is Marcus."

  const FRAMED_CORPUS = [
    ...DEDUP_CORPUS,
    {
      path: "areas/deploy/runbook-owner.html",
      html: memoryHtml({
        title: "The deploy runbook's owner",
        claim: FRAMED_CLAIM,
        body: "Recorded when the rotation was last reviewed.",
        memoryType: "semantic",
        createdAt: "2026-06-01T00:00:00Z"
      })
    }
  ]

  it("writes the candidate ANYWAY and counts the conflict, never suppressing it", async () => {
    /**
     * TRACE-5 plus INV-1. The assist proposes and never blocks, because sometimes the contradiction IS
     * the answer: a distilled claim that the runbook's owner changed necessarily contradicts the
     * memory naming the old owner, and a phase that declined to write it would keep the corpus tidy by
     * never recording the change.
     *
     * (Mutation: deleting the `activeFramesFor` lookup — returning an empty map from
     * `frameConflicts` — leaves `written: 1` correct and fails only on `conflicts` and the commit
     * message, which is why both are asserted.)
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([candidate({ claim: CANDIDATE_CLAIM, gist: "The rotation changed hands." })])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          // WRITTEN, not suppressed, and the conflict is counted.
          expect(outcome.counts.written).toBe(1)
          expect(outcome.counts.conflicts).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

          const added = yield* addedPaths(fixture, base)
          expect(added).toHaveLength(1)

          // The count reaches the `Memhtml-Counts` trailer, which is what `sleep review` reads.
          const counts = yield* fixture.deps.git
            .logTrailers(`${base}..HEAD`, TRAILER_COUNTS)
            .pipe(Effect.orDie)
          const parsed = JSON.parse(counts[0]?.values[0] ?? "") as Record<string, number>
          expect(parsed.conflicts).toBe(1)

          /**
           * And the commit NAMES the conflicting path and its claim, in both the subject and the body.
           * A reviewer at merge review sees which live memory disagrees without running a query.
           */
          const message = yield* messageOf(fixture, outcome.commitSha ?? "")
          expect(message).toContain("frame conflict")
          expect(message).toContain("areas/deploy/runbook-owner.html")
          expect(message).toContain("Priya")

          /**
           * NO AUTHORED EDGE, and no archive of either side. This is the mechanical half of the
           * decision: `conflictCandidates` anti-joins on `derived = 0`, so ANY authored edge between
           * two paths permanently closes that pair to the NLI phase — stamping one here would silence
           * the disagreement this lookup just found.
           */
          const existing = yield* atHead(fixture, "areas/deploy/runbook-owner.html")
          expect(existing).toBeDefined()
          expect(existing).not.toContain("memhtml-contradicts")
          expect(existing).not.toContain("memhtml-superseded-by")
          const written = yield* atHead(fixture, added[0] ?? "")
          expect(written).not.toContain("memhtml-contradicts")
          expect(written).not.toContain("memhtml-supersedes")
          // The existing memory's bytes are UNTOUCHED: the assist reads and never writes.
          expect(existing).toContain(FRAMED_CLAIM)
        }),
      { seed: FRAMED_CORPUS, consolidator }
    )
  })

  it("counts no conflict for a candidate whose claim occupies no live slot", async () => {
    /**
     * The non-vacuity control for the case above. A corpus where every candidate conflicts would pass
     * against a phase that counted `conflicts: candidates.length` unconditionally, so the same corpus
     * is run with a claim that keys differently — same fixture, same lookup, zero conflicts.
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({ claim: "The owner of the incident channel is Marcus." }),
        // No frame shape at all: `frameKeyOf` returns null, so this one is not even looked up.
        candidate({ claim: "Retries help." })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.written).toBe(2)
          expect(outcome.counts.conflicts).toBe(0)
        }),
      { seed: FRAMED_CORPUS, consolidator }
    )
  })
})

describe("trace-consolidation session selection", () => {
  it("skips a transcript below the byte floor, and takes one just above it", async () => {
    /**
     * The floor as a BOUNDARY rather than as a comparison against a far-away number: one session one
     * byte below and one exactly at the floor, so `>` versus `>=` is decided by this test.
     *
     * (Mutation: changing `file_size >= ?` to `> ?` drops the at-floor session and fails here.)
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-tiny", fileSize: TRACE_MIN_BYTES - 1 })
          yield* seedTrace(fixture, { sessionId: "session-at-floor", fileSize: TRACE_MIN_BYTES })

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.batch).toBe(1)
          // The at-floor session is the one that went, and the tiny one is still unconsolidated.
          expect((yield* consolidationWatermarks(fixture)).map((row) => row.session_id)).toEqual([
            "session-at-floor"
          ])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("skips a transcript still being written, judged against the RUN's instant", async () => {
    /**
     * The live-session guard. `session-live` was modified inside the quiet window before the run's own
     * instant, so it is a session that may still be in progress; reading it would take half a
     * conversation and then watermark it as done.
     *
     * The window is derived from `env.at` — midnight of the run date — and NOT from a clock, which is
     * what makes this assertable at all: a phase reading wall-clock would give a different answer
     * every time this test ran.
     *
     * (Mutation: dropping the `file_mtime < ?` clause admits `session-live` and fails here.)
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // Half an hour before the run's midnight instant: inside the one-hour quiet window.
          yield* seedTrace(fixture, {
            sessionId: "session-live",
            fileMtime: "2026-08-07T23:30:00Z"
          })
          // A day earlier: settled.
          yield* seedTrace(fixture, {
            sessionId: "session-settled",
            fileMtime: "2026-08-06T12:00:00Z"
          })

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.batch).toBe(1)
          expect((yield* consolidationWatermarks(fixture)).map((row) => row.session_id)).toEqual([
            "session-settled"
          ])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("keeps a sub-second mtime inside the boundary second on the live side of the cutoff", async () => {
    /**
     * The quiet window at its exact edge, with the millisecond field the corpus actually carries.
     *
     * `traces.file_mtime` is written as `new Date(mtimeMs).toISOString()`
     * (`packages/index/src/traces-persist.ts:446`), so a real row is 24 characters with a `.mmm`
     * fraction, and `unconsolidatedSessions` compares it to the cutoff as TEXT (`sql.ts:449`). A
     * cutoff truncated to seconds is 20 characters, and `'.' (0x2E) < 'Z' (0x5A)` — so EVERY
     * sub-second suffix sorts below a `…:00Z` cutoff and every session modified inside the cutoff's
     * own second is admitted as settled, half a conversation read and then watermarked as done.
     *
     * The run's instant is midnight 2026-08-08, so the cutoff is `2026-08-07T23:00:00.000Z`.
     * `session-boundary` at `.500Z` is 500 ms INSIDE the window and must be skipped; `session-just-
     * settled` at 500 ms outside it must be taken, which is what keeps this a boundary test rather
     * than a proof that the window excludes everything.
     *
     * (Mutation: restoring `.slice(0, 19).concat("Z")` on `settledBefore` admits
     * `session-boundary` and fails here.)
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, {
            sessionId: "session-boundary",
            fileMtime: "2026-08-07T23:00:00.500Z"
          })
          yield* seedTrace(fixture, {
            sessionId: "session-just-settled",
            fileMtime: "2026-08-07T22:59:59.500Z"
          })

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.batch).toBe(1)
          expect((yield* consolidationWatermarks(fixture)).map((row) => row.session_id)).toEqual([
            "session-just-settled"
          ])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("caps the batch and takes the NEWEST sessions, so a first run is an increment", async () => {
    /**
     * The first-run guard, and the ORDER is half of it. A fresh install faces a year of transcripts,
     * and an uncapped batch would hand thousands of files to one agent session. Newest-first makes the
     * cap a policy: the cycle distills recent sessions first and works backwards a batch per night.
     *
     * The sessions are seeded in an order that DISAGREES with their mtimes, so a phase that took the
     * first N rows rather than the newest N would fail rather than pass by insertion luck.
     *
     * (Mutation: dropping `LIMIT ?` hands over all 14; dropping `DESC` takes the oldest ten.)
     */
    const consolidator = scriptedConsolidator(() => candidates([]))
    const total = TRACE_SESSIONS_PER_RUN + 4

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // Seeded oldest-LAST by id but with mtimes running the other way, so insertion order and
          // recency order are deliberately opposed.
          for (let at = 0; at < total; at += 1) {
            yield* seedTrace(fixture, {
              sessionId: `session-${String(at).padStart(2, "0")}`,
              fileMtime: `2026-07-${String(total - at).padStart(2, "0")}T00:00:00Z`
            })
          }

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.batch).toBe(TRACE_SESSIONS_PER_RUN)
          const taken = (yield* consolidationWatermarks(fixture)).map((row) => row.session_id)
          expect(taken).toHaveLength(TRACE_SESSIONS_PER_RUN)
          /**
           * The NEWEST ten by mtime, which — given the inverted seeding — are ids 00..09. A phase
           * reading in insertion order would coincidentally agree here, which is why the mtimes are
           * inverted: ordering by mtime ASC would take ids 04..13 instead.
           */
          expect(taken).toEqual(
            Array.from(
              { length: TRACE_SESSIONS_PER_RUN },
              (_, at) => `session-${String(at).padStart(2, "0")}`
            )
          )
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("hands over the transcript's real path, and never opens it itself", async () => {
    /**
     * The phase's contract with the consolidator: the path is the one `traces.file_path` holds, and the
     * file really exists at it. The phase reads no transcript — the consolidator mounts them read-only
     * — so what is asserted is the handover.
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pathA = yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* traceConsolidation(envFor(fixture))

          expect(consolidator.calls).toHaveLength(1)
          const [entry, ...rest] = consolidator.calls[0]?.transcripts ?? []
          expect(rest).toEqual([])
          expect(entry?.sessionId).toBe("session-a")
          expect(entry?.filePath).toBe(pathA)
          // The path is outside the memory repo, which is `.memhtml` holding no session content.
          expect(pathA.startsWith(fixture.root)).toBe(false)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("generates a MANIFEST carrying the plane's metadata and no session content", async () => {
    /**
     * The manifest is the whole reason the handover is wider than a file list, and its two halves are
     * asserted separately because they come from different places and fail differently.
     *
     * **The `traces` columns**, which a transcript's own bytes do not state: the project slug, the cwd,
     * the branch, the span, the counts. A model without them cannot say which project a session ran in.
     *
     * **The join to `memory_session_links`**, which is the expensive half and the one worth a query.
     * The bar in `agent/instructions.md` is "more signal than one grep", so a pattern already written
     * down is not new signal — and `linkedMemories` is how the agent knows which those are. Seeded
     * here as two links on one session and NONE on another, because `[]` and populated are the two
     * readings the field has to support and a fixture with only one of them cannot tell a working join
     * from a constant.
     *
     * (Mutation: replacing `sessionManifestRows`'s `LEFT JOIN` with an inner `JOIN` drops
     * `session-quiet` from the manifest rows entirely — it has no link — and the phase falls back to
     * its bare ref, so `linkedMemories` reads `undefined` instead of `[]` and this case fails on the
     * `toEqual([])`. Removing the `memory_session_links` join altogether fails the two-link
     * assertions.)
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const busy = yield* seedTrace(fixture, {
            sessionId: "session-busy",
            fileMtime: "2026-07-02T00:00:00Z"
          })
          yield* seedTrace(fixture, {
            sessionId: "session-quiet",
            fileMtime: "2026-07-01T00:00:00Z"
          })
          yield* seedSessionLink(fixture, {
            path: "areas/oncall/drain-the-vip-first.html",
            sessionId: "session-busy",
            linkKind: "wrote"
          })
          yield* seedSessionLink(fixture, {
            path: "areas/metrics/scrape-cadence.html",
            sessionId: "session-busy",
            linkKind: "read"
          })

          yield* traceConsolidation(envFor(fixture))

          const handed = consolidator.calls[0]?.transcripts ?? []
          /** Newest-first, matching the selection's own order rather than insertion order. */
          expect(handed.map((entry) => entry.sessionId)).toEqual(["session-busy", "session-quiet"])

          const [head] = handed
          expect(head?.filePath).toBe(busy)
          // The `traces` metadata, from the plane and not invented.
          expect(head?.slug).toBe("-fixture-project")
          expect(head?.fileMtime).toBe("2026-07-02T00:00:00Z")
          expect(head?.fileSize).toBe(64 * 1024)
          /**
           * The join, with BOTH links and their kinds. Path-ordered, which is what makes a generated
           * manifest a pure function of the plane and therefore byte-assertable.
           */
          expect(head?.linkedMemories).toEqual([
            { path: "areas/metrics/scrape-cadence.html", linkKind: "read" },
            { path: "areas/oncall/drain-the-vip-first.html", linkKind: "wrote" }
          ])

          /**
           * And the session with NO link gets `[]` rather than an absent field. The distinction is one
           * the agent acts on: `[]` says the corpus holds nothing for this session, which is a session
           * whose findings were never written down, while absent would read as "not looked up".
           */
          expect(handed[1]?.linkedMemories).toEqual([])

          /**
           * NO SESSION CONTENT anywhere in the handover. `.memhtml` holds none and neither does anything
           * this phase sends: the manifest is paths, spans, counts, and corpus paths. Asserted over the
           * SERIALIZED handover so a field added later without thought is caught here — the fixture's
           * transcript lines carry a marker string that must not appear.
           */
          const serialized = JSON.stringify(handed)
          expect(serialized).not.toContain("a prompt")
          expect(serialized).not.toContain("an answer")
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("NEVER watermarks a session whose transcript never reached the agent", async () => {
    /**
     * The invariant this whole change turns on, and the defect it fixes.
     *
     * The phase used to watermark `batch` — the set it ASKED ABOUT. The two differ whenever a
     * transcript does not reach the agent: rotated away since `memhtml trace index` ran, moved outside
     * `MEMHTML_TRACE_ROOT`, or behind a symlink the read-only mount will not follow (all three measured;
     * see `partitionReachable` in `apps/consolidator/src/client.ts`). And `trace_consolidations` is an
     * ANTI-JOIN, so a watermark removes the session from every future batch permanently — the
     * transcript is lost silently, with a row asserting it was handled.
     *
     * The guard is STRUCTURAL rather than a check bolted on here: `ConsolidationOutcome` cannot be
     * constructed without `analyzedSessionIds`, so no consolidator can return a shape that leaves this
     * phase with only the batch to fall back on.
     *
     * The fixture is the honest reproduction. THREE sessions go out and the consolidator reports
     * reading TWO — which is exactly what the real client does when one file does not resolve — and one
     * candidate lands, so the phase takes its full productive path rather than an early return.
     *
     * (Mutation: changing the watermark's `sessionIds` back to `batch.map(...)` watermarks all three and
     * fails this case on the first assertion. The phase's `written` count, its commit, and every other
     * assertion in this file stay green under that mutation, which is exactly how quietly it shipped.)
     */
    const consolidator = scriptedConsolidator(() =>
      partiallyRead({
        analyzedSessionIds: ["session-reached-a", "session-reached-b"],
        candidates: [candidate({ claim: "A pattern from the two transcripts that did arrive." })]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-reached-a" })
          yield* seedTrace(fixture, { sessionId: "session-reached-b" })
          yield* seedTrace(fixture, { sessionId: "session-vanished" })

          const outcome = yield* traceConsolidation(envFor(fixture))

          /** The batch was three; the watermark is the two that arrived. */
          expect(outcome.counts.batch).toBe(3)
          expect((yield* consolidationWatermarks(fixture)).map((row) => row.session_id)).toEqual([
            "session-reached-a",
            "session-reached-b"
          ])

          /**
           * The counts SAY SO, which is the operator-visible half. `consolidated` is the analyzed count
           * rather than the batch, so the two disagreeing is the signal that transcripts went missing —
           * a state that previously had no reading at all, since watermarking the batch made them equal
           * by construction.
           */
          expect(outcome.counts.consolidated).toBe(2)
          expect(outcome.counts.unreachable).toBe(1)

          // And the productive path really ran, so this is not passing via an early return.
          expect(outcome.counts.written).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

          /**
           * The consequence that matters: a SECOND run still sees the vanished session, because the
           * anti-join never lost it. Asserted as a transition rather than by reading the table, since
           * "is it still selectable" is the question the watermark actually answers.
           */
          const second = yield* traceConsolidation(envFor(fixture))
          expect(second.counts.batch).toBe(1)
          expect(consolidator.calls[1]?.transcripts.map((entry) => entry.sessionId)).toEqual([
            "session-vanished"
          ])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("watermarks nothing when NO transcript reached the agent, and still reports ok", async () => {
    /**
     * The boundary of the case above: an empty analyzed set. It is reachable in production — a stale
     * `MEMHTML_TRACE_ROOT` makes every path in the batch unresolvable — and the phase must leave the whole
     * batch for the next run while staying green, since INV-3 says a phase that could not do its work
     * is not a broken phase.
     *
     * (Mutation: defaulting an empty `analyzedSessionIds` to the batch — the `?? batch` shape a
     * "convenience" would take — watermarks all two and fails here.)
     */
    const consolidator = scriptedConsolidator(() => partiallyRead({ analyzedSessionIds: [] }))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* seedTrace(fixture, { sessionId: "session-b" })

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.batch).toBe(2)
          expect(outcome.counts.consolidated).toBe(0)
          expect(outcome.counts.unreachable).toBe(2)
          expect(yield* consolidationWatermarks(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("cannot be made to watermark a session it never asked about", async () => {
    /**
     * The CONTAINMENT half, and the reason `analyzedFrom` intersects rather than trusting the outcome.
     *
     * A consolidator is an injected collaborator — the real one an eve agent reached over HTTP — and
     * `analyzedSessionIds` is a value it computes. Taking it as the watermark set directly would make
     * "which sessions are marked read forever" a claim the agent gets to make about sessions nobody
     * asked about, including ones a later night would otherwise have distilled.
     *
     * Here the scripted consolidator names a session that is real, unconsolidated, and NOT in this
     * batch (it is outside the quiet window, so the selection excluded it). It must not be watermarked.
     *
     * (Mutation: replacing `analyzedFrom(batch, ...)` with `outcome.success.analyzedSessionIds`
     * watermarks `session-not-asked` and fails this case.)
     */
    const consolidator = scriptedConsolidator(() =>
      partiallyRead({ analyzedSessionIds: ["session-asked", "session-not-asked"] })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-asked" })
          // Inside the quiet window, so the selection does not take it — a real row, not in the batch.
          yield* seedTrace(fixture, {
            sessionId: "session-not-asked",
            fileMtime: "2026-08-07T23:30:00Z"
          })

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.batch).toBe(1)
          expect((yield* consolidationWatermarks(fixture)).map((row) => row.session_id)).toEqual([
            "session-asked"
          ])
          // And the over-report is NOT counted as unreachable either: one asked, one analyzed.
          expect(outcome.counts.unreachable).toBe(0)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("does not re-consolidate a session already watermarked", async () => {
    /**
     * The anti-join, as a TRANSITION rather than a seeded row: the same session is consolidated, then
     * the phase is run again and does not see it. A pre-seeded watermark would pass even against a
     * query that read the wrong column.
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([candidate({ claim: "A candidate from the first pass over this session." })])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })

          const first = yield* traceConsolidation(envFor(fixture))
          expect(first.counts.batch).toBe(1)
          expect(first.counts.written).toBe(1)

          const afterFirst = yield* headSha(fixture)
          const second = yield* traceConsolidation(envFor(fixture))

          // Nothing left to read, so no call and no commit — the phase is idempotent under a re-run.
          expect(second.counts.batch).toBe(0)
          expect(second.counts.written).toBe(0)
          expect(second.commitSha).toBeNull()
          expect(second.llmCalls).toBe(0)
          expect(consolidator.calls).toHaveLength(1)
          expect(yield* headSha(fixture)).toBe(afterFirst)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("survives a rebuild's truncation, which is what makes the watermark run state", async () => {
    /**
     * INV-2 at the driver. `index.db` is a disposable projection of the git tree, but a consolidation
     * watermark records that a MODEL CALL happened — which no tree can restate — so it is in the same
     * category as `sleep_runs` and must not be truncated by a rebuild.
     *
     * Asserted by running the REAL `indexer.rebuild`, not by inspecting the truncate list: the list is
     * checked in the index suite, and what matters here is the composed behavior.
     *
     * (Mutation: adding `"trace_consolidations"` to `MEMORY_TABLES` empties the table and fails here.)
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* traceConsolidation(envFor(fixture))
          expect(yield* consolidationWatermarks(fixture)).toHaveLength(1)

          yield* fixture.reindex()

          expect(yield* consolidationWatermarks(fixture)).toEqual([
            { session_id: "session-a", run_id: `sleep/${DATE}` }
          ])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})

describe("the manifest join's SQL shape", () => {
  /**
   * SQL asserted as TEXT, because correctness and cost diverge here and only the text sees the
   * difference. Every case below is a property a behavioral test passes without: a manifest built from
   * N queries returns the same rows as one; an interpolated session id returns the same rows as a bound
   * one; an inner join returns the same rows whenever every session happens to have a link.
   */
  const sql = (ids: ReadonlyArray<string>): string => {
    let captured = ""
    const db = {
      all: (statement: string) => {
        captured = statement
        return Effect.succeed([])
      }
    } as unknown as Parameters<typeof sessionManifestRows>[0]
    Effect.runSync(sessionManifestRows(db, ids).pipe(Effect.asVoid))
    return captured
  }

  it("BINDS every session id, one `?` per id, interpolating none", () => {
    /**
     * A `traces.session_id` is a value the trace scanner read out of a filename under
     * `~/.claude/projects`, so an interpolated one would be a filename-derived string reaching SQL as
     * syntax. Placeholder COUNT is asserted, not merely their presence: a statement that bound the
     * first id and interpolated the rest contains a `?` too.
     *
     * (Mutation: building the `IN` list as `ids.map(id => `'${id}'`)` drops the placeholder count to
     * zero and fails here.)
     */
    const statement = sql(["a", "b", "c"])
    expect(statement).toContain("t.session_id IN (?, ?, ?)")
    expect((statement.match(/\?/g) ?? []).length).toBe(3)
    // No quoted literal anywhere: the only string literals a bound statement needs are none.
    expect(statement).not.toMatch(/'/)
  })

  it("is ONE statement per batch: a LEFT JOIN, not a per-session lookup or a group_concat", () => {
    const statement = sql(["a", "b"])
    expect(statement).toContain("LEFT JOIN memory_session_links l")
    /**
     * `LEFT` is asserted specifically. An inner join silently DROPS a session with no linked memory,
     * and such a session is the interesting case — findings never written down — so the phase would
     * fall back to its bare ref and lose the `[]`-versus-absent distinction the agent acts on.
     *
     * Spelled as "every `JOIN` onto that table is preceded by `LEFT`" rather than as a negative lookup
     * for a bare `JOIN`: `LEFT JOIN` CONTAINS the substring `JOIN`, so a naive negative assertion here
     * fails against the correct statement. (It did, on the first run of this case.)
     */
    for (const at of [...statement.matchAll(/JOIN memory_session_links/g)]) {
      expect(statement.slice(Math.max(0, (at.index ?? 0) - 5), at.index)).toBe("LEFT ")
    }
    /**
     * And no `group_concat`, which would put a corpus path inside a delimited string that a `,` in a
     * path would then split. The grouping is a `Map` in TypeScript, where it is not a parsing problem.
     */
    expect(statement).not.toContain("group_concat")
  })

  it("orders newest-first with total tie-breaks, so a generated manifest is reproducible", () => {
    /**
     * `file_mtime DESC` matches the selection's own order, and the three tie-breaks make the row order
     * TOTAL — which is what lets a test assert a manifest's `linkedMemories` with `toEqual` rather than
     * as a set.
     */
    expect(sql(["a"])).toContain(
      "ORDER BY t.file_mtime DESC, t.session_id ASC, l.path ASC, l.link_kind ASC"
    )
  })

  it("makes no query at all for an empty batch", () => {
    // A dry run and a barren night both reach here with nothing; a `WHERE ... IN ()` is not valid SQL.
    expect(sql([])).toBe("")
  })

  it("plans as two SEEKS against the shipped migrations, never a corpus scan", async () => {
    /**
     * The COST assertion, from a real `EXPLAIN QUERY PLAN` rather than from reading the text. Both
     * sides must seek — `traces` by its primary key, the links by `msl_session`
     * (`packages/index/migrations/0005_traces.sql`) — so the join is per-batch and not per-corpus. A
     * dropped index would leave this correct and linear in the whole link table.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const plan = yield* fixture.db
            .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql(["session-a"])}`, ["session-a"])
            .pipe(Effect.orDie)
          const details = plan.map((row) => row.detail).join("\n")
          expect(details).toContain("SEARCH t")
          expect(details).toContain("msl_session")
          expect(details).not.toMatch(/SCAN (t|l)\b/)
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

describe("trace-consolidation dry run", () => {
  it("counts the batch, makes no call, writes no commit and no watermark", async () => {
    /**
     * A dry run does the whole DETERMINISTIC half — the batch is real and counted — and stops before
     * the model call. Stopping before rather than after is the point: a dry run that spent Opus tokens
     * to discard the answer would be the most expensive way to count.
     *
     * (Mutation: moving the `env.dryRun` check below the `consolidate` call makes `llmCalls` non-zero
     * and fails here; removing the check entirely also fails the commit and watermark assertions.)
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([candidate({ claim: "A candidate a dry run must never write." })])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* seedTrace(fixture, { sessionId: "session-b" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture, true))

          // The batch is REAL: a dry run's counts describe what a real run would do.
          expect(outcome.counts.batch).toBe(2)
          expect(outcome.counts.written).toBe(0)
          expect(outcome.counts.consolidated).toBe(0)
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.commitSha).toBeNull()

          // No call was made at all — the expensive half never ran.
          expect(consolidator.calls).toEqual([])
          // No commit, no watermark, and a clean tree: nothing for a later phase to absorb.
          expect(yield* headSha(fixture)).toBe(before)
          expect(yield* consolidationWatermarks(fixture)).toEqual([])
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})
