/**
 * The labeled corpus the write-path discrimination arm scores the gate against.
 *
 * Each item is one candidate memory as the consolidator would hand it to the write path, labeled
 * `good` (the gate should write it) or `bad` (the gate should refuse it), with the PROVENANCE of that
 * label: the contract clause, design rule, or plan definition that decides it. A label with no source
 * is an opinion, and an eval scored against opinions measures the labeler.
 *
 * The 2026-08-27 plan (Agentic-Eng brief, "memhtml write-path eval ships first") named the arms and
 * one floor (trap-question abstention at or above 60 percent) and left the definition of a good or bad
 * CANDIDATE to the write path's own contract. So the definitions here are the write path's: the
 * consolidator door's schema and grounding checks (`apps/consolidator/src/contract.ts`,
 * `apps/consolidator/src/client.ts`) and the sleep phase's per-candidate refusal
 * (`packages/sleep/src/phases/trace-consolidation.ts`). Three `bad` classes are labeled from the
 * contract's PROSE rather than from a check that exists (`restatement`, `content-leak`), and the
 * per-class breakdown is what shows whether the gate covers them. That is the point of a labeled
 * corpus over a test suite: the suite asserts what the gate does, the corpus asserts what it should.
 *
 * Everything here is static data. The two transcripts are fixture JSONL in the shape Claude Code
 * writes, with the three encodings the quote check has to survive (a typed `"`, a message-internal
 * newline, and text nested under `tool_use` and `tool_result` blocks), and every `good` quote is a
 * verbatim span of one of them. `tests/write-path-corpus.test.ts` re-verifies that property so a
 * fixture edit cannot silently turn a `good` label into a fabrication.
 */

/** Which way the label points. */
export type WritePathLabel = "good" | "bad"

/**
 * One labeled candidate.
 *
 * `candidate` is `unknown` on purpose: a `bad` item may violate the type the door decodes (a bare
 * string where an entity object belongs, a missing field), and a typed field would make those shapes
 * unrepresentable. The gate's first stage IS the decode, so the corpus has to be able to hand it
 * something the type refuses.
 */
export interface LabeledCandidate {
  /** Stable id, `g01`…`g31` for good, `b01`…`b31` for bad. The manifest keys on it. */
  readonly id: string
  readonly label: WritePathLabel
  /**
   * For a `bad` item, its failure class (what is wrong with it). For a `good` item, its shape (what
   * the gate has to get RIGHT to accept it). The per-class breakdown groups on this.
   */
  readonly class: string
  /** The rule that decides the label, with the file that holds it. */
  readonly provenance: string
  readonly candidate: unknown
}

/** One fixture transcript, as the batch would offer it. */
export interface FixtureTranscript {
  readonly sessionId: string
  /** JSONL, one object per line, in the shape Claude Code writes under `~/.claude/projects`. */
  readonly jsonl: string
}

export const SESSION_A = "session-a"
export const SESSION_B = "session-b"

/** A JSON-encoded transcript line. */
const line = (value: unknown): string => JSON.stringify(value)
const user = (sessionId: string, content: unknown) =>
  line({ type: "user", sessionId, message: { role: "user", content } })
const assistant = (sessionId: string, text: string) =>
  line({
    type: "assistant",
    sessionId,
    message: { role: "assistant", content: [{ type: "text", text }] }
  })

/**
 * The quotable spans, named so a candidate can cite one by name and the corpus test can check it.
 *
 * Session A: a deploy pipeline failing on lockfile drift, then a browser-download timeout. Session B:
 * Bedrock throttling on the nightly cron, a truncated consolidator turn, a port race.
 */
export const A = {
  q1: "The nightly deploy failed again on the frozen lockfile step.",
  q2: "The lockfile step fails because the catalog pin for effect moved and pnpm-lock.yaml was not regenerated.",
  q3: "Running pnpm install --frozen-lockfile refuses on that drift by design.",
  q4: "So the fix is to regenerate the lockfile locally and commit it, not to drop the frozen flag.",
  q5: "Dropping --frozen-lockfile would let CI resolve versions nobody reviewed.",
  q6: "the diff touches only the effect catalog entries.",
  q7: "the a11y gate timed out at 180 seconds twice this week.",
  q8: "Playwright 1.62 ships no install script, so a cold runner downloads the browser inside the test step and the timeout counts that download.",
  q9: "Caching ~/.cache/ms-playwright keyed by the Playwright version removes it.",
  /** Carries a typed `"`, which is `\"` in the file's bytes: only the decoded arm can verify it. */
  q10: 'note it in the runbook under "cold runner" so nobody re-diagnoses it.',
  /** Spans a message-internal newline, which is the two bytes `\n` in the file. */
  q11: "The cache step restores ~/.cache/ms-playwright before install.\nThe runbook now has a cold runner section",
  /** Nested under a `tool_result` block, two levels down. */
  q12: "Tasks: 64 successful, 64 total",
  q13: "the release job must never run tools:bump on its own, that is a reviewed change.",
  q14: "tools:bump stays a human-initiated task; the mise.lock diff is the record of which binaries the fleet runs and it needs a reviewer.",
  /** Nested under a `tool_use` block's `input`. */
  q15: "pnpm install --frozen-lockfile && mise run check"
} as const

/** The one long line, for the quote-length cases. Well past `MAX_QUOTE_CHARS` (600). */
export const B_LONG =
  "Checked the gateway fork against upstream main this morning: upstream moved 41 commits since our " +
  "dev branch was cut, 3 of them touch the listener config we patched, and none of them conflict textually, " +
  "so a rebase applies clean but the runtime behaviour of the listener reload path changed in commit " +
  "9f3e2c1a and our patch assumes the old ordering. The honest answer for Priya is that the rebase is " +
  "mechanically trivial and semantically not, and it needs one live run against the staging tunnel before " +
  "Friday rather than a merge on green. I have written the three commits down in the fork's dev branch " +
  "notes with the line each one moves, so whoever picks it up does not have to re-derive the diff, and " +
  "the tunnel URL is the one we sent him on Thursday morning."

export const B = {
  q1: "The sleep cron threw ThrottlingException from Bedrock three nights running.",
  q2: "The embed client retries three times with exponential backoff starting at 200 milliseconds.",
  q3: "Three nights of throttling at the same 06:30 window suggests we are colliding with another tenant's batch, so the budget is not the root cause.",
  q4: "We bumped the retry budget from three to five after the third timeout on the nightly, and it still failed.",
  q5: "Then the fix is scheduling, not retries.",
  q6: "Moving the cron to 06:50 avoided the collision on the two nights we measured, and the embed calls completed with zero throttles.",
  q7: "the consolidator turn settled without structured output once",
  q8: "That turn hit the output token ceiling mid-answer.",
  q9: "The loop now names the bound it hit instead of reporting a contract violation, which is what issue 113 misdiagnosed.",
  /** Non-ASCII punctuation, verbatim. */
  q10: "Priya asked whether the gateway fork needs a rebase before Friday — I told him we'd check.",
  q11: B_LONG,
  q12: "Précis for the runbook: throttling at a fixed window is a scheduling collision, retries only widen the window.",
  q13: "pin the teardown port in the integration harness, two tests raced on 4000 yesterday.",
  q14: "The harness reserves the port from the kernel and hands it to both tests, so a fixed literal cannot race again."
} as const

export const TRANSCRIPT_A: FixtureTranscript = {
  sessionId: SESSION_A,
  jsonl: [
    line({ type: "summary", summary: "deploy pipeline lockfile drift", sessionId: SESSION_A }),
    user(SESSION_A, `${A.q1} Can you look at why pnpm install refuses?`),
    assistant(SESSION_A, `${A.q2} ${A.q3}`),
    user(SESSION_A, A.q4),
    assistant(
      SESSION_A,
      `Yes. ${A.q5} I regenerated pnpm-lock.yaml with the pinned pnpm and ${A.q6}`
    ),
    user(SESSION_A, `Also ${A.q7} Is that the browser download?`),
    assistant(SESSION_A, `It is the Chromium fetch. ${A.q8} ${A.q9}`),
    user(SESSION_A, `Add the cache step and ${A.q10}`),
    assistant(SESSION_A, `Done. ${A.q11} naming the 180 second timeout and the fetch behind it.`),
    line({
      type: "assistant",
      sessionId: SESSION_A,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: A.q15 } }]
      }
    }),
    user(SESSION_A, [{ type: "tool_result", content: `${A.q12}\nTime: 6m12s` }]),
    user(SESSION_A, `Good. One more thing: ${A.q13}`),
    assistant(SESSION_A, `Agreed, ${A.q14}`)
  ].join("\n")
}

export const TRANSCRIPT_B: FixtureTranscript = {
  sessionId: SESSION_B,
  jsonl: [
    user(SESSION_B, `${B.q1} What is our retry budget on the embed calls?`),
    assistant(SESSION_B, `${B.q2} ${B.q3}`),
    user(SESSION_B, B.q4),
    assistant(SESSION_B, `${B.q5} ${B.q6}`),
    user(SESSION_B, `Write that into the runbook. Also, ${B.q7}, do we know why?`),
    assistant(SESSION_B, `${B.q8} ${B.q9}`),
    user(SESSION_B, B.q10),
    assistant(SESSION_B, B.q11),
    assistant(SESSION_B, B.q12),
    user(SESSION_B, `Ship it. And ${B.q13}`),
    assistant(SESSION_B, `Pinned. ${B.q14}`)
  ].join("\n")
}

export const TRANSCRIPTS: ReadonlyArray<FixtureTranscript> = [TRANSCRIPT_A, TRANSCRIPT_B]

/** The batch's session ids: what the door treats as READABLE. */
export const BATCH_SESSION_IDS: ReadonlyArray<string> = TRANSCRIPTS.map((one) => one.sessionId)

/** A session id no transcript in the batch carries. */
export const SESSION_OUTSIDE_BATCH = "session-z"

// ── builders ─────────────────────────────────────────────────────────────────────────────────────

const ev = (sessionId: string, quote: string) => ({ sessionId, quote })
const a = (quote: string) => ev(SESSION_A, quote)
const b = (quote: string) => ev(SESSION_B, quote)

/** The ceilings, restated from `apps/consolidator/src/contract.ts` so the corpus reads on its own. */
export const CEILINGS = {
  claim: 300,
  gist: 1500,
  quote: 600,
  evidence: 32,
  entities: 64
} as const

/**
 * Pad a sentence to EXACTLY `length` characters with prose filler, for the at-the-ceiling cases.
 *
 * The filler is words, so the result still slugs to a title and still reads as a sentence, and the
 * last character is forced to a letter so a boundary case cannot end in a space the door might trim.
 */
export const padTo = (text: string, length: number): string => {
  const filler = " the same shape recurred across the runs we compared"
  let out = text
  while (out.length < length) out += filler
  out = out.slice(0, length)
  return out.endsWith(" ") ? `${out.slice(0, -1)}x` : out
}

/**
 * Distinct verbatim spans, enough for the evidence-count ceiling cases.
 *
 * Twenty-six named spans plus windows cut from the long line. Every entry is a substring of its
 * transcript, and the corpus test asserts that for each one.
 */
export const MANY_SPANS: ReadonlyArray<{ readonly sessionId: string; readonly quote: string }> = [
  a(A.q1),
  a(A.q2),
  a(A.q3),
  a(A.q4),
  a(A.q5),
  a(A.q6),
  a(A.q7),
  a(A.q8),
  a(A.q9),
  a(A.q12),
  a(A.q13),
  a(A.q14),
  a(A.q15),
  b(B.q1),
  b(B.q2),
  b(B.q3),
  b(B.q4),
  b(B.q5),
  b(B.q6),
  b(B.q7),
  b(B.q8),
  b(B.q9),
  b(B.q12),
  b(B.q13),
  b(B.q14),
  b(B_LONG.slice(0, 96)),
  b(B_LONG.slice(100, 196)),
  b(B_LONG.slice(200, 296)),
  b(B_LONG.slice(300, 396)),
  b(B_LONG.slice(400, 496)),
  b(B_LONG.slice(500, 596)),
  b(B_LONG.slice(600, 696)),
  b(B_LONG.slice(650, 746))
]

const entities = (count: number) =>
  Array.from({ length: count }, (_, at) => ({ type: "file", name: `fixture-${String(at)}.ts` }))

const good = (
  id: string,
  cls: string,
  provenance: string,
  candidate: Record<string, unknown>
): LabeledCandidate => ({ id, label: "good", class: cls, provenance, candidate })

const bad = (
  id: string,
  cls: string,
  provenance: string,
  candidate: unknown
): LabeledCandidate => ({ id, label: "bad", class: cls, provenance, candidate })

const base = {
  kind: "agent_insight",
  claim: "A frozen lockfile refusal in CI is lockfile drift, not a flag to drop.",
  gist: "Two sessions saw pnpm install --frozen-lockfile refuse after a catalog pin moved without a regenerated lockfile; the fix was to regenerate and commit, and dropping the flag was rejected each time.",
  entities: [
    { type: "tool", name: "pnpm" },
    { type: "file", name: "pnpm-lock.yaml" }
  ],
  evidence: [a(A.q2), a(A.q4)]
}

const TRACE2 =
  "apps/consolidator/src/contract.ts CandidateMemory.evidence isMinLength(2), the TRACE-2 bar"
const SCHEMA =
  "apps/consolidator/src/contract.ts CandidateMemory schema, decoded in client.ts runTurn"
const GROUNDING =
  "apps/consolidator/src/contract.ts ungroundedEvidenceReason: a cited session must be readable"
const QUOTE =
  "apps/consolidator/src/client.ts fabricatedQuoteReason: a quote must appear in the cited transcript"
const KINDS =
  "apps/consolidator/src/contract.ts CONSOLIDATION_KINDS, and trace-consolidation.ts candidateRefusalFor against WRITABLE_MEMORY_TYPES"
const REFUSAL = "packages/sleep/src/phases/trace-consolidation.ts candidateRefusalFor"
const DECODED_ARM =
  "apps/consolidator/src/contract.ts decodedTranscriptStrings: a quote verifies against any one decoded string"

// ── good ─────────────────────────────────────────────────────────────────────────────────────────

const GOOD: ReadonlyArray<LabeledCandidate> = [
  good("g01", "plain/episodic", `${TRACE2}; two verbatim lines from one readable session`, {
    ...base,
    kind: "episodic",
    claim:
      "On 2026-09-03 the nightly deploy failed on the frozen lockfile step after a catalog pin moved.",
    evidence: [a(A.q1), a(A.q2)]
  }),
  good("g02", "plain/semantic", `${TRACE2}; two verbatim lines from one readable session`, {
    ...base,
    kind: "semantic",
    claim: "pnpm install --frozen-lockfile refuses on lockfile drift by design.",
    evidence: [a(A.q3), a(A.q5)]
  }),
  good("g03", "plain/procedural", `${TRACE2}; two verbatim lines from one readable session`, {
    ...base,
    kind: "procedural",
    claim:
      "When CI refuses a frozen lockfile, regenerate it with the pinned pnpm and commit the diff.",
    evidence: [a(A.q4), a(A.q6)]
  }),
  good("g04", "plain/agent_insight", `${TRACE2}; two verbatim lines from one readable session`, {
    ...base,
    claim: "A cold runner's browser download counts against the a11y gate's timeout.",
    evidence: [a(A.q7), a(A.q8)]
  }),
  good("g05", "plain/error_pattern", `${TRACE2}; two verbatim lines from one readable session`, {
    ...base,
    kind: "error_pattern",
    claim:
      "Bedrock ThrottlingException at a fixed cron window is a scheduling collision, not a retry budget problem.",
    evidence: [b(B.q1), b(B.q3)]
  }),
  good("g06", "plain/precedent", `${TRACE2}; two verbatim lines from one readable session`, {
    ...base,
    kind: "precedent",
    claim: "tools:bump stays human-initiated because the mise.lock diff needs a reviewer.",
    evidence: [a(A.q13), a(A.q14)]
  }),
  good("g07", "cross-session/episodic", `${TRACE2}; quotes from two readable sessions`, {
    ...base,
    kind: "episodic",
    claim: "Both nightly failures this week were configuration drift rather than code defects.",
    evidence: [a(A.q2), b(B.q3)]
  }),
  good("g08", "cross-session/semantic", `${TRACE2}; quotes from two readable sessions`, {
    ...base,
    kind: "semantic",
    claim:
      "A gate that fails on a fixed clock is usually measuring something outside the code under test.",
    evidence: [a(A.q8), b(B.q3)]
  }),
  good("g09", "cross-session/procedural", `${TRACE2}; quotes from two readable sessions`, {
    ...base,
    kind: "procedural",
    claim: "Write the diagnosis into the runbook under the symptom's name so it is not re-derived.",
    evidence: [a(A.q10), b(B.q12)]
  }),
  good("g10", "cross-session/agent_insight", `${TRACE2}; quotes from two readable sessions`, {
    ...base,
    claim: "Widening a budget rarely fixes a failure whose cause is timing.",
    evidence: [b(B.q4), b(B.q5), a(A.q9)]
  }),
  good("g11", "cross-session/error_pattern", `${TRACE2}; quotes from two readable sessions`, {
    ...base,
    kind: "error_pattern",
    claim:
      "A turn that stops at its output ceiling reads as a contract violation unless the loop names the bound.",
    evidence: [b(B.q8), b(B.q9)]
  }),
  good("g12", "cross-session/precedent", `${TRACE2}; quotes from two readable sessions`, {
    ...base,
    kind: "precedent",
    claim: "Reviewed changes stay human-initiated even when automation could run them.",
    evidence: [a(A.q13), b(B.q10)]
  }),
  good(
    "g13",
    "encoding/typed-quote",
    `${DECODED_ARM}; the span holds a typed " that is \\" in the bytes`,
    {
      ...base,
      claim: "Runbook entries are filed under the symptom's name.",
      evidence: [a(A.q10), a(A.q9)]
    }
  ),
  good(
    "g14",
    "encoding/internal-newline",
    `${DECODED_ARM}; the span crosses a message-internal newline`,
    {
      ...base,
      kind: "procedural",
      claim: "Restore the Playwright cache before install on a cold runner.",
      evidence: [a(A.q11), a(A.q9)]
    }
  ),
  good(
    "g15",
    "encoding/rewrapped-whitespace",
    "apps/consolidator/src/contract.ts quoteAppearsIn: whitespace runs collapse on both sides",
    {
      ...base,
      claim: "Retries were raised from three to five before the cause was found.",
      evidence: [
        b(
          "We bumped the retry budget\n  from three to five   after the third timeout on the nightly"
        ),
        b(B.q5)
      ]
    }
  ),
  good(
    "g16",
    "encoding/nested-tool-result",
    `${DECODED_ARM}; the span sits under a tool_result block`,
    {
      ...base,
      kind: "episodic",
      claim: "The full check passed on 64 of 64 tasks after the lockfile was regenerated.",
      evidence: [a(A.q12), a(A.q15)]
    }
  ),
  good(
    "g17",
    "encoding/non-ascii",
    `${QUOTE}; verbatim including an em dash and a curly apostrophe`,
    {
      ...base,
      kind: "episodic",
      claim: "Priya asked for a rebase check on the gateway fork before Friday.",
      entities: [{ type: "person", name: "Priya Raman" }],
      evidence: [b(B.q10), b(B_LONG.slice(0, 96))]
    }
  ),
  good("g18", "ceiling/claim-300", `${SCHEMA}; claim isMaxLength(300), at the ceiling`, {
    ...base,
    claim: padTo("A lockfile refusal is drift.", CEILINGS.claim)
  }),
  good("g19", "ceiling/gist-1500", `${SCHEMA}; gist isMaxLength(1500), at the ceiling`, {
    ...base,
    gist: padTo(base.gist, CEILINGS.gist)
  }),
  good(
    "g20",
    "ceiling/quote-600",
    `${SCHEMA}; quote isMaxLength(600), at the ceiling and verbatim`,
    {
      ...base,
      kind: "episodic",
      claim: "The fork rebase applies clean but the listener reload ordering changed.",
      evidence: [b(B_LONG.slice(0, CEILINGS.quote)), b(B.q10)]
    }
  ),
  good("g21", "ceiling/evidence-32", `${SCHEMA}; evidence isMaxLength(32), at the ceiling`, {
    ...base,
    gist: "Every line the two sessions exchanged about drift, throttling and gates points the same way.",
    claim:
      "Across both sessions every failure traced to an environment change, not to a code change.",
    evidence: MANY_SPANS.slice(0, CEILINGS.evidence)
  }),
  good("g22", "ceiling/entities-64", `${SCHEMA}; entities isMaxLength(64), at the ceiling`, {
    ...base,
    entities: entities(CEILINGS.entities)
  }),
  good("g23", "shape/no-entities", `${SCHEMA}; entities may be empty`, {
    ...base,
    entities: []
  }),
  good(
    "g24",
    "shape/unknown-entity-type",
    "apps/consolidator/src/contract.ts CandidateEntity: the type vocabulary is open, `unknown` is valid",
    {
      ...base,
      entities: [{ type: "unknown", name: "ms-playwright" }]
    }
  ),
  good("g25", "shape/multi-sentence-claim", `${REFUSAL}; titleFor takes the first sentence`, {
    ...base,
    claim:
      "A frozen lockfile refusal is drift. Regenerating with the pinned pnpm is the fix. Dropping the flag is not.",
    evidence: [a(A.q4), a(A.q5)]
  }),
  good(
    "g26",
    "shape/path-and-digits",
    `${REFUSAL}; a claim with paths and digits still slugs to a title`,
    {
      ...base,
      claim:
        "Caching ~/.cache/ms-playwright removes the 180 second cold-runner timeout on Playwright 1.62.",
      evidence: [a(A.q7), a(A.q9)]
    }
  ),
  good("g27", "shape/short-quotes", `${QUOTE}; a short span is still a verbatim span`, {
    ...base,
    kind: "procedural",
    claim: "Pin the teardown port from the kernel so two tests cannot race on a literal.",
    evidence: [b("two tests raced on 4000"), b("reserves the port from the kernel")]
  }),
  good(
    "g28",
    "shape/three-quotes-two-sessions",
    `${TRACE2}; more than the minimum, across sessions`,
    {
      ...base,
      claim: "Fixed-window failures were solved by moving the schedule, twice.",
      evidence: [b(B.q6), b(B.q12), a(A.q9)]
    }
  ),
  good(
    "g29",
    "shape/padded-session-id",
    "packages/sleep/src/phases/trace-consolidation.ts soleEvidenceSession: ids are trimmed before they are compared; the quote is real and the session is in the batch",
    {
      ...base,
      claim: "The consolidator loop names the bound it stopped at.",
      evidence: [ev(` ${SESSION_B} `, B.q9), b(B.q8)]
    }
  ),
  good("g30", "shape/gist-with-code", `${SCHEMA}; gist is prose and may carry a command`, {
    ...base,
    gist: "Both sessions ended the same way: `pnpm install --frozen-lockfile && mise run check` ran green once the lockfile matched the catalog. The command is the receipt, the drift is the lesson.",
    evidence: [a(A.q15), a(A.q12)]
  }),
  good("g31", "shape/long-line-window", `${QUOTE}; a window cut from a long assistant message`, {
    ...base,
    kind: "semantic",
    claim: "A rebase can be mechanically trivial and semantically not.",
    evidence: [b(B_LONG.slice(300, 396)), b(B_LONG.slice(400, 496))]
  })
]

// ── bad ──────────────────────────────────────────────────────────────────────────────────────────

const BAD: ReadonlyArray<LabeledCandidate> = [
  bad(
    "b01",
    "fabricated-quote/paraphrase",
    `${QUOTE}; a paraphrase of a real line is not in the file`,
    {
      ...base,
      evidence: [a("The nightly deploy broke again at the lockfile step."), a(A.q4)]
    }
  ),
  bad(
    "b02",
    "fabricated-quote/stitched",
    `${QUOTE}; decodedTranscriptStrings tests each string separately, so a span across two messages fails`,
    {
      ...base,
      evidence: [a(`${A.q3} ${A.q4}`), a(A.q5)]
    }
  ),
  bad("b03", "fabricated-quote/reordered", `${QUOTE}; real words in a different order`, {
    ...base,
    evidence: [
      b("The budget is not the root cause, so we are colliding with another tenant."),
      b(B.q5)
    ]
  }),
  bad(
    "b04",
    "fabricated-quote/misattributed",
    `${QUOTE}; a real line from session B cited as session A`,
    {
      ...base,
      evidence: [a(B.q4), a(A.q2)]
    }
  ),
  bad("b05", "fabricated-quote/mixed", `${QUOTE}; one real quote does not carry an invented one`, {
    ...base,
    evidence: [a(A.q2), a("We agreed to drop the frozen flag for now.")]
  }),
  bad("b06", "ungrounded-session/one", `${GROUNDING}; session-z is not in the batch`, {
    ...base,
    evidence: [ev(SESSION_OUTSIDE_BATCH, A.q2), a(A.q4)]
  }),
  bad("b07", "ungrounded-session/both", `${GROUNDING}; neither citation names a readable session`, {
    ...base,
    evidence: [ev(SESSION_OUTSIDE_BATCH, A.q2), ev("session-y", A.q4)]
  }),
  bad("b08", "under-evidenced/one-quote", `${TRACE2}; one line is a restatement of that line`, {
    ...base,
    evidence: [a(A.q2)]
  }),
  bad("b09", "under-evidenced/no-quotes", `${TRACE2}; a claim with nothing behind it`, {
    ...base,
    evidence: []
  }),
  bad(
    "b10",
    "restatement/duplicate-quote",
    "TRACE-2 as prose (apps/consolidator/src/contract.ts CandidateMemory note: a pattern has at least two LINES behind it); the same line twice is one line. No check dedupes evidence.",
    {
      ...base,
      evidence: [a(A.q2), a(A.q2)]
    }
  ),
  bad(
    "b11",
    "restatement/duplicate-quote-rewrapped",
    "TRACE-2 as prose; the same line twice, differing only in whitespace, is one line. No check dedupes evidence.",
    {
      ...base,
      evidence: [a(A.q2), a(A.q2.replace(" the catalog", "  the catalog"))]
    }
  ),
  bad("b12", "disallowed-kind/task", `${KINDS}; task is work to do, not something observed`, {
    ...base,
    kind: "task"
  }),
  bad("b13", "disallowed-kind/user_preference", `${KINDS}; a preference nobody stated`, {
    ...base,
    kind: "user_preference"
  }),
  bad("b14", "disallowed-kind/verdict", `${KINDS}; a judgement this agent does not pass`, {
    ...base,
    kind: "verdict"
  }),
  bad("b15", "disallowed-kind/arc", `${KINDS}; arc is sleep-synthesized and not writable at all`, {
    ...base,
    kind: "arc"
  }),
  bad("b16", "disallowed-kind/unknown", `${KINDS}; not a memory type`, {
    ...base,
    kind: "insight"
  }),
  bad(
    "b17",
    "empty-claim/empty",
    `${SCHEMA}; claim isMinLength(1), and ${REFUSAL} refuses an empty claim`,
    {
      ...base,
      claim: ""
    }
  ),
  bad(
    "b18",
    "empty-claim/whitespace",
    `${REFUSAL}; a <mark> holding whitespace is a file no search can find`,
    {
      ...base,
      claim: "   "
    }
  ),
  bad("b19", "empty-gist/empty", `${SCHEMA}; gist isMinLength(1)`, {
    ...base,
    gist: ""
  }),
  bad("b20", "oversize/claim-301", `${SCHEMA}; claim isMaxLength(300)`, {
    ...base,
    claim: padTo("A lockfile refusal is drift.", CEILINGS.claim + 1)
  }),
  bad("b21", "oversize/gist-1501", `${SCHEMA}; gist isMaxLength(1500)`, {
    ...base,
    gist: padTo(base.gist, CEILINGS.gist + 1)
  }),
  bad(
    "b22",
    "oversize/quote-601",
    `${SCHEMA}; quote isMaxLength(600), verbatim but over the ceiling`,
    {
      ...base,
      evidence: [b(B_LONG.slice(0, CEILINGS.quote + 1)), b(B.q10)]
    }
  ),
  bad("b23", "oversize/evidence-33", `${SCHEMA}; evidence isMaxLength(32)`, {
    ...base,
    evidence: MANY_SPANS.slice(0, CEILINGS.evidence + 1)
  }),
  bad("b24", "oversize/entities-65", `${SCHEMA}; entities isMaxLength(64)`, {
    ...base,
    entities: entities(CEILINGS.entities + 1)
  }),
  bad("b25", "malformed-entity/empty-name", `${SCHEMA}; CandidateEntity.name isMinLength(1)`, {
    ...base,
    entities: [{ type: "tool", name: "" }]
  }),
  bad(
    "b26",
    "malformed-entity/bare-string",
    "apps/consolidator/src/contract.ts CandidateEntity: a required object, never a bare name",
    {
      ...base,
      entities: ["pnpm"]
    }
  ),
  bad("b27", "empty-session-id", `${SCHEMA}; CandidateEvidence.sessionId isMinLength(1)`, {
    ...base,
    evidence: [ev("", A.q2), a(A.q4)]
  }),
  bad("b28", "unslugable-claim/cjk", `${REFUSAL}; a claim that slugs to SLUG_FALLBACK`, {
    ...base,
    claim: "日本語のみの主張"
  }),
  bad("b29", "unslugable-claim/punctuation", `${REFUSAL}; a claim that slugs to SLUG_FALLBACK`, {
    ...base,
    claim: "!!! ??? ... ---"
  }),
  bad(
    "b30",
    "excess-property",
    "apps/consolidator/src/client.ts decode with onExcessProperty: error; an off-contract answer is refused, not repaired",
    {
      ...base,
      confidence: 0.9
    }
  ),
  bad(
    "b31",
    "content-leak/verbatim-claim",
    "packages/sleep/src/phases/trace-consolidation.ts commitContextFor: a verbatim transcript span must not enter the corpus; this claim IS the quote. No check compares claim to evidence.",
    {
      ...base,
      claim: B.q3,
      evidence: [b(B.q3), b(B.q1)]
    }
  )
]

/** The whole labeled corpus: 31 good, 31 bad, in id order. */
export const WRITE_PATH_CORPUS: ReadonlyArray<LabeledCandidate> = [...GOOD, ...BAD]

/**
 * The failure classes the gate is KNOWN not to cover, as of the frozen manifest.
 *
 * Stated in code so the eval can assert the gap is exactly this and no wider: a class that starts
 * failing here is a regression, and a class that starts passing is a change the manifest should
 * record. Three classes:
 *
 * - `restatement/*`: the TRACE-2 bar is checked as a COUNT of quotes, and nothing dedupes them, so the
 *   same line twice clears it.
 * - `content-leak/*`: nothing compares a claim against its own evidence, so a claim that is a
 *   verbatim transcript span is written into the corpus as prose.
 * - `shape/padded-session-id`: the door's `ungroundedEvidenceReason` compares ids untrimmed while the
 *   phase trims them, so a real quote from a real session is refused for its whitespace. A GOOD item
 *   the gate rejects, which is the one false rejection on this corpus.
 */
export const KNOWN_GAP_CLASSES: ReadonlyArray<string> = [
  "restatement/duplicate-quote",
  "restatement/duplicate-quote-rewrapped",
  "content-leak/verbatim-claim",
  "shape/padded-session-id"
]
