import { describe, expect, it } from "vitest"

import { rcFileFor, renderShellSnippet } from "../src/shell.js"

describe("renderShellSnippet", () => {
  it("exports the store and prefixes PATH, each under one comment", () => {
    expect(
      renderShellSnippet({ memhtmlRoot: "/home/dev/memory", binDir: "/opt/memhtml/0.14.0/bin" })
    ).toBe(
      [
        "# The memhtml store every memhtml command and MCP server reads by default.",
        'export MEMHTML_ROOT="/home/dev/memory"',
        "# Put this memhtml on PATH once, however many times this file is sourced.",
        'case ":$PATH:" in *":/opt/memhtml/0.14.0/bin:"*) ;; *) export PATH="/opt/memhtml/0.14.0/bin:$PATH";; esac',
        ""
      ].join("\n")
    )
  })

  it("guards the PATH line so re-sourcing cannot stack the directory", () => {
    const snippet = renderShellSnippet({ memhtmlRoot: "/m", binDir: "/b" })
    expect(snippet).toContain('case ":$PATH:" in *":/b:"*) ;; *)')
    expect(snippet.split("\n").filter((line) => line.includes("export PATH"))).toHaveLength(1)
  })

  it("escapes what a shell would read inside double quotes", () => {
    const snippet = renderShellSnippet({
      memhtmlRoot: '/home/dev/$USER `whoami` "m"',
      binDir: "/opt/a\\b"
    })
    expect(snippet).toContain('export MEMHTML_ROOT="/home/dev/\\$USER \\`whoami\\` \\"m\\""')
    expect(snippet).toContain('export PATH="/opt/a\\\\b:$PATH"')
  })
})

describe("rcFileFor", () => {
  it("reads zsh from $SHELL and falls back to bash", () => {
    expect(rcFileFor("/bin/zsh", "/home/dev")).toBe("/home/dev/.zshrc")
    expect(rcFileFor("/opt/homebrew/bin/zsh", "/home/dev")).toBe("/home/dev/.zshrc")
    expect(rcFileFor("/bin/bash", "/home/dev")).toBe("/home/dev/.bashrc")
    expect(rcFileFor("/usr/bin/fish", "/home/dev")).toBe("/home/dev/.bashrc")
    expect(rcFileFor(undefined, "/home/dev")).toBe("/home/dev/.bashrc")
    expect(rcFileFor("", "/home/dev")).toBe("/home/dev/.bashrc")
  })

  it("joins on the home it was given, trailing slash or not", () => {
    expect(rcFileFor("/bin/zsh", "/home/dev/")).toBe("/home/dev/.zshrc")
  })
})
