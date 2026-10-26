---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Contract map

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

Every inter-module contract in memhtml runs through `@memhtml/contracts`: its barrel re-exports nine files of shared types, closed vocabularies, error classes and path rules (`packages/contracts/src/index.ts:1-9`), and the other workspace packages import them by name, often through subpaths such as `@memhtml/contracts/edges` (`packages/html/src/serialize.ts:1`). A contract here is any interface, schema, literal vocabulary or on-disk format that crosses a package boundary. The page was built from the contracts sources, the import statements that name them under `apps/*/src` and `packages/*/src`, and the consumer sites that read them.

The analysis looked for implicit contracts: keys and names written in one place and read in another with no shared constant, type or import between them. Reviewers confirmed none of those candidates, so every section below is an explicit contract. Sections are ordered by how many source files import from each contract, counted over the files `git ls-files 'apps/*/src/**.ts' 'packages/*/src/**.ts'` lists outside `packages/contracts`: errors 56, paths 26, `HeadView` 20, edges 17, `MemoryRecord` 14, memory types 14, `OverlayOp` 11, store config 9, slugs 7, checkout lock 4, recall guidance 3.

## Tagged error classes

**Producer:** `packages/contracts/src/errors.ts:9-106`, re-exported by session (`packages/session/src/errors.ts:9`) and raised by store's git service (`packages/store/src/git.ts:2`).

**Consumers:**

- `apps/cli/src/errors.ts::codeFor` maps each `_tag` to an `ERR_*` code (`apps/cli/src/errors.ts:43-60`).
- `apps/mcp/src/failure.ts::mcpSuggestionsFor` maps each `_tag` to recovery suggestions (`apps/mcp/src/failure.ts:80-159`).
- `packages/session/src/commit.ts:633` matches a `StorageFailure` by its `operation`.

**Shape:**

```ts
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}
```

```ts
export class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  command: Schema.String,
  /** The process exit code, or `null` when the process never started. */
  exitCode: Schema.NullOr(Schema.Int)
}) {}
```

**Assumptions consumers make:**

- The `_tag` strings are stable: the CLI switches on string literals such as `"GitFailure"` and `"StorageFailure"`, not on classes. `apps/cli/src/errors.ts:46-49`
- The MCP edge switches on the same literals and reads `error.path` and `error.existingPath` off the payload. `apps/mcp/src/failure.ts:94-101`
- A `StorageFailure` whose `operation` equals `CHECKOUT_LOCKED` means the checkout lock wait ran out. `packages/session/src/commit.ts:633`
- An MCP resource read turns `GitFailure` into its own refusal. `apps/mcp/src/resources.ts:289`

**Drift risk:** renaming a tag compiles cleanly, because both edges compare `_tag` against string literals, and the error falls through to the default case. Mitigation: switch on `ErrorClass._tag`-typed unions so a rename fails typecheck.

## Memory path rules

**Producer:** `packages/contracts/src/paths.ts:10-367` (directory constants, `normalizePath`, archive slot rules).

**Consumers:**

- `packages/session/src/validate.ts:344-351` picks the archive slot during batch validation.
- `packages/curator/src/collapse-briefing.ts:92` plans archive destinations.
- `apps/cli/src/operations.ts:2060` and `apps/cli/src/replay.ts:147` read an archive path back to its live path.
- `packages/curator/src/briefing.ts:343`

**Shape:**

```ts
export const normalizePath = (path: string): string => {
  const collapsed = path.replace(/^\/+/, "").replace(/\/{2,}/g, "/")
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed
}
```

```ts
export const archivePathFor = (path: string, year: number, generation = 1): string =>
  `${ARCHIVE_BUCKET}/${yearSegment(year, generation)}/${normalizePath(path)}`
```

**Assumptions consumers make:**

- Every archiving writer takes the slot `archiveSlotFor` returns, and session's validator recomputes it against the view and the batch's own destinations. `packages/session/src/validate.ts:347-351`
- `originalPathFor` strips exactly one archive prefix, so for a task archived twice it names another archive path, and the CLI leaves the reopen advice out of the refusal. `apps/cli/src/operations.ts:2055-2060`
- Replay finds an archived twin by comparing `originalPathFor(candidate)` to the live path. `apps/cli/src/replay.ts:147`

**Drift risk:** a change to the `archive/<YYYY>.<n>/` layout in `archivePathFor` (`packages/contracts/src/paths.ts:237-238`) would orphan archives already in git trees, since `originalPathFor` (`:267-268`) would stop recognizing them. Mitigation: keep the left-inverse property under the existing contracts tests and add a fixture of old-format paths.

## HeadView, the read surface of one corpus version

**Producer:** `packages/contracts/src/record.ts:52-66`, implemented by head over persistent maps (`packages/head/src/indexes.ts:20`) and by session over head plus overlay (`packages/head/src/overlay.ts::withOverlay`).

**Consumers:**

- `packages/session/src/validate.ts:304` and `:520` (dedup by content hash, inbound edge holders).
- `packages/session/src/moves.ts:147`
- `packages/session/src/commit.ts:302`
- `apps/cli/src/head-scope.ts:147`

**Shape:**

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

**Assumptions consumers make:**

- `byContentHash` answers only for active records, so a hit means a live duplicate. `packages/session/src/validate.ts:304`
- `inbound` takes the root-relative href form, which session passes. `packages/session/src/moves.ts:147`
- The CLI doesn't trust that form and queries both `/path` and `path`. `apps/cli/src/head-scope.ts:147`

**Drift risk:** head keys `inbound` by `link.href` as authored (`packages/head/src/indexes.ts:77`), so the doc comment's "root-relative form" holds only while every writer authors root-relative hrefs, and a consumer that queries one form misses edges written in the other. Mitigation: normalize hrefs through `pathToHref` when the index is built.

## Edge vocabulary and the HTML rel token

**Producer:** `packages/contracts/src/edges.ts:9-149`.

**Consumers:**

- `packages/html/src/serialize.ts:106` writes `<link rel>` tokens.
- `packages/html/src/parse.ts:285` and `packages/html/src/constraints.ts:319` read them back.
- `apps/mcp/src/tools.ts:62` and `apps/cli/src/commands.ts:502` expose the rel enum on the wire.
- `packages/head/src/overlay.ts:2`

**Shape:**

```ts
export const relTokenFor = (rel: EdgeRel): string =>
  `${REL_TOKEN_PREFIX}${rel.replaceAll("_", "-")}`
```

```ts
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

- A token outside the closed vocabulary parses to `undefined` and fails the constraint check. `packages/html/src/constraints.ts:319`
- The MCP tool and the CLI flag accept exactly `MEMORY_RELS`. `apps/mcp/src/tools.ts:62`

**Drift risk:** the index migrations restate every rel as SQL `CHECK` literals (`packages/index/migrations/0008_tasks.sql:194-199`), and no test under `packages/index/tests` or `tests-integration/tests` names `ALL_RELS` (`rg -ln 'MEMORY_TYPES|ALL_RELS' packages/index/tests tests-integration/tests`), so a new rel in `edges.ts` passes typecheck and fails at insert time. Mitigation: a test that reads the migration's `CHECK` list and compares it to `ALL_RELS`.

## MemoryRecord, one parsed memory file

**Producer:** `packages/contracts/src/record.ts:25-49`, built by head (`packages/head/src/record.ts:2`).

**Consumers:**

- `packages/snapshot/src/snapshot.ts:186` flattens records into columns.
- `packages/curator/src/briefing.ts:343`
- `apps/cli/src/head-scope.ts:149`

**Shape:**

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

**Assumptions consumers make:**

- Snapshot columns are nullable only where `MemoryRecord` allows null. `packages/snapshot/src/snapshot.ts:160`
- The curator reads an archived record's live path from `record.path`. `packages/curator/src/briefing.ts:343`

**Drift risk:** `memoryType` and `status` are typed `string`, not the `MemoryType` and `MemoryStatus` literal schemas from `packages/contracts/src/types.ts:31` and `:69`, so a consumer that switches on them gets no exhaustiveness check. Mitigation: type both fields with the literal unions.

## Memory type, status and PARA vocabularies

**Producer:** `packages/contracts/src/types.ts:18-89`.

**Consumers:**

- `packages/html/src/parse.ts:3` validates `memhtml-type` and task status on read.
- `apps/mcp/src/tools.ts:59` and `:937` build tool parameter enums.
- `apps/cli/src/commands.ts:132` builds the CLI flag enum.
- `packages/index/src/scope.ts:263`

**Shape:**

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

**Assumptions consumers make:**

- The write surfaces offer `WRITABLE_MEMORY_TYPES`, which omits `arc`. `apps/mcp/src/tools.ts:59`
- Index scope filtering treats any string outside `MEMORY_TYPES` as unknown. `packages/index/src/scope.ts:263`

**Drift risk:** `WritableMemoryType` restates the nine writable types by hand (`packages/contracts/src/types.ts:42-52`) beside the derived `WRITABLE_MEMORY_TYPES` (`:38-40`), and the `files.memory_type` SQL `CHECK` restates all ten (`packages/index/migrations/0008_tasks.sql:38-40`), so a new type needs three edits that nothing ties together. Mitigation: build `WritableMemoryType` from `WRITABLE_MEMORY_TYPES` and test the migration list against `MEMORY_TYPES`.

## OverlayOp, the session's edit log entry

**Producer:** `packages/contracts/src/record.ts:81-88`.

**Consumers:**

- `packages/head/src/overlay.ts:33-140` applies each op to a view.
- `packages/session/src/validate.ts::touchedPaths` and the batch validator (`packages/session/src/validate.ts:294-403`).
- `apps/cli/src/session-exec.ts:4` and `apps/cli/src/replay.ts:1` import it for session execution and replay.

**Shape:**

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

**Assumptions consumers make:**

- `archive` and `move` touch both `path` and `to`; every other kind touches only `path`. `packages/session/src/validate.ts:178-187`
- `unlink` names a path the view already holds, or the overlay fails with `InvalidMemory`. `packages/head/src/overlay.ts:61-66`

**Drift risk:** `rel` is typed `string`, so an op with a rel outside `EdgeRel` type-checks and is refused only at run time. Mitigation: type `rel` as `EdgeRel`.

## Store config file, `memhtml.config.json`

**Producer:** `packages/contracts/src/store-config.ts:21-200` (`STORE_CONFIG_FILE`, the `StoreConfig` schema, resolved policies).

**Consumers:**

- `apps/cli/src/store-config.ts:47` and `:89` locate and decode the file.
- `packages/session/src/validate.ts:169-171` enforces the write bar.
- `packages/curator/src/inbox.ts:3` reads `DEFAULT_PLACEMENT_QUOTA`.

**Shape:**

```ts
export interface WriteBarPolicy {
  /** Each refused type with the reason its refusal gives. */
  readonly refusedTypes: ReadonlyMap<string, string>
  readonly requireAnchor: boolean
}
```

**Assumptions consumers make:**

- `refusedTypes` is keyed by the parsed `memhtml-type` value, and the map value is the refusal text shown to the writer. `packages/session/src/validate.ts:169-170`
- An absent file means library defaults. `apps/cli/src/store-config.ts:133`

## Slug and filename rules

**Producer:** `packages/contracts/src/slug.ts:8-151`.

**Consumers:**

- `packages/curator/src/inbox.ts:179`, `:313` and `:357` match folder names.
- `packages/store/src/store.ts:21` and `apps/cli/src/v2.ts:19` mint filenames.
- `packages/eval/src/corpus.ts:2`

**Shape:**

```ts
export const slugify = (title: string): string => {
  const kebab = kebabOf(title)
  if (kebab === "") return SLUG_FALLBACK

  return kebab.length <= SLUG_MAX_LENGTH
    ? kebab
    : kebab.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "") || SLUG_FALLBACK
}
```

**Assumptions consumers make:**

- The curator finds a tag's or entity's existing folder by recomputing `slugify` on every run, so the cut must never change. `packages/curator/src/inbox.ts:313`

**Drift risk:** any change to `slugify`'s cut splits an existing long workspace or tag into a second folder, as the producer's comment warns (`packages/contracts/src/slug.ts:57-60`). Mitigation: pin `slugify` outputs with fixture tests.

## Checkout lock

**Producer:** `packages/contracts/src/checkout-lock.ts:35-195`.

**Consumers:**

- `packages/store/src/checkout-lock.ts:19` and `:44`
- `packages/session/src/checkout-lock.ts:19` and `:41`
- `packages/session/src/commit.ts:633`

**Shape:**

```ts
export const CHECKOUT_LOCK_PATH = ".memhtml/checkout"
```

```ts
export const CHECKOUT_LOCKED = "checkout.locked"
```

**Assumptions consumers make:**

- Store and session lock the same target, `join(resolve(root), CHECKOUT_LOCK_PATH)`, so the two writers exclude each other. `packages/store/src/checkout-lock.ts:19`
- A lost wait surfaces as `StorageFailure` with `operation` `CHECKOUT_LOCKED`. `packages/session/src/commit.ts:633`

**Drift risk:** `checkoutLockTarget` is duplicated verbatim in store and session (`packages/session/src/checkout-lock.ts:19`), so a change to one copy lets the two writers take different locks. Mitigation: move `checkoutLockTarget` into contracts.

## Recall discipline text

**Producer:** `packages/contracts/src/guidance.ts:18-53`.

**Consumers:**

- `packages/integrations/src/render/block.ts:59`
- `packages/integrations/src/render/skill.ts:58`
- `apps/cli/src/commands.ts:2077`

**Shape:**

```ts
export const RECALL_DISCIPLINE: ReadonlyArray<string> = [
```

**Assumptions consumers make:**

- The integrations renderers emit one paragraph per array entry, separated by a blank line. `packages/integrations/src/render/block.ts:59`
- The CLI manifest guide topic uses the pre-joined `RECALL_DISCIPLINE_TEXT`. `apps/cli/src/commands.ts:2077`

## See also

- [impact analysis](impact-analysis.md): 23 shared source citations
- [business logic](business-logic.md): 18 shared source citations
- [dependency graph](../diagrams/structural/dependency-graph.md): 9 shared source citations
- [module map](../architecture/module-map.md): 7 shared source citations
- [state machines](../behavior/state-machines.md): 5 shared source citations
