import { isEdgeRel, MEMORY_RELS, relClassFor, TASK_RELS } from "@memhtml/contracts/edges"
import { InvalidMemory, type StorageFailure } from "@memhtml/contracts/errors"
import { normalizePath } from "@memhtml/contracts/paths"
import {
  isTaskStatus,
  isWritableMemoryType,
  type MemoryType,
  TASK_STATUSES,
  type TaskStatus,
  WRITABLE_MEMORY_TYPES
} from "@memhtml/contracts/types"
import { frameKeyOf, REINFORCE_SIGNALS, type ReinforceSignal } from "@memhtml/domain"
import { isValidDatetime, setMeta } from "@memhtml/html"
import {
  DatabaseService,
  type DatabaseShape,
  type FacetFilter,
  type FrameMatch,
  facetConditions,
  Indexer,
  IndexRecorder,
  type IndexRecorderShape,
  type LinkKind,
  persistScanned,
  Retrieval,
  readIndexState,
  readWatermark,
  reinforce,
  type SearchScope,
  sanitizeFtsQuery,
  type TailMerger
} from "@memhtml/index"
import { EMBED_WATERMARK } from "@memhtml/llm"
import { DETECTION_DIGEST_CHARS, DETECTION_PREFIX } from "@memhtml/sleep"
import { attemptIo, commitSubject, Store, type WriteInput } from "@memhtml/store"
import { mergeTailExtract, type SessionExtract, scanTraceRoot } from "@memhtml/traces"
import { Effect } from "effect"

import { ExtractorPort, Roots } from "./api-layer.js"
import type { ErrorCode } from "./envelope.js"
import { codeFor, messageFor } from "./errors.js"
import type { ExtractionItem } from "./extraction.js"

/**
 * The use cases, one per tool. Every CLI command and every MCP tool is a thin adapter over exactly
 * one of these, which makes `memhtml search` and `memory_search` provably the same query
 * rather than two implementations that agree today.
 *
 * Nothing here parses argv or builds an envelope. A function takes decoded parameters, returns a
 * typed result, and fails with a typed error. The adapters own the shape of the wire.
 */

/** Wall-clock as an ISO-8601 UTC second, through the Effect clock so a test can pin it. */
const nowSecond = Effect.clockWith((clock) =>
  Effect.map(clock.currentTimeMillis, (millis) => `${new Date(millis).toISOString().slice(0, 19)}Z`)
)

/** Drop `undefined`-valued keys, so `exactOptionalPropertyTypes` sees an absent key. */
const defined = <T extends Record<string, unknown>>(input: T): Partial<T> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) if (value !== undefined) out[key] = value
  return out as Partial<T>
}

/**
 * Narrow an untrusted memory-type string.
 *
 * `arc` is refused even though it is a valid storage type. An arc is synthesized by the sleep
 * cycle from many memories, so an agent naming one directly would be asserting a conclusion the
 * corpus has not earned. The vocabulary the tool exposes is therefore narrower than the CHECK
 * constraint by exactly that one value.
 */
export const decodeWritableType = (
  value: string
): Effect.Effect<Exclude<MemoryType, "arc">, InvalidMemory> =>
  (WRITABLE_MEMORY_TYPES as ReadonlyArray<string>).includes(value)
    ? Effect.succeed(value as Exclude<MemoryType, "arc">)
    : Effect.fail(
        InvalidMemory.make({
          reason: `unknown memory type: ${value}. One of: ${WRITABLE_MEMORY_TYPES.join(", ")}`
        })
      )

/**
 * The rels a CALLER may author: the nine memory rels plus the two task rels.
 *
 * The two classes the vocabulary withholds are the ones the system mints itself. A `person` edge is
 * written by sleep's person-links phase against `resources/people/*`, and `from_session` is written
 * by the write path from the provenance a caller already supplied. Authoring either by hand would put
 * a hand-guessed row where a derivation belongs.
 */
export const AUTHORABLE_RELS = [...MEMORY_RELS, ...TASK_RELS] as const

export type AuthorableRel = (typeof AUTHORABLE_RELS)[number]

/**
 * Narrow an untrusted rel to one a caller may author.
 *
 * A `blocks` edge between two tasks is a legitimate authored assertion, so the task class is in and
 * refusing it would leave the task graph writable by nothing. Whether the rel agrees with its
 * endpoints is not this function's business. `@memhtml/store`'s `linkMemories` reads both files'
 * `memhtml-type` and refuses a mismatch, and it is the only layer that can see the endpoints at all.
 *
 * `memory_link`'s MCP schema stays memory-rels-only (`MemoryRelSchema`, `apps/mcp/src/tools.ts`) and
 * refuses a task rel at decode. That is one narrow surface for agents and one wider one for the
 * operator, with the store's endpoint guard governing both.
 */
export const decodeAuthorableRel = (value: string): Effect.Effect<AuthorableRel, InvalidMemory> =>
  isEdgeRel(value) && (AUTHORABLE_RELS as ReadonlyArray<string>).includes(value)
    ? Effect.succeed(value as AuthorableRel)
    : Effect.fail(
        InvalidMemory.make({
          reason: `unknown rel: ${value}. One of: ${AUTHORABLE_RELS.join(", ")}`
        })
      )

/** Narrow an untrusted task status. */
export const decodeTaskStatus = (value: string): Effect.Effect<TaskStatus, InvalidMemory> =>
  isTaskStatus(value)
    ? Effect.succeed(value)
    : Effect.fail(
        InvalidMemory.make({
          reason: `unknown task status: ${value}. One of: ${TASK_STATUSES.join(", ")}`
        })
      )

/**
 * Narrow an untrusted due date, using the FORMAT's own validator.
 *
 * `isValidDatetime` rather than a local regex or `Date.parse`, because `files.due_at` is compared and
 * ordered as a string. `2026-8-9` and `Aug 9 2026` both parse as instants and neither sorts alongside
 * `2026-08-09`, so the overdue query would silently miss them. Reusing the parser's own validator is
 * also what keeps this refusal and the parser's violation from drifting apart.
 */
export const decodeDueAt = (value: string): Effect.Effect<string, InvalidMemory> =>
  isValidDatetime(value)
    ? Effect.succeed(value)
    : Effect.fail(
        InvalidMemory.make({
          reason: `due date is not an ISO date or datetime: ${value}. Expected YYYY-MM-DD or YYYY-MM-DDThh:mm:ssZ`
        })
      )

/** Narrow an untrusted reinforcement signal. */
export const decodeSignal = (value: string): Effect.Effect<ReinforceSignal, InvalidMemory> =>
  (REINFORCE_SIGNALS as ReadonlyArray<string>).includes(value)
    ? Effect.succeed(value as ReinforceSignal)
    : Effect.fail(
        InvalidMemory.make({
          reason: `unknown signal: ${value}. One of: ${REINFORCE_SIGNALS.join(", ")}`
        })
      )

/** Session provenance, present on any write-path call an agent makes from inside a session. */
export interface Provenance {
  readonly sessionId?: string | undefined
  readonly promptId?: string | undefined
  readonly turnUuid?: string | undefined
}

/**
 * Record the session link for an operation that touched a path.
 *
 * Fire-and-log rather than fail-the-call. The link is a note about what happened, and losing the
 * memory over a failed note about it would invert the priority. The file's own head already
 * carries `memhtml-session`/`memhtml-prompt`/`memhtml-turn`, so the durable half of the link survives even
 * when this row does not.
 */
const recordLink = (path: string, linkKind: LinkKind, provenance: Provenance, at: string) =>
  Effect.gen(function* () {
    if (provenance.sessionId === undefined || provenance.sessionId === "") return
    const recorder = yield* IndexRecorder
    yield* recorder
      .recordLink({
        path,
        sessionId: provenance.sessionId,
        linkKind,
        at,
        ...defined({ promptId: provenance.promptId, turnUuid: provenance.turnUuid })
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`session link not recorded for ${path}: ${error.operation}`)
        )
      )
  })

export interface WriteParams extends Provenance {
  readonly title: string
  readonly claim: string
  readonly body?: ReadonlyArray<string> | undefined
  /**
   * Pre-authored article markup, used verbatim in place of `claim`/`body`. The caller owns
   * constraint 1 when it supplies this, and the store's render gate is what enforces it. Markup
   * with no `<mark>` fails with `InvalidMemory` before anything is written or committed.
   */
  readonly articleHtml?: string | undefined
  readonly memoryType: string
  readonly path?: string | undefined
  readonly workspace?: string | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  readonly entities?: ReadonlyArray<string> | undefined
  readonly importance?: number | undefined
  readonly confidence?: number | undefined
  /** A task's opening status. Ignored on any other type, which carries no such meta. */
  readonly taskStatus?: string | undefined
  /** A task's deadline, ISO date or datetime. Refused before the write when it is neither. */
  readonly dueAt?: string | undefined
}

/**
 * Bring the index up to the commit a write just made.
 *
 * The whole COMMIT, never a list of paths the caller happens to know about, and two properties of the
 * index rest on that:
 *
 * 1. **A rename is only expressible as a diff.** Every correction and every archive is a `git mv`.
 *    `update()` reads `diff --name-status -M`, sees the `R`, and re-points the row, which keeps the
 *    embedding. Indexing the destination alone leaves the source row live: the archived memory stays
 *    in `memhtml list`, `files` carries a row the tree does not have, and the chunk rows the move
 *    exists to preserve end up duplicated under two paths.
 * 2. **The watermark is what makes freshness answerable.** `update()` records
 *    `index_state.head_sha`, and without it `memhtml status` reports `index_fresh: false` forever
 *    while `index update` re-derives from a stale base.
 *
 * The cost is one `git diff` over one commit, which is what the watermark exists to bound. On the
 * very first write there is no watermark row and `update()` falls through to a full rebuild. That is
 * correct, and cheap on a corpus that has one file in it.
 */
const reindex = () =>
  Effect.gen(function* () {
    const indexer = yield* Indexer
    return yield* indexer.update({ embed: true })
  })

/**
 * Decode untrusted write parameters into the store's `WriteInput`.
 *
 * Shared by {@link writeMemory} and {@link batchWrite}, and the sharing matters. A batch that
 * re-derived this would be a second decode of the same vocabulary, and the two would agree today
 * and drift the first time a field is added. The batch folds the singular's own decode rather
 * than a parallel one.
 *
 * The two task metas are decoded here, before any file is rendered, and only for a task.
 * `@memhtml/html`'s parser refuses `memhtml-task-status` on a non-task and refuses a `memhtml-due` that is not
 * an ISO datetime, so a bad value passed through would render a file the indexer then declines to
 * project. That file is present in the tree, absent from every search, and visible only as a log
 * line. Deciding here turns it into a typed `InvalidMemory` before the commit.
 */
const toWriteInput = (params: WriteParams, at: string): Effect.Effect<WriteInput, InvalidMemory> =>
  Effect.gen(function* () {
    const memoryType = yield* decodeWritableType(params.memoryType)
    const taskStatus =
      memoryType === "task" && params.taskStatus !== undefined && params.taskStatus !== ""
        ? yield* decodeTaskStatus(params.taskStatus)
        : undefined
    const dueAt =
      memoryType === "task" && params.dueAt !== undefined && params.dueAt !== ""
        ? yield* decodeDueAt(params.dueAt)
        : undefined

    return {
      title: params.title,
      claim: params.claim,
      memoryType,
      at,
      ...defined({
        body: params.body,
        articleHtml: params.articleHtml,
        path: params.path,
        workspace: params.workspace,
        tags: params.tags,
        entities: params.entities,
        importance: params.importance,
        confidence: params.confidence,
        sessionId: params.sessionId,
        promptId: params.promptId,
        turnUuid: params.turnUuid,
        taskStatus,
        dueAt
      })
    }
  })

/**
 * Write one memory: render, dedupe, commit, index.
 *
 * On a dedupe nothing is indexed, because nothing changed. A dedupe writes no file, stages nothing,
 * and commits nothing, so the tree is byte-identical and the index already describes it.
 */
export const writeMemory = (params: WriteParams) =>
  Effect.gen(function* () {
    const store = yield* Store
    const at = yield* nowSecond
    const result = yield* store.writeMemory(yield* toWriteInput(params, at))

    if (result.created) yield* reindex()
    yield* recordLink(result.path, "wrote", params, at)
    return result
  })

/**
 * A frame-match the `detect_conflicts` assist found for one op: something else already occupies this
 * claim's slot.
 *
 * One shape for both kinds of match, with the two source fields nullable, rather than a discriminated
 * union. A caller reads `claim` unconditionally, because that is the disagreement and what a decision
 * is made on, and then reads whichever of `path`/`batchIndex` is non-null to find the other claim. A
 * union would make every consumer branch before it could read the field it actually wants, and the
 * wire form (`Schema.NullOr` per field, per the batch's present-and-nullable rule) would publish the
 * same two nullable fields anyway.
 *
 * Exactly one of the two is non-null, always. A store match names the active memory's `path`. An
 * intra-batch match names the earlier op's `batchIndex`, and has no path because that op's file does
 * not exist yet, since the batch has not been written when the assist runs.
 */
export interface FrameConflict {
  /** The active memory already holding this frame key, or null for an intra-batch match. */
  readonly path: string | null
  /** The earlier op in this same batch holding it, or null for a store match. */
  readonly batchIndex: number | null
  /** The other claim's own text. The disagreement itself, which is what a caller decides on. */
  readonly claim: string
}

/** One op's outcome as the doors report it: the store's own shape, with the envelope's code. */
export interface BatchOpReport {
  readonly index: number
  readonly ok: boolean
  readonly path?: string | undefined
  readonly deduped?: boolean | undefined
  readonly existingPath?: string | undefined
  /** The envelope error code for this op's failure, absent when it did not fail. */
  readonly code?: ErrorCode | undefined
  readonly error?: string | undefined
  readonly skipped?: boolean | undefined
  /**
   * What this op's claim contradicts, when `detectConflicts` was on and something matched. Absent
   * when the flag was off, when nothing matched, or when the claim has no frame shape.
   *
   * Propose-only, so the presence of this field never changed what was written. See {@link batchWrite}.
   */
  readonly conflict?: FrameConflict | undefined
  /**
   * Set on a batch-internal loser under `consolidate: "last-wins"`: a later restatement of a slot
   * an earlier op already occupied. Its value won the slot, since last wins, but the write landed at
   * the earliest index with that frame key, so this op never got its own file and has no `path`.
   * The number is that slot, the caller-space index whose report carries the surviving write with its
   * path and any `supersededPath`.
   */
  readonly consolidatedInto?: number | undefined
  /**
   * Set on a winner whose write superseded a live stored memory under `consolidate: "last-wins"`:
   * the loser's archive path, where its bytes now live. Absent when nothing stored occupied the
   * slot, and also when the supersede itself degraded. The corpus is then merely unconsolidated,
   * which is what every batch produced before this flag existed.
   */
  readonly supersededPath?: string | undefined
}

export interface BatchWriteResult {
  readonly results: ReadonlyArray<BatchOpReport>
  readonly summary: {
    readonly total: number
    readonly written: number
    readonly deduped: number
    readonly failed: number
    readonly skipped: number
    /** Batch-internal losers under `consolidate: "last-wins"`: ops whose value a later op replaced. */
    readonly consolidated: number
  }
  readonly commitSha: string | null
}

export interface BatchWriteParams extends Provenance {
  readonly ops: ReadonlyArray<WriteParams>
  /** Best-effort mode: failed ops are reported and skipped, survivors land in the one commit. */
  readonly continueOnError?: boolean | undefined
  /**
   * Report each op's frame-matches as a per-op `conflict`. Changes nothing about what is written.
   *
   * Off by default, and the default is part of the contract rather than caution. The assist costs one
   * extra query per batch, and a caller that did not ask for the field would be paying for an answer
   * it does not read.
   */
  readonly detectConflicts?: boolean | undefined
  /**
   * Opt-in write-time consolidation: deterministic frame-key (`frameKeyOf`) last-wins.
   *
   * `detectConflicts` reports and leaves the corpus alone. This one acts, on the caller's explicit ask.
   * A later op whose claim occupies the same frame slot as an earlier one replaces it before
   * anything is written, so a batch-internal loser never reaches disk. A surviving op whose slot a
   * live stored memory occupies supersedes it after the commit, archiving the old file with a
   * `supersedes` chain back from the winner. Fail-closed on the rule's own terms: a claim with no
   * frame shape (null key) is never touched, and a failed store lookup degrades to
   * batch-internal-only consolidation through the same `Effect.catch` → `logWarning` → neutral
   * shape {@link detectFrameConflicts} takes, so the flag cannot become a new way to lose writes.
   */
  readonly consolidate?: "last-wins" | undefined
}

/**
 * A typed failure as a per-op report, through the same `codeFor`/`messageFor` every envelope error
 * takes.
 *
 * Mapped here rather than in each door, deliberately. A per-op code is part of the batch's payload
 * rather than of the envelope, so two doors shaping it independently is two mappings that agree today.
 * `memhtml apply` and `memory_write_batch` reporting different codes for the same refused op is
 * the drift the shared-use-case rule exists to prevent.
 */
const reportFailure = (index: number, error: unknown): BatchOpReport => ({
  index,
  ok: false,
  code: codeFor(error),
  error: messageFor(error)
})

/**
 * The `detect_conflicts` assist: which claim, if any, each op's own claim contradicts.
 *
 * **Propose-only, and that is the design rather than a v1 limitation.** The function returns a report
 * per op index and writes nothing, stages nothing, and refuses nothing, because sometimes the
 * contradiction is the answer. A memory recording that a runbook step changed necessarily contradicts
 * the memory stating the old step, and an assist that auto-archived, applied last-wins, or blocked the
 * write would destroy the pair a later reader needs to see the change in. The caller decides: write
 * anyway, `memory_correct` the match, or skip.
 *
 * **One query for the whole batch.** Every op's frame key is collected first and `activeFramesFor` is
 * called once with all of them. The signature takes an array so a caller cannot loop, and a
 * per-op lookup would be the quadratic-write-cost pattern this codebase has already paid for once.
 *
 * **Two match sources, checked in that order.** The store answers for active non-task memories. Its
 * predicate, and 0009's index, exclude archived rows and tasks, because an archived claim is not a
 * competing assertion and an open to-do phrased as a claim is working state rather than knowledge. Then
 * come the batch's own earlier ops, folded as this loop walks them in order. Two ops in one call can
 * occupy the same slot, and neither is in the store yet, so nothing but this fold can see that pair. A
 * store match wins when an op has both, because the store's memory is a fact already in the corpus
 * while the earlier op is one this same call is about to create.
 *
 * **A later op reports on an earlier one, never the reverse.** The fold is asymmetric on purpose. Op 3
 * matching op 1 tells a caller "you are about to restate something you just said", which is actionable
 * with op 3 still in hand. Reporting it on op 1 as well would name a conflict with something that did
 * not exist when op 1 was written, and would double one finding into two.
 *
 * **A lookup failure degrades to no conflicts.** The assist is a note about the writes, so losing the
 * memories over a failed note about them would invert the priority as it would for
 * {@link recordLink} and {@link bumpAccess}, with the same `Effect.catch` → `logWarning` → neutral value.
 * The write path never sees this function's failure, which makes "the assist cannot block a
 * write" true structurally rather than by review.
 */
const detectFrameConflicts = (
  ops: ReadonlyArray<WriteParams>
): Effect.Effect<ReadonlyMap<number, FrameConflict>, never, IndexRecorderShape> =>
  Effect.gen(function* () {
    /**
     * `frameKeyOf(op.claim)` per op, computed once and kept alongside the index.
     *
     * On the `article_html` path `claim` is `""` by construction, because both doors leave it empty and
     * the `<mark>` inside the markup is the claim. `frameKeyOf` therefore returns null and a markup op
     * gets no assist. Deriving one here would mean parsing every op's article at the ops layer, a second
     * render of bytes the store is about to render anyway. The boundary is stated in the tool
     * description instead of hidden behind a duplicate parse.
     */
    const keyed: Array<{ readonly index: number; readonly key: string; readonly claim: string }> =
      []
    for (const [index, op] of ops.entries()) {
      const key = frameKeyOf(op.claim)
      if (key !== null) keyed.push({ index, key, claim: op.claim })
    }
    if (keyed.length === 0) return new Map<number, FrameConflict>()

    const recorder = yield* IndexRecorder
    const live = yield* recorder
      .activeFramesFor(keyed.map((entry) => entry.key))
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`conflict assist skipped: ${error.operation}`).pipe(
            Effect.as(new Map<string, ReadonlyArray<FrameMatch>>())
          )
        )
      )

    const conflicts = new Map<number, FrameConflict>()
    /** frame key → the first op in this batch to occupy it. Built as the loop walks in order. */
    const seen = new Map<string, { readonly index: number; readonly claim: string }>()
    for (const entry of keyed) {
      const [stored] = live.get(entry.key) ?? []
      const earlier = seen.get(entry.key)
      if (stored !== undefined) {
        conflicts.set(entry.index, {
          path: stored.path,
          batchIndex: null,
          claim: stored.gist
        })
      } else if (earlier !== undefined) {
        conflicts.set(entry.index, {
          path: null,
          batchIndex: earlier.index,
          claim: earlier.claim
        })
      }
      if (earlier === undefined) seen.set(entry.key, { index: entry.index, claim: entry.claim })
    }
    return conflicts
  })

/**
 * The `consolidate: "last-wins"` plan: which slots survive, which ops lost to a later restatement,
 * and which stored memories a surviving slot supersedes. Everything is in the caller's index space.
 */
interface LastWinsPlan {
  /** The ops the pipeline runs, each at its original slot index. Losers are absent. */
  readonly ops: ReadonlyArray<{ readonly index: number; readonly op: WriteParams }>
  /** Batch-internal loser index → the slot whose position carries the surviving value. */
  readonly losers: ReadonlyMap<number, number>
  /** Surviving slot index → the live stored memory occupying that slot's frame key. */
  readonly pendingSupersede: ReadonlyMap<number, string>
}

/**
 * Fold last-wins over the caller's op array, before the decode fold, so a batch-internal loser
 * never reaches disk. The surviving value simply occupies the earliest slot with that key.
 *
 * Not derived from {@link detectFrameConflicts}' output, although the walk mirrors it. A store
 * match wins there, masking the batch-internal pair the plan needs, and the plan needs both: the
 * batch collision decides which value writes, and the store match decides what that write supersedes.
 *
 * The slot rule: the first occupant of a key keeps its position and later ops with the same key
 * replace its content (`plannedOps[slot] = laterOp`, provenance and all, since the surviving value
 * is the later op's own statement). The occupant-tracking never moves, so a third restatement
 * replaces the slot again, last wins, at a stable position a caller can index by.
 *
 * Fail-closed on both of the rule's own guards: a null frame key is never consolidated, and a
 * failed store lookup degrades to batch-internal consolidation only, through the same
 * `Effect.catch` → `logWarning` → neutral-shape path the conflict assist takes, because an opt-in
 * consolidation must not become a new way to lose writes.
 */
const planLastWins = (
  ops: ReadonlyArray<WriteParams>
): Effect.Effect<LastWinsPlan, never, IndexRecorderShape> =>
  Effect.gen(function* () {
    /** frame key → the slot (earliest occupant's index) that carries this key's surviving value. */
    const slotOf = new Map<string, number>()
    /** slot index → the op whose value currently occupies it. */
    const content = new Map<number, WriteParams>()
    const losers = new Map<number, number>()
    /** Slot indices in caller order, keyed and keyless alike. */
    const order: Array<number> = []

    for (const [index, op] of ops.entries()) {
      const key = frameKeyOf(op.claim)
      if (key === null) {
        // No frame shape, no slot. The rule's guards fail closed, so this op is never touched.
        order.push(index)
        content.set(index, op)
        continue
      }
      const slot = slotOf.get(key)
      if (slot === undefined) {
        slotOf.set(key, index)
        order.push(index)
        content.set(index, op)
        continue
      }
      content.set(slot, op)
      losers.set(index, slot)
    }

    const pendingSupersede = new Map<number, string>()
    if (slotOf.size > 0) {
      const recorder = yield* IndexRecorder
      // One query for every surviving key, for detectFrameConflicts' reason: a per-slot lookup is
      // the quadratic-write-cost shape this codebase has already paid for once.
      const live = yield* recorder
        .activeFramesFor([...slotOf.keys()])
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`consolidation store lookup skipped: ${error.operation}`).pipe(
              Effect.as(new Map<string, ReadonlyArray<FrameMatch>>())
            )
          )
        )
      for (const [key, slot] of slotOf) {
        const [stored] = live.get(key) ?? []
        if (stored !== undefined) pendingSupersede.set(slot, stored.path)
      }
    }

    return {
      ops: order.flatMap((index) => {
        const op = content.get(index)
        return op === undefined ? [] : [{ index, op }]
      }),
      losers,
      pendingSupersede
    }
  })

/**
 * Loser reports for a last-wins plan, derived from the winner slots' own final reports.
 *
 * A loser reports `ok` with `consolidatedInto` only when its slot's write landed, which means the
 * surviving value is on disk and the pointer names where. A slot that was skipped or refused took the
 * loser's value down with it, so the loser reports `skipped`, which is the retryable outcome and
 * the one an atomic abort already means: nothing of this op reached disk.
 */
const withConsolidation = (
  results: ReadonlyArray<BatchOpReport>,
  plan: LastWinsPlan | null
): ReadonlyArray<BatchOpReport> => {
  if (plan === null || plan.losers.size === 0) return results
  return results.map((report, index) => {
    const slot = plan.losers.get(index)
    if (slot === undefined) return report
    const winner = results[slot]
    return winner?.ok === true && winner.skipped !== true
      ? ({ index, ok: true, consolidatedInto: slot } satisfies BatchOpReport)
      : ({ index, ok: false, skipped: true } satisfies BatchOpReport)
  })
}

/**
 * Write N memories: one commit, one reindex, per-op results in input order.
 *
 * **Two folds, not one.** Decode is the operations layer's job and the store never sees it, so a
 * malformed `memory_type` on op 4 has to be caught here. This function therefore folds decode
 * over the ops and hands the store only what decoded. The store then folds the render gate, dedup,
 * and path claim over that, and this function splices the two result sets back into one array in
 * the caller's index space. Anything less and a decode failure would either be invisible per-op or
 * would shift every later op's index by one.
 *
 * **One reindex, gated on a file having been written** (G4). The indexer's `update()` reads
 * `git diff` over one commit, so a batch that committed once costs one diff. A dedupe-only
 * batch, which commits nothing, skips it entirely, because moving the watermark for a commit that
 * never happened is what `writeMemory`'s own `if (result.created)` guard exists to avoid.
 *
 * **The conflict assist is a third pass and it is read-only** (AC-1-2). It runs before the store's
 * fold, over the ops as the caller sent them, and its findings are merged into the reports at the
 * end, so it observes the batch and never participates in it. Nothing downstream of
 * {@link detectFrameConflicts} branches on its result: the same files are written, the same commit is
 * made, and the same ops are refused whether the flag is on or off. That is what propose-only means,
 * and it is checkable by reading this function rather than by trusting a description.
 */
export const batchWrite = (params: BatchWriteParams) =>
  Effect.gen(function* () {
    const continueOnError = params.continueOnError === true
    const store = yield* Store
    const at = yield* nowSecond

    /**
     * The assist, over the caller's own op array and before anything is written.
     *
     * Over `params.ops` rather than the decoded `inputs` below, so a conflict is reported in the
     * caller's index space directly and needs no `originOf` translation. An op the store then
     * refuses still gets its finding, which is the more useful order, because a caller told both "this
     * op is malformed" and "it also contradicts X" fixes one thing.
     *
     * Not gated on the ops being valid, and deliberately so. `frameKeyOf` is a pure lexical function
     * over a string, so it has nothing to refuse and cannot fail on an op the decode is about to reject.
     */
    const conflicts =
      params.detectConflicts === true
        ? yield* detectFrameConflicts(params.ops)
        : new Map<number, FrameConflict>()

    /**
     * The consolidation plan, before the decode fold and in the caller's index space. A
     * batch-internal loser is excluded from everything downstream, so its value never earns a file.
     * The surviving value sits at the earliest slot with its key, so every later report and
     * conflict finding stays at the index the caller sent.
     */
    const plan = params.consolidate === "last-wins" ? yield* planLastWins(params.ops) : null
    const planned =
      plan === null ? [...params.ops.entries()].map(([index, op]) => ({ index, op })) : plan.ops

    /**
     * Fold 1, decode. `Effect.result` rather than letting the failure escape, because a decode
     * refusal is this op's result and not the batch's.
     */
    const reports: Array<BatchOpReport | undefined> = params.ops.map(() => undefined)
    const inputs: Array<WriteInput> = []
    /** Store-result position → caller's op index, since the store never sees a skipped op. */
    const originOf: Array<number> = []
    let decodeAborted = false

    for (const { index, op } of planned) {
      const decoded = yield* Effect.result(toWriteInput({ ...op, ...provenanceOf(params, op) }, at))
      if (decoded._tag === "Failure") {
        reports[index] = reportFailure(index, decoded.failure)
        if (!continueOnError) {
          decodeAborted = true
          break
        }
        continue
      }
      originOf.push(index)
      inputs.push(decoded.success)
    }

    /**
     * An atomic decode abort touches the store at all. Nothing was written, so every other op,
     * including the ones that decoded, reports `skipped`, matching the store's own abort semantics
     * exactly rather than inventing a second one.
     */
    if (decodeAborted) {
      const results = withConsolidation(merged(reports, conflicts), plan)
      return { results, summary: summarize(results), commitSha: null } satisfies BatchWriteResult
    }

    /**
     * The extraction assist: one model call over the decoded ops, extracted entities unioned into
     * each op's own `entities` before anything is written, so they land as ordinary `memhtml-entity`
     * metas and the git tree, rather than the index, is what remembers them.
     *
     * After the decode fold because a refused op must not reach the prompt, and before the store
     * because the render is what serializes the metas. Failure costs exactly this batch's
     * extracted entities. The port being absent, the model being down, and an unreadable payload
     * all take the same logged-warning path, and the write itself never waits on a retry.
     * `entities: []` is what every write produced before this assist existed.
     */
    const extractor = (yield* ExtractorPort).extractor
    if (extractor !== undefined && inputs.length > 0) {
      const items: Array<ExtractionItem> = inputs.map((input) => ({
        title: input.title,
        text:
          input.articleHtml !== undefined
            ? input.articleHtml
            : [input.claim, ...(input.body ?? [])].join("\n")
      }))
      const outcome = yield* Effect.result(extractor.extract(items))
      if (outcome._tag === "Failure") {
        yield* Effect.logWarning(
          `entity extraction skipped for this batch: ${outcome.failure.reason}`
        )
      } else {
        for (const [index, extracted] of outcome.success.entries()) {
          const input = inputs[index]
          if (input === undefined || extracted.length === 0) continue
          const declared = input.entities ?? []
          const union = [...declared, ...extracted.filter((entity) => !declared.includes(entity))]
          inputs[index] = { ...input, entities: union }
        }
      }
    }

    // Fold 2, the store: render gate, dedup against the folded state, one commit.
    const batch = yield* store.writeMemories(inputs, { continueOnError })

    for (const entry of batch.results) {
      const index = originOf[entry.index]
      if (index === undefined) continue
      reports[index] =
        entry.ok || entry.skipped === true
          ? {
              index,
              ok: entry.ok,
              ...defined({
                path: entry.path,
                deduped: entry.deduped,
                existingPath: entry.existingPath,
                skipped: entry.skipped
              })
            }
          : reportFailure(index, entry.error)
    }

    // One reindex, after the commit, only when a file was actually written.
    if (batch.writtenPaths.length > 0) yield* reindex()
    for (const path of batch.writtenPaths) yield* recordLink(path, "wrote", params, at)

    /**
     * The store-supersede pass, after a successful batch commit: every surviving slot whose frame
     * key a live memory occupied archives that memory, in one `supersedeMemories` call.
     *
     * A slot qualifies when its report is `ok` with a path, including a dedupe, where the path is
     * the pre-existing file that already carries this slot's value. The stored occupant still
     * states the losing value, so superseding it is still correct. A slot that failed or was
     * skipped wrote nothing, so there is nothing for its occupant to lose to.
     *
     * `Effect.result` rather than a bare yield, because a failed supersede must not fail a batch whose
     * memories already landed. The degradation is annotate-only: `supersededPath` is omitted, the
     * warning says why, and the corpus is merely unconsolidated, which is what every batch produced
     * before this flag existed. On success there is one extra reindex, because archive paths moved.
     */
    if (plan !== null && plan.pendingSupersede.size > 0) {
      const pairs: Array<{ readonly winnerPath: string; readonly loserPath: string }> = []
      const winnerOf = new Map<string, number>()
      for (const [slot, storedPath] of plan.pendingSupersede) {
        const report = reports[slot]
        if (report === undefined || !report.ok || report.skipped === true) continue
        if (report.path === undefined) continue
        // A slot whose content deduped onto the occupant itself is a restatement rather than a
        // supersession. Winner and loser are one file, and archiving it would lose the value.
        if (report.path === storedPath) continue
        pairs.push({ winnerPath: report.path, loserPath: storedPath })
        winnerOf.set(storedPath, slot)
      }
      if (pairs.length > 0) {
        const outcome = yield* Effect.result(store.supersedeMemories(pairs))
        if (outcome._tag === "Failure") {
          yield* Effect.logWarning(
            `consolidation supersede skipped: ${messageFor(outcome.failure)}`
          )
        } else {
          for (const entry of outcome.success.archived) {
            const slot = winnerOf.get(entry.loserPath)
            const report = slot === undefined ? undefined : reports[slot]
            if (slot === undefined || report === undefined) continue
            reports[slot] = { ...report, supersededPath: entry.archivePath }
          }
          if (outcome.success.archived.length > 0) yield* reindex()
        }
      }
    }

    /**
     * An op the store aborted before reaching has no result of its own, and neither does one whose
     * decode succeeded in a batch the store then aborted. Both are `skipped`. Losers pick up their
     * `consolidatedInto` pointer last, from their winner slot's own final report.
     */
    const results = withConsolidation(merged(reports, conflicts), plan)

    return {
      results,
      summary: summarize(results),
      commitSha: batch.commitSha
    } satisfies BatchWriteResult
  })

/**
 * Per-op provenance falls back to the batch's own.
 *
 * The batch call carries the session the agent is in, and an op may name its own (a `memhtml apply`
 * file replaying a previous session's writes). Per-op wins, because it is the more specific statement
 * about where that one memory came from.
 */
const provenanceOf = (params: BatchWriteParams, op: WriteParams): Provenance =>
  defined({
    sessionId: op.sessionId ?? params.sessionId,
    promptId: op.promptId ?? params.promptId,
    turnUuid: op.turnUuid ?? params.turnUuid
  })

/**
 * The reports as their final array: an unreported op becomes `skipped`, and every op picks up the
 * assist's finding for its index.
 *
 * One function for both exit paths, the atomic decode abort and the normal return, because they had
 * already grown two copies of the same `?? skipped` fill and a third responsibility spliced into only
 * one of them is how a batch that aborted would silently lose its conflict findings. The abort path
 * needs them because nothing was written. A caller told "op 2 is malformed" and also "op 0
 * contradicts areas/x.html" can fix both before retrying, rather than discovering the second on the
 * next round trip.
 *
 * Merging here rather than at each report's construction site also keeps the assist out of the
 * write path. The reports are already final when the conflicts are attached, so there is no point at
 * which a conflict could be read by anything that decides an outcome.
 */
const merged = (
  reports: ReadonlyArray<BatchOpReport | undefined>,
  conflicts: ReadonlyMap<number, FrameConflict>
): ReadonlyArray<BatchOpReport> =>
  reports.map((report, index) => {
    const base = report ?? ({ index, ok: false, skipped: true } satisfies BatchOpReport)
    const conflict = conflicts.get(index)
    return conflict === undefined ? base : { ...base, conflict }
  })

/** The counts, derived from the reports in one pass so they cannot disagree with them. */
const summarize = (results: ReadonlyArray<BatchOpReport>): BatchWriteResult["summary"] => {
  let written = 0
  let deduped = 0
  let failed = 0
  let skipped = 0
  let consolidated = 0
  for (const result of results) {
    // A batch-internal loser is neither written nor failed. Its value survived at another slot,
    // and no file of its own was ever attempted, so it partitions into its own count.
    if (result.consolidatedInto !== undefined) consolidated += 1
    else if (result.skipped === true) skipped += 1
    else if (!result.ok) failed += 1
    else if (result.deduped === true) deduped += 1
    else written += 1
  }
  return { total: results.length, written, deduped, failed, skipped, consolidated }
}

/**
 * Read one memory, optionally recording that the session read it.
 *
 * The access bump lives here and nowhere else on the retrieval side, because salience accumulates
 * evidence that someone chose a memory and a ranker's guess is not a choice. An explicit open names
 * one path, through this call and the `memhtml://file/{path}` resource that funnels through it, which is
 * the strongest signal short of a write. A path merely returned by search or recall was the ranker's own
 * suggestion, and bumping it builds a rich-get-richer loop: today's top five rank higher
 * tomorrow while the memory that should displace them never breaks in to earn a first bump.
 *
 * `bumpAccess` sits beside `recordLink` deliberately. Both are notes about the read, both swallow their
 * own failures, and neither may cost the caller the memory it asked for.
 */
export const readMemory = (path: string, provenance: Provenance = {}) =>
  Effect.gen(function* () {
    const store = yield* Store
    const result = yield* store.readMemory(path)
    yield* recordLink(result.path, "read", provenance, yield* nowSecond)
    yield* bumpAccess([result.path])
    return result
  })

export interface SearchParams extends SearchScope {
  readonly query: string
  readonly limit?: number | undefined
}

/**
 * Ranked search. The retrieval service sanitizes the query text itself in `fts-query.ts`, so this
 * function never MATCHes user prose and neither does any caller of it.
 *
 * **No access bump, and the omission is the rule rather than an oversight.** A hit is the ranker's
 * guess about what the caller wanted, so counting it as salience would let the ranking teach itself.
 * A memory in today's top five would rank higher tomorrow purely for having been listed, and the
 * memory that should displace it never appears and so never earns a first bump. The cooldown does not
 * help, because it bounds one query replayed within 900 seconds, while the drift it would have to
 * bound operates across days. Salience moves when a caller opens a path ({@link readMemory}) or names
 * an outcome ({@link reinforceMemories}).
 */
export const searchMemories = (params: SearchParams) =>
  Effect.gen(function* () {
    const retrieval = yield* Retrieval
    return yield* retrieval.search(params)
  })

export interface RecallParams extends SearchScope {
  readonly query: string
  readonly budgetChars?: number | undefined
}

/**
 * A context pack under a character budget.
 *
 * No access bump either, for {@link searchMemories}' reason. A disclosed body is still the ranker's
 * choice of what to spend the budget on rather than the caller's choice of what to read.
 */
export const recallMemories = (params: RecallParams) =>
  Effect.gen(function* () {
    const retrieval = yield* Retrieval
    return yield* retrieval.recall(params)
  })

/**
 * Bump access bookkeeping for paths a caller chose to open. A missing state plane makes this a no-op.
 *
 * `reinforce` is the one SQL writer for `state.access` and this helper does not become a second one.
 * It moves callers to that writer rather than moving the write here.
 */
const bumpAccess = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (paths.length === 0) return
    const db = yield* DatabaseService
    if (!db.hasState) return
    yield* reinforce(db, paths, "neutral", yield* nowSecond).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`access bookkeeping missed: ${error.operation}`).pipe(
          Effect.as({ bumped: [], cooledDown: [] })
        )
      )
    )
  })

export interface CorrectParams extends Provenance {
  readonly targetPath: string
  readonly title: string
  readonly claim: string
  readonly body?: ReadonlyArray<string> | undefined
  /** Pre-authored article markup for the superseding file, used verbatim in place of `claim`/`body`. */
  readonly articleHtml?: string | undefined
  readonly memoryType?: string | undefined
  readonly reason?: string | undefined
}

/**
 * Supersede a memory: the new file and the archived target land in one commit.
 *
 * The type defaults to the target's own. A correction that silently changed the type would move
 * the memory to a different retention profile and a different PARA directory, and that is a second
 * decision the caller did not make.
 */
export const correctMemory = (params: CorrectParams) =>
  Effect.gen(function* () {
    const store = yield* Store
    const target = yield* store.readMemory(params.targetPath)
    const requested = params.memoryType ?? target.doc.metas.memoryType
    const memoryType = yield* decodeWritableType(requested)
    const at = yield* nowSecond

    const result = yield* store.correctMemory(params.targetPath, {
      title: params.title,
      claim: params.claim,
      memoryType,
      at,
      ...defined({
        body: params.body,
        articleHtml: params.articleHtml,
        reason: params.reason,
        sessionId: params.sessionId,
        promptId: params.promptId,
        turnUuid: params.turnUuid
      })
    })

    // A correction is an add and a rename in one commit, so it needs the diff-driven path. The
    // archived target's row has to move rather than be re-added under a new name beside its old one.
    yield* reindex()
    yield* recordLink(result.path, "corrected", params, at)
    return result
  })

/**
 * Add an authored edge. Idempotent on `(rel, href)`, so a re-run commits nothing.
 *
 * The rel is decoded against {@link AUTHORABLE_RELS}, the memory class plus the task class, so
 * `memhtml link a.html blocks b.html` reaches the task graph while a person or provenance rel, both of
 * which the system mints itself, stays unauthorable.
 */
export const linkMemories = (srcPath: string, rel: string, dstPath: string) =>
  Effect.gen(function* () {
    const edgeRel = yield* decodeAuthorableRel(rel)
    const store = yield* Store
    const src = normalizePath(srcPath)
    const result = yield* store.linkMemories(src, edgeRel, dstPath)
    // `addLink` is idempotent on the pair, so a re-link commits nothing and there is nothing to
    // index. Re-deriving a diff for a no-op would move the watermark for a commit that never was.
    if (result.commitSha !== null) yield* reindex()
    return { ...result, srcPath: src, dstPath: normalizePath(dstPath), rel: edgeRel }
  })

/** Soft-evict: `git mv` into `archive/<YYYY>/` with the archive stamps. Never a delete. */
export const archiveMemory = (path: string, reason: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const result = yield* store.archiveMemory(path, reason)
    // An archive is a pure rename. Handled as two independent paths it would leave the source row
    // live and duplicate the chunks. The diff path re-points the row and keeps the vector.
    yield* reindex()
    return result
  })

/** Bump access bookkeeping deliberately, with a caller-chosen signal. */
export const reinforceMemories = (paths: ReadonlyArray<string>, signal: string) =>
  Effect.gen(function* () {
    const decoded = yield* decodeSignal(signal)
    const db = yield* DatabaseService
    const at = yield* nowSecond
    if (!db.hasState) {
      return { bumped: [] as ReadonlyArray<string>, cooledDown: paths, signal: decoded }
    }
    const result = yield* reinforce(db, paths, decoded, at)
    return { ...result, signal: decoded }
  })

export interface NeighborsParams {
  readonly path: string
  /** 1 or 2. Clamped rather than refused: a caller asking for 5 wants "as much as you'll give". */
  readonly depth?: number | undefined
  readonly rels?: ReadonlyArray<string> | undefined
  /**
   * Distinct nodes to return, 1 to {@link NEIGHBORS_LIMIT}. Clamped rather than refused, like
   * `memory_list`'s 500 and `trace_search`'s 200, because a caller asking for more than the ceiling
   * wants the ceiling.
   */
  readonly limit?: number | undefined
}

/** One node in a neighborhood. `hop` is 1-based distance from the center: 1 or 2, never 0. */
export interface NeighborNode {
  readonly path: string
  readonly title: string
  readonly hop: number
  /** The rel of an edge at this node's minimal hop, so the pair describes one real edge. */
  readonly rel: string
  /** True when ANY edge reaching this node is sleep-mined rather than authored. */
  readonly derived: boolean
}

/**
 * The ceiling on nodes per neighborhood, and the default when a caller names none.
 *
 * A caller-supplied `limit` is clamped into `1..NEIGHBORS_LIMIT`, which is the shape both sibling
 * reads have (`memory_list` `Math.min(500, …)`, `trace_search` `Math.min(200, …)`). A clamp with no
 * flag behind it is a ceiling a caller can neither ask for nor lower.
 */
export const NEIGHBORS_LIMIT = 200

/**
 * Edge rows the statement may RETURN before it stops.
 *
 * **This bounds the answer, not the join.** Measured 2026-08-25 on node 24.19.0 against the shipped
 * schema: `EXPLAIN QUERY PLAN` on {@link neighborsQuery}'s depth-2 statement yields `MERGE
 * (UNION ALL)` with `USE TEMP B-TREE FOR ORDER BY` on every arm, so SQLite enumerates the union and
 * sorts the whole row set in a temp b-tree BEFORE the `LIMIT` takes its prefix. A hub of degree
 * 150/300/450 generates 22.5k/90k/202k rows either way, and the limited statement runs in
 * 47/92/155 ms against 66/253/591 ms unlimited — so the cap buys real time and memory downstream of
 * the sort while the join's work and the temp b-tree still grow with the center's degree squared.
 *
 * What the cap does bound: the rows that cross into JS, the fold below, and the size of one answer.
 * A neighborhood that reaches it is truncated rather than exhaustive, and `scanSaturated` says so
 * instead of leaving the caller to infer it — raising a caller's `limit` cannot recover an edge the
 * walk never returned.
 *
 * Bounding each arm before the union WOULD bound the join, and is not done: an arm-level `LIMIT`
 * takes an arbitrary prefix of one direction's edges, so the hop-1 nodes that survive decide which
 * hop-2 nodes exist at all, and the answer would change with the planner's row order rather than
 * only shrink.
 */
const NEIGHBORS_SCAN_LIMIT = 10_000

/**
 * The neighborhood walk as one statement plus its bind list.
 *
 * Exported so a cost assertion can `EXPLAIN QUERY PLAN` the string this function actually issues.
 * A plan asserted against a copy pasted into a test explains the copy, and the two drift the first
 * time an arm moves.
 *
 * Hop 1 is the center's own edges, either direction. Hop 2 walks one further from each hop-1 node and
 * excludes the center, so a two-cycle does not report the center as its own neighbor at distance 2.
 * Each arm carries the edge's own endpoints (`a`, `b`) so an edge can be counted as an edge, not
 * inferred from a node count.
 *
 * The join onto `files` is an inner join, so an edge pointing at a path the tree does not hold
 * contributes nothing. A dangling href is `memhtml doctor`'s finding rather than a titleless node.
 *
 * The rel list binds once per occurrence of the filter, in textual order: hop 1 uses it twice, hop 2
 * uses it four more times. Getting this count wrong is a bind mismatch rather than a wrong answer, so
 * it fails loudly.
 */
export const neighborsQuery = (input: {
  readonly center: string
  readonly depth: number
  readonly rels: ReadonlyArray<string>
}): { readonly sql: string; readonly params: ReadonlyArray<string> } => {
  const { center, depth, rels } = input
  const relFilter = rels.length > 0 ? ` AND e.rel IN (${rels.map(() => "?").join(", ")})` : ""
  const relFilter2 = rels.length > 0 ? ` AND e2.rel IN (${rels.map(() => "?").join(", ")})` : ""

  const hopOne = `
      SELECT e.dst_path AS path, e.rel AS rel, e.derived AS derived, 1 AS hop,
             e.src_path AS a, e.dst_path AS b
      FROM edges e
      WHERE e.src_path = ?1 AND e.edge_class = 'memory'${relFilter}
      UNION ALL
      SELECT e.src_path AS path, e.rel AS rel, e.derived AS derived, 1 AS hop,
             e.src_path AS a, e.dst_path AS b
      FROM edges e
      WHERE e.dst_path = ?1 AND e.edge_class = 'memory'${relFilter}`

  const hopTwo = `
      SELECT e2.dst_path AS path, e2.rel AS rel, e2.derived AS derived, 2 AS hop,
             e2.src_path AS a, e2.dst_path AS b
      FROM edges e
      JOIN edges e2 ON e2.src_path = e.dst_path
      WHERE e.src_path = ?1 AND e.edge_class = 'memory' AND e2.edge_class = 'memory'
        AND e2.dst_path <> ?1${relFilter}${relFilter2}
      UNION ALL
      SELECT e2.src_path AS path, e2.rel AS rel, e2.derived AS derived, 2 AS hop,
             e2.src_path AS a, e2.dst_path AS b
      FROM edges e
      JOIN edges e2 ON e2.dst_path = e.src_path
      WHERE e.dst_path = ?1 AND e.edge_class = 'memory' AND e2.edge_class = 'memory'
        AND e2.src_path <> ?1${relFilter}${relFilter2}`

  const walk = depth === 1 ? hopOne : `${hopOne}\n      UNION ALL${hopTwo}`

  return {
    sql: `SELECT w.path AS path, f.title AS title, w.rel AS rel, w.derived AS derived,
              w.hop AS hop, w.a AS a, w.b AS b
       FROM (${walk}) w
       JOIN files f ON f.path = w.path
       ORDER BY w.hop ASC, w.path ASC
       LIMIT ${NEIGHBORS_SCAN_LIMIT}`,
    params: [
      center,
      ...(depth === 1 ? [...rels, ...rels] : [...rels, ...rels, ...rels, ...rels, ...rels, ...rels])
    ]
  }
}

/**
 * The memory graph around one path, to a fixed depth of at most two hops.
 *
 * **Two fixed-depth joins in a `UNION ALL`, deliberately not a recursive CTE.** The depth is
 * bounded at 2 by the tool's contract, so recursion buys nothing and costs the one thing a graph
 * query must not have here: an unbounded worst case on a corpus whose `relates_to` edges are
 * mined by the sleep cycle and can be dense.
 *
 * **Only the forward direction is index-probed, and `edges_src`/`edges_dst` are not what probes it.**
 * Measured 2026-08-25 on node 24.19.0 (locked by the plan assertion in `apps/cli/tests/e2e.test.ts`):
 * both of those indexes are PARTIAL — `WHERE derived = 0` (`0008_tasks.sql`) — and this walk includes
 * derived edges on purpose, so neither is available to it. The `src_path = ?1` arms probe
 * `sqlite_autoindex_edges_1` instead, the implicit index behind `PRIMARY KEY (src_path, rel,
 * dst_path)`, whose leftmost column is the one they filter on. The `dst_path = ?1` arms have no such
 * luck and are a full SCAN of `edges`, so a neighborhood costs one table scan per reverse arm on top
 * of the degree² row set. A `rels` filter changes that: `edges_rel` carries no predicate, so a
 * rel-scoped walk probes on every arm.
 *
 * **Both directions, and `derived = 0 ∪ derived = 1`.** An edge is an assertion about a pair, and
 * which file happens to hold the `<link>` is authorship rather than direction of meaning. A
 * neighborhood that read only outbound edges would show a superseding memory its target and hide
 * from the target that it had been superseded. Derived edges are included because lateral retrieval
 * is what they are for. `derived` is still reported per node so a caller can tell a
 * sleep-mined suspicion from an authored assertion.
 *
 * `edge_class = 'memory'` on every join. A person edge entering here would put
 * `resources/people/*` into a memory neighborhood, and the class column exists to make that
 * structurally impossible.
 */
export const neighborsOf = (params: NeighborsParams) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const center = normalizePath(params.path)
    const depth = Math.min(2, Math.max(1, Math.trunc(params.depth ?? 1)))
    const limit = Math.min(
      NEIGHBORS_LIMIT,
      Math.max(1, Math.trunc(params.limit ?? NEIGHBORS_LIMIT))
    )

    const rels = (params.rels ?? []).filter(
      (rel) => isEdgeRel(rel) && relClassFor(rel) === "memory"
    )

    /**
     * Edge rows, hop-1 first, folded per path below rather than `GROUP BY` in SQL. A `GROUP BY`
     * with `min(hop)` and `min(rel)` aggregates the two columns independently, so a node reachable
     * as `supersedes` at hop 1 and `contradicts` at hop 2 would report `(hop 1, contradicts)`, a
     * pairing no edge holds. The fold keeps the rel of an edge AT the minimal hop.
     */
    const statement = neighborsQuery({ center, depth, rels })
    const rows = yield* db.all<{
      path: string
      title: string
      rel: string
      derived: number
      hop: number
      a: string
      b: string
    }>(statement.sql, statement.params)

    /**
     * One node per path at its minimal hop: a node reachable both directly and via a detour is a
     * 1-hop neighbor, and reporting it twice would let one memory occupy two slots in a bounded
     * answer. The rows arrive hop-first, so a path's first row IS an edge at its minimal hop and
     * its rel is kept verbatim. `derived` is the max over every edge reaching the node, so one
     * sleep-mined route marks the node as carrying a mined suspicion even when an authored edge
     * also reaches it. `edges` counts distinct edges the walk enumerated, which is what the MCP
     * schema's `edges` field claims to be.
     *
     * A path the clamp turns away is still counted, in `nodesDropped`, and its edges still count
     * toward `edges`: the two numbers live in different coordinate spaces on purpose, and an `edges`
     * total that quietly excluded a dropped path's edges would agree with `nodes` while describing
     * a walk that never happened.
     */
    const byPath = new Map<string, { title: string; hop: number; rel: string; derived: boolean }>()
    const edgeKeys = new Set<string>()
    const dropped = new Set<string>()
    for (const row of rows) {
      edgeKeys.add(JSON.stringify([row.a, row.rel, row.b]))
      const existing = byPath.get(row.path)
      if (existing === undefined) {
        if (byPath.size < limit) {
          byPath.set(row.path, {
            title: row.title,
            hop: row.hop,
            rel: row.rel,
            derived: row.derived === 1
          })
        } else {
          dropped.add(row.path)
        }
      } else if (row.derived === 1) {
        byPath.set(row.path, { ...existing, derived: true })
      }
    }

    const nodes: ReadonlyArray<NeighborNode> = [...byPath.entries()].map(([path, node]) => ({
      path,
      title: node.title,
      hop: node.hop,
      rel: node.rel,
      derived: node.derived
    }))
    return {
      center,
      depth,
      /** The node ceiling this answer was built under, after clamping the caller's ask. */
      limit,
      nodes,
      edges: edgeKeys.size,
      /**
       * Distinct paths the walk reached and `limit` turned away. `0` means `nodes` holds every path
       * the walk found, so a caller can tell a saturated neighborhood from a complete one. Raising
       * `limit` toward {@link NEIGHBORS_LIMIT} returns them.
       */
      nodesDropped: dropped.size,
      /**
       * True when the walk returned {@link NEIGHBORS_SCAN_LIMIT} rows, so edges past the cap were
       * never enumerated and no `limit` recovers them. Distinct from `nodesDropped`, which a bigger
       * `limit` fixes.
       */
      scanSaturated: rows.length >= NEIGHBORS_SCAN_LIMIT
    }
  })

export interface ListParams {
  readonly memoryType?: string | undefined
  readonly workspace?: string | undefined
  readonly tag?: string | undefined
  readonly entity?: string | undefined
  /**
   * `<dl>` facet predicates, AND across distinct names and OR within one name — `SearchScope.facets`'
   * rule, from the same builder, so a narrowing that finds a memory through `memhtml list` finds it
   * through `memhtml search` too.
   */
  readonly facets?: ReadonlyArray<FacetFilter> | undefined
  readonly para?: string | undefined
  readonly limit?: number | undefined
  /** The previous page's `nextCursor`: the last path returned. A keyset rather than an offset. */
  readonly cursor?: string | undefined
  readonly includeArchived?: boolean | undefined
}

/**
 * Page the corpus by facet.
 *
 * Keyset pagination on `path` rather than `LIMIT/OFFSET`. `files.path` is the primary key and it also
 * moves, because eviction is a `git mv`, so an offset page taken while a sleep cycle archives a file
 * would skip a row or repeat one. A cursor on the path itself is stable against that.
 */
export const listMemories = (params: ListParams) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const limit = Math.min(500, Math.max(1, Math.trunc(params.limit ?? 50)))
    const conditions: Array<string> = []
    const values: Array<string | number> = []

    if (params.includeArchived !== true) conditions.push("f.archived = 0")
    if (params.memoryType !== undefined && params.memoryType !== "") {
      const memoryType = yield* decodeWritableType(params.memoryType)
      conditions.push("f.memory_type = ?")
      values.push(memoryType)
    }
    if (params.workspace !== undefined && params.workspace !== "") {
      conditions.push("f.workspace = ?")
      values.push(params.workspace)
    }
    if (params.para !== undefined && params.para !== "") {
      conditions.push("f.para = ?")
      values.push(params.para)
    }
    if (params.tag !== undefined && params.tag !== "") {
      conditions.push("EXISTS (SELECT 1 FROM file_tags t WHERE t.path = f.path AND t.tag = ?)")
      values.push(params.tag)
    }
    if (params.entity !== undefined && params.entity !== "") {
      // The entity arrives as `type:name` and the table splits it at the first colon, so the
      // comparison rebuilds the reference rather than making the caller know the split. `lower()` on
      // BOTH sides for the same reason `assembleScope` folds that way: listing and search are one
      // vocabulary, so a spelling that finds a memory through one door has to find it through the
      // other, and the fold has to happen on one side of the JS/SQL seam rather than both.
      conditions.push(
        "EXISTS (SELECT 1 FROM file_entities e WHERE e.path = f.path AND lower(e.entity_type || ':' || e.entity_name) = lower(?))"
      )
      values.push(params.entity.trim())
    }
    /**
     * The facet axis, from `@memhtml/index`'s builder rather than a second copy of the grouping.
     *
     * The listing binds anonymous `?` in textual order, so the placeholder callback pushes onto
     * `values` and returns the marker. That is the same contract the numbered form has: whatever the
     * builder emits, the values it pushed are in the order the statement reads them.
     */
    for (const condition of facetConditions(params.facets ?? [], "f", (value) => {
      values.push(value)
      return "?"
    })) {
      conditions.push(condition)
    }
    if (params.cursor !== undefined && params.cursor !== "") {
      conditions.push("f.path > ?")
      values.push(normalizePath(params.cursor))
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
    const rows = yield* db.all<{
      path: string
      title: string
      memory_type: string
      gist: string
      workspace: string | null
      para: string
      confidence: number
      importance: number
      archived: number
      updated_at: string
    }>(
      `SELECT f.path, f.title, f.memory_type, f.gist, f.workspace, f.para,
              f.confidence, f.importance, f.archived, f.updated_at
       FROM files f ${where} ORDER BY f.path ASC LIMIT ?`,
      [...values, limit + 1]
    )

    // One row over the limit is fetched to decide whether a next page exists, then dropped. A
    // separate COUNT would be a second statement over the same predicate and could disagree with
    // this one under a concurrent write.
    const page = rows.slice(0, limit)
    const nextCursor = rows.length > limit ? (page.at(-1)?.path ?? null) : null
    return {
      files: page.map((row) => ({
        path: row.path,
        title: row.title,
        memoryType: row.memory_type,
        gist: row.gist,
        workspace: row.workspace,
        para: row.para,
        confidence: row.confidence,
        importance: row.importance,
        archived: row.archived === 1,
        updatedAt: row.updated_at
      })),
      nextCursor
    }
  })

/**
 * The task surface: CRUDL without retrieval.
 *
 * A task is the 10th `memory_type` and it is default-excluded from search, dedup, and every sleep
 * phase, so the working set an agent needs is not reachable by ranking. These three
 * functions are how it becomes reachable: `task add` wraps {@link writeMemory}, `task status` is one
 * head meta edited in place, and {@link listTasks} is a direct indexed scan. Reading a directory,
 * grepping a meta, and editing one line remain equally valid, and nothing here is the only path.
 */

export interface TaskStatusParams {
  readonly path: string
  readonly status: string
  /** Why the task closed. Stamped as the archive reason when the status is `done`. */
  readonly reason?: string | undefined
}

/** What a status change did. `archived` is true only for the `done` transition. */
export interface TaskStatusResult {
  readonly path: string
  readonly taskStatus: TaskStatus
  readonly archived: boolean
  /** The archive path, present iff `archived`. */
  readonly archivePath?: string | undefined
  readonly commitSha: string | null
  /** True when the file already carried this status, so nothing was written. */
  readonly unchanged: boolean
}

/**
 * Move a task to a new status.
 *
 * **`setMeta`, never parse→serialize.** The editors splice by source offset, so the article's bytes
 * cannot move on a status change, and neither can `memhtml-content-hash`, the dedupe key, or any chunk
 * id hanging off it. A round trip through the serializer drops a `<pre>` newline per write, which
 * would re-embed a task for a one-word edit and break the hash the file claims for itself.
 *
 * **`done` routes through `store.archiveMemory`**, which is a `git mv`. That is the design decision
 * that keeps `done` off the `memhtml-status` axis. Finishing a task stamps the status and moves the file
 * under `archive/<YYYY>/`, so "what did I finish" is the archive tree plus `git log` rather than a
 * fifth value every archive, correction, and publish path would have to learn. The stamp is written
 * before the move so both land in one commit and `git log --follow` reads through it.
 *
 * Reindexed through {@link reindex}, which diffs the whole commit. The `done` transition is a rename,
 * and only a diff expresses one: indexing the destination path alone leaves the pre-archive row live,
 * duplicates the chunks under two paths, and records no watermark.
 */
export const setTaskStatus = (params: TaskStatusParams) =>
  Effect.gen(function* () {
    const status = yield* decodeTaskStatus(params.status)
    const store = yield* Store
    const path = normalizePath(params.path)
    const at = yield* nowSecond

    // Read through the parser. A `memhtml task status` on a memory file would otherwise stamp a meta the
    // format refuses on that type, producing a file the indexer then declines to project.
    const existing = yield* store.readMemory(path)
    if (existing.doc.metas.memoryType !== "task") {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `${path} is a ${existing.doc.metas.memoryType} memory, not a task: only a task carries memhtml-task-status`
        })
      )
    }

    /**
     * A no-op status change writes nothing and commits nothing, so a re-run is free and the tree
     * stays byte-identical. The `memhtml-updated` stamp is skipped along with it, because a fresh
     * timestamp with no status change would claim the task moved when it did not.
     */
    if (existing.doc.metas.taskStatus === status) {
      return {
        path,
        taskStatus: status,
        archived: false,
        commitSha: null,
        unchanged: true
      } satisfies TaskStatusResult
    }

    const stamped = setMeta(
      setMeta(existing.html, "memhtml-task-status", status),
      "memhtml-updated",
      at
    )
    yield* attemptIo(`task.write:${path}`, async () => {
      const { writeFile } = await import("node:fs/promises")
      const { join } = await import("node:path")
      await writeFile(join(store.root, path), stamped, "utf8")
    })

    if (status !== "done") {
      yield* store.git.add([path])
      const commit = yield* store.git.commit(commitSubject("task", `${status} ${path}`))
      yield* reindex()
      return {
        path,
        taskStatus: status,
        archived: false,
        commitSha: commit.sha,
        unchanged: false
      } satisfies TaskStatusResult
    }

    /**
     * `archiveMemory` stages the `git mv` and commits, and it reads the file from disk, so the
     * `memhtml-task-status: done` stamp written just above travels with the move rather than needing a
     * second commit. `git mv` carries a working-tree modification with it (probed live 2026-08-02:
     * the staged blob is the pre-edit content and the worktree keeps the edit), and `archiveMemory`
     * re-writes the stamped bytes at the destination before staging, so the committed file holds
     * both the archive stamps and the done status.
     */
    const archived = yield* store.archiveMemory(path, params.reason ?? `task ${status}`)
    yield* reindex()
    return {
      path,
      taskStatus: status,
      archived: true,
      archivePath: archived.archivePath,
      commitSha: archived.commitSha,
      unchanged: false
    } satisfies TaskStatusResult
  })

export interface ListTasksParams {
  readonly status?: string | undefined
  readonly workspace?: string | undefined
  /** An ISO date. Returns tasks due strictly before it, so `--due-before today` is "overdue". */
  readonly dueBefore?: string | undefined
  readonly limit?: number | undefined
  /** The previous page's `nextCursor`: the last path returned. A keyset rather than an offset. */
  readonly cursor?: string | undefined
  readonly includeArchived?: boolean | undefined
  /**
   * Only tasks the sleep cycle DETECTED, never ones a human or an agent opened by hand.
   *
   * Issue #44's author separation, as the flag that makes it usable: "a human can review the machine's
   * queue separately". A detected task is a PROPOSAL with evidence and a human-opened task is a
   * decision already made, so they are two different reading sessions, and a queue that mixes them
   * makes the reviewer sort by hand.
   *
   * Absent means "both", not "only human-opened". A negative filter would be a second flag, and nobody
   * has asked for the reading it answers: an agent listing work does not care who noticed it.
   */
  readonly detected?: boolean | undefined
}

/**
 * The `GLOB` pattern that matches a detected task's path, and nothing else.
 *
 * **The PATH is the discriminator, and `author` is deliberately not it.** `packages/sleep/src/tasks.ts`
 * records why the path carries the detection key: it survives `rm index.db && rebuild` with no
 * projection, it is collision-free by construction, and it costs no new meta in a CLOSED vocabulary.
 * `files.author` IS a real column and every detected task carries `agent:sleep` in it — but so does
 * every memory `trace-consolidation` and `arc-synthesis` write, and so would a task an operator opened
 * while impersonating the cycle. `author = 'agent:sleep'` is therefore necessary and not sufficient,
 * while the path is both. Adding the author predicate beside this one would look like defense in depth
 * and would actually be a second, weaker copy of the same test — and it would break the moment a
 * detector minted under a different author, which is a change the path would survive.
 *
 * `GLOB` rather than `LIKE`, and the character class is the reason. `LIKE 'areas/inbox/tasks/det-%'`
 * would match `det-nothex…` and `detonate-things.html`; the twelve `[0-9a-f]` positions are the same
 * shape `detectionKeyOf`'s regex asserts, so the two agree about what a detected path IS. Verified
 * against node:sqlite: the pattern matches a real detected path and an archived one, and rejects a
 * human `t-…` task, a non-hex stem, a short digest, and `detonate-`.
 *
 * The leading `*` covers the ARCHIVE. `archivePathFor` prefixes `archive/<year>/`, so a closed detected
 * task's path is `archive/2026/areas/inbox/tasks/det-…`, and `--detected --include-archived` has to
 * reach it or "what did the machine propose and what happened to it" is unanswerable. It also means the
 * pattern is anchored on the FILENAME rather than on the directory, which is correct: the digest prefix
 * is the claim, and `placementFor` owns where a task files.
 */
const DETECTED_TASK_GLOB = `*/${DETECTION_PREFIX}${"[0-9a-f]".repeat(DETECTION_DIGEST_CHARS)}-*.html`

/** One task row as `task list` reports it. */
export interface TaskRow {
  readonly path: string
  readonly title: string
  readonly taskStatus: string | null
  readonly dueAt: string | null
  readonly workspace: string | null
  readonly archived: boolean
  readonly updatedAt: string
  /** Every task asserting `blocks` toward this one, path-ordered. Empty when nothing blocks it. */
  readonly blockedBy: ReadonlyArray<string>
}

/**
 * The task working set: a direct indexed scan, deliberately not retrieval.
 *
 * No RRF, no MMR, no embedding. A to-do list is not a ranking problem. An agent asking "what is
 * open" wants every row in a stable order, and a relevance score over working state would make the
 * answer depend on a query the caller does not have. The partial index `files_task_status`
 * (`WHERE memory_type='task' AND archived=0`) is what makes the default scan cheap.
 *
 * `blockedBy` is one correlated subquery over `edges`, filtered to `edge_class='task'` and
 * `rel='blocks'`. **The class filter is redundant with the rel filter today and is kept anyway.**
 * Probed live 2026-08-02: `0008_tasks.sql`'s per-class CHECKs refuse `blocks` under `memory`,
 * `person`, and `provenance`, so `rel='blocks'` already implies the class, and a mutation removing the
 * class predicate leaves every test green. It stays because the class column is what every
 * memory-graph query filters on, and a reader who saw this one query trust the rel alone would learn
 * the wrong rule about how the firewall is enforced.
 *
 * `group_concat` over an ordered subselect, probed 2026-08-12 on node 24.19.0: the inner `ORDER BY`
 * is preserved, and `char(10)` is the separator because a path cannot contain a newline while it can
 * contain a comma.
 *
 * The join is deliberately not an inner join onto `files`. A blocker whose file left the tree still
 * blocks, and hiding it here would make a permanently-blocked task look ready. `memhtml doctor` reports
 * that as a finding, and this function reports the edge as the corpus states it.
 */
export const listTasks = (params: ListTasksParams) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const limit = Math.min(500, Math.max(1, Math.trunc(params.limit ?? 50)))
    const conditions: Array<string> = ["f.memory_type = 'task'"]
    const values: Array<string | number> = []

    if (params.includeArchived !== true) conditions.push("f.archived = 0")
    if (params.status !== undefined && params.status !== "") {
      const status = yield* decodeTaskStatus(params.status)
      conditions.push("f.task_status = ?")
      values.push(status)
    }
    if (params.workspace !== undefined && params.workspace !== "") {
      conditions.push("f.workspace = ?")
      values.push(params.workspace)
    }
    if (params.dueBefore !== undefined && params.dueBefore !== "") {
      const dueBefore = yield* decodeDueAt(params.dueBefore)
      /**
       * `substr(…, 1, 10)` on both sides, so the comparison is one of calendar days.
       *
       * The case it fixes, established by enumeration 2026-08-02: a due date stored as a bare day
       * against a bound carrying a time on that same day. Whole-string,
       * `"2026-08-25" < "2026-08-25T09:00:00Z"` is true, because the shorter string is a prefix and
       * sorts first, so a task due sometime on the 25th would be reported late at 09:00 on the 25th.
       * A day-granularity deadline is not late until the day is over, and truncating both sides is
       * what says so. Every other combination of the two forms agrees either way.
       */
      conditions.push("f.due_at IS NOT NULL AND substr(f.due_at, 1, 10) < substr(?, 1, 10)")
      values.push(dueBefore)
    }
    if (params.cursor !== undefined && params.cursor !== "") {
      conditions.push("f.path > ?")
      values.push(normalizePath(params.cursor))
    }
    /**
     * A FILTER on the existing shape, not a new payload. Every row `task list` returns still carries
     * exactly the {@link TaskRow} fields, so `task.list` keeps its meaning and the append-only
     * discriminator rule in `envelope.ts` is untouched — nothing was added to a shipped shape and no
     * consumer's parse changes.
     *
     * A `detected: boolean` column per row was the alternative and it was declined. It would put the
     * same fact in two places (the path already says it) and it would make every caller of `task list`
     * parse a field only one flag's users read.
     */
    if (params.detected === true) {
      conditions.push("f.path GLOB ?")
      values.push(DETECTED_TASK_GLOB)
    }

    const rows = yield* db.all<{
      path: string
      title: string
      task_status: string | null
      due_at: string | null
      workspace: string | null
      archived: number
      updated_at: string
      blocked_by: string | null
    }>(
      `SELECT f.path, f.title, f.task_status, f.due_at, f.workspace, f.archived, f.updated_at,
              (SELECT group_concat(b.src_path, char(10)) FROM (
                 SELECT e.src_path AS src_path FROM edges e
                 WHERE e.dst_path = f.path AND e.edge_class = 'task' AND e.rel = 'blocks'
                 ORDER BY e.src_path ASC) b) AS blocked_by
       FROM files f
       WHERE ${conditions.join(" AND ")}
       ORDER BY f.path ASC LIMIT ?`,
      [...values, limit + 1]
    )

    const page = rows.slice(0, limit)
    const nextCursor = rows.length > limit ? (page.at(-1)?.path ?? null) : null
    return {
      tasks: page.map(
        (row): TaskRow => ({
          path: row.path,
          title: row.title,
          taskStatus: row.task_status,
          dueAt: row.due_at,
          workspace: row.workspace,
          archived: row.archived === 1,
          updatedAt: row.updated_at,
          blockedBy: row.blocked_by === null ? [] : row.blocked_by.split("\n")
        })
      ),
      nextCursor
    }
  })

/**
 * `mergeTailExtract` as the merger `persistScanned` requires.
 *
 * The two shapes differ in exactly one field, and the difference is real rather than cosmetic.
 * `SessionExtract` carries `counters`, the parse bookkeeping of one scan, and the persisted
 * `traces` row does not, because those are facts about a read rather than about the session.
 * `readStoredExtract` therefore cannot reconstruct them, and the merge is handed zeros for the
 * stored side. The merged counters then describe this scan alone, which is the only reading
 * available. Inventing a stored value would produce a number that claims to count lines nobody
 * read.
 *
 * Every other field the merge reads is present on both shapes, so this adapter is total.
 */
const ZERO_COUNTERS = {
  parsedLines: 0,
  droppedLines: 0,
  droppedNoSession: 0,
  skippedTypeLines: 0,
  unknownTypeLines: 0
} as const

const tailMerger: TailMerger = (stored, tail) =>
  mergeTailExtract(
    { ...stored, counters: ZERO_COUNTERS } as SessionExtract,
    { ...tail, counters: ZERO_COUNTERS } as SessionExtract
  )

/**
 * Scan the trace root and persist what changed.
 *
 * {@link tailMerger} is passed as the tail merger, and this is the only correct way to call
 * `persistScanned` on a `tail` action. A tail's extract describes the appended slice, so its
 * `first_prompt` is a mid-conversation prompt, its `started_at` is later than the session's, and
 * its prompt ordinals restart at 0. `persistScanned` takes the merger as a parameter precisely so
 * that "never upsert a tail extract directly" is a type-level obligation rather than a convention.
 */
export const indexTraces = () =>
  Effect.gen(function* () {
    const roots = yield* Roots
    const db = yield* DatabaseService
    const at = yield* nowSecond

    const report = yield* scanTraceRoot(roots.traceRoot, readWatermark(db))

    let sessionsWritten = 0
    let promptsWritten = 0
    let merged = 0
    for (const scanned of report.files) {
      const outcome = yield* persistScanned(db, scanned, tailMerger, at)
      /**
       * `sessionsWritten` counts files for which a `traces` ROW was written, which is exactly the
       * files `persistScanned` returns a session id for. It writes a row only for a non-skip
       * carrying an extract and a session id, so the three files it declines — a skip, a failed
       * read (a null extract), and a `file-history-*`-only file with no session to be about — are
       * each not a session written.
       *
       * The action alone cannot answer this. A failed read keeps the action the PLAN named, `tail`
       * or `rescan`, because the watermark logic needs to know what was attempted; a report that
       * read the action as the write would claim a session for a transcript that errored.
       */
      if (outcome.sessionId !== null) sessionsWritten += 1
      if (outcome.merged) merged += 1
      promptsWritten += outcome.promptsWritten
    }

    return {
      traceRoot: roots.traceRoot,
      filesSeen: report.files.length,
      skipped: report.skipped,
      tailed: report.tailed,
      rescanned: report.rescanned,
      // Files the scan planned to read and could not. `skipped + tailed + rescanned + filesFailed`
      // is `filesSeen`, so an operator can tell an unreadable transcript from an unchanged one.
      filesFailed: report.failed,
      bytesRead: report.bytesRead,
      sessionsWritten,
      promptsWritten,
      tailsMerged: merged
    }
  })

export interface TraceSearchParams {
  readonly query: string
  readonly cwd?: string | undefined
  readonly since?: string | undefined
  readonly limit?: number | undefined
}

/**
 * FTS over session first-prompts and AI titles.
 *
 * The query goes through the same sanitizer the memory arms use, and it has to. An apostrophe is a
 * hard driver error rather than an empty result, and "what did I ask about don't-repeat-yourself"
 * is an ordinary trace query. An empty sanitized query returns the most recent sessions rather
 * than nothing, because a caller with no terms wants a listing and an empty MATCH is not a listing.
 *
 * This is the trace plane and it stops here. No memory table is named, and nothing in the
 * retrieval assembler names `traces`. The firewall is by table name, in both directions.
 */
export const searchTraces = (params: TraceSearchParams) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const match = sanitizeFtsQuery(params.query)
    const limit = Math.min(200, Math.max(1, Math.trunc(params.limit ?? 20)))

    const conditions: Array<string> = []
    const values: Array<string | number> = []
    /**
     * The MATCH names `traces_fts` rather than a column of `traces`. The index is an external-content
     * FTS5 table, so it is joined in by rowid and only reached when there is something to match. Without
     * a query the statement never mentions it, which is what keeps a bare listing a plain table scan.
     */
    const matched = match !== ""
    const from = matched
      ? "FROM traces_fts JOIN traces t ON t.rowid = traces_fts.rowid"
      : "FROM traces t"
    if (matched) {
      conditions.push("traces_fts MATCH ?")
      values.push(match)
    }
    if (params.cwd !== undefined && params.cwd !== "") {
      conditions.push("t.cwd = ?")
      values.push(params.cwd)
    }
    if (params.since !== undefined && params.since !== "") {
      conditions.push("t.started_at >= ?")
      values.push(params.since)
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
    // A matched query orders by relevance, ascending because FTS5's bm25 is negative-is-better.
    // Without a match there is no relevance to order by and recency is the useful order.
    const order = matched ? "ORDER BY bm25(traces_fts)" : "ORDER BY t.started_at DESC"
    const rows = yield* db.all<{
      session_id: string
      slug: string
      cwd: string | null
      started_at: string | null
      prompt_count: number
      first_prompt: string
      ai_title: string | null
    }>(
      `SELECT t.session_id, t.slug, t.cwd, t.started_at, t.prompt_count, t.first_prompt, t.ai_title
       ${from} ${where} ${order} LIMIT ?`,
      [...values, limit]
    )

    return {
      sessions: rows.map((row) => ({
        sessionId: row.session_id,
        slug: row.slug,
        cwd: row.cwd,
        startedAt: row.started_at,
        promptCount: row.prompt_count,
        firstPrompt: row.first_prompt,
        aiTitle: row.ai_title
      })),
      degraded: match === ""
    }
  })

/**
 * Rows one `trace links` answer may carry. Every sibling read clamps (`memory_list` 500,
 * `trace_search` 200), and a long-lived session accretes links without bound, so an unclamped
 * answer grows forever. Newest first, so the truncation costs the oldest links.
 */
const TRACE_LINKS_LIMIT = 500

/**
 * The memory-session links, from either side.
 *
 * Both parameters absent is a refusal rather than an unbounded scan of every link ever recorded. A
 * tool whose no-argument form returns the whole table is a tool an agent calls by accident.
 */
export const traceLinks = (params: {
  readonly sessionId?: string | undefined
  readonly path?: string | undefined
}) =>
  Effect.gen(function* () {
    const hasSession = params.sessionId !== undefined && params.sessionId !== ""
    const hasPath = params.path !== undefined && params.path !== ""
    if (!hasSession && !hasPath) {
      return yield* Effect.fail(
        InvalidMemory.make({ reason: "trace links needs a session_id or a path" })
      )
    }

    const db = yield* DatabaseService
    const conditions: Array<string> = []
    const values: Array<string> = []
    if (hasSession) {
      conditions.push("l.session_id = ?")
      values.push(params.sessionId as string)
    }
    if (hasPath) {
      conditions.push("l.path = ?")
      values.push(normalizePath(params.path as string))
    }

    const rows = yield* db.all<{
      path: string
      session_id: string
      prompt_id: string | null
      turn_uuid: string | null
      link_kind: string
      at: string
    }>(
      `SELECT l.path, l.session_id, l.prompt_id, l.turn_uuid, l.link_kind, l.at
       FROM memory_session_links l
       WHERE ${conditions.join(" AND ")}
       ORDER BY l.at DESC, l.path ASC
       LIMIT ${TRACE_LINKS_LIMIT}`,
      values
    )

    return {
      links: rows.map((row) => ({
        path: row.path,
        sessionId: row.session_id,
        promptId: row.prompt_id,
        turnUuid: row.turn_uuid,
        linkKind: row.link_kind,
        at: row.at
      }))
    }
  })

/**
 * Corpus health, in one call.
 *
 * `indexFresh` compares the recorded watermark to `HEAD`, which is the only answer that means
 * anything. The index is a projection of a commit, so "fresh" means "the commit it describes is the
 * commit we are on". A count of rows would say the index exists rather than that it is current.
 *
 * `embedderUp` is read off the stored watermark rather than by probing Bedrock. A status call that
 * made a network request would fail for a reason unrelated to the corpus, and what a caller
 * needs to know is whether the vectors in this index are usable.
 */
export const statusReport = () =>
  Effect.gen(function* () {
    const store = yield* Store
    const db = yield* DatabaseService

    const headSha = yield* store.git.revParseHead()
    const dirty = yield* store.dirtyPaths()

    const state = yield* readIndexState(db).pipe(Effect.orElseSucceed(() => undefined))

    const byType = yield* countRows(
      db,
      "SELECT memory_type AS k, count(*) AS n FROM files WHERE archived = 0 GROUP BY memory_type"
    )
    const archivedCount = yield* countOne(db, "SELECT count(*) AS n FROM files WHERE archived = 1")
    const edges = yield* countOne(db, "SELECT count(*) AS n FROM edges")
    const derivedEdges = yield* countOne(db, "SELECT count(*) AS n FROM edges WHERE derived = 1")
    const embeddings = yield* countOne(db, "SELECT count(*) AS n FROM embeddings")
    const chunks = yield* countOne(db, "SELECT count(*) AS n FROM chunks")
    const traces = yield* countOne(db, "SELECT count(*) AS n FROM traces")

    const lastSleep = yield* db
      .get<{ run_id: string; status: string; started_at: string }>(
        "SELECT run_id, status, started_at FROM sleep_runs ORDER BY started_at DESC LIMIT 1"
      )
      .pipe(Effect.orElseSucceed(() => undefined))

    return {
      root: store.root,
      headSha,
      dirty: dirty.length > 0,
      dirtyPaths: dirty,
      countsByType: byType,
      archivedCount,
      edges,
      derivedEdges,
      chunks,
      embeddings,
      traces,
      indexFresh: state?.head_sha !== null && state?.head_sha === headSha,
      indexHeadSha: state?.head_sha ?? null,
      embedModel: state?.embed_model ?? null,
      // A stored watermark that disagrees with the configured one means every cosine in this index
      // is against a different vector space. Reporting it as "up" would be the silent half-migration
      // the indexer refuses at write time.
      embedderUp: state !== undefined && state.embed_model === EMBED_WATERMARK && embeddings > 0,
      hasState: db.hasState,
      lastSleep:
        lastSleep === undefined
          ? null
          : { runId: lastSleep.run_id, status: lastSleep.status, startedAt: lastSleep.started_at }
    }
  })

/** One scalar count, `0` when the table is unreachable. */
const countOne = (db: DatabaseShape, sql: string): Effect.Effect<number, StorageFailure> =>
  db.get<{ n: number }>(sql).pipe(Effect.map((row) => row?.n ?? 0))

/** A `GROUP BY` into a record. An absent key means zero, so the caller never reads a null. */
const countRows = (
  db: DatabaseShape,
  sql: string
): Effect.Effect<Readonly<Record<string, number>>, StorageFailure> =>
  db
    .all<{ k: string; n: number }>(sql)
    .pipe(Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.k, row.n]))))

/** Re-exported so the write path's type guard is usable by a caller building tool schemas. */
export { isWritableMemoryType }
