/** @memhtml/snapshot: the columnar cold-start cache. See `docs/design.md` §20. */
export {
  listSnapshots,
  pruneSnapshots,
  SNAPSHOTS_KEPT,
  type SnapshotEntry
} from "./prune.js"
export {
  type FacetColumns,
  FORMAT_METADATA_KEY,
  type LinkColumns,
  readSnapshot,
  readSnapshotIfPresent,
  SHA_METADATA_KEY,
  SNAPSHOT_FORMAT,
  SNAPSHOTS_DIR,
  type SnapshotColumns,
  type SnapshotContents,
  type SnapshotWriteResult,
  snapshotPathFor,
  writeSnapshot
} from "./snapshot.js"
export { STAGING_ABANDONED_MS, sweepStaging } from "./staging.js"
export {
  DIMENSION_METADATA_KEY,
  MODEL_ID_METADATA_KEY,
  type ReadVectors,
  readVectorCache,
  type StoredVectorSpace,
  type StoredVectors,
  VECTOR_CACHE_FORMAT,
  VECTOR_FORMAT_METADATA_KEY,
  VECTORS_DIR,
  type VectorCacheWriteResult,
  vectorCachePathFor,
  writeVectorCache
} from "./vectors.js"
