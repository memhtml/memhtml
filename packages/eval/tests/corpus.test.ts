import { contentHash } from "@memhtml/html"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"

import { buildCorpus, DEFAULT_PROBE_COUNT, quantizeNow, queryFor } from "../src/corpus.js"
import { makeFixtureCorpus, memoryFileFor } from "../src/fixture.js"

/**
 * The corpus generator's invariants.
 *
 * Four of these are regression locks on defects the discrimination gate itself surfaced on its first
 * run — each one made the gate unable to measure ranking, and each is asserted here so a future edit
 * to the generator fails a test rather than silently moving the gate's numbers.
 */

/**
 * A pinned run instant, so these assertions exercise `(seed, now)` determinism rather than the
 * wall clock. The generator quantizes it to the UTC day; any instant works.
 */
const NOW = Date.UTC(2026, 7, 24, 15, 30, 0)

const spec = buildCorpus({ now: NOW })
const active = spec.memories.filter((memory) => memory.archivedAt === undefined)
const isControl = (path: string): boolean =>
  path.includes("refuted-reading") ||
  path.includes("restated-quantity") ||
  path.includes("qualified-variant")

describe("determinism", () => {
  it("produces byte-identical files for one (seed, now)", () => {
    // The property the gate rests on: a change in the numbers means the RANKING changed, never that
    // the corpus did. Compared as rendered bytes rather than as specs, because bytes are what the
    // indexer reads.
    const again = buildCorpus({ now: NOW })
    expect(again.memories.map(memoryFileFor)).toEqual(spec.memories.map(memoryFileFor))
    expect(again.probes).toEqual(spec.probes)
    expect(again.access).toEqual(spec.access)
  })

  it("produces a different corpus for a different seed", () => {
    // Otherwise the seed is decoration and `--seed` on a failing run reproduces nothing.
    expect(buildCorpus({ seed: 7, now: NOW }).memories.map(memoryFileFor)).not.toEqual(
      spec.memories.map(memoryFileFor)
    )
  })

  it("quantizes the run instant to its UTC day, so one calendar date is one corpus", () => {
    // The gate's determinism checks compare full runs; a millisecond anchor would make "same seed,
    // same numbers" true only for runs started in the same millisecond.
    const morning = buildCorpus({ now: Date.UTC(2026, 7, 24, 0, 0, 1) })
    const evening = buildCorpus({ now: Date.UTC(2026, 7, 24, 23, 59, 59) })
    expect(morning.now).toBe(quantizeNow(NOW))
    expect(evening.memories.map(memoryFileFor)).toEqual(morning.memories.map(memoryFileFor))
    expect(evening.access).toEqual(morning.access)
  })

  it("never quantizes AHEAD of the instant it was given", () => {
    // The whole point of the anchor is that no generated stamp sits in the future, so an anchor
    // ahead of the run instant defeats it from the top. A `%` remainder keeps the dividend's sign,
    // which puts every pre-1970 instant on day 0.
    for (const instant of [NOW, 0, -1, -86_400_001, Date.UTC(1969, 0, 1)]) {
      expect(quantizeNow(instant)).toBeLessThanOrEqual(instant)
      expect(instant - quantizeNow(instant)).toBeLessThan(86_400_000)
      expect(Number.isInteger(quantizeNow(instant) / 86_400_000)).toBe(true)
    }
  })

  it("refuses a non-finite instant instead of carrying it into a stamp", () => {
    // `NaN` passes every arithmetic step and only fails at `toISOString`, as
    // `RangeError: Invalid time value` — an error naming neither the input nor its caller.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => quantizeNow(bad)).toThrow(RangeError)
      expect(() => buildCorpus({ now: bad })).toThrow(/finite epoch-millis/)
    }
  })
})

describe("the default anchor", () => {
  /**
   * `makeFixtureCorpus` is the ONE clock read in this package, and the gate cannot see it: the
   * discrimination suite passes an explicit `now`, and the fold's decay term is numerically inert in
   * this fixture, so replacing the fallback with a fixed epoch leaves every test in the package green
   * and re-introduces a corpus that ages out from under the gate. Two different pinned instants,
   * because one would also be satisfied by a constant.
   */
  const anchorAt = async (pinned: number): Promise<number> => {
    const fixture = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* TestClock.setTime(pinned)
          // Small on purpose: this measures where `now` came from, not what the corpus looks like.
          return yield* makeFixtureCorpus({ size: 12, probes: 2 })
        }),
        TestClock.layer()
      )
    )
    await fixture.cleanup()
    return fixture.spec.now
  }

  it("anchors an unspecified `now` to the run clock", async () => {
    const first = Date.UTC(2026, 2, 9, 18, 45, 12)
    const second = Date.UTC(2027, 10, 2, 4, 5, 6)
    expect(await anchorAt(first)).toBe(quantizeNow(first))
    expect(await anchorAt(second)).toBe(quantizeNow(second))
  }, 60_000)
})

describe("now-anchoring", () => {
  it("keeps every ranked stamp BEHIND the run instant", () => {
    /**
     * The regression this pins: the salience arm decays on `unixepoch('now') - last_accessed_at`
     * at query time, so a stamp AHEAD of the run instant inverts the decay into a boost that grows
     * until the calendar catches up — the same seed then produces different decay, and eventually
     * different ranks, depending on the day the eval runs. Only `validUntil` may sit in the
     * future, because it marks when a memory STOPS being valid and an expired memory is filtered.
     */
    for (const memory of spec.memories) {
      expect(Date.parse(memory.createdAt)).toBeLessThan(spec.now)
      expect(Date.parse(memory.updatedAt)).toBeLessThan(spec.now)
      if (memory.archivedAt !== undefined) {
        expect(Date.parse(memory.archivedAt)).toBeLessThan(spec.now)
      }
    }
    for (const row of spec.access) {
      expect(Date.parse(row.lastAccessedAt)).toBeLessThan(spec.now)
    }
  })

  it("keeps the relative spacing identical across run dates", () => {
    // Decay is a function of (now - stamp), so stable decay across calendar dates means every
    // stamp's DISTANCE behind the anchor is invariant — the corpus slides as one rigid body.
    const later = buildCorpus({ now: NOW + 90 * 86_400_000 })
    const offsets = (corpus: typeof spec): ReadonlyArray<number> =>
      corpus.memories.flatMap((memory) => [
        corpus.now - Date.parse(memory.createdAt),
        corpus.now - Date.parse(memory.updatedAt)
      ])
    expect(offsets(later)).toEqual(offsets(spec))
    expect(later.access.map((row) => later.now - Date.parse(row.lastAccessedAt))).toEqual(
      spec.access.map((row) => spec.now - Date.parse(row.lastAccessedAt))
    )
  })
})

describe("indexability", () => {
  it("gives every ACTIVE memory a distinct content hash", () => {
    /**
     * `files_content_hash_active` is a PARTIAL UNIQUE index, so a collision is not a weak probe — the
     * whole `writeAll` batch fails and the corpus cannot be indexed at all. The hash scope is
     * `<article>` alone, so a distinct title does not help: the first generated corpus had 17
     * colliding pairs at ordinals 180 apart, because the claim cycled on `(topic, type, noun, verb)`
     * while only the title carried the ordinal.
     */
    const hashes = active.map((memory) => contentHash(memoryFileFor(memory)))
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it("gives every memory a distinct path", () => {
    // The path IS the id. Two specs at one path means the second silently overwrites the first on
    // disk, and the probe that names it measures whichever won.
    const paths = spec.memories.map((memory) => memory.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it("gives every non-control memory a distinct claim", () => {
    /**
     * A probe query is DERIVED from its target's claim, so two memories sharing a claim means the
     * query identifies both equally well — the twin outranks the target about half the time and the
     * probe reports an inversion that says nothing about the control it was built to test. Measured
     * on the first generated 200: 20 duplicated claims, the twin at fused rank 1 and the target at 8.
     */
    const claims = active.filter((memory) => !isControl(memory.path)).map((memory) => memory.claim)
    expect(new Set(claims).size).toBe(claims.length)
  })
})

describe("probes", () => {
  it("carries at least the 30 design §5 asks for, each with a control", () => {
    expect(spec.probes.length).toBe(DEFAULT_PROBE_COUNT)
    expect(spec.probes.length).toBeGreaterThanOrEqual(30)
    for (const probe of spec.probes) {
      expect(probe.controlPaths.length).toBeGreaterThan(0)
      expect(probe.controlPaths).toHaveLength(probe.families.length)
    }
  })

  it("exercises all three divergence families across the suite", () => {
    const families = new Set(spec.probes.flatMap((probe) => probe.families))
    expect([...families].sort()).toEqual(["negation", "numeric", "variant"])
  })

  it("names only paths the corpus actually holds", () => {
    // A probe against a path that was never written is a probe whose target can never be returned,
    // which reads as a permanent inversion rather than as a broken fixture.
    const paths = new Set(spec.memories.map((memory) => memory.path))
    for (const probe of spec.probes) {
      expect(paths.has(probe.targetPath)).toBe(true)
      for (const control of probe.controlPaths) expect(paths.has(control)).toBe(true)
    }
  })

  it("spreads targets across the corpus's age range rather than taking the front", () => {
    /**
     * Two of the four arms — recency (w 0.5) and salience (w 0.4), 31% of the fold's weight — are
     * QUERY-BLIND: they rank a fixed window whatever was asked. `base` is generated in ordinal order
     * and `updatedAt` advances with the ordinal, so taking the first N candidates takes the N OLDEST
     * memories and every target falls outside the recency window by construction. Probed directly on
     * the unstrided generator: the recency window held ordinals 157-199 and the targets were 1-155,
     * an overlap of exactly zero.
     *
     * Asserted as a spread of the update stamps rather than of the ordinals, because the stamp is
     * what the arm actually reads.
     */
    const stamps = spec.probes.map((probe) => {
      const memory = spec.memories.find((candidate) => candidate.path === probe.targetPath)
      return Date.parse(memory?.updatedAt ?? "")
    })
    const oldest = Math.min(...stamps)
    const newest = Math.max(...stamps)
    const allStamps = active.map((memory) => Date.parse(memory.updatedAt))
    const corpusSpan = Math.max(...allStamps) - Math.min(...allStamps)
    // The probe targets cover at least half the corpus's age range.
    expect(newest - oldest).toBeGreaterThan(corpusSpan / 2)
  })

  it("keeps the family marker LEADING a control's title, so a tie is not decided against the target", () => {
    /**
     * RRF produces EXACT ties — two documents that swap positions across two equal-weight arms sum
     * identically (measured: 0.03252247 for a target at fts 1/vector 2 and its control at fts
     * 2/vector 1) — and the fold breaks them on `path ASC`. A trailing marker made every control's
     * path an extension of its target's stem, and `-` (0x2D) sorts before `.` (0x2E), so the control
     * won every tie: a systematic loss decided by filename punctuation.
     */
    for (const probe of spec.probes) {
      const stem = probe.targetPath.replace(/\.html$/, "")
      for (const control of probe.controlPaths) {
        expect(control.startsWith(`${stem}-`)).toBe(false)
      }
    }
  })
})

describe("queries", () => {
  it("keeps the digits a numeric control differs by", () => {
    /**
     * A numeric control differs from its target in exactly one numeric token, so a query that dropped
     * the number would have identical overlap with both and the probe would be measuring a tie-break
     * rather than discrimination.
     */
    const numeric = spec.probes.filter((probe) => probe.families.includes("numeric"))
    expect(numeric.length).toBeGreaterThan(0)
    for (const probe of numeric) {
      const memory = spec.memories.find((candidate) => candidate.path === probe.targetPath)
      const digits = memory?.claim.match(/\d+/g) ?? []
      expect(digits.length).toBeGreaterThan(0)
      expect(probe.query).toContain(digits[0] as string)
    }
  })

  it("drops function words, so `not` cannot hide behind them", () => {
    // A query carrying the target's function words would raise the negation control's lexical overlap
    // for a reason unrelated to the fact either states.
    const query = queryFor({
      claim: "Settle the ledger on the gateway before the lane is touched.",
      body: [],
      path: "x",
      title: "x",
      memoryType: "procedural",
      createdAt: "",
      updatedAt: "",
      confidence: 1,
      importance: 5,
      entities: [],
      tags: [],
      links: [],
      extras: []
    })
    expect(query).not.toMatch(/\bthe\b/)
    expect(query).not.toMatch(/\bbefore\b/)
    expect(query).toContain("settle")
    expect(query).toContain("ledger")
  })
})

describe("the format surface", () => {
  it("exercises every element the format gives indexer semantics", () => {
    // A fixture that never emits a `<dl>` cannot show that facets are projected, and the corpus is
    // also the only place `memhtml doctor`'s vocabulary check is exercised against real markup.
    const all = spec.memories.map(memoryFileFor).join("\n")
    for (const element of [
      "<time datetime=",
      "<dl>",
      "<dt>",
      "<dd>",
      "<data value=",
      "<cite>",
      "<q cite=",
      "<dfn>",
      "<figure>",
      "<figcaption>",
      "<details>",
      "<summary>",
      "<aside>",
      "<table>",
      "<caption>",
      "<abbr title=",
      "<section>",
      "<address>"
    ]) {
      expect(all).toContain(element)
    }
  })

  it("keeps every `<mark>` out of an `<aside>` and a `<details>`", () => {
    // Format constraint 5. A violation here would make `parseMemory` fail and the file would be
    // counted as skipped rather than indexed — a corpus quietly smaller than it claims.
    for (const memory of spec.memories) {
      const html = memoryFileFor(memory)
      const mark = html.indexOf("<mark>")
      expect(mark).toBeGreaterThan(-1)
      expect(html.indexOf("<aside>") === -1 || html.indexOf("<aside>") > mark).toBe(true)
      expect(html.indexOf("<details>") === -1 || html.indexOf("<details>") > mark).toBe(true)
    }
  })

  it("writes no authored href that dangles", () => {
    /**
     * `memhtml doctor` reports a dangling href as a finding, so a fixture shipping one would make the
     * "doctor clean on the fixture" criterion unmeetable — and an edge against a path that was never
     * written proves nothing about the edge encoding.
     */
    const paths = new Set(spec.memories.map((memory) => memory.path))
    for (const memory of spec.memories) {
      for (const link of memory.links) {
        expect(paths.has(link.href.replace(/^\//, ""))).toBe(true)
      }
    }
  })

  it("covers all nine memory rels and both person rels", () => {
    const rels = new Set(spec.memories.flatMap((memory) => memory.links.map((link) => link.rel)))
    for (const rel of [
      "memhtml-supersedes",
      "memhtml-contradicts",
      "memhtml-caused-by",
      "memhtml-leads-to",
      "memhtml-part-of",
      "memhtml-relates-to",
      "memhtml-example-of",
      "memhtml-supports",
      "memhtml-laterally-related",
      "memhtml-about-person",
      "memhtml-authored-by"
    ]) {
      expect(rels.has(rel)).toBe(true)
    }
  })
})

describe("the access plane", () => {
  it("gives a control NO access history, ever", () => {
    /**
     * A control is an adversary this test injects; it was never in the corpus and therefore cannot
     * have been retrieved. Giving it history would be inventing evidence that a WRONG FACT had been
     * useful. The exclusion is by ROLE, decided when the control is minted — which is also why the
     * access spread cannot be read as tuning toward the probes.
     */
    const accessed = new Set(spec.access.map((row) => row.path))
    for (const memory of spec.memories) {
      if (isControl(memory.path)) expect(accessed.has(memory.path)).toBe(false)
    }
  })

  it("gives a real share of the corpus history, so the salience arm has signal", () => {
    /**
     * With an empty plane the salience arm scores over a `LEFT JOIN` that matches nothing: every term
     * collapses to a function of `updated_at` and the arm becomes a SECOND recency arm, so 14% of the
     * fold's weight is inert. Probed on the empty-plane corpus: 0 of 36 targets fell inside the
     * salience window and the corpus MRR capped at 0.06.
     */
    const eligible = active.filter((memory) => !isControl(memory.path))
    expect(spec.access.length).toBeGreaterThan(eligible.length * 0.3)
    expect(spec.access.length).toBeLessThan(eligible.length)
  })

  it("names only active, non-archived paths", () => {
    // An archived memory is not a retrieval candidate, so history on one would be a row `memhtml doctor`
    // reports as an orphan the moment the index is rebuilt.
    const activePaths = new Set(active.map((memory) => memory.path))
    for (const row of spec.access) expect(activePaths.has(row.path)).toBe(true)
  })

  it("spreads access counts as a long tail rather than uniformly", () => {
    // A uniform count makes `ln(1 + accessCount)` nearly constant and the term carries no ordering
    // information at all — the arm would fire and rank nothing.
    const counts = spec.access.map((row) => row.accessCount)
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts) * 3)
  })
})
