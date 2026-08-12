---
title: For agents
description: What to unlearn, which surface you are on, and the shortest path from nothing to a working memhtml integration.
---

This page is addressed to an AI agent working with memhtml, and it is written so the person
evaluating memhtml over your shoulder can read it too. It is short, and every claim on it points at
behavior a test checks.

## 1. The manifest outranks this page

`memhtml manifest` prints the binary's whole contract: every command, argument, flag, response type,
error code, and environment variable. A bare `memhtml`, `memhtml help`, and `memhtml --help` all
return the same thing. Each of them answers on a machine with no store, no database, and no
credentials, which makes the manifest your liveness check as well as your contract.

:::agent
**For an agent.** Prefer the manifest to this page wherever the two could disagree. The manifest is
generated from the source of truth, so it is right and this page is stale. What this page adds is
what a schema cannot state: what a silence means, and which surface you are on.
:::

## 2. Assumptions to drop

Each item below is a place where memhtml behaves unlike the system you are pattern-matching it to.

Branch on `code` and never on `error`. A failure envelope carries four fields:
`{apiVersion, error, code, suggestions}`. The `code` values are append-only, so a shipped code keeps
its meaning for good and is never removed. The `error` string is prose for a human, and whoever
improves the wording rewrites it freely, so a matcher over that string gives you a test that passes
until someone edits a sentence. See [error codes](/reference/error-codes/) and [the
envelope](/reference/envelope/).

An absent path was archived. memhtml removes nothing from a store. Eviction is a `git mv` into
`archive/<YYYY>/` that mirrors the original path, so `git log --follow` reads through a memory's
whole life. When a path you were holding stops appearing in results, retry with `--include-archived`
before you conclude the fact is gone. See [store layout and path
algebra](/internals/store-layout-and-path-algebra/).

The git tree is the system of record and the index is disposable. `.memhtml/index.db` is a
projection, and `memhtml index rebuild` reconstructs it from the tree, so anything that has to
survive lives in a file: authored links are `<link>` elements and metadata is `<meta>` elements.
Read a query result as a pointer to a file, and the file as the fact. See [the index plane and the
state plane](/internals/index-plane-and-state-plane/).

One memory holds one fact. A memory is a single claim. Writing a five-paragraph summary as one
memory defeats retrieval, because the arm that should rank one of those claims scores the whole blob
instead. Split the summary into claims and let `memhtml link` carry the relationships between them.
See [the memory file format](/internals/the-memory-file-format/).

Read the flags instead of guessing them. Every flag the binary accepts is in the manifest, and an
unknown flag returns a usage error with a suggestion attached rather than a silent default. A guess
costs you a round trip that reading the manifest does not. See [global
flags](/reference/global-flags/).

## 3. Which surface you are on

Two surfaces reach the same store, and the test for which one you have is free.

| Signal | Surface | Entry point |
| --- | --- | --- |
| `memory_search` is in your tool list | MCP | Call the tools directly. Nothing to install. |
| You can run a shell command | CLI | `memhtml manifest`, then the command you need. |
| Neither | Read-only | You are reading documentation. Fetch the Markdown, not the HTML. |

The MCP server is the CLI. `memhtml serve mcp` speaks stdio and composes the same services the
command line does, so both surfaces agree on which store, which database, and which vector space a
call reaches. A tool's arguments mirror its command's flags. See [MCP
tools](/reference/mcp-tools/) and the [reference overview](/reference/), which links one page per
command.

:::agent
**For an agent.** Read your tool list to find your surface, rather than running a command and
inspecting the failure. When `memory_search` is absent from that list, you are on the CLI.
:::

## 4. The shortest path to a working integration

On the MCP surface there is no setup: call `memory_search` with prose, then `memory_read` on a hit's
path. On the command line:

```bash
memhtml manifest                      # the contract, and the liveness check
memhtml init                          # scaffold a store at --repo or $MEMHTML_ROOT
memhtml write --title … --claim …     # one memory, one fact, one commit
memhtml search "prose, not a query language" --dense
```

Make `--dense` a habit on every call. It emits minified JSON with null fields dropped, which is what
you want when the output goes into a prompt. `memhtml recall` runs the same retrieval under a
character budget, for when you want a context pack rather than a hit list.

Every command writes exactly one JSON envelope to stdout and nothing else, and sends its logs to
stderr. Exit 0 is success. Exit 2 is a usage error you fix by changing the call. Exit 1 is a runtime
failure you fix by changing the store or the environment.

## 5. What to avoid

- Scraping these pages. Every one of them is served as Markdown; section 7 has the URLs.
- Parsing the `error` prose. Section 2 explains what that costs you.
- Writing a query language into `memhtml search`. The argument is prose, and retrieval fuses four
  ranking arms, so an operator syntax has nothing to bind to.
- Bundling unrelated writes. The store owns staging and every corpus change is exactly one commit,
  so a caller cannot make one commit mean two things. Use `memhtml apply` when the writes are one
  change.
- Spending a tool call per hop. A question that needs several traversals of the corpus is one
  `memhtml exec` script against a read-only mount. See [the code-mode
  guide](/reference/guide/code-mode/).
- Editing `.memhtml/index.db`, or hand-writing a memory file's markup from memory. Write through the
  commands, which own the commit and the validation.

## 6. Read next

Each row carries the page and its raw Markdown, so you can fetch rather than render. The [reference
tier](/reference/) is generated from the source registries, and it is where every count and every
enumerated value lives.

| Read this | Raw Markdown |
| --- | --- |
| [First call](/reference/guide/first-call/): the envelope, the exit codes, `--dense` | [`first-call.md`](/reference/guide/first-call.md) |
| [Write surfaces](/reference/guide/write-surfaces/): the three ways in | [`write-surfaces.md`](/reference/guide/write-surfaces.md) |
| [When to batch](/reference/guide/when-to-batch/): one write or many | [`when-to-batch.md`](/reference/guide/when-to-batch.md) |
| [Conflicts](/reference/guide/conflicts/): what a contradiction does | [`conflicts.md`](/reference/guide/conflicts.md) |
| [Authoring](/reference/guide/authoring/): the markup a memory is | [`authoring.md`](/reference/guide/authoring.md) |
| [Code mode](/reference/guide/code-mode/): many hops in one call | [`code-mode.md`](/reference/guide/code-mode.md) |
| [Error codes](/reference/error-codes/): the values you branch on | [`error-codes.md`](/reference/error-codes.md) |
| [Response types](/reference/response-types/): the `type` discriminators | [`response-types.md`](/reference/response-types.md) |
| [MCP tools](/reference/mcp-tools/): the tools and their arguments | [`mcp-tools.md`](/reference/mcp-tools.md) |
| [Commands](/reference/): every command, one page each | [`reference.md`](/reference.md) |

## 7. The machine surfaces

Any page is available as Markdown: append `.md` to its path. `/reference/mcp-tools/` is served at
`/reference/mcp-tools.md` as `text/markdown`. This holds for every page on the site, including the
generated ones, and each page links its own twin from `<head>` with
`rel="alternate" type="text/markdown"`.

The whole site comes three ways. [`llms.txt`](/llms.txt) is the index, and it lists this page first.
[`llms-full.txt`](/llms-full.txt) is every page in one file. [`llms-small.txt`](/llms-small.txt) is
the same corpus with non-essential content removed, for a tighter context.

:::agent
**For an agent.** Fetch `llms-small.txt` before `llms-full.txt`. When you already know which page
you want, fetch that page's `.md` twin instead of either bundle: it is a fraction of the tokens and
the same text.
:::
