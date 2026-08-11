import { mkdtemp, rm } from "node:fs/promises"
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
 * Deliberately not a fake. The fleet has now had five bugs where a stateless fake verified the
 * shape of a call and missed the state semantics behind it — and this package's entire subject
 * is git's state semantics: what rename detection scores, what the index holds mid-merge, what
 * `mv` refuses. A fake git would pass a suite that a real one fails.
 */

/** A fixture repo and the services over it. `cleanup` removes the whole temp tree. */
export interface FixtureRepo {
  readonly root: string
  readonly git: GitShape
  readonly store: StoreShape
  readonly cleanup: () => Promise<void>
}

/**
 * `user.name`/`user.email` are set per repo rather than assumed from the environment: CI has no
 * global git identity, and `git commit` refuses without one — which would fail every test here
 * for a reason unrelated to what it asserts.
 */
const FIXTURE_IDENTITY: ReadonlyArray<readonly [string, string]> = [
  ["user.name", "memhtml fixture"],
  ["user.email", "fixture@memhtml.invalid"],
  // A signing config inherited from a developer's global gitconfig would make every fixture
  // commit prompt for a key or fail outright.
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"]
]

/**
 * A scaffolded memory repo in a fresh temp directory.
 *
 * `init: false` yields an empty directory that is not a git repo at all — what `initRepo`'s own
 * idempotence and refusal tests need.
 */
export const makeFixtureRepo = (
  options: { readonly init?: boolean; readonly hooks?: StoreHooks } = {}
): Effect.Effect<FixtureRepo> =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "memhtml-store-")))
    const git = makeGit(root)
    const cleanup = () => rm(root, { recursive: true, force: true })

    if (options.init !== false) {
      // The identity has to exist before the first commit, and `initRepo` makes one — so the
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
