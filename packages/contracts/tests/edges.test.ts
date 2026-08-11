import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  ALL_RELS,
  EDGE_CLASSES,
  type Edge,
  type EdgeRel,
  isEdgeRel,
  isWellFormedEdge,
  MEMORY_RELS,
  PERSON_RELS,
  PROVENANCE_RELS,
  relClassFor,
  relForToken,
  relsForClass,
  relTokenFor,
  TASK_RELS
} from "../src/edges.js"

const anyRel = fc.constantFrom(...ALL_RELS)

describe("edge vocabularies", () => {
  it("names nine memory rels, two person rels, one provenance rel, and two task rels", () => {
    expect(MEMORY_RELS).toHaveLength(9)
    expect(PERSON_RELS).toEqual(["about_person", "authored_by"])
    expect(PROVENANCE_RELS).toEqual(["from_session"])
    expect(TASK_RELS).toEqual(["blocks", "subtask_of"])
  })

  it("keeps the task rels OUT of the memory class, which is the graph firewall", () => {
    /**
     * The count that matters is `MEMORY_RELS`: every query that may feed PageRank, MMR, or the
     * retention bridge count filters `edge_class = 'memory'`, so a task rel landing in that class
     * would let a to-do list reweight the retention of knowledge. Nine memory rels, unchanged.
     */
    for (const rel of TASK_RELS) {
      expect(MEMORY_RELS as ReadonlyArray<string>).not.toContain(rel)
      expect(relClassFor(rel)).toBe("task")
    }
    expect(MEMORY_RELS).toHaveLength(9)
  })

  it("partitions: every rel belongs to exactly one class", () => {
    expect(ALL_RELS).toHaveLength(14)
    expect(new Set(ALL_RELS).size).toBe(14)
    for (const rel of ALL_RELS) {
      const owners = EDGE_CLASSES.filter((edgeClass) =>
        (relsForClass(edgeClass) as ReadonlyArray<string>).includes(rel)
      )
      expect(owners).toHaveLength(1)
    }
  })

  it("agrees between relClassFor and relsForClass in both directions", () => {
    fc.assert(
      fc.property(anyRel, (rel) => {
        const edgeClass = relClassFor(rel)
        expect(relsForClass(edgeClass)).toContain(rel)
      }),
      { numRuns: 1000 }
    )
  })

  it("narrows only vocabulary members", () => {
    for (const rel of ALL_RELS) {
      expect(isEdgeRel(rel)).toBe(true)
    }
    expect(isEdgeRel("mentions")).toBe(false)
    expect(isEdgeRel("memhtml-supersedes")).toBe(false)
  })
})

describe("link rel tokens", () => {
  it("round-trips every rel through its HTML token", () => {
    fc.assert(
      fc.property(anyRel, (rel) => {
        expect(relForToken(relTokenFor(rel))).toBe(rel)
      }),
      { numRuns: 1000 }
    )
  })

  it("emits a colon-free hyphenated token, since a rel attribute cannot hold a colon", () => {
    for (const rel of ALL_RELS) {
      const token = relTokenFor(rel)
      expect(token).not.toContain(":")
      expect(token).not.toContain("_")
      expect(token).toMatch(/^memhtml-[a-z-]+$/)
    }
  })

  it("refuses a token outside the vocabulary or missing the prefix", () => {
    expect(relForToken("supersedes")).toBeUndefined()
    expect(relForToken("memhtml-mentions")).toBeUndefined()
    expect(relForToken("memhtml-")).toBeUndefined()
    expect(relForToken("")).toBeUndefined()
  })
})

const edge = (over: Partial<Edge> & { readonly rel: EdgeRel }): Edge => ({
  srcPath: "areas/oncall/a.html",
  dstPath: "areas/oncall/b.html",
  edgeClass: relClassFor(over.rel),
  derived: false,
  strength: 1,
  provenance: "authored",
  ...over
})

describe("edge well-formedness", () => {
  it("accepts any rel paired with its own class", () => {
    fc.assert(
      fc.property(anyRel, (rel) => {
        expect(isWellFormedEdge(edge({ rel }))).toBe(true)
      }),
      { numRuns: 1000 }
    )
  })

  it("refuses a rel wearing another class, which is the SQL firewall's job too", () => {
    expect(isWellFormedEdge(edge({ rel: "about_person", edgeClass: "memory" }))).toBe(false)
    expect(isWellFormedEdge(edge({ rel: "supersedes", edgeClass: "person" }))).toBe(false)
    expect(isWellFormedEdge(edge({ rel: "from_session", edgeClass: "memory" }))).toBe(false)
    expect(isWellFormedEdge(edge({ rel: "blocks", edgeClass: "memory" }))).toBe(false)
    expect(isWellFormedEdge(edge({ rel: "subtask_of", edgeClass: "memory" }))).toBe(false)
    expect(isWellFormedEdge(edge({ rel: "relates_to", edgeClass: "task" }))).toBe(false)
  })

  it("refuses a self-loop", () => {
    expect(isWellFormedEdge(edge({ rel: "relates_to", dstPath: "areas/oncall/a.html" }))).toBe(
      false
    )
  })

  it("refuses a derived edge that claims any provenance but sleep", () => {
    expect(isWellFormedEdge(edge({ rel: "relates_to", derived: true, provenance: "sleep" }))).toBe(
      true
    )
    expect(
      isWellFormedEdge(edge({ rel: "relates_to", derived: true, provenance: "authored" }))
    ).toBe(false)
    expect(isWellFormedEdge(edge({ rel: "relates_to", derived: true, provenance: "import" }))).toBe(
      false
    )
  })
})
