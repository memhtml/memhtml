import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { SNAPSHOTS_DIR, snapshotPathFor, writeSnapshot } from "@memhtml/snapshot"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { codeFor, messageFor } from "../src/errors.js"
import {
  findAncestorSnapshot,
  loadVersion,
  snapshotAfterCommit,
  writeHeadSnapshot
} from "../src/head-cache.js"
import { headGate } from "../src/head-gate.js"
import { loadHeadAt } from "../src/v2.js"

/**
 * The head's cold-start cache on both sides (`head-cache.ts`) and the gate over it (`head-gate.ts`).
 *
 * Every claim about what a load cost is read from the payload's `source`, `ancestorSha`, and
 * `reparsed`; every claim about the tree is checked against git independently (`ls-tree`, `status`).
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `loadVersion`: drop the `findAncestorSnapshot` branch -> "advances the newest ancestor snapshot
 *   when the target has none" (`source` is `git`).
 * - `findAncestorSnapshot`: drop the `isAncestor` filter -> "ignores a snapshot that is not an
 *   ancestor of the target" (a snapshot of the side branch is advanced from).
 * - `findAncestorSnapshot`: `changed < best.changed` -> `changed > best.changed` -> "picks the
 *   ancestor with the fewest changed paths" (the older snapshot wins).
 * - `snapshotAfterCommit`: drop the `Effect.catch` -> "answers null and does not fail when the
 *   snapshot directory cannot be written" (the effect fails with `StorageFailure`).
 * - `writeHeadSnapshot`: drop the `pruneSnapshots` call -> "prunes to the newest four after a write".
 * - `headGate`: `if (report.passed)` -> "fails with HeadGateFailed, mapped to
 *   ERR_DISCRIMINATION_FAILED, when the landed version finds a probe worse".
 */

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const WORDS = [
  "harbor",
  "glacier",
  "orchard",
  "furnace",
  "lantern",
  "compass",
  "quarry",
  "saddle",
  "turbine",
  "velvet",
  "anvil",
  "beacon"
]

const memory = (word: string, at = "2026-03-01T12:00:00Z", claim?: string) => ({
  path: `areas/inbox/${word}.html`,
  html: renderTemplate({
    title: word,
    claim: claim ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)} facts are recorded here.`,
    memoryType: "semantic",
    at
  })
})

const commit = async (
  repo: FixtureRepo,
  files: ReadonlyArray<{ readonly path: string; readonly html: string | null }>,
  message = "fixture"
): Promise<string> => {
  for (const file of files) {
    const target = join(repo.root, file.path)
    if (file.html === null) await rm(target, { force: true })
    else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.html, "utf8")
    }
  }
  await run(repo.git.run(["add", "-A"]))
  await run(repo.git.run(["commit", "-q", "--allow-empty", "-m", message]))
  const sha = await run(repo.git.revParseHead())
  if (sha === null) throw new Error("no HEAD")
  return sha
}

/** A repo with the first `count` words committed as memories, on top of the scaffold. */
const corpus = async (count: number): Promise<{ repo: FixtureRepo; sha: string }> => {
  const repo = await run(makeFixtureRepo())
  repos.push(repo)
  const sha = await commit(
    repo,
    WORDS.slice(0, count).map((word) => memory(word)),
    "corpus"
  )
  return { repo, sha }
}

const status = (repo: FixtureRepo): Promise<string> =>
  run(repo.git.run(["status", "--porcelain"])).then((out) => out.trim())

describe("loadVersion", () => {
  it("reads git when no snapshot exists, its own snapshot when one does, and both agree", async () => {
    const { repo, sha } = await corpus(6)
    const fromGit = await run(loadVersion(repo.root, sha))
    expect(fromGit).toMatchObject({ source: "git", snapshotPath: null, ancestorSha: null })
    expect(fromGit.version.size).toBe(6)

    const written = await run(writeHeadSnapshot(repo.root, fromGit.version))
    expect(written).toMatchObject({
      sha,
      path: snapshotPathFor(repo.root, sha),
      rows: 6,
      pruned: []
    })
    expect(written.bytes).toBeGreaterThan(0)
    expect(written.ms).toBeGreaterThanOrEqual(0)
    // The write left the tree clean: the scaffold's .gitignore names the directory.
    expect(await status(repo)).toBe("")

    const fromSnapshot = await run(loadVersion(repo.root, sha))
    expect(fromSnapshot).toMatchObject({
      source: "snapshot",
      snapshotPath: written.path,
      ancestorSha: null,
      reparsed: null
    })
    expect([...fromSnapshot.version.paths()].sort()).toEqual([...fromGit.version.paths()].sort())
    // `source: "git"` forces the tree read even with the snapshot present.
    expect((await run(loadVersion(repo.root, sha, "git"))).source).toBe("git")
  })

  it("advances the newest ancestor snapshot when the target has none, re-parsing only the changed paths", async () => {
    const { repo, sha } = await corpus(6)
    const base = await run(loadVersion(repo.root, sha))
    await run(writeHeadSnapshot(repo.root, base.version))

    const edited = memory("harbor", "2026-04-01T12:00:00Z", "Harbor facts were revised.")
    const added = memory("anvil")
    const removed = memory("compass")
    const next = await commit(repo, [edited, added, { path: removed.path, html: null }], "delta")

    const loaded = await run(loadHeadAt(repo.root, next))
    expect(loaded).toMatchObject({
      sha: next,
      source: "snapshot+advance",
      ancestorSha: sha,
      snapshotPath: snapshotPathFor(repo.root, sha),
      reparsed: 3,
      skipped: null,
      records: 6
    })
    // The advanced version matches an independent tree read.
    const tree = (await run(repo.git.run(["ls-tree", "-r", "--name-only", "-z", next])))
      .split("\0")
      .filter((path) => path.endsWith(".html") && path !== "README.html")
      .sort()
    expect([...loaded.view.paths()].sort()).toEqual(tree)
    expect(loaded.view.get(edited.path)?.claim).toBe("Harbor facts were revised.")
    expect(loaded.view.get(removed.path)).toBeUndefined()
    expect(loaded.view.get(added.path)?.title).toBe("anvil")
    // And it is an advanced version: untouched records are the snapshot's objects.
    const parent = loaded.view.parent
    expect(parent?.sha).toBe(sha)
    expect(loaded.view.get(memory("glacier").path)).toBe(parent?.get(memory("glacier").path))
  })

  it("picks the ancestor with the fewest changed paths, ignoring a snapshot that is not an ancestor", async () => {
    const { repo, sha: first } = await corpus(4)
    await run(writeHeadSnapshot(repo.root, (await run(loadVersion(repo.root, first))).version))
    const second = await commit(repo, [memory("lantern"), memory("compass")], "second")
    await run(writeHeadSnapshot(repo.root, (await run(loadVersion(repo.root, second))).version))

    // A side branch off `first` with its own snapshot: newer by mtime, not an ancestor of main.
    await run(repo.git.run(["checkout", "-q", "-b", "side", first]))
    const side = await commit(repo, [memory("quarry")], "side")
    await run(writeHeadSnapshot(repo.root, (await run(loadVersion(repo.root, side))).version))
    await run(repo.git.run(["checkout", "-q", "main"]))

    const third = await commit(repo, [memory("saddle")], "third")
    const chosen = await run(findAncestorSnapshot(repo.root, third))
    expect(chosen).toEqual({ sha: second, path: snapshotPathFor(repo.root, second), changed: 1 })
    const loaded = await run(loadVersion(repo.root, third))
    expect(loaded).toMatchObject({ source: "snapshot+advance", ancestorSha: second, reparsed: 1 })
    expect(loaded.version.get(memory("quarry").path)).toBeUndefined()
    expect(loaded.version.size).toBe(7)

    // A target with only non-ancestor snapshots falls back to git.
    for (const entry of await readdir(join(repo.root, SNAPSHOTS_DIR))) {
      if (!entry.startsWith(side)) await rm(join(repo.root, SNAPSHOTS_DIR, entry))
    }
    expect(await run(findAncestorSnapshot(repo.root, third))).toBeNull()
    expect((await run(loadVersion(repo.root, third))).source).toBe("git")
  })

  it("refuses an exact snapshot whose metadata names another sha, and skips such an ancestor", async () => {
    const { repo, sha } = await corpus(3)
    const version = (await run(loadVersion(repo.root, sha))).version
    const other = "0".repeat(40)
    await run(
      writeSnapshot({
        records: version.records(),
        sha: other,
        path: snapshotPathFor(repo.root, sha)
      })
    )
    const refused = await run(Effect.result(loadVersion(repo.root, sha)))
    expect(Result.isFailure(refused)).toBe(true)
    if (Result.isFailure(refused)) {
      expect(refused.failure).toMatchObject({
        _tag: "StorageFailure",
        operation: "snapshot.sha-mismatch"
      })
    }
    const next = await commit(repo, [memory("anvil")], "next")
    expect((await run(loadVersion(repo.root, next))).source).toBe("git")
  })
})

describe("snapshotAfterCommit", () => {
  it("writes the snapshot for the new sha from the committed-against version, then loads hit it", async () => {
    const { repo, sha } = await corpus(4)
    const base = await run(loadHeadAt(repo.root, sha))
    const next = await commit(repo, [memory("anvil")], "next")
    const written = await run(snapshotAfterCommit(repo.root, next, base.view))
    expect(written).toMatchObject({ sha: next, path: snapshotPathFor(repo.root, next), rows: 5 })
    expect((await run(loadHeadAt(repo.root, next))).source).toBe("snapshot")
    expect(await status(repo)).toBe("")
  })

  it("loads the version itself when no base is given", async () => {
    const { repo, sha } = await corpus(3)
    const written = await run(snapshotAfterCommit(repo.root, sha))
    expect(written?.rows).toBe(3)
  })

  it("answers null and does not fail when the snapshot directory cannot be written", async () => {
    const { repo, sha } = await corpus(2)
    // A regular file where the directory must go: `mkdir -p` fails with ENOTDIR.
    await mkdir(join(repo.root, ".memhtml"), { recursive: true })
    await writeFile(join(repo.root, SNAPSHOTS_DIR), "not a directory", "utf8")
    const result = await run(Effect.result(snapshotAfterCommit(repo.root, sha)))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(result.success).toBeNull()
    await chmod(join(repo.root, SNAPSHOTS_DIR), 0o644)
  })

  it("prunes to the newest four after a write and reports what went", async () => {
    const { repo, sha } = await corpus(2)
    let head = await run(loadHeadAt(repo.root, sha))
    const shas: Array<string> = [sha]
    let written = await run(snapshotAfterCommit(repo.root, sha, head.view))
    for (const word of ["orchard", "furnace", "lantern", "compass", "quarry"]) {
      const next = await commit(repo, [memory(word)], word)
      shas.push(next)
      written = await run(snapshotAfterCommit(repo.root, next, head.view))
      head = await run(loadHeadAt(repo.root, next))
    }
    // Six writes, four kept: the two oldest went, the last one on this write.
    expect(written?.pruned).toEqual([shas[1]])
    const left = (await readdir(join(repo.root, SNAPSHOTS_DIR))).sort()
    expect(left).toEqual(
      shas
        .slice(2)
        .map((s) => `${s}.arrow`)
        .sort()
    )
  })
})

describe("headGate", () => {
  it("passes a landing that adds a record and reports both commits", async () => {
    const { repo, sha } = await corpus(6)
    const next = await commit(repo, [memory("anvil")], "add")
    const report = await run(headGate({ root: repo.root, from: sha, to: next, load: loadHeadAt }))
    expect(report).toMatchObject({
      mode: "head",
      passed: true,
      base: sha,
      landed: next,
      probes: 6,
      mrr: 1,
      mrrBefore: 1,
      inversions: [],
      inversionsBefore: 0,
      added: 1,
      removed: 0
    })
  })

  it("fails with HeadGateFailed, mapped to ERR_DISCRIMINATION_FAILED, when the landed version finds a probe worse", async () => {
    const { repo, sha } = await corpus(6)
    // A twin of `harbor` with the same title that says "harbor" once more in its claim: the lexical
    // arm puts the twin first, and at k = 1 the original falls out.
    const twin = {
      path: "areas/inbox/harbor2.html",
      html: renderTemplate({
        title: "harbor",
        claim: "Harbor facts are recorded in the harbor log.",
        memoryType: "semantic",
        at: "2026-06-01T12:00:00Z"
      })
    }
    const next = await commit(repo, [twin], "twin")
    const result = await run(
      Effect.result(
        headGate({
          root: repo.root,
          from: sha,
          to: next,
          load: loadHeadAt,
          options: { k: 1, tolerance: 1 }
        })
      )
    )
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    const failure = result.failure
    expect(failure._tag).toBe("HeadGateFailed")
    if (failure._tag !== "HeadGateFailed") return
    expect(failure.report.inversions).toEqual([
      { kind: "fell-out", path: "areas/inbox/harbor.html", query: "harbor" }
    ])
    expect(codeFor(failure)).toBe("ERR_DISCRIMINATION_FAILED")
    expect(messageFor(failure)).toContain("1 inversion(s) against 0 before")
  })
})
