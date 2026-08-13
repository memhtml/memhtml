import type { LlmContractViolation, ModelUnavailable } from "@memhtml/contracts/errors"
import { wrapAsData } from "@memhtml/llm"
import { Effect, Result, Schema } from "effect"

/**
 * The structured-output schemas the four LLM phases share, and the per-item isolation wrapper.
 *
 * Two rules govern everything here, both of them found by hitting the failure:
 *
 * **Numerics use `Schema.Finite`, not `Schema.Number`.** `Number` derives an `anyOf` carrying a
 * string branch for `Infinity`/`NaN`, which invites a model to answer a confidence field with the
 * string `"NaN"`; `Finite` derives a clean `{type:"number"}`.
 *
 * **Every corpus text reaching a prompt goes through `wrapAsData`.** This corpus records
 * instructions, and a procedural memory about a deploy step reads exactly like a directive, so
 * un-delimited memory text in a user turn is a prompt-injection surface the system builds for
 * itself. The prompts are also blind by construction. None names a path, a score, or a decision the
 * caller has already made, so the model cannot agree with a verdict it was shown.
 */

/** A stance judgment over one candidate pair. What conflict-detection asks for. */
export const StanceVerdict = Schema.Literals(["contradicts", "entails", "neutral"])
export type StanceVerdict = typeof StanceVerdict.Type

export const StanceJudgment = Schema.Struct({
  verdict: StanceVerdict,
  /** Unitless in `[0, 1]`. The assertion gate is deterministic and reads this, not the prose. */
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** One or two sentences naming the specific claims that conflict, or why they are compatible. */
  rationale: Schema.String
})
export type StanceJudgment = typeof StanceJudgment.Type

/**
 * The confidence a `contradicts` verdict must clear before the phase asserts an edge.
 *
 * A detected contradiction feeds a retention penalty that can eventually evict a memory, so a
 * false `contradicts` is worse than a missed one. The floor and the `detections >= 2`
 * corroboration gate are two independent guards on the same one-way door.
 */
export const STANCE_CONFIDENCE_FLOOR = 0.7

/** True when a judgment earns a `contradicts` edge. Computed here, not decided by the model. */
export const assertsContradiction = (judgment: StanceJudgment): boolean =>
  judgment.verdict === "contradicts" && judgment.confidence >= STANCE_CONFIDENCE_FLOOR

/** One arc the triage call proposes to act on. */
export const ArcAction = Schema.Literals(["update", "create", "skip"])
export type ArcAction = typeof ArcAction.Type

export const ArcPlanEntry = Schema.Struct({
  /**
   * The arc's slug when the action is `update` or `skip`, and the empty string on a `create`.
   * The runner mints the slug of a not-yet-existing arc from the title, because a model-chosen
   * slug would be a model-chosen file path.
   */
  slug: Schema.String,
  /** A concise behavioural-principal name, 3-8 words. */
  title: Schema.String,
  action: ArcAction,
  /** One or two sentences naming what changed or emerged. */
  rationale: Schema.String,
  /** The strongest 1-5 supporting memory keys, as offered in the evidence block. */
  evidenceKeys: Schema.Array(Schema.String)
})
export type ArcPlanEntry = typeof ArcPlanEntry.Type

export const ArcPlan = Schema.Struct({
  entries: Schema.Array(ArcPlanEntry)
})
export type ArcPlan = typeof ArcPlan.Type

/** One arc's written content. The execute call's whole output. */
export const ArcContent = Schema.Struct({
  title: Schema.String,
  /** The single sentence carrying the arc, which becomes the file's `<mark>` claim. */
  claim: Schema.String,
  /** 2-12 sentences that stand alone, one string per paragraph. */
  paragraphs: Schema.Array(Schema.String)
})
export type ArcContent = typeof ArcContent.Type

/** A synthesized canonical for one compress batch. */
export const CompressSynthesis = Schema.Struct({
  title: Schema.String,
  claim: Schema.String,
  paragraphs: Schema.Array(Schema.String),
  /**
   * The members whose content the canonical genuinely absorbs, by the key each was offered under.
   * A member the model omits stays active instead of being archived. The phase archives a file
   * only when it can show the content was carried forward.
   */
  absorbedKeys: Schema.Array(Schema.String)
})
export type CompressSynthesis = typeof CompressSynthesis.Type

/** The stance judge's system prompt. */
export const STANCE_SYSTEM = `You are a natural-language-inference stance judge for an AI agent's long-term memory system.
You are given two memories, A and B, that are embedding-near and about the same entity or topic.
Decide the stance of B relative to A in one pass:

- contradicts: A and B make claims about the same thing that CANNOT both be true at the same time
  (negation, opposite outcomes, mutually exclusive values).
- entails: B restates, paraphrases, or is fully implied by A — redundant, not conflicting.
- neutral: A and B are about the same entity but make compatible, complementary, or simply
  unrelated claims that can both hold.

Be conservative. A detected contradiction feeds a retention penalty that can eventually evict a
memory, so when the two claims COULD both be true — different scope, different time, different
aspect — answer neutral, not contradicts. Rate your confidence honestly and name the specific
conflicting or compatible claims in the rationale.`

/** The arc-triage system prompt: plan only, no content. */
export const ARC_TRIAGE_SYSTEM = `You triage behavioural arcs for an AI agent's long-term memory system. This is the planning pass:
a second pass writes each arc's content, so your output is only the plan.

- Assign every existing arc an action of update or skip. An arc omitted from the plan stays stale.
- Propose create only when a genuinely new behavioural pattern emerges that no existing arc covers.
- Propose update only when the evidence materially changes or reinforces the arc. Each update costs
  a model call, so skip trivial or redundant evidence.
- Keep evidenceKeys to the strongest 1-5 supporting memories per arc.
- Titles are concise behavioural-principal names of 3-8 words.
- Rationale is one or two sentences naming what changed or emerged.
- Leave slug empty on a create.`

/** The arc-execute system prompt: one arc's content. */
export const ARC_EXECUTE_SYSTEM = `You write one behavioural arc for an AI agent's long-term memory system. An arc is a self-contained
behavioural principal — a statement of a pattern, preference, or principle the agent developed
through experience. Arcs are read back in future sessions with no transcript context, so the
content must stand alone.

- claim is the ONE load-bearing sentence: the principle itself, stated as behaviour to adopt.
- paragraphs holds 2-12 sentences across one to four paragraphs. Behavioural principles fit at the
  tight end; an operational playbook may span the wider range.
- Use IF/THEN conditional phrasing for rules, framed positively around the behaviour to adopt.
- When updating, incorporate both the existing content and the new evidence, preserving knowledge
  that still holds.
- Keep references like "the evidence" or "recent sessions" out of the text — name the behaviour.
- The content reads as a stable identity statement, not a changelog.`

/** The compress-synthesis system prompt. */
export const COMPRESS_SYSTEM = `You fold a group of related memories into ONE canonical memory for an AI agent's long-term memory
system. The members are near-neighbours in one community of the memory graph; the canonical replaces
them, and each member you list in absorbedKeys is archived once the canonical is written.

- claim is the ONE load-bearing sentence the group shares.
- paragraphs preserves every distinct fact the members carry: a specific number, a named service, a
  date, a command. Losing one is losing the memory.
- List a member in absorbedKeys ONLY when the canonical genuinely carries its content forward. A
  member you omit stays active, which is the safe outcome — never list one to be tidy.
- If the members do not actually describe one thing, return an empty absorbedKeys and say so in the
  claim. Refusing to fold is a valid answer.`

/** One labelled corpus block, delimited so its prose cannot be read as an instruction. */
export const dataBlock = (label: string, text: string): string => wrapAsData(label, text)

/**
 * The stance judge's user turn for one pair. Both texts are wrapped; neither carries a path.
 *
 * The prompt names no path, no cosine, and no prior verdict, so the model cannot infer which answer
 * the caller is hoping for and cannot recognise a pair it judged last night.
 */
export const stancePrompt = (textA: string, textB: string): string =>
  `${dataBlock("memory_a", textA)}\n\n${dataBlock("memory_b", textB)}\n\n` +
  "Do these two memories contradict each other? Give your verdict, your confidence, and a " +
  "rationale naming the specific claims that conflict or why they are compatible."

/** The arc-triage user turn: the live arcs and the recent evidence, both wrapped. */
export const arcTriagePrompt = (arcsText: string, evidenceText: string): string =>
  `${dataBlock("current_arcs", arcsText)}\n\n${dataBlock("evidence", evidenceText)}\n\n` +
  "Produce a triage plan. Assign update or skip to every existing arc, and add a create entry for " +
  "any genuinely new behavioural pattern the existing arcs do not cover."

/** The arc-execute user turn for one arc. `current` is absent on a create. */
export const arcExecutePrompt = (input: {
  readonly title: string
  readonly rationale: string
  readonly current?: string | undefined
  readonly evidenceText: string
}): string =>
  (input.current === undefined
    ? `${dataBlock("new_arc_title", input.title)}\n\n`
    : `${dataBlock("existing_arc", input.current)}\n\n`) +
  `${dataBlock("evidence", input.evidenceText)}\n\n` +
  `${dataBlock("triage_rationale", input.rationale)}\n\n` +
  (input.current === undefined
    ? "Synthesize a new behavioural principal from this evidence."
    : "Update the arc to incorporate the new evidence, preserving existing knowledge that holds.")

/** The compress user turn for one batch: every member's text, wrapped, under its offered key. */
export const compressPrompt = (
  members: ReadonlyArray<{ readonly key: string; readonly text: string }>
): string =>
  `${members.map((member) => dataBlock(`member_${member.key}`, member.text)).join("\n\n")}\n\n` +
  "Fold these memories into one canonical memory. List in absorbedKeys exactly the members whose " +
  "content the canonical carries forward."

/** Everything a model call can fail with. Both are per-item; neither is per-phase. */
export type LlmFailure = ModelUnavailable | LlmContractViolation

/**
 * Run one model call in isolation: a failure becomes `undefined` and a counted skip.
 *
 * This is the per-item posture the packet's §4 requires, expressed with `Effect.result` because
 * `Effect.either` does not exist in this beta. One violation skips its item and leaves
 * the phase running. A night that judged 199 pairs and lost the 200th to a malformed tool payload has
 * done 199 pairs of work, and failing the phase would throw all of it away.
 */
export const isolate = <A>(
  label: string,
  call: Effect.Effect<A, LlmFailure>
): Effect.Effect<A | undefined> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(call)
    if (Result.isSuccess(outcome)) return outcome.success
    yield* Effect.logWarning(`sleep.llm ${label} skipped: ${outcome.failure.reason}`)
    return undefined
  })
