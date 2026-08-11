import { describe, expect, it } from "vitest"

import { buildManifest, COMMAND_NAMES, COMMANDS, GLOBAL_FLAGS } from "../src/commands.js"
import { CONFIG_VARS } from "../src/config.js"
import {
  API_VERSION,
  ERROR_CODES,
  EXIT_OK,
  EXIT_USAGE,
  fail,
  nearest,
  RESPONSE_TYPES,
  render,
  succeed
} from "../src/envelope.js"
import { SUGGESTIONS } from "../src/errors.js"
import { parseArgv, run } from "../src/run.js"

const parse = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>

describe("argv parsing", () => {
  it("accepts --flag value, --flag=value, and bare booleans", () => {
    const parsed = parseArgv(["search", "vip drain", "--repo", "/tmp/memhtml", "--dense"])
    expect(parsed.command).toBe("search")
    expect(parsed.positional).toEqual(["vip drain"])
    expect(parsed.flags.get("repo")).toEqual(["/tmp/memhtml"])
    expect(parsed.flags.get("dense")).toEqual([true])
  })

  it("treats a missing command as empty rather than throwing", () => {
    expect(parseArgv([]).command).toBe("")
  })

  it("keeps every occurrence of a repeatable flag", () => {
    // The load-bearing case: a scalar map would silently keep only `person:sanju`, and a write with
    // two entities would store one.
    const parsed = parseArgv(["write", "--entity", "service:checkout", "--entity", "person:sanju"])
    expect(parsed.flags.get("entity")).toEqual(["service:checkout", "person:sanju"])
  })

  it("reads --no-embed as an explicit false, the only way to turn off a true default", () => {
    expect(parseArgv(["index", "rebuild", "--no-embed"]).flags.get("embed")).toEqual([false])
  })

  it("matches a two-word command greedily and leaves the rest positional", () => {
    const parsed = parseArgv(["trace", "search", "rollback order"])
    expect(parsed.command).toBe("trace search")
    expect(parsed.positional).toEqual(["rollback order"])
  })

  it("does not fold a one-word command into a compound", () => {
    expect(parseArgv(["search", "index"]).command).toBe("search")
  })
})

describe("envelope", () => {
  it("stamps the api version on both shapes", () => {
    expect(succeed("cli.manifest", {}).apiVersion).toBe(API_VERSION)
    expect(fail("ERR_UNKNOWN", "boom").apiVersion).toBe(API_VERSION)
  })

  it("holds no duplicate error code or response type", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    expect(new Set(RESPONSE_TYPES).size).toBe(RESPONSE_TYPES.length)
  })

  it("drops nulls and indentation under --dense", () => {
    const payload = succeed("memory.detail", { path: "/a.html", workspace: null, tags: [] })
    expect(render(payload, true)).toBe(
      '{"apiVersion":"1","type":"memory.detail","data":{"path":"/a.html","tags":[]}}'
    )
    expect(render(payload, false)).toContain("\n")
  })

  it("suggests near misses and stays silent on a distant word", () => {
    expect(nearest("manifets", ["manifest", "search"])).toContain("manifest")
    expect(nearest("zzzzzzzzzzzz", ["manifest", "search"])).toEqual([])
  })
})

describe("manifest", () => {
  it("is derived from the command table rather than hand-written", () => {
    const manifest = buildManifest()
    expect(manifest.commands.map((command) => command.name)).toEqual(
      COMMANDS.map((command) => command.name)
    )
    expect(manifest.globalFlags).toEqual(GLOBAL_FLAGS)
    expect(manifest.errorCodes).toEqual(ERROR_CODES)
  })

  it("declares at least one response type per command", () => {
    for (const command of COMMANDS) {
      expect(command.responseTypes.length).toBeGreaterThan(0)
    }
  })

  it("declares only response types the envelope knows", () => {
    const known = new Set<string>(RESPONSE_TYPES)
    for (const type of buildManifest().responseTypes) {
      expect(known.has(type)).toBe(true)
    }
  })

  it("covers every command in design §8's tree", () => {
    // The command tree, verbatim from design.md §8. Pinned as a set so a command dropped from the
    // table fails here rather than becoming a surface an agent discovers is missing.
    const required = [
      "manifest",
      "write",
      "read",
      "search",
      "recall",
      "correct",
      "link",
      "archive",
      "list",
      "index rebuild",
      "index update",
      "index status",
      "trace index",
      "trace search",
      "trace links",
      "sleep run",
      "sleep resume",
      "sleep review",
      "sleep merge",
      "sleep status",
      "serve mcp",
      /**
       * The task family, past design §8's tree: `task` is the 10th memory type and it is
       * default-excluded from search, dedup, and every sleep phase, so these three commands are the
       * only surface the working set has. Pinned as names for the same reason the rest are — a
       * dropped one becomes a surface an agent discovers is missing.
       */
      "task add",
      "task status",
      "task list"
    ]
    const names = new Set(COMMANDS.map((command) => command.name))
    for (const name of required) expect(names.has(name)).toBe(true)
  })

  it("names every command's flags and args, and every documented variable", () => {
    const manifest = buildManifest()
    // What `--dense` is for: an agent reads the manifest once and knows the whole surface, so every
    // entry must carry its own arguments, flags, and response types rather than a name alone.
    for (const command of manifest.commands) {
      expect(command.summary.length).toBeGreaterThan(10)
      expect(Array.isArray(command.args)).toBe(true)
      expect(Array.isArray(command.flags)).toBe(true)
      expect(command.responseTypes.length).toBeGreaterThan(0)
      expect(command.supportsJson).toBe(true)
      expect(command.supportsDense).toBe(true)
      for (const flag of command.flags) expect(flag.description.length).toBeGreaterThan(5)
      for (const arg of command.args) expect(arg.description.length).toBeGreaterThan(5)
    }
    expect(manifest.config).toEqual(CONFIG_VARS)
    for (const name of [
      "MEMHTML_ROOT",
      "MEMHTML_TRACE_ROOT",
      "MEMHTML_AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      // Read by the serve supervisor rather than the store, but an operator running a split
      // deployment learns the surface from the manifest and nowhere else.
      "MEMHTML_MCP_BIN"
    ]) {
      expect(manifest.config.some((variable) => variable.name === name)).toBe(true)
    }
  })
})

describe("memhtml manifest", () => {
  /**
   * Every assertion here runs with NO layer argument, which is the point: `manifest` must answer on
   * a machine with no repo, no database, and no credentials. It is the first call an agent makes and
   * it is the liveness check, so building the app graph first would make the self-description
   * conditional on the thing it describes already working.
   */
  it("emits the cli.manifest envelope and exits 0", async () => {
    const result = await run(["manifest"])
    expect(result.exitCode).toBe(EXIT_OK)
    const body = parse(result.stdout)
    expect(body.type).toBe("cli.manifest")
    expect(body.apiVersion).toBe("1")
  })

  it("emits one line under --dense", async () => {
    const result = await run(["manifest", "--dense"])
    expect(result.stdout).not.toContain("\n")
    expect(parse(result.stdout).type).toBe("cli.manifest")
  })

  it("answers a bare invocation and `help` with the manifest", async () => {
    for (const argv of [[], ["help"]]) {
      const result = await run(argv)
      expect(result.exitCode).toBe(EXIT_OK)
      expect(parse(result.stdout).type).toBe("cli.manifest")
    }
  })

  it("lists every command with args, flags, response types, and the error codes under --dense", async () => {
    const result = await run(["manifest", "--dense"])
    const data = parse(result.stdout).data as ReturnType<typeof buildManifest>
    expect(data.commands).toHaveLength(COMMANDS.length)
    expect(data.errorCodes).toEqual(ERROR_CODES)
    expect(data.responseTypes.length).toBeGreaterThan(0)
    // Null-stripping must not have eaten a command's empty arg list into absence: an agent reading
    // `args: undefined` cannot tell "takes none" from "not described".
    for (const command of data.commands) {
      expect(command.args).toBeDefined()
      expect(command.flags).toBeDefined()
    }
  })
})

describe("error envelopes", () => {
  it("suggests the nearest command for a typo and exits 2", async () => {
    const result = await run(["manifets"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_UNKNOWN_COMMAND")
    expect(body.suggestions).toContain("manifest")
  })

  it("suggests across the whole flattened surface", async () => {
    const result = await run(["searh"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(parse(result.stdout).suggestions).toContain("search")
  })

  it("suggests a COMPOUND name from a typo in either of its words", async () => {
    /**
     * The flat table exists so a typo in the noun and a typo in the verb both get a candidate, and
     * that only works if the distance is measured against the whole typed invocation: `parseArgv`
     * matches a compound name exactly, so a misspelling leaves `command` holding the first token
     * alone — and `"index"` scores `init` at 2 while `index rebuild` scores 8, handing the operator a
     * command they did not ask for.
     */
    for (const [argv, expected] of [
      [["indx", "rebuild"], "index rebuild"],
      [["index", "rebiuld"], "index rebuild"],
      [["trace", "serch"], "trace search"],
      [["task", "lst"], "task list"],
      [["tsk", "list"], "task list"]
    ] as ReadonlyArray<readonly [ReadonlyArray<string>, string]>) {
      const result = await run(argv)
      expect(result.exitCode).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code).toBe("ERR_UNKNOWN_COMMAND")
      expect(body.suggestions, argv.join(" ")).toContain(expected)
      // The error names what the operator actually typed, both words — not the first token alone.
      expect(body.error).toBe(`unknown command: ${argv.join(" ")}`)
    }
  })

  it("offers no candidate for a word near nothing, rather than the least-bad one", async () => {
    const result = await run(["zzzzzzzzzzzz", "qqqqqqqqqqqq"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(parse(result.stdout).suggestions).toEqual([])
  })

  it("refuses an unknown flag rather than ignoring it", async () => {
    const result = await run(["manifest", "--densee"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.suggestions).toContain("dense")
  })

  it("names the missing argument and shows the shape of the call", async () => {
    const result = await run(["read"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_MISSING_ARGUMENT")
    expect(body.error).toContain("path")
    expect(body.suggestions).toEqual(["memhtml read <path>"])
  })

  it("names the missing required flag", async () => {
    const result = await run(["write", "--title", "x", "--claim", "y"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_MISSING_ARGUMENT")
    expect(body.error).toContain("--type")
  })

  it("refuses a value outside a closed vocabulary before touching a database", async () => {
    // No layer is provided, so this MUST be answered by validation alone: reaching a service here
    // would try to open a real repo, which is exactly the regression this pins.
    const result = await run(["write", "--title", "x", "--claim", "y", "--type", "epesodic"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.suggestions).toContain("episodic")
  })

  it("refuses `arc`, which is a storage type but not a writable one", async () => {
    const result = await run(["write", "--title", "x", "--claim", "y", "--type", "arc"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(parse(result.stdout).code).toBe("ERR_INVALID_FLAG")
  })

  describe("exactly one of --claim / --article-html", () => {
    /**
     * The rule the flag table cannot express. `FlagSpec` carries one `required: boolean` and no
     * notion of a conditional, so `--claim` no longer says `required: true` and the pairing is
     * enforced in `validate` — which is also WHY it is enforced there: `validate`'s return becomes
     * exit 2, while the same refusal raised inside a dispatch arm would travel through `failureFor`
     * and reach a shell caller as exit 1. Supplying the wrong flags is a usage error.
     *
     * No layer is provided anywhere below, deliberately. Every one of these MUST be answered by
     * validation alone — reaching a service would open a real repo, and an agent that mispaired the
     * flags would pay a database round-trip to be told so.
     */
    const cases = [
      ["write", ["write", "--title", "x", "--type", "semantic"]],
      ["correct", ["correct", "areas/inbox/a.html", "--title", "x"]]
    ] as const

    it("refuses BOTH with ERR_INVALID_FLAG: a flag present but unusable as given", async () => {
      for (const [name, base] of cases) {
        const result = await run([
          ...base,
          "--claim",
          "y",
          "--article-html",
          "<p><mark>C.</mark></p>"
        ])
        expect(result.exitCode, name).toBe(EXIT_USAGE)
        const body = parse(result.stdout)
        expect(body.code, name).toBe("ERR_INVALID_FLAG")
        // The prose names the RULE, not just the offending flag: an agent that reads only `error`
        // still learns which of the two to drop.
        expect(body.error, name).toContain("exactly one of --claim or --article-html")
        expect(body.suggestions, name).toEqual([
          `memhtml ${name} --claim <sentence>`,
          `memhtml ${name} --article-html '<p>…</p>'`
        ])
      }
    })

    it("refuses NEITHER with ERR_MISSING_ARGUMENT, the code an absent claim already returned", async () => {
      // Dropping `required: true` from `--claim` must not silently make a claimless write legal, and
      // the code must not change for the case that used to hit the required-flag check — a client
      // branching on `ERR_MISSING_ARGUMENT` for a forgotten claim keeps working.
      for (const [name, base] of cases) {
        const result = await run([...base])
        expect(result.exitCode, name).toBe(EXIT_USAGE)
        const body = parse(result.stdout)
        expect(body.code, name).toBe("ERR_MISSING_ARGUMENT")
        expect(body.error, name).toContain("exactly one of --claim or --article-html")
      }
    })

    it("holds the rule ONLY on write and correct, not on every command with a --claim", () => {
      // `task add` has a `--claim` that defaults to `--title` and no `--article-html` at all. A rule
      // applied to every command carrying a `--claim` would break it, so the scoping is the test.
      const taskAdd = COMMANDS.find((command) => command.name === "task add")
      expect(taskAdd?.flags.some((flag) => flag.name === "claim")).toBe(true)
      expect(taskAdd?.flags.some((flag) => flag.name === "article-html")).toBe(false)
    })

    it("states the rule in BOTH flag descriptions, so the manifest carries it", () => {
      /**
       * The manifest is how an agent learns the surface, and `FlagSpec` cannot express a conditional
       * — so with `required: true` gone from `--claim` there is nothing structural left saying the
       * two flags are paired. The descriptions are the only carrier, and `memhtml manifest` and
       * `memhtml agents-doc` both read them straight off this table.
       */
      for (const name of ["write", "correct"] as const) {
        const spec = COMMANDS.find((command) => command.name === name)
        const claim = spec?.flags.find((flag) => flag.name === "claim")
        const article = spec?.flags.find((flag) => flag.name === "article-html")
        expect(article, name).toBeDefined()
        // Conditionally required now, so the table must NOT claim it is unconditionally required.
        expect(claim?.required, name).toBeUndefined()
        expect(claim?.description, name).toContain("Exactly one of --claim or --article-html")
        expect(article?.description, name).toContain("Exactly one of --claim or --article-html")
        // And the caller's format contract, since the store refuses a violation rather than the CLI.
        expect(article?.description, name).toContain("<mark>")
        expect(article?.description, name).toContain("<time datetime>")
      }
    })
  })

  it("keeps stdout parseable on failure", async () => {
    const result = await run(["nope"])
    expect(() => parse(result.stdout)).not.toThrow()
  })
})

describe("suggestions name real commands", () => {
  /**
   * The drift gate on hand-written suggestions.
   *
   * A suggestion is part of the contract — an agent runs it — so a suggestion naming a command the
   * table no longer holds is a broken contract that nothing else fails on. `errors.ts` cannot check
   * this itself: importing `commands.js` there closes the cycle `commands.ts` → `operations.ts` →
   * `errors.ts` and leaves `AUTHORABLE_RELS` undefined in `commands.ts`'s module body. So the check
   * lives here, where importing both is free.
   *
   * Validated through `parseArgv` rather than a prefix match against `COMMAND_NAMES`, because the
   * greedy compound match is the rule that decides what `memhtml eval discriminate` actually invokes
   * (`run.ts:48`). Reimplementing that rule here would let the test and the binary disagree; running
   * the binary's own parser cannot.
   */
  const commandOf = (suggestion: string): string =>
    parseArgv(suggestion.split(" ").slice(1)).command

  /** Only the `memhtml …` suggestions are commands. The rest are prose, deliberately. */
  const memhtmlSuggestions = Object.entries(SUGGESTIONS).flatMap(([tag, build]) =>
    build({ _tag: tag, path: "areas/inbox/a.html", existingPath: "areas/inbox/b.html" })
      .filter((suggestion) => suggestion.startsWith("memhtml "))
      .map((suggestion) => [tag, suggestion] as const)
  )

  it("resolves every `memhtml …` suggestion to a command in the table", () => {
    const names = new Set(COMMAND_NAMES)
    expect(memhtmlSuggestions.length).toBeGreaterThan(0)
    for (const [tag, suggestion] of memhtmlSuggestions) {
      expect(names.has(commandOf(suggestion)), `${tag}: ${suggestion}`).toBe(true)
    }
  })

  it("gives every tag at least one suggestion, so an emptied arm cannot pass vacuously", () => {
    // Without this, deleting a suggestion's body would satisfy the walk above by having nothing to
    // walk — the failure mode a "for each, assert valid" test always has.
    for (const [tag, build] of Object.entries(SUGGESTIONS)) {
      expect(build({ _tag: tag }).length, tag).toBeGreaterThan(0)
    }
  })

  it("suggests `memhtml eval discriminate` without `--json`", () => {
    /**
     * The specific regression, pinned by name. `--json` is a GLOBAL flag defaulting to true
     * (`commands.ts:36-42`), so naming it in a suggestion added a token that carried no meaning and
     * gave the string a second way to go stale. The walk above would not catch its return — the
     * command name parses either way — so the flag form is asserted directly.
     */
    const suggestions = SUGGESTIONS.DiscriminationFailed?.({ _tag: "DiscriminationFailed" }) ?? []
    expect(suggestions).toContain("memhtml eval discriminate")
    for (const suggestion of suggestions) expect(suggestion).not.toContain("--json")
  })
})
