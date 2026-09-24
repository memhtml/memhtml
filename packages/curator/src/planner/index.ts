/**
 * The collapse planner: cuts one head view into archive, fold, and keep clusters with no model call.
 * See `plan.ts` for the four cuts and `docs/v2-poc.md`, "Collapse".
 */

export { type Communities, detectCommunities, seededRandom, type WeightedEdge } from "./graph.js"
export {
  ENTITY_EDGE_WEIGHT,
  ENTITY_KEY_CAP,
  frameGroupAgrees,
  frameValueOf,
  homeFor,
  isBucketPrefix,
  isShielded,
  NO_SOURCE,
  type PlanInput,
  planCollapse,
  prefixOf,
  sourceOf
} from "./plan.js"
export { parseRulings, rulingsByPath, VERDICTS } from "./rulings.js"
export {
  comparedText,
  knnEdges,
  MAX_DOCUMENT_FREQUENCY_SHARE,
  MIN_DOCUMENT_FREQUENCY_CAP,
  type SimilarityEdge,
  tfidfVectors
} from "./similarity.js"
export {
  ARCHIVE_CHUNK,
  type ClusterCut,
  type ClusterKind,
  type ClusterMember,
  type CollapseCluster,
  type CollapsePlan,
  DEFAULT_PLANNER_OPTIONS,
  FOLD_FIRST_SESSION_MEMBERS,
  LARGE_GROUP,
  type PlannerOptions,
  type PlanTotals,
  type Ruling,
  type Verdict
} from "./types.js"
