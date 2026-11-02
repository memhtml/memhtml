import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider"
import { archiveSlotFor } from "@memhtml/contracts"
import { generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  curatorModel,
  DEFAULT_BUDGET,
  DEFAULT_CURATOR_MODEL_ID,
  FAKE_MODEL_ID,
  fakeDedupScript,
  parseModelSpec,
  runCurator,
  withOutputCeiling
} from "../src/index.js"
import { emptyBriefing, fakeTools } from "./fakes.js"

/**
 * The model factory and the fake it returns. No provider is called: `bedrock:` and `proxy:` are
 * constructed lazily and only their construction is asserted, with an environment that cannot reach
 * a network. Mutations, each run once with the named case red: `parseModelSpec` accept any prefix ->
 * "an unknown spec fails with a typed error" (the effect succeeds); `withOutputCeiling` return the
 * model unwrapped -> "the output ceiling reaches every call the wrapped model makes" (the recorded
 * call carries no `maxOutputTokens`).
 */

const textAnswer = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined }
  },
  warnings: []
})

const failureOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (result._tag !== "Failure") throw new Error("expected a failure")
  return result.failure
}

describe("parseModelSpec", () => {
  it("reads the three spellings", async () => {
    expect(await Effect.runPromise(parseModelSpec("fake"))).toEqual({ kind: "fake" })
    expect(await Effect.runPromise(parseModelSpec(" fake "))).toEqual({ kind: "fake" })
    expect(
      await Effect.runPromise(parseModelSpec("bedrock:global.anthropic.claude-opus-5"))
    ).toEqual({ kind: "bedrock", modelId: "global.anthropic.claude-opus-5" })
    expect(await Effect.runPromise(parseModelSpec("proxy:opus"))).toEqual({
      kind: "proxy",
      model: "opus"
    })
  })

  it("an unknown spec fails with a typed error", async () => {
    for (const spec of ["gpt", "bedrock", "proxy:", "openai:x", ""]) {
      const failure = await failureOf(parseModelSpec(spec))
      expect(failure._tag, spec).toBe("CuratorModelSpecInvalid")
      expect(failure.spec, spec).toBe(spec)
    }
  })
})

describe("withOutputCeiling", () => {
  it("the output ceiling reaches every call the wrapped model makes", async () => {
    const recording = new MockLanguageModelV4({ doGenerate: async () => textAnswer("ok") })
    await generateText({ model: withOutputCeiling(recording), prompt: "one" })
    await generateText({ model: withOutputCeiling(recording, 1234), prompt: "two" })
    expect(recording.doGenerateCalls.map((call) => call.maxOutputTokens)).toEqual([
      DEFAULT_BUDGET.maxOutputTokensPerCall,
      1234
    ])
  })

  it("a caller's own ceiling wins over the default", async () => {
    const recording = new MockLanguageModelV4({ doGenerate: async () => textAnswer("ok") })
    await generateText({
      model: withOutputCeiling(recording),
      prompt: "one",
      maxOutputTokens: 77
    })
    expect(recording.doGenerateCalls[0]?.maxOutputTokens).toBe(77)
  })
})

describe("curatorModel", () => {
  it("fake returns a model named fake, wrapped with the output ceiling", async () => {
    const model = await Effect.runPromise(curatorModel("fake"))
    expect(typeof model).toBe("object")
    expect((model as { modelId: string }).modelId).toBe(FAKE_MODEL_ID)
  })

  it("proxy without MEMHTML_LLM_BASE_URL is a typed refusal naming the variable", async () => {
    const failure = await failureOf(curatorModel(`proxy:${DEFAULT_CURATOR_MODEL_ID}`, { env: {} }))
    expect(failure._tag).toBe("CuratorModelSpecInvalid")
    expect(failure.reason).toContain("MEMHTML_LLM_BASE_URL")
  })

  it("proxy with a malformed base URL is refused rather than routed somewhere else", async () => {
    const failure = await failureOf(
      curatorModel("proxy:x", { env: { MEMHTML_LLM_BASE_URL: "localhost:4000" } })
    )
    expect(failure._tag).toBe("CuratorModelSpecInvalid")
    expect(failure.reason).toContain("http(s) origin")
  })

  it("proxy and bedrock construct lazily with no call", async () => {
    const proxied = await Effect.runPromise(
      curatorModel("proxy:x", { env: { MEMHTML_LLM_BASE_URL: "http://127.0.0.1:1" } })
    )
    expect((proxied as { modelId: string }).modelId).toBe("bedrock/x")
    const direct = await Effect.runPromise(
      curatorModel("bedrock:some.model", { env: { AWS_REGION: "us-west-2" } })
    )
    expect((direct as { modelId: string }).modelId).toBe("some.model")
  })
})

describe("the fake model through the loop", () => {
  it("calls status, exec, finish; the exec script archives and splices the supersedes link itself", async () => {
    const briefing = {
      ...emptyBriefing,
      duplicates: [
        {
          key: "the capital of india is",
          value: "new delhi",
          records: [
            { path: "areas/inbox/capital-b.html", claim: "The capital of India is NEW DELHI" },
            { path: "areas/inbox/capital-a.html", claim: "The capital of India is New Delhi." }
          ]
        }
      ],
      duplicatesTotal: 1,
      // A contradiction beside it, which the fake must leave alone.
      contradictions: [
        {
          key: "the capital of france is",
          records: [
            {
              path: "areas/inbox/paris.html",
              claim: "The capital of France is Paris.",
              value: "paris"
            },
            {
              path: "areas/inbox/lyon.html",
              claim: "The capital of France is Lyon.",
              value: "lyon"
            }
          ]
        }
      ],
      contradictionsTotal: 1
    }
    // The fake tool set's exec answers what the real sandbox would print for that script.
    const tools = fakeTools({
      exec: {
        stdout: `${JSON.stringify({
          groups: 1,
          archived: [
            {
              kept: "areas/inbox/capital-a.html",
              from: "areas/inbox/capital-b.html",
              to: "archive/2026/areas/inbox/capital-b.html"
            }
          ]
        })}\n`,
        // What the real harvester yields for that script: the archive plus the link the script
        // spliced into the kept file's head.
        appended: 2,
        ops: [
          { kind: "link", path: "areas/inbox/capital-a.html" },
          {
            kind: "archive",
            path: "areas/inbox/capital-b.html",
            to: "archive/2026/areas/inbox/capital-b.html"
          }
        ]
      }
    })
    const model = await Effect.runPromise(curatorModel("fake"))
    const result = await Effect.runPromise(runCurator({ tools, model, briefing, charter: "c" }))
    expect(result.toolCalls).toEqual(["status", "exec", "finish"])
    expect(result.toolCalls).not.toContain("propose")
    expect(result.stoppedBy).toBe("finish")
    expect(result.report.split("\n")[0]).toBe(
      "Archived 1 duplicate record(s) behind their canonical twins."
    )
    expect(result.opsAppended).toBe(2)
    const script = tools.calls.find((call) => call.name === "exec")?.input
    expect(script).toContain('"areas/inbox/capital-a.html","areas/inbox/capital-b.html"')
    expect(script).toContain("memhtml-supersedes")
    // The contradiction's paths are nowhere in the script: the fake reads `duplicates` only.
    // (Mutation: `briefing?.duplicates` -> `[...duplicates, ...contradictions]` fails here.)
    expect(script).not.toContain("paris.html")
    expect(tools.proposed).toEqual([])
  })

  it("reports the dangling links the exec sweep dropped beside the archives", async () => {
    const tools = fakeTools({
      exec: {
        stdout: `${JSON.stringify({
          groups: 0,
          archived: [],
          unlinked: [
            { path: "areas/inbox/a.html", rel: "relates_to", href: "/areas/inbox/gone.html" }
          ]
        })}\n`,
        appended: 1,
        ops: [{ kind: "unlink", path: "areas/inbox/a.html" }]
      }
    })
    const model = await Effect.runPromise(curatorModel("fake"))
    const result = await Effect.runPromise(
      runCurator({ tools, model, briefing: emptyBriefing, charter: "c" })
    )
    expect(result.toolCalls).toEqual(["status", "exec", "finish"])
    expect(result.report.split("\n")[0]).toBe(
      "No duplicates to settle; dropped 1 dangling link(s)."
    )
    expect(result.report).toContain(
      "areas/inbox/a.html: dropped relates_to -> /areas/inbox/gone.html"
    )
  })

  it("finishes after exec when the briefing holds no duplicate group", async () => {
    const tools = fakeTools()
    const model = await Effect.runPromise(curatorModel("fake"))
    const result = await Effect.runPromise(
      runCurator({ tools, model, briefing: emptyBriefing, charter: "c" })
    )
    expect(result.toolCalls).toEqual(["status", "exec", "finish"])
    expect(result.report).toContain("nothing archived")
  })

  it("the dedup script sorts each group, keeps its first path, and links it to each archive", () => {
    const script = fakeDedupScript([{ paths: ["b.html", "a.html"] }], "2026")
    expect(script).toContain('[["a.html","b.html"]]')
    expect(script).toContain('"2026"')
    expect(script).toContain("fs.unlinkSync")
    expect(script).toContain(`'<link rel="memhtml-supersedes" href="/' + to + '">'`)
    expect(script).toContain('keptHtml.replace("</head>", link + "\\n</head>")')
    // The sweep runs after the dedup and over the active buckets only.
    expect(script.indexOf("const unlinked")).toBeGreaterThan(script.indexOf("archived.push"))
    expect(script).toContain('["areas", "projects", "resources"]')
    expect(script).toContain("fs.existsSync(ROOT + href)")
  })

  it("the dedup script archives into the slot archiveSlotFor names, past a held one", async () => {
    // Run with node over a temp tree standing in for the sandbox mount. The kept file's archive
    // slot is free; the other's bare-year slot holds an older record, so its archive takes `.2`.
    const root = await mkdtemp(join(tmpdir(), "memhtml-fake-dedup-"))
    try {
      const page = (claim: string) =>
        `<!doctype html>\n<html><head>\n<title>t</title>\n</head><body><p>${claim}</p></body></html>\n`
      const files: Record<string, string> = {
        "areas/inbox/a.html": page("kept"),
        "areas/inbox/b.html": page("duplicate"),
        "archive/2031/areas/inbox/b.html": page("an older record")
      }
      for (const [path, html] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), html, "utf8")
      }
      const held = new Set(Object.keys(files))
      const expected = archiveSlotFor("areas/inbox/b.html", 2031, (slot) => held.has(slot))
      expect(expected).toBe("archive/2031.2/areas/inbox/b.html")

      const script = fakeDedupScript(
        [{ paths: ["areas/inbox/b.html", "areas/inbox/a.html"] }],
        "2031"
      ).replace('const ROOT = "/mnt/memhtml"', `const ROOT = ${JSON.stringify(root)}`)
      const child = promisify(execFile)(process.execPath, ["--input-type=module", "-e", script])
      const { stdout } = await child
      const printed = JSON.parse(stdout) as { archived: ReadonlyArray<{ to: string }> }
      expect(printed.archived.map((entry) => entry.to)).toEqual([expected])
      expect(await readFile(join(root, expected), "utf8")).toBe(page("duplicate"))
      expect(await readFile(join(root, "archive/2031/areas/inbox/b.html"), "utf8")).toBe(
        page("an older record")
      )
      expect(await readFile(join(root, "areas/inbox/a.html"), "utf8")).toContain(
        `href="/${expected}"`
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
