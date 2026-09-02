import * as consolidator from "@memhtml/consolidator"
import * as llm from "@memhtml/llm"
import { describe, expect, it } from "vitest"

import { CONFIG_VARS } from "../src/config.js"

/**
 * The LLM-proxy environment is read by two copies of one parser: `@memhtml/llm`'s
 * `proxy-config.ts`, which the sleep lanes and the extractor use, and the consolidator's
 * dependency-free `llm-proxy.ts`, which eve compiles into the agent server and which may import
 * neither `effect` nor a workspace package (the published artifact bundles them rather than
 * installing them beside it — `apps/consolidator/tests/agent-files.test.ts`).
 *
 * This app is the one place that depends on both, so this is where the copies are held to one
 * another. Every case feeds the same input to both and asserts the same answer, so an edit to one
 * side fails here until the other side follows.
 */

const SAMPLE_ENVS: ReadonlyArray<Record<string, string | undefined>> = [
  {},
  { MEMHTML_LLM_BASE_URL: "  " },
  { MEMHTML_LLM_BASE_URL: "http://127.0.0.1:4000/" },
  {
    MEMHTML_LLM_BASE_URL: " https://llm.example.internal ",
    MEMHTML_LLM_API_KEY: " secret ",
    MEMHTML_LLM_MODEL_MAP:
      " global.anthropic.claude-opus-5=claude-opus-5 ,cohere.embed-v4:0=cohere-embed-v4, "
  },
  { MEMHTML_LLM_BASE_URL: "http://h", MEMHTML_LLM_API_KEY: "   " }
]

const MODEL_IDS = ["global.anthropic.claude-opus-5", "cohere.embed-v4:0", "openai.gpt-5.6-luna"]

const MALFORMED: ReadonlyArray<Record<string, string | undefined>> = [
  { MEMHTML_LLM_BASE_URL: "127.0.0.1:4000" },
  { MEMHTML_LLM_BASE_URL: "ftp://h" },
  { MEMHTML_LLM_BASE_URL: "http://h", MEMHTML_LLM_MODEL_MAP: "claude-opus-5" },
  { MEMHTML_LLM_BASE_URL: "http://h", MEMHTML_LLM_MODEL_MAP: "a=" },
  { MEMHTML_LLM_BASE_URL: "http://h", MEMHTML_LLM_MODEL_MAP: "a=b,a=c" }
]

describe("the consolidator's proxy reader agrees with @memhtml/llm's", () => {
  it("names the same three variables", () => {
    expect(consolidator.PROXY_BASE_URL_VAR).toBe(llm.PROXY_BASE_URL_VAR)
    expect(consolidator.PROXY_API_KEY_VAR).toBe(llm.PROXY_API_KEY_VAR)
    expect(consolidator.PROXY_MODEL_MAP_VAR).toBe(llm.PROXY_MODEL_MAP_VAR)
  })

  it("parses every sample environment to the same origin, key, and model resolution", () => {
    for (const env of SAMPLE_ENVS) {
      const theirs = consolidator.proxyFromEnv(env)
      const ours = llm.proxyConfigFromEnv(env)
      expect(theirs === null, JSON.stringify(env)).toBe(ours === null)
      if (theirs === null || ours === null) continue
      expect(theirs.baseUrl).toBe(ours.baseUrl)
      expect(theirs.apiKey).toBe(ours.apiKey)
      for (const id of MODEL_IDS) expect(theirs.modelFor(id)).toBe(llm.proxyModelId(ours, id))
    }
  })

  it("rejects the same malformed environments with the same message", () => {
    for (const env of MALFORMED) {
      const theirs = (() => {
        try {
          consolidator.proxyFromEnv(env)
          return null
        } catch (cause) {
          return cause instanceof Error ? cause.message : String(cause)
        }
      })()
      const ours = (() => {
        try {
          llm.proxyConfigFromEnv(env)
          return null
        } catch (cause) {
          return cause instanceof Error ? cause.message : String(cause)
        }
      })()
      expect(theirs, JSON.stringify(env)).not.toBeNull()
      expect(theirs).toBe(ours)
    }
  })

  /** And the manifest discloses all three, under the names the code reads. */
  it("is disclosed by the manifest under the same names", () => {
    const declared = new Set(CONFIG_VARS.map((variable) => variable.name))
    expect(declared.has(llm.PROXY_BASE_URL_VAR)).toBe(true)
    expect(declared.has(llm.PROXY_API_KEY_VAR)).toBe(true)
    expect(declared.has(llm.PROXY_MODEL_MAP_VAR)).toBe(true)
  })
})
