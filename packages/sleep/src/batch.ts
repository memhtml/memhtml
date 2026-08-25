import type { LlmContractViolation, ModelUnavailable } from "@memhtml/contracts/errors"
import { type ModelClientShape, type StructuredRequest, wrapAsData } from "@memhtml/llm"
import { Effect, Result } from "effect"

/**
 * The batched-resolution kernel: cluster, batch, one structured-list call per batch, then a
 * deterministic assertion over the answer.
 *
 * Five phases run this shape. `compress` folds a community into one canonical, `entity-resolution`
 * clusters alias candidates, `dedup-merge` partitions a connected component into merge groups, and
 * `edge-typing` types a batch of candidate pairs; a task-detection phase follows. Each one groups
 * corpus rows, hands one group (or a pack of small ones) to a model as a numbered member list, and
 * then decides what to write with code rather than with the model's prose. The parts that were the
 * same in every copy live here. The grouping rule, the schema, and the assertion over the answer stay
 * in the phase, because those are the parts that differ.
 *
 * **The kernel does not sort. The caller sorts, and the kernel preserves that order.** Every function
 * here is order-preserving, so batch boundaries and member keys are a function of the order the phase
 * handed over. A phase that reads rows in a fixed order therefore produces the same batches, the same
 * keys, and the same prompt bytes on a second run over an unchanged corpus. Sorting inside the kernel
 * would take that guarantee away from the phase that has to state it, because only the phase knows
 * which column is its stable key: `row.path` for compress, the normalized name for entity-resolution.
 *
 * **Members are offered under opaque keys, never under paths.** A model shown `m3` can answer only
 * `m3`, and an answer naming something the batch did not contain resolves to nothing and is dropped
 * by {@link resolveKeys}. When the answer to "which of these do you absorb" could be a path, the
 * answer is a write target the model chose.
 *
 * **Caps are per-phase, not shared.** `maxMembers` is how many members fit one answer's attention for
 * that phase's question, so each phase states its own constant next to the code that reads it. A
 * kernel-level constant would make one phase's cost tuning move another phase's batch boundaries.
 *
 * **The stable prefix goes in `system`, the variable member list in `prompt`.** {@link batchCall} sets
 * `cacheSystem`, so a phase's system prompt and tool schema form a cache-eligible prefix across every
 * batch of the night and only the member list is new bytes per call.
 */

/** One member as the model sees it: an opaque key and the text offered under it. */
export interface KeyedMember {
  readonly key: string
  readonly text: string
}

/** What {@link keyMembers} produces: the model's view, and the way back to the caller's rows. */
export interface KeyedBatch<T> {
  readonly keyed: ReadonlyArray<KeyedMember>
  /**
   * Key to the item it was minted for. A `get` on a key the model invented returns `undefined`,
   * which is how a hallucinated member becomes a drop instead of a write.
   */
  readonly itemForKey: ReadonlyMap<string, T>
}

/**
 * Mint `m1`..`mN` over `items` in the order given, and index each key back to its item.
 *
 * The keys carry no information beyond position, which is the point. A key that encoded a path or a
 * title would let a model answer with a target it inferred rather than one it was offered, and this
 * corpus stores instructions, so a member's own text can read as a directive about naming.
 *
 * `charBudget` slices each text after `textOf` builds it. The budget is per member and is applied
 * here so every phase slices at the same boundary, where the text stops being a row and becomes a
 * prompt.
 */
export const keyMembers = <T>(
  items: ReadonlyArray<T>,
  textOf: (item: T) => string,
  options?: { readonly charBudget?: number | undefined }
): KeyedBatch<T> => {
  const budget = options?.charBudget
  const keyed: Array<KeyedMember> = []
  const itemForKey = new Map<string, T>()
  for (const [offset, item] of items.entries()) {
    const key = `m${offset + 1}`
    const text = textOf(item)
    keyed.push({ key, text: budget === undefined ? text : text.slice(0, budget) })
    itemForKey.set(key, item)
  }
  return { keyed, itemForKey }
}

/**
 * The offered key a model's answer denotes, or `undefined` when it denotes none.
 *
 * A model shown `<member_m3>` answers `member_m3` at least as readily as `m3`: the wrapper tag is
 * the only place most batch prompts DISPLAY a key, so the label-prefixed form is the one the prompt
 * itself teaches (measured live 2026-08-23: `gpt-5.6-sol` answers the prefixed form on every call,
 * Claude Sonnet 5 on most). So a key that does not match directly is retried once with everything
 * up to its last `_` stripped, and only a suffix the batch actually offered resolves — `member_m9`
 * in a batch of three still denotes nothing, and a path or an invented name still drops. The
 * canonical form is returned so two spellings of one member collapse to one key everywhere a phase
 * keeps per-key state.
 */
export const offeredKeyFor = <T>(batch: KeyedBatch<T>, key: string): string | undefined => {
  if (batch.itemForKey.has(key)) return key
  const at = key.lastIndexOf("_")
  if (at === -1) return undefined
  const suffix = key.slice(at + 1)
  return batch.itemForKey.has(suffix) ? suffix : undefined
}

/**
 * Resolve the keys a model named back to items: unknown keys are dropped, repeats collapse.
 *
 * A key the batch never offered is a member the model invented, and every phase on this kernel turns
 * a named member into a write, so an unresolvable key must not reach that write. Dropping it leaves
 * the corresponding file untouched, which is the safe outcome for every one of the five phases.
 * Resolution goes through {@link offeredKeyFor}, so the label-prefixed spelling of an offered key
 * (`member_m3` for `m3`) resolves rather than reading as an invention.
 *
 * The result keeps the order the model named the keys in, and a key named twice appears once.
 * De-duplication is on the CANONICAL key rather than on the spelling or the resolved item, so `m1`
 * and `member_m1` in one answer count as one member, and the count a phase gates on ("at least two
 * members absorbed") counts distinct offered members.
 */
export const resolveKeys = <T>(batch: KeyedBatch<T>, keys: ReadonlyArray<string>): Array<T> =>
  [
    ...new Set(
      keys.flatMap((key) => {
        const canonical = offeredKeyFor(batch, key)
        return canonical === undefined ? [] : [canonical]
      })
    )
  ].flatMap((key) => {
    const item = batch.itemForKey.get(key)
    return item === undefined ? [] : [item]
  })

/**
 * Slice each pre-sorted group into batches of at most `maxMembers`, dropping any batch that falls
 * below `minMembers`.
 *
 * The groups arrive in the order the caller wants them called in, and each group's members arrive in
 * the caller's own stable order. This walks both in that order, so the boundaries are reproducible.
 *
 * `minMembers` defaults to 1, which keeps every slice. A phase whose question is meaningless for a
 * lone member raises it: compress passes 2, because folding one memory into a "canonical" rewrites it
 * under a new path and archives the original for no gain.
 */
export const assembleBatches = <T>(
  groups: ReadonlyArray<ReadonlyArray<T>>,
  options: { readonly maxMembers: number; readonly minMembers?: number | undefined }
): Array<Array<T>> => {
  const floor = options.minMembers ?? 1
  const batches: Array<Array<T>> = []
  for (const group of groups) {
    for (let at = 0; at < group.length; at += options.maxMembers) {
      const slice = group.slice(at, at + options.maxMembers)
      if (slice.length >= floor) batches.push(slice)
    }
  }
  return batches
}

/** One packed call: the groups that share it, each one still a group. */
export type GroupBatch<T> = ReadonlyArray<ReadonlyArray<T>>

/**
 * Pack whole groups into shared batches, bounded by a member count and a character budget together.
 *
 * For a phase whose groups are mostly tiny. `dedup-merge` works over connected components of the
 * near-duplicate graph, where a typical component is a pair, so one call per component would spend a
 * model call on two memories. Ten or twenty components in one call cost one.
 *
 * Group boundaries survive into the result, because they are evidence. Two members in different
 * components are known NOT to be near-duplicates, and a prompt that flattened the pack into one list
 * would ask the model to rediscover that.
 *
 * A group longer than `maxMembers` is sliced on the same stride {@link assembleBatches} uses, so no
 * returned batch breaches either cap. Packing is greedy in the order given and closes a batch when the
 * next unit would breach a cap, which makes the packing a function of the input order. Filtering out
 * groups the phase does not want called (a singleton component, for dedup) is the caller's step,
 * because a floor applied after packing would measure the pack instead of the group.
 */
export const packGroups = <T>(
  groups: ReadonlyArray<ReadonlyArray<T>>,
  options: {
    readonly maxMembers: number
    readonly maxChars: number
    readonly charsOf: (item: T) => number
  }
): Array<GroupBatch<T>> => {
  const batches: Array<Array<ReadonlyArray<T>>> = []
  let current: Array<ReadonlyArray<T>> = []
  let members = 0
  let chars = 0
  const close = () => {
    if (current.length > 0) batches.push(current)
    current = []
    members = 0
    chars = 0
  }
  for (const group of groups) {
    if (group.length === 0) continue
    const units =
      group.length > options.maxMembers
        ? assembleBatches([group], { maxMembers: options.maxMembers })
        : [group]
    for (const unit of units) {
      const cost = unit.reduce((total, item) => total + options.charsOf(item), 0)
      const breaches = members + unit.length > options.maxMembers || chars + cost > options.maxChars
      if (current.length > 0 && breaches) close()
      current.push(unit)
      members += unit.length
      chars += cost
    }
  }
  close()
  return batches
}

/**
 * The numbered member list as one prompt block: each member wrapped as data under `<label>_<key>`,
 * blocks separated by a blank line.
 *
 * Every member goes through `wrapAsData`, which is the prompt-injection boundary. This corpus stores
 * instructions, so a procedural memory about a deploy step reads exactly like a directive to the
 * model, and un-delimited member text in a user turn would be an injection surface the system built
 * for itself.
 *
 * The boundary covers the whole family, not only each member's own tag: the keys are `m1`..`mN` and
 * therefore predictable, so `wrapAsData` neutralizes every `</<label>_m<n>>` in a member's text. Left
 * to one label, member 1 could close member 2's block and reopen it around a fabricated body, and the
 * answer is keyed BY MEMBER — the verdicts on this surface drive merge and evict writes.
 */
export const memberList = (
  keyed: ReadonlyArray<KeyedMember>,
  options?: { readonly label?: string | undefined }
): string => {
  const label = options?.label ?? "member"
  return keyed.map((member) => wrapAsData(`${label}_${member.key}`, member.text)).join("\n\n")
}

/**
 * A batch's user turn: the member list first, the instruction that closes it last.
 *
 * The phase's own instruction sentence is the tail rather than the head, matching the order every
 * copy of this pattern already used. The stable half of a batch prompt is `system` and the tool
 * schema, which {@link batchCall} marks cacheable; the user turn is new bytes on every call whatever
 * order its parts sit in.
 */
export const batchPrompt = (
  keyed: ReadonlyArray<KeyedMember>,
  instruction: string,
  options?: { readonly label?: string | undefined }
): string => `${memberList(keyed, options)}\n\n${instruction}`

/** Everything a model call can fail with. Both are per-item; neither is per-phase. */
export type LlmFailure = ModelUnavailable | LlmContractViolation

/**
 * Run one model call in isolation: a failure becomes `undefined` and a counted skip.
 *
 * This is the per-item posture the packet's §4 requires, expressed with `Effect.result` because
 * `Effect.either` does not exist in this beta. One violation skips its item and leaves the phase
 * running. A night that judged 199 pairs and lost the 200th to a malformed tool payload has done 199
 * pairs of work, and failing the phase would throw all of it away.
 */
export const isolate = <A>(
  label: string,
  call: Effect.Effect<A, LlmFailure>
): Effect.Effect<A | undefined> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(call)
    if (Result.isSuccess(outcome)) return outcome.success
    yield* Effect.logWarning(`sleep.llm ${label} skipped: ${outcome.failure.reason}`)
    return undefined
  })

/**
 * Run one batch's model call: prompt-cache the stable prefix, and isolate the failure.
 *
 * `cacheSystem` is set here instead of at each call site, because every phase on this kernel has the
 * same shape: one system prompt and one tool schema repeated across every batch of the night, with
 * only the member list changing. A phase that forgot the flag would re-bill its whole prefix on every
 * batch, and the omission would be invisible in the phase's output.
 */
export const batchCall = <A, I>(
  model: ModelClientShape,
  label: string,
  request: Omit<StructuredRequest<A, I>, "cacheSystem">
): Effect.Effect<A | undefined> =>
  isolate(label, model.generateObject({ ...request, cacheSystem: true }))
