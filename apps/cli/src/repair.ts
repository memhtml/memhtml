import type { EdgeRel } from "@memhtml/contracts/edges"
import type { StorageFailure } from "@memhtml/contracts/errors"
import { archivePathFor, normalizePath } from "@memhtml/contracts/paths"
import { addLink, addMeta, removeLink, setMeta } from "@memhtml/html"
import type { DatabaseShape } from "@memhtml/index"
import type { Effect } from "effect"

/**
 * The byte-level repair kit `memhtml doctor --fix` applies to a dangling `<link>`.
 *
 * **Every head edit goes through `setMeta`/`addLink`/`removeLink`.** They splice by source offset, so
 * the article's bytes provably do not move on a bookkeeping pass, and neither does the content hash or
 * the dedupe key. A parse-then-serialize round trip drops a `<pre>` newline per write, which would make
 * a link repair look like a content change in `git diff` and move the dedup key of a file nobody edited.
 */

/** The `<link href>` document-reference form of a git-tree path: repo-root-relative, leading slash. */
export const hrefFor = (path: string): string => `/${normalizePath(path)}`

/** One head edit: a meta to set or append, a link to add, or a link to drop. */
export type HeadEdit =
  | { readonly kind: "meta"; readonly name: string; readonly value: string }
  | { readonly kind: "addMeta"; readonly name: string; readonly value: string }
  | { readonly kind: "addLink"; readonly rel: EdgeRel; readonly href: string }
  | { readonly kind: "removeLink"; readonly rel: EdgeRel; readonly href?: string | undefined }

/** A meta edit, as a value. */
export const meta = (name: string, value: string): HeadEdit => ({ kind: "meta", name, value })

/** A link addition, as a value. */
export const link = (rel: EdgeRel, href: string): HeadEdit => ({ kind: "addLink", rel, href })

/** A link removal, as a value. Omitting `href` drops every link of that rel. */
export const unlink = (rel: EdgeRel, href?: string): HeadEdit =>
  href === undefined ? { kind: "removeLink", rel } : { kind: "removeLink", rel, href }

/** Apply head edits to bytes in order. Pure. */
export const applyHeadEdits = (html: string, edits: ReadonlyArray<HeadEdit>): string => {
  let out = html
  for (const edit of edits) {
    if (edit.kind === "meta") out = setMeta(out, edit.name, edit.value)
    else if (edit.kind === "addMeta") out = addMeta(out, edit.name, edit.value)
    else if (edit.kind === "addLink") out = addLink(out, edit.rel, edit.href)
    else out = removeLink(out, edit.rel, edit.href)
  }
  return out
}

/** How many year partitions back a dangling href is chased. Ten years of archive is the whole corpus. */
export const ARCHIVE_LOOKBACK_YEARS = 10

/**
 * The archive path a missing target now lives at, or `undefined` when it is genuinely gone.
 *
 * Years are tried newest-first from the given year back over {@link ARCHIVE_LOOKBACK_YEARS}, so the
 * most recent archiving of a path that was archived more than once wins. That is the one a live edge
 * means, since an earlier archiving was superseded by a later restore.
 */
export const archivedFormOf = (
  target: string,
  known: ReadonlySet<string>,
  runYear: number
): string | undefined => {
  for (let back = 0; back <= ARCHIVE_LOOKBACK_YEARS; back += 1) {
    const candidate = archivePathFor(target, runYear - back)
    if (known.has(candidate)) return candidate
  }
  return undefined
}

/** A `<link rel="memhtml-*">` whose target is not in the tree. The repair's input. */
export interface DanglingEdge {
  readonly src_path: string
  readonly rel: string
  readonly dst_path: string
}

/**
 * Authored edges pointing at a path the index does not hold.
 *
 * `derived = 0` only: a mined edge lives in the index and nowhere else, so a dangling one is
 * repaired by the next rebuild instead of by rewriting a file. This finds the ones that are in a
 * file, which are the ones a commit has to fix.
 */
export const danglingEdges = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<DanglingEdge>, StorageFailure> =>
  db.all<DanglingEdge>(
    `SELECT e.src_path AS src_path, e.rel AS rel, e.dst_path AS dst_path
     FROM edges e
     LEFT JOIN files f ON f.path = e.dst_path
     WHERE e.derived = 0 AND f.path IS NULL
     ORDER BY e.src_path ASC, e.rel ASC, e.dst_path ASC`
  )

/** Every indexed path, active or archived. The repair's target set. */
export const allPaths = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<{ readonly path: string }>, StorageFailure> =>
  db.all<{ path: string }>("SELECT path FROM files ORDER BY path ASC")
