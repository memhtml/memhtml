import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import {
  discoverSessions,
  PROJECTS_DIR,
  type SessionFile,
  sessionIdFromPath,
  sidecarAgentIds
} from "../src/discover.js"

/** The checked-in fixture tree: two slugs, one main session each, one sidecar under the first. */
const FIXTURE_ROOT = new URL("./fixtures", import.meta.url).pathname

const ALPHA = "11111111-1111-4111-8111-111111111111"
const BETA = "22222222-2222-4222-8222-222222222222"

/** Fails the test on an unexpected `StorageFailure`, which is what a rejected promise does. */
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const runResult = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

const byPath = (files: ReadonlyArray<SessionFile>) =>
  [...files].sort((left, right) => left.filePath.localeCompare(right.filePath))

describe("discoverSessions", () => {
  it("finds all three transcripts of the fixture tree with the right slug, id, and kind", async () => {
    const files = byPath(await run(discoverSessions(FIXTURE_ROOT)))

    expect(
      files.map((file) => ({
        slug: file.slug,
        sessionId: file.sessionId,
        kind: file.kind,
        agentId: file.agentId
      }))
    ).toEqual([
      // Sorted by path: `<sessionId>.jsonl` precedes `<sessionId>/subagents/…`.
      { slug: "-tmp-fixture-alpha", sessionId: ALPHA, kind: "session", agentId: null },
      {
        slug: "-tmp-fixture-alpha",
        sessionId: ALPHA,
        kind: "subagent",
        agentId: "aaaa1111bbbb2222"
      },
      { slug: "-tmp-fixture-beta", sessionId: BETA, kind: "session", agentId: null }
    ])
  })

  it("takes a sidecar's session id from its parent directory, not from its filename", async () => {
    const files = await run(discoverSessions(FIXTURE_ROOT))
    const sidecar = files.find((file) => file.kind === "subagent")
    expect(sidecar?.sessionId).toBe(ALPHA)
    expect(sidecar?.filePath).toContain(join(ALPHA, "subagents", "agent-aaaa1111bbbb2222.jsonl"))
  })

  it("ignores the .meta.json beside a sidecar transcript", async () => {
    const files = await run(discoverSessions(FIXTURE_ROOT))
    expect(files.every((file) => file.filePath.endsWith(".jsonl"))).toBe(true)
  })

  it("stats every file it reports", async () => {
    const files = await run(discoverSessions(FIXTURE_ROOT))
    for (const file of files) {
      expect(file.size).toBeGreaterThan(0)
      expect(file.mtimeMs).toBeGreaterThan(0)
    }
  })

  it("returns nothing for a root with no projects directory", async () => {
    const files = await run(discoverSessions(join(FIXTURE_ROOT, "does-not-exist")))
    expect(files).toEqual([])
  })

  it("returns nothing when the projects path is a file rather than a directory", async () => {
    const root = await tempRoot("notdir")
    await writeFile(join(root, PROJECTS_DIR), "not a directory\n")
    expect(await run(discoverSessions(root))).toEqual([])
  })

  it("skips a session directory that has no subagents directory yet", async () => {
    const root = await tempRoot("nosubagents")
    const slugDir = join(root, PROJECTS_DIR, "-tmp-solo")
    await mkdir(join(slugDir, "sess-1"), { recursive: true })
    await writeFile(join(slugDir, "sess-1.jsonl"), "")

    const files = await run(discoverSessions(root))
    expect(files.map((file) => file.kind)).toEqual(["session"])
  })

  it("reports an unreadable projects directory as a StorageFailure rather than as empty", async () => {
    const root = await tempRoot("denied")
    const projects = join(root, PROJECTS_DIR)
    await mkdir(projects, { recursive: true })
    // A tree the scan cannot read must not be reported as a successful scan of zero sessions.
    const { chmod } = await import("node:fs/promises")
    await chmod(projects, 0o000)
    try {
      const result = await runResult(discoverSessions(root))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("StorageFailure")
        expect(result.failure.operation).toBe("traces.discover.projects")
      }
    } finally {
      await chmod(projects, 0o755)
    }
  })

  it("finds a zero-byte transcript, which is a session that has not written a record yet", async () => {
    const root = await tempRoot("empty-file")
    const slugDir = join(root, PROJECTS_DIR, "-tmp-empty")
    await mkdir(slugDir, { recursive: true })
    await writeFile(join(slugDir, "sess-empty.jsonl"), "")

    const files = await run(discoverSessions(root))
    expect(files).toHaveLength(1)
    expect(files[0]?.size).toBe(0)
  })

  it("ignores a non-jsonl file in a slug directory", async () => {
    const root = await tempRoot("stray")
    const slugDir = join(root, PROJECTS_DIR, "-tmp-stray")
    await mkdir(slugDir, { recursive: true })
    await writeFile(join(slugDir, "notes.md"), "not a transcript\n")
    await writeFile(join(slugDir, "sess-1.jsonl"), "")

    const files = await run(discoverSessions(root))
    expect(files.map((file) => file.sessionId)).toEqual(["sess-1"])
  })
})

describe("the mtime a discovered file reports", () => {
  /**
   * The regression that defeated the whole incremental design.
   *
   * `Stats.mtimeMs` is a FLOAT on Linux, and `trace_watermarks.mtime` is ISO-8601 text with
   * millisecond resolution. So a stored watermark reads back truncated, the skip test
   * `curr.mtimeMs === prev.mtimeMs` failed for every unchanged file, and every run re-read the
   * entire 3.67 GB corpus while reporting a rescan of every file.
   *
   * The assertion is the ROUND TRIP, not the integrality: a value that survives
   * `Date.parse(new Date(v).toISOString())` unchanged is the property the watermark needs, and it is
   * what a comparison tolerance would only have approximated.
   */
  it("survives the ISO-8601 round trip the watermark column stores it through", async () => {
    const root = await tempRoot("mtime")
    const slugDir = join(root, PROJECTS_DIR, "-tmp-mtime")
    await mkdir(slugDir, { recursive: true })
    await writeFile(join(slugDir, `${ALPHA}.jsonl`), '{"type":"user"}\n', "utf8")

    const files = await run(discoverSessions(root))
    expect(files).toHaveLength(1)
    const mtimeMs = files[0]?.mtimeMs as number

    const roundTripped = Date.parse(new Date(mtimeMs).toISOString())
    expect(roundTripped).toBe(mtimeMs)
  })
})

describe("sidecarAgentIds", () => {
  it("names only the agents of the session asked for", async () => {
    const files = await run(discoverSessions(FIXTURE_ROOT))
    expect(sidecarAgentIds(files, ALPHA)).toEqual(["aaaa1111bbbb2222"])
    expect(sidecarAgentIds(files, BETA)).toEqual([])
  })
})

describe("sessionIdFromPath", () => {
  it("reads a main session's id from its filename stem", () => {
    expect(sessionIdFromPath(`/root/${PROJECTS_DIR}/-tmp-a/sess-1.jsonl`, "/root")).toBe("sess-1")
  })

  it("reads a sidecar's id from its owning session directory", () => {
    expect(
      sessionIdFromPath(`/root/${PROJECTS_DIR}/-tmp-a/sess-1/subagents/agent-x.jsonl`, "/root")
    ).toBe("sess-1")
  })

  it("refuses a path outside the trace root", () => {
    expect(sessionIdFromPath("/elsewhere/sess-1.jsonl", "/root")).toBeNull()
  })

  it("refuses a path at the wrong depth inside the root", () => {
    expect(sessionIdFromPath(`/root/${PROJECTS_DIR}/sess-1.jsonl`, "/root")).toBeNull()
    expect(
      sessionIdFromPath(`/root/${PROJECTS_DIR}/-tmp-a/sess-1/notsubagents/agent-x.jsonl`, "/root")
    ).toBeNull()
  })
})

/** A per-test scratch root under the OS temp dir. Never inside the fixture tree. */
const tempRoot = async (name: string): Promise<string> => {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  return mkdtemp(join(tmpdir(), `memhtml-traces-${name}-`))
}
