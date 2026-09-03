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
 * | entity extraction          | `/v1/chat/completions` | OpenAI chat completions          |
 *
 * The consolidator agent (`apps/consolidator`) reads the SAME three variables through its own
 * dependency-free copy of this parser (`apps/consolidator/src/llm-proxy.ts`): its agent file may
 * not import a workspace package, because the published artifact bundles them rather than
 * installing them beside it. `apps/cli/tests/llm-proxy-parity.test.ts` pins the two copies to one
 * another.
 *
 * No `effect` import here either, so the parsers are the same plain functions in both copies.
 *
 * ## How a model is named to the proxy
 *
 * A proxy names models on its own terms, and memhtml asks for Bedrock inference-profile ids
 * (`global.anthropic.claude-opus-5`). The default bridge is the LiteLLM convention: the provider,
 * a slash, and the provider's exact id — `bedrock/global.anthropic.claude-opus-5`. It is lossless
 * (the id after the slash is exactly what Bedrock wants, so nothing is stripped and nothing can be
 * stripped wrong), a LiteLLM proxy routes it with one `bedrock/*` wildcard entry, and it names the
 * provider, which matters once a proxy fronts more than Bedrock. {@link PROXY_MODEL_PREFIX_VAR}
 * changes the prefix, or removes it (`none`) for a proxy that wants bare ids, and
 * {@link PROXY_MODEL_MAP_VAR} overrides single models by exact name, taking precedence over the
 * prefix.
 */

/** The proxy's origin, e.g. `http://127.0.0.1:4000`. Absent or blank means Bedrock directly. */
export const PROXY_BASE_URL_VAR = "MEMHTML_LLM_BASE_URL"

/** A bearer token the proxy requires, sent as `Authorization: Bearer <key>`. Optional. */
export const PROXY_API_KEY_VAR = "MEMHTML_LLM_API_KEY"

/**
 * `from=to` pairs, comma-separated, naming single models to the proxy by exact id:
 * `cohere.embed-v4:0=cohere-embed-v4`. A mapped id is sent verbatim, with no prefix.
 */
export const PROXY_MODEL_MAP_VAR = "MEMHTML_LLM_MODEL_MAP"

/**
 * The prefix put in front of every unmapped Bedrock id. Unset or blank means
 * {@link DEFAULT_PROXY_MODEL_PREFIX}; the literal {@link PROXY_MODEL_PREFIX_NONE} sends bare ids.
 */
export const PROXY_MODEL_PREFIX_VAR = "MEMHTML_LLM_MODEL_PREFIX"

/** LiteLLM's provider prefix for Bedrock: `bedrock/global.anthropic.claude-opus-5`. */
export const DEFAULT_PROXY_MODEL_PREFIX = "bedrock/"

/**
 * The value of {@link PROXY_MODEL_PREFIX_VAR} that means "no prefix". A WORD rather than the empty
 * string, because `effect/Config` reads an empty environment value as absent (probed against the
 * pinned release: `Config.string` fails on `""` exactly as on a missing key, so `withDefault` fires
 * for both). The sleep lanes read this variable through `Config` and the consolidator reads it from
 * `process.env` directly, and "" would have meant the default on one path and no prefix on the
 * other. Compared case-insensitively.
 */
export const PROXY_MODEL_PREFIX_NONE = "none"

export interface ProxyConfig {
  /** The origin with no trailing slash; routes are appended to it. */
  readonly baseUrl: string
  /** `null` when the proxy takes no credential. */
  readonly apiKey: string | null
  /** Prepended to every Bedrock id the map does not name. May be empty. */
  readonly modelPrefix: string
  /** memhtml's model id → the exact id the proxy wants, sent without the prefix. */
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
  // A loop rather than `/\/+$/`: that regex backtracks quadratically on a long run of slashes
  // (CodeQL `js/polynomial-redos`), and the value arrives from an environment nobody bounds.
  const stripped = raw.trim()
  let end = stripped.length
  while (end > 0 && stripped[end - 1] === "/") end -= 1
  const trimmed = stripped.slice(0, end)
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
    modelPrefix: proxyModelPrefix(env[PROXY_MODEL_PREFIX_VAR]),
    modelMap: parseProxyModelMap(env[PROXY_MODEL_MAP_VAR] ?? "")
  }
}

/**
 * The prefix a raw {@link PROXY_MODEL_PREFIX_VAR} value means: unset or blank is the LiteLLM
 * default, {@link PROXY_MODEL_PREFIX_NONE} is no prefix at all, anything else is taken as written
 * after trimming. Blank reads as unset for the reason every other variable here treats it so — a
 * blank export is how a variable goes missing — and because `Config` cannot see the difference.
 */
export const proxyModelPrefix = (raw: string | undefined): string => {
  const value = raw?.trim() ?? ""
  if (value === "") return DEFAULT_PROXY_MODEL_PREFIX
  if (value.toLowerCase() === PROXY_MODEL_PREFIX_NONE) return ""
  return value
}

/**
 * The id the proxy is asked for: the map's exact name when it has one, else the prefix and the
 * Bedrock id. The map wins so one odd model can be named by hand while the rest follow the rule.
 */
export const proxyModelId = (config: ProxyConfig, modelId: string): string =>
  config.modelMap.get(modelId) ?? `${config.modelPrefix}${modelId}`
