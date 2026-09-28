/**
 * `@memhtml/head`: the corpus as a value. One immutable version per commit, held as persistent
 * `effect` structures, advanced by delta, read through `HeadView`, searched by RRF over a lexical
 * and (given vectors) a vector arm, with recency breaking exact ties.
 * See `docs/v2-poc.md`.
 */

export type {
  HeadGateInversion,
  HeadGateOptions,
  HeadGateProbe,
  HeadGateReport,
  HeadGateResult
} from "./gate.js"
export {
  describeHeadGateFailure,
  gateHeads,
  HEAD_GATE_K,
  HEAD_GATE_PROBES,
  HEAD_GATE_SEED,
  HEAD_GATE_TOLERANCE,
  HeadGateFailed,
  probeQueryFor,
  probesFor,
  scoreProbes
} from "./gate.js"
export type { Indexes } from "./indexes.js"
export { emptyIndexes, indexesOf, insertRecord, removeRecord, viewOf } from "./indexes.js"
export type { LexicalIndex } from "./lexical.js"
export { STOP_WORDS, tokenize } from "./lexical.js"
export { withOverlay } from "./overlay.js"
export { blobShaOf, isArchivedPath, recordFrom } from "./record.js"
export type { HeadVectors, SearchArm, SearchHeadInput, SearchHit } from "./search.js"
export {
  DEFAULT_LIMIT,
  LEXICAL_ARM_LIMIT,
  LEXICAL_WEIGHT,
  searchHead,
  VECTOR_ARM_LIMIT,
  VECTOR_WEIGHT
} from "./search.js"
export type {
  DocumentEmbedder,
  FillCounts,
  FillResult,
  VectorCache,
  VectorSpace
} from "./vectors.js"
export { emptyVectorCache, fillVectors, VECTOR_TEXT_MAX_CHARS, vectorTextOf } from "./vectors.js"
export type { HeadVersion, SkippedFile } from "./version.js"
export { advanceHead, isCandidatePath, loadHead, versionFromRecords } from "./version.js"
