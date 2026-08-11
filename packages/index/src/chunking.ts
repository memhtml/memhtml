import { createHash } from "node:crypto"

import { CHUNK_MAX_CHARS } from "./schema-const.js"

/**
 * Chunking and the chunk id. Pure, because the chunk id is a dedup key across the whole corpus and
 * a key that depended on anything ambient would stop two identical bodies from sharing a vector.
 */

/** One chunk of a memory's article text. */
export interface Chunk {
  /** `sha256(content_hash + ":" + ordinal)` — corpus-wide, so an identical body reuses the vector. */
  readonly chunkId: string
  /** 0-based position within THIS file's chunk sequence. */
  readonly ordinal: number
  readonly text: string
  readonly charCount: number
}

/**
 * The chunk id for a `(content_hash, ordinal)` pair.
 *
 * The colon separator is what keeps the mapping injective: without it, hash `…ab` at ordinal 1 and
 * hash `…ab1` at ordinal `""` would be indistinguishable inputs. `content_hash` already carries its
 * own `sha256:` prefix, so the digest input is unambiguous end to end.
 */
export const chunkIdFor = (contentHash: string, ordinal: number): string =>
  createHash("sha256").update(`${contentHash}:${ordinal}`, "utf8").digest("hex")

/**
 * Split article text into chunks of at most {@link CHUNK_MAX_CHARS} characters, no overlap.
 *
 * An entry short enough to be one chunk is the overwhelmingly common case — the format is one fact
 * per file — so the fast path returns a single chunk 0 whose text is the whole article, and the
 * embedding is then a function of the article rather than of an arbitrary window.
 *
 * Longer text splits on sentence-ish boundaries, greedily packing whole sentences into each chunk.
 * A sentence longer than the ceiling is hard-cut rather than dropped, so the function is total and
 * no text is ever lost from the index.
 */
export const chunkText = (
  text: string,
  contentHash: string,
  maxChars: number = CHUNK_MAX_CHARS
): ReadonlyArray<Chunk> => {
  const trimmed = text.trim()
  if (trimmed === "") return []

  const pieces =
    trimmed.length <= maxChars
      ? [trimmed]
      : packSentences(splitSentences(trimmed, maxChars), maxChars)

  return pieces.map((piece, ordinal) => ({
    chunkId: chunkIdFor(contentHash, ordinal),
    ordinal,
    text: piece,
    charCount: piece.length
  }))
}

/**
 * Sentence-ish units, each already within `maxChars`. A run with no sentence terminator — a long
 * table row, a URL list — is cut at the ceiling rather than returned oversized, which is what keeps
 * every chunk within the embedder's window.
 */
const splitSentences = (text: string, maxChars: number): ReadonlyArray<string> => {
  const units: Array<string> = []
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const piece = sentence.trim()
    if (piece === "") continue
    if (piece.length <= maxChars) {
      units.push(piece)
      continue
    }
    for (let at = 0; at < piece.length; at += maxChars) {
      units.push(piece.slice(at, at + maxChars))
    }
  }
  return units
}

/** Greedily join units into chunks, never crossing `maxChars`. */
const packSentences = (units: ReadonlyArray<string>, maxChars: number): ReadonlyArray<string> => {
  const chunks: Array<string> = []
  let current = ""
  for (const unit of units) {
    const candidate = current === "" ? unit : `${current} ${unit}`
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }
    if (current !== "") chunks.push(current)
    current = unit
  }
  if (current !== "") chunks.push(current)
  return chunks
}
