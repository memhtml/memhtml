/**
 * `session exec --lang`: the two languages a script may be written in.
 *
 * Its own module with no imports, so the command table (`commands.ts`), the argv reader
 * (`run.ts`), and the sandbox (`session-exec.ts`) share one list without the table pulling the
 * sandbox's graph in.
 */

/**
 * The language a `session exec` script is written in.
 *
 * `bash` runs the script text as the shell program itself (`bash.exec(script)`), so a heredoc of
 * `cat`, `grep`, `sed -i`, `find`, and redirections is the script, and `js-exec` is still one command
 * away inside it. `js` runs the text as a module through `js-exec`, which is what `session exec` did
 * before the flag existed and what the curator's `exec` tool sends. The CLI defaults to `bash`
 * because the operator's stated primary path is an agent writing reads and writes as a heredoc;
 * `runSessionExec`'s input takes no default, so no in-process caller changes language silently.
 */
export type ExecLang = "bash" | "js"

/** Every {@link ExecLang}, in the order the manifest lists them. */
export const EXEC_LANGS: ReadonlyArray<ExecLang> = ["bash", "js"]

/** The CLI's `--lang` when the flag is absent. */
export const DEFAULT_EXEC_LANG: ExecLang = "bash"
