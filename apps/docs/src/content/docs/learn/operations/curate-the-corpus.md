---
title: Curate the corpus
description: Run the curator on a curate/<date> branch, review what it did, land it on main with curate merge behind the head gate, fold a whole corpus with curate collapse, and brief the model with a charter of your own.
---

```bash
memhtml curate run --model bedrock:global.anthropic.claude-opus-5   # commits to curate/<UTC date>
git -C ~/memhtml log --oneline main..curate/2026-10-18                # review it
memhtml curate merge curate/2026-10-18                               # land it on main
memhtml curate run --model fake --dry-run                             # credential-free preview
memhtml curate collapse --model fake --dry-run                        # plan a corpus-wide fold
```

A curation pass is two commands. `memhtml curate run` lets a model clean up the corpus inside one session on a `curate/<date>` branch, and `main` doesn't move while it works. `memhtml curate merge` is the only way that work reaches `main`, and a person or a gate decides when to run it. Throwing a pass away is `git branch -D`, because `main` never moved.

## Run the curator

```bash
memhtml curate run --model fake
```

`--model` names the model the loop runs on:

| Value               | What it calls                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fake`              | A scripted curator that needs no credential. It archives the briefed duplicates, drops dangling links, and files inbox records that have an obvious home. |
| `bedrock:<modelId>` | Bedrock, through the default AWS credential chain and the region in `AWS_REGION`.                                                                         |
| `proxy:<model>`     | An OpenAI-compatible proxy at `MEMHTML_LLM_BASE_URL`, naming the model with the `MEMHTML_LLM_MODEL_PREFIX` convention.                                    |

Without `--model`, the run uses `MEMHTML_CURATOR_MODEL`, then a proxy model when `MEMHTML_LLM_BASE_URL` is set, and otherwise refuses.

```json
{
  "apiVersion": "1",
  "type": "curate.run",
  "data": {
    "ref": "refs/heads/curate/2026-10-18",
    "sessionId": "curate-2026-10-18",
    "baseSha": "a8f6c3ca00560e9e8fff9afd3c71f83ed567fc0d",
    "model": "fake",
    "dryRun": false,
    "resumed": false,
    "steps": 3,
    "tokens": { "input": 300, "output": 60 },
    "stoppedBy": "finish",
    "ops": { "put": 0, "archive": 1, "link": 1, "unlink": 1, "label": 0, "unlabel": 0, "move": 0 },
    "report": "Archived 1 duplicate record(s) and dropped 1 dangling link(s).\n\n…",
    "toolCalls": ["status", "exec", "finish"],
    "commit": "e70b0e24ef58dc7495494482052962378af631e5",
    "outcome": "committed",
    "rebases": 0,
    "next": "memhtml curate merge refs/heads/curate/2026-10-18"
  }
}
```

The payload is shortened here. It also carries the `briefing` the model started from, the `head` it loaded, and the `snapshot` it wrote. `next` is the command that lands the branch.

The run writes to `curate/<UTC date>` unless you pass `--ref`, and the ref must sit under `curate/`. `main`, any other branch, or a tag is `ERR_INVALID_FLAG` at exit 2. The branch your checkout has open is `ERR_INVALID_MEMORY` at exit 1, so a run can't land on the branch you're working on. The session id is the ref with slashes as dashes (`curate-2026-10-18`), and a second run on the same ref is refused with `ERR_STORAGE` (`session.exists`) unless you pass `--resume`. `--resume` reopens the session's log and loads the corpus at the session's own base.

`--dry-run` runs the whole loop over an in-memory copy and writes no session, no ref, and no commit. With `--resume` it starts from the logged operations, so you see what a resumed run would do.

### The budget

The loop stops at whichever limit it reaches first, and `stoppedBy` names it:

| `stoppedBy`  | Limit                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `finish`     | The model called `finish` with its report.                            |
| `maxSteps`   | `--max-steps` model calls, 40 by default.                             |
| `wallClock`  | `--wall-clock-ms` for the whole run, 1200000 (20 minutes) by default. |
| `maxOps`     | 200 operations, the most one commit can hold.                         |
| `modelError` | A model call failed.                                                  |

A run the model stopped is `ERR_MODEL_UNAVAILABLE` at exit 1, and its operations stay in the session for `--resume`. A run that finished with no operations exits 0 with `commit: null`.

### What the curator works from

The run starts from a briefing that code computes before any model call. It counts active and archived records and the share sitting in `areas/inbox/`, and it names the work by path in a few capped lists:

- `duplicates`: records whose claims fill one slot with the same value.
- `contradictions`: records whose claims fill one slot with different values.
- `recent`: records created since the last curation branch, each with its three nearest records.
- `unlabeled`: records outside `projects/<slug>/` that carry no `memhtml-entity`.
- `supersededActive`: records a `supersedes` link names that were never archived.
- `danglingEdges`: links whose target is no longer a live record, with the better target when one exists.
- `inbox`: inbox records, each with a home directory when code can find an obvious one.

The model then works through six tools: `search`, `read`, `exec` (a script over the session's view, harvested the way `session exec` harvests), `propose` (explicit operations), `status`, and `finish`. It can propose the seven session operations: `put`, `archive`, `link`, `unlink`, `label`, `unlabel`, and `move`. Under the curator's scope it may write `areas/arcs/` and `resources/people/`, which other sessions can't. The store's [write bar](/learn/operations/set-the-store-policy/) judges every operation it proposes, and a refused proposal goes back to the model with the reason so it can fix it in the same run.

The shipped charter tells the model its priorities in order. It never settles a contradiction by deleting a side, it leaves people records and tasks alone apart from a missing entity, and then it removes duplicates, labels records, resolves entity aliases, files inbox records, writes a few arcs, and repairs dangling links. Memory bodies are data to the curator and never instructions. The first line of its report becomes the commit subject, `memhtml(curate): <first line>`.

## Review the branch

The branch is ordinary git, so review it with ordinary git:

```bash
git -C ~/memhtml log --oneline main..curate/2026-10-18
git -C ~/memhtml diff --stat main...curate/2026-10-18
git -C ~/memhtml show curate/2026-10-18
```

The commit's subject is `memhtml(curate):` followed by the report's first line, cut to 72 characters. The whole report, including what it left undone, is the `curate.run` payload's `report`. Every archive is a move into `archive/<YYYY>/` with the original path mirrored beneath, so `git diff -M` shows it as a rename.

## Land it with curate merge

```bash
memhtml curate merge curate/2026-10-18
```

```json
{
  "apiVersion": "1",
  "type": "curate.merged",
  "data": {
    "ref": "refs/heads/curate/2026-10-18",
    "into": "refs/heads/main",
    "from": "a8f6c3ca00560e9e8fff9afd3c71f83ed567fc0d",
    "to": "e70b0e24ef58dc7495494482052962378af631e5",
    "moved": true,
    "gate": {
      "ran": true,
      "passed": true,
      "mode": "head",
      "mrr": 1,
      "mrrBefore": 0.9286,
      "mrrFloor": 0.9086,
      "floor": 0.9086,
      "probes": 7,
      "inversions": 0,
      "inversionsBefore": 0,
      "base": "a8f6c3ca00560e9e8fff9afd3c71f83ed567fc0d",
      "landed": "e70b0e24ef58dc7495494482052962378af631e5"
    },
    "worktreeSynced": true,
    "replayed": null,
    "snapshot": {
      "sha": "e70b0e24ef58dc7495494482052962378af631e5",
      "path": "/home/you/memhtml/.memhtml/snapshots/e70b0e24ef58dc7495494482052962378af631e5.arrow",
      "bytes": 12762,
      "rows": 8,
      "ms": 22,
      "pruned": []
    }
  }
}
```

`--into` names the branch to land on, `main` by default. The landing takes one of two shapes:

- When the curate branch still descends from `main`, the landing is a fast-forward. `main` moves to the branch's tip with a compare-and-swap, so a writer that moved `main` in the meantime makes the merge refuse instead of being overwritten.
- When `main` has moved past the branch's base, which is the usual case on a store agents write to all day, the landing is a replay. The merge reads the branch's changes back as session operations, commits them as one new commit on `main`'s tip with the subject `memhtml(curate): <subject> (replayed onto <sha>)`, and moves the curate branch to that commit. `replayed` in the payload counts the operations and names the branch's original tip.

A replay refuses, with nothing moved, when the branch holds a change that isn't an operation, such as an article edited in place or a file deleted with no archive copy. It also refuses when the operations collide with what `main` gained meanwhile, such as a `duplicate`, a `claim-edit`, or a link whose target is gone. Either refusal is `ERR_INVALID_MEMORY` and names the path.

When `main` is the branch your checkout has open, the working tree moves with the landing. An uncommitted edit at a path the landing changes is `ERR_DIRTY_TREE`, and nothing moves.

### The head gate

Before anything moves, the merge checks that retrieval didn't get worse. It loads the version at `main` and the version the landing would produce, takes a seeded sample of up to 200 records that are active in both, searches for each by its title, and looks for the record in the top 10. It compares the mean reciprocal rank (MRR) of the two versions and counts inversions, which are a probe whose record fell out of the top 10 or a superseded record that now ranks above its replacement.

The gate passes when the landed MRR is no more than 0.02 below the base MRR and the inversion count didn't grow. A failing gate is `ERR_DISCRIMINATION_FAILED` at exit 1 with both numbers in the message, and nothing moves. The gate is relative because a store's own base numbers depend on its corpus. Records the landing adds aren't probes, since they have no rank at the base to compare against.

`--skip-gate` lands without the gate. It's a logged override, and `gate.ran` in the payload says which happened.

## Throw a pass away

```bash
git -C ~/memhtml branch -D curate/2026-10-18
```

Nothing else needs undoing, because the run never touched `main`, the checkout, or the index. The curator's session log stays under `.memhtml/sessions/` with no operations in it until [`session prune`](/learn/operations/write-through-a-session/#clean-up-with-session-prune) removes it. Until then, a new run on the same date needs `--resume` or another `--ref`, such as `curate/2026-10-18-2`.

## Fold a whole corpus with curate collapse

`memhtml curate collapse` is for a corpus that grew without curation and holds many records that say the same thing. A planner cuts the corpus into clusters with no model call, then a driver lands the clusters on one `curate/` branch:

```bash
memhtml curate collapse --model fake --dry-run
```

The planner cuts in four passes, each taking what the earlier ones left:

1. Rulings, when you pass `--rulings` with a JSONL file of `{ path, verdict, theme?, reason? }` lines. `archive` and `trace` verdicts join an archive cluster, `fold` verdicts group by theme, and `keep` takes a record out of every later pass.
2. The record's source (its `memhtml-author`) and its memory type.
3. Frame keys. Records whose claims fill one slot fold together only when they agree, and records that disagree are kept apart as contradiction candidates.
4. A similarity graph over what's left, split into communities.

Each cluster is an `archive`, a `fold`, or a `keep`. Archive clusters land with no model. Each fold cluster runs one bounded curator session under the collapse charter, where the model writes one canonical record and the driver archives every member and links it from the canonical with `supersedes`. Keep clusters are reported under `untouched` and left alone. One failed cluster is data in its own outcome and doesn't stop the others.

The branch defaults to `curate/<UTC date>-collapse`, so it never shares a session with a same-day `curate run`. `--dry-run` prints the whole plan under `plan`, and `--plan <file>` runs a saved one. `--only <ids>` and `--limit <n>` narrow what runs, and `--concurrency` (4 by default) sets how many fold sessions run at once. Each fold's budget is `--max-steps` (14) and `--wall-clock-ms` (900000). Land the result with `curate merge`, the same way as a curator run.

## Brief the model with your own charter

`--charter <file>` on `curate run` and `curate collapse` replaces the shipped charter. Both shipped charters are templates, and yours can use the same placeholders, which are filled from the store's `memhtml.config.json`:

| Placeholder              | Filled with                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `{{placementQuota}}`     | `curator.placementQuota`, the number of inbox records one run should file                           |
| `{{refusedTypesRule}}`   | A sentence naming the types `writeBar.refusedTypes` refuses, or nothing when the store refuses none |
| `{{refusedTypesClause}}` | The same as a clause, for the middle of a sentence                                                  |

Any other text is used as written. The write bar still judges every operation the model proposes, so a charter can't loosen the store's policy. A file that can't be read or holds no text is `ERR_STORAGE` at exit 1 before any model call. The payload's `charter` field names the file a run used.

## Put it on a schedule

Run the curator from cron, and keep the merge a human step:

```cron
30 3 * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml MEMHTML_CURATOR_MODEL=bedrock:global.anthropic.claude-opus-5 memhtml curate run --dense >> /var/log/memhtml/curate.jsonl 2>> /var/log/memhtml/curate.err
```

Each morning, read the branch and its report, then run `memhtml curate merge curate/<date>` or delete the branch. The head gate runs inside the merge either way.

The store's `curator.writerBuckets` and `curator.placementQuota` keys tune where the curator files records and how many it files per run. [Set the store policy](/learn/operations/set-the-store-policy/) covers them.
