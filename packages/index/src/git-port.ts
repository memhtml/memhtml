import type { StorageFailure } from "@memhtml/contracts/errors"
import { Context, type Effect } from "effect"

/**
 * The indexer's view of git, as a port.
 *
 * Declared here rather than imported from `@memhtml/store` so the indexer depends on a shape and not
 * on an implementation. The production adapter is the store's git subprocess wrapper and a test
 * binds a temp-repo driver, and neither is named by the module that consumes them. The method names
 * match the plumbing the store exposes, so binding is structural.
 *
 * Every method is read-only. The indexer observes the tree and writing is the store's job. An index
 * that could commit would make "rebuildable from git" circular.
 */

/** One `git ls-tree -r` row. */
export interface TreeEntry {
  /** The blob's own sha. Equal to `git hash-object <file>`, which makes it the free change key. */
  readonly blobSha: string
  /** Repo-root-relative, no leading slash — the git-tree form, and the `files.path` primary key. */
  readonly path: string
}

/**
 * One `git diff --name-status -M` row.
 *
 * `R` carries `fromPath`. A rename is the archive move (probed: reported as `R100`), and handling it
 * as a rename rather than a delete-plus-add is what preserves `chunks`/`embeddings`. Those key on
 * `content_hash`, so a `git mv` costs zero Bedrock calls.
 */
export interface DiffEntry {
  readonly status: "A" | "M" | "D" | "R"
  readonly path: string
  readonly fromPath?: string | undefined
}

/** One `git status --porcelain=v2` row: an uncommitted change the working tree carries. */
export interface StatusEntry {
  readonly path: string
  /** True when the path is gone from the working tree. */
  readonly deleted: boolean
  /**
   * The source of a staged rename, carried so the indexer can retire the source row. A staged
   * `git mv` is one status entry whose `path` is the destination; without the source, the old row
   * stays active and the destination's projection collides with it on `files_content_hash_active`.
   */
  readonly fromPath?: string | undefined
}

export interface GitPort {
  /** The commit the working tree is on. */
  readonly revParseHead: () => Effect.Effect<string, StorageFailure>
  /** Every blob under the given path prefixes at `ref`, in one subprocess. */
  readonly lsTreeR: (
    ref: string,
    pathPrefixes: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<TreeEntry>, StorageFailure>
  /**
   * Blob contents by sha, streamed through one `git cat-file --batch` rather than N reads. One
   * subprocess for the whole tree, and it works on a bare or detached checkout where the files are
   * not on disk at all.
   */
  readonly catFileBatch: (
    shas: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, string>, StorageFailure>
  readonly diffNameStatus: (
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<DiffEntry>, StorageFailure>
  readonly statusPorcelainV2: () => Effect.Effect<ReadonlyArray<StatusEntry>, StorageFailure>
  /** The blob sha a working-tree file WOULD have. The dirty path's change key. */
  readonly hashObject: (path: string) => Effect.Effect<string, StorageFailure>
  /** A working-tree file's bytes as text. Used only for uncommitted paths. */
  readonly readWorkingFile: (path: string) => Effect.Effect<string, StorageFailure>
}

/**
 * The tag is `memhtml/IndexGit`. `@memhtml/store` already publishes `memhtml/Git` for its own
 * `GitShape`, and two different shapes under one tag would let a layer satisfy the wrong requirement
 * silently. `makeGitPort` in `git-adapter.ts` is the bridge between them.
 */
export const IndexGit = Context.Service<GitPort>("memhtml/IndexGit")
