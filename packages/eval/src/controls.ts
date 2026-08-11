import {
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent
} from "@memhtml/domain"

/**
 * The three divergence families, as pure text transforms that turn a true claim into a
 * high-similarity WRONG one.
 *
 * A control is adversarial exactly when it is lexically and semantically near its target and
 * factually incompatible with it — which is what `@memhtml/domain`'s anti-merge guards already
 * formalize for the sleep cycle. So the control generator is the merge veto read backwards: the
 * three predicates that forbid folding two memories together are the three ways to build a
 * plausible impostor, and a control the veto cannot see is not a control at all.
 *
 * **Every control is validated against its OWN family's predicate, never against the
 * disjunction.** `negationDivergent` is a marker-PRESENCE check over the whole text: a target body
 * already containing `no`/`not`/`fail`/`invalid` puts a marker on both sides, the predicate returns
 * false, and the "flipped" control is then a paraphrase the retrieval stack is right to rank
 * alongside its target. Checking the disjunction would hide that — the numeric predicate would fire
 * on some incidental digit and the pair would look adversarial while the polarity flip did nothing.
 * {@link deriveControl} refuses that pair instead, so a weak control cannot enter a probe set.
 */

/** Which divergence a control embodies. Named on the probe, so a failure says which axis broke. */
export type DivergenceFamily = "negation" | "numeric" | "variant"

export const DIVERGENCE_FAMILIES: ReadonlyArray<DivergenceFamily> = [
  "negation",
  "numeric",
  "variant"
]

/** The text of a memory as the flips see it: the claim, then each body paragraph. */
export interface ClaimText {
  readonly claim: string
  readonly body: ReadonlyArray<string>
}

/** A derived control: the flipped text plus the family that produced it. */
export interface DerivedControl extends ClaimText {
  readonly family: DivergenceFamily
  /** What changed, for the probe's own record. */
  readonly note: string
}

/** The whole text one memory contributes, claim first. What the veto predicates compare. */
export const wholeText = (text: ClaimText): string => [text.claim, ...text.body].join(" ")

/**
 * Insertion points for a polarity flip, longest first so ` is not ` cannot be produced twice.
 *
 * Matched with surrounding spaces so a substring inside a word (`this`, `scan`) is never an
 * insertion point — the flip has to land on a verb, or the sentence reads as noise rather than as a
 * claim a retrieval stack could plausibly return.
 */
const NEGATION_ANCHORS: ReadonlyArray<string> = [
  " should ",
  " must ",
  " will ",
  " does ",
  " were ",
  " was ",
  " are ",
  " can ",
  " is ",
  " do "
]

/**
 * The affirmative claim as its negation.
 *
 * Total. When no verb anchor is present the whole sentence is wrapped rather than left unchanged —
 * a transform that silently returned its input would produce a "control" identical to its target,
 * and an identical control is a duplicate the content-hash index would refuse at index time, one
 * layer too late to explain itself.
 */
export const negationFlip = (claim: string): string => {
  for (const anchor of NEGATION_ANCHORS) {
    const at = claim.indexOf(anchor)
    if (at === -1) continue
    return `${claim.slice(0, at + anchor.length)}not ${claim.slice(at + anchor.length)}`
  }
  const trimmed = claim.trim()
  const lowered = trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
  return `It is not true that ${lowered}`
}

/** Numeric tokens, including dotted versions, in the order they appear. */
const NUMBER_PATTERN = /\d+(?:\.\d+)*/g

/**
 * The claim with its first numeric token replaced by a different one.
 *
 * `undefined` when the claim carries no number: the family does not apply, and inventing a number
 * to flip would produce a control that differs from its target by an ADDED fact rather than by a
 * contradicted one. The probe builder reads the `undefined` and skips the family rather than
 * emitting a weaker control under the same name.
 *
 * The replacement is `value + 10` for a small integer and `value * 2` otherwise, so the wrong
 * number stays in the plausible range for whatever the sentence counts — a retry budget of 13 is a
 * believable misremembering of 3, and 3000 is not.
 */
export const numericFlip = (claim: string): string | undefined => {
  const match = NUMBER_PATTERN.exec(claim)
  NUMBER_PATTERN.lastIndex = 0
  if (match === null) return undefined
  const found = match[0]
  const value = Number(found)
  if (!Number.isFinite(value)) return undefined
  const replacement =
    Number.isInteger(value) && value < 100 ? String(value + 10) : String(value * 2)
  return claim.slice(0, match.index) + replacement + claim.slice(match.index + found.length)
}

/**
 * The claim with a variant qualifier inserted after `anchor`.
 *
 * `qualifier` must be a token `@memhtml/domain`'s `VARIANT_QUALIFIERS` knows, or the pair is not
 * variant-divergent and {@link deriveControl} refuses it. Total: an absent anchor appends a
 * scope sentence naming the qualifier, which is a different fact about a different variant rather
 * than a paraphrase.
 */
export const variantFlip = (claim: string, anchor: string, qualifier: string): string => {
  const at = claim.indexOf(anchor)
  if (at === -1) return `${claim.replace(/\.$/, "")}, on the ${qualifier} variant only.`
  const cut = at + anchor.length
  return `${claim.slice(0, cut)} ${qualifier}${claim.slice(cut)}`
}

/** The predicate a family's control must satisfy against its target. */
export const familyPredicate = (
  family: DivergenceFamily
): ((textA: string, textB: string) => boolean) => {
  switch (family) {
    case "negation":
      return negationDivergent
    case "numeric":
      return numericTokenDivergent
    case "variant":
      return variantQualifierDivergent
  }
}

/** What a variant-family derivation needs beyond the target's own text. */
export interface VariantOptions {
  /** The token the qualifier is inserted after — a product or host name in the claim. */
  readonly anchor: string
  /** A `VARIANT_QUALIFIERS` member: `pro`, `beta`, `legacy`, … */
  readonly qualifier: string
}

/**
 * Derive one control from a target, or refuse.
 *
 * Refusal — `undefined` — is the load-bearing behavior, and it has two causes, both of which
 * produce a control that LOOKS adversarial and is not:
 *
 * 1. The family does not apply (no number to flip).
 * 2. The pair fails the family's own predicate. For `negation` that means the target body already
 *    carried a marker, so the flip is invisible to the very guard that defines the family.
 *
 * A caller that ignores the refusal and ships the pair anyway gets a probe whose control is a
 * paraphrase — and a gate built on paraphrases passes no matter how badly retrieval discriminates.
 */
export const deriveControl = (
  target: ClaimText,
  family: DivergenceFamily,
  options?: VariantOptions | undefined
): DerivedControl | undefined => {
  const flipped = ((): { readonly claim: string; readonly note: string } | undefined => {
    switch (family) {
      case "negation":
        return { claim: negationFlip(target.claim), note: "polarity inverted" }
      case "numeric": {
        const claim = numericFlip(target.claim)
        return claim === undefined ? undefined : { claim, note: "quantity replaced" }
      }
      case "variant": {
        if (options === undefined) return undefined
        return {
          claim: variantFlip(target.claim, options.anchor, options.qualifier),
          note: `qualified as ${options.qualifier}`
        }
      }
    }
  })()
  if (flipped === undefined) return undefined

  const control: DerivedControl = {
    family,
    claim: flipped.claim,
    body: target.body,
    note: flipped.note
  }
  return familyPredicate(family)(wholeText(target), wholeText(control)) ? control : undefined
}
