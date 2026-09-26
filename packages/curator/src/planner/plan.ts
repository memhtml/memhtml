import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { INBOX_DIR, PEOPLE_DIR, slugify } from "@memhtml/contracts"
import { frameValueOf as domainFrameValueOf } from "@memhtml/domain"

import { detectCommunities, type WeightedEdge } from "./graph.js"
import { rulingsByPath } from "./rulings.js"
import { knnEdges } from "./similarity.js"
import {
  type ClusterCut,
  type ClusterKind,
  type ClusterMember,
  type CollapseCluster,
  type CollapsePlan,
  DEFAULT_PLANNER_OPTIONS,
  type PlannerOptions,
  type PlanTotals,
  type Ruling
} from "./types.js"

/**
 * The planner: pure over a `HeadView`, deterministic, no model call, no I/O. Four cuts in order,
 * each one taking members the earlier cuts left:
 *
 * 0. Rulings, when supplied. A path ruled `archive` or `trace` joins its partition's archive
 *    cluster; a path ruled `fold` with a theme joins that theme's fold cluster; a path ruled `keep`
 *    leaves every later cut. A ruling is a human's decision, so it also admits the two record
 *    classes the charter otherwise shields (`resources/people/` and `task` rows), which without a
 *    ruling are excluded from every cut.
 * 1. Source plus memory type. The 2026-09-24 graph-cuts analysis found the store sparse (74% of
 *    records isolated in every layer) and that `author x memoryType x prefix` was the first-order
 *    structure, with one importer accounting for 73% of the records. Source is the
 *    `<meta name="memhtml-author">` value the way that analysis derived it, `(none)` when absent;
 *    it is not a `MemoryRecord` field, so it is read off the record's own bytes here.
 * 2. Frame key within a partition. A frame-key group is a fold only when every member states the
 *    same value (the claim after the frame) or the same claim. Members with different values are
 *    contradiction candidates, kept live under the charter's first priority, and the plan records
 *    them as a `keep` cluster with the reason. The 2026-09-23 live run refused eleven such groups
 *    correctly; this makes that refusal a rule the plan states rather than a judgment the model
 *    repeats. Entities join here as a graph layer rather than as hard groups: a shared entity
 *    (`person:laith` on 81 records) names a subject, not a duplicate, so it strengthens cut 3's
 *    edges instead of forming clusters of its own.
 * 3. A kNN similarity graph over what remains in each partition (`similarity.ts`) plus the entity
 *    layer, cut by Louvain (`graph.ts`). A community of two or more is a fold; one larger than
 *    `maxFold` is `keep`, because one canonical cannot carry it faithfully.
 * 4. PageRank anchors per cluster: the canonical candidate, and the title a fold is briefed under.
 *
 * Every list is sorted and every id is derived from the cut and its key, so the same view and the
 * same rulings yield byte-identical JSON.
 */

/** The author value for a record with no `memhtml-author` meta, spelled as the analysis spelled it. */
export const NO_SOURCE = "(none)"

/** Entity keys shared by more members than this are subjects, not similarity, and add no edge. */
export const ENTITY_KEY_CAP = 40

/** What one shared entity adds to a pair's edge weight, beside a cosine in [floor, 1]. */
export const ENTITY_EDGE_WEIGHT = 0.2

const AUTHOR_META = /<meta\s+name="memhtml-author"\s+content="([^"]*)"/i

/** The record's source: its author meta, read off the bytes the way the graph-cuts loader did. */
export const sourceOf = (record: MemoryRecord): string => {
  const match = AUTHOR_META.exec(record.html)
  const value = match?.[1]?.trim()
  return value === undefined || value === "" ? NO_SOURCE : value
}

/** The depth-2 prefix a path sits under (`areas/inbox`), or its top bucket for a shallower path. */
export const prefixOf = (path: string): string => path.split("/").slice(0, 2).join("/")

/** True for the buckets a canonical must not stay in: the inbox and any `*-import` landing zone. */
export const isBucketPrefix = (prefix: string): boolean =>
  prefix === INBOX_DIR || /-import$/.test(prefix)

const byPath = (a: { readonly path: string }, b: { readonly path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The most frequent value, ties broken by the value's own order so the answer is stable. */
const majority = (values: ReadonlyArray<string>): string | undefined => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))[0]?.[0]
}

/**
 * Types a canonical never takes: an arc is a synthesis and a task is a row, not a fact; an
 * `episodic` or `verdict` canonical is below the write bar under every scope, the curator's
 * included (`@memhtml/session` `writeBarReasons`), so a fold of them is briefed as `semantic`
 * rather than as a type its put could never land under.
 */
const NOT_CANONICAL_TYPES: ReadonlySet<string> = new Set(["arc", "task", "episodic", "verdict"])

const canonicalType = (records: ReadonlyArray<MemoryRecord>): string =>
  majority(
    records.map((record) => record.memoryType).filter((type) => !NOT_CANONICAL_TYPES.has(type))
  ) ?? "semantic"

/**
 * Where the canonical goes: the members' majority prefix when it is a real home, else
 * `<homeDefault>/<slug of the title>`, which is how the 2026-09-24 run placed 42 new homes.
 */
export const homeFor = (
  records: ReadonlyArray<MemoryRecord>,
  title: string,
  homeDefault: string
): string => {
  const prefix = majority(records.map((record) => prefixOf(record.path)))
  if (prefix === undefined || isBucketPrefix(prefix) || prefix.split("/").length < 2) {
    return `${homeDefault}/${slugify(title)}`
  }
  return prefix
}

const normalizeClaim = (claim: string): string =>
  claim.replace(/\s+/g, " ").trim().toLowerCase().replace(/\.$/, "")

/**
 * The value a claim writes into its frame, read through the domain's paired accessor (the same one
 * the briefing uses, so the planner and the briefing agree on what a value is), or the whole
 * normalized claim when the claim carries no frame.
 */
export const frameValueOf = (record: MemoryRecord): string =>
  domainFrameValueOf(record.claim) ?? normalizeClaim(record.claim)

/**
 * True when a frame-key group states one value or one claim, so folding it loses no side.
 *
 * A `verdict` record carries its judgment in the title (`verdict: suppressed_failure`) over a claim
 * that is the objective judged, so two verdicts with one claim and two titles disagree the way two
 * values do; measured on the 2026-09-22 store, one of the eleven shared frame keys was exactly that
 * pair (`unsupported_claim` beside `unverifiable-citation`), and the other ten were byte-identical
 * re-mints.
 */
export const frameGroupAgrees = (records: ReadonlyArray<MemoryRecord>): boolean => {
  if (
    records.every((record) => record.memoryType === "verdict") &&
    new Set(records.map((record) => normalizeClaim(record.title))).size > 1
  ) {
    return false
  }
  const values = new Set(records.map(frameValueOf))
  if (values.size === 1) return true
  return new Set(records.map((record) => normalizeClaim(record.claim))).size === 1
}

/** True for the records the charter shields from ranking: people identity records and task rows. */
export const isShielded = (record: MemoryRecord): boolean =>
  record.path.startsWith(`${PEOPLE_DIR}/`) || record.memoryType === "task"

export interface PlanInput {
  readonly rulings?: ReadonlyArray<Ruling> | undefined
  readonly options?: Partial<PlannerOptions> | undefined
  /** The clock the tag and the archive year read. Defaults to now. */
  readonly now?: Date | undefined
}

const partitionKey = (record: MemoryRecord): string =>
  `${sourceOf(record)}\u0000${record.memoryType}`

const partitionSlug = (key: string): string => {
  const [source, type] = key.split("\u0000")
  return `${slugify(source === NO_SOURCE ? "none" : (source ?? "none"))}-${slugify(type ?? "")}`
}

/** The entity layer over one partition: one edge per pair sharing an entity key under the cap. */
const entityEdges = (records: ReadonlyArray<MemoryRecord>): ReadonlyArray<WeightedEdge> => {
  const members = new Map<string, Array<string>>()
  for (const record of records) {
    for (const entity of new Set(record.entities)) {
      const list = members.get(entity) ?? []
      list.push(record.path)
      members.set(entity, list)
    }
  }
  const edges: Array<WeightedEdge> = []
  for (const [, paths] of [...members.entries()].sort((a, b) => byString(a[0], b[0]))) {
    if (paths.length < 2 || paths.length > ENTITY_KEY_CAP) continue
    const sorted = [...paths].sort(byString)
    for (let a = 0; a < sorted.length; a += 1) {
      for (let b = a + 1; b < sorted.length; b += 1) {
        edges.push({ from: sorted[a] ?? "", to: sorted[b] ?? "", weight: ENTITY_EDGE_WEIGHT })
      }
    }
  }
  return edges
}

interface ClusterDraft {
  readonly id: string
  readonly kind: ClusterKind
  readonly cut: ClusterCut
  readonly records: ReadonlyArray<MemoryRecord>
  readonly title?: string | undefined
  readonly rationale: string
}

export const planCollapse = (view: HeadView, input: PlanInput = {}): CollapsePlan => {
  const options: PlannerOptions = { ...DEFAULT_PLANNER_OPTIONS, ...(input.options ?? {}) }
  const now = input.now ?? new Date()
  const date = now.toISOString().slice(0, 10)
  const rulings = rulingsByPath(input.rulings ?? [])

  const active: Array<MemoryRecord> = []
  let archived = 0
  for (const record of view.records()) {
    if (record.archived) archived += 1
    else active.push(record)
  }
  active.sort(byPath)
  const activePaths = new Set(active.map((record) => record.path))
  let rulingsUnmatched = 0
  for (const path of rulings.keys()) if (!activePaths.has(path)) rulingsUnmatched += 1

  const drafts: Array<ClusterDraft> = []
  let excluded = 0
  let ruledKeep = 0

  // Cut 0: rulings. Archive and trace by partition, fold by theme, keep out of everything.
  const archiveByPartition = new Map<string, Array<MemoryRecord>>()
  const foldByTheme = new Map<string, Array<MemoryRecord>>()
  const remaining: Array<MemoryRecord> = []
  for (const record of active) {
    const ruling = rulings.get(record.path)
    if (ruling === undefined) {
      if (isShielded(record)) excluded += 1
      else remaining.push(record)
      continue
    }
    switch (ruling.verdict) {
      case "keep":
        ruledKeep += 1
        break
      case "archive":
      case "trace": {
        const key = partitionKey(record)
        const list = archiveByPartition.get(key) ?? []
        list.push(record)
        archiveByPartition.set(key, list)
        break
      }
      case "fold": {
        if (ruling.theme === undefined) {
          if (isShielded(record)) excluded += 1
          else remaining.push(record)
          break
        }
        const list = foldByTheme.get(ruling.theme) ?? []
        list.push(record)
        foldByTheme.set(ruling.theme, list)
        break
      }
    }
  }
  for (const [key, records] of [...archiveByPartition.entries()].sort((a, b) =>
    byString(a[0], b[0])
  )) {
    const [source, type] = key.split("\u0000")
    drafts.push({
      id: `archive-${partitionSlug(key)}`,
      kind: "archive",
      cut: "ruling",
      records,
      title: `Archive ${String(records.length)} ${type ?? ""} record(s) from ${source ?? NO_SOURCE}`,
      rationale: `${String(records.length)} record(s) ruled archive or trace by the rulings file; no model needed`
    })
  }
  for (const [theme, records] of [...foldByTheme.entries()].sort((a, b) => byString(a[0], b[0]))) {
    drafts.push({
      id: `theme-${slugify(theme)}`,
      kind: "fold",
      cut: "ruling",
      records,
      title: theme.replace(/[-_]+/g, " "),
      rationale: `${String(records.length)} record(s) ruled fold under theme ${JSON.stringify(theme)}`
    })
  }

  // Cut 1: partitions by source plus memory type over what the rulings left.
  const partitions = new Map<string, Array<MemoryRecord>>()
  for (const record of remaining) {
    const key = partitionKey(record)
    const list = partitions.get(key) ?? []
    list.push(record)
    partitions.set(key, list)
  }

  const pagerank = new Map<string, number>()
  let singletons = 0
  for (const [key, records] of [...partitions.entries()].sort((a, b) => byString(a[0], b[0]))) {
    // Cut 2: frame-key groups, agreeing ones fold and disagreeing ones are kept as contradictions.
    const byKey = new Map<string, Array<MemoryRecord>>()
    for (const record of records) {
      if (record.frameKey === null) continue
      const list = byKey.get(record.frameKey) ?? []
      list.push(record)
      byKey.set(record.frameKey, list)
    }
    const framed = new Set<string>()
    for (const [frameKey, group] of [...byKey.entries()].sort((a, b) => byString(a[0], b[0]))) {
      if (group.length < 2) continue
      for (const record of group) framed.add(record.path)
      const agrees = frameGroupAgrees(group)
      const values = Math.max(
        new Set(group.map(frameValueOf)).size,
        agrees ? 1 : new Set(group.map((record) => normalizeClaim(record.title))).size
      )
      drafts.push({
        id: `frame-${partitionSlug(key)}-${slugify(frameKey)}`,
        kind: agrees ? "fold" : "keep",
        cut: "frame-key",
        records: group,
        rationale: agrees
          ? `frame key ${JSON.stringify(frameKey)} held by ${String(group.length)} records stating one value`
          : `frame key ${JSON.stringify(frameKey)} held by ${String(group.length)} records with ${String(values)} different values: contradiction candidates, never folded`
      })
    }

    // Cut 3: the similarity graph over the whole partition (so PageRank covers the framed members
    // too), communities taken from the unframed remainder.
    const paths = records.map((record) => record.path)
    const cut = detectCommunities(
      paths,
      [knnEdges(records, { k: options.knn, floor: options.similarityFloor }), entityEdges(records)],
      options.seed
    )
    for (const [path, rank] of cut.pagerank) pagerank.set(path, rank)
    const byPathMap = new Map(records.map((record) => [record.path, record]))
    const clustered = new Set<string>(framed)
    let index = 0
    for (const community of cut.communities) {
      const members = community.filter((path) => !framed.has(path))
      if (members.length < 2) continue
      index += 1
      for (const path of members) clustered.add(path)
      const communityRecords = members.flatMap((path) => {
        const record = byPathMap.get(path)
        return record === undefined ? [] : [record]
      })
      const tooLarge = communityRecords.length > options.maxFold
      drafts.push({
        id: `sim-${partitionSlug(key)}-${String(index)}`,
        kind: tooLarge ? "keep" : "fold",
        cut: "similarity",
        records: communityRecords,
        rationale: tooLarge
          ? `Louvain community of ${String(communityRecords.length)} in ${partitionSlug(key)} exceeds maxFold ${String(options.maxFold)}: one canonical cannot carry it`
          : `Louvain community of ${String(communityRecords.length)} in ${partitionSlug(key)} over lexical kNN (k ${String(options.knn)}, cosine >= ${String(options.similarityFloor)}) plus shared entities`
      })
    }
    singletons += records.filter((record) => !clustered.has(record.path)).length
  }

  const clusters = drafts.map((draft) => toCluster(draft, rulings, pagerank, options))
  clusters.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.members.length - a.members.length ||
      byString(a.id, b.id)
  )
  const count = (kind: ClusterKind) => clusters.filter((cluster) => cluster.kind === kind)
  const totals: PlanTotals = {
    active: active.length,
    archived,
    excluded,
    ruledKeep,
    singletons,
    clusters: {
      archive: count("archive").length,
      fold: count("fold").length,
      keep: count("keep").length
    },
    members: {
      archive: count("archive").reduce((sum, cluster) => sum + cluster.members.length, 0),
      fold: count("fold").reduce((sum, cluster) => sum + cluster.members.length, 0),
      keep: count("keep").reduce((sum, cluster) => sum + cluster.members.length, 0)
    },
    rulingsUnmatched,
    partitions: partitions.size
  }
  return {
    sha: view.sha,
    tag: `collapse-${date}`,
    archiveYear: date.slice(0, 4),
    options,
    totals,
    clusters
  }
}

const KIND_ORDER: Record<ClusterKind, number> = { archive: 0, fold: 1, keep: 2 }

const toCluster = (
  draft: ClusterDraft,
  rulings: ReadonlyMap<string, Ruling>,
  pagerank: ReadonlyMap<string, number>,
  options: PlannerOptions
): CollapseCluster => {
  const records = [...draft.records].sort(byPath)
  const anchor = records.reduce(
    (best, record) =>
      (pagerank.get(record.path) ?? 0) > (pagerank.get(best.path) ?? 0) ? record : best,
    records[0] as MemoryRecord
  )
  const title = draft.title ?? anchor.title
  const members: Array<ClusterMember> = records.map((record) => {
    const ruling = rulings.get(record.path)
    return {
      path: record.path,
      claim: record.claim,
      memoryType: record.memoryType,
      ...(ruling === undefined ? {} : { ruling })
    }
  })
  return {
    id: draft.id,
    kind: draft.kind,
    cut: draft.cut,
    title,
    home: homeFor(records, title, options.homeDefault),
    memoryType: canonicalType(records),
    source: majority(records.map(sourceOf)) ?? NO_SOURCE,
    members,
    anchor: anchor.path,
    large: draft.kind === "fold" && records.length > options.largeGroup,
    rationale: draft.rationale
  }
}
