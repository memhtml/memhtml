/**
 * The FTS query sanitizer.
 *
 * This driver's MATCH parser has its own query syntax, and several forms that appear in ORDINARY
 * agent queries are HARD ERRORS rather than zero-result searches. Probed live 2026-08-02 against
 * @tursodatabase/database 0.7.2, each of these fails the statement:
 *
 * - `don't` — "Syntax Error: don't". An apostrophe in a natural-language query.
 * - `service:checkout-api` — "Field does not exist: 'service'". A colon is read as a field selector,
 *   and `type:name` entity references are the system's own notation.
 * - `-zebra`, `!!! ???` — "Invalid query: Only excluding terms given". A leading hyphen is negation.
 * - `AND`, `OR`, `NOT` alone, and `^x`, `[x]`, `{x}`, `\`, `-`, `--`.
 *
 * A search that throws where it should return nothing is worse than a bad ranking: `memory_search` is
 * an agent's first call, and a typed storage failure from an apostrophe reads to the agent as "the
 * memory system is broken". So the query is reduced to the tokens the index actually holds — runs of
 * Unicode letters and digits — and every operator character is dropped rather than escaped.
 *
 * Dropping rather than escaping is deliberate. This is not a query language exposed to users; the
 * `query` parameter is prose. Supporting negation or field selection would mean an agent could
 * accidentally invoke it by writing a hyphenated word, which is a far more common event than an agent
 * deliberately reaching for boolean syntax.
 *
 * `\p{L}\p{N}` rather than `[a-z0-9]`: `déployé` must survive as one token. ASCII-folding here would
 * make a diacritic query unmatchable against a corpus that stores the diacritics.
 */

/**
 * The MATCH-safe form of a query, or `""` when the query holds no indexable term.
 *
 * `""` is a value, not a failure: a caller MUST treat it as "the lexical arm contributes nothing" and
 * skip that arm, because an empty MATCH is accepted by the driver but a query of only punctuation is
 * not — and the two must not be distinguishable by whether the statement throws.
 */
export const sanitizeFtsQuery = (query: string): string =>
  (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")

/** True when a query carries at least one term the FTS index could match. */
export const hasFtsTerms = (query: string): boolean => sanitizeFtsQuery(query) !== ""
