#!/usr/bin/env node
import { Effect } from "effect"

import { buildCorpus, DEFAULT_CORPUS_SIZE, DEFAULT_PROBE_COUNT, DEFAULT_SEED } from "./corpus.js"
import { makeFixtureCorpus } from "./fixture.js"

/**
 * `pnpm gen:fixture` writes a fixture corpus somewhere an operator can browse it.
 *
 * The corpus is NOT committed and this script is not part of any gate. The tests and
 * `memhtml eval discriminate` generate their own into a temp directory, because `corpus.ts` is a pure
 * function of `(seed, now)`. This exists for the case a generated corpus needs to be looked at. A probe
 * whose target ranks below a control is far easier to understand with both files open than with a
 * rank in an envelope.
 *
 * One JSON object on stdout, like every other machine surface in this repo, so the path is greppable
 * from a shell. Exit 2 is a usage refusal and exit 0 a generated corpus, the same two codes the CLI
 * uses, so a wrapper script can branch on them.
 */

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  if (at !== -1 && argv[at + 1] !== undefined) return argv[at + 1]
  const inline = argv.find((token) => token.startsWith(`--${name}=`))
  return inline?.slice(name.length + 3)
}

/** A flag whose value is not an integer. Carried as a type so the entry point can exit 2 on it. */
export class FixtureUsageError extends Error {}

/**
 * Read an integer flag, refusing a value that is not one.
 *
 * A present-but-unparseable flag is a refusal rather than a fall back to the default. Both halves of
 * that matter: silently defaulting generates a corpus the operator did not ask for, and
 * `Number.parseInt` alone accepts `12abc` as 12 and answers `--now=abc` with `NaN`, which reaches the
 * stamp formatter as an unattributed `RangeError: Invalid time value`.
 */
export const integerFlag = (
  argv: ReadonlyArray<string>,
  name: string,
  fallback: number
): number => {
  const raw = flag(argv, name)
  if (raw === undefined) return fallback
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw new FixtureUsageError(`--${name} takes an integer, received ${JSON.stringify(raw)}`)
  }
  return Number.parseInt(raw.trim(), 10)
}

/** Everything the script reads off `argv`, resolved. */
export interface FixtureArgs {
  readonly seed: number
  readonly size: number
  readonly probes: number
  /**
   * The run instant the stamps anchor behind, so an operator can regenerate the exact corpus a report
   * names — every report carries the quantized `now` it was built at. Absent means the fixture reads
   * Effect's Clock.
   */
  readonly now?: number | undefined
  readonly root?: string | undefined
  readonly dryRun: boolean
}

export const parseArgs = (argv: ReadonlyArray<string>): FixtureArgs => {
  const now = flag(argv, "now")
  const root = flag(argv, "out")
  return {
    seed: integerFlag(argv, "seed", DEFAULT_SEED),
    size: integerFlag(argv, "size", DEFAULT_CORPUS_SIZE),
    probes: integerFlag(argv, "probes", DEFAULT_PROBE_COUNT),
    ...(now === undefined ? {} : { now: integerFlag(argv, "now", 0) }),
    ...(root === undefined ? {} : { root }),
    dryRun: argv.includes("--dry-run")
  }
}

/**
 * `--dry-run` builds the spec and writes nothing, so the probe set is inspectable without a
 * filesystem. That is how a corpus change is reviewed before it is generated.
 */
const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  let args: FixtureArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (!(error instanceof FixtureUsageError)) throw error
    process.stderr.write(`gen-fixture: ${error.message}\n`)
    return 2
  }
  const { dryRun, ...options } = args

  if (dryRun) {
    // This script is an operator surface, not a gate, so the ambient clock is the right default here.
    const spec = buildCorpus({ ...options, now: options.now ?? Date.now() })
    process.stdout.write(
      `${JSON.stringify(
        {
          seed: spec.seed,
          now: spec.now,
          memories: spec.memories.length,
          probes: spec.probes.length,
          families: [...new Set(spec.probes.flatMap((probe) => probe.families))].sort(),
          sample: spec.probes.slice(0, 3)
        },
        null,
        2
      )}\n`
    )
    return 0
  }

  const fixture = await Effect.runPromise(Effect.scoped(makeFixtureCorpus(options)))
  process.stdout.write(
    `${JSON.stringify(
      {
        root: fixture.root,
        seed: fixture.spec.seed,
        now: fixture.spec.now,
        memories: fixture.written,
        probes: fixture.spec.probes.length
      },
      null,
      2
    )}\n`
  )
  return 0
}

// Guarded so the flag parsing above is reachable from a test without generating a corpus as a side
// effect of the import.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
