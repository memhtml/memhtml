import { filenameFor, slugify, slugifyStem } from "./slug.js"
import { PARA_BUCKETS, type ParaBucket } from "./types.js"

/**
 * Path algebra. Every function here is pure and total, and a path is always the
 * repo-root-relative git-tree form: no leading slash, forward slashes only.
 */

/** Behavioral arcs. Under `areas/` because PARA is fixed at four buckets. */
export const ARCS_DIR = "areas/arcs"

/**
 * The person plane, folded into `resources/` rather than given its own bucket. Placement never
 * routes here: a person record is written at an explicit path by curation ({@link placementFor}).
 */
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
 * Why a path is not a usable memory path, or `undefined` when it is one.
 *
 * The RULE and its explanation in one function, because a refusal that restated the rule in its own
 * words would be a second copy of it, free to name a clause this function does not check. A
 * caller that refuses an unusable path quotes this string; {@link isValidMemoryPath} is the same
 * question asked as a boolean.
 *
 * Each clause names the input it saw rather than the rule in the abstract, so a caller holding the
 * message can act without re-reading the format doc. The traversal clause is the security one: it is
 * what keeps a caller-supplied path from escaping the memory repo.
 */
export const memoryPathViolation = (path: string): string | undefined => {
  const normalized = normalizePath(path)
  if (paraBucketOf(normalized) === undefined) {
    return `it is not rooted in a PARA bucket (${PARA_BUCKETS.join(", ")})`
  }
  if (!normalized.endsWith(MEMORY_EXTENSION)) return `it does not end in ${MEMORY_EXTENSION}`
  /*
   * No "names a bucket and nothing else" clause, because that case cannot reach here:
   * `paraBucketOf` returns a bucket only when a `/` sits at index 1 or later, so a path that got past
   * it always has at least one segment after the bucket. A bare `areas` (or `areas/`, which
   * `normalizePath` reduces to it) fails the clause above instead, and says so.
   */
  const traversal = normalized
    .split("/")
    .find((segment) => segment === "" || segment === "." || segment === "..")
  return traversal === undefined
    ? undefined
    : `it carries a ${traversal === "" ? "blank" : `\`${traversal}\``} path segment`
}

/**
 * True when a path is a usable memory path: rooted in a PARA bucket, ending in `.html`,
 * carrying no `.` or `..` segment.
 *
 * {@link memoryPathViolation} asked as a boolean, so the predicate and the refusal's reason cannot
 * disagree about which paths are usable.
 */
export const isValidMemoryPath = (path: string): boolean => memoryPathViolation(path) === undefined

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
 * The directory a memory belongs in, following design §2.1's five rules in order (explicit path,
 * arc, task, workspace, primary tag), else the inbox. Total: it always returns a
 * directory rooted in a PARA bucket, so the write path never guesses twice and never fails.
 *
 * Returns the *directory*, not the full path, because the filename needs a title this input
 * does not carry. {@link memoryPathFor} composes the two. An explicit `path` contributes
 * its directory; when that path is unusable it is ignored rather than propagated, so the
 * return stays a valid bucket and this function stays total.
 *
 * Totality is why the refusal cannot live here. A caller that wants an unusable path refused
 * rather than re-derived asks the store for it (`strictPath` on a `WriteInput`), which gates on
 * {@link memoryPathViolation} before any of this runs and quotes its reason. Refusing here instead
 * would make placement fallible for every caller, including a curator that places a synthesized
 * arc and has no caller path to be wrong about.
 */
export const placementFor = (input: PlacementInput): string => {
  if (input.path !== undefined && isValidMemoryPath(input.path)) {
    const normalized = normalizePath(input.path)
    return normalized.slice(0, normalized.lastIndexOf("/"))
  }

  if (input.memoryType === "arc") return ARCS_DIR

  /**
   * A task routes by workspace alone, before the topic rule. A task carries no topic, so the tag
   * rule has nothing to read, and a task about a person is still a task, never an identity record.
   */
  if (input.memoryType === "task") {
    return input.workspace !== undefined && input.workspace !== ""
      ? `projects/${slugify(input.workspace)}/${TASKS_SUBDIR}`
      : `${INBOX_DIR}/${TASKS_SUBDIR}`
  }

  /**
   * No rule here routes into `resources/people/`. A `person:` entity says who a record is about,
   * and a fact about a person is still a fact about its project or topic, so it files by the rules
   * below. A person record (the one identity file per person) is a place, not a type: it exists at
   * `resources/people/<person>.html` because a curator wrote it there with an explicit path under
   * the `curate` scope, the only scope that may. Until 2026-09-28 a `semantic` record naming any
   * person was routed there, and inside a run that path is reserved, so a fleet agent's fact that
   * mentioned a colleague was refused with nothing it could fix.
   */
  if (input.workspace !== undefined && input.workspace !== "") {
    return `projects/${slugify(input.workspace)}`
  }

  const primaryTag = (input.tags ?? []).find((tag) => tag.trim() !== "")
  if (RESOURCE_TYPES.includes(input.memoryType) && primaryTag !== undefined) {
    const topic = `resources/${slugify(primaryTag)}`
    // A tag that slugs to `people` names the person plane, which no rule routes into.
    if (topic !== PEOPLE_DIR) return topic
  }

  return INBOX_DIR
}

/**
 * The full path for a new memory. An explicit valid `path` is authoritative and returned
 * verbatim in canonical form; otherwise the directory comes from {@link placementFor} and
 * the filename from {@link filenameFor} over the title's {@link slugifyStem} stem, which
 * date-prefixes an episodic entry.
 */
export const memoryPathFor = (
  input: PlacementInput & { readonly title: string; readonly at: Date }
): string => {
  if (input.path !== undefined && isValidMemoryPath(input.path)) return normalizePath(input.path)
  const filename = filenameFor({
    slug: slugifyStem(input.title),
    episodic: input.memoryType === "episodic",
    at: input.at
  })
  return `${placementFor(input)}/${filename}`
}

/**
 * Format a year and a generation as the `archive/<YYYY>/` segment, or `archive/<YYYY>.<n>/` for a
 * generation of two or more.
 */
const yearSegment = (year: number, generation: number): string => {
  const yyyy = Math.trunc(year).toString().padStart(4, "0")
  const n = Math.trunc(generation)
  return n >= 2 ? `${yyyy}.${String(n)}` : yyyy
}

/**
 * An archive path's three parts: the year, the generation when the segment carries one, and the
 * original path. A generation is written once, as `.<n>` with n >= 2 and no leading zero, so every
 * slot has exactly one spelling and `archive/<YYYY>.1/` is not an archive path at all.
 */
const ARCHIVE_SLOT = /^archive\/(\d{4,})(?:\.([2-9]|[1-9]\d+))?\/(.+)$/

/**
 * The archive path a memory moves to on eviction: `archive/<YYYY>/<original-path>`, with the
 * original path mirrored exactly beneath the year.
 *
 * `year` is a calendar year (a label, not an offset). Mirroring the whole original path is
 * what makes the mapping injective and invertible, so `git log --follow` reads through the
 * move and `diff -M` reports it as `R100` rather than a delete plus an add.
 *
 * `generation` numbers the archivings of one path within one year. The first is the bare year;
 * a path archived again while that slot is held goes to `archive/<YYYY>.2/<original-path>`, then
 * `.3`, and so on, so an archive never writes over an earlier one. {@link archiveSlotFor} picks
 * the generation.
 */
export const archivePathFor = (path: string, year: number, generation = 1): string =>
  `${ARCHIVE_BUCKET}/${yearSegment(year, generation)}/${normalizePath(path)}`

/**
 * The slot an archive of `path` in `year` writes: the first generation `isHeld` does not claim,
 * starting from the bare year, with "held" meaning a record (active or archived) the caller's view
 * or tree already has at the slot. Every writer that archives takes this slot, and the session
 * validator refuses any other.
 *
 * Generations are tried in order, so the answer is the lowest free one and the slots of one path
 * fill without gaps. It terminates for any predicate that holds for finitely many slots, which is
 * every predicate over a real tree.
 */
export const archiveSlotFor = (
  path: string,
  year: number,
  isHeld: (slot: string) => boolean
): string => {
  for (let generation = 1; ; generation += 1) {
    const slot = archivePathFor(path, year, generation)
    if (!isHeld(slot)) return slot
  }
}

/**
 * The pre-eviction path behind an archive path, or `undefined` when the path is not an
 * archive path. Strips exactly one `archive/<YYYY>/` or `archive/<YYYY>.<n>/` prefix, so it is
 * the left inverse of {@link archivePathFor} for every generation, even for a memory archived
 * twice.
 */
export const originalPathFor = (archivePath: string): string | undefined =>
  ARCHIVE_SLOT.exec(normalizePath(archivePath))?.[3]

/** True when a path sits under the archive bucket with a year partition. */
export const isArchivePath = (path: string): boolean => originalPathFor(path) !== undefined

/**
 * The archive year of an archive path, or `undefined` when the path is not archived. A generation
 * slot belongs to its year: `archive/2031.2/x.html` is archived in 2031.
 */
export const archiveYearOf = (path: string): number | undefined => {
  const match = ARCHIVE_SLOT.exec(normalizePath(path))
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * The generation of an archive path: 1 for `archive/<YYYY>/`, n for `archive/<YYYY>.<n>/`, or
 * `undefined` when the path is not archived. Year then generation orders the archivings of one
 * path oldest first; the paths' string order does not, since `.` sorts before `/`.
 */
export const archiveGenerationOf = (path: string): number | undefined => {
  const match = ARCHIVE_SLOT.exec(normalizePath(path))
  if (match === null) return undefined
  return match[2] === undefined ? 1 : Number(match[2])
}

/**
 * Order two archive paths by the archiving each records, for `sort`: negative when `a` is the
 * earlier, positive when it is the later, 0 for the same year and generation. A later year is
 * later, and within a year a higher generation is, since each archive takes its year's first free
 * slot. A path that is not an archive path sorts before every one that is.
 *
 * Not the paths' string order, which puts `archive/2031.2/` before `archive/2031/` (`.` sorts
 * before `/`) and `archive/2031.10/` before `archive/2031.9/`.
 */
export const compareArchivings = (a: string, b: string): number => {
  const year = (archiveYearOf(a) ?? -1) - (archiveYearOf(b) ?? -1)
  if (year !== 0) return year
  return (archiveGenerationOf(a) ?? 0) - (archiveGenerationOf(b) ?? 0)
}

/**
 * Why a path cannot name an active record, or `undefined` when it can: the source an archive move
 * takes, and the task a status change edits.
 *
 * Two clauses, in order. A path that is not a usable memory path is refused with
 * {@link memoryPathViolation}'s own reason, because `normalizePath` keeps `.` and `..` segments: the
 * filesystem resolves `./archive/2031/x.html` and `areas/../archive/2031/x.html` to an archived
 * file, while the bucket read below sees `.` and `areas`, and {@link archivePathFor} would copy the
 * spelling into the destination. A leading `.` or `..` segment is named as such, ahead of the bucket
 * clause it would otherwise trip, so `./projects/x.html` is not told it has no bucket. A path in the
 * archive bucket is already archived, year partition or not, because the index reads every path
 * under `archive/` as archived. Archiving one again would nest it under `archive/<YYYY>/archive/`,
 * where {@link originalPathFor} maps it back to an archive path rather than to a live one.
 */
export const activeRecordPathViolation = (path: string): string | undefined => {
  const normalized = normalizePath(path)
  const lead = normalized.split("/")[0]
  if (lead === "." || lead === "..") {
    const advice = normalized.startsWith("./") ? "; drop the leading `./`" : ""
    return `path \`${normalized}\` is not a usable memory path: it starts with a \`${lead}\` segment${advice}`
  }
  const violation = memoryPathViolation(normalized)
  if (violation !== undefined) {
    return `path \`${normalized}\` is not a usable memory path: ${violation}`
  }
  return paraBucketOf(normalized) === ARCHIVE_BUCKET
    ? `already archived at ${normalized}`
    : undefined
}

/**
 * The filename prefix that makes a detected task recognizable from its path alone: a task a
 * detector minted at `det-<digest>-<slug>.html`, with no `author` column and no commit message to
 * read.
 * `memhtml task list --detected` filters on it and the curator's briefing reads it, so both agree
 * about what a detected path is.
 */
export const DETECTION_PREFIX = "det-"

/**
 * Hex characters of the digest carried in a detected task's path.
 *
 * Twelve, which is git's own abbreviated-sha width. It leaves 48 bits against a queue whose size a cap
 * holds in the tens, and it costs 17 characters of the 80-character slug budget rather than 68.
 */
export const DETECTION_DIGEST_CHARS = 12

const DETECTION_KEY = new RegExp(
  `^(${DETECTION_PREFIX}[0-9a-f]{${String(DETECTION_DIGEST_CHARS)}})-`
)

/**
 * The key a detected task's path carries, or `undefined` when the path is not one. The filename is
 * read, not the directory, so an archived detected task under `archive/<YYYY>/` keeps its key.
 */
export const detectionKeyOf = (path: string): string | undefined =>
  DETECTION_KEY.exec(path.slice(path.lastIndexOf("/") + 1))?.[1]

/** True when a path, live or archived, is a detected task's. */
export const isDetectedTaskPath = (path: string): boolean => detectionKeyOf(path) !== undefined
