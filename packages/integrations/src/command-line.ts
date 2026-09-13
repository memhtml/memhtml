/**
 * How a host is told to run this binary: the MCP server, the CLI, one hook, and the POSIX shell string
 * three of the four hosts expect instead of an argv array.
 *
 * Nothing here touches the filesystem or reads env. A `BinaryLocation` is resolved once by the caller
 * (`process.execPath` plus the realpath of each entry script) and every command line in an installed
 * config is derived from it, so one recorded location is the single answer to "which binary did we
 * wire", and `integrations doctor` can compare it against what resolves today.
 */

import type { BinaryLocation, CommandLine, HookEvent, HostId } from "./types.js"

/**
 * The `memhtml` CLI. `bare` writes `memhtml` and leaves resolution to PATH; the default runs the
 * recorded node against the recorded entry script, which is what survives a GUI host with no shell
 * PATH.
 */
export const cliCommand = (binary: BinaryLocation, bare: boolean): CommandLine =>
  bare ? { command: "memhtml", args: [] } : { command: binary.node, args: [binary.cli] }

/** The `memhtml-mcp` stdio server, the command a host's `mcpServers` entry spawns. */
export const mcpCommand = (binary: BinaryLocation, bare: boolean): CommandLine =>
  bare ? { command: "memhtml-mcp", args: [] } : { command: binary.node, args: [binary.mcp] }

/** What a hook command line needs beyond the event: which store, and where transcripts live. */
export interface HookCommandOptions {
  /** The store the hook reads, passed as the global `--repo` so the hook never depends on cwd or env. */
  readonly memhtmlRoot: string
  /** Where this host writes transcripts, when a format exists for it; absent omits the flag. */
  readonly traceRoot?: string
}

/**
 * One installed hook's command line: the CLI, then `hook <event> --host <host> --repo <root>`.
 *
 * `--repo` is always written even though the store could come from `MEMHTML_ROOT`, because a hook is
 * spawned by the host, not by a shell, and three of the four hosts do not pass a shell environment
 * through. `--trace-root` appears only when the caller knows where this host's transcripts land.
 */
export const hookCommand = (
  binary: BinaryLocation,
  bare: boolean,
  event: HookEvent,
  host: HostId,
  opts: HookCommandOptions
): CommandLine => {
  const cli = cliCommand(binary, bare)
  const args = [...cli.args, "hook", event, "--host", host, "--repo", opts.memhtmlRoot]
  if (opts.traceRoot !== undefined) args.push("--trace-root", opts.traceRoot)
  return { command: cli.command, args }
}

/**
 * Characters a POSIX shell leaves alone. Everything else — a space in a path, an apostrophe in a
 * directory name, a `$`, a `;` — forces single quotes.
 */
const SHELL_SAFE = /^[A-Za-z0-9_./:=@%+-]+$/

/**
 * One argument, quoted for `sh`. A single quote cannot be escaped inside single quotes, so it is
 * spliced as `'"'"'`: close, one double-quoted quote, reopen.
 */
export const shellQuote = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`

/**
 * A command line as one shell string. Claude Code, Codex, and Cursor all store a hook as a `command`
 * STRING and run it through a shell, so an unquoted space in the binary path is a two-word command
 * that silently does nothing. The OpenCode plugin gets the argv array instead and never needs this.
 */
export const shellJoin = (line: CommandLine): string =>
  [line.command, ...line.args].map(shellQuote).join(" ")
