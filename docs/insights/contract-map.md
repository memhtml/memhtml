# memhtml-public · Contract map

A contract here is any declaration in one file that a file in another package or app depends on. Four kinds appear below.

1. A TypeScript type or an `effect` `Schema` declared in one package and imported by another.
2. A closed string vocabulary that several modules must agree on, including where SQL restates it as a CHECK constraint.
3. A service interface, declared as a `Context.Service` shape, whose implementation is bound at a composition root.
4. A serialized artifact one module writes and another reads: a JSON envelope on stdout, a git tree, a committed sidecar.

Most of this repo's shared types are `effect` `Schema` declarations with a derived type (`export type X = typeof X.Type`), so every Shape block below quotes the `Schema` declaration verbatim rather than an interface.

Two facts apply to the whole map. First, this repository stores no memory. It is the software that manages a separate directory called the memhtml root, located by `$MEMHTML_ROOT` and defaulting to `~/memhtml` (`apps/cli/src/config.ts:26-31`). Second, memhtml manages that root with git. The root's git tree is the system of record, and `.memhtml/index.db` inside the root is a projection that is deleted and rebuilt without loss (`packages/index/src/index.ts:1-7`). When a contract below says "the root" it means that external directory, never this repository.

The primary consumer of every boundary here is a coding agent. The CLI answers in JSON envelopes with stable codes rather than prose, the MCP server publishes the same vocabularies as tool parameter enums, and the agent-facing documentation is generated from the command table. The notes below judge each surface by what an agent can parse and act on.

Contracts are ordered by how many files across package boundaries depend on them.

## The typed error vocabulary

Eight error classes in the shared contracts package define how every other package reports failure. `@memhtml/contracts/errors` is imported by 32 non-test files across 8 packages and 2 apps, which makes it the most widely imported contract in the repo.

**Producer:** `packages/contracts/src/errors.ts:9-64`

**Consumer(s):**

- `packages/store/src/store.ts:5-11` imports `DirtyTree`, `InvalidMemory`, `PathNotFound`, `StorageFailure`, `WriteConflict` and unions them into `StoreError` (`packages/store/src/store.ts:190-196`).
- `packages/index/src/database.ts:6` imports `StorageFailure` as the sole error type of every method on `DatabaseShape` (`packages/index/src/database.ts:69-101`).
- `packages/index/src/git-port.ts:1` imports `StorageFailure` as the port's one failure type (`packages/index/src/git-port.ts:44-69`).
- `packages/index/src/retrieval.ts:1` imports `ModelUnavailable` and `StorageFailure`.
- `packages/index/src/indexer.ts:1-5` imports `InvalidMemory`, `ModelUnavailable`, `StorageFailure`.
- `packages/html/src/parse.ts:2` imports `InvalidMemory` as `parseMemory`'s failure type (`packages/html/src/parse.ts:322`).
- `packages/llm/src/client.ts:2` and `packages/llm/src/embeddings.ts:2` import `ModelUnavailable`; `packages/llm/src/model-client.ts:2` imports both `LlmContractViolation` and `ModelUnavailable`; `packages/llm/src/structured.ts:1` imports `LlmContractViolation`.
- `apps/cli/src/errors.ts:41-67` switches on the `_tag` of every class to produce an `ErrorCode`.
- `apps/mcp/src/failure.ts:78-123` switches on the same tags to produce agent-executable suggestions.

**Shape:**

```typescript
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}

export class WriteConflict extends Schema.TaggedError<WriteConflict>()("WriteConflict", {
  path: Schema.String,
  ourSha: Schema.String,
  theirSha: Schema.String
}) {}

export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  modelId: Schema.String,
  reason: Schema.String
}) {}

export class InvalidMemory extends Schema.TaggedError<InvalidMemory>()("InvalidMemory", {
  reason: Schema.String
}) {}

export class PathNotFound extends Schema.TaggedError<PathNotFound>()("PathNotFound", {
  path: Schema.String
}) {}

export class DuplicateContent extends Schema.TaggedError<DuplicateContent>()("DuplicateContent", {
  contentHash: Schema.String,
  existingPath: Schema.String
}) {}

export class DirtyTree extends Schema.TaggedError<DirtyTree>()("DirtyTree", {
  paths: Schema.Array(Schema.String)
}) {}

export class LlmContractViolation extends Schema.TaggedError<LlmContractViolation>()(
  "LlmContractViolation",
  {
    reason: Schema.String
  }
) {}
```

**Assumptions consumers make:**

- Consumers assume the payload carries no driver text, no SQL, and no memory body, so the whole payload is safe to return to an agent. `packages/contracts/src/errors.ts:3-8` states that the driver's own message goes to `Effect.logError` at the adapter edge instead, and `apps/cli/src/errors.ts:69-77` relies on that by naming only actionable fields in its human message.
- Two consumers assume the tag set is open, not closed, and each handles an unknown tag rather than failing. `apps/cli/src/errors.ts:64-65` returns `ERR_UNKNOWN` from a `default` arm, and `apps/mcp/src/failure.ts:120-121` returns an empty suggestion array.
- `apps/cli/src/errors.ts:78-106` assumes every payload field it reads may be absent or the wrong type at runtime, and guards each with `text(...) ?? "<fallback>"` because the value arrives as `unknown` through the `TaggedError` interface at `apps/cli/src/errors.ts:16-19`.
- `apps/cli/src/errors.ts:33-39` assumes two error classes that are NOT in this file arrive with the same `_tag` shape: `GitFailure` from `@memhtml/store`, and `EmbedModelMismatch`, which predates the contracts package. Both are handled in the same switch.
- `apps/mcp/src/failure.ts:56-63` assumes the CLI's suggestions are unusable inside an MCP call, because they name shell commands an agent holding only tools cannot run, and maintains a deliberately parallel mapping.

**Drift risk:** Adding a ninth error class silently degrades it to `ERR_UNKNOWN` at the CLI edge and to zero suggestions at the MCP edge, so an agent receives a documented but uninformative code rather than a crash. Mitigation: when adding a class, add its arm to `codeFor`, `messageFor`, and `mcpSuggestionsFor` in the same change, and add its code to `ERROR_CODES` at `apps/cli/src/envelope.ts:67-83`.

## The edge vocabulary and its derived class

This module declares four edge classes that do not mix, four rel vocabularies, and one total function from a rel to its class. It has 14 import sites across 13 non-test files in 5 packages and 2 apps, and the SQL restates the same vocabularies as CHECK constraints.

**Producer:** `packages/contracts/src/edges.ts:9-149`

**Consumer(s):**

- `packages/store/src/store.ts:4` imports `EdgeRel` and `relClassFor`; the store calls `relClassFor` at `packages/store/src/store.ts:999` to decide which endpoint rule to enforce.
- `packages/index/src/project.ts:1` imports `relClassFor` and writes its result into the `edge_class` column at `packages/index/src/project.ts:359-363`.
- `packages/html/src/serialize.ts:1` imports `relTokenFor` to emit the `<link rel>` wire token.
- `packages/html/src/parse.ts:1` imports `relForToken`; `packages/html/src/parse.ts:229-230` drops a link whose token is outside the vocabulary.
- `packages/html/src/constraints.ts:1` imports `relForToken`; `packages/html/src/constraints.ts:259-261` reports the same token as a violation.
- `packages/html/src/document.ts:1` imports `EdgeRel` as the type of `MemoryLink.rel`.
- `packages/html/src/template.ts:1` and `packages/html/src/editors.ts:1-2` import `EdgeRel` and `relTokenFor`.
- `packages/sleep/src/edits.ts:1` and `packages/sleep/src/phases/integrity.ts:1` import `EdgeRel` and `isEdgeRel`.
- `apps/cli/src/operations.ts:1` imports `isEdgeRel`, `MEMORY_RELS`, `relClassFor`, `TASK_RELS`; `apps/cli/src/operations.ts:1100` filters to memory-class rels.
- `apps/cli/src/commands.ts:1` and `apps/mcp/src/tools.ts:9` import `MEMORY_RELS` to build the authorable-rel enum; `apps/mcp/src/tools.ts:48` turns it into `Schema.Literals(MEMORY_RELS)`.
- `packages/index/migrations/0008_tasks.sql:194-199` restates all four rel vocabularies as per-class CHECK constraints.

**Shape:**

```typescript
export const EDGE_CLASSES = ["memory", "person", "provenance", "task"] as const

export const MEMORY_RELS = [
  "supersedes",
  "contradicts",
  "caused_by",
  "leads_to",
  "part_of",
  "relates_to",
  "example_of",
  "supports",
  "laterally_related"
] as const

export const PERSON_RELS = ["about_person", "authored_by"] as const
export const PROVENANCE_RELS = ["from_session"] as const
export const TASK_RELS = ["blocks", "subtask_of"] as const

export const ALL_RELS = [...MEMORY_RELS, ...PERSON_RELS, ...PROVENANCE_RELS, ...TASK_RELS] as const

export const EdgeRel = Schema.Literals(ALL_RELS)
export type EdgeRel = typeof EdgeRel.Type

export const relClassFor = (rel: EdgeRel): EdgeClass => {
  if ((MEMORY_RELS as ReadonlyArray<string>).includes(rel)) return "memory"
  if ((PERSON_RELS as ReadonlyArray<string>).includes(rel)) return "person"
  if ((TASK_RELS as ReadonlyArray<string>).includes(rel)) return "task"
  return "provenance"
}

export const Edge = Schema.Struct({
  srcPath: Schema.String,
  rel: EdgeRel,
  dstPath: Schema.String,
  edgeClass: EdgeClass,
  derived: Schema.Boolean,
  strength: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  provenance: EdgeProvenance
})
```

**Assumptions consumers make:**

- The indexer assumes `relClassFor` is total, so it writes the result straight into a NOT NULL column with no fallback (`packages/index/src/project.ts:359-363`). Totality comes from `relClassFor`'s final `return "provenance"` rather than from a check.
- The two HTML consumers handle an unknown rel token differently, on purpose. The parser drops it so the file still parses (`packages/html/src/parse.ts:229-230`), while the constraint checker reports it (`packages/html/src/constraints.ts:259-261`).
- The store assumes it is the only module that can see both endpoints' memory types, so it checks the endpoint rule that SQL cannot check. `packages/store/src/store.ts:993-1020` rejects a memory-class rel touching a task file, and rejects a task-class rel touching a non-task. `packages/store/src/store.ts:258-263` states that the `edges` CHECK cannot read the endpoints' types at all.
- Every memory-graph query assumes `edge_class = 'memory'` is enough to keep a person or task edge out of PageRank, MMR, and the retention bridge count (`packages/contracts/src/edges.ts:4-8`, restated at `packages/index/migrations/0008_tasks.sql:177-181`).
- `packages/index/src/project.ts:343-344` assumes a self-loop must be dropped at projection time rather than sent to the driver, because the table's `CHECK (src_path <> dst_path)` at `packages/index/migrations/0008_tasks.sql:193` would reject the whole write batch over one hand-authored file.
- `relTokenFor` and `relForToken` assume the underscore-to-hyphen mapping is injective on the vocabulary (`packages/contracts/src/edges.ts:109-120`). No rel in `ALL_RELS` contains a hyphen, so the inverse is unambiguous.

**Drift risk:** Adding a rel to a class in TypeScript without widening the matching SQL CHECK makes every write carrying that rel fail at the driver. Because `writeAll` is one transaction (`packages/index/src/database.ts:82-83`), one new rel fails the whole batch. Mitigation: add the rel and its migration in the same change, following the recreate-and-copy pattern at `packages/index/migrations/0008_tasks.sql:173-209`.

## The path algebra

This module provides placement, archival, and normalization as pure total functions over repo-root-relative paths. It has 13 non-test importers across 5 packages and 1 app, and it is the only module that decides where a memory lands in the root.

**Producer:** `packages/contracts/src/paths.ts:10-240`

**Consumer(s):**

- `packages/store/src/store.ts:12-18` imports `archivePathFor`, `isValidMemoryPath`, `memoryPathFor`, `normalizePath`, and `PlacementInput`.
- `packages/store/src/layout.ts:5` imports `ARCS_DIR`, `INBOX_DIR`, `PEOPLE_DIR` and puts all three in `SCAFFOLD_DIRS` (`packages/store/src/layout.ts:41-48`).
- `packages/index/src/indexer.ts:6` imports `MEMORY_EXTENSION` and `normalizePath`.
- `packages/index/src/project.ts:2` imports `normalizePath` and `paraBucketOf`; `packages/index/src/project.ts:354` normalizes a link's `href` before storing it as `dst_path`.
- `packages/sleep/src/edits.ts:3` and `packages/sleep/src/phases/integrity.ts:2` import `archivePathFor` and `normalizePath`.
- `packages/sleep/src/phases/trace-consolidation.ts:3` imports `placementFor`.
- `packages/sleep/src/phases/compress.ts:1` imports `INBOX_DIR`, `packages/sleep/src/phases/person-links.ts:1` imports `PEOPLE_DIR`, and `packages/sleep/src/phases/arc-synthesis.ts:1` imports `ARCS_DIR`.
- `packages/sleep/src/review.ts:1` imports `isArchivePath`.
- `packages/eval/src/corpus.ts:1` imports `PEOPLE_DIR`.
- `apps/cli/src/doctor.ts:5` imports `INBOX_DIR`, `normalizePath`, `TASKS_SUBDIR`.
- `apps/cli/src/operations.ts:3` imports `normalizePath`.

**Shape:**

```typescript
export interface PlacementInput {
  readonly path?: string | undefined
  readonly memoryType: string
  readonly entities?: ReadonlyArray<string> | undefined
  readonly workspace?: string | undefined
  readonly tags?: ReadonlyArray<string> | undefined
}

export const placementFor = (input: PlacementInput): string => {
  if (input.path !== undefined && isValidMemoryPath(input.path)) {
    const normalized = normalizePath(input.path)
    return normalized.slice(0, normalized.lastIndexOf("/"))
  }

  if (input.memoryType === "arc") return ARCS_DIR

  if (input.memoryType === "task") {
    return input.workspace !== undefined && input.workspace !== ""
      ? `projects/${slugify(input.workspace)}/${TASKS_SUBDIR}`
      : `${INBOX_DIR}/${TASKS_SUBDIR}`
  }

  const namesPerson = (input.entities ?? []).some((entity) => entity.startsWith("person:"))
  if (namesPerson && input.memoryType === "semantic") return PEOPLE_DIR

  if (input.workspace !== undefined && input.workspace !== "") {
    return `projects/${slugify(input.workspace)}`
  }

  const primaryTag = (input.tags ?? []).find((tag) => tag.trim() !== "")
  if (RESOURCE_TYPES.includes(input.memoryType) && primaryTag !== undefined) {
    return `resources/${slugify(primaryTag)}`
  }

  return INBOX_DIR
}

export const archivePathFor = (path: string, year: number): string =>
  `${ARCHIVE_BUCKET}/${yearSegment(year)}/${normalizePath(path)}`

export const originalPathFor = (archivePath: string): string | undefined => {
  const normalized = normalizePath(archivePath)
  const match = /^archive\/(\d{4,})\/(.+)$/.exec(normalized)
  return match?.[2]
}
```

**Assumptions consumers make:**

- Every caller assumes `placementFor` never fails and never returns a directory outside a PARA bucket, so the write path does not guess twice (`packages/contracts/src/paths.ts:134-143`). An unusable explicit `path` is ignored rather than propagated, which is how totality is preserved.
- `packages/store/src/layout.ts:36-48` assumes the three directory constants `placementFor` can return already exist on disk, so `memhtml init` creates all of them and an agent's first write lands somewhere real.
- `packages/index/src/project.ts:336-341` assumes the leading slash in a link's `href` must be stripped before it becomes a `dst_path`, because the `edges` table stores the git-tree form and a slashed value would fail to join `files.path` while looking exactly like a corpus with no edges.
- A caller that wants an invalid path rejected instead of re-derived asks the store for it, with `strictPath` on a `WriteInput` (`packages/store/src/store.ts`, `strictPathRefusal`).
- `packages/index/src/project.ts:366-368` re-implements the archive-path inverse as a local `originOf` instead of importing `originalPathFor`, so two copies of the same regex exist. Both match `^archive\/\d{4,}\/(.+)$`.
- `PlacementInput` allows `| undefined` on every optional field. `packages/contracts/src/paths.ts:112-118` states that under `exactOptionalPropertyTypes` a bare `path?: string` would force every tool adapter to strip absent fields by hand, so the contract accepts the shape the MCP and CLI layers already hold.

**Drift risk:** Adding a routing rule to `placementFor` changes where new memories land without moving anything already in the root, so the same logical memory can sit in two directories depending on when it was written. Mitigation: treat a rule change as needing a migration pass over the root, and check inbox depth through `memhtml doctor`, which already reports it as a health signal (`packages/contracts/src/paths.ts:15-18`).

## The memory type vocabulary, restated in SQL

This module declares ten memory types, nine of which an agent may write, and the SQL restates the same list as a CHECK constraint. It has 11 import sites across 4 packages and 2 apps, plus two migrations.

**Producer:** `packages/contracts/src/types.ts:18-56`

**Consumer(s):**

- `packages/index/src/scope.ts:1` imports `MEMORY_TYPES` and `MemoryType`; the scope's `memoryTypes` field is typed by it (`packages/index/src/scope.ts:40`).
- `packages/html/src/document.ts:2-8` imports `MemoryType`, `MemoryStatus`, `TaskStatus`, `Confidence`, `Importance` into `MemoryMetas` (`packages/html/src/document.ts:29-83`).
- `packages/html/src/template.ts:2` imports the same five for `NewMemoryInput`.
- `packages/html/src/parse.ts:9` imports from it to decode the head's metas.
- `packages/index/src/indexer.ts:7` and `packages/store/src/layout.ts:6` import `PARA_BUCKETS`.
- `packages/store/src/index.ts:16` re-exports `PARA_BUCKETS` and `ParaBucket` rather than restating them.
- `packages/sleep/src/phases/person-links.ts:3` imports `PERSON_ENTITY_PREFIX`.
- `apps/mcp/src/tools.ts:10` imports `PARA_BUCKETS` and `WRITABLE_MEMORY_TYPES`; `apps/mcp/src/tools.ts:45` becomes `Schema.Literals(WRITABLE_MEMORY_TYPES)` and `apps/mcp/src/tools.ts:654` becomes `Schema.Literals(PARA_BUCKETS)`.
- `apps/cli/src/commands.ts:2` imports `TASK_STATUSES` and `WRITABLE_MEMORY_TYPES` for the flag enums.
- `apps/cli/src/operations.ts:11` imports from it.
- `packages/index/migrations/0001_files.sql:18,34` and `packages/index/migrations/0008_tasks.sql:38-40,46` restate `memory_type` and `para` as CHECK constraints.

**Shape:**

```typescript
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

export const WRITABLE_MEMORY_TYPES = MEMORY_TYPES.filter(
  (type): type is Exclude<MemoryType, "arc"> => type !== "arc"
)

export const PARA_BUCKETS = ["projects", "areas", "resources", "archive"] as const

export const TASK_STATUSES = ["todo", "doing", "blocked", "done"] as const
```

And the SQL restatement:

```sql
memory_type     TEXT NOT NULL CHECK (memory_type IN (
                  'episodic','semantic','procedural','agent_insight',
                  'user_preference','error_pattern','verdict','precedent','arc','task')),
para            TEXT NOT NULL CHECK (para IN ('projects','areas','resources','archive')),
```

**Assumptions consumers make:**

- Both agent-facing surfaces assume the writable vocabulary is exactly the storage vocabulary minus `arc`, and each derives the enum rather than restating it (`apps/mcp/src/tools.ts:45`, `apps/cli/src/commands.ts:2`). `packages/contracts/src/types.ts:34-37` gives the reason. An arc is synthesized by the sleep cycle from many memories, so an agent naming one directly would assert a conclusion the corpus has not earned.
- Retrieval assumes `task` is the one type an unscoped query does not see, and names it as a single constant so three copies of the string cannot drift (`packages/index/src/scope.ts:80-87`). `packages/index/src/scope.ts:31-39` states that a corpus with fifty open to-do items would otherwise crowd out the knowledge an agent asked for.
- `packages/html/src/document.ts:69-74` assumes `taskStatus` is present if and only if `memoryType` is `task`, and the parser reports a violation either way round. `packages/index/migrations/0008_tasks.sql:66-72` admits NULL in the `task_status` CHECK so one column serves both cases.
- The dedup index assumes tasks are exempt from content deduplication. `packages/index/migrations/0008_tasks.sql:119-127` adds `AND memory_type <> 'task'` to the partial unique index, so two open tasks may share a body while two memories may not.
- `packages/contracts/src/types.ts:58-62` assumes `archive` is a bucket rather than a status, so eviction is a `git mv` and the path itself records the state. `git log --follow` reads through it and `diff -M` reports the move as `R100`.

**Drift risk:** Widening the TypeScript vocabulary without the matching migration makes every write of the new type fail at the CHECK. The migration is expensive. `packages/index/migrations/0008_tasks.sql:1-2` states that adding `task` as the tenth type required a full recreate-and-copy of both `files` and `edges`, because SQLite cannot ALTER a CHECK constraint. Mitigation: budget a recreate-and-copy migration for any vocabulary widening, and copy the pattern at `packages/index/migrations/0008_tasks.sql:30-140`.

## `DatabaseShape`

This is the one interface between every SQL-writing module and the driver. 15 non-test source files reference it, which makes it the most widely referenced service interface in the repo.

**Producer:** `packages/index/src/database.ts:62-103`

**Consumer(s):**

- `packages/index/src/retrieval.ts:5,149` takes it as `RetrievalDeps.db`.
- `packages/index/src/indexer.ts:11` takes it as an indexer dependency.
- `packages/index/src/traces-persist.ts` and `packages/index/src/index-state.ts` and `packages/index/src/reinforce.ts` all reference it.
- `packages/sleep/src/sql.ts`, `packages/sleep/src/retention.ts`, `packages/sleep/src/env.ts` reference it, so the whole sleep cycle reaches SQL only through this shape.
- `packages/eval/src/harness.ts` references it.
- `apps/cli/src/api-layer.ts` wires it, and `apps/cli/src/operations.ts`, `apps/cli/src/views.ts`, `apps/cli/src/doctor.ts` consume it.
- `packages/index/src/index.ts:10-18` publishes `DatabaseService`, `DatabaseShape`, `SqlValue`, `Write`, `attachState`, `makeDatabase`, `runStateMigrations` as the package's SQL surface.

**Shape:**

```typescript
export type SqlValue = string | number | null | Uint8Array

export interface Write {
  readonly sql: string
  readonly params: ReadonlyArray<SqlValue>
}

export interface DatabaseShape {
  readonly run: (
    sql: string,
    params?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<void, StorageFailure>
  readonly get: <A>(
    sql: string,
    params?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<A | undefined, StorageFailure>
  readonly all: <A>(
    sql: string,
    params?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<ReadonlyArray<A>, StorageFailure>
  /** Applies every write atomically: all commit, or none do. */
  readonly writeAll: (writes: ReadonlyArray<Write>) => Effect.Effect<void, StorageFailure>
  readonly script: (sql: string) => Effect.Effect<void, StorageFailure>
  readonly migrationsApplied: number
  readonly stateMigrationsApplied: number
  /** True when `state.access` and `state.edge_corroboration` are reachable from this connection. */
  readonly hasState: boolean
}
```

**Assumptions consumers make:**

- Every caller of `get` and `all` supplies its own row type parameter `A` and assumes the driver's rows match it, because there is no runtime decode at this boundary. `packages/index/src/retrieval.ts:153-167` declares `HitRow` with snake_case column names and hands it to `all<HitRow>`, so a column rename becomes a silent `undefined` rather than a type error.
- `packages/index/src/project.ts:373-380` assumes `writeAll` is one transaction and therefore deduplicates rows before sending them, because a duplicate primary key from one file with a repeated `<dt>`/`<dd>` pair would roll back every other row in the batch.
- `packages/index/src/indexer.ts` assumes it must split a whole-store pass into batches instead of sending one transaction. `packages/index/src/schema-const.ts:77-85` sets `WRITE_BATCH_SIZE` at 500 and states the reason, which is to bound how much work a single failure discards and how long one write holds the WAL write lock.
- Callers assume a concurrent writer blocks rather than fails. `packages/index/src/database.ts:13-22` sets a 5000 ms busy timeout and states that the fleet runs many short-lived CLI invocations plus a long-lived MCP server against one store, serializing by waiting.
- Retrieval assumes the connection has `vector_distance_cos` registered, and that it computes the same arithmetic as the TypeScript MMR pass. `packages/index/src/database.ts:38-52` registers it from `@memhtml/domain`'s `cosineDistance` and states that two copies of the arithmetic could disagree about a clamp or a zero-magnitude vector while both looked right.
- Cross-plane callers assume `hasState` before qualifying a query with the `state` schema, because `state.db` is ATTACHed rather than always present (`packages/index/src/database.ts:99-100`).

**Drift risk:** A column rename in a migration passes type-check everywhere, because the row types are declared at the call sites and never checked against the schema. Mitigation: `packages/index/src/schema-const.ts:1-5` names identifiers the SQL and the TypeScript both use so a table rename is a compile error at every reader; extend that pattern to a column when one starts drifting.

## `MemoryDoc` and the parse output

`MemoryDoc` is the parsed form of a memory file, and the boundary between the format package and the index. The format package owns the name because a change to the HTML vocabulary changes this shape.

**Producer:** `packages/html/src/document.ts:29-209`

**Consumer(s):**

- `packages/index/src/project.ts:5` imports `MemoryDoc` and projects it onto rows; `packages/index/src/project.ts:346-351` reads `doc.links`, and `packages/index/src/project.ts:330` reads `doc.article.codeLangs`.
- `packages/index/src/indexer.ts:8` imports `parseMemory` and `contentHash`, then calls both at `packages/index/src/indexer.ts:189-201`.
- `packages/store/src/store.ts:20` imports `MemoryDoc` as `ReadResult.doc` (`packages/store/src/store.ts:125-129`).
- `apps/mcp/src/handlers.ts:27` imports `MemoryDoc`.
- `packages/html/src/parse.ts:322` declares `parseMemory` returning it.

**Shape:**

```typescript
export const MemoryDoc = Schema.Struct({
  /** The `<title>` text. The human name of the memory and the slug's source. */
  title: Schema.String,
  metas: MemoryMetas,
  /** `memhtml-entity` values as authored, e.g. `service:checkout-api`, in document order. */
  entities: Schema.Array(Schema.String),
  /** `memhtml-tag` values as authored, in document order. Open vocabulary. */
  tags: Schema.Array(Schema.String),
  links: Schema.Array(MemoryLink),
  article: ArticleExtractions,
  warnings: Schema.Array(Schema.String)
})
export type MemoryDoc = typeof MemoryDoc.Type
```

The nested `MemoryLink` carries the other coordinate space at this boundary:

```typescript
export const MemoryLink = Schema.Struct({
  rel: EdgeRel,
  href: Schema.String
})
```

**Assumptions consumers make:**

- The indexer assumes a parse failure is a counted skip rather than a fatal error, so one bad file does not stop the tree. `packages/index/src/indexer.ts:184-201` wraps `parseMemory` in `Effect.result`, and `packages/index/src/indexer.ts:40-41` types the skip list on `RebuildReport`.
- The indexer assumes the field names are its own, so no translation layer exists. `packages/html/src/document.ts:125-128` states that `ArticleExtractions` field names are the indexer's, and `packages/index/src/project.ts` consumes the struct directly.
- Consumers assume an absent meta means the file did not state it, never a substituted default. `packages/html/src/document.ts:20-24` states that the `files` table owns the defaults and a parser inventing `confidence: 1.0` would make a hand-authored omission indistinguishable from a deliberate assertion. `packages/index/migrations/0008_tasks.sql:48-49` holds those defaults.
- Consumers assume `href` carries a leading slash and `dst_path` does not. `packages/html/src/document.ts:88-93` states the conversion is `normalizePath` applied at the store boundary, and `packages/index/src/project.ts:354` performs it.
- The indexer assumes `article.html` is a serialization fixed point, because the content hash is computed from it. `packages/html/src/document.ts:130-134` states that re-parsing and re-serializing it yields the same bytes, and `packages/index/src/indexer.ts:195` hashes it.
- Consumers assume `metas.contentHash` is advisory and may disagree with the computed hash. `packages/html/src/document.ts:38-42` states the parser reports it verbatim and never repairs it, so a stale value is visible to `memhtml doctor`.
- Consumers assume `warnings` is non-fatal by construction, so a hand-authored file with an out-of-vocabulary element still parses and still indexes (`packages/html/src/document.ts:202-207`).

**Drift risk:** Adding an extraction field to `ArticleExtractions` leaves the projection ignoring it, so the new field reaches no SQL column and no search arm while the type checks clean. Mitigation: add the field, the migration, and the `projectFile` write in one change, and assert the round trip in the reproducibility test at `tests-integration/tests/rebuild.test.ts:204-226`.

## `StoreShape` and the write surface

`StoreShape` declares every operation that changes the corpus in the root, and each operation produces exactly one git commit. Every write in the system goes through this interface.

**Producer:** `packages/store/src/store.ts:198-280`

**Consumer(s):**

- `apps/cli/src/api-layer.ts` wires `Store` as a service and re-exports the tag, making it the composition root for both apps.
- `apps/cli/src/operations.ts` calls the write methods behind every CLI command.
- `apps/mcp/src/handlers.ts` calls the same methods behind every MCP tool.
- `packages/sleep/src/edits.ts:1-4` builds on the same primitives for the sleep cycle's edits.
- `tests-integration/tests/contracts.test.ts:35-68` asserts the dedupe behavior through the shipped CLI, which is the store's contract observed from outside.

**Shape:**

```typescript
export type WriteInput = NewMemoryInput &
  WriteProvenance & {
    /** An explicit path override. Ignored when it is not a usable memory path. */
    readonly path?: string | undefined
    readonly workspace?: string | undefined
  }

export interface WriteResult {
  /** The path the content lives at: the new file, or the existing one on a dedupe. */
  readonly path: string
  readonly created: boolean
  readonly deduped: boolean
  readonly existingPath?: string | undefined
  /** The commit this write produced, or `null` on a dedupe (which commits nothing). */
  readonly commitSha: string | null
  /** The article's content hash, the value `dedupeLookup` was asked about. */
  readonly contentHash: string
}

export type StoreError =
  | GitFailure
  | StorageFailure
  | InvalidMemory
  | PathNotFound
  | WriteConflict
  | DirtyTree

export interface StoreShape {
  readonly root: string
  readonly git: GitShape
  readonly writeMemory: (input: WriteInput) => Effect.Effect<WriteResult, StoreError>
  readonly writeMemories: (
    inputs: ReadonlyArray<WriteInput>,
    options?: { readonly continueOnError?: boolean | undefined } | undefined
  ) => Effect.Effect<BatchWriteResult, StoreError>
  readonly readMemory: (path: string) => Effect.Effect<ReadResult, StoreError>
  readonly correctMemory: (
    target: string,
    input: WriteInput & { readonly reason?: string | undefined }
  ) => Effect.Effect<CorrectResult, StoreError>
  readonly archiveMemory: (path: string, reason: string) => Effect.Effect<ArchiveResult, StoreError>
  readonly supersedeMemories: (
    pairs: ReadonlyArray<{ readonly winnerPath: string; readonly loserPath: string }>
  ) => Effect.Effect<SupersedeResult, StoreError>
  readonly linkMemories: (
    srcPath: string,
    rel: EdgeRel,
    dstPath: string
  ) => Effect.Effect<{ readonly commitSha: string | null }, StoreError>
  /** Paths with uncommitted changes. Empty means a clean tree. */
  readonly dirtyPaths: () => Effect.Effect<ReadonlyArray<string>, StoreError>
  /** Fail with `DirtyTree` unless the working tree is clean. What sleep's preflight calls. */
  readonly requireCleanTree: () => Effect.Effect<void, StoreError>
  readonly mergeBranch: (commitish: string) => Effect.Effect<void, StoreError>
}
```

**Assumptions consumers make:**

- Callers assume one operation is one commit, and that the store owns staging. `packages/store/src/store.ts:37-44` states that a caller staging its own files could bundle two unrelated writes into one commit, which would stop `git log` from reading as a history and stop `diff base..HEAD` from being a reviewable sleep run.
- Callers assume `created` and `deduped` are mutually exclusive and that exactly one is true (`packages/store/src/store.ts:61-67`), so they branch on either.
- Callers assume `commitSha` is `null` exactly when nothing was written. `packages/store/src/store.ts:74` says so for a single write, `packages/store/src/store.ts:103-109` for a batch, and `packages/store/src/store.ts:148-152` for a supersede.
- Batch callers assume the error channel means the batch mechanism failed, and never that a single op was rejected. `packages/store/src/store.ts:215-218` states that a rejected op is a `BatchOpResult` with `ok: false`, including in atomic mode, so a caller always gets its per-op array back.
- Batch callers assume the fold owns two properties rather than the caller. The fold produces one commit for N writes, and it assigns paths without collisions. `packages/store/src/store.ts:209-214` states that `freePathFor` reads disk and cannot see a path an earlier op in the same batch has claimed but not written.
- Batch callers assume `skipped` is distinct from a failure, because retrying a skipped op is correct and retrying a failed one is not (`packages/store/src/store.ts:84-88`).
- Callers assume the dedupe question is asked before any file is written, so a duplicate leaves the tree byte-identical with nothing to roll back. `tests-integration/tests/contracts.test.ts:54-68` asserts that against git itself rather than only against the report.
- The store assumes dedupe knowledge is injected rather than owned, because the package is SQL-free by design. `packages/store/src/store.ts:161-171` declares `DedupeLookup` as a function and states that the store's only knowledge is that a non-null answer means do not write.
- The store assumes a path move needs an explicit callback, because cross-database foreign keys do not exist. `packages/store/src/store.ts:173-181` declares `MoveCallback` as how `state.access.path` follows an archive.

**Drift risk:** Adding a method that writes without committing, or splitting an existing one-commit operation into two, breaks rollback and stops `diff base..HEAD` from being a reviewable unit. Mitigation: `packages/store/src/store.ts:224-231` and `:237-252` state the one-commit rule for corrections and supersedes. Hold any new operation to the same rule and assert the commit count in the integration tier.

## `GitPort` against the store's `GitShape`

The indexer declares its own read-only view of git instead of importing the store's client, and one adapter bridges them. No other contract in the repo ships a written analysis of why its two sides do not fit together directly.

**Producer:** `packages/index/src/git-port.ts:17-76`

**Consumer(s):**

- `packages/index/src/indexer.ts:12` imports `GitPort` as an indexer dependency.
- `packages/index/src/git-adapter.ts:3` imports `DiffEntry`, `GitPort`, `StatusEntry`, `TreeEntry` and produces a `GitPort` from a `StoreGitShape` at `packages/index/src/git-adapter.ts:138`.
- `packages/index/src/index.ts:31-42` publishes both the port and the adapter as the package's git surface.
- `apps/cli/src/api-layer.ts` supplies the production adapter, binding the store's git client to the port.

**Shape:**

```typescript
/** One `git ls-tree -r` row. */
export interface TreeEntry {
  /** The blob's own sha. Equal to `git hash-object <file>`, which makes it the free change key. */
  readonly blobSha: string
  /** Repo-root-relative, no leading slash — the git-tree form, and the `files.path` primary key. */
  readonly path: string
}

export interface DiffEntry {
  readonly status: "A" | "M" | "D" | "R"
  readonly path: string
  readonly fromPath?: string | undefined
}

/** One `git status --porcelain=v2` row: an uncommitted change the working tree carries. */
export interface StatusEntry {
  readonly path: string
  /** True when the path is gone from the working tree. */
  readonly deleted: boolean
}

export interface GitPort {
  /** The commit the working tree is on. */
  readonly revParseHead: () => Effect.Effect<string, StorageFailure>
  readonly lsTreeR: (
    ref: string,
    pathPrefixes: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<TreeEntry>, StorageFailure>
  readonly catFileBatch: (
    shas: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, string>, StorageFailure>
  readonly diffNameStatus: (
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<DiffEntry>, StorageFailure>
  readonly statusPorcelainV2: () => Effect.Effect<ReadonlyArray<StatusEntry>, StorageFailure>
  /** The blob sha a working-tree file WOULD have. The dirty path's change key. */
  readonly hashObject: (path: string) => Effect.Effect<string, StorageFailure>
  /** A working-tree file's bytes as text. Used only for uncommitted paths. */
  readonly readWorkingFile: (path: string) => Effect.Effect<string, StorageFailure>
}
```

The indexer re-declares the store's side instead of importing it. That declaration is the second half of the contract.

```typescript
/** The subset of `@memhtml/store`'s `GitShape` the indexer consumes. Declared, not imported. */
export interface StoreGitShape {
  readonly revParseHead: () => Effect.Effect<string | null, unknown>
  readonly lsTreeR: (
    commitish: string,
    pathspecs?: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<StoreTreeEntry>, unknown>
  readonly catFileBatch: (
    shas: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, unknown>
  readonly diffNameStatus: (
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<StoreChangedPath>, unknown>
  readonly statusPorcelainV2: () => Effect.Effect<ReadonlyArray<StoreStatusEntry>, unknown>
  readonly hashObject: (path: string) => Effect.Effect<string, unknown>
}
```

**Assumptions consumers make:**

- The indexer assumes every port method is read-only, so an index cannot commit. `packages/index/src/git-port.ts:11-14` states that an index that could commit would make "rebuildable from git" circular.
- The indexer assumes `revParseHead` returns a commit, never `null`. The adapter turns an unborn HEAD into a typed failure at `packages/index/src/git-adapter.ts:163-170`, and `packages/index/src/git-adapter.ts:157-162` states that letting `null` through would surface as an opaque `git diff null HEAD` error.
- The indexer assumes `catFileBatch` yields text. The adapter decodes UTF-8 at `packages/index/src/git-adapter.ts:187-198`.
- The indexer assumes a `copied` entry is NOT a rename. `packages/index/src/git-adapter.ts:109-114` maps it to `A` and states that `R` would make the indexer move the source's row to the destination and drop a live file from the index.
- The indexer assumes a rename carries `fromPath`, which is how the embedding survives an archive move. `packages/index/src/git-adapter.ts:103-108` downgrades a source-less rename to `A` rather than moving a row out from under an unknown path.
- The indexer assumes an `ignored` or `unmerged` status entry is not a change. `packages/index/src/git-adapter.ts:118-129` drops both and states that indexing either side of an unresolved merge would record a state the tree does not agree on.
- The indexer assumes a missing file is a counted skip, not a crash. `packages/index/src/git-adapter.ts:139-154` uses `Effect.catchCause` rather than `Effect.catch` so a defect from a `readFile` wired with `Effect.promise` cannot kill the fiber, and `packages/index/src/git-adapter.ts:71-79` states that an agent listing a path it just archived is the normal case.
- The adapter assumes a submodule entry has no blob behind it and drops it, keeping every sha in the batch resolvable (`packages/index/src/git-adapter.ts:176-184`).
- Both sides assume the tags must differ. `packages/index/src/git-port.ts:71-76` uses `memhtml/IndexGit` because `@memhtml/store` already publishes `memhtml/Git`, and two shapes under one tag would let a layer satisfy the wrong requirement without an error.

**Drift risk:** Adding a `kind` to the store's `StoreChangedPath` or `StoreStatusEntry` union breaks the adapter's exhaustive switches at compile time, which is the intended behavior. Changing the meaning of an existing kind produces no compile error. Mitigation: `packages/index/src/git-adapter.ts:86-90` exports `toDiffEntry` and `toStatusEntry` so the mapping is assertable without a repository, and names `copied` as the case that would corrupt the index and is awkward to provoke from real git.

## The CLI JSON envelope and exit codes

This is the machine contract an agent parses. It declares two envelope shapes, the response discriminators, the error codes, and 3 exit codes, and all of those lists are append-only — the counts are deliberately not restated here, because an append-only list grows and a number beside it in prose is a number nothing re-derives.

**Producer:** `apps/cli/src/envelope.ts:6-157`

**Consumer(s):**

- `apps/cli/src/run.ts:12-14` imports the exit codes and pairs each envelope with one; `apps/cli/src/run.ts:823-1025` emits every command's response.
- `apps/cli/src/errors.ts:1` imports `ErrorCode`, `Failure`, `fail` and produces the failure envelope at `apps/cli/src/errors.ts:153-155`.
- `apps/cli/src/agents-doc.ts:9` imports `API_VERSION`, `ERROR_CODES`, and all three exit codes, and writes them into the generated agent documentation at `apps/cli/src/agents-doc.ts:104-106`.
- `apps/mcp/src/failure.ts:1` imports `codeFor` and `messageFor` from `@memhtml/cli`, so the MCP server reports the same code vocabulary (`apps/mcp/src/failure.ts:32-34`).
- `tests-integration/tests/harness.ts:141-150` parses the envelope for every integration assertion: `body.error !== undefined` is the failure test and `body.data` is the payload.
- `packages/index/src/retrieval.ts:110-113` cites `apps/cli/src/envelope.ts:139` by line to explain why `scopeEmpty` is always a boolean.

**Shape:**

```typescript
export const API_VERSION = "1"

export interface Success<A> {
  readonly apiVersion: typeof API_VERSION
  readonly type: ResponseType
  readonly data: A
}

export interface Failure {
  readonly apiVersion: typeof API_VERSION
  readonly error: string
  readonly code: ErrorCode
  readonly suggestions: ReadonlyArray<string>
}

export const ERROR_CODES = [
  "ERR_UNKNOWN_COMMAND",
  "ERR_MISSING_ARGUMENT",
  "ERR_INVALID_FLAG",
  "ERR_PATH_NOT_FOUND",
  "ERR_INVALID_MEMORY",
  "ERR_DUPLICATE_CONTENT",
  "ERR_WRITE_CONFLICT",
  "ERR_DIRTY_TREE",
  "ERR_INDEX_STALE",
  "ERR_EMBED_MODEL_MISMATCH",
  "ERR_MODEL_UNAVAILABLE",
  "ERR_STORAGE",
  "ERR_GIT",
  "ERR_DISCRIMINATION_FAILED",
  "ERR_UNKNOWN"
] as const

/** Exit codes stay stable so a shell caller can branch without parsing output. */
export const EXIT_OK = 0
export const EXIT_USAGE = 2
export const EXIT_RUNTIME = 1
```

**Assumptions consumers make:**

- An agent is assumed to branch on `code` and never on the human `error` string. `apps/cli/src/envelope.ts:62-66` states that a code's meaning never changes and a code is never removed, while the prose changes freely as wording improves.
- A parser is assumed to read `type` before parsing `data`. `apps/cli/src/envelope.ts:8-11` states that a new payload shape gets a new discriminator rather than reusing one, so a discriminator's meaning is fixed once shipped.
- `apps/cli/src/errors.ts:110-116` assumes suggestions are part of the contract that a caller may rely on, and that absent suggestions arrive as an empty array rather than a null, so a parser never branches on presence.
- Payload shapes assume `--dense` drops null-valued keys, so a field that is null when absent disappears from the output an agent pastes into a prompt. `apps/cli/src/envelope.ts:140-154` implements `stripNulls`, and `packages/index/src/retrieval.ts:108-118` cites that behavior as the reason `scopeEmpty` is a boolean in every case.
- `apps/cli/src/errors.ts:117-126` assumes a suggestion string names a real command from the table in `apps/cli/src/commands.ts:111`, and enforces that with a walkable record rather than a switch so the suite can run every suggestion through the real `parseArgv`. The same comment states the import stays out of `apps/cli/src/errors.ts` because it would close a cycle through `apps/cli/src/operations.ts`.
- The MCP server assumes only `.message` reaches the wire, so it folds code, reason, and suggestions into one string at construction. `apps/mcp/src/failure.ts:17-23` states that `code` and `suggestions` are not wire fields because MCP's tool-error channel is one text block, and puts the code first behind a colon so a reader can recover it from the prefix.
- `apps/mcp/src/failure.ts:8-16` assumes a tool must declare a failure schema for its own message to reach the agent. `McpServer` has three catch branches and only one passes the message through. Without the declared schema the agent receives the string "Tool execution failed due to an internal server error".
- A shell caller is assumed to branch on the exit code without parsing output (`apps/cli/src/envelope.ts:87`), and `apps/cli/src/run.ts:827,952,964,1011,1013` pair every usage refusal with `EXIT_USAGE` while `apps/cli/src/run.ts:850,879,982,1019` pair every runtime failure with `EXIT_RUNTIME`.

**Drift risk:** Reusing an existing `RESPONSE_TYPES` discriminator for a changed payload shape breaks every parser silently, since `apiVersion` stays `"1"` and the discriminator still matches. Mitigation: treat both lists as append-only as the file states, and add a new discriminator for any payload change that is not purely additive.

## The retrieval surface

Search and recall over the projection, with the scope contract every arm receives and the hit shape an agent chains from.

**Producer:** `packages/index/src/retrieval.ts:37-146` and `packages/index/src/scope.ts:29-94`

**Consumer(s):**

- `apps/cli/src/operations.ts` calls `search` and `recall` behind the CLI commands.
- `apps/mcp/src/handlers.ts` calls the same two behind the MCP tools.
- `packages/index/src/retrieval.ts:14` imports `assembleScope` and `SearchScope` from the scope module, and `packages/index/src/retrieval.ts:38,122` extends `SearchScope` into both input types.
- `packages/index/src/index.ts:69-83,114-119` publishes `SearchInput`, `SearchHit`, `SearchResult`, `RecallInput`, `RecallPack`, `RetrievalShape`, `QueryEmbedPort`, `SearchScope`, `assembleScope`, `EXCLUDED_BY_DEFAULT`.
- `apps/cli/src/api-layer.ts` wires the `Retrieval` service.

**Shape:**

```typescript
export interface SearchScope {
  readonly memoryTypes?: ReadonlyArray<MemoryType> | undefined
  readonly workspace?: string | undefined
  /** ANY-of overlap. Each tag BROADENS the result set. */
  readonly tags?: ReadonlyArray<string> | undefined
  readonly entity?: string | undefined
  /** `<dl>` facet predicates: AND across distinct names, OR within one name. */
  readonly facets?: ReadonlyArray<FacetFilter> | undefined
  /** Archived files are excluded unless asked for. Eviction is a `git mv`, so they still exist. */
  readonly includeArchived?: boolean | undefined
  readonly asOf?: string | undefined
}

export interface SearchHit {
  readonly path: string
  readonly title: string
  readonly gist: string
  readonly memoryType: string
  /** The fused RRF score, unitless and comparable only within one result set. */
  readonly score: number
  readonly confidence: number
  readonly updatedAt: string
  readonly snippet: string
  readonly entities: ReadonlyArray<string>
  readonly supersededBy: string | null
}

export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHit>
  readonly degraded: boolean
  /** The arms that actually contributed, for the operator envelope. */
  readonly arms: ReadonlyArray<string>
  readonly entityScope: string | null
  readonly scopeEmpty: boolean
}

export interface RetrievalShape {
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, StorageFailure>
  readonly recall: (input: RecallInput) => Effect.Effect<RecallPack, StorageFailure>
}
```

**Assumptions consumers make:**

- An agent is assumed to chain a second search off a hit's own `entities` array verbatim. `packages/index/src/retrieval.ts:61-73` calls the `type:name` form a contract with the `entity` scope rather than a display choice, and `packages/index/src/scope.ts:49-61` states the same spelling on the scope side because `file_entities` is keyed on `(type, name)` and a bare name would be ambiguous.
- Consumers assume `entities` is an empty array rather than absent when a memory names none, because a caller reading an absent key cannot tell "no entities" from "this server does not report them" (`packages/index/src/retrieval.ts:70-72`).
- Consumers assume `supersededBy` is present and nullable in every result for the same reason (`packages/index/src/retrieval.ts:74-79`), and that it comes from the `edges` table rather than the head meta, since the meta reaches no SQL column and reading it would cost a file open per hit (`packages/index/src/retrieval.ts:81-84`).
- Consumers assume `score` is comparable only within one result set (`packages/index/src/retrieval.ts:49`), so two searches cannot be merged by score.
- Consumers assume search never fails because the embedder is down, it gets narrower. `packages/index/src/retrieval.ts:186-192` catches the model failure and logs it, and `packages/index/src/retrieval.ts:90-96` surfaces `degraded` so an agent comparing two searches knows one was ranked by fewer signals.
- Consumers assume `scopeEmpty` distinguishes an over-narrow scope from an empty corpus, and is never `true` for an unscoped empty result (`packages/index/src/retrieval.ts:114-117`). `packages/index/src/scope.ts:169-181` defines `scopeNarrows` and excludes `includeArchived` because it widens.
- Consumers assume `snippet` is an empty string only when the file has no chunk at all, never absent (`packages/index/src/retrieval.ts:53-59`).
- Both entry points assume the scope filter is built once and handed to every arm identically. `packages/index/src/scope.ts:6-13` states that per-arm filters would let a scope apply to three arms and not the fourth, which surfaces as a scoped query returning a result from outside the scope, and that no type catches it.
- The scope assumes parameter numbering starts at `?5` and holds whether or not the vector arm fired, because the caller always binds a four-value prefix with `null` at `?4`. `packages/index/src/scope.ts:22-26` records that an unbound numbered parameter reads as NULL on this driver rather than failing, so a shifted number would silently match nothing.
- The scope assumes `workspace` is strict equality, so a workspace-scoped query never sees a NULL-workspace file (`packages/index/src/scope.ts:41-46`).
- `asOf` assumes all three temporal columns compare lexicographically as strings, so the predicate is string comparison rather than a per-row parse (`packages/index/src/scope.ts:70-75`).

**Drift risk:** Adding a scope field without threading it into `assembleScope` leaves it accepted and ignored, so an agent narrowing a query gets an unscoped answer with no error. Mitigation: `packages/index/src/scope.ts:14-20` draws the line between a scope, which reaches every arm and belongs in this filter, and an arm's own exclusion, which must never enter it; a pin test enforces that an absent `asOf` produces a byte-identical filter (`packages/index/src/scope.ts:74-75`).

## The semantic-HTML memory-file grammar

The closed element and metadata vocabulary that defines what a memory file may contain. This is the contract the files in the root satisfy, so it binds the format package, the store's render gate, the indexer, and any hand-authored file.

**Producer:** `packages/html/src/vocabulary.ts:13-255`

**Consumer(s):**

- `packages/html/src/serialize.ts:6` imports `isRepeatableMeta`, `META_ORDER`, `MemoryMetaName` and emits metas in that order at `packages/html/src/serialize.ts:83`.
- `packages/html/src/constraints.ts:25` imports `REQUIRED_META` and checks each at `packages/html/src/constraints.ts:292-295`, then rejects an out-of-vocabulary meta name at `packages/html/src/constraints.ts:296-300`.
- `packages/html/src/parse.ts` reads the same prefix when collecting head metas and links (`packages/html/src/parse.ts:222-232`).
- `packages/store/src/store.ts:21-30` imports `checkMemory` and `renderTemplate`, so every write passes the vocabulary gate before a file is created.
- `apps/cli/src/doctor.ts:6` imports `checkMemory` to report violations over the whole root.

**Shape:**

```typescript
export const REQUIRED_META = [
  "memhtml-type",
  "memhtml-status",
  "memhtml-created",
  "memhtml-updated"
] as const

export const META_ORDER = [
  "memhtml-type",
  "memhtml-status",
  "memhtml-created",
  "memhtml-updated",
  "memhtml-confidence",
  "memhtml-importance",
  "memhtml-content-hash",
  "memhtml-author",
  "memhtml-session",
  "memhtml-prompt",
  "memhtml-turn",
  "memhtml-valid-from",
  "memhtml-valid-until",
  "memhtml-reprieves",
  "memhtml-archived",
  "memhtml-superseded-by",
  "memhtml-needs-revision",
  "memhtml-task-status",
  "memhtml-due",
  "memhtml-entity",
  "memhtml-tag"
] as const

export const REPEATABLE_META = ["memhtml-entity", "memhtml-tag"] as const

export const FIGURE_SCOPED_ELEMENTS = ["div", "span"] as const

export const FORBIDDEN_ATTRIBUTES: ReadonlySet<string> = new Set(["class", "style"])
export const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"])
```

**Assumptions consumers make:**

- The serializer assumes position in `META_ORDER` is a diff-stability contract, so a new scalar meta goes at the end of the scalar block. `packages/html/src/vocabulary.ts:65-69` states that inserting one mid-list would move every line below it in every file the next bookkeeping pass touches, and `packages/html/src/vocabulary.ts:42-46` states that a stable order is what makes a meta-only edit a one-line git diff.
- The parser and the constraint checker assume an out-of-vocabulary token means two different things: the parser drops the link so the file still parses (`packages/html/src/parse.ts:229-230`), the checker reports the violation (`packages/html/src/constraints.ts:259-261`).
- The checker assumes a duplicate `memhtml-type` is a violation rather than a last-wins pick, because two writers disagreeing about a memory's type should stop a write (`packages/html/src/constraints.ts:274-276`).
- The vocabulary assumes three metas are deliberately absent from `REQUIRED_META` because the `files` table documents a default for each, so a hand-authored file missing them is completed rather than refused (`packages/html/src/vocabulary.ts:28-34`). Those defaults are at `packages/index/migrations/0008_tasks.sql:48-49`.
- The serializer assumes `<pre>` needs a second newline emitted, because a newline immediately after the start tag is swallowed on parse. `packages/html/src/vocabulary.ts:202-207` states that without this, `<pre>` text starting with a newline loses one on every parse and serialize cycle and the content hash drifts.
- `bodyText` assumes a word boundary at every block-level edge and none at a phrasing-level edge, so `<dt>Applies to</dt><dd>ALB</dd>` yields two searchable words. `packages/html/src/vocabulary.ts:220-229` also states the content hash deliberately does NOT use `INLINE_ELEMENTS`, because making the digest a function of that list would move every hash on every future vocabulary change.
- The serializer assumes it must round-trip a file carrying `<script>` or `<style>` before the constraint is reported, which is why both appear in `RAW_TEXT_ELEMENTS` while also being forbidden (`packages/html/src/vocabulary.ts:186-200`, `:252`).
- `packages/html/src/vocabulary.ts:1-6` assumes the vocabulary IS the policy, so there is no sanitizer library and no allow-or-deny logic in the module.

**Drift risk:** Adding an element to `ARTICLE_ELEMENTS` without a matching extraction in `ArticleExtractions` makes the element legal and invisible: it parses without a warning and reaches no index column. Mitigation: pair a vocabulary addition with its extraction field and its projection write, and rely on the graceful-degradation rule at `packages/html/src/vocabulary.ts:88-95`, which makes an unnamed element a warning rather than a refusal in the interim.

## The root layout as system of record

Where memhtml puts things inside the external root, and which of those things survive a clone. This contract is what makes "the git tree is the system of record" checkable rather than aspirational.

**Producer:** `packages/store/src/layout.ts:22-76`

**Consumer(s):**

- `packages/store/src/store.ts:34` imports `attemptIo` and `readFileOrNull` from the same module, and `packages/store/src/store.ts:287-290` declares `MemhtmlRootConfig` reading `MEMHTML_ROOT`.
- `apps/cli/src/config.ts:4,85-88` imports `expandRoot` from `@memhtml/store` and re-declares `MemhtmlRoot` on top of it rather than redeclaring the expansion.
- `apps/cli/src/config.ts:26-31` documents `MEMHTML_ROOT` for `memhtml manifest` and the generated agent doc.
- `packages/index/src/schema-const.ts:7-18` names the migrations directories and the `state` schema the ATTACH uses.
- `tests-integration/tests/rebuild.test.ts:210-217` deletes both databases from `.memhtml/` and rebuilds, asserting the whole claim.

**Shape:**

```typescript
/** Where the index, the state plane, and the committed sidecars live. */
export const MEMHTML_DIR = ".memhtml"

/** The gitignored, rebuildable index database, relative to the root. */
export const INDEX_DB_PATH = `${MEMHTML_DIR}/index.db`

/** The gitignored state plane. NOT rebuildable from git — its sidecar is what survives. */
export const STATE_DB_PATH = `${MEMHTML_DIR}/state.db`

/** The committed append-only sidecar the state plane exports to. */
export const STATE_SIDECAR_PATH = `${MEMHTML_DIR}/state/access.jsonl`

export const GITIGNORE = `${INDEX_DB_PATH}
${STATE_DB_PATH}
${INDEX_DB_PATH}-*
${STATE_DB_PATH}-*
`

export const GITATTRIBUTES = `index.html merge=ours
sitemap.xml merge=ours
*.html diff=html
`

/** The config that makes `merge=ours` in `.gitattributes` actually resolve a conflict. */
export const MERGE_OURS_DRIVER = { key: "merge.ours.driver", value: "true" } as const
```

**Assumptions consumers make:**

- Every consumer assumes exactly two files are gitignored and everything else is committed, so a fresh clone plus `memhtml state import` plus `memhtml index rebuild` yields the whole system (`packages/store/src/layout.ts:50-54`). `tests-integration/tests/rebuild.test.ts:204-226` deletes both and asserts every row set returns.
- The rebuild path assumes `index.db` is reproducible from the tree and `state.db` is not. `packages/index/src/index.ts:5-6` states it, and `tests-integration/tests/rebuild.test.ts:205-209` states that deleting only the index would leave the harder half of the claim untested.
- The rebuild assumes its truncate list matches the schema. `packages/index/src/schema-const.ts:43-56` orders `MEMORY_TABLES` children before parents and states that a truncate list that has drifted leaves rows behind, so a rebuild is no longer a rebuild.
- The store assumes it must never create the root implicitly. `packages/store/src/layout.ts:12-19` states that a typo in `MEMHTML_ROOT` silently scaffolding a second empty memory repo would be worse than an error, because the agent would go on writing into it and only a later search would come up empty.
- Both config declarations assume `~` must be expanded in process rather than by a shell, because the value arrives from a shell profile, an MCP client config, and a cron line. `packages/store/src/store.ts:282-286` states that the other two would otherwise create a literal `./~` directory.
- `packages/store/src/layout.ts:61-69` assumes the `merge=ours` attribute alone does nothing, and records a live probe: with the attribute set and no driver configured, git still writes conflict markers. Since git config is per-clone, `memhtml init` must set `MERGE_OURS_DRIVER` again on every fresh clone.
- `packages/store/src/layout.ts:36-40` assumes an agent's first write must land in a directory that already exists, so `SCAFFOLD_DIRS` covers the four PARA buckets plus the three system directories `placementFor` can return.

**Drift risk:** Adding a generated artifact under the root without adding it to `.gitignore` or to `.gitattributes` makes it either a committed file that conflicts on every merge or a rebuildable file that is committed anyway. Mitigation: `packages/store/src/layout.ts:61-64` names the generated artifacts as the design's one merge-conflict source and `merge=ours` plus regeneration as the resolution; classify any new artifact into rebuildable-and-ignored or committed-and-merge-ours at the time it is added.

## Other contracts

- **`EmbedPort` and `QueryEmbedPort`**: two narrow ports the index declares over `@memhtml/llm`'s `EmbeddingsShape`, split because the document and query halves use different Bedrock `input_type` values and reusing one silently degrades retrieval (`packages/index/src/indexer.ts:26-31`, `packages/index/src/retrieval.ts:143-146`, `packages/llm/src/embeddings.ts:14-27`).
- **`IndexerShape` and its reports**: `RebuildReport` and `UpdateReport` carry counted skips so one unparseable file never fails a pass, and `EmbedMissingOptions` distinguishes a whole-store model migration from an incremental pass by the presence of a candidate list (`packages/index/src/indexer.ts:33-96`).
- **`SLEEP_PHASES` and `HARD_PREREQUISITES`**: 15 ordered phase names plus the pairs that must not be reordered, consumed by the sleep runner and by `memhtml sleep review` (`packages/sleep/src/contract.ts:17,35,42,57`).
- **`CONSOLIDATION_KINDS` and `ConsolidationResult`**: the consolidator's kinds are proven a subset of `WritableMemoryType` at compile time by an unused typed binding rather than a test (`apps/consolidator/src/contract.ts:28,44,85-86,116-117`).
- **`CONFIG_VARS`**: 8 documented environment variables in one array so `memhtml manifest` can describe the whole environment surface and an agent does not have to grep for `process.env`; the last entry's `name` is the imported `MCP_BIN_VAR` rather than a literal, so a rename cannot disclose a variable nothing reads (`apps/cli/src/config.ts:19-78`).
- **`COMMANDS`, `GLOBAL_FLAGS`, and `buildManifest`**: the command table is the single source for the `cli.manifest` response and for the generated `AGENTS.md`, both derived by walking it (`apps/cli/src/commands.ts:36,111,1024`, `apps/cli/src/agents-doc.ts:24,104-106`).
- **`ToolFailure`**: the MCP wire failure, whose `.message` is the whole agent-visible response; `toToolFailure` passes an already-composed `ToolFailure` through unchanged so a handler-built failure is not rewritten to its own class name (`apps/mcp/src/failure.ts:32-39,149-176`).
- **`Chunk` and `chunkIdFor`**: content-derived chunk ids are what let a `git mv` cost zero Bedrock calls, since `chunks` and `embeddings` key on the content hash (`packages/index/src/index.ts:9`, `packages/index/src/git-port.ts:26-30`).
- **`DisclosureCandidate` and `foldDisclosure`**: the tiered disclosure fold recall packs are built from, budgeted in characters (`packages/index/src/disclosure.ts` via `packages/index/src/index.ts:19-29`, consumed at `packages/index/src/retrieval.ts:6-11,128-134`).
- **`DedupeLookup` and `MoveCallback`**: two injected functions rather than repository methods, because `@memhtml/store` is SQL-free by design and cross-database foreign keys do not exist (`packages/store/src/store.ts:161-187`).
- **`Edge` and `isWellFormedEdge`**: the edge struct plus a caller-side well-formedness check that states the two `edges` CHECK conditions once in TypeScript so a bad edge can be refused before the driver refuses the batch (`packages/contracts/src/edges.ts:122-149`).
- **`spec/memhtml.symspec.json`**: a 61-entry EARS requirement ledger keyed by UUID, each entry carrying 17 fields including `key`, `sentence`, `status`, `systemName`, and `verificationMethod`; its one code consumer decodes `key`, `sentence`, `status`, `priority`, and `patternType` as required strings and throws on the file's own path when one is missing (`apps/docs/src/loaders/registry.ts:67,331-346`).

## See also

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 48 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 27 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 6 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 6 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 5 shared source citations
