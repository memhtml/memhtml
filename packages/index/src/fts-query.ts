/**
 * The FTS query sanitizer.
 *
 * FTS5's MATCH parser has its own query syntax, and several forms that appear in ORDINARY agent
 * queries are HARD ERRORS rather than zero-result searches. Probed live 2026-08-12 on node 24.19.0
 * (SQLite 3.53.3), each of these fails the statement:
 *
 * - `don't` fails with `fts5: syntax error near "'"`. An apostrophe opens a string literal.
 * - `service:checkout-api` fails with `no such column: service`. A colon is read as a column
 *   filter, and `type:name` entity references are the system's own notation. Bare `checkout-api`
 *   fails the same way, on `api`.
 * - `"unbalanced` fails with `unterminated string`.
 * - `AND`, `OR`, `NOT` alone, `a OR`, `NEAR(a b` fail with `fts5: syntax error`. They are keywords
 *   only in UPPERCASE, which is one reason the sanitizer lowercases: `and` is an ordinary term.
 * - `!!! ???`, `\`, `-`, `--`, `[x]` all fail with `fts5: syntax error`.
 *
 * A search that throws where it should return nothing is worse than a bad ranking. `memory_search` is
 * an agent's first call, and a typed storage failure from an apostrophe reads to the agent as "the
 * memory system is broken". So the query is reduced to the tokens the index actually holds, meaning
 * runs of Unicode letters and digits. Every operator character is dropped rather than escaped.
 *
 * Dropping rather than escaping is deliberate. The `query` parameter is prose, not a query language
 * exposed to users. Supporting negation or column filtering would mean an agent could
 * accidentally invoke it by writing a hyphenated word, which is a far more common event than an agent
 * deliberately reaching for boolean syntax. It also normalizes away the forms FTS5 happens to
 * ACCEPT, `zebra*` as a prefix search and `^x` as a column-head anchor. A query that silently
 * means something other than its words is worse than one that means all of them.
 *
 * `\p{L}\p{N}` is used instead of `[a-z0-9]` so `déployé` survives as one token. ASCII-folding
 * here would make a diacritic query unmatchable against a corpus that stores the diacritics.
 */

/**
 * The MATCH-safe form of a query, or `""` when the query holds no indexable term.
 *
 * `""` is a value, not a failure. A caller MUST read it as "the lexical arm contributes nothing" and
 * drop that arm, and MUST NOT bind it. An empty MATCH is itself a syntax error
 * (`fts5: syntax error near ""`), so a caller that passed `""` through would turn a query of only
 * punctuation into a storage failure, which is the whole outcome this module exists to prevent.
 */
export const sanitizeFtsQuery = (query: string): string =>
  (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")

/** True when a query carries at least one term the FTS index could match. */
export const hasFtsTerms = (query: string): boolean => sanitizeFtsQuery(query) !== ""
