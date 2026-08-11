import { SLEEP_REPORTS_DIR } from "@memhtml/store"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import type { PhaseResult, RunReport } from "../contract.js"
import { writeFileBytes } from "../edits.js"
import { emptyOutcome, type PhaseEnv, type PhaseOutcome, type SleepError } from "../env.js"
import { renderReport } from "../report.js"

/**
 * Phase 15 — report. Write `.memhtml/sleep/<run-id>.html` and commit it. ONE commit.
 *
 * This is the only phase whose input is the RUN rather than the corpus, so it takes the phases already
 * executed as a parameter instead of reading them back out of `sleep_phases` — the reporting tables are
 * a convenience the git history can regenerate, and a report that read from them would be a report of
 * what was recorded rather than of what happened.
 *
 * The report describes fourteen phases, not fifteen: it cannot describe itself. Its own row in
 * `sleep_phases` records the commit, and its file records everything before it.
 */
export const reportPhase =
  (executed: ReadonlyArray<PhaseResult>) =>
  (env: PhaseEnv): Effect.Effect<PhaseOutcome, SleepError> =>
    Effect.gen(function* () {
      const path = `${SLEEP_REPORTS_DIR}/${reportFilename(env.runId)}`
      const llmCalls = executed.reduce((total, phase) => total + phase.llmCalls, 0)
      const report: RunReport = {
        runId: env.runId,
        branch: env.branch,
        baseSha: env.baseSha,
        headSha: yield* headOf(env),
        dryRun: env.dryRun,
        phases: executed,
        llmCalls
      }
      const html = renderReport(report)

      const counts = {
        phases: executed.length,
        committed: executed.filter((phase) => phase.commitSha !== null).length,
        failed: executed.filter((phase) => phase.status === "failed").length,
        skipped: executed.filter((phase) => phase.status === "skipped").length,
        bytes: html.length
      }
      if (env.dryRun) return emptyOutcome(counts)

      yield* writeFileBytes(env, path, html)
      yield* env.deps.git.add([path])
      const commitSha = yield* commitPhase(env, "report", `record run ${env.runId}`, counts)
      return { counts, commitSha, llmCalls: 0 }
    })

/**
 * The report's filename. `/` is not legal in a filename and the run id is `sleep/<date>`, so the
 * separator becomes a hyphen — `sleep-2026-08-02.html`.
 */
export const reportFilename = (runId: string): string => `${runId.replaceAll("/", "-")}.html`

/** The branch tip, falling back to the base when nothing has committed. */
const headOf = (env: PhaseEnv): Effect.Effect<string, SleepError> =>
  env.deps.git.revParseHead().pipe(Effect.map((sha) => sha ?? env.baseSha))
