# Backlog — recorded 2026-08-03

Ranked. Each item names its evidence; nothing here is speculative.

## ~~1. Close the empty-claim gate hole~~ — DONE (T-AC-7-1)

Constraint 1 now includes "the one `<mark>`'s text must be non-empty", using the `files.gist` rule
as the emptiness predicate (`packages/html/src/constraints.ts`'s `isEmptyClaim`) so the constraint
and the extraction cannot disagree. Mutation-proven; `parseMemory` refuses and `checkMemory`
reports, so the store's render gate refuses the write before any commit. The door derivations are
now defense in depth. One fixture relied on the hole (`packages/index/tests/project.test.ts`
reached an empty gist through `claim: "<code>x</code>"`) and was rebuilt against `newMemoryDoc`,
which is the remaining legitimate producer of a `gist: ""` doc.

## ~~2. Consolidate claim derivation~~ — DONE (T-AC-7-1)

One home: `apps/cli/src/prose.ts`, exporting `claimFromProse`/`proseTail` through `@memhtml/cli`. Both
doors import it; `apps/mcp`'s `claimOf`/`restOf` are deleted. The two copies were byte-equivalent
modulo names, so no semantics were reconciled — all ten pre-existing assertions kept their inputs
and expectations verbatim. A grep lock over `apps/mcp/dist` (`tests/tools.test.ts`) fails on a
re-added copy under any name, matching the derivation's regexes rather than its identifiers.

## ~~3. Switch the eval harness to the batch door~~ — DONE (T-AC-7-2, memhtml-evals cd7810a)

The eval harness adapter (memhtml-evals `src/adapter/memhtml.ts`) still ingests via singular
`memory_write` with the `<time>` markup in `body` — so `event_at` stays NULL and ingestion pays
N round-trips. One change: ingest through `memory_write_batch` with `article_html` ops. This is
the change that turns the whole passthrough+batch arc into benchmark numbers (LongMemEval
temporal-reasoning). The adapter's own header comment anticipates it.

Resolution: the adapter buffers ingest() and flushes ONE memory_write_batch per reset() window
(at first answer(), close(), or flush()), each fact as article_html with the dataset timestamp
as a <time datetime> element. Live smoke: event_at carries the dataset timestamps. Hardening:
escapeHtmlText proven load-bearing via <script>; unsortable timestamps degrade to escaped text
per-op rather than aborting the window's atomic batch.

## 4. Expose the task family over MCP (medium)

The `memhtml task` CRUDL family (docs/tasks.md) is CLI-only; MCP agents cannot open or move tasks.
Looked like sequencing, not a decision (this session's surface enumeration). Shape: task_add /
task_status / task_list tools over the same operations, ToolFailure + description discipline
already established.

## 5. Batch op vocabulary v2 (defer until pulled)

The JSONL/ops envelope carries `op: "write"` precisely so correct/link/archive can join without
a wire break (spec 004 D4). No current consumer needs them; build when one does.

## 6. Doc-sync sweep (small, hygiene)

`docs/design.md`'s ResponseType line names 16 of 31 `RESPONSE_TYPES` (15 omissions, none
spurious — T-AC-6-4 finding). Candidate: derive that line from the enum the way AGENTS.md is
derived, or trim the doc to point at the enum.

## 7. Code snippets: fences in the prose door + `data-lang` (CORE DONE 2026-08-04, fc6addb)

Decisions 1, 2, and 4 shipped: `@memhtml/html` `fences.ts` owns the backtick-fence grammar (one copy
for the template and `prose.ts`'s paragraph splitter, so a blank line inside a fence no longer
splits it); a whole-paragraph fence renders as `<figure><pre><code data-lang>` with the claim
never fused onto it; a malformed `data-lang` is a constraint-6 warning; and `data-lang` promotes
to a `lang:` entity via the new `codeLangs` extraction. Docs, guide topics, AGENTS.md, and the
ARTICLE_HTML_CONTRACT updated. Five mutations proven to fire; live smoke through `memhtml apply`
verified bytes and the `lang:ts` query.

Decision 3 shipped (T-AC-2-1): `detect.ts` ports the eval's winner — highlight.js pinned exactly
11.11.1, the measured confidence formula, a 12-name vocabulary — and stamps unlabeled fences at
write time above 0.30 (the measured 0.28686 operating point, precision 95.18%, rounded safe). Nine
mutations proven to fire, including grep and dependency locks keeping detection out of `@memhtml/index`.
REMAINING from the plan: decision 5's sleep backfill (v2, deferred until the corpus has unlabeled
code).

Original plan (2026-08-04, recorded decision). The gap is bigger than language tagging: the PROSE door
cannot author code blocks at all — `articleHtmlFor` (packages/html/src/template.ts)
escapes every body paragraph into a `<p>`, so a snippet written through `memhtml write`/`memory_write`
flattens to paragraph text. Real `<pre><code>` only enters via `article_html` or hand-editing.
Agents naturally write fenced blocks, and a fence's info string (```ts) carries the language for
free — so language tagging rides on fence support, with auto-detect only as the fallback.

Design decisions (settled at plan time):

1. **Attribute: `data-lang="ts"`, never `class`.** Constraint 3 forbids `class` outright
   (`packages/html/src/constraints.ts:224-248`, "presentation is not memory"), and `lang=` is a
   BCP-47 human-language attribute — using it for code would corrupt document semantics.
   `data-lang` is legal HTML anywhere and reads plainly in view-source. Unknown values are a
   doctor WARNING (constraint-6 degrade-gracefully style), never a refusal.
2. **Prose door learns fences.** In the template's paragraph pipeline: a body paragraph that is a
   fenced block becomes `<figure><pre><code data-lang="...">…</code></pre></figure>`, whitespace
   preserved verbatim (the hash rules already carve out `<pre>`). The fence info string wins
   outright; no detection runs when the author stated the language. Works through singles and
   batches on both doors automatically (they share the template).
3. **Auto-detect: propose-only, at WRITE time, stamped into the file.** A detector proposes a
   language for unlabeled fences; stamp `data-lang` only above a measured confidence threshold,
   else omit the attribute. Two rules from the symspec lessons: MEASURE the detector against real
   snippets before picking the threshold (never guess it — the 0.82-vs-0.72 lesson), and
   detection must NOT live at index time — the tree is the system of record, and an index-time
   detector would make `rm index.db && rebuild` nondeterministic across detector versions,
   breaking the rebuildability contract. Candidates to eval: `flourite` (tiny, zero-dep) vs
   highlight.js `highlightAuto` (heavier, better-known); the eval picks.
4. **Indexer semantics — what makes it retrieval, not decoration.** Following the `<dfn>` →
   `concept:` promotion precedent (`packages/index/src/project.ts`, entityRowsFor), `data-lang="ts"`
   promotes to a `lang:ts` entity — `memhtml list --entity lang:ts` and entity-scoped search find
   every memory carrying TypeScript with zero new query machinery. Code text already lands in
   `body_text` (searchable) and stays out of `gist`.
5. **Sleep backfill (v2, deferred).** A curation phase proposing `data-lang` on existing
   unlabeled blocks — natural fit, since every sleep mutation is already a reviewable commit
   behind the discrimination gate. Build when the corpus has enough unlabeled code to matter.

Scope: template + vocabulary/constraints + one projection rule + docs/format.md row + tests;
the detector eval is its own task. Risk concentrates in the fence parser inside the prose path
(escaping bugs live there) — mutation-proof it like the batch fold. Update the manifest guide's
`authoring` topic and ARTICLE_HTML_CONTRACT when it lands.

## Conflict assist (H1 AC-1-1 + AC-1-2, landed on feature/roadmap-h1)

`frameKeyOf` is ported into `@memhtml/domain` from the eval harness's `consolidate.ts` (differentially
verified over 20,060 inputs, 0 mismatches) and surfaced as a derived, indexed `files.frame_key`
computed at projection time — migration 0009, additive, partial index over ACTIVE non-task rows,
deliberately NOT unique. `memory_write_batch` and `memhtml apply` take an optional `detect_conflicts` /
`--detect-conflicts` and report a per-op `conflict { path, batch_index, claim }`. Propose-only: no
auto-archive, no last-wins, no write blocking. See docs/design.md's batch section for the reasoning
and the two fold asymmetries.

REMAINING, in rough order of pull:

1. **`memory_search`/`memory_recall` do not surface conflicts.** The assist is write-time only, so a
   retrieval hit whose slot holds two live claims looks like one uncontested fact. `frame_key` is on
   `files` and indexed, so a hit could carry its slot-mates cheaply. Wait for a caller that wants it.
2. **A `conflicts` count in `summary` (v2).** Deliberately omitted — the five current numbers
   partition the ops and a conflict is not an outcome. Add only with a consumer that needs the count
   without walking `results`.
3. **`article_html` ops report nothing.** The claim lives inside the caller's markup and the ops
   layer never parses it. Closing this means either parsing each op's article before the store
   renders it (a second parse, and a second place the gist rule can drift) or moving the assist
   behind the store's own render — the second is the honest fix and it is a bigger change than v1
   earned.
4. **No sleep-cycle phase consumes frame keys.** A curation phase proposing corrections for slots
   with several live claims is the natural next consumer, and it fits the existing shape: every
   sleep mutation is already a reviewable commit behind the discrimination gate. Deferred until the
   corpus has enough contradictions to be worth a phase.
5. **Pre-0009 stores under-report until a rebuild.** SQL cannot call `frameKeyOf`, so 0009 does not
   backfill; existing rows carry NULL `frame_key` until `memhtml index rebuild` or each file's next
   update. The consequence is that the assist finds FEWER conflicts on an un-rebuilt store, never
   wrong ones — a safe degradation, stated in the migration header.

## Upstream watch

- effect `McpServer` never emits the MCP `instructions` initialize field
  (`McpSchema.ts:701` declares it; `McpServer.ts:1497-1501` omits it, 4.0.0-beta.102). When
  effect wires it, move the guide's `write-surfaces`/`when-to-batch` prose into it — comment at
  `apps/mcp/src/server.ts` marks the spot.
- effect masks handler errors unless a `failure:` schema is declared — any NEW tool must declare
  `failure: ToolFailure` or its errors read "internal server error". Locked by wire tests; the
  lesson is `.erpaval/solutions/api-patterns/xor-params-and-mcp-error-masking.md`.

## Code-mode (recorded 2026-08-06)

ROADMAP item 7 + docs/code-mode.md landed via feature/code-mode-roadmap (merge 50ba916).
Docs-only: the cookbook's helper and five recipes ran against the fixture corpus but no
package ships them yet. Next pull: `memhtml exec` (sandboxed helper preload, read-only index.db
handle) once real usage shows which recipes agents reach for; then the traversal gate beside
the discrimination gate. `pnpm check` green pre-merge (48/48 tasks).
