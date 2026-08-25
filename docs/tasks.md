# Tasks — the tenth memory type

A task is an ordinary memory file whose `memhtml-type` is `task` — one value in the closed type vocabulary rather than a parallel axis (`packages/contracts/src/types.ts:18`). It inherits every primitive the corpus has (path identity, hash-invariant meta edits, a git audit trail, archive-as-`git mv`, a per-directory `index.html`), and its different treatment is stated by the filters that read `memory_type`, never by a second column.

**The contract in one line: an agent works tasks the way it works files.** `ls` a directory to list them, grep a meta to filter, edit one head line to update, `git mv` to finish.

## The file, as a delta from an ordinary memory

Everything in `docs/format.md` holds: one `<mark>` claim leading the article, the closed element vocabulary, the four required metas. A task adds two head metas and one placement rule.

|                       |                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `memhtml-task-status` | **Required on a task, forbidden on anything else.** `todo \| doing \| blocked \| done` (`packages/contracts/src/types.ts:82`). |
| `memhtml-due`         | Optional. A deadline as `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ssZ`, the two forms `files.due_at` can string-order.                 |
| Directory             | `projects/<slug>/tasks/` with a workspace, `areas/inbox/tasks/` without (`packages/contracts/src/paths.ts:116`).               |

Both metas serialize after `memhtml-needs-revision` and before the repeatable keys (`packages/html/src/vocabulary.ts:65`), and project to `files.task_status` and `files.due_at` (`packages/index/src/project.ts:123`). The status meta's agreement with the type is a **parse violation in both directions**, not a dropped optional (`packages/html/src/parse.ts:166`): a task with no `memhtml-task-status` is refused (`:185`), and a non-task carrying one is refused (`:176`). A refused file never reaches the index — it sits in the tree, absent from every listing. So the template defaults the status rather than requiring it (`DEFAULT_TASK_STATUS`, `packages/html/src/template.ts:73`) and stamps it only for a task (`:173`).

Placement routes by workspace **alone**, ahead of the person and topic rules: a `person:` entity does not send a task to `resources/people/`, the durable identity surface, and a task carries no topic for the tag rule to read (`packages/contracts/src/paths.ts:112`).

## Two status axes, and why finishing archives

`memhtml-status` stays `active | archived` for a task exactly as for a memory (`packages/contracts/src/types.ts:69`); `memhtml-task-status` is a separate axis (`:72`), and `task_status` is its own nullable CHECK-constrained column beside `archived` (`packages/index/migrations/0008_tasks.sql:72`). Two axes rather than a fifth `memhtml-status` value, because `active`/`archived` is what every archive, correction, publish, and retention path switches on.

So `done` is not a resting state. `memhtml task status <path> done` writes the status with `setMeta`, then routes through `store.archiveMemory` — a `git mv` into `archive/<YYYY>/<original path>` plus the `memhtml-status`/`memhtml-updated`/`memhtml-archived` stamps (`apps/cli/src/operations.ts:1384`, `packages/store/src/store.ts:893-897`). The stamp is written _before_ the move, so both land in one commit and `git log --follow` reads through it. There is no delete and no completed-task list: **"what did I finish" is the archive tree plus `git log`**, and `memhtml task list --include-archived` shows it.

Every other transition is one head line plus the `memhtml-updated` stamp — `setMeta` splices by source offset, so the article's bytes and therefore `memhtml-content-hash` do not move (`apps/cli/src/operations.ts:1352`). Re-stamping the status a file already carries writes nothing and returns `unchanged: true` (`apps/cli/src/operations.ts:1342-1349`). Pointing `memhtml task status` at a non-task fails `ERR_INVALID_MEMORY` before any write (`apps/cli/src/operations.ts:1329-1335`).

## `memhtml-due` is string-ordered, so the format is the contract

`files.due_at` is compared and ordered **as a string**, never parsed per row (`packages/index/migrations/0008_tasks.sql:73-75`). A value that does not sort lexicographically alongside the others makes an overdue query silently wrong rather than empty, so `memhtml-due` reuses the format's own `<time datetime>` validator (`isValidDatetime`, `packages/html/src/constraints.ts:75`) at three points: the parser reports a violation (`packages/html/src/parse.ts:247`), `decodeDueAt` refuses the write (`apps/cli/src/operations.ts:133`), and `--due-before` refuses the query bound through that same `decodeDueAt` (`apps/cli/src/operations.ts:1637`).

**Exactly two forms are accepted:** the calendar date `YYYY-MM-DD`, or the canonical UTC instant `YYYY-MM-DDThh:mm:ssZ` (`ISO_DATETIME`, `packages/html/src/constraints.ts:64`). A bare date is a prefix of every instant on its day, so the two mix safely. Everything else is refused, and each rejected form breaks string ordering on its own: a space separator sorts before `T` (`"2026-08-24 13:00" < "2026-08-24T12:00"`), a non-UTC offset sorts by its clock face rather than its instant, and `hh:mm` without seconds or with a fraction makes `…T13:00:30Z` sort before the `…T13:00Z` it extends. So `2026-08-20 09:00`, `2026-08-20T09:00Z`, `2026-08-20T09:00:00.500Z`, and `2026-08-20T09:00:00+02:00` are all refused, as are `2026-8-9`, `Aug 9 2026`, `2026-13-45` (the day is round-tripped through `Date.UTC`), a bare time, a duration, and a week — `Date.parse` accepts several of those and none sorts alongside a padded date. `23:59:60` seconds is admitted, because a leap second is a real instant. Both overdue queries truncate to `substr(…, 1, 10)`, stating the comparison is one of **calendar days** (`apps/cli/src/operations.ts:1648`, `apps/cli/src/doctor.ts:231`): a task due sometime on the 25th is not late at 09:00 on the 25th.

## Edges: `blocks` and `subtask_of`

The task rel vocabulary is exactly two (`packages/contracts/src/edges.ts:54`), forming their own `edge_class` — the fourth (`:9`). The class is a firewall: every memory-graph query filters `edge_class = 'memory'` (`packages/sleep/src/sql.ts:271`, `apps/cli/src/operations.ts:1113`), so task topology cannot enter PageRank, label propagation, MMR's lateral arm, or the retention bridge count.

```
memhtml link <blocker> blocks <blocked>          # blocker must finish first
memhtml link <child> subtask_of <parent>         # decomposition
```

Both endpoints must be tasks. `requireEndpointClasses` refuses the mismatch in both directions — a memory rel with a task endpoint, and a task rel with a non-task endpoint — because the store is the only layer that reads both files' `memhtml-type` (`packages/store/src/store.ts:993`). The SQL CHECK pairs a rel with its class only and cannot reach the endpoints (`packages/index/migrations/0008_tasks.sql:194-199`). Provenance is unaffected: a task legitimately came from a session.

`blocks` has two readers — `memhtml task list`'s `blockedBy`, every task asserting `blocks` toward this one (`apps/cli/src/operations.ts:1492-1495`), and `memhtml doctor`'s `staleBlockers` (`apps/cli/src/doctor.ts:269`). **`subtask_of` has none**: no surface reports it and `memhtml neighbors` filters to the memory class, so a decomposition is stored but read back only from the file's `<link>` or the `edges` table.

## The CLI surface

| Command               | Arguments and flags                                                                                                          | Response type  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `memhtml task add`    | `--title`* `--claim` `--body` `--status` `--due` `--workspace` `--tag` `--entity` `--session-id` `--prompt-id` `--turn-uuid` | `task.written` |
| `memhtml task status` | `<path> <status>`, `--reason`                                                                                                | `task.updated` |
| `memhtml task list`   | `--status` `--workspace` `--due-before` `--limit` `--cursor` `--include-archived`                                            | `task.list`    |

Defined at `apps/cli/src/commands.ts:413`, dispatched at `apps/cli/src/run.ts:356`, envelope types at `apps/cli/src/envelope.ts:40`. `--claim` defaults to `--title` (`apps/cli/src/run.ts:361-363`), and `--reason` is recorded on the archive commit, so only `done` has one to record.

`memhtml task list` is a **direct indexed scan**, never retrieval: every matching row ordered by path, a keyset cursor on the last path, `--limit` 50 by default and capped at 500 (`apps/cli/src/operations.ts:1447`). The partial index `files_task_status` (`WHERE memory_type='task' AND archived=0`) keeps it the size of the open work (`packages/index/migrations/0008_tasks.sql:139`).

`memhtml link` authors both task rels — `AUTHORABLE_RELS` is the nine memory rels plus the two (`apps/cli/src/operations.ts:89`) — and `memhtml apply` writes tasks in a batch, a line carrying `"type":"task"` taking `status` and `due` alongside the ordinary fields (`apps/cli/src/apply.ts:49`). `memhtml write --type task` reaches the same placement rule and template default, and a hand-written file under `projects/<ws>/tasks/` satisfying the format is as real as one the CLI wrote.

## What the corpus machinery does not do to a task

- **Retrieval excludes tasks by default.** An unscoped query gets `memory_type <> 'task'` (`packages/index/src/scope.ts:121`); a caller-named type list is honored verbatim, so this is a default with a reachable opt-in rather than a hidden row (`:109`).
- **Dedup carves tasks out, both directions.** The partial unique index and the write path's lookup state one predicate (`packages/index/migrations/0008_tasks.sql:126-127`, `packages/index/src/traces-persist.ts:166`), and the store's intra-batch map restates it (`packages/store/src/store.ts:316-323`). Two open tasks with identical bodies are two work items, and a memory is never deduped onto a task's path.
- **Sleep skips them.** `SLEEP_EXCLUDED_TYPES` is stated once (`packages/sleep/src/sql.ts:36`) and spread into eight phase sites — dedup-merge, relationship-mining, edge-typing, retention-triage, reprieve, compress, confidence-decay, arc-synthesis — plus the two entity queries behind person-links and entity-resolution (`:337`, `:357`). Finished tasks need no exclusion: every phase's corpus is `archived = 0`. `HALF_LIVES_DAYS.task` is `null` (`packages/domain/src/retention.ts:125`).

## `memhtml doctor`'s task findings

| Finding          | What it means                                                 | Counts toward `healthy` |
| ---------------- | ------------------------------------------------------------- | ----------------------- |
| `overdueTasks`   | open tasks whose `memhtml-due` day has passed, earliest first | no                      |
| `staleBlockers`  | an open task whose `blocks` blocker is archived or missing    | no                      |
| `inboxTaskDepth` | open tasks in `areas/inbox/tasks/`, a finding past ten        | yes                     |

All three are **report-only**: `--fix` repairs dangling hrefs and orphan `state.access` rows and nothing else (`apps/cli/src/doctor.ts:346`). Clearing a stale blocker is an authoring decision — the blocked task may be genuinely ready, or the blocker archived early — and it is the one task-graph state no single file reveals, since each file is individually valid and only the pair is wrong (`:261`).

The first two do not affect `healthy` (`:488`): they are facts about the work, not defects in the corpus, and folding them in would make `healthy: false` normal. The task inbox does count, at ten — half the memory inbox's twenty, because an unplaced memory is a routing rule that stopped matching while an unplaced task is work nobody owns (`:78`). Doctor is the only surface that reports a _passed_ deadline; `--due-before` reads `due_at` only against a caller-supplied bound.

## MCP status: read and create, never advance

The toolkit is fourteen tools and none is a task tool (`apps/mcp/src/tools.ts:881`).

- `memory_write` takes `memory_type: "task"` — the enum derives from `WRITABLE_MEMORY_TYPES` (`:45`). There is no `status` or `due` field in the write parameters (`:237-246`), so a task authored over MCP opens in `todo` with no deadline.
- `memory_list` filters `memory_type: "task"` and `memory_search` opts in through `memory_types: ["task"]` (`:650`, `:444`). `memory_recall` takes no type parameter at all (`:514-518`), so over MCP a task is unreachable through recall with no opt-in available.
- `memory_link`'s `rel` is `MemoryRelSchema`, the nine memory rels, so a task rel is refused at **decode** (`:578`). The task graph is authored from the CLI: asserting `blocks` is planning.
- **No status transition and no archive-on-done.** `memory_archive` moves a task into the archive without touching `task_status`, leaving a `todo` file under `archive/`.

## Worked sequence

```bash
W=projects/checkout-api/tasks
memhtml task add --title "Wire the drain step into the runbook" --workspace checkout-api \
             --due 2026-08-20 --body "The runbook says revert first."   # → $W/…-runbook.html, todo
memhtml task add --title "Land the target-group migration" --workspace checkout-api
memhtml link $W/land-the-target-group-migration.html blocks $W/wire-the-drain-step-into-the-runbook.html

memhtml task list --workspace checkout-api        # both, with blockedBy filled in
memhtml task list --due-before 2026-08-21         # by calendar day, strictly before

memhtml task status $W/land-the-target-group-migration.html done --reason "landed with the drain fix"
# → archive/2026/projects/checkout-api/tasks/land-the-target-group-migration.html

memhtml doctor    # staleBlockers: the runbook task waits on an archived blocker. Report-only, because
              # whether it is now ready is a judgement `--fix` cannot make.
```

`ls projects/checkout-api/tasks/` answers the same listing question with no binary at all, which is the point.
