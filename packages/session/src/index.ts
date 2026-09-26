/**
 * `@memhtml/session`: a session's overlay log and the mechanical commit path that lands it on a
 * ref through the session's own git index file. See `docs/v2-poc.md`.
 */

export {
  archiveBody,
  type CommitOutcome,
  type CommitScope,
  commitMessage,
  commitSession,
  commitSubject
} from "./commit.js"
export { GitFailure } from "./errors.js"
export { type ExcludeResult, ensureExcluded, ensureExcludedQuietly } from "./exclude.js"
export { GIT_REPO_SELECTION_ENV, gitPathOf, makePlumbing, type Plumbing } from "./plumbing.js"
export {
  appendOps,
  DEFAULT_REF,
  isSessionId,
  rebaseSession,
  resumeSession,
  SESSION_ID,
  SESSIONS_DIR,
  type Session,
  saveSession,
  sessionIndexFile,
  sessionRef,
  sessionStateFile,
  startSession,
  withSessionLock
} from "./session.js"
export {
  BATCH_CAP,
  isReservedPath,
  touchedPaths,
  type ValidateOptions,
  type Violation,
  validateOps,
  writeBarReasons
} from "./validate.js"
