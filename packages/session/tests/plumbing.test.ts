import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { makePlumbing } from "../src/plumbing.js"
import { blobShaOf, commitFiles, git, makeRepo, memory, type Repo } from "./helpers.js"

/**
 * The plumbing against the real git binary (2.50.1 probed). Every method is exercised through the
 * session index file so the shared index is provably untouched.
 *
 * Mutation notes, one per guard, each run once with the change applied and the named test red:
 * - `updateRef`: drop the `cannot lock ref` branch (always fail) -> "classifies a moved ref as raced".
 * - `childEnv`: skip the `GIT_REPO_SELECTION_ENV` loop -> "ignores an ambient GIT_INDEX_FILE".
 * - `GIT_ENV`: drop the `GIT_LITERAL_PATHSPECS` or the `GIT_ICASE_PATHSPECS` pin -> "matches each
 *   path as itself, whatever the four variables say".
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<Repo> = []
const repo = async (): Promise<Repo> => {
  const created = await makeRepo()
  repos.push(created)
  return created
}
afterEach(async () => {
  await Promise.all(repos.splice(0).map((created) => created.cleanup()))
})

const plumbingIn = (root: string, name = "s1") =>
  makePlumbing({ root, indexFile: join(root, ".memhtml", "sessions", `${name}.idx`) })

const seeded = async () => {
  const { root } = await repo()
  await git(root, ["init", "-q"])
  const base = await commitFiles(root, {
    "areas/inbox/a.html": memory("A", "Alpha is the first letter of the Greek alphabet."),
    "areas/inbox/b.html": memory("B", "Beta is the second letter of the Greek alphabet.")
  })
  const { mkdir } = await import("node:fs/promises")
  await mkdir(join(root, ".memhtml", "sessions"), { recursive: true })
  return { root, base, git: plumbingIn(root) }
}

describe("hashObjectWrite", () => {
  it("matches sha1(blob <len>\\0 bytes) for ASCII and multibyte content", async () => {
    const { git: plumbing } = await seeded()
    for (const html of ["<p>plain</p>", "<p>café — 日本語 🚀</p>"]) {
      const sha = await run(plumbing.hashObjectWrite(new TextEncoder().encode(html)))
      expect(sha).toBe(blobShaOf(html))
    }
  })
})

describe("the session index", () => {
  it("stages, removes, and writes a tree without touching the shared index", async () => {
    const { root, base, git: plumbing } = await seeded()
    await run(plumbing.readTree(base))
    const sha = await run(plumbing.hashObjectWrite(new TextEncoder().encode(memory("C", "C."))))
    await run(plumbing.updateIndexAdd([{ mode: "100644", sha, path: "areas/inbox/c.html" }]))
    await run(plumbing.updateIndexRemove(["areas/inbox/a.html"]))
    const tree = await run(plumbing.writeTree())
    const listing = await git(root, ["ls-tree", "-r", "--name-only", tree])
    expect(listing.split("\n").sort()).toEqual([
      ".gitignore",
      "areas/inbox/b.html",
      "areas/inbox/c.html"
    ])
    // The shared index still describes HEAD exactly.
    expect(await git(root, ["status", "--porcelain"])).toBe("")
  })

  it("ignores an ambient GIT_INDEX_FILE and uses the session's own file", async () => {
    const { root, base } = await seeded()
    const previous = process.env.GIT_INDEX_FILE
    process.env.GIT_INDEX_FILE = join(root, "does-not-exist", "ambient.idx")
    try {
      // Constructed AFTER the variable is set: `makePlumbing` snapshots the environment once.
      const plumbing = plumbingIn(root)
      await run(plumbing.readTree(base))
      // The shared-index call must not inherit the ambient variable either: with it, `status`
      // would read an index that does not exist and report every file deleted.
      expect(await run(plumbing.dirtyPaths(["areas/inbox/a.html", ".gitignore"]))).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = previous
    }
    const bytes = await readFile(join(root, ".memhtml", "sessions", "s1.idx"))
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("DIRC")
  })

  it("writes the empty tree over an index file that was never read into (probed git 2.50.1)", async () => {
    // A missing index file is an empty index to git, not an error. `commitSession` always runs
    // `readTree(parent)` first, so this fact never reaches a commit; it is pinned so a future
    // reorder that skipped the read would show up as an emptied corpus here rather than on main.
    const { root } = await seeded()
    const plumbing = plumbingIn(root, "never-read")
    expect(await run(plumbing.writeTree())).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904")
  })
})

describe("commitTree, revParse, diffTreePaths", () => {
  it("commits a tree with the message on stdin and reads it back", async () => {
    const { root, base, git: plumbing } = await seeded()
    await run(plumbing.readTree(base))
    const tree = await run(plumbing.writeTree())
    const commit = await run(plumbing.commitTree(tree, [base], "subject\n\nMemhtml-Session: s1\n"))
    expect(
      await git(root, ["log", "-1", "--format=%s%n%(trailers:key=Memhtml-Session)", commit])
    ).toBe("subject\nMemhtml-Session: s1")
    expect(await run(plumbing.revParse("refs/heads/main"))).toBe(base)
    expect(await run(plumbing.revParse("refs/heads/absent"))).toBeNull()
  })

  it("lists changed paths NUL-safely, renames as delete plus add", async () => {
    const { root, base, git: plumbing } = await seeded()
    await git(root, ["mv", "areas/inbox/a.html", "areas/inbox/a moved.html"])
    await git(root, ["commit", "-q", "-m", "move"])
    const next = await git(root, ["rev-parse", "HEAD"])
    expect([...(await run(plumbing.diffTreePaths(base, next)))].sort()).toEqual([
      "areas/inbox/a moved.html",
      "areas/inbox/a.html"
    ])
    expect(await run(plumbing.diffTreePaths(base, base))).toEqual([])
  })
})

describe("updateRef", () => {
  it("swaps when the expected value holds and creates when expected is null", async () => {
    const { root, base, git: plumbing } = await seeded()
    expect(await run(plumbing.updateRef("refs/memhtml/sessions/s1", base, null))).toBe("updated")
    expect(await git(root, ["rev-parse", "refs/memhtml/sessions/s1"])).toBe(base)
    expect(await run(plumbing.updateRef("refs/memhtml/sessions/s1", base, null))).toBe("raced")
  })

  it("classifies a moved ref as raced and leaves it where the other writer put it", async () => {
    const { root, base, git: plumbing } = await seeded()
    const intruder = await commitFiles(root, { "areas/inbox/z.html": memory("Z", "Zeta.") })
    const outcome = await run(plumbing.updateRef("refs/heads/main", base, base))
    expect(outcome).toBe("raced")
    expect(await git(root, ["rev-parse", "refs/heads/main"])).toBe(intruder)
  })

  it("reports any other failure as a GitFailure naming the command", async () => {
    const { git: plumbing } = await seeded()
    const result = await run(
      Effect.result(plumbing.updateRef("refs/heads/main", "not-a-sha", null))
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.command).toBe("update-ref")
  })
})

describe("the shared side", () => {
  it("reads HEAD's branch, or null when detached", async () => {
    const { root, base, git: plumbing } = await seeded()
    expect(await run(plumbing.headRef())).toBe("refs/heads/main")
    await git(root, ["checkout", "-q", "--detach", base])
    expect(await run(plumbing.headRef())).toBeNull()
  })

  it("moves the working tree with read-tree -m -u on the shared index", async () => {
    const { root, base, git: plumbing } = await seeded()
    await run(plumbing.readTree(base))
    const sha = await run(plumbing.hashObjectWrite(new TextEncoder().encode(memory("C", "C."))))
    await run(plumbing.updateIndexAdd([{ mode: "100644", sha, path: "areas/inbox/c.html" }]))
    const tree = await run(plumbing.writeTree())
    const commit = await run(plumbing.commitTree(tree, [base], "m\n"))
    await run(plumbing.updateRef("refs/heads/main", commit, base))
    await run(plumbing.readTreeIntoWorktree(base, commit))
    expect(await readFile(join(root, "areas/inbox/c.html"), "utf8")).toBe(memory("C", "C."))
    expect(await run(plumbing.dirtyPaths(["areas/inbox/c.html", "areas/inbox/a.html"]))).toEqual([])
    expect(await run(plumbing.isAncestor(base, "refs/heads/main"))).toBe(true)
    expect(await run(plumbing.isAncestor(commit, base))).toBe(false)
  })

  it("dirtyPaths names a modified, a staged, and an untracked path among those asked, and no other", async () => {
    const { root, git: plumbing } = await seeded()
    await writeFile(join(root, "areas/inbox/a.html"), `${memory("A", "A.")}<!-- edit -->\n`, "utf8")
    await writeFile(join(root, "areas/inbox/new.html"), memory("New", "New."), "utf8")
    await writeFile(join(root, "areas/inbox/staged.html"), memory("Staged", "Staged."), "utf8")
    await git(root, ["add", "areas/inbox/staged.html"])
    expect(
      await run(
        plumbing.dirtyPaths([
          "areas/inbox/a.html",
          "areas/inbox/b.html",
          "areas/inbox/new.html",
          "areas/inbox/staged.html",
          "areas/inbox/absent.html"
        ])
      )
    ).toEqual(["areas/inbox/a.html", "areas/inbox/new.html", "areas/inbox/staged.html"])
    expect(await run(plumbing.dirtyPaths([]))).toEqual([])
  })
})

describe("dirtyPaths reads each path as itself", () => {
  /**
   * `git status` reads its path arguments as pathspecs, and `[`, `*` and `?` are ordinary
   * characters in a record's path. A bare `areas/inbox/a[b].html` also matches an untracked
   * `areas/inbox/ab.html`, so a commit touching only the first refused as `worktree-dirty` over the
   * second. Each path is passed as `:(literal)`, and an empty one is refused before git runs:
   * git rejects a bare `""`, but `:(literal)` with nothing after it matches the whole tree.
   */
  it("names a path whose name is a glob pattern, and not the untracked files it would match", async () => {
    const { root, git: plumbing } = await seeded()
    for (const name of ["a[b].html", "ab.html", "*.html"]) {
      await writeFile(join(root, "areas/inbox", name), memory(name, `${name}.`), "utf8")
    }

    expect(await run(plumbing.dirtyPaths(["areas/inbox/a[b].html", "areas/inbox/*.html"]))).toEqual(
      ["areas/inbox/*.html", "areas/inbox/a[b].html"]
    )
  })

  it("refuses an empty path rather than reading it as the whole tree", async () => {
    const { root, git: plumbing } = await seeded()
    await writeFile(join(root, "areas/inbox/new.html"), memory("New", "New."), "utf8")

    const result = await run(Effect.result(plumbing.dirtyPaths(["areas/inbox/a.html", ""])))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.command).toBe("status")
      expect(result.failure.exitCode).toBeNull()
    }
  })
})

describe("the environment cannot change how a pathspec matches", () => {
  /**
   * Four variables change how every pathspec matches. Against the `:(literal)` paths `dirtyPaths`
   * passes, two still would: `GIT_LITERAL_PATHSPECS=1` reads the `:(literal)` prefix as part of the
   * path, so nothing matches, and `GIT_ICASE_PATHSPECS=1` folds case, so `AB.HTML` names `ab.html`.
   * `GIT_NOGLOB_PATHSPECS` and `GIT_GLOB_PATHSPECS` cannot move a literal pathspec (probed, git
   * 2.50.1); they are pinned beside the other two, as the store's git service pins all four, for
   * any later call that passes a pattern. Each plumbing is built after the variable is set, since
   * `makePlumbing` snapshots the environment once.
   */
  it("matches each path as itself, whatever the four variables say", async () => {
    const { root } = await seeded()
    for (const name of ["a[b].html", "ab.html"]) {
      await writeFile(join(root, "areas/inbox", name), memory(name, `${name}.`), "utf8")
    }
    const dirty = (path: string) => run(plumbingIn(root).dirtyPaths([path]))

    const names = [
      "GIT_LITERAL_PATHSPECS",
      "GIT_NOGLOB_PATHSPECS",
      "GIT_GLOB_PATHSPECS",
      "GIT_ICASE_PATHSPECS"
    ] as const
    for (const name of names) {
      const saved = process.env[name]
      process.env[name] = "1"
      try {
        expect(await dirty("areas/inbox/a[b].html"), name).toEqual(["areas/inbox/a[b].html"])
        expect(await dirty("AREAS/INBOX/AB.HTML"), name).toEqual([])
      } finally {
        if (saved === undefined) delete process.env[name]
        else process.env[name] = saved
      }
    }
  })
})
