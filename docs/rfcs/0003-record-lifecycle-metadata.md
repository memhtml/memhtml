# RFC 0003: Record lifecycle metadata

- Status: Draft
- Created: 2026-10-25
- Applies to: memhtml 0.17.0 (68697d5)
- Related: RFC 0001 (curation recipes, which could act on these fields), RFC 0004

## Summary

A memory record says what it claims and when it was written, but not when the claim stops holding, when its value was read or rechecked, what it waits on, what outside object it depends on, whether its subject still exists, or that it holds a slot's one current value. This RFC adds those facts as head metas. Search marks a record that is no longer current and never hides it, a later change to a fact is a session op that keeps the content hash, and every write path refuses the facts until the store opts in.

## Motivation

Take a made-up map renderer, `project:marram-maps`, and eight records written about it in early 2031, all under `projects/marram-maps/`.

| # | written    | claim (the `<mark>`)                                                                                                        |
| - | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1 | 2031-01-14 | The marram-maps default tile host is tiles-a.example.org.                                                                   |
| 2 | 2031-03-03 | The marram-maps default tile host is tiles-b.example.org, served through the shared cache with the old host kept read-only. |
| 3 | 2031-01-14 | The marram-maps 1.x line gets security fixes until 2031-03-31.                                                              |
| 4 | 2031-03-03 | The published marram-maps style version is 7.                                                                               |
| 5 | 2031-03-03 | Vector tiles stay off in marram-maps until pull request 48 in github.com/example/marram-maps merges.                        |
| 6 | 2031-03-03 | The marram-maps style guide is generated from styles/default.json in github.com/example/marram-styles.                      |
| 7 | 2031-02-10 | Restart the marram-maps legacy renderer by draining its queue, then restarting its worker.                                  |
| 8 | 2031-04-08 | The marram-maps legacy renderer was switched off on 2031-04-07.                                                             |

Record 7 also names `system:marram-legacy-renderer`. Asked about marram-maps on 2031-05-06, 0.17.0 shows five gaps.

- **(a) Expiry.** Record 3 states its end date only in prose, and no write door takes a validity bound, so search serves it as current after the date passes.
- **(b) Observation time and pending conditions.** Nothing says when record 4's value was read from the project's site, and a later check that finds 7 still published can only be a new record. Record 5 holds until an event stated only in prose.
- **(c) Outside dependencies.** Records 5 and 6 depend on a pull request and a file in another repository, in no form a program can look up, so a change finds no dependent record.
- **(d) Subject state.** Record 8 says the legacy renderer is gone, yet record 7, a procedure, still reads as current, and the remedies are archiving or rewriting a record that is true as history.
- **(e) One current value.** Records 1 and 2 are two values of one slot. Both stay active, nothing links them, and search ranks them as equally live.

## Current behavior

### (a) The validity window exists, and nothing sets or reads it by default

`memhtml-valid-from` and `memhtml-valid-until` are in the vocabulary (`packages/html/src/vocabulary.ts:65-66`), parsed (`packages/html/src/parse.ts:137-138`) and accepted by `NewMemoryInput` (`packages/html/src/template.ts:59-61`), but no write door passes them. The write line shared by `apply` and `session put` maps a fixed field table (`apps/cli/src/apply.ts:37-51`) and refuses others (`apps/cli/src/apply.ts:191-199`), and neither `WriteParams` (`apps/cli/src/operations.ts:220-246`), `memhtml write`'s flags (`apps/cli/src/commands.ts:228-301`) nor `memory_write`'s fields (`apps/mcp/src/tools.ts:305-338`) has a validity field. Only `correct` writes one, stamping the archived loser's `memhtml-valid-until` with the winner's valid-from, min-wins (`packages/store/src/store.ts:637-650`, `packages/store/src/store.ts:1121-1127`).

The index applies the window only under `--as-of`, starting it at `coalesce(valid_from, event_at, created_at)` (`packages/index/src/scope.ts:246-260`). The head's record has no validity field (`packages/contracts/src/record.ts:25-49`), so `as_of` routes to the index (`apps/cli/src/head-retrieval.ts:75`), and `searchHead` ranks every active record (`packages/head/src/search.ts:211-216`). The curator briefing takes no clock (`packages/curator/src/briefing.ts:145-147`, `packages/curator/src/briefing.ts:240-244`).

### (b) No place for observation time or a condition, and no meta op

The vocabulary has no name for either (`packages/html/src/vocabulary.ts:53-85`). A session changes a live record's head only by `link`, `unlink`, `label` and `unlabel` (`packages/contracts/src/record.ts:81-88`). The `session exec` harvester refuses any other meta change with "a meta changed" (`apps/cli/src/session-exec.ts:277-278`), and the curate replay uses that harvester (`docs/design.md:907`).

### (c) Entities are unresolved strings

An entity is any `type:name` string, split at the first colon (`packages/contracts/src/types.ts:120-133`), so a writer could label record 5 `issue:github.com/example/marram-maps#48` and the head would index it in `byEntity` (`packages/head/src/indexes.ts:21-22`), but the string has no grammar. Only the `label` op checks spelling, through `isWellFormedEntity` (`packages/session/src/validate.ts:370`, `packages/head/src/overlay.ts:96`), and the spelling it requires lowercases the whole name (`packages/contracts/src/types.ts:150-151`, `packages/contracts/src/types.ts:181-182`), file paths included.

### (d) Lifecycle lives on records only

`memhtml-status` is `active` or `archived` (`packages/contracts/src/types.ts:68-70`), and a task adds `memhtml-task-status` (`packages/contracts/src/types.ts:72-89`). Nothing states an entity's own state. Only a `curate`-scope session may write `areas/arcs/` and `resources/people/` (`packages/session/src/validate.ts:74-75`). Only session code calls `isReservedPath` (`packages/session/src/validate.ts:260`, `apps/cli/src/session-exec.ts:184`), and `memory_archive` stays open in every mode (`docs/design.md:608`).

### (e) Uniqueness is by content and by path, never by slot

`validateOps` refuses a put whose content hash is active elsewhere (`duplicate`) and a put over an active path of the base view (`claim-edit`) (`packages/session/src/validate.ts:274-278`). The nearest thing to a slot is the frame key: a claim shaped "X is Y" with a value of at most six tokens gets one (`packages/domain/src/frame.ts:48-78`), and commit step 3 links a new put to every active record sharing its key with `memhtml-contradicts` (`packages/session/src/commit.ts:177-212`). Record 2's value is twelve tokens, past the cap (`packages/domain/src/frame.ts:54`, `packages/domain/src/frame.ts:76`), so it shares no key with record 1.

Step 3 skips a rival archived in the head and redirects one the batch moves, but links one the batch archives, because `movedTo` holds moves only and `archived` reads the base head (`packages/session/src/commit.ts:188-207`).

`session put` gives a derived path the first candidate the view does not hold (`apps/cli/src/v2.ts:313-325`), even one an archived revision just left. Archive destinations are `archive/<YYYY>/<path>` (`packages/contracts/src/paths.ts:217-218`), and `validateOps` lets a second archive of one path in one year replace the first copy (`packages/session/src/validate.ts:302-306`), even one a `supersedes` link names. We infer that same-title revisions alternate between two paths, so archiving a year's third revision replaces the first one's copy, and the second revision's `supersedes` link then names the third: a cycle.

## Proposal

### 1. Format additions

Five scalars go at the end of the scalar block, after `memhtml-due` (`packages/html/src/vocabulary.ts:71-77`), so no head line moves.

| meta                    | value                                | parse rule                                                                   |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `memhtml-observed`      | when its values were read            | datetime grammar, in `DATETIME_METAS` (`packages/html/src/parse.ts:173-179`) |
| `memhtml-verified`      | when a recheck found them unchanged  | datetime grammar                                                             |
| `memhtml-pending`       | a short condition the claim waits on | none (L6)                                                                    |
| `memhtml-key`           | `<entity>#<slot>`, the slot it holds | none (L6)                                                                    |
| `memhtml-subject-state` | `active`, `shelved` or `retired`     | none (L6)                                                                    |

`MemoryMetas` (`packages/html/src/document.ts:29-86`) and `MemoryRecord` (`packages/contracts/src/record.ts:25-49`) gain the five, and the record also `validFrom` and `validUntil`, all nullable.

**Only the two datetimes are parse rules,** like every datetime meta today (`packages/html/src/parse.ts:186-192`), because a parse violation drops a file from the head and the index (`docs/design.md:419`, `packages/index/src/indexer.ts:637-639`). The rest are `lifecycleViolations(path, doc)`, which `validateOps` runs on every put and stamped result, the render gate on every v1 write, and `doctor` on every file:

- **L1.** `memhtml-verified` is not earlier than `memhtml-observed`.
- **L2.** A key's entity is also a `memhtml-entity` of the record, which the renderer adds when a writer omits it.
- **L3.** `memhtml-subject-state` is present exactly when the key's slot is `state`, and a `person:` key takes no state.
- **L4.** `memhtml-valid-until` is later than the window's start (section 4).
- **L5.** An active record with `memhtml-subject-state` sits under `areas/subjects/`, and every active record there has one.
- **L6.** A key splits at its last `#` into a well-formed entity (`packages/contracts/src/types.ts:181-182`) and a slot matching `[a-z][a-z0-9-]{0,39}`; `pending` is one line of 1 to 200 characters; a state is one of the three values.

A hand-edited file that breaks one still loads, and the head ignores a key or state that breaks L3, L5 or L6. `doctor` reports L5 as `misplacedStates` and the rest as `lifecycleViolations`, each flipping `healthy`.

### 2. Write doors and the opt-in

The shared write line, `WriteParams`, `memhtml write` and `memory_write` gain `valid_from`, `valid_until`, `observed` and `pending`. The line's one decoder (`apps/cli/src/apply.ts:333-339`) checks each datetime with `isValidDatetime` (`packages/html/src/constraints.ts:77`) and refuses a bad value naming the line, before any op runs (`apps/cli/src/apply.ts:290-301`). `verified` is not a write field: a new record's check time is its observation time.

```jsonl
{"op":"write","title":"published marram-maps style version","type":"semantic","key":"project:marram-maps#style-version","body":"The published marram-maps style version is 7.","observed":"2031-03-03T09:00:00Z"}
```

**One start for both readers.** Lacking a valid-from, `--as-of` starts a window at the first `<time datetime>` (`packages/index/src/scope.ts:254-256`), the head at `memhtml-created` (section 4). So wherever this RFC writes `memhtml-valid-until` onto a record with no start (door, stamp or completion), it also writes `memhtml-valid-from` as its `memhtml-created`. That moves no head window and keeps record 3, whose `<time>` is its end date, visible to `--as-of`.

**`key` and `subject_state` are session-only.** The v1 doors refuse them, naming `session put`: a keyed write must find the slot's holder, the v1 doors have no head, and a correction per keyed line would split `apply`'s one commit (`packages/store/src/store.ts:937-979`). `correctMemory` likewise refuses a target with `memhtml-key` (`packages/store/src/store.ts:1045`), and `archiveMemory` one with `memhtml-subject-state` (`packages/store/src/store.ts:1146`).

**Opt-in.** A 0.17.0 reader skips a file with a new meta, so until the store declares `{ "lifecycleMetas": true }` in `memhtml.config.json`, `validateOps` and the store's render gate, which every v1 write and correction passes (`packages/store/src/store.ts:660-683`), refuse bytes carrying any of the five names. Checking bytes where writes converge covers `session exec` scripts, curator puts of whole HTML (`packages/curator/src/tools.ts:101-105`) and replays. `valid_from` and `valid_until` need no opt-in, and an older writer fails closed on the unknown key (`docs/design.md:629`).

### 3. The `stamp` op

```ts
export type StampName =
  | "memhtml-valid-until" | "memhtml-observed" | "memhtml-verified" | "memhtml-pending" | "memhtml-key"
// OverlayOp gains:
  | { readonly kind: "stamp"; readonly path: string; readonly name: StampName; readonly value: string | null }
```

`applyOp` and `stage` apply it with `setMeta`, or `removeMeta` for `null`, so the article and the content hash never change (`packages/html/src/editors.ts:145-170`, `packages/html/src/editors.ts:196-219`) and the vector is kept (`docs/design.md:447`). A stamp edits only its own line, plus `memhtml-valid-from` under section 2's rule, and leaves `memhtml-updated` alone, as a `label` does.

`validateOps` runs `checkMemory` and `lifecycleViolations` over each stamped result, and refuses a stamp that changes nothing, as it does a redundant `label` (`packages/session/src/validate.ts:375-378`).

| name                  | allowed                                                                                                                                                                                   | refused                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `memhtml-valid-until` | set, or move earlier                                                                                                                                                                      | moving later or clearing, which widens the window (`packages/html/src/parse.ts:188-192`); breaking L4 |
| `memhtml-observed`    | set when absent                                                                                                                                                                           | changing it; breaking L1                                                                              |
| `memhtml-verified`    | set, or move later                                                                                                                                                                        | moving earlier or clearing                                                                            |
| `memhtml-pending`     | set, replace with a new value, clear                                                                                                                                                      | the same value; clearing an absent value                                                              |
| `memhtml-key`         | set when the key is free or freed in the batch and the record's archive slot is free (section 7); change only the entity part when the batch labels the new spelling and unlabels the old | clearing; changing the slot; breaking L3                                                              |

The entity-only change lets alias repair (`docs/design.md:927`) reach a keyed record, a state record included; otherwise an `unlabel` of a key's entity is refused. `memhtml-subject-state` is not stampable: a state change is a new record.

`session put` reads `{"op":"stamp","path":"...","verified":"2031-04-28T08:30:00Z"}`, and `propose` gains the op (`packages/curator/src/tools.ts:100-161`). `session exec`'s `headEdit` emits a `stamp` per changed stamp name and refuses other meta changes (`apps/cli/src/session-exec.ts:253-315`); the replay, which shares it (`docs/design.md:907`), turns a stamp name that differs between an archive twin and its source into a stamp ahead of the archive.

### 4. Reading validity and freshness: (a) and (b)

**Current.** A window starts at `memhtml-valid-from`, else `memhtml-created`, wherever this RFC reads one; a `<time datetime>` dates an event, not the claim (`docs/format.md:76`). At instant `t`, a window is `not-yet` when its start is later than `t`, `closed` when `validUntil <= t`, else `open`, compared as strings like the index (`packages/index/src/scope.ts:254-259`), so a bare date begins at its day's start. A record is _current_ when its window is open and no subject it names is shelved or retired.

**A separate clock.** `searchHead`'s `now` clamps future dates in the recency key (`packages/head/src/search.ts:145-149`) and the doors send none (`apps/cli/src/head-retrieval.ts:94-104`), so the wall clock there would reorder future-dated ties. `SearchHeadInput` and `SearchRequest` instead gain `lifecycleNow` and `currentOnly`, which the doors fill; without `lifecycleNow`, `searchHead` neither marks nor reorders. An older head server refuses them with 400 (`apps/cli/src/head-server.ts:1424-1427`), and the door falls back to the index (`docs/design.md:844`).

**What a hit carries.** Under `detail: true`, which the doors always send (`apps/cli/src/head-retrieval.ts:103`), each hit gets a `HitLifecycle`: `current`, `window`, `validFrom`, `validUntil`, `subjects` (each shelved or retired entity with its state record's path), `pending`, `key`, `observedAt` and `verifiedAt`. `memory_search` and `memory_read` carry it as `lifecycle`, beside `superseded_by` (`apps/mcp/src/tools.ts:606`). `memory_recall` tags a non-current candidate, such as `[closed 2031-03-31]`, quoted or listed (`packages/index/src/disclosure.ts:103-127`). `pending` is data, never an instruction, as bodies are (`docs/design.md:927`).

**Order.** Score, then recency, then path (`packages/head/src/search.ts:155-166`) becomes score, then current before non-current, then recency, then path, which never overturns a score difference or removes a hit (`packages/head/src/search.ts:21-25`). A pending claim counts as current.

**Only current records.** `current_only: true` joins the `admit` predicate every arm applies before its cap (`packages/head/src/search.ts:202-208`). The index adds `coalesce(valid_from, created_at) <= ?t`, `(valid_until IS NULL OR valid_until > ?t)` and a `NOT EXISTS` over subject states, and marks hits without reordering, since its arms tie differently (`packages/head/src/search.ts:58-63`).

**`doctor` and the briefing.** Three findings describe the world, not a defect, so they stay out of `healthy` as `overdueTasks` does (`apps/cli/src/doctor.ts:642-653`):

- `expired`: active records whose window has closed, earliest first, over the partial index `files_ttl` (`packages/index/migrations/0008_tasks.sql:134`).
- `pendingAged`: records with `pending` whose `coalesce(verified, observed, created)` is older than `curator.pendingAgeDays`, default 14.
- `uncheckedAged`: records with `observed` whose `coalesce(verified, observed)` is older than `curator.observedAgeDays`, default 30.

Both defaults are a chosen default, not measured: fourteen days is long enough that a condition nobody rechecked deserves a look, and thirty lists a value read from a source about monthly. A store sets its own. `briefingFromView` gains `options.now` and the same lists, capped with totals like its work lists (`packages/curator/src/briefing.ts:42-65`, `packages/curator/src/briefing.ts:207`). Acting on them is RFC 0001's subject.

### 5. References to outside objects: (c)

Three entity types are reserved, with a grammar:

```text
issue:<host>/<namespace>/<repo>#<number>        issue:github.com/example/marram-maps#48
commit:<host>/<namespace>/<repo>@<sha>          commit:github.com/memhtml/memhtml@68697d5
source:<host>/<namespace>/<repo>@<rev>:<path>   source:github.com/example/marram-styles@main:styles/default.json
```

`issue` takes a decimal number in the host's one sequence (GitHub's issues and pull requests share it), `commit` 7 to 40 hex characters. `normalizeReference` lowercases all but a `source` path, and `isWellFormedEntity` defers to it, so `label` refuses `issue:github.com/example/marram-maps#forty-eight`. The write-line decoder, the MCP write handlers and `validateOps`'s put case gain the same check, for the three reserved types only; other entities are still accepted as written. The parser accepts any string, and `doctor` reports `malformedReferences`. Entity scopes still fold ASCII case (`packages/index/src/scope.ts:311`, `apps/cli/src/head-protocol.ts:167`), so `source:` paths differing only in case meet in one scope. A reference names an object, not the record's subject, so it satisfies no anchor rule (`packages/session/src/validate.ts:109-112`) and gives no inbox home (`docs/design.md:921`).

### 6. Subject states: (d)

A subject's state is a keyed record with slot `state`, such as `system:marram-legacy-renderer#state`, carrying `memhtml-subject-state`. `session put` places it under `areas/subjects/<entity type>/` by title and section 7's placement rule, and the head finds it through `bySlotKey`. `shelved` (paused) and `retired` (ended) make records naming the subject non-current, and `active` clears that. Its `memhtml-valid-from` says when the change happened; it takes effect when it lands. `person:` subjects take no state (L3), since marking a person retired would demote true history about their decisions.

**Who writes it.** `areas/subjects/` joins `CURATION_PREFIXES` (`packages/session/src/validate.ts:74-75`), and `session put` reads `subject_state` only under `curate`. `validateOps` enforces L5 on puts and on moves either way, since a curate-scope move passes the reserved-path check today (`packages/session/src/validate.ts:148-160`, `packages/session/src/validate.ts:258-260`).

This RFC adds no review. `curate merge` is the one door to `main` (`docs/design.md:897`), but the scope comes from the ref name (`apps/cli/src/v2.ts:503-504`) and the gate ignores state records, so any writer opening a `curate/` ref can change a state; a store wanting approval merges by hand.

**Reading it.** `HeadView` gains `subjectState(entity)`, read from the holder of `<entity>#state`, and `searchHead` adds a `subjects` entry per shelved or retired entity of a candidate, never marking a state record by its own state. Both readers match entities to a state key in the `normalizeEntityRef` spelling (`packages/contracts/src/types.ts:163-168`), so a legacy spelling is still marked; SQLite's `lower()` folds ASCII only (`packages/contracts/src/types.ts:143-147`), so projection stores that spelling in a new `file_entities.entity_ref` column, and the index runs one correlated `EXISTS` per candidate over it. The briefing gains `subjects`, each non-active subject with its count of active records, which the default recipe keeps as history.

**What it marks.** Every record naming a shelved or retired subject turns non-current, one reporting the change or naming a successor included, so `current_only` drops the explanation with the stale how-to; a default search returns both, so this RFC accepts that (Open question 5). Reactivating a subject is a new `active` state record superseding the old.

### 7. Keyed slots: (e)

**The rule.** At most one active record holds a key. The head keeps `HeadView.bySlotKey(key)` over active records, multi-valued like `byFrameKey` (`packages/head/src/indexes.ts:17-18`), in `insertRecord` and `removeRecord` (`packages/head/src/indexes.ts:61-120`). `validateOps` refuses, with `{ kind: "key-held", path, key, holder }`, two puts of one key in a batch, and a put whose key an active record holds unless the batch archives that holder and the put links `supersedes` to its archive destination. Where a hand edit left two holders, `read --key` and the completion refuse with `key-conflict` naming each, and `subjectState` answers no state, so search never fails on a conflict.

**Archives keep every chain.** A `supersedes` link names an archive path, so replacing an archived copy can close a chain into a cycle (Current behavior (e)). An archived copy is _chained_ when it carries `memhtml-key` or a record links `supersedes` to it, found through the head's `inbound` index (`packages/head/src/indexes.ts:19-20`). Two rules refuse with `{ kind: "archive-slot-held", path, slot }`:

- **No chained copy is replaced.** `validateOps` refuses a put or archive onto a chained copy, and an archive of a keyed record, or one the batch links `supersedes` to, onto any held destination. Unchained copies keep 0.17.0's replacement (`packages/session/src/validate.ts:302-306`).
- **No keyed record sits on a held slot.** Given the current year `Y`, `validateOps` refuses a keyed put, a `memhtml-key` stamp and a move of a keyed record when the view holds `archive/<Y>/<path>` for the record's path as the batch leaves it. `putPathFor` and the store's `freePathFor` (`packages/store/src/store.ts:432-472`) skip such candidates, keyed or not.

A move never writes over a record (`packages/session/src/validate.ts:420-423`) and an archive must map back to its source (`packages/session/src/validate.ts:299-301`), so only archiving the record at a path, or a put straight into `archive/`, fills its slot. We infer that a keyed holder's slot stays free as years turn, so the completion's archive lands on it; if not, the completion refuses, naming a move as the remedy.

**The completion.** `withSupersessions(view, ops)`, beside `withRepoints` (`packages/session/src/moves.ts:21-24`), completes each keyed put whose key has a holder:

1. A min-wins `stamp` of the holder's `memhtml-valid-until` to the put's start (its `memhtml-valid-from`, else its `memhtml-created`, never its `<time datetime>`), `correct`'s hand-off (`packages/store/src/store.ts:618-650`) at the put's instant, since the commit's is unknown at put time. An instant that breaks L4 is refused, naming the holder.
2. The put's `memhtml-valid-from`, set to that instant when it states none (section 2), and a `supersedes` link to the holder's archive destination.
3. An `archive` of the holder, which copies the stamped bytes (`packages/session/src/commit.ts:122-129`).

`session put`, `session exec` and the `propose` binder run it before `validateOps`. The replay does not: it lands on a tip `main` may have changed (`packages/session/src/moves.ts:9-12`), so rather than archive a holder nobody saw, it refuses with `key-held`. `memory_resolve` already follows `supersedes` forward (`apps/mcp/src/tools.ts:818-823`), so a citation of record 1 reaches the current tile host. Separately, step 3 skips a frame-key rival the batch archives.

**Reading a slot.** `memhtml read`'s positional path becomes optional beside `--key` (`apps/cli/src/commands.ts:355`), and `memory_read` gains `key` (`apps/mcp/src/tools.ts:527-530`); each takes exactly one of the two, giving a slot a stable address.

**Legacy data.** A curate run migrates a slot in one batch: it moves the newest holder to a path with a free archive slot if its own is held, stamps `memhtml-key` onto it, and supersedes the rest; a holder whose slot holds a chained copy moves first, in an earlier batch. The briefing and `doctor` report `keyConflicts`, keys with several active holders, flipping `healthy`. Sessions cannot make one, since a commit whose ref moved revalidates on the new tip (`docs/design.md:506`, `docs/design.md:539`), and v1 doors cannot write keys; a hand edit can.

## Invariants and safety

1. **No head edit moves a content hash or an existing head line.** Stamps edit head lines outside the article (`packages/html/src/editors.ts:145-149`).
2. **Nothing disappears from a default search.** `current_only` is opt-in, and `as_of` is unchanged.
3. **No head edit widens or empties a window.**
4. **No cross-field or shape rule makes a file unreadable.** Only a malformed new datetime drops a file, as a malformed `memhtml-valid-until` does today (`packages/html/src/parse.ts:186-192`).
5. **Every write path enforces the opt-in,** by checking bytes.
6. **One active holder per key, and no chained copy replaced,** for every session write; v1 doors cannot write a key, and `doctor` reports hand edits.
7. **A subject's state changes only on a curate ref,** without review of its own.
8. **Search stays pure.** With no `lifecycleNow` the order is 0.17.0's, and the gate passes none (`packages/head/src/gate.ts:177`), since it catches accidental order changes, not retirements.
9. **References are never merged by spelling.** Alias resolution leaves the reserved types alone.

## Compatibility and migration

- **Format.** A 0.17.0 binary refuses a file with a new meta (`packages/html/src/constraints.ts:358-360`), so readers upgrade before a store sets `lifecycleMetas`.
- **Ops and wire.** An older binary cannot decode or replay a `stamp`. Every new wire field is additive, and section 4 covers older head servers.
- **Snapshots.** `SNAPSHOT_FORMAT` (`packages/snapshot/src/snapshot.ts:61`) becomes `"2"`. Another format is a miss that loads from git (`docs/design.md:666`), so mixed binaries cost load time only.
- **Index.** One migration adds `observed_at`, `verified_at`, `pending`, `memory_key`, `subject_state`, `file_entities.entity_ref` and a partial index on `memory_key`, filled by `memhtml index rebuild`. The runner has no guard against a newer ledger (`packages/index/src/database.ts:193-243`), so we infer that an older binary's reindex leaves the new columns `NULL` until a newer rebuild.
- **Placement and archives.** On every door and store, a derived path whose archive slot for the write's year is held moves to the next ordinal, and an archive onto a held slot is refused where either copy belongs to a chain, which 0.17.0 allows. No existing file moves.
- **Ranking.** With no new metas, keys or states, only a record whose window is closed or not yet open is marked and loses exact ties. `correct` copies a winner's first `<time datetime>` into `memhtml-valid-from` (`packages/store/src/store.ts:1095-1098`), so a correction can read `not-yet`; the completion never does.
- **Config.** `lifecycleMetas` and the two `curator` keys fail closed on older binaries (`docs/design.md:629`).

## Alternatives considered

**An open metadata namespace (`memhtml-x-*` or `<dl>` facets).** The strongest alternative: stores add facts with no format change. But the vocabulary is the policy (`packages/html/src/vocabulary.ts:1-6`), and search and `doctor` must know which names mean expiry, so the engine would reserve them anyway, with weaker grammar. Unvalidated datetimes break the string ordering comparisons rely on (`packages/html/src/constraints.ts:50-66`), and facets sit inside the content hash, so a recheck would be a new record.

**Leave it to the curator's model reading prose.** No format change, but the model sees only what its briefing and step budget reach (`docs/design.md:925`), its reading cannot be tested deterministically, and search cannot rank on it.

**Unique archive slots,** such as `archive/<YYYY>.<n>/<path>`, would end every replacement. But 0.17.0 knows an archive path only by the `archive/<digits>/<path>` pattern (`packages/contracts/src/paths.ts:225-228`), so every reader would need the new layout first; section 7's rules need none.

**One path per slot.** The next holder takes the old path, giving a stable URL. But that path's second archive in a year lands on a chained copy, which section 7 refuses, and the put needs a `claim-edit` exception (`packages/session/src/validate.ts:274-278`).

**Smaller options.** Subject state in `memhtml.config.json` is never read by search (`docs/design.md:629`) and has no claim, history or window. Stamping state onto every record naming the subject repeats per record and on reversal. Filtering non-current records by default answers a history question with nothing and no sign of it, which `scope_empty` exists to avoid (`apps/mcp/src/tools.ts:620-627`). A wider frame key would read clauses as values (`packages/domain/src/frame.ts:31-33`); a declared key says what the writer means.

## Open questions

1. **Task resolution.** `TASK_STATUSES` has no `dropped` (`packages/contracts/src/types.ts:82`); whether a dropped task reuses a state or a slot is open.
2. **A stronger demotion.** We infer that lexical-only scores tie only on equal BM25 scores (`packages/head/src/search.ts:91-97`), while the vector arm's equal weight also ties mirrored ranks, such as 1 and 3 against 3 and 1 (`packages/head/src/search.ts:57`, `packages/head/src/search.ts:64`, `packages/domain/src/rrf.ts:28-29`). The PR measures fixture ties both ways before choosing the tie-break or a small RRF penalty.
3. **State under `as_of`.** The first version marks the current state even under `as_of`.
4. **v1 stamp doors,** open under `v1Doors` as `memory_link` is (`docs/design.md:608`).
5. **Who a state marks.** Exempting records created at or after the state's `memhtml-valid-from` keeps a report of the change current, and a late stale how-to too.

## Out of scope

Asking an outside system whether a referenced object changed (a resolver port, `doctor --refs`, a stale-reference list) moves to a follow-up RFC, "Resolving outside references", which should ask once per reference with its records' earliest `since`, require `at` on every changed answer, and compare `at` with each record's `since`.

## Implementation plan

Each PR ships alone, readers first.

1. **Step 3 skip** (test 11).
2. **Vocabulary and parser for all five names,** so later readers read them, with the opt-in, the byte checks, L1, L4 and L6. Until PRs 7 and 8, the byte checks refuse `memhtml-key` and `memhtml-subject-state` in every store.
3. **Records, snapshots and index columns.**
4. **Write doors,** the start rule and the v1 refusals.
5. **The `stamp` op** for the four unkeyed names, through harvest, `propose` and replay.
6. **Read-side marks,** `lifecycleNow` and `current_only`.
7. **Keyed slots:** L2, L3, the `key` field and stamp, `bySlotKey`, both archive rules, `withSupersessions`, `read --key`, `keyConflicts`.
8. **Subject states:** L5, `areas/subjects/`, `subject_state`, `subjectState`, the `subjects` marks, `misplacedStates`.
9. **Reference grammar** and `malformedReferences`.
10. **Freshness lists** and the `curator` keys.

## Acceptance tests

One synthetic fixture holds the eight records as literal HTML, clocks pinned; record 3 marks its end date as `<time datetime="2031-03-31">`. Parentheses give 0.17.0's differing behavior. `P` is a derived path, `P-2` its next ordinal.

1. `packages/html/tests/constraints.test.ts`: `memhtml-observed` `2031-03-03T09:00:00Z` passes, and `2031-03-03 09:00` is a violation. (Both: "outside the closed metadata vocabulary".)
2. `packages/session/tests/lifecycle-violations.test.ts`: `lifecycleViolations` reports an unlabeled key entity, the key `project:marram-maps#Tile-Host`, a 201-character `pending`, the state `Retired`, a state with no `#state` key, `person:ada-example#state`, `verified` before `observed`, and `valid-until` at the window's start. Each file parses and is searchable, a put of each is refused, and `doctor` lists a hand-authored one.
3. `packages/html/tests/serialize.test.ts`: the five metas serialize after `memhtml-due`; `setMeta(html, "memhtml-verified", "2031-04-28")` changes one line and keeps `contentHash`.
4. `apps/cli/tests/apply.test.ts`: `"valid_until":"2031-03-31"` also renders `memhtml-valid-from` as `memhtml-created`; `"2031-03-31 00:00"` is refused with `ERR_INVALID_FLAG`; a `key` line is refused naming `session put`. (`unknown field`.)
5. `apps/cli/tests/session-exec.test.ts`: without `lifecycleMetas`, a script writing `memhtml-observed` and an `apply` line with `observed` are refused naming the key; with it, both land, and adding `memhtml-verified` to record 4 harvests one hash-keeping `stamp`. ("a meta changed".)
6. `packages/session/tests/validate.test.ts`: on record 3, `valid-until` `2031-03-15` passes, while `2031-04-30`, `null` and `2031-01-14` are refused, as are `observed` under an earlier `verified`, `pending` replaced by itself, `pending: null` when absent, and a `#state` key on a stateless record. `--as-of 2031-02-01` returns record 3.
7. `packages/head/tests/search.test.ts`: record 3 ties a current record and is newer. With no `lifecycleNow` it ranks first; at `2031-05-06T00:00:00Z` it ranks second with `window: "closed"`, and `currentOnly` drops it. A record with `valid-from 2031-06-01` reads `not-yet`.
8. `packages/index/tests/disclosure.test.ts`: a closed record is tagged both when quoted and when it falls to an index line.
9. `packages/session/tests/validate.test.ts`: with keyed record 1 active, a keyed put of record 2 alone is `key-held` naming record 1; `withSupersessions` adds the stamp (to record 2's `memhtml-created`), record 2's `memhtml-valid-from`, the `supersedes` link and the archive, and `validateOps` returns `[]`. A keyed put made on 2031-05-06 whose claim carries `<time datetime="2031-09-01">` is current at once, and `--as-of 2031-06-01` returns it.
10. `tests-integration`: four same-title revisions of `project:marram-maps#tile-host` in four 2031 sessions leave one holder and three archived revisions at three paths, each with its window. `memory_resolve` from revision 1's path lists every hop in `steps` and ends `live`, not `cycle`; `read --key` returns revision 4; `--as-of` inside revision 2's window returns it. (Archiving revision 3 replaces revision 1's copy.)
11. `packages/session/tests/commit.test.ts`: putting a record that shares a frame key with an active record the batch archives leaves no `contradicts` link. (A link to the emptied path.)
12. `tests-integration`: from a 0.17.0-shaped slot (r1 archived at `archive/2031/P`, r2 at `archive/2031/P-2`, r3 active at `P`, r3 superseding r2's copy and r2 superseding r1's), a bare `memhtml-key` stamp on r3 is `archive-slot-held`, and a batch moving r3 to a free path, then stamping it, passes. A later keyed put leaves r1's archived bytes unchanged, and `memory_resolve` from `archive/2031/P` ends `live`, not `cycle`. (Archiving r3 replaces r1's copy.)
13. `tests-integration`: after a curate branch supersedes the tile host, `main` gains another holder; `curate merge` refuses with `key-held` naming it and moves nothing.
14. `packages/session/tests/validate.test.ts`: a put under `areas/subjects/` is `reserved-path` under `session` and passes under `curate`; a state record outside it, a stateless one inside it, and a state record's move out are refused.
15. `tests-integration`: under `curate`, `system:marram-legacy-renderer` goes `retired`, `active`, `retired` in three 2031 sessions with one title, at three paths with no cycle; `bySlotKey` names the third, and `memhtml archive` of it is refused.
16. `packages/head/tests/search.test.ts`: with the retired state, record 7 ties an unlabeled record and is newer. It ranks first with no `lifecycleNow`, and second with one, carrying `subjects`; so does a record labeled `System:Marram-Legacy-Renderer`. The state record is unmarked, and after an `active` state supersedes it nothing is.
17. `packages/session/tests/validate.test.ts`: a batch alias-repairing `system:marram-legacy-renderer` to `system:marram-renderer-legacy` on the retired state record, with the entity-only key stamp, and on record 7 passes, and record 7 stays marked.
18. `packages/contracts/tests/types.test.ts`: `parseReference` splits `issue:github.com/example/marram-maps#48`; `normalizeReference("source:GitHub.com/Example/Marram-Styles@main:styles/Default.json")` keeps the path's case; a `#forty-eight` write line is refused; the key `issue:github.com/example/marram-maps#48#status` has slot `status`.
19. `packages/curator/tests/briefing.test.ts`: at `2031-05-06`, a pending record observed `2031-04-01` is in `pendingAged` at 14 days and not at 60, and record 3 is in `expired`.
20. `apps/cli/tests/doctor.test.ts`: `expired` lists record 3 and `healthy` stays true, as it does with an archived state record present, which `misplacedStates` omits. Two hand-authored holders of one key fill `keyConflicts`, make `healthy` false, and make `read --key` refuse with `key-conflict` naming both.
21. `packages/head/tests/gate.test.ts`: on a landing that adds only the retired state record, `searchHead` with `lifecycleNow` moves record 7 below its tied rival, while `gateHeads` on that version gives the order of `searchHead` with no `lifecycleNow`.
