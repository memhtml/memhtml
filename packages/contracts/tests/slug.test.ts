import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  datePrefix,
  EPISODIC_PREFIX_LENGTH,
  filenameFor,
  hasDatePrefix,
  isSlug,
  SLUG_FALLBACK,
  SLUG_MAX_LENGTH,
  slugify,
  withCollisionOrdinal
} from "../src/slug.js"

/**
 * Word-shaped titles alongside arbitrary strings. `fc.string` alone does not exercise the
 * length cap: slugify collapses every run of non-alphanumerics to one hyphen, so a 200-char
 * arbitrary string kebabs down to ~10 characters (measured 2026-08-02, longest of 5,000 runs).
 * Only prose-shaped input reaches the 80-character budget.
 */
const wordyTitle = fc
  .array(fc.stringMatching(/^[a-zA-Z0-9]{1,12}$/), { minLength: 1, maxLength: 40 })
  .map((words) => words.join(" "))

const anyTitle = fc.oneof(fc.string({ maxLength: 200 }), wordyTitle)

describe("slugify", () => {
  it("emits only [a-z0-9-] and never exceeds the length budget", () => {
    fc.assert(
      fc.property(anyTitle, (title) => {
        const slug = slugify(title)
        expect(slug).toMatch(/^[a-z0-9-]+$/)
        expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
      }),
      { numRuns: 1000 }
    )
  })

  it("truncates a title that overruns the budget rather than emitting a long slug", () => {
    const midWord = "retry".repeat(40)
    expect(midWord.length).toBeGreaterThan(SLUG_MAX_LENGTH)
    expect(slugify(midWord)).toHaveLength(SLUG_MAX_LENGTH)
  })

  it("gives back the hyphen when the cut lands on one, so the slug stays well-formed", () => {
    // "abcd" repeated puts a hyphen exactly at the cut, which is then trimmed away.
    const onSeparator = Array.from({ length: 30 }, () => "abcd").join(" ")
    const slug = slugify(onSeparator)
    expect(slug).toHaveLength(SLUG_MAX_LENGTH - 1)
    expect(slug.endsWith("abcd")).toBe(true)
    expect(isSlug(slug)).toBe(true)
  })

  it("always produces a valid slug, so its output is its own fixed point", () => {
    fc.assert(
      fc.property(anyTitle, (title) => {
        const slug = slugify(title)
        expect(isSlug(slug)).toBe(true)
        expect(slugify(slug)).toBe(slug)
      }),
      { numRuns: 1000 }
    )
  })

  it("kebab-cases a real title", () => {
    expect(slugify("Prod rollbacks drain the VIP before the deploy is reverted")).toBe(
      "prod-rollbacks-drain-the-vip-before-the-deploy-is-reverted"
    )
  })

  it("folds diacritics to base letters rather than dropping the word", () => {
    expect(slugify("Déployé sur l'API")).toBe("deploye-sur-l-api")
  })

  it("collapses separator runs and trims the edges", () => {
    expect(slugify("  --Retry  3   times!!  ")).toBe("retry-3-times")
  })

  it("falls back rather than emitting an empty filename stem", () => {
    expect(slugify("!!!")).toBe(SLUG_FALLBACK)
    expect(slugify("")).toBe(SLUG_FALLBACK)
    expect(slugify("日本語")).toBe(SLUG_FALLBACK)
  })

  it("never leaves a truncated slug ending on a hyphen", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ minLength: 100, maxLength: 300 }), wordyTitle), (title) => {
        const slug = slugify(title)
        expect(slug.endsWith("-")).toBe(false)
        expect(slug.startsWith("-")).toBe(false)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("withCollisionOrdinal", () => {
  it("leaves the first claimant unsuffixed", () => {
    expect(withCollisionOrdinal("rollback-order", 1)).toBe("rollback-order")
    expect(withCollisionOrdinal("rollback-order", 0)).toBe("rollback-order")
  })

  it("suffixes from the second claimant onward", () => {
    expect(withCollisionOrdinal("rollback-order", 2)).toBe("rollback-order-2")
    expect(withCollisionOrdinal("rollback-order", 3)).toBe("rollback-order-3")
  })

  it("stays a valid slug inside the budget for any ordinal", () => {
    fc.assert(
      fc.property(anyTitle, fc.integer({ min: 1, max: 999 }), (title, ordinal) => {
        const suffixed = withCollisionOrdinal(slugify(title), ordinal)
        expect(isSlug(suffixed)).toBe(true)
        expect(suffixed.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
      }),
      { numRuns: 1000 }
    )
  })

  it("distinguishes consecutive ordinals, so a collision loop terminates", () => {
    fc.assert(
      fc.property(anyTitle, fc.integer({ min: 1, max: 998 }), (title, ordinal) => {
        const slug = slugify(title)
        expect(withCollisionOrdinal(slug, ordinal)).not.toBe(
          withCollisionOrdinal(slug, ordinal + 1)
        )
      }),
      { numRuns: 1000 }
    )
  })

  /**
   * **A slug at the cap whose own tail is the suffix.** The case above found this with a random
   * seed, so it is pinned here as a value: the counterexample's title kebabs to exactly
   * {@link SLUG_MAX_LENGTH} characters ending in `-2`, and cutting it to 78 to make room for `-2`
   * rebuilds the slug itself — so ordinals 1 and 2 named one file and the store's loop re-proposed
   * the name that had collided.
   *
   * Asserted as a value rather than left to the property, because a property test that only fails
   * on 1 seed in N is not a regression lock. The suffixed form stays a valid slug inside the budget,
   * which is the other half: shortening the stem may not produce `…--2` or an overrun.
   *
   * (Mutation: restoring the single-width cut in `withCollisionOrdinal` makes ordinals 1 and 2 equal
   * here. Observed: `expected '…-0aa000aa-0-2' not to be '…-0aa000aa-0-2'`.)
   */
  it("distinguishes ordinal 2 from ordinal 1 for a capped slug already ending in -2", () => {
    const slug = slugify(
      "A00Aa0a aaaAAaA0A aa00AAA0aAAA AAaAa0Aa AaAAAA00Aa aAAa AaAaaaaa0AA 0aa000AA 0 2A A"
    )
    expect(slug.length).toBe(SLUG_MAX_LENGTH)
    expect(slug.endsWith("-2")).toBe(true)

    expect(withCollisionOrdinal(slug, 2)).not.toBe(withCollisionOrdinal(slug, 1))
    expect(isSlug(withCollisionOrdinal(slug, 2))).toBe(true)
    expect(withCollisionOrdinal(slug, 2).length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
  })

  /**
   * Every ordinal the store can reach names a DIFFERENT file, on the slugs where that is hardest.
   *
   * The store walks 1..1000 (`pathFor`) and treats each candidate as a fresh name, so distinctness
   * has to hold across the whole range rather than between neighbours: a repeat anywhere is an
   * iteration that re-proposes a name already rejected. Enumerated rather than sampled, over the
   * family where the cut interacts with the suffix — a capped slug whose tail is itself an ordinal
   * suffix of each width.
   */
  it("names 1000 distinct files for every capped slug whose tail is an ordinal suffix", () => {
    for (const tail of ["-2", "-3", "-42", "-999"]) {
      const slug = `${"a".repeat(SLUG_MAX_LENGTH - tail.length)}${tail}`
      expect(slug.length).toBe(SLUG_MAX_LENGTH)
      const named = new Set<string>()
      for (let ordinal = 1; ordinal <= 1000; ordinal += 1) {
        const candidate = withCollisionOrdinal(slug, ordinal)
        expect(isSlug(candidate), `${tail} @ ${ordinal}: ${candidate}`).toBe(true)
        named.add(candidate)
      }
      expect(named.size, `tail ${tail}`).toBe(1000)
    }
  })
})

describe("episodic filenames", () => {
  it("stamps the date in UTC, not local time", () => {
    expect(datePrefix(new Date("2026-08-02T23:59:59Z"))).toBe("20260802")
    expect(datePrefix(new Date("2026-01-05T00:00:00Z"))).toBe("20260105")
  })

  it("prefixes exactly an episodic filename", () => {
    const at = new Date("2026-08-02T14:03:11Z")
    expect(filenameFor({ slug: "vip-drain", episodic: true, at })).toBe("20260802-vip-drain.html")
    expect(filenameFor({ slug: "vip-drain", episodic: false, at })).toBe("vip-drain.html")
  })

  it("makes the prefix detectable at its declared width", () => {
    const at = new Date("2026-08-02T14:03:11Z")
    fc.assert(
      fc.property(anyTitle, (title) => {
        const slug = slugify(title)
        const dated = filenameFor({ slug, episodic: true, at })
        expect(hasDatePrefix(dated)).toBe(true)
        expect(dated.slice(EPISODIC_PREFIX_LENGTH)).toBe(filenameFor({ slug, episodic: false, at }))
      }),
      { numRuns: 1000 }
    )
  })

  it("reads a bare slug of eight leading digits as prefixed, which is why the type decides", () => {
    const at = new Date("2026-08-02T14:03:11Z")
    expect(hasDatePrefix(filenameFor({ slug: "12345678-retries", episodic: false, at }))).toBe(true)
    expect(hasDatePrefix(filenameFor({ slug: "retry-3-times", episodic: false, at }))).toBe(false)
  })
})
