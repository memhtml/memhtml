import { execFile } from "node:child_process"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import { promisify } from "node:util"
import type { IFileSystem } from "just-bash"
import { InMemoryFs, MountableFs, OverlayFs } from "just-bash"

/**
 * The one composition that puts host directories inside a just-bash sandbox read-only.
 *
 * Two consumers need the SAME shape and it is built once here: this app's consolidator, which
 * mounts the transcript root so the agent reads transcripts off a filesystem, and `memhtml exec`, which
 * mounts the memory corpus so a sandboxed script can traverse it. The module lives in
 * `apps/consolidator` because that is where `just-bash` is a real dependency, pinned to 3.2.0,
 * the version eve 0.33.0 loads through its own optional-package path
 * (node_modules/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js). `memhtml exec` imports it
 * from `@memhtml/consolidator`.
 *
 * Every fact below was measured against just-bash 3.2.0 on 2026-08-09, re-probing the 2026-08
 * spike's findings rather than citing them.
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

/** The composed filesystem, plus the roots that reached it in mount order. */
export interface MountedFilesystem {
  /** Hand this to `just-bash`'s `Bash`/`Sandbox`, or return it from eve's `filesystem` factory. */
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
 * reason: **eve does NOT invoke the `filesystem` factory during template prewarming**
 * (node_modules/eve/dist/src/public/sandbox/just-bash-sandbox.d.ts, `filesystem`), so a bad root
 * would otherwise surface on the first live session, inside a spawned server, wrapped by eve as
 * "Failed to create the custom just-bash filesystem", after a sleep run already committed earlier
 * phases. A caller that can name its roots before spawning calls this first and fails there.
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
 * `base` is whatever the caller already owns; every unmounted path routes to it. For eve that is
 * `defaultFilesystem` from the `filesystem` factory, which owns `/workspace`, `/tmp`, and the home
 * directory. eve's contract requires those to survive
 * (node_modules/eve/dist/src/public/sandbox/just-bash-sandbox.d.ts) and mounting only under `/mnt/*`
 * is what preserves them. The default is an `InMemoryFs`, which is what a standalone caller wants
 * and what `MountableFs` would have defaulted to anyway.
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
      new OverlayFs({ root: root.hostPath, mountPoint: "/", readOnly: true })
    )
  }
  return { filesystem, roots: [...input.roots] }
}

/**
 * The variable a spawning process uses to tell a sandbox process what to mount.
 *
 * The `filesystem` factory runs inside the eve SERVER, and the roots are decided by the CLIENT that
 * spawned it. Those are two processes, so the roots have to cross a process boundary, and the spawn
 * environment is the only channel eve's CLI leaves open. One variable rather than one per root, so
 * the order and the pairing survive: a `MEMHTML_SANDBOX_TRACE_ROOT`-style set of variables cannot express
 * "these three, in this order" and would need a new variable per consumer.
 */
export const SANDBOX_MOUNTS_ENV = "MEMHTML_SANDBOX_MOUNTS"

/** Render roots for {@link SANDBOX_MOUNTS_ENV}. Validated first, so a spawn cannot carry a bad root. */
export const encodeSandboxMounts = (roots: ReadonlyArray<ReadOnlyRoot>): string => {
  const problem = readOnlyRootsProblem(roots)
  if (problem !== null) throw new SandboxMountInvalid(problem)
  return JSON.stringify(
    roots.map((root) => ({ mountPath: root.mountPath, hostPath: root.hostPath }))
  )
}

/**
 * Read roots back out of an environment. An absent or empty variable means no mounts, not an error.
 *
 * A MALFORMED variable throws, and the two cases are split for a reason: absent is the normal case
 * for a sandbox with nothing to mount, while a variable that is present and unparseable means the
 * spawner meant to mount something and this process would silently run without it. A sandbox that
 * quietly lost its corpus answers questions about an empty corpus, which reads as a finding.
 *
 * @throws {SandboxMountInvalid} when the value is present and not a valid root array.
 */
export const decodeSandboxMounts = (
  env: Record<string, string | undefined>
): ReadonlyArray<ReadOnlyRoot> => {
  const raw = env[SANDBOX_MOUNTS_ENV]
  if (raw === undefined || raw.trim() === "") return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new SandboxMountInvalid(`${SANDBOX_MOUNTS_ENV} is not valid JSON: ${String(cause)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new SandboxMountInvalid(`${SANDBOX_MOUNTS_ENV} must hold an array of roots`)
  }

  const roots: ReadOnlyRoot[] = []
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      throw new SandboxMountInvalid(`${SANDBOX_MOUNTS_ENV} holds a non-object entry`)
    }
    const { mountPath, hostPath } = entry as Record<string, unknown>
    if (typeof mountPath !== "string" || typeof hostPath !== "string") {
      throw new SandboxMountInvalid(
        `${SANDBOX_MOUNTS_ENV} entries need string mountPath and hostPath`
      )
    }
    roots.push({ mountPath, hostPath })
  }

  const problem = readOnlyRootsProblem(roots)
  if (problem !== null) throw new SandboxMountInvalid(`${SANDBOX_MOUNTS_ENV}: ${problem}`)
  return roots
}

/** A materialized commit, and how to remove it. */
export interface CorpusSnapshot {
  /** The detached worktree's directory, suitable as a {@link ReadOnlyRoot} `hostPath`. */
  readonly hostPath: string
  /** Removes the worktree and its administrative entry. Safe to call twice. */
  readonly release: () => Promise<void>
}

const run = promisify(execFile)

/**
 * Materialize one commit of a repository as a directory, for mounting.
 *
 * **A sleep run's live working tree is not a snapshot of anything.** `packages/sleep/src/run.ts:96`
 * checks out the run's own branch before any phase executes, and earlier phases commit onto it, so
 * the directory a later phase would mount mutates underneath it. A consolidation that read the
 * corpus "as it is" would be reading a corpus its own siblings edited seconds earlier, and would
 * report a state no reviewer can reproduce. `git worktree add --detach` at the run's `baseSha` is
 * the tree the reviewer diffs against, which makes "what the agent saw" and "what the review shows"
 * the same tree by construction rather than by timing.
 *
 * `--detach` and not a branch: a named branch would be a second ref on a sha the run already tracks,
 * and `git worktree remove` of a branch-carrying worktree leaves the branch behind.
 */
export const pinCorpusSnapshot = async (input: {
  readonly repoRoot: string
  readonly sha: string
}): Promise<CorpusSnapshot> => {
  const parent = mkdtempSync(join(tmpdir(), "memhtml-corpus-snapshot-"))
  const hostPath = join(parent, "tree")
  await run("git", ["-C", input.repoRoot, "worktree", "add", "--detach", hostPath, input.sha])

  let released = false
  return {
    hostPath,
    release: async () => {
      if (released) return
      released = true
      // `--force` because the mount is read-only but the worktree is a real directory a reader may
      // have left something in; a refusal here would leak a worktree entry into the repo's config.
      await run("git", ["-C", input.repoRoot, "worktree", "remove", "--force", hostPath]).catch(
        () => {}
      )
    }
  }
}
