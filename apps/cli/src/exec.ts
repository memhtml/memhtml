import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { InvalidMemory, StorageFailure } from "@memhtml/contracts/errors"
import { type GitFailure, makeGit } from "@memhtml/store"
import { Effect, type Scope } from "effect"

import { type Failure, fail } from "./envelope.js"

/**
 * `memhtml exec`, the code-mode runtime: an agent-supplied script, a read-only corpus, one envelope.
 *
 * ROADMAP item 7 is the requirement. A multi-hop traversal written as code answers in one execution
 * what the tool path answers in one round trip per hop, and the closed vocabulary is what makes the
 * tree queryable without a new surface per question. Measured in the 2026-08 spike and
 * re-probed here on 2026-08-09: a 305-file
 * census in 598ms, and an edge walk resolving 410/410 edges into 201 chains, the longest 8 hops, in one
 * execution at 430ms.
 *
 * **Structural and lexical planes only. No index handle.** That is the division item 7 itself draws.
 * `memhtml search` finds entry points, code traverses from there, and a script needing ranked retrieval
 * shells out to `memhtml search` and consumes its envelope. Nothing here opens `index.db`, so CODE-2's
 * index half is satisfied by there being no handle to guard rather than by a guard. If one is ever
 * added, `scripts/probe-sqlite-concurrency.mjs` measures what a second process can do to a live store.
 *
 * **Read-only by contract.** Every write still goes through `memhtml apply` / `memory_write*`, so the
 * one-commit-per-op, dedup, and conflict machinery cannot be bypassed. The mount enforces it, since
 * `readOnly: true` on the `OverlayFs` answers `EROFS`, and this module offers no write path at all.
 */

/** Where the corpus appears in the guest. Matches `ROOT` in `apps/cli/guest/corpus.mjs`. */
export const CORPUS_MOUNT = "/mnt/memhtml"

/** Where the seeded modules live. `/workspace` is writable; the corpus mount is not. */
const GUEST_LIB = "/workspace/lib"
const GUEST_SCRIPT = "/workspace/script.mjs"

/**
 * The default wall-clock bound on the script, in milliseconds.
 *
 * 30s, which is `maxJsTimeoutMs`'s own default in just-bash 3.2.0 (`dist/limits.d.ts:83`). It is named
 * here rather than inherited so the value appears in `memhtml manifest` and in `AGENTS.md`, where an
 * agent budgeting a call can read it. The measured work is far below it: the whole 305-file corpus
 * parses in 640ms, so 30s is roughly 45x the cost of a full-corpus pass.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The bound is capped, and the cap is what makes a runaway script terminate.
 *
 * `maxJsTimeoutMs` is the only thing standing between a runaway guest loop and a `memhtml exec` that
 * never returns. The guest is a QuickJS worker with no host-side reaper of its own, and an unbounded
 * script would hold the CLI process open indefinitely. Probed 2026-08-09 with `maxJsTimeoutMs: 700`
 * against `for(;;){n++}`: exit 124 at 724ms, "js-exec: Execution timeout: exceeded 700ms limit".
 */
export const MAX_TIMEOUT_MS = 600_000

/**
 * How much looser the shell's bound is than the script's, so the script's bound fires first.
 *
 * This is not extra budget for the script, since `maxJsTimeoutMs` still cuts it off at the requested
 * value. It is the margin that decides which of the two bounds reports, and therefore whether `stderr`
 * carries the message naming the limit. See {@link runExec} for the measured table.
 */
const SHELL_TIMEOUT_GRACE_MS = 2_000

/**
 * The `atob` shim, installed through just-bash's `javascript.bootstrap` before any guest module loads.
 *
 * QuickJS ships no base64 builtins and `node-html-parser` decodes a base64 entity table at load time,
 * so without this the parser throws "'atob' is not defined" at import and every script fails before
 * its first selector. Probed all three placements 2026-08-09: `bootstrap` works, prepending the shim
 * to the parser's own bytes works, and omitting it fails at `decodeBase64`. `bootstrap` is chosen
 * because it leaves the vendored parser byte-identical to the published artifact. A shim spliced into
 * the bundle would make the seeded file something no `pnpm` install reproduces.
 *
 * Base64 only, no `btoa`. The parser decodes and never encodes, and a shim for a capability nothing
 * uses is a capability added to the guest for free.
 */
const ATOB_BOOTSTRAP = `globalThis.atob = globalThis.atob || function (encoded) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let decoded = "", bits = 0, accumulator = 0
  for (const character of String(encoded).replace(/=+$/, "")) {
    const value = alphabet.indexOf(character)
    if (value < 0) continue
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) { bits -= 8; decoded += String.fromCharCode((accumulator >> bits) & 0xff) }
  }
  return decoded
}
`

/**
 * Where the guest-side helper's source lives on the host.
 *
 * `apps/cli/guest/corpus.mjs`, read as bytes at run time and never compiled. It sits outside `src/`
 * so `tsc` does not see it. It is guest source, its imports resolve against guest paths
 * (`/workspace/lib/nhp.mjs`), and a `.ts` file under `src/` would be typechecked against the host's
 * module graph and fail on an import that only exists inside the sandbox.
 *
 * Resolved from `import.meta.url` rather than from `process.cwd()`, so `memhtml exec` works from any
 * directory. `dist/exec.js` sits one level under the package root, which is where `guest/` is.
 */
const guestHelperPath = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "guest", "corpus.mjs")

/**
 * The HTML parser's bytes, as published.
 *
 * ## No bundling step, because the published artifact already is one
 *
 * `node-html-parser@9.0.1`'s `dist/index.mjs` is emitted by `tsdown` with its two dependencies
 * (`css-select`, `entities`) inlined: **zero `import` statements, zero `require(` calls, zero `node:`
 * references, 206655 bytes**, verified against the installed file rather than inferred from the
 * package's `sideEffects` field. The file `pnpm` installs is already loadable in the guest verbatim,
 * and there is nothing to regenerate. The reproduction path is `pnpm install`, pinned by
 * `pnpm-lock.yaml`, and a reader can re-verify self-containment with one grep. A checked-in bundle
 * would be a second copy of a published artifact that nobody could tell had drifted.
 *
 * ## Why this parser
 *
 * **cheerio and linkedom cannot load in QuickJS**, measured: `Object.getOwnPropertyDescriptor(
 * Function.prototype, "toString").writable === false` there, so `Object.assign(fn, source)` throws
 * whenever `source` carries a `toString`, which is what cheerio does when it attaches its
 * static API to `load`. linkedom fails identically through `cssom`. That is a property of the runtime,
 * so `docs/code-mode.md`'s cheerio examples do not carry over even though every selector does.
 *
 * `createRequire` against this module rather than a static import. The parser is never loaded on the
 * host at all, only read as text, and a static `import` would put a 200 KB module on the graph of
 * every `memhtml` command to obtain a path.
 */
const parserSourcePath = (): string =>
  createRequire(import.meta.url)
    .resolve("node-html-parser")
    .replace(/index\.cjs$/, "index.mjs")

/**
 * Did the runtime cut this script off, or did the script exit 124 on its own?
 *
 * Exported, and a pure function of the two observable values, because it is the one piece of
 * classification here that cannot be exercised end-to-end. `runExec` deliberately sets the shell's
 * bound looser than the script's ({@link SHELL_TIMEOUT_GRACE_MS}), so the JS bound always wins and only
 * one of the two wordings ever reaches a live report. That makes the other branch unfalsifiable
 * through the command and therefore a claim rather than a guard. As a function it is testable against
 * both strings just-bash actually produces.
 *
 * Both wordings, measured 2026-08-09 on `for(;;)` at a 400ms bound:
 *
 * - `maxJsTimeoutMs` fires: `js-exec: Execution timeout: exceeded 400ms limit`
 * - `maxExecutionTimeMs` fires: `bash: js-exec exceeded its execution deadline`, with no "timeout" in it
 *
 * A pattern matching only `/timeout/` therefore reports `timedOut: false` on a script that was cut off,
 * which is what the first version of this did. `aborted` covers `bash: execution aborted`, which is what
 * an `AbortSignal` produces (probed). This module takes no such path today, and classifying it correctly
 * now is cheap if it ever does.
 *
 * The exit code is required as well as the wording. 124 alone is reachable from a script that exits 124
 * itself, and a caller branching on `timedOut` needs it to mean the bound fired.
 */
export const cutOffByTheRuntime = (exitCode: number, stderr: string): boolean =>
  exitCode === 124 && /timeout|deadline|aborted/i.test(stderr)

/** What a script produced. `stdout` is the script's own bytes, uninterpreted. */
export interface ExecReport {
  /** The guest path the corpus was mounted at, so a script's paths are explainable from the report. */
  readonly corpusMount: string
  /** The commit the mounted tree holds, or `null` when a directory was mounted directly. */
  readonly sha: string | null
  /** The script's exit code. Non-zero is reported rather than raised. See {@link runExec}. */
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Wall-clock milliseconds for the guest execution alone, excluding mount and seeding. */
  readonly durationMs: number
  /** The bound that was in force. Present so a timeout is self-explaining from the envelope. */
  readonly timeoutMs: number
  /** True when the guest hit {@link timeoutMs}. just-bash reports exit 124 and says so on stderr. */
  readonly timedOut: boolean
}

/** Everything `memhtml exec` needs. `script` is source, already read; this module opens no script file. */
export interface ExecInput {
  /** The script's source, as the guest will see it. */
  readonly script: string
  /** An existing host directory holding the corpus. Mounted read-only at {@link CORPUS_MOUNT}. */
  readonly corpusPath: string
  /** Recorded into the report; `null` when the caller mounted a plain directory. */
  readonly sha?: string | null
  readonly timeoutMs?: number | undefined
}

/**
 * Run one script against a read-only corpus, and report what it printed.
 *
 * ## A non-zero exit is reported rather than raised
 *
 * A script that throws, or that exits 1 deliberately, comes back as a successful envelope carrying
 * `exitCode` and `stderr`. Mapping a guest exit onto the CLI's own exit 1 instead would
 * make `memhtml exec` unable to distinguish "your script failed" from "the runtime could not run it", and
 * an agent debugging a selector would get an error envelope with the script's real diagnostic buried
 * in an `error` string. The runtime's own failures (an absent corpus, an unreadable helper) do travel
 * the error channel and become exit 1.
 *
 * ## The sandbox has no network client, and that is this function's choice
 *
 * `new Bash()` is constructed with no `network` and no `fetch` option, so just-bash never registers its
 * network commands at all. Per `Bash.d.ts:80`: "Network commands (curl, wget) are registered when either
 * `fetch` or `network` is provided." Probed 2026-08-09 (`scripts/probe-sandbox-egress.mjs`): `curl` is
 * exit 127 "command not found", and the guest's `fetch` refuses on call with "Network access not
 * configured." `fetch` is a function there, so a `typeof` check on the global proves nothing. Eve
 * passes `dangerouslyAllowFullInternetAccess`, so the consolidator's sandbox does reach the network.
 * Whoever calls `new Bash()` decides egress, so it is decided here, for this runtime, by omission.
 *
 * ## Two opt-ins, one taken
 *
 * `javascript` is on because `js-exec` is the feature. `python` is off, and so is `network`. Both
 * are off by default in just-bash. That default is preserved as an explicit decision
 * rather than inherited silently, because a future edit adding `python: true` for one recipe would
 * hand every script a second language runtime.
 */
export const runExec = (
  input: ExecInput
): Effect.Effect<ExecReport, InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    /**
     * `just-bash` and the mount helper arrive by dynamic import, and the reason is measured.
     *
     * `just-bash`'s bundle is ~6 MB across 20 chunks and costs ~160ms to load. `@memhtml/consolidator`'s
     * barrel re-exports `mount.js`, which imports it statically, and `apps/cli/src/api-layer.ts`
     * imports that barrel, so today `just-bash` is already on the graph of every `memhtml read`
     * (20 chunks loaded, traced with `module.registerHooks`). Importing it here as well would add a
     * second static edge that survives any future fix to that one. This form keeps the exec path's own
     * cost on the exec path, which is the standing rule for the eve closure (`api-layer.ts`, where
     * `eve/client` is dynamic for the same reason).
     */
    const { Bash } = yield* Effect.tryPromise({
      try: () => import("just-bash"),
      catch: (cause) => StorageFailure.make({ operation: `exec.sandbox-load: ${String(cause)}` })
    })
    const { mountReadOnlyRoots } = yield* Effect.tryPromise({
      try: () => import("@memhtml/consolidator"),
      catch: (cause) => StorageFailure.make({ operation: `exec.mount-load: ${String(cause)}` })
    })

    const helperSource = yield* Effect.tryPromise({
      try: () => readFile(guestHelperPath(), "utf8"),
      catch: (cause) => StorageFailure.make({ operation: `exec.guest-helper: ${String(cause)}` })
    })
    const parserSource = yield* Effect.tryPromise({
      try: () => readFile(parserSourcePath(), "utf8"),
      catch: (cause) => StorageFailure.make({ operation: `exec.guest-parser: ${String(cause)}` })
    })

    /**
     * The one composition, from `apps/consolidator/src/mount.ts`.
     *
     * Not re-derived here. That module encodes the `mountPoint: "/"` requirement on the nested
     * `OverlayFs`, which a file count cannot catch, because all three spellings expose the same
     * number of files at three different prefixes. It also validates roots eagerly, so a bad
     * `corpusPath` is refused before a sandbox exists.
     */
    const { filesystem } = yield* Effect.try({
      try: () =>
        mountReadOnlyRoots({ roots: [{ mountPath: CORPUS_MOUNT, hostPath: input.corpusPath }] }),
      catch: (cause) =>
        InvalidMemory.make({ reason: `exec cannot mount the corpus: ${String(cause)}` })
    })

    /**
     * Two bounds, and the shell's is deliberately the looser one.
     *
     * `maxJsTimeoutMs` bounds the `js-exec` call and `maxExecutionTimeMs` bounds the whole shell
     * invocation, so both are needed. A script cannot outlive its budget by spending the time outside
     * the JS worker. Which one fires first changes the diagnostic, probed 2026-08-09 on a
     * `for(;;)` loop at a 400ms bound:
     *
     * | limits | exit | stderr |
     * | --- | --- | --- |
     * | `maxJsTimeoutMs` alone | 124 | `js-exec: Execution timeout: exceeded 400ms limit` |
     * | both equal | 124 | `bash: js-exec exceeded its execution deadline` |
     * | shell bound looser | 124 | `js-exec: execution timeout exceeded` + the limit-naming line |
     *
     * Setting them equal is a race whose winner decides whether the operator is told the number they
     * set. The shell's bound gets a small margin so the JS bound wins and its message, the one naming
     * the limit, is what reaches `stderr`. The margin is a grace period rather than extra budget. The
     * script is already cut off at `timeoutMs`, and the shell's bound exists only to catch the case
     * where `js-exec` itself fails to stop.
     */
    const bash = new Bash({
      fs: filesystem,
      javascript: { bootstrap: ATOB_BOOTSTRAP },
      executionLimits: {
        maxJsTimeoutMs: timeoutMs,
        maxExecutionTimeMs: timeoutMs + SHELL_TIMEOUT_GRACE_MS
      }
    })

    yield* Effect.tryPromise({
      try: async () => {
        await filesystem.mkdir(GUEST_LIB, { recursive: true })
        await filesystem.writeFile(`${GUEST_LIB}/nhp.mjs`, parserSource)
        await filesystem.writeFile(`${GUEST_LIB}/corpus.mjs`, helperSource)
        // Written through the filesystem rather than passed as `bash -c` text. A script arriving as a
        // shell argument would be subject to the shell's own quoting, and an agent's traversal is
        // full of `$`, backticks, and quotes that a heredoc mangles differently than a file does.
        await filesystem.writeFile(GUEST_SCRIPT, input.script)
      },
      catch: (cause) => StorageFailure.make({ operation: `exec.seed: ${String(cause)}` })
    })

    const started = Date.now()
    const result = yield* Effect.tryPromise({
      try: () => bash.exec(`js-exec ${GUEST_SCRIPT}`),
      // A thrown failure from `bash.exec` is the runtime's rather than the script's. just-bash reports a
      // script's own non-zero exit through `exitCode`, and throws only when it could not run at all.
      catch: (cause) => StorageFailure.make({ operation: `exec.run: ${String(cause)}` })
    })
    const durationMs = Date.now() - started

    const stderr = String(result.stderr ?? "")
    return {
      corpusMount: CORPUS_MOUNT,
      sha: input.sha ?? null,
      exitCode: result.exitCode,
      stdout: String(result.stdout ?? ""),
      stderr,
      durationMs,
      timeoutMs,
      timedOut: cutOffByTheRuntime(result.exitCode, stderr)
    }
  })

/**
 * `--file`'s bytes, or the usage failure for an unreadable path.
 *
 * A `Failure` return rather than a raised error, for the reason `applyText` has one. An unreadable
 * input path is a usage error the caller fixes by changing the call, so it must reach exit 2, and only
 * `validate`'s return path and this pre-dispatch read produce that code.
 */
export const readScript = async (file: string): Promise<string | Failure> => {
  try {
    return await readFile(file, "utf8")
  } catch (cause) {
    return fail(
      "ERR_PATH_NOT_FOUND",
      `exec cannot read --file ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      [`ls ${file}`, "cat script.mjs | memhtml exec"]
    )
  }
}

/**
 * The whole command: pin a commit, mount it, run the script, release the worktree.
 *
 * ## Why a pinned worktree and not `$MEMHTML_ROOT` itself
 *
 * A live `$MEMHTML_ROOT` contains `.memhtml/index.db`, and the guest ships `sqlite3`. Probed 2026-08-09
 * against a read-only `OverlayFs` over a directory holding a real database: `sqlite3
 * /mnt/memhtml/.memhtml/index.db 'select count(*) …'` returned the row, exit 0. Read-only is therefore no
 * barrier to a reader, and mounting the live root would hand every script the ranked planes this command
 * is scoped to exclude, through a door no `memhtml exec` flag opens.
 *
 * `git worktree add --detach` is what closes it. Both databases are gitignored
 * (`packages/store/src/layout.ts`, `GITIGNORE`), and a gitignored file is absent from a checkout of a
 * commit. This is verified rather than argued: the worktree probe in
 * `apps/cli/tests/exec.test.ts` asserts `.memhtml` is not present and that the guest's own `sqlite3` finds
 * nothing to open. Containment is therefore a property of what is mounted, with the read-only flag as a
 * second layer, rather than resting on a flag that a reader can read straight through.
 *
 * The pin also makes an answer reproducible. `sha` rides back in the report, so the same
 * traversal over the same tree is one `--sha` away, and an uncommitted edit is invisible. That is
 * the right behaviour for a command whose whole output is a claim about a corpus state.
 *
 * Cost measured: `git worktree add --detach` on the 305-file fixture is 31ms (three runs: 31/30/31),
 * against a 640ms full-corpus parse. The pin is ~5% of the work it makes correct.
 */
export const execCommand = (input: {
  readonly script: string
  readonly memhtmlRoot: string
  readonly sha?: string | undefined
  readonly timeoutMs?: number | undefined
}): Effect.Effect<ExecReport, InvalidMemory | StorageFailure | GitFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const git = makeGit(input.memhtmlRoot)

    const requested = input.sha
    const sha =
      requested !== undefined && requested.trim() !== ""
        ? requested.trim()
        : yield* git.revParseHead()
    if (sha === null) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `${input.memhtmlRoot} has no commit to mount: exec reads a committed tree, so an unborn HEAD has nothing to traverse`
        })
      )
    }

    /**
     * `pinCorpusSnapshot` from the shared mount module, released through `Effect.acquireRelease`.
     *
     * A worktree is an entry in the repo's own `.git/worktrees`, so a leaked one is durable state left
     * in the operator's repository rather than a temp directory the OS reclaims. The release runs on
     * the script's failure, on a timeout, and on an interrupt, which a `finally` around the happy path
     * would not cover.
     */
    const { pinCorpusSnapshot } = yield* Effect.tryPromise({
      try: () => import("@memhtml/consolidator"),
      catch: (cause) => StorageFailure.make({ operation: `exec.mount-load: ${String(cause)}` })
    })

    const snapshot = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => pinCorpusSnapshot({ repoRoot: input.memhtmlRoot, sha }),
        catch: (cause) =>
          InvalidMemory.make({
            reason: `exec cannot materialize ${sha}: ${String(cause)}`
          })
      }),
      (pinned) => Effect.promise(() => pinned.release())
    )

    return yield* runExec({
      script: input.script,
      corpusPath: snapshot.hostPath,
      sha,
      timeoutMs: input.timeoutMs
    })
  })
