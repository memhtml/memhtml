import { join } from "node:path"

import { HEAD_SOCKET } from "@memhtml/session"
import { Schema } from "effect"

/**
 * The head server's wire contract (`docs/v2-poc.md`, "Head server"): JSON over HTTP on a Unix domain
 * socket inside the store, five routes under one version prefix.
 *
 * The server (`head-server.ts`) decodes every request body with the schemas here, excess properties
 * refused, the way the CLI refuses an unknown flag; the client (`head-client.ts`) decodes every
 * answer with them, so a server of another version reads as no server rather than as a wrong answer.
 * A new route or a new version is a new prefix: `/v1/` never changes meaning.
 */

/** The protocol version, the prefix of every route. */
export const HEAD_PROTOCOL = "1"

export const HEAD_ROUTES = {
  status: `/v${HEAD_PROTOCOL}/status`,
  search: `/v${HEAD_PROTOCOL}/search`,
  read: `/v${HEAD_PROTOCOL}/read`,
  neighbors: `/v${HEAD_PROTOCOL}/neighbors`,
  exec: `/v${HEAD_PROTOCOL}/exec`
} as const

export type HeadRoute = keyof typeof HEAD_ROUTES

/** The socket's absolute path in a store: `.memhtml/head.sock`. */
export const headSocketPath = (root: string): string => join(root, HEAD_SOCKET)

/**
 * The longest socket path `bind(2)` takes on Linux: `sun_path` is 108 bytes with the terminating
 * NUL. A store nested deeper than that cannot host a server, and says so rather than failing inside
 * the listen call.
 */
export const SOCKET_PATH_MAX = 107

// ---------------------------------------------------------------------------------------------
// The embed path
// ---------------------------------------------------------------------------------------------

/**
 * How long a search waits for its query embed by default, in milliseconds. Sized for the fleet's
 * pre-turn lookup, which gives the socket 0.8 s of a 1.5 s budget: embeds through the proxy measured
 * 171 ms at p50 and 458 ms at p95 on 2026-09-28, and the one in the incident this bound answers took
 * 741 ms, so 450 ms keeps about 19 embeds in 20 and leaves the rest of the 0.8 s for the round trip
 * and the fold.
 */
export const EMBED_DEADLINE_DEFAULT_MS = 450

/**
 * The variable that overrides {@link EMBED_DEADLINE_DEFAULT_MS}: a whole number of milliseconds, `0`
 * for no deadline. Read by `head search` and by `head serve`, where a request's `embedDeadlineMs`
 * wins over it.
 */
export const EMBED_DEADLINE_VAR = "MEMHTML_EMBED_DEADLINE_MS"

/**
 * How long without an embed before the server warms the embed path, in milliseconds. A judgment,
 * not a measured cliff: probed 2026-09-28 through the bedrock-lanes agentgateway, no idle gap up to
 * 900 s made the next embed slower (`docs/v2-poc.md`, "Keeping the embed path warm"), so 45 s is
 * short enough that a pool with an idle timeout of a minute or more never idles out between warmups.
 */
export const EMBED_WARM_IDLE_DEFAULT_MS = 45_000

/** The variable that overrides {@link EMBED_WARM_IDLE_DEFAULT_MS}; `0` turns the warmup off. */
export const EMBED_WARM_IDLE_VAR = "MEMHTML_EMBED_WARM_IDLE_MS"

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * `POST /v1/search`: the input object `searchHead` takes, passed through whole, plus
 * `embedDeadlineMs`, the one field the server reads itself: how long this answer may wait for its
 * query embed, in milliseconds, `0` for no bound. Absent, the server's own deadline applies
 * (`MEMHTML_EMBED_DEADLINE_MS` in the server's environment, else {@link EMBED_DEADLINE_DEFAULT_MS}). An option `searchHead` gains later is one more optional
 * field here and on the client, and the route, the body's shape, and every older field stay as
 * they are.
 */
export const SearchRequest = Schema.Struct({
  query: Schema.String,
  limit: Schema.optionalKey(Schema.Int),
  now: Schema.optionalKey(Schema.String),
  embedDeadlineMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 }))
  )
})
export type SearchRequest = typeof SearchRequest.Type

/** `POST /v1/read`: one record by repo-relative path. */
export const ReadRequest = Schema.Struct({ path: Schema.String })

const OverlayOpSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("put"), path: Schema.String, html: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("archive"),
    path: Schema.String,
    to: Schema.String,
    html: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("link"),
    path: Schema.String,
    rel: Schema.String,
    href: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("unlink"),
    path: Schema.String,
    rel: Schema.String,
    href: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literals(["label", "unlabel"]),
    path: Schema.String,
    entity: Schema.String
  })
])

/** One `write` op as `session put` decoded it from its JSONL (`WriteParams`). */
const WriteParamsSchema = Schema.Struct({
  title: Schema.String,
  claim: Schema.String,
  body: Schema.optionalKey(Schema.Array(Schema.String)),
  articleHtml: Schema.optionalKey(Schema.String),
  memoryType: Schema.String,
  path: Schema.optionalKey(Schema.String),
  strictPath: Schema.optionalKey(Schema.Boolean),
  workspace: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  entities: Schema.optionalKey(Schema.Array(Schema.String)),
  importance: Schema.optionalKey(Schema.Finite),
  confidence: Schema.optionalKey(Schema.Finite),
  taskStatus: Schema.optionalKey(Schema.String),
  dueAt: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  promptId: Schema.optionalKey(Schema.String),
  turnUuid: Schema.optionalKey(Schema.String)
})

/** One `session put` line as `decodeSessionPut` decoded it (`SessionPutOp`). */
const SessionPutOpSchema = Schema.Union([
  Schema.Struct({ op: Schema.Literal("write"), params: WriteParamsSchema }),
  Schema.Struct({
    op: Schema.Literals(["label", "unlabel"]),
    path: Schema.String,
    entity: Schema.String
  })
])

/**
 * `POST /v1/neighbors`: what `session put` computes before it appends, asked of the version at the
 * session's base. `ops` is the session's log as the client read it, `lines` the new ops (`write`,
 * `label`, and `unlabel` lines in file order), `at` the instant the writes are stamped with, so the
 * server's answer is a function of the request, the commit `sha` names, and the vector cache it
 * holds, never of the ref it follows.
 */
export const NeighborsRequest = Schema.Struct({
  sha: Schema.String,
  ops: Schema.Array(OverlayOpSchema),
  lines: Schema.Array(SessionPutOpSchema),
  at: Schema.String,
  /** The session is run-bound (`MEMHTML_SESSION`): `duplicate` and `claim-edit` block too. Absent is false. */
  runBound: Schema.optionalKey(Schema.Boolean)
})
export type NeighborsRequest = typeof NeighborsRequest.Type

/**
 * The largest `POST /v1/exec` body the server reads, in bytes: 1 MiB. The body is the script as JSON
 * text, so this bounds a script at a little under it. Sized from the 2026-09-23 store clone, whose
 * memory records are 1.3 KB at the median, 23 KB at the 99th percentile, and 62 KB at most: a
 * heredoc under the cap writes about 800 median records or 16 of the largest, and a batch past that
 * is several execs. Above it the server answers 413 with `ERR_INVALID_FLAG` without reading the rest,
 * and the CLI refuses the same script at exit 2 before it asks, with the server or without it, so a
 * script's fate never depends on whether a server is running.
 */
export const EXEC_BODY_MAX_BYTES = 1_048_576

/**
 * `POST /v1/exec`: run a script over a session's view and append its harvest, as `session exec`
 * does. The server reads the session's log itself, so a request names the session and nothing
 * about its state. `timeoutMs` absent is the CLI's default, the cap applied either way.
 */
export const ExecRequest = Schema.Struct({
  id: Schema.String,
  script: Schema.String,
  lang: Schema.Literals(["bash", "js"]),
  timeoutMs: Schema.optionalKey(Schema.Int),
  /** As on `/v1/neighbors`. Sent only when true, so a call outside a run reads on an older server. */
  runBound: Schema.optionalKey(Schema.Boolean)
})
export type ExecRequest = typeof ExecRequest.Type

/**
 * The longest a `/v1/exec` waits before its script starts, twice over: once for the same session's
 * earlier exec (a session runs one exec at a time, so the second sees the first's harvest), and once
 * for a free worker. Past either the server declines with `busy` and has run nothing, so the client
 * runs the script itself; the client's answer timeout is built from this (`execAnswerTimeoutMs`).
 */
export const EXEC_QUEUE_WAIT_MS = 30_000

/** The request `session exec` sends, and its size on the wire, which the cap is measured against. */
export const execRequestOf = (input: {
  readonly id: string
  readonly script: string
  readonly lang: "bash" | "js"
  readonly timeoutMs?: number | undefined
  readonly runBound?: boolean | undefined
}): ExecRequest => ({
  id: input.id,
  script: input.script,
  lang: input.lang,
  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  ...(input.runBound === true ? { runBound: true } : {})
})

export const execBodyBytes = (request: ExecRequest): number =>
  Buffer.byteLength(JSON.stringify(request), "utf8")

/** The usage error a body over {@link EXEC_BODY_MAX_BYTES} earns, on the socket and in the CLI alike. */
export const execBodyTooLarge = (bytes: number | null): string =>
  `session exec takes a script whose request body is at most ${String(EXEC_BODY_MAX_BYTES)} bytes (1 MiB)${bytes === null ? "" : `; this one is ${String(bytes)}`}. Split it into several execs, or write records with \`session put\``

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

const HeadSourceSchema = Schema.Literals(["snapshot", "snapshot+advance", "git"])

const VectorSkipReasonSchema = Schema.Literals([
  "embedder-off",
  "no-cache",
  "cache-unreadable",
  "embed-failed",
  "embed-timeout"
])

/** The vector arm's report on one answer, the `vector` field local `head search` returns (`VectorUse`). */
export const VectorUseSchema = Schema.Struct({
  used: Schema.Boolean,
  reason: Schema.NullOr(VectorSkipReasonSchema),
  detail: Schema.NullOr(Schema.String),
  cached: Schema.NullOr(Schema.Finite),
  coverage: Schema.NullOr(Schema.Finite),
  loadMs: Schema.NullOr(Schema.Finite),
  embedMs: Schema.NullOr(Schema.Finite)
})

/**
 * What the server's background fill of the vector cache has done: whether one is running, the
 * records it embedded and the batches it sent, its failures with the latest one's reason, and the
 * latest batch's time and instant. A failed batch is tried again on the next advance or warmup tick.
 */
export const VectorBackfillStatus = Schema.Struct({
  running: Schema.Boolean,
  embedded: Schema.Finite,
  batches: Schema.Finite,
  failures: Schema.Finite,
  lastError: Schema.NullOr(Schema.String),
  lastMs: Schema.NullOr(Schema.Finite),
  lastAt: Schema.NullOr(Schema.String)
})

/**
 * The most records one background fill batch embeds: Cohere's per-request ceiling, so a batch is
 * one request. A landing that brings more is filled a batch at a time, one after another.
 */
export const BACKFILL_BATCH_MAX = 96

/**
 * The vector cache a server holds, for `status`: its entries, the share of the held version's
 * active records they cover, what reading it took, and the file's mtime; or, with `held: false`,
 * why there is none (`embedder-off`, `no-cache`, `cache-unreadable` with the reader's refusal in
 * `detail`). `loads` counts reads of the file: one at start, one per change of its mtime. `pending`
 * is the distinct article texts of the held version's active records that have no vector yet
 * (`null` with no cache held), which the background fill (`backfill`) works down.
 */
export const VectorCacheStatus = Schema.Struct({
  held: Schema.Boolean,
  reason: Schema.NullOr(VectorSkipReasonSchema),
  detail: Schema.NullOr(Schema.String),
  path: Schema.String,
  entries: Schema.NullOr(Schema.Finite),
  coverage: Schema.NullOr(Schema.Finite),
  loadMs: Schema.NullOr(Schema.Finite),
  mtime: Schema.NullOr(Schema.String),
  loads: Schema.Finite,
  pending: Schema.NullOr(Schema.Finite),
  backfill: VectorBackfillStatus
})
export type VectorCacheStatus = typeof VectorCacheStatus.Type

/** The exec pool as `status` reports it. */
export const ExecPoolStatus = Schema.Struct({
  size: Schema.Finite,
  idle: Schema.Finite,
  busy: Schema.Finite,
  started: Schema.Finite,
  killed: Schema.Finite,
  jobs: Schema.Finite
})

/**
 * The embedder's traffic as `status` reports it: the query-embed deadline the server applies to a
 * request that names none (`null`: no bound), the idle time after which it warms the embed path
 * (`null`: never), embeds in flight now, when the last one ended, and the counters. `timeouts` is
 * searches that answered without the arm because the deadline passed; each such embed was either
 * `lateKept` (left to finish in the background, at most {@link LATE_EMBEDS_MAX} at once, `lateInFlight`
 * now) or `lateStopped` (interrupted, its request aborted). `warmups` is the one-token embeds the
 * idle timer issued, `warmupFailures` those that failed, and `lastWarmupMs` the latest one's time.
 */
export const EmbedActivityStatus = Schema.Struct({
  deadlineMs: Schema.NullOr(Schema.Finite),
  warmIdleMs: Schema.NullOr(Schema.Finite),
  inFlight: Schema.Finite,
  lastEmbedAt: Schema.NullOr(Schema.String),
  timeouts: Schema.Finite,
  lateKept: Schema.Finite,
  lateStopped: Schema.Finite,
  lateInFlight: Schema.Finite,
  warmups: Schema.Finite,
  warmupFailures: Schema.Finite,
  lastWarmupMs: Schema.NullOr(Schema.Finite)
})
export type EmbedActivityStatus = typeof EmbedActivityStatus.Type

/**
 * Query embeds a server lets run past their deadline at once. One is enough to finish the cold
 * connection the miss was waiting on, which is what makes the next query warm; a second miss while
 * it runs is interrupted instead, so a slow proxy can never collect a pile of background calls.
 */
export const LATE_EMBEDS_MAX = 1

/** `GET /v1/status`. */
export const HeadServerStatus = Schema.Struct({
  protocol: Schema.Literal(HEAD_PROTOCOL),
  pid: Schema.Finite,
  root: Schema.String,
  socket: Schema.String,
  /** The ref the server follows. */
  ref: Schema.String,
  /** The commit the server's version is at, after the advance this request triggered, if any. */
  sha: Schema.String,
  records: Schema.Finite,
  /** The initial load's skip count from git; `null` when it came from a snapshot. */
  skipped: Schema.NullOr(Schema.Finite),
  /** How the server's first version was built: the path `loadHeadAt` took. */
  loadSource: HeadSourceSchema,
  loadMs: Schema.Finite,
  /** How long the last advance took, or `null` when the ref has not moved since the load. */
  lastAdvanceMs: Schema.NullOr(Schema.Finite),
  /** Advances since the load: one per observed ref move, however many requests saw it. */
  advances: Schema.Finite,
  requests: Schema.Finite,
  uptimeMs: Schema.Finite,
  /** The background poll's period; 0 when requests alone advance the version. */
  pollMs: Schema.Finite,
  startedAt: Schema.String,
  vectors: VectorCacheStatus,
  /** The embedder's deadline, warmups, and traffic; with no embedder, zeros and nulls. */
  embed: EmbedActivityStatus,
  /** The workers `/v1/exec` runs scripts in: how many run at once, and what they have done. */
  exec: ExecPoolStatus
})
export type HeadServerStatus = typeof HeadServerStatus.Type

/** The version an answer was computed over. */
export const ServedHead = Schema.Struct({
  sha: Schema.String,
  ref: Schema.String,
  records: Schema.Finite,
  skipped: Schema.NullOr(Schema.Finite)
})
export type ServedHead = typeof ServedHead.Type

const SearchHitSchema = Schema.Struct({
  path: Schema.String,
  score: Schema.Finite,
  arms: Schema.Array(Schema.Literals(["lexical", "recency", "vector"])),
  claim: Schema.String
})

/** `POST /v1/search`: the fields local `head search` returns, with the version it answered over. */
export const SearchAnswer = Schema.Struct({
  query: Schema.String,
  hits: Schema.Array(SearchHitSchema),
  vector: VectorUseSchema,
  searchMs: Schema.Finite,
  head: ServedHead
})

const ViolationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("format"),
    path: Schema.String,
    reasons: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    kind: Schema.Literal("duplicate"),
    path: Schema.String,
    existing: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal("claim-edit"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("reserved-path"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("batch-cap"), count: Schema.Finite, cap: Schema.Finite }),
  Schema.Struct({
    kind: Schema.Literal("write-bar"),
    path: Schema.String,
    reasons: Schema.Array(Schema.String)
  })
])

/**
 * `POST /v1/neighbors`: `preparePuts`'s answer, the ops to append, the puts as rendered and placed,
 * their neighbors, every violation, the blocking ones, and the vector arm's report, with the version
 * it was computed over.
 */
export const NeighborsAnswer = Schema.Struct({
  appended: Schema.Array(OverlayOpSchema),
  puts: Schema.Array(
    Schema.Struct({ kind: Schema.Literal("put"), path: Schema.String, html: Schema.String })
  ),
  neighbors: Schema.Array(
    Schema.Struct({ path: Schema.String, hits: Schema.Array(SearchHitSchema) })
  ),
  violations: Schema.Array(ViolationSchema),
  blocking: Schema.Array(ViolationSchema),
  vector: Schema.NullOr(VectorUseSchema),
  head: ServedHead
})

/**
 * What `session exec` reports, whichever process ran it (`execOverHead` in `v2.ts` returns exactly
 * this type): the script's result, the harvest, what was appended, and why anything was not. The
 * CLI adds `head` (where the version came from) and `server` (whether the server ran it) around it.
 */
export const ExecOutcome = Schema.Struct({
  id: Schema.String,
  baseSha: Schema.String,
  lang: Schema.Literals(["bash", "js"]),
  corpusMount: Schema.String,
  sha: Schema.NullOr(Schema.String),
  exitCode: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String,
  durationMs: Schema.Finite,
  timeoutMs: Schema.Finite,
  timedOut: Schema.Boolean,
  ops: Schema.Finite,
  appended: Schema.Finite,
  opsTotal: Schema.Finite,
  harvested: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      path: Schema.String,
      to: Schema.optionalKey(Schema.String)
    })
  ),
  rejected: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  violations: Schema.Array(ViolationSchema),
  blocking: Schema.Array(Schema.String)
})
export type ExecOutcome = typeof ExecOutcome.Type

/**
 * How the server came by the version at the session's base: the tip it holds, or an ancestor of it
 * built from the tip by the tree diff an advance uses.
 */
export const ExecBase = Schema.Literals(["tip", "ancestor"])
export type ExecBase = typeof ExecBase.Type

/**
 * Why a server that was asked did not run the exec, so the client runs it locally: the session's
 * base is neither the tip nor an ancestor the server can build (`base-unservable`), or the
 * session's earlier exec or every worker stayed busy past the wait (`busy`). Nothing was run and
 * nothing appended in either case.
 */
export const ExecDeclined = Schema.Literals(["base-unservable", "busy"])

/** `POST /v1/exec`: the outcome with the version it ran over, or why the server declined. */
export const ExecAnswer = Schema.Union([
  Schema.Struct({
    served: Schema.Literal(true),
    base: ExecBase,
    outcome: ExecOutcome,
    head: ServedHead
  }),
  Schema.Struct({ served: Schema.Literal(false), reason: ExecDeclined, detail: Schema.String })
])
export type ExecAnswer = typeof ExecAnswer.Type

// ---------------------------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------------------------

/**
 * A second `head serve` found a live server on the store's socket. It names what it found, read
 * from that server's own status when it answered, so the operator can stop the right process.
 */
export class HeadServerRunning extends Schema.TaggedError<HeadServerRunning>()(
  "HeadServerRunning",
  {
    socket: Schema.String,
    pid: Schema.NullOr(Schema.Finite),
    ref: Schema.NullOr(Schema.String),
    sha: Schema.NullOr(Schema.String)
  }
) {}
