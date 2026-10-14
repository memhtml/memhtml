---
title: The sleep pipeline
description: Seventeen curation phases in a fixed order on a review branch, each isolated from the others' failures, with commit trailers as the resume mechanism and a merge that can refuse.
---

## 1. Seventeen phases on a branch

The curation run is called sleep. `memhtml sleep run` executes the phases of `SLEEP_PHASES` in a fixed order: seventeen as of v0.15.1 (`packages/sleep/src/contract.ts:43-61`). Nothing in the package decides when a run happens; see [Sleep has no schedule](#17-sleep-has-no-schedule).

A run works on a branch named `sleep/<YYYY-MM-DD>` after its `--date`. A later run on the same date takes the first of `sleep/<date>`, `sleep/<date>-2`, and so on up to `-100` that is not a branch, so a deleted branch's name is reused, and past `-100` the run refuses to start (`packages/sleep/src/run.ts:83-102`, `:144-153`, `:876-893`). The runner creates the branch and reads `HEAD` back before any phase runs, so the run's own commits never land on `main` (`packages/sleep/src/run.ts:198-211`, `:420-444`).

A dry run (`--dry-run`) creates no branch and changes no tracked file. It does write `.memhtml/index.db`: preflight refreshes the index, and the run records one `sleep_runs` row marked `abandoned` (`packages/sleep/src/phases/preflight.ts:55`, `packages/sleep/src/run.ts:238-248`). Measured on a fixture, `index.db` was the only file whose bytes changed.

Figure 1 shows the shape of a run: the merge is the only way from the branch to `main`, and it can refuse.

```d2 pad=20 src="_figures/sleep-branch.d2" title="Main branches into sleep/date. The seventeen phases run on that branch and are submitted for review to a gate. The gate has exactly two outgoing arrows: passes, leading to main moves, and refuses, leading to main unmoved. No arrow returns from the branch to main except through the gate."
```

**Figure 1: a run reaches `main` only through a merge that can refuse.** The box labeled "the gate" stands for every check `sleep merge` makes (section 15). Because the branch is cut before any phase runs, a discarded run needs no compensating commit: `git branch -D` removes its commits. It does not remove what the run wrote to `index.db` and `state.db`.

| #  | Phase                 | Model | Commits                                                                              |
| -- | --------------------- | ----- | ------------------------------------------------------------------------------------ |
| 1  | `preflight`           | no    | none: refreshes the index and records counts                                         |
| 2  | `dedup-merge`         | yes   | at most one: keepers gain `memhtml-supersedes`, dropped files move to the archive    |
| 3  | `entity-resolution`   | yes   | at most one: `memhtml-entity` values normalized and merged in place                  |
| 4  | `person-links`        | no    | at most one: person files under `resources/people/` and `memhtml-about-person` links |
| 5  | `relationship-mining` | no    | none: derived `relates_to` rows in the index only                                    |
| 6  | `edge-typing`         | yes   | at most one: typed edges and corroborated contradictions                             |
| 7  | `confidence-decay`    | no    | at most one: `memhtml-confidence` lowered on un-reinforced files                     |
| 8  | `arc-synthesis`       | yes   | one per arc written                                                                  |
| 9  | `retention-triage`    | no    | at most one: files in the evict band move to the archive                             |
| 10 | `compress`            | yes   | one per canonical written                                                            |
| 11 | `reprieve`            | no    | at most one: `memhtml-valid-until` extended, or the file archived                    |
| 12 | `trace-consolidation` | yes   | one per distilled memory, plus one for commitments or for the ledger alone           |
| 13 | `task-detection`      | yes   | at most one: task files for open work the corpus records                             |
| 14 | `placement-triage`    | yes   | `--deep` only, at most one: inbox files moved into topic directories                 |
| 15 | `integrity`           | no    | at most one: dangling hrefs repaired, listings regenerated                           |
| 16 | `state-export`        | no    | at most one: `.memhtml/state/access.jsonl`, none when its bytes are unchanged        |
| 17 | `report`              | no    | one: `.memhtml/sleep/sleep-<date>.html`                                              |

A phase makes zero, one, or several commits, and it commits only what it staged: `git.commit` makes no commit when nothing is staged (`packages/store/src/git.ts:399-405`). `preflight` and `relationship-mining` never commit (`packages/sleep/src/contract.ts:241`). Three phases commit per item: `arc-synthesis` per arc, `compress` per canonical, and `trace-consolidation` per distilled memory (`packages/sleep/src/phases/arc-synthesis.ts:299`, `packages/sleep/src/phases/compress.ts:497-502`, `packages/sleep/src/phases/trace-consolidation.ts:1208-1214`). Measured with the model off, a fixture's first run made six commits, and a second run on the same date made four.

The order encodes dependencies (`packages/sleep/src/contract.ts:16-41`). Dedup-merge precedes compress and retention triage, entity resolution precedes person links, and confidence decay precedes retention triage, so each later phase finds the earlier phase's file writes on disk. Task detection and placement triage precede integrity, which regenerates the listings, and placement triage follows compress and task detection, so a move cannot hand them a path that no longer holds a file. Figure 2 draws the first four of these edges.

```d2 pad=20 src="_figures/phase-order.d2" title="Four dependency edges among six phases. Phase 2 dedup-merge points at phase 10 compress and at phase 9 retention-triage, both labeled post-merge. Phase 3 entity-resolution points at phase 4 person-links, labeled aliases first. Phase 7 confidence-decay points at phase 9 retention-triage, labeled decayed value. Dedup-merge, entity-resolution and compress are drawn as hexagons because all three call a model; the other three are deterministic."
```

**Figure 2: four ordering edges among six phases.** The figure leaves out `preflight`, which every later phase depends on, and the edges into `integrity` and around `placement-triage`. Each edge holds for the files a phase writes. Within one run it does not hold for the index the next phase reads, as the next paragraphs show.

Preflight refreshes `index.db` once, and no phase of a default run refreshes it again; only a `--deep` compress re-indexes, between its passes (`packages/sleep/src/phases/preflight.ts:55`, `packages/sleep/src/phases/compress.ts:513-516`). So a phase that selects from the index sees the corpus as preflight found it, not as earlier phases left it. The next run's preflight picks up their writes.

Measured with the model off, this has three visible effects. `entity-resolution` merged `Dana Examples` onto `dana example`, yet `person-links` in the same run minted a person file for each spelling, and the next run linked one memory to both. `confidence-decay` lowered a file from 1.0 to 0.92 while the index that `retention-triage` scores still held 1.0 (`packages/sleep/src/retention.ts:92`, `packages/sleep/src/sql.ts:121-128`). And `integrity` listed `resources/people/` without the person file created earlier in the run (`packages/sleep/src/sql.ts:1208-1213`).

For a file an earlier phase moved away, the protection is narrower: a stamp or an archive aimed at a path that no longer holds a file does nothing (`packages/sleep/src/edits.ts:131-144`, `:198-206`).

The phases of `LLM_PHASES` can call a model: eight as of v0.15.1 (`packages/sleep/src/contract.ts:169-178`). The other nine are deterministic. With no model bound, two of the eight still work. `entity-resolution` normalizes names and merges pairs at or above 0.85 character similarity, and `dedup-merge` folds pairs above the 0.92 cosine floor that pass the veto (`packages/sleep/src/phases/entity-resolution.ts:736-779`, `packages/sleep/src/phases/dedup-merge.ts:292-331`).

The other six write nothing and report `no model bound`, or `no consolidator bound` for `trace-consolidation` (`packages/sleep/src/phases/edge-typing.ts:261`, `packages/sleep/src/phases/trace-consolidation.ts:944-949`). `placement-triage` also needs `--deep`, and without it reports `deep-only phase; run with --deep` (`packages/sleep/src/phases/placement-triage.ts:130-132`).

As of v0.15.1, six of the eight share one batching kernel. The phase sorts its rows; the kernel slices them into batches, gives each member an opaque key from `m1` to `mN`, and resolves the keys an answer names back to rows (`packages/sleep/src/batch.ts:65-127`). A key the batch never offered resolves to nothing, so a model can name only a member it was shown. The kernel never sorts, so batch boundaries and prompt bytes follow from the corpus alone. `arc-synthesis` keys its evidence and arcs itself, and `trace-consolidation` reaches its model through the consolidator.

Each kernel call sets `cacheSystem` (`packages/sleep/src/batch.ts:278-283`), but only the Anthropic dialect turns it into a cache marker on the system prompt (`packages/llm/src/wire.ts:169-174`). The structured phases default to `gpt-5.6-sol`, an OpenAI-dialect model, and that dialect ignores the flag and turns prompt caching off by default (`packages/llm/src/wire.ts:226-228`). So the shared system prompt is cache-eligible only for a phase bound to a Claude model.

`PHASE_BODIES` is a total `Record<SleepPhase, PhaseBody>` (`packages/sleep/src/phases/index.ts:29-47`), so a phase named in `SLEEP_PHASES` without a body is a compile error, not a run that skips it.

## 2. Per-phase isolation

A phase that fails is caught with `Effect.result` and recorded as `failed`, and the phases after it still run (`packages/sleep/src/run.ts:703-735`). Measured: with `state-export` failing, `report` still ran and committed. The reason is the alternative: the predecessor system ran thirteen phases in one transaction, so one failure discarded the twelve that had succeeded.

`HARD_PREREQUISITES` lists the exceptions as literal pairs: 18 as of v0.15.1 (`packages/sleep/src/contract.ts:108-127`). A phase whose prerequisite failed is recorded `skipped`, and its body never runs (`packages/sleep/src/run.ts:674-690`). `preflight` is a prerequisite of all sixteen phases after it, and `dedup-merge` of `compress` and `retention-triage`.

**Preflight refuses four states:** a dirty tree, an `EmbedModelMismatch`, an `IndexStale` index, and a `VectorCoverageLow` vector plane (`packages/sleep/src/phases/preflight.ts:54-64`). Each makes every later commit wrong, not merely incomplete. A dirty tree means a later phase commits the operator's uncommitted bytes under sleep's trailers. A model mismatch is a half-migrated vector space whose cosines look plausible and are wrong. A stale index is a rebuild that did not finish, so every count describes a fragment. Low coverage means every cosine pass compares a sample of the corpus with itself and calls the rest unique.

All four would end in a corrupt run with a green report, which per-phase isolation cannot catch, so a failed preflight skips everything after it. Measured on a dirty tree: preflight failed with `DirtyTree`, the other sixteen phases were skipped, and the branch was left with no commits.

The coverage check applies only when the vector plane is in use: some vector exists, or an embedder is bound (`packages/sleep/src/phases/preflight.ts:60`). Below the hard floor of 0.5 preflight fails; below `MEMHTML_VECTOR_COVERAGE_FLOOR` (default 0.95) it warns and continues (`packages/sleep/src/phases/preflight.ts:62-68`). So a lexical-only store under `MEMHTML_EMBED=off` runs. A store under the default `MEMHTML_EMBED=on` with no credential writes no vectors, so preflight refuses it and names `MEMHTML_EMBED=off` as the opt-out (`packages/index/src/vector-coverage.ts:66-74`).

`dedup-merge` gates `compress` and `retention-triage` because both are meant to work on the post-merge set. That is why it isolates each model call: a batch whose answer comes back malformed is counted and skipped, so one bad payload cannot take two later phases down with it (`packages/sleep/src/batch.ts:259-268`).

On a failed phase, the runner resets the whole staging area and, when git can report which paths the phase made dirty, checks those out from `HEAD` and removes the ones it created; a path already dirty before the phase started keeps its bytes (`packages/sleep/src/run.ts:781-817`). Commits the phase already made stay, and so do its writes to `index.db` and `state.db`.

A run with any failed phase exits 1, whether one phase failed or all did (`apps/cli/src/run.ts:318-319`). The output is still the `sleep.report` shape with every phase's result: a caller reading the exit code asks one question, "did the curation happen?", and the payload says which case it was. `sleep status` and `sleep review` exit 0 even for a failed run, because they report a run they did not perform (`apps/cli/src/run.ts:314-317`).

After a failed run, the runner checks out the branch it started from, so later writes do not land on the sleep branch (`packages/sleep/src/run.ts:249`, `:481-509`). Measured after the failed preflight: `HEAD` was back on `main`, with the operator's edit still in the tree. A run started from a detached `HEAD` stays on the sleep branch with a warning. Nothing on `main` is rolled back, because `main` never moved.

### The pending-mark ledger

Some writes outlive a deleted branch. Neither `.memhtml/state.db` nor the `index.db` tables a rebuild keeps follow a branch, so a row written there during a phase survives the branch that earned it. For the consolidation watermark, `trace_consolidations` in `index.db`, that loses data: the watermark is an anti-join, so a session it covers is never selected again, even when the branch that consolidated it was discarded.

So a phase records such a write instead of making it. The record goes into `.memhtml/sleep/sleep-<date>.pending.jsonl`, named for the run id with `/` replaced by `-`, and is committed on the run's branch (`packages/sleep/src/contract.ts:496-497`). Lines are appended and deduplicated by their text, so a resume that records a mark again appends nothing (`packages/sleep/src/contract.ts:556-569`). As of v0.15.1, three phases write it: `entity-resolution`, `edge-typing`, and `trace-consolidation`.

Four kinds of line land there (`packages/sleep/src/contract.ts:423-487`). Three are deferred writes: `session-consolidated`, `edge-promoted`, and `entity-promoted`. The fourth, `commitment-below-floor`, keeps a commitment the consolidator scored below `COMMITMENT_FLOOR` (0.7), so the floor's refusals can be reviewed and not only counted (`packages/sleep/src/phases/trace-consolidation.ts:205`). The merge applies it as nothing.

The ledger is a committed file rather than a table for the reason trailers are the resume mechanism: a run's facts are its commits. `sleep merge` reads it as a blob at the branch tip, not from the working tree, which might hold a file a discarded run of the same date left behind (`packages/sleep/src/review.ts:549-555`).

The merge applies the marks after the branch lands and reports `marksPending` and `marksApplied` (`packages/sleep/src/review.ts:351`). A difference between the two is a plane write that did not land. A failed apply does not fail the merge, because `main` has already moved (`packages/sleep/src/review.ts:565-571`). The sessions in the shortfall are read again on a later run, at the price of a model call.

Corroboration counters stay at phase time on purpose (`packages/sleep/src/phases/entity-resolution.ts:916-921`). `detections` counts sightings, and a run whose model proposed a merge made that sighting even if its branch is discarded. Deferring the bump would undercount the evidence the two-detection gate exists to collect.

## 3. Commit trailers are the resume mechanism

Every phase commit carries three trailers: `Memhtml-Run`, `Memhtml-Phase`, and `Memhtml-Counts`, the last being the phase's counts as one line of JSON (`packages/sleep/src/contract.ts:140-142`, `packages/sleep/src/commit.ts:23-31`). The body is indented two spaces, so body text cannot be read as a trailer (`packages/sleep/src/commit.ts:51-55`). Measured: every commit of a fixture run carried all three.

`memhtml sleep resume <run-id>` reads the run row for its `base_sha`, checks out the branch, and reads `Memhtml-Phase` over `base..HEAD` (`packages/sleep/src/run.ts:298-324`, `:858-874`). It runs every phase with no trailer and reports the others `skipped` with `already completed on this branch` (`packages/sleep/src/run.ts:356-376`). So a phase that finished without committing runs again, and a phase that committed once and then failed is skipped.

The `sleep_phases` table does not decide. Measured: with a run's `sleep_phases` rows deleted, a resume still skipped the phase that had committed, and reran `preflight`, which never commits. A journal table would be a second record, and the two disagree exactly when it matters: when a process dies after `git commit` and before the row is written. The commit is the fact, and a failed write to the row never fails a run (`packages/sleep/src/run.ts:959-963`).

The run row is still required, because its `base_sha` bounds the range; without it the scan would reach an earlier merged run's trailers. A resume of a run with no row aborts and writes nothing (`packages/sleep/src/run.ts:298-310`). The CLI's `sleep resume` takes no flags, so a resume does no deep work and uses the default `--trace-sessions` (`apps/cli/src/run.ts:655-661`).

## 4. The curation phases exclude tasks

A `task` memory is kept out of every curation decision. The exclusion is `SLEEP_EXCLUDED_TYPES`, applied in the SQL that selects candidates and through `isSleepExcluded` where a phase filters rows itself (`packages/sleep/src/sql.ts:41-45`). Measured with the model off: a task naming `service:Checkout API` kept that spelling while the same run normalized a memory's copy, the task got no `memhtml-confidence` stamp, and a run that evicted a stale episodic memory left the task in place.

Tasks are not invisible to sleep. The five detectors write and close detected tasks (section 10), `integrity` repairs hrefs in task files and lists them, and `state-export` exports every access row, a task's included.

In `relationship-mining` the reason is the graph firewall (`packages/sleep/src/phases/relationship-mining.ts:83-95`). Mined edges carry `edge_class = 'memory'`, so a task endpoint would put task edges into PageRank and the retention scorer's bridge count, and the `edges` CHECK cannot refuse a well-formed `relates_to`.

In `retention-triage` the reason is that a task leaves the active tree one way, by being finished, so eviction would archive owed work (`packages/sleep/src/phases/retention-triage.ts:36-38`). The scorer would not floor an idle task anyway: a task's half-life is `null`, so its recency never decays.

The exclusion also keeps detection from being circular. A detected task is an ordinary `task` file, so it inherits every firewall when it lands: no phase bands it for eviction, no mined edge reaches it, and `task-detection`'s own scan cannot see it (`packages/sleep/src/sql.ts:151-163`).

## 5. Thresholds and caps

| Constant                                                      | Value                   | Location                                                 |
| ------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| Near-duplicate cosine (strict) / merges per phase run         | 0.92 / 100              | `packages/domain/src/merge.ts:22-25`                     |
| Dedup recall floor / component size / components per run      | 0.86 / 8 / 300          | `packages/sleep/src/phases/dedup-merge.ts:130-169`       |
| Dedup members per model call                                  | 40                      | `packages/sleep/src/phases/dedup-merge.ts:178`           |
| Entity auto-merge / review ratio                              | 0.85 / 0.75             | `packages/sleep/src/phases/entity-resolution.ts:87-90`   |
| Entity cluster confidence / detections / names per call       | 0.7 / 2 / 500           | `packages/sleep/src/phases/entity-resolution.ts:99-108`  |
| Mining cosine / pairs per file / pairs per pass               | 0.85 / 5 / 2000         | `packages/sleep/src/phases/relationship-mining.ts:40-60` |
| Edge-typing cosine / pairs per file / candidates / detections | 0.80 / 5 / 200 / 2      | `packages/sleep/src/phases/edge-typing.ts:117-140`       |
| Edge-typing pairs per call / edges written per phase run      | 30 / 50                 | `packages/sleep/src/phases/edge-typing.ts:114`, `:150`   |
| Confidence commit delta                                       | 0.005                   | `packages/domain/src/decay.ts:146`                       |
| Compress members per call / candidates per pass               | 8 / 2000                | `packages/sleep/src/phases/compress.ts:94-103`           |
| Task-detection scan / members per call / confidence           | 200 / 20 / 0.7          | `packages/sleep/src/phases/task-detection.ts:64-88`      |
| New detected tasks per run, across detectors                  | 10                      | `packages/sleep/src/tasks.ts:224`                        |
| Retention bands                                               | keep > 0.7, evict ≤ 0.3 | `packages/domain/src/retention.ts:144-145`               |
| Reprieve floor / days / reprieves per memory                  | 0.5 / 14 / 3            | `packages/domain/src/retention.ts:282-292`               |

Each cap is scoped as its label says, and reprieves per memory counts over the memory's whole life, in its `memhtml-reprieves` meta (`packages/sleep/src/phases/reprieve.ts:56`, `:74`). A resume gets a fresh detected-task budget, and so does a second run on the same date (`packages/sleep/src/run.ts:179`, `:335-343`).

## 6. The retention scorer

`scoreRetention` combines eight normalized signals under a weight profile chosen by memory type: five typed profiles and a default (`packages/domain/src/retention.ts:188-189`, `:272-276`). Every profile sums to 1.0, which keeps the composite in `[0, 1]` (`packages/domain/src/retention.ts:199-200`). A band boundary belongs to the lower band, so the three bands partition `[0, 1]` with no gap and no overlap (`packages/domain/src/retention.ts:265-269`).

The recency curve uses `LN2`, so the half-life is the curve's definition (`packages/domain/src/retention.ts:137`). Age runs from a file's `memhtml-updated` to the run date (`packages/sleep/src/retention.ts:117`). Half-lives are set per type, and `procedural` and `task` have none: a working procedure does not go stale with age, and age says nothing useful about intended work (`packages/domain/src/retention.ts:110-126`).

## 7. The merge veto

`mergeVetoed` is the disjunction of three symmetric divergence predicates: a negation flip, a numeric-token flip, and a variant-qualifier flip (`packages/domain/src/merge.ts:207-225`). Cosine similarity is geometric, and embedding models are weakest on the tokens that carry polarity and tell variants apart, so "the deploy step is safe" and "the deploy step is NOT safe" can score as near-duplicates. The merge keeps the older file, so a blind merge would fold a newer correction into the older wrong memory.

The predicates read different text (`packages/domain/src/merge.ts:27-47`, `:207-218`). The numeric predicate reads only the one-line `gist`, because a body cites evidence, and two honest statements of one fact rarely cite the same date or ticket id. Negation and variant qualifiers read gist and body together: their markers are rare words a body does not carry by accident.

The role guard in `mergeOutcomes` fixes each committed pair's roles for the batch (`packages/domain/src/merge.ts:266-307`). A dropped file cannot be dropped again or become a keeper, and a keeper cannot later be dropped. Without it, `(gf, a)` then `(b, gf)` would both commit, superseding `a` into a file the same batch archived. A keeper may keep again, so a group of duplicates folds into its oldest member in one run. Guard skips are counted as `roleGuarded`, apart from `vetoed`.

Every proposal, a model's included, passes the cap, the similarity threshold, the veto, the self-merge check, and the role guard, in that order (`packages/domain/src/merge.ts:280-295`).

With a model bound, `dedup-merge` mines a wider set at 0.86, adds pairs that share a frame key, builds connected components, and asks the model to partition each into merge groups (`packages/sleep/src/phases/dedup-merge.ts:292-297`, `:373-408`, `:453-462`). The model answers only "which of these are the same memory?". It never chooses the keeper: that is the member with the lowest corpus offset, and `activeCorpus` reads oldest first (`packages/sleep/src/sql.ts:121-128`).

Group pairs go through `mergeOutcomes` with the similarity threshold at 0, so a model can fold a pair between 0.86 and 0.92 that no cosine could settle (`packages/sleep/src/phases/dedup-merge.ts:537-538`). That band is what the model is for. The veto, the role guard, and the cap still apply, so a model that groups a claim with its negation is refused by the predicate that refuses a blind cosine.

Group pairs are offered first, then the mined pairs above 0.92 that touch no grouped file (`packages/sleep/src/phases/dedup-merge.ts:531-536`). Where the two disagree about a file, the model's group decides, because the model read both files. The cost: a pair the no-model path would fold is dropped when either file is in a group, even if that group's pairs are then vetoed, so binding a model can make one run fold less.

With no model bound, the phase mines at 0.92, orients each pair oldest first, and hands the pairs to the same filter (`packages/sleep/src/phases/dedup-merge.ts:292-331`). That is the deterministic floor: a run with no credentials still folds the duplicates a cosine can show, up to the cap of 100.

## 8. Entity resolution decides on centroids, not on character overlap

`entity-resolution` runs a deterministic pre-pass, a model core, and a deterministic post-pass (`packages/sleep/src/phases/entity-resolution.ts:628-1118`). The pre-pass normalizes every name, merges names that normalize together, and auto-merges pairs at or above 0.85 character similarity (`packages/sleep/src/phases/entity-resolution.ts:736-779`). With no model bound, that is the whole phase.

The similarity is the longest common subsequence over the mean length (`packages/sleep/src/phases/entity-resolution.ts:187-208`). It rises with shared ordered characters, which is what a separator or casing change is. It misses the case the phase exists for: a short name against its full form scores far below the 0.75 review band, and `dana` against `dana example` is 0.500.

What separates two spellings of one person from two different services is what is written under each name: the centroid of the vectors of every memory claiming it (`packages/sleep/src/phases/entity-resolution.ts:345-352`). The centroid is evidence for the model, not a threshold. The package's test fixture shows why, under the deterministic embedder: two services at 0.9333, and one person's two spellings at 0.7788 (`packages/sleep/tests/fixture.ts:441-445`). Any cosine floor that merged the person would fuse the services first.

With a model bound, the names of one entity type go to one structured clustering call, capped at the 500 names with the most files (`packages/sleep/src/phases/entity-resolution.ts:752-759`). Each name is shown with up to three memory titles, its three nearest centroid neighbors, and, for a person, the `memhtml-alias` values the person file declares (`packages/sleep/src/phases/entity-resolution.ts:146-152`).

The post-pass is code. A weight-then-lexicographic rule over the corpus's own file counts picks the surviving name, never the model (`packages/sleep/src/phases/entity-resolution.ts:230-265`). A cluster whose `canonicalKey` is not one of its own members is dropped (`packages/sleep/src/phases/entity-resolution.ts:863-874`). The character pass, the declared aliases, and the model feed one union-find, so no two passes disagree about the survivor.

Evidence decides how fast a merge applies. A merge backed by a declared alias, such as `<meta name="memhtml-alias" content="dana">` on a person file, applies in the run that finds it, because it is a human's or a directory's assertion (`packages/sleep/src/phases/entity-resolution.ts:766-779`). A merge the model alone proposes must clear the 0.7 confidence floor, is counted in `state.entity_corroboration` (`packages/sleep/src/sql.ts:864-874`), and applies only at two detections (`packages/sleep/src/phases/entity-resolution.ts:916-926`).

Two detections means two different run dates. The counter rises only when the run's instant, 00:00 UTC on its `--date`, differs from the one stored with the last detection. Measured on the built SQL over the real migrations, detections dated D, D again, a resume on D, and D+1 gave 1, 1, 1, 2, and a later run dated D gave 3. A dry run binds no model here, so it makes no detection (`packages/sleep/src/phases/entity-resolution.ts:700`).

Every band that does not merge is counted instead. A pair in the 0.75 to 0.85 band that the model did not cluster, and a cluster below the confidence floor, land in `reviewCandidates` and become detected tasks (`packages/sleep/src/phases/entity-resolution.ts:902-913`, `:972-986`). An entity merge is a one-way door on stored identity: no later commit separates two subjects whose memories were fused.

## 9. Edge typing runs in four separated stages

`edge-typing` runs a SQL scan with no model, a deterministic batching step, one isolated model call per batch, and a promotion the model never makes (`packages/sleep/src/phases/edge-typing.ts:215-562`). The scan unions relationship mining's derived `relates_to` edges with pairs that share an entity at or above 0.80 cosine, excludes tasks, and keeps the 200 strongest (`packages/sleep/src/phases/edge-typing.ts:182-230`). Neither set holds the other: two memories about one incident that name no common entity are invisible to the entity join and obvious to the embedder.

Pairs are sorted by the deepest directory both endpoints share and sliced at 30 per call, so related pairs land together and the call count is `ceil(pairs / 30)` (`packages/sleep/src/phases/edge-typing.ts:332-339`). The directory is a sort key and not a batch boundary, because each pair is judged on its own two memories. One call types its batch over `caused_by`, `leads_to`, `example_of`, `supports`, `part_of`, `contradicts`, and `none`, plus a direction, and a malformed answer skips only that batch.

Code decides what is written. A directional rel at or above the 0.7 confidence floor goes into the subject's file alone, in the direction the model named (`packages/sleep/src/phases/edge-typing.ts:541-562`, `packages/sleep/src/llm.ts:106-111`). It has no corroboration gate, because a `part_of` carries no retention penalty and is cheap for a reviewer to delete. One phase run writes at most 50 edges, promoted contradictions included, which bounds what one commit asks a reviewer to read (`packages/sleep/src/phases/edge-typing.ts:487`, `:542`).

`contradicts` keeps its gate. It is symmetric, so its direction is ignored; at or above the floor it bumps the corroboration counter, and it is written into both files only at two detections on different run dates (`packages/sleep/src/phases/edge-typing.ts:445-518`). One machine detection therefore cannot reach the retention penalty, which counts only edges in the files. The bump and the promotion decision are one statement's `RETURNING`, so two processes racing on a pair cannot both read one detection and both decline (`packages/sleep/src/sql.ts:697-705`).

`none`, or anything below the floor, writes nothing and leaves the pair a mined `relates_to`. A promoted `contradicts` asserts the conflict and stops there: nothing is superseded, closed, or archived. Choosing the winner is a one-way door on stored belief, and it belongs to an agent or a human.

## 10. Detected tasks are proposals with evidence

As of v0.15.1, five phases mint task files, through one shared module (`packages/sleep/src/tasks.ts:403-498`). A task already has its own lifecycle and a standing exclusion from curation, so a detected task needs no new artifact class. Three detectors read a decision a run declined: `entity-resolution` defers a name pair in the review band or below the confidence floor, `dedup-merge` a near-duplicate pair the veto refused, and `edge-typing` a contradiction at one detection. `trace-consolidation` turns a commitment in a transcript into a task, and `task-detection` asks which of the 200 most recently updated memories record open work.

**The key is the path.** A finding's digest is the filename, `areas/inbox/tasks/det-<12 hex>-<slug>.html`, hashed from the detector's name and its finding (`packages/sleep/src/tasks.ts:258-272`). A later run refreshes the task's `memhtml-updated` instead of opening a duplicate, and that survives an index rebuild. The content hash cannot serve, because the active-content uniqueness index excludes tasks: two tasks with identical bodies are two work items (`packages/index/migrations/0008_tasks.sql:126-127`).

**Quoted evidence is checked in code.** A cited sentence is looked up, whitespace-collapsed, in the file it names, and the mint is refused when it is absent (`packages/sleep/src/tasks.ts:736-748`). A detector citing a measurement, such as a similarity ratio or a veto predicate, says so in the evidence type, since no sentence in the corpus states it.

**Ten new tasks per run, across every detector.** The budget is a value the run creates and passes through `PhaseEnv`, so two runs in one process hold two budgets (`packages/sleep/src/run.ts:179`). A refresh costs nothing, and overflow is counted rather than dropped silently (`packages/sleep/src/tasks.ts:445-448`).

**Author separation.** Every detected task carries `memhtml-author: agent:sleep` and the tags `detected` and the detector's name (`packages/sleep/src/tasks.ts:473-479`), so a human's queue and the machine's are told apart by metadata.

**Self-cleaning.** A finding that stops appearing has its task stamped `done`, tagged `machine-closed`, and archived (`packages/sleep/src/tasks.ts:530-550`). The sweep runs only in a phase run that judged its whole candidate set, because a throttled phase cannot tell "the finding is gone" from "I was never asked". `trace-consolidation` has no sweep; it closes a detected task when a transcript reports the work done (`packages/sleep/src/phases/trace-consolidation.ts:534`).

## 11. Graph analysis runs in TypeScript

`pagerank` and `labelPropagation` implement PageRank by power iteration and community detection by label propagation (`packages/domain/src/graph.ts:76`, `:164`). Determinism is a correctness requirement: these scores feed the `pagerank` and `bridgeImportance` signals, so a reordering between runs would change which memories are evicted from a graph that did not change. So the code sorts nodes before iterating, folds parallel edges to their maximum strength, breaks label ties lexicographically, and names each community by its smallest member path.

A community below three members collapses to `undefined`, because a pair passed off as a community would make every cross-pair edge look like a bridge (`packages/domain/src/graph.ts:228-231`). `bridgeCounts` gives a node in no community a count of 0 rather than its full degree (`packages/domain/src/graph.ts:242-257`).

## 12. The model phases

There is one call contract with two wire dialects behind it (`packages/llm/src/wire.ts:147-155`). The Anthropic dialect is the Messages API with a forced tool. The OpenAI dialect is the chat-completions body with a `json_schema` `response_format` marked `strict: true`, whose constrained decoding makes an off-schema answer impossible at generation time (`packages/llm/src/wire.ts:229-236`).

Both responses converge on one shape and one strict decode, which fails with a typed error on a violation (`packages/llm/src/structured.ts:131-160`). It makes one repair first: a field the model double-encoded as a JSON string is unwrapped and decoded again under the same schema.

The structured phases default to `gpt-5.6-sol` for that constrained decoding (`packages/sleep/src/env.ts:88-97`). The source records that the Claude 5 models reject `strict` on Bedrock, so with them the schema is checked only at the decode, and a violating answer is a skipped batch (`packages/sleep/src/env.ts:77-78`). Every model id is a `global.` inference profile (`packages/llm/src/models.ts:50-86`). `thinking` is sent for two of the three Claude models and omitted for Sonnet 5, where sending it is a validation error (`packages/llm/src/models.ts:112-117`).

Each model call is isolated: a malformed response skips its batch and is counted (`packages/sleep/src/batch.ts:259-283`). The kernel phases bound their calls through candidate limits and batch sizes; `arc-synthesis` makes one writing call per arc its triage names, with no fixed cap. Isolation is what makes wider batches safe, so each phase sizes its batch for the answer's attention rather than the context window: 30 pairs for edge typing, 40 members for dedup, 20 for task detection, and 8 for compress.

`arc-synthesis` splits triage from execution, because one call asked both to choose and to write produces content for arcs it should have skipped, and writing is the expensive half (`packages/sleep/src/phases/arc-synthesis.ts:106-118`, `:190-206`).

`compress` archives a member only when the model names it as absorbed, so an omitted member stays active (`packages/sleep/src/phases/compress.ts:380-393`). A dated `episodic` record, one with a `day` facet, is never archived by compress: it is summarized, linked from the canonical, and stamped `part_of` it (`packages/sleep/src/phases/compress.ts:438-446`, `packages/sleep/src/sql.ts:69-92`). Retention triage and dedup-merge have no such exemption.

## 13. Generated artifacts and merge conflicts

The per-directory `index.html` files and the root `sitemap.xml` are generated. Only `memhtml publish` and the `integrity` phase write them, through one `generateArtifacts` (`apps/cli/src/publish.ts:63-74`, `packages/sleep/src/phases/integrity.ts:36-41`). Measured: a fixture had neither file after its synthetic writes, and eleven of them after its first run.

The output is a deterministic function of the index rows (`packages/sleep/src/publish.ts:136-163`). Inside a run those rows are the index preflight refreshed, so the files a run creates or moves reach the listings on the following run.

`memhtml init` marks both names `merge=ours` in `.gitattributes` and sets `merge.ours.driver` to `true` (`packages/store/src/layout.ts:69-76`, `:197`). In a plain `git merge`, a conflict in a generated file then keeps our side's bytes. Nothing regenerates the file during the merge; the next `memhtml publish` or `integrity` run does.

`sleep merge` never reaches that driver, because it refuses any `main` advance that touched a path the branch touched, generated files included (section 15). Measured: after `memhtml publish` on `main`, the merge refused with an overlap of `areas/inbox/index.html`, `resources/people/index.html`, and `sitemap.xml`, though both sides held identical copies of two of the three. Generated files are the likeliest overlap, since the sitemap lists each file's `memhtml-updated` and most runs restamp (`packages/sleep/src/publish.ts:136-152`).

Generated files are not the only paths two clones can both change. `state-export` and `memhtml state export` rewrite `.memhtml/state/access.jsonl` whole, and two clones that run on the same date add the same report and ledger names.

## 14. The integrity phase distinguishes two kinds of dangling href

A dangling href is an authored link to a path the index does not hold. `integrity` reads them from the index and repairs each in one of two ways (`packages/sleep/src/sql.ts:1181-1190`, `packages/sleep/src/phases/integrity.ts:54-99`). An archived target still exists and the edge still says something true, so the href is rewritten to the archive path. That path is derived with `archivePathFor`, not searched for, because the mapping is injective (`packages/contracts/src/paths.ts:213-214`); no rename-similarity score is read.

A target that is simply gone means the edge asserts a relationship to nothing, so it is dropped with a warning; leaving it would produce a dangling row on every rebuild. Measured: a memory linking to one archived and one deleted file came out of a run pointing into `archive/2026/` for the first, with the second removed and the warning `target has no file`.

Years are tried newest first, from the run's year back ten years (`packages/sleep/src/phases/integrity.ts:127-140`). The phase makes at most one commit, holding the repairs and the changed listings.

## 15. Review and the merge gate

`sleep review <run-id>` reports a run without changing it: the phase rows, the commits with their trailers, `git diff --stat base..branch`, and a per-file class of `meta-only`, `body-changed`, `archived`, `created`, or `deleted` (`packages/sleep/src/review.ts:55-98`, `packages/sleep/src/contract.ts:314`). `meta-only` is computed: the article hash is equal on both sides, which the byte-splicing head editors guarantee for a stamp (`packages/sleep/src/review.ts:177-189`).

`sleep merge <run-id>` lands a run on `main` after three checks, in order (`packages/sleep/src/review.ts:256-389`). First, the run must have a row; a run id that names nothing refuses as `no-run` (`packages/sleep/src/review.ts:263-272`).

Second, `main` must not have advanced onto the run's paths. If `main` moved past `base_sha`, the merge diffs both sides from the base and intersects the paths, both halves of every rename included (`packages/sleep/src/review.ts:485-512`). A shared path refuses as `main-advanced` and names the paths in `overlap`; a diff that cannot be read also refuses as `main-advanced`, with no `overlap`, because disjointness has to be proven (`packages/sleep/src/review.ts:280-312`).

A provably disjoint advance merges (issue #108, closed 2026-09-01). An unmoved `main` fast-forwards, and a disjoint advance lands as a merge commit (`packages/sleep/src/review.ts:333-335`, `:521-531`). Measured: a run landed as a two-parent merge after a new memory was written on `main`, and another refused with `overlap: ["areas/inbox/checkout-api-retries.html"]` after `main` linked from a file that run had restamped.

The refusal's reason is semantic, not textual. A run over a corpus that has since changed may have decided against data that no longer exists: a decay computed against a confidence an agent has since corrected, or an eviction of a memory that was just reinforced. Disjointness covers the paths the run wrote, not every row it read. After the measured disjoint merge, `areas/inbox/index.html` on `main` did not list the memory `main` had gained.

Third, the pre-merge gate must pass, or the merge refuses as `gate-failed` (`packages/sleep/src/review.ts:319-331`). Every refusal leaves `main` where it was, applies no marks, and exits 0, so a caller reads `merged` and `refusal`. A landing that conflicts anyway, or fails for another reason, also reports `main-advanced` (`packages/sleep/src/review.ts:336-344`). Measured: merging a dry run's id, which has no branch, refused as `main-advanced`.

After landing, the merge attempts three writes: the pending marks, the run row as `merged`, and `index update` with embedding (`packages/sleep/src/review.ts:351-378`). None of them can fail the merge, and a failed update is reported as `indexUpdated: false`. It does not read the run's status, so a failed or interrupted run's branch can be merged too.

`@memhtml/sleep` takes the gate as a parameter and supplies no default (`packages/sleep/src/review.ts:205-217`), so a package that cannot import the eval package cannot default it silently. The CLI composes it in its own wiring, and `--skip-gate` runs no gate and logs a warning (`apps/cli/src/run.ts:679-708`). The CLI's gate is the discrimination eval in its default fake mode, which measures the ranking stack against a generated fixture corpus and does not read the run's branch (`packages/eval/src/run.ts:67-68`, `:90`, `:186-193`).

A gate that needed live embeddings would make an unattended merge depend on a network call and on credentials. [Testing posture](/internals/testing-posture/) develops the gate itself, and the run-and-review procedure is an operations how-to under [Learn](/learn/).

## 16. Deep sleep: the occasional, budgeted cycle

`memhtml sleep run --deep` trades model cost for reach (issue #63). The default run has a blind spot: `compress` selects only memories with a graph community, communities come from label propagation over memory edges, and mined edges are floored at 0.85 cosine. A memory with no neighbor at that floor is never a compress candidate, however often sleep runs. Deep sleep is for corpora where writes outpaced curation, such as bulk imports.

Under the flag, four mechanisms turn on, and the branch, the review, and the merge stay the same.

- **A grouping band.** `relationship-mining` also mines pairs in `[0.72, 0.85)` as derived `laterally_related` edges, which label propagation uses for the deep partition (`packages/sleep/src/phases/relationship-mining.ts:104-128`). `memoryEdges` excludes them, so retention scoring, PageRank, and bridge counts never see them (`packages/sleep/src/sql.ts:582`).
- **Entity-keyed grouping.** Compress candidates still without a community are grouped by a shared entity, and an entity claimed by more than 64 active files is skipped as a stop-word (`packages/sleep/src/phases/compress.ts:186-216`).
- **Placement triage.** A deep-only phase proposes a directory for each inbox memory still without a community: an existing `areas/<topic>` or `resources/<topic>`, or one of at most five new ones per run (`packages/sleep/src/phases/placement-triage.ts:97`, `:142-151`). It `git mv`s the confident placements and rewrites inbound hrefs in the same commit, and `keep-inbox` is the ordinary answer (`packages/sleep/src/phases/placement-triage.ts:384-408`).
- **Iterate-until-quiet compress.** A pass that folded something re-indexes, re-mines, and folds again, up to three passes, because a canonical is a new neighbor (`packages/sleep/src/phases/compress.ts:513-516`).

Placement never moves a file that a phase's decision already touched on this branch, because a move would fold that edit into a rename a reviewer reads elsewhere. It also refuses a file a touched file links to (`packages/sleep/src/phases/placement-triage.ts:334-341`). A uniform sweep is exempt: `confidence-decay` restamps nearly every file, so counting it would pin nearly every candidate. `SWEEP_PHASES` names the sweeps, and as of v0.15.1 it holds only `confidence-decay` (`packages/sleep/src/contract.ts:218`).

The touched set is the union of the diffs of the run's own non-sweep commits, read from the trailers, so a resumed run reads the same set (`packages/sleep/src/touched.ts:78-113`). `person-links` leaves the article bytes identical and still pins, because the edge it authored is not in the index placement reads to repair inbound hrefs. A read that fails widens to every path in the range, and a set neither read can establish stops the phase before its first model call (`packages/sleep/src/touched.ts:88-133`).

`--max-llm-calls <n>` is one budget for the deep model calls of `compress` and `placement-triage` (`packages/sleep/src/phases/compress.ts:357-361`, `packages/sleep/src/phases/placement-triage.ts:250-253`). When it runs out, the remaining batches are skipped under `budgetSkipped` and nothing fails, because a budget stop and a model outage need different follow-ups. `--dry-run` composes with `--deep`.

Deep sleep never changes how a fold or a move lands: on the review branch, behind the same merge. It never lets the grouping band touch eviction, and it never re-files a task, an arc, or anything outside the inbox (`packages/sleep/src/phases/placement-triage.ts:149-158`).

## 17. Sleep has no schedule

Sleep reads a clock to stamp the run and phase rows, never to decide whether to run (`packages/sleep/src/run.ts:954-956`). There is no scheduler and no default cadence in the package. Inside a run, the one decision a clock reading feeds is the reaper's: at the start of a run, a `running` row older than 20 hours is closed as abandoned (`packages/sleep/src/run.ts:572-585`).

Phases read the run date instead, as a parameter. The CLI defaults it to today in UTC (`apps/cli/src/run.ts:779-781`), and the run's instant is 00:00 UTC on that date (`packages/sleep/src/run.ts:119-123`). The date decides real work: reprieve acts on a `memhtml-valid-until` at or before it, trace consolidation takes sessions quiet for an hour before it, and retention measures age up to it (`packages/sleep/src/phases/reprieve.ts:42-43`, `packages/sleep/src/phases/trace-consolidation.ts:963`, `packages/sleep/src/retention.ts:117`).

Every `memhtml-updated` a run writes into a file is that instant. Measured: a run dated 2026-10-14 stamped `memhtml-updated` as `2026-10-14T00:00:00Z` on files first written later that day, so the stamp moved backward.

The absence of a schedule is deliberate, and sleep's absence from the MCP tool surface follows from it (`apps/mcp/src/tools.ts:30-34`). A run rewrites confidence across the corpus, archives memories, and produces a branch a human is expected to read, so the caller of `memhtml sleep run` owns when it fires.

**Trigger on volume, not on the calendar, for correctness rather than cost.** A model-proposed entity merge applies only at two detections (`packages/sleep/src/phases/entity-resolution.ts:916-926`), and a second detection is evidence only if the corpus changed between the two reads. The counter refuses a detection dated the same as the one before it (section 8), but nothing checks that the corpus changed between two dates. A calendar cannot supply that independence; a volume threshold can.

Volume matters for a second reason: confidence decay is one step per run, not per day. Each run that decays a memory moves its confidence a tenth of the way toward the 0.2 floor (`packages/sleep/src/phases/confidence-decay.ts:72-82`, `packages/domain/src/decay.ts:127-131`). Measured: a second run on the same date lowered a confidence from 0.920 to 0.848. So the cadence sets how fast unconfirmed memories fade, and a run over an unchanged corpus is not a no-op.

What "enough has been written" means is the caller's choice; memhtml owns the signal and not the decision. `memhtml sleep plan` is that signal (`packages/sleep/src/plan.ts:155-317`). It answers "would a run change anything?" without running a phase, from index counts plus the state plane's pending merges. Its signals are memories written since the last run, chunks with no vector, settled transcripts, dangling authored links, and entity merges at one detection (`packages/sleep/src/plan.ts:228-264`).

`--dry-run` is a different thing and not a cheaper one. It refreshes the index and computes the phases' counts without writing, and with a model bound, `dedup-merge` spends its model calls before declining to write.

The plan's verdict has three values. `would-change` means a counted signal is above zero (`packages/sleep/src/plan.ts:301-306`). `no-signal` means every counted signal is zero, every uncountable input is empty, the state plane is attached, and the index describes the checked-out tree; it is the one verdict on which a caller may skip. Everything else is `unknown`.

Some inputs cannot be counted without doing the work: candidate pairs need an n-by-n neighbor scan, communities need label propagation, and retention bands need the scoring pass. The plan reports each one's input size under `unknown` instead of a zero (`packages/sleep/src/plan.ts:266-287`). Those inputs are the memories sleep may curate, so `no-signal` needs a store with no active non-task memory. Measured: an empty, freshly indexed store answered `no-signal`, and a one-memory store after a merged run answered `would-change`.

A stale index would make the plan skip without looking, too. `index.db` is a disposable projection, so after a clone, a `git pull`, or an `rm`, every aggregate reads zero whatever the corpus holds. The plan therefore reads `HEAD` and publishes `indexFresh` beside `indexedCommit` (`packages/sleep/src/plan.ts:168-170`). A `false` there, or an unreadable database, makes `no-signal` unreachable.
