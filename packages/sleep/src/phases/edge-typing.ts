import type { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import { hrefFor, link, meta, readFileBytes, stampFile } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody, type PhaseEnv } from "../env.js"
import {
  assertsContradiction,
  assertsEdge,
  EDGE_TYPING_SYSTEM,
  EdgeTyping,
  edgeTypingPrompt,
  isDirectionalRel,
  pairText
} from "../llm.js"
import {
  activeCorpus,
  bumpCorroboration,
  markPromoted,
  minedPairs,
  type PairRow,
  SLEEP_EXCLUDED_TYPES,
  sharedEntityPairs
} from "../sql.js"

/**
 * Phase 6, edge typing. Candidate pairs grouped and BATCHED, one structured verdict list per call
 * over the whole memory-rel vocabulary, then a deterministic promotion. One commit for the night's
 * promotions.
 *
 * Four stages, and keeping them separate is what makes the phase safe:
 *
 * 1. **Scan (SQL, no model).** The union of two candidate arms, deduplicated by unordered pair and
 *    RANKED BY SIMILARITY before the cap: relationship mining's derived `relates_to` edges
 *    ({@link minedPairs}) and the shared-entity scan ({@link sharedEntityPairs}). Neither arm
 *    subsumes the other — two memories about one incident naming no common entity are invisible to
 *    the join and obvious to the embedder, and a same-entity pair below the mining floor is the
 *    reverse — so recall is the union rather than whichever signal happens to be stronger in a
 *    corpus. Both arms exclude tasks and anti-join pairs that already carry an AUTHORED edge either
 *    way.
 * 2. **Batch (deterministic).** Pairs sorted by the directory both endpoints share, then sliced at
 *    {@link EDGE_PAIRS_PER_CALL} on the shared kernel, so topically related pairs land in one call.
 *    One call per batch, never one per pair: at the measured 1,498 mined pairs a night, per-pair
 *    judging is 1,498 calls and does not scale.
 * 3. **Judge (one model call per batch, isolated).** Each call is wrapped so one malformed tool
 *    payload skips its BATCH and is counted. A night that typed nine batches and lost the tenth has
 *    done nine batches of work; failing the phase would discard all of it.
 * 4. **Promote (deterministic, decided here and not by the model).** The model proposes a rel, a
 *    direction, and a confidence; code decides what is written:
 *    - `contradicts` above `EDGE_CONFIDENCE_FLOOR` bumps the corroboration counter and is
 *      written into BOTH files only at `detections >= 2`. A single machine detection therefore
 *      cannot reach the retention penalty, which counts only `derived = 0` file-borne edges. Both
 *      endpoints must still be in the TREE, checked before either write, and the counter is marked
 *      promoted only when both sides actually gained the link — otherwise the pair is left
 *      re-eligible for a later night rather than recorded as half done.
 *    - A DIRECTIONAL rel above the floor is written into the SUBJECT's file alone, per the
 *      direction the model named. No corroboration gate: a `part_of` carries no penalty and is
 *      cheap for a reviewer to delete, so a second night's wait would buy nothing.
 *    - `none`, or anything below the floor, writes nothing at all and leaves the pair a mined
 *      `relates_to`. That is the safe outcome and the one an unsure model is told to pick.
 *    - A verdict naming a key the batch never offered resolves to nothing and is dropped, so a
 *      hallucinated key cannot become a write. A pair the model omits is simply not typed tonight.
 *
 * **Determinism is the phase's, not the kernel's.** Both sorts below fix the batch boundaries and
 * the `m1`..`mN` keys, and the kernel preserves the order it is handed. Two runs over an unchanged
 * corpus therefore send the same prompt bytes in the same order.
 *
 * **Deferred: a `none` pair is re-judged on every later night, bounded by the candidate cap.** Neither
 * arm records that a pair was judged and answered `none`, so the pair stays a mined `relates_to` and
 * re-enters the union tomorrow. The cap is what bounds that cost — a night judges
 * {@link EDGE_TYPING_CANDIDATE_LIMIT} pairs whatever their history — and a judged-`none` watermark is
 * new durable state-plane surface, so it stays out of this change.
 *
 * **Detection only, still.** A promoted `contradicts` asserts the conflict and stops: nothing is
 * superseded, no `memhtml-valid-until` is closed, neither side is archived. Choosing the winner of a
 * contradiction is a one-way door on stored belief, and it belongs to an agent or a human, not to a
 * nightly job.
 *
 * This phase replaced `conflict-detection`, which asked one `generateObject` per pair for a stance
 * verdict over `{contradicts, entails, neutral}`. Contradiction is now one more verdict in the same
 * list, with the same corroboration gate. A run whose commits predate the rename carries
 * `Memhtml-Phase: conflict-detection` trailers, and `memhtml sleep resume` matches trailers by name,
 * so resuming a pre-rename run re-executes this phase; that is out of scope and costs a re-judge, not
 * a wrong write, because every write below is idempotent on its pair.
 */

/**
 * Pairs offered per model call.
 *
 * Sized for the answer's attention rather than for the context window: thirty pairs is sixty
 * memories, each sliced to {@link EDGE_PAIR_SIDE_CHARS}, and the model has to hold a distinct
 * judgment for each one. A batch twice this size buys half the calls and invites the model to answer
 * the first ten pairs carefully and the rest by pattern.
 */
export const EDGE_PAIRS_PER_CALL = 30

/** The similarity floor a shared-entity pair must clear to be worth including. */
export const EDGE_COSINE_FLOOR = 0.8

/** Nearest same-entity neighbors considered per source, on the shared-entity arm. */
export const EDGE_PER_SOURCE_K = 5

/**
 * Pairs typed per cycle. The model-cost guard, unchanged from the per-pair phase's 200 even though
 * the calls are now ~7 instead of 200: the cap bounds how many AUTHORED EDGES one night can write
 * into the corpus, and that budget did not get cheaper because the judging did.
 */
export const EDGE_TYPING_CANDIDATE_LIMIT = 200

/**
 * Characters of EACH SIDE of a pair shown. The house per-member budget, applied per side.
 *
 * A pair's member text holds two memories, so the kernel's per-member slice would cut the whole
 * `src` + `dst` block at one budget and could truncate `dst` away entirely on a long `src` — a
 * verdict about a pair whose second half the model never saw. Slicing each side first bounds the
 * pair at twice this and guarantees both halves are present.
 */
export const EDGE_PAIR_SIDE_CHARS = 1200

/** Detections a machine-found contradiction needs before it is written into the files. */
export const PROMOTION_DETECTIONS = 2

/**
 * Authored edges one night may promote, across every batch and both kinds.
 *
 * The candidate cap bounds what is JUDGED and this bounds what is WRITTEN, and they are different
 * guards: a model that answered `caused_by` at confidence 1.0 for all 200 candidates would otherwise
 * add 200 `<link>` lines to the corpus in one commit, which is not a diff a human reviews. Hitting
 * the cap is visible as `capped` in the counts.
 */
export const EDGE_PROMOTION_CAP = 50

/** One candidate pair with both endpoints' text, ready to be keyed. */
interface TypingCandidate {
  readonly pair: PairRow
  readonly srcText: string
  readonly dstText: string
}

/**
 * The union of both candidate arms, deduplicated by UNORDERED pair and ranked `sim` DESC.
 *
 * The two arms orient their pairs differently — the shared-entity join emits `dst < src` and a mined
 * edge carries whichever orientation mining wrote — so the dedup key sorts the endpoints. Without
 * that, one pair reaching both arms would be typed twice in one night, and the two verdicts could
 * disagree.
 *
 * The kept row is the FIRST one seen, and the mined arm is walked first, so a pair in both arms
 * carries mining's own orientation AND mining's own `sim`. That choice is arbitrary, because the
 * direction the phase writes comes from the model's `direction` field relative to this orientation,
 * so it must only be STABLE, which the sort makes it.
 *
 * **`sim` DESC is what makes the candidate cap select rather than truncate.** Both arms carry a
 * similarity on one scale — `sharedEntityPairs` reports the cosine `rankCandidatePairs` computed and
 * `minedPairs` reports the mined edge's own clamped cosine — so the union is rankable without
 * re-decoding a vector. A path-ordered union capped at {@link EDGE_TYPING_CANDIDATE_LIMIT} would spend
 * the whole night's model budget on whichever pairs sort alphabetically first, so a corpus whose
 * strongest candidates live under `services/` or `team/` would never have them judged at all, however
 * many nights ran. The tie-break is `src` ASC then `dst` ASC, which is `collectRanked`'s ordering in
 * `@memhtml/domain` — the house rule every other pair consumer already follows, so two runs over an
 * unchanged corpus select and batch the same pairs.
 */
export const unionPairs = (arms: ReadonlyArray<ReadonlyArray<PairRow>>): ReadonlyArray<PairRow> => {
  const seen = new Set<string>()
  const out: Array<PairRow> = []
  for (const arm of arms) {
    for (const pair of arm) {
      const key = pair.src < pair.dst ? `${pair.src} ${pair.dst}` : `${pair.dst} ${pair.src}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(pair)
    }
  }
  return out.sort((left, right) => {
    if (left.sim !== right.sim) return left.sim < right.sim ? 1 : -1
    if (left.src !== right.src) return left.src < right.src ? -1 : 1
    return left.dst < right.dst ? -1 : left.dst > right.dst ? 1 : 0
  })
}

/**
 * The night's candidate pairs: the union of both arms, ranked `sim` DESC, then capped.
 *
 * The rank is {@link unionPairs}' and the cap is applied AFTER it, so the cap selects the strongest
 * {@link EDGE_TYPING_CANDIDATE_LIMIT} pairs the corpus offers rather than the alphabetically first
 * ones. That ordering is also the batch order's first input, so a night's strongest pairs are judged
 * even when the cap bites.
 *
 * Its own function so the SCAN is separable from the judging, and exported so a test asserting on a
 * batch boundary, a cap, or a skip count reads the same set the phase will type instead of
 * reconstructing it. A test that rebuilt this by hand would be a second implementation free to
 * disagree, and every count below is stated relative to it. The scan's own correctness has an
 * independent all-SQL oracle in `tests/neighbor-pairs.test.ts`; this is the composition of two
 * already-tested reads.
 */
export const edgeTypingCandidates = (
  db: PhaseEnv["deps"]["db"]
): Effect.Effect<ReadonlyArray<PairRow>, StorageFailure> =>
  Effect.gen(function* () {
    const mined = yield* minedPairs(db, {
      rel: "relates_to",
      excludeTypes: SLEEP_EXCLUDED_TYPES
    })
    const shared = yield* sharedEntityPairs(db, {
      floor: EDGE_COSINE_FLOOR,
      perSourceK: EDGE_PER_SOURCE_K,
      limit: EDGE_TYPING_CANDIDATE_LIMIT,
      excludeTypes: SLEEP_EXCLUDED_TYPES
    })
    return unionPairs([mined, shared]).slice(0, EDGE_TYPING_CANDIDATE_LIMIT)
  })

/**
 * The grouping key for batching: the deepest directory both endpoints share, or `""` when they share
 * none.
 *
 * Deliberately NOT the graph community. `runRetentionPass` computes label propagation over the whole
 * memory-edge list plus PageRank plus the access plane, and this phase needs none of that — it would
 * be a second corpus-wide pass for a grouping hint, and it answers `undefined` for every pair in a
 * community below the size floor, which is most pairs in a small corpus. The shared directory is
 * already the corpus's own topical partition (`areas/deploy`, `areas/oncall`), it is a pure function
 * of two paths, and it puts related pairs in one call, which is all the batching needs from it. A
 * model shown thirty pairs from one area also has the area's context, which is the substantive half
 * of what community grouping was for.
 */
export const pairGroupKey = (pair: PairRow): string => {
  const left = pair.src.split("/")
  const right = pair.dst.split("/")
  const shared: Array<string> = []
  // Both arrays end in a filename, which is never part of the directory prefix.
  for (let at = 0; at < Math.min(left.length, right.length) - 1; at += 1) {
    if (left[at] !== right[at]) break
    shared.push(left[at] as string)
  }
  return shared.join("/")
}

export const edgeTyping: PhaseBody = (env) =>
  Effect.gen(function* () {
    const model = env.deps.model
    if (model === undefined) {
      return { ...emptyOutcome({ candidates: 0, judged: 0 }), detail: "no model bound" }
    }

    /**
     * Tasks are out of both candidate arms, inside {@link edgeTypingCandidates}. Every rel in the
     * vocabulary is a judgment about asserted facts, and a task asserts nothing: "these two
     * contradict" and "this one caused that one" have no true answer about intended work. A promoted
     * edge between two tasks would also be a memory-class edge with task endpoints written into both
     * files.
     */
    const candidates = yield* edgeTypingCandidates(env.deps.db)

    /**
     * The full path's count SHAPE, at zero. Every key the phase can report is present, because a
     * report reader comparing two nights reads a missing key as a phase that does not have that
     * concept rather than as a night that did none of it.
     */
    const zero = {
      candidates: 0,
      judged: 0,
      typed: 0,
      contradictions: 0,
      promoted: 0,
      skipped: 0,
      capped: 0,
      duplicates: 0
    }
    if (candidates.length === 0) return emptyOutcome(zero)
    if (env.dryRun) return emptyOutcome({ ...zero, candidates: candidates.length })

    const corpus = yield* activeCorpus(env.deps.db)
    const textOf = new Map(corpus.map((row) => [row.path, `${row.gist}\n${row.body_text}`]))

    /**
     * A pair whose endpoint the corpus no longer holds is dropped before batching rather than inside
     * the loop. An earlier phase's archive is the normal case here (the index is refreshed once, in
     * preflight), and dropping it later would leave a hole in the numbered list the model is asked
     * about.
     */
    const withText: Array<TypingCandidate> = []
    let skipped = 0
    for (const pair of candidates) {
      const srcText = textOf.get(pair.src)
      const dstText = textOf.get(pair.dst)
      if (srcText === undefined || dstText === undefined) {
        skipped += 1
        continue
      }
      withText.push({ pair, srcText, dstText })
    }

    /**
     * The group is a SORT KEY, not a batch boundary, and that distinction is the phase's cost model.
     *
     * `dedup-merge` packs whole groups with the boundaries preserved because there a boundary is
     * EVIDENCE: two members in different components are known not to be near-duplicates. Here every
     * pair is judged on its own two memories, so a boundary carries no information the verdict needs —
     * and honoring it would cost a model call per group. On a corpus whose pairs spread over a dozen
     * directories that is a dozen calls for thirty pairs, which is the per-pair shape this phase
     * exists to replace. Sorting by the group instead keeps related pairs ADJACENT, so they land in
     * one call whenever they fit, and the call count is `ceil(pairs / EDGE_PAIRS_PER_CALL)`.
     *
     * The sort is this phase's and the kernel keeps the order it produces: group key first, then the
     * `src`/`dst` order `unionPairs` already fixed, so a night's batch boundaries and `m1`..`mN` keys
     * are a function of the corpus alone.
     */
    const sorted = [...withText].sort((left, right) => {
      const leftKey = pairGroupKey(left.pair)
      const rightKey = pairGroupKey(right.pair)
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
      if (left.pair.src !== right.pair.src) return left.pair.src < right.pair.src ? -1 : 1
      return left.pair.dst < right.pair.dst ? -1 : left.pair.dst > right.pair.dst ? 1 : 0
    })
    const batches = assembleBatches([sorted], { maxMembers: EDGE_PAIRS_PER_CALL })

    const modelKey = modelFor(env.deps, "edge-typing")
    let judged = 0
    let typed = 0
    let contradictions = 0
    let promoted = 0
    let capped = 0
    /** Second-and-later verdicts naming a key their batch had already answered for. */
    let duplicates = 0
    let llmCalls = 0

    for (const batch of batches) {
      /** Opaque keys again, so a verdict cannot name a path. Each SIDE is sliced to its budget. */
      const keyed = keyMembers(batch, (candidate) =>
        pairText(
          candidate.srcText.slice(0, EDGE_PAIR_SIDE_CHARS),
          candidate.dstText.slice(0, EDGE_PAIR_SIDE_CHARS)
        )
      )

      llmCalls += 1
      const answer = yield* batchCall(model, `edge-typing batch of ${batch.length}`, {
        schema: EdgeTyping,
        system: EDGE_TYPING_SYSTEM,
        prompt: edgeTypingPrompt(keyed.keyed),
        modelKey,
        effort: "medium",
        toolDescription: "Emit one relationship verdict per candidate pair."
      })
      if (answer === undefined) {
        // One batch's worth of pairs went untyped. The rest of the night still runs.
        skipped += batch.length
        continue
      }

      /**
       * The keys this batch has already answered for, so a SECOND verdict naming one is dropped.
       *
       * A verdict is one pair's answer, and nothing in the schema stops a model from emitting two for
       * one key. Acting on both would write two authored edges from one relationship — and since the
       * two are free to disagree about `direction`, `caused_by` could land in BOTH files, which says
       * each memory caused the other. `resolveKeys` does not help: it is called one key at a time
       * here, because a verdict names one pair, so its own repeat-collapsing never sees the pair.
       *
       * FIRST wins rather than last, and the choice is the same one {@link unionPairs} makes: the
       * batch's order is deterministic, so which verdict is first is reproducible, and a later verdict
       * cannot revise a write already committed to the tree. Repeats are counted in `duplicates`
       * rather than silently swallowed, so a model doing this is visible in a night's report.
       */
      const answered = new Set<string>()

      for (const verdict of answer.verdicts) {
        /**
         * The key is resolved through the kernel, so an invented key yields no candidate and no
         * write.
         */
        const [candidate] = resolveKeys(keyed, [verdict.pairKey])
        if (candidate === undefined) continue
        if (answered.has(verdict.pairKey)) {
          duplicates += 1
          continue
        }
        answered.add(verdict.pairKey)
        judged += 1
        if (!assertsEdge(verdict)) continue

        if (assertsContradiction(verdict)) {
          contradictions += 1
          /**
           * The bump and the promotion decision are one statement's `RETURNING`, not a read followed
           * by a write. Two runs racing on one pair would otherwise both read `detections = 1` and
           * both decline to promote, so a genuinely corroborated contradiction would stay out of the
           * files forever.
           */
          const rows = yield* bumpCorroboration(env.deps.db, {
            srcPath: candidate.pair.src,
            rel: "contradicts",
            dstPath: candidate.pair.dst,
            at: env.at
          })
          const row = rows[0]
          if (row === undefined || row.detections < PROMOTION_DETECTIONS || row.promoted === 1) {
            continue
          }
          if (promoted + typed >= EDGE_PROMOTION_CAP) {
            capped += 1
            continue
          }

          /**
           * **BOTH endpoints, or nothing at all — checked BEFORE either write.**
           *
           * A `contradicts` is symmetric, and the phase's own promotion rule is that a reader arriving
           * at either file sees it. So the pair is all-or-nothing, and the check has to come first
           * because the alternative is not recoverable: stamping `src` and then finding `dst` gone
           * leaves a `<link>` pointing at a path the tree does not hold — a dangling href committed by
           * the commit that created it — while the other half of the conflict is invisible.
           *
           * A missing endpoint is ORDINARY here, not exceptional. Every phase reads its candidates from
           * an index refreshed once in preflight and not again, so a file an earlier phase archived is
           * still listed active at its old path when this phase reads it. `readFileBytes` answers
           * `undefined` for exactly that case, and the TREE is the system of record.
           */
          /**
           * **BOTH endpoints, or nothing at all — checked BEFORE either write.**
           *
           * A `contradicts` is symmetric, and the phase's own promotion rule is that a reader arriving
           * at either file sees it. So the pair is all-or-nothing, and the check has to come first
           * because the alternative is not recoverable: stamping `src` and then finding `dst` gone
           * leaves a `<link>` pointing at a path the tree does not hold — a dangling href committed by
           * the commit that created it — while the other half of the conflict is invisible.
           *
           * A missing endpoint is ORDINARY here, not exceptional. Every phase reads its candidates from
           * an index refreshed once in preflight and not again, so a file an earlier phase archived is
           * still listed active at its old path when this phase reads it. `readFileBytes` answers
           * `undefined` for exactly that case, and the TREE is the system of record.
           */
          const haveSrc = yield* readFileBytes(env, candidate.pair.src)
          const haveDst = yield* readFileBytes(env, candidate.pair.dst)
          if (haveSrc === undefined || haveDst === undefined) continue

          // `addLink` is idempotent on the pair, so a re-promotion writes nothing.
          const wroteSrc = yield* stampFile(env, candidate.pair.src, [
            link("contradicts", hrefFor(candidate.pair.dst)),
            meta("memhtml-updated", env.at)
          ])
          const wroteDst = yield* stampFile(env, candidate.pair.dst, [
            link("contradicts", hrefFor(candidate.pair.src)),
            meta("memhtml-updated", env.at)
          ])

          /**
           * The counter is promoted only when BOTH sides gained the edge on this run. `stampFile`'s
           * `false` also covers "the head already said this", so a pair whose files were somehow
           * stamped without the counter being promoted stays un-promoted — and therefore RE-ELIGIBLE,
           * which is the outcome that lets a later night with a refreshed index finish the job rather
           * than record a half-written edge as done.
           */
          /**
           * The counter is promoted only when BOTH sides gained the edge on this run. `stampFile`'s
           * `false` also covers "the head already said this", so a pair whose files were somehow
           * stamped without the counter being promoted stays un-promoted — and therefore RE-ELIGIBLE,
           * which is the outcome that lets a later night with a refreshed index finish the job rather
           * than record a half-written edge as done.
           */
          if (!wroteSrc || !wroteDst) continue

          yield* markPromoted(env.deps.db, {
            srcPath: candidate.pair.src,
            rel: "contradicts",
            dstPath: candidate.pair.dst,
            at: env.at
          })
          promoted += 1
          continue
        }

        if (!isDirectionalRel(verdict.rel)) continue
        if (promoted + typed >= EDGE_PROMOTION_CAP) {
          capped += 1
          continue
        }

        /**
         * ONE file, the subject's. A directional rel read from the wrong end inverts its meaning —
         * `caused_by` written into the cause instead of the effect says the opposite of what the
         * model answered — so the direction decides the file and the href together, from one
         * statement, and cannot disagree with itself.
         */
        const [subject, object] =
          verdict.direction === "src_to_dst"
            ? [candidate.pair.src, candidate.pair.dst]
            : [candidate.pair.dst, candidate.pair.src]
        const wrote = yield* stampFile(env, subject, [
          link(verdict.rel, hrefFor(object)),
          meta("memhtml-updated", env.at)
        ])
        // `false` means the link was already there, or the file is gone. Neither is a new edge.
        if (wrote) typed += 1
      }
    }

    const counts = {
      candidates: candidates.length,
      judged,
      typed,
      contradictions,
      promoted,
      skipped,
      capped,
      duplicates
    }
    if (promoted === 0 && typed === 0) return { counts, commitSha: null, llmCalls }

    const commitSha = yield* commitPhase(
      env,
      "edge-typing",
      `promote ${typed} typed edges and ${promoted} corroborated contradictions`,
      counts
    )
    return { counts, commitSha, llmCalls }
  })
