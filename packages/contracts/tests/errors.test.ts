import { describe, expect, it } from "vitest"

import {
  DirtyTree,
  DuplicateContent,
  InvalidMemory,
  LlmContractViolation,
  ModelUnavailable,
  PathNotFound,
  StorageFailure,
  WriteConflict
} from "../src/errors.js"

describe("errors", () => {
  it("tags every error with its own discriminator", () => {
    const tags = [
      StorageFailure.make({ operation: "run" })._tag,
      WriteConflict.make({ path: "/a.html", ourSha: "aa", theirSha: "bb" })._tag,
      ModelUnavailable.make({ modelId: "cohere.embed-v4:0", reason: "throttled" })._tag,
      InvalidMemory.make({ reason: "missing title" })._tag,
      PathNotFound.make({ path: "/nope.html" })._tag,
      DuplicateContent.make({ contentHash: "sha256:ff", existingPath: "/a.html" })._tag,
      DirtyTree.make({ paths: ["/a.html"] })._tag,
      LlmContractViolation.make({ reason: "stop_reason max_tokens" })._tag
    ]
    expect(new Set(tags).size).toBe(tags.length)
  })

  it("carries only the operation name on a storage failure", () => {
    const failure = StorageFailure.make({ operation: "writeAll" })
    expect(Object.keys(failure).sort()).toEqual(["_tag", "operation"])
  })

  it("names both shas on a write conflict so the caller can reconcile", () => {
    const conflict = WriteConflict.make({
      path: "/areas/oncall/rollback-order.html",
      ourSha: "1f4b9c",
      theirSha: "9e0b41"
    })
    expect(conflict.ourSha).not.toBe(conflict.theirSha)
    expect(conflict.path).toMatch(/^\//)
  })
})
