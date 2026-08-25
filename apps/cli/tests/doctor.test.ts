import { execFile } from "node:child_process"
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { DoctorReport } from "../src/doctor.js"
import { type Cli, makeCli } from "./harness.js"

const git = promisify(execFile)

/**
 * `memhtml doctor --fix` under a write that cannot land.
 *
 * The subject is the repair accounting, not the repair editors (those are `@memhtml/sleep`'s and
 * tested there). A repair is a claim that bytes reached disk, and the failure mode this file pins is
 * the quiet one: a `--fix` whose write failed but which counted the finding as settled anyway. The
 * envelope then said "1 dangling link repaired" over a tree that still held the dangling href, and
 * the commit subject notarized the claim.
 *
 * The injected failure is a real one — the source file made read-only — because a fake filesystem
 * would verify the shape of the call and miss the EACCES path `attemptIo` actually takes.
 */
describe("doctor --fix counts only repairs whose bytes reached disk", () => {
  let cli: Cli
  let source: string
  let target: string

  beforeAll(async () => {
    cli = await makeCli()

    const first = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "The asserting memory",
      "--claim",
      "This memory holds the authored edge.",
      "--workspace",
      "doctor-fixture"
    ])
    source = first.path

    const second = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "The memory that will vanish",
      "--claim",
      "This memory's file is about to leave the tree.",
      "--workspace",
      "doctor-fixture"
    ])
    target = second.path

    await cli.json(["link", source, "caused_by", target])

    // Remove the target OUTSIDE the CLI — a hand-driven `git rm` is exactly the corpus damage
    // doctor exists to find. The archive path is not taken, so the finding has no rewrite target
    // and the repair is a drop.
    await git("git", ["-C", cli.root, "rm", "--quiet", target])
    await git("git", ["-C", cli.root, "commit", "--quiet", "-m", "remove the target by hand"])
    await cli.json(["index", "update"])
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("finds the dangling edge before any repair", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.dangling).toEqual([
      { srcPath: source, rel: "caused_by", dstPath: target, rewriteTo: null }
    ])
  })

  it("reports a failed write under failedWrites, uncounted and uncommitted", async () => {
    /**
     * The regression. The write used to run through `Effect.orElseSucceed` and the counters ran
     * unconditionally after it, so an EACCES here was reported as `dropped: 1` with a commit whose
     * subject claimed a repair the tree does not hold.
     */
    await chmod(join(cli.root, source), 0o444)
    try {
      const report = await cli.json<DoctorReport>(["doctor", "--fix"])
      expect(report.repaired).toBeDefined()
      expect(report.repaired?.failedWrites).toEqual([source])
      expect(report.repaired?.rewritten).toBe(0)
      expect(report.repaired?.dropped).toBe(0)
      expect(report.repaired?.commitSha).toBeNull()
      // The finding is still open, so the report must keep saying so.
      expect(report.dangling.map((finding) => finding.srcPath)).toContain(source)
    } finally {
      await chmod(join(cli.root, source), 0o644)
    }
  })

  it("retries cleanly on the next run: the drop lands, is counted, and is committed", async () => {
    const report = await cli.json<DoctorReport>(["doctor", "--fix"])
    expect(report.repaired?.failedWrites).toEqual([])
    expect(report.repaired?.dropped).toBe(1)
    expect(report.repaired?.rewritten).toBe(0)
    expect(report.repaired?.commitSha).not.toBeNull()

    // And the repair is real: a fresh pass over the reindexed tree finds nothing dangling.
    await cli.json(["index", "update"])
    const clean = await cli.json<DoctorReport>(["doctor"])
    expect(clean.dangling).toEqual([])
  })
})
