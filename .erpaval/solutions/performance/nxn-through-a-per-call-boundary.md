# A per-call boundary cost measured at 1×n does not transfer to n×n — decode once, compute in-process

**Category**: performance | **Session**: session-2026-08-19 (issue #40, PR fix/sleep-pairwise-kernel) | **Status**: RESOLVED

## Symptom

`memhtml sleep run --dry-run` on a 2,907-memory corpus (4,219 chunks, all embedded) recorded zero phases: FATAL `Ineffective mark-compacts near heap limit` at ~3.3 GB after ~23 minutes on the default heap; RSS past 70 GB at 27 minutes under `--max-old-space-size=32768`.

## Mechanism

`neighborPairs` / `conflictCandidates` built the candidate set as a SQL self-join whose every pair row crossed into the JS UDF `vector_distance_cos`. node:sqlite materializes a fresh `Uint8Array` per BLOB argument per invocation, so n×n through the UDF is 2·n(n−1) four-KB allocations — at n = 2,907 that is 8.45M calls and ~67 GB of churn for a corpus that decodes ONCE into 12 MB. The comment beside the UDF says 79 ms for 10k rows, and it is right: that measurement is the 1×n retrieval shape (n calls, n copies per query). The boundary's per-call price is invisible at 1×n and is the whole cost at n×n. The `LIMIT`/`ROW_NUMBER` caps guard output rows, not compute — the window function ranks after the full pair space is evaluated.

Fix shape (packages/domain/src/neighbors.ts): fetch `path, vec` once, decode once, brute-force pairwise dot products with hoisted per-vector norms and per-source bounded top-k (O(n·k) memory). Same machine, same scale: ~3.8 s and 80 MB RSS. `conflictCandidates`' predicates stay in SQL but ENUMERATE pairs from the shared-entity join (output-sensitive) instead of filtering the n² scan.

## How to apply

- **Ask what a hot function's cost is per CALL at the boundary, not per flop.** A UDF, FFI hop, or IPC edge that allocates per invocation makes call COUNT the resource. A comment's measured number carries its shape (1×n vs n×n); re-derive before reusing it in a new consumer.
- **A row cap under a window function bounds output, never work.** If a guard exists to bound compute, it must sit before the pair space is enumerated.
- **Keep replacement arithmetic bit-identical to the shared scalar** (hoist the sqrt, keep the accumulation order) so the regression lock is exact `toEqual` against an independent oracle, not epsilon — and keep the displaced formulation alive INSIDE the test as that oracle.
- **A similarity floor cannot prune the dot product** (normalized bound is 1); floors only bound the accumulator. Don't expect a high floor to save an n×n scan.
- Mutation-verify the locks: tie-break flip, `>=`→`>` at the floor (needs a deterministic exactly-at-floor case — random floors never collide with a computed sim), and the `derived = 0` anti-join predicate.
