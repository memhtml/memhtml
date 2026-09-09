import {
  CandidateMemory,
  fabricatedQuoteReason,
  type ReachableTranscript,
  ungroundedEvidenceReason
} from "@memhtml/consolidator"
import { candidateRefusalFor } from "@memhtml/sleep"
import { Effect, Result, Schema } from "effect"

/**
 * The write-path gate, composed from the production functions in the order the fleet runs them.
 *
 * A consolidated candidate memory crosses four deterministic checks between the model's answer and
 * the tree, and none of them is re-implemented here. Each stage below IS the production function,
 * imported, and the composition mirrors the two call sites that run them:
 *
 * 1. `door:schema` — `Schema.decodeUnknownResult(CandidateMemory, { onExcessProperty: "error" })`, the
 *    decode `apps/consolidator/src/client.ts` `runTurn` applies to the whole payload. Kind in the six
 *    consolidation kinds, every field bounded, at least two evidence quotes, no undeclared key.
 * 2. `door:grounding` — `ungroundedEvidenceReason`: every cited session is one this batch made readable.
 * 3. `door:quote` — `fabricatedQuoteReason`: every quote appears verbatim (whitespace-collapsed) in the
 *    transcript it cites, against the raw bytes or any one decoded string.
 * 4. `phase:refusal` — `candidateRefusalFor`, the sleep phase's own per-candidate gate
 *    (`packages/sleep/src/phases/trace-consolidation.ts`): writable kind, non-blank claim and gist,
 *    two quotes, a claim that slugs to a title. Deliberately redundant with the door, and the
 *    redundancy is the production design: a scripted or future consolidator that skipped the door
 *    still does not get past the phase.
 *
 * What is NOT here, and why. In production the door refuses the WHOLE TURN on a grounding or quote
 * failure while the phase skips ONE candidate; this composition scores each candidate alone, so both
 * read as "this candidate was refused, at this stage". The phase's `freePath` exhaustion and the
 * store's render gate are corpus-state conditions (a thousand collisions on one stem; a template that
 * cannot render), not properties of a candidate, and a candidate that clears `candidateRefusalFor`
 * renders by construction (`renderTemplate` places the `<mark>` itself). So `accepted` here means
 * exactly what `written` means in the phase for a corpus with free paths.
 */

/** Where a candidate's fate was decided. `accepted` is the fifth outcome: it cleared all four. */
export type GateStage =
  | "door:schema"
  | "door:grounding"
  | "door:quote"
  | "phase:refusal"
  | "accepted"

export const GATE_STAGES: ReadonlyArray<GateStage> = [
  "door:schema",
  "door:grounding",
  "door:quote",
  "phase:refusal",
  "accepted"
]

/** One candidate's outcome. */
export interface GateDecision {
  readonly accepted: boolean
  readonly stage: GateStage
  /** The production function's own reason text, `null` when accepted. Truncated to one line. */
  readonly reason: string | null
}

/** What one batch made readable: the transcripts on disk, keyed the way the door keys them. */
export interface GateBatch {
  readonly reachable: ReadonlyArray<ReachableTranscript>
}

/** Reason strings are for a report line, so the schema's multi-line rendering is folded. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 400)

/**
 * Run one candidate through the gate.
 *
 * Never fails: a decision is the answer, and the only I/O (`fabricatedQuoteReason` re-reading a
 * transcript) already folds an unreadable file into a refusal rather than an error.
 */
export const admitCandidate = (raw: unknown, batch: GateBatch): Effect.Effect<GateDecision> =>
  Effect.gen(function* () {
    const decoded = Schema.decodeUnknownResult(CandidateMemory, { onExcessProperty: "error" })(raw)
    if (Result.isFailure(decoded)) {
      return { accepted: false, stage: "door:schema", reason: oneLine(String(decoded.failure)) }
    }
    const candidate = decoded.success

    const readable = batch.reachable.map(({ entry }) => entry.sessionId)
    const ungrounded = ungroundedEvidenceReason([candidate], readable)
    if (ungrounded !== null) {
      return { accepted: false, stage: "door:grounding", reason: oneLine(ungrounded) }
    }

    const fabricated = yield* fabricatedQuoteReason(
      { candidates: [candidate], commitments: [] },
      batch.reachable
    )
    if (fabricated !== null) {
      return { accepted: false, stage: "door:quote", reason: oneLine(fabricated) }
    }

    const refusal = candidateRefusalFor(candidate)
    if (refusal !== null) {
      return { accepted: false, stage: "phase:refusal", reason: oneLine(refusal) }
    }

    return { accepted: true, stage: "accepted", reason: null }
  })
