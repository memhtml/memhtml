---
title: Wire up your coding agent
description: What memhtml integrations install writes for Claude Code, Codex, Cursor, and OpenCode, which step each host still needs from you, and how uninstall removes exactly what install wrote.
---

```bash
npx memhtml@latest integrations install        # every host whose home directory exists
memhtml integrations install claude            # one host
memhtml integrations install --dry-run         # every file and entry it would write, and the content
memhtml integrations doctor                    # check the wiring, including a live handshake
```

`memhtml integrations install` wires a coding agent to this store in one command: the host's MCP server entry, its hooks, a fenced block in its instruction file, and a skill. Every one of those is recorded in a receipt with the SHA-256 of the bytes it owns, so `uninstall` removes exactly what `install` wrote and nothing a human added beside it. The four hosts are `claude` (Claude Code), `codex` (Codex CLI), `cursor`, and `opencode`, in that order everywhere the command reports them.

With no host argument, install detects one by home directory: `~/.claude`, `~/.codex`, `~/.cursor`, and `~/.config/opencode`. A host whose directory is absent isn't installed, so a machine with two agents on it gets two integrations and no guesses.

## What it writes

Four components per host, plus the receipt that owns them:

| Component         | What it does                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| MCP entry         | Registers `memhtml-mcp` over stdio, so the host gets the fifteen tools and three resources                                 |
| Hooks             | Session-start recall, per-prompt recall where the host can inject it, transcript indexing where a transcript format exists |
| Instruction block | A fenced block in the host's instruction file carrying the recall discipline                                               |
| Skill             | A `SKILL.md` the host loads on demand, carrying the same discipline                                                        |
| Receipt           | `~/.config/memhtml/integrations/<host>.json`: the SHA-256 of every owned file or fragment                                  |

Two kinds of thing get written, and the difference is how ownership is checked. A **file** is wholly memhtml's, so the receipt claims the hash of the whole thing: the skill, the OpenCode plugin, the Cursor rule. A **fragment** lives inside a file other tools also own, so the receipt claims only the rendered bytes of the fragment: a JSON key, a fenced TOML table, a Markdown block, one entry in a hooks array. Your own MCP servers, hooks, and prose in the same files are untouched by install and survive uninstall.

## Per host

### Claude Code

```bash
memhtml integrations install claude
```

| What              | Where                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| MCP entry         | `~/.claude.json`, `mcpServers.memhtml` (project scope: `.mcp.json`)                       |
| Hooks             | `~/.claude/settings.json`: `SessionStart`, `UserPromptSubmit`, `PreCompact`, `SessionEnd` |
| Instruction block | `~/.claude/CLAUDE.md`, inside `<!-- MEMHTML:START -->` / `<!-- MEMHTML:END -->`           |
| Skill             | `~/.claude/skills/memhtml/SKILL.md`                                                       |

Claude Code watches its settings, hooks, and skills files and picks up a change live, so there's no restart step at user scope. A project `.mcp.json` server needs the interactive approval prompt the host shows on the next launch.

This is the one host whose transcript format `@memhtml/traces` reads, so it's the one host that gets the two indexing hooks. See [index session transcripts](/learn/operations/index-session-transcripts/) for what those hooks feed.

### Codex CLI

```bash
memhtml integrations install codex
```

| What              | Where                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ |
| MCP entry         | `~/.codex/config.toml`, `[mcp_servers.memhtml]` inside `# MEMHTML:START` / `# MEMHTML:END` |
| Hooks             | `~/.codex/hooks.json`: `SessionStart`, `UserPromptSubmit`                                  |
| Instruction block | `~/.codex/AGENTS.md`, inside the same Markdown fence                                       |
| Skill             | `~/.agents/skills/memhtml/SKILL.md`                                                        |

Codex needs two steps from you, and the report names both. Restart Codex, because an edit to `config.toml` is read at startup. Then trust the hooks in `/hooks`: Codex keys trust to a hook's hash and skips an untrusted one, so a hook an installer wrote does nothing at all until you approve it there. Neither step can be automated, and `doctor` can't verify the trust decision from outside the host, so it prints the reminder rather than a check.

`config.toml` is TOML that you also edit, which is why the MCP table lives inside a comment fence: the fence is the fragment install owns, and everything outside it is yours.

### Cursor

```bash
memhtml integrations install cursor
memhtml integrations install cursor --project .
```

| What      | Where                                                    |
| --------- | -------------------------------------------------------- |
| MCP entry | `~/.cursor/mcp.json` (project scope: `.cursor/mcp.json`) |
| Hooks     | `~/.cursor/hooks.json`: `sessionStart` only              |
| Rule      | `.cursor/rules/memhtml.mdc`, a project file              |
| Skill     | `~/.agents/skills/memhtml/SKILL.md`                      |

Cursor gets one hook. Its `sessionStart` returns `additional_context`, which is a context-injection channel, and its `beforeSubmitPrompt` can only stop a turn, so there's nothing for a per-prompt recall hook to inject into and install writes none. Mid-turn recall on Cursor is the MCP tools.

The instruction surface is the other asymmetry. Cursor reads `.cursor/rules/*.mdc` and a project `AGENTS.md`, and it has no user-level instruction file this build writes, so the discipline block lands in a project rule rather than in your home directory. Run install once per repository where you want it, or rely on the skill, which Cursor 2.4 and newer read from `~/.agents/skills/`.

Cursor reloads `hooks.json` on save. Restart Cursor after the MCP entry changes.

### OpenCode

```bash
memhtml integrations install opencode
```

| What              | Where                                                          |
| ----------------- | -------------------------------------------------------------- |
| MCP entry         | `~/.config/opencode/opencode.json`, `mcp.memhtml`              |
| Plugin            | `~/.config/opencode/plugins/memhtml.js`, generated by install  |
| Instruction block | `~/.config/opencode/AGENTS.md`, inside the same Markdown fence |
| Skill             | `~/.agents/skills/memhtml/SKILL.md`                            |

OpenCode's hook system is its plugin system, so install generates a JavaScript file rather than a config entry, and the receipt claims the whole file. The plugin wires three hooks: `chat.message` pushes recall onto each user message, `experimental.session.compacting` pushes context into the compaction prompt, and `session.idle` indexes the session's transcript at turn end. Restart OpenCode after install, because it loads plugins and config at startup.

## What the report says

`install` answers one `integrations.report` envelope. The shape:

```json
{
  "apiVersion": "1",
  "type": "integrations.report",
  "data": {
    "host": "claude",
    "scope": "user",
    "changed": true,
    "entries": [
      { "path": "/home/you/.claude.json", "role": "mcp-entry", "kind": "fragment" },
      { "path": "/home/you/.claude/settings.json", "role": "hooks", "kind": "fragment" },
      { "path": "/home/you/.claude/CLAUDE.md", "role": "instruction-block", "kind": "fragment" },
      { "path": "/home/you/.claude/skills/memhtml/SKILL.md", "role": "skill", "kind": "file" }
    ],
    "nextSteps": ["Restart Claude Code to pick up the new MCP server."]
  }
}
```

Read `changed` rather than counting entries. A re-run that finds every managed fragment already correct reports `changed: false` and writes nothing, which is what makes install safe on a cron line or in a machine-setup script. `nextSteps` is the host's manual half: the restart, the trust step, the approval prompt. Uninstall answers the same type, with the entries it removed.

`--dry-run` reports the same envelope plus the rendered content of every entry, and writes nothing. Run it first when you want to read the block and the hook lines before they land in your home directory.

## Why the entry carries an absolute path

By default the MCP entry and every hook line name an absolute node executable and an absolute entry script, and the receipt records the version the binary reported. Two reasons, and both are about hosts rather than about taste. A GUI host doesn't inherit your shell's `PATH`, so a bare `memhtml-mcp` in its config is a command it can't find. And a version-manager alias that moves leaves a bare command pointing at nothing, with the failure showing up as a server that won't start rather than as a message about a path.

The cost is that an upgrade moves the entry script, so run `install` again after one. `doctor` re-resolves the path on every run and tells an upgrade from a move, so you find out before a session does.

`--bare-command` writes `memhtml` and `memhtml-mcp` instead and leaves `PATH` to you. Choose it when you manage the toolchain yourself and would rather the config not name a version.

The entry also carries `MEMHTML_ROOT` in its `env`, absolute, rather than relying on your shell profile. A host launches the server from its own environment, and the default `~/memhtml` may not be the store you meant.

## Project scope

`--project <path>` installs at repository scope instead of user scope. The path is resolved to its git top level, and the host's project files are written there: `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`, a root `AGENTS.md` or `CLAUDE.md`. The receipt moves with them, to `<root>/.memhtml-integrations/<host>.json`.

```bash
memhtml integrations install claude --project .
memhtml integrations list --project .
memhtml integrations uninstall claude --project .
```

`/` and `$HOME` are refused as a project root, because a git top level that resolves to either of those is a mistake whose blast radius is every repository under it.

## Re-running, and what a modification refuses

Install is idempotent. Run it twice and the second run reports `changed: false`.

A managed fragment a human edited is a different case, and install refuses it:

```
ERR_INTEGRATION_MODIFIED
```

The refusal is per entry, and nothing is written when one fires. It fires when the bytes install owns no longer hash to what the receipt claims, which means either you edited the block or another tool rewrote the file around it. Read the entry, decide which version you want, then either keep your edit by removing the receipt's claim on it with `uninstall`, or overwrite it with `--force`. `--force` keeps the prior bytes beside the file as a timestamped backup, and the report names the backup path.

`uninstall` refuses a modified entry with the same code and has no `--force`. That asymmetry is deliberate: overwriting your edit is recoverable from the backup, and deleting a file you had made your own isn't.

## List and doctor

`integrations list` reports one row per host per scope, each `not-installed`, `installed`, or `modified`:

```bash
memhtml integrations list
memhtml integrations list --project .
```

`integrations doctor` checks a host's wiring end to end and answers one row per check with `suggestions` on every failure:

```bash
memhtml integrations doctor          # every host with a receipt
memhtml integrations doctor claude   # one host
```

It checks that the binary resolves at the recorded absolute path and reports the version the receipt recorded, that the store root exists and holds a `.memhtml/` directory, that the MCP entry matches the receipt byte for byte, that the hooks are present, that the instruction block is present, that the skill is present, that the trace root holds transcripts for this host, and then it spawns the server the entry names with the env the entry carries and completes a live `initialize` handshake. That last check is the one that catches a config which reads correctly and starts nothing.

The store-root check reads the directory rather than calling `memhtml status`, because `status` on a bare directory creates a store, and a diagnostic that creates the thing it's checking always passes.

## The shell snippet

The MCP entries carry their own environment, so nothing about the host integration needs your shell. `integrations shell` is for you, running the CLI by hand:

```bash
memhtml integrations shell           # print the snippet
memhtml integrations shell --write   # append it to your rc file
```

It exports `MEMHTML_ROOT` and puts this binary's directory on `PATH`. `--write` appends the snippet inside `# MEMHTML:START` / `# MEMHTML:END` markers, replacing a prior fenced block rather than stacking a second one, to `~/.zshrc` when `$SHELL` ends in `zsh` and `~/.bashrc` otherwise. `--rc` names a different file.

## Read next

[Hooks and recall](/learn/operations/hooks-and-recall/) covers what each installed hook injects, the fail-open rule, the time bounds, and how to run a hook by hand to see what a host sees. [Wire up the MCP server](/learn/tutorial/mcp-server/) is the tutorial for the server the entry points at, including the hand-written config for a host this command doesn't know. [Configure the environment](/learn/operations/configure-the-environment/) lists the variables the entry sets for you.
