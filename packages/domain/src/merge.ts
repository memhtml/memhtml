/**
 * Near-duplicate merge decisions and the anti-merge divergence guards, ported from
 * the predecessor memory system's `domain/curation.py`.
 *
 * Cosine similarity is geometric, and embedding models are weak on exactly the tokens that
 * carry a fact's polarity and its discriminators: "the deploy step is safe" and "the deploy
 * step is NOT safe" sit above 0.92, and so do "retry 3 times" vs "retry 13 times" and "M1"
 * vs "M1 Pro". The merge keeps the *older* file, so a blind high-cosine merge folds a newer
 * correction into an older wrong memory. That loses the correction and restores the error the
 * correction was written to fix. These guards are a deterministic veto. A divergent pair
 * becomes a candidate contradiction for the conflict phase instead of a merge, no matter how
 * high its cosine runs.
 *
 * The guards are a POST-FILTER over every proposal, including a model's. `dedup-merge` asks a model
 * to partition a connected component into merge groups, and each pair that partition implies is
 * routed through {@link mergeCandidates} before anything is written. A model that groups a claim with
 * its own negation is refused by the same predicate that refuses a blind cosine, so the set of pairs
 * that can be committed does not widen when a model is bound.
 */

/** Cosine similarity above which two bodies are the same content. Strict. */
export const NEAR_DUPLICATE_THRESHOLD = 0.92

/** Merge decisions applied per sleep cycle, so a flood cannot fan the phase out unboundedly. */
export const MAX_MERGE_PAIRS = 100

/**
 * One oriented candidate pair. `keepPath` is already the canonical (the older file). The
 * orientation is the caller's, because it depends on commit dates this module does not read.
 * The texts are optional; when either is absent the divergence guards are skipped.
 */
export interface MergePair {
  readonly keepPath: string
  readonly dropPath: string
  readonly similarity: number
  readonly keepText?: string | undefined
  readonly dropText?: string | undefined
}

/** A committed merge: fold `dropPath` into `keepPath`. */
export interface MergeDecision {
  readonly keepPath: string
  readonly dropPath: string
  readonly similarity: number
}

/** Polarity markers. Exactly one side carrying one makes the pair polarity-divergent. */
const NEGATION_MARKERS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "none",
  "cannot",
  "without",
  "neither",
  "nor",
  "avoid",
  "disallow",
  "disallowed",
  "forbidden",
  "unsafe",
  "invalid",
  "false",
  "fail",
  "fails",
  "failed",
  "deny",
  "denied",
  "reject",
  "rejected"
])

/**
 * Contractions expanded before tokenizing, so "isn't" surfaces the underlying "not" and the
 * marker set stays small and word-boundary-safe.
 */
const CONTRACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["isn't", "is not"],
  ["aren't", "are not"],
  ["wasn't", "was not"],
  ["weren't", "were not"],
  ["don't", "do not"],
  ["doesn't", "does not"],
  ["didn't", "did not"],
  ["won't", "will not"],
  ["can't", "can not"],
  ["cannot", "can not"],
  ["couldn't", "could not"],
  ["shouldn't", "should not"],
  ["wouldn't", "would not"],
  ["mustn't", "must not"],
  ["haven't", "have not"],
  ["hasn't", "has not"],
  ["hadn't", "had not"],
  ["n't", " not"]
]

/**
 * Version and variant qualifiers. Two bodies agreeing except that one carries a qualifier
 * name different products or releases, not the same fact twice.
 */
const VARIANT_QUALIFIERS: ReadonlySet<string> = new Set([
  "pro",
  "max",
  "beta",
  "alpha",
  "rc",
  "preview",
  "legacy",
  "deprecated",
  "experimental"
])

const WORD_PATTERN = /[a-z0-9]+(?:\.[0-9]+)*/g
const DIGIT_PATTERN = /\d/

/** Lowercase, NFC-normalize, expand contractions. The pre-tokenize step. */
const normalizeText = (text: string): string => {
  let out = text.normalize("NFC").toLowerCase()
  for (const [pattern, replacement] of CONTRACTIONS) {
    out = out.replaceAll(pattern, replacement)
  }
  return out
}

/** Word and number tokens, including dotted versions like `v2.1`. */
const tokensOf = (text: string): ReadonlyArray<string> =>
  [...normalizeText(text).matchAll(WORD_PATTERN)].map((match) => match[0])

const intersect = (tokens: ReadonlyArray<string>, vocabulary: ReadonlySet<string>): Set<string> =>
  new Set(tokens.filter((token) => vocabulary.has(token)))

const numericTokens = (tokens: ReadonlyArray<string>): Set<string> =>
  new Set(tokens.filter((token) => DIGIT_PATTERN.test(token)))

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value))

/**
 * True when exactly one side carries a negation marker: "X is safe" against "X is NOT safe".
 * Symmetric. Both sides negating, or neither, is not divergent.
 */
export const negationDivergent = (textA: string, textB: string): boolean => {
  const negA = intersect(tokensOf(textA), NEGATION_MARKERS)
  const negB = intersect(tokensOf(textB), NEGATION_MARKERS)
  return negA.size > 0 !== negB.size > 0
}

/**
 * True when the two bodies carry different numeric tokens: "retry 3 times" against "retry 13
 * times". Two bodies with no numbers at all, or with identical numbers, do not trip it.
 * Symmetric.
 */
export const numericTokenDivergent = (textA: string, textB: string): boolean => {
  const numA = numericTokens(tokensOf(textA))
  const numB = numericTokens(tokensOf(textB))
  if (numA.size === 0 && numB.size === 0) return false
  return !sameSet(numA, numB)
}

/**
 * True when the two bodies carry different variant qualifiers: "M1" against "M1 Pro".
 * Symmetric.
 */
export const variantQualifierDivergent = (textA: string, textB: string): boolean => {
  const qualA = intersect(tokensOf(textA), VARIANT_QUALIFIERS)
  const qualB = intersect(tokensOf(textB), VARIANT_QUALIFIERS)
  return !sameSet(qualA, qualB)
}

/**
 * The veto: the disjunction of the three divergence predicates. Symmetric, pure, total. A
 * vetoed pair is never a duplicate no matter its cosine.
 */
export const mergeVetoed = (textA: string, textB: string): boolean =>
  negationDivergent(textA, textB) ||
  numericTokenDivergent(textA, textB) ||
  variantQualifierDivergent(textA, textB)

/**
 * Filter oriented candidate pairs into an in-batch-consistent decision list, applying in
 * order: the strict similarity threshold, the divergence veto (only when both texts are
 * present), a self-merge check, the in-batch role guard, and the per-cycle cap.
 *
 * The **in-batch role guard** needs the most explanation of the five. A path that appears in
 * any committed decision, as the keeper or as the drop, is fixed in that role for the batch
 * and cannot appear again in either. Both directions are required, and each rules out a
 * distinct corruption on a transitive chain:
 *
 * - A path already **dropped** cannot be dropped again (two keepers would each believe they
 *   absorbed it) nor become a keeper (content folded into a file this same batch archives).
 * - A path already a **keeper** cannot later be dropped. This is the case that survives if
 *   only the drop side is recorded: given `(gf, a)` then `(b, gf)`, both decisions commit,
 *   `gf` absorbs `a` and is then archived into `b`, so `a`'s content is superseded into a
 *   file that no longer exists. That is the loss the guard exists to prevent.
 *   Verified against the input `[(gf → a), (b → gf)]`.
 *
 * Fixing a role rather than a membership also keeps the output a function of input order
 * alone. The first decision claiming a path wins, matching the SQL result-set iteration
 * upstream, and a later pair naming it is skipped rather than reordering anything.
 */
export const mergeCandidates = (
  pairs: ReadonlyArray<MergePair>,
  options: {
    readonly threshold?: number | undefined
    readonly maxPairs?: number | undefined
  } = {}
): ReadonlyArray<MergeDecision> => {
  const threshold = options.threshold ?? NEAR_DUPLICATE_THRESHOLD
  const maxPairs = options.maxPairs ?? MAX_MERGE_PAIRS
  const decisions: Array<MergeDecision> = []
  const claimed = new Set<string>()

  for (const pair of pairs) {
    if (decisions.length >= maxPairs) break
    if (pair.similarity <= threshold) continue
    if (
      pair.keepText !== undefined &&
      pair.dropText !== undefined &&
      mergeVetoed(pair.keepText, pair.dropText)
    ) {
      continue
    }
    if (pair.keepPath === pair.dropPath) continue
    if (claimed.has(pair.dropPath) || claimed.has(pair.keepPath)) continue

    decisions.push({
      keepPath: pair.keepPath,
      dropPath: pair.dropPath,
      similarity: pair.similarity
    })
    claimed.add(pair.dropPath)
    claimed.add(pair.keepPath)
  }

  return decisions
}

/**
 * Connected components over an undirected edge list, as sorted member lists.
 *
 * The near-duplicate graph's components are dedup's units of work. A component is what "these
 * memories might all be one memory" looks like before anything has judged them, and it is the right
 * unit because near-duplication is transitive in practice: three rewordings of one fact produce
 * three edges, and folding them one pair at a time would ask the same question three times and could
 * answer it three different ways.
 *
 * **The partition is order-INVARIANT, not merely order-stable.** A union always keeps the
 * lexicographically smaller root, so every set's root is the smallest key it holds no matter which
 * order the edges arrive in. Members come back sorted, and components come back ordered by root,
 * which is each component's own smallest member. So the same edge SET produces the same output
 * whether it arrives mined-first, frame-first, mirrored, or shuffled. That is stronger than sorting
 * the input would be, and it is why no sort happens here: a caller cannot make this disagree with
 * itself by changing how it enumerates.
 *
 * A "larger root wins" or "first root seen wins" rule would break exactly that, because both make
 * the surviving root a fact about arrival order rather than about the set.
 *
 * Each pair is normalized before it is unioned, so `(a, b)` and `(b, a)` are one edge. A self-edge
 * introduces its key and joins nothing. Cost is near-linear in the edge count, and no step here ever
 * enumerates a pair the caller did not hand over.
 */
export const connectedComponents = (
  edges: ReadonlyArray<readonly [string, string]>
): ReadonlyArray<ReadonlyArray<string>> => {
  const parent = new Map<string, string>()

  const find = (key: string): string => {
    let current = key
    while ((parent.get(current) ?? current) !== current) {
      const next = parent.get(current) as string
      // Path compression re-points at the grandparent, which cannot change which key is the root.
      parent.set(current, parent.get(next) ?? next)
      current = parent.get(current) as string
    }
    return current
  }

  for (const [left, right] of edges) {
    if (!parent.has(left)) parent.set(left, left)
    if (!parent.has(right)) parent.set(right, right)
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft === rootRight) continue
    // The smaller key wins, which is what makes the result independent of edge order.
    if (rootLeft < rootRight) parent.set(rootRight, rootLeft)
    else parent.set(rootLeft, rootRight)
  }

  const byRoot = new Map<string, Array<string>>()
  for (const key of parent.keys()) {
    const root = find(key)
    const bucket = byRoot.get(root)
    if (bucket === undefined) byRoot.set(root, [key])
    else bucket.push(key)
  }

  return [...byRoot.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, members]) => members.sort())
}

/**
 * The compress-path exclusion: the members of a batch to supersede and archive, with the
 * canonical removed and order preserved. When a batch folds into a pre-existing canonical, a
 * member can *be* that canonical, and archiving it would destroy the file just folded into.
 */
export const excludeSelfSupersede = (
  canonicalPath: string,
  memberPaths: ReadonlyArray<string>
): ReadonlyArray<string> => memberPaths.filter((path) => path !== canonicalPath)
