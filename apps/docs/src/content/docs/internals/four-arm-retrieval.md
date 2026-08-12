---
title: Four-arm retrieval
description: An arm registry folded into one SQL statement, weighted RRF, degradation as a filter rather than an error, MMR diversification, and the disclosure fold.
---

## 1. One fused statement, two entry points { #one-fused-statement-two-entry-points }

`search` and `recall` sit on the same fused SQL and the same MMR pass
(`packages/index/src/retrieval.ts:16-23`), so a ranking change cannot apply to one and not the other.

**Arms are data** — a registry folded over by `buildRrfSql` (`packages/index/src/retrieval-sql.ts:198`,
`packages/index/src/retrieval-sql.ts:237`) — so adding a fifth is a table entry and dropping one is a
filter. Each arm returns exactly `(path, rank)`, 1-based.

## 2. The four arms { #the-four-arms }

`RANK_ARMS` (`packages/index/src/retrieval-sql.ts:243`) holds four members, in fold order. Order is
presentation only; RRF's sum commutes.

| Arm | Weight | Needs | Rank source |
|---|---|---|---|
| `fts` | 1.0 | query terms | `ROW_NUMBER() OVER ()` over a `LIMIT`ed MATCH subquery |
| `vector` | 1.0 | query vector | `ROW_NUMBER() OVER (ORDER BY dist)` over `min(cos)` grouped by path |
| `recency` | 0.5 | — | `coalesce(event_at, updated_at) DESC, path ASC` |
| `salience` | 0.4 | state plane | three terms over `state.access`, DESC — no task, no `resources/people/` |

### 2.1. fts { #fts }

`packages/index/src/retrieval-sql.ts:71`. `ROW_NUMBER() OVER ()` with no `ORDER BY` captures MATCH's own
row order, the only relevance signal this driver exposes — there is no `rank` column and no `bm25()`.
The window sits *outside* the `LIMIT`ed subquery, or it would number the pre-limit scan.

### 2.2. vector { #vector }

`packages/index/src/retrieval-sql.ts:94`. Exact brute force. `GROUP BY c.path` with `min(distance)`
collapses a file to its best chunk — without it a three-chunk file contributes three ranks, consumes
three slots of the arm's budget, and has three reciprocal-rank contributions summed, so being long would
outrank being relevant.

### 2.3. recency { #recency }

`packages/index/src/retrieval-sql.ts:118`. Event time first, so an episodic memory sorts by when the
incident happened rather than by when someone wrote it down.

### 2.4. salience { #salience }

`packages/index/src/retrieval-sql.ts:154`. `exp(-0.01·hours)` + `ln(1 + access_count)` +
`max(outcome_score, 0.0)`, read over the ATTACH. The clamp is the negative-outcome guard: no boost, but
no penalty either — the retention scorer owns punishment, and double-counting it here would let one bad
outcome bury a memory that is still the best answer.

**Two exclusions, and they are this arm's alone.** A `task` row and anything under `resources/people/`
emit no salience row at all (`SALIENCE_EXCLUDED_TYPE`, `SALIENCE_EXCLUDED_PREFIX`). Salience ranks
interchangeable candidates; a task is reached by `task_status`/`due_at` and salience there would reward
STALENESS — the stuck task re-read at every triage outranking the fresh urgent one — while a
person-reference record is reached by entity key and decay is wrong for identity, since a colleague
unmentioned for six months is not less themselves.

Memories *about* a person live outside `resources/people/` and keep their salience, which is the signal
that answers "which five of fifty entries about this person do we actually consult". The discriminator
is a path prefix rather than a type because there is no `person` memory type — a person file is a
`semantic` record `placementFor` routes there (`packages/contracts/src/paths.ts:122`).

The predicates sit INSIDE the arm and never in the shared `fileFilter`
(`packages/index/src/scope.ts:12-22`): an excluded row still earns its FTS, vector, and recency ranks,
so the arm has no opinion rather than the query being narrowed. The mechanism is that the CTE emits no
row for an excluded path at all — leaving the row in with a zeroed access count would still rank it by
write time, which is the recency arm's job, counted twice.

## 3. Fusion { #fusion }

Fusion is one statement: each active arm a CTE, weighted `1/(rank + 60)` contributions `UNION ALL`ed,
then summed per path (`packages/index/src/retrieval-sql.ts:246-248`,
`packages/domain/src/ranking.ts:8`).

Ties break on `path ASC`, so the ordering is total and two runs over an unchanged corpus produce the
same list — what the discrimination gate compares against. `buildRrfSql` returns `undefined` when no arm
is active, so a caller must treat that as an empty result rather than assemble `SELECT … FROM ()`.

The pure arithmetic has a twin in `@memhtml/domain` (`packages/domain/src/rrf.ts:37`), so a weight change
is testable without a database.

## 4. Numbered placeholders and degraded mode { #numbered-placeholders-and-degraded-mode }

The placeholder prefix is fixed at four positions (`packages/index/src/retrieval-sql.ts:24-27`): `?1`
query text, `?2` per-arm limit, `?3` final limit, `?4` query vector. Scope values bind from `?5` up
(`packages/index/src/scope.ts:95`), and the caller **always** binds a four-value prefix with `null` at
`?4` even when the assembled SQL references no `?4` (`packages/index/src/retrieval.ts:196-203`).

That is what keeps scope values at fixed positions whether or not the vector arm fired — with positional
`?` the numbering would shift and every remaining arm would silently read the wrong parameter. Weights
are inlined as literals: trusted configuration, and inlining keeps the tuple stable at four regardless of
how many arms fire.

Degradation is a filter, not an error path. `activeArms` (`packages/index/src/retrieval-sql.ts:218`)
drops any arm whose `needsEmbedding`, `needsState`, or `needsQueryTerms` precondition is unmet; an
embedder failure is caught, logged, and turned into `undefined`
(`packages/index/src/retrieval.ts:173-194`), so retrieval never errors because the embedding provider is
down — it gets narrower, and `degraded` says so on the response.

## 5. Query sanitization { #query-sanitization }

`needsQueryTerms` exists because several forms an agent writes are **hard driver errors rather than
empty results**: an apostrophe, a colon (the system's own entity notation), a leading hyphen, a bare
boolean operator (`packages/index/src/fts-query.ts:1-26`).

`sanitizeFtsQuery` (`packages/index/src/fts-query.ts:35`) reduces a query to runs of Unicode letters and
digits and returns `""` when nothing survives, and the arm then leaves the fold. Dropping rather than
escaping is deliberate: `query` is prose, not a query language, and supporting negation would mean an
agent invokes it accidentally by writing a hyphenated word. `\p{L}\p{N}` rather than `[a-z0-9]` keeps
`déployé` one token.

## 6. Scoping { #scoping }

Scope is assembled **once** and every arm receives the same string, differing only in the alias its
`files` row goes by via a `{alias}` token (`packages/index/src/scope.ts:92`); per-arm filters would let a
scope apply to three arms and not the fourth, a leak no type catches.

Defaults exclude archived files and `memory_type <> 'task'` (`packages/index/src/scope.ts:102-122`),
because a corpus with fifty open to-do items would put fifty of them in front of every recall, crowding
out the knowledge an agent asked for with a list it can read by `ls`-ing a directory. A caller-named type
list is honoured verbatim, `task` included — filtering it back out would make the opt-in unreachable, so
this is a default and not a firewall. That default is inlined rather than bound, because binding it would
consume a placeholder number and shift every scope parameter below it.

Workspace is **strict equality**: an unplaced memory is not "in every workspace", and returning it would
make a project-scoped recall quietly global.

The `entity` scope is **one** reference in `type:name` form, and the predicate REBUILDS that form from
`file_entities`' two columns rather than making the caller know where the split falls
(`packages/index/src/scope.ts:151-155`). It is `EXISTS` rather than a `JOIN`, matching the tag predicate:
a file carrying one name under two types would multiply its rows through a join, and a duplicated row
inside an arm's `LIMIT` spends the candidate budget on one file.

Singular where `tags` is a list, and the asymmetry is the point — the scope exists so a caller can chain
a hop off a hit's own `entities` list, which is one reference at a time, so a list would raise the
question of whether it broadens or narrows before anyone has asked for either. A scope matching nothing
returns no hits and says so through `scope_empty` rather than widening.

## 7. MMR { #mmr }

`search` fetches `limit × 3` fused candidates (`packages/index/src/retrieval.ts:31-35`), because
diversification can only reorder what it was given. `applyMmr` (`packages/domain/src/mmr.ts:36`) is
greedy `λ·relevance − (1−λ)·max_sim_to_selected` at λ = 0.5.

Fusion *rank* stands in for relevance (`packages/index/src/retrieval.ts:327-337`): RRF scores are
rank-derived and incomparable across queries, so a monotone substitute is the honest input — MMR needs
only the order to be right. A vectorless candidate takes penalty 0, the honest reading of unknown
similarity, so vectorless candidates keep their relative fusion order rather than being shuffled by a
fabricated distance. At λ ≥ 1 the function short-circuits rather than burning O(n²) cosines to reproduce
the order it was given.

Each hit carries a `snippet`: its best-matching chunk for this query, capped at 700 characters with a `…`
that fits *inside* the ceiling (`packages/index/src/retrieval-sql.ts:294`). It is one statement over the
final paths only — after MMR, not after fusion — so the fused CTE never changes shape
(`packages/index/src/retrieval.ts:286`). A NULL distance loses to any scored chunk and ordinal breaks
ties, so the winner is deterministic (`packages/index/src/retrieval.ts:457-467`).

## 8. The disclosure fold { #the-disclosure-fold }

`recall` returns a budgeted pack whose three tiers map onto the HTML structure rather than onto a
truncation of prose (`packages/index/src/disclosure.ts:1-17`).

`foldDisclosure` (`packages/index/src/disclosure.ts:93`) spends the budget in rank order and **continues
past a candidate that does not fit**, turning it into an index line: the budget is a character budget and
not a position cut-off, so one long memory mid-list does not silently truncate every shorter one after
it.

`MAX_PER_ENTITY = 2` caps full quotes per **entity name**, not per path
(`packages/index/src/disclosure.ts:25-32`) — per-path would be no cap at all, since twelve memories about
one service are twelve paths. A capped memory still gets its index line, so the cap narrows depth rather
than dropping the memory.

Arcs fold under their **own** 9,000-character envelope rather than competing with memories' 16,000
(`packages/index/src/retrieval.ts:408-421`): an arc is a synthesis of many memories, so letting the two
compete would make one arc crowd out every concrete memory behind it, and the pack would explain the
pattern while citing none of the evidence.

## 9. Reinforcement { #reinforcement }

`reinforce` (`packages/index/src/reinforce.ts:45`) is the **one** call site that moves `state.access`,
because the cooldown is the invariant: `access_count` feeds the salience arm, so a second writer would
let a loop in an agent replay one query and rewrite the corpus's ranking, and a cooldown enforced in two
places is enforced in neither.

The guard is expressed twice by necessity — as the SQL `WHERE` and as a pure twin — so the shared source
of truth is `REINFORCE_COOLDOWN_S = 900` (`packages/domain/src/ranking.ts:17`) and a property test pins
the two at the boundary.

The conditional upsert's `RETURNING` makes the bumped/cooled split authoritative rather than inferred
(`packages/index/src/reinforce.ts:30-43`): reading `last_accessed_at` first and deciding in TypeScript
would race a concurrent reinforce and report a bump that never happened. Only a non-neutral signal moves
`reinforcement_count` and the outcome EWMA — being read is evidence of relevance, not of correctness.

### 9.1. What bumps, and what deliberately does not { #what-bumps-and-what-deliberately-does-not }

Salience accumulates evidence that someone *chose* a memory, so the read tiers get three different
policies.

| Read | Bumps | Why |
|---|---|---|
| `memory_read` / `memhtml read` of a named path, and the `memhtml://file/{path}` resource | yes | the caller chose THAT memory — the strongest signal short of a write (`apps/cli/src/operations.ts:655`) |
| a path merely *returned* by `memory_search` / `memory_recall` | no | the ranker's own guess (`apps/cli/src/operations.ts:681`, `:692`) |
| the fifteen sleep phases | no | a schedule touching the whole corpus converges everything to uniform salience, which is no salience — and sleep bypasses the tool path entirely |
| `memory_reinforce` with a named signal | yes, and it moves the outcome EWMA too | the caller is asserting the memory was right or wrong |

Bumping on a hit is what builds the rich-get-richer loop: today's top five rank higher tomorrow purely
for having been listed, while the memory that should displace them never appears and so never earns a
first bump. The cooldown does not save it — 900 seconds bounds one query replayed inside a session, and
the drift operates across days.

Reading files off disk in code-mode touches no access row, and so obeys the same rule for free rather
than as an exception.
