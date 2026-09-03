import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  MAX_CONTEXT_CHARS,
  MAX_HITS_PER_SEARCH,
  MAX_LINE_CHARS,
  MAX_LINES_PER_READ,
  readTranscriptLines,
  searchTranscript,
  transcriptTools
} from "../src/tools.js"

/**
 * The three transcript tools, driven against real files with the shapes that broke the shell they
 * replace: a line over a megabyte long, a multi-megabyte file, and a phrase that appears hundreds of
 * times. Every assertion is about a BOUND — what comes back is a slice, a capped list, or a count —
 * because an unbounded result is the defect class (the 2026-09-03 stall) this module exists to end.
 */

let root = ""
let small = ""
let wide = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "consolidator-tools-"))
  await mkdir(join(root, "projects"), { recursive: true })
  small = join(root, "projects", "small.jsonl")
  await writeFile(
    small,
    [
      '{"type":"user","text":"please drain the VIP before the revert"}',
      '{"type":"assistant","text":"Draining the VIP first. The revert alone leaves connections pinned."}',
      '{"type":"user","text":"the vip drain worked; ship it"}',
      '{"type":"tool","text":"exit 0"}'
    ].join("\n") + "\n"
  )
  // One line past a megabyte with the needle buried in the middle, then a normal line.
  const half = "x".repeat(600_000)
  wide = join(root, "projects", "wide.jsonl")
  await writeFile(wide, `{"text":"${half}needle-in-the-middle${half}"}\n{"text":"needle again"}\n`)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("searchTranscript", () => {
  it("finds every occurrence of a literal phrase with bounded context", async () => {
    const result = await searchTranscript({
      sessionId: "small",
      hostPath: small,
      needle: "VIP",
      ignoreCase: false,
      maxHits: 20,
      contextChars: 12
    })
    expect(result.totalMatches).toBe(2)
    expect(result.matchingLines).toBe(2)
    expect(result.linesScanned).toBe(4)
    expect(result.truncated).toBe(false)
    expect(result.hits.map((hit) => hit.line)).toEqual([1, 2])
    for (const hit of result.hits) {
      expect(hit.match).toBe("VIP")
      expect(hit.before.length).toBeLessThanOrEqual(12)
      expect(hit.after.length).toBeLessThanOrEqual(12)
    }
  })

  it("matches case-insensitively only when asked", async () => {
    const strict = await searchTranscript({
      sessionId: "small",
      hostPath: small,
      needle: "vip",
      ignoreCase: false,
      maxHits: 20,
      contextChars: 20
    })
    const loose = await searchTranscript({
      sessionId: "small",
      hostPath: small,
      needle: "vip",
      ignoreCase: true,
      maxHits: 20,
      contextChars: 20
    })
    expect(strict.totalMatches).toBe(1)
    expect(loose.totalMatches).toBe(3)
    // The returned match keeps the transcript's own casing.
    expect(loose.hits.map((hit) => hit.match)).toEqual(["VIP", "VIP", "vip"])
  })

  it("returns a slice of a megabyte line, never the line, and still counts every match", async () => {
    const result = await searchTranscript({
      sessionId: "wide",
      hostPath: wide,
      needle: "needle",
      ignoreCase: false,
      maxHits: 1,
      contextChars: 5_000
    })
    expect(result.totalMatches).toBe(2)
    expect(result.hits).toHaveLength(1)
    expect(result.truncated).toBe(true)
    const [hit] = result.hits
    expect(hit?.line).toBe(1)
    expect(hit?.column).toBe(600_010)
    // The caller asked for 5,000 characters of context and got the ceiling.
    expect(hit?.before.length).toBe(MAX_CONTEXT_CHARS)
    expect(hit?.after.length).toBe(MAX_CONTEXT_CHARS)
  })

  it("caps the hits it returns at the module ceiling however many were asked for", async () => {
    const many = join(root, "projects", "many.jsonl")
    await writeFile(many, Array.from({ length: 300 }, (_, i) => `{"n":${i},"t":"hit"}`).join("\n"))
    const result = await searchTranscript({
      sessionId: "many",
      hostPath: many,
      needle: "hit",
      ignoreCase: false,
      maxHits: 10_000,
      contextChars: 10
    })
    expect(result.totalMatches).toBe(300)
    expect(result.hits).toHaveLength(MAX_HITS_PER_SEARCH)
    expect(result.truncated).toBe(true)
  })
})

describe("readTranscriptLines", () => {
  it("returns the requested range, 1-based and inclusive", async () => {
    const result = await readTranscriptLines({
      sessionId: "small",
      hostPath: small,
      start: 2,
      end: 3,
      maxChars: 500
    })
    expect(result.lines.map((line) => line.line)).toEqual([2, 3])
    expect(result.lines[0]?.text).toContain("Draining the VIP first")
    expect(result.lines.every((line) => !line.truncated)).toBe(true)
    expect(result.lastLineSeen).toBe(3)
  })

  it("cuts a megabyte line at the requested width with a marker, and never past the ceiling", async () => {
    const result = await readTranscriptLines({
      sessionId: "wide",
      hostPath: wide,
      start: 1,
      end: 1,
      maxChars: 50_000
    })
    const [line] = result.lines
    expect(line?.truncated).toBe(true)
    expect(line?.text.length).toBe(MAX_LINE_CHARS + 1)
    expect(line?.text.endsWith("…")).toBe(true)
  })

  it("clamps the range to the per-call line ceiling", async () => {
    const many = join(root, "projects", "lines.jsonl")
    await writeFile(many, Array.from({ length: 1_000 }, (_, i) => `{"n":${i}}`).join("\n"))
    const result = await readTranscriptLines({
      sessionId: "lines",
      hostPath: many,
      start: 1,
      end: 1_000,
      maxChars: 100
    })
    expect(result.lines).toHaveLength(MAX_LINES_PER_READ)
    expect(result.end).toBe(MAX_LINES_PER_READ)
  })

  it("reads past the end of the file without failing", async () => {
    const result = await readTranscriptLines({
      sessionId: "small",
      hostPath: small,
      start: 3,
      end: 40,
      maxChars: 100
    })
    expect(result.lines.map((line) => line.line)).toEqual([3, 4])
    expect(result.lastLineSeen).toBe(4)
  })
})

describe("transcriptTools", () => {
  const tools = () =>
    transcriptTools({
      entries: [
        {
          entry: { sessionId: "small", filePath: small, slug: "-tmp-small", promptCount: 2 },
          hostPath: small
        },
        { entry: { sessionId: "wide", filePath: wide }, hostPath: wide }
      ]
    })

  const call = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    const set = tools()
    const tool = set[name]
    if (tool?.execute === undefined) throw new Error(`no executable tool ${name}`)
    const execute = tool.execute as (input: unknown, options: unknown) => Promise<unknown>
    return execute(input, { toolCallId: "t1", messages: [] })
  }

  it("serves the manifest with metadata and linkedMemories always present, and no paths", async () => {
    const manifest = (await call("list_sessions", {})) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(manifest.sessions.map((s) => s.sessionId)).toEqual(["small", "wide"])
    expect(manifest.sessions[0]?.linkedMemories).toEqual([])
    expect(manifest.sessions[0]?.promptCount).toBe(2)
    expect(JSON.stringify(manifest)).not.toContain(root)
  })

  it("resolves a session id to its transcript and refuses one it was not handed", async () => {
    const found = (await call("search_transcript", { sessionId: "small", needle: "VIP" })) as {
      totalMatches: number
    }
    expect(found.totalMatches).toBe(2)
    const unknown = (await call("search_transcript", { sessionId: "other", needle: "VIP" })) as {
      error: string
      knownSessionIds: string[]
    }
    expect(unknown.error).toContain("unknown sessionId")
    expect(unknown.knownSessionIds).toEqual(["small", "wide"])
  })

  it("exposes exactly the three read-only tools and nothing that takes a path or a command", () => {
    expect(Object.keys(tools()).sort()).toEqual([
      "list_sessions",
      "read_lines",
      "search_transcript"
    ])
  })
})
