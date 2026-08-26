import { isSlug, SLUG_MAX_LENGTH } from "@memhtml/contracts/slug"
import { frameKeyOf } from "@memhtml/domain"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { TRAILER_COUNTS, TRAILER_PHASE, TRAILER_RUN } from "../src/contract.js"
import type { PhaseEnv } from "../src/env.js"
import {
  COMMITMENT_DETECTOR,
  COMMITMENT_FLOOR,
  TRACE_MIN_BYTES,
  TRACE_SESSIONS_PER_RUN,
  traceConsolidation
} from "../src/phases/trace-consolidation.js"
import { instantFor } from "../src/run.js"
import { sessionManifestRows } from "../src/sql.js"
import {
  closeDetectedTask,
  DETECTED_TAG,
  DETECTED_TASK_CAP,
  DETECTED_TASK_DIR,
  isDetectedTaskPath,
  makeDetectionBudget,
  openDetections
} from "../src/tasks.js"
import {
  candidate,
  candidates,
  commitment,
  consolidatorFailure,
  partiallyRead,
  scriptedConsolidator,
  withCommitments
} from "../src/testing.js"
import { appliedWatermarks, applyLedger, pendingSessions } from "./abort-fixture.js"
import {
  DEDUP_CORPUS,
  type Fixture,
  memoryHtml,
  type SeedFile,
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
/** A second night, for the refresh and cross-night-closure arms. */
const LATER = "2026-08-09"

const envFor = (
  fixture: Fixture,
  dryRun = false,
  options: { readonly date?: string; readonly cap?: number } = {}
): PhaseEnv => {
  const date = options.date ?? DATE
  const instant = instantFor(date)
  return {
    deps: fixture.deps,
    runId: `sleep/${date}`,
    branch: `sleep/${date}`,
    baseSha: "",
    date,
    at: instant.at,
    atMillis: instant.millis,
    dryRun,
    /**
     * Stated EXPLICITLY on every env this file builds, even at the default cap, because `budgetFor`
     * falls back to a fresh budget when the field is absent — so a phase driven twice by one test would
     * silently get two full caps and the overflow arm would be untestable. A run supplies one budget
     * for the night; this mirrors that.
     */
    detectionBudget: makeDetectionBudget(options.cap ?? DETECTED_TASK_CAP)
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

/** True for a run's pending-mark ledger: the one committed path that is bookkeeping, not corpus. */
const isLedgerPath = (path: string): boolean => path.endsWith(".pending.jsonl")

/**
 * The CORPUS paths a phase added: {@link addedPaths} without the run's pending-mark ledger.
 *
 * The ledger is committed on the branch beside the memories, because a proposal a merge cannot find is
 * a proposal that never applies — so it shows up in `git diff --name-status` like anything else. It is
 * bookkeeping and not a memory, so a case about which MEMORIES a night wrote filters it out and the
 * abort suites assert on the ledger directly instead.
 */
const addedMemories = (fixture: Fixture, from: string): Effect.Effect<ReadonlyArray<string>> =>
  addedPaths(fixture, from).pipe(Effect.map((paths) => paths.filter((path) => !isLedgerPath(path))))

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
     * INV-3's base case, mirroring `edge-typing`'s "no model bound" exactly. This is the shape
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual([])
          expect(yield* appliedWatermarks(fixture)).toEqual([])
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual([])
          expect(yield* appliedWatermarks(fixture)).toEqual([])
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
          const base = yield* headSha(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.detail).toBeUndefined()
          expect(outcome.counts.candidates).toBe(0)
          expect(outcome.counts.written).toBe(0)

          /**
           * The barren session IS marked, which the failed case above shows is not automatic. The agent
           * read it and correctly found nothing; re-reading it every night forever would mean the batch
           * never advances past a quiet session.
           *
           * And the mark COMMITS, on a night with no memory to carry it. A ledger left unstaged would be
           * swept into whichever later phase commits next, or discarded with the index — so the batch
           * would either never advance or advance under another phase's trailer.
           */
          expect(outcome.commitSha).not.toBeNull()
          expect(yield* addedMemories(fixture, base)).toEqual([])
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual(["session-a"])

          /** Still a PROPOSAL: nothing reached the plane, because nothing has merged. */
          expect(yield* appliedWatermarks(fixture)).toEqual([])
          yield* applyLedger(fixture, `sleep/${DATE}`)
          expect(yield* appliedWatermarks(fixture)).toEqual([
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
            entities: [{ type: "service", name: "sqlite" }]
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
          const added = yield* addedMemories(fixture, base)
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

          /**
           * Both sessions are MARKED under this run, and the ledger rides in the first candidate's
           * commit rather than earning a third — which is what keeps "one commit per candidate" a
           * statement about the night's commits and not about its memories only.
           */
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual([
            "session-a",
            "session-b"
          ])
          expect(yield* appliedWatermarks(fixture)).toEqual([])
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
          entities: [
            { type: "service", name: "sqlite" },
            { type: "person", name: "sanju" }
          ],
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
          const [path] = yield* addedMemories(fixture, base)
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
          /**
           * Each entity's TWO HALVES arrive joined as one `type:name` reference, which is the form
           * `file_entities` keys on and the form the `entity` scope compares. A reference filed without
           * its type lands under `unknown` and answers `service:sqlite` with an empty set — the same
           * answer an absent memory gives — so this is the assertion that says the memory is reachable
           * by the reference a caller would ask for.
           *
           * `toEqual` over both, in the candidate's own order, so a join that dropped a half or
           * reordered the pair is visible. (Mutation: joining `name` alone yields `["sqlite",
           * "sanju"]`; joining `name:type` yields `["sqlite:service", ...]`. Both fail here.)
           */
          expect(doc.entities).toEqual(["service:sqlite", "person:sanju"])

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

  it("trims both halves of an entity and drops a pair missing one", async () => {
    /**
     * The redundancy every model-facing value in this package carries, applied to the entity join.
     *
     * The padding case is not cosmetic: `parseEntity` splits on the FIRST colon, so an untrimmed
     * `" service "` files under the type `"service "` and no reference a caller spells reaches it — a
     * memory in the tree, indexed, and unfindable. The dropped pairs are the shapes the schema already
     * refuses, gated again here so a scripted or future consolidator that skipped the decode still
     * cannot write `:orphan` or `person:`, whose one meaningful half is unreachable through a scope
     * that compares the whole reference.
     *
     * (Mutation: removing the `.trim()` from either half yields `" service : sqlite "`; removing the
     * empty-half filter adds `unknown`-typed junk. Both fail the `toEqual`.)
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({
          claim: "A padded entity half files under a type nobody can spell.",
          gist: "Two lookups missed a memory whose entity meta carried surrounding whitespace.",
          kind: "error_pattern",
          entities: [
            { type: " service ", name: " sqlite " },
            { type: "   ", name: "orphan" },
            { type: "person", name: " " }
          ]
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const base = yield* headSha(fixture)

          yield* traceConsolidation(envFor(fixture))
          const [path] = yield* addedMemories(fixture, base)
          const doc = yield* parseMemory((yield* atHead(fixture, path ?? "")) ?? "")
          expect(doc.entities).toEqual(["service:sqlite"])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("rewrites a variant entity to the CORPUS's spelling and leaves a new name alone", async () => {
    /**
     * The mint-site canonicalization, against a real indexed corpus and real `file_entities` rows.
     *
     * The corpus already names `service:checkout-api` (two files, from `DEDUP_CORPUS`) and
     * `person:Priya Raman` (the file seeded below, whose authored spelling is NOT the normalized one).
     * The candidate coins a variant of each, and each must land on its OWN corpus spelling — which is
     * what makes the case non-vacuous three ways over:
     *
     * - `Service:Checkout-API` proves the rewrite happens at all.
     * - `person:priya  raman` proves the target is the CORPUS's spelling and not the normalized form. An
     *   implementation that simply lowercased and collapsed every reference passes the first arm and
     *   fails this one, and it would leave a reference addressing nothing.
     * - `Service:Brand-New-Thing` proves it is a LOOKUP. A name the corpus does not hold keeps the
     *   candidate's own spelling, so an implementation that rewrote toward whichever row it read first,
     *   or that normalized unconditionally, fails here.
     *
     * The neighbour matters for the reason the shared-table lesson states: `file_entities` is one table
     * across every entity, so a corpus holding a single name cannot tell "found the right row" from
     * "returned a row".
     *
     * (Mutations: returning an empty map from `corpusEntitySpellings` leaves all three verbatim and
     * fails the first two arms; keying the map on the raw reference instead of the normalized one
     * matches nothing and fails the same two; returning `normalizeEntityRef(ref)` instead of the corpus
     * spelling fails the person arm and the new-name arm.)
     */
    const PERSON_FILE: SeedFile = {
      path: "resources/people/priya-raman.html",
      html: memoryHtml({
        title: "Priya Raman",
        claim: "Priya Raman owns the payments ledger reconciliation.",
        createdAt: "2026-05-02T00:00:00Z",
        entities: ["person:Priya Raman"]
      })
    }

    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({
          claim: "A coined entity variant is a second handle on one name until sleep merges them.",
          gist: "Two nights of entity resolution have to agree before a merge applies, so the variant is live and separately addressable until then.",
          kind: "agent_insight",
          entities: [
            { type: "Service", name: "Checkout-API" },
            { type: "person", name: "priya  raman" },
            { type: "Service", name: "Brand-New-Thing" }
          ]
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const base = yield* headSha(fixture)

          yield* traceConsolidation(envFor(fixture))
          const [path] = yield* addedMemories(fixture, base)
          const doc = yield* parseMemory((yield* atHead(fixture, path ?? "")) ?? "")
          expect(doc.entities).toEqual([
            "service:checkout-api",
            "person:Priya Raman",
            "Service:Brand-New-Thing"
          ])
        }),
      { seed: [...DEDUP_CORPUS, PERSON_FILE], consolidator }
    )
  })

  it("stamps the origin session only when EVERY evidence quote cites one", async () => {
    /**
     * Provenance on a distilled memory, and the honest absence of it.
     *
     * The stamp is the ordinary `memhtml-session` meta, which is the decision `tasks.ts` records for
     * the detected-task arm: it is already in the closed vocabulary and already projects to
     * `files.session_id`, so nothing new is introduced and every provenance query already reads it.
     *
     * BOTH branches, in one answer, because the rule is the pair. A candidate whose quotes span
     * sessions has no single origin, and `files.session_id` is a scalar — so stamping one of several
     * would answer a provenance query with a session the claim is only partly from, which is a wrong
     * value no reader could detect. Absent is the honest answer, and the bar prefers cross-session
     * candidates, so it is also the COMMON one.
     *
     * The assertions read the DATABASE as well as the file, and that second read is what proves the
     * meta name is the right one. A stamp under any other name parses to nothing and projects to NULL,
     * which the meta assertion alone would not distinguish from an absent stamp.
     *
     * (Mutations: stamping `candidate.evidence[0]?.sessionId` unconditionally puts `session-a` on the
     * cross-session memory and fails the NULL assertions; dropping the stamp entirely fails the
     * single-origin ones. Renaming the meta fails the two `session_id` reads while the parsed
     * `metas.sessionId` reads would report `undefined` and look merely unstamped.)
     */
    const ONE_ORIGIN = "Everything this claim rests on was read in one session."
    const TWO_ORIGINS = "This claim rests on lines from two different sessions."
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({
          claim: ONE_ORIGIN,
          gist: "Both quotes come from session-a, so the memory has exactly one origin to name.",
          kind: "episodic",
          evidence: [
            { sessionId: "session-a", quote: "the first supporting line" },
            { sessionId: "session-a", quote: "the second supporting line" }
          ]
        }),
        candidate({
          claim: TWO_ORIGINS,
          gist: "The quotes come from session-a and session-b, so no single session is the origin.",
          kind: "semantic",
          evidence: [
            { sessionId: "session-a", quote: "the first supporting line" },
            { sessionId: "session-b", quote: "the second supporting line" }
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
          expect(outcome.counts.written).toBe(2)

          const added = yield* addedMemories(fixture, base)
          expect(added).toHaveLength(2)

          /** Path by claim, so neither assertion depends on the order git reports the two files in. */
          const byClaim = new Map<string, string>()
          for (const path of added) {
            const doc = yield* parseMemory((yield* atHead(fixture, path)) ?? "")
            byClaim.set(doc.article.gist, path)
          }
          const single = byClaim.get(ONE_ORIGIN)
          const spanning = byClaim.get(TWO_ORIGINS)
          if (single === undefined || spanning === undefined) {
            throw new Error(`expected both claims among ${[...byClaim.keys()].join(" | ")}`)
          }

          const singleDoc = yield* parseMemory((yield* atHead(fixture, single)) ?? "")
          expect(singleDoc.metas.sessionId).toBe("session-a")
          const spanningDoc = yield* parseMemory((yield* atHead(fixture, spanning)) ?? "")
          expect(spanningDoc.metas.sessionId).toBeUndefined()

          /**
           * And the meta reaches the column the `files_session` index covers. `reindex` rebuilds from
           * git, so this is the projection a fresh `memhtml index rebuild` would produce.
           */
          yield* fixture.reindex()
          const rows = yield* fixture.db
            .all<{ path: string; session_id: string | null }>(
              "SELECT path, session_id FROM files WHERE path IN (?, ?) ORDER BY path",
              [single, spanning].sort()
            )
            .pipe(Effect.orDie)
          expect(new Map(rows.map((row) => [row.path, row.session_id]))).toEqual(
            new Map([
              [single, "session-a"],
              [spanning, null]
            ])
          )
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
          expect(yield* addedMemories(fixture, base)).toHaveLength(2)
          // And nothing landed on the fallback stem, which is the shape a missing slug gate takes.
          expect(yield* atHead(fixture, "areas/inbox/untitled.html")).toBeUndefined()

          /**
           * The session is STILL watermarked. A batch whose candidates were mostly refused has still
           * been read, and the refusals are about the candidates rather than about the transcripts —
           * re-reading them would produce the same refusals at the same cost.
           */
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toHaveLength(1)
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

          const added = yield* addedMemories(fixture, base)
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

          const [victimPath] = yield* addedMemories(fixture, beforeFirst)
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

          const added = yield* addedMemories(fixture, beforeSecond)
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
           * And the second commit adds a MEMORY rather than modifying one. `diffNameStatus` is what
           * `addedPaths` reads, so a phase that overwrote the victim would show `modified` here and add
           * nothing — which is exactly how quietly that class of bug ships.
           *
           * The ledger is the one legitimate modification: both nights share a run id, so the second
           * night appends its session to the file the first night committed. That is the ledger doing
           * its job, and it is why the filter names it rather than allowing modifications generally.
           */
          const changes = yield* fixture.deps.git
            .diffNameStatus(beforeSecond, "HEAD")
            .pipe(Effect.orDie)
          expect(
            changes.filter((change) => change.kind === "modified" && !isLedgerPath(change.path))
          ).toEqual([])
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

          const added = yield* addedMemories(fixture, base)
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
           * decision: both of edge typing's candidate arms anti-join on `derived = 0`, so ANY authored
           * edge between two paths permanently closes that pair to the typing phase — stamping one
           * here would silence the disagreement this lookup just found.
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual(["session-at-floor"])
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual(["session-settled"])
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual(["session-just-settled"])
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
          const taken = yield* pendingSessions(fixture, `sleep/${DATE}`)
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual([
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
           * The consequence that matters: with the two reached sessions' marks APPLIED, a second run
           * still sees the vanished one, because the anti-join never took it. Asserted as a transition
           * rather than by reading the table, since "is it still selectable" is the question the
           * watermark actually answers — and the apply is what puts the other two beyond it.
           */
          expect(yield* applyLedger(fixture, `sleep/${DATE}`)).toBe(2)
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual([])
          expect(yield* appliedWatermarks(fixture)).toEqual([])
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual(["session-asked"])
          // And the over-report is NOT counted as unreachable either: one asked, one analyzed.
          expect(outcome.counts.unreachable).toBe(0)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("does not re-consolidate a session whose mark a merge APPLIED", async () => {
    /**
     * The anti-join, as a TRANSITION rather than a seeded row: the session is consolidated, the mark is
     * applied the way a merge applies it, and the phase is then run again and does not see it. A
     * pre-seeded watermark would pass even against a query that read the wrong column.
     *
     * **The apply is the load-bearing step and it belongs in the middle.** A mark is a proposal on the
     * branch until `merge` lands it, so the run BEFORE the apply is still re-selectable — which is the
     * abort property, asserted here as the second pass really re-reading the session and then, after the
     * apply, really declining to.
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual(["session-a"])

          // Unmerged, so the session is still on offer: the mark has changed no plane yet.
          expect(yield* appliedWatermarks(fixture)).toEqual([])
          expect(yield* applyLedger(fixture, `sleep/${DATE}`)).toBe(1)

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
          // The merge's own apply, so the row under test is the row a landed run really writes.
          expect(yield* applyLedger(fixture, `sleep/${DATE}`)).toBe(1)
          expect(yield* appliedWatermarks(fixture)).toHaveLength(1)

          yield* fixture.reindex()

          expect(yield* appliedWatermarks(fixture)).toEqual([
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
          expect(yield* pendingSessions(fixture, `sleep/${DATE}`)).toEqual([])
          expect(yield* appliedWatermarks(fixture)).toEqual([])
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})

/**
 * Surface 2 of issue #44: the same consolidator answer also carries COMMITMENTS, and the phase turns
 * them into detected tasks or closes the ones a session says are done.
 *
 * Every case here asserts against the TREE and against git, for the reason the file header states: a
 * phase reporting `commitmentTasks: 1` while writing nothing would satisfy a count assertion and none
 * of the ones that matter. Counts are asserted beside the file they claim to describe.
 *
 * Each `it` names the mutation that makes it fail. The recorded runs are in the PR body.
 */

/** Every detected task in the WORKING TREE, path-ordered, read through the module's own tree read. */
const detectedIn = (fixture: Fixture, date = DATE) =>
  openDetections(envFor(fixture, false, { date })).pipe(Effect.orDie)

/** Detected-task paths at a commitish, from git rather than from the working tree. */
const detectedAt = (fixture: Fixture, commitish: string): Effect.Effect<ReadonlyArray<string>> =>
  fixture.deps.git.run(["ls-tree", "-r", "--name-only", commitish]).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => isDetectedTaskPath(line))
        .sort()
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>)
  )

/** One session seeded and settled, which is what every case below needs before it can ask. */
const oneSession = (fixture: Fixture, sessionId = "session-a") => seedTrace(fixture, { sessionId })

describe("trace-consolidation mints tasks from commitments", () => {
  it("mints one detected task per unresolved commitment, with from_session provenance", async () => {
    /**
     * The happy path, asserted on the FILE rather than on the count. Four things have to be true at
     * once for a detected commitment task to be usable, and each is a separate way this could ship
     * broken: it is a `task` (so it inherits every sleep exclusion by being one), it is authored
     * `agent:sleep` (the author separation), its path carries the detection digest (the idempotence
     * surface `--detected` filters on), and it carries `memhtml-session` (issue #44's `from_session`).
     *
     * (Mutation: dropping the `sessionId` spread from `mintDetectedTask`'s `renderTemplate` call leaves
     * every count and every other assertion here green and fails only the `metas.sessionId` line —
     * which is exactly how quietly the provenance would have gone missing.)
     */
    const QUOTE = "SPECIFIC-VERBATIM-COMMITMENT-SPAN that must never reach the corpus"
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "wire the capture path before the next release",
          actor: "agent",
          evidence: { sessionId: "session-a", quote: QUOTE },
          confidence: 0.9
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.commitments).toBe(1)
          expect(outcome.counts.commitmentTasks).toBe(1)
          expect(outcome.counts.completionsApplied).toBe(0)
          expect(outcome.counts.completionsUnmatched).toBe(0)
          // No candidate memories in this answer, so every file added is the commitment pass's.
          expect(outcome.counts.written).toBe(0)

          const paths = yield* detectedAt(fixture, "HEAD")
          expect(paths).toHaveLength(1)
          const path = paths[0] ?? ""
          expect(path.startsWith(`${DETECTED_TASK_DIR}/`)).toBe(true)

          const html = yield* atHead(fixture, path)
          const doc = yield* parseMemory(html ?? "")
          expect(doc.metas.memoryType).toBe("task")
          expect(doc.metas.taskStatus).toBe("todo")
          expect(doc.metas.author).toBe("agent:sleep")
          // `from_session` provenance, which projects to `files.session_id`.
          expect(doc.metas.sessionId).toBe("session-a")
          expect(doc.tags[0]).toBe(DETECTED_TAG)
          expect(doc.tags[1]).toBe(COMMITMENT_DETECTOR)
          // The body names the work and the session a reviewer would go back to.
          expect(doc.article.gist).toContain("wire the capture path")
          expect(doc.article.bodyText).toContain("session-a")

          /**
           * The trace plane's central invariant, on the surface most likely to break it: the verbatim
           * transcript span is NOT in the file, at the byte level, and IS in the commit message. This
           * is the same assertion the candidate arm carries, because a commitment task's body is a
           * second place a quote could have been copied to.
           *
           * (Mutation: passing `evidence.quote` as the `session` arm's `statement`, or adding a
           * `quote` field to that arm and rendering it, fails here and nowhere else.)
           */
          expect(html).not.toContain(QUOTE)
          const message = yield* messageOf(fixture, "HEAD")
          expect(message).toContain(QUOTE)
          expect(message).toContain("session-a")
          // The indent is the trailer-injection guard, and this text came from a model.
          expect(message).toContain(`  commitment session-a: ${QUOTE}`)

          // One commit for the batch, on the phase's own trailer, downstream of the base.
          expect(outcome.commitSha).not.toBeNull()
          const trailers = yield* fixture.deps.git
            .logTrailers(`${base}..HEAD`, TRAILER_PHASE)
            .pipe(Effect.orDie)
          expect(trailers).toHaveLength(1)
          expect(trailers[0]?.values).toEqual(["trace-consolidation"])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("drops a commitment whose actor is not first-person, minting nothing", async () => {
    /**
     * Issue #44 asks for first-person commitments only. The contract keeps `other` in the vocabulary so
     * a model can report a third party's commitment ACCURATELY instead of mislabelling it as the user's,
     * and this is the filter that makes that honesty free.
     *
     * The fixture carries a first-person commitment BESIDE the `other` one, which is what makes the
     * case non-vacuous: a phase that minted nothing at all would pass a bare "no task from `other`"
     * assertion. One task lands, and it is the `agent` one.
     *
     * (Mutation: deleting the `FIRST_PERSON_ACTORS` check from `commitmentRefusalFor` mints two tasks
     * and fails both the count and the tree assertion.)
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "a colleague said they would ship the migration",
          actor: "other",
          evidence: { sessionId: "session-a", quote: "sanju said he'd ship the migration" }
        }),
        commitment({
          statement: "pin the flaky teardown port",
          actor: "agent",
          evidence: { sessionId: "session-a", quote: "I'll pin the teardown port" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.commitments).toBe(2)
          expect(outcome.counts.commitmentTasks).toBe(1)
          expect(outcome.counts.commitmentsSkipped).toBe(1)

          const open = yield* detectedIn(fixture)
          expect(open).toHaveLength(1)
          expect(open[0]?.claim).toContain("pin the flaky teardown port")
          // The dropped one is nowhere in the tree, and its quote is not in the commit either.
          expect(yield* messageOf(fixture, "HEAD")).not.toContain("sanju")
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("counts a below-floor commitment and mints nothing for it", async () => {
    /**
     * The floor is the guard against a queue nobody reads, and `COMMITMENT_FLOOR` is read from the
     * module rather than restated, so a change to the number moves this test with it. The pair is
     * `floor - 0.01` and `floor` exactly, which pins the comparison as `>=` rather than `>`: a
     * commitment AT the floor is admissible, and a strict comparison would silently discard the
     * boundary case every model that reports round numbers lands on.
     *
     * (Mutation: `<=` instead of `<` in the floor check drops the at-floor commitment and fails this;
     * deleting the check mints both and fails it too.)
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "maybe revisit the retry budget",
          confidence: COMMITMENT_FLOOR - 0.01,
          evidence: { sessionId: "session-a", quote: "we might revisit the retry budget" }
        }),
        commitment({
          statement: "raise the retry budget to five",
          confidence: COMMITMENT_FLOOR,
          evidence: { sessionId: "session-a", quote: "I'll raise the retry budget to five" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.commitmentsBelowFloor).toBe(1)
          expect(outcome.counts.commitmentTasks).toBe(1)
          const open = yield* detectedIn(fixture)
          expect(open).toHaveLength(1)
          expect(open[0]?.claim).toContain("raise the retry budget")
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("drops a commitment citing a session outside the batch it asked about", async () => {
    /**
     * The client already refuses a whole turn citing a session it did not make READABLE. This is the
     * phase's own, narrower containment: an id outside the BATCH must not become a task whose
     * `from_session` provenance names a session nobody selected. It is the same posture `analyzedFrom`
     * takes toward the watermark set — an injected collaborator may narrow what the phase asked about
     * and never widen it.
     *
     * (Mutation: dropping the `batchSessionIds.has(...)` check mints a task stamped `session-elsewhere`,
     * failing the count and the tree assertion.)
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "a commitment attributed to a session nobody asked about",
          evidence: { sessionId: "session-elsewhere", quote: "invented provenance" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const before = yield* headSha(fixture)
          const commitsBefore = yield* commitCount(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.commitments).toBe(1)
          expect(outcome.counts.commitmentTasks).toBe(0)
          expect(outcome.counts.commitmentsSkipped).toBe(1)
          expect(yield* detectedIn(fixture)).toEqual([])
          /**
           * The commitment pass staged nothing, so it costs no empty diff: the ONE commit the night made
           * is the ledger's, and it added no corpus file. `addedMemories` is what says the commitment
           * pass wrote nothing; the single commit is the run recording that it read the batch.
           */
          expect(yield* addedMemories(fixture, before)).toEqual([])
          expect(yield* commitCount(fixture)).toBe(commitsBefore + 1)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("respects the run's SHARED detection budget and counts the overflow", async () => {
    /**
     * The budget is the run's, taken once per phase invocation and threaded, so a cap of one turns the
     * second commitment away rather than handing it a fresh allowance. The cap exists because "a noisy
     * detector that mints 200 tasks destroys the working set it exists to serve", and the overflow is
     * COUNTED rather than dropped silently.
     *
     * (Mutation: replacing `budgetFor(env)` with `makeDetectionBudget()` — a fresh cap for this phase
     * rather than the run's shared one — mints both and fails this. Moving `budgetFor` INSIDE the mint
     * loop does NOT fail it, and that is worth recording: with `detectionBudget` present on the env,
     * `budgetFor` returns the same object every call, so the mutation is a no-op. The case that made it
     * matter is a phase driven with no budget on the env, which `budgetFor`'s own contract covers.)
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "first commitment of the night",
          evidence: { sessionId: "session-a", quote: "I'll do the first thing" }
        }),
        commitment({
          statement: "second commitment of the night",
          evidence: { sessionId: "session-a", quote: "I'll do the second thing" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture, false, { cap: 1 }))

          expect(outcome.counts.commitments).toBe(2)
          expect(outcome.counts.commitmentTasks).toBe(1)
          // The overflow is COUNTED, never silently dropped: a detector pressing against the cap every
          // night is a detector whose threshold is wrong, and that is only visible in the counts.
          expect(outcome.counts.commitmentsCapped).toBe(1)
          expect(yield* detectedIn(fixture)).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("refreshes rather than duplicating when a second night re-reads the same commitment", async () => {
    /**
     * Idempotence, across nights and through the KEY rather than through the content hash — two open
     * tasks with identical bodies are two real work items, so the structural dedup index cannot answer
     * "have I already minted this". The second night's re-read has to land on the same path.
     *
     * The WATERMARK is what makes this a real second night rather than the same night run twice: the
     * first run's mark, once APPLIED, takes `session-a` out of the batch permanently, and `session-b` is
     * seeded for the second night carrying the SAME commitment restated, which is the shape a standing
     * intention actually takes. The apply stands in for the first night's merge, without which the
     * second night would re-read `session-a` and the two nights would not be two.
     *
     * (Mutation: keying on the RUN id, or on the session id, mints a second task and fails this.)
     */
    const consolidator = scriptedConsolidator((request) =>
      withCommitments([
        commitment({
          statement: "wire the capture path before the next release",
          evidence: {
            sessionId: request.transcripts[0]?.sessionId ?? "session-a",
            quote: "I'll wire capture before we ship"
          }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          const first = yield* traceConsolidation(envFor(fixture))
          expect(first.counts.commitmentTasks).toBe(1)
          const [path] = yield* detectedAt(fixture, "HEAD")
          expect(yield* applyLedger(fixture, `sleep/${DATE}`)).toBe(1)

          yield* oneSession(fixture, "session-b")
          const second = yield* traceConsolidation(envFor(fixture, false, { date: LATER }))
          // The second night really did read a DIFFERENT session, or this proves nothing.
          expect(second.counts.batch).toBe(1)
          expect(second.counts.commitmentTasks).toBe(0)
          expect(second.counts.commitmentsRefreshed).toBe(1)

          // ONE file, at the SAME path: the second night refreshed the stamp rather than duplicating.
          const paths = yield* detectedAt(fixture, "HEAD")
          expect(paths).toEqual([path])
        }),
      {
        seed: DEDUP_CORPUS,
        consolidator
      }
    )
  })

  it("keys on the STATEMENT alone, so one commitment said in two sessions is one task", async () => {
    /**
     * The other half of the keying decision, and the one that makes cross-night closure possible at all.
     * A key carrying the session id would make Monday's task unfindable from Friday's completion, so the
     * key is the statement — and the consequence, asserted here, is that the same promise made twice is
     * ONE row in the queue rather than a task and a duplicate.
     *
     * Two DIFFERENT statements land beside them, which is what makes this non-vacuous: a phase that
     * folded every commitment into one task would pass a bare "one task from two identical statements"
     * assertion. Two files land, from three commitments.
     *
     * (Mutation: putting the session id back into `commitmentKey`'s digest mints three tasks and fails
     * this case, and breaks every cross-night closure case below.)
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "pin the flaky teardown port",
          evidence: { sessionId: "session-a", quote: "I'll pin the teardown port" }
        }),
        commitment({
          statement: "pin the flaky teardown port",
          evidence: { sessionId: "session-b", quote: "still need to pin the teardown port" }
        }),
        commitment({
          statement: "raise the retry budget to five",
          evidence: { sessionId: "session-b", quote: "I'll raise the retry budget" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          yield* oneSession(fixture, "session-b")
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.commitments).toBe(3)
          expect(outcome.counts.commitmentTasks).toBe(2)
          /**
           * The repeat is a REFRESH inside one answer, not a silent drop: the count says the phase saw
           * it and recognized it as already open, which is the reading an operator needs to tell "one
           * commitment" from "two the phase folded".
           */
          expect(outcome.counts.commitmentsRefreshed).toBe(1)

          const open = yield* detectedIn(fixture)
          expect(open).toHaveLength(2)
          expect(new Set(open.map((one) => one.key)).size).toBe(2)
          /**
           * The surviving task's provenance is the FIRST session that said it, because a refresh writes
           * only the `memhtml-updated` stamp — a human may have edited the body or moved the status, and
           * a detector overwriting that would take the queue away from the person it serves.
           */
          const pinned = open.find((one) => one.claim.includes("teardown"))
          const doc = yield* parseMemory((yield* atHead(fixture, pinned?.path ?? "")) ?? "")
          expect(doc.metas.sessionId).toBe("session-a")
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("mints one task per SHORT commitment, so two do not share a frame slot", async () => {
    /**
     * Finding 2(a), the commitment half. `mintDetectedTask`'s frame-key proximity check reads the CLAIM,
     * and the old wording — `confirm: the <actor> committed to <statement>` — put the statement in the
     * rule's VALUE position: measured against `frameKeyOf`, any statement of six tokens or fewer keys on
     * `confirm: the agent committed to`, so the second short commitment answered `framed` and vanished
     * from every counter. The collapse depended on statement LENGTH, which is why the two statements
     * here are deliberately short.
     *
     * MUTATION: revert `commitmentClaim` to `confirm: the ${actor} committed to ${statement}` — measured,
     * both statements then key on `confirm: the agent committed to`, so `commitmentTasks` reads 1,
     * `commitmentsFramed` reads 1, and one file lands. Both halves of this test go red.
     *
     * Non-vacuous against the length dependence: `"pin the flaky teardown port"` is five tokens and
     * `"rotate the signing key"` is four, so BOTH are inside `MAX_VALUE_TOKENS` under the old shape.
     * A test using long statements would pass against the broken claim, because those overflowed to
     * `null` and skipped the check entirely.
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "pin the flaky teardown port",
          evidence: { sessionId: "session-a", quote: "I'll pin the teardown port" }
        }),
        commitment({
          statement: "rotate the signing key",
          evidence: { sessionId: "session-a", quote: "I'll rotate the signing key" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.commitments).toBe(2)
          expect(outcome.counts.commitmentTasks, "one task per commitment").toBe(2)
          expect(outcome.counts.commitmentsFramed, "neither was swallowed by the frame check").toBe(
            0
          )

          const open = yield* detectedIn(fixture)
          expect(open).toHaveLength(2)
          // Each task's claim leads with its OWN statement, which is what makes the frames distinct.
          const gists = open.map((one) => one.claim)
          expect(gists.filter((gist) => gist.startsWith("confirm: pin the flaky"))).toHaveLength(1)
          expect(
            gists.filter((gist) => gist.startsWith("confirm: rotate the signing"))
          ).toHaveLength(1)
          // The mechanism under the assertion: two claims, two frame slots.
          expect(new Set(gists.map(frameKeyOf)).size, "two distinct frames").toBe(2)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("mints nothing on a dry run, however many commitments the answer would carry", async () => {
    /**
     * A dry run stops before the model call, so it cannot see a commitment at all — which is the
     * cheapest possible version of this guard and the one worth pinning, because a future change that
     * moved the commitment pass above the `dryRun` return would write task files during a preview.
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([commitment({ statement: "a commitment a dry run must never open" })])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const before = yield* headSha(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture, true))

          expect(outcome.counts.commitments).toBe(0)
          expect(outcome.counts.commitmentTasks).toBe(0)
          expect(consolidator.calls).toEqual([])
          expect(yield* headSha(fixture)).toBe(before)
          expect(yield* detectedIn(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("reports the commitment count SHAPE on every path, including a degraded one", async () => {
    /**
     * A report reader comparing two nights reads a MISSING key as a phase that does not have the
     * concept, not as a night that did none of it. So every count key is present on every return path,
     * which is the rule `edge-typing`'s `zero` states and `ZERO_COUNTS` here implements.
     */
    const consolidator = scriptedConsolidator(() => consolidatorFailure())

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.detail).toContain("consolidator unavailable")
          for (const key of [
            "commitments",
            "commitmentTasks",
            "completionsApplied",
            "completionsUnmatched",
            "commitmentsSkipped",
            "commitmentsBelowFloor",
            "commitmentsRefreshed",
            "commitmentsFramed",
            "commitmentsDismissed",
            "commitmentsCapped"
          ]) {
            expect(outcome.counts[key], key).toBe(0)
          }
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})

describe("trace-consolidation closes a detected task when a session shows it done", () => {
  /**
   * The commitment both nights see, differing only in whether it is resolved and WHICH SESSION reports
   * it.
   *
   * The session differs across nights on purpose, and it is what makes every case here a real
   * cross-night closure rather than the same night run twice: night one's `session-consolidated` mark,
   * once applied, takes `session-a` out of the batch, so night two reads `session-b`. A design keyed on
   * the session could not match the two, which is exactly the property `commitmentKey` argues for.
   *
   * {@link applyLedger} between the nights is night one's merge. Without it night one is a branch nobody
   * landed, `session-a` is still on offer, and the two nights collapse into one — which is the abort
   * property working, and it is why these cases state the apply rather than assuming it.
   */
  const SHIPPED = "wire the capture path before the next release"
  const shipped = (sessionId: string, resolved: boolean, confidence = 0.9) =>
    commitment({
      statement: SHIPPED,
      resolved,
      confidence,
      evidence: {
        sessionId,
        quote: resolved ? "capture is wired and shipped" : "I'll wire capture before we ship"
      }
    })

  it("closes the task the previous night opened, and archives it", async () => {
    /**
     * Issue #44's "closure is also detected", across two nights, which is the only reading under which
     * the arm does any work: night one opens the task from an unresolved commitment, night two sees the
     * same commitment resolved and closes it.
     *
     * `done` plus ARCHIVE, matching `memhtml task status done` exactly — `done` is not a resting state
     * on its own, and the archive tree plus `git log` is what answers "what did I close". So the
     * assertion is that the path LEFT the queue and the file exists under `archive/`, not merely that a
     * meta changed.
     *
     * (Mutation: replacing `closeDetectedTask` with a bare `stampFile` leaves the file in
     * `areas/inbox/tasks` and fails the archive assertion while leaving the count green.)
     */
    const consolidator = scriptedConsolidator((request, offset) =>
      withCommitments([shipped(request.transcripts[0]?.sessionId ?? "session-a", offset > 0)])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          const first = yield* traceConsolidation(envFor(fixture))
          expect(first.counts.commitmentTasks).toBe(1)
          const [opened] = yield* detectedAt(fixture, "HEAD")
          expect(opened).toBeDefined()
          expect(yield* applyLedger(fixture, `sleep/${DATE}`)).toBe(1)

          yield* oneSession(fixture, "session-b")
          const second = yield* traceConsolidation(envFor(fixture, false, { date: LATER }))
          // A DIFFERENT session reported the completion, which is the whole point of this arm.
          expect(second.counts.batch).toBe(1)
          expect(second.counts.completionsApplied).toBe(1)
          expect(second.counts.completionsUnmatched).toBe(0)
          // A resolved commitment does not ALSO mint: the close is the whole action.
          expect(second.counts.commitmentTasks).toBe(0)

          // Out of the open queue, and present under the archive tree at its archived path.
          expect(yield* detectedIn(fixture, LATER)).toEqual([])
          const paths = yield* detectedAt(fixture, "HEAD")
          expect(paths).toHaveLength(1)
          expect(paths[0]?.startsWith("archive/")).toBe(true)
          const doc = yield* parseMemory((yield* atHead(fixture, paths[0] ?? "")) ?? "")
          expect(doc.metas.taskStatus).toBe("done")
          expect(doc.metas.status).toBe("archived")
          // The closing reason lives in the commit, because the meta vocabulary is closed.
          expect(yield* messageOf(fixture, "HEAD")).toContain("completion detected")
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("NEVER closes a human-authored task, however well the completion matches", async () => {
    /**
     * The hard guard, and the case the whole surface has to be safe against: a human-opened task
     * archived because a model read "shipped it" in somebody's scrollback is work silently taken out of
     * a person's queue by a sentence they did not write — and `done` archives, so the file also leaves
     * the directory they look in.
     *
     * The fixture is built so the guard is the ONLY thing standing between the completion and the file.
     * A human task is seeded whose title, claim, and detected-task counterpart all describe the same
     * work, the detected task is opened by night one, and night two resolves it. Both files are then
     * checked: the detected one closed, the human one BYTE-IDENTICAL.
     *
     * The byte comparison is what makes it non-vacuous. A `memhtml-updated` stamp, a status change, or
     * a re-render would all leave a parsed assertion green.
     *
     * (Mutation: replacing `closeDetectedTask`'s `isDetectedTaskPath` guard with `return true` does not
     * fail this case on its own — the match is keyed, so the human task is never a candidate. What DOES
     * fail it is the guard's removal combined with a match by title or claim, which is the change this
     * case exists to make unshippable: it proves the human file survives a night that closed its twin.)
     */
    const HUMAN = "areas/inbox/tasks/t-wire-capture.html"
    const humanHtml = memoryHtml({
      title: "Wire the capture path before the next release",
      claim: "The capture path is not wired ahead of the next release.",
      body: "A human opened this, and no detector may close it.",
      memoryType: "task",
      taskStatus: "todo",
      createdAt: "2026-05-10T00:00:00Z"
    })
    const consolidator = scriptedConsolidator((request, offset) =>
      withCommitments([shipped(request.transcripts[0]?.sessionId ?? "session-a", offset > 0)])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          const humanBefore = yield* atHead(fixture, HUMAN)
          expect(humanBefore).toBeDefined()

          yield* traceConsolidation(envFor(fixture))
          yield* oneSession(fixture, "session-b")
          const second = yield* traceConsolidation(envFor(fixture, false, { date: LATER }))
          expect(second.counts.completionsApplied).toBe(1)

          // The human task's BLOB is unchanged, and it is still where a human looks for it.
          expect(yield* atHead(fixture, HUMAN)).toBe(humanBefore)
          const open = yield* detectedIn(fixture, LATER)
          expect(open).toEqual([])
        }),
      {
        seed: [...DEDUP_CORPUS, { path: HUMAN, html: humanHtml }],
        consolidator
      }
    )
  })

  it("refuses to close a human task even when handed its path directly", async () => {
    /**
     * The guard itself, exercised at the WRITE rather than through the phase, because the phase's keyed
     * match means a human path never reaches it — so a test through the phase alone would be the
     * vacuous lock this repo has paid for. `closeDetectedTask` is a public function and a second caller
     * arriving with a path from a query, a report, or a title match is precisely what it defends.
     *
     * (Mutation: replacing the `isDetectedTaskPath` check with `return true` archives the human task
     * and fails every assertion below.)
     */
    const HUMAN = "areas/inbox/tasks/t-wire-capture.html"
    const humanHtml = memoryHtml({
      title: "Wire the capture path before the next release",
      claim: "The capture path is not wired ahead of the next release.",
      memoryType: "task",
      taskStatus: "todo",
      createdAt: "2026-05-10T00:00:00Z"
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, HUMAN)
          const env = envFor(fixture)

          const closed = yield* closeDetectedTask(env, HUMAN).pipe(Effect.orDie)
          expect(closed).toBe(false)

          // Nothing staged, nothing written, and the file is byte-identical on disk.
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
          expect(yield* atHead(fixture, HUMAN)).toBe(before)
        }),
      { seed: [...DEDUP_CORPUS, { path: HUMAN, html: humanHtml }] }
    )
  })

  it("counts a resolved commitment that matches no open task as unmatched", async () => {
    /**
     * The completion arrives and there is nothing to close: no previous night opened it, or a human
     * already closed it by hand, or the model reworded the statement so the key moved. The issue asks
     * for this as a COUNT rather than as a silent drop, and the reason is diagnostic — a night whose
     * every completion is unmatched is a night where the keying is wrong, and that is invisible unless
     * the number is reported.
     *
     * (Mutation: dropping the `unmatched += 1` in the no-match branch reports zero and fails this.)
     */
    const consolidator = scriptedConsolidator(() => withCommitments([shipped("session-a", true)]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture)
          const before = yield* headSha(fixture)
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.completionsUnmatched).toBe(1)
          expect(outcome.counts.completionsApplied).toBe(0)
          expect(outcome.counts.commitmentTasks).toBe(0)
          // Nothing in the corpus moved: the unmatched completion is a count and not a write.
          expect(yield* addedMemories(fixture, before)).toEqual([])
          expect(
            yield* fixture.deps.git.diffNameStatus(before, "HEAD").pipe(
              Effect.map((changes) => changes.filter((change) => !isLedgerPath(change.path))),
              Effect.orDie
            )
          ).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("does NOT close below the floor, and counts the completion as unmatched", async () => {
    /**
     * The floor governs the closure arm identically to the mint arm — the same judgement about the same
     * sentence, made once. A lower floor on closure would mean a commitment too weak to open a task was
     * strong enough to archive one, which is the more destructive of the two directions.
     *
     * Night one opens the task at full confidence; night two reports the completion BELOW the floor. The
     * task must survive, and the completion must be counted so the operator can see the night tried.
     *
     * (Mutation: moving the floor check to apply only to the mint arm closes the task and fails both
     * the `completionsApplied` assertion and the surviving-task assertion.)
     */
    const consolidator = scriptedConsolidator((request, offset) => {
      const session = request.transcripts[0]?.sessionId ?? "session-a"
      return withCommitments([
        offset === 0 ? shipped(session, false) : shipped(session, true, COMMITMENT_FLOOR - 0.01)
      ])
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          yield* traceConsolidation(envFor(fixture))
          const [opened] = yield* detectedAt(fixture, "HEAD")

          yield* oneSession(fixture, "session-b")
          const second = yield* traceConsolidation(envFor(fixture, false, { date: LATER }))
          expect(second.counts.completionsApplied).toBe(0)
          expect(second.counts.commitmentsBelowFloor).toBe(1)
          expect(second.counts.completionsUnmatched).toBe(1)

          // The task is still open, at the same path, and not archived.
          expect(yield* detectedAt(fixture, "HEAD")).toEqual([opened])
          const open = yield* detectedIn(fixture, LATER)
          expect(open).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("reports only ITS OWN capped commitments, not an earlier detector's overflow", async () => {
    /**
     * `commitmentsCapped` is this pass's DELTA on the shared budget, and this is the only shape that can
     * tell the difference. The budget is shared across every detector, so by phase twelve it may already
     * carry entity-resolution's and dedup's overflow — and reporting `budget.overflow` raw would
     * attribute their turned-away findings to this phase's commitments. An operator would read that as
     * "the commitment detector is too noisy" about a night where it minted everything it found.
     *
     * The budget is constructed with a NON-ZERO overflow already on it, which is the state a real run
     * reaches and which `makeDetectionBudget` cannot produce — so it is built by hand here rather than
     * through the helper. Everything else about the shape is the helper's.
     *
     * (Mutation: reporting `budget.overflow` instead of `budget.overflow - overflowBefore` returns 4 and
     * fails this case, and fails no other in this file, because every other case starts from a fresh
     * budget where the two numbers agree.)
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "first commitment of the night",
          evidence: { sessionId: "session-a", quote: "I'll do the first thing" }
        }),
        commitment({
          statement: "second commitment of the night",
          evidence: { sessionId: "session-a", quote: "I'll do the second thing" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          const env = {
            ...envFor(fixture),
            /** Three findings an earlier phase already turned away, and no room left. */
            detectionBudget: { remaining: 0, overflow: 3 }
          }
          const outcome = yield* traceConsolidation(env)

          // Two of THIS phase's commitments were capped, not five.
          expect(outcome.counts.commitmentsCapped).toBe(2)
          expect(outcome.counts.commitmentTasks).toBe(0)
          // And the shared counter really did accumulate, or the delta would be trivially right.
          expect(env.detectionBudget.overflow).toBe(5)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("does not count a FILTERED completion as unmatched, only a floored or unkeyed one", async () => {
    /**
     * The two counters have to mean different things or neither is diagnostic.
     * `completionsUnmatched` is "a completion this store declined to apply", which points an operator at
     * the KEYING; `commitmentsSkipped` is "not a first-person commitment at all", which points at the
     * model's labelling. A third party's completion is the second and must not be reported as the first.
     *
     * The fixture carries a resolved `other` commitment ALONE, so the whole answer is one refusal.
     *
     * (Mutation: deriving `unmatched` by subtracting the admissible resolved count from every resolved
     * commitment in the answer — which is what an earlier version did — reports
     * `completionsUnmatched: 1` here and fails this case, while every other case in the file stays
     * green. That is precisely the shape of a counter that quietly means the wrong thing.)
     */
    const consolidator = scriptedConsolidator(() =>
      withCommitments([
        commitment({
          statement: "a colleague shipped the migration",
          actor: "other",
          resolved: true,
          evidence: { sessionId: "session-a", quote: "sanju shipped the migration" }
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.commitmentsSkipped).toBe(1)
          expect(outcome.counts.completionsUnmatched).toBe(0)
          expect(outcome.counts.completionsApplied).toBe(0)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("closes rather than refreshing when one answer reports a commitment both ways", async () => {
    /**
     * The ORDER of the two arms, which is load-bearing and would otherwise be invisible. A model can
     * report one sentence twice — once as an open commitment and once as resolved — and the two key the
     * same. Closures run FIRST, so the answer resolves to "closed".
     *
     * Mints-first would REFRESH the task and then close it in the same commit, which is worse than
     * either outcome on its own: the queue loses a task in the same breath that stamped it as freshly
     * seen, and the `memhtml-updated` stamp says a human was shown something archived before they could
     * look.
     *
     * (Mutation: moving the mint loop above the closure block makes this report
     * `commitmentsRefreshed: 1` and fails the assertion below.)
     */
    const consolidator = scriptedConsolidator((request, offset) => {
      const session = request.transcripts[0]?.sessionId ?? "session-a"
      return withCommitments(
        offset === 0 ? [shipped(session, false)] : [shipped(session, false), shipped(session, true)]
      )
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* oneSession(fixture, "session-a")
          yield* traceConsolidation(envFor(fixture))
          expect(yield* detectedIn(fixture)).toHaveLength(1)

          yield* oneSession(fixture, "session-b")
          const second = yield* traceConsolidation(envFor(fixture, false, { date: LATER }))
          expect(second.counts.completionsApplied).toBe(1)
          expect(second.counts.commitmentsRefreshed).toBe(0)
          /**
           * The unresolved twin then mints a FRESH task, because the closure took its key out of the
           * open queue first. That is the intended reading: the night's answer says the work is done, so
           * the old task closes, and the same answer's open claim opens a new proposal a reviewer can
           * dismiss in one action. It is churn a model created, not churn the phase invented.
           */
          expect(second.counts.commitmentTasks).toBe(1)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})
