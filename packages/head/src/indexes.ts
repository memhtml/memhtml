import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { HashMap, HashSet, Option } from "effect"

import { addToLexical, emptyLexical, type LexicalIndex, removeFromLexical } from "./lexical.js"

/**
 * The persistent record map and every index derived from it, as one value.
 *
 * Each field is an `effect` `HashMap` or `HashSet`, so a change to one record builds a new
 * `Indexes` that shares every untouched node with the old one. `insertRecord` and `removeRecord`
 * are the only two writers; every version and every overlay is a fold of those two over a parent.
 */
export interface Indexes {
  readonly records: HashMap.HashMap<string, MemoryRecord>
  /** content hash -> the ACTIVE path holding it. Archived records never enter. */
  readonly byContentHash: HashMap.HashMap<string, string>
  /** frame key -> ACTIVE paths whose claim shares it. */
  readonly byFrameKey: HashMap.HashMap<string, HashSet.HashSet<string>>
  /** href (root-relative, as authored) -> paths whose links point at it. All records. */
  readonly inbound: HashMap.HashMap<string, HashSet.HashSet<string>>
  /** entity (`type:name`, as authored) -> paths naming it. All records. */
  readonly byEntity: HashMap.HashMap<string, HashSet.HashSet<string>>
  /** Active records only, see `lexical.ts`. */
  readonly lexical: LexicalIndex
}

export const emptyIndexes: Indexes = {
  records: HashMap.empty(),
  byContentHash: HashMap.empty(),
  byFrameKey: HashMap.empty(),
  inbound: HashMap.empty(),
  byEntity: HashMap.empty(),
  lexical: emptyLexical
}

type Multi = HashMap.HashMap<string, HashSet.HashSet<string>>

const multiAdd = (multi: Multi, key: string, path: string): Multi =>
  HashMap.set(
    multi,
    key,
    HashSet.add(
      Option.getOrElse(HashMap.get(multi, key), () => HashSet.empty<string>()),
      path
    )
  )

const multiRemove = (multi: Multi, key: string, path: string): Multi => {
  const bucket = Option.getOrUndefined(HashMap.get(multi, key))
  if (bucket === undefined) return multi
  const next = HashSet.remove(bucket, path)
  return HashSet.size(next) === 0 ? HashMap.remove(multi, key) : HashMap.set(multi, key, next)
}

const multiGet = (multi: Multi, key: string): ReadonlyArray<string> => {
  const bucket = Option.getOrUndefined(HashMap.get(multi, key))
  return bucket === undefined ? [] : [...bucket].sort()
}

/** Drop the record at `path` from every index. A path with no record is a no-op. */
export const removeRecord = (indexes: Indexes, path: string): Indexes => {
  const record = Option.getOrUndefined(HashMap.get(indexes.records, path))
  if (record === undefined) return indexes
  let byFrameKey = indexes.byFrameKey
  let byContentHash = indexes.byContentHash
  let lexical = indexes.lexical
  if (!record.archived) {
    if (record.frameKey !== null) byFrameKey = multiRemove(byFrameKey, record.frameKey, path)
    // Only the holder releases the hash: a second active record with the same hash that lost the
    // race to hold it must not be able to evict the holder by being removed.
    if (Option.getOrUndefined(HashMap.get(byContentHash, record.contentHash)) === path) {
      byContentHash = HashMap.remove(byContentHash, record.contentHash)
    }
    lexical = removeFromLexical(lexical, record)
  }
  let inbound = indexes.inbound
  for (const link of record.links) inbound = multiRemove(inbound, link.href, path)
  let byEntity = indexes.byEntity
  for (const entity of record.entities) byEntity = multiRemove(byEntity, entity, path)
  return {
    records: HashMap.remove(indexes.records, path),
    byContentHash,
    byFrameKey,
    inbound,
    byEntity,
    lexical
  }
}

/**
 * Put `record` at its path, replacing whatever was there. Archived records enter `records`,
 * `inbound`, and `byEntity` only: the active-only indexes exist to answer "is this claim already
 * live", and an archived file is by definition not.
 */
export const insertRecord = (indexes: Indexes, record: MemoryRecord): Indexes => {
  const cleared = removeRecord(indexes, record.path)
  let byFrameKey = cleared.byFrameKey
  let byContentHash = cleared.byContentHash
  let lexical = cleared.lexical
  if (!record.archived) {
    if (record.frameKey !== null) byFrameKey = multiAdd(byFrameKey, record.frameKey, record.path)
    // First holder wins so the answer is stable across rebuilds in ls-tree order.
    if (!HashMap.has(byContentHash, record.contentHash)) {
      byContentHash = HashMap.set(byContentHash, record.contentHash, record.path)
    }
    lexical = addToLexical(lexical, record)
  }
  let inbound = cleared.inbound
  for (const link of record.links) inbound = multiAdd(inbound, link.href, record.path)
  let byEntity = cleared.byEntity
  for (const entity of record.entities) byEntity = multiAdd(byEntity, entity, record.path)
  return {
    records: HashMap.set(cleared.records, record.path, record),
    byContentHash,
    byFrameKey,
    inbound,
    byEntity,
    lexical
  }
}

/** Marks a view built here, so `searchHead` and `withOverlay` can reuse its indexes. */
export const INDEXES: unique symbol = Symbol.for("@memhtml/head/indexes")

/** A `HeadView` that exposes the indexes it answers from. */
export interface IndexedView extends HeadView {
  readonly [INDEXES]: Indexes
  readonly lexical: LexicalIndex
}

export const isIndexedView = (view: HeadView): view is IndexedView => INDEXES in view

/** The read surface over one `Indexes` value. */
export const viewOf = (indexes: Indexes, sha: string | null): IndexedView => ({
  [INDEXES]: indexes,
  lexical: indexes.lexical,
  sha,
  size: HashMap.size(indexes.records),
  get: (path) => Option.getOrUndefined(HashMap.get(indexes.records, path)),
  paths: () => HashMap.keys(indexes.records),
  records: () => HashMap.values(indexes.records),
  byContentHash: (hash) => Option.getOrUndefined(HashMap.get(indexes.byContentHash, hash)),
  byFrameKey: (key) => multiGet(indexes.byFrameKey, key),
  inbound: (href) => multiGet(indexes.inbound, href),
  byEntity: (entity) => multiGet(indexes.byEntity, entity)
})

/**
 * The indexes behind any `HeadView`: reused when the view was built here, rebuilt from
 * `records()` when a caller supplied its own (a test's `Map`-backed view).
 */
export const indexesOf = (view: HeadView): Indexes => {
  if (isIndexedView(view)) return view[INDEXES]
  let indexes = emptyIndexes
  for (const record of view.records()) indexes = insertRecord(indexes, record)
  return indexes
}
