import type { GitFailure } from "@memhtml/store"
import { commitSubject } from "@memhtml/store"
import { Effect } from "effect"

import type { PhaseCounts, SleepPhase } from "./contract.js"
import { TRAILER_COUNTS, TRAILER_PHASE, TRAILER_RUN } from "./contract.js"
import type { PhaseEnv } from "./env.js"

/**
 * The one place a sleep commit is made, and therefore the one place the trailer block is written.
 *
 * The trailer is the resume mechanism, so this module formats it instead of each phase. `memhtml sleep
 * resume` reads `Memhtml-Phase` values out of `git log base..HEAD` and skips what it finds. A phase that
 * stamped the key by hand could misspell it and become permanently un-resumable, so the run would
 * re-execute it every time, re-archiving files a previous attempt already moved.
 *
 * `Memhtml-Counts` is JSON on one line. Git trailers are a single line per key and a value may contain
 * colons and commas, both of which `%(trailers:key=…,valueonly)` returns verbatim (probed live
 * 2026-08-02, including a value containing `{"a": 1, "b": 2}`).
 */

/** The three trailers a phase commit carries. */
export const phaseTrailers = (
  runId: string,
  phase: SleepPhase,
  counts: PhaseCounts
): Readonly<Record<string, string>> => ({
  [TRAILER_RUN]: runId,
  [TRAILER_PHASE]: phase,
  [TRAILER_COUNTS]: JSON.stringify(counts)
})

/**
 * Indent every line of a commit body by two spaces, which is what keeps a trailer out of a body.
 *
 * **This is an injection guard.** Git folds a line of the message's FINAL
 * paragraph into the trailer block when it begins at column 0 with `token:`. Probed live 2026-08-08
 * on the real git: a body whose last paragraph is `Memhtml-Phase: integrity` makes
 * `%(trailers:key=Memhtml-Phase,valueonly)` return `integrity` alongside the real value, and
 * `Memhtml-Phase:integrity` with no space does the same. `- Memhtml-Phase: …`, `  Memhtml-Phase: …`,
 * `Memhtml Phase: …`, and `evidence s1: Memhtml-Phase: …` all do NOT.
 *
 * The trailers are the resume mechanism (`run.ts:333-350` reads `Memhtml-Phase` values out of
 * `git log base..HEAD` and skips what it finds), so a body carrying a forged one would make a run
 * believe a phase already ran and skip it, permanently, on every resume. The only phase whose body
 * holds text this package did not write is trace-consolidation, whose evidence quotes come from a
 * model reading transcripts. Because that untrusted path exists, the guard sits here instead of at
 * that one call site. Two spaces defeats every variant above, verified against all three keys forged
 * at once as the whole final paragraph.
 */
const indentBody = (body: string): string =>
  body
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `  ${line}`))
    .join("\n")

/**
 * Commit whatever the phase staged, with the trailer block.
 *
 * Returns `null` when the index held nothing, because `git.commit` no-ops on an empty index instead
 * of failing. That is what makes every phase idempotent under a re-run: an already-merged
 * duplicate no longer surfaces as a candidate, an already-decayed confidence is a fixed point, and
 * an already-archived file is not a candidate, so a second pass stages nothing and costs no commit.
 *
 * `body` is optional context between the subject and the trailers, the reviewer-facing receipt for a
 * commit whose subject cannot carry its own justification. It is passed through {@link indentBody},
 * which prevents trailer injection; see that function.
 */
export const commitPhase = (
  env: PhaseEnv,
  phase: SleepPhase,
  subject: string,
  counts: PhaseCounts,
  body?: string
): Effect.Effect<string | null, GitFailure> =>
  env.deps.git
    .commit(
      body === undefined || body.trim() === ""
        ? commitSubject(`sleep(${phase})`, subject)
        : `${commitSubject(`sleep(${phase})`, subject)}\n\n${indentBody(body)}`,
      { trailers: phaseTrailers(env.runId, phase, counts) }
    )
    .pipe(Effect.map((result) => result.sha))
