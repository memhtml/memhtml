import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"

/**
 * The plan's end-to-end verification item 5: the trace plane, and `trace_links` round-tripping from a
 * write that carried `--session-id`.
 *
 * **This lives in its own FILE, and that is a correctness requirement rather than tidiness.**
 * `MEMHTML_TRACE_ROOT` is read through `effect/Config`, which resolves against a snapshot of
 * `process.env` taken when the config provider is first built — so a `process.env.MEMHTML_TRACE_ROOT`
 * assigned inside a `beforeAll` that runs AFTER another suite in the same file has already resolved a
 * config is silently ignored, and `TraceRoot` falls back to its default of `~/.claude`.
 *
 * The consequence is not a failed assertion, it is a test that scans the developer's REAL transcript
 * corpus: measured on this machine at 3.67 GB across 5,387 files, which built a 38 MB `index.db` in a
 * temp repo and hung the suite well past any timeout. Verified directly — a `Config.string(...)` with a
 * default read once before the variable is set returns the default forever after, in the same process.
 *
 * Setting the variable at MODULE SCOPE, before any test or hook runs, is what makes the synthesized
 * root the one the scanner actually reads. A per-file `MEMHTML_TRACE_ROOT` also cannot leak into a sibling
 * suite, because vitest gives each file its own process.
 */

// Module scope, before any config is resolved anywhere in this file's process.
const TRACE_ROOT = await mkdtemp(join(tmpdir(), "memhtml-integration-traces-"))
process.env.MEMHTML_TRACE_ROOT = TRACE_ROOT

const SESSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

describe("verification item 5 — the trace plane, and trace_links from a --session-id write", () => {
  let cli: Cli
  let transcript: string

  beforeAll(async () => {
    /**
     * SYNTHESIZED, never `~/.claude`. A test reading a developer's transcripts would pass on one
     * machine and fail on another, and those transcripts are the one corpus the trace plane
     * deliberately never copies.
     */
    const slugDir = join(TRACE_ROOT, "projects", "-home-dev-payments")
    await mkdir(slugDir, { recursive: true })
    transcript = join(slugDir, `${SESSION}.jsonl`)

    const userLine = (uuid: string, promptId: string, at: string, text: string) =>
      `${JSON.stringify({
        type: "user",
        uuid,
        promptId,
        sessionId: SESSION,
        cwd: "/home/dev/payments",
        gitBranch: "main",
        version: "2.0.14",
        timestamp: at,
        message: { role: "user", content: [{ type: "text", text }] }
      })}\n`
    const assistantLine = (uuid: string, parentUuid: string, at: string) =>
      `${JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid,
        sessionId: SESSION,
        timestamp: at,
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }]
        }
      })}\n`

    await writeFile(
      transcript,
      [
        userLine("u1", "pr_01", "2026-08-01T10:00:00.000Z", "why did the settlement lane stall"),
        assistantLine("a1", "u1", "2026-08-01T10:00:05.000Z"),
        // No sessionId and no envelope at all: counted and skipped, never an error.
        `${JSON.stringify({ type: "file-history-snapshot", messageId: "m1" })}\n`,
        userLine("u2", "pr_02", "2026-08-01T10:05:00.000Z", "check the idempotency key first")
      ].join(""),
      "utf8"
    )

    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
    await rm(TRACE_ROOT, { recursive: true, force: true })
    delete process.env.MEMHTML_TRACE_ROOT
  })

  it("indexes the synthesized trace root, counting the unenveloped record", async () => {
    const report = await cli.json<{
      readonly traceRoot: string
      readonly filesSeen: number
      readonly sessionsWritten: number
      readonly promptsWritten: number
      readonly bytesRead: number
    }>(["trace", "index"])

    expect(report.traceRoot).toBe(TRACE_ROOT)
    expect(report.filesSeen).toBe(1)
    expect(report.sessionsWritten).toBe(1)
    expect(report.promptsWritten).toBe(2)
    expect(report.bytesRead).toBeGreaterThan(0)
  })

  it("skips a file the watermark already describes, and TAILS an appended slice", async () => {
    /**
     * The incremental design's whole point. A second scan of an unchanged corpus must read zero bytes:
     * the mtime is compared through the producer's own ms-integer readback (finding #38), never against
     * a raw `Stats.mtimeMs` float.
     */
    const unchanged = await cli.json<{
      readonly skipped: number
      readonly rescanned: number
      readonly bytesRead: number
    }>(["trace", "index"])
    expect(unchanged.skipped).toBe(1)
    expect(unchanged.rescanned).toBe(0)
    expect(unchanged.bytesRead).toBe(0)

    // Appending advances size and mtime, so the scanner reads only the new bytes.
    await appendFile(
      transcript,
      `${JSON.stringify({
        type: "user",
        uuid: "u3",
        promptId: "pr_03",
        sessionId: SESSION,
        timestamp: "2026-08-01T10:10:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "and the chargeback window" }] }
      })}\n`,
      "utf8"
    )

    const tailed = await cli.json<{
      readonly tailed: number
      readonly rescanned: number
      readonly tailsMerged: number
      readonly promptsWritten: number
      readonly bytesRead: number
    }>(["trace", "index"])
    expect(tailed.tailed).toBe(1)
    expect(tailed.rescanned).toBe(0)
    expect(tailed.tailsMerged).toBe(1)

    /**
     * Only the appended bytes were read, and that is the assertion the incremental design earns —
     * measured against the appended line's own length rather than against a constant, so a change to
     * the fixture cannot silently make this vacuous.
     */
    expect(tailed.bytesRead).toBeGreaterThan(0)
    expect(tailed.bytesRead).toBeLessThan(400)

    /**
     * **`promptsWritten` is the MERGED total for the session, not the count of appended prompts.**
     * `persistScanned` writes the merged prompt list with a delete-and-insert — the merged list is
     * authoritative and complete for the session, and an upsert would leave a stale row whose ordinal
     * the merge renumbered — so the number reports rows WRITTEN, which after a tail is all three. The
     * distinction is exactly the coordinate-space confusion the metarepo's semantic-contracts rule
     * warns about: `_count` of what, over which scope.
     */
    expect(tailed.promptsWritten).toBe(3)
  })

  it("keeps the session's own identity across the tail merge", async () => {
    /**
     * Finding #16: a tail's extract describes the APPENDED SLICE, so `first_prompt` is a
     * mid-conversation prompt and `started_at` is later than the session's. `mergeTailExtract` is what
     * keeps the row describing the SESSION — asserted here because the merge is a property of how the
     * CLI composes the scanner with the persister, not of either half alone.
     */
    const found = await cli.json<{
      readonly sessions: ReadonlyArray<{
        readonly sessionId: string
        readonly firstPrompt: string
        readonly promptCount: number
        readonly cwd: string | null
      }>
    }>(["trace", "search", "settlement lane stall"])

    const session = found.sessions.find((one) => one.sessionId === SESSION)
    expect(session).toBeDefined()
    // Still the FIRST prompt, not the appended one.
    expect(session?.firstPrompt).toContain("why did the settlement lane stall")
    expect(session?.promptCount).toBe(3)
    expect(session?.cwd).toBe("/home/dev/payments")
  })

  it("round-trips trace_links from a write carrying --session-id, in both directions", async () => {
    const written = await writeMemory(cli, {
      title: "The settlement lane stalls when the idempotency key is reused",
      claim: "A reused idempotency key stalls the settlement lane.",
      type: "error_pattern",
      sessionId: SESSION
    })

    // Session -> memories.
    const bySession = await cli.json<{
      readonly links: ReadonlyArray<{ readonly path: string; readonly linkKind: string }>
    }>(["trace", "links", "--session-id", SESSION])
    expect(bySession.links.some((link) => link.path === written.path)).toBe(true)
    expect(bySession.links.some((link) => link.linkKind === "wrote")).toBe(true)

    // Memory -> sessions.
    const byPath = await cli.json<{
      readonly links: ReadonlyArray<{ readonly sessionId: string }>
    }>(["trace", "links", "--path", written.path])
    expect(byPath.links.some((link) => link.sessionId === SESSION)).toBe(true)

    /**
     * And FILE-BORNE, which is the half that survives `rm index.db`. The link exists in both planes on
     * purpose: the row is queryable and the head stamp is durable.
     */
    const html = await readFile(join(cli.root, written.path), "utf8")
    expect(html).toContain(`content="${SESSION}"`)
  })

  it("keeps the trace plane out of memory retrieval entirely", async () => {
    // The firewall as a behavioural assertion: a phrase that exists ONLY in a transcript must not be
    // findable through `memhtml search`, whatever the FTS index holds.
    const hits = await cli.json<{ readonly hits: ReadonlyArray<{ readonly path: string }> }>([
      "search",
      "why did the settlement lane stall"
    ])
    for (const hit of hits.hits) {
      expect(hit.path.endsWith(".html")).toBe(true)
      expect(hit.path).not.toContain(".jsonl")
    }
  })
})
