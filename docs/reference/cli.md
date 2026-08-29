# memhtml-public · CLI

The `memhtml` CLI has 39 subcommands, one entry each in the `COMMANDS` array that also drives parsing and `AGENTS.md`. Each one writes exactly one JSON envelope to stdout, so a calling agent can parse the result instead of scraping prose. `apps/cli/src/commands.ts:118`

Start with `memhtml manifest`, which returns the whole contract: every command, argument, flag, response type, error code, and environment variable the binary accepts. `apps/cli/src/commands.ts:1094-1118`

The code in this repository is the software. The memory tree it manages lives elsewhere, in an external git repository holding the corpus, called the memhtml root. Every command acts on that root, found through `$MEMHTML_ROOT` or overridden per call with `--repo`. `apps/cli/src/config.ts:26-31`

Exit 0 means success. Exit 2 means a usage error, which the caller fixes by changing the call. Exit 1 means a runtime failure, which the caller fixes by changing the root or the environment. `apps/cli/src/envelope.ts:92-94`

## Global flags

Two flags apply to every command. They are declared once, so the manifest and the parser read the same declaration. `apps/cli/src/commands.ts:49-62`

Flags:

- `--dense`: Minify JSON and drop null fields, for pasting into a context window. Boolean, default false. `apps/cli/src/commands.ts:51`
- `--repo`: Path to the memory repo. Defaults to `$MEMHTML_ROOT`. String. `apps/cli/src/commands.ts:57`

There is no `--json` flag. The typed JSON envelope is the only output the binary has, on every command, so a flag selecting it would be parsed, advertised, and read by nothing; logs go to stderr. A suggestion string naming one would itself be a usage error, which is why `apps/cli/src/errors.ts` says so where it composes suggestions. `apps/cli/src/commands.ts:44-48`

The parser accepts `--flag value`, `--flag=value`, `--no-flag`, and bare `--flag`. It stores every value as an array, so a repeatable flag keeps all of its occurrences instead of collapsing to the last one. `apps/cli/src/run.ts:125-193`

`--no-embed` turns off a boolean flag whose default is true. `apps/cli/src/run.ts:147-152`

A boolean flag given a space-separated value is a usage error rather than a silent inversion: `--embed false` parses as `--embed` plus a stray positional `"false"`, which is the opposite of what the caller asked for, so the pair exits 2 naming both spellings that work. `apps/cli/src/run.ts:917-926`

## Flag and argument validation

Flags are validated against **this** command's spec plus the two globals, never the union of every command's flags. A flag that is valid somewhere else is still a usage error here, because `memhtml list --status todo` means `task list` and silently ignoring the flag would return an unfiltered answer that looks filtered. The suggestions name the commands that do take the flag. `apps/cli/src/run.ts:974-1003`

A positional past what the command declares is `ERR_UNEXPECTED_ARGUMENT` and exit 2. It is its own code because the offending token is not a flag, so `ERR_INVALID_FLAG` would misname it, and because it is surplus rather than absent, so `ERR_MISSING_ARGUMENT` would send the caller in the wrong direction: the fix is to drop a word rather than add one. A `repeatable` last argument turns the check off, which is what `memhtml reinforce a.html b.html` is, and that is declared in the command table rather than listed in the checker. `apps/cli/src/run.ts:950-965`

A bare `-` is exempt on `apply` and `exec`, the two commands that document it as the spelling naming stdin. `apps/cli/src/run.ts:936`

## manifest

```
memhtml manifest
```

Emit this CLI's full machine-readable contract. `apps/cli/src/run.ts:1119-1122`

This command takes no arguments and no flags. It answers without building the app layer, so it works on a machine with no root, no database, and no credentials, which makes it usable as a liveness check as well as a discovery call. `apps/cli/src/run.ts:1113-1122`

A bare `memhtml`, `memhtml help`, and `memhtml --help` return the same manifest envelope. `apps/cli/src/run.ts:1099`

## init

```
memhtml init
```

Scaffold a memory repo at `--repo`/`$MEMHTML_ROOT`: git init, PARA dirs, merge driver. `apps/cli/src/run.ts:307-313`

This command takes no arguments and no command-specific flags. `apps/cli/src/commands.ts:126-132`

## write

```
memhtml write --title <title> --type <type> [--claim <sentence> | --article-html <markup>]
```

Write one memory. Content-hash duplicates return the existing path, uncommitted. `apps/cli/src/run.ts:314-341`

Flags:

- `--title`: The memory's title. Becomes the `<title>` and the filename slug. Required, string. `apps/cli/src/commands.ts:139`
- `--claim`: The one load-bearing sentence. Becomes the `<mark>` span and `files.gist`. Exactly one of `--claim` or `--article-html`. String. `apps/cli/src/commands.ts:145`
- `--body`: A prose paragraph after the claim. Repeatable, one `<p>` each. String. `apps/cli/src/commands.ts:151`
- `--article-html`: Raw `<article>` markup used verbatim in place of `--claim`/`--body`. Must contain exactly one `<mark>` in the first `<p>` or `<li>`; the first `<time datetime>` becomes the memory's event time. String. `apps/cli/src/commands.ts:157`
- `--type`: The memory type. Required, one of the nine writable types; `arc` is absent because sleep synthesizes arcs. `apps/cli/src/commands.ts:163`
- `--path`: An explicit path override. One that is not a usable memory path is ignored and the placement rule decides instead; one a file already occupies is refused. String. `apps/cli/src/commands.ts:170`
- `--workspace`: Routes the memory to `projects/<slug>/`. String. `apps/cli/src/commands.ts:175`
- `--tag`: A tag. Repeatable; the first one routes an unplaced resource memory. String. `apps/cli/src/commands.ts:177`
- `--entity`: A `type:name` entity reference, for example `service:checkout-api`. Repeatable, string. `apps/cli/src/commands.ts:182`
- `--importance`: 1-10, a display ordinal. The retention scorer divides by 10. Int. `apps/cli/src/commands.ts:188`
- `--confidence`: 0-1. 1.0 is an unqualified assertion. String. `apps/cli/src/commands.ts:192`
- `--session-id`: The Claude Code session. Stamped into the head and indexed as a link. String. `apps/cli/src/commands.ts:194`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:198`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:199`

The `--type` vocabulary is the full `MEMORY_TYPES` storage set, `arc` included: the CLI is the operator surface, where curated import and deliberately authored rules are legitimate. The narrower `WRITABLE_MEMORY_TYPES` (minus `arc`) is the agent surface's, enforced by `memory_write`'s schema. `packages/contracts/src/types.ts:18-40`

Supplying both `--claim` and `--article-html`, or neither, is a usage error. It is checked before any service is built, so it exits 2 rather than 1. `apps/cli/src/run.ts:846-871`

An explicit `--path` naming a path a file already occupies is refused with `ERR_WRITE_CONFLICT`, and nothing is written or committed. Nothing in this corpus is overwritten, and an explicit path gets no `-2` collision suffix either, because the caller named one path and a quiet write to `…-2.html` would leave it holding a path with no file behind it. The recovery is `memhtml correct <path>`, which writes the superseding memory and archives what it replaces in one commit; `correct`'s own target is the one path exempt from the check, because the same commit moves it into the archive. `packages/store/src/store.ts:395-420`, `apps/cli/src/errors.ts:147-151`

## apply

```
memhtml apply [--file ops.jsonl]
memhtml apply --file -
memhtml apply -
```

Write many memories from a JSONL op stream: one commit, one index update, per-op results. `apps/cli/src/run.ts:342-357`

Flags:

- `--file`: The JSONL file to read. One complete JSON object per line. Omit it, pass `--file -`, or pass a positional `-` to read the stream from stdin. String. `apps/cli/src/commands.ts:210`
- `--continue-on-error`: Best-effort: a refused op is reported and skipped while every surviving op lands in the one commit. Atomic by default. Boolean, default false. `apps/cli/src/commands.ts:216`
- `--detect-conflicts`: Report each op's frame-matches as a per-op `conflict`. Propose-only: every op still writes exactly as it would have. Boolean, default false. `apps/cli/src/commands.ts:223`
- `--consolidate`: Resolve frame-key matches instead of only reporting them. One value: `last-wins`. Off by default. String. `apps/cli/src/commands.ts:230`
- `--session-id`: The Claude Code session for every op that names none. A line's own `session_id` wins over this. String. `apps/cli/src/commands.ts:237`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:242`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:243`

`-` is the stdin spelling in both places it can appear, as a positional and as `--file -`, and it cannot sit beside a real `--file`: two streams claiming to be the one that applies is exit 2 rather than one of them being silently ignored. `apps/cli/src/run.ts:821-832`

The whole stream is read and shape-validated before any service is built. A malformed line therefore exits 2 with nothing written and no database opened. `apps/cli/src/run.ts:1289-1300`

## read

```
memhtml read <path>
```

Read one memory: its metas, links, article, and format warnings. `apps/cli/src/run.ts:358-378`

Arguments:

- `<path>`: Repo-root-relative path to the memory. Required. `apps/cli/src/commands.ts:250`

Flags:

- `--session-id`: Records a `read` session link, so provenance is queryable both ways. String. `apps/cli/src/commands.ts:261`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:265`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:266`

The whole provenance triple, because the `read` arm stamps the whole triple: `memory_session_links` carries `prompt_id` and `turn_uuid` beside `session_id`, so a command declaring only the session would record a coarser link for a read than the write path records for the same turn, and one triple could not be threaded through a write-then-read flow. MCP's `memory_read` narrows to `session_id`; this surface is the one an agent threads a triple through. `apps/cli/src/commands.ts:251-258`

## search

```
memhtml search <query> [--limit 10]
```

Ranked search: four RRF arms plus MMR. Degrades to the lexical floor. `apps/cli/src/run.ts:379-388`

Arguments:

- `<query>`: Prose. Never a query language. Required. `apps/cli/src/commands.ts:273`

Flags:

- `--type`: Restrict to one memory type. Repeatable; each occurrence broadens the set (ANY-of). String. `apps/cli/src/commands.ts:67`
- `--workspace`: Restrict to one workspace. Strict: a scoped query never returns a memory with no workspace. String. `apps/cli/src/commands.ts:74`
- `--tag`: Restrict to memories carrying any of these tags. Repeatable; each broadens. String. `apps/cli/src/commands.ts:80`
- `--entity`: Restrict to memories carrying one `type:name` entity reference, the same form a hit's `entities` field publishes. String. `apps/cli/src/commands.ts:121`
- `--facet`: Restrict to memories carrying an authored `<dl>` facet, as `name=value`. Repeatable: two values of ONE name broaden (OR), two DIFFERENT names narrow (AND). String. `apps/cli/src/commands.ts:130`
- `--include-archived`: Include archived memories. Eviction is a `git mv`, so they still exist. Boolean, default false. `apps/cli/src/commands.ts:136`
- `--as-of`: Point-in-time view: returns what was believed valid at this ISO instant, including since-superseded memories marked `superseded_by`. String. `apps/cli/src/commands.ts:142`
- `--limit`: Hits to return. Int, default 10. `apps/cli/src/commands.ts:323`

The first seven flags are `SCOPE_FLAGS`, declared once and spread into this command, so `search` and `recall` scope the same way. `apps/cli/src/commands.ts:100-147`

A facet name and value are matched as TEXT with no case folding, so they are the one scope axis whose vocabulary is the consumer's own. Nothing published lets a caller DISCOVER the names a corpus holds — a hit's `entities` are copy-ready, its facets are not — so `--facet` presumes the vocabulary is already known, which is correct for the consumer writing its own facets and a real gap for exploring someone else's corpus.

`--as-of` is checked against the same grammar the format enforces on `<time datetime>` — `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ssZ` — and a value outside it is `ERR_INVALID_FLAG` at exit 2, before any service is built. That refusal is the only visible answer available: the flag binds into `coalesce(valid_from, event_at, created_at) <= ? AND (valid_until IS NULL OR valid_until > ?)`, where SQLite compares TEXT to TEXT and nothing parses the value, so `--as-of "2026-08-24 13:00"` would select a window the caller did not ask for and return a plausible-looking point-in-time view. One grammar for both sides also means the instants a caller may ask about are exactly the instants a file may state. `apps/cli/src/run.ts:873-904`

## recall

```
memhtml recall <query> [--budget 16000]
```

A disclosure pack under a character budget: arcs and memories folded separately. `apps/cli/src/run.ts:389-398`

Arguments:

- `<query>`: Prose. Required. `apps/cli/src/commands.ts:283`

Flags:

- `--type`: Restrict to one memory type. Repeatable; each occurrence broadens the set. String. `apps/cli/src/commands.ts:67`
- `--workspace`: Restrict to one workspace. Strict. String. `apps/cli/src/commands.ts:74`
- `--tag`: Restrict to memories carrying any of these tags. Repeatable. String. `apps/cli/src/commands.ts:80`
- `--entity`: Restrict to memories carrying one `type:name` entity reference. String. `apps/cli/src/commands.ts:121`
- `--facet`: Restrict to memories carrying an authored `<dl>` facet, as `name=value`. Repeatable, AND across names and OR within one. String. `apps/cli/src/commands.ts:130`
- `--include-archived`: Include archived memories. Boolean, default false. `apps/cli/src/commands.ts:136`
- `--as-of`: Point-in-time view at this ISO instant. String. `apps/cli/src/commands.ts:142`
- `--budget`: Characters of quoted body. Arcs get their own envelope on top. Int, default 16000. `apps/cli/src/commands.ts:333`

The MCP tool `memory_recall` publishes only `query`, `budget_chars` and `workspace`, so an agent on that surface cannot narrow a budgeted pack by type, tag, entity, or facet the way this command can.

## correct

```
memhtml correct <target> --title <title> [--claim <sentence> | --article-html <markup>]
```

Supersede a memory: write the new file and archive the target in one commit. `apps/cli/src/run.ts:399-413`

Arguments:

- `<target>`: The memory being corrected. Required. `apps/cli/src/commands.ts:298`

Flags:

- `--title`: The new memory's title. Required, string. `apps/cli/src/commands.ts:300`
- `--claim`: The corrected claim. Exactly one of `--claim` or `--article-html`. String. `apps/cli/src/commands.ts:302`
- `--body`: A prose paragraph. Repeatable, string. `apps/cli/src/commands.ts:307`
- `--article-html`: Raw `<article>` markup for the superseding memory, used verbatim in place of `--claim`/`--body`. String. `apps/cli/src/commands.ts:313`
- `--type`: The new memory's type. Defaults to the target's. One of the nine writable types. `apps/cli/src/commands.ts:319`
- `--reason`: Why the correction was made. String. `apps/cli/src/commands.ts:324`
- `--session-id`: Records a `corrected` session link. String. `apps/cli/src/commands.ts:325`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:326`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:327`

The claim-or-markup rule from `write` applies here too. Both commands are named in one set, so the rule is defined in one place. `apps/cli/src/run.ts:846-871`

This is also the recovery from an `ERR_WRITE_CONFLICT` on an explicit `--path`: the target is the one path the collision check exempts, because the same commit moves it into the archive before the correction's bytes are written. `packages/store/src/store.ts:391-394`

## link

```
memhtml link <src> <rel> <dst>
```

Add an authored edge to the source file and commit it. Idempotent. `apps/cli/src/run.ts:414-423`

Arguments:

- `<src>`: The asserting memory or task. Required. `apps/cli/src/commands.ts:335`
- `<rel>`: One of the eleven authorable rels. A task rel needs two tasks; a memory rel refuses a task endpoint. Required. `apps/cli/src/commands.ts:336-342`
- `<dst>`: The memory or task being pointed at. Required. `apps/cli/src/commands.ts:343`

This command takes no flags. `apps/cli/src/commands.ts:345`

The rel vocabulary is `AUTHORABLE_RELS`, the nine `MEMORY_RELS` plus the two `TASK_RELS`. Person rels and the provenance rel are left out of it, because the system writes those itself. `apps/cli/src/operations.ts:90-92`

## neighbors

```
memhtml neighbors <path> [--depth 1] [--limit 200] [--rel <rel>]
```

The memory graph around one path, to a fixed depth of at most two hops. `apps/cli/src/run.ts:424-434`

Arguments:

- `<path>`: The center of the neighborhood. Required. `apps/cli/src/commands.ts:351`

Flags:

- `--depth`: 1 or 2. Never more. Int, default 1. `apps/cli/src/commands.ts:353`
- `--limit`: Distinct nodes to return, clamped to 200. Int, default 200. `apps/cli/src/commands.ts:355`
- `--rel`: Restrict to these rels. Repeatable, drawn from the nine `MEMORY_RELS`. String. `apps/cli/src/commands.ts:362`

The response distinguishes two ways a neighborhood comes back short, because the recoveries differ. `nodesDropped` counts the paths the walk reached and `--limit` turned away, so a higher limit returns them. `scanSaturated` says the walk stopped at its own 10000-row cap, which no limit recovers. `apps/cli/src/commands.ts:355-360`

The nine memory rels are `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related`. `packages/contracts/src/edges.ts:19-29`

## resolve

```
memhtml resolve <path>
```

Follow a possibly-moved path forward to the memory that carries the fact now. A path is the id of a memory and it derives from the title, so correcting a memory with a reworded title moves the file and an external citation of the old path stops resolving. `apps/cli/src/operations.ts`

Arguments:

- `<path>`: The path a receipt, citation, or older answer recorded. Required.

No flags. The walk follows both mechanisms that move a memory — an authored `supersedes` link and the archive move recorded by `origin_path` — and neither is optional; the hop bound is a property of the answer rather than a preference.

`stopReason` decides whether the answer is citable and only `live` means yes. `archived` is a memory evicted rather than corrected, `unindexed` is no such path here (which can also mean the index does not yet describe the commit holding it — `indexedCommit` names the one it does), `cycle` is two memories each claiming to supersede the other, and `hop_limit` means `path` is where the walk stopped rather than the end of the chain. `steps` names each hop's mechanism, and every node is named by the path holding it now.

`hops: 0` with `stopReason: live` does not mean the bytes are unchanged: a correction whose title did not change lands at the same path. The MCP resource `memhtml://at/{commit}/{path}` is the grain that answers that, and `memory_resolve` publishes such a URI as `pinned_uri`.

## archive

```
memhtml archive <path> --reason <reason>
```

Soft-evict: `git mv` into `archive/<YYYY>/` with the archive stamps. Never a delete. `apps/cli/src/run.ts:435-443`

Arguments:

- `<path>`: The memory to archive. Required. `apps/cli/src/commands.ts:374`

Flags:

- `--reason`: Why it was evicted. Required, string. `apps/cli/src/commands.ts:375`

## reinforce

```
memhtml reinforce <path> [<path>...] [--signal neutral]
```

Bump access bookkeeping, gated by a 900-second per-path cooldown. `apps/cli/src/run.ts:444-454`

Arguments:

- `<path>`: A memory path. Repeat the argument for more. Required, repeatable. `apps/cli/src/commands.ts:383`

Flags:

- `--signal`: One of `positive`, `negative`, `neutral`. `neutral` bumps access without claiming the memory was right. String, default `neutral`. `apps/cli/src/commands.ts:391`

Every positional token is treated as a path, which matches the `paths` array the equivalent MCP tool takes. The variadic tail is declared as `repeatable: true` on the argument, which is also what exempts this command from the surplus-positional check. `apps/cli/src/commands.ts:383-388`

The signal vocabulary is `REINFORCE_SIGNALS`. `packages/domain/src/reinforce.ts:31`

## list

```
memhtml list [--type <type>] [--workspace <ws>] [--tag <tag>] [--entity <ref>] [--facet <name=value>] [--para <bucket>] [--limit 50] [--cursor <path>]
```

Page through the corpus by type, workspace, tag, entity, facet, or PARA bucket.

Flags:

- `--type`: One memory type, from the nine writable types. String. `apps/cli/src/commands.ts:469`
- `--workspace`: One workspace. String. `apps/cli/src/commands.ts:474`
- `--tag`: One tag. String. `apps/cli/src/commands.ts:475`
- `--entity`: One `type:name` entity reference. String. `apps/cli/src/commands.ts:476`
- `--facet`: One authored `<dl>` facet as `name=value`. Repeatable, composed exactly as `search` composes it: AND across distinct names, OR within one name. String. `apps/cli/src/commands.ts:480`
- `--para`: One PARA bucket: `projects`, `areas`, `resources`, or `archive`. String. `apps/cli/src/commands.ts:482`
- `--limit`: Rows per page. Int, default 50. `apps/cli/src/commands.ts:487`
- `--cursor`: The `next_cursor` from the previous page: the last path returned. String. `apps/cli/src/commands.ts:489`
- `--include-archived`: Include archived memories. Boolean, default false. `apps/cli/src/commands.ts:494`

`--status` belongs to `task list`, not here. Passing it to `list` is `ERR_INVALID_FLAG` with `memhtml task list --status` among the suggestions, because a flag silently ignored would return an unfiltered answer that reads as filtered. `apps/cli/src/run.ts:989-1002`

## entity activity

```
memhtml entity activity [--type <entity-type>] [--limit 50] [--include-archived]
```

Every entity with its file count and its last activity, newest first. A report and never a signal. `apps/cli/src/operations.ts`

Flags:

- `--type`: Restrict to one entity type, e.g. `service` — the half before the colon in a `type:name` reference. Matched case-insensitively, the way `--entity` is matched by `search` and `list`. String. `apps/cli/src/commands.ts:508`
- `--limit`: Rows to return, 1 to 500. An ask outside that is clamped rather than refused, and `limit` echoes the bound. Int, default 50. `apps/cli/src/commands.ts:514`
- `--include-archived`: Aggregate archived memories too. Excluded by default, because eviction is a `git mv` and an archived memory would otherwise keep an entity looking active. Boolean, default false. `apps/cli/src/commands.ts:521`

Three timestamps, because they are three clocks. `lastActivityAt` is `max(coalesce(event_at, updated_at))`, the recency arm's own rule, so "most recently active" means here what it means in a ranked search. `lastEventAt` is `max(event_at)` alone — WORLD time, `null` when no in-scope memory states one. `lastWrittenAt` is `max(updated_at)` alone: WRITE time. `entityCount` is the total matching the scope regardless of `limit`, so a clamped answer is visible rather than silent.

A row is one STORED reference rather than one folded identity: the grouping is on `(entity_type, entity_name)` as `file_entities` holds them, so a corpus that authored both `Service:Checkout-API` and `service:checkout-api` reports two rows where `--entity` at either retrieval door returns one entity's memories. `entity-resolution` is the phase that folds spellings.

Report-only, and structurally so. Every ranking arm lives in `@memhtml/index` and every decay term in `@memhtml/domain`, both below `apps/cli` in the project-reference graph, so neither can import this read.

There is no cursor, so a corpus with more than 500 entities cannot be fully enumerated through this command. `entityCount` makes the truncation visible.

## task add

```
memhtml task add --title <title> [--status todo] [--due <iso>]
```

Open a task: a `task` memory in `projects/<ws>/tasks/` or `areas/inbox/tasks/`. `apps/cli/src/run.ts:470-503`

Flags:

- `--title`: What the task is. Becomes the `<title>` and the filename slug. Required, string. `apps/cli/src/commands.ts:450`
- `--claim`: The task statement, as the `<mark>` span. Defaults to `--title`. String. `apps/cli/src/commands.ts:456`
- `--body`: A prose paragraph of working notes. Repeatable, one `<p>` each. String. `apps/cli/src/commands.ts:461`
- `--status`: The opening status: `todo`, `doing`, `blocked`, or `done`. String, default `todo`. `apps/cli/src/commands.ts:467`
- `--due`: An ISO date or datetime deadline, `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ssZ`. Compared as a string, so the form matters. String. `apps/cli/src/commands.ts:474`
- `--workspace`: Routes the task to `projects/<slug>/tasks/`. String. `apps/cli/src/commands.ts:479`
- `--tag`: A tag. Repeatable; tags scope search but never route a task. String. `apps/cli/src/commands.ts:484`
- `--entity`: A `type:name` entity reference. Repeatable, string. `apps/cli/src/commands.ts:490`
- `--session-id`: The Claude Code session that opened the task. String. `apps/cli/src/commands.ts:496`
- `--prompt-id`: The prompt within that session. String. `apps/cli/src/commands.ts:500`
- `--turn-uuid`: The turn within that session. String. `apps/cli/src/commands.ts:501`

This command is a shorthand over the same write path every other write uses. It calls `writeMemory` with `memoryType: "task"`. Because a task is a file in a directory, an agent can also work tasks with ordinary file tools. `apps/cli/src/commands.ts:435-443`

`--due` takes the same two forms `<time datetime>` does, and a value outside them is a document violation rather than a dropped optional, because `files.due_at` is compared and ordered as a raw string and an unsortable value would make the overdue query silently wrong rather than empty. `apps/cli/src/operations.ts:128-134`, `packages/html/src/parse.ts:247-249`

The status vocabulary is `TASK_STATUSES`. `packages/contracts/src/types.ts:82`

## task status

```
memhtml task status <path> <status> [--reason <reason>]
```

Move a task's status. `done` stamps and archives it, in one commit. `apps/cli/src/run.ts:504-513`

Arguments:

- `<path>`: The task file. Required. `apps/cli/src/commands.ts:509`
- `<status>`: One of `todo`, `doing`, `blocked`, `done`. Required. `apps/cli/src/commands.ts:510`

Flags:

- `--reason`: Why it closed. Recorded on the archive commit when the status is `done`. String. `apps/cli/src/commands.ts:514`

## task list

```
memhtml task list [--status <status>] [--workspace <ws>] [--due-before <iso>] [--detected] [--limit 50] [--cursor <path>]
```

The task working set: a direct indexed scan with blockers, never ranked retrieval. `apps/cli/src/run.ts:514-527`

Flags:

- `--status`: One task status. String. `apps/cli/src/commands.ts:527`
- `--workspace`: One workspace. String. `apps/cli/src/commands.ts:532`
- `--due-before`: An ISO date. Returns tasks due strictly before it, by calendar day. String. `apps/cli/src/commands.ts:534`
- `--limit`: Rows per page. Int, default 50. `apps/cli/src/commands.ts:538`
- `--cursor`: The `next_cursor` from the previous page: the last path returned. String. `apps/cli/src/commands.ts:540`
- `--include-archived`: Include finished tasks. `done` archives, so they are otherwise absent. Boolean, default false. `apps/cli/src/commands.ts:545`
- `--detected`: Only tasks the sleep cycle detected, never ones opened by hand. Boolean, default false. `apps/cli/src/commands.ts:551`

`--detected` is the machine's queue: each row is a proposal carrying the evidence `task-detection` detected it from, which is why it is a separate scope rather than a status. `apps/cli/src/commands.ts:551-557`

## index rebuild

```
memhtml index rebuild [--no-embed]
```

Rebuild `index.db` from the git tree at HEAD. Destroys nothing outside `.memhtml/`. `apps/cli/src/run.ts:528-534`

Flags:

- `--embed`: Fill missing vectors from Bedrock. `--no-embed` makes the rebuild instant. Boolean, default true. `apps/cli/src/commands.ts:567`

`memhtml index rebuild --embed` is the embed-model migration path: it is the one call that rewrites the vector space, and `EmbedModelMismatch` names it as its own recovery. There is no flag naming a model, because the model comes from the environment and a rebuild fills every missing vector in whatever space is configured. `apps/cli/src/errors.ts:157`

It is also the recovery from `ERR_INDEX_STALE`, and the only one. A rebuild that emptied the tables and did not finish repopulating them is detectable, and `memhtml index update` is what raises the tag — it refuses a watermark row with no commit on it rather than diffing from nothing — so a rebuild is the one call that repopulates what the interrupted pass left partial. `packages/index/src/indexer.ts:125`, `packages/index/src/indexer.ts:605-609`, `apps/cli/src/errors.ts:158`

## index update

```
memhtml index update [--no-embed]
```

Index only what moved since the recorded watermark, plus the dirty working tree. `apps/cli/src/run.ts:535-541`

Flags:

- `--embed`: Fill missing vectors. Boolean, default true. `apps/cli/src/commands.ts:580`

This command indexes uncommitted working-tree changes as well as committed ones. A file an agent edited by hand in the root is therefore searchable before it is committed. `apps/cli/src/commands.ts:934-935`

Every write path reindexes through this diff-driven pass rather than by naming the paths it just wrote. A `git mv` is ONE rename record in the commit diff rather than an unrelated delete plus add, so only the diff can express an archive as the move it is, and only this pass records the watermark the next incremental run reads. `apps/cli/src/operations.ts:228`

## index status

```
memhtml index status
```

The index watermark, the vector space it was built in, and its row counts. `apps/cli/src/run.ts:542-547`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:584-590`

## trace index

```
memhtml trace index
```

Scan `$MEMHTML_TRACE_ROOT` for Claude Code transcripts, reading only what changed. `apps/cli/src/run.ts:548-553`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:591-597`

`$MEMHTML_TRACE_ROOT` defaults to `~/.claude`. The CLI only reads from it and never writes to it. `apps/cli/src/config.ts:33-38`

The report accounts for every file the scan planned to read: `skipped + tailed + rescanned + filesFailed` is that total, so a file the scan could not read is visible rather than absorbed into a smaller-looking sweep. `sessionsWritten` answers a different question — it counts the files for which a `traces` row was actually written — so it is not a fourth term of that identity and a run can tail a file and write no row. `apps/cli/src/operations.ts:1754-1785`, `packages/traces/src/scan.ts:65`

## trace search

```
memhtml trace search <query> [--cwd <dir>] [--since <iso>] [--limit 20]
```

FTS over session first-prompts and AI titles. Never enters memory retrieval. `apps/cli/src/run.ts:554-564`

Arguments:

- `<query>`: Prose. Required. `apps/cli/src/commands.ts:601`

Flags:

- `--cwd`: Restrict to sessions from this directory. String. `apps/cli/src/commands.ts:603`
- `--since`: ISO-8601 lower bound on `started_at`. String. `apps/cli/src/commands.ts:604`
- `--limit`: Sessions to return. Int, default 20. `apps/cli/src/commands.ts:605`

## trace links

```
memhtml trace links [--session-id <id>] [--path <path>]
```

The memory-session links, from either side. `apps/cli/src/run.ts:565-573`

Flags:

- `--session-id`: Every memory this session touched. String. `apps/cli/src/commands.ts:614`
- `--path`: Every session that touched this memory. String. `apps/cli/src/commands.ts:615`

## sleep run

```
memhtml sleep run [--date YYYY-MM-DD] [--phases <list>] [--dry-run] [--deep] [--max-llm-calls <n>]
```

The curation cycle: one isolated commit per phase on a review branch. The summary and the `--phases` default are both derived from `SLEEP_PHASES.length` rather than typed, so the number the manifest states and the list beside it cannot disagree. `apps/cli/src/run.ts:574-589`, `apps/cli/src/commands.ts:627`

Flags:

- `--date`: The run date, `YYYY-MM-DD`. Defaults to today. Names the branch. String. `apps/cli/src/commands.ts:631`
- `--phases`: Comma-separated subset. Every phase by default. String. `apps/cli/src/commands.ts:636`
- `--dry-run`: Report per-phase counts and commit nothing. Boolean, default false. `apps/cli/src/commands.ts:641`
- `--deep`: The deep-sleep cycle: mine a lower grouping band, group by shared entity, re-file inbox singletons, and iterate `compress` until a pass folds nothing. Reaches the inbox tail the default community gate cannot, and costs more model calls. Same branch, review, and merge gate as a run without the flag. Boolean, default false. `apps/cli/src/commands.ts:647`
- `--max-llm-calls`: Cap on model calls the deep mechanisms may spend, shared across all deep phases. Exhaustion skips remaining batches with reason `budget` and the run stays green. Read only with `--deep`; absent means uncapped. Int. `apps/cli/src/commands.ts:657`

The phase names come from `SLEEP_PHASES` — seventeen as of v0.6.0, in execution order: `preflight`, `dedup-merge`, `entity-resolution`, `person-links`, `relationship-mining`, `edge-typing`, `confidence-decay`, `arc-synthesis`, `retention-triage`, `compress`, `reprieve`, `trace-consolidation`, `task-detection`, `placement-triage`, `integrity`, `state-export`, `report`. `packages/sleep/src/contract.ts:43-61`

Fifteen of them commit. `preflight` and `relationship-mining` are the two that cannot: `preflight` refreshes the index and asserts a clean tree, and `relationship-mining` writes derived edges to the index only, which are a re-derivable function of the corpus and the embedder. `packages/sleep/src/contract.ts:197`

Eight of them spend model calls when a model is bound: `dedup-merge`, `entity-resolution`, `edge-typing`, `arc-synthesis`, `compress`, `trace-consolidation`, `task-detection`, `placement-triage`. The other nine are deterministic and cost none. `packages/sleep/src/contract.ts:168-177`

`placement-triage` is deep-only. On a run without `--deep` it returns immediately, writes nothing, and commits nothing, so a default run's behavior is unchanged by its presence in the list. `packages/sleep/src/contract.ts:33-41`

A run with any failed phase exits 1, while still writing the `sleep.report` success envelope with the whole per-phase report. Both halves matter: a cron line reading only the exit code has to see that the curation did not happen, and a failure envelope carries no `data`, so reporting it as one would delete the per-phase detail that says which phases landed. A fully aborted run and a partially failed one exit the same, because a caller reading the exit code is asking one question and both answers are no; the payload already distinguishes them precisely, since an abort is every selected phase `failed` with `headSha === baseSha` and no commits. `apps/cli/src/run.ts:267-285`

A run holds a checked-out `sleep/<date>` branch. Any write that lands during the run commits onto that branch. `apps/cli/src/commands.ts:943-946`

## sleep resume

```
memhtml sleep resume <run-id>
```

Re-run only the phases with no `Memhtml-Phase` trailer on the branch. `apps/cli/src/run.ts:590-597`

Arguments:

- `<run-id>`: The run id, for example `sleep/2026-08-02`. Required. `apps/cli/src/commands.ts:670`

This command takes no flags. `apps/cli/src/commands.ts:671`

It carries the same exit-1-on-a-failed-phase rule `sleep run` does, and for the same reason. `apps/cli/src/run.ts:595`

## sleep review

```
memhtml sleep review <run-id> [--diff]
```

Per-phase counts, the commit list, `diff --stat`, and a per-file classification. `apps/cli/src/run.ts:598-613`

Arguments:

- `<run-id>`: The run id. Required. `apps/cli/src/commands.ts:677`

Flags:

- `--diff`: Include the raw diff. Boolean, default false. `apps/cli/src/commands.ts:679`

The raw diff is fetched only when asked for. Its size is unbounded, so a default response that carried it could exceed a context window. `apps/cli/src/run.ts:604-606`

This command exits 0 even when the run it describes failed. It reports a run it did not perform, and a read that exited non-zero because its subject failed would make "tell me what happened" indistinguishable from "I could not tell you". `apps/cli/src/run.ts:281-283`

## sleep merge

```
memhtml sleep merge <run-id> [--skip-gate]
```

Fast-forward main to the run's branch, after the discrimination gate passes. `apps/cli/src/run.ts:614-645`

Arguments:

- `<run-id>`: The run id. Required. `apps/cli/src/commands.ts:686`

Flags:

- `--skip-gate`: Merge without re-running discrimination. A deliberate, logged override, never a default. Boolean, default false. `apps/cli/src/commands.ts:689`

The gate is composed here rather than defaulted inside the sleep package. A failed gate returns `refusal: "gate-failed"` and main does not move. `apps/cli/src/run.ts:623-643`

The merge is also where a run's deferred state-plane writes land. `git branch -D` is this design's abort and `main` never moves during a run, so a write into `.memhtml/state.db` performed DURING a phase would outlive the branch that earned it — and for the consolidation watermark that is data loss rather than bookkeeping, because the watermark is an anti-join and a session it covers is never selected again. So `trace-consolidation`, `edge-typing`, and `entity-resolution` record their writes as marks in a committed ledger, `.memhtml/sleep/<run-id>.pending.jsonl`, and this command reads that ledger as a blob at the branch tip and applies the marks after the fast-forward succeeds. `packages/sleep/src/contract.ts:306-352`, `packages/sleep/src/review.ts:344-366`

The report carries `marksPending` and `marksApplied`, two numbers rather than one because they answer different questions: what the branch earned, and what the plane took. They agree on an ordinary merge, so a disagreement is the operator-visible reading of a plane write that did not land — the sessions in the shortfall stay unconsolidated and are re-read next cycle, which costs a model call and loses nothing. A failed apply does not fail the merge: `main` has already moved and the memories are landed. `packages/sleep/src/contract.ts:272-286`

## sleep status

```
memhtml sleep status
```

The latest sleep run and its per-phase outcomes. `apps/cli/src/run.ts:670-686`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:698-704`

Like `sleep review`, it exits 0 even when the run it reports failed. `apps/cli/src/run.ts:281-283`

## sleep plan

```
memhtml sleep plan
```

Would a run change anything? Reads index counts and runs no phase, so it costs a handful of aggregates rather than the seventeen phases `--dry-run` executes before declining to write. `packages/sleep/src/plan.ts`

No arguments and no flags. The signals ARE the phases' own selection predicates, called or clause-shared, so a caller wanting one reads its entry out of `signals`.

`verdict` is the field to branch on, and it has three values because two phases cannot have their candidates counted cheaply. `would-change`: a counted signal is non-zero. `no-signal`: every counted signal is zero, every uncountable phase's input is empty, AND `indexFresh` is true, which is the one state in which a run would reach nothing. `unknown`: everything else — `dedup-merge` and `relationship-mining` select candidate pairs from an n-by-n neighbor scan, so counting their candidates is the scan, and each reports an `inputCount` with an `unknownReason` instead of a zero.

Every count comes from `.memhtml/index.db`, so `indexFresh` says whether they describe anything: it is the same predicate `memhtml status` reports, and `indexedCommit` names the commit they do describe. A clone, a `git pull`, and a deleted index all answer every aggregate with zero over a corpus nothing has curated, so a stale index can never yield `no-signal`.

`signals` carries the counted ones with the phases each feeds: memories written since the last run, chunks with no vector, settled transcripts, dangling authored links, and entity merges awaiting a second run. `sessionsPerRun` is the consolidation phase's per-run cap, published beside the transcript count because a backlog larger than the cap is more than one run of work.

## status

```
memhtml status
```

Corpus health: HEAD, dirty state, counts by type, edges, index freshness. `apps/cli/src/run.ts:687-692`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:705-711`

## publish

```
memhtml publish
```

Regenerate the per-directory `index.html` listings and `sitemap.xml`, and commit them. `apps/cli/src/run.ts:646-651`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:712-718`

## doctor

```
memhtml doctor [--fix]
```

Corpus health: dangling hrefs, orphan state rows, inbox depth, vocabulary, staleness. `apps/cli/src/run.ts:652-657`

Flags:

- `--fix`: Repair dangling hrefs and prune orphan access rows. The other findings need a decision. Boolean, default false. `apps/cli/src/commands.ts:726`

`--fix` reports what it did as `repaired: { rewritten, dropped, failedWrites, prunedAccessRows, commitSha }`. A write that failed lands in `failedWrites` naming the source path, is not counted under `rewritten`, and is never staged — staging the unchanged file would commit the pre-repair bytes under a message claiming a repair. So a finding in `failedWrites` is still open and the next `memhtml doctor` reports it again. `apps/cli/src/doctor.ts:156`, `apps/cli/src/doctor.ts:388-440`

## eval discriminate

```
memhtml eval discriminate [--mode fake] [--seed <n>] [--now <ms>] [--size 200] [--probes 36] [--mrr-floor 0.85]
```

The refusable retrieval gate: every probe must outrank its own wrong-fact twins. `apps/cli/src/run.ts:1181-1211`

Flags:

- `--mode`: `fake` is the deterministic embedder CI measures; `live` needs `AWS_BEARER_TOKEN_BEDROCK` and refuses loudly without it. String, default `fake`. `apps/cli/src/commands.ts:741`
- `--seed`: The fixture corpus seed. A failing run is reproducible from this number. Int. `apps/cli/src/commands.ts:749`
- `--now`: The run instant the fixture corpus anchors its stamps behind, in UTC milliseconds since the epoch. Int, defaults to the clock. `apps/cli/src/commands.ts:754`
- `--size`: Base memories to generate. Int, default 200. `apps/cli/src/commands.ts:759`
- `--probes`: Probes to run. Design §5 wants at least 30. Int, default 36. `apps/cli/src/commands.ts:761`
- `--mrr-floor`: Mean-reciprocal-rank floor. Lowering it is a deliberate, visible choice. String, default `0.85`. `apps/cli/src/commands.ts:767`

`--now` is the other half of reproducing a failing run. The corpus is a function of `(seed, now)` and the recency arm ranks on those stamps, so a seed alone pins the text and not the ordering. It rides back in the report, which is what makes a rerun exact. `apps/cli/src/commands.ts:754-758`

A failed gate exits 1 with `ERR_DISCRIMINATION_FAILED`. A pipeline can stop on the exit code instead of reading a verdict out of the payload. `apps/cli/src/run.ts:1176-1179`

This command generates its own fixture corpus in a temp directory with an in-memory database. It does not open the operator's `index.db`. `apps/cli/src/run.ts:1168-1180`

## exec

```
memhtml exec --file <script.mjs>
memhtml exec --script <source>
memhtml exec --file -
cat script.mjs | memhtml exec
```

Run a read-only traversal script over the corpus in a sandbox: multi-hop in one execution. `apps/cli/src/run.ts:1227-1281`

Flags:

- `--file`: The script to run, as a path on the host. Omit it, pass `--file -`, or pass a positional `-` to read the script from stdin. Mutually exclusive with `--script`. String. `apps/cli/src/commands.ts:812`
- `--script`: The script source, inline. Mutually exclusive with `--file` and with reading stdin. String. `apps/cli/src/commands.ts:818`
- `--timeout-ms`: Wall-clock bound on the script. Exceeding it is `exitCode` 124 with `timedOut: true`, not an error envelope. Int, default 30000, capped at 600000. `apps/cli/src/commands.ts:824`
- `--sha`: The commit to mount, materialized as a detached worktree. Defaults to HEAD. Never the live working tree. String. `apps/cli/src/commands.ts:831`

The default and cap are constants: `DEFAULT_TIMEOUT_MS` is 30000 at `apps/cli/src/exec.ts:47` and `MAX_TIMEOUT_MS` is 600000 at `apps/cli/src/exec.ts:57`.

Passing the script through more than one of the three doors is a usage error, and `-` is the explicit stdin spelling in both of its positions, so it cannot sit beside a real `--file` or a `--script` either. So is a `--timeout-ms` that is not positive or above the cap: a non-positive bound is no bound at all, which is the one thing a sandbox may not be. Both are checked before any service is built. `apps/cli/src/run.ts:769-808`

A non-zero `exitCode` in the payload means the script failed, and the process still exits 0. Exit 1 means the runtime could not run the script at all. A blank script is exit 2 rather than an empty answer. `apps/cli/src/run.ts:1234-1248`

The sandbox's own capabilities have no flag. Python and network access are off, and no invocation can turn them on. `apps/cli/src/commands.ts:801-803`

## state export

```
memhtml state export
```

Write `.memhtml/state/access.jsonl`, the only durable copy of the state plane, and commit. `apps/cli/src/run.ts:658-663`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:839-846`

## state import

```
memhtml state import
```

Replay the committed sidecar into `state.db`. Counters merge by max, never last-wins. `apps/cli/src/run.ts:664-669`

This command takes no arguments and no flags. `apps/cli/src/commands.ts:847-853`

## agents-doc

```
memhtml agents-doc [--check] [--out AGENTS.md]
```

Regenerate `AGENTS.md` from this command table. `--check` fails on drift. `apps/cli/src/run.ts:1123-1131`

Flags:

- `--check`: Compare the committed doc to the regenerated one and fail on a difference. Boolean, default false. `apps/cli/src/commands.ts:860`
- `--out`: Where to write. Defaults to `./AGENTS.md`. String. `apps/cli/src/commands.ts:865`

The generated doc renders the same `COMMANDS` array that drives parsing, so every flag it describes is one the binary accepts. The rendering is deterministic to the byte, which is what lets the drift check compare the two copies exactly. `apps/cli/src/agents-doc.ts:11-21`

`--check` writes nothing. A check that repaired the drift it found would turn an uncommitted change into a green pipeline. `apps/cli/src/agents-doc.ts:209-242`

This command builds no app layer, so running it in CI does not scaffold a memhtml root as a side effect: `layerDatabase` would open `$MEMHTML_ROOT/.memhtml/index.db`, create the directory, and run every migration, which is a memory repo appearing on any machine that rendered Markdown. `apps/cli/src/run.ts:1113-1118`

## serve mcp

```
memhtml serve mcp
```

Run the `memhtml-mcp` stdio server: 15 tools and 3 resources over this same repo. `apps/cli/src/run.ts:1146-1165`

This command takes no arguments and no command-specific flags. `apps/cli/src/commands.ts:869-875`

It reads the global `--repo` flag and resolves it against the configured root. `apps/cli/src/run.ts:1148-1152`

The resolved root reaches the child as an explicit `MEMHTML_ROOT` on top of the inherited environment. Inheritance alone would not carry a root that came from `--repo`. `apps/cli/src/serve.ts:79`

The server runs as a child process rather than in-process. A stdio MCP server uses stdout as an NDJSON-RPC stream, and the CLI writes exactly one JSON envelope to that same descriptor, so the two cannot share it. `apps/cli/src/serve.ts:8-20`

The server binary is located as a sibling in the same build. `MEMHTML_MCP_BIN` overrides that path for a split deployment. `apps/cli/src/serve.ts:31-48`

The override variable's name is declared once as a constant, and the config table imports that constant. The documented name and the name the supervisor reads are therefore always the same string. `apps/cli/src/serve.ts:32`

## Error codes

A caller should branch on `code` rather than on the `error` prose. The code list is append-only. A shipped code keeps its meaning and is not removed. `apps/cli/src/envelope.ts:62-87`

The sixteen codes, in `ERROR_CODES` order, are `ERR_UNKNOWN_COMMAND`, `ERR_MISSING_ARGUMENT`, `ERR_INVALID_FLAG`, `ERR_UNEXPECTED_ARGUMENT`, `ERR_PATH_NOT_FOUND`, `ERR_INVALID_MEMORY`, `ERR_DUPLICATE_CONTENT`, `ERR_WRITE_CONFLICT`, `ERR_DIRTY_TREE`, `ERR_INDEX_STALE`, `ERR_EMBED_MODEL_MISMATCH`, `ERR_MODEL_UNAVAILABLE`, `ERR_STORAGE`, `ERR_GIT`, `ERR_DISCRIMINATION_FAILED`, `ERR_UNKNOWN`. `apps/cli/src/envelope.ts:67-87`

`ERR_UNEXPECTED_ARGUMENT` names a positional past what the command declares. It is its own code rather than a reuse of a neighbor, because the offending token is not a flag, which rules out `ERR_INVALID_FLAG`, and it is surplus rather than absent, which rules out `ERR_MISSING_ARGUMENT`: the caller fixes it by dropping a word instead of adding one. `apps/cli/src/envelope.ts:71-74`

An unknown command or an unknown flag returns nearest-match candidates in `suggestions`, computed by Levenshtein distance. A caller can retry a typo from that list without a second discovery call. `apps/cli/src/envelope.ts:129-143`

A suggestion has to be a call that MOVES the failure, which is why the `IndexStale` recovery is `memhtml index rebuild` and nothing else: `memhtml index update` is what raises the tag, so naming it would loop. Suggestions are a record keyed by tag rather than a `switch`, which is what closes that drift class, and a test drives every string through the binary's own `parseArgv`. `apps/cli/src/errors.ts:118-136`

For a two-word command the distance is measured against the whole typed invocation, so `memhtml index rebiuld` scores 2 against `index rebuild` rather than losing to `init`. `apps/cli/src/run.ts:728-767`

## Environment variables

Every environment variable is declared in one array, which is what `memhtml manifest` reads to describe them. `apps/cli/src/config.ts:26-78`

- `MEMHTML_ROOT`: The memory repo's root: a git repository holding the corpus and `.memhtml/`. Defaults to `~/memhtml`. `apps/cli/src/config.ts:28-31`
- `MEMHTML_TRACE_ROOT`: Where `memhtml trace index` reads Claude Code transcripts from. Read-only. Defaults to `~/.claude`. `apps/cli/src/config.ts:33-36`
- `MEMHTML_AWS_REGION`: The Bedrock region for embeddings and the sleep cycle's model-calling phases. Defaults to `us-east-1`. `apps/cli/src/config.ts:39-41`
- `AWS_BEARER_TOKEN_BEDROCK`: Bedrock bearer token, read by the AWS SDK itself. When it is absent the SDK falls back to the default credential chain, and retrieval degrades to the lexical floor instead of failing. `apps/cli/src/config.ts:44-47`
- `MEMHTML_EMBED`: `off` disables the embedder entirely. An explicit opt-out, distinct from a missing credential: a missing credential degrades one search at call time and `off` degrades every search. Defaults to `on`. `apps/cli/src/config.ts:50-53`
- `MEMHTML_LLM`: `off` makes every phase in `LLM_PHASES` report `no model bound` and stay `ok`, so a credential-free run is honest rather than red. `dedup-merge` and `entity-resolution` still do real deterministic work — dedup falls back to its cosine floor plus the divergence veto and still commits, and entity-resolution runs its normalization and character-overlap passes — while the rest report a reason and write nothing. Defaults to `on`. `apps/cli/src/config.ts:56-59`, `packages/sleep/src/contract.ts:143-177`
- `MEMHTML_EXTRACT_ENTITIES`: `on` adds one model call per write batch that extracts `memhtml-entity` metas the ops did not declare. It defaults to `off` because it changes what a write stores: extracted entities land in the files as if authored, and the write itself never waits on or fails with the model — a failed extraction is a logged warning and an unextracted batch. `apps/cli/src/config.ts:62-65`
- `MEMHTML_MCP_BIN`: An explicit path to the `memhtml-mcp` entry point, read only by the `memhtml serve mcp` supervisor. When it is absent the supervisor uses the sibling-path default. The name is imported from one constant rather than retyped here, so this row and the `process.env` read cannot name different strings. `apps/cli/src/config.ts:67-77`

## See also

- [memhtml-public · Processes](../behavior/processes.md): 13 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 6 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 4 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 3 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 3 shared source citations
