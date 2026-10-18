import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { ensureExcluded, ensureExcludedQuietly } from "../src/exclude.js"
import { gitPathOf } from "../src/plumbing.js"
import { SESSIONS_DIR, startSession } from "../src/session.js"
import { commitFiles, git, loadHead, memory } from "./helpers.js"

/**
 * `.git/info/exclude` as the ignore file for v2 state in a store whose committed `.gitignore` does
 * not name it (`exclude.ts`).
 *
 * Every ignore claim is checked with `git check-ignore` and `git status --porcelain` over the real
 * repository, not by reading the file back.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `ensureExcluded`: `const added = [...patterns]` (append without the presence check) -> "appends
 *   each missing pattern once across two calls" (the second call appends again, the file holds the
 *   line twice).
 * - `startSession`: drop the `ensureExcludedQuietly` call -> "a session start leaves git status
 *   empty in a store whose .gitignore predates sessions" (the log and index file are untracked).
 * - `gitPathOf`: return `join(root, ".git", relative)` -> "resolves the exclude file of a linked
 *   worktree to the common directory" (the worktree's `.git` is a file, so the write fails).
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A repo on `main` whose `.gitignore` ignores the databases only, the pre-v2 scaffold's shape. */
const olderStore = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-exclude-"))
  roots.push(root)
  await git(root, ["init", "-q", "-b", "main", "."])
  await git(root, ["config", "user.name", "memhtml test"])
  await git(root, ["config", "user.email", "test@memhtml.invalid"])
  await commitFiles(root, {
    ".gitignore": ".memhtml/index.db\n.memhtml/state.db\n",
    "areas/inbox/a.html": memory("A", "Alpha is the first letter of the Greek alphabet.")
  })
  return root
}

const status = (root: string): Promise<string> => git(root, ["status", "--porcelain"])

const ignored = async (root: string, path: string): Promise<boolean> => {
  try {
    await git(root, ["check-ignore", "-q", path])
    return true
  } catch {
    return false
  }
}

describe("ensureExcluded", () => {
  it("appends each missing pattern once across two calls", async () => {
    const root = await olderStore()
    expect(await ignored(root, ".memhtml/sessions/x.json")).toBe(false)
    expect(await ignored(root, ".memhtml/snapshots/x.arrow")).toBe(false)

    const first = await run(ensureExcluded(root, [".memhtml/sessions/", ".memhtml/snapshots/"]))
    expect(first.file).toBe(join(root, ".git", "info", "exclude"))
    expect(first.added).toEqual([".memhtml/sessions/", ".memhtml/snapshots/"])
    const second = await run(ensureExcluded(root, [".memhtml/sessions/", ".memhtml/snapshots/"]))
    expect(second.added).toEqual([])

    const lines = (await readFile(first.file, "utf8")).split("\n")
    expect(lines.filter((line) => line === ".memhtml/sessions/")).toHaveLength(1)
    expect(lines.filter((line) => line === ".memhtml/snapshots/")).toHaveLength(1)
    expect(await ignored(root, ".memhtml/sessions/x.json")).toBe(true)
    expect(await ignored(root, ".memhtml/snapshots/x.arrow")).toBe(true)
    // The exclude file is git's own, so the working tree stays clean.
    expect(await status(root)).toBe("")
  })

  it("adds only the patterns a second caller brings that are new", async () => {
    const root = await olderStore()
    await run(ensureExcluded(root, [".memhtml/sessions/"]))
    const next = await run(ensureExcluded(root, [".memhtml/sessions/", ".memhtml/snapshots/"]))
    expect(next.added).toEqual([".memhtml/snapshots/"])
  })

  it("keeps a file without a trailing newline on its own line", async () => {
    const root = await olderStore()
    const file = join(root, ".git", "info", "exclude")
    await writeFile(file, "*.log", "utf8")
    await run(ensureExcluded(root, [".memhtml/sessions/"]))
    expect(await readFile(file, "utf8")).toBe("*.log\n.memhtml/sessions/\n")
    expect(await ignored(root, "a.log")).toBe(true)
    expect(await ignored(root, ".memhtml/sessions/a")).toBe(true)
  })

  it("resolves the exclude file of a linked worktree to the common directory", async () => {
    const root = await olderStore()
    const linked = join(root, "..", `memhtml-exclude-linked-${process.pid}`)
    roots.push(linked)
    await git(root, ["worktree", "add", "-q", "-b", "side", linked])
    expect(await run(gitPathOf(linked, "info/exclude"))).toBe(join(root, ".git", "info", "exclude"))
    const result = await run(ensureExcluded(linked, [".memhtml/sessions/"]))
    expect(result.file).toBe(join(root, ".git", "info", "exclude"))
    expect(await ignored(linked, ".memhtml/sessions/x.json")).toBe(true)
    await git(root, ["worktree", "remove", "--force", linked])
  })

  it("the quiet form answers null and does not fail outside a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "memhtml-exclude-none-"))
    roots.push(root)
    await mkdir(join(root, "sub"), { recursive: true })
    expect(await run(ensureExcludedQuietly(join(root, "sub"), [".memhtml/sessions/"]))).toBeNull()
  })
})

describe("a session start", () => {
  it("leaves git status empty in a store whose .gitignore predates sessions", async () => {
    const root = await olderStore()
    const head = await loadHead(root)
    await run(startSession({ root, id: "s1", base: head }))
    expect(await status(root)).toBe("")
    expect(await ignored(root, `${SESSIONS_DIR}/s1.json`)).toBe(true)
    expect(await ignored(root, `${SESSIONS_DIR}/s1.idx`)).toBe(true)
  })
})
