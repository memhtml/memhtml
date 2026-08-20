---
title: The sleep pipeline
description: Fifteen curation phases in a fixed order, each an isolated commit on a branch, with commit trailers as the resume mechanism and a quality gate that can refuse the merge.
---

## 1. Fifteen phases on a branch

The nightly curation run is called sleep. It executes fifteen phases in a fixed order (`packages/sleep/src/contract.ts:17`), each producing its own commit on a branch named `sleep/<YYYY-MM-DD>`, suffixed `-2` when it runs a second time the same day (`packages/sleep/src/run.ts:45`). The branch is created before any phase runs, so `main` is never touched (`packages/sleep/src/run.ts:95-97`). A dry run creates no branch, which is safe because no phase writes a file in dry mode.

Figure 1 shows the shape of a run. Both of the gate's outcomes are drawn, because the refusal is the property worth seeing. There is no third outcome and no rollback.

```d2 pad=20 src="_figures/sleep-branch.d2" title="Main branches into sleep/date. The fifteen phases run on that branch and are submitted for review to a gate. The gate has exactly two outgoing arrows: passes, leading to main moves, and refuses, leading to main unmoved. No arrow returns from the branch to main except through the gate."
```

**Figure 1: `main` moves only when a gate that can refuse says so.** The branch is cut before any phase executes, so a failed run needs no compensating writes: the abort is `git branch -D` and `main` never moved. The two boxes leaving the gate are the only two outcomes.

| #  | Phase                 | Model | Git effect                                                                                              |
| -- | --------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| 1  | `preflight`           | no    | none; runs `index update` and snapshots counts                                                          |
| 2  | `dedup-merge`         | yes   | one commit: keeper gains `memhtml-supersedes`, dropped files `git mv` to archive, `review:` tasks filed |
| 3  | `entity-resolution`   | yes   | one commit: `memhtml-entity` values normalized and cluster-merged in place, `confirm:` tasks filed      |
| 4  | `person-links`        | no    | one commit: `memhtml-about-person` links to `resources/people/*`                                        |
| 5  | `relationship-mining` | no    | no commit; derived `relates_to` rows in the index only                                                  |
| 6  | `edge-typing`         | yes   | one commit: typed edges promoted, corroborated contradictions, `resolve:` tasks filed                   |
| 7  | `confidence-decay`    | no    | one commit: `memhtml-confidence` rewritten for un-reinforced files                                      |
| 8  | `arc-synthesis`       | yes   | one commit per arc                                                                                      |
| 9  | `retention-triage`    | no    | one commit: files in the evict band `git mv` to archive                                                 |
| 10 | `compress`            | yes   | one commit per batch                                                                                    |
| 11 | `reprieve`            | no    | one commit: `memhtml-valid-until` extended, or the file archived                                        |
| 12 | `trace-consolidation` | yes   | one commit per distilled memory, plus one for `commitment:` tasks                                       |
| 13 | `integrity`           | no    | one commit: dangling hrefs repaired, artifacts regenerated                                              |
| 14 | `state-export`        | no    | one commit: `.memhtml/state/access.jsonl`                                                               |
| 15 | `report`              | no    | one commit: `.memhtml/sleep/<run-id>.html`                                                              |

The order encodes four dependencies. Entity resolution precedes person links so that aliases have already merged. Confidence decay precedes retention triage so that triage scores the decayed value. Dedup-merge precedes both compress and retention triage, because both operate on the post-merge set.

Those four constraints are the whole of what the order is for, and Figure 2 draws only them. Every phase absent from the figure is order-independent of every other phase, which the table above cannot show.

```d2 pad=20 src="_figures/phase-order.d2" title="Four dependency edges among six phases. Phase 2 dedup-merge points at phase 10 compress and at phase 9 retention-triage, both labelled post-merge set. Phase 3 entity-resolution points at phase 4 person-links, labelled aliases merged first. Phase 7 confidence-decay points at phase 9 retention-triage, labelled scores the decayed value. Dedup-merge, entity-resolution and compress are drawn as hexagons because all three call a model; the other three are deterministic."
```

**Figure 2: the fixed order exists to satisfy four edges.** Nine of the fifteen phases appear nowhere in this graph, so the order among them is arbitrary and could change without consequence. The three hexagons mark the phases here that call a model, and each one's edge is about that call: `compress` archives a member only when the model names it as absorbed, `dedup-merge` gates both of its dependents on a fold the model proposed and the veto allowed, and `person-links` waits on `entity-resolution` so a person's aliases have already collapsed before a file is minted for them.

Six phases call a model (`packages/sleep/src/contract.ts:91`). Every other phase is deterministic and costs no model call.

Two of the six still do real work without one, and they degrade differently from the other four. `entity-resolution`'s normalization and character-overlap passes are a pre-stage, so a credential-free run still collapses `Checkout API` onto `checkout api`; what an absent model removes is the decision core, not the phase. `dedup-merge` falls back to the 0.92 cosine floor plus the divergence veto and still commits, so a night with no credentials folds every duplicate a cosine can prove. The other four report a reason and write nothing.

Every one of the six that judges a group of memories at once shares one batching kernel (`packages/sleep/src/batch.ts`): the phase sorts its rows, the kernel slices them into batches, mints opaque `m1`..`mN` keys over each batch's members, frames the member list as one prompt, and resolves the keys an answer names back to rows. A key the batch never offered resolves to nothing and is dropped, so a model can only ever name a member it was shown, never a path it inferred. The kernel does no sorting of its own and preserves the order it is handed, which is what lets each phase state that its own batch boundaries and prompt bytes are a function of the corpus alone.

Each batch's call goes out with `cacheSystem` set, so the phase's system prompt and tool schema form a cache-eligible prefix across every batch of the night and only the member list is new bytes per call (`packages/sleep/src/batch.ts:241-248`, `packages/llm/src/wire.ts:76-80`).

`PHASE_BODIES` is a total `Record<SleepPhase, PhaseBody>` (`packages/sleep/src/phases/index.ts:27`), so a name added to `SLEEP_PHASES` without a body is a compile error rather than a run that silently skips it.

## 2. Per-phase isolation

A phase that throws is caught with `Effect.result`, recorded as a value, and the phases after it still run (`packages/sleep/src/run.ts:231`, `packages/sleep/src/run.ts:258`). Thirteen phases inside one transaction would mean one raise discards the twelve that already succeeded.

`dedup-merge` is the one hard prerequisite, for `compress` and `retention-triage` (`packages/sleep/src/contract.ts:44-64`). Both operate on the post-merge set, and running them over a corpus that still holds its duplicates would compress a pair the merge then archives half of.

That prerequisite is why `dedup-merge` isolates each of its model calls rather than failing on one. It batches components, and a batch whose call comes back malformed is counted and skipped, so a single bad tool payload cannot take two later phases down with it.

A failed phase's staged files are unstaged (`packages/sleep/src/run.ts:283-290`), which isolates the failure in the tree as well as in the report. A partial stage would make the next phase's commit carry the failed phase's half-finished work.

Nothing is rolled back. `git branch -D` is the abort, and `main` never moved (`packages/sleep/src/run.ts:29-31`).

## 3. Commit trailers are the resume mechanism

Every phase commit carries `Memhtml-Run`, `Memhtml-Phase`, and `Memhtml-Counts` trailers (`packages/sleep/src/contract.ts:71-73`, `packages/sleep/src/commit.ts:22-30`), and `resume` reads the set of completed phases out of `git log base..HEAD` rather than out of the `sleep_phases` table (`packages/sleep/src/run.ts:138-145`, `packages/sleep/src/run.ts:334`).

A journal table that a resume depended on would be a second record of what happened, and the two records disagree exactly when it matters, namely when a process is killed after `git commit` and before the row is written. The commit is the fact, the row is a convenience the history can regenerate, and a failed reporting write never fails a run (`packages/sleep/src/run.ts:434-439`).

A resume reports already-done phases explicitly as `skipped`, so its report still accounts for all fifteen (`packages/sleep/src/run.ts:176-191`).

## 4. Every phase excludes tasks from its input

`packages/sleep/src/sql.ts:36` applies the exclusion, and the reason differs by phase. Four phases nonetheless _write_ tasks, which section 10 covers; the exclusion is what keeps that from looping, because a task sleep minted is never a candidate any phase reads back.

In `relationship-mining` it is the graph firewall. Mined edges are written with `edge_class = 'memory'`, so a task endpoint would put a task into PageRank, the diversification pass, and the retention scorer's bridge count. The `edges` CHECK cannot refuse it, because `relates_to` under `memory` is well-formed whatever files sit at its ends (`packages/sleep/src/phases/relationship-mining.ts:32-38`).

In `retention-triage` the reason is the score itself. Recency and access dominate it, so a task untouched for a month scores at the floor, and that is exactly the task most likely to still be owed. Evicting on that signal would archive the neglected work first and leave the busy work behind (`packages/sleep/src/phases/retention-triage.ts:24-28`).

## 5. Thresholds and caps

| Constant                                                      | Value                   | Location                                                 |
| ------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| Near-duplicate cosine / merges per cycle                      | 0.92 strict / 100       | `packages/domain/src/merge.ts:22-25`                     |
| Dedup recall floor / component cap / components per night     | 0.86 / 8 / 300          | `packages/sleep/src/phases/dedup-merge.ts:103-142`       |
| Dedup members per call                                        | 40                      | `packages/sleep/src/phases/dedup-merge.ts:151`           |
| Entity auto-merge / review ratio                              | 0.85 / 0.75             | `packages/sleep/src/phases/entity-resolution.ts:65-68`   |
| Entity cluster confidence / detections / shard                | 0.7 / 2 / 500           | `packages/sleep/src/phases/entity-resolution.ts:77-86`   |
| Mining cosine / k / sample                                    | 0.85 / 5 / 2000         | `packages/sleep/src/phases/relationship-mining.ts:22-32` |
| Edge-typing cosine / k / candidates / detections              | 0.80 / 5 / 200 / 2      | `packages/sleep/src/phases/edge-typing.ts:89-112`        |
| Edge-typing pairs per call / promotions per night             | 30 / 50                 | `packages/sleep/src/phases/edge-typing.ts:86`, `:122`    |
| Confidence commit delta                                       | 0.005                   | `packages/domain/src/decay.ts:135`                       |
| Compress batch / candidates                                   | 8 / 2000                | `packages/sleep/src/phases/compress.ts:46-55`            |
| Retention bands                                               | keep > 0.7, evict ≤ 0.3 | `packages/domain/src/retention.ts:144-145`               |
| Reprieve floor / days / max                                   | 0.5 / 14 / 3            | `packages/domain/src/retention.ts:277-287`               |
| New tasks minted per detector per night / claim-overlap floor | 10 / 0.6                | `packages/sleep/src/mint.ts:53`, `:81`                   |
| Commitment confidence floor                                   | 0.7                     | `packages/sleep/src/llm.ts:126`                          |

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

The phase detects and stops there. A promoted `contradicts` asserts the conflict: nothing is superseded, no `memhtml-valid-until` is closed, and neither side is archived. Choosing the winner of a contradiction is a one-way door on stored belief, and it belongs to an agent or a human rather than to a nightly job.

## 10. Task detection files what a phase may not decide

Four phases end up holding a decision they are not allowed to make. `entity-resolution` has a name pair below its cluster-confidence floor or still in the character review band. `dedup-merge` has a pair above 0.92 that the divergence veto refused. `edge-typing` has a `contradicts` verdict at one detection, held back by the two-night corroboration gate. `trace-consolidation` has read a first-person promise out of a transcript.

Each of those used to be one number in a commit trailer, `reviewCandidates: 3` or `vetoed: 1`, which no human reads and which the next night reports identically forever. Each is now a task file the phase writes into its own commit (`packages/sleep/src/mint.ts:15-38`). A minted task is an ordinary `task` memory, so it inherits the retrieval default, the dedup carve-out, and the edge-class firewall rather than introducing a type. [Tasks](/internals/the-memory-file-format/) covers the file itself.

One kernel does the writing for all four, because the consequence is the part that is easy to get wrong: an idempotency key, dedup against what is already open, a bound on how much one night may add, and a closure that does not reach a task a human has picked up. Four copies of that would be four chances to file a duplicate every night forever. The kernel stages and never commits, so a phase that mints two tasks and closes a third produces one reviewable commit rather than three.

Identity is a head meta, `memhtml-finding-key`, holding `<detector>:<first 16 hex of sha256(fingerprint)>` (`packages/sleep/src/mint.ts:174`). It exists because a task cannot be deduplicated by content: tasks are carved out of the content-hash unique index on purpose, since two open tasks with identical bodies are two real work items, and that carve-out leaves a detector with no way to recognize its own prior work (`packages/index/migrations/0011_finding_key.sql`). The key is derived from the finding rather than from the prose, so rewording a task keeps its key and a genuinely new finding takes a new one. A fingerprint carries no timestamp, no run id, and no session id, and the pair detectors sort their two endpoints, so an orientation that flipped with the corpus's file counts cannot re-file the same question as a new task.

A night writes at most ten new tasks per detector (`packages/sleep/src/mint.ts:53`). The bound is on the diff a human reviews rather than on the detection: a corpus that produced 400 confirm-this-pair findings is a corpus problem, and 400 new files in one commit is a night nobody can review. Overflow is counted, and every submitted finding still counts as detected for the night, so the same night's closure pass cannot mistake a capped finding for a vanished one. Each phase submits in fingerprint order, so two nights over an unchanged corpus write the same ten and the eleventh finding stays eleventh until it is decided.

Closure differs per detector, because absence means different things to each. Closing is `memhtml-task-status: done` stamped inside the archiving `git mv`, so the tree never holds a task that is archived and still `todo`, and the reason goes in the phase commit, since no head meta in the format carries one.

| Phase                 | Closure                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `entity-resolution`   | by absence, when the model pass ran, no batch failed in isolation, and no pair went unasked                     |
| `dedup-merge`         | by absence, and only from the model-bound arm, with every cap on the candidate path a clause of the attestation |
| `edge-typing`         | never by absence; an explicit closer asks about each open task's own pair                                       |
| `trace-consolidation` | only when a resolution says the work is done                                                                    |

Absence is evidence only from a detector that looked everywhere, so the shared close-by-absence pass runs under an attestation each phase computes about its own completeness, and only over tasks still in `todo`. Somebody who moved a task to `doing` or `blocked` owns it now, and a detector going quiet, usually because they are mid-fix, is not permission to archive their work item (`packages/sleep/src/mint.ts:248-264`).

`edge-typing` cannot make that attestation truthfully. Its candidate scan is capped at 200 of a corpus's thousands of pairs and ranked by similarity, so a pair filed last night is routinely not offered tonight, and an untruthful attestation would archive the whole backlog on the first night the corpus grew. So it asks about each open task's own pair instead, bounded by the open-task count rather than by the scan, and recovers the pair from the task's two `<q cite>` hrefs (`packages/sleep/src/phases/edge-typing.ts:347-441`). Three arms close a task: the corroboration counter says a second night confirmed the pair and both files gained the link, so the fact is file-borne and the question is answered; one endpoint is no longer an active file; or one endpoint's cited quote no longer occurs in it, which is a human editing the flagged text and is how a contradiction normally gets fixed. All three are a SQL read or a file read, so the closer runs before the model-dependent early returns and works on a night with no credentials. Wiring it after them would make those tasks immortal on exactly the nights nothing else happens, which are the nights nobody reads the report.

`trace-consolidation` gates each commitment deterministically between the agent and the tree: confidence at or above 0.7, `actor` exactly `"user"`, an evidence session id inside the analyzed batch, and a non-empty quote (`packages/sleep/src/phases/trace-consolidation.ts:215-251`). The actor arm is the self-referential guard. An assistant's "I'll grep for that next" is its own plan for its next tool call, and filing it would put the model's intentions on the human's to-do list, where a later session reads them back as work the human owes. Closure is resolution-driven only, because sessions are an unbounded universe: a commitment made last March is absent from tonight's ten-session batch because the batch is ten files, not because anybody did the work.

Evidence is quoted in the task body. A file-borne source is a `<q cite="/path">` inside a paragraph, and `<blockquote>` is not an option: it sits outside the closed element vocabulary, so a task minted with one would carry a warning forever and its quoted text would never reach the citations projection that both the edge-typing closer and `memhtml doctor` read. Quotes are cut at a word boundary with no ellipsis appended, because a prefix of the source's collapsed text is contained in it and a prefix plus an ellipsis is not (`packages/sleep/src/phases/edge-typing.ts:151-163`). A transcript source is plain text naming the session id, with the same id in `memhtml-session`, because a `cite` holds a repo path and a session id is not one. Doctor therefore verifies file-borne quotes and not transcript ones; the consolidator client, the one process with the transcripts mounted, verifies that containment itself and refuses the whole turn on a fabricated quote (`apps/consolidator/src/client.ts:845-988`).

Every minting phase reports the same counts, with zero-valued keys omitted so a commit trailer stays readable: `taskMinted`, `taskAlreadyOpen`, `taskDeduped`, `mintOverflow`, `taskClosed`, `closureSkipped`, and `pathExhausted`. `trace-consolidation` adds its own gate counts beside them, `commitmentBelowFloor`, `commitmentNotUser`, `commitmentUngrounded`, `resolutionClosed`, `resolutionBelowFloor`, and `resolutionUnmatched` — the last two are separate because they mean different things: a resolution the model hedged on is a fact about the transcript, while a confident completion matching no open task is a fact about the corpus, and a growing gap between them says the detector and the resolver disagree about a work item. Each phase's commit gate asks the mint and the closure too, not only its own primary writes: a night whose only output was three tasks has staged files, and leaving them for whichever later phase commits next would attribute this phase's writes to that one in the `Memhtml-Phase` trailer, so a resume would skip the phase that owns them.

## 11. Graph analysis runs in TypeScript

`packages/domain/src/graph.ts:76` and `packages/domain/src/graph.ts:164` implement PageRank by power iteration and community detection by label propagation.

Determinism is a correctness requirement here. These scores feed the `pagerank` and `bridgeImportance` signals, so a run-to-run reordering would change which memories get evicted on a corpus that did not change (`packages/domain/src/graph.ts:1-11`).

The implementation pins every source of ordering. It sorts nodes before iteration, which fixes the floating-point summation order. It folds parallel edges to their maximum strength. Label propagation visits in sorted order and breaks ties lexicographically rather than with a random seed. It canonicalizes each community label to the smallest member path, so two runs produce the same labels as well as the same grouping.

A community below three members collapses to `undefined` (`packages/domain/src/graph.ts:29-30`), because a pair passed off as a community would make every cross-pair edge look like a bridge. `bridgeCounts` gives a node in no community a count of 0 rather than its full degree (`packages/domain/src/graph.ts:236-247`).

## 12. The model phases

There is one call shape: the native Messages API with a forced tool (`packages/llm/src/wire.ts:9-12`, `packages/llm/src/constants.ts:24`), decoded against its schema and failing with a typed error on any violation rather than coercing the value (`packages/llm/src/structured.ts:64`).

The Converse API is unused here because the effort and thinking rules are per-model and exact, and Converse has no field for either. Three models are reached through `global.` inference profiles, with `thinking` sent for two of them and omitted for the third, where sending it is a validation error rather than a no-op (`packages/llm/src/models.ts:27-30`, `packages/llm/src/models.ts:57`).

Every phase caps how many calls it makes and isolates each one, so a single malformed response skips its batch and is counted rather than failing the phase (`packages/sleep/src/batch.ts:216-233`). A night that typed nine batches of pairs and lost the tenth has done nine batches of work.

Isolation is what makes the batching safe to widen. A batch is the unit a failure costs, so each phase sizes its batch for the answer's attention rather than for the context window: thirty pairs for edge typing, forty members for dedup, eight for compress, because compress asks the model to write one canonical carrying every member's facts while dedup asks only which members restate each other. A batch twice the right size buys half the calls and invites the model to answer the first few members carefully and the rest by pattern.

`arc-synthesis` splits triage from execution, because one call asked to both choose and write produces content for arcs it should have skipped, and the writing is the expensive half (`packages/sleep/src/phases/arc-synthesis.ts:25-28`). `compress` archives a member only when the model names it as absorbed, so an omitted member stays active, which is the safe outcome (`packages/sleep/src/phases/compress.ts:24-27`).

## 13. Generated artifacts are the one merge-conflict source

The per-directory `index.html` files and the root `sitemap.xml` are deterministic given the row set, and only `memhtml publish` and the integrity phase regenerate them. An ordinary write never does (`packages/sleep/src/publish.ts:159`, `packages/sleep/src/phases/integrity.ts:31-34`).

`.gitattributes` marks them `merge=ours` (`packages/store/src/layout.ts:70`), which does nothing without the `merge.ours.driver` config that `memhtml init` sets. With both in place a conflict in a generated file is resolved by regenerating it rather than by editing it.

## 14. The integrity phase distinguishes two kinds of dangling href

`packages/sleep/src/phases/integrity.ts:20-34`. An archived target still exists and the edge still says something true, so the href is rewritten to the archive path. That path is derived with `archivePathFor` rather than searched for, because the mapping is injective and no rename-similarity score is consulted anywhere in the system.

A target that is simply gone means the edge asserts a relationship to nothing, so the edge is dropped with a warning. Leaving it would produce a dangling row on every rebuild from then on. Years are tried newest-first over a ten-year window (`packages/sleep/src/phases/integrity.ts:127`), so the most recent archiving of a twice-archived path wins.

## 15. Review and the merge gate

`review` (`packages/sleep/src/review.ts:19`) reports per-phase counts, the commit list with their trailers, `git diff --stat base..HEAD`, and a per-file classification: `meta-only`, `body-changed`, `archived`, `created`, or `deleted` (`packages/sleep/src/contract.ts:131`).

`merge` has two refusals, and both happen before anything moves (`packages/sleep/src/review.ts:214-221`). If `main` has advanced past `base_sha` it refuses as `main-advanced`. If the pre-merge gate fails it refuses as `gate-failed`.

`@memhtml/sleep` takes the gate as a parameter and supplies no default (`packages/sleep/src/review.ts:196-206`). A package that cannot import the eval package must not be able to default it silently, so the composition is visible in the CLI's own wiring or it does not exist (`apps/cli/src/run.ts:496-515`).

The gate runs with the fake embedder (`packages/eval/src/run.ts:174`), because it measures the ranking stack against a generated fixture corpus. A gate that needed live embeddings would make a nightly merge conditional on a network call and on credentials being present at 3am. [Testing posture](/internals/testing-posture/) develops the gate itself, and the run-and-review procedure is an operations how-to under [Learn](/learn/).
