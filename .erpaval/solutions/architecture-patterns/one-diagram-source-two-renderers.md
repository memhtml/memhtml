# One diagram source, two renderers

A repository has two figure surfaces with disjoint capabilities: a docs site that can render anything,
and GitHub's README, which renders Mermaid natively and D2 not at all. Two hand-maintained drawings of
one system is the defect — they drift, and the drift is invisible because nothing compares them.

**One `.d2` source per figure, rendered twice.** astro-d2's `src=` attribute mounts an external file, so
the site's SVG and `d2 --ascii-mode=standard`'s monospace figure come from the same bytes. The ASCII goes
into the README as a committed fenced `text` block between `<!-- figure:NAME -->` markers, rewritten by
one script that also runs in `--check` mode from a vitest case. Generated, committed, gated by a test
rather than by a pipeline step — the same posture a generated command doc has.

## D2 0.7.1, probed live 2026-08-12

- **`fill-pattern: none` produces invalid SVG.** D2 accepts the value, emits
  `.none-overlay { fill: url(#none-…) }` in a second `<style>` block, and never closes its `<![CDATA[`.
  Three opens, two closes: a strict XML parser (librsvg) fails the whole document. Any unrecognized
  `fill-pattern` value is a candidate for the same shape of bug — D2 does not validate the name.
- **Themes 300 and 301 texture every container.** They put `class="dots-overlay"` on a container's rect,
  a `#0A0F25` dotted pattern at 0.1 opacity. No `style.fill` value displaces it — measured against
  `#ffffff`, `transparent`, and unset. Themes 0–5 do not do this. So a container is the only thing that
  makes a Terminal-theme figure non-monochrome, and a container-free figure is monochrome for free.
- **Theme 301 "Terminal Grayscale" is not achromatic.** Its palette is cool-tinted neutral: `#000410`,
  `#6D7284`, `#9499AB`, `#EEF1F8`. `vars.d2-config.theme-overrides` restating N1–N7, B1–B6, AA2/4/5 and
  AB4/5 as R=G=B is what makes monochrome literal. Square corners are D2's default in every theme
  measured, not this theme's contribution.
- **The ASCII renderer has its own layout and ignores `--layout`.** dagre and elk produce identical
  output. It packs same-rank siblings edge-to-edge when labels are wide, writes a `\n` escape through
  literally and shatters the row, and draws a diamond in asterisks and a circle or oval as a box with a
  stray `+O`. Its usable subset is rectangles, cylinders, pages, and hexagons, with node labels ≲16
  characters, edge labels ≲8, and at most three siblings per rank.

## The forcing constraints compose

No containers, short ASCII-only labels, and no diamonds is one figure style that satisfies the ASCII
renderer, the monochrome gate, and a pinned theme at once — the cheapest answer was not a compromise
between the three. Where a figure is site-only, the full shape vocabulary and multi-line labels are
available and the register says which figures those are.

## The measure is a width budget

A 30em prose measure and Starlight's `.sl-markdown-content img { max-width: 100% }` mean a figure's
NATURAL width is the scale its labels render at: 1164px in a 480px column is 0.41×, which is 6.6px text.
Every figure therefore carries a width budget (≲800px at `pad=20`, set per fence because the default
`pad=100` spends 160px on whitespace the measure then shrinks away), and `direction` is chosen by
measurement — `right` beat `down` 800px to 953px on one six-node dependency graph.

## Accessibility is not covered by the audit here

Two gaps that an automated pass reports as clean:

- axe accepts `alt="Diagram"`, which is astro-d2's DEFAULT `title`. A non-empty alt satisfies image-alt,
  so nothing catches the laziest possible alternative. A test asserting the title is neither empty nor
  the literal default, and is long enough to state how the parts connect, is what refuses it.
- axe ignores an inline `<svg>` with no `role="img"` — it is not an image to the audit at all. Keeping
  `inline: false` is therefore an accessibility decision and not only a caching one: an `<img>` keeps the
  text alternative inside something the audit checks.
- A fenced ASCII figure has no alt attribute to carry, and a screen reader sounds out the box characters.
  A caption below it is the RFC idiom and the wrong reading order on its own, so each figure is also
  announced BEFORE its fence, pointing at the paragraph that carries it in words.

## The census discipline applies to figures

Derive the expected figure count from the `.d2` files and the fences in the Markdown, then compare
against `dist/`. Read the built artifact rather than re-rendering in the test: re-rendering restates the
integration's flags and can agree with itself while disagreeing with the site. Scope a monochrome check
to what an element PAINTS (`fill=`, `stroke=`, and the `fill:`/`stroke:` inside `style=`) — D2 emits a
static CSS preamble carrying `--color-danger-fg:red` and unreferenced `.sketch-overlay-*` rules in every
theme, and a whole-file color grep fails on dead declarations. Scope a corner check to `<rect>`, where
`rx` is a corner radius; on an `<ellipse>` the same attribute is the radius and a legitimate figure
carries a large one.
