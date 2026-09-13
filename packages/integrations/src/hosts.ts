/**
 * The registry: for one host and one scope, exactly which absolute paths install touches and how each
 * one is edited.
 *
 * Every vendor fact about WHERE a host keeps its config lives here and nowhere else — the transaction
 * layer reads a `HostSpec` and knows only "a JSON key", "a TOML fence", "a Markdown block", "a whole
 * file". That split is what makes a fifth host a table entry rather than a new branch in install,
 * uninstall, list, and doctor.
 *
 * The paths are the vendor docs read 2026-09-13, and the asymmetries in the table are vendor limits
 * rather than choices: Cursor has no user-level instruction file this build writes (its rules are a
 * project directory), OpenCode has no hooks file at all (its hook system is a plugin), and Codex keeps
 * MCP servers in the same `config.toml` an operator hand-tunes, which is why that one entry is a fenced
 * region instead of a parsed table.
 */

import { join } from "node:path"

import { isDirectory } from "./fs.js"
import { CURSOR_HOOKS_VERSION } from "./render/hooks.js"
import { MCP_SERVER_KEY } from "./render/mcp.js"
import { OPENCODE_PLUGIN_FILE } from "./render/plugin.js"
import { SKILL_DIR_NAME } from "./render/skill.js"
import { HOSTS, type HostId, type Scope } from "./types.js"

/**
 * Where a host's MCP server entry goes, and what kind of document it is.
 *
 * `json` carries the key path the entry lands at, so the transaction layer never spells a vendor's
 * key. `toml-fence` carries the table NAME instead, which is what `hasUnfencedTable` needs to refuse a
 * hand-written twin of our entry: the fence cannot see structure, so the collision check is by name.
 */
export type McpTarget =
  | {
      readonly format: "json"
      readonly file: string
      readonly keyPath: ReadonlyArray<string>
    }
  | {
      readonly format: "toml-fence"
      readonly file: string
      readonly table: string
    }

/**
 * Where a host's hooks go.
 *
 * `json-arrays` is Claude Code, Codex, and Cursor: one object under `keyPath` whose keys are the
 * host's own event names and whose values are arrays install appends to entry by entry. `versionKey`
 * is Cursor's `{"version": 1}` preamble, which the file needs and which is not an array.
 *
 * `plugin-file` is OpenCode, where the hook surface is a JavaScript module install generates whole.
 */
export type HooksTarget =
  | {
      readonly format: "json-arrays"
      readonly file: string
      readonly keyPath: ReadonlyArray<string>
      /** A scalar the file must carry beside the hooks, when the host versions its hooks file. */
      readonly versionKey?: { readonly keyPath: ReadonlyArray<string>; readonly value: number }
    }
  | {
      readonly format: "plugin-file"
      readonly file: string
    }

/**
 * Where the instruction prose goes.
 *
 * `markdown-block` is a fenced region inside a file the operator also writes. `cursor-rules` is a
 * whole file of ours, because Cursor reads `.cursor/rules/*.mdc` and each rule file is one rule with
 * its own frontmatter — there is nothing to merge into.
 *
 * `agentsFile` is Claude Code's project-scope fork, and it is present only there. Claude Code reads
 * `CLAUDE.md` and not `AGENTS.md`, while every other host in a repository reads `AGENTS.md`, so a repo
 * that already has one gets the block THERE and a `@AGENTS.md` import in `CLAUDE.md` — one copy of the
 * prose, visible to both. The transaction layer decides between the two by looking at disk, since
 * which file exists is not a property of the host.
 */
export type InstructionTarget =
  | {
      readonly format: "markdown-block"
      readonly file: string
      readonly agentsFile?: string
    }
  | {
      readonly format: "cursor-rules"
      readonly file: string
    }

/** Everything install needs to know about one host at one scope. Absolute paths throughout. */
export interface HostSpec {
  readonly host: HostId
  readonly scope: Scope
  /** `$HOME` at user scope, the git top level at project scope. */
  readonly root: string
  readonly displayName: string
  readonly mcp: McpTarget
  readonly hooks: HooksTarget
  /** `null` for Cursor at user scope: it has no user-level instruction file this build writes. */
  readonly instruction: InstructionTarget | null
  /** The `SKILL.md` install writes, absolute. */
  readonly skill: string
  /** The host's manual half: a restart, a trust step, an approval prompt. */
  readonly nextSteps: ReadonlyArray<string>
}

/** What each host calls itself, for a report a human reads. */
export const DISPLAY_NAMES: Readonly<Record<HostId, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor",
  opencode: "OpenCode"
}

/**
 * The directory whose existence means a host is installed on this machine, relative to `$HOME`.
 *
 * `integrations install` with no host argument wires every host this finds, so the rule has to be one
 * a host creates itself on first run and never as a side effect of something else.
 */
export const DETECT_DIRS: Readonly<Record<HostId, string>> = {
  claude: ".claude",
  codex: ".codex",
  cursor: ".cursor",
  opencode: join(".config", "opencode")
}

/**
 * Where each host writes transcripts, `~`-relative, or `null` when memhtml cannot read them.
 *
 * Claude Code alone, because `@memhtml/traces` reads Claude Code's JSONL transcript format and no
 * other. A `null` host installs no indexing hook rather than one with nothing to read; an operator who
 * knows better says so with `MEMHTML_TRACE_ROOT`, which the CLI passes through for any host.
 */
export const DEFAULT_TRACE_ROOT: Readonly<Record<HostId, string | null>> = {
  claude: join("~", ".claude"),
  codex: null,
  cursor: null,
  opencode: null
}

/** The user-scope skill directory the three non-Claude hosts share: the cross-vendor `~/.agents`. */
const SHARED_SKILL_DIR = ".agents"

const skillFile = (base: string): string => join(base, "skills", SKILL_DIR_NAME, "SKILL.md")

const MCP_KEY_PATH: ReadonlyArray<string> = ["mcpServers", MCP_SERVER_KEY]
const OPENCODE_MCP_KEY_PATH: ReadonlyArray<string> = ["mcp", MCP_SERVER_KEY]
const HOOKS_KEY_PATH: ReadonlyArray<string> = ["hooks"]

/** Codex's table name, the one `hasUnfencedTable` refuses a hand-written copy of. */
export const CODEX_MCP_TABLE = `mcp_servers.${MCP_SERVER_KEY}`

/**
 * The plan for one host at one scope.
 *
 * `root` is `$HOME` for `user` and the git top level for `project`, and nothing here reads the other
 * one: a project install is entirely inside the repository, which is what lets it be committed.
 */
export const hostSpec = (host: HostId, scope: Scope, root: string): HostSpec => {
  const common = { host, scope, root, displayName: DISPLAY_NAMES[host] } as const
  switch (host) {
    case "claude":
      return scope === "user"
        ? {
            ...common,
            mcp: { format: "json", file: join(root, ".claude.json"), keyPath: MCP_KEY_PATH },
            hooks: {
              format: "json-arrays",
              file: join(root, ".claude", "settings.json"),
              keyPath: HOOKS_KEY_PATH
            },
            instruction: { format: "markdown-block", file: join(root, ".claude", "CLAUDE.md") },
            skill: skillFile(join(root, ".claude")),
            nextSteps: []
          }
        : {
            ...common,
            mcp: { format: "json", file: join(root, ".mcp.json"), keyPath: MCP_KEY_PATH },
            hooks: {
              format: "json-arrays",
              file: join(root, ".claude", "settings.json"),
              keyPath: HOOKS_KEY_PATH
            },
            instruction: {
              format: "markdown-block",
              file: join(root, "CLAUDE.md"),
              agentsFile: join(root, "AGENTS.md")
            },
            skill: skillFile(join(root, ".claude")),
            nextSteps: [
              "Approve the project .mcp.json prompt the next time Claude Code opens this repository."
            ]
          }
    case "codex": {
      // The same `.codex/` directory name at both scopes: Codex reads a repository's `.codex/` the way
      // it reads `~/.codex/`, so only the anchor differs.
      const base = join(root, ".codex")
      return {
        ...common,
        mcp: { format: "toml-fence", file: join(base, "config.toml"), table: CODEX_MCP_TABLE },
        hooks: {
          format: "json-arrays",
          file: join(base, "hooks.json"),
          keyPath: HOOKS_KEY_PATH
        },
        instruction: {
          format: "markdown-block",
          file: scope === "user" ? join(base, "AGENTS.md") : join(root, "AGENTS.md")
        },
        skill: skillFile(join(root, SHARED_SKILL_DIR)),
        nextSteps: [
          "Restart Codex; then open /hooks and trust the memhtml hooks (hash-keyed; an edit re-arms review)."
        ]
      }
    }
    case "cursor":
      return {
        ...common,
        mcp: {
          format: "json",
          file: join(root, ".cursor", "mcp.json"),
          keyPath: MCP_KEY_PATH
        },
        hooks: {
          format: "json-arrays",
          file: join(root, ".cursor", "hooks.json"),
          keyPath: HOOKS_KEY_PATH,
          versionKey: { keyPath: ["version"], value: CURSOR_HOOKS_VERSION }
        },
        instruction:
          scope === "user"
            ? null
            : {
                format: "cursor-rules",
                file: join(root, ".cursor", "rules", `${MCP_SERVER_KEY}.mdc`)
              },
        skill: skillFile(join(root, SHARED_SKILL_DIR)),
        nextSteps: ["Restart Cursor for mcp.json; hooks reload on save."]
      }
    case "opencode": {
      const base = scope === "user" ? join(root, ".config", "opencode") : join(root, ".opencode")
      return {
        ...common,
        mcp: {
          format: "json",
          file: scope === "user" ? join(base, "opencode.json") : join(root, "opencode.json"),
          keyPath: OPENCODE_MCP_KEY_PATH
        },
        hooks: { format: "plugin-file", file: join(base, "plugins", OPENCODE_PLUGIN_FILE) },
        instruction: {
          format: "markdown-block",
          file: scope === "user" ? join(base, "AGENTS.md") : join(root, "AGENTS.md")
        },
        skill: skillFile(join(root, SHARED_SKILL_DIR)),
        nextSteps: ["Restart OpenCode; plugins load at startup."]
      }
    }
  }
}

/**
 * Which hosts this machine has, in `HOSTS` order, by {@link DETECT_DIRS}.
 *
 * A directory rather than a binary on `PATH`: three of the four hosts ship as a GUI app or through a
 * version manager, so the config directory is the artifact that exists on every install path. A host
 * whose directory is absent is not wired, which is what makes `integrations install` with no argument
 * a statement about this machine rather than a guess.
 */
export const detectHosts = async (home: string): Promise<ReadonlyArray<HostId>> => {
  const found: Array<HostId> = []
  for (const host of HOSTS) {
    if (await isDirectory(join(home, DETECT_DIRS[host]))) found.push(host)
  }
  return found
}
