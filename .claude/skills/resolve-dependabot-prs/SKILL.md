---
name: resolve-dependabot-prs
description: This skill should be used when the user asks to "resolve the dependabot PRs", "clear the dependency PRs", "handle the bot PRs", "merge the dependabot backlog", "bump dependencies", "why are there four Effect PRs", or pastes a list of open dependabot PR titles. Covers this repo's install cooldown, the Effect catalog-as-a-set invariant, the packages whose bumps carry dated probes, and the gate-then-live-smoke order a dependency change has to clear.
version: 0.1.0
---

# Resolving dependabot PRs in memhtml

A dependency bump in this repo is not a rubber stamp. Four mechanisms make a green suite insufficient: an install cooldown that makes the newest version unavailable, a workspace catalog that must move as a set, comments carrying dated measurements a bump can falsify, and three run-time edges only a credentialed tier can exercise.

Work through the phases in order. Skipping the reconnaissance phase is what produces a wasted gate run or a merged bump that quietly invalidates a comment.

## Phase 1 — Read the actual state, not the notification

Bot PRs go stale. Dependabot recreates a group PR when `main` moves, so a title read an hour ago may propose different versions, and the PR number may have changed.

```bash
gh pr list --state open --json number,title --jq '.[] | "#\(.number) \(.title)"'
gh pr view <n> --json body --jq .body | grep -oE "^Updates \`[^\`]+\` from \S+ to \S+"
```

Note which are grouped and which are single. A set of near-identical single PRs for related packages is a symptom, not the task — see the grouping rule in `references/repo-invariants.md`.

## Phase 2 — Check the cooldown before anything else

`minimumReleaseAge` is 72 hours. A version inside that window cannot be installed, so verifying it costs a gate run that was always going to fail.

```bash
node .claude/skills/resolve-dependabot-prs/scripts/cooldown-check.mjs --pr <n>
```

Exit 0 means every version is installable; exit 1 lists what is blocked and when it clears. Where a proposed version is blocked, take the newest version that clears the window instead — a blocked install is the policy working.

## Phase 3 — Find what each bump could invalidate

For every package in the set, ask what claims name it:

```bash
./.claude/skills/resolve-dependabot-prs/scripts/probe-citations.sh <pkg> <old-version>
```

Three kinds of hit matter:

- **A dated probe comment** ("Probed live 2026-08-25 against eve 0.38.3: …") is a measured claim about a system this repo does not control. A bump is exactly the event that falsifies one, and no test can see a comment.
- **A version citation** outside `package.json` — a `$schema` URL, a comment naming the pinned binary — must move with the bump or the bump re-stales prose that was correct a moment ago.
- **A `.erpaval/solutions/**` lesson** records what was true when written. Read it; do not rewrite it.

Consult `references/sensitive-dependencies.md` for the packages already known to carry claims, what to verify for each, and how. Verify a claim in **both** directions: a guard being removed upstream can make local code obsolete rather than broken, which is equally worth knowing.

Where a claim can be checked without installing, do that first — unpacking a tarball into `/tmp` and reading the relevant dist file is cheaper than a gate run and answers the question directly.

## Phase 4 — Apply as one set per invariant

Respect the boundaries in `references/repo-invariants.md`. In particular, take the whole Effect catalog to one version in a single commit; never merge one of a set.

When a bot PR's base has moved, do not rebase its lockfile. Apply the version bumps to the `package.json` files and regenerate:

```bash
pnpm install
```

Sync any version citations Phase 3 surfaced, in the same commit as the bump.

## Phase 5 — Gate, then the tier the gate cannot replace

```bash
mise run check                    # 60 tasks; the definition of done
mise run package:smoke:live       # 69 checks; needs a Bedrock credential
```

Run the live tier whenever the set touches `eve`, `@aws-sdk/*`, `ai`, `@ai-sdk/*`, or anything the consolidator spawns. It is the only tier that performs a real `eve build` followed by a real `eve start`, and the only one that reaches Bedrock.

When the gate goes red, treat the failure as information rather than an obstacle. A red dependency PR is often the regression the pin exists to catch. Before changing a test to pass, establish which of these it is:

- the dependency regressed → hold the bump and record why;
- local code relied on behaviour that legitimately changed → fix the code;
- the test's FIXTURE no longer reaches the behaviour it covers → retarget the fixture, and keep the code.

The third case is easy to misread as dead code. Confirm that nothing still exercises the path before deleting it.

## Phase 6 — Land it, and supersede the bot's PRs

Push a named branch and open a PR whose body records what was verified beyond the gate — the cooldown margins, the claims re-checked, and the live-tier result. That is the part a reviewer cannot reconstruct.

`gh pr merge --auto` does not work here. Worse, `gh pr merge --merge` merges immediately even while non-required checks are pending, so wait for the checks explicitly:

```bash
for i in $(seq 1 14); do
  sleep 45
  [ "$(gh pr checks <n> 2>&1 | grep -cE 'pending|fail')" = "0" ] && break
done
gh pr checks <n>
```

Merge only once all checks report, then close each superseded bot PR with a comment naming the replacement and the reason it could not be merged as-is. Dependabot auto-closes a PR whose bump has landed, so re-check state before closing by hand.

## Reporting

State the cooldown margins, which claims were re-verified and how, and both gate results. Where a bump was held, name the version and the date it clears rather than leaving it as "deferred".

## Additional Resources

### Reference Files

- **`references/repo-invariants.md`** — the catalog-as-a-set rule, `minimumReleaseAge` semantics, dependabot group `update-types` behaviour, why `deps:` does not move a version, standing ignore rules, and the merge mechanics
- **`references/sensitive-dependencies.md`** — per-package: the claim a bump can falsify, where to check it, and what proves it

### Scripts

- **`scripts/cooldown-check.mjs`** — reports whether each `<pkg>@<version>` clears the window; reads the policy from `pnpm-workspace.yaml` rather than restating it, honours `minimumReleaseAgeExclude`, accepts `--pr <n>`, exits 1 when anything is blocked
- **`scripts/probe-citations.sh`** — surfaces the dated probes naming a package and every file citing its current version
