# memhtml

[![check](https://github.com/memhtml/memhtml/actions/workflows/check.yml/badge.svg)](https://github.com/memhtml/memhtml/actions/workflows/check.yml)
[![security](https://github.com/memhtml/memhtml/actions/workflows/security.yml/badge.svg)](https://github.com/memhtml/memhtml/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/memhtml/memhtml/badge)](https://scorecard.dev/viewer/?uri=github.com/memhtml/memhtml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

memhtml stores an agent's long-term memory as a git repository of semantic HTML5 files, one fact per
file. A rebuildable SQLite index sits over that tree, retrieval fuses four ranking arms, and a nightly
curation pipeline commits its work to a branch a human reviews before it lands.

## Install

One package carries the whole system — the CLI, code mode, the sleep cycle, the trace indexer, and the
MCP server — and installs two binaries, `memhtml` and `memhtml-mcp`. Node 24 or newer.

```bash
npm i -g memhtml       # or: pnpm add -g memhtml, bun add -g memhtml
npx memhtml manifest   # every command, flag, and error code, without installing anything
```

Point it at a corpus with `MEMHTML_ROOT` (default `~/memhtml`), and at your transcripts with
`MEMHTML_TRACE_ROOT` (default `~/.claude`). Reading and writing memories needs no credentials;
embeddings and the sleep cycle's model calls use Bedrock through the default AWS credential chain, and
`MEMHTML_EMBED=off` / `MEMHTML_LLM=off` turn both off.

To register the MCP server with a client, the command is `memhtml-mcp` over stdio.

```bash
memhtml init                                  # scaffold $MEMHTML_ROOT: git init, PARA dirs, merge driver
memhtml write --title "WAL admits one writer and many readers" --type semantic \
  --claim "A CLI command and a running memhtml serve mcp share one index.db."
memhtml search "one writer many readers"      # FTS + vector + recency + salience, fused with RRF
memhtml serve mcp                             # the same store over stdio: 14 tools, 2 resources
```

`memhtml manifest` (or a bare `memhtml`) answers with every command, flag, response type, and error code
the binary accepts, and it answers on a machine with no repo, no database, and no credentials. Every
command writes exactly one JSON envelope to stdout, logs go to stderr, and the exit code is 0 for
success, 2 for a usage error, 1 for a runtime failure. `AGENTS.md` is generated from the same table that
drives parsing, so the doc cannot drift from the binary.

## The design in three sentences

The git tree is the system of record, and `.memhtml/index.db` is a projection of it that can be deleted
and rebuilt without loss. Anything that must survive `rm index.db` lives in the files, where authored
links are `<link>` elements and metadata is `<meta>` elements, while re-derivable artifacts such as
embeddings and mined edges live only in the index. Every removal is a `git mv` into `archive/<YYYY>/`
that mirrors the original path, so the file stays in the tree and `git log --follow` reads straight
through a memory's whole life.

Figure 1 draws that. It is built from monospace box characters, which a screen reader reads as noise, so
skip to the paragraph below the figure: it says the same thing in words.

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
          +--------+     |
          |              |
       git mv         indexer
          |              |
          v              |        .------.
   +--------------+      v       |\-____-/|
   |archive/YYYY/ | +---------+  |        |
   |              | |index.db |  |        |
   +--------------+ |         |  |state.db|
                    +---------+  |        |
                         |        \-____-/
                         |
                         |           |
                      3 arms         |
                         |           |
                         |       salience
                         |           |
                         +------+    |
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

**Figure 1: every write door lands in the git tree, and every read is served from projections of it.**
Three doors reach in from outside: `memhtml write` and `memhtml apply`, the MCP server's 14 tools, and
your own file tools. All three commit into one git tree, and they differ only in who owns the commit.
Eviction moves a file to `archive/YYYY/` and leaves it in the tree. From the tree, a git-driven indexer
derives `index.db`, which supplies three of the four ranking arms. The fourth, salience, comes from
`state.db`, the one plane git cannot reproduce. A query enters the ranker at the bottom, RRF fuses the
four arms, MMR diversifies the result, and ranked hits come out. On the docs site the same drawing puts
into its borders what this caption has to spell out: a heavy border is a door, a double border is the
system of record, a dashed border is a projection that can be deleted and rebuilt, and a cylinder is a
database on disk.

## Why files

A memory an agent can be trusted with has to be reviewable, diffable, and recoverable. git supplies all
three directly, and that is why every write below lands as a commit:

- A correction is a commit. `memhtml correct` writes the new file and archives the old one in one
  commit, so an interrupted run cannot leave two live memories contradicting each other.
- A batch is a commit. `memhtml apply` (JSONL ops) and `memory_write_batch` (MCP) stage N files, make
  one commit, and reindex once. The batch is atomic by default, per-op results come back in input
  order, and a duplicate succeeds with `deduped: true` and the existing path.
- A nightly curation run is a branch. `memhtml sleep run` walks sixteen phases and commits each one's
  work on its own, so a human reads the curation one phase-shaped diff at a time, and
  `memhtml sleep merge` fast-forwards `main` only after a quality gate that can refuse.

## Who does what

Three actors share one tree. The agent writes facts, and it resolves only the conflicts it found itself.
Sleep curates nightly on a branch, and it detects conflicts without resolving them. The human owns the
gate and every one-way door.

Figure 2 draws the cycle they form. A screen reader reads its box characters as noise, so the paragraph
beneath the figure carries the same content in words.

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
 +---------------+  |
 |sleep, nightly |  |
 |               |  |
 +---------------+  |
         |          |
         |        merge
    15 commits      |
         |          |
         v          |
 +-------------+    |
 |sleep/<date> |    |
 |             |    |
 +-------------+    |
            |       |
         review     |
            |       |
            |   +---+
            |   |
            v   |
        +------------+
        | the human  |
        |            |
        +------------+
```
<!-- /figure:three-actors -->

**Figure 2: the three actors form a cycle through `main`, and only one of them may settle a
contradiction.** Reading top to bottom: the agent writes to `main` at any hour, one fact per file.
Sleep reads `main` nightly and puts its sixteen commits on a `sleep/<date>` branch, leaving `main`
untouched. Those phases deduplicate, resolve entities, decay confidence, compress, and synthesize arcs,
and they flag a contradiction without choosing a winner. The human reviews that branch and merges, which
returns the cycle to `main` and to the agent. The two heavy-bordered boxes are the actors outside the
system, and `main` and the branch are double-bordered because they are the system of record.

## The file format

One fact per file, in standard HTML5 that a browser displays and a person can read in view-source. The
element vocabulary is closed, and `memhtml doctor` warns on anything outside it. Each element carries
meaning the indexer reads, which is the structure Markdown gives you no way to express:

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

The single `<mark>` is the claim. It becomes the gist every listing shows, and it is the span a
correction targets. `<time datetime>` records when the fact happened in the world, so an episodic memory
ranks by that date instead of by its write time. `<dl>` pairs index as facets and `<cite>` as citations.
`<details>` folds elaboration behind a summary, and recall always discloses that a fold is there.
`docs/format.md` is the full vocabulary. `docs/tasks.md` covers the task type (`memhtml-task-status`,
`memhtml-due`), which rides the same format.

## Writing

Three doors, all supported, all landing in the same tree:

1. The CLI. `memhtml write` takes one memory. Give it `--claim` plus `--body` and the template owns the
   markup; give it `--article-html` and you own the markup, with the format check refusing violations
   before anything is written. `memhtml apply` takes many: one JSONL op per line, every op validated for
   shape before any of them executes, then one commit and one index pass.
2. The MCP server. `memhtml serve mcp` speaks stdio and exposes 14 tools and 2 resources over the same
   repo: write, read, search, recall, correct, link, archive, batch writes, and trace search. A CLI
   command and a running server share one store, because WAL admits one writer and any number of
   readers, and a contended write retries on `SQLITE_BUSY` (see `RUNBOOK.md`, section 4).
3. Your file tools. The tree is the system of record, so a hand-written file is as real as one the CLI
   wrote. You take on what the write path would have done: format validity (`memhtml doctor`), path
   choice, dedup, and the commit. Sleep refuses to start on a dirty tree.

Dedup is enforced by the schema: a partial unique index over active files makes a duplicate write
impossible to index, so the write returns the existing path with `deduped: true` and creates nothing.

A memory's whole life is commits in one tree.

Figure 3 draws that life. A screen reader sounds out its box characters, so read the paragraph beneath
the figure, which states the same four transitions in words.

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
                +-----------+
                |  active   |
                |           |
                +-----------+
                   |  |  |
        +----------+  |  +----------+
        |             |             |
        |           evict           |
     correct          |         compress
        |             |             |
        v             v             v
 +-----------+  +---------+  +-----------+
 |superseded |  |archived |  |compressed |
 |           |  |         |  |           |
 +-----------+  +---------+  +-----------+
```
<!-- /figure:memory-lifecycle -->

**Figure 3: a memory has one entry and three exits, and every one of them is a commit.** A write enters
the corpus as a single dedup-checked commit, and the file is then active. It stays active while sleep
reinforces or decays its confidence in place. Three things can end that state: `memhtml correct` writes a
replacement and archives the original in one commit, which makes it superseded; retention triage scores
it into the EVICT band and archives it, which makes it archived; or compress folds it into a synthesized
canonical memory and archives it with a `supersedes` link, which makes it compressed. Each of the three
exits is a `git mv` into `archive/YYYY/` mirroring the original path, so the file survives all of them
and `git log --follow` reads straight through the whole life.

## Retrieval

Four ranking arms are fused by reciprocal rank fusion (RRF, k=60) inside one SQL statement, and maximal
marginal relevance (MMR) diversifies the result afterwards in TypeScript:

| arm | weight | what it ranks |
|---|---|---|
| fts | 1.0 | one denormalized title+gist+body column |
| vector | 1.0 | exact brute force over Cohere Embed v4 (1024-dim), grouped by path so a long memory does not outrank a relevant one |
| recency | 0.5 | `coalesce(event_at, updated_at)`, so an episodic memory sorts by when the fact happened |
| salience | 0.4 | the durable access plane, attached in the same statement, with tasks and `resources/people/` excluded |

A Bedrock outage narrows retrieval instead of stopping it. Arms that need a query vector are dropped
before the statement is assembled, the response carries `degraded: true`, and the remaining arms answer.

Salience counts the opens a caller chose. `memhtml read` and `memory_read` of a named path bump the access
plane; a path that `memhtml search` or `memhtml recall` merely returned does not, and neither does a sleep
phase. Bumping on a hit would make today's top five rank higher tomorrow for having been listed, while
the memory that should displace them never gets a first bump. `memhtml reinforce` is the explicit outcome
channel, and it moves the same exponentially weighted moving average. The arm also stays out of the way
of a `task` row and a `resources/people/` reference record: both are reached by predicate and by key, and
salience there would reward a stale task and decay a person's identity.

`memhtml recall` adds a disclosure fold on top. Arcs get their own character envelope, so a summary does
not compete with the memories it summarizes. Each fold quotes at most 2 memories per entity name, and
everything past the budget collapses to one index line plus a path to drill into.

## The discrimination gate

`memhtml eval discriminate` reports the number that says whether retrieval can tell two similar facts
apart.
Embeddings are weakest on the tokens that carry a fact's polarity: "drain the VIP before reverting" and
"do not drain the VIP before reverting" sit above 0.99 cosine similarity while asserting opposite things.
So the gate derives every control from the probe's own target by flipping a negation, a number, or a
qualifier, which makes each control a high-cosine wrong answer by construction. Every target has to
strictly outrank all of its own controls, mean reciprocal rank has to clear 0.85, and one inversion fails
the run.

Two places run it. `pnpm check` runs it, and CI runs `pnpm check`. `memhtml sleep merge` runs it a second
time, so a sleep run that degrades retrieval cannot land. Fake-embedder mode is deterministic and needs
no credentials. `live` mode is an operator diagnostic, and it reports `skipped: true` when it cannot
reach the model, so a skipped gate reads as skipped rather than as green.

## Sleep

`memhtml sleep run` executes sixteen curation phases on a `sleep/<date>` branch: dedup-merge, entity
resolution, edge typing, confidence decay, arc synthesis, retention triage, compress, integrity,
and the rest. Each committing phase makes its own isolated commit with a machine-readable trailer, so
`memhtml sleep resume` re-runs only what is missing. Two phases commit nothing by design. `preflight`
refreshes the index, and `relationship-mining` writes derived edges to the index alone, because thousands
of re-derivable edges would bury every real diff. `trace-consolidation` hands unread session transcripts
to an agent and lands each distilled memory as its own commit, one per memory, so a reviewer reads one
claim at a time. A failed phase leaves the phases before it committed.

A run also opens TASKS, for work the corpus records and nobody opened. `task-detection` reads the recent
memories in batches and asks which of them carry a commitment nobody closed, quoting the sentence it
found; three other phases do the same for the decisions they decline to make — an alias pair too close to
ignore and too far to merge, a near-duplicate pair the divergence veto refused, a contradiction seen only
once. Every detected task is authored `agent:sleep`, cites its evidence verbatim, is capped at ten a
night across all four detectors, and closes itself when its finding stops appearing. A detection is a
proposal for a human, never a fact the corpus asserts.

`memhtml sleep review` classifies every touched file. `memhtml sleep merge` re-runs the discrimination gate
and refuses to move `main` on a regression. Detecting a conflict is nightly and automatic; resolving one
stays with the writer or a human, because choosing a winner is a one-way door.

Figure 4 draws the branch and the gate. A screen reader sounds out its box characters, so read the
paragraph beneath the figure, which carries the same content in words.

<!-- figure:sleep-branch -->
```text
            +-------+
            | main  |
            |       |
            +-------+
                |
             branch
                |
                v
         +-------------+
         |sleep/<date> |
         |             |
         +-------------+
                |
                v
        +---------------+
        |sixteen phases |
        |               |
        +---------------+
                |
             review
                |
                v
           +---------+
           |the gate |
           |         |
           +---------+
              |   |
        +-----+   +-----+
        |               |
     passes          refuses
        |               |
        v               v
 +-----------+   +-------------+
 |main moves |   |main unmoved |
 |           |   |             |
 +-----------+   +-------------+
```
<!-- /figure:sleep-branch -->

**Figure 4: `main` moves only after a gate that can refuse says so.** A run branches `main` into
`sleep/<date>` before any phase executes and walks its sixteen phases there, fourteen of them committing,
each on its own, with `preflight` and `relationship-mining` committing nothing by design. Then it submits
the branch for review. That review re-runs the discrimination gate and has two outcomes, both drawn: it
passes and `main` moves, or it refuses and `main` stays exactly where it was. Those are the only two
outcomes, and neither needs a rollback, because nothing on `main` ever moved. The abort is
`git branch -D`.

## Code-mode

The closed vocabulary makes the corpus a queryable API with no new surface: `article mark` is always the
claim, `link[rel^="memhtml-"]` is always an authored edge, and `dl` pairs are always facets. Use the
descendant selector. The markup is `<article><p><mark>`, so `article > mark` matches nothing and a helper
written from that spelling reports zero claims while looking correct. An agent that writes parser code
against `$MEMHTML_ROOT` composes multi-hop traversals in one execution and answers corpus-shaped
questions no tool enumerates: live contradiction pairs, an orphan census, a walk up a supersedence chain.
The contract is read-only, and writes stay behind the three doors above.

`memhtml exec` ships this as a command. It runs your script in a QuickJS sandbox with the corpus mounted
read-only at `/mnt/memhtml` and a helper preloaded at `/workspace/lib/corpus.mjs`, and it answers one
`exec.report` envelope. Measured on the 305-file fixture corpus: 305/305 claims parsed and 410/410 edges
resolved in one execution. The script reads a pinned commit, so an answer is reproducible and an
uncommitted edit stays invisible to it. The sandbox reaches the structural and lexical planes and holds
no index handle, so a script that wants ranked retrieval shells out to `memhtml search` and consumes its
envelope. `docs/code-mode.md` is the cookbook, with a measured helper and five recipes.

## Measured

| benchmark | memhtml | published reference |
|---|---|---|
| MemoryAgentBench FactConsolidation single-hop (26KB to 1.1MB stores) | 92% to 97% | ~60% at 26KB only |
| MemoryAgentBench FactConsolidation multi-hop | 37% to 49% | ≤7% all methods |
| BEAM Contradiction Resolution (100K split, 40 probes) | 43.8% mean | 0% to 5% all systems |
| LongMemEval-S (full 500, judged 2026-08-07) | 67.0% | ~55% to 65% typical agent baselines |

Read the cross-judge numbers as reference points rather than as a ranking: the judges here are verbatim
prompt ports running haiku-4.5, where the papers used gpt-4o and gpt-4.1-mini. `ROADMAP.md` carries these
numbers and the horizons they rank.

## Layout

```
$MEMHTML_ROOT/                        # its own git repo, one global memory store
  projects/<workspace-slug>/      # a workspace IS a directory. There is no workspaces table.
  areas/<area-slug>/              # ongoing responsibilities
  areas/arcs/                     # behavioral arcs (system-written by sleep only)
  areas/inbox/                    # where an unplaceable memory lands
  resources/<topic>/
  resources/people/<person>.html  # the person plane
  archive/<YYYY>/<original-path>  # soft-evicted, path-preserving, injective
  .memhtml/
    index.db                      # gitignored, rebuildable from the tree
    state.db                      # gitignored, NOT rebuildable from git
    state/access.jsonl            # committed sidecar: the state plane's only durable copy
    sleep/<run-id>.html           # committed sleep reports
  sitemap.xml + per-dir index.html  # generated by `memhtml publish`, committed
```

## Packages

The layering is strict and TypeScript project references enforce it. `@memhtml/contracts` and
`@memhtml/domain` import `effect` and nothing else, and a test reads `domain`'s own `dist` to confirm it
names no database driver, no SDK, and no `node:fs`.

None of them is published. Every workspace package is `private`, and `mise run package:assemble`
bundles the libraries and the binary-bearing apps into the single `memhtml` package that carries the
two binaries — the docs site and the integration-test harness stay outside the bundle
(`tsdown.config.ts` names the exact set). The table below is a map of the source, not a list of
things to install. `RELEASING.md` covers how the artifact is built and what must stay outside the
bundle.

| Package | What it owns |
|---|---|
| `@memhtml/contracts` | Schemas, the closed vocabularies, errors, path algebra. Zero I/O. |
| `@memhtml/domain` | Pure math: retention, decay, RRF, MMR, PageRank, the anti-merge guards. |
| `@memhtml/html` | The memory file format: parse, serialize, hash, surgical head editors. |
| `@memhtml/store` | The git-backed file store. One commit per operation, typed conflicts. |
| `@memhtml/index` | SQLite schema, the git-driven indexer, four-arm RRF retrieval, the state plane. |
| `@memhtml/traces` | Streaming JSONL parser over `~/.claude`, with a size+mtime+offset watermark. |
| `@memhtml/sleep` | The sixteen curation phases, each an isolated commit. |
| `@memhtml/llm` | Bedrock: Cohere embeddings and forced-tool structured output. |
| `@memhtml/eval` | The fixture corpus generator and the refusable discrimination gate. |
| `@memhtml/cli` | The `memhtml` binary, the envelope contract, and the one composition root. |
| `@memhtml/mcp` | The `memhtml-mcp` stdio server: 14 tools, 2 resources. |
| `@memhtml/consolidator` | The sandboxed eve agent that distills candidate memories from raw transcripts. |
| `@memhtml/docs` | The documentation site. |

## Development

[`mise`](https://mise.jdx.dev) is the command surface. It installs the toolchain from `mise.toml`, which
declares node, pnpm, lefthook, and the scanners, each pinned by checksum and provenance in the committed
`mise.lock`, so a clone resolves the same binaries CI does:

```bash
mise install        # node 24, pnpm 11.21.0, lefthook, scanners, from mise.lock
mise run install    # dependencies from the lockfile + the git hooks
mise run check      # the definition of done: lint, typecheck, tests, integration, eval, a11y, budget
```

CI runs that same `mise run check`, so the gate cannot drift from the one you run locally. Every task
delegates to the pnpm script underneath it, and turbo owns the task graph and the cache. No mise task
declares `sources` or `outputs`, because mise decides freshness by mtime and turbo by content hash, so a
mise-level skip would preempt turbo's per-package hashing.

`check` includes the discrimination gate in fake mode, so a change that degrades retrieval fails the
build. Tests run against a real temp-dir git repo and a real SQLite database with the shipped migrations.
Fakes are limited to the two edges that reach the network, the embedder and the model, because a stateless
fake verifies the shape of a call and misses the state semantics behind it, which is where the defects in
this system have actually lived.

| Command | Delegates to | What it runs |
|---|---|---|
| `mise run build` | `pnpm build` | `tsc -b` across the project graph |
| `mise run lint` | `pnpm lint` | biome |
| `mise run typecheck` | `pnpm typecheck` | strict `tsc --noEmit`, tests included |
| `mise run test` | `pnpm test` | every package's unit and property suites |
| `mise run test:integration` | `pnpm test:integration` | the cross-package contracts over a real repo and a real database |
| `mise run test:eval` | `pnpm test:eval` | the discrimination gate (fake mode) |
| `mise run test:a11y` | `pnpm test:a11y` | WCAG 2.2 AA over the built docs site, in a real browser |
| `mise run test:budget` | `pnpm test:budget` | Lighthouse category floors and the byte budget for that site |
| `mise run gen:fixture` | `pnpm gen:fixture` | write a browsable fixture corpus (pure function of a seed) |
| `mise run agents-doc` | none | regenerate `AGENTS.md` from the built CLI's own table |
| `mise run security` | none | osv-scanner + semgrep + betterleaks, SARIF into `.sarif/` |
| `mise run tools:bump` | none | re-resolve every `latest` tool in `mise.lock` |

To narrow a run to one package, use `mise run test-pkg <package> [vitest args]`. The package name takes
either spelling, and everything after it goes to vitest:

```bash
mise run test-pkg domain rrf -t "strictly"    # one test
mise run test-pkg index retrieval             # one file
```

That path goes straight to the package's vitest, so it skips turbo and builds nothing first. Every
`@memhtml/*` package's exports resolve only to `./dist`, so run `mise run build` after editing another
package's `src/`.

`mise.toml`'s `[tools] pnpm` and `package.json`'s `packageManager` both declare the pnpm that runs, and
neither can be derived from the other. `mise run tools:verify` fails when they disagree, and
`mise run install` depends on it, so the check runs on every install. Declaration order matters too:
`pnpm` sits above `node` because node's own bin holds a `pnpm` symlink into corepack wherever
`corepack enable` has run, and with node first every pnpm call would resolve to corepack rather than to
the pinned binary.

## Docs

| File | What it holds |
|---|---|
| `AGENTS.md` | The full command surface, generated from the binary's own table |
| `RUNBOOK.md` | Operating the store day to day |
| `ROADMAP.md` | The system-level view: measured standing, ranked horizons |
| `docs/design.md` | Every architectural decision with its evidence |
| `docs/format.md` | The file format and the closed vocabulary |
| `docs/tasks.md` | The task memory type |
| `docs/code-mode.md` | Navigating the corpus with code |
| `docs/backlog.md` | The fine-grained ledger |
