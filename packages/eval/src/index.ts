/**
 * `@memhtml/eval` holds the fixture corpus generator and the refusable discrimination gate.
 *
 * A package of its own rather than a directory inside `@memhtml/index`, because the harness builds a REAL
 * git repository and renders real memory files. It needs `@memhtml/store` and `@memhtml/html` at runtime, and
 * `@memhtml/index` lists the store as a devDependency on purpose, declaring its own `memhtml/IndexGit` port
 * instead. Promoting git-subprocess code to a runtime dependency of the projection layer to host an
 * eval harness would invert that. The arrow still points inward, since this package depends on the six
 * below it, and `apps/cli` depends on this one.
 *
 * The corpus is never committed. `corpus.ts` is a pure function of `(seed, now)`, so a fixture is
 * regenerated on demand and two runs at one seed on one day are byte-identical. That is what makes a
 * change in the gate's numbers mean the ranking changed rather than the corpus.
 */

export type { ClaimText, DerivedControl, DivergenceFamily, VariantOptions } from "./controls.js"
export {
  DIVERGENCE_FAMILIES,
  deriveControl,
  familyPredicate,
  negationFlip,
  numericFlip,
  variantFlip,
  wholeText
} from "./controls.js"
export type { CorpusSpec, MemorySpec, Probe } from "./corpus.js"
export {
  articleFor,
  buildCorpus,
  DEFAULT_CORPUS_SIZE,
  DEFAULT_PROBE_COUNT,
  DEFAULT_SEED,
  quantizeNow,
  queryFor
} from "./corpus.js"
export type {
  DiscriminationReport,
  EvalMode,
  FloorReport,
  ProbeResult
} from "./discriminate.js"
export {
  describeFailure,
  discriminate,
  MRR_FLOOR,
  PROBE_LIMIT,
  runFloor,
  runProbes,
  summarize
} from "./discriminate.js"
export type { FixtureCorpus, FixtureOptions } from "./fixture.js"
export { makeFixtureCorpus, memoryFileFor, writeCorpus } from "./fixture.js"
export type { EvalEmbedder, EvalStack, StackOptions } from "./harness.js"
export {
  buildStack,
  FAKE_DIM,
  failingEmbedder,
  fakeEmbedder,
  fakeVector,
  liveEmbedder,
  withStack
} from "./harness.js"
export type { EvalOptions, EvalOutcome } from "./run.js"
export {
  BEDROCK_TOKEN_VAR,
  DiscriminationFailed,
  discriminationGate,
  hasBedrockCredentials,
  runDiscrimination
} from "./run.js"
export type { FixtureTranscript, LabeledCandidate, WritePathLabel } from "./write-path-corpus.js"
export {
  BATCH_SESSION_IDS,
  CEILINGS,
  KNOWN_GAP_CLASSES,
  MANY_SPANS,
  padTo,
  SESSION_A,
  SESSION_B,
  SESSION_OUTSIDE_BATCH,
  TRANSCRIPT_A,
  TRANSCRIPT_B,
  TRANSCRIPTS,
  WRITE_PATH_CORPUS
} from "./write-path-corpus.js"
export type { GateBatch, GateDecision, GateStage } from "./write-path-gate.js"
export { admitCandidate, GATE_STAGES } from "./write-path-gate.js"
export type {
  ClassBreakdown,
  ConfusionMatrix,
  LabeledDecision,
  WritePathReport
} from "./write-path-metrics.js"
export {
  agrees,
  breakdownByClass,
  confusionOf,
  describeWritePath,
  summarizeWritePath
} from "./write-path-metrics.js"
export type {
  FrozenDecision,
  ReplayDrift,
  WritePathManifest,
  WritePathOptions
} from "./write-path-run.js"
export {
  corpusSha256,
  decideAll,
  GATE_SOURCES,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  manifestFor,
  readManifest,
  replayDrift,
  runWritePathDiscrimination,
  transcriptsSha256,
  WRITE_PATH_BASELINE_F1,
  WRITE_PATH_F1_FLOOR,
  withBatch,
  writeManifest
} from "./write-path-run.js"
