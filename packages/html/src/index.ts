/**
 * `@memhtml/html` is the memory file format: parse, serialize, hash, and the surgical head editors.
 *
 * The format is semantic HTML5 over a closed vocabulary, and this package is its only
 * implementation. Every element in the vocabulary earns its place by carrying indexer
 * semantics, so the parse output is named for what the indexer stores rather than for the
 * markup it came from.
 */

export type { CheckResult } from "./constraints.js"
export {
  checkDocument,
  isRootRelativeHref,
  isValidDatetime,
  VIOLATION_SEPARATOR
} from "./constraints.js"
export type { CanonicalLang, Detection } from "./detect.js"
export {
  CANONICAL_LANGS,
  DEPLOY_THRESHOLD,
  detect,
  detectLang,
  normalizeLang
} from "./detect.js"
export {
  ArticleExtractions,
  Citation,
  Facet,
  MemoryDoc,
  MemoryLink,
  MemoryMetas
} from "./document.js"
export { addLink, addMeta, readMeta, removeLink, removeMeta, setMeta } from "./editors.js"
export type { FencedBlock } from "./fences.js"
export { closesFence, fencedBlockOf, fenceOpeningOf, LANG_TOKEN } from "./fences.js"
export type { CanonicalTextOptions, HashableArticle } from "./hash.js"
export {
  canonicalArticleText,
  canonicalText,
  contentHash,
  HASH_ALGORITHM,
  isContentHash
} from "./hash.js"
export { escapeAttribute, escapeText, writeChildren, writeOuter } from "./markup.js"
export { checkMemory, parseMemory } from "./parse.js"
export { metaPairs, serializeMemory } from "./serialize.js"
export type { NewMemoryInput } from "./template.js"
export {
  articleHtmlFor,
  DEFAULT_TASK_STATUS,
  newMemoryDoc,
  renderTemplate
} from "./template.js"
export type { MemoryMetaName, RepeatableMeta } from "./vocabulary.js"
export {
  ARTICLE_ELEMENTS,
  DOCUMENT_ELEMENTS,
  FIGURE_SCOPED_ELEMENTS,
  FORBIDDEN_ATTRIBUTES,
  FORBIDDEN_ELEMENTS,
  GIST_EXCLUDED_ELEMENTS,
  isMemoryMetaName,
  isRepeatableMeta,
  KNOWN_ELEMENTS,
  LINK_REL_PREFIX,
  META_ORDER,
  META_PREFIX,
  PERSON_ELEMENTS,
  REPEATABLE_META,
  REQUIRED_META,
  VOID_ELEMENTS
} from "./vocabulary.js"
