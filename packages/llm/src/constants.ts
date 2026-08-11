/**
 * Bedrock wire constants. Cohere Embed v4 returns 1536 floats when `output_dimension` is
 * absent and exactly 1024 when it is named (probed live 2026-08-02), so the InvokeModel
 * body names it — a silent default change would invalidate every stored vector against a
 * schema that says 1024.
 */
export const EMBED_MODEL_ID = "cohere.embed-v4:0"
export const EMBED_DIM = 1024

/** Cohere's per-request text ceiling. Batches larger than this are rejected. */
export const EMBED_BATCH_LIMIT = 96

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
 * A generous default: 8192 truncated early croq runs mid-object, and a truncated
 * structured response is a contract violation, not a partial result. `max_tokens` bounds
 * thinking and answer together, which is what makes a tight budget bite earlier than it
 * looks like it should.
 */
export const MAX_TOKENS_DEFAULT = 16_384

/**
 * Every Claude 5 generation tops out here. Above the ceiling Bedrock raises a
 * `ValidationException` rather than clamping, so the clamp lives on this side.
 */
export const MAX_TOKENS_CEILING = 128_000

/** The only valid `anthropic_version`. Not a model date. */
export const ANTHROPIC_VERSION = "bedrock-2023-05-31"
