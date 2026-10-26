import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CheckoutLockOptions, HeadView, OverlayOp, WriteBarPolicy } from "@memhtml/contracts"
import { CHECKOUT_LOCKED, isEdgeRel, pathToHref, StorageFailure } from "@memhtml/contracts"
import { frameKeyOf } from "@memhtml/domain"
import { addLink, addMeta, parseMemory, removeLink, removeMeta, setMeta } from "@memhtml/html"
import { Effect } from "effect"

import { withCheckoutLock } from "./checkout-lock.js"
import type { GitFailure } from "./errors.js"
import { makePlumbing, type Plumbing } from "./plumbing.js"
import { requireLogUnmoved, type Session, saveSessionLocked, withSessionLock } from "./session.js"
import { settlePending } from "./settle.js"
import { type CommitScope, touchedPaths, type Violation, validateOps } from "./validate.js"

export type { CommitScope } from "./validate.js"

/**
 * The commit path. Mechanical, no model call: validate, check the ref against the validated version,
 * check frame-key conflicts, write blobs, write a tree, commit, record the intent, then move the
 * checkout and compare-and-swap the ref under the checkout lock.
 */

export type CommitOutcome =
  | {
      readonly kind: "committed"
      readonly sha: string
      readonly paths: ReadonlyArray<string>
      readonly contradictions: ReadonlyArray<{ readonly path: string; readonly against: string }>
      /**
       * True when `HEAD` is the session's ref, so the shared index and working tree were moved to
       * the new commit before the ref was. False when the ref is not checked out and nothing
       * needed to follow.
       */
      readonly worktreeSynced: boolean
      /**
       * True when this call found the commit an earlier call had landed before it was killed (the
       * log still carried it as `pending`) and reports that commit instead of building one. The
       * contradictions of a recovered commit are not re-derived and come back empty.
       */
      readonly recovered: boolean
    }
  | {
      readonly kind: "rebase-needed"
      readonly overlapping: ReadonlyArray<string>
      readonly mainSha: string
    }
  | { readonly kind: "refused"; readonly violations: ReadonlyArray<Violation> }
  | {
      /**
       * `HEAD` is the session's ref and the checkout has uncommitted state (staged, modified, or
       * untracked) at a path this commit writes or removes, so the shared index could not follow
       * the ref. Nothing was committed; the caller cleans up or commits from another checkout.
       */
      readonly kind: "worktree-dirty"
      readonly paths: ReadonlyArray<string>
    }

/** The same cap the store applies to a commit subject (`packages/store/src/plumbing.ts`). */
export const COMMIT_SUBJECT_MAX = 72

/** The git trailer key carrying the session id. */
export const SESSION_TRAILER = "Memhtml-Session"

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim()

/** `memhtml(<scope>): <summary>`, one line, capped, never empty. */
export const commitSubject = (summary: string, scope: CommitScope = "session"): string => {
  const flat = oneLine(summary)
  const capped =
    flat.length <= COMMIT_SUBJECT_MAX ? flat : `${flat.slice(0, COMMIT_SUBJECT_MAX - 1).trim()}…`
  return `memhtml(${scope}): ${capped === "" ? "(untitled)" : capped}`
}

/** Subject, blank line, one trailer. The id is flattened so it cannot open a second trailer line. */
export const commitMessage = (
  summary: string,
  sessionId: string,
  scope: CommitScope = "session"
): string => `${commitSubject(summary, scope)}\n\n${SESSION_TRAILER}: ${oneLine(sessionId)}\n`

/**
 * The instant an archive op stamps, when the caller supplies none: whole seconds, because the
 * format's ISO rule (`packages/html` ISO_DATETIME) takes `YYYY-MM-DDThh:mm:ssZ` and nothing finer.
 * `Date.prototype.toISOString` carries milliseconds, and 2,170 records archived with that stamp on
 * 2026-09-24 were rejected by every reader, so the archive looked empty to search.
 */
const nowIso = (): string => `${new Date().toISOString().slice(0, 19)}Z`

/**
 * The archive body: `memhtml-status archived` and `memhtml-archived <instant>` stamped into the
 * head. `setMeta` splices head lines only, so the article bytes and the content hash are unchanged.
 */
export const archiveBody = (html: string, archivedAt: string): string =>
  setMeta(setMeta(html, "memhtml-status", "archived"), "memhtml-archived", archivedAt)

/** Which paths the ops stage and which they remove, applied in order over the head. */
interface StagedTree {
  readonly writes: Map<string, string>
  readonly removes: Set<string>
}

/**
 * Fold the ops into a set of writes and removes. A `link`, `unlink`, `label`, or `unlabel` reads the
 * file from an earlier op in the same batch when there is one, else from the head; a `move` removes
 * its source and writes the same bytes at its destination; an `archive` removes its source and writes its
 * destination with the archive stamps over the source AS THE COMMIT SEES IT (an earlier op in the
 * batch, else the head at the commit's parent), never over the bytes the op carries: those name
 * which article is meant (validateOps checks the hash), and a link the source gained since the op
 * was minted must travel with the archived copy.
 */
const stage = (head: HeadView, ops: ReadonlyArray<OverlayOp>, archivedAt: string): StagedTree => {
  const writes = new Map<string, string>()
  const removes = new Set<string>()
  for (const op of ops) {
    switch (op.kind) {
      case "put":
        writes.set(op.path, op.html)
        removes.delete(op.path)
        break
      case "archive": {
        // validateOps refused an archive whose source is neither in the head nor put earlier in the
        // batch, so the fallback to `op.html` is unreachable after step 1; it keeps the fold total.
        const source = writes.get(op.path) ?? head.get(op.path)?.html ?? op.html
        writes.delete(op.path)
        removes.add(op.path)
        writes.set(op.to, archiveBody(source, archivedAt))
        break
      }
      case "link": {
        const current = writes.get(op.path) ?? head.get(op.path)?.html
        // validateOps refused a link whose source is absent and a rel outside the vocabulary,
        // so both branches below are unreachable after step 1; they keep the fold total.
        if (current === undefined || !isEdgeRel(op.rel)) break
        writes.set(op.path, addLink(current, op.rel, op.href))
        break
      }
      case "unlink": {
        // The mirror of `link`: the file as the batch left it, with the one edge cut. An archive
        // built later in the batch reads `writes`, so it carries the removal.
        const current = writes.get(op.path) ?? head.get(op.path)?.html
        if (current === undefined || !isEdgeRel(op.rel)) break
        writes.set(op.path, removeLink(current, op.rel, op.href))
        break
      }
      case "label": {
        // The file as the batch left it, with one `memhtml-entity` line spliced in; an archive built
        // later in the batch reads `writes`, so the archived copy carries the label.
        const current = writes.get(op.path) ?? head.get(op.path)?.html
        if (current === undefined) break
        writes.set(op.path, addMeta(current, "memhtml-entity", op.entity))
        break
      }
      case "unlabel": {
        const current = writes.get(op.path) ?? head.get(op.path)?.html
        if (current === undefined) break
        writes.set(op.path, removeMeta(current, "memhtml-entity", op.entity))
        break
      }
      case "move": {
        // The source as the batch left it, written unchanged at its destination: no stamp, so the
        // blob, the content hash, and every meta travel with the record. The same unreachable
        // fallback to `op.html` as an archive's keeps the fold total.
        const source = writes.get(op.path) ?? head.get(op.path)?.html ?? op.html
        writes.delete(op.path)
        removes.add(op.path)
        writes.set(op.to, source)
        removes.delete(op.to)
        break
      }
    }
  }
  return { writes, removes }
}

/**
 * Step 3: a put whose claim shares a frame key with a different active path gets a
 * `memhtml-contradicts` link to that path. Both stay live; nothing is auto-archived.
 */
const markContradictions = (
  head: HeadView,
  ops: ReadonlyArray<OverlayOp>,
  writes: Map<string, string>
): Effect.Effect<ReadonlyArray<{ path: string; against: string }>> =>
  Effect.gen(function* () {
    const contradictions: Array<{ path: string; against: string }> = []
    // A rival this batch moves is linked at its destination, so the edge never names a path the
    // commit empties; one it archives is not linked at all.
    const movedTo = new Map<string, string>()
    const archiving = new Set<string>()
    for (const op of ops) {
      if (op.kind === "move") movedTo.set(op.path, op.to)
      else if (op.kind === "archive") archiving.add(op.path)
    }
    for (const op of ops) {
      if (op.kind !== "put") continue
      const html = writes.get(op.path)
      if (html === undefined) continue
      // Step 1 already parsed every put, so a failure here is a defect, not a violation.
      const doc = yield* parseMemory(html).pipe(Effect.orDie)
      const key = frameKeyOf(doc.article.gist)
      if (key === null) continue
      let linked = html
      for (const other of head.byFrameKey(key)) {
        if (other === op.path) continue
        const record = head.get(other)
        if (record === undefined || record.archived || archiving.has(other)) continue
        const against = movedTo.get(other) ?? other
        linked = addLink(linked, "contradicts", pathToHref(against))
        contradictions.push({ path: op.path, against })
      }
      writes.set(op.path, linked)
    }
    return contradictions
  })

const utf8 = new TextEncoder()

/**
 * How a commit gets its plumbing: called with the index file the staging calls use (a commit's own
 * temporary file), or `undefined` for the calls that stage nothing. The default is
 * `makePlumbing({ root, indexFile })`; a test wraps it to act at one exact step of the sequence (a v1
 * commit landing right after the checkout moved, a process dying right after it).
 */
export type PlumbingFactory = (indexFile: string | undefined) => Plumbing

/**
 * Run `use` with a plumbing that stages into a fresh index file of its own, in a directory under the
 * OS temp dir that is removed on every exit (success, failure, interruption). A session keeps no
 * index between calls: step 4 reads the parent's tree into this file, stages, and writes the tree,
 * so nothing a later call depends on lives in it. Outside the repository, so no cleanup of
 * `.memhtml/sessions/` can remove it while a commit is staging into it.
 */
const withTemporaryIndex = <A, E, R>(
  make: PlumbingFactory,
  use: (git: Plumbing) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | StorageFailure, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "memhtml-commit-index-")),
      catch: (cause) => cause
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logError(`session commit: no temporary index directory: ${String(cause)}`)
      ),
      Effect.mapError(() => StorageFailure.make({ operation: "session.index" }))
    ),
    (directory) => use(make(join(directory, "index"))),
    (directory) =>
      Effect.promise(() => rm(directory, { recursive: true, force: true }).catch(() => undefined))
  )

/** What {@link landOnRef} did. */
export type Landing =
  | {
      /** The ref moved to `to`; the checkout moved with it when `worktreeSynced`. */
      readonly kind: "landed"
      readonly worktreeSynced: boolean
    }
  | {
      /** The ref no longer named `expected`. Nothing moved; `tip` is what it names now. */
      readonly kind: "raced"
      readonly tip: string | null
    }
  | {
      /** `HEAD` is the ref and the checkout holds uncommitted state at these paths. Nothing moved. */
      readonly kind: "worktree-dirty"
      readonly paths: ReadonlyArray<string>
    }

/**
 * Move `ref` from `expected` to `to` with the checkout following, as one critical section under the
 * repository's checkout lock (`withCheckoutLock`), so no other writer of the shared index (a v1
 * store write in any process, another session's commit, a curate merge) runs between the checkout
 * moving and the ref moving:
 *
 * 1. The ref must still name `expected`; otherwise `raced` before anything is touched.
 * 2. When `HEAD` is the ref, a path in `paths` with uncommitted state is `worktree-dirty`; otherwise
 *    `read-tree -m -u from to` brings the shared index and working tree to `to` (a two-tree merge,
 *    so uncommitted edits at other paths survive) while the ref still names `from`.
 * 3. `update-ref ref to expected`, the compare-and-swap. `raced` (a writer that does not take the
 *    lock moved it) rolls the checkout back to `from`, and so does a git failure that left the ref
 *    where it was.
 *
 * The three steps are uninterruptible once the lock is held, so an interrupt cannot leave the
 * checkout one step ahead of a ref that never moved; only waiting for the lock can be interrupted.
 */
export const landOnRef = (input: {
  readonly root: string
  readonly git: Plumbing
  readonly ref: string
  /** What the ref must still name: the compare-and-swap's old value; `null` when it must not exist. */
  readonly expected: string | null
  /** The commit the checkout holds now: `expected`, or a new session's base when the ref is unborn. */
  readonly from: string
  readonly to: string
  /** The paths `from..to` changes; uncommitted state at any of them is `worktree-dirty`. */
  readonly paths: ReadonlyArray<string>
  readonly lock?: CheckoutLockOptions | undefined
}): Effect.Effect<Landing, GitFailure | StorageFailure> => {
  const { git, ref } = input
  const rollBack = (why: string) =>
    git
      .readTreeIntoWorktree(input.to, input.from)
      .pipe(Effect.catch(() => Effect.logWarning(`${ref}: checkout not rolled back after ${why}`)))
  return withCheckoutLock(
    input.root,
    Effect.uninterruptible(
      Effect.gen(function* () {
        const tip = yield* git.revParse(ref)
        if (tip !== input.expected) return { kind: "raced", tip } as const
        const checkedOut = (yield* git.headRef()) === ref
        if (checkedOut) {
          const dirty = yield* git.dirtyPaths(input.paths)
          if (dirty.length > 0) return { kind: "worktree-dirty", paths: dirty } as const
          yield* git.readTreeIntoWorktree(input.from, input.to)
        }
        const swapped = yield* git.updateRef(ref, input.to, input.expected).pipe(
          Effect.tapError(() =>
            checkedOut
              ? git.isAncestor(input.to, ref).pipe(
                  Effect.catch(() => Effect.succeed(false)),
                  Effect.flatMap((landed) => (landed ? Effect.void : rollBack("a failed swap")))
                )
              : Effect.void
          )
        )
        if (swapped === "raced") {
          if (checkedOut) yield* rollBack("a lost swap")
          return { kind: "raced", tip: yield* git.revParse(ref) } as const
        }
        return { kind: "landed", worktreeSynced: checkedOut } as const
      })
    ),
    input.lock
  )
}

/** The paths the ops touch that `from..to` changed: what a `rebase-needed` reports as `overlapping`. */
const overlappingPaths = (
  git: Plumbing,
  ops: ReadonlyArray<OverlayOp>,
  from: string,
  to: string
): Effect.Effect<ReadonlyArray<string>, GitFailure> =>
  git.diffTreePaths(from, to).pipe(
    Effect.map((changedPaths) => {
      const changed = new Set(changedPaths)
      return [...new Set(ops.flatMap(touchedPaths))].filter((path) => changed.has(path)).sort()
    })
  )

/**
 * The commit path, in order. The whole call holds the session's lock (`withSessionLock`), so two
 * commits of one id cannot interleave and a `session put` cannot rewrite the log mid-commit. Every
 * step that touches the shared checkout runs under the repository's checkout lock as well, which
 * every v1 store write holds from its first stage to its commit.
 *
 * 0. Recovery (`settlePending`, `settle.ts`). A log carrying `pending` names a commit an earlier
 *    call built and may have landed before it was killed. Reachable from the ref: answer `committed`
 *    for it with `recovered: true` and clear the log. Not reachable: undo whatever checkout update it
 *    made, drop `pending` from the log, and continue. Every append settles `pending` the same way
 *    before it writes (`appendOps`), so the ops a landed `pending` leaves are exactly the ones it
 *    committed, and clearing them loses nothing.
 * 1. `validateOps(head, ops, { scope })`; any violation is `refused` and writes nothing.
 * 2. The ref must be at the version that was validated. A ref that moved past `head.sha` is
 *    `rebase-needed` whether or not the changed paths overlap: duplicate hashes and frame keys are
 *    collisions between different paths, so a path-disjoint advance can still carry one, and only
 *    a head rebuilt at the tip can judge it. `overlapping` still names the path collisions.
 * 3. Frame-key contradictions, marked on the new file's head before hashing.
 * 4. Blobs, index, tree, commit object, through a temporary index file removed on every outcome.
 * 5. Write `pending: commit` to the log, BEFORE anything shared is touched: from here on a process
 *    killed at any instant leaves a log the next call settles in step 0.
 * 6. {@link landOnRef} under the checkout lock: the ref must still be at step 2's value (else
 *    `rebase-needed`); when `HEAD` is the ref, uncommitted state at a session path is
 *    `worktree-dirty`, else the checkout follows; then the compare-and-swap, whose loss rolls the
 *    checkout back and is `rebase-needed`. `worktree-dirty` and `rebase-needed` clear `pending`.
 *    The checkout follows before the ref moves because the reverse order would leave `HEAD` ahead of
 *    the index on any failure, and git then reports the session's own files as staged deletions
 *    that the next `git commit -a` or v1 write commits.
 * 7. Persist the log (base moved to the commit, ops empty, no pending) right after the swap.
 */
export const commitSession = (input: {
  readonly session: Session
  readonly head: HeadView & { readonly sha: string }
  readonly message: string
  /** The instant archive ops stamp; defaults to now. Explicit so a test can pin it. */
  readonly archivedAt?: string | undefined
  /**
   * The subject's scope and the validator's; `session` unless a curator run says otherwise. Under
   * `curate` the arcs and people prefixes are writable.
   */
  readonly scope?: CommitScope | undefined
  /** The validator's batch cap ({@link ValidateOptions}); `BATCH_CAP` unless a replay lifts it. */
  readonly batchCap?: number | undefined
  /**
   * The store's write bar ({@link ValidateOptions} `writeBar`), judged in step 1. The library
   * default when omitted, which refuses no type and anchors nothing, so a caller landing on a real
   * store passes the policy its `memhtml.config.json` states.
   */
  readonly writeBar?: WriteBarPolicy | undefined
  /** The plumbing; {@link PlumbingFactory}. A test seam: the default is the real git plumbing. */
  readonly plumbing?: PlumbingFactory | undefined
  /** The checkout lock's wait; 15 s unless a test shortens it. */
  readonly checkoutLock?: CheckoutLockOptions | undefined
}): Effect.Effect<CommitOutcome, GitFailure | StorageFailure> =>
  withSessionLock(
    input.session.root,
    input.session.id,
    Effect.gen(function* () {
      const { head } = input
      // The caller read the log before it took the lock (and usually loaded a head in between), so
      // an op appended meanwhile would be dropped by the empty log step 7 writes. Refused instead.
      yield* requireLogUnmoved(input.session)
      let session = input.session
      const root = session.root
      const make: PlumbingFactory =
        input.plumbing ?? ((indexFile) => makePlumbing({ root, indexFile }))
      const git = make(undefined)

      // 0. Recovery from a call killed after it wrote `pending`.
      if (session.pending !== undefined) {
        const pending = session.pending
        const settled = yield* settlePending({
          root,
          git,
          ref: session.ref,
          pending,
          lock: input.checkoutLock
        })
        if (settled.landed) {
          const parent = yield* git.revParse(`${pending}^`)
          const paths =
            parent === null ? [] : [...(yield* git.diffTreePaths(parent, pending))].sort()
          yield* saveSessionLocked({ ...session, baseSha: pending, ops: [], pending: undefined })
          return {
            kind: "committed",
            sha: pending,
            paths,
            contradictions: [],
            worktreeSynced: settled.worktreeSynced,
            recovered: true
          } as const
        }
        session = { ...session, pending: undefined }
        yield* saveSessionLocked(session)
      }

      // 1. Validate under the caller's scope. Any violation refuses the whole batch and writes
      //    nothing; a curator's scope is what lets an arcs or people path through here.
      const violations = validateOps(head, session.ops, {
        scope: input.scope ?? "session",
        writeBar: input.writeBar,
        ...(input.batchCap === undefined ? {} : { batchCap: input.batchCap })
      })
      if (violations.length > 0) return { kind: "refused", violations } as const

      // 2. The ref must be at the validated version.
      const mainSha = yield* git.revParse(session.ref)
      const parent = mainSha ?? head.sha
      if (mainSha !== null && mainSha !== head.sha) {
        const overlapping = yield* overlappingPaths(git, session.ops, head.sha, mainSha)
        return { kind: "rebase-needed", overlapping, mainSha } as const
      }

      // 3. Frame-key contradictions, marked on the new file's head before hashing.
      const staged = stage(head, session.ops, input.archivedAt ?? nowIso())
      const contradictions = yield* markContradictions(head, session.ops, staged.writes)

      // 4. Blobs, index, tree, commit, staged through a temporary index file. One child per step
      //    where git allows.
      const tree = yield* withTemporaryIndex(make, (index) =>
        Effect.gen(function* () {
          yield* index.readTree(parent)
          const entries: Array<{ mode: "100644"; sha: string; path: string }> = []
          for (const [path, html] of staged.writes) {
            const sha = yield* index.hashObjectWrite(utf8.encode(html))
            entries.push({ mode: "100644", sha, path })
          }
          yield* index.updateIndexRemove([...staged.removes])
          yield* index.updateIndexAdd(entries)
          return yield* index.writeTree()
        })
      )
      const commit = yield* git.commitTree(
        tree,
        [parent],
        commitMessage(input.message, session.id, input.scope)
      )
      const paths = [...new Set([...staged.writes.keys(), ...staged.removes])].sort()

      // 5. Intent, before anything shared is touched.
      yield* saveSessionLocked({ ...session, pending: commit })

      // 6. The checkout follows and the ref moves, as one section under the checkout lock.
      const landing = yield* landOnRef({
        root,
        git,
        ref: session.ref,
        expected: mainSha,
        from: parent,
        to: commit,
        paths,
        lock: input.checkoutLock
      }).pipe(
        // A lock that was never taken touched nothing, so the intent goes with it.
        Effect.tapError((error) =>
          error._tag === "StorageFailure" && error.operation === CHECKOUT_LOCKED
            ? saveSessionLocked({ ...session, pending: undefined }).pipe(Effect.ignore)
            : Effect.void
        )
      )
      if (landing.kind === "worktree-dirty") {
        yield* saveSessionLocked({ ...session, pending: undefined })
        return { kind: "worktree-dirty", paths: landing.paths } as const
      }
      if (landing.kind === "raced") {
        yield* saveSessionLocked({ ...session, pending: undefined })
        const moved = landing.tip ?? parent
        const overlapping =
          landing.tip === null ? [] : yield* overlappingPaths(git, session.ops, parent, moved)
        return { kind: "rebase-needed", overlapping, mainSha: moved } as const
      }

      // 7. The session now sits on the commit it made, with an empty log. The commit's
      //    `Memhtml-Session` trailer is its provenance; no ref is kept per session.
      yield* saveSessionLocked({ ...session, baseSha: commit, ops: [], pending: undefined })

      return {
        kind: "committed",
        sha: commit,
        paths,
        contradictions,
        worktreeSynced: landing.worktreeSynced,
        recovered: false
      } as const
    })
  )
