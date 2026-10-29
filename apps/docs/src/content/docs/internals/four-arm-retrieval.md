---
title: Four-arm retrieval
description: Four rankers folded into one SQL statement, weighted rank fusion, degradation as a filter, a diversification pass, and the disclosure fold.
---

## 1. One fused statement, two entry points

The index's retrieval runs four rankers independently and merges their ordered result lists. That merge is a standard technique called reciprocal rank fusion, and this page calls each ranker an arm. `memhtml search` and `memhtml recall` always run it. The MCP tools `memory_search` and `memory_recall` ask a running head server first and run it only when none answers, `MEMHTML_MCP_HEAD` is `off`, or the call needs the index (`apps/cli/src/head-retrieval.ts::routeFor`). A head server ranks with a lexical and a vector arm alone, with no salience, polarity, or MMR step ([Run a head server](/learn/operations/run-a-head-server/)).

The retrieval service's two entry points, `search` and `recall`, sit on the same fused SQL and the same polarity step (`packages/index/src/retrieval.ts::makeRetrieval::search`, `packages/index/src/retrieval.ts::makeRetrieval::recall`), so a fusion change cannot apply to one and miss the other. Only `search` runs the diversification pass; `recall` hands its polarity-ordered pool straight to the disclosure fold.

Each arm is an entry in a registry, and `buildRrfSql` folds over that registry to assemble the statement (`packages/index/src/retrieval-sql.ts::RANK_ARMS`, `packages/index/src/retrieval-sql.ts::buildRrfSql`). Adding a fifth arm to the statement therefore means adding a table entry, and dropping one means filtering the registry. Each arm returns exactly `(path, rank)`, with rank counted from 1.

Figure 1 draws the `search` path, and labels the diversification pass by its usual name, maximal marginal relevance, abbreviated MMR. The four arms, their union, and the per-path sum are one SQL statement. The query embed and the lexical probe of section 5, when either runs, come before it, and the polarity step and MMR are TypeScript over the rows it chose (`packages/index/src/retrieval.ts::makeRetrieval::fuse`).

```d2 pad=20 src="_figures/rrf-and-mmr.d2" title="The search path. Query text fans out to four arms, fts at weight 1.0, vector at weight 1.0, recency at weight 0.5, and salience at weight 0.4, each returning a path and a rank. The salience arm also reads state.access over an ATTACH. All four arms feed a UNION ALL of weight over rank plus sixty, then a SUM per path. Three times the limit of those paths pass through a polarity step that demotes negation-flipped twins, then MMR at lambda one half, then one snippet statement over the final paths, then ranked hits."
```

**Figure 1: one SQL statement down to the sum, then TypeScript.** Each arm is a common table expression returning `(path, rank)` and nothing else, so changing a weight touches one number and dropping an arm is a filter over the registry. The snippet statement sits after diversification rather than after fusion, which keeps the shape of the fused query independent of how many hits survive.

## 2. The four arms

`RANK_ARMS` (`packages/index/src/retrieval-sql.ts::RANK_ARMS`) holds four members in fold order: `fts`, the lexical arm, for full-text search, `vector` for embedding similarity, `recency`, and `salience`. The order is presentation only, since a sum commutes.

| Arm        | Weight | Needs        | Rank source                                                                          |
| ---------- | ------ | ------------ | ------------------------------------------------------------------------------------ |
| `fts`      | 1.0    | query terms  | `ROW_NUMBER() OVER ()` over a `LIMIT`ed MATCH subquery                               |
| `vector`   | 1.0    | query vector | `ROW_NUMBER() OVER (ORDER BY dist)` over each path's `min(vector_distance_cos)`      |
| `recency`  | 0.5    | nothing      | `coalesce(event_at, updated_at) DESC, path ASC`                                      |
| `salience` | 0.4    | state plane  | three terms over `state.access`, descending, excluding tasks and `resources/people/` |

### 2.1. fts

`packages/index/src/retrieval-sql.ts::ftsArm`. The `LIMIT`ed MATCH subquery orders by `bm25()`, which FTS5 reports as a negative number where more negative is more relevant, so ascending order keeps the best matches. `ROW_NUMBER() OVER ()` then numbers the survivors. The window sits outside the `LIMIT`ed subquery, since inside it the numbering would apply to the pre-limit scan.

### 2.2. vector

`packages/index/src/retrieval-sql.ts::vectorArm`. Exact brute-force comparison. `GROUP BY c.path` with `min(distance)` collapses a file to its best-matching chunk. Without that collapse a three-chunk file would contribute three ranks, consume three slots of the arm's candidate budget, and have three reciprocal-rank contributions summed, so length would beat relevance.

### 2.3. recency

`packages/index/src/retrieval-sql.ts::recencyArm`. Event time comes first, so an episodic memory sorts by when the incident happened rather than by when someone wrote it down.

### 2.4. salience

Salience is this system's measure of how much a memory has proved itself in use: how recently it was read, how often, and how the outcomes went. The arm computes it as `exp(-0.01·hours)` + `ln(1 + access_count)` + `max(outcome_score, 0.0)` over the attached state plane (`packages/index/src/retrieval-sql.ts::salienceArm`). `hours` runs from the last access, or from the file's `updated_at` when it has never been read or reinforced.

The clamp on the third term keeps one bad outcome from burying a memory that is still the best answer: a negative `outcome_score` adds nothing and subtracts nothing. No other code in this build reads a negative score to demote or archive a memory, so negative signals can at most cancel the boost earlier positive ones gave. A reinforce that records a negative signal also bumps the access count and the time of last use, so it raises the other two terms (`packages/index/src/reinforce.ts::reinforce`).

Two exclusions belong to this arm and to no other. A `task` row and anything under `resources/people/` emit no salience row at all (`SALIENCE_EXCLUDED_TYPE`, `SALIENCE_EXCLUDED_PREFIX`). Salience ranks candidates that are interchangeable answers to a question. A task is reached by `task_status` and `due_at` instead, and ranking tasks by salience would reward staleness, letting the stuck task re-read at every triage outrank the fresh urgent one. A person-reference record is reached by entity key, and decay is the wrong model for identity, since a colleague unmentioned for six months is not less themselves.

Memories about a person live outside `resources/people/` and keep their salience, which is the signal that answers which five of fifty entries about a person actually get consulted. The discriminator is a path prefix rather than a memory type because there is no `person` type: a person file is a `semantic` record written at an explicit path under that directory, and no placement rule derives that directory. A `person:` entity files by workspace or topic, and a primary tag that slugs to `people` routes nothing, so without a workspace the record files to `areas/inbox/` (`packages/contracts/src/paths.ts::placementFor`, `packages/index/src/retrieval-sql.ts::SALIENCE_EXCLUDED_PREFIX`). In a session only the curator's `curate` scope may write there (`packages/session/src/validate.ts::isReservedPath`).

Both predicates sit inside the arm and never in the shared `fileFilter` (`packages/index/src/retrieval-sql.ts::salienceArm`, `packages/index/src/retrieval-sql.ts::ArmHoles::fileFilter`, `packages/index/src/scope.ts::assembleScope`). An excluded row still earns its lexical, vector, and recency ranks. This arm holds no opinion about it, and the query as a whole stays as wide as the caller asked for. The arm's query emits no row for an excluded path at all. Leaving the row in with a zeroed access count would still rank it by write time, which is the recency arm's job counted twice.

## 3. Fusion

Fusion is one statement. Each active arm is a common table expression, each contributes `weight × 1/(rank + 60)`, the contributions are combined with `UNION ALL`, and the result is summed per path (`packages/index/src/retrieval-sql.ts::buildRrfSql`, `packages/domain/src/ranking.ts::RRF_K`).

Ties break on `path ASC`, which makes the ordering total, so two runs over an unchanged corpus produce the same list. The discrimination gate described in [Testing posture](/internals/testing-posture/) depends on that, since it reads each probe's rank off a `search` result (`packages/eval/src/discriminate.ts::discriminate`). `buildRrfSql` returns `undefined` when no arm is active, and a caller has to read that as an empty result. Assembling the statement anyway would produce `SELECT … FROM ()`.

The arithmetic has a pure twin in `@memhtml/domain` (`packages/domain/src/rrf.ts::fuseArms`), so a weight change is testable without a database.

## 4. Numbered placeholders and degraded mode

The placeholder prefix is fixed at four positions (`packages/index/src/retrieval-sql.ts::PARAM_QUERY`, `packages/index/src/retrieval-sql.ts::PARAM_ARM_LIMIT`, `packages/index/src/retrieval-sql.ts::PARAM_FINAL_LIMIT`, `packages/index/src/retrieval-sql.ts::PARAM_QUERY_VECTOR`): `?1` is the query text, `?2` the per-arm limit, `?3` the final limit, and `?4` the query vector. Scope values bind from `?5` upward (`packages/index/src/scope.ts::assembleScope`). The caller builds the tuple in that slot order, with `null` at `?4` when there is no query vector, and then trims it to the highest `?N` the assembled statement names, because SQLite rejects a value bound past the highest `?N` and accepts one at a lower position the statement never names (`packages/index/src/retrieval-sql.ts::rrfParams`, `packages/index/src/retrieval.ts::makeRetrieval::fuse`). So the `null` is bound only when scope values follow it.

Fixed numbering is what keeps scope values at fixed positions whether or not the vector arm fired. With positional `?` markers the numbering would shift, and every remaining arm would silently read the wrong parameter. Weights are inlined as literals rather than bound, because they are trusted configuration and inlining keeps the numbered prefix at four slots however many arms fire.

Degradation drops arms and never fails the query. `activeArms` (`packages/index/src/retrieval-sql.ts::activeArms`) filters out any arm whose `needsEmbedding`, `needsState`, or `needsQueryTerms` precondition is unmet. An embedder failure is caught, logged, and turned into `undefined` (`packages/index/src/retrieval.ts::makeRetrieval::queryVector`), so retrieval keeps answering when the embedding provider is down. The result set gets narrower. The response's `degraded` field is true only when the vector arm did not fire: no embedder, a failed embed, or vector coverage below `MEMHTML_VECTOR_COVERAGE_FLOOR` (`packages/index/src/retrieval.ts::makeRetrieval::gatedQueryVector`). A query with no indexable term drops the lexical arm, and that alone does not set `degraded`.

## 5. Query sanitization

`needsQueryTerms` exists because several forms an agent writes are hard driver errors rather than empty results: an apostrophe, a colon (which is this system's own entity notation), a leading hyphen, and a bare boolean operator (`packages/index/src/fts-query.ts`).

The sanitizer lowercases a query and reduces it to runs of Unicode letters and digits, keeping a balanced double-quoted span as one phrase (`packages/index/src/fts-query.ts::sanitizeFtsQuery`). When nothing survives it returns `""`, and the lexical arm leaves the fold. Dropping the offending characters beats escaping them. `query` is prose rather than a query language, and supporting negation would let an agent invoke it by accident every time it wrote a hyphenated word. The character class is `\p{L}\p{N}` rather than `[a-z0-9]`, which keeps `déployé` as one token.

`ftsQueryForms` (`packages/index/src/fts-query.ts::ftsQueryForms`) builds two MATCH forms from those terms: every term joined with `AND`, and every term joined with `OR`. The lexical arm binds the all-terms form when `buildFtsProbeSql` (`packages/index/src/retrieval-sql.ts::buildFtsProbeSql`) finds a file in scope holding every term, and the any-of form otherwise (`packages/index/src/retrieval.ts::makeRetrieval::fuse`).

The any-of form exists because FTS5 reads space-separated terms as AND. Under the all-terms form alone, a natural-language sentence that is not a verbatim quote of stored text matches nothing lexically, and the arm contributes nothing to the fold. The any-of form lets one proper noun in the sentence find its file, and bm25 ranks the files holding more of the words first.

The all-terms form is kept where it can answer because the fold, not bm25, needs it. Under either form bm25 ranks the all-terms file first, but the any-of form hands the fold up to 40 candidates instead of a few (`packages/domain/src/ranking.ts::DEFAULT_ARM_LIMIT`). RRF's `1/(rank + 60)` is nearly flat across 40 positions, so recency and salience then outvote the lexical lead (corpus MRR 1.0 against 0.28 on the gate's fixture, seed 20260802).

A double-quoted span in the query is one FTS5 phrase in either form, so `"drain the vip"` demands those words in that order. The words inside the quotes are sanitized like the rest, and an unbalanced quote is read as no quote at all.

## 6. Scoping

The scope predicate is assembled once, and every arm receives the same string, differing only in the alias its `files` row goes by through a `{alias}` token (`packages/index/src/scope.ts::assembleScope`). Per-arm filters would allow a scope to apply to three arms and miss the fourth, and no type would catch that.

The defaults exclude archived files and set `memory_type <> 'task'` (`packages/index/src/scope.ts::assembleScope`). A corpus holding fifty open to-do items would otherwise put fifty of them in front of every recall, crowding out the knowledge an agent asked for with a list it could read by listing a directory.

A caller-named type list is honored exactly as given, `task` included, since filtering it back out would make the opt-in unreachable. A caller can override the exclusion, which makes it a default and not a firewall. The default predicate is inlined into the SQL, because binding it would consume a placeholder number and shift every scope parameter below it.

Workspace matching is strict equality. An unplaced memory belongs to no workspace, and returning it would make a project-scoped recall quietly global.

The `entity` scope takes one reference in `type:name` form, and the predicate rebuilds that form from the two columns of `file_entities` rather than making the caller know where the split falls (`packages/index/src/scope.ts::assembleScope`). It uses `EXISTS` rather than a join, matching the tag predicate: a file carrying one name under two types would multiply its rows through a join, and a duplicated row inside an arm's `LIMIT` spends the candidate budget on one file.

The scope is singular where `tags` is a list, and that asymmetry is deliberate. The scope exists so a caller can follow a hop off a hit's own `entities` list, which yields one reference at a time. A list would raise the question of whether it broadens or narrows before anyone had asked for either. A scope matching nothing returns no hits and reports `scopeEmpty` (`scope_empty` on the MCP tools) rather than widening itself.

### The facet axis is the extension point

`facets` narrows on the `<dl>` pairs the indexer projects into `file_facets`, and it is the one scope axis whose vocabulary is the caller's rather than this system's. [The extension contract](/internals/the-extension-contract/) states the whole set of axes a consumer may model on; this section is the retrieval half of it. The element set and the `<meta>` names are closed, so a consumer modeling its own document kinds, states, or tiers writes them as `<dt>`/`<dd>` pairs and queries them here: `--facet doc-type=runbook` on the CLI, `facets: ["doc-type=runbook"]` on `memory_search` and `memory_list`. No name in that vocabulary reaches any package, because the predicate is over two `TEXT` columns.

The composition is fixed and it is stated in the flag help and in both tool descriptions, because it is a semantic contract rather than a convenience. Values under the **same** name broaden, so `doc-type=runbook doc-type=guide` is either; **different** names narrow, so `doc-type=runbook tier=1` is both. `facetConditions` (`packages/index/src/scope.ts`) implements that as one `EXISTS` per distinct name with `value IN (…)` inside it, and the same function builds the listing's predicate, so a narrowing that finds a memory through `memhtml search` finds it through `memhtml list`. A caller reading the rule the other way would act on a superset or on an empty set, and neither is visible in the rows that come back.

The match is on the facet's text with no case fold, unlike the `entity` axis, which folds because a caller types a reference from memory. A facet name is a key the consumer chose and writes itself. The one transformation either half does get is the parser's: text content is whitespace-collapsed and trimmed before it reaches `file_facets`, and the filter side only trims, so the collapsed form is the queryable one. The fold would also cost the seek: probed 2026-10-29 on node 24's `node:sqlite`, `ff.name = ? AND ff.value IN (?)` plans as `SEARCH ff USING COVERING INDEX sqlite_autoindex_file_facets_1 (path=? AND name=? AND value=?)`, while wrapping the name in `lower()` degrades the same probe to `(path=?)` and wrapping only the value degrades it to `(path=? AND name=?)`, each returning identical rows.

There is no numeric predicate, and that is the contract rather than a gap. `file_facets.numeric_value` carries whatever a `<data value>` parsed to, **unitless**: the unit lives in the human phrasing beside it, so `<data value="120">about two minutes</data>` is seconds only because the prose says so (`packages/index/migrations/0001_files.sql`). An inequality over that column would be a comparison whose meaning the corpus never stated. The caller owns the unit, and it owns it by matching the text it wrote.

### The pointer behind an empty scope

`scopeEmpty` says the scope emptied the result; `archivedMatches` and `archived` say whether the address still resolves somewhere. When `scopeEmpty` is true, `archivedInScope` (`packages/index/src/retrieval.ts`) re-runs the SAME assembled scope with the archived flag flipped, so the axes are byte-for-byte the ones that emptied the search, and returns the count of archived rows plus up to `limit` of their paths with the memory that superseded each (derived from the `supersedes` edge the way a hit's `supersededBy` is). A scope match rather than a ranked one: the question is whether `day=2026-09-02` still names a file, not how the query would rank it. `memhtml archive`, `memhtml correct`, and a session's archive op (which the curator and `curate collapse` use) move a file into `archive/`, and the default scope excludes archived rows, so an agent reading `hits: []` over a correct facet needs this to tell "never written" from "archived" (issue #130). Both fields are the zero shape, `0` and `[]`, whenever `scopeEmpty` is false.

## 7. Diversification

`search` fetches three times as many fused candidates as the caller's limit (`packages/index/src/retrieval.ts::MMR_POOL_FACTOR`), because a diversifier can only reorder what it was given. `applyMmr` (`packages/domain/src/mmr.ts::applyMmr`) then runs maximal marginal relevance, a greedy selection that at each step picks the candidate maximizing `λ·relevance − (1−λ)·max_sim_to_selected`, with λ = 0.5. It trades a little relevance for less redundancy against the hits it has already chosen.

Fusion rank, as the polarity step in section 7.1 adjusts it, stands in for relevance (`packages/index/src/retrieval.ts::makeRetrieval::search`, `packages/index/src/polarity.ts::polarityScored`). Fused scores are derived from ranks and are not comparable across queries, so a monotone substitute is the honest input, and diversification needs only the order to be right. A candidate with no vector takes penalty 0, which is the honest reading of an unknown similarity, so those candidates keep their relative fusion order instead of being shuffled by a fabricated distance. At λ ≥ 1 the function returns its input rather than burning O(n²) cosine computations to reproduce the order it was handed.

### 7.1. Polarity

Between fusion and MMR sits one more step, and it exists because none of the four arms can see a `not`. A memory saying "X merges 5 intervals" and one saying "X does not merge 5 intervals" share every term the lexical arm matches, sit a hair apart in the vector space, and tie on recency and salience, so the fused order between them is decided by noise.

`polarityScored` (`packages/index/src/polarity.ts`) assigns the reciprocal-rank score MMR consumes and then demotes a candidate only when three things hold at once: its claim disagrees with the query's polarity (the same `negationDivergent` marker set the discrimination gate builds its controls from), another candidate in the pool agrees with the query, and the two are near-identical in the vector space (cosine at or above `TWIN_COSINE`, 0.9).

The demoted twin lands below its lowest-ranked agreeing twin, scaled by `POLARITY_DEMOTION` (0.5), so it stays in the pool rather than vanishing. A twin fusion already placed below every agreeing copy is left alone. A lone negated memory with no affirmative near-copy is left exactly where fusion put it, which is what keeps this from being a blanket penalty on every true negative fact. The step is symmetric in the query: "why does X not merge" demotes the affirmative twin.

Two trade-offs follow from reading the query's phrasing as the wanted polarity, and both are pinned by tests. Two live memories that contradict each other rank the half matching the question's phrasing first; a contradiction resolved with `memhtml correct` never reaches the step, because `correct` archives the superseded half. Outcome words in the marker set (`without`, `fail`, `avoid`) make a query like "deploy without downtime" read as negated.

`recall` applies the same step to its fused order, so the two entry points agree on which twin comes first. Measured live (Bedrock embeddings, default fixture, 2026-09-04): 36 of 36 probes discriminated at MRR 1.0, zero inversions.

### 7.2. Snippets

Each hit carries a `snippet`, its best-matching chunk for this query, capped at 700 characters with an ellipsis that fits inside the ceiling (`packages/index/src/retrieval-sql.ts::truncateSnippet`, `packages/index/src/schema-const.ts::SNIPPET_MAX_CHARS`). One statement computes it over the final paths only, after diversification rather than after fusion, so the fused query never changes shape (`packages/index/src/retrieval.ts::makeRetrieval::snippets`). A NULL distance loses to any scored chunk and ordinal breaks the remaining ties, which makes the winner deterministic (`packages/index/src/retrieval.ts::beats`).

## 8. The disclosure fold

`recall` returns a pack with a character budget, and what it quotes follows the HTML structure rather than a truncation of prose (`packages/index/src/disclosure.ts`). A memory appears in one of two forms: a full quote of its claim, its `<summary>` headlines, its `<dl>` facets, and its citations (`packages/index/src/project.ts::disclosureTextFor`), or an index line carrying its path, title, and claim. A `<details>` body never reaches the pack; only a read returns it.

`foldDisclosure` (`packages/index/src/disclosure.ts::foldDisclosure`) spends the budget in rank order and continues past a candidate that does not fit, demoting it to an index line. The budget is a character budget rather than a position cut-off, so one long memory in the middle of the list does not silently truncate every shorter one after it.

`MAX_PER_ENTITY = 2` caps full quotes per entity name rather than per path (`packages/index/src/disclosure.ts::MAX_PER_ENTITY`). A per-path cap would be no cap at all, since twelve memories about one service are twelve paths. A capped memory still gets its index line, so the cap reduces depth without dropping the memory.

Arcs fold under their own 9,000-character envelope instead of competing with the memories' budget, 16,000 characters unless the caller names one (`packages/index/src/retrieval.ts::makeRetrieval::recall`, `packages/index/src/disclosure.ts::ARC_BODY_BUDGET`, `packages/index/src/disclosure.ts::MEMORY_BODY_BUDGET`). An arc is a synthesis of many memories, so letting the two compete would let one arc crowd out every concrete memory behind it, and the pack would then explain a pattern while citing none of the evidence for it.

## 9. Reinforcement

`reinforce` (`packages/index/src/reinforce.ts::reinforce`) is the only call site that bumps `state.access` on a read or a reinforcement, and the cooldown is why. `access_count` feeds the salience arm, so a second bumping path would let a loop in an agent replay one query and rewrite the corpus's ranking. Three other paths write the table without answering a query: `memhtml state import`, the store's `onMove` hook, which re-keys the row of a file the store archives through `memhtml archive` or `memhtml correct` (`apps/cli/src/api-layer.ts::layerStore`), and `memhtml doctor --fix`, which deletes orphan rows. A session commit moves and archives paths without that hook, so the access row of a path it moves stays under the old path (`packages/session/src/commit.ts::stage`).

The guard is necessarily expressed twice, once as the SQL `WHERE` clause and once as a pure function, so both read the same constant, `REINFORCE_COOLDOWN_S = 900` (`packages/domain/src/ranking.ts::REINFORCE_COOLDOWN_S`), and a property test pins the two together at the boundary.

The conditional upsert's `RETURNING` clause makes the bumped-versus-cooled split authoritative rather than inferred (`packages/index/src/reinforce.ts::reinforce`). Reading `last_accessed_at` first and deciding in TypeScript would race a concurrent reinforce and report a bump that never happened. Only a non-neutral signal moves `reinforcement_count` and `outcome_score`, because being read is evidence of relevance and not of correctness.

### 9.1. What bumps salience

Salience accumulates evidence that someone chose a memory, so only a chosen open and a deliberate reinforcement bump it.

| Read                                                                                      | Bumps                                     | Why                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `memory_read` or `memhtml read` of a named path, and the `memhtml://file/{path}` resource | yes                                       | the caller chose that memory, which is the strongest signal short of a write (`apps/cli/src/operations.ts::readMemory`)     |
| a path merely returned by `memory_search` or `memory_recall`                              | no                                        | that is the ranker's own guess (`apps/cli/src/operations.ts::searchMemories`, `apps/cli/src/operations.ts::recallMemories`) |
| every curation pass                                                                       | no                                        | a sweep that touches the whole corpus drives everything toward uniform salience, and curation bypasses the tool path anyway |
| `memory_reinforce` with a named signal                                                    | yes, and it moves `outcome_score` as well | the caller is asserting the memory was right or wrong; a signal inside the 900-second cooldown is dropped                   |

Bumping on a returned hit would build a rich-get-richer loop. Today's top five would rank higher tomorrow for having been listed, while the memory that should displace them never appears and so never earns a first bump. The cooldown does not prevent that: 900 seconds bounds one query replayed inside a session, and the drift operates across days.

Reading files off disk in code mode, where the agent runs its own script against the store's files instead of calling a tool, touches no access row. That obeys the same rule without needing an exception.
