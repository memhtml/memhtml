# memhtml-public · Public API

This repository is the software that manages a memory tree. It stores no memories itself. The tree
it manages is the `memhtml root`, located by `$MEMHTML_ROOT`, which is the default every command
resolves its target from (`AGENTS.md:74`). The root's git history is the system of record, and
`.memhtml/index.db` inside the root is a projection of it that an operator deletes and rebuilds
without loss (`README.md:23-24`).

An agent reaches this software through two binaries, and package manifests declare both.
`apps/cli/package.json:7-8` maps `memhtml` to `./dist/bin.js`, and
`apps/mcp/package.json:7-8` maps `memhtml-mcp` to the same relative entry inside its own package.
The CLI is built for an agent to call. Every command writes exactly one JSON envelope to stdout and
sends logs to stderr (`AGENTS.md:5-6`). `memhtml manifest` answers with every command, argument,
flag, response type, and error code the binary accepts, and it works on a machine with no root, no
database, and no credentials, so it serves as the liveness check as well as the discovery call
(`AGENTS.md:28-30`). `docs/reference/cli.md` documents that command surface. This
page documents the TypeScript library surface underneath it.

The library is a pnpm workspace of nine packages under `packages/` and four apps under `apps/`
(`pnpm-workspace.yaml:1-3`). Every workspace package is `"private": true` and declares an `exports`
map pointing at `./dist/index.js`, so each package's `src/index.ts` barrel is its public surface
(`packages/store/package.json:1-20`). The 30 symbols below are the barrel-named exports with the
most distinct cross-package importer files, counted across every TypeScript file in the repo except
`apps/docs`, which is out of scope.

### StorageFailure

```ts
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}
```

Reports a driver or filesystem rejection as the name of the operation that failed. It excludes SQL
text, parameters, and row contents, so the error can be returned to an agent without leaking
content from the root.

`packages/contracts/src/errors.ts:9-11`

### EMBED_WATERMARK

```ts
export const EMBED_WATERMARK = `${EMBED_MODEL_ID}@${EMBED_DIM}`
```

`index_state.embed_model` stores this value. It carries both the model id and the dimension,
because a model id alone does not identify a vector space.

`packages/llm/src/constants.ts:34`

### ModelUnavailable

```ts
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  modelId: Schema.String,
  reason: Schema.String
}) {}
```

Bedrock refused the call because of throttling, an unavailable model, or a denied region.

`packages/contracts/src/errors.ts:25-28`

### EMBED_DIM

```ts
export const EMBED_DIM = 1024
```

The InvokeModel body names this embedding width explicitly. Cohere Embed v4 returns 1536 floats when
`output_dimension` is absent and exactly 1024 when it is named.

`packages/llm/src/constants.ts:8`

### InvalidMemory

```ts
export class InvalidMemory extends Schema.TaggedError<InvalidMemory>()("InvalidMemory", {
  reason: Schema.String
}) {}
```

Reports that a memory violates the file format or the type and placement vocabulary.

`packages/contracts/src/errors.ts:31-33`

### DatabaseShape

```ts
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
  /**
   * Apply a whole SQL script — many statements, no parameters — in ONE transaction.
   *
   * This is the migration primitive, exposed because a caller applying migration files must use
   * the same one the runner does. Whether a `DROP TABLE`'s cascade is contained by that
   * transaction is exactly the kind of fact a per-statement loop would answer differently.
   */
  readonly script: (sql: string) => Effect.Effect<void, StorageFailure>
  readonly migrationsApplied: number
  /**
   * Migrations recorded in the ATTACHed state plane's own ledger, or `0` when no state database is
   * attached. Two counters because the planes are versioned independently: `index.db` is deleted
   * and rebuilt, `state.db` is not.
   */
  readonly stateMigrationsApplied: number
  /** True when `state.access` and `state.edge_corroboration` are reachable from this connection. */
  readonly hasState: boolean
}
```

Every reader and writer of the root's index plane holds this SQLite connection contract. It exposes
`run`, `get`, `all`, an atomic `writeAll`, a multi-statement `script`, two migration counters, and a
`hasState` flag that reports whether the durable state plane is attached.

`packages/index/src/database.ts:69-101`

### contentHash

```ts
export const contentHash = (input: HashableArticle | Node | string): string => {
```

Computes the content hash of an article from a parsed document, an article node, or the article's
inner HTML. It locates the `<article>` element first, so head content stays out of the digest.

`packages/html/src/hash.ts:156`

### DatabaseService

```ts
export const DatabaseService = Context.Service<DatabaseShape>("memhtml/Database")
```

The layer graph uses this Effect service tag to provide and request a `DatabaseShape`.

`packages/index/src/database.ts:103`

### makeGit

```ts
export const makeGit = (root: string): GitShape => ({
```

Builds the git service against a repository root. It is exported directly as well as wrapped in a
layer, so tests can drive the actual git binary against a temp-directory repo.

`packages/store/src/git.ts:234`

### renderTemplate

```ts
export const renderTemplate = (input: NewMemoryInput): string =>
  serializeMemory(newMemoryDoc(input))
```

Renders a fresh memory file as bytes. The write path calls this one function to do so.

`packages/html/src/template.ts:203-204`

### EdgeRel

```ts
export const EdgeRel = Schema.Literals(ALL_RELS)
export type EdgeRel = typeof EdgeRel.Type
```

This is the schema and derived type for every relationship name across all four edge classes. Those
names are the full vocabulary of the index's `edges.rel` column.

`packages/contracts/src/edges.ts:62-63`

### STATE_SCHEMA

```ts
export const STATE_SCHEMA = "state"
```

The root's `state.db` is ATTACHed under this schema name. Every cross-plane query qualifies its
tables with it.

`packages/index/src/schema-const.ts:18`

### normalizePath

```ts
export const normalizePath = (path: string): string =>
```

Reduces a caller-supplied path to the canonical git-tree form. It drops leading slashes, collapses
repeated slashes, and drops a trailing slash.

`packages/contracts/src/paths.ts:43`

### parseMemory

```ts
export const parseMemory = (html: string): Effect.Effect<MemoryDoc, InvalidMemory> =>
```

Parses a memory file, failing with `InvalidMemory` whose `reason` is every violation joined by
`VIOLATION_SEPARATOR`.

`packages/html/src/parse.ts:322`

### makeIndexer

```ts
export const makeIndexer = (deps: IndexerDeps): IndexerShape => {
```

Builds the indexer over a database and a git port. The indexer projects the root's git tree into the
rebuildable SQLite index.

`packages/index/src/indexer.ts:161`

### makeDatabase

```ts
export const makeDatabase = (
  databasePath: string,
  migrationsDir: string,
  state?: { readonly path: string; readonly migrationsDir: string }
) =>
```

Opens a scoped connection with `foreign_keys` on and every pending migration applied. When `state`
is supplied, it attaches the durable state plane over the same connection.

`packages/index/src/database.ts:319-323`

### slugify

```ts
export const slugify = (title: string): string => {
```

Kebab-cases a title into `[a-z0-9-]` at most `SLUG_MAX_LENGTH` characters, folding diacritics to
base letters. Feeding the result back in returns the same slug.

`packages/contracts/src/slug.ts:28`

### archivePathFor

```ts
export const archivePathFor = (path: string, year: number): string =>
  `${ARCHIVE_BUCKET}/${yearSegment(year)}/${normalizePath(path)}`
```

Builds the archive path a memory moves to on eviction. It mirrors the original path beneath the
year, so the mapping is injective and `git log --follow` reads through the move.

`packages/contracts/src/paths.ts:165-166`

### LlmContractViolation

```ts
export class LlmContractViolation extends Schema.TaggedError<LlmContractViolation>()(
  "LlmContractViolation",
  {
    reason: Schema.String
  }
) {}
```

Reports that the model broke its structured-output contract with an undecodable tool payload, a
`max_tokens` stop, or a refusal. The item ends with no result, and the violation is not coerced
into a value.

`packages/contracts/src/errors.ts:59-64`

### makeGitPort

```ts
export const makeGitPort = (deps: GitAdapterDeps): GitPort => {
```

Maps a store `GitShape` onto the indexer's narrower port. It logs the git command and then
translates every rejection to the port's error type, which keeps a subprocess's stderr out of tool
responses sent to an agent.

`packages/index/src/git-adapter.ts:138`

### MemoryType

```ts
export const MemoryType = Schema.Literals(MEMORY_TYPES)
export type MemoryType = typeof MemoryType.Type
```

This is the schema and derived type for the closed ten-value memory type vocabulary. The
`files.memory_type` CHECK constraint in SQL restates the same ten values.

`packages/contracts/src/types.ts:31-32`

### MIGRATIONS_DIR

```ts
export const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname
```

The rebuildable index's migrations live here, and they are applied in filename order.

`packages/index/src/schema-const.ts:8`

### STATE_MIGRATIONS_DIR

```ts
export const STATE_MIGRATIONS_DIR = new URL("../state-migrations", import.meta.url).pathname
```

The state plane's own migrations live here. They sit in a separate directory because `index.db`
inside the root is deleted and rebuilt without touching `state.db`.

`packages/index/src/schema-const.ts:15`

### commitSubject

```ts
export const commitSubject = (operation: MemhtmlOperation | string, subject: string): string => {
```

Formats a commit subject as `memhtml(<operation>): <subject>`. It collapses whitespace and caps the
subject at `COMMIT_SUBJECT_MAX`, so an agent-supplied title with a newline cannot become a commit
body.

`packages/store/src/plumbing.ts:368`

### initRepo

```ts
export const initRepo = (git: GitShape): Effect.Effect<InitResult, GitFailure | StorageFailure> =>
```

Scaffolds a memory root at `git.root` and makes its initial commit. Every step asks the repo what is
already true and supplies only what is missing, so the operation is convergent as well as
idempotent.

`packages/store/src/layout.ts:183`

### makeIndexRecorder

```ts
export const makeIndexRecorder = (db: DatabaseShape): IndexRecorderShape => ({
```

Builds the trace-plane recorder over a database connection. Its `recordLink` is idempotent on the
`(path, session_id, link_kind, at)` primary key, so two recorders racing on the same instant write
one row instead of failing.

`packages/index/src/traces-persist.ts:130`

### makeStore

```ts
export const makeStore = (git: GitShape, hooks: StoreHooks = {}): StoreShape => {
```

Builds the store over a git service. It is exported so tests can build it against a temp-directory
repo with the actual git binary, which a fake would not exercise for state transitions.

`packages/store/src/store.ts:367`

### MEMORY_TYPES

```ts
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
```

This array is the closed memory type vocabulary of ten values. The `files.memory_type` CHECK
constraint in SQL restates the same ten values.

`packages/contracts/src/types.ts:18-29`

### attemptIo

```ts
export const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
```

Wraps a filesystem call as a typed `StorageFailure`. It logs the errno for an operator and keeps it
out of the returned value.

`packages/store/src/layout.ts:149-152`

### MEMORY_RELS

```ts
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
```

This array holds the nine memory relationship names. Two of them, `supersedes` and `contradicts`,
carry a penalty because they gate the retention `contested_status` signal.

`packages/contracts/src/edges.ts:19-29`

## See also

- [memhtml-public · Contract map](../insights/contract-map.md): 5 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 3 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 3 shared source citations
- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 3 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 2 shared source citations
