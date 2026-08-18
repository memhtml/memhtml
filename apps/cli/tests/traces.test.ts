import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"

/**
 * `memhtml trace index` end to end, against a SYNTHESIZED trace root.
 *
 * Synthesized rather than real: nothing in this suite may read `~/.claude`, both because a test that
 * depended on a developer's transcripts would pass on one machine and fail on another, and because
 * those transcripts are the one corpus the trace plane deliberately never copies.
 *
 * The tail path is the interesting one, and it is why this file exists at the app layer rather than
 * only in `@memhtml/traces`: a tail's extract describes the APPENDED SLICE, so merging it correctly is a
 * property of how the CLI composes the scanner with the persister, not of either half alone.
 */

const SESSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"

const userLine = (uuid: string, promptId: string, at: string, text: string) =>
  `${JSON.stringify({
    type: "user",
    uuid,
    promptId,
    sessionId: SESSION,
    cwd: "/home/dev/checkout-api",
    gitBranch: "main",
    version: "2.0.14",
    timestamp: at,
    message: { role: "user", content: [{ type: "text", text }] }
  })}\n`

const assistantLine = (uuid: string, parentUuid: string, at: string, model: string) =>
  `${JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: SESSION,
    timestamp: at,
    message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] }
  })}\n`

/** A `file-history-snapshot`: no sessionId, no envelope at all. Counted and skipped, never an error. */
const snapshotLine = () => `${JSON.stringify({ type: "file-history-snapshot", messageId: "m1" })}\n`

describe("memhtml trace index", () => {
  let cli: Cli
  let traceRoot: string
  let transcript: string

  beforeAll(async () => {
    traceRoot = await mkdtemp(join(tmpdir(), "memhtml-trace-"))
    const slugDir = join(traceRoot, "projects", "-home-dev-checkout-api")
    await mkdir(slugDir, { recursive: true })
    transcript = join(slugDir, `${SESSION}.jsonl`)
    await writeFile(
      transcript,
      [
        userLine(
          "u1",
          "pr_01",
          "2026-08-01T10:00:00.000Z",
          "why did the checkout deploy roll back"
        ),
        assistantLine("a1", "u1", "2026-08-01T10:00:05.000Z", "claude-opus-5"),
        snapshotLine(),
        userLine("u2", "pr_02", "2026-08-01T10:05:00.000Z", "drain the vip first"),
        assistantLine("a2", "u2", "2026-08-01T10:05:09.000Z", "claude-opus-5")
      ].join(""),
      "utf8"
    )

    // MEMHTML_TRACE_ROOT is read through `effect/Config`, so the environment IS the interface here — the
    // same one a cron line uses.
    process.env.MEMHTML_TRACE_ROOT = traceRoot
    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
    await rm(traceRoot, { recursive: true, force: true })
    delete process.env.MEMHTML_TRACE_ROOT
  })

  it("indexes a session, counting the unenveloped record rather than failing on it", async () => {
    const report = await cli.json<{
      readonly traceRoot: string
      readonly filesSeen: number
      readonly rescanned: number
      readonly sessionsWritten: number
      readonly promptsWritten: number
      readonly bytesRead: number
    }>(["trace", "index"])

    expect(report.traceRoot).toBe(traceRoot)
    expect(report.filesSeen).toBe(1)
    expect(report.rescanned).toBe(1)
    expect(report.sessionsWritten).toBe(1)
    expect(report.promptsWritten).toBe(2)
    expect(report.bytesRead).toBeGreaterThan(0)
  })

  it("finds the session by what was asked in it", async () => {
    const result = await cli.json<{
      readonly sessions: ReadonlyArray<{
        readonly sessionId: string
        readonly cwd: string | null
        readonly promptCount: number
        readonly firstPrompt: string
      }>
    }>(["trace", "search", "checkout deploy roll back"])

    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session?.sessionId).toBe(SESSION)
    expect(session?.cwd).toBe("/home/dev/checkout-api")
    expect(session?.promptCount).toBe(2)
    expect(session?.firstPrompt).toContain("why did the checkout deploy")
  })

  it("answers a trace query whose raw text is a MATCH syntax error", async () => {
    // Same sanitizer, same reason as the memory arms: an apostrophe is a hard driver error and
    // "what did I ask about don't-repeat-yourself" is an ordinary query.
    const result = await cli.run(["trace", "search", "don't roll back"])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).type).toBe("trace.sessions")
  })

  it("skips a file the watermark already describes, reading zero bytes", async () => {
    const report = await cli.json<{ readonly skipped: number; readonly bytesRead: number }>([
      "trace",
      "index"
    ])
    expect(report.skipped).toBe(1)
    // The number the whole incremental design exists to keep at zero: a second run over an unchanged
    // corpus must not re-read 3.67 GB.
    expect(report.bytesRead).toBe(0)
  })

  it("merges an appended tail into the session rather than overwriting it", async () => {
    /**
     * The load-bearing assertion, and finding #16 made executable. The tail's extract describes the
     * APPENDED SLICE: its `firstPrompt` is `pr_03`'s text, its `startedAt` is 10:20, and its prompt
     * ordinals restart at 0. Writing it directly would reset `first_prompt` to a mid-conversation
     * prompt, move `started_at` forward, and collide every prompt at ordinal 0.
     */
    await appendFile(
      transcript,
      [
        userLine("u3", "pr_03", "2026-08-01T10:20:00.000Z", "and the target group bleed"),
        assistantLine("a3", "u3", "2026-08-01T10:20:04.000Z", "claude-opus-5")
      ].join(""),
      "utf8"
    )
    // A whole-second mtime granularity on some filesystems can make an append inside one tick look
    // unchanged, so the size change is what the watermark keys on here — and it did change.
    const report = await cli.json<{
      readonly tailed: number
      readonly tailsMerged: number
      readonly promptsWritten: number
    }>(["trace", "index"])

    expect(report.tailed).toBe(1)
    expect(report.tailsMerged).toBe(1)
    // Three prompts, not one: the merge renumbered the tail's ordinal-0 prompt onto the end of the
    // stored list rather than colliding with it.
    expect(report.promptsWritten).toBe(3)

    const result = await cli.json<{
      readonly sessions: ReadonlyArray<{
        readonly promptCount: number
        readonly firstPrompt: string
        readonly startedAt: string | null
      }>
    }>(["trace", "search", "checkout"])
    const session = result.sessions[0]
    expect(session?.promptCount).toBe(3)
    // Identity fields stay the OLDER side's: the session began at 10:00 with the rollback question,
    // and a tail cannot rewrite when it started or what was asked first.
    expect(session?.firstPrompt).toContain("why did the checkout deploy")
    expect(session?.startedAt).toBe("2026-08-01T10:00:00.000Z")
  })

  it("links a memory to a session in both directions", async () => {
    const written = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "episodic",
      "--title",
      "The checkout rollback needed a VIP drain first",
      "--claim",
      "The rollback stranded connections until the VIP was drained.",
      "--session-id",
      SESSION,
      "--prompt-id",
      "pr_02"
    ])

    const bySession = await cli.json<{
      readonly links: ReadonlyArray<{
        readonly path: string
        readonly promptId: string | null
        readonly linkKind: string
      }>
    }>(["trace", "links", "--session-id", SESSION])
    const link = bySession.links.find((entry) => entry.path === written.path)
    expect(link?.linkKind).toBe("wrote")
    expect(link?.promptId).toBe("pr_02")

    const byPath = await cli.json<{
      readonly links: ReadonlyArray<{ readonly sessionId: string }>
    }>(["trace", "links", "--path", written.path])
    expect(byPath.links.some((entry) => entry.sessionId === SESSION)).toBe(true)
  })

  it("keeps the trace plane out of memory retrieval", async () => {
    /**
     * The firewall, as a behavioral assertion rather than a SQL grep. The corpus holds ONE memory
     * about the rollback and the trace plane holds a session whose first prompt is about the same
     * thing — so if the two planes were joined anywhere, a memory search would return a session and
     * a trace search would return a memory path. Neither may happen.
     */
    const hits = await cli.json<{ readonly hits: ReadonlyArray<{ readonly path: string }> }>([
      "search",
      "checkout deploy roll back"
    ])
    for (const hit of hits.hits) expect(hit.path).toMatch(/\.html$/)

    const sessions = await cli.json<{
      readonly sessions: ReadonlyArray<{ readonly sessionId: string }>
    }>(["trace", "search", "VIP drain"])
    for (const session of sessions.sessions) {
      expect(session.sessionId).toBe(SESSION)
    }
  })
})
