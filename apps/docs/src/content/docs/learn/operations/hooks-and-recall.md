---
title: Hooks and recall
description: What each installed hook injects on each host, why a hook that fails prints nothing, the time bounds it runs under, and how to run one by hand to see exactly what a host sees.
---

```bash
echo '{"prompt":"why did the checkout deploy roll back"}' |
  memhtml hook user-prompt-submit --host claude --repo ~/memhtml
```

Every hook `memhtml integrations install` writes is one invocation of `memhtml hook <event> --host <host> --repo <root>`. There are no shell scripts to maintain and no per-host wrapper: the binary reads the host's own payload on stdin, runs retrieval or transcript indexing, and writes that host's own protocol to stdout. So a hook is a thing you can run by hand, which is the whole of this page's debugging advice.

`memhtml hook` is the one command that doesn't write the envelope. It writes what the host expects, because the host is parsing it, and the envelope on that stream would read as garbage. Its response type is `hook.output` for the manifest's sake.

## The four events

`session-start`, `user-prompt-submit`, `pre-compact`, and `session-end` are host-neutral names. Each host's installer maps them onto that host's own event names, and the hook engine maps the host's payload back.

| Event                | What it does                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `session-start`      | Runs `recall` and injects a context pack under a character budget (`--budget`, default 3000) |
| `user-prompt-submit` | Runs `search` on the prompt and injects the top hits (`--limit`, default 5)                  |
| `pre-compact`        | Indexes this session's transcript into the trace plane before the host discards it           |
| `session-end`        | Indexes this session's transcript into the trace plane                                       |

The two recall events inject context. The two indexing events don't inject anything, and no host reads their stdout anyway: a pre-compaction or session-end hook is an observer. Their value is timing, because a transcript is worth indexing at exactly the moment the host is about to compact it away.

## What each host gets

| Host        | session-start                         | per-prompt                  | pre-compact                                | session-end                                |
| ----------- | ------------------------------------- | --------------------------- | ------------------------------------------ | ------------------------------------------ |
| Claude Code | `SessionStart`, injects               | `UserPromptSubmit`, injects | `PreCompact`, indexes, with a trace root   | `SessionEnd`, indexes, with a trace root   |
| Codex CLI   | `SessionStart`, injects               | `UserPromptSubmit`, injects | none                                       | none                                       |
| Cursor      | `sessionStart`, injects               | none                        | none                                       | none                                       |
| OpenCode    | no event; the compaction hook runs it | `chat.message`, injects     | `experimental.session.compacting`, injects | `session.idle`, indexes, with a trace root |

Five of those cells say `none`, and each one is a host limit rather than a gap in this build.

Cursor has no per-prompt injection channel. Its `beforeSubmitPrompt` hook can stop a turn and can pass a message to you, and it has no documented way to add context to the prompt the model reads, so install writes no per-prompt hook for Cursor at all rather than one that runs and is discarded. Mid-turn recall on Cursor is the MCP tools.

Codex and Cursor never get an indexing hook. Codex's hooks file carries the two injecting events and nothing else, Cursor's carries `sessionStart` alone, and neither host writes a transcript in a format `@memhtml/traces` reads.

Claude Code's two indexing hooks and OpenCode's `session.idle` handler exist only when a trace root is known. Only Claude Code has a default one, `~/.claude`, because `@memhtml/traces` reads Claude Code's transcript format and no other. `MEMHTML_TRACE_ROOT` sets a trace root for any host, so exporting it is what arms OpenCode's indexer. Without one, install writes no indexing hook at all rather than one with nothing to read.

The output protocol differs too, and the engine writes whichever one the `--host` flag names. Claude Code takes plain text on stdout and puts it in the model's context. Codex takes `hookSpecificOutput.additionalContext` JSON, which Claude Code also accepts, so Codex gets the JSON form. Cursor takes `{"additional_context": "…"}`. The OpenCode plugin calls the binary itself and pushes the text as a message part, so it wants plain text. Read from the vendor docs on 2026-09-13, Codex caps injected context at roughly 2,500 tokens, which the 3000-character default budget sits under.

An empty answer renders as an empty string on every host. A hook with nothing to add says nothing, and every host reads that as no change.

## Any failure prints nothing and exits 0

This is the rule that matters most, because it's the one that decides whether you can leave hooks installed. Any failure inside `memhtml hook` prints nothing to stdout and exits 0. An unreachable store, a missing index, a Bedrock outage, a malformed payload, a timeout: every one of them produces silence and a success exit code.

A hook runs on the critical path of your turn, so the only acceptable failure is one you don't notice. A hook that exited non-zero would surface as a host error on a prompt that had nothing wrong with it, and a hook that printed a diagnostic would put its own error text into the model's context, where the model would try to act on it.

The cost is that a broken hook is invisible from inside a session, which is why `integrations doctor` exists and why the by-hand invocation below is the way you check one.

## The time bounds

Retrieval runs under a hard 1.5 s bound. Transcript indexing runs under 10 s. A run that reaches its bound is a failure like any other, so it prints nothing and exits 0, and the turn proceeds without the context.

The bounds are what make per-prompt recall affordable. Each prompt spawns one node process, and 1.5 s is the ceiling on what that can cost you. `--hooks session` installs session-start recall only when you'd rather not spend it, and `--hooks none` writes the MCP entry, block, and skill with no hook at all.

Indexing gets the longer bound because it walks a transcript file rather than answering a query, and because it runs at a moment the host is already pausing.

## Hooks never write memories

No hook writes a memory. Not the session-start pack, not the per-prompt search, not the indexing events. They read the corpus and they index transcripts, and that's the whole of what they do.

Two reasons hold that line. memhtml is single-writer, so a hook that wrote a memory would put a commit on the critical path of a turn and would contend with the CLI and the MCP server for the index. And distillation is a judgment about what's durable, which belongs to `memhtml sleep run` reading whole transcripts on a reviewable branch, not to a hook with 1.5 s and one prompt. See [run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/).

So the loop is: hooks recall and index, sleep distills what the transcripts were worth, and a human merges. The indexing hooks are what feed the first half of that, which is why they're worth installing on the host whose transcripts memhtml can read.

## Run one by hand

Give the hook the payload its host would give it and read what comes back:

```bash
echo '{"prompt":"drain the VIP before reverting"}' |
  memhtml hook user-prompt-submit --host claude --repo ~/memhtml
```

That's plain text, and it's exactly the bytes Claude Code would put in the model's context. Change the host to see the same answer in another dialect:

```bash
echo '{"prompt":"drain the VIP before reverting"}' |
  memhtml hook user-prompt-submit --host codex --repo ~/memhtml
```

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "…" } }
```

Empty output is the answer to two different questions, and the by-hand run is how you tell them apart. Either retrieval found nothing worth injecting, or something failed and the fail-open rule swallowed it. Run the same query through `memhtml search` to find out which:

```bash
memhtml search "drain the VIP before reverting" --dense
```

A search that answers while the hook is silent means the failure is in the hook's own arguments, and the store path is the usual one: the installed hook pins `--repo` to an absolute store root, so check that the root you're passing by hand is the same one. A search that also finds nothing means the corpus is the answer.

The session-start pack takes no prompt, so the payload can be a bare object:

```bash
echo '{"cwd":"/home/you/work/checkout-api"}' |
  memhtml hook session-start --host claude --repo ~/memhtml --budget 1500
```

`cwd` is read where the host sends one, and it's how a session in a project directory gets a pack about that project. Cursor sends `workspace_roots` instead and the engine reads the first entry.

The indexing events want a trace root, which defaults to `$MEMHTML_TRACE_ROOT`; an installed indexing hook always names one explicitly on its command line:

```bash
echo '{"session_id":"…"}' | memhtml hook pre-compact --host claude --trace-root ~/.claude
```

That one prints nothing on success, because no host reads its stdout. Check that it did something by looking at the trace plane afterwards with `memhtml trace search`, per [index session transcripts](/learn/operations/index-session-transcripts/).

## What the injected text says

The session-start pack is a `memhtml recall` answer rendered as a bounded index: one line per memory carrying its title, a gist clipped to 240 characters, and the path an agent hands straight to `memory_read`, arcs before ordinary memories, then up to five open tasks. `--budget` decides which memories `recall` thought were worth spending on rather than how much prose lands in the session: the disclosed bodies stay out of the block, and the disclosed tier is simply ordered first within each fold. The per-prompt injection is a `memhtml search` answer at `--limit` hits, in the same one-line form.

Neither one is a citation, and the instruction block install writes is where that's stated to the agent. A hit is the ranker's guess about your prompt, its snippet is the chunk that best matched, and an agent that quotes it without opening the path quotes something the ranker chose. The block and the skill carry that discipline, the manifest carries it as the `recall-discipline` guide topic, and all three render from one prose module in `@memhtml/contracts`, so they can't drift from each other.

## Read next

[Wire up your coding agent](/learn/operations/wire-a-coding-agent/) is what installs these hooks and where the per-host files are listed. [Index session transcripts](/learn/operations/index-session-transcripts/) covers the trace plane the indexing events feed and the firewall between it and memory retrieval. [For agents](/agents/) is the page an agent reads about its own surface.
