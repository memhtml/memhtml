# A comment stating a measured ratio is not a test, and the cascade can falsify it

**Category:** test-failures · **Session:** session-046ecf · 2026-08-12

`rfc.css` declared its palette with every contrast ratio annotated — `--memhtml-link: #0000ee; /* 9.08:1 */` — and rendered **2.19:1** site-wide in light mode. The values were right. The cascade made them wrong, and the comment documented the intent.

The mechanism is worth knowing because it looks correct:

```css
:root                            { --memhtml-link: #0000ee; }  /* specificity 0,0,1 */
:root[data-theme="light"]        { --sl-color-text-accent: var(--memhtml-link); }
:root, :root[data-theme="dark"]  { --memhtml-link: #8da9ff; }  /* the bare :root is ALSO 0,0,1 */
```

**A selector list takes each selector's specificity separately.** The bare `:root` in the third rule ties with the first and wins on order, so every `var(--memhtml-link)` in the light block resolved to the dark accent. Declaring the primitives inside `:root[data-theme="light"]` settles it by specificity rather than by ordering.

Any theme built by pointing one custom property at another has this hazard: the indirection is resolved where the property is _declared_, not where it is _used_.

## What actually catches it

An automated pass over the built output. `@axe-core/playwright` over four representative pages found it immediately; nothing in review had, across three agents editing the file.

**Run the baseline as a ratchet, not an allowlist.** Ours fails on a violation outside the list **and on an entry that stops firing**, so fixing a defect turns the gate red and tells you to delete its entry. That is what confirmed all three fixes had landed. An allowlist would have silently absorbed them.

Name the gate's blind spots in the gate: axe **passes** `alt="Diagram"` (which is astro-d2's own default title), **ignores inline `<svg>` without `role="img"`**, and **never tests SC 1.4.12**. Cover those with explicit probes or say plainly that they are uncovered.

## Two more from the same pass

- **Drop a flaky check rather than tolerate it.** axe's `scrollable-region-focusable` fired on 1 of 5 runs over an unchanged page while the geometry held identical. Replaced by a deterministic probe reporting under the same rule id, so the baseline entry still governs it.
- **A spell gate earns its keep on meaning, not spelling.** It flagged `unretrievable`; the dictionary word `irretrievable` would have **inverted the sentence**, whose whole point was that the file is still in the tree. Rephrase; do not substitute, and do not dictionary a coinage without reading it.

Related: [[result-identical-but-wrong]], [[cross-phase-contamination-and-vacuous-locks]].
