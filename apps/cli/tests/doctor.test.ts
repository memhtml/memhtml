import { execFile } from "node:child_process"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { archivePathFor, archiveYearOf } from "@memhtml/contracts/paths"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { DoctorReport } from "../src/doctor.js"
import { EXIT_RUNTIME } from "../src/envelope.js"
import { type Cli, makeCli } from "./harness.js"

const git = promisify(execFile)

/**
 * `memhtml doctor --fix` under a write that cannot land.
 *
 * The subject is the repair accounting, not the repair editors (those are `src/repair.ts`'s and
 * tested in `repair.test.ts`). A repair is a claim that bytes reached disk, and the failure mode this file pins is
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

/**
 * The untyped-entity count, which is what makes a bare-name PRODUCER visible.
 *
 * `unknown` is a supported storage type, so nothing refuses a bare `memhtml-entity` meta and nothing
 * downstream errors on one. What it costs is reachability: the `entity` scope requires the type half, so
 * a memory stored under `unknown:checkout-api` returns an empty set for `service:checkout-api` — the
 * same answer an absent memory gives. Doctor is the only surface that can say the corpus holds them.
 */
describe("doctor counts untyped entity references", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()

    // A TYPED neighbour first. Its `unknown`-free rows are what prove the count is a predicate on the
    // entity type rather than a count of every entity in the corpus.
    await cli.json([
      "write",
      "--type",
      "semantic",
      "--title",
      "The typed neighbour",
      "--claim",
      "This memory names its entity with a type.",
      "--entity",
      "service:checkout-api"
    ])

    // Two files sharing one bare name, so `files` is a count of claimants and not of distinct names.
    for (const title of ["The first bare namer", "The second bare namer"]) {
      await cli.json([
        "write",
        "--type",
        "semantic",
        "--title",
        title,
        "--claim",
        `${title} writes its entity without a type.`,
        "--entity",
        "payments-api"
      ])
    }

    await cli.json([
      "write",
      "--type",
      "semantic",
      "--title",
      "The third bare namer",
      "--claim",
      "A different bare name entirely.",
      "--entity",
      "ledger-service"
    ])
  })

  it("reports each bare name with how many files claim it, and the typed one not at all", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    // Ordered by claimants descending, so the worst offender leads.
    expect(report.untypedEntities).toEqual([
      { entityName: "payments-api", files: 2 },
      { entityName: "ledger-service", files: 1 }
    ])
    // Distinct NAMES, not files: two claimants of one name count once.
    expect(report.untypedEntityTotal).toBe(2)
  })

  it("leaves healthy alone, because unknown is a supported type rather than a defect", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.untypedEntityTotal).toBeGreaterThan(0)
    // The load-bearing half: a corpus whose only finding is untyped entities is still healthy. Gating
    // on it would turn every hand-authored corpus red for writing metas the way the format allows.
    expect(report.healthy).toBe(true)
  })
})

/**
 * A record archived inside the archive, at `archive/<YYYY>/archive/<YYYY>/<path>`.
 *
 * No door makes one, because the store refuses a source that is already under `archive/`. A tree
 * written before that refusal, or moved by hand, can still hold one, and `originalPathFor` strips a
 * single prefix, so the file reads as the archive of an archive path rather than of a live one.
 * Doctor names each one.
 */
describe("doctor reports a record archived inside the archive", () => {
  let cli: Cli
  let kept: string
  let moved: string

  const archived = async (title: string, claim: string): Promise<string> => {
    const written = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      title,
      "--claim",
      claim,
      "--workspace",
      "acme-widget"
    ])
    const result = await cli.json<{ readonly archivePath: string }>([
      "archive",
      written.path,
      "--reason",
      "evicted"
    ])
    return result.archivePath
  }

  const headSha = async (): Promise<string> =>
    (await git("git", ["-C", cli.root, "rev-parse", "HEAD"])).stdout.trim()

  beforeAll(async () => {
    cli = await makeCli()
    kept = await archived("The widget pool size", "The widget pool holds eight.")
    moved = await archived("The widget queue depth", "The widget queue holds thirty.")
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("reports nothing for records archived once", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.nestedArchivePaths).toEqual([])
    expect(report.healthy).toBe(true)
  })

  it("cannot be handed one by archive or correct, which refuse an archived source", async () => {
    const head = await headSha()
    // The `.` and `..` spellings resolve to the same file on disk, so they are refused too, as paths
    // that are not usable memory paths.
    const spellings: ReadonlyArray<readonly [string, string]> = [
      [kept, `already archived at ${kept}`],
      [`./${kept}`, `path \`./${kept}\` is not a usable memory path`],
      [`areas/../${kept}`, `path \`areas/../${kept}\` is not a usable memory path`]
    ]
    for (const [path, reason] of spellings) {
      for (const argv of [
        ["archive", path, "--reason", "evicted again"],
        [
          "correct",
          path,
          "--title",
          "The widget pool size, corrected",
          "--claim",
          "The widget pool holds sixteen."
        ]
      ]) {
        const result = await cli.run(argv)
        expect(result.exitCode).toBe(EXIT_RUNTIME)
        const body = JSON.parse(result.stdout) as Record<string, unknown>
        expect(body.code).toBe("ERR_INVALID_MEMORY")
        expect(body.error).toContain(reason)
      }
    }
    expect(await headSha()).toBe(head)
    const status = await cli.json<{ readonly dirty: boolean }>(["status"])
    expect(status.dirty).toBe(false)
  })

  it("names a nested path moved in by hand, and counts it against healthy", async () => {
    const nested = archivePathFor(moved, archiveYearOf(moved) ?? new Date().getUTCFullYear())
    await mkdir(dirname(join(cli.root, nested)), { recursive: true })
    await git("git", ["-C", cli.root, "mv", moved, nested])
    await git("git", ["-C", cli.root, "commit", "--quiet", "-m", "archive an archived record"])
    await cli.json(["index", "update"])

    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.nestedArchivePaths).toEqual([nested])
    expect(report.healthy).toBe(false)
    // Every other term of `healthy` is clean, so the nested path is what turned it false.
    expect(report.dangling).toEqual([])
    expect(report.orphanAccessRows).toEqual([])
    expect(report.inboxCrowded).toBe(false)
    expect(report.inboxTasksCrowded).toBe(false)
    expect(report.warnings).toEqual([])
    expect(report.unparseable).toEqual([])
    expect(report.indexFresh).toBe(true)
    expect(report.embedModelMatches).toBe(true)
    expect(report.vectorCoverageLow).toBe(false)
  })

  it("names a nested path under a generation slot as well", async () => {
    // A record moved by hand into `archive/<YYYY>.2/archive/...` is archived a second time too.
    const nested = archivePathFor(kept, archiveYearOf(kept) ?? new Date().getUTCFullYear(), 2)
    await mkdir(dirname(join(cli.root, nested)), { recursive: true })
    await git("git", ["-C", cli.root, "mv", kept, nested])
    await git("git", ["-C", cli.root, "commit", "--quiet", "-m", "nest an archived record"])
    await cli.json(["index", "update"])

    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.nestedArchivePaths).toContain(nested)
    expect(report.healthy).toBe(false)
  })
})
