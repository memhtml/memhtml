import type { OGImageOptions } from "astro-og-canvas"

import { ICON_PNG_SIZE, PALETTE } from "./mark.ts"

/**
 * The social card, as a pure function of a page.
 *
 * The card is a specification excerpt and not a banner: warm paper, the mark at the head, one ink
 * title, a gray line of abstract, a running foot, and the standards-red rule bleeding off the bottom
 * edge. Flat fill, no gradient, no photograph and no wordmark — each of those would be the first thing
 * on this site that existed to decorate.
 *
 * `astro-og-canvas` draws exactly two text registers, a title and a description, so the hierarchy has
 * to come from size, weight and color. That is what an RFC's first page does anyway.
 */

/** The slug the root page's card is written under. Its collection id is the empty string. */
export const OG_SLUG_ROOT = "index"

/** The card's rendered size, fixed by `astro-og-canvas`. Stated so the head tags can declare it. */
export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16)
]

/** 5.36:1 on paper — the secondary ink `rfc.css` measured, kept rather than invented for the card. */
export const INK_SECONDARY = "#6B6862"

/** The face family name CanvasKit reads out of the Tinos TTFs. */
const FAMILY = "Tinos"

/** The three tiers, keyed by the path segment a page id starts with. */
const TIERS: ReadonlyArray<readonly [string, string]> = [
  ["learn/", "Learn"],
  ["reference/", "Reference"],
  ["internals/", "Internals"]
]

const tierLabel = (id: string): string | undefined =>
  TIERS.find(([prefix]) => id === prefix.replace(/\/$/, "") || id.startsWith(prefix))?.[1]

/**
 * The running foot: the two lines a specification carries at the bottom of every page — what the
 * document is, and where in it you are.
 *
 * The brand line appears on the root card only. It is one line of three words and it stops meaning
 * anything if it is stamped onto ninety-odd cards, which is the same reason the landing page states
 * it once.
 */
const runningFoot = (id: string): string => {
  if (id === OG_SLUG_ROOT) return "memhtml · MEANING · MEMORY · MARKUP"
  const tier = tierLabel(id)
  return [tier === undefined ? "memhtml" : `memhtml · ${tier}`, `/${id}/`].join("\n")
}

/**
 * Trim to a word boundary at or under `budget` characters.
 *
 * The renderer does not truncate: text longer than the card runs off the bottom edge and is clipped
 * mid-word, so the budget is enforced here where it can end on a word and say that it did. The two
 * numbers below are the measured ceilings for this card — a 62px bold title wraps three times and a
 * 30px description four before the red rule is reached.
 */
const clamp = (text: string, budget: number): string => {
  if (text.length <= budget) return text
  const cut = text.slice(0, budget)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "")}…`
}

export const TITLE_BUDGET = 84
export const DESCRIPTION_BUDGET = 168

/** Where the card for a page id is served from, relative to the site base. */
export const ogSlug = (id: string): string => `${id === "" ? OG_SLUG_ROOT : id}.png`

/** What a reader of the card is told it shows, for `og:image:alt`. */
export const ogAlt = (title: string): string =>
  `A specification cover set on warm paper: “${title}” over a line of abstract, closed by a red rule.`

export interface OgPage {
  readonly id: string
  readonly title: string
  readonly description?: string | undefined
}

/**
 * Where the mark is read from, relative to the working directory.
 *
 * `astro-og-canvas` reads a logo with `fs.readFile`, so the path is resolved against the process's
 * cwd — which every documented way of building this package sets to the package root. A cwd that
 * fails this assumption fails the build on a missing file rather than shipping a card without the
 * mark, so the assumption is loud.
 */
export const OG_LOGO_PATH = `./public/icon-${ICON_PNG_SIZE}.png`

export const ogCard = ({ id, title, description }: OgPage): OGImageOptions => ({
  title: clamp(title, TITLE_BUDGET),
  description: [
    ...(description === undefined || description === ""
      ? []
      : [clamp(description, DESCRIPTION_BUDGET)]),
    runningFoot(id)
  ].join("\n\n"),
  bgGradient: [rgb(PALETTE.paper)],
  /*
   * The mark, at its natural size, top-left.
   *
   * It also fixes the card's vertical composition, which is the non-obvious part: with no logo the
   * renderer pins the text block to the top padding edge and leaves half the card as paper, which
   * reads as a card that failed to finish rendering. A logo moves the text's permitted band down by
   * its own height plus one padding, so 48px of mark buys a text block that sits against the red
   * rule instead of floating above nothing.
   */
  logo: { path: OG_LOGO_PATH, size: [ICON_PNG_SIZE, ICON_PNG_SIZE] },
  // `block-end` strokes the bottom edge and half the width is clipped by it, so 6 renders 6px of
  // red across the foot — the mark's masthead rule, at card scale.
  border: { color: rgb(PALETTE.normative), width: 6, side: "block-end" },
  padding: 76,
  font: {
    title: {
      color: rgb(PALETTE.ink),
      size: 62,
      lineHeight: 1.15,
      weight: "Bold",
      families: [FAMILY]
    },
    description: {
      color: rgb(INK_SECONDARY),
      size: 30,
      lineHeight: 1.4,
      weight: "Normal",
      families: [FAMILY]
    }
  }
})
