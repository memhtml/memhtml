import {
  connectedComponents,
  MAX_MERGE_PAIRS,
  type MergeDecision,
  type MergePair,
  mergeCandidates,
  mergeVetoed,
  NEAR_DUPLICATE_THRESHOLD,
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent
} from "@memhtml/domain"
import { escapeAttribute, escapeText } from "@memhtml/html"
import { Effect } from "effect"

import { batchCall, type KeyedMember, keyMembers, packGroups, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import type { PhaseCounts } from "../contract.js"
import { archiveFile, hrefFor, link, meta, stampFile } from "../edits.js"
import {
  modelFor,
  type PhaseBody,
  type PhaseEnv,
  type PhaseOutcome,
  type SleepError
} from "../env.js"
import { DEDUP_SYSTEM, dedupPrompt, MergePartition } from "../llm.js"
import { type DetectedFinding, type MintReport, makeMinter } from "../mint.js"
import {
  activeCorpus,
  type CorpusRow,
  frameKeyPairs,
  neighborPairs,
  SLEEP_EXCLUDED_TYPES
} from "../sql.js"

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
 * ## The vetoed pair becomes a `review:` task
 *
 * A veto is a REFUSAL to decide, not a decision. Two memories at 0.93 cosine whose texts disagree about
 * a polarity, a number, or a variant are either a duplicate the guard read too literally or a real
 * contradiction one of them is wrong about — and nothing in this phase can tell which. Before this arm
 * existed the whole answer was `vetoed: 1` in a commit trailer, which no human ever reads and which the
 * next night reports identically forever. So each true veto above {@link NEAR_DUPLICATE_THRESHOLD}
 * mints one `review:` task quoting BOTH sides, and the finding key makes the second night recognize
 * the first night's task instead of filing it again.
 *
 * **The vetoes are RE-DERIVED per pair, not read off the `vetoed` count.** That counter is a residual —
 * `proposed.length - decisions.length` — and `mergeCandidates` drops a pair for four different reasons:
 * the veto, a self-merge, the both-roles guard, and the per-night cap. Minting off the residual would
 * file a task about a pair whose only problem was that its keeper had already been claimed by an
 * earlier fold, which is a pair that needs no human at all and which the next night simply merges. So
 * this arm re-applies {@link mergeVetoed} to each undecided pair and mints only where it answers true.
 *
 * **Only the model-bound arm may attest `universeComplete`.** Closure means "the finding is gone", and
 * absence is evidence only from a detector that looked everywhere. The deterministic arm mines at 0.92
 * and can propose nothing else, so a pair the MODEL grouped last night — a frame seed, a recall-band
 * restatement — is invisible to it, and a no-model night reading that silence as "no longer vetoed"
 * would archive the task while the divergence is still on disk. Even with a model bound, four caps can
 * hide a pair: {@link DEDUP_PAIR_LIMIT}, {@link DEDUP_MAX_COMPONENTS}, `packGroups`'s member and
 * character budgets, and `MAX_MERGE_PAIRS`. Each is checked, because a cap that truncated is a night
 * that did not look everywhere.
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

/**
 * Characters of each side's own text quoted into a `review:` task, cut at a word boundary.
 *
 * A reviewer opening the task has to see WHAT diverges without opening either file, and the divergence
 * is a `not`, a number, or a qualifier — always inside the claim and its first sentence or two. Three
 * hundred characters carries that with room to spare while keeping a two-quote task readable, and it is
 * a quarter of {@link DEDUP_MEMBER_CHARS}, which is the budget for a model reading for similarity
 * rather than a human reading one pair.
 *
 * The cut is at the last space inside the budget, because a quote is VERIFIED by containment: doctor's
 * stale-quote check asks whether the quoted run still appears in the cited file
 * (`apps/cli/src/doctor.ts`), and a cut mid-word is still a contiguous substring but reads as a typo in
 * the one place an operator is judging whether the evidence is real.
 */
export const DEDUP_QUOTE_CHARS = 300

/** The detector name every `review:` task this phase mints is keyed under. */
export const DEDUP_DETECTOR = "dedup-merge"

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

/** A path's last segment, for a claim a human reads. */
const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/**
 * One side's text as a quotable run: whitespace collapsed, cut to {@link DEDUP_QUOTE_CHARS} at the
 * last word boundary inside the budget.
 *
 * **The input is `body_text`, NOT {@link textFor}, and that is a correctness requirement rather than a
 * preference.** A quote is verified by CONTAINMENT — doctor's stale-quote check asks whether the quoted
 * run still appears in `article.bodyText` of the cited file (`apps/cli/src/doctor.ts`) — and `body_text`
 * IS that projection (`packages/index/src/project.ts:165`), which already opens with the gist. `textFor`
 * prepends the gist a SECOND time for the model's member list, so a quote cut from it reads
 * `<gist> <gist> <body>` and is not a substring of any file. Measured 2026-08-20 against
 * `DEDUP_CORPUS`'s flip: `bodyText` is `"A blue-green cutover … business hours. Connection draining …"`
 * and contains its own gist, so every task minted off `textFor` would report `quote-gone` on the night
 * it was written.
 *
 * Collapsed FIRST, because collapsed is the form both sides of that comparison take. A whitespace-collapsed
 * prefix of `body_text` cut at a space is a contiguous substring of `bodyText`, which is what makes the
 * containment hold by construction rather than by luck.
 */
const quotableText = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= DEDUP_QUOTE_CHARS) return flat
  const cut = flat.slice(0, DEDUP_QUOTE_CHARS)
  const lastSpace = cut.lastIndexOf(" ")
  return lastSpace <= 0 ? cut : cut.slice(0, lastSpace)
}

/**
 * Which of the three divergence predicates fired, named for the reviewer.
 *
 * `mergeVetoed` is the disjunction, so it says a pair diverges and not how. Re-asking each predicate
 * individually is three pure calls over text already in memory, and it turns the task's prose line from
 * "the veto refused this" into the sentence that tells a reviewer where to look: a `numeric` label
 * points them at the digits, a `negation` label at a `not`. More than one can fire, and they are
 * reported in the disjunction's own order so two pairs with the same divergence read the same way.
 */
const vetoLabelsFor = (keepText: string, dropText: string): ReadonlyArray<string> => [
  ...(negationDivergent(keepText, dropText) ? ["negation"] : []),
  ...(numericTokenDivergent(keepText, dropText) ? ["numeric"] : []),
  ...(variantQualifierDivergent(keepText, dropText) ? ["variant-qualifier"] : [])
]

/**
 * One vetoed pair as a finding: the templated claim, and an article whose two `<q cite>` quotes are the
 * evidence a reviewer judges.
 *
 * **The evidence element is `<q cite="/path">` inside a `<p>`, never `<blockquote>`.** `blockquote` is
 * outside `KNOWN_ELEMENTS`, so a task minted with one carries the constraint-6 warning forever AND its
 * quoted text never reaches `article.citations` — which is what doctor's stale-quote check and
 * `file_citations` both read, so the evidence would be unverifiable by anything. `packages/sleep/src/mint.ts`'s
 * `DetectedFinding.bodyHtml` pins the choice for all four minting phases and a kernel test holds it.
 *
 * The lead `<p>` carries the claim's `<mark>` and nothing else, because `articleHtml` is handed through
 * untouched: constraint 1 (exactly one `<mark>`, in the first block) is this caller's to satisfy.
 *
 * Both quotes and the paths inside `cite` go through the html package's own escapers rather than being
 * interpolated raw. Memory text is authored prose and holds `&` and `<` routinely, and an unescaped one
 * would either break the parse or silently swallow the rest of the quote — in the one file whose whole
 * purpose is showing a human what two files say.
 */
const vetoFinding = (
  pair: MergePair,
  keepText: string,
  dropText: string,
  quoteFor: (path: string) => string
): DetectedFinding => {
  const [first, second] = [pair.keepPath, pair.dropPath].toSorted()
  const labels = vetoLabelsFor(keepText, dropText)
  const claim = `review: ${basenameOf(pair.keepPath)} and ${basenameOf(pair.dropPath)} are near-duplicates vetoed for divergence`
  const quote = (path: string): string =>
    `<p><q cite="${escapeAttribute(hrefFor(path))}">${escapeText(quotableText(quoteFor(path)))}</q></p>`
  const reason =
    labels.length === 0
      ? // Unreachable from the caller, which mints only where `mergeVetoed` answered true — and the
        // disjunction is exactly these three predicates. Stated rather than asserted, so a fourth
        // predicate added to the veto without a label here degrades one sentence instead of throwing.
        "The divergence veto refused this pair."
      : `The divergence veto refused this pair on ${labels.join(" and ")}, at cosine ${pair.similarity.toFixed(4)}.`
  return {
    detector: DEDUP_DETECTOR,
    /**
     * SORTED paths, so the key is a fact about the unordered pair. Orientation is a function of
     * `created_at`, and a corrected `memhtml-created` would flip the keeper and re-file the same
     * finding under a second key — two tasks about one pair, forever.
     */
    fingerprint: `dedup:${first}\0${second}`,
    title: claim,
    claim,
    bodyHtml:
      `<p><mark>${escapeText(claim)}</mark></p>` +
      `<p>${escapeText(reason)}</p>` +
      quote(pair.keepPath) +
      quote(pair.dropPath)
  }
}

/** What one minting pass hands back to the commit: its counts, and its lines of the commit body. */
interface MintPass {
  readonly counts: PhaseCounts
  /** One line per minted or closed task. Empty when the pass did nothing. */
  readonly receipt: ReadonlyArray<string>
}

/**
 * Mint one `review:` task per TRUE veto among the pairs `mergeCandidates` did not commit, and close the
 * tasks whose vetoes are gone.
 *
 * The undecided set is derived by subtracting the committed decisions from the proposals, keyed on the
 * oriented pair. That is the same subtraction the `vetoed` counter reports as a scalar, and re-applying
 * `mergeVetoed` to each member is what separates the four reasons it conflates — see the phase header.
 *
 * The similarity gate is {@link NEAR_DUPLICATE_THRESHOLD} and not the recall floor, on the same
 * reasoning that keeps the merge floor at 0.92 when a model is bound: a pair at 0.87 whose texts
 * diverge is two different facts, which is the ordinary state of a corpus and not a finding. Only a pair
 * the cosine says is one claim while the text says it is two is worth a human's morning. `>=` rather
 * than `mergeCandidates`'s strict `>`, because the acceptance criterion is stated at/above the
 * threshold and a pair sitting exactly on it is the case the whole band argument is about.
 *
 * Submission is in sorted-fingerprint order, so which findings the kernel's mint cap holds back is a
 * function of the corpus rather than of the order two arms happened to propose pairs in.
 *
 * `quoteFor` answers a path with the text to QUOTE, which is `body_text` and not the model-facing
 * {@link textFor} join — see {@link quotableText} for why the two must not be confused.
 */
const mintVetoedPairs = (
  env: PhaseEnv,
  proposed: ReadonlyArray<MergePair>,
  decisions: ReadonlyArray<MergeDecision>,
  universeComplete: boolean,
  quoteFor: (path: string) => string
): Effect.Effect<MintPass, SleepError> =>
  Effect.gen(function* () {
    const committed = new Set(
      decisions.map((decision) => `${decision.keepPath} ${decision.dropPath}`)
    )
    const findings = proposed
      .filter((pair) => !committed.has(`${pair.keepPath} ${pair.dropPath}`))
      .flatMap((pair) => {
        if (pair.similarity < NEAR_DUPLICATE_THRESHOLD) return []
        const { keepText, dropText } = pair
        // Absent text is why `mergeCandidates` skipped the veto too, so there is nothing to re-apply
        // and nothing to quote. Every pair either arm builds carries both, from `textOf`.
        if (keepText === undefined || dropText === undefined) return []
        if (!mergeVetoed(keepText, dropText)) return []
        return [vetoFinding(pair, keepText, dropText, quoteFor)]
      })
      .toSorted((left, right) => (left.fingerprint < right.fingerprint ? -1 : 1))

    /**
     * NO `restatementDedup`. This detector's claims are TEMPLATED — two distinct vetoed pairs sharing
     * one file differ only in the other basename, which scores well above the Jaccard floor — so the
     * restatement arm would silently suppress the second pair's task forever with `taskDeduped` as the
     * only trace. Under a template a distinct fingerprint IS a distinct work item, which is exactly the
     * split `mint.ts`'s `CLAIM_JACCARD_FLOOR` records.
     */
    const minter = yield* makeMinter(env, DEDUP_DETECTOR)
    for (const finding of findings) yield* minter.submit(finding)
    const report: MintReport = minter.finish()
    const closure = yield* minter.closeAbsent(universeComplete)
    return {
      counts: { ...report.counts, ...closure },
      receipt: report.minted.map((task) => `filed ${task.path} (${task.findingKey})`)
    }
  })

export const dedupMerge: PhaseBody = (env) =>
  Effect.gen(function* () {
    const corpus = yield* activeCorpus(env.deps.db)
    const order = new Map(corpus.map((row, offset) => [row.path, offset]))
    const rowFor = new Map(corpus.map((row) => [row.path, row]))
    const textOf = new Map(corpus.map((row) => [row.path, textFor(row)]))
    /**
     * The QUOTABLE text of each path: `body_text` alone, which is `article.bodyText` as the projection
     * stored it. Separate from {@link textOf} because that one prepends the gist for the model's member
     * list, and a quote cut from it is not a substring of any file — see {@link quotableText}.
     */
    const quoteOf = (path: string): string => rowFor.get(path)?.body_text ?? ""

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
       *
       * It DOES mint: a pair the cosine proves and the veto refuses is a finding whichever arm found
       * it, and a night with no credentials is the night a reviewer most needs the file to say so. It
       * does NOT close, and the two are not symmetric — see the phase header's attestation note.
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
        (inner) => mintVetoedPairs(inner, oriented, decisions, false, quoteOf)
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
    const graph = connectedComponents(edges).filter((members) => members.length >= 2)
    const components = graph
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

    /**
     * The attestation, and every cap on the candidate path is a clause.
     *
     * Closure archives a human's open task on the strength of a finding's ABSENCE, so the question is
     * not "did the phase work" but "did it look everywhere a vetoed pair could be". Each cap below hides
     * candidates when it binds, and a hidden pair is a pair whose task would be closed as resolved while
     * its divergence is still on disk:
     *
     * - `skipped` — an isolated batch failure. Its components reached no model, so any group the model
     *   would have proposed inside them was never proposed, and a group pair is a pair only the model
     *   can put in front of the veto.
     * - {@link DEDUP_PAIR_LIMIT} — the mined set was cut, so pairs at the bottom of the `sim` ordering
     *   never became edges, never became components, and never reached the veto.
     * - {@link DEDUP_MAX_COMPONENTS} — components past the cost bound were dropped whole.
     * - {@link DEDUP_MAX_COMPONENT} — a large component was truncated to its lowest paths, so its
     *   remaining members' pairs are deferred. Not in the acceptance criterion's list and included
     *   anyway: it hides candidates by exactly the mechanism the other two do.
     * - `packGroups` — a group longer than {@link DEDUP_BATCH_MEMBERS} is sliced, which asks each half
     *   in ignorance of the other. Unreachable while {@link DEDUP_MAX_COMPONENT} is the smaller number,
     *   and checked rather than argued: the two constants are independent and either may move.
     * - `MAX_MERGE_PAIRS` — the decision pass stopped partway. The mint arm re-derives each veto itself,
     *   so a capped pair is still minted correctly; this clause is conservatism about the CLOSURE, whose
     *   error direction is archiving work a human still owes.
     */
    const minedTruncated = pairs.length >= DEDUP_PAIR_LIMIT
    const componentsTruncated = graph.length > DEDUP_MAX_COMPONENTS
    const memberTruncated = components.some((members) => members.length >= DEDUP_MAX_COMPONENT)
    const packSliced = batches.some((batch) =>
      batch.some((group) => group.length > DEDUP_BATCH_MEMBERS)
    )
    const universeComplete =
      skipped === 0 &&
      !minedTruncated &&
      !componentsTruncated &&
      !memberTruncated &&
      !packSliced &&
      decisions.length < MAX_MERGE_PAIRS

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
      (inner) => mintVetoedPairs(inner, proposed, decisions, universeComplete, quoteOf)
    )
    return { ...outcome, llmCalls }
  })

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
  mint: (env: PhaseEnv) => Effect.Effect<MintPass, SleepError>
): Effect.Effect<PhaseOutcome, SleepError> =>
  Effect.gen(function* () {
    /**
     * A DRY RUN still runs the mint pass, because that is where its counts come from — `taskMinted`
     * and `closureSkipped` are exactly the numbers an operator sizing a night wants, and the kernel is
     * itself dry-run aware: it computes every count and every placed path and skips only the two lines
     * that touch the tree. Nothing here commits on a dry run either, so the branch is on the ARCHIVE
     * loop alone rather than on the whole function as it was before this arm existed.
     */
    let merged = 0
    let vanished = 0
    if (env.dryRun) {
      merged = decisions.length
    } else {
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
    }

    const pass = yield* mint(env)
    const final = { ...base, merged, vanished, ...pass.counts }
    if (env.dryRun) return { counts: final, commitSha: null, llmCalls: 0 }

    /**
     * ONE commit for the folds AND the mints. The early return the two arms used to take when
     * `decisions` was empty is gone, because a night that folds nothing can still have a `review:` task
     * to file; `commitPhase` already answers "nothing staged" with a `null` sha, so an empty night costs
     * no commit without an early return arranging it.
     */
    const commitSha = yield* commitPhase(
      env,
      "dedup-merge",
      merged > 0 || pass.receipt.length === 0
        ? `fold ${merged} near-duplicates into canonicals`
        : "file review tasks for vetoed near-duplicates",
      final,
      /**
       * The reviewer-facing receipt, and the one place a CLOSURE REASON can go: no head meta in the
       * format carries one, so `mint.ts`'s `closeTask` states that a caller puts the reason in its own
       * phase commit — which is also where somebody asking why a task disappeared is already reading.
       */
      pass.receipt.join("\n")
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })
