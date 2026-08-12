---
title: Run and review a sleep cycle
description: Fifteen curation phases on a review branch — how to run them, how to read the diff, what a failed phase costs, and why a merge refuses.
---

```bash
memhtml sleep run                       # 15 phases, each its own commit on sleep/<date>
memhtml sleep run --dry-run             # per-phase counts, no branch, no commits
memhtml sleep run --phases preflight,dedup-merge,integrity
memhtml sleep status                    # the latest run and its per-phase outcomes
memhtml sleep review <run-id> [--diff]
memhtml sleep resume <run-id>
memhtml sleep merge <run-id>
```

The fifteen phases, in order (`packages/sleep/src/contract.ts:17`):

```
preflight            dedup-merge        entity-resolution    person-links
relationship-mining  conflict-detection confidence-decay     arc-synthesis
retention-triage     compress           reprieve             trace-consolidation
integrity            state-export       report
```

The branch is created **before any phase runs** and every commit lands on it, so `main` is never touched
by a run (`packages/sleep/src/run.ts:96`). A second run on the same date takes `sleep/<date>-2` and upward
(`packages/sleep/src/run.ts:45`). A dry run creates no branch at all.

A real run leaves you checked out on the sleep branch. `memhtml sleep merge` checks out the target itself,
so you do not have to.

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

Every phase reports `status`, a `counts` object shaped to that phase, a `commitSha` (null on a dry run and
on the phases that commit nothing by design), and its own `llmCalls`. `failedPhases` is present so you do
not have to filter the array to know whether anything failed.

Two phases commit nothing even on a real run, by design: `preflight` just refreshes the index, and
`relationship-mining` writes derived edges to the index alone — thousands of re-derivable edges would bury
every real diff.

With `MEMHTML_LLM=off` a run is still honest rather than red:

```
conflict-detection    | ok | no model bound
arc-synthesis         | ok | no model bound
compress              | ok | no model bound
trace-consolidation   | ok | no consolidator bound
```

## Review before you merge

```bash
memhtml sleep review sleep/2026-08-12
memhtml sleep review sleep/2026-08-12 --diff
```

The per-file classification is the substance here, because `git diff --stat` says a file changed by two
lines and says nothing about whether those lines were a confidence stamp or the memory's claim. Review
compares the two versions' **article content hashes** (`packages/sleep/src/review.ts:170`):

| Classification | What it is | Read it? |
|---|---|---|
| `meta-only` | A decay stamp, a link promotion, or a reprieve extension. The article did not move. | Skippable. |
| `body-changed` | The claim moved. | **Read these.** |
| `archived` | An eviction, reaching the tree as a `git mv` into `archive/<YYYY>/`. | Skim the reasons. |
| `created` | A new file, usually a synthesized arc or a compress canonical. | Read these. |

That classification is what makes a fifteen-commit night reviewable in minutes: the `meta-only` set is
usually most of it.

## A failed phase is not a failed run

Every phase is its own commit, and a failure is caught as a **value**: the phase records `failed`, the
phases after it still run, and every prior commit stays on the branch
(`packages/sleep/src/run.ts:231`). A failed phase's staged files are unstaged, so the next phase's commit
carries no half-finished work.

The one exception is a declared hard prerequisite: **`dedup-merge` failing skips `compress` and
`retention-triage`**, both of which operate on the post-merge set (`packages/sleep/src/contract.ts:57`).

To abort, drop the branch — `main` never moved:

```bash
git branch -D sleep/2026-08-12
```

To finish an interrupted run:

```bash
memhtml sleep resume sleep/2026-08-12
```

`resume` re-runs only the phases with no `Memhtml-Phase` commit trailer on the branch. It reads the
branch's own commits rather than a journal table (`packages/sleep/src/run.ts:146`) — the commit **is** the
fact, so a process killed after `git commit` and before a row write resumes correctly rather than
redoing work it already committed.

## When trace-consolidation distils nothing

Phase 12 hands unread session transcripts to the consolidator agent and commits one memory per candidate
that clears the bar. It reports `ok` in four different situations, and `detail` is what tells them apart:

| `detail` | Meaning | What to do |
|---|---|---|
| `no consolidator bound` | `MEMHTML_LLM=off`, or no Bedrock credentials in the environment. The phase was never able to run. | Nothing, if that was intended. Otherwise export `AWS_BEARER_TOKEN_BEDROCK` (or the SigV4 pair). |
| `consolidator unavailable: ConsolidatorUnavailable` | The agent server could not be built, started, or reached. Usually its output is missing. | `pnpm --filter @memhtml/consolidator build:agent`. That build is deliberately outside the turbo graph, so a fresh clone has not run it. |
| `consolidator unavailable: ConsolidatorRunFailed` | The turn reached the model and came back with nothing usable — a throttle, a timeout, an unentitled key. | Re-run. No session was watermarked, so nothing was lost. |
| absent, with `candidates: 0` | The agent read the batch and found nothing above the bar. **A successful night.** | Nothing. The sessions are watermarked and will not be re-read. |

Only the last one means the transcripts have been dealt with. Read `counts.batch` for how many sessions
were handed over and `counts.consolidated` for how many were watermarked: a failed call leaves
`consolidated: 0` with `batch` non-zero, which is the shape that says *these transcripts are still
waiting*.

A run takes at most **10 sessions, newest first**, skipping transcripts under 8 KiB and any modified
within an hour of the run's instant (`packages/sleep/src/phases/trace-consolidation.ts:64`). So a first
run over a year of history is an increment, not a stampede: it consolidates the ten most recent sessions
and works backwards a batch per night.

Each commit's body carries the evidence quotes the claim rests on, which is the reviewable receipt. The
memory itself carries only the distilled claim, because `.memhtml` holds no session content. A commit
whose subject reads `distil (frame conflict) …` means the new claim occupies the same frame slot as a live
memory, named in the body — the phase writes it anyway and reports the conflict, because sometimes the
contradiction is the answer.

## When the merge refuses

```bash
memhtml sleep merge sleep/2026-08-12
```

The refusal is a value on the report, never an error (`packages/sleep/src/contract.ts:169`,
`packages/sleep/src/review.ts:226`):

| `refusal` | Meaning | What to do |
|---|---|---|
| `no-run` | No such run id. | `memhtml sleep status`. |
| `main-advanced` | `main` moved past the run's `base_sha`, so the run curated a corpus that no longer exists. Also the refusal when the fast-forward itself fails. | Re-run the sleep. Every phase is idempotent, so it is cheap. |
| `gate-failed` | The discrimination gate refused: this run degrades retrieval. | `memhtml eval discriminate` to see which probes inverted, then `git branch -D <run-id>`. |

`--skip-gate` merges without re-running discrimination and logs a warning (`apps/cli/src/run.ts:490`) — a
deliberate override, never a default.

The gate always runs in **fake** mode here (`apps/cli/src/run.ts:514`), precisely so a nightly merge is
not conditional on a token being valid at 3am. See [check the discrimination
gate](/learn/operations/check-the-discrimination-gate/).

## Why the merge is a human step

`memhtml sleep run` is on the cron; `memhtml sleep merge` is not. A run rewrites confidence across the
corpus and archives memories, so the branch exists for a person to read `memhtml sleep review` first.

The division of labour is the same one the whole system uses: conflict **detection** is nightly and
automatic, conflict **resolution** stays with the writer or a human. Choosing a winner between two
contradictory memories is a one-way door.

For an AI agent: sleep is not on the MCP tool surface, and that is deliberate — do not try to trigger a
curation run mid-conversation. If you found a contradiction yourself, `memhtml correct` is your verb.

[The sleep pipeline](/internals/the-sleep-pipeline/) develops the phases.
