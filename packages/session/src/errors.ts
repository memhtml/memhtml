/**
 * The git failure this package raises is the shared class from `@memhtml/contracts`, re-exported so
 * `import { GitFailure } from "./errors.js"` keeps resolving inside the package and
 * `import { GitFailure } from "@memhtml/session"` keeps resolving outside it. One class, one `_tag`:
 * the store raises the same one, so a caller holding failures from both producers matches them once.
 * `command` is the subcommand name only, never the argv, because arguments carry memory paths and a
 * failure is returned to an agent.
 */
export { GitFailure } from "@memhtml/contracts/errors"
