import { createHash } from "node:crypto"

/**
 * The matcher behind `DENIED_TERMS` in `src/gates.ts`, kept beside the tests that use it.
 *
 * A term is compared by digest only, so neither this file nor the list ever holds one in the clear.
 */

/** The form a term is hashed in: lowercase, ASCII letters and digits only. */
export const normalizeTerm = (term: string): string => term.toLowerCase().replace(/[^a-z0-9]/g, "")

/** The SHA-256 of a term's normalized form, as lowercase hex. */
export const termDigest = (term: string): string =>
  createHash("sha256").update(normalizeTerm(term)).digest("hex")

/** Separators that join two runs into one candidate: `kebab-case`, `snake_case`, and two words. */
const JOINERS: ReadonlySet<string> = new Set(["-", "_", " "])

const digests = new Map<string, string>()
const digestOf = (candidate: string): string => {
  const known = digests.get(candidate)
  if (known !== undefined) return known
  const digest = createHash("sha256").update(candidate).digest("hex")
  digests.set(candidate, digest)
  return digest
}

/**
 * Every place in `text` where a denied term appears, as the 1-based line and the digest it matched.
 *
 * A candidate is one lowercase run of letters and digits, or two runs separated by exactly one
 * joiner, concatenated. One scan of the text, so the cost is linear in its length; the digest cache is
 * shared across calls because the site repeats its vocabulary on every page.
 */
export const deniedTermHits = (
  text: string,
  denied: ReadonlySet<string>
): ReadonlyArray<{ readonly line: number; readonly digest: string }> => {
  const hits: Array<{ readonly line: number; readonly digest: string }> = []
  const lower = text.toLowerCase()
  const lineAt = (index: number): number => {
    let line = 1
    for (let at = lower.indexOf("\n"); at !== -1 && at < index; at = lower.indexOf("\n", at + 1))
      line += 1
    return line
  }
  let previous: { readonly run: string; readonly end: number } | undefined
  for (const match of lower.matchAll(/[a-z0-9]+/g)) {
    const run = match[0]
    const start = match.index
    const candidates = [run]
    if (
      previous !== undefined &&
      start - previous.end === 1 &&
      JOINERS.has(lower[previous.end] ?? "")
    )
      candidates.push(previous.run + run)
    for (const candidate of candidates) {
      const digest = digestOf(candidate)
      if (denied.has(digest)) hits.push({ line: lineAt(start), digest })
    }
    previous = { run, end: start + run.length }
  }
  return hits
}
