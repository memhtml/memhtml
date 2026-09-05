import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { type GitShape, makeGit } from "./git.js"
import { initRepo } from "./layout.js"
import { makeStore, type StoreHooks, type StoreShape } from "./store.js"

/**
 * A real git repository in a temp directory, for tests in this package and in every package
 * downstream. Exported at the `@memhtml/store/testing` subpath so `@memhtml/index` and `@memhtml/sleep`
 * build their fixtures the same way this package does.
 *
 * Deliberately not a fake. A stateless fake verifies the shape of a call and misses the state
 * semantics behind it, which is where this system's defects have actually lived — and this
 * package's entire subject IS git's state semantics: what rename detection scores, what the index
 * holds mid-merge, what `mv` rejects. A fake git would pass a suite that a real one fails.
 */

/** A fixture repo and the services over it. `cleanup` removes the whole temp tree. */
export interface FixtureRepo {
  readonly root: string
  readonly git: GitShape
  readonly store: StoreShape
  readonly cleanup: () => Promise<void>
}

/**
 * `user.name`/`user.email` are set per repo rather than assumed from the environment. CI has no
 * global git identity, and `git commit` fails without one, which would fail every test here
 * for a reason unrelated to what it asserts.
 */
const FIXTURE_IDENTITY: ReadonlyArray<readonly [string, string]> = [
  ["user.name", "memhtml fixture"],
  ["user.email", "fixture@memhtml.invalid"],
  // A signing config inherited from a developer's global gitconfig would make every fixture
  // commit prompt for a key or fail outright.
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  /**
   * No background maintenance in a fixture, because it OUTLIVES the test.
   *
   * `git commit` starts `git maintenance run --auto` (and `gc --auto` before it) as a detached
   * process, so a repo that a test tears down at the end of its case can still have git writing into
   * `.git/objects` — and {@link FixtureRepo.cleanup} then fails with `ENOTEMPTY: directory not empty,
   * rmdir '…/.git/objects'`, attributed to whichever case happened to be last. Observed on CI
   * 2026-08-14 (`memhtml/memhtml` run 31849757926). A fixture lives for one test and never has enough
   * objects for maintenance to be worth doing, so switching it off removes the race rather than
   * waiting the race out.
   */
  ["gc.auto", "0"],
  ["maintenance.auto", "false"]
]

/**
 * A scaffolded memory repo in a fresh temp directory.
 *
 * `init: false` yields an empty directory that is not a git repo at all, which is what `initRepo`'s
 * own idempotence and rejection tests need.
 */
export const makeFixtureRepo = (
  options: { readonly init?: boolean; readonly hooks?: StoreHooks } = {}
): Effect.Effect<FixtureRepo> =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "memhtml-store-")))
    const git = makeGit(root)
    /**
     * `maxRetries` because a temp tree can have a writer that is not this process.
     *
     * The `gc.auto` entry above stops git's own background maintenance, the writer that caused this;
     * the retries are the second layer, for anything else that holds a file open for a moment — a
     * scanner, an editor, an OS indexer. `rm` retries only the errors worth retrying (`ENOTEMPTY`,
     * `EBUSY`, `EPERM`), so a genuinely undeletable tree still fails rather than stalling.
     */
    const cleanup = () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

    if (options.init !== false) {
      // The identity has to exist before the first commit, and `initRepo` makes one, so the
      // repo is created here, configured, and only then scaffolded.
      yield* git.run(["init", "-b", "main", "."]).pipe(Effect.orDie)
      for (const [key, value] of FIXTURE_IDENTITY) {
        yield* git.setConfig(key, value).pipe(Effect.orDie)
      }
      yield* initRepo(git).pipe(Effect.orDie)
    }

    return { root, git, store: makeStore(git, options.hooks ?? {}), cleanup }
  })

/** Set the fixture identity on a repo created some other way (a clone, a bare repo's worktree). */
export const configureIdentity = (git: GitShape): Effect.Effect<void> =>
  Effect.forEach(FIXTURE_IDENTITY, ([key, value]) => git.setConfig(key, value)).pipe(
    Effect.asVoid,
    Effect.orDie
  )

/** A `dedupeLookup` over a mutable map, for a test that drives the dedupe branch. */
export const mapDedupeLookup = (
  byHash: Map<string, string> = new Map()
): {
  readonly byHash: Map<string, string>
  readonly lookup: NonNullable<StoreHooks["dedupeLookup"]>
} => ({
  byHash,
  lookup: (contentHash) => Effect.succeed(byHash.get(contentHash) ?? null)
})

/** A `onMove` recorder, for asserting the state-plane mirror fires exactly once per move. */
export const recordingMoveCallback = (): {
  readonly moves: Array<readonly [string, string]>
  readonly onMove: NonNullable<StoreHooks["onMove"]>
} => {
  const moves: Array<readonly [string, string]> = []
  return {
    moves,
    onMove: (from, to) =>
      Effect.sync(() => {
        moves.push([from, to])
      })
  }
}

/** The minimum write input, so a test names only the fields it cares about. */
export const writeInput = (
  overrides: Partial<Parameters<StoreShape["writeMemory"]>[0]> = {}
): Parameters<StoreShape["writeMemory"]>[0] => ({
  title: "A remembered fact",
  claim: "The claim this memory asserts.",
  memoryType: "semantic",
  at: "2026-08-02T12:00:00Z",
  ...overrides
})

/**
 * A throwaway `MEMHTML_ROOT` for one test process, and the check that nothing created it.
 *
 * Issue #144. `run()` in `@memhtml/cli`, called in-process without `--repo` or an injected layer,
 * resolves its repo from the environment, so a test that reached the app layer opened whatever store
 * the developer's shell named, and a help mutant rebuilt a live index that way. Every vitest config
 * whose tests can reach that layer sets `test.env` from {@link throwawayTestEnv}, so the only store an
 * unpinned invocation can touch is a path under the OS temp dir that nothing else uses. The path is
 * per process, so two runs on one machine cannot share it, and nothing here creates it: a test that
 * opens it IS the defect, and {@link assertThrowawayRootUntouched} is the run's teardown that says so.
 */
export const THROWAWAY_ROOT_PREFIX = "memhtml-vitest-root-"

/** The throwaway root for this process. Read `process.env.MEMHTML_ROOT` inside a test worker instead. */
export const throwawayRoot = (): string => join(tmpdir(), `${THROWAWAY_ROOT_PREFIX}${process.pid}`)

/**
 * The environment a test run is pinned to: the throwaway root, both network edges off so a layer
 * built from it neither embeds nor resolves a Bedrock credential, and `MEMHTML_REFUSE_ENV_ROOT` on so
 * an in-process `run()` that names no repo is refused at exit 2 instead of reaching the throwaway at
 * all. The root pin and the teardown stay as the backstop for a layer built outside `run()`.
 */
export const throwawayTestEnv = (): Record<string, string> => ({
  MEMHTML_ROOT: throwawayRoot(),
  MEMHTML_EMBED: "off",
  MEMHTML_LLM: "off",
  MEMHTML_REFUSE_ENV_ROOT: "1"
})

/**
 * Rejects when the throwaway root exists, naming what it holds. Pure of process state so it can be
 * unit-tested; {@link throwawayRootGlobalSetup} is what wires it into a run's exit code.
 */
export const assertThrowawayRootUntouched = async (): Promise<void> => {
  const root = throwawayRoot()
  let entries: ReadonlyArray<string>
  try {
    entries = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  throw new Error(
    `a test reached the app layer through the environment: ${root} exists and holds ${entries.join(", ")}. Pass --repo or inject a layer (issue #144).`
  )
}

/**
 * The vitest `globalSetup` default export: runs once in the main process, before any test file, and
 * returns the teardown that runs after the last one.
 *
 * Setup removes a stale root first. The path is named by this process's own pid, so anything already
 * there is from a killed run whose pid the OS has recycled, and reporting it would blame this run for
 * another's leftovers. Teardown sets `process.exitCode` before rethrowing, because vitest catches a
 * teardown rejection in `close()`, logs it as `error during close`, and ends with a bare
 * `process.exit()`: without the exit code the message would print under a green summary and CI would
 * pass. Probed in vitest 4.1.11.
 */
export const throwawayRootGlobalSetup = async (): Promise<() => Promise<void>> => {
  await rm(throwawayRoot(), { recursive: true, force: true })
  return async () => {
    try {
      await assertThrowawayRootUntouched()
    } catch (error) {
      process.exitCode = 1
      throw error
    }
  }
}
