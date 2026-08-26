/**
 * `@memhtml/store` is the git-backed file store. Every operation that changes the corpus is one
 * commit, and every git failure is a typed value.
 *
 * The tree is the system of record, and `.memhtml/index.db` is derived from it. That is what makes the
 * store the only writer. An operation that changed a file without committing would leave the
 * index describing a state git does not have, and `git status` is what tells the indexer so.
 */

/**
 * PARA's four buckets are owned by `@memhtml/contracts` and re-exported here, not restated. Two
 * copies of a closed vocabulary drift the moment one is edited, and the `files.para` CHECK
 * constraint already restates this set once in SQL. A third copy would be a third thing to
 * keep in agreement.
 */
export { PARA_BUCKETS, type ParaBucket } from "@memhtml/contracts/types"
export {
  Git,
  GitFailure,
  type GitShape,
  layerGit,
  type MergeOutcome,
  makeGit,
  type Trailers,
  type UnmergedStage
} from "./git.js"
export type { InitResult } from "./layout.js"
export {
  attemptIo,
  GITATTRIBUTES,
  GITIGNORE,
  INDEX_DB_PATH,
  initRepo,
  MEMHTML_DIR,
  MERGE_OURS_DRIVER,
  README,
  readFileOrNull,
  SCAFFOLD_DIRS,
  SLEEP_REPORTS_DIR,
  STATE_DB_PATH,
  STATE_SIDECAR_PATH
} from "./layout.js"
export type {
  ChangedPath,
  ChangeKind,
  MemhtmlOperation,
  StatusEntry,
  StatusKind,
  TrailerRecord,
  TreeEntry
} from "./plumbing.js"
export {
  COMMIT_SUBJECT_MAX,
  commitSubject,
  PROMPT_TRAILER,
  parseCatFileBatch,
  parseDiffNameStatus,
  parseLsTree,
  parseNulPathList,
  parseStatusPorcelainV2,
  parseTrailerLog,
  provenanceTrailers,
  SESSION_TRAILER,
  TRAILER_FIELD_CHAR,
  TRAILER_FIELD_SEPARATOR,
  TRAILER_RECORD_SEPARATOR
} from "./plumbing.js"
export type {
  ArchiveResult,
  BatchOpResult,
  BatchWriteResult,
  CorrectResult,
  DedupeLookup,
  MoveCallback,
  ReadResult,
  StoreError,
  StoreHooks,
  StoreShape,
  SupersedeResult,
  WriteInput,
  WriteProvenance,
  WriteResult
} from "./store.js"
export { expandRoot, isoSecond, makeStore, Store } from "./store.js"
