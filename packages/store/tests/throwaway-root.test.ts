import { access, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  assertThrowawayRootUntouched,
  THROWAWAY_ROOT_PREFIX,
  throwawayRoot,
  throwawayRootGlobalSetup,
  throwawayTestEnv
} from "../src/testing.js"

/**
 * The throwaway `MEMHTML_ROOT` helpers (issue #144), exercised under THIS worker's pid. The real
 * globalSetup runs in vitest's main process, whose pid differs, so creating this worker's root here
 * cannot trip the teardown of any suite that pins one.
 */
describe("the throwaway test root", () => {
  const root = throwawayRoot()
  const exitCode = process.exitCode

  afterEach(async () => {
    process.exitCode = exitCode
    await rm(root, { recursive: true, force: true })
  })

  it("is under the temp dir, named by this process's pid, and pinned with both edges off", () => {
    expect(root).toBe(join(tmpdir(), `${THROWAWAY_ROOT_PREFIX}${process.pid}`))
    expect(throwawayTestEnv()).toEqual({
      MEMHTML_ROOT: root,
      MEMHTML_EMBED: "off",
      MEMHTML_LLM: "off",
      MEMHTML_REFUSE_ENV_ROOT: "1"
    })
  })

  it("passes while the root is absent and names what it holds once it exists", async () => {
    await expect(assertThrowawayRootUntouched()).resolves.toBeUndefined()
    await mkdir(join(root, ".memhtml"), { recursive: true })
    await expect(assertThrowawayRootUntouched()).rejects.toThrow(/\.memhtml/)
    await expect(assertThrowawayRootUntouched()).rejects.toThrow(root)
  })

  it("removes a stale root in setup, and its teardown fails the process when a test created one", async () => {
    await mkdir(join(root, "stale"), { recursive: true })
    const teardown = await throwawayRootGlobalSetup()
    await expect(access(root)).rejects.toThrow()
    await expect(teardown()).resolves.toBeUndefined()
    expect(process.exitCode).toBe(exitCode)
    await mkdir(join(root, ".memhtml"), { recursive: true })
    await expect(teardown()).rejects.toThrow(/reached the app layer/)
    // The exit code is what makes a logged teardown error a red run; vitest only logs the throw.
    expect(process.exitCode).toBe(1)
  })
})
