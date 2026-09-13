import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

import { type ParseError, parse as parseJsonc } from "jsonc-parser"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"
import { envelopeOf, runBuilt, runBuiltWithStdin } from "./spawned.js"

/**
 * `memhtml integrations` against a real `$HOME`, driven through the BUILT binary.
 *
 * Every other tier proves the rendering: `@memhtml/integrations`' own suites assert each host's config
 * shape byte for byte with no home directory to install into, which is what makes them fast and total.
 * What no pure renderer can show is the half this family exists for — that the files land where a vendor
 * looks for them, that the command a host will actually spawn is a path that exists, that a hook run the
 * way a host runs it returns that host's protocol, and that uninstall gives a file another tool owns back
 * unchanged. Those are process and filesystem facts, so this tier spawns the binary with `HOME` pointed at
 * a temp directory and reads what appears there.
 *
 * `HOME` is the whole reason this file is careful. `integrations install` at user scope writes into
 * `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, and `~/.config/opencode/`, so a suite
 * that inherited the operator's home would rewire the coding agents of whoever ran `mise run check`.
 * Every invocation here passes a `HOME` under the temp directory through `extraEnv`, which `childEnv`
 * merges last.
 */

/** Does this path exist? A missing file is an answer here, not an error. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex")

/**
 * Where two texts first differ, as a sentence.
 *
 * A byte-for-byte assertion over a config file fails with two hashes, and a message carrying both whole
 * files makes the reader diff them by eye — which is how a one-line reformat reads as "the file was
 * destroyed". This names the line.
 */
const firstDifference = (before: string, after: string): string => {
  const left = before.split("\n")
  const right = after.split("\n")
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    if (left[at] !== right[at]) {
      return `line ${String(at + 1)}\n  before: ${JSON.stringify(left[at])}\n  after:  ${JSON.stringify(right[at])}`
    }
  }
  return "no line differs, so only the trailing bytes moved"
}

/**
 * One host's config file, read the way the HOST reads it: JSON with comments.
 *
 * `JSON.parse` is the wrong reader here and fails loudly, which is the useful half of this discovery —
 * `~/.claude.json` and `~/.cursor/mcp.json` legitimately carry `//` comments, both from an operator and
 * from this suite's own fixtures, and a strict parse of one throws on line 2. The same `jsonc-parser` the
 * installer edits with is used to read it, and its errors are surfaced rather than swallowed: a file this
 * cannot parse is a file the host cannot load either.
 */
const readJsonc = async <A>(path: string): Promise<A> => {
  const text = await readFile(path, "utf8")
  const errors: Array<ParseError> = []
  const value = parseJsonc(text, errors) as A
  if (errors.length > 0) {
    throw new Error(`${path} is not valid JSONC (${errors.length} errors):\n${text}`)
  }
  return value
}

/** One host's user-scope footprint, spelled the way a vendor's docs spell it. */
interface HostFixture {
  readonly host: string
  /**
   * Files install must write, relative to `$HOME`.
   *
   * Restated here rather than read from the receipt on purpose: the receipt is the thing under test, so a
   * census that took its paths from it would agree with an install that wrote the wrong four files. The
   * receipt's own completeness is asserted separately, against these.
   */
  readonly writes: ReadonlyArray<string>
  /**
   * The directory whose presence IS this host, relative to `$HOME`.
   *
   * Created before every install, because that is how `integrations install` with no host argument
   * detects a host, and because a directory this suite created cannot then be asserted absent after
   * uninstall — which is what the skill-directory assertions read.
   */
  readonly homeDir: string
  /**
   * Files another tool already owns, seeded with foreign content before install.
   *
   * These are the ones uninstall must give back byte for byte. A comment in `~/.claude.json` is the
   * sharpest case: a JSON round trip through `JSON.parse` + `JSON.stringify` would drop it, so its
   * survival is what proves the edit was a text splice rather than a rewrite.
   */
  readonly shared: Readonly<Record<string, string>>
}

const CLAUDE_JSON = `{
  // Kept by hand: the review server predates memhtml and must survive both directions.
  "mcpServers": {
    "review": {
      "command": "/usr/local/bin/review-mcp",
      "args": ["--stdio"]
    }
  },
  "numStartups": 41
}
`

const CLAUDE_SETTINGS = `{
  // An operator's own settings, and one hook of their own.
  "permissions": {
    "allow": ["Bash(git status)"]
  },
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "/usr/local/bin/log-session", "timeout": 5 }]
      }
    ]
  }
}
`

const HOSTS: ReadonlyArray<HostFixture> = [
  {
    host: "claude",
    homeDir: ".claude",
    writes: [
      ".claude.json",
      ".claude/settings.json",
      ".claude/CLAUDE.md",
      ".claude/skills/memhtml/SKILL.md"
    ],
    shared: {
      ".claude.json": CLAUDE_JSON,
      ".claude/settings.json": CLAUDE_SETTINGS,
      ".claude/CLAUDE.md": "# My instructions\n\nAlways run the tests before saying it works.\n"
    }
  },
  {
    host: "codex",
    homeDir: ".codex",
    writes: [
      ".codex/config.toml",
      ".codex/hooks.json",
      ".codex/AGENTS.md",
      ".agents/skills/memhtml/SKILL.md"
    ],
    shared: {
      ".codex/config.toml": '# Mine, not memhtml\'s.\nmodel = "gpt-5-codex"\n',
      ".codex/AGENTS.md": "# My instructions\n\nPrefer small diffs.\n"
    }
  },
  {
    host: "cursor",
    homeDir: ".cursor",
    writes: [".cursor/mcp.json", ".cursor/hooks.json"],
    shared: {
      ".cursor/mcp.json":
        '{\n  // Mine.\n  "mcpServers": {\n    "review": { "command": "/usr/local/bin/review-mcp" }\n  }\n}\n'
    }
  },
  {
    host: "opencode",
    homeDir: ".config/opencode",
    writes: [
      ".config/opencode/opencode.json",
      ".config/opencode/plugins/memhtml.js",
      ".config/opencode/AGENTS.md"
    ],
    shared: {
      ".config/opencode/opencode.json":
        '{\n  // Mine.\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "system"\n}\n',
      ".config/opencode/AGENTS.md": "# My instructions\n\nAsk before deleting anything.\n"
    }
  }
]

/** One fixture by name, so a `describe` naming a host cannot index past the end of the table. */
const hostFixture = (host: string): HostFixture => {
  const found = HOSTS.find((one) => one.host === host)
  if (found === undefined) throw new Error(`no fixture for ${host}`)
  return found
}

/** The receipt path this family writes at user scope, which is also a host's install state. */
const receiptPath = (home: string, host: string): string =>
  join(home, ".config", "memhtml", "integrations", `${host}.json`)

/**
 * `integrations.report`, as the command answers it.
 *
 * One row per host under `hosts` rather than a `host` at the top, because a bare `integrations install`
 * installs every host whose home directory exists, and a single-host envelope could not describe that
 * run. Every assertion below reads its host's row by name for the same reason.
 */
interface Report {
  readonly action: string
  readonly scope: string
  readonly changed: boolean
  readonly hosts: ReadonlyArray<{
    readonly host: string
    readonly changed: boolean
    readonly entries: ReadonlyArray<{ path: string; role: string; kind: string; action: string }>
    readonly receiptPath?: string
  }>
}

/** One host's row, or a failure naming what the report did carry. */
const reportRow = (report: Report, host: string): Report["hosts"][number] => {
  const found = report.hosts.find((one) => one.host === host)
  if (found === undefined) {
    throw new Error(
      `no \`${host}\` row: ${report.hosts.map((one) => one.host).join(", ") || "none"}`
    )
  }
  return found
}

interface Receipt {
  readonly host: string
  readonly scope: string
  readonly memhtmlRoot: string
  readonly entries: ReadonlyArray<{
    readonly path: string
    readonly role: string
    readonly kind: string
    readonly sha256: string
  }>
}

/** `integrations.list`: one row per host per scope, carrying that host's install state. */
interface Listing {
  readonly rows: ReadonlyArray<{
    readonly host: string
    readonly scope: string
    readonly state: string
  }>
}

/**
 * A `$HOME` with one host's pre-existing files in it, and the exact bytes each one started with.
 *
 * The host's own directory is created even when nothing is seeded into it, because that directory is how
 * `integrations install` with no host argument detects a host at all, and a suite that installed into a
 * home with none of them would be testing a machine that does not exist.
 */
const seedHome = async (
  fixture: HostFixture
): Promise<{ readonly home: string; readonly before: Map<string, string> }> => {
  const home = await mkdtemp(join(tmpdir(), `memhtml-home-${fixture.host}-`))
  const before = new Map<string, string>()
  await mkdir(join(home, fixture.homeDir), { recursive: true })
  for (const [relative, content] of Object.entries(fixture.shared)) {
    const absolute = join(home, relative)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
    before.set(relative, content)
  }
  return { home, before }
}

describe("Claude Code, wired to a store through the built binary", () => {
  let cli: Cli
  let home: string
  let before: Map<string, string>
  let memoryPath: string
  const fixture = hostFixture("claude")

  beforeAll(async () => {
    cli = await makeCli()
    const written = await writeMemory(cli, {
      title: "Draining the VIP before a revert keeps connections off the old target group",
      claim: "Drain the VIP before reverting a deploy.",
      type: "semantic",
      workspace: "checkout-api"
    })
    memoryPath = written.path
    const seeded = await seedHome(fixture)
    home = seeded.home
    before = seeded.before
  })

  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
    await cli.cleanup()
  })

  it("installs at exit 0 and reports the entries it wrote", async () => {
    const spawned = await runBuilt(cli.root, ["integrations", "install", "claude"], { HOME: home })
    expect(spawned.exitCode, spawned.stderr).toBe(0)
    const envelope = envelopeOf(spawned)
    expect(envelope.type).toBe("integrations.report")
    const data = envelope.data as Report
    expect(data.scope).toBe("user")
    expect(data.changed).toBe(true)
    const row = reportRow(data, "claude")
    expect(row.changed).toBe(true)
    expect(row.entries.length).toBeGreaterThan(0)
    for (const entry of row.entries) {
      expect(isAbsolute(entry.path), entry.path).toBe(true)
      expect(entry.role.length).toBeGreaterThan(0)
      expect(["file", "fragment"]).toContain(entry.kind)
    }
  })

  it("writes every file a Claude Code install is supposed to write", async () => {
    for (const relative of fixture.writes) {
      expect(await exists(join(home, relative)), relative).toBe(true)
    }
    expect(await exists(receiptPath(home, "claude"))).toBe(true)
  })

  /**
   * The receipt is the ownership story, so it is checked against the filesystem in BOTH directions: every
   * path it claims exists, and every file the fixture above names is claimed. One direction alone passes
   * over a receipt that names a file nobody wrote, or an install that wrote a file the receipt forgot —
   * and the second is the one that makes uninstall leave litter behind.
   */
  it("claims every file it wrote, and nothing it did not", async () => {
    const receipt = JSON.parse(await readFile(receiptPath(home, "claude"), "utf8")) as Receipt
    expect(receipt.host).toBe("claude")
    expect(receipt.scope).toBe("user")
    expect(await realpath(receipt.memhtmlRoot)).toBe(await realpath(cli.root))
    for (const entry of receipt.entries) {
      expect(await exists(entry.path), entry.path).toBe(true)
      expect(entry.sha256.length).toBeGreaterThan(0)
    }
    const claimed = new Set(receipt.entries.map((entry) => entry.path))
    for (const relative of fixture.writes) {
      expect([...claimed], relative).toContain(join(home, relative))
    }
  })

  it("names an absolute MCP command that exists on this machine", async () => {
    const config = await readJsonc<{
      readonly mcpServers: Record<string, { readonly command: string; readonly args?: string[] }>
    }>(join(home, ".claude.json"))
    const entry = config.mcpServers.memhtml
    expect(entry).toBeDefined()
    expect(isAbsolute(entry?.command ?? "")).toBe(true)
    expect(await exists(entry?.command ?? "")).toBe(true)
    // The operator's own server is still there: this is a fragment inside a file we co-own.
    expect(config.mcpServers.review).toBeDefined()
  })

  /**
   * The two events Claude Code can inject context on, each carrying this store's path.
   *
   * `--repo` matters more than it looks: a hook is spawned by the host rather than by a shell, so it
   * inherits no `MEMHTML_ROOT`, and a hook without the flag would search whatever the default root is —
   * a different corpus, silently, with no error anywhere.
   */
  it("installs a session-start and a per-prompt hook naming this store", async () => {
    const settings = await readJsonc<{
      readonly hooks: Record<string, ReadonlyArray<{ hooks?: ReadonlyArray<{ command?: string }> }>>
    }>(join(home, ".claude/settings.json"))
    const commandFor = (event: string): string =>
      (settings.hooks[event] ?? [])
        .flatMap((group) => (group.hooks ?? []).map((handler) => handler.command ?? ""))
        .join(" ")
    const start = commandFor("SessionStart")
    const prompt = commandFor("UserPromptSubmit")
    expect(start).toContain("hook session-start --host claude")
    expect(prompt).toContain("hook user-prompt-submit --host claude")
    for (const command of [start, prompt]) {
      const root = /--repo (\S+)/.exec(command)?.[1] ?? ""
      expect(await realpath(root.replaceAll("'", "")), command).toBe(await realpath(cli.root))
    }
    // The operator's own SessionEnd hook is untouched, which is what a fragment claim buys.
    expect(JSON.stringify(settings.hooks.SessionEnd)).toContain("/usr/local/bin/log-session")
  })

  /**
   * The installed hook, run the way the host runs it: payload on stdin, protocol on stdout.
   *
   * Not an envelope, and that is the assertion rather than a detail — Claude Code puts this stdout into
   * the model's context, so `{"apiVersion":"1",…}` there would exit 0, print something, and be wrong in
   * the only way that matters.
   */
  it("injects the store's own memory on a per-prompt hook, as text and not an envelope", async () => {
    const spawned = await runBuiltWithStdin(
      cli.root,
      ["hook", "user-prompt-submit", "--host", "claude"],
      `${JSON.stringify({ prompt: "why did the checkout deploy keep serving after the revert" })}\n`,
      { HOME: home }
    )
    expect(spawned.exitCode, spawned.stderr).toBe(0)
    expect(spawned.stdout).toContain(memoryPath)
    expect(() => JSON.parse(spawned.stdout)).toThrow()
  })

  it("lists claude as installed at user scope", async () => {
    const spawned = await runBuilt(cli.root, ["integrations", "list"], { HOME: home })
    expect(spawned.exitCode, spawned.stderr).toBe(0)
    const envelope = envelopeOf(spawned)
    expect(envelope.type).toBe("integrations.list")
    const rows = (envelope.data as Listing).rows
    // Every host is reported, installed or not: the operator's question is which, so the whole closed
    // vocabulary appearing is part of the answer.
    expect(rows.map((one) => one.host)).toEqual(["claude", "codex", "cursor", "opencode"])
    expect(rows.find((one) => one.host === "claude")?.state).toBe("installed")
    for (const other of rows.filter((one) => one.host !== "claude")) {
      expect(other.state, other.host).toBe("not-installed")
    }
  })

  it("answers a doctor report whose checks each carry a verdict", async () => {
    const spawned = await runBuilt(cli.root, ["integrations", "doctor", "claude"], { HOME: home })
    expect(spawned.exitCode, spawned.stderr).toBe(0)
    const envelope = envelopeOf(spawned)
    expect(envelope.type).toBe("integrations.doctor")
    const data = envelope.data as {
      readonly healthy: boolean
      readonly hosts: ReadonlyArray<{
        readonly host: string
        readonly healthy: boolean
        readonly checks: ReadonlyArray<{
          name: string
          ok: boolean
          detail: string
          suggestions: ReadonlyArray<string>
        }>
      }>
    }
    const host = data.hosts.find((one) => one.host === "claude")
    expect(host, JSON.stringify(data.hosts.map((one) => one.host))).toBeDefined()
    const checks = host?.checks ?? []
    expect(checks.length).toBeGreaterThan(0)
    for (const check of checks) {
      expect(check.name.length, JSON.stringify(check)).toBeGreaterThan(0)
      expect(typeof check.ok).toBe("boolean")
      expect(Array.isArray(check.suggestions)).toBe(true)
    }
    // A failing check must say what to do about it; a passing one has nothing to suggest.
    for (const check of checks.filter((one) => !one.ok)) {
      expect(check.suggestions.length, `${check.name}: ${check.detail}`).toBeGreaterThan(0)
    }
    /*
     * `mcp-handshake` is in here, which is the reason this case is worth its two seconds: it spawns the
     * `memhtml-mcp` the MCP entry names and waits for an `initialize` reply, so a wired host that could
     * never actually start the server fails here rather than in someone's editor.
     */
    expect(checks.map((one) => one.name)).toContain("mcp-handshake")
    expect(
      data.healthy,
      `failing: ${checks
        .filter((one) => !one.ok)
        .map((one) => `${one.name} (${one.detail})`)
        .join("; ")}`
    ).toBe(true)
  })

  it("prints a shell snippet without --write, and writes no rc file", async () => {
    const rc = join(home, ".zshrc")
    const spawned = await runBuilt(cli.root, ["integrations", "shell"], {
      HOME: home,
      SHELL: "/bin/zsh"
    })
    expect(spawned.exitCode, spawned.stderr).toBe(0)
    const envelope = envelopeOf(spawned)
    expect(envelope.type).toBe("integrations.shell")
    const data = envelope.data as { readonly snippet: string }
    expect(data.snippet).toContain("MEMHTML_ROOT")
    expect(await exists(rc)).toBe(false)
  })

  /** Last, because it takes the installation away. */
  it("gives every shared file back byte for byte, and takes the skill with it", async () => {
    const skill = join(home, ".claude/skills/memhtml/SKILL.md")
    expect(await exists(skill)).toBe(true)
    const spawned = await runBuilt(cli.root, ["integrations", "uninstall", "claude"], {
      HOME: home
    })
    expect(spawned.exitCode, spawned.stderr).toBe(0)
    expect(envelopeOf(spawned).type).toBe("integrations.report")
    for (const [relative, content] of before) {
      const now = await readFile(join(home, relative), "utf8")
      expect(sha256(now), `${relative}: ${firstDifference(content, now)}`).toBe(sha256(content))
    }
    expect(await exists(skill)).toBe(false)
    expect(await exists(dirname(skill))).toBe(false)
    expect(await exists(receiptPath(home, "claude"))).toBe(false)

    // The other half of the `list` case above: the same call, over a home nothing is installed in.
    const listed = await runBuilt(cli.root, ["integrations", "list"], { HOME: home })
    for (const row of (envelopeOf(listed).data as Listing).rows) {
      expect(row.state, row.host).toBe("not-installed")
    }
  })
})

/**
 * The same round trip for every host, over that host's own file set.
 *
 * Claude Code is covered above in depth and repeated here anyway: the loop's subject is the property that
 * install and uninstall are inverses of each other on a home someone else was already using, and a host
 * left out of it is a host where that has never been shown.
 */
describe("every host installs its own file set and hands the shared files back", () => {
  it.for(HOSTS)("$host", async (fixture) => {
    const cli = await makeCli()
    const { home, before } = await seedHome(fixture)
    try {
      const installed = await runBuilt(cli.root, ["integrations", "install", fixture.host], {
        HOME: home
      })
      expect(installed.exitCode, installed.stderr).toBe(0)
      const report = envelopeOf(installed)
      expect(report.type).toBe("integrations.report")
      expect(reportRow(report.data as Report, fixture.host).changed).toBe(true)

      for (const relative of fixture.writes) {
        expect(await exists(join(home, relative)), `${fixture.host}: ${relative}`).toBe(true)
      }
      const receipt = JSON.parse(await readFile(receiptPath(home, fixture.host), "utf8")) as Receipt
      expect(receipt.host).toBe(fixture.host)
      const skills = receipt.entries.filter((entry) => entry.role === "skill")
      for (const entry of skills) expect(await exists(entry.path), entry.path).toBe(true)

      const removed = await runBuilt(cli.root, ["integrations", "uninstall", fixture.host], {
        HOME: home
      })
      expect(removed.exitCode, removed.stderr).toBe(0)
      for (const [relative, content] of before) {
        const now = await readFile(join(home, relative), "utf8")
        expect(sha256(now), `${fixture.host}: ${relative}: ${firstDifference(content, now)}`).toBe(
          sha256(content)
        )
      }
      for (const entry of skills) {
        expect(await exists(entry.path), entry.path).toBe(false)
        expect(await exists(dirname(entry.path)), dirname(entry.path)).toBe(false)
      }
      expect(await exists(receiptPath(home, fixture.host))).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
      await cli.cleanup()
    }
  })
})
