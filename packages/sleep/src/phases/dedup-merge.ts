import {
  connectedComponents,
  MAX_MERGE_PAIRS,
  type MergeDecision,
  type MergePair,
  mergeCandidates,
  NEAR_DUPLICATE_THRESHOLD,
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent
} from "@memhtml/domain"
import type { GitFailure } from "@memhtml/store"
import { Effect } from "effect"

import { batchCall, type KeyedMember, keyMembers, packGroups, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import type { PhaseCounts } from "../contract.js"
import { archiveFile, hrefFor, link, meta, stampFile } from "../edits.js"
import {
  emptyOutcome,
  modelFor,
  type PhaseBody,
  type PhaseEnv,
  type PhaseOutcome,
  type SleepError
} from "../env.js"
import { DEDUP_SYSTEM, dedupPrompt, MergePartition } from "../llm.js"
import {
  activeCorpus,
  type CorpusRow,
  frameKeyPairs,
  neighborPairs,
  SLEEP_EXCLUDED_TYPES
} from "../sql.js"
import { budgetFor, closeVanishedDetections, detectionKey, mintDetectedTask } from "../tasks.js"

/**
 * Phase 2, dedup-merge. Fold near-duplicates: the keeper gains `memhtml-supersedes`, the dropped
 * files `git mv` into the archive. ONE commit.
 *
 * ## The model partitions; code decides
 *
 * With a model bound the phase mines a RECALL-oriented candidate set at {@link DEDUP_COMPONENT_FLOOR},
 * unions it with the frame-key exact matches, builds connected components over the union, and asks the
 * model to partition each component into merge groups. The model answers one question: which of these
 * memories are the same memory. It does not choose the canonical, it does not name a write target, and
 * it is never asked an n² pair question — a component of five is one entry in one batch's member list,
 * not ten pair calls.
 *
 * Everything the fold writes is derived afterwards. Orientation is arithmetic over corpus order, and
 * every pair a group implies is routed through `mergeCandidates`, which applies the divergence veto,
 * the self-merge check, the both-roles guard, and the per-night cap. So the set of pairs that CAN be
 * committed does not widen when a model is bound: it is the same predicate over a different candidate
 * set.
 *
 * **Orientation keeps the OLDER file.** That is why the divergence veto changes outcomes instead of
 * being cosmetic. A blind high-cosine merge of a newer correction into an older wrong memory does not
 * merely lose information, it restores the error the correction was written to fix. `activeCorpus`
 * reads oldest-first, so the older path is the keeper by construction and the choice is reproducible.
 * Inside a model-proposed group the keeper is the member with the lowest corpus offset, which is the
 * same rule applied to more than two files at once.
 *
 * **The veto and the in-batch role guard both live in `@memhtml/domain`.** `mergeCandidates` claims BOTH
 * roles for every committed pair. A path that was a keeper cannot later be dropped, and a path that
 * was dropped cannot later become a keeper. The predecessor memory system recorded only the drop side, so given
 * `(gf → a)` then `(b → gf)` both decisions committed: `gf` absorbed `a` and was then archived into
 * `b`, superseding `a`'s content into a file the same batch destroyed. Batching makes that guard carry
 * MORE, not less: one model answer names several groups, and two groups overlapping on one path is
 * exactly that chain, arriving from one call instead of from two nights.
 *
 * **With no model bound the phase is the deterministic floor, unchanged.** It mines at
 * {@link NEAR_DUPLICATE_THRESHOLD}, orients, and hands the pairs to `mergeCandidates`. That is not a
 * degraded mode to be repaired later: a night with no credentials still folds every duplicate a cosine
 * can prove, and every count it reports is what this phase reported before it could call a model.
 *
 * ## Precedence between the two candidate sets
 *
 * Model groups are offered to `mergeCandidates` FIRST, then the mined pairs above the deterministic
 * floor that no group already claimed. Two properties follow, and both are the reason for the order:
 *
 * - The deterministic floor never regresses. Every pair the no-model path would have merged is still
 *   in the list, so binding a model cannot make a night fold less than it did.
 * - Where the two disagree the semantic answer wins the path. A pair above 0.92 whose two files the
 *   model instead grouped with a third folds as the model's group, because the both-roles guard gives
 *   a path to whichever decision claims it first. The model read both files; the cosine read neither.
 *
 * Within each half the order is fixed: groups follow the batch, component, and group order they were
 * packed and answered in, and mined pairs stay in the kernel's `sim` DESC ordering.
 *
 * One commit for the whole batch, not one per pair. A keeper's `memhtml-supersedes` points at its
 * dropped file's ARCHIVE path, which is where that file lives only after this commit lands.
 * Splitting them would create a dangling href in the commit that made it dangle.
 *
 * ## A vetoed pair becomes a review task
 *
 * Surface 1 of issue #44, second detector. The veto is the phase's strongest signal that something
 * needs a HUMAN rather than a merge: two memories a cosine says are the same and a divergence
 * predicate says cannot both be true is either a correction the corpus has not recorded as one, or a
 * pair of facts about different things that read alike. Neither resolution is a nightly job's to make —
 * choosing the winner of a contradiction is a one-way door on stored belief — and the count alone told
 * nobody. {@link mintVetoTasks} opens one task per vetoed pair NAMING THE PREDICATE that fired, in the
 * same commit as the folds.
 */

/**
 * The mining floor when a model is bound. RECALL-oriented, and deliberately below the merge floor.
 *
 * A pair between this and {@link NEAR_DUPLICATE_THRESHOLD} is one no cosine can settle: high enough
 * that the two memories are about one thing, not high enough that they are provably one claim. That
 * band is what a semantic reader is for, and the deterministic path cannot see into it at all. Issue
 * #43 measured ~800 pairs at 0.86 on the 2,907-memory production corpus against 77 at 0.92, and those
 * 800 collapse into components small enough that {@link DEDUP_MAX_COMPONENTS} bounds the night at tens
 * of calls rather than hundreds.
 *
 * The floor is only a floor. A pair that clears it still has to survive the model's partition and then
 * the veto, so more recall here cannot lower the bar on what gets written.
 */
export const DEDUP_COMPONENT_FLOOR = 0.86

/**
 * Mined pairs considered per night at the recall floor.
 *
 * `MAX_MERGE_PAIRS * 8`, twice the deterministic path's `* 4`, because the floor moved down and the
 * pair count grows with the band while the commit cap does not move: no more than `MAX_MERGE_PAIRS`
 * folds land whatever this admits, so the multiplier buys candidate COVERAGE and cannot buy extra
 * writes. Issue #43's measurement is the sizing — ~800 pairs at 0.86 against 800 here — so a corpus of
 * that shape is mined whole and a larger one is truncated at a bound that is stated rather than
 * emergent.
 */
export const DEDUP_PAIR_LIMIT = MAX_MERGE_PAIRS * 8

/**
 * Files of one component that reach a model call. A larger component is TRUNCATED to its lowest paths.
 *
 * Eight is above the size a real near-duplicate family reaches — a fact restated eight times is
 * already pathological — so a component past it is almost always the recall floor having chained
 * several distinct facts through shared vocabulary. Handing all of it over would spend one call's whole
 * attention budget on the component least likely to hold a clean duplicate, and a model asked to
 * partition thirty loosely-related memories answers with a few large groups, which is the answer shape
 * the veto is least able to correct.
 *
 * Truncation keeps the LOWEST PATHS rather than the highest cosines, so which members are considered
 * is a property of the corpus and not of the floor. The remainder is deferred, not lost: the night's
 * folds change the graph, so tomorrow's components over the same corpus are smaller.
 */
export const DEDUP_MAX_COMPONENT = 8

/**
 * Components handed to a model per night. The cost bound.
 *
 * Set so a night lands in issue #43's measured envelope of ~15-25 calls: at
 * {@link DEDUP_BATCH_MEMBERS} members per call and a typical component of two, 300 components pack
 * into roughly 15 calls, and the per-call character budget closes some earlier. Components are taken
 * in component order, which is lowest-path first, so which ones a capped night considers is
 * reproducible.
 */
export const DEDUP_MAX_COMPONENTS = 300

/**
 * Members per dedup call. Wider than compress's 8 because the question is cheaper per member.
 *
 * compress asks the model to WRITE one canonical carrying every member's facts, so each member has to
 * fit the answer's generative attention. Dedup asks only which members restate each other and the
 * answer is a list of keys, so one batch can hold several components' worth.
 */
export const DEDUP_BATCH_MEMBERS = 40

/** Characters of each member shown. The house member budget, the same 1200 compress uses. */
export const DEDUP_MEMBER_CHARS = 1200

/**
 * Characters per dedup call: the member budget times the member cap.
 *
 * Derived rather than chosen, so the two caps cannot drift into a call that honors one and breaches
 * the other. It is a CEILING and normally slack, because most members are far shorter than their
 * budget, which is why `packGroups` takes both bounds and closes on whichever binds first.
 */
export const DEDUP_BATCH_CHARS = DEDUP_MEMBER_CHARS * DEDUP_BATCH_MEMBERS

/**
 * The threshold the batched arm hands `mergeCandidates`, which must NOT re-gate on similarity.
 *
 * Admission on that arm is already decided when the filter runs. A group pair got there because the
 * model grouped it, and a mined pair got there because it cleared {@link NEAR_DUPLICATE_THRESHOLD} in
 * the phase's own filter. What is left for `mergeCandidates` to apply is the veto, the self check, the
 * both-roles guard, and the cap — the four that are about safety rather than about a number.
 *
 * Zero rather than {@link DEDUP_COMPONENT_FLOOR} because that comparison is STRICT (`<= threshold`
 * skips), and a group pair the corpus never mined carries the floor itself as its similarity. A
 * threshold of the floor would drop exactly the frame-seeded pairs that seeding exists to find, and it
 * would do it silently: the count would read as a veto. Nothing negative can reach here, since every
 * mined similarity is at or above the floor and the synthetic value IS the floor.
 */
export const DEDUP_ADMIT_FLOOR = 0

/** The text a member is offered under: its claim and its body, the same join compress uses. */
const textFor = (row: CorpusRow): string => `${row.gist}\n${row.body_text}`

/**
 * `arc` is excluded from the candidate set. An arc is a synthesis of many memories, so it is
 * embedding-near everything it summarizes, and merging one into a member would replace the
 * conclusion with one of its premises.
 *
 * `task` is excluded for the opposite reason: two open tasks with the same body are two things
 * to do, not one fact stored twice. Folding them would archive real work an agent still owes.
 * The `files_content_hash_active` index carves tasks out for the same reason, so structural and
 * semantic dedup agree about them.
 */
const EXCLUDED_TYPES: ReadonlyArray<string> = ["arc", ...SLEEP_EXCLUDED_TYPES]

export const dedupMerge: PhaseBody = (env) =>
  Effect.gen(function* () {
    const corpus = yield* activeCorpus(env.deps.db)
    const order = new Map(corpus.map((row, offset) => [row.path, offset]))
    const rowFor = new Map(corpus.map((row) => [row.path, row]))
    const textOf = new Map(corpus.map((row) => [row.path, textFor(row)]))

    const model = env.deps.model
    const pairs = yield* neighborPairs(env.deps.db, {
      floor: model === undefined ? NEAR_DUPLICATE_THRESHOLD : DEDUP_COMPONENT_FLOOR,
      perSourceK: 5,
      limit: model === undefined ? MAX_MERGE_PAIRS * 4 : DEDUP_PAIR_LIMIT,
      excludeTypes: EXCLUDED_TYPES
    })

    /**
     * Orient each unordered pair once, older path as keeper, and drop the mirrored duplicate. The
     * kernel offers each pair to BOTH endpoints' neighborhoods, so `(a, b)` and `(b, a)` both arrive.
     */
    const seen = new Set<string>()
    const oriented: Array<MergePair> = []
    /** `keepPath dropPath` -> the mined similarity, so a group can report a measured value. */
    const simFor = new Map<string, number>()
    for (const pair of pairs) {
      const left = order.get(pair.src)
      const right = order.get(pair.dst)
      if (left === undefined || right === undefined) continue
      const [keepPath, dropPath] = left <= right ? [pair.src, pair.dst] : [pair.dst, pair.src]
      const key = `${keepPath} ${dropPath}`
      if (seen.has(key)) continue
      seen.add(key)
      simFor.set(key, pair.sim)
      oriented.push({
        keepPath,
        dropPath,
        similarity: pair.sim,
        keepText: textOf.get(keepPath),
        dropText: textOf.get(dropPath)
      })
    }

    if (model === undefined) {
      /**
       * The deterministic path: the mined pairs at 0.92, oriented, through the same filter under its
       * own default threshold. Every count and every write here is what this phase produced before it
       * could call a model, which is what makes the existing dedup tests an oracle for the rest.
       */
      const decisions = mergeCandidates(oriented)
      return yield* commitMerges(
        env,
        decisions,
        {
          candidates: oriented.length,
          components: 0,
          llmGroups: 0,
          vetoed: oriented.length - decisions.length
        },
        /**
         * Every mined pair on this arm cleared 0.92, so a vetoed one here is a near-certain duplicate
         * the divergence predicates refused — which is exactly the pair issue #44 wants a human to
         * look at. `judged: true`, because this arm makes no model call, so nothing about the night
         * could have silently failed to evaluate a pair.
         */
        { vetoed: vetoedPairs(oriented), judged: true }
      )
    }

    /**
     * The component graph: the mined edges at the recall floor, unioned with the frame-key exact
     * matches. A frame seed is an edge no cosine produced, so the union is what puts a slot collision
     * in front of the model even when the two bodies share little vocabulary.
     */
    const frameSeeds = yield* frameKeyPairs(env.deps.db)
    const edges: Array<readonly [string, string]> = [
      ...oriented.map((pair) => [pair.keepPath, pair.dropPath] as const),
      ...frameSeeds.flatMap((pair) => {
        /**
         * A seed is filtered by the SAME type exclusion the mining arm passes to SQL. The frame index
         * already carves out tasks, but not `arc` — and an arc shares a slot with any member it
         * summarizes, so an unfiltered seed would put the conclusion in a component with its premise
         * and invite the model to fold one into the other.
         */
        const src = rowFor.get(pair.src)
        const dst = rowFor.get(pair.dst)
        if (src === undefined || dst === undefined) return []
        if (EXCLUDED_TYPES.includes(src.memory_type) || EXCLUDED_TYPES.includes(dst.memory_type)) {
          return []
        }
        return [[pair.src, pair.dst] as const]
      })
    ]

    /**
     * Components of two or more are the units of work, truncated to {@link DEDUP_MAX_COMPONENT} at
     * their lowest paths and capped at {@link DEDUP_MAX_COMPONENTS} per night. `connectedComponents`
     * returns members sorted and components ordered by their smallest member, so both cuts are a
     * function of the corpus rather than of how the edges were enumerated.
     */
    const components = connectedComponents(edges)
      .filter((members) => members.length >= 2)
      .slice(0, DEDUP_MAX_COMPONENTS)
      .map((members) =>
        members.slice(0, DEDUP_MAX_COMPONENT).flatMap((path) => {
          const row = rowFor.get(path)
          return row === undefined ? [] : [row]
        })
      )
      .filter((members) => members.length >= 2)

    /**
     * Whole components per call, so no group's members are split across two answers. Splitting one
     * would ask each half whether it holds a duplicate having hidden the other half.
     */
    const batches = packGroups(components, {
      maxMembers: DEDUP_BATCH_MEMBERS,
      maxChars: DEDUP_BATCH_CHARS,
      charsOf: (row) => Math.min(textFor(row).length, DEDUP_MEMBER_CHARS)
    })

    const modelKey = modelFor(env.deps, "dedup-merge")
    let llmCalls = 0
    let llmGroups = 0
    let skipped = 0
    /** Group-implied pairs, in batch then component then group order. */
    const groupPairs: Array<MergePair> = []
    /** Every path a surviving group claimed, so the mined arm cannot re-propose one. */
    const grouped = new Set<string>()

    for (const batch of batches) {
      /**
       * ONE keying across the whole batch, not one per component. Keys have to be unique inside the
       * answer's namespace, and per-component keying would mint `m1` several times over — so a model
       * naming `m1` would name several files and `resolveKeys` could not say which.
       */
      const keyed = keyMembers(batch.flat(), textFor, { charBudget: DEDUP_MEMBER_CHARS })
      /** Which component each offered key sits in. The containment check below reads this. */
      const componentOfKey = new Map<string, number>()
      const framed: Array<ReadonlyArray<KeyedMember>> = []
      let cursor = 0
      for (const [offset, members] of batch.entries()) {
        const slice = keyed.keyed.slice(cursor, cursor + members.length)
        for (const member of slice) componentOfKey.set(member.key, offset)
        framed.push(slice)
        cursor += members.length
      }

      llmCalls += 1
      const partition = yield* batchCall(model, `dedup batch of ${batch.length} components`, {
        schema: MergePartition,
        system: DEDUP_SYSTEM,
        prompt: dedupPrompt(framed),
        modelKey,
        effort: "high",
        toolDescription:
          "Emit the merge groups: within each component, the members that are the same memory."
      })
      if (partition === undefined) {
        /**
         * One call's failure costs its own components and nothing else. `dedup-merge` is a HARD
         * prerequisite of compress and retention-triage, so failing the phase over one malformed tool
         * payload would cancel two later phases as well as this one's whole night.
         */
        skipped += 1
        continue
      }

      for (const group of partition.groups) {
        const members = resolveKeys(keyed, group.memberKeys)
        if (members.length < 2) continue

        /**
         * **A group is confined to ONE component, and a spanning group is DROPPED WHOLE rather than
         * split.** Splitting would keep the half of an answer whose premise was already wrong: a model
         * that grouped across components disagreed with the measurement that separated them, and there
         * is no reason to trust the surviving half of that answer more than the part being discarded.
         * Dropping leaves every member active, which is the safe outcome, and any pair inside the
         * intended component is still reachable through the mined arm when a cosine can prove it.
         *
         * Read off the RESOLVED keys, so a key the model invented cannot decide containment: an
         * unknown key is absent from `componentOfKey` and would otherwise count as a second component.
         */
        const componentIds = new Set(
          group.memberKeys.flatMap((key) => {
            const id = componentOfKey.get(key)
            return id === undefined ? [] : [id]
          })
        )
        if (componentIds.size !== 1) continue

        /** The keeper is the OLDEST member: the lowest corpus offset, the same rule a pair uses. */
        const sorted = [...members].sort(
          (left, right) => (order.get(left.path) ?? 0) - (order.get(right.path) ?? 0)
        )
        const keeper = sorted[0]
        if (keeper === undefined) continue
        llmGroups += 1
        for (const member of sorted.slice(1)) {
          groupPairs.push({
            keepPath: keeper.path,
            dropPath: member.path,
            /**
             * The mined similarity when this pair was itself mined, else the floor. A frame-seeded
             * pair and a transitive pair inside a component were never scored, and the floor is the
             * honest value for "at least this near, never measured closer" — see
             * {@link DEDUP_ADMIT_FLOOR} for why the filter must not compare against it.
             */
            similarity: simFor.get(`${keeper.path} ${member.path}`) ?? DEDUP_COMPONENT_FLOOR,
            keepText: textOf.get(keeper.path),
            dropText: textOf.get(member.path)
          })
          grouped.add(member.path)
        }
        grouped.add(keeper.path)
      }
    }

    /**
     * Groups first, then the mined pairs above the DETERMINISTIC floor that no group claimed. The
     * comparison is against 0.92 and not against the recall floor, so a pair in the recall band the
     * model declined to group is not folded: the model's silence about it is the answer, and folding it
     * anyway would make the recall floor the merge floor.
     */
    const remaining = oriented.filter(
      (pair) =>
        pair.similarity > NEAR_DUPLICATE_THRESHOLD &&
        !grouped.has(pair.keepPath) &&
        !grouped.has(pair.dropPath)
    )
    const proposed = [...groupPairs, ...remaining]
    const decisions = mergeCandidates(proposed, { threshold: DEDUP_ADMIT_FLOOR })

    const outcome = yield* commitMerges(
      env,
      decisions,
      {
        candidates: proposed.length,
        components: components.length,
        llmGroups,
        vetoed: proposed.length - decisions.length,
        skipped
      },
      /**
       * On this arm a vetoed pair is one the MODEL grouped as the same memory, or one that cleared
       * 0.92 with no group claiming it, and the veto then refused it for a divergence. Both readings
       * are the issue's case: a semantic reader said "same" and a deterministic predicate said "these
       * differ in a way that matters", and the resolution — is one a correction of the other? — is a
       * human's.
       *
       * `judged` is false when a batch's call failed, because those components were never partitioned:
       * their pairs reach the veto only through the mined arm, so a night that lost a call cannot say
       * whether a pair it did not see is still a candidate.
       */
      { vetoed: vetoedPairs(proposed), judged: skipped === 0 }
    )
    return { ...outcome, llmCalls }
  })

/** The detector name every near-duplicate review task is keyed and swept under. */
export const DEDUP_REVIEW_DETECTOR = "dedup-merge"

/**
 * The proposed pairs the divergence veto refused, with WHICH predicate fired.
 *
 * The three predicates are pure, exported, and independently callable, so the phase can name the one
 * that fired instead of reporting "vetoed". That distinction is the whole value of the task: "these two
 * carry different numbers" tells a reviewer to compare the numbers, "exactly one of them is negated"
 * tells them one is probably a correction of the other, and "vetoed" tells them to read both files from
 * scratch.
 *
 * Re-running the predicates rather than threading a reason out of `mergeCandidates` keeps the domain
 * filter's signature alone: it returns the decisions it made, and asking it to also return a
 * per-refusal reason would make every caller carry a channel one caller reads. The predicates are pure
 * token-set comparisons over text already in memory, and this runs over the proposed set once.
 *
 * A pair with either text missing is NOT vetoed — the filter skips the veto for it too, since it cannot
 * evaluate one — so those are absent here, which is correct: an unevaluated pair is not a divergence
 * anyone found.
 */
const vetoedPairs = (proposed: ReadonlyArray<MergePair>): ReadonlyArray<VetoedPair> =>
  proposed.flatMap((pair) => {
    const keepText = pair.keepText
    const dropText = pair.dropText
    if (keepText === undefined || dropText === undefined) return []
    const predicates = [
      ...(negationDivergent(keepText, dropText)
        ? ["one side is negated and the other is not"]
        : []),
      ...(numericTokenDivergent(keepText, dropText) ? ["the two carry different numbers"] : []),
      ...(variantQualifierDivergent(keepText, dropText)
        ? ["the two name different product variants"]
        : [])
    ]
    if (predicates.length === 0) return []
    return [
      { keepPath: pair.keepPath, dropPath: pair.dropPath, similarity: pair.similarity, predicates }
    ]
  })

/** One vetoed pair and the predicates behind the refusal, in the veto's own disjunction order. */
interface VetoedPair {
  readonly keepPath: string
  readonly dropPath: string
  readonly similarity: number
  readonly predicates: ReadonlyArray<string>
}

/**
 * Mint one review task per vetoed pair, and sweep the ones that stopped diverging.
 *
 * **The key is the two PATHS sorted.** A path is the id of a memory in this corpus, and the question is
 * about these two files — so unlike the merge itself, which orients keeper-then-drop from corpus dates,
 * the review question is unordered and sorting is what makes tomorrow's `(b, a)` key with today's
 * `(a, b)`.
 *
 * **The evidence is a MEASUREMENT.** The predicate that fired is a fact about the two token sets, and
 * no sentence in either file states it. The paths ride in the detail so a reviewer can open both.
 *
 * A pair whose veto STOPS firing — because a human corrected one of the two, or because one was
 * archived — is closed by the sweep, which is right: the divergence was the finding, and it is gone.
 */
const mintVetoTasks = (
  env: PhaseEnv,
  vetoed: ReadonlyArray<VetoedPair>,
  judged: boolean
): Effect.Effect<
  { readonly minted: number; readonly refreshed: number; readonly closed: number },
  SleepError | GitFailure
> =>
  Effect.gen(function* () {
    const budget = budgetFor(env)
    /**
     * Keyed and de-duplicated before minting, then walked in key order, so which pairs a budget-capped
     * night surfaces is a function of the pairs rather than of the arm that proposed them.
     */
    const byKey = new Map<string, VetoedPair>()
    for (const pair of vetoed) {
      const key = detectionKey(DEDUP_REVIEW_DETECTOR, vetoFinding(pair))
      if (!byKey.has(key)) byKey.set(key, pair)
    }

    let minted = 0
    let refreshed = 0
    for (const key of [...byKey.keys()].sort()) {
      const pair = byKey.get(key)
      if (pair === undefined) continue
      const outcome = yield* mintDetectedTask(env, budget, {
        detector: DEDUP_REVIEW_DETECTOR,
        finding: vetoFinding(pair),
        title: `Review near-duplicates vetoed for divergence: ${basenameOf(pair.keepPath)} and ${basenameOf(pair.dropPath)}`,
        claim: "review: near-duplicates vetoed for divergence — is one a correction of the other?",
        detail:
          `The two memories are ${pair.keepPath} and ${pair.dropPath}. Sleep refused to fold them ` +
          `because folding keeps the OLDER file, so a blind merge of a correction into the memory it ` +
          `corrects would restore the error the correction was written to fix.`,
        evidence: { kind: "measurement", detail: vetoEvidence(pair) }
      })
      if (outcome === "minted") minted += 1
      else if (outcome === "refreshed") refreshed += 1
    }

    const closed = judged
      ? yield* closeVanishedDetections(env, DEDUP_REVIEW_DETECTOR, new Set(byKey.keys()))
      : 0
    return { minted, refreshed, closed }
  })

/** The canonical finding string: the two paths, sorted. See {@link mintVetoTasks}. */
const vetoFinding = (pair: VetoedPair): string =>
  pair.keepPath < pair.dropPath
    ? `${pair.keepPath} ${pair.dropPath}`
    : `${pair.dropPath} ${pair.keepPath}`

/** The evidence line: which predicates fired, and how near the two bodies measured. */
const vetoEvidence = (pair: VetoedPair): string =>
  `${pair.predicates.join("; ")} — at cosine ${pair.similarity.toFixed(3)}, ` +
  `at or above the ${String(DEDUP_COMPONENT_FLOOR)} candidate floor`

/** A path's filename without its extension, for a title that fits `ls` and a commit subject. */
const basenameOf = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.html$/, "")

/**
 * Archive each drop, stamp each keeper, and commit once.
 *
 * Shared by both arms so the WRITES do not fork on whether a model was bound: the two differ in how
 * they choose pairs and in nothing else. A pair that reached here has already passed the veto, the self
 * check, the both-roles guard, and the cap, whichever arm proposed it.
 *
 * The counts are real on a dry run — including the veto — because an operator sizing a night needs to
 * know what it would have folded. Only the writes are withheld.
 *
 * **A dry run here DOES spend model calls, and `entity-resolution`'s deliberately does not.** The two
 * choices differ because what a preview is worth differs. The number an operator wants from this phase
 * is how many folds a real night would make, and the model's partition is what decides that — a dry run
 * that skipped the call would report only the deterministic floor's folds and understate the night it is
 * previewing. `entity-resolution` refuses because its writes are identity rewrites, the one-way door
 * this codebase guards hardest: its dry run would have to bump `entity_corroboration` to be honest about
 * night two, and a counter bumped by a run that wrote nothing is a night of evidence the corpus never
 * saw.
 */
const commitMerges = (
  env: PhaseEnv,
  decisions: ReadonlyArray<MergeDecision>,
  base: PhaseCounts,
  /**
   * The vetoed pairs to defer to a human, and whether the night judged its whole candidate set.
   *
   * Passed in rather than recomputed here, because only the caller knows which arm ran and therefore
   * which set `proposed` was — and `judged` is a fact about the CALLS, which this function does not
   * make.
   */
  review: { readonly vetoed: ReadonlyArray<VetoedPair>; readonly judged: boolean }
): Effect.Effect<PhaseOutcome, SleepError | GitFailure> =>
  Effect.gen(function* () {
    /**
     * A dry run counts the folds and the vetoes and mints nothing. Every count above is already real on
     * a dry run because an operator sizing a night needs them; a TASK is a write, so it waits for a
     * real night the same way the archives do.
     */
    if (env.dryRun) {
      return emptyOutcome({
        ...base,
        merged: decisions.length,
        vanished: 0,
        tasksMinted: 0,
        tasksClosed: 0
      })
    }

    let merged = 0
    let vanished = 0
    for (const decision of decisions) {
      const archived = yield* archiveFile(env, decision.dropPath, [
        meta("memhtml-superseded-by", hrefFor(decision.keepPath))
      ])
      // `null` means the tree no longer holds the drop path. The keeper gains no supersedes toward a
      // file that is not there, which would dangle in the commit that created it.
      if (archived === null) {
        vanished += 1
        continue
      }
      yield* stampFile(env, decision.keepPath, [
        link("supersedes", hrefFor(archived)),
        meta("memhtml-updated", env.at)
      ])
      merged += 1
    }

    /**
     * The vetoed pairs become tasks in the SAME commit as the folds, and the mint runs even when
     * nothing folded — which is why the old `decisions.length === 0` early return is gone. A night
     * whose every candidate was vetoed is precisely the night with the most for a human to decide, and
     * returning early on it would have made surface 1 unreachable on exactly that night.
     */
    const tasks = yield* mintVetoTasks(env, review.vetoed, review.judged)

    const final = {
      ...base,
      merged,
      vanished,
      tasksMinted: tasks.minted,
      tasksClosed: tasks.closed
    }
    if (merged === 0 && tasks.minted === 0 && tasks.refreshed === 0 && tasks.closed === 0) {
      return emptyOutcome(final)
    }
    const commitSha = yield* commitPhase(
      env,
      "dedup-merge",
      `fold ${merged} near-duplicates into canonicals`,
      final,
      tasks.minted + tasks.closed === 0
        ? undefined
        : `deferred ${tasks.minted} vetoed pairs to review tasks` +
            (tasks.closed === 0 ? "" : `; closed ${tasks.closed}: no longer detected`)
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })
