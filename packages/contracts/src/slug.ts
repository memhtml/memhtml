/**
 * Slug rules. A slug is the filename stem and the path is the id. There is no uuid
 * anywhere in the system, so the slug carries the whole burden of being stable, readable,
 * and filesystem-safe on every platform git runs on.
 */

/** Maximum slug length in characters, before any collision suffix. */
export const SLUG_MAX_LENGTH = 80

/**
 * The fewest characters a word-boundary cut may leave. A slug cut at its last word boundary inside
 * the budget keeps at least this many, else it is cut at the budget itself: a boundary further
 * back would drop most of a title whose last word inside the budget is long.
 */
export const SLUG_MIN_WORD_CUT = 60

/**
 * The stem used when a title reduces to nothing sluggable, such as an all-punctuation or
 * non-Latin title. A placeholder beats an empty filename, and `memhtml doctor` can find
 * these by name.
 */
export const SLUG_FALLBACK = "untitled"

/**
 * Cut a kebab-case string to at most `limit` characters: at its last hyphen at or before `limit`
 * when that leaves at least {@link SLUG_MIN_WORD_CUT} characters, so the result ends on a whole
 * word, else at `limit`. Any hyphen the cut exposes is trimmed, so the result is still well formed.
 */
const cutAtWord = (kebab: string, limit: number): string => {
  if (kebab.length <= limit) return kebab
  const boundary = kebab.lastIndexOf("-", limit)
  const end = boundary >= SLUG_MIN_WORD_CUT ? boundary : limit
  return kebab.slice(0, end).replace(/-+$/, "")
}

/** A title folded and kebab-cased, uncut: `""` when nothing in it is sluggable. */
const kebabOf = (title: string): string =>
  title
    .normalize("NFKD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")

/**
 * Kebab-case a title into `[a-z0-9-]`, at most {@link SLUG_MAX_LENGTH} characters.
 *
 * Diacritics are folded to their base letters (`déployé` ⇒ `deploye`) rather than dropped,
 * so a title stays recognizable. Runs of separators collapse to one hyphen and the result
 * carries no leading or trailing hyphen, which makes the function idempotent: a slug fed
 * back in comes out unchanged.
 *
 * Truncation cuts at {@link SLUG_MAX_LENGTH} and then trims any hyphen the cut exposed, so
 * a truncated slug is still a valid slug rather than one ending mid-separator.
 *
 * This is the slug of every name that is recomputed each time it is used: a workspace's
 * `projects/<slug>/` folder, a tag's `resources/<slug>/`, and the names the curator matches
 * against them. Its cut never changes, so a long workspace or tag stays one folder. A new
 * record's filename stem, computed once when the record is minted, is {@link slugifyStem}'s.
 */
export const slugify = (title: string): string => {
  const kebab = kebabOf(title)
  if (kebab === "") return SLUG_FALLBACK

  return kebab.length <= SLUG_MAX_LENGTH
    ? kebab
    : kebab.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "") || SLUG_FALLBACK
}

/**
 * The filename stem a new record takes from its title: {@link slugify}'s kebab-case, with a
 * longer title cut at its last word boundary inside {@link SLUG_MAX_LENGTH} when that keeps at
 * least {@link SLUG_MIN_WORD_CUT} characters, else at {@link SLUG_MAX_LENGTH} itself. A cut stem
 * is still a valid slug and, when it can be, ends on a whole word rather than a fragment of one.
 * Equal to {@link slugify} for every title whose slug fits the budget.
 *
 * Only a filename stem takes this cut, because a stem is computed once, when a record is minted,
 * and the path is the record's id from then on: the rule decides new filenames and never moves an
 * existing file. A folder name is recomputed on every write and keeps {@link slugify}'s cut.
 */
export const slugifyStem = (title: string): string => {
  const kebab = kebabOf(title)
  if (kebab === "") return SLUG_FALLBACK
  return cutAtWord(kebab, SLUG_MAX_LENGTH) || SLUG_FALLBACK
}

/** True when a string is already a valid slug, the fixed point of {@link slugify} and {@link slugifyStem}. */
export const isSlug = (value: string): boolean =>
  value.length > 0 && value.length <= SLUG_MAX_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)

/**
 * Append a collision suffix. `ordinal` is a 1-based ordinal for display in the filename;
 * ordinal 1 is the unsuffixed slug, 2 becomes `-2`, and so on, matching the `-2`/`-3`
 * convention. The suffix is added inside the length budget, so a maximum-length slug is
 * shortened rather than overflowed, and the stem is cut by the rule {@link slugifyStem} cuts with:
 * at its last word boundary inside the room left when that keeps {@link SLUG_MIN_WORD_CUT}
 * characters, else at the room itself.
 *
 * **The result never equals the input, at any slug length.** That is what makes the store's
 * collision loop (`packages/store/src/store.ts`, `pathFor`) terminate rather than re-propose
 * the name that collided. It is not free near the length cap: for a slug whose own tail IS the
 * suffix, cutting to make room and appending the suffix can rebuild the slug — and because the
 * cut also trims any hyphen it exposes, the rebuild can recur at MORE than one cut width. The
 * stem is therefore re-cut from its own post-trim length until appending the suffix no longer
 * reproduces the input; each re-cut strictly shortens the stem, so the loop terminates and the
 * result stays inside the budget.
 */
export const withCollisionOrdinal = (slug: string, ordinal: number): string => {
  if (ordinal <= 1) return slug
  const suffix = `-${ordinal}`
  /** The slug cut to at most `upTo` characters, the way {@link slugifyStem} cuts a title. */
  const stemAt = (upTo: number): string => cutAtWord(slug, upTo)
  let stem = stemAt(SLUG_MAX_LENGTH - suffix.length)
  while (stem.length > 0 && `${stem}${suffix}` === slug) {
    stem = stemAt(stem.length - 1)
  }
  /**
   * An empty stem takes the fallback, which keeps the function total over arbitrary strings:
   * even for a degenerate input equal to the bare suffix, the fallback stem differs from it.
   */
  return `${stem || SLUG_FALLBACK}${suffix}`
}

/**
 * The `YYYYMMDD-` prefix an episodic filename carries. Time is part of an episodic entry's
 * identity and it never receives a correction in place, so the date belongs in the name;
 * every other type is timeless and correctable, so it gets a bare slug.
 */
export const EPISODIC_PREFIX_LENGTH = 9

/** Format an instant as the `YYYYMMDD` stamp of an episodic filename, in UTC. */
export const datePrefix = (at: Date): string => {
  const year = at.getUTCFullYear().toString().padStart(4, "0")
  const month = (at.getUTCMonth() + 1).toString().padStart(2, "0")
  const day = at.getUTCDate().toString().padStart(2, "0")
  return `${year}${month}${day}`
}

/**
 * The filename for a memory: `20260802-slug.html` for episodic, `slug.html` otherwise.
 * The date prefix sits outside the slug's length budget, because it is identity, not title.
 */
export const filenameFor = (input: {
  readonly slug: string
  readonly episodic: boolean
  readonly at: Date
}): string => (input.episodic ? `${datePrefix(input.at)}-${input.slug}.html` : `${input.slug}.html`)

/** True when a filename carries the `YYYYMMDD-` episodic prefix. */
export const hasDatePrefix = (filename: string): boolean => /^\d{8}-/.test(filename)
