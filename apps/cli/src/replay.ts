import type { OverlayOp } from "@memhtml/contracts"
import { originalPathFor } from "@memhtml/contracts/paths"
import { contentHash, parseMemory } from "@memhtml/html"
import { archiveBody, type CommitScope } from "@memhtml/session"
import { type GitFailure, makeGit } from "@memhtml/store"
import { Effect, Result } from "effect"

import { harvestOps } from "./session-exec.js"

/**
 * Replay for `curate merge` (`docs/v2-poc.md`, "Curation door"): the curator's operation log,
 * reconstructed from the trees at the merge base and at the curate ref's tip, so a branch whose
 * base `main` has moved past can be landed as a fresh session on `main` instead of a fast-forward.
 *
 * A commit on a curate ref is a pure function of overlay ops (`commitSession` stages puts, archive
 * copies with head-only stamps, and head-only link splices, and nothing else), so the difference
 * between the two trees is decidable back into ops: an added `.html` is a `put`; a file gone from
 * its path beside a new `archive/<YYYY>/<that path>` holding the same article is one `archive`; a
 * file still at its path with the same article and new `<link rel="memhtml-...">` edges is one
 * `link` per edge, and one `unlink` per edge it lost. Anything else (a file deleted with no twin, an
 * article changed in place, a meta changed, a file that is not a memory) is not an operation, and
 * since the commit path cannot write it, someone wrote it by hand; the merge refuses naming the path
 * and the reason.
 *
 * The comparison is the harvester's ({@link harvestOps}, `session-exec.ts`): the base tree is the
 * seeded set and the tip tree is what the script left. One thing differs from a sandbox run: an
 * archive copy on a curate ref carries the stamps `commitSession` wrote (`memhtml-status archived`,
 * `memhtml-archived <instant>`), which the harvester's head comparison would read as a meta change.
 * So the seeded side of an archived source is restamped with {@link archiveBody} at the instant the
 * twin names before the comparison, and the two heads then differ only in what the curator added.
 */

/** One path the two trees disagree on, as `git diff-tree -r -z --no-renames` reports it. */
export interface DiffEntry {
  /** `A` added, `D` deleted, `M` modified, `T` type changed. Renames are disabled, so never `R`. */
  readonly status: string
  readonly path: string
  /** The blob at the base, or `null` when the path was added. */
  readonly beforeSha: string | null
  /** The blob at the tip, or `null` when the path was deleted. */
  readonly afterSha: string | null
}

const RAW_ENTRY = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/
const NULL_SHA = "0".repeat(40)

/**
 * Parse the raw, NUL-framed diff-tree output: `:<mode> <mode> <sha> <sha> <status>\0<path>\0` per
 * entry. Framed on NUL so a path holding a non-ASCII byte arrives as bytes rather than quoted and
 * escaped (`core.quotePath`). A malformed record throws rather than returning a partial list,
 * because a replay over half a diff would land half a curation.
 */
export const parseDiffTreeRaw = (output: string): ReadonlyArray<DiffEntry> => {
  const fields = output.split("\0")
  if (fields.at(-1) === "") fields.pop()
  const entries: Array<DiffEntry> = []
  for (let at = 0; at < fields.length; at += 2) {
    const header = fields[at] ?? ""
    const path = fields[at + 1]
    const match = RAW_ENTRY.exec(header)
    if (match === null || path === undefined) {
      throw new Error(`diff-tree record ${String(at / 2)} is not a raw entry: ${header}`)
    }
    const [, , , before, after, status] = match
    entries.push({
      status: status ?? "",
      path,
      beforeSha: before === NULL_SHA || before === undefined ? null : before,
      afterSha: after === NULL_SHA || after === undefined ? null : after
    })
  }
  return entries
}

/** What one path could not be replayed as, and why. */
export interface ReplayRejection {
  readonly path: string
  readonly reason: string
}

/** The reconstructed log, or what stopped it. `rejected` non-empty means the merge refuses. */
export interface Reconstruction {
  /** `put`s, then `link`s, then `archive`s, each sorted by path: the harvester's order. */
  readonly ops: ReadonlyArray<OverlayOp>
  readonly rejected: ReadonlyArray<ReplayRejection>
  readonly counts: {
    readonly put: number
    readonly archive: number
    readonly link: number
    readonly unlink: number
  }
  /**
   * The instant every archive twin at the tip is stamped with, when there is exactly one; `null`
   * when there are no archives or the twins disagree (a ref of several commits). The landing passes
   * it as `archivedAt`, so a replayed archive keeps the instant the curator archived it.
   */
  readonly archivedAt: string | null
}

const contentHashOrNull = (html: string): string | null => {
  try {
    return contentHash(html)
  } catch {
    return null
  }
}

/** The `memhtml-archived` stamp on a memory's head, or `null` when absent or unparseable. */
const archivedStampOf = (html: string): string | null => {
  const parsed = Effect.runSync(Effect.result(parseMemory(html)))
  return Result.isSuccess(parsed) ? (parsed.success.metas.archivedAt ?? null) : null
}

/** The stated reason an in-place article change is refused. */
export const ARTICLE_EDIT_REASON =
  "the article changed in place; a claim is never edited, so this is not an operation (write a new record and archive this one)"

/**
 * Rebuild the operation log from two trees. Pure over bytes: `before` holds every changed path's
 * body at the merge base (absent for an added path), `after` every changed path's body at the tip
 * (absent for a deleted path). Untouched paths need not appear in either.
 *
 * The harvester decides puts, links, and archives, and rejects deletions with no twin, twins whose
 * article differs, and head edits other than added links. One rule is added on top: a `put` at a
 * path that existed at the base is an article changed in place, which the harvester reports as a
 * put (for `validateOps` to refuse as `claim-edit`) and which a replay refuses here by name, because
 * the commit path never writes one and the sandbox is not where it came from.
 */
export const reconstructOps = (input: {
  readonly before: ReadonlyMap<string, string>
  readonly after: ReadonlyMap<string, string>
  readonly scope?: CommitScope | undefined
}): Reconstruction => {
  const stamps = new Set<string>()
  const seeded = new Map<string, { readonly html: string; readonly contentHash: string }>()
  for (const [path, html] of input.before) {
    let seededHtml = html
    if (!input.after.has(path)) {
      // An archived source: its twin carries the commit's stamps, so the seeded side carries them
      // too, and the comparison sees only what the curator added to the copy's head.
      const twin = [...input.after.keys()].find((candidate) => originalPathFor(candidate) === path)
      const stamp = twin === undefined ? null : archivedStampOf(input.after.get(twin) ?? "")
      if (stamp !== null) {
        stamps.add(stamp)
        seededHtml = archiveBody(html, stamp)
      }
    }
    seeded.set(path, { html: seededHtml, contentHash: contentHashOrNull(seededHtml) ?? "" })
  }
  const harvest = harvestOps({
    seeded,
    after: [...input.after].map(([path, html]) => ({ path, html })),
    skippedGitDir: false,
    scope: input.scope
  })
  const rejected: Array<ReplayRejection> = [...harvest.rejected]
  const ops = harvest.ops.filter((op) => {
    if (op.kind === "put" && input.before.has(op.path)) {
      rejected.push({ path: op.path, reason: ARTICLE_EDIT_REASON })
      return false
    }
    return true
  })
  const count = (kind: OverlayOp["kind"]): number => ops.filter((op) => op.kind === kind).length
  const byPath = (a: ReplayRejection, b: ReplayRejection): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  return {
    ops,
    rejected: rejected.sort(byPath),
    counts: {
      put: count("put"),
      archive: count("archive"),
      link: count("link"),
      unlink: count("unlink")
    },
    archivedAt: stamps.size === 1 ? ([...stamps][0] ?? null) : null
  }
}

/** The two trees' disagreement as bytes, read from git in two subprocesses. */
export interface CurateDelta {
  readonly before: ReadonlyMap<string, string>
  readonly after: ReadonlyMap<string, string>
  /** Paths whose change the raw diff reports in a form no op has (a type change). */
  readonly unsupported: ReadonlyArray<ReplayRejection>
}

const utf8 = new TextDecoder()

/**
 * Read every path `base` and `tip` disagree on, with its body at each end: one `diff-tree` for the
 * statuses and blob shas, one `cat-file --batch` for the bodies. `--no-renames`, so an archive
 * arrives as its deletion and its addition and the pairing is the reconstruction's to decide.
 */
export const readCurateDelta = (
  root: string,
  base: string,
  tip: string
): Effect.Effect<CurateDelta, GitFailure> =>
  Effect.gen(function* () {
    const git = makeGit(root)
    const raw = yield* git.run(["diff-tree", "-r", "-z", "--no-renames", base, tip])
    const entries = parseDiffTreeRaw(raw)
    const unsupported: Array<ReplayRejection> = []
    const wanted = new Set<string>()
    for (const entry of entries) {
      if (entry.status === "T") {
        unsupported.push({
          path: entry.path,
          reason: "changed type (a symlink or a submodule is not a memory)"
        })
        continue
      }
      if (entry.beforeSha !== null) wanted.add(entry.beforeSha)
      if (entry.afterSha !== null) wanted.add(entry.afterSha)
    }
    const blobs = yield* git.catFileBatch([...wanted])
    const before = new Map<string, string>()
    const after = new Map<string, string>()
    const bodyOf = (sha: string): string => {
      const bytes = blobs.get(sha)
      return bytes === undefined ? "" : utf8.decode(bytes)
    }
    for (const entry of entries) {
      if (entry.status === "T") continue
      if (entry.beforeSha !== null) before.set(entry.path, bodyOf(entry.beforeSha))
      if (entry.afterSha !== null) after.set(entry.path, bodyOf(entry.afterSha))
    }
    return { before, after, unsupported }
  })

/** `git merge-base a b`, or `null` when the two commits share no history. */
export const mergeBase = (
  root: string,
  a: string,
  b: string
): Effect.Effect<string | null, GitFailure> =>
  makeGit(root)
    .run(["merge-base", a, b])
    .pipe(
      Effect.map((out) => {
        const sha = out.trim()
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null
      }),
      // Exit 1 is "no common ancestor", an answer rather than a failure.
      Effect.catchTag("GitFailure", (failure) =>
        failure.exitCode === 1 ? Effect.succeed(null) : Effect.fail(failure)
      )
    )

/** A commit's subject line, with the `memhtml(<scope>): ` prefix taken off when it carries one. */
export const commitSubjectOf = (root: string, sha: string): Effect.Effect<string, GitFailure> =>
  makeGit(root)
    .run(["log", "-1", "--format=%s", sha])
    .pipe(Effect.map((out) => out.trim().replace(/^memhtml\([a-z]+\):\s*/, "")))
