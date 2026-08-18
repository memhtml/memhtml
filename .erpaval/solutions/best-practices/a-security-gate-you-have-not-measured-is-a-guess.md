# A security gate you have not measured is a guess, in both directions

**Tags**: security, codeql, vex, openvex, scorecard, semgrep, betterleaks, grype, trivy, osv-scanner,
redos, rulesets, sarif, supply-chain, release-please, mutation-testing
**Modules**: .github/workflows, mise.toml, security/memhtml.openvex.json,
scripts/vex-to-osv-config.mjs, packages/contracts/src/paths.ts, packages/domain/src/frame.ts

**Category:** best-practices · **Session:** session-b308f2 · 2026-08-18

Six scanners had been running for weeks. Turning them into merge gates surfaced defects in the
*gates* — not one of which was visible from a green pipeline. The through-line: a security check
produces three outcomes, not two, and the third one looks exactly like success.

## A scanner that exits 0 having produced nothing

`betterleaks git . --exit-code=0` collapses *found secrets*, *found none*, and *never produced a
usable report* into one exit status. Observed live: it exited 0 having written a truncated SARIF,
printed neither its `scanned N bytes` nor its `no leaks found` line, and `mise run security` went
green. The only thing that noticed was `upload-sarif` rejecting the file as `Unexpected end of JSON
input` — which fails the job for the wrong reason and reads like an upload defect. A re-run passed,
so it was **intermittent**: a silent no-op that usually works, which is the version that erodes a gate
rather than the version someone fixes.

**Verify the artifact, do not infer it from the exit code.** Parse the report and assert its shape,
retry once, then fail naming the cause. Failing costs nothing that report-only exists to protect: an
invalid SARIF carries no finding detail to lose, and "the sweep did not run" is the one result that
must never be read as clean. `--exit-code=0`, `|| true`, and `--exit-code 0` appear on four of the
five scanners here, so the same hole exists wherever one of them dies quietly.

## Measure a static-analysis finding before you believe it OR dismiss it

CodeQL's first run raised two `js/polynomial-redos` at high, same rule, same severity, both on an
unbounded write path. **They were not the same finding**, and only measurement separated them:

- `normalizePath` — the named regex `/\/+$/` IS quadratic in isolation: 4 ms, 57 ms, 769 ms,
  **3049 ms** at n = 2k, 8k, 32k, 64k. The shipped chain was **flat at 0.05 ms** on the same input,
  because a preceding `.replace(/\/{2,}/g, "/")` left no run of two slashes to backtrack over.
- `frameKeyOf` — linear at 128k in all three adversarial shapes (0.07 / 0.27 / 12.66 ms). The
  whitespace shape the rule names cannot reach the regex at all: a `\s+ -> " "` collapse on the line
  above leaves single spaces. A genuine false positive.

So the analyzer was right about one regex and wrong about both reachabilities. **The interesting
defect was neither the one reported nor "nothing":** `normalizePath`'s safety depended on the ORDER of
three chained `.replace()` calls, with nothing stating it and nothing checking it. Swapping two lines
is a plausible tidy-up that restores a 5.5-second stall across 42 call sites — while returning
byte-identical output. The fix is to remove the order-dependence (`endsWith`/`slice` cannot be
reordered into a hazard), not to argue with the tool and not to rewrite a regex that measured fine.

**Cost-curve assertions are the lock, because this class is invisible to output.** The reordered
version still returned `"a/a"`, correctly, in 5.5 seconds. Assert correctness AND time, put the bound
three orders of magnitude below the quadratic value at that size — that gap is what lets a timing
assertion be a blocking test instead of a flake — and mutation-verify against the specific edit it
guards. Both locks here failed against their reintroduced bugs before being trusted.

Corollary: **a normalization step can be load-bearing for COST, not only for the semantics it is
documented for.** Both functions had one, neither said so, and deleting either turns a claim into a
stall. Say it where the normalizer is, and gate it.

## VEX is where a suppression belongs; the scanners disagree about reading it

A prose comment plus a click in a UI is how a suppression outlives the reasoning that justified it.
OpenVEX makes it a versioned, reviewable statement the scanners consume. Probed 2026-08-18, because
they do not agree:

| tool | VEX support |
|---|---|
| grype 0.111.1 | `--vex`, honors `not_affected` — matches moved to `ignoredMatches` tagged `{namespace: vex, vex-status: not_affected}` |
| trivy 0.70.0 | `--vex`, EXPERIMENTAL, accepts a file path |
| osv-scanner 2.5.0 | **none** — only `[[IgnoredVulns]]` in its own TOML |

So generate osv-scanner's config from the ledger rather than keeping a second list by hand, and gate
the generated file against drift with the script's own `--check`. **Expand aliases**: osv-scanner
reported the GHSA while Dependabot and trivy reported the CVE, and an ignore naming one silently stops
applying when a scanner switches which id it uses.

The ledger is itself a stated invariant, so it needs a gate — and the assertions that matter are the
silent ones. A status or justification outside the spec enum does not error; the scanner declines to
match, the finding reappears, and the document reads as though it were applied. A product without a
PURL parses and suppresses nothing. And `affected` / `under_investigation` must **not** render an
ignore entry: rendering one inverts the ledger's meaning while the file still generates and still
parses.

**A VEX-suppressed finding auto-closes as `fixed`** on the next scan, which beats a dismissal: the
record is in the repo, in review, in git history.

Match the justification to the truth: `vulnerable_code_not_in_execute_path` when the code is present
but unreached, not `component_not_present`. And when no patched version exists at all — advisory range
`<= 2.0.1` where 2.0.1 is the highest ever published — say **not overridable**, because "not yet
overridden" invites someone to go looking for the upgrade that does not exist.

## A ruleset naming a tool that never runs blocks every PR, forever

`code_scanning` required `CodeQL` in a repo with zero CodeQL analyses and no workflow producing one.
GitHub does not error; it waits. Every PR sat `BLOCKED` with all checks green and nothing to click.

Two follow-ons worth knowing before tightening one of these:

- **Do not gate on Scorecard.** Its high findings are repo *posture* — `BranchProtectionID`,
  `CodeReviewID`, `TokenPermissionsID` — and `MaintainedID` scores commit cadence. A merge gate a
  quiet fortnight can turn red is a gate people learn to bypass. Gate the tools whose findings are
  about the code and its dependencies; leave posture reporting.
- **Check the baseline before tightening.** Enabling a threshold against existing open alerts blocks
  everything immediately; every gated tool here was at zero first.

## Two small ones that cost real time

- **Resolve an action SHA through the `tags` API, not `git/ref/tags`.** The latter returns the
  *annotated tag object* for an annotated tag, so `v4.37.7` appeared not to match the pin that was in
  fact correct. Nearly logged as a finding. Also: `github/codeql-action`'s `init`, `analyze`, and
  `upload-sarif` must all pin the SAME version — mixing them is unsupported.
- **A commit type moves a version, and scope does not save you.** `fix(ci):` on a `mise.toml` scanner
  task made release-please cut a release PR whose only changelog entry described a change that ships
  nothing in the package. `fix` is a patch bump regardless of scope; CI-only work is `ci:`.

Related: [[a-stated-invariant-with-no-gate-is-not-an-invariant]],
[[synchronous-detector-on-untrusted-write-path]], [[a-wrong-count-reads-as-a-finding]],
[[cross-phase-contamination-and-vacuous-locks]], [[a-comment-stating-a-ratio-is-not-a-test]].
