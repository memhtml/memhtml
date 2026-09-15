import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { sha256 } from "../src/fs.js"
import {
  compareEntries,
  inspectReceiptFile,
  readReceipt,
  receiptPath,
  removeReceipt,
  writeReceipt
} from "../src/receipt.js"
import type { Receipt, ReceiptEntry } from "../src/types.js"

/**
 * The receipt is the only thing that licenses a delete, so its tests are about what happens when it cannot
 * be trusted.
 *
 * `readReceipt` collapsing absent and invalid into `null` is convenient for callers and dangerous for
 * `doctor`, which must not report "not installed" for a receipt that is corrupt — an operator who then runs
 * install would write over a real one and lose the entry list an uninstall needs. That is why
 * `inspectReceiptFile` exists and why every invalid case here asserts a `problem` sentence naming the field.
 */

const roots: Array<string> = []

const tempRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memhtml-int-receipt-")))
  roots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const entry = (path: string, sha: string): ReceiptEntry => ({
  path,
  role: "mcp-entry",
  kind: "fragment",
  sha256: sha
})

/** A receipt rooted where the test keeps it: a receipt is only valid at its own root's receipt path. */
const receipt = (overrides: Partial<Receipt> = {}, root = "/home/ada"): Receipt => ({
  package: "memhtml",
  version: "0.14.0",
  host: "claude",
  scope: "user",
  root,
  memhtmlRoot: join(root, "memory"),
  binary: {
    node: "/usr/bin/node",
    cli: join(root, ".local", "bin", "memhtml"),
    mcp: join(root, ".local", "bin", "memhtml-mcp"),
    version: "0.14.0"
  },
  bareCommand: false,
  hooks: "all",
  installedAt: "2026-09-13T00:00:00.000Z",
  entries: [entry(join(root, ".claude.json"), sha256('{"command":"memhtml-mcp"}'))],
  ...overrides
})

describe("receiptPath", () => {
  it("hides the user-scope receipt under .config and keeps the project one at the repo root", () => {
    expect(receiptPath("user", "/home/ada", "claude")).toBe(
      "/home/ada/.config/memhtml/integrations/claude.json"
    )
    expect(receiptPath("project", "/srv/repo", "codex")).toBe(
      "/srv/repo/.memhtml-integrations/codex.json"
    )
  })

  it("gives every host its own file, so one host's uninstall cannot touch another's", () => {
    const paths = (["claude", "codex", "cursor", "opencode"] as const).map((host) =>
      receiptPath("user", "/home/ada", host)
    )
    expect(new Set(paths).size).toBe(4)
  })
})

describe("write / read / remove", () => {
  it("round-trips through disk, creating the directory, pretty-printed with a trailing newline", async () => {
    const root = await tempRoot()
    const path = receiptPath("user", root, "claude")
    const written = receipt({}, root)
    await writeReceipt(path, written)
    expect(await readReceipt(path)).toEqual(written)
    const text = await readFile(path, "utf8")
    expect(text.endsWith("\n")).toBe(true)
    expect(text).toContain('\n  "host": "claude",')
    expect(await readdir(join(root, ".config", "memhtml", "integrations"))).toEqual(["claude.json"])
  })

  it("overwrites an existing receipt rather than appending to it", async () => {
    const root = await tempRoot()
    const path = receiptPath("project", root, "cursor")
    await writeReceipt(path, receipt({ host: "cursor", scope: "project", hooks: "session" }, root))
    await writeReceipt(path, receipt({ host: "cursor", scope: "project", hooks: "none" }, root))
    const back = await readReceipt(path)
    expect(back?.hooks).toBe("none")
  })

  it("removes the file, and removing an absent one is success", async () => {
    const root = await tempRoot()
    const path = receiptPath("user", root, "codex")
    await writeReceipt(path, receipt({ host: "codex" }, root))
    await removeReceipt(path)
    expect(await readReceipt(path)).toBeNull()
    await removeReceipt(path)
    expect((await inspectReceiptFile(path)).state).toBe("absent")
  })
})

describe("inspectReceiptFile", () => {
  it("reports absent for a file that is not there", async () => {
    const root = await tempRoot()
    expect(await inspectReceiptFile(join(root, "nope.json"))).toEqual({
      state: "absent",
      receipt: null
    })
  })

  it("reports valid and hands back the receipt", async () => {
    const root = await tempRoot()
    const path = receiptPath("user", root, "claude")
    await writeReceipt(path, receipt({}, root))
    const inspected = await inspectReceiptFile(path)
    expect(inspected.state).toBe("valid")
    expect(inspected.receipt).toEqual(receipt({}, root))
    expect(inspected.problem).toBeUndefined()
  })

  it("reports invalid with the parse error for a truncated file", async () => {
    const root = await tempRoot()
    const path = join(root, "claude.json")
    await writeFile(path, '{ "package": "memhtml", "version":', "utf8")
    const inspected = await inspectReceiptFile(path)
    expect(inspected.state).toBe("invalid")
    expect(inspected.receipt).toBeNull()
    expect(inspected.problem).toMatch(/not valid JSON/)
    expect(await readReceipt(path)).toBeNull()
  })

  it("names the field that is wrong for a well-formed JSON file of the wrong shape", async () => {
    const root = await tempRoot()
    const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
      [[], /not a JSON object/],
      [{ ...receipt({}, root), package: "openwiki" }, /`package`/],
      [{ ...receipt({}, root), host: "vscode" }, /`host`/],
      [{ ...receipt({}, root), scope: "global" }, /`scope`/],
      [{ ...receipt({}, root), hooks: "some" }, /`hooks`/],
      [{ ...receipt({}, root), bareCommand: "no" }, /`bareCommand`/],
      [{ ...receipt({}, root), binary: { node: "/usr/bin/node" } }, /`binary\.cli`/],
      [{ ...receipt({}, root), entries: {} }, /`entries` is not an array/],
      [
        { ...receipt({}, root), entries: [{ path: join(root, "x"), role: "hooks", kind: "file" }] },
        /sha256/
      ],
      [
        {
          ...receipt({}, root),
          entries: [{ path: join(root, "x"), role: "banner", kind: "file", sha256: "a" }]
        },
        /role/
      ]
    ]
    for (const [value, problem] of cases) {
      const path = join(root, `${Math.random().toString(36).slice(2)}.json`)
      await writeFile(path, JSON.stringify(value), "utf8")
      const inspected = await inspectReceiptFile(path)
      expect(inspected.state).toBe("invalid")
      expect(inspected.problem).toMatch(problem)
    }
  })

  it("accepts a receipt with no entries, which is what a dry-run-then-real install can produce", async () => {
    const root = await tempRoot()
    const path = receiptPath("user", root, "claude")
    await writeReceipt(path, receipt({ entries: [] }, root))
    expect((await inspectReceiptFile(path)).state).toBe("valid")
  })
})

describe("compareEntries", () => {
  const entries = [
    entry("/home/ada/.claude.json", sha256("mcp")),
    entry("/home/ada/.claude/settings.json", sha256("hooks"))
  ]

  it("is installed when every entry still hashes to its claim", async () => {
    const result = await compareEntries(entries, async (item) =>
      item.path.endsWith(".claude.json") ? sha256("mcp") : sha256("hooks")
    )
    expect(result.state).toBe("installed")
    expect(result.drift).toEqual([])
  })

  it("is modified, naming the entry and the hash actually found, when one differs", async () => {
    const result = await compareEntries(entries, async (item) =>
      item.path.endsWith(".claude.json") ? sha256("edited by hand") : sha256("hooks")
    )
    expect(result.state).toBe("modified")
    expect(result.drift).toEqual([{ entry: entries[0], actual: sha256("edited by hand") }])
  })

  it("counts a vanished file or fragment as drift, with a null actual", async () => {
    const result = await compareEntries(entries, async (item) =>
      item.path.endsWith(".claude.json") ? null : sha256("hooks")
    )
    expect(result.state).toBe("modified")
    expect(result.drift).toEqual([{ entry: entries[0], actual: null }])
  })

  it("reports every drifted entry, not just the first", async () => {
    const result = await compareEntries(entries, async () => null)
    expect(result.drift.map((item) => item.entry.path)).toEqual(entries.map((item) => item.path))
  })

  it("is installed for an empty entry list, since not-installed is the caller's question", async () => {
    const result = await compareEntries([], async () => null)
    expect(result.state).toBe("installed")
  })
})

describe("a receipt is bound to where it sits and what it may claim", () => {
  const valid = (root: string): Receipt => ({
    package: "memhtml",
    version: "9.9.9",
    host: "claude",
    scope: "user",
    root,
    memhtmlRoot: join(root, "memory"),
    binary: {
      node: "/usr/bin/node",
      cli: "/opt/memhtml/cli.mjs",
      mcp: "/opt/memhtml/mcp.mjs",
      version: "9.9.9"
    },
    bareCommand: false,
    hooks: "all",
    installedAt: "2026-09-13T00:00:00.000Z",
    entries: [entry(join(root, ".claude", "CLAUDE.md"), sha256("x"))]
  })

  it("is invalid at another host's path", async () => {
    const root = await tempRoot()
    const path = receiptPath("user", root, "cursor")
    await writeReceipt(path, valid(root))
    const inspected = await inspectReceiptFile(path)
    expect(inspected.state).toBe("invalid")
    expect(inspected.problem).toContain("belongs at")
    expect(inspected.problem).toContain(receiptPath("user", root, "claude"))
  })

  it("is invalid when an entry reaches outside its root", async () => {
    const root = await tempRoot()
    const path = receiptPath("user", root, "claude")
    for (const outside of [
      "/etc/passwd",
      join(root, "..", "elsewhere"),
      "relative/file",
      `${root}/a/../../b`
    ]) {
      await writeReceipt(path, { ...valid(root), entries: [entry(outside, sha256("x"))] })
      const inspected = await inspectReceiptFile(path)
      expect(inspected.state, outside).toBe("invalid")
      expect(inspected.problem, outside).toContain("under `root`")
    }
  })

  it("is invalid when root itself is relative", async () => {
    const root = await tempRoot()
    const path = receiptPath("user", root, "claude")
    await writeReceipt(path, { ...valid(root), root: "home/someone" })
    expect((await inspectReceiptFile(path)).problem).toContain("`root`")
  })
})
