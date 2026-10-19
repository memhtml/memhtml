/**
 * The collapse plan: what `memhtml curate collapse` executes, computed by code over one head view
 * with no model call, and serializable as JSON so a plan can be saved, read, edited, and replayed.
 *
 * Three kinds of cluster, and the kind decides the driver:
 *
 * - `archive` needs no model. Every member is archived through validated sessions in chunks.
 * - `fold` runs one curator session under the collapse charter: the model writes one canonical
 *   record, and the driver completes the archives and the `supersedes` links so every member ends
 *   archived and reached from the canonical.
 * - `keep` is untouched. It is in the plan so a human can see what the planner found and refused:
 *   a frame-key group whose members disagree in value is a contradiction candidate, never a fold.
 */

export type ClusterKind = "archive" | "fold" | "keep"

/** Which cut produced a cluster, so a rationale can be read back to the rule that made it. */
export type ClusterCut = "ruling" | "frame-key" | "similarity"

/** The four rulings the audit vocabulary uses, per path. `trace` lands with `archive`. */
export type Verdict = "keep" | "fold" | "trace" | "archive"

/** One line of a rulings JSONL file: a path, its verdict, and for a fold the theme it folds into. */
export interface Ruling {
  readonly path: string
  readonly verdict: Verdict
  readonly theme?: string | undefined
  readonly reason?: string | undefined
}

export interface ClusterMember {
  readonly path: string
  readonly claim: string
  readonly memoryType: string
  /** The audit ruling on this path, when one was supplied. */
  readonly ruling?: Ruling | undefined
}

export interface CollapseCluster {
  /** Stable across runs over the same view and rulings: derived from the cut and its key. */
  readonly id: string
  readonly kind: ClusterKind
  readonly cut: ClusterCut
  /** The canonical's title for a fold; the anchor's title otherwise. */
  readonly title: string
  /** Where the canonical lives, as a directory prefix with no trailing slash (`areas/loop-guard`). */
  readonly home: string
  /** The majority memory type among the members; the canonical's type for a fold. */
  readonly memoryType: string
  /** The `<meta name="memhtml-author">` value the members share, or `(none)`. */
  readonly source: string
  readonly members: ReadonlyArray<ClusterMember>
  /** The member with the highest PageRank in its partition's graph: the canonical candidate. */
  readonly anchor: string
  /** True when the fold has more members than {@link LARGE_GROUP}: the driver completes archives and links. */
  readonly large: boolean
  /** One line saying which rule made this cluster and why it has the kind it has. */
  readonly rationale: string
}

export interface PlanTotals {
  /** Active records in the view. */
  readonly active: number
  /** Archived records in the view. */
  readonly archived: number
  /** Active records the planner did not consider: `resources/people/` and `task` rows. */
  readonly excluded: number
  /** Active records ruled `keep`, left out of every cut. */
  readonly ruledKeep: number
  /** Active records that ended in no cluster. */
  readonly singletons: number
  readonly clusters: Record<ClusterKind, number>
  readonly members: Record<ClusterKind, number>
  /** Rulings whose path is not an active record in the view. */
  readonly rulingsUnmatched: number
  /** Partitions by source plus memory type that held at least one record. */
  readonly partitions: number
}

export interface CollapsePlan {
  /** The commit the view was built from, so a replayed plan can be checked against the ref. */
  readonly sha: string | null
  /** The tag every canonical carries, `collapse-<UTC date>`. */
  readonly tag: string
  /** The archive year every member's destination uses. */
  readonly archiveYear: string
  readonly options: PlannerOptions
  readonly totals: PlanTotals
  /** Sorted: archive clusters first, then fold, then keep; within a kind by size descending, then id. */
  readonly clusters: ReadonlyArray<CollapseCluster>
}

export interface PlannerOptions {
  /** Nearest neighbors kept per record in the similarity graph. */
  readonly knn: number
  /** Cosine below which a neighbor is not an edge. */
  readonly similarityFloor: number
  /** A fold with more members than this leaves its archives and links to the driver. */
  readonly largeGroup: number
  /** A similarity community with more members than this is `keep`: one canonical cannot hold it. */
  readonly maxFold: number
  /** The bucket a canonical goes under when the members' own prefix is an inbox or an import. */
  readonly homeDefault: string
  /** The seed for the community detection's random order, so a plan is reproducible. */
  readonly seed: number
}

/** The 2026-09-24 rule: a fold over more than this many members has the driver do the bookkeeping. */
export const LARGE_GROUP = 30

/** Archive ops per session for an `archive` cluster: under `BATCH_CAP` with room for a stamp. */
export const ARCHIVE_CHUNK = 180

/** The most members one fold session briefs in full; the rest are archived by follow-up sessions. */
export const FOLD_FIRST_SESSION_MEMBERS = 170

export const DEFAULT_PLANNER_OPTIONS: PlannerOptions = {
  knn: 10,
  similarityFloor: 0.35,
  largeGroup: LARGE_GROUP,
  maxFold: 120,
  homeDefault: "areas",
  seed: 42
}
