import { Schema } from "effect"

/**
 * The four non-mixing edge classes. The class is what makes a person or task edge structurally
 * incapable of entering PageRank, MMR, or the retention bridge count: every memory-graph
 * query filters `edge_class = 'memory'`, and the SQL CHECK constraint refuses a rel that
 * belongs to another class.
 */
export const EDGE_CLASSES = ["memory", "person", "provenance", "task"] as const

export const EdgeClass = Schema.Literals(EDGE_CLASSES)
export type EdgeClass = typeof EdgeClass.Type

/**
 * The nine memory rels. `supersedes` and `contradicts` are penalty-bearing — they gate
 * the retention `contested_status` signal — so sleep promotes a corroborated one into
 * both files rather than leaving it in the rebuildable index.
 */
export const MEMORY_RELS = [
  "supersedes",
  "contradicts",
  "caused_by",
  "leads_to",
  "part_of",
  "relates_to",
  "example_of",
  "supports",
  "laterally_related"
] as const

export const MemoryRel = Schema.Literals(MEMORY_RELS)
export type MemoryRel = typeof MemoryRel.Type

/** The two person rels, pointing at `resources/people/*`. */
export const PERSON_RELS = ["about_person", "authored_by"] as const

export const PersonRel = Schema.Literals(PERSON_RELS)
export type PersonRel = typeof PersonRel.Type

/** The one provenance rel, linking a memory to the session that produced it. */
export const PROVENANCE_RELS = ["from_session"] as const

export const ProvenanceRel = Schema.Literals(PROVENANCE_RELS)
export type ProvenanceRel = typeof ProvenanceRel.Type

/**
 * The two task rels, both between two `task` files.
 *
 * Their own class for the same reason the person rels have one: task topology is working
 * state, and a `blocks` edge entering PageRank would let an agent's to-do list reweight the
 * retention of its knowledge. `@memhtml/store`'s `linkMemories` refuses a task rel unless BOTH
 * endpoints are tasks, and the `edges` CHECK refuses the rel under any other class.
 */
export const TASK_RELS = ["blocks", "subtask_of"] as const

export const TaskRel = Schema.Literals(TASK_RELS)
export type TaskRel = typeof TaskRel.Type

/** Every rel across all four classes. The `edges.rel` column's full vocabulary. */
export const ALL_RELS = [...MEMORY_RELS, ...PERSON_RELS, ...PROVENANCE_RELS, ...TASK_RELS] as const

export const EdgeRel = Schema.Literals(ALL_RELS)
export type EdgeRel = typeof EdgeRel.Type

/**
 * The class a rel belongs to. Total over {@link ALL_RELS} and injective per class — a rel
 * name appears in exactly one class, which is what lets the class be derived rather than
 * carried alongside the rel and risk disagreeing with it.
 */
export const relClassFor = (rel: EdgeRel): EdgeClass => {
  if ((MEMORY_RELS as ReadonlyArray<string>).includes(rel)) return "memory"
  if ((PERSON_RELS as ReadonlyArray<string>).includes(rel)) return "person"
  if ((TASK_RELS as ReadonlyArray<string>).includes(rel)) return "task"
  return "provenance"
}

/** The rels of one class. The inverse of {@link relClassFor}, as a set. */
export const relsForClass = (edgeClass: EdgeClass): ReadonlyArray<EdgeRel> => {
  switch (edgeClass) {
    case "memory":
      return MEMORY_RELS
    case "person":
      return PERSON_RELS
    case "provenance":
      return PROVENANCE_RELS
    case "task":
      return TASK_RELS
  }
}

/** True when `rel` is in the closed vocabulary. Narrows an untrusted string. */
export const isEdgeRel = (rel: string): rel is EdgeRel =>
  (ALL_RELS as ReadonlyArray<string>).includes(rel)

/** Where an edge came from. `derived` edges are only ever `sleep`-provenanced. */
export const EDGE_PROVENANCES = ["authored", "sleep", "import"] as const

export const EdgeProvenance = Schema.Literals(EDGE_PROVENANCES)
export type EdgeProvenance = typeof EdgeProvenance.Type

/**
 * A `<link rel>` token, which is the rel prefixed for the HTML plane. `rel` tokens cannot
 * hold a colon, so the prefix is hyphenated and the rel's own underscores become hyphens:
 * `laterally_related` ⇒ `memhtml-laterally-related`.
 */
export const REL_TOKEN_PREFIX = "memhtml-"

/** The HTML `<link rel>` token for a rel. */
export const relTokenFor = (rel: EdgeRel): string =>
  `${REL_TOKEN_PREFIX}${rel.replaceAll("_", "-")}`

/**
 * The rel behind a `<link rel>` token, or `undefined` when the token is outside the closed
 * vocabulary. Inverse of {@link relTokenFor} on its image.
 */
export const relForToken = (token: string): EdgeRel | undefined => {
  if (!token.startsWith(REL_TOKEN_PREFIX)) return undefined
  const rel = token.slice(REL_TOKEN_PREFIX.length).replaceAll("-", "_")
  return isEdgeRel(rel) ? rel : undefined
}

/**
 * One edge. `derived` separates a sleep-mined suspicion from an authored assertion: the
 * retention `contested_status` signal counts only `derived: false` contradictions, so an
 * uncorroborated machine guess can never evict a memory.
 *
 * `strength` is unitless in `[0, 1]`; an authored edge is 1.0 and a mined one carries its
 * cosine. `srcPath`/`dstPath` are repo-root-relative with no leading slash.
 */
export const Edge = Schema.Struct({
  srcPath: Schema.String,
  rel: EdgeRel,
  dstPath: Schema.String,
  edgeClass: EdgeClass,
  derived: Schema.Boolean,
  strength: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  provenance: EdgeProvenance
})
export type Edge = typeof Edge.Type

/**
 * True when an edge's declared class matches its rel and it is not a self-loop — the two
 * conditions the `edges` table's CHECK constraints enforce, stated once here so a caller
 * can refuse a bad edge before the driver does.
 */
export const isWellFormedEdge = (edge: Edge): boolean =>
  edge.srcPath !== edge.dstPath &&
  relClassFor(edge.rel) === edge.edgeClass &&
  (!edge.derived || edge.provenance === "sleep")
