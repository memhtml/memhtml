---
title: The sleep pipeline
description: Seventeen curation phases in a fixed order, each an isolated commit on a branch, with commit trailers as the resume mechanism and a quality gate that can refuse the merge.
---

## 1. Seventeen phases on a branch

The curation run is called sleep. It has no schedule of its own: nothing in the system reads a clock to decide whether to run, so the cadence is the caller's — see [Sleep has no schedule](#17-sleep-has-no-schedule). It executes the phases of `SLEEP_PHASES` in a fixed order — seventeen as of v0.6.0 (`packages/sleep/src/contract.ts:43`) — each producing its own commit on a branch named `sleep/<YYYY-MM-DD>`, suffixed `-2` when it runs a second time the same day (`packages/sleep/src/run.ts:45`). The branch is created before any phase runs, so `main` is never touched (`packages/sleep/src/run.ts:95-97`). A dry run creates no branch, which is safe because no phase writes a file in dry mode.

Figure 1 shows the shape of a run. Both of the gate's outcomes are drawn, because the refusal is the property worth seeing. There is no third outcome and no rollback.

```d2 pad=20 src="_figures/sleep-branch.d2" title="Main branches into sleep/date. The seventeen phases run on that branch and are submitted for review to a gate. The gate has exactly two outgoing arrows: passes, leading to main moves, and refuses, leading to main unmoved. No arrow returns from the branch to main except through the gate."
```

**Figure 1: `main` moves only when a gate that can refuse says so.** The branch is cut before any phase executes, so a failed run needs no compensating writes: the abort is `git branch -D` and `main` never moved. The two boxes leaving the gate are the only two outcomes.

| #  | Phase                 | Model | Git effect                                                                                                              |
| -- | --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| 1  | `preflight`           | no    | none; runs `index update` and snapshots counts                                                                          |
| 2  | `dedup-merge`         | yes   | one commit: keeper gains `memhtml-supersedes`, dropped files `git mv` to archive, vetoed pairs become review tasks      |
| 3  | `entity-resolution`   | yes   | one commit: `memhtml-entity` values normalized and cluster-merged in place, review-band pairs become review tasks       |
| 4  | `person-links`        | no    | one commit: `memhtml-about-person` links to `resources/people/*`                                                        |
| 5  | `relationship-mining` | no    | no commit; derived `relates_to` rows in the index only                                                                  |
| 6  | `edge-typing`         | yes   | one commit: typed edges promoted, corroborated contradictions written, single-detection ones deferred to review tasks   |
| 7  | `confidence-decay`    | no    | one commit: `memhtml-confidence` rewritten for un-reinforced files                                                      |
| 8  | `arc-synthesis`       | yes   | one commit per arc                                                                                                      |
| 9  | `retention-triage`    | no    | one commit: files in the evict band `git mv` to archive                                                                 |
| 10 | `compress`            | yes   | one commit per batch                                                                                                    |
| 11 | `reprieve`            | no    | one commit: `memhtml-valid-until` extended, or the file archived                                                        |
| 12 | `trace-consolidation` | yes   | one commit per distilled memory                                                                                         |
| 13 | `task-detection`      | yes   | one commit: task files for commitments and follow-ups the corpus records                                                |
| 14 | `placement-triage`    | yes   | deep-only (`--deep`): one commit re-filing inbox singletons into topic directories; a run without `--deep` does nothing |
| 15 | `integrity`           | no    | one commit: dangling hrefs repaired, artifacts regenerated                                                              |
| 16 | `state-export`        | no    | one commit: `.memhtml/state/access.jsonl`                                                                               |
| 17 | `report`              | no    | one commit: `.memhtml/sleep/<run-id>.html`                                                                              |

The order encodes six dependencies. Entity resolution precedes person links so that aliases have already merged. Confidence decay precedes retention triage so that triage scores the decayed value. Dedup-merge precedes both compress and retention triage, because both operate on the post-merge set. Task detection precedes integrity, because it writes files and integrity regenerates the directory listings those files belong in. And placement triage sits between the two, after compress and task detection and before integrity: it re-files only what deep grouping could not fold, a move mid-scan would hand the detector paths that no longer hold files, and it moves files whose inbound hrefs it rewrites itself, which integrity's archive-chasing repair cannot do.

Figure 2 draws the four edges among the six phases that carry them. Every phase absent from the figure is order-independent of every other phase, which the table above cannot show.

```d2 pad=20 src="_figures/phase-order.d2" title="Four dependency edges among six phases. Phase 2 dedup-merge points at phase 10 compress and at phase 9 retention-triage, both labelled post-merge set. Phase 3 entity-resolution points at phase 4 person-links, labelled aliases merged first. Phase 7 confidence-decay points at phase 9 retention-triage, labelled scores the decayed value. Dedup-merge, entity-resolution and compress are drawn as hexagons because all three call a model; the other three are deterministic."
```

**Figure 2: four of the ordering edges, drawn over the six phases that carry them.** Eleven of the seventeen phases appear nowhere in this graph, so the order among them is arbitrary and could change without consequence. The three hexagons mark the phases here that call a model, and each one's edge is about that call: `compress` archives a member only when the model names it as absorbed, `dedup-merge` gates both of its dependents on a fold the model proposed and the veto allowed, and `entity-resolution` runs before `person-links` so a person's aliases have already collapsed before a file is minted for them.

The phases of `LLM_PHASES` call a model — eight as of v0.6.0 (`packages/sleep/src/contract.ts:168`). The other nine are deterministic and cost no model call.

Two of the eight still do real work without one, and they degrade differently from the other six. `entity-resolution`'s normalization and character-overlap passes are a pre-stage, so a credential-free run still collapses `Checkout API` onto `checkout api`; what an absent model removes is the decision core, not the phase. `dedup-merge` falls back to the 0.92 cosine floor plus the divergence veto and still commits, so a run with no credentials folds every duplicate a cosine can prove. The other six report a reason and write nothing. `placement-triage` carries a second condition on top of the model: it spends calls only under `--deep`, and a run without the flag returns immediately with a reason.

Seven of the eight judge a group of memories at once and share one batching kernel (`packages/sleep/src/batch.ts`): the phase sorts its rows, the kernel slices them into batches, mints opaque `m1`..`mN` keys over each batch's members, frames the member list as one prompt, and resolves the keys an answer names back to rows. A key the batch never offered resolves to nothing and is dropped, so a model can only ever name a member it was shown, never a path it inferred. The kernel does no sorting of its own and preserves the order it is handed, which is what lets each phase state that its own batch boundaries and prompt bytes are a function of the corpus alone. `trace-consolidation` is the eighth, and it reaches its model through the consolidator rather than through this kernel.

Each batch's call goes out with `cacheSystem` set, so the phase's system prompt and tool schema form a cache-eligible prefix across every batch of the night and only the member list is new bytes per call (`packages/sleep/src/batch.ts:241-248`, `packages/llm/src/wire.ts:76-80`).

`PHASE_BODIES` is a total `Record<SleepPhase, PhaseBody>` (`packages/sleep/src/phases/index.ts:27`), so a name added to `SLEEP_PHASES` without a body is a compile error rather than a run that silently skips it.

## 2. Per-phase isolation

A phase that throws is caught with `Effect.result`, recorded as a value, and the phases after it still run (`packages/sleep/src/run.ts:231`, `packages/sleep/src/run.ts:258`). Thirteen phases inside one transaction would mean one raise discards the twelve that already succeeded.

`HARD_PREREQUISITES` spells the exceptions out one literal pair at a time (`packages/sleep/src/contract.ts:107`), and there are two shapes of them.

**`preflight` gates the whole run: every one of the sixteen phases after it.** A failed preflight therefore commits nothing. It establishes the three preconditions the rest of the night reads, and each failure makes every later commit wrong rather than merely unhelpful: a dirty tree means a later phase commits the operator's own uncommitted bytes under sleep's trailers, an `EmbedModelMismatch` is a half-migrated vector space that degrades every cosine while each individual vector stays well-formed, and an `IndexStale` is an index a rebuild emptied and did not finish repopulating, so every later phase's counts describe a corpus fragment. All three end in the one outcome per-phase isolation is no defense against, a corrupt night with a green report.

`dedup-merge` gates `compress` and `retention-triage`. Both operate on the post-merge set, and running them over a corpus that still holds its duplicates would compress a pair the merge then archives half of.

That prerequisite is why `dedup-merge` isolates each of its model calls rather than failing on one. It batches components, and a batch whose call comes back malformed is counted and skipped, so a single bad tool payload cannot take two later phases down with it.

A failed phase's staged files are unstaged (`packages/sleep/src/run.ts:283-290`), which isolates the failure in the tree as well as in the report. A partial stage would make the next phase's commit carry the failed phase's half-finished work.

A run whose selected phases all failed exits 1, and so does a run that lost only some of them, while the envelope stays the `sleep.report` success shape carrying the full per-phase report (`apps/cli/src/run.ts:284`). A caller reading the exit code is asking one question — did the curation this invocation was for happen — and both answers are no; the difference between them is already stated precisely in the payload, an abort being every selected phase `failed` with `headSha === baseSha` and no commits. `sleep status` and `sleep review` are excluded, because a read that exited non-zero over a run it merely describes would make "tell me what happened" indistinguishable from "I could not tell you".

Nothing is rolled back. `git branch -D` is the abort, and `main` never moved (`packages/sleep/src/run.ts:29-31`).

### The pending-mark ledger

Two writes escape that abort by their nature, so they are deferred rather than performed. `.memhtml/state.db` is not rebuildable from the tree and `trace_consolidations` survives an index rebuild by construction, so a state-plane row written DURING a phase outlives the branch that earned it. For the consolidation watermark that is data loss rather than bookkeeping: the watermark is an anti-join, so a session it covers is never selected again, and a discarded branch would leave the transcript gone behind a row asserting it was handled.

So a phase records the write instead of making it, in `.memhtml/sleep/<run-id>.pending.jsonl` — a committed artifact on the run's own branch, one JSON line per earned write, appended and deduplicated by the rendered line so a resume re-recording a mark it already earned appends nothing (`packages/sleep/src/contract.ts:306`, `:351`). Three kinds land there: `session-consolidated` (a `trace-consolidation` watermark), `edge-promoted`, and `entity-promoted`. The ledger is a committed file rather than a table for the reason the trailers are the resume mechanism: a run's facts are its commits, and a table would be a second record that disagrees exactly when it matters, on a branch that was reviewed and thrown away.

`merge` reads that ledger as a blob at the branch tip — not off the working tree, which would also honor a file a discarded run of the same date left behind — and applies it after the fast-forward succeeds, reporting both `marksPending` and `marksApplied` on the `sleep.merge` envelope (`packages/sleep/src/review.ts`). Two numbers rather than one, because they answer different questions: the branch earned the first and the plane took the second, so a merge where they disagree is the operator-visible reading of a plane write that did not land. A failed apply does not fail the merge — `main` has already moved and the memories are landed — so the shortfall is reported and logged instead, and the sessions in it stay unconsolidated and are re-read on the next cycle at the price of a model call.

Corroboration counters deliberately stay at phase time. `detections` counts nights on which a model read the corpus and proposed the merge, and a discarded night did both, so deferring that bump would undercount the evidence the two-night gate exists to accumulate.

## 3. Commit trailers are the resume mechanism

Every phase commit carries `Memhtml-Run`, `Memhtml-Phase`, and `Memhtml-Counts` trailers (`packages/sleep/src/contract.ts:139-141`, `packages/sleep/src/commit.ts:22-30`), and `resume` reads the set of completed phases out of `git log base..HEAD` rather than out of the `sleep_phases` table (`packages/sleep/src/run.ts:138-145`, `packages/sleep/src/run.ts:334`).

A journal table that a resume depended on would be a second record of what happened, and the two records disagree exactly when it matters, namely when a process is killed after `git commit` and before the row is written. The commit is the fact, the row is a convenience the history can regenerate, and a failed reporting write never fails a run (`packages/sleep/src/run.ts:434-439`).

A resume reports already-done phases explicitly as `skipped`, so its report still accounts for all seventeen (`packages/sleep/src/run.ts:176-191`).

## 4. Every phase excludes tasks

`packages/sleep/src/sql.ts:36` applies the exclusion, and the reason differs by phase.

In `relationship-mining` it is the graph firewall. Mined edges are written with `edge_class = 'memory'`, so a task endpoint would put a task into PageRank, the diversification pass, and the retention scorer's bridge count. The `edges` CHECK cannot refuse it, because `relates_to` under `memory` is well-formed whatever files sit at its ends (`packages/sleep/src/phases/relationship-mining.ts:32-38`).

In `retention-triage` the reason is the score itself. Recency and access dominate it, so a task untouched for a month scores at the floor, and that is exactly the task most likely to still be owed. Evicting on that signal would archive the neglected work first and leave the busy work behind (`packages/sleep/src/phases/retention-triage.ts:24-28`).

Four phases WRITE tasks, and the exclusion is what makes that safe rather than circular. A detected task is an ordinary `task` file, so it inherits every firewall above the moment it lands: no phase scores it, no edge reaches it, and `task-detection`'s own scan cannot see it, which is why a detector cannot restate its own queue every night (`packages/sleep/src/tasks.ts`).

## 5. Thresholds and caps

| Constant                                                  | Value                   | Location                                                 |
| --------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| Near-duplicate cosine / merges per cycle                  | 0.92 strict / 100       | `packages/domain/src/merge.ts:22-25`                     |
| Dedup recall floor / component cap / components per night | 0.86 / 8 / 300          | `packages/sleep/src/phases/dedup-merge.ts:103-142`       |
| Dedup members per call                                    | 40                      | `packages/sleep/src/phases/dedup-merge.ts:151`           |
| Entity auto-merge / review ratio                          | 0.85 / 0.75             | `packages/sleep/src/phases/entity-resolution.ts:65-68`   |
| Entity cluster confidence / detections / shard            | 0.7 / 2 / 500           | `packages/sleep/src/phases/entity-resolution.ts:77-86`   |
| Mining cosine / k / sample                                | 0.85 / 5 / 2000         | `packages/sleep/src/phases/relationship-mining.ts:22-32` |
| Edge-typing cosine / k / candidates / detections          | 0.80 / 5 / 200 / 2      | `packages/sleep/src/phases/edge-typing.ts:89-112`        |
| Edge-typing pairs per call / promotions per night         | 30 / 50                 | `packages/sleep/src/phases/edge-typing.ts:86`, `:122`    |
| Confidence commit delta                                   | 0.005                   | `packages/domain/src/decay.ts:135`                       |
| Compress batch / candidates                               | 8 / 2000                | `packages/sleep/src/phases/compress.ts:46-55`            |
| Task-detection scan / batch / confidence                  | 200 / 20 / 0.7          | `packages/sleep/src/phases/task-detection.ts`            |
| Detected tasks per night, across detectors                | 10                      | `packages/sleep/src/tasks.ts`                            |
| Retention bands                                           | keep > 0.7, evict ≤ 0.3 | `packages/domain/src/retention.ts:144-145`               |
| Reprieve floor / days / max                               | 0.5 / 14 / 3            | `packages/domain/src/retention.ts:277-287`               |

## 6. The retention scorer

`packages/domain/src/retention.ts:267` combines eight normalized signals under a weight profile chosen by memory type.

Every profile's eight weights sum to exactly 1.0 under compensated summation (`packages/domain/src/retention.ts:199`), which is the convexity fact the composite's `[0, 1]` range rests on. Band boundaries belong to the lower band, so the three bands partition `[0, 1]` with no gap and no overlap (`packages/domain/src/retention.ts:260`).

The recency curve uses `LN2` rather than a `0.693` literal, which makes the half-life the definition of the curve, so a test can assert an equality instead of a tolerance (`packages/domain/src/retention.ts:131-137`). Half-lives are set per type, and `procedural` and `task` are `null`: a working procedure does not go stale with age, and age is actively misleading about intended work (`packages/domain/src/retention.ts:110-126`).

## 7. The merge veto

`packages/domain/src/merge.ts:175` is the disjunction of three symmetric divergence predicates: a negation flip, a numeric-token flip, and a variant-qualifier flip. Any one of them vetoes a merge.

Cosine similarity is geometric, and embedding models are weakest on exactly the tokens that carry polarity and discriminate between variants, so "the deploy step is safe" and "the deploy step is NOT safe" sit above 0.92. The merge keeps the older file, so a blind high-cosine merge folds a newer correction into an older wrong memory. That restores the error the correction was written to fix (`packages/domain/src/merge.ts:1-13`).

The in-batch role guard (`packages/domain/src/merge.ts:202-260`) fixes a path's role for the batch: a keeper cannot later be dropped, and a dropped file cannot later be a keeper. Both directions are needed. Recording only the drop side leaves a corruption in place: given the pairs `(gf, a)` and then `(b, gf)`, both decisions commit, `gf` absorbs `a` and is then archived into `b`, so `a`'s content is superseded into a file the same batch destroyed.

The veto, the self-merge check, the both-roles guard, and the per-night cap are a post-filter over **every** proposal, including a model's (`packages/domain/src/merge.ts:14-18`). With a model bound `dedup-merge` mines a recall-oriented candidate set at 0.86, unions it with the frame-key exact matches, builds connected components over that union, and asks the model to partition each component into merge groups. Every pair a group implies is then routed through `mergeCandidates`, so the set of pairs that _can_ be committed does not widen when a model is bound: it is the same predicate over a different candidate set. A model that groups a claim with its own negation is refused by the predicate that refuses a blind cosine.

The band between 0.86 and 0.92 is what the model is for. A pair there is one no cosine can settle — high enough that the two memories are about one thing, not high enough that they are provably one claim — and the deterministic path cannot see into it at all. The model answers one question over a component, which of these memories are the same memory, and it never chooses the canonical and never names a write target. Orientation stays arithmetic over corpus order: `activeCorpus` reads oldest-first, so the older path is the keeper by construction, and inside a model-proposed group the keeper is the member with the lowest corpus offset.

Batching makes the both-roles guard carry more rather than less. One answer names several groups, and two groups overlapping on one path is exactly the `(gf, a)` then `(b, gf)` chain arriving from one call instead of from two nights.

Model groups are offered to `mergeCandidates` first, then the mined pairs above 0.92 that no group already claimed. Two properties follow from that order. The deterministic floor never regresses, because every pair the no-model path would have merged is still in the list, so binding a model cannot make a night fold less than it did. And where the two disagree the semantic answer wins the path: a pair above 0.92 whose two files the model instead grouped with a third folds as the model's group, because the guard gives a path to whichever decision claims it first. The model read both files; the cosine read neither.

With no model bound the phase is the deterministic floor, unchanged: it mines at 0.92, orients, and hands the pairs to the same filter. That is not a degraded mode awaiting repair. A night with no credentials still folds every duplicate a cosine can prove, and every count it reports is what this phase reported before it could call a model, which is what makes the existing dedup tests an oracle for the rest.

## 8. Entity resolution decides on centroids, not on character overlap

`packages/sleep/src/phases/entity-resolution.ts:23-62` runs three stages, and the separation is what makes a one-way door safe.

The pre-pass is deterministic and cheap: normalize every name, exact-merge the ones that normalize together, and auto-merge pairs at or above 0.85 character overlap. That pass alone is the whole phase with no model bound, so a credential-free run still collapses `Checkout API` onto `checkout api`. The similarity is the longest common subsequence over the mean length, chosen over Levenshtein because it is monotone in shared ordered characters, which is what a separator or casing change actually is.

Character overlap is measurably wrong on the case the phase exists for. Measured on the live corpus, `laith` against `laith al-saadoon` scores 0.476 and `sanju` against `sanju kumar` 0.625 — below even the 0.75 review band — so a short name and its full form are structurally invisible to a character ratio, and the phase minted two person files for one person. What separates them is not the name string but what is written under each name: the centroid of the vectors of every memory claiming it. Two spellings of one person have near-identical centroids; `checkout-api` and `payments-api` do not, however close their strings or their domain. The same pre-pass computes one centroid per name, in `O(files)` and never per pair.

With a model bound, **all** names of one entity type go into one structured clustering call, sharded at 500, and the model returns a partition into subjects rather than a pair verdict. At the measured 59 entities that is one call where the pair space is 1,711.

The centroid is evidence handed to the model, not a threshold. A cosine floor over centroids would make exactly the mistake a bare character ratio avoids, because two services in one domain are written about in the same terms: on the measured corpus `checkout-api` against `payments-api` sits at 0.9333 while one person's two spellings sit at 0.7788, so any floor that merged the person would fuse the two services first. Each member is offered with its memory count, up to three memory titles, its three nearest centroid neighbors, and — for a person — the `memhtml-alias` values a person file declares.

The post-pass is code. Which name survives is decided by a weight-then-lexicographic rule over the corpus's own file counts and never by the model, because the canonical is every rewrite's target and becomes a person file's path once `person-links` runs. The model's `canonicalKey` is used only for validation: a cluster whose canonical is not one of its own members is a self-contradicting answer and is dropped. All three pair sources — the character pass, the alias oracle, and the model — feed one union-find, so no two passes can disagree about which name survives.

Evidence decides how fast a merge applies. An alias-backed merge commits on night one, because a person file carrying `<meta name="memhtml-alias" content="laith">` is a human's or an authoritative directory's assertion of identity rather than a machine's suspicion. A merge the model alone proposes must clear the 0.7 confidence floor and is then counted in `state.entity_corroboration` (`packages/index/state-migrations/S0002_entity_corroboration.sql`), applying only once two different nights have reached it over independently re-read corpora.

Every band that does not merge is counted rather than merged. The 0.75-to-0.85 character band the model did not cluster, and a cluster below the confidence floor, both land in `reviewCandidates`. An entity merge is a one-way door on stored identity — no later commit separates two subjects whose memories were fused — and the failure mode of an over-eager gate is silent and permanent.

## 9. Edge typing runs in four separated stages

`packages/sleep/src/phases/edge-typing.ts:27-76`: a SQL scan with no model involved, a deterministic batching step, one isolated model call per batch, then a deterministic promotion the model never makes.

The scan is the union of two candidate arms, deduplicated by unordered pair: relationship mining's derived `relates_to` edges, and a shared-entity scan at the cosine floor. Neither arm subsumes the other, so recall is the union rather than whichever signal happens to be stronger in a corpus — two memories about one incident naming no common entity are invisible to the entity join and obvious to the embedder, and a same-entity pair below the mining floor is the reverse. Both arms exclude tasks and anti-join pairs that already carry an authored edge either way.

Batching is what makes the phase affordable. Pairs are sorted by the deepest directory both endpoints share and sliced at thirty pairs per call, so topically related pairs land in one call and the call count is `ceil(pairs / 30)`. The shared directory is the corpus's own topical partition and a pure function of two paths, which is why it is used rather than the graph community: label propagation over the whole edge list would be a second corpus-wide pass for a grouping hint, and it answers `undefined` for every pair in a community below the size floor. The group is a sort key and not a batch boundary, because every pair is judged on its own two memories, so a boundary carries no information the verdict needs and honoring one would cost a call per directory.

One call judges its whole batch over the rel vocabulary `{caused_by, leads_to, example_of, supports,
part_of, contradicts, none}` plus a direction, and each call is isolated: a malformed tool payload skips that batch and is counted, so a night that typed nine batches and lost the tenth has done nine batches of work.

What is written is decided by code. A directional rel above the confidence floor is written into the subject's file alone, per the direction the model named, because a `caused_by` written into the cause instead of the effect says the opposite of what the model answered. There is no corroboration gate on those: a `part_of` carries no retention penalty and is cheap for a reviewer to delete, so a second night's wait would buy nothing. A night promotes at most fifty authored edges across every batch and both kinds, which is the bound on what one commit asks a human to read.

`contradicts` is the exception and keeps the gate it always had. It is symmetric, so its `direction` field is ignored, and above the floor it bumps the corroboration counter and is written into **both** files only at `detections >= 2`. One machine detection therefore cannot reach the retention penalty, which counts only `derived = 0` file-borne edges. The bump and the promotion decision are one statement's `RETURNING` (`packages/sleep/src/phases/edge-typing.ts:325-337`), because two runs racing on one pair would otherwise both read `detections = 1` and both decline to promote. `addLink` is idempotent on the pair, so a re-promotion writes nothing.

`none`, or anything below the floor, writes nothing and leaves the pair a mined `relates_to`. That is the answer an unsure model is told to pick, and it costs the corpus nothing.

The phase detects and stops there. A promoted `contradicts` asserts the conflict: nothing is superseded, no `memhtml-valid-until` is closed, and neither side is archived. Choosing the winner of a contradiction is a one-way door on stored belief, and it belongs to an agent or a human rather than to an unattended run.

## 10. Detected tasks are proposals with evidence

Four phases write task files, and one module holds everything they share (`packages/sleep/src/tasks.ts`). A task is already a memory type with its own lifecycle, its own edge class, and a standing exclusion from every phase, so a detected task needs no new artifact class: it inherits every firewall by being a task.

Each detector reads a decision the night declined to make. `entity-resolution` defers an alias pair inside the 0.75-0.85 character band or below the model's confidence floor. `dedup-merge` defers a near-duplicate pair the divergence veto refused, naming which predicate fired. `edge-typing` defers a contradiction at one detection, below the two-night promotion gate. `task-detection` reads the 200 most-recently-updated memories in batches of 20 and asks which of them record a commitment nobody closed.

Five guards make that safe, and each one is the reason a detected queue is usable rather than noise.

**The key is the path.** A finding's stable digest is the filename stem: `areas/inbox/tasks/det-<12 hex>-<slug>.html`, over the detector's name plus a canonical finding string the detector sorts. So a second night refreshes the `memhtml-updated` stamp instead of opening a duplicate, and the idempotence surface survives `rm index.db && rebuild` with no projection at all. The content hash cannot serve here: `files_content_hash_active` deliberately carves out open tasks, because two open tasks with identical bodies are two real work items.

**Evidence is verified in code, never asked for.** A detector citing a sentence has that sentence looked up in the file it names, whitespace-collapsed, and the mint is REFUSED when it is absent. That is what keeps a model's fabricated sentence out of a file a human then reads as a citation. A detector citing a MEASUREMENT — a similarity ratio, a veto predicate, a detection count — says so in the type, because no sentence in the corpus states one and a quote would have to be manufactured.

**Ten a night, across every detector.** The budget is a mutable value the RUN creates and threads through `PhaseEnv`, not a module counter, so two runs in one process hold two budgets. Overflow is counted rather than dropped silently: a detector pressing on the cap every night is a detector whose threshold is wrong.

**Author separation.** Every detected task carries `memhtml-author: agent:sleep` and the tags `detected` plus the detector's name, so a human's queue and the machine's are told apart by metadata rather than by where they sit.

**Self-cleaning.** A finding that stops appearing has its task stamped `done` and archived through the same machinery `memhtml task status done` uses, with `no longer detected` in the commit body. The sweep runs only on a night that judged its whole candidate set: a phase whose model call was throttled cannot distinguish "the finding is gone" from "I was never asked", and closing on that reading would take a real review out of a human's queue.

## 11. Graph analysis runs in TypeScript

`packages/domain/src/graph.ts:76` and `packages/domain/src/graph.ts:164` implement PageRank by power iteration and community detection by label propagation.

Determinism is a correctness requirement here. These scores feed the `pagerank` and `bridgeImportance` signals, so a run-to-run reordering would change which memories get evicted on a corpus that did not change (`packages/domain/src/graph.ts:1-11`).

The implementation pins every source of ordering. It sorts nodes before iteration, which fixes the floating-point summation order. It folds parallel edges to their maximum strength. Label propagation visits in sorted order and breaks ties lexicographically rather than with a random seed. It canonicalizes each community label to the smallest member path, so two runs produce the same labels as well as the same grouping.

A community below three members collapses to `undefined` (`packages/domain/src/graph.ts:29-30`), because a pair passed off as a community would make every cross-pair edge look like a bridge. `bridgeCounts` gives a node in no community a count of 0 rather than its full degree (`packages/domain/src/graph.ts:236-247`).

## 12. The model phases

There is one call contract with two wire dialects behind it (`packages/llm/src/wire.ts`). The Anthropic dialect is the native Messages API with a forced tool; the OpenAI dialect is the chat-completions body with `response_format: {type: "json_schema", strict: true}`, whose constrained decoding makes an off-schema answer impossible at generation time. Both responses converge on one shape before the decode, which fails with a typed error on any violation rather than coercing the value (`packages/llm/src/structured.ts:64`) — the decode is the contract for both providers, never a trust in either one's enforcement.

The structured phases default to `gpt-5.6-sol` for exactly that constrained-decoding property: the Claude 5 models reject `strict` and `output_config.format` on every Bedrock surface (probed live 2026-08-22), so with them the schema is a request checked after the fact, and a violated answer is a skipped batch. The Converse API is unused here because the effort and thinking rules are per-model and exact, and Converse has no field for either. Every model is reached through a `global.` inference profile — mandatory for the OpenAI entries, whose bare ids reject on-demand invocation — with `thinking` sent for two of the Claude models and omitted for the third, where sending it is a validation error rather than a no-op (`packages/llm/src/models.ts`).

Every phase caps how many calls it makes and isolates each one, so a single malformed response skips its batch and is counted rather than failing the phase (`packages/sleep/src/batch.ts:216-233`). A night that typed nine batches of pairs and lost the tenth has done nine batches of work.

Isolation is what makes the batching safe to widen. A batch is the unit a failure costs, so each phase sizes its batch for the answer's attention rather than for the context window: thirty pairs for edge typing, forty members for dedup, twenty for task detection, eight for compress, because compress asks the model to write one canonical carrying every member's facts while dedup asks only which members restate each other and task detection asks each member for one verbatim sentence. A batch twice the right size buys half the calls and invites the model to answer the first few members carefully and the rest by pattern.

`arc-synthesis` splits triage from execution, because one call asked to both choose and write produces content for arcs it should have skipped, and the writing is the expensive half (`packages/sleep/src/phases/arc-synthesis.ts:25-28`). `compress` archives a member only when the model names it as absorbed, so an omitted member stays active, which is the safe outcome (`packages/sleep/src/phases/compress.ts:24-27`).

## 13. Generated artifacts are the one merge-conflict source

The per-directory `index.html` files and the root `sitemap.xml` are deterministic given the row set, and only `memhtml publish` and the integrity phase regenerate them. An ordinary write never does (`packages/sleep/src/publish.ts:159`, `packages/sleep/src/phases/integrity.ts:31-34`).

`.gitattributes` marks them `merge=ours` (`packages/store/src/layout.ts:70`), which does nothing without the `merge.ours.driver` config that `memhtml init` sets. With both in place a conflict in a generated file is resolved by regenerating it rather than by editing it.

## 14. The integrity phase distinguishes two kinds of dangling href

`packages/sleep/src/phases/integrity.ts:20-34`. An archived target still exists and the edge still says something true, so the href is rewritten to the archive path. That path is derived with `archivePathFor` rather than searched for, because the mapping is injective and no rename-similarity score is consulted anywhere in the system.

A target that is simply gone means the edge asserts a relationship to nothing, so the edge is dropped with a warning. Leaving it would produce a dangling row on every rebuild from then on. Years are tried newest-first over a ten-year window (`packages/sleep/src/phases/integrity.ts:127`), so the most recent archiving of a twice-archived path wins.

## 15. Review and the merge gate

`review` (`packages/sleep/src/review.ts:53`) reports per-phase counts, the commit list with their trailers, `git diff --stat base..HEAD`, and a per-file classification: `meta-only`, `body-changed`, `archived`, `created`, or `deleted` (`packages/sleep/src/contract.ts:234`).

`merge` has two refusals, and both happen before anything moves (`packages/sleep/src/review.ts:271`, `:284`). If `main` has advanced past `base_sha` it refuses as `main-advanced`. If the pre-merge gate fails it refuses as `gate-failed`. A run id naming nothing refuses as `no-run` (`:252`), which is a lookup failure rather than a precondition. A refusal applies no pending marks and reports neither count.

`@memhtml/sleep` takes the gate as a parameter and supplies no default (`packages/sleep/src/review.ts:238`). A package that cannot import the eval package must not be able to default it silently, so the composition is visible in the CLI's own wiring or it does not exist (`apps/cli/src/run.ts:496-515`).

The gate runs with the fake embedder (`packages/eval/src/run.ts:174`), because it measures the ranking stack against a generated fixture corpus. A gate that needed live embeddings would make an unattended merge conditional on a network call and on credentials being present whenever the caller happened to fire it. [Testing posture](/internals/testing-posture/) develops the gate itself, and the run-and-review procedure is an operations how-to under [Learn](/learn/).

## 16. Deep sleep: the occasional, budgeted cycle

`memhtml sleep run --deep` trades model cost for reach (issue #63). The default community gate is the right cost guard for routine operation, and it has a structural blind spot: `compress` selects only memories with a graph community, communities come from label propagation over mined edges, and mining is floored at 0.85 cosine. On a measured bulk-import inbox of 3,079 files, 8% had a neighbor at that floor and 84% touched no edge at all — no community, so no compress candidacy, at any frequency. Deep sleep is for exactly those corpus states: bulk imports, migrations, any stretch where writes outpaced curation.

Under the flag, four mechanisms turn on, and nothing else changes — the same branch lifecycle, the same review and merge gate, the same degradation posture:

- **A grouping-tier mining band.** `relationship-mining` additionally mines [0.72, 0.85) as derived `laterally_related` edges (`packages/sleep/src/phases/relationship-mining.ts`). Their one consumer is label propagation's partition for the deep phases; `memoryEdges` excludes the band, so default-run retention scoring, PageRank, and bridge counts never see it.
- **Entity-keyed grouping.** Compress candidates the widened graph still leaves without a community are grouped by shared `file_entities` reference — the pair class whose prose diverges while the subject is identical, invisible to any cosine. Hub entities (more than 64 active claimants) are stop-words and are skipped.
- **Placement triage.** A deep-only phase proposes an existing `areas/<topic>` or `resources/<topic>` directory — or at most five new ones per run — for each inbox memory even deep grouping could not attach, and `git mv`s the confident placements, rewriting inbound hrefs in the same commit. `keep-inbox` is the model's refusal and the ordinary answer.
- **Iterate-until-quiet compress.** A pass that folded something re-indexes, re-mines, re-scores, and folds again, up to three passes, because a canonical is a new neighbor and a new community member.

`--max-llm-calls <n>` is one budget every deep phase shares. Exhaustion skips remaining batches with the distinct count `budgetSkipped` — a budget stop and a model outage need different mornings-after — and the run stays green. `--dry-run` composes with `--deep`: mining and grouping counts are computed deterministically with no model call and no write.

What deep sleep will not do: it never changes what happens to a fold or a move (everything lands on the review branch behind the same discrimination gate), it never lets the grouping band touch eviction decisions, and it never re-files a task, an arc, or anything outside the inbox.

## 17. Sleep has no schedule

Sleep reads a clock only to STAMP, never to trigger. One `clock.currentTimeMillis` supplies the run's timestamps (`packages/sleep/src/run.ts`) and `edits.ts` does date arithmetic to compute a validity bound; no phase, and nothing in the runner, consults a clock to decide whether to do work. There is no scheduler, no cron entry, and no default cadence anywhere in the package.

The absence is deliberate, and one design decision already rests on it: sleep is the one capability absent from the MCP tool surface, because it is an operator action that rewrites confidence across the corpus, archives memories, and produces a branch a human is expected to read (`apps/mcp/src/tools.ts`). `memhtml sleep run` is the entry point, and the caller owns when it fires.

**Trigger on volume, not on the calendar, and the reason is correctness rather than cost.** A machine-proposed entity merge is applied only once two SEPARATE runs have independently reached the same conclusion — `state.entity_corroboration` counts detections and promotes at two (`packages/index/state-migrations/S0002_entity_corroboration.sql`). What makes the second detection evidence is that the corpus CHANGED between the two reads. Two runs back to back over an unchanged corpus re-read the same rows, so the second rubber-stamps the first and the counter reaches two on one piece of evidence. A calendar cannot supply that independence and a volume threshold can: run when enough has been written since the last one.

The same reading applies to every other phase, for the cheaper reason. A run over an unchanged corpus re-derives the same deterministic scores over the same rows, so it costs model calls and produces commits nobody needs to read. What "enough has been written" means is the caller's to choose, because only the caller knows its own write rate; memhtml owns the signal and not the decision.

`memhtml sleep plan` is that signal. It answers "would a run change anything?" from index counts alone, running no phase — memories written since the last run, chunks with no vector, settled transcripts waiting, dangling authored links, entity merges waiting on a second run. `--dry-run` is a different thing and not a cheaper one: it executes all seventeen phases, including the neighbor scan that exhausted 70 GB of RSS on a 2,907-file corpus, and lets each model-calling phase decline to write at the end.

The plan's verdict has three values, and the third is the honest one. `would-change` means a counted signal is non-zero. `no-signal` means every counted signal is zero AND every phase whose candidates cannot be counted has an empty input, so a run would reach nothing — the one state in which a caller may skip. In between is `unknown`: `dedup-merge` and `relationship-mining` select candidate PAIRS from an n-by-n scan, so counting their candidates IS the scan, and they report their input cardinality with an explicit unknown rather than a zero. A predicate that said "no effect" because it did not look would be worse than no predicate.
