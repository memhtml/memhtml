---
title: Run and review a sleep cycle
description: "Seventeen curation phases on a review branch: how to run them, how to read the diff, what a failed phase costs, and why a merge refuses."
---

```bash
memhtml sleep plan                      # would a run change anything? index counts, no phase runs
memhtml sleep run                       # 17 phases, each its own commit on sleep/<date>
memhtml sleep run --dry-run             # per-phase counts, no branch, no commits
memhtml sleep run --phases preflight,dedup-merge,integrity
memhtml sleep run --deep                # the occasional budgeted cycle; --max-llm-calls caps it
memhtml sleep status                    # the latest run and its per-phase outcomes
memhtml sleep review <run-id> [--diff]
memhtml sleep resume <run-id>
memhtml sleep merge <run-id>
```

A sleep cycle is the curation pass over the corpus. It merges duplicates, resolves entities, mines relationships, decays confidence, evicts what has gone stale, and distills new memories out of session transcripts. Each phase makes its own commit on a branch, so nothing reaches `main` until you merge.

The phases of `SLEEP_PHASES`, in order — seventeen as of v0.6.0 (`packages/sleep/src/contract.ts:43`):

```
preflight            dedup-merge        entity-resolution    person-links
relationship-mining  edge-typing        confidence-decay     arc-synthesis
retention-triage     compress           reprieve             trace-consolidation
task-detection       placement-triage   integrity            state-export
report
```

`placement-triage` is deep-only. On a run without `--deep` it returns immediately, writes nothing, and commits nothing, so a run without the flag behaves the same whether or not you count it.

`reprieve` gives a memory whose stated validity date has passed another two weeks when its use record earns it, and archives it otherwise. `compress` folds several overlapping memories into one canonical memory. `edge-typing` reads the pairs relationship mining and the shared-entity scan turned up and names the relationship between them — `caused_by`, `leads_to`, `example_of`, `supports`, `part_of`, or `contradicts` — promoting the confident ones into the files as authored links. `task-detection` reads the recent corpus for work the text records and nobody opened — a commitment somebody made, a follow-up nobody closed — and opens a task file quoting the sentence it found. Three other phases do the same for the decisions they decline to make: an alias pair entity resolution would not merge, a near-duplicate pair the divergence veto refused, a contradiction below the two-night promotion gate. Every detected task is authored `agent:sleep`, capped at ten a night across all four, and closed automatically when its finding stops appearing.

The branch is created before any phase runs and every commit lands on it, so a run never touches `main` (`packages/sleep/src/run.ts:96`). A second run on the same date takes `sleep/<date>-2` and upward (`packages/sleep/src/run.ts:45`). A dry run creates no branch at all.

A real run leaves you checked out on the sleep branch. `memhtml sleep merge` checks out the target itself, so you do not have to.

## Decide whether to run at all

```bash
memhtml sleep plan
```

`sleep plan` reads index counts and runs no phase, so it costs a handful of aggregates. `verdict` is the field to branch on. `would-change` means a counted signal is non-zero and a run has work. `no-signal` means nothing any phase reads has anything in it, which is the one state in which skipping is safe. `unknown` means every counted signal is zero but a phase whose candidates cannot be counted still has input: `dedup-merge` and `relationship-mining` select candidate pairs from a neighbor scan, so counting their candidates is the scan, and they report an input cardinality with an explicit reason instead of a zero.

`signals` carries the counted ones — memories written since the last run, chunks with no vector, settled transcripts, dangling authored links, entity merges waiting on a second run — each naming the phases it feeds. `sessionsPerRun` sits beside the transcript count because a backlog of forty at a cap of ten is four runs of work.

Trigger on VOLUME, not on the calendar, and the reason is correctness rather than cost: a machine-proposed entity merge applies only once two separate runs independently agree, and what makes the second agreement evidence is that the corpus changed between the reads. Two runs back to back over an unchanged corpus rubber-stamp each other.

## Start with a dry run

```bash
memhtml sleep run --dry-run
```

```json
{
  "apiVersion": "1",
  "type": "sleep.report",
  "data": {
    "runId": "sleep/2026-08-12",
    "branch": "sleep/2026-08-12",
    "baseSha": "7ebc0ce7226c84b0ab29a77d0289bf6c8ade9280",
    "headSha": "7ebc0ce7226c84b0ab29a77d0289bf6c8ade9280",
    "dryRun": true,
    "llmCalls": 0,
    "phases": [
      {
        "phase": "preflight",
        "status": "ok",
        "counts": {
          "active": 1,
          "archived": 0,
          "chunks": 1,
          "embeddings": 0,
          "edges": 0,
          "derivedEdges": 0,
          "indexedAdded": 0,
          "indexedModified": 0,
          "indexedRemoved": 0,
          "indexedRenamed": 0,
          "embeddingsWritten": 0,
          "indexSkipped": 0
        },
        "commitSha": null,
        "llmCalls": 0
      }
    ],
    "failedPhases": [],
    "commits": []
  }
}
```

Every phase reports `status`, a `counts` object shaped to that phase, a `commitSha`, and its own `llmCalls`. `commitSha` is null on a dry run and on the phases that commit nothing by design. `failedPhases` is there so you can see whether anything failed without filtering the array yourself.

Two phases commit nothing even on a real run, by design. `preflight` only refreshes the index, and `relationship-mining` writes its derived edges into the index alone, because thousands of edges the system can derive again would bury every real diff.

Eight phases call a model (`LLM_PHASES`, `packages/sleep/src/contract.ts:168`). With `MEMHTML_LLM=off` every one of them still reports `ok` and says why it did nothing:

```
edge-typing           | ok | no model bound
arc-synthesis         | ok | no model bound
compress              | ok | no model bound
trace-consolidation   | ok | no consolidator bound
task-detection        | ok | no model bound
placement-triage      | ok | deep only
```

`placement-triage` reports its deep-only reason on any run without `--deep`, with or without a model, because the flag gates it before the credential does.

`dedup-merge` and `entity-resolution` are absent from that list on purpose. Both call a model when one is bound and both have deterministic work to do when one is not, so they report counts rather than a reason: dedup falls back to the 0.92 cosine floor plus the divergence veto and still commits its folds, and entity resolution still runs its normalization and character-overlap passes.

## Review before you merge

```bash
memhtml sleep review sleep/2026-08-12
memhtml sleep review sleep/2026-08-12 --diff
```

`git diff --stat` tells you a file changed by two lines and says nothing about whether those two lines were a confidence stamp or the memory's claim. Review hashes each file's article content on both sides of the change and compares the two hashes (`packages/sleep/src/review.ts:170`):

| Classification | What it is                                                                          | Read it?          |
| -------------- | ----------------------------------------------------------------------------------- | ----------------- |
| `meta-only`    | A decay stamp, a link promotion, or a reprieve extension. The article did not move. | Skippable.        |
| `body-changed` | The claim moved.                                                                    | Read these first. |
| `archived`     | An eviction, reaching the tree as a `git mv` into `archive/<YYYY>/`.                | Skim the reasons. |
| `created`      | A new file, usually a synthesized arc or a compress canonical.                      | Read these.       |

That classification is what makes a fifteen-commit night reviewable in minutes, because the `meta-only` set is usually most of it.

## A failed phase leaves the rest of the run standing

Every phase is its own commit, and a failure comes back as a value. The phase records `failed`, the phases after it still run, and every prior commit stays on the branch (`packages/sleep/src/run.ts:231`). A failed phase's staged files are unstaged, so the next phase's commit carries no half-finished work.

Two declared prerequisites are the exception (`HARD_PREREQUISITES`, `packages/sleep/src/contract.ts:107`). `preflight` gates the whole run — every one of the sixteen phases after it — so a failed preflight commits nothing at all: a dirty tree would otherwise have a later phase commit your uncommitted bytes under sleep's trailers, and a stale index or a half-migrated vector space would make every later phase's counts describe a corpus fragment. And when `dedup-merge` fails, `compress` and `retention-triage` are skipped, because both operate on the post-merge set.

Check the exit code, not just the envelope. A run with any failed phase exits 1, and so does a fully aborted one; the envelope stays the `sleep.report` success shape carrying the whole per-phase report, so a cron line that branched on the exit code alone sees the failure while a reader still gets the detail. An abort reads as every selected phase `failed` with `headSha` equal to `baseSha` and no commits. `memhtml sleep status` and `memhtml sleep review` always exit 0, because they describe a run rather than perform one.

To abort, drop the branch. `main` never moved:

```bash
git branch -D sleep/2026-08-12
```

Dropping the branch discards the run's **pending state-plane marks** along with its commits, and that is the point of them. Three writes a phase makes would otherwise outlive the branch, because `.memhtml/state.db` is not rebuildable from the tree: a `trace-consolidation` watermark, an edge promotion, and an entity promotion. So each is recorded instead as a line in `.memhtml/sleep/<run-id>.pending.jsonl`, a committed file on the run's own branch, and `memhtml sleep merge` applies them after the fast-forward succeeds, reporting `marksPending` beside `marksApplied` (`packages/sleep/src/contract.ts:306`).

Nothing in that ledger is lost work. A session whose watermark never applied is simply re-read on the next cycle — one model call, and a candidate a reviewer may decline — and a counter that stays unset leaves its pair eligible again. Without the ledger the watermark would be the expensive case: it is an anti-join, so a session it covers is never selected again, and a discarded branch would leave the transcript unread behind a row asserting it was handled. Corroboration counters stay at phase time on purpose, because `detections` counts the nights a model read the corpus and proposed the merge, and a night you discarded did both.

To finish an interrupted run:

```bash
memhtml sleep resume sleep/2026-08-12
```

`resume` re-runs only the phases with no `Memhtml-Phase` commit trailer on the branch. It reads the branch's own commits rather than a journal table (`packages/sleep/src/run.ts:146`), so the commit is the record of what happened. A process killed after `git commit` and before a row write therefore resumes correctly instead of redoing work it already committed.

## When trace-consolidation distills nothing

Phase 12 hands unread session transcripts to the consolidator agent and commits one memory per candidate that clears the bar. It reports `ok` in four different situations, and `detail` is what tells them apart:

| `detail`                                            | Meaning                                                                                                          | What to do                                                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `no consolidator bound`                             | `MEMHTML_LLM=off`, or no Bedrock credentials in the environment. The phase was never able to run.                | Nothing, if that was intended. Otherwise export `AWS_BEARER_TOKEN_BEDROCK` (or the SigV4 pair).                                           |
| `consolidator unavailable: ConsolidatorUnavailable` | The agent server could not be built, started, or reached. Usually its output is missing.                         | `pnpm --filter @memhtml/consolidator build:agent`. That build sits outside the turbo graph deliberately, so a fresh clone has not run it. |
| `consolidator unavailable: ConsolidatorRunFailed`   | The turn reached the model and came back with nothing usable, after a throttle, a timeout, or an unentitled key. | Re-run. No session was watermarked, so nothing was lost.                                                                                  |
| absent, with `candidates: 0`                        | The agent read the batch and found nothing above the bar. A successful night.                                    | Nothing. The sessions are watermarked and will not be re-read.                                                                            |

Only the last one means the transcripts have been dealt with. Read `counts.batch` for how many sessions were handed over and `counts.consolidated` for how many were watermarked. A failed call leaves `consolidated: 0` with `batch` above zero, and that shape says the transcripts are still waiting.

A run takes at most 10 sessions, newest first. It skips transcripts under 8 KiB and any transcript modified within an hour of the run's instant (`packages/sleep/src/phases/trace-consolidation.ts:64`). So a first run over a year of history consolidates the ten most recent sessions and works backwards a batch per night.

Each commit's body carries the evidence quotes the claim rests on, which is the receipt you review. The memory itself carries only the distilled claim, because `.memhtml` holds no session content. A commit whose subject reads `distill (frame conflict) …` means the new claim fills the same slot as a live memory, where a slot is a subject-and-relation phrase such as "the capital of India is". The body names the memory it collides with. The phase writes the new memory anyway and reports the conflict, because sometimes the contradiction is the answer.

## When the merge refuses

```bash
memhtml sleep merge sleep/2026-08-12
```

A refusal arrives as a value on the report rather than as an error (`packages/sleep/src/contract.ts:265`, `packages/sleep/src/review.ts:238`):

| `refusal`       | Meaning                                                                                                                                                 | What to do                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `no-run`        | No such run id.                                                                                                                                         | `memhtml sleep status`.                                                                  |
| `main-advanced` | `main` moved past the run's `base_sha`, so the run curated a corpus that no longer exists. This is also the refusal when the fast-forward itself fails. | Re-run the sleep cycle. Every phase is safe to repeat, so it is cheap.                   |
| `gate-failed`   | The discrimination gate refused: this run degrades retrieval.                                                                                           | `memhtml eval discriminate` to see which probes inverted, then `git branch -D <run-id>`. |

A merge that happened reports `marksPending` and `marksApplied`. They agree on an ordinary merge, so a merge where they disagree is telling you a state-plane write did not land: the sessions in the shortfall stay unconsolidated and are re-read next cycle, and the server's log carries which mark and why. A failed apply deliberately does not fail the merge — `main` has already moved and the memories are landed — so a reported shortfall is the visible form of that. A refusal applies nothing and reports neither count.

The discrimination gate is the check that every probe query ranks its target fact above deliberately wrong versions of that fact. `--skip-gate` merges without re-running it and logs a warning (`apps/cli/src/run.ts:490`), which is a deliberate override and never a default.

The gate always runs in fake mode here (`apps/cli/src/run.ts:514`), which keeps an unattended merge from depending on a token being valid whenever the run fires. See [check the discrimination gate](/learn/operations/check-the-discrimination-gate/).

## Why the merge is a human step

A caller may fire `memhtml sleep run` unattended; `memhtml sleep merge` is not for that. A run rewrites confidence across the corpus and archives memories, so the branch waits for a person to read `memhtml sleep review` first.

Conflict detection runs on every cycle and automatically, and conflict resolution stays with the writer or a human, which is the division of labour the whole system uses. Choosing a winner between two contradictory memories is a one-way door.

For an AI agent, sleep is absent from the MCP tool surface, so do not try to start a curation run mid-conversation. If you found a contradiction yourself, `memhtml correct` is your verb.

[The sleep pipeline](/internals/the-sleep-pipeline/) covers the phases in detail.
