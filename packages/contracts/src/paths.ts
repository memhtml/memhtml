import { filenameFor, slugify } from "./slug.js"
import { PARA_BUCKETS, type ParaBucket } from "./types.js"

/**
 * Path algebra. Every function here is pure and total, and a path is always the
 * repo-root-relative git-tree form: no leading slash, forward slashes only.
 */

/** Behavioral arcs. Under `areas/` because PARA is fixed at four buckets. */
export const ARCS_DIR = "areas/arcs"

/** The person plane, folded into `resources/` rather than given its own bucket. */
export const PEOPLE_DIR = "resources/people"

/**
 * Where a memory lands when no rule claims it. `memhtml doctor` reports inbox depth as a
 * health signal, so an unplaceable memory is visible rather than lost.
 */
export const INBOX_DIR = "areas/inbox"

/**
 * The directory segment every task file sits under, appended to its workspace's project
 * directory or to the inbox.
 *
 * A subdirectory rather than a fifth bucket: PARA is fixed at four, and a task belongs to
 * whatever the memory beside it belongs to. Keeping tasks in one named segment is what makes
 * `ls projects/<slug>/tasks` the list operation, which is the design's
 * CRUDL-without-retrieval contract. The segment name is therefore part of the contract.
 */
export const TASKS_SUBDIR = "tasks"

/** The bucket eviction moves into, partitioned by year. */
export const ARCHIVE_BUCKET = "archive"

/** The file extension every memory carries. */
export const MEMORY_EXTENSION = ".html"

/**
 * Reduce a caller-supplied path to the canonical git-tree form: leading slashes dropped
 * (callers may pass the `<link href>` document-reference form), repeated slashes collapsed,
 * trailing slash dropped.
 *
 * The trailing slash is removed by `endsWith`/`slice` rather than by `/\/+$/`, which is not a
 * style choice: an unanchored-left `\/+$` is quadratic on a long run of slashes followed by a
 * non-slash, measured 2026-08-18 at 4 ms / 57 ms / 769 ms / 3049 ms for n = 2k / 8k / 32k / 64k.
 * The collapse above happens to defuse it — after it, no run of two slashes survives, so the
 * pattern can only ever match one character — but that made the cost of this function depend on
 * the ORDER of three chained calls, with nothing stating it and nothing checking it. Reordering
 * them, or dropping the collapse, would reintroduce a multi-second stall on 64 KB of input across
 * this function's callers, all of which sit on the write path that accepts agent-supplied paths.
 * A single-character slice cannot be reordered into a hazard.
 * `packages/contracts/tests/paths.test.ts` asserts the cost curve at adversarial sizes.
 */
export const normalizePath = (path: string): string => {
  const collapsed = path.replace(/^\/+/, "").replace(/\/{2,}/g, "/")
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed
}

/** The PARA bucket a path sits in, or `undefined` when it sits outside all four. */
export const paraBucketOf = (path: string): ParaBucket | undefined => {
  const normalized = normalizePath(path)
  const at = normalized.indexOf("/")
  if (at <= 0) return undefined
  const head = normalized.slice(0, at)
  return PARA_BUCKETS.find((bucket) => bucket === head)
}

/**
 * True when a path is a usable memory path: rooted in a PARA bucket, ending in `.html`,
 * carrying no `.` or `..` segment. The traversal check is what keeps a caller-supplied
 * path from escaping the memory repo.
 */
export const isValidMemoryPath = (path: string): boolean => {
  const normalized = normalizePath(path)
  if (paraBucketOf(normalized) === undefined) return false
  if (!normalized.endsWith(MEMORY_EXTENSION)) return false
  const segments = normalized.split("/")
  if (segments.length < 2) return false
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

/**
 * What {@link placementFor} decides from. `path` is the caller's explicit override.
 *
 * Every optional field also admits `undefined` explicitly. Under
 * `exactOptionalPropertyTypes` a bare `path?: string` would refuse
 * `placementFor({ path: params.path, … })` for a `string | undefined` param, forcing every
 * tool adapter to strip absent fields by hand. The contract therefore accepts the shape the
 * MCP and CLI layers actually hold.
 */
export interface PlacementInput {
  readonly path?: string | undefined
  readonly memoryType: string
  readonly entities?: ReadonlyArray<string> | undefined
  readonly workspace?: string | undefined
  readonly tags?: ReadonlyArray<string> | undefined
}

/** Types that route to a topic directory under `resources/` when no workspace is named. */
const RESOURCE_TYPES: ReadonlyArray<string> = ["semantic", "procedural", "precedent"]

/**
 * The directory a memory belongs in, following design §2.1's six rules in order, with the
 * `task` rule sitting between the arc rule and the person rule. Total: it always returns a
 * directory rooted in a PARA bucket, so the write path never guesses twice and never fails.
 *
 * Returns the *directory*, not the full path, because the filename needs a title this input
 * does not carry. {@link memoryPathFor} composes the two. An explicit `path` contributes
 * its directory; when that path is unusable it is ignored rather than propagated, so the
 * return stays a valid bucket. A caller that wants an invalid path refused rather than
 * silently re-derived gates on {@link isValidMemoryPath} first.
 */
export const placementFor = (input: PlacementInput): string => {
  if (input.path !== undefined && isValidMemoryPath(input.path)) {
    const normalized = normalizePath(input.path)
    return normalized.slice(0, normalized.lastIndexOf("/"))
  }

  if (input.memoryType === "arc") return ARCS_DIR

  /**
   * A task routes by workspace alone, before the person and topic rules. A task about a person
   * is still a task, and routing it to `resources/people/` would put working state in the
   * durable identity surface. A task carries no topic, so the tag rule has nothing to read.
   */
  if (input.memoryType === "task") {
    return input.workspace !== undefined && input.workspace !== ""
      ? `projects/${slugify(input.workspace)}/${TASKS_SUBDIR}`
      : `${INBOX_DIR}/${TASKS_SUBDIR}`
  }

  const namesPerson = (input.entities ?? []).some((entity) => entity.startsWith("person:"))
  if (namesPerson && input.memoryType === "semantic") return PEOPLE_DIR

  if (input.workspace !== undefined && input.workspace !== "") {
    return `projects/${slugify(input.workspace)}`
  }

  const primaryTag = (input.tags ?? []).find((tag) => tag.trim() !== "")
  if (RESOURCE_TYPES.includes(input.memoryType) && primaryTag !== undefined) {
    return `resources/${slugify(primaryTag)}`
  }

  return INBOX_DIR
}

/**
 * The full path for a new memory. An explicit valid `path` is authoritative and returned
 * verbatim in canonical form; otherwise the directory comes from {@link placementFor} and
 * the filename from {@link filenameFor}, which date-prefixes an episodic entry.
 */
export const memoryPathFor = (
  input: PlacementInput & { readonly title: string; readonly at: Date }
): string => {
  if (input.path !== undefined && isValidMemoryPath(input.path)) return normalizePath(input.path)
  const filename = filenameFor({
    slug: slugify(input.title),
    episodic: input.memoryType === "episodic",
    at: input.at
  })
  return `${placementFor(input)}/${filename}`
}

/** Format a year as the four-digit `archive/<YYYY>/` segment. */
const yearSegment = (year: number): string => Math.trunc(year).toString().padStart(4, "0")

/**
 * The archive path a memory moves to on eviction: `archive/<YYYY>/<original-path>`, with the
 * original path mirrored exactly beneath the year.
 *
 * `year` is a calendar year (a label, not an offset). Mirroring the whole original path is
 * what makes the mapping injective and invertible, so `git log --follow` reads through the
 * move and `diff -M` reports it as `R100` rather than a delete plus an add.
 */
export const archivePathFor = (path: string, year: number): string =>
  `${ARCHIVE_BUCKET}/${yearSegment(year)}/${normalizePath(path)}`

/**
 * The pre-eviction path behind an archive path, or `undefined` when the path is not an
 * archive path. Strips exactly one `archive/<YYYY>/` prefix, so it is the left inverse of
 * {@link archivePathFor} even for a memory archived twice.
 */
export const originalPathFor = (archivePath: string): string | undefined => {
  const normalized = normalizePath(archivePath)
  const match = /^archive\/(\d{4,})\/(.+)$/.exec(normalized)
  return match?.[2]
}

/** True when a path sits under the archive bucket with a year partition. */
export const isArchivePath = (path: string): boolean => originalPathFor(path) !== undefined

/** The archive year of an archive path, or `undefined` when the path is not archived. */
export const archiveYearOf = (path: string): number | undefined => {
  const match = /^archive\/(\d{4,})\//.exec(normalizePath(path))
  return match?.[1] === undefined ? undefined : Number(match[1])
}
