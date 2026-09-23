/**
 * `@memhtml/head`: the corpus as a value. One immutable version per commit, held as persistent
 * `effect` structures, advanced by delta, read through `HeadView`, searched by two-arm RRF.
 * See `docs/v2-poc.md`.
 */

export type { Indexes } from "./indexes.js"
export { emptyIndexes, indexesOf, insertRecord, removeRecord } from "./indexes.js"
export type { LexicalIndex } from "./lexical.js"
export { STOP_WORDS, tokenize } from "./lexical.js"
export { withOverlay } from "./overlay.js"
export { blobShaOf, isArchivedPath, recordFrom } from "./record.js"
export type { SearchArm, SearchHit } from "./search.js"
export { DEFAULT_LIMIT, LEXICAL_WEIGHT, RECENCY_WEIGHT, searchHead } from "./search.js"
export type { HeadVersion, SkippedFile } from "./version.js"
export { advanceHead, isCandidatePath, loadHead } from "./version.js"
