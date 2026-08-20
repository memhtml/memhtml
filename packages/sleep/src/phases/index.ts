import type { SleepPhase } from "../contract.js"
import type { PhaseBody } from "../env.js"
import { arcSynthesis } from "./arc-synthesis.js"
import { compress } from "./compress.js"
import { confidenceDecay } from "./confidence-decay.js"
import { dedupMerge } from "./dedup-merge.js"
import { edgeTyping } from "./edge-typing.js"
import { entityResolution } from "./entity-resolution.js"
import { integrity } from "./integrity.js"
import { personLinks } from "./person-links.js"
import { preflight } from "./preflight.js"
import { relationshipMining } from "./relationship-mining.js"
import { reportPhase } from "./report.js"
import { reprieve } from "./reprieve.js"
import { retentionTriage } from "./retention-triage.js"
import { stateExport } from "./state-export.js"
import { taskDetection } from "./task-detection.js"
import { traceConsolidation } from "./trace-consolidation.js"

/**
 * The phase registry: one body per phase name, exhaustively.
 *
 * A total `Record<SleepPhase, PhaseBody>`, not a lookup that can miss, so adding a phase name
 * to `SLEEP_PHASES` without writing its body is a compile error instead of a run that silently skips
 * it. `report` is the one entry that takes the run's own results, so its registry entry is a
 * zero-result placeholder the runner replaces. See `run.ts`.
 */
export const PHASE_BODIES: Readonly<Record<SleepPhase, PhaseBody>> = {
  preflight,
  "dedup-merge": dedupMerge,
  "entity-resolution": entityResolution,
  "person-links": personLinks,
  "relationship-mining": relationshipMining,
  "edge-typing": edgeTyping,
  "confidence-decay": confidenceDecay,
  "arc-synthesis": arcSynthesis,
  "retention-triage": retentionTriage,
  compress,
  reprieve,
  "trace-consolidation": traceConsolidation,
  "task-detection": taskDetection,
  integrity,
  "state-export": stateExport,
  report: reportPhase([])
}

export { arcSynthesis } from "./arc-synthesis.js"
export {
  COMPRESS_BATCH_SIZE,
  COMPRESS_CANDIDATE_LIMIT,
  COMPRESS_MEMBER_CHARS,
  COMPRESS_MIN_BATCH,
  compress
} from "./compress.js"
export { confidenceDecay } from "./confidence-decay.js"
export {
  DEDUP_ADMIT_FLOOR,
  DEDUP_BATCH_CHARS,
  DEDUP_BATCH_MEMBERS,
  DEDUP_COMPONENT_FLOOR,
  DEDUP_MAX_COMPONENT,
  DEDUP_MAX_COMPONENTS,
  DEDUP_MEMBER_CHARS,
  DEDUP_PAIR_LIMIT,
  dedupMerge
} from "./dedup-merge.js"
export {
  EDGE_COSINE_FLOOR,
  EDGE_PAIR_SIDE_CHARS,
  EDGE_PAIRS_PER_CALL,
  EDGE_PER_SOURCE_K,
  EDGE_PROMOTION_CAP,
  EDGE_TYPING_CANDIDATE_LIMIT,
  edgeTyping,
  edgeTypingCandidates,
  PROMOTION_DETECTIONS,
  pairGroupKey,
  // Aliased: entity-resolution exports its own `unionPairs` (name pairs, not path pairs).
  unionPairs as unionEdgePairs
} from "./edge-typing.js"
export type {
  AliasGroup,
  CentroidNeighbor,
  CharacterPairs,
  EntityCentroid,
  EntityClusters,
  NamePair,
  ProposedMerge
} from "./entity-resolution.js"
export {
  AUTO_MERGE_THRESHOLD,
  aliasBacked,
  characterPairs,
  decomposeCluster,
  ENTITY_BATCH_SIZE,
  ENTITY_CONFIDENCE_FLOOR,
  ENTITY_MEMBER_CHARS,
  ENTITY_NEIGHBORS,
  ENTITY_PROMOTION_DETECTIONS,
  ENTITY_SAMPLE_TITLES,
  entityCentroids,
  entityMemberText,
  entityResolution,
  nameSimilarity,
  nearestCentroids,
  normalizeEntityName,
  pairKey,
  REVIEW_THRESHOLD,
  resolveClusters,
  // Aliased: edge-typing exports its own `unionPairs` (path pairs, not name pairs).
  unionPairs as unionNamePairs
} from "./entity-resolution.js"
export { ARCHIVE_LOOKBACK_YEARS, archivedFormOf, integrity } from "./integrity.js"
export { personLinks } from "./person-links.js"
export { preflight } from "./preflight.js"
export {
  MINING_COSINE_FLOOR,
  MINING_PER_SOURCE_K,
  MINING_SAMPLE_LIMIT,
  relationshipMining
} from "./relationship-mining.js"
export { reportFilename, reportPhase } from "./report.js"
export { reprieve } from "./reprieve.js"
export { retentionTriage } from "./retention-triage.js"
export {
  parseSidecar,
  renderSidecar,
  round4,
  SIDECAR_PRECISION,
  type SidecarEntry,
  stateExport,
  toSidecarEntry
} from "./state-export.js"
export {
  TASK_DETECT_BATCH_SIZE,
  TASK_DETECT_DETECTOR,
  TASK_DETECT_FLOOR,
  TASK_DETECT_MEMBER_CHARS,
  TASK_SCAN_LIMIT,
  taskDetection
} from "./task-detection.js"
export {
  TRACE_MIN_BYTES,
  TRACE_QUIET_MILLIS,
  TRACE_SESSIONS_PER_RUN,
  traceConsolidation
} from "./trace-consolidation.js"
