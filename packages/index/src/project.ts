import { relClassFor } from "@memhtml/contracts/edges"
import { normalizePath, paraBucketOf } from "@memhtml/contracts/paths"
import { parseEntity } from "@memhtml/contracts/types"
import { frameKeyOf } from "@memhtml/domain"
import type { MemoryDoc } from "@memhtml/html"

import { type Chunk, chunkText } from "./chunking.js"
import type { SqlValue, Write } from "./database.js"

/**
 * A parsed `MemoryDoc` projected onto rows. Pure, so given a doc, a path, and a blob sha, the row set
 * is fully determined. That is what makes a full rebuild and the incremental path produce the same
 * rows, the contract the reproducibility test asserts.
 */

/** Everything one file contributes to the index. */
export interface FileProjection {
  readonly path: string
  readonly contentHash: string
  readonly chunks: ReadonlyArray<Chunk>
  readonly writes: ReadonlyArray<Write>
}

/** The `workspace` a path implies. The directory under `projects/`, or `null` outside that bucket. */
export const workspaceOf = (path: string): string | null => {
  const normalized = normalizePath(path)
  if (!normalized.startsWith("projects/")) return null
  const rest = normalized.slice("projects/".length)
  const at = rest.indexOf("/")
  return at <= 0 ? null : rest.slice(0, at)
}

/**
 * Words in the article text. Whitespace-delimited runs, which is the same tokenization the FTS index
 * and the embedder both apply, so this number describes what they index rather than the raw markup.
 */
export const wordCountOf = (bodyText: string): number =>
  bodyText.trim() === "" ? 0 : bodyText.trim().split(/\s+/).length

/**
 * The single FTS column, holding title, gist, and body joined by newlines.
 *
 * Denormalized because a multi-column FTS index on this driver returns rowid order rather than
 * relevance order and scopes MATCH to the named column alone (probed 2026-08-02). Newline-joined
 * rather than space-joined so a term at the end of the title cannot fuse with one at the start of
 * the gist into a phrase neither states.
 */
export const ftsTextFor = (doc: MemoryDoc): string =>
  [doc.title, doc.article.gist, doc.article.bodyText].filter((part) => part !== "").join("\n")

/**
 * The recall disclosure body, meaning what `memory_recall` may QUOTE rather than what it may search.
 *
 * `body_text` is the search surface and includes everything. Disclosure is narrower, and each of the
 * two exclusions has a reason:
 *
 * - **`<details>` bodies never appear.** That is Tier 3, the "how this was learned" provenance, and
 *   it reaches an agent only through `memory_read`. Spending a shared character budget on one
 *   memory's backstory starves the claims of memories the agent has not seen at all.
 * - **`<aside>` texts never appear.** An aside is a scope caveat. A disclosure line has no room to
 *   say "this is the exception", so quoting one presents the exception as the rule.
 *
 * Composed from the doc's separated extraction fields rather than by re-deriving them from the
 * markup. `@memhtml/html` reports `summaryTexts`, `facets`, and `citations` apart from `bodyText`
 * so a consumer can build a narrower view without a second parser. A second parser
 * here would be a consumer reimplementing producer semantics, which is the mistake the fleet has
 * paid for repeatedly.
 *
 * The composition is claim-first and structured: the `<mark>` claim, then each `<summary>` headline,
 * then the `<dl>` facets as `name: value`, then the citations. That is the memory's substance in the
 * form the format already gives it, and every part of it sits outside a `<details>` body and
 * outside an `<aside>`.
 */
export const disclosureTextFor = (doc: MemoryDoc): string =>
  [
    doc.article.gist,
    ...doc.article.summaryTexts,
    ...doc.article.facets.map((facet) => `${facet.name}: ${facet.value}`),
    ...doc.article.citations.map((citation) => citation.text)
  ]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n")

/** A boolean-ish meta as the 0/1 SQL integer. */
const flag = (value: boolean | undefined): number => (value === true ? 1 : 0)

/**
 * The `files` columns in bind order. One list drives the insert, the placeholder count, and the
 * upsert's assignment clause, so a new column cannot be added to one and forgotten in another.
 * A mismatch there binds every subsequent value to the wrong column and every CHECK still passes.
 */
export const FILE_COLUMNS = [
  "path",
  "blob_sha",
  "content_hash",
  "memory_type",
  "title",
  "body_text",
  "gist",
  "fts_text",
  "disclosure_text",
  "para",
  "workspace",
  "confidence",
  "importance",
  "archived",
  "origin_path",
  "word_count",
  "created_at",
  "updated_at",
  "event_at",
  "archived_at",
  "valid_from",
  "valid_until",
  "reprieves",
  "needs_revision",
  "author",
  "session_id",
  "prompt_id",
  "turn_uuid",
  "indexed_at",
  "task_status",
  "due_at",
  /**
   * The claim's slot, from `@memhtml/domain`'s `frameKeyOf` over the gist. NULL on most rows, because
   * the heuristic's guards fail closed, and `files_frame_key_active` (0009) indexes only the non-NULL
   * active non-task ones.
   */
  "frame_key"
] as const

/**
 * Project one file onto its complete row set.
 *
 * `archived` is read from the path's PARA bucket, not from `memhtml-status`. The path is the state,
 * because eviction IS the `git mv` into `archive/<YYYY>/`. A file whose head says `active` while
 * sitting under `archive/` is stale metadata and the tree is right. Trusting the meta instead would
 * let a mis-stamped file re-enter retrieval and break the partial unique index's dedup guarantee.
 */
export const projectFile = (input: {
  readonly path: string
  readonly blobSha: string
  readonly contentHash: string
  readonly doc: MemoryDoc
  readonly indexedAt: string
}): FileProjection => {
  const path = normalizePath(input.path)
  const { doc } = input
  const para = paraBucketOf(path) ?? "areas"
  const archived = para === "archive"
  const chunks = chunkText(doc.article.bodyText, input.contentHash)

  const fileRow: ReadonlyArray<SqlValue> = [
    path,
    input.blobSha,
    input.contentHash,
    doc.metas.memoryType,
    doc.title,
    doc.article.bodyText,
    doc.article.gist,
    ftsTextFor(doc),
    disclosureTextFor(doc),
    para,
    workspaceOf(path),
    doc.metas.confidence ?? 1.0,
    doc.metas.importance ?? 5,
    archived ? 1 : 0,
    archived ? originOf(path) : null,
    wordCountOf(doc.article.bodyText),
    doc.metas.createdAt,
    doc.metas.updatedAt,
    doc.article.eventAt ?? null,
    doc.metas.archivedAt ?? null,
    doc.metas.validFrom ?? null,
    doc.metas.validUntil ?? null,
    doc.metas.reprieves ?? 0,
    flag(doc.metas.needsRevision),
    doc.metas.author ?? "agent",
    doc.metas.sessionId ?? null,
    doc.metas.promptId ?? null,
    doc.metas.turnUuid ?? null,
    input.indexedAt,
    /**
     * Both read straight off the parsed metas, and both NULL on a non-task. `@memhtml/html` rejects a
     * `memhtml-task-status` on any other type, so a non-null value here would mean the parser let a
     * file through that it does not accept.
     */
    doc.metas.taskStatus ?? null,
    doc.metas.dueAt ?? null,
    /**
     * Derived from the GIST, which is the `<mark>` claim, rather than from `body_text` or from
     * `fts_text`. The gist is the one sentence the memory asserts, so it is the only field a
     * frame+value rule can read without keying on a supporting paragraph that happens to contain a
     * linking token. Feeding it the body would make the key depend on prose the claim does not make.
     *
     * `frameKeyOf` is pure lexical, with no clock, no random, and no model, so a rebuild recomputes
     * the same key from the same file by construction, keeping a rebuilt index byte-identical here.
     * NULL is the common case and means "no frame shape", never "not computed".
     */
    frameKeyOf(doc.article.gist)
  ]

  /**
   * An upsert, not an insert, so one statement serves both paths. A rebuild writes into an emptied
   * table where nothing conflicts, and an incremental pass rewrites a row in place. Rewriting in
   * place is what preserves the row's `chunks`. Deleting and re-inserting the `files` row would
   * cascade the chunks away and take their embeddings with them, which is exactly the cost the
   * content-hash keying exists to avoid.
   *
   * The conflict target is `path`, the primary key. A `content_hash` collision against a DIFFERENT
   * active path is deliberately NOT absorbed. That is the structural dedup, and the partial unique
   * index rejecting it is the guarantee.
   */
  const writes: Array<Write> = [
    /**
     * Clear the multi-row children first, which makes the projection idempotent. Applying it twice,
     * or applying it over a stale version of the same path, leaves exactly the rows the doc states.
     * The `files` row itself is never deleted. See the upsert below.
     */
    { sql: "DELETE FROM file_tags WHERE path = ?", params: [path] },
    { sql: "DELETE FROM file_entities WHERE path = ?", params: [path] },
    { sql: "DELETE FROM file_facets WHERE path = ?", params: [path] },
    { sql: "DELETE FROM file_citations WHERE path = ?", params: [path] },
    /**
     * Only the chunks whose body is no longer this file's. A chunk row's id derives from
     * `content_hash`, so an unchanged body keeps its ids and its embeddings. A changed body's old
     * chunks describe text that no longer exists, and their vectors go with them by cascade. A
     * blanket `DELETE FROM chunks WHERE path = ?` would re-embed the whole file on any meta-only
     * edit, which is what the hash's invariance under head edits exists to prevent.
     */
    {
      sql: "DELETE FROM chunks WHERE path = ? AND content_hash <> ?",
      params: [path, input.contentHash]
    },
    /**
     * The file's own authored edges. Deleted by `src_path` only, because an INBOUND edge is another
     * file's assertion, and dropping it because this file was re-indexed would silently rewrite
     * someone else's document. The integrity phase repairs dangling hrefs deliberately, in a commit.
     */
    { sql: "DELETE FROM edges WHERE src_path = ? AND derived = 0", params: [path] },
    {
      sql: `INSERT INTO files (
        ${FILE_COLUMNS.join(", ")}
      ) VALUES (${fileRow.map(() => "?").join(", ")})
      ON CONFLICT(path) DO UPDATE SET ${FILE_COLUMNS.filter((column) => column !== "path")
        .map((column) => `${column} = excluded.${column}`)
        .join(", ")}`,
      params: fileRow
    }
  ]

  for (const tag of dedupe(doc.tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))) {
    writes.push({ sql: "INSERT INTO file_tags (path, tag) VALUES (?, ?)", params: [path, tag] })
  }

  for (const entity of entityRowsFor(doc)) {
    writes.push({
      sql: "INSERT INTO file_entities (path, entity_type, entity_name) VALUES (?, ?, ?)",
      params: [path, entity.entityType, entity.entityName]
    })
  }

  for (const chunk of chunks) {
    /**
     * `ON CONFLICT(chunk_id)` re-points an existing chunk at this path, and THAT is the whole
     * rename handler. `chunk_id` is content-derived and path-independent, so a `git mv` finds its
     * chunk row already present, updates one column, and keeps the embedding hanging off it. Zero
     * Bedrock calls for an archive move, without a rename-specific code path.
     */
    writes.push({
      sql: `INSERT INTO chunks (chunk_id, path, content_hash, ordinal, text, char_count)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(chunk_id) DO UPDATE SET path = excluded.path, ordinal = excluded.ordinal,
              text = excluded.text, char_count = excluded.char_count`,
      params: [chunk.chunkId, path, input.contentHash, chunk.ordinal, chunk.text, chunk.charCount]
    })
  }

  for (const facet of dedupeBy(doc.article.facets, (facet) => `${facet.name} ${facet.value}`)) {
    writes.push({
      sql: "INSERT INTO file_facets (path, name, value, numeric_value) VALUES (?, ?, ?, ?)",
      params: [path, facet.name, facet.value, facet.numericValue ?? null]
    })
  }

  for (const citation of dedupeBy(doc.article.citations, (citation) => citation.text)) {
    writes.push({
      sql: "INSERT INTO file_citations (path, text, href) VALUES (?, ?, ?)",
      params: [path, citation.text, citation.href ?? null]
    })
  }

  for (const link of authoredEdgesFor(doc, path, input.contentHash, input.indexedAt)) {
    writes.push(link)
  }

  return { path, contentHash: input.contentHash, chunks, writes }
}

/**
 * The entity rows a doc claims. Its `memhtml-entity` metas, one `concept:<term>` row per `<dfn>`, and
 * one `lang:<value>` row per `<code data-lang>`.
 *
 * Promoting defined terms is what makes a semantic memory that DEFINES a term findable by that term
 * without the author also writing a `memhtml-entity` meta. The `<dfn>` already said it, and asking for
 * it twice is how the two drift apart. `data-lang` promotes on the same reasoning. The fence info
 * string already named the language, so `memhtml list --entity lang:ts` finds every memory carrying
 * TypeScript with no new query machinery and no restatement.
 *
 * An entity with no `type:` separator is stored under the `unknown` type rather than dropped. The
 * name is still a real handle a query can use, and dropping it would silently lose a hand-authored
 * file's only entity.
 *
 * Names are stored AS AUTHORED, deliberately. `entity-resolution` rewrites a file's `memhtml-entity`
 * meta to its normalized form and finds that work by reading these rows back — so a projection that
 * normalized here would hide every unnormalized meta from the one pass whose job is to fix it, and
 * the phase would report `namesNormalized: 0` over a corpus full of them. Casing is folded at COMPARE
 * time instead (`assembleScope`, `listMemories`), where it costs a query nothing and blinds nobody.
 */
export const entityRowsFor = (
  doc: MemoryDoc
): ReadonlyArray<{ readonly entityType: string; readonly entityName: string }> => {
  const rows = doc.entities.flatMap((entity) => {
    const trimmed = entity.trim()
    if (trimmed === "") return []
    const parsed = parseEntity(trimmed)
    return [parsed ?? { entityType: "unknown", entityName: trimmed }]
  })

  const concepts = doc.article.definedTerms
    .map((term) => term.trim())
    .filter((term) => term !== "")
    .map((term) => ({ entityType: "concept", entityName: term }))

  const langs = doc.article.codeLangs.map((lang) => ({ entityType: "lang", entityName: lang }))

  return dedupeBy([...rows, ...concepts, ...langs], (row) => `${row.entityType} ${row.entityName}`)
}

/**
 * Authored edges from the head's `<link rel="memhtml-*">` elements.
 *
 * `href` is the document-reference form, repo-root-relative WITH a leading slash, and the `edges`
 * table stores the git-tree form, so `normalizePath` strips it. Storing the slashed form would make
 * every edge's `dst_path` fail to join `files.path`, and the join returning nothing looks exactly
 * like a corpus with no edges.
 *
 * A self-loop is dropped rather than inserted. The table's CHECK would reject the whole batch, and
 * one hand-authored file pointing at itself must not fail the indexing of every file beside it.
 */
export const authoredEdgesFor = (
  doc: MemoryDoc,
  path: string,
  contentHash: string,
  createdAt: string
): ReadonlyArray<Write> =>
  dedupeBy(
    doc.links.flatMap((link) => {
      const dstPath = normalizePath(link.href)
      if (dstPath === "" || dstPath === path) return []
      return [{ rel: link.rel, dstPath }]
    }),
    (edge) => `${edge.rel} ${edge.dstPath}`
  ).map((edge) => ({
    sql: `INSERT INTO edges (src_path, rel, dst_path, edge_class, derived, strength, provenance, src_hash, created_at)
          VALUES (?, ?, ?, ?, 0, 1.0, 'authored', ?, ?)`,
    params: [path, edge.rel, edge.dstPath, relClassFor(edge.rel), contentHash, createdAt]
  }))

/** The pre-archive path an archived file came from, for `files.origin_path`. */
const originOf = (archivePath: string): string | null => {
  const match = /^archive\/\d{4,}\/(.+)$/.exec(archivePath)
  return match?.[1] ?? null
}

const dedupe = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

/**
 * First occurrence per key, order-preserving.
 *
 * Deduplication happens HERE rather than being left to the database because these rows go in through
 * `writeAll`, which is one atomic batch. A duplicate `(path, name, value)` facet would fail the
 * primary key and roll back every other row in the batch, so one file with a repeated `<dt>`/`<dd>`
 * pair would take the whole rebuild down.
 */
const dedupeBy = <A>(values: ReadonlyArray<A>, key: (value: A) => string): ReadonlyArray<A> => {
  const seen = new Set<string>()
  const out: Array<A> = []
  for (const value of values) {
    const id = key(value)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(value)
  }
  return out
}
