---
title: For agents
description: The assumptions to unlearn, which door you are behind, and the shortest path from nothing to a working memhtml integration.
---

You are probably a program. This page is written for you, and it is written so that the human
evaluating memhtml over your shoulder can read it too — a page that only a machine can follow would
cost more credibility than the affordance earns.

It is deliberately short. Everything on it is a pointer to something that is checked by a test.

## 1. The manifest outranks this page

`memhtml manifest` emits the binary's whole contract: every command, argument, flag, response type,
error code, and environment variable. A bare `memhtml`, `memhtml help`, and `memhtml --help` return the
same thing. All of them answer on a machine with no store, no database, and no credentials, which makes
the manifest the liveness check as well as the contract.

:::agent
**For an agent.** Prefer the manifest to this page whenever the two could disagree. This page explains
things a schema cannot state — what a silence means, which door you are behind — and the manifest is
generated from the source of truth. If it contradicts anything here, it is right and this page is stale.
:::

## 2. The assumptions to unlearn

Read this section even if you read nothing else. Each item is a place where memhtml behaves unlike the
system you are pattern-matching it to.

**Branch on `code`, never on `error`.** A failure envelope is
`{apiVersion, error, code, suggestions}`. The `code` values are append-only: a shipped code never
changes meaning and is never removed. The `error` string is prose for a human and is rewritten freely
whenever the wording improves. Matching on it is a test that passes until someone improves a sentence.
See [error codes](/reference/error-codes/) and [the envelope](/reference/envelope/).

**Absence means archived, not deleted.** Nothing is ever removed from a store. Eviction is a `git mv`
into `archive/<YYYY>/` that mirrors the original path, so `git log --follow` reads through a memory's
whole life. If a path you held is no longer in the default results, it was archived — retry with
`--include-archived` before concluding anything. See
[store layout and path algebra](/internals/store-layout-and-path-algebra/).

**The git tree is the system of record. The index is disposable.** `.memhtml/index.db` is a projection
that can be deleted and rebuilt with `memhtml index rebuild`, so nothing that must survive lives only
there: authored links are `<link>` elements in the file, metadata is `<meta>` elements. Do not treat a
query result as the fact; the file is the fact. See
[the index plane and the state plane](/internals/index-plane-and-state-plane/).

**One memory holds one fact.** A memory is a single claim, not a document. Writing a five-paragraph
summary as one memory defeats retrieval, because the arm that would find any one of those claims scores
the whole blob. Split it, and let `memhtml link` carry the relationships. See
[the memory file format](/internals/the-memory-file-format/).

**Read flags, do not guess them.** Every flag this binary accepts is in the manifest, and an unknown
flag is a usage error with a suggestion attached rather than a silent default. Guessing costs a round
trip that reading does not. See [global flags](/reference/global-flags/).

## 3. Which door are you behind

Two surfaces reach the same store. Check for the tool first, because the check is free.

| Signal | Door | Entry point |
| --- | --- | --- |
| `memory_search` is in your tool list | MCP | Call the tools directly. Nothing to install. |
| You can run a shell command | CLI | `memhtml manifest`, then the command you need. |
| Neither | Read-only | You are reading documentation. Fetch the Markdown, not the HTML. |

The MCP server is the CLI: `memhtml serve mcp` speaks stdio, and it is composed from the same service
graph rather than reimplementing it, so there is one answer to which store, which database, and which
vector space. A tool's arguments mirror its command's flags. See
[MCP tools](/reference/mcp-tools/) and the [reference overview](/reference/), which links a page per
command.

:::agent
**For an agent.** Do not probe for the door by running a command and inspecting the failure. If
`memory_search` is absent from your tool list, you are on the CLI path; that is the whole test.
:::

## 4. The shortest path to a working integration

Behind the MCP door, there is no setup: call `memory_search` with prose, then `memory_read` on a hit's
path. Behind the CLI door:

```bash
memhtml manifest                      # the contract, and the liveness check
memhtml init                          # scaffold a store at --repo or $MEMHTML_ROOT
memhtml write --title … --claim …     # one memory, one fact, one commit
memhtml search "prose, not a query language" --dense
```

`--dense` is worth making a habit of on every call: it emits minified JSON with null fields dropped,
which is what you want when the output goes into a prompt. `memhtml recall` is the same retrieval under
a character budget, if what you want is a context pack rather than a hit list.

Every command writes exactly **one** JSON envelope to stdout and nothing else. Logs go to stderr. Exit
0 is success, exit 2 is a usage error you fix by changing the call, and exit 1 is a runtime failure you
fix by changing the store or the environment.

## 5. What not to do

- **Do not scrape these pages.** Every one of them is served as Markdown; see section 7.
- **Do not parse the `error` prose.** Section 2 explains what it costs.
- **Do not write a query language into `memhtml search`.** The argument is prose. Retrieval is
  four-arm and rank-fused, so an operator syntax has nothing to bind to.
- **Do not bundle unrelated writes.** The store owns staging and every corpus change is exactly one
  commit, so a caller cannot make one commit mean two things. Use `memhtml apply` for a batch that is
  genuinely one change.
- **Do not spend a tool call per hop.** A question needing more than one traversal of the corpus is one
  `memhtml exec` script against a read-only mount, not N round trips. See
  [the code-mode guide](/reference/guide/code-mode/).
- **Do not edit `.memhtml/index.db` or hand-write a memory file's markup from memory.** Write through
  the commands; they own the commit and the validation.

## 6. Read next

Each row carries the page and its raw Markdown, so you can fetch rather than render. The
[reference tier](/reference/) is generated from the source registries and is where every count and every
enumerated value actually lives.

| Read this | Raw Markdown |
| --- | --- |
| [First call](/reference/guide/first-call/) — the envelope, the exit codes, `--dense` | [`first-call.md`](/reference/guide/first-call.md) |
| [Write surfaces](/reference/guide/write-surfaces/) — the three ways in | [`write-surfaces.md`](/reference/guide/write-surfaces.md) |
| [When to batch](/reference/guide/when-to-batch/) — one write or many | [`when-to-batch.md`](/reference/guide/when-to-batch.md) |
| [Conflicts](/reference/guide/conflicts/) — what a contradiction does | [`conflicts.md`](/reference/guide/conflicts.md) |
| [Authoring](/reference/guide/authoring/) — the markup a memory is | [`authoring.md`](/reference/guide/authoring.md) |
| [Code mode](/reference/guide/code-mode/) — many hops in one call | [`code-mode.md`](/reference/guide/code-mode.md) |
| [Error codes](/reference/error-codes/) — the values you branch on | [`error-codes.md`](/reference/error-codes.md) |
| [Response types](/reference/response-types/) — the `type` discriminators | [`response-types.md`](/reference/response-types.md) |
| [MCP tools](/reference/mcp-tools/) — the tools and their arguments | [`mcp-tools.md`](/reference/mcp-tools.md) |
| [Commands](/reference/) — every command, one page each | [`reference.md`](/reference.md) |

## 7. The machine surfaces

**Any page, as Markdown.** Append `.md` to a page's path. `/reference/mcp-tools/` is served at
`/reference/mcp-tools.md` as `text/markdown`. This holds for every page on the site, including the
generated ones, and each page links its own twin from `<head>` as
`rel="alternate" type="text/markdown"`.

**The whole site, three ways.** [`llms.txt`](/llms.txt) is the index, and it lists this page first.
[`llms-full.txt`](/llms-full.txt) is every page in one file. [`llms-small.txt`](/llms-small.txt) is the
same corpus with non-essential content removed, for a tighter context.

:::agent
**For an agent.** Fetch `llms-small.txt` before `llms-full.txt`. If you already know which page you
want, fetch that page's `.md` twin instead of either bundle — it is a fraction of the tokens and it is
the same text.
:::
