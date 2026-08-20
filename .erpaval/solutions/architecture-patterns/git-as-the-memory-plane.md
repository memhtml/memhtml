# Git as the memory plane — the invariants that survived contact

**Tags**: git, memory, architecture, para, sqlite, index **Modules**: packages/store, packages/index, packages/sleep

## What held

- **Files are truth, SQLite is a rebuildable index**: the disposability test ("must it survive `rm index.db`?") cleanly decided every placement question — authored edges in HTML `<link>`, derived edges DB-only, corroborated promotions written back to files.
- **Phase-per-commit sleep** with trailer-based resume replaced the predecessor memory system's 13-phase single-transaction abort hazard exactly as designed; `git branch -D` is the abort.
- **Content-hash dedup keyed on canonical `<article>` text, meta-invariant** — the property that makes decay/bookkeeping churn invisible to identity. Everything (chunks, embeddings) keys on the content hash so a `git mv` costs zero re-embedding.

## What the design got wrong (probed, corrected in docs/design.md)

- **"Evictions show as R100" is arithmetically impossible** when the same commit stamps archive metas — similarity is tree-to-tree; measured R059–R087. Assert rename+`--follow`, never a score.
- **`.gitattributes merge=ours` is inert** without `git config merge.ours.driver true` (per-clone; re-run init after cloning).
- **`Stats.mtimeMs` is a float**; storing it at ms-text resolution silently defeats every watermark equality check — the incremental design re-read 3.67 GB per run until fixed at the producer. Semantic-contracts failure: agreed on `mtimeMs: number`, disagreed on resolution.
- A parent process must not build the DB layer before spawning a child that opens the same embedded database: the parent then holds a writer handle, on a store it never queries, for as long as the child lives. Under WAL that costs a redundant handle; under a driver whose lock excludes a second **writable** opener it deadlocks the child outright (`memhtml serve mcp` did exactly that to its own child). What a second process can do to a live store is measured, never remembered: `scripts/probe-sqlite-concurrency.mjs`.
- Closing a git child's stdin when the command reads none raises an **uncatchable async EPIPE** — handle at the spawn wrapper (`packages/store/src/git.ts`).

## Upstream debts found by porting

- The predecessor's `domain/curation.py:288`: in-batch merge guard records only the drop side — a keeper can be archived by a later pair in the same batch (data loss). Fixed in @memhtml/domain; report upstream.
- In both the predecessor and `@memhtml/domain`, `negationDivergent` is marker-presence over whole text — a body already containing "not" masks a claim-level flip (weakens both the merge veto and negation-family eval controls).
- parse5's serializer drops one `<pre>` newline per round-trip — hash drift on no-op writes; @memhtml/html ships its own writer.
