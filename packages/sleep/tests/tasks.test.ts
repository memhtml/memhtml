import { EVICT_THRESHOLD } from "@memhtml/domain"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { arcSynthesis } from "../src/phases/arc-synthesis.js"
import { compress } from "../src/phases/compress.js"
import { edgeTyping } from "../src/phases/edge-typing.js"
import { entityResolution } from "../src/phases/entity-resolution.js"
import { personLinks } from "../src/phases/person-links.js"
import { retentionTriage } from "../src/phases/retention-triage.js"
import { runRetentionPass } from "../src/retention.js"
import { instantFor } from "../src/run.js"
import {
  minedPairs,
  neighborPairs,
  openDetectedTasks,
  sharedEntityPairs,
  taskPathForFindingKey
} from "../src/sql.js"
import { scriptedModel, value } from "../src/testing.js"
import { DEDUP_CORPUS, type Fixture, memoryHtml, TASK_CORPUS, withFixture } from "./fixture.js"

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
      : request.system.startsWith("You partition")
        ? // dedup-merge's partition call. `groups: []` is a refusal, which leaves the phase on its
          // deterministic arm — the same pairs it folds with no model bound at all.
          value({ groups: [] })
        : request.system.startsWith("You type")
          ? value({ verdicts: [] })
          : value({ title: "x", claim: "y", paragraphs: [], absorbedKeys: [] })
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
  it("returns no pair with a task endpoint, from any scan", async () => {
    /**
     * The three SQL holes, directly. `neighborPairs` feeds dedup-merge and relationship-mining, and
     * `sharedEntityPairs` plus `minedPairs` are edge typing's two candidate arms; all three are where
     * a task would enter, and the first two are asserted at a floor low enough that the
     * near-duplicate task pair WOULD clear it.
     *
     * `minedPairs` needs its own arm because it reads the `edges` table rather than the vector space,
     * so the `excludeTypes` hole it carries is a different statement's `NOT IN` and could be missed
     * on its own. Its input is seeded here as a mined edge BETWEEN TWO TASKS, which is what the
     * relationship-mining phase would write if its own hole ever regressed — so this arm holds even
     * against a contaminated index.
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
          const shared = yield* sharedEntityPairs(fixture.db, {
            floor: 0.5,
            perSourceK: 10,
            limit: 500,
            excludeTypes: ["task"]
          })

          yield* fixture.db.run(
            `INSERT INTO edges
               (src_path, rel, dst_path, edge_class, derived, strength, provenance, created_at)
             VALUES (?, 'relates_to', ?, 'memory', 1, 0.99, 'sleep', '2026-08-01T00:00:00Z')`,
            [
              "areas/inbox/tasks/t-runbook-review-a.html",
              "areas/inbox/tasks/t-runbook-review-b.html"
            ]
          )
          const mined = yield* minedPairs(fixture.db, {
            rel: "relates_to",
            excludeTypes: ["task"]
          })
          const minedWithTasks = yield* minedPairs(fixture.db, { rel: "relates_to" })
          return { withoutTasks, withTasks, shared, mined, minedWithTasks }
        }),
      { seed: SEED, model: inertModel() }
    )

    const namesTask = (pair: { src: string; dst: string }) =>
      pair.src.includes("/tasks/") || pair.dst.includes("/tasks/")

    // The holes work…
    expect(outcome.withoutTasks.filter(namesTask)).toEqual([])
    expect(outcome.shared.filter(namesTask)).toEqual([])
    expect(outcome.mined.filter(namesTask)).toEqual([])
    // …and each is doing something: without it, the same scan DOES return task pairs. Without these
    // halves the assertions above would hold on a corpus whose tasks were simply too dissimilar, or
    // on an index that happened to hold no mined edge between two tasks.
    expect(outcome.withTasks.filter(namesTask).length).toBeGreaterThan(0)
    expect(outcome.minedWithTasks.filter(namesTask).length).toBeGreaterThan(0)
  })
})

describe("edge-typing", () => {
  it("types no pair involving a task, so no model call is spent on one", async () => {
    // Every rel in the vocabulary is a judgment about asserted facts. A task asserts nothing, so
    // "these contradict" and "this caused that" have no true answer — and a promoted edge would be a
    // memory-class edge written into two task files.
    const model = scriptedModel(() => value({ verdicts: [] }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping(envFor(fixture))
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

/**
 * The finding-key helpers, which are the READ half of task-detection idempotency.
 *
 * Every other test in this file is about a phase declining to touch a task. These two are the
 * opposite: they are the only queries in the module that go LOOKING for tasks, and they exist because
 * a detected task has no other stable identity. `files_content_hash_active` carves tasks out of
 * content dedup on purpose (two open tasks with identical bodies are two real work items), so nothing
 * would stop a nightly detector from re-filing the same finding every night.
 *
 * The corpus below is built so each condition has something to refuse, and the two `edge` /
 * `edge-typing` rows are the case that separates a correct filter from a plausible one.
 */
const KEY = (detector: string, digest: string) => `${detector}:${digest}`

const OPEN_KEY = KEY("edge", "00112233445566aa")
const DONE_KEY = KEY("edge", "00112233445566bb")
const ARCHIVED_KEY = KEY("edge", "00112233445566cc")
const NEIGHBOR_KEY = KEY("edge-typing", "00112233445566dd")
const OTHER_KEY = KEY("commitment", "00112233445566ee")

const OPEN_PATH = "areas/inbox/tasks/t-key-open.html"
const DONE_PATH = "areas/inbox/tasks/t-key-done.html"
/**
 * Seeded ALREADY UNDER `archive/`, not archived by a later `UPDATE`. The path is the state — eviction
 * IS the `git mv`, and the projection reads `archived` from the PARA bucket rather than from a meta
 * (`packages/index/src/project.ts`) — so seeding it here makes the row archived for EVERY test in this
 * block by the same mechanism production uses, instead of only for the ones that remember to update it.
 */
const ARCHIVED_PATH = "archive/2026/areas/inbox/tasks/t-key-archived.html"
const NEIGHBOR_PATH = "areas/inbox/tasks/t-key-neighbor.html"
const OTHER_PATH = "areas/inbox/tasks/t-key-other.html"

const detectedTask = (title: string, claim: string, findingKey: string, taskStatus: string) =>
  memoryHtml({
    title,
    claim,
    memoryType: "task",
    taskStatus,
    findingKey,
    createdAt: "2026-04-01T00:00:00Z"
  })

const FINDING_KEY_CORPUS: ReadonlyArray<{ readonly path: string; readonly html: string }> = [
  {
    path: OPEN_PATH,
    html: detectedTask(
      "Confirm the staging bastion port",
      "The staging bastion port is unconfirmed.",
      OPEN_KEY,
      "todo"
    )
  },
  {
    // Done but NOT yet archived: the transient between a status edit and its `git mv`, which is the
    // only window where `task_status <> 'done'` does work `archived = 0` has not already done.
    path: DONE_PATH,
    html: detectedTask(
      "Record the deploy runbook owner",
      "The deploy runbook owner is unrecorded.",
      DONE_KEY,
      "done"
    )
  },
  {
    path: ARCHIVED_PATH,
    html: detectedTask(
      "Chase the expired TLS certificate",
      "The staging TLS certificate has expired.",
      ARCHIVED_KEY,
      "todo"
    )
  },
  {
    /**
     * The prefix twin, and the reason the filter is a range rather than a `LIKE`. `edge-typing` starts
     * with `edge`, so `LIKE 'edge%'` would swallow this row into the `edge` detector's results — and
     * the two detectors would each keep re-filing findings the other had already recorded.
     */
    path: NEIGHBOR_PATH,
    html: detectedTask(
      "Type the checkout-to-deploy edge",
      "The checkout and deploy memories have no typed edge between them.",
      NEIGHBOR_KEY,
      "todo"
    )
  },
  {
    path: OTHER_PATH,
    html: detectedTask(
      "Follow up on the capacity commitment",
      "The capacity commitment has no owner.",
      OTHER_KEY,
      "todo"
    )
  }
]

describe("the finding-key helpers", () => {
  it("returns one detector's OPEN tasks and excludes done, archived, and other detectors", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const open = yield* openDetectedTasks(fixture.db, "edge")

          // Exactly the one open `edge` task, with every field the minting kernel reads.
          expect(open).toHaveLength(1)
          expect(open[0]?.path).toBe(OPEN_PATH)
          expect(open[0]?.finding_key).toBe(OPEN_KEY)
          expect(open[0]?.task_status).toBe("todo")
          expect(open[0]?.gist).toBe("The staging bastion port is unconfirmed.")

          /**
           * And each negative is a row that EXISTS and was excluded, not a row the fixture failed to
           * seed. Without this half the assertion above would hold just as well on an empty corpus.
           */
          const seeded = yield* fixture.db.all<{ readonly finding_key: string }>(
            "SELECT finding_key FROM files WHERE finding_key IS NOT NULL ORDER BY finding_key"
          )
          expect(seeded.map((row) => row.finding_key)).toEqual(
            [OPEN_KEY, DONE_KEY, ARCHIVED_KEY, NEIGHBOR_KEY, OTHER_KEY].toSorted()
          )
        }),
      { seed: [...FINDING_KEY_CORPUS] }
    )
  })

  it("does not bleed across a detector whose name is a PREFIX of another", async () => {
    /**
     * The range boundary, in BOTH directions — one direction alone would pass on a filter that is
     * simply too narrow. `edge` must not see `edge-typing`'s task, AND `edge-typing` must see its own.
     *
     * The mechanism: `-` is 0x2D and `:` is 0x3A, so `edge-typing:…` sorts BELOW `edge:`'s lower bound
     * and is outside the bracket entirely.
     *
     * **Verified by mutation, and the honest form of that note matters here.** Dropping the SEPARATOR
     * is what this catches: `finding_key LIKE ? || '%'` fails three cases in this block, because `edge`
     * then matches `edge-typing:…`. Keeping the separator and only changing the FORM —
     * `finding_key LIKE ? || ':%'` — passes every case, because it is genuinely result-equivalent to
     * the range on this data. The range is chosen over that form for the PLAN, not the rows, and the
     * plan is asserted where a plan can be asserted: `files_finding_key_open`'s seek test in
     * `packages/index/tests/migrations.test.ts`. Claiming this test covered the LIKE-vs-range choice
     * would have been the `result-identical-but-wrong` mistake in the note itself.
     *
     * A wrong upper BOUND is caught here too: `< '<d>:'` instead of `< '<d>;'` fails two cases.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const edge = yield* openDetectedTasks(fixture.db, "edge")
          expect(edge.map((row) => row.path)).toEqual([OPEN_PATH])

          const neighbor = yield* openDetectedTasks(fixture.db, "edge-typing")
          expect(neighbor.map((row) => row.path)).toEqual([NEIGHBOR_PATH])

          // A detector with no tasks at all reads as empty rather than as everything.
          expect(yield* openDetectedTasks(fixture.db, "decay")).toEqual([])
        }),
      { seed: [...FINDING_KEY_CORPUS] }
    )
  })

  it("honors an exact key, and excludes the done and archived tasks the range does", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          expect(yield* taskPathForFindingKey(fixture.db, OPEN_KEY)).toBe(OPEN_PATH)
          // The neighbor detector's key resolves to its OWN task, which is the exact-match half of the
          // prefix case: equality needs no range reasoning, and this pins that it gets it right.
          expect(yield* taskPathForFindingKey(fixture.db, NEIGHBOR_KEY)).toBe(NEIGHBOR_PATH)

          /**
           * A done task and an archived one are both ABSENT, which is what makes this lookup mean "is
           * this finding already open work" rather than "has this finding ever been filed". A detector
           * whose task was completed and then re-detected files it again, deliberately: the finding
           * came back, so the work did.
           */
          expect(yield* taskPathForFindingKey(fixture.db, DONE_KEY)).toBeUndefined()
          expect(yield* taskPathForFindingKey(fixture.db, ARCHIVED_KEY)).toBeUndefined()
          // And both rows are really there, so the two assertions above are about the WHERE clause.
          const present = yield* fixture.db.all<{ readonly finding_key: string }>(
            "SELECT finding_key FROM files WHERE finding_key IN (?, ?)",
            [DONE_KEY, ARCHIVED_KEY]
          )
          expect(present).toHaveLength(2)

          // A key nothing carries is undefined, never an empty row.
          expect(
            yield* taskPathForFindingKey(fixture.db, KEY("edge", "ffffffffffffffff"))
          ).toBeUndefined()
        }),
      { seed: [...FINDING_KEY_CORPUS] }
    )
  })

  it("sees no hand-authored memory, since only a detector writes the meta", async () => {
    // The helpers are `memory_type = 'task'`-scoped, matching `files_finding_key_open`'s predicate. A
    // hand-edited semantic memory carrying a key is not work to be re-filed.
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.db.run("UPDATE files SET memory_type = 'semantic' WHERE path = ?", [
            OPEN_PATH
          ])
          expect(yield* openDetectedTasks(fixture.db, "edge")).toEqual([])
          expect(yield* taskPathForFindingKey(fixture.db, OPEN_KEY)).toBeUndefined()
        }),
      { seed: [...FINDING_KEY_CORPUS] }
    )
  })

  it("projects a task with NO finding key as NULL, invisible to both helpers", async () => {
    // The overwhelmingly common case: a hand-filed task has no anchor, and a NULL is outside the
    // partial index and outside every range.
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const row = yield* fixture.db.get<{ readonly finding_key: string | null }>(
            "SELECT finding_key FROM files WHERE path = ?",
            ["areas/inbox/tasks/t-runbook-review-a.html"]
          )
          expect(row?.finding_key).toBeNull()
          expect(yield* openDetectedTasks(fixture.db, "edge")).toEqual([])
        }),
      { seed: [...TASK_CORPUS] }
    )
  })
})
