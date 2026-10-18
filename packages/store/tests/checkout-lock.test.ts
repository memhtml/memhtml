import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CHECKOUT_LOCK_PATH } from "@memhtml/contracts"
import { renderTemplate } from "@memhtml/html"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { checkoutLockTarget, withCheckoutLock } from "../src/checkout-lock.js"
import { makeGit } from "../src/git.js"
import { makeStore, type StoreShape } from "../src/store.js"
import { type FixtureRepo, makeFixtureRepo, writeInput } from "../src/testing.js"

/**
 * Every v1 path that commits the shared index, beside a session commit's critical section.
 *
 * A session commit moves the shared index and working tree to its new commit (`read-tree -m -u`)
 * and only then compare-and-swaps the ref, holding the checkout lock across both
 * (`@memhtml/session` `landOnRef`). A v1 commit landing in between commits the whole index, so it
 * took the session's file under its own subject, the swap lost, and the session's rollback staged the
 * file's deletion for the next v1 commit to land. Here that critical section is staged by hand under
 * the same lock from a root fiber of its own (another writer), held for 600 ms, and each door must
 * wait it out: its commit lands after the session's, holding its own paths and nothing of the
 * session's.
 *
 * Mutation notes, each run once with the change applied and the cases named red:
 * - `exclusive` without `withCheckoutLock` (the permit alone) -> "two stores over one root (two
 *   processes) writing one title land two files" (both pick the same free path, and one write
 *   replaces the other). The doors stay green: `Git.commit` still takes the lock for the commit.
 * - `Git.commit` without `withCheckoutLock` as well -> every door red: the door commits inside the
 *   window and takes the session's file, and the session's swap loses.
 * - `Git.commit` without `withCheckoutLock` alone -> "a bare git.commit" red.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const fixture = async (): Promise<FixtureRepo> => {
  const repo = await run(makeFixtureRepo())
  repos.push(repo)
  return repo
}

const git = (
  root: string,
  args: ReadonlyArray<string>,
  extra: NodeJS.ProcessEnv = {},
  input?: string
) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", ...extra },
    ...(input === undefined ? {} : { input })
  }).trim()

const SESSION_PATH = "areas/inbox/session-fact.html"
const SESSION_FACT = renderTemplate({
  title: "Session fact",
  claim: "A fact a run session wrote.",
  entities: ["system:fixture"],
  memoryType: "semantic",
  at: "2026-10-18T12:00:00Z"
})

/** True when `promise` settles within `ms`. */
const settlesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
  ])

/**
 * A session commit's critical section, by hand, from another writer: under the checkout lock, build
 * a commit adding {@link SESSION_PATH} on HEAD through a scratch index, move the shared index and
 * working tree to it, hold for `holdMs`, then compare-and-swap the ref. Resolves with the commit
 * once the section is entered (`entered`) and once it is done (`done`, the swap's outcome).
 */
const sessionSection = (root: string, holdMs: number) => {
  let markEntered: (commit: string) => void = () => {}
  const entered = new Promise<string>((resolve) => {
    markEntered = resolve
  })
  const done = Effect.runPromise(
    withCheckoutLock(
      root,
      Effect.promise(async () => {
        const scratch = await mkdtemp(join(tmpdir(), "memhtml-store-section-"))
        try {
          const env = { GIT_INDEX_FILE: join(scratch, "index") }
          const parent = git(root, ["rev-parse", "HEAD"])
          const blob = git(root, ["hash-object", "-w", "--stdin"], {}, SESSION_FACT)
          git(root, ["read-tree", parent], env)
          git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${SESSION_PATH}`], env)
          const tree = git(root, ["write-tree"], env)
          const commit = git(root, ["commit-tree", tree, "-p", parent, "-m", "memhtml(session): x"])
          git(root, ["read-tree", "-m", "-u", parent, commit])
          markEntered(commit)
          await new Promise((resolve) => setTimeout(resolve, holdMs))
          try {
            git(root, ["update-ref", "refs/heads/main", commit, parent])
            return "swapped"
          } catch {
            git(root, ["read-tree", "-m", "-u", commit, parent])
            return "raced"
          }
        } finally {
          await rm(scratch, { recursive: true, force: true })
        }
      })
    )
  )
  return { entered, done }
}

/** One door: its setup (before the section) and the call under test, given the repo. */
interface Door {
  readonly name: string
  readonly setup: (store: StoreShape) => Promise<Record<string, string>>
  readonly call: (
    repo: FixtureRepo,
    paths: Record<string, string>
  ) => Effect.Effect<unknown, unknown>
}

const written = async (store: StoreShape, title: string): Promise<string> =>
  (await run(store.writeMemory(writeInput({ title, claim: `${title} is a fact.` })))).path

const DOORS: ReadonlyArray<Door> = [
  {
    name: "writeMemory (memory_write)",
    setup: async () => ({}),
    call: (repo) => repo.store.writeMemory(writeInput({ title: "V1 write" }))
  },
  {
    name: "writeMemories (memory_write_batch)",
    setup: async () => ({}),
    call: (repo) =>
      repo.store.writeMemories([
        writeInput({ title: "Batch one", claim: "The first of a batch." }),
        writeInput({ title: "Batch two", claim: "The second of a batch." })
      ])
  },
  {
    name: "correctMemory (memory_correct)",
    setup: async (store) => ({ target: await written(store, "Original") }),
    call: (repo, paths) =>
      repo.store.correctMemory(
        paths.target ?? "",
        writeInput({ title: "Corrected", claim: "The corrected fact." })
      )
  },
  {
    name: "archiveMemory (memory_archive)",
    setup: async (store) => ({ target: await written(store, "Evicted") }),
    call: (repo, paths) => repo.store.archiveMemory(paths.target ?? "", "no longer true")
  },
  {
    name: "linkMemories (memory_link)",
    setup: async (store) => ({
      src: await written(store, "Source"),
      dst: await written(store, "Target")
    }),
    call: (repo, paths) => repo.store.linkMemories(paths.src ?? "", "relates_to", paths.dst ?? "")
  },
  {
    name: "exclusive around git.add and git.commit (task status)",
    setup: async () => ({}),
    call: (repo) =>
      repo.store.exclusive(
        Effect.promise(() =>
          writeFile(
            join(repo.root, "areas/inbox/by-hand.html"),
            SESSION_FACT.replace("Session", "Hand")
          )
        ).pipe(
          Effect.andThen(repo.git.add(["areas/inbox/by-hand.html"])),
          Effect.andThen(repo.git.commit("memhtml(task): by hand"))
        )
      )
  },
  {
    name: "a bare git.commit of a stage made outside any lock",
    setup: async () => ({}),
    call: (repo) =>
      Effect.promise(() =>
        writeFile(join(repo.root, "areas/inbox/bare.html"), SESSION_FACT.replace("Session", "Bare"))
      ).pipe(
        Effect.andThen(repo.git.add(["areas/inbox/bare.html"])),
        Effect.andThen(repo.git.commit("memhtml(write): bare"))
      )
  }
]

describe("the checkout lock in the v1 store", () => {
  it("two stores over one root (two processes) writing one title land two files", async () => {
    const repo = await fixture()
    // A second store over the same root has its own in-process permit, as another process does.
    const other = makeStore(makeGit(repo.root))
    const input = writeInput({ title: "Same title", claim: "Written by two processes at once." })
    const [first, second] = await Promise.all([
      run(repo.store.writeMemory(input)),
      run(other.writeMemory({ ...input, claim: "Written by the other process at once." }))
    ])
    expect(new Set([first.path, second.path]).size).toBe(2)
    const tree = git(repo.root, ["ls-tree", "-r", "--name-only", "main"]).split("\n")
    expect(tree).toContain(first.path)
    expect(tree).toContain(second.path)
    expect(git(repo.root, ["status", "--porcelain"])).toBe("")
  })

  it("targets <root>/.memhtml/checkout, the string @memhtml/session computes", () => {
    expect(CHECKOUT_LOCK_PATH).toBe(".memhtml/checkout")
    expect(checkoutLockTarget("/srv/store")).toBe("/srv/store/.memhtml/checkout")
  })

  for (const door of DOORS) {
    it(`${door.name} waits out a session's checkout move and keeps its file on main`, async () => {
      const repo = await fixture()
      const paths = await door.setup(repo.store)
      const before = git(repo.root, ["rev-parse", "HEAD"])
      const section = sessionSection(repo.root, 600)
      const sessionCommit = await section.entered
      const op = run(door.call(repo, paths))
      expect(await settlesWithin(op, 300)).toBe(false)
      expect(await section.done).toBe("swapped")
      await op
      // The door's commit sits on the session's and changes none of the session's paths.
      const head = git(repo.root, ["rev-parse", "HEAD"])
      expect(git(repo.root, ["rev-parse", `${head}^`])).toBe(sessionCommit)
      expect(git(repo.root, ["rev-parse", `${sessionCommit}^`])).toBe(before)
      expect(git(repo.root, ["show", "--name-only", "--format=", head]).split("\n")).not.toContain(
        SESSION_PATH
      )
      expect(git(repo.root, ["ls-tree", "-r", "--name-only", "main"]).split("\n")).toContain(
        SESSION_PATH
      )
      expect(git(repo.root, ["status", "--porcelain"])).toBe("")
    })
  }
})
