/**
 * Cosine similarity of two vectors, unitless and clamped to `[-1, 1]`.
 *
 * A zero-magnitude input yields `0`, never `NaN`: MMR takes a `max` over the similarities
 * to the already-selected set, and one `NaN` there poisons every comparison after it, so a
 * degenerate embedding would silently collapse diversification instead of contributing
 * nothing.
 *
 * The result is clamped because the unclamped ratio does not stay in range. Verified in node
 * 2026-08-02: two vectors whose squared magnitudes fall into the subnormal range return
 * `1.000000106821595` — the squares underflow, so `sqrt` divides by a magnitude smaller than
 * the true one. Similarity is also the input to `1 - similarity` distance and to the MMR
 * penalty, both of which state a range, so the clamp belongs here rather than at each reader.
 *
 * Length mismatch is handled by walking the shorter vector rather than failing, because the
 * only way two stored vectors differ in length is a half-migrated embedding model — a
 * condition the index refuses at the `embed_model` watermark, so it can never reach here.
 */
export const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB))
  return Math.max(-1, Math.min(1, similarity))
}

/**
 * Cosine *distance*, `1 - similarity`, unitless in `[0, 2]`. This is the space the vector
 * arm's SQL works in (`vector_distance_cos`), so a threshold stated as a similarity is
 * converted once here rather than inverted at each call site.
 */
export const cosineDistance = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number =>
  1 - cosine(a, b)

/**
 * Neumaier compensated summation. Naive left-to-right addition of the retention weight
 * profiles gives `0.9999999999999999` for two of the six (verified in node), which would
 * make a convexity assertion fail against a profile that is correct by construction. This
 * is the `math.fsum` the ported scorer relies on.
 */
export const compensatedSum = (values: Iterable<number>): number => {
  let sum = 0
  let compensation = 0
  for (const value of values) {
    const next = sum + value
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum
    sum = next
  }
  return sum + compensation
}
