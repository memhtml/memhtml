import type { HeadView, OverlayOp } from "@memhtml/contracts"
import {
  ARCS_DIR,
  isEdgeRel,
  memoryPathViolation,
  normalizePath,
  originalPathFor,
  PEOPLE_DIR
} from "@memhtml/contracts"
import { checkMemory, contentHash, isRootRelativeHref } from "@memhtml/html"

/**
 * The mechanical checks a commit runs before it writes anything. No model call, no I/O: every
 * check reads the head view and the ops, so a refusal costs nothing and leaves the tree untouched.
 */

export type Violation =
  | { readonly kind: "format"; readonly path: string; readonly reasons: ReadonlyArray<string> }
  | { readonly kind: "duplicate"; readonly path: string; readonly existing: string }
  /** A put over an active path with a different content hash. Claims are never edited in place. */
  | { readonly kind: "claim-edit"; readonly path: string }
  /** `areas/arcs/`, `resources/people/`, `.memhtml/`, `index.html`, `sitemap.xml`. */
  | { readonly kind: "reserved-path"; readonly path: string }
  | { readonly kind: "batch-cap"; readonly count: number; readonly cap: number }

/** The most ops one commit carries. A larger batch is two sessions. */
export const BATCH_CAP = 200

/** Directory prefixes only curation writes. */
const RESERVED_PREFIXES: ReadonlyArray<string> = [`${ARCS_DIR}/`, `${PEOPLE_DIR}/`, ".memhtml/"]

/** Filenames the site generator owns at any depth. */
const RESERVED_FILENAMES: ReadonlyArray<string> = ["index.html", "sitemap.xml"]

/** True when a session may not write the path. */
export const isReservedPath = (path: string): boolean => {
  const normalized = normalizePath(path)
  if (RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  const slash = normalized.lastIndexOf("/")
  const filename = slash === -1 ? normalized : normalized.slice(slash + 1)
  return RESERVED_FILENAMES.includes(filename)
}

/** Every path an op reads or writes, for the disjointness check and the reserved-path check. */
export const touchedPaths = (op: OverlayOp): ReadonlyArray<string> => {
  switch (op.kind) {
    case "put":
      return [op.path]
    case "archive":
      return [op.path, op.to]
    case "link":
      return [op.path]
  }
}

/** True when the view holds the path as a live (non-archived) record. */
const isActiveIn = (view: HeadView, path: string): boolean => {
  const record = view.get(path)
  return record !== undefined && !record.archived
}

/** The content hash of the live record at `path`, or undefined when there is none. */
const activeHashIn = (view: HeadView, path: string): string | undefined => {
  const record = view.get(path)
  return record !== undefined && !record.archived ? record.contentHash : undefined
}

export const validateOps = (
  view: HeadView,
  ops: ReadonlyArray<OverlayOp>
): ReadonlyArray<Violation> => {
  if (ops.length > BATCH_CAP) return [{ kind: "batch-cap", count: ops.length, cap: BATCH_CAP }]

  const violations: Array<Violation> = []
  /** Content hashes this batch introduces, so two puts of one claim in one session collide too. */
  const batchHashes = new Map<string, string>()
  /** Paths this batch puts with their content hash, so a later `link` or `archive` can name them. */
  const batchPuts = new Map<string, string>()

  for (const op of ops) {
    for (const path of touchedPaths(op)) {
      if (isReservedPath(path)) violations.push({ kind: "reserved-path", path })
    }

    switch (op.kind) {
      case "put": {
        const reasons: Array<string> = []
        const pathReason = memoryPathViolation(op.path)
        if (pathReason !== undefined) reasons.push(`path: ${pathReason}`)
        reasons.push(...checkMemory(op.html).violations)
        if (reasons.length > 0) {
          violations.push({ kind: "format", path: op.path, reasons })
          break
        }
        const hash = contentHash(op.html)
        const existing = view.byContentHash(hash) ?? batchHashes.get(hash)
        if (existing !== undefined) {
          violations.push({ kind: "duplicate", path: op.path, existing })
        } else if (isActiveIn(view, op.path)) {
          violations.push({ kind: "claim-edit", path: op.path })
        }
        batchHashes.set(hash, op.path)
        batchPuts.set(op.path, hash)
        break
      }
      case "archive": {
        const reasons: Array<string> = []
        const sourceHash = batchPuts.get(op.path) ?? activeHashIn(view, op.path)
        if (sourceHash === undefined) {
          reasons.push("archive source is not an active record in the head")
        }
        if (originalPathFor(op.to) !== normalizePath(op.path)) {
          reasons.push("archive destination is not archive/<YYYY>/<original path>")
        }
        if (view.get(op.to) !== undefined) reasons.push("archive destination already exists")
        const format = checkMemory(op.html).violations
        reasons.push(...format)
        // `op.html` names which article is meant; the bytes written come from the head (or an
        // earlier op in the batch), so its article must be the source's. A head-only link the
        // source gained since the op was minted leaves the hash equal and is carried by the copy.
        if (
          format.length === 0 &&
          sourceHash !== undefined &&
          contentHash(op.html) !== sourceHash
        ) {
          reasons.push("archive op's article differs from the source record's")
        }
        if (reasons.length > 0) violations.push({ kind: "format", path: op.path, reasons })
        break
      }
      case "link": {
        const reasons: Array<string> = []
        if (!isActiveIn(view, op.path) && !batchPuts.has(op.path)) {
          reasons.push("link source is not an active record in the head")
        }
        if (!isEdgeRel(op.rel)) reasons.push(`rel \`${op.rel}\` is outside the edge vocabulary`)
        if (!isRootRelativeHref(op.href)) reasons.push("href is not root-relative")
        if (reasons.length > 0) violations.push({ kind: "format", path: op.path, reasons })
        break
      }
    }
  }
  return violations
}
