import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
// Mocked below to `path.win32`: these two read the mock, the way `mount.ts` would on a win32 host.
import { normalize, sep } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { readOnlyRootsProblem } from "../src/mount.js"

/**
 * The guest-path rules of `mount.ts` under win32 path semantics, simulated on the Linux CI host.
 *
 * A guest path is POSIX on every host, since just-bash's filesystem is a POSIX tree; the host's
 * `node:path` is not. On win32, `path.normalize("/mnt/memhtml")` is `\mnt\memhtml`, so a rule that
 * judged a guest path with it refused every mount (upstream issue #156). Here `node:path` is
 * replaced with `path.win32` for every module this file loads, `mount.ts` included, so the rules
 * run against the host semantics a win32 machine has, and the first case proves the simulation is
 * in force before any other case can pass on it.
 *
 * Mutation, run once with the change applied and the named case red:
 * - `mount.ts` `readOnlyRootsProblem`: normalize with `node:path`'s `normalize` instead of
 *   `node:path/posix`'s -> "accepts a POSIX guest path under win32 path semantics" (the answer is
 *   `mount path "/mnt/memhtml" must be an absolute, normalized guest path`).
 */

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path")
  return { ...actual.win32, default: actual.win32 }
})

let host: string

beforeAll(async () => {
  // `tmpdir()` and the host path stay POSIX: the host filesystem is this machine's.
  host = await mkdtemp(`${tmpdir()}/mount-win32-`)
})

afterAll(async () => {
  await rm(host, { recursive: true, force: true })
})

describe("guest mount paths under win32 path semantics", () => {
  it("is running with win32's node:path", () => {
    expect(sep).toBe("\\")
    expect(normalize("/mnt/memhtml")).toBe("\\mnt\\memhtml")
  })

  it("accepts a POSIX guest path under win32 path semantics", () => {
    expect(readOnlyRootsProblem([{ mountPath: "/mnt/memhtml", hostPath: host }])).toBeNull()
    expect(readOnlyRootsProblem([{ mountPath: "/mnt/traces/run", hostPath: host }])).toBeNull()
  })

  it("still refuses what is not an absolute, normalized POSIX guest path", () => {
    for (const mountPath of [
      "mnt/memhtml",
      "/mnt/memhtml/",
      "/mnt//memhtml",
      "/mnt/./memhtml",
      "\\mnt\\memhtml",
      "C:\\mnt\\memhtml"
    ]) {
      expect(
        readOnlyRootsProblem([{ mountPath, hostPath: host }]),
        JSON.stringify(mountPath)
      ).toContain("must be an absolute, normalized guest path")
    }
  })
})
