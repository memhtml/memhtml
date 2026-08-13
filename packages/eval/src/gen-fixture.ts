#!/usr/bin/env node
import { Effect } from "effect"

import { buildCorpus, DEFAULT_CORPUS_SIZE, DEFAULT_PROBE_COUNT, DEFAULT_SEED } from "./corpus.js"
import { makeFixtureCorpus } from "./fixture.js"

/**
 * `pnpm gen:fixture` writes a fixture corpus somewhere an operator can browse it.
 *
 * The corpus is NOT committed and this script is not part of any gate. The tests and
 * `memhtml eval discriminate` generate their own into a temp directory, because `corpus.ts` is a pure
 * function of a seed. This exists for the case a generated corpus needs to be looked at. A probe
 * whose target ranks below a control is far easier to understand with both files open than with a
 * rank in an envelope.
 *
 * One JSON object on stdout, like every other machine surface in this repo, so the path is greppable
 * from a shell.
 */

const flag = (name: string): string | undefined => {
  const argv = process.argv.slice(2)
  const at = argv.indexOf(`--${name}`)
  if (at !== -1 && argv[at + 1] !== undefined) return argv[at + 1]
  const inline = argv.find((token) => token.startsWith(`--${name}=`))
  return inline?.slice(name.length + 3)
}

const integer = (name: string, fallback: number): number => {
  const raw = flag(name)
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

const options = {
  seed: integer("seed", DEFAULT_SEED),
  size: integer("size", DEFAULT_CORPUS_SIZE),
  probes: integer("probes", DEFAULT_PROBE_COUNT),
  ...(flag("out") === undefined ? {} : { root: flag("out") as string })
}

/**
 * `--dry-run` builds the spec and writes nothing, so the probe set is inspectable without a
 * filesystem. That is how a corpus change is reviewed before it is generated.
 */
if (process.argv.includes("--dry-run")) {
  const spec = buildCorpus(options)
  process.stdout.write(
    `${JSON.stringify(
      {
        seed: spec.seed,
        memories: spec.memories.length,
        probes: spec.probes.length,
        families: [...new Set(spec.probes.flatMap((probe) => probe.families))].sort(),
        sample: spec.probes.slice(0, 3)
      },
      null,
      2
    )}\n`
  )
  process.exit(0)
}

const fixture = await Effect.runPromise(Effect.scoped(makeFixtureCorpus(options)))
process.stdout.write(
  `${JSON.stringify(
    {
      root: fixture.root,
      seed: fixture.spec.seed,
      memories: fixture.written,
      probes: fixture.spec.probes.length
    },
    null,
    2
  )}\n`
)
