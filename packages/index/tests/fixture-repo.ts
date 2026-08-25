import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"

import type { DiffEntry, GitPort, StatusEntry, TreeEntry } from "../src/git-port.js"

/**
 * A real temp-dir git repository plus a real {@link GitPort} over it.
 *
 * Local to this package because `@memhtml/store` has not shipped its `@memhtml/store/testing` fixture
 * builder yet, and importing an unshipped subpath would couple this task's green suite to a sibling's
 * in-progress files. When that helper lands, this becomes the second implementation of the same port
 * and the tests bind to either — which is the point of the port being a shape rather than an import.
 *
 * Every method here is the actual git plumbing, run as a subprocess against a real repository. The
 * alternative — a stateless fake returning canned tree entries — would verify the SHAPE of the calls
 * and not the driver's behavior, and the fleet has paid six times for that distinction: a rename
 * reported as `R100`, a `-z` field order, a status line's dual hashes are all facts about git, not
 * about this code.
 */

const run = promisify(execFile)

/** A memory file to seed. `html` is the whole document. */
export interface SeedFile {
  readonly path: string
  readonly html: string
}

export interface FixtureRepo {
  readonly root: string
  readonly git: GitPort
  /** Write files and commit them. Returns the new HEAD. */
  readonly commit: (files: ReadonlyArray<SeedFile>, message: string) => Promise<string>
  /** Write files WITHOUT committing, so `status --porcelain=v2` reports them. */
  readonly writeDirty: (files: ReadonlyArray<SeedFile>) => Promise<void>
  /** `git mv` plus a commit — the archive move, which `diff -M` reports as `R100`. */
  readonly move: (from: string, to: string, message: string) => Promise<string>
  /**
   * `git mv` WITHOUT a commit, so `status --porcelain=v2` reports one `2 R.` record.
   *
   * That record names only the destination; the source arrives as its own NUL field. An indexer that
   * sees the destination alone leaves the source row live, and the destination's projection then
   * collides with it on `files_content_hash_active`.
   */
  readonly moveStaged: (from: string, to: string) => Promise<void>
  readonly remove: (path: string, message: string) => Promise<string>
  readonly head: () => Promise<string>
  /** Raw plumbing, for a test that needs to assert on git's own output. */
  readonly raw: (...args: ReadonlyArray<string>) => Promise<string>
  readonly cleanup: () => Promise<void>
}

/** A repo with `user.name`/`user.email` set, so commits work with no ambient git config. */
export const makeFixtureRepo = async (): Promise<FixtureRepo> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-index-fixture-"))
  const raw = async (...args: ReadonlyArray<string>): Promise<string> => {
    const { stdout } = await run("git", [...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }

  await raw("init", "--initial-branch=main")
  await raw("config", "user.name", "Fixture")
  await raw("config", "user.email", "fixture@example.invalid")
  await raw("config", "commit.gpgsign", "false")

  const write = async (files: ReadonlyArray<SeedFile>) => {
    for (const file of files) {
      const full = join(root, file.path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, file.html, "utf8")
    }
  }

  const commit = async (files: ReadonlyArray<SeedFile>, message: string) => {
    await write(files)
    await raw("add", "-A")
    await raw("commit", "-m", message)
    return (await raw("rev-parse", "HEAD")).trim()
  }

  return {
    root,
    git: makeFixtureGit(root, raw),
    commit,
    writeDirty: write,
    move: async (from, to, message) => {
      await mkdir(dirname(join(root, to)), { recursive: true })
      await raw("mv", from, to)
      await raw("commit", "-m", message)
      return (await raw("rev-parse", "HEAD")).trim()
    },
    moveStaged: async (from, to) => {
      await mkdir(dirname(join(root, to)), { recursive: true })
      await raw("mv", from, to)
    },
    remove: async (path, message) => {
      await raw("rm", path)
      await raw("commit", "-m", message)
      return (await raw("rev-parse", "HEAD")).trim()
    },
    head: async () => (await raw("rev-parse", "HEAD")).trim(),
    raw,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

/** Wrap a rejected subprocess as the port's typed failure, keeping stderr for the operator only. */
const attempt = <A>(operation: string, thunk: () => Promise<A>) =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) => Effect.logError(`git.${operation} failed: ${String(cause)}`)),
    Effect.mapError(() => StorageFailure.make({ operation: `git.${operation}` }))
  )

/**
 * The real {@link GitPort} over a real repository.
 *
 * `-z` everywhere a path is parsed. A memory filename comes from a slugified title, so it is
 * `[a-z0-9-]` today — but git's default output quotes and escapes non-ASCII paths, and a parser that
 * split on newlines would silently mangle one the day a path stops being ASCII. NUL-delimited output
 * has no escaping at all.
 */
const makeFixtureGit = (
  root: string,
  raw: (...args: ReadonlyArray<string>) => Promise<string>
): GitPort => ({
  revParseHead: () => attempt("revParseHead", async () => (await raw("rev-parse", "HEAD")).trim()),

  lsTreeR: (ref, pathPrefixes) =>
    attempt("lsTreeR", async () => {
      const stdout = await raw("ls-tree", "-r", "-z", "--full-name", ref, "--", ...pathPrefixes)
      return stdout
        .split("\0")
        .filter((line) => line !== "")
        .flatMap((line): ReadonlyArray<TreeEntry> => {
          // "<mode> <type> <sha>\t<path>"
          const tab = line.indexOf("\t")
          if (tab === -1) return []
          const fields = line.slice(0, tab).split(" ")
          const blobSha = fields[2]
          if (fields[1] !== "blob" || blobSha === undefined) return []
          return [{ blobSha, path: line.slice(tab + 1) }]
        })
    }),

  /**
   * One `git cat-file --batch` for the whole set: shas on stdin, `<sha> blob <size>\n<bytes>\n` back.
   * The size header is authoritative — a memory's own bytes may contain a newline, so the reader
   * consumes exactly `size` bytes rather than scanning for a terminator.
   */
  catFileBatch: (shas) =>
    attempt("catFileBatch", async () => {
      const blobs = new Map<string, string>()
      const unique = [...new Set(shas)]
      if (unique.length === 0) return blobs

      const stdout = await new Promise<Buffer>((resolve, reject) => {
        const child = execFile(
          "git",
          ["cat-file", "--batch"],
          { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
          (error, out) => (error === null ? resolve(out) : reject(error))
        )
        child.stdin?.end(`${unique.join("\n")}\n`)
      })

      let at = 0
      while (at < stdout.length) {
        const newline = stdout.indexOf(0x0a, at)
        if (newline === -1) break
        const header = stdout.subarray(at, newline).toString("utf8")
        at = newline + 1
        const [sha, type, sizeText] = header.split(" ")
        const size = Number(sizeText)
        if (sha === undefined || type !== "blob" || !Number.isFinite(size)) continue
        blobs.set(sha, stdout.subarray(at, at + size).toString("utf8"))
        at += size + 1
      }
      return blobs
    }),

  /**
   * `-M` is what makes the archive move a rename. Without it the same commit reads as a delete plus
   * an add, and the delete cascades away the embedding the rename exists to preserve.
   */
  diffNameStatus: (from, to) =>
    attempt("diffNameStatus", async () => {
      const stdout = await raw("diff", "--name-status", "-M", "-z", from, to)
      const fields = stdout.split("\0").filter((field) => field !== "")
      const entries: Array<DiffEntry> = []
      let at = 0
      while (at < fields.length) {
        const code = fields[at]
        if (code === undefined) break
        // A rename's status carries a similarity score ("R100") and TWO following path fields.
        if (code.startsWith("R") || code.startsWith("C")) {
          const fromPath = fields[at + 1]
          const path = fields[at + 2]
          if (fromPath !== undefined && path !== undefined)
            entries.push({ status: "R", path, fromPath })
          at += 3
          continue
        }
        const path = fields[at + 1]
        if (path !== undefined && (code === "A" || code === "M" || code === "D")) {
          entries.push({ status: code, path })
        }
        at += 2
      }
      return entries
    }),

  /**
   * `--porcelain=v2 -z`: `1 <XY> ... <path>` for a tracked change, `? <path>` for an untracked file,
   * and `2 <XY> ... <X><score> <path>\0<origPath>\0` for a rename. The `XY` pair is the index and
   * worktree status; `D` in either position means the path is gone, which is how an uncommitted
   * archive or delete is distinguished from an edit.
   *
   * A rename's ORIGINAL path is its own NUL field, and that is the trap: a reader that takes one
   * field per record consumes the next record's data as this one's path, and a reader that ignores
   * the field entirely reports the destination with no source. A `2 ` record also carries one MORE
   * space-delimited field than a `1 ` record — the `R<score>` — so the path starts one field later.
   */
  statusPorcelainV2: () =>
    attempt("statusPorcelainV2", async () => {
      const stdout = await raw("status", "--porcelain=v2", "-z", "--untracked-files=all")
      const records = stdout.split("\0").filter((record) => record !== "")
      const entries: Array<StatusEntry> = []
      let at = 0
      while (at < records.length) {
        const record = records[at] ?? ""
        at += 1
        if (record.startsWith("? ")) {
          entries.push({ path: record.slice(2), deleted: false })
          continue
        }
        const renamed = record.startsWith("2 ")
        if (!record.startsWith("1 ") && !renamed) continue
        const fields = record.split(" ")
        const xy = fields[1] ?? ""
        const path = fields.slice(renamed ? 9 : 8).join(" ")
        if (!renamed) {
          if (path !== "") entries.push({ path, deleted: xy.includes("D") })
          continue
        }
        // Consumed here whether or not the entry is kept, so the loop stays aligned.
        const fromPath = records[at]
        at += 1
        if (path === "" || fromPath === undefined) continue
        entries.push({ path, deleted: xy.includes("D"), fromPath })
      }
      return entries
    }),

  hashObject: (path) => attempt("hashObject", async () => (await raw("hash-object", path)).trim()),

  readWorkingFile: (path) => attempt("readWorkingFile", () => readFile(join(root, path), "utf8"))
})
