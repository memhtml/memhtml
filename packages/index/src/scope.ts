import { MEMORY_TYPES, type MemoryType } from "@memhtml/contracts/types"

import type { ArmHoles } from "./retrieval-sql.js"
import { PARAM_QUERY_VECTOR } from "./retrieval-sql.js"

/**
 * Search scoping, assembled into the `{fileFilter}` hole every arm carries.
 *
 * The filter is built ONCE and every arm receives the same string, differing only in the alias its
 * `files` row goes by. Per-arm filters would let a scope apply to three arms and not the fourth,
 * which surfaces as a scoped query returning a result from outside the scope. No type catches that
 * leak.
 *
 * **One deliberate exception, and it is not a scope.** The salience arm carries two exclusions of its
 * own, `SALIENCE_EXCLUDED_TYPE` and `SALIENCE_EXCLUDED_PREFIX` at `retrieval-sql.ts:141`, because a
 * task and a person-reference record are ranked by predicate and by key rather than by relevance. That
 * is an ARM's rule about which rows it has an opinion on, not a caller's statement about which rows the
 * query is over, and an excluded row still earns its FTS, vector, and recency ranks. A scope narrows
 * the candidate set and therefore stays here, reaching every arm. Anything that would narrow one arm's
 * candidate set and not the others' belongs in that arm and must never enter this filter.
 *
 * On parameter positions, the fixed prefix `?1`-`?4` belongs to the RRF assembler, so scope values
 * bind from `?5` upward. That numbering holds whether or not the vector arm fired, because the
 * caller always binds a four-value prefix with `null` at `?4` when there is no query vector. An
 * unbound numbered parameter reads as `NULL` on this driver rather than failing (probed
 * 2026-08-02), so a shifted number would silently match nothing instead of erroring.
 */

/** The caller's scope. Every field absent means "the whole wiki, minus the tasks". */
export interface SearchScope {
  /**
   * ANY-of. Absent or empty means every type EXCEPT `task`, and naming `task` opts a query in.
   *
   * The asymmetry is deliberate and it is the one place `task` is treated apart from other types. A
   * task is intermediate working state rather than a remembered fact. A corpus with fifty open to-do
   * items would put fifty of them in front of every recall, crowding out the knowledge an agent asked
   * for with a list it can read by `ls`-ing a directory. Tasks are CRUDL-able without retrieval by
   * design, so retrieval is where they stay out of the way.
   */
  readonly memoryTypes?: ReadonlyArray<MemoryType> | undefined
  /**
   * STRICT equality. A workspace-scoped query never sees a NULL-workspace page. A memory with no
   * workspace is unplaced rather than "in every workspace", and returning it would make a
   * project-scoped recall quietly global.
   */
  readonly workspace?: string | undefined
  /** ANY-of overlap. Each tag BROADENS the result set. */
  readonly tags?: ReadonlyArray<string> | undefined
  /**
   * STRICT equality on ONE entity reference, in `type:name` form, so `person:sanju` and not `sanju`.
   *
   * The same spelling `memory_list` takes, and the same predicate, because the two are one vocabulary.
   * A caller that learned `person:sanju` from a listing must be able to hand that exact string to a
   * search. `file_entities` is keyed on `(type, name)`, so the bare name is ambiguous. `person:sanju`
   * and `concept:sanju` are two entities, and accepting the bare name here would make a scope that
   * narrows to whichever of them the corpus happens to hold.
   *
   * Singular, unlike `tags`, and that asymmetry is deliberate. This scope exists so a caller can chain
   * a hop off a hit's own `entities` list, which is one reference at a time. A list would raise the
   * question of whether it broadens or narrows before anyone has asked for either.
   */
  readonly entity?: string | undefined
  /** Archived files are excluded unless asked for. Eviction is a `git mv`, so they still exist. */
  readonly includeArchived?: boolean | undefined
  /**
   * Point-in-time view. Takes an ISO instant, and the candidate set becomes "what was believed valid
   * at this moment", with archived files INCLUDED, filtered by the validity window
   * `coalesce(valid_from, event_at, created_at) <= asOf AND (valid_until IS NULL OR valid_until > asOf)`.
   *
   * The coalesce order is the stamping rule's own (`@memhtml/store`'s `validFromOf`). An explicit
   * valid-from beats the event time, which beats the write time. All three columns compare
   * lexicographically as strings by design (0008_tasks.sql), so the predicate is string comparison,
   * never a per-row parse. Applied HERE, at the one filter every arm receives, so the temporal lens
   * cannot hold for three arms and leak in the fourth. When absent the assembled filter is
   * byte-identical to today's, and a pin test enforces that.
   */
  readonly asOf?: string | undefined
}

/**
 * The one type an unscoped query does not see.
 *
 * Named as a constant so the SQL predicate, the `dedupeLookup` exclusion in `traces-persist.ts`,
 * and the tests all read one value. Three copies of the string `'task'` would let the retrieval
 * default and the dedup carve-out drift apart, and each would look correct alone.
 */
export const EXCLUDED_BY_DEFAULT = "task"

/** An assembled filter, holding the SQL fragment and the values that bind to its placeholders. */
export interface AssembledScope {
  readonly holes: ArmHoles
  /** Values for `?5` onward, in placeholder order. */
  readonly params: ReadonlyArray<string | number>
}

/**
 * Assemble a scope into the arm hole plus its bound values.
 *
 * The `{alias}` token stands in for whichever alias the arm gives its `files` row; each arm
 * substitutes it. Emitting a fixed alias here would make the fragment usable by one arm only.
 *
 * An empty scope produces `AND {alias}.archived = 0` plus the default task exclusion. Every arm
 * receives both, so a task cannot enter one arm's candidate set and be missing from another's.
 */
export const assembleScope = (scope: SearchScope = {}): AssembledScope => {
  const conditions: Array<string> = []
  const params: Array<string | number> = []
  let next = PARAM_QUERY_VECTOR + 1

  const placeholder = (value: string | number): string => {
    params.push(value)
    return `?${next++}`
  }

  if (scope.asOf !== undefined && scope.asOf !== "") {
    /**
     * The as-of lens REPLACES the archived filter rather than composing with it. A superseded
     * memory that was valid at the asked moment is archived NOW, and excluding it would make the
     * point-in-time view show only the survivors of every later decision, which is the present
     * rather than the past. Both bounds bind as parameters like every other caller value, and the
     * same placeholder binds twice because the window has two ends and one instant.
     */
    conditions.push(
      `coalesce({alias}.valid_from, {alias}.event_at, {alias}.created_at) <= ${placeholder(scope.asOf)}`
    )
    conditions.push(
      `({alias}.valid_until IS NULL OR {alias}.valid_until > ${placeholder(scope.asOf)})`
    )
  } else if (scope.includeArchived !== true) conditions.push("{alias}.archived = 0")

  const types = (scope.memoryTypes ?? []).filter((type) =>
    (MEMORY_TYPES as ReadonlyArray<string>).includes(type)
  )
  if (types.length > 0) {
    /**
     * A caller-named type list is honored VERBATIM, `task` included. Filtering `task` back out of
     * an explicit list would make the opt-in unreachable, and there would then be no way to search
     * tasks at all. The exclusion is a default and not a firewall. (The firewalls in this system are
     * `edge_class` and the trace tables, and both reject a write rather than defaulting.)
     */
    conditions.push(`{alias}.memory_type IN (${types.map((type) => placeholder(type)).join(", ")})`)
  } else {
    /**
     * Inlined rather than bound, unlike every other value here. It is this function's own default
     * rather than caller input, and binding it would consume a placeholder number and shift every
     * scope parameter below it. The `?5`-upward numbering is a contract with the RRF assembler.
     */
    conditions.push(`{alias}.memory_type <> '${EXCLUDED_BY_DEFAULT}'`)
  }

  if (scope.workspace !== undefined && scope.workspace !== "") {
    conditions.push(`{alias}.workspace = ${placeholder(scope.workspace)}`)
  }

  const tags = (scope.tags ?? []).filter((tag) => tag.trim() !== "")
  if (tags.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM file_tags ft WHERE ft.path = {alias}.path AND ft.tag IN (${tags
        .map((tag) => placeholder(tag))
        .join(", ")}))`
    )
  }

  /**
   * The entity scope, as the same EXISTS `listMemories` issues (`apps/cli/src/operations.ts:979`).
   *
   * The reference arrives as `type:name` and the comparison REBUILDS it from the two columns rather
   * than making the caller know where the split falls. The concatenation is parenthesized. `||` does
   * outrank `=` on this driver, so the parentheses change no parse. They are there because a
   * mis-scoped variant returns plausible rows on any fixture small enough to write down, which makes
   * the assembled TEXT the only place the grouping can be asserted at all.
   *
   * `EXISTS` rather than a `JOIN`, matching the tag predicate. A file carrying an entity twice under
   * two types would multiply its rows through a join, and a duplicated row inside an arm's `LIMIT`
   * spends the candidate budget on one file. That is the same defect the vector arm's
   * `GROUP BY c.path` exists to prevent.
   */
  if (scope.entity !== undefined && scope.entity !== "") {
    conditions.push(
      `EXISTS (SELECT 1 FROM file_entities e WHERE e.path = {alias}.path AND (e.entity_type || ':' || e.entity_name) = ${placeholder(scope.entity)})`
    )
  }

  const fileFilter = conditions.map((condition) => `\n         AND ${condition}`).join("")
  return { holes: { fileFilter }, params }
}
