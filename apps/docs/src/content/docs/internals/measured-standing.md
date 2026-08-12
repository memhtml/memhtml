---
title: Measured standing
description: The benchmark numbers this system has actually measured, with the judge caveat that governs how they may be read.
---

## 1. Where the system stands

Measured 2026-08-06; the LongMemEval-S row judged 2026-08-07. These are self-run numbers, not published
results, and the right-hand column is a reference point rather than a leaderboard position — read section
2 before reading the table as a comparison.

| benchmark | memhtml | published reference |
|---|---|---|
| MAB FactConsolidation single-hop (26KB–1.1MB stores) | 92–97% | ~60% at 26KB only |
| MAB FactConsolidation multi-hop | 37–49% | ≤7% all methods |
| BEAM Contradiction Resolution (100K split, 40 probes) | 43.8% mean | 0–5% all systems |
| LongMemEval-S (full 500, judged 2026-08-07) | 67.0% | mid-50s–low-60s memory-system baselines |

## 2. The judge caveat

**Cross-judge numbers are reference points, not rankings.** The judges behind the left-hand column are
verbatim prompt ports running haiku-4.5, where the papers behind the right-hand column used gpt-4o and
gpt-4.1-mini. The numbers are self-run and unpublished.

A bare comparison table would misrepresent them, so the caveat travels with the table wherever the table
goes, and it is stated in every result header. Two systems scored by different judges are not on one scale:
a difference of a few points across the columns says as much about the grader as about the system.

What the columns *can* support is a claim about order of magnitude within a row where the gap is large — a
multi-hop consolidation rate of 37–49% against a published ceiling of 7%, or a contradiction-resolution
mean of 43.8% against 0–5%, is a difference no plausible judge disagreement closes.

## 3. What the campaign established about the architecture

As distinct from any one fix:

- **The git-tree-as-system-of-record plus a rebuildable index survives adversarial-scale ingest.** 18k
  memories land in minutes.
- **The retrieval stack finds one-fact memories reliably at every store size tested**, from 26KB to
  1.1MB.

Both are properties of the shape described in [Packages and dependency
direction](/internals/packages-and-dependency-direction/) and [The index](/internals/the-index/) rather
than of a tuning pass, which is why they are recorded here instead of in a changelog.

## 4. What these numbers are not

They are not the gate. The number that decides whether a change ships is the discrimination gate
(`packages/eval/src/discriminate.ts:224`), which runs on every check and inside `memhtml sleep merge`, and
which refuses on a single inversion regardless of any aggregate — see [Testing
posture](/internals/testing-posture/).

A benchmark score measures a configuration against a corpus someone else designed. The gate measures
whether this retrieval stack can still tell a fact from its own negation. Only the second one can fail a
build.
