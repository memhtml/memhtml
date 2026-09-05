/**
 * `@memhtml/index` is the rebuildable SQLite plane: schema, indexer, four-arm RRF retrieval, the
 * state plane, and the trace-plane persistence half.
 *
 * `index.db` is a projection of the git tree and is deleted and rebuilt without loss. `state.db` is
 * ATTACHed over the same connection and holds the one set of facts git cannot reproduce.
 */

export { type Chunk, chunkIdFor, chunkText } from "./chunking.js"
export {
  attachState,
  DatabaseService,
  type DatabaseShape,
  makeDatabase,
  runStateMigrations,
  type SqlValue,
  type Write
} from "./database.js"
export {
  ARC_BODY_BUDGET,
  budgetFor,
  type DisclosedEntry,
  type DisclosureCandidate,
  type DisclosureFold,
  foldDisclosure,
  type IndexLine,
  MAX_PER_ENTITY,
  MEMORY_BODY_BUDGET
} from "./disclosure.js"
export type { FtsQueryForms } from "./fts-query.js"
export { ftsQueryForms, hasFtsTerms, sanitizeFtsQuery } from "./fts-query.js"
export {
  type GitAdapterDeps,
  makeGitPort,
  type StoreGitShape
} from "./git-adapter.js"
export {
  type DiffEntry,
  type GitPort,
  IndexGit,
  type StatusEntry,
  type TreeEntry
} from "./git-port.js"
export { IndexStateRow, readIndexState } from "./index-state.js"
export {
  type BackfillReport,
  EmbedModelMismatch,
  type EmbedPort,
  GENERATED_NAMES,
  Indexer,
  type IndexerDeps,
  type IndexerShape,
  IndexStale,
  isIndexablePath,
  makeIndexer,
  RebuildNoEmbedRefused,
  type RebuildReport,
  TREE_PREFIXES,
  type UpdateReport
} from "./indexer.js"
export {
  authoredEdgesFor,
  disclosureTextFor,
  entityRowsFor,
  FILE_COLUMNS,
  type FileProjection,
  ftsTextFor,
  projectFile,
  wordCountOf,
  workspaceOf
} from "./project.js"
export {
  OUTCOME_EWMA_ALPHA,
  REINFORCE_PATH_BATCH,
  type ReinforceResult,
  reinforce
} from "./reinforce.js"
export {
  DEFAULT_ARM_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MMR_POOL_FACTOR,
  makeRetrieval,
  type QueryEmbedPort,
  type RecallInput,
  type RecallPack,
  Retrieval,
  type RetrievalDeps,
  type RetrievalShape,
  type SearchHit,
  type SearchInput,
  type SearchResult
} from "./retrieval.js"
export {
  type ArmHoles,
  activeArms,
  buildRrfSql,
  buildSnippetSql,
  PARAM_ARM_LIMIT,
  PARAM_FINAL_LIMIT,
  PARAM_QUERY,
  PARAM_QUERY_VECTOR,
  RANK_ARMS,
  type RankArm,
  type RrfOptions,
  SALIENCE_EXCLUDED_PREFIX,
  SALIENCE_EXCLUDED_TYPE,
  truncateSnippet
} from "./retrieval-sql.js"
export {
  CHUNK_MAX_CHARS,
  FTS_COLUMN,
  FTS_INDEX_NAME,
  INDEX_STATE_ID,
  MEMORY_TABLES,
  MIGRATIONS_DIR,
  SNIPPET_MAX_CHARS,
  STATE_MIGRATIONS_DIR,
  STATE_SCHEMA,
  STATE_TABLES,
  TRACE_TABLES,
  WRITE_BATCH_SIZE
} from "./schema-const.js"
export {
  type AssembledScope,
  assembleScope,
  EXCLUDED_BY_DEFAULT,
  FACET_SEPARATOR,
  type FacetFilter,
  facetConditions,
  parseFacetFilter,
  parseFacetFilters,
  type SearchScope
} from "./scope.js"
export {
  type FrameMatch,
  IndexRecorder,
  type IndexRecorderShape,
  LINK_KINDS,
  type LinkKind,
  makeIndexRecorder,
  type NearMatch,
  type PersistOutcome,
  type PromptRowLike,
  persistScanned,
  readStoredExtract,
  readWatermark,
  type ScannedFileLike,
  type SessionExtractLike,
  type SessionLink,
  type TailMerger,
  type WatermarkLike,
  writeWatermark
} from "./traces-persist.js"
