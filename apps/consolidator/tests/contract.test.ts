import { MEMORY_TYPES } from "@memhtml/contracts"
import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CandidateCommitment,
  CandidateMemory,
  COMMITMENT_ACTORS,
  CONSOLIDATION_KINDS,
  CONSOLIDATION_OUTPUT_JSON_SCHEMA,
  ConsolidationPayload,
  isConsolidationKind,
  MAX_CANDIDATES_PER_RESULT,
  MAX_CLAIM_CHARS,
  MAX_COMMITMENTS_PER_RESULT,
  MAX_ENTITIES_PER_CANDIDATE,
  MAX_EVIDENCE_PER_CANDIDATE,
  MAX_QUOTE_CHARS,
  MAX_STATEMENT_CHARS,
  MAX_TRANSCRIPTS_PER_RUN,
  underCitedWatermarkWarning,
  ungroundedCommitmentReason,
  ungroundedEvidenceReason,
  watermarkableSessionIds
} from "../src/contract.js"

/**
 * The decode tier. No credentials, no eve server, no network — INV-3 keeps CI credential-free, so
 * every test here runs on a schema and a plain object.
 *
 * The decode posture under test is `packages/llm/src/structured.ts:52-61`'s: a coerced object is
 * indistinguishable from a real one downstream, so every assertion below is that a bad payload
 * FAILS rather than being quietly repaired.
 */

/** The payload decode, over the value exactly as given. Nothing is filled in. */
const decodeRaw = (payload: unknown): Result.Result<ConsolidationPayload, unknown> =>
  Effect.runSync(
    Effect.result(
      Schema.decodeUnknownEffect(ConsolidationPayload, { onExcessProperty: "error" })(payload)
    )
  )

/**
 * The same decode with the payload's other REQUIRED fields supplied when the case did not state them.
 *
 * Every case in the CANDIDATE suite is about the candidate half of the payload, and `commitments` and
 * `readSessionIds` are both required, so without this each of them would fail for a reason that has
 * nothing to do with what it asserts. Filling them here keeps each case's subject legible.
 *
 * It fills only a non-array object, and only a key the case did not state, so the three cases that turn
 * on the ROOT shape — a missing `candidates`, a bare array, an extra root key — still see exactly what
 * they passed. Each requirement is asserted directly through {@link decodeRaw}, so nothing about it
 * rests on this convenience.
 */
const decode = (payload: unknown): Result.Result<ConsolidationPayload, unknown> =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? decodeRaw({ commitments: [], readSessionIds: ["session-a"], ...payload })
    : decodeRaw(payload)

const evidence = (sessionId: string, quote: string) => ({ sessionId, quote })

/** One well-formed commitment, with the fields a case does not care about filled in plausibly. */
const commitment = (overrides: Record<string, unknown> = {}) => ({
  statement: "wire the capture path before the next release",
  actor: "agent",
  evidence: evidence("session-a", "I'll wire capture before we cut the release"),
  confidence: 0.9,
  resolved: false,
  ...overrides
})

const candidate = (overrides: Record<string, unknown> = {}) => ({
  kind: "error_pattern",
  claim: "The batch importer fails on empty CSV headers across sessions.",
  gist: "Three sessions hit the same TypeError from a header-less CSV; the fix each time was to pass an explicit header list.",
  entities: [
    { type: "file", name: "importer.ts" },
    { type: "package", name: "papaparse" }
  ],
  evidence: [
    evidence("session-a", "TypeError: Cannot read properties of undefined (reading 'trim')"),
    evidence("session-b", "TypeError: Cannot read properties of undefined (reading 'trim')")
  ],
  ...overrides
})

describe("CandidateMemory decode", () => {
  it("accepts a well-formed candidate", () => {
    const result = decode({ candidates: [candidate()] })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.candidates).toHaveLength(1)
      expect(result.success.candidates[0]?.kind).toBe("error_pattern")
    }
  })

  it("accepts an empty candidate list, because refusing to pad is a correct answer", () => {
    const result = decode({ candidates: [] })
    expect(Result.isSuccess(result)).toBe(true)
  })

  /**
   * The TRACE-2 bar as a type. A candidate that can cite only one line IS a restatement of that
   * line — the thing one grep already surfaces — so the schema refuses it rather than trusting
   * `agent/instructions.md` to have been followed.
   */
  it("REJECTS a candidate with one evidence quote (the TRACE-2 bar)", () => {
    const result = decode({
      candidates: [candidate({ evidence: [evidence("session-a", "TypeError: undefined")] })]
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  it("REJECTS a candidate with no evidence at all", () => {
    expect(Result.isFailure(decode({ candidates: [candidate({ evidence: [] })] }))).toBe(true)
  })

  it("REJECTS a kind outside the closed vocabulary", () => {
    expect(Result.isFailure(decode({ candidates: [candidate({ kind: "insight" })] }))).toBe(true)
  })

  it("REJECTS a kind that is a memory type but not a consolidation kind", () => {
    // `task` and `user_preference` are real corpus types this agent may not infer.
    expect(Result.isFailure(decode({ candidates: [candidate({ kind: "task" })] }))).toBe(true)
    expect(Result.isFailure(decode({ candidates: [candidate({ kind: "user_preference" })] }))).toBe(
      true
    )
  })

  it("REJECTS an empty claim and an empty gist", () => {
    expect(Result.isFailure(decode({ candidates: [candidate({ claim: "" })] }))).toBe(true)
    expect(Result.isFailure(decode({ candidates: [candidate({ gist: "" })] }))).toBe(true)
  })

  /** A quote is a citation, not a payload: an unbounded one could carry a whole transcript. */
  it("REJECTS a quote longer than the ceiling", () => {
    const result = decode({
      candidates: [
        candidate({
          evidence: [
            evidence("session-a", "x".repeat(MAX_QUOTE_CHARS + 1)),
            evidence("session-b", "ok")
          ]
        })
      ]
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  it("REJECTS a claim longer than the ceiling", () => {
    expect(
      Result.isFailure(
        decode({ candidates: [candidate({ claim: "x".repeat(MAX_CLAIM_CHARS + 1) })] })
      )
    ).toBe(true)
  })

  it("REJECTS an empty sessionId, so a quote cannot be unattributed", () => {
    const result = decode({
      candidates: [
        candidate({ evidence: [evidence("", "a quote"), evidence("session-b", "another")] })
      ]
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  /**
   * The load-bearing one, and the reason `onExcessProperty: "error"` is passed explicitly. The
   * DEFAULT (`"ignore"`) strips the extra key and SUCCEEDS, which would let the agent answer a
   * schema adjacent to the one it was given and have the difference vanish silently.
   */
  it("REJECTS an undeclared extra key instead of stripping it", () => {
    const result = decode({ candidates: [candidate({ confidence: 0.9 })] })
    expect(Result.isFailure(result)).toBe(true)
  })

  it("REJECTS an extra key at the payload root", () => {
    expect(Result.isFailure(decode({ candidates: [candidate()], notes: "hi" }))).toBe(true)
  })

  it("REJECTS a missing candidates field and a bare array", () => {
    expect(Result.isFailure(decode({}))).toBe(true)
    expect(Result.isFailure(decode([candidate()]))).toBe(true)
  })

  it("accepts empty entities but rejects an entity with an empty half", () => {
    expect(Result.isSuccess(decode({ candidates: [candidate({ entities: [] })] }))).toBe(true)
    expect(
      Result.isFailure(decode({ candidates: [candidate({ entities: [{ type: "", name: "x" }] })] }))
    ).toBe(true)
    expect(
      Result.isFailure(
        decode({ candidates: [candidate({ entities: [{ type: "file", name: "" }] })] })
      )
    ).toBe(true)
  })

  /**
   * The type half is what makes an entity reachable, so the decode refuses every way of omitting it.
   *
   * A memory whose entity is filed under `unknown` answers the reference a caller spells —
   * `service:checkout-api` — with an empty set, and the empty set is also what an absent memory
   * returns. This is the case that keeps the shape STRUCTURAL rather than advisory: a bare string is
   * the answer a model trained on the previous phrasing gives, and it fails here instead of writing an
   * unreachable memory.
   *
   * (Mutation: `entities: Schema.Array(Schema.String.check(Schema.isMinLength(1)))` accepts the bare
   * strings and the type-less object below, and fails this case on the first two expectations.)
   */
  it("REJECTS a bare-string entity and an entity with no type", () => {
    expect(
      Result.isFailure(decode({ candidates: [candidate({ entities: ["checkout-api"] })] }))
    ).toBe(true)
    expect(
      Result.isFailure(
        decode({ candidates: [candidate({ entities: [{ name: "checkout-api" }] })] })
      )
    ).toBe(true)
    expect(
      Result.isFailure(decode({ candidates: [candidate({ entities: [{ type: "service" }] })] }))
    ).toBe(true)
  })

  /**
   * An undeclared key inside an entity fails, matching the payload root's own posture: the decode runs
   * with `onExcessProperty: "error"` precisely so an answer shaped like a NEIGHBOURING schema cannot
   * decode with the difference stripped out.
   */
  it("REJECTS an extra key inside an entity", () => {
    expect(
      Result.isFailure(
        decode({
          candidates: [candidate({ entities: [{ type: "service", name: "checkout-api", id: 7 }] })]
        })
      )
    ).toBe(true)
  })

  /**
   * The type vocabulary is OPEN, and this is the assertion that keeps it open. memhtml must not dictate
   * a consumer's entity taxonomy, so a term outside anything the prompt suggests decodes, and so does
   * `unknown` — which is a real store type, not a rejection.
   *
   * (Mutation: `type: Schema.Literals([...])` over any fixed list fails here.)
   */
  it("ACCEPTS a type outside the suggested vocabulary, and `unknown`", () => {
    expect(
      Result.isSuccess(
        decode({
          candidates: [
            candidate({
              entities: [
                { type: "gauge", name: "backlog-depth" },
                { type: "unknown", name: "the thing in the corner" }
              ]
            })
          ]
        })
      )
    ).toBe(true)
  })

  it("decodes to the class, so downstream code gets the declared type", () => {
    const result = decode({ candidates: [candidate()] })
    if (!Result.isSuccess(result)) throw new Error("expected success")
    const first = result.success.candidates[0]
    expect(first).toBeInstanceOf(CandidateMemory)
  })
})

/**
 * The commitments half of the payload: issue #44's surface 2.
 *
 * Same decode posture as the candidate suite — every assertion is that a bad payload FAILS rather than
 * being quietly repaired — over a shape that differs from a candidate memory in exactly the places the
 * contract argues it should: ONE evidence quote instead of two, a closed actor vocabulary, and a
 * `resolved` flag.
 */
describe("CandidateCommitment decode", () => {
  it("accepts a well-formed commitment", () => {
    const result = decode({ candidates: [], commitments: [commitment()] })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.commitments).toHaveLength(1)
      expect(result.success.commitments[0]).toBeInstanceOf(CandidateCommitment)
    }
  })

  /**
   * The field the closure arm turns on, so it has to survive the decode as a real boolean.
   *
   * (Mutation: dropping `resolved` from the schema fails this and the wire-schema case, and would leave
   * `phases/trace-consolidation.ts`' closure arm permanently unreachable — every commitment would read
   * as unresolved and the "completion detected" path would never run.)
   */
  it("decodes resolved: true as a real flag, so the closure arm is reachable", () => {
    const result = decode({ candidates: [], commitments: [commitment({ resolved: true })] })
    if (!Result.isSuccess(result)) throw new Error("expected success")
    expect(result.success.commitments[0]?.resolved).toBe(true)
  })

  it("REJECTS a missing resolved flag rather than defaulting it to false", () => {
    const { resolved: _dropped, ...withoutResolved } = commitment()
    expect(Result.isFailure(decode({ candidates: [], commitments: [withoutResolved] }))).toBe(true)
  })

  it("accepts every actor in the closed vocabulary and REJECTS one outside it", () => {
    for (const actor of COMMITMENT_ACTORS) {
      expect(
        Result.isSuccess(decode({ candidates: [], commitments: [commitment({ actor })] })),
        actor
      ).toBe(true)
    }
    expect(
      Result.isFailure(decode({ candidates: [], commitments: [commitment({ actor: "team" })] }))
    ).toBe(true)
    expect(
      Result.isFailure(decode({ candidates: [], commitments: [commitment({ actor: "" })] }))
    ).toBe(true)
  })

  /**
   * ONE evidence object, not a list. The two-quote bar is the TRACE-2 bar for a candidate MEMORY, which
   * claims a pattern across lines; a commitment is one sentence, so a second quote could only be
   * padding. Asserting the array form is REFUSED is what makes "exactly one" structural rather than a
   * minimum a caller could widen.
   */
  it("REJECTS an evidence ARRAY, because a commitment cites exactly one line", () => {
    const result = decode({
      candidates: [],
      commitments: [commitment({ evidence: [evidence("session-a", "a quote")] })]
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  it("REJECTS an empty statement, an empty quote, and an empty sessionId", () => {
    expect(
      Result.isFailure(decode({ candidates: [], commitments: [commitment({ statement: "" })] }))
    ).toBe(true)
    expect(
      Result.isFailure(
        decode({
          candidates: [],
          commitments: [commitment({ evidence: evidence("session-a", "") })]
        })
      )
    ).toBe(true)
    expect(
      Result.isFailure(
        decode({ candidates: [], commitments: [commitment({ evidence: evidence("", "a quote") })] })
      )
    ).toBe(true)
  })

  it("REJECTS a statement longer than the ceiling", () => {
    const result = decode({
      candidates: [],
      commitments: [commitment({ statement: "x".repeat(MAX_STATEMENT_CHARS + 1) })]
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  it("REJECTS a confidence outside [0, 1] and a non-finite one", () => {
    for (const confidence of [-0.1, 1.1, "high"]) {
      expect(
        Result.isFailure(decode({ candidates: [], commitments: [commitment({ confidence })] })),
        String(confidence)
      ).toBe(true)
    }
  })

  /** Absent, a string, and `null` all decode: the three forms a producer can spell "no due date". */
  it("accepts dueHint absent, as a string, and as null", () => {
    const { statement, actor, evidence: one, confidence, resolved } = commitment()
    const base = { statement, actor, evidence: one, confidence, resolved }
    expect(Result.isSuccess(decode({ candidates: [], commitments: [base] }))).toBe(true)
    expect(
      Result.isSuccess(
        decode({ candidates: [], commitments: [{ ...base, dueHint: "2026-08-20" }] })
      )
    ).toBe(true)
    expect(
      Result.isSuccess(decode({ candidates: [], commitments: [{ ...base, dueHint: null }] }))
    ).toBe(true)
  })

  it("REJECTS an undeclared extra key on a commitment instead of stripping it", () => {
    const result = decode({ candidates: [], commitments: [commitment({ owner: "laith" })] })
    expect(Result.isFailure(result)).toBe(true)
  })

  /**
   * The field is REQUIRED, so an agent that answered only the candidates half fails the decode rather
   * than being read as "looked and found no commitments". This is the case {@link decodeRaw} exists
   * for: the convenience decode fills the field, and this asserts the requirement it fills.
   *
   * (Mutation: making `commitments` optional, or defaulting it to `[]` in the schema, fails this.)
   */
  it("REJECTS a payload with no commitments field at all", () => {
    expect(Result.isFailure(decodeRaw({ candidates: [], readSessionIds: [] }))).toBe(true)
    expect(
      Result.isSuccess(decodeRaw({ candidates: [], commitments: [], readSessionIds: [] }))
    ).toBe(true)
  })
})

describe("the read receipt is a required field", () => {
  /**
   * `readSessionIds` is what the watermark advances over, so an ABSENT one has no honest reading. The
   * only fallback available would be the whole reachable set, which is the advance the field exists to
   * narrow — a turn that opened 1 of 32 would go back to watermarking all 32, and
   * `trace_consolidations` is an anti-join, so those 31 transcripts would be lost rather than delayed.
   * Required is what makes an agent that stopped reporting it fail the turn instead.
   *
   * (Mutation: `Schema.optionalKey(...)`, or a `?? []` anywhere downstream, fails the first case.)
   */
  it("REJECTS a payload with no readSessionIds at all", () => {
    expect(Result.isFailure(decodeRaw({ candidates: [], commitments: [] }))).toBe(true)
    expect(
      Result.isSuccess(decodeRaw({ candidates: [], commitments: [], readSessionIds: [] }))
    ).toBe(true)
  })

  /** `[]` is a real answer: nothing was readable, or nothing was opened. Not the same as absent. */
  it("ACCEPTS an empty receipt", () => {
    expect(Result.isSuccess(decode({ candidates: [], readSessionIds: [] }))).toBe(true)
  })

  /**
   * Bounded by the transcript cap, because a run mounts at most that many transcripts and a longer list
   * names sessions no run was handed. Both sides of the bound, so a later edit cannot tighten the value
   * while every rejection case stays green.
   */
  it("bounds the receipt at the transcript cap and accepts exactly that many", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `session-${String(i)}`)
    expect(
      Result.isSuccess(decode({ candidates: [], readSessionIds: ids(MAX_TRANSCRIPTS_PER_RUN) }))
    ).toBe(true)
    expect(
      Result.isFailure(decode({ candidates: [], readSessionIds: ids(MAX_TRANSCRIPTS_PER_RUN + 1) }))
    ).toBe(true)
  })
})

/**
 * The grounding check the schema cannot express, exercised as the pure rule the client applies.
 *
 * `sessionId`'s doc comment claimed for one task that an id was "checked on decode" against the
 * readable ids, and nothing checked it — a candidate could cite a session nobody read, and that id
 * rode into the sleep phase and out into a commit message as `evidence <id>:`. A reviewer's whole
 * recourse against a distilled claim is to go back to that session and see whether the quote is
 * there, so a fabricated id is worse than no evidence: it reads as provenance.
 */
describe("evidence must be grounded in the READABLE batch", () => {
  /**
   * The grounding set is the set of transcripts that RESOLVED in the sandbox, not the batch a caller
   * asked about. The client narrowed it that way when transcripts moved onto a read-only mount: a
   * session whose file did not resolve cannot have been read, so citing it is a fabricated receipt even
   * when the caller did ask about that session.
   */
  const READABLE = ["session-a", "session-b"]

  it("accepts candidates citing only readable sessions", () => {
    expect(ungroundedEvidenceReason([candidate()], READABLE)).toBeNull()
  })

  it("accepts an empty candidate list, which cites nothing at all", () => {
    expect(ungroundedEvidenceReason([], READABLE)).toBeNull()
  })

  /**
   * The hallucinated id. `session-c` never resolved, and the rest of the candidate is impeccable —
   * a well-formed claim, a real gist, two quotes, one of them from a session that WAS read. That
   * mixture is the realistic shape: a model that read two transcripts and attributed one quote to a
   * third session it inferred the existence of.
   *
   * (Mutation: removing the `ungroundedEvidenceReason` call from `runTurn`, or making this function
   * return `null` unconditionally, fails this case and the two below it.)
   */
  it("REJECTS a candidate citing a session this run never made readable", () => {
    const reason = ungroundedEvidenceReason(
      [
        candidate({
          evidence: [
            evidence("session-a", "TypeError: Cannot read properties of undefined"),
            evidence("session-c", "a quote from a session that was never provided")
          ]
        })
      ],
      READABLE
    )
    expect(reason).not.toBeNull()
    // The reason NAMES the invented id, which is what an operator reads in the phase's detail line.
    expect(reason).toContain("session-c")
    expect(reason).toContain("did not make readable")
  })

  /**
   * The whole turn is refused, and the offset says which candidate did it. A caller cannot use this
   * to drop one candidate and keep the rest — that would be the lenient repair the decode posture
   * refuses — but an operator can tell which of six candidates was ungrounded.
   */
  it("names the OFFSET of the offending candidate, not merely that one exists", () => {
    const reason = ungroundedEvidenceReason(
      [candidate(), candidate({ evidence: [evidence("session-z", "invented")] })],
      READABLE
    )
    expect(reason).toContain("candidate 1")
  })

  /**
   * An empty grounding set rejects everything, which is the correct answer rather than a degenerate
   * one: a run that made no transcript READABLE cannot have produced a grounded candidate, and
   * `partitionReachable` finding nothing already fails earlier as `ConsolidatorUnavailable`.
   *
   * The set the client passes is now the REACHABLE one rather than the requested batch, which tightens
   * this rule: a citation of a session whose file never resolved is a fabricated receipt even if a
   * caller did ask about that session.
   */
  it("REJECTS every candidate when nothing was reachable", () => {
    expect(ungroundedEvidenceReason([candidate()], [])).not.toBeNull()
  })

  /**
   * The same rule over the COMMITMENTS list, which is not covered by the candidate arm: the two shapes
   * differ in evidence arity, so a single function cannot read both, and a commitment's session id
   * travels further than a candidate's — it keys a detected task and becomes that task's own
   * `memhtml-session` provenance, where a human reading the queue treats it as the place to go and
   * check.
   *
   * (Mutation: removing the `ungroundedCommitmentReason` call from `runTurn`, or making the function
   * return `null` unconditionally, fails the three cases below. Every candidate-arm case stays green,
   * which is exactly how quietly an ungrounded commitment would have shipped.)
   */
  it("REJECTS a commitment citing a session this run never made readable", () => {
    const reason = ungroundedCommitmentReason(
      [{ evidence: evidence("session-c", "I'll fix it tomorrow") }],
      READABLE
    )
    expect(reason).not.toBeNull()
    expect(reason).toContain("session-c")
    expect(reason).toContain("did not make readable")
    // It says COMMITMENT, so an operator reading the phase's detail knows which half to look at.
    expect(reason).toContain("commitment 0")
  })

  it("accepts commitments citing only readable sessions, and an empty list", () => {
    expect(
      ungroundedCommitmentReason([{ evidence: evidence("session-a", "quote") }], READABLE)
    ).toBeNull()
    expect(ungroundedCommitmentReason([], READABLE)).toBeNull()
  })

  it("names the OFFSET of the offending commitment", () => {
    const reason = ungroundedCommitmentReason(
      [
        { evidence: evidence("session-a", "grounded") },
        { evidence: evidence("session-z", "invented") }
      ],
      READABLE
    )
    expect(reason).toContain("commitment 1")
  })

  it("REJECTS every commitment when nothing was reachable", () => {
    expect(
      ungroundedCommitmentReason([{ evidence: evidence("session-a", "quote") }], [])
    ).not.toBeNull()
  })
})

describe("one answer is finite by contract", () => {
  /**
   * Every scalar field carries a ceiling and the LISTS have to as well, or one turn's answer is as
   * large as the model chooses: each evidence quote also costs a containment walk over the cited
   * transcript in `fabricatedQuoteReason`, so an unbounded list is unbounded verification work too.
   * The bounds are far above what the instructions ask for (six candidates, a handful of
   * commitments), so tripping one is an off-contract answer rather than a thorough one.
   *
   * (Mutation: removing any `isMaxLength` from the contract's list fields fails the matching case.)
   */
  it("REJECTS a payload with more candidates than the ceiling", () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_RESULT + 1 }, () => candidate())
    expect(Result.isFailure(decode({ candidates: many }))).toBe(true)
    expect(
      Result.isSuccess(decode({ candidates: Array.from({ length: 3 }, () => candidate()) }))
    ).toBe(true)
  })

  it("REJECTS a payload with more commitments than the ceiling", () => {
    const many = Array.from({ length: MAX_COMMITMENTS_PER_RESULT + 1 }, () => commitment())
    expect(Result.isFailure(decode({ candidates: [], commitments: many }))).toBe(true)
  })

  it("REJECTS a candidate with more evidence quotes than the ceiling", () => {
    const quotes = Array.from({ length: MAX_EVIDENCE_PER_CANDIDATE + 1 }, (_, i) =>
      evidence("session-a", `quote number ${String(i)}`)
    )
    expect(Result.isFailure(decode({ candidates: [candidate({ evidence: quotes })] }))).toBe(true)
  })

  it("REJECTS a candidate with more entities than the ceiling", () => {
    const entities = Array.from({ length: MAX_ENTITIES_PER_CANDIDATE + 1 }, (_, i) => ({
      type: "file",
      name: `entity-${String(i)}`
    }))
    expect(Result.isFailure(decode({ candidates: [candidate({ entities })] }))).toBe(true)
  })

  /**
   * The other side of every ceiling: EXACTLY the bound decodes.
   *
   * A cap tested only at MAX+1 pins the direction and not the value, so a later edit that tightened any
   * of these — to `MAX - 1`, or from `isMaxLength` to an exclusive check — would keep every rejection
   * case green while refusing answers the contract's own constants call legal. The instructions ask for
   * far less than these bounds, so the value that matters is not the model's typical answer but the
   * boundary the decode advertises.
   *
   * (Mutation: `isMaxLength(MAX_CANDIDATES_PER_RESULT - 1)` — or the same on any of the four — fails
   * here and nowhere else.)
   */
  it("ACCEPTS exactly the ceiling on all four lists", () => {
    const quotes = Array.from({ length: MAX_EVIDENCE_PER_CANDIDATE }, (_, i) =>
      evidence("session-a", `quote number ${String(i)}`)
    )
    const entities = Array.from({ length: MAX_ENTITIES_PER_CANDIDATE }, (_, i) => ({
      type: "file",
      name: `entity-${String(i)}`
    }))
    expect(
      Result.isSuccess(
        decode({
          candidates: Array.from({ length: MAX_CANDIDATES_PER_RESULT }, () => candidate()),
          commitments: []
        })
      )
    ).toBe(true)
    expect(
      Result.isSuccess(
        decode({
          candidates: [],
          commitments: Array.from({ length: MAX_COMMITMENTS_PER_RESULT }, () => commitment())
        })
      )
    ).toBe(true)
    expect(Result.isSuccess(decode({ candidates: [candidate({ evidence: quotes })] }))).toBe(true)
    expect(Result.isSuccess(decode({ candidates: [candidate({ entities })] }))).toBe(true)
  })
})

describe("watermarkableSessionIds advances the sessions the answer reports reading", () => {
  const READABLE = ["session-a", "session-b", "session-c"]
  /** The receipt an honest turn over the whole batch returns. */
  const READ_ALL = { readSessionIds: READABLE }

  /**
   * The rule reads ONLY the receipt, and its parameter type says so — the answer's findings are
   * deliberately not an input. An earlier version gated the advance on the answer carrying at least
   * one candidate or commitment, against a misrouted listener that is already inert without it (the
   * receiptless body it feared fails decode, and session ids never cross the wire — the rule's own
   * doc holds the whole argument), and issue #104 measured that gate's cost: the all-barren answer
   * with a full receipt is the one the instructions call "the right one for a batch that held nothing
   * durable", so an honest quiet night advanced nothing, the newest-first selection re-offered the
   * identical batch, and a ~2,000-session backlog never moved.
   *
   * An empty receipt still advances nothing: it is the honest answer of an agent that opened nothing,
   * and the sessions come back on a later night.
   *
   * (Mutation: reintroducing a finding gate makes the parameter type reject every caller and fails
   * the first case for any answer-shaped fixture; defaulting an empty receipt to the reachable set
   * fails the second.)
   */
  it("advances the whole receipt of a wholly barren answer, and nothing of an empty receipt", () => {
    expect(watermarkableSessionIds(READ_ALL, READABLE)).toEqual(READABLE)
    expect(watermarkableSessionIds({ readSessionIds: [] }, READABLE)).toEqual([])
  })

  /**
   * Issue #104's observed night, as a fixture: four reachable sessions, an answer carrying zero
   * candidates and zero commitments, and a read receipt naming one of the four. The phase's own
   * contract (`packages/sleep/src/phases/trace-consolidation.ts`, "Still the whole READ batch,
   * including the barren ones") says that one advances as read-with-nothing-above-the-bar.
   * Selection is newest-first over unconsolidated sessions, so a rule that advances nothing here
   * re-selects the identical batch every night and the backlog never moves.
   */
  it("advances the read-and-found-nothing sessions of a wholly barren answer (#104)", () => {
    expect(
      watermarkableSessionIds({ readSessionIds: ["session-b"] }, [
        "session-a",
        "session-b",
        "session-c",
        "session-d"
      ])
    ).toEqual(["session-b"])
  })

  it("advances exactly the READ sessions, not the whole reachable set", () => {
    /**
     * The receipt is what bounds the advance to what was opened. A rule that advanced every REACHABLE
     * session would watermark all 32 for a turn that read 1, and `trace_consolidations` is an
     * anti-join, so the 31 nobody opened would be lost rather than delayed.
     *
     * A receipt naming `session-a` alone advances `session-a` alone — and `session-b` and `session-c`
     * come back on a later night.
     *
     * (Mutation: returning `readableSessionIds` fails the first expectation.)
     */
    expect(watermarkableSessionIds({ readSessionIds: ["session-a"] }, READABLE)).toEqual([
      "session-a"
    ])
    expect(watermarkableSessionIds({ readSessionIds: ["session-a"] }, READABLE)).not.toContain(
      "session-c"
    )
  })

  /**
   * The receipt can only ever NARROW. A session the run did not make reachable is inert however the
   * answer names it, which is what bounds a model claim to something the caller measured — and it is why
   * an id outside the set does not refuse the whole turn the way a fabricated EVIDENCE id does.
   */
  it("cannot advance a session the run never made reachable", () => {
    expect(
      watermarkableSessionIds({ readSessionIds: ["session-z", "session-b"] }, READABLE)
    ).toEqual(["session-b"])
    expect(watermarkableSessionIds(READ_ALL, [])).toEqual([])
  })

  /** Reachable order is preserved, so a report line and a test's `toEqual` are reproducible. */
  it("returns the reachable order, not the receipt's", () => {
    expect(
      watermarkableSessionIds({ readSessionIds: ["session-c", "session-a", "session-b"] }, READABLE)
    ).toEqual(READABLE)
  })

  /** A padded id in the receipt still matches: neither side controls the whitespace around an id. */
  it("trims the receipt's ids before matching", () => {
    expect(watermarkableSessionIds({ readSessionIds: ["  session-b  "] }, READABLE)).toEqual([
      "session-b"
    ])
  })
})

describe("a wide read claim behind narrow quotes is logged", () => {
  /** Enough sessions for the ratio to carry signal; below eight the rule declines to speak. */
  const batchOf = (count: number): ReadonlyArray<string> =>
    Array.from({ length: count }, (_, i) => `session-${String(i)}`)

  /** One candidate quoting one session twice: the answer a truncated or lazy turn returns. */
  const oneSessionCandidate = (sessionId: string) =>
    candidate({
      evidence: [evidence(sessionId, "the first line"), evidence(sessionId, "the second line")]
    })

  /**
   * THE residual `readSessionIds` cannot close. The receipt is a model CLAIM, so a turn that opened one
   * transcript and NAMES thirty-two advances thirty-two, and the 31 it never read are gone because the
   * selection is an anti-join. The quotes are the verified half, so the gap between what the answer
   * claims and what it can prove is the only measurable signal, and this line is where it is measured.
   *
   * (Mutation: returning `null` unconditionally, or counting evidence QUOTES rather than distinct
   * sessions, fails this case — two quotes from one session is one session's receipt.)
   */
  it("warns when a wide receipt advances on quotes from a small fraction of it", () => {
    const readable = batchOf(32)
    const warning = underCitedWatermarkWarning(
      {
        candidates: [oneSessionCandidate("session-0")],
        commitments: [],
        readSessionIds: readable
      },
      readable
    )
    expect(warning).not.toBeNull()
    // The three counts an operator acts on: what advanced, what cited, and what advanced uncited.
    expect(warning).toContain("watermarking 32")
    expect(warning).toContain("only 1 of them")
    expect(warning).toContain("other 31")
  })

  /**
   * An HONEST narrow turn is silent, and this is the case the receipt buys. A turn that opened one
   * transcript and says so advances one session, which is below the minimum the ratio speaks about — so
   * the operator sees a line only when a wide CLAIM is not backed by wide quoting.
   *
   * (Mutation: computing `advancing` from `readableSessionIds` rather than from the advance fails here,
   * because the reachable set is 32 while the honest advance is 1.)
   */
  it("says nothing for an honest turn that reads one session and names one", () => {
    const readable = batchOf(32)
    expect(
      underCitedWatermarkWarning(
        {
          candidates: [oneSessionCandidate("session-0")],
          commitments: [],
          readSessionIds: ["session-0"]
        },
        readable
      )
    ).toBeNull()
  })

  /**
   * A thorough turn is silent. The threshold is a quarter of the advance, and a run citing eight of 32
   * sessions is the shape the instructions ask for — a warning there teaches an operator to ignore the
   * line by the time a one-session receipt arrives.
   */
  it("says nothing when a quarter or more of the advance is cited", () => {
    const readable = batchOf(32)
    const candidates = Array.from({ length: 8 }, (_, i) =>
      oneSessionCandidate(`session-${String(i)}`)
    )
    expect(
      underCitedWatermarkWarning(
        { candidates, commitments: [], readSessionIds: readable },
        readable
      )
    ).toBeNull()
  })

  /** Commitments are receipts too: a commitment's session is cited exactly as a candidate's is. */
  it("counts cited sessions across BOTH lists", () => {
    const readable = batchOf(12)
    const commitments = Array.from({ length: 3 }, (_, i) =>
      commitment({
        evidence: evidence(`session-${String(i)}`, "I'll wire capture before we cut the release")
      })
    )
    expect(
      underCitedWatermarkWarning(
        {
          candidates: [oneSessionCandidate("session-9")],
          commitments,
          readSessionIds: readable
        },
        readable
      )
    ).toBeNull()
    // The same four sessions cited against a claim three times as wide does warn.
    expect(
      underCitedWatermarkWarning(
        {
          candidates: [oneSessionCandidate("session-9")],
          commitments,
          readSessionIds: batchOf(32)
        },
        batchOf(32)
      )
    ).not.toBeNull()
  })

  /**
   * A citation OUTSIDE the advance is not a receipt for the advance, and the two failures it causes pull
   * in opposite directions.
   *
   * First arm: eight sessions advance on the receipt alone and the only quotes name two REACHABLE
   * sessions the receipt left out. Counting those two puts `cited.size` at the quarter floor and the line
   * goes silent, while ZERO of the advancing eight carries a citation — the exact shape the rule exists
   * to surface, suppressed by evidence about a different set.
   *
   * Second arm: a wide claim whose one quote names a session outside the advance. The line must fire, and
   * both of its numbers must be in the advancing space — `0 of them` cited, `32` uncited. A count over
   * the whole answer prints `1` and `31`, neither of which is true of any set.
   *
   * (Mutation: counting every cited session id regardless of the advance makes the first arm return a
   * string and prints `only 1 of them` in the second.)
   */
  it("counts a citation only when the session it names is one the watermark advances", () => {
    const advance = batchOf(8)
    const reachable = [...advance, "session-outside-a", "session-outside-b"]
    expect(
      underCitedWatermarkWarning(
        {
          candidates: [oneSessionCandidate("session-outside-a")],
          commitments: [
            commitment({
              evidence: evidence("session-outside-b", "I'll wire capture before we cut the release")
            })
          ],
          readSessionIds: advance
        },
        reachable
      )
    ).not.toBeNull()

    const wide = batchOf(32)
    const warning = underCitedWatermarkWarning(
      {
        candidates: [oneSessionCandidate("session-elsewhere")],
        commitments: [],
        readSessionIds: wide
      },
      [...wide, "session-elsewhere"]
    )
    expect(warning).toContain("watermarking 32")
    expect(warning).toContain("only 0 of them")
    expect(warning).toContain("other 32")
  })

  /**
   * A wholly barren answer claiming a WIDE read is exactly the shape this line exists for: since
   * issue #104's fix, that receipt advances all 32, it cites zero of them, and a truncated turn
   * returning empty lists over a wide receipt is indistinguishable here from a thorough quiet night —
   * so the line fires and the operator decides. A small advance stays quiet either way: one citation
   * out of two is both the floor and the ordinary shape of a two-transcript night.
   */
  it("warns for a barren answer advancing a wide receipt, and stays silent for a small advance", () => {
    const barren = underCitedWatermarkWarning(
      { candidates: [], commitments: [], readSessionIds: batchOf(32) },
      batchOf(32)
    )
    expect(barren).toContain("watermarking 32")
    expect(barren).toContain("only 0 of them")
    expect(
      underCitedWatermarkWarning(
        {
          candidates: [oneSessionCandidate("session-0")],
          commitments: [],
          readSessionIds: batchOf(4)
        },
        batchOf(4)
      )
    ).toBeNull()
  })
})

describe("the kind vocabulary is a subset of the corpus vocabulary", () => {
  it("every consolidation kind is a real memory type", () => {
    for (const kind of CONSOLIDATION_KINDS) {
      expect(MEMORY_TYPES).toContain(kind)
      expect(isConsolidationKind(kind)).toBe(true)
    }
  })

  it("excludes the four types a transcript pattern cannot earn", () => {
    for (const excluded of ["task", "user_preference", "verdict", "arc"]) {
      expect(CONSOLIDATION_KINDS as readonly string[]).not.toContain(excluded)
      expect(isConsolidationKind(excluded)).toBe(false)
    }
  })
})

describe("the derived JSON Schema eve is handed", () => {
  const schema = CONSOLIDATION_OUTPUT_JSON_SCHEMA as Record<string, unknown>

  /**
   * The regression guard for a real defect found while building this. Raw
   * `toJsonSchemaDocument(ConsolidationPayload)` returns a root of
   * `{ $ref: "#/$defs/ConsolidationPayloadJsonEncoding", $defs: {...} }` — a root with no `type`
   * and no `properties`, so anything reading `schema.type` to constrain the model finds
   * `undefined`. `toJsonSchema` inlines the root definition; if that step is dropped, this fails.
   */
  it("has a CONCRETE object root, not a bare $ref", () => {
    expect(schema.type).toBe("object")
    expect(schema.properties).toHaveProperty("candidates")
    expect(schema.properties).toHaveProperty("commitments")
    expect(schema.properties).toHaveProperty("readSessionIds")
    expect(schema.$ref).toBeUndefined()
  })

  /**
   * The commitments half has to reach the MODEL, not only the decoder. eve lowers this document to the
   * model's structured-output contract, so a field absent here is a field the model is never asked
   * for — and then the required-field decode refuses every turn, which is the loudest possible way to
   * discover it and still a wasted call.
   *
   * (Mutation: dropping `commitments` from `ConsolidationPayload` fails this and the two cases above.)
   */
  it("describes the commitment item shape through a resolvable $ref", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const commitments = properties.commitments
    if (commitments === undefined) throw new Error("schema.properties.commitments is missing")
    expect(commitments.type).toBe("array")
    const ref = (commitments.items as Record<string, unknown>).$ref
    if (typeof ref !== "string") throw new Error(`commitments.items has no $ref: ${String(ref)}`)
    const defs = schema.$defs as Record<string, Record<string, unknown> | undefined>
    const target = defs[ref.slice("#/$defs/".length)]
    if (target === undefined) throw new Error(`commitments.items.$ref does not resolve: ${ref}`)
    expect(target.type).toBe("object")
    // Every field the phase's post-filter reads, so a schema that stopped publishing one is caught.
    for (const field of ["statement", "actor", "evidence", "confidence", "resolved"]) {
      expect(target.properties).toHaveProperty(field)
    }
    // `resolved` and `confidence` are REQUIRED: an omitted `resolved` would default to nothing and the
    // closure arm would be unreachable, and an omitted confidence has no floor to clear.
    expect(target.required).toEqual(["statement", "actor", "evidence", "confidence", "resolved"])
  })

  /**
   * `dueHint` publishes the FLAT string-or-null union, which is the wire fix `apps/mcp/src/tools.ts`
   * records: a bare `Schema.optional` publishes a schema accepting `null` that the decoder then
   * rejects, so a producer doing the obvious thing for "no due date" fails a call the contract called
   * valid. `optionalKey(NullOr(...))` accepts all three forms and publishes them.
   */
  it("publishes dueHint as an optional string-or-null, not a decoder trap", () => {
    const defs = schema.$defs as Record<string, Record<string, unknown>>
    const target = Object.values(defs).find((def) =>
      Object.hasOwn((def.properties ?? {}) as object, "dueHint")
    )
    if (target === undefined) throw new Error("no definition carries dueHint")
    expect(target.required as string[]).not.toContain("dueHint")
    const dueHint = (target.properties as Record<string, Record<string, unknown>>).dueHint
    expect(dueHint?.anyOf).toEqual([{ type: "string" }, { type: "null" }])
  })

  it("carries the closed actor vocabulary", () => {
    const rendered = JSON.stringify(schema)
    for (const actor of COMMITMENT_ACTORS) expect(rendered).toContain(`"${actor}"`)
  })

  it("keeps the root's own constraints after inlining", () => {
    expect(schema.required).toEqual(["candidates", "commitments", "readSessionIds"])
    expect(schema.additionalProperties).toBe(false)
  })

  /**
   * The read receipt has to reach the MODEL, not only the decoder. It is the field the watermark
   * advances over, so a schema that stopped publishing it would be asking for an answer that then fails
   * the required-field decode on every turn — the loudest possible way to discover it and still a wasted
   * call every night.
   *
   * A plain string array with the transcript cap as `maxItems`, asserted here rather than inferred: the
   * bound is what tells the model the list is a per-session receipt over a bounded batch and not a place
   * to write prose.
   *
   * (Mutation: dropping `readSessionIds` from `ConsolidationPayload` fails this and the two cases above.)
   */
  it("publishes the read receipt as a bounded array of strings", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const receipt = properties.readSessionIds
    if (receipt === undefined) throw new Error("schema.properties.readSessionIds is missing")
    expect(receipt.type).toBe("array")
    expect((receipt.items as Record<string, unknown>).type).toBe("string")
    expect(receipt.maxItems).toBe(MAX_TRANSCRIPTS_PER_RUN)
  })

  /** The nested refs must survive the root inlining, or the item shape is lost. */
  it("still describes candidate items through $defs", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const candidates = properties.candidates
    // Thrown, not `expect`ed: this narrows for `noUncheckedIndexedAccess` AND keeps a missing
    // `candidates` — the exact regression this test exists to catch — reported as itself, rather
    // than as a TypeError from indexing `undefined` on the next line.
    if (candidates === undefined) throw new Error("schema.properties.candidates is missing")
    expect(candidates.type).toBe("array")
    const items = candidates.items as Record<string, unknown>
    // The pointer's TARGET is the contract, not the name the schema library derives for it: the
    // generated `$defs` key tracks Effect's own encoding-name convention, while a pointer that does
    // not RESOLVE is the defect this guards. So assert the ref is a `$defs` pointer and that the
    // definition behind it is the candidate shape — which fails on a lost ref, a dangling ref, and
    // a ref retargeted at something else, and survives a rename that changes nothing.
    const ref = items.$ref
    if (typeof ref !== "string") throw new Error(`candidates.items has no $ref: ${String(ref)}`)
    expect(ref).toMatch(/^#\/\$defs\//)
    const defs = schema.$defs as Record<string, Record<string, unknown> | undefined>
    const target = defs[ref.slice("#/$defs/".length)]
    if (target === undefined) throw new Error(`candidates.items.$ref does not resolve: ${ref}`)
    expect(target.type).toBe("object")
    expect(target.properties).toHaveProperty("claim")
    expect(target.properties).toHaveProperty("evidence")
  })

  /**
   * The entity's TWO HALVES have to reach the MODEL as an object with both fields required.
   *
   * This is the whole mechanism by which a typed reference arrives, and it is why the shape is an
   * object rather than a string with a `pattern`: a provider's strict-mode structured output enforces
   * a required object field, and a `pattern` on a string it does not. A schema publishing
   * `{"type": "string"}` here would be asked for bare names again, every candidate would file under
   * `unknown`, and the decode would accept it — the wire schema is the only place that is visible.
   *
   * `additionalProperties: false` matters for the same reason `strict: true` demands it in
   * `apps/cli/src/extraction.ts`: a lax item schema invites a third key the join would ignore.
   *
   * (Mutation: `entities: Schema.Array(Schema.String.check(Schema.isMinLength(1)))` publishes
   * `items: {type: "string"}` with no `$ref`, and fails on the ref lookup below.)
   */
  it("publishes the entity item as an object requiring both type and name", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const candidates = properties.candidates
    if (candidates === undefined) throw new Error("schema.properties.candidates is missing")
    const defs = schema.$defs as Record<string, Record<string, unknown> | undefined>
    const candidateRef = (candidates.items as Record<string, unknown>).$ref
    if (typeof candidateRef !== "string") throw new Error("candidates.items has no $ref")
    const candidateDef = defs[candidateRef.slice("#/$defs/".length)]
    if (candidateDef === undefined) throw new Error(`unresolved ref ${candidateRef}`)
    const entities = (candidateDef.properties as Record<string, Record<string, unknown>>).entities
    if (entities === undefined) throw new Error("the candidate definition has no entities")
    expect(entities.type).toBe("array")
    const entityRef = (entities.items as Record<string, unknown>).$ref
    if (typeof entityRef !== "string") {
      throw new Error(`entities.items is not an object ref: ${JSON.stringify(entities.items)}`)
    }
    const entity = defs[entityRef.slice("#/$defs/".length)]
    if (entity === undefined) throw new Error(`unresolved ref ${entityRef}`)
    expect(entity.type).toBe("object")
    expect(entity.required).toEqual(["type", "name"])
    expect(entity.additionalProperties).toBe(false)
    /**
     * The type is a plain string and NOT an enum, asserted on the wire because that is where a closed
     * vocabulary would be imposed on a consumer. memhtml does not own a consumer's entity taxonomy.
     */
    const type = (entity.properties as Record<string, Record<string, unknown>>).type
    expect(type?.type).toBe("string")
    expect(type?.enum).toBeUndefined()
  })

  /**
   * The two-quote bar has to reach the MODEL, not only the decoder. Without this the schema would
   * ask for any-length evidence and the bar would only be discovered at decode time, turning a
   * guidable constraint into a wasted turn.
   */
  it("carries the minimum-two-evidence constraint into the wire schema", () => {
    expect(JSON.stringify(schema)).toContain('"minItems":2')
  })

  it("carries the closed kind vocabulary, and none of the excluded types", () => {
    const rendered = JSON.stringify(schema)
    for (const kind of CONSOLIDATION_KINDS) expect(rendered).toContain(`"${kind}"`)
    expect(rendered).not.toContain('"task"')
    expect(rendered).not.toContain('"user_preference"')
  })

  /**
   * `toJsonSchemaDocument` hoists nested structs into `definitions` and leaves
   * `$ref: "#/$defs/<name>"` behind. If the fold in `toJsonSchema` regressed, the refs would
   * dangle and the model would be handed a schema it cannot resolve.
   */
  it("leaves no dangling $ref: every ref resolves into $defs", () => {
    const refs: string[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (typeof node !== "object" || node === null) return
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") refs.push(value)
        else walk(value)
      }
    }
    walk(schema)

    const defs = (schema.$defs ?? {}) as Record<string, unknown>
    for (const ref of refs) {
      expect(ref.startsWith("#/$defs/")).toBe(true)
      expect(defs).toHaveProperty(ref.slice("#/$defs/".length))
    }
    // Guard the guard: if nothing nested, the walk above proves nothing, so assert the shape
    // that makes the test meaningful.
    expect(refs.length > 0 || Object.keys(defs).length === 0).toBe(true)
  })

  it("is JSON-serializable, since it crosses the wire as a request body", () => {
    expect(() => JSON.stringify(schema)).not.toThrow()
  })
})
