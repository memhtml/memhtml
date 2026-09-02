/**
 * Bedrock wire constants. Cohere Embed v4 returns 1536 floats when `output_dimension` is
 * absent and exactly 1024 when it is named (probed live 2026-08-02), so the InvokeModel
 * body names it. If the default changed without notice, every stored vector would be
 * invalid against a schema that says 1024.
 */
export const EMBED_MODEL_ID = "cohere.embed-v4:0"
export const EMBED_DIM = 1024

/** Cohere's per-request text ceiling. Batches larger than this are rejected. */
export const EMBED_BATCH_LIMIT = 96

/**
 * How many embed batches are in flight at once.
 *
 * A whole-store pass is `ceil(chunks / EMBED_BATCH_LIMIT)` requests, about 105 for a 10k-chunk
 * corpus. Issuing them one after another makes `index rebuild --embed` a serial chain of network
 * round trips, which is the slowest thing this system does.
 *
 * The concurrency is bounded, and the bound protects a shared quota rather than local resources.
 * Bedrock rate-limits per account, so every caller in the account draws on one tokens-per-minute
 * budget, and an unbounded fan-out would spend that budget in one burst and throttle every other
 * consumer. Throttles that do occur are absorbed below Effect by the SDK's adaptive retry
 * (`maxAttempts: 10`), which backs off per request. A slightly-too-high bound therefore costs
 * latency instead of failing the run.
 */
export const EMBED_CONCURRENCY = 6

/**
 * The watermark value `index_state.embed_model` stores. Both axes in one string, because
 * a model id alone does not identify a vector space: the same id at another
 * `output_dimension` produces vectors that are silently incomparable with the stored ones.
 */
export const EMBED_WATERMARK = `${EMBED_MODEL_ID}@${EMBED_DIM}`

/**
 * The forced-tool name for structured output. One name across every phase, so a decoder
 * can assert on it rather than on positional order in `content`.
 */
export const STRUCTURED_TOOL_NAME = "emit"

/**
 * The per-call output budget when a caller names none. A budget of 8192 has been observed
 * truncating structured responses mid-object, and a truncated structured response is a contract
 * violation rather than a partial result. `max_tokens` bounds thinking and answer together, so a
 * tight budget is consumed sooner than the answer's length alone suggests, and every sleep phase
 * here runs with reasoning on.
 *
 * 64,000 rather than the 16,384 that stood here: the same number the consolidator settled on for
 * its own per-call ceiling (`apps/consolidator/src/output-budget.ts`, issue #113), half of the
 * 128,000 ceiling below, and generous against the largest structured answer any phase asks for. A
 * budget is a ceiling and not a spend — the model stops when the answer is done — so the cost of a
 * high default is only paid by the answers that needed it.
 */
export const MAX_TOKENS_DEFAULT = 64_000

/**
 * Every Claude 5 generation tops out here. Above the ceiling Bedrock raises a
 * `ValidationException` rather than clamping, so the clamp lives on this side.
 */
export const MAX_TOKENS_CEILING = 128_000

/** The only valid `anthropic_version`. Not a model date. */
export const ANTHROPIC_VERSION = "bedrock-2023-05-31"
