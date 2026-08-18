import { PEOPLE_DIR } from "@memhtml/contracts/paths"
import { slugify } from "@memhtml/contracts/slug"

import {
  type ClaimText,
  DIVERGENCE_FAMILIES,
  type DivergenceFamily,
  deriveControl,
  type VariantOptions
} from "./controls.js"

/**
 * The fixture corpus, as a pure specification.
 *
 * Pure and seeded, so the same seed yields byte-identical files on any machine. A fixture the
 * discrimination gate runs against exists so that a change in the numbers means a change in the
 * RANKING and not a change in the corpus. Nothing here reads a clock, a filesystem, or an environment
 * variable, and `fixture.ts` is the only module that writes.
 *
 * No real transcript, no real memory, no `~/.claude` content. Every fact below is invented about
 * invented services.
 */

/** One memory to write, before it becomes HTML. */
export interface MemorySpec {
  readonly path: string
  readonly title: string
  /** The sentence the memory turns on. It becomes the `<mark>` span and therefore `files.gist`. */
  readonly claim: string
  readonly body: ReadonlyArray<string>
  readonly memoryType: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly confidence: number
  readonly importance: number
  readonly entities: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly links: ReadonlyArray<{ readonly rel: string; readonly href: string }>
  /** Extra article markup after the claim paragraph, the element kit this memory exercises. */
  readonly extras: ReadonlyArray<string>
  /** Set on the archived members, which carry `memhtml-status: archived` and a `memhtml-archived` stamp. */
  readonly archivedAt?: string | undefined
  readonly validUntil?: string | undefined
  readonly sessionId?: string | undefined
}

/**
 * One discrimination probe: a query, the memory that answers it, and the near-twins that do not.
 *
 * `controlPaths` are ordered by family so a failure names the axis. Each control is validated
 * against its OWN family's divergence predicate at generation time. See `controls.ts`.
 */
export interface Probe {
  readonly query: string
  readonly targetPath: string
  readonly controlPaths: ReadonlyArray<string>
  readonly families: ReadonlyArray<DivergenceFamily>
}

/**
 * One memory's durable access bookkeeping, held as a `state.access` row.
 *
 * Part of the SPEC rather than something the harness invents, because the salience arm reads this plane
 * and a fixture whose state plane is empty cannot measure that arm at all. Seeded and query-blind, so
 * the spread is a function of the corpus seed and nothing here consults the probe list.
 */
export interface AccessSpec {
  readonly path: string
  /** A quantity, per-memory lifetime, 0-based. */
  readonly accessCount: number
  readonly reinforcementCount: number
  /** Unitless in `[-1, 1]`. */
  readonly outcomeScore: number
  readonly lastAccessedAt: string
}

/** The whole fixture: the memories to write, their access history, and the probes. */
export interface CorpusSpec {
  readonly memories: ReadonlyArray<MemorySpec>
  /** `state.access` rows the harness seeds before running the probes. */
  readonly access: ReadonlyArray<AccessSpec>
  readonly probes: ReadonlyArray<Probe>
  readonly seed: number
}

/** The default seed. Named so a caller changing it is making a visible choice. */
export const DEFAULT_SEED = 20_260_802

/**
 * mulberry32. A 32-bit PRNG whose whole state is one integer, so the generator is reproducible
 * across node versions. `Math.random` is unseedable, and a hash-derived index would couple the
 * corpus's shape to a digest's internals.
 */
const rng = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** One invented service and the vocabulary its memories are written in. */
interface Topic {
  readonly service: string
  readonly area: string
  readonly workspace: string
  readonly tags: ReadonlyArray<string>
  /** A noun the variant-family flip inserts its qualifier after. */
  readonly variantAnchor: string
  readonly nouns: ReadonlyArray<string>
  readonly verbs: ReadonlyArray<string>
}

/**
 * Twelve topics with deliberately disjoint vocabularies.
 *
 * The vocabularies are disjoint because the deterministic embedder is a bag of words. Two topics
 * sharing nouns would put unrelated memories inside a probe's candidate window, and the gate would
 * then measure vocabulary overlap rather than discrimination.
 */
const TOPICS: ReadonlyArray<Topic> = [
  {
    service: "checkout-api",
    area: "oncall",
    workspace: "checkout-api",
    tags: ["deploy", "oncall"],
    variantAnchor: "target group",
    nouns: ["rollback", "target group", "connection drain", "deploy revert", "load balancer"],
    verbs: ["drains", "reverts", "deregisters"]
  },
  {
    service: "metrics-agent",
    area: "observability",
    workspace: "metrics-agent",
    tags: ["observability", "telemetry"],
    variantAnchor: "collector",
    nouns: ["exporter scrape", "collector flush", "local buffer", "scrape interval", "cardinality"],
    verbs: ["scrapes", "flushes", "buffers"]
  },
  {
    service: "payments-gateway",
    area: "compliance",
    workspace: "payments-gateway",
    tags: ["payments", "compliance"],
    variantAnchor: "settlement lane",
    nouns: ["settlement lane", "chargeback window", "idempotency key", "capture step", "ledger"],
    verbs: ["settles", "captures", "reconciles"]
  },
  {
    service: "auth-service",
    area: "identity",
    workspace: "auth-service",
    tags: ["identity", "security"],
    variantAnchor: "signing key",
    nouns: ["signing key", "token rotation", "refresh grant", "session cookie", "audience claim"],
    verbs: ["rotates", "revokes", "issues"]
  },
  {
    service: "search-index",
    area: "retrieval",
    workspace: "search-index",
    tags: ["search", "indexing"],
    variantAnchor: "shard",
    nouns: ["shard rebuild", "analyzer chain", "stopword list", "segment merge", "query planner"],
    verbs: ["reindexes", "merges", "analyzes"]
  },
  {
    service: "batch-loader",
    area: "pipelines",
    workspace: "batch-loader",
    tags: ["pipeline", "throughput"],
    variantAnchor: "worker pool",
    nouns: ["backpressure", "worker pool", "chunk size", "commit fence", "dead letter"],
    verbs: ["throttles", "commits", "replays"]
  },
  {
    service: "notification-worker",
    area: "delivery",
    workspace: "notification-worker",
    tags: ["delivery", "retries"],
    variantAnchor: "retry queue",
    nouns: ["retry queue", "delivery receipt", "bounce handling", "quiet hours", "digest window"],
    verbs: ["retries", "suppresses", "batches"]
  },
  {
    service: "schema-migrator",
    area: "database",
    workspace: "schema-migrator",
    tags: ["migrations", "database"],
    variantAnchor: "migration ledger",
    nouns: ["migration ledger", "advisory lock", "column backfill", "rollback script", "dry run"],
    verbs: ["applies", "locks", "backfills"]
  },
  {
    service: "cdn-edge",
    area: "caching",
    workspace: "cdn-edge",
    tags: ["caching", "latency"],
    variantAnchor: "edge node",
    nouns: ["cache invalidation", "edge node", "stale-while-revalidate", "purge fanout", "origin"],
    verbs: ["invalidates", "purges", "revalidates"]
  },
  {
    service: "feature-flags",
    area: "rollout",
    workspace: "feature-flags",
    tags: ["rollout", "experiments"],
    variantAnchor: "cohort",
    nouns: ["cohort", "kill switch", "sticky bucket", "exposure event", "ramp step"],
    verbs: ["ramps", "buckets", "exposes"]
  },
  {
    service: "cost-explorer",
    area: "finops",
    workspace: "cost-explorer",
    tags: ["finops", "budgets"],
    variantAnchor: "budget alarm",
    nouns: [
      "budget alarm",
      "amortized spend",
      "tag allocation",
      "reservation coverage",
      "forecast"
    ],
    verbs: ["allocates", "forecasts", "amortizes"]
  },
  {
    service: "incident-review",
    area: "practice",
    workspace: "incident-review",
    tags: ["practice", "postmortem"],
    variantAnchor: "timeline entry",
    nouns: [
      "timeline entry",
      "contributing factor",
      "action item",
      "blameless framing",
      "severity"
    ],
    verbs: ["records", "assigns", "reviews"]
  }
]

/** The nine storage types. `arc` is here because the fixture writes files directly, as sleep does. */
const TYPES: ReadonlyArray<string> = [
  "episodic",
  "semantic",
  "procedural",
  "agent_insight",
  "user_preference",
  "error_pattern",
  "verdict",
  "precedent",
  "arc"
]

/** The invented people. Four person files, each reachable by a `person:` entity. */
const PEOPLE: ReadonlyArray<{
  readonly slug: string
  readonly name: string
  readonly role: string
}> = [
  { slug: "sanju", name: "Sanju", role: "runs the payments on-call rotation" },
  { slug: "imani", name: "Imani", role: "owns the search relevance surface" },
  { slug: "dara", name: "Dara", role: "keeps the migration ledger honest" },
  { slug: "wren", name: "Wren", role: "reviews every incident timeline" }
]

/** Words a probe query drops. A query is what an agent types rather than the claim pasted back. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "before",
  "by",
  "do",
  "does",
  "each",
  "every",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "must",
  "of",
  "on",
  "once",
  "only",
  "or",
  "so",
  "than",
  "that",
  "the",
  "then",
  "this",
  "to",
  "under",
  "was",
  "were",
  "when",
  "which",
  "will",
  "with"
])

/**
 * A probe query holds the target's own content words, in order, capped.
 *
 * Content words rather than the claim verbatim, and the query design decides what the probe can
 * measure. A NUMERIC-family control differs from its target in exactly one numeric token, so a
 * query that dropped the number would have identical overlap with both and the vector arm could
 * not order them at all. The probe would measure a tie-break instead. Keeping the digits is what
 * makes the numeric family a probe rather than a coin toss. The same reasoning keeps a variant
 * qualifier's ANCHOR in the query while the qualifier itself, which only the control carries,
 * stays out.
 *
 * Stopwords go so that `not` cannot hide behind them. A query carrying the target's function words
 * would raise the negation control's lexical overlap for a reason unrelated to the fact either
 * states.
 */
export const queryFor = (spec: MemorySpec, limit = 12): string =>
  (spec.claim.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, limit)
    .join(" ")

/** A memory's slug-derived path inside a directory. */
const pathIn = (directory: string, title: string): string => `${directory}/${slugify(title)}.html`

/** An ISO-8601 UTC second, from a day offset against the corpus's fixed epoch. */
const at = (dayOffset: number, hour = 9): string => {
  const millis = Date.UTC(2026, 0, 1, hour, 0, 0) + dayOffset * 86_400_000
  return `${new Date(millis).toISOString().slice(0, 19)}Z`
}

/** A calendar date `YYYY-MM-DD` from the same epoch, for a `<time datetime>` attribute. */
const eventDate = (dayOffset: number): string => at(dayOffset).slice(0, 10)

/**
 * The element kits, one per index modulo their count, so a generated corpus exercises every element
 * `docs/format.md` gives indexer semantics to.
 *
 * Each kit returns markup that follows the claim paragraph. None of them contains a `<mark>`, because
 * the claim leads the article and constraint 5 forbids one inside an `<aside>` or `<details>`.
 */
const KITS: ReadonlyArray<(topic: Topic, ordinal: number) => ReadonlyArray<string>> = [
  // `<time datetime>`, the event the fact is about, which the recency arm ranks on.
  (topic, ordinal) => [
    `<p>Observed on <time datetime="${eventDate(ordinal % 300)}">the ${topic.service} rotation</time>` +
      ` while the ${topic.nouns[0] ?? "surface"} was under load.</p>`
  ],
  // `<dl>`/`<dt>`/`<dd>` with a `<data value>`, the facet rows, one with a numeric value.
  (topic, ordinal) => [
    "<dl>",
    `<dt>Applies to</dt><dd>${topic.service}</dd>`,
    `<dt>Window</dt><dd><data value="${60 + (ordinal % 7) * 30}">about ` +
      `${1 + (ordinal % 7)} minutes</data> of exposure</dd>`,
    "</dl>"
  ],
  // `<cite>` and `<q cite>`, the citation rows, one with a source URI.
  (topic, ordinal) => [
    `<p>Recorded against <cite>${topic.service} sev${1 + (ordinal % 3)}</cite>, which noted ` +
      `<q cite="/areas/${topic.area}/index.html">the ${topic.nouns[1] ?? "surface"} was the ` +
      `contributing factor</q>.</p>`
  ],
  // `<dfn>`, which the indexer promotes to a `concept:` entity.
  (topic) => [
    `<p>A <dfn>${topic.nouns[2] ?? "quiet window"}</dfn> is the interval in which ` +
      `${topic.service} ${topic.verbs[0] ?? "settles"} without operator involvement.</p>`
  ],
  // `<figure>`/`<pre><code>`/`<figcaption>`, body text and a caption, excluded from the gist.
  (topic) => [
    "<figure>",
    `<pre><code>memhtml search "${topic.service} ${topic.nouns[0] ?? "surface"}"</code></pre>`,
    `<figcaption>How the ${topic.service} runbook is found again.</figcaption>`,
    "</figure>"
  ],
  // `<details>`/`<summary>`, Tier 3 provenance. The summary discloses, the body does not.
  (topic) => [
    "<details>",
    `<summary>How this was learned about ${topic.service}</summary>`,
    `<p>Three consecutive ${topic.nouns[3] ?? "incidents"} replayed the same shape before anyone ` +
      "wrote it down.</p>",
    "</details>"
  ],
  // `<aside>`, a scope caveat, searchable but never quoted in a recall line.
  (topic) => [
    "<aside>",
    `<p>Managed platforms handle this for you; the note is ${topic.service}-specific.</p>`,
    "</aside>"
  ],
  // `<table>` and `<abbr title>`, tabular facts plus an expansion into FTS.
  (topic, ordinal) => [
    "<table>",
    `<caption>${topic.service} thresholds</caption>`,
    "<thead><tr><th>Signal</th><th>Threshold</th></tr></thead>",
    `<tbody><tr><td><abbr title="time to first byte">TTFB</abbr></td>` +
      `<td>${100 + (ordinal % 9) * 25} ms</td></tr></tbody>`,
    "</table>"
  ],
  // `<section>`, `<ul>`, `<strong>`/`<em>`, and an `<a href>`, the ordinary prose vocabulary.
  (topic) => [
    "<section>",
    `<p><strong>Order matters.</strong> The ${topic.nouns[4] ?? "surface"} is <em>always</em> ` +
      "settled first.</p>",
    "<ul>",
    `<li>Confirm the ${topic.nouns[0] ?? "surface"} is quiet.</li>`,
    `<li>Then let ${topic.service} <a href="/areas/${topic.area}/index.html">proceed</a>.</li>`,
    "</ul>",
    "</section>"
  ]
]

/**
 * The article markup for a spec: the claim paragraph, the first body paragraph joined onto it, then
 * the remaining paragraphs and the element kit.
 *
 * Written here rather than left to `renderTemplate`'s claim/body path because the kits carry real
 * markup, and `renderTemplate` escapes its `body` strings as text. That is correct for a tool
 * parameter and wrong for a `<dl>`.
 */
export const articleFor = (spec: MemorySpec): string => {
  const [lead, ...rest] = spec.body
  const first =
    lead === undefined
      ? `<p><mark>${spec.claim}</mark></p>`
      : `<p><mark>${spec.claim}</mark> ${lead}</p>`
  return [first, ...rest.map((text) => `<p>${text}</p>`), ...spec.extras].join("\n")
}

/**
 * A claim built from a topic and an ordinal.
 *
 * **Distinct per ordinal, and the gate requires that.** The topic list, the type list, the noun list,
 * and the verb list all cycle, so `(topic, type, noun, verb)` repeats every lcm(12, 9, 5, 3) = 180
 * ordinals, and a corpus of 200 therefore held 20 pairs of memories asserting the SAME claim in
 * different directories. A probe's query is derived from its target's claim, so a shared claim means
 * the query identifies two memories equally well. The twin outranks the target on recency about half
 * the time, and the probe reports an inversion that says nothing about the control it was built to
 * test. Measured on the first generated 200: the twin took fused rank 1 and the target rank 8 on the
 * probe that surfaced it.
 *
 * `scopeFor` disambiguates them with a per-ordinal environment noun spliced into the claim, so two
 * ordinals a multiple of 180 apart state facts about different environments. It carries no digit, so
 * the numeric divergence family still compares exactly the quantity the claim asserts.
 */
const claimFor = (topic: Topic, type: string, ordinal: number): string => {
  const noun = topic.nouns[nounIndexOf(ordinal, topic.nouns.length)] ?? "surface"
  const verb = topic.verbs[ordinal % topic.verbs.length] ?? "settles"
  const scope = scopeFor(ordinal)
  switch (type) {
    case "episodic":
      return `On the ${topic.service} ${scope} rotation the ${noun} ${verb} ${2 + (ordinal % 5)} times before the alarm cleared.`
    case "procedural":
      return `Settle the ${noun} on ${topic.service} ${scope} before the ${topic.variantAnchor} is touched.`
    case "error_pattern":
      return `A ${topic.service} ${scope} ${noun} that ${verb} twice in ${5 + (ordinal % 4)} minutes is the failure signature.`
    case "user_preference":
      return `The operator wants ${topic.service} ${scope} ${noun} reports batched into ${1 + (ordinal % 3)} digest per day.`
    case "agent_insight":
      return `Reading the ${topic.service} ${scope} ${noun} first cuts the investigation to ${2 + (ordinal % 4)} steps.`
    case "verdict":
      return `The ${topic.service} ${scope} ${noun} was judged safe at a ramp of ${10 + (ordinal % 5) * 10} percent.`
    case "precedent":
      return `The ${topic.service} ${scope} ${noun} decision from sev${1 + (ordinal % 3)} governs every later ${topic.variantAnchor}.`
    case "arc":
      return `Across ${3 + (ordinal % 4)} incidents the ${topic.service} ${scope} ${noun} was reversible only while the ${topic.variantAnchor} stayed quiet.`
    default:
      return `The ${topic.service} ${scope} ${noun} ${verb} once every ${1 + (ordinal % 6)} intervals.`
  }
}

/**
 * The noun index for an ordinal, from the ordinal's own `(topic, type)` LANE rather than from the
 * ordinal directly.
 *
 * **`ordinal % nouns.length` cycles in lockstep with the topic and type lists, which is what produced
 * the corpus's twin problem.** Topic cycles at 12 and type at 9, so a given `(topic, type)` pair
 * recurs every 36 ordinals. With the noun taken as `ordinal % 5` the SAME noun returns every
 * lcm(36, 5) = 180. Two memories then share their entire subject, same service, same type, same noun,
 * and differ only in the scope word and the body's letter code. A probe query built from one of them
 * matches both, and the twin took fused rank 1 while the target sat at 3 or 4 on EVERY probe. The
 * controls were still correctly ranked below the target, so this was not an inversion. It was a
 * fixture that cannot measure rank 1, which caps MRR near 0.25 no matter how well retrieval works.
 *
 * Dividing by the `(topic, type)` cycle length advances the noun once per LANE visit instead, so the
 * fifth `checkout-api`/`procedural` memory gets the fifth noun. The full tuple then repeats only after
 * 36 x 5 = 180 lane visits, which is 6,480 ordinals, far past any corpus this generates.
 */
const nounIndexOf = (ordinal: number, nounCount: number): number =>
  nounCount === 0 ? 0 : Math.floor(ordinal / (TOPICS.length * TYPES.length)) % nounCount

/**
 * A per-ordinal environment noun, such as `staging`, `canary`, or `frankfurt`.
 *
 * Digit-free, so a `numeric` control still differs from its target by exactly the quantity the claim
 * asserts and by nothing else. This is a second axis of distinction alongside {@link nounIndexOf}. 23
 * is coprime with both 12 and 9, so the scope word advances on every ordinal without re-synchronizing
 * with the topic or type cycle.
 */
const scopeFor = (ordinal: number): string => {
  const scopes = [
    "staging",
    "canary",
    "frankfurt",
    "singapore",
    "dublin",
    "ohio",
    "sandbox",
    "preprod",
    "shadow",
    "primary",
    "failover",
    "dr",
    "internal",
    "partner",
    "regulated",
    "trial",
    "legacyfleet",
    "greenfleet",
    "bluefleet",
    "edgefleet",
    "batchfleet",
    "streamfleet",
    "coldfleet"
  ] as const
  return scopes[ordinal % scopes.length] as string
}

/**
 * A base-26 letter code for an ordinal, running `a`, `b`, … `z`, `ba`, `bb`, and so on.
 *
 * Letters rather than digits, because the code lands in the body and the numeric divergence family
 * compares numeric TOKEN SETS over the whole text. A digit here would put an incidental number on both
 * sides of every pair, and a `numeric` control would then be distinguishable by a token unrelated to
 * the quantity the claim states.
 */
const letterCode = (ordinal: number): string => {
  let value = ordinal
  let out = ""
  do {
    out = String.fromCharCode(97 + (value % 26)) + out
    value = Math.floor(value / 26)
  } while (value > 0)
  return out
}

/**
 * Body paragraphs. Deliberately free of `no`/`not`/`fail`. See {@link PROBE_TYPES}.
 *
 * **The last sentence carries a per-ordinal code, and it is what makes every article distinct.** The
 * content hash's scope is `<article>` alone, so a title is not part of it, and the claim is a function
 * of `(topic, type, ordinal mod k)` for several small `k`. Two ordinals a common multiple apart
 * therefore produce IDENTICAL article text under different titles. `files_content_hash_active` is a
 * partial UNIQUE index, so the second such memory cannot be indexed at all. The whole `writeAll` batch
 * fails and the corpus never reaches the gate. Measured on the first generated 200: 17 colliding pairs
 * at ordinals 180 apart.
 *
 * A code rather than widening the claim vocabulary, because a probe query is derived from the claim.
 * Pushing the distinguisher into the claim would put a token unique to one memory into the query that
 * is supposed to discriminate it from its controls, which the controls copy, and the probe would then
 * be measuring a shared unique token.
 */
const bodyFor = (topic: Topic, ordinal: number): ReadonlyArray<string> => {
  const noun = topic.nouns[(ordinal + 1) % topic.nouns.length] ?? "surface"
  return [
    `The ${noun} stays consistent while ${topic.service} holds the ${topic.variantAnchor} steady.`,
    `Operators reach for this whenever a ${topic.area} question arrives mid-rotation.`,
    `Filed under rotation note ${letterCode(ordinal)} of the ${topic.area} log.`
  ]
}

/** The directory a spec lands in, following design §2.1's placement rules. */
const directoryFor = (topic: Topic, type: string, ordinal: number): string => {
  if (type === "arc") return "areas/arcs"
  if (type === "episodic" || type === "error_pattern") return `projects/${topic.workspace}`
  if (type === "procedural" || type === "verdict") return `areas/${topic.area}`
  if (type === "semantic" || type === "precedent") return `resources/${topic.tags[0] ?? "general"}`
  return ordinal % 2 === 0 ? `projects/${topic.workspace}` : `areas/${topic.area}`
}

/**
 * The types a probe target may have.
 *
 * `procedural` and `semantic` only, from finding #33. `negationDivergent` is a marker-PRESENCE check
 * over the whole text, so a target whose body already says `no`, `not`, `fails`, or `invalid` puts a
 * marker on BOTH sides of the pair and the polarity flip becomes invisible to the predicate that
 * defines the family. The claims and bodies these two types generate are affirmative by construction.
 * {@link buildProbes} still re-checks each pair through `deriveControl`, so a future edit that
 * smuggles a marker into a body drops the control rather than shipping a paraphrase dressed as an
 * adversary.
 */
const PROBE_TYPES: ReadonlyArray<string> = ["procedural", "semantic"]

/**
 * A control's own title, so its `fts_text` differs from its target's as a real file's would.
 *
 * **The family marker LEADS the title, and that placement decides the tie-break.** The title is the
 * slug and the slug is the filename, so a trailing marker made every control's path an extension of
 * its target's stem, `…-110-qualified-variant.html` against `…-110.html`. `-` (0x2D) sorts before
 * `.` (0x2E), so the control's path sorted before its target's on EVERY pair.
 *
 * That matters because RRF produces **exact** score ties, and the fold breaks them on `path ASC`
 * (design §5, deliberately, so the ordering is total and reproducible). Two documents that swap
 * positions across two equal-weight arms sum identically, measured here at 0.03252247 for both the
 * target (fts 1, vector 2) and its variant control (fts 2, vector 1). With a trailing marker the
 * tie-break went to the CONTROL every time, a systematic loss decided by filename punctuation.
 *
 * Leading the marker makes the ordering depend on the marker word against the target's first word,
 * which is arbitrary per pair rather than adverse. That is the relationship a real corpus has, where a
 * memory and its near-twin carry unrelated titles. It is deliberately not tuned the other way, because
 * a fixture that guaranteed the target won every tie would be a fixture arranged to pass.
 */
const controlTitleFor = (targetTitle: string, family: DivergenceFamily): string => {
  switch (family) {
    case "negation":
      return `Refuted reading — ${targetTitle}`
    case "numeric":
      return `Restated quantity — ${targetTitle}`
    case "variant":
      return `Qualified variant — ${targetTitle}`
  }
}

/**
 * Build the base corpus: `count` memories spread across the twelve topics and the nine types, plus
 * the person files.
 *
 * The seeded PRNG decides only the JITTER, meaning confidence, importance, which memories carry a TTL,
 * and the day offsets. Placement and vocabulary are functions of the ordinal, which keeps a corpus
 * legible: the fifth `checkout-api` memory is always the fifth `checkout-api` memory.
 */
const buildBase = (count: number, seed: number): ReadonlyArray<MemorySpec> => {
  const next = rng(seed)
  const specs: Array<MemorySpec> = []

  for (const person of PEOPLE) {
    specs.push({
      path: `${PEOPLE_DIR}/${person.slug}.html`,
      title: person.name,
      claim: `${person.name} ${person.role}.`,
      body: [`Reach ${person.name} through the rotation channel rather than by direct message.`],
      memoryType: "semantic",
      createdAt: at(1),
      updatedAt: at(1),
      confidence: 0.95,
      importance: 6,
      entities: [`person:${person.slug}`],
      tags: ["people"],
      links: [],
      extras: [`<address>${person.name} — rotation channel</address>`]
    })
  }

  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const topic = TOPICS[ordinal % TOPICS.length] as Topic
    const type = TYPES[ordinal % TYPES.length] as string
    const day = 30 + (ordinal % 240)
    const claim = claimFor(topic, type, ordinal)
    const title = titleFor(topic, type, ordinal)
    const kit = KITS[ordinal % KITS.length] as (typeof KITS)[number]
    const jitter = next()

    specs.push({
      path: pathIn(directoryFor(topic, type, ordinal), title),
      title,
      claim,
      body: bodyFor(topic, ordinal),
      memoryType: type,
      createdAt: at(day),
      updatedAt: at(day + (jitter > 0.7 ? 3 : 0)),
      confidence: 0.6 + Math.round(jitter * 40) / 100,
      importance: 1 + Math.floor(jitter * 10),
      entities: [
        `service:${topic.service}`,
        ...(jitter > 0.8
          ? [`person:${(PEOPLE[ordinal % PEOPLE.length] as { slug: string }).slug}`]
          : [])
      ],
      tags: topic.tags,
      links: [],
      extras: kit(topic, ordinal),
      ...(jitter > 0.9 ? { validUntil: at(day + 400) } : {}),
      ...(ordinal % 17 === 0 ? { sessionId: sessionIdFor(ordinal) } : {})
    })
  }

  return specs
}

/**
 * A memory's title. Distinct per ordinal, because the slug, and therefore the path, is the id.
 *
 * It uses the same noun the claim uses, through {@link nounIndexOf}, so the title and the claim name
 * one subject. `title` is the first field of `fts_text`, and a title naming a different noun than the
 * claim would put a term into the lexical arm that the memory does not assert.
 */
const titleFor = (topic: Topic, type: string, ordinal: number): string => {
  const noun = topic.nouns[nounIndexOf(ordinal, topic.nouns.length)] ?? "surface"
  return `${topic.service} ${noun} ${scopeFor(ordinal)} ${type.replace("_", " ")} ${ordinal}`
}

/** A synthetic session uuid. Shaped like a real one and derived from the ordinal, so reproducible. */
const sessionIdFor = (ordinal: number): string => {
  const hex = (ordinal + 0x1000).toString(16).padStart(4, "0")
  return `${hex}${hex}-${hex}-4${hex.slice(1)}-8${hex.slice(1)}-${hex}${hex}${hex}`
}

/**
 * Authored edges, added after every path is known so no href can dangle.
 *
 * Dangling is the failure `memhtml doctor` exists to report, so a fixture that shipped one would make the
 * "doctor clean on the fixture" criterion unmeetable. An edge invented against a path that was never
 * written also proves nothing about the edge encoding.
 */
const withEdges = (specs: ReadonlyArray<MemorySpec>): ReadonlyArray<MemorySpec> => {
  const arcs = specs.filter((spec) => spec.memoryType === "arc").map((spec) => spec.path)
  const people = specs.filter((spec) => spec.path.startsWith(PEOPLE_DIR)).map((spec) => spec.path)
  const others = specs.filter(
    (spec) => spec.memoryType !== "arc" && !spec.path.startsWith(PEOPLE_DIR)
  )

  /** One rel per residue class, so every memory rel and both person rels appear in the corpus. */
  const rels = [
    "memhtml-relates-to",
    "memhtml-caused-by",
    "memhtml-leads-to",
    "memhtml-example-of",
    "memhtml-supports",
    "memhtml-laterally-related",
    "memhtml-contradicts"
  ] as const

  const byPath = new Map(specs.map((spec) => [spec.path, spec]))
  const additions = new Map<string, Array<{ readonly rel: string; readonly href: string }>>()
  const add = (path: string, rel: string, href: string): void => {
    if (path === href) return
    const list = additions.get(path) ?? []
    if (list.some((entry) => entry.rel === rel && entry.href === `/${href}`)) return
    list.push({ rel, href: `/${href}` })
    additions.set(path, list)
  }

  others.forEach((spec, index) => {
    // Every fourth memory is part of an arc, which is what gives the arc plane inbound structure.
    if (index % 4 === 0 && arcs.length > 0) {
      add(spec.path, "memhtml-part-of", arcs[index % arcs.length] as string)
    }
    // A memory-class edge to the next memory in the same topic band.
    const partner = others[(index + TOPICS.length) % others.length]
    if (partner !== undefined) {
      add(spec.path, rels[index % rels.length] as string, partner.path)
    }
    // A person edge for the memories that name a person, so the person plane is reachable.
    if (spec.entities.some((entity) => entity.startsWith("person:")) && people.length > 0) {
      const slug = spec.entities.find((entity) => entity.startsWith("person:"))?.slice(7) ?? ""
      const personPath = people.find((path) => path.endsWith(`/${slug}.html`))
      if (personPath !== undefined) add(spec.path, "memhtml-about-person", personPath)
    }
    if (index % 11 === 0 && people.length > 0) {
      add(spec.path, "memhtml-authored-by", people[index % people.length] as string)
    }
  })

  return [...byPath.values()].map((spec) => {
    const extra = additions.get(spec.path) ?? []
    return extra.length === 0 ? spec : { ...spec, links: [...spec.links, ...extra] }
  })
}

/**
 * The archived tier: a copy of every `count`-th memory moved under `archive/<YYYY>/`, superseded by
 * a live memory that points at it.
 *
 * Archived entries are exempt from the active content-hash unique index, so the archived copy states
 * an EARLIER version of the fact rather than the same one. That is also what gives the supersedes edge
 * something to mean.
 */
const withArchive = (specs: ReadonlyArray<MemorySpec>): ReadonlyArray<MemorySpec> => {
  const live = specs.filter(
    (spec) => spec.memoryType === "procedural" && !spec.path.startsWith("archive/")
  )
  const archived: Array<MemorySpec> = []
  const superseding = new Map<string, string>()

  live.forEach((spec, index) => {
    if (index % 6 !== 0) return
    const originalPath = spec.path.replace(
      /\/([^/]+)\.html$/,
      (_all, stem: string) => `/${stem}-earlier.html`
    )
    const archivePath = `archive/2025/${originalPath}`
    archived.push({
      ...spec,
      path: archivePath,
      title: `${spec.title} (earlier reading)`,
      claim: spec.claim.replace(/\.$/, ", as the rotation understood it in 2025."),
      createdAt: at(-200),
      updatedAt: at(-190),
      archivedAt: at(-190),
      links: [],
      extras: []
    })
    superseding.set(spec.path, archivePath)
  })

  return [
    ...specs.map((spec) => {
      const target = superseding.get(spec.path)
      return target === undefined
        ? spec
        : { ...spec, links: [...spec.links, { rel: "memhtml-supersedes", href: `/${target}` }] }
    }),
    ...archived
  ]
}

/**
 * The probes and the controls they need, derived from the base corpus.
 *
 * A target contributes a probe only if at least one family yields a VALIDATED control. A probe with
 * no control cannot show an inversion, so it would raise MRR while measuring nothing.
 *
 * **Targets are drawn EVENLY across the candidate list rather than off the front, and correctness
 * depends on that.** Two of the four ranking arms, recency (w 0.5) and salience (w 0.4), together
 * 31% of the fold's weight, are QUERY-BLIND. They rank a fixed `DEFAULT_ARM_LIMIT` window of the
 * corpus whatever was asked. `base` is generated in ordinal order and a memory's `updatedAt`
 * advances with its ordinal, so taking the first N candidates takes the N OLDEST memories. Every
 * probe target then sits outside the recency window by construction and loses both blind arms on
 * every probe. Probed directly: the recency window held ordinals 157-199 while the probe targets
 * were 1-155, an overlap of exactly zero, and MRR capped at 0.06 with the inversion check
 * nonetheless passing at every corpus scale.
 *
 * A uniform stride puts targets across the whole age range, which is what an agent's queries actually
 * hit. It changes NOTHING about the controls or the strict per-probe check, since the inversion count
 * was 1 before and after. It makes the MRR aggregate a measurement of ranking rather than of where the
 * generator happened to slice.
 */
const buildProbes = (
  base: ReadonlyArray<MemorySpec>,
  wanted: number
): { readonly controls: ReadonlyArray<MemorySpec>; readonly probes: ReadonlyArray<Probe> } => {
  const candidates = base.filter(
    (spec) =>
      PROBE_TYPES.includes(spec.memoryType) &&
      !spec.path.startsWith(PEOPLE_DIR) &&
      !spec.path.startsWith("archive/")
  )

  /**
   * Every `stride`-th candidate, then the remainder in order.
   *
   * The stride pass spreads the ages. The fall-through keeps the function total when a family refuses
   * a control on a strided pick, so a corpus still yields `wanted` probes rather than however many the
   * stride happened to land on.
   */
  const stride = Math.max(1, Math.floor(candidates.length / Math.max(1, wanted)))
  const strided = candidates.filter((_, offset) => offset % stride === 0)
  const remainder = candidates.filter((_, offset) => offset % stride !== 0)
  const ordered = [...strided, ...remainder]

  const controls: Array<MemorySpec> = []
  const probes: Array<Probe> = []

  for (const target of ordered) {
    if (probes.length >= wanted) break
    const topic = TOPICS.find((candidate) => target.path.includes(candidate.workspace))
    const variant: VariantOptions | undefined =
      topic === undefined
        ? undefined
        : { anchor: topic.variantAnchor, qualifier: qualifierFor(target.path) }

    const controlPaths: Array<string> = []
    const families: Array<DivergenceFamily> = []

    for (const family of DIVERGENCE_FAMILIES) {
      const derived = deriveControl(
        { claim: target.claim, body: target.body } satisfies ClaimText,
        family,
        variant
      )
      if (derived === undefined) continue
      const title = controlTitleFor(target.title, family)
      const path = pathIn(directoryOf(target.path), title)
      controls.push({
        ...target,
        path,
        title,
        claim: derived.claim,
        body: [...derived.body],
        /**
         * A control is written a day LATER than its target, so the recency arm ranks the control
         * ABOVE the memory that answers the query. That is deliberate. A fixture whose targets were
         * always the freshest would let recency alone satisfy the gate, and the gate would then pass
         * against a broken vector arm. Paying the recency penalty is what makes the pass mean that
         * the lexical and semantic arms discriminated.
         */
        updatedAt: at(dayOf(target.updatedAt) + 1),
        links: [],
        /**
         * **The target's element kit is COPIED rather than dropped, which is what makes the pair a
         * fair test.** A control without the kit is a strictly SHORTER document carrying the same
         * query terms, and both ranking arms are length-sensitive. The FTS arm's only relevance signal
         * is MATCH's own term-density order, and a vector is L2-normalized so unrelated tokens dilute
         * the cosine. Measured before this was fixed: the kit-free control took FTS rank 1 and vector
         * rank 3 while its target sat at 4 and 10, on 22 of 36 probes. The gate was failing on
         * document length instead of on the fact. A control that wins by being terser proves nothing
         * about discrimination, and a fold that "fixed" it would be tuned against an artifact.
         *
         * With the kit copied, the pair differs by exactly the flipped token, which is the
         * high-cosine wrong-fact adversary design §5 asks for.
         */
        extras: [...target.extras]
      })
      controlPaths.push(path)
      families.push(family)
    }

    if (controlPaths.length === 0) continue
    probes.push({ query: queryFor(target), targetPath: target.path, controlPaths, families })
  }

  return { controls, probes }
}

/** A variant qualifier from `@memhtml/domain`'s vocabulary, chosen by the path so it is reproducible. */
const qualifierFor = (path: string): string => {
  const qualifiers = ["pro", "beta", "legacy", "experimental", "preview"] as const
  const sum = [...path].reduce((total, character) => total + character.charCodeAt(0), 0)
  return qualifiers[sum % qualifiers.length] as string
}

/** The directory part of a path. */
const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/"))

/** The day offset an ISO instant sits at, against the corpus's epoch. */
const dayOf = (instant: string): number =>
  Math.round((Date.parse(instant) - Date.UTC(2026, 0, 1, 9, 0, 0)) / 86_400_000)

/** How many base memories a default corpus carries, before controls and the archive tier. */
export const DEFAULT_CORPUS_SIZE = 200

/** How many probes a default corpus carries. Design §5 requires at least 30. */
export const DEFAULT_PROBE_COUNT = 36

/**
 * The whole fixture specification.
 *
 * The order is fixed as people, base, archive tier, then controls, so the generated tree is written
 * in a stable order and two runs at one seed produce byte-identical files.
 */
export const buildCorpus = (
  options: {
    readonly seed?: number | undefined
    readonly size?: number | undefined
    readonly probes?: number | undefined
  } = {}
): CorpusSpec => {
  const seed = options.seed ?? DEFAULT_SEED
  const size = options.size ?? DEFAULT_CORPUS_SIZE
  const base = buildBase(size, seed)
  const { controls, probes } = buildProbes(base, options.probes ?? DEFAULT_PROBE_COUNT)
  const memories = withArchive(withEdges([...base, ...controls]))
  const controlPaths = new Set(controls.map((control) => control.path))
  return { memories, access: buildAccess(memories, controlPaths, seed), probes, seed }
}

/** Fraction of the non-control corpus that has been read at least once. */
const ACCESSED_FRACTION = 0.6

/**
 * The access history the harness seeds into `state.access`.
 *
 * **Without it the salience arm has no signal, and 14% of the fold's weight is inert.** That arm scores
 * `exp(-decay * hoursSinceAccess) + ln(1 + accessCount) + max(outcomeScore, 0)` over a `LEFT JOIN
 * state.access`. With the plane empty every term collapses to a function of `updated_at` alone, so the
 * arm becomes a second recency arm and the fold is effectively three-armed. Probed directly on the
 * empty-plane corpus: 0 of 36 probe targets fell inside the salience window.
 *
 * **Two rules, and both are about honesty rather than about the number:**
 *
 * 1. **A CONTROL gets no history, ever.** A control is an adversary this test injects. It was never in
 *    the corpus and therefore cannot have been retrieved. Giving it access history would be inventing
 *    evidence that a wrong fact had been useful. That is also why the rule is not tuning toward the
 *    probes. The exclusion is by ROLE, decided when the control is minted, rather than by whether it
 *    happens to be some probe's control.
 * 2. **The spread is QUERY-BLIND.** It is a function of the corpus seed and the path order. Nothing
 *    here reads the probe list, so a target's history is whatever its position in the corpus earns it.
 *    A spread that favored targets would make the gate pass by construction.
 *
 * The distribution is a long tail, `1 / (floor + jitter)`, because that is the shape retrieval traffic
 * has: a handful of memories are read constantly and most are read once. A uniform count would make
 * `ln(1 + accessCount)` nearly constant, and the term would carry no ordering information.
 */
const buildAccess = (
  memories: ReadonlyArray<MemorySpec>,
  controlPaths: ReadonlySet<string>,
  seed: number
): ReadonlyArray<AccessSpec> => {
  // A second stream off the same seed, so the access spread is reproducible and independent of the
  // jitter stream `buildBase` consumed. A shared generator would make a corpus-size change re-roll
  // every access count.
  const next = rng(seed ^ 0x5f37_59df)
  const rows: Array<AccessSpec> = []

  for (const memory of memories) {
    const jitter = next()
    if (controlPaths.has(memory.path)) continue
    if (memory.archivedAt !== undefined) continue
    if (jitter > ACCESSED_FRACTION) continue
    const count = Math.max(1, Math.round(1 / (0.08 + jitter)))
    rows.push({
      path: memory.path,
      accessCount: count,
      reinforcementCount: Math.min(count, Math.floor(jitter * 6)),
      outcomeScore: Math.round(jitter * 100) / 100,
      lastAccessedAt: at(240 + Math.floor(jitter * 20))
    })
  }

  return rows
}
