import { unlink } from "node:fs/promises"

import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import type { InvalidMemory, StorageFailure } from "@memhtml/contracts/errors"
import {
  advanceHead,
  type HeadVersion,
  isCandidatePath,
  loadHead,
  versionFromRecords
} from "@memhtml/head"
import { ensureExcludedQuietly } from "@memhtml/session"
import {
  listSnapshots,
  pruneSnapshots,
  readSnapshotIfPresent,
  SNAPSHOTS_DIR,
  snapshotPathFor,
  writeSnapshot
} from "@memhtml/snapshot"
import { type GitFailure, makeGit, parseNulPathList } from "@memhtml/store"
import { Effect } from "effect"

/**
 * The head's cold-start cache, on both sides (`docs/v2-poc.md`, "Loading from snapshots").
 *
 * Read side: {@link loadVersion} builds the version at a sha from its own snapshot when one exists,
 * else from the newest snapshot of an ANCESTOR commit advanced through `advanceHead` over the paths
 * the two trees differ on, else from git. A store that lands a commit a day has a snapshot for
 * yesterday's tip and a few dozen changed paths since, so the advance path is the common one after
 * the first load, and the full git read is the exception it was built to be. The cache can make a
 * load faster and never make it fail: a snapshot that cannot be read is a miss, and the load tries
 * the next source.
 *
 * Write side: {@link writeHeadSnapshot} writes the snapshot for a version and prunes the directory
 * to the newest {@link SNAPSHOTS_KEPT}; {@link snapshotAfterCommit} is the best-effort form every
 * ref-moving commit calls, so the next invocation hits the cache for the sha it just made.
 */

export type HeadSource = "snapshot" | "snapshot+advance" | "git"

export interface LoadedVersion {
  readonly version: HeadVersion
  readonly source: HeadSource
  /** The snapshot the version was read from (its own, or the ancestor's), or `null` from git. */
  readonly snapshotPath: string | null
  /** Under `snapshot+advance`, the commit whose snapshot was advanced; otherwise `null`. */
  readonly ancestorSha: string | null
  /**
   * Under `snapshot+advance`, how many memory paths differ between the ancestor and the target:
   * the paths `advanceHead` handed to the parser (or removed). Otherwise `null`.
   */
  readonly reparsed: number | null
}

/** `merge-base --is-ancestor`: exit 1 is "no", an answer rather than a failure. */
const isAncestor = (
  root: string,
  sha: string,
  target: string
): Effect.Effect<boolean, GitFailure> =>
  makeGit(root)
    .run(["merge-base", "--is-ancestor", sha, target])
    .pipe(
      Effect.as(true),
      Effect.catchTag("GitFailure", (failure) =>
        failure.exitCode === 1 ? Effect.succeed(false) : Effect.fail(failure)
      )
    )

/** How many memory paths differ between two trees, the count `advanceHead` will re-parse over. */
const changedCandidates = (
  root: string,
  from: string,
  to: string
): Effect.Effect<number, GitFailure> =>
  makeGit(root)
    .run(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to])
    .pipe(Effect.map((out) => parseNulPathList(out).filter(isCandidatePath).length))

export interface AncestorSnapshot {
  readonly sha: string
  readonly path: string
  /** Memory paths that differ between the ancestor and the target. */
  readonly changed: number
}

/**
 * The snapshots to advance from when `target` has none of its own, best first: those whose sha is
 * an ancestor of `target`, by fewest changed memory paths, ties to the newer file. Empty when no
 * snapshot is an ancestor (a fresh clone, or a target on an unrelated branch). A snapshot whose
 * sha git cannot judge (a commit gc'd with the branch that made it) is passed over with a log line.
 */
export const ancestorSnapshots = (
  root: string,
  target: string
): Effect.Effect<ReadonlyArray<AncestorSnapshot>, StorageFailure> =>
  Effect.gen(function* () {
    const found: Array<AncestorSnapshot> = []
    // `listSnapshots` is newest first and the sort is stable, so equal counts keep that order.
    for (const entry of yield* listSnapshots(root)) {
      if (entry.sha === target) continue
      const probed = yield* Effect.result(
        Effect.gen(function* () {
          if (!(yield* isAncestor(root, entry.sha, target))) return null
          return yield* changedCandidates(root, entry.sha, target)
        })
      )
      if (probed._tag === "Failure") {
        yield* Effect.logWarning(
          `snapshot ${entry.path} names a commit git could not compare with ${target} (${probed.failure.command}, exit ${String(probed.failure.exitCode)}); passing over it`
        )
        continue
      }
      if (probed.success === null) continue
      found.push({ sha: entry.sha, path: entry.path, changed: probed.success })
    }
    return found.sort((left, right) => left.changed - right.changed)
  })

/**
 * The snapshot to advance from when `target` has none of its own: the first of
 * {@link ancestorSnapshots}, or `null` when no snapshot is an ancestor.
 */
export const findAncestorSnapshot = (
  root: string,
  target: string
): Effect.Effect<AncestorSnapshot | null, StorageFailure> =>
  ancestorSnapshots(root, target).pipe(Effect.map((found) => found[0] ?? null))

/**
 * The records of the snapshot at `path` as a cache of `sha`, or `null` for a miss. Never fails.
 *
 * A file that is not there is a quiet miss. A file that cannot be read (`snapshot.read.file`: a
 * permission, an I/O error) is a miss with a warning and is left alone. A file that reads but is not
 * a snapshot of `sha` (garbage, truncated, another format version, another schema, or metadata that
 * names another sha) is a miss with a warning and is removed, so the next load does not pay to read
 * it again and the next write of that sha lands in its place.
 */
const cachedRecords = (
  path: string,
  sha: string
): Effect.Effect<ReadonlyArray<MemoryRecord> | null> =>
  Effect.gen(function* () {
    const read = yield* Effect.result(readSnapshotIfPresent(path))
    if (read._tag === "Success") {
      if (read.success === null) return null
      if (read.success.sha === sha) return read.success.records
      yield* Effect.logWarning(
        `snapshot ${path} names ${read.success.sha} in its metadata, so it is not the cache of ${sha}`
      )
    } else if (read.failure.operation === "snapshot.read.file") {
      yield* Effect.logWarning(`snapshot ${path} could not be read; loading without it`)
      return null
    }
    yield* Effect.tryPromise(() => unlink(path)).pipe(
      Effect.andThen(
        Effect.logWarning(`snapshot ${path} removed: it is not a cache this build reads`)
      ),
      Effect.catch(() =>
        Effect.logWarning(`snapshot ${path} could not be removed; loading without it`)
      )
    )
    return null
  })

/**
 * The version at `sha`. `source: "git"` forces the full tree read (so `head snapshot --write` can
 * never re-cache a stale file); `"auto"` takes the cheapest path that exists: the sha's own snapshot,
 * else each ancestor snapshot in the order {@link ancestorSnapshots} ranks them, else git.
 *
 * Every snapshot failure is a cache miss and never this call's failure ({@link cachedRecords}): a
 * file that does not decode, is of another format version, or whose metadata names a different sha
 * than its filename is logged, removed, and passed over for the next source. Only git can fail the
 * load, as it would with no cache at all.
 */
export const loadVersion = (
  root: string,
  sha: string,
  source: "auto" | "git" = "auto"
): Effect.Effect<LoadedVersion, GitFailure | InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const git = makeGit(root)
    if (source === "auto") {
      const own = snapshotPathFor(root, sha)
      const records = yield* cachedRecords(own, sha)
      if (records !== null) {
        return {
          version: versionFromRecords(records, sha),
          source: "snapshot",
          snapshotPath: own,
          ancestorSha: null,
          reparsed: null
        }
      }
      // A directory that cannot be listed is one more miss: git still answers.
      const ancestors = yield* ancestorSnapshots(root, sha).pipe(
        Effect.catch((failure) =>
          Effect.logWarning(
            `listing the snapshots under ${root} failed (${failure.operation}); loading ${sha} without them`
          ).pipe(Effect.as([] as ReadonlyArray<AncestorSnapshot>))
        )
      )
      for (const ancestor of ancestors) {
        const base = yield* cachedRecords(ancestor.path, ancestor.sha)
        if (base === null) continue
        const version = yield* advanceHead(git, versionFromRecords(base, ancestor.sha), sha)
        return {
          version,
          source: "snapshot+advance",
          snapshotPath: ancestor.path,
          ancestorSha: ancestor.sha,
          reparsed: ancestor.changed
        }
      }
    }
    return {
      version: yield* loadHead(git, sha),
      source: "git",
      snapshotPath: null,
      ancestorSha: null,
      reparsed: null
    }
  })

/** What writing a snapshot reports. */
export interface SnapshotWritten {
  readonly sha: string
  readonly path: string
  readonly bytes: number
  readonly rows: number
  readonly ms: number
  /** Snapshot shas removed to keep the directory at {@link SNAPSHOTS_KEPT}, newest first. */
  readonly pruned: ReadonlyArray<string>
}

/**
 * Write `view`'s snapshot at `.memhtml/snapshots/<sha>.arrow`, make sure the clone ignores that
 * directory, and prune to the newest few. The exclude step is best-effort and the prune is part of
 * the write: a directory that only grows is a cache that eventually costs more than the git read.
 */
export const writeHeadSnapshot = (
  root: string,
  view: HeadView & { readonly sha: string }
): Effect.Effect<SnapshotWritten, StorageFailure> =>
  Effect.gen(function* () {
    const started = Date.now()
    yield* ensureExcludedQuietly(root, [`${SNAPSHOTS_DIR}/`])
    const path = snapshotPathFor(root, view.sha)
    const written = yield* writeSnapshot({ records: view.records(), sha: view.sha, path })
    const pruned = yield* pruneSnapshots(root)
    return {
      sha: view.sha,
      path,
      bytes: written.bytes,
      rows: written.rows,
      ms: Date.now() - started,
      pruned
    }
  })

/**
 * After a commit moved a ref to `sha`: build that version (from `from` by delta when the caller
 * holds the version it committed against, else through {@link loadVersion}) and write its snapshot.
 *
 * Never fails. The commit has landed; a cache write that could fail it would turn a full disk into
 * a lost commit in the payload while the ref says otherwise. A failure is logged and the payload
 * carries `null`, so the next invocation loads the slow way and says so in `source`.
 */
export const snapshotAfterCommit = (
  root: string,
  sha: string,
  from?: HeadVersion
): Effect.Effect<SnapshotWritten | null> =>
  Effect.gen(function* () {
    const version =
      from === undefined
        ? (yield* loadVersion(root, sha)).version
        : yield* advanceHead(makeGit(root), from, sha)
    return yield* writeHeadSnapshot(root, version)
  }).pipe(
    Effect.catch((failure) =>
      Effect.logWarning(
        `snapshot for ${sha} not written (${failure._tag}); the commit landed and the next load reads git`
      ).pipe(Effect.as(null))
    ),
    Effect.withSpan("head.snapshotAfterCommit")
  )
