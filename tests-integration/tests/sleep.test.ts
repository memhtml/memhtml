import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { originalPathFor } from "@memhtml/contracts/paths"
import { SLEEP_PHASES } from "@memhtml/sleep"
import { scriptedModel, value } from "@memhtml/sleep/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"

/**
 * The plan's verification item 6, first half: a sleep run on a real corpus, reviewed, and MERGED
 * THROUGH THE GATE.
 *
 * `@memhtml/sleep`'s own suite proves each phase; this proves the CLI's COMPOSITION of them — that
 * `memhtml sleep merge` supplies `preMergeGate` (finding #35), that the review surface reports what the run
 * did, and that an eviction reaches the tree as a rename `git log --follow` reads through.
 *
 * **Renames are asserted as renames, never as `R100`** (finding #23): an archive commit stamps
 * `memhtml-status`/`memhtml-archived` in the SAME commit and rename similarity is computed tree-to-tree, so a
 * head stamp lowers the score — measured R059-R087 on real memory files. `originalPathFor` is the
 * authoritative inverse and no correctness path reads the score.
 */

const DATE = "2026-08-02"

/** A model that answers every LLM phase with "nothing to do", so no LLM phase commits. */
const inertModel = () =>
  scriptedModel((request) =>
    request.system.startsWith("You triage")
      ? value({ entries: [] })
      : request.system.startsWith("You partition")
        ? // dedup-merge's partition call. A refusal keeps the phase on its deterministic arm.
          value({ groups: [] })
        : value({ verdict: "neutral", confidence: 0.9, rationale: "compatible claims" })
  )

/**
 * Commit a memory file with EXPLICIT stamps, then index it.
 *
 * `memhtml write` stamps `memhtml-created`/`memhtml-updated` from the clock, so a memory written through the CLI is
 * always zero days old at the run date — and the retention scorer's recency signal is then 1.0, which
 * puts every fresh memory in the KEEP or COMPRESS band. Measured: both CLI-written memories scored
 * COMPRESS and `evicted` was 0, so an eviction assertion over them would have been unreachable.
 *
 * An AGED memory is what an eviction needs, and a stamped file committed into the tree is exactly how
 * one exists — a memory written months ago, or a hand-authored one. The indexer reads the tree, so this
 * is a supported input rather than a back door: `memhtml index update` projects it like any other file.
 */
const commitAgedMemory = async (
  cli: Cli,
  input: {
    readonly path: string
    readonly title: string
    readonly claim: string
    readonly memoryType: string
    readonly at: string
    readonly confidence?: string | undefined
    readonly importance?: string | undefined
  }
): Promise<string> => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${input.title}</title>
<meta name="memhtml-type" content="${input.memoryType}">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="${input.at}">
<meta name="memhtml-updated" content="${input.at}">
<meta name="memhtml-confidence" content="${input.confidence ?? "0.20"}">
<meta name="memhtml-importance" content="${input.importance ?? "1"}">
</head>
<body>
<article>
<p><mark>${input.claim}</mark></p>
</article>
</body>
</html>
`
  await mkdir(dirname(join(cli.root, input.path)), { recursive: true })
  await writeFile(join(cli.root, input.path), html, "utf8")
  await cli.git("add", input.path)
  await cli.git("commit", "-m", `memhtml(write): ${input.title}`)
  await cli.json(["index", "update"])
  return input.path
}

interface SleepReport {
  readonly runId: string
  readonly branch: string
  readonly baseSha: string
  readonly headSha: string
  readonly dryRun: boolean
  readonly phases: ReadonlyArray<{
    readonly phase: string
    readonly status: string
    readonly counts: Readonly<Record<string, number>>
    readonly commitSha: string | null
  }>
  readonly failedPhases: ReadonlyArray<string>
  readonly commits: ReadonlyArray<string>
}

describe("verification item 6 — sleep run, review, and merge through the discrimination gate", () => {
  let cli: Cli
  let report: SleepReport

  beforeAll(async () => {
    cli = await makeCli({ model: inertModel() })

    // A memory that should SURVIVE, so the run is not simply archiving everything.
    await writeMemory(cli, {
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "Drain the VIP before reverting the deploy.",
      body: ["The revert alone leaves in-flight connections pinned to the old target group."],
      workspace: "checkout-api",
      tags: ["deploy"],
      entities: ["service:checkout-api"]
    })

    /**
     * A memory built to land in the EVICT band: episodic (so recency carries the most weight), seven
     * months stale at the run date, never accessed, unreferenced, low confidence, and short enough that
     * the content-density signal is penalized.
     */
    await commitAgedMemory(cli, {
      path: "areas/stale/a-forgotten-detail.html",
      title: "A forgotten detail about the staging bastion",
      claim: "The staging bastion listened on port 2222.",
      memoryType: "episodic",
      at: "2026-01-05T00:00:00Z"
    })

    report = await cli.json<SleepReport>(["sleep", "run", "--date", DATE])
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("runs every phase on a branch, with one trailer per commit", async () => {
    expect(report.runId).toBe(`sleep/${DATE}`)
    /**
     * Against `SLEEP_PHASES` rather than a literal. A hand-typed count made adding a phase a
     * two-place edit whose second place is an integration file nobody runs while iterating, so the
     * gate reported a wrong phase count as a broken run.
     */
    expect(report.phases).toHaveLength(SLEEP_PHASES.length)
    expect(report.failedPhases).toEqual([])

    // The branch exists in GIT and the run's commits are on it — `main` never moved.
    const branches = await cli.git("branch", "--list", `sleep/${DATE}`)
    expect(branches).toContain(`sleep/${DATE}`)

    /**
     * Exactly one `Memhtml-Phase` trailer per committed phase. The trailers are what `memhtml sleep resume`
     * reads, so a phase that committed without one would be permanently re-executed — re-archiving
     * files a previous attempt already moved.
     */
    const trailers = await cli.git(
      "log",
      "--format=%(trailers:key=Memhtml-Phase,valueonly)",
      `${report.baseSha}..sleep/${DATE}`
    )
    const stamped = trailers
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    expect(stamped).toHaveLength(report.commits.length)
  })

  it("evicts into archive/ as a RENAME, never a delete plus an add", async () => {
    const triage = report.phases.find((phase) => phase.phase === "retention-triage")
    expect(triage?.status).toBe("ok")
    expect(triage?.counts.evicted ?? 0).toBeGreaterThan(0)

    /**
     * `-M` on, and the assertion is the KIND plus git's own default similarity floor of 50% — never
     * `R100`, which is arithmetically impossible for an archive that also stamps its head in the same
     * commit. `originalPathFor` is what actually inverts the move.
     */
    const raw = await cli.git("diff", "--name-status", "-M", `${report.baseSha}..sleep/${DATE}`)
    const renames = raw
      .split("\n")
      .map((line) => line.split("\t"))
      .flatMap(([status, from, to]) =>
        status?.startsWith("R") && from !== undefined && to !== undefined
          ? [{ score: Number(status.slice(1)), from, to }]
          : []
      )
      .filter((rename) => rename.to.startsWith("archive/"))

    expect(renames.length).toBeGreaterThan(0)
    for (const rename of renames) {
      expect(rename.score).toBeGreaterThanOrEqual(50)
      expect(originalPathFor(rename.to)).toBe(rename.from)

      /**
       * `--follow` reads THROUGH the move: the archive path's history reaches back past the eviction to
       * the commit that created the file at its live path. That is the property the path-mirroring
       * archive layout buys, and it is what makes an eviction recoverable.
       */
      const follow = await cli.git(
        "log",
        "--follow",
        "--format=%H",
        `sleep/${DATE}`,
        "--",
        rename.to
      )
      expect(
        follow
          .trim()
          .split("\n")
          .filter((line) => line !== "").length
      ).toBeGreaterThan(1)
    }

    // At least one score strictly BELOW 100 — the fact that makes gating on `R100` wrong rather than
    // merely brittle. If this ever fails because every archive scored 100, design §2.1 changed.
    expect(renames.some((rename) => rename.score < 100)).toBe(true)
  })

  it("reviews the run: per-phase counts, the commit list, and a per-file classification", async () => {
    const review = await cli.json<{
      readonly runId: string
      readonly phases: ReadonlyArray<{ readonly phase: string }>
      readonly commits: ReadonlyArray<{ readonly sha: string; readonly phase: string | null }>
      readonly diffStat: string
      readonly files: ReadonlyArray<{ readonly path: string; readonly classification: string }>
    }>(["sleep", "review", `sleep/${DATE}`])

    expect(review.runId).toBe(`sleep/${DATE}`)
    expect(review.commits.length).toBeGreaterThan(0)
    expect(review.diffStat.length).toBeGreaterThan(0)
    expect(review.files.length).toBeGreaterThan(0)

    /**
     * The classification is the substance. `git diff --stat` says a file changed by two lines and says
     * nothing about whether those lines were a confidence stamp or the memory's claim — and the reason
     * head edits go through byte-splicing editors is so that distinction is REAL: a meta-only change
     * provably leaves the article's bytes, and therefore its content hash, identical.
     */
    expect(review.files.some((file) => file.classification === "archived")).toBe(true)
    for (const file of review.files) {
      expect(["meta-only", "body-changed", "archived", "created", "deleted"]).toContain(
        file.classification
      )
    }
  })

  it("commits a report the run's own branch carries", async () => {
    const reportPhase = report.phases.find((phase) => phase.phase === "report")
    expect(reportPhase?.status).toBe("ok")
    const listed = await cli.git("ls-tree", "--name-only", `sleep/${DATE}`, ".memhtml/sleep/")
    expect(listed).toContain(`sleep-${DATE}.html`)
  })

  it("MERGES through the discrimination gate, fast-forwarding main", async () => {
    /**
     * **Finding #35's deliverable, asserted end to end.** `memhtml sleep merge` supplies
     * `preMergeGate: discriminationGate()` — so this merge only lands because the gate PASSED. A merge
     * that succeeded with the gate unsupplied would look identical from the outside, which is why the
     * refusal case below is asserted too.
     */
    const merged = await cli.json<{
      readonly merged: boolean
      readonly headSha: string
      readonly refusal?: string | undefined
    }>(["sleep", "merge", `sleep/${DATE}`])

    expect(merged.refusal).toBeUndefined()
    expect(merged.merged).toBe(true)

    // Fast-forward only, never a merge commit: `main` IS the branch tip now, and HEAD is on main.
    expect((await cli.git("rev-parse", "HEAD")).trim()).toBe(merged.headSha)
    expect((await cli.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main")
    expect((await cli.git("rev-parse", `sleep/${DATE}`)).trim()).toBe(merged.headSha)
  })

  it("refuses to merge a run whose base main has advanced past", async () => {
    /**
     * The other refusal, and it is not about the gate: `main` having advanced means the run curated a
     * corpus that no longer exists — a decay computed against a confidence an agent has since
     * corrected, an eviction of a memory that was just reinforced. Asserted against GIT rather than
     * against the report, because a refusal that returned the right word while moving `main` would be
     * the exact bug.
     */
    await writeMemory(cli, {
      title: "A memory written after the sleep run branched",
      claim: "This landed on main after the run took its base."
    })
    const head = (await cli.git("rev-parse", "HEAD")).trim()

    const refused = await cli.json<{
      readonly merged: boolean
      readonly refusal?: string | undefined
    }>(["sleep", "merge", `sleep/${DATE}`])

    expect(refused.merged).toBe(false)
    expect(refused.refusal).toBe("main-advanced")
    expect((await cli.git("rev-parse", "HEAD")).trim()).toBe(head)
  })

  it("reports `no-run` for a run id that does not exist", async () => {
    const missing = await cli.json<{ readonly merged: boolean; readonly refusal?: string }>([
      "sleep",
      "merge",
      "sleep/1999-01-01"
    ])
    expect(missing.merged).toBe(false)
    expect(missing.refusal).toBe("no-run")
  })

  it("rebuilds the index after the merge, reproducing the post-sleep corpus", async () => {
    // The last link of item 6: a sleep run rewrote heads and moved files, and the index must still be a
    // faithful projection of the resulting tree.
    await cli.json(["index", "rebuild", "--embed"])
    const status = await cli.json<{ readonly indexFresh: boolean; readonly dirty: boolean }>([
      "status"
    ])
    expect(status.indexFresh).toBe(true)
    expect(status.dirty).toBe(false)

    const doctor = await cli.json<{
      readonly dangling: ReadonlyArray<unknown>
      readonly orphanAccessRows: ReadonlyArray<string>
    }>(["doctor"])
    expect(doctor.dangling).toEqual([])
    expect(doctor.orphanAccessRows).toEqual([])
  })
})
