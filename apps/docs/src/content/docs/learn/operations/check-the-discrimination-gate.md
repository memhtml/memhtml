---
title: Check the discrimination gate
description: Run the gate, read its report or its failure message, and see why a skipped live run fails.
---

```bash
memhtml eval discriminate                       # fake mode: deterministic, no credentials
memhtml eval discriminate --mode live           # the same probes against Bedrock's vector space
memhtml eval discriminate --seed 20260802 --size 200 --probes 36 --mrr-floor 0.85   # the defaults, written out
```

The gate generates its own corpus, 200 base memories by default (`--size`), takes up to 36 of them as probe targets (`--probes`), and requires every probe to rank its own target above every wrong-fact twin of that target. Those twins are the controls, and they are derived mechanically from the target by three flips: a negation flip, a numeric flip, a qualifier flip. A flip that does not apply or does not change the fact is dropped, so a claim with no number gets no numeric control (`packages/eval/src/controls.ts::deriveControl`), and on the default corpus half the probes carry two controls rather than three. That construction makes them high-similarity adversaries by design rather than by luck. Embeddings are weakest on exactly the tokens that carry a fact's polarity, so "drain the VIP before reverting" and "do NOT drain the VIP before reverting" differ only by "do NOT" while asserting opposite things. `corpusSize` (304 in the sample below) counts every indexed file: the 200, their 90 controls, 4 person records, and 10 archived ones.

This command never opens your store. It ignores `--repo` and `MEMHTML_ROOT`, builds its own fixture corpus in a fresh directory under the system temp directory (`TMPDIR`) with an in-memory database (`packages/eval/src/harness.ts::buildStack`), removes that directory when the run finishes, pass or fail (`packages/eval/src/harness.ts::withStack`), and never builds the application layer (`apps/cli/src/api-layer.ts::layerApp`), because `apps/cli/src/run.ts::run` answers it first. So it is safe to run with a server up, and in `fake` mode with no credentials.

## Read the report

```bash
memhtml eval discriminate | jq 'del(.data.results, .data.now)'   # needs jq; drops the per-probe results and the day-stamped now
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

- `passed` is true only when the run has at least one probe, zero inversions, and `mrr` at or above `mrrFloor` (`packages/eval/src/discriminate.ts::summarize`). One inversion fails the run whatever the MRR says.
- `inversions` lists the probes whose target did not strictly outrank every one of its controls, a target missing from the hit list included. A passing run prints it empty and a failing run prints no report, so on a failure read the `error` message instead: it names the first inversion's query, the target's rank in the whole hit list, and a control at or above it.
- `mrr` and `corpusMrr` measure different things. MRR is mean reciprocal rank: for each probe, one divided by the target's rank, averaged over the probes. `mrr` ranks the target within the set holding it and its own controls, one plus the number of controls it failed to strictly outrank, which is the space the gate is stated in, and `1` there means every target beat every control outright. `corpusMrr` uses the target's rank in the whole hit list of up to 40 (`packages/eval/src/discriminate.ts::PROBE_LIMIT`) and counts a target missing from it as `0`. It is reported rather than gated: read it as context and leave the verdict to `mrr`.
- `degradedProbes` counts probes ranked without the vector arm, because the query embed failed or too few chunks carry vectors. It stays `0` in `fake` mode and does not change `passed` by itself.
- `seed` and `now` pin the corpus together, because it is a function of both and `now` is the run instant rounded down to its UTC day (`packages/eval/src/corpus.ts::quantizeNow`). Re-run with `--seed <seed> --now <now>`, where `--now` takes UTC milliseconds, and you get the same corpus and the same probes. A failing run prints neither, so note the `--seed` you passed (default `20260802`) and the UTC day of the run.
- A failed gate exits 1 with `ERR_DISCRIMINATION_FAILED`, and stdout then holds only the failure envelope, `apiVersion`, `error`, `code`, and `suggestions`, with no report. A gate that exited 0 and left its verdict in the payload is one every shell caller forgets to read.

`--mrr-floor` defaults to `0.85` (`packages/eval/src/discriminate.ts::MRR_FLOOR`). Lowering it is a deliberate and visible choice, but today it changes no verdict: a target that loses to any of its own controls is an inversion, so a run with probes and no inversions has an `mrr` of exactly `1`, and the floor decides the verdict only when it is set above `1`.

## fake is the mode CI measures

`fake` embeds with a hashed bag of words (`packages/eval/src/harness.ts::fakeVector`), so it is deterministic and needs no credentials, and a pass at the default seed is the verdict this project ships on. A pass at another seed is not promised, and some seeds report an inversion.

`live` runs the same probes with Cohere Embed v4 vectors (`packages/llm/src/constants.ts::EMBED_MODEL_ID`), from Bedrock in `MEMHTML_AWS_REGION` (default `us-east-1`) or through the proxy `MEMHTML_LLM_BASE_URL` names. Treat it as an operator diagnostic rather than a CI gate.

## A skipped live run fails, and nothing was measured

`--mode live` without `AWS_BEARER_TOKEN_BEDROCK`, or with it blank, skips the run (`packages/eval/src/run.ts::runDiscrimination`): it exits 1 with `ERR_DISCRIMINATION_FAILED`, an `error` that says live-mode discrimination did NOT run, and the same reason as a loud `logError` line on stderr. Only that variable decides, so an access-key pair, `AWS_PROFILE`, or `MEMHTML_LLM_BASE_URL` does not prevent the skip.

The failure being guarded against is a green pipeline over a gate that never ran, and operators filter warnings out, which is why the line is an error rather than a warning. Failing the command on a skip keeps a skipped quality gate looking like the failure it is.

Re-run with credentials, or run `--mode fake`.

```bash
memhtml eval discriminate --mode live 2>&1 >/dev/null | head -1   # the reason, on stderr
```

## Where the gate is enforced

Every place runs it in `fake` mode, which needs no credentials:

- `mise run check`, the tier the `check` workflow runs on every pull request and push to `main`, and the release workflow runs before it publishes. Its `test:eval` tier runs the gate in process (`packages/eval/eval/discriminate.test.ts`) and its unit tier runs this command on small corpora (`apps/cli/tests/cli.test.ts`), so a change that degrades retrieval fails the build instead of shipping. The package smoke (`scripts/smoke-package.mjs`), which the `check` workflow's package job, the release workflow, and the pre-push hook run in its plain or `--live` form, also runs this command from the installed package with `--size 12`.

## When quality feels wrong but nothing errors

Run this command. It measures the installed ranking code on a corpus it generates itself and reads nothing from your store, so a `fake` failure points at that code, and neither result says whether your corpus holds the answer.

A pass here alongside bad answers in practice points first at the corpus or the index, though a `fake` pass says nothing about the live embedder, which `--mode live` measures. Go to [diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/).
