# ROADMAP — memhtml

Written 2026-08-06, at the close of the first benchmark campaign
(memhtml-evals: MemoryAgentBench FactConsolidation, BEAM Contradiction
Resolution, and LongMemEval-S all complete as of 2026-08-07).
Every item below names its evidence — a measured number, a probe, or a
commit — and nothing here is speculative. Ranked within each horizon.
`docs/backlog.md` remains the fine-grained ledger; this file is the
system-level view the benchmarks bought.

**Status 2026-08-07: Horizon 1 COMPLETE** — items 1–3 and the tech-debt
block shipped via spec 005, merged to main at
`5decd60` and pushed. Struck items below keep their original text as the
record of what was asked; each carries a `SHIPPED` line saying what landed.

## Where the system stands (measured, 2026-08-06)

| benchmark | memhtml | published reference |
|---|---|---|
| MAB FactConsolidation single-hop (26KB–1.1MB stores) | 92–97% | ~60% at 26KB only |
| MAB FactConsolidation multi-hop | 37–49% | ≤7% all methods |
| BEAM Contradiction Resolution (100K split, 40 probes) | 43.8% mean | 0–5% all systems |
| LongMemEval-S (full 500, judged 2026-08-07) | 67.0% | mid-50s–low-60s memory-system baselines |

Judge caveat: cross-judge numbers are reference points, not rankings — our
judges are verbatim prompt ports running haiku-4.5 where the papers used
gpt-4o / gpt-4.1-mini. Stated in every result header.

What the campaign proved about the ARCHITECTURE, as opposed to any one fix:
git-tree-as-source-of-truth plus a rebuildable index survives contact with
adversarial-scale ingest (18k memories in minutes post-fix), and the
retrieval stack (FTS + vector + recency + salience arms) finds one-fact
memories reliably at every store size tested. The two structural findings
that remain are consolidation ownership and hop chaining — both below.

## Where distribution stands (2026-08-18)

One published package, `memhtml`, carrying two binaries — `memhtml` and
`memhtml-mcp`. All thirteen workspace packages are `private`; the nine
libraries had no consumer outside this repository, and none of the thirteen was
ever published, which is what made collapsing them free. `RELEASING.md` carries
the flow, `docs/design.md` §14 the decisions.

The artifact has a gate of its own because no other tier can see it:
`mise run package:smoke` installs the tarball and drives all 36 commands and all
14 MCP tools through the installed binary, and `--live` adds the three edges the
credential-free run cannot reach (Bedrock embeddings, the sleep phases that call
a model, the consolidator distilling through eve). It found four packaging
defects that a green `pnpm check` could not, catalogued in
`.erpaval/solutions/build-errors/the-published-artifact-is-not-the-workspace.md`.

**Published.** The package is on npm as `memhtml` (0.2.2 at time of writing),
released by release-please on merge to main and authenticated with OIDC trusted
publishing — no long-lived token anywhere. The two external blockers resolved
as designed: the org-level "Allow GitHub Actions to create and approve pull
requests" setting was granted, and the first publish used a one-time token to
bootstrap the package trusted publishing could not create.

## Horizon 1 — pulled by measured evidence — ✅ COMPLETE 2026-08-07

### ~~1. Write-time consolidation as a SYSTEM capability (the H4 finding)~~ — DONE (2026-08-07)

**SHIPPED** (6d8b7bb + 07f4c6e): `detect_conflicts` on `memory_write_batch`
and `memhtml apply --detect-conflicts` — propose-only per-op `conflict
{path, batch_index, claim}`; frame-key port byte-equivalent to the eval's
(differential-tested over 20,060 inputs, 0 mismatches); `files.frame_key`
derived column + partial index (migration 0009, additive; pre-0009 rows
carry NULL until the next rebuild — run `memhtml index rebuild` before
measuring conflict recall on an existing store). Flag renamed from the
candidate `supersede_on_conflict` because the decided behavior never
supersedes. Singular door deferred until pulled.

The single largest score movement of the campaign (multi-hop 1% → 48%,
single-hop collapse erased) came from consolidating conflicting facts at
write time — implemented in the EVAL ADAPTER (memhtml-evals
src/adapter/consolidate.ts, frame-key last-wins), not in memhtml. The
system's own story is currently split:

- `memory_correct` exists but requires the writer to already know the
  target path — it resolves a conflict the agent has ALREADY found.
- Sleep's conflict-detection phase finds conflicts nightly but deliberately
  never resolves them (detection-only by design — choosing a winner is a
  one-way door that belongs to the writer or a human).

The gap: nothing helps at the moment of writing, which is when the writer
still has the context to judge. Candidate shape, smallest first:
`memory_write_batch` (and/or the singular door) gains an optional
`supersede_on_conflict` assist — before committing, run the batch's claims
through dedupe-style frame matching against ACTIVE memories (the
structural-dedup lookup already exists on the write path); on a hit, return
the match as a per-op `conflict` field so the CALLER decides write-new /
correct / skip. Propose-only, like every other assist in the system: the
store never auto-archives on a heuristic. BEAM is the cautionary evidence
for keeping it caller-decided — its gold IS the contradiction, and
last-wins applied blindly destroys the answer (measured: ~4% of BEAM chat
lines collide on a frame key; the eval ran it OFF for that benchmark).

Evidence: memhtml-evals NEXT-SESSION.md rounds 2–3; MAB board 2026-08-06;
BEAM consolidation-off decision 2026-08-06.

### ~~2. Fence auto-detect write-path stamping (backlog 7, decision 3)~~ — DONE (2026-08-07)

**SHIPPED** (6d8b7bb + 1ca44f4 + a05723e): `packages/html/src/detect.ts` —
highlight.js 11.11.1 exact-pinned (since bumped to 11.11.2), port-fidelity proven against all 332
eval-corpus rows, threshold 0.30 (re-measured: precision 95.06%, coverage
24.4%). Write time only; rebuild reads the stamp back. Two validation
hardenings beyond the ask: `DETECT_MAX_CHARS = 4096` abstention ceiling
(unbounded `highlightAuto` measured ~20s blocking CPU at 40KB on the
single-threaded MCP process) and a lazy `createRequire` load so the read
path stops paying ~100ms/~30MB for grammars it never runs.

### ~~3. embedMissing pending scan — scope to the batch~~ — DONE (2026-08-07)

**SHIPPED** (6d8b7bb): optional `candidateChunkIds` on `embedMissing`;
`update()` passes its batch's projection chunk ids. Measured 7/29/56ms @
1k/5k/10k → 3–4ms flat. Behavior change recorded in RUNBOOK/design.md:
`update --embed` no longer incidentally backfills the store-wide embed
gap (that backfill WAS the growing term) — `rebuild --embed` or a bare
`embedMissing()` closes store-wide gaps, including model migration.

### ~~Tech debt block (2026-08-06 doc-rewrite findings)~~ — DONE (2026-08-07), all three SHIPPED (6d8b7bb)

**T1 SHIPPED**: `.github/workflows/check.yml`, one credential-free `check` job (corepack
honors the packageManager pin, store cache keyed on pnpm-lock.yaml, MR +
default-branch rules).

**T2 SHIPPED**: the swap landed exactly as decided — bump moved to
`readMemory`'s explicit open (the `memhtml://file/{path}` resource counts: the
caller named a path), search/recall hit loops bump nothing, and the
salience arm excludes `task` rows plus `resources/people/` reference
records via arm-local predicates ("person-reference" has no memory_type;
the path prefix is the discriminator that matches the decided split).
Three guards mutation-proven. The lived-in-corpus validation gap below
still stands — the rule remains argued from mechanism, not measured.

**T3 SHIPPED**: suggestions became a walkable `SUGGESTIONS` record
validated through the binary's own `parseArgv` in tests (a renamed command
now fails the suite); the stale `--json` form is gone; `MEMHTML_MCP_BIN`
joined `CONFIG_VARS` so manifest and AGENTS.md disclose it (RUNBOOK prose
flipped from "deliberately absent").

Original text of the block, kept for the record:

The full-docs rewrite re-proved every documented contract against the
binary by execution; three defect classes survived into code and belong
in Horizon 1 as one small block:

**T1. CI gate on the remote.** The repo now has a remote and no
pipeline; `pnpm check` is honor-system.
One `.github/workflows/check.yml` running `pnpm check` enforces the definition of
done — no credentials needed, since check gates the discrimination
eval in fake mode. Evidence: no CI config anywhere in history; the
README briefly claimed a CI gate that did not exist (caught 2026-08-06).

**T2. Salience-read semantics — DECIDED 2026-08-06: bump on open, not on
hit; provenance-gated; type-scoped.** (Decision recorded 2026-08-06.)
The rule that resolves the contradiction:
salience should accumulate evidence that someone CHOSE a memory, and
ignore reads that are the system's own guess. Three read tiers, three
policies:

- **Explicit opens count fully.** A `memory_read` of a specific path, or
  a progressive-disclosure expansion of an arc, is the strongest signal
  short of a write — the agent (or the user steering it) chose THAT
  memory. These reads bump.
- **Bulk retrieval hits do not count.** A path merely RETURNED by
  `memory_search`/`memory_recall` was the ranker's guess. Bumping on hit
  creates the structural feedback loop: top-5 today → bumped → higher
  tomorrow → bumped again, while the memory that should displace it never
  breaks in to earn its first bump. An exploratory sweep (8 searches, 20
  reads, 19 irrelevant) injects 20 units of noise per unit of signal.
- **Sleep-cycle reads never count.** Nightly phases touch the whole
  corpus on a schedule; counting them converges everything to uniform
  salience, which is no salience. (Already true — sleep reads bypass the
  tool path.)

The CODE IS CURRENTLY BACKWARDS from this rule, which is stronger
evidence than the doc contradiction that flagged it: `searchMemories` and
`recallMemories` bump every hit (operations.ts:495,507 — the 900s
cooldown limits replay, not the rich-get-richer loop, since ranking
drift operates across days) while `readMemory` — the explicit open, the
one read that SHOULD count — only records a provenance link and never
bumps (operations.ts:469-475). The fix is a swap, not a new mechanism:
move the `bumpAccess` call from the search/recall paths to the read
path. `recordLink` already fires there; bump beside it.

Second half, type scoping (same decision): salience belongs to ranked
fusion over interchangeable candidates and has no business in
exact-keyed or state-predicate access. Task-typed memories are reached
by status/due_at (nominal predicates — and salience would actively
reward STALENESS there: the stuck task re-read during triage outranks
the fresh urgent one). Person/reference records are reached by entity
key, and decay is wrong for identity (a colleague unmentioned for six
months is not less themselves). Episodic/semantic memories about a
person keep salience — "which five of fifty sanju-memories do we
actually consult" is exactly the signal. Implementation: exclude
task/person-reference types from the salience arm's contribution (one
memory-type list in retrieval-sql.ts), leaving their FTS/vector/entity
arms untouched.

After the swap, code-mode.md rule 2 ("reads off disk don't bump") stays
true and stops being an exception — it becomes the same rule: no chosen
open, no bump. Doc updates: format.md salience section + code-mode rule
wording. Verification per the guards-must-fire lesson: a test proving a
memory_read bumps, a search hit does not, and a task-typed row's rank is
salience-invariant — each shown to fail with the rule reversed.

Open validation gap, honestly held: no benchmark in the campaign
exercises salience (fresh store per row, no repeated access). The rule
above is argued from mechanism, not measured. The measuring instrument
is a lived-in-corpus eval — age, supersedence chains, access history,
"returning user" ground truth — which is also what RRF weight tuning
waits on. One gym serves both; build it before tuning either.

**T3. Manifest-derived error suggestions.** Suggestion strings are
hand-written while AGENTS.md is generated from the command table, so
they drift: `apps/cli/src/errors.ts:133` still suggests the stale
`memhtml eval discriminate --json` form, and `MEMHTML_MCP_BIN` is real
(`apps/cli/src/serve.ts:32`) but absent from `CONFIG_VARS`, so
`memhtml manifest` can never disclose it. Derive suggestions from the same
table that drives parsing; that closes the class, not the instances.

## Horizon 2 — pulled by the next order of magnitude — ✅ COMPLETE 2026-08-09

Items 6, 7, and 11 shipped. Item 8 was dropped. Items 4, 5, 6b, 9, and 10 are
each gated on a condition that has NOT occurred, and each states its own trigger
below — they were not built, and they move to the top of Horizon 3's queue by
default:

| item | trigger, unfired |
|---|---|
| 4. ANN for vector search | a real corpus approaching ~100k chunks |
| 5. the embeddings-on write wall | stores passing ~50k files |
| 6b. embedding-proximity conflicts | the lived-in-corpus gym that salience and RRF tuning also wait on |
| 9. committed embedding cache | a CI stage that needs live search |

**Deliberately not closed, and each is a decision rather than an omission:**

- **HOP-2 and CODE-3 stay `draft`.** Both are measurement requirements and
  benchmarks belong to a separate session; HOP-2 additionally cannot be measured
  on the MAB corpus as it stands, because that corpus carries no entity
  references. See item 6 and the benchmark handoff notes.
- **Prompt caching (item 11 step 5) is unbuilt**, gated on a wire capture proving
  the cache point lands through eve plus hit-rate numbers.
- **The consolidator sandbox's network egress is accepted and documented, not
  fixed.** eve exposes no option and rejects `setNetworkPolicy`, so the mitigation
  is outside eve.
- **The corpus snapshot mount is deferred**, with the scoping problem named in
  item 11.

### 4. Vector search past ~100k chunks needs ANN

Retrieval is brute-force KNN via `vector_distance_cos` — correct and fast
at benchmark scale (18k memories), a query-time wall at 100k+ chunks.
No action until a real corpus approaches that size; when it does, the
options are a vector-index extension loaded into SQLite or an external ANN
sidecar. Keep the decision open; record corpus size at
sleep time so the approach is data-triggered, not calendar-triggered.
Evidence: retrieval-sql.ts reading, noted 2026-08-05.

### 5. The embeddings-on write wall is unattributed

The projection lane is flat: six consecutive 256-op batches against a
constant 10k-file store cost 6/5/6/5/5/5 ms in `db.writeAll` (2026-08-12,
node 24.19.0). What no probe attributes is the REST of an embeddings-on
batch's wall — the embed calls, the pending scan, and per-op overhead
across a 256-op round. Fine until stores pass ~50k files;
probe-embed-cost.mjs is the rig, lane-split and with a deterministic
embedder, when it matters.

### ~~6. Multi-hop assist — the reasoning half of the H4 finding~~ — DONE (2026-08-08)
**SHIPPED** (2026-08-08; `82c2600`..`133408a`)

`memory_search` takes an `entity` scope on both doors, every hit publishes its
entities in the same `type:name` form the scope accepts — so a second hop is a
COPY, not a spelling guess — and an unmatched scope returns visibly empty via
`scopeEmpty` rather than widening. HOP-1 and HOP-3 are `implemented`, with 15
mutation checks and 14 guards fired.

Verified end to end on a real chain (`Our Mutual Friend → Charles Darwin → Amala
Paul → Belgium`): two `memory_search` calls, hop 2's scope copied verbatim from
hop 1's `entities`, non-matching memories excluded, and `--entity person:Nobody`
returning `hits: []` with `scopeEmpty: true` rather than silently widening.

**HOP-2 stays `draft` deliberately, and the reason is a substrate fact rather
than a shortfall.** It is a measurement requirement ("at most two tool calls"),
and the after-measurement ran: all four MAB multi-hop rows, 400 questions, mean
5.61 tool calls against a 5.65 baseline — and **zero entity-scoped calls**. That
zero is not low adoption. Entities are SUPPLIED, never extracted
(`packages/html/src/parse.ts:337` reads them from `memhtml-entity` meta elements;
there is no NER anywhere in `packages`/`apps`), and the eval adapter declares
none, so every hit in the MAB store publishes `entities: []`. There is nothing
for hop 2 to copy, and an agent that reached for the scope anyway would be
inventing the string the tool description tells it not to guess. So the assist
cannot be measured on this corpus as it stands: HOP-2 needs a corpus decision
before it needs another run. Recorded for the benchmark session in the
internal benchmark handoff notes.

Original entry, as the record of what was asked:

With the store holding exactly one value per relation, the remaining MAB
multi-hop misses (~52–63/row) are hop-CHAINING failures under the answer
agent's 8-turn budget, not retrieval. That is primarily a consumer-side
problem, but memhtml owns one lever: entity-scoped search already exists,
and a `memory_search` that accepted an entity from a prior hit's entities
list as a scope would cut a two-hop chain from 4+ tool calls to 2. Sequence
AFTER item 1; measure on the same MAB multi-hop rows.

### 6b. Embedding-proximity conflict detection — the paraphrase layer

(Added 2026-08-07.) Frame-key matching (Horizon 1 item 1)
only catches claims sharing a frame shape; a full paraphrase ("the deploy
failed because of the lockfile" vs "the lockfile broke the deploy") sails
past it. The next layer is a KNN proximity check at write time — writes
already compute document embeddings, so the marginal cost is one vector query
per op. Constraints settled at recording time: propose-only like every other
assist (BEAM's lesson stands — the caller decides, because sometimes the
contradiction IS the answer); surfaces through the same per-op `conflict`
field; and the threshold must be MEASURED on a labeled near-duplicate corpus
before deployment, never guessed (the fence-detector discipline). That
measurement wants the lived-in-corpus gym that salience/RRF tuning already
waits on — one gym serves all three. Note this layer puts Bedrock on the
conflict path where frame keys are credential-free; keep frame keys as the
floor, proximity as the opt-in upgrade.

### ~~7. Code-mode — the corpus as a programmable API (read-only)~~ — DONE (2026-08-09)
**SHIPPED** (2026-08-09; `623d7d3` the shared mount, `bdc468a`
`memhtml exec`)

`memhtml exec` runs an agent-supplied script inside a `just-bash` sandbox over a
read-only corpus mount, one JSON envelope out, response type `exec.report`. The
corpus helper is preloaded and the script arrives by `--file`, `--script`, or
stdin. CODE-1 and CODE-2 are `implemented`.

**The spike collapsed 7(b) from "build a runtime" to "compose one."** `just-bash`
3.3.0 — already a dependency, pinned to what eve (0.38.3) loads — ships 88 commands
including `js-exec`, a QuickJS-sandboxed JS/TS runtime with a Node-compatible
`node:fs` shim. So the work was a mount, an opt-in, and a helper rather than a
runtime. The mount composition is shared with the consolidator on one helper
(`apps/consolidator/src/mount.ts`), because both need the same read-only
`OverlayFs` under a `MountableFs`.

Two corrections this entry needed, both measured rather than argued:

- **The parser is `node-html-parser`, not cheerio.** cheerio and linkedom CANNOT
  load in QuickJS: `Object.assign` onto a function throws when the source carries
  `toString`, which is non-writable there. The text above picked cheerio "because
  the runtime is bun", and that choice does not carry over — two of the four
  parsers this entry called interchangeable are unusable in the sandbox.
- **The claim selector is `article mark`, not `article > mark`.** The markup is
  `<article><p><mark>`, so the claim is a DESCENDANT. `article > mark` matches
  NOTHING, and a helper written from the old description silently reported zero
  claims. Three documents agreed on the wrong selector; the markup settled it.

CODE-1 was built ahead of its recorded pre-condition, deliberately. The
pre-condition was "real usage shows which cookbook recipes agents reach for";
that evidence never arrived, and the spec now names the decision that actually
triggered the work rather than a condition that never occurred. The index handle
was dropped from CODE-1's response: `memhtml exec` covers the STRUCTURAL and LEXICAL
planes only, which is the division this entry itself draws.

**CODE-2's index half is vacuous in v1, by construction rather than by guard** —
no index handle is exposed, so there is nothing to refuse. The store half is
real and mutation-verified: dropping `readOnly: true` makes the EROFS assertion
fail. If an index handle is ever added it is a SECOND PROCESS, and the measured
rules are WAL's (`node scripts/probe-sqlite-concurrency.mjs`): a second process
opens a live store, each statement reads the latest COMMITTED state, `readOnly:
true` refuses it every write, and a write contending with the live writer past
`busy_timeout` reports `SQLITE_BUSY`.

Egress is decided by whoever calls `new Bash()`. `memhtml exec` passes no `network`
and no `fetch`, so `curl` is not a command in its sandbox and the guest's `fetch`
refuses on call. It does NOT share the consolidator's exposure, which is eve's
hardcoded full-access option. `typeof fetch` is a function under both, so a
capability check on the global would enforce nothing.

**CODE-3 stays `draft`.** It scores code-mode against tool-chaining on the same
MAB rows, which is a benchmark, and benchmarks are the separate pre-Horizon-3
session. Its pre-condition ("memhtml exec has landed") has now fired. What it needs
is recorded in the internal benchmark handoff notes.

7(c), the `memory_eval` MCP tool, remains future work and is unstarted.

Original entry, as the record of what was asked:

The closed vocabulary makes the tree a queryable API without any new
surface: `article mark` is always the claim, `meta[name="memhtml-*"]` is
always typed metadata, `link[rel^="memhtml-"]` is always an authored edge,
`dl` pairs are always facets. An agent that writes cheerio/lxml code
against `$MEMHTML_ROOT` composes multi-hop traversals in ONE execution instead
of one tool round-trip per hop — the same 8-turn budget the multi-hop
misses (item 6) die under, spent once instead of 4+ times. It also covers
the corpus-question long tail no tool enumerates: live contradiction
pairs, orphan census, entity co-occurrence, supersedence-chain walks.

Measured 2026-08-06 (docs/code-mode.md carries the code and output): a
~100-line cheerio helper under bun parses the 304-file fixture corpus and
answers five such questions in under 1s total; the same helper drives
`bun repl` / `bun -e` for interactive exploration. Verified against the
fixture generator's output, i.e. against the format contract itself.

Re-measured 2026-08-09 inside the `memhtml exec` sandbox, where the runtime is
QuickJS rather than bun: **cheerio and linkedom cannot load there at all**
(`Object.assign` onto a function throws, because `Function.prototype.toString`
is non-writable), so the parser is `node-html-parser` with a small `atob`
shim. On a 305-file corpus the census ran in 598ms and the edge-chain walk
resolved 410/410 edges into 201 chains, longest 8 hops, in ONE execution at
430ms. The selectors carried over unchanged; only the library changed.

Boundaries that make it safe: READ-ONLY by contract — every write still
goes through `memhtml apply` / `memory_write*`, so the one-commit-per-op,
dedup, and conflict machinery cannot be bypassed; and reading files off
disk touches no access row, which since T2 landed is the SAME rule the
tool path follows rather than a carve-out from it — salience bumps on a
chosen open, so no chosen open means no bump. Code-mode covers the structural and
lexical planes only — no cosine, no RRF, no salience. The division of
labor: `memory_search` finds entry points, code traverses from there;
scripts that need ranked retrieval shell out to `memhtml search` and consume
its envelope, which the one-envelope-per-command contract already makes a
code-mode API.

Sequencing, cheapest first: (a) docs/code-mode.md cookbook — DONE with
this entry; (b) a `memhtml exec` sandboxed runtime preloading the helper
(corpus/backlinks/chain + a read-only `index.db` handle) once the recipes
agents actually reach for are known; (c) a `memory_eval` MCP tool — the
collapse-N-tools-into-one-API endgame — only after (b) shows which
traversals earn it. A traversal gate belongs beside the discrimination
gate when (b) lands: fixture questions answerable only via multi-hop,
scored code-mode vs tool-chain on accuracy and tokens, so "code beats
chaining" becomes a number on the same MAB rows as item 6.

### 8. ~~Multi-machine state plane — merge-commutative counters~~ — DROPPED

Descoped 2026-08-07: multi-machine is not a
requirement. The original analysis stands if that ever changes
(`access.jsonl` is last-writer-wins on merge; fix shape was
merge-commutative counters), but nothing waits on it and no trigger is
armed.

### 9. Committed embedding cache (opt-in)

Disaster recovery is clone → rebuild → full Bedrock re-embed of the
corpus. Committing embeddings (~4KB per memory, ~40MB at 10k) makes a
fresh clone searchable with zero spend and no credentials — which is
also what a CI job wants. Costs repo weight; keep opt-in. Trigger: a CI
stage that needs live search (the second-machine trigger died with
item 8).

### ~~10. Lexical fallback arm behind config~~ — DONE (2026-08-12)

**SHIPPED**, and by removal rather than by the fallback arm this item
proposed. The single-vendor-flag dependency is gone: the index is plain
SQLite through node's built-in `node:sqlite`, the lexical arm is FTS5,
and there are no driver flags to rename. The fallback arm was to buy
independence "at a known quality cost"; the port bought it at a quality
GAIN — `bm25()` replaces an unrankable MATCH order, and the fixture's
discrimination MRR reads 1.0 with zero inversions of 36 probes.

The follow-on this exposes: that fixture is now **saturated**. Every
target outranks its own controls and every other memory in the corpus,
so `mrr` and `corpusMrr` both read exactly 1 and the gate has no
headroom left to measure an improvement — it can only detect a
regression. A harder fixture (more near-miss distractors per probe, or
probes drawn from the lived-in corpus) is what restores its resolution.
Trigger: the next ranking change that this gate reports as "no change".

### ~~11. trace-consolidation v2 — the unbuilt half of the trace plane~~ — DONE (2026-08-08, redesigned 2026-08-09)
**SHIPPED** (2026-08-08; redesigned 2026-08-09 —
`623d7d3`, `009430e`, `d216015`)

The agent is `apps/consolidator` — eve over the AI SDK Bedrock provider,
`just-bash` sandbox, `jwtHmac` over a per-run secret, pinned to loopback. The phase hands it
up to 10 unread sessions per night (newest first, over 8 KiB, settled for
an hour) and lands each candidate that clears the bar as its own commit on
the sleep branch, which is what puts a distilled memory behind the
discrimination gate. Sleep depends on a structural port, never on eve;
`apps/cli` is the one module that knows both halves exist.

Every recorded decision held: Opus 5 on the Bedrock global endpoint with
high reasoning effort, the very-high bar for writing (stated in the agent's
instructions AND enforced as a two-evidence-quote minimum in both the
schema and the phase's own gate), and the reviewable-commit discipline.
One thing was added rather than decided in advance: the evidence quotes go
in the COMMIT BODY and never into a memory, so `.memhtml` still holds no
session content, and the commit body is indented two spaces because git
otherwise folds a quote shaped like `Memhtml-Phase: integrity` into the trailer
block a resume reads.

**The 2026-08-09 redesign, an approved recorded decision, closed the largest defect in the
above and two review findings with it.** Four of its five steps shipped:

1. **The caller chooses the port; the stdout parse is gone** (`623d7d3`). `--port 0`
   made eve the only party that knew the port, so the client scraped it back off
   stdout and needed ANSI-stripping and loopback validation to do it safely.
   Binding an ephemeral port in-process and passing it explicitly makes the origin
   a string this process composed, and the parse and its guards were deleted with
   the thing they defended. Readiness is now a poll of eve's health route. The
   bind race cannot be closed and a nitro bind collision produces no
   distinguishable error — the process stays alive, prints its normal line, and
   never listens — so a lost race and a slow start are retried alike on a fresh
   port.
2. **One shared mount helper** (`623d7d3`), used by both this app and `memhtml exec`
   rather than written twice. The nested overlay's `mountPoint: "/"` is
   load-bearing and a file count CANNOT check it: all three spellings report the
   same count and resolve files at different paths, so the guards assert resolved
   paths.
3. **A manifest replaced the `clientContext` payload** (`009430e`), which is the
   defect. `clientContext: { files }` is not a filesystem write — eve renders it as
   ONE user-role context message, so a 10-transcript batch arrived as a peer
   message beside the operator's instructions, ~750k tokens prepaid, and the files
   reached `/workspace` only if the model echoed them back. Transcripts now arrive
   on a read-only mount, and the model gets metadata joining `traces` to
   `memory_session_links`: paths, date ranges, prompt and turn counts, and the
   memories each session already produced. Cost became demand-driven (~1k tokens
   of manifest) instead of prepaid.
4. **The declared window is 1,000,000** (`009430e`). It said 200,000 only because
   eve resolves windows from a catalog that does not know the global inference
   profile, and Opus 5 on Bedrock serves 1M. The number drives compaction
   thresholds.

**Step 5, prompt caching, is deliberately NOT built, and its trigger is
recorded.** `providerOptions.bedrock.cachePoint` is real
(`@ai-sdk/amazon-bedrock` `dist/index.js:448-457`, and usage returns
`cacheReadInputTokens`/`cacheWriteInputTokens`), but eve DROPS `providerOptions`
for external providers, and the `wrapLanguageModel` + `defaultSettingsMiddleware`
workaround is verified only for reasoning settings, never for cache points.
Trigger: a wire capture proving the cache point lands, plus hit-rate numbers. The
instructions plus manifest are the stable prefix; transcripts must stay on the
filesystem or they poison it.

The watermark defect that came with the old seeding path is now closed
structurally, not by care: `analyzedSessionIds` is REQUIRED on the outcome, so no
consolidator can return a shape that leaves the phase watermarking the batch it
merely ASKED about, and the phase intersects with the batch so the set can only
narrow. A session whose transcript never arrived is never recorded as
consolidated.

Two things remain open and are accepted rather than fixed:

- **The corpus snapshot mount is deferred.** A pinned worktree needs a
  `release()`, so it belongs to a per-run scope while the client is constructed
  once; `pinCorpusSnapshot` exists and is tested but is unwired. `linkedMemories`
  in the manifest covers the load-bearing "is this already written down" check
  meanwhile.
- **The sandbox has full egress and this app cannot turn it off.** eve hardcodes
  `dangerouslyAllowFullInternetAccess`; a probe from inside reaches a public host,
  obtains an IMDSv2 token, and reads the instance-role name. Mitigation lives
  OUTSIDE eve — a network namespace, an IMDS block, or a hop limit of 1. Run
  `node scripts/probe-sandbox-egress.mjs`. The channel is no longer anonymous
  (`d216015`), which closes the composition where any local UID could drive that
  sandbox, but a same-UID reader of the server's environment still wins.

What remains open is the watermark's coverage under reconsolidation: losing
`index.db` loses every watermark, and the next cycle re-reads and re-distils
those sessions. Safe (a duplicate candidate is a commit a reviewer declines)
but not free, and worth revisiting if the corpus ever makes it expensive.

Decisions recorded 2026-08-07 (agent stack revised same day from Strands
to eve):

- **Model**: Opus 5 on the Bedrock global endpoint, high reasoning
  effort. No cost ceiling.
- **Agent stack**: eve (Vercel's open-source agent framework,
  github.com/vercel/eve, Apache-2.0, npm `eve`) over the AI SDK v7
  Bedrock provider (`@ai-sdk/amazon-bedrock`). Grounded 2026-08-07:
  `defineAgent({ model })` accepts a provider-authored AI SDK
  `LanguageModel` directly — no AI Gateway and no Vercel account
  required; `reasoning: "high"` is the provider-agnostic effort option;
  the Bedrock provider takes global inference-profile IDs and
  `reasoningConfig` budgets, and authenticates via
  AWS_BEARER_TOKEN_BEDROCK or the SDK credential chain. The sandbox is
  an adapter: LOCAL backends are Docker (present on this box),
  microsandbox (needs KVM — absent here), or just-bash; Vercel Sandbox
  is only the deployed default and is NOT used. `defaultBackend()`
  falls through Docker → microsandbox → just-bash on its own. The
  consolidator's grep/jq over transcript JSONL runs through eve's
  built-in sandbox tools (bash/read/grep/glob against /workspace) with
  the transcript dir seeded or mounted; `networkPolicy` can pin egress
  to the Bedrock endpoint. eve is in public beta (framework surface may
  move; docs ship in node_modules/eve/docs — ground against the
  installed version at build time). Durability via the bundled Workflow
  SDK; evals as scored suites runnable in CI.
- **Bar for writing**: trace-derived memories face VERY HIGH scrutiny.
  The raw data already sits in the transcripts and any agent can jq/grep
  it, so a distilled memory earns its place only by carrying high signal
  the raw form does not surface — e.g. high-frequency recurring error
  shapes (semantic/fuzzy/exact match being one lens, not an exhaustive
  one). Distillation is compression plus judgment; a memory that merely
  restates what one grep finds is below the bar.
- **Gate**: synthesized memories go through the same reviewable-commit
  discipline as every other sleep mutation, behind the discrimination
  gate.

## Horizon 3 — standing backlog, unchanged priority

- **Task family over MCP** (backlog 4): CLI-only today; MCP agents cannot
  open/move tasks. Shape settled (task_add/task_status/task_list,
  `failure: ToolFailure` discipline).
- **Sleep backfill for unlabeled fences** (backlog 7 decision 5): now that
  the detector has a measured threshold, this is mechanical — but wait for
  a corpus with enough unlabeled code to matter.
- ~~**Doc-sync sweep** (backlog 6): design.md's ResponseType line names 16 of
  31 members; derive it from the enum.~~ — RESOLVED (2026-08-18): design.md
  now cites the constant (`apps/cli/src/envelope.ts:12`) without enumerating,
  so the enum (32 members today) can grow without the doc drifting.
- **Batch op vocabulary v2** (backlog 5): defer until a consumer pulls it.
- **Upstream watch** (backlog): effect McpServer still drops the MCP
  `instructions` initialize field; new tools must declare
  `failure: ToolFailure` or errors mask.

## Standing lessons the campaign wrote into `.erpaval/solutions/`

These are constraints on HOW future work here is done, not features:

- **A green suite says nothing about the published artifact** — every tier
  resolves `@memhtml/*` through pnpm's links, where run-time assets exist
  whether or not a manifest declares them. Three shipped absent from every
  tarball. Any future change to what ships needs a claim in the packaging table
  and a pass through `package:smoke`. build-errors/
  the-published-artifact-is-not-the-workspace.md.
- **Probe the real composition before trusting a suspect list** — the
  dominant term was unlisted twice in a row (projectFromTree per-op walks,
  then FTS live-insert accumulation). performance/
  profile-before-fixing-named-suspects.md.
- **"Flat" measured on a fresh structure says nothing about the Nth batch
  on an aging one** — probe consecutive rounds at constant size before
  ruling a term out. performance/fts-live-insert-accumulation.md.
- **One fact per memory is a retrieval invariant, not a style preference**
  — 16KB grab-bag memories rank by their first fact's gist and collapse
  retrieval at scale (MAB round 2, H1). Any future bulk-import surface
  should split to fact grain or say loudly that it does not.
- **A new guard test must be shown to fail** (break the invariant
  deliberately, watch it fire, restore) — applied to the bm25 sort
  direction, which fails the gate as DESC, and to the eval's consolidation
  test; keep applying it.
- **A probe must cross the exact boundary the constraint is about, and vary the
  thing under test** — "can a second process read the index" was answered wrongly
  twice in one session, in opposite directions, each time by a probe that ran and
  printed output. A probe that crosses a SIMILAR boundary is not weaker evidence,
  it is evidence about something else, and a probe holding the configuration fixed
  cannot discover that the configuration is the answer.
  `scripts/probe-sqlite-concurrency.mjs` obeys both rules, so the next reader
  measures instead of citing.
- **An accepted option is not an enforced option** — a driver that types an
  option in its constructor signature may still ignore it, and a guard built on
  it passes review, typecheck, and every functional test while enforcing nothing.
  When a safety property rests on a library flag, prove the flag by attempting
  the thing it forbids. Same shape as `typeof fetch` being a function in a
  sandbox with no network.
- **A capability check beats a capability assumption** — cheerio and linkedom
  cannot load in QuickJS, so two of the four parsers item 7 called
  interchangeable are unusable there. The doc's choice was tied to bun and nobody
  had run it elsewhere. test-failures/a-wrong-count-reads-as-a-finding.md.
- **A wrong count reads as a finding about the data** — `0/410 edges resolved` and
  `withClaim: 0` were both probe bugs that looked like facts about the corpus.
  Census probes assert against an independently-derived total; they never report a
  count.
- **Put the qualifier in the claim, not the surrounding prose** — "the index's
  lock is exclusive" kept its mechanism and lost the WRITABLE that carried its
  meaning, and got re-derived wrongly two sessions later. Write the claim so it is still
  true when it is the only sentence left, then gate it with a test that fails when
  the qualifier is deleted. architecture-patterns/put-the-qualifier-in-the-claim.md.
- **Ask who called the constructor before recording a boundary** — sandbox egress
  belongs to whoever calls `new Bash()`, so two consumers of one sandbox library
  do not necessarily share one boundary.
  architecture-patterns/sandbox-egress-is-set-by-the-constructor.md, and
  `scripts/probe-sandbox-egress.mjs`.
- **Use `setsid` for long runs** — the harness's background reaper killed an eval
  row at question 87 of 100, and `appendFileSync` had already written the partial
  lines, so a naive rerun would have duplicated question ids into every mean.
