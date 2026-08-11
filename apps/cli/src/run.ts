import { discriminationGate, type EvalMode, runDiscrimination } from "@memhtml/eval"
import { initRepo } from "@memhtml/store"
import { Effect, type Layer, Logger } from "effect"
import { runAgentsDoc } from "./agents-doc.js"
import { Git, Indexer, layerApp, Sleep } from "./api-layer.js"
import { applyPayload, applyText, decodeApply, readStdin } from "./apply.js"
import { buildManifest, COMMAND_NAMES, COMMANDS, GLOBAL_FLAGS } from "./commands.js"
import { MemhtmlRoot } from "./config.js"
import { doctor } from "./doctor.js"
import {
  API_VERSION,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  type Failure,
  fail,
  nearest,
  render,
  type Success,
  succeed
} from "./envelope.js"
import { failureFor } from "./errors.js"
import { DEFAULT_TIMEOUT_MS, execCommand, MAX_TIMEOUT_MS, readScript } from "./exec.js"
import * as ops from "./operations.js"
import { publish } from "./publish.js"
import { serveMcp } from "./serve.js"
import { stateExport, stateImport } from "./state.js"
import { indexReport, sleepPhases, sleepRunReport } from "./views.js"

export interface Parsed {
  readonly command: string
  readonly positional: ReadonlyArray<string>
  readonly flags: ReadonlyMap<string, ReadonlyArray<string | boolean>>
}

const KNOWN_FLAGS = new Set([
  ...GLOBAL_FLAGS.map((flag) => flag.name),
  ...COMMANDS.flatMap((command) => command.flags.map((flag) => flag.name))
])

/**
 * The two-word command names, longest first.
 *
 * A subcommand is matched greedily so `index status` beats `index`, and the leftover tokens become
 * positionals. Matching the shorter name first would make `memhtml index status` a call to a
 * hypothetical `index` command with `status` as an argument, which is a wrong answer rather than an
 * error.
 */
const COMPOUND_NAMES = COMMAND_NAMES.filter((name) => name.includes(" ")).sort(
  (left, right) => right.length - left.length
)

/**
 * `--flag value`, `--flag=value`, `--no-flag`, and bare `--flag`.
 *
 * Every flag's value is an ARRAY, because several flags are repeatable (`--tag`, `--entity`,
 * `--body`) and a map of scalars would silently keep only the last occurrence — a write with three
 * entities would store one. Non-repeatable flags read `.at(-1)`, so a duplicate is last-wins rather
 * than an error, which is what a shell user retyping a flag expects.
 */
export const parseArgv = (argv: ReadonlyArray<string>): Parsed => {
  const positional: Array<string> = []
  const flags = new Map<string, Array<string | boolean>>()

  const push = (name: string, value: string | boolean): void => {
    const existing = flags.get(name)
    if (existing === undefined) flags.set(name, [value])
    else existing.push(value)
  }

  let index = 0
  while (index < argv.length) {
    const token = argv[index] as string
    if (token.startsWith("--")) {
      const body = token.slice(2)
      const eq = body.indexOf("=")
      if (eq !== -1) {
        push(body.slice(0, eq), body.slice(eq + 1))
        index += 1
        continue
      }
      // `--no-embed` is how a boolean defaulting to true is turned off. Without it, a flag whose
      // default is `true` would be unsettable from a shell.
      if (body.startsWith("no-") && KNOWN_FLAGS.has(body.slice(3))) {
        push(body.slice(3), false)
        index += 1
        continue
      }
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith("--")) {
        push(body, next)
        index += 2
        continue
      }
      push(body, true)
      index += 1
      continue
    }
    positional.push(token)
    index += 1
  }

  const joined = positional.join(" ")
  const compound = COMPOUND_NAMES.find((name) => joined === name || joined.startsWith(`${name} `))
  if (compound !== undefined) {
    const consumed = compound.split(" ").length
    return { command: compound, positional: positional.slice(consumed), flags }
  }

  return { command: positional[0] ?? "", positional: positional.slice(1), flags }
}

/** A flag's last value as a string, or `undefined` when it was not given. */
const str = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags.get(name)?.at(-1)
  return value === undefined || typeof value === "boolean" ? undefined : value
}

/** Every value a repeatable flag was given, in order. Empty when absent. */
const list = (parsed: Parsed, name: string): ReadonlyArray<string> =>
  (parsed.flags.get(name) ?? []).flatMap((value) =>
    typeof value === "string" && value !== "" ? [value] : []
  )

/** A flag as a boolean: bare `--flag` is true, `--no-flag` is false, `--flag=false` is false. */
const bool = (parsed: Parsed, name: string, fallback: boolean): boolean => {
  const value = parsed.flags.get(name)?.at(-1)
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  return value !== "false" && value !== "0" && value !== "no"
}

/** A flag as an integer, or `undefined` when absent or unparseable. */
const int = (parsed: Parsed, name: string): number | undefined => {
  const raw = str(parsed, name)
  if (raw === undefined) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : undefined
}

/** A flag as a finite number in a range, or `undefined`. */
const num = (parsed: Parsed, name: string): number | undefined => {
  const raw = str(parsed, name)
  if (raw === undefined) return undefined
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : undefined
}

/** The scope every retrieval command shares, so `search` and `recall` cannot diverge. */
const scopeOf = (parsed: Parsed) => ({
  memoryTypes: list(parsed, "type") as ReadonlyArray<never>,
  workspace: str(parsed, "workspace"),
  tags: list(parsed, "tag"),
  entity: str(parsed, "entity"),
  includeArchived: bool(parsed, "include-archived", false),
  asOf: str(parsed, "as-of")
})

/** Session provenance, from the three flags every write-path command accepts. */
const provenanceOf = (parsed: Parsed) => ({
  sessionId: str(parsed, "session-id"),
  promptId: str(parsed, "prompt-id"),
  turnUuid: str(parsed, "turn-uuid")
})

export interface RunResult {
  readonly stdout: string
  readonly exitCode: number
}

/** What a handler returns: a response type and its payload. The envelope is added once, below. */
type Handled = readonly [Success<unknown>["type"], unknown]

/**
 * Dispatch one parsed invocation against the provided services.
 *
 * Every arm is decode → call → name the response type. No arm builds an envelope, catches an error,
 * or writes to a stream: those happen once in {@link run}, which is what keeps thirty-one commands
 * from having thirty-one slightly different failure shapes.
 *
 * `applyOps` is the one piece of state an arm cannot derive from `parsed`: reading a file or draining
 * stdin is async I/O whose failures are USAGE errors (exit 2), and `run` has already done it and
 * refused before reaching here. Passed in rather than read here, so the `apply` arm stays what every
 * other arm is — one call to a shared use case.
 */
const dispatch = (
  parsed: Parsed,
  applyOps: ReadonlyArray<ops.WriteParams> = []
): Effect.Effect<Handled, unknown, DispatchServices> => {
  switch (parsed.command) {
    case "manifest":
      return Effect.succeed(["cli.manifest", buildManifest()])

    case "init":
      return Effect.gen(function* () {
        const git = yield* Git
        const result = yield* initRepo(git)
        return ["repo.init", result] as const
      })

    case "write":
      return Effect.gen(function* () {
        const result = yield* ops.writeMemory({
          title: str(parsed, "title") ?? "",
          // `claim` is "" exactly when `--article-html` supplied the article instead, which
          // `validate` has already proven is the only way to get here without a claim. The
          // template ignores `claim` entirely on that branch (`@memhtml/html` template.ts:88-91).
          claim: str(parsed, "claim") ?? "",
          body: list(parsed, "body"),
          articleHtml: str(parsed, "article-html"),
          memoryType: str(parsed, "type") ?? "",
          path: str(parsed, "path"),
          workspace: str(parsed, "workspace"),
          tags: list(parsed, "tag"),
          entities: list(parsed, "entity"),
          importance: int(parsed, "importance"),
          confidence: num(parsed, "confidence"),
          ...provenanceOf(parsed)
        })
        return ["memory.written", result] as const
      })

    /**
     * The batch door. One call to the shared `batchWrite`, and the per-op `code`/`error` it returns
     * are NOT re-mapped here — the operation already ran them through the same `codeFor`/`messageFor`
     * every envelope error takes, precisely so this door and `memory_write_batch` cannot report
     * different codes for one refused op.
     */
    case "apply":
      return Effect.gen(function* () {
        const result = yield* ops.batchWrite({
          ops: applyOps,
          continueOnError: bool(parsed, "continue-on-error", false),
          detectConflicts: bool(parsed, "detect-conflicts", false),
          // `validate` has already refused any value outside the flag's closed vocabulary, so the
          // narrowing here cannot silently drop a caller's ask.
          ...(str(parsed, "consolidate") === "last-wins"
            ? { consolidate: "last-wins" as const }
            : {}),
          ...provenanceOf(parsed)
        })
        return ["batch.applied", applyPayload(result)] as const
      })

    case "read":
      return Effect.gen(function* () {
        const result = yield* ops.readMemory(parsed.positional[0] ?? "", provenanceOf(parsed))
        return [
          "memory.detail",
          {
            path: result.path,
            title: result.doc.title,
            metas: result.doc.metas,
            entities: result.doc.entities,
            tags: result.doc.tags,
            links: result.doc.links,
            gist: result.doc.article.gist,
            body: result.doc.article.bodyText,
            html: result.doc.article.html,
            archived: result.doc.metas.status === "archived",
            warnings: result.doc.warnings
          }
        ] as const
      })

    case "search":
      return Effect.gen(function* () {
        const result = yield* ops.searchMemories({
          query: parsed.positional[0] ?? "",
          limit: int(parsed, "limit"),
          ...scopeOf(parsed)
        })
        return ["memory.hits", result] as const
      })

    case "recall":
      return Effect.gen(function* () {
        const pack = yield* ops.recallMemories({
          query: parsed.positional[0] ?? "",
          budgetChars: int(parsed, "budget"),
          ...scopeOf(parsed)
        })
        return ["recall.pack", pack] as const
      })

    case "correct":
      return Effect.gen(function* () {
        const result = yield* ops.correctMemory({
          targetPath: parsed.positional[0] ?? "",
          title: str(parsed, "title") ?? "",
          claim: str(parsed, "claim") ?? "",
          body: list(parsed, "body"),
          articleHtml: str(parsed, "article-html"),
          memoryType: str(parsed, "type"),
          reason: str(parsed, "reason"),
          ...provenanceOf(parsed)
        })
        return ["memory.corrected", result] as const
      })

    case "link":
      return Effect.gen(function* () {
        const result = yield* ops.linkMemories(
          parsed.positional[0] ?? "",
          parsed.positional[1] ?? "",
          parsed.positional[2] ?? ""
        )
        return ["memory.linked", result] as const
      })

    case "neighbors":
      return Effect.gen(function* () {
        const result = yield* ops.neighborsOf({
          path: parsed.positional[0] ?? "",
          depth: int(parsed, "depth"),
          rels: list(parsed, "rel")
        })
        return ["memory.neighbors", result] as const
      })

    case "archive":
      return Effect.gen(function* () {
        const result = yield* ops.archiveMemory(
          parsed.positional[0] ?? "",
          str(parsed, "reason") ?? ""
        )
        return ["memory.archived", result] as const
      })

    case "reinforce":
      return Effect.gen(function* () {
        // Every positional is a path: `memhtml reinforce a.html b.html --signal positive` is the shape
        // an agent reaching for the MCP tool's `paths` array writes on a command line.
        const result = yield* ops.reinforceMemories(
          parsed.positional,
          str(parsed, "signal") ?? "neutral"
        )
        return ["memory.reinforced", result] as const
      })

    case "list":
      return Effect.gen(function* () {
        const result = yield* ops.listMemories({
          memoryType: str(parsed, "type"),
          workspace: str(parsed, "workspace"),
          tag: str(parsed, "tag"),
          entity: str(parsed, "entity"),
          para: str(parsed, "para"),
          limit: int(parsed, "limit"),
          cursor: str(parsed, "cursor"),
          includeArchived: bool(parsed, "include-archived", false)
        })
        return ["memory.list", result] as const
      })

    case "task add":
      return Effect.gen(function* () {
        const title = str(parsed, "title") ?? ""
        const result = yield* ops.writeMemory({
          title,
          // The claim defaults to the title: a task's statement and its name are usually the same
          // sentence, and a required second phrasing would be restated verbatim every time.
          claim: str(parsed, "claim") ?? title,
          body: list(parsed, "body"),
          memoryType: "task",
          workspace: str(parsed, "workspace"),
          tags: list(parsed, "tag"),
          entities: list(parsed, "entity"),
          taskStatus: str(parsed, "status"),
          dueAt: str(parsed, "due"),
          ...provenanceOf(parsed)
        })
        return [
          "task.written",
          {
            path: result.path,
            created: result.created,
            deduped: result.deduped,
            // Two open tasks with identical bodies are two real work items, so the dedup carve-out
            // means this is normally false — reported anyway, because a caller cannot tell a fresh
            // file from a returned one without it.
            existingPath: result.existingPath ?? null,
            taskStatus: str(parsed, "status") ?? "todo",
            dueAt: str(parsed, "due") ?? null,
            commitSha: result.commitSha
          }
        ] as const
      })

    case "task status":
      return Effect.gen(function* () {
        const result = yield* ops.setTaskStatus({
          path: parsed.positional[0] ?? "",
          status: parsed.positional[1] ?? "",
          reason: str(parsed, "reason")
        })
        return ["task.updated", { ...result, archivePath: result.archivePath ?? null }] as const
      })

    case "task list":
      return Effect.gen(function* () {
        const result = yield* ops.listTasks({
          status: str(parsed, "status"),
          workspace: str(parsed, "workspace"),
          dueBefore: str(parsed, "due-before"),
          limit: int(parsed, "limit"),
          cursor: str(parsed, "cursor"),
          includeArchived: bool(parsed, "include-archived", false)
        })
        return ["task.list", result] as const
      })

    case "index rebuild":
      return Effect.gen(function* () {
        const indexer = yield* Indexer
        const report = yield* indexer.rebuild({ embed: bool(parsed, "embed", true) })
        return ["index.report", { mode: "rebuild", ...report }] as const
      })

    case "index update":
      return Effect.gen(function* () {
        const indexer = yield* Indexer
        const report = yield* indexer.update({ embed: bool(parsed, "embed", true) })
        return ["index.report", { mode: "update", ...report }] as const
      })

    case "index status":
      return Effect.gen(function* () {
        const report = yield* indexReport()
        return ["index.report", report] as const
      })

    case "trace index":
      return Effect.gen(function* () {
        const report = yield* ops.indexTraces()
        return ["trace.report", report] as const
      })

    case "trace search":
      return Effect.gen(function* () {
        const result = yield* ops.searchTraces({
          query: parsed.positional[0] ?? "",
          cwd: str(parsed, "cwd"),
          since: str(parsed, "since"),
          limit: int(parsed, "limit")
        })
        return ["trace.sessions", result] as const
      })

    case "trace links":
      return Effect.gen(function* () {
        const result = yield* ops.traceLinks({
          sessionId: str(parsed, "session-id"),
          path: str(parsed, "path")
        })
        return ["trace.links", result] as const
      })

    case "sleep run":
      return Effect.gen(function* () {
        const sleep = yield* Sleep
        const phases = yield* sleepPhases(str(parsed, "phases"))
        const report = yield* sleep.run({
          date: str(parsed, "date") ?? (yield* today),
          ...(phases === undefined ? {} : { phases }),
          dryRun: bool(parsed, "dry-run", false)
        })
        return ["sleep.report", sleepRunReport(report)] as const
      })

    case "sleep resume":
      return Effect.gen(function* () {
        const sleep = yield* Sleep
        const report = yield* sleep.resume(parsed.positional[0] ?? "")
        return ["sleep.report", sleepRunReport(report)] as const
      })

    case "sleep review":
      return Effect.gen(function* () {
        const sleep = yield* Sleep
        const report = yield* sleep.review(parsed.positional[0])
        const withDiff = bool(parsed, "diff", false)
        if (!withDiff) return ["sleep.review", report] as const
        // The raw diff is fetched here rather than inside `review`: it is the one field whose size
        // is unbounded, and a review that always carried it would make the default response
        // unusable in a context window.
        const git = yield* Git
        const diff = yield* git
          .run(["diff", `${report.baseSha}..${report.headSha}`])
          .pipe(Effect.orElseSucceed(() => ""))
        return ["sleep.review", { ...report, diff }] as const
      })

    case "sleep merge":
      return Effect.gen(function* () {
        const sleep = yield* Sleep
        const skipGate = bool(parsed, "skip-gate", false)
        if (skipGate) {
          yield* Effect.logWarning(
            "sleep merge --skip-gate: merging without re-running discrimination"
          )
        }
        /**
         * **The discrimination gate, composed here.** A sleep run that degrades retrieval quality
         * cannot land, and the refusal is the point — the whole reason `@memhtml/sleep` takes the gate as
         * a parameter and supplies none is that a package that cannot import the eval must not be
         * able to silently default it. The composition is visible in this wiring or it does not exist.
         *
         * `discriminationGate` fails on an inversion, `merge` wraps it in `Effect.result`, and the
         * failure becomes `refusal: "gate-failed"` with `main` never moving.
         *
         * `fake` mode, always. The gate measures the RANKING STACK against its own generated fixture
         * corpus, so a live-Bedrock run would make a nightly merge conditional on a network call and
         * on credentials being present at 3am — and the deterministic embedder's cosine relations are
         * a pure function of the text, which is exactly the property a regression gate needs. A
         * cron whose merge silently skipped its gate because a token expired is the failure this
         * refuses to have.
         */
        const report = yield* sleep.merge(
          parsed.positional[0] ?? "",
          skipGate ? {} : { preMergeGate: discriminationGate().pipe(Effect.asVoid) }
        )
        return ["sleep.merge", report] as const
      })

    case "publish":
      return Effect.gen(function* () {
        const report = yield* publish()
        return ["publish.report", report] as const
      })

    case "doctor":
      return Effect.gen(function* () {
        const report = yield* doctor({ fix: bool(parsed, "fix", false) })
        return ["doctor.report", report] as const
      })

    case "state export":
      return Effect.gen(function* () {
        const report = yield* stateExport()
        return ["state.export", report] as const
      })

    case "state import":
      return Effect.gen(function* () {
        const report = yield* stateImport()
        return ["state.import", report] as const
      })

    case "sleep status":
      return Effect.gen(function* () {
        const sleep = yield* Sleep
        const report = yield* sleep.review()
        return [
          "sleep.report",
          {
            runId: report.runId,
            branch: report.branch,
            baseSha: report.baseSha,
            headSha: report.headSha,
            phases: report.phases,
            commits: report.commits.length
          }
        ] as const
      })

    case "status":
      return Effect.gen(function* () {
        const report = yield* ops.statusReport()
        return ["status.health", report] as const
      })

    default:
      // Unreachable while every COMMANDS entry has a case. A new spec with no handler surfaces
      // here as a usage error rather than an empty stdout.
      return Effect.fail({ _tag: "UnhandledCommand", command: parsed.command })
  }
}

/** Today as `YYYY-MM-DD`, through the Effect clock so a test can pin the run date. */
const today = Effect.clockWith((clock) =>
  Effect.map(clock.currentTimeMillis, (millis) => new Date(millis).toISOString().slice(0, 10))
)

/**
 * The services `dispatch` may reach for, derived from the app layer's own output.
 *
 * Derived rather than listed: a service added to `layerCore` becomes available to a handler with no
 * edit here, and — more to the point — a service REMOVED from the layer becomes a compile error at
 * the handler that reads it, rather than a runtime "service not found" at the one moment an operator
 * is running the command.
 */
type DispatchServices = Layer.Success<ReturnType<typeof layerApp>>

/**
 * An unknown command, with candidates measured against the WHOLE typed invocation.
 *
 * `parseArgv` only matches a compound name exactly, so a typo in either word of `memhtml index rebuild`
 * leaves `command` holding the first token alone and every remaining token in `positional` — and
 * measuring `"index"` against the flat name list scores `init` at 2 and `index rebuild` at 8, so the
 * suggestion an operator needs loses to one they did not ask for. Re-joining the tokens is what makes
 * the distance a comparison of the two things: `"index rebiuld"` is 2 from `index rebuild` and 12
 * from `init`.
 *
 * Both are offered — the joined form first — because the typo could be in either half. A one-word
 * invocation joins to itself, so the single-command path is unchanged.
 */
const unknownCommand = (parsed: Parsed): Failure => {
  const typed = [parsed.command, ...parsed.positional].join(" ").trim()
  const candidates = [
    ...nearest(typed, COMMAND_NAMES),
    ...nearest(parsed.command, COMMAND_NAMES)
  ].filter((name, at, all) => all.indexOf(name) === at)
  return fail(
    "ERR_UNKNOWN_COMMAND",
    `unknown command: ${typed === "" ? parsed.command : typed}`,
    candidates.slice(0, 3)
  )
}

/**
 * The commands where the article body comes from EITHER a claim or pre-authored markup, never both.
 *
 * Listed here rather than expressed in `FlagSpec`, because `FlagSpec` has one `required: boolean` and
 * no notion of a conditional — and inventing a table field for a rule that holds on two commands
 * would put a second, weaker copy of this check into the manifest for every command that does not
 * need it. Both flag descriptions state the rule, so `memhtml manifest` still carries it.
 */
const EITHER_CLAIM_OR_ARTICLE: ReadonlySet<string> = new Set(["write", "correct"])

/**
 * `memhtml exec` takes at most one script door, and a bound inside the cap.
 *
 * Here for the reason `claimOrArticle` is: `validate`'s return becomes exit 2 and a failure raised in
 * `dispatch` becomes exit 1, so "you passed the wrong flags" must be decided before any service is
 * built. `.erpaval/solutions/api-patterns/xor-params-and-mcp-error-masking.md` records the rule.
 *
 * At most one rather than exactly one, because ZERO doors is legal and means stdin — the same shape
 * `memhtml apply` has, where a bare invocation drains the pipe. So a missing script is not a usage error
 * here; an EMPTY one is, and that check lives beside the read in {@link run} because reading is async.
 *
 * `--timeout-ms` is checked for a POSITIVE integer within the cap. Zero and negatives are refused
 * rather than clamped: just-bash treats a non-positive `maxJsTimeoutMs` as no bound at all, so
 * `--timeout-ms 0` would read as "be quick" and mean "run forever".
 */
const execFlags = (parsed: Parsed): Failure | undefined => {
  if (parsed.command !== "exec") return undefined

  const doors = [
    str(parsed, "file") === undefined ? undefined : "--file",
    str(parsed, "script") === undefined ? undefined : "--script"
  ].filter((door) => door !== undefined)
  if (doors.length > 1) {
    return fail(
      "ERR_INVALID_FLAG",
      "exec takes at most one of --file or --script, not both: two scripts cannot both be the one that runs",
      [
        "memhtml exec --file traverse.mjs",
        "memhtml exec --script 'console.log(1)'",
        "cat s.mjs | memhtml exec"
      ]
    )
  }
  // A `-` positional is the explicit stdin spelling, so it cannot sit beside a door either.
  if (doors.length === 1 && parsed.positional[0] === "-") {
    return fail(
      "ERR_INVALID_FLAG",
      `exec cannot read stdin and ${doors[0]} in the same call: \`-\` names stdin as the script source`,
      ["cat s.mjs | memhtml exec", `memhtml exec ${doors[0]} …`]
    )
  }

  const raw = str(parsed, "timeout-ms")
  if (raw !== undefined) {
    const timeout = int(parsed, "timeout-ms")
    if (timeout === undefined || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
      return fail(
        "ERR_INVALID_FLAG",
        `--timeout-ms must be a positive integer of at most ${MAX_TIMEOUT_MS}: a non-positive bound is no bound at all, which is the one thing a sandbox may not be`,
        [`memhtml exec --timeout-ms ${DEFAULT_TIMEOUT_MS}`]
      )
    }
  }

  return undefined
}

/**
 * Exactly one of `--claim` / `--article-html`.
 *
 * Checked HERE and not in the dispatch arm, because the exit code is the contract: `validate`'s
 * return is emitted as exit 2 ({@link EXIT_USAGE}), while a failure raised inside `dispatch` travels
 * through `failureFor` and becomes exit 1. Supplying the wrong flags is a usage error, and a shell
 * caller branching on the code must not see it as a runtime one.
 *
 * Two codes for two conditions, each following the convention already in this function: an absent
 * required flag is `ERR_MISSING_ARGUMENT` (as below), and a flag present but unusable as given is
 * `ERR_INVALID_FLAG` (as above, and in the closed-vocabulary check). Neither is newly minted.
 */
const claimOrArticle = (parsed: Parsed): Failure | undefined => {
  if (!EITHER_CLAIM_OR_ARTICLE.has(parsed.command)) return undefined
  const hasClaim = str(parsed, "claim") !== undefined
  const hasArticle = str(parsed, "article-html") !== undefined
  if (hasClaim && hasArticle) {
    return fail(
      "ERR_INVALID_FLAG",
      `${parsed.command} takes exactly one of --claim or --article-html, not both: --article-html is the whole article, so a --claim beside it would be silently discarded`,
      [
        `memhtml ${parsed.command} --claim <sentence>`,
        `memhtml ${parsed.command} --article-html '<p>…</p>'`
      ]
    )
  }
  if (!hasClaim && !hasArticle) {
    return fail(
      "ERR_MISSING_ARGUMENT",
      `${parsed.command} requires exactly one of --claim or --article-html`,
      [
        `memhtml ${parsed.command} --claim <sentence>`,
        `memhtml ${parsed.command} --article-html '<p>…</p>'`
      ]
    )
  }
  return undefined
}

/**
 * Validate a parsed invocation against its spec. Usage errors only — nothing here touches a service.
 *
 * Returning the failure rather than throwing keeps the exit code decision in one place: a usage
 * error is exit 2 and a runtime error is exit 1, and a validator that emitted its own envelope would
 * have to know that too.
 */
const validate = (parsed: Parsed): Failure | undefined => {
  for (const name of parsed.flags.keys()) {
    if (!KNOWN_FLAGS.has(name)) {
      return fail("ERR_INVALID_FLAG", `unknown flag: --${name}`, nearest(name, [...KNOWN_FLAGS]))
    }
  }

  const spec = COMMANDS.find((command) => command.name === parsed.command)
  if (spec === undefined) return unknownCommand(parsed)

  const missingArgs = spec.args.filter(
    (arg, position) => arg.required && parsed.positional[position] === undefined
  )
  if (missingArgs.length > 0) {
    return fail(
      "ERR_MISSING_ARGUMENT",
      `${spec.name} requires: ${missingArgs.map((arg) => arg.name).join(", ")}`,
      [`memhtml ${spec.name} <${missingArgs[0]?.name}>`]
    )
  }

  const missingFlags = spec.flags.filter(
    (flag) => flag.required === true && parsed.flags.get(flag.name) === undefined
  )
  if (missingFlags.length > 0) {
    return fail(
      "ERR_MISSING_ARGUMENT",
      `${spec.name} requires: ${missingFlags.map((flag) => `--${flag.name}`).join(", ")}`,
      missingFlags.map((flag) => `memhtml ${spec.name} --${flag.name} <value>`)
    )
  }

  // Presence rules together: the unconditionally-required flags above, then the two conditional
  // rules the table cannot express, then the value checks below.
  const eitherOr = claimOrArticle(parsed)
  if (eitherOr !== undefined) return eitherOr

  const exec = execFlags(parsed)
  if (exec !== undefined) return exec

  /**
   * A closed-vocabulary flag is checked here rather than at the service, so a typo answers with the
   * whole vocabulary and never touches the database. The check is skipped for a repeatable flag's
   * non-final values only in the sense that every value is checked — a `--type` list with one bad
   * entry is a usage error, not a silently narrowed search.
   */
  for (const flag of spec.flags) {
    if (flag.values === undefined) continue
    for (const value of parsed.flags.get(flag.name) ?? []) {
      if (typeof value !== "string") continue
      if (!flag.values.includes(value)) {
        return fail(
          "ERR_INVALID_FLAG",
          `--${flag.name} must be one of: ${flag.values.join(", ")}`,
          nearest(value, flag.values)
        )
      }
    }
  }

  return undefined
}

/**
 * Returns the rendered envelope and an exit code rather than writing to the process, so tests
 * assert on the exact bytes an agent would parse.
 *
 * `layer` is injectable for exactly that reason: a test supplies the real composition over a temp
 * repo and a deterministic embedder, and every assertion below then describes the shipped path.
 *
 * `stdin` is injectable for the same reason one step further out: `memhtml apply` reads a JSONL stream
 * from a pipe, and a test that had to spawn a process and write to its descriptor to exercise the
 * stdin path would be an integration test of the shell rather than of this function. The default
 * reads `process.stdin`, so `bin.ts` needs no knowledge of which commands want input.
 */
export const run = async (
  argv: ReadonlyArray<string>,
  layer?: Layer.Layer<DispatchServices>,
  stdin: () => Promise<string> = readStdin
): Promise<RunResult> => {
  const parsed = parseArgv(argv)
  const dense = bool(parsed, "dense", false)

  const emit = (payload: Success<unknown> | Failure, exitCode: number): RunResult => ({
    stdout: render(payload, dense),
    exitCode
  })

  if (parsed.command === "" || parsed.command === "help") {
    return emit(succeed("cli.manifest", buildManifest()), EXIT_OK)
  }

  const invalid = validate(parsed)
  if (invalid !== undefined) return emit(invalid, EXIT_USAGE)

  /**
   * The two self-describing commands answer WITHOUT building the app layer.
   *
   * `manifest` is the load-bearing case: it is the FIRST call an agent makes and it must answer on a
   * machine with no repo, no database, and no credentials. Building the layer first would make the
   * self-description conditional on the thing it describes being already working.
   *
   * `agents-doc` is here because building the layer has a SIDE EFFECT — `layerDatabase` opens
   * `$MEMHTML_ROOT/.memhtml/index.db`, creating the directory and running every migration. A doc generator
   * that scaffolded a memory repo as a side effect of rendering Markdown would create `~/memhtml`
   * on any machine that ran `memhtml agents-doc --check` in CI. It reads only the command table, so it
   * has no business touching the app graph at all.
   */
  if (parsed.command === "manifest") {
    return emit(succeed("cli.manifest", buildManifest()), EXIT_OK)
  }

  if (parsed.command === "agents-doc") {
    return Effect.runPromise(
      runAgentsDoc({ check: bool(parsed, "check", false), out: str(parsed, "out") }).pipe(
        Effect.map((data) => emit(succeed("agents.doc", data), EXIT_OK)),
        Effect.catch((error) => Effect.succeed(emit(failureFor(error), EXIT_RUNTIME))),
        Effect.provideService(Logger.LogToStderr, true)
      )
    )
  }

  /**
   * `serve mcp` must not build the app layer either, and here the reason is a LOCK.
   *
   * The supervisor's only job is to spawn the server and wait. Building `layerApp` first would open
   * `$MEMHTML_ROOT/.memhtml/index.db` in the parent, and Turso's lock excludes a second WRITABLE opener — so
   * would fail to open the very database it exists to serve, with "File is locked by another
   * process". The parent needs the resolved repo ROOT, which is config, not a service.
   *
   * Nothing is emitted until the child exits, because stdout belongs to the child from the moment it
   * is spawned. The `serve.exit` envelope describes how the server ended, and it is written after
   * the descriptors are the parent's again.
   */
  if (parsed.command === "serve mcp") {
    return Effect.runPromise(
      Effect.gen(function* () {
        const override = str(parsed, "repo")
        const configured = yield* MemhtmlRoot
        const memhtmlRoot =
          override !== undefined && override.trim() !== "" ? override.trim() : configured
        return yield* serveMcp(memhtmlRoot)
      }).pipe(
        Effect.map((data) => emit(succeed("serve.exit", data), EXIT_OK)),
        Effect.catch((error) => Effect.succeed(emit(failureFor(error), EXIT_RUNTIME))),
        Effect.catchCause((cause) =>
          Effect.succeed(
            emit(fail("ERR_UNKNOWN", `unexpected failure: ${String(cause)}`, []), EXIT_RUNTIME)
          )
        ),
        Effect.provideService(Logger.LogToStderr, true)
      )
    )
  }

  /**
   * `eval discriminate` does not build the app layer either, and the reason is finding #37's lesson
   * one command over: the gate measures the ranking stack against its own GENERATED fixture corpus in
   * a temp directory with an in-memory database, and reads the operator's `index.db` not at all.
   * Building `layerApp` would take Turso's writer lock on a database this command never queries —
   * so `memhtml eval discriminate` would refuse to run while `memhtml-mcp` is serving the repo, which is
   * exactly when an operator wants to check the gate.
   *
   * **Exit 1 on a failed gate**, with `ERR_DISCRIMINATION_FAILED`. A refusable gate that exited 0 and
   * left the verdict inside the payload would be a gate every shell caller forgets to read — the
   * whole point is that a pipeline stops.
   */
  if (parsed.command === "eval discriminate") {
    const requested = (str(parsed, "mode") ?? "fake") as EvalMode
    return Effect.runPromise(
      runDiscrimination({
        mode: requested,
        ...(int(parsed, "seed") === undefined ? {} : { seed: int(parsed, "seed") }),
        ...(int(parsed, "size") === undefined ? {} : { size: int(parsed, "size") }),
        ...(int(parsed, "probes") === undefined ? {} : { probes: int(parsed, "probes") }),
        ...(num(parsed, "mrr-floor") === undefined ? {} : { mrrFloor: num(parsed, "mrr-floor") })
      }).pipe(
        Effect.map((outcome) =>
          outcome.passed
            ? emit(succeed("eval.discrimination", outcome), EXIT_OK)
            : {
                stdout: render(succeed("eval.discrimination", outcome), dense),
                exitCode: EXIT_RUNTIME
              }
        ),
        Effect.catchCause((cause) =>
          Effect.succeed(
            emit(fail("ERR_UNKNOWN", `unexpected failure: ${String(cause)}`, []), EXIT_RUNTIME)
          )
        ),
        Effect.provideService(Logger.LogToStderr, true)
      )
    )
  }

  /**
   * `memhtml exec` does not build the app layer either, for the lock reason two commands over.
   *
   * The command reads a git TREE and nothing else: it materializes a commit as a detached worktree and
   * mounts that directory read-only. It never queries `index.db`, so building `layerApp` would take
   * Turso's writer lock on a database it does not use — and `memhtml exec` would refuse to run while
   * `memhtml serve mcp` is serving the repo, which is exactly when an agent wants a traversal. Nothing
   * here can be reached through `dispatch`, because `dispatch`'s service set IS the app layer's.
   *
   * **Non-zero `exitCode` in the payload is still exit 0 for the process**, and that split is the
   * contract. A failing script is a REPORT with `stderr` an agent reads and fixes; the CLI's exit 1 is
   * reserved for the runtime failing to run the script at all (no repo, unreadable sha, absent helper).
   * Collapsing the two would make an agent unable to tell a bad selector from a broken install, and
   * would bury the script's own diagnostic inside an `error` string.
   *
   * The script is read HERE rather than in `runExec`, so a missing or empty script is exit 2 like every
   * other input error: `runExec` takes source, never a path.
   */
  if (parsed.command === "exec") {
    const inline = str(parsed, "script")
    const file = parsed.positional[0] === "-" ? undefined : str(parsed, "file")
    const script =
      inline !== undefined ? inline : file === undefined ? await stdin() : await readScript(file)
    if (typeof script !== "string") return emit(script, EXIT_USAGE)
    if (script.trim() === "") {
      return emit(
        fail(
          "ERR_MISSING_ARGUMENT",
          "exec needs a script: a blank one would report an empty answer rather than an error",
          [
            "memhtml exec --script 'console.log(1)'",
            "memhtml exec --file traverse.mjs",
            "cat s.mjs | memhtml exec"
          ]
        ),
        EXIT_USAGE
      )
    }

    const override = str(parsed, "repo")
    return Effect.runPromise(
      Effect.gen(function* () {
        const configured = yield* MemhtmlRoot
        const memhtmlRoot =
          override !== undefined && override.trim() !== "" ? override.trim() : configured
        return yield* execCommand({
          script,
          memhtmlRoot,
          sha: str(parsed, "sha"),
          timeoutMs: int(parsed, "timeout-ms")
        })
      }).pipe(
        Effect.map((report) => emit(succeed("exec.report", report), EXIT_OK)),
        Effect.catch((error) => Effect.succeed(emit(failureFor(error), EXIT_RUNTIME))),
        Effect.catchCause((cause) =>
          Effect.succeed(
            emit(fail("ERR_UNKNOWN", `unexpected failure: ${String(cause)}`, []), EXIT_RUNTIME)
          )
        ),
        Effect.provideService(Logger.LogToStderr, true),
        Effect.scoped
      )
    )
  }

  /**
   * `memhtml apply` reads and SHAPE-VALIDATES its whole op stream before any service is built (AC-6-4).
   *
   * Here rather than in `validate` because reading a file is async and `validate` is a pure synchronous
   * function of the parsed argv; here rather than in the dispatch arm because a refusal raised inside
   * `dispatch` travels through `failureFor` and becomes exit 1, while a malformed input file is a USAGE
   * error and must be exit 2. The caller wrote a bad file; the corpus is fine.
   *
   * The ordering is the observable contract: nothing is written for a file with a bad line, and at this
   * point nothing CAN have been — the app layer has not been built, so no database is open and no git
   * command has run.
   */
  let applyOps: ReadonlyArray<ops.WriteParams> = []
  if (parsed.command === "apply") {
    // `memhtml apply -` is the explicit "read stdin" spelling; the dash is not a path.
    const file = parsed.positional[0] === "-" ? undefined : str(parsed, "file")
    const text = await applyText(file, stdin)
    if (typeof text !== "string") return emit(text, EXIT_USAGE)
    const decoded = decodeApply(text)
    if (!decoded.ok) return emit(decoded.failure, EXIT_USAGE)
    applyOps = decoded.ops
  }

  const program = dispatch(parsed, applyOps).pipe(
    Effect.map(([type, data]) => emit(succeed(type, data), EXIT_OK)),
    Effect.catch((error) => Effect.succeed(emit(failureFor(error), EXIT_RUNTIME))),
    // A defect is still an answer. An unexpected throw anywhere below would otherwise reach the
    // process as an unhandled rejection and print a stack trace onto stdout, which is precisely the
    // one thing this contract promises never to do — stdout is a parse target.
    Effect.catchCause((cause) =>
      Effect.succeed(
        emit(fail("ERR_UNKNOWN", `unexpected failure: ${String(cause)}`, []), EXIT_RUNTIME)
      )
    ),
    Effect.provide(layer ?? layerApp(str(parsed, "repo"))),
    // Logs go to stderr, always. Effect's default logger writes to stdout, which would interleave
    // log lines with the envelope and break every parser.
    Effect.provideService(Logger.LogToStderr, true),
    Effect.scoped
  )

  return Effect.runPromise(program)
}

/** The envelope's api version, re-exported so a caller can assert on it without a second import. */
export { API_VERSION }
