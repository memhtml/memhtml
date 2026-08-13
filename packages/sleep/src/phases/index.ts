import type { SleepPhase } from "../contract.js"
import type { PhaseBody } from "../env.js"
import { arcSynthesis } from "./arc-synthesis.js"
import { compress } from "./compress.js"
import { confidenceDecay } from "./confidence-decay.js"
import { conflictDetection } from "./conflict-detection.js"
import { dedupMerge } from "./dedup-merge.js"
import { entityResolution } from "./entity-resolution.js"
import { integrity } from "./integrity.js"
import { personLinks } from "./person-links.js"
import { preflight } from "./preflight.js"
import { relationshipMining } from "./relationship-mining.js"
import { reportPhase } from "./report.js"
import { reprieve } from "./reprieve.js"
import { retentionTriage } from "./retention-triage.js"
import { stateExport } from "./state-export.js"
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
  "conflict-detection": conflictDetection,
  "confidence-decay": confidenceDecay,
  "arc-synthesis": arcSynthesis,
  "retention-triage": retentionTriage,
  compress,
  reprieve,
  "trace-consolidation": traceConsolidation,
  integrity,
  "state-export": stateExport,
  report: reportPhase([])
}

export { arcSynthesis } from "./arc-synthesis.js"
export {
  COMPRESS_BATCH_SIZE,
  COMPRESS_CANDIDATE_LIMIT,
  COMPRESS_MEMBER_CHARS,
  compress
} from "./compress.js"
export { confidenceDecay } from "./confidence-decay.js"
export {
  CONFLICT_CANDIDATE_LIMIT,
  CONFLICT_COSINE_FLOOR,
  CONFLICT_PER_SOURCE_K,
  conflictDetection,
  PROMOTION_DETECTIONS
} from "./conflict-detection.js"
export { dedupMerge } from "./dedup-merge.js"
export {
  AUTO_MERGE_THRESHOLD,
  entityResolution,
  nameSimilarity,
  normalizeEntityName,
  REVIEW_THRESHOLD,
  resolveClusters
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
  TRACE_MIN_BYTES,
  TRACE_QUIET_MILLIS,
  TRACE_SESSIONS_PER_RUN,
  traceConsolidation
} from "./trace-consolidation.js"
