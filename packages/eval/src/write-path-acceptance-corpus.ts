/**
 * The labeled corpus the write-path ACCEPTANCE arm scores `dedup-merge` against.
 *
 * The discrimination arm (`write-path-corpus.ts`) asks whether the write path refuses a bad candidate.
 * This arm asks the question production could not answer on 2026-09-10 and 2026-09-11, when the
 * scheduled `dedup-merge` phase reported `vetoed: 171/171` and `vetoed: 178/178` with `merged: 0`: does
 * the store ACCEPT a merge it should? A gate that refuses everything scores perfectly on refusal and
 * has stored nothing, so acceptance has to be measured on its own.
 *
 * Each item is one GROUP as the model would have answered it — "these members are the same memory" —
 * labeled `merge` (the phase should fold every member into the oldest) or `keep` (the phase must fold
 * none), with the provenance of that label. The group is what the corpus stands in for: the same
 * substitution the discrimination arm makes when its labeled candidates stand in for the consolidator
 * model. Everything after the model's answer is production code, imported: the phase's own text join
 * (`dedupTextFor`), its own group fan-out (`groupPairsFor`), and the domain's `mergeCandidates` under
 * the phase's own `DEDUP_ADMIT_FLOOR`.
 *
 * Three `merge` classes are labeled from the phase's CONTRACT rather than from what it does today, and
 * the arm reports them as known gaps: a pair whose bodies differ only in an incidental number (a date,
 * a ticket id, an exit code) is vetoed by `numericTokenDivergent`, which compares the numeric token
 * SETS of the whole article text, and a group of three folds one member instead of two because
 * `mergeCandidates`' in-batch role guard claims the keeper after the first commit. Both are the
 * mechanism behind the two all-veto nights; see `docs/…/check-the-discrimination-gate.md`.
 *
 * Member bodies are plain prose with the article's text content in mind: `body` is what
 * `files.body_text` holds for the file, the `<article>`'s text, so a date inside `<time>` or a ticket
 * number inside a sentence is in it. The words the three predicates key on — negation markers,
 * variant qualifiers, and any token carrying a digit — are used only where the label intends them.
 */

/** Which way the label points. `merge`: every member folds into the oldest. `keep`: none does. */
export type AcceptanceLabel = "merge" | "keep"

/** One member of a group, as the phase's `CorpusRow` would carry it. Order in the array is corpus order. */
export interface AcceptanceMember {
  readonly path: string
  /** The `<mark>` claim, `files.gist`. */
  readonly gist: string
  /** The `<article>`'s text content, `files.body_text`. */
  readonly body: string
}

/** One labeled group. */
export interface LabeledGroup {
  /** Stable id, `m01`… for merge, `k01`… for keep. Reports and gap sets key on it. */
  readonly id: string
  readonly label: AcceptanceLabel
  /**
   * For a `merge` group, its shape (what the fold has to get RIGHT to accept it). For a `keep` group,
   * its divergence (why the veto must refuse it). The per-class breakdown groups on this.
   */
  readonly class: string
  /** The rule that decides the label, with the file that holds it. */
  readonly provenance: string
  /** Two or more members, oldest first. */
  readonly members: ReadonlyArray<AcceptanceMember>
}

const MERGE_RULE =
  "packages/domain/src/merge.ts mergeVetoed: a pair with no negation, numeric, or variant divergence is not vetoed; packages/sleep/src/phases/dedup-merge.ts DEDUP_ADMIT_FLOOR: a group pair is admitted on the model's answer alone"

const member = (path: string, gist: string, body: string): AcceptanceMember => ({
  path,
  gist,
  body: `${gist} ${body}`
})

/**
 * The `merge` classes the phase gets WRONG today, stated so the tier fails if the set moves.
 *
 * - `incidental-number`: the same claim, one side carrying a number the other lacks (a date, a ticket,
 *   an exit code). `numericTokenDivergent` requires the two numeric token sets to be EQUAL over the
 *   whole `gist\nbody_text`, so any incidental number on one side vetoes. This is the predicate that
 *   fired on every review task the two all-veto nights minted ("the two carry different numbers").
 * - `group-fanout`: a group of three implies two pairs with one keeper; `mergeCandidates` claims the
 *   keeper after the first commit and skips the second pair as a role-guard hit. One of two folds.
 */
export const ACCEPTANCE_KNOWN_GAP_CLASSES: ReadonlyArray<string> = [
  "incidental-number",
  "group-fanout"
]

export const ACCEPTANCE_CORPUS: ReadonlyArray<LabeledGroup> = [
  // ---- merge: the phase should fold every member into the oldest -------------------------------
  {
    id: "m01",
    label: "merge",
    class: "reworded",
    provenance: MERGE_RULE,
    members: [
      member(
        "areas/oncall/drain-vip-before-revert.html",
        "Drain the VIP before reverting a production deploy.",
        "The revert alone leaves in-flight connections pinned to the old target group."
      ),
      member(
        "areas/oncall/vip-drain-precedes-revert.html",
        "Before reverting a production deploy, drain the VIP first.",
        "Reverting by itself keeps in-flight connections pinned on the old target group."
      )
    ]
  },
  {
    id: "m02",
    label: "merge",
    class: "shared-number",
    provenance: `${MERGE_RULE}; numericTokenDivergent: identical numeric token sets do not diverge`,
    members: [
      member(
        "areas/llm/embed-retries.html",
        "The embed client retries 3 times with exponential backoff.",
        "Each retry waits longer than the one before it."
      ),
      member(
        "areas/llm/embedding-retry-budget.html",
        "Embedding calls are retried 3 times, with backoff between attempts.",
        "The wait grows between attempts."
      )
    ]
  },
  {
    id: "m03",
    label: "merge",
    class: "group-fanout",
    provenance:
      "packages/sleep/src/phases/dedup-merge.ts groupPairsFor: every member but the oldest drops into the keeper, so a group of three implies two folds",
    members: [
      member(
        "areas/sleep/sleep-runs-on-its-own-branch.html",
        "The scheduled sleep run commits on its own sleep branch and merges back afterwards.",
        "The store stays on its default branch while the run is open."
      ),
      member(
        "areas/sleep/sleep-branch-then-merge.html",
        "Sleep commits to a dedicated sleep branch and merges it back once the run is reviewed.",
        "Main is untouched while the branch is open."
      ),
      member(
        "areas/sleep/sleep-writes-land-on-a-branch.html",
        "Every sleep write lands on a sleep branch that is merged back after the run.",
        "The default branch stays where it was for the whole run."
      )
    ]
  },
  {
    id: "m04",
    label: "merge",
    class: "shared-negation",
    provenance: `${MERGE_RULE}; negationDivergent: both sides negated is not divergent`,
    members: [
      member(
        "areas/ci/frozen-lockfile-is-not-the-problem.html",
        "Dropping the frozen lockfile flag is not the fix; regenerate the lockfile and commit it.",
        "The flag is what keeps CI from resolving versions nobody reviewed."
      ),
      member(
        "areas/ci/regenerate-the-lockfile.html",
        "The fix is to regenerate and commit the lockfile, not to drop the frozen flag.",
        "Without the flag CI would resolve versions nobody reviewed."
      )
    ]
  },
  {
    id: "m05",
    label: "merge",
    class: "shared-variant",
    provenance: `${MERGE_RULE}; variantQualifierDivergent: identical qualifier sets do not diverge`,
    members: [
      member(
        "areas/build/laptop-toolchain-image.html",
        "Builds on the M1 Pro laptops need the arm64 toolchain image.",
        "The default image is built for the other architecture."
      ),
      member(
        "areas/build/arm-toolchain-for-laptops.html",
        "On an M1 Pro laptop the build requires the arm64 toolchain image.",
        "The stock image targets the other architecture."
      )
    ]
  },
  {
    id: "m06",
    label: "merge",
    class: "incidental-number",
    provenance:
      "packages/sleep/src/llm.ts DEDUP_SYSTEM: a group is one fact stored more than once, in different words; a date in one telling is not a second fact",
    members: [
      member(
        "areas/oncall/drain-vip-observed.html",
        "Drain the VIP before reverting a production deploy.",
        "The revert alone leaves in-flight connections pinned, observed on 2026-07-28 during the checkout incident."
      ),
      member(
        "areas/oncall/drain-vip-rule.html",
        "Always drain the VIP before you revert a production deploy.",
        "A bare revert leaves in-flight connections pinned to the old target group."
      )
    ]
  },
  {
    id: "m07",
    label: "merge",
    class: "incidental-number",
    provenance:
      "packages/sleep/src/llm.ts DEDUP_SYSTEM: a group is one fact stored more than once, in different words; a ticket id is a citation, not a differing number",
    members: [
      member(
        "areas/sleep/head-returns-to-starting-branch.html",
        "A failed sleep run puts HEAD back on the branch it started from.",
        "Tracked in pull request 178."
      ),
      member(
        "areas/sleep/failed-run-restores-branch.html",
        "When a sleep run fails, HEAD is restored to the starting branch.",
        "Raised as issue 130 and closed by the fix."
      )
    ]
  },
  {
    id: "m08",
    label: "merge",
    class: "incidental-number",
    provenance:
      "packages/sleep/src/llm.ts DEDUP_SYSTEM: a group is one fact stored more than once, in different words; an exit code quoted in one telling is not a differing claim",
    members: [
      member(
        "areas/review/suppressed-failure-lesson.html",
        "A completion message must disclose every tool failure the ledger recorded.",
        "The reviewer flagged a message that asserted success over a Bash exit code 1 in the same session."
      ),
      member(
        "areas/review/disclose-tool-failures.html",
        "Every recorded tool failure has to be disclosed in the completion message.",
        "A message that asserts success over a recorded failure is blocked by the reviewer."
      )
    ]
  },
  {
    id: "m09",
    label: "merge",
    class: "shared-version",
    provenance: `${MERGE_RULE}; numericTokenDivergent: a dotted version present on both sides does not diverge`,
    members: [
      member(
        "areas/ci/playwright-downloads-on-cold-runner.html",
        "Playwright 1.62 downloads its browser inside the test step on a cold runner.",
        "The timeout counts the download."
      ),
      member(
        "areas/ci/cold-runner-browser-download.html",
        "On a cold runner, Playwright 1.62 pulls the browser down during the test step itself.",
        "That download is inside the timed window."
      )
    ]
  },
  {
    id: "m10",
    label: "merge",
    class: "contraction",
    provenance: `${MERGE_RULE}; merge.ts CONTRACTIONS: "isn't" expands to "is not", so both sides carry the marker`,
    members: [
      member(
        "areas/gateway/port-4000-is-agentgateway.html",
        "Port 4000 isn't the LiteLLM proxy; it is agentgateway.",
        "Client auth happens at the gateway."
      ),
      member(
        "areas/gateway/agentgateway-on-4000.html",
        "Port 4000 is agentgateway, and it is not the LiteLLM proxy.",
        "The gateway is where client auth happens."
      )
    ]
  },
  {
    id: "m11",
    label: "merge",
    class: "same-gist",
    provenance: `${MERGE_RULE}; two files with one gist and different prose are one claim twice`,
    members: [
      member(
        "areas/brief/every-section-needs-a-directive.html",
        "Every section of the brief needs a directive.",
        "That includes the grounding note."
      ),
      member(
        "areas/brief/sections-carry-directives.html",
        "Every section of the brief needs a directive.",
        "The grounding note is a section too and takes one."
      )
    ]
  },
  // ---- keep: the phase must fold none ---------------------------------------------------------
  {
    id: "k01",
    label: "keep",
    class: "negation-flip",
    provenance:
      "packages/domain/src/merge.ts negationDivergent: exactly one side negated is a veto",
    members: [
      member(
        "areas/deploy/blue-green-is-safe.html",
        "Blue-green deploy is safe to run during business hours.",
        "Traffic shifts only after the new target group is healthy."
      ),
      member(
        "areas/deploy/blue-green-is-not-safe.html",
        "Blue-green deploy is not safe to run during business hours.",
        "Traffic shifts before the new target group is healthy."
      )
    ]
  },
  {
    id: "k02",
    label: "keep",
    class: "numeric-flip",
    provenance:
      "packages/domain/src/merge.ts numericTokenDivergent: different numeric token sets are a veto",
    members: [
      member(
        "areas/llm/embed-retries-three.html",
        "The embed client retries 3 times with exponential backoff.",
        "Each retry waits longer than the one before it."
      ),
      member(
        "areas/llm/embed-retries-thirteen.html",
        "The embed client retries 13 times with exponential backoff.",
        "Each retry waits longer than the one before it."
      )
    ]
  },
  {
    id: "k03",
    label: "keep",
    class: "variant-flip",
    provenance:
      "packages/domain/src/merge.ts variantQualifierDivergent: different qualifier sets are a veto",
    members: [
      member(
        "areas/build/m1-toolchain-image.html",
        "Builds on the M1 laptops need the arm64 toolchain image.",
        "The default image is built for the other architecture."
      ),
      member(
        "areas/build/m1-pro-toolchain-image.html",
        "Builds on the M1 Pro laptops need the arm64 toolchain image.",
        "The default image is built for the other architecture."
      )
    ]
  },
  {
    id: "k04",
    label: "keep",
    class: "templated-series",
    provenance:
      "modeled on the store's areas/inbox/verdict-suppressed-failure-<n> series, whose pairs the 2026-09-10 and 2026-09-11 nights vetoed at cosine 1.000 for differing numbers: two verdicts on two objectives are two records, and the veto's refusal is the right outcome",
    members: [
      member(
        "areas/inbox/verdict-suppressed-failure-a.html",
        "Review verdict for objective: wire the new CLI to the inference endpoint.",
        "Category: suppressed_failure. Claim reviewed: the completion message asserts the cutover is done and verified, but a recorded Bash exit code 1 is never acknowledged. Durable lesson: disclose the failure before claiming done."
      ),
      member(
        "areas/inbox/verdict-suppressed-failure-b.html",
        "Review verdict for objective: what is waiting for me this morning.",
        "Category: suppressed_failure. Claim reviewed: the completion message lists the waiting items, but a recorded Bash exit code 2 is never acknowledged. Durable lesson: disclose the failure before reporting the queue."
      )
    ]
  },
  {
    id: "k05",
    label: "keep",
    class: "qualifier-flip",
    provenance:
      "packages/domain/src/merge.ts variantQualifierDivergent: a deprecated variant against the current one is a veto",
    members: [
      member(
        "areas/cli/use-the-sync-flag.html",
        "Use the sync flag to refresh the index before a search.",
        "It runs the incremental update."
      ),
      member(
        "areas/cli/use-the-deprecated-sync-flag.html",
        "Use the deprecated sync flag to refresh the index before a search.",
        "It still runs the incremental update."
      )
    ]
  }
]
