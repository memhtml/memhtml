import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { CurateMerged, CurateRunReport } from "@memhtml/cli"
import { renderTemplate } from "@memhtml/html"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"

/**
 * The curator end to end (`docs/v2-poc.md`, "Curator"): `curate run --model fake` over a 300-memory
 * fixture that holds one deliberate frame-key duplicate pair lands one archive plus one link on
 * `curate/<date>`, both from the one `exec` (the fake's script splices the `supersedes` link into the
 * kept file's head, and the harvester turns that head edit into a `link` op, so no `propose` runs),
 * a second run without `--resume` refuses `session.exists`, `curate merge` lands the branch on
 * `main`, and a dry run leaves no session, no ref, and no commit.
 *
 * Every ref position is read back with `rev-parse` and every file claim with `git show` or `access`,
 * independently of the payload under test. The fixture is committed with porcelain, not through the
 * CLI, because nothing here reads the SQLite index.
 *
 * Mutations, each run once with the change applied and the named case red (2026-09-23):
 * - `curate-run.ts` `curateRun`: `startSession({ ..., force: true })` -> "a second run without
 *   --resume refuses session.exists" (the second run starts over and commits again) and "--resume
 *   reopens the landed session" (the base is no longer the landed commit).
 * - `curate-run.ts` `curateRun`: open a real session under `dryRun` too -> "a dry run appends
 *   nothing, commits nothing, and leaves the ref unborn" (a session log appears) and the landing case
 *   after it (the real run is refused with `session.exists`).
 * - `curate-run.ts` `curateRun`: skip `land` and report a zero sha -> "lands one archive plus one
 *   link" (the ref stays unborn), the resume case, and the merge case.
 * - `curate-run.ts` `curateRun`: the resume branch wraps the session in `sessionOverlay` under
 *   `dryRun` too -> "--dry-run --resume previews a started session and leaves its log, its ref, and
 *   main untouched" (the outcome is `committed`, the ref is born, and the log holds two ops).
 */

const FIXTURE_SIZE = 300
const AT = "2026-09-20T12:00:00Z"
const REF = "curate/2026-09-23"
const QUALIFIED = `refs/heads/${REF}`
/** The archive year the fake derives from the clock, so the assertions hold past this year. */
const YEAR = String(new Date().getUTCFullYear())

/** One fixture memory, distinct in claim, with no frame shape so it joins no frame-key group. */
const fixtureMemory = (index: number): { readonly path: string; readonly html: string } => ({
  path: `areas/inbox/fixture-${String(index).padStart(3, "0")}.html`,
  html: renderTemplate({
    title: `Fixture ${index}`,
    claim: `Fixture fact ${index} names region ${index % 7}.`,
    body: [`Region ${index % 7} trades through port ${index % 11}.`],
    memoryType: "semantic",
    at: AT,
    tags: [`region-${index % 7}`]
  })
})

/**
 * The deliberate duplicate pair: one frame key (`the capital of india is`) with the same value said
 * two ways, so the head's `byFrameKey` holds both and the briefing lists one group of two. The fake
 * keeps the path that sorts first, so the names decide which one survives.
 */
const KEPT = "areas/inbox/capital-a.html"
const DUPLICATE = "areas/inbox/capital-b.html"
const PAIR = [
  {
    path: KEPT,
    html: renderTemplate({
      title: "Capital of India",
      claim: "The capital of India is New Delhi.",
      memoryType: "semantic",
      at: AT
    })
  },
  {
    path: DUPLICATE,
    html: renderTemplate({
      title: "Capital of India, restated",
      claim: "The capital of India is New Delhi city.",
      body: ["Stated a second time in other words."],
      memoryType: "semantic",
      at: AT
    })
  }
]

let cli: Cli

const rev = async (ref: string): Promise<string | null> => {
  try {
    return (await cli.git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).trim()
  } catch {
    return null
  }
}
const onDisk = (path: string): Promise<boolean> =>
  access(join(cli.root, path)).then(
    () => true,
    () => false
  )
const sessionLog = (id: string): Promise<boolean> => onDisk(`.memhtml/sessions/${id}.json`)
/** The ops a session's log holds, read off disk independently of any payload. */
const loggedOps = async (id: string): Promise<number> => {
  const log = JSON.parse(
    await readFile(join(cli.root, `.memhtml/sessions/${id}.json`), "utf8")
  ) as { ops: ReadonlyArray<unknown> }
  return log.ops.length
}

beforeAll(async () => {
  cli = await makeCli()
  const files = [
    ...Array.from({ length: FIXTURE_SIZE }, (_, index) => fixtureMemory(index)),
    ...PAIR
  ]
  for (const file of files) {
    const target = join(cli.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await cli.git("add", "-A")
  await cli.git("commit", "-q", "-m", "curator fixture")
}, 180_000)

afterAll(async () => {
  await cli.cleanup()
})

describe("curate run --model fake", () => {
  it("a dry run appends nothing, commits nothing, and leaves the ref unborn", async () => {
    const main = await rev("refs/heads/main")
    const report = await cli.json<CurateRunReport>([
      "curate",
      "run",
      "--model",
      "fake",
      "--ref",
      REF,
      "--dry-run"
    ])
    expect(report.dryRun).toBe(true)
    expect(report.outcome).toBe("dry-run")
    expect(report.commit).toBeNull()
    expect(report.stoppedBy).toBe("finish")
    // The would-be harvest is reported: the fake's one exec archives the duplicate and links the
    // kept record, so the link op came from code mode and no propose call was made.
    expect(report.ops).toEqual({ put: 0, archive: 1, link: 1 })
    expect(report.toolCalls).toEqual(["status", "exec", "finish"])
    expect(report.toolCalls).not.toContain("propose")
    expect(await rev(QUALIFIED)).toBeNull()
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await sessionLog("curate-2026-09-23")).toBe(false)
    expect(await onDisk(DUPLICATE)).toBe(true)
  })

  it("--dry-run --resume previews a started session and leaves its log, its ref, and main untouched", async () => {
    // A different date, so the session this case opens never collides with the landing cases.
    const ref = "curate/2026-09-22"
    const id = "curate-2026-09-22"
    const main = await rev("refs/heads/main")
    await cli.json(["session", "start", "--id", id, "--ref", ref])
    expect(await loggedOps(id)).toBe(0)

    const report = await cli.json<CurateRunReport>([
      "curate",
      "run",
      "--model",
      "fake",
      "--ref",
      ref,
      "--dry-run",
      "--resume"
    ])
    expect(report.dryRun).toBe(true)
    expect(report.resumed).toBe(true)
    expect(report.baseSha).toBe(main)
    expect(report.outcome).toBe("dry-run")
    expect(report.commit).toBeNull()
    expect(report.stoppedBy).toBe("finish")
    // The preview shows what the resumed run would append: the same pair the plain dry run finds.
    expect(report.ops).toEqual({ put: 0, archive: 1, link: 1 })

    expect(await rev(`refs/heads/${ref}`)).toBeNull()
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await loggedOps(id)).toBe(0)
    expect(await onDisk(DUPLICATE)).toBe(true)
  })

  it("lands one archive plus one link on the curator branch and reports the loop", async () => {
    const main = await rev("refs/heads/main")
    const report = await cli.json<CurateRunReport>([
      "curate",
      "run",
      "--model",
      "fake",
      "--ref",
      REF
    ])
    expect(report.ref).toBe(QUALIFIED)
    expect(report.sessionId).toBe("curate-2026-09-23")
    expect(report.baseSha).toBe(main)
    expect(report.stoppedBy).toBe("finish")
    expect(report.outcome).toBe("committed")
    // One archive and one link, both harvested from the exec: the fake never calls propose.
    expect(report.ops).toEqual({ put: 0, archive: 1, link: 1 })
    expect(report.toolCalls).toEqual(["status", "exec", "finish"])
    expect(report.toolCalls).not.toContain("propose")
    expect(report.steps).toBe(3)
    expect(report.tokens.input).toBeGreaterThan(0)
    expect(report.briefing.frameKeyGroups).toEqual([
      {
        key: "the capital of india is",
        records: [
          { path: KEPT, claim: "The capital of India is New Delhi." },
          { path: DUPLICATE, claim: "The capital of India is New Delhi city." }
        ]
      }
    ])
    expect(report.briefing.active).toBe(FIXTURE_SIZE + 2)
    expect(report.next).toBe(`memhtml curate merge ${QUALIFIED}`)

    // The branch exists at the commit, main did not move, and the checkout did not follow.
    expect(report.commit).not.toBeNull()
    expect(await rev(QUALIFIED)).toBe(report.commit)
    expect(await rev("refs/heads/main")).toBe(main)
    expect(await onDisk(DUPLICATE)).toBe(true)

    // The subject is the report's first line under the curate scope, with the session trailer.
    const message = await cli.git("log", "-1", "--format=%B", QUALIFIED)
    expect(message.startsWith("memhtml(curate): Archived 1 duplicate record(s)")).toBe(true)
    expect(message).toContain("Memhtml-Session: curate-2026-09-23")

    // The tree: the duplicate moved under archive/, the kept record gained the supersedes link.
    const paths = (await cli.git("ls-tree", "-r", "--name-only", QUALIFIED)).split("\n")
    expect(paths).not.toContain(DUPLICATE)
    expect(paths).toContain(`archive/${YEAR}/${DUPLICATE}`)
    const kept = await cli.git("show", `${QUALIFIED}:${KEPT}`)
    expect(kept).toContain(`<link rel="memhtml-supersedes" href="/archive/${YEAR}/${DUPLICATE}">`)
    const archived = await cli.git("show", `${QUALIFIED}:archive/${YEAR}/${DUPLICATE}`)
    expect(archived).toContain('<meta name="memhtml-status" content="archived">')
  })

  it("a second run without --resume refuses session.exists at exit 1", async () => {
    const tip = await rev(QUALIFIED)
    const result = await cli.run(["curate", "run", "--model", "fake", "--ref", REF])
    expect(result.exitCode).toBe(1)
    const body = JSON.parse(result.stdout) as { code: string; error: string }
    expect(body.code).toBe("ERR_STORAGE")
    expect(body.error).toContain("session.exists")
    expect(await rev(QUALIFIED)).toBe(tip)
  })

  it("--resume reopens the landed session, finds nothing left, and commits nothing", async () => {
    const tip = await rev(QUALIFIED)
    const report = await cli.json<CurateRunReport>([
      "curate",
      "run",
      "--model",
      "fake",
      "--ref",
      REF,
      "--resume"
    ])
    expect(report.resumed).toBe(true)
    // The session's base is the commit it landed, where the pair is already settled.
    expect(report.baseSha).toBe(tip)
    expect(report.briefing.frameKeyGroupsTotal).toBe(0)
    expect(report.outcome).toBe("no-ops")
    expect(report.commit).toBeNull()
    expect(await rev(QUALIFIED)).toBe(tip)
  })

  it("curate merge --skip-gate lands main at the curator's commit", async () => {
    const before = await rev("refs/heads/main")
    const target = await rev(QUALIFIED)
    const merged = await cli.json<CurateMerged>(["curate", "merge", REF, "--skip-gate"])
    expect(merged).toMatchObject({ from: before, to: target, moved: true, worktreeSynced: true })
    expect(await rev("refs/heads/main")).toBe(target)
    expect(await onDisk(DUPLICATE)).toBe(false)
    expect(await onDisk(`archive/${YEAR}/${DUPLICATE}`)).toBe(true)
    // The edge placed from code mode is on main's tree and in the checkout.
    const kept = await cli.git("show", `refs/heads/main:${KEPT}`)
    expect(kept).toContain(`<link rel="memhtml-supersedes" href="/archive/${YEAR}/${DUPLICATE}">`)
    expect(await readFile(join(cli.root, KEPT), "utf8")).toBe(kept)
  })
})
