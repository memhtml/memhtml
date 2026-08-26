/**
 * `@memhtml/sleep`: the curation cycle as seventeen git commits.
 *
 * Every phase is its own commit on `sleep/<date>`, carrying a `Memhtml-Run`/`Memhtml-Phase`/`Memhtml-Counts`
 * trailer block. The trailers are what `resume` reads, so no journal table is required and the git
 * history alone can say what a run already did. A failed phase keeps every prior commit and lets the
 * later phases run; `git branch -D` is the abort, and `main` never moved.
 */

export type { GroupBatch, KeyedBatch, KeyedMember, LlmFailure } from "./batch.js"
export {
  assembleBatches,
  batchCall,
  batchPrompt,
  isolate,
  keyMembers,
  memberList,
  offeredKeyFor,
  packGroups,
  resolveKeys
} from "./batch.js"
export { commitPhase, phaseTrailers } from "./commit.js"
export type {
  CandidateCommitmentLike,
  CandidateEvidenceLike,
  CandidateMemoryLike,
  ConsolidationOutcome,
  ConsolidatorFailure,
  ConsolidatorPort,
  TranscriptManifestEntry,
  TranscriptRef
} from "./consolidator.js"
export type {
  FileClassification,
  MergeReport,
  PendingMark,
  PhaseCounts,
  PhaseResult,
  PhaseStatus,
  ReviewCommit,
  ReviewFile,
  ReviewReport,
  RunReport,
  SleepPhase
} from "./contract.js"
export {
  appendPendingMarks,
  dependentsOf,
  HARD_PREREQUISITES,
  isSleepPhase,
  isSweepPhase,
  LLM_PHASES,
  NON_COMMITTING_PHASES,
  parsePendingMarks,
  pendingMarksPath,
  phaseIndexOf,
  readPendingMarks,
  recordPendingMarks,
  SLEEP_PHASES,
  SWEEP_PHASES,
  TRAILER_COUNTS,
  TRAILER_PHASE,
  TRAILER_RUN
} from "./contract.js"
export type { HeadEdit } from "./edits.js"
export {
  addTag,
  applyHeadEdits,
  archiveFile,
  confidenceOf,
  datePlusDays,
  hrefFor,
  link,
  meta,
  renderConfidence,
  reprievesOf,
  rewriteEntityMeta,
  stampFile,
  unlink,
  withArchiveOrdinal,
  yearOf
} from "./edits.js"
export type {
  DeepOptions,
  LlmBudget,
  PhaseBody,
  PhaseEnv,
  PhaseOutcome,
  SleepDeps,
  SleepError
} from "./env.js"
export { DEFAULT_MODELS, emptyOutcome, makeLlmBudget, modelFor, takeLlmCall } from "./env.js"
export type { EdgeDirection, EdgeDirectionalRel, EdgeVerdictRel } from "./llm.js"
export {
  ARC_EXECUTE_SYSTEM,
  ARC_TRIAGE_SYSTEM,
  ArcContent,
  ArcPlan,
  ArcPlanEntry,
  arcExecutePrompt,
  arcTriagePrompt,
  assertsContradiction,
  assertsEdge,
  COMPRESS_INSTRUCTION,
  COMPRESS_SYSTEM,
  CompressSynthesis,
  compressPrompt,
  DEDUP_INSTRUCTION,
  DEDUP_SYSTEM,
  dataBlock,
  dedupPrompt,
  EDGE_CONFIDENCE_FLOOR,
  EDGE_DIRECTIONAL_RELS,
  EDGE_TYPED_RELS,
  EDGE_TYPING_INSTRUCTION,
  EDGE_TYPING_SYSTEM,
  EdgeTyping,
  EdgeVerdict,
  ENTITY_CLUSTER_INSTRUCTION,
  ENTITY_CLUSTER_SYSTEM,
  EntityCluster,
  EntityClustering,
  edgeTypingPrompt,
  entityClusterPrompt,
  isDirectionalRel,
  MergeGroup,
  MergePartition,
  PLACEMENT_CONFIDENCE_FLOOR,
  PLACEMENT_INSTRUCTION,
  PLACEMENT_KEEP,
  PLACEMENT_SYSTEM,
  Placement,
  PlacementTriage,
  pairText,
  placementPrompt,
  TASK_DETECT_INSTRUCTION,
  TASK_DETECT_SYSTEM,
  TaskDetection,
  TaskFinding,
  TaskFindingKind,
  taskDetectPrompt
} from "./llm.js"
export * from "./phases/index.js"
export type { PlanSignal, PlanUnknown, PlanVerdict, SleepPlan } from "./plan.js"
export { plan } from "./plan.js"
export type { GeneratedFile } from "./publish.js"
export {
  generateArtifacts,
  generateIndexes,
  generateSitemap,
  INDEX_FILENAME,
  SITEMAP_FILENAME
} from "./publish.js"
export { renderReport } from "./report.js"
export type { RetentionPass, ScoredMemory } from "./retention.js"
export { ageDaysBetween, hoursBetween, runRetentionPass } from "./retention.js"
export type { MergeOptions } from "./review.js"
export { merge, review } from "./review.js"
export type { RunOptions } from "./run.js"
export {
  completedPhases,
  dateFromRunId,
  describeFailure,
  instantFor,
  parseCounts,
  resume,
  run,
  runIdFor
} from "./run.js"
export type { SleepShape } from "./service.js"
export { layerSleep, makeSleep, Sleep } from "./service.js"
export type {
  AccessRow,
  CorpusRow,
  CorpusSnapshot,
  CorroborationRow,
  DanglingEdge,
  EdgeRow,
  EntityCorroborationRow,
  EntityCount,
  PairRow,
  PhaseRow,
  PublishRow,
  RetentionEdgeCounts,
  RunRow,
  SessionManifestRow,
  UnconsolidatedSession
} from "./sql.js"
export {
  accessRows,
  activeCorpus,
  activeEntities,
  allPaths,
  applyPendingMarks,
  bumpCorroboration,
  bumpEntityCorroboration,
  consolidatedSessionCount,
  corpusSnapshot,
  danglingEdges,
  deepGroupingEdges,
  entityClaims,
  entityVectors,
  frameKeyPairs,
  inboundAuthoredEdges,
  latestRun,
  linkedSessionCount,
  markEntityPromoted,
  markPromoted,
  markSessionsConsolidated,
  memoryEdges,
  minedPairs,
  neighborPairs,
  pathsForEntity,
  publishRows,
  readPhases,
  readRun,
  recentActiveMemories,
  recordPhase,
  recordRun,
  replaceMinedEdges,
  retentionEdgeCounts,
  sessionManifestRows,
  sharedEntityPairs,
  unconsolidatedSessions,
  unlinkedSessionCount
} from "./sql.js"
export type {
  DetectionBudget,
  DetectionEvidence,
  DetectionRequest,
  MintOutcome,
  OpenDetection
} from "./tasks.js"
export {
  budgetFor,
  closeDetectedTask,
  closeVanishedDetections,
  DETECTED_TAG,
  DETECTED_TASK_CAP,
  DETECTED_TASK_DIR,
  DETECTION_DIGEST_CHARS,
  DETECTION_PREFIX,
  DISMISSAL_LOOKBACK_YEARS,
  detectedTaskPath,
  detectionKey,
  detectionKeyOf,
  isDetectedTaskPath,
  MACHINE_CLOSED_TAG,
  makeDetectionBudget,
  mintDetectedTask,
  openDetections
} from "./tasks.js"
export type { TouchedSet } from "./touched.js"
export { isSweepCommit, touchedThisRun } from "./touched.js"
