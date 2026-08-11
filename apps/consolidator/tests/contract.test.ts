import { MEMORY_TYPES } from "@memhtml/contracts"
import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CandidateMemory,
  CONSOLIDATION_KINDS,
  CONSOLIDATION_OUTPUT_JSON_SCHEMA,
  ConsolidationPayload,
  isConsolidationKind,
  MAX_CLAIM_CHARS,
  MAX_QUOTE_CHARS,
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
    expect(items.$ref).toBe("#/$defs/CandidateMemoryJsonEncoding")
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
