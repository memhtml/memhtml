import {
  DiscriminationFailed,
  discriminationGate,
  type EvalMode,
  runDiscrimination
} from "@memhtml/eval"
import { isValidDatetime } from "@memhtml/html"
import { parseFacetFilters } from "@memhtml/index"
import { initRepo } from "@memhtml/store"
import { Effect, type Layer, Logger } from "effect"
import { runAgentsDoc } from "./agents-doc.js"
import { Git, Indexer, layerApp, Sleep } from "./api-layer.js"
import { applyPayload, applyText, decodeApply, readStdin } from "./apply.js"
import {
  buildManifest,
  COMMAND_NAMES,
  COMMANDS,
  type CommandSpec,
  type FlagSpec,
  GLOBAL_FLAGS
} from "./commands.js"
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
  /**
   * Each bare boolean flag a value-shaped token followed as a separate argv word, as a
   * `[flag, token]` pair.
   *
   * A boolean flag does not consume the next token, so `--embed false` parses as `embed: true` plus
   * a positional `"false"` — the INVERSE of what the caller asked for, on a flag whose whole purpose
   * is to turn work off. The pair is carried here rather than resolved in the parser because
   * {@link validate} owns refusals and the exit code they carry; `--embed=false` and `--no-embed` are
   * the spellings that work.
   */
  readonly strayBooleanValues: ReadonlyArray<readonly [string, string]>
}

const KNOWN_FLAGS = new Set([
  ...GLOBAL_FLAGS.map((flag) => flag.name),
  ...COMMANDS.flatMap((command) => command.flags.map((flag) => flag.name))
])

/**
 * Every flag name the spec table declares, mapped to the type it declares.
 *
 * **Only a `string` or `int` flag consumes the next argv token as its value**, and the two kinds it
 * excludes are excluded for different reasons:
 *
 * - A `boolean` flag takes `--flag`, `--flag=value`, or `--no-flag`, so the token after it stays
 *   positional and can be the command: `memhtml --dense list` is the `list` command, not an empty
 *   command carrying `dense: "list"`.
 * - A flag the table does not declare has no type to consult, and eating the token would swallow the
 *   command name — `memhtml --nope list` would answer the manifest at exit 0 instead of refusing an
 *   unknown flag. Leaving the token positional lets the command reach {@link validate}, which is
 *   where an unknown flag becomes exit 2.
 *
 * The map is name-keyed across every command even though validation is per-command, because the
 * parser runs before the command is known. That is sound only while one name carries ONE type
 * everywhere, which is a property of the table `cli.test.ts` enforces rather than a hope.
 */
const FLAG_TYPES: ReadonlyMap<string, FlagSpec["type"]> = new Map(
  [...GLOBAL_FLAGS, ...COMMANDS.flatMap((command) => command.flags)].map((flag) => [
    flag.name,
    flag.type
  ])
)

/**
 * The tokens {@link bool} would have read as a boolean value.
 *
 * A boolean flag followed by one of these is a caller spelling `--flag <value>`, which parses as the
 * opposite value. Any other token after a boolean flag is a positional the caller meant — the
 * command name, a path, a query — so the set is exactly the vocabulary `bool` interprets and not
 * "any following token".
 */
const BOOLEAN_VALUE_TOKENS: ReadonlySet<string> = new Set(["true", "false", "yes", "no", "0", "1"])

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
 * `--flag value`, `--flag=value`, `--no-flag`, and bare `--flag`, parsed against the spec table.
 *
 * Every flag's value is an array, because several flags are repeatable (`--tag`, `--entity`,
 * `--body`) and a map of scalars would silently keep only the last occurrence, so a write with three
 * entities would store one. Non-repeatable flags read `.at(-1)`, so a duplicate is last-wins rather
 * than an error, which is what a shell user retyping a flag expects.
 *
 * Only a flag the table types `string` or `int` consumes the next token as its value; a boolean flag
 * and an undeclared flag both leave it positional, for the two reasons {@link FLAG_TYPES} states.
 * A boolean flag followed by a value-shaped token is recorded as a stray so {@link validate} can
 * refuse it rather than silently inverting the caller's ask.
 */
export const parseArgv = (argv: ReadonlyArray<string>): Parsed => {
  const positional: Array<string> = []
  const flags = new Map<string, Array<string | boolean>>()
  const strayBooleanValues: Array<readonly [string, string]> = []

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
      const type = FLAG_TYPES.get(body)
      if ((type === "string" || type === "int") && next !== undefined && !next.startsWith("--")) {
        push(body, next)
        index += 2
        continue
      }
      if (
        type === "boolean" &&
        next !== undefined &&
        BOOLEAN_VALUE_TOKENS.has(next.toLowerCase())
      ) {
        strayBooleanValues.push([body, next])
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
    return {
      command: compound,
      positional: positional.slice(consumed),
      flags,
      strayBooleanValues
    }
  }

  return {
    command: positional[0] ?? "",
    positional: positional.slice(1),
    flags,
    strayBooleanValues
  }
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
  // `list` returns every occurrence, so a repeated `--facet` composes instead of last-winning, and
  // the `name=value` split is `@memhtml/index`'s so both doors read one wire form.
  facets: parseFacetFilters(list(parsed, "facet")),
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

/**
 * What a handler returns: a response type, its payload, and optionally the exit code that payload
 * implies. The envelope is added once, below, and an absent third element is {@link EXIT_OK}.
 *
 * The third element exists for the two commands whose own failures are DATA. `@memhtml/sleep` types
 * `run` and `resume` with error channel `never` on purpose — a phase that failed is a normal terminal
 * state with a report row — so the report is a success envelope and the process still has to say the
 * curation did not happen. Everywhere else a returned payload is success, so the element is absent
 * rather than restated on every other arm.
 */
type Handled = readonly [Success<unknown>["type"], unknown, number?]

/**
 * Exit 1 when a sleep run has a failed phase.
 *
 * **A partially-failed run and a fully-aborted run exit the same**, and that is a decision rather
 * than an omission. A caller reading the exit code is asking one question — did the curation this
 * invocation was for happen — and both answers are no. The difference between them is already stated
 * in the payload, precisely: an abort is every selected phase `failed` with `headSha === baseSha` and
 * no commits, while a partial run names the phases that landed. A second exit code would be a
 * second, weaker copy of that, and a caller would have to learn it to recover a fact the envelope
 * already carries.
 *
 * Exit 1 rather than 2: the call was well-formed, so this is a runtime failure an operator fixes by
 * changing the repo or the environment ({@link EXIT_USAGE} is reserved for fixing the call).
 *
 * `sleep status` and `sleep review` are deliberately not routed through here. They REPORT a run they
 * did not perform, and a read that exited non-zero because the thing it describes failed would make
 * "tell me what happened" indistinguishable from "I could not tell you".
 */
const sleepExit = (report: { readonly failedPhases: ReadonlyArray<string> }): number =>
  report.failedPhases.length > 0 ? EXIT_RUNTIME : EXIT_OK

/**
 * Dispatch one parsed invocation against the provided services.
 *
 * Every arm is decode → call → name the response type. No arm builds an envelope, catches an error,
 * or writes to a stream. Those happen once in {@link run}, which keeps thirty-one commands
 * from having thirty-one slightly different failure shapes.
 *
 * `applyOps` is the one piece of state an arm cannot derive from `parsed`. Reading a file or draining
 * stdin is async I/O whose failures are usage errors (exit 2), and `run` has already done it and
 * refused before reaching here. It is passed in rather than read here, so the `apply` arm stays what
 * every other arm is: one call to a shared use case.
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
          strictPath: bool(parsed, "strict-path", false),
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
     * are not re-mapped here. The operation already ran them through the same `codeFor`/`messageFor`
     * every envelope error takes, so this door and `memory_write_batch` cannot report
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
          limit: int(parsed, "limit"),
          rels: list(parsed, "rel")
        })
        return ["memory.neighbors", result] as const
      })

    case "resolve":
      return Effect.gen(function* () {
        const result = yield* ops.resolveMemory(parsed.positional[0] ?? "")
        return ["memory.resolved", result] as const
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
          facets: parseFacetFilters(list(parsed, "facet")),
          para: str(parsed, "para"),
          limit: int(parsed, "limit"),
          cursor: str(parsed, "cursor"),
          includeArchived: bool(parsed, "include-archived", false)
        })
        return ["memory.list", result] as const
      })

    case "entity activity":
      return Effect.gen(function* () {
        const result = yield* ops.entityActivity({
          entityType: str(parsed, "type"),
          limit: int(parsed, "limit"),
          includeArchived: bool(parsed, "include-archived", false)
        })
        return ["entity.activity", result] as const
      })

    case "task add":
      return Effect.gen(function* () {
        const title = str(parsed, "title") ?? ""
        const result = yield* ops.writeMemory({
          title,
          // The claim defaults to the title, because a task's statement and its name are usually the
          // same sentence, and a required second phrasing would be restated verbatim every time.
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
            // means this is normally false. It is reported anyway, because a caller cannot tell a
            // fresh file from a returned one without it.
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
          includeArchived: bool(parsed, "include-archived", false),
          detected: bool(parsed, "detected", false)
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
        const maxLlmCalls = int(parsed, "max-llm-calls")
        const report = yield* sleep.run({
          date: str(parsed, "date") ?? (yield* today),
          ...(phases === undefined ? {} : { phases }),
          dryRun: bool(parsed, "dry-run", false),
          deep: bool(parsed, "deep", false),
          ...(maxLlmCalls === undefined ? {} : { maxLlmCalls })
        })
        const payload = sleepRunReport(report)
        return ["sleep.report", payload, sleepExit(payload)] as const
      })

    case "sleep resume":
      return Effect.gen(function* () {
        const sleep = yield* Sleep
        const report = yield* sleep.resume(parsed.positional[0] ?? "")
        const payload = sleepRunReport(report)
        return ["sleep.report", payload, sleepExit(payload)] as const
      })

    case "sleep review":
      return Effect.gen(function* () {
        const sleep = yield* Sleep
        const report = yield* sleep.review(parsed.positional[0])
        const withDiff = bool(parsed, "diff", false)
        if (!withDiff) return ["sleep.review", report] as const
        // The raw diff is fetched here rather than inside `review`, because it is the one field whose
        // size is unbounded, and a review that always carried it would make the default response
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
         * cannot land. `@memhtml/sleep` takes the gate as a parameter and supplies none, so a package
         * that cannot import the eval also cannot silently default it. The composition is visible in
         * this wiring or it does not exist.
         *
         * `discriminationGate` fails on an inversion, `merge` wraps it in `Effect.result`, and the
         * failure becomes `refusal: "gate-failed"` with `main` never moving.
         *
         * `fake` mode, always. The gate measures the ranking stack against its own generated fixture
         * corpus, so a live-Bedrock run would make an unattended merge conditional on a network call and
         * on credentials being present at 3am. The deterministic embedder's cosine relations are
         * a pure function of the text, which is the property a regression gate needs. A
         * cron whose merge silently skipped its gate because a token expired is the failure this
         * arrangement prevents.
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
 * Derived rather than listed. A service added to `layerCore` becomes available to a handler with no
 * edit here, and a service removed from the layer becomes a compile error at
 * the handler that reads it, rather than a runtime "service not found" at the one moment an operator
 * is running the command.
 */
type DispatchServices = Layer.Success<ReturnType<typeof layerApp>>

/**
 * An unknown command, with candidates measured against the whole typed invocation.
 *
 * `parseArgv` only matches a compound name exactly, so a typo in either word of `memhtml index rebuild`
 * leaves `command` holding the first token alone and every remaining token in `positional`.
 * Measuring `"index"` against the flat name list scores `init` at 2 and `index rebuild` at 8, so the
 * suggestion an operator needs loses to one they did not ask for. Re-joining the tokens makes
 * the distance a comparison of the two things: `"index rebiuld"` is 2 from `index rebuild` and 12
 * from `init`.
 *
 * Both are offered, the joined form first, because the typo could be in either half. A one-word
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
 * The commands where the article body comes from either a claim or pre-authored markup, never both.
 *
 * Listed here rather than expressed in `FlagSpec`, because `FlagSpec` has one `required: boolean` and
 * no notion of a conditional. Inventing a table field for a rule that holds on two commands
 * would put a second, weaker copy of this check into the manifest for every command that does not
 * need it. Both flag descriptions state the rule, so `memhtml manifest` still carries it.
 */
const EITHER_CLAIM_OR_ARTICLE: ReadonlySet<string> = new Set(["write", "correct"])

/**
 * `memhtml exec` takes at most one script door, and a bound inside the cap.
 *
 * Here for the reason `claimOrArticle` is: `validate`'s return becomes exit 2 and a failure raised in
 * `dispatch` becomes exit 1, so "you passed the wrong flags" must be decided before any service is
 * built. Mutually exclusive parameters are refused at this edge, before dispatch, because a refusal
 * raised any later is masked as a runtime error
 * (`.erpaval/solutions/api-patterns/xor-params-and-mcp-error-masking.md`).
 *
 * At most one rather than exactly one, because zero doors is legal and means stdin, the same shape
 * `memhtml apply` has, where a bare invocation drains the pipe. `--file -` is the flag spelling of
 * stdin and counts as no door at all. A missing script is not a usage error
 * here. An empty one is, and that check sits beside the read in {@link run} because reading is async.
 *
 * `--timeout-ms` is checked for a positive integer within the cap. Zero and negatives are refused
 * rather than clamped, because just-bash treats a non-positive `maxJsTimeoutMs` as no bound at all, so
 * `--timeout-ms 0` would read as "be quick" and mean "run forever".
 */
const execFlags = (parsed: Parsed): Failure | undefined => {
  if (parsed.command !== "exec") return undefined

  const file = str(parsed, "file")
  const doors = [
    // `--file -` is the flag spelling of stdin, not a file door.
    file === undefined || file === "-" ? undefined : "--file",
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
  // `-`, positional or as `--file -`, is the explicit stdin spelling, so it cannot sit beside a door.
  if (doors.length === 1 && (parsed.positional[0] === "-" || file === "-")) {
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
 * `memhtml apply` takes at most one op-stream source.
 *
 * The same rule `execFlags` holds for a script, on the same two spellings: `-` (positional or as
 * `--file -`) names stdin, and stdin beside a real `--file` is two streams claiming to be the one
 * that applies. Refused here so the answer is exit 2, matching exec, rather than one of the
 * sources being silently ignored.
 */
const applyFlags = (parsed: Parsed): Failure | undefined => {
  if (parsed.command !== "apply") return undefined
  const file = str(parsed, "file")
  if (file !== undefined && file !== "-" && parsed.positional[0] === "-") {
    return fail(
      "ERR_INVALID_FLAG",
      "apply cannot read stdin and --file in the same call: `-` names stdin as the op stream",
      ["cat ops.jsonl | memhtml apply", "memhtml apply --file ops.jsonl"]
    )
  }
  return undefined
}

/**
 * Exactly one of `--claim` / `--article-html`.
 *
 * Checked here rather than in the dispatch arm, because the exit code is the contract. `validate`'s
 * return is emitted as exit 2 ({@link EXIT_USAGE}), while a failure raised inside `dispatch` travels
 * through `failureFor` and becomes exit 1. Supplying the wrong flags is a usage error, and a shell
 * caller branching on the code must not see it as a runtime one.
 *
 * Two codes for two conditions, each following the convention already in this function. An absent
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
 * `--as-of` must be a value the point-in-time comparison can order.
 *
 * The flag binds twice into `coalesce(valid_from, event_at, created_at) <= ? AND (valid_until IS
 * NULL OR valid_until > ?)` (`packages/index/src/scope.ts`), where SQLite compares TEXT to TEXT.
 * Nothing there parses the value, so an unsortable one does not error — it silently answers a
 * DIFFERENT question. `--as-of "2026-08-24 13:00"` sorts after every `T`-form instant on that day
 * and before none of them, so the window it selects is not the window the caller asked for, and the
 * result set looks like a plausible point-in-time view. A usage error is the only visible answer.
 *
 * The same {@link isValidDatetime} the format enforces on `<time datetime>` and on every datetime
 * meta, so the values a caller may ASK ABOUT are exactly the values a file may STATE. Two grammars
 * here would let a caller name an instant no memory can carry.
 *
 * `ERR_INVALID_FLAG`, this function's existing code for a flag present but unusable as given, and
 * exit 2 rather than a runtime error, because `validate`'s return is the usage path. A bare
 * `--as-of` with no value is refused for the same reason a bad one is: it reads as a scoped query
 * and would return an unscoped answer.
 */
const asOfFlag = (parsed: Parsed): Failure | undefined => {
  if (parsed.flags.get("as-of") === undefined) return undefined
  const value = str(parsed, "as-of")
  if (value !== undefined && isValidDatetime(value)) return undefined
  return fail(
    "ERR_INVALID_FLAG",
    `--as-of must be an ISO date or datetime (YYYY-MM-DD or YYYY-MM-DDThh:mm:ssZ)${value === undefined ? "" : `, not "${value}"`}: the point-in-time window compares it as a string, so a value outside that grammar selects a different window rather than failing`,
    [
      `memhtml ${parsed.command} --as-of 2026-08-24`,
      `memhtml ${parsed.command} --as-of 2026-08-24T13:00:00Z`
    ]
  )
}

/**
 * A boolean flag spelled with a space-separated value.
 *
 * `--embed false` parses as `embed: true` plus a positional `"false"`, so a caller asking to SKIP
 * embedding would get embedding on and a stray token nothing reads. That is a silent wrong answer,
 * which is the one outcome this surface may not produce, so the pair is exit 2 and the message names
 * both spellings that work.
 *
 * `ERR_INVALID_FLAG`, the code for a flag present but unusable as given, and the same code the
 * closed-vocabulary and `--as-of` checks return.
 */
const strayBooleanFlags = (parsed: Parsed): Failure | undefined => {
  const stray = parsed.strayBooleanValues[0]
  if (stray === undefined) return undefined
  const [name, token] = stray
  return fail(
    "ERR_INVALID_FLAG",
    `--${name} is a boolean flag and takes no separate value, so \`--${name} ${token}\` reads as --${name} with a stray "${token}" argument`,
    [`memhtml ${parsed.command} --${name}=${token}`, `memhtml ${parsed.command} --no-${name}`]
  )
}

/**
 * The commands where a bare `-` positional names stdin rather than an argument.
 *
 * Both declare no positional argument and both document `-` as the spelling that reads the stream
 * from a pipe, so the dash is the caller doing what the flag description says rather than a surplus
 * token. Their own mutual-exclusion checks (`execFlags`, `applyFlags`) refuse a dash beside a real
 * `--file`.
 */
const STDIN_MARKER_COMMANDS: ReadonlySet<string> = new Set(["apply", "exec"])

/**
 * Positionals past what the command declares.
 *
 * The counterpart to the missing-argument check below: "absent" and "surplus" are both wrong calls
 * and both answer. Without this one a surplus positional is silently dropped — `memhtml read
 * a.html b.html` reads ONE memory and reports nothing about the second, and every mis-spelled
 * boolean value (`--embed false`) leaves one behind.
 *
 * A `repeatable` last argument turns the check off, because a variadic tail is what
 * `memhtml reinforce a.html b.html` is. That is declared in the table rather than listed here, so
 * the manifest states it and a future variadic command needs no edit to this function.
 */
const surplusArgs = (parsed: Parsed, spec: CommandSpec): Failure | undefined => {
  if (spec.args.at(-1)?.repeatable === true) return undefined
  const extra = parsed.positional
    .slice(spec.args.length)
    .filter((token) => !(token === "-" && STDIN_MARKER_COMMANDS.has(spec.name)))
  if (extra.length === 0) return undefined
  const shape =
    spec.args.length === 0
      ? `${spec.name} takes no arguments`
      : `${spec.name} takes ${spec.args.length}: ${spec.args.map((arg) => arg.name).join(", ")}`
  return fail(
    "ERR_UNEXPECTED_ARGUMENT",
    `unexpected argument: ${extra.map((token) => `"${token}"`).join(", ")}. ${shape}`,
    [`memhtml ${spec.name}${spec.args.map((arg) => ` <${arg.name}>`).join("")}`, "memhtml manifest"]
  )
}

/**
 * Validate a parsed invocation against its spec. Usage errors only; nothing here touches a service.
 *
 * Returning the failure rather than throwing keeps the exit code decision in one place. A usage
 * error is exit 2 and a runtime error is exit 1, and a validator that emitted its own envelope would
 * have to know that too.
 */
const validate = (parsed: Parsed): Failure | undefined => {
  const spec = COMMANDS.find((command) => command.name === parsed.command)
  if (spec === undefined) return unknownCommand(parsed)

  /**
   * Flags are validated against THIS command's spec plus the true globals, not the union of every
   * command's flags. A flag that is valid somewhere else is still a usage error here: an agent that
   * typed `memhtml list --status todo` meant `task list`, and silently ignoring the flag would
   * return an unfiltered answer that looks filtered. The suggestions are drawn from the whole known
   * set, so a flag that belongs to another command still points somewhere.
   */
  const allowed = new Set([
    ...GLOBAL_FLAGS.map((flag) => flag.name),
    ...spec.flags.map((flag) => flag.name)
  ])
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) {
      // A flag that is real elsewhere gets the commands that take it; a flag that is real nowhere
      // gets the nearest spellings this command does take.
      return KNOWN_FLAGS.has(name)
        ? fail(
            "ERR_INVALID_FLAG",
            `--${name} is not a flag of ${spec.name}`,
            COMMANDS.filter((command) => command.flags.some((flag) => flag.name === name))
              .slice(0, 3)
              .map((command) => `memhtml ${command.name} --${name}`)
          )
        : fail("ERR_INVALID_FLAG", `unknown flag: --${name}`, nearest(name, [...allowed]))
    }
  }

  // Before the presence checks below, because a boolean flag given a space-separated value produces
  // BOTH a wrong flag value and a surplus positional, and the flag is the mistake worth naming.
  const strayBoolean = strayBooleanFlags(parsed)
  if (strayBoolean !== undefined) return strayBoolean

  const surplus = surplusArgs(parsed, spec)
  if (surplus !== undefined) return surplus

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

  const apply = applyFlags(parsed)
  if (apply !== undefined) return apply

  // After the unknown-flag loop above, so reaching this with `--as-of` present means this command
  // declares it. The value check therefore needs no command list of its own.
  const asOf = asOfFlag(parsed)
  if (asOf !== undefined) return asOf

  /**
   * A closed-vocabulary flag is checked here rather than at the service, so a typo answers with the
   * whole vocabulary and never touches the database. Every value of a repeatable flag is checked, not
   * only the last one, so a `--type` list with one bad entry is a usage error rather than a silently
   * narrowed search.
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
 * `layer` is injectable for that reason. A test supplies the real composition over a temp
 * repo and a deterministic embedder, and every assertion below then describes the shipped path.
 *
 * `stdin` is injectable for the same reason one step further out. `memhtml apply` reads a JSONL stream
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
   * The two self-describing commands answer without building the app layer.
   *
   * `manifest` matters most here. It is the first call an agent makes and it must answer on a
   * machine with no repo, no database, and no credentials. Building the layer first would make the
   * self-description conditional on the thing it describes being already working.
   *
   * `agents-doc` is here because building the layer has a side effect. `layerDatabase` opens
   * `$MEMHTML_ROOT/.memhtml/index.db`, creating the directory and running every migration. A doc generator
   * that scaffolded a memory repo as a side effect of rendering Markdown would create `~/memhtml`
   * on any machine that ran `memhtml agents-doc --check` in CI. It reads only the command table, so it
   * has no reason to touch the app graph at all.
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
   * `serve mcp` must not build the app layer either, and here the reason is the database.
   *
   * The supervisor's only job is to spawn the server and wait. Building `layerApp` first would open
   * `$MEMHTML_ROOT/.memhtml/index.db` and run its migrations in the parent. That is a second writer
   * against the store the child exists to serve, held open for as long as the child lives, by a process
   * that never issues a query. The parent needs the resolved repo root, which is config rather than a
   * service.
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
   * `eval discriminate` does not build the app layer either, for the reason the command above gives.
   * The gate measures the ranking stack against its own generated fixture corpus in a temp directory
   * with an in-memory database, and reads the operator's `index.db` not at all. Building `layerApp`
   * would open and migrate a store this command never queries, and an operator checking the gate is
   * typically doing it while `memhtml-mcp` serves that store.
   *
   * **Exit 1 on a failed gate**, with the `ERR_DISCRIMINATION_FAILED` FAILURE envelope. A gate
   * that exited 0 and left the verdict inside the payload would be a gate every shell caller
   * forgets to read, and a gate that exited 1 inside a success envelope would be one an agent
   * branching on `code` never sees fail. The failure travels through `failureFor` like every other
   * typed failure, so the code, the one-line reason, and the recovery suggestions are the
   * documented ones.
   */
  if (parsed.command === "eval discriminate") {
    const requested = (str(parsed, "mode") ?? "fake") as EvalMode
    return Effect.runPromise(
      runDiscrimination({
        mode: requested,
        ...(int(parsed, "seed") === undefined ? {} : { seed: int(parsed, "seed") }),
        // `--seed` alone does not reproduce a run: the fixture corpus is a function of `(seed, now)`
        // and its stamps are what the recency arm ranks on, so the instant is the other half.
        ...(int(parsed, "now") === undefined ? {} : { now: int(parsed, "now") }),
        ...(int(parsed, "size") === undefined ? {} : { size: int(parsed, "size") }),
        ...(int(parsed, "probes") === undefined ? {} : { probes: int(parsed, "probes") }),
        ...(num(parsed, "mrr-floor") === undefined ? {} : { mrrFloor: num(parsed, "mrr-floor") })
      }).pipe(
        Effect.map((outcome) =>
          outcome.passed
            ? emit(succeed("eval.discrimination", outcome), EXIT_OK)
            : emit(failureFor(new DiscriminationFailed(outcome)), EXIT_RUNTIME)
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
   * `memhtml exec` does not build the app layer either, for the reason two commands over.
   *
   * The command reads a git tree and nothing else. It materializes a commit as a detached worktree and
   * mounts that directory read-only. It never queries `index.db`, so building `layerApp` would open and
   * migrate a database it does not use, on the path an agent reaches for while `memhtml serve mcp` is
   * serving the repo. Nothing here can be reached through `dispatch`, because `dispatch`'s service set
   * is the app layer's.
   *
   * **Non-zero `exitCode` in the payload is still exit 0 for the process**, and that split is the
   * contract. A failing script is a report with `stderr` an agent reads and fixes. The CLI's exit 1 is
   * reserved for the runtime failing to run the script at all (no repo, unreadable sha, absent helper).
   * Collapsing the two would make an agent unable to tell a bad selector from a broken install, and
   * would bury the script's own diagnostic inside an `error` string.
   *
   * The script is read here rather than in `runExec`, so a missing or empty script is exit 2 like every
   * other input error. `runExec` takes source, never a path.
   */
  if (parsed.command === "exec") {
    const inline = str(parsed, "script")
    // `-` names stdin in both spellings: the positional and `--file -`. Neither is a path.
    const flagFile = str(parsed, "file")
    const file = parsed.positional[0] === "-" || flagFile === "-" ? undefined : flagFile
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
   * `memhtml apply` checks the shape of its whole op stream before any service is built (AC-6-4).
   *
   * Here rather than in `validate` because reading a file is async and `validate` is a pure synchronous
   * function of the parsed argv. Here rather than in the dispatch arm because a refusal raised inside
   * `dispatch` travels through `failureFor` and becomes exit 1, while a malformed input file is a usage
   * error and must be exit 2. The caller wrote a bad file, and the corpus is fine.
   *
   * The ordering is the observable contract. Nothing is written for a file with a bad line, and at this
   * point nothing can have been, because the app layer has not been built, so no database is open and
   * no git command has run.
   */
  let applyOps: ReadonlyArray<ops.WriteParams> = []
  if (parsed.command === "apply") {
    // `-` is the explicit "read stdin" spelling in both positions — `memhtml apply -` and
    // `memhtml apply --file -` — and the dash is never a path.
    const flagFile = str(parsed, "file")
    const file = parsed.positional[0] === "-" || flagFile === "-" ? undefined : flagFile
    const text = await applyText(file, stdin)
    if (typeof text !== "string") return emit(text, EXIT_USAGE)
    const decoded = decodeApply(text)
    if (!decoded.ok) return emit(decoded.failure, EXIT_USAGE)
    applyOps = decoded.ops
  }

  const program = dispatch(parsed, applyOps).pipe(
    Effect.map(([type, data, exitCode]) => emit(succeed(type, data), exitCode ?? EXIT_OK)),
    Effect.catch((error) => Effect.succeed(emit(failureFor(error), EXIT_RUNTIME))),
    // A defect is still an answer. An unexpected throw anywhere below would otherwise reach the
    // process as an unhandled rejection and print a stack trace onto stdout. Stdout is a parse
    // target, so it carries the envelope and nothing else.
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
