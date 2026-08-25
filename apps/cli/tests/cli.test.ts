import { isValidDatetime } from "@memhtml/html"
import { describe, expect, it } from "vitest"

import { buildManifest, COMMAND_NAMES, COMMANDS, GLOBAL_FLAGS } from "../src/commands.js"
import { CONFIG_VARS } from "../src/config.js"
import {
  API_VERSION,
  ERROR_CODES,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  fail,
  nearest,
  RESPONSE_TYPES,
  render,
  succeed
} from "../src/envelope.js"
import { codeFor, messageFor, SUGGESTIONS } from "../src/errors.js"
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

  it("never lets a bare boolean flag swallow the command that follows it", () => {
    /**
     * The regression: a parser that let any bare `--flag` consume the next non-`--` token turned
     * `memhtml --dense list` into `{dense: "list"}` with an EMPTY command — which is the manifest,
     * exit 0. An agent asking for a dense listing got the whole command table instead and nothing
     * failed. A boolean flag takes `--flag` or `--flag=value` only.
     */
    const parsed = parseArgv(["--dense", "list"])
    expect(parsed.command).toBe("list")
    expect(parsed.flags.get("dense")).toEqual([true])
  })

  it("still lets a string flag before the command consume its value", () => {
    // The other half of the rule: only a flag the table types `string` or `int` takes the next token.
    // `--repo <path>` before the command is a normal shell spelling and must keep working.
    const parsed = parseArgv(["--repo", "/tmp/memhtml", "list"])
    expect(parsed.command).toBe("list")
    expect(parsed.flags.get("repo")).toEqual(["/tmp/memhtml"])
  })

  it("never lets an UNDECLARED flag swallow the command that follows it", () => {
    /**
     * The same swallow, one step further out: an unknown flag has no declared type, so a parser that
     * asked only "is this boolean" let `memhtml --nope list` consume `list` as a value, leaving an
     * EMPTY command — the manifest, exit 0. An undeclared flag must leave the token positional so the
     * command reaches `validate`, which is the only place that can answer exit 2.
     */
    const parsed = parseArgv(["--nope", "list"])
    expect(parsed.command).toBe("list")
    expect(parsed.flags.get("nope")).toEqual([true])
  })

  it("keeps a boolean flag's space-separated value out of the flag and marks it stray", () => {
    /**
     * `--embed false` cannot be read as `embed: false`, because a boolean flag does not consume the
     * next token — so it parses as `embed: true` plus a positional `"false"`, which is the INVERSE of
     * the ask on a flag whose purpose is to turn work off. The pair is recorded so `validate` refuses
     * it; the spellings that work are `--embed=false` and `--no-embed`.
     */
    const parsed = parseArgv(["index", "rebuild", "--embed", "false"])
    expect(parsed.command).toBe("index rebuild")
    expect(parsed.flags.get("embed")).toEqual([true])
    expect(parsed.positional).toEqual(["false"])
    expect(parsed.strayBooleanValues).toEqual([["embed", "false"]])
  })

  it("leaves a non-value token after a boolean flag alone", () => {
    // Only the vocabulary `bool` interprets counts as a stray. `--dense list` is the `list` command,
    // and a rule reading "any token after a boolean flag" would refuse the shape the case above pins.
    expect(parseArgv(["--dense", "list"]).strayBooleanValues).toEqual([])
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

describe("the spec table's own invariants", () => {
  it("gives one flag name exactly one type across all commands", () => {
    /**
     * What `FLAG_TYPES` rests on. The parser has to know whether a flag consumes the next token
     * BEFORE it knows the command, so it keys a flag's type by name across the whole table. A name
     * declared `boolean` on one command and `string` on another would make that lookup answer for the
     * wrong command: the string flag would silently stop consuming its value, or the boolean one would
     * start eating the command name — with nothing else failing.
     *
     * Derived here from the table rather than imported from the parser, so this asserts the property
     * instead of restating the implementation.
     *
     * (Mutation: retyping `read`'s `session-id` to `boolean`, so `session-id` is `string` on `write`
     * and `boolean` here, fails this case with `session-id: boolean, string`.)
     */
    const types = new Map<string, Set<string>>()
    for (const flag of [...GLOBAL_FLAGS, ...COMMANDS.flatMap((command) => command.flags)]) {
      const seen = types.get(flag.name) ?? new Set<string>()
      seen.add(flag.type)
      types.set(flag.name, seen)
    }
    // The walk has something to walk: a table read as empty would satisfy every assertion below.
    expect(types.size).toBeGreaterThan(20)
    for (const [name, seen] of types) {
      expect([...seen].sort().join(", "), name).toBe([...seen][0])
    }
  })

  it("declares a repeatable argument only in last position", () => {
    // `validate` reads `args.at(-1)?.repeatable` to decide whether a surplus positional is legal, so a
    // repeatable argument anywhere else would be a variadic tail the check cannot see.
    for (const command of COMMANDS) {
      for (const [position, arg] of command.args.entries()) {
        if (arg.repeatable !== true) continue
        expect(position, `${command.name} ${arg.name}`).toBe(command.args.length - 1)
      }
    }
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

  it("refuses a flag that belongs to another command, pointing at the commands that take it", async () => {
    /**
     * The regression: validation against the UNION of every command's flags let any flag that was
     * valid anywhere be silently ignored everywhere. `memhtml list --status todo` (the caller meant
     * `task list`) returned an unfiltered listing that looked filtered, exit 0, and nothing failed.
     * Per-command validation makes it exit 2, and the suggestions name where the flag is real.
     */
    const result = await run(["list", "--status", "todo"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain("--status is not a flag of list")
    const suggestions = body.suggestions as ReadonlyArray<string>
    expect(suggestions.length).toBeGreaterThan(0)
    for (const suggestion of suggestions) expect(suggestion).toContain("--status")
  })

  it("refuses an unknown flag that precedes the command, rather than eating the command", async () => {
    /**
     * The regression: `--nope` has no declared type, so the parser consumed `list` as its value. The
     * command came out EMPTY, which is the manifest at exit 0 — an agent asking for a listing got the
     * command table and nothing failed. No layer is provided, so this MUST be answered by validation.
     */
    const result = await run(["--nope", "list"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toBe("unknown flag: --nope")
  })

  describe("a boolean flag given a space-separated value", () => {
    /**
     * The silent inversion. A boolean flag does not consume the next token, so `--embed false` is
     * `embed: true` plus a stray positional: a caller asking to SKIP embedding got embedding ON, from
     * a call that exited 0. Every boolean flag on a command has the same shape, so the cases are the
     * table's own booleans rather than a hand-picked pair.
     *
     * No layer is provided anywhere below — a wrong answer this shape must be refused before any
     * service is built, and reaching one would embed on a real repo.
     *
     * (Mutation: dropping the `strayBooleanFlags` call from `validate` leaves each of these to the
     * surplus-positional check, which answers `ERR_UNEXPECTED_ARGUMENT` — still exit 2, and still a
     * refusal, but naming the stray token rather than the flag that produced it. Observed:
     * `expected 'ERR_UNEXPECTED_ARGUMENT' to be 'ERR_INVALID_FLAG'` on all seven. The two checks are
     * deliberately both here: either one alone kills the silent inversion, and the pair decides which
     * mistake the message names.)
     */
    const cases = [
      ["index rebuild", ["index", "rebuild", "--embed", "false"], "embed"],
      ["task list", ["task", "list", "--detected", "false"], "detected"],
      ["doctor", ["doctor", "--fix", "no"], "fix"],
      ["agents-doc", ["agents-doc", "--check", "0"], "check"],
      ["sleep run", ["sleep", "run", "--deep", "false"], "deep"],
      ["sleep run", ["sleep", "run", "--dry-run", "true"], "dry-run"],
      ["sleep review", ["sleep", "review", "sleep/2026-08-24", "--diff", "1"], "diff"]
    ] as const

    it.each(cases)("refuses it on %s", async (_name, argv, flag) => {
      const result = await run([...argv])
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code, argv.join(" ")).toBe("ERR_INVALID_FLAG")
      expect(body.error, argv.join(" ")).toContain(`--${flag} is a boolean flag`)
      // The suggestions are the two spellings that DO set a boolean, so the caller's next call works.
      const suggestions = body.suggestions as ReadonlyArray<string>
      expect(
        suggestions.some((line) => line.includes(`--${flag}=`)),
        argv.join(" ")
      ).toBe(true)
      expect(
        suggestions.some((line) => line.includes(`--no-${flag}`)),
        argv.join(" ")
      ).toBe(true)
    })

    it("still accepts the two spellings that work", () => {
      // `--flag=value` and `--no-flag` reach `bool` as real values, so the refusal above is about the
      // space and nothing else.
      expect(parseArgv(["index", "rebuild", "--embed=false"]).flags.get("embed")).toEqual(["false"])
      expect(parseArgv(["index", "rebuild", "--no-embed"]).flags.get("embed")).toEqual([false])
      expect(parseArgv(["index", "rebuild", "--embed=false"]).strayBooleanValues).toEqual([])
    })
  })

  describe("a positional the command does not declare", () => {
    /**
     * The other half of the same hole: `validate` checked only for MISSING arguments, so a surplus one
     * was dropped in silence — `memhtml read a.html b.html` read ONE memory and said nothing about the
     * second, and every mis-spelled boolean value left one behind.
     *
     * (Mutation: dropping the `surplusArgs` call from `validate` drops the extra token instead —
     * `read a.html b.html` reaches the service and answers for the FIRST path alone, exit 1 here
     * because the fixture path does not exist, and `status a.html` answers exit 0 with a report the
     * argument had no part in. Observed: `expected 1 to be 2` and `expected +0 to be 2`.)
     */
    it("refuses it, naming the token and the shape the command takes", async () => {
      const result = await run(["read", "areas/inbox/a.html", "areas/inbox/b.html"])
      expect(result.exitCode).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code).toBe("ERR_UNEXPECTED_ARGUMENT")
      expect(body.error).toContain('"areas/inbox/b.html"')
      expect(body.error).toContain("read takes 1: path")
      expect(body.suggestions).toContain("memhtml read <path>")
    })

    it("refuses it on a command that declares no argument at all", async () => {
      const result = await run(["status", "areas/inbox/a.html"])
      expect(result.exitCode).toBe(EXIT_USAGE)
      expect(parse(result.stdout).error).toContain("status takes no arguments")
    })

    it("allows the variadic tail the table declares", () => {
      /**
       * `memhtml reinforce a.html b.html` is the shape an agent reaching for `memory_reinforce`'s
       * `paths` array writes, so the check must not refuse it. The exemption is declared in the table
       * (`repeatable: true`) rather than listed in `validate`, which is what the manifest publishes.
       */
      const spec = COMMANDS.find((command) => command.name === "reinforce")
      expect(spec?.args.at(-1)?.repeatable).toBe(true)
    })

    it("allows the `-` stdin marker on the two commands that document it", async () => {
      /**
       * `memhtml apply -` and `memhtml exec -` name stdin, and neither declares a positional, so a
       * blanket surplus check would refuse the spelling their own flag descriptions promise. Driven
       * through `run` with an empty stdin, whose refusal is a DIFFERENT usage error — the point is that
       * it is not `ERR_UNEXPECTED_ARGUMENT`.
       */
      for (const argv of [
        ["apply", "-"],
        ["exec", "-"]
      ]) {
        const result = await run(argv, undefined, () => Promise.resolve(""))
        expect(parse(result.stdout).code, argv.join(" ")).not.toBe("ERR_UNEXPECTED_ARGUMENT")
      }
    })
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

  describe("--as-of, which SQL compares as a string", () => {
    /**
     * No layer is provided anywhere below, deliberately: each of these MUST be answered by
     * validation alone. `--as-of` binds twice into `coalesce(valid_from, event_at, created_at) <= ?
     * AND (valid_until IS NULL OR valid_until > ?)`, where SQLite compares TEXT to TEXT and nothing
     * parses the value. So an unsortable one does not error — it selects a DIFFERENT window and
     * returns a plausible-looking point-in-time view. Exit 2 is the only visible answer, and it has
     * to come before a service is built.
     */
    const UNSORTABLE = [
      // Sorts after every `T`-form instant on its day, so its window is nothing the caller asked for.
      "2026-08-24 13:00",
      "2026-08-24 13:00:00Z",
      // Sorts by its clock face rather than its instant.
      "2026-08-24T13:00:00+05:00",
      // Fractional seconds sort before the whole second they extend.
      "2026-08-24T13:00:00.000Z",
      // Absent seconds sort before the same minute carrying them.
      "2026-08-24T13:00Z",
      "not a date",
      "",
      // In the grammar, off the calendar.
      "2026-13-45"
    ] as const

    it.each(["search", "recall"])("refuses an unsortable --as-of on %s", async (command) => {
      for (const value of UNSORTABLE) {
        const result = await run([command, "vip drain", "--as-of", value])
        expect(result.exitCode, value).toBe(EXIT_USAGE)
        const body = parse(result.stdout)
        expect(body.code, value).toBe("ERR_INVALID_FLAG")
        expect(body.error, value).toContain("--as-of")
        // The suggestions are runnable calls of the command the caller actually typed.
        expect(body.suggestions, value).toEqual([
          `memhtml ${command} --as-of 2026-08-24`,
          `memhtml ${command} --as-of 2026-08-24T13:00:00Z`
        ])
      }
    })

    it("refuses a bare --as-of, which reads as scoped and would answer unscoped", async () => {
      // A trailing `--as-of` parses as the boolean `true`, so `scopeOf` would read no instant and
      // the query would return the whole corpus under a flag that says otherwise.
      const result = await run(["search", "vip drain", "--as-of"])
      expect(result.exitCode).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code).toBe("ERR_INVALID_FLAG")
      expect(body.error).toContain("--as-of")
    })

    it("admits exactly the values a memory file may STATE, so ask and answer share one grammar", () => {
      /**
       * Asserted against the format's own predicate rather than by running the command, because a
       * value that PASSES validation falls through to dispatch and builds the app layer — which
       * opens `$MEMHTML_ROOT/.memhtml/index.db` and would scaffold a repo as a side effect of a unit
       * test. `e2e.test.ts` runs the admitted forms through the real harness instead.
       *
       * One grammar for both directions is the point. A caller who could name an instant no file may
       * carry would be asking a question the corpus cannot answer.
       */
      for (const value of ["2026-08-24", "2026-08-24T13:00:00Z"]) {
        expect(isValidDatetime(value), value).toBe(true)
      }
      for (const value of UNSORTABLE) expect(isValidDatetime(value), value).toBe(false)
    })
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
     * The specific regression, pinned by name. There is no `--json` flag — the typed JSON envelope
     * is the binary's only output — so a suggestion naming it would itself be a usage error. The
     * walk above would not catch its return — the command name parses either way — so the flag
     * form is asserted directly.
     */
    const suggestions = SUGGESTIONS.DiscriminationFailed?.({ _tag: "DiscriminationFailed" }) ?? []
    expect(suggestions).toContain("memhtml eval discriminate")
    for (const suggestion of suggestions) expect(suggestion).not.toContain("--json")
  })

  it("emits the documented FAILURE envelope when the discrimination gate refuses", async () => {
    /**
     * The regression: a failed gate used to exit 1 but wrap the outcome in a SUCCESS envelope, so
     * an agent branching on `code` — which is what the envelope contract tells it to do — never saw
     * the gate fail. The docstring promised `ERR_DISCRIMINATION_FAILED`; nothing emitted it.
     *
     * An `--mrr-floor` above 1 forces the refusal deterministically: MRR is a mean of reciprocal
     * ranks and cannot exceed 1, so the fake-mode gate fails regardless of how well it ranks. The
     * corpus is kept small because the ranking's quality is not the subject.
     */
    const result = await run([
      "eval",
      "discriminate",
      "--size",
      "40",
      "--probes",
      "3",
      "--mrr-floor",
      "1.1"
    ])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_DISCRIMINATION_FAILED")
    expect(typeof body.error).toBe("string")
    expect(body.suggestions).toContain("memhtml eval discriminate")
    // A failure envelope has no `data`: the success shape must not leak through on the refusal.
    expect(body.data).toBeUndefined()
  }, 120_000)

  it("anchors the gate's corpus at the instant --now names, and reports the anchor back", async () => {
    /**
     * `--seed` alone does not reproduce a failing gate: the fixture corpus is a pure function of
     * `(seed, now)` and its stamps are what the recency and salience arms read, so the instant is the
     * other half. The flag existed nowhere while `packages/eval` threaded the value explicitly.
     *
     * The anchor is YESTERDAY's UTC day boundary, plus twelve hours, and both halves of that matter.
     * Yesterday, so a flag that were parsed and ignored would report the clock's own day and fail
     * here rather than agreeing by coincidence. Plus twelve hours, because `quantizeNow` floors the
     * anchor to a day — the corpus's stamps are day-grained — so the value that rides back proves the
     * flag reached the fixture rather than being echoed.
     *
     * (Mutation: dropping the `now` spread from the `eval discriminate` arm reports today's boundary.
     * Observed: two numbers 86400000 apart.)
     */
    const DAY_MILLIS = 86_400_000
    const anchor = Math.floor(Date.now() / DAY_MILLIS) * DAY_MILLIS - DAY_MILLIS
    const result = await run([
      "eval",
      "discriminate",
      "--size",
      "20",
      "--probes",
      "2",
      "--mrr-floor",
      "0",
      "--now",
      String(anchor + DAY_MILLIS / 2)
    ])
    expect(result.exitCode).toBe(EXIT_OK)
    const data = (parse(result.stdout).data ?? {}) as { readonly now: number }
    expect(data.now).toBe(anchor)
  }, 120_000)

  it("maps IndexStale to ERR_INDEX_STALE with a recovery that is not the raiser", () => {
    /**
     * `ERR_INDEX_STALE` is in `ERROR_CODES` (append-only), so it must stay reachable through
     * `codeFor` rather than degrade to `ERR_UNKNOWN`. The producer is the index package's
     * interrupted-rebuild detection; this pins the tag the two packages meet on.
     *
     * And the suggestion must MOVE the failure. `memhtml index update` is the command that raises this
     * tag — it refuses a watermark row with no commit on it rather than diffing from nothing
     * (`packages/index/src/indexer.ts`) — so offering it sent the operator in a circle. A rebuild is
     * the call that repopulates the tables the interrupted pass left partial.
     */
    const failure = { _tag: "IndexStale", reason: "a rebuild did not finish" }
    expect(codeFor(failure)).toBe("ERR_INDEX_STALE")
    expect(messageFor(failure)).toContain("a rebuild did not finish")
    expect(SUGGESTIONS.IndexStale?.(failure)).toEqual(["memhtml index rebuild"])
  })

  it("offers `memhtml correct` for a write conflict, which is what an occupied path needs", () => {
    /**
     * The store refuses an explicit `--path` that a file already occupies, because nothing in this
     * corpus is overwritten. Re-applying the change to current content is the recovery for the OTHER
     * branch of this tag — a merge conflict, which carries two blob shas — and it is no recovery at all
     * for an occupied path: the actionable call is `memhtml correct <path>`, which writes the
     * superseding memory and archives what it replaces in one commit.
     */
    const suggestions =
      SUGGESTIONS.WriteConflict?.({ _tag: "WriteConflict", path: "areas/inbox/a.html" }) ?? []
    expect(suggestions.some((line) => line.startsWith("memhtml correct areas/inbox/a.html"))).toBe(
      true
    )
    // And the merge-conflict recovery stays, since one tag covers both branches.
    expect(suggestions).toContain("re-apply the change to current content")
  })
})

describe("flag descriptions that carry a contract the table cannot express", () => {
  const flagOf = (command: string, flag: string) =>
    COMMANDS.find((entry) => entry.name === command)?.flags.find((entry) => entry.name === flag)

  it("states both outcomes of an explicit --path on write", () => {
    /**
     * The manifest is where an agent learns this, and the two outcomes are not symmetric: a path that
     * is not a usable memory path is IGNORED and the placement rule decides, while a path a file
     * already occupies is REFUSED with `ERR_WRITE_CONFLICT`. A description carrying only the first
     * reads as "a bad override is harmless", which is the branch that writes nothing and fails.
     */
    const path = flagOf("write", "path")
    expect(path?.description).toContain("IGNORED")
    expect(path?.description).toContain("ERR_WRITE_CONFLICT")
    expect(path?.description).toContain("memhtml correct")
  })

  it("declares --now on the gate, the other half of reproducing a failing run", () => {
    // The fixture corpus is a function of `(seed, now)` and its stamps are what the recency arm ranks
    // on, so `--seed` alone does not reproduce a run. The units are in the description because the
    // flag name cannot carry them.
    const now = flagOf("eval discriminate", "now")
    expect(now?.type).toBe("int")
    expect(now?.description).toContain("UTC millisecond")
  })

  it("declares the whole provenance triple wherever an arm stamps the whole triple", () => {
    /**
     * The regression: `read` and `correct` spread `provenanceOf(parsed)` into their use case while the
     * table declared only `session-id`, so `--prompt-id` and `--turn-uuid` were dead code in the arm
     * AND a usage error at the door. Per-command flag validation turned that mismatch into exit 2 for
     * a call that had been working, breaking a caller threading one triple through write-then-correct.
     */
    for (const command of ["write", "apply", "read", "correct", "task add"]) {
      for (const flag of ["session-id", "prompt-id", "turn-uuid"]) {
        expect(flagOf(command, flag), `${command} --${flag}`).toBeDefined()
      }
    }
  })
})
