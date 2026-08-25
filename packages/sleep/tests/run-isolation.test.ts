import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { RunReport } from "../src/contract.js"
import { SLEEP_PHASES, TRAILER_PHASE } from "../src/contract.js"
import type { SleepDeps } from "../src/env.js"
import { completedPhases, resume, run, runIdFor } from "../src/run.js"
import { latestRun, readPhases, readRun } from "../src/sql.js"
import { DEDUP_CORPUS, type Fixture, LAST_DROP_PATH, withFixture } from "./fixture.js"

/**
 * Containment: where a run's commits land, and what a failed phase leaves behind.
 *
 * Four properties the design's safety story rests on, each of which fails SILENTLY — the report
 * reads as a clean run in every case, so every assertion here is against GIT and the tables
 * rather than against the report alone:
 *
 * 1. A run whose branch checkout fails commits nothing onto the branch that IS checked out, which
 *    after a merge is `main`. `git branch -D` is the whole abort, and it only reaches commits that
 *    are on the run's own branch.
 * 2. A phase that fails after partial writes leaves nothing on disk for a LATER phase to stage,
 *    because the file operations read the working tree rather than the index.
 * 3. A run whose PREFLIGHT fails commits nothing at all: the three preconditions it establishes —
 *    a clean tree, one vector space, an index that can be diffed — are what make a later phase's
 *    commit correct rather than merely present.
 * 4. A resume of a run nothing recorded refuses rather than treating the missing watermark as an
 *    empty one — an empty watermark reads all of `HEAD`, where a merged run's trailers name every
 *    phase.
 */

const DATE = "2026-08-02"

/** Commits reachable from HEAD. What proves a run committed, or did not. */
const commitCount = (fixture: Fixture): Effect.Effect<number> =>
  fixture.raw("rev-list", "--count", "HEAD").pipe(Effect.map((text) => Number(text.trim())))

/** The branch HEAD names, read straight from git. */
const headBranch = (fixture: Fixture): Effect.Effect<string> =>
  fixture.raw("rev-parse", "--abbrev-ref", "HEAD").pipe(Effect.map((text) => text.trim()))

/**
 * One path's bytes as HEAD holds them, or `null` when HEAD does not hold the path.
 *
 * `catchCause`, because `fixture.raw` dies on a non-zero git exit: `git show HEAD:<absent>` exits 128
 * and arrives here as a DEFECT, which `orElseSucceed` does not answer — it would take the test down
 * instead of reporting the absence this helper exists to report.
 */
const blobAt = (fixture: Fixture, path: string): Effect.Effect<string | null> =>
  fixture.raw("show", `HEAD:${path}`).pipe(Effect.catchCause(() => Effect.succeed(null)))

describe("a run commits only to its own branch", () => {
  it("aborts when the branch cannot be created, leaving the current branch and the tables untouched", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * A ref named `sleep` makes `refs/heads/sleep/<date>` unbuildable, because git stores a ref
           * as a file and cannot create one under a path that is already one. Probed live 2026-08-25:
           * `git checkout -b sleep/2026-08-02` exits 128 with `cannot lock ref
           * 'refs/heads/sleep/2026-08-02': 'refs/heads/sleep' exists`, and `show-ref --verify --quiet`
           * on the same name exits 1 — so `branchExists` answers false and the run picks exactly the
           * name git will refuse. A real failure of the real port, with nothing faked.
           */
          yield* fixture.raw("branch", "sleep")
          expect(yield* fixture.deps.git.branchExists(`sleep/${DATE}`).pipe(Effect.orDie)).toBe(
            false
          )

          const before = yield* commitCount(fixture)
          const report = yield* run(fixture.deps, { date: DATE })

          // Every phase is reported failed, naming one cause. `failed` is what a caller branches on.
          expect(report.phases).toHaveLength(SLEEP_PHASES.length)
          expect(report.phases.every((phase) => phase.status === "failed")).toBe(true)
          expect(report.phases.every((phase) => phase.commitSha === null)).toBe(true)
          expect(report.phases[0]?.detail).toContain("SleepRunAborted")
          expect(report.phases[0]?.detail).toContain("cannot check out")

          // THE PROPERTY: the checked-out branch did not move, and HEAD is still on it.
          expect(yield* commitCount(fixture)).toBe(before)
          expect(yield* headBranch(fixture)).toBe("main")
          expect(report.headSha).toBe(report.baseSha)

          // Nor did the working tree: no phase ran, so nothing was written and nothing unstaged.
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])

          /**
           * And nothing was recorded. A `sleep_runs` row for a run that never started would be read
           * by `review`, by `merge`, and by the next `resume` as a run with a branch and a watermark.
           */
          expect(yield* latestRun(fixture.db).pipe(Effect.orDie)).toBeUndefined()
          expect(yield* readPhases(fixture.db, report.runId).pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("aborts when the checkout reports success without moving HEAD", async () => {
    /**
     * The read-back's own test, and the only case here that needs a seam: git's exit status and where
     * `HEAD` actually points are two different facts, and no real-git provocation makes the first
     * succeed while the second is wrong. ONE method is replaced — a `checkoutBranch` that reports
     * success and does nothing — so the assertion is about the runner's precondition and not about
     * git's behavior.
     *
     * Without the read-back this run executes all seventeen phases on `main`.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const deps: SleepDeps = {
            ...fixture.deps,
            git: { ...fixture.deps.git, checkoutBranch: () => Effect.void }
          }

          const before = yield* commitCount(fixture)
          const report = yield* run(deps, { date: DATE })

          expect(report.phases.every((phase) => phase.status === "failed")).toBe(true)
          expect(report.phases[0]?.detail).toContain("HEAD is on main")

          expect(yield* commitCount(fixture)).toBe(before)
          expect(yield* headBranch(fixture)).toBe("main")
          expect(yield* latestRun(fixture.db).pipe(Effect.orDie)).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("refuses a run id whose every same-day name is a branch already", () => {
    /**
     * The exhausted-name case, as a unit because provoking it against a real repo means a hundred
     * branches. `undefined` is what the runner turns into an abort, and the alternative it rules out
     * is answering `sleep/<date>-100` when that name is taken: the phases would commit onto the
     * branch of the run holding it, and `recordRun`'s upsert would overwrite that run's row.
     */
    const taken = [
      `sleep/${DATE}`,
      ...Array.from({ length: 99 }, (_, at) => `sleep/${DATE}-${at + 2}`)
    ]
    expect(taken).toHaveLength(100)
    expect(runIdFor(DATE, taken)).toBeUndefined()
    // One free name is still found, at the end of the range as well as the start.
    expect(runIdFor(DATE, taken.slice(0, 99))).toBe(`sleep/${DATE}-100`)
  })
})

describe("a failed phase leaves nothing for a later phase to commit", () => {
  it("restores the working tree it half-wrote, so no later commit carries its bytes", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * The same provocation `run.test.ts` uses for the hard-prerequisite case, for the same
           * measured reason: a read-only archive DESTINATION DIRECTORY makes `git mv` exit 128
           * (`fatal: renaming … failed: Permission denied`), which `archiveFile`'s free-path probe
           * cannot route around. dedup-merge processes its pairs in descending similarity, so the
           * metrics pair archives cleanly FIRST and the oncall pair's move then fails — leaving the
           * phase's partial work on disk, which is this test's whole subject.
           *
           * What that partial work is, measured: `areas/metrics/scrape-cadence.html` carries a
           * `memhtml-supersedes` link the phase stamped, and
           * `areas/metrics/exporter-scrape-interval.html` is physically gone from its live path with
           * an untracked copy under `archive/2026/`. `git reset HEAD` alone moves the index and none
           * of that, and confidence-decay runs four phases later, reads the keeper off DISK, and
           * stages the whole file — so the abandoned supersedes rides into the decay commit.
           */
          yield* Effect.promise(async () => {
            const { chmod, mkdir } = await import("node:fs/promises")
            const { dirname, join } = await import("node:path")
            const parent = join(fixture.root, dirname(`archive/2026/${LAST_DROP_PATH}`))
            await mkdir(parent, { recursive: true })
            await chmod(parent, 0o500)
          })
          yield* fixture.reindex()

          const keeperPath = "areas/metrics/scrape-cadence.html"
          const dropPath = "areas/metrics/exporter-scrape-interval.html"
          const report = yield* run(fixture.deps, { date: DATE })
          const phaseOf = (name: string) =>
            report.phases.find((candidate) => candidate.phase === name)

          // The provocation still provokes: the phase failed, and its report line is unchanged.
          expect(phaseOf("dedup-merge")?.status).toBe("failed")
          expect(phaseOf("dedup-merge")?.detail).toContain("GitFailure")
          expect(phaseOf("dedup-merge")?.commitSha).toBeNull()

          /**
           * A LATER phase did commit this very file — otherwise the assertion below would hold
           * because nothing staged the path at all, which is the vacuous version of this test.
           */
          const changes = yield* fixture.deps.git
            .diffNameStatus(report.baseSha, "HEAD")
            .pipe(Effect.orDie)
          const keeperChange = changes.find((change) => change.path === keeperPath)
          expect(keeperChange?.kind).toBe("modified")

          /**
           * THE PROPERTY: that later commit carries the later phase's work and NOT the failed
           * phase's. The supersedes link is the failed phase's own byte-level signature.
           */
          const keeper = yield* blobAt(fixture, keeperPath)
          expect(keeper).not.toBeNull()
          expect(keeper).not.toContain("memhtml-supersedes")
          expect(keeper).not.toContain("archive/2026")

          // The half-archived file is back at its live path, in the tree AND on disk.
          expect(yield* blobAt(fixture, dropPath)).not.toBeNull()
          const onDisk = yield* Effect.promise(async () => {
            const { readFile } = await import("node:fs/promises")
            const { join } = await import("node:path")
            return readFile(join(fixture.root, dropPath), "utf8").catch(() => null)
          })
          expect(onDisk).not.toBeNull()

          // And its abandoned archive copy is gone rather than sitting untracked in the tree.
          const archived = yield* Effect.promise(async () => {
            const { readFile } = await import("node:fs/promises")
            const { join } = await import("node:path")
            return readFile(join(fixture.root, `archive/2026/${dropPath}`), "utf8").catch(
              () => null
            )
          })
          expect(archived).toBeNull()

          // No commit on the branch touched the metrics archive at all.
          expect(
            changes.filter(
              (change) =>
                change.path.startsWith("archive/2026/areas/metrics/") ||
                change.fromPath?.startsWith("areas/metrics/") === true
            )
          ).toEqual([])
        }).pipe(
          /**
           * The mode is restored whatever the body did, so the fixture's temp-dir cleanup can remove
           * the tree. A failed assertion would otherwise leave an unremovable directory behind and
           * every later test in the file would fail on the tmpdir rather than on itself.
           */
          Effect.ensuring(
            Effect.promise(async () => {
              const { chmod } = await import("node:fs/promises")
              const { dirname, join } = await import("node:path")
              await chmod(
                join(fixture.root, dirname(`archive/2026/${LAST_DROP_PATH}`)),
                0o700
              ).catch(() => {})
            })
          )
        ),
      { seed: DEDUP_CORPUS }
    )
  })
})

/**
 * The bytes an operator has not committed yet, and the file they sit in.
 *
 * A TRACKED file, modified and left unstaged, because that is the shape that turns a soft preflight
 * into committed dirt: `confidence-decay` reads a memory off DISK and stages the whole result, so an
 * uncommitted edit rides into the decay commit under the run's own trailers. An untracked file would
 * prove nothing here — no phase stages a path it does not know about.
 */
const OPERATOR_DIRT = "OPERATOR-WORK-IN-PROGRESS"
const DIRTIED_PATH = "areas/deploy/blue-green-is-safe.html"

/** Put {@link OPERATOR_DIRT} in the file's prose, leaving it modified and unstaged. */
const dirtyTheTree = (fixture: Fixture): Effect.Effect<void> =>
  Effect.promise(async () => {
    const { readFile, writeFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const full = join(fixture.root, DIRTIED_PATH)
    const html = await readFile(full, "utf8")
    await writeFile(full, html.replace("</p>", ` ${OPERATOR_DIRT}</p>`), "utf8")
  })

/** Every commit ANYWHERE in the repo whose diff adds or removes a string. */
const commitsCarrying = (fixture: Fixture, text: string): Effect.Effect<ReadonlyArray<string>> =>
  fixture.raw("log", "--all", "--format=%H", `-S${text}`).pipe(
    Effect.map((out) =>
      out
        .trim()
        .split("\n")
        .filter((line) => line !== "")
    )
  )

/** Assert a report is one failed preflight followed by sixteen phases nothing ran. */
const expectPreflightBlockedTheRest = (
  report: RunReport,
  detail: (text: string | undefined) => void
): void => {
  /**
   * SEVENTEEN entries still. A blocked phase APPEARS in the report — a run that reported one line
   * would read as a partial run, and `sleepRunReport`'s consumers count phases.
   */
  expect(report.phases).toHaveLength(SLEEP_PHASES.length)
  expect(report.phases.map((phase) => phase.phase)).toEqual([...SLEEP_PHASES])

  const preflight = report.phases[0]
  expect(preflight?.phase).toBe("preflight")
  expect(preflight?.status).toBe("failed")
  detail(preflight?.detail)

  for (const phase of report.phases.slice(1)) {
    // `skipped` is the status the hard-prerequisite mechanism already gives a blocked phase.
    expect(phase.status, phase.phase).toBe("skipped")
    expect(phase.detail, phase.phase).toBe("hard prerequisite preflight failed")
    expect(phase.commitSha, phase.phase).toBeNull()
    expect(phase.counts, phase.phase).toEqual({})
  }
}

describe("a failed preflight stops every phase after it", () => {
  it("commits nothing over an operator's uncommitted work", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * A NEIGHBOUR run first, merged into `main`, and it is doing three jobs at once.
           *
           * It is the contaminating state: its commits and `Memhtml-Phase` trailers are in `main`'s
           * history and its rows are in `sleep_runs`/`sleep_phases`, so neither the commit count nor
           * the row assertions below can be satisfied by an empty repo or an empty table.
           *
           * It is also the VACUITY CONTROL. "No later phase committed" is worthless if the fixture
           * gave the later phases nothing to commit, so the same corpus is run once with preflight
           * SUCCEEDING and the commits are counted. `confidence-decay` in particular is asserted to
           * commit, because it is the phase that reads a memory off disk and would carry the
           * operator's uncommitted bytes.
           */
          const neighbour = yield* run(fixture.deps, { date: DATE })
          expect(neighbour.phases.filter((phase) => phase.status === "failed")).toEqual([])
          const neighbourCommits = neighbour.phases.filter((phase) => phase.commitSha !== null)
          expect(neighbourCommits.length).toBeGreaterThan(4)
          expect(
            neighbour.phases.find((phase) => phase.phase === "confidence-decay")?.commitSha
          ).not.toBeNull()
          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          yield* fixture.deps.git.mergeFastForward(neighbour.runId).pipe(Effect.orDie)

          yield* dirtyTheTree(fixture)
          // The provocation provokes: the tree really is dirty, at exactly one path.
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([DIRTIED_PATH])
          expect(yield* commitsCarrying(fixture, OPERATOR_DIRT)).toEqual([])

          const before = yield* commitCount(fixture)
          const report = yield* run(fixture.deps, { date: DATE })
          expect(report.runId).toBe(`sleep/${DATE}-2`)

          /**
           * THE PROPERTY, in GIT, and asserted FIRST because it is the one that matters: a report can
           * say whatever it likes, and what makes this bug expensive is bytes landing in commits. The
           * branch was created and HEAD is on it — the run started — and the branch carries no commit
           * at all, so `main` and the run branch are the same commit.
           */
          expect(yield* headBranch(fixture)).toBe(report.runId)
          expect(yield* commitCount(fixture)).toBe(before)
          expect(report.headSha).toBe(report.baseSha)
          expect(
            yield* fixture.deps.git.diffNameStatus(report.baseSha, "HEAD").pipe(Effect.orDie)
          ).toEqual([])

          // And no commit in the repository carries the operator's bytes, under any trailer.
          expect(yield* commitsCarrying(fixture, OPERATOR_DIRT)).toEqual([])

          expectPreflightBlockedTheRest(report, (text) => expect(text).toBe("DirtyTree"))
          expect(report.llmCalls).toBe(0)

          /**
           * The operator's work is also still THERE. The run neither commits it nor cleans it up:
           * `discardPhaseWrites` restores only paths the failed phase itself made dirty, and this one
           * was dirty before preflight ran.
           */
          const onDisk = yield* Effect.promise(async () => {
            const { readFile } = await import("node:fs/promises")
            const { join } = await import("node:path")
            return readFile(join(fixture.root, DIRTIED_PATH), "utf8")
          })
          expect(onDisk).toContain(OPERATOR_DIRT)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([DIRTIED_PATH])

          // The report file the last phase writes is absent too, which is what "commits nothing" means.
          expect(
            yield* blobAt(fixture, `.memhtml/sleep/${report.runId.replaceAll("/", "-")}.html`)
          ).toBeNull()

          /**
           * The rows agree with the report: seventeen of them, one failed and sixteen skipped, and the
           * run itself recorded `failed`.
           */
          const rows = yield* readPhases(fixture.db, report.runId).pipe(Effect.orDie)
          expect(rows).toHaveLength(SLEEP_PHASES.length)
          expect(rows[0]?.phase).toBe("preflight")
          expect(rows[0]?.status).toBe("failed")
          expect(rows.slice(1).map((row) => row.status)).toEqual(
            SLEEP_PHASES.slice(1).map(() => "skipped")
          )
          expect(rows.every((row) => row.commit_sha === null)).toBe(true)
          expect((yield* readRun(fixture.db, report.runId).pipe(Effect.orDie))?.status).toBe(
            "failed"
          )

          /**
           * The NEIGHBOUR's rows are untouched, which is what proves the assertions above read this
           * run's rows and not a table-wide count.
           */
          const neighbourRows = yield* readPhases(fixture.db, neighbour.runId).pipe(Effect.orDie)
          expect(neighbourRows).toHaveLength(SLEEP_PHASES.length)
          expect(
            neighbourRows.filter((row) => row.error === "hard prerequisite preflight failed")
          ).toEqual([])
          expect(neighbourRows.filter((row) => row.commit_sha !== null).length).toBe(
            neighbourCommits.length
          )
          expect((yield* readRun(fixture.db, neighbour.runId).pipe(Effect.orDie))?.status).toBe(
            "review"
          )
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("commits nothing when the index is a state update cannot diff from", async () => {
    /**
     * `IndexStale` rather than `DirtyTree`, because the two fail differently and the runner has to
     * treat both as blocking: a dirty tree is the store REFUSING before it does anything, and this one
     * is an error travelling out of the indexer port mid-phase.
     *
     * An EXISTING `index_state` row whose `head_sha` is NULL is what a rebuild leaves when it dies
     * between its truncate and its watermark write (`packages/index/src/indexer.ts`), and an absent row
     * is a different state that `update` answers with a full rebuild. `packages/index`'s own tests
     * prove a rebuild produces this row by interrupting one; here the row is written directly, because
     * the subject is what the RUNNER does with the refusal.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const neighbour = yield* run(fixture.deps, { date: DATE })
          expect(neighbour.phases.filter((phase) => phase.status === "failed")).toEqual([])
          const neighbourCommits = neighbour.phases.filter((phase) => phase.commitSha !== null)
          expect(neighbourCommits.length).toBeGreaterThan(4)
          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          yield* fixture.deps.git.mergeFastForward(neighbour.runId).pipe(Effect.orDie)

          yield* fixture.db
            .run("UPDATE index_state SET head_sha = NULL WHERE id = 1")
            .pipe(Effect.orDie)
          const state = yield* fixture.db
            .get<{ head_sha: string | null }>("SELECT head_sha FROM index_state WHERE id = 1")
            .pipe(Effect.orDie)
          expect(state).toBeDefined()
          expect(state?.head_sha).toBeNull()
          // The tree is CLEAN, so the only precondition failing is the index.
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])

          const before = yield* commitCount(fixture)
          const report = yield* run(fixture.deps, { date: DATE })

          expectPreflightBlockedTheRest(report, (text) => {
            expect(text).toContain("IndexStale")
            expect(text).toContain("did not finish repopulating")
          })
          expect(yield* headBranch(fixture)).toBe(report.runId)
          expect(yield* commitCount(fixture)).toBe(before)
          expect(
            yield* fixture.deps.git.diffNameStatus(report.baseSha, "HEAD").pipe(Effect.orDie)
          ).toEqual([])
          expect((yield* readRun(fixture.db, report.runId).pipe(Effect.orDie))?.status).toBe(
            "failed"
          )
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("blocks the same sixteen phases on a dry run, whose counts would otherwise read as a preview", async () => {
    /**
     * A dry run updates the index deliberately, and its whole product is COUNTS. So a dry run whose
     * preflight failed has to report the same sixteen skips a real run does: numbers computed over a
     * corpus fragment or a half-migrated vector space are a preview of a night nothing would reproduce,
     * and a wrong count reads as a finding.
     *
     * The clean dry run FIRST, over the same fixture, is the vacuity control — it proves these phases
     * have counts to compute when preflight succeeds.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* commitCount(fixture)
          const clean = yield* run(fixture.deps, { date: DATE, dryRun: true })
          expect(clean.phases).toHaveLength(SLEEP_PHASES.length)
          expect(clean.phases.filter((phase) => phase.status === "skipped")).toEqual([])
          expect(clean.phases.filter((phase) => phase.status === "failed")).toEqual([])
          expect(
            clean.phases.find((phase) => phase.phase === "dedup-merge")?.counts.merged
          ).toBeGreaterThan(0)
          expect(
            clean.phases.filter((phase) => Object.keys(phase.counts).length > 0).length
          ).toBeGreaterThan(4)

          yield* dirtyTheTree(fixture)
          const dirty = yield* run(fixture.deps, { date: "2026-08-03", dryRun: true })

          expectPreflightBlockedTheRest(dirty, (text) => expect(text).toBe("DirtyTree"))

          // A dry run still creates no branch, commits nothing, and records no phase row.
          expect(yield* headBranch(fixture)).toBe("main")
          expect(yield* commitCount(fixture)).toBe(before)
          expect(yield* readPhases(fixture.db, dirty.runId).pipe(Effect.orDie)).toEqual([])
          expect((yield* readRun(fixture.db, dirty.runId).pipe(Effect.orDie))?.status).toBe(
            "abandoned"
          )
          expect(yield* commitsCarrying(fixture, OPERATOR_DIRT)).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

describe("resume against a run nothing recorded", () => {
  it("errors instead of reading a merged run's trailers as its own completed phases", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * THE CONTAMINATING STATE, and the reason a clean-database version of this test passes
           * against the bug: a NEIGHBOUR run that finished and was MERGED, so its `Memhtml-Phase`
           * trailers are in `main`'s own history. With no run row the watermark was `""`, which makes
           * the trailer scan read `HEAD` rather than `<base>..HEAD` — so the merged run's trailers
           * marked every phase complete, the resume executed nothing, and it reported `review`.
           */
          const neighbour = yield* run(fixture.deps, { date: DATE })
          expect(neighbour.phases.filter((phase) => phase.status === "failed")).toEqual([])
          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          yield* fixture.deps.git.mergeFastForward(neighbour.runId).pipe(Effect.orDie)

          /**
           * The state is real, asserted rather than assumed: reading trailers with an empty watermark
           * really does find the neighbour's phases in `main`'s history. A wrong count here would mean
           * this test proves nothing, so the number is derived from the neighbour's own report.
           */
          const committed = new Set(
            neighbour.phases.flatMap((phase) => (phase.commitSha === null ? [] : [phase.phase]))
          )
          expect(committed.size).toBeGreaterThan(4)
          const seen = yield* completedPhases(fixture.deps, "")
          expect([...seen].sort()).toEqual([...committed].sort())
          const trailers = yield* fixture.deps.git
            .logTrailers("HEAD", TRAILER_PHASE)
            .pipe(Effect.orDie)
          expect(trailers.flatMap((record) => record.values).length).toBeGreaterThan(4)

          const before = yield* commitCount(fixture)
          const unknownRunId = "sleep/2026-08-09"
          const resumed = yield* resume(fixture.deps, unknownRunId, { date: "2026-08-09" })

          // THE PROPERTY: the resume refuses, by name, and every phase reads failed rather than done.
          expect(resumed.phases).toHaveLength(SLEEP_PHASES.length)
          expect(resumed.phases.every((phase) => phase.status === "failed")).toBe(true)
          expect(resumed.phases[0]?.detail).toContain("no such run")
          expect(
            resumed.phases.filter((phase) => phase.detail === "already completed on this branch")
          ).toEqual([])

          // Nothing was committed onto `main`, and HEAD never left it.
          expect(yield* commitCount(fixture)).toBe(before)
          expect(yield* headBranch(fixture)).toBe("main")
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])

          // And no row was invented for the run id, which the NEXT resume would read as a watermark.
          expect(yield* readPhases(fixture.db, unknownRunId).pipe(Effect.orDie)).toEqual([])
          expect((yield* latestRun(fixture.db).pipe(Effect.orDie))?.run_id).toBe(neighbour.runId)
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("refuses a resume whose recorded branch no longer exists", async () => {
    /**
     * The other half of the same containment: a run row survives `git branch -D`, which is the
     * documented way to discard a bad run. Resuming it must not fall through onto whatever branch is
     * checked out — the discarded run's phases would land on `main` with the run's own trailers.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const discarded = yield* run(fixture.deps, { date: DATE, phases: ["preflight"] })
          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          yield* fixture.raw("branch", "-D", discarded.runId)

          const before = yield* commitCount(fixture)
          const resumed = yield* resume(fixture.deps, discarded.runId, { date: DATE })

          expect(resumed.phases.every((phase) => phase.status === "failed")).toBe(true)
          expect(resumed.phases[0]?.detail).toContain("cannot check out")
          expect(yield* commitCount(fixture)).toBe(before)
          expect(yield* headBranch(fixture)).toBe("main")
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})
