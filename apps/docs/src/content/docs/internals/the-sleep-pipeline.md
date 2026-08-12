---
title: The sleep pipeline
description: Fifteen phases in a fixed order, each an isolated commit on a branch, with commit trailers as the resume mechanism and a refusable quality gate at the merge.
---

## 1. Fifteen phases on a branch

Fifteen phases in a fixed order (`packages/sleep/src/contract.ts:17`), each an isolated commit on
`sleep/<YYYY-MM-DD>`, suffixed `-2` on a same-day rerun (`packages/sleep/src/run.ts:45`). The branch is
created before any phase runs, so `main` is never touched (`packages/sleep/src/run.ts:95-97`). A dry run
creates no branch, safe precisely because no phase in dry mode writes a file.

| # | Phase | Model | Git effect |
|---|---|---|---|
| 1 | `preflight` | no | none — `index update`, snapshot counts |
| 2 | `dedup-merge` | no | one commit: keeper gains `memhtml-supersedes`, dropped files `git mv` to archive |
| 3 | `entity-resolution` | no | one commit: `memhtml-entity` values normalized and cluster-merged in place |
| 4 | `person-links` | no | one commit: `memhtml-about-person` links to `resources/people/*` |
| 5 | `relationship-mining` | no | **no commit** — derived `relates_to` in the index only |
| 6 | `conflict-detection` | yes | one commit, only for corroborated promotions |
| 7 | `confidence-decay` | no | one commit: `memhtml-confidence` rewritten for un-reinforced files |
| 8 | `arc-synthesis` | yes | **one commit per arc** |
| 9 | `retention-triage` | no | one commit: EVICT-band files `git mv` to archive |
| 10 | `compress` | yes | **one commit per batch** |
| 11 | `reprieve` | no | one commit: `memhtml-valid-until` extended, or the file archived |
| 12 | `trace-consolidation` | yes | **one commit per distilled memory** |
| 13 | `integrity` | no | one commit: dangling hrefs repaired, artifacts regenerated |
| 14 | `state-export` | no | one commit: `.memhtml/state/access.jsonl` |
| 15 | `report` | no | one commit: `.memhtml/sleep/<run-id>.html` |

The order encodes the dependencies: entity resolution precedes person links so aliases have already
merged, confidence decay precedes retention triage so triage scores the decayed value, and dedup-merge
precedes compress and retention because both operate on the post-merge set.

Four phases call a model (`packages/sleep/src/contract.ts:71`); every other phase is deterministic and
costs no model call.

`PHASE_BODIES` is a total `Record<SleepPhase, PhaseBody>` (`packages/sleep/src/phases/index.ts:27`), so a
name added to `SLEEP_PHASES` without a body is a compile error rather than a run that silently skips it.

## 2. Per-phase isolation is the whole design

A phase that throws is caught with `Effect.result`, recorded as a value, and the phases after it still run
(`packages/sleep/src/run.ts:231`, `packages/sleep/src/run.ts:258`) — thirteen phases inside one transaction
means one raise discards the twelve that already succeeded.

`dedup-merge` is the one **hard prerequisite**, for `compress` and `retention-triage`
(`packages/sleep/src/contract.ts:57-60`), because both operate on the post-merge set and running them over
a corpus that still holds its duplicates would compress a pair the merge then archives half of.

A failed phase's staged files are unstaged (`packages/sleep/src/run.ts:283-290`), which keeps the failure
isolated in the *tree* as well as the report: a partial stage would make the next phase's commit carry the
failed phase's half-finished work.

**Nothing is ever rolled back** — `git branch -D` is the abort and `main` never moved
(`packages/sleep/src/run.ts:29-31`).

## 3. Commit trailers are the resume mechanism

Every phase commit carries `Memhtml-Run`, `Memhtml-Phase`, and `Memhtml-Counts`
(`packages/sleep/src/contract.ts:67-69`, `packages/sleep/src/commit.ts:22-30`), and `resume` reads the
completed set out of `git log base..HEAD` rather than out of `sleep_phases`
(`packages/sleep/src/run.ts:138-145`, `packages/sleep/src/run.ts:334`).

A journal table a resume depended on would be a second record of what happened, and the two disagree
exactly when it matters — a process killed after `git commit` and before the row's write. The commit is
the fact; the row is a convenience the history can regenerate, and a reporting write never fails a run
(`packages/sleep/src/run.ts:434-439`).

A resume reports already-done phases explicitly as `skipped`, so its report accounts for all fifteen
(`packages/sleep/src/run.ts:176-191`).

## 4. Tasks are excluded from every phase

`packages/sleep/src/sql.ts:33`, for different reasons per phase.

In `relationship-mining` it is the graph firewall: mined edges are written `edge_class = 'memory'`, so a
task endpoint would put a task into PageRank, MMR, and the bridge count, and the `edges` CHECK cannot
refuse it because `relates_to` under `memory` is well-formed whatever files sit at its ends
(`packages/sleep/src/phases/relationship-mining.ts:32-38`).

In `retention-triage` it is sharper: the score is dominated by recency and access, so a task untouched for
a month scores at the *floor* — exactly the task most likely to still be owed, so evicting on that signal
would archive the neglected work first and leave the busy work behind
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

`packages/domain/src/retention.ts:267` is eight normalized signals under a per-type weight profile.

Every profile's eight weights sum to exactly 1.0 under compensated summation
(`packages/domain/src/retention.ts:199`), the convexity fact the composite's `[0, 1]` range rests on. Band
boundaries belong to the lower band, so the three bands partition `[0, 1]` with no gap and no overlap
(`packages/domain/src/retention.ts:260`).

`LN2` rather than a `0.693` literal makes the half-life the *definition* of the recency curve, so a test
asserts an equality instead of a tolerance (`packages/domain/src/retention.ts:131-137`). Half-lives are per
type, with `procedural` and `task` set to `null` — a working procedure does not stale, and age is actively
misleading about intended work (`packages/domain/src/retention.ts:110-126`).

## 7. The merge veto

`packages/domain/src/merge.ts:169` is the disjunction of three symmetric divergence predicates: negation
flip, numeric-token flip, variant-qualifier flip.

Cosine is geometric and embedding models are weakest on exactly the tokens carrying polarity and
discriminators, so "the deploy step is safe" and "the deploy step is NOT safe" sit above 0.92. Since the
merge keeps the *older* file, a blind high-cosine merge folds a newer correction into an older wrong
memory — it does not merely lose information, it restores the error the correction was written to fix
(`packages/domain/src/merge.ts:1-13`).

The **in-batch role guard** (`packages/domain/src/merge.ts:174-195`) fixes a path's role for the batch: a
keeper cannot later be dropped, and vice versa. Both directions are required — recording only the drop side
leaves the surviving corruption, where given `(gf, a)` then `(b, gf)` both decisions commit, `gf` absorbs
`a` and is then archived into `b`, so `a`'s content is superseded into a file the same batch destroyed.

## 8. Conflict detection is three stages, and the separation is the safety property

`packages/sleep/src/phases/conflict-detection.ts:21-40`: an SQL scan with no model, one isolated model call
per pair, then a deterministic assertion the model never makes.

Only `verdict: "contradicts"` above the confidence floor bumps the corroboration counter, and only two
detections promote the edge into the files, so a single machine detection can never reach the retention
penalty. The bump and the promotion decision are one statement's `RETURNING`
(`packages/sleep/src/phases/conflict-detection.ts:124-135`), because two runs racing on one pair would
otherwise both read `detections = 1` and both decline to promote.

Promotion writes **both** directions, since a contradiction is symmetric; `addLink` is idempotent on the
pair, so a re-promotion writes nothing.

The phase **detects and stops** — choosing the winner of a contradiction is a one-way door on stored belief
and belongs to an agent or a human, not to a nightly job.

## 9. Graph analysis runs in TypeScript

`packages/domain/src/graph.ts:76`, `packages/domain/src/graph.ts:164`: PageRank by power iteration,
communities by label propagation.

Determinism is a correctness requirement — these scores feed the `pagerank` and `bridgeImportance` signals,
so a run-to-run reordering would change which memories get evicted on a corpus that did not change
(`packages/domain/src/graph.ts:1-11`).

Every order source is pinned: nodes sorted before iteration so the floating-point summation order is fixed,
parallel edges folded to their maximum strength, label propagation visiting in sorted order with
lexicographic tie-breaking rather than a random seed. Community labels are canonicalized to the smallest
member path, so the *partition* is reproducible and not just the grouping.

Communities below three members collapse to `undefined` (`packages/domain/src/graph.ts:29-30`) — a pair
passed off as a community would make every cross-pair edge look like a bridge — and `bridgeCounts` gives a
node in no community a count of 0 rather than its full degree
(`packages/domain/src/graph.ts:236-247`).

## 10. The model phases

One call shape: the native Messages API with a forced tool (`packages/llm/src/wire.ts:9-12`,
`packages/llm/src/constants.ts:24`), decoded against its schema and failing typed on any violation rather
than coercing (`packages/llm/src/structured.ts:64`).

Not Converse: the effort and thinking rules are per-model and exact, and Converse has no field for either.
Three models are reached through `global.` inference profiles, with `thinking` sent for two and omitted for
the third because sending it there is a validation error rather than a no-op
(`packages/llm/src/models.ts:27-30`, `packages/llm/src/models.ts:57`).

Every phase caps its calls and isolates each one, so a single malformed response skips its item and is
counted — a night that judged 199 pairs and lost the 200th has done 199 pairs of work
(`packages/sleep/src/phases/conflict-detection.ts:105-119`).

`arc-synthesis` splits triage from execution, because a single call asked to both choose and write produces
content for arcs it should have skipped and the writing is the expensive half
(`packages/sleep/src/phases/arc-synthesis.ts:25-28`). `compress` archives a member only when the model
names it as absorbed; an omitted member stays active, which is the safe outcome
(`packages/sleep/src/phases/compress.ts:24-27`).

## 11. Generated artifacts are the one merge-conflict source

Per-directory `index.html` and root `sitemap.xml` are deterministic given the row set and regenerated only
by `memhtml publish` and the integrity phase, never on an ordinary write
(`packages/sleep/src/publish.ts:159`, `packages/sleep/src/phases/integrity.ts:31-34`).

`.gitattributes` marks them `merge=ours` (`packages/store/src/layout.ts:70`), inert without the
`merge.ours.driver` config `memhtml init` sets — so a conflict is resolved by regeneration, never by hand.

## 12. The integrity phase distinguishes two kinds of dangling href

`packages/sleep/src/phases/integrity.ts:20-34`. An archived target still exists and the edge still says
something true, so the href is rewritten to the archive path — *derived* with `archivePathFor` rather than
searched for, since the mapping is injective and no rename-similarity score is consulted anywhere.

A target that is simply gone means the edge asserts a relationship to nothing, so it is dropped with a
warning; leaving it would produce a dangling row on every rebuild forever. Years are tried newest-first
over a ten-year window (`packages/sleep/src/phases/integrity.ts:127`), so the most recent archiving of a
twice-archived path wins.

## 13. Review and the merge gate

`review` (`packages/sleep/src/review.ts:19`) reports per-phase counts, the commit list with their trailers,
`git diff --stat base..HEAD`, and a per-file classification — `meta-only`, `body-changed`, `archived`,
`created`, `deleted` (`packages/sleep/src/contract.ts:131`).

`merge` has **two refusals, both before anything moves** (`packages/sleep/src/review.ts:214-221`): `main`
having advanced past `base_sha` refuses as `main-advanced`, and a failing pre-merge gate refuses as
`gate-failed`.

`@memhtml/sleep` takes the gate as a parameter and **supplies no default**
(`packages/sleep/src/review.ts:196-206`) — a package that cannot import the eval must not be able to
silently default it, so the composition is visible in the CLI's own wiring or it does not exist
(`apps/cli/src/run.ts:496-515`).

The gate runs in `fake` mode (`packages/eval/src/run.ts:174`) because it measures the ranking stack against
a generated fixture corpus, and a live-embedding gate would make a nightly merge conditional on a network
call and on credentials being present at 3am. [Testing posture](/internals/testing-posture/) develops the
gate itself, and the run-and-review procedure is an operations how-to under [Learn](/learn/).
