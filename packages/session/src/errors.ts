import { Schema } from "effect"

/**
 * A git subprocess exited non-zero, or could not be spawned. The same shape as the store's
 * `GitFailure` (`packages/store/src/git.ts`), declared here because this package spawns git itself
 * and does not import `@memhtml/store`. `command` is the subcommand name only, never the argv,
 * because arguments carry memory paths and a failure is returned to an agent.
 */
export class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  command: Schema.String,
  /** The process exit code, or `null` when the process never started. */
  exitCode: Schema.NullOr(Schema.Int)
}) {}
