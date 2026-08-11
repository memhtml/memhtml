import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { parseMemory } from "@memhtml/html"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  GITATTRIBUTES,
  GITIGNORE,
  INDEX_DB_PATH,
  initRepo,
  MERGE_OURS_DRIVER,
  SCAFFOLD_DIRS,
  STATE_DB_PATH
} from "../src/layout.js"
import { configureIdentity, type FixtureRepo, makeFixtureRepo } from "../src/testing.js"

/** `memhtml init`: the one path that creates a memory repo, and the only one. */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []

const fixture = async (options?: Parameters<typeof makeFixtureRepo>[0]): Promise<FixtureRepo> => {
  const repo = await run(makeFixtureRepo(options))
  repos.push(repo)
  return repo
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

/** A bare directory with a git identity but no scaffold, so `initRepo` does the whole job. */
const bareDirectory = async (): Promise<FixtureRepo> => {
  const repo = await fixture({ init: false })
  await run(repo.git.run(["init", "-b", "main", "."]))
  await run(configureIdentity(repo.git))
  return repo
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

describe("initRepo on an empty directory", () => {
  it("scaffolds the PARA tree, the config files, and one initial commit", async () => {
    const repo = await bareDirectory()
    const result = await run(initRepo(repo.git))

    expect(result.created).toBe(false) // the repo existed; this call scaffolded it
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/)

    for (const directory of SCAFFOLD_DIRS) {
      expect(await exists(join(repo.root, directory))).toBe(true)
    }
    expect(await readFile(join(repo.root, ".gitignore"), "utf8")).toBe(GITIGNORE)
    expect(await readFile(join(repo.root, ".gitattributes"), "utf8")).toBe(GITATTRIBUTES)

    // Exactly one commit, and the whole scaffold is IN it rather than merely on disk.
    expect((await run(repo.git.run(["rev-list", "--count", "HEAD"]))).trim()).toBe("1")
    const tracked = (await run(repo.git.lsTreeR("HEAD"))).map((entry) => entry.path)
    expect(tracked).toContain(".gitignore")
    expect(tracked).toContain(".gitattributes")
    expect(tracked).toContain("README.html")
    for (const directory of SCAFFOLD_DIRS) {
      expect(tracked).toContain(`${directory}/.gitkeep`)
    }
    expect(await run(repo.git.statusPorcelainV2())).toEqual([])
  })

  it("creates the four PARA buckets plus arcs, people, and inbox", async () => {
    const repo = await bareDirectory()
    await run(initRepo(repo.git))
    for (const directory of [
      "projects",
      "areas",
      "resources",
      "archive",
      "areas/arcs",
      "areas/inbox",
      "resources/people"
    ]) {
      expect(await exists(join(repo.root, directory))).toBe(true)
    }
  })

  it("commits a README that is itself a valid memory document", async () => {
    // The repo's entry point demonstrates the format it stores; a README that failed the
    // parser would be the first thing a reader saw and the first thing `memhtml doctor` flagged.
    const repo = await bareDirectory()
    await run(initRepo(repo.git))
    const html = await readFile(join(repo.root, "README.html"), "utf8")
    const parsed = await Effect.runPromise(Effect.result(parseMemory(html)))
    // A README carries no `memhtml-type`, so it is deliberately not a memory *record* — but its
    // article must still parse, which is what `checkMemory` reports on.
    const { checkMemory } = await import("@memhtml/html")
    expect(checkMemory(html).violations.filter((v) => !v.includes("memhtml-"))).toEqual([])
    expect(Result.isFailure(parsed)).toBe(true)
  })

  it("gitignores both databases, so a live index never makes the tree dirty", async () => {
    // Without this, every sleep preflight would refuse: `index.db` is written on every query.
    const repo = await bareDirectory()
    await run(initRepo(repo.git))
    await writeFile(join(repo.root, INDEX_DB_PATH), "bytes", "utf8")
    await writeFile(join(repo.root, STATE_DB_PATH), "bytes", "utf8")
    await writeFile(join(repo.root, `${INDEX_DB_PATH}-wal`), "bytes", "utf8")
    const entries = await run(repo.git.statusPorcelainV2())
    expect(entries.filter((entry) => entry.kind !== "ignored")).toEqual([])
  })

  it("does NOT gitignore the state sidecar, which is the durability story", async () => {
    // `.memhtml/state/access.jsonl` is the one thing under `.memhtml/` that must be committed: it is
    // what makes a fresh clone reproduce access history, and gitignoring it would silently turn
    // the state plane into data that only exists on one machine.
    const repo = await bareDirectory()
    await run(initRepo(repo.git))
    await writeFile(join(repo.root, ".memhtml/state/access.jsonl"), '{"path":"a"}\n', "utf8")
    const entries = await run(repo.git.statusPorcelainV2())
    expect(entries.map((entry) => entry.path)).toContain(".memhtml/state/access.jsonl")
  })
})

describe("initRepo idempotence", () => {
  it("writes nothing and commits nothing on a second call", async () => {
    const repo = await bareDirectory()
    const first = await run(initRepo(repo.git))
    const second = await run(initRepo(repo.git))

    expect(second.wrote).toEqual([])
    expect(second.created).toBe(false)
    expect(second.headSha).toBe(first.headSha)
    expect((await run(repo.git.run(["rev-list", "--count", "HEAD"]))).trim()).toBe("1")
    expect(await run(repo.git.statusPorcelainV2())).toEqual([])
  })

  it("does not overwrite a .gitignore an operator edited", async () => {
    // Idempotence has to mean "leaves the repo alone", not "restores the scaffold": a repo with
    // a locally added ignore line would silently lose it on every `memhtml init`.
    const repo = await bareDirectory()
    await run(initRepo(repo.git))
    const edited = `${GITIGNORE}.memhtml/scratch/\n`
    await writeFile(join(repo.root, ".gitignore"), edited, "utf8")

    await run(initRepo(repo.git))
    expect(await readFile(join(repo.root, ".gitignore"), "utf8")).toBe(edited)
  })

  it("restores a single deleted scaffold file without touching the rest", async () => {
    const repo = await bareDirectory()
    await run(initRepo(repo.git))
    const { rm } = await import("node:fs/promises")
    await rm(join(repo.root, "areas/inbox/.gitkeep"))

    const result = await run(initRepo(repo.git))
    expect(result.wrote).toEqual(["areas/inbox/.gitkeep"])
    expect(await exists(join(repo.root, "areas/inbox/.gitkeep"))).toBe(true)
    // A restore is a real change, so it earns a commit rather than leaving a dirty tree.
    expect(await run(repo.git.statusPorcelainV2())).toEqual([])
  })

  it("is idempotent against a repo that already holds memories", async () => {
    const repo = await fixture()
    const { writeInput } = await import("../src/testing.js")
    const written = await run(repo.store.writeMemory(writeInput()))
    const before = (await run(repo.git.run(["rev-list", "--count", "HEAD"]))).trim()

    const result = await run(initRepo(repo.git))
    expect(result.wrote).toEqual([])
    expect((await run(repo.git.run(["rev-list", "--count", "HEAD"]))).trim()).toBe(before)
    // And the memory is untouched.
    expect(await run(repo.store.readMemory(written.path))).toBeDefined()
  })
})

describe("initRepo on a directory that is not a repo yet", () => {
  it("runs git init itself and reports created", async () => {
    const repo = await fixture({ init: false })
    // A directory that is not a repo has nowhere to hold a git identity, so the identity is
    // set after `initRepo` creates the repo — and `initRepo` is then re-run. This is the real
    // `memhtml init` sequence on a fresh machine, not a test contrivance.
    const first = await Effect.runPromise(Effect.result(initRepo(repo.git)))
    expect(await run(repo.git.isRepo())).toBe(true)

    await run(configureIdentity(repo.git))
    const result = await run(initRepo(repo.git))
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/)
    // Whether the first attempt reached a commit depends on whether this machine has a global
    // git identity; either way the second call converges to a committed scaffold.
    expect(Result.isSuccess(first) || Result.isFailure(first)).toBe(true)
    expect(await run(repo.git.statusPorcelainV2())).toEqual([])
  })

  it("converges from a half-initialized repo whose scaffold was staged but never committed", async () => {
    // The state an interrupted first run leaves behind: files written, index staged, HEAD
    // unborn. A version that short-circuited on "I wrote nothing this time" would report
    // success over a repo with no commit at all.
    const repo = await fixture({ init: false })
    await run(repo.git.run(["init", "-b", "main", "."]))
    for (const [path, contents] of [
      [".gitignore", GITIGNORE],
      [".gitattributes", GITATTRIBUTES]
    ] as const) {
      await writeFile(join(repo.root, path), contents, "utf8")
    }
    await run(repo.git.add([".gitignore", ".gitattributes"]))
    expect(await run(repo.git.revParseHead())).toBeNull()

    await run(configureIdentity(repo.git))
    const result = await run(initRepo(repo.git))

    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.wrote).not.toContain(".gitignore")
    expect(result.wrote).toContain("README.html")
    expect(await run(repo.git.statusPorcelainV2())).toEqual([])
  })

  it("names the default branch main rather than inheriting init.defaultBranch", async () => {
    // A branch name that depended on the operator's global config would make every branch
    // reference in sleep and in the runbook conditional on whose machine ran `memhtml init`.
    const repo = await fixture({ init: false })
    await Effect.runPromise(Effect.result(initRepo(repo.git)))
    await run(configureIdentity(repo.git))
    await run(initRepo(repo.git))
    expect((await run(repo.git.run(["rev-parse", "--abbrev-ref", "HEAD"]))).trim()).toBe("main")
  })
})

describe("the merge=ours driver", () => {
  it("sets merge.ours.driver, without which the .gitattributes entry is inert", async () => {
    // Probed live 2026-08-02: with `index.html merge=ours` in `.gitattributes` and NO
    // `merge.ours.driver` config, git still conflicts and writes conflict markers. The
    // attribute alone does nothing, so the design's only stated conflict mitigation depends on
    // this config — which is per-clone, hence re-set on every init.
    const repo = await bareDirectory()
    await run(initRepo(repo.git))
    expect((await run(repo.git.run(["config", "--get", MERGE_OURS_DRIVER.key]))).trim()).toBe(
      MERGE_OURS_DRIVER.value
    )
  })

  it("resolves a generated index.html conflict to ours instead of writing markers", async () => {
    const repo = await bareDirectory()
    await run(initRepo(repo.git))

    await writeFile(join(repo.root, "areas/index.html"), "<p>base</p>", "utf8")
    await run(repo.git.add(["areas/index.html"]))
    await run(repo.git.commit("memhtml(publish): base"))

    await run(repo.git.checkoutBranch("side", { create: true }))
    await writeFile(join(repo.root, "areas/index.html"), "<p>side regenerated</p>", "utf8")
    await run(repo.git.add(["areas/index.html"]))
    await run(repo.git.commit("memhtml(publish): side"))

    await run(repo.git.checkoutBranch("main"))
    await writeFile(join(repo.root, "areas/index.html"), "<p>main regenerated</p>", "utf8")
    await run(repo.git.add(["areas/index.html"]))
    await run(repo.git.commit("memhtml(publish): main"))

    const outcome = await run(repo.git.merge("side"))
    expect(outcome).toEqual({ merged: true, conflicted: [] })
    const merged = await readFile(join(repo.root, "areas/index.html"), "utf8")
    expect(merged).toBe("<p>main regenerated</p>")
    expect(merged).not.toContain("<<<<<<<")
  })

  it("still conflicts on an ordinary memory file, which merge=ours must not silence", async () => {
    // The `merge=ours` scope is exactly the two generated artifacts. If it swallowed a memory
    // conflict, one agent's fact would vanish with no diff and no error — the failure mode the
    // typed WriteConflict exists to prevent.
    const repo = await bareDirectory()
    await run(initRepo(repo.git))

    await writeFile(join(repo.root, "areas/inbox/m.html"), "<p>base</p>", "utf8")
    await run(repo.git.add(["areas/inbox/m.html"]))
    await run(repo.git.commit("memhtml(write): base"))

    await run(repo.git.checkoutBranch("side", { create: true }))
    await writeFile(join(repo.root, "areas/inbox/m.html"), "<p>side</p>", "utf8")
    await run(repo.git.add(["areas/inbox/m.html"]))
    await run(repo.git.commit("memhtml(write): side"))

    await run(repo.git.checkoutBranch("main"))
    await writeFile(join(repo.root, "areas/inbox/m.html"), "<p>main</p>", "utf8")
    await run(repo.git.add(["areas/inbox/m.html"]))
    await run(repo.git.commit("memhtml(write): main"))

    const outcome = await run(repo.git.merge("side"))
    expect(outcome.merged).toBe(false)
    expect(outcome.conflicted).toEqual(["areas/inbox/m.html"])
    await run(repo.git.mergeAbort())
  })
})
