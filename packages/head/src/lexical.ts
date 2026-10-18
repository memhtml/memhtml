import type { MemoryRecord } from "@memhtml/contracts"
import { HashMap, Option } from "effect"

/**
 * The lexical index: token to the paths that carry it, with each path's term frequency, plus the
 * per-document lengths BM25 normalizes by.
 *
 * Every field is a persistent `effect` structure, so a version built from its parent by
 * {@link removeFromLexical} and {@link addToLexical} shares every bucket the change did not touch.
 * The bucket for one token is `HashMap<path, tf>` rather than a bare path set because BM25 needs the
 * term frequency at query time and re-tokenizing a candidate per query would cost the whole body.
 */
export interface LexicalIndex {
  /** token -> path -> term frequency. Active records only. */
  readonly postings: HashMap.HashMap<string, HashMap.HashMap<string, number>>
  /** path -> token count after stop-word removal. Its size is the document count. */
  readonly lengths: HashMap.HashMap<string, number>
  /** Sum of every length, so the average length is O(1) at query time. */
  readonly totalLength: number
}

export const emptyLexical: LexicalIndex = {
  postings: HashMap.empty(),
  lengths: HashMap.empty(),
  totalLength: 0
}

/**
 * English function words dropped before indexing and before scoring a query. A short closed list:
 * a longer one starts dropping content words (`system`, `time`) that a memory corpus searches by.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "not",
  "of",
  "on",
  "or",
  "s",
  "she",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "when",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you"
])

/**
 * Lowercase and split on runs of non-word characters, then drop stop words and empties.
 *
 * The split class is Unicode-aware (`\p{L}` and `\p{N}` plus underscore) rather than the ASCII
 * `\W`, so `café` stays one token instead of losing its last letter. Deterministic and total.
 */
export const tokenize = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token !== "" && !STOP_WORDS.has(token))

/** The text one record is indexed by: title, then claim, then the whole body. */
export const indexedText = (record: MemoryRecord): string =>
  `${record.title} ${record.claim} ${record.bodyText}`

/** Term frequencies of one record's indexed text. */
export const termFrequencies = (record: MemoryRecord): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const token of tokenize(indexedText(record))) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

const lengthOf = (frequencies: ReadonlyMap<string, number>): number => {
  let total = 0
  for (const count of frequencies.values()) total += count
  return total
}

/** Add one record's tokens. The caller has already removed any earlier record at the same path. */
export const addToLexical = (index: LexicalIndex, record: MemoryRecord): LexicalIndex => {
  const frequencies = termFrequencies(record)
  let postings = index.postings
  for (const [token, count] of frequencies) {
    const bucket = Option.getOrElse(HashMap.get(postings, token), () =>
      HashMap.empty<string, number>()
    )
    postings = HashMap.set(postings, token, HashMap.set(bucket, record.path, count))
  }
  const length = lengthOf(frequencies)
  return {
    postings,
    lengths: HashMap.set(index.lengths, record.path, length),
    totalLength: index.totalLength + length
  }
}

/** Remove one record's tokens. A bucket emptied by the removal is dropped, not left empty. */
export const removeFromLexical = (index: LexicalIndex, record: MemoryRecord): LexicalIndex => {
  const length = Option.getOrUndefined(HashMap.get(index.lengths, record.path))
  if (length === undefined) return index
  let postings = index.postings
  for (const token of termFrequencies(record).keys()) {
    const bucket = Option.getOrUndefined(HashMap.get(postings, token))
    if (bucket === undefined) continue
    const next = HashMap.remove(bucket, record.path)
    postings =
      HashMap.size(next) === 0
        ? HashMap.remove(postings, token)
        : HashMap.set(postings, token, next)
  }
  return {
    postings,
    lengths: HashMap.remove(index.lengths, record.path),
    totalLength: index.totalLength - length
  }
}
