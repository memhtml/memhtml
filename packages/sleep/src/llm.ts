import type { MemoryRel } from "@memhtml/contracts/edges"
import { wrapAsData } from "@memhtml/llm"
import { Schema } from "effect"

import { batchPrompt } from "./batch.js"

/**
 * The structured-output schemas the four LLM phases share, and their prompts.
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

/**
 * The rels edge typing may propose, plus `none`. A closed subset of `MEMORY_RELS`, and the
 * omissions are deliberate.
 *
 * `supersedes` is out because it is a one-way door on stored belief: it says one memory REPLACES
 * another, which is dedup-merge's and compress's business and rides with an archive. `relates_to`
 * is out because it is what the pair already carries as a derived edge, so proposing it is a no-op
 * with a model call attached. `laterally_related` is out for the same reason one notch weaker.
 * A pair the model cannot type answers `none` and stays a mined suspicion.
 */
export const EDGE_TYPED_RELS = [
  "caused_by",
  "leads_to",
  "example_of",
  "supports",
  "part_of",
  "contradicts"
] as const satisfies ReadonlyArray<MemoryRel>

/**
 * The five DIRECTIONAL rels: the ones whose meaning depends on which endpoint is the subject.
 *
 * `contradicts` is excluded and that is the whole distinction this list draws. A contradiction is
 * symmetric — a reader arriving at either file must see it — so it is promoted into BOTH files and
 * its `direction` field is ignored. A directional rel is promoted into ONE file, the subject's, and
 * the direction decides which one.
 */
export const EDGE_DIRECTIONAL_RELS = [
  "caused_by",
  "leads_to",
  "example_of",
  "supports",
  "part_of"
] as const satisfies ReadonlyArray<MemoryRel>

/** One directional rel, as a type. A member of `MemoryRel` by the `satisfies` above. */
export type EdgeDirectionalRel = (typeof EDGE_DIRECTIONAL_RELS)[number]

/** The rel vocabulary the model answers over: the typed rels plus the refusal. */
export const EdgeVerdictRel = Schema.Literals([...EDGE_TYPED_RELS, "none"])
export type EdgeVerdictRel = typeof EdgeVerdictRel.Type

/**
 * Which endpoint is the rel's subject. Meaningful only for {@link EDGE_DIRECTIONAL_RELS}.
 *
 * Required rather than optional, because a model allowed to omit it would omit it on the rels where
 * it matters. `contradicts` and `none` carry a value the phase does not read.
 */
export const EdgeDirection = Schema.Literals(["src_to_dst", "dst_to_src"])
export type EdgeDirection = typeof EdgeDirection.Type

/** One pair's verdict, under the opaque key the pair was offered as. */
export const EdgeVerdict = Schema.Struct({
  /** The offered key, e.g. `m3`. A key the batch never held resolves to nothing and is dropped. */
  pairKey: Schema.String,
  rel: EdgeVerdictRel,
  direction: EdgeDirection,
  /** Unitless in `[0, 1]`. The promotion gate is deterministic and reads this, not the prose. */
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** One or two sentences naming the specific claims that carry the rel. Optional: `none` has none. */
  rationale: Schema.optional(Schema.String)
})
export type EdgeVerdict = typeof EdgeVerdict.Type

/** One batch's whole answer: a verdict LIST, never one call per pair. */
export const EdgeTyping = Schema.Struct({
  verdicts: Schema.Array(EdgeVerdict)
})
export type EdgeTyping = typeof EdgeTyping.Type

/**
 * The confidence a verdict must clear before the phase writes anything.
 *
 * A `contradicts` feeds a retention penalty that can eventually evict a memory, so a false one is
 * worse than a missed one; the floor and the `detections >= 2` corroboration gate are two
 * independent guards on that one-way door. A directional rel is milder but still an authored edge in
 * a file a human reads, so it clears the same floor. One number, because a second one would be a
 * knob nobody could say the meaning of.
 */
export const EDGE_CONFIDENCE_FLOOR = 0.7

/** True when a verdict is a proposal at all, above the floor. Computed here, never by the model. */
export const assertsEdge = (verdict: EdgeVerdict): boolean =>
  verdict.rel !== "none" && verdict.confidence >= EDGE_CONFIDENCE_FLOOR

/** True when a verdict earns a `contradicts` edge. The corroboration gate's precondition. */
export const assertsContradiction = (verdict: EdgeVerdict): boolean =>
  verdict.rel === "contradicts" && verdict.confidence >= EDGE_CONFIDENCE_FLOOR

/**
 * True when a rel's meaning depends on which endpoint is its subject.
 *
 * A NARROWING predicate, not a boolean, so the caller's `rel` becomes an `EdgeDirectionalRel` — and
 * therefore a `MemoryRel` — inside the branch that writes a `<link>`. A plain boolean would leave the
 * write site casting `"none"`-inclusive union to `EdgeRel`, which is the cast that would silently
 * survive someone adding a non-rel member to the verdict vocabulary.
 */
export const isDirectionalRel = (rel: EdgeVerdictRel): rel is EdgeDirectionalRel =>
  (EDGE_DIRECTIONAL_RELS as ReadonlyArray<string>).includes(rel)

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
  /** A concise behavioral-principal name, 3-8 words. */
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

/**
 * The edge-typing system prompt: the whole rel vocabulary, one pass, one answer per pair.
 *
 * The same conservative posture the per-pair stance judge carried, generalized. An unsure pair
 * answers `none` and keeps the machine-mined `relates_to` it already has, which costs the corpus
 * nothing; a wrong `contradicts` starts a memory down the eviction path and a wrong directional rel
 * writes a claim about causality into a file a human reads.
 */
export const EDGE_TYPING_SYSTEM = `You type relationships between memories in an AI agent's long-term memory system. You are given a
NUMBERED LIST of candidate pairs. Each pair holds two memories, src and dst, that are embedding-near
or share an entity. Return ONE verdict per pair, naming the pair by the key it was offered under.

Choose the rel that holds between the two memories:

- caused_by: one memory's fact is the CAUSE of the other's. The subject is the effect.
- leads_to: one memory's fact leads to, triggers, or produces the other's. The subject is the cause.
- example_of: one memory is a concrete instance of the other's general claim. The subject is the instance.
- supports: one memory is evidence FOR the other's claim, without restating it. The subject is the evidence.
- part_of: one memory is a component, step, or subtopic of the other's larger whole. The subject is the part.
- contradicts: the two make claims about the same thing that CANNOT both be true at the same time
  (negation, opposite outcomes, mutually exclusive values). SYMMETRIC: direction is ignored.
- none: the two are merely about the same topic, restate each other, or carry no relationship you can
  name from the text. This is the correct answer whenever you are unsure.

direction says which endpoint is the rel's SUBJECT, as described per rel above: src_to_dst means src
is the subject and dst the object; dst_to_src is the reverse. Answer src_to_dst on contradicts and
none, where it is not read.

Be conservative. A verdict above the confidence floor is written into the memory files as an authored
edge, and a false contradicts feeds a retention penalty that can eventually evict a memory. When the
relationship COULD be something else — different scope, different time, mere topical adjacency —
answer none. Two memories being similar is not a relationship. Rate confidence honestly and name the
specific claims that carry the rel in the rationale.

Omitting a pair is allowed: an omitted pair is simply left untyped.`

/** The arc-triage system prompt: plan only, no content. */
export const ARC_TRIAGE_SYSTEM = `You triage behavioral arcs for an AI agent's long-term memory system. This is the planning pass:
a second pass writes each arc's content, so your output is only the plan.

- Assign every existing arc an action of update or skip. An arc omitted from the plan stays stale.
- Propose create only when a genuinely new behavioral pattern emerges that no existing arc covers.
- Propose update only when the evidence materially changes or reinforces the arc. Each update costs
  a model call, so skip trivial or redundant evidence.
- Keep evidenceKeys to the strongest 1-5 supporting memories per arc.
- Titles are concise behavioral-principal names of 3-8 words.
- Rationale is one or two sentences naming what changed or emerged.
- Leave slug empty on a create.`

/** The arc-execute system prompt: one arc's content. */
export const ARC_EXECUTE_SYSTEM = `You write one behavioral arc for an AI agent's long-term memory system. An arc is a self-contained
behavioral principal — a statement of a pattern, preference, or principle the agent developed
through experience. Arcs are read back in future sessions with no transcript context, so the
content must stand alone.

- claim is the ONE load-bearing sentence: the principle itself, stated as behavior to adopt.
- paragraphs holds 2-12 sentences across one to four paragraphs. Behavioral principles fit at the
  tight end; an operational playbook may span the wider range.
- Use IF/THEN conditional phrasing for rules, framed positively around the behavior to adopt.
- When updating, incorporate both the existing content and the new evidence, preserving knowledge
  that still holds.
- Keep references like "the evidence" or "recent sessions" out of the text — name the behavior.
- The content reads as a stable identity statement, not a changelog.`

/** The compress-synthesis system prompt. */
export const COMPRESS_SYSTEM = `You fold a group of related memories into ONE canonical memory for an AI agent's long-term memory
system. The members are near-neighbors in one community of the memory graph; the canonical replaces
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
 * One pair as the model sees it: both memories inline, delimited, under `src` and `dst` headings.
 *
 * This is a MEMBER's text, not a whole prompt: the kernel's `keyMembers` slices it to the phase's
 * per-member budget and `memberList` wraps the whole thing again under the pair's opaque key, so a
 * batch of thirty pairs is one nesting of sixty delimited memories. Neither half carries a path, a
 * cosine, or a prior verdict, so the model cannot infer which answer the caller is hoping for and
 * cannot recognize a pair it judged last night.
 *
 * The inner headings are plain lines rather than another `wrapAsData` block, because the outer wrap
 * already carries the "this is data" instruction and a second copy per member would repeat that
 * sentence sixty times in one prompt for no added guard.
 */
export const pairText = (srcText: string, dstText: string): string =>
  `src:\n${srcText}\n\ndst:\n${dstText}`

/** The instruction that closes an edge-typing batch's user turn, after the pair list. */
export const EDGE_TYPING_INSTRUCTION =
  "Type each pair above. Return one verdict per pair, naming the pair by its offered key, with the " +
  "rel, the direction, your confidence, and a rationale naming the claims that carry the rel. " +
  "Answer none whenever you are unsure."

/**
 * One edge-typing batch's user turn: every pair's two memories under its offered key, then the
 * instruction.
 *
 * `batchPrompt` from the kernel builds the list and appends the instruction, so the framing is the
 * same bytes compress's batches use. Kept as a named function because the instruction belongs beside
 * {@link EDGE_TYPING_SYSTEM}, which is the other half of what the model is told.
 */
export const edgeTypingPrompt = (
  pairs: ReadonlyArray<{ readonly key: string; readonly text: string }>
): string => batchPrompt(pairs, EDGE_TYPING_INSTRUCTION, { label: "pair" })

/** The arc-triage user turn: the live arcs and the recent evidence, both wrapped. */
export const arcTriagePrompt = (arcsText: string, evidenceText: string): string =>
  `${dataBlock("current_arcs", arcsText)}\n\n${dataBlock("evidence", evidenceText)}\n\n` +
  "Produce a triage plan. Assign update or skip to every existing arc, and add a create entry for " +
  "any genuinely new behavioral pattern the existing arcs do not cover."

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
    ? "Synthesize a new behavioral principal from this evidence."
    : "Update the arc to incorporate the new evidence, preserving existing knowledge that holds.")

/** The instruction that closes a compress batch's user turn, after the member list. */
export const COMPRESS_INSTRUCTION =
  "Fold these memories into one canonical memory. List in absorbedKeys exactly the members whose " +
  "content the canonical carries forward."

/**
 * The compress user turn for one batch: every member's text, wrapped, under its offered key.
 *
 * `batchPrompt` from the kernel builds the member list and appends the instruction, so this produces
 * the same bytes it did when the framing was inline here. Kept as a named function because the
 * instruction belongs beside {@link COMPRESS_SYSTEM}, which is the other half of what the model is
 * told.
 */
export const compressPrompt = (
  members: ReadonlyArray<{ readonly key: string; readonly text: string }>
): string => batchPrompt(members, COMPRESS_INSTRUCTION)
