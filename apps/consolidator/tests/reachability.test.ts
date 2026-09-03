import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Result } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { makeConsolidator, transcriptWithinRoot, turnMessage } from "../src/client.js"
import { type ConsolidatorError, ConsolidatorUnavailable } from "../src/contract.js"
import { CORPUS_SNAPSHOT_TMPDIR_PREFIX } from "../src/mount.js"
import { answerReply, scriptedModel, toolReply } from "./scripted-model.js"

/**
 * The client end to end over a scripted model: what a run does with its batch BEFORE the model sees
 * anything (containment under the trace root, reachability on the host), what it hands the model
 * (a message with no session ids and no paths), and what it does with the answer (decode, ground,
 * verify quotes, watermark from the read receipt). No network, no server, no credentials beyond the
 * gate's placeholder.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const clientSource = () =>
  import("node:fs/promises").then((fs) =>
    fs.readFile(join(packageRoot, "src", "client.ts"), "utf8")
  )
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

let root = ""
let projects = ""
let s1 = ""
let s2 = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "consolidator-reach-"))
  projects = join(root, "projects")
  await mkdir(projects, { recursive: true })
  s1 = join(projects, "s1.jsonl")
  s2 = join(projects, "s2.jsonl")
  await writeFile(
    s1,
    '{"type":"user","text":"drain the VIP before the revert"}\n{"type":"assistant","text":"Draining first; the revert alone leaves connections pinned."}\n'
  )
  await writeFile(s2, '{"type":"user","text":"the vip drain worked; ship it"}\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const BEARER = { AWS_BEARER_TOKEN_BEDROCK: "not-a-real-token" }

const barrenOver = (...ids: string[]) => ({ candidates: [], commitments: [], readSessionIds: ids })

const consolidateWith = (
  replies: Parameters<typeof scriptedModel>[0],
  transcripts: ReadonlyArray<{ sessionId: string; filePath: string }>,
  traceRoot = root
) => {
  const scripted = scriptedModel(replies)
  const consolidator = makeConsolidator({
    env: BEARER,
    traceRoot,
    model: scripted.model,
    instructions: "You are the test agent."
  })
  return {
    scripted,
    result: Effect.runPromise(Effect.result(consolidator.consolidate({ transcripts })))
  }
}

const failureOf = async (
  replies: Parameters<typeof scriptedModel>[0],
  transcripts: ReadonlyArray<{ sessionId: string; filePath: string }>
): Promise<ConsolidatorError> => {
  const { result } = consolidateWith(replies, transcripts)
  const settled = await result
  if (!Result.isFailure(settled)) throw new Error("expected the run to fail")
  return settled.failure
}

describe("transcriptWithinRoot", () => {
  it("accepts a file under the root and returns its relative path", () => {
    expect(
      transcriptWithinRoot({ filePath: "/traces/projects/a.jsonl", traceRoot: "/traces" })
    ).toEqual({
      relativePath: "projects/a.jsonl"
    })
  })

  it("refuses the root itself, an escape, an unrelated absolute path, and a relative path", () => {
    for (const filePath of [
      "/traces",
      "/traces/../etc/passwd",
      "/elsewhere/a.jsonl",
      "projects/a.jsonl"
    ]) {
      const resolved = transcriptWithinRoot({ filePath, traceRoot: "/traces" })
      expect("reason" in resolved, filePath).toBe(true)
    }
  })

  it("refuses a `..` segment that survives normalization", () => {
    const resolved = transcriptWithinRoot({
      filePath: "/traces/projects/../../x.jsonl",
      traceRoot: "/traces"
    })
    expect("reason" in resolved).toBe(true)
  })
})

describe("a transcript that does not resolve is never analyzed", () => {
  it("fails as unavailable when no transcript resolves, without calling the model", async () => {
    const { scripted, result } = consolidateWith(
      [answerReply(barrenOver("ghost"))],
      [
        { sessionId: "ghost", filePath: join(projects, "ghost.jsonl") },
        { sessionId: "outside", filePath: "/etc/hostname" }
      ]
    )
    const settled = await result
    expect(Result.isFailure(settled)).toBe(true)
    if (Result.isFailure(settled)) {
      expect(settled.failure).toBeInstanceOf(ConsolidatorUnavailable)
      expect(settled.failure.reason).toContain("none of the 2 transcript files resolve")
    }
    expect(scripted.calls()).toBe(0)
  })

  it("hands the model only the reachable sessions and watermarks only what it read", async () => {
    const { scripted, result } = consolidateWith(
      [toolReply("list_sessions"), answerReply(barrenOver("s1", "ghost"))],
      [
        { sessionId: "s1", filePath: s1 },
        { sessionId: "ghost", filePath: join(projects, "ghost.jsonl") }
      ]
    )
    const settled = await result
    expect(Result.isSuccess(settled)).toBe(true)
    if (Result.isSuccess(settled)) {
      // `ghost` was named in the receipt and is NOT watermarked: it never resolved.
      expect(settled.success.analyzedSessionIds).toEqual(["s1"])
      expect(settled.success.llmCalls).toBe(2)
    }
    expect(scripted.calls()).toBe(2)
  })

  it("refuses a directory as a transcript", async () => {
    const failure = await failureOf(
      [answerReply(barrenOver("dir"))],
      [{ sessionId: "dir", filePath: projects }]
    )
    expect(failure).toBeInstanceOf(ConsolidatorUnavailable)
  })
})

describe("what the model is shown", () => {
  it("composes a turn message with no session ids, no paths, and no transcript content", () => {
    const message = turnMessage([
      { entry: { sessionId: "s1-secret-id", filePath: s1 }, hostPath: s1 },
      { entry: { sessionId: "s2-secret-id", filePath: s2 }, hostPath: s2 }
    ])
    expect(message).toContain("2 session transcript(s)")
    expect(message).not.toContain("s1-secret-id")
    expect(message).not.toContain(root)
    expect(message).not.toContain("VIP")
    expect(message).toContain("list_sessions")
  })

  it("never puts transcript bytes in a model message: content arrives only as tool results", async () => {
    const code = codeOnly(await clientSource())
    // The one file read in this module is the quote verifier, which reads to CHECK, never to send.
    expect(code.match(/readFile\(/g) ?? []).toHaveLength(1)
    expect(code).toContain("fabricatedQuoteReason")
    expect(code).not.toContain("clientContext")
  })
})

describe("the answer is checked before anything is watermarked", () => {
  it("refuses a cited quote that is not in the transcript, as a contract violation", async () => {
    const failure = await failureOf(
      [
        toolReply("list_sessions"),
        answerReply({
          candidates: [
            {
              kind: "procedural",
              claim: "Drain the VIP before a revert.",
              gist: "Twice the operator drained first.",
              entities: [],
              evidence: [
                { sessionId: "s1", quote: "drain the VIP before the revert" },
                { sessionId: "s1", quote: "this sentence was never said" }
              ]
            }
          ],
          commitments: [],
          readSessionIds: ["s1"]
        })
      ],
      [{ sessionId: "s1", filePath: s1 }]
    )
    expect(failure._tag).toBe("ConsolidatorContractViolation")
    expect(failure.reason).toContain("does not appear in that transcript")
  })

  it("accepts a grounded, verified candidate and returns it with the watermark", async () => {
    const { result } = consolidateWith(
      [
        toolReply("search_transcript", { sessionId: "s1", needle: "VIP" }),
        answerReply({
          candidates: [
            {
              kind: "procedural",
              claim: "Drain the VIP before a revert.",
              gist: "The revert alone leaves connections pinned; the drain is done first every time.",
              entities: [{ type: "concept", name: "VIP" }],
              evidence: [
                { sessionId: "s1", quote: "drain the VIP before the revert" },
                { sessionId: "s1", quote: "the revert alone leaves connections pinned" }
              ]
            }
          ],
          commitments: [],
          readSessionIds: ["s1", "s2"]
        })
      ],
      [
        { sessionId: "s1", filePath: s1 },
        { sessionId: "s2", filePath: s2 }
      ]
    )
    const settled = await result
    expect(Result.isSuccess(settled)).toBe(true)
    if (Result.isSuccess(settled)) {
      expect(settled.success.candidates).toHaveLength(1)
      expect(settled.success.analyzedSessionIds).toEqual(["s1", "s2"])
    }
  })

  it("routes analyzedSessionIds through watermarkableSessionIds, never the raw reachable set", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain("watermarkableSessionIds(decoded.success, readableIds)")
    expect(code).not.toMatch(/analyzedSessionIds:\s*readableIds/)
    expect(code).toContain("underCitedWatermarkWarning(decoded.success, readableIds)")
  })
})

describe("nothing is left behind, and nothing extra is written", () => {
  it("writes nothing into the trace root", async () => {
    const before = (await readdir(projects)).sort()
    await consolidateWith(
      [toolReply("list_sessions"), answerReply(barrenOver("s1"))],
      [{ sessionId: "s1", filePath: s1 }]
    ).result
    expect((await readdir(projects)).sort()).toEqual(before)
  })

  it("sweeps a stale directory under each prefix this app has ever created, and spares a fresh one", async () => {
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    const staleRun = await mkdtemp(join(tmpdir(), "memhtml-consolidator-run-"))
    const staleSnapshot = await mkdtemp(join(tmpdir(), CORPUS_SNAPSHOT_TMPDIR_PREFIX))
    await mkdir(join(staleSnapshot, "tree"), { recursive: true })
    await utimes(staleRun, twoDaysAgo, twoDaysAgo)
    await utimes(staleSnapshot, twoDaysAgo, twoDaysAgo)
    const fresh = await mkdtemp(join(tmpdir(), CORPUS_SNAPSHOT_TMPDIR_PREFIX))
    try {
      await consolidateWith(
        [toolReply("list_sessions"), answerReply(barrenOver("s1"))],
        [{ sessionId: "s1", filePath: s1 }]
      ).result
      expect(existsSync(staleRun)).toBe(false)
      expect(existsSync(staleSnapshot)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      for (const dir of [staleRun, staleSnapshot, fresh])
        await rm(dir, { recursive: true, force: true })
    }
  })
})
