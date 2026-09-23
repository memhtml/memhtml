import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import {
  DETECTED_TASK_DIR,
  DETECTION_DIGEST_CHARS,
  DETECTION_PREFIX,
  detectedTaskPath,
  detectionKey,
  detectionKeyOf,
  isDetectedTaskPath
} from "../src/detected-tasks.js"

describe("the detection key's delimiter", () => {
  /**
   * The key is a corpus-visible identifier — it is IN the filename of every detected task — so the
   * digest input is a wire format and this asserts its bytes rather than its shape.
   */
  it("separates the detector from the finding with a NUL, so two splits cannot collide", () => {
    /**
     * Without a delimiter, `("ab", "c")` and `("a", "bc")` concatenate to one string and share a task:
     * one detector's sweep would then close the other's. The pair below is exactly that collision, and
     * a delimiter that were a space, a hyphen, or absent makes these two keys equal.
     */
    expect(detectionKey("ab", "c")).not.toBe(detectionKey("a", "bc"))
    // And the delimiter cannot be typed into either half: normalization collapses whitespace and a NUL
    // is not whitespace, so no finding can forge a boundary.
    expect(detectionKey("a", "b")).not.toBe(detectionKey("a\u0000b", ""))
  })

  it("digests the value the RAW byte digested, so no shipped key moves", () => {
    /**
     * The escape and the raw byte are one character, so this is a pin on the value rather than on the
     * spelling: a key already in a corpus filename must keep resolving. Computed here from the
     * documented input rather than copied from a run, so it fails if the composition changes.
     */
    const expected = `${DETECTION_PREFIX}${createHash("sha256")
      .update(`probe${String.fromCharCode(0)}service checkout-api payments-api`, "utf8")
      .digest("hex")
      .slice(0, DETECTION_DIGEST_CHARS)}`
    expect(detectionKey("probe", "service checkout-api payments-api")).toBe(expected)
  })

  it("keeps its own source file TEXT, which is what a repo-wide text gate can read", async () => {
    /**
     * A raw NUL in the source makes the file `data` to every text tool, and `grep` skips a file it
     * reads as binary WITHOUT saying so — so a repo-wide prose gate and every maintainer's grep had a
     * blind spot on exactly the file holding this delimiter. The escape is what keeps the file
     * greppable, and this is the assertion that stops the byte coming back.
     */
    const source = await readFile(
      new URL("../src/detected-tasks.ts", import.meta.url).pathname,
      "utf8"
    )
    expect(source.includes(String.fromCharCode(0))).toBe(false)
    expect(source).toContain("\\u0000")
  })
})

describe("the detected task path", () => {
  it("lands under the ordinary task placement and reads its key back", () => {
    const key = detectionKey("probe", "a finding")
    const path = detectedTaskPath(key, "Wire the capture path before the next release")
    expect(path.startsWith(`${DETECTED_TASK_DIR}/${DETECTION_PREFIX}`)).toBe(true)
    expect(detectionKeyOf(path)).toBe(key)
    expect(isDetectedTaskPath(path)).toBe(true)
    expect(isDetectedTaskPath("areas/inbox/tasks/hand-opened.html")).toBe(false)
  })

  it("is total over an empty title", () => {
    const key = detectionKey("probe", "empty")
    expect(detectedTaskPath(key, "")).toBe(`${DETECTED_TASK_DIR}/${key}-untitled.html`)
  })
})
