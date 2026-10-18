/** @memhtml/snapshot: the columnar cold-start cache. See `docs/design.md` §20. */
export {
  listSnapshots,
  pruneSnapshots,
  SNAPSHOTS_KEPT,
  type SnapshotEntry
} from "./prune.js"
export {
  FORMAT_METADATA_KEY,
  readSnapshot,
  readSnapshotIfPresent,
  SHA_METADATA_KEY,
  SNAPSHOT_FORMAT,
  SNAPSHOTS_DIR,
  type SnapshotColumns,
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
  vectorCachePathFor,
  writeVectorCache
} from "./vectors.js"
