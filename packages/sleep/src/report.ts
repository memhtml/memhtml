import { escapeAttribute, escapeText } from "@memhtml/html"

import { type PendingMark, type PhaseResult, phaseIndexOf, type RunReport } from "./contract.js"

/**
 * The committed sleep report: `.memhtml/sleep/<run-id>.html`.
 *
 * Semantic HTML in the corpus's own style, and deliberately NOT a memory: it has no `memhtml-*` head, so
 * it carries no type, no claim, and no content hash. That is what keeps it out of retrieval. The
 * indexer only reads paths under the four PARA buckets, and a report describing what curation did
 * would otherwise rank above the memories it describes on any query about the corpus itself.
 *
 * The report is what a reviewer reads before `memhtml sleep merge`, so it leads with what changed and what
 * failed instead of with the run's identity. A failed phase and an empty phase look identical in a
 * commit list, and the difference decides whether the branch should land.
 */

/** The ledger's record kinds, the ones the report renders for review rather than `merge` applies. */
export type BelowFloorMark = Extract<PendingMark, { readonly kind: "commitment-below-floor" }>

/**
 * A run report as one committed HTML document.
 *
 * `ledger` is the run's pending-mark ledger, or the part of it the report renders: the
 * `commitment-below-floor` records, listed under a fold so a reviewer can judge what the floor refused.
 * Marks of every other kind are ignored here; they are `merge`'s to apply, not the reader's to review.
 */
export const renderReport = (
  report: RunReport,
  ledger: ReadonlyArray<PendingMark> = []
): string => {
  const failed = report.phases.filter((phase) => phase.status === "failed")
  const skipped = report.phases.filter((phase) => phase.status === "skipped")
  const committed = report.phases.filter((phase) => phase.commitSha !== null)
  const belowFloor = ledger.filter(
    (mark): mark is BelowFloorMark => mark.kind === "commitment-below-floor"
  )

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sleep run ${escapeText(report.runId)}</title>
</head>
<body>
<article>
<p><mark>${escapeText(report.runId)} ran ${report.phases.length} phases: ${committed.length} committed, ${failed.length} failed, ${skipped.length} skipped.</mark>
${report.dryRun ? "This was a DRY RUN: counts were computed and nothing was committed." : `The branch is <code>${escapeText(report.branch)}</code>, based on <code>${escapeText(report.baseSha.slice(0, 12))}</code>.`}</p>

<dl>
<dt>Run</dt><dd>${escapeText(report.runId)}</dd>
<dt>Branch</dt><dd><code>${escapeText(report.branch)}</code></dd>
<dt>Base</dt><dd><code>${escapeText(report.baseSha)}</code></dd>
<dt>Head</dt><dd><code>${escapeText(report.headSha)}</code></dd>
<dt>Model calls</dt><dd><data value="${escapeAttribute(String(report.llmCalls))}">${report.llmCalls}</data></dd>
</dl>

${failed.length === 0 ? "" : `${renderFailures(failed)}\n`}${belowFloor.length === 0 ? "" : `${renderBelowFloor(belowFloor)}\n`}<table>
<caption>Per-phase outcome, in execution order</caption>
<thead><tr><th>#</th><th>Phase</th><th>Status</th><th>Commit</th><th>Model calls</th><th>Counts</th></tr></thead>
<tbody>
${report.phases.map(renderPhaseRow).join("\n")}
</tbody>
</table>
</article>
</body>
</html>
`
}

/**
 * The failures, above the table.
 *
 * A `<details>` fold, not a paragraph, because the failure reason is diagnostic detail. The
 * disclosure tiers put an elaboration behind a fold while its `<summary>` stays visible, so a
 * reviewer sees THAT a phase failed without reading the reason first.
 */
const renderFailures = (failed: ReadonlyArray<PhaseResult>): string =>
  `<details>
<summary>${failed.length} ${failed.length === 1 ? "phase" : "phases"} failed; every prior commit is intact and the later phases ran.</summary>
<ul>
${failed
  .map(
    (phase) =>
      `<li><code>${escapeText(phase.phase)}</code> — ${escapeText(phase.detail ?? "no detail recorded")}</li>`
  )
  .join("\n")}
</ul>
</details>`

/**
 * The commitments the floor refused, above the table and behind a fold.
 *
 * Each item carries what re-scoring needs: the statement, the confidence the floor compared, the
 * session it came from, and whether the same session showed it done. Ordered as the ledger holds
 * them, which is the order the phase saw them.
 */
const renderBelowFloor = (marks: ReadonlyArray<BelowFloorMark>): string =>
  `<details>
<summary>${marks.length} ${marks.length === 1 ? "commitment" : "commitments"} scored below the floor and minted nothing; listed for review.</summary>
<ul>
${marks
  .map(
    (mark) =>
      `<li><q>${escapeText(mark.statement)}</q> — confidence <data value="${escapeAttribute(String(mark.confidence))}">${escapeText(mark.confidence.toFixed(2))}</data>, session <code>${escapeText(mark.sessionId)}</code>, ${mark.resolved ? "stated as done" : "open"}</li>`
  )
  .join("\n")}
</ul>
</details>`

/** One phase's row. Counts are rendered as `key=value` pairs in insertion order. */
const renderPhaseRow = (phase: PhaseResult): string => {
  const counts = Object.entries(phase.counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
  return (
    `<tr><td>${phaseIndexOf(phase.phase)}</td>` +
    `<td><code>${escapeText(phase.phase)}</code></td>` +
    `<td>${escapeText(phase.status)}</td>` +
    `<td>${phase.commitSha === null ? "—" : `<code>${escapeText(phase.commitSha.slice(0, 12))}</code>`}</td>` +
    `<td>${phase.llmCalls}</td>` +
    `<td>${counts === "" ? "—" : escapeText(counts)}</td></tr>`
  )
}
