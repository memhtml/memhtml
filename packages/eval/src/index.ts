/**
 * `@memhtml/eval` — the fixture corpus generator and the refusable discrimination gate.
 *
 * A package of its own rather than a directory inside `@memhtml/index`, because the harness builds a REAL
 * git repository and renders real memory files: it needs `@memhtml/store` and `@memhtml/html` at runtime, and
 * `@memhtml/index` lists the store as a devDependency on purpose — it declares its own `memhtml/IndexGit` port
 * instead. Promoting git-subprocess code to a runtime dependency of the projection layer to host an
 * eval harness would invert that. The arrow still points inward: this package depends on the six below
 * it, and `apps/cli` depends on this one.
 *
 * The corpus is never committed. `corpus.ts` is a pure function of a seed, so a fixture is regenerated
 * on demand and two runs at one seed are byte-identical — which is what makes a change in the gate's
 * numbers mean the ranking changed rather than the corpus.
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
