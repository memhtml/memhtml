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
 * runs of Unicode letters and digits. Every operator character except a balanced pair of ASCII double
 * quotes is dropped rather than escaped.
 *
 * Dropping rather than escaping is deliberate. The `query` parameter is prose with one piece of
 * syntax, the quoted phrase, and is otherwise not a query language exposed to users. Supporting
 * negation or column filtering would mean an agent could accidentally invoke it by writing a
 * hyphenated word, which is a far more common event than an agent deliberately reaching for boolean
 * syntax. It also normalizes away the forms FTS5 happens to ACCEPT, `zebra*` as a prefix search and
 * `^x` as a column-head anchor. A query that silently means something other than its words is worse
 * than one that means all of them.
 *
 * **The terms are joined with `OR`, and bm25 ranks.** FTS5 reads space-separated terms as an implicit
 * AND, which returns a file only when it holds EVERY token. For a sentence of more than a few words
 * that is not a verbatim quote of stored text, that is zero rows: measured on a 9k-chunk store,
 * `orion` alone matches 77 files and `orion wants talk` matches none, so the lexical arm runs and
 * contributes nothing while the fold proceeds on the other arms (issue #143). Joined with `OR`, a file
 * holding any of the words is a candidate and `bm25()` puts the files holding more of them, and the
 * rarer ones, first. The all-terms documents stay at the top and the partial matches follow.
 *
 * **A double-quoted span is kept as one FTS5 phrase**, so a caller can still demand adjacency:
 * `"drain the vip"` matches those three tokens in that order and nothing else. The words inside the
 * quotes are sanitized exactly like the words outside them, then emitted as a single `"..."` term, so
 * `"don't drain"` is the phrase `"don t drain"` and `"OR"` is the phrase `"or"`, a literal and not a
 * keyword. An unbalanced quote is treated as no quote at all: the characters are dropped and every
 * word is an ordinary term. Nothing else is quoted, and only the ASCII `"` is read this way.
 *
 * Because `OR` is emitted, sanitizing the sanitizer's own output is NOT an identity: the keyword
 * lowercases to the ordinary term `or`. What holds instead is that the output is always a MATCH the
 * driver accepts, once and twice sanitized, which the driver-level suite proves.
 *
 * `\p{L}\p{N}` is used instead of `[a-z0-9]` so `déployé` survives as one token. ASCII-folding
 * here would make a diacritic query unmatchable against a corpus that stores the diacritics.
 */

/** The runs of Unicode letters and digits in a lowercased text, in order. */
const termsOf = (text: string): ReadonlyArray<string> =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** The character that opens and closes a phrase. Straight ASCII only. */
const QUOTE = '"'

/**
 * The MATCH-safe form of a query, or `""` when the query holds no indexable term.
 *
 * Terms joined with ` OR `, each term either a bare lowercased token or a `"..."` phrase of tokens
 * from one balanced pair of quotes in the caller's text. `orion wants talk` is
 * `orion OR wants OR talk`; `find "drain the vip" fast` is `find OR "drain the vip" OR fast`.
 *
 * `""` is a value, not a failure. A caller MUST read it as "the lexical arm contributes nothing" and
 * drop that arm, and MUST NOT bind it. An empty MATCH is itself a syntax error
 * (`fts5: syntax error near ""`), so a caller that passed `""` through would turn a query of only
 * punctuation into a storage failure, which is the whole outcome this module exists to prevent.
 */
export const sanitizeFtsQuery = (query: string): string => ftsQueryForms(query).any

/**
 * The two MATCH forms one query sanitizes to. Both are `""` when the query holds no indexable term,
 * and both are the same string when it holds exactly one term.
 *
 * `all` joins the terms with `AND` and matches only a file holding every one of them. `any` joins
 * them with `OR` and is the form that finds anything at all when no file holds every word.
 *
 * The lexical arm runs `all` first and falls back to `any` only when `all` matches nothing in its
 * scope, and the reason is the FUSION rather than bm25. Measured on the discrimination gate's fixture
 * (seed 20260802, 304 files, 36 probes): bm25 ranks the all-terms file first under both forms, with
 * the same scores at the top, but under `any` the arm hands the fold 40 candidates where `all` hands
 * it 3 or 4. RRF's `1/(rank + 60)` is nearly flat across 40 positions (1/61 against 1/100), so the
 * arm stops acting as a filter, recency and salience decide among the 40, and the target's lexical
 * lead is compressed away: the any-of form alone holds MRR at 1.0 with zero inversions but drops
 * corpus MRR from 1.0 to 0.28 (0.20 on the lexical floor). All-then-any keeps every number at the
 * all-terms value and still answers the sentence that matches on one word.
 */
export interface FtsQueryForms {
  /** Every term required. `orion AND wants AND talk`. */
  readonly all: string
  /** Any term suffices, bm25 ranks. `orion OR wants OR talk`. */
  readonly any: string
}

export const ftsQueryForms = (query: string): FtsQueryForms => {
  const terms = ftsTermsOf(query)
  return { all: terms.join(" AND "), any: terms.join(" OR ") }
}

/**
 * The sanitized terms of a query, in order: bare lowercased tokens and `"..."` phrases, each already
 * a MATCH-safe string on its own. The one place the caller's text becomes MATCH vocabulary.
 */
const ftsTermsOf = (query: string): ReadonlyArray<string> => {
  const pieces = query.split(QUOTE)
  // `split` on N quotes yields N + 1 pieces, so an odd count of pieces is an even count of quotes.
  // With the quotes balanced the pieces alternate outside, inside, outside. Unbalanced, the quote
  // characters are not letters or digits and `termsOf` drops them like any other separator.
  const balanced = pieces.length % 2 === 1
  if (!balanced) return termsOf(query)
  const terms: Array<string> = []
  pieces.forEach((piece, at) => {
    const tokens = termsOf(piece)
    if (tokens.length === 0) return
    if (at % 2 === 1) terms.push(`${QUOTE}${tokens.join(" ")}${QUOTE}`)
    else terms.push(...tokens)
  })
  return terms
}

/** True when a query carries at least one term the FTS index could match. */
export const hasFtsTerms = (query: string): boolean => sanitizeFtsQuery(query) !== ""
