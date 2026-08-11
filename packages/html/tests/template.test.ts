import { describe, expect, it } from "vitest"

import { contentHash } from "../src/hash.js"
import { checkMemory } from "../src/parse.js"
import { serializeMemory } from "../src/serialize.js"
import {
  articleHtmlFor,
  DEFAULT_TASK_STATUS,
  type NewMemoryInput,
  newMemoryDoc,
  renderTemplate
} from "../src/template.js"
import { parseOk } from "./fixtures.js"

/**
 * The write path's template. The property that matters: whatever an agent supplies, the file the
 * template emits satisfies all six constraints — an agent placing its own `<mark>` would violate
 * constraint 1 regularly, and a template that places it cannot.
 */

const BASE: NewMemoryInput = {
  title: "Prod rollbacks drain the VIP first",
  claim: "If a prod rollback is issued, drain the VIP before reverting the deploy.",
  memoryType: "procedural",
  at: "2026-08-02T14:03:11Z"
}

describe("the emitted file is always valid", () => {
  it("satisfies every constraint on the minimal input", () => {
    expect(checkMemory(renderTemplate(BASE))).toEqual({ violations: [], warnings: [] })
  })

  it("satisfies every constraint with body paragraphs, metas, and links", () => {
    const html = renderTemplate({
      ...BASE,
      body: ["The revert alone leaves connections pinned.", "Caught live on the third rollback."],
      confidence: 0.9,
      importance: 8,
      author: "agent:claude-fable-5",
      sessionId: "f7e32699",
      promptId: "pr_01JQ8",
      turnUuid: "9e0b41c2",
      entities: ["service:checkout-api", "person:sanju"],
      tags: ["deploy", "oncall"],
      links: [
        { rel: "supersedes", href: "/archive/2026/areas/oncall/old.html" },
        { rel: "part_of", href: "/areas/arcs/reversibility-first.html" }
      ],
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z"
    })
    expect(checkMemory(html)).toEqual({ violations: [], warnings: [] })
  })

  it("escapes a claim carrying markup characters rather than emitting an element", () => {
    const html = renderTemplate({ ...BASE, claim: "Use <script>alert(1)</script> never." })
    expect(checkMemory(html).violations).toEqual([])
    expect(parseOk(html).article.gist).toBe("Use <script>alert(1)</script> never.")
  })

  it("escapes a title carrying markup characters", () => {
    const html = renderTemplate({ ...BASE, title: 'A "quoted" & <angled> title' })
    expect(parseOk(html).title).toBe('A "quoted" & <angled> title')
  })

  it("is a serialization fixed point on the first read", () => {
    const html = renderTemplate(BASE)
    expect(serializeMemory(parseOk(html))).toBe(html)
  })
})

describe("the claim leads the first paragraph", () => {
  it("wraps the claim in the one <mark>", () => {
    expect(parseOk(renderTemplate(BASE)).article.gist).toBe(BASE.claim)
  })

  it("joins the first body paragraph as the claim paragraph's tail", () => {
    const doc = parseOk(
      renderTemplate({ ...BASE, body: ["A tail sentence.", "A second paragraph."] })
    )
    expect(doc.article.html.split("<p>")).toHaveLength(3)
    expect(doc.article.html).toContain("</mark> A tail sentence.</p>")
  })

  it("drops an empty body paragraph rather than emitting an empty element", () => {
    const doc = parseOk(renderTemplate({ ...BASE, body: ["", "   ", "Real prose."] }))
    expect(doc.article.html).not.toContain("<p></p>")
    expect(doc.article.bodyText).toBe(`${BASE.claim} Real prose.`)
  })

  it("trims the claim", () => {
    expect(parseOk(renderTemplate({ ...BASE, claim: "  A claim.  " })).article.gist).toBe(
      "A claim."
    )
  })
})

describe("fenced code blocks in the prose path", () => {
  const FENCED = {
    ...BASE,
    body: ["The tail sentence.", "```ts\nconst x: number = 1\n```", "Prose after the block."]
  }

  it("renders a fenced paragraph as figure/pre/code with data-lang", () => {
    const html = renderTemplate(FENCED)
    expect(checkMemory(html)).toEqual({ violations: [], warnings: [] })
    const doc = parseOk(html)
    expect(doc.article.html).toContain(
      '<figure><pre><code data-lang="ts">const x: number = 1</code></pre></figure>'
    )
    expect(doc.article.codeLangs).toEqual(["ts"])
  })

  it("keeps the code out of the gist and in the body text", () => {
    const doc = parseOk(renderTemplate(FENCED))
    expect(doc.article.gist).toBe(BASE.claim)
    expect(doc.article.bodyText).toContain("const x: number = 1")
  })

  it("omits data-lang when the fence names no language", () => {
    const doc = parseOk(renderTemplate({ ...BASE, body: ["```\nplain code\n```"] }))
    expect(doc.article.html).toContain("<code>plain code</code>")
    expect(doc.article.codeLangs).toEqual([])
  })

  it("never joins a fence onto the claim paragraph", () => {
    // The claim must lead its own <p>; a fence as the first body paragraph follows as a figure.
    const html = renderTemplate({ ...BASE, body: ["```sh\nmemhtml doctor\n```"] })
    expect(checkMemory(html)).toEqual({ violations: [], warnings: [] })
    const doc = parseOk(html)
    expect(doc.article.html).toContain(`<p><mark>${BASE.claim}</mark></p>`)
    expect(doc.article.html).toContain('data-lang="sh"')
  })

  it("preserves indentation and blank lines through parse and serialize", () => {
    const code = "if (a) {\n\n    b()\n}"
    const html = renderTemplate({ ...BASE, body: [`\`\`\`js\n${code}\n\`\`\``] })
    const doc = parseOk(html)
    expect(doc.article.html).toContain(code)
    expect(serializeMemory(doc)).toBe(html)
  })

  it("escapes markup inside the code rather than parsing it", () => {
    const html = renderTemplate({ ...BASE, body: ["```html\n<script>alert(1)</script>\n```"] })
    expect(checkMemory(html).violations).toEqual([])
    expect(parseOk(html).article.bodyText).toContain("<script>alert(1)</script>")
  })

  it("escapes an unterminated fence as paragraph text, backticks visible", () => {
    const doc = parseOk(renderTemplate({ ...BASE, body: ["```ts\nconst x = 1"] }))
    expect(doc.article.html).not.toContain("<pre>")
    expect(doc.article.bodyText).toContain("```ts")
  })
})

describe("articleHtml escape hatch", () => {
  it("uses pre-authored markup verbatim, canonicalized", () => {
    const html = renderTemplate({
      ...BASE,
      articleHtml:
        '<p><mark>A claim.</mark></p><dl><dt>Host</dt><dd><data value="3">three</data></dd></dl>'
    })
    const doc = parseOk(html)
    expect(doc.article.facets).toEqual([{ name: "Host", value: "three", numericValue: 3 }])
    expect(checkMemory(html)).toEqual({ violations: [], warnings: [] })
  })

  it("ignores claim and body when articleHtml is given", () => {
    const doc = parseOk(
      renderTemplate({
        ...BASE,
        body: ["ignored"],
        articleHtml: "<p><mark>Different claim.</mark></p>"
      })
    )
    expect(doc.article.gist).toBe("Different claim.")
    expect(doc.article.bodyText).not.toContain("ignored")
  })

  it("falls back to claim and body when articleHtml is blank", () => {
    expect(parseOk(renderTemplate({ ...BASE, articleHtml: "   " })).article.gist).toBe(BASE.claim)
  })

  it("surfaces the caller's own constraint violation rather than hiding it", () => {
    const html = renderTemplate({ ...BASE, articleHtml: "<p>No claim at all.</p>" })
    expect(checkMemory(html).violations).toContain("no <mark>: the claim span is required")
  })
})

describe("head stamping", () => {
  it("stamps status active and both timestamps from `at`", () => {
    const doc = parseOk(renderTemplate(BASE))
    expect(doc.metas.status).toBe("active")
    expect(doc.metas.createdAt).toBe(BASE.at)
    expect(doc.metas.updatedAt).toBe(BASE.at)
  })

  it("stamps a content hash the indexer's own recomputation agrees with", () => {
    const html = renderTemplate(BASE)
    expect(parseOk(html).metas.contentHash).toBe(contentHash(html))
  })

  it("keeps the stamped hash valid after a meta-only edit", () => {
    const html = renderTemplate(BASE)
    const doc = parseOk(html)
    expect(doc.metas.contentHash).toBe(contentHash(serializeMemory(doc)))
  })

  it("omits an unsupplied optional rather than defaulting it", () => {
    const doc = parseOk(renderTemplate(BASE))
    expect(doc.metas.confidence).toBeUndefined()
    expect(doc.metas.author).toBeUndefined()
  })

  it("hashes two inputs with the same article identically however their metas differ", () => {
    const one = renderTemplate({ ...BASE, confidence: 1, importance: 10 })
    const two = renderTemplate({ ...BASE, confidence: 0.1, importance: 1, author: "human:ada" })
    expect(one).not.toBe(two)
    expect(contentHash(two)).toBe(contentHash(one))
  })
})

describe("a task's head", () => {
  const TASK: NewMemoryInput = {
    title: "Wire the discrimination gate into sleep merge",
    claim: "The pre-merge gate is unsupplied, so a quality-degrading run can merge.",
    memoryType: "task",
    at: "2026-08-02T14:03:11Z"
  }

  it("defaults memhtml-task-status to todo, so the emitted file parses", () => {
    /**
     * The parser REFUSES a task with no `memhtml-task-status`, so the default is what keeps the
     * template's own output valid: without it every `renderTemplate({ memoryType: "task" })`
     * would produce a file the format rejects.
     */
    const html = renderTemplate(TASK)
    expect(checkMemory(html)).toEqual({ violations: [], warnings: [] })
    expect(parseOk(html).metas.taskStatus).toBe(DEFAULT_TASK_STATUS)
    expect(DEFAULT_TASK_STATUS).toBe("todo")
  })

  it("carries a caller's status and due date through", () => {
    const html = renderTemplate({ ...TASK, taskStatus: "blocked", dueAt: "2026-08-09" })
    expect(checkMemory(html)).toEqual({ violations: [], warnings: [] })
    const doc = parseOk(html)
    expect(doc.metas.taskStatus).toBe("blocked")
    expect(doc.metas.dueAt).toBe("2026-08-09")
  })

  it("stamps no task status on a non-task, even when the caller names one", () => {
    // A non-task carrying `memhtml-task-status` is a parse violation, so emitting a caller's stray
    // value would put a file in git that the indexer then skips.
    const html = renderTemplate({ ...BASE, taskStatus: "doing" })
    expect(checkMemory(html)).toEqual({ violations: [], warnings: [] })
    expect(html).not.toContain("memhtml-task-status")
  })

  it("is a serialization fixed point, so a status edit stays a one-line diff", () => {
    const html = renderTemplate({ ...TASK, dueAt: "2026-08-09" })
    expect(serializeMemory(parseOk(html))).toBe(html)
  })

  it("keeps the task metas out of the content hash", () => {
    // The hash scope is the `<article>`, so a status transition is invisible to identity — which
    // is what lets a task be updated all week without re-embedding or tripping structural dedup.
    const todo = renderTemplate(TASK)
    const doing = renderTemplate({ ...TASK, taskStatus: "doing", dueAt: "2026-08-09" })
    expect(todo).not.toBe(doing)
    expect(contentHash(doing)).toBe(contentHash(todo))
  })
})

describe("newMemoryDoc and articleHtmlFor", () => {
  it("gives newMemoryDoc the same article html articleHtmlFor computes", () => {
    expect(newMemoryDoc(BASE).article.html).toBe(articleHtmlFor(BASE))
  })

  it("leaves the extraction fields empty, since the real ones come from a read", () => {
    const doc = newMemoryDoc(BASE)
    expect(doc.article.gist).toBe("")
    expect(doc.article.facets).toEqual([])
    expect(doc.warnings).toEqual([])
  })

  it("is deterministic — the same input yields the same bytes", () => {
    expect(renderTemplate(BASE)).toBe(renderTemplate(BASE))
  })
})
