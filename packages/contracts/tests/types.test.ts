import { Schema } from "effect"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  isPersonEntity,
  isTaskStatus,
  isWritableMemoryType,
  MEMORY_TYPES,
  MemoryType,
  normalizeEntityName,
  normalizeEntityRef,
  PARA_BUCKETS,
  parseEntity,
  TASK_STATUSES,
  TaskStatus,
  WRITABLE_MEMORY_TYPES,
  WritableMemoryType
} from "../src/types.js"

const decodeType = Schema.decodeUnknownSync(MemoryType)
const decodeWritable = Schema.decodeUnknownSync(WritableMemoryType)

describe("memory type vocabulary", () => {
  it("names ten distinct types", () => {
    expect(MEMORY_TYPES).toHaveLength(10)
    expect(new Set(MEMORY_TYPES).size).toBe(10)
  })

  it("carries task as one axis with the other nine, not a parallel kind", () => {
    // The design decision, pinned: a task IS a memory type, so every filter that scopes by type
    // can scope tasks in or out and nothing needs a second column to disagree with.
    expect(MEMORY_TYPES).toContain("task")
  })

  it("exposes nine to a writer, withholding only arc", () => {
    expect(WRITABLE_MEMORY_TYPES).toHaveLength(9)
    expect(WRITABLE_MEMORY_TYPES).not.toContain("arc")
    expect(WRITABLE_MEMORY_TYPES).toContain("task")
    expect(new Set([...WRITABLE_MEMORY_TYPES, "arc"])).toEqual(new Set(MEMORY_TYPES))
  })

  it("agrees between the runtime filter and the restated writable schema", () => {
    /**
     * `WRITABLE_MEMORY_TYPES` is derived by a filter and `WritableMemoryType` restates the same
     * values literally, because a schema built from a filtered array loses its literal type. Two
     * statements of one vocabulary can disagree, so the agreement is asserted rather than assumed:
     * a type added to one and not the other would make the tool enum and the guard describe
     * different sets.
     */
    for (const type of WRITABLE_MEMORY_TYPES) {
      expect(decodeWritable(type)).toBe(type)
    }
  })

  it("decodes every vocabulary member and rejects everything else", () => {
    for (const type of MEMORY_TYPES) {
      expect(decodeType(type)).toBe(type)
    }
    expect(() => decodeType("insight")).toThrow()
    expect(() => decodeType("")).toThrow()
  })

  it("refuses arc at the writable boundary, in the schema and the guard alike", () => {
    expect(() => decodeWritable("arc")).toThrow()
    expect(isWritableMemoryType("arc")).toBe(false)
  })

  it("agrees between the guard and the writable list on every type", () => {
    for (const type of MEMORY_TYPES) {
      expect(isWritableMemoryType(type)).toBe(
        (WRITABLE_MEMORY_TYPES as ReadonlyArray<string>).includes(type)
      )
    }
  })
})

describe("task status vocabulary", () => {
  const decodeTaskStatus = Schema.decodeUnknownSync(TaskStatus)

  it("names exactly the four statuses, in order", () => {
    expect([...TASK_STATUSES]).toEqual(["todo", "doing", "blocked", "done"])
  })

  it("stays disjoint from the memory statuses, which are a different axis", () => {
    // A task's lifecycle and a file's active/archived state are two axes on purpose: every
    // archive/correct/publish path switches on `memhtml-status`, and overloading it would change
    // the meaning of each of them.
    for (const status of TASK_STATUSES) {
      expect(["active", "archived"]).not.toContain(status)
    }
  })

  it("decodes every member and refuses everything else", () => {
    for (const status of TASK_STATUSES) expect(decodeTaskStatus(status)).toBe(status)
    expect(() => decodeTaskStatus("in-progress")).toThrow()
    expect(() => decodeTaskStatus("")).toThrow()
  })

  it("narrows only vocabulary members", () => {
    for (const status of TASK_STATUSES) expect(isTaskStatus(status)).toBe(true)
    expect(isTaskStatus("wip")).toBe(false)
    expect(isTaskStatus("active")).toBe(false)
  })
})

describe("para buckets", () => {
  it("is exactly the four buckets, in order, without duplicates", () => {
    expect(PARA_BUCKETS).toEqual(["projects", "areas", "resources", "archive"])
    expect(new Set(PARA_BUCKETS).size).toBe(4)
  })
})

describe("entity references", () => {
  it("round-trips any type and name through the separator", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,12}$/),
        fc.string({ minLength: 1, maxLength: 30 }),
        (entityType, entityName) => {
          const parsed = parseEntity(`${entityType}:${entityName}`)
          expect(parsed).toEqual({ entityType, entityName })
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("keeps a colon in the name with the name, splitting only on the first", () => {
    expect(parseEntity("url:https://example.com")).toEqual({
      entityType: "url",
      entityName: "https://example.com"
    })
  })

  it("refuses a reference with no separator, an empty type, or an empty name", () => {
    expect(parseEntity("sanju")).toBeUndefined()
    expect(parseEntity(":sanju")).toBeUndefined()
    expect(parseEntity("person:")).toBeUndefined()
    expect(parseEntity("")).toBeUndefined()
  })

  /**
   * The comparison form, in TypeScript.
   *
   * `entity-resolution` uses it to decide which `memhtml-entity` metas to rewrite, so it is the rule
   * that decides what a canonical entity name IS. The two SQL doors fold with `lower()` on both sides
   * instead — a narrower fold, but one that cannot disagree with itself across the JS/SQL seam.
   */
  it("folds case, NFC, and internal whitespace into one comparison form", () => {
    expect(normalizeEntityName("  Checkout   API ")).toBe("checkout api")
    expect(normalizeEntityName("cafe\u0301")).toBe(normalizeEntityName("caf\u00e9"))
  })

  it("is idempotent, so re-normalizing a stored name cannot change it", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const once = normalizeEntityName(raw)
        expect(normalizeEntityName(once)).toBe(once)
      }),
      { numRuns: 1000 }
    )
  })

  it("normalizes BOTH halves of a reference and rejoins them", () => {
    expect(normalizeEntityRef("Service:Checkout-API")).toBe("service:checkout-api")
  })

  it("strips padding around the separator, so spacing is not part of an entity's identity", () => {
    // Each half is trimmed independently, so `PERSON : Sanju` and `person:sanju` are one entity.
    // A hand-authored meta written with spaces around the colon is a spelling, not a new entity.
    expect(normalizeEntityRef("  PERSON : Sanju   Kumar ")).toBe("person:sanju kumar")
    expect(normalizeEntityRef("person:sanju kumar")).toBe("person:sanju kumar")
  })

  it("keeps a separator-less reference separator-less rather than inventing a type", () => {
    // The caller decides what an untyped reference means. Prefixing `unknown:` here would make this
    // function answer a question only the projection is entitled to answer.
    expect(normalizeEntityRef("Checkout-API")).toBe("checkout-api")
    expect(normalizeEntityRef("")).toBe("")
  })

  it("splits a reference on the FIRST colon when normalizing, so a URL name survives", () => {
    expect(normalizeEntityRef("URL:https://Example.com/A")).toBe("url:https://example.com/a")
  })

  it("agrees with parseEntity about where the split is", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z]{1,12}$/),
        fc.stringMatching(/^[A-Za-z0-9-]{1,20}$/),
        (entityType, entityName) => {
          const parsed = parseEntity(normalizeEntityRef(`${entityType}:${entityName}`))
          expect(parsed).toEqual({
            entityType: normalizeEntityName(entityType),
            entityName: normalizeEntityName(entityName)
          })
        }
      ),
      { numRuns: 500 }
    )
  })

  it("recognizes a person only when the prefix carries a name", () => {
    expect(isPersonEntity("person:sanju")).toBe(true)
    expect(isPersonEntity("person:")).toBe(false)
    expect(isPersonEntity("service:checkout-api")).toBe(false)
  })

  it("refuses a whitespace-only name, the boundary the person-file phase filters on", () => {
    // `person-links` keys on `entity_name.trim() !== ""`, so a name that is only whitespace never
    // gets a person file. Reading it as a person here would route memories at a file nothing mints.
    expect(isPersonEntity("person: ")).toBe(false)
    expect(isPersonEntity("person:   ")).toBe(false)
    expect(isPersonEntity("person:\t")).toBe(false)
    expect(isPersonEntity("person:\n")).toBe(false)
    // A name with surrounding whitespace is still a name.
    expect(isPersonEntity("person: sanju ")).toBe(true)
  })
})
