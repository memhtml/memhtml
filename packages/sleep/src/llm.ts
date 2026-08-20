import type { MemoryRel } from "@memhtml/contracts/edges"
import { wrapAsData } from "@memhtml/llm"
import { Schema } from "effect"

import { batchPrompt, memberList } from "./batch.js"

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

/** One proposed identity cluster over the entity names a batch offered. */
export const EntityCluster = Schema.Struct({
  /**
   * The member key the cluster's canonical name was offered under. The phase re-derives the canonical
   * from ITS OWN weight-then-lexicographic rule, so this names which member the model considers the
   * fullest form and never which file gets rewritten. A key the batch did not offer resolves to
   * nothing and drops the cluster.
   */
  canonicalKey: Schema.String,
  /**
   * Every member key in the cluster, canonical included. A cluster of one is a valid answer meaning
   * "this name stands alone", and it produces no merge.
   */
  memberKeys: Schema.Array(Schema.String),
  /** Unitless in `[0, 1]`. The merge gate is deterministic and reads this, not the prose. */
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** One sentence naming what makes these one subject: a declared alias, a shared neighborhood. */
  evidence: Schema.String
})
export type EntityCluster = typeof EntityCluster.Type

/**
 * The whole clustering answer for one batch: a partition of the offered names.
 *
 * `clusters: []` is a refusal and a valid answer. A model that cannot tell two short names apart must
 * be able to say so, because the alternative — inventing a cluster to fill the field — reaches a
 * permanent rewrite of stored identity.
 */
export const EntityClustering = Schema.Struct({
  clusters: Schema.Array(EntityCluster)
})
export type EntityClustering = typeof EntityClustering.Type
/**
 * One merge group: the members the model says are the same memory, by their offered keys.
 *
 * **No canonical field, deliberately.** The keeper is the OLDER file, decided from corpus order in
 * the phase, and a model-chosen canonical would be a model-chosen write target: the file that
 * survives and the files that get archived. The model's whole job here is the partition — which
 * members are one memory — and orientation is arithmetic over `created_at` that needs no judgment.
 *
 * A group of fewer than two keys is meaningless and the phase drops it. That is the shape a model
 * produces when it wants to say "this one is on its own", which is a valid answer.
 */
export const MergeGroup = Schema.Struct({
  memberKeys: Schema.Array(Schema.String)
})
export type MergeGroup = typeof MergeGroup.Type

/**
 * The dedup partition for one packed batch: every merge group the model found, across every
 * component in the batch.
 *
 * **The groups are FLAT, not nested per component, and the phase re-derives which component each one
 * came from.** A nested answer would need the model to keep a component index aligned with its
 * groups, which is bookkeeping a model gets wrong under load, and a mis-aligned index would attach a
 * group to the wrong component's files. A flat list of member keys carries the same information,
 * because a key already identifies its member and therefore its component. So the phase can check
 * containment itself instead of trusting a label.
 *
 * `groups: []` is a full refusal: every member stays where it is, which is the safe outcome and the
 * behavior a night with no model already has.
 */
export const MergePartition = Schema.Struct({
  groups: Schema.Array(MergeGroup)
})
export type MergePartition = typeof MergePartition.Type

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

/**
 * The entity-clustering system prompt: partition one type's names into subjects.
 *
 * Names the three evidence kinds a member block carries, because each one supports a different
 * inference and a model told only "decide if these are the same" would weigh the name string — the
 * signal that is measurably wrong here. `laith` against `laith al-saadoon` is 0.476 by character
 * overlap, below even the review band, while their memory centroids are near-identical.
 *
 * The refusal instruction is load-bearing rather than polite. A cluster this phase acts on rewrites
 * every `memhtml-entity` meta naming the alias across the corpus, and no later commit separates two
 * subjects whose memories were fused.
 */
export const ENTITY_CLUSTER_SYSTEM = `You group entity names for an AI agent's long-term memory system. Every name below is the same KIND of
thing — all people, or all services, or all concepts — and several may be different ways of writing one
subject. Partition them into subjects.

Each member gives you:
- the name as the corpus records it, and how many active memories claim it;
- up to three titles of memories claiming it, which say what that name is ABOUT;
- its nearest neighbors by MEMORY CENTROID with a cosine — the centroid is the average of the vectors
  of every memory claiming the name, so a high cosine means two names are written about in the same
  terms. Two spellings of one person have near-identical centroids; two different services in one
  domain do not;
- for a person, aliases DECLARED in that person's own file, which are an authoritative statement of
  identity rather than a guess.

Rules:
- Every cluster lists canonicalKey plus every other member key that names the same subject. Set
  canonicalKey to the fullest, most complete form of the name.
- A name that stands alone is its own cluster of one, or you may leave it out. Both mean "no merge".
- Return an empty clusters list when nothing here is the same subject. Refusing to group is a valid
  and often correct answer.
- Short name against long name is the case to look for: 'laith' and 'laith al-saadoon' are one person
  when the evidence supports it. Shared prefix is NOT: 'checkout-api' and 'payments-api' are two
  services, and 'metrics-api' and 'metrics-cli' are a service and a tool.
- Never group two names because their strings are similar. Group them because the evidence says one
  subject, and cite that evidence.
- Rate confidence honestly. A merge fuses two subjects' memories permanently and nothing separates
  them again, so answer low when you are unsure and the system will hold the merge back.`

/** The instruction that closes an entity-clustering batch's user turn, after the member list. */
export const ENTITY_CLUSTER_INSTRUCTION =
  "Partition these names into subjects. Return one cluster per subject with its canonicalKey, every " +
  "member key it covers, your confidence, and the specific evidence that makes them one subject."

/**
 * The entity-clustering user turn for one batch: every member's evidence block under its offered key.
 *
 * `batchPrompt` from the kernel builds the list and appends the instruction, so the stable half of the
 * call is {@link ENTITY_CLUSTER_SYSTEM} plus the tool schema and only the member list is new bytes per
 * batch. Kept as a named function because the instruction belongs beside the system prompt.
 */
export const entityClusterPrompt = (
  members: ReadonlyArray<{ readonly key: string; readonly text: string }>
): string => batchPrompt(members, ENTITY_CLUSTER_INSTRUCTION, { label: "entity" })

/**
 * The dedup-partition system prompt.
 *
 * The stable prefix for every dedup call of a {@link batchCall} marks it cacheable, so only
 * the member list is new bytes per batch.
 *
 * It tells the model that a group is a claim about SAMENESS and nothing else. Every other decision
 * the fold needs — which file survives, whether the pair diverges in polarity or in a number,
 * whether either path is already spoken for — is made by code after the answer comes back, and the
 * prompt says so, because a model told it is choosing what gets deleted answers more conservatively
 * than the question deserves.
 */
export const DEDUP_SYSTEM = `You partition groups of near-duplicate memories for an AI agent's long-term memory system.
Each component below holds memories that are near neighbors in vector space, or that state the same
relation. Within EACH component, group the memories that are THE SAME MEMORY — one fact stored more
than once, in different words.

- A group means: these state one fact, and keeping all of them stores it repeatedly. Two memories
  about the same topic that carry DIFFERENT facts are not a group.
- Group only members of the SAME component. Members of different components are already known not to
  be near-duplicates.
- A member belongs to at most one group. Leave a member out of every group when it is on its own.
- Return groups: [] when no component holds a duplicate. Refusing to group is a valid answer and is
  the right one whenever you are unsure.
- You are not choosing what to delete. Which memory survives a fold is decided from the memories'
  own dates afterwards, and a proposed group is still checked for contradicting claims, differing
  numbers, and differing product variants before anything is written. Answer only the question of
  sameness.`

/**
 * What a detected finding is: a commitment somebody made, or a follow-up nobody closed.
 *
 * Two values and not more. Issue #44 names both — "an open commitment or unresolved follow-up" — and
 * they are genuinely different work: a commitment has an actor who said they would do something, and a
 * follow-up is a question or a defect the text leaves open with nobody attached. The phase renders a
 * different claim for each, and the pair is closed because a third value would be a category whose
 * reading nothing downstream could state.
 */
export const TaskFindingKind = Schema.Literals(["commitment", "followup"])
export type TaskFindingKind = typeof TaskFindingKind.Type

/** One finding about one offered member. */
export const TaskFinding = Schema.Struct({
  /** The offered key, e.g. `m3`. A key the batch never held resolves to nothing and is dropped. */
  memberKey: Schema.String,
  /**
   * The sentence that carries the finding, copied VERBATIM from the member's text.
   *
   * Verbatim is a checked requirement and not a request: the phase looks the sentence up in the cited
   * file's own article text and refuses the mint when it is not there. So a paraphrase costs the
   * finding, which is why the system prompt says so in those words.
   */
  sentence: Schema.String,
  kind: TaskFindingKind,
  /** Unitless in `[0, 1]`. The mint gate is deterministic and reads this, not the prose. */
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})
export type TaskFinding = typeof TaskFinding.Type

/**
 * One batch's whole answer: the findings across every member it was shown.
 *
 * `findings: []` is a refusal and the correct answer for most batches. Most memories record a fact and
 * carry no open work at all, and a model that felt obliged to fill the list would mint tasks out of
 * ordinary prose — which is precisely the noise the volume cap exists to bound and the reviewer's
 * attention cannot absorb.
 */
export const TaskDetection = Schema.Struct({
  findings: Schema.Array(TaskFinding)
})
export type TaskDetection = typeof TaskDetection.Type

/**
 * The task-detection system prompt.
 *
 * The conservative posture every other judge in this file carries, aimed at the one thing this phase
 * can get wrong at scale: a memory that MENTIONS work is not a memory that carries an open
 * commitment. An `error_pattern` describing a defect somebody already fixed reads exactly like one
 * describing a defect nobody has, and the difference is in whether the text says it was resolved.
 *
 * The verbatim rule is stated as a consequence rather than as a style note, because it IS one: the
 * phase looks the sentence up in the file and drops the finding when it is absent.
 */
export const TASK_DETECT_SYSTEM = `You find OPEN WORK recorded in an AI agent's long-term memory system. You are given a NUMBERED LIST
of memories. For each one, decide whether its text records work that is still open, and if so quote
the sentence that says so.

Two kinds:

- commitment: somebody stated they would do something and the text does not say it happened. "I'll
  fix that tomorrow", "we need to wire capture before the next release", "leaving the merge until you
  review it".
- followup: the text leaves something unresolved with nobody attached. An unfixed defect a memory
  describes, a question it ends on, a decision it says is blocked pending something else.

Rules:

- sentence must be copied VERBATIM from the member's own text, character for character. The system
  looks it up in the file and DISCARDS the finding when it is not found, so a paraphrase, a
  correction, a stitched-together sentence, or a summary loses the finding entirely.
- Return findings: [] when nothing here carries open work. That is the ordinary answer: most memories
  record a fact, not a task. Refusing is correct whenever you are unsure.
- A memory that DESCRIBES completed work is not open work. "we fixed the flaky teardown by pinning
  the port" is a record, not a task. Look for work the text leaves undone.
- Never report a hypothetical, an option considered and rejected, or a general principle. "if the
  cache misses we would need to warm it" names no work anybody owes.
- One finding per memory at most, and only for the memories that have one. Omitting a member is
  always allowed.
- Rate confidence honestly. A finding above the floor becomes a task file a human is asked to review,
  and a queue full of things that were never work is a queue nobody reads.`

/** The instruction that closes a task-detection batch's user turn, after the member list. */
export const TASK_DETECT_INSTRUCTION =
  "Which of these memories carry open work? For each one that does, name it by its offered key, " +
  "quote the sentence verbatim, say whether it is a commitment or a followup, and rate your " +
  "confidence. Return findings: [] if none of them do."

/**
 * The task-detection user turn for one batch: every member's text under its offered key.
 *
 * `batchPrompt` from the kernel builds the list and appends the instruction, so
 * {@link TASK_DETECT_SYSTEM} plus the tool schema form the cache-eligible prefix and only the member
 * list is new bytes per batch. The label is `memory` rather than `member`, because what the model is
 * asked about is whether a MEMORY records open work, and the wrapper's label is the only place the
 * prompt names the thing.
 */
export const taskDetectPrompt = (
  members: ReadonlyArray<{ readonly key: string; readonly text: string }>
): string => batchPrompt(members, TASK_DETECT_INSTRUCTION, { label: "memory" })

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

/** The instruction that closes a dedup batch's user turn, after the components. */
export const DEDUP_INSTRUCTION =
  "Within each component above, group the members that are the same memory stated more than once. " +
  "Name each group's members by the keys they were offered under. Return groups: [] if no " +
  "component holds a duplicate."

/**
 * The dedup user turn for one packed batch: each component's members, wrapped, under a header that
 * names which keys sit in that component.
 *
 * **The component boundary is in the prompt because it is EVIDENCE.** Two members in different
 * components have already been measured as not near-duplicates, by a cosine floor and a frame-key
 * lookup, and a flat member list would throw that away and ask the model to rediscover it across the
 * whole batch. Packing ten components into one call is a cost decision; letting them blur into one
 * list would make it a correctness one.
 *
 * The headers are built from the OFFERED KEYS alone, never from a path or a title, so a header
 * carries nothing a member's own text could have chosen. `memberList` still wraps every member's
 * text, so the injection boundary is per member and the framing around it holds no corpus bytes.
 *
 * A containment claim in the prompt is not a containment guarantee: the phase re-checks that every
 * group the model returns sits inside ONE component, because the prompt is an instruction and the
 * post-pass is the enforcement.
 */
export const dedupPrompt = (
  components: ReadonlyArray<ReadonlyArray<{ readonly key: string; readonly text: string }>>
): string => {
  const blocks = components.map((members, offset) => {
    const keys = members.map((member) => member.key).join(", ")
    return `component_${offset + 1} holds ${keys}.\n\n${memberList(members)}`
  })
  return `${blocks.join("\n\n")}\n\n${DEDUP_INSTRUCTION}`
}
