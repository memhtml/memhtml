import type { Effect } from "effect"

/**
 * The consolidator as this package sees it: a structural port, declared here and satisfied elsewhere.
 *
 * **Sleep must not depend on eve, and this file is how that holds.** The real consolidator is
 * `apps/consolidator` — an eve agent over the AI SDK Bedrock provider, `just-bash` sandbox and all —
 * and a `@memhtml/sleep` that imported it would drag a 17 MB agent build and a network client into the
 * dependency closure of a package whose entire test tier is a temp-dir git repo and an in-memory
 * Turso. So sleep declares the SHAPE it consumes and `apps/cli`, the composition root, is the one
 * module that knows both halves exist. Exactly the posture `env.ts` already takes for git, the
 * database, and the model.
 *
 * **Structural, so the adapter is zero lines.** TypeScript is structural, so
 * `apps/consolidator`'s `ConsolidatorShape` (`apps/consolidator/src/client.ts:38-42`) is assignable
 * to {@link ConsolidatorPort} directly — no wrapper function, no `as` cast, and nothing that could
 * translate one field into another and drift. Each type below is deliberately WIDER than the
 * concrete one it accepts:
 *
 * - `kind` is `string` rather than the six-value `CONSOLIDATION_KINDS`, because the phase gates it
 *   against `@memhtml/contracts`' own vocabulary anyway (a kind is a corpus type or it is not written)
 *   and a narrower type here would be a second copy of that list, free to drift from the one the
 *   store enforces.
 * - {@link ConsolidatorFailure} is `_tag` + `reason`, which all four of the real client's typed
 *   errors carry verbatim (`apps/consolidator/src/contract.ts:232-277`). The phase branches on
 *   `_tag` for the report line and never on a payload, so nothing narrower is needed and anything
 *   narrower would pin this package to that error union's exact membership.
 */

/** One transcript the phase asks to have read, named by the session it belongs to. */
export interface TranscriptRef {
  readonly sessionId: string
  /** Absolute path to the JSONL under `MEMHTML_TRACE_ROOT`. The phase never opens it. */
  readonly filePath: string
}

/**
 * One session as the generated manifest describes it: the transcript, plus what its bytes cannot say.
 *
 * Wider than {@link TranscriptRef} and every added field OPTIONAL, which mirrors the plane: `traces`
 * declares most of its columns nullable (`packages/index/migrations/0005_traces.sql`), and a phase that
 * defaulted an absent `cwd` would be asserting something about the session rather than reporting it.
 *
 * Structurally assignable to the real client's `TranscriptManifestEntry`
 * (`apps/consolidator/src/client.ts`), the same way the rest of this port is — see the module note.
 */
export interface TranscriptManifestEntry extends TranscriptRef {
  readonly slug?: string | undefined
  readonly cwd?: string | undefined
  readonly gitBranch?: string | undefined
  readonly startedAt?: string | undefined
  readonly endedAt?: string | undefined
  readonly fileMtime?: string | undefined
  readonly fileSize?: number | undefined
  readonly promptCount?: number | undefined
  readonly turnCount?: number | undefined
  /**
   * Memories the corpus already links to this session. `[]` and absent mean different things
   * downstream: `[]` says the corpus holds none, which is a session whose findings were never written
   * down, while absent says the phase did not look.
   */
  readonly linkedMemories?:
    | ReadonlyArray<{ readonly path: string; readonly linkKind: string }>
    | undefined
}

/** One transcript line a candidate rests on. Carried for the commit message, never into a memory. */
export interface CandidateEvidenceLike {
  readonly sessionId: string
  readonly quote: string
}

/**
 * One distilled candidate, as the phase reads it.
 *
 * `claim` becomes the file's `<mark>` and therefore `files.gist`; `gist` becomes its prose. The
 * naming inversion is real and it is the consolidator's, not this port's: there, `claim` is the one
 * sentence and `gist` is the supporting detail (`apps/consolidator/src/contract.ts:77-86`), while in
 * the corpus `gist` is the extracted `<mark>` text. The phase maps `claim → claim` and
 * `gist → body`, which is the only reading under which both files mean what they say.
 */
export interface CandidateMemoryLike {
  /** A `MemoryType` value verbatim. Gated against the writable vocabulary before anything is written. */
  readonly kind: string
  readonly claim: string
  readonly gist: string
  readonly entities: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<CandidateEvidenceLike>
}

/** What one consolidation run produced, what it cost, and which sessions it actually reached. */
export interface ConsolidationOutcome {
  readonly candidates: ReadonlyArray<CandidateMemoryLike>
  /**
   * Model calls the run actually made. NOT one: the eve harness loops, so a run that grepped five
   * times made five calls, and the number comes back counted from the stream rather than assumed.
   * The phase reports it verbatim as its `llmCalls`.
   */
  readonly llmCalls: number
  /**
   * The sessions whose transcripts REACHED the agent, which is the only set the phase may watermark.
   *
   * REQUIRED, and that is what makes "never watermark a session whose transcript never arrived"
   * structural rather than advisory. The phase cannot ask the batch instead — a batch is what it
   * REQUESTED, and the difference between requested and reached is exactly a transcript that was
   * rotated away, moved outside `MEMHTML_TRACE_ROOT`, or sits behind a symlink the sandbox will not
   * follow. Watermarking the batch records such a session as consolidated and never reads it again.
   *
   * The port cannot verify the set, and it does not have to: the phase INTERSECTS it with the batch
   * (`markSessionsConsolidated`'s input in `phases/trace-consolidation.ts`), so a consolidator that
   * over-reported could still only cause sessions in the batch to be watermarked. What no consolidator
   * can do is make the phase watermark something it did not name.
   */
  readonly analyzedSessionIds: ReadonlyArray<string>
}

/**
 * Anything the port can fail with. `_tag` names the class for the phase's report line; `reason` is
 * already free of transcript content by the real client's own contract, so it is safe to log.
 */
export interface ConsolidatorFailure {
  readonly _tag: string
  readonly reason: string
}

/**
 * The one method the phase calls.
 *
 * **The transcript ROOT is deliberately not here.** The real consolidator mounts it read-only — that
 * is how transcripts reach the agent, rather than through a model message — but it is `MEMHTML_TRACE_ROOT`
 * configuration, constant for a client's whole life, so it is bound when the client is CONSTRUCTED in
 * the CLI's composition root (`makeConsolidator({ traceRoot })`).
 *
 * Keeping it out of this signature is what stops it becoming a phase's concern. It would otherwise have
 * to reach a phase through `PhaseEnv`, which every one of the fifteen phases shares — so one phase's
 * mount detail would be in the environment of the fourteen that never read a transcript, and the sleep
 * package would carry a field whose only meaning is inside an eve sandbox it is firewalled from.
 */
export interface ConsolidatorPort {
  readonly consolidate: (input: {
    readonly transcripts: ReadonlyArray<TranscriptManifestEntry>
  }) => Effect.Effect<ConsolidationOutcome, ConsolidatorFailure>
}
