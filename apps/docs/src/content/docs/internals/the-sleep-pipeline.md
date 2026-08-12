---
title: The sleep pipeline
description: Fifteen curation phases in a fixed order, each an isolated commit on a branch, with commit trailers as the resume mechanism and a quality gate that can refuse the merge.
---

## 1. Fifteen phases on a branch

The nightly curation run is called sleep. It executes fifteen phases in a fixed order
(`packages/sleep/src/contract.ts:17`), each producing its own commit on a branch named
`sleep/<YYYY-MM-DD>`, suffixed `-2` when it runs a second time the same day
(`packages/sleep/src/run.ts:45`). The branch is created before any phase runs, so `main` is never touched
(`packages/sleep/src/run.ts:95-97`). A dry run creates no branch, which is safe because no phase writes a
file in dry mode.

Figure 1 shows the shape of a run. Both of the gate's outcomes are drawn, because the refusal is the
property worth seeing. There is no third outcome and no rollback.

```d2 pad=20 src="_figures/sleep-branch.d2" title="Main branches into sleep/date. The fifteen phases run on that branch and are submitted for review to a gate. The gate has exactly two outgoing arrows: passes, leading to main moves, and refuses, leading to main unmoved. No arrow returns from the branch to main except through the gate."
```

**Figure 1: `main` moves only when a gate that can refuse says so.** The branch is cut before any phase
executes, so a failed run needs no compensating writes: the abort is `git branch -D` and `main` never
moved. The two boxes leaving the gate are the only two outcomes.

| # | Phase | Model | Git effect |
|---|---|---|---|
| 1 | `preflight` | no | none; runs `index update` and snapshots counts |
| 2 | `dedup-merge` | no | one commit: keeper gains `memhtml-supersedes`, dropped files `git mv` to archive |
| 3 | `entity-resolution` | no | one commit: `memhtml-entity` values normalized and cluster-merged in place |
| 4 | `person-links` | no | one commit: `memhtml-about-person` links to `resources/people/*` |
| 5 | `relationship-mining` | no | no commit; derived `relates_to` rows in the index only |
| 6 | `conflict-detection` | yes | one commit, only for corroborated promotions |
| 7 | `confidence-decay` | no | one commit: `memhtml-confidence` rewritten for un-reinforced files |
| 8 | `arc-synthesis` | yes | one commit per arc |
| 9 | `retention-triage` | no | one commit: files in the evict band `git mv` to archive |
| 10 | `compress` | yes | one commit per batch |
| 11 | `reprieve` | no | one commit: `memhtml-valid-until` extended, or the file archived |
| 12 | `trace-consolidation` | yes | one commit per distilled memory |
| 13 | `integrity` | no | one commit: dangling hrefs repaired, artifacts regenerated |
| 14 | `state-export` | no | one commit: `.memhtml/state/access.jsonl` |
| 15 | `report` | no | one commit: `.memhtml/sleep/<run-id>.html` |

The order encodes four dependencies. Entity resolution precedes person links so that aliases have already
merged. Confidence decay precedes retention triage so that triage scores the decayed value. Dedup-merge
precedes both compress and retention triage, because both operate on the post-merge set.

Those four constraints are the whole of what the order is for, and Figure 2 draws only them. Every phase
absent from the figure is order-independent of every other phase, which the table above cannot show.

```d2 pad=20 src="_figures/phase-order.d2" title="Four dependency edges among six phases. Phase 2 dedup-merge points at phase 10 compress and at phase 9 retention-triage, both labelled post-merge set. Phase 3 entity-resolution points at phase 4 person-links, labelled aliases merged first. Phase 7 confidence-decay points at phase 9 retention-triage, labelled scores the decayed value. Compress is drawn as a hexagon because it calls a model; the other five are deterministic."
```

**Figure 2: the fixed order exists to satisfy four edges.** Nine of the fifteen phases appear nowhere in
this graph, and that absence is the useful reading: the order among them is arbitrary and could change
without consequence. The hexagon marks the one phase here that calls a model, which is also why
`compress` archives a member only when the model names it as absorbed.

Four phases call a model (`packages/sleep/src/contract.ts:71`). Every other phase is deterministic and
costs no model call.

`PHASE_BODIES` is a total `Record<SleepPhase, PhaseBody>` (`packages/sleep/src/phases/index.ts:27`), so a
name added to `SLEEP_PHASES` without a body is a compile error rather than a run that silently skips it.

## 2. Per-phase isolation

A phase that throws is caught with `Effect.result`, recorded as a value, and the phases after it still run
(`packages/sleep/src/run.ts:231`, `packages/sleep/src/run.ts:258`). Thirteen phases inside one transaction
would mean one raise discards the twelve that already succeeded.

`dedup-merge` is the one hard prerequisite, for `compress` and `retention-triage`
(`packages/sleep/src/contract.ts:57-60`). Both operate on the post-merge set, and running them over a
corpus that still holds its duplicates would compress a pair the merge then archives half of.

A failed phase's staged files are unstaged (`packages/sleep/src/run.ts:283-290`), which isolates the
failure in the tree as well as in the report. A partial stage would make the next phase's commit carry the
failed phase's half-finished work.

Nothing is rolled back. `git branch -D` is the abort, and `main` never moved
(`packages/sleep/src/run.ts:29-31`).

## 3. Commit trailers are the resume mechanism

Every phase commit carries `Memhtml-Run`, `Memhtml-Phase`, and `Memhtml-Counts` trailers
(`packages/sleep/src/contract.ts:67-69`, `packages/sleep/src/commit.ts:22-30`), and `resume` reads the set
of completed phases out of `git log base..HEAD` rather than out of the `sleep_phases` table
(`packages/sleep/src/run.ts:138-145`, `packages/sleep/src/run.ts:334`).

A journal table that a resume depended on would be a second record of what happened, and the two records
disagree exactly when it matters, namely when a process is killed after `git commit` and before the row is
written. The commit is the fact, the row is a convenience the history can regenerate, and a failed
reporting write never fails a run (`packages/sleep/src/run.ts:434-439`).

A resume reports already-done phases explicitly as `skipped`, so its report still accounts for all fifteen
(`packages/sleep/src/run.ts:176-191`).

## 4. Tasks are excluded from every phase

`packages/sleep/src/sql.ts:33` applies the exclusion, and the reason differs by phase.

In `relationship-mining` it is the graph firewall. Mined edges are written with
`edge_class = 'memory'`, so a task endpoint would put a task into PageRank, the diversification pass, and
the retention scorer's bridge count. The `edges` CHECK cannot refuse it, because `relates_to` under
`memory` is well-formed whatever files sit at its ends
(`packages/sleep/src/phases/relationship-mining.ts:32-38`).

In `retention-triage` the reason is sharper. Recency and access dominate the score, so a task untouched
for a month scores at the floor, and that is exactly the task most likely to still be owed. Evicting on
that signal would archive the neglected work first and leave the busy work behind
(`packages/sleep/src/phases/retention-triage.ts:24-28`).

## 5. Thresholds and caps

| Constant | Value | Location |
|---|---|---|
| Near-duplicate cosine / merges per cycle | 0.92 strict / 100 | `packages/domain/src/merge.ts:16-19` |
| Entity auto-merge / review ratio | 0.85 / 0.75 | `packages/sleep/src/phases/entity-resolution.ts:30-33` |
| Mining cosine / k / sample | 0.85 / 5 / 2000 | `packages/sleep/src/phases/relationship-mining.ts:22-28` |
| Conflict cosine / k / cap / detections | 0.80 / 5 / 200 / 2 | `packages/sleep/src/phases/conflict-detection.ts:43-52` |
| Confidence commit delta | 0.005 | `packages/domain/src/decay.ts:135` |
| Compress batch / candidates | 8 / 2000 | `packages/sleep/src/phases/compress.ts:39-42` |
| Retention bands | keep > 0.7, evict ≤ 0.3 | `packages/domain/src/retention.ts:144-145` |
| Reprieve floor / days / max | 0.5 / 14 / 3 | `packages/domain/src/retention.ts:277-287` |

## 6. The retention scorer

`packages/domain/src/retention.ts:267` combines eight normalized signals under a weight profile chosen by
memory type.

Every profile's eight weights sum to exactly 1.0 under compensated summation
(`packages/domain/src/retention.ts:199`), which is the convexity fact the composite's `[0, 1]` range rests
on. Band boundaries belong to the lower band, so the three bands partition `[0, 1]` with no gap and no
overlap (`packages/domain/src/retention.ts:260`).

The recency curve uses `LN2` rather than a `0.693` literal, which makes the half-life the definition of the
curve, so a test can assert an equality instead of a tolerance
(`packages/domain/src/retention.ts:131-137`). Half-lives are set per type, and `procedural` and `task` are
`null`: a working procedure does not go stale with age, and age is actively misleading about intended work
(`packages/domain/src/retention.ts:110-126`).

## 7. The merge veto

`packages/domain/src/merge.ts:169` is the disjunction of three symmetric divergence predicates: a negation
flip, a numeric-token flip, and a variant-qualifier flip. Any one of them vetoes a merge.

Cosine similarity is geometric, and embedding models are weakest on exactly the tokens that carry polarity
and discriminate between variants, so "the deploy step is safe" and "the deploy step is NOT safe" sit above
0.92. The merge keeps the older file, so a blind high-cosine merge folds a newer correction into an older
wrong memory. That restores the error the correction was written to fix
(`packages/domain/src/merge.ts:1-13`).

The in-batch role guard (`packages/domain/src/merge.ts:174-195`) fixes a path's role for the batch: a
keeper cannot later be dropped, and a dropped file cannot later be a keeper. Both directions are needed.
Recording only the drop side leaves a corruption in place: given the pairs `(gf, a)` and then `(b, gf)`,
both decisions commit, `gf` absorbs `a` and is then archived into `b`, so `a`'s content is superseded into
a file the same batch destroyed.

## 8. Conflict detection runs in three separated stages

`packages/sleep/src/phases/conflict-detection.ts:21-40`: a SQL scan with no model involved, then one
isolated model call per candidate pair, then a deterministic assertion the model never makes.

Only a `verdict: "contradicts"` above the confidence floor bumps the corroboration counter, and only two
detections promote the edge into the files, so one machine detection cannot reach the retention penalty.
The bump and the promotion decision are one statement's `RETURNING`
(`packages/sleep/src/phases/conflict-detection.ts:124-135`), because two runs racing on one pair would
otherwise both read `detections = 1` and both decline to promote.

Promotion writes both directions, since a contradiction is symmetric, and `addLink` is idempotent on the
pair, so a re-promotion writes nothing.

The phase detects and stops there. Choosing the winner of a contradiction is a one-way door on stored
belief, and it belongs to an agent or a human rather than to a nightly job.

## 9. Graph analysis runs in TypeScript

`packages/domain/src/graph.ts:76` and `packages/domain/src/graph.ts:164` implement PageRank by power
iteration and community detection by label propagation.

Determinism is a correctness requirement here. These scores feed the `pagerank` and `bridgeImportance`
signals, so a run-to-run reordering would change which memories get evicted on a corpus that did not change
(`packages/domain/src/graph.ts:1-11`).

Every source of ordering is pinned. Nodes are sorted before iteration so the floating-point summation order
is fixed. Parallel edges are folded to their maximum strength. Label propagation visits in sorted order and
breaks ties lexicographically rather than with a random seed. Community labels are canonicalized to the
smallest member path, which makes the partition reproducible and not merely the grouping.

A community below three members collapses to `undefined`
(`packages/domain/src/graph.ts:29-30`), because a pair passed off as a community would make every
cross-pair edge look like a bridge. `bridgeCounts` gives a node in no community a count of 0 rather than
its full degree (`packages/domain/src/graph.ts:236-247`).

## 10. The model phases

There is one call shape: the native Messages API with a forced tool
(`packages/llm/src/wire.ts:9-12`, `packages/llm/src/constants.ts:24`), decoded against its schema and
failing with a typed error on any violation rather than coercing the value
(`packages/llm/src/structured.ts:64`).

The Converse API is unused here because the effort and thinking rules are per-model and exact, and Converse
has no field for either. Three models are reached through `global.` inference profiles, with `thinking`
sent for two of them and omitted for the third, where sending it is a validation error rather than a no-op
(`packages/llm/src/models.ts:27-30`, `packages/llm/src/models.ts:57`).

Every phase caps how many calls it makes and isolates each one, so a single malformed response skips its
item and is counted. A night that judged 199 pairs and lost the 200th has done 199 pairs of work
(`packages/sleep/src/phases/conflict-detection.ts:105-119`).

`arc-synthesis` splits triage from execution, because one call asked to both choose and write produces
content for arcs it should have skipped, and the writing is the expensive half
(`packages/sleep/src/phases/arc-synthesis.ts:25-28`). `compress` archives a member only when the model
names it as absorbed, so an omitted member stays active, which is the safe outcome
(`packages/sleep/src/phases/compress.ts:24-27`).

## 11. Generated artifacts are the one merge-conflict source

The per-directory `index.html` files and the root `sitemap.xml` are deterministic given the row set, and
only `memhtml publish` and the integrity phase regenerate them. An ordinary write never does
(`packages/sleep/src/publish.ts:159`, `packages/sleep/src/phases/integrity.ts:31-34`).

`.gitattributes` marks them `merge=ours` (`packages/store/src/layout.ts:70`), which does nothing without
the `merge.ours.driver` config that `memhtml init` sets. With both in place a conflict in a generated file
is resolved by regenerating it rather than by editing it.

## 12. The integrity phase distinguishes two kinds of dangling href

`packages/sleep/src/phases/integrity.ts:20-34`. An archived target still exists and the edge still says
something true, so the href is rewritten to the archive path. That path is derived with `archivePathFor`
rather than searched for, because the mapping is injective and no rename-similarity score is consulted
anywhere in the system.

A target that is simply gone means the edge asserts a relationship to nothing, so the edge is dropped with
a warning. Leaving it would produce a dangling row on every rebuild from then on. Years are tried
newest-first over a ten-year window (`packages/sleep/src/phases/integrity.ts:127`), so the most recent
archiving of a twice-archived path wins.

## 13. Review and the merge gate

`review` (`packages/sleep/src/review.ts:19`) reports per-phase counts, the commit list with their trailers,
`git diff --stat base..HEAD`, and a per-file classification: `meta-only`, `body-changed`, `archived`,
`created`, or `deleted` (`packages/sleep/src/contract.ts:131`).

`merge` has two refusals, and both happen before anything moves
(`packages/sleep/src/review.ts:214-221`). If `main` has advanced past `base_sha` it refuses as
`main-advanced`. If the pre-merge gate fails it refuses as `gate-failed`.

`@memhtml/sleep` takes the gate as a parameter and supplies no default
(`packages/sleep/src/review.ts:196-206`). A package that cannot import the eval package must not be able to
default it silently, so the composition is visible in the CLI's own wiring or it does not exist
(`apps/cli/src/run.ts:496-515`).

The gate runs with the fake embedder (`packages/eval/src/run.ts:174`), because it measures the ranking
stack against a generated fixture corpus. A gate that needed live embeddings would make a nightly merge
conditional on a network call and on credentials being present at 3am.
[Testing posture](/internals/testing-posture/) develops the gate itself, and the run-and-review procedure
is an operations how-to under [Learn](/learn/).
