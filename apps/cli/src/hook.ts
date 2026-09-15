import { stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import type { StorageFailure } from "@memhtml/contracts/errors"
import type { DatabaseShape, RetrievalShape } from "@memhtml/index"
import {
  cwdOf,
  type HookEvent,
  type HostId,
  promptOf,
  renderHookOutput
} from "@memhtml/integrations"
import { expandRoot } from "@memhtml/store"
import { ConfigProvider, Effect } from "effect"

import { Roots, type RootsShape } from "./api-layer.js"
import { MemhtmlRoot } from "./config.js"
import { indexTraces, listTasks, recallMemories, searchMemories } from "./operations.js"

/**
 * The hook engine: what an installed host hook actually runs.
 *
 * Two properties hold this whole module together, and every decision below follows from one of them.
 *
 * **It never fails.** A hook runs inside a host's turn, so a failure here is a failure of the
 * developer's session rather than of `memhtml`. Every path funnels through {@link runHook}, whose error
 * channel is `never`: a storage failure, a defect, a missing plane, and a blown deadline all become the
 * empty string, which every host reads as "this hook has nothing to add".
 *
 * **It is bounded.** `deadlineMs` is a hard bound on the whole engine, not on one query, because the
 * thing being protected is the turn: an agent waiting on recall is an agent that has not started
 * working. Expiry returns the empty string, so a slow store degrades to no injection rather than to a
 * slow session.
 *
 * The rendering is pure and exported ({@link renderPromptHits}, {@link renderSessionPack}) so the
 * shape of an injection is testable without a store, and the host's protocol is applied one layer out
 * by `renderHookOutput` — this module produces TEXT and knows nothing about JSON envelopes or which
 * host reads which stream.
 */

/** What the engine needs to answer one hook call. */
export interface HookInput {
  readonly event: HookEvent
  /**
   * Which host fired. Read for one decision only: whether this host can inject at all on this event
   * ({@link injects}). The output DIALECT is applied by the caller.
   */
  readonly host: HostId
  /** The host's hook payload, already JSON-parsed, or `undefined` when it was not parseable. */
  readonly payload: unknown
  /** Hits to inject on a per-prompt recall. */
  readonly limit: number
  /** Character budget handed to `recall` for the session-start pack. */
  readonly budget: number
  /**
   * `--trace-root`, when the caller named one.
   *
   * The indexer takes its root from the `Roots` service, which `layerRoots` resolves from
   * `MEMHTML_TRACE_ROOT` — there is no override parameter on `indexTraces()` and no roots-override
   * layer, so the CALLER applies this as that variable, through {@link hookConfigProvider} beside the
   * layer. It is carried here to be VERIFIED rather than to be applied: indexing the wrong transcript tree
   * would advance a watermark over files the host never wrote, which is worse than indexing none, so a
   * mismatch between this value and the resolved root declines the work with a warning.
   */
  readonly traceRoot?: string
  /** The hard bound on the whole engine. Expiry is the empty string. */
  readonly deadlineMs: number
}

/** The events that INDEX transcripts rather than inject text. Both produce no output, ever. */
export const INDEXING_EVENTS: ReadonlySet<HookEvent> = new Set(["pre-compact", "session-end"])

/** The default `--limit`, and the value `commands.ts` states as the flag's documented default. */
export const HOOK_LIMIT_DEFAULT = 5

/** The default `--budget`, and the value `commands.ts` states as the flag's documented default. */
export const HOOK_BUDGET_DEFAULT = 3000

/** How long a recall event may take before the turn wins. */
export const HOOK_RECALL_DEADLINE_MS = 1500

/**
 * How long an indexing event may take. Longer than a recall's bound because nothing waits on it: a
 * `PreCompact` or `SessionEnd` hook injects nothing, and a scan that reaches the watermark leaves less
 * for the next one. Still bounded, because a host that kills the process would lose the whole scan.
 */
export const HOOK_INDEX_DEADLINE_MS = 10_000

/** A gist is cut to this, so one memory can never dominate an injected block. */
export const GIST_MAX_CHARS = 240

/** Open tasks listed on a session-start injection, at most. */
export const OPEN_TASK_LIMIT = 5

/** The statuses that mean "open work". `ListTasksParams.status` is scalar, so this is one call each. */
export const OPEN_TASK_STATUSES = ["todo", "doing"] as const

/**
 * The per-prompt header. It says three things on purpose: that these are the RANKER's guesses rather
 * than facts the agent may cite, that `memory_read` is how a body is obtained, and that
 * `memory_reinforce` is how the guess becomes evidence. Salience only moves on a read or an outcome
 * (`operations.ts`), so a block that did not ask for those two calls would inject memories that can
 * never learn from having been useful.
 */
export const PROMPT_HEADER =
  "memhtml recall for this prompt (ranker's guess, not a citation; memory_read before quoting, memory_reinforce after use):"

/** The session-start header, naming the directory the pack was recalled for. */
export const sessionHeader = (label: string): string =>
  `memhtml memory for ${label} (recall pack; memory_read before quoting):`

/** The line that introduces the open-task tail. */
export const OPEN_TASKS_HEADER = "open tasks:"

/** One character-bounded gist. The marker is kept inside the bound, never appended past it. */
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** The minimum a hit needs to render. Structural, so a test needs no `SearchHit`. */
export interface HookEntry {
  readonly path: string
  readonly title: string
  readonly gist: string
}

/** One line: title, gist, and the path an agent hands straight to `memory_read`. */
const entryLine = (entry: HookEntry): string =>
  `- ${entry.title} — ${clip(entry.gist, GIST_MAX_CHARS)} [${entry.path}]`

/**
 * The per-prompt injection: a header and one line per hit.
 *
 * No hits is the empty string rather than a header with nothing under it. A header alone would spend
 * context to say "nothing found", once per prompt, for the whole session.
 */
export const renderPromptHits = (hits: ReadonlyArray<HookEntry>, limit: number): string => {
  const lines = hits.slice(0, Math.max(0, limit)).map(entryLine)
  return lines.length === 0 ? "" : [PROMPT_HEADER, ...lines].join("\n")
}

/** The two folds of a recall pack, as much of them as this renderer reads. */
export interface HookPack {
  readonly arcs: {
    readonly disclosed: ReadonlyArray<HookEntry>
    readonly indexLines: ReadonlyArray<HookEntry>
  }
  readonly memories: {
    readonly disclosed: ReadonlyArray<HookEntry>
    readonly indexLines: ReadonlyArray<HookEntry>
  }
}

/** The minimum a task row needs to render. Structural, for the reason {@link HookEntry} is. */
export interface HookTask {
  readonly path: string
  readonly title: string
  readonly taskStatus: string | null
}

/**
 * The session-start injection: the recall pack as a compact index, then open tasks.
 *
 * The pack's DISCLOSED BODIES are deliberately not injected, only their gists. `--budget` still does
 * the work that matters — it decides which memories `recall` thought were worth spending on, and the
 * disclosed tier comes first within each fold, so the ordering carries the tiering — while the injected
 * block stays a bounded index a session can afford at every start. Arcs precede ordinary memories
 * because an arc is the general rule and a memory is one instance of it.
 *
 * Empty is empty: no memories and no tasks renders nothing at all, not a header.
 */
export const renderSessionPack = (input: {
  readonly label: string
  readonly pack: HookPack
  readonly tasks: ReadonlyArray<HookTask>
}): string => {
  const entries = [
    ...input.pack.arcs.disclosed,
    ...input.pack.arcs.indexLines,
    ...input.pack.memories.disclosed,
    ...input.pack.memories.indexLines
  ]
  const memoryLines = entries.map(entryLine)
  const taskLines = input.tasks.map(
    (task) =>
      `- ${task.title}${task.taskStatus === null ? "" : ` (${task.taskStatus})`} [${task.path}]`
  )
  if (memoryLines.length === 0 && taskLines.length === 0) return ""
  return [
    sessionHeader(input.label),
    ...memoryLines,
    ...(taskLines.length === 0 ? [] : [OPEN_TASKS_HEADER, ...taskLines])
  ].join("\n")
}

/**
 * The query a session start recalls on: the working directory's own name and its parent's.
 *
 * A path is not a query, and its middle is noise — `/home/me/work/worktrees/memhtml-integrations`
 * shares `home`, `me`, and `work` with every other checkout on the machine. The leaf names the thing
 * being worked on and the parent names the family it belongs to (`memhtml-integrations worktrees`),
 * which is exactly the two-token query a lexical arm can rank on.
 */
export const queryForCwd = (cwd: string): string => {
  const leaf = basename(cwd)
  const parent = basename(dirname(cwd))
  const words = [leaf, parent].filter((word) => word !== "" && word !== "." && word !== "/")
  return [...new Set(words)].join(" ")
}

/**
 * Whether this host reads anything a hook writes on this event.
 *
 * Asked of the DIALECT rather than restated here, so the one table that knows Cursor cannot inject on
 * a per-prompt hook is the one that renders it. The probe text is arbitrary: `renderHookOutput` returns
 * the empty string for every event a host ignores and something non-empty for every event it reads.
 *
 * Checked BEFORE the store is touched, so a host that cannot inject spends no part of the turn on a
 * query whose result it would discard.
 */
export const injects = (host: HostId, event: HookEvent): boolean =>
  renderHookOutput(host, event, "probe") !== ""

/** `user-prompt-submit`: search on the prompt, inject the hits. */
const promptRecall = (input: HookInput) =>
  Effect.gen(function* () {
    const prompt = promptOf(input.payload)
    if (prompt === undefined) return ""
    const result = yield* searchMemories({ query: prompt, limit: input.limit })
    return renderPromptHits(result.hits, input.limit)
  })

/**
 * `session-start`: recall on the working directory, then the open task queue.
 *
 * The task list is a SEPARATE call from recall on purpose: `SearchScope` excludes `task` from every
 * unscoped query (a corpus with fifty to-do items would crowd out the knowledge the session asked
 * for), so the working set has to arrive through the direct indexed scan that exists for it. It is also
 * two calls rather than one, because `ListTasksParams.status` is scalar and open work is two statuses.
 *
 * A failing task scan does not cost the memories. A store with no state plane, or a task query that
 * fails, leaves the pack intact and the tail absent.
 */
const sessionPack = (input: HookInput) =>
  Effect.gen(function* () {
    const cwd = cwdOf(input.payload)
    if (cwd === undefined) return ""
    const label = basename(cwd)
    const pack = yield* recallMemories({ query: queryForCwd(cwd), budgetChars: input.budget })
    const tasks = yield* openTasks
    return renderSessionPack({ label, pack, tasks })
  })

/** Open tasks, at most {@link OPEN_TASK_LIMIT}, path-ordered within each status. */
const openTasks = Effect.forEach(OPEN_TASK_STATUSES, (status) =>
  listTasks({ status, limit: OPEN_TASK_LIMIT })
).pipe(
  Effect.map((pages) => pages.flatMap((page) => page.tasks).slice(0, OPEN_TASK_LIMIT)),
  Effect.orElseSucceed((): ReadonlyArray<HookTask> => [])
)

/**
 * `pre-compact` and `session-end`: index the host's transcripts, inject nothing.
 *
 * The empty string is the whole output contract for these two events on every host — Claude Code and
 * Codex ignore a `PreCompact`/`SessionEnd` hook's stdout entirely — so the work here is a WRITE to the
 * trace plane and the return value is a constant.
 */
const indexTranscripts = (input: HookInput) =>
  Effect.gen(function* () {
    const roots = yield* Roots
    const asked = input.traceRoot === undefined ? undefined : expandRoot(input.traceRoot)
    if (asked !== undefined && asked !== roots.traceRoot) {
      /**
       * The override did not reach the layer. Declining is the safe half: `scanTraceRoot` advances a
       * watermark, so scanning the DEFAULT root here would record progress against a tree the caller
       * did not name and the next correctly-configured run would skip those files.
       */
      yield* Effect.logWarning(
        `hook: --trace-root ${asked} did not reach the layer (resolved ${roots.traceRoot}); nothing indexed`
      )
      return ""
    }
    yield* indexTraces()
    return ""
  })

/**
 * The event table, as one Effect rather than a union of four.
 *
 * The return type is annotated rather than inferred, and it has to be: each arm needs a different
 * subset of the graph (search wants `Retrieval`, the task tail wants the database, indexing wants
 * `Roots`), and a UNION of requirement sets is not a set of requirements anything can provide. Stating
 * the union of what the whole engine may need is what makes `runHook` one providable effect.
 */
const engine = (
  input: HookInput
): Effect.Effect<string, StorageFailure, RetrievalShape | DatabaseShape | RootsShape> => {
  if (!injects(input.host, input.event) && !INDEXING_EVENTS.has(input.event)) {
    return Effect.succeed("")
  }
  switch (input.event) {
    case "user-prompt-submit":
      return promptRecall(input)
    case "session-start":
      return sessionPack(input)
    case "pre-compact":
    case "session-end":
      return indexTranscripts(input)
  }
}

/**
 * Run one hook. Never fails, never exceeds `deadlineMs`, and returns the TEXT to inject.
 *
 * `Effect.timeout` rather than a checked clock, because the bound has to interrupt work that is
 * already running — a query that has begun is exactly the thing a turn cannot wait for. What it can
 * interrupt is an ASYNC stall: an embedder waiting on Bedrock, a fiber that yields, a scan large enough
 * to cross a yield point. It cannot preempt one synchronous `node:sqlite` call, because nothing in this
 * process can; measured against a fixture store, a whole `search` completes inside one tick and the
 * timer never gets the loop. The bound is therefore about the edge that can actually stall rather than
 * about a slow local query, and the tests assert it where it is assertable. The
 * `catchCause` below it is what makes the error channel `never`: it catches the `TimeoutError` the
 * bound raises, every typed storage failure under it, and any defect, and answers all three with the
 * empty string. There is deliberately no way for a caller to tell those apart from a quiet store,
 * because a hook has no channel in which to report one.
 */
export const runHook = (input: HookInput) =>
  engine(input).pipe(
    Effect.timeout(input.deadlineMs),
    Effect.catchCause(() => Effect.succeed(""))
  )

/**
 * Whether a store exists at the root a hook would open, without creating anything.
 *
 * A hook must never SCAFFOLD a store, and this is the check that guarantees it. Building the app layer
 * opens `<root>/.memhtml/index.db` through `makeDatabase`, which `mkdir -p`s the directory first — so a
 * host whose config carries a stale or mistyped root would have its every session start silently
 * create a memory repo that nothing else ever reads. `.git` is the probe rather than the directory
 * itself, because a memhtml root IS a git repository; a worktree's `.git` is a file, which `stat`
 * answers for as well.
 *
 * `false` means the caller prints nothing and exits 0, the same answer every other failure gets.
 */
export const hookStoreReady = (repoOverride?: string | undefined) =>
  Effect.gen(function* () {
    const configured = yield* MemhtmlRoot
    const named = repoOverride?.trim()
    const root = named !== undefined && named !== "" ? expandRoot(named) : configured
    return yield* Effect.tryPromise(() => stat(join(root, ".git"))).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
  })

/**
 * The configuration the hook's layer is built from: this process's environment, with `--trace-root`
 * applied as `MEMHTML_TRACE_ROOT`.
 *
 * A provider rather than a mutation of `process.env`, and the difference is measurable rather than
 * stylistic. `ConfigProvider` is a `Context.Reference` whose default is `fromEnv()`, constructed once
 * and cached, so a variable set after the first `Config` read in a process is never seen — probed
 * 2026-09-13 in this suite: setting `MEMHTML_TRACE_ROOT` before building the layer resolved the
 * `~/.claude` default anyway, because an earlier test had already read config in the same worker.
 * Provided beside the layer, the value cannot depend on what else the process read first.
 *
 * `MEMHTML_TRACE_ROOT` is still the only door `layerRoots` has — `indexTraces()` reads `Roots.traceRoot`
 * and neither it nor `layerApp` takes an override — so this sets exactly that variable rather than
 * inventing a second name for it.
 */
export const hookConfigProvider = (
  traceRoot?: string | undefined
): ConfigProvider.ConfigProvider => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined)
  ) as Record<string, string>
  const named = traceRoot?.trim()
  return ConfigProvider.fromEnv({
    env: named === undefined || named === "" ? env : { ...env, MEMHTML_TRACE_ROOT: named }
  })
}

/**
 * How long the engine waits for the host to finish writing its payload.
 *
 * The engine's own `deadlineMs` cannot bound this: the read happens before any Effect runs, and a host
 * that spawned the hook and then never wrote or closed the descriptor would hold the turn open forever
 * with the deadline never started. A payload is a few hundred bytes on a pipe the host has already
 * written, so anything past this is a host that is not going to write one.
 */
export const HOOK_STDIN_DEADLINE_MS = 500

/**
 * The host's payload: drain stdin under a bound, then parse.
 *
 * Every failure is the same answer as everywhere else in this module — no payload. A read that throws,
 * a host that writes nothing, and a host that never closes the pipe are indistinguishable to the
 * engine, and all three mean "this hook has nothing to search for".
 */
export const readHookPayload = async (
  stdin: () => Promise<string>,
  timeoutMs: number = HOOK_STDIN_DEADLINE_MS
): Promise<unknown> => {
  const raw = await Promise.race([
    stdin().catch(() => ""),
    new Promise<string>((resolve) => {
      // `unref` so a pipe that never closed cannot be the reason the process stays alive.
      setTimeout(() => resolve(""), timeoutMs).unref()
    })
  ])
  return parseHookPayload(raw)
}

/**
 * The host's hook payload, parsed.
 *
 * Unparseable is `undefined` rather than an error, and that is the same decision as everything else in
 * this module: a host that changed its payload shape, wrote nothing, or wrote a log line to the pipe
 * gets a hook that injects nothing, not a hook that fails inside its turn. `promptOf` and `cwdOf`
 * already read `undefined` as "no prompt" and "no cwd".
 */
export const parseHookPayload = (raw: string): unknown => {
  if (raw.trim() === "") return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}
