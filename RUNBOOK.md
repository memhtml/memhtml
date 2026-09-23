# RUNBOOK — operating `memhtml`

Environment, daily operation, the concurrency rules, and recovery.

Every command writes exactly ONE JSON envelope to stdout and logs to stderr, so every line below is safe to pipe into `jq` and safe to run from cron. Exit 0 success, 2 usage, 1 runtime (`apps/cli/src/envelope.ts:92`). `memhtml manifest` is the authoritative command surface and answers on a machine with no repo, no database, and no credentials.

One thing a cron line needs from that contract: there is no `--json` flag to pass, because the typed envelope is the only output the binary has, on every command.

---

## 1. Environment

| Variable                        | Default     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMHTML_ROOT`                  | `~/memhtml` | The memory repo. A leading `~` is expanded — this value arrives from a shell profile, an MCP client config, and a cron line, and only the shell expands tildes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MEMHTML_REFUSE_ENV_ROOT`       | —           | Set to any value but `0`, `false`, `no`, or `off` (absent or blank is off; case-insensitive) makes `memhtml` take its repo from `--repo` alone: `MEMHTML_ROOT` and the `~/memhtml` default stop being doors, and a call that opens a repo without `--repo` is refused with `ERR_REPO_REQUIRED` at exit 2 before anything is opened. For CI, for a suite calling the CLI in-process, and for an agent runtime that exports `MEMHTML_ROOT` to every subprocess. `manifest`, `help`, `agents-doc`, and `eval discriminate` never open a repo and are unaffected. Read by `memhtml` only: `memhtml-mcp` takes its root from `MEMHTML_ROOT`, which `memhtml serve mcp --repo` sets for the child explicitly.                                                                     |
| `MEMHTML_TRACE_ROOT`            | `~/.claude` | Where `memhtml trace index` reads transcripts. Read-only; never written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MEMHTML_AWS_REGION`            | `us-east-1` | Bedrock region for embeddings and for write-time entity extraction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AWS_BEARER_TOKEN_BEDROCK`      | —           | Read by the AWS SDK itself. Absent means the default credential chain; retrieval degrades to the lexical floor rather than failing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MEMHTML_LLM_BASE_URL`          | —           | An OpenAI- and Anthropic-compatible LLM proxy's origin, e.g. `http://127.0.0.1:4000` for an agentgateway listener. Set, every model call — the entity extractor on `/v1/chat/completions`, embeddings on `/v1/embeddings` — leaves through it instead of going to Bedrock directly, and no AWS credential is consulted. A set-but-malformed value fails at startup naming the variable.                                                                                                                                                                                                                                                                                                                                                                                     |
| `MEMHTML_LLM_API_KEY`           | —           | A bearer token for that proxy (`Authorization: Bearer <key>`). Read only when `MEMHTML_LLM_BASE_URL` is set; absent means the proxy takes no credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MEMHTML_LLM_MODEL_PREFIX`      | `bedrock/`  | The prefix in front of every Bedrock model id a proxied request carries: `bedrock/global.anthropic.claude-opus-5`, the LiteLLM convention, which a LiteLLM proxy routes with one `bedrock/*` entry. Set it to `none` for a proxy that takes bare Bedrock ids. Read only when `MEMHTML_LLM_BASE_URL` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MEMHTML_LLM_MODEL_MAP`         | —           | `from=to` pairs, comma-separated, naming single models to the proxy by exact id when the prefix rule does not fit (`cohere.embed-v4:0=cohere-embed-v4`). A mapped id is sent verbatim, without the prefix. A proxy that does not know a name answers `model_not_found`, which the failure reason carries verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MEMHTML_OPENAI_PROMPT_CACHE`   | `off`       | How the OpenAI-lane chat-completions requests ask Bedrock to treat prompt caching. `off` sends `prompt_cache_options: {mode: "explicit"}` with no breakpoints, which Bedrock documents as no prompt caching and no cache-write charge; `implicit` sends no caching field and leaves the endpoint's default in place. Off by default: Bedrock's implicit mode for GPT-5.6 writes the whole prompt to the cache at 1.25x the input rate on every call that clears the 1,024-token minimum, and the structured-output prompts share no prefix long enough to ever be read back. Set `implicit` for an OpenAI-compatible endpoint that rejects the Bedrock-only field. Read on the direct path and the proxy path alike; any other value fails at startup naming this variable. |
| `MEMHTML_EMBED`                 | `on`        | `off` disables the embedder entirely. Distinct from a missing credential: a missing credential degrades one search at call time, `off` degrades every search.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MEMHTML_VECTOR_COVERAGE_FLOOR` | `0.95`      | The share of indexed chunks that must carry a vector in the configured space before the vector arm is trusted. Below it `search` and `recall` drop the vector arm and report `degraded: true` with `vectorCoverage`, `doctor` reports `vectorCoverageLow` and `healthy: false`. A sparse plane ranks the few embedded files above every exact match (issue #141), so it is treated as absent rather than run. Sleep refuses below a fixed hard floor of `0.5`, which this variable does not move: a value under `0.5` keeps search and doctor accepting a plane sleep still refuses. Remedy: `memhtml index embed`, or `memhtml index rebuild --embed`.                                                                                                                     |
| `MEMHTML_LLM`                   | `on`        | `off` binds no model, so write-time entity extraction is skipped and every write still succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MEMHTML_EXTRACT_ENTITIES`      | `on`        | `off` removes the one model call per write batch that extracts `memhtml-entity` metas the ops did not declare (`apps/cli/src/config.ts`); `MEMHTML_LLM=off` removes it too. On by default, like `MEMHTML_EMBED`, and it changes what a write STORES: extracted entities land in the files as if authored. The write never waits on or fails with the model — a failed extraction is a logged warning and an unextracted batch.                                                                                                                                                                                                                                                                                                                                              |
| `MEMHTML_MCP_BIN`               | —           | An explicit path to the `memhtml-mcp` entry point, read only by the serve supervisor (`apps/cli/src/serve.ts:58`). Absent means the sibling-path default, since the two apps ship as one build. Set it for a split deployment; it locates the server rather than configuring the store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

These are declared in `apps/cli/src/config.ts` and are what `memhtml manifest` reports. `MEMHTML_EMBED` and `MEMHTML_LLM` compare case-insensitively against `off` (`apps/cli/src/api-layer.ts:250`, `apps/cli/src/api-layer.ts:313`). `MEMHTML_MCP_BIN` is the one that configures no store behavior at all, and it is disclosed anyway: an operator debugging a split deployment reads the manifest, and a variable the binary reads but does not declare is one they cannot discover. `--repo <path>` overrides `MEMHTML_ROOT` per call.

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

**What moves the access plane, if you are debugging a salience number.** `memhtml read <path>` and `memory_read` bump it — an explicit open is a chosen memory — and so does the `memhtml://file/{path}` MCP resource, which funnels through the same use case. `memhtml search` and `memhtml recall` do NOT, however many paths they return, and neither does a curation pass: those are the ranker's guess and the curator's sweep, and counting either makes the ranking teach itself. So a corpus that has been searched all day and never read has an empty `state.access`, and that is correct rather than a bug. `memhtml reinforce --signal positive|negative` is the explicit channel and is the only thing that moves the outcome EWMA. The salience arm also ignores `task` rows and anything under `resources/people/` entirely, so their access counts exist but never affect a rank.

Working-tree edits are legitimate too: `memhtml index update` projects uncommitted changes as well as committed ones, so a hand-edited file is searchable before you commit it — but you own the commit.

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed >> /var/log/memhtml/index.log 2>&1
17 * * * *    cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml trace index      >> /var/log/memhtml/trace.log 2>&1
0 6 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml publish         >> /var/log/memhtml/publish.log 2>&1
0 7 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml doctor          >> /var/log/memhtml/doctor.log 2>&1
```

Each is idempotent: an unchanged HEAD and a clean tree touch nothing.

---

## 4. The MCP server, and sharing a store

```bash
memhtml serve mcp
MEMHTML_MCP_BIN=/path/to/bin.js memhtml serve mcp   # explicit path, for a split deployment
```

15 tools and 2 resources over this same repo (`apps/mcp/src/tools.ts`). Curation is deliberately absent from the tool surface: it is an operator action producing a reviewable branch, not something an agent triggers mid-conversation.

**A CLI command and a running server can share one repo.** WAL admits one writer at a time and any number of concurrent readers: readers never block the writer, a second writer waits rather than failing, and a wait that outlives `busy_timeout` is retried with jittered exponential backoff for up to 20 seconds (`packages/index/src/database.ts`). So `memhtml write` while `memhtml serve mcp` is serving the same store is a supported thing to do, and so is the every-10-minutes `index update` cron. Measure it yourself with `node scripts/probe-sqlite-concurrency.mjs`.

Retrying is safe because the error being retried is `SQLITE_BUSY` specifically — the lock was never taken, so the statement had no effect to half-apply. A write inside a transaction rolls back before the retry, so the transaction re-runs whole rather than resuming.

What still needs one writer is a curation session with its `curate/<date>` branch checked out, for a reason that is about git rather than the database: a concurrent write commits ONTO that branch and is either merged as if it were curation or lost with `git branch -D`. Quiesce writes for the length of one.

`memhtml serve mcp` holds no database of its own — it spawns `memhtml-mcp` with inherited stdio and waits (`apps/cli/src/serve.ts:87`), so the supervisor has no handle to conflict with the child. Interrupting it kills the child, so Ctrl-C never leaves an orphaned server holding the database open (`apps/cli/src/serve.ts:108`).

The one exception is `memhtml eval discriminate`, which never builds the app layer (`apps/cli/src/run.ts:891`): it measures the ranking stack against its own generated fixture corpus in a temp directory with an in-memory database and never reads your `index.db`. Deliberate — checking the gate is exactly what an operator wants while the server is up.

`memhtml status`, and `memory_status` through the same `statusReport`, write one WARN to stderr per call while the index is stale: `index describes <sha>, HEAD is <sha>; run memhtml index update --embed`. That line is for the operator of a `serve mcp` process, whose only view of the store is the server's log; the payload's `indexFresh` is for the caller who parses it.

---

## 5. The index, and when to rebuild

```bash
memhtml index update --embed     # only what moved since the watermark, plus the dirty tree
memhtml index rebuild --embed    # the whole tree at HEAD
memhtml index status             # watermark, vector space, per-table row counts
```

`--no-embed` turns either off and makes the pass instant. `update --embed` embeds only its own batch's chunks (the pending scan is scoped to them, since an unscoped scan was the last store-scaled per-batch cost), so it never revisits a chunk that lost its vector. Closing a store-wide embed gap is `memhtml index embed`'s job: it runs the unscoped scan in persisted slices, writes vectors and nothing else, is safe to rerun, and reports `embeddingsWritten` beside `embeddingsRemaining`, the chunks still without a vector after the pass. `memhtml index embed --dry-run` reports the gap and writes nothing. Vectors key on content hash either way, so a `git mv` issues zero Bedrock calls.

`update` is the daily verb. Reach for `rebuild` when the database file is gone or unopenable, when a migration adds a column the projection must recompute, or after fixing files doctor reported `unparseable`. `update` with no recorded watermark falls through to a rebuild on its own (`update` in `packages/index/src/indexer.ts`), so a deleted database mostly handles itself. A rebuild deletes every memory table, reprojects the tree, and lets the FTS triggers re-index the rows (`truncateForRebuild` in `packages/index/src/indexer.ts`). It keeps the vectors: the `embeddings` rows in the configured vector space are stashed before the delete and put back for every chunk id the reprojection produced again, and chunk ids are content-addressed, so a rebuild over an unchanged tree re-embeds nothing and its report's `embeddingsPreserved` says how many it kept. Only a model change empties the vector plane. It destroys nothing outside `.memhtml/` and touches neither the trace tables nor the attached state plane.

**`index rebuild --no-embed` over a store that carries vectors is refused.** `--no-embed` is the harness flag, and it was run against a live store by accident: ten hours of `update --embed` later that store held 183 embeddings under 9,332 chunks, because an update embeds only its own batch. So when the `embeddings` table is non-empty and the stored model matches the configured one, the bare call exits 1 with `ERR_REBUILD_NO_EMBED_REFUSED`, names the count in `error` and in a WARN on stderr, and writes nothing. `--force` runs it anyway. The vectors survive either way; what the flag costs on a live store is that new or changed chunks stay without a vector until `memhtml index embed` runs.

**A vector-space mismatch is a hard refusal, and a rebuild alone does not clear it.** Both `rebuild` and `update` call `guardEmbedModel()` before any write (`guardEmbedModel` in `packages/index/src/indexer.ts`), so an index built under one embedding model can never accumulate rows under another: you get `ERR_EMBED_MODEL_MISMATCH` naming the stored space and the configured one. Delete the database and rebuild into the configured space:

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

## 7. Curation

The v1 `memhtml sleep` commands are gone from this branch. Curation runs as a session on a `curate/<date>` branch (`memhtml session start --ref refs/heads/curate/<date>`), lands through the same commit gate as any other session, and a human merges the branch. `docs/design.md` section 15 describes the shape.

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
memhtml doctor          # eleven checks
memhtml doctor --fix    # repairs the two that need no judgement call
memhtml publish         # regenerate index.html listings and sitemap.xml, and commit
```

| Finding                    | Meaning                                                                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dangling`                 | A `<link>` points at a path the tree does not hold.                                                                                                                                                                                                                                                                        | `--fix` rewrites it to the archive path, or drops it when the target is gone.                                                                                                                                                                                                                             |
| `orphanAccessRows`         | A `state.access` row whose path left the tree.                                                                                                                                                                                                                                                                             | `--fix` prunes it.                                                                                                                                                                                                                                                                                        |
| `inboxCrowded`             | Over 20 active memories in `areas/inbox/`: the placement rules stopped matching what agents write.                                                                                                                                                                                                                         | Re-place them, or revisit the rules.                                                                                                                                                                                                                                                                      |
| `inboxTasksCrowded`        | Over 10 open tasks in `areas/inbox/tasks/`: work with no project.                                                                                                                                                                                                                                                          | Drain it. A task inbox is meant to be drained, not accumulated.                                                                                                                                                                                                                                           |
| `overdueTasks`             | An open task whose `memhtml-due` has passed.                                                                                                                                                                                                                                                                               | Doctor is the ONLY surface reading `due_at` — a task is default-excluded from search.                                                                                                                                                                                                                     |
| `staleBlockers`            | A `blocks` edge whose blocker is archived or absent.                                                                                                                                                                                                                                                                       | Decide whether the blocked task is ready. Each file alone is valid; only the pair is wrong.                                                                                                                                                                                                               |
| `warnings`                 | An element outside the closed vocabulary. The file still indexes.                                                                                                                                                                                                                                                          | Author's intent — doctor will not guess.                                                                                                                                                                                                                                                                  |
| `unparseable`              | A file the parser refuses. It is NOT in the index.                                                                                                                                                                                                                                                                         | Read the violations with `memhtml read <path>`.                                                                                                                                                                                                                                                           |
| `indexFresh: false`        | The index describes an older commit.                                                                                                                                                                                                                                                                                       | `memhtml index update --embed`.                                                                                                                                                                                                                                                                           |
| `embedModelMatches: false` | Stored vectors are in a different space from the configured one.                                                                                                                                                                                                                                                           | §5 — delete the database and rebuild.                                                                                                                                                                                                                                                                     |
| `vectorCoverageLow: true`  | Under `vectorCoverageFloor` of the chunks carry a vector in the configured space, while the plane is in use (some vector exists, or an embedder is configured). Search returns the few embedded files for every query with `degraded: false`. A store with zero vectors and no embedder is lexical-only and stays healthy. | `memhtml index embed` backfills the missing vectors; `memhtml index rebuild --embed` rebuilds everything. Zero vectors with an embedder bound is usually `MEMHTML_EMBED=on` with no credential: set `MEMHTML_EMBED=off` if the store is not meant to embed. `vectorCoverageRemedy` carries the same text. |

Thresholds are `INBOX_WARN_DEPTH` 20 and `INBOX_TASK_WARN_DEPTH` 10 (`apps/cli/src/doctor.ts:69`, `apps/cli/src/doctor.ts:78`). `--fix` splices the changed bytes in place (`apps/cli/src/repair.ts`) rather than writing through the serializer, because a repair routed through the serializer would move the content hash of every file it touched.

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
- `embedderUp: false` → the stored watermark disagrees with the configured model, or there are zero vectors (`apps/cli/src/operations.ts:1733`). Read off the stored watermark rather than by probing Bedrock, so it never fails for a reason unrelated to the corpus. Zero vectors under a matching model is a gap `memhtml index embed` closes without a rebuild.
- `degraded: true` on a search response → the vector arm did not fire. Read `vectorCoverage` beside it: low (under `MEMHTML_VECTOR_COVERAGE_FLOOR`, default `0.95`) means the index is sparsely embedded and the arm was dropped on purpose, so run `memhtml index embed`; high means the query embedder returned nothing, so check `MEMHTML_AWS_REGION` and the Bedrock credential. Search still works on the lexical floor either way.
- `vectorCoverage` below the floor on `memhtml status` or `memhtml index status` while `embedderUp` is true → the incident shape of issue #141: a `rebuild --no-embed` followed by incremental updates embeds only the newest files, and those few then outrank every exact match. `memhtml index embed` is the fix; `doctor` reports it as `vectorCoverageLow`.
- Quality feels wrong but nothing errors → `memhtml eval discriminate`. That is what it is for.

**A search should never error instead of returning nothing.** Query text goes through `sanitizeFtsQuery` before it reaches MATCH (`packages/index/src/fts-query.ts:71`), because several forms common in prose are hard driver errors rather than empty results: an apostrophe (`don't`), a `type:name` entity reference (`service:checkout-api`), and a leading hyphen, which FTS reads as negation. A query that errors means the sanitizer was bypassed — a bug, not a configuration problem.

**Error codes**: `ERR_UNKNOWN_COMMAND`, `ERR_MISSING_ARGUMENT`, `ERR_INVALID_FLAG`, `ERR_UNEXPECTED_ARGUMENT`, `ERR_REPO_REQUIRED`, `ERR_PATH_NOT_FOUND`, `ERR_INVALID_MEMORY`, `ERR_DUPLICATE_CONTENT`, `ERR_WRITE_CONFLICT`, `ERR_DIRTY_TREE`, `ERR_INDEX_STALE`, `ERR_EMBED_MODEL_MISMATCH`, `ERR_MODEL_UNAVAILABLE`, `ERR_STORAGE`, `ERR_GIT`, `ERR_DISCRIMINATION_FAILED`, `ERR_UNKNOWN`, `ERR_REBUILD_NO_EMBED_REFUSED` (`apps/cli/src/envelope.ts:67`). Branch on `code`, never on the `error` prose. Most failures carry `suggestions`, which are commands you can run (`apps/cli/src/errors.ts:136`). Every `memhtml …` suggestion is checked against the command table by the suite, so a renamed command cannot leave a suggestion naming a command that no longer exists. `ERR_REPO_REQUIRED` is the exit-2 refusal `MEMHTML_REFUSE_ENV_ROOT` (section 1) produces for a call that opens a repo without `--repo`; the suggestion is the flag spelling.

Three of those codes come from the usage surface and are worth reading precisely, because each names a different fix. `ERR_INVALID_FLAG` on a flag that exists elsewhere means the flag is real but not on THIS command — flags are validated against the command's own spec plus the two globals, never the union, so `memhtml list --status todo` is refused rather than answered unfiltered, and the suggestions name the commands that do take it (`apps/cli/src/run.ts:989`). `ERR_UNEXPECTED_ARGUMENT` is a positional past what the command declares, so the fix is dropping a word rather than adding one (`apps/cli/src/run.ts:950`). And `--as-of` outside the `YYYY-MM-DD` / `YYYY-MM-DDThh:mm:ssZ` grammar is `ERR_INVALID_FLAG` at exit 2 before any service is built, because the value is compared as TEXT in SQL and an unsortable one selects a different window rather than failing (`apps/cli/src/run.ts:892`).

**An occupied explicit `--path` is `ERR_WRITE_CONFLICT`, and nothing is written or committed.** Nothing in this corpus is overwritten, and an explicit path gets no `-2` collision suffix either, so the recovery is `memhtml correct <path>` — which writes the superseding memory and archives what it replaces in one commit (`apps/cli/src/errors.ts:147`).

**`ERR_INDEX_STALE` has exactly one recovery: `memhtml index rebuild`.** `memhtml index update` is what RAISES the tag — it refuses a watermark row with no commit on it rather than diffing from nothing — so a rebuild is the one call that repopulates the tables an interrupted pass left partial (`packages/index/src/indexer.ts:609`, `apps/cli/src/errors.ts:158`).

**`ERR_REBUILD_NO_EMBED_REFUSED` is the `--no-embed` interlock from §5.** The store carries vectors and the call would leave every new chunk without one. `memhtml index rebuild --embed` embeds them, `memhtml index rebuild --no-embed --force` is the operator saying the gap is understood, and `memhtml index embed` closes a gap that already exists.

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

The git tree is the system of record: every memory, every authored `<link>`, every `<meta>`, and the history of every eviction via `git log --follow`. `.memhtml/state/access.jsonl` is committed too. `index.db` is a projection — embeddings, mined edges, chunks, FTS — and is fully rebuildable. `state.db` rebuilds from the sidecar only, so any access bump since the last export is lost, which is why `memhtml state export` belongs on the cron. The trace tables rebuild by re-running `memhtml trace index`, which re-walks `$MEMHTML_TRACE_ROOT` from a zero watermark: slow, not lossy. An unmerged `curate/<date>` branch is lost unless it was pushed; run the curation again, since every pass is idempotent.
