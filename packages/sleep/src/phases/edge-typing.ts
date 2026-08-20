import type { StorageFailure } from "@memhtml/contracts/errors"
import { MEMORY_EXTENSION, normalizePath } from "@memhtml/contracts/paths"
import { escapeAttribute, escapeText, parseMemory } from "@memhtml/html"
import { STATE_SCHEMA } from "@memhtml/index"
import type { GitFailure } from "@memhtml/store"
import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import { hrefFor, link, meta, readFileBytes, stampFile } from "../edits.js"
import { modelFor, type PhaseBody, type PhaseEnv } from "../env.js"
import {
  assertsContradiction,
  assertsEdge,
  EDGE_TYPING_SYSTEM,
  EdgeTyping,
  edgeTypingPrompt,
  isDirectionalRel,
  pairText
} from "../llm.js"
import { closeTask, type DetectedFinding, makeMinter } from "../mint.js"
import {
  activeCorpus,
  bumpCorroboration,
  markPromoted,
  minedPairs,
  openDetectedTasks,
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

/**
 * The detector segment of every task this phase mints, and the range `openDetectedTasks` brackets.
 *
 * Equal to the phase name deliberately: a finding key names the phase that has to recognize it next
 * night, and `edge-typing` is also the `Memhtml-Phase` trailer, so one string identifies the detector
 * in the file, in the index range, and in the commit. It is a PREFIX of nothing and has `edge` as its
 * own prefix, which is the case `sql.ts:208-244`'s explicit key range exists to keep separate.
 */
export const EDGE_DETECTOR = "edge-typing"

/**
 * Characters of each side's evidence quoted into a `resolve:` task.
 *
 * Far narrower than {@link EDGE_PAIR_SIDE_CHARS}, and for a different purpose: the model's budget is
 * how much text it needs to JUDGE the pair, and this is how much a human needs to SEE to recognize
 * the conflict. Two paragraphs of ~300 characters is a screenful a reviewer reads at once, and the
 * task's job is to send them to the two files rather than to reproduce them.
 *
 * Cut at a WORD boundary and with NO ellipsis appended, which is a correctness requirement rather
 * than a nicety: the quote has to remain findable in the source, both for the closer's evidence-gone
 * arm below and for doctor's stale-quote check. A prefix of the source's collapsed text is contained
 * in it; a prefix plus `…` is not, so every minted task would report its own evidence as gone.
 */
export const EDGE_QUOTE_CHARS = 300

/** One candidate pair with both endpoints' text, ready to be keyed. */
interface TypingCandidate {
  readonly pair: PairRow
  readonly srcText: string
  readonly dstText: string
  /**
   * Each endpoint's ARTICLE TEXT alone, which is what a minted quote is drawn from.
   *
   * Separate from {@link TypingCandidate.srcText} because that one is `gist + "\n" + body_text` — and
   * `files.body_text` is already the whole article's text INCLUDING the gist
   * (`packages/index/src/project.ts` projects `doc.article.bodyText`). Quoting the prompt's text
   * would therefore emit `claim claim body…`, a string that does NOT occur in the endpoint file, so
   * the quote would be unverifiable the instant it was written — stale to the closer's evidence-gone
   * arm and to doctor's `staleQuotes` at once. `body_text` is exactly `parseMemory`'s
   * `article.bodyText`, whitespace-collapsed by the same function on both sides of the comparison.
   */
  readonly srcBody: string
  readonly dstBody: string
}

/** A memory path's filename without its extension, for a claim a human reads in an inbox. */
const basenameOf = (path: string): string => {
  const name = normalizePath(path).split("/").pop() ?? path
  return name.endsWith(MEMORY_EXTENSION) ? name.slice(0, -MEMORY_EXTENSION.length) : name
}

/**
 * `edge:<a>\0<b>` with the two paths SORTED — a `resolve:` task's whole identity.
 *
 * Sorted because a contradiction is symmetric and the two candidate arms orient their pairs
 * differently ({@link unionPairs} keeps whichever arm saw the pair first). A fingerprint carrying the
 * orientation would re-file the same question as a new task on the night the arms' order changed,
 * while the old task looked absent. `\0` as the separator because it cannot occur in a path, so no
 * two distinct pairs concatenate into one fingerprint.
 */
export const resolveFingerprint = (left: string, right: string): string => {
  const [a, b] = normalizePath(left) < normalizePath(right) ? [left, right] : [right, left]
  return `edge:${normalizePath(a)}\u0000${normalizePath(b)}`
}

/**
 * One side's evidence quote: its article text, cut at a word boundary inside {@link EDGE_QUOTE_CHARS}.
 *
 * Whitespace is collapsed first, so the quote written into the task is already in the form the
 * containment check compares — the closer and doctor both collapse the source, and a quote carrying
 * the file's own line breaks would only match after they did.
 */
export const evidenceQuote = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= EDGE_QUOTE_CHARS) return flat
  const cut = flat.slice(0, EDGE_QUOTE_CHARS)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace <= 0 ? cut : cut.slice(0, lastSpace)).trim()
}

/**
 * True when `quote` occurs in `text` with runs of whitespace collapsed on BOTH sides.
 *
 * **A deliberate three-line twin** of `apps/cli/src/doctor.ts`'s `quoteAppearsIn` and
 * `apps/consolidator/src/contract.ts`'s, not an import: the three live in a package and two apps that
 * cannot import each other, and the rule is short enough that the copies are cheaper than a shared
 * door. They must AGREE — a fix to one is ported, never unified — because this one decides whether a
 * task CLOSES and doctor's decides whether the same task is REPORTED, and a disagreement would show
 * up as a task doctor flags forever and the closer never reaches.
 *
 * Collapsing whitespace is the only normalization. Case and punctuation compare as written, because
 * each is a way the source could have changed in a way that changes what it says — which is exactly
 * the human edit the evidence-gone arm is looking for.
 */
const quoteAppearsIn = (quote: string, text: string): boolean => {
  const flatten = (value: string): string => value.replace(/\s+/g, " ").trim()
  const needle = flatten(quote)
  /** An empty needle is `includes`-true against anything, which would close nothing honestly. */
  if (needle === "") return false
  return flatten(text).includes(needle)
}

/**
 * One `resolve:` finding: the pinned claim, both sides quoted with their paths, and the model's own
 * reason for suspecting the conflict.
 *
 * **`bodyHtml`, not prose paragraphs, and the element is `<q cite>`.** A cited quote per side cannot
 * be expressed as prose, and `<blockquote>` is outside `@memhtml/html`'s closed vocabulary — a task
 * minted with one carries an `unknown:blockquote` warning forever AND its quoted text never reaches
 * `article.citations`, which is the projection BOTH the closer below and doctor's stale-quote check
 * read. The evidence would be unverifiable by the two mechanisms that exist to verify it
 * (`mint.ts`'s `DetectedFinding.bodyHtml` records the measurement; `tests/mint.test.ts` pins it).
 *
 * **The two `cite` attributes are the closer's ONLY route back to the endpoints, which couples this
 * template to {@link resolveClosure}.** The finding key is a sha256 digest, so the paths cannot be
 * recovered from it, and no head meta in the format carries a pair. So the closer reads the task's
 * citations and treats their two hrefs as `src` and `dst`. A change here that dropped a `cite`, cited
 * something other than an endpoint, or emitted a third citation would silently stop the closer from
 * recovering the pair — and the task would then never close by any arm.
 *
 * **The rationale is UNTRUSTED MODEL TEXT and lands in a prose paragraph, escaped, and nowhere
 * else** — never in the `cite`, the `title`, or the `claim`. It is a sentence a model wrote about a
 * corpus that stores instructions.
 */
export const resolveFinding = (input: {
  readonly src: string
  readonly dst: string
  readonly srcQuote: string
  readonly dstQuote: string
  readonly confidence: number
  readonly rationale: string | undefined
}): DetectedFinding => {
  /**
   * The claim names the pair in SORTED order, the same order the fingerprint uses, so the claim — and
   * therefore the title, the slug, and the file path — is a function of the unordered pair. Naming
   * them in `src`/`dst` order would make the FILENAME depend on which candidate arm saw the pair
   * first, so the same finding would slug two ways across two nights while its key stayed stable.
   */
  const [first, second] =
    normalizePath(input.src) < normalizePath(input.dst)
      ? [input.src, input.dst]
      : [input.dst, input.src]
  const claim = `resolve: ${basenameOf(first)} and ${basenameOf(second)} may contradict`
  const cited = (path: string, quote: string): string =>
    `<p><q cite="${escapeAttribute(hrefFor(path))}">${escapeText(quote)}</q></p>`
  const rationale = (input.rationale ?? "").replace(/\s+/g, " ").trim()
  const verdictLine =
    rationale === ""
      ? `The model judged these two claims contradictory at ${input.confidence.toFixed(2)} confidence and gave no reason. One machine sighting is not corroboration, so nothing was written into either file.`
      : `The model judged these two claims contradictory at ${input.confidence.toFixed(2)} confidence, stating, unverified: ${rationale}`
  return {
    detector: EDGE_DETECTOR,
    fingerprint: resolveFingerprint(input.src, input.dst),
    title: claim,
    claim,
    bodyHtml: [
      `<p><mark>${escapeText(claim)}</mark></p>`,
      cited(input.src, input.srcQuote),
      cited(input.dst, input.dstQuote),
      `<p>${escapeText(verdictLine)}</p>`
    ].join("\n")
  }
}

/** Whether a promoted `contradicts` counter exists for a pair, in EITHER orientation. */
const contradictionPromoted = (
  db: PhaseEnv["deps"]["db"],
  left: string,
  right: string
): Effect.Effect<boolean, StorageFailure> =>
  /**
   * **BOTH orientations, and nothing makes one enough.** `edge_corroboration` is keyed on
   * `(src_path, rel, dst_path)` in whatever order the CANDIDATE arm produced — `unionPairs` keeps
   * whichever arm saw the pair first — while a task's citations are written in the mint's own sorted
   * order. The two coincide on some corpora and not on others, and a one-sided lookup would answer
   * `false` for every pair where they disagree, so those tasks would survive their own promotion
   * forever.
   *
   * Found by mutation on 2026-08-19: dropping the second disjunct left all fifteen cases here GREEN,
   * because the fixture's flip pair happens to orient the same way both times. The reversed-orientation
   * case now pins it.
   *
   * A small SELECT here rather than a new `sql.ts` helper, per this phase's own style for a read no
   * other caller wants. Guarded on `hasState` the way `accessRows` is: the durable plane is optional,
   * and a caller that attached only the rebuildable index has no such table to ask.
   */
  db.hasState
    ? db
        .get<{ readonly n: number }>(
          `SELECT count(*) AS n FROM ${STATE_SCHEMA}.edge_corroboration
           WHERE rel = 'contradicts' AND promoted = 1
             AND ((src_path = ? AND dst_path = ?) OR (src_path = ? AND dst_path = ?))`,
          [left, right, right, left]
        )
        .pipe(Effect.map((row) => (row?.n ?? 0) > 0))
    : Effect.succeed(false)

/** What one night's closure pass did, for the phase to fold into its counts and its commit. */
interface ResolveClosure {
  readonly closed: number
  /** Reasons in closure order, for the commit body. There is nowhere in the FORMAT for a reason. */
  readonly reasons: ReadonlyArray<string>
  /** True when a real archive move was staged, so the phase knows it owes a commit. */
  readonly staged: boolean
}

/**
 * The EXPLICIT closer over this detector's open tasks. Runs every night the phase runs, including a
 * night with no model at all.
 *
 * **This phase never closes by absence, and the closer is why.** `closeAbsent` reads "the detector
 * did not detect this finding tonight" as evidence the finding is gone, and that inference is sound
 * only for a detector that looked EVERYWHERE. This one does not: {@link EDGE_TYPING_CANDIDATE_LIMIT}
 * caps the candidate scan at 200 of a corpus's thousands of pairs, ranked by similarity, so a pair
 * filed last night is routinely not even offered tonight — a truthful `universeComplete` is
 * unreachable here, and an untruthful one would archive the whole `resolve:` backlog on the first
 * night the corpus grew. So closure is decided by asking about EACH OPEN TASK's own pair instead, and
 * the cost is bounded by the open-task count rather than by the scan.
 *
 * **Deterministic, hence its position: BEFORE the model-dependent early returns.** Every one of the
 * three arms is a SQL read or a file read, so a night with no credentials — which is every CI run and
 * every unconfigured install — still promotes-and-closes, still notices an archived endpoint, and
 * still notices a human editing the contradiction away. Wiring it after the `model === undefined`
 * return would have made a corpus's `resolve:` tasks immortal on exactly the nights nothing else
 * happens.
 *
 * Three closing arms, each with its own reason:
 *
 * - **`promoted to edge`.** The corroboration counter says a second night confirmed the pair and both
 *   files gained the `contradicts` link. The contradiction is now FILE-BORNE, so the task asking a
 *   human to look at it is moot — the fact is in the corpus where a reader will meet it.
 * - **`endpoint gone`.** One side is not an active file. Archived counts: eviction is a `git mv`, and
 *   a contradiction with an evicted memory is not a live conflict a human can resolve. The tree is
 *   the system of record here as everywhere in this package, so "not active" is `readFileBytes`
 *   answering nothing at the cited path — which covers an archive move and a deletion with one read.
 * - **`evidence gone`.** Both endpoints are active and one's cited quote no longer occurs in it. That
 *   is the human editing the very text the detector flagged, which IS the finding being resolved.
 *   The Gate-1 critic named this the load-bearing clause and it is: without it, the ordinary way a
 *   contradiction gets fixed leaves its task open forever, and an inbox nobody can empty is an inbox
 *   nobody reads.
 *
 * **The status guard applies to ONE arm, not to all three**, which is the split the packet's §9
 * decides and the reason it is not `closeAbsent`'s blanket rule. `promoted` and `endpoint gone` are
 * facts about the TREE: whoever moved the task to `doing` is working on a question the corpus has
 * already answered, and leaving it open would have them resolve a conflict that is written down or
 * gone. `evidence gone` is the opposite — a human mid-fix is the most likely reason a quote stopped
 * matching, and archiving their task from under them is precisely what the todo-only rule exists to
 * prevent. So a non-`todo` task closes on the first two arms and is left alone by the third.
 */
const resolveClosure = (
  env: PhaseEnv
): Effect.Effect<ResolveClosure, StorageFailure | GitFailure> =>
  Effect.gen(function* () {
    const open = yield* openDetectedTasks(env.deps.db, EDGE_DETECTOR)
    let closed = 0
    const reasons: Array<string> = []
    let staged = false

    for (const row of open) {
      /**
       * The task's own bytes, not the index's row. A task an earlier phase already archived is still
       * listed open here (the index is refreshed once, in preflight), and the tree decides.
       */
      const html = yield* readFileBytes(env, row.path)
      if (html === undefined) continue
      const doc = yield* parseMemory(html).pipe(Effect.orElseSucceed(() => undefined))
      if (doc === undefined) continue

      /**
       * The endpoints, recovered from the task's `<q cite>` hrefs — see {@link resolveFinding} for
       * the coupling this depends on. EXACTLY two cited paths, because a `resolve:` task quotes one
       * side each: fewer means the template changed or a human edited the evidence out, and more
       * means this is not a pair task. Either way the closer cannot say which two memories the
       * finding is about, and guessing would close the wrong task, so it leaves this one alone.
       */
      const citedPaths = [
        ...new Set(
          doc.article.citations.flatMap((one) =>
            one.href === undefined ? [] : [normalizePath(one.href)]
          )
        )
      ]
      const [src, dst] = citedPaths
      if (citedPaths.length !== 2 || src === undefined || dst === undefined) {
        /**
         * **The IMMORTAL-TASK case, and it is the one skip in this loop that never resolves.** This phase
         * has no absence pass, so declining here means no arm can ever reach the task: it is not closable
         * by promotion, by a gone endpoint, or by a stale quote, and it sits in the inbox until a human
         * deletes it. Every other `continue` above is transient — an unreadable file, a parse failure, an
         * endpoint that will parse next night.
         *
         * So it is LOGGED, which is where somebody asking why one `resolve:` task never leaves finds the
         * answer, and the cited count is in the line because that is the whole diagnosis: one path means a
         * hand-edit removed a quote, three means the file is not a pair task. Counted nowhere for the same
         * reason the todo-only skip below is not — `closureSkipped` means "the absence pass was withheld",
         * and this phase has no absence pass.
         */
        yield* Effect.logInfo(
          `sleep.edge-typing left ${row.path} open: its citations name ${String(citedPaths.length)} ` +
            "path(s), not the two endpoints a resolve task is about, so no closing arm can reach it"
        )
        continue
      }

      /** Closed regardless of status: the fact is file-borne now, so the task is moot. */
      if (yield* contradictionPromoted(env.deps.db, src, dst)) {
        if (yield* closeOne(env, row.path)) {
          closed += 1
          staged = !env.dryRun
          reasons.push(`${row.path}: promoted to edge`)
        }
        continue
      }

      const srcHtml = yield* readFileBytes(env, src)
      const dstHtml = yield* readFileBytes(env, dst)
      /** Closed regardless of status: there is no live conflict left for a human to resolve. */
      if (srcHtml === undefined || dstHtml === undefined) {
        if (yield* closeOne(env, row.path)) {
          closed += 1
          staged = !env.dryRun
          reasons.push(`${row.path}: endpoint gone`)
        }
        continue
      }

      /**
       * Both endpoints parsed, or this arm declines. An unparseable endpoint is `doctor`'s finding,
       * and reading it as "the quote is gone" would close a task over an unrelated defect.
       */
      const srcDoc = yield* parseMemory(srcHtml).pipe(Effect.orElseSucceed(() => undefined))
      const dstDoc = yield* parseMemory(dstHtml).pipe(Effect.orElseSucceed(() => undefined))
      if (srcDoc === undefined || dstDoc === undefined) continue

      const textOfCited = new Map([
        [src, srcDoc.article.bodyText],
        [dst, dstDoc.article.bodyText]
      ])
      const stale = doc.article.citations.some((one) => {
        if (one.href === undefined) return false
        const source = textOfCited.get(normalizePath(one.href))
        return source !== undefined && !quoteAppearsIn(one.text, source)
      })
      if (!stale) continue

      /**
       * The ONE arm the todo-only rule guards. Counted nowhere — `closureSkipped` means "the whole
       * absence pass was withheld" and this phase has no absence pass — so it is logged, which is
       * where an operator asking why a `doing` task survived a quote edit will find the answer.
       */
      if (row.task_status !== "todo") {
        yield* Effect.logInfo(
          `sleep.edge-typing left ${row.path} open: evidence gone but task_status is ${row.task_status}`
        )
        continue
      }
      if (yield* closeOne(env, row.path)) {
        closed += 1
        staged = !env.dryRun
        reasons.push(`${row.path}: evidence gone`)
      }
    }

    return { closed, reasons, staged }
  })

/**
 * Close one task through the kernel's primitive, or count the closure without performing it on a dry
 * run.
 *
 * `closeTask` rather than a local `stampFile` + `archiveFile` pair, so this phase's closures and the
 * three other detectors' are one operation: the `done` stamp rides the `git mv`'s `extraEdits`, and
 * the tree never holds a task that is archived and still `todo`. Its `null` means the live path held
 * no file, which is no closure.
 */
const closeOne = (
  env: PhaseEnv,
  path: string
): Effect.Effect<boolean, StorageFailure | GitFailure> =>
  env.dryRun ? Effect.succeed(true) : closeTask(env, path).pipe(Effect.map((at) => at !== null))

/**
 * Run the closer and fold it into an outcome, on a night that judges nothing.
 *
 * **The three degraded returns below have to run the closer themselves**, and this is what makes each
 * of them one line rather than five: a no-model night, a night whose scan found no candidate, and a
 * dry run each used to return `emptyOutcome` — which would now skip the whole closure pass on exactly
 * the nights the phase does nothing else. Those are the nights an operator is least likely to look at
 * a report, so an immortal `resolve:` backlog would accumulate invisibly.
 *
 * A staged closure gets its OWN commit here rather than being left in the index. Leaving it would hand
 * the move to whichever later phase commits next, and that commit's `Memhtml-Phase` trailer would
 * attribute this phase's closure to that one — so `memhtml sleep resume` would skip the phase that
 * actually owns the write.
 */
const closureOnly = (
  env: PhaseEnv,
  counts: Record<string, number>,
  detail?: string
): Effect.Effect<
  {
    readonly counts: Record<string, number>
    readonly commitSha: string | null
    readonly llmCalls: 0
  },
  StorageFailure | GitFailure
> =>
  Effect.gen(function* () {
    const closure = yield* resolveClosure(env)
    const final = { ...counts, ...(closure.closed === 0 ? {} : { taskClosed: closure.closed }) }
    const commitSha = closure.staged
      ? yield* commitPhase(
          env,
          "edge-typing",
          `close ${closure.closed} resolve task(s)`,
          final,
          closureBody(closure)
        )
      : null
    return { counts: final, commitSha, llmCalls: 0, ...(detail === undefined ? {} : { detail }) }
  })

/**
 * The closure reasons as a commit body.
 *
 * **The reason goes in the COMMIT and nowhere else, because there is nowhere else.** No head meta in
 * the format carries a closure reason, and `closeTask` records exactly that. The commit is also where
 * a reviewer asking why a task disappeared is already reading. `commitPhase` indents the body, which
 * is the trailer-injection guard — every path here is this package's own text, but the guard is
 * unconditional and stays so.
 */
const closureBody = (closure: ResolveClosure): string =>
  [`Closed ${closure.closed} resolve task(s):`, ...closure.reasons.map((one) => `- ${one}`)].join(
    "\n"
  )

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
    /**
     * **Every terminal path runs the closer, including the three degraded ones.** It is deterministic —
     * SQL and file reads only — so a no-model night, a candidate-free night, and a dry run all still
     * close what the corpus says is closed. See {@link resolveClosure} for why this phase closes
     * explicitly instead of by absence.
     *
     * On the FULL path it runs LAST, after the judging, and the ordering is load-bearing: a pair the
     * model corroborates tonight is promoted into both files tonight, so its `resolve:` task is moot
     * the moment `markPromoted` lands. A closer that ran first would leave that task open for a whole
     * extra night, asking a human to resolve a contradiction the same commit just wrote down.
     */
    const model = env.deps.model
    if (model === undefined) {
      return yield* closureOnly(env, { candidates: 0, judged: 0 }, "no model bound")
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
    if (candidates.length === 0) return yield* closureOnly(env, zero)
    if (env.dryRun) return yield* closureOnly(env, { ...zero, candidates: candidates.length })

    const corpus = yield* activeCorpus(env.deps.db)
    const textOf = new Map(corpus.map((row) => [row.path, `${row.gist}\n${row.body_text}`]))
    /** The ARTICLE text alone, which is what a minted quote is drawn from. See {@link TypingCandidate}. */
    const bodyOf = new Map(corpus.map((row) => [row.path, row.body_text]))

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
      withText.push({
        pair,
        srcText,
        dstText,
        srcBody: bodyOf.get(pair.src) ?? "",
        dstBody: bodyOf.get(pair.dst) ?? ""
      })
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

    /**
     * The minting pass, constructed BEFORE the batch loop so its open-task snapshot is taken at phase
     * start rather than part-way through, and every below-gate contradiction the night finds is
     * offered to the same dedup state.
     *
     * **NO `restatementDedup`, deliberately.** The kernel's claim-Jaccard arm is opt-in
     * (`mint.ts:84-90`) precisely because it is wrong for TEMPLATED claims, and this phase's claim is
     * a template: `resolve: a and b may contradict` against `resolve: a and c may contradict` share
     * every token but one, so two genuinely different contradictions that happen to share an endpoint
     * would score far above the 0.6 floor and the second would be silently dropped as a restatement.
     * Under a template the exact finding key IS the identity, and distinct fingerprints are distinct
     * work items.
     */
    const minter = yield* makeMinter(env, EDGE_DETECTOR)
    /**
     * Findings collected across every batch, keyed by fingerprint, submitted in ONE sorted pass after
     * the loop.
     *
     * **Sorted submission is required by the cap, not by tidiness.** `MINT_CAP` bounds what one night
     * writes and counts the rest as `mintOverflow`, so submission ORDER decides which ten findings
     * become files — and submitting inline would make that order the MODEL's verdict order, which is
     * not reproducible across two runs over an unchanged corpus. Fingerprint order is a function of
     * the pair set alone, so the eleventh pair stays the eleventh pair until it is decided.
     */
    const deferred = new Map<string, DetectedFinding>()

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
            /**
             * **THE MINT: one machine sighting is not enough to write an edge, and is enough to ask a
             * human.** This is the branch the phase used to `continue` out of silently — a contradiction
             * the model asserted above the confidence floor, held back by the two-night corroboration
             * gate, which then existed only as a counter in the state plane. A reviewer had no way to
             * see it, and if the pair fell out of the capped candidate scan it was never seen again.
             * The task is where that sighting becomes visible without becoming an asserted fact.
             *
             * Minted only on a genuinely BELOW-GATE row: `promoted === 1` means the edge is already in
             * both files, so the question is answered and a task asking it would be noise the closer
             * would archive on its next pass. `row === undefined` is a bump that returned nothing,
             * which says nothing about the pair.
             *
             * Both quotes must be non-empty. An empty quote is `includes`-true against anything, so
             * the closer's evidence-gone arm could never verify it, and the task would be unclosable
             * evidence-wise — better not filed. A valid memory always has article text, so this is a
             * guard against a projection anomaly rather than an ordinary path.
             */
            if (row !== undefined && row.promoted === 0) {
              const srcQuote = evidenceQuote(candidate.srcBody)
              const dstQuote = evidenceQuote(candidate.dstBody)
              if (srcQuote !== "" && dstQuote !== "") {
                const finding = resolveFinding({
                  src: candidate.pair.src,
                  dst: candidate.pair.dst,
                  srcQuote,
                  dstQuote,
                  confidence: verdict.confidence,
                  rationale: verdict.rationale
                })
                /**
                 * DEFERRED, not submitted here — see the sorted pass after the batch loop. One pair
                 * reached twice keeps the FIRST finding, the same choice `answered` makes about
                 * repeated verdicts and `unionPairs` makes about a pair in both arms.
                 */
                if (!deferred.has(finding.fingerprint)) deferred.set(finding.fingerprint, finding)
              }
            }
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

    /** The night's below-gate contradictions, offered in fingerprint order. See {@link deferred}. */
    for (const fingerprint of [...deferred.keys()].sort()) {
      const finding = deferred.get(fingerprint)
      if (finding === undefined) continue
      yield* minter.submit(finding)
    }
    /**
     * `finish` and NOT `closeAbsent`. This phase closes explicitly instead — the candidate scan is
     * capped and sampled, so "not detected tonight" is not evidence a finding is gone. See
     * {@link resolveClosure}.
     */
    const mintReport = minter.finish()

    /**
     * The closure pass, AFTER the judging — see the note at the top of the phase. A pair promoted a few
     * lines above is promoted in the tree and in the counter, so its task closes on this same night
     * rather than surviving until the next one.
     */
    const closure = yield* resolveClosure(env)

    const counts = {
      candidates: candidates.length,
      judged,
      typed,
      contradictions,
      promoted,
      skipped,
      capped,
      duplicates,
      ...mintReport.counts,
      ...(closure.closed === 0 ? {} : { taskClosed: closure.closed })
    }
    /**
     * The commit gate asks about the MINT and the CLOSURE too, not only the two kinds of edge. A night
     * whose only output was three `resolve:` tasks, or one closure, has staged files — and returning
     * `null` here would leave them for whichever later phase commits next, whose `Memhtml-Phase`
     * trailer would then attribute this phase's writes to that one, so a resume would skip the phase
     * that owns them.
     */
    if (promoted === 0 && typed === 0 && mintReport.minted.length === 0 && !closure.staged) {
      return { counts, commitSha: null, llmCalls }
    }

    const commitSha = yield* commitPhase(
      env,
      "edge-typing",
      /**
       * A MINT-ONLY night says what it did, mirroring `dedup-merge`'s arm on its own subject.
       *
       * The unconditional edge subject read `promote 0 typed edges and 0 corroborated contradictions` on
       * exactly the commit that filed new findings — and that is the ORDINARY first night for any pair,
       * because the corroboration gate holds every new sighting back for a second night. So the one line a
       * human reads in `git log` described a night that did nothing, while the commit carried task files.
       *
       * The edge subject wins whenever an edge was written, so this is a branch and not a rename: a night
       * that promoted one contradiction AND closed a task still reports the promotion, which is the write
       * a reviewer is auditing. The closure-only subject is `closureOnly`'s and is not reached from here.
       */
      promoted === 0 && typed === 0 && mintReport.minted.length > 0
        ? "file resolve: tasks for detected contradictions"
        : `promote ${typed} typed edges and ${promoted} corroborated contradictions`,
      counts,
      /**
       * The closure reasons, in the commit because the format has nowhere else to carry one — the same
       * decision `entity-resolution` records and `closeTask` states. Absent on a night that closed
       * nothing, so an ordinary night's commit is the one it was.
       */
      closure.closed === 0 ? undefined : closureBody(closure)
    )
    return { counts, commitSha, llmCalls }
  })
