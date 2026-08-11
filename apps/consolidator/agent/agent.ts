import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { defineAgent } from "eve"

/**
 * The consolidator agent's runtime config.
 *
 * eve is filesystem-first: this file IS the config, reached by `eve build` then `eve start`,
 * never by a programmatic `defineAgent().run()`. `agent/instructions.md` is required and carries
 * the TRACE-2 bar. The client wrapper in `src/client.ts` drives it over HTTP.
 *
 * Bedrock direct, not the Vercel AI Gateway: the gateway is an anti-goal, and a
 * provider-authored `LanguageModel` is how eve is told to call a provider directly
 * (node_modules/eve/docs/agent-config.md, "Set the model").
 *
 * Credentials are read from the environment by the provider itself and there is NO default AWS
 * chain — `AWS_BEARER_TOKEN_BEDROCK`, else `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. No
 * shared config file, no SSO cache, no instance metadata. The provider is also lazy: this call
 * and the `bedrock(...)` call below both succeed with zero credentials and nothing fails until
 * the first request, which is exactly why `hasConsolidatorCredentials()` exists in
 * `src/contract.ts` and runs before a server is ever spawned.
 */
const bedrock = createAmazonBedrock({ region: process.env.AWS_REGION ?? "us-east-1" })

export default defineAgent({
  model: bedrock("global.anthropic.claude-opus-5"),

  /**
   * REQUIRED here, unlike for a gateway model id. eve's window catalog does not know this
   * model id, and without the window it cannot judge when to compact. Verified against the
   * installed 0.31.0 type: `modelContextWindowTokens?: number` on the agent definition
   * (node_modules/eve/dist/src/shared/agent-definition.d.ts:59).
   *
   * **1,000,000 is the window Opus 5 serves on the Bedrock global inference profile**, confirmed by
   * the operator. The reason a number has to be written here at all is that eve resolves windows from
   * a Gateway catalog that does not know an inference profile id, so the resolution it would do is
   * unavailable rather than merely wrong — and the number it previously carried, 200_000, was not a
   * measurement of anything: it was the conservative value chosen when the catalog came up empty.
   *
   * Not cosmetic. This drives eve's COMPACTION THRESHOLD, so a window declared at a fifth of the real
   * one makes the harness compact a session that had four fifths of its budget left — and compaction
   * of a transcript-reading session discards the earlier reads a cross-session pattern is assembled
   * from, which is the one thing this agent exists to find.
   */
  modelContextWindowTokens: 1_000_000,

  /**
   * Provider-agnostic reasoning ONLY. Do not add
   * `modelOptions.providerOptions.bedrock.reasoningConfig`.
   *
   * Probed live: Opus 5 rejects `reasoningConfig: { type: "enabled", budgetTokens }` outright,
   * and eve drops an unsupported `providerOptions` silently — so the pairing fails in the worst
   * way, looking configured while being either an error or a no-op. `reasoning: "high"` is
   * forwarded by eve to the turn's model calls and is what actually takes effect.
   */
  reasoning: "high",

  limits: {
    /**
     * A batch of transcripts is a read-heavy job with a small answer. This bounds the answer,
     * not the reading, so a run cannot spin producing candidates.
     *
     * Crossing it does not raise a continuation prompt here: a run driven by the client wrapper
     * has no human to ask, and eve fails the next model call with `SESSION_TOKEN_LIMIT_REACHED`
     * for sessions that cannot reach one. That surfaces as a typed `ConsolidatorRunFailed`.
     */
    maxOutputTokensPerSession: 50_000
  }
})
