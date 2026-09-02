/**
 * The consolidation turn's two token ceilings, and why neither may be left to a default.
 *
 * Imported by `agent/agent.ts`, which eve compiles into the server it spawns. Constants rather than
 * anything computed per run: eve BAKES `limits` and the model wrapper into `.output/server/index.mjs`
 * at `eve build` time and reads them from that manifest at boot, so a value the client tried to pass
 * per batch on the child's environment would be ignored (measured 2026-09-02: an env-driven cap did
 * not reach the session; the built manifest's literal did).
 *
 * No `effect` import: nitro bundles this into the agent alongside `mount.ts` and `run-auth.ts`, and
 * arithmetic is all it should cost.
 *
 * ## The per-call ceiling is the one that broke the phase
 *
 * `MODEL_CALL_OUTPUT_TOKEN_LIMIT` is per model call. Unset, the Bedrock Converse request carries no
 * `inferenceConfig.maxTokens` at all — `@ai-sdk/amazon-bedrock@5.0.61` sets that field only when the
 * call settings name `maxOutputTokens` — and the service applies its own 4,096-token default. That is
 * ~16 KB, which the consolidator's answer does not fit: the payload is up to six candidates, each with
 * two verbatim quotes of up to 600 characters, plus commitments and a read receipt.
 *
 * Measured on a four-transcript batch (issue #113, run 2026-09-02 13:45Z): from model call 38 onward,
 * 28 consecutive calls finished with `finishReason: "length"` at exactly 4,096 output tokens, all 15
 * `final_output` calls arrived as `{}` or truncated JSON, and the turn ended 11 minutes later on a
 * Bedrock `MODEL_CALL_FAILED`. The answer was never expressible, so no cap on the SESSION could have
 * helped: the earlier 06:30Z runs under a 50,000-token session cap hit that ceiling first and parked,
 * which is the same defect one layer up.
 *
 * 64,000 is half of what the provider's own capability table reports for this model
 * (`getModelCapabilities("claude-opus-5").maxOutputTokens === 128_000`, `@ai-sdk/anthropic@4.0.41`),
 * so it is generous against a full payload and still leaves the model's stated ceiling untouched.
 * Opus 5 uses ADAPTIVE thinking on this provider, so no reasoning budget is added on top of this
 * number (`resolveAmazonBedrockReasoningConfig`: a budget is added to `maxTokens` only for the
 * `type: "enabled"` shape, which adaptive is not).
 *
 * ## The per-session ceiling, and what it is really for
 *
 * `sessionOutputTokenLimit` bounds the whole turn, reasoning included, because the provider reports
 * reasoning tokens as output tokens and this agent runs `reasoning: "high"`. The flat `50_000` that
 * stood here was described as bounding "the answer, not the reading"; it bounded the reading, and
 * every recorded turn against the operator's corpus landed within 6% of it (49,850 / 50,368 / 50,930 /
 * 51,696 / 52,956 output tokens over five turns on 2026-09-01/02).
 *
 * It is sized for the LARGEST batch the phase can hand over rather than a typical one, because the
 * value is fixed at build time and a cap that fits four transcripts would strangle a batch of
 * thirty-two. That makes it a backstop against a session that will not stop, not a tight budget: the
 * bound that actually protects an unattended run is the turn's TIME budget (`turnBudgetMsFor` in
 * `client.ts`, ten minutes plus three per transcript), which the client enforces and can cancel.
 */

/**
 * The largest batch the session ceiling is sized for.
 *
 * A LITERAL here rather than an import of `MAX_TRANSCRIPTS_PER_RUN`, and the duplication is the
 * point: `contract.ts` imports `effect` and `@memhtml/contracts`, and both are bundled INTO the
 * published artifact rather than installed beside it, so an agent file that reached them failed
 * `eve build` from an installed tarball with `ConsolidatorUnavailable` (caught by
 * `mise run package:smoke`, which is the only tier that installs the artifact). The agent's import
 * graph stays first-party and dependency-free — the same rule `mount.ts` and `run-auth.ts` follow.
 *
 * `tests/turn-limits.test.ts` pins this to `MAX_TRANSCRIPTS_PER_RUN`, so the copy cannot drift.
 */
export const SESSION_OUTPUT_TOKEN_MAX_BATCH = 32

/** Per model call. See the note above: unset, Bedrock applies 4,096 and the answer cannot fit. */
export const MODEL_CALL_OUTPUT_TOKEN_LIMIT = 64_000

/** The per-session budget's fixed part, spent once regardless of batch size. */
export const SESSION_OUTPUT_TOKEN_BASE = 30_000

/** The per-session budget's per-transcript part: reasoning and tool calls to read one transcript. */
export const SESSION_OUTPUT_TOKEN_PER_TRANSCRIPT = 40_000

/**
 * The session ceiling for a batch of `transcriptCount` transcripts.
 *
 * `agent/agent.ts` evaluates this at `MAX_TRANSCRIPTS_PER_RUN`, since the built agent serves every
 * batch size. Exported as a function anyway, because that is what makes the per-transcript figure
 * checkable against the measurement in `tests/turn-limits.test.ts` rather than a bare literal.
 */
export const sessionOutputTokenLimit = (transcriptCount: number): number =>
  SESSION_OUTPUT_TOKEN_BASE + SESSION_OUTPUT_TOKEN_PER_TRANSCRIPT * transcriptCount
