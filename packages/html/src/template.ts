import type { EdgeRel } from "@memhtml/contracts/edges"
import type { Confidence, Importance, MemoryType, TaskStatus } from "@memhtml/contracts/types"

import { detectLang } from "./detect.js"
import type { MemoryDoc } from "./document.js"
import { fencedBlockOf } from "./fences.js"
import { contentHash } from "./hash.js"
import { escapeAttribute, escapeText } from "./markup.js"
import { serializeMemory } from "./serialize.js"
import { innerHtml, parseArticleFragment } from "./tree.js"

/**
 * Build a fresh memory file from write-tool parameters.
 *
 * The write path calls this, not the serializer directly: an agent supplies a title, a claim,
 * and prose, and the template is what turns that into the `<mark>`-led first paragraph the
 * format requires. An agent that had to hand-author the `<mark>` placement would violate
 * constraint 1 regularly. A template that places it always places it correctly.
 */

/** What `memory_write` supplies. Mirrors the tool's parameters, with the format's own additions. */
export interface NewMemoryInput {
  /** The `<title>`, and the slug's source. */
  readonly title: string
  /**
   * The claim: exactly the text that becomes the one `<mark>` span and therefore `files.gist`.
   * Required, because a memory with no claim has nothing to disclose at Tier 1.
   */
  readonly claim: string
  /**
   * Prose after the claim, one paragraph per element. The claim's own paragraph is the first
   * one, so `body[0]` becomes the claim paragraph's tail rather than a second `<p>`.
   */
  readonly body?: ReadonlyArray<string> | undefined
  /**
   * Pre-authored article markup, used verbatim in place of `claim`/`body`. The escape hatch for
   * a correction that carries a `<dl>` or a `<figure>`. It must already contain its own
   * `<mark>`, so the caller owns constraint 1 when it uses this.
   */
  readonly articleHtml?: string | undefined
  readonly memoryType: MemoryType
  /** ISO-8601 UTC instant of write time. Stamps both `memhtml-created` and `memhtml-updated`. */
  readonly at: string
  readonly confidence?: typeof Confidence.Type | undefined
  readonly importance?: typeof Importance.Type | undefined
  readonly author?: string | undefined
  readonly sessionId?: string | undefined
  readonly promptId?: string | undefined
  readonly turnUuid?: string | undefined
  /** `type:name` entity references, e.g. `service:checkout-api`. */
  readonly entities?: ReadonlyArray<string> | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  /**
   * Other names this file's subject is recorded under, as `memhtml-alias` metas. A person file's
   * identity declaration, which sleep's entity resolution reads as merge evidence.
   */
  readonly aliases?: ReadonlyArray<string> | undefined
  readonly links?: ReadonlyArray<{ readonly rel: EdgeRel; readonly href: string }> | undefined
  /** Bitemporal validity of the fact. Absent means always-valid. */
  readonly validFrom?: string | undefined
  readonly validUntil?: string | undefined
  /**
   * A task's lifecycle position. Absent on a `task` defaults to {@link DEFAULT_TASK_STATUS};
   * absent on any other type stays absent, because only a task carries one.
   */
  readonly taskStatus?: TaskStatus | undefined
  /** When a task is due. An ISO date or datetime, string-ordered. */
  readonly dueAt?: string | undefined
}

/**
 * The status a new task starts in.
 *
 * Defaulted rather than required of the caller because `parseMemory` REFUSES a task with no
 * `memhtml-task-status`. A template that omitted it would render a file the format rejects, and
 * every `memhtml task add` would have to restate the obvious opening state.
 */
export const DEFAULT_TASK_STATUS: TaskStatus = "todo"

/** Drop `undefined`-valued keys so `exactOptionalPropertyTypes` sees an absent key. */
const definedOnly = <T extends Record<string, unknown>>(input: T): Partial<T> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

/**
 * A fenced block's markup: `<figure><pre><code>` with the code escaped but otherwise verbatim.
 * Indentation and blank lines are the content, and the hash rules already treat `<pre>` text
 * byte-for-byte. `class` is a constraint-3 violation and `lang=` is a BCP-47 human-language
 * attribute, so the language rides on the one attribute that is legal, semantic, and plain in
 * view-source.
 *
 * The info string wins outright. When the author named a language, {@link detectLang} does not
 * run, so no detector opinion overrides what a human wrote, even where hljs would score the
 * snippet differently. Only an UNLABELED fence is detected, and only above the eval's measured
 * threshold and inside the ported vocabulary (`detect.ts`). Otherwise the attribute stays
 * absent, because wrong metadata reaches `lang:` entities while a missing one costs nothing.
 *
 * Detection belongs HERE, on the write path, and nowhere downstream. The stamp is written into the
 * file, which is the system of record. Index rebuild reads `data-lang` back (`parse.ts`) and never
 * re-detects, so `rm index.db && rebuild` stays a pure function of the tree rather than of the
 * installed highlight.js version.
 */
const codeBlockHtml = (block: { readonly lang?: string | undefined; readonly code: string }) => {
  const named = block.lang ?? detectLang(block.code)
  const lang = named === undefined ? "" : ` data-lang="${escapeAttribute(named)}"`
  return `<figure><pre><code${lang}>${escapeText(block.code)}</code></pre></figure>`
}

/**
 * The article markup for an input: the claim wrapped in `<mark>` inside the first `<p>`, the
 * first body paragraph joined onto it as the claim's tail, and each remaining paragraph its own
 * `<p>`. Empty paragraphs are dropped rather than emitted, so a trailing blank in the tool
 * payload does not become an empty element.
 *
 * A body paragraph that is a fenced code block becomes a `<figure><pre><code>` instead of a
 * `<p>`, the one way the prose path can author real code markup. A fence is not joined onto
 * the claim's paragraph. When the first body paragraph is a fence, the claim stands alone in its
 * `<p>` and the figure follows, so the claim still leads the article (constraint 1) and code
 * stays out of the sentence.
 */
export const articleHtmlFor = (input: NewMemoryInput): string => {
  if (input.articleHtml !== undefined && input.articleHtml.trim() !== "") {
    return innerHtml(parseArticleFragment(input.articleHtml))
  }
  const paragraphs = (input.body ?? [])
    .filter((text) => text.trim() !== "")
    .map((text) => {
      const block = fencedBlockOf(text)
      return block === undefined
        ? { html: `<p>${escapeText(text.trim())}</p>`, tail: text.trim() }
        : { html: codeBlockHtml(block), tail: undefined }
    })
  const [lead, ...rest] = paragraphs
  const claim = `<mark>${escapeText(input.claim.trim())}</mark>`
  const first =
    lead?.tail === undefined ? `<p>${claim}</p>` : `<p>${claim} ${escapeText(lead.tail)}</p>`
  const following = lead === undefined || lead.tail !== undefined ? rest : [lead, ...rest]
  return innerHtml(
    parseArticleFragment([first, ...following.map((paragraph) => paragraph.html)].join("\n"))
  )
}

/**
 * A fresh `MemoryDoc` for an input, with `memhtml-content-hash` already stamped from the article the
 * template just built, so the file that reaches disk is self-consistent and the indexer's own
 * recomputation agrees with it on the first read.
 */
export const newMemoryDoc = (input: NewMemoryInput): MemoryDoc => {
  const html = articleHtmlFor(input)
  const article = parseArticleFragment(html)
  return {
    title: input.title.trim(),
    metas: {
      memoryType: input.memoryType,
      status: "active",
      createdAt: input.at,
      updatedAt: input.at,
      contentHash: contentHash(article),
      ...definedOnly({
        confidence: input.confidence,
        importance: input.importance,
        author: input.author,
        sessionId: input.sessionId,
        promptId: input.promptId,
        turnUuid: input.turnUuid,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        /**
         * Stamped only for a task, and defaulted there. A non-task carrying
         * `memhtml-task-status` is a parse violation, so emitting a caller's stray value would put
         * a file in git that the indexer then skips. It would be present in the tree, absent
         * from every search, and visible only as a log line.
         */
        taskStatus:
          input.memoryType === "task" ? (input.taskStatus ?? DEFAULT_TASK_STATUS) : undefined,
        dueAt: input.dueAt
      })
    },
    entities: input.entities ?? [],
    tags: input.tags ?? [],
    aliases: input.aliases ?? [],
    links: input.links ?? [],
    article: {
      html,
      bodyText: "",
      gist: "",
      facets: [],
      citations: [],
      definedTerms: [],
      codeLangs: [],
      summaryTexts: [],
      asideTexts: [],
      captions: [],
      abbreviations: []
    },
    warnings: []
  }
}

/**
 * A fresh memory file as bytes. The one function the write path calls. The extraction fields on
 * the intermediate doc are empty because serialization reads only `article.html`, and the real
 * extractions come back from `parseMemory` on the next read.
 */
export const renderTemplate = (input: NewMemoryInput): string =>
  serializeMemory(newMemoryDoc(input))
