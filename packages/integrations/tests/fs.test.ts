import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import {
  assertNoSymlinkComponents,
  exists,
  expandHome,
  isDirectory,
  readTextOrNull,
  realpathOrSelf,
  restoreText,
  sha256,
  snapshotText,
  writeTextAtomic
} from "../src/fs.js"

/**
 * The disk layer against real directories: no mock filesystem, because every property under test here is
 * a property of the real one. A fake `fs` would report a mode it was told to report and would rename
 * across its own imaginary device, which is exactly the pair of behaviors install depends on.
 *
 * Two assertions carry more than they look like. "No temp sibling survives" is the one that catches an
 * atomic write whose rename failed halfway — the file is correct and a `.tmp` turd sits beside it forever.
 * And restore-from-absent is the rollback case that makes a failed install indistinguishable from one that
 * never ran; a snapshot that only remembers bytes cannot express it.
 */

const roots: Array<string> = []

/**
 * `realpath` on the way out, because `mkdtemp` hands back a path under `$TMPDIR` and that prefix is itself
 * a symlink on some platforms (`/tmp` → `/private/tmp` on macOS). The symlink-refusal tests would then fail
 * on the harness rather than on the subject.
 */
const tempRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memhtml-int-fs-")))
  roots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777

describe("sha256", () => {
  it("is the standard hex digest of the UTF-8 bytes", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  it("separates two texts that differ only in trailing whitespace", () => {
    expect(sha256("a\n")).not.toBe(sha256("a"))
  })
})

describe("readTextOrNull", () => {
  it("answers null for an absent file and the text for a present one", async () => {
    const root = await tempRoot()
    expect(await readTextOrNull(join(root, "nope.json"))).toBeNull()
    await writeFile(join(root, "there.json"), "{}\n", "utf8")
    expect(await readTextOrNull(join(root, "there.json"))).toBe("{}\n")
  })

  it("throws rather than answering null when the path is unreadable for another reason", async () => {
    const root = await tempRoot()
    await mkdir(join(root, "dir"))
    await expect(readTextOrNull(join(root, "dir"))).rejects.toThrow()
  })
})

describe("writeTextAtomic", () => {
  it("creates missing parents and leaves no temp sibling behind", async () => {
    const root = await tempRoot()
    const path = join(root, "a", "b", "settings.json")
    await writeTextAtomic(path, '{"x":1}\n')
    expect(await readFile(path, "utf8")).toBe('{"x":1}\n')
    expect(await readdir(join(root, "a", "b"))).toEqual(["settings.json"])
  })

  it("preserves an existing file's mode bits when mode is omitted", async () => {
    const root = await tempRoot()
    const path = join(root, "config.toml")
    await writeFile(path, "old\n", "utf8")
    await chmod(path, 0o600)
    await writeTextAtomic(path, "new\n")
    expect(await readFile(path, "utf8")).toBe("new\n")
    expect(await modeOf(path)).toBe(0o600)
  })

  it("applies an explicit mode exactly, unmasked by the umask", async () => {
    const root = await tempRoot()
    const path = join(root, "fresh.json")
    await writeTextAtomic(path, "{}\n", 0o640)
    expect(await modeOf(path)).toBe(0o640)
  })

  it("overrides an existing mode when one is given", async () => {
    const root = await tempRoot()
    const path = join(root, "tighten.json")
    await writeFile(path, "{}\n", "utf8")
    await chmod(path, 0o644)
    await writeTextAtomic(path, "{}\n", 0o600)
    expect(await modeOf(path)).toBe(0o600)
  })

  it("replaces the file rather than truncating it, so a reader never sees a partial write", async () => {
    const root = await tempRoot()
    const path = join(root, "swap.json")
    await writeTextAtomic(path, "first\n")
    const before = await stat(path)
    await writeTextAtomic(path, "second\n")
    const after = await stat(path)
    expect(await readFile(path, "utf8")).toBe("second\n")
    expect(after.ino).not.toBe(before.ino)
  })
})

describe("snapshotText / restoreText", () => {
  it("restores bytes and mode exactly", async () => {
    const root = await tempRoot()
    const path = join(root, "settings.json")
    await writeFile(path, '{\n  // a comment\n  "hooks": {}\n}\n', "utf8")
    await chmod(path, 0o600)
    const snapshot = await snapshotText(path)
    expect(snapshot.mode).toBe(0o600)
    await writeTextAtomic(path, "clobbered\n", 0o644)
    await restoreText(snapshot)
    expect(await readFile(path, "utf8")).toBe('{\n  // a comment\n  "hooks": {}\n}\n')
    expect(await modeOf(path)).toBe(0o600)
  })

  it("records absence and removes the file the install created", async () => {
    const root = await tempRoot()
    const path = join(root, "nested", "hooks.json")
    const snapshot = await snapshotText(path)
    expect(snapshot).toEqual({ path, text: null, mode: null })
    await writeTextAtomic(path, '{"hooks":[]}\n')
    expect(await exists(path)).toBe(true)
    await restoreText(snapshot)
    expect(await exists(path)).toBe(false)
  })

  it("restoring an absent snapshot twice is not an error", async () => {
    const root = await tempRoot()
    const snapshot = await snapshotText(join(root, "gone.json"))
    await restoreText(snapshot)
    await restoreText(snapshot)
    expect(await exists(join(root, "gone.json"))).toBe(false)
  })
})

describe("isDirectory / exists / realpathOrSelf", () => {
  it("answers false for a missing path instead of throwing", async () => {
    const root = await tempRoot()
    expect(await isDirectory(join(root, "missing"))).toBe(false)
    expect(await exists(join(root, "missing"))).toBe(false)
    expect(await isDirectory(join(root, "missing", "deeper"))).toBe(false)
  })

  it("separates a directory from a file", async () => {
    const root = await tempRoot()
    await mkdir(join(root, "dir"))
    await writeFile(join(root, "file"), "x", "utf8")
    expect(await isDirectory(join(root, "dir"))).toBe(true)
    expect(await isDirectory(join(root, "file"))).toBe(false)
    expect(await exists(join(root, "file"))).toBe(true)
  })

  it("counts a dangling symlink as existing, since it is an obstacle and not free space", async () => {
    const root = await tempRoot()
    await symlink(join(root, "nowhere"), join(root, "link"))
    expect(await exists(join(root, "link"))).toBe(true)
    expect(await isDirectory(join(root, "link"))).toBe(false)
  })

  it("resolves a symlink and returns the input unchanged when it cannot", async () => {
    const root = await tempRoot()
    await mkdir(join(root, "real"))
    await symlink(join(root, "real"), join(root, "alias"))
    expect(await realpathOrSelf(join(root, "alias"))).toBe(await realpathOrSelf(join(root, "real")))
    const missing = join(root, "not-a-thing")
    expect(await realpathOrSelf(missing)).toBe(missing)
  })
})

describe("assertNoSymlinkComponents", () => {
  it("accepts a path whose existing components are all real, including one not yet created", async () => {
    const root = await tempRoot()
    await mkdir(join(root, ".claude"), { recursive: true })
    await expect(
      assertNoSymlinkComponents(join(root, ".claude", "settings.json"))
    ).resolves.toBeUndefined()
    await expect(
      assertNoSymlinkComponents(join(root, ".claude", "skills", "memhtml", "SKILL.md"))
    ).resolves.toBeUndefined()
  })

  it("refuses when a PARENT component is a symlink, naming that component", async () => {
    const root = await tempRoot()
    await mkdir(join(root, "dotfiles", "claude"), { recursive: true })
    await symlink(join(root, "dotfiles", "claude"), join(root, ".claude"))
    await expect(assertNoSymlinkComponents(join(root, ".claude", "settings.json"))).rejects.toThrow(
      join(root, ".claude")
    )
  })

  it("refuses when the final component itself is a symlink", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "elsewhere.json"), "{}\n", "utf8")
    await symlink(join(root, "elsewhere.json"), join(root, ".claude.json"))
    await expect(assertNoSymlinkComponents(join(root, ".claude.json"))).rejects.toThrow(/symlink/)
  })

  it("refuses a dangling symlink component too", async () => {
    const root = await tempRoot()
    await symlink(join(root, "nowhere"), join(root, "link"))
    await expect(assertNoSymlinkComponents(join(root, "link", "settings.json"))).rejects.toThrow(
      /symlink/
    )
  })

  it("does not follow the link it refused", async () => {
    const root = await tempRoot()
    await mkdir(join(root, "target"))
    await symlink(join(root, "target"), join(root, "link"))
    const path = join(root, "link", "written.json")
    await expect(assertNoSymlinkComponents(path)).rejects.toThrow()
    expect(await readdir(join(root, "target"))).toEqual([])
    expect((await lstat(join(root, "link"))).isSymbolicLink()).toBe(true)
  })
})

describe("expandHome", () => {
  it("expands a leading tilde and nothing else", () => {
    expect(expandHome("~", "/home/ada")).toBe("/home/ada")
    expect(expandHome("~/.claude/settings.json", "/home/ada")).toBe(
      "/home/ada/.claude/settings.json"
    )
    expect(expandHome("/etc/memhtml", "/home/ada")).toBe("/etc/memhtml")
    expect(expandHome("~other/notes", "/home/ada")).toBe("~other/notes")
    expect(expandHome("./relative/~", "/home/ada")).toBe("./relative/~")
    expect(expandHome("$HOME/notes", "/home/ada")).toBe("$HOME/notes")
  })
})
