# A sandbox that fails to answer reads as the script's failure, so classify the runtime's own vocabulary

**Tags**: flake-discipline, sandbox, just-bash, quickjs, atomics, ci-vs-local, code-mode, retry
**Modules**: apps/cli/src/exec.ts, apps/cli/guest/corpus.mjs, apps/cli/tests/exec.test.ts

## What was observed

`mise run check` on a 4-vCPU GitHub runner failed one census case
(`memhtml/memhtml` run 31830358200, 2026-08-14):

```
FAIL tests/exec.test.ts > resolves every edge, matching the count grep can resolve with test -f
Error: script exited 1: at isDirectory (/workspace/lib/corpus.mjs:45:28): Error code: 0
```

The merge commit's tree was **byte-identical** (`git rev-parse <merge>^{tree}` equal) to the branch
head whose own run had passed 14 minutes earlier, and the case passes locally. So the input to the
gate was the same and the answer differed: the difference was the machine, not the code.

## What `Error code: 0` actually is

A guest `fs` call in just-bash is a synchronous round trip over a `SharedArrayBuffer`: the QuickJS
thread parks in `Atomics.wait` while the host thread services the operation and writes a status back.
`SyncBackend.execSync` (just-bash 3.2.0, byte-identical in 3.3.0) reports a handshake that did not
complete in **its own words**, never the host's:

- `Error code: <n>` — the wait returned with a status that is not `SUCCESS` and no error was recorded.
- `Operation timed out` — the wait expired with the host never answering.

The guest then throws that string, so it arrives formatted like any script error
(`at <frame>: <message>`) on `stderr` with exit 1. Two consequences:

- **A CLI reports it as the script's failure.** An agent is told its selector is wrong when the
  sandbox merely failed to hand back one `stat`.
- **The fault is one operation, not a dead sandbox.** In the observed failure the guest's own
  `writeStderr` and `exit` both landed afterwards, and the whole case returned in 1174ms — so the
  bridge was healthy on both sides of the glitch. That is what makes re-running the script correct
  rather than hopeful.

## The rules

**Classify a third-party runtime's own failure vocabulary before reporting its output as your
caller's fault.** The split this repo already draws — a script's failure is a successful envelope,
the runtime's failure is exit 1 — only holds if something decides which one happened. `bridgeFault`
returns the phrase it matched so the log carries the evidence, and exhaustion becomes
`StorageFailure` / `ERR_STORAGE` rather than an `exec.report` about a `stat` that never happened.

**A retry is only sound when the work has no effects to duplicate.** Here it is: the corpus is
mounted read-only, the sandbox has no network client, every attempt reads the same pinned commit, and
each attempt builds a fresh `Bash` and therefore a fresh shared buffer. State that argument where the
retry lives — the next reader's question is "what does this run twice?".

**Keep the two timeout classifications disjoint.** A cut-off script (`exitCode: 124`, a message
naming the limit) must NOT be a bridge fault, or a runaway loop burns every attempt's full bound
before answering. Both classifiers are pure functions with a test that asserts the same string
against both.

**A round trip you make for nothing is exposure you take for nothing.** The walk descended into
`.git`: 578 of the 305-memory fixture's 935 entries, so 62% of its bridge calls bought nothing, and
each one is a chance to hit the race. Skipping `.git` is also a correctness fix — a ref is a file at
a name its author chose, so a branch called `foo.html` lands at `.git/refs/heads/foo.html` and is
counted as a memory whose every field is empty.

## Measuring the flake before fixing it

Reproduction was attempted and **failed**: 25 sequential executions on an idle 16-core box and 72
executions across 6 processes pinned to 2 CPUs (3x oversubscription) produced zero faults. That
negative result is what forced the test shape — a case driving the real sandbox cannot distinguish a
working retry from a fault that never fires, so the classifier and the retry loop are separate
exported functions unit-tested over injected reports, each mutation-verified (drop the `.git` skip →
`expected 2 to be 1`; blind the classifier → the retry stops retrying; widen it to the cut-off
wording → the disjointness case fails; retry every non-zero exit → the "runs a script's own failure
once" case fails).

CI's amplifier is worth naming even though it is not the defect: a 4-vCPU runner runs turbo at up to
10 packages concurrently, each vitest forking its own workers, so a synchronous cross-thread
handshake competes with far more runnable threads than cores. The fix does not depend on that
diagnosis, which is the point — it holds on any machine.

## Related

[[sandbox-egress-is-set-by-the-constructor]] measured the same sandbox's other unstated property.
[[a-comment-stating-a-ratio-is-not-a-test]] carries the sibling rule for nondeterminism in a gate:
measure the flake before trusting it or before suppressing it.
