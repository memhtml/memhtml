import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Every authored page that claims to reproduce a source file VERBATIM, compared with that file.
 *
 * A prose promise to be verbatim is the one kind of documentation that rots invisibly: the page keeps
 * saying it, the reader keeps believing it, and nothing anywhere reads the other file. The consolidator
 * page publishes eve's live system prompt under exactly that promise, and it had drifted far enough to
 * describe a `/mnt/corpus/` mount the client does not compose and to predate the whole commitments
 * surface — so the site was serving, as the system prompt, a prompt that was not one.
 *
 * The comparison is byte-for-byte over the fenced block, minus the trailing newline the fence eats. A
 * looser match — length, or a few landmark sentences — is the shape that passes while the paragraph a
 * reader actually needs has changed.
 *
 * The table is keyed by page so a second reproduced source is one entry rather than a second test, and
 * each entry names the FENCE LANGUAGE it lives under, because a page may hold several fences and the
 * one under test has to be identified rather than found by position.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(dirname(root))

interface Reproduction {
  /** The authored page, relative to the docs content root. */
  readonly page: string
  /** The file the page claims to reproduce, relative to the repository root. */
  readonly source: string
  /** The fence's info string, which is what identifies the block on a page with several. */
  readonly fence: string
  /** The sentence on the page that makes the claim, so a reader can find what this gate enforces. */
  readonly promise: string
}

const REPRODUCED: ReadonlyArray<Reproduction> = [
  {
    page: "internals/the-consolidator.md",
    source: "apps/consolidator/agent/instructions.md",
    fence: "markdown",
    promise: "Section 4 reproduces it verbatim"
  }
]

const fenceBody = (body: string, fence: string): string | undefined => {
  const pattern = new RegExp(`\`\`\`${fence}\\n([\\s\\S]*?)\\n\`\`\``)
  return pattern.exec(body)?.[1]
}

describe("a page that claims to reproduce a source file does", () => {
  it.each(REPRODUCED)("keeps $page's $fence fence equal to $source", (entry) => {
    const pagePath = join(root, "src", "content", "docs", entry.page)
    const page = readFileSync(pagePath, "utf8")
    const source = readFileSync(join(repoRoot, entry.source), "utf8")

    // The claim itself, asserted first: an entry whose page stopped promising verbatim is an entry that
    // should be retired rather than one that quietly guards nothing.
    expect(page, `${entry.page} no longer promises "${entry.promise}"`).toContain(entry.promise)

    const block = fenceBody(page, entry.fence)
    expect(block, `${entry.page} holds no \`\`\`${entry.fence} fence`).toBeDefined()
    expect(block).toBe(source.replace(/\n+$/, ""))
  })

  it("names a source that exists and is not empty, so the comparison has two sides", () => {
    for (const entry of REPRODUCED) {
      const source = readFileSync(join(repoRoot, entry.source), "utf8")
      expect(source.trim().length, `${entry.source} is empty`).toBeGreaterThan(100)
    }
  })
})
