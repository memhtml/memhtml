/** @memhtml/snapshot: the columnar cold-start cache. See docs/v2-poc.md. */
export {
  listSnapshots,
  pruneSnapshots,
  SNAPSHOTS_KEPT,
  type SnapshotEntry
} from "./prune.js"
export {
  readSnapshot,
  SHA_METADATA_KEY,
  SNAPSHOTS_DIR,
  type SnapshotColumns,
  snapshotPathFor,
  writeSnapshot
} from "./snapshot.js"
export {
  DIMENSION_METADATA_KEY,
  MODEL_ID_METADATA_KEY,
  type ReadVectors,
  readVectorCache,
  type StoredVectorSpace,
  type StoredVectors,
  VECTORS_DIR,
  vectorCachePathFor,
  writeVectorCache
} from "./vectors.js"
