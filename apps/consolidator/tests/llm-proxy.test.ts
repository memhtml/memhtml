import { describe, expect, it } from "vitest"

import {
  normalizeProxyBaseUrl,
  PROXY_API_KEY_VAR,
  PROXY_BASE_URL_VAR,
  PROXY_MODEL_MAP_VAR,
  parseProxyModelMap,
  proxyFromEnv
} from "../src/llm-proxy.js"

/**
 * The consolidator's own reading of the proxy environment. This module is a dependency-free copy of
 * `packages/llm/src/proxy-config.ts`; `apps/cli/tests/llm-proxy-parity.test.ts` holds the two to
 * one another, and this file covers what the agent relies on from this copy alone.
 */

describe("proxyFromEnv", () => {
  it("is null with no base URL, or a blank one", () => {
    expect(proxyFromEnv({})).toBeNull()
    expect(proxyFromEnv({ [PROXY_BASE_URL_VAR]: " " })).toBeNull()
    // The other two variables mean nothing on their own.
    expect(proxyFromEnv({ [PROXY_API_KEY_VAR]: "k", [PROXY_MODEL_MAP_VAR]: "a=b" })).toBeNull()
  })

  it("normalizes the origin and resolves model ids through the map, identity when unmapped", () => {
    const proxy = proxyFromEnv({
      [PROXY_BASE_URL_VAR]: "http://127.0.0.1:4000/",
      [PROXY_MODEL_MAP_VAR]: "global.anthropic.claude-opus-5=claude-opus-5"
    })
    expect(proxy?.baseUrl).toBe("http://127.0.0.1:4000")
    expect(proxy?.apiKey).toBeNull()
    expect(proxy?.modelFor("global.anthropic.claude-opus-5")).toBe("claude-opus-5")
    expect(proxy?.modelFor("global.anthropic.claude-sonnet-5")).toBe(
      "global.anthropic.claude-sonnet-5"
    )
  })

  it("trims the key and treats a blank one as none", () => {
    expect(
      proxyFromEnv({ [PROXY_BASE_URL_VAR]: "http://h", [PROXY_API_KEY_VAR]: " k " })?.apiKey
    ).toBe("k")
    expect(
      proxyFromEnv({ [PROXY_BASE_URL_VAR]: "http://h", [PROXY_API_KEY_VAR]: "  " })?.apiKey
    ).toBeNull()
  })

  it("throws with the variable named on a malformed origin or map", () => {
    expect(() => normalizeProxyBaseUrl("h:4000")).toThrow(/MEMHTML_LLM_BASE_URL/)
    expect(() => parseProxyModelMap("no-equals")).toThrow(/MEMHTML_LLM_MODEL_MAP/)
    expect(() =>
      proxyFromEnv({ [PROXY_BASE_URL_VAR]: "http://h", [PROXY_MODEL_MAP_VAR]: "a=b,a=c" })
    ).toThrow(/twice/)
  })
})
