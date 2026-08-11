import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  ARC_BODY_BUDGET,
  budgetFor,
  type DisclosureCandidate,
  foldDisclosure,
  MAX_PER_ENTITY,
  MEMORY_BODY_BUDGET
} from "../src/disclosure.js"

/** A candidate whose body is exactly `length` characters, so budget arithmetic is exact. */
const candidate = (
  path: string,
  length: number,
  entityNames: ReadonlyArray<string> = [],
  memoryType = "semantic"
): DisclosureCandidate => ({
  path,
  title: `Title ${path}`,
  gist: `Claim about ${path}`,
  memoryType,
  disclosureText: "x".repeat(length),
  entityNames
})

describe("the envelopes", () => {
  it("gives an arc the larger envelope and everything else the shared one", () => {
    expect(budgetFor("arc")).toBe(ARC_BODY_BUDGET)
    expect(ARC_BODY_BUDGET).toBe(9_000)
    for (const type of ["semantic", "episodic", "procedural", "precedent"]) {
      expect(budgetFor(type)).toBe(MEMORY_BODY_BUDGET)
    }
    expect(MEMORY_BODY_BUDGET).toBe(16_000)
  })

  it("caps full quotes at two per entity name", () => {
    expect(MAX_PER_ENTITY).toBe(2)
  })
})

describe("foldDisclosure", () => {
  it("quotes everything that fits, in rank order", () => {
    const fold = foldDisclosure([candidate("a", 10), candidate("b", 10), candidate("c", 10)], 100)
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a", "b", "c"])
    expect(fold.indexLines).toEqual([])
    expect(fold.spentChars).toBe(30)
    expect(fold.truncated).toBe(false)
  })

  it("never exceeds the budget", () => {
    const fold = foldDisclosure([candidate("a", 60), candidate("b", 60)], 100)
    expect(fold.spentChars).toBeLessThanOrEqual(100)
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a"])
    expect(fold.indexLines.map((line) => line.path)).toEqual(["b"])
    expect(fold.truncated).toBe(true)
  })

  it("keeps folding past an overflow, so a long entry does not truncate every shorter one after it", () => {
    const fold = foldDisclosure(
      [candidate("a", 10), candidate("big", 500), candidate("c", 10)],
      100
    )
    // The budget is a character budget, not a position cut-off.
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a", "c"])
    expect(fold.indexLines.map((line) => line.path)).toEqual(["big"])
  })

  it("gives an overflow entry its claim and path, so the agent can drill down deliberately", () => {
    const fold = foldDisclosure([candidate("big", 500)], 100)
    expect(fold.indexLines).toEqual([
      { path: "big", title: "Title big", gist: "Claim about big", memoryType: "semantic" }
    ])
  })

  it("caps full quotes per ENTITY NAME rather than per path", () => {
    const fold = foldDisclosure(
      [
        candidate("a", 10, ["checkout-api"]),
        candidate("b", 10, ["checkout-api"]),
        candidate("c", 10, ["checkout-api"]),
        candidate("d", 10, ["billing"])
      ],
      10_000
    )
    // Twelve memories about one service are twelve paths; per-path would be no cap at all, and one
    // entity's history would fill the budget while every other entity got an index line.
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a", "b", "d"])
    expect(fold.indexLines.map((line) => line.path)).toEqual(["c"])
  })

  it("caps a memory that names ANY already-capped entity", () => {
    const fold = foldDisclosure(
      [
        candidate("a", 10, ["checkout-api"]),
        candidate("b", 10, ["checkout-api"]),
        candidate("c", 10, ["billing", "checkout-api"])
      ],
      10_000
    )
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a", "b"])
    expect(fold.indexLines.map((line) => line.path)).toEqual(["c"])
  })

  it("counts a multi-entity quote against every entity it names", () => {
    const fold = foldDisclosure(
      [
        candidate("a", 10, ["x", "y"]),
        candidate("b", 10, ["x"]),
        candidate("c", 10, ["y"]),
        candidate("d", 10, ["y"])
      ],
      10_000
    )
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a", "b", "c"])
    expect(fold.indexLines.map((line) => line.path)).toEqual(["d"])
  })

  it("counts a memory once per entity name even when it claims that name twice", () => {
    // Reachable, not hypothetical: `file_entities` is keyed on `(type, name)` while the cap is keyed
    // on the name alone, so `person:sanju` plus `concept:sanju` reach the fold as ["sanju", "sanju"].
    // Counting both would let ONE memory exhaust a cap of two by itself and push every other memory
    // about that person into an index line.
    const fold = foldDisclosure(
      [candidate("a", 10, ["sanju", "sanju"]), candidate("b", 10, ["sanju"])],
      10_000
    )
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a", "b"])
    expect(fold.indexLines).toEqual([])
  })

  it("still caps at two distinct memories naming that same doubled name", () => {
    const fold = foldDisclosure(
      [
        candidate("a", 10, ["sanju", "sanju"]),
        candidate("b", 10, ["sanju"]),
        candidate("c", 10, ["sanju"])
      ],
      10_000
    )
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a", "b"])
    expect(fold.indexLines.map((line) => line.path)).toEqual(["c"])
  })

  it("does not cap a memory that names no entity", () => {
    const fold = foldDisclosure(
      [candidate("a", 10), candidate("b", 10), candidate("c", 10), candidate("d", 10)],
      10_000
    )
    expect(fold.disclosed).toHaveLength(4)
  })

  it("returns an empty fold for no candidates", () => {
    expect(foldDisclosure([], 1_000)).toEqual({
      disclosed: [],
      indexLines: [],
      spentChars: 0,
      truncated: false
    })
  })

  it("turns everything into an index line under a zero budget", () => {
    const fold = foldDisclosure([candidate("a", 1)], 0)
    expect(fold.disclosed).toEqual([])
    expect(fold.indexLines.map((line) => line.path)).toEqual(["a"])
    expect(fold.spentChars).toBe(0)
  })

  it("quotes an empty body without spending budget", () => {
    const fold = foldDisclosure([candidate("a", 0)], 0)
    // A memory whose disclosure text is empty still counts as disclosed: the entry itself is the
    // information, and forcing it into an index line would hide a real result behind a pointer.
    expect(fold.disclosed.map((entry) => entry.path)).toEqual(["a"])
  })
})

describe("foldDisclosure properties", () => {
  /**
   * Paths are unique by construction, from the generated offset. A duplicate path is not a state the
   * fold can receive — its input is a fused result set keyed on `files.path`, which is the primary
   * key — and generating one would make "preserves rank order" untestable rather than stronger, since
   * two identical paths have no single position to preserve.
   *
   * Entity names are drawn from a THREE-value alphabet with repetition allowed, which is what makes
   * the per-entity cap actually bite: a wide alphabet would almost never produce a collision, and the
   * cap property would pass against a fold that had no cap at all.
   */
  const candidatesArb = fc
    .array(
      fc.tuple(
        fc.integer({ min: 0, max: 200 }),
        fc.array(fc.constantFrom("x", "y", "z"), { maxLength: 3 })
      ),
      { maxLength: 30 }
    )
    .map((entries) =>
      entries.map(([length, entities], offset) => candidate(`p${offset}`, length, entities))
    )

  it("partitions the input: every candidate is disclosed or index-lined, never both, never lost", () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 2_000 }), (candidates, budget) => {
        const fold = foldDisclosure(candidates, budget)
        const disclosed = fold.disclosed.map((entry) => entry.path)
        const lines = fold.indexLines.map((line) => line.path)
        expect(disclosed.length + lines.length).toBe(candidates.length)
        expect([...disclosed, ...lines].sort()).toEqual(
          candidates.map((entry) => entry.path).sort()
        )
      }),
      { numRuns: 300 }
    )
  })

  it("never spends more than the budget", () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 2_000 }), (candidates, budget) => {
        expect(foldDisclosure(candidates, budget).spentChars).toBeLessThanOrEqual(budget)
      }),
      { numRuns: 300 }
    )
  })

  it("spends exactly the sum of what it quoted", () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 2_000 }), (candidates, budget) => {
        const fold = foldDisclosure(candidates, budget)
        const summed = fold.disclosed.reduce((total, entry) => total + entry.body.length, 0)
        expect(fold.spentChars).toBe(summed)
      }),
      { numRuns: 300 }
    )
  })

  it("reports truncated exactly when something became an index line", () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 2_000 }), (candidates, budget) => {
        const fold = foldDisclosure(candidates, budget)
        expect(fold.truncated).toBe(fold.indexLines.length > 0)
      }),
      { numRuns: 300 }
    )
  })

  it("preserves rank order within each output", () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 2_000 }), (candidates, budget) => {
        const fold = foldDisclosure(candidates, budget)
        const positions = new Map(candidates.map((entry, offset) => [entry.path, offset]))
        for (const output of [
          fold.disclosed.map((entry) => entry.path),
          fold.indexLines.map((line) => line.path)
        ]) {
          const ranks = output.map((path) => positions.get(path) ?? -1)
          expect([...ranks].sort((left, right) => left - right)).toEqual(ranks)
        }
      }),
      { numRuns: 300 }
    )
  })

  it("never quotes more than maxPerEntity memories naming one entity", () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 1, max: 4 }), (candidates, cap) => {
        const fold = foldDisclosure(candidates, 1_000_000, cap)
        const counts = new Map<string, number>()
        for (const entry of fold.disclosed) {
          const source = candidates.find((one) => one.path === entry.path)
          // Deduplicated per memory, matching the fold: the cap counts MEMORIES per name, so one
          // memory claiming a name twice is one memory. `file_entities` is keyed on `(type, name)`
          // while the cap is keyed on the name alone, so `person:sanju` plus `concept:sanju` is a
          // real input.
          for (const name of new Set(source?.entityNames ?? [])) {
            counts.set(name, (counts.get(name) ?? 0) + 1)
          }
        }
        for (const count of counts.values()) expect(count).toBeLessThanOrEqual(cap)
      }),
      { numRuns: 300 }
    )
  })
})
