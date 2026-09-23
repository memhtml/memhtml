import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { type CurateMerged, curateMerge } from "@memhtml/cli"
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
 * - `v2.ts` `curateMerge`: drop the `isAncestor(from, to)` refusal -> "a curator branch that is not
 *   a descendant of main is refused and nothing moves" (main is fast-forwarded to a commit that does
 *   not contain it, so `merge-base --is-ancestor` of the old main into the new one turns false).
 * - `v2.ts` `curateMerge`: replace the gate call with `gate = { ran: false, passed: null }` -> "a
 *   merge without --skip-gate runs the fake-mode gate and reports it" (`gate.ran` is false) and "an
 *   injected failing gate fails the merge with its numbers and moves nothing" (the failure never
 *   fires).
 * - `v2.ts` `curateMerge`: drop `readTreeIntoWorktree(from, to)` -> "curate merge --skip-gate lands
 *   main at the curator's commit with the working tree following" (the put files are absent on
 *   disk and `status` reports staged deletions).
 * - `v2.ts` `curateMerge`: drop the `dirtyPaths` refusal -> "an uncommitted edit at a path the
 *   landing changes is refused as a dirty tree" (`read-tree -u` overwrites the edit or fails with
 *   ERR_GIT instead).
 * - `commit.ts` step 6: pass `expected: to` in place of `mainSha` for an unborn ref -> "a curator
 *   session on an unborn ref is created by its first commit" (`update-ref` refuses to create).
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
  await writeFile(file, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`)
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
      worktreeSynced: true
    })

    expect(await rev("refs/heads/main")).toBe(target)
    expect(await rev("HEAD")).toBe(target)
    expect(await status()).toBe("")
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
    expect(merged).toMatchObject({ from: main, to: main, moved: false, worktreeSynced: false })
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

  it("a curator branch that is not a descendant of main is refused and nothing moves", async () => {
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

    const result = await cli.run(["curate", "merge", "curate/y", "--skip-gate"])
    expect(result.exitCode).toBe(1)
    const body = JSON.parse(result.stdout) as { code: string; error: string }
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("not a descendant")
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await rev("refs/heads/curate/y")).toBe(sha)
    expect(await onDisk(written.path)).toBe(true)
    expect(await onDisk("areas/inbox/curated-on-y.html")).toBe(false)
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
  it("a merge without --skip-gate runs the fake-mode gate and reports it", async () => {
    const { sha } = await curate("z", [
      { op: "write", title: "Curated on z", type: "semantic", body: "Lands behind the gate." }
    ])
    const before = await rev("refs/heads/main")
    const merged = await cli.json<CurateMerged>(["curate", "merge", "curate/z"])
    expect(merged).toMatchObject({ from: before, to: sha, moved: true, worktreeSynced: true })
    expect(merged.gate.ran).toBe(true)
    expect(merged.gate.passed).toBe(true)
    expect(merged.gate.mode).toBe("fake")
    expect(typeof merged.gate.mrr).toBe("number")
    expect(merged.gate.mrr).toBeGreaterThanOrEqual(merged.gate.mrrFloor ?? Number.POSITIVE_INFINITY)
    expect(merged.gate.probes).toBeGreaterThan(0)
    expect(merged.gate.inversions).toBe(0)
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
