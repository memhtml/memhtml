# Tasks — the tenth memory type

A task is an ordinary memory file whose `memhtml-type` is `task` — one value in the closed type vocabulary
rather than a parallel axis (`packages/contracts/src/types.ts:18`). It inherits every primitive the
corpus has (path identity, hash-invariant meta edits, a git audit trail, archive-as-`git mv`, a
per-directory `index.html`), and its different treatment is stated by the filters that read
`memory_type`, never by a second column.

**The contract in one line: an agent works tasks the way it works files.** `ls` a directory to list
them, grep a meta to filter, edit one head line to update, `git mv` to finish.

## The file, as a delta from an ordinary memory

Everything in `docs/format.md` holds: one `<mark>` claim leading the article, the closed element
vocabulary, the four required metas. A task adds two head metas and one placement rule.

| | |
|---|---|
| `memhtml-task-status` | **Required on a task, forbidden on anything else.** `todo \| doing \| blocked \| done` (`packages/contracts/src/types.ts:82`). |
| `memhtml-due` | Optional. An ISO date or datetime deadline. |
| `memhtml-finding-key` | Optional. `<detector>:<digest16>` on a task sleep minted; absent on one a human wrote. See "Detected tasks" below. |
| Directory | `projects/<slug>/tasks/` with a workspace, `areas/inbox/tasks/` without (`packages/contracts/src/paths.ts:116`). |

The first two metas serialize after `memhtml-needs-revision` and before the repeatable keys
(`packages/html/src/vocabulary.ts:65`), and project to `files.task_status` and `files.due_at`
(`packages/index/src/project.ts:123`). The status meta's agreement with the type is a **parse violation
in both directions**, not a dropped optional (`packages/html/src/parse.ts:166`): a task with no
`memhtml-task-status` is refused (`:185`), and a non-task carrying one is refused (`:176`). A refused file
never reaches the index — it sits in the tree, absent from every listing. So the template defaults the
status rather than requiring it (`DEFAULT_TASK_STATUS`, `packages/html/src/template.ts:73`) and stamps
it only for a task (`:173`).

Placement routes by workspace **alone**, ahead of the person and topic rules: a `person:` entity does
not send a task to `resources/people/`, the durable identity surface, and a task carries no topic for
the tag rule to read (`packages/contracts/src/paths.ts:112`).

## Two status axes, and why finishing archives

`memhtml-status` stays `active | archived` for a task exactly as for a memory
(`packages/contracts/src/types.ts:69`); `memhtml-task-status` is a separate axis (`:72`), and `task_status`
is its own nullable CHECK-constrained column beside `archived`
(`packages/index/migrations/0008_tasks.sql:72`). Two axes rather than a fifth `memhtml-status` value,
because `active`/`archived` is what every archive, correction, publish, and retention path switches on.

So `done` is not a resting state. `memhtml task status <path> done` writes the status with `setMeta`, then
routes through `store.archiveMemory` — a `git mv` into `archive/<YYYY>/<original path>` plus the
`memhtml-status`/`memhtml-updated`/`memhtml-archived` stamps (`apps/cli/src/operations.ts:1384`,
`packages/store/src/store.ts:893-897`). The stamp is written *before* the move, so both land in one commit
and `git log --follow` reads through it. There is no delete and no completed-task list: **"what did I
finish" is the archive tree plus `git log`**, and `memhtml task list --include-archived` shows it.

Every other transition is one head line plus the `memhtml-updated` stamp — `setMeta` splices by source
offset, so the article's bytes and therefore `memhtml-content-hash` do not move
(`apps/cli/src/operations.ts:1352`). Re-stamping the status a file already carries writes nothing and
returns `unchanged: true` (`apps/cli/src/operations.ts:1342-1349`). Pointing `memhtml task status` at a non-task
fails `ERR_INVALID_MEMORY` before any write (`apps/cli/src/operations.ts:1329-1335`).

## `memhtml-due` is string-ordered, so the format is the contract

`files.due_at` is compared and ordered **as a string**, never parsed per row
(`packages/index/migrations/0008_tasks.sql:73-75`). A value that does not sort lexicographically alongside
the others makes an overdue query silently wrong rather than empty, so `memhtml-due` reuses the format's own
`<time datetime>` validator (`packages/html/src/constraints.ts:67`) at three points: the parser reports
a violation (`packages/html/src/parse.ts:188`), `decodeDueAt` refuses the write
(`apps/cli/src/operations.ts:132`), and `--due-before` refuses the query bound (`:1462`).

Accepted: `YYYY-MM-DD`, optionally `T` or a space plus `hh:mm`, optional `:ss` with fractional seconds,
optional `Z` or `±hh:mm`. Refused: `2026-8-9`, `Aug 9 2026`, `2026-13-45` (the day is round-tripped
through `Date.UTC`), a bare time, a duration, a week — `Date.parse` accepts several of those and none
sorts alongside a padded date. Both overdue queries truncate to `substr(…, 1, 10)` on both sides,
stating the comparison is one of **calendar days** (`apps/cli/src/operations.ts:1473`,
`apps/cli/src/doctor.ts:225`): a task due sometime on the 25th is not late at 09:00 on the 25th.

## Edges: `blocks` and `subtask_of`

The task rel vocabulary is exactly two (`packages/contracts/src/edges.ts:54`), forming their own
`edge_class` — the fourth (`:9`). The class is a firewall: every memory-graph query filters
`edge_class = 'memory'` (`packages/sleep/src/sql.ts:271`, `apps/cli/src/operations.ts:1113`), so task
topology cannot enter PageRank, label propagation, MMR's lateral arm, or the retention bridge count.

```
memhtml link <blocker> blocks <blocked>          # blocker must finish first
memhtml link <child> subtask_of <parent>         # decomposition
```

Both endpoints must be tasks. `requireEndpointClasses` refuses the mismatch in both directions — a
memory rel with a task endpoint, and a task rel with a non-task endpoint — because the store is the only
layer that reads both files' `memhtml-type` (`packages/store/src/store.ts:993`). The SQL CHECK pairs a rel
with its class only and cannot reach the endpoints (`packages/index/migrations/0008_tasks.sql:194-199`).
Provenance is unaffected: a task legitimately came from a session.

`blocks` has two readers — `memhtml task list`'s `blockedBy`, every task asserting `blocks` toward this one
(`apps/cli/src/operations.ts:1492-1495`), and `memhtml doctor`'s `staleBlockers` (`apps/cli/src/doctor.ts:269`).
**`subtask_of` has none**: no surface reports it and `memhtml neighbors` filters to the memory class, so a
decomposition is stored but read back only from the file's `<link>` or the `edges` table.

## Detected tasks: how work enters without `task add`

Four sleep phases each end up holding something a human has to decide and nothing to do with it.
`entity-resolution` has a name pair the model would not settle, `dedup-merge` a near-duplicate its veto
refused, `edge-typing` a contradiction one night short of promotion, `trace-consolidation` a promise
somebody made in a transcript. Before detection each of those was one number in a commit trailer, which
the next night reported identically forever. Now each is a **task file**, written by the phase and
reviewed in that phase's commit (`packages/sleep/src/mint.ts:15-38`).

A minted task is an ordinary `memory_type: task` file. It gets no new type, so it inherits the retrieval
default, the dedup carve-out, the edge-class firewall, and every sleep exclusion already stated on this
page, and `memhtml task status`/`task list`/`link` work on it unchanged.

| Detector | Claim template | Fingerprint |
|---|---|---|
| `entity-resolution` | `confirm: are «<a>» and «<b>» the same <type>?` | `entity:<type>\0<a>\0<b>`, names sorted after normalization (`packages/sleep/src/phases/entity-resolution.ts:510`) |
| `dedup-merge` | `review: <a> and <b> are near-duplicates vetoed for divergence` | `dedup:` over the sorted path pair (`packages/sleep/src/phases/dedup-merge.ts:316`) |
| `edge-typing` | `resolve: <a> and <b> may contradict` | `edge:<a>\0<b>`, paths sorted (`packages/sleep/src/phases/edge-typing.ts:200`) |
| `trace-consolidation` | `commitment: <statement>` | `commit:<normalized statement>` (`packages/sleep/src/phases/trace-consolidation.ts:180`) |

### The finding key is the whole identity

`memhtml-finding-key` is `<detector>:<first 16 hex of sha256(fingerprint)>`
(`packages/sleep/src/mint.ts:174`), and it exists because a task **cannot** be deduplicated by content.
`files_content_hash_active` refuses a second active row with one hash, tasks are carved out of it on
purpose — two open tasks with identical bodies are two work items — and that carve-out leaves a detector
with no way to recognize its own prior work, so a nightly pass over an unchanged corpus would file the
same task every night and nothing in the schema would object
(`packages/index/migrations/0011_finding_key.sql:1-20`).

The key is derived from the **finding**, not from the prose, so rewording a task keeps its key and a
genuinely new finding takes a new one. A fingerprint therefore carries no timestamp, no run id, and no
session id (`packages/sleep/src/mint.ts:110-114`): a commitment restated in a later session is the same
work item, and the pair detectors sort their two endpoints so the fingerprint is a property of the
unordered pair — an orientation that flipped with the file counts would re-file the same question and
leave the old task looking absent.

A malformed value is a **warning, not a violation** (`packages/html/src/parse.ts:175-195`). The two task
metas refuse the file because a task with no position in its own lifecycle is better skipped than indexed
wrongly. A finding key is bookkeeping *about* a task, and refusing the file over a typo would make a task
a human can see in the tree vanish from `task list`. So a bad key parses as absent, projects NULL, and the
worst case is one duplicate task. The meta serializes after `memhtml-due` (`packages/html/src/vocabulary.ts:87`) and
projects to `files.finding_key` straight off the parsed metas, with no second pattern test
(`packages/index/src/project.ts:206-217`).

`files.finding_key` is nullable, unconstrained, and **not unique**: a duplicate key means a detector
filed twice, which is a bug the minting lookup catches and a reviewer declines, and a unique index would
turn that recoverable double-file into a failed sleep phase. Its partial index
`files_finding_key_open` covers `archived = 0 AND memory_type = 'task' AND finding_key IS NOT NULL`, and
one detector's open set is read as an explicit **range** — `finding_key >= '<d>:' AND finding_key <
'<d>;'`, `;` being `:` plus one in ASCII — never `LIKE`, which states the same intent and does not seek
on this driver (`packages/sleep/src/sql.ts:214-255`).

### Detected and authored stay separated

A minted task carries `memhtml-author: agent:sleep` and the tag `detected`
(`packages/sleep/src/mint.ts:59-62`), so the machine's provenance is in the file's own bytes and not only
in a column. `memhtml task list --detected` adds `f.finding_key IS NOT NULL`
(`apps/cli/src/operations.ts:1463`): the presence of a key **is** the predicate, because there is no
boolean column to disagree with it.

### One night may add ten per detector

`MINT_CAP` is 10 new task files per detector per night (`packages/sleep/src/mint.ts:53`). The bound is on
the diff a human reviews, not on the detection: a corpus that produced 400 confirm-this-pair findings is
a corpus problem, and 400 new files in one commit is a night nobody can review and a useless inbox the
morning after. Overflow is counted, not lost, and every submitted finding's key still counts as
*detected* for the night, so the same night's closure pass cannot mistake a capped finding for a vanished
one (`packages/sleep/src/mint.ts:370-393`). Each phase submits in **fingerprint order**, so two nights
over an unchanged corpus write the same ten and the eleventh finding stays eleventh until it is decided
(`packages/sleep/src/phases/entity-resolution.ts:1038-1056`).

Two dedup arms run before the cap. The exact finding key catches a finding restated identically. A
claim-overlap arm — normalized-token Jaccard at 0.6 against every open task of the same detector — catches
the same work item worded differently between two nights, and it is **opt-in**: only
`trace-consolidation` enables it (`packages/sleep/src/phases/trace-consolidation.ts:457-467`), because a
templated claim differs from its siblings only in the slot values, so two distinct pairs sharing one
endpoint measure 0.78-0.90 and the second would be dropped as a restatement
(`packages/sleep/src/mint.ts:64-90`).

### Closure is per detector, because absence means different things

Closing a task is `memhtml-task-status: done` stamped **inside** the archiving `git mv`, so the tree never
holds a task that is archived and still `todo` (`packages/sleep/src/mint.ts:230-234`). No head meta in the
format carries a closure reason, so each phase states it in its own commit — which is where a reviewer
asking why a task disappeared is already reading (`packages/sleep/src/phases/entity-resolution.ts:1134`).

Absence is evidence only from a detector that looked everywhere, so the shared close-by-absence pass runs
only under an attestation the phase computes about its own completeness, and only over tasks still in
`todo`: somebody who moved a task to `doing` or `blocked` owns it now, and a detector going quiet — the
usual reason being that they are mid-fix — is not permission to archive their work item
(`packages/sleep/src/mint.ts:248-264`).

| Detector | How a task closes |
|---|---|
| `entity-resolution` | By absence, when the model pass ran, no batch failed in isolation, and no pair went unasked. The pair merged, left the review band, or its names left the corpus. |
| `dedup-merge` | By absence, and only from the model-bound arm: the deterministic floor cannot see the recall band, so its silence is not evidence. Every cap on the candidate path is a clause of the attestation (`packages/sleep/src/phases/dedup-merge.ts:648-684`). |
| `edge-typing` | **Never by absence** — the candidate scan is capped at 200 pairs, so a pair filed last night is routinely not even offered tonight. An explicit closer asks about each open task's own pair instead: `promoted to edge`, `endpoint gone`, or `evidence gone` (`packages/sleep/src/phases/edge-typing.ts:346-485`). |
| `trace-consolidation` | Only when a resolution says so. Sessions are an unbounded universe: a commitment made last March is absent from tonight's ten-session batch because the batch is ten files, not because anyone did the work (`packages/sleep/src/phases/trace-consolidation.ts:427-433`). |

The edge-typing closer runs on every night the phase runs, including a night with no credentials, because
all three of its arms are a SQL read or a file read. Its `evidence gone` arm — one endpoint's cited quote
no longer occurring in it — is the load-bearing one: editing the flagged text *is* how a contradiction
normally gets fixed, and without that arm the ordinary fix leaves its task open forever. That arm alone
carries the todo-only guard; `promoted` and `endpoint gone` are facts about the tree, so they close a
`doing` task too rather than leaving somebody to resolve a conflict the corpus has already answered
(`packages/sleep/src/phases/edge-typing.ts:366-387`).

### Evidence is quoted, and doctor checks the half it can

File-borne evidence is a `<q cite="/path">` inside a paragraph. **Not `<blockquote>`** — that element is
outside the closed vocabulary, so a task minted with one carries an `unknown:blockquote` warning forever
*and* its quoted text never reaches `article.citations`, which is the projection both the edge-typing
closer and doctor read. The evidence would be unverifiable by the two mechanisms that exist to verify it
(`packages/sleep/src/mint.ts:120-129`). Quotes are cut at a word boundary with **no ellipsis appended**,
because a prefix of the source's collapsed text is contained in it and a prefix plus `…` is not — every
task would otherwise report its own evidence as gone (`packages/sleep/src/phases/edge-typing.ts:150-163`).

Transcript evidence is plain text naming the session, with the same id in `memhtml-session`. A `cite`
holds a repo path that doctor resolves, and a session id is not a path, so stamping one would produce a
citation pointing at nothing and fail on every commitment task forever
(`packages/sleep/src/phases/trace-consolidation.ts:253-265`). Two consequences follow, and both are
accepted rather than hidden: **session-cited quotes are outside doctor's coverage**, and the
consolidator client — the one process with the transcripts mounted — verifies whitespace-normalized
containment and refuses the whole turn on a fabricated quote instead
(`apps/consolidator/src/client.ts:846-935`). A transcript's own due wording reaches the body and never
`memhtml-due`: turning "by Friday" into a date needs a reference clock and a parser this phase does not
have, and a stamped deadline nobody stated is one that retention and `--due-before` would treat as fact.

Restatement noise below the Jaccard floor is the other accepted residual — embedding-based mint dedup
needs a query-embed port sleep's phase environment does not carry, so the bound on it today is
`MINT_CAP` (`.erpaval/specs/007-task-detection/spec.md`).

## The CLI surface

| Command | Arguments and flags | Response type |
|---|---|---|
| `memhtml task add` | `--title`* `--claim` `--body` `--status` `--due` `--workspace` `--tag` `--entity` `--session-id` `--prompt-id` `--turn-uuid` | `task.written` |
| `memhtml task status` | `<path> <status>`, `--reason` | `task.updated` |
| `memhtml task list` | `--status` `--workspace` `--due-before` `--detected` `--limit` `--cursor` `--include-archived` | `task.list` |

Defined at `apps/cli/src/commands.ts:413`, dispatched at `apps/cli/src/run.ts:356`, envelope types at
`apps/cli/src/envelope.ts:40`. `--claim` defaults to `--title` (`apps/cli/src/run.ts:361-363`), and
`--reason` is recorded on the archive commit, so only `done` has one to record.

`memhtml task list` is a **direct indexed scan**, never retrieval: every matching row ordered by path, a
keyset cursor on the last path, `--limit` 50 by default and capped at 500
(`apps/cli/src/operations.ts:1447`). The partial index `files_task_status`
(`WHERE memory_type='task' AND archived=0`) keeps it the size of the open work
(`packages/index/migrations/0008_tasks.sql:139`).

`memhtml link` authors both task rels — `AUTHORABLE_RELS` is the nine memory rels plus the two
(`apps/cli/src/operations.ts:89`) — and `memhtml apply` writes tasks in a batch, a line carrying
`"type":"task"` taking `status` and `due` alongside the ordinary fields (`apps/cli/src/apply.ts:49`).
`memhtml write --type task` reaches the same placement rule and template default, and a hand-written file
under `projects/<ws>/tasks/` satisfying the format is as real as one the CLI wrote.

## What the corpus machinery does not do to a task

- **Retrieval excludes tasks by default.** An unscoped query gets `memory_type <> 'task'`
  (`packages/index/src/scope.ts:121`); a caller-named type list is honored verbatim, so this is a
  default with a reachable opt-in rather than a hidden row (`:109`).
- **Dedup carves tasks out, both directions.** The partial unique index and the write path's lookup
  state one predicate (`packages/index/migrations/0008_tasks.sql:126-127`,
  `packages/index/src/traces-persist.ts:166`), and the store's intra-batch map restates it
  (`packages/store/src/store.ts:316-323`). Two open tasks with identical bodies are two work items, and a
  memory is never deduped onto a task's path.
- **Sleep skips them as INPUT.** `SLEEP_EXCLUDED_TYPES` is stated once (`packages/sleep/src/sql.ts:36`)
  and spread into eight phase sites — dedup-merge, relationship-mining, edge-typing,
  retention-triage, reprieve, compress, confidence-decay, arc-synthesis — plus the two entity queries
  behind person-links and entity-resolution (`:337`, `:357`). Finished tasks need no exclusion: every
  phase's corpus is `archived = 0`. `HALF_LIVES_DAYS.task` is `null`
  (`packages/domain/src/retention.ts:125`). Four phases nonetheless *write* tasks — see "Detected
  tasks" above — and the exclusion is what keeps that from looping: a task sleep minted is never a
  candidate any phase reads back.

## `memhtml doctor`'s task findings

| Finding | What it means | Counts toward `healthy` |
|---|---|---|
| `overdueTasks` | open tasks whose `memhtml-due` day has passed, earliest first | no |
| `staleBlockers` | an open task whose `blocks` blocker is archived or missing | no |
| `staleQuotes` | an open **detected** task whose `<q cite>` evidence is `missing` or `quote-gone` | no |
| `inboxTaskDepth` | open tasks in `areas/inbox/tasks/`, a finding past ten | yes |

All four are **report-only**: `--fix` repairs dangling hrefs and orphan `state.access` rows and nothing
else (`apps/cli/src/doctor.ts:346`). Clearing a stale blocker is an authoring decision — the blocked
task may be genuinely ready, or the blocker archived early — and it is the one task-graph state no
single file reveals, since each file is individually valid and only the pair is wrong (`:261`).

The first three do not affect `healthy` (`:698-712`): they are facts about the work, not defects in the
corpus, and folding them in would make `healthy: false` normal. The task inbox does count, at ten —
half the memory inbox's twenty, because an unplaced memory is a routing rule that stopped matching while
an unplaced task is work nobody owns (`:78`). Doctor is the only surface that reports a *passed*
deadline; `--due-before` reads `due_at` only against a caller-supplied bound.

`staleQuotes` reads the same open-detected-task set the minting kernel does, minus the detector range —
doctor asks about every detector at once, so `finding_key IS NOT NULL` alone is the filter. Both that
clause and `memory_type = 'task'` change the result: a hand-authored task quoting a file is not a
detected finding and its author owns its quotes, and `<q cite>` is a general-purpose element every memory
may use. An **archived** cited file is not a finding, because eviction is a `git mv` that preserves the
bytes, so the quote is still verifiable; the chase uses the same `archivedFormOf` `--fix` uses on a
dangling href, and only a path with no file anywhere is `missing`. `citedPath` is reported verbatim as
the task wrote it, since the operator's next move is to open the task and read those bytes
(`apps/cli/src/doctor.ts:400-433`). Repair is refused for both of the usual reasons: doctor cannot
re-derive a quote it did not mint, and whether the finding survived the edit is a judgement. The
ordinary way a stale quote appears is a human editing the very text a detector flagged — which is the
finding being resolved, so `healthy: false` would punish the fix.

## MCP status: read and create, never advance

The toolkit is fourteen tools and none is a task tool (`apps/mcp/src/tools.ts:774`).

- `memory_write` takes `memory_type: "task"` — the enum derives from `WRITABLE_MEMORY_TYPES` (`:45`).
  There is no `status` or `due` field in the write parameters (`:237-246`), so a task authored over MCP
  opens in `todo` with no deadline.
- `memory_list` filters `memory_type: "task"` and `memory_search` opts in through
  `memory_types: ["task"]` (`:650`, `:444`). `memory_recall` takes no type parameter at all (`:514-518`), so
  over MCP a task is unreachable through recall with no opt-in available.
- `memory_link`'s `rel` is `MemoryRelSchema`, the nine memory rels, so a task rel is refused at
  **decode** (`:578`). The task graph is authored from the CLI: asserting `blocks` is planning.
- **No status transition and no archive-on-done.** `memory_archive` moves a task into the archive
  without touching `task_status`, leaving a `todo` file under `archive/`.

## Worked sequence

```bash
W=projects/checkout-api/tasks
memhtml task add --title "Wire the drain step into the runbook" --workspace checkout-api \
             --due 2026-08-20 --body "The runbook says revert first."   # → $W/…-runbook.html, todo
memhtml task add --title "Land the target-group migration" --workspace checkout-api
memhtml link $W/land-the-target-group-migration.html blocks $W/wire-the-drain-step-into-the-runbook.html

memhtml task list --workspace checkout-api        # both, with blockedBy filled in
memhtml task list --due-before 2026-08-21         # by calendar day, strictly before
memhtml task list --detected                      # only what sleep minted, both of these excluded

memhtml task status $W/land-the-target-group-migration.html done --reason "landed with the drain fix"
# → archive/2026/projects/checkout-api/tasks/land-the-target-group-migration.html

memhtml doctor    # staleBlockers: the runbook task waits on an archived blocker. Report-only, because
              # whether it is now ready is a judgement `--fix` cannot make.
              # staleQuotes would name a detected task whose cited evidence somebody has since edited.
```

`ls projects/checkout-api/tasks/` answers the same listing question with no binary at all, which is
the point.
