import { MEMORY_TYPES } from "@memhtml/contracts"
import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CandidateMemory,
  CONSOLIDATION_KINDS,
  CONSOLIDATION_OUTPUT_JSON_SCHEMA,
  Commitment,
  ConsolidationPayload,
  isConsolidationKind,
  MAX_CLAIM_CHARS,
  MAX_QUOTE_CHARS,
  quoteAppearsIn,
  Resolution,
  ungroundedEvidenceReason
} from "../src/contract.js"

/**
 * The decode tier. No credentials, no eve server, no network — INV-3 keeps CI credential-free, so
 * every test here runs on a schema and a plain object.
 *
 * The decode posture under test is `packages/llm/src/structured.ts:52-61`'s: a coerced object is
 * indistinguishable from a real one downstream, so every assertion below is that a bad payload
 * FAILS rather than being quietly repaired.
 */

const decode = (payload: unknown): Result.Result<ConsolidationPayload, unknown> =>
  Effect.runSync(
    Effect.result(
      Schema.decodeUnknownEffect(ConsolidationPayload, { onExcessProperty: "error" })(payload)
    )
  )

const evidence = (sessionId: string, quote: string) => ({ sessionId, quote })

const candidate = (overrides: Record<string, unknown> = {}) => ({
  kind: "error_pattern",
  claim: "The batch importer fails on empty CSV headers across sessions.",
  gist: "Three sessions hit the same TypeError from a header-less CSV; the fix each time was to pass an explicit header list.",
  entities: ["importer.ts", "papaparse"],
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

  it("accepts empty entities but rejects an empty entity string", () => {
    expect(Result.isSuccess(decode({ candidates: [candidate({ entities: [] })] }))).toBe(true)
    expect(Result.isFailure(decode({ candidates: [candidate({ entities: [""] })] }))).toBe(true)
  })

  it("decodes to the class, so downstream code gets the declared type", () => {
    const result = decode({ candidates: [candidate()] })
    if (!Result.isSuccess(result)) throw new Error("expected success")
    const first = result.success.candidates[0]
    expect(first).toBeInstanceOf(CandidateMemory)
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

  /**
   * The three lists are passed as ONE argument rather than three positional parameters, so a fourth
   * evidence-carrying list added to `ConsolidationPayload` cannot silently skip the walk: it has to be
   * added to the argument type to typecheck at the client's one call site.
   */
  const answer = (overrides: Partial<Parameters<typeof ungroundedEvidenceReason>[0]> = {}) => ({
    candidates: [candidate()],
    commitments: [],
    resolutions: [],
    ...overrides
  })

  it("accepts candidates citing only readable sessions", () => {
    expect(ungroundedEvidenceReason(answer(), READABLE)).toBeNull()
  })

  it("accepts an empty answer, which cites nothing at all", () => {
    expect(ungroundedEvidenceReason(answer({ candidates: [] }), READABLE)).toBeNull()
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
      answer({
        candidates: [
          candidate({
            evidence: [
              evidence("session-a", "TypeError: Cannot read properties of undefined"),
              evidence("session-c", "a quote from a session that was never provided")
            ]
          })
        ]
      }),
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
      answer({
        candidates: [candidate(), candidate({ evidence: [evidence("session-z", "invented")] })]
      }),
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
    expect(ungroundedEvidenceReason(answer(), [])).not.toBeNull()
  })

  /**
   * The check reaches the two NEWER lists, and this is the case AC-4-1 turns on. A commitment rides
   * into the sleep phase and out to the user as something THEY said, whose whole recourse is to open the
   * cited session and read the line — so an id naming a session nobody opened is a fabricated receipt in
   * exactly the sense a candidate's is, and the same whole-turn refusal applies.
   *
   * (Mutation: dropping the `answer.commitments` loop from `ungroundedEvidenceReason` fails this and
   * the two below it, while every candidate case above still passes. That is why they are separate.)
   */
  it("REJECTS a commitment citing a session this run never made readable", () => {
    const reason = ungroundedEvidenceReason(
      answer({
        candidates: [],
        commitments: [{ evidence: { sessionId: "session-c" } }]
      }),
      READABLE
    )
    expect(reason).not.toBeNull()
    expect(reason).toContain("commitment 0")
    expect(reason).toContain("session-c")
    expect(reason).toContain("did not make readable")
  })

  it("REJECTS a resolution citing a session this run never made readable", () => {
    const reason = ungroundedEvidenceReason(
      answer({ candidates: [], resolutions: [{ evidence: { sessionId: "session-z" } }] }),
      READABLE
    )
    expect(reason).toContain("resolution 0")
    expect(reason).toContain("session-z")
  })

  it("accepts commitments and resolutions citing readable sessions", () => {
    expect(
      ungroundedEvidenceReason(
        answer({
          commitments: [{ evidence: { sessionId: "session-a" } }],
          resolutions: [{ evidence: { sessionId: "session-b" } }]
        }),
        READABLE
      )
    ).toBeNull()
  })
})

/**
 * The verbatim-quote check, which is the one grounding rule that opens a file.
 *
 * `ungroundedEvidenceReason` above proves a quote is ATTRIBUTED to a session the run read; it never
 * reads the transcript, so a model that legitimately opened `session-a` and then wrote a plausible line
 * from it passes it cleanly. For a commitment that residual gap is the whole product: the corpus tells
 * the user "you said you would do X", and the only thing behind that is the quote.
 *
 * A pure function over two strings, so this tier needs no transcript on disk and no server.
 */
describe("a commitment quote must really appear in the transcript", () => {
  const TRANSCRIPT =
    '{"role":"user","content":"I\'ll wire the retry next session, once the pin lands"}\n' +
    '{"role":"assistant","content":"Noted. I will leave the migration until the review."}\n'

  it("finds a quote that is verbatim in the file", () => {
    expect(quoteAppearsIn("I'll wire the retry next session", TRANSCRIPT)).toBe(true)
  })

  /**
   * The normalization that makes this usable rather than lenient. Transcripts are JSONL, so a model
   * quoting across a wrapped line legitimately renders one run of whitespace differently from the
   * file — a newline for a space, a doubled space, leading indentation. Every one of those is the same
   * sentence, so collapsing runs on both sides is the one difference a faithful quote may have.
   */
  it("tolerates whitespace variance in either direction", () => {
    expect(quoteAppearsIn("I'll wire the   retry\n next session", TRANSCRIPT)).toBe(true)
    expect(quoteAppearsIn("  I'll wire the retry next session  ", TRANSCRIPT)).toBe(true)
    expect(
      quoteAppearsIn("I'll wire the retry next session", "I'll wire\tthe retry\nnext session")
    ).toBe(true)
  })

  /**
   * The fabrication this exists to catch, and it is the realistic shape rather than a nonsense string:
   * a paraphrase of a line that IS in the file, from a session that WAS read. Nothing before this check
   * refuses it.
   */
  it("REJECTS a paraphrase of a line that is really there", () => {
    expect(quoteAppearsIn("I will wire the retry next session", TRANSCRIPT)).toBe(false)
    expect(quoteAppearsIn("I'll wire up the retry next session", TRANSCRIPT)).toBe(false)
  })

  /**
   * Only WHITESPACE is normalized. Case and punctuation are each a way a "quote" can differ from the
   * line in a way that changes what it says, so they are compared as written.
   */
  it("does not normalize case or punctuation", () => {
    expect(quoteAppearsIn("i'll wire the retry next session", TRANSCRIPT)).toBe(false)
    expect(quoteAppearsIn("I'll wire the retry next session!", TRANSCRIPT)).toBe(false)
  })

  /**
   * Guard the guard: `"".includes` is TRUE against anything, so an empty or whitespace-only needle
   * would make the check pass unconditionally — a gate that cannot fail. The schema's `minLength(1)`
   * already refuses an empty quote, and this refuses it a second time at the point of use, because a
   * check whose degenerate input passes is worse than no check.
   */
  it("REJECTS an empty or whitespace-only quote rather than matching everything", () => {
    expect(quoteAppearsIn("", TRANSCRIPT)).toBe(false)
    expect(quoteAppearsIn("   \n  ", TRANSCRIPT)).toBe(false)
  })

  it("REJECTS any quote against an empty transcript", () => {
    expect(quoteAppearsIn("I'll wire the retry next session", "")).toBe(false)
  })
})

/**
 * The wire-compatibility rule, and it needs its own gate because it is a behavior nothing else asserts:
 * a stated invariant with no test is not an invariant.
 *
 * `commitments` and `resolutions` are optional-with-default-`[]` while `candidates` is required, and the
 * asymmetry is about BUILDS rather than answers. The `outputSchema` is composed per turn so decoder and
 * wire schema cannot skew, but the INSTRUCTIONS bake into an agent build that `resolveAgentAppRoot`
 * reuses per package version — so an operator with a warm `.output/` runs today's schema against an
 * agent never told these lists exist. Required keys would fail every such turn and throw away the
 * candidates that build still produces correctly.
 */
describe("commitments and resolutions on the wire", () => {
  const commitment = (overrides: Record<string, unknown> = {}) => ({
    statement: "The user will wire the retry before the pin lands.",
    actor: "user",
    evidence: evidence("session-a", "I'll wire the retry next session"),
    confidence: 0.8,
    ...overrides
  })

  const resolution = (overrides: Record<string, unknown> = {}) => ({
    statement: "The retry is merged.",
    evidence: evidence("session-b", "merged the retry branch"),
    confidence: 0.9,
    ...overrides
  })

  /**
   * The compatibility case. An OLD agent build answers the old shape, and it must decode — with both
   * lists `[]` rather than absent, so nothing downstream has to ask whether a missing list means
   * "found none" or "was never asked".
   *
   * (Mutation: making either field required, or dropping the `withDecodingDefaultKey`, fails this.)
   */
  it("decodes a payload with NEITHER key, defaulting both to []", () => {
    const result = decode({ candidates: [candidate()] })
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.commitments).toEqual([])
    expect(result.success.resolutions).toEqual([])
  })

  it("round-trips a payload carrying both", () => {
    const result = decode({
      candidates: [],
      commitments: [commitment()],
      resolutions: [resolution()]
    })
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.commitments[0]).toBeInstanceOf(Commitment)
    expect(result.success.resolutions[0]).toBeInstanceOf(Resolution)
    expect(result.success.commitments[0]?.actor).toBe("user")
  })

  /**
   * `candidates` stays REQUIRED, and defaulting it would be the real regression: an agent that returned
   * `{}` where it meant `{"candidates": []}` produced a truncated answer, and a default would decode
   * that truncation as a clean empty result.
   */
  it("still REJECTS a payload with no candidates key at all", () => {
    expect(Result.isFailure(decode({ commitments: [], resolutions: [] }))).toBe(true)
  })

  it("accepts an omitted dueHint and a stated one", () => {
    expect(Result.isSuccess(decode({ candidates: [], commitments: [commitment()] }))).toBe(true)
    expect(
      Result.isSuccess(
        decode({ candidates: [], commitments: [commitment({ dueHint: "before the review" })] })
      )
    ).toBe(true)
  })

  /**
   * `optionalKey` is EXACT-optional, so the only spelling of absent is an absent key. `optional` would
   * be `optionalKey(UndefinedOr(S))`, which publishes a `{"type": "null"}` branch in the wire schema
   * that the decoder then refuses — the model would be shown the exact spelling that fails the turn.
   */
  it("REJECTS a null dueHint, because absent is spelled by omitting the key", () => {
    expect(
      Result.isFailure(decode({ candidates: [], commitments: [commitment({ dueHint: null })] }))
    ).toBe(true)
    expect(
      Result.isFailure(decode({ candidates: [], commitments: [commitment({ dueHint: "" })] }))
    ).toBe(true)
  })

  it("REJECTS an actor outside the two speakers a transcript records", () => {
    expect(
      Result.isFailure(decode({ candidates: [], commitments: [commitment({ actor: "system" })] }))
    ).toBe(true)
    expect(
      Result.isFailure(decode({ candidates: [], commitments: [commitment({ actor: "" })] }))
    ).toBe(true)
  })

  /**
   * `Schema.Finite`, not `Schema.Number`: `Number` accepts `NaN` and derives an `anyOf` with a string
   * branch for `"Infinity"`/`"NaN"` in the wire schema. A confidence outside 0..1 is a number the
   * consumer's own threshold cannot reason about.
   */
  it("REJECTS a confidence outside 0..1, and a non-finite one", () => {
    for (const bad of [1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        Result.isFailure(decode({ candidates: [], commitments: [commitment({ confidence: bad })] }))
      ).toBe(true)
      expect(
        Result.isFailure(decode({ candidates: [], resolutions: [resolution({ confidence: bad })] }))
      ).toBe(true)
    }
    // The boundaries themselves are IN range, or a firmly-stated commitment could not be reported.
    expect(
      Result.isSuccess(decode({ candidates: [], commitments: [commitment({ confidence: 1 })] }))
    ).toBe(true)
    expect(
      Result.isSuccess(decode({ candidates: [], commitments: [commitment({ confidence: 0 })] }))
    ).toBe(true)
  })

  it("REJECTS a statement past the claim ceiling, and an empty one", () => {
    for (const bad of ["x".repeat(MAX_CLAIM_CHARS + 1), ""]) {
      expect(
        Result.isFailure(decode({ candidates: [], commitments: [commitment({ statement: bad })] }))
      ).toBe(true)
      expect(
        Result.isFailure(decode({ candidates: [], resolutions: [resolution({ statement: bad })] }))
      ).toBe(true)
    }
  })

  /**
   * ONE evidence quote, not an array, and that asymmetry with a candidate's two is the contract: a
   * commitment IS a single sentence someone said, so the sentence is the whole evidence.
   */
  it("takes one evidence object rather than an array of them", () => {
    expect(
      Result.isFailure(
        decode({
          candidates: [],
          commitments: [commitment({ evidence: [evidence("session-a", "quote")] })]
        })
      )
    ).toBe(true)
  })

  it("REJECTS an undeclared extra key on either, instead of stripping it", () => {
    expect(
      Result.isFailure(
        decode({ candidates: [], commitments: [commitment({ actorName: "laith" })] })
      )
    ).toBe(true)
    expect(
      Result.isFailure(decode({ candidates: [], resolutions: [resolution({ actor: "user" })] }))
    ).toBe(true)
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
    expect(schema.$ref).toBeUndefined()
  })

  it("keeps the root's own constraints after inlining", () => {
    expect(schema.required).toEqual(["candidates"])
    expect(schema.additionalProperties).toBe(false)
  })

  /**
   * The optional-with-default fields have to reach the MODEL, described but not required. Described,
   * or the agent is never told the shape to fill; not required, or a warm agent build that predates
   * them fails every turn. `required` above already pins the second half — this pins the first, which
   * a `required` assertion alone would let regress to the fields vanishing entirely.
   */
  it("describes commitments and resolutions without requiring them", () => {
    const properties = schema.properties as Record<string, Record<string, unknown> | undefined>
    for (const name of ["commitments", "resolutions"]) {
      const field = properties[name]
      if (field === undefined) throw new Error(`schema.properties.${name} is missing`)
      expect(field.type).toBe("array")
      expect(schema.required as readonly string[]).not.toContain(name)
    }
  })

  /**
   * The constraints a model can actually be guided by, asserted on the rendered document rather than
   * navigated to: the shared `CandidateEvidence` reached through `Commitment.evidence` hoists to a
   * `$defs` key whose NAME is effect's own encoding convention and not a contract, so the walk to it
   * would be asserting the generated name.
   */
  it("carries the commitment vocabulary and the 0..1 confidence bound", () => {
    const properties = schema.properties as Record<string, Record<string, unknown> | undefined>
    const rendered = JSON.stringify(properties.commitments)
    expect(rendered).toContain('"user"')
    expect(rendered).toContain('"assistant"')
    expect(rendered).toContain('"minimum":0')
    expect(rendered).toContain('"maximum":1')
    // `dueHint` is described but outside the item's own `required`, so absent is a legal answer.
    expect(rendered).toContain("dueHint")
    expect(rendered).not.toContain('"dueHint","evidence"')
  })

  /**
   * The published schema must not advertise a spelling of absent that the DECODER refuses, and this is
   * the gate that pins it — the decode test alone cannot, because `optional` and `optionalKey` both
   * reject `dueHint: null` and differ only in what the model is TOLD.
   *
   * `Schema.optional` is `optionalKey(UndefinedOr(S))`, which publishes `anyOf: [{type: "string"},
   * {type: "null"}]`. A model reading that sends `dueHint: null` for a commitment with no stated due
   * date, which is the overwhelmingly common case, and the whole turn then fails decode over an absent
   * optional. `packages/llm/src/structured.ts` records the same hazard on the MCP wire.
   *
   * (Mutation: `Schema.optionalKey` → `Schema.optional` on `dueHint` fails this case and nothing else
   * in the file, which is exactly why it is here.)
   */
  it("does not publish a null branch for the optional dueHint", () => {
    const properties = schema.properties as Record<string, Record<string, unknown> | undefined>
    const commitments = properties.commitments
    if (commitments === undefined) throw new Error("schema.properties.commitments is missing")
    const item = commitments.items as Record<string, Record<string, unknown> | undefined>
    const itemProperties = item.properties
    if (itemProperties === undefined) throw new Error("the commitment item has no properties")
    expect(JSON.stringify(itemProperties.dueHint)).toBe(
      JSON.stringify({ type: "string", allOf: [{ minLength: 1 }] })
    )
  })

  /**
   * `Schema.Finite`, not `Schema.Number`, on both confidences. `Number` derives an `anyOf` carrying a
   * STRING branch for `"Infinity"` and `"NaN"`, which tells the model a string is an acceptable
   * confidence — the house lesson `packages/llm/src/structured.ts:28-31` records.
   */
  it("publishes confidence as a plain number, with no string branch for NaN", () => {
    const rendered = JSON.stringify(schema)
    expect(rendered).not.toContain('"NaN"')
    expect(rendered).not.toContain('"Infinity"')
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
