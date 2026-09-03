import { MEMORY_TYPES, type WritableMemoryType } from "@memhtml/contracts"
import { Schema } from "effect"

import { PROXY_BASE_URL_VAR, proxyFromEnv } from "./llm-proxy.js"

/**
 * What a consolidation run is allowed to return, and what a caller may act on.
 *
 * This module is the whole contract and holds no eve import, no network call, and no
 * credential read beyond looking at `process.env` key presence. That is what lets the test
 * tier decode every shape and exercise the preflight with no credentials and no server.
 */

/**
 * The kinds a consolidated candidate may claim, as a subset of the corpus vocabulary rather
 * than a vocabulary of its own.
 *
 * `packages/contracts/src/types.ts:10-16` records why: three overlapping type vocabularies is
 * what made the predecessor memory system's classification unanswerable. So `kind` here is a `MemoryType` value
 * verbatim, and the next task writes it through the store with no translation step that could
 * drift. The subset is narrower than the nine writable types because the four omitted ones
 * cannot be earned from a transcript pattern:
 *
 * - `task` is work to do, not something observed to have happened.
 * - `user_preference` is a standing instruction the user gave; inferring one from behavior is
 *   how a corpus starts asserting preferences nobody stated.
 * - `verdict` is a judgement this agent is not the one to pass.
 * - `arc` is synthesized by the sleep cycle from many memories and is not writable at all.
 */
export const CONSOLIDATION_KINDS = [
  "episodic",
  "semantic",
  "procedural",
  "agent_insight",
  "error_pattern",
  "precedent"
] as const

export type ConsolidationKind = (typeof CONSOLIDATION_KINDS)[number]

/**
 * Compile-time proof that every kind above is a writable corpus type. If someone adds a kind
 * that `@memhtml/contracts` does not know, or one that only the sleep cycle may write, this line
 * stops the build instead of the next task discovering it against a real repo.
 */
const _kindsAreWritableMemoryTypes: readonly WritableMemoryType[] = CONSOLIDATION_KINDS
void _kindsAreWritableMemoryTypes

/** Ceiling on one evidence quote, so a "quote" cannot smuggle a whole transcript through. */
export const MAX_QUOTE_CHARS = 600

/** Ceiling on the prose fields, generous for a sentence and far below a transcript. */
export const MAX_CLAIM_CHARS = 300
export const MAX_GIST_CHARS = 1_500

/**
 * Who made a commitment, as a closed three-value vocabulary.
 *
 * `other` exists so the model has somewhere honest to put a third party's commitment instead of
 * mislabelling it, and the sleep phase drops it: issue #44 asks for FIRST-PERSON commitments only
 * ("I will", "we need to"), because a task nobody in this pair owes is not work this store can track.
 * Leaving the value out of the vocabulary would have made "a colleague said they'd ship it" arrive
 * tagged `user` or `agent`, which is the failure the third constructor prevents.
 */
export const COMMITMENT_ACTORS = ["user", "agent", "other"] as const

export type CommitmentActor = (typeof COMMITMENT_ACTORS)[number]

/** Ceiling on a commitment's statement. One sentence, the same bound a claim carries. */
export const MAX_STATEMENT_CHARS = 300

/**
 * Ceilings on the LIST fields, so one answer is finite by contract rather than by good behavior.
 *
 * Every scalar field above is bounded and the lists were not, so a single turn could return an answer
 * whose size only the model chose: each candidate is up to ~21 KB of prose plus its evidence, and each
 * evidence quote costs a containment walk over the cited transcript in `fabricatedQuoteReason`. The
 * bounds are generous against the instructions — `agent/instructions.md` calls six candidates plenty
 * and asks for a handful of commitments — so a decode that trips one is an off-contract answer, not a
 * thorough one.
 */
export const MAX_CANDIDATES_PER_RESULT = 200
export const MAX_COMMITMENTS_PER_RESULT = 200
/** Per candidate. Two is the floor (the TRACE-2 bar); this is the matching ceiling. */
export const MAX_EVIDENCE_PER_CANDIDATE = 32
/** Per candidate. Concrete names, not an inventory of every file a session touched. */
export const MAX_ENTITIES_PER_CANDIDATE = 64

/**
 * Ceiling on transcripts per run.
 *
 * Not a bound on resident bytes — the mount does not copy — but on how many files one agent session
 * is asked to hold in attention, and the guard against a caller handing over five thousand sessions,
 * which is well within what one sleep cycle could find unconsolidated. The sleep phase's own
 * `TRACE_SESSIONS_PER_RUN` is lower and binds first; this is the client's independent backstop
 * against a different caller.
 *
 * Declared with the other ceilings rather than beside the mount notes below, because
 * {@link ConsolidationPayload} bounds its read receipt by it and a class body evaluates where it is
 * written — a `const` declared further down would be in its temporal dead zone.
 */
export const MAX_TRANSCRIPTS_PER_RUN = 32

/**
 * One transcript line the candidate rests on, tied to the session it came from.
 *
 * Evidence is what makes the TRACE-2 bar checkable by something other than trust: a candidate
 * that names a cross-session pattern has to be able to point at the lines it read it from, and
 * a reviewer can go back to `sessionId` and see whether the quote is really there.
 */
export class CandidateEvidence extends Schema.Class<CandidateEvidence>("CandidateEvidence")({
  /**
   * The session the quote was read from.
   *
   * Must be one of the ids this run made READABLE, which the schema cannot express, because a set
   * membership over per-run values is not a schema constraint. {@link ungroundedEvidenceReason} holds
   * that rule, applied by `runTurn` in `client.ts` after decode, where the reachable batch is in scope;
   * a citation of an unreachable id fails the turn as a `ConsolidatorContractViolation`. All the schema
   * itself asks for is that the field is present and non-empty, so a quote cannot be unattributed.
   */
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  /** A short verbatim span from that session's transcript. */
  quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUOTE_CHARS))
}) {}

/**
 * One entity a candidate names, as a TYPE and a NAME rather than as one bare string.
 *
 * ## Why the type half is structural
 *
 * The corpus keys an entity on `(entity_type, entity_name)`, and the `entity` retrieval scope compares
 * a whole `type:name` reference (`packages/index/src/scope.ts`). A reference carrying no separator is
 * filed under the type `unknown` (`packages/index/src/project.ts`), which keeps the name as a handle
 * and costs reachability: a memory stored under `unknown:checkout-api` answers
 * `service:checkout-api` — the reference a caller would ask for — with an empty set, which is the same
 * answer an absent memory gives. So a producer emitting bare names writes memories nothing can reach
 * by entity.
 *
 * ## A required OBJECT FIELD, never a `pattern` on a string
 *
 * The other entity producer in this repo already ships this shape: `apps/cli/src/extraction.ts` sends
 * `{type, name}` with `required: ["type", "name"]` and `additionalProperties: false` under the
 * Responses API's `strict: true`, and joins the pair as `type:name`. A JSON-Schema `pattern` is not
 * reliably enforced by a provider's strict-mode structured output, while a required object field is,
 * so the type half arrives because the shape has nowhere else to put it.
 *
 * ## The type vocabulary is OPEN
 *
 * `type` is any non-empty term, not a literal union. memhtml does not dictate a consumer's entity
 * taxonomy: the types `agent/instructions.md` offers are a prompt-level suggestion, `unknown` remains
 * a valid store type, and a consumer modelling its own domain adds its own terms without a change
 * here. What this schema requires is that the type is STATED, never which one it is.
 */
export class CandidateEntity extends Schema.Class<CandidateEntity>("CandidateEntity")({
  /** What kind of thing it is — `service`, `person`, `file`, or any other term. See the class note. */
  type: Schema.String.check(Schema.isMinLength(1)),
  /** Its concrete name, as the transcript spells it. */
  name: Schema.String.check(Schema.isMinLength(1))
}) {}

/**
 * One distilled candidate. Not yet a memory: the next task decides what reaches the corpus.
 *
 * `evidence` is `minLength(2)`, which expresses the TRACE-2 bar as a type rather than as
 * prose the model may ignore. A pattern that spans lines or sessions has at least two lines
 * behind it; a candidate that can only cite one is a restatement of that one line, which
 * `agent/instructions.md` names as below the bar. Prose in the instructions asks for the bar,
 * this refuses the turn's output without it, and the two are deliberately redundant.
 */
export class CandidateMemory extends Schema.Class<CandidateMemory>("CandidateMemory")({
  kind: Schema.Literals(CONSOLIDATION_KINDS),
  /** One sentence stating the pattern. */
  claim: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CLAIM_CHARS)),
  /** The supporting detail: what recurs, where, and what it implies. */
  gist: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_GIST_CHARS)),
  /** Tools, files, commands, packages, people the claim is about. May be empty. */
  entities: Schema.Array(CandidateEntity).check(Schema.isMaxLength(MAX_ENTITIES_PER_CANDIDATE)),
  evidence: Schema.Array(CandidateEvidence).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(MAX_EVIDENCE_PER_CANDIDATE)
  )
}) {}

/**
 * One commitment a session records: a thing somebody said they would do, and whether the same session
 * shows it done.
 *
 * ## Why this is not a `CandidateMemory` with `kind: "task"`
 *
 * {@link CONSOLIDATION_KINDS} excludes `task` on purpose, and that exclusion is still right: "task is
 * work to do, not something observed to have happened", so a candidate MEMORY asserting a task would
 * be the consolidator deciding what work exists. A commitment is a different claim — the transcript
 * SAYS somebody committed, which is an observation — and the decision about whether that becomes a
 * task file is the sleep phase's, made deterministically above a floor. Two lists, so the model cannot
 * launder a task through the memory vocabulary and the phase's post-filter has a shape to filter.
 *
 * ## ONE evidence quote, against `CandidateMemory`'s two
 *
 * The two-quote bar on a memory is the TRACE-2 bar restated as a type: a candidate memory claims a
 * pattern ACROSS lines or sessions, so a pattern with one line behind it is a restatement of that line
 * and the schema refuses it. A commitment is the opposite shape. It is exactly one sentence somebody
 * said, in one place, and the quote IS the finding rather than evidence that a pattern recurs. Asking
 * for a second quote would force the model to pad — to attach an unrelated line, or to split one
 * sentence across two quotes — which manufactures the appearance of corroboration for something that
 * needs none. So the field is a single {@link CandidateEvidence} rather than an array with a minimum,
 * which makes "exactly one" structural instead of a bound a caller could widen.
 *
 * ## `resolved` is a fact about the SAME session, not a judgement
 *
 * True only when the transcript the commitment was read from also shows the work done. That narrow
 * reading is what keeps it checkable: the model has the whole file open, so "did this session later
 * say it shipped" is a question about text it read. A commitment resolved in a LATER session is not
 * this field's job — the sleep phase closes that case by matching a live detected task against a
 * resolved commitment, and it can do so across nights because the task file persists.
 *
 * `confidence` is what the phase floors on. It is the model's own statement of how sure it is that
 * this is a commitment at all, and the floor is `COMMITMENT_FLOOR` in
 * `packages/sleep/src/phases/trace-consolidation.ts`.
 */
export class CandidateCommitment extends Schema.Class<CandidateCommitment>("CandidateCommitment")({
  /** The commitment in one sentence, as the model states it. Not necessarily verbatim; the quote is. */
  statement: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_STATEMENT_CHARS)),
  actor: Schema.Literals(COMMITMENT_ACTORS),
  /**
   * When it is due, if the text says. `optionalKey(NullOr(...))` rather than `optional`, which is the
   * wire fix `apps/mcp/src/tools.ts:73-90` records: a bare `Schema.optional` publishes a JSON Schema
   * accepting `null` while the DECODER rejects it, so a producer that read the schema and sent
   * `"dueHint": null` for "no due date" would fail a decode the published contract called valid.
   * Absent and `null` both mean the text named no date, and the phase drops a value the format refuses.
   */
  dueHint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The one verbatim line the commitment was read from, and the session it is in. */
  evidence: CandidateEvidence,
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** True when THIS session also shows the work done. See the class note. */
  resolved: Schema.Boolean
}) {}

/**
 * What one run produced, what it cost in model calls, and WHICH SESSIONS IT ACTUALLY READ.
 *
 * `analyzedSessionIds` is the value a caller watermarks from rather than a reporting field. It exists
 * because the alternative, watermarking the batch that was ASKED about, records a transcript that
 * never arrived as consolidated and never reads it again. A batch of ten where one path has been
 * rotated away, or sits behind a symlink the sandbox will not follow, is not ten sessions read.
 *
 * The field is REQUIRED rather than optional, and that is what makes the rule structural instead of
 * advisory: nothing can produce a `ConsolidationResult` without stating what it read, so a caller has
 * the honest set at hand and never has to fall back on the batch. `markSessionsConsolidated`'s only
 * correct input is this set, intersected with the batch. See
 * `packages/sleep/src/phases/trace-consolidation.ts`.
 *
 * It is the intersection of two sets, gated on the answer carrying at least one finding: the
 * transcripts whose files RESOLVE AT THEIR GUEST PATH inside the sandbox's read-only mount, and the
 * sessions the agent's own read receipt names. Resolution is checkable where "the model opened it" is
 * not, and it is measured before the model runs — so it bounds the claim rather than proving it, while
 * the receipt narrows it to what the agent says it opened. Never the batch that was asked about, and
 * never merely the ids the answer CITES: a barren-but-read session must advance, or every quiet
 * transcript is re-read at full model cost every night. {@link watermarkableSessionIds} holds the whole
 * rule, and the client logs the empty arm loudly.
 */
export class ConsolidationResult extends Schema.Class<ConsolidationResult>("ConsolidationResult")({
  candidates: Schema.Array(CandidateMemory),
  /**
   * Commitments the same turn reported. Issue #44's surface 2, and its marginal cost is TOKENS in a
   * call this run was already making rather than a second call.
   *
   * REQUIRED, matching `analyzedSessionIds`' posture and for a weaker but real version of the same
   * reason: an optional list would let a consolidator that never looked be indistinguishable from one
   * that looked and found nothing, and `[]` is the honest way to say the second. Nothing downstream
   * defaults it.
   */
  commitments: Schema.Array(CandidateCommitment),
  llmCalls: Schema.Finite,
  analyzedSessionIds: Schema.Array(Schema.String)
}) {}

/**
 * The reason a decoded answer is not grounded in what the run made readable, or `null`.
 *
 * A candidate may only cite sessions THIS RUN MADE READABLE, and the schema cannot say so: a set
 * membership over per-run values is not a schema constraint. So the check is a function of the
 * decoded answer and the reachable ids, which is why it lives here in the contract rather than inline
 * in the client. `client.ts` needs a live eve server to reach, and INV-3 keeps this app's test tier
 * credential-free and server-free. Same reasoning `toJsonSchema` records for staying in this module.
 *
 * An id outside that set is a fabricated receipt. The id rides into the sleep phase and then into a
 * commit message as `evidence <id>:`, where a reviewer's whole recourse is to go back to that session
 * and check the quote is really there. An id naming a session nobody read is worse than no evidence,
 * because it reads as provenance.
 *
 * **The whole TURN is refused, not the one candidate**, and that is a deliberate departure from the
 * per-candidate isolation the sleep phase applies to its own gate. Dropping the offender here would
 * be a lenient repair of a model answer, which is the posture `ConsolidationPayload`'s decode already
 * refuses with `onExcessProperty: "error"`: a filtered list is indistinguishable downstream from a
 * list the agent returned. And a fabricated id says the answer is not grounded in the batch handed
 * over, which is a fact about the run rather than a fault in one candidate. The caller loses nothing
 * it can act on: `ConsolidatorContractViolation` degrades the sleep phase to `ok` with the `_tag` in
 * its detail, leaving the batch unwatermarked for the next night.
 */
export const ungroundedEvidenceReason = (
  candidates: ReadonlyArray<{
    readonly evidence: ReadonlyArray<{ readonly sessionId: string }>
  }>,
  readableSessionIds: ReadonlyArray<string>
): string | null => {
  const readable = new Set(readableSessionIds)
  for (const [offset, candidate] of candidates.entries()) {
    const invented = candidate.evidence.find((quote) => !readable.has(quote.sessionId))
    if (invented !== undefined) {
      return ungroundedReason("candidate", offset, invented.sessionId, readable.size)
    }
  }
  return null
}

/**
 * The same rule for {@link CandidateCommitment}, whose evidence is ONE quote rather than a list.
 *
 * **The whole turn is refused, matching the memory arm exactly**, and the alternative was considered
 * and declined. Dropping just the offending commitment looks cheaper — five good commitments survive
 * one bad id — but it is the lenient repair `ConsolidationPayload`'s `onExcessProperty: "error"`
 * decode already refuses for the reason recorded above {@link ungroundedEvidenceReason}: a filtered
 * list is indistinguishable downstream from a list the agent returned. And what a fabricated id says
 * is not "this one commitment is wrong" but "this answer is not grounded in the batch handed over",
 * which is a fact about the RUN. A model that invented a session id to attribute one commitment to has
 * given no reason to trust the five beside it.
 *
 * The cost of that strictness is one night's commitments, and it is bounded: the transcripts stay
 * unwatermarked, so the next night reads the same batch and asks again.
 *
 * A SIBLING rather than a widened {@link ungroundedEvidenceReason}, because the two shapes differ in
 * their evidence arity and the reason strings have to name which list the offender is in — an operator
 * reading `commitment 3 cites session …` in a phase's detail knows which half of the answer to look
 * at, and `candidate 3` would send them to the wrong one.
 */
export const ungroundedCommitmentReason = (
  commitments: ReadonlyArray<{ readonly evidence: { readonly sessionId: string } }>,
  readableSessionIds: ReadonlyArray<string>
): string | null => {
  const readable = new Set(readableSessionIds)
  for (const [offset, commitment] of commitments.entries()) {
    if (!readable.has(commitment.evidence.sessionId)) {
      return ungroundedReason("commitment", offset, commitment.evidence.sessionId, readable.size)
    }
  }
  return null
}

/** The one reason string both arms produce, so the two cannot drift in wording. */
const ungroundedReason = (
  label: string,
  offset: number,
  sessionId: string,
  readableCount: number
): string =>
  `${label} ${String(offset)} cites session ${sessionId}, which this run did ` +
  `not make readable (${String(readableCount)} transcript(s) resolved in the sandbox)`

/**
 * Which of the reachable sessions a caller may WATERMARK from this answer: the sessions the agent
 * SAYS it read, intersected with what this run made reachable.
 *
 * The receipt is what bounds the advance to what was opened. Advancing every reachable session would
 * lose transcripts permanently — a turn that opens 1 of 32 advances all 32, and `trace_consolidations`
 * is an anti-join, so the other 31 are never selected again. That is the shape a step-budget-truncated
 * turn takes. `readSessionIds` closes it: the agent names the sessions it opened or grepped, and only
 * those advance.
 *
 * A barren-but-READ session still advances, and so does a wholly barren ANSWER (issue #104), which is
 * what keeps the cost bounded — "the agent read it and found nothing above the bar" is the watermark's
 * meaning, the instructions call the all-empty answer with a full receipt the right one for a quiet
 * batch, and gating each session on a CITATION would re-read every quiet transcript at full model cost
 * every night forever. An earlier version gated the whole advance on the answer carrying at least one
 * finding, as defense in depth against a misrouted listener whose `{"candidates": [], "commitments":
 * []}` happened to decode — and the measured cost was #104's: selection is newest-first, so an honest
 * barren night re-selected the identical batch forever and a ~2,000-session backlog never advanced.
 *
 * What actually keeps that listener inert is not this function and not `healthy` (a weak pre-filter:
 * its route is unauthenticated and its three fields are guessable). Two properties do the work.
 * The exact body the gate feared FAILS DECODE — `readSessionIds` is required and the client decodes
 * with `onExcessProperty: "error"`, so no receiptless answer reaches this rule at all. And a receipt
 * that does arrive can only intersect nonzero if it names REAL session ids, which never cross the
 * wire: `turnMessage` (`client.ts`) deliberately omits them, they live in the manifest mounted into
 * the real agent's sandbox, so a listener that is not that agent has nothing to name. A future edit
 * that put session ids into the turn message would silently void that second property — the
 * seeding-era shape `turnMessage`'s own note declines — so the ids stay off the wire on purpose.
 *
 * The intersection is what bounds the claim. A session id the run did not make reachable cannot be
 * watermarked however the answer names it, so the receipt can only ever NARROW the reachable set. That
 * is the same authority `analyzedFrom` gives the client's answer against the phase's batch.
 *
 * ## What is still unverified, stated as the residual it is
 *
 * `readSessionIds` is a model CLAIM. An agent that opens one transcript and names thirty-two advances
 * thirty-two, and nothing here can tell that from a thorough run — the quote gate
 * (`fabricatedQuoteReason`, `client.ts`) proves reading happened where an answer cites, not how much.
 * {@link underCitedWatermarkWarning} is what makes that shape visible: it compares the sessions the
 * answer QUOTES against the sessions it claims to have read, so a wide claim behind a narrow set of
 * quotes — including a wholly barren answer claiming eight or more sessions read — is logged rather
 * than silent.
 *
 * Ids are trimmed before comparison, so a receipt whose entries carry stray whitespace still matches
 * the reachable ids the manifest handed over.
 *
 * In the contract rather than inline in `client.ts`, matching {@link ungroundedEvidenceReason}: the
 * rule is pure over the answer and the reachable ids, and the test tier exercises it with no server.
 */
export const watermarkableSessionIds = (
  answer: { readonly readSessionIds: ReadonlyArray<string> },
  readableSessionIds: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const read = new Set(answer.readSessionIds.map((id) => id.trim()))
  return readableSessionIds.filter((id) => read.has(id))
}

/**
 * The share of an ADVANCING set that must be CITED for the advance to pass without a warning.
 *
 * A quarter. The instructions call six candidates plenty for a batch of up to
 * {@link MAX_TRANSCRIPTS_PER_RUN} transcripts, and each candidate cites at least two quotes, so an
 * honest thorough turn claiming 32 sessions read cites somewhere around 4 to 12 of them and sits near
 * this line; the shape this exists to surface — one candidate quoting one session while the receipt
 * claims 32 — is at 3%. Set to fire rather than to stay quiet, because the log line is the only place
 * the claim's breadth is measured against a verified receipt, and a warning costs a line while the
 * shape it describes costs transcripts.
 */
const WATERMARK_CITED_SHARE_FLOOR = 0.25

/**
 * Advances smaller than this never warn.
 *
 * Below eight sessions the ratio carries no signal: a two-session advance with one citation is at the
 * floor and is also the ordinary shape of a night with two transcripts, so warning there would train an
 * operator to ignore the line by the time a claim of 32 advancing on one citation arrives. It is also
 * what keeps an HONEST narrow turn quiet — a run that opens one transcript and names one advances one.
 */
const WATERMARK_WARN_MIN_READABLE = 8

/**
 * The warning for a watermark that advances many sessions on the citations of a small fraction of them,
 * or `null` when the advance is unremarkable.
 *
 * This is OBSERVABILITY over the one thing {@link watermarkableSessionIds} cannot check, not a second
 * gate. It changes no semantics: the advance happens either way.
 *
 * What it measures is the gap between two receipts of different strength. `readSessionIds` is the
 * agent's own CLAIM about what it opened, and the advance is derived from it; the quotes are the
 * VERIFIED half, re-read against the real transcripts by `fabricatedQuoteReason`. So an answer claiming
 * thirty-two sessions read while quoting one is the shape a truncated or lazy turn takes, and it is
 * indistinguishable here from a thorough run whose thirty-one quiet sessions genuinely held nothing.
 * The log line is the only place that gap is visible.
 *
 * An HONEST narrow turn does not warn, and that follows from the advance being the claim: a turn that
 * opens one transcript and names one advances one, which is below {@link WATERMARK_WARN_MIN_READABLE}.
 * The line fires for a WIDE claim behind a NARROW set of quotes, which is exactly the case worth an
 * operator's attention.
 *
 * The count is of DISTINCT cited session ids INSIDE the advancing set, because both numbers in the line
 * have to name one space. A citation of a session that is not advancing — one outside the receipt, or
 * one the run never made reachable — is evidence about a different set, and counting it both understates
 * the uncited remainder and suppresses the line in the case it exists for: eight sessions advancing on
 * the receipt alone, with two quotes naming sessions none of them, reads as a quarter cited when zero
 * of the advance is. Distinct rather than per-quote, because a candidate citing one session twice is one
 * session's receipt and a per-quote count would read as breadth. Pure over the answer and the readable
 * ids, in the contract for the reason {@link ungroundedEvidenceReason} records: the test tier drives it
 * with no server.
 */
export const underCitedWatermarkWarning = (
  answer: {
    readonly candidates: ReadonlyArray<{
      readonly evidence: ReadonlyArray<{ readonly sessionId: string }>
    }>
    readonly commitments: ReadonlyArray<{ readonly evidence: { readonly sessionId: string } }>
    readonly readSessionIds: ReadonlyArray<string>
  },
  readableSessionIds: ReadonlyArray<string>
): string | null => {
  const advance = watermarkableSessionIds(answer, readableSessionIds)
  const advancing = advance.length
  if (advancing < WATERMARK_WARN_MIN_READABLE) return null

  const advancingIds = new Set(advance)
  const cited = new Set<string>()
  const cite = (sessionId: string): void => {
    const id = sessionId.trim()
    if (advancingIds.has(id)) cited.add(id)
  }
  for (const candidate of answer.candidates) {
    for (const quote of candidate.evidence) cite(quote.sessionId)
  }
  for (const commitment of answer.commitments) cite(commitment.evidence.sessionId)
  if (cited.size >= advancing * WATERMARK_CITED_SHARE_FLOOR) return null

  return (
    `consolidation is watermarking ${String(advancing)} session(s) the agent reports having read, on ` +
    `quotes from only ${String(cited.size)} of them; the other ${String(advancing - cited.size)} ` +
    "advance on the reported receipt alone, and a watermarked session is never selected again. " +
    "Check the turn's step budget if it should have read more."
  )
}

/**
 * Whether a quote appears in a text, compared after collapsing whitespace runs on BOTH sides.
 *
 * The collapse is the only normalization: case, punctuation, and word order all still have to match,
 * because the claim being checked is "this sentence is in that file" and a looser comparison would
 * verify a paraphrase. Whitespace alone is exempt since neither side controls it — the model re-wraps
 * lines and the transcript's own indentation is serialization, not speech.
 *
 * Pure over two strings, so `tests/contract.test.ts` drives it with no file on disk. What text to
 * hand it is the caller's problem, and the caller must offer BOTH the raw bytes and the decoded
 * strings — see {@link decodedTranscriptStrings} for why either alone fails honest quotes.
 */
export const quoteAppearsIn = (quote: string, text: string): boolean => {
  const needle = flattenWhitespace(quote)
  /** An empty needle is `includes`-true against anything, which would gate nothing. */
  if (needle === "") return false
  return flattenWhitespace(text).includes(needle)
}

/** The one normalization both sides get. See {@link quoteAppearsIn} for why nothing else is. */
const flattenWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim()

/**
 * Containment checks for many quotes against ONE transcript, paying its normalization once.
 *
 * {@link quoteAppearsIn} flattens BOTH sides per call, so checking a transcript's quotes through it
 * directly re-flattens the whole file once per quote — against the corpus's measured p99 of 4.68 MB
 * and a 37.2 MB maximum, that is megabytes of regex work multiplied by however many quotes the model
 * cited from one session. This closure flattens the raw bytes at construction and the decoded strings
 * on the first quote that needs them, so the per-quote cost is one `includes` (plus one more per
 * decoded string when the raw arm misses).
 *
 * Same two arms, same semantics as the caller composing {@link quoteAppearsIn} with
 * {@link decodedTranscriptStrings}: raw bytes first because most quotes are verbatim in the source,
 * decoded strings each tested SEPARATELY so a quote stitched across two messages still refuses.
 * `fabricatedQuoteReason` (`client.ts`) builds one of these per cited session; a run that cites
 * nothing builds none.
 */
export interface TranscriptQuoteChecker {
  readonly contains: (quote: string) => boolean
}

export const transcriptQuoteChecker = (transcript: string): TranscriptQuoteChecker => {
  const flatRaw = flattenWhitespace(transcript)
  /** Decoded lazily: a session whose every quote is verbatim in the bytes never pays for a parse. */
  let flatDecoded: ReadonlyArray<string> | null = null
  return {
    contains: (quote) => {
      const needle = flattenWhitespace(quote)
      if (needle === "") return false
      if (flatRaw.includes(needle)) return true
      flatDecoded ??= decodedTranscriptStrings(transcript).map(flattenWhitespace)
      return flatDecoded.some((text) => text.includes(needle))
    }
  }
}

/**
 * Every string value a JSONL transcript carries, DECODED, one entry per value.
 *
 * ## The gap this closes, and why the raw bytes alone fail honest answers
 *
 * {@link quoteAppearsIn} against the file's bytes asks whether the quote is a substring of JSON
 * SOURCE, and a transcript's message text is JSON-ENCODED in that source. Two ordinary quotes
 * therefore cannot verify against bytes, and neither is a fabrication:
 *
 * - **A quote carrying a `"` the speaker typed.** The bytes hold `\"`, so the needle's one character
 *   is two in the file and no amount of whitespace normalization brings them together.
 * - **A quote spanning a message-internal newline.** The bytes hold the two characters `\` and `n`,
 *   while the needle holds a real newline that {@link quoteAppearsIn} collapses to a space. The
 *   comparison is then a space against a backslash.
 *
 * The cost of that mismatch is not one lost commitment. `fabricatedQuoteReason` (`client.ts`) refuses
 * the WHOLE turn, so the batch produces nothing, so `markSessionsConsolidated` never runs, so the
 * next run selects the same batch and fails identically — an honest answer livelocking an unattended
 * job. PR #47's review gauntlet found exactly this against real JSONL bytes.
 *
 * ## Values only, and each value SEPARATELY
 *
 * Keys are excluded because a field name is not something a speaker said, so a quote matching one is
 * not evidence about a session. The result is a LIST rather than a joined blob for a sharper reason:
 * joining would make the tail of one message and the head of the next a contiguous run, so a model
 * could stitch a sentence out of two turns and have it verify — a fabricated quote assembled from
 * real words, which is precisely the failure the check exists to catch. The caller tests each string
 * on its own.
 *
 * ## Why this does NOT filter to message-content fields
 *
 * Review suggested restricting extraction to speech fields so a quote matching transcript METADATA
 * (a role, a type, a session id) cannot satisfy containment. Filtering here is inert against that:
 * a metadata value is escape-free, so its decoded form IS its byte form (measured:
 * `JSON.stringify(v).slice(1, -1) === v` for every such value), and the caller's RAW arm — the
 * original contract, searching the whole file's bytes — already accepts it, keys included. The
 * decoded arm widens acceptance ONLY for strings carrying JSON escapes, which metadata never does.
 * Tightening against metadata-shaped quotes would mean restricting the raw arm by parsing every
 * transcript format's field layout, and the schema's floor already bounds the damage: a "quote" that
 * is one metadata token is a degenerate citation a reviewer sees verbatim in the task body, not a
 * fabrication this check could have caught.
 *
 * ## An unparseable line is SKIPPED, and the caller keeps the raw arm
 *
 * These files are written by a live process, so the last line is routinely a half-written object, and
 * one torn line must not cost the file. A line that parses to a bare scalar contributes nothing
 * either: `JSON.parse("3")` succeeds and a number is not a quote. And because the caller accepts a
 * match against the RAW text OR any decoded string, a file this cannot parse at all is exactly as
 * verifiable as it was before — the decoded arm only ever adds.
 *
 * Pure and synchronous over one string, so the test tier drives it with no file on disk.
 */
export const decodedTranscriptStrings = (transcript: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    // `null` is `typeof "object"`, and `Object.values(null)` throws rather than answering nothing.
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) collect(item)
    }
  }
  for (const line of transcript.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      collect(JSON.parse(trimmed))
    } catch {
      // A torn or non-JSON line costs itself. See the note above.
    }
  }
  return out
}

/**
 * ── This module holds NO origin validation, and nothing may parse a child's stdout for one ───────
 *
 * The server's origin is composed in `client.ts` from `LOOPBACK_HOST` and a port this process
 * obtained from the kernel (`reserveLoopbackPort`), then passed to `eve start --port <n>`. No string
 * a child process writes is ever on the path that decides where a transcript or a run token is sent,
 * so there is no untrusted origin to validate here. The readiness poll covers the reachable hazard
 * (something else on the port) by refusing any listener that does not answer `/eve/v1/health` with
 * eve's own body.
 *
 * A constraint on anything that ever parses eve's stdout again: the stream carries ANSI escapes even
 * when piped with no TTY (measured 2026-08-09, eve 0.33.0: a failing `eve start` emitted
 * `ESC[90m…ESC[39m` into a redirected file). Such a parser needs an escape strip, with the ESC byte
 * built via `String.fromCharCode`, because biome's `noControlCharactersInRegex` refuses a control
 * character in regex source however it is spelled.
 */

/**
 * The structured payload the agent is asked for.
 *
 * A wrapper object rather than a bare array: eve lowers this to the model's structured-output
 * contract, and a top-level array leaves nowhere to say "I found nothing" that is
 * distinguishable from a truncated answer. `candidates: []` is a real, readable result.
 *
 * `commitments` is REQUIRED, so an agent that ignored the second half of its instructions fails the
 * decode instead of quietly answering only the first. That is the same posture the decode already
 * takes toward an undeclared extra key: nothing about an off-contract answer is repaired here, because
 * a defaulted `commitments: []` would be indistinguishable from a turn that looked and found none.
 */
export class ConsolidationPayload extends Schema.Class<ConsolidationPayload>(
  "ConsolidationPayload"
)({
  candidates: Schema.Array(CandidateMemory).check(Schema.isMaxLength(MAX_CANDIDATES_PER_RESULT)),
  commitments: Schema.Array(CandidateCommitment).check(
    Schema.isMaxLength(MAX_COMMITMENTS_PER_RESULT)
  ),
  /**
   * The `sessionId` of every session the agent opened or grepped: the PER-SESSION READ RECEIPT the
   * watermark advances over.
   *
   * REQUIRED, and that is what makes it a receipt rather than a hint. An optional field would let an
   * agent that reported nothing be indistinguishable from one that read nothing, and the fallback for
   * an absent receipt is the whole reachable set — which is exactly the advance this field exists to
   * narrow. Nothing downstream defaults it.
   *
   * Bounded by {@link MAX_TRANSCRIPTS_PER_RUN}, because a run mounts at most that many transcripts, so
   * a longer list names sessions no run was handed.
   *
   * {@link watermarkableSessionIds} intersects it with the reachable set, so an id outside that set is
   * INERT. The whole turn is not refused for one, unlike a fabricated EVIDENCE id
   * ({@link ungroundedEvidenceReason}): that one rides into a commit message as provenance a reviewer
   * trusts, while this one changes nothing a caller can act on.
   */
  readSessionIds: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_TRANSCRIPTS_PER_RUN))
}) {}

/**
 * A JSON-safe object, structurally identical to eve's own `JsonObject`
 * (node_modules/eve/dist/src/shared/json.d.ts:12).
 *
 * Declared here rather than imported so `contract.ts` keeps its zero-eve-import property, which
 * is what lets the test tier decode every shape with no server and no credentials. TypeScript is
 * structural, so the value below is assignable to eve's `outputSchema` parameter without a cast.
 */
export type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/**
 * Derive the JSON Schema eve is handed for `outputSchema`.
 *
 * Deliberately a local seven lines rather than an import of `@memhtml/llm`'s `toInputSchema`
 * (`packages/llm/src/structured.ts:33-38`), for two reasons. It keeps the Bedrock SDK, which
 * `@memhtml/llm` pulls in for its own client, out of this app's dependency closure, and it keeps
 * this app's wire shape independently derived from the same effect schema, so a change in one
 * does not silently redefine the other. The `$defs` fold is the same one `structured.ts`
 * documents: `toJsonSchemaDocument` hoists nested structs into `definitions` and leaves
 * `$ref: "#/$defs/<name>"` behind, so the definitions go back under the root as `$defs`.
 *
 * The `JSON.parse(JSON.stringify(...))` normalization does two jobs, since effect types the emitted
 * document loosely. It proves the value really is JSON-serializable, which matters because the
 * document crosses the wire as a request body and a non-serializable member would fail at the
 * boundary instead of here. It also drops `undefined`-valued keys, which are not JSON and which
 * eve's own `parseJsonValue` treats as omitted.
 *
 * The ROOT `$ref` is then inlined, and that step changes what a consumer reads. Measured against
 * effect 4.0.0-beta.102: `toJsonSchemaDocument(ConsolidationPayload)` returns a root of exactly
 * `{ $ref: "#/$defs/ConsolidationPayloadJsonEncoding", $defs: {...} }`, a root with NO `type`,
 * NO `properties`, and nothing at all describing an object. A nested `$ref` is well-supported
 * (`packages/llm/src/structured.ts:24-27` records it verified live against Bedrock's
 * `input_schema`), but a root that only points elsewhere is a different shape, and a consumer that
 * reads `schema.type` to decide how to constrain the model finds `undefined`. Rather than bet the
 * turn on every layer between here and the model dereferencing a root pointer, the referenced
 * definition is merged into the root and dropped from `$defs`; the remaining definitions stay put
 * for the nested refs that point at them.
 */
export const toJsonSchema = (schema: Schema.Top): JsonObject => {
  const document = Schema.toJsonSchemaDocument(schema)
  const serializable = JSON.parse(
    JSON.stringify({ ...document.schema, $defs: document.definitions })
  ) as Record<string, JsonValue>

  const { $ref: rootRef, $defs: rawDefs, ...rest } = serializable
  const defs = (rawDefs ?? {}) as Record<string, JsonValue>

  const rootName =
    typeof rootRef === "string" && rootRef.startsWith("#/$defs/")
      ? rootRef.slice("#/$defs/".length)
      : null
  const rootDef = rootName === null ? null : defs[rootName]

  const root =
    rootDef !== null &&
    rootDef !== undefined &&
    typeof rootDef === "object" &&
    !Array.isArray(rootDef)
      ? { ...rest, ...rootDef }
      : { ...rest, ...(rootRef === undefined ? {} : { $ref: rootRef }) }

  const remaining =
    rootName === null
      ? defs
      : Object.fromEntries(Object.entries(defs).filter(([name]) => name !== rootName))

  return (Object.keys(remaining).length === 0 ? root : { ...root, $defs: remaining }) as JsonObject
}

/** The `outputSchema` value passed on the turn. Derived once; the schema never varies. */
export const CONSOLIDATION_OUTPUT_JSON_SCHEMA = toJsonSchema(ConsolidationPayload)

/**
 * ── There is deliberately NO per-file byte cap on what a transcript exposes to the sandbox ───────
 *
 * Transcripts arrive on a read-only `OverlayFs` mount that reads THROUGH to the host on demand
 * (`src/mount.ts`), so nothing is resident in the server process and there is no seeded byte count
 * to bound. A large transcript costs whatever the model actually reads of it, and eve bounds each
 * `read_file` at 2000 lines or 50 KB
 * (node_modules/eve/dist/src/execution/sandbox/truncate-output.js), so the budget sits with the
 * reader, spent deliberately per call.
 *
 * The corpus distribution this holds against, measured 2026-08-08: 11,360 transcripts, 6.59 GB, p50
 * 332 KB, p90 915 KB, p99 4.68 MB, max 37.2 MB. `packages/traces/src/parse.ts:16-21` reasons about
 * the same shape.
 */

/** One transcript the caller wants read, named by the session it belongs to. */
export interface TranscriptRef {
  readonly sessionId: string
  readonly filePath: string
}

/**
 * Why a run produced nothing usable. Every constructor here is something a caller can branch
 * on: skip the phase, fail it, or report it.
 *
 * Payloads carry no transcript content. A consolidator error can be logged and reported by the
 * sleep cycle, and transcript text must not ride along into a report. That is the same posture
 * `packages/contracts/src/errors.ts:5-8` states for storage failures.
 */

/**
 * No usable credentials in the environment. Its own case, distinct from a failed call, because
 * INV-3 turns on the caller being able to SKIP rather than fail: a run with no credentials is
 * not a broken run, it is a run that was never possible.
 */
export class ConsolidatorCredentialsMissing extends Schema.TaggedError<ConsolidatorCredentialsMissing>()(
  "ConsolidatorCredentialsMissing",
  {
    reason: Schema.String
  }
) {}

/** The agent server could not be built, started, or reached. */
export class ConsolidatorUnavailable extends Schema.TaggedError<ConsolidatorUnavailable>()(
  "ConsolidatorUnavailable",
  {
    reason: Schema.String
  }
) {}

/**
 * The turn reached the model and did not come back with a usable answer.
 *
 * One type over both failure shapes the probe found, discriminated by `phase` rather than split
 * into two error classes, because a caller's decision is the same for both: the run produced
 * nothing. `turn` is eve's `status: "ready"` with `outcome.status: "failed"`; `invocation` is a
 * top-level `status: "failed"`.
 */
export class ConsolidatorRunFailed extends Schema.TaggedError<ConsolidatorRunFailed>()(
  "ConsolidatorRunFailed",
  {
    phase: Schema.Literals(["invocation", "turn"]),
    reason: Schema.String
  }
) {}

/**
 * The turn settled but its structured payload is not one this contract accepts: absent when a
 * schema was requested, or present and undecodable.
 *
 * Kept apart from {@link ConsolidatorRunFailed} because it says something different about the
 * agent: it answered, and the answer broke the contract. Same posture as
 * `packages/llm/src/structured.ts:52-61`: a coerced object is indistinguishable from a real one
 * downstream, so nothing lenient happens here.
 *
 * A turn eve could not settle is not this: see {@link unsettledTurnReason}. eve ends a parked or
 * recoverably-failed conversation turn as `session.waiting` with no structured result, and a client
 * that tests only `data === undefined` files it here — which is what two consecutive sleep runs did
 * (issue #113), each reporting "settled without a structured result" for a turn the harness had
 * stopped on its output-token cap.
 */
export class ConsolidatorContractViolation extends Schema.TaggedError<ConsolidatorContractViolation>()(
  "ConsolidatorContractViolation",
  {
    reason: Schema.String
  }
) {}

/**
 * The subset of eve's `MessageResult` that {@link unsettledTurnReason} reads.
 *
 * Structural rather than eve's own type, so the pure test tier can drive it with a literal recorded
 * from a real run and the classifier is pinned to the three fields it needs: `status`
 * (node_modules/eve/dist/src/client/types.d.ts, `MessageResult.status`), a parked turn's
 * `inputRequests` (node_modules/eve/dist/src/runtime/input/types.d.ts, `InputRequest`), and the
 * turn's `events`, which carry the failure code when eve failed the turn rather than parking it
 * (node_modules/eve/dist/src/protocol/message.d.ts, `createTurnFailedEvent`).
 */
export interface SettledTurnShape {
  readonly status: "completed" | "failed" | "waiting"
  /**
   * The structured payload, when the turn produced one. Its PRESENCE is what separates a successful
   * conversation turn from an unsettled one, and nothing else does — see {@link unsettledTurnReason}.
   */
  readonly data?: unknown
  readonly inputRequests: ReadonlyArray<{
    readonly kind: string
    readonly prompt?: string | undefined
    readonly action?: { readonly input?: unknown } | undefined
  }>
  readonly events: ReadonlyArray<{ readonly type: string; readonly data?: unknown }>
}

/**
 * How many characters of a foreign prompt or provider message the failure reason carries. Enough to
 * name what happened; both are model-facing text of no fixed length and the reason is a log line.
 */
const UNSETTLED_DETAIL_CHARS = 200

/**
 * Why a turn produced no structured result, or `null` when it produced one or is not this shape.
 *
 * **`waiting` is not a failure by itself, and assuming it was rejected a good answer.** A CLIENT
 * session is conversation-mode, and eve ends EVERY conversation turn that way: `emitTurnEpilogue`
 * emits `turn.completed` and then `session.waiting` on success too
 * (node_modules/eve/dist/src/harness/emission.js), so `MessageResult.status` is `"waiting"` for a
 * turn that answered perfectly. Measured 2026-09-02 14:53Z: a turn that emitted `result.completed`
 * with six candidates came back `waiting`, and an earlier version of this function failed the run on
 * it. `data` is the discriminator, so this returns `null` whenever a payload arrived, whatever the
 * status says.
 *
 * With that settled, eve never FAILS a conversation turn outright either: it parks it. Three
 * different things arrive that way and all three are terminal here, because nobody is on the other
 * end of this session — the phase runs unattended and the agent's instructions forbid it from asking
 * anything.
 *
 * 1. **The session token-limit prompt.** `enforceSessionTokenLimit`
 *    (node_modules/eve/dist/src/harness/session-limit-enforcement.js) routes a conversation-mode
 *    session to `parkOnSessionTokenLimit`, which emits an `input.requested` of kind `session-limit`
 *    and then the turn epilogue. Only TASK-mode runs get the `SESSION_TOKEN_LIMIT_REACHED` failure.
 * 2. **A recoverable turn failure.** A provider error that survives eve's retries goes through
 *    `emitRecoverableFailedTurn` (harness/emission.js): `turn.failed` with a code, then
 *    `session.waiting`. The turn is left for a human to retry, so `status` is `waiting` and not
 *    `failed`, and the code is only in the events.
 * 3. **An `ask_question` or tool approval**, which this agent is not supposed to raise at all.
 *
 * Every arm names its numbers, because they are the diagnosis. A line reading "the session spent
 * 50368 output tokens against a cap of 50000" or "MODEL_CALL_FAILED after 92 model call(s), 28 of
 * which were cut off at the per-call output limit" is what tells an operator which ceiling to move;
 * `ConsolidatorContractViolation` told them the model had answered off-schema, which was false.
 *
 * The truncation count is included wherever it is non-zero: a `message.completed` carrying
 * `finishReason: "length"` is a model call whose output was cut mid-answer, and a run of them is the
 * signature of a per-call ceiling too small for the payload (issue #113 — 28 in a row at 4,096
 * tokens). Read defensively throughout: every one of these payloads is `JsonObject` on the wire and
 * this module does not own their shapes, so a missing field shortens the sentence rather than
 * throwing inside a failure path.
 */
export const unsettledTurnReason = (turn: SettledTurnShape, modelCalls: number): string | null => {
  if (turn.data !== undefined) return null
  if (turn.status !== "waiting") return null
  const truncated = truncatedCallSuffix(turn)
  const limit = turn.inputRequests.find((request) => request.kind === "session-limit")
  if (limit !== undefined) {
    const input = limit.action?.input
    const detail = isRecord(input) ? describeSessionLimit(input) : ""
    return (
      `the consolidation turn parked on eve's session token-limit prompt after ` +
      `${String(modelCalls)} model call(s)${detail}${truncated}; the consolidator has no human to ` +
      `approve a fresh budget, so the turn is failed`
    )
  }
  const failure = failedTurnEvent(turn)
  if (failure !== null) {
    return (
      `the consolidation turn failed and was parked for a human retry: ${failure} after ` +
      `${String(modelCalls)} model call(s)${truncated}`
    )
  }
  const first = turn.inputRequests[0]
  if (first !== undefined) {
    return (
      `the consolidation turn parked on an input request nobody is present to answer ` +
      `(${first.kind}: ${cut(first.prompt ?? "")}) after ${String(modelCalls)} model call(s)`
    )
  }
  return (
    `the consolidation turn ended waiting for a next message with no result, no failure, and no ` +
    `input request, after ${String(modelCalls)} model call(s)${truncated}`
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const cut = (text: string): string => text.slice(0, UNSETTLED_DETAIL_CHARS)

const describeSessionLimit = (input: Record<string, unknown>): string => {
  const kind = typeof input.kind === "string" ? input.kind : "a"
  const used = typeof input.usedTokens === "number" ? String(input.usedTokens) : null
  const cap = typeof input.limit === "number" ? String(input.limit) : null
  if (used === null && cap === null) return ` (${kind}-token limit)`
  return `: the session spent ${used ?? "?"} ${kind} tokens against a cap of ${cap ?? "?"}`
}

/** `turn.failed`/`step.failed`'s code and message, as one clause, or `null` when neither is present. */
const failedTurnEvent = (turn: SettledTurnShape): string | null => {
  for (const event of turn.events) {
    if (event.type !== "turn.failed" && event.type !== "step.failed") continue
    if (!isRecord(event.data)) return event.type
    const code = typeof event.data.code === "string" ? event.data.code : event.type
    const message = typeof event.data.message === "string" ? cut(event.data.message) : ""
    return message === "" ? code : `${code} (${message})`
  }
  return null
}

/**
 * How many model calls were cut off at the per-call output ceiling, as a clause or the empty string.
 *
 * `finishReason` is on `message.completed`
 * (node_modules/eve/dist/src/protocol/message.d.ts, `createMessageCompletedEvent`), and `"length"`
 * means the provider stopped the call at its output limit rather than at an answer.
 */
const truncatedCallSuffix = (turn: SettledTurnShape): string => {
  const cutOff = turn.events.filter(
    (event) =>
      event.type === "message.completed" &&
      isRecord(event.data) &&
      event.data.finishReason === "length"
  ).length
  return cutOff === 0
    ? ""
    : `, ${String(cutOff)} of which were cut off at the per-call output limit`
}

/** Everything the client wrapper can fail with. */
export type ConsolidatorError =
  | ConsolidatorCredentialsMissing
  | ConsolidatorUnavailable
  | ConsolidatorRunFailed
  | ConsolidatorContractViolation

/**
 * Which env vars could authenticate the Bedrock provider, in the order the provider reads them.
 *
 * The provider has NO default AWS credential chain, verified live in the probe: no shared
 * config file, no SSO cache, no instance metadata, env vars only. So presence here is the whole
 * question, and a preflight cannot be fooled by a profile that only the AWS CLI can see.
 *
 * The third way to reach a model is not a Bedrock credential at all: an LLM proxy named by
 * `MEMHTML_LLM_BASE_URL` (`src/llm-proxy.ts`), which the agent calls through the Anthropic provider
 * instead of the Bedrock one. Its own key is optional, so the proxy's PRESENCE is what counts here.
 */
const BEARER_VAR = "AWS_BEARER_TOKEN_BEDROCK"
const SIGV4_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const

const present = (env: Record<string, string | undefined>, name: string): boolean => {
  const value = env[name]
  return value !== undefined && value.trim() !== ""
}

/**
 * Whether a consolidation run could reach a model at all, without making a call.
 *
 * Asking cheaply matters because the provider is lazy. `createAmazonBedrock` and
 * `provider(modelId)` both succeed with zero credentials, and nothing fails until the first
 * request, by which time a server has been built, spawned, and handed transcripts. Verified in
 * the probe. So the caller checks this first and skips, which is the INV-3 groundwork: CI has
 * no credentials and must stay green.
 *
 * Empty-string is treated as absent. A blank export is how a credential goes missing in
 * practice, and `""` would authenticate nothing while reading as present.
 *
 * An LLM proxy counts as a route whether or not it takes a key, because the key is the proxy's
 * business and a keyless loopback proxy is a supported deployment. A malformed proxy URL THROWS
 * here rather than reading as absent: falling back to "no route" would skip the phase quietly for
 * a run the operator configured, and the message names the variable to fix.
 *
 * This answers "could a call be attempted", never "would it be authorized". A stale or
 * unentitled key passes here and fails at the call as {@link ConsolidatorRunFailed}, which is the
 * honest split, since the only way to know a key works is to use it.
 */
export const hasConsolidatorCredentials = (
  env: Record<string, string | undefined> = process.env
): boolean =>
  proxyFromEnv(env) !== null ||
  present(env, BEARER_VAR) ||
  SIGV4_VARS.every((name) => present(env, name))

/**
 * The message carried on {@link ConsolidatorCredentialsMissing}: which env vars would fix it.
 *
 * Takes no environment on purpose. It names the three accepted MECHANISMS, which never vary, and
 * says nothing about which vars are currently set. A failure message is logged and reported by
 * the sleep cycle, so naming the present-but-rejected variables would put credential-shaped
 * details into a report for no diagnostic gain. Whether a given var is set is what
 * {@link hasConsolidatorCredentials} answers.
 */
export const credentialsMissingReason = (): string =>
  `no way to reach a model in the environment: set ${BEARER_VAR} or ${SIGV4_VARS.join(" + ")} ` +
  `for Bedrock directly, or ${PROXY_BASE_URL_VAR} for an LLM proxy`

/**
 * Every kind is a real corpus type, restated so a reader of this file alone can see the
 * relationship without opening `@memhtml/contracts`.
 */
export const isConsolidationKind = (value: string): value is ConsolidationKind =>
  (CONSOLIDATION_KINDS as readonly string[]).includes(value) &&
  (MEMORY_TYPES as readonly string[]).includes(value)
