import type { HeadView, OverlayOp } from "@memhtml/contracts"
import {
  ARCS_DIR,
  hrefToPath,
  isArchivePath,
  isEdgeRel,
  isWellFormedEntity,
  memoryPathViolation,
  normalizePath,
  originalPathFor,
  PEOPLE_DIR
} from "@memhtml/contracts"
import { checkMemory, contentHash, isRootRelativeHref, parseMemory, readLinks } from "@memhtml/html"
import { Effect, Exit } from "effect"

/**
 * The mechanical checks a commit runs before it writes anything. No model call, no I/O: every
 * check reads the head view and the ops, so a refusal costs nothing and leaves the tree untouched.
 */

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
   * A new record that fails the write bar ({@link writeBarReasons}): a run narrative, review output,
   * or a record that names nothing it is about. Every scope and every type is judged; only an
   * archive destination is not, because it is an existing record moving. An `unlabel` that leaves
   * its record with no entity and no workspace path fails the same anchor rule.
   */
  | { readonly kind: "write-bar"; readonly path: string; readonly reasons: ReadonlyArray<string> }

/** The most ops one commit carries. A larger batch is two sessions. */
export const BATCH_CAP = 200

/**
 * Who is writing. `session` is an ordinary session on `main`; `curate` is a run of the curator
 * (`@memhtml/curator`) on its own `curate/<date>` branch. The scope names the commit subject
 * (`memhtml(<scope>): ...`) and widens what the validator lets through: the arcs and people
 * prefixes are the curator's to write and nobody else's.
 */
export type CommitScope = "session" | "curate"

/** The options `validateOps` and `isReservedPath` take. `scope` defaults to `session`. */
export interface ValidateOptions {
  readonly scope?: CommitScope | undefined
}

/** Directory prefixes only curation writes: refused under `session`, writable under `curate`. */
const CURATION_PREFIXES: ReadonlyArray<string> = [`${ARCS_DIR}/`, `${PEOPLE_DIR}/`]

/** The store's own state, which no scope writes through a session. */
const STORE_PREFIXES: ReadonlyArray<string> = [".memhtml/"]

/** Filenames the site generator owns at any depth; no scope writes them. */
const RESERVED_FILENAMES: ReadonlyArray<string> = ["index.html", "sitemap.xml"]

/** True when a writer under `scope` may not write the path. */
export const isReservedPath = (path: string, scope: CommitScope = "session"): boolean => {
  const normalized = normalizePath(path)
  if (STORE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  if (scope !== "curate" && CURATION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true
  }
  const slash = normalized.lastIndexOf("/")
  const filename = slash === -1 ? normalized : normalized.slice(slash + 1)
  return RESERVED_FILENAMES.includes(filename)
}

/** The prefix a workspace's records sit under (`projects/<slug>/`), which anchors a record by itself. */
const WORKSPACE_PREFIX = "projects/"

/**
 * Types no session may write, the curator's included, each with the reason it gives. A run
 * narrative belongs in the trace index, which already holds every run; review output was never
 * memory. On 2026-09-24 the audit of the live store found these two classes, with unanchored
 * lessons, made up most of the noise that three writers with no bar had left.
 */
const REFUSED_TYPES: ReadonlyMap<string, string> = new Map([
  [
    "episodic",
    "an episodic record narrates one run; runs belong in the trace index, not the store"
  ],
  ["verdict", "a verdict is review output, not a memory"]
])

/**
 * The reason a record that names nothing gives, worded so the writer (a person, an agent, or the
 * curator's model reading a refused proposal) knows exactly what to add.
 */
export const UNANCHORED_REASON =
  'names no system, project, or person: add at least one memhtml-entity (<meta name="memhtml-entity" content="system:<name>"> in the head, an entities value in a write op, or a label op) or write it in a workspace (projects/<slug>/)'

/** True when a record's entities or its path say what it is about: the write bar's anchor rule. */
const isAnchored = (path: string, entities: Iterable<string>): boolean =>
  [...entities].some((entity) => entity.trim() !== "") ||
  normalizePath(path).startsWith(WORKSPACE_PREFIX)

/**
 * Why a new record falls below the write bar, or nothing when it clears it.
 *
 * The bar has two halves. This is the mechanical one: the record is not a run narrative or review
 * output, and it names what it is about, through at least one `memhtml-entity` or by sitting in a
 * workspace under `projects/<slug>/`. The other half (a mechanism or a decision, something a future
 * run would look up) needs a model's judgment and is the writing agent's, stated in the `session put`
 * and `session exec` help and, for the curator, in its two charters.
 *
 * The bar holds under every scope and for every type. The curator was exempt until 2026-09-26, and
 * the one-time collapse it ran left 491 of 706 active non-task records with no label, so its
 * canonicals and arcs now clear the same anchor rule. A task is still a type any session may write,
 * and it too must be anchored: a task under `projects/<slug>/tasks/` is anchored by its path, one in
 * the inbox needs an entity. An archive destination is an existing record moving, never a new one,
 * and is not judged. A file that does not parse answers nothing here, because the format check has
 * already refused it.
 */
export const writeBarReasons = (path: string, html: string): ReadonlyArray<string> => {
  if (isArchivePath(path)) return []
  const parsed = Effect.runSyncExit(parseMemory(html))
  if (!Exit.isSuccess(parsed)) return []
  const doc = parsed.value
  const reasons: Array<string> = []
  const refused = REFUSED_TYPES.get(doc.metas.memoryType)
  if (refused !== undefined) reasons.push(refused)
  if (!isAnchored(path, doc.entities)) reasons.push(UNANCHORED_REASON)
  return reasons
}

/** Every path an op reads or writes, for the disjointness check and the reserved-path check. */
export const touchedPaths = (op: OverlayOp): ReadonlyArray<string> => {
  switch (op.kind) {
    case "put":
      return [op.path]
    case "archive":
      return [op.path, op.to]
    case "link":
    case "unlink":
    case "label":
    case "unlabel":
      return [op.path]
  }
}

/** The `memhtml-entity` values of a file that parses, as authored; none for one that does not. */
const entitiesIn = (html: string): ReadonlyArray<string> => {
  const parsed = Effect.runSyncExit(parseMemory(html))
  return Exit.isSuccess(parsed) ? parsed.value.entities : []
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
  ops: ReadonlyArray<OverlayOp>,
  options: ValidateOptions = {}
): ReadonlyArray<Violation> => {
  const scope = options.scope ?? "session"
  if (ops.length > BATCH_CAP) return [{ kind: "batch-cap", count: ops.length, cap: BATCH_CAP }]

  const violations: Array<Violation> = []
  /** Content hashes this batch introduces, so two puts of one claim in one session collide too. */
  const batchHashes = new Map<string, string>()
  /** Paths this batch puts with their content hash, so a later `link` or `archive` can name them. */
  const batchPuts = new Map<string, string>()
  /**
   * The edges each path carries as the batch has left it so far: the head's (or the put's) links,
   * plus every `link` this batch added and minus every `unlink` it dropped. An `unlink` is judged
   * against this, so a batch may drop an edge it added earlier and may not drop one twice.
   */
  const batchEdges = new Map<string, Set<string>>()
  const edgeKey = (rel: string, href: string): string => `${rel} -> ${href}`
  const edgesOf = (path: string): Set<string> => {
    const known = batchEdges.get(path)
    if (known !== undefined) return known
    const record = view.get(path)
    const fresh = new Set(record?.links.map((link) => edgeKey(link.rel, link.href)) ?? [])
    batchEdges.set(path, fresh)
    return fresh
  }
  /**
   * The entities each path carries as the batch has left it so far, kept the way `batchEdges` keeps
   * edges: the head's (or the put's) values, plus every `label` and minus every `unlabel`. A `label`
   * of a value already there and an `unlabel` of one that is not are judged against this.
   */
  const batchEntities = new Map<string, Set<string>>()
  const entitiesOf = (path: string): Set<string> => {
    const known = batchEntities.get(path)
    if (known !== undefined) return known
    const fresh = new Set(view.get(path)?.entities ?? [])
    batchEntities.set(path, fresh)
    return fresh
  }
  /** Paths an `unlabel` touched, judged against the anchor rule once the whole batch is walked. */
  const unlabeled = new Set<string>()
  /** Sources this batch archives: the record moves, and an archive destination is not judged. */
  const archived = new Set<string>()
  /**
   * Every path this batch creates, puts and archive destinations alike, gathered before the walk so
   * a link may name a target its batch creates later in the order. The harvester emits links before
   * archives, so the archive a `supersedes` edge points at comes after the edge.
   */
  const batchCreates = new Set<string>(
    ops.flatMap((op) =>
      op.kind === "put"
        ? [normalizePath(op.path)]
        : op.kind === "archive"
          ? [normalizePath(op.to)]
          : []
    )
  )

  for (const op of ops) {
    for (const path of touchedPaths(op)) {
      if (isReservedPath(path, scope)) violations.push({ kind: "reserved-path", path })
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
        const bar = writeBarReasons(op.path, op.html)
        if (bar.length > 0) violations.push({ kind: "write-bar", path: op.path, reasons: bar })
        batchHashes.set(hash, op.path)
        batchPuts.set(op.path, hash)
        batchEdges.set(
          op.path,
          new Set(readLinks(op.html).map((link) => edgeKey(link.rel, link.href)))
        )
        batchEntities.set(op.path, new Set(entitiesIn(op.html)))
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
        archived.add(normalizePath(op.path))
        break
      }
      case "link": {
        const reasons: Array<string> = []
        if (!isActiveIn(view, op.path) && !batchPuts.has(op.path)) {
          reasons.push("link source is not an active record in the head")
        }
        if (!isEdgeRel(op.rel)) reasons.push(`rel \`${op.rel}\` is outside the edge vocabulary`)
        if (!isRootRelativeHref(op.href)) {
          reasons.push("href is not root-relative")
        } else {
          // The target must be a record: active or archived in the head (a `supersedes` edge points
          // at an archive by design, and a repaired dangling link points at the archived form), or
          // one this batch puts or archives. The first live run minted 23 links in two minutes; a
          // dangling one would have landed unnoticed.
          const target = normalizePath(hrefToPath(op.href))
          if (view.get(target) === undefined && !batchCreates.has(target)) {
            reasons.push("link target is not a record in the head or this batch")
          }
        }
        if (reasons.length > 0) violations.push({ kind: "format", path: op.path, reasons })
        else edgesOf(op.path).add(edgeKey(op.rel, op.href))
        break
      }
      case "unlink": {
        const reasons: Array<string> = []
        if (!isActiveIn(view, op.path) && !batchPuts.has(op.path)) {
          reasons.push("unlink source is not an active record in the head")
        }
        if (!isEdgeRel(op.rel)) reasons.push(`rel \`${op.rel}\` is outside the edge vocabulary`)
        // The edge must be on the file as the batch sees it: dropping an edge that is not there is
        // a stale op, and letting it through would commit a no-op the log describes as a change.
        if (reasons.length === 0 && !edgesOf(op.path).has(edgeKey(op.rel, op.href))) {
          reasons.push("unlink names an edge the source does not carry")
        }
        if (reasons.length > 0) violations.push({ kind: "format", path: op.path, reasons })
        else edgesOf(op.path).delete(edgeKey(op.rel, op.href))
        break
      }
      case "label": {
        const reasons: Array<string> = []
        if (!isActiveIn(view, op.path) && !batchPuts.has(op.path)) {
          reasons.push("label source is not an active record in the head")
        }
        // A new label is written in the one spelling every entity index can meet: `type:name`,
        // already normalized, so `Service:MemHTML` cannot open a second key beside `service:memhtml`.
        if (!isWellFormedEntity(op.entity)) {
          reasons.push(
            `entity \`${op.entity}\` is not a normalized type:name value (lowercase, e.g. system:memhtml)`
          )
        }
        // The value must not be there already: `addMeta` would write nothing, and the log would
        // describe a change the commit never makes.
        if (reasons.length === 0 && entitiesOf(op.path).has(op.entity)) {
          reasons.push("label names an entity the source already carries")
        }
        if (reasons.length > 0) violations.push({ kind: "format", path: op.path, reasons })
        else entitiesOf(op.path).add(op.entity)
        break
      }
      case "unlabel": {
        const reasons: Array<string> = []
        if (!isActiveIn(view, op.path) && !batchPuts.has(op.path)) {
          reasons.push("unlabel source is not an active record in the head")
        }
        // Matched as authored, not normalized: an unlabel takes off a value the file carries, a
        // legacy spelling included, which is how a malformed label is repaired.
        if (reasons.length === 0 && !entitiesOf(op.path).has(op.entity)) {
          reasons.push("unlabel names an entity the source does not carry")
        }
        if (reasons.length > 0) violations.push({ kind: "format", path: op.path, reasons })
        else {
          entitiesOf(op.path).delete(op.entity)
          unlabeled.add(op.path)
        }
        break
      }
    }
  }
  // The anchor rule over every record an `unlabel` edited, as the whole batch left it, so a batch
  // that swaps one label for another passes in either order and one that drops the last fails. A
  // record the batch archives is exempt: the archived copy is a destination, never judged.
  for (const path of unlabeled) {
    if (archived.has(normalizePath(path))) continue
    if (!isAnchored(path, entitiesOf(path))) {
      violations.push({ kind: "write-bar", path, reasons: [UNANCHORED_REASON] })
    }
  }
  return violations
}
