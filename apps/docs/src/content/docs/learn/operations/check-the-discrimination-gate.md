---
title: Check the discrimination gate
description: Run the one number that says whether retrieval works at all, read its report, and never mistake a skipped gate for a passing one.
---

```bash
memhtml eval discriminate                       # fake mode: deterministic, no credentials
memhtml eval discriminate --mode live           # the same probes against Bedrock's vector space
memhtml eval discriminate --seed 20260802 --size 200 --probes 36 --mrr-floor 0.85
```

Every probe must outrank **its own wrong-fact twins**. Controls are derived mechanically from each
probe's target — a negation flip, a numeric flip, a qualifier flip — which makes them high-cosine
adversaries by construction rather than by luck. Embeddings are weakest on exactly the tokens carrying a
fact's polarity: "drain the VIP before reverting" and "do NOT drain the VIP before reverting" sit above
0.99 cosine while asserting opposite things.

This command never touches your store. It builds its own fixture corpus in a temp directory with an
in-memory database and never constructs the application layer (`apps/cli/src/run.ts:834`), so it is safe
to run with a server up and with no credentials.

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

- **`passed`** is true only when there are **zero inversions and `mrr >= mrrFloor`**. One inversion fails
  the run regardless of the MRR.
- **`inversions`** is the array of probes where at least one control outranked the target. This is where
  you look first, because each entry names the query, the target path, and every control's rank.
- **`mrr` and `corpusMrr` are different coordinate spaces.** `mrr` is the mean reciprocal rank of the
  target within `{target} ∪ its own controls` — the space the gate is stated in, where `1.0` means every
  target beat every impostor outright. `corpusMrr` is the same measure over the whole hit list, and it is
  **reported and not gated**, because it is dominated by corpus size rather than by ranking quality. Do
  not read a low `corpusMrr` as a retrieval defect.
- **`degradedProbes`** counts probes ranked without the vector arm.
- **`seed`** makes a failing run reproducible: re-run with `--seed <that number>` and you get the same
  corpus and the same probes.
- **Exit 1 with `ERR_DISCRIMINATION_FAILED` on a failed gate.** A refusable gate that exited 0 and left
  the verdict in the payload is one every shell caller forgets to read.

`--mrr-floor` defaults to `0.85` (`packages/eval/src/discriminate.ts:103`). Lowering it is a deliberate,
visible choice: a gate below that floor admits a target that loses to one of its own negation-flipped
twins on one probe in seven.

## fake is the mode that counts

`fake` uses a deterministic embedder, needs no credentials, and is what CI measures. **A pass there is a
real pass.** It is also the mode `memhtml sleep merge` runs, so a nightly merge is never conditional on a
token being valid at 3am.

`live` runs the same probes against Bedrock's actual vector space. It is an operator diagnostic, not a
CI gate.

## If you see `skipped: true`, nothing was measured

`--mode live` without `AWS_BEARER_TOKEN_BEDROCK` reports `mode: "live"`, `requested: "live"`,
`skipped: true`, zero probes, `passed: false`, and a loud `logError` on stderr
(`packages/eval/src/run.ts:85`).

That combination is deliberate down to the log level: the failure mode being guarded against is a green
pipeline over an unmeasured gate, and a warning is the level operators filter out. `passed: false` on a
skip means a skipped quality gate can never look like a passing one.

Re-run with credentials, or run `--mode fake`.

```bash
memhtml eval discriminate --mode live 2>&1 >/dev/null | head -1   # the reason, on stderr
```

## Where the gate is enforced

Two places:

- **`mise run check`** — the tier CI runs. A change that degrades retrieval fails the build rather than
  shipping.
- **`memhtml sleep merge`** — a curation run that degrades retrieval cannot land. That refusal arrives as
  `refusal: "gate-failed"` on the merge report; see [run and review a sleep
  cycle](/learn/operations/run-and-review-a-sleep-cycle/).

## When quality feels wrong but nothing errors

This command is the answer. It separates "the ranking stack is broken" from "this corpus does not contain
the answer", which no amount of reading search output will do.

A pass here plus bad answers in practice points at the corpus or the index rather than the ranker — go to
[diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/).
