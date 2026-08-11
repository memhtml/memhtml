import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  ARCS_DIR,
  archivePathFor,
  archiveYearOf,
  INBOX_DIR,
  isArchivePath,
  isValidMemoryPath,
  memoryPathFor,
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

const placement = fc.record<PlacementInput>({
  memoryType: fc.constantFrom(...MEMORY_TYPES),
  entities: fc.array(
    fc.oneof(
      fc.constant("person:sanju"),
      fc.constant("service:checkout-api"),
      segment.map((s) => `tool:${s}`)
    ),
    { maxLength: 3 }
  ),
  workspace: fc.oneof(fc.constant(""), segment),
  tags: fc.array(fc.oneof(fc.constant(""), segment), { maxLength: 3 })
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

  it("routes a person's semantic memory to the people directory", () => {
    expect(placementFor({ memoryType: "semantic", entities: ["person:sanju"] })).toBe(PEOPLE_DIR)
  })

  it("keeps a person's episodic memory out of the people directory: rule 3 is semantic-only", () => {
    expect(placementFor({ memoryType: "episodic", entities: ["person:sanju"] })).toBe(INBOX_DIR)
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
