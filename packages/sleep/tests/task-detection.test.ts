import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { dedupMerge } from "../src/phases/dedup-merge.js"
import { edgeTyping } from "../src/phases/edge-typing.js"
import { entityResolution } from "../src/phases/entity-resolution.js"
import {
  TASK_DETECT_DETECTOR,
  TASK_DETECT_FLOOR,
  taskDetection
} from "../src/phases/task-detection.js"
import { instantFor } from "../src/run.js"
import { recentActiveMemories } from "../src/sql.js"
import {
  closeVanishedDetections,
  DETECTED_TASK_CAP,
  DETECTED_TASK_DIR,
  DETECTION_PREFIX,
  detectionKey,
  isDetectedTaskPath,
  makeDetectionBudget,
  mintDetectedTask,
  openDetections
} from "../src/tasks.js"
import { scriptedModel, value, violation } from "../src/testing.js"
import {
  DEDUP_CORPUS,
  DEDUP_VETO_TRIPLE,
  type Fixture,
  memoryHtml,
  TASK_CORPUS,
  VETO_KEEP_PATH,
  VETO_REFUSED_PATH,
  withFixture
} from "./fixture.js"

/**
 * Task detection: the shared minting discipline, the three review surfaces, and the batched scan.
 *
 * Every guard here is asserted against the TREE rather than against a phase's counts, for the reason
 * `run.test.ts` states about git: a phase that reported `tasksMinted: 1` while writing nothing would
 * satisfy a count assertion and none of the ones that matter. The counts are asserted too, but only
 * beside the file they claim to describe.
 *
 * Each `it` names the mutation that makes it fail, because the vacuous-lock failure mode this repo has
 * paid for repeatedly is a guard test that passes against a corpus with nothing for the guard to
 * refuse. The mutation ledger is in the PR body; the per-test notes are what let a reader re-run one.
 */

const DATE = "2026-08-02"
const LATER = "2026-08-03"

const envFor = (
  fixture: Fixture,
  options: { readonly date?: string; readonly dryRun?: boolean; readonly cap?: number } = {}
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
    dryRun: options.dryRun ?? false,
    detectionBudget: makeDetectionBudget(options.cap ?? DETECTED_TASK_CAP)
  }
}

/** Every detected task in the WORKING TREE, path-ordered. Read through the module's own tree read. */
const detectedIn = (fixture: Fixture, date = DATE) =>
  openDetections(envFor(fixture, { date })).pipe(Effect.orDie)

/** Paths under the detected-task prefix at a commitish, from git rather than from the tree. */
const detectedAt = (fixture: Fixture, commitish: string): Effect.Effect<ReadonlyArray<string>> =>
  fixture.deps.git.run(["ls-tree", "-r", "--name-only", commitish, `${DETECTED_TASK_DIR}/`]).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => isDetectedTaskPath(line))
        .sort()
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>)
  )

/** A file's bytes at a commitish, or `undefined`. */
const bytesAt = (
  fixture: Fixture,
  commitish: string,
  path: string
): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `${commitish}:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/** A model that answers every OTHER LLM phase with "nothing to do". */
const inertUnless = (
  reply: (request: { readonly system: string; readonly prompt: string }, at: number) => unknown
) =>
  scriptedModel((request, at) => {
    if (request.system.startsWith("You triage")) return value({ entries: [] })
    if (request.system.startsWith("You partition")) return value({ groups: [] })
    if (request.system.startsWith("You type")) return value({ verdicts: [] })
    if (request.system.startsWith("You group")) return value({ clusters: [] })
    if (request.system.startsWith("You find")) {
      return value(reply(request, at) ?? { findings: [] })
    }
    return value({ title: "x", claim: "y", paragraphs: [], absorbedKeys: [] })
  })

/**
 * A memory carrying a sentence a detector can quote verbatim, plus one that carries none.
 *
 * The second file is the negative control that makes every "the phase minted one task" assertion
 * non-vacuous: a corpus where every member has a commitment would pass against a phase that minted a
 * task per member.
 */
const COMMITMENT_SENTENCE = "I will wire the capture hook before the next release ships."

const SCAN_CORPUS = [
  {
    path: "areas/deploy/capture-hook-pending.html",
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The capture hook is not wired yet</title>
<meta name="memhtml-type" content="agent_insight">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-07-20T00:00:00Z">
<meta name="memhtml-updated" content="2026-07-30T00:00:00Z">
<meta name="memhtml-tag" content="deploy">
</head>
<body>
<article>
<p><mark>The capture hook is not wired into the confirmation path.</mark> ${COMMITMENT_SENTENCE}</p>
</article>
</body>
</html>
`
  },
  {
    path: "areas/deploy/capture-hook-wired.html",
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The retry budget was raised to nine</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-07-21T00:00:00Z">
<meta name="memhtml-updated" content="2026-07-29T00:00:00Z">
<meta name="memhtml-tag" content="deploy">
</head>
<body>
<article>
<p><mark>The retry budget on the settlement queue is nine attempts.</mark> Raising it from three was measured against the observed backlog.</p>
</article>
</body>
</html>
`
  }
] as const

describe("the minting discipline", () => {
  it("keys a detected task by its finding, so a second night refreshes rather than duplicates", async () => {
    /**
     * The idempotence guard. MUTATION: drop the `existing !== undefined` branch in
     * `mintDetectedTask`, or key the path on the title instead of the digest — either produces two
     * files on the second night, and the second assertion goes red.
     *
     * Two nights are two `PhaseEnv`s with different `at` values, which is what makes the refresh
     * observable at all: the stamp is the only byte that changes.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const request = {
            detector: "probe",
            finding: "service checkout-api payments-api",
            title: "Confirm two service names",
            claim: "confirm: are these one service?",
            evidence: { kind: "measurement" as const, detail: "character overlap 0.79" }
          }

          const first = yield* mintDetectedTask(
            envFor(fixture),
            makeDetectionBudget(),
            request
          ).pipe(Effect.orDie)
          expect(first).toBe("minted")

          const afterFirst = yield* detectedIn(fixture)
          expect(afterFirst).toHaveLength(1)
          const path = afterFirst[0]?.path as string
          expect(path.startsWith(`${DETECTED_TASK_DIR}/${DETECTION_PREFIX}`)).toBe(true)
          const firstBytes = yield* bytesAt(fixture, "HEAD", path).pipe(
            Effect.orElseSucceed(() => undefined)
          )
          expect(firstBytes, "staged, not committed: the phase commits").toBeUndefined()

          /**
           * The same finding on a later date, with the TITLE reworded. The title reaches the path's
           * slug, so a key that leaned on it would produce a second file here.
           */
          const second = yield* mintDetectedTask(
            envFor(fixture, { date: LATER }),
            makeDetectionBudget(),
            { ...request, title: "A completely different wording of the same question" }
          ).pipe(Effect.orDie)
          expect(second).toBe("refreshed")

          const afterSecond = yield* detectedIn(fixture, LATER)
          expect(afterSecond.map((one) => one.path)).toEqual([path])
          // The stamp moved to the second night's instant; nothing else did.
          const bytes = yield* fixture.deps.store.readMemory(path).pipe(Effect.orDie)
          expect(bytes.doc.metas.updatedAt).toBe(instantFor(LATER).at)
          expect(bytes.doc.metas.createdAt).toBe(instantFor(DATE).at)
          expect(bytes.doc.article.gist).toBe(request.claim)
        }),
      { seed: [...DEDUP_CORPUS] }
    )
  })

  it("refuses a mint whose quote is not in the source it cites", async () => {
    /**
     * The evidence guard, and the issue's "code-verified evidence" in one assertion. MUTATION: make
     * `evidenceHolds` return `true` for a quote branch — the fabricated mint then lands and the second
     * `toHaveLength(0)` goes red.
     *
     * Non-vacuous by construction: the SAME source file admits a real quote from it, so the refusal is
     * about the quote and not about the file being unreadable.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const source = "areas/deploy/capture-hook-pending.html"
          const fabricated = yield* mintDetectedTask(envFor(fixture), makeDetectionBudget(), {
            detector: "probe",
            finding: `${source} fabricated`,
            title: "A finding whose evidence was invented",
            claim: "resolve: something the source never said.",
            evidence: {
              kind: "quote",
              quote: "I will personally rewrite the entire settlement pipeline on Friday.",
              sourcePath: source
            }
          }).pipe(Effect.orDie)
          expect(fabricated).toBe("unverified")
          expect(yield* detectedIn(fixture)).toHaveLength(0)

          const real = yield* mintDetectedTask(envFor(fixture), makeDetectionBudget(), {
            detector: "probe",
            finding: `${source} real`,
            title: "A finding whose evidence is in the file",
            claim: "resolve: the source really says this.",
            evidence: { kind: "quote", quote: COMMITMENT_SENTENCE, sourcePath: source }
          }).pipe(Effect.orDie)
          expect(real, "the same source admits a quote that is actually in it").toBe("minted")
          expect(yield* detectedIn(fixture)).toHaveLength(1)
        }),
      { seed: [...SCAN_CORPUS] }
    )
  })

  it("caps the night's mints across detectors and counts the overflow", async () => {
    /**
     * The volume cap, and the SHARED half of it. MUTATION: drop the `budget.remaining <= 0` check —
     * all four land and the `toHaveLength(2)` goes red. MUTATION: give each detector its own budget
     * (call `makeDetectionBudget()` per mint) — the second detector's mint succeeds and the same
     * assertion goes red, which is the half a per-detector cap would pass.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const budget = makeDetectionBudget(2)
          const env = envFor(fixture)
          const outcomes: Array<string> = []
          for (const [detector, finding] of [
            ["alpha", "one"],
            ["alpha", "two"],
            ["alpha", "three"],
            ["beta", "four"]
          ] as const) {
            outcomes.push(
              yield* mintDetectedTask(env, budget, {
                detector,
                finding,
                title: `A finding called ${finding}`,
                claim: `confirm: the ${finding} finding.`,
                evidence: { kind: "measurement", detail: `measured ${finding}` }
              }).pipe(Effect.orDie)
            )
          }

          expect(outcomes).toEqual(["minted", "minted", "capped", "capped"])
          expect(budget.overflow).toBe(2)
          expect(yield* detectedIn(fixture)).toHaveLength(2)
        }),
      { seed: [...DEDUP_CORPUS] }
    )
  })

  it("closes a vanished detection and leaves a still-live one open", async () => {
    /**
     * Self-cleaning, with the negative half in the same test — which is what makes it a test of the
     * SWEEP rather than of "close everything". MUTATION: drop the `liveKeys.has` check in
     * `closeVanishedDetections` and the live task is closed too, so the second assertion goes red.
     * MUTATION: drop the `archiveFile` call and the closed task stays at its live path, so the
     * `toBeUndefined` goes red.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const env = envFor(fixture)
          const budget = makeDetectionBudget()
          for (const finding of ["still-there", "gone-tomorrow"]) {
            yield* mintDetectedTask(env, budget, {
              detector: "probe",
              finding,
              title: `A finding called ${finding}`,
              claim: `confirm: the ${finding} finding.`,
              evidence: { kind: "measurement", detail: `measured ${finding}` }
            }).pipe(Effect.orDie)
          }
          const before = yield* detectedIn(fixture)
          expect(before).toHaveLength(2)
          const gonePath = before.find((one) => one.key === detectionKey("probe", "gone-tomorrow"))
            ?.path as string
          const livePath = before.find((one) => one.key === detectionKey("probe", "still-there"))
            ?.path as string

          // Commit what the mints staged, so the sweep's `git mv` has a tracked file to move.
          yield* fixture.deps.git.commit("seed two detected tasks").pipe(Effect.orDie)

          const closed = yield* closeVanishedDetections(
            envFor(fixture, { date: LATER }),
            "probe",
            new Set([detectionKey("probe", "still-there")])
          ).pipe(Effect.orDie)
          expect(closed).toBe(1)

          // The vanished one moved to the archive with `done` stamped; the live one did not move.
          expect(yield* bytesAt(fixture, "HEAD", gonePath)).toBeDefined()
          const remaining = yield* detectedIn(fixture, LATER)
          expect(remaining.map((one) => one.path)).toEqual([livePath])
          const archived = yield* fixture.deps.store
            .readMemory(`archive/2026/${gonePath}`)
            .pipe(Effect.orDie)
          expect(archived.doc.metas.taskStatus).toBe("done")
          expect(archived.doc.metas.status).toBe("archived")
        }),
      { seed: [...DEDUP_CORPUS] }
    )
  })
})

describe("the task-detection phase", () => {
  it("skips with a reason when no model is bound", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* taskDetection(envFor(fixture))
          expect(outcome.detail).toBe("no model bound")
          expect(outcome.commitSha).toBeNull()
          expect(outcome.llmCalls).toBe(0)
          expect(yield* detectedIn(fixture)).toHaveLength(0)
        }),
      { seed: [...SCAN_CORPUS] }
    )
  })

  it("mints a task from a verbatim commitment and refuses a fabricated sentence in the same batch", async () => {
    /**
     * The phase's whole happy path plus its evidence guard, driven from ONE model answer so the two
     * are known to be reachable together. MUTATION: remove the verbatim check and both findings mint,
     * so `minted` reads 2 and `unverified` reads 0.
     *
     * The `capture-hook-wired` member is the negative control: the model is answered for it with a
     * sentence that is not in it, which is exactly what a hallucinating model does.
     */
    const model = inertUnless(() => ({
      findings: [
        {
          memberKey: "m1",
          sentence: COMMITMENT_SENTENCE,
          kind: "commitment",
          confidence: 0.9
        },
        {
          memberKey: "m2",
          sentence: "We must delete the settlement queue before Thursday.",
          kind: "followup",
          confidence: 0.95
        }
      ]
    }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* taskDetection(envFor(fixture))

          expect(outcome.counts.findings).toBe(2)
          expect(outcome.counts.minted).toBe(1)
          expect(outcome.counts.unverified).toBe(1)
          expect(outcome.llmCalls).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

          /** The task is in the COMMIT, which is what puts it behind the discrimination gate. */
          const committed = yield* detectedAt(fixture, outcome.commitSha as string)
          expect(committed).toHaveLength(1)

          const task = yield* fixture.deps.store
            .readMemory(committed[0] as string)
            .pipe(Effect.orDie)
          expect(task.doc.metas.memoryType).toBe("task")
          expect(task.doc.metas.taskStatus).toBe("todo")
          expect(task.doc.metas.author).toBe("agent:sleep")
          expect(task.doc.tags).toEqual(["detected", TASK_DETECT_DETECTOR])
          // The evidence is a real `<q cite>` pointing at the source, and carries the quote verbatim.
          expect(task.doc.article.citations.map((one) => one.text)).toContain(COMMITMENT_SENTENCE)
          expect(task.doc.article.citations.map((one) => one.href)).toContain(
            "/areas/deploy/capture-hook-pending.html"
          )
          // And the fabricated sentence reached no file at all.
          expect(task.html).not.toContain("delete the settlement queue")
        }),
      { seed: [...SCAN_CORPUS], model }
    )
  })

  it("drops a finding below the confidence floor", async () => {
    /**
     * MUTATION: delete the `finding.confidence < TASK_DETECT_FLOOR` guard — the task mints and
     * `minted` reads 1. The confidence sits one hundredth BELOW the floor, so a guard written with
     * `<=` instead of `<` still passes and a guard deleted does not.
     */
    const model = inertUnless(() => ({
      findings: [
        {
          memberKey: "m1",
          sentence: COMMITMENT_SENTENCE,
          kind: "commitment",
          confidence: TASK_DETECT_FLOOR - 0.01
        }
      ]
    }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* taskDetection(envFor(fixture))
          expect(outcome.counts.findings).toBe(1)
          expect(outcome.counts.minted).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect(yield* detectedIn(fixture)).toHaveLength(0)
        }),
      { seed: [...SCAN_CORPUS], model }
    )
  })

  it("never scans a detected task, so a task is not evidence of another task", async () => {
    /**
     * The no-self-scan guard. MUTATION: drop `SLEEP_EXCLUDED_TYPES` from `recentActiveMemories` — the
     * seeded detected task appears in the scan, reaches the prompt, and both assertions go red.
     *
     * A SECOND path-prefix filter inside the phase was written and then removed, and this test is why:
     * mutating it away left this green, because a detected task the index has not yet projected is
     * absent from the statement's result rather than present under the wrong type. That is the vacuous
     * -lock this repo's own lesson names, caught by running the mutation rather than by reasoning about
     * it, so the phase now carries one guard that fires instead of two where one cannot.
     *
     * Both kinds of task are seeded: a DETECTED one (so the exclusion has the self-scan case to refuse)
     * and the ordinary ones from `TASK_CORPUS` (so it is not passing merely because the corpus holds no
     * tasks at all).
     */
    const model = inertUnless(() => ({ findings: [] }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const key = detectionKey("probe", "seeded")
          const detectedPath = `${DETECTED_TASK_DIR}/${key}-a-seeded-detection.html`
          yield* fixture.commit(
            [
              {
                path: detectedPath,
                html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A seeded detection</title>
<meta name="memhtml-type" content="task">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-01T00:00:00Z">
<meta name="memhtml-updated" content="2026-08-01T00:00:00Z">
<meta name="memhtml-task-status" content="todo">
<meta name="memhtml-author" content="agent:sleep">
<meta name="memhtml-tag" content="detected">
<meta name="memhtml-tag" content="probe">
</head>
<body>
<article>
<p><mark>confirm: a seeded detection nobody has answered.</mark> I will decide this tomorrow for certain.</p>
</article>
</body>
</html>
`
              }
            ],
            "seed a detected task"
          )
          yield* fixture.reindex()

          const scanned = yield* recentActiveMemories(fixture.db, { limit: 500 }).pipe(Effect.orDie)
          expect(scanned.map((row) => row.path)).not.toContain(detectedPath)
          expect(
            scanned.filter((row) => row.memory_type === "task"),
            "no task of any kind reaches the scan"
          ).toEqual([])
          // Non-vacuous: the corpus really does hold tasks for the filter to exclude.
          expect(
            (yield* fixture.db
              .all<{ n: number }>(
                "SELECT count(*) AS n FROM files WHERE memory_type = 'task' AND archived = 0"
              )
              .pipe(Effect.orDie))[0]?.n
          ).toBeGreaterThan(1)

          yield* taskDetection(envFor(fixture))
          expect(model.calls.length).toBeGreaterThan(0)
          for (const call of model.calls) {
            expect(call.prompt).not.toContain("a seeded detection nobody has answered")
            expect(call.prompt).not.toContain("I will decide this tomorrow for certain")
          }
        }),
      { seed: [...SCAN_CORPUS, ...TASK_CORPUS], model }
    )
  })

  it("does not sweep on a night whose model call failed", async () => {
    /**
     * The sweep's precondition. MUTATION: replace `skipped === 0` with an unconditional sweep — the
     * previously minted task is closed because a throttled call made its finding look gone, and the
     * `toHaveLength(1)` goes red.
     *
     * Driven with a `violation`, which is the shape a real off-contract answer takes, so the phase's
     * per-batch isolation is what produces `skipped` rather than a flag a test set.
     */
    const model = scriptedModel((request) =>
      request.system.startsWith("You find")
        ? violation("scripted off-contract answer")
        : value({ findings: [] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const env = envFor(fixture)
          yield* mintDetectedTask(env, makeDetectionBudget(), {
            detector: TASK_DETECT_DETECTOR,
            finding: "areas/deploy/capture-hook-pending.html something found last night",
            title: "A finding from last night",
            claim: "resolve: a finding from last night.",
            evidence: { kind: "measurement", detail: "found last night" }
          }).pipe(Effect.orDie)
          yield* fixture.deps.git.commit("seed a prior detection").pipe(Effect.orDie)

          const outcome = yield* taskDetection(envFor(fixture, { date: LATER }))
          expect(outcome.counts.skipped).toBe(1)
          expect(outcome.counts.closed).toBe(0)
          expect(yield* detectedIn(fixture, LATER)).toHaveLength(1)
        }),
      { seed: [...SCAN_CORPUS], model }
    )
  })

  it("counts candidates on a dry run and writes nothing", async () => {
    const model = inertUnless(() => ({
      findings: [
        { memberKey: "m1", sentence: COMMITMENT_SENTENCE, kind: "commitment", confidence: 0.99 }
      ]
    }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* taskDetection(envFor(fixture, { dryRun: true }))
          expect(outcome.counts.candidates).toBe(SCAN_CORPUS.length)
          expect(outcome.counts.minted).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect(model.calls, "a dry run spends no tokens it then discards").toEqual([])
          expect(yield* detectedIn(fixture)).toHaveLength(0)
        }),
      { seed: [...SCAN_CORPUS], model }
    )
  })
})

/**
 * Two service names inside the character REVIEW BAND, and one well outside it.
 *
 * `ENTITY_CORPUS` cannot carry this test: its negative control is `checkout-api` against
 * `payments-api`, which scores **0.5000** by longest-common-subsequence — deliberately BELOW the 0.75
 * band, because that corpus exists to prove a centroid cosine is not a merge threshold. Measured with
 * `nameSimilarity` on 2026-08-19:
 *
 * | pair | ratio | band |
 * |---|---|---|
 * | `checkout-api` ↔ `checkout-cli` | 0.8333 | REVIEW — deferred, and the pair this asserts on |
 * | `metrics-api` ↔ `checkout-api` | 0.5833 | below the band — no candidate, no task |
 * | `metrics-api` ↔ `checkout-cli` | 0.4167 | below the band |
 *
 * So exactly ONE pair of the three is deferred, which is what makes "the phase minted one task" a real
 * assertion rather than one a corpus of uniformly-similar names would pass. Neither band name
 * normalizes onto the other and no person file declares them aliases, so nothing merges either: this
 * corpus produces a night whose only outcome is a deferral.
 */
const ENTITY_BAND_CORPUS = [
  {
    path: "areas/services/checkout-api-timeout.html",
    html: memoryHtml({
      title: "The checkout API times out after four seconds",
      claim: "The checkout api closes an upstream call after four seconds.",
      memoryType: "semantic",
      createdAt: "2026-04-06T00:00:00Z",
      entities: ["service:checkout-api"],
      tags: ["deploy"]
    })
  },
  {
    path: "areas/services/checkout-cli-retries.html",
    html: memoryHtml({
      title: "The checkout CLI retries a failed submit",
      claim: "The checkout cli resubmits an order once before reporting a failure.",
      memoryType: "semantic",
      createdAt: "2026-04-07T00:00:00Z",
      entities: ["service:checkout-cli"],
      tags: ["tooling"]
    })
  },
  {
    path: "areas/services/metrics-api-cadence.html",
    html: memoryHtml({
      title: "The metrics API serves a one-minute window",
      claim: "The metrics api answers queries over a one-minute aggregation window.",
      memoryType: "semantic",
      createdAt: "2026-04-08T00:00:00Z",
      entities: ["service:metrics-api"],
      tags: ["observability"]
    })
  }
] as const

describe("surface 1: the review phases mint tasks", () => {
  it("entity-resolution turns a review-band pair into a task in its own commit", async () => {
    /**
     * Issue #44's motivating case, end to end: `reviewCandidates: 2` used to be the whole outcome of a
     * deferred decision. MUTATION: delete the `mintReviewTasks` call — `reviewCandidates` still reads
     * the same number and `tasksMinted` reads 0, so the count alone cannot carry this assertion, which
     * is exactly the point.
     *
     * {@link ENTITY_BAND_CORPUS} puts `checkout-api` and `checkout-cli` in the character review band
     * (0.8333, inside 0.75-0.85) and keeps a third name well below it, so the band pass has exactly one
     * real deferral with NO model bound at all — which is why this runs without one.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))

          expect(outcome.counts.reviewCandidates, "exactly one pair is in the band").toBe(1)
          expect(outcome.counts.tasksMinted).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

          const committed = yield* detectedAt(fixture, outcome.commitSha as string)
          expect(committed).toHaveLength(1)

          const task = yield* fixture.deps.store
            .readMemory(committed[0] as string)
            .pipe(Effect.orDie)
          expect(task.doc.article.gist).toBe(
            'confirm: are "checkout-api" and "checkout-cli" the same service?'
          )
          expect(task.doc.metas.memoryType).toBe("task")
          expect(task.doc.metas.taskStatus).toBe("todo")
          expect(task.doc.metas.author).toBe("agent:sleep")
          expect(task.doc.tags).toEqual(["detected", "entity-resolution"])
          // A measurement, so no `<q>`: there is no sentence in the corpus stating a ratio.
          expect(task.doc.article.citations).toEqual([])
          expect(task.doc.article.bodyText).toContain("character overlap 0.83")
          expect(task.doc.article.bodyText).toContain("review band")
          // The name that is NOT in the band reached no task at all.
          expect(task.html).not.toContain("metrics-api")
        }),
      { seed: [...ENTITY_BAND_CORPUS] }
    )
  })

  it("entity-resolution mints on a night that rewrote nothing at all", async () => {
    /**
     * The reordering that makes surface 1 reachable. MUTATION: restore the old
     * `if (rewrites.size === 0 || env.dryRun) return` early exit — a night whose ONLY outcome is
     * deferrals mints nothing and every assertion here goes red. That was the shape of the night the
     * issue was written about.
     *
     * {@link ENTITY_BAND_CORPUS} produces exactly that night: no name normalizes onto another and no
     * alias is declared, so `filesRewritten` is 0 while `reviewCandidates` is 1.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.counts.filesRewritten).toBe(0)
          expect(outcome.counts.namesNormalized).toBe(0)
          expect(outcome.counts.reviewCandidates).toBe(1)
          expect(outcome.counts.tasksMinted).toBe(1)
          expect(outcome.commitSha).not.toBeNull()
        }),
      { seed: [...ENTITY_BAND_CORPUS] }
    )
  })

  it("entity-resolution mints nothing on a dry run", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture, { dryRun: true }))
          expect(outcome.counts.reviewCandidates, "the count is real on a dry run").toBe(1)
          expect(outcome.counts.tasksMinted).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect(yield* detectedIn(fixture)).toHaveLength(0)
        }),
      { seed: [...ENTITY_BAND_CORPUS] }
    )
  })

  it("dedup-merge turns a vetoed pair into a task naming the predicate that fired", async () => {
    /**
     * MUTATION: delete the `mintVetoTasks` call — `vetoed` still counts the pair and no file exists,
     * so `tasksMinted` reads 0. MUTATION: replace `vetoedPairs`'s per-predicate list with a bare
     * "vetoed" string — the `negated` assertion goes red, which is what makes the task useful rather
     * than merely present.
     *
     * `DEDUP_CORPUS` carries the measured negation flip at cosine 0.9907, which the veto refuses while
     * the true duplicate at 0.9277 merges. So the same commit holds a fold AND a deferral, which is
     * the arrangement the phase's one-commit discipline has to survive.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.merged, "the true duplicates still fold").toBeGreaterThan(0)
          expect(outcome.counts.vetoed).toBeGreaterThan(0)
          expect(outcome.counts.tasksMinted).toBeGreaterThan(0)

          const committed = yield* detectedAt(fixture, outcome.commitSha as string)
          expect(committed.length).toBe(outcome.counts.tasksMinted)
          const tasks = yield* Effect.all(
            committed.map((path) => fixture.deps.store.readMemory(path).pipe(Effect.orDie))
          )
          expect(
            tasks.every((task) =>
              task.doc.article.gist.startsWith("review: near-duplicates vetoed for divergence")
            )
          ).toBe(true)
          const bodies = tasks.map((task) => task.doc.article.bodyText).join("\n")
          expect(bodies, "the predicate is named, not merely that a veto fired").toContain(
            "one side is negated and the other is not"
          )
          expect(bodies).toContain(VETO_REFUSED_PATH)
          expect(bodies).toContain(VETO_KEEP_PATH)
          for (const task of tasks) {
            expect(task.doc.tags).toEqual(["detected", "dedup-merge"])
            expect(task.doc.metas.author).toBe("agent:sleep")
          }
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_VETO_TRIPLE] }
    )
  })

  it("edge-typing turns a single-detection contradiction into a task, and closes it on promotion", async () => {
    /**
     * Both halves of the third detector, which is the only one whose closure is the system resolving
     * the finding rather than the finding evaporating. MUTATION: delete the `deferred.push` — the first
     * `tasksMinted` reads 0. MUTATION: make `mintContradictionTasks` sweep unconditionally on a
     * `skipped` night and the "does not sweep" test above goes red instead.
     *
     * The two nights are two phase runs: the first bumps the counter to 1 (below the gate, so the task
     * is opened), and the second reaches 2, promotes the edge into both files, and stops deferring — so
     * the sweep closes the task.
     */
    const model = scriptedModel((request) =>
      request.system.startsWith("You type")
        ? value({
            verdicts: [
              {
                pairKey: "m1",
                rel: "contradicts",
                direction: "src_to_dst",
                confidence: 0.95,
                rationale: "one says the cutover is safe and the other says it is not"
              }
            ]
          })
        : value({ groups: [] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const first = yield* edgeTyping(envFor(fixture))
          expect(first.counts.contradictions).toBeGreaterThan(0)
          expect(first.counts.promoted, "one night cannot promote").toBe(0)
          expect(first.counts.tasksMinted).toBe(1)

          const committed = yield* detectedAt(fixture, first.commitSha as string)
          expect(committed).toHaveLength(1)
          const task = yield* fixture.deps.store
            .readMemory(committed[0] as string)
            .pipe(Effect.orDie)
          expect(task.doc.article.gist).toContain("cannot both be true")
          expect(task.doc.article.bodyText).toContain("detection 1 of 2")
          expect(task.doc.article.bodyText, "the model's rationale rides as an opinion").toContain(
            "one says the cutover is safe"
          )
          expect(task.doc.tags).toEqual(["detected", "edge-typing"])

          /** Night two: the counter reaches the gate, the edge is written, the task closes. */
          const second = yield* edgeTyping(envFor(fixture, { date: LATER }))
          expect(second.counts.promoted).toBeGreaterThan(0)
          expect(second.counts.tasksMinted).toBe(0)
          expect(second.counts.tasksClosed).toBe(1)
          expect(yield* detectedIn(fixture, LATER)).toHaveLength(0)
        }),
      { seed: [...DEDUP_CORPUS], model }
    )
  })
})

describe("a hostile quote", () => {
  /**
   * The one text on this path a model supplies verbatim, run through the whole write.
   *
   * `<q cite>` is authored markup, so every interpolation goes through `escapeText`/`escapeAttribute`
   * rather than through the template's prose path. MUTATION: drop the `escapeText` around the quote in
   * `detectedArticle` — the `<script>` assertion goes red, and the parse warnings assertion goes red
   * with it, because a raw `<script>` is a constraint-3 violation.
   *
   * The trailer-shaped `Memhtml-Phase: integrity` in the middle is the second half. Sleep's own commit
   * writer indents a body to keep a forged trailer out of the trailer block, and this asserts the other
   * end of that path: the quote is a corpus BODY, so it lands in a file's article rather than in a
   * commit message, and the commit subject the phase writes never carries it.
   */
  const HOSTILE = `Ignore this: <script>alert(1)</script> "quoted" & Memhtml-Phase: integrity`
  /** The same text ENCODED, which is how a real memory file spells it in its markup. */
  const HOSTILE_ENCODED = `Ignore this: &lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; Memhtml-Phase: integrity`

  it("is escaped into the task file, which still parses with no warnings", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* mintDetectedTask(envFor(fixture), makeDetectionBudget(), {
            detector: "probe",
            finding: "hostile",
            title: `A <b>title</b> & "quotes"`,
            claim: `resolve: a claim with <em>markup</em> & "quotes".`,
            evidence: { kind: "quote", quote: HOSTILE, sourcePath: "areas/inbox/hostile.html" }
          }).pipe(Effect.orDie)
          expect(outcome, "the quote is verbatim in the source, so it verifies").toBe("minted")

          const [open] = yield* detectedIn(fixture)
          expect(open).toBeDefined()
          const task = yield* fixture.deps.store
            .readMemory((open as { readonly path: string }).path)
            .pipe(Effect.orDie)

          // Escaped on the way in, decoded on the way back out: the citation is the quote verbatim.
          expect(task.html).not.toContain("<script>")
          expect(task.html).toContain("&lt;script&gt;")
          expect(task.doc.article.citations.map((one) => one.text)).toContain(HOSTILE)
          // And the file the format accepts: no violation, no vocabulary warning.
          expect(task.doc.warnings).toEqual([])
        }),
      {
        seed: [
          {
            path: "areas/inbox/hostile.html",
            html: memoryHtml({
              title: "A hostile memory",
              claim: "This memory carries hostile prose.",
              body: HOSTILE_ENCODED
            })
          }
        ]
      }
    )
  })
})
