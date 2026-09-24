/**
 * `@memhtml/curator`: the curator memhtml itself owns. A bounded `generateText` tool loop over an
 * injected tool set (`CuratorTools`), the charter it runs under, the budget it runs inside, and the
 * model factory behind `--model`. The binder that gives it a real head, session, and sandbox is
 * `apps/cli/src/curate-run.ts`. See `docs/v2-poc.md`, "Curator".
 */

export {
  BRIEFING_GROUP_CAP,
  BRIEFING_LOW_CAP,
  type Briefing,
  briefingFromView,
  type ContradictionGroup,
  type DuplicateGroup,
  type FrameKeyMember,
  HEADLINE_CLAIM_TYPES,
  INBOX_PREFIX,
  type LowConfidenceRecord,
  parseBriefing,
  renderBriefing
} from "./briefing.js"
export { budgetWith, type CuratorBudget, DEFAULT_BUDGET } from "./budget.js"
export {
  CHARTER_PATH,
  CHARTER_RULE_COUNT,
  CHARTER_URL,
  COLLAPSE_CHARTER,
  COLLAPSE_CHARTER_PATH,
  COLLAPSE_CHARTER_RULE_COUNT,
  COLLAPSE_CHARTER_URL,
  CURATOR_CHARTER,
  DATA_NOT_INSTRUCTIONS
} from "./charter.js"
export {
  type CollapseBriefing,
  type CollapseBriefingMember,
  collapseBriefingOf,
  isoSecondOf,
  parseCollapseBriefing,
  type RenderCollapseInput,
  renderCollapseBriefing
} from "./collapse-briefing.js"
export { CuratorModelSpecInvalid } from "./errors.js"
export {
  FAKE_MODEL_ID,
  FAKE_PROVIDER,
  fakeCanonicalHtml,
  fakeCanonicalPath,
  fakeCollapseProposal,
  fakeCuratorModel,
  fakeDedupScript,
  fakeNextCall
} from "./fake-model.js"
export {
  type CuratorRun,
  type CuratorRunInput,
  runCurator,
  type StoppedBy,
  TOOL_RESULT_CAP,
  TRUNCATION_MARKER,
  truncateToolResult
} from "./loop.js"
export {
  CURATOR_MODEL_VAR,
  type CuratorModelOptions,
  type CuratorModelSpec,
  curatorModel,
  DEFAULT_CURATOR_MODEL_ID,
  MODEL_SPEC_PREFIXES,
  modelSpecOf,
  parseModelSpec,
  withOutputCeiling
} from "./model.js"
export * from "./planner/index.js"
export {
  archivePathFor,
  type CuratorExecResult,
  type CuratorProposeResult,
  type CuratorRecordView,
  type CuratorSearchHit,
  type CuratorSessionStatus,
  type CuratorTools,
  type OpSummary,
  ProposedOp,
  toOverlayOps
} from "./tools.js"
