# memhtml-public · CLI

The `memhtml` CLI has 36 subcommands. Each one writes exactly one JSON envelope to stdout, so a calling agent can parse the result instead of scraping prose. `apps/cli/package.json:7-9`

Start with `memhtml manifest`, which returns the whole contract: every command, argument, flag, response type, error code, and environment variable the binary accepts. `apps/cli/src/commands.ts:1024-1048`

The code in this repository is the software. The memory tree it manages lives elsewhere, in an external git repository holding the corpus, called the memhtml root. Every command acts on that root, found through `$MEMHTML_ROOT` or overridden per call with `--repo`. `apps/cli/src/config.ts:26-31`

Exit 0 means success. Exit 2 means a usage error, which the caller fixes by changing the call. Exit 1 means a runtime failure, which the caller fixes by changing the root or the environment. `apps/cli/src/envelope.ts:88-90`

## Global flags

Three flags apply to every command. They are declared once, so the manifest and the parser read the same declaration. `apps/cli/src/commands.ts:36-55`

Flags:

- `--json`: Emit the typed JSON envelope on stdout (default; logs go to stderr). Boolean, default true. `apps/cli/src/commands.ts:38`
- `--dense`: Minify JSON and drop null fields, for pasting into a context window. Boolean, default false. `apps/cli/src/commands.ts:44`
- `--repo`: Path to the memory repo. Defaults to `$MEMHTML_ROOT`. String. `apps/cli/src/commands.ts:50`

The parser accepts `--flag value`, `--flag=value`, `--no-flag`, and bare `--flag`. It stores every value as an array, so a repeatable flag keeps all of its occurrences instead of collapsing to the last one. `apps/cli/src/run.ts:61-111`

`--no-embed` turns off a boolean flag whose default is true. `apps/cli/src/run.ts:82-88`

## manifest

```
memhtml manifest
```

Emit this CLI's full machine-readable contract.
`apps/cli/src/run.ts:842-844`

This command takes no arguments and no flags. It answers without building the app layer, so it works on a machine with no root, no database, and no credentials, which makes it usable as a liveness check as well as a discovery call. `apps/cli/src/run.ts:829-841`

A bare `memhtml` and `memhtml help` return the same manifest envelope. `apps/cli/src/run.ts:822-824`

## init

```
memhtml init
```

Scaffold a memory repo at `--repo`/`$MEMHTML_ROOT`: git init, PARA dirs, merge driver.
`apps/cli/src/run.ts:194-199`

This command takes no arguments and no command-specific flags. `apps/cli/src/commands.ts:120-125`

## write

```
memhtml write --title <title> --type <type> [--claim <sentence> | --article-html <markup>]
```

Write one memory. Content-hash duplicates return the existing path, uncommitted.
`apps/cli/src/run.ts:201-221`

Flags:

- `--title`: The memory's title. Becomes the `<title>` and the filename slug. Required, string. `apps/cli/src/commands.ts:132`
- `--claim`: The one load-bearing sentence. Becomes the `<mark>` span and `files.gist`. Exactly one of `--claim` or `--article-html`. String. `apps/cli/src/commands.ts:138`
- `--body`: A prose paragraph after the claim. Repeatable, one `<p>` each. String. `apps/cli/src/commands.ts:144`
- `--article-html`: Raw `<article>` markup used verbatim in place of `--claim`/`--body`. Must contain exactly one `<mark>` in the first `<p>` or `<li>`; the first `<time datetime>` becomes the memory's event time. String. `apps/cli/src/commands.ts:150`
- `--type`: The memory type. Required, one of the nine writable types; `arc` is absent because sleep synthesizes arcs. `apps/cli/src/commands.ts:156`
- `--path`: An explicit path override. Ignored when it is not a valid memory path. String. `apps/cli/src/commands.ts:163`
- `--workspace`: Routes the memory to `projects/<slug>/`. String. `apps/cli/src/commands.ts:167`
- `--tag`: A tag. Repeatable; the first one routes an unplaced resource memory. String. `apps/cli/src/commands.ts:169`
- `--entity`: A `type:name` entity reference, for example `service:checkout-api`. Repeatable, string. `apps/cli/src/commands.ts:174`
- `--importance`: 1-10, a display ordinal. The retention scorer divides by 10. Int. `apps/cli/src/commands.ts:180`
- `--confidence`: 0-1. 1.0 is an unqualified assertion. String. `apps/cli/src/commands.ts:184`
- `--session-id`: The Claude Code session. Stamped into the head and indexed as a link. String. `apps/cli/src/commands.ts:186`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:190`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:191`

The `--type` vocabulary comes from `WRITABLE_MEMORY_TYPES`, the nine values in `MEMORY_TYPES` minus `arc`. `packages/contracts/src/types.ts:38-40`

Supplying both `--claim` and `--article-html`, or neither, is a usage error. It is checked before any service is built, so it exits 2 rather than 1. `apps/cli/src/run.ts:700-725`

## apply

```
memhtml apply [--file ops.jsonl]
memhtml apply -
```

Write many memories from a JSONL op stream: one commit, one index update, per-op results.
`apps/cli/src/run.ts:229-243`

Flags:

- `--file`: The JSONL file to read. One complete JSON object per line. Omit it, or pass `-`, to read the stream from stdin. String. `apps/cli/src/commands.ts:202`
- `--continue-on-error`: Best-effort: a refused op is reported and skipped while every surviving op lands in the one commit. Atomic by default. Boolean, default false. `apps/cli/src/commands.ts:208`
- `--detect-conflicts`: Report each op's frame-matches as a per-op `conflict`. Propose-only: every op still writes exactly as it would have. Boolean, default false. `apps/cli/src/commands.ts:215`
- `--consolidate`: Resolve frame-key matches instead of only reporting them. One value: `last-wins`. Off by default. String. `apps/cli/src/commands.ts:222`
- `--session-id`: The Claude Code session for every op that names none. A line's own `session_id` wins over this. String. `apps/cli/src/commands.ts:229`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:234`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:235`

The whole stream is read and shape-validated before any service is built. A malformed line therefore exits 2 with nothing written and no database opened. `apps/cli/src/run.ts:1006-1015`

## read

```
memhtml read <path>
```

Read one memory: its metas, links, article, and format warnings.
`apps/cli/src/run.ts:245-264`

Arguments:

- `<path>`: Repo-root-relative path to the memory. Required. `apps/cli/src/commands.ts:242`

Flags:

- `--session-id`: Records a `read` session link, so provenance is queryable both ways. String. `apps/cli/src/commands.ts:245`

## search

```
memhtml search <query> [--limit 10]
```

Ranked search: four RRF arms plus MMR. Degrades to the lexical floor.
`apps/cli/src/run.ts:266-274`

Arguments:

- `<query>`: Prose. Never a query language. Required. `apps/cli/src/commands.ts:255`

Flags:

- `--type`: Restrict to one memory type. Repeatable; each occurrence broadens the set (ANY-of). String. `apps/cli/src/commands.ts:60`
- `--workspace`: Restrict to one workspace. Strict: a scoped query never returns a memory with no workspace. String. `apps/cli/src/commands.ts:67`
- `--tag`: Restrict to memories carrying any of these tags. Repeatable; each broadens. String. `apps/cli/src/commands.ts:73`
- `--entity`: Restrict to memories carrying one `type:name` entity reference, the same form a hit's `entities` field publishes. String. `apps/cli/src/commands.ts:79`
- `--include-archived`: Include archived memories. Eviction is a `git mv`, so they still exist. Boolean, default false. `apps/cli/src/commands.ts:88`
- `--as-of`: Point-in-time view: returns what was believed valid at this ISO instant, including since-superseded memories marked `superseded_by`. String. `apps/cli/src/commands.ts:94`
- `--limit`: Hits to return. Int, default 10. `apps/cli/src/commands.ts:258`

The first six flags are `SCOPE_FLAGS`, declared once and spread into this command, so `search` and `recall` scope the same way. `apps/cli/src/commands.ts:58-99`

## recall

```
memhtml recall <query> [--budget 16000]
```

A disclosure pack under a character budget: arcs and memories folded separately.
`apps/cli/src/run.ts:276-284`

Arguments:

- `<query>`: Prose. Required. `apps/cli/src/commands.ts:265`

Flags:

- `--type`: Restrict to one memory type. Repeatable; each occurrence broadens the set. String. `apps/cli/src/commands.ts:60`
- `--workspace`: Restrict to one workspace. Strict. String. `apps/cli/src/commands.ts:67`
- `--tag`: Restrict to memories carrying any of these tags. Repeatable. String. `apps/cli/src/commands.ts:73`
- `--entity`: Restrict to memories carrying one `type:name` entity reference. String. `apps/cli/src/commands.ts:79`
- `--include-archived`: Include archived memories. Boolean, default false. `apps/cli/src/commands.ts:88`
- `--as-of`: Point-in-time view at this ISO instant. String. `apps/cli/src/commands.ts:94`
- `--budget`: Characters of quoted body. Arcs get their own envelope on top. Int, default 16000. `apps/cli/src/commands.ts:269`

## correct

```
memhtml correct <target> --title <title> [--claim <sentence> | --article-html <markup>]
```

Supersede a memory: write the new file and archive the target in one commit.
`apps/cli/src/run.ts:286-299`

Arguments:

- `<target>`: The memory being corrected. Required. `apps/cli/src/commands.ts:280`

Flags:

- `--title`: The new memory's title. Required, string. `apps/cli/src/commands.ts:282`
- `--claim`: The corrected claim. Exactly one of `--claim` or `--article-html`. String. `apps/cli/src/commands.ts:284`
- `--body`: A prose paragraph. Repeatable, string. `apps/cli/src/commands.ts:289`
- `--article-html`: Raw `<article>` markup for the superseding memory, used verbatim in place of `--claim`/`--body`. String. `apps/cli/src/commands.ts:295`
- `--type`: The new memory's type. Defaults to the target's. One of the nine writable types. `apps/cli/src/commands.ts:301`
- `--reason`: Why the correction was made. String. `apps/cli/src/commands.ts:306`
- `--session-id`: Records a `corrected` session link. String. `apps/cli/src/commands.ts:307`

The claim-or-markup rule from `write` applies here too. Both commands are named in one set, so the rule is defined in one place. `apps/cli/src/run.ts:629`

## link

```
memhtml link <src> <rel> <dst>
```

Add an authored edge to the source file and commit it. Idempotent.
`apps/cli/src/run.ts:301-309`

Arguments:

- `<src>`: The asserting memory or task. Required. `apps/cli/src/commands.ts:315`
- `<rel>`: One of the eleven authorable rels. A task rel needs two tasks; a memory rel refuses a task endpoint. Required. `apps/cli/src/commands.ts:317-321`
- `<dst>`: The memory or task being pointed at. Required. `apps/cli/src/commands.ts:323`

This command takes no flags. `apps/cli/src/commands.ts:325`

The rel vocabulary is `AUTHORABLE_RELS`, the nine `MEMORY_RELS` plus the two `TASK_RELS`. Person rels and the provenance rel are left out of it, because the system writes those itself. `apps/cli/src/operations.ts:82-89`

## neighbors

```
memhtml neighbors <path> [--depth 1] [--rel <rel>]
```

The memory graph around one path, to a fixed depth of at most two hops.
`apps/cli/src/run.ts:311-319`

Arguments:

- `<path>`: The center of the neighborhood. Required. `apps/cli/src/commands.ts:331`

Flags:

- `--depth`: 1 or 2. Never more. Int, default 1. `apps/cli/src/commands.ts:333`
- `--rel`: Restrict to these rels. Repeatable, drawn from the nine `MEMORY_RELS`. String. `apps/cli/src/commands.ts:335`

The nine memory rels are `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related`. `packages/contracts/src/edges.ts:19-29`

## archive

```
memhtml archive <path> --reason <reason>
```

Soft-evict: `git mv` into `archive/<YYYY>/` with the archive stamps. Never a delete.
`apps/cli/src/run.ts:321-328`

Arguments:

- `<path>`: The memory to archive. Required. `apps/cli/src/commands.ts:347`

Flags:

- `--reason`: Why it was evicted. Required, string. `apps/cli/src/commands.ts:348`

## reinforce

```
memhtml reinforce <path> [<path>...] [--signal neutral]
```

Bump access bookkeeping, gated by a 900-second per-path cooldown.
`apps/cli/src/run.ts:330-339`

Arguments:

- `<path>`: A memory path. Repeat the argument for more. Required. `apps/cli/src/commands.ts:355`

Flags:

- `--signal`: One of `positive`, `negative`, `neutral`. `neutral` bumps access without claiming the memory was right. String, default `neutral`. `apps/cli/src/commands.ts:359`

Every positional token is treated as a path. That matches the `paths` array the equivalent MCP tool takes. `apps/cli/src/run.ts:332-333`

The signal vocabulary is `REINFORCE_SIGNALS`. `packages/domain/src/reinforce.ts:31`

## list

```
memhtml list [--type <type>] [--workspace <ws>] [--tag <tag>] [--entity <ref>] [--para <bucket>] [--limit 50] [--cursor <path>]
```

Page through the corpus by type, workspace, tag, entity, or PARA bucket.
`apps/cli/src/run.ts:341-354`

Flags:

- `--type`: One memory type, from the nine writable types. String. `apps/cli/src/commands.ts:374`
- `--workspace`: One workspace. String. `apps/cli/src/commands.ts:379`
- `--tag`: One tag. String. `apps/cli/src/commands.ts:380`
- `--entity`: One `type:name` entity reference. String. `apps/cli/src/commands.ts:381`
- `--para`: One PARA bucket: `projects`, `areas`, `resources`, or `archive`. String. `apps/cli/src/commands.ts:383`
- `--limit`: Rows per page. Int, default 50. `apps/cli/src/commands.ts:388`
- `--cursor`: The `next_cursor` from the previous page: the last path returned. String. `apps/cli/src/commands.ts:390`
- `--include-archived`: Include archived memories. Boolean, default false. `apps/cli/src/commands.ts:395`

## task add

```
memhtml task add --title <title> [--status todo] [--due <iso>]
```

Open a task: a `task` memory in `projects/<ws>/tasks/` or `areas/inbox/tasks/`.
`apps/cli/src/run.ts:356-388`

Flags:

- `--title`: What the task is. Becomes the `<title>` and the filename slug. Required, string. `apps/cli/src/commands.ts:418`
- `--claim`: The task statement, as the `<mark>` span. Defaults to `--title`. String. `apps/cli/src/commands.ts:424`
- `--body`: A prose paragraph of working notes. Repeatable, one `<p>` each. String. `apps/cli/src/commands.ts:429`
- `--status`: The opening status: `todo`, `doing`, `blocked`, or `done`. String, default `todo`. `apps/cli/src/commands.ts:435`
- `--due`: An ISO date or datetime deadline. Compared as a string, so the form matters. String. `apps/cli/src/commands.ts:442`
- `--workspace`: Routes the task to `projects/<slug>/tasks/`. String. `apps/cli/src/commands.ts:447`
- `--tag`: A tag. Repeatable; tags scope search but never route a task. String. `apps/cli/src/commands.ts:452`
- `--entity`: A `type:name` entity reference. Repeatable, string. `apps/cli/src/commands.ts:458`
- `--session-id`: The Claude Code session that opened the task. String. `apps/cli/src/commands.ts:464`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:468`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:469`

This command is a shorthand over the same write path every other write uses. It calls `writeMemory` with `memoryType: "task"`. Because a task is a file in a directory, an agent can also work tasks with ordinary file tools. `apps/cli/src/commands.ts:403-411`

The status vocabulary is `TASK_STATUSES`. `packages/contracts/src/types.ts:82`

## task status

```
memhtml task status <path> <status> [--reason <reason>]
```

Move a task's status. `done` stamps and archives it, in one commit.
`apps/cli/src/run.ts:390-398`

Arguments:

- `<path>`: The task file. Required. `apps/cli/src/commands.ts:477`
- `<status>`: One of `todo`, `doing`, `blocked`, `done`. Required. `apps/cli/src/commands.ts:478`

Flags:

- `--reason`: Why it closed. Recorded on the archive commit when the status is `done`. String. `apps/cli/src/commands.ts:482`

## task list

```
memhtml task list [--status <status>] [--workspace <ws>] [--due-before <iso>] [--detected] [--limit 50] [--cursor <path>]
```

The task working set: a direct indexed scan with blockers, never ranked retrieval.
`apps/cli/src/run.ts:400-411`

Flags:

- `--status`: One task status. String. `apps/cli/src/commands.ts:495`
- `--workspace`: One workspace. String. `apps/cli/src/commands.ts:500`
- `--due-before`: An ISO date. Returns tasks due strictly before it, by calendar day. String. `apps/cli/src/commands.ts:502`
- `--detected`: Only machine-detected tasks: the ones carrying a `memhtml-finding-key` minted by sleep. Boolean, default false. `apps/cli/src/commands.ts:519`
- `--limit`: Rows per page. Int, default 50. `apps/cli/src/commands.ts:506`
- `--cursor`: The `next_cursor` from the previous page: the last path returned. String. `apps/cli/src/commands.ts:508`
- `--include-archived`: Include finished tasks. `done` archives, so they are otherwise absent. Boolean, default false. `apps/cli/src/commands.ts:513`

## index rebuild

```
memhtml index rebuild [--no-embed]
```

Rebuild `index.db` from the git tree at HEAD. Destroys nothing outside `.memhtml/`.
`apps/cli/src/run.ts:413-418`

Flags:

- `--embed`: Fill missing vectors from Bedrock. `--no-embed` makes the rebuild instant. Boolean, default true. `apps/cli/src/commands.ts:527`

## index update

```
memhtml index update [--no-embed]
```

Index only what moved since the recorded watermark, plus the dirty working tree.
`apps/cli/src/run.ts:420-425`

Flags:

- `--embed`: Fill missing vectors. Boolean, default true. `apps/cli/src/commands.ts:540`

This command indexes uncommitted working-tree changes as well as committed ones. A file an agent edited by hand in the root is therefore searchable before it is committed. `apps/cli/src/commands.ts:863-865`

## index status

```
memhtml index status
```

The index watermark, the vector space it was built in, and its row counts.
`apps/cli/src/run.ts:427-431`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:545-550`

## trace index

```
memhtml trace index
```

Scan `$MEMHTML_TRACE_ROOT` for Claude Code transcripts, reading only what changed.
`apps/cli/src/run.ts:433-437`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:552-557`

`$MEMHTML_TRACE_ROOT` defaults to `~/.claude`. The CLI only reads from it and never writes to it. `apps/cli/src/config.ts:32-37`

## trace search

```
memhtml trace search <query> [--cwd <dir>] [--since <iso>] [--limit 20]
```

FTS over session first-prompts and AI titles. Never enters memory retrieval.
`apps/cli/src/run.ts:439-448`

Arguments:

- `<query>`: Prose. Required. `apps/cli/src/commands.ts:561`

Flags:

- `--cwd`: Restrict to sessions from this directory. String. `apps/cli/src/commands.ts:563`
- `--since`: ISO-8601 lower bound on `started_at`. String. `apps/cli/src/commands.ts:564`
- `--limit`: Sessions to return. Int, default 20. `apps/cli/src/commands.ts:565`

## trace links

```
memhtml trace links [--session-id <id>] [--path <path>]
```

The memory-session links, from either side.
`apps/cli/src/run.ts:450-457`

Flags:

- `--session-id`: Every memory this session touched. String. `apps/cli/src/commands.ts:574`
- `--path`: Every session that touched this memory. String. `apps/cli/src/commands.ts:575`

## sleep run

```
memhtml sleep run [--date YYYY-MM-DD] [--phases <list>] [--dry-run]
```

The nightly curation cycle: 15 phases, each an isolated commit on a review branch.
`apps/cli/src/run.ts:459-469`

Flags:

- `--date`: The run date, `YYYY-MM-DD`. Defaults to today. Names the branch. String. `apps/cli/src/commands.ts:585`
- `--phases`: Comma-separated subset. All 15 by default. String. `apps/cli/src/commands.ts:590`
- `--dry-run`: Report per-phase counts and commit nothing. Boolean, default false. `apps/cli/src/commands.ts:595`

The 15 phase names come from `SLEEP_PHASES`: `preflight`, `dedup-merge`, `entity-resolution`, `person-links`, `relationship-mining`, `edge-typing`, `confidence-decay`, `arc-synthesis`, `retention-triage`, `compress`, `reprieve`, `trace-consolidation`, `integrity`, `state-export`, `report`. `packages/sleep/src/contract.ts:17-33`

A run holds a checked-out `sleep/<date>` branch. Any write that lands during the run commits onto that branch. `apps/cli/src/commands.ts:872-876`

## sleep resume

```
memhtml sleep resume <run-id>
```

Re-run only the phases with no `Memhtml-Phase` trailer on the branch.
`apps/cli/src/run.ts:471-476`

Arguments:

- `<run-id>`: The run id, for example `sleep/2026-08-02`. Required. `apps/cli/src/commands.ts:606`

This command takes no flags. `apps/cli/src/commands.ts:607`

## sleep review

```
memhtml sleep review <run-id> [--diff]
```

Per-phase counts, the commit list, `diff --stat`, and a per-file classification.
`apps/cli/src/run.ts:478-492`

Arguments:

- `<run-id>`: The run id. Required. `apps/cli/src/commands.ts:613`

Flags:

- `--diff`: Include the raw diff. Boolean, default false. `apps/cli/src/commands.ts:615`

The raw diff is fetched only when asked for. Its size is unbounded, so a default response that carried it could exceed a context window. `apps/cli/src/run.ts:484-486`

## sleep merge

```
memhtml sleep merge <run-id> [--skip-gate]
```

Fast-forward main to the run's branch, after the discrimination gate passes.
`apps/cli/src/run.ts:494-524`

Arguments:

- `<run-id>`: The run id. Required. `apps/cli/src/commands.ts:622`

Flags:

- `--skip-gate`: Merge without re-running discrimination. A deliberate, logged override, never a default. Boolean, default false. `apps/cli/src/commands.ts:625`

The gate is composed here rather than defaulted inside the sleep package. A failed gate returns `refusal: "gate-failed"` and main does not move. `apps/cli/src/run.ts:503-522`

## sleep status

```
memhtml sleep status
```

The latest sleep run and its per-phase outcomes.
`apps/cli/src/run.ts:550-565`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:635-640`

## status

```
memhtml status
```

Corpus health: HEAD, dirty state, counts by type, edges, index freshness.
`apps/cli/src/run.ts:567-571`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:642-647`

## publish

```
memhtml publish
```

Regenerate the per-directory `index.html` listings and `sitemap.xml`, and commit them.
`apps/cli/src/run.ts:526-530`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:649-654`

## doctor

```
memhtml doctor [--fix]
```

Corpus health: dangling hrefs, orphan state rows, inbox depth, vocabulary, staleness.
`apps/cli/src/run.ts:532-536`

Flags:

- `--fix`: Repair dangling hrefs and prune orphan access rows. The other findings need a decision. Boolean, default false. `apps/cli/src/commands.ts:662`

## eval discriminate

```
memhtml eval discriminate [--mode fake] [--seed <n>] [--size 200] [--probes 36] [--mrr-floor 0.85]
```

The refusable retrieval gate: every probe must outrank its own wrong-fact twins.
`apps/cli/src/run.ts:901-927`

Flags:

- `--mode`: `fake` is the deterministic embedder CI measures; `live` needs `AWS_BEARER_TOKEN_BEDROCK` and refuses loudly without it. String, default `fake`. `apps/cli/src/commands.ts:677`
- `--seed`: The fixture corpus seed. A failing run is reproducible from this number. Int. `apps/cli/src/commands.ts:685`
- `--size`: Base memories to generate. Int, default 200. `apps/cli/src/commands.ts:689`
- `--probes`: Probes to run. Int, default 36. `apps/cli/src/commands.ts:691`
- `--mrr-floor`: Mean-reciprocal-rank floor. Lowering it is a deliberate, visible choice. String, default `0.85`. `apps/cli/src/commands.ts:697`

A failed gate exits 1 with `ERR_DISCRIMINATION_FAILED`. A pipeline can stop on the exit code instead of reading a verdict out of the payload. `apps/cli/src/run.ts:896-899`

This command generates its own fixture corpus in a temp directory with an in-memory database. It does not open the operator's `index.db`. `apps/cli/src/run.ts:890-895`

## exec

```
memhtml exec --file <script.mjs>
memhtml exec --script <source>
cat script.mjs | memhtml exec
```

Run a read-only traversal script over the corpus in a sandbox: multi-hop in one execution.
`apps/cli/src/run.ts:947-992`

Flags:

- `--file`: The script to run, as a path on the host. Omit it, or pass `-`, to read the script from stdin. Mutually exclusive with `--script`. String. `apps/cli/src/commands.ts:742`
- `--script`: The script source, inline. Mutually exclusive with `--file` and with reading stdin. String. `apps/cli/src/commands.ts:748`
- `--timeout-ms`: Wall-clock bound on the script. Exceeding it is `exitCode` 124 with `timedOut: true`, not an error envelope. Int, default 30000, capped at 600000. `apps/cli/src/commands.ts:754`
- `--sha`: The commit to mount, materialized as a detached worktree. Defaults to HEAD. Never the live working tree. String. `apps/cli/src/commands.ts:761`

The default and cap are constants: `DEFAULT_TIMEOUT_MS` is 30000 at `apps/cli/src/exec.ts:48` and `MAX_TIMEOUT_MS` is 600000 at `apps/cli/src/exec.ts:58`.

Passing the script through more than one of the three doors is a usage error. So is a `--timeout-ms` that is not positive or is above the cap. Both are checked before any service is built. `apps/cli/src/run.ts:646-686`

A non-zero `exitCode` in the payload means the script failed, and the process still exits 0. Exit 1 means the runtime could not run the script at all. `apps/cli/src/run.ts:938-942`

The sandbox's own capabilities have no flag. Python and network access are off, and no invocation can turn them on. `apps/cli/src/commands.ts:730-733`

## state export

```
memhtml state export
```

Write `.memhtml/state/access.jsonl`, the only durable copy of the state plane, and commit.
`apps/cli/src/run.ts:538-542`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:769-776`

## state import

```
memhtml state import
```

Replay the committed sidecar into `state.db`. Counters merge by max, never last-wins.
`apps/cli/src/run.ts:544-548`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:778-783`

## agents-doc

```
memhtml agents-doc [--check] [--out AGENTS.md]
```

Regenerate `AGENTS.md` from this command table. `--check` fails on drift.
`apps/cli/src/run.ts:846-854`

Flags:

- `--check`: Compare the committed doc to the regenerated one and fail on a difference. Boolean, default false. `apps/cli/src/commands.ts:790`
- `--out`: Where to write. Defaults to `./AGENTS.md`. String. `apps/cli/src/commands.ts:795`

The generated doc renders the same `COMMANDS` array that drives parsing, so every flag it describes is one the binary accepts. The rendering is deterministic to the byte, which is what lets the drift check compare the two copies exactly. `apps/cli/src/agents-doc.ts:11-21`

`--check` writes nothing. A check that repaired the drift it found would turn an uncommitted change into a green pipeline. `apps/cli/src/agents-doc.ts:209-242`

This command builds no app layer, so running it in CI does not scaffold a memhtml root as a side effect. `apps/cli/src/run.ts:836-840`

## serve mcp

```
memhtml serve mcp
```

Run the `memhtml-mcp` stdio server: 14 tools and 2 resources over this same repo.
`apps/cli/src/run.ts:869-888`

This command takes no arguments and no command-specific flags. `apps/cli/src/commands.ts:799-805`

It reads the global `--repo` flag and resolves it against the configured root. `apps/cli/src/run.ts:871-876`

The resolved root reaches the child as an explicit `MEMHTML_ROOT` on top of the inherited environment. Inheritance alone would not carry a root that came from `--repo`. `apps/cli/src/serve.ts:79`

The server runs as a child process rather than in-process. A stdio MCP server uses stdout as an NDJSON-RPC stream, and the CLI writes exactly one JSON envelope to that same descriptor, so the two cannot share it. `apps/cli/src/serve.ts:8-20`

The server binary is located as a sibling in the same build. `MEMHTML_MCP_BIN` overrides that path for a split deployment. `apps/cli/src/serve.ts:31-48`

The override variable's name is declared once as a constant, and the config table imports that constant. The documented name and the name the supervisor reads are therefore always the same string. `apps/cli/src/serve.ts:32`

## Error codes

A caller should branch on `code` rather than on the `error` prose. The code list is append-only. A shipped code keeps its meaning and is not removed. `apps/cli/src/envelope.ts:62-83`

The fifteen codes are `ERR_UNKNOWN_COMMAND`, `ERR_MISSING_ARGUMENT`, `ERR_INVALID_FLAG`, `ERR_PATH_NOT_FOUND`, `ERR_INVALID_MEMORY`, `ERR_DUPLICATE_CONTENT`, `ERR_WRITE_CONFLICT`, `ERR_DIRTY_TREE`, `ERR_INDEX_STALE`, `ERR_EMBED_MODEL_MISMATCH`, `ERR_MODEL_UNAVAILABLE`, `ERR_STORAGE`, `ERR_GIT`, `ERR_DISCRIMINATION_FAILED`, `ERR_UNKNOWN`. `apps/cli/src/envelope.ts:67-83`

An unknown command or an unknown flag returns nearest-match candidates in `suggestions`, computed by Levenshtein distance. A caller can retry a typo from that list without a second discovery call. `apps/cli/src/envelope.ts:124-138`

For a two-word command the distance is measured against the whole typed invocation, so `memhtml index rebiuld` scores 2 against `index rebuild` rather than losing to `init`. `apps/cli/src/run.ts:596-619`

## Environment variables

Every environment variable is declared in one array, which is what `memhtml manifest` reads to describe them. `apps/cli/src/config.ts:26-78`

- `MEMHTML_ROOT`: The memory repo's root: a git repository holding the corpus and `.memhtml/`. Defaults to `~/memhtml`. `apps/cli/src/config.ts:27-31`
- `MEMHTML_TRACE_ROOT`: Where `memhtml trace index` reads Claude Code transcripts from. Read-only. Defaults to `~/.claude`. `apps/cli/src/config.ts:32-37`
- `MEMHTML_AWS_REGION`: The Bedrock region for embeddings and the sleep cycle's model-calling phases. Defaults to `us-east-1`. `apps/cli/src/config.ts:38-42`
- `AWS_BEARER_TOKEN_BEDROCK`: Bedrock bearer token, read by the AWS SDK itself. When it is absent the SDK falls back to the default credential chain, and retrieval degrades to the lexical floor instead of failing. `apps/cli/src/config.ts:43-48`
- `MEMHTML_EMBED`: `off` disables the embedder entirely. Defaults to `on`. `apps/cli/src/config.ts:49-54`
- `MEMHTML_LLM`: `off` makes every model-calling sleep phase report `no model bound` and stay `ok`; `entity-resolution` still runs its deterministic passes. Defaults to `on`. `apps/cli/src/config.ts:55-60`
- `MEMHTML_EXTRACT_ENTITIES`: `on` adds one model call per write batch that extracts `memhtml-entity` metas the ops did not declare. It defaults to `off` because it changes what a write stores. `apps/cli/src/config.ts:61-66`
- `MEMHTML_MCP_BIN`: An explicit path to the `memhtml-mcp` entry point, read only by the `memhtml serve mcp` supervisor. When it is absent the supervisor uses the sibling-path default. `apps/cli/src/config.ts:67-77`

## See also

- [memhtml-public · Processes](../behavior/processes.md): 13 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 6 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 4 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 3 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 3 shared source citations
