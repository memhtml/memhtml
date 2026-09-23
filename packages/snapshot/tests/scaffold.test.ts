import { describe, expect, it } from "vitest"
import { PACKAGE } from "../src/index.js"

describe("scaffold", () => {
  it("names itself", () => {
    expect(PACKAGE).toBe("@memhtml/snapshot")
  })
})
