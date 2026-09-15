/**
 * The disk primitives every installer step stands on: hash, read, atomic write, snapshot, restore.
 *
 * Plain async functions over `node:fs/promises`, deliberately outside the Effect graph. The transaction
 * layer above wraps them once; keeping them total and dependency-free means the rollback path — the one
 * path that runs while something is already wrong — has no layer to build and nothing to fail on.
 *
 * Two rules are encoded here rather than left to callers. Every write goes to a temp sibling and lands
 * with `rename`, so a config file a host is reading is never half a file. And every path an install is
 * about to touch is walked component by component: a symlink anywhere in it is refused, because an
 * installer that follows one writes into a place the operator never named.
 */

import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises"
import { dirname, join, parse as parsePath, resolve, sep } from "node:path"

/** The mode bits `stat` reports that are worth preserving: setuid/setgid/sticky plus rwx. */
const MODE_BITS = 0o7777

/** Hex SHA-256 of `text` as UTF-8. Every receipt claim and every drift check is this one function. */
export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code
      : undefined
    : undefined

/**
 * The file's text, or `null` when it does not exist. Any other failure — a directory in the way, a
 * permission error — throws, because "unreadable" and "absent" lead to different installer decisions.
 */
export const readTextOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
}

const statOrNull = async (path: string) => {
  try {
    return await stat(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
}

const lstatOrNull = async (path: string) => {
  try {
    return await lstat(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
}

/**
 * Write `text` to `path` so a concurrent reader sees either the old file or the new one: parent
 * directories are created, the bytes go to a temp sibling, and `rename` publishes them.
 *
 * The temp file is a sibling rather than a `$TMPDIR` entry on purpose — `rename` across filesystems
 * fails with `EXDEV`, and `~/.claude.json` and `/tmp` are routinely on different ones.
 *
 * With `mode` omitted an existing file's permission bits carry over, which matters for the shell rc
 * files and any config an operator has deliberately tightened. `chmod` happens on the temp file before
 * the rename, so the mode is never briefly wrong at the real path, and it is set explicitly rather than
 * through `writeFile`'s `mode` option because that one is masked by the process umask.
 */
export const writeTextAtomic = async (path: string, text: string, mode?: number): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const existing = mode === undefined ? await statOrNull(path) : null
  const effective = mode ?? (existing === null ? undefined : existing.mode & MODE_BITS)
  const temp = `${path}.memhtml-${process.pid.toString(36)}-${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temp, text, "utf8")
    if (effective !== undefined) await chmod(temp, effective)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** What a file looked like before install touched it. `text: null` records "there was no file". */
export interface TextSnapshot {
  readonly path: string
  readonly text: string | null
  readonly mode: number | null
}

/** Capture `path`'s bytes and permission bits, or the fact that it does not exist. */
export const snapshotText = async (path: string): Promise<TextSnapshot> => {
  const text = await readTextOrNull(path)
  if (text === null) return { path, text: null, mode: null }
  const info = await statOrNull(path)
  return { path, text, mode: info === null ? null : info.mode & MODE_BITS }
}

/**
 * Put `path` back exactly as `snapshotText` found it. A snapshot of an absent file removes whatever is
 * there now, so a rolled-back install leaves no file it created — the case that makes a failed install
 * indistinguishable from one that never ran.
 */
export const restoreText = async (snapshot: TextSnapshot): Promise<void> => {
  if (snapshot.text === null) {
    await rm(snapshot.path, { force: true })
    return
  }
  if (snapshot.mode === null) {
    await writeTextAtomic(snapshot.path, snapshot.text)
    return
  }
  await writeTextAtomic(snapshot.path, snapshot.text, snapshot.mode)
}

/** True when `path` resolves to a directory. A missing path is `false`, not an error. */
export const isDirectory = async (path: string): Promise<boolean> => {
  const info = await statOrNull(path)
  return info?.isDirectory() ?? false
}

/**
 * True when something exists at `path`. `lstat`, so a dangling symlink counts as existing — install
 * must treat a broken link as an obstacle rather than as free space.
 */
export const exists = async (path: string): Promise<boolean> => (await lstatOrNull(path)) !== null

/** `path` with every symlink resolved, or `path` itself when it cannot be resolved (it may not exist). */
export const realpathOrSelf = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Refuse `path` when any component that already exists is a symlink.
 *
 * Walking stops at the first component that does not exist, because nothing below a missing directory
 * exists either. The rule is openwiki's, learned the hard way: an installer must never follow a symlink
 * into a place it did not intend to write — a `~/.claude` linked into a dotfiles repo turns a config
 * edit into a commit in someone else's tree.
 */
export const assertNoSymlinkComponents = async (path: string): Promise<void> => {
  const absolute = resolve(path)
  const { root } = parsePath(absolute)
  const segments = absolute
    .slice(root.length)
    .split(sep)
    .filter((part) => part.length > 0)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    const info = await lstatOrNull(current)
    if (info === null) return
    if (info.isSymbolicLink()) {
      throw new Error(`refusing to write through the symlink at ${current} (in ${absolute})`)
    }
  }
}

/**
 * `~` and `~/…` resolved against `home`. Nothing else is expanded: `$VAR` and `~other` are left alone,
 * since a config value that looks like a shell expression is not one by the time this package sees it.
 */
export const expandHome = (path: string, home: string): string => {
  if (path === "~") return home
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(home, path.slice(2))
  return path
}
