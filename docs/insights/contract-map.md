# memhtml-public · Contract map

Describes the source at 0.16.0 (2026-10-18). Citations are `path:line` into that tree.

**Removed in 0.16.** The sleep pipeline (`memhtml sleep`, `@memhtml/sleep`) and the consolidator (`apps/consolidator`) are gone, and so are the contracts that belonged only to them. Sessions and the head carry the write path in their place, and `memhtml curate` carries curation. See [Migrate to 0.16](https://memhtml.github.io/learn/operations/migrate-to-0-16/).

A contract here is any declaration in one file that a file in another package or app depends on. Four kinds appear below.

1. A TypeScript type or an `effect` `Schema` declared in one package and imported by another.
2. A closed string vocabulary that several modules must agree on, including where SQL restates it as a CHECK constraint.
3. A service interface, declared as a `Context.Service` shape, whose implementation is bound at a composition root.
4. A serialized artifact one module writes and another reads: a JSON envelope on stdout, a git tree, a session log, an Arrow file, a request over a socket.

This repo's shared types are of two kinds: `effect` `Schema` declarations with a derived type (`export type X = typeof X.Type`), and plain TypeScript interfaces or type aliases. Every Shape block below quotes the declaration's code verbatim, whichever kind it is, and keeps a doc comment only where the comment states part of the contract.

Two facts apply to the whole map. First, this repository stores no memory. It's the software that manages a separate directory called the memhtml root, located by `MEMHTML_ROOT` and defaulting to `~/memhtml` (`apps/cli/src/config.ts:108-117`). Second, memhtml manages that root with git. The root's git tree is the system of record. `.memhtml/index.db` inside the root is a projection that's deleted and rebuilt without loss (`packages/index/src/index.ts:1-7`), and the head's snapshots and vector caches under `.memhtml/` are caches of the same tree. When a contract below says "the root" it means that external directory, never this repository.

The primary consumer of every boundary here is a coding agent. The CLI answers in JSON envelopes with stable codes rather than prose, with two declared exceptions (`help` on a terminal prints Markdown, and a successful `memhtml hook` prints the host's own hook protocol; `apps/cli/src/envelope.ts:51-59`), the MCP server publishes the same vocabularies as tool parameter enums, and the agent-facing documentation is generated from the command table. The notes below judge each surface by what an agent can parse and act on.

The sections are grouped by kind: the four vocabularies of `@memhtml/contracts` first, then the service and document shapes, then the agent-facing surfaces and the model boundary, then the v2 write and read paths (sessions, the head, its server, snapshots, the store's policy file, the curator, MCP search and recall, and the contract an agent runtime holds). Each of the five sections that states a dependent-file count measured it the same way, as every `.ts` file outside `tests/`, `test/`, `*.test.ts`, and `tests-integration/` whose text contains the module specifier (for the four vocabularies) or the bare identifier including its declaring file (for `DatabaseShape`), re-measured at 0.16.0: 49, 14, 16, 13 plus two migrations, and 17. The v2 packages mostly import the root `@memhtml/contracts` barrel instead of a subpath (11 files in `apps/cli`, 8 in `packages/head`, 7 each in `packages/session` and `packages/curator`, 3 in `packages/snapshot`, and 1 in `packages/store`), and the subpath counts don't include them.

## The typed error vocabulary

Eleven error classes in the shared contracts package define how every other package reports failure. `@memhtml/contracts/errors` is imported by 49 non-test files across 10 packages and 2 apps, which makes it the most widely imported contract in the repo.

**Producer:** `packages/contracts/src/errors.ts:9-106`

**Consumer(s):**

- `packages/store/src/store.ts:5-11` imports `DirtyTree`, `InvalidMemory`, `PathNotFound`, `StorageFailure`, `WriteConflict` and unions them with `GitFailure` into `StoreError` (`packages/store/src/store.ts:218-224`).
- `packages/store/src/git.ts:2` imports `GitFailure` and re-exports it (`packages/store/src/git.ts:32-38`), so every `import { GitFailure } from "@memhtml/store"` keeps resolving. `packages/session/src/errors.ts:9` re-exports the same class for the session's own git calls.
- `packages/index/src/database.ts:6` imports `StorageFailure` as the sole error type of every method on `DatabaseShape` (`packages/index/src/database.ts:61-93`).
- `packages/index/src/git-port.ts:1` imports `StorageFailure` as the port's one failure type (`packages/index/src/git-port.ts:50-75`).
- `packages/index/src/retrieval.ts:1` imports `ModelUnavailable` and `StorageFailure`.
- `packages/index/src/indexer.ts:1-5` imports `InvalidMemory`, `ModelUnavailable`, `StorageFailure`.
- `packages/html/src/parse.ts:2` imports `InvalidMemory` as `parseMemory`'s failure type (`packages/html/src/parse.ts:385`).
- `packages/head/src/record.ts:3`, `packages/head/src/overlay.ts:3`, and `packages/head/src/version.ts:2` import `InvalidMemory`, the failure a record that doesn't parse carries.
- `packages/llm/src/client.ts:2` and `packages/llm/src/embeddings.ts:1` import `ModelUnavailable`; `packages/llm/src/model-client.ts:1` imports both `LlmContractViolation` and `ModelUnavailable`; `packages/llm/src/structured.ts:1` imports `LlmContractViolation`.
- `apps/cli/src/errors.ts:42-102` switches on `_tag` to produce an `ErrorCode`. Its 19 arms don't cover every class. `LlmContractViolation` has no arm, so it falls to `default` and reports `ERR_UNKNOWN`, although `messageFor` handles it at `apps/cli/src/errors.ts:140-141`. `V1DoorClosed` is the one arm that reads its payload, answering `ERR_SESSION_BOUND` when `session` is a string and `ERR_V1_DOOR_CLOSED` otherwise (`apps/cli/src/errors.ts:95-98`).
- `apps/mcp/src/failure.ts:80-149` switches on the same tags to produce agent-executable suggestions, covering 12 of them; `IndexStale`, `RebuildNoEmbedRefused`, `IntegrationModified`, `LlmContractViolation`, `HeadGateFailed`, `CuratorModelSpecInvalid`, `HeadServerRunning`, and `HeadSocketPathTooLong` have no MCP arm and get the empty array.

**Shape:**

```typescript
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}

export class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  command: Schema.String,
  /** The process exit code, or `null` when the process never started. */
  exitCode: Schema.NullOr(Schema.Int)
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

export class StoreConfigInvalid extends Schema.TaggedError<StoreConfigInvalid>()(
  "StoreConfigInvalid",
  {
    path: Schema.String,
    reason: Schema.String
  }
) {}

export class V1DoorClosed extends Schema.TaggedError<V1DoorClosed>()("V1DoorClosed", {
  door: Schema.String,
  mode: Schema.String,
  session: Schema.NullOr(Schema.String)
}) {}
```

**Assumptions consumers make:**

- Consumers assume the payload carries no driver text, no SQL, and no memory body, so the whole payload is safe to return to an agent. `packages/contracts/src/errors.ts:3-8` states that the driver's own message goes to `Effect.logError` at the adapter edge instead, `packages/contracts/src/errors.ts:13-17` says the same of git's argv and stderr, and `apps/cli/src/errors.ts:104-112` relies on that by naming only actionable fields in its human message.
- Two consumers assume the tag set is open and handle an unknown tag rather than failing. `apps/cli/src/errors.ts:99-100` returns `ERR_UNKNOWN` from a `default` arm, and `apps/mcp/src/failure.ts:146-147` returns an empty suggestion array.
- `apps/cli/src/errors.ts:113-163` assumes every payload field it reads may be absent or the wrong type at runtime, and guards each with `text(...) ?? "<fallback>"` because the value arrives as `unknown` through the `TaggedError` interface at `apps/cli/src/errors.ts:17-20`.
- `apps/cli/src/errors.ts:42-102` assumes nine tags declared outside `packages/contracts/src/errors.ts` arrive with the same `_tag` shape: `EmbedModelMismatch`, `IndexStale`, and `RebuildNoEmbedRefused` (plain classes at `packages/index/src/indexer.ts:159`, `:181`, `:199`), `DiscriminationFailed` (`packages/eval/src/run.ts:167`), `HeadGateFailed` (`packages/head/src/gate.ts:264`), `CuratorModelSpecInvalid` (`packages/curator/src/errors.ts:7`), `IntegrationModified` (`packages/integrations/src/errors.ts:8`), `HeadServerRunning` (`apps/cli/src/head-protocol.ts:837`), and `HeadSocketPathTooLong` (`apps/cli/src/head-protocol.ts:852`). The header comment at `apps/cli/src/errors.ts:33-41` still says `GitFailure` lives in `@memhtml/store`; it moved to the contracts package so the session package raises the same class (`packages/contracts/src/errors.ts:19-23`).
- `apps/mcp/src/failure.ts:59-65` assumes the CLI's suggestions are unusable inside an MCP call, because they name shell commands an agent holding only tools can't run, and maintains a deliberately parallel mapping.

**Drift risk:** Adding an error class silently degrades it to `ERR_UNKNOWN` at the CLI edge and to zero suggestions at the MCP edge, so an agent receives a documented but uninformative code rather than a crash. `LlmContractViolation` is a live instance. It has a `messageFor` arm and no `codeFor` arm. Mitigation: when adding a class, add its arm to `codeFor`, `messageFor`, the walkable `SUGGESTIONS` record (`apps/cli/src/errors.ts:188-270`), and `mcpSuggestionsFor` in the same change, and add its code to `ERROR_CODES` at `apps/cli/src/envelope.ts:110-161`.

## The edge vocabulary and its derived class

This module declares four edge classes that don't mix, four rel vocabularies, and one total function from a rel to its class. It's imported by 14 non-test files across 4 packages and 2 apps, and the SQL restates the same vocabularies as CHECK constraints.

**Producer:** `packages/contracts/src/edges.ts:9-149`

**Consumer(s):**

- `packages/store/src/store.ts:4` imports `EdgeRel` and `relClassFor`; the store calls `relClassFor` at `packages/store/src/store.ts:1285` to decide which endpoint rule to enforce.
- `packages/index/src/project.ts:1` imports `relClassFor` and writes its result into the `edge_class` column at `packages/index/src/project.ts:366-368`.
- `packages/html/src/serialize.ts:1` imports `relTokenFor` to emit the `<link rel>` wire token.
- `packages/html/src/parse.ts:1` imports `relForToken`; `packages/html/src/parse.ts:285-286` drops a link whose token is outside the vocabulary.
- `packages/html/src/constraints.ts:1` imports `relForToken`; `packages/html/src/constraints.ts:319-321` reports the same token as a violation.
- `packages/html/src/document.ts:1` imports `EdgeRel` as the type of `MemoryLink.rel`.
- `packages/html/src/template.ts:1` imports `EdgeRel` alone, as the type of a `NewMemoryInput` link (`packages/html/src/template.ts:58`); `packages/html/src/editors.ts:1-2` imports `EdgeRel`, `relForToken`, and `relTokenFor`.
- `packages/head/src/overlay.ts:2` imports `isEdgeRel`, so a session view refuses a `link` or `unlink` whose rel is outside the vocabulary; `packages/session/src/validate.ts:7` reads the same predicate through the root `@memhtml/contracts` barrel for the commit's own check.
- `apps/cli/src/doctor.ts:4` imports `EdgeRel` and `isEdgeRel`, and `apps/cli/src/repair.ts:1` imports `EdgeRel` for the head edits `doctor --fix` applies.
- `apps/cli/src/operations.ts:1` imports `isEdgeRel`, `MEMORY_RELS`, `relClassFor`, `TASK_RELS`; `apps/cli/src/operations.ts:1301` filters to memory-class rels.
- `apps/cli/src/commands.ts:1` and `apps/mcp/src/tools.ts:15` import `MEMORY_RELS` to build the authorable-rel enum; `apps/mcp/src/tools.ts:62` turns it into `Schema.Literals(MEMORY_RELS)`.
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

- The indexer assumes `relClassFor` is total, so it writes the result straight into a NOT NULL column with no fallback (`packages/index/src/project.ts:366-368`). Totality comes from `relClassFor`'s final `return "provenance"` rather than from a check.
- The two HTML consumers handle an unknown rel token differently, on purpose. The parser drops it so the file still parses (`packages/html/src/parse.ts:285-286`), while the constraint checker reports it (`packages/html/src/constraints.ts:319-321`).
- The store assumes it's the only module that can see both endpoints' memory types, so it checks the endpoint rule that SQL can't check. `packages/store/src/store.ts:1279-1311` rejects a memory-class rel touching a task file, and rejects a task-class rel touching a non-task. `packages/store/src/store.ts:299-300` states that the `edges` CHECK can't read the endpoints' types at all.
- Every memory-graph query assumes `edge_class = 'memory'` is enough to keep a person or task edge out of the memory graph (`packages/contracts/src/edges.ts:3-8`, restated at `packages/index/migrations/0008_tasks.sql:177-181`).
- `packages/index/src/project.ts:349-350` assumes a self-loop must be dropped at projection time rather than sent to the driver (the drop is at `packages/index/src/project.ts:361`), because the table's `CHECK (src_path <> dst_path)` at `packages/index/migrations/0008_tasks.sql:193` would reject the whole write batch over one hand-authored file.
- `relTokenFor` and `relForToken` assume the underscore-to-hyphen mapping is injective on the vocabulary (`packages/contracts/src/edges.ts:109-120`). No rel in `ALL_RELS` contains a hyphen, so the inverse is unambiguous.

**Drift risk:** Adding a rel to a class in TypeScript without widening the matching SQL CHECK makes every write carrying that rel fail at the driver. Because `writeAll` is one transaction (`packages/index/src/database.ts:74-75`), one new rel fails the whole batch. Mitigation: add the rel and its migration in the same change, following the recreate-and-copy pattern at `packages/index/migrations/0008_tasks.sql:173-209`.

## The path algebra

This module provides placement, archival, and normalization as pure total functions over repo-root-relative paths. It has 16 non-test importers across 4 packages and 2 apps, and it's the only module that decides where a memory lands in the root.

**Producer:** `packages/contracts/src/paths.ts:10-238`

**Consumer(s):**

- `packages/store/src/store.ts:12-19` imports six names: `archivePathFor`, `isValidMemoryPath`, `memoryPathFor`, `memoryPathViolation`, `normalizePath`, and `PlacementInput`. `memoryPathViolation` (`packages/store/src/store.ts:16`) is the one the `strictPath` refusal quotes at `packages/store/src/store.ts:707-720`.
- `packages/store/src/layout.ts:5` imports `ARCS_DIR`, `INBOX_DIR`, `PEOPLE_DIR` and puts all three in `SCAFFOLD_DIRS` (`packages/store/src/layout.ts:41-48`).
- `packages/index/src/indexer.ts:6` imports `MEMORY_EXTENSION` and `normalizePath`.
- `packages/index/src/project.ts:2` imports `normalizePath` and `paraBucketOf`; `packages/index/src/project.ts:360` normalizes a link's `href` before storing it as `dst_path`.
- `packages/head/src/record.ts:4` imports `ARCHIVE_BUCKET`, which decides a record's `archived` flag, and `packages/head/src/version.ts:3` imports `MEMORY_EXTENSION` for `isCandidatePath`.
- `packages/session/src/validate.ts:2-15` reads `isArchivePath`, `memoryPathViolation`, `normalizePath`, `originalPathFor`, `pathToHref`, and `hrefToPath` through the root barrel, so a session's archive op is judged by the same inverse the store's archive writes.
- `packages/eval/src/corpus.ts:1` imports `PEOPLE_DIR`.
- `apps/cli/src/session-exec.ts:6` imports `memoryPathViolation` and `originalPathFor` to turn a sandbox's file moves into `archive` and `move` ops; `apps/cli/src/replay.ts:2` imports `originalPathFor` to rebuild a curator branch's archives; `apps/cli/src/v2.ts:12` imports `isValidMemoryPath` and `memoryPathFor` for `session put`; `apps/cli/src/detected-tasks.ts:3` imports `placementFor`.
- `apps/cli/src/doctor.ts:5` imports `INBOX_DIR`, `normalizePath`, and `TASKS_SUBDIR`.
- `apps/cli/src/repair.ts:3` imports `archivePathFor` and `normalizePath`, and `apps/cli/src/operations.ts:3` and `apps/cli/src/head-scope.ts:2` import `normalizePath`.
- `apps/mcp/src/resources.ts:2` imports `isValidMemoryPath` and `normalizePath`.

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

  if (input.workspace !== undefined && input.workspace !== "") {
    return `projects/${slugify(input.workspace)}`
  }

  const primaryTag = (input.tags ?? []).find((tag) => tag.trim() !== "")
  if (RESOURCE_TYPES.includes(input.memoryType) && primaryTag !== undefined) {
    const topic = `resources/${slugify(primaryTag)}`
    // A tag that slugs to `people` names the person plane, which no rule routes into.
    if (topic !== PEOPLE_DIR) return topic
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

- Every caller assumes `placementFor` never fails and never returns a directory outside a PARA bucket, so the write path doesn't guess twice (`packages/contracts/src/paths.ts:132-147`). An unusable explicit `path` is ignored rather than propagated, which is how totality is preserved.
- No rule routes into `resources/people/`, and a tag that slugs to `people` falls through to the inbox (`packages/contracts/src/paths.ts:181-184`). `packages/contracts/src/paths.ts:166-174` states why. A person record is a place written by a curator under the `curate` scope, and inside a run that path is reserved, so a routing rule that sent a fact there would produce a write the session validator refuses (`packages/session/src/validate.ts:75`, `:87-97`). `PlacementInput.entities` is still accepted and read by no rule.
- `packages/store/src/layout.ts:35-48` assumes the three directory constants `placementFor` can return already exist on disk, so `memhtml init` creates all of them and an agent's first write lands somewhere real.
- `packages/index/src/project.ts:344-347` assumes the leading slash in a link's `href` must be stripped before it becomes a `dst_path`, because the `edges` table stores the git-tree form and a slashed value would fail to join `files.path` while looking exactly like a corpus with no edges.
- A caller that wants an invalid path rejected instead of re-derived asks the store for it, with `strictPath` on a `WriteInput` (`packages/store/src/store.ts`, `strictPathRefusal`).
- `packages/index/src/project.ts:371-375` re-implements the archive-path inverse as a local `originOf` instead of importing `originalPathFor`, so two copies of the same regex exist. Both match `^archive\/\d{4,}\/(.+)$`.
- `PlacementInput` allows `| undefined` on every optional field. `packages/contracts/src/paths.ts:115-121` states that under `exactOptionalPropertyTypes` a bare `path?: string` would force every tool adapter to strip absent fields by hand, so the contract accepts the shape the MCP and CLI layers already hold.

**Drift risk:** Adding a routing rule to `placementFor` changes where new memories land without moving anything already in the root, so the same logical memory can sit in two directories depending on when it was written. Mitigation: treat a rule change as needing a migration pass over the root, and check inbox depth through `memhtml doctor`, which already reports it as a health signal (`packages/contracts/src/paths.ts:18-21`).

## The memory type vocabulary, restated in SQL

This module declares ten memory types, nine of which an agent may write, and the SQL restates the same list as a CHECK constraint. It has 13 non-test importers across 4 packages and 2 apps, plus two migrations.

**Producer:** `packages/contracts/src/types.ts:18-82`, with the entity helpers at `packages/contracts/src/types.ts:114-196`

**Consumer(s):**

- `packages/index/src/scope.ts:1` imports `MEMORY_TYPES` and `MemoryType`; the scope's `memoryTypes` field is typed by it (`packages/index/src/scope.ts:131`).
- `packages/html/src/document.ts:2-8` imports `MemoryType`, `MemoryStatus`, `TaskStatus`, `Confidence`, `Importance` into `MemoryMetas` (`packages/html/src/document.ts:29-83`).
- `packages/html/src/template.ts:2` imports four of them, `Confidence`, `Importance`, `MemoryType`, and `TaskStatus`, for `NewMemoryInput`; `MemoryStatus` isn't imported there.
- `packages/html/src/parse.ts:9` imports from it to decode the head's metas.
- `packages/index/src/indexer.ts:7` and `packages/store/src/layout.ts:6` import `PARA_BUCKETS`.
- `packages/store/src/index.ts:16` re-exports `PARA_BUCKETS` and `ParaBucket` rather than restating them.
- `packages/head/src/overlay.ts:4` imports `isWellFormedEntity`, so a session's `label` op with a malformed entity fails at the overlay (`packages/head/src/overlay.ts:96-98`), and `packages/index/src/project.ts:3` imports `parseEntity` for the entity rows (`packages/index/src/project.ts:327`).
- `apps/cli/src/head-scope.ts:3` imports `MEMORY_TYPES` and keeps only the known names in a head scope's type filter (`apps/cli/src/head-scope.ts:107-110`).
- `apps/mcp/src/tools.ts:16` imports `PARA_BUCKETS` and `WRITABLE_MEMORY_TYPES`; `apps/mcp/src/tools.ts:59` becomes `Schema.Literals(WRITABLE_MEMORY_TYPES)` and `apps/mcp/src/tools.ts:919` becomes `Schema.Literals(PARA_BUCKETS)`.
- `apps/cli/src/commands.ts:3` imports `MEMORY_TYPES`, `TASK_STATUSES`, and `WRITABLE_MEMORY_TYPES` for the flag enums.
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

- The agent surface (`apps/mcp/src/tools.ts:59`) derives its enum as the storage vocabulary minus `arc`; the CLI is the operator surface and admits the full set (`apps/cli/src/commands.ts:3`, issue #88). The comment above the MCP enum at `apps/mcp/src/tools.ts:58` says "The eight types an agent may write" over a nine-entry `WRITABLE_MEMORY_TYPES`. The array is right and the comment's count is stale. `packages/contracts/src/types.ts:34-37` says `arc` is system-written only, and `apps/mcp/src/tools.ts:58` names a curator as the writer, so an agent's tool enum leaves it out.
- Retrieval assumes `task` is the one type an unscoped query doesn't see, and names it as a single constant so three copies of the string can't drift (`packages/index/src/scope.ts:211-218`). `packages/index/src/scope.ts:122-130` states that a corpus with fifty open to-do items would otherwise crowd out the knowledge an agent asked for.
- `packages/html/src/document.ts:69-74` assumes `taskStatus` is present if and only if `memoryType` is `task`, and the parser reports a violation either way round. `packages/index/migrations/0008_tasks.sql:66-72` admits NULL in the `task_status` CHECK so one column serves both cases.
- The dedup index assumes tasks are exempt from content deduplication. `packages/index/migrations/0008_tasks.sql:119-127` adds `AND memory_type <> 'task'` to the partial unique index, so two open tasks may share a body while two memories may not.
- `packages/contracts/src/types.ts:58-62` assumes `archive` is a bucket rather than a status, so eviction is a `git mv` and the path itself records the state. `git log --follow` reads through it and `diff -M` reports the move as `R100`.

**Drift risk:** Widening the TypeScript vocabulary without the matching migration makes every write of the new type fail at the CHECK. The migration is expensive. `packages/index/migrations/0008_tasks.sql:1-2` states that adding `task` as the tenth type required a full recreate-and-copy of both `files` and `edges`, because SQLite can't ALTER a CHECK constraint. Mitigation: budget a recreate-and-copy migration for any vocabulary widening, and copy the pattern at `packages/index/migrations/0008_tasks.sql:30-140`.

## `DatabaseShape`

This is the one interface between every SQL-writing module and the driver. 17 non-test source files reference it, counting its declaring file, which makes it the most widely referenced service interface in the repo. The v2 head doesn't use it. It reads git and its own snapshot files, and the index serves v1 commands only.

**Producer:** `packages/index/src/database.ts:54-93`

**Consumer(s):**

- `packages/index/src/retrieval.ts:5,204-205` takes it as `RetrievalDeps.db`.
- `packages/index/src/indexer.ts:11` takes it as an indexer dependency.
- `packages/index/src/traces-persist.ts`, `packages/index/src/index-state.ts`, and `packages/index/src/reinforce.ts` all reference it, and `packages/index/src/sidecar.ts:44` and `packages/index/src/vector-coverage.ts:100` take it as their first argument.
- `packages/eval/src/harness.ts` references it.
- `apps/cli/src/api-layer.ts` wires it, and `apps/cli/src/operations.ts`, `apps/cli/src/views.ts`, `apps/cli/src/doctor.ts`, `apps/cli/src/hook.ts:5`, `apps/cli/src/artifacts.ts:32`, and `apps/cli/src/repair.ts:86`, `:98` consume it.
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

- Every caller of `get` and `all` supplies its own row type parameter `A` and assumes the driver's rows match it, because there's no runtime decode at this boundary. `apps/cli/src/repair.ts:72-76` declares `DanglingEdge` with snake_case column names and hands it to `all<DanglingEdge>` (`apps/cli/src/repair.ts:88`), so a column rename becomes a silent `undefined` and never a type error.
- `packages/index/src/project.ts:379-387` assumes `writeAll` is one transaction and therefore deduplicates rows before sending them, because a duplicate primary key from one file with a repeated `<dt>`/`<dd>` pair would roll back every other row in the batch.
- `packages/index/src/indexer.ts` assumes it must split a whole-store pass into batches instead of sending one transaction. `packages/index/src/schema-const.ts:81-89` sets `WRITE_BATCH_SIZE` at 500 and states the reason, which is to bound how much work a single failure discards and how long one write holds the WAL write lock.
- Callers assume a concurrent writer blocks rather than fails. `packages/index/src/database.ts:13-22` sets a 5000 ms busy timeout and states that many short-lived CLI invocations plus a long-lived MCP server run against one store and serialize by waiting.
- Retrieval assumes the connection has `vector_distance_cos` registered, and that it computes the same arithmetic as the TypeScript MMR pass. `packages/index/src/database.ts:24-52` registers it from `@memhtml/domain`'s `cosineDistance` (registration at `:45-52`) and states at `:28-30` that two copies of the arithmetic could disagree about a clamp or a zero-magnitude vector while both looked right.
- Cross-plane callers assume `hasState` before qualifying a query with the `state` schema, because `state.db` is ATTACHed rather than always present (`packages/index/src/database.ts:91-92`).

**Drift risk:** A column rename in a migration passes type-check everywhere, because the row types are declared at the call sites and never checked against the schema. Mitigation: `packages/index/src/schema-const.ts:1-5` names identifiers the SQL and the TypeScript both use so a table rename is a compile error at every reader; extend that pattern to a column when one starts drifting.

## `MemoryDoc` and the parse output

`MemoryDoc` is the parsed form of a memory file, and the boundary between the format package and both read paths, the v1 index and the v2 head. The format package owns the name because a change to the HTML vocabulary changes this shape.

**Producer:** `packages/html/src/document.ts:29-220`

**Consumer(s):**

- `packages/index/src/project.ts:5` imports `MemoryDoc` and projects it onto rows; `packages/index/src/project.ts:359` reads `doc.links`, and `packages/index/src/project.ts:336` reads `doc.article.codeLangs`.
- `packages/index/src/indexer.ts:8` imports `parseMemory` and `contentHash`, then calls both at `packages/index/src/indexer.ts:305-317`.
- `packages/head/src/record.ts:6` imports `parseMemory` and `contentHash`, and `recordFrom` maps the parsed document onto a `MemoryRecord` field by field (`packages/head/src/record.ts:34-63`).
- `packages/session/src/validate.ts:16` and `packages/session/src/commit.ts:7` import `parseMemory`, so a session's ops are judged and applied against the same parse the head reads.
- `apps/cli/src/session-exec.ts:7` imports `MemoryDoc` and compares the metas, tags, and aliases of a sandbox's edited file against the original (`apps/cli/src/session-exec.ts:277`).
- `packages/store/src/store.ts:21` imports `MemoryDoc` as `ReadResult.doc` (`packages/store/src/store.ts:153-157`).
- `apps/mcp/src/handlers.ts:32` imports `MemoryDoc`.
- `packages/html/src/parse.ts:385` declares `parseMemory` returning it.

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
  aliases: Schema.Array(Schema.String),
  links: Schema.Array(MemoryLink),
  article: ArticleExtractions,
  /**
   * Vocabulary warnings, such as an element outside the closed vocabulary or a `<div>` outside
   * a `<figure>`. Format constraint 6: the file still parses and still indexes, so a
   * hand-authored file degrades gracefully instead of being refused.
   */
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

- The indexer assumes a parse failure is a counted skip rather than a fatal error, so one bad file doesn't stop the tree. `packages/index/src/indexer.ts:305-317` wraps `parseMemory` in `Effect.result`, and `packages/index/src/indexer.ts:35-48` types the skip list on `RebuildReport`.
- The indexer assumes the field names are its own, so no translation layer exists. `packages/html/src/document.ts:125-128` states that `ArticleExtractions` field names are the indexer's, and `packages/index/src/project.ts` consumes the struct directly.
- Consumers assume an absent meta means the file didn't state it, never a substituted default. `packages/html/src/document.ts:20-24` states that the `files` table owns the defaults and a parser inventing `confidence: 1.0` would make a hand-authored omission indistinguishable from a deliberate assertion. `packages/index/migrations/0008_tasks.sql:48-49` holds those defaults.
- Consumers assume `href` carries a leading slash and `dst_path` doesn't. `packages/html/src/document.ts:88-93` states the conversion is `normalizePath` applied at the store boundary, and `packages/index/src/project.ts:360` performs it.
- The indexer assumes `article.html` is a serialization fixed point, because the content hash is computed from it. `packages/html/src/document.ts:130-134` states that re-parsing and re-serializing it yields the same bytes, and `packages/index/src/indexer.ts:311` hashes it.
- Consumers assume `metas.contentHash` is advisory and may disagree with the computed hash. `packages/html/src/document.ts:38-43` states the parser reports it verbatim and never repairs it, so a stale value is visible to `memhtml doctor`.
- Consumers assume `warnings` is non-fatal by construction, so a hand-authored file with an out-of-vocabulary element still parses and still indexes (`packages/html/src/document.ts:213-218`).

**Drift risk:** Adding an extraction field to `ArticleExtractions` leaves the projection ignoring it, so the new field reaches no SQL column and no search arm while the type checks clean. Mitigation: add the field, the migration, and the `projectFile` write in one change, and assert the round trip in the reproducibility test at `tests-integration/tests/rebuild.test.ts:205-227`.

## `StoreShape` and the write surface

`StoreShape` declares every operation that changes the corpus in the root, and each operation produces exactly one git commit. Every write in the system goes through this interface.

**Producer:** `packages/store/src/store.ts:226-318`, with `WriteInput` at `packages/store/src/store.ts:56-87` and `WriteResult` at `packages/store/src/store.ts:89-106`

**Consumer(s):**

- `apps/cli/src/api-layer.ts:59` re-exports the `Store` tag and the layer wires it, making `apps/cli` the composition root for both apps.
- `apps/cli/src/operations.ts:42` imports `Store` and calls the write methods behind every v1 CLI command. `apps/cli/src/operations.ts:2024` is the one caller of `store.exclusive`. A task status change writes, stages, and commits as the store's one writer, so it holds the checkout lock a session commit also takes.
- `apps/mcp/src/handlers.ts:1-30` imports the CLI's operations from `@memhtml/cli`, so every MCP write reaches the same methods through `apps/cli/src/operations.ts`. `apps/mcp/src/resources.ts:285` and `:570` take `Store` directly for reads.
- `apps/cli/src/doctor.ts:570` takes `Store` for its health checks.
- `tests-integration/tests/contracts.test.ts:35-70` asserts the dedupe behavior through the shipped CLI, which is the store's contract observed from outside.

The session package doesn't depend on the store (`packages/session/package.json` lists no `@memhtml/store`). A session commit lands through its own git plumbing and meets the store only at the checkout lock, which the section on sessions describes.

**Shape:**

```typescript
export type WriteInput = NewMemoryInput &
  WriteProvenance & {
    /**
     * An explicit path override. Re-derived through the placement rule when it is not a usable
     * memory path unless {@link strictPath} is set, and refused with `WriteConflict` when a file
     * already sits there: nothing in this corpus is overwritten, so a revision is `correctMemory`
     * (which archives the file it replaces) and never a second write to the same path.
     */
    readonly path?: string | undefined
    readonly strictPath?: boolean | undefined
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
  /**
   * Run `effect` as this store's one writer: the in-process permit every write below takes, then the
   * repository's checkout lock (`withCheckoutLock`), which a session commit and every other process's
   * store take too. For a caller that stages and commits through {@link git} itself (a task status
   * change), so its `git add` and `git commit` cannot interleave with another writer of the shared
   * index. Not reentrant on the permit: `effect` must not call a write method of this store.
   */
  readonly exclusive: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | StorageFailure, R>
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
  /** Fail with `DirtyTree` unless the working tree is clean. What a curation pass calls before it starts. */
  readonly requireCleanTree: () => Effect.Effect<void, StoreError>
  readonly mergeBranch: (commitish: string) => Effect.Effect<void, StoreError>
}
```

**Assumptions consumers make:**

- Callers assume one operation is one commit, and that the store owns staging. `packages/store/src/store.ts:39-45` states that a caller staging its own files could bundle two unrelated writes into one commit, which would stop `git log` from reading as a history and stop `diff base..HEAD` from being a reviewable unit. The example of a reviewable run in that comment comes from the removed v1 pipeline.
- Callers assume an explicit `path` is re-derived, never refused, unless they opt in with `strictPath` (`packages/store/src/store.ts:58-85`); with it set, `strictPathRefusal` at `packages/store/src/store.ts:707-720` fails with `InvalidMemory` quoting `memoryPathViolation`'s reason, and an occupied path is refused with `WriteConflict` either way.
- Callers assume `created` and `deduped` are mutually exclusive and that exactly one is true (`packages/store/src/store.ts:89-95`), so they branch on either.
- Callers assume `commitSha` is `null` exactly when nothing was written. `packages/store/src/store.ts:102-103` says so for a single write, and `packages/store/src/store.ts:131-147` for a batch.
- Batch callers assume the error channel means the batch mechanism failed, and never that a single op was rejected. `packages/store/src/store.ts:253-255` states that a rejected op is a `BatchOpResult` with `ok: false`, including in atomic mode, so a caller always gets its per-op array back.
- Batch callers assume the fold owns two properties rather than the caller. The fold produces one commit for N writes, and it assigns paths without collisions. `packages/store/src/store.ts:248-251` states that `freePathFor` reads disk and can't see a path an earlier op in the same batch has claimed but not written.
- Batch callers assume `skipped` is distinct from a failure, because retrying a skipped op is correct and retrying a failed one isn't (`packages/store/src/store.ts:113-115`).
- Callers assume the dedupe question is asked before any file is written, so a duplicate leaves the tree byte-identical with nothing to roll back. `tests-integration/tests/contracts.test.ts:55-69` asserts that against git itself rather than only against the report.
- The store assumes dedupe knowledge is injected rather than owned, because the package is SQL-free by design. `packages/store/src/store.ts:189-199` declares `DedupeLookup` as a function and states that the store's only knowledge is that a non-null answer means don't write.
- The store assumes a path move needs an explicit callback, because cross-database foreign keys don't exist. `packages/store/src/store.ts:201-209` declares `MoveCallback` as how `state.access.path` follows an archive.
- A caller of `exclusive` assumes the effect it passes calls no write method of the same store, because the in-process permit isn't reentrant (`packages/store/src/store.ts:229-235`). `apps/cli/src/operations.ts:2024-2029` keeps to that by staging and committing through `store.git` alone.
- Three methods have no caller outside the store's own tests: `supersedeMemories`, `requireCleanTree`, and `mergeBranch`. The doc comments at `packages/store/src/store.ts:275-290` and `:309` still describe callers in the removed v1 batch pipeline and in a curation preflight, and neither calls them at 0.16.0. A change to their behavior reaches no shipped path.

**Drift risk:** Adding a method that writes without committing, or splitting an existing one-commit operation into two, breaks rollback and stops `diff base..HEAD` from being a reviewable unit. Mitigation: `packages/store/src/store.ts:262-269` states the one-commit rule for corrections, and `packages/store/src/store.ts:241-256` states it for batches. Hold any new operation to the same rule and assert the commit count in the integration tier.

## `GitPort` against the store's `GitShape`

The indexer declares its own read-only view of git instead of importing the store's client, and one adapter bridges them. No other contract in the repo ships a written analysis of why its two sides don't fit together directly. The v2 head takes the other route and imports the store's `GitShape` directly (`packages/head/src/version.ts:4`), which the section on the head describes.

**Producer:** `packages/index/src/git-port.ts:17-82` for the port, and `packages/index/src/git-adapter.ts:34-88` for the store's side as the indexer declares it (`StoreGitShape`, `StoreTreeEntry`, `StoreChangedPath`, `StoreStatusEntry`, `GitAdapterDeps`)

**Consumer(s):**

- `packages/index/src/indexer.ts:12` imports `GitPort` as an indexer dependency.
- `packages/index/src/git-adapter.ts:3` imports `DiffEntry`, `GitPort`, `StatusEntry`, `TreeEntry` and `makeGitPort` at `packages/index/src/git-adapter.ts:148` builds a `GitPort` from the store's side.
- `packages/index/src/index.ts:32-43` publishes both the port and the adapter as the package's git surface.
- `apps/cli/src/api-layer.ts:148-156` supplies the production adapter, binding the store's git client to the port.

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
  /**
   * The source of a staged rename, carried so the indexer can retire the source row. A staged
   * `git mv` is one status entry whose `path` is the destination; without the source, the old row
   * stays active and the destination's projection collides with it on `files_content_hash_active`.
   */
  readonly fromPath?: string | undefined
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

The indexer re-declares the store's side instead of importing it. That declaration, at `packages/index/src/git-adapter.ts:33-49`, is the second half of the contract.

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

- The indexer assumes every port method is read-only, so an index can't commit. `packages/index/src/git-port.ts:11-14` states that an index that could commit would make "rebuildable from git" circular.
- The indexer assumes `revParseHead` returns a commit, never `null`. The adapter turns an unborn HEAD into a typed failure at `packages/index/src/git-adapter.ts:167-180`, and `packages/index/src/git-adapter.ts:167-172` states that letting `null` through would surface as an opaque `git diff null HEAD` error.
- The indexer assumes `catFileBatch` yields text. The adapter decodes UTF-8 at `packages/index/src/git-adapter.ts:200-206`.
- The indexer assumes a `copied` entry isn't a rename. `packages/index/src/git-adapter.ts:113-118` maps it to `A` and states that `R` would make the indexer move the source's row to the destination and drop a live file from the index.
- The indexer assumes a rename carries `fromPath`, which is how the embedding survives an archive move. `packages/index/src/git-adapter.ts:106-112` downgrades a source-less rename to `A` rather than moving a row out from under an unknown path.
- The indexer assumes an `ignored` or `unmerged` status entry isn't a change. `packages/index/src/git-adapter.ts:122-130` drops both and states that indexing either side of an unresolved merge would record a state the tree doesn't agree on.
- The indexer assumes a missing file is a counted skip and never a crash. `packages/index/src/git-adapter.ts:149-164` uses `Effect.catchCause` rather than `Effect.catch` so a defect from a `readFile` wired with `Effect.promise` can't kill the fiber, and `packages/index/src/git-adapter.ts:74-81` states that an agent listing a path it just archived is the normal case.
- The adapter assumes a submodule entry has no blob behind it and drops it, keeping every sha in the batch resolvable (`packages/index/src/git-adapter.ts:187-193`).
- Both sides assume the tags must differ. `packages/index/src/git-port.ts:77-82` uses `memhtml/IndexGit` because `@memhtml/store` already publishes `memhtml/Git`, and two shapes under one tag would let a layer satisfy the wrong requirement without an error.

**Drift risk:** Adding a `kind` to the store's `StoreChangedPath` or `StoreStatusEntry` union breaks the adapter's exhaustive switches at compile time, which is the intended behavior. Changing the meaning of an existing kind produces no compile error. Mitigation: `packages/index/src/git-adapter.ts:90-95` and `:122-129` export `toDiffEntry` and `toStatusEntry` so the mapping is assertable without a repository, and names `copied` as the case that would corrupt the index and is awkward to provoke from real git.

## The CLI JSON envelope and exit codes

This is the machine contract an agent parses. It declares two envelope shapes, the response discriminators, the error codes, and 3 exit codes, and all of those lists are append-only. The counts are deliberately not restated here, because an append-only list grows and a number beside it in prose is a number nothing re-derives.

The integrations family appended to both lists. `RESPONSE_TYPES` gained five discriminators, `integrations.report`, `integrations.list`, `integrations.doctor`, `integrations.shell`, and `hook.output` (`apps/cli/src/envelope.ts:51-59`), and `ERROR_CODES` gained three codes. `ERR_UNKNOWN_HOST` and `ERR_UNKNOWN_HOOK_EVENT` are usage errors at exit 2 because the fix is on the command line, and `ERR_INTEGRATION_MODIFIED` is a runtime refusal at exit 1 because a receipt-owned file doesn't match its receipt (`apps/cli/src/envelope.ts:137-144`). The same comment records the two deliberate exceptions to the one-envelope rule. `help` on a terminal prints Markdown, and a successful `memhtml hook` prints the host's hook protocol in place of this envelope. Its usage errors still arrive as the failure envelope, which is why `hook.output` is declared at all (`apps/cli/src/envelope.ts:52-54`).

The v2 families appended again. `RESPONSE_TYPES` gained the session family (`session.started`, `session.appended`, `session.exec.report`, `session.committed`, `session.status`, `session.rebased`), the head family (`head.status`, `head.search`, `head.snapshot`, `head.served`, `head.embedded`), the curation family (`curate.merged`, `curate.run`, `curate.collapse`), `config.report`, and `session.pruned` (`apps/cli/src/envelope.ts:60-87`). `ERROR_CODES` gained four codes (`apps/cli/src/envelope.ts:145-160`). `ERR_HEAD_SERVER_RUNNING` and `ERR_STORE_CONFIG` are runtime refusals at exit 1, and `ERR_SESSION_BOUND` and `ERR_V1_DOOR_CLOSED` are usage codes at exit 2 because the fix is a different call. Four discriminators near the top of the list belong to the removed v1 batch pipeline, and no command answers them. They stay because the list is append-only, and a parser that learned them keeps parsing (`apps/cli/src/envelope.ts:20-23`, `:36`, `:49`).

**Producer:** `apps/cli/src/envelope.ts:6-235`

**Consumer(s):**

- `apps/cli/src/run.ts:42-53` imports the exit codes and pairs each envelope with one; `apps/cli/src/run.ts:1577-2428` emits every command's response (the exported `run` starts at `apps/cli/src/run.ts:1684`).
- `apps/cli/src/errors.ts:2` imports `ErrorCode`, `Failure`, `fail` and produces the failure envelope in `failureFor` at `apps/cli/src/errors.ts:277-279`.
- `apps/cli/src/agents-doc.ts:9` imports `API_VERSION`, `ERROR_CODES`, and all three exit codes, and writes them into the generated agent documentation at `apps/cli/src/agents-doc.ts:132-151` and `apps/cli/src/agents-doc.ts:210`.
- `apps/mcp/src/failure.ts:1` imports `codeFor` and `messageFor` from `@memhtml/cli`, so the MCP server reports the same code vocabulary (`apps/mcp/src/failure.ts:34-36`).
- `tests-integration/tests/harness.ts:139-148` parses the envelope for every integration assertion. `body.error !== undefined` is the failure test and `body.data` is the payload.
- `packages/index/src/retrieval.ts:133-144` cites `apps/cli/src/envelope.ts` by line to explain why `scopeEmpty` is always a boolean; the line it names (`:139`, at `packages/index/src/retrieval.ts:137`) is inside the integrations comment of `ERROR_CODES`, and `stripNulls` sits at `apps/cli/src/envelope.ts:218-232`.

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
  // A positional past what the command declares. Distinct from `ERR_INVALID_FLAG` because the
  // offending token is not a flag, and distinct from `ERR_MISSING_ARGUMENT` because it is surplus
  // rather than absent: the caller drops a word instead of adding one.
  "ERR_UNEXPECTED_ARGUMENT",
  // The call opens a repo, names none with `--repo`, and `MEMHTML_REFUSE_ENV_ROOT` forbids reading
  // one from the environment. A usage code, since the fix is on the line rather than in the store.
  "ERR_REPO_REQUIRED",
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
  "ERR_UNKNOWN",
  // `index rebuild --no-embed` over a store that carries vectors in the configured space, without
  // `--force`. Exit 1: the call parsed, and the work was declined. Appended after `ERR_UNKNOWN`
  // because the list is append-only and AGENTS.md prints it in this order.
  "ERR_REBUILD_NO_EMBED_REFUSED",
  // The integrations family. `ERR_UNKNOWN_HOST` and `ERR_UNKNOWN_HOOK_EVENT` are usage errors (exit 2):
  // the host or event named on the command line is outside the closed vocabulary, and the fix is on
  // the command line. `ERR_INTEGRATION_MODIFIED` is a runtime refusal (exit 1): a file or config entry
  // the receipt owns no longer matches it, so install without --force and uninstall both stop rather
  // than overwrite a change a human made.
  "ERR_UNKNOWN_HOST",
  "ERR_UNKNOWN_HOOK_EVENT",
  "ERR_INTEGRATION_MODIFIED",
  // `head serve` found a live server on the store's socket. Exit 1: the call parsed, and the store
  // already has its server; stop that one (the message names its pid) or use it.
  "ERR_HEAD_SERVER_RUNNING",
  // A v1 door that creates a record (`write`, `apply`, `correct`, `task add`) was called with
  // `MEMHTML_SESSION` set. Those doors commit with no write bar, and the process has a session to
  // write through, so the call is refused before anything opens. A usage code: the fix is on the line
  // (`session exec` or `session put`), not in the store.
  "ERR_SESSION_BOUND",
  // A v1 door that creates a record was called with no session set, and the store's
  // `memhtml.config.json` sets `v1Doors` to `closed`: records go in through sessions only. A usage
  // code, like ERR_SESSION_BOUND: the fix is on the line (start a session and put through it).
  "ERR_V1_DOOR_CLOSED",
  // The store's `memhtml.config.json` exists and cannot be read or does not decode (an unknown key,
  // a value of the wrong type, JSON that does not parse). Exit 1: the fix is in the store, and every
  // command that needs the policy refuses rather than running under the library defaults.
  "ERR_STORE_CONFIG"
] as const

/** Exit codes stay stable so a shell caller can branch without parsing output. */
export const EXIT_OK = 0
export const EXIT_USAGE = 2
export const EXIT_RUNTIME = 1
```

**Assumptions consumers make:**

- An agent is assumed to branch on `code` and never on the human `error` string. `apps/cli/src/envelope.ts:105-109` states that a code's meaning never changes and a code is never removed, while the prose changes freely as wording improves.
- A parser is assumed to read `type` before parsing `data`. `apps/cli/src/envelope.ts:1-11` states that a new payload shape gets a new discriminator rather than reusing one, so a discriminator's meaning is fixed once shipped.
- `apps/cli/src/errors.ts:169-176` assumes suggestions are part of the contract that a caller may rely on, and that absent suggestions arrive as an empty array rather than a null, so a parser never branches on presence.
- Payload shapes assume `--dense` drops null-valued keys, so a field that's null when absent disappears from the output an agent pastes into a prompt. `apps/cli/src/envelope.ts:218-232` implements `stripNulls`, and `packages/index/src/retrieval.ts:133-144` cites that behavior as the reason `scopeEmpty` is a boolean in every case.
- `apps/cli/src/errors.ts:178-187` assumes a suggestion string names a real command from the table in `apps/cli/src/commands.ts:185`, and enforces that with a walkable record instead of a switch (`apps/cli/src/errors.ts:188`) so the suite can run every suggestion through the real `parseArgv`. The same comment (`apps/cli/src/errors.ts:184-186`) states the import stays out of `apps/cli/src/errors.ts` because it would close an import cycle. The commands table imports from the operations module at `apps/cli/src/commands.ts:16`, and the operations module imports `codeFor` at `apps/cli/src/operations.ts:49`. The source comment at `apps/cli/src/errors.ts:185` gives older line numbers for both imports.
- The MCP server assumes only `.message` reaches the wire, so it folds code, reason, and suggestions into one string at construction. `apps/mcp/src/failure.ts:20-25` states that `code` and `suggestions` aren't wire fields because MCP's tool-error channel is one text block, and puts the code first behind a colon so a reader can recover it from the prefix.
- `apps/mcp/src/failure.ts:8-16` assumes a tool must declare a failure schema for its own message to reach the agent. `McpServer` has three catch branches and only one passes the message through. Without the declared schema the agent receives the string "Tool execution failed due to an internal server error".
- A shell caller is assumed to branch on the exit code without parsing output (`apps/cli/src/envelope.ts:165-168`). `apps/cli/src/run.ts:1081-1084` states the rule that holds it. A refusal returned by `validate` is emitted at `EXIT_USAGE` (`apps/cli/src/run.ts:1726`), and a failure raised inside `dispatch` goes through `failureFor` at `EXIT_RUNTIME`. The one exception is a `V1DoorClosed` raised inside `dispatch`, which `apps/cli/src/run.ts:2416-2421` still emits at `EXIT_USAGE`, so both of its codes exit 2 wherever the guard fires. A handler may return a third tuple element for a report whose failures are data (`apps/cli/src/run.ts:327-335`).

**Drift risk:** Reusing an existing `RESPONSE_TYPES` discriminator for a changed payload shape breaks every parser silently, since `apiVersion` stays `"1"` and the discriminator still matches. Mitigation: treat both lists as append-only as the file states, and add a new discriminator for any payload change that isn't purely additive.

## The retrieval surface

Search and recall over the projection, with the scope contract every arm receives and the hit shape an agent chains from.

**Producer:** `packages/index/src/retrieval.ts:55-202` and `packages/index/src/scope.ts:120-218`

**Consumer(s):**

- `apps/cli/src/operations.ts` calls `search` and `recall` behind the CLI commands.
- `apps/mcp/src/handlers.ts:581` and `:619` call the same two behind the MCP tools, as the fallback when the head server doesn't answer. The section on MCP search and recall describes that routing.
- `packages/index/src/retrieval.ts:22` imports `assembleScope` and `SearchScope` from the scope module, and `packages/index/src/retrieval.ts:56,176` extends `SearchScope` into both input types.
- `packages/index/src/index.ts:78-92,123-133` publishes `SearchInput`, `SearchHit`, `SearchResult`, `RecallInput`, `RecallPack`, `RetrievalShape`, `QueryEmbedPort`, `SearchScope`, `assembleScope`, `EXCLUDED_BY_DEFAULT`.
- `apps/cli/src/api-layer.ts` wires the `Retrieval` service.

**Shape:**

```typescript
export interface SearchScope {
  readonly memoryTypes?: ReadonlyArray<MemoryType> | undefined
  readonly workspace?: string | undefined
  /** ANY-of overlap. Each tag BROADENS the result set. */
  readonly tags?: ReadonlyArray<string> | undefined
  readonly entity?: string | undefined
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
  /**
   * True when the vector arm did not fire, so the result came from the lexical floor. Three causes:
   * no embedder is bound, the embedder failed, or `vectorCoverage` is below the floor and the arm was
   * dropped on purpose (a sparse plane ranks the embedded few above every lexical match, issue #141).
   * Reported rather than silent, because an agent comparing two searches needs to know one of them
   * was ranked by fewer signals. `vectorCoverage` tells the third cause from the first two.
   */
  readonly degraded: boolean
  /**
   * The share of the index's chunks carrying a vector in the configured space, `0` to `1`, read once
   * per call. Present on every result so a caller can tell a coverage degradation (this is low) from
   * an embedder outage (this is high and `degraded` is still true). `1` on an index with no chunks.
   */
  readonly vectorCoverage: number
  /** The arms that actually contributed, for the operator envelope. */
  readonly arms: ReadonlyArray<string>
  /**
   * The entity reference this search was scoped to, or `null` when it was not scoped by entity.
   *
   * Echoed back so an empty result is ATTRIBUTABLE. A scope that matches nothing never widens here,
   * since there is no fallback to widen to. The failure mode left is a caller who cannot tell a
   * corpus with no answer from a scope with a typo in it, and this field is what tells them.
   */
  readonly entityScope: string | null
  /**
   * True when a scope was named, it narrowed the query, and nothing survived it.
   *
   * A BOOLEAN in every case rather than a field that appears only when it fires. The CLI's `--dense`
   * drops null-valued keys (`apps/cli/src/envelope.ts:139`), so a marker that were null when absent
   * would vanish from exactly the output an agent pastes into a context window. `false` costs five
   * bytes and is unambiguous.
   *
   * Never `true` for an unscoped empty result. An empty corpus is not an over-narrow scope, and
   * conflating them would make the marker mean "no hits", which `hits.length` already says.
   */
  readonly scopeEmpty: boolean
  /**
   * How many ARCHIVED memories the same scope matches, computed only when `scopeEmpty` is true and
   * `0` otherwise.
   *
   * The pointer behind an empty scope. Eviction and compress are a `git mv` into `archive/`, and the
   * default scope excludes archived rows, so a correct facet over a real record (`day=2026-09-02` on a
   * journal compress folded last night) answers nothing and, without this number, says nothing about
   * why. With it an agent can tell "never existed" from "archived": retry with `includeArchived`, or
   * follow `archived[].supersededBy` to what replaced it (issue #130). A scope match rather than a
   * ranked one: the question is whether the scope's address still resolves, not how the query would
   * rank what it points at. Only the scope's own axes are re-applied; the archived flag is what flips.
   * Zero as well under `asOf`, whose lens already admits archived rows, so the flag is not what
   * emptied that search.
   */
  readonly archivedMatches: number
  /**
   * Up to `limit` of those archived paths, sorted, each with the path of the memory that superseded it
   * or `null` when nothing did. Empty unless `scopeEmpty` is true. `supersededBy` is derived from the
   * `supersedes` edge the way a hit's is, so compress's canonical and `correct`'s replacement both
   * resolve.
   */
  readonly archived: ReadonlyArray<ArchivedMatch>
}

/** One archived memory the scope of an empty search still matches. */
export interface ArchivedMatch {
  readonly path: string
  readonly supersededBy: string | null
}

export interface RetrievalShape {
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, StorageFailure>
  readonly recall: (input: RecallInput) => Effect.Effect<RecallPack, StorageFailure>
}
```

The `apps/cli/src/envelope.ts:139` inside the quoted `scopeEmpty` comment is the source's own citation, reproduced verbatim from `packages/index/src/retrieval.ts:137`. It's stale, and `stripNulls` sits at `apps/cli/src/envelope.ts:218-232`.

`SearchScope.facets` is the one field whose wire spelling lives outside the interface. Its doc comment (`packages/index/src/scope.ts:165-192`) states the composition rule. Two values under one name broaden, and two different names narrow. `FacetFilter` (`packages/index/src/scope.ts:36-41`) is a `name` and `value` pair rather than a string, because the SQL binds the halves separately and a predicate builder that re-split its input would carry a second copy of the split rule (`:32-34`). `FACET_SEPARATOR` is `"="` (`:44`); `parseFacetFilter` (`:57-63`) splits one `name=value` spec at the FIRST separator, trims both halves, and returns `undefined` for `=x`, `x=`, and `x`, so a value may contain `=` and a name may not; `parseFacetFilters` (`:66-70`) maps that over a list and drops every rejection silently, the same discipline a blank tag gets, because a scope value that can't narrow anything shouldn't narrow everything. `packages/index/src/index.ts:127-131` publishes all four, and both doors call the one parser: `apps/cli/src/run.ts:5,310,518` for every `--facet` occurrence on the two commands that take it, and `apps/mcp/src/handlers.ts:33,569,785` for the `facets` parameter of the two tools. A second parser in either app is the drift to watch for: a spec one door accepts and the other drops, with no error on either side.

**Assumptions consumers make:**

- An agent is assumed to chain a second search off a hit's own `entities` array verbatim. `packages/index/src/retrieval.ts:79-91` calls the `type:name` form a contract with the `entity` scope rather than a display choice, and `packages/index/src/scope.ts:140-164` states the same spelling on the scope side because `file_entities` is keyed on `(type, name)` and a bare name would be ambiguous.
- Consumers assume `entities` is an empty array rather than absent when a memory names none, because a caller reading an absent key can't tell "no entities" from "this server does not report them" (`packages/index/src/retrieval.ts:88-89`).
- Consumers assume `supersededBy` is present and nullable in every result for the same reason (`packages/index/src/retrieval.ts:92-97`), and that it comes from the `edges` table rather than the head meta, since the meta reaches no SQL column and reading it would cost a file open per hit (`packages/index/src/retrieval.ts:99-101`).
- Consumers assume `score` is comparable only within one result set (`packages/index/src/retrieval.ts:67`), so two searches can't be merged by score.
- Consumers assume search never fails because the embedder is down, it gets narrower. `packages/index/src/retrieval.ts:259-280` catches the model failure and logs it, and `packages/index/src/retrieval.ts:109-116` surfaces `degraded` so an agent comparing two searches knows one was ranked by fewer signals.
- Consumers assume `scopeEmpty` distinguishes an over-narrow scope from an empty corpus, and is never `true` for an unscoped empty result (`packages/index/src/retrieval.ts:141-142`). `packages/index/src/retrieval.ts:237-253` defines `scopeNarrows` and excludes `includeArchived` because it widens.
- Consumers assume `snippet` is an empty string only when the file has no chunk at all, never absent (`packages/index/src/retrieval.ts:71-78`).
- Both entry points assume the scope filter is built once and handed to every arm identically. `packages/index/src/scope.ts:6-13` states that per-arm filters would let a scope apply to three arms and not the fourth, which surfaces as a scoped query returning a result from outside the scope, and that no type catches it.
- The scope assumes parameter numbering starts at `?5` and holds whether or not the vector arm fired, because the caller always binds a four-value prefix with `null` at `?4`. `packages/index/src/scope.ts:22-26` records that an unbound numbered parameter reads as NULL on this driver rather than failing, so a shifted number would silently match nothing.
- The scope assumes `workspace` is strict equality, so a workspace-scoped query never sees a NULL-workspace file (`packages/index/src/scope.ts:132-137`).
- `asOf` assumes all three temporal columns compare lexicographically as strings, so the predicate is string comparison rather than a per-row parse (`packages/index/src/scope.ts:196-208`).

**Drift risk:** Adding a scope field without threading it into `assembleScope` leaves it accepted and ignored, so an agent narrowing a query gets an unscoped answer with no error. Mitigation: `packages/index/src/scope.ts:14-20` draws the line between a scope, which reaches every arm and belongs in this filter, and an arm's own exclusion, which must never enter it; a pin test enforces that an absent `asOf` produces a byte-identical filter (`packages/index/src/scope.ts:205-206`).

## The semantic-HTML memory-file grammar

The closed element and metadata vocabulary that defines what a memory file may contain. This is the contract the files in the root satisfy, so it binds the format package, the store's render gate, the session validator, the indexer, the head, and any hand-authored file.

**Producer:** `packages/html/src/vocabulary.ts:13-284`

**Consumer(s):**

- `packages/html/src/serialize.ts:6` imports `isRepeatableMeta`, `META_ORDER`, `MemoryMetaName` and emits metas in that order at `packages/html/src/serialize.ts:83`.
- `packages/html/src/constraints.ts:26` imports `REQUIRED_META` and checks each at `packages/html/src/constraints.ts:352-355`, then rejects an out-of-vocabulary meta name at `packages/html/src/constraints.ts:356-359`.
- `packages/html/src/parse.ts` reads the same prefix when collecting head metas and links (`packages/html/src/parse.ts:277-288`).
- `packages/store/src/store.ts:22-31` imports `checkMemory` and `renderTemplate`, so every v1 write passes the vocabulary gate before a file is created.
- `packages/session/src/validate.ts:16` imports `checkMemory` and runs it on every `put` and on the `html` an `archive` or a `move` carries (`packages/session/src/validate.ts:267`, `:310`, `:429`). A failure is a `format` violation (`packages/session/src/validate.ts:268-270`), so a session op meets the same gate as a v1 write.
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
  /**
   * The two task metas, appended after the last pre-task scalar. Position in this list is a
   * diff-stability contract, so a new scalar goes at the END of the scalar block: inserting one
   * mid-list would move every line below it in every file the next bookkeeping pass touches.
   */
  "memhtml-task-status",
  "memhtml-due",
  "memhtml-entity",
  "memhtml-tag",
  /**
   * Appended after the two established repeatables, for the same diff-stability reason: a new
   * repeatable goes at the END of the repeatable block, so no file's existing head lines move.
   */
  "memhtml-alias"
] as const

export const REPEATABLE_META = ["memhtml-entity", "memhtml-tag", "memhtml-alias"] as const

export const FIGURE_SCOPED_ELEMENTS = ["div", "span"] as const

export const FORBIDDEN_ATTRIBUTES: ReadonlySet<string> = new Set(["class", "style"])
export const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"])
```

**Assumptions consumers make:**

- The serializer assumes position in `META_ORDER` is a diff-stability contract, so a new scalar meta goes at the end of the scalar block. `packages/html/src/vocabulary.ts:53-75` states that inserting one mid-list would move every line below it in every file the next bookkeeping pass touches, and `packages/html/src/vocabulary.ts:48-52` states that a stable order is what makes a meta-only edit a one-line git diff.
- The parser and the constraint checker assume an out-of-vocabulary token means two different things. The parser drops the link so the file still parses (`packages/html/src/parse.ts:285-286`), the checker reports the violation (`packages/html/src/constraints.ts:319-321`).
- The checker assumes a duplicate `memhtml-type` is a violation rather than a last-wins pick, because two writers disagreeing about a memory's type should stop a write (`packages/html/src/constraints.ts:335-336`).
- The vocabulary assumes three metas are deliberately absent from `REQUIRED_META` because the `files` table documents a default for each, so a hand-authored file missing them is completed rather than refused (`packages/html/src/vocabulary.ts:34-40`). Those defaults are at `packages/index/migrations/0008_tasks.sql:48-49`. That comment's first sentence says "Each of the five" (`packages/html/src/vocabulary.ts:35`) over a list of four. The array is the contract, and the comment's count is stale.
- The serializer assumes `<pre>` needs a second newline emitted, because a newline immediately after the start tag is swallowed on parse. `packages/html/src/vocabulary.ts:213-218` states that without this, `<pre>` text starting with a newline loses one on every parse and serialize cycle and the content hash drifts.
- `bodyText` assumes a word boundary at every block-level edge and none at a phrasing-level edge, so `<dt>Applies to</dt><dd>ALB</dd>` yields two searchable words. `packages/html/src/vocabulary.ts:231-240` also states the content hash deliberately doesn't use `INLINE_ELEMENTS`, because making the digest a function of that list would move every hash on every future vocabulary change.
- The serializer assumes it must round-trip a file carrying `<script>` or `<style>` before the constraint is reported, which is why both appear in `RAW_TEXT_ELEMENTS` while also being forbidden (`packages/html/src/vocabulary.ts:197-211`, `:273`).
- `packages/html/src/vocabulary.ts:1-6` assumes the vocabulary IS the policy, so there's no sanitizer library and no allow-or-deny logic in the module.

**Drift risk:** Adding an element to `ARTICLE_ELEMENTS` without a matching extraction in `ArticleExtractions` makes the element legal and invisible. It parses without a warning and reaches no index column. Mitigation: pair a vocabulary addition with its extraction field and its projection write, and rely on the graceful-degradation rule at `packages/html/src/vocabulary.ts:100-106`, which makes an unnamed element a warning rather than a refusal in the interim.

## The root layout as system of record

Where memhtml puts things inside the external root, and which of those things survive a clone. This contract is what makes "the git tree is the system of record" checkable rather than aspirational.

**Producer:** `packages/store/src/layout.ts:21-106`

**Consumer(s):**

- `packages/store/src/store.ts:36` imports `attemptIo` and `readFileOrNull` from the same module, and `packages/store/src/store.ts:320-341` declares `expandRoot`, the tilde expansion every `MEMHTML_ROOT` value passes through.
- `apps/cli/src/config.ts:15` imports `expandRoot` from `@memhtml/store`, and `apps/cli/src/config.ts:282-286` declares `MemhtmlRoot` on top of it instead of redeclaring the expansion.
- `apps/cli/src/config.ts:107-117` documents `MEMHTML_ROOT` for `memhtml manifest` and the generated agent doc.
- `packages/index/src/schema-const.ts:7-20` names the migrations directories and the `state` schema the ATTACH uses.
- `tests-integration/tests/rebuild.test.ts:211-218` deletes both databases from `.memhtml/` and rebuilds, asserting the whole claim.
- The v2 packages declare their own copies of the v2 paths instead of importing the store's: `SESSIONS_DIR` (`packages/session/src/session.ts:58`), `HEAD_SOCKET` (`packages/session/src/exclude.ts:28`), `SNAPSHOTS_DIR` (`packages/snapshot/src/snapshot.ts:177`), and `VECTORS_DIR` (`packages/snapshot/src/vectors.ts:68`). Nothing outside the store's own barrel (`packages/store/src/index.ts:33-47`) imports the store's v2 constants.

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

/** The v2 session logs and index files (`@memhtml/session`), per-process state, never committed. */
export const SESSIONS_DIR_PATH = `${MEMHTML_DIR}/sessions`

/** The v2 Arrow snapshots (`@memhtml/snapshot`), a rebuildable cache of one commit each. */
export const SNAPSHOTS_DIR_PATH = `${MEMHTML_DIR}/snapshots`

/** The v2 vector caches (`@memhtml/snapshot`), rebuildable by embedding the tree's articles again. */
export const VECTORS_DIR_PATH = `${MEMHTML_DIR}/vectors`

/** The head server's Unix domain socket (`memhtml head serve`), present only while one runs. */
export const HEAD_SOCKET_PATH = `${MEMHTML_DIR}/head.sock`

export const V2_IGNORE_PATTERNS: ReadonlyArray<string> = [
  `${SESSIONS_DIR_PATH}/`,
  `${SNAPSHOTS_DIR_PATH}/`,
  `${VECTORS_DIR_PATH}/`,
  HEAD_SOCKET_PATH
]

export const GITIGNORE = `${INDEX_DB_PATH}
${STATE_DB_PATH}
${INDEX_DB_PATH}-*
${STATE_DB_PATH}-*
${V2_IGNORE_PATTERNS.join("\n")}
`

export const GITATTRIBUTES = `index.html merge=ours
sitemap.xml merge=ours
*.html diff=html
`

/** The config that makes `merge=ours` in `.gitattributes` actually resolve a conflict. */
export const MERGE_OURS_DRIVER = { key: "merge.ours.driver", value: "true" } as const
```

`SCAFFOLD_DIRS` (`packages/store/src/layout.ts:36-48`) is the list `memhtml init` creates: the four PARA buckets, the three placement directories `ARCS_DIR`, `PEOPLE_DIR`, and `INBOX_DIR`, `.memhtml/state`, and one legacy reports directory under `.memhtml/`. Nothing in 0.16.0 writes to that last one, and `packages/store/src/layout.ts:33` keeps it so an existing store's layout and `init` stay stable.

**Assumptions consumers make:**

- Every consumer assumes the ignore list holds the two databases, their `-*` siblings, and the four v2 patterns, and that everything else is committed. A fresh clone plus `memhtml state import` plus `memhtml index rebuild` yields the whole system, and the v2 state under `.memhtml/` is per-process or a cache of the tree (`packages/store/src/layout.ts:75-89`). `tests-integration/tests/rebuild.test.ts:205-227` deletes both databases and asserts every row set returns.
- The v2 writers assume an existing store's `.gitignore` predates them and shouldn't be rewritten, because it's committed content. Each first writer appends its own pattern to `.git/info/exclude` instead (`packages/session/src/exclude.ts:11-19`, `packages/store/src/layout.ts:62-67`). The first writers are a session start at `packages/session/src/session.ts:256`, a snapshot write at `apps/cli/src/head-cache.ts:248`, a vector fill at `apps/cli/src/head-vectors.ts:383`, and the head server at `apps/cli/src/head-server.ts:859` and `:1485`.
- The checkout lock lives at `.memhtml/checkout.lock`, an empty directory that `proper-lockfile` creates and removes (`packages/contracts/src/checkout-lock.ts:31-35`). It's in no ignore list. Git doesn't list an empty directory as untracked, so it never shows in `git status`.
- The rebuild path assumes `index.db` is reproducible from the tree and `state.db` isn't. `packages/index/src/index.ts:5-6` states it, and `tests-integration/tests/rebuild.test.ts:206-210` states that deleting only the index would leave the harder half of the claim untested.
- The rebuild assumes its truncate list matches the schema. `packages/index/src/schema-const.ts:47-60` orders `MEMORY_TABLES` children before parents, and `packages/index/src/schema-const.ts:1-5` states that a truncate list that has drifted from the schema leaves rows behind, which makes the rebuild incomplete.
- The store assumes it must never create the root implicitly. `packages/store/src/layout.ts:12-19` states that a typo in `MEMHTML_ROOT` silently scaffolding a second empty memory repo would be worse than an error, because the agent would go on writing into it and only a later search would come up empty.
- Both config declarations assume `~` must be expanded in process rather than by a shell, because the value arrives from a shell profile, an MCP client config, and a non-interactive job's command line, and only the shell expands tildes on its own. `packages/store/src/store.ts:320-326` states that the other two would otherwise create a literal `./~` directory.
- `packages/store/src/layout.ts:91-99` assumes the `merge=ours` attribute alone does nothing, and records a live probe. With the attribute set and no driver configured, git still writes conflict markers. Since git config is per-clone, `memhtml init` must set `MERGE_OURS_DRIVER` again on every fresh clone.
- `packages/store/src/layout.ts:36-40` assumes an agent's first write must land in a directory that already exists, so `SCAFFOLD_DIRS` covers the four PARA buckets plus the three system directories `placementFor` can return.

**Drift risk:** Each v2 path is declared twice, once in the store's layout and once in the package that writes it. A rename on one side leaves a new store's `.gitignore` naming a directory nothing writes while the real one shows up in `git status`. Mitigation: import the store's constant in the writing package, or assert the two spellings equal in a test.

Adding a generated artifact under the root without adding it to `.gitignore` or to `.gitattributes` makes it either a committed file that conflicts on every merge or a rebuildable file that's committed anyway. Mitigation: `packages/store/src/layout.ts:91-94` names the generated artifacts as the design's one merge-conflict source and `merge=ours` plus regeneration as the resolution; classify any new artifact into rebuildable-and-ignored or committed-and-merge-ours at the time it's added.

A third SQL plane sits beside the memory tables and the ATTACHed `state` schema, and it's neither rebuilt nor committed. `TRACE_TABLES` (`packages/index/src/schema-const.ts:63`) names `trace_prompts`, `traces`, and `trace_watermarks`, created inside `index.db` by `packages/index/migrations/0005_traces.sql:8` onward; `schema-const.ts:62` states that a memory rebuild never touches them, and `MEMORY_TABLES` (`:51-60`), the list `packages/index/src/indexer.ts:414` empties, doesn't name them, so `memhtml index rebuild` keeps every scanned session. `0005_traces.sql:1-6` states the two firewalls. Every column is a pointer or a capped head and never a copy of session content, and no retrieval SQL names `traces` or `trace_prompts`. The scanner in `@memhtml/traces` owns the incremental decision as pure arithmetic. `Watermark` (`packages/traces/src/watermark.ts:21-25`, `size`, `mtimeMs`, `byteOff`) mirrors a `trace_watermarks` row, and a `WatermarkAction` (`:38`) of `skip`, `tail`, or `rescan` decides whether a file is opened at all. `packages/index/src/traces-persist.ts:8-22` owns the table and states the scanner's shapes structurally rather than importing them, because `@memhtml/traces` depends on `@memhtml/index` and the arrow stays one way, which is also why the tail merge is an injected function rather than an import.

The plane's root is `Roots.traceRoot` (`apps/cli/src/api-layer.ts:87-94`), resolved once by `layerRoots` (`:100-109`) from `TraceRoot` (`apps/cli/src/config.ts:294-297`, `MEMHTML_TRACE_ROOT` defaulting to `~/.claude`), and read-only. `tests-integration/tests/traces.test.ts:13-31` records what resolving it late costs. `Config` reads against a snapshot of `process.env` taken when the provider is first built, so a suite that assigned `MEMHTML_TRACE_ROOT` in a `beforeAll` after another suite in the same process had resolved config fell back to the real `~/.claude` and scanned every transcript there into a temp repo. The variable is set at module scope for that reason, and the hook engine applies `--trace-root` through a `ConfigProvider` rather than by mutating `process.env` for the same one.

## The integrations family

`@memhtml/integrations` wires a coding agent host to the store: an MCP server entry, lifecycle hooks, an instruction block, and a skill file, each written under a receipt that proves ownership. The package declares six closed vocabularies, one serialized artifact, and one error class, and `apps/cli` is its only consumer outside the package. `apps/cli/src/run.ts:6` and `apps/cli/src/commands.ts:5` import the vocabularies, `apps/cli/src/hook.ts:6-12` imports the dialect, and `apps/cli/src/integrations.ts:26` imports the transaction layer.

**Producer:** `packages/integrations/src/types.ts:10-137`, published with the rest of the package by `packages/integrations/src/index.ts:15-21`

**Consumer(s):**

- `apps/cli/src/run.ts:6` imports `HOSTS`, `HOOK_EVENTS`, `isHostId`, `isHookEvent`, and `renderHookOutput`; `apps/cli/src/run.ts:1344-1359` turns an out-of-vocabulary event or host into `ERR_UNKNOWN_HOOK_EVENT` or `ERR_UNKNOWN_HOST` with one suggestion per known value, and `apps/cli/src/run.ts:1835` re-checks both before the hook engine runs.
- `apps/cli/src/commands.ts:5` imports `HOSTS` and `HOOK_EVENTS` and interpolates them into flag descriptions at `apps/cli/src/commands.ts:1032,1089,1128,1172` and into an enum at `:1181`, so the manifest and the generated agent doc name every host the parser accepts.
- `apps/cli/src/integrations.ts:61-83` declares `IntegrationsAnswer` (an envelope plus an exit code) and `IntegrationsInput`, and `apps/cli/src/integrations.ts:264-499` runs the five verbs `integrationsInstall`, `integrationsUninstall`, `integrationsList`, `integrationsDoctor`, and `integrationsShell`.
- Inside the package, `packages/integrations/src/install.ts:60`, `uninstall.ts:27`, `list.ts:14`, and `doctor.ts:28` all read the receipt through `inspectReceiptFile` and `compareEntries`, so four verbs share one reading of what "installed" means.

**Shape:**

```typescript
/** The four coding agents this package can wire, in the order the docs present them. */
export const HOSTS = ["claude", "codex", "cursor", "opencode"] as const
export type HostId = (typeof HOSTS)[number]

export const HOOK_EVENTS = [
  "session-start",
  "user-prompt-submit",
  "pre-compact",
  "session-end"
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]
```

The other four vocabularies are `SCOPES` (`user` anchors at `$HOME`, `project` at a git repository's top level; `packages/integrations/src/types.ts:17-18`), `HOOK_MODES` (`all`, `session`, `none`; `:37-38`), `MANAGED_ROLES` (the six things a receipt entry can be: `mcp-entry`, `hooks`, `instruction-block`, `skill`, `plugin`, `rules`; `:93-101`), and `INSTALL_STATES` (`not-installed`, `installed`, `modified`; `:128-129`). `compareEntries` at `packages/integrations/src/receipt.ts:166-176` produces two of the three states and never `not-installed`, which `:163-164` says is the absence of a receipt and the caller's question.

The receipt is contract kind 4, a serialized artifact one verb writes and four read.

```typescript
export interface Receipt {
  readonly package: "memhtml"
  readonly version: string
  readonly host: HostId
  readonly scope: Scope
  readonly root: string
  readonly memhtmlRoot: string
  readonly binary: BinaryLocation
  readonly bareCommand: boolean
  readonly hooks: HookMode
  readonly installedAt: string
  readonly entries: ReadonlyArray<ReceiptEntry>
}

export interface ReceiptEntry {
  readonly path: string
  readonly role: ManagedRole
  readonly kind: "file" | "fragment"
  readonly sha256: string
}
```

`install` writes it through `writeReceipt` (`packages/integrations/src/receipt.ts:139`, called at `packages/integrations/src/install.ts:887`), and `list`, `doctor`, `uninstall`, and a re-run `install` read it back through `inspectReceiptFile` (`receipt.ts:108`), which is the only reader that distinguishes absent, valid, and invalid-with-a-reason (`receipt.ts:38-43`). It lives at `receiptPath` (`receipt.ts:33-36`): `~/.config/memhtml/integrations/<host>.json` at user scope, `.memhtml-integrations/<host>.json` at project scope, one per host per scope. Each entry hashes only the bytes install owns, the whole file for `kind: "file"` and the rendered fragment for `kind: "fragment"` (`packages/integrations/src/types.ts:78-82`, `receipt.ts:157-161`), so a human's edit anywhere else in a shared config file isn't drift, and a deleted fragment is drift rather than a separate state.

`IntegrationModified` (`packages/integrations/src/errors.ts:8-15`) is the one error class the package declares, carrying `host`, `path`, and `detail`. It's raised at `packages/integrations/src/install.ts:464,689,726,747` and `packages/integrations/src/uninstall.ts:80,130` when a receipt-owned entry doesn't hash to its receipt or a hand-written twin of the package's entry sits outside the fence. The CLI maps it in three places. `codeFor` returns `ERR_INTEGRATION_MODIFIED` (`apps/cli/src/errors.ts:83-84`), `messageFor` names the host, path, and detail (`apps/cli/src/errors.ts:150-151`), and the `SUGGESTIONS` record offers `integrations doctor <host>` then `integrations install <host> --force` (`apps/cli/src/errors.ts:252-256`). `apps/cli/src/integrations.ts:206-212` routes every other failure in this family to `ERR_STORAGE` rather than `ERR_UNKNOWN`, on the reading that the remaining failures are filesystem ones. The MCP server has no arm for the tag (`apps/mcp/src/failure.ts:80-149`), which is harmless only as long as no MCP tool reaches the transaction layer.

The per-host algebra is `HostSpec` (`packages/integrations/src/hosts.ts:92-106`), whose `mcp`, `hooks`, and `instruction` fields are the discriminated unions `McpTarget` (`json` or `toml-fence`; `:33-43`), `HooksTarget` (`json-arrays` or `plugin-file`; `:54-65`), and `InstructionTarget` (`markdown-block` or `cursor-rules`, with `agentsFile` present only for Claude Code at project scope; `:80-89`). `hostSpec(host, scope, root)` at `packages/integrations/src/hosts.ts:161` is the function from the two vocabularies to a spec, a `switch` over `HostId` with no default arm, so a fifth host is a compile error until it has a spec. `detectHosts` at `:271-277` walks `DETECT_DIRS` (`:122-127`) to decide which hosts an argument-less install wires, and `DEFAULT_TRACE_ROOT` (`:136-141`) is non-null for Claude Code alone, because `@memhtml/traces` reads only its transcript format, so the other three hosts install no indexing hook. `DISPLAY_NAMES` (`:109-114`) and `CODEX_MCP_TABLE` (`:153`) are the remaining per-host constants.

The wire shapes the installer merges into a host's own files are in `render/`. `packages/integrations/src/render/mcp.ts:15-32` declares `MCP_SERVER_KEY`, `JsonMcpEntry` (Claude Code and Cursor, under `mcpServers.memhtml`, with `args` omitted rather than `[]`), and `OpenCodeMcpEntry` (one command array, `environment` rather than `env`), and `codexMcpToml` at `:75-85` renders the `[mcp_servers.memhtml]` table with its `env` sub-table last. `packages/integrations/src/render/hooks.ts:24-46` declares `CommandHook`, `CommandHookGroup` (no `matcher`, on purpose), `CursorHookEntry`, and `CURSOR_HOOKS_VERSION`; `claudeOwned` at `:164-172` is how install and doctor recognize their own entries, by the `hook <event> --host <host>` shape every command in the entry must match (`:150-152`), and `codexOwned` and `cursorOwned` (`:175-178`) are the same function. `packages/integrations/src/install.ts:66-67` imports both renderers and `:483-514` is where a spec's `format` picks one.

The fence contract is what lets three adapters edit files other tools also own. `packages/integrations/src/adapters/fenced.ts:52-63` declares `FencedText` (`upsert`, `remove`, `read`, `has`, plus the two markers) over one marker pair, `fenced()` at `:70-127` builds it, and three adapters bind it to their own markers: `adapters/toml.ts:16-17` (`# MEMHTML:START` / `# MEMHTML:END`, for Codex's `config.toml`), `adapters/markdown.ts:12-13` (`<!-- MEMHTML:START -->` / `<!-- MEMHTML:END -->`, for `CLAUDE.md` and `AGENTS.md`), and `adapters/shellrc.ts:12-13` (the same `#` pair as TOML, for an rc file). Markers match a trimmed line so a hand-reindented file doesn't grow a second region (`fenced.ts:66-68`), malformed or duplicated markers throw rather than guess (`fenced.ts:40-41`), and `linesOutsideFence` at `fenced.ts:134-153` is what lets `hasUnfencedTable` (`adapters/toml.ts:48-57`) refuse a hand-written `[mcp_servers.memhtml]` outside the fence. `adapters/markdown.ts:42-43` adds the one Markdown-specific rule, that a `CLAUDE.md` which is only `@AGENTS.md` is a pointer the block shouldn't be written into.

**Assumptions consumers make:**

- The CLI assumes the two lists it validates against are the only vocabularies a hook call can be wrong about, so `apps/cli/src/run.ts:1835` checks `isHookEvent` and `isHostId` and nothing else before running the engine.
- Every verb assumes the receipt is the sole ownership proof and that ownership is per fragment, so `install` without `--force` and `uninstall` both stop on drift rather than overwrite (`packages/integrations/src/install.ts:16`, `packages/integrations/src/uninstall.ts:5`).
- The TOML adapter assumes it may not parse the file, so a collision is detected by table name outside the fence rather than by structure (`packages/integrations/src/hosts.ts:30-31`, `adapters/toml.ts:35-38`).

**Drift risk:** Adding a `HookEvent` isn't a compile error anywhere. `renderHookOutput` (`packages/integrations/src/dialect.ts:17-37`) returns the empty string for an event a host's arm doesn't name, so a new event installs and silently injects nothing, and `injects(host, event)` reads that silence as "this host cannot inject here". Mitigation: add the dialect arm, the `CODEX_EVENT_NAMES` entry (`dialect.ts:40-45`), and the per-host event mapping in `render/hooks.ts` in the same change as the vocabulary entry.

## The hook engine

`apps/cli/src/hook.ts` is what an installed host hook runs. Two properties hold it together, stated at `apps/cli/src/hook.ts:20-39`. It never fails, and it's bounded. It produces text and knows nothing about which host reads which stream; the host's protocol is applied one layer out by `renderHookOutput`.

**Producer:** `apps/cli/src/hook.ts:42-113` for the input, the constants, and the headers, and `packages/integrations/src/dialect.ts:17-70` for the per-host dialect

**Consumer(s):**

- `apps/cli/src/run.ts:85-88` imports `hookStoreReady`, `readHookPayload`, and `runHook`; the `hook` arm at `apps/cli/src/run.ts:1829-1879` checks the store exists without creating it (`:1866`), reads the payload (`:1870`), picks the deadline by event (`:1871`), and prints `renderHookOutput(...)` and nothing else, with `--dense` and `--json` not reaching that stream (`apps/cli/src/run.ts:1808-1809`).
- `packages/integrations/src/render/hooks.ts:63,92,114` render the `memhtml hook <event> --host <host>` command lines that the hosts' config files call, with a host-side timeout of `RECALL_TIMEOUT_SECONDS` 10 for injecting events and `INDEX_TIMEOUT_SECONDS` 30 for indexing ones (`:49-52`).
- The engine requires `RetrievalShape | DatabaseShape | RootsShape` (`apps/cli/src/hook.ts:297-299`) and reaches the store through `apps/cli/src/operations.ts` (`apps/cli/src/hook.ts:18`).

**Shape:**

```typescript
/** What the engine needs to answer one hook call. */
export interface HookInput {
  readonly event: HookEvent
  /**
   * Which host fired. Read for one decision only: whether this host can inject at all on this event
   * ({@link injects}). The output DIALECT is applied by the caller.
   */
  readonly host: HostId
  /** The host's hook payload, already JSON-parsed, or `undefined` when it was not parseable. */
  readonly payload: unknown
  /** Hits to inject on a per-prompt recall. */
  readonly limit: number
  /** Character budget handed to `recall` for the session-start pack. */
  readonly budget: number
  /**
   * `--trace-root`, when the caller named one.
   *
   * The indexer takes its root from the `Roots` service, which `layerRoots` resolves from
   * `MEMHTML_TRACE_ROOT` — there is no override parameter on `indexTraces()` and no roots-override
   * layer, so the CALLER applies this as that variable, through {@link hookConfigProvider} beside the
   * layer. It is carried here to be VERIFIED rather than to be applied: indexing the wrong transcript tree
   * would advance a watermark over files the host never wrote, which is worse than indexing none, so a
   * mismatch between this value and the resolved root declines the work with a warning.
   */
  readonly traceRoot?: string
  /** The hard bound on the whole engine. Expiry is the empty string. */
  readonly deadlineMs: number
}
```

The constants beside it are the budget and deadline contract. `INDEXING_EVENTS` is `pre-compact` and `session-end`, the two events that index transcripts and never print (`apps/cli/src/hook.ts:71`); `HOOK_LIMIT_DEFAULT` 5 and `HOOK_BUDGET_DEFAULT` 3000 are the flag defaults `commands.ts` also states (`:74,77`); `HOOK_RECALL_DEADLINE_MS` 1500 bounds an injecting event and `HOOK_INDEX_DEADLINE_MS` 10000 bounds an indexing one (`:80,87`); `GIST_MAX_CHARS` 240, `OPEN_TASK_LIMIT` 5, and `OPEN_TASK_STATUSES` (`todo`, `doing`) shape the session-start block (`:90-96`); and `HOOK_STDIN_DEADLINE_MS` 500 bounds the read the engine's own deadline can't (`:393`). `PROMPT_HEADER`, `sessionHeader`, and `OPEN_TASKS_HEADER` (`:105-113`) are the three lines an injection starts with; the per-prompt header deliberately says the hits are the ranker's guess and names `memory_read` and `memory_reinforce`, because salience only moves on a read or an outcome (`:98-104`).

The injection matrix is `injects(host, event)` at `apps/cli/src/hook.ts:222-223`, which asks the dialect with a probe string rather than restating a table, so the one function that knows a host can't inject on an event is the one that renders it. That function is `renderHookOutput` at `packages/integrations/src/dialect.ts:17-37`. Claude Code takes plain stdout on `session-start` and `user-prompt-submit`; Codex takes a `hookSpecificOutput.additionalContext` JSON on the same two, with the event name spelled from `CODEX_EVENT_NAMES` (`:40-45`); Cursor takes `{additional_context}` on `session-start` only, so a Cursor per-prompt hook is never installed; OpenCode's generated plugin takes plain text on the two injecting events. Every host's arm returns the empty string for an event it doesn't name, and an empty `text` renders as an empty string on every host. `promptOf` and `cwdOf` (`dialect.ts:52-70`) read the prompt and the working directory out of the payload, taking `cwd` or the first of Cursor's `workspace_roots`.

The stdin protocol is the other half of the boundary. `readHookPayload` (`apps/cli/src/hook.ts:402-414`) races the host's stdin against an `unref`'d `HOOK_STDIN_DEADLINE_MS` timer and hands the raw text to `parseHookPayload` (`:424-431`), which returns `undefined` for anything empty or unparseable rather than an error. `runHook` (`:329-333`) wraps the engine in `Effect.timeout(input.deadlineMs)` and `Effect.catchCause(() => Effect.succeed(""))`, so a storage failure, a defect, and a blown deadline are all the empty string, and `apps/cli/src/run.ts:1811-1813` states why every path exits 0. On `UserPromptSubmit` a non-zero exit is how a hook BLOCKS the prompt. `hookStoreReady` (`:363-373`) probes `<root>/.git` rather than building the layer, because `makeDatabase` would `mkdir -p` a store at a mistyped root, and `hookConfigProvider` (`:390-401`) applies `--trace-root` as `MEMHTML_TRACE_ROOT` through a `ConfigProvider` rather than by mutating `process.env`, for the reason `:379-384` records. The renderers `renderPromptHits` (`:177-180`) and `renderSessionPack` (`:212-234`) are pure over the structural `HookEntry`, `HookPack`, and `HookTask` (`:161-199`), and `queryForCwd` (`:244-249`) turns a working directory into the two-token query a session start recalls on.

**Drift risk:** The engine's deadlines and the host-side timeouts are two constants in two packages that must keep their order. `HOOK_RECALL_DEADLINE_MS` (1500 ms) plus process startup must stay under `RECALL_TIMEOUT_SECONDS` (10 s) and `HOOK_INDEX_DEADLINE_MS` (10 s) under `INDEX_TIMEOUT_SECONDS` (30 s), or the host kills the process before the engine's own timeout returns the empty string and an indexing scan is lost mid-pass. Mitigation: change the pair together, and keep the deadline names beside each other in `apps/cli/src/hook.ts:79-87` and `packages/integrations/src/render/hooks.ts:48-52` as they're now.

## The composition root and its service shapes

`apps/cli/src/api-layer.ts` is where config becomes services for the v1 commands and for the MCP server. Besides wiring the shapes other packages declare, it declares four `Context.Service` shapes of its own, contract kind 3, and binds each in a layer that reads its environment through `effect`'s `Config`. `RootsShape` (`:87-94`) carries `memhtmlRoot` and `traceRoot`, resolved by `layerRoots` (`:100-109`) from `MemhtmlRoot` and `TraceRoot`, with `--repo` winning over `MEMHTML_ROOT`. `EmbedderShape` (`:218-223`) carries the `document` and `query` embed ports, both `undefined` when `MEMHTML_EMBED` is `off` (`:236-240`). `RetrievalPolicyShape` (`:281-286`) carries `vectorCoverageFloor`, read as a number by `VectorCoverageFloor` and refused outside `(0, 1]` with `Effect.die` naming `MEMHTML_VECTOR_COVERAGE_FLOOR` (`:299-303`). `ExtractorPortShape` (`:356-360`) carries an optional entity extractor, `undefined` when either `MEMHTML_EXTRACT_ENTITIES` or `MEMHTML_LLM` is `off` (`:365-373`). An optional port reports absence as `undefined` and never as a failure, so a credential-free environment degrades a search or leaves a write unextracted and never turns into a dead CLI (`:213-216`).

`layerApp` (`:402-419`) is the one production graph, and `memhtml serve mcp` runs the same one in a child process, so an MCP tool and its CLI twin read one database. `layerAppWith` (`:421-449`) is the same `layerCore` with only the network edges substituted, so a test runs the wiring production runs.

The v2 commands never build this graph. `apps/cli/src/v2.ts:122-128` states that every `session`, `head`, and `curate` arm resolves a root and reads git, and none opens `index.db`, so building `layerApp` would open and migrate a database no arm queries while `memhtml serve mcp` may hold it. `apps/cli/src/run.ts:1228-1229` routes those commands around the layer by prefix, and `apps/cli/src/run.ts:1231-1241` names the four v2 commands that bind an embedder of their own. `apps/cli/src/v2.ts:127-128` adds that `DispatchServices` (`apps/cli/src/run.ts:697`) is the app layer's service set, so nothing in `v2.ts` is reached through `dispatch`.

## `ModelClientShape` and the model table

The door every v1 model call goes through, and the closed table of models every lane names. `ModelClient` is a `Context.Service`, contract kind 3, bound once at the composition root and consumed by the write-time entity extractor. The curator's model calls take a second door, the AI SDK, and share only the model table and the proxy configuration with this package.

**Producer:** `packages/llm/src/model-client.ts:28-81` and `packages/llm/src/models.ts:22-117`

**Consumer(s):**

- `apps/cli/src/api-layer.ts:30-32` imports `ModelClient`, `ModelClientLive`, and `ModelClientShape`; `apps/cli/src/api-layer.ts:362-376` builds the extractor port from it, and `apps/cli/src/api-layer.ts:415` provides `ModelClientLive` to that port in the production graph. `apps/cli/src/api-layer.ts:58` re-exports the tag.
- `apps/cli/src/extraction.ts:4,162` takes a `ModelClientShape` into `makeEntityExtractor`, so every extraction test injects one and none needs the network (`apps/cli/src/extraction.ts:28`).
- `packages/curator/src/model.ts:5` imports `modelByKey`, `proxyConfigFromEnv`, and `proxyModelId` and no `ModelClient`. The curator builds an AI SDK `LanguageModel` from a `--model` spec (`packages/curator/src/model.ts:13-23`), names its default as `modelByKey("opus-5").modelId` (`packages/curator/src/model.ts:31`), and takes any `bedrock:<modelId>` spec as given (`packages/curator/src/model.ts:52-63`), so a curator's model needn't be a row of the table.
- `packages/llm/src/proxy.ts:11,49` reads `MODELS` to find a model by its Bedrock id when a call leaves through the LLM proxy.

**Shape:**

```typescript
export interface ModelClientShape {
  readonly generate: (
    modelKey: ModelKey,
    prompt: string,
    options: GenerateOptions
  ) => Effect.Effect<Generation, ModelUnavailable>
  readonly generateObject: <A, I>(
    request: StructuredRequest<A, I>
  ) => Effect.Effect<A, ModelUnavailable | LlmContractViolation>
}

export const ModelClient = Context.Service<ModelClientShape>("memhtml/ModelClient")
```

```typescript
export const ModelKey = Schema.Literals([
  "sonnet-5",
  "opus-5",
  "fable-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra"
])
export type ModelKey = typeof ModelKey.Type

/** Which wire dialect a model speaks. Selected per model, never per call. */
export type Provider = "anthropic" | "openai"

export interface ModelInfo {
  readonly key: ModelKey
  readonly label: string
  readonly modelId: string
  readonly provider: Provider
}
```

`MODELS` (`packages/llm/src/models.ts:50-86`) is the five-row table behind `ModelKey`, every `modelId` a `global.` Bedrock inference profile because the OpenAI ids reject on-demand invocation without one (`:44-49`). `modelByKey` (`:95-101`) is total over `ModelKey` and throws only if the table is edited out of agreement with the literal union. `thinkingFor` (`:112-117`) is the per-model `thinking` object: `{type: "adaptive"}` for Opus 5 and Fable 5, `null` for Sonnet 5, which rejects any thinking key, and never consulted on the OpenAI lane. `Generation` (`packages/llm/src/model-client.ts:28-33`) carries the text plus nullable token counts and a latency, `StructuredRequest` (`:35-58`) carries the schema, the prompt, the model key, the effort, and the optional `inputSchema` override and `cacheSystem` flag, and `ModelClientDefaults` (`:78-81`) is where a deployment's wire defaults meet a call's options.

Every JSON Schema handed to a model through `ModelClient` is a closed object, contract kind 4. `toInputSchema` (`packages/llm/src/structured.ts:44-50`) calls `Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })` (`packages/llm/src/structured.ts:45`), and that option is what emits `additionalProperties: false`. Without it the document is open, and a model may answer a schema next to the one it was given. `packages/llm/tests/structured.test.ts:31` pins the `false` on a root. The serialized form is `StructuredRequest.inputSchema` (`packages/llm/src/model-client.ts:47`), the hand-written override typed as `toInputSchema`'s return. The decode side is closed the same way. `packages/llm/src/structured.ts:142` decodes with `{ onExcessProperty: "error" }`, because the default strips an undeclared key and succeeds (`packages/llm/src/structured.ts:116-119`).

The LLM-proxy vocabulary is declared once. `packages/llm/src/proxy-config.ts:31,34,40,46` declares `PROXY_BASE_URL_VAR` (`MEMHTML_LLM_BASE_URL`), `PROXY_API_KEY_VAR` (`MEMHTML_LLM_API_KEY`), `PROXY_MODEL_MAP_VAR` (`MEMHTML_LLM_MODEL_MAP`), and `PROXY_MODEL_PREFIX_VAR` (`MEMHTML_LLM_MODEL_PREFIX`), with `DEFAULT_PROXY_MODEL_PREFIX` `bedrock/` (`:49`) and `PROXY_MODEL_PREFIX_NONE`. That's the word `none` and never the empty string, because `Config.String` reads `""` as absent (`:51-58`). `ProxyConfig` (`:60-69`) is the parsed result, a `baseUrl`, a nullable `apiKey`, a `modelPrefix`, and a `modelMap`. `LlmConfig` reads all four through `Config` at `packages/llm/src/client.ts:174-180`. The curator reads them off the raw environment through `proxyConfigFromEnv` (`packages/llm/src/proxy-config.ts:131-133`, `packages/curator/src/model.ts:101`), and both paths resolve a blank value to the default. `proxyRouteFor` (`packages/llm/src/proxy.ts:47-52`) picks `embeddings`, `completions`, or `messages` from the `MODELS` row. The module's header says "three environment variables" (`packages/llm/src/proxy-config.ts:3`) over four declarations, and two of its comments (`:15`, `:78`) still refer to a second copy and a timeout variable that belonged to the removed v1 pipeline.

`OpenAiPromptCache` (`packages/llm/src/wire.ts:69`) is a two-value vocabulary, `off` and `implicit`, read from `MEMHTML_OPENAI_PROMPT_CACHE` (`OPENAI_PROMPT_CACHE_VAR`, `:72`) with `off` as `DEFAULT_OPENAI_PROMPT_CACHE` (`:74`). `openAiPromptCacheFrom` (`:88-98`) trims and lowercases, maps blank to the default, and throws naming the variable and both legal values for anything else, so a typo can't silently put Bedrock's cache-write premium back on every call while the environment claims to have turned it off. `LlmConfig` applies it at `packages/llm/src/client.ts:170-173`, `ModelClientDefaults.openaiPromptCache` (`packages/llm/src/model-client.ts:78-81`) carries it to the OpenAI lane, and the `CONFIG_VARS` row at `apps/cli/src/config.ts:186-191` is what `memhtml manifest` publishes for it.

**Assumptions consumers make:**

- Callers assume `generateObject` returns a value that honors its schema or a typed failure, never a string to re-parse (`packages/llm/src/model-client.ts:24-25`), so `LlmContractViolation` is the only channel a shape mismatch reaches them on. The CLI edge has no `codeFor` arm for that tag (`apps/cli/src/errors.ts:42-102`), so it surfaces to an agent as `ERR_UNKNOWN` with the right message.
- Callers assume the provider is a property of the model, never of the call (`packages/llm/src/models.ts:34-35`), so a `ModelKey` alone decides which wire dialect a request takes.
- The extractor port assumes the client is optional. With `MEMHTML_EXTRACT_ENTITIES` or `MEMHTML_LLM` set to `off` it binds no extractor (`apps/cli/src/api-layer.ts:373`), and a bound extractor that fails costs the batch its extracted entities and never the write (`apps/cli/src/api-layer.ts:341-354`).
- The curator assumes its `--model` spec is judged before any repo opens. `modelSpecOf` is pure so `run.ts` can refuse a bad spec at exit 2 (`packages/curator/src/model.ts:38-41`), and `parseModelSpec` raises `CuratorModelSpecInvalid` for the same reasons inside an effect (`packages/curator/src/model.ts:71-78`).

**Drift risk:** Adding a `ModelKey` literal without a `MODELS` row type-checks and throws at the first `modelByKey` call, which is the intended loud failure, but adding a row whose `provider` is wrong for its id type-checks and fails only at Bedrock. Mitigation: `packages/llm/src/models.ts:90-94` states that the throw exists to fail loudly on a table edited out of agreement with the union; keep the live-probe dates in the table's comments current when a row changes, since they're the only record of which shape each model accepted.

## Sessions against git and the store

A session is a base commit, a ref, and a log of overlay ops, and its commit lands those ops on the ref as one git commit. `@memhtml/session` does this with its own git plumbing and never imports `@memhtml/store`. The two packages meet at two points only, the repository's shared index and the checkout lock that guards it, and the lock's contract lives in `@memhtml/contracts` so neither side has to import the other.

**Producer:** `packages/session/src/session.ts:38-53` for the session and its log, `packages/session/src/commit.ts:399-426` for the commit order, `packages/session/src/plumbing.ts:7-50` for the git plumbing, and `packages/contracts/src/checkout-lock.ts:5-97` for the lock both writers take

**Consumer(s):**

- `packages/session/package.json:25-32` lists `@memhtml/contracts`, `@memhtml/domain`, `@memhtml/html`, `effect`, `proper-lockfile`, and `write-file-atomic`, and no `@memhtml/store`. `packages/session/src/errors.ts:9` re-exports the contracts' `GitFailure`, so a session's git failure is the same class the store raises.
- `packages/session/src/checkout-lock.ts:19-41` and `packages/store/src/checkout-lock.ts:19-44` each bind `withCheckoutLockUsing` (`packages/contracts/src/checkout-lock.ts:128`) to their own `proper-lockfile` acquisition over `CHECKOUT_LOCK_PATH`.
- `packages/session/src/commit.ts:302` takes the lock around `landOnRef`, and `packages/session/src/commit.ts:359` takes it around `settlePending`.
- `packages/store/src/store.ts:1420-1423` takes it inside the store's one in-process permit, so every v1 write method runs as `exclusive`, and `apps/cli/src/operations.ts:2024` calls `store.exclusive` for the one v1 path that stages through `store.git` itself.
- `apps/cli/src/v2.ts:944-996` (`commitOverHead`) is the one caller of `commitSession` for `session commit`, run by the CLI and by the head server alike.

**Shape:**

```typescript
export interface Session {
  /** The repository root. Not persisted: the log is found by root plus id, so it cannot disagree. */
  readonly root: string
  readonly id: string
  readonly baseSha: string
  /** `refs/heads/main` by default; `refs/heads/curate/<date>` for a curator. */
  readonly ref: string
  readonly ops: ReadonlyArray<OverlayOp>
  /**
   * The commit a `commitSession` built and was about to land when the log was last written, or
   * absent. Written before the ref moves and cleared after, so a process killed between the two
   * leaves a record: the next commit checks whether it reached the ref and answers `committed` for
   * it instead of refusing the same ops as duplicates of themselves.
   */
  readonly pending?: string | undefined
}

export const SESSIONS_DIR = ".memhtml/sessions"

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
```

```typescript
export const CHECKOUT_LOCK_PATH = ".memhtml/checkout"

export const CHECKOUT_LOCK_STALE_MS = 10_000

export const CHECKOUT_LOCK_UPDATE_MS = 2_000

export const CHECKOUT_LOCK_WAIT_MS = 15_000

export const CHECKOUT_LOCKED = "checkout.locked"

export type AcquireLockDirectory = (
  target: string,
  options: LockDirectoryOptions
) => Promise<() => Promise<void>>

export const CheckoutLockHeld = Context.Reference<ReadonlySet<string>>(
  "@memhtml/contracts/CheckoutLockHeld",
  { defaultValue: () => new Set<string>() }
)
```

**Assumptions consumers make:**

- The session assumes it must spawn git itself. `packages/session/src/plumbing.ts:7-14` states that a session writes through its own index file, and the store's `Git` service scrubs `GIT_INDEX_FILE` from every child, so the store's client can't stage into a session's index. A commit stages through a temporary index it removes on every outcome (`packages/session/src/commit.ts:514-528`).
- Both sides assume the same set of repo-selecting variables is removed from every child, because a hook exports an absolute `GIT_DIR` that a child would follow (`packages/store/src/git.ts:180-190`). The session's copy at `packages/session/src/plumbing.ts:41-50` says it's "The same list as" the store's at `packages/store/src/git.ts:191-200`. The store's list is pinned by tests to the copy in `apps/cli/src/mount.ts`, and no test compares the session's copy with either.
- Both writers assume the other holds the checkout lock around the window where the shared index and the ref disagree. `packages/contracts/src/checkout-lock.ts:9-20` gives the race it prevents. A v1 commit takes the whole shared index, so without the lock it sweeps a session's just-staged file into its own commit, the session's swap loses, and the rollback stages that file's deletion. The two must agree on the lock's path, its timing, and the reentrancy key (`packages/contracts/src/checkout-lock.ts:22-28`).
- A writer that already holds the lock assumes a nested acquisition runs without waiting on itself (`packages/contracts/src/checkout-lock.ts:88-97`). The held set is a `Context.Reference` per fiber, so it scopes to the holder's own effect and the fibers it forks.
- `landOnRef` assumes the checkout moves before the ref (`packages/session/src/commit.ts:267-283`). The ref must still name the expected commit, a dirty session path is `worktree-dirty`, `read-tree -m -u` moves the shared index and working tree, and `update-ref` is the compare-and-swap. A lost swap rolls the checkout back and answers `rebase-needed`. `packages/session/src/commit.ts:422-424` states the reason for the order. The reverse would leave `HEAD` ahead of the index on a failure, and git would then report the session's own files as staged deletions.
- The commit assumes a killed process can leave a commit half landed. `pending` is written to the log before anything shared is touched (`packages/session/src/commit.ts:537`), and the next commit settles it under the lock (`packages/session/src/commit.ts:335-347`). A landed `pending` answers `committed` with `recovered: true`, and an unlanded one is rolled back with a two-tree merge that leaves another writer's identical bytes in place.
- A lock that never got taken assumes nothing moved, so `CHECKOUT_LOCKED` clears `pending` before it fails the call (`packages/session/src/commit.ts:549-555`).
- One writer per id at a time. `packages/session/src/session.ts:19-25` puts every log write and the whole of a commit under `withSessionLock`, and a second writer fails at once with `session.locked`. `packages/session/src/session.ts:27-35` adds the re-read under the lock, so a writer whose log changed since it read it fails with `session.moved` (`packages/session/src/session.ts:304-319`) and writes nothing.
- The log decoder assumes every `OverlayOp` kind has a branch, and `packages/session/src/session.ts:112-122` makes a missing branch a type error, because a kind the log can hold and can't decode would fail every later call on that session with `session.decode`.

**Drift risk:** The lock's constants are shared, and its filesystem half is written twice, once in each package's `checkout-lock.ts`, with the same `mkdir` and `proper-lockfile` call. A change to one side's target path or lock library leaves two writers that each think they hold the lock while excluding nothing. The repo-selecting list is the same shape of risk, with three copies and one pair pinned. Mitigation: move `checkoutLockTarget` and `acquire` behind one function both packages import, and add a session-side test that pins its `GIT_REPO_SELECTION_ENV` to the store's by value.

## The head against `@memhtml/html` and the store's git

`@memhtml/head` builds an immutable version of the corpus from one commit, with every record parsed by the format package and every byte read through the store's git client. It's the one v2 package that imports `@memhtml/store`, and it takes the store's `GitShape` directly where the indexer declares a port of its own.

**Producer:** `packages/head/src/version.ts:18-201` for the version and its two builders, `packages/head/src/record.ts:9-63` for one file as one record, and `packages/head/src/overlay.ts:147` for a session's ops over a version

**Consumer(s):**

- `packages/head/src/version.ts:4` imports `GitShape`, `GitFailure`, `parseNulPathList`, and `TreeEntry` from `@memhtml/store`. `loadHead` (`packages/head/src/version.ts:111-125`) calls `git.lsTreeR` and `git.catFileBatch`, and `changedPaths` (`packages/head/src/version.ts:148-155`) calls `git.run` with a raw `diff-tree` argv and parses its output with the store's `parseNulPathList`.
- `packages/head/src/record.ts:6` imports `parseMemory` and `contentHash` from `@memhtml/html`, and `recordFrom` (`packages/head/src/record.ts:34-63`) copies the parsed document onto a `MemoryRecord` field by field. `packages/head/src/record.ts:9-16` states that this is the only place a memory file is parsed on the head's read path.
- `packages/head/src/overlay.ts:5` imports `addLink`, `addMeta`, `removeLink`, and `removeMeta` from `@memhtml/html`, so a `link`, `unlink`, `label`, or `unlabel` op rewrites one head line of the file and re-parses it, and `packages/head/src/overlay.ts:2` and `:4` check the rel and the entity with the contracts' `isEdgeRel` and `isWellFormedEntity`.
- `apps/cli/src/head-cache.ts:177-224` builds the version every v2 command reads, from a snapshot, a snapshot advanced by `advanceHead`, or `loadHead`.
- `packages/session/src/validate.ts` and `packages/session/src/commit.ts` take a `HeadView` (`packages/contracts/src/record.ts:52`), the read-only face that `IndexedView` and so `HeadVersion` extend (`packages/head/src/indexes.ts:126`), so the session judges ops against a head without importing the head package.

**Shape:**

```typescript
export interface HeadVersion extends IndexedView {
  readonly sha: string
  readonly parent: HeadVersion | null
  /** Files that were candidates and failed `parseMemory`. Skipped, counted, never thrown. */
  readonly skipped: number
  readonly skippedFiles: ReadonlyArray<SkippedFile>
}

export const isCandidatePath = (path: string): boolean => {
  if (!path.endsWith(MEMORY_EXTENSION)) return false
  if (path.startsWith(".memhtml/")) return false
  const slash = path.lastIndexOf("/")
  const base = slash === -1 ? path : path.slice(slash + 1)
  return base !== "index.html"
}

export const blobShaOf = (html: string): string => {
  const bytes = Buffer.from(html, "utf8")
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
}
```

**Assumptions consumers make:**

- A version built from scratch and one built by advancing agree node for node, because both fold the same `insertRecord` (`packages/head/src/version.ts:105-110`, `:127-135`). `advanceHead` removes every changed path, re-parses the ones still present at the target, and keeps the parent's record object when the blob sha is unchanged (`packages/head/src/version.ts:157-164`).
- `changedPaths` assumes `--no-renames` and `-z` for the reasons the store's own tree diff gives. A rename must contribute both paths, and a non-ASCII path must arrive unquoted (`packages/head/src/version.ts:142-147`).
- A file that doesn't parse is a counted skip and never a failure of the load (`packages/head/src/version.ts:29-31`, `:70-99`). A version built from a snapshot reports zero skips, because a snapshot holds records only (`packages/head/src/version.ts:127-135`).
- `blobShaOf` assumes a SHA-1 object-format repository. `packages/head/src/record.ts:18-24` computes the sha locally because an overlay holds files git hasn't seen. The one reader is the reparse check at `packages/head/src/version.ts:181`, so in a SHA-256 repository every changed path is re-parsed on each advance, and the snapshot's `blobSha` column holds values git never produces.
- `recordFrom` hashes the parsed document with `contentHash(doc)` (`packages/head/src/record.ts:43`), and the indexer hashes `doc.article.html` (`packages/index/src/indexer.ts:311`). `packages/html/src/hash.ts:150-161` takes either input and canonicalizes the article first, which is what keeps the two read paths' content hashes equal.
- The head and the index decide which files are memories with two different rules. The head's `isCandidatePath` admits any `.html` path outside `.memhtml/` whose filename isn't `index.html`. The indexer's `isIndexablePath` also requires a PARA bucket as the first segment and refuses `sitemap.xml` (`packages/index/src/indexer.ts:242-251`). So a `.html` file outside the four buckets, such as the root `README.html` that `memhtml init` writes, is a head candidate and never an index row.

**Drift risk:** A format rule added to `parseMemory` reaches the head and the index at once, which is the intended coupling. A change to either candidate rule reaches one read path only, and an agent that searches through the head (the MCP default) and lists through the index sees two corpora that differ by those paths. Mitigation: state the candidate rule once in `@memhtml/contracts/paths` beside `MEMORY_EXTENSION` and import it from both packages.

## The head server protocol

`memhtml head serve` holds one loaded version per store and answers over a local socket, and the CLI's v2 commands and the MCP server ask it before they load a head themselves. `apps/cli/src/head-protocol.ts` is the wire contract for both halves: seven routes under one version prefix, a request schema per route, and an answer schema per route.

**Producer:** `apps/cli/src/head-protocol.ts:7-29` for the routes, `apps/cli/src/head-protocol.ts:156-384` for the requests and their bounds, `apps/cli/src/head-protocol.ts:386-827` for the answers, and `apps/cli/src/head-server.ts:1353-1477` for the routing

**Consumer(s):**

- `apps/cli/src/head-client.ts:148-219` (`askHeadFor`) sends one request and reports how it ended, and `apps/cli/src/head-client.ts:226-229` (`askHead`) collapses every ending but `answered` to `null`.
- `apps/cli/src/v2.ts:632-647` asks `neighbors` for `session put`, `apps/cli/src/v2.ts:1120-1126` asks `commit` for `session commit`, and `apps/cli/src/v2.ts:1241-1247` asks `rebase` for `session rebase`. `session exec`, `head status`, and `head search` ask the `exec`, `status`, and `search` routes (`apps/cli/src/v2.ts:130-140`).
- `apps/cli/src/head-retrieval.ts:94-118` asks `search` with a scope and `detail: true` for the MCP server's `memory_search` and `memory_recall`.
- `apps/cli/src/head-server.ts:1265-1275` runs a commit under the server's one commit permit, reading the store's policy per request.

**Shape:**

```typescript
export const HEAD_PROTOCOL = "1"

export const HEAD_ROUTES = {
  status: `/v${HEAD_PROTOCOL}/status`,
  search: `/v${HEAD_PROTOCOL}/search`,
  read: `/v${HEAD_PROTOCOL}/read`,
  neighbors: `/v${HEAD_PROTOCOL}/neighbors`,
  exec: `/v${HEAD_PROTOCOL}/exec`,
  commit: `/v${HEAD_PROTOCOL}/commit`,
  rebase: `/v${HEAD_PROTOCOL}/rebase`
} as const

export const CommitRequest = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
  dropRefused: Schema.optionalKey(Schema.Boolean)
})

export const RebaseRequest = Schema.Struct({ id: Schema.String })

export const CommitDeclined = Schema.Literals([
  "other-ref",
  "session-unreadable",
  "base-unservable",
  "busy"
])

export const CommitAnswer = Schema.Union([
  Schema.Struct({
    served: Schema.Literal(true),
    base: CommitBase,
    outcome: CommitResult,
    head: ServedHead
  }),
  Declined
])
```

`status` is a `GET`, and the other six are `POST` with a JSON body. `search` takes the input `searchHead` takes plus `embedDeadlineMs`, `scope`, and `detail` (`apps/cli/src/head-protocol.ts:183-202`). `read` takes a path. `neighbors` takes the session's base sha, its log, the new `session put` lines, and the write instant (`apps/cli/src/head-protocol.ts:266-280`). `exec`, `commit`, and `rebase` name the session and nothing about its state, because the server reads the log itself (`apps/cli/src/head-protocol.ts:294-306`, `:339-363`). `CommitResult` (`apps/cli/src/head-protocol.ts:726-764`) is the same four-kind outcome the local commit returns, and `RebaseResult` (`:808-819`) is the base it moved from and to, whether it moved, and the op count.

**Assumptions consumers make:**

- The server assumes a request body with a key its schema doesn't declare is a caller error. Every route decodes with `onExcessProperty: "error"` (`apps/cli/src/head-server.ts:1364-1367`, `:1417-1419`, `:1424-1426`, `:1451-1453`, `:1457-1459`), and `apps/cli/src/head-protocol.ts:12-14` compares it to the CLI refusing an unknown flag. A newer client's new field therefore reads as a 400 on an older server, which is why `runBound` and `dropRefused` are sent only when true (`apps/cli/src/head-protocol.ts:304`, `:342`).
- The client assumes the opposite for answers. `askHeadFor` decodes with the schema's default (`apps/cli/src/head-client.ts:178`), which drops an undeclared key, so a newer server's extra answer field reads fine on an older client.
- Status codes carry the failure class (`apps/cli/src/head-server.ts:1441-1476`). A body that fails its schema, or an `exec` body that isn't usable, is 400 with `ERR_INVALID_FLAG`. An `exec` body over `EXEC_BODY_MAX_BYTES` (1 MiB, `apps/cli/src/head-protocol.ts:283-292`) is 413 with `ERR_INVALID_FLAG`. An unknown route is 404 with `ERR_UNKNOWN_COMMAND` naming the routes. Any other failure is 500 with the CLI's own `failureFor` envelope. Each error body is the CLI's failure envelope.
- Every caller assumes a server can only make a call faster. `apps/cli/src/head-client.ts:14-19` states that `askHead`'s `null` covers no socket, nobody listening, a connect past 100 ms (`:44`), an answer past 10 s (`:51`), a non-200 status, and a body the schema refuses, and the caller then takes the local path.
- Commit and rebase can't take that shortcut, because they have an effect. `Asked` (`apps/cli/src/head-client.ts:122-136`) separates `no-server` (the connection never completed, so nothing ran), `refused` (a status other than 200), and `lost` (connected, then no usable answer). `unanswered` (`apps/cli/src/v2.ts:1039-1077`) commits locally on `no-server` or a 4xx, which the server answers before it reads the log, and fails with `StorageFailure` naming `session status` on a 5xx or `lost`, because the server may have moved the ref.
- A declined commit or rebase did nothing, and the client commits locally (`apps/cli/src/head-protocol.ts:775-787`). The server declines when the session's ref isn't the server's, its log didn't read, its base couldn't be built, or another commit held the permit past `COMMIT_QUEUE_WAIT_MS` (20 s, `apps/cli/src/head-protocol.ts:378-384`). The client waits up to `COMMIT_DEADLINE_DEFAULT_MS` (60 s, `apps/cli/src/head-protocol.ts:366-376`), which `MEMHTML_COMMIT_DEADLINE_MS` overrides. `apps/cli/src/v2.ts:1079-1083` adds `via` and `server` to the outcome, so the payload says which process committed and why.
- The endpoint is derived from the store path alone, on both sides (`apps/cli/src/head-protocol.ts:33-75`). On Linux and macOS it's `.memhtml/head.sock`, bound with mode 0600 (`apps/cli/src/head-server.ts:183-191`), and a path past 107 bytes on Linux or 103 on macOS is never bound or dialed (`apps/cli/src/head-protocol.ts:77-110`). Under win32 it's the named pipe `\\.\pipe\memhtml-<16 hex>` from the SHA-256 of the resolved store path (`apps/cli/src/head-protocol.ts:48-57`).

**Drift risk:** None. The protocol imports the session log's op union (`OverlayOpSchema` from `@memhtml/session`, `apps/cli/src/head-protocol.ts:4` and `:250`; defined at `packages/session/src/session.ts:93`), so every kind a log can hold, `move` included, crosses the wire, and the compile-time guard at `packages/session/src/session.ts:128-133` makes a kind the contract gains and the schema lacks a type error.

## Snapshots and the vector cache against their readers

`@memhtml/snapshot` writes two kinds of Arrow IPC file under `.memhtml/`: a snapshot of every record at one commit, and a vector cache of one embedding space keyed by content hash. Both are caches of the git tree, and the contract with their readers is mostly about what a reader does with a file it can't use.

**Producer:** `packages/snapshot/src/snapshot.ts:1-68` and `:320-528` for snapshots, `packages/snapshot/src/vectors.ts:1-92` and `:190-249` for the vector cache, and `packages/snapshot/src/prune.ts:14-22` for retention

**Consumer(s):**

- `apps/cli/src/head-cache.ts:131-165` (`cachedRecords`) reads a snapshot as a cache of one sha, and `apps/cli/src/head-cache.ts:177-224` (`loadVersion`) tries the sha's own snapshot, then each ancestor snapshot in the order `ancestorSnapshots` ranks them (`apps/cli/src/head-cache.ts:88-119`), then git.
- `apps/cli/src/head-cache.ts:35-37` names the write side. `writeHeadSnapshot` prunes to `SNAPSHOTS_KEPT`, and `snapshotAfterCommit` is the best-effort write after every ref-moving commit, called from `apps/cli/src/v2.ts:983-986`. The head server writes the snapshot of a commit it served before it answers (`apps/cli/src/head-server.ts:172-175`).
- `apps/cli/src/head-vectors.ts:146-161` (`loadForSearch`) reads the vector cache for a search, and `apps/cli/src/head-vectors.ts:367-387` reads and rewrites it for `head embed`.
- `apps/cli/src/head-protocol.ts:390-398` publishes `HeadSourceSchema` and the vector skip reasons, so a served answer reports which source built its version and why a search ran without vectors.

**Shape:**

```typescript
export const SHA_METADATA_KEY = "sha"

export const FORMAT_METADATA_KEY = "format"

export const SNAPSHOT_FORMAT = "1"

export const SNAPSHOTS_DIR = ".memhtml/snapshots"

export const snapshotPathFor = (root: string, sha: string): string =>
  join(root, SNAPSHOTS_DIR, `${sha}.arrow`)

export const VECTOR_CACHE_FORMAT = "1"

export const VECTORS_DIR = ".memhtml/vectors"

export const vectorCachePathFor = (root: string, space: StoredVectorSpace): string =>
  join(
    root,
    VECTORS_DIR,
    `${space.modelId.replace(/[^A-Za-z0-9._-]/g, "_")}@${String(space.dimension)}.arrow`
  )
```

**Assumptions consumers make:**

- A reader checks the format key before anything else, because a file of another layout may hold anything under the other keys (`packages/snapshot/src/snapshot.ts:473-477`, `packages/snapshot/src/vectors.ts:217-224`). A file with no format key was written before the key existed and reads as format "1" (`packages/snapshot/src/snapshot.ts:63-68`). That fallback is fixed at "1", so a later format still refuses those files.
- Every snapshot refusal is a cache miss and never the load's failure (`apps/cli/src/head-cache.ts:167-176`). `readSnapshot` names each step it refuses at, from `snapshot.read.file` through `snapshot.read.rows` (`packages/snapshot/src/snapshot.ts:495-503`). `cachedRecords` keeps an unreadable file with a warning and deletes every other refused file, including a file whose metadata names a sha other than the one its filename names, so the next write of that sha lands in its place (`apps/cli/src/head-cache.ts:131-139`).
- A vector cache of another format reads as absent with a warning and is left in place, and the next `head embed` rewrites it whole (`packages/snapshot/src/vectors.ts:16-19`). Any other refusal is a `StorageFailure` (`packages/snapshot/src/vectors.ts:198-201`). A search reports it as `cache-unreadable` with the step's name and runs without vectors (`apps/cli/src/head-vectors.ts:150-156`), and `head embed` reads the same file with no catch (`apps/cli/src/head-vectors.ts:369`), so one that doesn't decode fails the fill until it's removed.
- The vector cache's space lives in the filename and in the metadata, and a reader refuses a file whose metadata names another model id or dimension (`packages/snapshot/src/vectors.ts:7-9`, `:225-230`), because two model ids can sanitize to one filename.
- Writers assume a reader never sees a half-written file. Both write through `write-file-atomic` with a staging name unique to the process, thread, and call, so a `session commit` and the head server can write one sha at once and the last rename wins (`packages/snapshot/src/snapshot.ts:320-328`). There's no `fsync`, because a lost file is a miss. A staging file an hour old is swept as abandoned (`packages/snapshot/src/staging.ts:20-25`).
- Retention assumes the newest four snapshots by mtime are the ones a load asks for (`packages/snapshot/src/prune.ts:14-20`). `listSnapshots` matches names against `/^([0-9a-f]{40})\.arrow$/` (`packages/snapshot/src/prune.ts:22`), so in a SHA-256 repository a snapshot's own-sha read still works, and the ancestor path and pruning never see the file.

**Drift risk:** Two builds on one store that disagree on `SNAPSHOT_FORMAT` delete each other's snapshots. The older build reads the newer file as another format and removes it, and the newer build rewrites it after its next commit. Neither fails, and both pay a git load more often than either would alone. Mitigation: move `SNAPSHOT_FORMAT` only with a release note, and treat a format move like a migration that every process on a store takes together.

## The store's policy file

`memhtml.config.json` at the store root states what every process writing to one store must agree on: the write bar a session is judged by, whether the v1 record doors are open, and the curator's placement rules. The contracts package owns the schema and the defaults, and the CLI owns the read.

**Producer:** `packages/contracts/src/store-config.ts:5-230`

**Consumer(s):**

- `apps/cli/src/store-config.ts:64-93` (`loadStorePolicy`) reads and decodes the file, and `apps/cli/src/store-config.ts:27-36` lists when it's read.
- `apps/cli/src/v2.ts:654`, `:916`, `:1116`, and `:1635` read it for `session put`, `session exec`, `session commit`, and `curate merge`, and `apps/cli/src/curate-run.ts:565` and `apps/cli/src/curate-collapse.ts:893` read it for the curator.
- `apps/cli/src/head-server.ts:1096`, `:1271`, and `:1427` read it per `exec`, `commit`, and `neighbors` request, so an edit applies to the server's next request with no restart.
- `apps/cli/src/run.ts:1712-1723` reads `v1Doors` before validation for the four record-creating v1 commands, and `apps/cli/src/run.ts:366`, `:396`, `:450`, and `:539` and `apps/mcp/src/handlers.ts:338`, `:406`, and `:658` call `guardV1Door` inside the layer when the mode couldn't be read first.
- `packages/session/src/validate.ts:131-145` applies the write bar's `refusedTypes` and `requireAnchor` as `write-bar` violations.

**Shape:**

```typescript
export const STORE_CONFIG_FILE = "memhtml.config.json"

export const V1_DOOR_MODES = ["open", "closed-in-session", "closed"] as const

export const PLACEMENT_QUOTA_MAX = 200

export const DEFAULT_PLACEMENT_QUOTA = 60

export const StoreConfig = Schema.Struct({
  writeBar: Schema.optionalKey(
    Schema.Struct({
      /** Types no session may write, the curator's included. Default: none. */
      refusedTypes: Schema.optionalKey(Schema.Array(RefusedType)),
      /**
       * Every new record must name what it is about: a `memhtml-entity`, or a path under
       * `projects/<slug>/`. Also holds a `move` destination and an `unlabel` that drops a record's
       * last entity. Default: off.
       */
      requireAnchor: Schema.optionalKey(Schema.Boolean)
    })
  ),
  v1Doors: Schema.optionalKey(Schema.Literals(V1_DOOR_MODES)),
  curator: Schema.optionalKey(
    Schema.Struct({
      writerBuckets: Schema.optionalKey(Schema.Array(BucketPattern)),
      /** Inbox records one `curate run` should file. Default {@link DEFAULT_PLACEMENT_QUOTA}. */
      placementQuota: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: PLACEMENT_QUOTA_MAX }))
      )
    })
  )
})
```

**Assumptions consumers make:**

- Every reader assumes a file that doesn't decode is a refusal and never the defaults. `packages/contracts/src/store-config.ts:14-17` states that a typo in a policy file shouldn't loosen the policy it meant to state. `decodeStoreConfig` refuses JSON that doesn't parse, an excess key at any depth, a value outside its type, and a type listed twice (`packages/contracts/src/store-config.ts:187`, `:194-230`). `apps/cli/src/store-config.ts:38-43` turns that into `StoreConfigInvalid`, which every command that needs the policy reports as `ERR_STORE_CONFIG` at exit 1 (`apps/cli/src/envelope.ts:157-160`).
- An absent file is the library's defaults, and so is a path where a parent isn't a directory. `ENOENT` and `ENOTDIR` read as no file, and every other read error fails closed (`apps/cli/src/store-config.ts:69-85`).
- The defaults are neutral (`packages/contracts/src/store-config.ts:9-12`, `:117-134`). The write bar refuses no type and requires no anchor, `v1Doors` is `closed-in-session`, the curator has no writer buckets, and the placement quota is 60.
- `session commit` reads the policy before it asks the head server, so a broken file refuses with `ERR_STORE_CONFIG` before the server sees the request (`apps/cli/src/v2.ts:1114-1116`).
- `PLACEMENT_QUOTA_MAX` restates the session's `BATCH_CAP` of 200 because the contracts package can't import the session (`packages/contracts/src/store-config.ts:40-45`), and a quota above the cap could never land in one commit.
- `v1Doors` assumes `MEMHTML_SESSION` marks a process inside an agent runtime's run (`packages/contracts/src/store-config.ts:23-36`). Under `closed-in-session` such a process gets `ERR_SESSION_BOUND` from `memhtml write`, `apply`, `correct`, `task add`, and the MCP `memory_write`, `memory_write_batch`, and `memory_correct` tools. Under `closed` every process gets `ERR_V1_DOOR_CLOSED`. Both are usage codes at exit 2 (`apps/cli/src/run.ts:990-1016`, `apps/cli/src/run.ts:2416-2421`).
- The session validator assumes no session writes the policy file, and `packages/session/src/validate.ts:80-81` lists `STORE_CONFIG_FILE` as a store file no scope writes.

**Drift risk:** The strict decode makes the file's schema a version contract between every build that touches a store. A key added in a newer build is an excess key to an older one, so every older process on the store refuses every command that needs the policy with `ERR_STORE_CONFIG` once the file uses it, the head server included. The `apps/cli/src/store-config.ts:30-33` list of readers names the server's `neighbors` and `exec` routes and omits `commit`. Mitigation: ship a new key in a release before any store's file uses it, and say in the changelog which version first reads it.

## `CuratorTools` and its binder

`@memhtml/curator` owns the model loop and the tools the model sees, and owns no head, session, or sandbox. It takes those through `CuratorTools`, an interface of five promise-returning methods, and `apps/cli` binds it to the real head, a session on disk, and the `session exec` sandbox. The interface exists because the sandbox lives in `apps/cli` and a package can't import an app (`packages/curator/src/tools.ts:5-13`).

**Producer:** `packages/curator/src/tools.ts:15-201`

**Consumer(s):**

- `packages/curator/src/loop.ts:152-188` registers the five methods as the model's tools, through the AI SDK, and cuts every result at `TOOL_RESULT_CAP`, 30,000 characters (`packages/curator/src/loop.ts:40`).
- `apps/cli/src/curate-run.ts:357-460` (`bindTools`) is the production binder, called by `curate run` at `apps/cli/src/curate-run.ts:613` and by `curate collapse` at `apps/cli/src/curate-collapse.ts:651`.
- `packages/curator/src/tools.ts:2` imports `Violation` from `@memhtml/session`, so the violations a tool returns are the session validator's own type.

**Shape:**

```typescript
export interface CuratorExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
  readonly ops: ReadonlyArray<OpSummary>
  readonly appended: number
  readonly rejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>
  readonly violations: ReadonlyArray<Violation>
}

export interface CuratorProposeResult {
  readonly appended: number
  readonly violations: ReadonlyArray<Violation>
}

export interface CuratorTools {
  search(query: string, limit: number): Promise<ReadonlyArray<CuratorSearchHit>>
  read(path: string): Promise<CuratorRecordView | null>
  exec(script: string): Promise<CuratorExecResult>
  propose(ops: ReadonlyArray<OverlayOp>): Promise<CuratorProposeResult>
  status(): Promise<CuratorSessionStatus>
}
```

The model doesn't propose `OverlayOp` directly. `ProposedOp` (`packages/curator/src/tools.ts:91-162`) is a Zod union where an `archive` or a `move` names only its source and destination, and `toOverlayOps` (`packages/curator/src/tools.ts:168-201`) reads the source's bytes through `read` to fill the op's `html`, so a model never restates a whole file. A source `read` can't find comes back in `missing` instead of being dropped.

**Assumptions consumers make:**

- The loop assumes a rejected proposal is a tool result and never the end of the run (`packages/curator/src/loop.ts:31-37`). `propose` returns the violations, and the model reads them and tries again.
- The binder judges every new op on top of what the overlay already holds, under the `curate` scope and the store's write bar (`apps/cli/src/curate-run.ts:369-391`). Any violation on a path the new ops touch, or the batch cap, refuses them. `apps/cli/src/curate-run.ts:372-375` states why there's no non-blocking kind here. A curator's ref has no rebase that cures a `duplicate` or a `claim-edit`, so one appended op with either would leave the session uncommittable.
- `exec` runs the script as JavaScript (`apps/cli/src/curate-run.ts:412-414`) and appends its harvest only when the script exited 0 and nothing blocks (`apps/cli/src/curate-run.ts:419-420`). Its result's `violations` field carries everything the validator reported over the whole would-be batch, while `propose` returns only the blocking subset (`apps/cli/src/curate-run.ts:434`, `:447`).
- A proposed or harvested `move` or `archive` names only its source and destination. The binder adds the `unlink` and `link` pairs that repoint every edge to the old path (`withRepoints`, `apps/cli/src/curate-run.ts:415-417`, `:441-444`), because the validator refuses a batch that leaves an edge pointing at a path a move or an archive vacated (`packages/contracts/src/record.ts:68-80`).
- `search` ranks the overlaid view with `searchHead` and no vectors (`apps/cli/src/curate-run.ts:394-405`), so the curator searches with the lexical arm alone and recency breaks ties.
- `status` reports the session's base, ref, and op counts by kind (`packages/curator/src/tools.ts:68-81`), and the loop adds the steps and tokens it has spent.

**Drift risk:** `packages/curator/src/tools.ts:164-166` declares its own `archivePathFor(path, now)`, beside the contracts' `archivePathFor(path, year)` (`packages/contracts/src/paths.ts:217`). The curator's copy takes a `Date`, reads the UTC year, and doesn't normalize the path, and the contracts' copy normalizes it and formats the year segment itself. The two agree for the normalized paths `read` resolves, and the session validator checks every destination with the contracts' inverse (`packages/session/src/validate.ts:299-301`), so a divergence would show up as a refused archive and never as a misplaced file. The risk is a change to one rule that doesn't reach the other. Mitigation: call the contracts' function with `now.getUTCFullYear()` and drop the local copy.

## MCP search and recall against the head server

The MCP server answers `memory_search` and `memory_recall` from the head server when it can, and from the index otherwise. The head follows the ref and never lags it, while the index is a projection someone has to update, so a record a run session commits is in the head's next answer and in the index only after the next `memhtml index update` (`apps/cli/src/head-retrieval.ts:19-27`).

**Producer:** `apps/cli/src/head-retrieval.ts:37-214`

**Consumer(s):**

- `apps/mcp/src/handlers.ts:581` answers `memory_search` with `searchOnHead`, falling back to `searchMemories` when it returns `null`.
- `apps/mcp/src/handlers.ts:619` answers `memory_recall` with `recallOnHead`, falling back to `recallMemories` the same way.
- `apps/mcp/src/handlers.ts:1-30` imports both from `@memhtml/cli`, so the MCP app holds no head code of its own.

**Shape:**

```typescript
export const HEAD_RETRIEVAL_TIMEOUT_MS = 2_000

export type Routing = { readonly route: "head" } | { readonly route: "index"; reason: IndexReason }

export const routeFor = (
  params: SearchParams | RecallParams,
  env: Readonly<Record<string, string | undefined>> = process.env
): Routing => {
  if (env[MCP_HEAD_VAR]?.trim().toLowerCase() === "off")
    return { route: "index", reason: "disabled" }
  if (params.includeArchived === true) return { route: "index", reason: "include-archived" }
  if (params.asOf !== undefined && params.asOf !== "") return { route: "index", reason: "as-of" }
  if (params.query.includes('"')) return { route: "index", reason: "phrase" }
  if (!hasFtsTerms(params.query) || tokenize(params.query).length === 0)
    return { route: "index", reason: "no-terms" }
  return { route: "head" }
}
```

**Assumptions consumers make:**

- The handlers assume the head's answer has v1's shape exactly, so they shape it with the code they already had and an agent can't tell the doors apart by the fields (`apps/cli/src/head-retrieval.ts:29-32`). `searchOnHead` maps each detailed hit onto a `SearchHit` and the scope report onto `scopeEmpty`, `archivedMatches`, and `archived` (`apps/cli/src/head-retrieval.ts:144-164`). `recallOnHead` asks for v1's candidate pool and folds it with v1's own `foldDisclosure`, arcs under their envelope and the rest under the budget (`apps/cli/src/head-retrieval.ts:167-214`).
- The ranking isn't v1's. The head fuses BM25 and the vector arm by RRF with recency as the tie-break, where v1 also fuses recency and salience arms and diversifies with MMR (`apps/cli/src/head-retrieval.ts:30-32`). `arms` reports `fts`, `vector` when it ran, and `recency` (`apps/cli/src/head-retrieval.ts:120-125`), so an agent reading `arms` can tell which door ranked a result.
- A call goes to the index for each thing the head can't answer the way the index would (`apps/cli/src/head-retrieval.ts:44-60`): `MEMHTML_MCP_HEAD=off`, `include_archived`, `as_of`, a double-quoted phrase, or a query with no term the head's BM25 indexes. Every other parameter routes to the head (`apps/cli/src/head-retrieval.ts:64-67`).
- The socket gets 2 s once connected (`apps/cli/src/head-retrieval.ts:37-42`), and any answer short of a scoped, detailed one is `null`, so the call goes to the index. `apps/cli/src/head-retrieval.ts:110-116` treats an answer with no `scope`, or a hit with no `detail`, as another protocol and falls back.
- `MEMHTML_MCP_HEAD` is read per call (`apps/cli/src/head-protocol.ts:145-150`), so an operator can send every call to the index with no restart.
- A head answer reports `degraded: true` whenever the vector arm didn't run and `vectorCoverage` as the server's coverage, or `0` when the server reported none (`apps/cli/src/head-retrieval.ts:157-158`, `:211-212`).

**Drift risk:** The head answer and the index answer share one TypeScript type and two rankings, so a field the index fills from SQL has to be filled from a record on the head side, by hand, in `hitDetailOf` (`apps/cli/src/head-scope.ts:167`). A required field added to `SearchHit` type-checks on the index path and fails to compile here until the mapping at `apps/cli/src/head-retrieval.ts:144-164` names it, which is the guard. A change to what an existing field means on one side has no such guard. Mitigation: add an integration test that runs one scoped query through both doors over one fixture and compares every field but `score`. `tests-integration/tests/mcp-search-head.test.ts` already runs both doors over one store, and checks that the head finds a record the index hasn't caught up to.

## The contract an agent runtime holds

An agent runtime that gives each run one session talks to memhtml through the CLI's JSON envelopes, one environment variable, and one file per session. It exports `MEMHTML_SESSION` to every subprocess of a run, lets the agent write through `session put` and `session exec`, and commits the session once when the run ends. Each piece is a contract the runtime depends on and the CLI publishes.

**Producer:** `apps/cli/src/config.ts:83-105` for `MEMHTML_SESSION`, `apps/cli/src/run.ts:931-988` for how a session command resolves its id, `apps/cli/src/v2.ts:1079-1298` for the commit, rebase, and status payloads, `packages/session/src/session.ts:13-25` and `:57-70` for the log on disk, and `apps/cli/src/envelope.ts:92-103` for the envelope

**Consumer(s):**

- An agent runtime, which reads `session status` and `session commit` payloads by key and may stat or read the log file. Nothing in this repository is that consumer, and the contract is stated here from the producer's side.
- `apps/cli/src/commands.ts:1348-1409` documents `session commit`, `--drop-refused`, `--no-server`, and `session rebase` in the command table, so `memhtml manifest` and the generated agent doc publish the same text.
- `apps/cli/src/run.ts:990-1016` closes the v1 record doors in a process that carries `MEMHTML_SESSION`, under the store's default `v1Doors` mode.

**Shape:**

```typescript
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

export const SESSION_VAR = "MEMHTML_SESSION"

export const sessionStateFile = (root: string, id: string): string =>
  join(root, SESSIONS_DIR, `${id}.json`)

export type SessionCommitted = CommitResult & {
  readonly via: "server" | "local"
  readonly server: CommitServerUse
}
```

`session status` answers `session.status` with `data` holding `id`, `ref`, `baseSha`, `refSha`, `behind`, `ops` (the log's op count), one count per op kind (`puts`, `archives`, `links`, `unlinks`, `labels`, `unlabels`, `moves`), `paths` (every path the log touches, sorted), and `pending` (`apps/cli/src/v2.ts:1271-1298`). `session commit` answers `session.committed` with a `CommitResult` (`apps/cli/src/head-protocol.ts:726-764`) whose `kind` is `committed`, `rebase-needed`, `refused`, or `worktree-dirty`, plus `snapshot`, `dropped`, `via`, and `server`. `session rebase` answers `session.rebased` with `from`, `baseSha`, `moved`, `ops`, `head`, `via`, and `server` (`apps/cli/src/v2.ts:1222-1269`).

**Assumptions consumers make:**

- The runtime assumes the session's log is `<store>/.memhtml/sessions/<id>.json` (`packages/session/src/session.ts:15`, `:69-70`). An id is one path segment of letters, digits, `.`, `_`, and `-`, at most 128 characters, starting with a letter or digit (`packages/session/src/session.ts:61-62`). A bad id on the line or in the variable is `ERR_INVALID_FLAG` at exit 2 before any repo opens (`apps/cli/src/run.ts:931-971`).
- The runtime assumes it never has to start the session. When `session put` or `session exec` takes its id from `MEMHTML_SESSION` and no log exists, the call starts the session on the main ref's tip, and two subagents that start it at once both go on with the one log (`apps/cli/src/v2.ts:425-441`).
- A session whose id is the variable's is run-bound, whether or not the id is also spelled on the line (`apps/cli/src/run.ts:973-988`). A run-bound put or exec also refuses `duplicate` and `claim-edit` ops at write time (`apps/cli/src/v2.ts:341-354`), so the log the runtime commits holds only ops that were clean when written.
- The runtime branches on `data.kind`, because every commit outcome is a success envelope at exit 0 (`apps/cli/src/run.ts:2375`). `refused` carries the violations, `rebase-needed` carries `overlapping` and `mainSha`, and `worktree-dirty` carries the dirty paths. A failure envelope at exit 1 means the commit itself failed, such as `checkout.locked` after 15 s or a server that took the commit and didn't answer (`apps/cli/src/v2.ts:1039-1046`), and `session status` is the next call in both cases.
- `--drop-refused` assumes the runtime would rather land a run's clean ops than lose them all to one bad op. Each round drops every op that touches a path a violation names, records it in `.memhtml/sessions/<id>.dropped.jsonl`, and commits again, until the commit is clean, the log is empty, or a violation names no path, which only the batch cap does (`apps/cli/src/v2.ts:965-982`, `:1160-1198`). `dropped` lists each removed op with its reasons.
- `rebase-needed` is returned and never retried by the CLI (`apps/cli/src/v2.ts:941-942`). The runtime runs `session rebase`, which keeps every op and moves the base to the ref's tip, and commits again, because a rebase can turn the outcome into `refused`.
- A committed session keeps its log with zero ops and its base at the new commit (`packages/session/src/commit.ts:569-571`), so `session status` after a commit shows `ops: 0`. `session prune --older-than` removes such logs once they're older than the cutoff and never removes a log that holds ops (`packages/session/src/prune.ts:29-39`).

**Drift risk:** The payload keys above are the whole interface, and none of them is versioned apart from the envelope's `apiVersion`, which stays `"1"`. Renaming `ops` or `paths` in `sessionStatus`, or adding a fifth commit `kind`, passes every test in this repository and breaks a runtime that reads the old key or switches over four kinds. Mitigation: treat these keys and the four kinds as append-only, as the envelope's discriminators already are, and give a changed payload a new `RESPONSE_TYPES` entry.

## Other contracts

- **`EmbedPort` and `QueryEmbedPort`**: two narrow ports the index declares over `@memhtml/llm`'s `EmbeddingsShape`, split because the document and query halves use different Bedrock `input_type` values and reusing one silently degrades retrieval (`packages/index/src/indexer.ts:27-32`, `packages/index/src/retrieval.ts:199-202`, `packages/llm/src/embeddings.ts:18-25`).
- **`IndexerShape` and its reports**: `RebuildReport` and `UpdateReport` carry counted skips so one unparseable file never fails a pass, and `EmbedMissingOptions` distinguishes a whole-store model migration from an incremental pass by the presence of a candidate list (`packages/index/src/indexer.ts:34-146`).
- **`CONFIG_VARS`**: 25 documented environment variables in one array so `memhtml manifest` can describe the whole environment surface and an agent doesn't have to grep for `process.env` (`apps/cli/src/config.ts:107-275`). A row whose variable another module declares takes its `name` from that module's constant, such as `CURATOR_MODEL_VAR`, `COMMIT_DEADLINE_VAR`, `EXEC_POOL_SIZE_VAR`, and `MCP_BIN_VAR`, so a rename can't disclose a variable nothing reads (`apps/cli/src/config.ts:265-270`). Each row is paired with a read elsewhere. `MEMHTML_ROOT` (`apps/cli/src/config.ts:282`), `MEMHTML_TRACE_ROOT` (`apps/cli/src/config.ts:294`), and `MEMHTML_VECTOR_COVERAGE_FLOOR` (`apps/cli/src/config.ts:307`) are read with `Config.String`, `Config.String`, and `Config.Number`. `MEMHTML_AWS_REGION`, `MEMHTML_OPENAI_PROMPT_CACHE`, and the four proxy variables are `Config.String` inside `LlmConfig` at `packages/llm/src/client.ts:163,170,175,176,179,180`. `MEMHTML_EMBED`, `MEMHTML_EXTRACT_ENTITIES`, and `MEMHTML_LLM` are `Config.String` at `apps/cli/src/api-layer.ts:236,365,369`. The v2 variables are read off the environment directly, as `MEMHTML_MCP_HEAD` is through `MCP_HEAD_VAR` at `apps/cli/src/head-retrieval.ts:72` and `MEMHTML_CURATOR_MODEL` through `CURATOR_MODEL_VAR` at `apps/cli/src/run.ts:2220`, and `memhtml config` reports the three that tune `head serve` with their effective values and sources (`apps/cli/src/config-report.ts:58-75`). The row is what `memhtml manifest` publishes and the read is what the process honors. A row with no read discloses a variable nothing honors, and a read with no row is a variable an agent can't discover.
- **`REINFORCE_SIGNALS`**: the closed three-value vocabulary `positive`, `negative`, `neutral`, declared once in `@memhtml/domain` (`packages/domain/src/reinforce.ts:31-32`) and published to both agent surfaces the way `MEMORY_RELS` and `WRITABLE_MEMORY_TYPES` are. `apps/cli/src/commands.ts:4,539` makes it the `values` of the `--signal` flag with `neutral` as the default, `apps/cli/src/operations.ts:17,177-184` narrows an untrusted string through `decodeSignal`, failing with an `InvalidMemory` whose reason lists the three values, and `apps/mcp/src/tools.ts:17,898` makes it `Schema.Literals(REINFORCE_SIGNALS)` on `memory_reinforce`. `signalValue` (`:39-48`) is a `switch` over the literal union with no default arm, mapping `neutral` to 0 so a neutral reinforcement bumps access without moving the outcome EWMA, and a fourth signal without an arm there's a compile error.
- **`COMMANDS`, `GLOBAL_FLAGS`, and `buildManifest`**: the command table is the single source for the `cli.manifest` response and for the generated `AGENTS.md`, both derived by walking it (`apps/cli/src/commands.ts:68,185,1995`, `apps/cli/src/agents-doc.ts:7,174-193`).
- **`ToolFailure`**: the MCP wire failure, whose `.message` is the whole agent-visible response; `toToolFailure` passes an already-composed `ToolFailure` through unchanged so a handler-built failure isn't rewritten to its own class name (`apps/mcp/src/failure.ts:34-41,207-224`).
- **`Chunk` and `chunkIdFor`**: content-derived chunk ids are what let a `git mv` cost zero Bedrock calls, since `chunks` and `embeddings` key on the content hash (`packages/index/src/index.ts:9`, `packages/index/src/git-port.ts:26-30`).
- **`DisclosureCandidate` and `foldDisclosure`**: the tiered disclosure fold recall packs are built from, budgeted in characters (`packages/index/src/disclosure.ts` via `packages/index/src/index.ts:19-29`, consumed at `packages/index/src/retrieval.ts:6-11` for the import, `:182-190` where `RecallPack` is typed by its return, and `:602-641` where `recall` folds arcs and memories under separate budgets).
- **`DedupeLookup` and `MoveCallback`**: two injected functions rather than repository methods, because `@memhtml/store` is SQL-free by design and cross-database foreign keys don't exist (`packages/store/src/store.ts:189-209`).
- **`Edge` and `isWellFormedEdge`**: the edge struct plus a caller-side well-formedness check (`packages/contracts/src/edges.ts:122-149`). The check tests three conditions. The declared class matches the rel, the edge isn't a self-loop, and a derived edge carries the `sleep` provenance value, a stored value only the removed pipeline wrote (`packages/contracts/src/edges.ts:95-96`). Its doc comment names only the first two, the ones the `edges` CHECK constraints enforce, and no non-test code calls it at 0.16.0.
- **`spec/memhtml.symspec.json`**: a 107-entry EARS requirement ledger keyed by UUID, each entry carrying between 16 and 20 of 22 field names including `key`, `sentence`, `status`, `systemName`, and `verificationMethod`; its one code consumer decodes `key`, `sentence`, `status`, `priority`, `patternType`, `verificationMethod`, and `systemName` as required strings and throws on the file's own path when one is missing (`apps/docs/src/loaders/registry.ts:67,342-358`).
- **`RECALL_DISCIPLINE`, `RECALL_DISCIPLINE_TEXT`, `RECALL_DISCIPLINE_SHORT`**: five paragraphs of agent guidance stated once in `packages/contracts/src/guidance.ts:17-53` so every surface renders the same words. It has three consumers. `apps/cli/src/commands.ts:2,1984` renders the joined text as the `recall-discipline` guide topic, `packages/integrations/src/render/block.ts:15,59` writes the paragraphs into the fenced instruction block, and `packages/integrations/src/render/skill.ts:13,58` writes them into the installed `SKILL.md`. `RECALL_DISCIPLINE_SHORT` (`packages/contracts/src/guidance.ts:51-53`) is declared for the retrieval tools' descriptions and has no consumer in the tree; `apps/mcp/src/tools.ts` doesn't import from the module.

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at cf76951.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 97 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 81 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 71 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 65 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 62 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 47 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 43 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 41 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 38 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 36 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 33 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 27 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 25 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 24 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 17 shared source citations
