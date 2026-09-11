---
title: Check the discrimination gate
description: Run the gate, read its report, and tell a skipped run from a passing one.
---

```bash
memhtml eval discriminate                       # fake mode: deterministic, no credentials
memhtml eval discriminate --mode live           # the same probes against Bedrock's vector space
memhtml eval discriminate --seed 20260802 --size 200 --probes 36 --mrr-floor 0.85
```

The gate builds a small corpus of facts, queries it with one probe per fact, and requires every probe to rank its own target above every wrong-fact twin of that target. Those twins are the controls, and they are derived mechanically from the target: a negation flip, a numeric flip, a qualifier flip. That construction makes them high-similarity adversaries by design rather than by luck. Embeddings are weakest on exactly the tokens that carry a fact's polarity, so "drain the VIP before reverting" and "do NOT drain the VIP before reverting" sit above 0.99 cosine similarity while asserting opposite things.

This command never touches your store. It builds its own fixture corpus in a temp directory with an in-memory database and never constructs the application layer (`apps/cli/src/run.ts:834`), so it is safe to run with a server up and with no credentials.

## Read the report

```bash
memhtml eval discriminate
```

```json
{
  "apiVersion": "1",
  "type": "eval.discrimination",
  "data": {
    "mode": "fake",
    "probes": 36,
    "discriminated": 36,
    "inversions": [],
    "mrr": 1,
    "corpusMrr": 1,
    "mrrFloor": 0.85,
    "passed": true,
    "degradedProbes": 0,
    "requested": "fake",
    "skipped": false,
    "seed": 20260802,
    "corpusSize": 304
  }
}
```

- `passed` is true only when the run has zero inversions and `mrr` sits at or above `mrrFloor`. One inversion fails the run whatever the MRR says.
- `inversions` is the array of probes where at least one control outranked the target. Look here first, because each entry names the query, the target path, and every control's rank.
- `mrr` and `corpusMrr` measure different things. MRR is mean reciprocal rank: for each probe, one divided by the rank the target came back at, averaged over the probes. `mrr` computes that within the set holding one target and its own controls, which is the space the gate is stated in, and `1.0` there means every target beat every impostor outright. `corpusMrr` computes the same measure over the whole hit list, and corpus size dominates it, so a bigger corpus pushes it down on its own. It is reported rather than gated: read it as a size signal and leave the verdict to `mrr`.
- `degradedProbes` counts probes ranked without the vector arm.
- `seed` makes a failing run reproducible. Re-run with `--seed <that number>` and you get the same corpus and the same probes.
- A failed gate exits 1 with `ERR_DISCRIMINATION_FAILED`. A gate that exited 0 and left its verdict in the payload is one every shell caller forgets to read.

`--mrr-floor` defaults to `0.85` (`packages/eval/src/discriminate.ts:103`). Lowering it is a deliberate and visible choice: a gate below that floor admits a target that loses to one of its own negation-flipped twins on one probe in seven.

## fake is the mode CI measures

`fake` uses a deterministic embedder and needs no credentials, so a pass there is the verdict this project ships on. It is also the mode `memhtml sleep merge` runs, which keeps an unattended merge from depending on a token being valid at 3am.

`live` runs the same probes against Bedrock's actual vector space. Treat it as an operator diagnostic rather than a CI gate.

## If you see `skipped: true`, nothing was measured

`--mode live` without `AWS_BEARER_TOKEN_BEDROCK` reports `mode: "live"`, `requested: "live"`, `skipped: true`, zero probes, `passed: false`, and a loud `logError` on stderr (`packages/eval/src/run.ts:85`).

The failure being guarded against is a green pipeline over a gate that never ran, and operators filter warnings out, which is why the line is an error rather than a warning. Reporting `passed: false` on a skip keeps a skipped quality gate looking like the failure it is.

Re-run with credentials, or run `--mode fake`.

```bash
memhtml eval discriminate --mode live 2>&1 >/dev/null | head -1   # the reason, on stderr
```

## Where the gate is enforced

Two places:

- `mise run check`, the tier CI runs, where a change that degrades retrieval fails the build instead of shipping.
- `memhtml sleep merge`, where a curation run that degrades retrieval cannot land. That refusal arrives as `refusal: "gate-failed"` on the merge report; see [run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/).

## When quality feels wrong but nothing errors

Run this command. It tells you whether the ranking stack is broken or this corpus never held the answer, and reading search output will not settle that.

A pass here alongside bad answers in practice points at the corpus or the index rather than the ranker. Go to [diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/).

## The write-path arm

The retrieval gate above asks whether the READ path ranks the right memory. The write-path arm asks whether the WRITE path admits the right candidate. It runs inside `mise run check` as part of `test:eval` and has no command of its own yet.

```bash
pnpm --filter @memhtml/eval test:eval      # both arms, credential-free
pnpm freeze:write-path                      # rewrite the frozen manifest after an intended change
```

It feeds 62 labeled candidate memories (31 the gate should write, 31 it should refuse) through the production gate, composed from the consolidator door's own decode, grounding and verbatim-quote checks and the sleep phase's per-candidate refusal. Refusal is the positive class: precision is the share of refusals that deserved it, recall the share of bad candidates that were caught. The floor is F1 0.88, the measured baseline (0.9333) minus five points, because the 2026-08-27 plan named no floor for this arm.

Every decision is frozen in `packages/eval/fixtures/write-path-discrimination.manifest.json` and replayed on each run. A drifted decision fails the tier naming the candidate id and where it now stops. If the change was intended, run `pnpm freeze:write-path` and review the manifest diff; the script refuses to freeze a report below the floor. The corpus also states the gate's known gaps (`KNOWN_GAP_CLASSES`): a duplicated evidence quote clears the two-quote bar, a claim that is a verbatim transcript span is written as prose, and a real quote from a session id padded with whitespace is refused at the door. The tier fails if that set moves in either direction, so closing a gap is a visible change rather than a silent one.

## The write-path acceptance arm

The discrimination arm scores refusal. A phase that refuses everything scores perfectly on it and stores nothing, which is what the scheduled `dedup-merge` did on 2026-09-10 and 2026-09-11: `candidates: 171, vetoed: 171, merged: 0` and `candidates: 178, vetoed: 178, merged: 0`, with the model grouping 52 and 59 groups. The acceptance arm scores the other direction: of the pairs the store SHOULD fold, how many does it fold? It runs inside the same `test:eval` tier.

It feeds 16 labeled groups (11 the phase should fold, 5 it must refuse) through the phase's own fold path once the model has answered: `dedupTextFor` (the `gist` + `body_text` join the veto reads), `groupPairsFor` (oldest member keeps, every other member drops), and `mergeCandidates` under `DEDUP_ADMIT_FLOOR`. The group stands in for the model's answer, the same substitution the discrimination arm makes. A fold is the positive class: `acceptance` is folds over the pairs labeled `merge`, `precision` is the share of folds that were labeled `merge`, and a fold of a `keep` pair fails the tier outright whatever the rate. Baseline measured 2026-09-11 at 0.14.0: acceptance 0.6667 (8 of 12), precision 1.0. The floor is the baseline minus five points, 0.61.

### Why two nights vetoed every candidate

The report's `vetoed` is `proposed.length - decisions.length` (`packages/sleep/src/phases/dedup-merge.ts`, the `commitMerges` call on the model arm), so it counts every pair the filter did not commit, whatever stopped it. Two things stop nearly all of them, and the arm reproduces both against the production code:

1. **`numericTokenDivergent` compares the numeric token SETS of the whole article text** (`packages/domain/src/merge.ts`, `numericTokenDivergent`: `!sameSet(numA, numB)`), over the string `dedupTextFor` builds from the gist AND the body. Two statements of one fact almost always differ in an incidental number somewhere in the body (a date inside `<time>`, a ticket or pull-request id, an exit code, a cosine), and one such token on one side is a veto. Every review task the two nights minted names this predicate: "the two carry different numbers", at cosines up to 1.000 on pairs such as `areas/inbox/verdict-suppressed-failure-45` and `-48`. Those particular pairs are templated verdict records on different objectives, so refusing them is right, but the reason is wrong: they should never have been proposed, and the same predicate refuses the genuine duplicates that carry an incidental number. The corpus states this as the `incidental-number` known gap (three pairs, all stopped at `veto:numeric`).

2. **A model group folds at most one member per night.** `groupPairsFor` names the same keeper in every pair of a group, and `mergeCandidates` claims BOTH roles of a committed pair, so after `(keeper, m2)` commits, `(keeper, m3)` is skipped because `claimed.has(pair.keepPath)` is true (`merge.ts`, the in-batch role guard). The skipped pair is counted under `vetoed` although no predicate fired. The corpus states this as the `group-fanout` known gap (a group of three: one fold, one role-guard skip).

The model judge is not the cause: `llmGroups` was 52 and 59 on the two nights, and `unresolved` and `skipped` were 0. Neither is the threshold: the model arm hands `mergeCandidates` a threshold of 0. The cap (100) was never reached because nothing committed.

The fixes are domain decisions and are not made here: narrowing the numeric predicate to the claim (the `gist`) or to numbers adjacent to shared vocabulary, and letting the role guard admit a repeated KEEPER while still refusing a repeated drop. Either change moves the acceptance number and the known-gap set, and the tier fails until both are re-stated, which is the point of stating them.
