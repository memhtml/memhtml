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

/**
 * Lowercase, NFC-normalize, collapse internal whitespace, trim. What it means for two entity names to
 * be the SAME name.
 *
 * It lives in contracts rather than beside a caller because it is a vocabulary rule, and a second copy
 * of a vocabulary rule fails silently: `entity-resolution` decides which `memhtml-entity` metas to
 * rewrite by comparing a name against this form, so a divergent copy would have the phase canonicalize
 * files toward a spelling nothing else recognizes, reporting merges no query can reach.
 *
 * `file_entities` stores names AS AUTHORED, not in this form, and that is deliberate — the phase finds
 * its work by reading those rows back, so a projection that pre-normalized would hide every
 * unnormalized meta from the one pass whose job is to fix it. The two SQL doors fold with `lower()` on
 * both sides instead: a narrower fold (SQLite's `lower()` is ASCII-only) that cannot disagree with
 * itself across the JS/SQL seam. Full canonicalization is durable in the TREE, applied by the phase.
 */
export const normalizeEntityName = (name: string): string =>
  name.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * A whole reference in that form: both halves normalized, rejoined, padding around the separator gone.
 *
 * For callers comparing references in TypeScript — the write path deciding whether a candidate entity
 * is one the corpus already names. The SQL doors do NOT use this; see the seam note above.
 *
 * Total over unparseable input. A string with no separator normalizes as a whole and is returned
 * without one, so the caller still decides what an untyped reference means rather than receiving a
 * silently invented type.
 */
export const normalizeEntityRef = (entity: string): string => {
  const parsed = parseEntity(entity.trim())
  return parsed === undefined
    ? normalizeEntityName(entity)
    : `${normalizeEntityName(parsed.entityType)}${ENTITY_SEPARATOR}${normalizeEntityName(parsed.entityName)}`
}

/** The `person:` entity prefix, which routes a semantic memory to `resources/people/`. */
export const PERSON_ENTITY_PREFIX = `person${ENTITY_SEPARATOR}`

/**
 * True when an entity reference names a person: the `person:` prefix plus a name that survives
 * `trim()`.
 *
 * The trim is what makes this predicate agree with the rest of the person plane. `placementFor`
 * routes on it, and the sleep phase that mints the person file and its `memhtml-about-person`
 * links keys on `entity_name.trim() !== ""`. A whitespace-only name accepted here would land a
 * memory in `resources/people/` that no phase will ever give a person file to link at — and
 * `slugify` maps that name to `untitled`, which names nobody.
 */
export const isPersonEntity = (entity: string): boolean =>
  entity.startsWith(PERSON_ENTITY_PREFIX) && entity.slice(PERSON_ENTITY_PREFIX.length).trim() !== ""
