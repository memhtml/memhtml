/**
 * Slug rules. A slug is the filename stem and the path is the id. There is no uuid
 * anywhere in the system, so the slug carries the whole burden of being stable, readable,
 * and filesystem-safe on every platform git runs on.
 */

/** Maximum slug length in characters, before any collision suffix. */
export const SLUG_MAX_LENGTH = 80

/**
 * The stem used when a title reduces to nothing sluggable, such as an all-punctuation or
 * non-Latin title. A placeholder beats an empty filename, and `memhtml doctor` can find
 * these by name.
 */
export const SLUG_FALLBACK = "untitled"

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
 */
export const slugify = (title: string): string => {
  const folded = title
    .normalize("NFKD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase()

  const kebab = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")

  if (kebab === "") return SLUG_FALLBACK

  return kebab.length <= SLUG_MAX_LENGTH
    ? kebab
    : kebab.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "") || SLUG_FALLBACK
}

/** True when a string is already a valid slug, the fixed point of {@link slugify}. */
export const isSlug = (value: string): boolean =>
  value.length > 0 && value.length <= SLUG_MAX_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)

/**
 * Append a collision suffix. `ordinal` is a 1-based ordinal for display in the filename;
 * ordinal 1 is the unsuffixed slug, 2 becomes `-2`, and so on, matching the `-2`/`-3`
 * convention. The suffix is added inside the length budget, so a maximum-length slug is
 * shortened rather than overflowed.
 *
 * **Two ordinals never name one file.** That is what makes the store's collision loop
 * (`packages/store/src/store.ts`, `pathFor`) terminate rather than re-propose the name that
 * collided, and it is not free at the length cap: a slug of exactly {@link SLUG_MAX_LENGTH}
 * characters whose own tail IS the suffix comes back UNCHANGED from the cut-and-append, because
 * cutting `…-0aa000aa-0-2` to 78 characters and appending `-2` rebuilds it. Reproduced
 * 2026-08-14 from a `fast-check` counterexample; ordinals 1 and 2 both named
 * `a00aa0a-…-0aa000aa-0-2`. Taking one character less resolves it for every ordinal, because the
 * result is then shorter than {@link SLUG_MAX_LENGTH} and only a slug OF that length can be
 * rebuilt this way.
 */
export const withCollisionOrdinal = (slug: string, ordinal: number): string => {
  if (ordinal <= 1) return slug
  const suffix = `-${ordinal}`
  /** The slug cut to `upTo` characters, with any hyphen the cut exposed trimmed off. */
  const stemAt = (upTo: number): string =>
    slug.length <= upTo ? slug : slug.slice(0, upTo).replace(/-+$/, "")
  const room = SLUG_MAX_LENGTH - suffix.length
  const widest = stemAt(room)
  const stem = `${widest}${suffix}` === slug ? stemAt(room - 1) : widest
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
