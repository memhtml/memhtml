import { describe, expect, it } from "vitest"

import { MEMHTML_DIR, PARA_BUCKETS } from "../src/index.js"

describe("para buckets", () => {
  it("is exactly the four PARA buckets, in order", () => {
    expect(PARA_BUCKETS).toEqual(["projects", "areas", "resources", "archive"])
  })

  it("holds no duplicate and no bucket that collides with the state dir", () => {
    expect(new Set(PARA_BUCKETS).size).toBe(PARA_BUCKETS.length)
    expect(PARA_BUCKETS).not.toContain(MEMHTML_DIR)
  })
})
