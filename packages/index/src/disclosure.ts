/**
 * The recall disclosure fold: how a character budget is spent across arcs, memories, and the
 * lateral tail.
 *
 * The tiers map 1:1 onto the HTML structure rather than onto a truncation of prose (design §5,
 * format.md's `<details>` row):
 *
 * - **Tier 1** — the `<mark>` gist. The author's chosen load-bearing span, always disclosed.
 * - **Tier 2** — `<summary>` texts. The elaboration's headline, disclosed inside a full quote.
 * - **Tier 3** — the `<details>` body. Reaches an agent only through `memory_read`, never through
 *   recall: it is the "how this was learned" material, and spending a shared budget on it starves
 *   the claims of memories the agent has not seen yet.
 *
 * `<aside>` texts are never quoted in an index line. An aside is a scope caveat, so presenting it as
 * the memory would present the exception as the rule — and an index line has no room to say which
 * it is.
 */

/** An arc gets a bigger envelope than an ordinary memory: it is a synthesis of many of them. */
export const ARC_BODY_BUDGET = 9_000

/** The shared envelope for ordinary memories. */
export const MEMORY_BODY_BUDGET = 16_000

/**
 * At most two full quotes per ENTITY NAME, not per path.
 *
 * Per-path would be no cap at all: twelve memories about one service are twelve paths, and they
 * would fill the budget with one entity's history while every other entity the query touched gets
 * an index line. The cap is what makes recall breadth-first over entities.
 */
export const MAX_PER_ENTITY = 2

/** A candidate for disclosure, already ranked. */
export interface DisclosureCandidate {
  readonly path: string
  readonly title: string
  /** The `<mark>` claim. The Tier-1 line, and what an overflow entry shows. */
  readonly gist: string
  readonly memoryType: string
  /**
   * Article text WITHOUT `<details>` bodies — Tier 1 + Tier 2 only. The indexer supplies this
   * separately from `body_text` precisely so the fold cannot accidentally quote Tier 3.
   */
  readonly disclosureText: string
  /** Entity names this memory claims, for the per-entity cap. */
  readonly entityNames: ReadonlyArray<string>
}

/** A fully quoted memory. */
export interface DisclosedEntry {
  readonly path: string
  readonly title: string
  readonly gist: string
  readonly memoryType: string
  readonly body: string
}

/** A memory that did not fit: its claim and its path, so the agent can drill down deliberately. */
export interface IndexLine {
  readonly path: string
  readonly title: string
  readonly gist: string
  readonly memoryType: string
}

/** What one budget produced. */
export interface DisclosureFold {
  readonly disclosed: ReadonlyArray<DisclosedEntry>
  readonly indexLines: ReadonlyArray<IndexLine>
  /** Characters of quoted body actually spent. Never exceeds the budget. */
  readonly spentChars: number
  /** True when at least one candidate became an index line instead of a quote. */
  readonly truncated: boolean
}

/** `arc` memories take {@link ARC_BODY_BUDGET}; everything else takes {@link MEMORY_BODY_BUDGET}. */
export const budgetFor = (memoryType: string): number =>
  memoryType === "arc" ? ARC_BODY_BUDGET : MEMORY_BODY_BUDGET

/**
 * Fold ranked candidates into quotes and index lines under one character budget.
 *
 * Rank order is authoritative: a candidate is never promoted past a better-ranked one to make it
 * fit. A candidate that does not fit becomes an index line and the fold CONTINUES — a later,
 * shorter candidate can still be quoted, because the budget is a character budget and not a
 * position cut-off. Without that, one long memory in the middle of the list would silently truncate
 * every shorter one after it.
 *
 * `maxPerEntity` applies to full quotes only. A capped memory still gets its index line, so the
 * cap narrows depth rather than dropping the memory.
 */
export const foldDisclosure = (
  candidates: ReadonlyArray<DisclosureCandidate>,
  budgetChars: number,
  maxPerEntity: number = MAX_PER_ENTITY
): DisclosureFold => {
  const disclosed: Array<DisclosedEntry> = []
  const indexLines: Array<IndexLine> = []
  const perEntity = new Map<string, number>()
  let spentChars = 0

  for (const candidate of candidates) {
    const line: IndexLine = {
      path: candidate.path,
      title: candidate.title,
      gist: candidate.gist,
      memoryType: candidate.memoryType
    }

    /**
     * Deduplicated per candidate. One memory counts ONCE against a name however many times it claims
     * it — and it can claim one twice, because the cap is keyed on the entity NAME while
     * `file_entities` is keyed on `(type, name)`: `person:sanju` and `concept:sanju` are two rows
     * with one name. Counting both would let a single memory exhaust the cap by itself and push every
     * other memory about that entity into an index line.
     */
    const names = new Set(candidate.entityNames)
    const cappedEntity = [...names].some((name) => (perEntity.get(name) ?? 0) >= maxPerEntity)
    const body = candidate.disclosureText
    if (cappedEntity || spentChars + body.length > budgetChars) {
      indexLines.push(line)
      continue
    }

    disclosed.push({ ...line, body })
    spentChars += body.length
    for (const name of names) {
      perEntity.set(name, (perEntity.get(name) ?? 0) + 1)
    }
  }

  return { disclosed, indexLines, spentChars, truncated: indexLines.length > 0 }
}
