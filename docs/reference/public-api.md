# memhtml-public · Public API

This repository is the software that manages a memory tree; it stores no memories itself. The tree
it manages is the `memhtml root`, located by `$MEMHTML_ROOT`, which is the default every command
resolves its target from (`AGENTS.md:74`). The root's git history is the system of record, and
`.memhtml/index.db` inside the root is a projection of it that an operator deletes and rebuilds
without loss (`README.md:23-24`).

An agent reaches this software through two binaries, and both are declared in package manifests
rather than discovered. `apps/cli/package.json:7-8` maps `memhtml` to `./dist/bin.js`, and
`apps/mcp/package.json:7-8` maps `memhtml-mcp` to the same relative entry inside its own package.
The CLI is the agent-first surface, and its own generated instructions say so: every command writes
exactly one JSON envelope to stdout and logs go to stderr (`AGENTS.md:5-6`), and `memhtml manifest`
answers with every command, argument, flag, response type, and error code the binary accepts on a
machine with no root, no database, and no credentials, which makes it the liveness check as well as
the discovery call (`AGENTS.md:28-30`). `docs/reference/cli.md` documents that command surface. This
page documents the TypeScript library surface underneath it.

The library is a pnpm workspace of nine packages under `packages/` and four apps under `apps/`
(`pnpm-workspace.yaml:1-3`). Every workspace package is `"private": true` and declares an `exports`
map pointing at `./dist/index.js`, so each package's `src/index.ts` barrel is its public surface
(`packages/store/package.json:1-20`). The 30 symbols below are the barrel-named exports with the
most distinct cross-package importer files, counted across every TypeScript file in the repo except
the out-of-scope `apps/docs`.

### StorageFailure

```ts
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}
```

A driver or filesystem rejection, reduced to the operation that failed, with SQL text, parameters,
and row contents deliberately excluded so the error can be returned to an agent without leaking
content from the root.

`packages/contracts/src/errors.ts:9-11`

### EMBED_WATERMARK

```ts
export const EMBED_WATERMARK = `${EMBED_MODEL_ID}@${EMBED_DIM}`
```

The value `index_state.embed_model` stores, carrying both the model id and the dimension because a
model id alone does not identify a vector space.

`packages/llm/src/constants.ts:34`

### ModelUnavailable

```ts
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  modelId: Schema.String,
  reason: Schema.String
}) {}
```

Bedrock refused the call: throttling, an unavailable model, or a denied region.

`packages/contracts/src/errors.ts:25-28`

### EMBED_DIM

```ts
export const EMBED_DIM = 1024
```

The embedding width the InvokeModel body names explicitly, because Cohere Embed v4 returns 1536
floats when `output_dimension` is absent and exactly 1024 when it is named.

`packages/llm/src/constants.ts:8`

### InvalidMemory

```ts
export class InvalidMemory extends Schema.TaggedError<InvalidMemory>()("InvalidMemory", {
  reason: Schema.String
}) {}
```

A memory that violates the file format or the type and placement vocabulary.

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

The SQLite connection contract every reader and writer of the root's index plane holds, exposing
`run`, `get`, `all`, an atomic `writeAll`, a multi-statement `script`, two migration counters, and a
`hasState` flag reporting whether the durable state plane is attached.

`packages/index/src/database.ts:69-101`

### contentHash

```ts
export const contentHash = (input: HashableArticle | Node | string): string => {
```

The content hash of an article, taken from a parsed document, an article node, or the article's
inner HTML, with the `<article>` element located first so head content can never reach the digest.

`packages/html/src/hash.ts:156`

### DatabaseService

```ts
export const DatabaseService = Context.Service<DatabaseShape>("memhtml/Database")
```

The Effect service tag under which a `DatabaseShape` is provided to and requested from the layer
graph.

`packages/index/src/database.ts:103`

### makeGit

```ts
export const makeGit = (root: string): GitShape => ({
```

Builds the git service against a repository root, exported rather than only wrapped in a layer so
tests drive the real git binary against a temp-directory repo instead of a fake.

`packages/store/src/git.ts:234`

### renderTemplate

```ts
export const renderTemplate = (input: NewMemoryInput): string =>
  serializeMemory(newMemoryDoc(input))
```

Renders a fresh memory file as bytes, and it is the one function the write path calls.

`packages/html/src/template.ts:203-204`

### EdgeRel

```ts
export const EdgeRel = Schema.Literals(ALL_RELS)
export type EdgeRel = typeof EdgeRel.Type
```

The schema and derived type for every relationship name across all four edge classes, which is the
full vocabulary of the index's `edges.rel` column.

`packages/contracts/src/edges.ts:62-63`

### STATE_SCHEMA

```ts
export const STATE_SCHEMA = "state"
```

The schema name the root's `state.db` is ATTACHed under, and every cross-plane query qualifies with
it.

`packages/index/src/schema-const.ts:18`

### normalizePath

```ts
export const normalizePath = (path: string): string =>
```

Reduces a caller-supplied path to the canonical git-tree form: leading slashes dropped, repeated
slashes collapsed, trailing slash dropped.

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

Builds the indexer over a database and a git port, which is the component that projects the root's
git tree into the rebuildable SQLite index.

`packages/index/src/indexer.ts:161`

### makeDatabase

```ts
export const makeDatabase = (
  databasePath: string,
  migrationsDir: string,
  state?: { readonly path: string; readonly migrationsDir: string }
) =>
```

Opens a scoped connection with `foreign_keys` on and every pending migration applied, attaching the
durable state plane over the same connection when `state` is supplied.

`packages/index/src/database.ts:319-323`

### slugify

```ts
export const slugify = (title: string): string => {
```

Kebab-cases a title into `[a-z0-9-]` at most `SLUG_MAX_LENGTH` characters, folding diacritics to
base letters and returning a result that is itself a valid slug when fed back in.

`packages/contracts/src/slug.ts:28`

### archivePathFor

```ts
export const archivePathFor = (path: string, year: number): string =>
  `${ARCHIVE_BUCKET}/${yearSegment(year)}/${normalizePath(path)}`
```

The archive path a memory moves to on eviction, mirroring the original path beneath the year so the
mapping is injective and `git log --follow` reads through the move.

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

The model broke its structured-output contract with an undecodable tool payload, a `max_tokens`
stop, or a refusal, and the item loses its result rather than having a violation coerced into a
value.

`packages/contracts/src/errors.ts:59-64`

### makeGitPort

```ts
export const makeGitPort = (deps: GitAdapterDeps): GitPort => {
```

Maps a store `GitShape` onto the indexer's narrower port, translating every rejection to the port's
error type after logging the git command so a subprocess's stderr never travels to an agent through
a tool response.

`packages/index/src/git-adapter.ts:138`

### MemoryType

```ts
export const MemoryType = Schema.Literals(MEMORY_TYPES)
export type MemoryType = typeof MemoryType.Type
```

The schema and derived type for the closed ten-value memory type vocabulary, restated by the
`files.memory_type` CHECK constraint in SQL.

`packages/contracts/src/types.ts:31-32`

### MIGRATIONS_DIR

```ts
export const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname
```

Where the rebuildable index's migrations live, applied in filename order.

`packages/index/src/schema-const.ts:8`

### STATE_MIGRATIONS_DIR

```ts
export const STATE_MIGRATIONS_DIR = new URL("../state-migrations", import.meta.url).pathname
```

The state plane's own migration ledger, kept in a separate directory because `index.db` inside the
root is deleted and rebuilt without touching `state.db`.

`packages/index/src/schema-const.ts:15`

### commitSubject

```ts
export const commitSubject = (operation: MemhtmlOperation | string, subject: string): string => {
```

Formats a commit subject as `memhtml(<operation>): <subject>`, collapsing whitespace and capping the
subject at `COMMIT_SUBJECT_MAX` so an agent-supplied title with a newline cannot become a commit
body.

`packages/store/src/plumbing.ts:368`

### initRepo

```ts
export const initRepo = (git: GitShape): Effect.Effect<InitResult, GitFailure | StorageFailure> =>
```

Scaffolds a memory root at `git.root` and makes its initial commit, convergently rather than merely
idempotently: every step asks the repo what is already true and supplies only what is missing.

`packages/store/src/layout.ts:183`

### makeIndexRecorder

```ts
export const makeIndexRecorder = (db: DatabaseShape): IndexRecorderShape => ({
```

Builds the trace-plane recorder over a database connection, whose `recordLink` is idempotent on the
`(path, session_id, link_kind, at)` primary key so two recorders racing on the same instant write
one row rather than failing.

`packages/index/src/traces-persist.ts:130`

### makeStore

```ts
export const makeStore = (git: GitShape, hooks: StoreHooks = {}): StoreShape => {
```

Builds the store over a git service, exported so tests build it against a temp-directory repo with
the real git binary rather than a fake that would miss every state transition.

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

The closed memory type vocabulary of ten values, restated by the `files.memory_type` CHECK
constraint in SQL.

`packages/contracts/src/types.ts:18-29`

### attemptIo

```ts
export const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
```

Wraps a filesystem call as a typed `StorageFailure`, logging the errno for an operator while keeping
it out of the returned value.

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

The nine memory relationship names, of which `supersedes` and `contradicts` are penalty-bearing
because they gate the retention `contested_status` signal.

`packages/contracts/src/edges.ts:19-29`

## See also

- [memhtml-public · Contract map](../insights/contract-map.md): 5 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 3 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 3 shared source citations
- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 3 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 2 shared source citations
