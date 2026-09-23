/**
 * `@memhtml/session`: a session's overlay log and the mechanical commit path that lands it on a
 * ref through the session's own git index file. See `docs/v2-poc.md`.
 */

export { type CommitOutcome, commitMessage, commitSession, commitSubject } from "./commit.js"
export { GitFailure } from "./errors.js"
export { GIT_REPO_SELECTION_ENV, makePlumbing, type Plumbing } from "./plumbing.js"
export {
  appendOps,
  DEFAULT_REF,
  rebaseSession,
  resumeSession,
  SESSIONS_DIR,
  type Session,
  saveSession,
  sessionIndexFile,
  sessionRef,
  sessionStateFile,
  startSession
} from "./session.js"
export {
  BATCH_CAP,
  isReservedPath,
  touchedPaths,
  type Violation,
  validateOps
} from "./validate.js"
