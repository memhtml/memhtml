/**
 * Near-duplicate merge decisions and the anti-merge divergence guards, ported from
 * the predecessor memory system's `domain/curation.py`.
 *
 * Cosine similarity is geometric, and embedding models are weak on exactly the tokens that
 * carry a fact's polarity and its discriminators: "the deploy step is safe" and "the deploy
 * step is NOT safe" sit above 0.92, and so do "retry 3 times" vs "retry 13 times" and "M1"
 * vs "M1 Pro". The merge keeps the *older* file, so a blind high-cosine merge folds a newer
 * correction into an older wrong memory — it does not just lose information, it actively
 * restores the error the correction was written to fix. These guards are a deterministic
 * veto: a divergent pair is a candidate contradiction for the conflict phase, never a merge,
 * regardless of how high its cosine runs.
 */

/** Cosine similarity above which two bodies are the same content. Strict. */
export const NEAR_DUPLICATE_THRESHOLD = 0.92

/** Merge decisions applied per sleep cycle, so a flood cannot fan the phase out unboundedly. */
export const MAX_MERGE_PAIRS = 100

/**
 * One oriented candidate pair. `keepPath` is already the canonical (the older file) — the
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
 * The **in-batch role guard** is the load-bearing one. A path that appears in any committed
 * decision — as the keeper or as the drop — is fixed in that role for the batch and cannot
 * appear again in either. Both directions are required, and each rules out a distinct
 * corruption on a transitive chain:
 *
 * - A path already **dropped** cannot be dropped again (two keepers would each believe they
 *   absorbed it) nor become a keeper (content folded into a file this same batch archives).
 * - A path already a **keeper** cannot later be dropped. This is the case that survives if
 *   only the drop side is recorded: given `(gf, a)` then `(b, gf)`, both decisions commit,
 *   `gf` absorbs `a` and is then archived into `b` — so `a`'s content is superseded into a
 *   file that no longer exists, which is exactly the loss the guard exists to prevent.
 *   Verified against the input `[(gf → a), (b → gf)]`.
 *
 * Fixing a role rather than a membership also keeps the output a function of input order
 * alone: the first decision claiming a path wins, matching the SQL result-set iteration
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
 * The compress-path exclusion: the members of a batch to supersede and archive, with the
 * canonical removed and order preserved. When a batch folds into a pre-existing canonical, a
 * member can *be* that canonical, and archiving it would destroy the file just folded into.
 */
export const excludeSelfSupersede = (
  canonicalPath: string,
  memberPaths: ReadonlyArray<string>
): ReadonlyArray<string> => memberPaths.filter((path) => path !== canonicalPath)
