import { Schema } from "effect"

/**
 * The memory type vocabulary, closed. Ten values, restated by the `files.memory_type`
 * CHECK constraint in SQL.
 *
 * `arc` is in the vocabulary but absent from {@link WRITABLE_MEMORY_TYPES}: an arc is
 * synthesized by the sleep cycle from many memories, so an agent naming one directly
 * would be asserting a conclusion the corpus has not yet earned.
 *
 * `task` is ONE axis with the other nine rather than a parallel `kind` column, because
 * three overlapping type vocabularies is what made
 * the predecessor memory system's classification unanswerable. A task is a memory type whose
 * retrieval, dedup, and curation treatment a filter states, not a second axis. Tasks are
 * default-excluded from search and skipped by sleep. See `@memhtml/index`'s `assembleScope`
 * and the sleep phases' `excludeTypes`.
 */
export const MEMORY_TYPES = [
  "episodic",
  "semantic",
  "procedural",
  "agent_insight",
  "user_preference",
  "error_pattern",
  "verdict",
  "precedent",
  "arc",
  "task"
] as const

export const MemoryType = Schema.Literals(MEMORY_TYPES)
export type MemoryType = typeof MemoryType.Type

/**
 * The nine types `memory_write` exposes. `arc` is system-written only, so the tool
 * parameter enum is narrower than the storage vocabulary by exactly that one value.
 */
export const WRITABLE_MEMORY_TYPES = MEMORY_TYPES.filter(
  (type): type is Exclude<MemoryType, "arc"> => type !== "arc"
)

export const WritableMemoryType = Schema.Literals([
  "episodic",
  "semantic",
  "procedural",
  "agent_insight",
  "user_preference",
  "error_pattern",
  "verdict",
  "precedent",
  "task"
])
export type WritableMemoryType = typeof WritableMemoryType.Type

/** True for the nine types an agent may write. Narrows, so a caller can branch on it. */
export const isWritableMemoryType = (type: MemoryType): type is WritableMemoryType => type !== "arc"

/**
 * PARA's four buckets, closed and ordered. `archive` is a bucket rather than a status
 * because eviction is a `git mv`. The path itself records the state, so `git log
 * --follow` reads through it and `diff -M` reports the move as `R100`.
 */
export const PARA_BUCKETS = ["projects", "areas", "resources", "archive"] as const

export const ParaBucket = Schema.Literals(PARA_BUCKETS)
export type ParaBucket = typeof ParaBucket.Type

/** The status a memory file carries in `memhtml-status`. */
export const MemoryStatus = Schema.Literals(["active", "archived"])
export type MemoryStatus = typeof MemoryStatus.Type

/**
 * A task's own status, carried in `memhtml-task-status`, a SEPARATE axis from
 * {@link MemoryStatus}, which stays `active | archived` for every type including `task`.
 *
 * Two axes rather than four `memhtml-status` values because `active`/`archived` is what every
 * archive, correction, and publish path switches on, and a fifth value there would silently
 * change the meaning of each of them. Finishing a task stamps `done` AND archives the file
 * through the same `archiveMemory` machinery, so `done` is not a resting state on its own and
 * "what did I finish" is answered by the archive tree plus `git log`.
 */
export const TASK_STATUSES = ["todo", "doing", "blocked", "done"] as const

export const TaskStatus = Schema.Literals(TASK_STATUSES)
export type TaskStatus = typeof TaskStatus.Type

/** True when a string is in the closed task-status vocabulary. Narrows an untrusted value. */
export const isTaskStatus = (value: string): value is TaskStatus =>
  (TASK_STATUSES as ReadonlyArray<string>).includes(value)

/**
 * A finding key: the idempotency anchor of a machine-detected task, `<detector>:<digest16>`,
 * where the digest is the first 16 hex characters of a sha256 over whatever the detector
 * decided identifies the finding. A detector that runs twice over the same signal produces the
 * same key, so the second run recognizes its own earlier task instead of filing a duplicate.
 *
 * 16 characters rather than the full 64: the key is a head meta a human reads and edits in place,
 * and a full digest makes that line unreadable while adding collision margin no corpus of tasks
 * will ever need.
 *
 * Human-authored tasks carry no key at all. Absence is the signal that nothing owns the file's
 * identity but the human who wrote it.
 */
export const FINDING_KEY_PATTERN = /^[a-z0-9-]+:[0-9a-f]{16}$/

/**
 * Importance, 1-10 inclusive, 1-based ordinal on a display scale, never an arithmetic
 * input on its own. The retention scorer divides it by 10 to reach `[0, 1]` before it
 * meets any other signal.
 */
export const Importance = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))

/** Confidence, unitless in `[0, 1]`. 1.0 is an unqualified assertion. */
export const Confidence = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/**
 * A repo-root-relative path to a memory file, e.g. `areas/oncall/rollback-order.html`.
 * No leading slash: this is the git-tree form, the `files.path` primary key, and the id
 * of a memory. `<link href>` values carry the same path with a leading `/`. That is a
 * document-reference form, converted at the HTML boundary, never stored here.
 */
export const MemoryPath = Schema.String.check(Schema.isMinLength(1))

/**
 * A `type:name` entity reference, e.g. `service:checkout-api`, `person:sanju`. The
 * prefix before the first colon is the entity type; everything after is the name, which
 * may itself contain colons.
 */
export const ENTITY_SEPARATOR = ":"

/** Split an entity reference into its type and name. Absent separator ⇒ `None` type. */
export const parseEntity = (
  entity: string
): { readonly entityType: string; readonly entityName: string } | undefined => {
  const at = entity.indexOf(ENTITY_SEPARATOR)
  if (at <= 0 || at === entity.length - 1) return undefined
  return { entityType: entity.slice(0, at), entityName: entity.slice(at + 1) }
}

/** The `person:` entity prefix, which routes a semantic memory to `resources/people/`. */
export const PERSON_ENTITY_PREFIX = `person${ENTITY_SEPARATOR}`

/** True when an entity reference names a person. */
export const isPersonEntity = (entity: string): boolean =>
  entity.startsWith(PERSON_ENTITY_PREFIX) && entity.length > PERSON_ENTITY_PREFIX.length
