import { createHash } from "node:crypto"

import { LlmContractViolation, ModelUnavailable } from "@memhtml/contracts/errors"
import { decodeToolInput, EMBED_DIM, EMBED_WATERMARK, type ModelClientShape } from "@memhtml/llm"
import { Effect } from "effect"

import type {
  CandidateMemoryLike,
  ConsolidatorPort,
  TranscriptManifestEntry
} from "./consolidator.js"

/**
 * The fakes this package's tests bind, exported at the `@memhtml/sleep/testing` subpath so T9's CLI
 * smoke and T10's integration tier build a sleep run the same way.
 *
 * **Nothing here fakes git or the database.** Both are real in every sleep test — a temp-dir repo
 * driven by the store's own subprocess wrapper, and an in-memory SQLite database carrying the shipped
 * migrations. Sleep's whole subject is state transitions across those two planes (a `git mv` plus a
 * head stamp in one commit, an upsert whose `RETURNING` decides a promotion), and the fleet has
 * six times paid for a fake that verified the shape of a call and missed the semantics behind it.
 *
 * What IS faked is the model and the embedder, because neither is a state machine: a model call is a
 * function from a prompt to an object, and the tests need that function to be scriptable and free.
 */

/** How many components the deterministic embedder produces. Matches the real vector space's width. */
export const FAKE_DIM = EMBED_DIM

/**
 * A hash-seeded bag-of-words embedder whose cosine relations are ASSERTABLE.
 *
 * A random fake makes a cosine threshold untestable and a constant fake makes every pair identical,
 * so neither can show that dedup found a duplicate. This one hashes each token to two component
 * indices and L2-normalizes, so two texts sharing vocabulary have a genuinely high cosine and two
 * disjoint texts a low one — while the mapping stays a pure function of the text, so a run on another
 * machine produces the same numbers and the same merge decisions.
 *
 * This is the same construction `@memhtml/index`'s harness uses. Duplicated rather than imported because
 * that one is a test file, not a shipped export, and a test importing another package's test tree
 * couples two suites' file layouts.
 */
export const fakeVector = (text: string): Float32Array => {
  const vector = new Float32Array(FAKE_DIM)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const token of tokens) {
    const digest = createHash("sha256").update(token, "utf8").digest()
    const first = digest.readUInt32BE(0) % FAKE_DIM
    const second = digest.readUInt32BE(4) % FAKE_DIM
    vector[first] = (vector[first] ?? 0) + 1
    vector[second] = (vector[second] ?? 0) + 0.5
  }
  let norm = 0
  for (const component of vector) norm += component * component
  if (norm === 0) return vector
  const scale = 1 / Math.sqrt(norm)
  for (let at = 0; at < vector.length; at += 1) vector[at] = (vector[at] ?? 0) * scale
  return vector
}

/** The embedder as the indexer's port, with a call counter. */
export interface FakeEmbedder {
  readonly embed: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<Float32Array>, ModelUnavailable>
  readonly embedQuery: (text: string) => Effect.Effect<Float32Array, ModelUnavailable>
  readonly calls: () => number
}

export const makeFakeEmbedder = (): FakeEmbedder => {
  let calls = 0
  return {
    embed: (texts) =>
      Effect.sync(() => {
        calls += 1
        return texts.map(fakeVector)
      }),
    embedQuery: (text) =>
      Effect.sync(() => {
        calls += 1
        return fakeVector(text)
      }),
    calls: () => calls
  }
}

/** One recorded model call: which prompt went out, and which schema it was decoded against. */
export interface RecordedCall {
  readonly system: string
  readonly prompt: string
  readonly modelKey: string
}

/**
 * A scripted `ModelClientShape`.
 *
 * `reply` receives the request and the 0-based call offset, so a test varies the answer per call —
 * which is how the injected-failure scenario works: return a value for the first N calls and a
 * `LlmContractViolation` for the rest, and the phase's per-item isolation is exercised at exactly
 * the boundary that matters.
 *
 * `generate` (plain text) throws `ModelUnavailable`: no sleep phase calls it, and a fake that
 * answered would let a phase quietly start using the untyped path.
 */
export interface ScriptedModel extends ModelClientShape {
  /** Every call in order, so a test asserts on the bytes that would have gone to Bedrock. */
  readonly calls: ReadonlyArray<RecordedCall>
}

/** What a scripted reply may be: a value, or a typed failure to exercise the isolation path. */
export type ScriptedReply =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "violation"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }

/** A scripted value. */
export const value = (payload: unknown): ScriptedReply => ({ kind: "value", value: payload })

/** A scripted contract violation — a model that answered off-schema. */
export const violation = (reason = "scripted violation"): ScriptedReply => ({
  kind: "violation",
  reason
})

/** A scripted transport failure — Bedrock throttled or unavailable. */
export const unavailable = (reason = "scripted outage"): ScriptedReply => ({
  kind: "unavailable",
  reason
})

/**
 * Build a scripted model.
 *
 * The reply function is given the decoded request, so a script can branch on the SYSTEM prompt to
 * answer the triage call and the execute call differently — which is how the arc-synthesis test
 * drives both halves of that phase from one fake.
 */
export const scriptedModel = (
  reply: (
    request: { readonly system: string; readonly prompt: string },
    callOffset: number
  ) => ScriptedReply
): ScriptedModel => {
  const calls: Array<RecordedCall> = []
  return {
    calls,
    generate: (modelKey) =>
      Effect.fail(
        ModelUnavailable.make({
          modelId: String(modelKey),
          reason: "the scripted model answers only generateObject"
        })
      ),
    generateObject: (request) => {
      const system = request.system ?? ""
      const offset = calls.length
      calls.push({ system, prompt: request.prompt, modelKey: request.modelKey })
      const scripted = reply({ system, prompt: request.prompt }, offset)
      if (scripted.kind === "violation") {
        return Effect.fail(LlmContractViolation.make({ reason: scripted.reason }))
      }
      if (scripted.kind === "unavailable") {
        return Effect.fail(
          ModelUnavailable.make({ modelId: String(request.modelKey), reason: scripted.reason })
        )
      }
      /**
       * The scripted value is decoded through the REQUEST'S OWN SCHEMA by the PRODUCTION decoder —
       * `decodeToolInput`, including its `onExcessProperty: "error"`. So a fixture that drifts from
       * the schema, or carries an undeclared key, is refused here exactly as a real model's answer
       * would be, rather than flowing into a phase as a shape the real model could never produce.
       * That is the whole reason the fake is a client and not a stubbed phase.
       */
      return decodeToolInput(request.schema, scripted.value)
    }
  }
}

/**
 * One recorded consolidation call: the MANIFEST that was handed over.
 *
 * Recorded because the phase's own selection is half of what it does — the byte floor, the quiet
 * window, and the batch cap are all invisible in the candidates and fully visible here. A test asserts
 * on the SESSIONS that reached the agent, which is the only way those three are non-vacuous.
 *
 * The whole entry is kept and not only `{sessionId, filePath}`, because the manifest's generated fields
 * are now part of what the phase produces: a test can assert that a session's `linkedMemories` really
 * names the memory the corpus links to it, which is a join no candidate reveals.
 */
export interface RecordedConsolidation {
  readonly transcripts: ReadonlyArray<TranscriptManifestEntry>
}

/** A scripted {@link ConsolidatorPort}. */
export interface ScriptedConsolidator extends ConsolidatorPort {
  readonly calls: ReadonlyArray<RecordedConsolidation>
}

/**
 * What a scripted consolidation may answer: candidates, or one of the client's real failure classes.
 *
 * The failure arm carries a `_tag` a caller chooses, because the phase's degradation branches on it
 * for the report line and the four real tags mean genuinely different things to an operator —
 * `ConsolidatorCredentialsMissing` is a run that was never possible, `ConsolidatorRunFailed` is one
 * that reached the model and came back empty-handed.
 */
export type ScriptedConsolidation =
  | {
      readonly kind: "candidates"
      readonly candidates: ReadonlyArray<CandidateMemoryLike>
      readonly llmCalls?: number | undefined
      /**
       * The sessions this scripted run claims to have READ. Defaults to every transcript it was handed.
       *
       * The default is the honest one for a fake with no filesystem — a scripted consolidator reaches
       * whatever it is given — and stating it explicitly is how a test drives the case the real client
       * hits when a transcript does not resolve: {@link analyzed} names a subset, and the phase must
       * then watermark that subset and NOT the batch.
       */
      readonly analyzedSessionIds?: ReadonlyArray<string> | undefined
    }
  | { readonly kind: "failure"; readonly tag: string; readonly reason: string }

/** A scripted answer carrying candidates. `llmCalls` defaults to a plausible multi-call run. */
export const candidates = (
  list: ReadonlyArray<CandidateMemoryLike>,
  llmCalls?: number
): ScriptedConsolidation => ({
  kind: "candidates",
  candidates: list,
  ...(llmCalls === undefined ? {} : { llmCalls })
})

/**
 * A scripted answer that read only SOME of the transcripts it was handed.
 *
 * The shape the real client produces when a transcript does not resolve inside the sandbox — rotated
 * away, moved outside `MEMHTML_TRACE_ROOT`, or behind a symlink the mount will not follow. It exists as a
 * named helper because the invariant it exercises is the one this fake is most needed for: a session
 * whose transcript never arrived must not be watermarked, and no candidate list can express that.
 */
export const partiallyRead = (input: {
  readonly analyzedSessionIds: ReadonlyArray<string>
  readonly candidates?: ReadonlyArray<CandidateMemoryLike> | undefined
  readonly llmCalls?: number | undefined
}): ScriptedConsolidation => ({
  kind: "candidates",
  candidates: input.candidates ?? [],
  analyzedSessionIds: input.analyzedSessionIds,
  ...(input.llmCalls === undefined ? {} : { llmCalls: input.llmCalls })
})

/** A scripted consolidator failure — credentials absent, agent unreachable, contract broken. */
export const consolidatorFailure = (
  tag = "ConsolidatorRunFailed",
  reason = "scripted consolidator failure"
): ScriptedConsolidation => ({ kind: "failure", tag, reason })

/**
 * One candidate, with the fields a test does not care about filled in plausibly.
 *
 * Two evidence quotes by default, because that is the bar both the consolidator's schema and the
 * phase's own gate enforce — a helper defaulting to one would make every happy-path fixture a
 * refusal, and a test author would "fix" it by loosening the gate.
 */
export const candidate = (
  input: Partial<CandidateMemoryLike> & { readonly claim: string }
): CandidateMemoryLike => ({
  kind: input.kind ?? "agent_insight",
  claim: input.claim,
  gist: input.gist ?? `Supporting detail for: ${input.claim}`,
  entities: input.entities ?? [],
  evidence: input.evidence ?? [
    { sessionId: "session-a", quote: "the first supporting line" },
    { sessionId: "session-b", quote: "the second supporting line" }
  ]
})

/**
 * Build a scripted consolidator.
 *
 * `reply` sees the transcripts and the 0-based call offset, so a test can answer a first run with
 * candidates and a second with a failure — which is how the resume and idempotence paths are driven
 * from one fake.
 *
 * Unlike {@link scriptedModel} there is no production decoder to route through: the real client
 * decodes eve's structured output against `ConsolidationPayload` and hands back already-typed values,
 * so the boundary a fake could get wrong is the one this fake IS. The phase's own gate
 * (`refusalFor`) is therefore the thing under test here, and a scripted candidate deliberately CAN
 * violate it — that is the per-candidate isolation arm.
 */
export const scriptedConsolidator = (
  reply: (
    request: { readonly transcripts: ReadonlyArray<TranscriptManifestEntry> },
    callOffset: number
  ) => ScriptedConsolidation
): ScriptedConsolidator => {
  const calls: Array<RecordedConsolidation> = []
  return {
    calls,
    consolidate: ({ transcripts }) =>
      Effect.suspend(() => {
        const offset = calls.length
        calls.push({ transcripts })
        const scripted = reply({ transcripts }, offset)
        if (scripted.kind === "failure") {
          return Effect.fail({ _tag: scripted.tag, reason: scripted.reason })
        }
        return Effect.succeed({
          candidates: scripted.candidates,
          /**
           * Defaults to one call per transcript plus one. Still a MULTI-call default, because the eve
           * harness loops and a run that grepped five times made five calls — the number comes back
           * counted off the event stream rather than assumed. A fake that answered `1` would let a test
           * assert `llmCalls === 1` and lock in the wrong model of what a run costs.
           */
          llmCalls: scripted.llmCalls ?? transcripts.length + 1,
          /**
           * Defaults to EVERY transcript handed over, which is what a fake with no filesystem honestly
           * reaches. The default is not a shortcut around the invariant: `analyzedSessionIds` is a
           * required field on the outcome, so this fake has to state a value, and a test that needs the
           * missing-transcript case says so with {@link partiallyRead}.
           */
          analyzedSessionIds:
            scripted.analyzedSessionIds ?? transcripts.map((entry) => entry.sessionId)
        })
      })
  }
}

/** An embedder that always fails, for the degradation path. */
export const failingEmbedder = (): FakeEmbedder => ({
  embed: () =>
    Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "fake outage" })),
  embedQuery: () =>
    Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "fake outage" })),
  calls: () => 0
})
