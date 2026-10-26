import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { CollapsePlan } from "@memhtml/curator"
import { renderTemplate } from "@memhtml/html"
import { makeGit } from "@memhtml/store"
import { configureIdentity } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { CurateCollapseReport } from "../src/curate-collapse.js"
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../src/envelope.js"
import { run } from "../src/run.js"

/**
 * `memhtml curate collapse --model fake` end to end over a real temp repo (`docs/design.md` §23,
 * "The collapse"): a dry run prints the plan and writes nothing; a run with rulings lands the
 * archive cluster with no model and every fold through the fake, with each member archived and
 * reached from its canonical by a `supersedes` link; a keep cluster and a keep-ruled record are
 * untouched; a saved plan replays with `--only`, and a plan whose `largeGroup` is lowered drives
 * the driver-completes path where the fake writes the put alone and the driver adds every archive
 * and link.
 *
 * Every claim about the tree is read back with `git show`, `git ls-tree`, or `access`, independently
 * of the payload. The fixture is committed with porcelain because nothing here reads the SQLite index.
 *
 * Mutations, each run once with the change applied and the named case red (2026-09-24):
 * - `curate-collapse.ts` `curateCollapse`: run the clusters under `dryRun` too -> "a dry run prints
 *   the plan and writes nothing" (a session log appears and the ref is born).
 * - `curate-collapse.ts` `foldCluster`: `links` left empty (no driver supersedes completion) ->
 *   "a lowered largeGroup drives the driver-completes path" (the canonical carries no supersedes
 *   link and `driver.link` is 0).
 * - `curate-collapse.ts` `foldCluster`: `completion` left empty -> the same case (the members stay
 *   active, `driver.archive` is 0).
 * - `curate-collapse.ts` `curateCollapse`: `executable` includes `keep` clusters -> "lands the
 *   archive cluster and every fold" (the Freedonia pair is folded and one of its sides archived).
 * - `run.ts` `curateRunFlags`: `CURATOR_COMMANDS` without `curate collapse` -> "refuses a ref outside
 *   curate/ and a non-positive pool at exit 2" (the ref case falls through to exit 1, the pool case
 *   to a run).
 * - `curate-collapse.ts` `archivable`: ignore the `keep` ruling -> "lands the archive cluster and
 *   every fold" (`verify-3` is archived).
 */

const AT = "2026-09-20T12:00:00Z"
const REF = "curate/collapse-test"
const QUALIFIED = `refs/heads/${REF}`
const YEAR = String(new Date().getUTCFullYear())

const VERIFY = [
  "Verify against the primary source before asserting a result or claiming completion.",
  "Always verify the primary source before asserting completion of a result.",
  "Before claiming completion, verify the result against its primary source.",
  "Assert a result only after verifying it against the primary source."
]
const PKILL = [
  "pkill -f matching the shell's own command line kills the shell that ran it.",
  "A pkill -f pattern that matches its own shell command line kills the running shell.",
  "Never run pkill -f with a pattern the invoking shell command line also matches."
]
const SINGLETONS = [
  "The docs site renders diagrams through d2 at build time.",
  "Lighthouse scores a static page pessimistically under host contention.",
  "The snapshot file is one Arrow IPC table per commit."
]

const verifyPath = (index: number) => `areas/inbox/verify-${String(index)}.html`
const pkillPath = (index: number) => `areas/inbox/pkill-${String(index)}.html`
const singlePath = (index: number) => `areas/inbox/single-${String(index)}.html`

const FILES: ReadonlyArray<{ readonly path: string; readonly html: string }> = [
  ...VERIFY.map((claim, index) => ({
    path: verifyPath(index),
    html: renderTemplate({
      title: `Verify before asserting ${String(index)}`,
      claim,
      body: [`Seen on run ${String(index)}.`],
      memoryType: "user_preference",
      at: AT,
      tags: ["verification"]
    })
  })),
  ...PKILL.map((claim, index) => ({
    path: pkillPath(index),
    html: renderTemplate({
      title: `pkill self match ${String(index)}`,
      claim,
      body: [`Exit code 144 on attempt ${String(index)}.`],
      memoryType: "error_pattern",
      at: AT
    })
  })),
  ...SINGLETONS.map((claim, index) => ({
    path: singlePath(index),
    html: renderTemplate({
      title: `Singleton ${String(index)}`,
      claim,
      memoryType: "semantic",
      at: AT
    })
  })),
  {
    path: "areas/inbox/capital-a.html",
    html: renderTemplate({
      title: "Capital of India",
      claim: "The capital of India is New Delhi.",
      memoryType: "semantic",
      at: AT
    })
  },
  {
    path: "areas/inbox/capital-b.html",
    html: renderTemplate({
      title: "Capital of India, again",
      claim: "The capital of India is New Delhi.",
      body: ["Restated with a body."],
      memoryType: "semantic",
      at: AT
    })
  },
  {
    path: "areas/inbox/freedonia-a.html",
    html: renderTemplate({
      title: "Capital of Freedonia",
      claim: "The capital of Freedonia is Fredville.",
      memoryType: "semantic",
      at: AT
    })
  },
  {
    path: "areas/inbox/freedonia-b.html",
    html: renderTemplate({
      title: "Capital of Freedonia, disputed",
      claim: "The capital of Freedonia is Chicolini.",
      memoryType: "semantic",
      at: AT
    })
  }
]

const RULINGS = [
  { path: singlePath(0), verdict: "archive", reason: "stub" },
  { path: singlePath(1), verdict: "trace", reason: "run narrative" },
  { path: verifyPath(3), verdict: "keep", reason: "the best statement" }
]

let root: string
let work: string
const roots: Array<string> = []

const git = (...args: ReadonlyArray<string>): Promise<string> =>
  Effect.runPromise(
    makeGit(root)
      .run([...args])
      .pipe(Effect.orDie)
  )

const rev = async (ref: string): Promise<string | null> => {
  try {
    const sha = (await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).trim()
    return sha === "" ? null : sha
  } catch {
    return null
  }
}
const onDisk = (path: string): Promise<boolean> =>
  access(join(root, path)).then(
    () => true,
    () => false
  )
const treeOf = async (ref: string): Promise<ReadonlySet<string>> =>
  new Set((await git("ls-tree", "-r", "--name-only", ref)).split("\n").filter((l) => l !== ""))
const show = (ref: string, path: string): Promise<string> => git("show", `${ref}:${path}`)

const parse = <A>(stdout: string): A => JSON.parse(stdout) as A
interface Envelope {
  readonly type?: string
  readonly code?: string
  readonly error?: string
  readonly data?: CurateCollapseReport
}

/** A fresh repo with the fixture committed on `main`. */
const freshRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-curate-collapse-"))
  roots.push(dir)
  const g = makeGit(dir)
  await Effect.runPromise(g.run(["init", "-b", "main", "."]).pipe(Effect.orDie))
  await Effect.runPromise(configureIdentity(g))
  for (const file of FILES) {
    const target = join(dir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await Effect.runPromise(g.run(["add", "-A"]).pipe(Effect.orDie))
  await Effect.runPromise(g.run(["commit", "-q", "-m", "collapse fixture"]).pipe(Effect.orDie))
  return dir
}

beforeAll(async () => {
  root = await freshRepo()
  work = await mkdtemp(join(tmpdir(), "memhtml-curate-collapse-work-"))
  roots.push(work)
  await writeFile(
    join(work, "rulings.jsonl"),
    `${RULINGS.map((ruling) => JSON.stringify(ruling)).join("\n")}\n`,
    "utf8"
  )
})
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
})

const collapse = (...args: ReadonlyArray<string>) =>
  run(["curate", "collapse", "--model", "fake", "--repo", root, ...args])

describe("curate collapse --model fake", () => {
  it("a dry run prints the plan and writes nothing", async () => {
    const result = await collapse(
      "--ref",
      REF,
      "--rulings",
      join(work, "rulings.jsonl"),
      "--dry-run"
    )
    expect(result.exitCode, result.stdout).toBe(EXIT_OK)
    const body = parse<Envelope>(result.stdout)
    expect(body.type).toBe("curate.collapse")
    const data = body.data as CurateCollapseReport
    expect(data.dryRun).toBe(true)
    expect(data.planSource).toBe("computed")
    expect(data.plan).not.toBeNull()
    const plan = data.plan as CollapsePlan
    expect(plan.sha).toBe(await rev("refs/heads/main"))
    expect(data.base).toBe(plan.sha)
    expect(data.totals.clusters).toEqual({ archive: 1, fold: 3, keep: 1 })
    expect(data.totals.ruledKeep).toBe(1)
    expect(data.clusters.every((cluster) => cluster.outcome === "dry-run")).toBe(true)
    expect(data.clusters).toHaveLength(4)
    expect(data.untouched.map((cluster) => cluster.kind)).toEqual(["keep"])
    expect(data.tip).toBeNull()
    expect(data.snapshot).toBeNull()
    expect(data.next).toBe(`memhtml curate merge ${QUALIFIED}`)
    // Nothing on disk: no session log, no ref, main where it was.
    expect(await onDisk(".memhtml/sessions")).toBe(false)
    expect(await rev(QUALIFIED)).toBeNull()
    await writeFile(join(work, "plan.json"), JSON.stringify(plan), "utf8")
    // The saved plan replays against the same tip with no mismatch and no recomputation.
    const replay = await collapse("--ref", REF, "--plan", join(work, "plan.json"), "--dry-run")
    expect(replay.exitCode, replay.stdout).toBe(EXIT_OK)
    const replayed = parse<Envelope>(replay.stdout).data as CurateCollapseReport
    expect(replayed.planSource).toBe("file")
    expect(replayed.planShaMismatch).toBe(false)
    expect(replayed.planMs).toBe(0)
    expect(replayed.clusters.map((c) => c.id)).toEqual(data.clusters.map((c) => c.id))
  }, 120_000)

  it("lands the archive cluster and every fold: each member archived and reached from its canonical", async () => {
    const main = await rev("refs/heads/main")
    const result = await collapse("--ref", REF, "--rulings", join(work, "rulings.jsonl"))
    expect(result.exitCode, result.stdout).toBe(EXIT_OK)
    const data = parse<Envelope>(result.stdout).data as CurateCollapseReport
    expect(data.dryRun).toBe(false)
    expect(data.plan).toBeNull()
    expect(data.summary.failed, JSON.stringify(data.clusters.map((c) => c.error))).toBe(0)
    expect(data.summary.committed).toBe(4)
    expect(data.summary.canonicals).toBe(3)
    // The archive cluster: two ruled paths, no model, no steps.
    const archive = data.clusters.find((cluster) => cluster.kind === "archive")
    expect(archive?.outcome).toBe("committed")
    expect(archive?.steps).toBe(0)
    expect(archive?.ops).toEqual({
      put: 0,
      archive: 2,
      link: 0,
      unlink: 0,
      label: 0,
      unlabel: 0,
      move: 0
    })
    expect(archive?.commits).toHaveLength(1)
    // Each fold: one put, one archive per member, one link per member, two model calls.
    for (const fold of data.clusters.filter((cluster) => cluster.kind === "fold")) {
      expect(fold.outcome, fold.id).toBe("committed")
      expect(fold.canonical, fold.id).not.toBeNull()
      expect(fold.ops.put, fold.id).toBe(1)
      expect(fold.ops.archive, fold.id).toBe(fold.members)
      expect(fold.ops.link, fold.id).toBe(0)
      expect(fold.steps, fold.id).toBe(2)
      expect(fold.stoppedBy, fold.id).toBe("finish")
      expect(fold.warnings, fold.id).toEqual([])
    }
    // Every commit is on the ref, main did not move, and the checkout was never touched.
    const tip = await rev(QUALIFIED)
    expect(tip).not.toBeNull()
    expect(data.tip).toBe(tip)
    // The ref moved, so its tip is cached for the merge that follows.
    expect(data.snapshot?.sha).toBe(tip)
    expect(data.snapshot?.rows).toBeGreaterThan(0)
    expect(await rev("refs/heads/main")).toBe(main)
    expect(Number((await git("rev-list", "--count", `${main ?? ""}..${QUALIFIED}`)).trim())).toBe(
      data.summary.commits
    )
    // Nothing tracked changed in the checkout, and the session logs and the snapshot, the only
    // things written under `.memhtml/`, are excluded through `.git/info/exclude` by the code that
    // writes them, so the status is clean.
    expect((await git("status", "--porcelain", "--untracked-files=no")).trim()).toBe("")
    expect((await git("status", "--porcelain")).trim()).toBe("")
    expect(await onDisk(".memhtml/sessions")).toBe(true)
    expect(await onDisk(".memhtml/snapshots")).toBe(true)

    const tree = await treeOf(QUALIFIED)
    // The archive-ruled paths moved; the keep-ruled one and the singleton without a ruling stayed.
    expect(tree.has(singlePath(0))).toBe(false)
    expect(tree.has(`archive/${YEAR}/${singlePath(0)}`)).toBe(true)
    expect(tree.has(`archive/${YEAR}/${singlePath(1)}`)).toBe(true)
    expect(tree.has(verifyPath(3))).toBe(true)
    expect(tree.has(singlePath(2))).toBe(true)
    // The contradiction candidates were left alone, both sides live.
    expect(tree.has("areas/inbox/freedonia-a.html")).toBe(true)
    expect(tree.has("areas/inbox/freedonia-b.html")).toBe(true)
    // The verify fold: three members archived, the canonical under a new home pointing at each.
    const verify = data.clusters.find((cluster) => cluster.id.includes("user-preference"))
    expect(verify?.members).toBe(3)
    const canonical = verify?.canonical ?? ""
    expect(canonical.startsWith("areas/")).toBe(true)
    expect(canonical.startsWith("areas/inbox/")).toBe(false)
    expect(tree.has(canonical)).toBe(true)
    const html = await show(QUALIFIED, canonical)
    for (const index of [0, 1, 2]) {
      expect(tree.has(verifyPath(index))).toBe(false)
      expect(tree.has(`archive/${YEAR}/${verifyPath(index)}`)).toBe(true)
      expect(html).toContain(`href="/archive/${YEAR}/${verifyPath(index)}"`)
      const archived = await show(QUALIFIED, `archive/${YEAR}/${verifyPath(index)}`)
      expect(archived).toContain('name="memhtml-status" content="archived"')
    }
    expect(html).toContain('name="memhtml-tag" content="collapse-')
    // The frame-key fold: the India pair behind one canonical.
    const india = data.clusters.find((cluster) => cluster.id.startsWith("frame-"))
    expect(india?.members).toBe(2)
    expect(tree.has("areas/inbox/capital-a.html")).toBe(false)
    expect(tree.has(`archive/${YEAR}/areas/inbox/capital-b.html`)).toBe(true)
    // Commit subjects name the scope and the cluster.
    const subjects = await git("log", "--format=%s", `${main ?? ""}..${QUALIFIED}`)
    expect(subjects).toContain("memhtml(curate): archive 2 records: archive-none-")
    expect(subjects).toContain("memhtml(curate): fold ")
  }, 180_000)

  it("a second run over the landed ref finds nothing left and commits nothing", async () => {
    const tip = await rev(QUALIFIED)
    const result = await collapse("--ref", REF, "--rulings", join(work, "rulings.jsonl"))
    expect(result.exitCode, result.stdout).toBe(EXIT_OK)
    const data = parse<Envelope>(result.stdout).data as CurateCollapseReport
    expect(data.base).toBe(tip)
    expect(data.summary.commits).toBe(0)
    expect(await rev(QUALIFIED)).toBe(tip)
  }, 120_000)

  it("a saved plan replays with --only, and a lowered largeGroup drives the driver-completes path", async () => {
    // A fresh repo, so the saved plan's members are all active again; the plan names main's sha.
    root = await freshRepo()
    const saved = parse<CollapsePlan>(await readFile(join(work, "plan.json"), "utf8"))
    const pkill = saved.clusters.find((cluster) => cluster.id.includes("error-pattern"))
    if (pkill === undefined) throw new Error("the plan holds no pkill fold")
    const lowered: CollapsePlan = { ...saved, options: { ...saved.options, largeGroup: 1 } }
    await writeFile(join(work, "plan-large.json"), JSON.stringify(lowered), "utf8")
    const result = await collapse(
      "--ref",
      REF,
      "--plan",
      join(work, "plan-large.json"),
      "--only",
      `${pkill.id},no-such-cluster`
    )
    expect(result.exitCode, result.stdout).toBe(EXIT_OK)
    const data = parse<Envelope>(result.stdout).data as CurateCollapseReport
    expect(data.planSource).toBe("file")
    expect(data.planMs).toBe(0)
    // The fresh repo's commit has another sha than the one the plan was computed over, so the
    // mismatch is reported; every member is re-checked against the tip, so the fold still lands.
    expect(data.planShaMismatch).toBe(true)
    expect(data.clusters.map((cluster) => cluster.id)).toEqual([pkill.id])
    const [fold] = data.clusters
    expect(fold?.outcome, fold?.error ?? "").toBe("committed")
    // The fake wrote the put alone; the driver added every archive and every link in the same session.
    expect(fold?.ops).toEqual({
      put: 1,
      archive: 3,
      link: 3,
      unlink: 0,
      label: 0,
      unlabel: 0,
      move: 0
    })
    expect(fold?.driver).toEqual({ archive: 3, link: 3 })
    expect(fold?.commits).toHaveLength(1)
    const tree = await treeOf(QUALIFIED)
    const html = await show(QUALIFIED, fold?.canonical ?? "")
    for (const index of [0, 1, 2]) {
      expect(tree.has(pkillPath(index))).toBe(false)
      expect(html).toContain(`href="/archive/${YEAR}/${pkillPath(index)}"`)
    }
    // Every other cluster is untouched and says so.
    expect(data.untouched.map((cluster) => cluster.id)).toContain("archive-none-semantic")
    expect(tree.has(verifyPath(0))).toBe(true)
    expect(tree.has(singlePath(0))).toBe(true)
  }, 180_000)
})

describe("curate collapse's refusals", () => {
  it("refuses a ref outside curate/ and a non-positive pool at exit 2, before any repo opens", async () => {
    for (const argv of [
      ["--ref", "main"],
      ["--ref", "refs/heads/feature/x"],
      ["--concurrency", "0"],
      ["--limit", "-1"],
      ["--max-steps", "soon"]
    ]) {
      const result = await run([
        "curate",
        "collapse",
        "--model",
        "fake",
        "--repo",
        "/nonexistent",
        ...argv
      ])
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      expect(parse<Envelope>(result.stdout).code, argv.join(" ")).toBe("ERR_INVALID_FLAG")
    }
  })

  it("refuses --only naming no executable cluster, and a missing plan or rulings file, at exit 1", async () => {
    root = await freshRepo()
    const only = await collapse("--ref", REF, "--only", "nope", "--dry-run")
    expect(only.exitCode).toBe(EXIT_RUNTIME)
    expect(parse<Envelope>(only.stdout).code).toBe("ERR_INVALID_MEMORY")
    const plan = await collapse("--ref", REF, "--plan", join(work, "absent.json"))
    expect(plan.exitCode).toBe(EXIT_RUNTIME)
    expect(parse<Envelope>(plan.stdout).code).toBe("ERR_STORAGE")
    const rulings = await collapse("--ref", REF, "--rulings", join(work, "absent.jsonl"))
    expect(rulings.exitCode).toBe(EXIT_RUNTIME)
    expect(parse<Envelope>(rulings.stdout).code).toBe("ERR_STORAGE")
    expect(await rev(QUALIFIED)).toBeNull()
  }, 120_000)

  it("refuses the branch HEAD points at, even under curate/", async () => {
    root = await freshRepo()
    await git("checkout", "-q", "-b", "curate/checked-out")
    const result = await collapse("--ref", "curate/checked-out", "--dry-run")
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = parse<Envelope>(result.stdout)
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("checked out")
  }, 120_000)

  it("names a failed cluster's cause in its error, for a typed failure as for any other", async () => {
    // A plain file where the session directory goes makes every cluster's session write fail with
    // a typed StorageFailure, whose `message` is empty: the report must carry its payload instead.
    root = await freshRepo()
    await mkdir(join(root, ".memhtml"), { recursive: true })
    await writeFile(join(root, ".memhtml", "sessions"), "not a directory\n", "utf8")
    const result = await collapse("--ref", REF, "--rulings", join(work, "rulings.jsonl"))
    expect(result.exitCode, result.stdout).toBe(EXIT_OK)
    const data = parse<Envelope>(result.stdout).data as CurateCollapseReport
    const failed = data.clusters.filter((cluster) => cluster.outcome === "failed")
    expect(failed.length, JSON.stringify(data.clusters)).toBeGreaterThan(0)
    for (const cluster of failed) {
      expect(cluster.error, cluster.id).toMatch(/^storage operation failed: \S/)
    }
  }, 120_000)
})

describe("a fold whose member's archive slot an older record holds", () => {
  /*
   * Member `widget-cache-1` was written at a path whose `archive/<YYYY>/` slot already holds an
   * older, unrelated record. The fold archives the member into the year's next generation and the
   * canonical supersedes that slot, under both completions: the driver's (a lowered `largeGroup`)
   * and the model's own archives through the binder. The older record keeps its bytes.
   *
   * Mutations, each run once with the change applied and the named case red:
   * - `foldCluster`'s completion back to skipping a member whose year slot is held -> "the driver
   *   completes it" (the member is left to a second, follow-up commit).
   * - `toOverlayOps` back to `archive/<YYYY>/<path>` -> "the model proposes its archives" (the
   *   validator refuses the proposal and the fold lands nothing).
   */
  const CLAIMS = [
    "The acme widget build fails when its cache directory is read-only.",
    "An acme widget build fails if its cache directory is read-only.",
    "When its cache directory is read-only, the acme widget build fails."
  ]
  const memberPath = (index: number) => `areas/inbox/widget-cache-${String(index)}.html`
  const member = memberPath(1)
  const heldSlot = `archive/${YEAR}/${member}`
  const generationSlot = `archive/${YEAR}.2/${member}`
  const OLDER = renderTemplate({
    title: "Widget cache owner",
    claim: "Grace Example owned the acme widget cache before the build moved.",
    memoryType: "semantic",
    at: AT
  }).replace('content="active"', 'content="archived"')

  const slotRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "memhtml-curate-collapse-slot-"))
    roots.push(dir)
    const g = makeGit(dir)
    await Effect.runPromise(g.run(["init", "-b", "main", "."]).pipe(Effect.orDie))
    await Effect.runPromise(configureIdentity(g))
    const files = [
      ...CLAIMS.map((claim, index) => ({
        path: memberPath(index),
        html: renderTemplate({
          title: `Widget cache read-only ${String(index)}`,
          claim,
          body: [`Exit code 73 on attempt ${String(index)}.`],
          memoryType: "error_pattern",
          at: AT
        })
      })),
      { path: heldSlot, html: OLDER }
    ]
    for (const file of files) {
      await mkdir(dirname(join(dir, file.path)), { recursive: true })
      await writeFile(join(dir, file.path), file.html, "utf8")
    }
    await Effect.runPromise(g.run(["add", "-A"]).pipe(Effect.orDie))
    await Effect.runPromise(g.run(["commit", "-q", "-m", "slot fixture"]).pipe(Effect.orDie))
    return dir
  }

  const landsInTheGeneration = async (largeGroup: number | undefined) => {
    const dir = await slotRepo()
    const inRepo = (...args: ReadonlyArray<string>) =>
      run(["curate", "collapse", "--model", "fake", "--repo", dir, "--ref", REF, ...args])
    const planned = await inRepo("--dry-run")
    expect(planned.exitCode, planned.stdout).toBe(EXIT_OK)
    const plan = (parse<Envelope>(planned.stdout).data as CurateCollapseReport).plan as CollapsePlan
    const fold = plan.clusters.find((cluster) => cluster.kind === "fold")
    if (fold === undefined) throw new Error("the plan holds no fold")
    expect(fold.members.map((one) => one.path).sort()).toEqual([0, 1, 2].map(memberPath))
    const planFile = join(dir, "..", `${String(Date.now())}-slot-plan.json`)
    roots.push(planFile)
    await writeFile(
      planFile,
      JSON.stringify(
        largeGroup === undefined ? plan : { ...plan, options: { ...plan.options, largeGroup } }
      ),
      "utf8"
    )

    const result = await inRepo("--plan", planFile, "--only", fold.id)
    expect(result.exitCode, result.stdout).toBe(EXIT_OK)
    const [outcome] = (parse<Envelope>(result.stdout).data as CurateCollapseReport).clusters
    expect(outcome?.outcome, outcome?.error ?? "").toBe("committed")
    expect(outcome?.skipped).toEqual([])
    expect(outcome?.ops.archive).toBe(3)
    // One session settles the whole fold: no member is left for a follow-up to archive.
    expect(outcome?.commits).toHaveLength(1)

    const showIn = (path: string) =>
      Effect.runPromise(
        makeGit(dir)
          .run(["show", `${QUALIFIED}:${path}`])
          .pipe(Effect.orDie)
      )
    const tree = new Set(
      (
        await Effect.runPromise(
          makeGit(dir).run(["ls-tree", "-r", "--name-only", QUALIFIED]).pipe(Effect.orDie)
        )
      )
        .split("\n")
        .filter((line) => line !== "")
    )
    for (const index of [0, 1, 2]) expect(tree.has(memberPath(index))).toBe(false)
    expect(tree.has(`archive/${YEAR}/${memberPath(0)}`)).toBe(true)
    expect(tree.has(`archive/${YEAR}/${memberPath(2)}`)).toBe(true)
    expect(tree.has(generationSlot)).toBe(true)
    expect(await showIn(generationSlot)).toContain(CLAIMS[1])
    expect(await showIn(heldSlot)).toBe(OLDER)
    const canonical = await showIn(outcome?.canonical ?? "")
    expect(canonical).toContain(`href="/${generationSlot}"`)
    expect(canonical).not.toContain(`href="/${heldSlot}"`)
  }

  it("the driver completes it: the member is archived to the next generation and linked there", async () => {
    await landsInTheGeneration(1)
  }, 180_000)

  it("the model proposes its archives: the binder and the briefing name the next generation", async () => {
    await landsInTheGeneration(undefined)
  }, 180_000)

  it("a fold past one session archives the rest and links every member to its generation slot", async () => {
    // 181 members, one more than a chunk, every one with its bare-year slot held. The first session
    // archives 170 and links as many as the batch cap leaves room for; the follow-up archives the
    // other 11 and links the 141 already archived to the slots they took. Mutation: `followUp` back
    // to `archive/<YYYY>/<path>` -> the validator refuses the follow-up, whose archives name held
    // slots, and the 11 stay live.
    const count = 181
    const path = (index: number) =>
      `areas/inbox/widget-release-${String(index).padStart(3, "0")}.html`
    const dir = await mkdtemp(join(tmpdir(), "memhtml-curate-collapse-large-"))
    roots.push(dir)
    const g = makeGit(dir)
    const gitIn = (...args: ReadonlyArray<string>) =>
      Effect.runPromise(g.run([...args]).pipe(Effect.orDie))
    await gitIn("init", "-b", "main", ".")
    await Effect.runPromise(configureIdentity(g))
    for (let index = 0; index < count; index += 1) {
      const files = [
        {
          at: path(index),
          html: renderTemplate({
            title: `Widget release day ${String(index)}`,
            claim: "The release day of the acme widget is Thursday.",
            body: [`Noted on build ${String(index)}.`],
            memoryType: "semantic",
            at: AT
          })
        },
        {
          at: `archive/${YEAR}/${path(index)}`,
          html: renderTemplate({
            title: `Widget release owner ${String(index)}`,
            claim: `Grace Example owned acme widget release ${String(index)}.`,
            memoryType: "semantic",
            at: AT
          }).replace('content="active"', 'content="archived"')
        }
      ]
      for (const file of files) {
        await mkdir(dirname(join(dir, file.at)), { recursive: true })
        await writeFile(join(dir, file.at), file.html, "utf8")
      }
    }
    await gitIn("add", "-A")
    await gitIn("commit", "-q", "-m", "large slot fixture")
    const blobs = async (ref: string, prefix: string) =>
      (await gitIn("ls-tree", "-r", ref, "--", prefix)).trim().split("\n").sort()
    const older = await blobs("main", `archive/${YEAR}/`)
    expect(older).toHaveLength(count)

    const result = await run(["curate", "collapse", "--model", "fake", "--repo", dir, "--ref", REF])
    expect(result.exitCode, result.stdout).toBe(EXIT_OK)
    const report = parse<Envelope>(result.stdout).data as CurateCollapseReport
    const fold = report.clusters.find((cluster) => cluster.kind === "fold")
    expect(fold?.members).toBe(count)
    expect(fold?.outcome, fold?.error ?? "").toBe("committed")
    expect(fold?.skipped).toEqual([])
    expect(fold?.ops.archive).toBe(count)
    expect(fold?.commits).toHaveLength(2)

    // Every older record keeps its slot byte for byte, and every member sits in the next generation.
    expect(await blobs(QUALIFIED, `archive/${YEAR}/`)).toEqual(older)
    const tree = new Set(
      (await gitIn("ls-tree", "-r", "--name-only", QUALIFIED)).split("\n").filter((l) => l !== "")
    )
    const canonical = await gitIn("show", `${QUALIFIED}:${fold?.canonical ?? ""}`)
    for (let index = 0; index < count; index += 1) {
      expect(tree.has(path(index)), path(index)).toBe(false)
      expect(tree.has(`archive/${YEAR}.2/${path(index)}`), path(index)).toBe(true)
      expect(canonical).toContain(`href="/archive/${YEAR}.2/${path(index)}"`)
    }
    expect(canonical).not.toContain(`href="/archive/${YEAR}/`)
  }, 180_000)
})
