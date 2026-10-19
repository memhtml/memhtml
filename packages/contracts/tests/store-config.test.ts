import { describe, expect, it } from "vitest"

import {
  DEFAULT_PLACEMENT_QUOTA,
  DEFAULT_STORE_POLICY,
  decodeStoreConfig,
  PLACEMENT_QUOTA_MAX,
  refusedTypeReason,
  STORE_CONFIG_FILE,
  STORE_POLICY_KEYS,
  storePolicyOf
} from "../src/store-config.js"

/**
 * The store's policy file, decoded. Pure: text in, a policy or a reason out.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `onExcessProperty: "error"` dropped from the decoder -> "refuses a misspelled key at any depth"
 *   (`requireAnchors` decodes as an empty write bar).
 * - the duplicate-type loop removed -> "refuses a type listed twice".
 * - `config.writeBar?.requireAnchor ?? ...` -> `?? true` -> "an empty file is the library default".
 */

const decoded = (value: unknown) => {
  const result = decodeStoreConfig(JSON.stringify(value))
  if (!result.ok) throw new Error(result.reason)
  return storePolicyOf(result.config)
}

const reasonOf = (text: string): string => {
  const result = decodeStoreConfig(text)
  if (result.ok) throw new Error(`decoded: ${text}`)
  return result.reason
}

describe("decodeStoreConfig", () => {
  it("an empty file is the library default, every key from the default", () => {
    const { policy, sources } = decoded({})
    expect(policy.writeBar.refusedTypes.size).toBe(0)
    expect(policy.writeBar.requireAnchor).toBe(false)
    expect(policy.v1Doors).toBe("closed-in-session")
    expect(policy.curator).toEqual({ writerBuckets: [], placementQuota: DEFAULT_PLACEMENT_QUOTA })
    expect(policy).toEqual(DEFAULT_STORE_POLICY)
    expect(Object.keys(sources)).toEqual([...STORE_POLICY_KEYS])
    expect(new Set(Object.values(sources))).toEqual(new Set(["default"]))
    expect(STORE_CONFIG_FILE).toBe("memhtml.config.json")
  })

  it("reads every key a file sets, names it as the file's, and leaves the rest at the default", () => {
    const { policy, sources } = decoded({
      writeBar: {
        refusedTypes: ["verdict", { type: "episodic", reason: "runs live in the trace index" }]
      },
      curator: { writerBuckets: ["*-import"] }
    })
    expect([...policy.writeBar.refusedTypes]).toEqual([
      ["verdict", refusedTypeReason("verdict")],
      ["episodic", "runs live in the trace index"]
    ])
    expect(refusedTypeReason("verdict")).toContain(STORE_CONFIG_FILE)
    expect(policy.writeBar.requireAnchor).toBe(false)
    expect(policy.curator.writerBuckets).toEqual(["*-import"])
    expect(sources).toEqual({
      "writeBar.refusedTypes": "file",
      "writeBar.requireAnchor": "default",
      v1Doors: "default",
      "curator.writerBuckets": "file",
      "curator.placementQuota": "default"
    })
    const strict = decoded({
      writeBar: { requireAnchor: true },
      v1Doors: "closed",
      curator: { placementQuota: 0 }
    })
    expect(strict.policy.writeBar.requireAnchor).toBe(true)
    expect(strict.policy.v1Doors).toBe("closed")
    expect(strict.policy.curator.placementQuota).toBe(0)
  })

  it("refuses a misspelled key at any depth, naming where", () => {
    expect(reasonOf('{"writeBar":{"requireAnchors":true}}')).toContain("requireAnchors")
    expect(reasonOf('{"v1Door":"open"}')).toContain("v1Door")
    expect(reasonOf('{"curator":{"buckets":[]}}')).toContain("buckets")
  })

  it("refuses a value outside its key's type", () => {
    expect(reasonOf('{"v1Doors":"shut"}')).toContain("v1Doors")
    expect(reasonOf('{"writeBar":{"requireAnchor":"yes"}}')).toContain("requireAnchor")
    expect(reasonOf('{"writeBar":{"refusedTypes":["narrative"]}}')).toContain("refusedTypes")
    expect(reasonOf('{"writeBar":{"refusedTypes":[{"type":"verdict","reason":""}]}}')).toContain(
      "reason"
    )
    expect(reasonOf('{"curator":{"placementQuota":1.5}}')).toContain("placementQuota")
    expect(reasonOf(`{"curator":{"placementQuota":${String(PLACEMENT_QUOTA_MAX + 1)}}}`)).toContain(
      "placementQuota"
    )
    expect(reasonOf('{"curator":{"writerBuckets":["areas/x-import"]}}')).toContain("writerBuckets")
    expect(reasonOf('{"curator":{"writerBuckets":[""]}}')).toContain("writerBuckets")
  })

  it("refuses a type listed twice", () => {
    expect(
      reasonOf('{"writeBar":{"refusedTypes":["verdict",{"type":"verdict","reason":"no"}]}}')
    ).toContain("`verdict` twice")
  })

  it("refuses text that is not JSON, and a top level that is not an object", () => {
    expect(reasonOf("{ writeBar: }")).toContain("not valid JSON")
    expect(reasonOf("[]")).toContain("Expected")
    expect(reasonOf("null")).toContain("Expected")
    expect(reasonOf("")).toContain("not valid JSON")
  })
})
