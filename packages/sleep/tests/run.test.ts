import { originalPathFor } from "@memhtml/contracts/paths"
import { GENERATED_NAMES } from "@memhtml/index"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { SLEEP_PHASES, TRAILER_COUNTS, TRAILER_PHASE, TRAILER_RUN } from "../src/contract.js"
import { ArcPlan, EdgeTyping } from "../src/llm.js"
import { instantFor, resume, run, runIdFor } from "../src/run.js"
import { latestRun, readPhases } from "../src/sql.js"
import { isDetectedTaskPath } from "../src/tasks.js"
import {
  candidate,
  candidates,
  scriptedConsolidator,
  scriptedModel,
  value,
  violation
} from "../src/testing.js"
import { pendingSessions } from "./abort-fixture.js"
import {
  consolidationWatermarks,
  DEDUP_CORPUS,
  type Fixture,
  LAST_DROP_PATH,
  memoryHtml,
  seedTrace,
  TASK_CORPUS,
  withFixture
} from "./fixture.js"

/**
 * The runner against a real repo.
 *
 * Every assertion that is about git reads GIT, not the report. A runner that returned
 * `status: "ok"` with a `commitSha` while committing nothing would satisfy every shape assertion
 * here and none of the ones that matter.
 */

const DATE = "2026-08-02"

/** Commits reachable from HEAD. What proves a phase committed. */
const commitCount = (fixture: Fixture): Effect.Effect<number> =>
  fixture.raw("rev-list", "--count", "HEAD").pipe(Effect.map((text) => Number(text.trim())))

/** The `Memhtml-Phase` trailer values on the branch, newest first. */
const phaseTrailers = (fixture: Fixture, range: string): Effect.Effect<ReadonlyArray<string>> =>
  fixture.deps.git.logTrailers(range, TRAILER_PHASE).pipe(
    Effect.map((records) => records.flatMap((record) => record.values)),
    Effect.orDie
  )

/** A model that answers every LLM phase with "nothing to do", so no LLM phase commits. */
const inertModel = () =>
  scriptedModel((request) =>
    request.system.startsWith("You triage")
      ? value({ entries: [] })
      : request.system.startsWith("You partition")
        ? // dedup-merge's partition call. `groups: []` is a refusal, which leaves the phase on its
          // deterministic arm — the same pairs it folds with no model bound at all.
          value({ groups: [] })
        : request.system.startsWith("You type")
          ? value({ verdicts: [] })
          : value({ title: "x", claim: "y", paragraphs: [], absorbedKeys: [] })
  )

describe("run", () => {
  it("creates sleep/<date>, executes all seventeen phases, and stamps one trailer per commit", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* commitCount(fixture)
          const report = yield* run(fixture.deps, { date: DATE })

          expect(report.runId).toBe(`sleep/${DATE}`)
          expect(report.branch).toBe(`sleep/${DATE}`)
          expect(report.phases.map((phase) => phase.phase)).toEqual([...SLEEP_PHASES])

          // The branch exists in GIT and HEAD is on it.
          const branch = (yield* fixture.raw("rev-parse", "--abbrev-ref", "HEAD")).trim()
          expect(branch).toBe(`sleep/${DATE}`)

          // Exactly one Memhtml-Phase trailer per commit the run made.
          const committed = report.phases.filter((phase) => phase.commitSha !== null)
          expect(yield* commitCount(fixture)).toBe(before + committed.length)
          const trailers = yield* phaseTrailers(fixture, `${report.baseSha}..HEAD`)
          expect(trailers.length).toBe(committed.length)
          expect(new Set(trailers)).toEqual(new Set(committed.map((phase) => phase.phase)))

          // Every commit carries the whole trailer block, not only the phase key.
          const runs = yield* fixture.deps.git
            .logTrailers(`${report.baseSha}..HEAD`, TRAILER_RUN)
            .pipe(Effect.orDie)
          expect(runs.every((record) => record.values[0] === report.runId)).toBe(true)
          const counts = yield* fixture.deps.git
            .logTrailers(`${report.baseSha}..HEAD`, TRAILER_COUNTS)
            .pipe(Effect.orDie)
          expect(counts.every((record) => record.values.length === 1)).toBe(true)
          // `Memhtml-Counts` survives as parseable JSON: git returns a trailer value verbatim.
          for (const record of counts) {
            expect(() => JSON.parse(record.values[0] ?? "")).not.toThrow()
          }

          // The report and the sleep phase never disagree about which phases failed.
          expect(report.phases.filter((phase) => phase.status === "failed")).toEqual([])
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("commits nothing on a dry run and leaves the tree clean", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* commitCount(fixture)
          const branchBefore = (yield* fixture.raw("rev-parse", "--abbrev-ref", "HEAD")).trim()

          const report = yield* run(fixture.deps, { date: DATE, dryRun: true })

          expect(report.dryRun).toBe(true)
          // Every phase reports counts; none reports a commit.
          expect(report.phases.every((phase) => phase.commitSha === null)).toBe(true)
          expect(report.phases.some((phase) => Object.keys(phase.counts).length > 0)).toBe(true)
          // A dry run still discovers the duplicate — the counts are real, only the writes are not.
          const dedup = report.phases.find((phase) => phase.phase === "dedup-merge")
          expect(dedup?.counts.merged).toBeGreaterThan(0)

          expect(yield* commitCount(fixture)).toBe(before)
          expect((yield* fixture.raw("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
            branchBefore
          )
          // The tree is clean AFTER the dry run: no phase wrote a file.
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])

          // The one row a dry run writes is the run row, marked so a report can say it was dry.
          const row = yield* latestRun(fixture.db).pipe(Effect.orDie)
          expect(row?.status).toBe("abandoned")
          // And NO phase rows: a dry run leaves no per-phase record to be mistaken for a real one.
          expect(yield* readPhases(fixture.db, report.runId).pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("suffixes the branch on a same-day rerun", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const first = yield* run(fixture.deps, { date: DATE })
          expect(first.runId).toBe(`sleep/${DATE}`)
          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          const second = yield* run(fixture.deps, { date: DATE })
          expect(second.runId).toBe(`sleep/${DATE}-2`)
          expect(yield* fixture.deps.git.branchExists(`sleep/${DATE}-2`).pipe(Effect.orDie)).toBe(
            true
          )
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("isolates a failing LLM phase: prior commits intact, later phases still run", async () => {
    /**
     * The injected failure is a `LlmContractViolation` on every edge-typing call. Per-item
     * isolation means the PHASE does not fail — it counts the skips — which is the correct behavior
     * and is asserted below. The phase-level failure path is covered separately by the hard-prereq
     * test, where a real phase failure is provoked.
     */
    const model = scriptedModel((request) =>
      request.system.startsWith("You type relationships")
        ? violation("scripted off-schema answer")
        : value({ entries: [] })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })

          const typing = report.phases.find((phase) => phase.phase === "edge-typing")
          const dedup = report.phases.find((phase) => phase.phase === "dedup-merge")
          const stateExport = report.phases.find((phase) => phase.phase === "state-export")
          const reportPhase = report.phases.find((phase) => phase.phase === "report")

          // Every candidate pair was skipped, and the phase counted them rather than aborting.
          expect(typing?.status).toBe("ok")
          expect(typing?.counts.skipped).toBeGreaterThan(0)
          expect(typing?.counts.judged).toBe(0)
          expect(typing?.commitSha).toBeNull()

          // The phase BEFORE it committed, and the phases AFTER it ran.
          expect(dedup?.commitSha).not.toBeNull()
          expect(stateExport?.status).toBe("ok")
          expect(reportPhase?.commitSha).not.toBeNull()

          // The dedup commit is still reachable: nothing was rolled back.
          const trailers = yield* phaseTrailers(fixture, `${report.baseSha}..HEAD`)
          expect(trailers).toContain("dedup-merge")
          expect(trailers).toContain("report")
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("skips compress and retention-triage when dedup-merge fails, and runs everything else", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * dedup-merge is made to fail for real, and — deliberately — to fail on its SECOND archive,
           * AFTER the first has already staged files. A failure before anything is staged would make the
           * "nothing left staged" assertion below vacuous, and this test's whole subject is that the
           * failed phase's partial work does not ride along in the next phase's commit.
           *
           * **The provocation is a read-only DESTINATION DIRECTORY**, which makes `git mv` exit 128 with
           * `fatal: renaming … failed: Permission denied` (probed live 2026-08-20 on the real git). The
           * corpus is read oldest-first, so the oncall pair archives cleanly and stages its files before
           * the metrics pair fails.
           *
           * It used to squat the destination PATH with a tracked file, which raised
           * `fatal: destination exists`. That no longer fails the phase and must not: `archiveFile` now
           * probes the destination and takes the next free ordinal, precisely so a path archived twice in
           * one year does not cost a whole phase (`packages/sleep/src/edits.ts`). So this test needed a
           * provocation the probe cannot route around, and a directory the process may not write into is
           * one — the probe reads ENOENT (the destination really is free), `mkdir -p` succeeds on the
           * directory that already exists, and the rename is what git refuses. Each of those three was
           * measured before this test was rewritten around them.
           */
          yield* Effect.promise(async () => {
            const { chmod, mkdir } = await import("node:fs/promises")
            const { dirname, join } = await import("node:path")
            const parent = join(fixture.root, dirname(`archive/2026/${LAST_DROP_PATH}`))
            await mkdir(parent, { recursive: true })
            await chmod(parent, 0o500)
          })
          yield* fixture.reindex()

          const report = yield* run(fixture.deps, { date: DATE })
          const phaseOf = (name: string) =>
            report.phases.find((candidate) => candidate.phase === name)

          // The phase itself failed, with a reason an operator can read.
          expect(phaseOf("dedup-merge")?.status).toBe("failed")
          expect(phaseOf("dedup-merge")?.detail).toContain("GitFailure")
          expect(phaseOf("dedup-merge")?.commitSha).toBeNull()

          // Its two HARD dependents are skipped, naming the blocker.
          expect(phaseOf("compress")?.status).toBe("skipped")
          expect(phaseOf("compress")?.detail).toBe("hard prerequisite dedup-merge failed")
          expect(phaseOf("retention-triage")?.status).toBe("skipped")
          expect(phaseOf("retention-triage")?.detail).toBe("hard prerequisite dedup-merge failed")

          // Every SOFT phase after it still ran, and the report still committed.
          expect(phaseOf("confidence-decay")?.status).toBe("ok")
          expect(phaseOf("integrity")?.status).toBe("ok")
          expect(phaseOf("state-export")?.status).toBe("ok")
          expect(phaseOf("report")?.commitSha).not.toBeNull()

          /**
           * NO COMMIT ON THE BRANCH CARRIES THE FAILED PHASE'S WORK.
           *
           * This is asserted over the whole branch's diff rather than over `diff --cached` at the end:
           * the phases after the failure commit, and each commit flushes the index — so reading the
           * final staged set would report empty whether or not the reset happened, and the assertion
           * would be vacuous. (Verified by mutation: removing the reset left an index-only assertion
           * green.) What the reset actually prevents is a LATER phase's commit absorbing dedup-merge's
           * half-finished archive, so that is what is checked.
           *
           * dedup-merge staged one clean archive before the second move failed, so the abandoned work is
           * observable: the moved-out path would be deleted and its archive copy added by whichever
           * phase committed next.
           */
          const changes = yield* fixture.deps.git
            .diffNameStatus(report.baseSha, "HEAD")
            .pipe(Effect.orDie)
          const abandoned = changes.filter(
            (change) =>
              change.path.startsWith("archive/2026/areas/metrics/") ||
              change.fromPath?.startsWith("areas/metrics/") === true
          )
          expect(abandoned).toEqual([])

          // Both metrics memories are still live at their original paths on the branch.
          for (const path of [
            "areas/metrics/scrape-cadence.html",
            "areas/metrics/exporter-scrape-interval.html"
          ]) {
            const live = yield* fixture.deps.git.run(["cat-file", "-e", `HEAD:${path}`]).pipe(
              Effect.map(() => true),
              Effect.orElseSucceed(() => false)
            )
            expect(live).toBe(true)
          }
        }).pipe(
          /**
           * The mode is restored whatever the body did, so the fixture's temp-dir cleanup can remove the
           * tree. `ensuring` rather than a trailing statement, because a failed assertion above would
           * otherwise leave an unremovable directory behind and every later test in the file would fail
           * on the tmpdir rather than on itself.
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
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("evicts into archive/ as a RENAME that git log --follow reads through", async () => {
    /**
     * The assertion is `kind: "renamed"` plus a similarity floor plus `log --follow`, NEVER `R100`.
     * An archive commit stamps `memhtml-status`/`memhtml-archived` in the SAME commit, and rename similarity is
     * computed tree-to-tree — so a head stamp lowers it (T6 measured R059-R087 on real memory files).
     * `originalPathFor` is the authoritative inverse, and no correctness path reads the score.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * A memory built to land in the EVICT band: episodic (so recency carries the most weight),
           * seven months stale at the run date, never accessed, unreferenced, and short enough that
           * the content-density signal is penalized. Retention triage archives it, and that archive
           * move is what this test measures.
           */
          yield* fixture.commit(
            [
              {
                path: "areas/stale/a-forgotten-detail.html",
                html: memoryHtml({
                  title: "A forgotten detail",
                  claim: "The staging bastion listened on port 2222.",
                  memoryType: "episodic",
                  createdAt: "2026-01-05T00:00:00Z",
                  confidence: "0.20",
                  importance: "1"
                })
              }
            ],
            "seed an evictable memory"
          )
          yield* fixture.reindex()

          const report = yield* run(fixture.deps, { date: DATE })

          // The eviction happened, and the report says so.
          const triage = report.phases.find((phase) => phase.phase === "retention-triage")
          expect(triage?.counts.evicted ?? 0).toBeGreaterThan(0)

          const changes = yield* fixture.deps.git
            .diffNameStatus(report.baseSha, "HEAD")
            .pipe(Effect.orDie)
          const renames = changes.filter(
            (change) => change.kind === "renamed" && change.path.startsWith("archive/")
          )
          expect(renames.length).toBeGreaterThan(0)

          for (const rename of renames) {
            // Rename detection provably holds — git's default threshold is 50%.
            expect(rename.similarity ?? 0).toBeGreaterThanOrEqual(50)
            // The path algebra, not the score, is what inverts the move.
            expect(originalPathFor(rename.path)).toBe(rename.fromPath)

            /**
             * `--follow` reads THROUGH the move: the archive path's history reaches back past the
             * eviction to the commit that created the file at its live path. That is the property the
             * path-mirroring archive layout buys, and it is what makes an eviction recoverable.
             */
            const follow = yield* fixture.raw("log", "--follow", "--format=%H", "--", rename.path)
            const shas = follow
              .trim()
              .split("\n")
              .filter((line) => line !== "")
            expect(shas.length).toBeGreaterThan(1)
            // The oldest commit `--follow` reaches predates the sleep branch entirely.
            const oldest = shas[shas.length - 1] ?? ""
            const ancestor = yield* fixture
              .raw("merge-base", "--is-ancestor", oldest, report.baseSha)
              .pipe(
                Effect.map(() => true),
                Effect.orElseSucceed(() => false)
              )
            expect(ancestor).toBe(true)
          }

          /**
           * At least one archive rename measured BELOW 100 — the fact that makes gating on `R100`
           * wrong rather than merely brittle. If this ever fails because every archive scored 100, the
           * archive stopped stamping its head in the same commit and design §2.1 changed.
           */
          expect(renames.some((rename) => (rename.similarity ?? 100) < 100)).toBe(true)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })
})

describe("trace-consolidation inside a full run", () => {
  it("commits over eleven predecessors' writes and leaves integrity green", async () => {
    /**
     * The cross-phase-contamination discipline applied to the newest committing phase.
     *
     * trace-consolidation is phase TWELVE, so by the time it writes, dedup-merge has archived two
     * duplicates, entity-resolution and person-links have stamped heads, relationship-mining has
     * written derived edges, confidence-decay has rewritten confidences, retention-triage and reprieve
     * have moved files, and compress may have folded a community. A phase test over a clean corpus
     * says nothing about that; this one is the only place the phase runs downstream of all of it.
     *
     * **Integrity is the assertion that matters.** It runs immediately AFTER trace-consolidation and
     * repairs dangling authored edges and regenerates directory listings — so a phase that wrote a file
     * with a bad path, a broken link, or an unparseable head would surface HERE, as integrity failing or
     * as a repair commit undoing the write. (This is exactly why the phase records the conflict in its
     * counts rather than stamping an authored `<link>`: an edge toward a path integrity cannot resolve
     * is the failure mode being excluded.)
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({
          claim: "Partial indexes on this driver need the predicate restated in the query.",
          gist: "Two separate lookups planned as a table scan until the redundant clause was added.",
          kind: "error_pattern",
          entities: ["service:sqlite"]
        }),
        candidate({
          claim: "A fixture corpus goes stale one phase before the phase under test.",
          gist: "Several debugging sessions ended at a preceding phase's write.",
          kind: "agent_insight"
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* seedTrace(fixture, { sessionId: "session-b" })

          const report = yield* run(fixture.deps, { date: DATE })
          const phaseOf = (name: string) =>
            report.phases.find((candidateOne) => candidateOne.phase === name)

          const trace = phaseOf("trace-consolidation")
          expect(trace?.status).toBe("ok")
          expect(trace?.counts.written).toBe(2)
          expect(trace?.commitSha).not.toBeNull()
          // Its cost lands in the run's total, which is what makes it an LLM phase.
          expect(trace?.llmCalls).toBeGreaterThan(0)
          expect(report.llmCalls).toBeGreaterThanOrEqual(trace?.llmCalls ?? 0)

          /**
           * The three phases AFTER it all ran and none failed — integrity in particular, which is the
           * one that would notice a malformed write.
           */
          expect(phaseOf("integrity")?.status).toBe("ok")
          expect(phaseOf("state-export")?.status).toBe("ok")
          expect(phaseOf("report")?.commitSha).not.toBeNull()
          expect(report.phases.filter((phase) => phase.status === "failed")).toEqual([])

          /**
           * Integrity did not have to REPAIR anything the phase wrote. `repaired` counts authored edges
           * pointing at absent paths, so a nonzero value here would mean a consolidated memory carried a
           * link integrity had to strip — the assertion that the phase writes no dangling edge.
           */
          expect(phaseOf("integrity")?.counts.repaired ?? 0).toBe(0)

          // Two trailers name the phase, one per candidate: the commits are on the branch and
          // reachable by the resume/review machinery over the whole run's range.
          const trailers = yield* phaseTrailers(fixture, `${report.baseSha}..HEAD`)
          expect(trailers.filter((one) => one === "trace-consolidation")).toHaveLength(2)

          /**
           * The two files PROJECT — parseable, indexable, and reachable by retrieval like any other
           * memory. A file the indexer skipped would sit in the tree and be absent from every search,
           * visible only as a log line.
           *
           * The reindex is EXPLICIT here, and that is a property of the design rather than a test
           * convenience: the index is refreshed once, in preflight, and not again
           * (`packages/sleep/src/edits.ts:136-140`), so nothing phase twelve writes is indexed within
           * its own run — the next cycle's preflight picks it up. Querying `files` straight after the
           * run therefore returns nothing, which is correct and was verified here rather than assumed.
           * What matters is that the projection ACCEPTS these files, which is what this asserts.
           */
          yield* fixture.reindex()
          const rows = yield* fixture.db
            .all<{ path: string; memory_type: string; gist: string; frame_key: string | null }>(
              `SELECT path, memory_type, gist, frame_key FROM files
               WHERE author = 'agent:sleep' AND memory_type IN ('error_pattern', 'agent_insight')
               ORDER BY path`
            )
            .pipe(Effect.orDie)
          expect(rows).toHaveLength(2)
          for (const row of rows) {
            // A projected gist means the `<mark>` claim survived the template and the parser.
            expect(row.gist, row.path).not.toBe("")
          }

          // Both sessions carry a PENDING watermark, which `merge` applies once the branch lands. The
          // state plane stays untouched until then, so discarding this branch leaves them re-selectable.
          expect(yield* pendingSessions(fixture, report.runId)).toEqual(["session-a", "session-b"])
        }),
      { seed: DEDUP_CORPUS, model: inertModel(), consolidator }
    )
  })

  it("is skipped rather than failed on a run with no consolidator, all seventeen still green", async () => {
    /**
     * The CI shape, at the RUNNER rather than at the phase: no credentials, so nothing is bound, and
     * the run must still report seventeen phases with none failed. This is the case that would break if
     * the phase's degradation ever became a failure.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const report = yield* run(fixture.deps, { date: DATE })

          const trace = report.phases.find((phase) => phase.phase === "trace-consolidation")
          expect(trace?.status).toBe("ok")
          expect(trace?.detail).toBe("no consolidator bound")
          expect(trace?.commitSha).toBeNull()
          expect(report.phases).toHaveLength(SLEEP_PHASES.length)
          expect(report.phases.filter((phase) => phase.status === "failed")).toEqual([])
          expect(yield* consolidationWatermarks(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })
})

describe("a full run leaves every open task untouched", () => {
  /**
   * The cross-phase-contamination discipline applied to the task exclusions.
   *
   * The tasks are seeded BESIDE the memories, and each is built to reach a specific phase — a
   * near-duplicate pair for dedup-merge, a memory-vocabulary twin for mining and conflict detection,
   * an EVICT-band TTL-passed task for triage and reprieve, a `person:` entity for person-links, a
   * mixed-case entity for entity-resolution. A corpus of fresh unrelated tasks would be skipped by
   * every phase regardless, and this test would pass against a sleep cycle with NO exclusions.
   *
   * The assertion is the git BLOB of each task file, not its parsed content: a `memhtml-updated` stamp,
   * a `memhtml-confidence` rewrite, or an added `<link>` all change the blob, and all three are things a
   * phase would do to a memory. Plus: no edge with a task endpoint, and no task moved or archived.
   */
  const taskPaths = TASK_CORPUS.map((file) => file.path)

  /** `path -> blob sha` for every task file at a given commit. */
  const taskBlobs = (fixture: Fixture, commitish: string) =>
    Effect.gen(function* () {
      const entries = new Map<string, string>()
      for (const path of taskPaths) {
        const line = yield* fixture
          .raw("rev-parse", `${commitish}:${path}`)
          .pipe(Effect.map((text) => text.trim()))
        entries.set(path, line)
      }
      return entries
    })

  it("keeps every task file byte-identical and mines no edge onto one", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* taskBlobs(fixture, "HEAD")
          const report = yield* run(fixture.deps, { date: DATE })

          // Every task file's blob is unchanged: no stamp, no link, no confidence rewrite.
          const after = yield* taskBlobs(fixture, "HEAD")
          expect([...after.entries()]).toEqual([...before.entries()])

          /**
           * And the run did real work on the MEMORIES, or "nothing changed" is trivially true.
           * `merged: 2` is the memory corpus's own two duplicate pairs — the task corpus adds a
           * third mergeable pair, so this number is also the dedup exclusion's own assertion.
           */
          const committed = report.phases.filter((phase) => phase.commitSha !== null)
          expect(committed.length).toBeGreaterThan(0)
          expect(report.phases.find((phase) => phase.phase === "dedup-merge")?.counts.merged).toBe(
            2
          )

          /**
           * And no task MEMORY FILE moved: no archive, no rename under a tasks directory.
           *
           * `index.html` is excluded because it is a generated artifact rather than a memory —
           * `isIndexablePath` refuses the name, so it holds no row and enters no phase's corpus.
           * Integrity generating one for `areas/inbox/tasks/` is the design working: a browsable
           * directory listing is what makes "read a dir" the list operation for tasks too.
           */
          const changes = yield* fixture.deps.git
            .diffNameStatus(report.baseSha, "HEAD")
            .pipe(Effect.orDie)
          const underTasks = changes.filter(
            (change) =>
              (change.path.includes("/tasks/") || change.fromPath?.includes("/tasks/") === true) &&
              !GENERATED_NAMES.some((name) => change.path.endsWith(`/${name}`))
          )
          /**
           * A run may now ADD a task under `/tasks/`, and every one it adds is a DETECTED task the
           * night opened for a human (issue #44). Those are excluded by their `det-<digest>-` stem
           * rather than by being under the directory, so the invariant this test protects stays what it
           * always was — no phase touches an EXISTING task — while a night that defers a decision is
           * not read as a violation.
           *
           * `isDetectedTaskPath` is the same predicate the minting module keys on, so a change that
           * broke the prefix would fail here rather than quietly widening the exclusion. The
           * classification is asserted too: a detected task may only ever be ADDED by a run, never a
           * modify or a rename of something that was already there.
           */
          const detected = underTasks.filter((change) => isDetectedTaskPath(change.path))
          expect(detected.every((change) => change.kind === "added")).toBe(true)
          expect(underTasks.filter((change) => !isDetectedTaskPath(change.path))).toEqual([])

          // No edge — authored OR derived, any class — has a task at either end.
          const edges = yield* fixture.db
            .all<{ src_path: string; rel: string; dst_path: string; edge_class: string }>(
              "SELECT src_path, rel, dst_path, edge_class FROM edges"
            )
            .pipe(Effect.orDie)
          expect(edges.length).toBeGreaterThan(0)
          const ontoTask = edges.filter(
            (edge) => edge.src_path.includes("/tasks/") || edge.dst_path.includes("/tasks/")
          )
          expect(ontoTask).toEqual([])

          /**
           * person-links minted no person file out of a task's `person:imani`. A person file is a
           * durable identity surface a human hand-edits; creating one from a to-do item would put
           * working state into the corpus's most permanent plane. (`.gitkeep` is the scaffold's,
           * from `memhtml init`.)
           */
          const people = yield* fixture
            .raw("ls-tree", "-r", "--name-only", "HEAD", "resources/people/")
            .pipe(Effect.orElseSucceed(() => ""))
          const personFiles = people
            .trim()
            .split("\n")
            .filter((line) => line.endsWith(".html"))
          expect(personFiles).toEqual([])

          // No task was scored: confidence-decay counts its type skips separately from its
          // reinforced ones, so the number is readable rather than absorbed into a difference.
          const decay = report.phases.find((phase) => phase.phase === "confidence-decay")
          expect(decay?.counts.skippedType).toBe(taskPaths.length)
        }),
      { seed: [...DEDUP_CORPUS, ...TASK_CORPUS], model: inertModel() }
    )
  })

  it("still lets a phase see a task's row, so the skip is a decision and not an empty index", async () => {
    /**
     * The guard against a vacuous version of the test above: if the indexer refused task files
     * outright, every assertion would hold for the wrong reason. Tasks ARE indexed — with their
     * columns, chunks, and embeddings — and it is the phases that decline to act on them.
     */
    const rows = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* run(fixture.deps, { date: DATE })
          return yield* fixture.db
            .all<{ path: string; task_status: string | null; chunks: number; vectors: number }>(
              `SELECT f.path AS path, f.task_status AS task_status,
                      (SELECT count(*) FROM chunks c WHERE c.path = f.path) AS chunks,
                      (SELECT count(*) FROM embeddings e JOIN chunks c ON c.chunk_id = e.chunk_id
                        WHERE c.path = f.path) AS vectors
               FROM files f WHERE f.memory_type = 'task' ORDER BY f.path`
            )
            .pipe(Effect.orDie)
        }),
      { seed: [...DEDUP_CORPUS, ...TASK_CORPUS], model: inertModel() }
    )

    expect(rows.map((row) => row.path)).toEqual([...taskPaths].sort())
    for (const row of rows) {
      expect(row.task_status, row.path).not.toBeNull()
      expect(row.chunks, row.path).toBeGreaterThan(0)
      expect(row.vectors, row.path).toBeGreaterThan(0)
    }
  })
})

describe("resume", () => {
  it("skips the phases whose trailers are already on the branch and runs only the rest", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const firstFive = SLEEP_PHASES.slice(0, 5)
          const partial = yield* run(fixture.deps, { date: DATE, phases: [...firstFive] })
          expect(partial.phases.map((phase) => phase.phase)).toEqual([...firstFive])

          const committedFirst = partial.phases
            .filter((phase) => phase.commitSha !== null)
            .map((phase) => phase.phase)
          expect(committedFirst.length).toBeGreaterThan(0)

          const resumed = yield* resume(fixture.deps, partial.runId, { date: DATE })

          // All seventeen are accounted for. A resume that reported only the ten it ran would read as a
          // partial run.
          expect(resumed.phases.map((phase) => phase.phase)).toEqual([...SLEEP_PHASES])

          /**
           * The COMMITTED phases are skipped, and only those. A phase that ran and committed nothing
           * left no trailer, so it legitimately re-executes — which is safe precisely because every
           * phase is idempotent: an already-merged duplicate no longer surfaces, an already-decayed
           * confidence is a fixed point, an already-archived file is no longer a candidate.
           */
          for (const phase of committedFirst) {
            const row = resumed.phases.find((candidate) => candidate.phase === phase)
            expect(row?.status).toBe("skipped")
            expect(row?.detail).toBe("already completed on this branch")
          }
          const skipped = resumed.phases
            .filter((phase) => phase.detail === "already completed on this branch")
            .map((phase) => phase.phase)
          expect(new Set(skipped)).toEqual(new Set(committedFirst))

          // The phases beyond the first five ran, and at least one of them committed.
          const later = resumed.phases.filter((phase) => SLEEP_PHASES.indexOf(phase.phase) >= 5)
          expect(later.every((phase) => phase.detail !== "already completed on this branch")).toBe(
            true
          )
          expect(later.some((phase) => phase.commitSha !== null)).toBe(true)

          // The trailers on the branch now name every phase that ever committed on it, once each.
          const trailers = yield* phaseTrailers(fixture, `${partial.baseSha}..HEAD`)
          expect(trailers.length).toBe(new Set(trailers).size)

          /**
           * A second resume re-executes only the phases that still hold no trailer, and — the property
           * that matters — commits nothing more. Idempotence is asserted against GIT: the commit count
           * does not move.
           */
          const before = yield* commitCount(fixture)
          const again = yield* resume(fixture.deps, partial.runId, { date: DATE })
          expect(yield* commitCount(fixture)).toBe(before)
          expect(again.phases.filter((phase) => phase.status === "failed")).toEqual([])
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })
})

describe("run id and instant", () => {
  it("suffixes only when the base name is taken", () => {
    expect(runIdFor("2026-08-02", [])).toBe("sleep/2026-08-02")
    expect(runIdFor("2026-08-02", ["sleep/2026-08-02"])).toBe("sleep/2026-08-02-2")
    expect(runIdFor("2026-08-02", ["sleep/2026-08-02", "sleep/2026-08-02-2"])).toBe(
      "sleep/2026-08-02-3"
    )
  })

  it("derives the run instant from the date parameter alone, never from a clock", () => {
    expect(instantFor("2026-08-02").at).toBe("2026-08-02T00:00:00Z")
    // Two calls a day apart in wall-clock time give the same instant for the same date.
    expect(instantFor("2026-08-02")).toEqual(instantFor("2026-08-02"))
  })
})

describe("scripted model fidelity", () => {
  it("decodes a scripted payload through the production decoder, refusing an excess key", async () => {
    /**
     * The fake is a CLIENT, not a stubbed phase, and it decodes through `decodeToolInput` — including
     * `onExcessProperty: "error"`. So a fixture that drifts from the schema is refused here exactly as
     * a real model's off-schema answer would be, which is what keeps the fake from proving a phase
     * works against a shape the model can never produce.
     */
    const model = scriptedModel(() =>
      value({
        verdicts: [
          {
            pairKey: "m1",
            rel: "contradicts",
            direction: "src_to_dst",
            confidence: 0.9,
            rationale: "x",
            extra: 1
          }
        ]
      })
    )
    const outcome = await Effect.runPromise(
      Effect.result(
        model.generateObject({
          schema: EdgeTyping,
          prompt: "p",
          modelKey: "sonnet-5",
          effort: "low"
        })
      )
    )
    expect(outcome._tag).toBe("Failure")
  })

  it("accepts a payload that satisfies the schema", async () => {
    const model = scriptedModel(() => value({ entries: [] }))
    const plan = await Effect.runPromise(
      model.generateObject({ schema: ArcPlan, prompt: "p", modelKey: "opus-5", effort: "low" })
    )
    expect(plan.entries).toEqual([])
    expect(model.calls).toHaveLength(1)
  })
})
