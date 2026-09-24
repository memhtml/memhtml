/**
 * `@memhtml/cli`: the `memhtml` binary, and the composition root the MCP server shares.
 *
 * The layer graph lives here rather than in each app because a second composition would be a second
 * set of decisions about which database file, which git root, and which vector space. The two apps
 * must be looking at exactly one of each. `apps/mcp` imports `layerApp` and the operations from
 * this package for that reason.
 */

export type { AgentsDocResult } from "./agents-doc.js"
export { AGENTS_DOC_PATH, renderAgentsDoc, runAgentsDoc } from "./agents-doc.js"
export type {
  EmbedderShape,
  ExtractorPortShape,
  RetrievalPolicyShape,
  RootsShape
} from "./api-layer.js"
export {
  DatabaseService,
  Embedder,
  Embeddings,
  ExtractorPort,
  Git,
  Indexer,
  IndexGit,
  IndexRecorder,
  layerApp,
  layerAppWith,
  layerCore,
  layerDatabase,
  layerEmbedder,
  layerEmbedderFrom,
  layerExtractorFrom,
  layerExtractorPort,
  layerGit,
  layerIndexer,
  layerIndexGit,
  layerRecorder,
  layerRetrieval,
  layerRetrievalPolicy,
  layerRetrievalPolicyFrom,
  layerRoots,
  layerStore,
  ModelClient,
  Retrieval,
  RetrievalPolicy,
  Roots,
  Store
} from "./api-layer.js"
export { applyPayload, applyText, decodeApply, readStdin } from "./apply.js"
export {
  type ArgSpec,
  buildManifest,
  COMMAND_NAMES,
  COMMANDS,
  type CommandSpec,
  type FlagSpec,
  GLOBAL_FLAGS,
  GUIDE,
  GUIDE_OP_EXAMPLE,
  GUIDE_TOPICS,
  type GuideBlock
} from "./commands.js"
export { CONFIG_VARS, type ConfigVar, MemhtmlRoot, TraceRoot } from "./config.js"
export {
  bindTools,
  COMMIT_ATTEMPTS,
  CURATE_REF_PREFIX,
  CURATE_REF_ROOT,
  type CurateRunInput,
  type CurateRunReport,
  commitSummary,
  curateRefProblem,
  curateRun,
  curateSessionId,
  defaultCurateRef,
  memoryOverlay,
  type OpsByKind,
  type Overlay
} from "./curate-run.js"
export {
  API_VERSION,
  ERROR_CODES,
  type ErrorCode,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  type Failure,
  fail,
  nearest,
  RESPONSE_TYPES,
  type ResponseType,
  render,
  type Success,
  succeed
} from "./envelope.js"
export { codeFor, failureFor, messageFor, SUGGESTIONS, suggestionsFor } from "./errors.js"
/**
 * Code-mode's runtime. Exported for the test tier, which drives `runExec` against a plain directory to
 * assert the sandbox's own properties without a git repository in the way, and `execCommand` to assert
 * the pin. Nothing outside this package imports either on a read path. See `exec.ts` on why
 * `just-bash` arrives dynamically.
 */
export {
  CORPUS_MOUNT,
  cutOffByTheRuntime,
  DEFAULT_TIMEOUT_MS,
  type ExecInput,
  type ExecReport,
  execCommand,
  MAX_TIMEOUT_MS,
  readScript,
  runExec
} from "./exec.js"
export type { EntityExtractorShape, ExtractionAnswer, ExtractionItem } from "./extraction.js"
export {
  EXTRACTION_MODEL,
  EXTRACTION_MODEL_ID,
  entitiesFrom,
  extractionPrompt,
  INSTRUCTIONS as EXTRACTION_INSTRUCTIONS,
  makeEntityExtractor,
  RESPONSE_SCHEMA as EXTRACTION_RESPONSE_SCHEMA
} from "./extraction.js"
export {
  type AncestorSnapshot,
  findAncestorSnapshot,
  type HeadSource,
  type LoadedVersion,
  loadVersion,
  type SnapshotWritten,
  snapshotAfterCommit,
  writeHeadSnapshot
} from "./head-cache.js"
export {
  type GateFailure,
  type GateOutcome,
  gateReportOf,
  type HeadLoader,
  headGate,
  isHeadGateReport
} from "./head-gate.js"
export * from "./operations.js"
export { claimFromProse, proseTail } from "./prose.js"
export {
  ARTICLE_EDIT_REASON,
  type CurateDelta,
  commitSubjectOf,
  type DiffEntry,
  mergeBase,
  parseDiffTreeRaw,
  type Reconstruction,
  type ReplayRejection,
  readCurateDelta,
  reconstructOps
} from "./replay.js"
export { type Parsed, parseArgv, type RunResult, run } from "./run.js"
export { MCP_BIN_VAR, mcpEntryPoint, type ServeResult, serveMcp } from "./serve.js"
export {
  type CurateMerged,
  curateMerge,
  type GateReport,
  type HeadStats,
  headSearch,
  headSnapshot,
  headStats,
  headStatus,
  type LoadedHead,
  loadHeadAt,
  MERGE_ATTEMPTS,
  qualifyRef,
  type ReplayReport,
  runV2,
  sessionCommit,
  sessionExec,
  sessionPut,
  sessionRebase,
  sessionStart,
  sessionStatus,
  type V2Input
} from "./v2.js"
export { indexReport } from "./views.js"
