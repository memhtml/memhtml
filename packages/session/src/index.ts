/**
 * `@memhtml/session`: a session's overlay log and the mechanical commit path that lands it on a
 * ref through a temporary git index. See `docs/design.md` §17.
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
  type PlumbingFactory,
  RESTATEMENT_REASONS,
  type RestatementReason
} from "./commit.js"
export { GitFailure } from "./errors.js"
export {
  type ExcludeResult,
  ensureExcluded,
  ensureExcludedQuietly,
  HEAD_SOCKET
} from "./exclude.js"
export { afterDroppedVacates, missingRepoints, type VacateFollower, withRepoints } from "./moves.js"
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
  OverlayOpSchema,
  rebaseSession,
  replaceOps,
  resumeSession,
  SESSION_ID,
  SESSION_LOCK_STALE_MS,
  SESSION_PENDING,
  SESSION_REFS_PREFIX,
  SESSIONS_DIR,
  type Session,
  type SessionLockOptions,
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
