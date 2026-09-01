import { subscribe, unsubscribe } from "node:diagnostics_channel"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { GitFailure, makeGit } from "../src/git.js"
import { SESSION_TRAILER } from "../src/plumbing.js"
import { configureIdentity, type FixtureRepo, makeFixtureRepo } from "../src/testing.js"

/**
 * The git service against the real git binary in temp-dir repos.
 *
 * There is no fake git in this package and there will not be one. Its subject is git's own
 * behavior — what rename detection scores, what the index holds mid-conflict, what `mv`
 * refuses — and a fake would verify that the right argv was assembled while missing every one
 * of those. The standing lesson about fakes, applied where the "real adapter" IS the feature.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** Run and require a failure, returning it. `Effect.result`, since `Effect.either` does not exist. */
const runErr = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error("expected a failure, got a value")
  return result.failure
}

const repos: Array<FixtureRepo> = []

const fixture = async (options?: Parameters<typeof makeFixtureRepo>[0]): Promise<FixtureRepo> => {
  const repo = await run(makeFixtureRepo(options))
  repos.push(repo)
  return repo
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await rm("/tmp/memhtml-store-absent-root-xyzzy", { recursive: true, force: true })
})

/** Write a file under the repo, creating its directory. */
const put = async (root: string, path: string, contents: string): Promise<void> => {
  await mkdir(join(root, path, ".."), { recursive: true })
  await writeFile(join(root, path), contents, "utf8")
}

describe("revParseHead and isRepo", () => {
  it("reads the HEAD sha of a scaffolded repo", async () => {
    const repo = await fixture()
    const head = await run(repo.git.revParseHead())
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(await run(repo.git.isRepo())).toBe(true)
  })

  it("reads an unborn HEAD as null rather than failing", async () => {
    // `rev-parse HEAD` exits 128 on a repo with no commit. That is a state `initRepo`
    // legitimately observes on the way to making the first commit, so it is a value.
    const repo = await fixture({ init: false })
    await run(repo.git.run(["init", "-b", "main", "."]))
    expect(await run(repo.git.revParseHead())).toBeNull()
  })

  it("reports a plain directory as not a repo", async () => {
    const repo = await fixture({ init: false })
    expect(await run(repo.git.isRepo())).toBe(false)
  })
})

describe("lsTreeR", () => {
  it("lists every blob of the tree in one call", async () => {
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await put(repo.root, "projects/y/b.html", "<p>b</p>")
    await run(repo.git.add(["areas/x/a.html", "projects/y/b.html"]))
    await run(repo.git.commit("memhtml(write): two"))

    const entries = await run(repo.git.lsTreeR("HEAD", ["areas", "projects"]))
    const html = entries.filter((entry) => entry.path.endsWith(".html"))
    expect(html.map((entry) => entry.path).sort()).toEqual(["areas/x/a.html", "projects/y/b.html"])
    expect(html.every((entry) => /^[0-9a-f]{40}$/.test(entry.sha))).toBe(true)
  })

  it("fails typed on an unknown commitish rather than throwing", async () => {
    const repo = await fixture()
    const failure = await runErr(repo.git.lsTreeR("no-such-ref"))
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure.command).toBe("ls-tree")
    expect(failure.exitCode).not.toBe(0)
  })
})

describe("hashObject", () => {
  it("agrees with the blob sha the tree records", async () => {
    // The indexer's change key is free precisely because of this equality: a working-tree file's
    // hash-object output is the same sha it will carry in the tree.
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>content</p>")
    const hashed = await run(repo.git.hashObject("areas/x/a.html"))
    await run(repo.git.add(["areas/x/a.html"]))
    await run(repo.git.commit("memhtml(write): a"))
    const entries = await run(repo.git.lsTreeR("HEAD", ["areas/x/a.html"]))
    expect(entries[0]?.sha).toBe(hashed)
  })
})

describe("catFileBatch", () => {
  it("streams 50 blobs in ONE subprocess", async () => {
    // The design's reason for the batch: a full rebuild reads the whole corpus with one process
    // rather than one per file.
    const repo = await fixture()
    const paths: Array<string> = []
    const bodyOfIndex = new Map<string, string>()
    for (let index = 0; index < 50; index += 1) {
      const path = `areas/bulk/m-${index}.html`
      const body = `<p>memory number ${index}</p>`
      await put(repo.root, path, body)
      bodyOfIndex.set(path, body)
      paths.push(path)
    }
    await run(repo.git.add(paths))
    await run(repo.git.commit("memhtml(write): fifty"))

    const entries = (await run(repo.git.lsTreeR("HEAD", ["areas/bulk"]))).filter((entry) =>
      entry.path.endsWith(".html")
    )
    expect(entries).toHaveLength(50)

    const [blobs, spawns] = await countingSpawns(() =>
      run(repo.git.catFileBatch(entries.map((entry) => entry.sha)))
    )

    // Not "one call" — one PROCESS, for all fifty blobs.
    expect(spawns).toBe(1)
    expect(blobs.size).toBe(50)
    // Every blob is paired with its OWN path's body: a batch that returned the right count with
    // shifted framing would satisfy a size assertion alone.
    for (const entry of entries) {
      const body = Buffer.from(blobs.get(entry.sha) ?? new Uint8Array()).toString("utf8")
      expect(body).toBe(bodyOfIndex.get(entry.path))
    }
  })

  it("reads a body containing multibyte characters back byte-identical", async () => {
    const repo = await fixture()
    const body = "<p>a — dash, an emoji 🜛, and a nbsp here</p>"
    await put(repo.root, "areas/x/uni.html", body)
    await run(repo.git.add(["areas/x/uni.html"]))
    await run(repo.git.commit("memhtml(write): unicode"))
    const [entry] = await run(repo.git.lsTreeR("HEAD", ["areas/x/uni.html"]))
    const blobs = await run(repo.git.catFileBatch([entry?.sha ?? ""]))
    expect(Buffer.from(blobs.get(entry?.sha ?? "") ?? new Uint8Array()).toString("utf8")).toBe(body)
  })

  it("spawns nothing for an empty sha list", async () => {
    const repo = await fixture()
    const [blobs, spawns] = await countingSpawns(() => run(repo.git.catFileBatch([])))
    expect(blobs).toEqual(new Map())
    expect(spawns).toBe(0)
  })
})

describe("mv and diffNameStatus", () => {
  it("reports a pure git mv as R100", async () => {
    // The archive mapping is injective, and a move with no other change is exactly R100 — the
    // ceiling every archive-with-stamps case is measured against.
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    await run(repo.git.commit("memhtml(write): a"))
    const base = await run(repo.git.revParseHead())

    await mkdir(join(repo.root, "archive/2026/areas/x"), { recursive: true })
    await run(repo.git.mv("areas/x/a.html", "archive/2026/areas/x/a.html"))
    await run(repo.git.commit("memhtml(archive): a"))

    const changes = await run(repo.git.diffNameStatus(base ?? "", "HEAD"))
    expect(changes).toEqual([
      {
        kind: "renamed",
        path: "archive/2026/areas/x/a.html",
        fromPath: "areas/x/a.html",
        similarity: 100
      }
    ])
  })

  it("refuses a move into a directory that does not exist", async () => {
    // Probed live: `fatal: renaming … failed: No such file or directory`. The archive's year
    // partition is new every January, so the store mkdirs before every `mv`.
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    await run(repo.git.commit("memhtml(write): a"))

    const failure = await runErr(repo.git.mv("areas/x/a.html", "archive/2099/areas/x/a.html"))
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure.command).toBe("mv")
  })
})

describe("commit", () => {
  it("stamps trailers below the subject", async () => {
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    const result = await run(
      repo.git.commit("memhtml(write): a", { trailers: { [SESSION_TRAILER]: "sess-1" } })
    )
    expect(result.empty).toBe(false)
    const body = await run(repo.git.run(["log", "-1", "--format=%B"]))
    expect(body).toContain("memhtml(write): a")
    expect(body).toContain(`${SESSION_TRAILER}: sess-1`)
  })

  it("is a no-op with nothing staged, rather than a failure or an empty commit", async () => {
    // `git commit` exits 1 with an empty index. Treating that as a failure would make every
    // deduped write look broken; making an empty commit would put noise in the history.
    const repo = await fixture()
    const before = await run(repo.git.revParseHead())
    const result = await run(repo.git.commit("memhtml(write): nothing"))
    expect(result).toEqual({ sha: null, empty: true })
    expect(await run(repo.git.revParseHead())).toBe(before)
  })

  it("returns the new commit's sha", async () => {
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    const result = await run(repo.git.commit("memhtml(write): a"))
    expect(result.sha).toBe(await run(repo.git.revParseHead()))
  })
})

describe("statusPorcelainV2", () => {
  it("reports a modified tracked file, an untracked file, and nothing else", async () => {
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    await run(repo.git.commit("memhtml(write): a"))

    await put(repo.root, "areas/x/a.html", "<p>changed</p>")
    await put(repo.root, "areas/x/new.html", "<p>new</p>")

    const entries = await run(repo.git.statusPorcelainV2())
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    expect(byPath.get("areas/x/a.html")?.kind).toBe("changed")
    expect(byPath.get("areas/x/new.html")?.kind).toBe("untracked")
  })

  it("does not report the gitignored index databases", async () => {
    // The `.gitignore` scaffolding is what keeps a live index from making every tree dirty and
    // every sleep preflight refuse.
    const repo = await fixture()
    await put(repo.root, ".memhtml/index.db", "not really a database")
    await put(repo.root, ".memhtml/state.db", "nor this")
    const entries = await run(repo.git.statusPorcelainV2())
    expect(entries.filter((entry) => entry.kind !== "ignored")).toEqual([])
  })

  it("is empty on the clean tree initRepo leaves behind", async () => {
    const repo = await fixture()
    expect(await run(repo.git.statusPorcelainV2())).toEqual([])
  })
})

describe("branches", () => {
  it("creates, finds, and fast-forwards a branch", async () => {
    const repo = await fixture()
    expect(await run(repo.git.branchExists("sleep/2026-08-02"))).toBe(false)

    await run(repo.git.checkoutBranch("sleep/2026-08-02", { create: true }))
    expect(await run(repo.git.branchExists("sleep/2026-08-02"))).toBe(true)

    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    const onBranch = await run(repo.git.commit("memhtml(write): on branch"))

    await run(repo.git.checkoutBranch("main"))
    await run(repo.git.mergeFastForward("sleep/2026-08-02"))
    expect(await run(repo.git.revParseHead())).toBe(onBranch.sha)
  })

  it("fails typed when a fast-forward is not possible", async () => {
    const repo = await fixture()
    await run(repo.git.checkoutBranch("side", { create: true }))
    await put(repo.root, "areas/x/side.html", "<p>side</p>")
    await run(repo.git.add(["areas/x/side.html"]))
    await run(repo.git.commit("memhtml(write): side"))

    await run(repo.git.checkoutBranch("main"))
    await put(repo.root, "areas/x/main.html", "<p>main</p>")
    await run(repo.git.add(["areas/x/main.html"]))
    await run(repo.git.commit("memhtml(write): main"))

    const failure = await runErr(repo.git.mergeFastForward("side"))
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure.command).toBe("merge-ff")
  })
})

describe("diffTreeNames", () => {
  /**
   * One case per flag, and every one of them is a case about a SILENT answer. `diff-tree` reports
   * nothing for a merge commit, nothing for a root commit, and nothing for an abbreviated sha, all
   * at exit 0 — so a caller unioning paths would receive a smaller set and no error. These are the
   * flags' locks; drop any flag from `makeGit` and its case here goes red.
   */
  it("reports BOTH paths of a rename, so a caller sees the path that went away", async () => {
    /**
     * A this-run guard asking "which paths did these commits write" needs the pre-move path as much
     * as the post-move one, and `git diff --name-only` — which DOES detect renames — reports only
     * the destination. This is the behavior assertion for the difference, not a flag assertion:
     * `--no-renames` is inert on `diff-tree`, so this case is red only if the invocation stops being
     * a `diff-tree` or loses `-r`/`-z`.
     */
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>line one</p>\n<p>line two</p>\n")
    await run(repo.git.add(["areas/x/a.html"]))
    await run(repo.git.commit("memhtml(write): a"))

    await mkdir(join(repo.root, "areas/y"), { recursive: true })
    await run(repo.git.mv("areas/x/a.html", "areas/y/a.html"))
    const moved = await run(repo.git.commit("memhtml(write): move a"))

    expect([...(await run(repo.git.diffTreeNames([moved.sha ?? ""])))].sort()).toEqual([
      "areas/x/a.html",
      "areas/y/a.html"
    ])
  })

  it("returns a non-ASCII path unquoted, so it equals the path the index holds", async () => {
    // Under newline framing `core.quotePath` renders this as `"areas/x/caf\303\251.html"`, quotes
    // and octal escapes included, and a caller's `Set.has` against a real path never matches.
    const repo = await fixture()
    await put(repo.root, "areas/x/café.html", "<p>c</p>")
    await run(repo.git.add(["areas/x/café.html"]))
    const made = await run(repo.git.commit("memhtml(write): cafe"))

    expect(await run(repo.git.diffTreeNames([made.sha ?? ""]))).toEqual(["areas/x/café.html"])
  })

  it("reports a merge commit's paths rather than nothing", async () => {
    const repo = await fixture()
    await put(repo.root, "areas/x/base.html", "<p>base</p>")
    await run(repo.git.add(["areas/x/base.html"]))
    await run(repo.git.commit("memhtml(write): base"))
    const base = await run(repo.git.revParseHead())

    await run(repo.git.checkoutBranch("side", { create: true }))
    await put(repo.root, "areas/x/side.html", "<p>side</p>")
    await run(repo.git.add(["areas/x/side.html"]))
    await run(repo.git.commit("memhtml(write): side"))

    await run(repo.git.checkoutBranch("main"))
    await put(repo.root, "areas/x/main.html", "<p>main</p>")
    await run(repo.git.add(["areas/x/main.html"]))
    await run(repo.git.commit("memhtml(write): main"))
    await run(repo.git.run(["merge", "--no-ff", "-m", "merge side", "side"]))
    const merge = await run(repo.git.revParseHead())

    expect(merge).not.toBe(base)
    expect(await run(repo.git.diffTreeNames([merge ?? ""]))).toContain("areas/x/side.html")
  })

  it("reports a root commit's whole tree rather than nothing", async () => {
    const repo = await fixture({ init: false })
    await run(repo.git.run(["init", "-b", "main", "."]))
    await run(configureIdentity(repo.git))
    await put(repo.root, "areas/x/first.html", "<p>first</p>")
    await run(repo.git.add(["areas/x/first.html"]))
    const root = await run(repo.git.commit("memhtml(write): first"))

    expect(await run(repo.git.diffTreeNames([root.sha ?? ""]))).toEqual(["areas/x/first.html"])
  })

  it("unions many commits in ONE subprocess, with no sha among the paths", async () => {
    const repo = await fixture()
    const shas: Array<string> = []
    for (const name of ["one", "two", "three"]) {
      await put(repo.root, `areas/x/${name}.html`, `<p>${name}</p>`)
      await run(repo.git.add([`areas/x/${name}.html`]))
      const made = await run(repo.git.commit(`memhtml(write): ${name}`))
      shas.push(made.sha ?? "")
    }

    const [paths, spawns] = await countingSpawns(() => run(repo.git.diffTreeNames(shas)))
    expect(spawns).toBe(1)
    expect([...paths].sort()).toEqual([
      "areas/x/one.html",
      "areas/x/three.html",
      "areas/x/two.html"
    ])
    // Without `--no-commit-id` each commit's own 40-hex name arrives as a line among the paths.
    for (const path of paths) expect(path).not.toMatch(/^[0-9a-f]{40}$/)
  })

  it("refuses an abbreviated sha, which git answers with the short name and no diff", async () => {
    const repo = await fixture()
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    const made = await run(repo.git.commit("memhtml(write): a"))
    const short = (made.sha ?? "").slice(0, 7)

    const failure = await runErr(repo.git.diffTreeNames([short]))
    expect(failure).toBeInstanceOf(GitFailure)
    expect(failure.command).toBe("diff-tree")
    // The full name is what the same call accepts, so the refusal is about the FORM and nothing else.
    expect(await run(repo.git.diffTreeNames([made.sha ?? ""]))).toEqual(["areas/x/a.html"])
  })

  it("spawns nothing for an empty commit list", async () => {
    const repo = await fixture()
    const [paths, spawns] = await countingSpawns(() => run(repo.git.diffTreeNames([])))
    expect(paths).toEqual([])
    expect(spawns).toBe(0)
  })
})

describe("logTrailers", () => {
  it("reads one key's values per commit, empty for a commit carrying none", async () => {
    const repo = await fixture()
    const base = await run(repo.git.revParseHead())

    for (const phase of ["preflight", "dedup-merge"]) {
      await put(repo.root, `areas/x/${phase}.html`, `<p>${phase}</p>`)
      await run(repo.git.add([`areas/x/${phase}.html`]))
      await run(repo.git.commit(`sleep(${phase}): x`, { trailers: { "Memhtml-Phase": phase } }))
    }
    await put(repo.root, "areas/x/plain.html", "<p>plain</p>")
    await run(repo.git.add(["areas/x/plain.html"]))
    await run(repo.git.commit("memhtml(write): no trailer"))

    const records = await run(repo.git.logTrailers(`${base}..HEAD`, "Memhtml-Phase"))
    // Newest first, which is git's own order and what `sleep resume` reads.
    expect(records.map((record) => record.values)).toEqual([[], ["dedup-merge"], ["preflight"]])
  })

  it("reads a JSON trailer value back whole, commas and all", async () => {
    const repo = await fixture()
    const base = await run(repo.git.revParseHead())
    const counts = '{"candidates":31,"merged":7,"vetoed":4}'
    await put(repo.root, "areas/x/a.html", "<p>a</p>")
    await run(repo.git.add(["areas/x/a.html"]))
    await run(
      repo.git.commit("sleep(dedup-merge): fold", { trailers: { "Memhtml-Counts": counts } })
    )

    const records = await run(repo.git.logTrailers(`${base}..HEAD`, "Memhtml-Counts"))
    expect(records[0]?.values).toEqual([counts])
  })
})

describe("merge conflicts", () => {
  it("surfaces a conflict as a value with both index stages readable", async () => {
    // The contaminating state the design's concurrency section describes: two clones of one bare
    // repo racing on one file. A single-clone test cannot produce it.
    const origin = await fixture({ init: false })
    await run(origin.git.run(["init", "--bare", "-b", "main", "."]))

    const ours = await fixture({ init: false })
    const theirs = await fixture({ init: false })
    for (const clone of [ours, theirs]) {
      await run(clone.git.run(["clone", origin.root, "."]))
      await run(configureIdentity(clone.git))
    }

    await put(ours.root, "areas/x/f.html", "<p>base</p>")
    await run(ours.git.add(["areas/x/f.html"]))
    await run(ours.git.commit("memhtml(write): base"))
    await run(ours.git.run(["push", "origin", "HEAD:main"]))

    await run(theirs.git.run(["fetch", "origin"]))
    await run(theirs.git.run(["checkout", "-B", "main", "origin/main"]))

    // Both clones now edit the same file and both commit. First push wins.
    await put(ours.root, "areas/x/f.html", "<p>ours</p>")
    await run(ours.git.add(["areas/x/f.html"]))
    await run(ours.git.commit("memhtml(write): ours"))
    await run(ours.git.run(["push", "origin", "HEAD:main"]))

    await put(theirs.root, "areas/x/f.html", "<p>theirs</p>")
    await run(theirs.git.add(["areas/x/f.html"]))
    await run(theirs.git.commit("memhtml(write): theirs"))

    // The losing clone's push is refused, and a fast-forward is impossible.
    const pushFailure = await runErr(theirs.git.run(["push", "origin", "HEAD:main"]))
    expect(pushFailure).toBeInstanceOf(GitFailure)
    await run(theirs.git.run(["fetch", "origin"]))
    const ffFailure = await runErr(theirs.git.mergeFastForward("origin/main"))
    expect(ffFailure.command).toBe("merge-ff")

    // A three-way merge conflicts. That is a VALUE — an ordinary outcome of two agents writing.
    const outcome = await run(theirs.git.merge("origin/main"))
    expect(outcome.merged).toBe(false)
    expect(outcome.conflicted).toEqual(["areas/x/f.html"])

    const stages = await run(theirs.git.unmergedStages())
    const stageOf = (stage: number) =>
      stages.find((entry) => entry.path === "areas/x/f.html" && entry.stage === stage)?.sha
    expect(stageOf(1)).toMatch(/^[0-9a-f]{40}$/)
    expect(stageOf(2)).toMatch(/^[0-9a-f]{40}$/)
    expect(stageOf(3)).toMatch(/^[0-9a-f]{40}$/)
    expect(new Set([stageOf(1), stageOf(2), stageOf(3)]).size).toBe(3)

    // Stage 2 is this clone's own content, stage 3 the incoming one — not the other way round.
    const blobs = await run(theirs.git.catFileBatch([stageOf(2) ?? "", stageOf(3) ?? ""]))
    const bodyOf = (sha: string | undefined) =>
      Buffer.from(blobs.get(sha ?? "") ?? new Uint8Array()).toString("utf8")
    expect(bodyOf(stageOf(2))).toBe("<p>theirs</p>")
    expect(bodyOf(stageOf(3))).toBe("<p>ours</p>")

    await run(theirs.git.mergeAbort())
    // The abort restores the pre-merge state: the file is this clone's own content again.
    expect(await readFile(join(theirs.root, "areas/x/f.html"), "utf8")).toBe("<p>theirs</p>")
    expect(await run(theirs.git.unmergedStages())).toEqual([])
  })

  it("reports a clean merge as merged with nothing conflicted", async () => {
    const repo = await fixture()
    await run(repo.git.checkoutBranch("side", { create: true }))
    await put(repo.root, "areas/x/side.html", "<p>side</p>")
    await run(repo.git.add(["areas/x/side.html"]))
    await run(repo.git.commit("memhtml(write): side"))

    await run(repo.git.checkoutBranch("main"))
    await put(repo.root, "areas/x/main.html", "<p>main</p>")
    await run(repo.git.add(["areas/x/main.html"]))
    await run(repo.git.commit("memhtml(write): main"))

    // Different files: two agents writing different memories never interact.
    expect(await run(repo.git.merge("side"))).toEqual({ merged: true, conflicted: [] })
  })
})

describe("GitFailure", () => {
  it("carries the subcommand and exit code, and no argv", async () => {
    // A GitFailure reaches an agent through a tool response. Arguments carry memory paths and
    // commit subjects carry memory titles, so neither is in the payload.
    const repo = await fixture()
    const failure = await runErr(repo.git.run(["cat-file", "-p", "no-such-object"]))
    expect(Object.keys({ ...failure }).sort()).toEqual(["_tag", "command", "exitCode"])
    expect(failure.command).toBe("cat-file")
    expect(failure.exitCode).toBe(128)
  })

  it("fails rather than throwing when git is asked to run outside a repo", async () => {
    const notARepo = await fixture({ init: false })
    const failure = await runErr(makeGit(notARepo.root).lsTreeR("HEAD"))
    expect(failure).toBeInstanceOf(GitFailure)
  })

  it("fails when the root does not exist at all", async () => {
    const failure = await runErr(makeGit("/tmp/memhtml-store-absent-root-xyzzy").revParseHead())
    expect(failure).toBeInstanceOf(GitFailure)
  })
})

/**
 * Count actual OS process spawns while a thunk runs, via `node:diagnostics_channel`'s
 * `child_process` channel.
 *
 * Counting method invocations instead would be the recurring mistake in this class of test: a
 * wrapper that increments once per `catFileBatch` call passes identically whether the
 * implementation runs one `cat-file --batch` or fifty `cat-file -p`, which is the exact claim
 * under test. The channel observes the spawn itself, so only the real thing satisfies it.
 */
const countingSpawns = async <A>(thunk: () => Promise<A>): Promise<[A, number]> => {
  let spawns = 0
  const onSpawn = () => {
    spawns += 1
  }
  subscribe("child_process", onSpawn)
  try {
    return [await thunk(), spawns]
  } finally {
    unsubscribe("child_process", onSpawn)
  }
}

describe("the environment cannot re-aim a call at another repository", () => {
  /**
   * git exports repo-selecting variables into the processes it runs: a `pre-push` hook in a linked
   * worktree receives an ABSOLUTE `GIT_DIR`, and every descendant inherits it. Before the scrub in
   * `gitChildEnv`, a store call that meant "the corpus at `-C <root>`" read the HOOK's repository
   * instead — measured as `memhtml sleep run` refusing with DirtyTree over a clean corpus, naming
   * dirt that belonged to the repo the push ran from. The variables here are the ones a hook
   * actually exports; `GIT_REPO_SELECTION_ENV` in `src/git.ts` carries the full scrubbed set.
   *
   * (Mutation: dropping the `delete` loop from `gitChildEnv` makes `statusPorcelainV2` report the
   * OTHER repo's dirty file, or fail outright, and this case names it.)
   */
  it("answers about the -C repo even when GIT_DIR names another", async () => {
    const corpus = await fixture()
    const other = await fixture()
    await put(other.root, "left-uncommitted.txt", "dirt that belongs to the other repo")

    const saved = new Map<string, string | undefined>()
    for (const [name, value] of [
      ["GIT_DIR", join(other.root, ".git")],
      ["GIT_WORK_TREE", other.root],
      ["GIT_INDEX_FILE", join(other.root, ".git", "index")]
    ] as const) {
      saved.set(name, process.env[name])
      process.env[name] = value
    }
    try {
      // Both halves, so a scrub that broke git entirely cannot pass: the corpus reads clean,
      // and the same call against the dirty repo's own service really does see the dirt.
      expect(await run(corpus.git.statusPorcelainV2())).toEqual([])
      const dirt = await run(other.git.statusPorcelainV2())
      expect(dirt.map((entry) => entry.path)).toContain("left-uncommitted.txt")
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
