import { describe, expect, it } from "vitest"

import {
  FORMAT_MD_EXAMPLE,
  fileOfType,
  fileWith,
  fileWithStamps,
  MINIMAL_ARTICLE,
  parseErr,
  parseOk
} from "./fixtures.js"

/**
 * The extraction table of `docs/format.md`, one describe block per element. Each block asserts
 * both what the element contributes and what it must NOT contribute — an aside reaching the gist
 * or a `<pre>` body reaching the gist are the two failures that would misrepresent a memory in
 * recall, and neither is visible from a test that only checks the positive case.
 */

describe("<article> — the hash and body scope", () => {
  it("extracts all article text into bodyText", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.bodyText).toContain("drain the VIP before reverting the deploy")
    expect(doc.article.bodyText).toContain("ALB/NLB target-group deploys")
  })

  it("keeps head content out of bodyText", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    for (const headOnly of ["f7e32699", "sha256:1f4b9c", "claude-fable-5", "reversibility-first"]) {
      expect(doc.article.bodyText, headOnly).not.toContain(headOnly)
    }
    expect(doc.article.bodyText).not.toContain(doc.title)
  })

  it("separates adjacent block text so each word stays searchable", () => {
    const doc = parseOk(
      fileWith("<p><mark>A claim.</mark></p><dl><dt>Applies to</dt><dd>ALB</dd></dl>")
    )
    expect(doc.article.bodyText).toContain("Applies to ALB")
    expect(doc.article.bodyText).not.toContain("toALB")
  })

  it("does not insert a space inside a phrasing element", () => {
    const doc = parseOk(fileWith("<p><mark>Run <code>ls</code> first.</mark></p>"))
    expect(doc.article.bodyText).toBe("Run ls first.")
  })
})

describe("<mark> — the gist is the claim and only the claim", () => {
  it("extracts exactly the mark span", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.gist).toBe(
      "If a prod rollback is issued, drain the VIP before reverting the deploy."
    )
  })

  it("excludes the paragraph tail after the mark", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.gist).not.toContain("in-flight connections")
  })

  it("excludes a <code> body inside the mark but keeps it in bodyText", () => {
    const doc = parseOk(fileWith("<p><mark>Run <code>rm -rf /</code> never.</mark></p>"))
    expect(doc.article.gist).toBe("Run never.")
    expect(doc.article.bodyText).toContain("rm -rf /")
  })

  it("excludes a <pre> body inside the mark", () => {
    const doc = parseOk(fileWith("<p><mark>Do this: <pre>step one</pre> then stop.</mark></p>"))
    expect(doc.article.gist).not.toContain("step one")
  })
})

describe("<time> — event time, not write time", () => {
  it("takes the FIRST time element's datetime", () => {
    const doc = parseOk(
      fileWith(
        '<p><mark>A claim.</mark> On <time datetime="2026-07-28">July</time> and <time datetime="2026-09-01">September</time>.</p>'
      )
    )
    expect(doc.article.eventAt).toBe("2026-07-28")
  })

  it("reports the datetime attribute, never the human text", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.eventAt).toBe("2026-07-28")
    expect(doc.article.eventAt).not.toBe("July 28")
  })

  it("differs from the write-time metas, which are separate fields", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.eventAt).not.toBe(doc.metas.updatedAt)
    expect(doc.metas.createdAt).toBe("2026-08-02T14:03:11Z")
  })

  it("omits eventAt when the article names no time", () => {
    expect(parseOk(fileWith(MINIMAL_ARTICLE)).article.eventAt).toBeUndefined()
  })
})

describe("<dl>/<dt>/<dd> and <data value> — facets", () => {
  it("pairs each dd with the governing dt in document order", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.facets.map((facet) => facet.name)).toEqual(["Applies to", "Failure window"])
    expect(doc.article.facets[0]?.value).toBe("ALB/NLB target-group deploys")
  })

  it("lands a <data value> in the facet's numericValue", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.facets[1]?.numericValue).toBe(120)
    expect(doc.article.facets[1]?.value).toBe("about two minutes of pinned connections")
  })

  it("omits numericValue when the dd carries no data element", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.facets[0]?.numericValue).toBeUndefined()
  })

  it("ignores a data value that is not a number", () => {
    const doc = parseOk(
      fileWith(
        '<p><mark>A claim.</mark></p><dl><dt>N</dt><dd><data value="soon">later</data></dd></dl>'
      )
    )
    expect(doc.article.facets[0]?.numericValue).toBeUndefined()
  })

  /**
   * `Number("")` and `Number(" ")` are both `0`, and zero is a finite number, so a blank `value`
   * would store a measured quantity the file never claimed. `numericValue` is present only for a
   * `<data value>` that parses as a finite number, which a blank attribute does not.
   */
  it.each(["", " ", "\t"])("omits numericValue for a blank data value (%j)", (blank) => {
    const doc = parseOk(
      fileWith(
        `<p><mark>A claim.</mark></p><dl><dt>N</dt><dd><data value="${blank}">unstated</data></dd></dl>`
      )
    )
    expect(doc.article.facets[0]?.value).toBe("unstated")
    expect(doc.article.facets[0]?.numericValue).toBeUndefined()
    expect("numericValue" in (doc.article.facets[0] ?? {})).toBe(false)
  })

  it("takes the first data value that parses, skipping a blank one before it", () => {
    const doc = parseOk(
      fileWith(
        '<p><mark>A claim.</mark></p><dl><dt>N</dt><dd><data value=""></data><data value="42">forty-two</data></dd></dl>'
      )
    )
    expect(doc.article.facets[0]?.numericValue).toBe(42)
  })

  it("gives one facet row per dd when a dt governs several", () => {
    const doc = parseOk(
      fileWith("<p><mark>A claim.</mark></p><dl><dt>Hosts</dt><dd>a</dd><dd>b</dd></dl>")
    )
    expect(doc.article.facets).toEqual([
      { name: "Hosts", value: "a" },
      { name: "Hosts", value: "b" }
    ])
  })

  it("ignores a dd with no preceding dt", () => {
    const doc = parseOk(fileWith("<p><mark>A claim.</mark></p><dl><dd>orphan</dd></dl>"))
    expect(doc.article.facets).toEqual([])
  })
})

describe("<cite> and <q> — citations", () => {
  it("collects a cite with no href", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.citations).toEqual([{ text: "checkout-api sev2" }])
  })

  it("records a q's cite attribute as the href", () => {
    const doc = parseOk(
      fileWith('<p><mark>A claim.</mark> <q cite="/resources/rfc.html">verbatim words</q></p>')
    )
    expect(doc.article.citations).toEqual([{ text: "verbatim words", href: "/resources/rfc.html" }])
  })

  it("collects cites and quotes together in document order", () => {
    const doc = parseOk(
      fileWith('<p><mark>A claim.</mark> <cite>first</cite> <q cite="/x.html">second</q></p>')
    )
    expect(doc.article.citations.map((citation) => citation.text)).toEqual(["first", "second"])
  })
})

describe("<dfn> — concept entity promotion", () => {
  it("promotes each defined term", () => {
    const doc = parseOk(
      fileWith("<p><mark>A <dfn>drain window</dfn> is the pinned interval.</mark></p>")
    )
    expect(doc.article.definedTerms).toEqual(["drain window"])
  })

  it("collects several terms in document order", () => {
    const doc = parseOk(
      fileWith("<p><mark>A claim.</mark></p><p><dfn>alpha</dfn> and <dfn>beta</dfn>.</p>")
    )
    expect(doc.article.definedTerms).toEqual(["alpha", "beta"])
  })

  it("keeps the term in the gist when it sits inside the mark", () => {
    const doc = parseOk(fileWith("<p><mark>A <dfn>drain window</dfn> matters.</mark></p>"))
    expect(doc.article.gist).toBe("A drain window matters.")
  })
})

describe("<figure>/<figcaption> — captions are FTS-visible, code is not gist-visible", () => {
  it("collects the caption", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.captions).toEqual(["The drain command that must precede the revert."])
  })

  it("keeps the pre/code body in bodyText", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.bodyText).toContain("modify-target-group-attributes")
  })

  it("keeps the pre/code body out of the gist", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.gist).not.toContain("modify-target-group-attributes")
  })
})

describe("<details>/<summary> — the disclosure fold", () => {
  it("collects summary text, which recall always discloses", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.summaryTexts).toEqual(["How this was learned"])
  })

  it("keeps the details body searchable in bodyText", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.bodyText).toContain("Three rollbacks in July")
  })

  it("keeps the details body out of the summary list", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.summaryTexts.join(" ")).not.toContain("Three rollbacks")
  })
})

describe("<aside> — searchable but never quoted", () => {
  it("collects the aside separately so recall can refuse to quote it", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.asideTexts).toEqual([
      "Fly.io and Cloud Run drain automatically; this is AWS-target-group specific."
    ])
  })

  it("keeps the aside in bodyText, so a search still finds the caveat", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.bodyText).toContain("Fly.io and Cloud Run")
  })

  it("keeps the aside out of the gist", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.article.gist).not.toContain("Fly.io")
  })
})

describe("<abbr title> — the expansion reaches FTS", () => {
  it("collects the title", () => {
    const doc = parseOk(
      fileWith('<p><mark>The <abbr title="Virtual IP">VIP</abbr> drains first.</mark></p>')
    )
    expect(doc.article.abbreviations).toEqual(["Virtual IP"])
  })

  it("ignores an abbr with no title", () => {
    const doc = parseOk(fileWith("<p><mark>The <abbr>VIP</abbr> drains.</mark></p>"))
    expect(doc.article.abbreviations).toEqual([])
  })
})

describe("<section> and <table> — outline and tabular text", () => {
  it("treats a section as outline only, with no index effect of its own", () => {
    const doc = parseOk(fileWith("<section><p><mark>A claim.</mark></p><p>Detail.</p></section>"))
    expect(doc.article.bodyText).toBe("A claim. Detail.")
    expect(doc.warnings).toEqual([])
  })

  it("pulls table cell text into bodyText", () => {
    const doc = parseOk(
      fileWith(
        "<p><mark>A claim.</mark></p><table><caption>Delays</caption><thead><tr><th>Host</th></tr></thead><tbody><tr><td>alb-1</td></tr></tbody></table>"
      )
    )
    expect(doc.article.bodyText).toContain("Delays")
    expect(doc.article.bodyText).toContain("alb-1")
    expect(doc.warnings).toEqual([])
  })
})

describe("head metas", () => {
  it("types every meta the example carries", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.metas.memoryType).toBe("procedural")
    expect(doc.metas.status).toBe("active")
    expect(doc.metas.confidence).toBe(0.9)
    expect(doc.metas.importance).toBe(8)
    expect(doc.metas.author).toBe("agent:claude-fable-5")
    expect(doc.metas.sessionId).toBe("f7e32699-d45b-4248-8ae6-894dfc606f49")
    expect(doc.metas.promptId).toBe("pr_01JQ8")
  })

  it("reports the file's own content-hash claim verbatim, never repaired", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.metas.contentHash).toBe("sha256:1f4b9c")
  })

  it("leaves an unstated optional absent rather than substituting a default", () => {
    const doc = parseOk(fileWith(MINIMAL_ARTICLE))
    expect(doc.metas.confidence).toBeUndefined()
    expect(doc.metas.importance).toBeUndefined()
    expect("confidence" in doc.metas).toBe(false)
  })

  it("drops an out-of-range optional rather than failing the parse", () => {
    const doc = parseOk(
      fileWith(
        MINIMAL_ARTICLE,
        '<meta name="memhtml-confidence" content="1.5">\n<meta name="memhtml-importance" content="99">'
      )
    )
    expect(doc.metas.confidence).toBeUndefined()
    expect(doc.metas.importance).toBeUndefined()
  })

  /**
   * `Number("")` and `Number("   ")` are both `0`, so a blank content is the trap: a confidence of
   * 0.00 is an in-range assertion of "certainly false", not the stated-nothing the blank means.
   *
   * Both probes sit on metas whose range ADMITS zero — `confidence` is `[0, 1]` and `reprieves` is
   * `[0, MAX_SAFE_INTEGER]` — because that is the only place the blank guard is the thing under
   * test. A blank `memhtml-importance` reads as 0, which is already below its own minimum of 1, so
   * the range check drops it whether the guard exists or not and an assertion there would pass
   * against the bug.
   */
  it.each(["", " ", "   "])(
    "drops a blank numeric value (%j) rather than reading it as zero",
    (blank) => {
      const doc = parseOk(
        fileWith(
          MINIMAL_ARTICLE,
          [
            `<meta name="memhtml-confidence" content="${blank}">`,
            `<meta name="memhtml-reprieves" content="${blank}">`
          ].join("\n")
        )
      )
      expect(doc.metas.confidence).toBeUndefined()
      expect("confidence" in doc.metas).toBe(false)
      expect(doc.metas.reprieves).toBeUndefined()
      expect("reprieves" in doc.metas).toBe(false)
    }
  )

  it("drops a non-integral importance, which is an ordinal", () => {
    const doc = parseOk(fileWith(MINIMAL_ARTICLE, '<meta name="memhtml-importance" content="7.5">'))
    expect(doc.metas.importance).toBeUndefined()
  })

  it("reads every optional meta the format names", () => {
    const doc = parseOk(
      fileWith(
        MINIMAL_ARTICLE,
        [
          '<meta name="memhtml-valid-from" content="2026-01-01T00:00:00Z">',
          '<meta name="memhtml-valid-until" content="2027-01-01T00:00:00Z">',
          '<meta name="memhtml-reprieves" content="2">',
          '<meta name="memhtml-archived" content="2026-09-01T00:00:00Z">',
          '<meta name="memhtml-superseded-by" content="/areas/oncall/new.html">',
          '<meta name="memhtml-needs-revision" content="true">',
          '<meta name="memhtml-turn" content="9e0b41c2">'
        ].join("\n")
      )
    )
    expect(doc.metas.validFrom).toBe("2026-01-01T00:00:00Z")
    expect(doc.metas.validUntil).toBe("2027-01-01T00:00:00Z")
    expect(doc.metas.reprieves).toBe(2)
    expect(doc.metas.archivedAt).toBe("2026-09-01T00:00:00Z")
    expect(doc.metas.supersededBy).toBe("/areas/oncall/new.html")
    expect(doc.metas.needsRevision).toBe(true)
    expect(doc.metas.turnUuid).toBe("9e0b41c2")
  })

  it("reads the title", () => {
    expect(parseOk(FORMAT_MD_EXAMPLE).title).toBe(
      "Prod rollbacks drain the VIP before the deploy is reverted"
    )
  })

  it("drops an empty repeatable value rather than storing a blank entity", () => {
    const doc = parseOk(fileWith(MINIMAL_ARTICLE, '<meta name="memhtml-tag" content="">'))
    expect(doc.tags).toEqual([])
  })
})

/**
 * The five datetime metas share `<time datetime>`'s grammar because they share its consumer: SQL
 * compares and orders every one of them as a raw string, so an admitted value that does not sort
 * lexicographically as it sorts chronologically silently reorders a result set.
 */
describe("the datetime metas, which SQL compares as raw strings", () => {
  it("refuses a space-separated required stamp, which sorts before an EARLIER T-form instant", () => {
    // The inversion the grammar exists to make unconstructible, asserted on the strings first so
    // the test states the hazard rather than trusting the reader to see it.
    expect("2026-08-24 13:00:00Z" < "2026-08-24T12:00:00Z").toBe(true)

    const reason = parseErr(fileWithStamps("2026-08-24T13:00:00Z", "2026-08-24 13:00:00Z"))
    expect(reason).toContain('<meta name="memhtml-updated" content="2026-08-24 13:00:00Z">')
    expect(reason).toContain("is not an ISO date or datetime")
  })

  it("refuses a non-UTC offset, which sorts by its clock face rather than its instant", () => {
    const reason = parseErr(fileWithStamps("2026-08-24T13:00:00Z", "2026-08-24T13:00:00+05:00"))
    expect(reason).toContain('<meta name="memhtml-updated" content="2026-08-24T13:00:00+05:00">')
  })

  it("refuses a required stamp that is not a datetime at all", () => {
    const reason = parseErr(fileWithStamps("not a date", "2026-08-24T13:00:00Z"))
    expect(reason).toContain('<meta name="memhtml-created" content="not a date">')
  })

  it("refuses an out-of-range date on a required stamp", () => {
    expect(parseErr(fileWithStamps("2026-13-45", "2026-08-24T13:00:00Z"))).toContain(
      "memhtml-created"
    )
  })

  /**
   * A REFUSAL and not a dropped optional, which is the one place these three diverge from every
   * other malformed optional. Dropping an unsortable `memhtml-valid-until` widens the validity
   * window to always-valid, so the file answers an as-of query for instants it said the fact was
   * already dead — the drop is fail-open on stored belief, and the refusal is visible.
   */
  it.each(["memhtml-valid-from", "memhtml-valid-until", "memhtml-archived"])(
    "refuses an unsortable %s rather than dropping it",
    (name) => {
      const reason = parseErr(
        fileWith(MINIMAL_ARTICLE, `<meta name="${name}" content="2026-08-24 13:00:00Z">`)
      )
      expect(reason).toContain(`<meta name="${name}" content="2026-08-24 13:00:00Z">`)
    }
  )

  it("admits a bare calendar date, which is a prefix of every instant on its day", () => {
    const doc = parseOk(
      fileWith(
        MINIMAL_ARTICLE,
        [
          '<meta name="memhtml-valid-from" content="2026-08-24">',
          '<meta name="memhtml-valid-until" content="2027-01-01T00:00:00Z">',
          '<meta name="memhtml-archived" content="2026-09-01T00:00:00Z">'
        ].join("\n")
      )
    )
    expect(doc.metas.validFrom).toBe("2026-08-24")
    expect(doc.metas.validUntil).toBe("2027-01-01T00:00:00Z")
    expect(doc.metas.archivedAt).toBe("2026-09-01T00:00:00Z")
  })

  it("carries a stated stamp through verbatim", () => {
    const doc = parseOk(fileWithStamps("2026-08-02T00:00:00Z", "2026-08-24T13:00:00Z"))
    expect(doc.metas.createdAt).toBe("2026-08-02T00:00:00Z")
    expect(doc.metas.updatedAt).toBe("2026-08-24T13:00:00Z")
  })

  it("reports the missing-meta violation, not the grammar one, for an absent stamp", () => {
    // A meta stated badly and a meta not stated at all are different mistakes, and `checkHead`
    // already owns the second. Reporting both for one absent line would name it twice.
    const reason = parseErr(
      fileOfType("semantic").replace(
        '<meta name="memhtml-updated" content="2026-08-02T00:00:00Z">',
        ""
      )
    )
    expect(reason).toContain('missing required <meta name="memhtml-updated">')
    expect(reason).not.toContain("is not an ISO date or datetime")
  })
})

describe("the task metas, which the type governs in both directions", () => {
  it("reads a task's status and due date", () => {
    const doc = parseOk(
      fileOfType(
        "task",
        [
          '<meta name="memhtml-task-status" content="doing">',
          '<meta name="memhtml-due" content="2026-08-09">'
        ].join("\n")
      )
    )
    expect(doc.metas.memoryType).toBe("task")
    expect(doc.metas.taskStatus).toBe("doing")
    expect(doc.metas.dueAt).toBe("2026-08-09")
    // The OTHER axis is untouched: a live task is an active file like any other.
    expect(doc.metas.status).toBe("active")
  })

  it("refuses a task with no memhtml-task-status", () => {
    /**
     * A violation, not a dropped optional: a task with no lifecycle position is omitted from
     * every `memhtml task list --status` filter, so it would be invisible to the one surface that
     * exists to show it while sitting in the tree looking fine.
     */
    expect(parseErr(fileOfType("task"))).toContain("a task requires")
  })

  it("refuses memhtml-task-status on a memory that is not a task", () => {
    for (const type of ["semantic", "episodic", "arc"]) {
      expect(
        parseErr(fileOfType(type, '<meta name="memhtml-task-status" content="todo">')),
        type
      ).toContain("only a task carries one")
    }
  })

  it("refuses a status outside the closed vocabulary", () => {
    const reason = parseErr(fileOfType("task", '<meta name="memhtml-task-status" content="wip">'))
    expect(reason).toContain("outside the vocabulary")
    expect(reason).toContain("todo, doing, blocked, done")
  })

  it("refuses a memhtml-due that does not sort lexicographically with the others", () => {
    for (const due of [
      "next friday",
      "2026-13-45",
      "08/09/2026",
      "2026-08-09T25:00:00Z",
      // Real instants whose raw-string order disagrees with their chronological order.
      "2026-08-09 13:00:00Z",
      "2026-08-09T13:00:00+05:00"
    ]) {
      expect(
        parseErr(
          fileOfType(
            "task",
            [
              '<meta name="memhtml-task-status" content="todo">',
              `<meta name="memhtml-due" content="${due}">`
            ].join("\n")
          )
        ),
        due
      ).toContain("is not an ISO date or datetime")
    }
  })

  it("admits a task with no due date: not every task has a deadline", () => {
    const doc = parseOk(fileOfType("task", '<meta name="memhtml-task-status" content="todo">'))
    expect(doc.metas.dueAt).toBeUndefined()
    expect("dueAt" in doc.metas).toBe(false)
  })
})

describe("links carry the unprefixed rel and the document-reference href", () => {
  it("strips the memhtml- prefix and restores the underscore", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(doc.links).toEqual([
      { rel: "supersedes", href: "/archive/2026/areas/oncall/rollback-order.html" },
      { rel: "part_of", href: "/areas/arcs/reversibility-first.html" }
    ])
  })

  it("keeps the leading slash, which is the document-reference form", () => {
    for (const link of parseOk(FORMAT_MD_EXAMPLE).links) {
      expect(link.href.startsWith("/")).toBe(true)
    }
  })
})
