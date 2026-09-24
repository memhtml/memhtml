import { access } from "node:fs/promises"

import type { HeadView } from "@memhtml/contracts"
import { type InvalidMemory, StorageFailure } from "@memhtml/contracts/errors"
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
  readSnapshot,
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
 * the first load, and the full git read is the exception it was built to be.
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

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false
    )
  )

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
 * The snapshot to advance from when `target` has none of its own: among the snapshots whose sha is
 * an ancestor of `target`, the one with the fewest changed memory paths, ties to the newest file.
 * `null` when no snapshot is an ancestor (a fresh clone, or a target on an unrelated branch).
 */
export const findAncestorSnapshot = (
  root: string,
  target: string
): Effect.Effect<AncestorSnapshot | null, GitFailure | StorageFailure> =>
  Effect.gen(function* () {
    let best: AncestorSnapshot | null = null
    for (const entry of yield* listSnapshots(root)) {
      if (entry.sha === target) continue
      if (!(yield* isAncestor(root, entry.sha, target))) continue
      const changed = yield* changedCandidates(root, entry.sha, target)
      if (best === null || changed < best.changed)
        best = { sha: entry.sha, path: entry.path, changed }
    }
    return best
  })

/**
 * The version at `sha`. `source: "git"` forces the full tree read (so `head snapshot --write` can
 * never re-cache a stale file); `"auto"` takes the cheapest path that exists.
 *
 * A snapshot whose metadata names a different sha than its filename is not the cache it claims to
 * be: as the exact match it is refused, because the caller asked for that sha and the rows describe
 * another; as an ancestor candidate it is skipped with a log line and the load falls through, because
 * an ancestor is a starting point and a wrong one would be advanced into a wrong version.
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
      if (yield* exists(own)) {
        const snapshot = yield* readSnapshot(own)
        if (snapshot.sha !== sha) {
          yield* Effect.logError(
            `snapshot ${own} names ${snapshot.sha} in its metadata, so it is not the cache of ${sha}`
          )
          return yield* Effect.fail(StorageFailure.make({ operation: "snapshot.sha-mismatch" }))
        }
        return {
          version: versionFromRecords(snapshot.records, sha),
          source: "snapshot",
          snapshotPath: own,
          ancestorSha: null,
          reparsed: null
        }
      }
      const ancestor = yield* findAncestorSnapshot(root, sha)
      if (ancestor !== null) {
        const snapshot = yield* readSnapshot(ancestor.path)
        if (snapshot.sha === ancestor.sha) {
          const base = versionFromRecords(snapshot.records, ancestor.sha)
          const version = yield* advanceHead(git, base, sha)
          return {
            version,
            source: "snapshot+advance",
            snapshotPath: ancestor.path,
            ancestorSha: ancestor.sha,
            reparsed: ancestor.changed
          }
        }
        yield* Effect.logError(
          `snapshot ${ancestor.path} names ${snapshot.sha} in its metadata, so it cannot be advanced to ${sha}; loading from git`
        )
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
