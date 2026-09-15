import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { locateBinary } from "../src/locate.js"

const roots: Array<string> = []

const tempRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memhtml-int-locate-")))
  roots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("locateBinary", () => {
  it("finds memhtml-mcp beside the entry script", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "memhtml"), "", "utf8")
    await writeFile(join(root, "memhtml-mcp.mjs"), "", "utf8")
    const found = await locateBinary({ entry: join(root, "memhtml"), version: "9.9.9" })
    expect(found.mcp).toBe(join(root, "memhtml-mcp.mjs"))
    expect(found.node).toBe(process.execPath)
  })

  it("takes MEMHTML_MCP_BIN only when it names a file that exists", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "memhtml"), "", "utf8")
    await writeFile(join(root, "elsewhere-mcp"), "", "utf8")
    const found = await locateBinary({
      entry: join(root, "memhtml"),
      version: "9.9.9",
      mcpOverride: join(root, "elsewhere-mcp")
    })
    expect(found.mcp).toBe(join(root, "elsewhere-mcp"))
    await expect(
      locateBinary({
        entry: join(root, "memhtml"),
        version: "9.9.9",
        mcpOverride: join(root, "missing")
      })
    ).rejects.toThrow("MEMHTML_MCP_BIN names")
  })

  it("names pnpm build when no server script sits beside the entry", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "memhtml"), "", "utf8")
    await expect(locateBinary({ entry: join(root, "memhtml"), version: "9.9.9" })).rejects.toThrow(
      "pnpm build"
    )
  })
})
