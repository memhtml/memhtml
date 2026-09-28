import { execFile } from "node:child_process"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { ARTICLE_EDIT_REASON, type CurateMerged, curateMerge } from "@memhtml/cli"
import { DiscriminationFailed, type EvalOutcome } from "@memhtml/eval"
import { renderTemplate } from "@memhtml/html"
import { appendOps, type CommitOutcome, resumeSession } from "@memhtml/session"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"

/**
 * The curation door end to end (`docs/v2-poc.md`, "Curation door"): a curator is a session on a
 * `curate/<name>` branch, its first commit creates the branch, and `curate merge` lands the branch
 * on `main` behind the gate with the checkout following.
 *
 * Every ref position below is read back with `rev-parse` and every working-tree claim with
 * `access` and `status --porcelain`, independently of the payload under test. A payload that said
 * `worktreeSynced: true` over a checkout that did not move would fail the disk check, not the
 * payload check.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `v2.ts` `curateMerge`: pin `fastForward` to `true` -> "a curator branch that is not a descendant
 *   of main is not refused: it is replayed" (the fast-forward path's compare-and-swap moves main to a
 *   commit that does not contain it, and `replayed` comes back `null`).
 * - `v2.ts` `curateMerge`: replace the gate call with `gate = { ran: false, passed: null }` -> "a
 *   merge without --skip-gate runs the head gate over both tips and reports it" (`gate.ran` is
 *   false) and "an injected failing gate fails the merge with its numbers and moves nothing" (the
 *   failure never fires).
 * - `v2.ts` `curateMerge`: drop the `snapshotAfterCommit` call (`snapshot: null`) -> "curate merge
 *   --skip-gate lands main at the curator's commit with the working tree following" (the payload's
 *   `snapshot` is null and the next `head status` reads git).
 * - `v2.ts` `curateMerge`: drop `readTreeIntoWorktree(from, to)` -> "curate merge --skip-gate lands
 *   main at the curator's commit with the working tree following" (the put files are absent on
 *   disk and `status` reports staged deletions).
 * - `v2.ts` `curateMerge`: drop the `dirtyPaths` refusal -> "an uncommitted edit at a path the
 *   landing changes is refused as a dirty tree" (`read-tree -u` overwrites the edit or fails with
 *   ERR_GIT instead).
 * - `commit.ts` step 6: pass `expected: to` in place of `mainSha` for an unborn ref -> "a curator
 *   session on an unborn ref is created by its first commit" (`update-ref` refuses to create).
 * - `v2.ts` `landReplay`: drop the `git.updateRef(input.ref, outcome.sha, input.to)` that moves the
 *   curate ref -> "a curator branch whose base main has moved past is replayed onto main as one
 *   commit" (the ref still names the original tip, and the re-run replays again into a `duplicate`
 *   refusal instead of `moved: false`).
 * - `v2.ts` `curateMerge`: drop the pre-gate `validateOps` refusal -> "a record main gained with the
 *   same content hash refuses the replay as a duplicate before the gate runs" (the injected gate
 *   records a run, and the refusal comes from the commit path instead).
 * - `v2.ts` `replayPlan`: drop the `rejected.length > 0` refusal -> "a hand-made commit that edits an
 *   article in place is refused naming the path" (the edit is replayed as a put and refused as a
 *   `claim-edit`, so the message no longer carries the article-edit reason).
 * - `v2.ts` `landReplay`: make `rebase-needed` fall through to the attempts-exhausted failure ->
 *   "main moving between validation and commit is settled by the retry loop" (the landing fails
 *   instead of reporting `attempts: 2`).
 */

const AT = "2026-09-20T12:00:00Z"

const fixtureMemory = (index: number): { readonly path: string; readonly html: string } => ({
  path: `areas/inbox/curate-fixture-${String(index)}.html`,
  html: renderTemplate({
    title: `Curate fixture ${index}`,
    claim: `Curate fixture fact ${index} names harbor ${index % 3}.`,
    memoryType: "semantic",
    at: AT
  })
})
const FIXTURES = [fixtureMemory(0), fixtureMemory(1), fixtureMemory(2)]

let cli: Cli
let scratchDir: string

const rev = async (ref: string): Promise<string | null> => {
  try {
    return (await cli.git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).trim()
  } catch {
    return null
  }
}
/**
 * The checkout's uncommitted state outside `.memhtml/`, which holds the sessions' own untracked
 * log and index files and is never what a landing moves.
 */
const status = async (): Promise<string> =>
  (await cli.git("status", "--porcelain", "--", ".", ":!.memhtml")).trim()
const onDisk = (path: string): Promise<boolean> =>
  access(join(cli.root, path)).then(
    () => true,
    () => false
  )

const opsFile = async (
  name: string,
  ops: ReadonlyArray<Record<string, unknown>>
): Promise<string> => {
  const file = join(scratchDir, `${name}.jsonl`)
  // Every write names an entity unless the case says otherwise, so fixtures clear the write bar's
  // anchor rule and the cases that are not about the bar stay about what they test.
  const anchored = ops.map((op) =>
    op.op === "write" && op.entities === undefined && op.entity === undefined
      ? { ...op, entities: ["system:fixture"] }
      : op
  )
  await writeFile(file, `${anchored.map((op) => JSON.stringify(op)).join("\n")}\n`)
  return file
}

interface Started {
  readonly id: string
  readonly baseSha: string
  readonly ref: string
}
interface Appended {
  readonly paths: ReadonlyArray<string>
}
type Committed = { readonly id: string; readonly ref: string } & CommitOutcome

/** A curator session on `curate/<name>`, with `puts` landed in its overlay, committed to the branch. */
const curate = async (
  name: string,
  puts: ReadonlyArray<Record<string, unknown>>
): Promise<{
  readonly started: Started
  readonly paths: ReadonlyArray<string>
  readonly sha: string
}> => {
  const id = `curator-${name}`
  const started = await cli.json<Started>([
    "session",
    "start",
    "--id",
    id,
    "--ref",
    `curate/${name}`
  ])
  const appended = await cli.json<Appended>([
    "session",
    "put",
    "--id",
    id,
    "--file",
    await opsFile(id, puts)
  ])
  const committed = await cli.json<Committed>([
    "session",
    "commit",
    "--id",
    id,
    "--message",
    `curated ${name}`
  ])
  expect(committed.kind, name).toBe("committed")
  if (committed.kind !== "committed") throw new Error("unreachable")
  return { started, paths: appended.paths, sha: committed.sha }
}

beforeAll(async () => {
  cli = await makeCli()
  scratchDir = join(cli.root, "..", `memhtml-v2-curate-${process.pid}`)
  await mkdir(scratchDir, { recursive: true })
  for (const file of FIXTURES) {
    const target = join(cli.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await cli.git("add", "-A")
  await cli.git("commit", "-q", "-m", "curate fixture")
}, 180_000)

afterAll(async () => {
  await rm(scratchDir, { recursive: true, force: true })
  await cli.cleanup()
})

describe("a curator session on an unborn branch", () => {
  it("is created by its first commit, on the qualified ref, without moving main or the checkout", async () => {
    const main = await rev("refs/heads/main")
    expect(await rev("refs/heads/curate/x")).toBeNull()

    const id = "curator-x"
    const started = await cli.json<Started>(["session", "start", "--id", id, "--ref", "curate/x"])
    expect(started.ref).toBe("refs/heads/curate/x")
    expect(started.baseSha).toBe(main)

    const appended = await cli.json<Appended>([
      "session",
      "put",
      "--id",
      id,
      "--file",
      await opsFile(id, [
        { op: "write", title: "Curated one", type: "semantic", body: "The first curated fact." },
        { op: "write", title: "Curated two", type: "semantic", body: "The second curated fact." }
      ])
    ])
    expect(appended.paths).toHaveLength(2)

    // The archive op goes through the package API: `session put` takes write ops only, and an
    // archive names the source's article by its bytes, which the fixture holds.
    const source = FIXTURES[0]
    if (source === undefined) throw new Error("no fixture")
    const session = await Effect.runPromise(resumeSession({ root: cli.root, id }))
    await Effect.runPromise(
      appendOps(session, [
        { kind: "archive", path: source.path, to: `archive/2026/${source.path}`, html: source.html }
      ])
    )

    const committed = await cli.json<Committed>([
      "session",
      "commit",
      "--id",
      id,
      "--message",
      "curated x"
    ])
    expect(committed.kind).toBe("committed")
    if (committed.kind !== "committed") return
    expect(committed.worktreeSynced).toBe(false)
    expect(committed.paths).toEqual(
      [...appended.paths, source.path, `archive/2026/${source.path}`].sort()
    )
    // The branch exists now, at the commit; main and the checkout did not move.
    expect(await rev("refs/heads/curate/x")).toBe(committed.sha)
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await status()).toBe("")
    for (const path of appended.paths) expect(await onDisk(path), path).toBe(false)
    expect(await onDisk(source.path)).toBe(true)
  })

  it("curate merge --skip-gate lands main at the curator's commit with the working tree following", async () => {
    const before = await rev("refs/heads/main")
    const target = await rev("refs/heads/curate/x")
    if (before === null || target === null) throw new Error("the previous case did not run")
    const source = FIXTURES[0]
    if (source === undefined) throw new Error("no fixture")

    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/x", "--skip-gate"])
    expect(merged).toEqual({
      ref: "refs/heads/curate/x",
      into: "refs/heads/main",
      from: before,
      to: target,
      moved: true,
      gate: { ran: false, passed: null },
      worktreeSynced: true,
      replayed: null,
      snapshot: expect.objectContaining({ sha: target, rows: expect.any(Number) })
    })

    expect(await rev("refs/heads/main")).toBe(target)
    expect(await rev("HEAD")).toBe(target)
    expect(await status()).toBe("")
    // The landing cached its version, and the snapshot directory is ignored, so a full status is
    // as clean as the one that excludes `.memhtml/`.
    expect(await onDisk(`.memhtml/snapshots/${target}.arrow`)).toBe(true)
    expect((await cli.git("status", "--porcelain")).trim()).toBe("")
    const head = await cli.json<{ sha: string; source: string }>(["head", "status"])
    expect(head).toMatchObject({ sha: target, source: "snapshot" })
    expect(await onDisk("areas/inbox/curated-one.html")).toBe(true)
    expect(await onDisk("areas/inbox/curated-two.html")).toBe(true)
    expect(await onDisk(source.path)).toBe(false)
    expect(await onDisk(`archive/2026/${source.path}`)).toBe(true)

    // The curator's log sits on its own commit: nothing pending, nothing left to land.
    const after = await cli.json<{ baseSha: string; ops: number; refSha: string }>([
      "session",
      "status",
      "--id",
      "curator-x"
    ])
    expect(after).toMatchObject({ baseSha: target, ops: 0, refSha: target })
  })

  it("a second merge of the same branch moves nothing and says so", async () => {
    const main = await rev("refs/heads/main")
    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/x", "--skip-gate"])
    expect(merged).toMatchObject({
      from: main,
      to: main,
      moved: false,
      worktreeSynced: false,
      snapshot: null
    })
    expect(await rev("refs/heads/main")).toBe(main)
  })
})

describe("the refusals", () => {
  it("a ref that does not exist is refused at exit 1 with ERR_INVALID_MEMORY", async () => {
    const main = await rev("refs/heads/main")
    const result = await cli.run(["curate", "merge", "curate/absent", "--skip-gate"])
    expect(result.exitCode).toBe(1)
    const body = JSON.parse(result.stdout) as { code: string; error: string }
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("refs/heads/curate/absent")
    expect(await rev("refs/heads/main")).toBe(main)
  })

  it("a curator branch that is not a descendant of main is not refused: it is replayed", async () => {
    const { sha } = await curate("y", [
      { op: "write", title: "Curated on y", type: "semantic", body: "Landed on y first." }
    ])
    // main advances past the curator's base through the v1 store, so curate/y no longer contains it.
    const written = await cli.json<{ path: string }>([
      "write",
      "--title",
      "Written while y was open",
      "--type",
      "semantic",
      "--claim",
      "Main moved after the curator branched."
    ])
    const main = await rev("refs/heads/main")
    expect(main).not.toBe(sha)

    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/y", "--skip-gate"])
    expect(merged.moved).toBe(true)
    expect(merged.replayed).toMatchObject({
      ops: { put: 1, archive: 0, link: 0 },
      originalTip: sha
    })
    expect(await rev("refs/heads/main")).toBe(merged.to)
    expect(await rev("refs/heads/curate/y")).toBe(merged.to)
    expect(await onDisk(written.path)).toBe(true)
    expect(await onDisk("areas/inbox/curated-on-y.html")).toBe(true)
    expect(await status()).toBe("")
  })

  it("an uncommitted edit at a path the landing changes is refused as a dirty tree", async () => {
    const { sha, paths } = await curate("w", [
      {
        op: "write",
        title: "Curated on w",
        type: "semantic",
        body: "Lands only over a clean path."
      }
    ])
    const path = paths[0]
    if (path === undefined) throw new Error("no put")
    const main = await rev("refs/heads/main")
    await mkdir(dirname(join(cli.root, path)), { recursive: true })
    await writeFile(join(cli.root, path), "<!doctype html><p>an untracked edit</p>\n", "utf8")

    const refused = await cli.envelope(["curate", "merge", "curate/w", "--skip-gate"])
    expect(refused.code).toBe("ERR_DIRTY_TREE")
    expect(String(refused.error)).toContain(path)
    expect(await rev("refs/heads/main")).toBe(main)

    await rm(join(cli.root, path))
    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/w", "--skip-gate"])
    expect(merged.to).toBe(sha)
    expect(merged.worktreeSynced).toBe(true)
    expect(await rev("refs/heads/main")).toBe(sha)
    expect(await status()).toBe("")
  })
})

describe("the gate", () => {
  it("a merge without --skip-gate runs the head gate over both tips and reports it", async () => {
    const { sha } = await curate("z", [
      { op: "write", title: "Curated on z", type: "semantic", body: "Lands behind the gate." }
    ])
    const before = await rev("refs/heads/main")
    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/z"])
    expect(merged).toMatchObject({ from: before, to: sha, moved: true, worktreeSynced: true })
    expect(merged.gate.ran).toBe(true)
    expect(merged.gate.passed).toBe(true)
    // The gate is over the two versions the landing moves between, never over a fixture corpus.
    expect(merged.gate.mode).toBe("head")
    expect(merged.gate.base).toBe(before)
    expect(merged.gate.landed).toBe(sha)
    expect(typeof merged.gate.mrr).toBe("number")
    expect(typeof merged.gate.mrrBefore).toBe("number")
    expect(merged.gate.mrr).toBeGreaterThanOrEqual(merged.gate.floor ?? Number.POSITIVE_INFINITY)
    expect(merged.gate.mrrFloor).toBe(merged.gate.floor)
    // Every record active at both tips is a probe: the fixtures and the earlier landings.
    expect(merged.gate.probes).toBeGreaterThan(0)
    expect(merged.gate.inversions).toBe(0)
    expect(merged.gate.inversionsBefore).toBe(0)
    expect(await rev("refs/heads/main")).toBe(sha)
    expect(await onDisk("areas/inbox/curated-on-z.html")).toBe(true)
  }, 60_000)

  it("an injected failing gate fails the merge with its numbers and moves nothing", async () => {
    const { sha, paths } = await curate("v", [
      { op: "write", title: "Curated on v", type: "semantic", body: "Held back by the gate." }
    ])
    const main = await rev("refs/heads/main")
    const outcome: EvalOutcome = {
      mode: "fake",
      requested: "fake",
      skipped: false,
      probes: 4,
      discriminated: 3,
      inversions: [],
      mrr: 0.5,
      corpusMrr: 0.5,
      mrrFloor: 0.85,
      passed: false,
      degradedProbes: 0,
      results: [],
      seed: 1,
      now: 0,
      corpusSize: 0
    }
    const failed = await Effect.runPromise(
      Effect.result(
        curateMerge({
          root: cli.root,
          ref: "curate/v",
          gate: Effect.fail(new DiscriminationFailed(outcome))
        })
      )
    )
    expect(failed._tag).toBe("Failure")
    if (failed._tag !== "Failure") return
    expect(failed.failure._tag).toBe("DiscriminationFailed")
    if (failed.failure._tag !== "DiscriminationFailed") return
    expect(failed.failure.reason).toContain("MRR 0.5")
    expect(failed.failure.reason).toContain("floor of 0.85")
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await rev("refs/heads/curate/v")).toBe(sha)
    for (const path of paths) expect(await onDisk(path), path).toBe(false)
    expect(await status()).toBe("")
  })
})

/** A passing fake-mode outcome, for an injected gate that must not decide the case. */
const PASSING: EvalOutcome = {
  mode: "fake",
  requested: "fake",
  skipped: false,
  probes: 4,
  discriminated: 4,
  inversions: [],
  mrr: 1,
  corpusMrr: 1,
  mrrFloor: 0.85,
  passed: true,
  degradedProbes: 0,
  results: [],
  seed: 1,
  now: 0,
  corpusSize: 0
}

/** One `write` op landed on main through a session, so main moves past a curator's base. */
const advanceMain = async (name: string, title: string, body: string): Promise<string> => {
  const id = `main-${name}`
  await cli.json(["session", "start", "--id", id])
  await cli.json([
    "session",
    "put",
    "--id",
    id,
    "--file",
    await opsFile(id, [{ op: "write", title, type: "semantic", body }])
  ])
  const committed = await cli.json<Committed>([
    "session",
    "commit",
    "--id",
    id,
    "--message",
    `main moved for ${name}`
  ])
  expect(committed.kind, name).toBe("committed")
  if (committed.kind !== "committed") throw new Error("unreachable")
  return committed.sha
}

const lsTree = async (ref: string): Promise<ReadonlyArray<string>> =>
  (await cli.git("ls-tree", "-r", "--name-only", ref)).split("\n").filter((line) => line !== "")

describe("the replay, when main moved past the curator's base", () => {
  it("a curator branch whose base main has moved past is replayed onto main as one commit", async () => {
    const base = await rev("refs/heads/main")
    const archivedSource = FIXTURES[1]
    const keptSource = FIXTURES[2]
    if (base === null || archivedSource === undefined || keptSource === undefined) {
      throw new Error("no fixture")
    }
    const twin = `archive/2026/${archivedSource.path}`

    // The curator: one put, one archive, and two links (one on the file archived, one on a kept
    // file), all through session commands on the curate ref.
    const id = "curator-r"
    await cli.json<Started>(["session", "start", "--id", id, "--ref", "curate/r"])
    const appended = await cli.json<Appended>([
      "session",
      "put",
      "--id",
      id,
      "--file",
      await opsFile(id, [
        { op: "write", title: "Curated on r", type: "semantic", body: "Replayed onto main." }
      ])
    ])
    const put = appended.paths[0]
    if (put === undefined) throw new Error("no put")
    const session = await Effect.runPromise(resumeSession({ root: cli.root, id }))
    await Effect.runPromise(
      appendOps(session, [
        { kind: "link", path: archivedSource.path, rel: "supports", href: `/${keptSource.path}` },
        { kind: "link", path: keptSource.path, rel: "supersedes", href: `/${twin}` },
        { kind: "archive", path: archivedSource.path, to: twin, html: archivedSource.html }
      ])
    )
    const committed = await cli.json<Committed>([
      "session",
      "commit",
      "--id",
      id,
      "--message",
      "curated r"
    ])
    expect(committed.kind).toBe("committed")
    if (committed.kind !== "committed") return
    const tip = committed.sha

    // Main moves past the curator's base with an unrelated put.
    const moved = await advanceMain("r", "Unrelated while r was open", "Main moved past r.")
    expect(await cli.git("merge-base", "--is-ancestor", moved, tip).catch(() => "no")).toBe("no")

    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/r", "--skip-gate"])
    expect(merged.moved).toBe(true)
    expect(merged.from).toBe(moved)
    expect(merged.to).not.toBe(tip)
    expect(merged.worktreeSynced).toBe(true)
    expect(merged.replayed).toEqual({
      base,
      ops: { put: 1, archive: 1, link: 2, unlink: 0, label: 0, unlabel: 0 },
      attempts: 1,
      originalTip: tip
    })
    // A landed replay caches its version the way a fast-forward does.
    expect(merged.snapshot).toEqual(
      expect.objectContaining({ sha: merged.to, rows: expect.any(Number) })
    )
    expect(await onDisk(`.memhtml/snapshots/${merged.to}.arrow`)).toBe(true)

    // One commit on main, parented on the moved tip, with the replay subject.
    expect(await rev("refs/heads/main")).toBe(merged.to)
    expect(await rev(`${merged.to}^`)).toBe(moved)
    expect((await cli.git("log", "-1", "--format=%s", merged.to)).trim()).toBe(
      `memhtml(curate): curated r (replayed onto ${moved.slice(0, 7)})`
    )
    // Every op is on the tree: the put, the archive twin and not its source, the unrelated put.
    const tree = await lsTree("refs/heads/main")
    expect(tree).toContain(put)
    expect(tree).toContain(twin)
    expect(tree).not.toContain(archivedSource.path)
    expect(tree).toContain("areas/inbox/unrelated-while-r-was-open.html")
    // The archived twin carries the link placed on its source, and the kept file its edge.
    const archived = await cli.git("show", `refs/heads/main:${twin}`)
    expect(archived).toContain(`<link rel="memhtml-supports" href="/${keptSource.path}">`)
    expect(archived).toContain('<meta name="memhtml-status" content="archived">')
    expect(await cli.git("show", `refs/heads/main:${keptSource.path}`)).toContain(
      `<link rel="memhtml-supersedes" href="/${twin}">`
    )
    // The checkout followed.
    expect(await rev("HEAD")).toBe(merged.to)
    expect(await status()).toBe("")
    expect(await onDisk(put)).toBe(true)
    expect(await onDisk(twin)).toBe(true)
    expect(await onDisk(archivedSource.path)).toBe(false)

    // The curate ref now names the landed commit, so a re-run has nothing to do.
    expect(await rev("refs/heads/curate/r")).toBe(merged.to)
    const again = await cli.json<CurateMerged>(["curate", "merge", "curate/r", "--skip-gate"])
    expect(again).toMatchObject({
      from: merged.to,
      to: merged.to,
      moved: false,
      replayed: null,
      snapshot: null
    })
  })

  it("a record main gained with the same content hash refuses the replay as a duplicate before the gate runs", async () => {
    const { sha } = await curate("d", [
      { op: "write", title: "Curated on d", type: "semantic", body: "The same fact twice." }
    ])
    const main = await advanceMain("d", "Written on main as d", "The same fact twice.")
    let gateRan = false
    const failed = await Effect.runPromise(
      Effect.result(
        curateMerge({
          root: cli.root,
          ref: "curate/d",
          gate: Effect.sync(() => {
            gateRan = true
            return PASSING
          })
        })
      )
    )
    expect(failed._tag).toBe("Failure")
    if (failed._tag !== "Failure") return
    expect(failed.failure._tag).toBe("InvalidMemory")
    if (failed.failure._tag !== "InvalidMemory") return
    expect(failed.failure.reason).toContain("duplicate")
    expect(failed.failure.reason).toContain("nothing moved")
    expect(gateRan).toBe(false)
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await rev("HEAD")).toBe(main)
    expect(await rev("refs/heads/curate/d")).toBe(sha)
    expect(await onDisk("areas/inbox/curated-on-d.html")).toBe(false)
    expect(await status()).toBe("")
  })

  it("a hand-made commit that edits an article in place is refused naming the path", async () => {
    const { sha } = await curate("h", [
      { op: "write", title: "Curated on h", type: "semantic", body: "Landed beside a hand edit." }
    ])
    const edited = FIXTURES[2]
    if (edited === undefined) throw new Error("no fixture")
    // A commit no session wrote: the fixture's claim changed in place, built through plumbing on a
    // private index so the checkout is untouched.
    const exec = promisify(execFile)
    const indexFile = join(scratchDir, "hand.idx")
    const plumbing = async (...args: ReadonlyArray<string>): Promise<string> =>
      (
        await exec("git", ["-C", cli.root, ...args], {
          env: { ...process.env, GIT_INDEX_FILE: indexFile, LC_ALL: "C" }
        })
      ).stdout.trim()
    const body = edited.html.replace(`names harbor ${2 % 3}`, "names harbor 9")
    const written = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "git",
        ["-C", cli.root, "hash-object", "-w", "--stdin"],
        { env: { ...process.env, LC_ALL: "C" } },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
      )
      child.stdin?.end(body)
    })
    await plumbing("read-tree", sha)
    await plumbing("update-index", "--add", "--cacheinfo", `100644,${written},${edited.path}`)
    const tree = await plumbing("write-tree")
    const hand = await plumbing("commit-tree", tree, "-p", sha, "-m", "hand edit on h")
    await plumbing("update-ref", "refs/heads/curate/h", hand, sha)

    const main = await advanceMain("h", "Written on main as h", "Main moved past h.")
    const result = await cli.run(["curate", "merge", "curate/h", "--skip-gate"])
    expect(result.exitCode).toBe(1)
    const envelope = JSON.parse(result.stdout) as { code: string; error: string }
    expect(envelope.code).toBe("ERR_INVALID_MEMORY")
    expect(envelope.error).toContain(edited.path)
    expect(envelope.error).toContain(ARTICLE_EDIT_REASON)
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await rev("refs/heads/curate/h")).toBe(hand)
    expect(await onDisk("areas/inbox/curated-on-h.html")).toBe(false)
    expect(await status()).toBe("")
  })

  it("main moving between validation and commit is settled by the retry loop", async () => {
    const { sha } = await curate("m", [
      { op: "write", title: "Curated on m", type: "semantic", body: "Lands on the second try." }
    ])
    const before = await advanceMain("m", "Written on main as m", "Main moved past m.")
    // The gate runs after validation and before the commit, so a gate that advances main is a
    // writer racing the landing at exactly the point the retry loop exists for.
    let racer: string | null = null
    const merged = await Effect.runPromise(
      curateMerge({
        root: cli.root,
        ref: "curate/m",
        gate: Effect.promise(async () => {
          racer = await advanceMain("m-race", "Written during the gate", "Raced the landing.")
          return PASSING
        })
      })
    )
    expect(racer).not.toBeNull()
    expect(before).not.toBe(racer)
    expect(merged.moved).toBe(true)
    expect(merged.gate.ran).toBe(true)
    expect(merged.replayed).toMatchObject({ attempts: 2, originalTip: sha, ops: { put: 1 } })
    expect(merged.from).toBe(racer)
    expect(await rev("refs/heads/main")).toBe(merged.to)
    expect(await rev(`${merged.to}^`)).toBe(racer)
    expect(await rev("refs/heads/curate/m")).toBe(merged.to)
    const tree = await lsTree("refs/heads/main")
    expect(tree).toContain("areas/inbox/curated-on-m.html")
    expect(tree).toContain("areas/inbox/written-during-the-gate.html")
    expect(await status()).toBe("")
  })

  /**
   * The curator labels records through `session put` label lines on its branch; `main` moves; the
   * replay reconstructs one `label` or `unlabel` per value from the two trees and lands them.
   */
  it("a curator branch that labels and unlabels records replays the entity edits onto main", async () => {
    const labeled = FIXTURES[2]
    if (labeled === undefined) throw new Error("no fixture")
    const { sha } = await curate("l", [
      { op: "write", title: "Curated on l", type: "semantic", body: "Lands beside two labels." },
      { op: "label", path: labeled.path, entity: "project:harbor" },
      { op: "label", path: labeled.path, entity: "system:memhtml" }
    ])
    // A second commit on the branch takes one of the two back off, so the replay sees the net edit.
    const id = "curator-l"
    await cli.json([
      "session",
      "put",
      "--id",
      id,
      "--file",
      await opsFile(`${id}-2`, [{ op: "unlabel", path: labeled.path, entity: "system:memhtml" }])
    ])
    const second = await cli.json<Committed>(["session", "commit", "--id", id, "--message", "l2"])
    expect(second.kind).toBe("committed")
    if (second.kind !== "committed") return
    expect(second.sha).not.toBe(sha)
    const moved = await advanceMain("l", "Written on main as l", "Main moved past l.")

    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/l", "--skip-gate"])
    expect(merged.moved).toBe(true)
    expect(merged.from).toBe(moved)
    expect(merged.replayed).toMatchObject({
      ops: { put: 1, archive: 0, link: 0, unlink: 0, label: 1, unlabel: 0 },
      attempts: 1,
      originalTip: second.sha
    })
    const onMain = await cli.git("show", `refs/heads/main:${labeled.path}`)
    expect(onMain).toContain('<meta name="memhtml-entity" content="project:harbor">')
    expect(onMain).not.toContain('content="system:memhtml"')
    expect(await rev("refs/heads/curate/l")).toBe(merged.to)
    expect(await status()).toBe("")
  })
})

/**
 * A session on a curate branch is the curation door, so its three arms judge under the `curate`
 * scope (`sessionScopeOf` in `v2.ts`): a label on an `areas/arcs/` record and an archive of a
 * `resources/people/` record land on the branch, where the same label from a session on `main` is
 * refused as a reserved path. Found on 2026-09-28 rehearsing the live collapse: 59 labels on 30
 * arcs and people records and the archive of one vague arc could not be written from the documented
 * door, only from `curate run`'s model loop.
 *
 * Mutation, run once with the change applied and this case red: `sessionScopeOf` returning
 * `"session"` for every ref -> the curate-branch `session put` is refused with `reserved path`.
 */
describe("a session on a curate branch is judged under the curate scope", () => {
  const ARC = {
    path: "areas/arcs/curate-scope-arc.html",
    html: renderTemplate({
      title: "Curate scope arc",
      claim: "An arc the curator labels names harbor 7.",
      memoryType: "semantic",
      at: AT
    })
  }
  const PERSON = {
    path: "resources/people/curate-scope-person.html",
    html: renderTemplate({
      title: "Curate scope person",
      claim: "A people stub the curator archives names harbor 8.",
      memoryType: "semantic",
      at: AT
    })
  }

  it("labels an arc and archives a people record from session put and session exec, and refuses the label on main", async () => {
    for (const file of [ARC, PERSON]) {
      const target = join(cli.root, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.html, "utf8")
    }
    await cli.git("add", "-A", "--", ARC.path, PERSON.path)
    await cli.git("commit", "-q", "-m", "arc and person fixtures")

    const label = [{ op: "label", path: ARC.path, entity: "project:harbor" }]
    await cli.json(["session", "start", "--id", "scope-main"])
    const onMain = await cli.run([
      "session",
      "put",
      "--id",
      "scope-main",
      "--file",
      await opsFile("scope-main", label)
    ])
    expect(onMain.exitCode).toBe(1)
    expect(onMain.stdout).toContain("reserved path")

    const id = "curator-scope"
    await cli.json(["session", "start", "--id", id, "--ref", "curate/scope"])
    const appended = await cli.json<{ readonly appended: number }>([
      "session",
      "put",
      "--id",
      id,
      "--file",
      await opsFile(id, label)
    ])
    expect(appended.appended).toBe(1)
    const script = join(scratchDir, "scope-archive.sh")
    await writeFile(
      script,
      `set -e\nmkdir -p /mnt/memhtml/archive/2026/resources/people\nmv /mnt/memhtml/${PERSON.path} /mnt/memhtml/archive/2026/${PERSON.path}\n`
    )
    const exec = await cli.json<{
      readonly appended: number
      readonly blocking: ReadonlyArray<string>
      readonly harvested: ReadonlyArray<{ readonly kind: string; readonly path: string }>
    }>(["session", "exec", "--id", id, "--file", script])
    expect(exec.blocking).toEqual([])
    expect(exec.appended).toBe(1)
    expect(exec.harvested).toEqual([
      expect.objectContaining({ kind: "archive", path: PERSON.path })
    ])

    const committed = await cli.json<Committed>([
      "session",
      "commit",
      "--id",
      id,
      "--message",
      "scope"
    ])
    expect(committed.kind).toBe("committed")
    const subject = (await cli.git("log", "-1", "--format=%s", "refs/heads/curate/scope")).trim()
    expect(subject).toBe("memhtml(curate): scope")
    const onBranch = await cli.git("show", `refs/heads/curate/scope:${ARC.path}`)
    expect(onBranch).toContain('<meta name="memhtml-entity" content="project:harbor">')
    expect(await lsTree("refs/heads/curate/scope")).toContain(`archive/2026/${PERSON.path}`)
    expect(await lsTree("refs/heads/curate/scope")).not.toContain(PERSON.path)
  })
})

/**
 * A replay is one commit of the whole branch, so it is not held to the 200-op batch cap each of
 * the branch's own commits was: found on 2026-09-28 rehearsing the live collapse, whose 70-commit
 * branch reconstructs to 2,747 ops and was refused with "2747 ops exceeds the cap of 200" the first
 * time `main` moved under it.
 *
 * Mutation, run once with the change applied and this case red: `MERGE_BATCH_CAP` set to
 * `BATCH_CAP` in `v2.ts` -> the merge is refused naming the cap.
 */
describe("a replay past the batch cap", () => {
  it("lands a curate branch whose commits add up to more than 200 ops as one replayed commit", async () => {
    const id = "curator-big"
    await cli.json(["session", "start", "--id", id, "--ref", "curate/big"])
    for (const part of [0, 1]) {
      const writes = Array.from({ length: 105 }, (_, index) => ({
        op: "write",
        title: `Big replay record ${part}-${index}`,
        type: "semantic",
        body: `Big replay fact ${part}-${index} names harbor ${index} of part ${part}.`
      }))
      await cli.json([
        "session",
        "put",
        "--id",
        id,
        "--file",
        await opsFile(`${id}-${part}`, writes)
      ])
      const committed = await cli.json<Committed>([
        "session",
        "commit",
        "--id",
        id,
        "--message",
        `big part ${part}`
      ])
      expect(committed.kind).toBe("committed")
    }
    const moved = await advanceMain("big", "Written on main as big", "Main moved past big.")

    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/big", "--skip-gate"])
    expect(merged.moved).toBe(true)
    expect(merged.from).toBe(moved)
    expect(merged.replayed).toMatchObject({ ops: { put: 210, archive: 0, label: 0 }, attempts: 1 })
    expect((await cli.git("rev-parse", "refs/heads/main")).trim()).toBe(merged.to)
    const landed = await lsTree("refs/heads/main")
    expect(landed.filter((path) => path.includes("big-replay-record-")).length).toBe(210)
    expect(await status()).toBe("")
  }, 180_000)
})
