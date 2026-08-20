import { NEAR_DUPLICATE_THRESHOLD } from "@memhtml/domain"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import {
  DEDUP_BATCH_MEMBERS,
  DEDUP_COMPONENT_FLOOR,
  DEDUP_DETECTOR,
  DEDUP_MAX_COMPONENT,
  dedupMerge,
  dedupPackSliced
} from "../src/phases/dedup-merge.js"
import { instantFor } from "../src/run.js"
import { type ScriptedModel, scriptedModel, value, violation } from "../src/testing.js"
import { DEDUP_CORPUS, type Fixture, memoryHtml, type SeedFile, withFixture } from "./fixture.js"

/**
 * dedup-merge's `review:` minting arm: the vetoed near-duplicate becomes a task a human decides.
 *
 * **A separate file from `tests/dedup.test.ts` on purpose.** That file's `describe("dedup-merge")` block
 * is the ORACLE for the deterministic arm — every case in it predates the model path and asserts the
 * folds plus the veto's SILENCE — and this arm's whole subject is what the phase now writes alongside
 * those folds. Mixing them would put a new counts key into assertions whose entire value is that they
 * have not changed.
 *
 * **The positive fixture is `DEDUP_CORPUS` itself, unchanged.** Its negation flip measures 0.9898 — above
 * `NEAR_DUPLICATE_THRESHOLD`, so the cosine says one claim, and negation-divergent, so the veto refuses
 * it. That is exactly the finding this arm exists to file, and it has been in the corpus since before the
 * arm did: the pair whose veto every existing test asserts as an absence is the pair that now produces a
 * task. Nothing about the positive case is constructed for it.
 *
 * Three of the nine cases are NEGATIVES — a pair the both-roles guard excluded, a true veto below the
 * merge floor, a night that truncated — and a negative over a corpus with nothing to refuse is the
 * vacuous-lock the metarepo's narrator lesson names. So each seeds the input that WOULD have minted and
 * asserts the flip's own task in the same case, which is what makes "minted nothing extra" checkable
 * rather than "the arm was never reached".
 *
 * Every cosine named below is MEASURED under the deterministic embedder against the article text the
 * chunker embeds (`claim + " " + body`, whitespace-collapsed), 2026-08-20.
 */

const DATE = "2026-08-02"

/** `DEDUP_CORPUS`'s flip pair: the true veto at 0.9898 that this arm files a task about. */
const SAFE = "areas/deploy/blue-green-is-safe.html"
const NOT_SAFE = "areas/deploy/blue-green-is-not-safe.html"

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
 * A path's bytes at HEAD, or `undefined`.
 *
 * Through the store's own `run` and NOT through `fixture.raw`, which is `orDie`: a missing path would
 * become a DEFECT `orElseSucceed` cannot catch, so the test would crash where it means to observe an
 * absence — which is half of what a closure assertion is. The same reasoning `dedup.test.ts` records.
 */
const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/** Every task file under the inbox at HEAD, sorted. What the mint arm wrote, read off the tree. */
const mintedTasks = (fixture: Fixture): Effect.Effect<ReadonlyArray<string>> =>
  fixture.deps.git.run(["ls-tree", "-r", "--name-only", "HEAD", "areas/inbox/tasks/"]).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>)
  )

/** The parsed doc of a file at HEAD. Warnings, metas, and citations all come off this one parse. */
const docAt = (fixture: Fixture, path: string) =>
  Effect.gen(function* () {
    const html = yield* atHead(fixture, path)
    return yield* parseMemory(html ?? "").pipe(Effect.orDie)
  })

/** A model that groups whichever offered members match a needle. The dedup house helper. */
const partitionsBy = (
  choose: (prompt: string) => ReadonlyArray<ReadonlyArray<string>>
): ScriptedModel =>
  scriptedModel((request) =>
    value({ groups: choose(request.prompt).map((keys) => ({ memberKeys: keys })) })
  )

/** A model that groups nothing. `groups: []` is a valid answer, and the safe one. */
const refusesEveryGroup = (): ScriptedModel => partitionsBy(() => [])

const keysMatching = (prompt: string, needles: ReadonlyArray<string>): Array<string> => {
  const found: Array<string> = []
  for (const match of prompt.matchAll(/<member_(m\d+)>\n([\s\S]*?)\n<\/member_\1>/g)) {
    const key = match[1] ?? ""
    const text = match[2] ?? ""
    if (needles.some((needle) => text.includes(needle))) found.push(key)
  }
  return found
}

/**
 * THREE clean restatements of one fact, every pair above the merge floor and NOT ONE of them vetoed.
 *
 * This is the both-roles residual, isolated. The guard fixes a path's role for the batch, so the first
 * pair folds and the second is refused — and `vetoed`, being `proposed.length - decisions.length`, counts
 * that refusal identically to a real divergence. A phase minting off the residual therefore files a task
 * about a pair whose only problem is that its keeper was already claimed, which needs no human at all
 * and which tomorrow's run simply merges against a keeper that now carries the absorbed content.
 *
 * **Measured 2026-08-20:**
 *
 * | pair | cosine | veto |
 * |---|---|---|
 * | `a` ↔ `b` | 0.9531 | none — above 0.92, so it FOLDS |
 * | `a` ↔ `c` | 0.9495 | none — above 0.92, and REFUSED on the shared keeper |
 * | `b` ↔ `c` | 0.9184 | none — inside the recall band, so mined as an edge and never folded |
 * | any member vs any {@link DEDUP_CORPUS} member | ≤ 0.6198 | no cross-topic edge |
 *
 * No body carries a negation marker, a number, or a variant qualifier, so `mergeVetoed` is false for all
 * three pairs — measured, not intended, because a masked marker would make the whole fixture assert the
 * opposite of what it claims (the window `DEDUP_CORPUS`'s flip note warns about).
 *
 * `createdAt` orders them, so `a` is the keeper and the refused pair is identifiable.
 */
const ROLE_TRIPLE: ReadonlyArray<SeedFile> = [
  {
    path: "areas/ledger/reconciler-flushes-before-close.html",
    html: memoryHtml({
      title: "The reconciler flushes before the daily close",
      claim:
        "The ledger reconciler flushes its pending batch to the warehouse before the daily close.",
      body: "Pending rows leave the staging table so the warehouse holds a settled batch when the daily close runs.",
      memoryType: "semantic",
      createdAt: "2026-03-01T00:00:00Z",
      confidence: "0.88",
      tags: ["ledger"]
    })
  },
  {
    path: "areas/ledger/before-close-the-batch-flushes.html",
    html: memoryHtml({
      title: "Before the daily close the batch flushes",
      claim:
        "Before the daily close the ledger reconciler flushes its pending batch to the warehouse.",
      body: "The staging table empties its pending rows and the warehouse holds a settled batch as the daily close runs.",
      memoryType: "semantic",
      createdAt: "2026-03-02T00:00:00Z",
      confidence: "0.88",
      tags: ["ledger"]
    })
  },
  {
    path: "areas/ledger/pending-batch-reaches-the-warehouse.html",
    html: memoryHtml({
      title: "The pending batch reaches the warehouse",
      claim:
        "The pending batch of the ledger reconciler is flushed to the warehouse before the daily close.",
      body: "Rows pending in the staging table leave, so as the daily close runs the warehouse holds a settled batch.",
      memoryType: "semantic",
      createdAt: "2026-03-03T00:00:00Z",
      confidence: "0.88",
      tags: ["ledger"]
    })
  }
]

const ROLE_KEEP_PATH = "areas/ledger/reconciler-flushes-before-close.html"
const ROLE_FOLDED_PATH = "areas/ledger/before-close-the-batch-flushes.html"
const ROLE_REFUSED_PATH = "areas/ledger/pending-batch-reaches-the-warehouse.html"

/**
 * A TRUE veto whose cosine sits INSIDE the recall band: 0.9127, above `DEDUP_COMPONENT_FLOOR` 0.86 and
 * below `NEAR_DUPLICATE_THRESHOLD` 0.92.
 *
 * The similarity gate's own fixture, and it has to reach `proposed` to test the gate at all. A band pair
 * the model DECLINES never gets there — the mined arm's own filter is `> 0.92` — so this fixture is only
 * a probe when the model GROUPS it, which is what the case below scripts. Then the pair is in the
 * proposal list, `mergeVetoed` answers true, and the ONLY thing that can decline the mint is the
 * threshold.
 *
 * **Measured 2026-08-20:** the two members 0.9127, negation-divergent; versus any {@link DEDUP_CORPUS}
 * member ≤ 0.5483, so it is its own component and adds no cross-topic edge.
 */
const VETO_BAND_PAIR: ReadonlyArray<SeedFile> = [
  {
    path: "areas/tracing/spans-reach-the-aggregator.html",
    html: memoryHtml({
      title: "Sandboxed spans reach the aggregator",
      claim: "The trace collector forwards sandboxed spans to the aggregator on every flush tick.",
      body: "Forwarded spans carry their sandbox label so the aggregator attributes them to the originating session cleanly.",
      memoryType: "semantic",
      createdAt: "2026-02-01T00:00:00Z",
      confidence: "0.80",
      tags: ["tracing"]
    })
  },
  {
    path: "areas/tracing/spans-stay-local.html",
    html: memoryHtml({
      title: "Sandboxed spans stay local",
      claim:
        "Sandboxed spans are not forwarded to the aggregator by the trace collector on a flush tick.",
      body: "Held spans carry their sandbox label so the aggregator attributes nothing to the originating session cleanly.",
      memoryType: "semantic",
      createdAt: "2026-02-02T00:00:00Z",
      confidence: "0.80",
      tags: ["tracing"]
    })
  }
]

const BAND_A_PATH = "areas/tracing/spans-reach-the-aggregator.html"
const BAND_B_PATH = "areas/tracing/spans-stay-local.html"

/**
 * THREE mutually-vetoed memories, so one night holds three DISTINCT findings whose templated claims all
 * overlap heavily.
 *
 * The fixture for the coordinator's `restatementDedup` amendment, and it is the only shape that can
 * observe it. The kernel's claim-Jaccard arm is opt-in precisely because a pair detector's claims differ
 * only in their slot values, and three pairs over three files share two basenames out of three:
 *
 * | claims compared | Jaccard | consequence with the arm ON |
 * |---|---|---|
 * | `pos↔neg` vs `pos↔var` | 0.8462 | second finding suppressed as a "restatement" |
 * | `pos↔neg` vs `neg↔var` | 0.9231 | third suppressed too |
 * | `pos↔var` vs `neg↔var` | 0.9231 | — |
 *
 * All three sit far above `CLAIM_JACCARD_FLOOR` 0.6, so with the arm on the night files ONE task instead
 * of three and reports `taskDeduped: 2` — two real divergences a human never sees, forever.
 *
 * **Measured cosines and vetoes 2026-08-20**, and every pair clears 0.92 so the gate is not what is
 * being tested:
 *
 * | pair | cosine | veto |
 * |---|---|---|
 * | `pos` ↔ `neg` | 0.9506 | negation |
 * | `pos` ↔ `var` | 0.9917 | variant-qualifier (`preview`) |
 * | `neg` ↔ `var` | 0.9427 | negation AND variant-qualifier |
 *
 * Versus any {@link DEDUP_CORPUS} member ≤ 0.5348, so it is its own component. The both-roles guard
 * still confines the FOLDS, but no fold is possible here at all: all three pairs are vetoed, which is
 * what makes all three reach the mint arm together.
 */
const VETO_TRIPLE: ReadonlyArray<SeedFile> = [
  {
    path: "areas/retention/reprieves-are-pruned.html",
    html: memoryHtml({
      title: "Expired reprieves are pruned each Sunday",
      claim: "The retention sweeper prunes expired reprieves from the ledger each Sunday evening.",
      body: "Pruned entries free their slot in the retention ledger and the sweeper writes a summary of the weekly prune afterwards.",
      memoryType: "semantic",
      createdAt: "2026-01-01T00:00:00Z",
      confidence: "0.85",
      tags: ["retention"]
    })
  },
  {
    path: "areas/retention/reprieves-are-not-pruned.html",
    html: memoryHtml({
      title: "Expired reprieves are not pruned",
      claim:
        "Expired reprieves are not pruned from the ledger by the retention sweeper each Sunday evening.",
      body: "Entries retain their slot in the retention ledger and the sweeper writes a summary of the weekly prune afterwards.",
      memoryType: "semantic",
      createdAt: "2026-01-02T00:00:00Z",
      confidence: "0.85",
      tags: ["retention"]
    })
  },
  {
    path: "areas/retention/preview-reprieves-are-pruned.html",
    html: memoryHtml({
      title: "Expired preview reprieves are pruned each Sunday",
      claim:
        "The retention sweeper prunes expired preview reprieves from the ledger each Sunday evening.",
      body: "Pruned entries free their slot in the retention ledger and the sweeper writes a summary of the weekly prune afterwards.",
      memoryType: "semantic",
      createdAt: "2026-01-03T00:00:00Z",
      confidence: "0.85",
      tags: ["retention"]
    })
  }
]

/**
 * A PREVIOUS night's `review:` task, seeded exactly as the mint arm would have left it.
 *
 * Its finding key names a pair no corpus in this file holds, so it is absent from every night's
 * `presentKeys` and the ONLY thing deciding its fate is the attestation. The digest is a literal rather
 * than a `findingKeyOf` call, so a change to the hashing surfaces as a failure here instead of as a test
 * that silently agrees with itself.
 */
const STALE_TASK_PATH = "areas/inbox/tasks/t-review-a-vanished-pair.html"

const STALE_TASK: SeedFile = {
  path: STALE_TASK_PATH,
  html: memoryHtml({
    title: "review: gone-a.html and gone-b.html are near-duplicates vetoed for divergence",
    claim: "review: gone-a.html and gone-b.html are near-duplicates vetoed for divergence",
    memoryType: "task",
    taskStatus: "todo",
    findingKey: `${DEDUP_DETECTOR}:00112233445566aa`,
    createdAt: "2026-07-01T00:00:00Z",
    tags: ["detected"]
  })
}

/**
 * A frame-key family of {@link TRUNCATING_FAMILY_SIZE} memories: one component larger than
 * {@link DEDUP_MAX_COMPONENT}, so the night really TRUNCATES.
 *
 * The two truncation clauses of the attestation cannot be observed with the file's other corpora,
 * because none of them builds a component past 8, and a clause whose input never varies is a clause a
 * mutation cannot break. This one does, and it reaches the component graph through the FRAME SEED arm
 * rather than through the cosine: every claim states the same slot — `the default retry budget of the
 * importer is` — so `frameKeyPairs` emits an edge for every pair and the component is the whole family
 * whatever the embedder says. (Measured 2026-08-20 anyway: intra-family cosine is 0.9730 for every pair,
 * so the mined arm would find them too.)
 *
 * Deliberately **not vetoed and not mergeable-in-one-night**. No body carries a negation marker or a
 * variant qualifier, and every body is token-identical, so `mergeVetoed` is false for all 36 pairs —
 * measured, not intended. The value tokens are spelled-out words rather than digits for the same reason:
 * `numericTokenDivergent` would fire on every pair and the family would mint 36 `review:` tasks, which is
 * a different behavior from the one under test.
 *
 * So the family's ONLY effect on the night is on the attestation, which is what makes the two cases below
 * about the attestation and nothing else.
 */
const TRUNCATING_FAMILY_SIZE = 9

const TRUNCATING_FAMILY: ReadonlyArray<SeedFile> = [
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen"
].map((word, offset) => ({
  path: `areas/importer/retry-budget-${word}.html`,
  html: memoryHtml({
    title: `The importer's default retry budget is ${word}`,
    claim: `The default retry budget of the importer is ${word}.`,
    body: "Operators tuning the importer read this budget from the shipped configuration file.",
    memoryType: "semantic",
    createdAt: `2026-04-${String(offset + 10).padStart(2, "0")}T00:00:00Z`,
    confidence: "0.80",
    tags: ["importer"]
  })
}))

describe("dedup-merge's truncation attestation is computed from PRE-pack inputs", () => {
  it("withholds closure on a night whose component EXCEEDED the member cap", async () => {
    /**
     * The `memberTruncated` clause, at a corpus that actually trips it. {@link TRUNCATING_FAMILY} is one
     * frame-key component of nine, cut to its lowest {@link DEDUP_MAX_COMPONENT} paths, so the ninth
     * member's pairs were never put in front of the veto — and closing an open `review:` task on that
     * silence would archive a divergence still on disk.
     *
     * **The clause has to read the PRE-pack component, and this case is what makes that checkable.** Both
     * truncation clauses used to inspect `components`, which is `graph.slice(...).map(members =>
     * members.slice(0, DEDUP_MAX_COMPONENT))` — already truncated — so `memberTruncated` asked whether the
     * OUTPUT length reached the cap. Two consequences followed and both are wrong in the same direction as
     * each other and opposite in effect: a component of exactly 8 was nothing to truncate and reported
     * `>= 8` as truncation, withholding closure forever; and the comparison could no longer distinguish
     * that from the real case. The clause now compares the PRE-truncation length against the cap with a
     * strict `>`, so truncation means the input EXCEEDED the cap.
     *
     * (Mutation: reverting `memberTruncated` to `components.some((m) => m.length >= DEDUP_MAX_COMPONENT)`
     * keeps this case green and makes the exactly-at-cap case below fail; reverting it to a post-slice
     * `> DEDUP_MAX_COMPONENT` makes THIS case fail with `taskClosed: 1`, because no post-slice component
     * can exceed the cap.)
     */
    expect(TRUNCATING_FAMILY_SIZE).toBeGreaterThan(DEDUP_MAX_COMPONENT)

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          /** Non-vacuous: the component really was built, and really was cut to the cap. */
          expect(outcome.counts.components).toBe(1)
          expect(outcome.counts.skipped).toBe(0)

          expect(outcome.counts.closureSkipped).toBe(1)
          expect(outcome.counts.taskClosed).toBeUndefined()
          expect(yield* atHead(fixture, STALE_TASK_PATH)).toBeDefined()
        }),
      { seed: [...TRUNCATING_FAMILY, STALE_TASK], model: refusesEveryGroup() }
    )
  })

  it("CLOSES on a night whose component sat EXACTLY at the member cap", async () => {
    /**
     * The off-by-one, isolated. A component of exactly {@link DEDUP_MAX_COMPONENT} lost nothing —
     * `members.slice(0, 8)` of eight members is those eight members — so the night DID look everywhere
     * and its silence about an absent finding is evidence. Under the old `>=` on the post-slice length
     * this component reported truncation, so any corpus holding one withheld closure permanently and the
     * `review:` backlog could never be emptied.
     *
     * The same family minus one member, so what differs between this case and the one above is one file.
     *
     * (Mutation: `>=` in place of `>` makes this `closureSkipped: 1` and leaves the stale task in place.)
     */
    const atCap = TRUNCATING_FAMILY.slice(0, DEDUP_MAX_COMPONENT)
    expect(atCap).toHaveLength(DEDUP_MAX_COMPONENT)

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          /** Non-vacuous: one component of exactly the cap, and the model really was called. */
          expect(outcome.counts.components).toBe(1)
          expect(outcome.llmCalls).toBeGreaterThan(0)
          expect(outcome.counts.skipped).toBe(0)

          expect(outcome.counts.taskClosed).toBe(1)
          expect(outcome.counts.closureSkipped).toBeUndefined()
          expect(yield* atHead(fixture, STALE_TASK_PATH)).toBeUndefined()
        }),
      { seed: [...atCap, STALE_TASK], model: refusesEveryGroup() }
    )
  })

  it("withholds closure when a component EXCEEDS the batch member cap, over a lowered cap", async () => {
    /**
     * The `packSliced` clause, which was STRUCTURALLY VACUOUS and is the finding this case exists for.
     *
     * `packGroups` slices any group longer than `maxMembers` before it returns (`batch.ts:145-181`), so
     * inspecting its OUTPUT for a group longer than {@link DEDUP_BATCH_MEMBERS} asks whether a function
     * that guarantees `<= maxMembers` returned something larger. It cannot, so the clause could never
     * fire — not "does not fire on this corpus", but cannot fire on any corpus, which is the difference
     * between an untested clause and one that is not a clause at all. It now reads the PRE-pack component
     * lengths, where a slice is a real possibility.
     *
     * Driven through {@link dedupPackSliced} with the cap passed explicitly rather than through a corpus
     * of 41 memories: what the clause asserts is a property of the two numbers, the real constants make
     * `DEDUP_MAX_COMPONENT` (8) bind long before `DEDUP_BATCH_MEMBERS` (40) so no corpus can reach it
     * while that ordering holds, and a fixture of 41 near-duplicates would be forty times the seed cost to
     * assert the same arithmetic. The phase's own wiring is asserted separately: the constant-ordering
     * case below proves this clause is unreachable TODAY and says why it is checked anyway.
     */
    const lengths = (...counts: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<unknown>> =>
      counts.map((count) => new Array<unknown>(count).fill(0))

    /** EXCEEDING the cap is a slice, so the night asked each half in ignorance of the other. */
    expect(dedupPackSliced(lengths(5), 4)).toBe(true)
    /** Exactly at the cap is one whole call: nothing was split, so nothing was hidden. */
    expect(dedupPackSliced(lengths(4), 4)).toBe(false)
    expect(dedupPackSliced(lengths(1, 4, 2), 4)).toBe(false)
    /** ONE oversized component among many is enough, and the empty night is complete. */
    expect(dedupPackSliced(lengths(2, 9, 3), 4)).toBe(true)
    expect(dedupPackSliced([], 4)).toBe(false)
  })

  it("is unreachable while the component cap is the smaller number, and is checked anyway", () => {
    /**
     * Why the `packSliced` clause survives despite having no reachable corpus: the two caps are
     * INDEPENDENT constants and either may move. Today {@link DEDUP_MAX_COMPONENT} cuts every component
     * to 8 before packing, so no component can exceed {@link DEDUP_BATCH_MEMBERS}'s 40 and the clause is
     * dead code — pinned here so raising the component cap past the batch cap fails this line rather than
     * silently making an attestation clause live and untested.
     */
    expect(DEDUP_MAX_COMPONENT).toBeLessThanOrEqual(DEDUP_BATCH_MEMBERS)
  })
})

describe("dedup-merge refuses to mint a task with no evidence in it", () => {
  /**
   * Empty `body_text` on ONE side of the pair, written straight into the projection.
   *
   * **A SQL write rather than a fixture file, and the reason is a measurement: no valid memory can
   * produce an empty `body_text`.** `parseMemory` refuses a file with no `<mark>` and refuses one whose
   * `<mark>` is empty after the code exclusion (`no <mark>: the claim span is required` / `empty <mark>`,
   * probed 2026-08-20), and `article.bodyText` is `textContent(article)` with code INCLUDED — so it always
   * carries at least the claim, and a corpus row with an empty one is by construction a projection
   * anomaly rather than an authorable file. Seeding one as HTML is therefore not possible, and a test that
   * tried would be asserting the parser's refusal instead of the phase's guard.
   *
   * `UPDATE files SET body_text` is exactly that anomaly and nothing more. It is safe to write here:
   * `files_fts_update` fires `AFTER UPDATE OF fts_text` (`0003_fts.sql:37`) so the lexical index is
   * untouched, and the vectors live in `chunks`/`embeddings` keyed on path, so the pair still MINES at its
   * measured cosine. What changes is only the string a quote would be cut from.
   */
  const blankBodyText = (fixture: Fixture, path: string) =>
    fixture.db.run("UPDATE files SET body_text = '' WHERE path = ?", [path]).pipe(Effect.orDie)

  it("counts emptyEvidence and mints NOTHING when one side has no quotable text", async () => {
    /**
     * The guard `edge-typing` has carried since the mint arm landed (`edge-typing.ts:878-881`), ported.
     *
     * **An empty quote is `includes`-true against anything**, so a task minted with one is unverifiable by
     * the two mechanisms that exist to verify it: doctor's stale-quote check would report it as present
     * forever whatever the file said, and an `<q></q>` never even reaches `article.citations` (probed —
     * `readCitations` drops an element whose text is empty), so the task would carry ONE citation where
     * the closer and the reviewer both expect two. A finding a human cannot check is worse than no
     * finding, so the pair is skipped whole rather than filed with half its evidence.
     *
     * Counted rather than dropped in silence, because "the night found a divergence and refused to file
     * it" is a fact about the corpus's projection that an operator has to be able to see — `edge-typing`'s
     * copy of this guard counts nowhere at all and is invisible in its report, which is the half of that
     * phase's behavior this one does not mirror.
     *
     * (Mutation: deleting the `keepQuote === "" || dropQuote === ""` clause makes this `taskMinted: 1`,
     * with a task whose `article.citations` holds ONE href instead of two.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* blankBodyText(fixture, NOT_SAFE)

          const outcome = yield* dedupMerge(envFor(fixture))

          /** Non-vacuous: the veto really did fire, so a finding really was available to refuse. */
          expect(outcome.counts.vetoed).toBe(1)
          expect(outcome.counts.emptyEvidence).toBe(1)
          expect(outcome.counts.taskMinted).toBeUndefined()
          expect(yield* mintedTasks(fixture)).toEqual([])

          /** The FOLDS are unaffected: this refuses one task, not the night. */
          expect(outcome.counts.merged).toBe(2)
          /** And both vetoed files are still live, exactly as they are when the task IS filed. */
          expect(yield* atHead(fixture, SAFE)).toBeDefined()
          expect(yield* atHead(fixture, NOT_SAFE)).toBeDefined()
        }),
      { seed: DEDUP_CORPUS, model: refusesEveryGroup() }
    )
  })

  it("counts nothing on the ordinary night, so the counter is not a constant", async () => {
    /**
     * The other half of the same measurement. Without this, `emptyEvidence: 1` above would also pass
     * against a phase that counted every vetoed pair — the counter has to be ABSENT on the night the
     * same corpus mints, which is the night every other case in this file drives.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.emptyEvidence).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS, model: refusesEveryGroup() }
    )
  })

  it("does not let a refused pair CLOSE a task, since the divergence is still on disk", async () => {
    /**
     * The interaction with the attestation, which is where a silent skip would do real damage. The night
     * looked everywhere — no cap bound, no batch failed — so `universeComplete` is true and the closure
     * pass runs. A pair whose finding was refused for want of evidence is a pair whose task, if one were
     * open, would then be archived on a night that deliberately declined to file it.
     *
     * {@link STALE_TASK} names a pair no corpus here holds, so this asserts the mechanism rather than the
     * one pair: closure is still decided by the attestation, and `emptyEvidence` is a mint-side refusal
     * that does not claim the corpus is clean.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* blankBodyText(fixture, NOT_SAFE)

          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.emptyEvidence).toBe(1)
          /** The night WAS complete, so the absent finding's task closes on its own terms. */
          expect(outcome.counts.taskClosed).toBe(1)
          expect(yield* atHead(fixture, STALE_TASK_PATH)).toBeUndefined()
        }),
      { seed: [...DEDUP_CORPUS, STALE_TASK], model: refusesEveryGroup() }
    )
  })
})

describe("dedup-merge mints review tasks for vetoed near-duplicates", () => {
  it("files ONE task quoting both sides, naming the negation veto and the cosine", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.taskMinted).toBe(1)
          /** The folds still happen in the SAME commit, so the arm is additive rather than a fork. */
          expect(outcome.counts.merged).toBe(2)
          expect(outcome.counts.vetoed).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

          const tasks = yield* mintedTasks(fixture)
          expect(tasks).toHaveLength(1)
          const taskPath = tasks[0] ?? ""

          const doc = yield* docAt(fixture, taskPath)
          /**
           * NO WARNINGS, which is the `<blockquote>` guard in its observable form: `blockquote` sits
           * outside `KNOWN_ELEMENTS`, so a body built with one would carry `<blockquote> is outside the
           * closed vocabulary` here for the life of the file.
           */
          expect(doc.warnings).toEqual([])
          expect(doc.metas.memoryType).toBe("task")
          expect(doc.metas.taskStatus).toBe("todo")
          expect(doc.metas.author).toBe("agent:sleep")
          expect(doc.metas.findingKey?.startsWith(`${DEDUP_DETECTOR}:`)).toBe(true)
          expect(doc.tags).toEqual(["detected"])
          expect(doc.article.gist).toBe(
            "review: blue-green-is-safe.html and blue-green-is-not-safe.html are near-duplicates vetoed for divergence"
          )

          /**
           * TWO citations, one per side, each carrying its own path. THE assertion the element choice
           * exists for: a `<blockquote>` version leaves this list EMPTY while every other assertion in
           * this case still passes, and `article.citations` is what doctor's stale-quote check reads and
           * what fills `file_citations`.
           */
          expect(doc.article.citations).toHaveLength(2)
          expect(doc.article.citations.map((citation) => citation.href)).toEqual([
            `/${SAFE}`,
            `/${NOT_SAFE}`
          ])

          /**
           * And each quote is VERIFIABLE, by the containment doctor computes: the quoted run appears in
           * the cited file's own `bodyText`.
           *
           * This is the case that caught a real bug. The phase's model-facing `textFor` joins
           * `gist + "\n" + body_text`, and `body_text` ALREADY opens with the gist — so a quote cut from
           * `textFor` reads `<gist> <gist> <body>` and is a substring of no file at all. Every task the
           * arm minted would have reported `quote-gone` on the night it was written. The quote comes off
           * `body_text` for exactly this reason.
           */
          for (const citation of doc.article.citations) {
            const cited = yield* docAt(fixture, (citation.href ?? "").slice(1))
            expect(cited.article.bodyText).toContain(citation.text)
          }

          /** The prose line names WHICH predicate fired and the measured cosine. */
          expect(doc.article.bodyText).toContain("negation")
          expect(doc.article.bodyText).toContain("0.9898")

          /** Exactly one `<mark>`, leading — the render gate `articleHtml` makes the caller's. */
          expect((yield* atHead(fixture, taskPath))?.match(/<mark>/g)).toHaveLength(1)

          /** Both vetoed files are STILL LIVE. The mint is a task ABOUT them, not a decision on them. */
          expect(yield* atHead(fixture, SAFE)).toBeDefined()
          expect(yield* atHead(fixture, NOT_SAFE)).toBeDefined()
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-supersedes")
        }),
      { seed: DEDUP_CORPUS, model: refusesEveryGroup() }
    )
  })

  it("mints NOTHING for the pairs the BOTH-ROLES guard excluded, beside a veto that does", async () => {
    /**
     * The residual test, and the reason the arm re-applies `mergeVetoed` rather than reading `vetoed`.
     *
     * {@link ROLE_TRIPLE} contributes two above-floor pairs sharing one keeper: the first folds and the
     * second is refused on the shared role, with NO divergence anywhere in the fixture. So the night's
     * `vetoed` residual is 2 — one role refusal plus `DEDUP_CORPUS`'s real negation — and the true veto
     * count is 1. A phase minting off the residual files two tasks, the second about a pair that needs no
     * human at all.
     *
     * (Mutation: replacing the `mergeVetoed(keepText, dropText)` re-check with `true` makes this
     * `taskMinted: 2` and the second task cites the two ledger files.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          /** The residual really is 2, so the pair the mint declines is genuinely in it. */
          expect(outcome.counts.vetoed).toBe(2)
          expect(outcome.counts.taskMinted).toBe(1)

          const tasks = yield* mintedTasks(fixture)
          expect(tasks).toHaveLength(1)
          /** Named, so the one task is the divergence's and not a role refusal's. */
          expect(
            (yield* docAt(fixture, tasks[0] ?? "")).article.citations.map((one) => one.href)
          ).toEqual([`/${SAFE}`, `/${NOT_SAFE}`])

          /** The triple folded ONE pair, which is what put a role refusal in the residual. */
          expect(yield* atHead(fixture, ROLE_KEEP_PATH)).toContain("memhtml-supersedes")
          expect(yield* atHead(fixture, ROLE_FOLDED_PATH)).toBeUndefined()
          /** And the refused pair's other half is live, unsuperseded, and un-minted-about. */
          expect(yield* atHead(fixture, ROLE_REFUSED_PATH)).toBeDefined()
          expect(yield* atHead(fixture, ROLE_REFUSED_PATH)).not.toContain("memhtml-supersedes")
        }),
      { seed: [...DEDUP_CORPUS, ...ROLE_TRIPLE], model: refusesEveryGroup() }
    )
  })

  it("mints NOTHING for a true veto BELOW the merge floor, beside one above it that does", async () => {
    /**
     * The similarity gate. {@link VETO_BAND_PAIR} measures 0.9127 and IS negation-divergent, so it is a
     * true veto — and the model is scripted to GROUP it, which is the only way a band pair reaches the
     * proposal list at all (the mined arm's own filter is `> 0.92`). So the pair is proposed, the veto
     * refuses the fold, and the ONLY thing that can decline the task is the threshold.
     *
     * Below 0.92 the cosine has not said the two are one claim, and two different facts that disagree
     * about a `not` are the ordinary state of a corpus rather than a morning's decision.
     *
     * (Mutation: lowering the gate to `DEDUP_COMPONENT_FLOOR` makes this `taskMinted: 2`, the second
     * citing the two tracing files.)
     */
    expect(DEDUP_COMPONENT_FLOOR).toBeLessThan(0.9127)
    expect(NEAR_DUPLICATE_THRESHOLD).toBeGreaterThan(0.9127)

    const model = partitionsBy((prompt) => [
      keysMatching(prompt, ["sandboxed spans", "Held spans"])
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          /** The model really did group it, so the pair really was proposed. */
          expect(outcome.counts.llmGroups).toBe(1)
          expect(outcome.counts.taskMinted).toBe(1)

          const tasks = yield* mintedTasks(fixture)
          expect(tasks).toHaveLength(1)
          const doc = yield* docAt(fixture, tasks[0] ?? "")
          /** The task that WAS filed is the above-floor pair's, so the gate cut the right one. */
          expect(doc.article.citations.map((one) => one.href)).toEqual([`/${SAFE}`, `/${NOT_SAFE}`])
          expect(doc.article.bodyText).not.toContain("sandboxed spans")

          /** Both band files are live: below the floor there is no fold and no task. */
          expect(yield* atHead(fixture, BAND_A_PATH)).toBeDefined()
          expect(yield* atHead(fixture, BAND_B_PATH)).toBeDefined()
          expect(yield* atHead(fixture, BAND_A_PATH)).not.toContain("memhtml-supersedes")
        }),
      { seed: [...DEDUP_CORPUS, ...VETO_BAND_PAIR], model }
    )
  })

  it("SKIPS closure on a night whose batch FAILED, while still minting", async () => {
    /**
     * The attestation, at the cap easiest to reach honestly: one isolated batch failure. Those
     * components reached no model, so a group pair the model would have proposed was never proposed —
     * and closing an open `review:` task on that silence would archive a divergence still on disk.
     *
     * The mint still happens in the same run, which is the asymmetry the whole design turns on: minting
     * on an incomplete night ADDS a finding a human can dismiss, and closing on one DESTROYS a work item
     * they may be mid-way through.
     *
     * (Mutation: dropping `skipped === 0` from the conjunction makes this `taskClosed: 1` and
     * {@link STALE_TASK_PATH} disappears from the tree.)
     */
    const model = scriptedModel((_request, offset) =>
      offset === 0 ? violation("scripted bad tool payload") : value({ groups: [] })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.skipped).toBeGreaterThan(0)
          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.closureSkipped).toBe(1)
          expect(outcome.counts.taskClosed).toBeUndefined()
          /** The stale task is still live and still todo. */
          const stale = yield* docAt(fixture, STALE_TASK_PATH)
          expect(stale.metas.taskStatus).toBe("todo")
          expect(yield* atHead(fixture, `archive/2026/${STALE_TASK_PATH}`)).toBeUndefined()
        }),
      { seed: [...DEDUP_CORPUS, STALE_TASK], model }
    )
  })

  it("CLOSES a previously-minted task on a CLEAN night whose pair no longer diverges", async () => {
    /**
     * The other side of the attestation, and the whole point of the finding key. Night one's task is
     * seeded; this night's corpus holds no vetoed pair at all, the model answers cleanly, and no cap
     * binds — so `universeComplete` is true and the finding's absence really is evidence.
     *
     * The corpus is {@link ROLE_TRIPLE} rather than `DEDUP_CORPUS` deliberately: the latter still holds
     * its own negation flip, which would keep a DIFFERENT key present and say nothing about whether the
     * ABSENT one closes. The triple has zero vetoes and one fold, so the night is clean and productive.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.taskMinted).toBeUndefined()
          expect(outcome.counts.skipped).toBe(0)
          expect(outcome.counts.taskClosed).toBe(1)
          expect(outcome.counts.closureSkipped).toBeUndefined()

          /** Archived with the `done` stamp riding the move: `closeTask`'s one-move contract. */
          expect(yield* atHead(fixture, STALE_TASK_PATH)).toBeUndefined()
          const archived = yield* docAt(fixture, `archive/2026/${STALE_TASK_PATH}`)
          expect(archived.metas.taskStatus).toBe("done")
          expect(archived.metas.status).toBe("archived")
          expect(archived.metas.findingKey).toBe(`${DEDUP_DETECTOR}:00112233445566aa`)

          /** One commit for the fold AND the closure, with the counts on its trailer. */
          const message = yield* fixture.raw("log", "-1", "--format=%B")
          expect(message).toContain("sleep(dedup-merge)")
          expect(message).toContain('"taskClosed":1')
        }),
      { seed: [...ROLE_TRIPLE, STALE_TASK], model: refusesEveryGroup() }
    )
  })

  it("MINTS on a no-model night and NEVER closes, though the cosine arm found the veto", async () => {
    /**
     * The credential-free night, and its two halves pull opposite ways deliberately.
     *
     * It MINTS: the flip pair clears 0.92, so the cosine alone proves the finding, and a night with no
     * credentials is the night a reviewer most needs the file to say so.
     *
     * It never CLOSES: the deterministic arm mines at 0.92 and cannot propose a frame seed or a
     * recall-band pair, so its silence about a task the model's arm filed is IGNORANCE rather than
     * evidence. `closureSkipped` says the pass was withheld whole.
     *
     * (Mutation: passing `true` for the no-model arm's `universeComplete` makes this `taskClosed: 1`.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          /** Really the no-model arm: no components were built and no call was made. */
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.components).toBe(0)

          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.closureSkipped).toBe(1)
          expect(outcome.counts.taskClosed).toBeUndefined()
          expect(yield* atHead(fixture, STALE_TASK_PATH)).toBeDefined()

          /** And the task it filed is the real one, with both quotes. */
          const tasks = (yield* mintedTasks(fixture)).filter((path) => path !== STALE_TASK_PATH)
          expect(tasks).toHaveLength(1)
          expect(
            (yield* docAt(fixture, tasks[0] ?? "")).article.citations.map((one) => one.href)
          ).toEqual([`/${SAFE}`, `/${NOT_SAFE}`])
        }),
      { seed: [...DEDUP_CORPUS, STALE_TASK] }
    )
  })

  it("is a FIXED POINT: night two recognizes night one's task by its finding key", async () => {
    /**
     * Idempotency end to end, in ONE fixture so night two reads night one's tree.
     *
     * Without the key the phase files the same `review:` task every night forever — and silently, because
     * `files_content_hash_active` carves tasks out of content dedup on purpose (two open tasks with one
     * body are two real work items). Nothing else in the system would object.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const first = yield* dedupMerge(envFor(fixture))
          expect(first.counts.taskMinted).toBe(1)
          /** Re-index so night two sees the post-merge, post-mint corpus, as the next run would. */
          yield* fixture.reindex()
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          const second = yield* dedupMerge(envFor(fixture))
          expect(second.counts.taskAlreadyOpen).toBe(1)
          expect(second.counts.taskMinted).toBeUndefined()
          expect(second.counts.merged).toBe(0)
          /** THE assertion: night two commits nothing at all. */
          expect(second.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* mintedTasks(fixture)).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS, model: refusesEveryGroup() }
    )
  })

  it("files THREE tasks for three mutually-vetoed files, whose templated claims overlap at 0.85+", async () => {
    /**
     * The `restatementDedup` amendment, asserted. This detector's claims are TEMPLATED, so the kernel's
     * claim-Jaccard arm must stay OFF: {@link VETO_TRIPLE}'s three findings score 0.8462–0.9231 against
     * each other, and the arm would fold the second and third into the first and report `taskDeduped: 2`.
     * Two real divergences a human never sees, with a count as the only trace.
     *
     * Under a template a distinct fingerprint IS a distinct work item, which is the split `mint.ts`'s
     * `CLAIM_JACCARD_FLOOR` records — and this is the corpus that makes the choice observable rather than
     * argued.
     *
     * (Mutation, measured: passing `{ restatementDedup: true }` to `makeMinter` makes this
     * `{ taskMinted: 1, taskDeduped: 2 }` and only ONE task file reaches the tree.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.taskMinted).toBe(3)
          expect(outcome.counts.taskDeduped).toBeUndefined()
          /** All three pairs were proposed and all three were vetoed: no fold was ever possible. */
          expect(outcome.counts.vetoed).toBe(3)
          expect(outcome.counts.merged).toBe(0)

          /** THREE distinct files, and three distinct finding keys. */
          const tasks = yield* mintedTasks(fixture)
          expect(tasks).toHaveLength(3)
          const keys = new Set<string>()
          for (const path of tasks) {
            const doc = yield* docAt(fixture, path)
            expect(doc.warnings).toEqual([])
            /** Each task quotes ITS OWN two files, so the three are about three pairs. */
            expect(doc.article.citations).toHaveLength(2)
            keys.add(doc.metas.findingKey ?? "")
          }
          expect(keys.size).toBe(3)

          /** Every one of the three memories is still live: three findings, zero decisions. */
          for (const file of VETO_TRIPLE) {
            expect(yield* atHead(fixture, file.path)).toBeDefined()
            expect(yield* atHead(fixture, file.path)).not.toContain("memhtml-supersedes")
          }
        }),
      { seed: VETO_TRIPLE, model: refusesEveryGroup() }
    )
  })

  it("counts the mint on a DRY RUN and writes nothing", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* dedupMerge(envFor(fixture, true))

          /** The preview is REAL: an operator sizing a night wants the task count too. */
          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.merged).toBe(2)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
          expect(yield* mintedTasks(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, model: refusesEveryGroup() }
    )
  })
})
