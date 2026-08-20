# Spec 004 — batch apply on both doors, with agent-verbose discoverability

Requested 2026-08-03: "Build the batch mode … make sure these instructions are written down and returned via the mcp server information (description) and also a bare CLI call and CLI --help should be verbose about how this all works for future agents."

Borrowed judgment: symspec field-report lessons (batch `apply` was its #1 authoring lever; fold the SINGULAR op yourself for per-op results; atomic-by-default with one save; intra-batch refs resolve against the folded state).

## Grounding facts (verified in source 2026-08-03, this session)

- G1. `memhtml` with no args and `memhtml help` already emit the full `cli.manifest` envelope (`apps/cli/src/run.ts:722-724`); `--help` parses as a bare flag on the empty command and lands in the same arm. "Verbose for agents" therefore means enriching the MANIFEST payload, not adding a new code path.
- G2. effect 4.0.0-beta.102 NEVER emits the MCP `instructions` field: the initialize handler (`McpServer.ts:1497-1501`) returns `{capabilities, serverInfo, protocolVersion}` only, though `McpSchema.ts:701` declares `instructions` optional. Server-level guidance must therefore live in TOOL DESCRIPTIONS. Record this as a known upstream gap; do not patch the dependency.
- G3. Writes go one file per commit through `store.writeMemory` (`packages/store/src/store.ts:305`); the render gate (`renderChecked`) and dedup happen per write. There is no multi-file commit primitive in the store today.
- G4. The indexer reindexes per write via `indexer.update()` (`apps/cli/src/operations.ts:227`, `reindex`) — one `git diff` per commit. A batch that committed N times would reindex N times; a batch that commits ONCE reindexes once.
- G5. The MCP wire has no `memory_write_batch`; the eval harness (memhtml-evals adapter) pays one round-trip per `memory_write` when ingesting a LongMemEval session.
- G6. Manifest/AGENTS.md derive from the COMMANDS table (`apps/cli/src/commands.ts`); the drift gate is `apps/cli/tests/agents-doc.test.ts`. New commands and prose flow into every projection.

## Design decisions (settled at spec time)

- D1. **One batch primitive in the operations layer**, two doors over it — same shape as every other operation (the handlers' whole job stays "decode → call the shared use case → shape").
- D2. **The batch is one commit.** N files staged, one `git.commit`, one reindex. Atomic-by-default: any op failure before commit aborts the whole batch, nothing staged survives (`git` reset of staged paths or write-to-temp discipline — implementer reads the store's writeFileAt/stage flow and picks the mechanism; the observable contract is "failed batch leaves a byte-identical tree").
- D3. **`--continue-on-error` / `continue_on_error`** flips to best-effort: failed ops are reported per-op and skipped; surviving ops land in the single commit. Per-op results ALWAYS returned, in input order, `{index, ok, path?, deduped?, code?, error?}` — mirror the envelope's own code/error discipline.
- D4. **Op vocabulary v1 is writes only**: `{op: "write", …memory_write params…}` (both `body` prose XOR `article_html` markup per op, same rule as the singular). No correct/link/archive in v1 — those mutate existing state and have archival side effects that do not compose into one commit trivially; the op envelope carries `op` so v2 can add them without a wire break.
- D5. **Dedup inside a batch**: content-hash dedup applies per op against the store AND against earlier ops in the same batch (the folded state), reported as `ok: true, deduped: true` with the existing path — never an error.
- D6. **CLI door**: `memhtml apply` reading JSONL ops from `--file <path>` or stdin (`-`). Response type `batch.applied` (append-only addition), `{results: […], summary: {total, written, deduped,
  failed}, commit_sha}`.
- D7. **MCP door**: `memory_write_batch` taking `ops: Array<{title, memory_type, body?,
  article_html?, …}>` (same fields as memory_write minus `op` — the tool name IS the op), same per-op results shape, declared `failure: ToolFailure`.
- D8. **Discoverability, CLI**: the manifest gains a `guide` section — prose blocks an agent reads on the FIRST bare `memhtml` call: the three doors (CLI / MCP / direct file edit + the commit duty), when to batch (>3 writes → one `memhtml apply` beats N `memhtml write`), the JSONL op shape with one example line, atomicity semantics, and the body-XOR-article_html rule. Rendered into AGENTS.md by the same generator (G6) so the doc and the live answer cannot drift.
- D9. **Discoverability, MCP**: `memory_write_batch`'s description carries the batch workflow (when to batch, per-op results, atomic vs continue_on_error, dedup semantics); `memory_write`'s description gains one pointer sentence ("writing more than ~3 memories in a row? call memory_write_batch once instead"). Shared-constant discipline (ARTICLE_HTML_CONTRACT precedent) so write/batch prose cannot drift apart. G2 recorded in a comment where a maintainer would look for the instructions field.

## Requirements (EARS)

- AC-6-1 (Ubiquitous). The system SHALL provide a `batchWrite` operation in `apps/cli/src/operations.ts` that folds the singular write over an op list, resolves dedup against the folded state (D5), stages every surviving file, commits ONCE, and reindexes ONCE. [operations + store]
- AC-6-2 (Event-driven). WHEN any op fails in atomic mode (default), the operation SHALL abort before commit and leave the tree byte-identical, reporting every op's result (the failed op's error, subsequent ops as `skipped`). [Dependencies: AC-6-1]
- AC-6-3 (Event-driven). WHEN `continue_on_error` is set, failed ops SHALL be reported and skipped while surviving ops land in the one commit. [Dependencies: AC-6-1]
- AC-6-4 (Ubiquitous). `memhtml apply` SHALL read JSONL from `--file`/stdin, validate each line's shape before executing ANY op (a malformed line 7 is a usage error naming line 7, exit 2, nothing written), and emit `batch.applied`. [Dependencies: AC-6-1]
- AC-6-5 (Ubiquitous). `memory_write_batch` SHALL expose the same operation over MCP with per-op results and `failure: ToolFailure`. [Dependencies: AC-6-1]
- AC-6-6 (Ubiquitous). The manifest (bare `memhtml`, `memhtml help`, `memhtml --help`, `memhtml manifest`) SHALL carry the `guide` section (D8), and AGENTS.md SHALL render it via the existing generator; the drift test extends to the guide. [P — commands.ts/manifest only, no dependency on AC-6-1]
- AC-6-7 (Ubiquitous). Both write-tool descriptions SHALL carry the batch-vs-singular guidance via a shared constant (D9). [Dependencies: AC-6-5]
- AC-6-8 (Unwanted). WHEN a batch contains an op whose rendered file fails `checkMemory`, the render gate SHALL refuse that op with the violation list (per-op in continue mode, batch-fatal in atomic mode); the gate is NEVER bypassed by the batch path. [Dependencies: AC-6-1]

## Success metric

Ingesting the 20-write Alice fixture through one `memory_write_batch` call produces 1 commit, 1 reindex, 20 per-op results; the same ingest through `memhtml apply` from JSONL matches. Root `pnpm check` green including new integration tests; every new guard mutation-proven.
