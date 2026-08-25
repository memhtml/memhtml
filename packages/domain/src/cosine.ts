/**
 * Cosine similarity of two vectors, unitless and clamped to `[-1, 1]`.
 *
 * Total: every input maps to a number in range, and `NaN` is never returned. A zero-magnitude
 * input yields `0`, and so does a vector carrying a `NaN` or infinite component — the two
 * conditions the arithmetic below cannot answer. `0` is the reading a vectorless candidate
 * already gets in MMR: no usable direction, so no demonstrable duplication, so no penalty.
 *
 * Returning `NaN` would be worse than returning a wrong number. MMR folds a `max` over the
 * similarities to the already-selected set, and the two equivalent ways of writing that fold
 * disagree on `NaN` — `Math.max(penalty, NaN)` is `NaN` while `NaN > penalty` is `false` — so a
 * single degenerate embedding would make the result depend on which fold runs, not on the
 * corpus.
 *
 * The result is clamped because the unclamped ratio does not stay in range. Verified in node
 * 2026-08-02: two vectors whose squared magnitudes fall into the subnormal range return
 * `1.000000106821595`. The squares underflow, so `sqrt` divides by a magnitude smaller than
 * the true one. Similarity is also the input to `1 - similarity` distance and to the MMR
 * penalty, both of which state a range, so the clamp belongs here rather than at each reader.
 *
 * Length mismatch is handled by walking the shorter vector rather than failing. The only way
 * two stored vectors differ in length is a half-migrated embedding model, a condition the
 * index refuses at the `embed_model` watermark, so it does not reach here.
 *
 * `ArrayLike` rather than `ReadonlyArray` so a `Float32Array` decoded straight off a stored
 * blob is an argument: this is the `vector_distance_cos` SQL function's own body, called once
 * per candidate row, and materialising two 1024-element arrays per call to satisfy a narrower
 * type would allocate more than the arithmetic costs. Every array caller still fits.
 */
export const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
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
  // A `NaN` component propagates into all three accumulators, and an infinite one makes the
  // ratio `Infinity / Infinity`. Both land here as `NaN`, and both mean "no usable direction".
  if (Number.isNaN(similarity)) return 0
  return Math.max(-1, Math.min(1, similarity))
}

/**
 * Cosine *distance*, `1 - similarity`, unitless in `[0, 2]`. This is the space the vector
 * arm's SQL works in (`vector_distance_cos`), so a threshold stated as a similarity is
 * converted once here rather than inverted at each call site.
 */
export const cosineDistance = (a: ArrayLike<number>, b: ArrayLike<number>): number =>
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
