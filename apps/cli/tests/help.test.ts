import { access, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { renderAgentsDoc } from "../src/agents-doc.js"
import { buildManifest, COMMANDS, type CommandSpec, GLOBAL_FLAGS } from "../src/commands.js"
import { REFUSE_ENV_ROOT_VAR } from "../src/config.js"
import { EXIT_OK, EXIT_USAGE, RESPONSE_TYPES } from "../src/envelope.js"
import {
  type helpData,
  renderCommandHelp,
  seeAlsoOf,
  USAGE_ERROR_CODES,
  usageOf
} from "../src/help.js"
import { parseArgv, run, validate } from "../src/run.js"

const parse = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>

/** stdout is a pipe: what a test runner, a shell pipeline, and an agent all are. */
const piped = (argv: ReadonlyArray<string>) => run(argv, undefined, undefined, false)

/**
 * The `MEMHTML_ROOT` this run started with, read once before any test overrides it. `vitest.config.ts`
 * pins it to a throwaway under the OS temp dir, and the pin is asserted below rather than assumed.
 */
const PINNED_ROOT = process.env.MEMHTML_ROOT
/** stdout is a terminal: a person is reading. */
const terminal = (argv: ReadonlyArray<string>) => run(argv, undefined, undefined, true)

const specOf = (name: string): CommandSpec => {
  const spec = COMMANDS.find((command) => command.name === name)
  if (spec === undefined) throw new Error(`${name} is not in the table`)
  return spec
}

/**
 * A shell's word split, enough for the examples: whitespace separates, and a `"…"` or `'…'` segment
 * is one word with its quotes removed. No escapes, no expansion — an example needing either would be
 * an example an agent cannot copy.
 */
const shellWords = (line: string): ReadonlyArray<string> => {
  const words: Array<string> = []
  let current = ""
  let quote: string | undefined
  let inWord = false
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      inWord = true
      continue
    }
    if (char === " ") {
      if (inWord) words.push(current)
      current = ""
      inWord = false
      continue
    }
    current += char
    inWord = true
  }
  if (inWord) words.push(current)
  return words
}

describe("memhtml help <command>, piped", () => {
  /**
   * Every case here passes `stdoutIsTTY = false` explicitly rather than relying on vitest's stdout,
   * because the selection rule is the subject: a pipe gets the envelope, and the envelope is what
   * every other command emits, so an agent parses help the way it parses `search`.
   */
  it("answers the cli.help envelope for the spelled-out form, --help, and -h alike", async () => {
    const spec = specOf("search")
    for (const argv of [
      ["help", "search"],
      ["search", "--help"],
      ["search", "-h"],
      ["-h", "search"],
      ["--help", "search"]
    ]) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      const body = parse(result.stdout)
      expect(body.type, argv.join(" ")).toBe("cli.help")
      const data = body.data as ReturnType<typeof helpData>
      expect(data.name).toBe("search")
      expect(data.usage).toBe("memhtml search <query> [flags]")
      expect(data.flags).toEqual(spec.flags)
      expect(data.args).toEqual(spec.args)
      expect(data.examples).toEqual(spec.examples)
      expect(data.globalFlags).toEqual(GLOBAL_FLAGS)
      expect(data.usageErrorCodes).toEqual(USAGE_ERROR_CODES)
    }
  })

  it("describes a two-word command and names its siblings", async () => {
    for (const argv of [
      ["help", "index", "rebuild"],
      ["index", "rebuild", "--help"]
    ]) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      const data = parse(result.stdout).data as ReturnType<typeof helpData>
      expect(data.name).toBe("index rebuild")
      expect(data.usage).toBe("memhtml index rebuild [flags]")
      expect(data.seeAlso).toEqual(["index update", "index status"])
    }
  })

  it("carries the manifest's own entry for the command, so the two cannot disagree", async () => {
    const manifest = buildManifest()
    for (const spec of COMMANDS) {
      const result = await piped(["help", ...spec.name.split(" ")])
      expect(result.exitCode, spec.name).toBe(EXIT_OK)
      const data = parse(result.stdout).data as Record<string, unknown>
      const entry = manifest.commands.find((command) => command.name === spec.name)
      expect(entry).toBeDefined()
      // Every field of the manifest entry, verbatim: `usage`, `seeAlso`, `globalFlags`, and
      // `usageErrorCodes` are additions, never rewrites.
      expect(data).toMatchObject(entry as Record<string, unknown>)
      expect(data.usage).toBe(usageOf(spec))
      expect(data.seeAlso).toEqual(seeAlsoOf(spec))
    }
  })

  it("declares cli.help as a response type the envelope and the table both know", () => {
    expect(RESPONSE_TYPES).toContain("cli.help")
    expect(specOf("help").responseTypes).toContain("cli.help")
    expect(specOf("help").responseTypes).toContain("cli.manifest")
  })

  it("emits one line under --dense, and keeps an empty examples list rather than dropping it", async () => {
    // `--dense` strips nulls. A command with no examples must still say `examples: []`, or an agent
    // cannot tell "none" from "not described" — the same rule the manifest's `args: []` follows.
    const bare = COMMANDS.find((command) => command.examples === undefined)
    expect(bare).toBeDefined()
    const result = await piped(["help", ...(bare as CommandSpec).name.split(" "), "--dense"])
    expect(result.stdout).not.toContain("\n")
    const data = parse(result.stdout).data as ReturnType<typeof helpData>
    expect(data.examples).toEqual([])
  })
})

describe("memhtml help <command>, on a terminal", () => {
  it("prints Markdown that names the usage line, every flag, and every example", async () => {
    const spec = specOf("search")
    const result = await terminal(["search", "--help"])
    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.stdout.startsWith("# memhtml search")).toBe(true)
    expect(() => JSON.parse(result.stdout)).toThrow()
    expect(result.stdout).toContain("```\nmemhtml search <query> [flags]\n```")
    for (const flag of spec.flags) expect(result.stdout).toContain(`\`--${flag.name}\``)
    for (const flag of GLOBAL_FLAGS) expect(result.stdout).toContain(`\`--${flag.name}\``)
    for (const example of spec.examples ?? []) expect(result.stdout).toContain(example)
    expect(result.stdout).toContain('"type": "memory.hits"')
  })

  it("is the same Markdown the renderer returns, deterministic to the byte", async () => {
    const spec = specOf("index rebuild")
    const rendered = renderCommandHelp(spec)
    expect(rendered).toBe(renderCommandHelp(spec))
    const result = await terminal(["help", "index", "rebuild"])
    expect(`${result.stdout}\n`).toBe(rendered)
  })

  it("renders every command without throwing and names each of its flags and arguments", () => {
    for (const spec of COMMANDS) {
      const doc = renderCommandHelp(spec)
      expect(doc.startsWith(`# memhtml ${spec.name}\n`), spec.name).toBe(true)
      expect(doc).toContain(spec.summary)
      for (const flag of spec.flags) expect(doc, spec.name).toContain(`\`--${flag.name}\``)
      for (const arg of spec.args) expect(doc, spec.name).toContain(arg.name)
    }
  })

  it("obeys --json over the terminal check, so a script never gets prose by accident", async () => {
    for (const argv of [
      ["help", "search", "--json"],
      ["search", "--help", "--json"]
    ]) {
      const result = await terminal(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      expect(parse(result.stdout).type, argv.join(" ")).toBe("cli.help")
    }
  })
})

describe("memhtml help with no command", () => {
  it("is the manifest envelope when piped", async () => {
    for (const argv of [["help"], ["--help"], ["-h"], ["help", "--json"]]) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      expect(parse(result.stdout).type, argv.join(" ")).toBe("cli.manifest")
    }
  })

  it("is the agent doc's Markdown on a terminal, and the manifest again under --json", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const result = await terminal(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      expect(`${result.stdout}\n`, argv.join(" ")).toBe(renderAgentsDoc())
    }
    const json = await terminal(["help", "--json"])
    expect(parse(json.stdout).type).toBe("cli.manifest")
  })

  it("leaves a bare `memhtml` as the manifest envelope on a terminal too", async () => {
    // The liveness check. A bare invocation is what a script probes with, and the guide promises it
    // the manifest; only an explicit ask for help gets prose.
    const result = await terminal([])
    expect(parse(result.stdout).type).toBe("cli.manifest")
  })

  it("describes help itself under `help --help`", async () => {
    const result = await piped(["help", "--help"])
    expect(result.exitCode).toBe(EXIT_OK)
    const data = parse(result.stdout).data as ReturnType<typeof helpData>
    expect(data.name).toBe("help")
    expect(data.usage).toBe("memhtml help [command]... [flags]")
  })
})

describe("help's refusals", () => {
  it("answers ERR_UNKNOWN_COMMAND for a command that does not exist, in both spellings", async () => {
    for (const argv of [
      ["help", "serch"],
      ["serch", "--help"]
    ]) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code, argv.join(" ")).toBe("ERR_UNKNOWN_COMMAND")
      expect(body.suggestions, argv.join(" ")).toContain("search")
    }
  })

  it("keeps the caller's words in a typo'd two-word command, so the suggestion is the real name", async () => {
    // `memhtml index rebuil --help` is the natural recovery move after a typo. It must answer at least
    // as well as the typo alone: the error names both words and the suggestions include the command.
    for (const argv of [
      ["index", "rebuil", "--help"],
      ["help", "index", "rebuil"]
    ]) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code, argv.join(" ")).toBe("ERR_UNKNOWN_COMMAND")
      expect(body.error, argv.join(" ")).toBe("unknown command: index rebuil")
      expect(body.suggestions, argv.join(" ")).toContain("index rebuild")
    }
  })

  it("answers a noun alone with the noun's commands", async () => {
    // `nearest()` cannot reach `index rebuild` from `index` by edit distance, so without this branch
    // the ask for a family answered `init`.
    const result = await piped(["help", "index"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_UNKNOWN_COMMAND")
    expect(body.suggestions).toEqual(["index rebuild", "index update", "index status"])
  })

  it("refuses a surplus word after a real command as ERR_UNEXPECTED_ARGUMENT, naming the word", async () => {
    for (const [argv, known] of [
      [["help", "search", "extra"], "search"],
      [["help", "index", "rebuild", "now"], "index rebuild"]
    ] as ReadonlyArray<readonly [ReadonlyArray<string>, string]>) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code, argv.join(" ")).toBe("ERR_UNEXPECTED_ARGUMENT")
      expect(body.error, argv.join(" ")).toContain(`"${argv.at(-1)}"`)
      expect(body.suggestions, argv.join(" ")).toEqual([`memhtml help ${known}`])
    }
  })

  it("refuses `--help false` in the flag form exactly as the spelled-out form does", async () => {
    // A boolean flag does not consume the next token, so `--help false` is `help: true` plus a stray
    // `false`: the INVERSE of the ask. The parser records the stray; the help arm must not drop it.
    for (const argv of [
      ["search", "--help", "false"],
      ["help", "--help", "false"]
    ]) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      expect(parse(result.stdout).code, argv.join(" ")).toBe("ERR_INVALID_FLAG")
    }
  })

  it("lets --help win over every other flag on the line", async () => {
    // A person adding `--help` to a half-typed call wants the table, not a refusal of the half.
    const result = await piped(["search", "--type", "semantic", "--limit", "5", "--help"])
    expect(result.exitCode).toBe(EXIT_OK)
    expect((parse(result.stdout).data as ReturnType<typeof helpData>).name).toBe("search")
  })

  it("still refuses a flag help itself does not take, in the spelled-out form", async () => {
    const result = await piped(["help", "search", "--limit", "5"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.suggestions).toContain("memhtml help help")
  })
})

describe("the vitest config's throwaway MEMHTML_ROOT", () => {
  it("is in force: under the temp dir, never ~/memhtml, both network edges off, the flag on", () => {
    /**
     * Issue #144. A test calling `run()` in-process without `--repo` or a layer resolves its repo
     * from the environment, so on a developer machine it reaches the developer's store. The config
     * pins the variable to a throwaway so that path can only ever be a temp directory. A config
     * change that dropped the pin would fail here, which is what stops it being removed in silence.
     */
    expect(PINNED_ROOT).toBeDefined()
    expect(PINNED_ROOT?.startsWith(join(tmpdir(), "memhtml-vitest-root-")), PINNED_ROOT).toBe(true)
    expect(PINNED_ROOT).not.toBe(join(homedir(), "memhtml"))
    expect(process.env.MEMHTML_EMBED).toBe("off")
    expect(process.env.MEMHTML_LLM).toBe("off")
    expect(process.env[REFUSE_ENV_ROOT_VAR]).toBe("1")
  })
})

describe("help has no side effects", () => {
  const roots: Array<string> = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  /** The `help` command itself, or any command carrying `--help` / `-h`. */
  const helpShaped = (argv: ReadonlyArray<string>): boolean => {
    const parsed = parseArgv(argv)
    return parsed.command === "help" || parsed.flags.get("help")?.at(-1) === true
  }

  /**
   * Every help-shaped invocation: the flag form in its three spellings, the spelled-out form with
   * and without a target, and every example in the COMMANDS table that asks for help. The examples
   * come from the table rather than being restated, so a new help example is covered the day it
   * lands. `search` and `index rebuild` are the targets because they are the two commands that most
   * obviously need the layer when they RUN, and `index rebuild` is the one that rewrote a live index
   * in the incident behind issue #144.
   */
  const invocations: ReadonlyArray<ReadonlyArray<string>> = [
    ["help"],
    ["-h"],
    ["--help"],
    ["help", "search"],
    ["search", "--help"],
    ["search", "-h"],
    ["index", "rebuild", "--help"],
    ...COMMANDS.flatMap((spec) => spec.examples ?? [])
      .map((example) => shellWords(example).slice(1))
      .filter(helpShaped)
  ]

  it("covers the table's help examples, so the case below cannot pass vacuously", () => {
    expect(invocations.length).toBeGreaterThan(7)
  })

  it("opens nothing: no index.db appears under $MEMHTML_ROOT, under --repo, or under the run's pinned root", async () => {
    /**
     * `layerApp` creates `<root>/.memhtml/index.db` on its way up, so a help that built the layer
     * would scaffold a store as a side effect of asking a question. Three roots are probed, because
     * each is a door a help that stopped intercepting would walk through: the `MEMHTML_ROOT` this
     * test sets, a `--repo` on the line, and the throwaway the whole run is pinned to.
     *
     * Every invocation runs first and the filesystem is asserted before the exit codes, so a
     * regression reads as the side effect it is rather than as a wrong exit code that happens to
     * have one.
     */
    const parent = await mkdtemp(join(tmpdir(), "memhtml-help-"))
    roots.push(parent)
    const envRoot = join(parent, "env-root")
    const repoRoot = join(parent, "repo-root")
    const before = process.env.MEMHTML_ROOT
    process.env.MEMHTML_ROOT = envRoot
    const outcomes: Array<readonly [string, number]> = []
    try {
      for (const argv of invocations) {
        for (const full of [argv, [...argv, "--repo", repoRoot]]) {
          const result = await piped(full)
          outcomes.push([full.join(" "), result.exitCode])
        }
      }
    } finally {
      if (before === undefined) delete process.env.MEMHTML_ROOT
      else process.env.MEMHTML_ROOT = before
    }
    for (const root of [envRoot, repoRoot, ...(PINNED_ROOT === undefined ? [] : [PINNED_ROOT])]) {
      await expect(access(join(root, ".memhtml", "index.db")), root).rejects.toThrow()
    }
    // The two roots this test named were never created at all, not merely left without a database.
    await expect(access(envRoot)).rejects.toThrow()
    await expect(access(repoRoot)).rejects.toThrow()
    for (const [line, exitCode] of outcomes) expect(exitCode, line).toBe(EXIT_OK)
  })
})

describe("the examples in the table", () => {
  /**
   * The drift gate on hand-written examples. An example is the one line of help an agent COPIES, so
   * one that names a renamed flag or a retired value is worse than none. Every example is split the
   * way a shell would and run through the binary's own parser and validator, with no layer, so a
   * usage error here is the same exit-2 envelope the copied line would produce.
   */
  const examples = COMMANDS.flatMap((spec) =>
    (spec.examples ?? []).map((example) => [spec.name, example] as const)
  )

  it("exist, so the gate below cannot pass vacuously", () => {
    expect(examples.length).toBeGreaterThan(5)
  })

  /** `help`'s own examples may be the `--help` spelling, which parses to the command being described. */
  const asksHelp = (argv: ReadonlyArray<string>): boolean =>
    parseArgv(argv).flags.get("help")?.at(-1) === true

  it("each invoke the command they sit beside and are one invocation, never a pipeline", () => {
    for (const [name, example] of examples) {
      expect(example.startsWith("memhtml "), example).toBe(true)
      expect(example, example).not.toContain("|")
      const argv = shellWords(example).slice(1)
      if (name === "help" && asksHelp(argv)) continue
      expect(parseArgv(argv).command, example).toBe(name)
    }
  })

  it("each pass the parser and the validator without a usage error", async () => {
    for (const [, example] of examples) {
      const argv = shellWords(example).slice(1)
      if (asksHelp(argv)) {
        // Help answers before `validate`, so the whole call is the check, and it needs no layer.
        expect((await piped(argv)).exitCode, example).toBe(EXIT_OK)
        continue
      }
      expect(validate(parseArgv(argv)), example).toBeUndefined()
    }
  })
})

describe("usage errors point at help", () => {
  it("ends every refusal of a known command with `memhtml help <command>`, as the LAST suggestion", async () => {
    // One case per validation arm, so a new arm that forgets the pointer fails here: unknown flag,
    // missing argument, missing flag, a flag from another command, surplus argument, closed
    // vocabulary (whose own suggestions can be empty), the either-or rule, --as-of, a stray boolean.
    for (const [argv, expected] of [
      [["read"], "memhtml help read"],
      [["write", "--title", "x", "--claim", "y"], "memhtml help write"],
      [["manifest", "--densee"], "memhtml help manifest"],
      [["list", "--status", "todo"], "memhtml help list"],
      [["read", "areas/inbox/a.html", "areas/inbox/b.html"], "memhtml help read"],
      [["task", "add", "--title", "x", "--status", "bogus"], "memhtml help task add"],
      [["write", "--title", "x", "--type", "semantic"], "memhtml help write"],
      [["search", "q", "--as-of", "yesterday"], "memhtml help search"],
      [["index", "rebuild", "--embed", "false"], "memhtml help index rebuild"]
    ] as ReadonlyArray<readonly [ReadonlyArray<string>, string]>) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect((body.suggestions as ReadonlyArray<string>).at(-1), argv.join(" ")).toBe(expected)
      // And the pointer is itself a valid call, so following it cannot produce a second error.
      const followed = await piped(expected.split(" ").slice(1))
      expect(followed.exitCode, expected).toBe(EXIT_OK)
    }
  })
})
