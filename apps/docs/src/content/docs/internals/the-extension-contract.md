---
title: The extension contract
description: Which axes a consumer may model its own domain on, which vocabularies are closed and why, and what a published version bump may change.
---

memhtml is a published package, and that makes the question "what may I build on?" a contract rather than a matter of taste. This page answers it in one place: five axes are OPEN, six vocabularies a consumer meets are CLOSED, and each closed one has a recorded reason a reader can go and check.

The distinction is not about how hard something is to change. It is about what memhtml claims to understand. On an open axis you coin the value and memhtml stores it, indexes it, and filters on it. On a closed vocabulary the system interprets the value: a `memhtml-type` selects a retention half-life, a PARA bucket selects a placement rule, an envelope `code` selects a caller's recovery path. Interpretation is what a value has to be closed to have.

Open does NOT mean uninterpreted, and pretending it did would be the more useful-sounding claim rather than the true one. Each open axis carries a short list of RESERVED values that a rule does read, and each one is named where the axis is described below. A consumer that avoids the reserved names has the whole axis; one that reuses a reserved name gets a behavior it did not ask for, and the reserved list is the only place that is written down.

## 1. The five open axes

### Facets: `<dl>`/`<dt>`/`<dd>`

A definition list inside the article is the general-purpose extension point. Each `<dt>`/`<dd>` pair is projected into `file_facets(path, name, value, numeric_value)` (`packages/index/migrations/0001_files.sql:91-101`), and both `memhtml search --facet name=value` and `memhtml list --facet name=value` filter on it. The composition is fixed and worth knowing before you model with it: values under the SAME name broaden, different names narrow, so `--facet doc-type=runbook --facet doc-type=guide` is either and `--facet doc-type=runbook --facet tier=1` is both. Neither mistake is visible in the rows that come back. [Four-arm retrieval](/internals/four-arm-retrieval/) carries the predicate's own shape, including why there is no case fold and what it costs at the planner.

Two properties make this the axis to reach for first. The name and the value are matched as TEXT with no case folding, so memhtml has no opinion about what either one means and `Tier` and `tier` are two facet names. What is stored is the element's TEXT CONTENT, and the parser collapses each run of whitespace to one space and trims the ends (`packages/html/src/parse.ts:45`, applied to both halves at `packages/html/src/parse.ts:304-308`), while the filter side only trims (`packages/index/src/scope.ts:57-62`) — so a `<dd>` authored as `runbook  rollback` is stored single-spaced and has to be queried single-spaced. Write the halves the way you want to query them and the two agree; the collapse is the only transformation, and it is the parser's rather than the index's. And `numeric_value` is UNITLESS by contract: it is filled only when the `<dd>` carries a `<data value>` that parses as a finite number, and the unit lives in the human phrasing beside it — `<data value="120">about two minutes</data>` is seconds because the prose says so. There is deliberately no numeric comparison over it, because an inequality on an unlabelled number is an inequality whose units the caller and the store can disagree about silently. The caller owns the unit and matches the text it wrote.

### Tags: `memhtml-tag`

Repeatable, open vocabulary. One `<meta name="memhtml-tag">` per tag rather than a comma-joined string, so correcting one tag is a one-line git diff (`packages/html/src/vocabulary.ts:26`). A new tag is usable the moment it is written; nothing registers one anywhere. Tags broaden a scoped search, so several tags on one query is an any-of overlap.

Placement reads the FIRST tag as a directory name and nothing more: a `semantic`, `procedural`, or `precedent` memory with no workspace routes to `resources/<primary-tag>` (`packages/contracts/src/paths.ts:178-180`). It does not interpret which tag it is.

**Two tag VALUES are reserved, and the first POSITION is load-bearing for them.** `detected` and `machine-closed` belong to the task-detection phase (`packages/sleep/src/tasks.ts:176`, `:200`). A detected task is written with `tags: [detected, <detector>]`, and the sweep that closes a vanished finding requires `tags[0] === "detected"` and reads `tags[1]` as the detector's name (`packages/sleep/src/tasks.ts:641`, `:678-679`). So prepending a tag to a sleep-minted detected task, or reordering its tags, takes that task out of the sweep's reach — and the phase then mints a second file for the same finding on the next run, and every run after. Do not use either value, and do not reorder the tags on a file the pipeline wrote.

### The entity type vocabulary: `type:name`

The SHAPE is fixed and the vocabulary is open. A reference is split at the first colon, the half before it is the type, and everything after is the name, which may itself contain colons (`packages/contracts/src/types.ts:117`). `file_entities` is keyed on `(type, name)`, which is why a scope takes the full `type:name` form and never a bare name: the bare name is ambiguous, and `person:sanju` and `concept:sanju` are two entities that share a spelling.

Nothing closes the type half. The write-time extraction assist offers seven types in its prompt, and downstream the store accepts any of them and anything else (`apps/cli/src/extraction.ts:52`).

**Three type names are reserved, because the projection MINTS rows under them from the article rather than from a meta** (`entityRowsFor`, `packages/index/src/project.ts:321-338`). `concept:<term>` comes from every `<dfn>`, so a defined term is findable by the term. `lang:<value>` comes from every `<code data-lang>`, so a memory holding a SQL fence carries `lang:sql` whether or not it is about SQL — model your own language topic under a type of your own, or `--entity lang:sql` returns a superset the rows cannot report. And `unknown:` is the fallback for a reference with no type half at all, which also makes it what `memhtml doctor` samples as `untypedEntities` (`apps/cli/src/doctor.ts:347`): a reference you deliberately type `unknown` is reported as a reference missing its type, because the two are byte-identical in `file_entities`.

**`person:` is read by two things, and the second one WRITES.** Placement routes a `semantic` memory naming a person to `resources/people` (`packages/contracts/src/paths.ts:164-171`, through `isPersonEntity` at `packages/contracts/src/types.ts:173`, which compares the prefix exactly and so is case-sensitive). Separately, sleep phase 4 reads `entity_type = 'person'` over every non-excluded memory type, mints `resources/people/<slug>.html` for each name it finds, and splices a `memhtml-about-person` link into every memory claiming that name (`packages/sleep/src/phases/person-links.ts:29`, `:36`). That is a corpus mutation rather than a directory choice, and it fires for an `episodic` memory as readily as a `semantic` one. Every other type is stored, indexed, and filterable, and read by nothing.

### Workspace: an open string

Any string. It routes to `projects/<slug>` through `slugify`, and there is no workspaces table anywhere — a workspace is a directory, so creating one costs a `mkdir` inside a commit (`packages/contracts/src/paths.ts:145-188`). A scoped query on it is STRICT: a workspace scope never returns a memory that has no workspace.

### An explicit path

Any path legal under `isValidMemoryPath`: rooted in a PARA bucket, ending in `.html`, carrying no `.` or `..` segment (`packages/contracts/src/paths.ts:80-107`). `archive` is one of the four buckets, so a path under it passes — and a memory written there is outside every default query, since eviction is what that bucket records. Within that, the directory layout under a bucket is yours to choose, and the placement rules only decide where a memory goes when you name nothing.

Read the default carefully, because it is the surprising half. An explicit path that is NOT usable is re-derived through the placement rules, so the write succeeds at a path you did not name and the response reports that other path as the outcome. `--strict-path` turns that into a refusal with `ERR_INVALID_MEMORY` naming the clause the path broke, and nothing is written, staged, or committed. An OCCUPIED path is refused with `ERR_WRITE_CONFLICT` either way: this corpus overwrites nothing.

## 2. The closed vocabularies

Each of these has its reason recorded beside the code that declares it. The reason is cited rather than restated here, because a second copy of a rationale is free to drift from the first. The [Reference](/reference/) page derives every closed value-set from those declarations, so it is the exhaustive list and this table is the six a consumer meets while modelling.

| Vocabulary                                                             | Declared in                                                                         | Where the reason lives                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The element and attribute vocabulary, and the `memhtml-*` meta names   | `packages/html/src/vocabulary.ts:13-266`                                            | that file's own head comment: the vocabulary IS the policy, which is why the module holds data and no sanitizer |
| The ten memory types                                                   | `packages/contracts/src/types.ts:18`                                                | the `MEMORY_TYPES` doc comment                                                                                  |
| PARA's four buckets                                                    | `packages/contracts/src/types.ts:63`, `packages/contracts/src/paths.ts:10-36`       | the `PARA_BUCKETS` doc comment, and `ARCS_DIR`/`TASKS_SUBDIR` beside it                                         |
| The four task statuses                                                 | `packages/contracts/src/types.ts:82`, `packages/index/migrations/0008_tasks.sql:72` | the `TASK_STATUSES` doc comment; the SQL `CHECK` is the second enforcement                                      |
| The edge classes, the fourteen `rel` tokens, and the three provenances | `packages/contracts/src/edges.ts:9`, `:19`, `:35`, `:41`, `:54`, `:96`              | each array's own doc comment in that file                                                                       |
| The envelope `type` and `code` values                                  | `apps/cli/src/envelope.ts:12`, `:70`                                                | the `RESPONSE_TYPES` and `ERROR_CODES` doc comments                                                             |

The edge vocabulary is the one that fails QUIETLY, so it is worth knowing before you model a relation. A `<link rel="memhtml-depends-on">` is not a parse error: the constraint checker records it as outside the closed vocabulary and `readLinks` drops it (`packages/html/src/constraints.ts:257`, `packages/html/src/parse.ts:283-286`), so the file still parses, still commits, and the edge simply never exists. A relation your domain needs that is not one of the fourteen is a facet or an entity, not a `<link>`.

`memhtml-task-status` is closed and doubly enforced — a value outside `TASK_STATUSES` is a parse violation and a SQL `CHECK` failure — which is the answer to "can I use it for my own state machine". No.

The memory types are the one worth quoting, because the reason is a lesson rather than a mechanism: `task` is ONE axis with the other nine rather than a parallel `kind` column, because three overlapping type vocabularies is what made the predecessor memory system's classification unanswerable. A memory type selects a retention half-life, a set of placement rules, and a default search scope, so the vocabulary being closed is what lets any of those be stated at all. Nine of the ten are writable: `arc` is synthesized by the sleep cycle from many memories, so an agent naming one directly would assert a conclusion the corpus has not earned.

PARA is fixed at four buckets, and the two things that look like exceptions are not. Behavioral arcs live at `areas/arcs` and tasks live under a `tasks` segment inside their workspace's project directory — both are named directories inside the four, chosen so that a task belongs to whatever the memory beside it belongs to. `archive` is a bucket rather than a status value because eviction is a `git mv`: the path itself records the state, which is what makes `git log --follow` read through a memory's whole life.

The envelope vocabularies are closed in a specific and weaker sense: they are APPEND-ONLY. A shipped `type` or `code` never changes meaning and is never removed, and a new condition gets a new value. So a caller branching on `code` keeps working across versions, while a caller that treated the list as exhaustive — refusing anything it did not recognize — will meet a value it has not seen. Branch on the codes you handle and treat the rest as unknown.

## 3. What a version bump may change

Releases are cut from Conventional Commit subjects, so the subject that shipped a change is what says how large it was: `feat:` moves the minor, `fix:` the patch, and a `!` or a `BREAKING CHANGE:` trailer the major.

Against that, this page is the promise:

- A value on an open axis that is not a RESERVED name keeps working. Nothing reads it, so no rule can start reading it differently. A new reserved name on an open axis is a minor, and it is why each axis above names the ones it has.
- A closed vocabulary may GROW in a minor release. A new memory type, a new `memhtml-*` meta name, a new envelope `type` or `code` is an addition, and a consumer that branches on the values it handles is unaffected.
- A closed vocabulary shrinking, or a member changing meaning, is a major. That is the case the append-only rule exists to make loud rather than silent.
- The two published binaries are the contract surface, and the twelve workspace packages are private and cannot be installed (`scripts/package-manifest.mjs`). There is no `exports` map on the published package: adding an import surface later would be a minor, and removing one a major, so today there is nothing there to depend on.

## 4. Where to model what

A short answer for the common cases, so the choice does not have to be re-derived:

- A KIND of document your domain has — a runbook, a decision record, a weekly report: a facet. `doc-type=runbook`.
- A STATE your domain moves things through: a facet. Not a memory type; not `memhtml-status`, which is `active`/`archived` and is what every archive, correction, and publish path switches on; and not `memhtml-task-status`, which is closed to four values by the parser and by a SQL `CHECK`.
- A THING your domain talks about — a service, a team, a customer, a cluster: an entity, with a type you choose that is not `person`, `concept`, `lang`, or `unknown`. Then `memory_search`'s `entity` scope is your join.
- A partition of the corpus a whole conversation stays inside: a workspace.
- A cross-cutting label you want to broaden a search with: a tag, avoiding `detected` and `machine-closed`.
- A RELATION between two memories your domain needs: a facet or a shared entity. Not a `<link rel>` — the fourteen tokens are closed and an unknown one is dropped without an error.
- A layout you need to be able to read with `ls` and `git log`: an explicit path.
