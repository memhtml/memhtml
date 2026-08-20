# Instrument the real composition before trusting a suspect list — the dominant term was unlisted

**Tags**: profiling, performance, indexer, git-subprocess, effect, probe-first **Modules**: packages/index, packages/store, tests-integration

## What happened

Session-93362b's handoff named three suspects for the quadratic write cost (freePathFor disk probes, git staging walks, indexer diff). A probe that wrapped every GitShape/git-port/db method with timers on the REAL makeStore/makeIndexer composition showed the dominant term was a FOURTH thing: `projectFromTree` inside `update()`'s diffs loop — 2 subprocesses per changed file, each a full-tree walk (one `git ls-tree -r <ref> -- <one path>` costs the same as walking everything). freePathFor was 6% of the cost; git staging was noise.

## How to apply

- Wrap SERVICES, not call sites: `instrument(prefix, service)` over every function-valued property (Effect: wrap with `Effect.suspend` + `Effect.ensuring` around a hrtime pair) gives per-method calls×wall with zero production edits. See tests-integration/probe-write-cost.mjs.
- Seed big fixture stores CHEAPLY (direct file writes + one `git add -A` + one commit + one rebuild), or the probe itself pays the quadratic it measures.
- Vary batch size AND store size in one matrix — it separates per-op×n terms from per-batch×n terms in one table, which is exactly the distinction a fix design needs.
- A per-path plumbing call in a loop (`ls-tree <ref> -- <path>`, `cat-file` per blob) is a tree walk per iteration. Batch to ONE subprocess per batch: full `lsTreeR` into a path→sha map + one `catFileBatch` of the union.
- Run the acceptance probe with ALL lanes on (embeddings included) before declaring flat-in-n: the embeddings-off probe was flat while the live run still grew linearly (embedMissing's pending scan — a per-batch full-table JOIN).
