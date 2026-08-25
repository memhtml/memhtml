import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { InvalidMemory, WriteConflict } from "@memhtml/contracts/errors"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { PROMPT_TRAILER, SESSION_TRAILER } from "../src/plumbing.js"
import { type BatchWriteResult, makeStore, type StoreHooks } from "../src/store.js"
import { type FixtureRepo, makeFixtureRepo, mapDedupeLookup, writeInput } from "../src/testing.js"

/**
 * `writeMemories` against real git repos: N validated writes, ONE commit.
 *
 * Every "nothing happened" assertion reads GIT and DISK rather than the return value, because the
 * failure mode being excluded is precisely a batch whose result object claims a byte-identical tree
 * while a half-written file sits untracked beside it. A stateless fake would report the same shape
 * for both.
 *
 * The three properties that belong to the FOLD rather than to any single write, and that a caller
 * looping over `writeMemory` could not have: one commit for N files, dedup resolved against the
 * batch's own accepted ops, and two same-titled ops getting distinct paths — `freePathFor` reads
 * disk, so it cannot see a path a sibling op has claimed but not yet written.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

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
})

const commitCount = async (repo: FixtureRepo): Promise<number> =>
  Number((await run(repo.git.run(["rev-list", "--count", "HEAD"]))).trim())

const lastSubject = async (repo: FixtureRepo): Promise<string> =>
  (await run(repo.git.run(["log", "-1", "--format=%s"]))).trim()

/**
 * Every `.html` on disk under the PARA directories, excluding the scaffold's own `README.html`.
 *
 * On DISK rather than in the tree, deliberately: an aborted batch's leftover would be an UNTRACKED
 * file, invisible to `ls-tree`, and it is exactly what a validate-as-you-write implementation
 * produces. This is the assertion that makes "byte-identical tree" mean something.
 */
const htmlOnDisk = async (repo: FixtureRepo): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(repo.root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name).slice(repo.root.length + 1))
    .filter((path) => path !== "README.html")
    .sort()
}

/** A snapshot of everything a batch must not disturb when it refuses. */
const snapshot = async (repo: FixtureRepo) => ({
  commits: await commitCount(repo),
  head: await run(repo.git.revParseHead()),
  tree: await run(repo.git.lsTreeR("HEAD")),
  disk: await htmlOnDisk(repo),
  dirty: await run(repo.store.dirtyPaths())
})

/** One op's violation text, or a throw naming what it actually held. */
const violationOf = (result: BatchWriteResult, index: number): string => {
  const error = result.results[index]?.error
  if (!(error instanceof InvalidMemory)) {
    throw new Error(
      `op ${index} carried no InvalidMemory: ${JSON.stringify(result.results[index])}`
    )
  }
  return error.reason
}

/** One op's path conflict, or a throw naming what it actually held. */
const conflictOf = (result: BatchWriteResult, index: number): WriteConflict => {
  const error = result.results[index]?.error
  if (!(error instanceof WriteConflict)) {
    throw new Error(
      `op ${index} carried no WriteConflict: ${JSON.stringify(result.results[index])}`
    )
  }
  return error
}

/** Article markup with prose but no claim span — constraint 1's exact violation. */
const NO_MARK = "<p>No mark at all.</p>"

/** The one op shape the render gate refuses: an empty claim and markup with no `<mark>`. */
const badOp = (title: string) => writeInput({ title, claim: "", articleHtml: NO_MARK })

describe("writeMemories: N writes, one commit", () => {
  it("writes three files in ONE commit with per-op results in input order", async () => {
    const repo = await fixture()
    const before = await commitCount(repo)

    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "First fact", claim: "One." }),
        writeInput({ title: "Second fact", claim: "Two." }),
        writeInput({ title: "Third fact", claim: "Three." })
      ])
    )

    // ONE commit for three files. This is the property the whole primitive exists for: N commits
    // would mean N reindexes downstream (G4), and `git log` would read as three unrelated writes.
    expect(await commitCount(repo)).toBe(before + 1)
    expect(await lastSubject(repo)).toBe("memhtml(batch): 3 memories")
    expect(result.commitSha).not.toBeNull()

    // Results in INPUT order, every op present, each carrying its own path.
    expect(result.results.map((entry) => entry.index)).toEqual([0, 1, 2])
    expect(result.results.every((entry) => entry.ok)).toBe(true)
    expect(result.results.map((entry) => entry.path)).toEqual([
      "areas/inbox/first-fact.html",
      "areas/inbox/second-fact.html",
      "areas/inbox/third-fact.html"
    ])
    expect(result.summary).toEqual({ total: 3, written: 3, deduped: 0, failed: 0, skipped: 0 })

    // All three are in the COMMIT, not merely on disk, and the tree is clean.
    const committed = await run(repo.git.lsTreeR("HEAD", [...result.writtenPaths]))
    expect(committed.map((entry) => entry.path).sort()).toEqual([...result.writtenPaths].sort())
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("names the one title when a batch of one wrote one file", async () => {
    // A batch of one is an ordinary write as far as `git log --oneline` is concerned.
    const repo = await fixture()
    await run(repo.store.writeMemories([writeInput({ title: "Only one" })]))
    expect(await lastSubject(repo)).toBe("memhtml(batch): Only one")
  })

  it("writes every file parseably, with each op's own stamped hash", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Alpha", claim: "A.", tags: ["deploy"] }),
        writeInput({ title: "Beta", claim: "B.", entities: ["person:sanju"] })
      ])
    )
    const first = await run(repo.store.readMemory(result.results[0]?.path ?? ""))
    const second = await run(repo.store.readMemory(result.results[1]?.path ?? ""))
    expect(first.doc.article.gist).toBe("A.")
    expect(first.doc.metas.contentHash).toBe(result.results[0]?.contentHash)
    expect(second.doc.article.gist).toBe("B.")
    expect(second.doc.metas.contentHash).toBe(result.results[1]?.contentHash)
    // Placement is the same rule the singular write follows — a tag routes to `resources/<tag>/`.
    expect(first.path).toBe("resources/deploy/alpha.html")
    expect(second.path).toBe("resources/people/beta.html")
  })

  it("stamps ONE set of provenance trailers on the batch commit", async () => {
    // A batch is one commit, so it gets one `Memhtml-Session`. Per-op provenance is already in each
    // file's own head, which is where it belongs.
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Traced one", sessionId: "sess-b", promptId: "pr_b" }),
        writeInput({ title: "Traced two", claim: "Other.", sessionId: "sess-b", promptId: "pr_b" })
      ])
    )
    const body = await run(repo.git.run(["log", "-1", "--format=%B"]))
    expect(body).toContain(`${SESSION_TRAILER}: sess-b`)
    expect(body).toContain(`${PROMPT_TRAILER}: pr_b`)
    // Once, not twice: a repeated trailer would double-count a night's writes in `sleep resume`.
    expect(body.split(`${SESSION_TRAILER}: sess-b`).length - 1).toBe(1)

    for (const entry of result.results) {
      expect((await run(repo.store.readMemory(entry.path ?? ""))).doc.metas.sessionId).toBe(
        "sess-b"
      )
    }
  })

  it("returns an empty result for an empty op list, committing nothing", async () => {
    const repo = await fixture()
    const before = await commitCount(repo)
    const result = await run(repo.store.writeMemories([]))
    expect(result.results).toEqual([])
    expect(result.summary).toEqual({ total: 0, written: 0, deduped: 0, failed: 0, skipped: 0 })
    expect(result.commitSha).toBeNull()
    expect(await commitCount(repo)).toBe(before)
  })
})

describe("atomic mode (the default): a refusal leaves a byte-identical tree", () => {
  it("aborts before commit when op 2 fails the render gate, writing nothing at all", async () => {
    const repo = await fixture()
    const before = await snapshot(repo)

    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Would have been first", claim: "One." }),
        badOp("Refused by the gate"),
        writeInput({ title: "Never attempted", claim: "Three." })
      ])
    )

    // Nothing on disk, nothing staged, no commit — and the assertion that matters is the DISK one:
    // op 1 validated successfully, so an implementation that wrote as it validated would leave
    // `areas/inbox/would-have-been-first.html` untracked, which `ls-tree` cannot see.
    expect(await htmlOnDisk(repo)).toEqual(before.disk)
    expect(await commitCount(repo)).toBe(before.commits)
    expect(await run(repo.git.revParseHead())).toBe(before.head)
    expect(await run(repo.git.lsTreeR("HEAD"))).toEqual(before.tree)
    expect(await run(repo.store.dirtyPaths())).toEqual([])

    expect(result.commitSha).toBeNull()
    expect(result.writtenPaths).toEqual([])
    expect(result.summary).toEqual({ total: 3, written: 0, deduped: 0, failed: 1, skipped: 2 })
  })

  it("reports the failed op's violation, and every OTHER op as skipped", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Validated but unwritten", claim: "One." }),
        badOp("Refused"),
        writeInput({ title: "Never reached", claim: "Three." })
      ])
    )

    /**
     * Op 0 reports `skipped`, not `ok`. It validated — but nothing was written, so reporting it as
     * `ok` with a path would hand the caller a path with no file behind it. `skipped` is also what
     * makes a retry correct: every skipped op is safe to resubmit, and the failed one is not.
     */
    expect(result.results[0]).toEqual({ index: 0, ok: false, skipped: true })
    expect(result.results[2]).toEqual({ index: 2, ok: false, skipped: true })

    // AC-6-8: the gate names the violation, so an agent can fix the markup without a second call.
    const failed = result.results[1]
    expect(failed?.ok).toBe(false)
    expect(failed?.skipped).toBeUndefined()
    expect(violationOf(result, 1)).toContain("no <mark>")
  })

  it("aborts on the FIRST failing op, so a later bad op is reported as skipped", async () => {
    const repo = await fixture()
    const result = await run(repo.store.writeMemories([badOp("First bad"), badOp("Second bad")]))
    expect(result.results[0]?.error).toBeInstanceOf(InvalidMemory)
    expect(result.results[1]).toEqual({ index: 1, ok: false, skipped: true })
    expect(result.summary).toEqual({ total: 2, written: 0, deduped: 0, failed: 1, skipped: 1 })
  })
})

describe("continue_on_error: survivors land in the one commit", () => {
  it("writes ops 1 and 3 in ONE commit and reports op 2 in place", async () => {
    const repo = await fixture()
    const before = await commitCount(repo)

    const result = await run(
      repo.store.writeMemories(
        [
          writeInput({ title: "Survivor one", claim: "One." }),
          badOp("The casualty"),
          writeInput({ title: "Survivor two", claim: "Three." })
        ],
        { continueOnError: true }
      )
    )

    // ONE commit for the two survivors — not two commits, and not zero.
    expect(await commitCount(repo)).toBe(before + 1)
    expect(result.commitSha).not.toBeNull()
    expect(result.writtenPaths).toEqual([
      "areas/inbox/survivor-one.html",
      "areas/inbox/survivor-two.html"
    ])
    expect(await htmlOnDisk(repo)).toEqual([
      "areas/inbox/survivor-one.html",
      "areas/inbox/survivor-two.html"
    ])
    expect(await run(repo.store.dirtyPaths())).toEqual([])

    // Per-op results still in input order, with the failure in the middle and NO skipped ops.
    expect(result.results[0]).toMatchObject({ index: 0, ok: true, deduped: false })
    expect(result.results[1]?.ok).toBe(false)
    expect(result.results[1]?.error).toBeInstanceOf(InvalidMemory)
    expect(result.results[1]?.skipped).toBeUndefined()
    expect(result.results[2]).toMatchObject({ index: 2, ok: true, deduped: false })
    expect(result.summary).toEqual({ total: 3, written: 2, deduped: 0, failed: 1, skipped: 0 })
  })

  it("commits nothing when every op fails, and still reports all of them", async () => {
    const repo = await fixture()
    const before = await snapshot(repo)
    const result = await run(
      repo.store.writeMemories([badOp("Bad one"), badOp("Bad two")], { continueOnError: true })
    )
    expect(result.commitSha).toBeNull()
    expect(result.summary).toEqual({ total: 2, written: 0, deduped: 0, failed: 2, skipped: 0 })
    expect(result.results.every((entry) => entry.error instanceof InvalidMemory)).toBe(true)
    expect(await commitCount(repo)).toBe(before.commits)
    expect(await htmlOnDisk(repo)).toEqual(before.disk)
  })
})

describe("intra-batch dedup against the folded state (D5)", () => {
  it("dedupes op 2 onto op 1's path, writing ONE file", async () => {
    /**
     * The batch-only case. The injected `dedupeLookup` reads the INDEX, which knows nothing about
     * a file this batch has not committed yet — so a fold that asked only the store would write
     * both copies and then leave the `files_content_hash_active` unique index to refuse one at
     * projection time, silently.
     */
    const dedupe = mapDedupeLookup()
    const repo = await fixture({ hooks: { dedupeLookup: dedupe.lookup } })

    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "One title", claim: "The same fact." }),
        writeInput({ title: "Quite another title", claim: "The same fact." })
      ])
    )

    const firstPath = "areas/inbox/one-title.html"
    expect(result.results[0]).toMatchObject({ index: 0, ok: true, deduped: false, path: firstPath })
    // A dedupe is `ok`, never an error — and it reports the FIRST op's path, so the caller learns
    // where its fact lives in the same response.
    expect(result.results[1]).toMatchObject({
      index: 1,
      ok: true,
      deduped: true,
      path: firstPath,
      existingPath: firstPath
    })
    expect(result.summary).toEqual({ total: 2, written: 1, deduped: 1, failed: 0, skipped: 0 })

    // ONE file, and no `-2` variant anywhere on disk.
    expect(await htmlOnDisk(repo)).toEqual([firstPath])
    expect(result.writtenPaths).toEqual([firstPath])
  })

  it("resolves a THIRD identical op onto the same first path", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "T1", claim: "Same." }),
        writeInput({ title: "T2", claim: "Same." }),
        writeInput({ title: "T3", claim: "Same." })
      ])
    )
    expect(result.results.map((entry) => entry.path)).toEqual([
      "areas/inbox/t1.html",
      "areas/inbox/t1.html",
      "areas/inbox/t1.html"
    ])
    expect(result.summary).toEqual({ total: 3, written: 1, deduped: 2, failed: 0, skipped: 0 })
    expect(await htmlOnDisk(repo)).toEqual(["areas/inbox/t1.html"])
  })

  it("still asks the STORE's lookup, so a pre-existing file dedupes too", async () => {
    // The mutation-proof pair: the batch's own map must not REPLACE the store's oracle.
    const dedupe = mapDedupeLookup()
    const repo = await fixture({ hooks: { dedupeLookup: dedupe.lookup } })
    const existing = await run(repo.store.writeMemory(writeInput({ title: "Already here" })))
    dedupe.byHash.set(existing.contentHash, existing.path)
    const before = await commitCount(repo)

    const result = await run(
      repo.store.writeMemories([writeInput({ title: "A new title for an old fact" })])
    )
    expect(result.results[0]).toMatchObject({ ok: true, deduped: true, path: existing.path })
    expect(result.commitSha).toBeNull()
    // Nothing was written, so nothing was committed: `git.commit` reports an empty index as a
    // no-op rather than making an empty commit.
    expect(await commitCount(repo)).toBe(before)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("exempts tasks in BOTH directions, so two identical tasks are two files", async () => {
    /**
     * The exemption mirrors the injected lookup's `memory_type <> 'task'` predicate, which mirrors
     * the `files_content_hash_active` partial unique index. Two open tasks with identical bodies
     * are two real work items — and a memory must not be deduped onto a task either, or the caller
     * would be handed a task's path as the home of its fact.
     */
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Drain the VIP", claim: "Do the thing.", memoryType: "task" }),
        writeInput({ title: "Drain the VIP", claim: "Do the thing.", memoryType: "task" })
      ])
    )
    expect(result.summary).toEqual({ total: 2, written: 2, deduped: 0, failed: 0, skipped: 0 })
    expect(result.results.every((entry) => entry.deduped === false)).toBe(true)
    // Two distinct files — the same-title collision guard applies to the exempt path too.
    const paths = result.results.map((entry) => entry.path)
    expect(new Set(paths).size).toBe(2)
    expect(await htmlOnDisk(repo)).toEqual([...paths].sort())
  })

  it("does not dedupe a memory onto an identical-bodied task earlier in the batch", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "As a task", claim: "Identical body.", memoryType: "task" }),
        writeInput({ title: "As a memory", claim: "Identical body." })
      ])
    )
    expect(result.summary).toEqual({ total: 2, written: 2, deduped: 0, failed: 0, skipped: 0 })
    expect(result.results[1]?.deduped).toBe(false)
  })
})

describe("intra-batch path collisions", () => {
  it("gives two same-titled ops DISTINCT paths, both written", async () => {
    /**
     * The batch-only bug class. `freePathFor` decides "taken" by reading DISK, and in a batch that
     * validates every op before writing any, neither file exists yet — so without the claimed-path
     * set both ops receive `areas/inbox/same-title.html` and the second write silently clobbers
     * the first. The claim tracked per batch is what makes this a `-2`.
     */
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Same title", claim: "One fact." }),
        writeInput({ title: "Same title", claim: "A different fact." })
      ])
    )

    expect(result.results[0]?.path).toBe("areas/inbox/same-title.html")
    expect(result.results[1]?.path).toBe("areas/inbox/same-title-2.html")
    expect(result.summary).toEqual({ total: 2, written: 2, deduped: 0, failed: 0, skipped: 0 })

    // Both files exist on disk AND in the commit, and neither clobbered the other's content.
    expect(await htmlOnDisk(repo)).toEqual([
      "areas/inbox/same-title-2.html",
      "areas/inbox/same-title.html"
    ])
    expect((await run(repo.store.readMemory("areas/inbox/same-title.html"))).doc.article.gist).toBe(
      "One fact."
    )
    expect(
      (await run(repo.store.readMemory("areas/inbox/same-title-2.html"))).doc.article.gist
    ).toBe("A different fact.")
  })

  it("continues past a path a PREVIOUS commit already holds", async () => {
    // Disk stays authoritative: the claimed set is an addition to the uniqueness check, not a
    // replacement for it.
    const repo = await fixture()
    await run(repo.store.writeMemory(writeInput({ title: "Same title", claim: "Committed." })))
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Same title", claim: "Batched one." }),
        writeInput({ title: "Same title", claim: "Batched two." })
      ])
    )
    expect(result.results.map((entry) => entry.path)).toEqual([
      "areas/inbox/same-title-2.html",
      "areas/inbox/same-title-3.html"
    ])
  })

  it("counts a claimed path per batch, so three same-titled ops get three paths", async () => {
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "Trio", claim: "One." }),
        writeInput({ title: "Trio", claim: "Two." }),
        writeInput({ title: "Trio", claim: "Three." })
      ])
    )
    expect(result.results.map((entry) => entry.path)).toEqual([
      "areas/inbox/trio.html",
      "areas/inbox/trio-2.html",
      "areas/inbox/trio-3.html"
    ])
    expect((await htmlOnDisk(repo)).length).toBe(3)
  })
})

describe("a commit failure rolls the whole batch back", () => {
  it("unstages and unlinks every written file, leaving a byte-identical tree", async () => {
    /**
     * The one failure mode phase-1 validation cannot pre-empt: the files were written and staged,
     * and git itself refused. Driven by a git service whose `commit` fails, since the real binary
     * cannot be made to fail here on demand — everything else in the batch, including the write
     * and the stage, is the REAL store against the REAL repo, so the rollback runs against actual
     * on-disk and index state.
     *
     * `git reset -- <paths>`, not `git rm --cached`: probed live 2026-08-04, `rm --cached` exits
     * 128 as soon as one listed path was never staged, which is the state a part-way `add` leaves.
     */
    const repo = await fixture()
    const before = await snapshot(repo)
    const failingGit = {
      ...repo.git,
      commit: () => repo.git.run(["commit", "--this-is-not-a-flag"]).pipe(Effect.asVoid) as never
    }
    const store = makeStore(failingGit)

    await runErr(
      store.writeMemories([
        writeInput({ title: "Rolled back one", claim: "One." }),
        writeInput({ title: "Rolled back two", claim: "Two." })
      ])
    )

    // The whole point: both files are gone from disk AND unstaged, so `git status` is clean.
    expect(await htmlOnDisk(repo)).toEqual(before.disk)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
    expect(await commitCount(repo)).toBe(before.commits)
    expect(await run(repo.git.lsTreeR("HEAD"))).toEqual(before.tree)
  })

  it("rolls back a PART-WAY stage, where some paths were never staged at all", async () => {
    /**
     * The case that picks the rollback mechanism, and the reason `git rm --cached` is wrong here.
     *
     * Probed live 2026-08-04: `git rm --cached -- a b` exits 128 with `fatal: pathspec 'b' did not
     * match any files` as soon as ONE listed path was never staged — so a rollback built on it
     * would ITSELF fail on exactly the input it exists for, leaving the first file staged and both
     * on disk. `git reset -- a b` exits 0 in that same state. This test is what makes the two
     * mechanisms distinguishable: the all-staged case above passes with either.
     *
     * A git whose `add` refuses the second path is how that state is produced. Everything else —
     * the write, the reset, the unlink — is the real binary against the real repo.
     */
    const repo = await fixture()
    const before = await snapshot(repo)
    let adds = 0
    const flakyGit = {
      ...repo.git,
      add: (paths: ReadonlyArray<string>) => {
        adds += 1
        // The batch stages once with every path; a per-path add is what a partial failure looks
        // like, so the first path is staged and the rest are refused.
        return adds === 1 && paths.length > 1
          ? repo.git
              .add(paths.slice(0, 1))
              .pipe(Effect.andThen(repo.git.run(["add", "--", "no/such/path.html"])))
              .pipe(Effect.asVoid)
          : repo.git.add(paths)
      }
    }
    const store = makeStore(flakyGit)

    await runErr(
      store.writeMemories([
        writeInput({ title: "Staged then reset", claim: "One." }),
        writeInput({ title: "Never staged", claim: "Two." })
      ])
    )

    // Both files removed, nothing left staged: the first path had to be unstaged AND unlinked, and
    // the second — written but invisible to git — had to be unlinked too.
    expect(await htmlOnDisk(repo)).toEqual(before.disk)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
    expect(await commitCount(repo)).toBe(before.commits)
  })

  it("RESTORES a file that appeared at a claimed path rather than deleting it", async () => {
    /**
     * The race the in-process permit cannot close, and the one that makes the compensation a
     * journal rather than an unlink: another process commits a file at a path this batch already
     * claimed. The batch's write pass replaces those bytes, git then refuses the commit, and undoing
     * the batch means putting the OTHER writer's memory back — an unlink would delete a file that is
     * in HEAD, in a corpus whose whole premise is that nothing is ever deleted.
     *
     * The intruding commit is made from the dedupe hook, which the batch calls once per op during
     * validation, so it lands after op 0 claimed its path and before the write pass reaches it. Real
     * hook, real git, real commit.
     */
    const repo = await fixture()
    const claimed = "areas/inbox/racing-title.html"
    const outsider = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Written by the other process</title>
<meta name="memhtml-type" content="semantic">
</head>
<body>
<article>
<p><mark>The other writer got here first.</mark></p>
</article>
</body>
</html>
`
    let lookups = 0
    const hooks: StoreHooks = {
      dedupeLookup: () =>
        Effect.gen(function* () {
          lookups += 1
          if (lookups === 2) {
            yield* Effect.promise(() => writeFile(join(repo.root, claimed), outsider, "utf8"))
            yield* repo.git.add([claimed])
            yield* repo.git.commit("memhtml(write): the other process")
          }
          return null
        })
    }
    const failingGit = {
      ...repo.git,
      commit: () => repo.git.run(["commit", "--this-is-not-a-flag"]).pipe(Effect.asVoid) as never
    }
    const store = makeStore(failingGit, hooks)

    await runErr(
      store.writeMemories([
        writeInput({ title: "Racing title", claim: "This batch's fact." }),
        writeInput({ title: "Second op", claim: "Whatever the second op says." })
      ])
    )

    // The other writer's memory is still there, byte for byte, and the tree it committed is clean.
    expect(await readFile(join(repo.root, claimed), "utf8")).toBe(outsider)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
    expect(await run(repo.store.requireCleanTree())).toBeUndefined()
    expect(await htmlOnDisk(repo)).toEqual([claimed])
  })
})

describe("an explicit path a batch cannot have", () => {
  it("refuses the op whose explicit path an active memory holds, per op", async () => {
    /**
     * The same refusal the singular write makes, reported the way the batch contract requires: a
     * rejected OP is a per-op result, never an error-channel failure, so the caller still gets its
     * array back. The occupant's bytes are the assertion that matters — an overwrite here would
     * delete a memory with no archive and no supersedes link.
     */
    const repo = await fixture()
    const occupied = await run(
      repo.store.writeMemory(
        writeInput({ path: "areas/oncall/held.html", claim: "The fact already here." })
      )
    )
    const before = await readFile(join(repo.root, occupied.path), "utf8")

    const result = await run(
      repo.store.writeMemories(
        [
          writeInput({ title: "Would replace it", claim: "A newer fact.", path: occupied.path }),
          writeInput({ title: "A free path", claim: "Lands fine." })
        ],
        { continueOnError: true }
      )
    )

    expect(result.results[0]?.ok).toBe(false)
    expect(conflictOf(result, 0).path).toBe(occupied.path)
    expect(result.summary).toEqual({ total: 2, written: 1, deduped: 0, failed: 1, skipped: 0 })
    // The survivor still lands in the one commit, and the occupant is untouched.
    expect(result.results[1]).toMatchObject({ ok: true, path: "areas/inbox/a-free-path.html" })
    expect(await readFile(join(repo.root, occupied.path), "utf8")).toBe(before)
    expect(await run(repo.store.dirtyPaths())).toEqual([])
  })

  it("refuses the SECOND of two ops naming one explicit path", async () => {
    /**
     * Neither file exists when either op is validated, so disk cannot separate them — the claimed
     * set is the only thing that can. Without it both ops are handed the path and the second write
     * replaces the first inside one commit, which reports two successes for one file.
     */
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories(
        [
          writeInput({ title: "First", claim: "One.", path: "areas/oncall/one-slot.html" }),
          writeInput({ title: "Second", claim: "Two.", path: "areas/oncall/one-slot.html" })
        ],
        { continueOnError: true }
      )
    )

    expect(result.results[0]).toMatchObject({ ok: true, path: "areas/oncall/one-slot.html" })
    expect(result.results[1]?.ok).toBe(false)
    expect(conflictOf(result, 1).path).toBe("areas/oncall/one-slot.html")
    expect(result.summary).toEqual({ total: 2, written: 1, deduped: 0, failed: 1, skipped: 0 })
    // ONE file, holding the FIRST op's fact.
    expect(await htmlOnDisk(repo)).toEqual(["areas/oncall/one-slot.html"])
    expect((await run(repo.store.readMemory("areas/oncall/one-slot.html"))).doc.article.gist).toBe(
      "One."
    )
  })

  it("aborts the whole batch on that refusal in atomic mode", async () => {
    // Atomic is the default, so a path conflict aborts exactly like a render-gate violation: nothing
    // written, every other op reported as skipped rather than as ok with a path.
    const repo = await fixture()
    const before = await snapshot(repo)
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "First", claim: "One.", path: "areas/oncall/contended.html" }),
        writeInput({ title: "Second", claim: "Two.", path: "areas/oncall/contended.html" })
      ])
    )

    expect(result.results[0]).toEqual({ index: 0, ok: false, skipped: true })
    expect(conflictOf(result, 1).path).toBe("areas/oncall/contended.html")
    expect(result.summary).toEqual({ total: 2, written: 0, deduped: 0, failed: 1, skipped: 1 })
    expect(result.commitSha).toBeNull()
    expect(await htmlOnDisk(repo)).toEqual(before.disk)
    expect(await commitCount(repo)).toBe(before.commits)
  })

  it("keeps writing an explicit path nothing holds", async () => {
    // The mutation-proof pair: only an OCCUPIED or twice-claimed path is refused. A guard that
    // refused every explicit path would satisfy all three cases above and none of this one.
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({ title: "One", claim: "One.", path: "areas/oncall/first-slot.html" }),
        writeInput({ title: "Two", claim: "Two.", path: "areas/oncall/second-slot.html" })
      ])
    )
    expect(result.summary).toEqual({ total: 2, written: 2, deduped: 0, failed: 0, skipped: 0 })
    expect(await htmlOnDisk(repo)).toEqual([
      "areas/oncall/first-slot.html",
      "areas/oncall/second-slot.html"
    ])
  })
})

describe("the render gate is never bypassed by the batch path (AC-6-8)", () => {
  it("accepts valid authored markup verbatim in a batch, unescaped", async () => {
    // The mutation-proof pair for every refusal above: the same gate, markup that satisfies the
    // constraints, reaching disk as MARKUP. A gate stubbed to always pass would satisfy the
    // refusals only if it were removed, and this only if it were kept.
    const repo = await fixture()
    const result = await run(
      repo.store.writeMemories([
        writeInput({
          title: "An authored batch article",
          claim: "",
          articleHtml:
            '<p><mark>Claim.</mark> <time datetime="2023-05-20T02:21:00Z">then</time></p>'
        })
      ])
    )
    const read = await run(repo.store.readMemory(result.results[0]?.path ?? ""))
    expect(read.html).toContain('<time datetime="2023-05-20T02:21:00Z">')
    expect(read.html).not.toContain("&lt;time")
    expect(read.doc.article.gist).toBe("Claim.")
  })

  it("refuses each bad op independently in continue mode, naming each violation", async () => {
    const repo = await fixture()
    const result: BatchWriteResult = await run(
      repo.store.writeMemories(
        [badOp("Bad one"), writeInput({ title: "Good", claim: "Fine." }), badOp("Bad two")],
        { continueOnError: true }
      )
    )
    expect(violationOf(result, 0)).toContain("no <mark>")
    expect(violationOf(result, 2)).toContain("no <mark>")
    expect(result.results[1]?.ok).toBe(true)
    expect(result.summary).toEqual({ total: 3, written: 1, deduped: 0, failed: 2, skipped: 0 })
  })
})
