/**
 * `@memhtml/sleep` — the nightly curation cycle as fifteen git commits.
 *
 * Every phase is its own commit on `sleep/<date>`, carrying a `Memhtml-Run`/`Memhtml-Phase`/`Memhtml-Counts`
 * trailer block. The trailers are what `resume` reads, so no journal table is load-bearing and the git
 * history alone can say what a run already did. A failed phase keeps every prior commit and lets the
 * later phases run; `git branch -D` is the abort, and `main` never moved.
 */

export { commitPhase, phaseTrailers } from "./commit.js"
export type {
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
  dependentsOf,
  HARD_PREREQUISITES,
  isSleepPhase,
  LLM_PHASES,
  NON_COMMITTING_PHASES,
  phaseIndexOf,
  SLEEP_PHASES,
  TRAILER_COUNTS,
  TRAILER_PHASE,
  TRAILER_RUN
} from "./contract.js"
export type { HeadEdit } from "./edits.js"
export {
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
  yearOf
} from "./edits.js"
export type { PhaseBody, PhaseEnv, PhaseOutcome, SleepDeps, SleepError } from "./env.js"
export { DEFAULT_MODELS, emptyOutcome, modelFor } from "./env.js"
export type { LlmFailure, StanceVerdict } from "./llm.js"
export {
  ARC_EXECUTE_SYSTEM,
  ARC_TRIAGE_SYSTEM,
  ArcContent,
  ArcPlan,
  ArcPlanEntry,
  arcExecutePrompt,
  arcTriagePrompt,
  assertsContradiction,
  COMPRESS_SYSTEM,
  CompressSynthesis,
  compressPrompt,
  dataBlock,
  isolate,
  STANCE_CONFIDENCE_FLOOR,
  STANCE_SYSTEM,
  StanceJudgment,
  stancePrompt
} from "./llm.js"
export * from "./phases/index.js"
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
  bumpCorroboration,
  conflictCandidates,
  consolidatedSessionCount,
  corpusSnapshot,
  danglingEdges,
  latestRun,
  linkedSessionCount,
  markPromoted,
  markSessionsConsolidated,
  memoryEdges,
  neighbourPairs,
  pathsForEntity,
  publishRows,
  readPhases,
  readRun,
  recordPhase,
  recordRun,
  replaceMinedEdges,
  retentionEdgeCounts,
  sessionManifestRows,
  unconsolidatedSessions,
  unlinkedSessionCount
} from "./sql.js"
