import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { isEdgeRel, pathToHref, type StorageFailure } from "@memhtml/contracts"
import { frameKeyOf } from "@memhtml/domain"
import { addLink, parseMemory, setMeta } from "@memhtml/html"
import { Effect } from "effect"

import type { GitFailure } from "./errors.js"
import {
  plumbingFor,
  type Session,
  saveSessionLocked,
  sessionRef,
  withSessionLock
} from "./session.js"
import { type CommitScope, touchedPaths, type Violation, validateOps } from "./validate.js"

export type { CommitScope } from "./validate.js"

/**
 * The commit path. Mechanical, no model call: validate, check disjointness against the ref,
 * check frame-key conflicts, write blobs, write a tree, commit, compare-and-swap the ref.
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

/** The instant an archive op stamps, when the caller supplies none. */
const nowIso = (): string => new Date().toISOString()

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
 * Fold the ops into a set of writes and removes. A `link` reads the file from an earlier `put` in the
 * same batch when there is one, else from the head; an `archive` removes its source and writes its
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
        if (record === undefined || record.archived) continue
        linked = addLink(linked, "contradicts", pathToHref(other))
        contradictions.push({ path: op.path, against: other })
      }
      writes.set(op.path, linked)
    }
    return contradictions
  })

const utf8 = new TextEncoder()

/** Move the provenance ref to `commit`, creating it or advancing it; a failure is logged, not raised. */
const recordProvenance = (
  git: ReturnType<typeof plumbingFor>,
  id: string,
  commit: string
): Effect.Effect<void> =>
  git.updateRef(sessionRef(id), commit, null).pipe(
    Effect.flatMap((outcome) =>
      outcome === "raced"
        ? git
            .revParse(sessionRef(id))
            .pipe(Effect.flatMap((old) => git.updateRef(sessionRef(id), commit, old)))
        : Effect.succeed(outcome)
    ),
    Effect.asVoid,
    // The commit is on the ref already; a provenance ref that did not move is an operator's note,
    // not a reason to tell the caller the commit failed.
    Effect.catch((failure) =>
      Effect.logWarning(
        `session ${id}: provenance ref not updated (git ${failure.command} exited ${String(failure.exitCode)})`
      )
    )
  )

/**
 * The commit path, in order. The whole call holds the session's lock, so two commits of one id
 * cannot interleave on the shared `.idx`, and a `session put` cannot rewrite the log mid-commit.
 *
 * 0. Recovery. A log carrying `pending` names a commit an earlier call built and may have landed
 *    before it was killed. Reachable from the ref: it landed, so answer `committed` for it and clear
 *    the log. Not reachable: roll the checkout back if it had followed, drop `pending`, continue.
 * 1. `validateOps(head, ops, { scope })`; any violation is `refused` and writes nothing.
 * 2. The ref must be at the version that was validated. A ref that moved past `head.sha` is
 *    `rebase-needed` whether or not the changed paths overlap: duplicate hashes and frame keys are
 *    collisions between different paths, so a path-disjoint advance can still carry one, and only
 *    a head rebuilt at the tip can judge it. `overlapping` still names the path collisions.
 * 3. Frame-key contradictions, marked on the new file's head before hashing.
 * 4. Blobs, index, tree, commit object, through the session's own index file.
 * 5. When `HEAD` is the session's ref, the checkout follows FIRST: a session path with uncommitted
 *    state is `worktree-dirty` and nothing moves; otherwise `read-tree -m -u parent commit` brings
 *    the shared index and working tree to the new tree while the ref still names the parent. A
 *    checkout left one step ahead by a failure here shows the session's files as staged additions,
 *    which the next commit of this session reverts (step 0) and no human commit can turn into a loss.
 *    The reverse order (ref first) would leave `HEAD` ahead of the index on any failure, and git
 *    then reports the session's own files as deletions that the next `git commit -a` or v1 write
 *    commits.
 * 6. Write `pending: commit` to the log, then compare-and-swap the ref. `raced` rolls the checkout
 *    back and is `rebase-needed` with the ref's new value.
 * 7. Persist the log (base moved to the commit, ops empty, no pending) right after the swap, then
 *    record provenance under `refs/memhtml/sessions/<id>` as a best effort.
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
}): Effect.Effect<CommitOutcome, GitFailure | StorageFailure> =>
  withSessionLock(
    input.session.root,
    input.session.id,
    Effect.gen(function* () {
      const { head } = input
      let session = input.session
      const git = plumbingFor(session.root, session.id)
      const checkedOut = (yield* git.headRef()) === session.ref

      // 0. Recovery from a call killed between the swap and the log write.
      if (session.pending !== undefined) {
        const pending = session.pending
        if (yield* git.isAncestor(pending, session.ref)) {
          const parent = yield* git.revParse(`${pending}^`)
          const paths =
            parent === null ? [] : [...(yield* git.diffTreePaths(parent, pending))].sort()
          yield* saveSessionLocked({ ...session, baseSha: pending, ops: [], pending: undefined })
          yield* recordProvenance(git, session.id, pending)
          return {
            kind: "committed",
            sha: pending,
            paths,
            contradictions: [],
            worktreeSynced: checkedOut,
            recovered: true
          } as const
        }
        if (checkedOut) {
          const parent = yield* git.revParse(`${pending}^`)
          if (parent !== null) {
            yield* git
              .readTreeIntoWorktree(pending, parent)
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning(`session ${session.id}: checkout not rolled back`)
                )
              )
          }
        }
        session = { ...session, pending: undefined }
      }

      // 1. Validate under the caller's scope. Any violation refuses the whole batch and writes
      //    nothing; a curator's scope is what lets an arcs or people path through here.
      const violations = validateOps(head, session.ops, { scope: input.scope ?? "session" })
      if (violations.length > 0) return { kind: "refused", violations } as const

      // 2. The ref must be at the validated version.
      const mainSha = yield* git.revParse(session.ref)
      const parent = mainSha ?? head.sha
      if (mainSha !== null && mainSha !== head.sha) {
        const changed = new Set(yield* git.diffTreePaths(head.sha, mainSha))
        const touched = new Set(session.ops.flatMap(touchedPaths))
        const overlapping = [...touched].filter((path) => changed.has(path)).sort()
        return { kind: "rebase-needed", overlapping, mainSha } as const
      }

      // 3. Frame-key contradictions, marked on the new file's head before hashing.
      const staged = stage(head, session.ops, input.archivedAt ?? nowIso())
      const contradictions = yield* markContradictions(head, session.ops, staged.writes)

      // 4. Blobs, index, tree, commit. One child per step where git allows.
      yield* git.readTree(parent)
      const entries: Array<{ mode: "100644"; sha: string; path: string }> = []
      for (const [path, html] of staged.writes) {
        const sha = yield* git.hashObjectWrite(utf8.encode(html))
        entries.push({ mode: "100644", sha, path })
      }
      yield* git.updateIndexRemove([...staged.removes])
      yield* git.updateIndexAdd(entries)
      const tree = yield* git.writeTree()
      const commit = yield* git.commitTree(
        tree,
        [parent],
        commitMessage(input.message, session.id, input.scope)
      )
      const paths = [...new Set([...staged.writes.keys(), ...staged.removes])].sort()

      // 5. The checkout follows before the ref moves.
      if (checkedOut) {
        const dirty = yield* git.dirtyPaths(paths)
        if (dirty.length > 0) return { kind: "worktree-dirty", paths: dirty } as const
        yield* git.readTreeIntoWorktree(parent, commit)
      }

      // 6. Intent, then compare-and-swap. A race means someone advanced between step 2 and now.
      yield* saveSessionLocked({ ...session, pending: commit })
      const swapped = yield* git.updateRef(session.ref, commit, mainSha)
      if (swapped === "raced") {
        if (checkedOut) {
          yield* git
            .readTreeIntoWorktree(commit, parent)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning(`session ${session.id}: checkout not rolled back`)
              )
            )
        }
        yield* saveSessionLocked({ ...session, pending: undefined })
        const moved = yield* git.revParse(session.ref)
        return { kind: "rebase-needed", overlapping: [], mainSha: moved ?? parent } as const
      }

      // 7. The session now sits on the commit it made, with an empty log; then provenance.
      yield* saveSessionLocked({ ...session, baseSha: commit, ops: [], pending: undefined })
      yield* recordProvenance(git, session.id, commit)

      return {
        kind: "committed",
        sha: commit,
        paths,
        contradictions,
        worktreeSynced: checkedOut,
        recovered: false
      } as const
    })
  )
