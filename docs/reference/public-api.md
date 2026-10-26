# memhtml-public · Public API

Describes the source at 0.16.0 (2026-10-18). Citations are `path:line` into that tree.

This repository is the software that manages a memory tree. It stores no memories itself. The tree it manages is the `memhtml root`, which `$MEMHTML_ROOT` locates and which defaults to `~/memhtml` (`AGENTS.md:675`). A command that opens a repo takes it from `--repo` when that flag is given and from `$MEMHTML_ROOT` otherwise (`AGENTS.md:94`). When `MEMHTML_REFUSE_ENV_ROOT` is on, `memhtml` takes the repo from `--repo` alone and refuses a call that opens a repo without it (`AGENTS.md:676`). The root's git history is the system of record. The file `.memhtml/index.db` inside the root is a projection of it that can be deleted and rebuilt without loss (`README.md:58`, under "The design in three sentences").

An agent reaches this software through two binaries, and package manifests declare both. `apps/cli/package.json:21-23` maps `memhtml` to `./dist/bin.js`, and `apps/mcp/package.json:20-22` maps `memhtml-mcp` to the same relative entry inside its own package. The published `memhtml` package ships the same two binaries as `./dist/memhtml.mjs` and `./dist/memhtml-mcp.mjs`. It declares no `exports` map, so nothing on this page can be imported from the published package (`scripts/package-manifest.mjs:107-112`). The CLI is built for an agent to call. Every command writes exactly one JSON envelope to stdout and sends logs to stderr. The one exception is `memhtml help` on a terminal, which writes Markdown (`AGENTS.md:5-7`). `memhtml manifest` answers with every command, argument, flag, response type, and error code the binary accepts. It works on a machine with no repo, no database, and no credentials, so it serves as the liveness check as well as the discovery call (`AGENTS.md:29-31`). `docs/reference/cli.md` documents that command surface. This page documents the TypeScript library surface underneath it, which the workspace packages import from one another.

The library is a pnpm workspace of fourteen packages under `packages/`, three apps under `apps/`, and the `tests-integration` package (`pnpm-workspace.yaml:1-4`). The fourteen packages are contracts, curator, domain, eval, head, html, index, integrations, llm, session, snapshot, store, telemetry, and traces. Every package under `packages/` is `"private": true` and declares an `exports` map whose `.` entry points at `./dist/index.js`, so each package's `src/index.ts` barrel is the surface the other packages import (`packages/store/package.json:1-29`). `@memhtml/contracts` also exports seven subpaths, `./edges`, `./errors`, `./guidance`, `./paths`, `./slug`, `./store-config`, and `./types` (`packages/contracts/package.json:20-53`). Its barrel re-exports those seven modules and two more, `checkout-lock` and `record`, which have no subpath of their own (`packages/contracts/src/index.ts:1-9`). `@memhtml/store` also exports a `./testing` subpath that its barrel doesn't re-export (`packages/store/package.json:20-29`).

The symbols below are the barrel-named exports with the most distinct cross-package importer files, counted across every TypeScript file in the repo except `apps/docs`, which is out of scope. The count works like this. Each name a `packages/*/src/index.ts` barrel exports is followed through `export *` and `export { } from` to the file that declares it. Its count is the number of distinct `.ts` files outside the declaring package that name it in an `import`, `import type`, `export { } from`, destructured `await import()`, or `import * as` member access whose specifier is the declaring package's `@memhtml/<name>` barrel or one of its subpaths. Tests are included, and `apps/docs`, `node_modules`, and `dist` are skipped. An import through another package's re-export doesn't count. `GitFailure` is declared in `@memhtml/contracts` (`packages/contracts/src/errors.ts:24-28`), and most files import it through the re-exports in `@memhtml/store` (`packages/store/src/git.ts:38`) and `@memhtml/session` (`packages/session/src/errors.ts:9`). It counts only those two re-exporting files, so it isn't listed. The list is the top 30 plus every row tied at the cutoff. Positions 25 through 32 all have 6 importer files, so 32 symbols appear, ordered by count and then by name. Each entry gives the declaration copied from the source, what it does and how it fails, the declaration's line range, and its importer count.

### StorageFailure

```ts
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}
```

The typed failure for a rejected driver or filesystem call. Its only field is `operation`, a name for the step that failed. The database adapter logs the driver's own message with `Effect.logError` and puts only the operation name into the error (`packages/index/src/database.ts:152-162`). The store's `attemptIo` and `readFileOrNull` do the same for the filesystem, and so does the session package's own `attemptIo` (`packages/session/src/session.ts:135-144`). Several v2 refusals are a `StorageFailure` whose `operation` names the refusal. A second writer of one session id gets `session.locked` (`packages/session/src/session.ts:161-188`), and a writer whose log changed after it read the log gets `session.moved` (`packages/session/src/session.ts:304`). A snapshot file the reader refuses gets an operation such as `snapshot.read.format` (`packages/snapshot/src/snapshot.ts:495-509`). The reduction to an operation name is a convention of each construction site. `memhtml exec` appends `String(cause)` to the operation for its sandbox steps (`apps/cli/src/exec.ts:346-361`), so on that path the field can carry a runtime's error text.

`packages/contracts/src/errors.ts:9-11`, 52 importer files

### renderTemplate

```ts
export const renderTemplate = (input: NewMemoryInput): string =>
  serializeMemory(newMemoryDoc(input))
```

Renders a fresh memory file as bytes from write-tool parameters. It puts the claim in the first paragraph's `<mark>`, sets the status to `active` and both timestamps to `at`, and stamps `memhtml-content-hash` from the article it just built. A `task` gets the status `todo` when none is supplied (`packages/html/src/template.ts:152-202`). When `articleHtml` is supplied, it's used in place of `claim` and `body`, and the caller then owns the `<mark>` (`packages/html/src/template.ts:34-40`). `session put` renders each write it's given through `renderTemplate` before it validates the batch (`apps/cli/src/v2.ts:550`). It performs no format check and never fails. `parseMemory` is what rejects a malformed file.

`packages/html/src/template.ts:209-210`, 36 importer files

### HeadView

```ts
export interface HeadView {
  /** The commit this view was built from; null for a view with no git ancestry (tests, overlays on nothing). */
  readonly sha: string | null
  readonly size: number
  get(path: string): MemoryRecord | undefined
  paths(): Iterable<string>
  records(): Iterable<MemoryRecord>
  /** Active (non-archived) record holding this content hash, if any. */
  byContentHash(hash: string): string | undefined
  /** Active records whose claim shares this frame key. */
  byFrameKey(key: string): ReadonlyArray<string>
  /** Paths whose links point at this href (root-relative form). */
  inbound(href: string): ReadonlyArray<string>
  byEntity(entity: string): ReadonlyArray<string>
}
```

The read surface of one immutable corpus version, which every v2 package codes against. The head implements it over `effect` HashMaps, and its `HeadVersion` extends the indexed form of the view (`packages/head/src/version.ts:26-32`, `packages/head/src/indexes.ts:126-129`). A session implements it as the head plus its overlay through `withOverlay` (`packages/head/src/overlay.ts:147-153`), and a test can implement it over a plain `Map` (`packages/contracts/src/record.ts:5-9`). `sha` is the commit the view was built from. It's `null` for a view with no git ancestry, and an overlay keeps its base's `sha`. `byContentHash` and `byFrameKey` answer over active records only. An archived record still shows up in `get`, `records`, `inbound`, and `byEntity`. When two active records share a content hash, `byContentHash` names the first one inserted (`packages/head/src/indexes.ts:89-120`). Every method is synchronous, and none fails. A view the head didn't build gets its indexes rebuilt from `records()` each time an overlay or a search needs them (`packages/head/src/indexes.ts:152-157`).

`packages/contracts/src/record.ts:52-66`, 27 importer files

### MemoryRecord

```ts
export interface MemoryRecord {
  readonly path: string
  /** git blob sha of `html`, computed locally as sha1("blob <len>\0" + bytes). */
  readonly blobSha: string
  /** `sha256:<hex>` over the canonical `<article>` text (`@memhtml/html` contentHash). */
  readonly contentHash: string
  readonly frameKey: string | null
  readonly title: string
  readonly memoryType: string
  readonly status: string
  readonly claim: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly eventAt: string | null
  readonly confidence: number | null
  readonly importance: number | null
  readonly tags: ReadonlyArray<string>
  readonly entities: ReadonlyArray<string>
  readonly links: ReadonlyArray<RecordLink>
  readonly facets: ReadonlyArray<RecordFacet>
  readonly bodyText: string
  readonly html: string
  /** True when the path is under `archive/`. */
  readonly archived: boolean
}
```

The flat projection of one memory file. It carries the raw `html`, so a version can be written into a sandbox or a snapshot without going back to git. It also carries every field the indexes derive, so an index rebuild never re-parses (`packages/contracts/src/record.ts:5-7`). `recordFrom` builds one from a path and its bytes, and it fails with the parser's `InvalidMemory` when `parseMemory` rejects the file (`packages/head/src/record.ts:34-63`). `blobSha` is computed locally the way git hashes the UTF-8 bytes, so a record in a session overlay already has the sha that a later `hash-object -w` produces (`packages/head/src/record.ts:18-28`). `archived` is true when the path sits under `archive/`. A snapshot stores one row per record, and `recordAt` rebuilds each record from its columns on read (`packages/snapshot/src/snapshot.ts:413`).

`packages/contracts/src/record.ts:25-49`, 27 importer files

### ModelUnavailable

```ts
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  modelId: Schema.String,
  reason: Schema.String
}) {}
```

The typed failure for a model call that produced no usable answer, carrying `modelId` and a `reason` string. The source comment names throttling, an unavailable model, and a denied region. The code raises it in more cases than a refusal by Bedrock. Any transport rejection or unparseable payload raises it, with the SDK error's name and message as `reason` (`packages/llm/src/client.ts:47-83`). So does a response that stopped at `max_tokens` or `refusal` (`packages/llm/src/model-client.ts:178-186`), a `generate` answer with no text (`packages/llm/src/model-client.ts:207-217`), and an embedding response with the wrong vector count or width (`packages/llm/src/embeddings.ts:83-102`). Two v2 commands raise it too. `head embed` raises it when no document embedder is bound (`apps/cli/src/head-vectors.ts:357-366`). `curate run` raises it when a model failure stops the curator, and its `reason` counts the ops that stay in the session for `--resume` (`apps/cli/src/curate-run.ts:627-634`).

`packages/contracts/src/errors.ts:42-45`, 22 importer files

### InvalidMemory

```ts
export class InvalidMemory extends Schema.TaggedError<InvalidMemory>()("InvalidMemory", {
  reason: Schema.String
}) {}
```

The typed failure for a memory file that breaks the format or the type and placement vocabulary. Its one field, `reason`, is free text. `parseMemory` fills it with every violation it found, joined by `VIOLATION_SEPARATOR`, which is `"; "` (`packages/html/src/constraints.ts:42`). Other sites write their own reason. The store writes `a memory cannot link to itself: <path>` (`packages/store/src/store.ts:1332-1334`), and the CLI writes one for an unknown memory type (`apps/cli/src/operations.ts:83-92`). The head's overlay raises it for an op that doesn't parse or doesn't resolve, such as a `link` on a path the view doesn't hold or an `unlink` of an edge the file doesn't carry (`packages/head/src/overlay.ts:45-88`). `curate merge` also uses it to report a replay that was refused at commit (`apps/cli/src/v2.ts:1837-1842`).

`packages/contracts/src/errors.ts:48-50`, 20 importer files

### contentHash

```ts
export const contentHash = (input: HashableArticle | Node | string): string => {
  if (typeof input === "string") return digest(canonicalArticleText(articleTreeOf(input)))
  if (isHashableArticle(input))
    return digest(canonicalArticleText(parseArticleFragment(input.article.html)))
  return digest(canonicalArticleText(input))
}
```

Computes `sha256:<64 hex>` over an article's canonical text (`canonicalText`). In that text, runs of ASCII whitespace collapse to one space, and text inside `<pre>` is kept byte for byte (`packages/html/src/hash.ts:101-125`). It accepts a parsed document, an article node, or a string. A string that contains an `<article>` element is hashed on the first one, and a string without one is hashed as bare article markup. It never fails, because rejecting malformed input is left to `parseMemory` (`packages/html/src/hash.ts:163-185`). The hash is the dedupe key. A record's `contentHash` comes from it (`packages/head/src/record.ts:43`), and `validateOps` reports a put whose hash an active record or an earlier put already holds as a `duplicate` (`packages/session/src/validate.ts:273-279`).

`packages/html/src/hash.ts:156-161`, 20 importer files

### OverlayOp

```ts
export type OverlayOp =
  | { readonly kind: "put"; readonly path: string; readonly html: string }
  | { readonly kind: "archive"; readonly path: string; readonly to: string; readonly html: string }
  | { readonly kind: "link"; readonly path: string; readonly rel: string; readonly href: string }
  | { readonly kind: "unlink"; readonly path: string; readonly rel: string; readonly href: string }
  | { readonly kind: "label"; readonly path: string; readonly entity: string }
  | { readonly kind: "unlabel"; readonly path: string; readonly entity: string }
  | { readonly kind: "move"; readonly path: string; readonly to: string; readonly html: string }
```

One entry in a session's overlay log. There are seven kinds. A `put` writes a new file, and an `archive` moves an active record to its archive path. `link` and `unlink` add or drop one `(rel, href)` edge. `label` and `unlabel` add or drop one `memhtml-entity` value. A `move` relocates an active record to a new live path with its bytes unchanged (`packages/contracts/src/record.ts:68-80`). A session never edits an active claim in place, so a changed claim is a `put` plus an `archive` of the old file. The four edge and entity edits touch only the head, so a record's content hash survives them. A move repoints nothing by itself, and `validateOps` refuses a batch that leaves an edge to the old path behind. `withOverlay` applies a log in order and fails with `InvalidMemory` on the first op that doesn't parse or resolve (`packages/head/src/overlay.ts:147-153`). The session log decodes each op against `OverlayOpSchema`, which has one branch per kind, and a type check fails the build when the contract gains a kind the schema lacks (`packages/session/src/session.ts:93-121`, exported as `OverlayOpSchema`, with the compile-time guard at `:128-133`).

`packages/contracts/src/record.ts:81-88`, 17 importer files

### makeGit

```ts
export const makeGit = (root: string): GitShape => ({
```

Builds the `GitShape` service over the `git` binary. It runs every call as `git -C <root>` through `execFile` (`packages/store/src/git.ts:222-257`). Each spawn sets `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and `LC_ALL=C`, and removes the repository-selecting variables such as `GIT_DIR`, so a call made from inside a git hook still targets `root` (`packages/store/src/git.ts:174-207`). The user's own git config is still read, which is why every parsed call states its output format with explicit flags. `layerGit` wraps it as a layer (`packages/store/src/git.ts:493`). The CLI's v2 code calls it directly when it needs git for a root it already holds, as `loadVersion` does to load a head version (`apps/cli/src/head-cache.ts:177-183`). Tests use it to drive the real binary against a temporary repository.

`packages/store/src/git.ts:292-467`, 16 importer files

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

Parses a memory file into a `MemoryDoc`. It fails with `InvalidMemory` when the structural check or the head-meta reader reports any violation, and `reason` is every violation joined by `VIOLATION_SEPARATOR`. When there's no violation but the head metadata or the `<article>` element is still missing, `reason` is the fixed string `head metadata is incomplete`. Structural warnings don't fail the parse. They come back in `warnings`. `checkMemory` returns the same violations and warnings as lists without building a doc (`packages/html/src/parse.ts:417-427`). The head skips a file that `parseMemory` rejects and counts it in `skipped` (`packages/head/src/version.ts:29-31`).

`packages/html/src/parse.ts:385-411`, 16 importer files

### DatabaseService

```ts
export const DatabaseService = Context.Service<DatabaseShape>("memhtml/Database")
```

The Effect service key under which the layer graph provides and requests a `DatabaseShape`. The CLI's `layerDatabase` provides it by opening `.memhtml/index.db` with `state.db` attached through `makeDatabase`. That layer ends with `Layer.orDie` (`apps/cli/src/api-layer.ts:111-129`). So a failure to open or migrate either database surfaces as a defect, and no typed `StorageFailure` reaches the caller.

`packages/index/src/database.ts:95`, 14 importer files

### EMBED_WATERMARK

```ts
export const EMBED_WATERMARK = `${EMBED_MODEL_ID}@${EMBED_DIM}`
```

The vector-space label that `index_state.embed_model` stores. It joins the model id and the dimension with `@`, which gives `cohere.embed-v4:0@1024` (`packages/llm/src/constants.ts:7-8`). Before `update`, `index embed`, and any rebuild that can't write vectors, the indexer's `guardEmbedModel` compares the stored label with this one. When they differ, it fails with `EmbedModelMismatch`, carrying `stored` and `configured` (`packages/index/src/indexer.ts:159-165`, `packages/index/src/indexer.ts:332-338`). `memhtml index rebuild --embed` with an embedder present runs no check before it starts. Its `truncateForRebuild` writes the configured label into `index_state` in the same transaction that empties the tables, and it keeps only stored vectors already in the configured space (`packages/index/src/indexer.ts:398-415`, `packages/index/src/indexer.ts:689-696`). Test fakes use it as the `modelId` of a simulated outage (`apps/cli/tests/harness.ts:87`).

`packages/llm/src/constants.ts:34`, 14 importer files

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

The SQLite connection contract that every reader and writer of the index plane holds. `run`, `get`, and `all` run one statement. `writeAll` runs a batch in one transaction, and `script` runs a parameterless multi-statement script in one transaction. Two counters report applied migrations, and `hasState` reports the state attachment. Every method fails with `StorageFailure` whose `operation` is the method's name, after the driver's message is logged. A statement that hits `SQLITE_BUSY` is retried with jittered exponential backoff for up to 20 seconds before it fails (`packages/index/src/database.ts:147-184`). `writeAll` and `script` run inside `BEGIN IMMEDIATE` and issue `ROLLBACK` on any throw. An error from that `ROLLBACK` is swallowed, so the original failure is the one reported (`packages/index/src/database.ts:262-273`). `makeDatabase` sets `hasState` from whether the caller passed a state database (`packages/index/src/database.ts:396`). It doesn't probe the state tables.

`packages/index/src/database.ts:61-93`, 10 importer files

### EMBED_DIM

```ts
export const EMBED_DIM = 1024
```

The embedding width. `buildEmbedBody` sends it as `output_dimension` on every embed request (`packages/llm/src/embeddings.ts:57-66`). Cohere Embed v4 returns 1536 floats when that field is absent, per the probe the file's header comment records (`packages/llm/src/constants.ts:1-6`). A response vector of any other width fails the batch with `ModelUnavailable`, and its `reason` names the vector's index and the width it carried (`packages/llm/src/embeddings.ts:94-99`). The head's vector space pairs it with `EMBED_MODEL_ID`, and that space names the head's vector cache file (`apps/cli/src/head-vectors.ts:35-38`).

`packages/llm/src/constants.ts:8`, 10 importer files

### normalizePath

```ts
export const normalizePath = (path: string): string => {
  const collapsed = path.replace(/^\/+/, "").replace(/\/{2,}/g, "/")
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed
}
```

Reduces a caller-supplied path to the git-tree form. It drops leading slashes, collapses runs of slashes to one, and removes a trailing slash. It never fails and does no validation, so `.` and `..` segments pass through unchanged. `memoryPathViolation` is the check that refuses a path outside the four PARA buckets, one that doesn't end in `.html`, or one carrying a blank, `.`, or `..` segment (`packages/contracts/src/paths.ts:83-100`). A session put whose path fails that check is a `format` violation (`packages/session/src/validate.ts:266-271`).

`packages/contracts/src/paths.ts:57-60`, 10 importer files

### addLink

```ts
export const addLink = (html: string, rel: EdgeRel, href: string): string => {
  const token = relTokenFor(rel)
  const document = parseDocument(html)
  const head = headOf(document)
  if (head === undefined) return html
  if (
    memhtmlLinks(head).some((link) => attr(link, "rel") === token && attr(link, "href") === href)
  ) {
    return html
  }
  const offset = insertionOffsetForLink(html, head)
  return offset === undefined ? html : insertAt(html, offset, `${linkLine(token, href)}\n`)
}
```

Appends one `<link>` edge line to a memory's head. The rel token is `memhtml-` plus the rel with underscores written as hyphens, which `relTokenFor` builds (`packages/contracts/src/edges.ts:106-110`). It's idempotent on the `(rel, href)` pair, so a second call with the same edge returns the input. The new line goes after the last `memhtml-` link, else after the last `memhtml-` meta, else at `</head>` (`packages/html/src/editors.ts:102-128`). It splices bytes by source offset and never touches the article, so the content hash doesn't change. It never fails. A file with no `<head>`, or a parse with no source location, comes back unchanged. The store calls it to add a link and to record a correction's `supersedes` edge (`packages/store/src/store.ts:1339`, `packages/store/src/store.ts:1094`). The overlay's `link` op and the session commit call it too (`packages/head/src/overlay.ts:57`, `packages/session/src/commit.ts:130-137`). The commit also uses it to mark a frame-key rival with a `contradicts` edge (`packages/session/src/commit.ts:197-208`).

`packages/html/src/editors.ts:226-238`, 8 importer files

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

Returns a claim's frame key. The key is the text up to the last linking word (`of`, `is`, `in`, `to`, `by`, `as`) that a value follows, lowercased. Two claims that write different values into the same slot share a key. Whitespace runs collapse before the match. It returns `null` when the claim has no such split, when the frame has fewer than three tokens, or when the value has more than six (`packages/domain/src/frame.ts:48-54`). The source comment calls the key case-insensitive. The linking-word pattern has no `i` flag and runs before the lowercasing, though. So `The Capital Of India Is X` returns `null`, and `the capital of India is Y` keys on `the capital of india is`. The head indexes active records by it in `byFrameKey` (`packages/head/src/indexes.ts:100-101`). A session commit links each new put to every active record with the same key through a `contradicts` edge (`packages/session/src/commit.ts:197-208`).

`packages/domain/src/frame.ts:67-78`, 8 importer files

### EdgeRel

```ts
export const EdgeRel = Schema.Literals(ALL_RELS)
export type EdgeRel = typeof EdgeRel.Type
```

The schema and derived type for every relationship name across the four edge classes. There are nine memory rels, two person rels, one provenance rel, and two task rels, fourteen in all (`packages/contracts/src/edges.ts:19-60`). The `edges` table restates the per-class lists as CHECK constraints keyed on `edge_class` (`packages/index/migrations/0008_tasks.sql:194-199`). `relClassFor` derives the class from the rel, since each name belongs to exactly one class (`packages/contracts/src/edges.ts:70-75`). The head's overlay refuses a `link` op whose rel isn't in this list (`packages/head/src/overlay.ts:52-54`), and an `unlink` op the same way (`packages/head/src/overlay.ts:70-72`).

`packages/contracts/src/edges.ts:62-63`, 7 importer files

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

The closed vocabulary of ten memory types. The `files.memory_type` CHECK constraint restates the same ten values (`packages/index/migrations/0008_tasks.sql:38-40`). `arc` is in the vocabulary, but agents can't write it, which `WRITABLE_MEMORY_TYPES` encodes. Search leaves `task` out through `EXCLUDED_BY_DEFAULT` unless the caller names it in the type filter (`packages/index/src/scope.ts:262-280`). Search on the head applies the same `EXCLUDED_BY_DEFAULT` default (`apps/cli/src/head-scope.ts:124-126`).

`packages/contracts/src/types.ts:18-29`, 7 importer files

### MemoryType

```ts
export const MemoryType = Schema.Literals(MEMORY_TYPES)
export type MemoryType = typeof MemoryType.Type
```

The schema and derived type for the ten `MEMORY_TYPES` values, so decoding a string outside the vocabulary with this schema fails. The write path narrows further. `WritableMemoryType` and `WRITABLE_MEMORY_TYPES` leave out `arc` (`packages/contracts/src/types.ts:34-53`). The policy file's `RefusedType` entries decode against it, so an unknown type in `writeBar.refusedTypes` makes the file invalid (`packages/contracts/src/store-config.ts:50-57`).

`packages/contracts/src/types.ts:31-32`, 7 importer files

### STATE_SCHEMA

```ts
export const STATE_SCHEMA = "state"
```

The schema name, `state`, under which `state.db` is ATTACHed. Queries that reach the durable state plane qualify its tables with this name, and most TypeScript sites interpolate the constant. The ATTACH statement itself, the state migrations, and the CLI's archive mirror write `state` literally (`packages/index/src/database.ts:291-293`, `packages/index/state-migrations/S0001_access.sql:13`, `apps/cli/src/api-layer.ts:198`). Changing the constant alone wouldn't move them.

`packages/index/src/schema-const.ts:21`, 7 importer files

### STORE_CONFIG_FILE

```ts
export const STORE_CONFIG_FILE = "memhtml.config.json"
```

The name of the store's policy file, kept at the store root and tracked in git beside the corpus (`packages/contracts/src/store-config.ts:5-18`). It doesn't end in `.html`, so it's never a memory. The CLI's `loadStorePolicy` reads it from the working tree. An absent file, `ENOENT` or `ENOTDIR`, means the library defaults. A file that can't be read or doesn't decode fails with `StoreConfigInvalid` (`apps/cli/src/store-config.ts:63-93`). Nothing caches it. The CLI reads it once per command that judges or creates a record, the head server once per `/v1/neighbors` and `/v1/exec` request, and the MCP server once per record-creating tool call (`apps/cli/src/store-config.ts:27-36`). No session scope may write the file, because `validateOps` lists it in `STORE_FILES` (`packages/session/src/validate.ts:80-81`).

`packages/contracts/src/store-config.ts:21`, 7 importer files

### sessionStateFile

```ts
export const sessionStateFile = (root: string, id: string): string =>
  join(root, SESSIONS_DIR, `${id}.json`)
```

The path of one session's log, `.memhtml/sessions/<id>.json` under the root (`packages/session/src/session.ts:57-58`). It only joins the parts. An id must match `SESSION_ID`, which takes a letter or digit followed by up to 127 characters from `[A-Za-z0-9._-]` (`packages/session/src/session.ts:62`). The callers that take the session lock or read the log check the id first and refuse a bad one with `session.id` (`packages/session/src/session.ts:146-151`). The log is written to a temp file and renamed into place, so a reader never sees half a file (`packages/session/src/session.ts:190-206`). `startSession` refuses an id that already has a log with `session.exists` unless `force` is set (`packages/session/src/session.ts:248-253`). `resumeSession` reads the log, and a missing or malformed one is a `StorageFailure` (`packages/session/src/session.ts:289-301`). Session pruning finds each log through it (`packages/session/src/prune.ts:194`).

`packages/session/src/session.ts:69-70`, 7 importer files

### slugify

```ts
export const slugify = (title: string): string => {
  const kebab = kebabOf(title)
  if (kebab === "") return SLUG_FALLBACK

  return kebab.length <= SLUG_MAX_LENGTH
    ? kebab
    : kebab.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "") || SLUG_FALLBACK
}
```

Kebab-cases a title into `[a-z0-9-]`. `kebabOf` applies NFKD, strips combining marks so diacritics fold to base letters, and lowercases. Then it replaces each run of other characters with one hyphen and trims hyphens from both ends (`packages/contracts/src/slug.ts:36-44`). A title that reduces to nothing returns `SLUG_FALLBACK`, which is `untitled`. A result longer than `SLUG_MAX_LENGTH` (80) is cut there, and any exposed trailing hyphen is trimmed (`packages/contracts/src/slug.ts:7-22`). A slug fed back in comes out unchanged. This is the slug of every name that is recomputed each time it's used, such as a workspace's `projects/<slug>/` folder and a tag's `resources/<slug>/`, so its cut never changes and a long workspace or tag stays one folder. A new record's filename stem is `slugifyStem`'s.

`packages/contracts/src/slug.ts:62-69`, 5 importer files

### slugifyStem

```ts
export const slugifyStem = (title: string): string => {
  const kebab = kebabOf(title)
  if (kebab === "") return SLUG_FALLBACK
  return cutAtWord(kebab, SLUG_MAX_LENGTH) || SLUG_FALLBACK
}
```

The filename stem a new record takes from its title, which `memoryPathFor` and both collision loops use (`packages/contracts/src/paths.ts:199`, `packages/store/src/store.ts:460`, `apps/cli/src/v2.ts:338`). It kebab-cases as `slugify` does, and a result longer than 80 is cut at its last hyphen at or before 80 when that leaves at least `SLUG_MIN_WORD_CUT` (60) characters, so it ends on a whole word, and at 80 otherwise (`cutAtWord` at `packages/contracts/src/slug.ts:24-34`). It equals `slugify` for every title whose slug fits the budget. `withCollisionOrdinal` cuts its stem by the same rule to make room for a `-N` suffix. A stem is computed only when a record is minted, and the path is the record's id from then on, so the rule decides new filenames and never moves an existing file.

`packages/contracts/src/slug.ts:82-86`, 2 importer files

### DirtyTree

```ts
export class DirtyTree extends Schema.TaggedError<DirtyTree>()("DirtyTree", {
  paths: Schema.Array(Schema.String)
}) {}
```

The typed failure for an operation that needs a clean tree and found uncommitted changes. It carries the dirty `paths`, and the CLI maps it to `ERR_DIRTY_TREE` (`apps/cli/src/errors.ts:55-56`). When the target ref is checked out, `landOnRef` checks the paths a landing changes and answers `worktree-dirty` when any of them has uncommitted state (`packages/session/src/commit.ts:308-313`). `curate merge` turns that answer into `DirtyTree` on both its fast-forward and its replay (`apps/cli/src/v2.ts:1741-1743`, `apps/cli/src/v2.ts:1843-1844`). `curate run` does the same when it lands (`apps/cli/src/curate-run.ts:511-512`). Nothing moves in either case. `session commit` reports the same case as its `worktree-dirty` outcome (`apps/cli/src/v2.ts:1085-1090`). The store's `requireCleanTree` raises it over every dirty path that isn't ignored (`packages/store/src/store.ts:1360-1373`).

`packages/contracts/src/errors.ts:67-69`, 6 importer files

### StoreConfigInvalid

```ts
export class StoreConfigInvalid extends Schema.TaggedError<StoreConfigInvalid>()(
  "StoreConfigInvalid",
  {
    path: Schema.String,
    reason: Schema.String
  }
) {}
```

The typed failure for a policy file that can't be read or doesn't decode. It carries the file's `path` and a `reason` that names what's wrong and where. The CLI maps it to `ERR_STORE_CONFIG` (`apps/cli/src/errors.ts:93-94`), and it suggests `memhtml config` and then an edit or removal of the file (`apps/cli/src/errors.ts:258-261`). Its one producer is `loadStorePolicy` (`apps/cli/src/store-config.ts:63-93`). Decoding is strict. An unknown key, a value of the wrong type, an unknown memory type, or a type listed twice each becomes a `reason` (`packages/contracts/src/store-config.ts:194-230`). A typo in the file therefore can't loosen the policy. Commands that need no policy, such as reads, search, and status, never read the file and never raise it (`apps/cli/src/store-config.ts:38-43`).

`packages/contracts/src/errors.ts:89-95`, 6 importer files

### Violation

```ts
export type Violation =
  | { readonly kind: "format"; readonly path: string; readonly reasons: ReadonlyArray<string> }
  | { readonly kind: "duplicate"; readonly path: string; readonly existing: string }
  /** A put over an active path with a different content hash. Claims are never edited in place. */
  | { readonly kind: "claim-edit"; readonly path: string }
  /**
   * `.memhtml/`, `index.html`, `sitemap.xml` under every scope; `areas/arcs/` and `resources/people/`
   * too unless the scope is `curate`.
   */
  | { readonly kind: "reserved-path"; readonly path: string }
  | { readonly kind: "batch-cap"; readonly count: number; readonly cap: number }
  /**
   * A new record that fails the store's write bar ({@link writeBarReasons}): a type the store
   * refuses, or, under the anchor rule, a record that names nothing it is about. Every scope and
   * every type is judged; only an archive destination is not, because it is an existing record
   * moving. Under the anchor rule an `unlabel` that leaves its record with no entity and no
   * workspace path fails too, and so does a `move` destination that names nothing.
   */
  | { readonly kind: "write-bar"; readonly path: string; readonly reasons: ReadonlyArray<string> }
```

One mechanical refusal from `validateOps`, the check a session commit runs before it writes anything. The check reads only the view and the ops, with no model call and no I/O (`packages/session/src/validate.ts:19-22`). There are six kinds. A batch over `BATCH_CAP`, which is 200 ops, gets a single `batch-cap` violation, and nothing else is judged (`packages/session/src/validate.ts:45`, `packages/session/src/validate.ts:181-189`). For a put, a path or format problem is `format`. A content hash that an active record or an earlier put in the batch holds is `duplicate`, and a different article at an active path is `claim-edit` (`packages/session/src/validate.ts:264-279`). `reserved-path` covers `.memhtml/`, the policy file, `index.html`, and `sitemap.xml` under every scope, plus the arcs and people prefixes outside the `curate` scope (`packages/session/src/validate.ts:86-97`). `write-bar` carries the store policy's reasons for a new record. A commit refuses the whole batch on any violation and writes nothing (`packages/session/src/commit.ts:495-500`). `session put` and `session exec` refuse a call only for `batch-cap` or for a blocking kind on a path the call touches. The blocking kinds are `format`, `reserved-path`, `batch-cap`, and `write-bar`, plus `duplicate` and `claim-edit` in a session bound by `MEMHTML_SESSION` (`apps/cli/src/v2.ts:333-354`).

`packages/session/src/validate.ts:24-42`, 6 importer files

### WriteBarPolicy

```ts
export interface WriteBarPolicy {
  /** Each refused type with the reason its refusal gives. */
  readonly refusedTypes: ReadonlyMap<string, string>
  readonly requireAnchor: boolean
}
```

The policy half of the write bar, which `validateOps` applies beyond format and integrity (`packages/contracts/src/store-config.ts:98`). `refusedTypes` maps each refused type to the reason its refusal gives. `storePolicyOf` builds the map from the file, and a type listed by name alone gets the reason `refusedTypeReason` writes (`packages/contracts/src/store-config.ts:151-163`). With `requireAnchor` on, a new record must name a `memhtml-entity` or sit under `projects/<slug>/`, which `isAnchored` checks (`packages/session/src/validate.ts:109-112`). The library default, `DEFAULT_WRITE_BAR`, refuses no type and anchors nothing (`packages/contracts/src/store-config.ts:117-121`). `writeBarReasons` returns no reason for an archive destination or a file that doesn't parse (`packages/session/src/validate.ts:131-145`). The bar holds under every scope and for every type, the curator's writes and tasks included (`packages/session/src/validate.ts:114-130`).

`packages/contracts/src/store-config.ts:99-103`, 6 importer files

### appendOps

```ts
export const appendOps = (
  session: Session,
  ops: ReadonlyArray<OverlayOp>
): Effect.Effect<Session, StorageFailure> => {
  const next: Session = { ...session, ops: [...session.ops, ...ops] }
  return withSessionLock(
    session.root,
    session.id,
    requireLogUnmoved(session).pipe(Effect.andThen(writeState(next)))
  ).pipe(Effect.as(next))
}
```

Appends ops to a session's log, persists the log, and returns the session the caller should keep using. It doesn't validate the ops. `session put` runs `validateOps` first and appends nothing when a blocking violation applies (`apps/cli/src/v2.ts:556-568`). The write runs under the session's exclusive lock. A second writer of the same id fails at once with `session.locked` (`packages/session/src/session.ts:161-188`). A lock whose mtime goes 30 seconds without a refresh counts as stale (`packages/session/src/session.ts:66-67`). Under the lock, `requireLogUnmoved` re-reads the log. It fails with `session.moved` and writes nothing when the ops on disk differ from the ops the caller read (`packages/session/src/session.ts:304-319`). Every failure is a `StorageFailure`.

`packages/session/src/session.ts:325-335`, 6 importer files

### originalPathFor

```ts
export const originalPathFor = (archivePath: string): string | undefined => {
  const normalized = normalizePath(archivePath)
  const match = /^archive\/(\d{4,})\/(.+)$/.exec(normalized)
  return match?.[2]
}
```

The inverse of `archivePathFor` (`packages/contracts/src/paths.ts:217-218`). It normalizes the path, strips exactly one `archive/<year>/` prefix whose year has four or more digits, and returns the rest. It returns `undefined` for a path without such a prefix, and `isArchivePath` asks the same question as a boolean (`packages/contracts/src/paths.ts:232`). A memory archived twice gives back its first archive path. An archive op whose destination doesn't map back to its source through `originalPathFor` is a format violation (`packages/session/src/validate.ts:299-301`).

`packages/contracts/src/paths.ts:225-229`, 6 importer files

### setMeta

```ts
export const setMeta = (html: string, name: string, value: string): string => {
  if (!isMemoryMetaName(name)) return html
  const document = parseDocument(html)
  const head = headOf(document)
  if (head === undefined) return html

  const existing = memhtmlMetas(head).find((meta) => meta.name === name)
  if (existing !== undefined) {
    const span = spanOf(existing.element)
    if (span === undefined) return html
    return splice(html, span, metaLine(name, value))
  }

  const offset = insertionOffsetForMeta(html, head, name)
  return offset === undefined ? html : insertAt(html, offset, `${metaLine(name, value)}\n`)
}
```

Sets one head meta to one value. It replaces the first `<meta>` of that name in place, or it inserts a new line at the name's position in `META_ORDER` (`packages/html/src/editors.ts:74-100`). Exactly one line changes, and the article stays outside the edited range, so the content hash is the same before and after for every name (`packages/html/src/editors.ts:145-154`). On a repeatable key it sets the first value, and `addMeta` is the append. A name outside the meta vocabulary that `isMemoryMetaName` checks returns the input unchanged (`packages/html/src/vocabulary.ts:89-91`), and so does a file with no `<head>`. It never fails. A session commit stamps an archived copy's `memhtml-status` and `memhtml-archived` through it (`packages/session/src/commit.ts:90-95`). The CLI's `task status` stamps `memhtml-task-status` and `memhtml-updated` through it (`apps/cli/src/operations.ts:2009-2013`).

`packages/html/src/editors.ts:155-170`, 6 importer files

### snapshotPathFor

```ts
export const snapshotPathFor = (root: string, sha: string): string =>
  join(root, SNAPSHOTS_DIR, `${sha}.arrow`)
```

The path of one commit's snapshot, `.memhtml/snapshots/<sha>.arrow` under the root (`packages/snapshot/src/snapshot.ts:176-181`). A snapshot is one Arrow IPC file per commit with one row per `MemoryRecord` (`packages/snapshot/src/snapshot.ts:1-15`). The function only joins the parts and checks nothing. `loadVersion` tries the sha's own snapshot first, then ancestor snapshots it can advance from, then a full git read (`apps/cli/src/head-cache.ts:167-224`). A file that doesn't decode, or whose metadata names another sha, is logged, removed, and treated as a miss (`apps/cli/src/head-cache.ts:140-165`). `writeSnapshot` writes the bytes to a sibling staging file and renames it into place with no `fsync` (`packages/snapshot/src/snapshot.ts:320-345`). `writeHeadSnapshot` then prunes the directory to the newest four (`apps/cli/src/head-cache.ts:237-260`), the default `SNAPSHOTS_KEPT` (`packages/snapshot/src/prune.ts:20`).

`packages/snapshot/src/snapshot.ts:180-181`, 6 importer files

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at cf76951.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 46 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 43 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 43 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 34 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 32 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 21 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 20 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 19 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 19 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 18 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 15 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 15 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 13 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 13 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 10 shared source citations
