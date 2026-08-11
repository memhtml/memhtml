/**
 * Pure parsers for git's `-z` plumbing formats, and the commit-message algebra.
 *
 * Every function here is total over arbitrary input and free of I/O, so the formats are pinned
 * against captured bytes in a unit test rather than only exercised through a live repo. That
 * split matters: an integration test proves the command works today, and these prove the
 * parser survives a malformed, truncated, or empty stream — which is what a partially written
 * pipe from a killed subprocess actually looks like.
 *
 * Every format below was probed live 2026-08-02.
 */

/** One blob from `git ls-tree -r --full-name -z`. */
export interface TreeEntry {
  /** The file mode as git prints it, e.g. `100644`. */
  readonly mode: string
  /** `blob` or `commit` (a submodule). `tree` never appears under `-r`. */
  readonly objectType: string
  /** The blob sha — also the indexer's change key, equal to `hash-object` on the file. */
  readonly sha: string
  /** Repo-root-relative, forward slashes, no leading slash. */
  readonly path: string
}

/**
 * `ls-tree -r --full-name -z` rows: `<mode> <type> <sha>\t<path>\0`.
 *
 * The tab is what makes this parseable with a path containing spaces, and `-z` is what makes
 * it parseable with a path containing a newline — git would otherwise quote and escape such a
 * path, and an unescaping parser is a second format to get wrong.
 */
export const parseLsTree = (output: string): ReadonlyArray<TreeEntry> =>
  output
    .split("\0")
    .filter((row) => row !== "")
    .flatMap((row) => {
      const tab = row.indexOf("\t")
      if (tab === -1) return []
      const [mode, objectType, sha] = row.slice(0, tab).split(" ")
      if (mode === undefined || objectType === undefined || sha === undefined) return []
      return [{ mode, objectType, sha, path: row.slice(tab + 1) }]
    })

/** How a path changed between two commits. `renamed` carries both paths. */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechanged"

/** One entry from `git diff --name-status -M -z`. */
export interface ChangedPath {
  readonly kind: ChangeKind
  /** The path as of the newer commit. For a delete, the path that went away. */
  readonly path: string
  /** Set only on a rename or copy: the path as of the older commit. */
  readonly fromPath: string | null
  /**
   * Rename/copy similarity as git's own integer percentage, 0-100, or `null` for every other
   * kind. A pure `git mv` scores 100; the same move carrying a head stamp in the same commit
   * scores lower (measured 59-87 on real memory files), which is why nothing downstream may
   * gate on 100 — `originalPathFor` is the authoritative inverse of the archive mapping.
   */
  readonly similarity: number | null
}

/** The status letters git emits, mapped to the names this package uses. */
const CHANGE_KINDS: Readonly<Record<string, ChangeKind>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechanged"
}

/**
 * `diff --name-status -M -z` output.
 *
 * The framing is NOT one record per NUL-delimited field: status and path are separate fields,
 * so `A\0path\0` is one change in two fields, and a rename is `R100\0from\0to\0` — three.
 * Probed live: a mixed diff came back as
 * `D\0a/three.html\0M\0a/two.html\0A\0b/new.html\0R100\0a/one.html\0b/one-renamed.html\0`.
 * Reading fields pairwise would silently attribute a rename's destination to the next change.
 */
export const parseDiffNameStatus = (output: string): ReadonlyArray<ChangedPath> => {
  const fields = output.split("\0").filter((field) => field !== "")
  const changes: Array<ChangedPath> = []
  let index = 0
  while (index < fields.length) {
    const status = fields[index]
    if (status === undefined) break
    const kind = CHANGE_KINDS[status.charAt(0)]
    if (kind === undefined) {
      index += 1
      continue
    }
    const score = status.slice(1)
    const similarity = score === "" ? null : Number(score)
    if (kind === "renamed" || kind === "copied") {
      const fromPath = fields[index + 1]
      const path = fields[index + 2]
      index += 3
      if (fromPath === undefined || path === undefined) break
      changes.push({ kind, path, fromPath, similarity })
      continue
    }
    const path = fields[index + 1]
    index += 2
    if (path === undefined) break
    changes.push({ kind, path, fromPath: null, similarity: null })
  }
  return changes
}

/** The state of one path in `git status --porcelain=v2`. */
export type StatusKind = "changed" | "renamed" | "unmerged" | "untracked" | "ignored"

/**
 * One record from `git status --porcelain=v2 -z`.
 *
 * The sha fields are deliberately four rather than two reused across kinds. An `unmerged`
 * record's shas are index STAGES (base/ours/theirs), not a HEAD/index pair, and a field named
 * `headSha` that means "our stage-2 blob" on one kind and "the sha in HEAD" on another is the
 * shape-agrees-meaning-differs seam this fleet has paid for repeatedly. Each field is `null`
 * on every kind it does not describe.
 */
export interface StatusEntry {
  readonly kind: StatusKind
  readonly path: string
  /** Set only on a rename: the path it moved from. */
  readonly fromPath: string | null
  /**
   * The two-letter XY code: X is the index-vs-HEAD state, Y the worktree-vs-index state, `.`
   * for unchanged. Empty for an untracked or ignored path, which have no staged state.
   */
  readonly xy: string
  /** `changed`/`renamed` only: the blob sha in HEAD, `null` when the path is new. */
  readonly headSha: string | null
  /**
   * `changed`/`renamed` only: the blob sha in the INDEX — the staged content, not what is on
   * disk. A worktree-modified file's on-disk sha needs `hash-object`, which is why the indexer
   * stamps it separately rather than reading it from here.
   */
  readonly indexSha: string | null
  /** `unmerged` only: index stage 2, this side's blob. `WriteConflict.ourSha`. */
  readonly oursSha: string | null
  /** `unmerged` only: index stage 3, the incoming blob. `WriteConflict.theirSha`. */
  readonly theirsSha: string | null
}

/** All-zero shas mean "no object": git prints them for a path absent from HEAD or the index. */
const isNullSha = (sha: string): boolean => /^0+$/.test(sha)

const shaOrNull = (sha: string | undefined): string | null =>
  sha === undefined || isNullSha(sha) ? null : sha

/**
 * `status --porcelain=v2 -z` records.
 *
 * The record shapes, probed live:
 * - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>\0` — an ordinary change.
 * - `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>\0` — a rename. The
 *   original path is its OWN NUL field, which is the trap: a parser that reads one field per
 *   record consumes the next record's data as this one's path.
 * - `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>\0` — unmerged, three stage shas.
 * - `? <path>\0` and `! <path>\0` — untracked and ignored.
 */
export const parseStatusPorcelainV2 = (output: string): ReadonlyArray<StatusEntry> => {
  const records = output.split("\0").filter((record) => record !== "")
  const entries: Array<StatusEntry> = []
  let index = 0
  while (index < records.length) {
    const record = records[index]
    if (record === undefined) break
    index += 1
    const marker = record.slice(0, 2)

    if (marker === "? " || marker === "! ") {
      entries.push({
        kind: marker === "? " ? "untracked" : "ignored",
        path: record.slice(2),
        fromPath: null,
        xy: "",
        headSha: null,
        indexSha: null,
        oursSha: null,
        theirsSha: null
      })
      continue
    }

    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — seven fields before the path.
    if (marker === "1 ") {
      const fields = splitFields(record.slice(2), 7)
      const path = fields.rest
      if (path === null) continue
      entries.push({
        kind: "changed",
        path,
        fromPath: null,
        xy: fields.head[0] ?? "",
        headSha: shaOrNull(fields.head[5]),
        indexSha: shaOrNull(fields.head[6]),
        oursSha: null,
        theirsSha: null
      })
      continue
    }

    // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` — eight before the path.
    if (marker === "2 ") {
      const fields = splitFields(record.slice(2), 8)
      const path = fields.rest
      // The original path is the next NUL field, consumed here so the loop stays aligned.
      const fromPath = records[index]
      index += 1
      if (path === null || fromPath === undefined) continue
      entries.push({
        kind: "renamed",
        path,
        fromPath,
        xy: fields.head[0] ?? "",
        headSha: shaOrNull(fields.head[5]),
        indexSha: shaOrNull(fields.head[6]),
        oursSha: null,
        theirsSha: null
      })
      continue
    }

    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — nine before the path. The
    // three shas are index stages: 1 base, 2 ours, 3 theirs.
    if (marker === "u ") {
      const fields = splitFields(record.slice(2), 9)
      const path = fields.rest
      if (path === null) continue
      entries.push({
        kind: "unmerged",
        path,
        fromPath: null,
        xy: fields.head[0] ?? "",
        headSha: null,
        indexSha: null,
        oursSha: shaOrNull(fields.head[7]),
        theirsSha: shaOrNull(fields.head[8])
      })
    }
  }
  return entries
}

/**
 * The first `count` space-delimited fields of a record, and everything after them as one
 * string. A path may contain spaces, so it must never be split — only the fixed-arity prefix
 * is space-delimited, and the remainder is the path verbatim.
 */
const splitFields = (
  record: string,
  count: number
): { readonly head: ReadonlyArray<string>; readonly rest: string | null } => {
  const head: Array<string> = []
  let offset = 0
  for (let field = 0; field < count; field += 1) {
    const space = record.indexOf(" ", offset)
    if (space === -1) return { head, rest: null }
    head.push(record.slice(offset, space))
    offset = space + 1
  }
  const rest = record.slice(offset)
  return { head, rest: rest === "" ? null : rest }
}

/**
 * `cat-file --batch` output: `<sha> <type> <size>\n<size bytes>\n` per object, or
 * `<sha> missing\n` for one git does not have (exit stays 0, so a missing object is a gap in
 * the map rather than a failure).
 *
 * Parsed over bytes, not a decoded string: the size in the header counts BYTES, and a blob
 * carrying multibyte UTF-8 would make every subsequent header offset wrong if the sizes were
 * applied to string indices. A memory file is UTF-8 with em dashes in it, so this is the
 * common case rather than an edge one.
 */
export const parseCatFileBatch = (output: Uint8Array): ReadonlyMap<string, Uint8Array> => {
  const blobs = new Map<string, Uint8Array>()
  const NEWLINE = 0x0a
  let offset = 0
  while (offset < output.length) {
    const lineEnd = output.indexOf(NEWLINE, offset)
    if (lineEnd === -1) break
    const header = Buffer.from(output.subarray(offset, lineEnd)).toString("utf8")
    offset = lineEnd + 1
    const [sha, objectType, size] = header.split(" ")
    if (sha === undefined || objectType === undefined) break
    // `missing`, `ambiguous`, and `dangling` all mean "no body follows".
    if (size === undefined) continue
    const length = Number(size)
    if (!Number.isFinite(length) || length < 0) break
    blobs.set(sha, output.subarray(offset, offset + length))
    // The body is followed by one newline that is not part of the object.
    offset += length + 1
  }
  return blobs
}

/**
 * `logTrailers` framing. A commit subject can contain any byte a shell allows, and a trailer
 * value can contain commas and newlines, so the record and field separators are control
 * characters no git output uses for its own structure: NUL between records, U+001F between
 * fields.
 */
export const TRAILER_RECORD_SEPARATOR = "%x00"
export const TRAILER_FIELD_SEPARATOR = "%x1f"

/**
 * The byte `%x1f` expands to, as an escape rather than the literal control character. A raw
 * 0x1F in source survives a copy through a terminal or an editor only by luck, and this and
 * the format string above must agree exactly or every trailer parses as part of the sha.
 */
export const TRAILER_FIELD_CHAR = "\u001f"

/** One commit's trailer values for a queried key. Empty `values` means it carried none. */
export interface TrailerRecord {
  readonly sha: string
  readonly values: ReadonlyArray<string>
}

/**
 * Parse the `--format` output {@link TRAILER_RECORD_SEPARATOR} frames. Order is git's own —
 * newest commit first, which is what `sleep resume` wants when it asks which phases ran.
 */
export const parseTrailerLog = (output: string): ReadonlyArray<TrailerRecord> =>
  output
    .split("\0")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .flatMap((record) => {
      const [sha, ...rest] = record.split(TRAILER_FIELD_CHAR)
      if (sha === undefined || sha.trim() === "") return []
      return [
        {
          sha: sha.trim(),
          values: rest
            .flatMap((field) => field.split(TRAILER_FIELD_CHAR))
            .map((value) => value.trim())
            .filter((value) => value !== "")
        }
      ]
    })

/**
 * A commit subject: `memhtml(<op>): <subject>`, Conventional-Commits-shaped so the memory repo's
 * history reads the same way every sibling's does.
 *
 * The subject is collapsed to one line and capped, because it carries a memory *title* — an
 * agent-supplied string that may hold newlines, and a newline in `-m` would silently become a
 * commit body, moving the title out of `git log --oneline`.
 */
export const COMMIT_SUBJECT_MAX = 72

/** Operations that appear in a commit subject's scope position. */
export type MemhtmlOperation =
  | "write"
  | "correct"
  | "archive"
  | "link"
  | "init"
  | "publish"
  | "state"

export const commitSubject = (operation: MemhtmlOperation | string, subject: string): string => {
  const flat = subject.replace(/\s+/g, " ").trim()
  const capped =
    flat.length <= COMMIT_SUBJECT_MAX ? flat : `${flat.slice(0, COMMIT_SUBJECT_MAX - 1).trim()}…`
  return `memhtml(${operation}): ${capped === "" ? "(untitled)" : capped}`
}

/** The git trailer key carrying a memory write's originating session. */
export const SESSION_TRAILER = "Memhtml-Session"

/** The git trailer key carrying the prompt within that session. */
export const PROMPT_TRAILER = "Memhtml-Prompt"

/**
 * Session provenance as commit trailers, omitting what is absent. Provenance is in the file's
 * head too (`memhtml-session`/`memhtml-prompt`); the trailer is what makes it reachable from a commit
 * range without reading any file, which is how a sleep run attributes a night's writes.
 */
export const provenanceTrailers = (input: {
  readonly sessionId?: string | undefined
  readonly promptId?: string | undefined
}): Record<string, string> => {
  const trailers: Record<string, string> = {}
  if (input.sessionId !== undefined && input.sessionId !== "") {
    trailers[SESSION_TRAILER] = input.sessionId
  }
  if (input.promptId !== undefined && input.promptId !== "") {
    trailers[PROMPT_TRAILER] = input.promptId
  }
  return trailers
}
