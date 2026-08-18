import { EVICT_THRESHOLD } from "@memhtml/domain"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { arcSynthesis } from "../src/phases/arc-synthesis.js"
import { compress } from "../src/phases/compress.js"
import { conflictDetection } from "../src/phases/conflict-detection.js"
import { entityResolution } from "../src/phases/entity-resolution.js"
import { personLinks } from "../src/phases/person-links.js"
import { retentionTriage } from "../src/phases/retention-triage.js"
import { runRetentionPass } from "../src/retention.js"
import { instantFor } from "../src/run.js"
import { conflictCandidates, neighborPairs } from "../src/sql.js"
import { scriptedModel, value } from "../src/testing.js"
import { DEDUP_CORPUS, type Fixture, TASK_CORPUS, withFixture } from "./fixture.js"

/**
 * Per-phase task exclusions, each asserted at the phase that owns it.
 *
 * The full-run test in `run.test.ts` proves the OUTCOME — every task file byte-identical, no edge
 * onto a task — and four of the nine exclusions are not individually observable through it: their
 * phases are guarded by a model gate, a band threshold, or a community-size floor that the fixture
 * corpus does not clear anyway. Mutation-verified: reverting each of those four leaves the full-run
 * test green, which is precisely the vacuous-lock failure mode the repo's own lesson names. So each
 * is tested here against its own phase, where the guard is the only thing standing between the task
 * and the write.
 *
 * The tasks come from {@link TASK_CORPUS}, which is built so each exclusion has something to refuse:
 * an EVICT-band task, a person-entity task, a mixed-case-entity task, two near-duplicate tasks.
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

const SEED = [...DEDUP_CORPUS, ...TASK_CORPUS]

const FORGOTTEN = "areas/inbox/tasks/t-forgotten.html"
const ASK_IMANI = "areas/inbox/tasks/t-ask-imani.html"

/** A file's bytes at HEAD, or `undefined` when HEAD holds no such path. */
const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/** A model that answers every phase with "nothing to do", so no LLM phase writes. */
const inertModel = () =>
  scriptedModel((request) =>
    request.system.startsWith("You triage")
      ? value({ entries: [] })
      : value({ verdict: "neutral", confidence: 0.9, rationale: "compatible" })
  )

describe("retention-triage", () => {
  it("drops a task from the candidate set before it is banded at all", async () => {
    /**
     * The exclusion here is DEFENSE IN DEPTH, and saying so is the honest form of this test.
     *
     * `HALF_LIVES_DAYS.task` is `null`, so a task's recency signal is pinned at 1 whatever its age
     * — and with a uniform PageRank over an edgeless corpus contributing its own fixed share, the
     * floor a task can reach under `DEFAULT_WEIGHTS` sits ABOVE the 0.3 evict edge. `t-forgotten` is
     * seven months stale, never accessed, importance 1, and one line long, and it still scores 0.57.
     * So there is no fixture that makes "the phase declined to evict an EVICT-banded task" a real
     * assertion: the domain's half-life entry already prevents the band.
     *
     * What IS assertable, and what the type filter alone buys, is that a task never enters the
     * candidate set — so the phase's own counts describe the memory corpus, and a future weight or
     * half-life change cannot quietly make tasks evictable. Mutation-verified on `counts.scored`.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pass = yield* runRetentionPass(fixture.db, instantFor(DATE).at)
          const scored = pass.scored.find((entry) => entry.row.path === FORGOTTEN)
          expect(scored, "the task is in the scored corpus at all").toBeDefined()
          // The recency pin, stated where a reader of this test would otherwise wonder.
          expect(scored?.score.signals.recency).toBe(1)
          expect(scored?.score.score).toBeGreaterThan(EVICT_THRESHOLD)

          const before = yield* atHead(fixture, FORGOTTEN)
          const outcome = yield* retentionTriage(envFor(fixture))

          expect(yield* atHead(fixture, FORGOTTEN)).toBe(before)
          expect(
            yield* atHead(fixture, `archive/2026/${FORGOTTEN}`),
            "the task was archived"
          ).toBeUndefined()

          // The load-bearing assertion: the tasks are not among the rows this phase banded.
          const memories = pass.scored.filter((entry) => entry.row.memory_type !== "task")
          expect(outcome.counts.scored).toBe(memories.length)
          expect(memories.length).toBeLessThan(pass.scored.length)
        }),
      { seed: SEED, model: inertModel() }
    )
  })
})

describe("person-links", () => {
  it("mints no person file from a task's person: entity, and links no task", async () => {
    /**
     * `t-ask-imani` carries `person:imani` and no memory does — so without the exclusion this phase
     * would create `resources/people/imani.html`, the durable hand-edited identity surface, out of a
     * to-do item, and stamp `memhtml-about-person` into the task file.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, ASK_IMANI)
          const outcome = yield* personLinks(envFor(fixture))

          expect(yield* atHead(fixture, ASK_IMANI)).toBe(before)
          expect(yield* atHead(fixture, "resources/people/imani.html")).toBeUndefined()
          // No person reached the phase at all: the memory corpus names none.
          expect(outcome.counts.people).toBe(0)
          expect(outcome.counts.filesCreated).toBe(0)
          expect(outcome.commitSha).toBeNull()
        }),
      { seed: SEED, model: inertModel() }
    )
  })
})

describe("entity-resolution", () => {
  it("does not normalize a task's mixed-case entity meta", async () => {
    // `t-ask-imani` carries `Service:Checkout-API`, which pass one of this phase would lowercase —
    // a nightly job editing live working state, and a rewrite of the task's own bytes.
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, ASK_IMANI)
          expect(before).toContain("Service:Checkout-API")

          yield* entityResolution(envFor(fixture))

          const after = yield* atHead(fixture, ASK_IMANI)
          expect(after).toBe(before)
          expect(after).toContain("Service:Checkout-API")
        }),
      { seed: SEED, model: inertModel() }
    )
  })
})

describe("compress", () => {
  it("cannot reach a task, because a task can never join a community", async () => {
    /**
     * This exclusion is UNREACHABLE by construction, and mutation proved it: removing the filter
     * from `compress.ts` leaves this test green. The reason is worth stating rather than hiding
     * behind a filter nobody can trip.
     *
     * `compress` requires `entry.community !== undefined`, and communities come from
     * `labelPropagation` over `memoryEdges`, which filters `edge_class = 'memory'`. A task cannot
     * carry a memory-class edge — the store refuses one and the `edges` CHECK refuses the rel
     * outside its class — so every task is an isolated node, every task's community is a singleton,
     * and a singleton is below `MIN_COMMUNITY_SIZE` and collapses to `undefined`.
     *
     * So the assertion is on the MECHANISM, and the fixture seeds REAL task-class edges among the
     * tasks first — otherwise "no community" would hold because the tasks have no edges at all, and
     * the `edge_class = 'memory'` filter in `memoryEdges` would go untested. With the edges present,
     * dropping that filter makes the tasks form a community and this test goes red.
     */
    const model = scriptedModel(() =>
      value({ title: "Folded", claim: "A folded claim.", paragraphs: [], absorbedKeys: [] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * A connected triangle of task-class edges, which is `MIN_COMMUNITY_SIZE` — so these three
           * tasks WOULD be a community if task edges reached the graph math.
           */
          const chain: ReadonlyArray<readonly [string, string, string]> = [
            [FORGOTTEN, "blocks", ASK_IMANI],
            [ASK_IMANI, "blocks", "areas/inbox/tasks/t-drain-runbook.html"],
            ["areas/inbox/tasks/t-drain-runbook.html", "subtask_of", FORGOTTEN]
          ]
          for (const [src, rel, dst] of chain) {
            yield* fixture.db
              .run(
                `INSERT INTO edges (src_path, rel, dst_path, edge_class, created_at)
                 VALUES (?, ?, ?, 'task', ?)`,
                [src, rel, dst, instantFor(DATE).at]
              )
              .pipe(Effect.orDie)
          }

          const pass = yield* runRetentionPass(fixture.db, instantFor(DATE).at)
          const tasks = pass.scored.filter((entry) => entry.row.memory_type === "task")
          expect(tasks.length).toBe(TASK_CORPUS.length)
          for (const task of tasks) {
            expect(task.community, `${task.row.path} joined a community`).toBeUndefined()
          }

          yield* compress(envFor(fixture))
          for (const call of model.calls) {
            expect(call.prompt).not.toContain("staging bastion port")
            expect(call.prompt).not.toContain("Ask Imani")
          }
        }),
      { seed: SEED, model }
    )
  })
})

describe("arc-synthesis", () => {
  it("offers no task as evidence, so an arc rests on outcomes and not intentions", async () => {
    /**
     * An arc is a claim about how the agent BEHAVES, drawn from what it has learned. Asserted on the
     * triage PROMPT, because the phase then stamps `memhtml-part-of` onto each supporting file — which
     * for a task would be a memory-class edge into the graph the task class exists to stay out of.
     */
    const model = scriptedModel(() => value({ entries: [] }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* arcSynthesis(envFor(fixture))
          expect(model.calls.length).toBeGreaterThan(0)
          for (const call of model.calls) {
            expect(call.prompt).not.toContain("staging bastion port")
            expect(call.prompt).not.toContain("Imani owns the search relevance surface")
            expect(call.prompt).not.toContain("deploy runbook needs a review")
          }
        }),
      { seed: SEED, model }
    )
  })
})

describe("the candidate scans themselves", () => {
  it("returns no pair with a task endpoint, from either scan", async () => {
    /**
     * The two SQL holes, directly. `neighborPairs` feeds dedup-merge and relationship-mining and
     * `conflictCandidates` feeds conflict detection; both scans are where a task would enter, and
     * both are asserted at a floor low enough that the near-duplicate task pair WOULD clear it.
     */
    const outcome = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const withoutTasks = yield* neighborPairs(fixture.db, {
            floor: 0.5,
            perSourceK: 10,
            limit: 500,
            excludeTypes: ["task"]
          })
          const withTasks = yield* neighborPairs(fixture.db, {
            floor: 0.5,
            perSourceK: 10,
            limit: 500
          })
          const conflicts = yield* conflictCandidates(fixture.db, {
            floor: 0.5,
            perSourceK: 10,
            limit: 500,
            excludeTypes: ["task"]
          })
          return { withoutTasks, withTasks, conflicts }
        }),
      { seed: SEED, model: inertModel() }
    )

    const namesTask = (pair: { src: string; dst: string }) =>
      pair.src.includes("/tasks/") || pair.dst.includes("/tasks/")

    // The hole works…
    expect(outcome.withoutTasks.filter(namesTask)).toEqual([])
    expect(outcome.conflicts.filter(namesTask)).toEqual([])
    // …and it is doing something: without it, the same scan DOES return task pairs. Without this
    // half the assertions above would hold on a corpus whose tasks were simply too dissimilar.
    expect(outcome.withTasks.filter(namesTask).length).toBeGreaterThan(0)
  })
})

describe("conflict-detection", () => {
  it("judges no pair involving a task, so no model call is spent on one", async () => {
    // "These two contradict" is a judgment about asserted facts. A task asserts nothing, so the
    // question has no true answer — and a promoted `contradicts` would be a memory-class edge
    // written into two task files.
    const model = scriptedModel(() =>
      value({ verdict: "contradicts", confidence: 0.99, rationale: "scripted" })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* conflictDetection(envFor(fixture))
          for (const call of model.calls) {
            expect(call.prompt).not.toContain("staging bastion port")
            expect(call.prompt).not.toContain("deploy runbook needs a review")
            expect(call.prompt).not.toContain("rollback runbook omits the VIP drain")
          }
        }),
      { seed: SEED, model }
    )
  })
})
