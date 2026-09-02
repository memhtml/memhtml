/**
 * The LLM-proxy configuration: three environment variables and the two parsers that read them.
 *
 * memhtml calls its models on Bedrock directly by default. Set {@link PROXY_BASE_URL_VAR} and every
 * model call goes to an OpenAI- and Anthropic-compatible LLM proxy instead — an agentgateway
 * listener, or anything else serving the same four routes:
 *
 * | Lane                       | Route                  | Wire format                      |
 * | -------------------------- | ---------------------- | -------------------------------- |
 * | the Anthropic sleep models | `/v1/messages`         | Anthropic Messages               |
 * | the OpenAI sleep model     | `/v1/chat/completions` | OpenAI chat completions          |
 * | Cohere embeddings          | `/v1/embeddings`       | OpenAI embeddings (+ `input_type`) |
 * | entity extraction          | `/v1/responses`        | OpenAI Responses                 |
 *
 * The consolidator agent (`apps/consolidator`) reads the SAME three variables through its own
 * dependency-free copy of this parser (`apps/consolidator/src/llm-proxy.ts`): its agent file may
 * not import a workspace package, because the published artifact bundles them rather than
 * installing them beside it. `apps/cli/tests/llm-proxy-parity.test.ts` pins the two copies to one
 * another.
 *
 * No `effect` import here either, so the parsers are the same plain functions in both copies.
 *
 * ## Why a model map, and why it defaults to identity
 *
 * A proxy names models on its own terms. memhtml asks for Bedrock inference-profile ids
 * (`global.anthropic.claude-opus-5`), and a proxy fronting Bedrock may accept those verbatim, or
 * may publish aliases and translate behind them. Which is the operator's choice, so the request
 * carries the Bedrock id unless {@link PROXY_MODEL_MAP_VAR} says otherwise; a mapping is a
 * deployment fact and belongs in the environment beside the URL it applies to.
 */

/** The proxy's origin, e.g. `http://127.0.0.1:4000`. Absent or blank means Bedrock directly. */
export const PROXY_BASE_URL_VAR = "MEMHTML_LLM_BASE_URL"

/** A bearer token the proxy requires, sent as `Authorization: Bearer <key>`. Optional. */
export const PROXY_API_KEY_VAR = "MEMHTML_LLM_API_KEY"

/**
 * `from=to` pairs, comma-separated, rewriting the model id a request carries:
 * `global.anthropic.claude-opus-5=claude-opus-5,cohere.embed-v4:0=cohere-embed-v4`.
 */
export const PROXY_MODEL_MAP_VAR = "MEMHTML_LLM_MODEL_MAP"

export interface ProxyConfig {
  /** The origin with no trailing slash; routes are appended to it. */
  readonly baseUrl: string
  /** `null` when the proxy takes no credential. */
  readonly apiKey: string | null
  /** memhtml's model id → the id the proxy wants. Absent keys pass through unchanged. */
  readonly modelMap: ReadonlyMap<string, string>
}

/**
 * The origin memhtml will append `/v1/...` to, or a thrown `Error` naming what is wrong with it.
 *
 * Trailing slashes are dropped so `http://host:4000/` and `http://host:4000` are one value, and the
 * scheme is required because a bare `host:4000` is what a shell profile most easily gets wrong and
 * `fetch` would reject it with a message that does not name the variable. Throwing rather than
 * returning `null` is deliberate: a set-but-unusable value dying at construction, with the variable
 * named, is the outcome `MEMHTML_CONSOLIDATOR_TURN_TIMEOUT_MS` chose for the same reason — a typo
 * that silently fell back to Bedrock direct would route production traffic somewhere the operator
 * did not point it.
 */
export const normalizeProxyBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!/^https?:\/\/[^/\s]+/.test(trimmed)) {
    throw new Error(
      `${PROXY_BASE_URL_VAR} must be an http(s) origin such as http://127.0.0.1:4000; got ${JSON.stringify(raw)}`
    )
  }
  return trimmed
}

/**
 * Parse {@link PROXY_MODEL_MAP_VAR}. Empty entries (a trailing comma) are ignored; an entry with no
 * `=`, an empty side, or a key mapped twice throws with the offending entry quoted, for the reason
 * {@link normalizeProxyBaseUrl} records.
 */
export const parseProxyModelMap = (raw: string): ReadonlyMap<string, string> => {
  const map = new Map<string, string>()
  for (const entry of raw.split(",")) {
    const pair = entry.trim()
    if (pair === "") continue
    const at = pair.indexOf("=")
    const from = at === -1 ? "" : pair.slice(0, at).trim()
    const to = at === -1 ? "" : pair.slice(at + 1).trim()
    if (from === "" || to === "") {
      throw new Error(
        `${PROXY_MODEL_MAP_VAR} entries are from=to pairs separated by commas; got ${JSON.stringify(pair)}`
      )
    }
    if (map.has(from)) {
      throw new Error(`${PROXY_MODEL_MAP_VAR} maps ${JSON.stringify(from)} twice`)
    }
    map.set(from, to)
  }
  return map
}

/**
 * The proxy configuration an environment describes, or `null` when {@link PROXY_BASE_URL_VAR} is
 * absent or blank — which is the default, Bedrock direct.
 *
 * A blank value reads as absent for the reason the credential preflight treats `""` as unset: a
 * blank export is how a variable goes missing in practice, and an empty origin is not a place to
 * send traffic.
 */
export const proxyConfigFromEnv = (
  env: Record<string, string | undefined> = process.env
): ProxyConfig | null => {
  const rawBaseUrl = env[PROXY_BASE_URL_VAR]?.trim() ?? ""
  if (rawBaseUrl === "") return null
  const apiKey = env[PROXY_API_KEY_VAR]?.trim() ?? ""
  return {
    baseUrl: normalizeProxyBaseUrl(rawBaseUrl),
    apiKey: apiKey === "" ? null : apiKey,
    modelMap: parseProxyModelMap(env[PROXY_MODEL_MAP_VAR] ?? "")
  }
}

/** The id the proxy is asked for: the mapped one when the map names it, the original otherwise. */
export const proxyModelId = (config: ProxyConfig, modelId: string): string =>
  config.modelMap.get(modelId) ?? modelId
