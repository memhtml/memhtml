import { execFile } from "node:child_process"
import { Effect } from "effect"

import { GitFailure } from "./errors.js"

/**
 * Git plumbing for one session, over `node:child_process` and nothing else.
 *
 * The session writes through its OWN index file, so two sessions on one repository never touch
 * each other's staging area and never touch the shared index a human's checkout uses. That is
 * exactly what the store's `Git` service cannot do: it scrubs `GIT_INDEX_FILE` from every child
 * (correctly, for its purpose), so this package spawns git itself and sets the variable per call.
 */

/** A raw subprocess result, before a non-zero exit is turned into a failure. */
interface ProcessResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number | null
}

/**
 * Fixed environment for every git call. `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from
 * hanging a headless process, `GIT_OPTIONAL_LOCKS=0` stops a read from taking the index lock, and
 * `LC_ALL=C` pins the message locale so the raced-ref classification reads the same words everywhere.
 */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C"
}

/**
 * The variables by which the environment, not `-C`, decides which repository a git call operates
 * on. Removed from every child for the reason the store removes them: a hook exports an absolute
 * `GIT_DIR` and a child would silently operate on the hook's repository. The same list as
 * `packages/store/src/git.ts` `GIT_REPO_SELECTION_ENV`, minus nothing: `GIT_INDEX_FILE` is scrubbed
 * here too and then set explicitly for the calls that stage into the session index.
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

/** `process.env` with {@link GIT_ENV} applied, every repo-selecting variable removed, then `extra`. */
const childEnv = (extra: Readonly<Record<string, string>>): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV }
  for (const name of GIT_REPO_SELECTION_ENV) delete env[name]
  return { ...env, ...extra }
}

/** 64 MiB, the same bound the store uses. */
const MAX_BUFFER = 64 * 1024 * 1024

/** The all-zero object name `update-ref` reads as "the ref must not exist yet". */
const ZERO_SHA = "0".repeat(40)

const spawnGit = (
  root: string,
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
  stdin?: Uint8Array | string
): Effect.Effect<ProcessResult> =>
  Effect.callback<ProcessResult>((resume, signal) => {
    const child = execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "buffer", maxBuffer: MAX_BUFFER, env, signal },
      (error: (Error & { code?: unknown }) | null, stdout: Buffer, stderr: Buffer) => {
        resume(
          Effect.succeed({
            stdout,
            stderr: stderr.toString("utf8"),
            exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null
          })
        )
      }
    )
    // stdin is closed unconditionally so a command that reads until EOF exits. A child that read
    // no stdin may already have exited, and a write to its closed pipe raises EPIPE asynchronously,
    // which only an `error` listener can absorb.
    const input = child.stdin
    if (input !== null) {
      input.on("error", () => {})
      input.end(stdin ?? "")
    }
  })

interface RunOptions {
  readonly stdin?: Uint8Array | string | undefined
  readonly okExitCodes?: ReadonlyArray<number> | undefined
}

/** A full 40-hex object name. */
const FULL_SHA = /^[0-9a-f]{40}$/

export interface Plumbing {
  /** `read-tree <sha>` into the session index file. */
  readTree(sha: string): Effect.Effect<void, GitFailure>
  /** `hash-object -w --stdin`; the blob sha. */
  hashObjectWrite(bytes: Uint8Array): Effect.Effect<string, GitFailure>
  /** `update-index --add --index-info`, one child for the whole batch. */
  updateIndexAdd(
    entries: ReadonlyArray<{ readonly mode: "100644"; readonly sha: string; readonly path: string }>
  ): Effect.Effect<void, GitFailure>
  /** `update-index --force-remove -z --stdin`, one child for the whole batch. */
  updateIndexRemove(paths: ReadonlyArray<string>): Effect.Effect<void, GitFailure>
  /** `write-tree` over the session index file; the tree sha. */
  writeTree(): Effect.Effect<string, GitFailure>
  /** `commit-tree`, message on stdin; the commit sha. */
  commitTree(
    tree: string,
    parents: ReadonlyArray<string>,
    message: string
  ): Effect.Effect<string, GitFailure>
  /**
   * `update-ref <ref> <next> <expected>` as a compare-and-swap. `expected: null` means the ref must
   * not exist. A non-zero exit whose stderr names the ref as locked or moved is `"raced"`; any other
   * non-zero exit is a `GitFailure`.
   */
  updateRef(
    ref: string,
    next: string,
    expected: string | null
  ): Effect.Effect<"updated" | "raced", GitFailure>
  /** The commit a ref resolves to, or `null` when it does not resolve. */
  revParse(ref: string): Effect.Effect<string | null, GitFailure>
  /** `diff-tree -r --name-only --no-renames -z from to`. */
  diffTreePaths(from: string, to: string): Effect.Effect<ReadonlyArray<string>, GitFailure>
  /** `read-tree -m -u from to` on the SHARED index, so the working tree follows a commit. */
  readTreeIntoWorktree(from: string, to: string): Effect.Effect<void, GitFailure>
  /** The branch `HEAD` points at (`refs/heads/...`), or `null` when detached. Shared index. */
  headRef(): Effect.Effect<string | null, GitFailure>
  /** `status --porcelain --untracked-files=no` over the shared index and working tree. */
  worktreeStatus(): Effect.Effect<string, GitFailure>
}

export const makePlumbing = (input: {
  readonly root: string
  readonly indexFile: string
}): Plumbing => {
  const { root, indexFile } = input
  const sessionEnv = childEnv({ GIT_INDEX_FILE: indexFile })
  const sharedEnv = childEnv({})

  const run = (
    env: Record<string, string | undefined>,
    command: string,
    args: ReadonlyArray<string>,
    options: RunOptions = {}
  ): Effect.Effect<ProcessResult, GitFailure> =>
    Effect.gen(function* () {
      const result = yield* spawnGit(root, args, env, options.stdin)
      const accepted = options.okExitCodes ?? [0]
      if (result.exitCode !== null && accepted.includes(result.exitCode)) return result
      yield* Effect.logError(
        `git ${command} exited ${String(result.exitCode)}: ${result.stderr.trim()}`
      )
      return yield* Effect.fail(GitFailure.make({ command, exitCode: result.exitCode }))
    }).pipe(Effect.withSpan(`session.git.${command}`))

  const text = (result: ProcessResult): string => result.stdout.toString("utf8")

  /** A sha on stdout, or a `GitFailure` when the output is not one (a truncated pipe). */
  const shaOf = (command: string, result: ProcessResult): Effect.Effect<string, GitFailure> => {
    const sha = text(result).trim()
    return FULL_SHA.test(sha)
      ? Effect.succeed(sha)
      : Effect.fail(GitFailure.make({ command, exitCode: result.exitCode }))
  }

  return {
    readTree: (sha) => run(sessionEnv, "read-tree", ["read-tree", sha]).pipe(Effect.asVoid),

    hashObjectWrite: (bytes) =>
      run(sessionEnv, "hash-object", ["hash-object", "-w", "--stdin"], { stdin: bytes }).pipe(
        Effect.flatMap((result) => shaOf("hash-object", result))
      ),

    updateIndexAdd: (entries) =>
      entries.length === 0
        ? Effect.void
        : run(sessionEnv, "update-index", ["update-index", "--add", "-z", "--index-info"], {
            // `-z` makes the record NUL-terminated so a path carrying a newline stays one path.
            stdin: entries.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}\0`).join("")
          }).pipe(Effect.asVoid),

    updateIndexRemove: (paths) =>
      paths.length === 0
        ? Effect.void
        : run(sessionEnv, "update-index", ["update-index", "--force-remove", "-z", "--stdin"], {
            stdin: paths.map((path) => `${path}\0`).join("")
          }).pipe(Effect.asVoid),

    writeTree: () =>
      run(sessionEnv, "write-tree", ["write-tree"]).pipe(
        Effect.flatMap((result) => shaOf("write-tree", result))
      ),

    commitTree: (tree, parents, message) =>
      run(
        sessionEnv,
        "commit-tree",
        ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
        { stdin: message.endsWith("\n") ? message : `${message}\n` }
      ).pipe(Effect.flatMap((result) => shaOf("commit-tree", result))),

    updateRef: (ref, next, expected) =>
      Effect.gen(function* () {
        const result = yield* spawnGit(
          root,
          ["update-ref", ref, next, expected ?? ZERO_SHA],
          sessionEnv
        )
        if (result.exitCode === 0) return "updated" as const
        // Probed git 2.50.1: a moved ref reports `cannot lock ref '<ref>': is at <sha> but expected
        // <sha>`; a create-only on an existing ref reports `cannot lock ref '<ref>': reference
        // already exists`. Both name the ref and both mean another writer got there first.
        if (result.stderr.includes(`'${ref}'`) && result.stderr.includes("cannot lock ref")) {
          return "raced" as const
        }
        yield* Effect.logError(
          `git update-ref exited ${String(result.exitCode)}: ${result.stderr.trim()}`
        )
        return yield* Effect.fail(
          GitFailure.make({ command: "update-ref", exitCode: result.exitCode })
        )
      }).pipe(Effect.withSpan("session.git.update-ref")),

    revParse: (ref) =>
      run(sessionEnv, "rev-parse", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        // Exit 1 with empty output is "does not resolve", an answer rather than a failure.
        okExitCodes: [0, 1]
      }).pipe(
        Effect.map((result) => {
          const sha = text(result).trim()
          return FULL_SHA.test(sha) ? sha : null
        })
      ),

    diffTreePaths: (from, to) =>
      run(sessionEnv, "diff-tree", [
        "diff-tree",
        "-r",
        "--name-only",
        "--no-renames",
        "-z",
        from,
        to
      ]).pipe(
        Effect.map((result) =>
          text(result)
            .split("\0")
            .filter((path) => path !== "")
        )
      ),

    readTreeIntoWorktree: (from, to) =>
      run(sharedEnv, "read-tree", ["read-tree", "-m", "-u", from, to]).pipe(Effect.asVoid),

    headRef: () =>
      run(sharedEnv, "symbolic-ref", ["symbolic-ref", "-q", "HEAD"], {
        // Exit 1 is a detached HEAD.
        okExitCodes: [0, 1]
      }).pipe(
        Effect.map((result) => {
          const ref = text(result).trim()
          return ref === "" ? null : ref
        })
      ),

    worktreeStatus: () =>
      run(sharedEnv, "status", ["status", "--porcelain", "--untracked-files=no"]).pipe(
        Effect.map(text)
      )
  }
}
