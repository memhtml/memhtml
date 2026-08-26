import type { GitShape } from "@memhtml/store"
import { Effect, Result } from "effect"

import { isSleepPhase, isSweepPhase, TRAILER_PHASE } from "./contract.js"

/**
 * What this run has already written to the tree, read back out of the run's own commits.
 *
 * `commit.ts` is the one place a sleep commit is MADE, and therefore the one place the trailer block
 * is written; this is the one place those commits are READ BACK as a set of paths. A phase asking
 * "did another phase write this file tonight" has exactly one honest source, and it is the branch:
 * `PhaseEnv` carries no accumulator of prior phases' results, and one would be empty on a
 * `memhtml sleep resume` — the phases the killed attempt finished exist only as commits. So a guard
 * built on an accumulator would stop guarding on the one kind of run where a phase already wrote.
 *
 * **The set is scoped to the phases whose write carries a decision.** A phase in `SWEEP_PHASES`
 * restamps every eligible file by a rule, so its commit says nothing about any individual file, and
 * pinning the corpus on it makes the phase downstream refuse everything structurally (issue #81).
 * Every other commit in the range pins, including one carrying no recognizable phase at all — see
 * {@link isSweepCommit}.
 */

/**
 * The touched set, and how much confidence the reads earned.
 *
 * Three cases rather than one path set, because the difference is operator-visible and a caller must
 * not be able to lose it. A read that failed and quietly returned an empty set would turn the guard
 * OFF at exactly the moment it cannot tell what happened. So a failed read WIDENS, and a read that
 * failed entirely is its own value the caller reports rather than a set it acts on.
 */
export type TouchedSet =
  /** Both reads landed: the union of the non-sweep commits' own diffs. */
  | {
      readonly kind: "scoped"
      readonly paths: ReadonlySet<string>
      /** Non-sweep commits whose diffs are unioned here. */
      readonly commits: number
      /** Commits `SWEEP_PHASES` excluded. */
      readonly sweeps: number
    }
  /** A read failed, so the set is every path the whole range touched. Pins more than it must. */
  | { readonly kind: "widened"; readonly paths: ReadonlySet<string> }
  /** Nothing could be read. There is no set, and a caller must not proceed as if it were empty. */
  | { readonly kind: "unknown" }

/**
 * True when a commit's `Memhtml-Phase` trailer says every phase that made it is a sweep.
 *
 * **A missing, empty, or unrecognized value pins.** The trailer is what identifies a sweep, so the
 * absence of the identification cannot grant the exemption — an operator's own mid-run commit, a
 * commit stamped with a phase name this version does not know, and a forged value that is not a phase
 * all land on the conservative side. `every` rather than `some` for the same reason: a commit
 * claiming two phases is exempt only if neither of them decided anything.
 */
export const isSweepCommit = (values: ReadonlyArray<string>): boolean =>
  values.length > 0 && values.every((value) => isSleepPhase(value) && isSweepPhase(value))

/**
 * The paths this run wrote, excluding the sweeps.
 *
 * **Paths come back exactly as git spells them, with no normalization, and that is deliberate.**
 * `diff-tree --name-only -z` emits repo-root-relative, `/`-separated, unquoted paths with no leading
 * slash — the same spelling the `files` table holds, because the indexer derived those from
 * `git ls-tree`. `normalizePath` strips leading slashes, collapses doubled ones, and trims a trailing
 * one, so against this output it is a no-op, and a no-op called for its name reads as a guarantee
 * nobody checks. What holds the two spellings in agreement is a test that moves a real file after a
 * real phase wrote it.
 *
 * The set legitimately holds paths that are not memories — `edge-typing` stages its pending-marks
 * ledger into its own commit — and they are inert, because a caller only ever asks whether a
 * candidate's own path is in it.
 *
 * `baseSha === ""` is an empty set rather than a scan of all of `HEAD`. Over `HEAD` a previously
 * merged run's trailers name every phase, so the set would become every file every past sleep ever
 * touched: the same over-pinning, one release further back. With no base there is no run to bound, and
 * production always has one because `preflight` requires a commit and a clean tree.
 */
export const touchedThisRun = (
  git: GitShape,
  baseSha: string
): Effect.Effect<TouchedSet, never, never> =>
  Effect.gen(function* () {
    if (baseSha === "") {
      return { kind: "scoped" as const, paths: new Set<string>(), commits: 0, sweeps: 0 }
    }
    const range = `${baseSha}..HEAD`

    const read = yield* Effect.result(git.logTrailers(range, TRAILER_PHASE))
    if (Result.isFailure(read)) {
      yield* Effect.logWarning(
        `sleep.touched could not read ${TRAILER_PHASE} over ${range}; pinning the whole range`
      )
      return yield* widen(git, baseSha)
    }

    const records = read.success
    const semantic = records.flatMap((record) => (isSweepCommit(record.values) ? [] : [record.sha]))
    const diffed = yield* Effect.result(git.diffTreeNames(semantic))
    if (Result.isFailure(diffed)) {
      yield* Effect.logWarning(
        `sleep.touched could not diff ${String(semantic.length)} commit(s) of ${range}; ` +
          `pinning the whole range`
      )
      return yield* widen(git, baseSha)
    }

    return {
      kind: "scoped" as const,
      paths: new Set(diffed.success),
      commits: semantic.length,
      sweeps: records.length - semantic.length
    }
  })

/**
 * Every path the range touched, as the fallback when the scoped read could not be made.
 *
 * Through `diffNameStatus`, which detects renames and reports the pre-move path in `fromPath`. BOTH
 * sides go in: this set exists to be conservative, and a `git mv`'s source is a path a phase wrote as
 * surely as its destination is.
 */
const widen = (git: GitShape, baseSha: string): Effect.Effect<TouchedSet, never, never> =>
  git.diffNameStatus(baseSha, "HEAD").pipe(
    Effect.map((changes): TouchedSet => {
      const paths = new Set<string>()
      for (const change of changes) {
        paths.add(change.path)
        if (change.fromPath !== null) paths.add(change.fromPath)
      }
      return { kind: "widened", paths }
    }),
    Effect.orElseSucceed((): TouchedSet => ({ kind: "unknown" }))
  )
