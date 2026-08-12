---
title: Measured standing
description: The benchmark numbers this system has measured, with the caveat about judges that governs how to read them.
---

## 1. Where the system stands

The runs below were measured 2026-08-06, and the LongMemEval-S row was judged 2026-08-07. Every number in
the middle column is self-run and unpublished, and the right-hand column is a reference point rather than
a leaderboard position. Read section 2 before reading the table as a comparison.

| benchmark | memhtml | published reference |
|---|---|---|
| MAB FactConsolidation single-hop (26KB–1.1MB stores) | 92–97% | ~60% at 26KB only |
| MAB FactConsolidation multi-hop | 37–49% | ≤7% all methods |
| BEAM Contradiction Resolution (100K split, 40 probes) | 43.8% mean | 0–5% all systems |
| LongMemEval-S (full 500, judged 2026-08-07) | 67.0% | mid-50s–low-60s memory-system baselines |

## 2. The judge caveat

The two score columns were graded by different models, so they sit on different scales. The `memhtml`
column comes from verbatim ports of each paper's own judging prompt running on haiku-4.5, and the papers
behind the reference column ran those prompts on gpt-4o and gpt-4.1-mini. Every `memhtml` number is
self-run and unpublished. So read each row as two reference points and not as a ranking, and read a gap of
a few points across the columns as telling you about the graders.

The caveat travels with the table wherever the table goes, and it appears in every result header, because a
bare comparison table would misrepresent what was measured.

Where a gap within one row is large, the columns do support a claim about order of magnitude. A multi-hop
consolidation rate of 37–49% against a published ceiling of 7%, or a contradiction-resolution mean of 43.8%
against 0–5%, is a difference no plausible disagreement between graders closes.

## 3. What the campaign established about the architecture

Two findings hold at the level of the design rather than of any one fix.

The git tree as the record of facts, plus a rebuildable index, survives ingest at adversarial scale: 18k
memories land in minutes. And the retrieval stack finds one-fact memories reliably at every store size
tested, from 26KB to 1.1MB.

Both are properties of the shape described in
[Packages and dependency direction](/internals/packages-and-dependency-direction/) and
[The index](/internals/the-index/) rather than of a tuning pass, which is why they are recorded here rather
than in a changelog.

## 4. What these numbers are not

They do not gate anything. The number that decides whether a change ships is the discrimination gate
(`packages/eval/src/discriminate.ts:224`), which runs on every check and inside `memhtml sleep merge`, and
which refuses on a single inversion regardless of any aggregate. See
[Testing posture](/internals/testing-posture/).

A benchmark score measures one configuration against a corpus someone else designed. The gate measures
whether this retrieval stack can still tell a fact from its own negation, and only the gate can fail a
build.
