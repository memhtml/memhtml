import { describe, expect, it } from "vitest"

import {
  parseJsonc,
  readJsonPath,
  removeArrayEntries,
  removeJsonPath,
  upsertArrayEntries,
  upsertJsonPath
} from "../src/adapters/json.js"

/**
 * The JSON adapter's job is not "produce correct JSON" — `JSON.stringify` does that. It is "change the two
 * lines we own and no others", which is why every case here starts from a document with somebody else's
 * comments, key order, and formatting in it and asserts those survive the edit.
 *
 * The array cases are the sharp ones. A hooks array is shared: the operator's own `SessionStart` hook and
 * ours live in the same list, so install must recognize its own entries by their command line, drop exactly
 * those, and append the new ones — and uninstall must leave the operator's hook and remove the now-empty
 * key. An `owned` predicate that matched too widely would silently delete the operator's hooks on upgrade.
 */

const BINARY = "/home/ada/.local/bin/memhtml"

/** The real ownership predicate: an entry whose `command` names this binary AND the `hook` subcommand. */
const owned = (entry: unknown): boolean => {
  if (typeof entry !== "object" || entry === null) return false
  const command = (entry as { readonly command?: unknown }).command
  return typeof command === "string" && command.includes(" hook ") && command.includes(BINARY)
}

const OURS = { type: "command", command: `${BINARY} hook session-start --host claude` }
const THEIRS = { type: "command", command: "/usr/local/bin/notify --start" }
const THEIR_HOOK_ELSEWHERE = { type: "command", command: "/opt/other/bin/tool hook session-start" }

const COMMENTED = `{
  // the MCP servers this machine trusts
  "mcpServers": {
    /* left alone */
    "other": { "command": "other-mcp" }
  },
  "theme": "dark" // trailing
}
`

describe("readJsonPath", () => {
  it("reads through a document with comments and a trailing comma", () => {
    const text = `{
  // comment
  "a": { "b": [1, 2, 3], },
}
`
    expect(readJsonPath(text, ["a", "b", 1])).toBe(2)
    expect(readJsonPath(text, ["a", "b"])).toEqual([1, 2, 3])
  })

  it("answers undefined for an absent path and null for a present null", () => {
    const text = '{ "present": null }'
    expect(readJsonPath(text, ["absent"])).toBeUndefined()
    expect(readJsonPath(text, ["present"])).toBeNull()
    expect(readJsonPath(text, ["present", "deeper"])).toBeUndefined()
  })

  it("answers undefined for an unparseable document rather than a partial read", () => {
    expect(readJsonPath('{ "a": 1, "b": }', ["a"])).toBeUndefined()
  })

  it("treats a null or blank input as an empty object", () => {
    expect(readJsonPath(null, ["a"])).toBeUndefined()
    expect(readJsonPath("   \n", ["a"])).toBeUndefined()
  })
})

describe("upsertJsonPath", () => {
  it("keeps every comment and every sibling key", () => {
    const next = upsertJsonPath(COMMENTED, ["mcpServers", "memhtml"], {
      command: `${BINARY}-mcp`,
      env: { MEMHTML_ROOT: "/home/ada/memory" }
    })
    expect(next).toContain("// the MCP servers this machine trusts")
    expect(next).toContain("/* left alone */")
    expect(next).toContain('"theme": "dark" // trailing')
    expect(readJsonPath(next, ["mcpServers", "other", "command"])).toBe("other-mcp")
    expect(readJsonPath(next, ["mcpServers", "memhtml", "env", "MEMHTML_ROOT"])).toBe(
      "/home/ada/memory"
    )
  })

  it("creates the file, the intermediate objects, and a trailing newline from nothing", () => {
    const next = upsertJsonPath(null, ["hooks", "SessionStart", "enabled"], true)
    expect(next).toBe(`{
  "hooks": {
    "SessionStart": {
      "enabled": true
    }
  }
}
`)
  })

  it("indents new content with two spaces", () => {
    const next = upsertJsonPath("{}", ["a"], { b: 1 })
    expect(next).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n')
  })

  it("overwrites an existing value in place", () => {
    const next = upsertJsonPath(COMMENTED, ["theme"], "light")
    expect(readJsonPath(next, ["theme"])).toBe("light")
    expect(next).toContain("// the MCP servers this machine trusts")
  })

  it("is idempotent: writing the same value twice gives the same bytes", () => {
    const once = upsertJsonPath(COMMENTED, ["mcpServers", "memhtml"], { command: "x" })
    const twice = upsertJsonPath(once, ["mcpServers", "memhtml"], { command: "x" })
    expect(twice).toBe(once)
  })
})

describe("removeJsonPath", () => {
  it("removes our key and leaves the operator's comments and keys intact", () => {
    const withOurs = upsertJsonPath(COMMENTED, ["mcpServers", "memhtml"], { command: "x" })
    const next = removeJsonPath(withOurs, ["mcpServers", "memhtml"])
    expect(readJsonPath(next, ["mcpServers", "memhtml"])).toBeUndefined()
    expect(readJsonPath(next, ["mcpServers", "other", "command"])).toBe("other-mcp")
    expect(next).toContain("// the MCP servers this machine trusts")
    expect(next).toContain("/* left alone */")
  })

  it("is a no-op when the path is already absent", () => {
    expect(removeJsonPath(COMMENTED, ["mcpServers", "memhtml"])).toBe(COMMENTED)
    expect(removeJsonPath(COMMENTED, ["nothing", "here"])).toBe(COMMENTED)
  })

  it("normalizes a null input to an empty object rather than throwing", () => {
    expect(removeJsonPath(null, ["a"])).toBe("{}\n")
  })
})

describe("upsertArrayEntries", () => {
  it("creates the array when the path is absent", () => {
    const next = upsertArrayEntries(null, ["hooks", "SessionStart"], [OURS], owned)
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toEqual([OURS])
  })

  it("removes only our entries and keeps the operator's, in their order", () => {
    const start = upsertJsonPath(
      null,
      ["hooks", "SessionStart"],
      [THEIRS, OURS, THEIR_HOOK_ELSEWHERE]
    )
    const next = upsertArrayEntries(start, ["hooks", "SessionStart"], [OURS], owned)
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toEqual([
      THEIRS,
      THEIR_HOOK_ELSEWHERE,
      OURS
    ])
  })

  it("does not treat another tool's `hook` command as ours", () => {
    const start = upsertJsonPath(null, ["hooks", "SessionStart"], [THEIR_HOOK_ELSEWHERE])
    const next = upsertArrayEntries(start, ["hooks", "SessionStart"], [], owned)
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toEqual([THEIR_HOOK_ELSEWHERE])
  })

  it("does not treat our binary running another subcommand as a hook entry", () => {
    const indexer = { type: "command", command: `${BINARY} trace index --host claude` }
    const start = upsertJsonPath(null, ["hooks", "SessionEnd"], [indexer])
    const next = upsertArrayEntries(start, ["hooks", "SessionEnd"], [], owned)
    expect(readJsonPath(next, ["hooks", "SessionEnd"])).toEqual([indexer])
  })

  it("is idempotent across re-installs", () => {
    const first = upsertArrayEntries(null, ["hooks", "SessionStart"], [OURS], owned)
    const second = upsertArrayEntries(first, ["hooks", "SessionStart"], [OURS], owned)
    expect(second).toBe(first)
    expect(readJsonPath(second, ["hooks", "SessionStart"])).toEqual([OURS])
  })

  it("keeps the comments in the enclosing document", () => {
    const text = `{
  // hooks the operator wrote
  "hooks": {
    "SessionStart": [{ "type": "command", "command": "/usr/local/bin/notify --start" }]
  }
}
`
    const next = upsertArrayEntries(text, ["hooks", "SessionStart"], [OURS], owned)
    expect(next).toContain("// hooks the operator wrote")
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toEqual([THEIRS, OURS])
  })

  it("replaces a value that is not an array at all", () => {
    const text = '{ "hooks": { "SessionStart": { "legacy": true } } }'
    const next = upsertArrayEntries(text, ["hooks", "SessionStart"], [OURS], owned)
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toEqual([OURS])
  })
})

describe("removeArrayEntries", () => {
  it("drops only our entries", () => {
    const start = upsertJsonPath(null, ["hooks", "SessionStart"], [THEIRS, OURS])
    const next = removeArrayEntries(start, ["hooks", "SessionStart"], owned)
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toEqual([THEIRS])
  })

  it("drops the key entirely once the array is empty, and the object it left empty with it", () => {
    const start = upsertJsonPath(null, ["hooks", "SessionStart"], [OURS])
    const next = removeArrayEntries(start, ["hooks", "SessionStart"], owned)
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toBeUndefined()
    // `hooks` is a container this install created, so it goes too: the cascade climbs as far as the
    // root object and stops there, which is what makes an uninstall give the original file back.
    expect(readJsonPath(next, ["hooks"])).toBeUndefined()
    expect(next).toBe("{}\n")
  })

  it("keeps an event key the operator also has entries under", () => {
    const start = upsertJsonPath(null, ["hooks", "SessionStart"], [THEIRS, OURS])
    const next = removeArrayEntries(start, ["hooks", "SessionStart"], owned)
    expect(readJsonPath(next, ["hooks", "SessionStart"])).toEqual([THEIRS])
  })

  it("is a no-op when the array is absent or is not an array", () => {
    expect(removeArrayEntries(COMMENTED, ["hooks", "SessionStart"], owned)).toBe(COMMENTED)
    const object = '{ "hooks": { "SessionStart": {} } }\n'
    expect(removeArrayEntries(object, ["hooks", "SessionStart"], owned)).toBe(object)
  })

  it("round-trips an install: upsert then remove restores the operator's list", () => {
    const start = upsertJsonPath(COMMENTED, ["hooks", "SessionStart"], [THEIRS])
    const installed = upsertArrayEntries(start, ["hooks", "SessionStart"], [OURS], owned)
    const uninstalled = removeArrayEntries(installed, ["hooks", "SessionStart"], owned)
    expect(uninstalled).toBe(start)
  })
})

describe("parseJsonc", () => {
  it("parses comments and trailing commas", () => {
    expect(parseJsonc('{ /* c */ "a": [1, 2,], }')).toEqual({ a: [1, 2] })
  })

  it("answers undefined on broken input and on empty input", () => {
    expect(parseJsonc("{ not json")).toBeUndefined()
    expect(parseJsonc("")).toBeUndefined()
  })
})

/**
 * The byte-preservation lock, and the reason this adapter computes its own text edits instead of calling
 * `jsonc-parser`'s `modify` with `formattingOptions`: that path widens every edit to whole lines and
 * re-prints them, so writing `mcpServers.memhtml` re-flowed the operator's INLINE `"review"` entry over
 * three lines and uninstall could no longer hand the file back. Measured on `.cursor/mcp.json` and
 * `.claude/settings.json`, where the receipt's whole promise is the bytes.
 *
 * The documents below carry every shape that made that visible: an inline sibling object with an inline
 * array inside it, a comment line, a last property with no trailing comma, an empty object, an empty
 * array, and the same file at two indentations. Every reversible case asserts `remove(upsert(text))` is
 * `text` byte for byte and that `upsert` is idempotent, which together say the edit touched nothing but
 * its own span.
 */

const CONFIG = `{
  // the review server predates memhtml
  "mcpServers": {
    "review": { "command": "/usr/local/bin/review-mcp", "args": ["--stdio"] }
  },
  "permissions": {},
  "hooks": {
    "SessionEnd": [
      { "type": "command", "command": "/usr/local/bin/log-session" }
    ]
  },
  "oneLine": { "SessionEnd": [{ "type": "command", "command": "/usr/local/bin/log" }] },
  "empty": [],
  "numStartups": 41
}
`

const CONFIG_4 = `{
    // the review server predates memhtml
    "mcpServers": {
        "review": { "command": "/usr/local/bin/review-mcp", "args": ["--stdio"] }
    },
    "permissions": {},
    "hooks": {
        "SessionEnd": [
            { "type": "command", "command": "/usr/local/bin/log-session" }
        ]
    },
    "oneLine": { "SessionEnd": [{ "type": "command", "command": "/usr/local/bin/log" }] },
    "empty": [],
    "numStartups": 41
}
`

/** The line the defect used to re-flow, in both documents. */
const INLINE_NEIGHBOUR = '"review": { "command": "/usr/local/bin/review-mcp", "args": ["--stdio"] }'

const MCP_ENTRY = {
  command: `${BINARY}-mcp`,
  env: { MEMHTML_ROOT: "/home/ada/memory" }
}

/** One edit and the call that takes it back out. */
interface Reversible {
  readonly what: string
  readonly install: (text: string) => string
  readonly uninstall: (text: string) => string
  /** True for the one case whose target IS the inline member, so its line is ours to change. */
  readonly writesIntoNeighbour?: true
}

const REVERSIBLE: ReadonlyArray<Reversible> = [
  {
    what: "an object key in a parent that already runs over lines",
    install: (text) => upsertJsonPath(text, ["mcpServers", "memhtml"], MCP_ENTRY),
    uninstall: (text) => removeJsonPath(text, ["mcpServers", "memhtml"])
  },
  {
    what: "an object key in a parent written on one line",
    install: (text) => upsertJsonPath(text, ["mcpServers", "review", "cwd"], "/home/ada"),
    uninstall: (text) => removeJsonPath(text, ["mcpServers", "review", "cwd"]),
    writesIntoNeighbour: true
  },
  {
    what: "an object key in a parent chain that is not there at all",
    install: (text) => upsertJsonPath(text, ["agents", "memhtml", "enabled"], true),
    uninstall: (text) => removeJsonPath(text, ["agents", "memhtml", "enabled"])
  },
  {
    what: "an object key whose value is already there",
    install: (text) => upsertJsonPath(text, ["numStartups"], 42),
    uninstall: (text) => upsertJsonPath(text, ["numStartups"], 41)
  },
  {
    what: "an array entry in an array that already runs over lines",
    install: (text) => upsertArrayEntries(text, ["hooks", "SessionEnd"], [OURS], owned),
    uninstall: (text) => removeArrayEntries(text, ["hooks", "SessionEnd"], owned)
  },
  {
    what: "an array entry in an array written on one line",
    install: (text) => upsertArrayEntries(text, ["oneLine", "SessionEnd"], [OURS], owned),
    uninstall: (text) => removeArrayEntries(text, ["oneLine", "SessionEnd"], owned)
  },
  {
    what: "an array that is not there at all",
    install: (text) => upsertArrayEntries(text, ["hooks", "SessionStart"], [OURS], owned),
    uninstall: (text) => removeArrayEntries(text, ["hooks", "SessionStart"], owned)
  }
]

describe("an edit changes no byte outside its own span", () => {
  for (const [style, document] of Object.entries({ "2-space": CONFIG, "4-space": CONFIG_4 })) {
    it.for(REVERSIBLE)(`${style}: $what`, ({ install, uninstall }) => {
      const installed = install(document)
      expect(installed).not.toBe(document)
      expect(uninstall(installed)).toBe(document)
    })

    it.for(REVERSIBLE)(`${style}: $what, written twice`, ({ install }) => {
      const once = install(document)
      expect(install(once)).toBe(once)
    })

    it.for(REVERSIBLE.filter((one) => one.writesIntoNeighbour === undefined))(
      `${style}: $what, beside an inline member`,
      ({ install }) => {
        // The defect itself: this member is on one line and must stay on it, gaining at most the comma
        // JSON needs when something is appended after it.
        const installed = install(document)
        expect(
          installed.includes(`${INLINE_NEIGHBOUR}\n`) ||
            installed.includes(`${INLINE_NEIGHBOUR},\n`)
        ).toBe(true)
      }
    )
  }

  it("gives an empty document back exactly, since the root object is never removed", () => {
    const installed = upsertJsonPath("{}\n", ["mcpServers", "memhtml"], MCP_ENTRY)
    expect(installed).toBe(`{
  "mcpServers": {
    "memhtml": {
      "command": "${BINARY}-mcp",
      "env": {
        "MEMHTML_ROOT": "/home/ada/memory"
      }
    }
  }
}
`)
    expect(removeJsonPath(installed, ["mcpServers", "memhtml"])).toBe("{}\n")
  })

  /**
   * Two shapes that do NOT come back byte for byte, and both by decision rather than by drift: a
   * container that was ALREADY empty cannot be told apart from one this install created, and leaving
   * `"mcpServers": {}` or `"SessionStart": []` behind is the litter every other assertion here exists to
   * prevent. Every other byte in the document is still untouched, which is what these two assert.
   */
  it("takes an object that was already empty with it, and nothing else", () => {
    const installed = upsertJsonPath(CONFIG, ["permissions", "allow"], ["Bash(git status)"])
    expect(installed).toContain(
      `  "permissions": {\n    "allow": [\n      "Bash(git status)"\n    ]`
    )
    expect(removeJsonPath(installed, ["permissions", "allow"])).toBe(
      CONFIG.replace('  "permissions": {},\n', "")
    )
  })

  it("takes an array that was already empty with it, and nothing else", () => {
    const installed = upsertArrayEntries(CONFIG, ["empty"], [OURS], owned)
    expect(installed).toContain(`  "empty": [\n    {\n      "type": "command",`)
    expect(removeArrayEntries(installed, ["empty"], owned)).toBe(
      CONFIG.replace('  "empty": [],\n', "")
    )
  })

  it("writes our own value at the indent the parent's other members sit at", () => {
    // Requirement and readability in one assertion: two-space stepped from the member indent, so the
    // block reads as part of the document it landed in rather than as a machine's paste.
    expect(upsertJsonPath(CONFIG_4, ["mcpServers", "memhtml"], MCP_ENTRY)).toContain(
      `        "memhtml": {\n          "command": "${BINARY}-mcp",\n          "env": {\n            "MEMHTML_ROOT": "/home/ada/memory"\n          }\n        }`
    )
  })

  it("writes an inline value inline, on the one line its parent occupies", () => {
    const installed = upsertJsonPath(CONFIG, ["oneLine", "enabled"], true)
    expect(installed).toContain(
      '"oneLine": { "SessionEnd": [{ "type": "command", "command": "/usr/local/bin/log" }], "enabled": true },'
    )
  })

  it("leaves a document it cannot parse exactly as it is rather than repairing it", () => {
    const broken = '{\n  "a": 1,\n  "b":\n}\n'
    expect(upsertJsonPath(broken, ["c"], 1)).toBe(broken)
    expect(removeJsonPath(broken, ["a"])).toBe(broken)
    expect(upsertArrayEntries(broken, ["d"], [OURS], owned)).toBe(broken)
    expect(removeArrayEntries(broken, ["a"], owned)).toBe(broken)
  })
})
