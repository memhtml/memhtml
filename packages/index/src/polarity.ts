import { cosine, negationDivergent } from "@memhtml/domain"

/**
 * The polarity step between fusion and MMR: demote the negation-flipped twin of a better answer.
 *
 * The four arms see no polarity. A memory saying "X merges 5 intervals" and one saying "X does not
 * merge 5 intervals" share every term the lexical arm matches, sit a hair apart in the vector space,
 * and tie on recency and salience, so the fused order between them is decided by noise, and the
 * discrimination gate's negation family measures exactly that coin toss (issue #132 reported one
 * stable inversion in 36 live probes, the flipped twin at rank 1 and the target at rank 12).
 *
 * The step is deliberately NARROW. A blanket penalty on every candidate carrying `not` would demote a
 * true negative fact ("never retry more than three times") whenever a query is phrased affirmatively,
 * which is most queries. So a candidate is demoted only when THREE things hold at once: its text
 * disagrees with the query's polarity ({@link negationDivergent}, the same marker set the gate's
 * controls are built from), another candidate in the pool agrees with the query, and the two are
 * near-identical in the vector space ({@link TWIN_COSINE}). That is the shape of a flipped twin and
 * of very little else; a lone negated memory with no affirmative near-copy is left exactly where the
 * fusion put it. The demoted twin lands below its lowest-ranked agreeing twin, scaled by
 * {@link POLARITY_DEMOTION}, so it stays in the pool and stays visible rather than vanishing. A twin
 * that fusion already placed below every agreeing near-copy is left alone: there is nothing to
 * correct, and scaling it anyway would move it past unrelated candidates for no reason.
 *
 * Symmetric in the query: a query that itself carries a negation demotes the AFFIRMATIVE twin, which
 * is what a caller asking "why does X not merge" wants above the fold.
 *
 * Two trade-offs are accepted and pinned by tests rather than hidden:
 *
 * - The query's PHRASING is read as the wanted polarity. Two live memories that contradict each other
 *   ("the step is safe" and "the step is not safe") are a flipped-twin pair, and an affirmatively
 *   phrased question ranks the affirmative one first even when the negated one is the newer
 *   correction. `memhtml correct` archives the memory it supersedes and the default scope excludes
 *   archived rows, so the resolved case never reaches this step; the residual is an unresolved
 *   contradiction both halves of which are still active, and that pair is the conflict phase's to
 *   settle, not the ranker's.
 * - The marker set is the merge veto's, shared with the gate's controls, and it includes outcome
 *   words (`without`, `fail`, `avoid`). A query like "deploy without downtime" therefore reads as
 *   negated and prefers the twin that carries a marker. A narrower query-side set would fix that
 *   phrasing and break "how to avoid retries", so the one shared set stays.
 *
 * Pure and total, so it is unit-tested with synthetic vectors, and it runs over the hydrated pool
 * (at most `limit × MMR_POOL_FACTOR` rows) so the O(n²) pair walk is bounded by a small constant.
 * The text judged is the claim, or the first {@link POLARITY_TEXT_CHARS} characters of the body when
 * a file has no claim, so a large body costs the tokenizer a bounded amount per row.
 */

/** Cosine at or above which two candidates are treated as one memory in two polarities. */
export const TWIN_COSINE = 0.9

/** The factor applied to a demoted twin's score after it is clamped below its agreeing twin. */
export const POLARITY_DEMOTION = 0.5

/** How much of a claimless body is judged: the opening, which is what its first chunk embeds. */
export const POLARITY_TEXT_CHARS = 2000

/** What the step reads off a hydrated row. `vector` is `undefined` for an unembedded memory. */
export interface PolarityRow {
  readonly path: string
  readonly gist: string
  readonly body_text: string
  readonly vector: ReadonlyArray<number> | undefined
}

/** One row with the score the step assigned it: `1 / fusedRank`, demoted when it is a flipped twin. */
export interface PolarityScored<Row> {
  readonly row: Row
  readonly score: number
}

/** The text polarity is judged on: the claim, or the opening of the body when a file has no claim. */
const polarityText = (row: PolarityRow): string =>
  row.gist.trim() !== "" ? row.gist : row.body_text.slice(0, POLARITY_TEXT_CHARS)

/**
 * Score a fused-order pool, demote each polarity-flipped twin, and return the pool re-sorted by the
 * result. Ties break on `path ASC` so the order is total.
 */
export const polarityScored = <Row extends PolarityRow>(
  query: string,
  rows: ReadonlyArray<Row>
): ReadonlyArray<PolarityScored<Row>> => {
  const scores = rows.map((_, offset) => 1 / (offset + 1))
  const texts = rows.map(polarityText)
  const disagrees = texts.map((text) => negationDivergent(query, text))

  for (let at = 0; at < rows.length; at += 1) {
    if (disagrees[at] !== true) continue
    const vector = rows[at]?.vector
    if (vector === undefined) continue
    /** The lowest score among agreeing near-copies, so the demoted twin lands below ALL of them. */
    let floor: number | undefined
    for (let other = 0; other < rows.length; other += 1) {
      if (other === at || disagrees[other] === true) continue
      const otherVector = rows[other]?.vector
      if (otherVector === undefined) continue
      if (cosine(vector, otherVector) < TWIN_COSINE) continue
      const otherScore = scores[other] as number
      if (floor === undefined || otherScore < floor) floor = otherScore
    }
    // Only a twin ABOVE at least one agreeing near-copy is out of order; one already below them all
    // keeps its fused score.
    if (floor !== undefined && (scores[at] as number) > floor)
      scores[at] = floor * POLARITY_DEMOTION
  }

  return rows
    .map((row, at) => ({ row, score: scores[at] as number }))
    .sort((left, right) => right.score - left.score || left.row.path.localeCompare(right.row.path))
}
