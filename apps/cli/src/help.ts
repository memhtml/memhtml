import { argLine, flagLine } from "./agents-doc.js"
import { buildManifest, COMMANDS, type CommandSpec, GLOBAL_FLAGS } from "./commands.js"
import { API_VERSION, type ErrorCode } from "./envelope.js"

/**
 * `memhtml help <command>`: one command's entry in the table, projected two ways.
 *
 * Help is a projection of `COMMANDS`, the same array that drives parsing, `memhtml manifest`, and
 * `AGENTS.md`, so it cannot describe a flag the binary does not accept. Nothing here opens a repo, a
 * database, or the network: the module imports the table and the envelope constants and nothing else,
 * which is what lets `memhtml search --help` answer on a machine with no store.
 *
 * Two shapes for two readers. A person at a terminal gets Markdown; a program gets the `cli.help`
 * envelope, whose `data` is the manifest's own entry for the command plus the fields a manifest reader
 * would otherwise derive (`usage`, `seeAlso`, the global flags, the usage-error codes). The selection
 * rule lives in `run.ts`; this module only renders.
 */

/**
 * The codes the parser and validator can return for ANY command before it runs.
 *
 * Listed here rather than per command because the table does not hold per-command error codes and
 * help must not invent them: a runtime failure's code depends on what failed, not on which command
 * was called, and the full append-only list is `memhtml manifest`'s `errorCodes`.
 */
export const USAGE_ERROR_CODES: ReadonlyArray<ErrorCode> = [
  "ERR_UNKNOWN_COMMAND",
  "ERR_MISSING_ARGUMENT",
  "ERR_INVALID_FLAG",
  "ERR_UNEXPECTED_ARGUMENT"
]

/**
 * `memhtml search <query> [flags]`, generated from the spec so it cannot name an argument it lacks.
 * `[flags]` is always present: the global flags apply to every command, so a command with no flags of
 * its own still takes `--dense`, `--repo`, and `--help`.
 */
export const usageOf = (spec: CommandSpec): string => {
  const args = spec.args.map((arg) => {
    const placeholder = arg.required ? `<${arg.name}>` : `[${arg.name}]`
    return arg.repeatable === true ? `${placeholder}...` : placeholder
  })
  return ["memhtml", spec.name, ...args, "[flags]"].join(" ")
}

/**
 * Sibling commands, in table order: the ones sharing this command's noun (`index rebuild` lists
 * `index status`) and the ones emitting one of its response types. Derived, never authored, so a new
 * `index` verb appears in its siblings' help at the commit that adds it.
 */
export const seeAlsoOf = (spec: CommandSpec): ReadonlyArray<string> => {
  const noun = spec.name.split(" ")[0] ?? spec.name
  const compound = spec.name.includes(" ")
  return COMMANDS.filter(
    (candidate) =>
      candidate.name !== spec.name &&
      ((compound && candidate.name.startsWith(`${noun} `)) ||
        candidate.responseTypes.some((type) => spec.responseTypes.includes(type)))
  ).map((candidate) => candidate.name)
}

/** The `cli.help` payload: the manifest's entry for the command, plus what a reader would derive. */
export const helpData = (spec: CommandSpec) => {
  const entry = buildManifest().commands.find((command) => command.name === spec.name)
  if (entry === undefined) throw new Error(`${spec.name} is not in the manifest it was read from`)
  return {
    ...entry,
    usage: usageOf(spec),
    globalFlags: GLOBAL_FLAGS,
    usageErrorCodes: USAGE_ERROR_CODES,
    seeAlso: seeAlsoOf(spec)
  }
}

export type HelpData = ReturnType<typeof helpData>

/**
 * The Markdown a terminal gets. Sections in reading order: what to type, what it does, what each
 * part means, what comes back, what can refuse, examples, neighbours. Rendered with the same
 * per-argument and per-flag lines as `AGENTS.md`, so the two documents describe a flag identically.
 *
 * Plain Markdown, no ANSI: it reads in any terminal, under `NO_COLOR`, and in a pager, and a reader
 * who wants styling pipes it through the renderer they already have. Deterministic to the byte for
 * the same reason `AGENTS.md` is.
 */
export const renderCommandHelp = (spec: CommandSpec): string => {
  const lines: Array<string> = []
  lines.push(`# memhtml ${spec.name}`)
  lines.push("")
  lines.push(spec.summary)
  lines.push("")
  lines.push("## Usage")
  lines.push("")
  lines.push("```")
  lines.push(usageOf(spec))
  lines.push("```")
  lines.push("")
  if (spec.args.length > 0) {
    lines.push("## Arguments")
    lines.push("")
    lines.push("`<required>` `[optional]`; a trailing `...` in the usage line means it may repeat.")
    lines.push("")
    for (const arg of spec.args) lines.push(argLine(arg))
    lines.push("")
  }
  if (spec.flags.length > 0) {
    lines.push("## Flags")
    lines.push("")
    for (const flag of spec.flags) lines.push(flagLine(flag))
    lines.push("")
  }
  lines.push("## Global flags")
  lines.push("")
  for (const flag of GLOBAL_FLAGS) lines.push(flagLine(flag))
  lines.push("")
  lines.push("## Response")
  lines.push("")
  lines.push(
    `One JSON envelope on stdout: \`{ "apiVersion": "${API_VERSION}", "type": ${spec.responseTypes
      .map((type) => `"${type}"`)
      .join(" | ")}, "data": { } }\`. Logs go to stderr.`
  )
  lines.push("")
  lines.push("## Errors")
  lines.push("")
  lines.push(
    `A failure is \`{ "apiVersion": "${API_VERSION}", "error": "<prose>", "code": "<ERROR_CODE>", "suggestions": [] }\`; branch on \`code\`. Exit 2 with one of ${USAGE_ERROR_CODES.map((code) => `\`${code}\``).join(", ")} when the call itself is wrong; exit 1 with a runtime code from \`memhtml manifest\`'s \`errorCodes\` when the call was fine and the work failed.`
  )
  lines.push("")
  const examples = spec.examples ?? []
  if (examples.length > 0) {
    lines.push("## Examples")
    lines.push("")
    lines.push("```sh")
    for (const example of examples) lines.push(example)
    lines.push("```")
    lines.push("")
  }
  const seeAlso = seeAlsoOf(spec)
  if (seeAlso.length > 0) {
    lines.push("## See also")
    lines.push("")
    for (const name of seeAlso) lines.push(`- \`memhtml help ${name}\``)
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}
