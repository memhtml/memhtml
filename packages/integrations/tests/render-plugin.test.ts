import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { hookCommand } from "../src/command-line.js"
import { OPENCODE_PLUGIN_FILE, renderOpenCodePlugin } from "../src/render/plugin.js"
import type { BinaryLocation, HookMode } from "../src/types.js"

const BINARY: BinaryLocation = {
  node: "/opt/nodes/24.9.0/bin/node",
  cli: "/opt/memhtml/0.14.0/dist/memhtml.mjs",
  mcp: "/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs",
  version: "0.14.0"
}

const ROOT = "/home/dev/memory"
const OPTS = { memhtmlRoot: ROOT, traceRoot: "/home/dev/.local/share/opencode" }
const NO_TRACE = { memhtmlRoot: ROOT }

interface PluginHooks {
  readonly "chat.message"?: (input: unknown, output: unknown) => Promise<void>
  readonly "experimental.session.compacting"?: (input: unknown, output: unknown) => Promise<void>
  readonly event?: (input: { readonly event: unknown }) => Promise<void>
}

/** Write the rendered plugin to a temp `.mjs` and import it: the only honest syntax check. */
const load = async (source: string): Promise<PluginHooks> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-plugin-"))
  const file = join(dir, OPENCODE_PLUGIN_FILE)
  await writeFile(file, source, "utf8")
  const module: Record<string, unknown> = await import(file)
  const factory = module.MemhtmlPlugin
  if (typeof factory !== "function") throw new Error("MemhtmlPlugin is not a function")
  return (await (factory as (input: { directory: string }) => Promise<PluginHooks>)({
    directory: "/tmp"
  })) as PluginHooks
}

describe("renderOpenCodePlugin", () => {
  it("renders no plugin at all for hooks none", () => {
    expect(renderOpenCodePlugin(BINARY, false, "none", OPTS)).toBe("")
  })

  it("names its generator in the header so nobody hand-edits it", () => {
    const text = renderOpenCodePlugin(BINARY, false, "all", OPTS)
    expect(text.split("\n")[0]).toContain("memhtml integrations install")
    expect(text.split("\n")[0]).toContain("overwrites")
    expect(text).toContain(`memory store at ${ROOT}`)
    expect(OPENCODE_PLUGIN_FILE).toBe("memhtml.js")
  })

  it("imports node:child_process and NOTHING else", () => {
    /**
     * A plugin that imported memhtml would die the next time the toolchain moved the package, and
     * OpenCode loads plugins at startup, so that failure is a dead session rather than a missing memory.
     */
    const text = renderOpenCodePlugin(BINARY, false, "all", OPTS)
    const specifiers = [...text.matchAll(/^import .* from "([^"]+)"$/gm)].map((match) => match[1])
    expect(specifiers).toEqual(["node:child_process"])
    expect(text).not.toMatch(/from "[^"]*(memhtml|opencode)/)
    expect(text).not.toMatch(/\brequire\(/)
  })

  it("bakes in the recorded argv for each event, with --repo and a 1500 ms bound", () => {
    const text = renderOpenCodePlugin(BINARY, false, "all", OPTS)
    expect(text).toContain("const TIMEOUT_MS = 1500")
    expect(text).toContain(`const COMMAND = ${JSON.stringify(BINARY.node)}`)
    for (const [name, event] of [
      ["PROMPT_ARGS", "user-prompt-submit"],
      ["SESSION_ARGS", "session-start"],
      ["IDLE_ARGS", "session-end"]
    ] as const) {
      const args = [...hookCommand(BINARY, false, event, "opencode", OPTS).args]
      expect(text).toContain(`const ${name} = ${JSON.stringify(args)}`)
      expect(args).toContain("--repo")
      expect(args).toContain(event)
    }
    expect(text).toContain(`"--repo","${ROOT}"`)
  })

  it("is valid JavaScript whose factory returns the three hooks", async () => {
    const hooks = await load(renderOpenCodePlugin(BINARY, false, "all", OPTS))
    expect(Object.keys(hooks)).toEqual(["chat.message", "experimental.session.compacting", "event"])
    expect(typeof hooks["chat.message"]).toBe("function")
  })

  it("drops the per-message recall for hooks session and keeps the rest", async () => {
    const hooks = await load(renderOpenCodePlugin(BINARY, false, "session", OPTS))
    expect(Object.keys(hooks)).toEqual(["experimental.session.compacting", "event"])
  })

  it("drops the idle indexer when no transcript root is known", async () => {
    for (const mode of ["all", "session"] as ReadonlyArray<HookMode>) {
      const text = renderOpenCodePlugin(BINARY, false, mode, NO_TRACE)
      expect(text).not.toContain("IDLE_ARGS")
      expect(text).not.toContain("session.idle")
      expect(Object.keys(await load(text))).not.toContain("event")
    }
  })

  it("fails open: a binary that does not exist pushes nothing and throws nothing", async () => {
    const missing: BinaryLocation = { ...BINARY, node: "/nonexistent/node/bin/node" }
    const hooks = await load(renderOpenCodePlugin(missing, false, "all", OPTS))
    const parts: Array<unknown> = [{ type: "text", text: "what did we decide about retries" }]
    const context: Array<unknown> = []
    await hooks["chat.message"]?.({}, { parts })
    await hooks["experimental.session.compacting"]?.({}, { context })
    await hooks.event?.({ event: { type: "session.idle" } })
    expect(parts).toHaveLength(1)
    expect(context).toHaveLength(0)
  })

  it("ignores an event that is not session.idle", async () => {
    const hooks = await load(renderOpenCodePlugin(BINARY, false, "all", OPTS))
    await expect(hooks.event?.({ event: { type: "message.updated" } })).resolves.toBeUndefined()
    await expect(hooks.event?.({ event: undefined })).resolves.toBeUndefined()
  })
})
