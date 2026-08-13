import { Effect } from "effect"

import type { DiffEntry, GitPort, StatusEntry, TreeEntry } from "./git-port.js"

/**
 * The adapter from `@memhtml/store`'s `GitShape` to the indexer's {@link GitPort}.
 *
 * The two shapes are NOT structurally compatible, and this module is what gives the port real work
 * to do. Five differences, each of which would be a silent bug if the store's
 * service were passed where a `GitPort` is expected:
 *
 * 1. `revParseHead` returns `string | null`, the `null` being an unborn HEAD, which a freshly
 *    `git init`ed repo genuinely has. The indexer needs a commit, so that becomes a typed failure.
 * 2. `catFileBatch` yields `Uint8Array`, not `string`. Memory files are UTF-8 and the parser takes
 *    text, so the decode belongs at this boundary.
 * 3. `diffNameStatus` reports `kind: "added" | "modified" | ... | "renamed" | "copied"` with a
 *    `fromPath: string | null`; the port's `status` is the single letter and `fromPath` is optional.
 *    A `copied` entry maps to `A` and NOT to `R`: a copy's source still exists, so `R` would make the
 *    indexer move the source's row to the destination and drop a live file from the index.
 * 4. `statusPorcelainV2` reports a five-way `kind` plus a two-letter `xy` code. "Is this path gone
 *    from the worktree?" is `xy` containing `D`, and an `ignored` entry is not a change at all.
 * 5. Failures are `GitFailure { command, exitCode }`, and the port speaks `StorageFailure
 *    { operation }`, so the git command name is logged for the operator and never returned to an
 *    agent.
 *
 * The store owns none of this, because its shape is the right shape for a git client. Translating at
 * the consumer works here because the semantics are git's rather than the producer's private ones,
 * and both sides read them the same way.
 */

/** The subset of `@memhtml/store`'s `GitShape` the indexer consumes. Declared, not imported. */
export interface StoreGitShape {
  readonly revParseHead: () => Effect.Effect<string | null, unknown>
  readonly lsTreeR: (
    commitish: string,
    pathspecs?: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<StoreTreeEntry>, unknown>
  readonly catFileBatch: (
    shas: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, unknown>
  readonly diffNameStatus: (
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<StoreChangedPath>, unknown>
  readonly statusPorcelainV2: () => Effect.Effect<ReadonlyArray<StoreStatusEntry>, unknown>
  readonly hashObject: (path: string) => Effect.Effect<string, unknown>
}

export interface StoreTreeEntry {
  readonly objectType: string
  readonly sha: string
  readonly path: string
}

export interface StoreChangedPath {
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechanged"
  readonly path: string
  readonly fromPath: string | null
}

export interface StoreStatusEntry {
  readonly kind: "changed" | "renamed" | "unmerged" | "untracked" | "ignored"
  readonly path: string
  readonly xy: string
}

/** How the adapter reads a working-tree file and how it reports a refusal. */
export interface GitAdapterDeps {
  readonly git: StoreGitShape
  /**
   * Reads a repo-relative path as UTF-8 text. The CLI supplies one rooted at `MEMHTML_ROOT`.
   *
   * MUST report a missing or unreadable file through its ERROR channel, so `Effect.tryPromise` and
   * not `Effect.promise`. A defect propagates past `Effect.catch` and takes down the fiber, so an
   * absent path would crash the indexer instead of becoming the counted skip it is. An agent listing
   * a path it just archived is the normal case.
   */
  readonly readFile: (path: string) => Effect.Effect<string, unknown>
  /**
   * Builds the port's typed failure from an operation name. Injected so this module names no error
   * class of its own and the port's error type stays the caller's decision.
   */
  readonly fail: (operation: string) => Effect.Effect<never, never, never>
}

/**
 * One store change entry as a port entry. Total over the six kinds, and exported so the mapping is
 * assertable without a repository. The `copied` case would corrupt the index if it were folded in
 * with `renamed`, and it is awkward to provoke from real git.
 */
export const toDiffEntry = (change: StoreChangedPath): DiffEntry => {
  switch (change.kind) {
    case "added":
      return { status: "A", path: change.path }
    // A type change, such as a file becoming a symlink, is a content replacement as far as the
    // index is concerned. Re-project the path from whatever the new blob holds.
    case "modified":
    case "typechanged":
      return { status: "M", path: change.path }
    case "deleted":
      return { status: "D", path: change.path }
    case "renamed":
      // The archive move. `fromPath` is what lets the indexer re-point the row instead of deleting
      // it, which is what keeps the embedding. A rename reported with no source degrades to an add,
      // so the destination still gets indexed and nothing moves out from under an unknown path.
      return change.fromPath === null
        ? { status: "A", path: change.path }
        : { status: "R", path: change.path, fromPath: change.fromPath }
    case "copied":
      // NOT a rename. A copy's SOURCE still exists in the tree, so `R` would make the indexer move
      // the source's row to the destination and drop a live file from the index. `A` costs nothing,
      // because the destination's body is unchanged, so its content-derived `chunk_id`s already
      // carry vectors and the projection's upsert reuses them.
      return { status: "A", path: change.path }
  }
}

/**
 * One store status entry as zero or one port entries.
 *
 * `ignored` is not a change, and an `unmerged` path is mid-conflict. Indexing either side of an
 * unresolved merge would record a state the tree does not agree on yet, and the conflict is the
 * caller's to resolve.
 */
export const toStatusEntry = (entry: StoreStatusEntry): ReadonlyArray<StatusEntry> =>
  entry.kind === "ignored" || entry.kind === "unmerged"
    ? []
    : // `xy` is index-vs-HEAD and worktree-vs-index; a `D` in either position means the path is gone.
      [{ path: entry.path, deleted: entry.xy.includes("D") }]

/**
 * Map a store `GitShape` onto the indexer's port.
 *
 * `fail` translates every rejection to the port's error type after logging the git command, so a
 * subprocess's stderr never travels to an agent through a tool response. That stderr can contain a
 * path, a branch name, or a hunk.
 */
export const makeGitPort = (deps: GitAdapterDeps): GitPort => {
  /**
   * Translate one operation's rejection into the port's typed failure.
   *
   * `Effect.catchCause` rather than `Effect.catch`, because it catches a DEFECT as well as a typed
   * failure. A `readFile` wired with `Effect.promise` instead of `Effect.tryPromise` raises a defect
   * on ENOENT, and a defect passing through would kill the fiber, so a missing path would crash an
   * index update rather than become the counted skip the indexer already handles. Catching the cause
   * makes the port total whatever its dependencies do.
   */
  const attempt = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.tapCause((cause: unknown) =>
        Effect.logError(`git.${operation} failed: ${String(cause)}`)
      ),
      Effect.catchCause(() => deps.fail(operation))
    ) as Effect.Effect<A, never>

  return {
    /**
     * An unborn HEAD becomes a typed failure instead of `null`. Every indexer path needs a commit to
     * diff against or to read a tree from, and letting `null` through would make `git diff null
     * HEAD` the first place the problem surfaced, as an opaque subprocess error rather than "this
     * repo has no commits".
     */
    revParseHead: () =>
      attempt(
        "revParseHead",
        Effect.gen(function* () {
          const head = yield* deps.git.revParseHead()
          return head === null ? yield* Effect.fail("HEAD is unborn") : head
        })
      ),

    lsTreeR: (ref, pathPrefixes) =>
      attempt(
        "lsTreeR",
        deps.git.lsTreeR(ref, pathPrefixes).pipe(
          Effect.map((entries) =>
            entries.flatMap(
              (entry): ReadonlyArray<TreeEntry> =>
                // A submodule is a `commit` entry with no blob behind it, so `cat-file` would find
                // nothing for its sha. Dropping it here keeps the batch's shas all resolvable.
                entry.objectType === "blob" ? [{ blobSha: entry.sha, path: entry.path }] : []
            )
          )
        )
      ),

    catFileBatch: (shas) =>
      attempt(
        "catFileBatch",
        deps.git.catFileBatch(shas).pipe(
          Effect.map((blobs) => {
            const decoder = new TextDecoder("utf-8")
            const out = new Map<string, string>()
            for (const [sha, bytes] of blobs) out.set(sha, decoder.decode(bytes))
            return out as ReadonlyMap<string, string>
          })
        )
      ),

    diffNameStatus: (from, to) =>
      attempt(
        "diffNameStatus",
        deps.git.diffNameStatus(from, to).pipe(Effect.map((changes) => changes.map(toDiffEntry)))
      ),

    statusPorcelainV2: () =>
      attempt(
        "statusPorcelainV2",
        deps.git.statusPorcelainV2().pipe(Effect.map((entries) => entries.flatMap(toStatusEntry)))
      ),

    hashObject: (path) => attempt("hashObject", deps.git.hashObject(path)),
    readWorkingFile: (path) => attempt("readWorkingFile", deps.readFile(path))
  }
}
