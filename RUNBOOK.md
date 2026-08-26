# RUNBOOK — operating `memhtml`

Environment, daily operation, the concurrency rules, and recovery.

Every command writes exactly ONE JSON envelope to stdout and logs to stderr, so every line below is safe to pipe into `jq` and safe to run from cron. Exit 0 success, 2 usage, 1 runtime (`apps/cli/src/envelope.ts:92`). `memhtml manifest` is the authoritative command surface and answers on a machine with no repo, no database, and no credentials.

Two things a cron line needs from that contract. A failed or aborted `memhtml sleep run` exits 1 while still writing its full `sleep.report` success envelope, so the exit code alone is enough to alert on (§7). And there is no `--json` flag to pass: the typed envelope is the only output the binary has, on every command.

---

## 1. Environment

| Variable                   | Default     | Meaning                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMHTML_ROOT`             | `~/memhtml` | The memory repo. A leading `~` is expanded — this value arrives from a shell profile, an MCP client config, and a cron line, and only the shell expands tildes.                                                                                                                                                                                                                        |
| `MEMHTML_TRACE_ROOT`       | `~/.claude` | Where `memhtml trace index` reads transcripts. Read-only; never written.                                                                                                                                                                                                                                                                                                               |
| `MEMHTML_AWS_REGION`       | `us-east-1` | Bedrock region for embeddings and for every sleep phase in `LLM_PHASES` — eight as of v0.6.0 (`packages/sleep/src/contract.ts:168`).                                                                                                                                                                                                                                                   |
| `AWS_BEARER_TOKEN_BEDROCK` | —           | Read by the AWS SDK itself. Absent means the default credential chain; retrieval degrades to the lexical floor rather than failing.                                                                                                                                                                                                                                                    |
| `MEMHTML_EMBED`            | `on`        | `off` disables the embedder entirely. Distinct from a missing credential: a missing credential degrades one search at call time, `off` degrades every search.                                                                                                                                                                                                                          |
| `MEMHTML_LLM`              | `on`        | `off` makes every phase in `LLM_PHASES` report `no model bound` and `trace-consolidation` report `no consolidator bound`, all staying `ok`. `dedup-merge` and `entity-resolution` still do real deterministic work without a model; the rest report a reason and write nothing.                                                                                                        |
| `MEMHTML_EXTRACT_ENTITIES` | `off`       | `on` adds one model call per write batch that extracts `memhtml-entity` metas the ops did not declare (`apps/cli/src/config.ts:62`). Opt-in, unlike `MEMHTML_EMBED`, because it changes what a write STORES: extracted entities land in the files as if authored. The write never waits on or fails with the model — a failed extraction is a logged warning and an unextracted batch. |
| `MEMHTML_MCP_BIN`          | —           | An explicit path to the `memhtml-mcp` entry point, read only by the serve supervisor (`apps/cli/src/serve.ts:58`). Absent means the sibling-path default, since the two apps ship as one build. Set it for a split deployment; it locates the server rather than configuring the store.                                                                                                |

These eight are declared in `apps/cli/src/config.ts:26` and are what `memhtml manifest` reports. `MEMHTML_EMBED` and `MEMHTML_LLM` compare case-insensitively against `off` (`apps/cli/src/api-layer.ts:250`, `apps/cli/src/api-layer.ts:313`). `MEMHTML_MCP_BIN` is the one that configures no store behavior at all, and it is disclosed anyway: an operator debugging a split deployment reads the manifest, and a variable the binary reads but does not declare is one they cannot discover. `--repo <path>` overrides `MEMHTML_ROOT` per call.

### The database

`index.db` and `state.db` are plain SQLite, opened through node's built-in `node:sqlite` — there is no third-party database dependency and no driver flags to keep in step. `sqlite3`, a GUI browser, or any other tool opens both files directly, which is what makes a stuck index inspectable without this binary.

Each connection sets `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`, and `synchronous = NORMAL`, and registers one SQL function, `vector_distance_cos` (`packages/index/src/database.ts`). WAL is a persistent property of the file rather than of the connection, so a store created by any caller ends up in the same mode. `NORMAL` synchronous can cost the last commits on power loss, which for a projection rebuildable from the git tree is not a durability question.

---

## 2. Initializing a store

```bash
export MEMHTML_ROOT=~/memhtml
memhtml init
memhtml index rebuild --embed
```

`memhtml init` is convergent: each step asks the repo what is already true and supplies only what is missing, so it reaches the same end state from an empty directory, from a fully scaffolded repo, and from one left half-initialized by an interrupted run (`packages/store/src/layout.ts:183`).

**A git identity is a precondition, and its absence surfaces as `ERR_GIT` exit 128.** `memhtml init` commits the scaffold, and `git commit` refuses without one — so on a fresh container, a CI runner, or any sandbox with no `~/.gitconfig`, the very first command fails with `git commit failed (exit 128)` while git's own "Please tell me who you are" goes to stderr. Nothing is lost: `init` is convergent, so setting an identity and re-running carries the staged scaffold to a commit. Either configure it:

```bash
git config --global user.name "You"
git config --global user.email "you@example.com"
```

or supply it per-process, which needs no repository and no config file and is what an unattended agent should prefer:

```bash
export GIT_AUTHOR_NAME="memhtml" GIT_AUTHOR_EMAIL="memhtml@localhost"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
```

**`memhtml init` is required on a fresh clone.** `.gitattributes` marks `index.html` and `sitemap.xml` `merge=ours`, and that attribute is INERT without the `merge.ours.driver` config (`packages/store/src/layout.ts:76`). Git config is per-clone and is not cloned, so a clone that skips `memhtml init` gets conflict markers written into a generated file on the first merge touching one. Verify with `git -C "$MEMHTML_ROOT" config --get merge.ours.driver`; it must print `true`.

`.memhtml/index.db` and `.memhtml/state.db` are both gitignored (`packages/store/src/layout.ts:55`). A clone carries the TREE plus `.memhtml/state/access.jsonl`, which is why `memhtml state import` is a step and not an optimization: without it the salience retrieval arm has no signal and ranking is silently poorer rather than broken.

---

## 3. Daily operation

```bash
memhtml write --title "One writer and many readers share the index" --type semantic \
  --claim "WAL admits a single writer at a time and any number of concurrent readers."
memhtml apply --file ops.jsonl        # many memories, ONE commit, ONE index pass
memhtml search "one writer many readers"
memhtml recall "one writer many readers" --budget 16000
memhtml read areas/inbox/some-memory.html
memhtml list --type semantic --limit 50
```

Reach for `memhtml apply` past about three memories in one task: a batch stages every file, makes one commit, and reindexes once, where N writes make N commits and pay N index passes. Atomic by default; `--continue-on-error` is best-effort. Both read stdin when `--file` is omitted or is `-`.

Nothing is deleted. `memhtml correct <target>` writes the superseding file and archives the target in one commit; `memhtml archive <path> --reason ...` is a `git mv` into `archive/<YYYY>/`. Pass `--include-archived` to see evicted memories. `memhtml reinforce <path>` bumps access bookkeeping under a 900-second per-path cooldown (`packages/domain/src/ranking.ts:17`), so a loop reinforcing one path records one bump.

**What moves the access plane, if you are debugging a salience number.** `memhtml read <path>` and `memory_read` bump it — an explicit open is a chosen memory — and so does the `memhtml://file/{path}` MCP resource, which funnels through the same use case. `memhtml search` and `memhtml recall` do NOT, however many paths they return, and neither does a sleep phase: those are the ranker's guess and the schedule's sweep, and counting either makes the ranking teach itself. So a corpus that has been searched all day and never read has an empty `state.access`, and that is correct rather than a bug. `memhtml reinforce --signal positive|negative` is the explicit channel and is the only thing that moves the outcome EWMA. The salience arm also ignores `task` rows and anything under `resources/people/` entirely, so their access counts exist but never affect a rank.

Working-tree edits are legitimate too: `memhtml index update` projects uncommitted changes as well as committed ones, so a hand-edited file is searchable before you commit it — but you own the commit, and `memhtml sleep run` refuses on a dirty tree.

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed >> /var/log/memhtml/index.log 2>&1
17 * * * *    cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml trace index      >> /var/log/memhtml/trace.log 2>&1
30 3 * * *    cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml sleep run        >> /var/log/memhtml/sleep.log 2>&1
0 6 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml publish         >> /var/log/memhtml/publish.log 2>&1
0 7 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml doctor          >> /var/log/memhtml/doctor.log 2>&1
```

Each is idempotent: an unchanged HEAD and a clean tree touch nothing. `memhtml sleep merge` is deliberately NOT on the cron — a run rewrites confidence across the corpus and archives memories, so the branch exists for a human to read `memhtml sleep review` first.

---

## 4. The MCP server, and sharing a store

```bash
memhtml serve mcp
MEMHTML_MCP_BIN=/path/to/bin.js memhtml serve mcp   # explicit path, for a split deployment
```

15 tools and 3 resources over this same repo (`apps/mcp/src/tools.ts`). Sleep is deliberately absent from the tool surface: it is a cron and operator action producing a reviewable branch, not something an agent triggers mid-conversation.

**A CLI command and a running server can share one repo.** WAL admits one writer at a time and any number of concurrent readers: readers never block the writer, a second writer waits rather than failing, and a wait that outlives `busy_timeout` is retried with jittered exponential backoff for up to 20 seconds (`packages/index/src/database.ts`). So `memhtml write` while `memhtml serve mcp` is serving the same store is a supported thing to do, and so is the every-10-minutes `index update` cron. Measure it yourself with `node scripts/probe-sqlite-concurrency.mjs`.

Retrying is safe because the error being retried is `SQLITE_BUSY` specifically — the lock was never taken, so the statement had no effect to half-apply. A write inside a transaction rolls back before the retry, so the transaction re-runs whole rather than resuming.

What still needs one writer is `memhtml sleep run`, for a reason that is about git rather than the database: a run holds a checked-out `sleep/<date>` branch, so a concurrent write commits ONTO that branch and is either merged as if it were curation or lost with `git branch -D`. Quiesce writes for the duration of a run.

`memhtml serve mcp` holds no database of its own — it spawns `memhtml-mcp` with inherited stdio and waits (`apps/cli/src/serve.ts:87`), so the supervisor has no handle to conflict with the child. Interrupting it kills the child, so Ctrl-C never leaves an orphaned server holding the database open (`apps/cli/src/serve.ts:108`).

The one exception is `memhtml eval discriminate`, which never builds the app layer (`apps/cli/src/run.ts:891`): it measures the ranking stack against its own generated fixture corpus in a temp directory with an in-memory database and never reads your `index.db`. Deliberate — checking the gate is exactly what an operator wants while the server is up.

---

## 5. The index, and when to rebuild

```bash
memhtml index update --embed     # only what moved since the watermark, plus the dirty tree
memhtml index rebuild --embed    # the whole tree at HEAD
memhtml index status             # watermark, vector space, per-table row counts
```

`--no-embed` turns either off and makes the pass instant. Closing a store-wide embed gap afterwards is `rebuild --embed`'s job: `update --embed` embeds only its own batch's chunks (the pending scan is scoped to them — an unscoped scan was the last store-scaled per-batch cost). Vectors key on content hash either way, so a `git mv` issues zero Bedrock calls.

`update` is the daily verb. Reach for `rebuild` when the database file is gone or unopenable, when a migration adds a column the projection must recompute, or after fixing files doctor reported `unparseable`. `update` with no recorded watermark falls through to a rebuild on its own (`packages/index/src/indexer.ts:565`), so a deleted database mostly handles itself. A rebuild drops the FTS index, deletes every memory table, reprojects, and recreates the index (`packages/index/src/indexer.ts:389`); it destroys nothing outside `.memhtml/` and touches neither the trace tables nor the attached state plane.

**A vector-space mismatch is a hard refusal, and a rebuild alone does not clear it.** Both `rebuild` and `update` call `guardEmbedModel()` before any write (`packages/index/src/indexer.ts:241`), so an index built under one embedding model can never accumulate rows under another: you get `ERR_EMBED_MODEL_MISMATCH` naming the stored space and the configured one. Delete the database and rebuild into the configured space:

```bash
memhtml status                                     # read embedModel and embedderUp
rm "$MEMHTML_ROOT"/.memhtml/index.db "$MEMHTML_ROOT"/.memhtml/index.db-*
memhtml index rebuild --embed
```

Nothing in the tree is at risk, and `state.db` is a separate file this does not touch.

---

## 6. The state plane

```bash
memhtml state export      # write .memhtml/state/access.jsonl and commit it
memhtml state import      # replay the sidecar into state.db
```

`state.db` is gitignored and NOT rebuildable from git — access counts, reinforcement counts, and the outcome EWMA are the one set of facts the tree cannot reproduce. The committed sidecar is what survives (`apps/cli/src/state.ts:54`). The export is byte-stable, so an unchanged plane produces an identical file and commits nothing. The import upserts with `max()` on the monotone counters rather than truncating, so importing onto a live plane cannot discard counters the sidecar predates (`apps/cli/src/state.ts:131`); an unparseable sidecar line is counted in `skipped` and never fatal. Sleep runs `state-export` as its penultimate phase, so the sidecar refreshes once per night regardless of query volume — run it by hand before a machine goes away.

### Multi-machine: `access.jsonl` is last-writer-wins

Two machines both committing is the conflict path git handles. The state plane is different: `.memhtml/state/access.jsonl` is a whole-file merge, so two machines' access counts do not combine — the later commit wins and the other machine's reads are lost. `memhtml state import` merging by max makes an IMPORT non-destructive; the FILE merge is still last-writer-wins.

Mitigation today is one writer: a second machine that reads the repo should `memhtml state import` and never `memhtml state export`. Detection is an access count that goes DOWN across a pull, and nothing alarms on it. Making the counters merge-commutative — max-of, or per-machine sub-counters summed — is the prerequisite for real multi-machine use.

---

## 7. Sleep

```bash
memhtml sleep run                       # every phase of SLEEP_PHASES, each its own commit on sleep/<date>
memhtml sleep run --dry-run             # per-phase counts, no branch, no commits
memhtml sleep run --phases preflight,dedup-merge,integrity
memhtml sleep run --deep --max-llm-calls 400   # the deep cycle, with the extra model spend capped
memhtml sleep status                    # the latest run and its per-phase outcomes
memhtml sleep review <run-id> [--diff]
memhtml sleep resume <run-id>
memhtml sleep merge <run-id>
```

The phases in order, seventeen as of v0.6.0: `preflight`, `dedup-merge`, `entity-resolution`, `person-links`, `relationship-mining`, `edge-typing`, `confidence-decay`, `arc-synthesis`, `retention-triage`, `compress`, `reprieve`, `trace-consolidation`, `task-detection`, `placement-triage`, `integrity`, `state-export`, `report` (`packages/sleep/src/contract.ts:43`). Fifteen of them commit; `preflight` and `relationship-mining` are the two that cannot (`packages/sleep/src/contract.ts:197`). The branch is created BEFORE any phase runs and every commit lands on it, so `main` is never touched by a run (`packages/sleep/src/run.ts:96`). A second run on the same date takes `sleep/<date>-2` and upward (`packages/sleep/src/run.ts:45`). A dry run creates no branch. A real run leaves you checked out on the sleep branch; `memhtml sleep merge` checks out the target itself.

`placement-triage` is deep-only. Without `--deep` it returns immediately, writes nothing, and commits nothing, so a default run behaves exactly as it does without the phase in the list (`packages/sleep/src/contract.ts:33`). `--deep` mines a lower grouping band, groups by shared entity, re-files inbox singletons, and iterates `compress` until a pass folds nothing; `--max-llm-calls` caps what the deep mechanisms may spend across all of them, and exhaustion skips the remaining batches with reason `budget` while the run stays green.

**A run with any failed phase exits 1**, and the envelope it writes is still the `sleep.report` SUCCESS envelope carrying the whole per-phase report (`apps/cli/src/run.ts:284`). Both halves are deliberate: a cron line reading only the exit code has to see that the curation did not happen, and a failure envelope carries no `data`, so reporting one would throw away the detail saying which phases landed. A fully aborted run and a partially failed one exit the same, because a caller reading the exit code is asking one question and both answers are no — the payload distinguishes them precisely, since an abort is every selected phase `failed` with `headSha === baseSha` and no commits. `sleep status` and `sleep review` are exempt: they report a run they did not perform, and a read that exited non-zero because its subject failed would make "tell me what happened" indistinguishable from "I could not tell you".

`review`'s per-file classification is the substance, because `git diff --stat` says a file changed by two lines and says nothing about whether those lines were a confidence stamp or the memory's claim. It compares the two versions' ARTICLE content hashes (`packages/sleep/src/review.ts:170`): `meta-only` is a decay stamp, link promotion, or reprieve extension and is skippable; `body-changed` means the claim moved, so read these; `archived` is an eviction, reaching the tree as a `git mv` into `archive/<YYYY>/`; `created` is a new file, usually a synthesized arc or a compress canonical.

### A failed phase is not a failed run

Every phase is its own commit and a failure is caught as a VALUE: the phase records `failed`, the phases after it still run, and every prior commit stays on the branch (`packages/sleep/src/run.ts:231`). A failed phase's staged files are unstaged so the next phase's commit carries no half-finished work. The exceptions are the declared hard prerequisites (`packages/sleep/src/contract.ts:107`), and there are two.

**`preflight` gates the WHOLE run: every one of the sixteen phases after it is skipped when it fails, so a failed preflight commits nothing.** It establishes the three preconditions the rest of the night reads, and each of its failures makes every later commit wrong rather than merely unhelpful. A dirty tree means a later phase stages and commits the operator's uncommitted bytes under sleep's own trailers. An embed-model mismatch is a half-migrated vector space, which degrades every cosine in the run while each individual vector stays well-formed, so dedup, mining, and conflict detection all come back plausible and wrong. A stale index is one a rebuild emptied and did not finish repopulating, and every later phase reads it, so their counts describe a corpus fragment. All three end in the one outcome per-phase isolation is no defense against: a corrupt night with a green report.

`dedup-merge` is the narrow one: failing it SKIPS `compress` and `retention-triage`, both of which operate on the post-merge set. That is also why `dedup-merge` isolates each of its model calls instead of failing on one — a batch whose call comes back malformed is counted and skipped, so a single bad tool payload cannot take two later phases down with it.

`git branch -D <run-id>` is the abort, and `main` never moved. Resume with `memhtml sleep resume <run-id>`, which reads the branch's own `Memhtml-Phase` commit trailers rather than a journal table — the commit is the fact, so a process killed after `git commit` and before the row write resumes correctly (`packages/sleep/src/run.ts:146`).

### What `git branch -D` discards

Deleting the branch discards everything the run decided, and that now includes the run's writes into the state plane. `.memhtml/state.db` is not rebuildable from the tree, so a row written DURING a phase would outlive the branch that earned it — and for the consolidation watermark that is data loss rather than bookkeeping, because the watermark is an anti-join: a session it covers is never selected again, and the transcript would be gone with a row asserting it was handled.

So three phases record their non-undoable writes as marks in a committed ledger instead of performing them. `trace-consolidation` records a session watermark, `edge-typing` an edge promotion, `entity-resolution` an entity promotion, each as one JSONL line in `.memhtml/sleep/<run-id>.pending.jsonl` on the run's own branch (`packages/sleep/src/contract.ts:306`, `packages/sleep/src/contract.ts:351`). `memhtml sleep merge` reads that ledger as a blob at the BRANCH TIP — what earns a write is what the branch committed, so an uncommitted file a discarded run of the same date left behind is exactly the mark this design refuses to apply — and applies the marks after the fast-forward succeeds (`packages/sleep/src/review.ts:344`).

The practical consequence for an operator: aborting a reviewed-and-rejected night costs a re-read, not a loss. The sessions it covered stay unconsolidated and come back on the next cycle at the price of one model call, and the entity and edge pairs it proposed stay re-eligible. Corroboration counters deliberately stay at phase time rather than joining the ledger, because `detections` counts nights on which a model read the corpus and proposed the merge — and a discarded night did both.

`marksPending` and `marksApplied` on the merge report are two numbers rather than one, and they answer different questions: what the branch earned, and what the plane took (`packages/sleep/src/contract.ts:272`). They agree on an ordinary merge, so a shortfall is the operator-visible reading of a plane write that did not land, and the sessions in it are re-read next cycle. A failed apply does NOT fail the merge: `main` has already moved and the memories are landed, so the shortfall is reported and logged rather than reported as a merge that failed over a `main` that moved.

### When trace-consolidation distills nothing

Phase 12 hands unread session transcripts to the consolidator agent and commits one memory per candidate that clears the bar. It reports `ok` in four different situations, and the `detail` is what tells them apart:

| `detail`                                            | Meaning                                                                                                  | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no consolidator bound`                             | `MEMHTML_LLM=off`, or no Bedrock credentials in the environment. The phase was never able to run.        | Nothing, if that was intended. Otherwise export `AWS_BEARER_TOKEN_BEDROCK` (or the SigV4 pair).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `consolidator unavailable: ConsolidatorUnavailable` | The agent server could not be built, started, or reached. Usually its output is missing.                 | **From a checkout**: `pnpm --filter @memhtml/consolidator build:agent`. That build is deliberately outside the turbo graph, so a fresh clone has not run it. **From an installed package**: nothing to run — the first consolidation builds the agent into `~/.cache/memhtml/eve/<version>/` itself and reports this only if that build fails, so read the `reason`, which carries eve's own stderr. Never build it inside `node_modules`: nitro externalizes what it resolves there and the server exits 13 on an unsettled top-level await (`apps/consolidator/src/agent-build.ts`). |
| `consolidator unavailable: ConsolidatorRunFailed`   | The turn reached the model and came back with nothing usable — a throttle, a timeout, an unentitled key. | Re-run. No session was watermarked, so nothing was lost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| absent, with `candidates: 0`                        | The agent read the batch and found nothing above the bar. **A successful night.**                        | Nothing. The sessions are watermarked and will not be re-read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The distinction matters because only the last one means the transcripts have been dealt with. Read `counts.batch` to see how many sessions were handed over and `counts.consolidated` for how many were watermarked: a failed call leaves `consolidated: 0` with `batch` nonzero, which is the shape that says "these transcripts are still waiting".

A run takes at most 10 sessions, newest first, skipping transcripts under 8 KiB and any modified within an hour of the run's instant (`packages/sleep/src/phases/trace-consolidation.ts:64`). So a first run over a year of history is an increment, not a stampede — it consolidates the ten most recent sessions and works backwards a batch per night.

Each commit's body carries the evidence quotes the claim rests on, which is the reviewable receipt; the memory itself carries only the distilled claim, because `.memhtml` holds no session content. A commit whose subject reads `distill (frame conflict) …` means the new claim occupies the same frame slot as a live memory, named in the body — the phase writes it anyway and reports the conflict, because sometimes the contradiction is the answer.

### When the merge refuses

The refusal is a value on the report, never an error (`packages/sleep/src/contract.ts:265-286`, `packages/sleep/src/review.ts:220-296`).

| `refusal`       | Meaning                                                                                                                                         | What to do                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `no-run`        | No such run id.                                                                                                                                 | `memhtml sleep status`.                                                                  |
| `main-advanced` | `main` moved past the run's `base_sha`, so the run curated a corpus that no longer exists. Also the refusal when the fast-forward itself fails. | Re-run the sleep. Every phase is idempotent, so it is cheap.                             |
| `gate-failed`   | The discrimination gate refused: this run degrades retrieval.                                                                                   | `memhtml eval discriminate` to see which probes inverted, then `git branch -D <run-id>`. |

`--skip-gate` merges without re-running discrimination and logs a warning (`apps/cli/src/run.ts:617-620`) — a deliberate override, never a default. The gate always runs in FAKE mode (`apps/cli/src/run.ts:641`), precisely so a unattended merge is not conditional on a token being valid whenever the run fires.

---

## 8. The discrimination gate

```bash
memhtml eval discriminate                       # fake mode: deterministic, no credentials
memhtml eval discriminate --mode live           # the same probes against Bedrock's vector space
memhtml eval discriminate --seed 20260802 --size 200 --probes 36 --mrr-floor 0.85
```

Every probe must outrank its own wrong-fact twins. The default MRR floor is `0.85` (`packages/eval/src/discriminate.ts:103`); lowering it is a deliberate, visible choice. A failing run is reproducible from its `seed`. **Exit 1 with `ERR_DISCRIMINATION_FAILED` on a failed gate** — a refusable gate that exited 0 and left the verdict in the payload is one every shell caller forgets to read.

`fake` is what CI measures and a pass there is a real pass. `live` WITHOUT `AWS_BEARER_TOKEN_BEDROCK` reports `mode: "live"`, `requested: "live"`, `skipped: true`, zero probes, `passed: false`, and a loud `logError` (`packages/eval/src/run.ts:85`). **If you see `skipped: true`, nothing was measured** — a skipped quality gate must never look like a passing one. Re-run with credentials, or run `--mode fake`.

---

## 9. Doctor and publish

```bash
memhtml doctor          # eight checks
memhtml doctor --fix    # repairs the two that need no judgement call
memhtml publish         # regenerate index.html listings and sitemap.xml, and commit
```

| Finding                    | Meaning                                                                                            | Fix                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `dangling`                 | A `<link>` points at a path the tree does not hold.                                                | `--fix` rewrites it to the archive path, or drops it when the target is gone.                                          |
| `orphanAccessRows`         | A `state.access` row whose path left the tree.                                                     | `--fix` prunes it.                                                                                                     |
| `inboxCrowded`             | Over 20 active memories in `areas/inbox/`: the placement rules stopped matching what agents write. | Re-place them, or revisit the rules.                                                                                   |
| `inboxTasksCrowded`        | Over 10 open tasks in `areas/inbox/tasks/`: work with no project.                                  | Drain it. A task inbox is meant to be drained, not accumulated.                                                        |
| `overdueTasks`             | An open task whose `memhtml-due` has passed.                                                       | Doctor is the ONLY surface reading `due_at` — a task is default-excluded from search and skipped by every sleep phase. |
| `staleBlockers`            | A `blocks` edge whose blocker is archived or absent.                                               | Decide whether the blocked task is ready. Each file alone is valid; only the pair is wrong.                            |
| `warnings`                 | An element outside the closed vocabulary. The file still indexes.                                  | Author's intent — doctor will not guess.                                                                               |
| `unparseable`              | A file the parser refuses. It is NOT in the index.                                                 | Read the violations with `memhtml read <path>`.                                                                        |
| `indexFresh: false`        | The index describes an older commit.                                                               | `memhtml index update --embed`.                                                                                        |
| `embedModelMatches: false` | Stored vectors are in a different space from the configured one.                                   | §5 — delete the database and rebuild.                                                                                  |

Thresholds are `INBOX_WARN_DEPTH` 20 and `INBOX_TASK_WARN_DEPTH` 10 (`apps/cli/src/doctor.ts:69`, `apps/cli/src/doctor.ts:78`). `--fix` reuses the sleep integrity phase's byte-splicing repair logic rather than a second implementation, because a repair routed through the serializer would move the content hash of every file it touched.

**Read `repaired.failedWrites` before believing a `--fix` run.** The report is `repaired: { rewritten, dropped, failedWrites, prunedAccessRows, commitSha }` (`apps/cli/src/doctor.ts:156`), and a repair whose write failed lands in `failedWrites` naming the source path: it is NOT counted under `rewritten` and it is never staged, because staging the unchanged file would commit the pre-repair bytes under a message claiming a repair. So a path in `failedWrites` is still a live finding and the next `memhtml doctor` reports it again — usually a permissions or disk problem on that one file, which is worth fixing before re-running. `memhtml publish` is deterministic to the byte, so two runs over an unchanged corpus write nothing and commit nothing (`apps/cli/src/publish.ts:10`); it is also the resolution for a `merge=ours` conflict in a generated artifact — regenerate rather than hand-edit.

---

## 10. Traces

```bash
memhtml trace index                       # scan $MEMHTML_TRACE_ROOT for Claude Code transcripts
memhtml trace search "some prompt text"
memhtml trace links --session-id <id>
memhtml trace links --path areas/inbox/some-memory.html
```

The scan reads only what changed, against a size + mtime + byte-offset watermark (`packages/traces/src/watermark.ts:66`), so an unchanged corpus reads zero bytes rather than re-walking the tree. Both size and mtime must match to skip: size alone would miss an in-place rewrite. `$MEMHTML_TRACE_ROOT` is read-only and never written.

**The report accounts for every file the scan planned to read**, and the identity is `skipped + tailed + rescanned + filesFailed` (`apps/cli/src/operations.ts:1781`, `packages/traces/src/scan.ts:65`). A file the scan could not read is therefore visible as `filesFailed` rather than absorbed into a smaller-looking sweep — a transcript being rewritten under the scan, or one whose permissions changed, shows up here and is simply re-read next run. `sessionsWritten` answers a different question and is not a fourth term of that identity: it counts the files for which a `traces` row was actually written, so a run can tail a file and write no row, and comparing the two is how you tell "read the bytes" from "indexed the session". `memhtml trace search` is FTS over session first-prompts and AI titles and never enters memory retrieval. `memhtml trace links` with neither `--session-id` nor `--path` is a refusal, not a scan of the whole table (`apps/cli/src/operations.ts:1671`). The trace tables are never touched by a memory rebuild (`packages/index/src/schema-const.ts:59`), so a rebuild does not cost a re-walk of `~/.claude`.

---

## 11. Diagnosing retrieval

```bash
memhtml status           # HEAD, dirty paths, counts by type, edges, index freshness, embedder state
memhtml index status     # the watermark, the vector space, per-table row counts
memhtml doctor
```

- `indexFresh: false` → `memhtml index update --embed`. The index describes a commit; "fresh" means that commit is HEAD (`apps/cli/src/operations.ts:1729`).
- `embedderUp: false` → the stored watermark disagrees with the configured model, or there are zero vectors (`apps/cli/src/operations.ts:1733`). Read off the stored watermark rather than by probing Bedrock, so it never fails for a reason unrelated to the corpus.
- `degraded: true` on a search response → the query embedder returned nothing. Search still works on the lexical floor; check `MEMHTML_AWS_REGION` and the Bedrock credential.
- Quality feels wrong but nothing errors → `memhtml eval discriminate`. That is what it is for.

**A search should never error instead of returning nothing.** Query text goes through `sanitizeFtsQuery` before it reaches MATCH (`packages/index/src/fts-query.ts:41`), because several forms common in prose are hard driver errors rather than empty results: an apostrophe (`don't`), a `type:name` entity reference (`service:checkout-api`), and a leading hyphen, which FTS reads as negation. A query that errors means the sanitizer was bypassed — a bug, not a configuration problem.

**The tree is dirty and sleep refuses.** Preflight calls `requireCleanTree()` (`packages/sleep/src/phases/preflight.ts:22`) and fails with `ERR_DIRTY_TREE` listing the paths: a phase reading the index while the tree holds uncommitted edits would curate a corpus nobody has. The refusal lands in phase one, so it costs nothing. Inspect with `git -C "$MEMHTML_ROOT" status --porcelain`, run `memhtml index update --embed` (the indexer DOES read dirty paths), then commit or stash and re-run.

**Error codes**: `ERR_UNKNOWN_COMMAND`, `ERR_MISSING_ARGUMENT`, `ERR_INVALID_FLAG`, `ERR_UNEXPECTED_ARGUMENT`, `ERR_PATH_NOT_FOUND`, `ERR_INVALID_MEMORY`, `ERR_DUPLICATE_CONTENT`, `ERR_WRITE_CONFLICT`, `ERR_DIRTY_TREE`, `ERR_INDEX_STALE`, `ERR_EMBED_MODEL_MISMATCH`, `ERR_MODEL_UNAVAILABLE`, `ERR_STORAGE`, `ERR_GIT`, `ERR_DISCRIMINATION_FAILED`, `ERR_UNKNOWN` (`apps/cli/src/envelope.ts:67`). Branch on `code`, never on the `error` prose. Most failures carry `suggestions`, which are commands you can run (`apps/cli/src/errors.ts:136`). Every `memhtml …` suggestion is checked against the command table by the suite, so a renamed command cannot leave a suggestion naming a command that no longer exists.

Three of those codes come from the usage surface and are worth reading precisely, because each names a different fix. `ERR_INVALID_FLAG` on a flag that exists elsewhere means the flag is real but not on THIS command — flags are validated against the command's own spec plus the two globals, never the union, so `memhtml list --status todo` is refused rather than answered unfiltered, and the suggestions name the commands that do take it (`apps/cli/src/run.ts:989`). `ERR_UNEXPECTED_ARGUMENT` is a positional past what the command declares, so the fix is dropping a word rather than adding one (`apps/cli/src/run.ts:950`). And `--as-of` outside the `YYYY-MM-DD` / `YYYY-MM-DDThh:mm:ssZ` grammar is `ERR_INVALID_FLAG` at exit 2 before any service is built, because the value is compared as TEXT in SQL and an unsortable one selects a different window rather than failing (`apps/cli/src/run.ts:892`).

**An occupied explicit `--path` is `ERR_WRITE_CONFLICT`, and nothing is written or committed.** Nothing in this corpus is overwritten, and an explicit path gets no `-2` collision suffix either, so the recovery is `memhtml correct <path>` — which writes the superseding memory and archives what it replaces in one commit (`apps/cli/src/errors.ts:147`).

**`ERR_INDEX_STALE` has exactly one recovery: `memhtml index rebuild`.** `memhtml index update` is what RAISES the tag — it refuses a watermark row with no commit on it rather than diffing from nothing — so a rebuild is the one call that repopulates the tables an interrupted pass left partial (`packages/index/src/indexer.ts:609`, `apps/cli/src/errors.ts:158`).

---

## 12. Disaster recovery

Losing `.memhtml/` costs nothing but time, provided the tree and the sidecar are pushed.

```bash
git clone <remote> ~/memhtml
cd ~/memhtml
export MEMHTML_ROOT=~/memhtml

memhtml init                      # re-set merge.ours.driver — per-clone, not cloned
memhtml state import              # restore the access plane from .memhtml/state/access.jsonl
memhtml index rebuild --embed     # reproject the tree

memhtml status                    # indexFresh true, embedderUp true, counts match the tree
memhtml doctor                    # expect healthy
memhtml eval discriminate         # expect passed true
```

Order matters: `memhtml init` first because the merge driver is per-clone, `memhtml state import` before the rebuild so the salience arm has signal on the first query, and the rebuild last because it is the only step costing Bedrock calls and the one you re-run if it is interrupted.

The git tree is the system of record: every memory, every authored `<link>`, every `<meta>`, and the history of every eviction via `git log --follow`. `.memhtml/state/access.jsonl` and `.memhtml/sleep/<run-id>.html` are committed too. `index.db` is a projection — embeddings, mined edges, chunks, FTS — and is fully rebuildable. `state.db` rebuilds from the sidecar only, so any access bump since the last export is lost, which is why `state-export` runs every night. The trace tables rebuild by re-running `memhtml trace index`, which re-walks `$MEMHTML_TRACE_ROOT` from a zero watermark: slow, not lossy. An unmerged sleep branch is lost unless it was pushed — re-run the sleep, since every phase is idempotent.
