import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { CommitmentLike, ResolutionLike } from "../src/consolidator.js"
import { TRAILER_COUNTS, TRAILER_PHASE } from "../src/contract.js"
import type { PhaseEnv } from "../src/env.js"
import { COMMITMENT_FLOOR } from "../src/llm.js"
import { CLAIM_JACCARD_FLOOR, claimJaccard, DETECTED_TAG, findingKeyOf } from "../src/mint.js"
import { traceConsolidation } from "../src/phases/trace-consolidation.js"
import { instantFor } from "../src/run.js"
import { candidates, scriptedConsolidator } from "../src/testing.js"
import { DEDUP_CORPUS, type Fixture, memoryHtml, seedTrace, withFixture } from "./fixture.js"

/**
 * AC-4-2/3/4: trace-consolidation mints `commitment:` tasks and closes them on a resolution.
 *
 * Its own file rather than an extension of `trace-consolidation.test.ts`, which is already 1300 lines
 * about the phase's OTHER subject — session selection, watermarks, and the candidate-to-memory path.
 * Nothing here is faked but the consolidator: git is a temp-dir repo, the database carries the shipped
 * migrations, and every assertion about a task file reads the bytes back through `parseMemory`.
 *
 * The vacuous-lock lesson governs the negatives. Each gate case below runs beside a commitment that
 * WOULD mint, so "counted, not minted" is a discrimination rather than an empty corpus reporting zero;
 * and each Jaccard threshold is asserted at a MEASURED value with its headroom stated, so a floor
 * moved by a refactor fails here instead of silently ceasing to match.
 */

const DATE = "2026-08-19"
const DETECTOR = "trace-consolidation"

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

/** A commitment with everything defaulted, so a case states only the field it varies. */
const commitment = (
  input: Partial<CommitmentLike> & { readonly statement: string }
): CommitmentLike => ({
  statement: input.statement,
  actor: input.actor ?? "user",
  confidence: input.confidence ?? 0.8,
  evidence: input.evidence ?? {
    sessionId: "session-a",
    quote: `I'll get to it — ${input.statement}`
  },
  ...(input.dueHint === undefined ? {} : { dueHint: input.dueHint })
})

const resolution = (
  input: Partial<ResolutionLike> & { readonly statement: string }
): ResolutionLike => ({
  statement: input.statement,
  confidence: input.confidence ?? 0.8,
  evidence: input.evidence ?? { sessionId: "session-a", quote: `done: ${input.statement}` }
})

/** A scripted answer carrying commitments and resolutions and no candidates. */
const spoke = (input: {
  readonly commitments?: ReadonlyArray<CommitmentLike> | undefined
  readonly resolutions?: ReadonlyArray<ResolutionLike> | undefined
}) =>
  scriptedConsolidator(() => ({
    kind: "candidates" as const,
    candidates: [],
    commitments: input.commitments ?? [],
    resolutions: input.resolutions ?? []
  }))

/** Every open task file the tree holds under a detected-task path, HEAD-visible. */
const addedPaths = (fixture: Fixture, from: string): Effect.Effect<ReadonlyArray<string>> =>
  fixture.deps.git.diffNameStatus(from, "HEAD").pipe(
    Effect.map((changes) =>
      changes.filter((change) => change.kind === "added").map((change) => change.path)
    ),
    Effect.orDie
  )

const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

const headSha = (fixture: Fixture): Effect.Effect<string> =>
  fixture.raw("rev-parse", "HEAD").pipe(Effect.map((text) => text.trim()))

const messageOf = (fixture: Fixture, sha: string): Effect.Effect<string> =>
  fixture.raw("log", "-1", "--format=%B", sha)

/**
 * A commitment statement and its measured pairings, used across the closure cases.
 *
 * Measured with `mint.ts`'s own tokenizer, against the claim with its `commitment: ` prefix stripped —
 * which is what the phase compares, and this fixture is chosen SPECIFICALLY to make that choice
 * observable. The DONE resolution scores **0.6250 stripped and 0.5556 prefixed**, so it clears the 0.6
 * floor only when the prefix is stripped: a phase comparing the raw claim closes nothing here.
 *
 * A longer pair would not discriminate. `I'll add the VIP drain step to the rollback runbook` against
 * `I added …` scores 0.7273 stripped and 0.6667 prefixed — above the floor either way — so a closure
 * test written on it passes with the strip removed, which is exactly the vacuous lock this fixture
 * exists to avoid. (Measured both ways, 2026-08-20; the strip mutation was run and left that pair
 * green.) The short statement is also the realistic one: a spoken promise is usually six words, and
 * short is where a one-token union inflation moves the answer.
 *
 * NEAR_MISS scores 0.4000 stripped and UNRELATED 0.0909, so the floor is a threshold rather than a
 * formality even after the strip.
 */
const PROMISE = "I'll rotate the staging bastion key"
const RESOLVED = "I rotated the staging bastion key"
const NEAR_MISS = "the staging bastion key rotation is scheduled"
const UNRELATED = "shipped the metrics dashboard rewrite"

/** A commitment task as a previous night's mint left it, so the closure pass has something to close. */
const commitmentTask = (input: {
  readonly statement: string
  readonly taskStatus?: string | undefined
}) =>
  memoryHtml({
    title: `commitment: ${input.statement}`,
    claim: `commitment: ${input.statement}`,
    body: "Read out of a transcript by trace consolidation on an earlier night.",
    memoryType: "task",
    taskStatus: input.taskStatus ?? "todo",
    findingKey: findingKeyOf(DETECTOR, `commit:${input.statement.toLowerCase()}`),
    createdAt: "2026-08-01T00:00:00Z",
    tags: [DETECTED_TAG]
  })

const OPEN_TASK_PATH = "areas/inbox/tasks/t-vip-drain-commitment.html"

/** `DEDUP_CORPUS` plus one open todo commitment task, which is what a closure case needs to close. */
const OPEN_SEED = [
  ...DEDUP_CORPUS,
  { path: OPEN_TASK_PATH, html: commitmentTask({ statement: PROMISE }) }
]

describe("the measured Jaccard pairings this suite rests on", () => {
  it("puts the resolved pair above the floor and the near miss below it", () => {
    /**
     * The fixture's own arithmetic, asserted before any behavior depends on it. A closure test whose
     * pair silently drifted below the floor would report "the closer does not work" while the truth
     * was "these two sentences no longer overlap", and the two need different fixes.
     */
    const resolved = claimJaccard(PROMISE, RESOLVED)
    expect(resolved).toBeCloseTo(0.625, 3)
    expect(resolved).toBeGreaterThanOrEqual(CLAIM_JACCARD_FLOOR)

    const near = claimJaccard(PROMISE, NEAR_MISS)
    expect(near).toBeCloseTo(0.4, 3)
    expect(near).toBeLessThan(CLAIM_JACCARD_FLOOR)

    expect(claimJaccard(PROMISE, UNRELATED)).toBeCloseTo(0.0909, 3)
  })

  it("shows the pinned claim prefix pushing this pair BELOW the floor, which the strip prevents", () => {
    /**
     * The measurement behind `claimStatement`, and the reason the closure fixture is a short statement.
     * `claimJaccard` reads the stored gist, which is the whole claim including `commitment:` — a token
     * no resolution carries, so it inflates the union by one on every comparison. On this pair that is
     * the difference between clearing the floor and missing it.
     *
     * (Mutation-verified 2026-08-20: replacing `claimStatement` with the identity fails the closure
     * case below — `resolutionClosed` goes from 1 to absent, so the commitment never closes — because
     * this fixture was chosen to make the strip load-bearing. On the earlier, longer fixture, 0.7273
     * stripped against 0.6667 prefixed, the SAME mutation left all twelve cases green. This case
     * itself is pure arithmetic and does not move under the mutation; it is the measurement that
     * explains the closure case's fixture.)
     */
    expect(claimJaccard(PROMISE, RESOLVED)).toBeGreaterThanOrEqual(CLAIM_JACCARD_FLOOR)
    expect(claimJaccard(`commitment: ${PROMISE}`, RESOLVED)).toBeCloseTo(0.5556, 3)
    expect(claimJaccard(`commitment: ${PROMISE}`, RESOLVED)).toBeLessThan(CLAIM_JACCARD_FLOOR)
  })
})

describe("commitment minting", () => {
  it("mints a task carrying session provenance, the detected tag, and the quote as PLAIN TEXT", async () => {
    /**
     * AC-4-2's happy path, and the evidence rule is the load-bearing half. A transcript quote gets NO
     * `<q cite>`: a `cite` in this corpus holds a repo-relative path the doctor resolves and verifies
     * the quote against, and a session id is not one — stamping it would produce a citation pointing at
     * nothing and fail doctor's stale-quote check on every commitment task forever. So the session id
     * rides in the prose for a human and in `memhtml-session` for the machine.
     *
     * (Mutation: quoting the evidence as `<q cite="session-a">` makes `article.citations` non-empty and
     * fails the `toEqual([])` below, while every count assertion here still passes.)
     */
    const consolidator = spoke({
      commitments: [commitment({ statement: PROMISE, confidence: 0.8, dueHint: "before Friday" })]
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

          const [path] = yield* addedPaths(fixture, base)
          expect(path).toBeDefined()
          /** An ordinary task path under the inbox's task directory, from `placementFor`'s task arm. */
          expect(path).toBe("areas/inbox/tasks/commitment-i-ll-rotate-the-staging-bastion-key.html")

          const doc = yield* parseMemory((yield* atHead(fixture, path ?? "")) ?? "").pipe(
            Effect.orDie
          )
          /** No parse warning: the body's markup is inside the closed vocabulary. */
          expect(doc.warnings).toEqual([])
          expect(doc.metas.memoryType).toBe("task")
          expect(doc.metas.taskStatus).toBe("todo")
          expect(doc.metas.author).toBe("agent:sleep")
          expect(doc.tags).toEqual([DETECTED_TAG])
          /** `memhtml-session` provenance, which is what `renderTemplate` received the sessionId for. */
          expect(doc.metas.sessionId).toBe("session-a")
          expect(doc.metas.findingKey).toBe(
            findingKeyOf(DETECTOR, `commit:${PROMISE.toLowerCase()}`)
          )

          /** The pinned claim template, verbatim, as the `<mark>` and therefore as `files.gist`. */
          expect(doc.article.gist).toBe(`commitment: ${PROMISE}`)
          /** The quote is in the BODY and names the session, and it is NOT a citation. */
          expect(doc.article.bodyText).toContain("In session session-a, the user said")
          expect(doc.article.bodyText).toContain(`I'll get to it — ${PROMISE}`)
          expect(doc.article.citations).toEqual([])
          /** And the quote is its own paragraph rather than tacked onto the claim sentence. */
          expect(doc.article.gist).not.toContain("In session")

          /**
           * `dueHint` reaches the prose and NOT `memhtml-due`. Parsing "before Friday" into a date
           * needs a reference clock this phase does not have, and a stamped due date would be a
           * deadline nobody stated that `task list` and retention would then treat as fact.
           */
          expect(doc.article.bodyText).toContain("before Friday")
          expect(doc.metas.dueAt).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("recognizes the SAME statement from a DIFFERENT session as the same task", async () => {
    /**
     * The fingerprint's whole point: the session id is provenance, NOT identity. A commitment restated
     * in a later session is the same work item — somebody said again they would do the thing they still
     * have not done — so night two must report `taskAlreadyOpen` and write nothing.
     *
     * Driven as a real TRANSITION across two runs with a commit and a reindex between them, because
     * that is the state night two actually starts from: `openDetectedTasks` reads the index, so a
     * pre-seeded row would pass even against a phase keying on the session.
     *
     * (Mutation: folding the session id into `commitmentFingerprint` makes night two mint a second
     * file at `…-2.html` with `taskMinted: 1`, and only the added-paths assertion fails.)
     */
    const consolidator = scriptedConsolidator((_request, offset) => ({
      kind: "candidates" as const,
      candidates: [],
      commitments: [
        commitment({
          statement: PROMISE,
          evidence: {
            sessionId: offset === 0 ? "session-night-one" : "session-night-two",
            quote: "I really will get to the runbook"
          }
        })
      ],
      resolutions: []
    }))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-night-one" })
          const first = yield* traceConsolidation(envFor(fixture))
          expect(first.counts.taskMinted).toBe(1)

          /** Commit and reindex: the minted task is now COMMITTED state the index can see. */
          yield* fixture.reindex()
          const afterFirst = yield* headSha(fixture)

          yield* seedTrace(fixture, { sessionId: "session-night-two" })
          const second = yield* traceConsolidation(envFor(fixture))

          expect(second.counts.taskAlreadyOpen).toBe(1)
          expect(second.counts.taskMinted).toBeUndefined()
          /** And nothing new in the tree: no second file, no second commit for the task pass. */
          expect(yield* addedPaths(fixture, afterFirst)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("counts each gate failure under its own name and mints the one commitment that clears", async () => {
    /**
     * The gate, all four arms at once, beside a commitment that DOES mint — so this is a
     * discrimination and not an empty corpus reporting zeros. Each arm gets its own counter because
     * they mean different things to an operator: a night of `commitmentNotUser` is an agent reading its
     * own plans back as the user's promises, which is a prompt problem, while `commitmentBelowFloor` is
     * a batch of musings, which is not a problem at all.
     *
     * (Mutation: dropping the `actor !== "user"` arm mints the assistant's own next tool call as the
     * human's to-do item — `taskMinted: 2` — which is the self-referential loop the spec forbids.)
     */
    const consolidator = spoke({
      commitments: [
        commitment({ statement: PROMISE }),
        // Below the floor: a hedge, not a commitment.
        commitment({ statement: "I might look at the bastion port sometime", confidence: 0.6 }),
        // The assistant's own plan for its next tool call.
        commitment({ statement: "I'll grep the config for that setting", actor: "assistant" }),
        // A session nobody in this batch read: fabricated provenance.
        commitment({
          statement: "I'll rewrite the scrape cadence doc",
          evidence: { sessionId: "session-never-read", quote: "a quote from nowhere" }
        }),
        // An empty quote leaves the body asserting a promise with nothing behind it.
        commitment({
          statement: "I'll pin the exporter scrape interval",
          evidence: { sessionId: "session-a", quote: "   " }
        })
      ]
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const base = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.commitmentBelowFloor).toBe(1)
          expect(outcome.counts.commitmentNotUser).toBe(1)
          /** The unreachable session and the blank quote are both grounding failures. */
          expect(outcome.counts.commitmentUngrounded).toBe(2)

          /** ONE file, and it is the one that cleared: four refusals wrote nothing at all. */
          const added = yield* addedPaths(fixture, base)
          expect(added).toHaveLength(1)
          expect(added[0]).toContain("staging-bastion-key")

          /** The floor is a threshold: 0.6 is below it and 0.7 is not. */
          expect(COMMITMENT_FLOOR).toBe(0.7)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })

  it("omits the mint vocabulary entirely from a night with no commitments", async () => {
    /**
     * The zero-omission rule (AC-3-4), which is what keeps the `Memhtml-Counts` trailer readable. A
     * night the consolidator answered with candidates and no commitments must report exactly the
     * counters it reported before this change existed.
     */
    const consolidator = scriptedConsolidator(() => candidates([]))

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          for (const key of [
            "taskMinted",
            "taskAlreadyOpen",
            "taskDeduped",
            "mintOverflow",
            "resolutionClosed",
            "resolutionUnmatched",
            "commitmentBelowFloor",
            "commitmentNotUser",
            "commitmentUngrounded"
          ]) {
            expect(outcome.counts[key], key).toBeUndefined()
          }
          /** And no commit: `commitPhase` no-ops on an empty index, so a quiet night is free. */
          expect(yield* headSha(fixture)).toBe(before)
        }),
      { seed: DEDUP_CORPUS, consolidator }
    )
  })
})

describe("resolution closure", () => {
  it("closes a matching todo commitment task, with the resolution in the commit", async () => {
    /**
     * AC-4-3. The task is archived with `done` stamped in the SAME staged move (`closeTask`), and the
     * REASON goes in the commit message because nothing in the format carries one — which is also
     * where a reviewer is reading when they ask why their task disappeared.
     *
     * (Mutation: dropping the `claimJaccard >= CLAIM_JACCARD_FLOOR` predicate closes on every
     * resolution, which the near-miss case below then catches; dropping the closure pass entirely
     * fails here on `resolutionClosed`.)
     */
    const consolidator = spoke({ resolutions: [resolution({ statement: RESOLVED })] })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.resolutionClosed).toBe(1)
          expect(outcome.counts.resolutionUnmatched).toBeUndefined()
          expect(outcome.commitSha).not.toBeNull()

          /** Gone from its live path, present in the archive, stamped `done` AND `archived`. */
          expect(yield* atHead(fixture, OPEN_TASK_PATH)).toBeUndefined()
          const archived = yield* atHead(fixture, `archive/2026/${OPEN_TASK_PATH}`)
          expect(archived).toBeDefined()
          const doc = yield* parseMemory(archived ?? "").pipe(Effect.orDie)
          expect(doc.metas.taskStatus).toBe("done")
          expect(doc.metas.status).toBe("archived")

          /** The reason NAMES the task and quotes the resolution that closed it. */
          const message = yield* messageOf(fixture, outcome.commitSha ?? "")
          expect(message).toContain(OPEN_TASK_PATH)
          expect(message).toContain(RESOLVED)

          /**
           * And the commit is THIS phase's, carrying the task counts in its own trailer rather than
           * leaving the closure staged for a later phase to absorb under its name.
           */
          const phases = yield* fixture.deps.git
            .logTrailers(`${outcome.commitSha ?? ""}^..${outcome.commitSha ?? ""}`, TRAILER_PHASE)
            .pipe(Effect.orDie)
          expect(phases[0]?.values).toEqual(["trace-consolidation"])
          const counts = yield* fixture.deps.git
            .logTrailers(`${outcome.commitSha ?? ""}^..${outcome.commitSha ?? ""}`, TRAILER_COUNTS)
            .pipe(Effect.orDie)
          const parsed = JSON.parse(counts[0]?.values[0] ?? "") as Record<string, number>
          expect(parsed.resolutionClosed).toBe(1)

          /** Nothing left staged for a later phase's commit to pick up. */
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: OPEN_SEED, consolidator }
    )
  })

  it("leaves a DOING task alone, because a human owns it now", async () => {
    /**
     * The todo-only guard, and it is the same rule `closeAbsent` carries for the same reason: somebody
     * moved this to `doing`, so a model's reading that the work finished is not permission to archive
     * their work item out from under them. They will mark it done themselves.
     *
     * The resolution is the SAME 0.7273 pair that closes a todo task in the case above, so what
     * differs here is one meta and nothing else.
     *
     * (Mutation: deleting the `row.task_status === "todo"` clause archives the doing task and fails
     * both assertions below.)
     */
    const consolidator = spoke({ resolutions: [resolution({ statement: RESOLVED })] })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.resolutionClosed).toBeUndefined()
          expect(outcome.counts.resolutionUnmatched).toBe(1)
          /** Byte-identical at its live path, and no commit was made at all. */
          expect(yield* atHead(fixture, OPEN_TASK_PATH)).toBe(
            commitmentTask({ statement: PROMISE, taskStatus: "doing" })
          )
          expect(yield* headSha(fixture)).toBe(before)
        }),
      {
        seed: [
          ...DEDUP_CORPUS,
          {
            path: OPEN_TASK_PATH,
            html: commitmentTask({ statement: PROMISE, taskStatus: "doing" })
          }
        ],
        consolidator
      }
    )
  })

  it("counts a near-miss resolution as unmatched and closes nothing", async () => {
    /**
     * The floor as a THRESHOLD. `the VIP drain step is in the rollback runbook now` is about the same
     * runbook and the same step and scores 0.4615, which is not a statement that the work happened —
     * the drain step being present is consistent with somebody else having written it, or with the
     * commitment being about a different edit. Below the floor, nothing closes.
     *
     * A below-floor CONFIDENCE resolution rides in the same run, so both refusal arms are exercised
     * and both land in `resolutionUnmatched`.
     */
    const consolidator = spoke({
      resolutions: [
        resolution({ statement: NEAR_MISS }),
        resolution({ statement: UNRELATED }),
        // A hedged completion: above the Jaccard bar would not save it, and it is not above it either.
        resolution({ statement: RESOLVED, confidence: 0.6 })
      ]
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.counts.resolutionUnmatched).toBe(3)
          expect(outcome.counts.resolutionClosed).toBeUndefined()
          /** The task is still there and the tree did not move. */
          expect(yield* atHead(fixture, OPEN_TASK_PATH)).toBeDefined()
          expect(yield* headSha(fixture)).toBe(before)
        }),
      { seed: OPEN_SEED, consolidator }
    )
  })

  it("never closes by ABSENCE: a night with no resolutions leaves the backlog alone", async () => {
    /**
     * The one closure rule this detector does NOT have, stated as a test because its absence is a
     * decision. The other three detectors attest `universeComplete` and archive findings that stopped
     * appearing; this one reads ten sessions out of an unbounded history, so a commitment made last
     * March is absent from tonight's batch because tonight's batch is ten files. Attesting completeness
     * here would archive the whole commitment backlog on the first night, and every night after.
     *
     * (Mutation: adding `yield* minter.closeAbsent(true)` to the pass archives the seeded task on this
     * very fixture and fails here — the honest reproduction of that bug.)
     */
    const consolidator = spoke({ commitments: [commitment({ statement: UNRELATED })] })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })

          const outcome = yield* traceConsolidation(envFor(fixture))

          /** The unrelated commitment minted, so the pass really ran rather than returning early. */
          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.taskClosed).toBeUndefined()
          expect(outcome.counts.closureSkipped).toBeUndefined()
          /** The seeded task, whose finding is nowhere in tonight's answer, is untouched. */
          expect(yield* atHead(fixture, OPEN_TASK_PATH)).toBe(
            commitmentTask({ statement: PROMISE })
          )
        }),
      { seed: OPEN_SEED, consolidator }
    )
  })
})

describe("the degraded and dry-run paths", () => {
  it("mints and closes nothing when no consolidator is bound", async () => {
    /**
     * INV-3's base case for this pass. A run with no Bedrock credentials — every CI run — reaches the
     * "no consolidator bound" early return before any of this, so the commitment machinery must be
     * unreachable rather than merely quiet.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture))

          expect(outcome.detail).toBe("no consolidator bound")
          expect(outcome.counts.taskMinted).toBeUndefined()
          expect(outcome.counts.resolutionClosed).toBeUndefined()
          expect(yield* headSha(fixture)).toBe(before)
          expect(yield* atHead(fixture, OPEN_TASK_PATH)).toBeDefined()
        }),
      { seed: OPEN_SEED }
    )
  })

  it("counts a dry run's mint and closure while leaving the tree byte-identical", async () => {
    /**
     * A dry run stops before the model call in this phase, so the commitment pass is never reached at
     * all and the counts are absent rather than zero — which is the honest report: nothing was asked,
     * so nothing was found. Asserted because the alternative shapes (a preview with counts, a crash on
     * an absent outcome) are both reachable from a careless guard.
     */
    const consolidator = spoke({
      commitments: [commitment({ statement: UNRELATED })],
      resolutions: [resolution({ statement: RESOLVED })]
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const before = yield* headSha(fixture)

          const outcome = yield* traceConsolidation(envFor(fixture, true))

          expect(outcome.counts.batch).toBe(1)
          expect(outcome.counts.taskMinted).toBeUndefined()
          expect(outcome.counts.resolutionClosed).toBeUndefined()
          /** No call at all, no commit, and a clean tree for the next phase. */
          expect(consolidator.calls).toEqual([])
          expect(yield* headSha(fixture)).toBe(before)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: OPEN_SEED, consolidator }
    )
  })
})
