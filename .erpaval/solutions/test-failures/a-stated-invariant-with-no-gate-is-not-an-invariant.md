# A stated invariant with no gate is not an invariant, and CI will certify its violation

**Tags**: dependabot, pnpm-workspace, catalog, effect-v4, invariant, gate, mutation-testing, prerelease, highlight-js, threshold-provenance, turbo, eve **Modules**: pnpm-workspace.yaml, .github/dependabot.yml, tests-integration/tests/catalog.test.ts, packages/html/src/detect.ts

**Category:** test-failures · **Session:** session-b308f2 · 2026-08-18

`pnpm-workspace.yaml` carried the rule in a comment: _"Effect v4 is pre-release: every Effect package moves as one pinned, tested set, and the three versions here are always the same string."_ Dependabot then opened one PR per package, each moving exactly one of the three — and **two of those PRs passed the full `check` gate green** with the catalog holding `effect: 4.0.0-rc.109` beside two `4.0.0-beta.107`.

The gate cannot see it, and the reason generalizes past this repo:

- **Each package imports only the entry it declares**, so no package's own suite observes the disagreement. A split catalog resolves, installs, and typechecks.
- **`tsc -b` cannot see it either** — two versions of a library are two valid module graphs.
- The observable failure is _two copies of the Effect runtime in one `node_modules`_: a `Layer` built by a test helper and a `Layer` consumed by the code under test come from different modules, surfacing as a mismatched `_tag` or a missing service at run time, far from its cause, and only in whichever suite happens to cross that seam.

**Where the invariant spans files, no per-file suite is its home.** The gate belongs in the tier whose subject is the repo (`tests-integration/tests/catalog.test.ts` here). Asking "which existing suite covers this?" and finding none is the signal that the invariant was never gated, not that it needs no gate.

## Prerelease moves escape a minor/patch group

The mechanism that fanned out four PRs from one intent. `.github/dependabot.yml` grouped `update-types: [minor, patch]` and its comment claimed that grouped Effect — but `4.0.0-beta.107 → 4.0.0-rc.109` is **neither minor nor patch**, so the group never matched and each package got its own PR. A set that must move together needs a `patterns:` group naming it (`effect`, `@effect/*`) across **all** update types; `update-types` alone cannot express "these move together" for anything on a prerelease line.

## Four assertions, because the obvious one is not sufficient

Same-string across the set is the assertion everyone writes, and alone it is weak. Each of these was **mutation-verified against the state it claims to catch** — the discipline that keeps finding vacuous locks here:

| Assertion                                              | Fails when                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| same string across the set                             | the split state exists — and the message names the offending entry                                                                            |
| the set list is **complete**, derived from the catalog | a fourth `@effect/*` entry is added to the catalog but not to the hardcoded set, which a same-string check over a stale list silently permits |
| every manifest reaches the dep via `catalog:`          | a manifest pins `"effect": "4.0.0-rc.109"` directly, which satisfies the other two while running a different version                          |
| the lockfile reflects the declaration                  | a manifest edit was never followed by an install, naming the entry instead of `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`                             |

The second row is the one worth internalizing: **a check over a hardcoded list of members must derive that list from the source of truth and compare**, or the list rots into a permission slip.

## A red dependency PR can be a real regression the pin exists to catch

`highlight.js` 11.11.2 → 11.12.0 failed five cases, and the temptation is to re-record the fixtures. Do not, when the fixture is a _measured reference_: hljs relevance scores **are** the fence detector's confidences, and its deployed threshold was swept over a 332-snippet corpus at a 95%-precision floor that lives in a different repo. Measured 2026-08-18: `slice:example-service/mise.toml@42+9` fell `0.5406 → 0.1993` and stopped stamping `toml`; one python row stopped too. Both are **coverage** losses carrying no evidence about **precision** — so re-recording would ship a threshold calibrated for a score distribution that no longer exists.

Hold it, and encode the hold where Dependabot will respect it: **ignore minor and major, leave patch open** so a CVE fix still reaches a PR where the exact-pin assertion decides whether it lands. A blanket ignore also blocks security updates.

## Two smaller notes from the same pass

- **Turbo cancels siblings on the first failure**, so a run that reports one failed task has _not_ verified the rest — the sibling `ELIFECYCLE` lines are cancellations. A single red task means the gate must be re-run to green before any claim about the other tiers.
- **A dependency whose build step is outside the gate needs the live tier.** `eve build` is a separate script, not in `check`'s graph, so a five-minor `eve` jump was invisible to 58 green tasks and was verified through `package:smoke:live` instead — watching for `batch=1`, since `batch=0` is what an unreached consolidation phase reports and it reads exactly like coverage.

Related: [[a-comment-stating-a-ratio-is-not-a-test]], [[cross-phase-contamination-and-vacuous-locks]], [[put-the-qualifier-in-the-claim]], [[where-a-filesystem-first-agent-gets-built]], [[a-wrong-count-reads-as-a-finding]].
