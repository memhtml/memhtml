import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { isEdgeRel, pathToHref, type StorageFailure } from "@memhtml/contracts"
import { frameKeyOf } from "@memhtml/domain"
import { addLink, parseMemory, setMeta } from "@memhtml/html"
import { Effect } from "effect"

import type { GitFailure } from "./errors.js"
import { plumbingFor, type Session, saveSession, sessionRef } from "./session.js"
import { touchedPaths, type Violation, validateOps } from "./validate.js"

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
      /** True when the shared index and working tree were moved to the new commit. */
      readonly worktreeSynced: boolean
    }
  | {
      readonly kind: "rebase-needed"
      readonly overlapping: ReadonlyArray<string>
      readonly mainSha: string
    }
  | { readonly kind: "refused"; readonly violations: ReadonlyArray<Violation> }

/** The same cap the store applies to a commit subject (`packages/store/src/plumbing.ts`). */
export const COMMIT_SUBJECT_MAX = 72

/** The git trailer key carrying the session id. */
export const SESSION_TRAILER = "Memhtml-Session"

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim()

/** `memhtml(session): <summary>`, one line, capped, never empty. */
export const commitSubject = (summary: string): string => {
  const flat = oneLine(summary)
  const capped =
    flat.length <= COMMIT_SUBJECT_MAX ? flat : `${flat.slice(0, COMMIT_SUBJECT_MAX - 1).trim()}…`
  return `memhtml(session): ${capped === "" ? "(untitled)" : capped}`
}

/** Subject, blank line, one trailer. The id is flattened so it cannot open a second trailer line. */
export const commitMessage = (summary: string, sessionId: string): string =>
  `${commitSubject(summary)}\n\n${SESSION_TRAILER}: ${oneLine(sessionId)}\n`

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
 * destination with the archive stamps.
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
      case "archive":
        writes.delete(op.path)
        removes.add(op.path)
        writes.set(op.to, archiveBody(op.html, archivedAt))
        break
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

export const commitSession = (input: {
  readonly session: Session
  readonly head: HeadView & { readonly sha: string }
  readonly message: string
  readonly syncWorktree?: boolean | undefined
  /** The instant archive ops stamp; defaults to now. Explicit so a test can pin it. */
  readonly archivedAt?: string | undefined
}): Effect.Effect<CommitOutcome, GitFailure | StorageFailure> =>
  Effect.gen(function* () {
    const { session, head } = input
    const git = plumbingFor(session.root, session.id)

    // 1. Validate. Any violation refuses the whole batch and writes nothing.
    const violations = validateOps(head, session.ops)
    if (violations.length > 0) return { kind: "refused", violations } as const

    // 2. Disjointness against the ref. A disjoint advance continues on top of it.
    const mainSha = yield* git.revParse(session.ref)
    const parent = mainSha ?? session.baseSha
    if (mainSha !== null && mainSha !== session.baseSha) {
      const changed = new Set(yield* git.diffTreePaths(session.baseSha, mainSha))
      const touched = new Set(session.ops.flatMap(touchedPaths))
      const overlapping = [...touched].filter((path) => changed.has(path)).sort()
      if (overlapping.length > 0) return { kind: "rebase-needed", overlapping, mainSha } as const
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
    const commit = yield* git.commitTree(tree, [parent], commitMessage(input.message, session.id))

    // 6 (precondition, read before the ref moves): the working tree follows only when HEAD is the
    // session's ref and the shared index and working tree match it. After the swap, HEAD names the
    // new commit while the shared index still holds `parent`, so `status` would read as dirty.
    const worktreeEligible =
      input.syncWorktree === true &&
      (yield* git.headRef()) === session.ref &&
      (yield* git.worktreeStatus()).trim() === ""

    // 5. Compare-and-swap the ref. A race means someone advanced between step 2 and now.
    const swapped = yield* git.updateRef(session.ref, commit, mainSha)
    if (swapped === "raced") {
      const moved = yield* git.revParse(session.ref)
      return { kind: "rebase-needed", overlapping: [], mainSha: moved ?? parent } as const
    }
    yield* git.updateRef(sessionRef(session.id), commit, null).pipe(
      // A second commit from the same id moves its provenance ref forward.
      Effect.flatMap((outcome) =>
        outcome === "raced"
          ? git
              .revParse(sessionRef(session.id))
              .pipe(Effect.flatMap((old) => git.updateRef(sessionRef(session.id), commit, old)))
          : Effect.succeed(outcome)
      )
    )

    // 6. Follow with the working tree when eligible. A failure here leaves the commit in place
    // and is reported as "not synced" rather than failing an outcome that already landed.
    const worktreeSynced = worktreeEligible
      ? yield* git.readTreeIntoWorktree(parent, commit).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false))
        )
      : false

    // The session now sits on the commit it made, with an empty log.
    yield* saveSession({ ...session, baseSha: commit, ops: [] })

    const paths = [...new Set([...staged.writes.keys(), ...staged.removes])].sort()
    return { kind: "committed", sha: commit, paths, contradictions, worktreeSynced } as const
  })
