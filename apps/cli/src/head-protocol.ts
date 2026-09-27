import { join } from "node:path"

import { HEAD_SOCKET } from "@memhtml/session"
import { Schema } from "effect"

/**
 * The head server's wire contract (`docs/v2-poc.md`, "Head server"): JSON over HTTP on a Unix domain
 * socket inside the store, four routes under one version prefix.
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
  neighbors: `/v${HEAD_PROTOCOL}/neighbors`
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
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * `POST /v1/search`: exactly the input object `searchHead` takes, passed through whole. An option
 * `searchHead` gains later is one more optional field here and on the client, and the route, the
 * body's shape, and every older field stay as they are.
 */
export const SearchRequest = Schema.Struct({
  query: Schema.String,
  limit: Schema.optionalKey(Schema.Int),
  now: Schema.optionalKey(Schema.String)
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
  at: Schema.String
})
export type NeighborsRequest = typeof NeighborsRequest.Type

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

const HeadSourceSchema = Schema.Literals(["snapshot", "snapshot+advance", "git"])

const VectorSkipReasonSchema = Schema.Literals([
  "embedder-off",
  "no-cache",
  "cache-unreadable",
  "embed-failed"
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
 * The vector cache a server holds, for `status`: its entries, the share of the held version's
 * active records they cover, what reading it took, and the file's mtime; or, with `held: false`,
 * why there is none (`embedder-off`, `no-cache`, `cache-unreadable` with the reader's refusal in
 * `detail`). `loads` counts reads of the file: one at start, one per change of its mtime.
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
  loads: Schema.Finite
})
export type VectorCacheStatus = typeof VectorCacheStatus.Type

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
  vectors: VectorCacheStatus
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
