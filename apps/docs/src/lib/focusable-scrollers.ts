import { defineHastPlugin } from "satteri"

/**
 * Makes every horizontally scrolling block keyboard-reachable.
 *
 * A `<pre>` from Expressive Code and a `<table>` from Starlight's Markdown renderer both scroll
 * sideways when their content is wider than the measure, and neither is focusable — so the overflowing
 * half is reachable with a pointer and unreachable with a keyboard. That is SC 2.1.1, and on this site
 * it is not hypothetical: the measure is 30em, and a command's flag table or a wide code sample exceeds
 * it routinely.
 *
 * `tabindex="0"` is the fix WCAG's own technique names, and it belongs here rather than upstream in
 * either plugin: this site chose the narrow measure that makes those blocks overflow.
 *
 * A `role`/`aria-label` pair is deliberately NOT added. A focusable element with no accessible name is
 * a smaller problem than a region announced with a name invented by a build step, and the surrounding
 * heading already says what the block is.
 *
 * Sätteri's plugins are VISITOR OBJECTS keyed by node type, not unified-style functions over a tree:
 * an `element` subscription carrying a `filter` of tag names, resolved once per document, and the tag
 * filter runs in Rust so only matched nodes cross the boundary. A `(tree) => void` reaches `runNext`
 * and is handed something that is not a tree at all.
 *
 * The node is `Readonly`, so the visitor RETURNS a replacement rather than mutating in place.
 */
export const focusableScrollers = () =>
  defineHastPlugin({
    name: "memhtml-focusable-scrollers",
    element: {
      filter: ["pre", "table"],
      visit(node) {
        if (node.properties?.tabIndex !== undefined) return
        return { ...node, properties: { ...node.properties, tabIndex: 0 } }
      }
    }
  })
