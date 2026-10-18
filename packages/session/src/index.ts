/**
 * `@memhtml/session`: a session's overlay log and the mechanical commit path that lands it on a
 * ref through the session's own git index file. See `docs/v2-poc.md`.
 */

export { checkoutLockTarget, withCheckoutLock } from "./checkout-lock.js"
export {
  archiveBody,
  type CommitOutcome,
  type CommitScope,
  commitMessage,
  commitSession,
  commitSubject,
  type Landing,
  landOnRef,
  type PlumbingFactory
} from "./commit.js"
export { GitFailure } from "./errors.js"
export {
  type ExcludeResult,
  ensureExcluded,
  ensureExcludedQuietly,
  HEAD_SOCKET
} from "./exclude.js"
export { withRepoints } from "./moves.js"
export {
  GIT_REPO_SELECTION_ENV,
  gitPathOf,
  makePlumbing,
  type Plumbing,
  type RefEntry
} from "./plumbing.js"
export {
  type PruneCount,
  type PruneReport,
  pruneSessions,
  type UnlandedSession
} from "./prune.js"
export {
  appendOps,
  DEFAULT_REF,
  decodeLog,
  isSessionId,
  LOG_MOVED,
  rebaseSession,
  replaceOps,
  resumeSession,
  SESSION_ID,
  SESSION_LOCK_STALE_MS,
  SESSION_PENDING,
  SESSION_REFS_PREFIX,
  SESSIONS_DIR,
  type Session,
  saveSession,
  sessionStateFile,
  startSession,
  withSessionLock
} from "./session.js"
export {
  BATCH_CAP,
  isReservedPath,
  touchedPaths,
  UNANCHORED_REASON,
  type ValidateOptions,
  type Violation,
  validateOps,
  writeBarReasons
} from "./validate.js"
