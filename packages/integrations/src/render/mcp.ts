/**
 * Each host's MCP server entry for this store, as the object (or TOML text) the installer merges into
 * the host's own config file.
 *
 * Three shapes for four hosts, from the vendor docs read 2026-09-13: Claude Code and Cursor take
 * `command` plus `args[]` under `mcpServers.<name>`; Codex takes a TOML table `[mcp_servers.<name>]`;
 * OpenCode takes one `command` ARRAY under `mcp.<name>` with `type: "local"` and spells the env table
 * `environment`. Every shape carries the env explicitly, because a GUI host inherits no shell
 * environment and an entry that relies on `MEMHTML_ROOT` being exported works only in a terminal.
 */

import type { CommandLine } from "../types.js"

/** The key this entry is stored under in every host's server map. */
export const MCP_SERVER_KEY = "memhtml"

/** What the installer merges into `mcpServers` for Claude Code and Cursor. */
export interface JsonMcpEntry {
  readonly command: string
  /** Omitted entirely when the command needs no arguments, rather than written as `[]`. */
  readonly args?: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

/** What the installer merges into `mcp` for OpenCode. */
export interface OpenCodeMcpEntry {
  readonly type: "local"
  /** OpenCode's one-array form: the command and its arguments together. */
  readonly command: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string>>
  readonly enabled: boolean
}

/**
 * Claude Code's `mcpServers.memhtml`. `args` is omitted when empty because `claude mcp get` prints the
 * entry back and an empty array reads as a truncated command.
 */
export const claudeMcpEntry = (
  mcp: CommandLine,
  env: Readonly<Record<string, string>>
): JsonMcpEntry =>
  mcp.args.length === 0
    ? { command: mcp.command, env: { ...env } }
    : { command: mcp.command, args: [...mcp.args], env: { ...env } }

/** Cursor's `mcp.json` takes the same object as Claude Code's, key for key. */
export const cursorMcpEntry = (
  mcp: CommandLine,
  env: Readonly<Record<string, string>>
): JsonMcpEntry => claudeMcpEntry(mcp, env)

/** OpenCode's `mcp.memhtml`: one command array, `environment` rather than `env`, explicitly enabled. */
export const opencodeMcpEntry = (
  mcp: CommandLine,
  env: Readonly<Record<string, string>>
): OpenCodeMcpEntry => ({
  type: "local",
  command: [mcp.command, ...mcp.args],
  environment: { ...env },
  enabled: true
})

/** A TOML basic string: only the backslash and the double quote need escaping in the values we write. */
const tomlString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/**
 * Codex's `[mcp_servers.memhtml]` table plus its `env` sub-table, as the text the installer places
 * inside its `# MEMHTML:START` / `# MEMHTML:END` fence in `~/.codex/config.toml`.
 *
 * The env table is a separate `[mcp_servers.memhtml.env]` header rather than an inline table, so a
 * long absolute path never runs past a line the operator has to read. It comes LAST, because every key
 * after a table header belongs to that table.
 */
export const codexMcpToml = (mcp: CommandLine, env: Readonly<Record<string, string>>): string => {
  const lines = [`[mcp_servers.${MCP_SERVER_KEY}]`, `command = ${tomlString(mcp.command)}`]
  if (mcp.args.length > 0) {
    lines.push(`args = [${mcp.args.map(tomlString).join(", ")}]`)
  }
  lines.push("", `[mcp_servers.${MCP_SERVER_KEY}.env]`)
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key} = ${tomlString(value)}`)
  }
  return `${lines.join("\n")}\n`
}
