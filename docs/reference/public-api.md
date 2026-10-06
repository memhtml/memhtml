# memhtml-public · Public API

Describes the source at 0.15.1 (main 9fcbfaf, 2026-10-05). Citations are `path:line` into that tree.

This repository is the software that manages a memory tree. It stores no memories itself. The tree it manages is the `memhtml root`, which `$MEMHTML_ROOT` locates and which defaults to `~/memhtml` (`AGENTS.md:575`). A command that opens a repo takes it from `--repo` when that flag is given and from `$MEMHTML_ROOT` otherwise (`AGENTS.md:96`), and when `MEMHTML_REFUSE_ENV_ROOT` is on, `memhtml` takes the repo from `--repo` alone and refuses a call that opens a repo without it (`AGENTS.md:576`). The root's git history is the system of record, and `.memhtml/index.db` inside the root is a projection of it that can be deleted and rebuilt without loss (`README.md:58`, under "The design in three sentences").

An agent reaches this software through two binaries, and package manifests declare both. `apps/cli/package.json:21-23` maps `memhtml` to `./dist/bin.js`, and `apps/mcp/package.json:20-22` maps `memhtml-mcp` to the same relative entry inside its own package. The published `memhtml` package ships the same two binaries as `./dist/memhtml.mjs` and `./dist/memhtml-mcp.mjs` and declares no `exports` map, so nothing on this page can be imported from the published package (`scripts/package-manifest.mjs:104-109`). The CLI is built for an agent to call. Every command writes exactly one JSON envelope to stdout and sends logs to stderr, with one exception: `memhtml help` on a terminal writes Markdown (`AGENTS.md:5-7`). `memhtml manifest` answers with every command, argument, flag, response type, and error code the binary accepts, and it works on a machine with no repo, no database, and no credentials, so it serves as the liveness check as well as the discovery call (`AGENTS.md:29-31`). `docs/reference/cli.md` documents that command surface. This page documents the TypeScript library surface underneath it, which the workspace packages import from one another.

The library is a pnpm workspace of eleven packages under `packages/`, four apps under `apps/`, and the `tests-integration` package (`pnpm-workspace.yaml:1-4`). Every package under `packages/` is `"private": true` and declares an `exports` map whose `.` entry points at `./dist/index.js`, so each package's `src/index.ts` barrel is the surface the other packages import (`packages/store/package.json:1-29`). `@memhtml/contracts` also exports six subpaths, `./edges`, `./errors`, `./guidance`, `./paths`, `./slug`, and `./types` (`packages/contracts/package.json:20-49`), and its barrel re-exports all six, one `export` line each (`packages/contracts/src/index.ts:1-6`). `@memhtml/sleep` and `@memhtml/store` each export a `./testing` subpath that their barrels do not re-export (`packages/sleep/package.json:20-29`, `packages/store/package.json:20-29`).

The symbols below are the barrel-named exports with the most distinct cross-package importer files, counted across every TypeScript file in the repo except `apps/docs`, which is out of scope. Exactly: for each name a `packages/*/src/index.ts` barrel exports, followed through `export *` and `export { } from` to the file that declares it, the count is the number of distinct `.ts` files outside the declaring package, tests included and `apps/docs`, `node_modules`, and `dist` skipped, that name it in an `import`, `import type`, `export { } from`, destructured `await import()`, or `import * as` member access whose specifier is the declaring package's `@memhtml/<name>` barrel or one of its subpaths. The list is the top 30 plus every row tied at the cutoff: positions 26 through 34 all have 5 importer files, so 34 symbols appear, ordered by count and then by name. Each entry gives the declaration copied from the source, what it does and how it fails, the declaration's line range, and its importer count.

### StorageFailure

```ts
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}
```

The typed failure for a rejected driver or filesystem call. Its only field is `operation`, a name for the step that failed. The database adapter logs the driver's own message with `Effect.logError` and puts only the operation name into the error (`packages/index/src/database.ts:152-162`), and the store's `attemptIo` and `readFileOrNull` do the same for the filesystem. That reduction is a convention of each construction site, not a property of the class: `memhtml exec` appends `String(cause)` to the operation for its sandbox steps (`apps/cli/src/exec.ts:324-339`), so on that path the field can carry a runtime's error text.

`packages/contracts/src/errors.ts:9-11`, 39 importer files

### ModelUnavailable

```ts
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  modelId: Schema.String,
  reason: Schema.String
}) {}
```

The typed failure for a model call that produced no usable answer, carrying `modelId` and a `reason` string. The source comment names throttling, an unavailable model, and a denied region, but the code raises it for more than a refusal by Bedrock: any transport rejection or unparseable payload, with the SDK error's name and message as `reason` (`packages/llm/src/client.ts:59-83`), a response that stopped at `max_tokens` or `refusal` (`packages/llm/src/model-client.ts:178-186`), a `generate` answer with no text (`packages/llm/src/model-client.ts:207-217`), and an embedding response with the wrong vector count or width (`packages/llm/src/embeddings.ts:83-102`).

`packages/contracts/src/errors.ts:25-28`, 17 importer files

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

The SQLite connection contract every reader and writer of the index plane holds: `run`, `get`, and `all` for one statement, `writeAll` for a batch in one transaction, `script` for a parameterless multi-statement script in one transaction, two migration counters, and `hasState`. Every method fails with `StorageFailure` whose `operation` is the method's name, after the driver's message is logged, and a statement that hits `SQLITE_BUSY` is retried with jittered exponential backoff for up to 20 seconds before it fails (`packages/index/src/database.ts:147-184`). `writeAll` and `script` run inside `BEGIN IMMEDIATE` and issue `ROLLBACK` on any throw, and an error from that `ROLLBACK` is swallowed so the original failure is the one reported (`packages/index/src/database.ts:262-273`). `hasState` is `true` whenever the caller passed a state database to `makeDatabase` (`packages/index/src/database.ts:396`); it is not a probe of the state tables.

`packages/index/src/database.ts:61-93`, 16 importer files

### DatabaseService

```ts
export const DatabaseService = Context.Service<DatabaseShape>("memhtml/Database")
```

The Effect service key under which the layer graph provides and requests a `DatabaseShape`. The CLI's `layerDatabase` provides it by opening `.memhtml/index.db` with `state.db` attached through `makeDatabase`, and it ends with `Layer.orDie`, so a failure to open or migrate either database surfaces as a defect rather than as a typed `StorageFailure` (`apps/cli/src/api-layer.ts:118-136`).

`packages/index/src/database.ts:95`, 15 importer files

### EMBED_WATERMARK

```ts
export const EMBED_WATERMARK = `${EMBED_MODEL_ID}@${EMBED_DIM}`
```

The vector-space label that `index_state.embed_model` stores: the model id and the dimension joined by `@`, which is `cohere.embed-v4:0@1024` (`packages/llm/src/constants.ts:7-8`). Before `update`, `index embed`, and any rebuild that cannot write vectors, the indexer's `guardEmbedModel` compares the stored label with this one and fails with `EmbedModelMismatch`, carrying `stored` and `configured`, when they differ (`packages/index/src/indexer.ts:332-338`, `packages/index/src/indexer.ts:159-165`). `memhtml index rebuild --embed` with an embedder present runs no check before it starts, because its `truncateForRebuild` writes the configured label into `index_state` in the same transaction that empties the tables, keeping only stored vectors already in the configured space (`packages/index/src/indexer.ts:398-415`, `packages/index/src/indexer.ts:689-696`).

`packages/llm/src/constants.ts:34`, 14 importer files

### InvalidMemory

```ts
export class InvalidMemory extends Schema.TaggedError<InvalidMemory>()("InvalidMemory", {
  reason: Schema.String
}) {}
```

The typed failure for a memory file that breaks the format or the type and placement vocabulary. Its one field, `reason`, is free text. `parseMemory` fills it with every violation it found joined by `VIOLATION_SEPARATOR`, which is `"; "` (`packages/html/src/constraints.ts:40`), and other sites write their own reason, such as the store's `a memory cannot link to itself: <path>` (`packages/store/src/store.ts:1318`) or the CLI's refusal of an unknown memory type (`apps/cli/src/operations.ts:83-92`).

`packages/contracts/src/errors.ts:31-33`, 12 importer files

### STATE_SCHEMA

```ts
export const STATE_SCHEMA = "state"
```

The schema name, `state`, under which `state.db` is ATTACHed. Queries that reach the durable state plane qualify its tables with this name. Most TypeScript sites interpolate the constant, but the ATTACH statement itself, the state migrations, and at least two queries write `state` literally (`packages/index/src/database.ts:291-293`, `packages/index/state-migrations/S0001_access.sql:13`, `packages/sleep/src/plan.ts:211-213`, `apps/cli/src/api-layer.ts:205`), so changing the constant alone would not move them.

`packages/index/src/schema-const.ts:19`, 12 importer files

### EMBED_DIM

```ts
export const EMBED_DIM = 1024
```

The embedding width. `buildEmbedBody` sends it as `output_dimension` on every embed request (`packages/llm/src/embeddings.ts:57-66`), because Cohere Embed v4 returns 1536 floats when that field is absent, per the probe the file's header comment records (`packages/llm/src/constants.ts:1-6`). A response vector of any other width fails the batch with `ModelUnavailable` whose `reason` names the vector's index and the width it carried (`packages/llm/src/embeddings.ts:94-99`).

`packages/llm/src/constants.ts:8`, 11 importer files

### contentHash

```ts
export const contentHash = (input: HashableArticle | Node | string): string => {
  if (typeof input === "string") return digest(canonicalArticleText(articleTreeOf(input)))
  if (isHashableArticle(input))
    return digest(canonicalArticleText(parseArticleFragment(input.article.html)))
  return digest(canonicalArticleText(input))
}
```

Computes `sha256:<64 hex>` over an article's canonical text (`canonicalText`), in which runs of ASCII whitespace collapse to one space and text inside `<pre>` is kept byte for byte (`packages/html/src/hash.ts:101-125`). It accepts a parsed document, an article node, or a string. A string that contains an `<article>` element is hashed on the first one, and a string without one is hashed as bare article markup. It never fails, because rejecting malformed input is left to `parseMemory` (`packages/html/src/hash.ts:163-185`).

`packages/html/src/hash.ts:156-161`, 10 importer files

### parseMemory

```ts
export const parseMemory = (html: string): Effect.Effect<MemoryDoc, InvalidMemory> =>
  Effect.suspend(() => {
    const document = parseDocument(html)
    const structural = checkDocument(document)
    const metaResult = readMetas(headMetas(document))
    const article = articleOf(document)
    const violations = [...structural.violations, ...metaResult.violations]

    if (violations.length > 0 || metaResult.metas === undefined || article === undefined) {
      const reason =
        violations.length > 0 ? violations.join(VIOLATION_SEPARATOR) : "head metadata is incomplete"
      return Effect.fail(InvalidMemory.make({ reason }))
    }

    const metas = headMetas(document)
    const [title] = elementsNamed(document, "title")
    return Effect.succeed({
      title: title === undefined ? "" : textContent(title),
      metas: metaResult.metas,
      entities: repeated(metas, "memhtml-entity"),
      tags: repeated(metas, "memhtml-tag"),
      aliases: repeated(metas, "memhtml-alias"),
      links: readLinks(document),
      article: readArticle(article),
      warnings: structural.warnings
    })
  })
```

Parses a memory file into a `MemoryDoc`. It fails with `InvalidMemory` when the structural check or the head-meta reader reports any violation, and `reason` is every violation joined by `VIOLATION_SEPARATOR`. When there is no violation but the head metadata or the `<article>` element is still missing, `reason` is the fixed string `head metadata is incomplete`. Structural warnings do not fail the parse; they come back in `warnings`, and `checkMemory` returns the same violations and warnings as lists without building a doc (`packages/html/src/parse.ts:417-427`).

`packages/html/src/parse.ts:385-411`, 10 importer files

### GitFailure

```ts
export class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  command: Schema.String,
  /** The process exit code, or `null` when the process never started. */
  exitCode: Schema.NullOr(Schema.Int)
}) {}
```

The typed failure for a git subprocess that exited with a code the call does not accept, or that produced no exit code. It carries `command`, a short label for the call such as `rev-parse`, `merge-ff`, or `diff-cached` rather than the argv, and `exitCode`, which is `null` when the process could not be spawned or was killed by a signal (`packages/store/src/git.ts:231-233`). The runner logs the subprocess's stderr with `Effect.logError` and keeps it out of the error (`packages/store/src/git.ts:258-275`). `diffTreeNames` also fails with `exitCode: null`, without spawning anything, when it is given an abbreviated sha (`packages/store/src/git.ts:355-359`).

`packages/store/src/git.ts:35-39`, 9 importer files

### normalizePath

```ts
export const normalizePath = (path: string): string => {
  const collapsed = path.replace(/^\/+/, "").replace(/\/{2,}/g, "/")
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed
}
```

Reduces a caller-supplied path to the git-tree form: leading slashes dropped, runs of slashes collapsed to one, and a trailing slash removed. It never fails and does no validation, so `.` and `..` segments pass through unchanged. `memoryPathViolation` is the check that refuses a path outside the four PARA buckets, one that does not end in `.html`, or one carrying a blank, `.`, or `..` segment (`packages/contracts/src/paths.ts:80-97`).

`packages/contracts/src/paths.ts:54-57`, 9 importer files

### EdgeRel

```ts
export const EdgeRel = Schema.Literals(ALL_RELS)
export type EdgeRel = typeof EdgeRel.Type
```

The schema and derived type for every relationship name across the four edge classes: nine memory rels, two person rels, one provenance rel, and two task rels, fourteen in all (`packages/contracts/src/edges.ts:19-60`). The `edges` table restates the per-class lists as CHECK constraints keyed on `edge_class` (`packages/index/migrations/0008_tasks.sql:194-199`). `relClassFor` derives the class from the rel, since each name belongs to exactly one class (`packages/contracts/src/edges.ts:70-75`).

`packages/contracts/src/edges.ts:62-63`, 8 importer files

### attemptIo

```ts
export const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`store.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation }))
  )
```

Runs a promise-returning filesystem call and maps any rejection to `StorageFailure` with the given `operation`. Before mapping, it logs `store.<operation> failed:` followed by the error's `message`, and that message stays out of the returned error. Callers sometimes put a path into `operation`, as the scaffold writer `writeIfAbsent` does with `init.write:<path>` (`packages/store/src/layout.ts:114-128`).

`packages/store/src/layout.ts:149-158`, 8 importer files

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

The closed vocabulary of ten memory types. The `files.memory_type` CHECK constraint restates the same ten values (`packages/index/migrations/0008_tasks.sql:38-40`). `arc` is in the vocabulary but agents cannot write it, which `WRITABLE_MEMORY_TYPES` encodes. `task` is left out of search through `EXCLUDED_BY_DEFAULT` unless the caller names it in the type filter (`packages/index/src/scope.ts:262-280`), and sleep's curation queries skip it (`packages/sleep/src/sql.ts:41-45`).

`packages/contracts/src/types.ts:18-29`, 7 importer files

### ModelClientShape

```ts
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
```

The two ways a sleep phase calls a model. `generate` returns the joined text blocks with token counts and latency, and fails with `ModelUnavailable` when the transport fails, the response stops at `max_tokens` or `refusal`, or the answer holds no text (`packages/llm/src/model-client.ts:178-186`, `packages/llm/src/model-client.ts:207-217`). `generateObject` forces one tool call and decodes its input against the request's schema with undeclared properties refused, and it fails with `LlmContractViolation` when there is no tool call or the payload does not decode after one repair of a double-encoded field (`packages/llm/src/structured.ts:131-160`). Whether one failed call skips an item or fails the phase is the calling phase's decision, made with `Effect.result` over each call (`packages/llm/src/model-client.ts:19-26`).

`packages/llm/src/model-client.ts:60-69`, 7 importer files

### archivePathFor

```ts
export const archivePathFor = (path: string, year: number): string =>
  `${ARCHIVE_BUCKET}/${yearSegment(year)}/${normalizePath(path)}`
```

Builds the path a memory moves to on eviction, `archive/<YYYY>/<original path>`, with the year truncated to an integer and zero-padded to four digits and the original path normalized (`packages/contracts/src/paths.ts:203`). Mirroring the whole original path is what lets `originalPathFor` strip the prefix back off. It does not check `year`, so a negative or non-finite value yields a segment that is not all digits, and `originalPathFor` then does not recognize the result as an archive path.

`packages/contracts/src/paths.ts:213-214`, 7 importer files

### renderTemplate

```ts
export const renderTemplate = (input: NewMemoryInput): string =>
  serializeMemory(newMemoryDoc(input))
```

Renders a fresh memory file as bytes from write-tool parameters. It puts the claim in the first paragraph's `<mark>`, sets the status to `active` and both timestamps to `at`, stamps `memhtml-content-hash` from the article it just built, and gives a `task` the status `todo` when none is supplied (`packages/html/src/template.ts:152-202`). When `articleHtml` is supplied it is used in place of `claim` and `body`, and the caller then owns the `<mark>` (`packages/html/src/template.ts:34-40`). It performs no format check and never fails; `parseMemory` is what rejects a malformed file.

`packages/html/src/template.ts:209-210`, 7 importer files

### slugify

```ts
export const slugify = (title: string): string => {
  const folded = title
    .normalize("NFKD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase()

  const kebab = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")

  if (kebab === "") return SLUG_FALLBACK

  return kebab.length <= SLUG_MAX_LENGTH
    ? kebab
    : kebab.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "") || SLUG_FALLBACK
}
```

Kebab-cases a title into `[a-z0-9-]`: it applies NFKD, strips combining marks so diacritics fold to base letters, lowercases, replaces each run of other characters with one hyphen, and trims hyphens from both ends. A title that reduces to nothing returns `SLUG_FALLBACK`, which is `untitled`, and a result longer than `SLUG_MAX_LENGTH` (80) is cut there with any exposed trailing hyphen trimmed (`packages/contracts/src/slug.ts:7-15`). A slug fed back in comes out unchanged.

`packages/contracts/src/slug.ts:28-44`, 7 importer files

### LlmContractViolation

```ts
export class LlmContractViolation extends Schema.TaggedError<LlmContractViolation>()(
  "LlmContractViolation",
  {
    reason: Schema.String
  }
) {}
```

The typed failure for a forced-tool answer that breaks its structured-output contract. The code raises it in two cases: the response has no `emit` tool call, or the tool payload fails the strict schema decode even after one repair of a double-encoded field, in which case `reason` carries the decode error and a preview of the raw payload (`packages/llm/src/structured.ts:131-160`). The source comment also lists a `max_tokens` stop and a refusal, but those surface as `ModelUnavailable` with the `reason` `incomplete response: stop_reason=<value>` (`packages/llm/src/model-client.ts:178-186`).

`packages/contracts/src/errors.ts:59-64`, 6 importer files

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

The nine relationship names of the memory edge class. The `edges` table admits exactly these nine under `edge_class = 'memory'` (`packages/index/migrations/0008_tasks.sql:194-196`). Retention's `contested_status` signal counts only inbound authored `contradicts` edges (`packages/sleep/src/sql.ts:622-633`). The source comment says `supersedes` gates that signal too, but the count reads only `contradicts`. Retrieval reads `supersedes` to report a memory's successor (`packages/index/src/retrieval.ts:411-414`).

`packages/contracts/src/edges.ts:19-29`, 6 importer files

### MemoryType

```ts
export const MemoryType = Schema.Literals(MEMORY_TYPES)
export type MemoryType = typeof MemoryType.Type
```

The schema and derived type for the ten `MEMORY_TYPES` values, so decoding a string outside the vocabulary with this schema fails. The write path narrows further: `WritableMemoryType` and `WRITABLE_MEMORY_TYPES` leave out `arc` (`packages/contracts/src/types.ts:34-53`).

`packages/contracts/src/types.ts:31-32`, 6 importer files

### frameKeyOf

```ts
export const frameKeyOf = (gist: string): string | null => {
  const match = FRAME.exec(gist.replace(/\s+/g, " ").trim())
  if (match === null) return null
  const frame = match[1]
  const value = match[2]
  if (frame === undefined || value === undefined) return null
  if (frame.split(" ").length < MIN_FRAME_TOKENS) return null
  // `value` matched `(.+?)`, so it is non-empty and splits to at least one token; only the
  // upper bound needs checking.
  if (value.split(" ").length > MAX_VALUE_TOKENS) return null
  return frame.toLowerCase()
}
```

Returns a claim's frame key, the text up to the last linking word (`of`, `is`, `in`, `to`, `by`, `as`) that a value follows, lowercased, so two claims that write different values into the same slot share a key. Whitespace runs collapse before the match, and it returns `null` when the claim has no such split, when the frame has fewer than three tokens, or when the value has more than six (`packages/domain/src/frame.ts:48-54`). The source comment calls the key case-insensitive, but the linking-word pattern has no `i` flag and runs before the lowercasing, so `The Capital Of India Is X` returns `null` while `the capital of India is Y` keys on `the capital of india is`.

`packages/domain/src/frame.ts:67-78`, 6 importer files

### readFileOrNull

```ts
export const readFileOrNull = (
  absolutePath: string
): Effect.Effect<string | null, StorageFailure> =>
  Effect.tryPromise({
    try: () => readFile(absolutePath, "utf8"),
    catch: (cause) => cause
  }).pipe(
    Effect.catch((cause) => {
      const code = (cause as { code?: unknown } | null)?.code
      return code === "ENOENT" || code === "EISDIR"
        ? Effect.succeed(null)
        : Effect.logError(`store.read failed: ${String(code ?? cause)}`).pipe(
            Effect.andThen(Effect.fail(StorageFailure.make({ operation: "read" })))
          )
    })
  )
```

Reads a file as UTF-8, and returns `null` when the read fails with `ENOENT` or `EISDIR`, so a directory at the path also reads as absent. Any other rejection is logged as `store.read failed:` with the error code and fails with `StorageFailure` whose `operation` is `read`.

`packages/store/src/layout.ts:131-146`, 6 importer files

### readMeta

```ts
export const readMeta = (html: string, name: string): string | undefined => {
  const head = headOf(parseDocument(html))
  if (head === undefined) return undefined
  return memhtmlMetas(head)
    .find((meta) => meta.name === name)
    ?.element.attrs.find((candidate) => candidate.name === "content")?.value
}
```

Returns the `content` of the first head `<meta>` whose `name` equals the given name, or `undefined`. It considers only metas whose name starts with `META_PREFIX`, which is `memhtml-` (`packages/html/src/vocabulary.ts:13`), and it validates nothing, so it works on bytes that `parseMemory` would reject. The source comment says no parse is needed, but each call parses the whole document with `parseDocument`.

`packages/html/src/editors.ts:283-289`, 6 importer files

### GitShape

```ts
export interface GitShape {
  /** The repository root every path in this service is relative to. */
  readonly root: string
  /** `HEAD`'s commit sha, or `null` in a repo with no commit yet. */
  readonly revParseHead: () => Effect.Effect<string | null, GitFailure>
  /** True when `root` is inside a git work tree with `root` as its top level. */
  readonly isRepo: () => Effect.Effect<boolean, GitFailure>
  /** Every blob in a commit's tree, recursively. One subprocess for the whole corpus. */
  readonly lsTreeR: (
    commitish: string,
    pathspecs?: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<TreeEntry>, GitFailure>
  /**
   * The contents of many blobs in ONE subprocess. The shas go in on stdin and the bodies come
   * back framed, so reading the whole tree costs one process instead of one per file. It also
   * works against a bare repo or a detached checkout, where `readFile` has nothing to read.
   */
  readonly catFileBatch: (
    shas: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, GitFailure>
  /** Per-path change between two commits, renames detected and reported as one entry. */
  readonly diffNameStatus: (
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<ChangedPath>, GitFailure>
  /**
   * Every path the given commits changed, unioned, in ONE subprocess. FULL object names only.
   *
   * The shas go in on stdin, exactly as {@link catFileBatch} does, because the caller's set is one
   * per commit in a range and a range can hold hundreds — `sleep`'s compress phase commits inside
   * its fold loop. One process either way.
   *
   * A rename contributes BOTH of its paths. The union answers "which paths did these commits
   * write", and a caller asking that about a `git mv` needs the path that went away as much as the
   * one that arrived.
   */
  readonly diffTreeNames: (
    commits: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<string>, GitFailure>
  /** The working tree's dirty state, with both the index and worktree blob shas. */
  readonly statusPorcelainV2: () => Effect.Effect<ReadonlyArray<StatusEntry>, GitFailure>
  /** The blob sha a working-tree file would hash to. Equals its sha in the tree once committed. */
  readonly hashObject: (path: string) => Effect.Effect<string, GitFailure>
  readonly add: (paths: ReadonlyArray<string>) => Effect.Effect<void, GitFailure>
  /** `git mv`. The destination's parent directory must already exist, since git will not make it. */
  readonly mv: (from: string, to: string) => Effect.Effect<void, GitFailure>
  readonly commit: (
    message: string,
    options?: { readonly trailers?: Trailers | undefined }
  ) => Effect.Effect<CommitResult, GitFailure>
  readonly checkoutBranch: (
    branch: string,
    options?: { readonly create?: boolean | undefined }
  ) => Effect.Effect<void, GitFailure>
  readonly branchExists: (branch: string) => Effect.Effect<boolean, GitFailure>
  /** Fast-forward `HEAD` to `commitish`, or fail. This never creates a merge commit. */
  readonly mergeFastForward: (commitish: string) => Effect.Effect<void, GitFailure>
  /**
   * A three-way merge, whose conflict is a VALUE rather than a failure. Git exits 1 on a
   * content conflict, which is an ordinary outcome for two agents editing one file, and the
   * caller needs the conflicted paths to build its own typed error.
   */
  readonly merge: (commitish: string) => Effect.Effect<MergeOutcome, GitFailure>
  /** Abandon an in-progress merge, restoring the pre-merge index and worktree. */
  readonly mergeAbort: () => Effect.Effect<void, GitFailure>
  /**
   * The unmerged index stages of a conflict, so stage 1 base, 2 ours, 3 theirs, per path.
   * This is where `WriteConflict.ourSha`/`theirSha` come from.
   */
  readonly unmergedStages: () => Effect.Effect<ReadonlyArray<UnmergedStage>, GitFailure>
  /** One trailer key's values per commit in a range, newest first. Drives `sleep resume`. */
  readonly logTrailers: (
    range: string,
    key: string
  ) => Effect.Effect<ReadonlyArray<TrailerRecord>, GitFailure>
  /** Set a repository-local config value. */
  readonly setConfig: (key: string, value: string) => Effect.Effect<void, GitFailure>
  /** Run any subcommand. The escape hatch for a one-off; every routine call has a method. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, GitFailure>
}
```

The git service contract: one method per git call the store and the indexer make, plus `run` as an escape hatch for any subcommand. Every method fails only with `GitFailure`. Some non-zero exits are answers rather than failures: `revParseHead` returns `null` on an unborn `HEAD`, `branchExists` returns `false`, `commit` returns `{ sha: null, empty: true }` when nothing is staged, and `merge` returns a content conflict as a `MergeOutcome` value while any other refusal stays a `GitFailure` (`packages/store/src/git.ts:289-299`, `packages/store/src/git.ts:397-438`).

`packages/store/src/git.ts:54-133`, 5 importer files

### INBOX_DIR

```ts
export const INBOX_DIR = "areas/inbox"
```

The value `areas/inbox`. `placementFor` falls through to `INBOX_DIR` when no other rule claims a memory (`packages/contracts/src/paths.ts:182`). A `task` that names no workspace goes to its `tasks` subdirectory (`packages/contracts/src/paths.ts:158-162`). `memhtml init` scaffolds it (`packages/store/src/layout.ts:41-48`), `memhtml doctor` counts the active indexed files anywhere under it, the `tasks` subdirectory included (`apps/cli/src/doctor.ts:281-290`), and sleep's placement phase draws its candidates from it, excluding tasks (`packages/sleep/src/phases/placement-triage.ts:149-160`).

`packages/contracts/src/paths.ts:19`, 5 importer files

### PEOPLE_DIR

```ts
export const PEOPLE_DIR = "resources/people"
```

`resources/people`, the person plane. `placementFor` routes a `semantic` memory there when one of its entities is a `person:` reference (`packages/contracts/src/paths.ts:170-171`), sleep's person-links phase builds each person file's path from `PEOPLE_DIR` and the `slugify` of the name (`packages/sleep/src/phases/person-links.ts:36`), and `memhtml init` scaffolds the directory.

`packages/contracts/src/paths.ts:13`, 5 importer files

### WRITABLE_MEMORY_TYPES

```ts
export const WRITABLE_MEMORY_TYPES = MEMORY_TYPES.filter(
  (type): type is Exclude<MemoryType, "arc"> => type !== "arc"
)
```

The nine memory types an agent may write: `MEMORY_TYPES` without `arc`, which the sleep cycle synthesizes. The CLI's `decodeWritableType` refuses any other value, `arc` included, with `InvalidMemory` whose `reason` lists these nine (`apps/cli/src/operations.ts:83-92`). The `WritableMemoryType` schema beside it restates the nine values as a literal list instead of deriving them from this array (`packages/contracts/src/types.ts:42-53`).

`packages/contracts/src/types.ts:38-40`, 5 importer files

### commitSubject

```ts
export const commitSubject = (operation: MemhtmlOperation | string, subject: string): string => {
  const flat = oneLine(subject)
  const capped =
    flat.length <= COMMIT_SUBJECT_MAX ? flat : `${flat.slice(0, COMMIT_SUBJECT_MAX - 1).trim()}…`
  return `memhtml(${operation}): ${capped === "" ? "(untitled)" : capped}`
}
```

Formats a commit subject as `memhtml(<operation>): <subject>`. It collapses every whitespace run in the subject to one space, so an agent-supplied title with a newline cannot become a commit body, and a subject longer than `COMMIT_SUBJECT_MAX` (72) is cut to its first 71 characters, trimmed, and ended with `…` (`packages/store/src/plumbing.ts:369`). An empty subject becomes `(untitled)`. The `operation` is inserted as given; callers pass fixed strings such as `write`, and sleep's commit helper calls `commitSubject` with `sleep(<phase>)` (`packages/sleep/src/commit.ts:76-82`).

`packages/store/src/plumbing.ts:393-398`, 5 importer files

### escapeAttribute

```ts
export const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll(" ", "&nbsp;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;")
```

Escapes a value for a double-quoted attribute: `&`, the double quote, a literal no-break space as `&nbsp;`, and carriage return and line feed as numeric references, so every emitted `<meta>` or `<link>` stays on one source line for the head editors. It leaves `<`, `>`, and the single quote alone, which is safe because the serializer always writes double quotes (`packages/html/src/markup.ts:65-70`).

`packages/html/src/markup.ts:50-56`, 5 importer files

### escapeText

```ts
export const escapeText = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(" ", "&nbsp;")
```

Escapes a text run: `&`, `<`, `>`, and a literal no-break space (U+00A0) as `&nbsp;`, so an invisible character in a claim shows up in the file. It leaves quotes alone, which text content does not need.

`packages/html/src/markup.ts:36-41`, 5 importer files

### makeGit

```ts
export const makeGit = (root: string): GitShape => ({
```

Builds the `GitShape` service over the `git` binary, running every call as `git -C <root>` through `execFile` (`packages/store/src/git.ts:216-251`). Each spawn sets `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and `LC_ALL=C`, and removes the repository-selecting variables such as `GIT_DIR`, so a call made from inside a git hook still targets `root` (`packages/store/src/git.ts:168-201`). The user's own git config is still read, which is why every parsed call states its output format with explicit flags. It is exported beside `layerGit` so tests can drive the real binary against a temporary repository.

`packages/store/src/git.ts:286-458`, 5 importer files

### originalPathFor

```ts
export const originalPathFor = (archivePath: string): string | undefined => {
  const normalized = normalizePath(archivePath)
  const match = /^archive\/(\d{4,})\/(.+)$/.exec(normalized)
  return match?.[2]
}
```

The inverse of `archivePathFor`: it normalizes the path, strips exactly one `archive/<year>/` prefix whose year is four or more digits, and returns the rest. It returns `undefined` for a path without such a prefix, and `isArchivePath` asks the same question as a boolean (`packages/contracts/src/paths.ts:228`). A memory archived twice gives back its first archive path, not its original path.

`packages/contracts/src/paths.ts:221-225`, 5 importer files

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at 9fcbfaf.

- [memhtml-public · Module map](../architecture/module-map.md): 32 shared source citations
- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 30 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 27 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 22 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 13 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 13 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 12 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 12 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 11 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 10 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 9 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 9 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 9 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 8 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 5 shared source citations
