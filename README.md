# memhtml

[![check](https://github.com/memhtml/memhtml/actions/workflows/check.yml/badge.svg)](https://github.com/memhtml/memhtml/actions/workflows/check.yml) [![security](https://github.com/memhtml/memhtml/actions/workflows/security.yml/badge.svg)](https://github.com/memhtml/memhtml/actions/workflows/security.yml) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/memhtml/memhtml/badge)](https://scorecard.dev/viewer/?uri=github.com/memhtml/memhtml) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

memhtml stores an agent's long-term memory as a git repository of semantic HTML5 files, one fact per file. A rebuildable SQLite index sits over that tree, and retrieval fuses four ranking arms. Writers work in sessions over an immutable in-memory head, each session lands as one commit, and curation runs as a session on a branch a human reviews before it lands.

## Install

One package carries the whole system — the CLI, code mode, the trace indexer, and the MCP server — and installs two binaries, `memhtml` and `memhtml-mcp`. Node 24 or newer.

```bash
npm i -g memhtml       # or: pnpm add -g memhtml, bun add -g memhtml
npx memhtml manifest   # every command, flag, and error code, without installing anything
```

Point it at a corpus with `MEMHTML_ROOT` (default `~/memhtml`), and at your transcripts with `MEMHTML_TRACE_ROOT` (default `~/.claude`). Reading and writing memories needs no credentials; embeddings and write-time entity extraction use Bedrock through the default AWS credential chain, and `MEMHTML_EMBED=off` / `MEMHTML_LLM=off` turn both off.

To register the MCP server with a coding agent, use `memhtml integrations install` in the next section, which writes the entry for you.

```bash
memhtml init                                  # scaffold $MEMHTML_ROOT: git init, PARA dirs, merge driver
memhtml write --title "WAL admits one writer and many readers" --type semantic \
  --claim "A CLI command and a running memhtml serve mcp share one index.db."
memhtml search "one writer many readers"      # FTS + vector + recency + salience, fused with RRF
memhtml serve mcp                             # the same store over stdio: 15 tools, 2 resources
```

`memhtml manifest` (or a bare `memhtml`) answers with every command, flag, response type, and error code the binary accepts, and it answers on a machine with no repo, no database, and no credentials. Every command writes exactly one JSON envelope to stdout (the one exception is `memhtml help` on a terminal, which writes Markdown), logs go to stderr, and the exit code is 0 for success, 2 for a usage error, 1 for a runtime failure. `AGENTS.md` is generated from the same table that drives parsing, so the doc cannot drift from the binary.

## Wire up your coding agent

One command wires an agent to the store: the MCP server entry, hooks, a fenced block in the host's instruction file, and a skill, all recorded in a receipt with the SHA-256 of every owned file or fragment, so uninstall removes exactly what install wrote and nothing you added beside it.

```bash
npx memhtml@latest integrations install       # every host whose home directory exists
memhtml integrations install claude           # or codex, cursor, opencode
memhtml integrations install --dry-run        # what it would write, and the rendered content
```

| Host        | What gets written                                                                                                            | Your step                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Claude Code | `~/.claude.json` MCP entry, four hooks in `~/.claude/settings.json`, a block in `~/.claude/CLAUDE.md`, a skill               | none, the files are watched               |
| Codex CLI   | `[mcp_servers.memhtml]` in `~/.codex/config.toml`, two hooks in `~/.codex/hooks.json`, a block, a skill                      | restart, then trust the hooks in `/hooks` |
| Cursor      | `~/.cursor/mcp.json` entry, `sessionStart` in `~/.cursor/hooks.json`, a skill; with `--project`, `.cursor/rules/memhtml.mdc` | restart for the MCP entry                 |
| OpenCode    | `mcp.memhtml` in `opencode.json`, a generated plugin, a block in `AGENTS.md`, a skill                                        | restart, plugins load at startup          |

A hook reads the host's payload on stdin, runs recall or transcript indexing under a hard time bound, and prints the host's own protocol, so the agent starts a session and each prompt with the memories that matter. No hook writes a memory: memhtml is single-writer, and distilling a transcript into a durable fact belongs to a curator on a reviewable branch. Any failure inside a hook prints nothing and exits 0, so a hook can never block a turn.

```bash
memhtml integrations doctor     # binary path and version, store root, MCP entry, hooks, block, skill, live handshake
memhtml integrations list       # installed, modified, or not installed, per host and scope
```

Re-running is idempotent, `--project <path>` installs at repository scope instead, and a managed fragment a human changed is refused with `ERR_INTEGRATION_MODIFIED` until you pass `--force`, which keeps a timestamped backup. [Wire up your coding agent](apps/docs/src/content/docs/learn/operations/wire-a-coding-agent.md) has the per-host files and flags; [hooks and recall](apps/docs/src/content/docs/learn/operations/hooks-and-recall.md) has what each hook injects and how to run one by hand.

## The design in three sentences

The git tree is the system of record, and `.memhtml/index.db` is a projection of it whose memory rows `memhtml index rebuild` recomputes from the files. Anything that must survive `rm index.db` lives in the files, where authored links are `<link>` elements and metadata is `<meta>` elements, while re-derivable artifacts such as embeddings stay in gitignored files. Every archive moves a memory file to `archive/<YYYY>/`, or `archive/<YYYY>.<n>/` when an earlier archiving holds that slot, mirroring the original path, so the file stays in the tree and `git log --follow` reads straight through a memory's whole life.

Figure 1 draws that. It is built from monospace box characters, which a screen reader reads as noise, so skip to the paragraph below the figure: it says the same thing in words.

<!-- dprint-ignore-start -->
<!-- figure:system-topology -->
```text
 +--------+  +---------------+ +----------------+
 |the CLI |  |the MCP server | |your file tools |
 |        |  |               | |                |
 +--------+  +---------------+ +----------------+
      |              |                |
      |           commit              |
      |              |                |
      +--commit---+  |  +----yours----+
                  |  |  |
                  v  v  v
              +-------------+
              |the git tree |
              |             |
              +-------------+
                   |     |
            +------+     |
            |            |
         archive      indexer
            |            |
            v            |       .------.
       +---------+       v      |\-____-/|
       |archive/ | +---------+  |        |
       |         | |index.db |  |        |
       +---------+ |         |  |state.db|
                   +---------+  |        |
                         |       \-____-/
                         |
                         |          |
                      3 arms        |
                         |          |
                         |      salience
                         |          |
                         +-----+    |
                               |    |
                               v    v
                          +-------------+
                          |RRF then MMR |
                          |             |
                          +-------------+
                                  |
                                  v
                           +------------+
                           |ranked hits |
                           |            |
                           +------------+
```
<!-- /figure:system-topology -->
<!-- dprint-ignore-end -->

**Figure 1: every write door lands in the git tree, and the index that ranks a search is derived from it.** Three doors reach in from outside: `memhtml write` and `memhtml apply`, the MCP server's 15 tools, and your own file tools. All three commit into one git tree, and they differ only in who owns the commit. Every archive moves a file to `archive/<YYYY>/` or `archive/<YYYY>.<n>/` and leaves it in the tree. From the tree, a git-driven indexer derives `index.db`, which supplies three of the four ranking arms. The fourth, salience, comes from `state.db`, the one plane git cannot reproduce. A `memhtml search` query enters the ranker at the bottom, RRF fuses the four arms, MMR diversifies the result, and ranked hits come out. On the docs site the same drawing puts into its borders what this caption has to spell out: a heavy border is a door, a double border is the system of record, a dashed border is a projection that can be deleted and rebuilt, and a cylinder is a database on disk.

## Why files

A memory an agent can be trusted with has to be reviewable, diffable, and recoverable. git supplies all three directly, and that is why every write below lands as a commit:

- A correction is a commit. `memhtml correct` writes the new file and archives the old one in one commit, so an interrupted run cannot leave two live memories contradicting each other.
- A batch is a commit. `memhtml apply` (JSONL ops) and `memory_write_batch` (MCP) stage N files, make one commit, and reindex once. The batch is atomic by default, per-op results come back in input order, and a duplicate succeeds with `deduped: true` and the existing path.
- Curation is a branch. A curator works as a session on a `curate/<date>` branch and lands through the same commit gate as any other session, so a human reads the curation as commits on a branch before `main` moves.

## Who does what

Three actors share one tree. The agent writes facts, and it resolves only the conflicts it found itself. The curator works on a branch when a caller starts one, and it detects conflicts without resolving them. The human owns the gate and every one-way door.

Figure 2 draws the cycle they form. A screen reader reads its box characters as noise, so the paragraph beneath the figure carries the same content in words.

<!-- dprint-ignore-start -->
<!-- figure:three-actors -->
```text
         +----------+
         |the agent |
         |          |
         +----------+
              |
           writes
              |
              v
          +-------+
          | main  |
          |       |
          +-------+
             |  ^
             |  +---+
             |      |
           reads    |
             |      |
             v      |
  +------------+    |
  |the curator |    |
  |            |    |
  +------------+    |
         |          |
         |        merge
      commits       |
         |          |
         v          |
 +--------------+   |
 |curate/<date> |   |
 |              |   |
 +--------------+   |
            |       |
         review     |
            |       |
            |    +--+
            |    |
            v    |
        +------------+
        | the human  |
        |            |
        +------------+
```
<!-- /figure:three-actors -->
<!-- dprint-ignore-end -->

**Figure 2: the three actors form a cycle through `main`, and only one of them may settle a contradiction.** Reading top to bottom: the agent writes to `main` at any hour, one fact per file. The curator reads `main` when it runs and puts its commits on a `curate/<date>` branch, leaving `main` untouched. Those commits remove duplicates, resolve entity aliases, file inbox records, fold near-duplicates into canonical records, and write arcs, and they flag a contradiction without choosing a winner. The human reviews that branch and lands it with `memhtml curate merge`, which returns the cycle to `main` and to the agent. The two heavy-bordered boxes are the actors outside the system, and `main` and the branch are double-bordered because they are the system of record.

## The file format

One fact per file, in standard HTML5 that a browser displays and a person can read in view-source. The element vocabulary is closed, and `memhtml doctor` warns on anything outside it. Each element carries meaning the indexer reads, which is the structure Markdown gives you no way to express:

```html
<article>
  <p><mark>If a prod rollback is issued, drain the VIP before reverting the deploy.</mark>
  The revert alone leaves in-flight connections pinned to the old target group,
  observed on <time datetime="2026-07-28">July 28</time> during the <cite>checkout-api sev2</cite>.</p>
  <dl><dt>Applies to</dt><dd>ALB/NLB target-group deploys</dd></dl>
  <details><summary>How this was learned</summary><p>Three rollbacks replayed the same 500-spike…</p></details>
  <aside><p>Fly.io and Cloud Run drain automatically; this is AWS-specific.</p></aside>
</article>
```

The single `<mark>` is the claim. It becomes the gist every listing shows, and it is the span a correction targets. `<time datetime>` records when the fact happened in the world, so an episodic memory ranks by that date instead of by its write time; it takes a calendar date or the canonical UTC instant `YYYY-MM-DDThh:mm:ssZ` and nothing else, because those values are compared and ordered as raw strings and only a fixed grammar sorts lexicographically the way it sorts chronologically. The datetime metas in the head — `memhtml-created`, `memhtml-updated`, `memhtml-valid-from`, `memhtml-valid-until`, `memhtml-archived`, `memhtml-due` — take that same grammar, and a value outside it is a document violation rather than a dropped optional: dropping an unsortable `memhtml-valid-until` would widen the validity window to always-valid. `<dl>` pairs index as facets and `<cite>` as citations. `<details>` folds elaboration behind a summary, and recall always discloses that a fold is there. `docs/format.md` is the full vocabulary. `docs/tasks.md` covers the task type (`memhtml-task-status`, `memhtml-due`), which rides the same format.

## Writing

Three doors, all supported, all landing in the same tree:

1. The CLI. `memhtml write` takes one memory. Give it `--claim` plus `--body` and the template owns the markup; give it `--article-html` and you own the markup, with the format check refusing violations before anything is written. `memhtml apply` takes many: one JSONL op per line, every op validated for shape before any of them executes, then one commit and one index pass.
2. The MCP server. `memhtml serve mcp` speaks stdio and exposes 15 tools and 2 resources over the same repo: write, read, search, recall, correct, link, archive, batch writes, and trace search. A CLI command and a running server share one store, because WAL admits one writer and any number of readers, and a contended write retries on `SQLITE_BUSY` (see `RUNBOOK.md`, section 4).
3. Your file tools. The tree is the system of record, so a hand-written file is as real as one the CLI wrote. You take on what the write path would have done: format validity (`memhtml doctor`), path choice, dedup, and the commit.

These three commit straight to the store with no write bar. A session is the write path that's held to the store's write bar, and the next section describes it. Under the default store policy, the CLI's record-creating doors refuse inside a run session and name the session command that does the same job.

Dedup is enforced by the schema: a partial unique index over active files makes a duplicate write impossible to index, so the write returns the existing path with `deduped: true` and creates nothing.

A memory's whole life is commits in one tree.

Figure 3 draws that life. A screen reader sounds out its box characters, so read the paragraph beneath the figure, which states the same transitions in words.

<!-- dprint-ignore-start -->
<!-- figure:memory-lifecycle -->
```text
          +--------+
          | write  |
          |        |
          +--------+
               |
            commit
               |
               v
          +-------+
          |active |
          |       |
          +-------+
             |  |
        +----+  +----+
        |            |
 correct or fold   evict
        |            |
        v            v
 +-----------+  +--------+
 |superseded |  |evicted |
 |           |  |        |
 +-----------+  +--------+
```
<!-- /figure:memory-lifecycle -->
<!-- dprint-ignore-end -->

**Figure 3: a memory has one entry and two exits, and every one of them is a commit.** A write enters the corpus as a single dedup-checked commit, and the file is then active. It stays active while agents read and reinforce it. `memhtml correct` writes a replacement and archives the original in one commit. A `memhtml curate collapse` fold writes one canonical memory and archives each near-duplicate it replaces. Either way a `supersedes` link from the new memory makes the old one superseded. An eviction archives the memory with no successor: `memhtml archive`, `memhtml task status <path> done`, or an `archive` operation a session commits. A curator's folds and archives land on its `curate/` branch and reach the target branch once `memhtml curate merge` lands it. Each exit moves the file to `archive/<YYYY>/`, or `archive/<YYYY>.<n>/` when an earlier archiving holds that slot, with the original path mirrored beneath, so the file survives all of them and `git log --follow` reads straight through the whole life.

## Sessions, the head server, and curation

memhtml 0.16 changes how the corpus is held and written. A memory file is the same file it was, and git is still the system of record. Upgrading from 0.15 takes a few operator steps, which the migration guide at https://memhtml.github.io/learn/operations/migrate-to-0-16/ walks through.

**How a write happens.** A writer opens a session on a ref. The session sees one immutable version of the corpus, the head, plus its own log of operations: `put`, `archive`, `move`, `link`, `unlink`, `label`, and `unlabel`. `memhtml session put` appends JSONL write lines. `memhtml session exec` runs a bash heredoc over the head and the session's own changes, mounted at `/mnt/memhtml`, and turns the files the script wrote into operations. `memhtml session commit` validates the whole log, checks that the ref is still at the version it validated, marks a frame-key contradiction with a `contradicts` edge, and lands the log as one commit with a compare-and-swap on the ref. When another writer landed first, the answer is `rebase-needed`, and `memhtml session rebase` and a retry settle it. An agent runtime can bind every process of one run to one session by exporting `MEMHTML_SESSION`, and commit it once when the run ends.

```sh
export MEMHTML_SESSION=run-42
memhtml session exec <<'SH'
grep -rl 'content="system:memhtml"' /mnt/memhtml/projects | wc -l
SH
printf '%s\n' '{"op":"write","title":"session exec runs bash","type":"semantic","body":"memhtml session exec runs its script as bash unless --lang js is passed.","entity":"system:memhtml"}' \
  | memhtml session put --file -
memhtml session commit --message "what this run learned" --drop-refused
```

**The head server.** `memhtml head serve` keeps one store's head loaded and answers over a Unix socket at `.memhtml/head.sock`, or a named pipe on Windows. `head search`, `session put`, `session exec`, `session commit`, and `session rebase` ask it first and take the local path when no server answers, so a server makes a call faster and doesn't make it fail. MCP `memory_search` and `memory_recall` ask it too, so a record a session committed is searchable before the SQLite index catches up. On a 7,437-record copy of a production store (2026-09-27), a search through the server took 0.84 s at p50 from the CLI against 2.6 s locally, and 36 ms over the socket directly.

**Curation.** Judgment runs off the write path. `memhtml curate run` is a bounded, model-driven tool loop that works as a session on a `curate/<date>` branch. It removes duplicates, labels records that name no entity, files inbox records into their homes, and writes arcs, and it never settles a contradiction by deleting a side. `memhtml curate collapse` folds clusters of near-duplicates into canonical records in bulk, from a deterministic plan. Nothing reaches `main` from a curate branch except `memhtml curate merge`, which scores retrieval on both versions with the head gate and refuses a landing that makes it worse. A human runs it, or a gate does.

```sh
memhtml curate run --model fake    # credential-free; pass bedrock:<model id> for a real run
memhtml curate merge curate/$(date -u +%F)
```

**The store policy file.** What every writer to one store must agree on lives in `memhtml.config.json` at the store root, tracked in git. It sets the write bar (the memory types no session may write, and whether every new record must name an entity or sit under a project), the `v1Doors` mode, and the curator's writer buckets and placement quota. With no file, neutral defaults apply. A malformed file fails closed with `ERR_STORE_CONFIG`, and `memhtml config` prints the effective policy and where each value came from. The v1 doors still work. Under the default `closed-in-session` mode they refuse inside a run session and name the session command to use, and under `closed` they refuse everywhere.

**Removed in 0.16.** The sleep pipeline (`memhtml sleep` and its six subcommands), the consolidator agent, `apply --consolidate`, and the MCP fields and resource that reported on them are gone. `curate run`, `curate collapse`, and `curate merge` replace them. `docs/design.md` sections 15 to 24 describe the design and the decisions behind it.

## Retrieval

Four ranking arms are fused by reciprocal rank fusion (RRF, k=60) inside one SQL statement, and maximal marginal relevance (MMR) diversifies the result afterwards in TypeScript:

| arm      | weight | what it ranks                                                                                                       |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| fts      | 1.0    | one denormalized title+gist+body column                                                                             |
| vector   | 1.0    | exact brute force over Cohere Embed v4 (1024-dim), grouped by path so a long memory does not outrank a relevant one |
| recency  | 0.5    | `coalesce(event_at, updated_at)`, so an episodic memory sorts by when the fact happened                             |
| salience | 0.4    | the durable access plane, attached in the same statement, with tasks and `resources/people/` excluded               |

A Bedrock outage narrows retrieval instead of stopping it. Arms that need a query vector are dropped before the statement is assembled, the response carries `degraded: true`, and the remaining arms answer.

Salience counts the opens a caller chose. `memhtml read` and `memory_read` of a named path bump the access plane; a path that `memhtml search` or `memhtml recall` merely returned does not, and neither does a curation pass. Bumping on a hit would make today's top five rank higher tomorrow for having been listed, while the memory that should displace them never gets a first bump. `memhtml reinforce` is the explicit outcome channel, and it moves the same exponentially weighted moving average. The arm also stays out of the way of a `task` row and a `resources/people/` reference record: both are reached by predicate and by key, and salience there would reward a stale task and decay a person's identity.

`memhtml recall` adds a disclosure fold on top. Arcs get their own character envelope, so a summary does not compete with the memories it summarizes. Each fold quotes at most 2 memories per entity name, and everything past the budget collapses to one index line plus a path to drill into.

## The discrimination gate

`memhtml eval discriminate` reports the number that says whether retrieval can tell two similar facts apart. Embeddings are weakest on the tokens that carry a fact's polarity: "drain the VIP before reverting" and "do not drain the VIP before reverting" sit above 0.99 cosine similarity while asserting opposite things. So the gate derives every control from the probe's own target by flipping a negation, a number, or a qualifier, which makes each control a high-cosine wrong answer by construction. Every target has to strictly outrank all of its own controls, mean reciprocal rank has to clear 0.85, and one inversion fails the run.

One place runs it: `pnpm check`, which CI runs. Fake-embedder mode is deterministic and needs no credentials. `live` mode is an operator diagnostic, and it reports `skipped: true` when it cannot reach the model, so a skipped gate reads as skipped rather than as green.

## Code-mode

The closed vocabulary makes the corpus a queryable API with no new surface: `article mark` is always the claim, `link[rel^="memhtml-"]` is always an authored edge, and `dl` pairs are always facets. Use the descendant selector. The markup is `<article><p><mark>`, so `article > mark` matches nothing and a helper written from that spelling reports zero claims while looking correct. An agent that writes parser code against `$MEMHTML_ROOT` composes multi-hop traversals in one execution and answers corpus-shaped questions no tool enumerates: live contradiction pairs, an orphan census, a walk up a supersedence chain. The contract is read-only, and writes stay behind the doors above. `memhtml session exec` is the writable twin: it runs a bash heredoc or a JS module over the head plus a session's own changes and turns the files the script wrote into session operations.

`memhtml exec` ships this as a command. It runs your script in a QuickJS sandbox with the corpus mounted read-only at `/mnt/memhtml` and a helper preloaded at `/workspace/lib/corpus.mjs`, and it answers one `exec.report` envelope. Measured on the 305-file fixture corpus: 305/305 claims parsed and 410/410 edges resolved in one execution. The script reads a pinned commit, so an answer is reproducible and an uncommitted edit stays invisible to it. The sandbox reaches the structural and lexical planes and holds no index handle, so a script that wants ranked retrieval shells out to `memhtml search` and consumes its envelope. `docs/code-mode.md` is the cookbook, with a measured helper and five recipes.

## Measured

| benchmark                                                            | memhtml    | published reference                 |
| -------------------------------------------------------------------- | ---------- | ----------------------------------- |
| MemoryAgentBench FactConsolidation single-hop (26KB to 1.1MB stores) | 92% to 97% | ~60% at 26KB only                   |
| MemoryAgentBench FactConsolidation multi-hop                         | 37% to 49% | ≤7% all methods                     |
| BEAM Contradiction Resolution (100K split, 40 probes)                | 43.8% mean | 0% to 5% all systems                |
| LongMemEval-S (full 500, judged 2026-08-07)                          | 67.0%      | ~55% to 65% typical agent baselines |

Read the cross-judge numbers as reference points rather than as a ranking: the judges here are verbatim prompt ports running haiku-4.5, where the papers used gpt-4o and gpt-4.1-mini. `ROADMAP.md` carries these numbers and the horizons they rank.

## Layout

```
$MEMHTML_ROOT/                        # its own git repo, one global memory store
  projects/<workspace-slug>/      # a workspace IS a directory. There is no workspaces table.
  areas/<area-slug>/              # ongoing responsibilities
  areas/arcs/                     # behavioral arcs (written by curation only)
  areas/inbox/                    # where an unplaceable memory lands
  resources/<topic>/
  resources/people/<person>.html  # the person plane
  archive/<YYYY>[.<n>]/<original-path>  # soft-evicted, path-preserving, injective
  .memhtml/
    index.db                      # gitignored, rebuildable from the tree
    state.db                      # gitignored, NOT rebuildable from git
    state/access.jsonl            # committed sidecar: the state plane's only durable copy
    sessions/<id>.json            # gitignored, one session's log of operations
    snapshots/<sha>.arrow         # gitignored, the head's cold-start cache
    vectors/<model>@<dim>.arrow   # gitignored, the head's vector cache
    head.sock                     # gitignored, the head server's socket
  memhtml.config.json             # committed store policy, never a record
  sitemap.xml + per-dir index.html  # generated by `memhtml publish`, committed
```

## Packages

The layering is strict and TypeScript project references enforce it. `@memhtml/contracts` and `@memhtml/domain` import `effect` and nothing else, and a test reads `domain`'s own `dist` to confirm it names no database driver, no SDK, and no `node:fs`.

None of them is published. Every workspace package is `private`, and `mise run package:assemble` bundles the libraries and the binary-bearing apps into the single `memhtml` package that carries the two binaries — the docs site and the integration-test harness stay outside the bundle (`tsdown.config.ts` names the exact set). The table below is a map of the source, not a list of things to install. `RELEASING.md` covers how the artifact is built and what must stay outside the bundle.

| Package                 | What it owns                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `@memhtml/contracts`    | Schemas, the closed vocabularies, errors, path algebra. Zero I/O.               |
| `@memhtml/domain`       | Pure math: retention, decay, RRF, MMR, PageRank, the anti-merge guards.         |
| `@memhtml/html`         | The memory file format: parse, serialize, hash, surgical head editors.          |
| `@memhtml/store`        | The git-backed file store. One commit per operation, typed conflicts.           |
| `@memhtml/index`        | SQLite schema, the git-driven indexer, four-arm RRF retrieval, the state plane. |
| `@memhtml/traces`       | Streaming JSONL parser over `~/.claude`, with a size+mtime+offset watermark.    |
| `@memhtml/llm`          | Bedrock: Cohere embeddings and forced-tool structured output.                   |
| `@memhtml/eval`         | The fixture corpus generator and the refusable discrimination gate.             |
| `@memhtml/head`         | One corpus version in memory: indexes, overlays, search, and the head gate.     |
| `@memhtml/session`      | Session logs, validation, the commit path, and the checkout lock.               |
| `@memhtml/snapshot`     | Arrow snapshots of the head per commit, and the vector cache.                   |
| `@memhtml/curator`      | The curator's tool loop, its charters and budget, and the collapse planner.     |
| `@memhtml/integrations` | Wiring a coding agent to a store: MCP entry, hooks, instructions, receipt.      |
| `@memhtml/telemetry`    | The opt-in OTLP trace exporter.                                                 |
| `@memhtml/cli`          | The `memhtml` binary, the envelope contract, and the one composition root.      |
| `@memhtml/mcp`          | The `memhtml-mcp` stdio server: 15 tools, 2 resources.                          |
| `@memhtml/docs`         | The documentation site.                                                         |

## Development

[`mise`](https://mise.jdx.dev) is the command surface. It installs the toolchain from `mise.toml`, which declares node, pnpm, lefthook, and the scanners, each pinned by checksum and provenance in the committed `mise.lock`, so a clone resolves the same binaries CI does:

```bash
mise install        # node 24, pnpm 11.21.0, lefthook, scanners, from mise.lock
mise run install    # dependencies from the lockfile + the git hooks
mise run check      # the definition of done: lint, lint:repo, lint:md, typecheck, tests, integration, eval, a11y, budget
```

CI runs that same `mise run check`, so the gate cannot drift from the one you run locally. Every task delegates to the pnpm script underneath it, and turbo owns the task graph and the cache. No mise task declares `sources` or `outputs`, because mise decides freshness by mtime and turbo by content hash, so a mise-level skip would preempt turbo's per-package hashing.

`check` includes the discrimination gate in fake mode, so a change that degrades retrieval fails the build. Tests run against a real temp-dir git repo and a real SQLite database with the shipped migrations. Fakes are limited to the two edges that reach the network, the embedder and the model, because a stateless fake verifies the shape of a call and misses the state semantics behind it, which is where the defects in this system have actually lived.

| Command                     | Delegates to            | What it runs                                                                   |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `mise run build`            | `pnpm build`            | `tsc -b` across the project graph                                              |
| `mise run lint`             | `pnpm lint`             | biome per package, plus `lint:repo` (`biome check .`) over the repo            |
| `mise run lint:md`          | `pnpm lint:md`          | dprint over every authored Markdown file                                       |
| `mise run typecheck`        | `pnpm typecheck`        | strict `tsc --noEmit`, tests included                                          |
| `mise run test`             | `pnpm test`             | every package's unit and property suites                                       |
| `mise run test:integration` | `pnpm test:integration` | the cross-package contracts over a real repo and a real database               |
| `mise run test:eval`        | `pnpm test:eval`        | the discrimination gate (fake mode)                                            |
| `mise run test:a11y`        | `pnpm test:a11y`        | WCAG 2.2 AA over the built docs site, in a real browser                        |
| `mise run gen:fixture`      | `pnpm gen:fixture`      | write a browsable fixture corpus (pure function of a seed)                     |
| `mise run agents-doc`       | none                    | regenerate `AGENTS.md` from the built CLI's own table                          |
| `mise run security`         | none                    | osv-scanner + semgrep + betterleaks + syft/grype + trivy, SARIF into `.sarif/` |
| `mise run tools:bump`       | none                    | re-resolve every `latest` tool in `mise.lock`                                  |

To narrow a run to one package, use `mise run test-pkg <package> [vitest args]`. The package name takes either spelling, and everything after it goes to vitest:

```bash
mise run test-pkg domain rrf -t "strictly"    # one test
mise run test-pkg index retrieval             # one file
```

That path goes straight to the package's vitest, so it skips turbo and builds nothing first. Every `@memhtml/*` package's exports resolve only to `./dist`, so run `mise run build` after editing another package's `src/`.

`mise.toml`'s `[tools] pnpm` and `package.json`'s `packageManager` both declare the pnpm that runs, and neither can be derived from the other. `mise run tools:verify` fails when they disagree, and `mise run install` depends on it, so the check runs on every install. Declaration order matters too: `pnpm` sits above `node` because node's own bin holds a `pnpm` symlink into corepack wherever `corepack enable` has run, and with node first every pnpm call would resolve to corepack rather than to the pinned binary.

## Docs

| File                | What it holds                                                   |
| ------------------- | --------------------------------------------------------------- |
| `AGENTS.md`         | The full command surface, generated from the binary's own table |
| `RUNBOOK.md`        | Operating the store day to day                                  |
| `ROADMAP.md`        | The system-level view: measured standing, ranked horizons       |
| `docs/design.md`    | Every architectural decision with its evidence                  |
| `docs/format.md`    | The file format and the closed vocabulary                       |
| `docs/tasks.md`     | The task memory type                                            |
| `docs/code-mode.md` | Navigating the corpus with code                                 |
| `docs/backlog.md`   | The fine-grained ledger                                         |
| `SECURITY.md`       | Supported versions and private vulnerability reporting          |
