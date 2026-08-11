# Spec 005 — ROADMAP Horizon 1: consolidation assist, fence auto-detect, batch-scoped embed scan, tech-debt block

Requested 2026-08-07: "/erpaval the next milestone of memhtml per the
roadmap.md". Horizon 1 of ROADMAP.md (written 2026-08-06 at the close of the benchmark
campaign): items 1-3 plus the tech-debt block T1-T3. The roadmap is the spec's parent —
each item already names its evidence and, for T2, its decided semantics.

## Grounding facts (verified this session, 2026-08-07)

- G1. Detector eval verdict (memhtml-evals results/detector-eval-2026-08-04.json):
  winner highlight.js `highlightAuto`, operating threshold 0.28685957116771854,
  measured precision 95.18%, coverage 25.0% on a 332-snippet corpus. Confidence
  formula `1 - exp(-max(0, (top - runnerUp)/lines))` with canonical-aware
  runner-up (a dialect duel that normalizes to the same vocabulary token uses the
  full top score as margin). hljs runs its FULL grammar set deliberately —
  restricting grammars to the vocabulary measured 0.9% vs 25% coverage at the
  precision floor. Reference implementation: memhtml-evals
  src/detector-eval/detectors.ts (hljsDetector) + vocab.ts (CANONICAL_LANGS,
  ALIASES). The vocabulary must match memhtml's LANG_TOKEN exactly.
- G2. T3 targets: suggestions are hand-written in `suggestionsFor()`
  (apps/cli/src/errors.ts:115-137, stale instance :133); the single source for
  parsing + manifest + AGENTS.md is COMMANDS/GLOBAL_FLAGS
  (apps/cli/src/commands.ts); CONFIG_VARS (apps/cli/src/config.ts:24-59) lacks
  MEMHTML_MCP_BIN, which is real (apps/cli/src/serve.ts:32, read :50-51).
  RUNBOOK.md:20 currently documents that absence as DELIBERATE — the prose flips
  with the code. Manifest test cli.test.ts:156-164 and AGENTS.md byte-lock
  agents-doc.test.ts:80-88 both move.
- G3. T1: no CI config anywhere in history; remote is
  https://github.com/memhtml/memhtml.git. `pnpm check` = `turbo run lint
  typecheck test test:integration test:eval` (root package.json:19; turbo wires
  build as a dependency). Credential-free by construction: eval `--mode` defaults
  to `fake` (commands.ts:648-654, packages/eval/src/run.ts:81), integration
  tests set MEMHTML_EMBED=off/MEMHTML_LLM=off themselves
  (tests-integration/tests/spawned.ts:44-45). Pins: pnpm@11.16.0
  (packageManager), node >=24 (engines).
- G4. embedMissing residual named by prior lesson (RESOLVED f95b018 note): the
  full `chunks LEFT JOIN embeddings` pending scan per batch, whose
  `e.model <> ?` disjunct defeats the embeddings_model index; measured linear
  11ms @ 1k → 60ms @ 10k chunks (probe-embed-cost.mjs, 2026-08-06). Fix shape
  per ROADMAP item 3: indexPaths/update already know the batch's chunk ids —
  scan those instead of the table.
- G5. T2 semantics DECIDED 2026-08-06 (recorded decision, captured in
  ROADMAP): bump on explicit open, not on hit; provenance-gated; type-scoped.
  Current code is backwards: searchMemories/recallMemories bump every hit
  (operations.ts:495,507), readMemory never bumps (operations.ts:469-475,
  recordLink only). Fix is a swap. Type scoping: exclude task and
  person/reference memory types from the salience arm's contribution (one
  memory-type list in retrieval-sql.ts), leaving FTS/vector/entity arms
  untouched.
- G6. Item 1 semantics fixed by ROADMAP: `supersede_on_conflict` assist on the
  batch door (and/or singular), propose-only — run the batch's claims through
  dedupe-style frame matching against ACTIVE memories on the write path; on a
  hit return the match as a per-op `conflict` field so the CALLER decides
  write-new / correct / skip. The store never auto-archives on a heuristic.
  BEAM is the cautionary evidence (its gold IS the contradiction; ~4% of BEAM
  chat lines collide on a frame key; the eval ran consolidation OFF).

## Grounding facts round 2 (explore fleet, 2026-08-07)

- G7. **Frame matching is NEW to memhtml.** The write-path structural dedupe is
  exact content-hash (`DedupeLookup` hook, store.ts:156-158; SQL
  `activePathForHash` traces-persist.ts:139-147; wired api-layer.ts:198).
  `frameKeyOf` lives only in the eval adapter (memhtml-evals
  consolidate.ts:47-57): lowercased claim text up to the LAST linking token
  (of|is|in|to|by|as), MIN_FRAME_TOKENS=3, MAX_VALUE_TOKENS=6. The roadmap's
  "lookup already exists" refers to the hook PLUMBING shape, not the matching.
- G8. **"In-vocabulary" needs a new closed list.** memhtml's LANG_TOKEN
  (fences.ts:21) is a token grammar, not a name list; the closed vocabulary
  (12 canonical names + aliases) lives in the eval's vocab.ts and must be
  ported. Author-written info strings stay grammar-validated; the closed list
  gates DETECTOR output only.
- G9. **Person-reference has no memory_type.** Person files are
  memory_type=semantic routed to resources/people/ by placementFor
  (contracts/paths.ts:122-123). A memory-type list cannot express T2's
  person-reference exclusion; the path prefix `resources/people/` exactly
  matches the decided split (exclude reference records, keep memories ABOUT a
  person). Tasks are already excluded from unscoped retrieval by default
  (scope.ts:99) — the task exclusion matters only for opted-in
  memory_types:["task"] queries.
- G10. The read-path bump adds DatabaseService to memory_read's MCP dependency
  set (tools.ts:298) and makes the memhtml://file/{path} resource (resources.ts:44)
  a bumper — a resource fetch names a specific path, so it IS an explicit open.
  Arc expansion needs no second path: arc bodies reach agents only through
  memory_read (disclosure.ts:10-12).
- G11. embedMissing's callers already hold the batch's chunk ids and discard
  them (FileProjection.chunks, project.ts:16-21; dropped at indexer.ts:441,
  :559, :578). Chunk ids are content-derived (chunking.ts:27), so renames
  already carry their vectors. The `e.model <> ?` migration case keeps the
  full scan: model migration re-embeds via `memhtml index rebuild --embed`, the
  documented move.
- G12. highlight.js 11.11.1 = npm latest = the eval's measured pin (zero
  drift); not currently a dependency anywhere in the workspace.

## Design decisions (settled at spec time)

- D1. **Fence detection is write-time only and version-pinned.** `data-lang`
  proposals happen in the write path (both doors share the template), never at
  index time — `rm index.db && rebuild` must be deterministic across detector
  versions. Pin highlight.js exactly; record the pinned version + threshold in
  the code beside the detector.
- D2. **Detector threshold: deploy at 0.30** (roadmap's rounding of the measured
  0.2868 operating point — conservative direction: higher threshold ≥ measured
  precision). In-vocabulary names only; below threshold or out-of-vocabulary →
  omit the attribute entirely. The author's info string always wins; detection
  runs only on unlabeled fences.
- D3. **Conflict assist is propose-only and off by default.** A new optional
  flag on the batch op envelope; when on, frame-key matches against ACTIVE
  memories (and the batch's own folded state) surface as a per-op `conflict`
  field carrying the matched path + claim. No write behavior changes; no
  auto-archive. Wire shape additive — no break for existing consumers.
- D4. **T2 is a swap plus a list.** Move bumpAccess from search/recall hit loops
  to readMemory beside recordLink; add a salience-exempt memory-type list to
  the salience arm only. Three guard tests, each proven to fire by reversing
  the rule (guards-must-fire).
- D5. **T3 derives, not edits.** Suggestion strings become references into
  COMMANDS (validated at test time against the live table) so a renamed command
  fails the suite; MEMHTML_MCP_BIN joins CONFIG_VARS so manifest + AGENTS.md
  disclose it. AGENTS.md regenerates from the built CLI.
- D6. **CI is one job.** node:24-slim class image, corepack-activated
  pnpm@11.16.0, pnpm store cache keyed on pnpm-lock.yaml, single `pnpm check`.
  No credentials, no live mode.
- D7. **Conflict assist lives in the operations layer, not the store.**
  Propose-only means no write behavior changes, so the store package stays
  conflict-agnostic. `batchWrite` (operations.ts), when the flag is on,
  derives each op's claim, computes its frame key, consults (a) a new
  IndexRecorder lookup over ACTIVE memories and (b) the batch's own folded
  frame map, and merges a `conflict` field into the per-op reports after the
  store returns. Frame keys are queryable via a new derived `frame_key` column
  on `files`, computed at projection time from the gist by a pure function
  (rebuild-deterministic), backed by a partial index (archived = 0). O(1)
  lookups, not an O(n) gist sweep — the write-cost lesson forbids per-op
  store-scaled scans.
- D8. **Param name: `detect_conflicts`, not `supersede_on_conflict`.** The
  roadmap's candidate name says "supersede" but its decided behavior is
  propose-only reporting; a flag named supersede that never supersedes is a
  wire-contract lie. Roadmap marked the shape "candidate"; the behavior is
  unchanged. Batch door + CLI `memhtml apply --detect-conflicts` in v1; the
  singular door is deferred until pulled (the bulk/agent path is where the H4
  finding lives). Frame-key port: same tokens and guards as the eval's
  consolidate.ts (linking tokens of|is|in|to|by|as, MIN_FRAME_TOKENS=3,
  MAX_VALUE_TOKENS=6) so eval and system agree about what a conflict is.
- D9. **T2 discriminators.** Task exclusion by memory_type = 'task';
  person-reference exclusion by path prefix `resources/people/` (G9 — no
  memory_type exists, and the path split exactly matches the decided rule:
  reference records are excluded, memories ABOUT a person keep salience).
  The `memhtml://file/{path}` MCP resource read counts as an explicit open (the
  caller named a specific path — that is precisely "someone CHOSE a memory").
- D10. **embedMissing gains an optional candidate-id list.** update()
  collects the batch's projection chunk ids and passes them; the full-table
  scan remains for rebuild and for the `e.model <> ?` migration case (model
  changes re-embed via `memhtml index rebuild --embed`, the documented move).

## Acceptance criteria

EARS-style; each maps to one task. [P] = parallel-safe.

- **AC-1-1** (Ubiquitous): THE projection SHALL derive a `frame_key` column on
  `files` from the gist via a pure ported frame-key function (same tokens and
  guards as the eval's consolidate.ts), with a partial index over ACTIVE
  non-task rows; rebuild SHALL reproduce identical frame keys.
- **AC-1-2** (Event-driven): WHEN `memory_write_batch` (or `memhtml apply
  --detect-conflicts`) carries `detect_conflicts: true` and an op's claim
  frame-matches an ACTIVE memory or an earlier op in the same batch, THE
  per-op result SHALL carry a `conflict` field (NullOr wire discipline) naming
  the matched path and its claim, and the write SHALL proceed unchanged.
  WHEN the flag is absent or false, behavior and wire results SHALL be
  unchanged from today.
- **AC-2-1** (Event-driven) [P]: WHEN a memory containing an unlabeled fence is
  written through either door, THE write path SHALL run highlight.js 11.11.1
  highlightAuto with the eval's confidence formula (canonical-aware runner-up);
  IF confidence ≥ 0.30 AND the normalized language lands in the ported
  canonical vocabulary, THE fence SHALL be stamped `data-lang`; otherwise the
  attribute SHALL be omitted. Author info strings always win; index rebuild
  SHALL never run detection.
- **AC-3-1** (Ubiquitous) [P]: THE embedMissing pending scan SHALL accept an
  optional candidate chunk-id list; update() SHALL pass the batch's projection
  chunk ids; rebuild and model-migration paths keep the full scan. Probe
  (probe-embed-cost.mjs) SHALL show the per-batch pending term flat in store
  size.
- **AC-T1** (Ubiquitous) [P]: THE repo SHALL carry a .github/workflows/check.yml running
  `pnpm check` credential-free on merge requests and main, honoring the
  packageManager pin.
- **AC-T2** (Event-driven): WHEN memory_read opens a specific path (including
  the memhtml://file resource), salience SHALL bump; WHEN search/recall merely
  return a path, salience SHALL NOT bump; task-typed rows and
  resources/people/ reference records SHALL be salience-invariant in ranked
  fusion (other arms untouched). Each guard test proven to fire under rule
  reversal (guards-must-fire).
- **AC-T3** (Ubiquitous) [P]: Error suggestions SHALL be validated against (or
  derived from) COMMANDS so a stale command form fails the suite; CONFIG_VARS
  SHALL include MEMHTML_MCP_BIN (RUNBOOK prose flipped, manifest tests updated);
  the stale `memhtml eval discriminate --json` suggestion SHALL be gone; AGENTS.md
  regenerated from the built CLI.

## Task graph

Wave 1 (parallel, independent files):
- T-AC-T1-1: .github/workflows/check.yml (orchestrator-direct, small)
- T-AC-T3-1: suggestions derivation + MEMHTML_MCP_BIN (apps/cli only)
- T-AC-3-1: embedMissing candidate list (packages/index only)
- T-AC-2-1: fence detector port + write-path stamping (packages/html + template seam)
- T-AC-T2-1: salience swap + type scoping (operations.ts + retrieval-sql.ts + docs)

Wave 2 (after T-AC-T2-1 and T-AC-3-1 land, since it touches operations.ts and
projection):
- T-AC-1-1: frame_key projection column + migration + rebuild determinism
- T-AC-1-2: detect_conflicts assist on batch door + CLI flag (blockedBy T-AC-1-1)

Rationale: item 1 is the largest and touches projection (migration), the ops
layer, both doors' wire schemas, and AGENTS.md — serialize it behind the two
tasks that share files with it. T-AC-2-1 and T-AC-T3-1 both regenerate
AGENTS.md; they run in parallel but the SECOND to merge regenerates once more
(byte-lock keeps them honest).

## Gate 1 critique deltas (inline critique, 2026-08-07 — subagent launches declined, run by orchestrator)

- C1 (REVISE, folded): D7's migration is ADDITIVE — 0008's recreate-and-copy
  was forced by CHECK-constraint edits; frame_key is a plain nullable TEXT
  column + partial index, so migration 0009 is `ALTER TABLE files ADD COLUMN`
  + `CREATE INDEX`. Rebuild self-heals existing stores (index.db is
  disposable; the column recomputes from the tree).
- C2 (REVISE, folded): AGENTS.md regeneration confined to T-AC-T3-1 in Wave 1
  (fence detection adds no commands/config vars); T-AC-1-2 regenerates again
  in Wave 2. The byte-lock test keeps both honest.
- C3 (REVISE, folded): apps/cli/tests/e2e.test.ts:269-299 (comment + tolerance
  encoding the old bump-on-hit behavior) is explicitly in T-AC-T2-1 scope.
- C4 (verified safe): eval adapter decodes batch results via a loose local
  interface (memhtml.ts:116,353) — the added conflict field breaks no consumer.
  Wire discipline: field PRESENT and null when flag off, per BatchOpResult
  NullOr rule.
- C5 (NOTE): singular-door deferral is within the roadmap's "and/or" phrasing;
  threshold 0.30-vs-0.2868 handled conservatively (higher threshold ≥ measured
  precision). Both survive.
- C6 (REVISE, folded): salience-arm-local predicate deliberately breaks the
  one-filter-reaches-every-arm symmetry documented at scope.ts:8-12 — doc
  caveat added to T-AC-T2-1 scope.
- MEMHTML_EMBED default verified already "on" (api-layer.ts:239, config.ts:48-52)
  — no change; CI/integration tests opt out deliberately.

GATE 1: Approved 2026-08-07 ("Carry on!" following plan
summary + dedup steelman; embedding-proximity recorded as ROADMAP item 6b).
