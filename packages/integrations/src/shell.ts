/**
 * The shell snippet `integrations shell` prints, and where `--write` would put it.
 *
 * This is for the HUMAN running `memhtml` by hand. Every installed host config already carries its own
 * absolute command and its own `MEMHTML_ROOT`, so no host depends on a shell change ever happening —
 * which is why the snippet is opt-in and why it is printed before it is written.
 */

import { join } from "node:path"

export interface ShellSnippetOptions {
  /** The store, absolute. */
  readonly memhtmlRoot: string
  /** The directory holding the `memhtml` and `memhtml-mcp` binaries, absolute. */
  readonly binDir: string
}

/** A value inside a double-quoted shell string: the four characters the shell still reads there. */
const doubleQuoted = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")

/**
 * Two exports and two comments. The PATH line is guarded with a `case` on `:$PATH:` rather than appended
 * unconditionally, because an rc file is sourced once per shell and a nested shell would otherwise
 * accumulate the same directory over and over.
 */
export const renderShellSnippet = (opts: ShellSnippetOptions): string => {
  const root = doubleQuoted(opts.memhtmlRoot)
  const bin = doubleQuoted(opts.binDir)
  return [
    "# The memhtml store every memhtml command and MCP server reads by default.",
    `export MEMHTML_ROOT="${root}"`,
    "# Put this memhtml on PATH once, however many times this file is sourced.",
    `case ":$PATH:" in *":${bin}:"*) ;; *) export PATH="${bin}:$PATH";; esac`,
    ""
  ].join("\n")
}

/**
 * The rc file to append to, from `$SHELL`. zsh reads `~/.zshrc` for interactive shells and bash reads
 * `~/.bashrc`; an unknown or absent `$SHELL` gets `~/.bashrc`, which is the safer guess because bash is
 * the shell a script inherits.
 */
export const rcFileFor = (shell: string | undefined, home: string): string =>
  shell?.endsWith("zsh") === true ? join(home, ".zshrc") : join(home, ".bashrc")
