# RFC 0002: Fold by fact in curate collapse

- Status: Draft
- Created: 2026-10-25
- Applies to: memhtml 0.17.0 (68697d5)
- Related: RFC 0001 (curation recipes)

## Summary

`curate collapse` folds records that state one fact into one canonical record. At 68697d5 its planner folds topics: it cuts communities out of a lexical graph in which every shared entity adds an edge, and never compares records by different authors. This RFC sorts what the planner finds by strength of evidence. Records with equal or near-identical claims, or one agreeing frame key, fold with no model when the domain's divergence veto passes every pair. Records that only score high on text features fold only after a model judge (`--judge`) or a person's ruling, because text features cannot tell two facts about one subject that share most words from two wordings of one fact. Entities only reinforce text, person entities never count, and pairs cross authors. People, preferences, procedures, arcs and records on a live `contradicts` edge never fold; the edge session commit adds between two records writing one value is not live. Topics become arc candidates. Before a fold lands, the driver checks that the canonical kept its briefed members' identifiers and entities.

## Motivation

A record states one fact (`docs/format.md:3`), and a fold writes one canonical that supersedes and archives its members (`docs/design.md:947`). When members state different facts, correcting one means rewriting them all.

Take six made-up `semantic` records in `projects/loquat-example/`:

| #  | File                         | Author                 | Title                                       | Claim                                                                              | Body                                                                   |
| -- | ---------------------------- | ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| R1 | `release-1-4-0.html`         | (none)                 | loquat-example 1.4.0 release                | loquat-example 1.4.0 shipped to the public registry on 2031-03-04.                 | Quenby, the release lead, tagged it that morning.                      |
| R2 | `imported-release-note.html` | `agent:copier-example` | Imported note: loquat-example 1.4.0 release | The 1.4.0 release of loquat-example went out to the public registry on 2031-03-04. | Copied from the release notes Quenby wrote.                            |
| R3 | `release-job-target.html`    | (none)                 | loquat-example release job target           | The loquat-example release job publishes packages to the public registry.          | Quenby set the release job up when the project moved its packages.     |
| R4 | `release-job-signing.html`   | (none)                 | loquat-example release job signing          | The loquat-example release job signs packages before it publishes them.            | Quenby added the signing step to the release job after a key rotation. |
| R5 | `ci-timeout.html`            | (none)                 | loquat-example integration job timeout      | The loquat-example integration job times out after 30 minutes.                     | Quenby raised the limit when the test matrix grew.                     |
| R6 | `fast-path-default.html`     | (none)                 | loquat-example fast-path default            | The fast-path flag in loquat-example defaults to off.                              | Quenby keeps it off until parser fuzzing finishes.                     |

R1 and R2 state one fact. R3 and R4 are a near-miss: one subject, most words shared, two facts. The right plan folds only R1 with R2.

A dry run of the 68697d5 planner (`memhtml curate collapse --model fake --dry-run`) gives:

- With no entity labels: one fold, R3 with R4. R2, by another author, is never compared with R1.
- With `person:quenby-example` or `project:loquat-example` on every record: two folds, R3 with R4, and R1 with R5 and R6, whose texts share almost no word.
- With one author for all six and no labels: R1 with R2, and R3 with R4.

## Current behavior

`planCollapse` is pure over a head view and calls no model (`packages/curator/src/planner/plan.ts:22-23`). After rulings (`plan.ts:255-313`) it runs three cuts:

1. Partition by author and memory type, `(none)` for no `memhtml-author` (`plan.ts:62-69`, `plan.ts:194-195`).
2. Frame-key groups in a partition. A frame key is a claim's subject and relation up to the last linking word (`packages/domain/src/frame.ts:1-7`). A group writing one value folds at any size; one with several is a `keep` cluster of contradiction candidates (`plan.ts:160-170`, `plan.ts:327-353`).
3. Louvain communities (`plan.ts:355-386`) over a kNN layer, each record's 10 nearest neighbors at a TF-IDF cosine of 0.35 or more over title, claim and body (`packages/curator/src/planner/types.ts:117-124`, `packages/curator/src/planner/similarity.ts:40-42`, `similarity.ts:87-133`), plus 0.2 per entity key that two to 40 records share (`plan.ts:56-60`, `plan.ts:202-223`, `packages/curator/src/planner/graph.ts:63-91`). Vectors drop every token carried by more than 10 records or a fifth of the partition, whichever is more (`similarity.ts:27-35`, `similarity.ts:65-76`), so a dozen re-mints alone in their partition lose every word they share. A community over `maxFold`, default 120, is `keep` (`plan.ts:376-385`, `types.ts:121`).

The anchor, the member with the highest PageRank, supplies only the title (`plan.ts:438-443`); the format example is the first briefed member (`packages/curator/src/collapse-briefing.ts:111`). The CLI passes no planner options (`apps/cli/src/curate-collapse.ts:907-916`).

What follows:

- **A fold is a topic** (an inference the example shows), though the briefing calls it "one theme of near-duplicate memories" (`collapse-briefing.ts:116`).
- **An entity edge alone joins a pair** (`plan.ts:358-362`). The design has entities join as a weighted layer, not hard groups (`docs/design.md:944`); a comment overstates that ("instead of forming clusters of its own", `plan.ts:41-43`). The type is not read, though a `person:` entity says only who a record is about (`docs/design.md:59`), so the labels `curate run` adds (`packages/curator/prompts/charter.md:30`) become fold edges by themselves.
- **Two writers never meet** (`plan.ts:326-388`), as a test asserts (`packages/curator/tests/planner.test.ts:214`).
- **Few records are shielded**: `resources/people/` and `task` rows (`plan.ts:172-174`), which a ruling admits (`plan.ts:26-30`). Records on a `contradicts` edge can fold, and the frame-key cut runs no veto.
- **Session commit marks shared slots, not disagreements.** It links a put to every active record sharing its frame key with `contradicts`, values unread (`packages/session/src/commit.ts:177-212`, `commit.ts:463-465`), though the `curate run` charter reads the edge as joining two values (`charter.md:27`). A restatement committed through a session thus carries a `contradicts` edge to the record it restates.
- **An archive repoints nothing.** Only a `move` is checked for inbound edges (`packages/session/src/validate.ts:452-488`, against `validate.ts:291-325`), so edges into a folded member dangle until a curate run repairs them (`charter.md:15`, `charter.md:34`).
- **Nothing compares a canonical with its members.** The driver only warns on a canonical outside its home, over two puts, or a non-member archived (`curate-collapse.ts:685-694`). `validateOps` checks a put's path, format, duplicate hash, claim edit and write bar (`validate.ts:264-290`).

Unused: the `curate run` charter's rule that records "that state one fact, in the same or different words, are a dedup pair; a neighbor that only shares a topic is not" (`charter.md:29`); `mergeVetoReasons`, which refuses a pair when one side alone negates, the claims' numbers differ, or the two sides carry different variant qualifiers (`packages/domain/src/merge.ts:197-218`); and `connectedComponents`, an order-invariant union-find (`merge.ts:326-350`).

## Proposal

After rulings, which are unchanged, the planner applies sections 1 to 6, and the driver section 7.

### 1. The never-fold set

These records join no fold or score cluster:

- **People records** under `resources/people/`. Folding two merges two people, and person edges into the archived one dangle (`packages/contracts/src/edges.ts:34-35`).
- **Tasks.** A fold keeps one status.
- **Preferences** (`user_preference`). An agent obeys the wording, and two on one subject can differ in a word that matters (an inference).
- **Procedures** (`procedural`). Steps are order-sensitive, and prose names a procedure that no fold repoints.
- **Arcs.** Their `part_of` edges would dangle.
- **Contradicted records**, on either end of a live `contradicts` edge (`edges.ts:14-29`). An edge is live unless its ends share a frame key, agree by `frameGroupAgrees` (`plan.ts:160-170`) and pass the veto; such an edge is session commit's slot mark, over a pair `charter.md:29` calls duplicates. Folding a live end leaves the other side's edge dangling, hiding the disagreement. The costs: restatements of a contested claim wait, and a person's `contradicts` edge between two records writing one value reads as a slot mark.

`resources/people/` and `task` stay a built-in floor. A ruling still admits a shielded record into a theme fold (`plan.ts:26-30`), named in the rationale. A saved plan does not: the driver's per-cluster re-check against the tip (`apps/cli/src/commands.ts:1685`, `curate-collapse.ts:624-625`) adds the never-fold test for every cut but `ruling`, skipping shielded members into `outcome.skipped` and any cluster left with one member.

### 2. Same-fact pairs

| Feature            | Definition                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimCosine`      | TF-IDF cosine over the `<mark>` claims, weighted as in `tfidfVectors` (`similarity.ts:49-85`) with idf over the type's eligible records and no document-frequency cap, so a word every claim shares keeps its smoothed weight (`similarity.ts:77`) |
| `firstChunkCosine` | The same over each article cut at 1,800 characters, claim first (`packages/head/src/vectors.ts:22-34`)                                                                                                                                             |
| `titleOverlap`     | Jaccard overlap of title words, by the head's tokenizer (`packages/head/src/lexical.ts:98`)                                                                                                                                                        |
| `sameFolder`       | One directory, not a bucket (`plan.ts:79-86`)                                                                                                                                                                                                      |
| `sharedEntity`     | A shared entity of a counted type (section 4) on at most `ENTITY_KEY_CAP` records (`plan.ts:56-57`)                                                                                                                                                |

Candidates, per memory type across authors, are the union of claim kNN at `nearDuplicateFloor`, first-chunk kNN at `candidateFloor`, and equal-claim and frame-key buckets. The kNN joins keep the cap, which bounds their cost (`similarity.ts:13-16`); the hashed buckets catch floods it hides. A candidate is an edge under one rule:

1. **Same claim:** the claims are equal after `normalizeClaim` (`plan.ts:140-141`), or `claimCosine` is at or above `nearDuplicateFloor`.
2. **Agreeing frame key:** the bucket agrees by `frameGroupAgrees`. A disagreeing bucket is a `keep` cluster, as today, whose members join no other cluster.
3. **Pair score:** `firstChunkCosine` at or above `candidateFloor`, and `w1 * firstChunkCosine + w2 * titleOverlap + w3 * sameFolder + w4 * sharedEntity` at or above `threshold`. Config loading refuses `w3 + w4` at or above `threshold`.

Rules 1 and 2 make strong edges, rule 3 a score edge. Every edge must pass `mergeVetoReasons`, claim as gist and article as body (`merge.ts:44-50`), so a negation or variant stated only in a body counts (`merge.ts:38-42`); a bucket member the veto refuses against another gets no edge to it. No edge joins the ends of a live `contradicts` edge, shield or not.

### 3. Fold clusters and score clusters

Components come from `connectedComponents`. A component passes the all-pairs test when every two members pass the veto, are not the ends of a live `contradicts` edge, and have equal claims, an agreeing frame key, or `claimCosine` or `firstChunkCosine` at or above `candidateFloor`, so a chain cannot carry in an unrelated, vetoed or contradicting member.

- A component of strong edges only is a **fold cluster**, with no size cap, since a flood of re-mints is one fact and the driver already handles folds over 30 and 180 members (`types.ts:109-115`). One failing the all-pairs test is `keep`.
- A component with a score edge is a **score cluster**, planned as `keep` with `needs: "judge"`. Over `maxScoreCluster` members or failing the test, it loses its weakest score edge (lowest score, ties by paths) and is recomputed until every part passes. Strong edges stay, and a part left with strong edges only is a fold cluster.

The driver skips `keep` clusters (`curate-collapse.ts:919`). A score cluster folds when the judge keeps it, or when a person rules its members `fold` under one theme (`packages/curator/src/planner/rulings.ts:3-8`).

The cut is `claim-match`. Its id is `cm-<memory type>-<hash>-<slug of the anchor's path>`, cut to 100 characters, where `<hash>` is 8 hex characters of the SHA-256 of the sorted member paths, so same-named anchors, or two member sets with one anchor, never share an id. Session ids add `collapse-` and, for follow-ups, `-more-<n>`, cut at 128 characters (`curate-collapse.ts:244-245`, `curate-collapse.ts:589`); a fold session starts with `force: true`, dropping any log there (`curate-collapse.ts:649-655`, `packages/session/src/session.ts:288-308`). The leading hash and the 100-character cut keep the suffix. Judge-split groups take ids the same way.

The anchor, which supplies only the title, is the member whose title has the highest mean `titleOverlap` with the others, then the fewest title words, then the first path. The home stays `homeFor` (`plan.ts:123-138`).

### 4. Entities reinforce, and person entities do not count

A shared entity is one term of rule 3, which needs text first. In the topic graph, `entityEdges` adds `ENTITY_EDGE_WEIGHT` only to pairs the kNN layer joined. Types in `ignoreEntityTypes` add nothing anywhere. A type is the part before the first colon (`docs/format.md:91`).

### 5. The optional judge

`--judge <spec>` takes `fake`, `bedrock:<modelId>` or `proxy:<model>`, resolved as `--model` is (`packages/curator/src/model.ts:138-152`). Without it, planning calls no model.

- `judgePlan(plan, view, model)` runs after the pure `planCollapse`, one call per score cluster through the `--concurrency` pool, under the output ceiling (`model.ts:128-135`).
- It sees the numbered members (title, type, claim, the article's opening) and the pair evidence. The shipped template asks it to group members that state one fact, not those that only share a subject, and treats record text as data. It answers through one tool (`packages/curator/src/loop.ts:16-22`).
- Code only narrows: out-of-range or repeated numbers, groups under two members, and groups with a pair the veto refuses are dropped. Each surviving group becomes a fold cluster; other members become singletons. A failed call leaves `keep` with `judge error: <reason>`.
- The plan records each verdict (`kept`, `split`, `dropped`, `failed`, with spec and reason). A `--plan` replay runs recorded clusters with no call; `--judge` with `--plan` is `ERR_INVALID_FLAG` at exit 2. `--judge fake` keeps every cluster whole, offline, for tests.

### 6. Arc candidates

The topic graph is today's cut 3 per author and type, with section 4 applied, over eligible records plus never-fold records other than people, tasks and arcs. A community of `arcCandidates.min` to `max` members that is not one fold cluster becomes an arc candidate, and a member in a fold cluster carries its id, so an arc writer links the canonical. `curate collapse` writes no arc.

### 7. Coverage of the members' identifiers

Code lists what each member lost in the canonical:

- **Identifiers** in the member's article missing from the canonical's article text and its `<time datetime>` and `<data value>` attributes. Kinds match in table order, each match removed before the next kind runs, so `2031-03-04` is one date, not three counts.

  | Kind    | Matches                                                       | Example      |
  | ------- | ------------------------------------------------------------- | ------------ |
  | date    | `YYYY-MM-DD`, an instant, every `<time datetime>`             | `2031-03-04` |
  | version | optional `v`, dot-joined numbers, optional pre-release        | `1.4.0`      |
  | sha     | 7 to 40 hex characters with a letter and a digit, case-folded | `68697d5`    |
  | issue   | `#` and digits                                                | `#418`       |
  | id      | letters, `-` or `_`, digits                                   | `run-4821`   |
  | count   | any other number, every `<data value>`                        | `30`         |

- **Entities** on a member that are missing from the canonical's head (the briefing asks for the union, `collapse-briefing.ts:124-126`).
- **Polarity**, over claims only, since canonical prose can carry an incidental "no": the canonical's claim carries a negation marker from the veto's list (`merge.ts:72-96`) when no member's does, or none when every member's does, so a ruled fold mixing "never" with plain wordings still lands.

The check covers only what the model could keep:

- Only members briefed in this session. A cluster over 180 briefs its first 170 (`curate-collapse.ts:637-639`), and follow-ups archive the rest and link them to a canonical that never saw them (`curate-collapse.ts:568-573`, `curate-collapse.ts:781-787`); `outcome.unchecked` counts them. Members ruled `keep` are context.
- In the session, a put only against the members its own `supersedes` links name (`curate-collapse.ts:509-521`), so a fold with two canonicals (`packages/curator/prompts/collapse.md:11`) can propose them one at a time. In a fold over 30 members, whose links the driver writes to the first put (`collapse.md:13`, `curate-collapse.ts:640`), the first put against every briefed member. At the end, a member no put supersedes is checked against the first put, which the driver links it to (`curate-collapse.ts:720-727`).
- The briefing lists each member's identifiers (`collapse-briefing.ts:20-27`), since its body excerpt stops at 400 characters (`collapse-briefing.ts:150`), and the fake model's canonical appends them (`packages/curator/src/fake-model.ts:238-264`).

The collapse driver passes its briefed members and the mode to `bindTools` (`curate-collapse.ts:657`). Under `--coverage refuse`, a gap is a blocking `coverage` violation in the binder's judge (`apps/cli/src/curate-run.ts:384-398`), so nothing is appended (`curate-run.ts:454-455`) and the model proposes again. Under `report`, the put is appended and the result lists the gaps in a `coverage` field. `curate run` shares the binder (`curate-run.ts:357`, `curate-run.ts:620`) but passes no members, so it has no coverage check. The driver checks the final ops before landing (`curate-collapse.ts:743-761`): under `refuse` a gap commits nothing, goes into `outcome.coverage`, and the log stays (`curate-collapse.ts:748-757`); `report` lands and lists it.

The check is a floor. It misses names in prose, mechanisms, commands and code paths, which the charter also asks to keep (`collapse.md:12`), any changed meaning that keeps every token and negation, and tokens listed bare. The charter gains a rule to keep every listed identifier and to put the fact's own `<time datetime>` first, since the first becomes `event_at` (`docs/format.md:76`); the driver warns when the canonical's `event_at` differs from the anchor's.

### 8. Plan format

New fields are optional, and `readPlan` (`curate-collapse.ts:831-841`) fills absent ones, so a 0.17 plan reads as before.

| Field                                  | On      | Meaning                                                                       |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `cut: "claim-match"`, `needs: "judge"` | cluster | The new cut, and a score cluster planned as `keep`                            |
| `pairs`, `judge`                       | cluster | Pair evidence (below), and `{ spec, verdict, reason }`                        |
| `planner`, `arcCandidates`             | plan    | `fact` or `topic`, and `{ id, title, members: [{ path, fold? }], rationale }` |
| `neverFold`, `pairs`, `arcCandidates`  | totals  | Counts                                                                        |
| `coverage`, `unchecked`                | outcome | Gaps per member, and members not checked                                      |

```json
{ "a": "projects/loquat-example/imported-release-note.html", "b": "projects/loquat-example/release-1-4-0.html",
  "rule": "score", "score": 0.6, "authors": ["agent:copier-example", "(none)"],
  "features": { "claimCosine": 0.78, "firstChunkCosine": 0.58, "titleOverlap": 0.75, "sameFolder": true, "sharedEntity": null } }
```

`rule` is `claim`, `frame` or `score`.

### 9. CLI and config

`curate collapse` gains `--judge <spec>` (off), `--coverage refuse|report` (`refuse`) and `--planner fact|topic` (`fact`); `topic` runs the 0.17 cuts over eligible records, `maxFold` 120 included (`types.ts:121`), for one minor release. `curator.collapse` in the store config is optional, and `memhtml config` reports each key's source (`docs/design.md:631`):

```json
{ "curator": { "collapse": {
  "neverFold": { "types": ["user_preference", "procedural", "arc"], "paths": [], "facets": [], "contradicted": true },
  "ignoreEntityTypes": ["person"],
  "pairs": { "knn": 10, "candidateFloor": 0.35, "nearDuplicateFloor": 0.9, "threshold": 0.45,
    "weights": { "firstChunkCosine": 0.6, "titleOverlap": 0.2, "sameFolder": 0.1, "sharedEntity": 0.1 } },
  "maxScoreCluster": 8,
  "arcCandidates": { "min": 4, "max": 30 } } } }
```

`paths` are globs matched as writer buckets are (`plan.ts:79-86`). `facets` names shielding facets: a store marking held records with a `legal-hold` facet lists `legal-hold`. Every default is a chosen default, not measured, which the fixture lets a later PR revisit:

| Default                 | Chosen default, not measured, because                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `neverFold`             | section 1                                                                                                                                              |
| `ignoreEntityTypes`     | a person entity says who, not which fact (`docs/design.md:59`)                                                                                         |
| `knn`, `candidateFloor` | they are today's values (`types.ts:118-119`)                                                                                                           |
| `nearDuplicateFloor`    | claims this close share nearly every rare word, and the veto catches the flips they hide (`merge.ts:5-12`)                                             |
| `weights`, `threshold`  | the article carries the fact, the title restates it, folder and entity are context; a pair at the floor needs high title overlap plus folder or entity |
| `maxScoreCluster`       | one judge call reads every member                                                                                                                      |
| `arcCandidates`         | the charter's arc floor (`charter.md:33`) and `LARGE_GROUP` (`types.ts:109`)                                                                           |
| `--coverage refuse`     | a lost identifier survives only in git history                                                                                                         |

### 10. The example under this proposal

Computed with 68697d5's `tfidfVectors` and `tokenize` (an inference until the implementing PR's test asserts it), only two pairs reach `candidateFloor`:

| Pair   | `claimCosine` | `firstChunkCosine` | `titleOverlap` | Score | With `project:loquat-example` |
| ------ | ------------- | ------------------ | -------------- | ----- | ----------------------------- |
| R1, R2 | 0.78          | 0.58               | 0.75           | 0.60  | 0.70                          |
| R3, R4 | 0.65          | 0.43               | 0.67           | 0.49  | 0.59                          |

No claims are equal or reach 0.9, no frame keys match, and the veto passes both. With no judge, labeled or not: no fold, two score clusters, R5 and R6 singletons, no arc candidate. A judge that keeps R1 with R2 and splits R3 from R4 gives one fold, anchored on R1's shorter title.

Out of scope, each a follow-up: how a canonical carries a decision, in an RFC on decision records; stopping session commit from marking a same-value put (`commit.ts:177-212`), which this design does not need; repointing inbound edges when a fold archives a member; and writing arcs from candidates (`curate run`, or an RFC 0001 recipe).

## Invariants and safety

1. **No fold on score alone.** Without a verdict or ruling, every fold edge is an equal or near-identical claim or an agreeing frame key; the score only finds and ranks candidates.
2. **No pair without text.** Folder and entity terms cannot pass a pair, and ignored entity types add to nothing.
3. **Never-fold records stay out** of planned folds and replays, unless a ruling admits one and says so.
4. **Contradictions stay live**: no fold the planner or judge makes holds a disagreeing frame-key group or both ends of a live `contradicts` edge, and every pair in it passes the veto.
5. **The judge only narrows**, to re-vetoed subsets of one score cluster, and a failure leaves `keep`.
6. **No lost identifiers.** Under `refuse`, a canonical that lacks a briefed member's identifier or entity, or reverses the members' shared polarity, commits nothing (limits in section 7).
7. **Determinism.** Without a judge, one view and one set of options give byte-identical JSON (`plan.ts:49-50`). A replay calls no model.
8. **Unique ids** for clusters and for every session a fold starts, follow-ups included.
9. **One door to `main`**: only `curate merge` reaches it (`docs/design.md:897`).

## Compatibility and migration

- **Plans change**: fewer folds, cross-author folds, score clusters, arc candidates. An older binary ignores the new fields.
- **Replays meet the re-check and coverage.** A 0.17 plan's preference folds are skipped by default, and its topic folds may be refused. `neverFold.types: []` with `--coverage report` restores 0.17 landing.
- **New binaries first.** Config decoding refuses unknown keys (`packages/contracts/src/store-config.ts:187`), so an older binary fails with `ERR_STORE_CONFIG` on `curator.collapse`.
- **Defaults shield more**; a store folding those types sets `neverFold`.
- **Tests change.** The planner and CLI tests pin the topic cuts and run under `--planner topic` until PR 7 moves them to `neverFold.types: []` and `--judge fake`. By the 68697d5 tokenizer (inferences until the tests assert them), PKILL (`planner.test.ts:92-96`, `apps/cli/tests/curate-collapse.test.ts:56-60`) then folds two members, its "Never" claim vetoed, so `toHaveLength(3)` (`planner.test.ts:205`) becomes 2. In the planner fixture, VERIFY joins its imported restatements, less its fourth member, so the two-sources test (`planner.test.ts:214`) asserts that cross-author pairs fold. The CLI totals hold (`curate-collapse.test.ts:236`), and `docs/design.md:949` gains "under `--judge fake`". Its bodies carry numbers (`curate-collapse.test.ts:88`) that pass coverage because the fake carries identifiers, and coverage applies under a custom `--charter`.

## Alternatives considered

**Keep topic communities and judge each.** The strongest alternative: a model separates facts better than features. But a community can hold 120 members (`types.ts:121`), so the prompt grows with the topic; every plan needs a model; the judge sees no cross-author pair; and entity edges still build the groups it must undo.

**Fold score-only pairs unjudged.** The near-miss scores 0.49 beside the duplicate's 0.60, so a separating threshold would be fit to one example.

**Stop session commit marking same-value puts, and keep every `contradicts` edge live.** That stops only new marks; stores already hold them, so the planner must read values anyway.

**Build on the domain's dedup units and the planned adjudication tier.** `@memhtml/domain` ships the veto, `connectedComponents` and `mergeOutcomes` (`merge.ts:236-266`), and the backlog plans a budgeted model tier over reported pairs (`docs/backlog.md:66`). This RFC reuses the first two. `mergeOutcomes` needs a 0.92 embedding cosine (`merge.ts:21-22`) and keeps the older file, while the planner is lexical (`similarity.ts:7-11`) and a fold writes a new canonical. `--judge` could later route through that tier.

**Raise the floor, lower `maxFold`.** Louvain still joins pairs of pairs, entity edges still form groups, writers never meet, and the cap moves with partition size (`similarity.ts:27-35`).

**Let the fold session split.** The charter permits two canonicals (`collapse.md:11`), but the split would happen inside a 14-step session (`curate-collapse.ts:99`), outside the plan a person reviews.

**Drop the author partition.** An analysis found author and type the first-order structure (`docs/design.md:943`, `plan.ts:31-35`); that crossing it would let one writer's vocabulary dominate topics is an inference.

## Open questions

1. Should a store fit the weights from labeled pairs?
2. Should `firstChunkCosine` use the vector cache when present, at the cost of invariant 7 and of the planner's lexical design (`similarity.ts:7-11`)?
3. Should pairs cross memory types (`canonicalType` handles mixed types, `plan.ts:109-117`)?
4. Should records that write different values into one frame key over time fold into one record with a dated history, instead of staying a `keep` group (`plan.ts:160-170`)?
5. Is `count` too noisy for single digits?
6. Should people records be beyond rulings?
7. Should `precedent` be never-fold until the decision-record RFC?
8. Should arc candidates cross authors?

## Implementation plan

Each PR ships alone, suite green.

1. **Fixture**, `packages/curator/tests/fixtures/fold-by-fact.jsonl`, and a test printing today's pair precision and recall, before any weights.
2. **Entities reinforce.** `entityEdges` takes the kNN pairs; `ignoreEntityTypes` joins the schema (`store-config.ts:81-94`). This alone removes the labeled R1, R5 and R6 fold.
3. **Never-fold**, with live-edge reading and the replay re-check.
4. **Coverage**: `foldCoverage`, briefing identifiers, the fake, the binder's members input, `--coverage`, and the charter rule to keep every identifier.
5. **Same-fact pairs**: rules, uncapped pair idf, equal-claim buckets, the veto on every edge, clusters, ids, arc candidates, `--planner`, plan fields, fixture assertions.
6. **Judge**: `judgePlan`, `--judge`, verdicts.
7. **Removal** of `--planner topic`, moving its tests to the fact planner.

Each updates `docs/design.md` section 23, the help text (`commands.ts:1663-1745`) and the charter.

## Acceptance tests

Fixtures are synthetic, built through the real parser as `planner.test.ts:57-66` does, or through a session where a test says so. HEAD is 68697d5.

1. **Example, no judge.** The six records labeled `person:quenby-example`: no fold; score clusters R1 with R2 (0.60, both authors) and R3 with R4 (0.49); `totals.singletons` 2. (HEAD: folds R3 with R4, and R1 with R5 and R6.)
2. **Near-miss, judged.** A scripted judge keeps R1 with R2 and splits R3 from R4: one fold anchored on R1, verdicts `kept` and `split`. Under `--judge fake`, two folds.
3. **People add nothing.** A pair built with `firstChunkCosine` 0.45, `titleOverlap` 0.30 and one folder, features asserted first, scores 0.43: no edge labeled `person:quenby-example`, a 0.53 score cluster labeled `project:loquat-example`.
4. **Topic edges.** Two records above `similarityFloor` sharing `project:loquat-example` weigh cosine plus 0.2; two below it have no edge.
5. **Across authors.** Two `error_pattern` records with near-identical claims, one by `agent:copier-example`: one fold listing both authors. (HEAD: two singletons.)
6. **Large groups.** Twelve records by two authors agreeing on one frame key fold as one, as do twelve re-mints of one claim with no frame key and different bodies, alone in their type or beside 60 unrelated records. (HEAD: the re-mints are twelve singletons alone, one fold beside them.)
7. **Divergent bodies.** A rule 1 pair with `firstChunkCosine` under `candidateFloor`: one fold.
8. **Never-fold.** Near-identical pairs of `user_preference`, `procedural`, `arc` and people records join no cluster; `totals.neverFold` counts 2, 2, 2, people under `excluded`. With `neverFold.types: []` the preferences fold; task rows never do. A `neverFold.paths` glob and a `neverFold.facets` name each shield a pair.
9. **Contradictions.** Two near-identical records with no frame key, on a hand-written `contradicts` edge, never share a cluster, shield on or off, even with a third joined to both. "The release channel of loquat-example is stable." restated with another body through `session put` and `session commit`, which links the two with `contradicts`: one fold, rule `frame`, no judge. A third, committed the same way with `weekly`: no fold among the three.
10. **Veto.** "The loquat-example deploy step needs a lock." against "The loquat-example deploy step does not need a lock.", one title and body: no edge. Two records claiming "The integration job timeout of loquat-example is 30 minutes.", one body adding that the limit does not apply on the legacy runner: no edge, though the frame key agrees. `totals.pairs.vetoed` 2. (HEAD: the second pair folds by frame key.)
11. **Chains.** A joins B at 0.55, B joins C at 0.50, A and C under every floor: the cluster is A with B.
12. **Ids.** Called directly, the id function separates anchors `projects/quince-example/release-summary.html` and `projects/medlar-example/release-summary.html`, and two member sets with one 200-character anchor path; every session id, follow-ups included, stays distinct within 128 characters.
13. **Judge narrows.** Scripted: an out-of-range number, and a group pairing a claim with its negation, are dropped; a model error leaves `keep` with `judge error`.
14. **Replays.** `--judge fake --dry-run` saves R1 with R2 as a `fold` with verdict `kept`; `--plan` lands it with no judge call; `--plan` with `--judge fake` is `ERR_INVALID_FLAG`, exit 2, nothing written.
15. **Coverage lists.** A member holding `2031-03-04`, `68697d5`, `#418`, `1.4.0`, `run-4821` and `30`, a canonical lacking `#418` and `30`: `foldCoverage` lists exactly those, as `issue` and `count`.
16. **Coverage in session.** Two members, the second holding `#418`. Under `refuse`, a scripted put superseding both and lacking `#418` gets a `coverage` violation and `appended` 0, and the corrected put lands; one superseding only the first is appended. Under `report`, the gapped put is appended, its result listing the gap. `curate run` returns no `coverage` field.
17. **Coverage at the end.** The same members, and a put superseding only the first, lacking `#418`: under `refuse`, nothing commits, `outcome.coverage` lists the second member, and the log stays; under `report`, it lands, listing the gap. A canonical claim adding "not" to unnegated members is refused; a canonical body with an incidental "no" lands.
18. **Coverage scope.** A 200-member ruling fold under `--model fake` lands under `refuse` with `outcome.unchecked` 30, as do the CLI fixture's fake folds.
19. **Arc candidates.** Five one-author records sharing release vocabulary, five facts: no fold, one arc candidate. Three: none.
20. **Determinism.** Over the held-out fixture with `now` fixed, two runs give byte-identical JSON holding a cross-author pair and an arc candidate.
21. **Config.** An unknown `curator.collapse` key, or `sameFolder + sharedEntity` reaching `threshold`, is `ERR_STORE_CONFIG`.
22. **Precision and recall.** PR 1's fixture: at least 60 made-up records over six made-up projects, each with a `fact` label: one- and two-author restatements, topic groups, person-labeled records with no shared text, flagged near-misses, veto near-misses, contradicted pairs, never-fold records and floods. Its projects split into tuning and held-out halves; the test pins its SHA-256. On the held-out half, defaults, no judge: fold pair precision at least 0.95 (0 when nothing folds), candidate recall (same-fact pairs in one fold or score cluster) at least 0.80, and no flagged near-miss folded. `--planner topic` figures print unasserted.
23. **Old plans.** A 0.17 plan of the CLI fixture skips its `user_preference` folds; with `neverFold.types: []` it lands what it landed under 0.17.
