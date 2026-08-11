import { describe, expect, it } from "vitest"

import {
  agentCountFor,
  extractFromText,
  FIRST_PROMPT_LIMIT,
  TEXT_HEAD_LIMIT,
  userText
} from "../src/extract.js"

const FILE = { filePath: "/fixtures/projects/-tmp-x/s1.jsonl", slug: "-tmp-x" }

const enveloped = (fields: Record<string, unknown>) =>
  JSON.stringify({
    sessionId: "s1",
    cwd: "/tmp/x",
    gitBranch: "main",
    entrypoint: "cli",
    version: "2.1.219",
    isSidechain: false,
    userType: "external",
    ...fields
  })

const userLine = (uuid: string, promptId: string, at: string, content: unknown) =>
  enveloped({ type: "user", uuid, promptId, timestamp: at, message: { role: "user", content } })

const assistantLine = (uuid: string, at: string, model: string) =>
  enveloped({
    type: "assistant",
    uuid,
    timestamp: at,
    message: { role: "assistant", id: `m-${uuid}`, model, content: [{ type: "text", text: "ok" }] }
  })

describe("userText", () => {
  it("reads a bare string content", () => {
    expect(userText({ role: "user", content: "  a   prompt\n" })).toBe("a prompt")
  })

  it("reads text blocks, which is how most real prompts arrive", () => {
    expect(
      userText({
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" }
        ]
      })
    ).toBe("first second")
  })

  it("yields nothing for a tool_result-only block list", () => {
    expect(
      userText({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: "out" }]
      })
    ).toBe("")
  })

  it("keeps the text half of a mixed image+text list and drops the image", () => {
    expect(
      userText({
        role: "user",
        content: [
          { type: "image", source: {} },
          { type: "text", text: "look at this" }
        ]
      })
    ).toBe("look at this")
  })

  it("yields nothing rather than throwing for absent, null, and non-object content", () => {
    expect(userText(undefined)).toBe("")
    expect(userText(null)).toBe("")
    expect(userText({ role: "user" })).toBe("")
    expect(userText({ role: "user", content: 42 })).toBe("")
    expect(userText("not a message")).toBe("")
  })
})

describe("extractFromText counters", () => {
  it("counts every disposition and throws on none of them", () => {
    const text = [
      '{"type":"mode","mode":"default","sessionId":"s1"}',
      '{"type":"file-history-snapshot","messageId":"m","snapshot":{},"isSnapshotUpdate":false}',
      '{"type":"user","sessionId":',
      '"a bare JSON string, not a record"',
      "[1, 2, 3]",
      '{"noTypeField":true}',
      '{"type":"user","uuid":"u0","promptId":"p0","timestamp":"2026-08-01T10:00:00.000Z"}',
      '{"type":"a-type-from-a-later-release","sessionId":"s1"}',
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "hello"),
      ""
    ].join("\n")

    const extract = extractFromText(text, FILE)

    expect(extract.counters).toEqual({
      // mode, file-history-snapshot, later-release, no-session user, the good user record.
      parsedLines: 5,
      // Truncated line, bare string, array, and the object with no `type`.
      droppedLines: 4,
      droppedNoSession: 1,
      // `mode` and `file-history-snapshot`.
      skippedTypeLines: 2,
      unknownTypeLines: 1
    })
    expect(extract.sessionId).toBe("s1")
    expect(extract.turnCount).toBe(1)
  })

  it("drops an envelope-less file-history record instead of counting it malformed", () => {
    const snapshot =
      '{"type":"file-history-snapshot","messageId":"m1","snapshot":{"trackedFileBackups":{}},"isSnapshotUpdate":false}'
    const delta =
      '{"type":"file-history-delta","messageId":"m2","snapshotMessageId":"m1","trackingPath":"a.ts","backup":{},"timestamp":"2026-08-01T10:00:00.000Z"}'
    const extract = extractFromText([snapshot, delta].join("\n"), FILE)

    expect(extract.counters.skippedTypeLines).toBe(2)
    expect(extract.counters.droppedLines).toBe(0)
    expect(extract.counters.droppedNoSession).toBe(0)
    // Skipped before any field access, so the delta's own timestamp never reaches the range.
    expect(extract.startedAt).toBeNull()
  })

  it("parses a file of only bare mode records without a session id or a turn", () => {
    const text = [
      '{"type":"mode","mode":"plan","sessionId":"s1"}',
      '{"type":"permission-mode","permissionMode":"default","sessionId":"s1"}',
      '{"type":"last-prompt","lastPrompt":"x","leafUuid":"u1","sessionId":"s1"}'
    ].join("\n")
    const extract = extractFromText(text, FILE)
    // The allowlist runs before any field access, so a skipped type donates nothing — not even the
    // `sessionId` it happens to carry. Nothing is lost: discovery reads the session id off the
    // path, so the row's identity never depends on a record type this parser ignores.
    expect(extract.sessionId).toBeNull()
    expect(extract.turnCount).toBe(0)
    expect(extract.counters.skippedTypeLines).toBe(3)
    expect(extract.counters.droppedNoSession).toBe(0)
  })

  it("counts an empty file as nothing at all", () => {
    const extract = extractFromText("", FILE)
    expect(extract.counters.parsedLines).toBe(0)
    expect(extract.counters.droppedLines).toBe(0)
    expect(extract.prompts).toEqual([])
    expect(extract.sessionId).toBeNull()
  })
})

describe("extractFromText prompt attribution", () => {
  it("takes prompt rows from user records only, never from assistant records", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "first"),
      // An assistant record carrying a promptId is still not a prompt: promptId is a user-record
      // field, and treating this as one would invent a prompt nobody typed.
      enveloped({
        type: "assistant",
        uuid: "u2",
        promptId: "p-ghost",
        timestamp: "2026-08-01T10:00:02.000Z",
        message: { role: "assistant", id: "m", model: "claude-opus-5", content: [] }
      }),
      userLine("u3", "p2", "2026-08-01T10:00:03.000Z", "second")
    ].join("\n")

    const extract = extractFromText(text, FILE)

    expect(extract.prompts.map((row) => row.promptId)).toEqual(["p1", "p2"])
    expect(extract.promptCount).toBe(2)
  })

  it("counts a repeated promptId once and keeps the first record's identity", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "first"),
      userLine("u2", "p1", "2026-08-01T10:00:02.000Z", "same prompt, later record"),
      userLine("u3", "p2", "2026-08-01T10:00:03.000Z", "second"),
      userLine("u4", "p1", "2026-08-01T10:00:04.000Z", "same prompt again")
    ].join("\n")

    const extract = extractFromText(text, FILE)

    expect(extract.promptCount).toBe(2)
    expect(extract.prompts).toHaveLength(2)
    const [first] = extract.prompts
    expect(first?.promptId).toBe("p1")
    expect(first?.turnUuid).toBe("u1")
    expect(first?.at).toBe("2026-08-01T10:00:01.000Z")
    expect(first?.textHead).toBe("first")
  })

  it("numbers ordinals 0-based by first appearance, not by timestamp", () => {
    const text = [
      // A resumed session can carry an out-of-order timestamp; the ordinal is a file position.
      userLine("u1", "p1", "2026-08-01T10:00:09.000Z", "typed first"),
      userLine("u2", "p2", "2026-08-01T10:00:02.000Z", "typed second"),
      userLine("u3", "p3", "2026-08-01T10:00:05.000Z", "typed third")
    ].join("\n")

    const extract = extractFromText(text, FILE)

    expect(extract.prompts.map((row) => [row.promptId, row.ordinal])).toEqual([
      ["p1", 0],
      ["p2", 1],
      ["p3", 2]
    ])
  })

  it("skips a user record with no promptId while still counting its turn", () => {
    const text = [
      enveloped({
        type: "user",
        uuid: "u1",
        timestamp: "2026-08-01T10:00:01.000Z",
        message: { role: "user", content: "no prompt id on this one" }
      }),
      userLine("u2", "p1", "2026-08-01T10:00:02.000Z", "with a prompt id")
    ].join("\n")

    const extract = extractFromText(text, FILE)

    expect(extract.prompts.map((row) => row.promptId)).toEqual(["p1"])
    expect(extract.turnCount).toBe(2)
  })

  it("fills a text head from the first record that carries text", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", [
        { type: "tool_result", tool_use_id: "t1", content: "output" }
      ]),
      userLine("u2", "p1", "2026-08-01T10:00:02.000Z", [{ type: "text", text: "the real text" }])
    ].join("\n")

    const extract = extractFromText(text, FILE)
    const [row] = extract.prompts
    expect(row?.textHead).toBe("the real text")
    // Identity still belongs to the first record for this prompt.
    expect(row?.turnUuid).toBe("u1")
    expect(row?.at).toBe("2026-08-01T10:00:01.000Z")
  })

  it("caps a text head at the index limit", () => {
    const long = "x".repeat(TEXT_HEAD_LIMIT + 250)
    const extract = extractFromText(userLine("u1", "p1", "2026-08-01T10:00:01.000Z", long), FILE)
    expect(extract.prompts[0]?.textHead).toHaveLength(TEXT_HEAD_LIMIT)
  })

  it("carries the agentId of a sidecar's prompts and null for a main session's", () => {
    const sidecar = enveloped({
      type: "user",
      uuid: "s1",
      promptId: "sp1",
      agentId: "agent-7",
      timestamp: "2026-08-01T10:00:01.000Z",
      message: { role: "user", content: "sidecar brief" }
    })
    expect(extractFromText(sidecar, FILE).prompts[0]?.agentId).toBe("agent-7")
    expect(
      extractFromText(userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "main"), FILE).prompts[0]
        ?.agentId
    ).toBeNull()
  })
})

describe("extractFromText first_prompt", () => {
  it("skips a tool_result user record and takes the first record carrying text", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", [
        { type: "tool_result", tool_use_id: "t1", content: "a tool's output, not a prompt" }
      ]),
      userLine("u2", "p2", "2026-08-01T10:00:02.000Z", "What the user actually asked."),
      userLine("u3", "p3", "2026-08-01T10:00:03.000Z", "A later question.")
    ].join("\n")

    expect(extractFromText(text, FILE).firstPrompt).toBe("What the user actually asked.")
  })

  it("takes a text-block prompt, the shape most real sessions open with", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", [
        { type: "tool_result", tool_use_id: "t1", content: "output" }
      ]),
      userLine("u2", "p2", "2026-08-01T10:00:02.000Z", [{ type: "text", text: "Block-shaped." }])
    ].join("\n")

    expect(extractFromText(text, FILE).firstPrompt).toBe("Block-shaped.")
  })

  it("stays empty for a session of only tool results", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", [
        { type: "tool_result", tool_use_id: "t1", content: "output" }
      ]),
      userLine("u2", "p2", "2026-08-01T10:00:02.000Z", [
        { type: "tool_result", tool_use_id: "t2", content: "more output" }
      ])
    ].join("\n")

    expect(extractFromText(text, FILE).firstPrompt).toBe("")
  })

  it("caps at the index limit", () => {
    const long = "y".repeat(FIRST_PROMPT_LIMIT + 400)
    const extract = extractFromText(userLine("u1", "p1", "2026-08-01T10:00:01.000Z", long), FILE)
    expect(extract.firstPrompt).toHaveLength(FIRST_PROMPT_LIMIT)
  })

  it("does not take an assistant record's text", () => {
    const text = [
      assistantLine("u1", "2026-08-01T10:00:01.000Z", "claude-opus-5"),
      userLine("u2", "p1", "2026-08-01T10:00:02.000Z", "the user's words")
    ].join("\n")
    expect(extractFromText(text, FILE).firstPrompt).toBe("the user's words")
  })
})

describe("extractFromText session fields", () => {
  it("takes identity from the first enveloped record and not from a later one", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "first"),
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        uuid: "u2",
        promptId: "p2",
        timestamp: "2026-08-01T10:00:02.000Z",
        cwd: "/tmp/somewhere-else",
        gitBranch: "feature/other",
        entrypoint: "sdk-py",
        version: "9.9.9",
        message: { role: "user", content: "second" }
      })
    ].join("\n")

    const extract = extractFromText(text, FILE)
    expect(extract.cwd).toBe("/tmp/x")
    expect(extract.gitBranch).toBe("main")
    expect(extract.entrypoint).toBe("cli")
    expect(extract.version).toBe("2.1.219")
  })

  it("takes the most frequent assistant model and excludes the synthetic placeholder", () => {
    const text = [
      assistantLine("u1", "2026-08-01T10:00:01.000Z", "<synthetic>"),
      assistantLine("u2", "2026-08-01T10:00:02.000Z", "<synthetic>"),
      assistantLine("u3", "2026-08-01T10:00:03.000Z", "<synthetic>"),
      assistantLine("u4", "2026-08-01T10:00:04.000Z", "claude-fable-5"),
      assistantLine("u5", "2026-08-01T10:00:05.000Z", "claude-opus-5"),
      assistantLine("u6", "2026-08-01T10:00:06.000Z", "claude-opus-5")
    ].join("\n")

    expect(extractFromText(text, FILE).model).toBe("claude-opus-5")
  })

  it("has no model when every assistant turn was synthetic", () => {
    const text = assistantLine("u1", "2026-08-01T10:00:01.000Z", "<synthetic>")
    expect(extractFromText(text, FILE).model).toBeNull()
  })

  it("breaks a model tie toward the one seen first", () => {
    const text = [
      assistantLine("u1", "2026-08-01T10:00:01.000Z", "claude-fable-5"),
      assistantLine("u2", "2026-08-01T10:00:02.000Z", "claude-opus-5")
    ].join("\n")
    expect(extractFromText(text, FILE).model).toBe("claude-fable-5")
  })

  it("takes started_at and ended_at as the instant range, not the file order", () => {
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:09.000Z", "later instant, earlier line"),
      userLine("u2", "p2", "2026-08-01T10:00:02.000Z", "earlier instant, later line"),
      userLine("u3", "p3", "2026-08-01T10:00:20.000Z", "the latest")
    ].join("\n")

    const extract = extractFromText(text, FILE)
    expect(extract.startedAt).toBe("2026-08-01T10:00:02.000Z")
    expect(extract.endedAt).toBe("2026-08-01T10:00:20.000Z")
  })

  it("orders a mixed-offset range by instant, not by string", () => {
    // Lexicographically "…14:00:00+09:00" sorts after "…10:00:01Z" while being 5 h earlier. The
    // traces.started_at index is over TEXT, so canonicalizing at extraction is what keeps range
    // queries correct.
    const text = [
      userLine("u1", "p1", "2026-08-01T10:00:01Z", "z form"),
      userLine("u2", "p2", "2026-08-01T14:00:00+09:00", "offset form")
    ].join("\n")

    const extract = extractFromText(text, FILE)
    expect(extract.startedAt).toBe("2026-08-01T05:00:00.000Z")
    expect(extract.endedAt).toBe("2026-08-01T10:00:01.000Z")
    expect(extract.prompts[1]?.at).toBe("2026-08-01T05:00:00.000Z")
  })

  it("ignores an unparseable timestamp instead of poisoning the range", () => {
    const text = [
      userLine("u1", "p1", "not a timestamp", "bad"),
      userLine("u2", "p2", "2026-08-01T10:00:02.000Z", "good")
    ].join("\n")

    const extract = extractFromText(text, FILE)
    expect(extract.startedAt).toBe("2026-08-01T10:00:02.000Z")
    expect(extract.endedAt).toBe("2026-08-01T10:00:02.000Z")
    expect(extract.prompts[0]?.at).toBe("")
  })

  it("takes the last ai-title, because the title is re-emitted as it is refined", () => {
    const text = [
      '{"type":"ai-title","aiTitle":"Draft title","sessionId":"s1"}',
      userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "hello"),
      '{"type":"ai-title","aiTitle":"Refined title","sessionId":"s1"}'
    ].join("\n")

    expect(extractFromText(text, FILE).aiTitle).toBe("Refined title")
  })

  it("has no title when no ai-title record appeared", () => {
    const extract = extractFromText(userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "x"), FILE)
    expect(extract.aiTitle).toBeNull()
  })

  it("counts a turn per enveloped record and none for a session-only record", () => {
    const text = [
      // pr-link carries a sessionId but no uuid: a session fact, not a turn.
      '{"type":"pr-link","sessionId":"s1","prNumber":7,"prUrl":"https://example.invalid/pr/7","prRepository":"e/f","timestamp":"2026-08-01T10:00:01.000Z"}',
      '{"type":"agent-name","agentName":"a","sessionId":"s1"}',
      userLine("u1", "p1", "2026-08-01T10:00:02.000Z", "hello"),
      assistantLine("u2", "2026-08-01T10:00:03.000Z", "claude-opus-5"),
      enveloped({
        type: "system",
        uuid: "u3",
        timestamp: "2026-08-01T10:00:04.000Z",
        level: "info"
      }),
      enveloped({ type: "attachment", uuid: "u4", timestamp: "2026-08-01T10:00:05.000Z" })
    ].join("\n")

    expect(extractFromText(text, FILE).turnCount).toBe(4)
  })

  it("still reaches a pr-link's session id and instant without counting a turn", () => {
    const extract = extractFromText(
      '{"type":"pr-link","sessionId":"s1","prNumber":7,"prUrl":"https://example.invalid/pr/7","prRepository":"e/f","timestamp":"2026-08-01T10:00:01.000Z"}',
      FILE
    )
    expect(extract.sessionId).toBe("s1")
    expect(extract.startedAt).toBe("2026-08-01T10:00:01.000Z")
    expect(extract.turnCount).toBe(0)
  })

  it("carries the file's path and slug through unchanged", () => {
    const extract = extractFromText(userLine("u1", "p1", "2026-08-01T10:00:01.000Z", "x"), FILE)
    expect(extract.filePath).toBe(FILE.filePath)
    expect(extract.slug).toBe(FILE.slug)
  })

  it("collects distinct agentIds in first-appearance order", () => {
    const text = [
      enveloped({
        type: "user",
        uuid: "u1",
        promptId: "p1",
        agentId: "agent-b",
        timestamp: "2026-08-01T10:00:01.000Z",
        message: { role: "user", content: "x" }
      }),
      enveloped({
        type: "assistant",
        uuid: "u2",
        agentId: "agent-b",
        timestamp: "2026-08-01T10:00:02.000Z",
        message: { role: "assistant", id: "m", model: "claude-opus-5", content: [] }
      }),
      enveloped({
        type: "user",
        uuid: "u3",
        promptId: "p2",
        agentId: "agent-a",
        timestamp: "2026-08-01T10:00:03.000Z",
        message: { role: "user", content: "y" }
      })
    ].join("\n")

    expect(extractFromText(text, FILE).agentIds).toEqual(["agent-b", "agent-a"])
  })
})

describe("agentCountFor", () => {
  const base = extractFromText(
    JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u1",
      promptId: "p1",
      agentId: "agent-a",
      timestamp: "2026-08-01T10:00:01.000Z",
      message: { role: "user", content: "x" }
    }),
    FILE
  )

  it("unions record-borne agents with sidecar filenames", () => {
    expect(agentCountFor(base, ["agent-b"])).toBe(2)
  })

  it("counts an agent named by both planes once", () => {
    expect(agentCountFor(base, ["agent-a"])).toBe(1)
  })

  it("counts a sidecar whose records have not landed yet", () => {
    const empty = extractFromText("", FILE)
    expect(agentCountFor(empty, ["agent-a", "agent-b"])).toBe(2)
  })

  it("is zero for a session with no agents at all", () => {
    expect(agentCountFor(extractFromText("", FILE), [])).toBe(0)
  })
})
