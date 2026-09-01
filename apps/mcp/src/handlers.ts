import {
  archiveMemory,
  type BatchOpReport,
  type BatchWriteResult,
  batchWrite,
  claimFromProse,
  codeFor,
  correctMemory,
  type EmbedderShape,
  type layerApp,
  linkMemories,
  listMemories,
  messageFor,
  neighborsOf,
  proseTail,
  readMemory,
  recallMemories,
  reinforceMemories,
  resolveMemory,
  searchMemories,
  searchTraces,
  statusReport,
  traceLinks,
  type WriteParams,
  writeMemory
} from "@memhtml/cli"
import { InvalidMemory } from "@memhtml/contracts/errors"
import type { MemoryDoc } from "@memhtml/html"
import { parseFacetFilters } from "@memhtml/index"
import { Effect, type Layer } from "effect"

import { batchAbortFailure, type ToolFailure, toToolFailure } from "./failure.js"
import { pinnedUri } from "./resources.js"
import { MemhtmlToolkit } from "./tools.js"

/**
 * The handlers: decode → call the shared use case → shape the result. Nothing else.
 *
 * Every handler calls the SAME function the CLI command calls, which is what makes `memory_search`
 * and `memhtml search` provably one query rather than two that agree today. A handler that reached for a
 * repository directly would be a second implementation of the thing the operations module exists to
 * be the only copy of.
 *
 * Parameter names are snake_case because they are the MCP wire contract; the operations take
 * camelCase. That rename is the handlers' whole remaining job.
 */

/** The services a handler reaches for: the app layer's own output. */
type AppServices = Layer.Success<ReturnType<typeof layerApp>>

/**
 * Every handler's error translation, applied once.
 *
 * MCP has one error channel and it is prose, so a typed error's STRUCTURE cannot survive the
 * boundary. Everything a caller acts on can, folded into the one string the protocol carries:
 * `toToolFailure` composes the stable code, the reason with its actionable payload fields, and
 * suggestions phrased as tool calls this agent can make. Nothing leaks a driver message, a git argv,
 * or a memory body, because the reason is `messageFor`'s and each error class dropped those at its
 * adapter edge precisely so a tool response could not carry corpus content.
 *
 * **It has to be a `ToolFailure` and not an `AiError`.** `McpServer` catches an `AiError` FIRST and
 * rewrites it to a generic internal-error sentence unless its reason is `ToolParameterValidationError`
 * (effect 4.0.0-rc.109), so a typed failure delivered that way reaches its agent with the content
 * removed. A `ToolFailure` is what each tool's `failure:` schema declares, which puts it on the branch
 * that passes `.message` through verbatim. The two halves only work together: dropping the declaration
 * in `tools.ts` re-masks everything this function builds, and the wire test in `tests-integration` is
 * what holds that pair honest.
 *
 * The error type is `ToolFailure` for every handler and `kit.toLayer` checks it, so a handler that
 * failed with a raw domain error is a compile error rather than a masked response. `failure.ts` is the
 * single place the wire failure is produced.
 */
const handled = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ToolFailure, R> =>
  effect.pipe(Effect.mapError(toToolFailure))

/**
 * The head metadata as a flat string record.
 *
 * Flattened rather than typed per key: the wire schema is `Record<string, string>` because the head's
 * optional metas are genuinely open at the edges. A format version can add `memhtml-*` names, and a
 * client that had to know the closed set would break on the first addition. Numbers are stringified
 * because that is what the `<meta content>` attribute holds; a consumer that wants the number reads
 * the typed field on `memory_search` or `memory_list` instead.
 */
const metaRecord = (doc: MemoryDoc): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(doc.metas)) {
    if (value === undefined) continue
    out[key] = typeof value === "string" ? value : String(value)
  }
  for (const entity of doc.entities) out[`entity:${entity}`] = "true"
  for (const tag of doc.tags) out[`tag:${tag}`] = "true"
  return out
}

/**
 * An explicit `null` as an absent value.
 *
 * The parameter schemas accept `null` as well as absence, and `Optional` in `tools.ts` says why: the
 * derived JSON Schema advertises `null`, and a client that reads the schema and sends
 * `{"workspace": null}` for "no workspace" is doing the documented thing. The operations layer speaks
 * `undefined` for "not supplied" because `exactOptionalPropertyTypes` distinguishes an absent key from
 * a present one, so the two vocabularies meet HERE, once, rather than at each of fifteen call sites.
 */
const opt = <A>(value: A | null | undefined): A | undefined => value ?? undefined

/** Absent optional array as an empty one, so a handler never passes `undefined` downstream. */
const arr = <A>(value: ReadonlyArray<A> | null | undefined): ReadonlyArray<A> => value ?? []

/**
 * The article a write authored, from whichever of the two parameters arrived, or else a refusal.
 *
 * `body` and `article_html` are two ways to author ONE article, so exactly one of them is the whole
 * rule, and it is enforced here rather than in the schema on purpose. A `Schema.Union` of two structs
 * derives a JSON Schema `anyOf` over the FULL parameter object twice, so a client reading
 * `tools/list` sees two near-identical thirteen-field shapes, and a decode failure against a union
 * names neither branch's actual problem. A runtime refusal costs the round trip a bad call already
 * deserved and spends it on prose that states the rule.
 *
 * Both-supplied is refused rather than resolved by precedence, the tempting shortcut. A
 * caller that sent both meant one of them, and silently rendering the other writes a memory whose
 * content the caller did not choose, into a git commit, indexed, retrievable. Neither-supplied is
 * refused for the same reason it cannot be defaulted: an article with no claim has no `<mark>`, so
 * `files.gist` would be empty on every disclosure tier.
 *
 * A blank string counts as absent, on both sides. Template-driven clients do fill unset fields with
 * `""`, and such a call would otherwise read as "supplied both" when it supplied one.
 *
 * On the markup path `claim` is `""` and `body` is empty, and neither derivation runs: the template
 * uses `articleHtml` verbatim, so a claim derived from prose that does not exist would be a second,
 * invisible authoring decision. The `<mark>` inside the markup IS the claim, and the parser extracts
 * it into `files.gist` on the first index pass. Markup whose `<mark>` is missing OR EMPTY is the
 * STORE's refusal (`packages/store/src/store.ts`'s render gate, over `@memhtml/html` constraint 1)
 * rather than this function's. The XOR is the only rule the wire boundary owns.
 *
 * The prose path derives through `claimFromProse`/`proseTail`, imported from `@memhtml/cli` so this door
 * and `memhtml apply` split prose the same way. A second copy here would let the same body produce
 * different gists depending on which door wrote it.
 */
interface Authored {
  readonly claim: string
  readonly body: ReadonlyArray<string>
  readonly articleHtml: string | undefined
}

const authored = (
  body: string | null | undefined,
  articleHtml: string | null | undefined
): Effect.Effect<Authored, InvalidMemory> => {
  const prose = opt(body)
  const markup = opt(articleHtml)
  const hasProse = prose !== undefined && prose.trim() !== ""
  const hasMarkup = markup !== undefined && markup.trim() !== ""
  if (hasProse === hasMarkup) {
    return Effect.fail(
      InvalidMemory.make({
        reason: `exactly one of body or article_html is required, and ${hasProse ? "both were supplied" : "neither was supplied"}`
      })
    )
  }
  return Effect.succeed(
    hasMarkup
      ? { claim: "", body: [], articleHtml: markup }
      : {
          claim: claimFromProse(prose as string),
          body: proseTail(prose as string),
          articleHtml: undefined
        }
  )
}

/** One `memory_write_batch` op as it arrives on the wire, before the XOR has been resolved. */
interface BatchOpParams {
  readonly title: string
  readonly body?: string | null | undefined
  readonly article_html?: string | null | undefined
  readonly memory_type: string
  readonly path?: string | null | undefined
  readonly strict_path?: boolean | null | undefined
  readonly workspace?: string | null | undefined
  readonly tags?: ReadonlyArray<string> | null | undefined
  readonly entities?: ReadonlyArray<string> | null | undefined
  readonly importance?: number | null | undefined
  readonly confidence?: number | null | undefined
  readonly session_id?: string | null | undefined
  readonly prompt_id?: string | null | undefined
  readonly turn_uuid?: string | null | undefined
}

/**
 * One op's wire-name-to-operation-name rename, given the article its XOR already resolved to.
 *
 * The same rename `memory_write`'s handler performs, over the same field list. The ops carry a whole
 * `memory_write` payload (D7), so a second spelling of this mapping would be the drift the shared
 * `writeFields` in `tools.ts` exists to make impossible on the schema side.
 */
const writeParamsOf = (op: BatchOpParams, article: Authored): WriteParams => ({
  title: op.title,
  claim: article.claim,
  body: article.body,
  articleHtml: article.articleHtml,
  memoryType: op.memory_type,
  path: opt(op.path),
  strictPath: opt(op.strict_path),
  workspace: opt(op.workspace),
  tags: arr(op.tags),
  entities: arr(op.entities),
  importance: opt(op.importance),
  confidence: opt(op.confidence),
  sessionId: opt(op.session_id),
  promptId: opt(op.prompt_id),
  turnUuid: opt(op.turn_uuid)
})

/**
 * An op's XOR refusal as that op's own report, through the SAME `codeFor`/`messageFor` pair
 * `operations.ts`'s `reportFailure` uses.
 *
 * Not a second mapping of the error: a per-op `code` is part of the batch payload's contract, and
 * `memhtml apply` and `memory_write_batch` reporting different codes for one refused op is exactly the
 * drift the shared-use-case rule exists to prevent. The XOR is the one refusal the operations layer
 * cannot produce, being a wire-vocabulary rule about two parameters that layer never sees, since
 * `WriteParams` takes an already-resolved `claim`/`body`/`articleHtml`. So this is the one place
 * a report is built outside `batchWrite`, and it is built with `batchWrite`'s own functions.
 */
const xorReport = (index: number, error: InvalidMemory): BatchOpReport => ({
  index,
  ok: false,
  code: codeFor(error),
  error: messageFor(error)
})

/**
 * The first op that FAILED, as opposed to one that was skipped or deduped.
 *
 * `batchWrite`'s atomic abort reports the offending op with its code and every other op as `skipped`
 * (`operations.ts:545-548` for a decode refusal, `store.ts:693-705` for a render-gate one), so an
 * aborted batch is recognizable by exactly this: one report with `ok: false` and `skipped` unset. A
 * check on `summary.skipped > 0` alone would also match a batch that had nothing to abort.
 */
const firstFailure = (reports: ReadonlyArray<BatchOpReport>): BatchOpReport | undefined =>
  reports.find((report) => !report.ok && report.skipped !== true && report.code !== undefined)

/** One op's report as the wire shape: every field present, absent ones as `null`. */
const wireReport = (report: BatchOpReport) => ({
  index: report.index,
  ok: report.ok,
  path: report.path ?? null,
  deduped: report.deduped === true,
  existing_path: report.existingPath ?? null,
  code: report.code ?? null,
  error: report.error ?? null,
  skipped: report.skipped === true,
  /**
   * The conflict assist's finding, `batchIndex` renamed to `batch_index`. That rename is the whole of
   * the handlers' remaining job, applied one level deeper than usual because this is the first nested
   * struct on the batch's wire shape. `memhtml apply`'s own `opPayload` performs the same rename onto
   * the same names, so the two doors' payloads stay byte-comparable.
   *
   * A conflict says nothing about `ok`, `path`, or `skipped`, and this function is where that is
   * visible: nothing above changes when the field is populated.
   */
  conflict:
    report.conflict === undefined
      ? null
      : {
          path: report.conflict.path,
          batch_index: report.conflict.batchIndex,
          claim: report.conflict.claim
        },
  /**
   * The near-duplicate assist's findings, each entry renamed the way `conflict` is and for its
   * reason: `memhtml apply`'s `opPayload` publishes the same names, so the two doors' payloads stay
   * byte-comparable. A finding says nothing about `ok`, `path`, or `skipped` either.
   */
  near_duplicates:
    report.nearDuplicates === undefined
      ? null
      : report.nearDuplicates.map((hit) => ({
          path: hit.path,
          batch_index: hit.batchIndex,
          similarity: hit.similarity,
          claim: hit.claim
        })),
  consolidated_into: report.consolidatedInto ?? null,
  superseded_path: report.supersededPath ?? null
})

/**
 * The batch's counts, over the merged report array.
 *
 * The same one-pass derivation `operations.ts`'s `summarize` performs, and it has to be re-derived here
 * rather than taken from `batchWrite` for one reason: in continue mode this handler's own XOR refusals
 * are reports `batchWrite` never saw, so its summary describes a SHORTER op list. Taking it would
 * publish `total` less than `results.length`, a summary a client cannot reconcile with the array it
 * came with. On the atomic path there are no such refusals and this returns `batchWrite`'s own numbers.
 */
const summarize = (
  results: ReadonlyArray<BatchOpReport>
): BatchWriteResult["summary"] & { readonly total: number } => {
  let written = 0
  let deduped = 0
  let failed = 0
  let skipped = 0
  let consolidated = 0
  for (const result of results) {
    // The same partition `operations.ts` makes: a batch-internal loser's value survived at
    // another slot and no file of its own was attempted, so it is neither written nor failed.
    if (result.consolidatedInto !== undefined) consolidated += 1
    else if (result.skipped === true) skipped += 1
    else if (!result.ok) failed += 1
    else if (result.deduped === true) deduped += 1
    else written += 1
  }
  return { total: results.length, written, deduped, failed, skipped, consolidated }
}

/**
 * The handler layer for the toolkit.
 *
 * `kit.toLayer({ … })` is checked against the toolkit's own parameter and success schemas, so a
 * handler returning the wrong shape is a compile error rather than a decode failure on a live call.
 */
export const ToolHandlers: Layer.Layer<
  Layer.Success<ReturnType<typeof MemhtmlToolkit.toLayer>>,
  never,
  AppServices
> = MemhtmlToolkit.toLayer({
  memory_write: (params) =>
    handled(
      Effect.gen(function* () {
        const article = yield* authored(params.body, params.article_html)
        const result = yield* writeMemory({
          title: params.title,
          claim: article.claim,
          body: article.body,
          articleHtml: article.articleHtml,
          memoryType: params.memory_type,
          path: opt(params.path),
          strictPath: opt(params.strict_path),
          workspace: opt(params.workspace),
          tags: arr(params.tags),
          entities: arr(params.entities),
          importance: opt(params.importance),
          confidence: opt(params.confidence),
          sessionId: opt(params.session_id),
          promptId: opt(params.prompt_id),
          turnUuid: opt(params.turn_uuid)
        })
        return {
          path: result.path,
          created: result.created,
          deduped: result.deduped,
          existing_path: result.existingPath ?? null
        }
      })
    ),

  /**
   * The batch: resolve every op's XOR, call `batchWrite` ONCE, report every op in input order.
   *
   * **The XOR runs per op, up front, before `batchWrite` is called at all.** It is the wire boundary's
   * only rule and it is a rule about two PARAMETERS. `WriteParams` takes an already-resolved
   * `claim`/`body`/`articleHtml`, so an op that supplied both is a call the operations layer has no way
   * to recognize. Resolving it here also means the store's phase-1 validation sees only ops that could
   * possibly be written, which is what keeps "the atomic abort happens before any file exists" true of
   * the XOR too.
   *
   * **Then the modes diverge, and each one matches `batchWrite`'s own semantics for the failure class
   * it already handles**, a malformed `memory_type`, which is likewise a per-op decode refusal:
   *
   * - CONTINUE: each XOR refusal becomes that op's failed report, ONLY the survivors go to
   *   `batchWrite`, and the survivors' reports are spliced back at their ORIGINAL indices. `originOf`
   *   is what makes that possible: `batchWrite` indexes results in the array it was handed, so a
   *   survivor at position 0 of a two-op call may be op 0 or op 1 of a three-op one, and reporting its
   *   own index would shift every later op by the number of refusals before it. The result is a
   *   SUCCESS: every op is present in `results`, in input order, which is the contract D3 states and
   *   the only shape an agent can index by.
   * - ATOMIC (the default): the first refused op aborts, and the abort reaches the agent through the
   *   ERROR channel as `batchAbortFailure`. An XOR refusal short-circuits before `batchWrite` is
   *   called at all, since an atomic batch with a refused op writes nothing by definition and the call
   *   would be a round trip whose only outcome is the abort. A refusal `batchWrite` itself produced,
   *   such as a malformed `memory_type` or an op the store's render gate refused, comes back as an
   *   aborted RESULT, and is converted at the same seam.
   *
   * **That conversion is the one non-obvious thing here, and it was a real bug caught by a test.** An
   * aborted `batchWrite` returns a well-formed result: every op reported, one of them failed, the rest
   * `skipped`, `commitSha: null`. Returning it verbatim is a SUCCESS response for a call that wrote
   * nothing, so the XOR path (an error) and the render-gate path (a success) would be two channels for
   * one outcome, and `BATCH_GUIDANCE`'s promise that "the first refused op aborts the whole call … and
   * the failure names the offending op" would be false for every refusal the handler did not itself
   * detect. `firstFailure` finds the offending op in the returned reports and `batchAbortFailure`
   * composes the one message both paths use.
   */
  memory_write_batch: (params) =>
    handled(
      Effect.gen(function* () {
        const continueOnError = params.continue_on_error === true
        const reports: Array<BatchOpReport | undefined> = params.ops.map(() => undefined)
        const survivors: Array<WriteParams> = []
        /** Survivor position in what `batchWrite` was handed → this caller's own op index. */
        const originOf: Array<number> = []

        for (const [index, op] of params.ops.entries()) {
          const article = yield* Effect.result(authored(op.body, op.article_html))
          if (article._tag === "Failure") {
            const report = xorReport(index, article.failure)
            /**
             * Composed rather than `Effect.fail(article.failure)`, which would reach the agent as the
             * singular's own message: it names the rule but not WHICH of twenty ops broke it, and says
             * nothing about `continue_on_error`.
             */
            if (!continueOnError) {
              return yield* Effect.fail(
                batchAbortFailure(index, report.code ?? "ERR_INVALID_MEMORY", report.error ?? "")
              )
            }
            reports[index] = report
            continue
          }
          originOf.push(index)
          survivors.push(writeParamsOf(op, article.success))
        }

        const batch = yield* batchWrite({
          ops: survivors,
          continueOnError,
          /**
           * The flag reaches `batchWrite` unchanged, which is the only correct place for the assist to
           * live: `memhtml apply --detect-conflicts` gets the same findings from the same code, so the two
           * doors cannot disagree about what a conflict is.
           *
           * The survivors-only consequence is real and it is right. An op this handler already refused
           * for the XOR is not in `survivors`, so it gets no conflict report, and it also has no claim
           * to derive one FROM: on the both-supplied path there is no way to tell which of the two the
           * caller meant, and on the neither-supplied path there is no claim at all. A finding invented
           * for such an op would name a slot the caller never asserted.
           */
          detectConflicts: params.detect_conflicts === true,
          // The same one-place-for-the-assist rule: `memhtml apply --detect-near-duplicates` gets
          // the same findings from the same code, and the survivors-only consequence above holds
          // here too — an XOR-refused op has no resolved text to embed.
          detectNearDuplicates: params.detect_near_duplicates === true,
          // Threaded unchanged for the same reason the flag above is: `memhtml apply --consolidate`
          // resolves the same slots from the same code, so the two doors cannot disagree about
          // which value won.
          ...(params.consolidate !== undefined && params.consolidate !== null
            ? { consolidate: params.consolidate }
            : {}),
          sessionId: opt(params.session_id),
          promptId: opt(params.prompt_id),
          turnUuid: opt(params.turn_uuid)
        })

        // An atomic batch `batchWrite` aborted: one op failed, so the whole call failed, and it reaches
        // the agent through the same error channel and the same message as the XOR refusal above.
        if (!continueOnError) {
          const failed = firstFailure(batch.results)
          if (failed !== undefined) {
            return yield* Effect.fail(
              batchAbortFailure(
                originOf[failed.index] ?? failed.index,
                failed.code ?? "ERR_INVALID_MEMORY",
                failed.error ?? ""
              )
            )
          }
        }

        /**
         * Splice each survivor's report back at its ORIGINAL index, and translate the conflict's
         * `batchIndex` through the SAME map, which is the non-obvious half.
         *
         * `batchWrite` saw only `survivors`, so an intra-batch conflict it found names a position in
         * THAT array. In continue mode with an XOR-refused op before the conflicting pair, survivor 1
         * is the caller's op 2, so reporting the raw number would name a different op than the one the
         * assist actually matched, and it would name it plausibly enough that nobody would notice. The
         * outer `index` has always needed this translation for exactly the same reason; the conflict is
         * a second index in the same space and needs it too.
         *
         * `originOf[…] ?? conflict.batchIndex` mirrors the fallback three lines above rather than
         * dropping the conflict: an untranslatable index is impossible here (every survivor has an
         * origin, by construction of the loop that built both arrays), and if it somehow were not, a
         * caller is better served by a suspicious number than by a finding silently deleted.
         */
        for (const report of batch.results) {
          const index = originOf[report.index]
          if (index === undefined) continue
          const conflict = report.conflict
          const translated =
            conflict === undefined || conflict.batchIndex === null
              ? { ...report, index }
              : {
                  ...report,
                  index,
                  conflict: {
                    ...conflict,
                    batchIndex: originOf[conflict.batchIndex] ?? conflict.batchIndex
                  }
                }
          // A near-duplicate's `batchIndex` is another index in `batchWrite`'s survivor space and
          // takes the same translation, entry by entry. A store match (null `batchIndex`) passes
          // through unchanged, and the `?? hit.batchIndex` fallback mirrors the conflict's for its
          // reason: a suspicious number serves a caller better than a finding silently deleted.
          const withNear =
            translated.nearDuplicates === undefined
              ? translated
              : {
                  ...translated,
                  nearDuplicates: translated.nearDuplicates.map((hit) =>
                    hit.batchIndex === null
                      ? hit
                      : { ...hit, batchIndex: originOf[hit.batchIndex] ?? hit.batchIndex }
                  )
                }
          // `consolidatedInto` is a second index in `batchWrite`'s survivor space and takes the
          // same translation the conflict's `batchIndex` does, for the same reason: an XOR-refused
          // op before the consolidated pair would otherwise make the pointer name the wrong op.
          reports[index] =
            withNear.consolidatedInto === undefined
              ? withNear
              : {
                  ...withNear,
                  consolidatedInto: originOf[withNear.consolidatedInto] ?? withNear.consolidatedInto
                }
        }

        /**
         * An op with no report of its own was never reached. Unreachable on the atomic path, which has
         * already failed by here, so this is continue mode's own case: `skipped`, the same word
         * `batchWrite` uses, so the two doors describe one outcome in one vocabulary.
         */
        const results = reports.map(
          (report, index) => report ?? ({ index, ok: false, skipped: true } satisfies BatchOpReport)
        )
        return {
          results: results.map(wireReport),
          summary: summarize(results),
          commit_sha: batch.commitSha,
          near_duplicates_degraded: batch.nearDuplicatesDegraded
        }
      })
    ),

  memory_read: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* readMemory(params.path, { sessionId: opt(params.session_id) })
        return {
          path: result.path,
          title: result.doc.title,
          body: result.doc.article.bodyText,
          gist: result.doc.article.gist,
          memory_type: result.doc.metas.memoryType,
          meta: metaRecord(result.doc),
          links: result.doc.links.map((link) => ({ rel: link.rel, href: link.href })),
          archived: result.doc.metas.status === "archived",
          warnings: result.doc.warnings
        }
      })
    ),

  memory_search: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* searchMemories({
          query: params.query,
          limit: opt(params.limit),
          memoryTypes: opt(params.memory_types),
          workspace: opt(params.workspace),
          tags: opt(params.tags),
          entity: opt(params.entity),
          // The same `name=value` decode `memhtml search --facet` runs, from `@memhtml/index`, so one
          // spelling reaches one predicate through both doors.
          facets: parseFacetFilters(arr(params.facets)),
          includeArchived: opt(params.include_archived),
          asOf: opt(params.as_of)
        })
        return {
          hits: result.hits.map((hit) => ({
            path: hit.path,
            title: hit.title,
            gist: hit.gist,
            memory_type: hit.memoryType,
            score: hit.score,
            confidence: hit.confidence,
            updated_at: hit.updatedAt,
            snippet: hit.snippet,
            entities: hit.entities,
            superseded_by: hit.supersededBy
          })),
          degraded: result.degraded,
          arms: result.arms,
          entity_scope: result.entityScope,
          scope_empty: result.scopeEmpty
        }
      })
    ),

  memory_recall: (params) =>
    handled(
      Effect.gen(function* () {
        const pack = yield* recallMemories({
          query: params.query,
          budgetChars: opt(params.budget_chars),
          workspace: opt(params.workspace)
        })
        /**
         * `lateral` is the union of both folds' index lines.
         *
         * It holds what did not fit the budget, surfaced with its claim and its path so an agent
         * can drill down deliberately, and it is not a third retrieval arm. Dropping it would make
         * a truncated pack indistinguishable from a small corpus.
         */
        return {
          sections: {
            arcs: pack.arcs.disclosed.map((entry) => ({
              path: entry.path,
              title: entry.title,
              gist: entry.gist,
              body: entry.body
            })),
            memories: pack.memories.disclosed.map((entry) => ({
              path: entry.path,
              title: entry.title,
              gist: entry.gist,
              body: entry.body
            })),
            lateral: [...pack.arcs.indexLines, ...pack.memories.indexLines].map((line) => ({
              path: line.path,
              title: line.title,
              gist: line.gist
            }))
          },
          spent_chars: pack.spentChars,
          truncated: pack.truncated,
          degraded: pack.degraded
        }
      })
    ),

  memory_correct: (params) =>
    handled(
      Effect.gen(function* () {
        const article = yield* authored(params.body, params.article_html)
        const result = yield* correctMemory({
          targetPath: params.target_path,
          title: params.title,
          claim: article.claim,
          body: article.body,
          articleHtml: article.articleHtml,
          reason: params.reason,
          sessionId: opt(params.session_id)
        })
        /**
         * `superseded` names the target's ARCHIVE path, which is where the file is once the commit
         * lands, and it is what the new file's `memhtml-supersedes` link points at. Reporting the
         * pre-archive path would hand back a path with no file behind it.
         */
        return {
          path: result.path,
          superseded: [result.archivedPath],
          archived: [result.archivedPath]
        }
      })
    ),

  memory_link: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* linkMemories(params.src_path, params.rel, params.dst_path)
        return {
          // True whether or not this call was the one that wrote the link: the edge exists either
          // way, and `addLink` is idempotent on the pair. A false here would make a re-link look
          // like a failure.
          ok: true,
          rel: result.rel,
          src_path: result.srcPath,
          dst_path: result.dstPath
        }
      })
    ),

  memory_neighbors: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* neighborsOf({
          path: params.path,
          depth: opt(params.depth),
          rels: opt(params.rels),
          limit: opt(params.limit)
        })
        /**
         * Both truncation markers cross the boundary, and the rename is the only work here.
         *
         * The operation reports the clamped ceiling as `limit` and this surface publishes it as
         * `node_limit`, because a tool response that spelled it `limit` would put the caller's ask and
         * the walk's 10000-edge-row cap under one word. Dropping either marker would leave a clamped
         * neighborhood indistinguishable from a complete one, which is the whole reason the operation
         * counts them.
         */
        return {
          nodes: result.nodes,
          edges: result.edges,
          node_limit: result.limit,
          dropped_node_count: result.nodesDropped,
          scan_saturated: result.scanSaturated
        }
      })
    ),

  memory_resolve: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* resolveMemory(params.path)
        /**
         * `pinned_uri` is composed HERE and nowhere else, from `pinnedUri`, the function the resource
         * that routes that URI exports.
         *
         * The operation cannot build it: `@memhtml/cli` knows nothing about the MCP scheme, and a
         * resolution is a fact about the corpus rather than about a transport. Composing it from
         * literals in this file would be a second declaration of the published template — the
         * consumer-side reimplementation of a producer's naming rule this repo has paid for.
         *
         * It is withheld in two cases and they are one rule: a URI this server would refuse is not a
         * citation. There is no commit to pin to before the first rebuild, and `unindexed` is the one
         * stop reason whose `path` the indexed commit does not hold, so pinning it would hand a client
         * a receipt that reads `ERR_PATH_NOT_FOUND` forever. Every other stop reason ends on a path the
         * index holds a row for.
         */
        return {
          requested: result.requested,
          path: result.path,
          hops: result.hops,
          steps: result.steps,
          stop_reason: result.stopReason,
          title: result.title,
          indexed_commit: result.indexedCommit,
          pinned_uri:
            result.indexedCommit === null || result.stopReason === "unindexed"
              ? null
              : pinnedUri(result.indexedCommit, result.path)
        }
      })
    ),

  memory_archive: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* archiveMemory(params.path, params.reason)
        return { path: result.path, archive_path: result.archivePath }
      })
    ),

  memory_reinforce: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* reinforceMemories(params.paths, params.signal)
        return { bumped: result.bumped, cooled_down: result.cooledDown }
      })
    ),

  memory_list: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* listMemories({
          memoryType: opt(params.memory_type),
          workspace: opt(params.workspace),
          tag: opt(params.tag),
          entity: opt(params.entity),
          facets: parseFacetFilters(arr(params.facets)),
          para: opt(params.para),
          limit: opt(params.limit),
          cursor: opt(params.cursor)
        })
        return {
          files: result.files.map((file) => ({
            path: file.path,
            title: file.title,
            memory_type: file.memoryType,
            gist: file.gist,
            workspace: file.workspace,
            para: file.para,
            confidence: file.confidence,
            importance: file.importance,
            archived: file.archived,
            updated_at: file.updatedAt
          })),
          next_cursor: result.nextCursor
        }
      })
    ),

  trace_search: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* searchTraces({
          query: params.query,
          cwd: opt(params.cwd),
          since: opt(params.since),
          limit: opt(params.limit)
        })
        return {
          sessions: result.sessions.map((session) => ({
            session_id: session.sessionId,
            slug: session.slug,
            cwd: session.cwd,
            started_at: session.startedAt,
            prompt_count: session.promptCount,
            first_prompt: session.firstPrompt,
            ai_title: session.aiTitle
          }))
        }
      })
    ),

  trace_links: (params) =>
    handled(
      Effect.gen(function* () {
        const result = yield* traceLinks({
          sessionId: opt(params.session_id),
          path: opt(params.path)
        })
        return {
          links: result.links.map((link) => ({
            path: link.path,
            session_id: link.sessionId,
            prompt_id: link.promptId,
            turn_uuid: link.turnUuid,
            link_kind: link.linkKind,
            at: link.at
          }))
        }
      })
    ),

  memory_status: () =>
    handled(
      Effect.gen(function* () {
        const report = yield* statusReport()
        return {
          head_sha: report.headSha,
          dirty: report.dirty,
          counts_by_type: report.countsByType,
          archived_count: report.archivedCount,
          edges: report.edges,
          index_fresh: report.indexFresh,
          embedder_up: report.embedderUp,
          last_sleep:
            report.lastSleep === null
              ? null
              : {
                  run_id: report.lastSleep.runId,
                  status: report.lastSleep.status,
                  started_at: report.lastSleep.startedAt
                }
        }
      })
    )
})

/** Re-exported so a caller wiring a test layer names the same type the handlers require. */
export type { AppServices, EmbedderShape }
