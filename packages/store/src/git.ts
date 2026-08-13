import { execFile } from "node:child_process"
import { Context, Effect, Layer, Schema } from "effect"

import {
  type ChangedPath,
  parseCatFileBatch,
  parseDiffNameStatus,
  parseLsTree,
  parseStatusPorcelainV2,
  parseTrailerLog,
  type StatusEntry,
  TRAILER_FIELD_SEPARATOR,
  TRAILER_RECORD_SEPARATOR,
  type TrailerRecord,
  type TreeEntry
} from "./plumbing.js"

/**
 * Git as a service, over `node:child_process` and nothing else.
 *
 * No git library. The plumbing commands this uses have been stable for a decade and their
 * output formats are versioned by explicit flags (`-z`, `--porcelain=v2`, `--batch`). A
 * library wrapping them is a dependency whose own API is not stable, and which would have to
 * be audited for whether it shells out anyway. The parsing lives in `plumbing.ts` as pure
 * functions, so every format below is asserted against captured bytes rather than a live repo.
 */

/**
 * A git subprocess exited non-zero, or could not be spawned. `command` is the subcommand
 * name only, and never the full argv, because arguments carry memory paths and commit subjects
 * carry memory titles, and a `GitFailure` is returned to an agent through a tool response.
 * The stderr text goes to `Effect.logError` at the boundary below instead of into the payload.
 */
export class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  command: Schema.String,
  /** The process exit code, or `null` when the process never started. */
  exitCode: Schema.NullOr(Schema.Int)
}) {}

/** What {@link GitShape.commit} stamps below the subject line. */
export interface Trailers {
  readonly [key: string]: string
}

/** The result of a `commit` that had nothing staged. */
export interface CommitResult {
  /** The new commit's sha, or `null` when the index held no change and nothing was committed. */
  readonly sha: string | null
  /** True when the index was empty, so the call was a no-op rather than a commit. */
  readonly empty: boolean
}

export interface GitShape {
  /** The repository root every path in this service is relative to. */
  readonly root: string
  /** `HEAD`'s commit sha, or `null` in a repo with no commit yet. */
  readonly revParseHead: () => Effect.Effect<string | null, GitFailure>
  /** True when `root` is inside a git work tree with `root` as its top level. */
  readonly isRepo: () => Effect.Effect<boolean, GitFailure>
  /** Every blob in a commit's tree, recursively. One subprocess for the whole corpus. */
  readonly lsTreeR: (
    commitish: string,
    pathspecs?: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<TreeEntry>, GitFailure>
  /**
   * The contents of many blobs in ONE subprocess. The shas go in on stdin and the bodies come
   * back framed, so reading the whole tree costs one process instead of one per file. It also
   * works against a bare repo or a detached checkout, where `readFile` has nothing to read.
   */
  readonly catFileBatch: (
    shas: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, GitFailure>
  /** Per-path change between two commits, renames detected and reported as one entry. */
  readonly diffNameStatus: (
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<ChangedPath>, GitFailure>
  /** The working tree's dirty state, with both the index and worktree blob shas. */
  readonly statusPorcelainV2: () => Effect.Effect<ReadonlyArray<StatusEntry>, GitFailure>
  /** The blob sha a working-tree file would hash to. Equals its sha in the tree once committed. */
  readonly hashObject: (path: string) => Effect.Effect<string, GitFailure>
  readonly add: (paths: ReadonlyArray<string>) => Effect.Effect<void, GitFailure>
  /** `git mv`. The destination's parent directory must already exist, since git will not make it. */
  readonly mv: (from: string, to: string) => Effect.Effect<void, GitFailure>
  readonly commit: (
    message: string,
    options?: { readonly trailers?: Trailers | undefined }
  ) => Effect.Effect<CommitResult, GitFailure>
  readonly checkoutBranch: (
    branch: string,
    options?: { readonly create?: boolean | undefined }
  ) => Effect.Effect<void, GitFailure>
  readonly branchExists: (branch: string) => Effect.Effect<boolean, GitFailure>
  /** Fast-forward `HEAD` to `commitish`, or fail. This never creates a merge commit. */
  readonly mergeFastForward: (commitish: string) => Effect.Effect<void, GitFailure>
  /**
   * A three-way merge, whose conflict is a VALUE rather than a failure. Git exits 1 on a
   * content conflict, which is an ordinary outcome for two agents editing one file, and the
   * caller needs the conflicted paths to build its own typed error.
   */
  readonly merge: (commitish: string) => Effect.Effect<MergeOutcome, GitFailure>
  /** Abandon an in-progress merge, restoring the pre-merge index and worktree. */
  readonly mergeAbort: () => Effect.Effect<void, GitFailure>
  /**
   * The unmerged index stages of a conflict, so stage 1 base, 2 ours, 3 theirs, per path.
   * This is where `WriteConflict.ourSha`/`theirSha` come from.
   */
  readonly unmergedStages: () => Effect.Effect<ReadonlyArray<UnmergedStage>, GitFailure>
  /** One trailer key's values per commit in a range, newest first. Drives `sleep resume`. */
  readonly logTrailers: (
    range: string,
    key: string
  ) => Effect.Effect<ReadonlyArray<TrailerRecord>, GitFailure>
  /** Set a repository-local config value. */
  readonly setConfig: (key: string, value: string) => Effect.Effect<void, GitFailure>
  /** Run any subcommand. The escape hatch for a one-off; every routine call has a method. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, GitFailure>
}

/** One unmerged index entry. `stage` is git's own 1/2/3, meaning base, ours, theirs. */
export interface UnmergedStage {
  readonly path: string
  readonly stage: 1 | 2 | 3
  readonly sha: string
}

/** What a three-way merge did. `conflicted` is empty on a clean merge. */
export interface MergeOutcome {
  readonly merged: boolean
  readonly conflicted: ReadonlyArray<string>
}

export const Git = Context.Service<GitShape>("memhtml/Git")

/** A raw subprocess result, before a non-zero exit is turned into a failure. */
interface ProcessResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number | null
}

/**
 * Environment for every git call. The three `GIT_CONFIG_*` variables suppress any
 * `~/.gitconfig` alias, hook path, or template dir that would otherwise change what these
 * commands do on a developer's machine but not in CI. `GIT_TERMINAL_PROMPT=0` is what keeps a
 * credential prompt from hanging a headless indexer forever.
 */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C"
}

/** 64 MiB. A `cat-file --batch` over a whole corpus is the one call with a large stdout. */
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * Spawn git and collect its output as bytes.
 *
 * `stdout` stays a Buffer because `cat-file --batch` frames binary blob bodies with byte
 * lengths. Decoding to a string first would corrupt any non-UTF-8 content and would make
 * the frame lengths disagree with the string indices used to walk them.
 */
const spawnGit = (
  root: string,
  args: ReadonlyArray<string>,
  stdin?: string
): Effect.Effect<ProcessResult> =>
  Effect.callback<ProcessResult>((resume, signal) => {
    const child = execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "buffer", maxBuffer: MAX_BUFFER, env: { ...process.env, ...GIT_ENV }, signal },
      (error: (Error & { code?: unknown }) | null, stdout: Buffer, stderr: Buffer) => {
        resume(
          Effect.succeed({
            stdout,
            stderr: stderr.toString("utf8"),
            // execFile reports a signal kill or a spawn failure with a non-numeric `code`.
            // Both mean "no exit status", which the failure's `null` says exactly.
            exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null
          })
        )
      }
    )
    // stdin is closed unconditionally. `cat-file --batch` reads until EOF, so a child whose
    // stdin stayed open would never exit and the effect would never resume.
    //
    // The `error` listener is what keeps that from crashing the process. Every git command that
    // reads no stdin, which is all of them but `cat-file --batch`, usually exits before this
    // write lands, and writing to the closed pipe of an exited child raises EPIPE
    // asynchronously, with no `try` able to catch it. The exit status is the only outcome that
    // matters here, so a stdin write that loses the race is discarded rather than fatal.
    const input = child.stdin
    if (input !== null) {
      input.on("error", () => {})
      input.end(stdin ?? "")
    }
  })

/**
 * Run git and fail on a non-zero exit. `command` names the subcommand for the typed failure, and
 * `okExitCodes` widens the accepted set for the calls where non-zero is an answer rather than
 * an error (`rev-parse --verify --quiet` on an unborn HEAD, `merge` on a conflict).
 */
const git = (
  root: string,
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly stdin?: string | undefined
    readonly okExitCodes?: ReadonlyArray<number>
  } = {}
): Effect.Effect<ProcessResult, GitFailure> =>
  Effect.gen(function* () {
    const result = yield* spawnGit(root, args, options.stdin)
    const accepted = options.okExitCodes ?? [0]
    if (result.exitCode !== null && accepted.includes(result.exitCode)) return result
    yield* Effect.logError(
      `git ${command} exited ${String(result.exitCode)}: ${result.stderr.trim()}`
    )
    return yield* Effect.fail(GitFailure.make({ command, exitCode: result.exitCode }))
  }).pipe(Effect.withSpan(`git.${command}`))

/** Decoded stdout of a successful call. */
const text = (result: ProcessResult): string => result.stdout.toString("utf8")

/**
 * The service against a repository root. Exported rather than only wrapped in a layer, because every
 * test in this package drives the real git binary against a temp-dir repo. A fake git
 * verifies the shape of these calls and not git's own behaviour, and it is git's behaviour
 * (rename detection, index staging, merge conflict stages) that this package exists to use.
 */
export const makeGit = (root: string): GitShape => ({
  root,

  revParseHead: () =>
    git(root, "rev-parse", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      // Exit 1 with empty output is an unborn HEAD, a repo initialized but not yet committed.
      // That is a state `initRepo` legitimately observes rather than a failure.
      okExitCodes: [0, 1]
    }).pipe(
      Effect.map((result) => {
        const sha = text(result).trim()
        return sha === "" ? null : sha
      })
    ),

  isRepo: () =>
    git(root, "rev-parse", ["rev-parse", "--show-toplevel"], { okExitCodes: [0, 128] }).pipe(
      Effect.map((result) => result.exitCode === 0 && text(result).trim() !== "")
    ),

  lsTreeR: (commitish, pathspecs = []) =>
    git(root, "ls-tree", [
      "ls-tree",
      "-r",
      "--full-name",
      "-z",
      commitish,
      ...(pathspecs.length === 0 ? [] : ["--", ...pathspecs])
    ]).pipe(Effect.map((result) => parseLsTree(text(result)))),

  catFileBatch: (shas) =>
    shas.length === 0
      ? Effect.succeed(new Map())
      : git(root, "cat-file", ["cat-file", "--batch"], {
          stdin: `${shas.join("\n")}\n`
        }).pipe(Effect.map((result) => parseCatFileBatch(result.stdout))),

  diffNameStatus: (from, to) =>
    git(root, "diff", ["diff", "--name-status", "-M", "-z", from, to]).pipe(
      Effect.map((result) => parseDiffNameStatus(text(result)))
    ),

  statusPorcelainV2: () =>
    git(root, "status", ["status", "--porcelain=v2", "-z"]).pipe(
      Effect.map((result) => parseStatusPorcelainV2(text(result)))
    ),

  hashObject: (path) =>
    git(root, "hash-object", ["hash-object", "--", path]).pipe(
      Effect.map((result) => text(result).trim())
    ),

  add: (paths) =>
    paths.length === 0
      ? Effect.void
      : git(root, "add", ["add", "--", ...paths]).pipe(Effect.asVoid),

  mv: (from, to) => git(root, "mv", ["mv", "--", from, to]).pipe(Effect.asVoid),

  commit: (message, options = {}) =>
    Effect.gen(function* () {
      // `diff --cached --quiet` exits 1 when the index differs from HEAD. Asking first is what
      // makes a no-op write a no-op instead of an empty commit. `commit` with nothing staged
      // exits 1, and treating that as a failure would make every deduped write look broken.
      const staged = yield* git(root, "diff-cached", ["diff", "--cached", "--quiet"], {
        okExitCodes: [0, 1]
      })
      if (staged.exitCode === 0) return { sha: null, empty: true }

      const trailerArgs = Object.entries(options.trailers ?? {}).flatMap(([key, value]) =>
        value === "" ? [] : ["--trailer", `${key}: ${value}`]
      )
      yield* git(root, "commit", ["commit", "-m", message, ...trailerArgs])
      const sha = yield* git(root, "rev-parse", ["rev-parse", "HEAD"])
      return { sha: text(sha).trim(), empty: false }
    }),

  checkoutBranch: (branch, options = {}) =>
    git(root, "checkout", ["checkout", ...(options.create === true ? ["-b"] : []), branch]).pipe(
      Effect.asVoid
    ),

  branchExists: (branch) =>
    git(root, "show-ref", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      okExitCodes: [0, 1]
    }).pipe(Effect.map((result) => result.exitCode === 0)),

  mergeFastForward: (commitish) =>
    git(root, "merge-ff", ["merge", "--ff-only", commitish]).pipe(Effect.asVoid),

  merge: (commitish) =>
    Effect.gen(function* () {
      // Exit 1 is a conflict rather than an error. Git also uses 128 when it declines to start
      // (dirty tree, unborn HEAD), which stays a GitFailure.
      const result = yield* git(root, "merge", ["merge", "--no-edit", commitish], {
        okExitCodes: [0, 1]
      })
      if (result.exitCode === 0) return { merged: true, conflicted: [] }
      const unmerged = yield* git(root, "diff-u", ["diff", "--name-only", "--diff-filter=U", "-z"])
      return {
        merged: false,
        conflicted: text(unmerged)
          .split("\0")
          .filter((path) => path !== "")
      }
    }),

  mergeAbort: () => git(root, "merge-abort", ["merge", "--abort"]).pipe(Effect.asVoid),

  unmergedStages: () =>
    git(root, "ls-files", ["ls-files", "-u", "-z"]).pipe(
      Effect.map((result) => parseUnmergedStages(text(result)))
    ),

  logTrailers: (range, key) =>
    git(root, "log", [
      "log",
      `--format=${TRAILER_RECORD_SEPARATOR}%H${TRAILER_FIELD_SEPARATOR}%(trailers:key=${key},valueonly,separator=${TRAILER_FIELD_SEPARATOR})`,
      range
    ]).pipe(Effect.map((result) => parseTrailerLog(text(result)))),

  setConfig: (key, value) =>
    git(root, "config", ["config", "--local", key, value]).pipe(Effect.asVoid),

  run: (args) => git(root, args[0] ?? "run", args).pipe(Effect.map(text))
})

/**
 * `git ls-files -u -z` rows, shaped `<mode> <sha> <stage>\t<path>\0`. Kept here rather than in
 * `plumbing.ts` because the stage numbers are this module's own narrowing.
 */
const parseUnmergedStages = (output: string): ReadonlyArray<UnmergedStage> =>
  output
    .split("\0")
    .filter((row) => row !== "")
    .flatMap((row) => {
      const tab = row.indexOf("\t")
      if (tab === -1) return []
      const fields = row.slice(0, tab).split(" ")
      const stage = Number(fields[2])
      if (stage !== 1 && stage !== 2 && stage !== 3) return []
      const sha = fields[1]
      if (sha === undefined) return []
      return [{ path: row.slice(tab + 1), stage, sha }]
    })

/**
 * The live layer, rooted at a caller-supplied path. There is no `MEMHTML_ROOT` read here. The
 * root is config the store owns (`store.ts`), and a git service that resolved its own root
 * could not be pointed at a fixture repo or at a sleep worktree.
 */
export const layerGit = (root: string): Layer.Layer<GitShape> => Layer.succeed(Git)(makeGit(root))
