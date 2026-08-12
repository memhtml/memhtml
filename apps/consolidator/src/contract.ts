import { MEMORY_TYPES, type WritableMemoryType } from "@memhtml/contracts"
import { Schema } from "effect"

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
 * - `user_preference` is a standing instruction the user gave; inferring one from behaviour is
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
   * Must be one of the ids this run made READABLE, which the schema cannot express — a set membership
   * over per-run values is not a schema constraint. {@link ungroundedEvidenceReason} is that rule,
   * applied by `client.ts`'s `runTurn` immediately after decode, where the reachable batch is in scope;
   * a citation of an unreachable id fails the turn as a `ConsolidatorContractViolation`. All the schema
   * itself asks for is that the field is present and non-empty, so a quote cannot be unattributed.
   */
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  /** A short verbatim span from that session's transcript. */
  quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUOTE_CHARS))
}) {}

/**
 * One distilled candidate. Not yet a memory: the next task decides what reaches the corpus.
 *
 * `evidence` is `minLength(2)` and that is the TRACE-2 bar expressed as a type rather than as
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
  entities: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  evidence: Schema.Array(CandidateEvidence).check(Schema.isMinLength(2))
}) {}

/**
 * What one run produced, what it cost in model calls, and WHICH SESSIONS IT ACTUALLY REACHED.
 *
 * `analyzedSessionIds` is not reporting. It is the value a caller watermarks from, and it exists
 * because the alternative — watermarking the batch that was ASKED about — records a transcript that
 * never arrived as consolidated and never reads it again. A batch of ten where one path has been
 * rotated away, or sits behind a symlink the sandbox will not follow, is not ten sessions read.
 *
 * The field is REQUIRED rather than optional, and that is what makes the rule structural instead of
 * advisory: nothing can produce a `ConsolidationResult` without stating what it reached, so a caller
 * has the honest set at hand and never has to fall back on the batch. `markSessionsConsolidated`'s
 * only correct input is this set, intersected with the batch — see
 * `packages/sleep/src/phases/trace-consolidation.ts`.
 *
 * It is the set of transcripts whose files RESOLVE AT THEIR GUEST PATH inside the sandbox's
 * read-only mount, not the set the model chose to open. Those are different claims and only the
 * first is checkable: nothing outside the model can prove a file was read, while a file that does
 * not resolve was categorically not read. The pre-existing semantics of a watermark — "the agent saw
 * this session and correctly found nothing above the bar" — needs exactly the first.
 */
export class ConsolidationResult extends Schema.Class<ConsolidationResult>("ConsolidationResult")({
  candidates: Schema.Array(CandidateMemory),
  llmCalls: Schema.Finite,
  analyzedSessionIds: Schema.Array(Schema.String)
}) {}

/**
 * The reason a decoded answer is not grounded in what the run made readable, or `null`.
 *
 * A candidate may only cite sessions THIS RUN MADE READABLE, and the schema cannot say so: a set
 * membership over per-run values is not a schema constraint. So the check is a function of the
 * decoded answer and the reachable ids, which is why it lives here in the contract rather than inline
 * in the client — `client.ts` needs a live eve server to reach, and INV-3 keeps this app's test tier
 * credential-free and server-free. Same reasoning `toJsonSchema` records for staying in this module.
 *
 * An id outside that set is a fabricated receipt. The id rides into the sleep phase and then into a commit
 * message as `evidence <id>:`, where a reviewer's whole recourse is to go back to that session and
 * check the quote is really there — so an id naming a session nobody read is worse than no evidence,
 * because it reads as provenance.
 *
 * **The whole TURN is refused, not the one candidate**, and that is a deliberate departure from the
 * per-candidate isolation the sleep phase applies to its own gate. Dropping the offender here would
 * be a lenient repair of a model answer, which is the posture `ConsolidationPayload`'s decode already
 * refuses with `onExcessProperty: "error"`: a filtered list is indistinguishable downstream from a
 * list the agent returned. And a fabricated id is not a fault in one candidate — it says the answer
 * is not grounded in the batch handed over, which is a fact about the run. The caller loses nothing
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
      return (
        `candidate ${String(offset)} cites session ${invented.sessionId}, which this run did ` +
        `not make readable (${String(readable.size)} transcript(s) resolved in the sandbox)`
      )
    }
  }
  return null
}

/**
 * ── The origin validation that used to live here is DELETED, with the parse it defended ──────────
 *
 * `loopbackOriginFrom`, `nonLoopbackOrigin`, `isLoopbackHostname`, `ANSI_ESCAPE`, and
 * `URL_CANDIDATE` existed for one caller: `startServer` spawned `eve start --port 0` and read the
 * bound port back off the child's stdout, so the address this process posted transcripts to was a
 * string a child wrote, and validating it as loopback was the only thing standing between "eve
 * printed a URL" and "the batch was posted to it".
 *
 * `client.ts` now chooses the port itself (`reserveLoopbackPort`) and passes it to
 * `eve start --port <n>`, so the origin is composed from a constant and an integer this process got
 * from the kernel. There is no untrusted string in the path any more, and nothing left to validate:
 * a "defence" over a value we constructed asserts that we typed our own constant correctly.
 *
 * Kept as belt-and-braces it would have been WORSE than deleted, because it would have kept
 * asserting a threat model that no longer holds — and the deletion is not a downgrade in practice:
 * the readiness poll now refuses any listener that does not answer `/eve/v1/health` as eve, which
 * covers the reachable case (something else on the port) more directly than a hostname check on a
 * self-composed URL ever did.
 *
 * One measured correction to leave behind, since the old comment asserted the opposite. It claimed
 * eve's piped stdout carries zero ANSI escape bytes. It does not: probed 2026-08-09 with stdout
 * redirected to a file and no TTY, a failing `eve start` emitted
 * `ESC[90mStopping server gracefully (5s)... Press ESC[1mCtrl+CESC[22m again…ESC[39m`. So an escape
 * on that stream is real, not theoretical — it is simply no longer on any path that decides an
 * address. If anything ever parses that stream again it needs the strip, and it needs the ESC byte
 * built via `String.fromCharCode` because biome's `noControlCharactersInRegex` refuses a control
 * character in regex source however it is spelled.
 */

/**
 * The structured payload the agent is asked for.
 *
 * A wrapper object rather than a bare array: eve lowers this to the model's structured-output
 * contract, and a top-level array leaves nowhere to say "I found nothing" that is
 * distinguishable from a truncated answer. `candidates: []` is a real, readable result.
 */
export class ConsolidationPayload extends Schema.Class<ConsolidationPayload>(
  "ConsolidationPayload"
)({
  candidates: Schema.Array(CandidateMemory)
}) {}

/**
 * A JSON-safe object, structurally identical to eve's own `JsonObject`
 * (node_modules/eve/dist/src/shared/json.d.ts:12).
 *
 * Declared here rather than imported so `contract.ts` keeps its zero-eve-import property — that
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
 * (`packages/llm/src/structured.ts:33-38`), for two reasons. It keeps the Bedrock SDK — which
 * `@memhtml/llm` pulls in for its own client — out of this app's dependency closure, and it keeps
 * this app's wire shape independently derived from the same effect schema, so a change in one
 * does not silently redefine the other. The `$defs` fold is the same one `structured.ts`
 * documents: `toJsonSchemaDocument` hoists nested structs into `definitions` and leaves
 * `$ref: "#/$defs/<name>"` behind, so the definitions go back under the root as `$defs`.
 *
 * The `JSON.parse(JSON.stringify(...))` normalization is not decoration: effect types the emitted
 * document loosely, and this both proves the value really is JSON-serializable — it crosses the
 * wire as a request body, so a non-serializable member would fail at the boundary instead of here
 * — and drops `undefined`-valued keys, which are not JSON and which eve's own `parseJsonValue`
 * treats as omitted.
 *
 * The ROOT `$ref` is then inlined, and that step is not cosmetic. Measured against effect
 * 4.0.0-beta.102: `toJsonSchemaDocument(ConsolidationPayload)` returns a root of exactly
 * `{ $ref: "#/$defs/ConsolidationPayloadJsonEncoding", $defs: {...} }` — a root with NO `type`,
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
 * ── `DEFAULT_TAIL_BYTES` is DELETED, and so is the reason it existed ──────────────────────────────
 *
 * It was a 256 KiB per-file cap on how much of each transcript reached the sandbox, and the cap was
 * load-bearing for a mechanism that is gone: the client SEEDED transcripts, so every seeded byte was
 * resident in the server process for the session's lifetime (just-bash is a pure-JS VFS holding file
 * content in memory), and 256 KiB x 32 files was what bounded that at 8 MiB.
 *
 * Transcripts now arrive on a read-only `OverlayFs` mount that reads THROUGH to the host on demand
 * (`src/mount.ts`), so nothing is resident because nothing is copied. A 37.2 MB transcript — the
 * measured maximum over the live corpus — now costs whatever the model actually reads of it, and eve
 * bounds each `read_file` at 2000 lines or 50 KB
 * (node_modules/eve/dist/src/execution/sandbox/truncate-output.js). The budget moved from the seeding
 * path to the reader, where the model spends it deliberately.
 *
 * Keeping the constant would have been worse than deleting it: a 256 KiB number labelled "how many
 * bytes reach the sandbox" is now FALSE, and a future reader would have taken it as a live limit.
 * The distribution it was measured against is still recorded — 11,360 transcripts, 6.59 GB, p50
 * 332 KB, p90 915 KB, p99 4.68 MB, max 37.2 MB (2026-08-08) — because
 * `packages/traces/src/parse.ts:16-21` reasons about the same shape.
 */

/**
 * Ceiling on transcripts per run.
 *
 * This one SURVIVES the seeding path's removal, and its justification changes rather than
 * disappearing. It no longer bounds resident bytes — the mount does not copy — but it still bounds
 * how many files one agent session is asked to hold in attention, and it is the guard against a
 * caller handing over five thousand sessions, which is well within what one sleep cycle could find
 * unconsolidated. The sleep phase's own `TRACE_SESSIONS_PER_RUN` is lower and binds first; this is
 * the client's independent backstop against a different caller.
 */
export const MAX_TRANSCRIPTS_PER_RUN = 32

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
 * sleep cycle, and transcript text must not ride along into a report — the same posture
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
 * Kept apart from {@link ConsolidatorRunFailed} because it means something different about the
 * agent — it answered, and the answer broke the contract. Same posture as
 * `packages/llm/src/structured.ts:52-61`: a coerced object is indistinguishable from a real one
 * downstream, so nothing lenient happens here.
 */
export class ConsolidatorContractViolation extends Schema.TaggedError<ConsolidatorContractViolation>()(
  "ConsolidatorContractViolation",
  {
    reason: Schema.String
  }
) {}

/** Everything the client wrapper can fail with. */
export type ConsolidatorError =
  | ConsolidatorCredentialsMissing
  | ConsolidatorUnavailable
  | ConsolidatorRunFailed
  | ConsolidatorContractViolation

/**
 * Which env vars could authenticate the Bedrock provider, in the order the provider reads them.
 *
 * The provider has NO default AWS credential chain — verified live in the probe: no shared
 * config file, no SSO cache, no instance metadata, env vars only. So presence here is the whole
 * question, and a preflight cannot be fooled by a profile that only the AWS CLI can see.
 */
const BEARER_VAR = "AWS_BEARER_TOKEN_BEDROCK"
const SIGV4_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const

const present = (env: Record<string, string | undefined>, name: string): boolean => {
  const value = env[name]
  return value !== undefined && value.trim() !== ""
}

/**
 * Whether a consolidation run could authenticate at all, without making a call.
 *
 * The point of asking cheaply: the provider is lazy — `createAmazonBedrock` and
 * `provider(modelId)` both succeed with zero credentials, and nothing fails until the first
 * request, by which time a server has been built, spawned, and handed transcripts. Verified in
 * the probe. So the caller checks this first and skips, which is the INV-3 groundwork: CI has
 * no credentials and must stay green.
 *
 * Empty-string is treated as absent. A blank export is how a credential goes missing in
 * practice, and `""` would authenticate nothing while reading as present.
 *
 * This answers "could a call be attempted", never "would it be authorized". A stale or
 * unentitled key passes here and fails at the call as {@link ConsolidatorRunFailed} — the
 * honest split, since the only way to know a key works is to use it.
 */
export const hasConsolidatorCredentials = (
  env: Record<string, string | undefined> = process.env
): boolean => present(env, BEARER_VAR) || SIGV4_VARS.every((name) => present(env, name))

/**
 * The message carried on {@link ConsolidatorCredentialsMissing}: which env vars would fix it.
 *
 * Takes no environment on purpose. It names the two accepted MECHANISMS, which never vary, and
 * says nothing about which vars are currently set — a failure message is logged and reported by
 * the sleep cycle, so naming the present-but-rejected variables would put credential-shaped
 * details into a report for no diagnostic gain. Whether a given var is set is what
 * {@link hasConsolidatorCredentials} answers.
 */
export const credentialsMissingReason = (): string =>
  `no Bedrock credentials in the environment: set ${BEARER_VAR}, or ${SIGV4_VARS.join(" + ")}`

/**
 * Every kind is a real corpus type, restated so a reader of this file alone can see the
 * relationship without opening `@memhtml/contracts`.
 */
export const isConsolidationKind = (value: string): value is ConsolidationKind =>
  (CONSOLIDATION_KINDS as readonly string[]).includes(value) &&
  (MEMORY_TYPES as readonly string[]).includes(value)
