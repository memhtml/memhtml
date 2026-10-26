import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  ARCS_DIR,
  archiveGenerationOf,
  archivePathFor,
  archiveSlotFor,
  archiveYearOf,
  compareArchivings,
  INBOX_DIR,
  isArchivePath,
  isValidMemoryPath,
  memoryPathFor,
  memoryPathViolation,
  normalizePath,
  originalPathFor,
  PEOPLE_DIR,
  type PlacementInput,
  paraBucketOf,
  placementFor,
  TASKS_SUBDIR
} from "../src/paths.js"
import { MEMORY_TYPES, PARA_BUCKETS } from "../src/types.js"

/** A path segment that survives slugification unchanged, so a round-trip is exact. */
const segment = fc.stringMatching(/^[a-z0-9]+(-[a-z0-9]+)*$/).filter((s) => s.length <= 40)

const memoryPath = fc
  .tuple(
    fc.constantFrom(...PARA_BUCKETS),
    fc.array(segment, { minLength: 0, maxLength: 3 }),
    segment
  )
  .map(([bucket, dirs, stem]) => [bucket, ...dirs, `${stem}.html`].join("/"))

const year = fc.integer({ min: 1970, max: 9999 })

describe("normalizePath", () => {
  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normalizePath(raw)
        expect(normalizePath(once)).toBe(once)
      }),
      { numRuns: 1000 }
    )
  })

  it("accepts the document-reference form callers read out of a link href", () => {
    expect(normalizePath("/areas/arcs/x.html")).toBe("areas/arcs/x.html")
    expect(normalizePath("areas//arcs///x.html")).toBe("areas/arcs/x.html")
    expect(normalizePath("areas/arcs/")).toBe("areas/arcs")
  })

  it("stays linear on a long slash run, so no caller can stall the write path", () => {
    /**
     * A cost-curve assertion rather than a correctness one, because the defect this locks is
     * invisible to output: every implementation here returns the same string, and only one of them
     * takes three seconds to do it.
     *
     * `/\/+$/` — the obvious way to strip a trailing slash — is quadratic on a long slash run
     * followed by a non-slash. Measured 2026-08-18 on the shape below: 4 ms, 57 ms, 769 ms,
     * 3049 ms at n = 2k, 8k, 32k, 64k. The version that ships does not use it, and this fails if
     * anyone reintroduces it, whether directly or by reordering the collapse that used to be the
     * only thing keeping the input away from it.
     *
     * The bound is generous on purpose. A quadratic implementation exceeds it by three orders of
     * magnitude at n = 64k, so the gap between pass and fail is not a matter of a loaded machine —
     * which is what lets a timing assertion be a blocking test rather than a flake.
     */
    const adversarial = `a/${"/".repeat(64_000)}a`
    // Correct first: the guard is worthless if it locks the cost of a wrong answer.
    expect(normalizePath(adversarial)).toBe("a/a")

    const started = process.hrtime.bigint()
    for (let i = 0; i < 20; i++) normalizePath(adversarial)
    const perCallMs = Number(process.hrtime.bigint() - started) / 20e6
    expect(
      perCallMs,
      `normalizePath took ${perCallMs.toFixed(1)}ms on a 64k slash run`
    ).toBeLessThan(50)
  })
})

describe("archive path algebra", () => {
  it("originalPathFor inverts archivePathFor for every path and year", () => {
    fc.assert(
      fc.property(memoryPath, year, (path, y) => {
        expect(originalPathFor(archivePathFor(path, y))).toBe(path)
      }),
      { numRuns: 1000 }
    )
  })

  it("recovers the year it was archived under", () => {
    fc.assert(
      fc.property(memoryPath, year, (path, y) => {
        expect(archiveYearOf(archivePathFor(path, y))).toBe(y)
      }),
      { numRuns: 1000 }
    )
  })

  it("is injective: two distinct (path, year) pairs never collide", () => {
    fc.assert(
      fc.property(memoryPath, memoryPath, year, year, (a, b, ya, yb) => {
        if (a === b && ya === yb) return
        expect(archivePathFor(a, ya)).not.toBe(archivePathFor(b, yb))
      }),
      { numRuns: 1000 }
    )
  })

  it("strips exactly one archive prefix, so a twice-archived path unwraps one layer", () => {
    const once = archivePathFor("areas/oncall/a.html", 2026)
    const twice = archivePathFor(once, 2027)
    expect(originalPathFor(twice)).toBe(once)
    expect(originalPathFor(once)).toBe("areas/oncall/a.html")
  })

  it("reports a non-archive path as such rather than guessing", () => {
    expect(originalPathFor("areas/oncall/a.html")).toBeUndefined()
    expect(originalPathFor("archive/areas/a.html")).toBeUndefined()
    expect(isArchivePath("areas/oncall/a.html")).toBe(false)
    expect(archiveYearOf("areas/oncall/a.html")).toBeUndefined()
  })

  it("lands every archived path in the archive bucket", () => {
    fc.assert(
      fc.property(memoryPath, year, (path, y) => {
        const archived = archivePathFor(path, y)
        expect(paraBucketOf(archived)).toBe("archive")
        expect(isValidMemoryPath(archived)).toBe(true)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("archive generation slots", () => {
  const generation = fc.integer({ min: 1, max: 10_000 })

  it("reads a generation slot as the same year's archive of the same path", () => {
    expect(originalPathFor("archive/2031.2/a/b.html")).toBe("a/b.html")
    expect(archiveYearOf("archive/2031.2/a/b.html")).toBe(2031)
    expect(isArchivePath("archive/2031.2/a/b.html")).toBe(true)
    expect(archiveGenerationOf("archive/2031.2/a/b.html")).toBe(2)
    expect(archiveGenerationOf("archive/2031/a/b.html")).toBe(1)
    expect(archiveGenerationOf("areas/inbox/a.html")).toBeUndefined()
  })

  it("spells generation one as the bare year and every later one as <YYYY>.<n>", () => {
    expect(archivePathFor("areas/inbox/a.html", 2031, 1)).toBe("archive/2031/areas/inbox/a.html")
    expect(archivePathFor("areas/inbox/a.html", 2031, 2)).toBe("archive/2031.2/areas/inbox/a.html")
    expect(archivePathFor("areas/inbox/a.html", 2031, 12)).toBe(
      "archive/2031.12/areas/inbox/a.html"
    )
  })

  it("inverts archivePathFor for every path, year, and generation", () => {
    fc.assert(
      fc.property(memoryPath, year, generation, (path, y, n) => {
        const slot = archivePathFor(path, y, n)
        expect(originalPathFor(slot)).toBe(path)
        expect(archiveYearOf(slot)).toBe(y)
        expect(archiveGenerationOf(slot)).toBe(n)
        expect(paraBucketOf(slot)).toBe("archive")
        expect(isValidMemoryPath(slot)).toBe(true)
      }),
      { numRuns: 1000 }
    )
  })

  it("is injective over (path, year, generation), so no two archivings share a slot", () => {
    fc.assert(
      fc.property(
        memoryPath,
        memoryPath,
        year,
        year,
        generation,
        generation,
        (a, b, ya, yb, na, nb) => {
          if (a === b && ya === yb && na === nb) return
          expect(archivePathFor(a, ya, na)).not.toBe(archivePathFor(b, yb, nb))
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("gives each slot one spelling: a .0, .1, or zero-padded generation is not an archive path", () => {
    for (const path of [
      "archive/2031.0/a/b.html",
      "archive/2031.1/a/b.html",
      "archive/2031.02/a/b.html",
      "archive/2031./a/b.html"
    ]) {
      expect(originalPathFor(path), path).toBeUndefined()
      expect(archiveYearOf(path), path).toBeUndefined()
      expect(archiveGenerationOf(path), path).toBeUndefined()
    }
  })

  it("archiveSlotFor names the first generation of the year that no record holds", () => {
    const path = "resources/acme-widget/b.html"
    expect(archiveSlotFor(path, 2031, () => false)).toBe(
      "archive/2031/resources/acme-widget/b.html"
    )
    const held = new Set([
      "archive/2031/resources/acme-widget/b.html",
      "archive/2031.2/resources/acme-widget/b.html"
    ])
    expect(archiveSlotFor(path, 2031, (slot) => held.has(slot))).toBe(
      "archive/2031.3/resources/acme-widget/b.html"
    )
    // Another year's slots, and another path's, do not count against this one.
    const elsewhere = new Set([
      "archive/2030/resources/acme-widget/b.html",
      "archive/2031/resources/acme-widget/c.html"
    ])
    expect(archiveSlotFor(path, 2031, (slot) => elsewhere.has(slot))).toBe(
      "archive/2031/resources/acme-widget/b.html"
    )
  })

  it("archiveSlotFor never answers a held slot, and always one that maps back to the path", () => {
    fc.assert(
      fc.property(memoryPath, year, fc.array(generation, { maxLength: 8 }), (path, y, taken) => {
        const held = new Set(taken.map((n) => archivePathFor(path, y, n)))
        const slot = archiveSlotFor(path, y, (candidate) => held.has(candidate))
        expect(held.has(slot)).toBe(false)
        expect(originalPathFor(slot)).toBe(path)
        expect(archiveYearOf(slot)).toBe(y)
      }),
      { numRuns: 500 }
    )
  })

  it("compareArchivings orders a path's archivings by year, then generation, as numbers", () => {
    const path = "areas/inbox/a-fact.html"
    // String order would put .10 before .9, and every generation before its own bare year.
    expect(
      compareArchivings(archivePathFor(path, 2031, 10), archivePathFor(path, 2031, 9))
    ).toBeGreaterThan(0)
    expect(
      compareArchivings(archivePathFor(path, 2031, 2), archivePathFor(path, 2031, 1))
    ).toBeGreaterThan(0)
    expect(
      compareArchivings(archivePathFor(path, 2031, 1), archivePathFor(path, 2030, 9))
    ).toBeGreaterThan(0)
    expect(compareArchivings(archivePathFor(path, 2031, 3), archivePathFor(path, 2031, 3))).toBe(0)
    expect(compareArchivings(path, archivePathFor(path, 2031, 1))).toBeLessThan(0)
    fc.assert(
      fc.property(
        memoryPath,
        fc.array(fc.tuple(year, generation), { minLength: 1, maxLength: 12 }),
        (p, slots) => {
          const sorted = slots
            .map(([y, n]) => archivePathFor(p, y, n))
            .sort(compareArchivings)
            .map((slot) => [archiveYearOf(slot) ?? 0, archiveGenerationOf(slot) ?? 0] as const)
          const expected = [...slots].sort(([ya, na], [yb, nb]) => ya - yb || na - nb)
          expect(sorted).toEqual(expected)
        }
      ),
      { numRuns: 500 }
    )
  })
})

describe("isValidMemoryPath", () => {
  it("accepts a bucket-rooted html path", () => {
    fc.assert(
      fc.property(memoryPath, (path) => {
        expect(isValidMemoryPath(path)).toBe(true)
      }),
      { numRuns: 1000 }
    )
  })

  it("refuses a path outside the buckets, without an extension, or carrying traversal", () => {
    expect(isValidMemoryPath("notes/a.html")).toBe(false)
    expect(isValidMemoryPath("areas/a.md")).toBe(false)
    expect(isValidMemoryPath("areas")).toBe(false)
    expect(isValidMemoryPath("areas/../../etc/passwd.html")).toBe(false)
    expect(isValidMemoryPath("areas/./a.html")).toBe(false)
    expect(isValidMemoryPath("")).toBe(false)
  })
})

describe("memoryPathViolation", () => {
  it("agrees with isValidMemoryPath on every path, in both directions", () => {
    /**
     * The invariant that makes one of them the rule and the other a phrasing of it. A refusal that
     * quoted a reason for a path the predicate accepts would refuse a usable path, and a predicate
     * that rejected a path with no reason would refuse one with nothing to tell the caller.
     */
    fc.assert(
      fc.property(fc.oneof(memoryPath, fc.string()), (path) => {
        expect(memoryPathViolation(path) === undefined).toBe(isValidMemoryPath(path))
      }),
      { numRuns: 1000 }
    )
  })

  it("names the clause a path broke, one clause at a time", () => {
    // Each case violates exactly one clause, so a reason that named the wrong one fails here rather
    // than reading as plausible. A caller holding the string has to be able to fix the input from it.
    expect(memoryPathViolation("notes/a.html")).toContain("PARA bucket")
    expect(memoryPathViolation("areas/a.md")).toContain(".html")
    expect(memoryPathViolation("areas/../etc/passwd.html")).toContain("`..`")
    expect(memoryPathViolation("areas/./a.html")).toContain("`.`")
    // A bare bucket is not rooted IN one: `paraBucketOf` needs a `/` past the head, so `areas` and
    // `areas/` both land on the first clause rather than on a clause of their own.
    expect(memoryPathViolation("areas")).toContain("PARA bucket")
    expect(memoryPathViolation("areas/")).toContain("PARA bucket")
  })

  it("says nothing about a usable path", () => {
    expect(memoryPathViolation("areas/oncall/rollback.html")).toBeUndefined()
  })
})

const placement = fc.record<PlacementInput>({
  memoryType: fc.constantFrom(...MEMORY_TYPES),
  entities: fc.array(
    fc.oneof(
      fc.constant("person:sasha"),
      fc.constant("service:checkout-api"),
      segment.map((s) => `tool:${s}`)
    ),
    { maxLength: 3 }
  ),
  workspace: fc.oneof(fc.constant(""), segment),
  tags: fc.array(fc.oneof(fc.constant(""), fc.constant("People"), segment), { maxLength: 3 })
})

describe("placementFor", () => {
  it("is total and always yields a directory rooted in a PARA bucket", () => {
    fc.assert(
      fc.property(placement, (input) => {
        const directory = placementFor(input)
        expect(directory.length).toBeGreaterThan(0)
        expect(paraBucketOf(`${directory}/x.html`)).toBeDefined()
        expect(isValidMemoryPath(`${directory}/x.html`)).toBe(true)
      }),
      { numRuns: 1000 }
    )
  })

  it("honors an explicit valid path above every other rule", () => {
    expect(
      placementFor({ path: "projects/memhtml/a.html", memoryType: "arc", workspace: "other" })
    ).toBe("projects/memhtml")
  })

  it("re-derives rather than propagates an unusable explicit path", () => {
    expect(placementFor({ path: "../../etc/passwd.html", memoryType: "arc" })).toBe(ARCS_DIR)
    expect(placementFor({ path: "notes/a.txt", memoryType: "episodic" })).toBe(INBOX_DIR)
  })

  it("routes an arc to areas/arcs regardless of workspace or entities", () => {
    fc.assert(
      fc.property(placement, (input) => {
        expect(placementFor({ ...input, path: undefined, memoryType: "arc" })).toBe(ARCS_DIR)
      }),
      { numRuns: 1000 }
    )
  })

  it("never routes into the people directory by entity: a person record is curation's, at an explicit path", () => {
    // A fact that names a person files where its other fields send it (2026-09-28): inside a run
    // resources/people/ is reserved, so routing there refused every fleet fact about a colleague.
    expect(placementFor({ memoryType: "semantic", entities: ["person:sasha"] })).toBe(INBOX_DIR)
    expect(
      placementFor({ memoryType: "semantic", entities: ["person:laura", "project:agent-runtime"] })
    ).toBe(INBOX_DIR)
    expect(
      placementFor({
        memoryType: "semantic",
        entities: ["person:laura"],
        workspace: "agent-runtime"
      })
    ).toBe("projects/agent-runtime")
    expect(
      placementFor({ memoryType: "semantic", entities: ["person:laura"], tags: ["reviews"] })
    ).toBe("resources/reviews")
    expect(placementFor({ memoryType: "episodic", entities: ["person:sasha"] })).toBe(INBOX_DIR)
    // Nor by a tag that slugs to the plane's own name.
    expect(placementFor({ memoryType: "semantic", tags: ["People"] })).toBe(INBOX_DIR)
  })

  it("places a person record only where its explicit path says", () => {
    expect(
      placementFor({
        path: `${PEOPLE_DIR}/sasha.html`,
        memoryType: "semantic",
        entities: ["person:sasha"]
      })
    ).toBe(PEOPLE_DIR)
  })

  it("no generated input lands in the people directory without a path naming it", () => {
    fc.assert(
      fc.property(placement, (input) => {
        const dir = placementFor({ ...input, path: undefined })
        expect(dir === PEOPLE_DIR || dir.startsWith(`${PEOPLE_DIR}/`)).toBe(false)
      }),
      { numRuns: 1000 }
    )
  })

  it("prefers a workspace over a topic directory", () => {
    expect(placementFor({ memoryType: "semantic", workspace: "Memhtml", tags: ["deploy"] })).toBe(
      "projects/memhtml"
    )
  })

  it("routes a timeless type with a tag but no workspace to a topic directory", () => {
    for (const type of ["semantic", "procedural", "precedent"]) {
      expect(placementFor({ memoryType: type, tags: ["Deploy Order"] })).toBe(
        "resources/deploy-order"
      )
    }
  })

  it("skips an empty tag when picking the primary one", () => {
    expect(placementFor({ memoryType: "semantic", tags: ["", "  ", "oncall"] })).toBe(
      "resources/oncall"
    )
  })

  it("falls through to the inbox when no rule claims the memory", () => {
    expect(placementFor({ memoryType: "verdict" })).toBe(INBOX_DIR)
    expect(placementFor({ memoryType: "semantic", tags: [] })).toBe(INBOX_DIR)
  })

  it("routes a task under its workspace's tasks directory, or the inbox's", () => {
    expect(placementFor({ memoryType: "task", workspace: "Memhtml" })).toBe(
      `projects/memhtml/${TASKS_SUBDIR}`
    )
    expect(placementFor({ memoryType: "task" })).toBe(`${INBOX_DIR}/${TASKS_SUBDIR}`)
    expect(placementFor({ memoryType: "task", workspace: "" })).toBe(`${INBOX_DIR}/${TASKS_SUBDIR}`)
  })

  it("keeps a task out of the people and topic directories, whatever it names", () => {
    /**
     * The rule sits ABOVE the person and tag rules, and that ordering is the assertion: a task
     * about a person is working state, and routing it into `resources/people/` would put a to-do
     * item in the durable identity surface a human hand-edits.
     */
    fc.assert(
      fc.property(placement, (input) => {
        const directory = placementFor({ ...input, path: undefined, memoryType: "task" })
        expect(directory.endsWith(`/${TASKS_SUBDIR}`)).toBe(true)
        expect(directory.startsWith(PEOPLE_DIR)).toBe(false)
        expect(directory.startsWith("resources/")).toBe(false)
      }),
      { numRuns: 1000 }
    )
  })

  it("keeps every task directory a valid memory path root", () => {
    for (const workspace of ["", "memhtml", "Some Workspace"]) {
      const directory = placementFor({ memoryType: "task", workspace })
      expect(isValidMemoryPath(`${directory}/t.html`)).toBe(true)
      expect(paraBucketOf(`${directory}/t.html`)).toBeDefined()
    }
  })
})

describe("memoryPathFor", () => {
  const at = new Date("2026-08-02T14:03:11Z")

  it("date-prefixes an episodic filename and only an episodic one", () => {
    expect(memoryPathFor({ memoryType: "episodic", title: "VIP drain before rollback", at })).toBe(
      "areas/inbox/20260802-vip-drain-before-rollback.html"
    )
    expect(
      memoryPathFor({
        memoryType: "procedural",
        title: "VIP drain before rollback",
        tags: ["x"],
        at
      })
    ).toBe("resources/x/vip-drain-before-rollback.html")
  })

  it("always produces a valid memory path", () => {
    fc.assert(
      fc.property(placement, fc.string({ maxLength: 120 }), (input, title) => {
        expect(isValidMemoryPath(memoryPathFor({ ...input, title, at }))).toBe(true)
      }),
      { numRuns: 1000 }
    )
  })
})
