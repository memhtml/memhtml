# A synchronous library on an untrusted write path needs a size ceiling and a lazy load

**Tags**: highlight-js, dos, input-cap, lazy-import, barrel-exports, single-threaded, mcp
**Modules**: packages/html, apps/mcp

From shipping fence auto-detect (session-729e89): highlight.js `highlightAuto` was
correct, measured, and still carried two costs no functional test surfaces.

## The rules

1. **Cost curves are input properties: measure at adversarial sizes, not corpus
   sizes.** The eval corpus topped out near 1KB and the detector looked instant.
   Measured on the pinned build: 5KB ≈ 450ms, 40KB ≈ 20s, 100KB ≈ 122s of blocking
   synchronous CPU — super-linear, dominated by the C-family grammars. The MCP server
   is ONE single-threaded process and `body` is unbounded on the wire, so one large
   unlabeled fence wedges every other request. Fix shape: an ABSTENTION ceiling
   (`DETECT_MAX_CHARS = 4096`, fail-closed, same value as out-of-vocabulary), not a
   prefix slice — truncation changes the per-line normalization the threshold was
   measured against and would force an eval re-run.
2. **A barrel re-export makes every consumer pay the heaviest module's load cost.**
   Re-exporting `detect.ts` from `@memhtml/html`'s index made the READ path (indexer,
   retrieval, operations) eagerly load 192 grammars: ~100ms and ~30MB heap in
   processes that never detect. Verified by resolve hook, fixed with a lazy
   synchronous `createRequire` load on first detection (dynamic `import()` would have
   forced async through the render pipeline). Measured after: barrel import 20MB;
   +31MB only when a detection actually fires.
3. **Grep locks over imports don't catch load cost.** The layering test proved the
   indexer never CALLS the detector; nothing proved it never LOADS it. If the
   property is "this module is not paid for here", the probe is a resolve hook or
   heap measurement, not a grep.

## How to apply

- New dependency on a write path that accepts caller bytes: before merging, time it
  at 5/40/100KB and check who transitively loads it.
- Prefer abstain-above-ceiling over truncate-and-run whenever the operating point
  was measured on untruncated input.
