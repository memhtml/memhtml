import { describe, expect, it } from "vitest"

import { closesFence, fencedBlockOf, fenceOpeningOf, LANG_TOKEN } from "../src/fences.js"

/**
 * The fence grammar. The properties that matter: a whole-paragraph fence is recognized with its
 * language and its code verbatim, and everything short of that — prose, an unterminated opener, a
 * mismatched closer — is `undefined`, so the template escapes it as text and the author's
 * backticks stay visible instead of half-rendering.
 */

describe("fencedBlockOf", () => {
  it("recognizes a fence and its info-string language", () => {
    expect(fencedBlockOf("```ts\nconst x = 1\n```")).toEqual({ lang: "ts", code: "const x = 1" })
  })

  it("recognizes a bare fence with no language", () => {
    expect(fencedBlockOf("```\nplain\n```")).toEqual({ code: "plain" })
  })

  it("lowercases the language and takes only the first info-string token", () => {
    expect(fencedBlockOf("```TypeScript title=x.ts\ncode\n```")?.lang).toBe("typescript")
  })

  it("keeps indentation and interior blank lines verbatim", () => {
    const code = "if (a) {\n\n    b()\n}"
    expect(fencedBlockOf(`\`\`\`js\n${code}\n\`\`\``)?.code).toBe(code)
  })

  it("drops an info-string token outside the language grammar rather than stamping it", () => {
    const block = fencedBlockOf("```<script>alert(1)</script>\ncode\n```")
    expect(block).toBeDefined()
    expect(block?.lang).toBeUndefined()
  })

  it("admits the real-world identifiers the grammar exists for", () => {
    for (const lang of ["c++", "c#", "objective-c", "python3", "f90"]) {
      expect(LANG_TOKEN.test(lang)).toBe(true)
    }
  })

  it("is undefined on prose, an unterminated fence, and a too-short closer", () => {
    expect(fencedBlockOf("Just a sentence.")).toBeUndefined()
    expect(fencedBlockOf("```ts\nconst x = 1")).toBeUndefined()
    expect(fencedBlockOf("````ts\ncode\n```")).toBeUndefined()
  })

  it("requires the closer to be a bare backtick run", () => {
    expect(fencedBlockOf("```ts\ncode\n``` trailing")).toBeUndefined()
  })

  it("accepts a longer closing run, per CommonMark", () => {
    expect(fencedBlockOf("```ts\ncode\n`````")).toEqual({ lang: "ts", code: "code" })
  })
})

describe("the line-level grammar the paragraph splitter uses", () => {
  it("agrees with fencedBlockOf on what opens and closes", () => {
    const opening = fenceOpeningOf("```ts")
    expect(opening).toBe("```")
    expect(closesFence("```", opening as string)).toBe(true)
    expect(closesFence("`````", opening as string)).toBe(true)
    expect(closesFence("``", opening as string)).toBe(false)
    expect(fenceOpeningOf("prose with ``` inside")).toBeUndefined()
  })
})
