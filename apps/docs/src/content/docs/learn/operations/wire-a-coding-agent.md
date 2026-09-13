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

| Component         | What it does                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| MCP entry         | Registers `memhtml-mcp` over stdio, so the host gets the fifteen tools and three resources                            |
| Hooks             | Session-start recall, per-prompt recall where the host can inject it, transcript indexing where a trace root is known |
| Instruction block | A fenced block in the host's instruction file carrying the recall discipline                                          |
| Skill             | A `SKILL.md` the host loads on demand, carrying the same discipline                                                   |
| Receipt           | `~/.config/memhtml/integrations/<host>.json`: the SHA-256 of every owned file or fragment                             |

Two kinds of thing get written, and the difference is how ownership is checked. A **file** is wholly memhtml's, so the receipt claims the hash of the whole thing: the skill, the OpenCode plugin, the Cursor rule. A **fragment** lives inside a file other tools also own, so the receipt claims only the rendered bytes of the fragment: a JSON key, a fenced TOML table, a Markdown block, one entry in a hooks array. Your own entries, comments, key order, and line breaking survive both directions byte for byte: the editor splices only the owned bytes and never reformats a neighbor.

One file is shared on purpose. Codex, Cursor, and OpenCode all read `~/.agents/skills/memhtml/SKILL.md`, so install adopts a byte-identical twin instead of refusing it as somebody else's file, and uninstall leaves it on disk while another host's receipt still claims it.

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

Claude Code watches its settings, hooks, and skills files and picks up a change live, so a user-scope install asks nothing of you and its `nextSteps` is empty. A project install carries exactly one step, because a project `.mcp.json` server needs the approval prompt the host shows on the next launch: `Approve the project .mcp.json prompt the next time Claude Code opens this repository.`

This is the one host with a default trace root, `~/.claude`, so it's the one host that gets the two indexing hooks with no configuration. `MEMHTML_TRACE_ROOT` names a trace root for any host, and on OpenCode it's what arms the plugin's indexing handler; Codex and Cursor have no indexing event to write one into. See [index session transcripts](/learn/operations/index-session-transcripts/) for what those hooks feed.

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

Codex needs two steps from you, and the report names both. Restart Codex, because an edit to `config.toml` is read at startup. Then trust the hooks in `/hooks`: Codex keys trust to a hook's hash and skips an untrusted one, so a hook an installer wrote does nothing at all until you approve it there. Neither step can be automated, and nothing outside Codex can read the trust decision, so `doctor` carries it as an informational green `hook-trust` row rather than a verdict.

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

OpenCode's hook system is its plugin system, so install generates a JavaScript file rather than a config entry, and the receipt claims the whole file. The plugin wires two handlers by default: `chat.message` pushes recall onto each user message, and `experimental.session.compacting` pushes the session-start pack into the compaction prompt. A third handler, `session.idle`, indexes the session's transcript at turn end, and install writes it only when a trace root is known, which for OpenCode means `MEMHTML_TRACE_ROOT`. Restart OpenCode after install, because it loads plugins and config at startup.

## What the report says

`install` answers one `integrations.report` envelope, keyed by host. This is a real `memhtml integrations install claude --dry-run` answer with the `contents` map trimmed off:

```json
{
  "apiVersion": "1",
  "type": "integrations.report",
  "data": {
    "action": "install",
    "scope": "user",
    "root": "/home/you",
    "memhtmlRoot": "/home/you/memhtml",
    "dryRun": true,
    "changed": true,
    "hosts": [
      {
        "host": "claude",
        "changed": true,
        "memhtmlRoot": "/home/you/memhtml",
        "entries": [
          { "path": "/home/you/.claude.json", "role": "mcp-entry", "kind": "fragment", "action": "planned" },
          { "path": "/home/you/.claude/settings.json", "role": "hooks", "kind": "fragment", "action": "planned" },
          { "path": "/home/you/.claude/CLAUDE.md", "role": "instruction-block", "kind": "fragment", "action": "planned" },
          { "path": "/home/you/.claude/skills/memhtml/SKILL.md", "role": "skill", "kind": "file", "action": "planned" }
        ],
        "backups": [],
        "receiptPath": "/home/you/.config/memhtml/integrations/claude.json",
        "nextSteps": []
      }
    ]
  }
}
```

The report is keyed by host because the host argument is optional: `memhtml integrations install` wires every host it detects, and one flat report could describe only the last of them. A row's `action` is `created`, `updated`, or `unchanged` on a real run, `planned` on a dry run, and `removed` on an uninstall. `backups` names the prior bytes `--force` kept beside a file. `nextSteps` is that host's manual half, and it's the empty array for a host that asks nothing of you.

Read `changed` rather than counting entries: at the top it's true when any host changed, and each host carries its own. A re-run that finds every managed fragment already correct reports `changed: false` and writes nothing, which is what makes install safe on a cron line or in a machine-setup script. Uninstall answers the same type with `action: "uninstall"` and one host row, which carries a `state` of `installed` or `not-installed` beside the entries it removed.

`--dry-run` adds `contents`, a map from every path the install would touch to that file's whole new text, and writes nothing. Run it first when you want to read the block and the hook lines before they land in your home directory.

## Why the entry carries an absolute path

By default the MCP entry and every hook line name an absolute node executable and an absolute entry script, and the receipt records the version the binary reported. Two reasons, and both are about hosts rather than about taste. A GUI host doesn't inherit your shell's `PATH`, so a bare `memhtml-mcp` in its config is a command it can't find. And a version-manager alias that moves leaves a bare command pointing at nothing, with the failure showing up as a server that won't start rather than as a message about a path.

The cost is that an upgrade moves the entry script, so run `install` again after one. `doctor` re-resolves the path on every run and tells an upgrade from a move, so you find out before a session does.

`--bare-command` writes `memhtml` and `memhtml-mcp` instead and leaves `PATH` to you. Choose it when you manage the toolchain yourself and would rather the config not name a version.

The entry also carries `MEMHTML_ROOT` in its `env`, absolute, rather than relying on your shell profile. A host launches the server from its own environment, and the default `~/memhtml` may not be the store you meant.

## Project scope

`--project <path>` installs at repository scope instead of user scope. The path is resolved to its git top level, and the host's project files are written there: `.mcp.json`, `.claude/settings.json`, `.cursor/mcp.json`, `.cursor/rules/memhtml.mdc`, `.codex/config.toml`, `.codex/hooks.json`, `opencode.json`, `.opencode/plugins/memhtml.js`, a root `AGENTS.md` or `CLAUDE.md`, and the skill under `.claude/skills/memhtml/` for Claude Code or `.agents/skills/memhtml/` for the other three. The receipt moves with them, to `<root>/.memhtml-integrations/<host>.json`.

Claude Code's block goes where the repository already keeps its instructions. A repository with an `AGENTS.md` gets the block there and a fenced `@AGENTS.md` import in `CLAUDE.md`, so the prose exists once and both readers see it; a `CLAUDE.md` that is already only that import is left alone.

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

The same refusal covers a receipt that is present and can't be read, whether it's truncated, of the wrong shape, copied in from another host or root, or claims a path outside its own root. Install won't plan over it as if the host were never installed, and uninstall won't guess at what to remove from it; `--force` on install proceeds as a fresh install and keeps the unreadable bytes beside it. Uninstall also stops when another host's receipt at the same scope can't be read, because that receipt may claim the skill the three non-Claude hosts share.

With no host named, install plans every detected host before it writes to any of them, so a refusal on the third host leaves the first two untouched. If a disk error interrupts the real pass, the failure names the hosts that did land and the uninstall command for each.

Re-running install with a narrower `--hooks` mode removes the events it no longer wants, and `--hooks none` removes every hook the previous install wrote, including OpenCode's plugin file, in the same transaction that drops them from the receipt. The report lists those rows as `removed`. Your own hook entries beside ours stay where they are.

`uninstall` refuses a modified entry with the same code and has no `--force`. That asymmetry is deliberate: overwriting your edit is recoverable from the backup, and deleting a file you had made your own isn't.

## List and doctor

`integrations list` answers an `integrations.list` envelope: `home`, a `projectRoot` that is `null` without `--project`, and `rows`, one row per host per scope:

```bash
memhtml integrations list
memhtml integrations list --project .
```

A row carries `host`, `scope`, `root`, `state` (`not-installed`, `installed`, or `modified`), and `receiptPath`, plus `version` and `memhtmlRoot` when the receipt was readable and a `detail` sentence when it wasn't or when something drifted.

`integrations doctor` checks a host's wiring end to end and answers an `integrations.doctor` envelope: `scope`, `root`, `healthy`, and `hosts`, each with its own `healthy` and a `checks` array of `{name, ok, detail, suggestions}`:

```bash
memhtml integrations doctor          # every host with a receipt
memhtml integrations doctor claude   # one host
```

The check names, in the order a healthy host reports them: `receipt`, `binary-node`, `binary-cli`, `binary-mcp`, `cli-version`, `store-root`, one `entry:<role>` per receipt entry, `hooks`, `instruction-block`, `skill`, `trace-root` when an installed hook names one, `mcp-handshake`, and `hook-trust` on Codex. An absent or unreadable receipt answers with that one `receipt` row and stops, because nothing else is knowable without it. `trace-root` passes on a root that exists and holds no transcript yet, which is every machine before its first session, and fails only on a root that cannot be listed.

`cli-version` runs the recorded CLI's `manifest` and compares the version it prints with the version the receipt records, so an upgrade reads differently from a binary that moved. `mcp-handshake` spawns the server the entry names, with the env the entry carries, and completes a live `initialize`. That last check is the one that catches a config which reads correctly and starts nothing.

The store-root check reads the directory rather than calling `memhtml status`, because `status` on a bare directory creates a store, and a diagnostic that creates the thing it's checking always passes. The same rule gates the handshake: when `store-root` failed, `mcp-handshake` reads `not attempted`, because starting the server would scaffold the `.memhtml/` the row above just reported missing and the next run would read green.

## The shell snippet

The MCP entries carry their own environment, so nothing about the host integration needs your shell. `integrations shell` is for you, running the CLI by hand:

```bash
memhtml integrations shell           # print the snippet
memhtml integrations shell --write   # append it to your rc file
```

It exports `MEMHTML_ROOT` and puts this binary's directory on `PATH`. `--write` appends the snippet inside `# MEMHTML:START` / `# MEMHTML:END` markers, replacing a prior fenced block rather than stacking a second one, to `~/.zshrc` when `$SHELL` ends in `zsh` and `~/.bashrc` otherwise. `--rc` names a different file. The `integrations.shell` envelope carries `rc`, `snippet`, `written`, and `changed`, so a script can tell a fresh append from a no-op.

## Read next

[Hooks and recall](/learn/operations/hooks-and-recall/) covers what each installed hook injects, the fail-open rule, the time bounds, and how to run a hook by hand to see what a host sees. [Wire up the MCP server](/learn/tutorial/mcp-server/) is the tutorial for the server the entry points at, including the hand-written config for a host this command doesn't know. [Configure the environment](/learn/operations/configure-the-environment/) lists the variables the entry sets for you.
