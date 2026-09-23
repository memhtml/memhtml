import { execFile } from "node:child_process"
import { mkdtempSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import { promisify } from "node:util"
import type { IFileSystem } from "just-bash"
import { InMemoryFs, MountableFs, OverlayFs } from "just-bash"

/**
 * The one composition that puts host directories inside a just-bash sandbox read-only.
 *
 * `memhtml exec` mounts the memory corpus so a sandboxed script can traverse it, and `session exec`
 * reuses the same shapes for its writable overlay. The module lives in `apps/cli` because that is where
 * `just-bash` is a real dependency (pinned in `package.json`).
 *
 * The facts below were first measured against just-bash 3.2.0 (2026-08-09). The ones that matter, EROFS
 * on write, symlinks not followed, the mountPoint spellings, nesting/trailing-slash refusals, the base
 * surviving, are re-proven against the INSTALLED just-bash on every run of `tests/mount.test.ts`, so a
 * behavior change in an upgrade fails there rather than aging in this comment.
 */

/**
 * One host directory and where it appears in the guest.
 *
 * There is deliberately NO way to set the overlay's own `mountPoint` from here. See
 * {@link mountReadOnlyRoots} for the measurement that makes that a footgun rather than an option.
 */
export interface ReadOnlyRoot {
  /** Absolute guest path, e.g. `/mnt/memhtml`. Never `/`, never nested inside another root's path. */
  readonly mountPath: string
  /** An existing directory on the host. Mounted read-only; nothing under it is ever written. */
  readonly hostPath: string
}

/**
 * The largest single file a mounted root will read, in bytes.
 *
 * `2**53-1`, the same value a read-write host filesystem binding uses. See {@link mountReadOnlyRoots}
 * for the measurement that makes an unset cap a correctness bug rather than a safety margin.
 */
export const MAX_MOUNTED_FILE_READ_BYTES = Number.MAX_SAFE_INTEGER

/** The composed filesystem, plus the roots that reached it in mount order. */
export interface MountedFilesystem {
  /** Hand this to `just-bash`'s `Bash`/`Sandbox`. */
  readonly filesystem: IFileSystem
  readonly roots: ReadonlyArray<ReadOnlyRoot>
}

/** A root declaration this composition cannot honor. Carries the reason, never a file's content. */
export class SandboxMountInvalid extends Error {
  override readonly name = "SandboxMountInvalid"
}

/**
 * Why a set of roots cannot be mounted, or `null`.
 *
 * Pure except for `statSync` on each host path, and separate from {@link mountReadOnlyRoots} for one
 * reason: a caller that can name its roots before building a sandbox calls this first and fails there,
 * with a reason naming the root, instead of inside the filesystem constructor with no mention of the
 * mount it belongs to.
 *
 * The rules, in the order a caller trips them:
 *
 * - `mountPath` must be absolute, already normalized, and free of a trailing slash.
 *   `MountableFs.mount` rejects `.`/`..` segments itself, but it silently normalizes a relative path,
 *   a doubled separator, and a trailing slash. The declared path and the effective mount would then
 *   differ, so a typo would mount somewhere other than where it reads. Note `/mnt/memhtml/`
 *   survives `path.normalize` unchanged (probed), so the trailing slash needs its own check.
 * - `mountPath` may not be `/` and may not nest inside another root's path. `MountableFs` throws on
 *   both ("Cannot mount at root '/'", "Cannot mount at 'X': inside existing mount 'Y'", probed),
 *   which this restates as one typed reason naming both paths.
 * - `hostPath` must be an existing DIRECTORY. `OverlayFs`'s constructor does check this eagerly
 *   ("OverlayFs root does not exist" / "is not a directory", probed), which is the one gotcha that
 *   was already handled upstream; it is repeated here so one call answers for every root instead of
 *   throwing on the first bad one with no mention of the mount it belongs to.
 */
export const readOnlyRootsProblem = (roots: ReadonlyArray<ReadOnlyRoot>): string | null => {
  const claimed: string[] = []
  for (const root of roots) {
    const { mountPath, hostPath } = root
    if (mountPath === "/") {
      return 'mount path "/" is not mountable: the base filesystem owns the root'
    }
    if (
      !mountPath.startsWith("/") ||
      mountPath.endsWith("/") ||
      normalize(mountPath) !== mountPath
    ) {
      return `mount path ${JSON.stringify(mountPath)} must be an absolute, normalized guest path`
    }
    for (const taken of claimed) {
      if (taken === mountPath) return `mount path ${mountPath} is declared twice`
      if (mountPath.startsWith(`${taken}/`) || taken.startsWith(`${mountPath}/`)) {
        return `mount paths ${taken} and ${mountPath} nest, which MountableFs refuses`
      }
    }
    claimed.push(mountPath)

    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(hostPath)
    } catch (cause) {
      return `host path ${hostPath} for mount ${mountPath} is unreadable: ${String(cause)}`
    }
    if (!stats.isDirectory()) {
      return `host path ${hostPath} for mount ${mountPath} is not a directory`
    }
  }
  return null
}

/**
 * Compose a filesystem with each host root mounted read-only at its guest path.
 *
 * ## `mountPoint: "/"` on the nested overlay decides which paths resolve, and a file count cannot say
 *
 * `MountableFs` routes a path to a mount by stripping the mount prefix and handing the REMAINDER to
 * the mounted filesystem (`routePath` in just-bash's bundle), while `OverlayFs` applies its own
 * `mountPoint`, default `/home/user/project`, to whatever it is handed. So the two prefixes
 * compose, and all three spellings resolve a real file at a DIFFERENT path. Re-probed 2026-08-09
 * against a two-file fixture, mounting at `/mnt/memhtml`:
 *
 * | overlay `mountPoint` | path that reads the file |
 * | --- | --- |
 * | `"/"` | `/mnt/memhtml/sub/a.txt` (intended) |
 * | omitted | `/mnt/memhtml/home/user/project/sub/a.txt` |
 * | `"/mnt/memhtml"` | `/mnt/memhtml/mnt/memhtml/sub/a.txt` |
 *
 * **Every variant reports the same file count**, so a census assertion cannot tell them apart; only
 * reading a path does. That is why `mountPoint` is not on {@link ReadOnlyRoot} at all. The option
 * has exactly one correct value under a `MountableFs`, and offering it would be offering two ways to
 * get a filesystem that looks populated and answers no path a caller would write.
 *
 * ## What read-only means here, measured rather than assumed
 *
 * `readOnly: true` is enforced rather than advisory: a write through the composed filesystem throws
 * `EROFS: read-only file system`, and through `Bash` the command throws the same. `..` traversal out
 * of a mount and an absolute `/etc/hostname` both fail, because the overlay resolves a guest path
 * against its own root and returns nothing outside it. And `allowSymlinks` defaults to FALSE, so a
 * symlink under a mounted root is not followed: any real path traversing one is rejected. That is the
 * safe direction, and it costs reachability. `~/.claude/skills/*` holds symlinks to directories
 * outside the trace root, and those read as absent inside the sandbox.
 *
 * ## The base filesystem stays writable
 *
 * `base` is whatever the caller already owns; every unmounted path routes to it, so a caller's
 * `/workspace`, `/tmp`, and home directory survive, and mounting only under `/mnt/*` is what preserves
 * them. The default is an `InMemoryFs`, which is what a standalone caller wants and what `MountableFs`
 * would have defaulted to anyway.
 *
 * ## The read cap has to be set, or a large transcript reads as a MISSING FILE
 *
 * `OverlayFs` caps a single read at `maxFileReadSize`, default 10 MB, and over that it throws
 * `EFBIG`. just-bash's commands do not pass that code through: measured 2026-09-03 against the
 * installed 3.4.2, `grep -c -F needle` on an 11.5 MB transcript answered
 * `No such file or directory` while `ls -la` on the same path printed its 11553767 bytes. With the
 * cap raised, the same command returned its count in 357 ms.
 *
 * That is worse than a bounded read, because a script reads a file it cannot open as a file that is
 * not there, so every file past 10 MB was silently unreadable and looked absent. So the cap is stated
 * here, at `2**53-1`: these mounts are read-only host directories, and the bound that matters is the
 * script's wall clock, not a file size.
 *
 * @throws {SandboxMountInvalid} when {@link readOnlyRootsProblem} rejects the roots.
 */
export const mountReadOnlyRoots = (input: {
  readonly roots: ReadonlyArray<ReadOnlyRoot>
  readonly base?: IFileSystem | undefined
}): MountedFilesystem => {
  const problem = readOnlyRootsProblem(input.roots)
  if (problem !== null) throw new SandboxMountInvalid(problem)

  const filesystem = new MountableFs({ base: input.base ?? new InMemoryFs() })
  for (const root of input.roots) {
    filesystem.mount(
      root.mountPath,
      new OverlayFs({
        root: root.hostPath,
        mountPoint: "/",
        readOnly: true,
        maxFileReadSize: MAX_MOUNTED_FILE_READ_BYTES
      })
    )
  }
  return { filesystem, roots: [...input.roots] }
}

/**
 * The temp directory prefix a pinned snapshot lives under, named once so the `mkdtemp` and the sweep
 * that reclaims an orphan cannot drift.
 *
 * Exported because the test tier counts entries under it: {@link pinCorpusSnapshot} is reached on the
 * `memhtml exec` path, where a SIGKILL leaves the mkdtemp parent behind with no finalizer able to reach
 * it, and a census over the prefix is how a leak on the clean path is caught.
 */
export const CORPUS_SNAPSHOT_TMPDIR_PREFIX = "memhtml-corpus-snapshot-"

/** A materialized commit, and how to remove it. */
export interface CorpusSnapshot {
  /** The detached worktree's directory, suitable as a {@link ReadOnlyRoot} `hostPath`. */
  readonly hostPath: string
  /** Removes the worktree and its administrative entry. Safe to call twice. */
  readonly release: () => Promise<void>
}

const run = promisify(execFile)

/**
 * The variables by which the environment, not `-C`, decides which repository a git call operates
 * on. Removed from every git spawn here for the reason `packages/store/src/git.ts` records at its
 * own `GIT_REPO_SELECTION_ENV`: git exports an absolute `GIT_DIR` into hook processes run from a
 * linked worktree, and a snapshot call inheriting it would `worktree add` against the HOOK's
 * repository rather than the corpus named by `-C`. The store does not export the list, so it is
 * restated here; `tests/mount.test.ts` pins the two spellings to each other.
 */
export const GIT_REPO_SELECTION_ENV: ReadonlyArray<string> = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES"
]

/** `process.env` with every repo-selecting variable removed, for the two `git worktree` calls. */
const gitChildEnv = (): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of GIT_REPO_SELECTION_ENV) delete env[name]
  return env
}

/**
 * Materialize one commit of a repository as a directory, for mounting.
 *
 * **The live working tree is not a snapshot of anything.** Another process can check out a branch or
 * commit onto it while a script runs, so the directory a script would mount mutates underneath it. A
 * script that read the corpus "as it is" could read a corpus edited seconds earlier and report a state
 * no reviewer can reproduce. `git worktree add --detach` at the pinned sha is the tree the report names,
 * which makes "what the script saw" and "what the report says" the same tree by construction rather
 * than by timing.
 *
 * `--detach` and not a branch: a named branch would be a second ref on a sha the run already tracks,
 * and `git worktree remove` of a branch-carrying worktree leaves the branch behind.
 */
export const pinCorpusSnapshot = async (input: {
  readonly repoRoot: string
  readonly sha: string
}): Promise<CorpusSnapshot> => {
  const parent = mkdtempSync(join(tmpdir(), CORPUS_SNAPSHOT_TMPDIR_PREFIX))
  const hostPath = join(parent, "tree")
  await run("git", ["-C", input.repoRoot, "worktree", "add", "--detach", hostPath, input.sha], {
    env: gitChildEnv()
  })

  let released = false
  return {
    hostPath,
    release: async () => {
      if (released) return
      released = true
      // `--force` because the mount is read-only but the worktree is a real directory a reader may
      // have left something in; a refusal here would leak a worktree entry into the repo's config.
      await run("git", ["-C", input.repoRoot, "worktree", "remove", "--force", hostPath], {
        env: gitChildEnv()
      }).catch(() => {})
      /**
       * The mkdtemp PARENT is this function's to remove, and it is a second step because `git worktree
       * remove` deletes only the tree it was handed. Releasing without it leaves one empty
       * `${CORPUS_SNAPSHOT_TMPDIR_PREFIX}*` directory per `memhtml exec` on the CLEAN path, where
       * nothing failed and nothing looks wrong. Unconditional on the git call's outcome: a worktree
       * that could not be removed is a stale administrative entry `git worktree prune` reclaims, and
       * keeping the directory around does not fix it.
       */
      await rm(parent, { recursive: true, force: true }).catch(() => {})
    }
  }
}
