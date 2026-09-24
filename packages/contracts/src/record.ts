/**
 * The v2 record plane: what one memory file becomes once parsed, and the read-only view of a
 * corpus version that every v2 package codes against.
 *
 * `MemoryRecord` is a flat projection of one file. It carries the raw `html` so a version of the
 * corpus can be materialized into a sandbox or a snapshot without going back to git, and it carries
 * every field the indexes derive so an index rebuild never re-parses. `HeadView` is the read
 * surface of one immutable version: the head process implements it over a persistent map, a
 * session implements it over head-plus-overlay, and a test implements it over a plain `Map`.
 *
 * Paths are repo-relative with no leading slash (`areas/inbox/x.html`). Link hrefs keep the file
 * format's root-relative form (`/areas/inbox/x.html`); `hrefToPath` and `pathToHref` convert.
 */

export interface RecordLink {
  readonly rel: string
  readonly href: string
}

export interface RecordFacet {
  readonly name: string
  readonly value: string
}

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

/** One immutable version of the corpus, read-only. */
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

/**
 * One entry in a session's overlay log. A session never edits an active claim in place: a changed
 * claim is a `put` of a new file plus an `archive` of the old one, linked by a supersedes edge.
 * `link` and `unlink` are the two head-only edits: each names one `(rel, href)` edge on one file,
 * and neither touches the article, so the record's content hash survives both.
 */
export type OverlayOp =
  | { readonly kind: "put"; readonly path: string; readonly html: string }
  | { readonly kind: "archive"; readonly path: string; readonly to: string; readonly html: string }
  | { readonly kind: "link"; readonly path: string; readonly rel: string; readonly href: string }
  | { readonly kind: "unlink"; readonly path: string; readonly rel: string; readonly href: string }

export const hrefToPath = (href: string): string => (href.startsWith("/") ? href.slice(1) : href)

export const pathToHref = (path: string): string => (path.startsWith("/") ? path : `/${path}`)
