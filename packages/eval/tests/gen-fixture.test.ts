import { describe, expect, it } from "vitest"

import { DEFAULT_CORPUS_SIZE, DEFAULT_PROBE_COUNT, DEFAULT_SEED } from "../src/corpus.js"
import { FixtureUsageError, parseArgs } from "../src/gen-fixture.js"

/**
 * The operator surface's argument reading.
 *
 * Importing this module runs nothing: the script body sits behind `import.meta.main`, so the parser is
 * reachable without generating a corpus as a side effect of the import.
 */

describe("parseArgs", () => {
  it("defaults every flag, so `gen:fixture` with no arguments is the default corpus", () => {
    expect(parseArgs([])).toEqual({
      seed: DEFAULT_SEED,
      size: DEFAULT_CORPUS_SIZE,
      probes: DEFAULT_PROBE_COUNT,
      dryRun: false
    })
  })

  it("reads both spellings of a flag", () => {
    expect(parseArgs(["--seed", "7", "--size=25", "--dry-run"])).toEqual({
      seed: 7,
      size: 25,
      probes: DEFAULT_PROBE_COUNT,
      dryRun: true
    })
  })

  it("carries `--now` through, since a report names the anchor it was built at", () => {
    const anchor = Date.UTC(2026, 7, 24)
    expect(parseArgs([`--now=${anchor}`]).now).toBe(anchor)
    // Absent is not zero: absent means the fixture reads the clock.
    expect(parseArgs([]).now).toBeUndefined()
  })

  it("refuses a non-integer flag instead of falling back to the default", () => {
    /**
     * Two defects in one refusal. A silent fallback generates a corpus the operator did not ask for,
     * and for `--now` there is no fallback at all: `Number.parseInt("abc")` is `NaN`, which reaches
     * the stamp formatter as `RangeError: Invalid time value` — an error naming neither the flag nor
     * the value. `parseInt` also reads `12abc` as 12, which the same guard refuses.
     */
    for (const argv of [["--now=abc"], ["--now", "abc"], ["--seed=x"], ["--size=12abc"]]) {
      expect(() => parseArgs(argv)).toThrow(FixtureUsageError)
    }
    // The message names the flag and quotes the value it was handed.
    expect(() => parseArgs(["--probes=1.5"])).toThrow(/--probes takes an integer, received "1\.5"/)
  })
})
