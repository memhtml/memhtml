import { describe, expect, it } from "vitest"

import { hookCommand, shellJoin } from "../src/command-line.js"
import {
  CURSOR_HOOKS_VERSION,
  claudeHooks,
  claudeOwned,
  codexHooks,
  codexOwned,
  cursorHooks,
  cursorOwned
} from "../src/render/hooks.js"
import type { BinaryLocation, HookMode } from "../src/types.js"

const BINARY: BinaryLocation = {
  node: "/opt/nodes/24.9.0/bin/node",
  cli: "/opt/memhtml/0.14.0/dist/memhtml.mjs",
  mcp: "/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs",
  version: "0.14.0"
}

const ROOT = "/home/dev/memory"
const OPTS = { memhtmlRoot: ROOT, traceRoot: "/home/dev/.claude" }
const NO_TRACE = { memhtmlRoot: ROOT }

/** Every command string in a rendered entry set, whichever host shape it is. */
const commandsIn = (entries: Record<string, ReadonlyArray<unknown>>): ReadonlyArray<string> =>
  Object.values(entries).flatMap((array) =>
    array.flatMap((entry) => {
      const record = entry as { readonly command?: string; readonly hooks?: ReadonlyArray<unknown> }
      if (typeof record.command === "string") return [record.command]
      return (record.hooks ?? []).map(
        (handler) => (handler as { readonly command: string }).command
      )
    })
  )

describe("claudeHooks", () => {
  it("renders the full set as Claude Code's settings.json shape, timeouts and all", () => {
    expect(claudeHooks(BINARY, false, "all", OPTS)).toEqual({
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: shellJoin(hookCommand(BINARY, false, "session-start", "claude", OPTS)),
              timeout: 10
            }
          ]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: shellJoin(hookCommand(BINARY, false, "user-prompt-submit", "claude", OPTS)),
              timeout: 10
            }
          ]
        }
      ],
      PreCompact: [
        {
          hooks: [
            {
              type: "command",
              command: shellJoin(hookCommand(BINARY, false, "pre-compact", "claude", OPTS)),
              timeout: 30
            }
          ]
        }
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: shellJoin(hookCommand(BINARY, false, "session-end", "claude", OPTS)),
              timeout: 30
            }
          ]
        }
      ]
    })
  })

  it("omits matcher entirely, because a missing matcher already means every source", () => {
    for (const groups of Object.values(claudeHooks(BINARY, false, "all", OPTS))) {
      for (const group of groups) {
        expect(Object.keys(group)).toEqual(["hooks"])
      }
    }
  })

  it("drops the transcript hooks when no trace root is known", () => {
    expect(Object.keys(claudeHooks(BINARY, false, "all", NO_TRACE))).toEqual([
      "SessionStart",
      "UserPromptSubmit"
    ])
  })

  it("prunes by mode: session is session-start only, none writes nothing", () => {
    expect(Object.keys(claudeHooks(BINARY, false, "session", OPTS))).toEqual(["SessionStart"])
    expect(claudeHooks(BINARY, false, "none", OPTS)).toEqual({})
  })
})

describe("codexHooks", () => {
  it("installs the two injecting events and NEVER a compaction hook", () => {
    /** There is no Codex transcript reader, so a PreCompact hook would index nothing. */
    expect(Object.keys(codexHooks(BINARY, false, "all", OPTS))).toEqual([
      "SessionStart",
      "UserPromptSubmit"
    ])
    expect(Object.keys(codexHooks(BINARY, false, "session", OPTS))).toEqual(["SessionStart"])
    expect(codexHooks(BINARY, false, "none", OPTS)).toEqual({})
  })

  it("names codex as the host in every command", () => {
    for (const command of commandsIn(codexHooks(BINARY, true, "all", OPTS))) {
      expect(command).toContain("--host codex")
    }
  })
})

describe("cursorHooks", () => {
  it("installs sessionStart and NEVER a prompt hook, in any mode", () => {
    /**
     * MUTATION-VERIFIED LOCK "cursor never gets a prompt hook": adding a `beforeSubmitPrompt` entry to
     * `cursorHooks` fails this case. Cursor's `beforeSubmitPrompt` can only cancel a turn — it cannot
     * inject context — so a per-prompt hook there spawns a process per prompt and throws the answer away.
     */
    for (const mode of ["all", "session"] as const) {
      const entries = cursorHooks(BINARY, false, mode, OPTS)
      expect(Object.keys(entries)).toEqual(["sessionStart"])
      for (const command of commandsIn(entries)) {
        expect(command).not.toContain("user-prompt-submit")
        expect(command).toContain("session-start")
      }
    }
    expect(cursorHooks(BINARY, false, "none", OPTS)).toEqual({})
  })

  it("renders a bare { command } entry and a version for the file that wraps it", () => {
    expect(cursorHooks(BINARY, true, "all", NO_TRACE)).toEqual({
      sessionStart: [
        { command: "memhtml hook session-start --host cursor --repo /home/dev/memory" }
      ]
    })
    expect(CURSOR_HOOKS_VERSION).toBe(1)
  })
})

describe("every rendered hook command", () => {
  it("carries --repo <root> and its own event, on every host and mode", () => {
    const sets = [
      ...(["all", "session"] as ReadonlyArray<HookMode>).flatMap((mode) => [
        claudeHooks(BINARY, false, mode, OPTS),
        claudeHooks(BINARY, true, mode, NO_TRACE),
        codexHooks(BINARY, false, mode, OPTS),
        cursorHooks(BINARY, false, mode, OPTS)
      ])
    ]
    let seen = 0
    for (const entries of sets) {
      for (const [event, groups] of Object.entries(entries)) {
        for (const command of commandsIn({ [event]: groups })) {
          seen += 1
          expect(command).toContain(`--repo ${ROOT}`)
          expect(command).toMatch(
            / hook (session-start|user-prompt-submit|pre-compact|session-end) /
          )
        }
      }
    }
    // 4 + 2 + 2 + 1 for `all`, then 1 + 1 + 1 + 1 for `session`: a census, not a report.
    expect(seen).toBe(13)
  })
})

describe("ownership predicates", () => {
  const ours = claudeHooks(BINARY, false, "all", OPTS).SessionStart?.[0]

  it("recognizes an entry this installer wrote", () => {
    expect(claudeOwned(ours, BINARY, false)).toBe(true)
    expect(claudeOwned(ours)).toBe(true)
    expect(
      codexOwned(codexHooks(BINARY, false, "all", OPTS).SessionStart?.[0], BINARY, false)
    ).toBe(true)
    expect(
      cursorOwned(cursorHooks(BINARY, true, "all", OPTS).sessionStart?.[0], BINARY, true)
    ).toBe(true)
  })

  it("leaves another tool's hook alone", () => {
    expect(claudeOwned({ hooks: [{ type: "command", command: "./bin/lint-staged" }] })).toBe(false)
    expect(
      claudeOwned({ command: "npx some-other-memory hook session-start" }, BINARY, false)
    ).toBe(false)
    expect(claudeOwned({ hooks: [] })).toBe(false)
    expect(claudeOwned({})).toBe(false)
    expect(claudeOwned(undefined)).toBe(false)
    expect(claudeOwned("memhtml hook session-start")).toBe(false)
  })

  it("in bare mode owns only a line that starts with the bare memhtml command", () => {
    const shape = "hook session-start --host claude --repo /m"
    expect(claudeOwned({ command: `memhtml ${shape}` }, BINARY, true)).toBe(true)
    expect(claudeOwned({ command: `other-tool ${shape}` }, BINARY, true)).toBe(false)
    expect(claudeOwned({ command: `/opt/other/memhtml ${shape}` }, BINARY, true)).toBe(false)
    // The word alone is not the shape: no event, no --host.
    expect(claudeOwned({ command: "memhtml hook something-else" }, BINARY, true)).toBe(false)
    expect(claudeOwned({ command: "other-tool hook session-start" }, BINARY, true)).toBe(false)
  })

  it("refuses a group a human has added a second handler to", () => {
    const mixed = {
      hooks: [
        (ours as { readonly hooks: ReadonlyArray<unknown> }).hooks[0],
        { type: "command", command: "./bin/notify" }
      ]
    }
    expect(claudeOwned(mixed, BINARY, false)).toBe(false)
  })

  it("does not claim a memhtml command that is not a hook", () => {
    expect(claudeOwned({ command: `${BINARY.cli} search "anything"` }, BINARY, false)).toBe(false)
  })
})
