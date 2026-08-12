---
title: Check the discrimination gate
description: Run the one number that says whether retrieval works at all, read its report, and never mistake a skipped gate for a passing one.
---

```bash
memhtml eval discriminate                       # fake mode: deterministic, no credentials
memhtml eval discriminate --mode live           # the same probes against Bedrock's vector space
memhtml eval discriminate --seed 20260802 --size 200 --probes 36 --mrr-floor 0.85
```

The gate builds a small corpus of facts, queries it with one probe per fact, and requires every probe
to rank its own target above every wrong-fact twin of that target. Those twins are the controls, and
they are derived mechanically from the target: a negation flip, a numeric flip, a qualifier flip. That
construction makes them high-similarity adversaries by design rather than by luck. Embeddings are
weakest on exactly the tokens that carry a fact's polarity, so "drain the VIP before reverting" and
"do NOT drain the VIP before reverting" sit above 0.99 cosine similarity while asserting opposite
things.

This command never touches your store. It builds its own fixture corpus in a temp directory with an
in-memory database and never constructs the application layer (`apps/cli/src/run.ts:834`), so it is
safe to run with a server up and with no credentials.

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

- `passed` is true only when the run has zero inversions and `mrr` sits at or above `mrrFloor`. One
  inversion fails the run whatever the MRR says.
- `inversions` is the array of probes where at least one control outranked the target. Look here
  first, because each entry names the query, the target path, and every control's rank.
- `mrr` and `corpusMrr` measure different things. MRR is mean reciprocal rank: for each probe, one
  divided by the rank the target came back at, averaged over the probes. `mrr` computes that within
  the set holding one target and its own controls, which is the space the gate is stated in, and
  `1.0` there means every target beat every impostor outright. `corpusMrr` computes the same measure
  over the whole hit list, and corpus size dominates it, so a bigger corpus pushes it down on its own.
  It is reported rather than gated: read it as a size signal and leave the verdict to `mrr`.
- `degradedProbes` counts probes ranked without the vector arm.
- `seed` makes a failing run reproducible. Re-run with `--seed <that number>` and you get the same
  corpus and the same probes.
- A failed gate exits 1 with `ERR_DISCRIMINATION_FAILED`. A gate that exited 0 and left its verdict in
  the payload is one every shell caller forgets to read.

`--mrr-floor` defaults to `0.85` (`packages/eval/src/discriminate.ts:103`). Lowering it is a deliberate
and visible choice: a gate below that floor admits a target that loses to one of its own
negation-flipped twins on one probe in seven.

## fake is the mode that counts

`fake` uses a deterministic embedder, needs no credentials, and is the mode CI measures, so a pass
there is the verdict this project ships on. It is also the mode `memhtml sleep merge` runs, which keeps
a nightly merge from depending on a token being valid at 3am.

`live` runs the same probes against Bedrock's actual vector space. Treat it as an operator diagnostic
rather than a CI gate.

## If you see `skipped: true`, nothing was measured

`--mode live` without `AWS_BEARER_TOKEN_BEDROCK` reports `mode: "live"`, `requested: "live"`,
`skipped: true`, zero probes, `passed: false`, and a loud `logError` on stderr
(`packages/eval/src/run.ts:85`).

That combination is deliberate down to the log level. The failure being guarded against is a green
pipeline over a gate that never ran, and operators filter warnings out. Reporting `passed: false` on a
skip keeps a skipped quality gate looking like the failure it is.

Re-run with credentials, or run `--mode fake`.

```bash
memhtml eval discriminate --mode live 2>&1 >/dev/null | head -1   # the reason, on stderr
```

## Where the gate is enforced

Two places:

- `mise run check`, the tier CI runs, where a change that degrades retrieval fails the build instead
  of shipping.
- `memhtml sleep merge`, where a curation run that degrades retrieval cannot land. That refusal
  arrives as `refusal: "gate-failed"` on the merge report; see
  [run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/).

## When quality feels wrong but nothing errors

Run this command. It tells you whether the ranking stack is broken or this corpus never held the
answer, and reading search output will not settle that.

A pass here alongside bad answers in practice points at the corpus or the index rather than the ranker.
Go to [diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/).
