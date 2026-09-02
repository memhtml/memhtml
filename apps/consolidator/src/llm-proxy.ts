/**
 * The LLM-proxy environment, as the consolidator reads it.
 *
 * memhtml calls its models on Bedrock directly by default. Set {@link PROXY_BASE_URL_VAR} and the
 * consolidator agent instead calls an OpenAI- and Anthropic-compatible LLM proxy — an agentgateway
 * listener, or anything else serving the Anthropic Messages route at `<base>/v1/messages`.
 *
 * ## A dependency-free COPY of `packages/llm/src/proxy-config.ts`, on purpose
 *
 * `agent/agent.ts` imports this, and eve compiles that file into the server it spawns. The twelve
 * `@memhtml/*` packages are BUNDLED into the published artifact rather than installed beside it, so
 * an agent file importing `@memhtml/llm` builds in the workspace and fails `eve build` from an
 * installed tarball with `ConsolidatorUnavailable` (`tests/agent-files.test.ts` records the trap).
 * The same rule keeps `effect` out of here. `apps/cli/tests/llm-proxy-parity.test.ts` pins this
 * copy to the original: same variable names, same parse of the same inputs.
 *
 * `src/contract.ts` reads it too, for the credential preflight: a proxy is a way to reach a model,
 * so its presence is what lets a run that holds no Bedrock credential proceed.
 */

/** The proxy's origin, e.g. `http://127.0.0.1:4000`. Absent or blank means Bedrock directly. */
export const PROXY_BASE_URL_VAR = "MEMHTML_LLM_BASE_URL"

/** A bearer token the proxy requires, sent as `Authorization: Bearer <key>`. Optional. */
export const PROXY_API_KEY_VAR = "MEMHTML_LLM_API_KEY"

/** `from=to` pairs, comma-separated, rewriting the model id a request carries. */
export const PROXY_MODEL_MAP_VAR = "MEMHTML_LLM_MODEL_MAP"

export interface ConsolidatorProxy {
  /** The origin with no trailing slash. */
  readonly baseUrl: string
  /** `null` when the proxy takes no credential. */
  readonly apiKey: string | null
  /** The id the proxy is asked for: the mapped one when the map names it, the original otherwise. */
  readonly modelFor: (modelId: string) => string
}

/** See `normalizeProxyBaseUrl` in `packages/llm/src/proxy-config.ts`; this is that function. */
export const normalizeProxyBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!/^https?:\/\/[^/\s]+/.test(trimmed)) {
    throw new Error(
      `${PROXY_BASE_URL_VAR} must be an http(s) origin such as http://127.0.0.1:4000; got ${JSON.stringify(raw)}`
    )
  }
  return trimmed
}

/** See `parseProxyModelMap` in `packages/llm/src/proxy-config.ts`; this is that function. */
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
 * The proxy an environment describes, or `null` when {@link PROXY_BASE_URL_VAR} is absent or blank.
 * A set-but-malformed value throws with the variable named, for the reason the original records: a
 * typo that silently fell back to Bedrock direct would route the run somewhere the operator did
 * not point it.
 */
export const proxyFromEnv = (
  env: Record<string, string | undefined> = process.env
): ConsolidatorProxy | null => {
  const rawBaseUrl = env[PROXY_BASE_URL_VAR]?.trim() ?? ""
  if (rawBaseUrl === "") return null
  const apiKey = env[PROXY_API_KEY_VAR]?.trim() ?? ""
  const modelMap = parseProxyModelMap(env[PROXY_MODEL_MAP_VAR] ?? "")
  return {
    baseUrl: normalizeProxyBaseUrl(rawBaseUrl),
    apiKey: apiKey === "" ? null : apiKey,
    modelFor: (modelId) => modelMap.get(modelId) ?? modelId
  }
}
