# Ingestion granularity dominates retrieval quality (H1: 9→96/100)

**Category**: eval-harness | **Session**: session-93362b (2026-08-05)

## Finding

MAB FactConsolidation single-hop collapsed with store size (61→17→9→5 /100) under blob-per-chunk ingestion. Splitting to one memory per fact line (evals adapter bf419f7, factUnitsOf) took cr-06 from 9→96 and cr-05 from 17→92 with ZERO retrieval-stack changes. Abstentions 84→0.

## Why

Search ranks FILES by title/gist. A 16KB blob's gist describes only its first sentence; a fact-grained file's gist IS the fact. Sharpening the write side made every arm (fts, vector, recency) work with aligned targets.

## How to apply

- Before touching ranking (BM25, weights, MMR), check what the WRITE side hands the index: gist/title alignment with query granularity is the first lever.
- H3 (snippet on hits) was accuracy-neutral while the reader prompt mandates full reads — reader protocol and search surface must be tuned together.
- Multi-hop conflict chains did NOT yield to granularity (10→22, floor-adjacent): they need write-time consolidation (supersede/correct), a different mechanism.
