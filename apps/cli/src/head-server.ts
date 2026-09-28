import { access, chmod, lstat, mkdir, rm, stat } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { createConnection } from "node:net"
import { dirname } from "node:path"

import type { InvalidMemory, ModelUnavailable } from "@memhtml/contracts/errors"
import { StorageFailure } from "@memhtml/contracts/errors"
import { advanceHead, fillVectors, type HeadVersion, searchHead, vectorTextOf } from "@memhtml/head"
import type { EmbedPort, QueryEmbedPort } from "@memhtml/index"
import { DEFAULT_REF, ensureExcludedQuietly, HEAD_SOCKET, resumeSession } from "@memhtml/session"
import { snapshotPathFor, VECTORS_DIR, writeVectorCache } from "@memhtml/snapshot"
import { type GitFailure, makeGit } from "@memhtml/store"
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
  type Scope,
  Semaphore
} from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import type { EmbedderShape } from "./api-layer.js"
import { headRefOf, recordView } from "./curate-run.js"
import { fail } from "./envelope.js"
import { failureFor } from "./errors.js"
import { EXEC_BUSY, makeExecPool } from "./exec-pool.js"
import { type HeadSource, writeHeadSnapshot } from "./head-cache.js"
import { askHead, CONNECT_TIMEOUT_MS } from "./head-client.js"
import {
  BACKFILL_BATCH_MAX,
  EMBED_DEADLINE_DEFAULT_MS,
  EMBED_WARM_IDLE_DEFAULT_MS,
  type EmbedActivityStatus,
  EXEC_BODY_MAX_BYTES,
  EXEC_QUEUE_WAIT_MS,
  type ExecAnswer,
  type ExecBase,
  ExecRequest,
  execBodyTooLarge,
  HEAD_PROTOCOL,
  HEAD_ROUTES,
  HeadServerRunning,
  HeadServerStatus,
  headSocketPath,
  LATE_EMBEDS_MAX,
  NeighborsRequest,
  ReadRequest,
  SearchRequest,
  type ServedHead,
  SOCKET_PATH_MAX,
  type VectorCacheStatus
} from "./head-protocol.js"
import {
  type CacheRead,
  coverageOf,
  headVectorsPath,
  type LateEmbed,
  loadForSearch,
  skippedUse,
  vectorsForQuery
} from "./head-vectors.js"
import { type CachedImage, cacheImage } from "./session-exec.js"
import { execOverHead, loadHeadAt, preparePuts, qualifyRef, revParse } from "./v2.js"

/**
 * `memhtml head serve`: one process that holds the head loaded and answers lookups over the store's
 * socket (`docs/v2-poc.md`, "Head server").
 *
 * ## The version it holds
 *
 * The server loads the version at its ref's tip once, the cheapest way `loadHeadAt` knows, and then
 * follows the ref. The consistency rule is that an answer is never older than the ref at the moment
 * of the request: every request reads the ref first (one `rev-parse`, a few milliseconds) and, when
 * it moved, advances the held version with `advanceHead` over the changed paths before it answers.
 * A background poll ({@link DEFAULT_POLL_MS}) does the same between requests, so a request usually
 * finds the version already advanced and pays only the `rev-parse`.
 *
 * Advances are serialized by one permit: two never run at once, and a request that arrives during
 * one waits for it and then answers from its result instead of starting another. Inside the permit
 * the ref is read again, so a waiter never moves the version backward to the tip it saw before it
 * waited. Each advance cuts the new version's `parent` pointer: the server holds exactly one version,
 * and a chain kept for a process that lives for weeks would keep every delta it ever saw.
 *
 * After an advance the new version's snapshot is written in the background, best-effort, the way
 * `snapshotAfterCommit` does it, and skipped when the file already exists (a `session commit` writes
 * its own). A failed write is a log line.
 *
 * ## The vector cache it holds
 *
 * With an embedder bound (the one `run()` resolves; `MEMHTML_EMBED=off` binds none), the server
 * reads the vector cache for the configured space once at start and holds it, and `search` and
 * `neighbors` run the vector arm over it exactly as `head search` and `session put` do over the
 * file, so an answer's `vector` field reads the same on both paths. Before every answer that uses
 * it, and after every poll, the file is `stat`ed; a changed mtime, size, or inode (a `head embed`
 * renames a new file into place) is read again under its own permit, so an embed run while the
 * server is up takes effect on the next request with no restart. A file that vanished, or that the
 * reader refuses, leaves the arm off with that reason until the file changes again.
 *
 * ## The embed path it keeps short
 *
 * A search waits for its query embed at most {@link EMBED_DEADLINE_DEFAULT_MS} (the request's
 * `embedDeadlineMs`, else the server's `embedDeadlineMs`); past it the search answers on the
 * lexical arm with `embed-timeout`, and the embed still running is either left to finish, when
 * fewer than {@link LATE_EMBEDS_MAX} are already finishing, or interrupted. The one left to finish
 * is what warms the connection the miss was waiting on.
 *
 * With an embedder and a cache, a timer issues one one-token query embed whenever no embed has
 * ended for `warmIdleMs` ({@link EMBED_WARM_IDLE_DEFAULT_MS}) and none is in flight, so the first
 * search after a quiet stretch finds the path through the LLM proxy to Bedrock warm. Every embed the
 * server makes (search, neighbors, late, warmup, and fill) moves the idle clock, so a busy server
 * never warms. The timer is a fiber in the server's scope, stopped with it.
 *
 * ## The vectors it fills
 *
 * An advance that brings records the held cache has no vector for starts a background fill: the
 * missing records are embedded {@link BACKFILL_BATCH_MAX} at a time, off every request's path, and
 * written to the cache file the way `head embed` writes it, so the file and the held cache agree
 * and a restart keeps them. One fill runs at a time; a failed batch is retried on the next advance
 * or warmup tick.
 *
 * ## Exec
 *
 * `/v1/exec` runs `session exec` here: the session's log is read, the version at its base is the
 * held tip or an ancestor of it built by the tree diff (anything else is declined with
 * `base-unservable`, and the client runs the script itself), and `execOverHead` (the function the
 * CLI's local path runs) overlays, runs, harvests, validates, and appends. The script runs in a
 * worker (`exec-pool.ts`), because just-bash holds the thread it runs on and this thread answers
 * every search; the exec holds no advance permit and keeps the version it started with, so searches
 * and advances go on while it runs. Execs of one session id run one at a time, the second seeing
 * the first's harvest; execs of different sessions run at once, up to the pool's size. The UTF-8
 * image of each base version the guest is seeded from is kept for the last {@link IMAGES_KEPT}
 * versions, so a call encodes only the paths its session's overlay rewrote.
 *
 * ## The socket
 *
 * `.memhtml/head.sock`, bound with mode 0600 (the umask is narrowed around the bind, so the file is
 * never reachable by anyone else, even for the instant before a `chmod`), and never a TCP port. A
 * socket file already there is probed first: one that accepts a connection is a live server and this
 * one refuses ({@link HeadServerRunning}); one that refuses (`ECONNREFUSED`) was left by a killed
 * server and is replaced. Closing the scope closes the listener and removes the file.
 */

/** The background poll's default period. */
export const DEFAULT_POLL_MS = 1000

/** Versions other than the tip kept for sessions whose base is older than the tip. */
const VERSIONS_KEPT = 4

/** Base versions whose seed image `/v1/exec` keeps (about 17 MB each on the 7,437-record clone). */
export const IMAGES_KEPT = 2

/** How much of an oversized exec body is read and dropped before the connection is cut. */
const EXEC_DRAIN_MAX_BYTES = 64 * EXEC_BODY_MAX_BYTES

/**
 * A request body as text, or `tooLarge` at the first chunk that takes it past `cap` bytes. After
 * that the rest is read and dropped, so the refusal can be answered on a connection that is still
 * open, until {@link EXEC_DRAIN_MAX_BYTES} have come in, where the request is destroyed.
 */
const readCapped = (
  incoming: IncomingMessage,
  cap: number
): Promise<{ readonly text: string } | { readonly tooLarge: true } | { readonly bad: string }> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = []
    let bytes = 0
    const stop = () => {
      incoming.off("data", onData)
      incoming.off("end", onEnd)
      incoming.off("error", onError)
    }
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= cap) {
        chunks.push(chunk)
        return
      }
      stop()
      chunks.length = 0
      incoming.on("error", () => undefined)
      incoming.on("data", (more: Buffer) => {
        bytes += more.length
        if (bytes > EXEC_DRAIN_MAX_BYTES) incoming.destroy()
      })
      resolve({ tooLarge: true })
    }
    const onEnd = () => {
      stop()
      resolve({ text: Buffer.concat(chunks).toString("utf8") })
    }
    const onError = (error: Error) => {
      stop()
      resolve({ bad: `the body could not be read: ${error.message}` })
    }
    incoming.on("data", onData)
    incoming.once("end", onEnd)
    incoming.once("error", onError)
  })

/** What the warmup embeds: one token, as a query, the call a search makes. */
export const WARMUP_TEXT = "warm"

/** How often a warmup that found an embed in flight (or no cache) looks again, at most. */
const WARM_RECHECK_MS = 1000

/** How long a closing server waits for requests in flight. */
const SHUTDOWN_GRACE = Duration.seconds(2)

export interface HeadServerInput {
  readonly root: string
  /** The ref to follow; default the branch `HEAD` points at, else `main`. */
  readonly ref?: string | undefined
  /** The background poll's period in milliseconds; 0 turns it off. */
  readonly pollMs?: number | undefined
  /** The embedder `search` and `neighbors` use; absent or with both ports absent, the arm is off. */
  readonly embedder?: EmbedderShape | undefined
  /**
   * How long a search waits for its query embed when the request names no `embedDeadlineMs`, in
   * milliseconds; `0` for no bound. Default {@link EMBED_DEADLINE_DEFAULT_MS}.
   */
  readonly embedDeadlineMs?: number | undefined
  /**
   * Idle milliseconds after which the server warms the embed path with a one-token embed; `0`
   * turns the warmup off. Default {@link EMBED_WARM_IDLE_DEFAULT_MS}.
   */
  readonly warmIdleMs?: number | undefined
  /** The exec pool's worker entry; the sandbox runner unless a test hands in a stand-in. */
  readonly execWorkerPath?: string | undefined
}

/** A running server, for the command arm and for tests. */
export interface HeadServer {
  readonly socket: string
  readonly ref: string
  /** The held version as it stands, without reading the ref. */
  readonly held: () => HeadVersion
  /** The status route's answer as it stands, without reading the ref. */
  readonly stats: () => HeadServerStatus
}

/** The mutable half of a server: the one version it holds and what holding it has cost. */
interface State {
  version: HeadVersion
  lastAdvanceMs: number | null
  advances: number
  requests: number
}

/**
 * The vector cache as the server holds it: the read it last made, and the identity of the file that
 * read saw (`null` for no file), which decides whether the next `stat` calls for another read.
 */
interface HeldVectors {
  read: CacheRead
  stamp: string | null
  mtime: string | null
  loads: number
}

/** The background fill's state: one runs at a time, and a trigger during one asks for another pass. */
interface Backfill {
  running: boolean
  again: boolean
  embedded: number
  batches: number
  failures: number
  lastError: string | null
  lastMs: number | null
  lastAt: number | null
}

/** Distinct article texts of `view`'s active records whose content hash `vectors` lacks. */
const pendingOf = (view: HeadVersion, vectors: ReadonlyMap<string, Float32Array>): number => {
  const missing = new Set<string>()
  for (const record of view.records()) {
    if (record.archived || vectors.has(record.contentHash)) continue
    if (vectorTextOf(record) !== "") missing.add(record.contentHash)
  }
  return missing.size
}

/** The embedder's traffic, which the deadline, the late embeds, and the warmup read and move. */
interface EmbedActivity {
  inFlight: number
  /** When the last embed ended, success or failure; `null` before the first. */
  lastEndedAt: number | null
  timeouts: number
  lateKept: number
  lateStopped: number
  lateInFlight: number
  warmups: number
  warmupFailures: number
  lastWarmupMs: number | null
}

/** What identifies one version of the cache file: a rename into place changes the inode, a rewrite the mtime. */
const stampOf = (path: string): Effect.Effect<{ stamp: string; mtime: string } | null> =>
  Effect.promise(() =>
    stat(path).then(
      (info) => ({
        stamp: `${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`,
        mtime: info.mtime.toISOString()
      }),
      () => null
    )
  )

/** A version with its `parent` cut, so the server holds one version rather than a chain. */
const detached = (version: HeadVersion): HeadVersion =>
  version.parent === null ? version : { ...version, parent: null }

const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation }))
  )

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false
    )
  )

/** What is at the socket path: nothing, a socket nobody listens on, or a live listener. */
type SocketProbe = "absent" | "stale" | "live"

/**
 * Connect to `socket` once. A connect that completes is a live server. `ECONNREFUSED` is a socket
 * file with no listener, which is what a server killed without its finalizers leaves. A connect that
 * neither completes nor refuses inside {@link CONNECT_TIMEOUT_MS} is treated as live: a wedged
 * server still owns its socket, and replacing it would leave two processes believing they serve.
 */
const probeSocket = (socket: string): Effect.Effect<SocketProbe, StorageFailure> =>
  Effect.gen(function* () {
    const stat = yield* Effect.promise(() => lstat(socket).catch(() => null))
    if (stat === null) return "absent"
    if (!stat.isSocket()) {
      yield* Effect.logError(
        `${socket} exists and is not a socket; move it aside before starting a head server`
      )
      return yield* Effect.fail(StorageFailure.make({ operation: "head.serve.notSocket" }))
    }
    return yield* Effect.callback<SocketProbe, StorageFailure>((resume) => {
      const connection = createConnection({ path: socket })
      const timer = setTimeout(() => {
        connection.destroy()
        resume(Effect.succeed("live"))
      }, CONNECT_TIMEOUT_MS)
      connection.once("connect", () => {
        clearTimeout(timer)
        connection.destroy()
        resume(Effect.succeed("live"))
      })
      connection.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (error.code === "ECONNREFUSED") resume(Effect.succeed("stale"))
        else if (error.code === "ENOENT") resume(Effect.succeed("absent"))
        else {
          resume(
            Effect.logError(`probing ${socket} failed: ${error.message}`).pipe(
              Effect.andThen(Effect.fail(StorageFailure.make({ operation: "head.serve.probe" })))
            )
          )
        }
      })
    })
  })

/**
 * Make the socket path free to bind, or refuse. A live server is named from its own status when it
 * answers one; a stale file is removed with a log line.
 */
const claimSocket = (
  root: string,
  socket: string
): Effect.Effect<void, StorageFailure | HeadServerRunning> =>
  Effect.gen(function* () {
    if (socket.length > SOCKET_PATH_MAX) {
      yield* Effect.logError(
        `${socket} is ${String(socket.length)} bytes, past the ${String(SOCKET_PATH_MAX)} a Unix socket path allows; serve a store at a shorter path`
      )
      return yield* Effect.fail(StorageFailure.make({ operation: "head.serve.socketPath" }))
    }
    const probe = yield* probeSocket(socket)
    if (probe === "live") {
      const answered = yield* askHead({ root, route: "status", schema: HeadServerStatus })
      return yield* Effect.fail(
        HeadServerRunning.make({
          socket,
          pid: answered?.data.pid ?? null,
          ref: answered?.data.ref ?? null,
          sha: answered?.data.sha ?? null
        })
      )
    }
    if (probe === "stale") {
      yield* Effect.logWarning(`${socket} was left by a server that is gone; replacing it`)
      yield* attemptIo("head.serve.unlinkStale", () => rm(socket, { force: true }))
    }
  })

/** The ref a server follows: the flag's, else the branch `HEAD` points at, else `main`. */
const followedRef = (root: string, ref: string | undefined): Effect.Effect<string, GitFailure> =>
  ref !== undefined && ref.trim() !== ""
    ? Effect.succeed(qualifyRef(ref))
    : headRefOf(root).pipe(Effect.map((current) => current ?? DEFAULT_REF))

/** A request body the route's schema refused, or a body that is not JSON: the caller's mistake. */
const isBadRequest = (error: { readonly _tag?: unknown }): boolean =>
  error._tag === "SchemaError" || error._tag === "HttpServerError"

/**
 * Start a server on `root` in the current scope: load, claim the socket, bind, serve, poll. Closing
 * the scope stops the poll, closes the listener, and removes the socket file.
 */
export const startHeadServer = (
  input: HeadServerInput
): Effect.Effect<
  HeadServer,
  GitFailure | InvalidMemory | StorageFailure | HeadServerRunning,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const root = input.root
    const socket = headSocketPath(root)
    const pollMs = input.pollMs ?? DEFAULT_POLL_MS
    const bound: EmbedderShape = input.embedder ?? { document: undefined, query: undefined }
    const embedderOn = bound.document !== undefined || bound.query !== undefined
    const deadlineMs = input.embedDeadlineMs ?? EMBED_DEADLINE_DEFAULT_MS
    const warmIdleMs = input.warmIdleMs ?? EMBED_WARM_IDLE_DEFAULT_MS
    const activity: EmbedActivity = {
      inFlight: 0,
      lastEndedAt: null,
      timeouts: 0,
      lateKept: 0,
      lateStopped: 0,
      lateInFlight: 0,
      warmups: 0,
      warmupFailures: 0,
      lastWarmupMs: null
    }
    /** One embed call, counted in flight while it runs and moving the idle clock when it ends. */
    const tracked = <A>(
      call: Effect.Effect<A, ModelUnavailable>
    ): Effect.Effect<A, ModelUnavailable> =>
      Effect.suspend(() => {
        activity.inFlight += 1
        return call.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activity.inFlight -= 1
              activity.lastEndedAt = Date.now()
            })
          )
        )
      })
    const trackedDocument = (port: EmbedPort | undefined): EmbedPort | undefined =>
      port === undefined ? undefined : { embed: (texts) => tracked(port.embed(texts)) }
    const trackedQuery = (port: QueryEmbedPort | undefined): QueryEmbedPort | undefined =>
      port === undefined ? undefined : { embedQuery: (text) => tracked(port.embedQuery(text)) }
    // Every embed the routes make goes through these, so the idle clock sees all of them.
    const embedder: EmbedderShape = {
      document: trackedDocument(bound.document),
      query: trackedQuery(bound.query)
    }
    const ref = yield* followedRef(root, input.ref)
    const git = makeGit(root)

    const tip = yield* revParse(root, ref)
    if (tip === null) {
      yield* Effect.logError(`head serve: ${ref} does not resolve in ${root}`)
      return yield* Effect.fail(StorageFailure.make({ operation: "head.serve.ref" }))
    }
    const loaded = yield* loadHeadAt(root, tip)
    const loadSource: HeadSource = loaded.source
    const startedAt = Date.now()
    const state: State = {
      version: detached(loaded.view),
      lastAdvanceMs: null,
      advances: 0,
      requests: 0
    }
    // A snapshot holds records only, so a version that started from one cannot say what it skipped.
    const skippedOf = (version: HeadVersion): number | null =>
      loadSource === "git" ? version.skipped : null
    const served = (version: HeadVersion): ServedHead => ({
      sha: version.sha,
      ref,
      records: version.size,
      skipped: skippedOf(version)
    })
    const vectorsPath = headVectorsPath(root)
    const vectors: HeldVectors = {
      read: { ok: false, use: skippedUse(embedderOn ? "no-cache" : "embedder-off") },
      stamp: null,
      mtime: null,
      loads: 0
    }
    const backfill: Backfill = {
      running: false,
      again: false,
      embedded: 0,
      batches: 0,
      failures: 0,
      lastError: null,
      lastMs: null,
      lastAt: null
    }
    const backfillStatus = () => ({
      running: backfill.running,
      embedded: backfill.embedded,
      batches: backfill.batches,
      failures: backfill.failures,
      lastError: backfill.lastError,
      lastMs: backfill.lastMs,
      lastAt: backfill.lastAt === null ? null : new Date(backfill.lastAt).toISOString()
    })
    const vectorStatus = (): VectorCacheStatus => {
      const read = vectors.read
      return read.ok
        ? {
            held: true,
            reason: null,
            detail: null,
            path: vectorsPath,
            entries: read.cache.vectors.size,
            coverage: coverageOf(state.version, read.cache.vectors),
            loadMs: read.loadMs,
            mtime: vectors.mtime,
            loads: vectors.loads,
            pending: pendingOf(state.version, read.cache.vectors),
            backfill: backfillStatus()
          }
        : {
            held: false,
            reason: read.use.reason,
            detail: read.use.detail,
            path: vectorsPath,
            entries: null,
            coverage: null,
            loadMs: read.use.loadMs,
            mtime: vectors.mtime,
            loads: vectors.loads,
            pending: null,
            backfill: backfillStatus()
          }
    }
    const embedStatus = (): EmbedActivityStatus => ({
      deadlineMs: deadlineMs > 0 ? deadlineMs : null,
      warmIdleMs: warmIdleMs > 0 && embedder.query !== undefined ? warmIdleMs : null,
      inFlight: activity.inFlight,
      lastEmbedAt:
        activity.lastEndedAt === null ? null : new Date(activity.lastEndedAt).toISOString(),
      timeouts: activity.timeouts,
      lateKept: activity.lateKept,
      lateStopped: activity.lateStopped,
      lateInFlight: activity.lateInFlight,
      warmups: activity.warmups,
      warmupFailures: activity.warmupFailures,
      lastWarmupMs: activity.lastWarmupMs
    })
    const stats = (): HeadServerStatus => ({
      protocol: HEAD_PROTOCOL,
      pid: process.pid,
      root,
      socket,
      ref,
      sha: state.version.sha,
      records: state.version.size,
      skipped: skippedOf(state.version),
      loadSource,
      loadMs: loaded.loadMs,
      lastAdvanceMs: state.lastAdvanceMs,
      advances: state.advances,
      requests: state.requests,
      uptimeMs: Date.now() - startedAt,
      pollMs,
      startedAt: new Date(startedAt).toISOString(),
      vectors: vectorStatus(),
      embed: embedStatus(),
      exec: pool.stats()
    })

    const scope = yield* Effect.scope
    const pool = yield* makeExecPool({ workerPath: input.execWorkerPath })
    const advanceLock = yield* Semaphore.make(1)
    const snapshotLock = yield* Semaphore.make(1)
    const vectorLock = yield* Semaphore.make(1)

    /**
     * The held cache, read again first when the file changed since the last read. Holding the permit
     * the file is `stat`ed again, so requests that saw one change read it once. With no embedder the
     * file is never read: neither arm would use it. Never fails; a refusal is the arm's reason.
     */
    const heldVectors: Effect.Effect<CacheRead> = Effect.gen(function* () {
      if (!embedderOn) return vectors.read
      const seen = yield* stampOf(vectorsPath)
      if ((seen?.stamp ?? null) === vectors.stamp) return vectors.read
      return yield* vectorLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* stampOf(vectorsPath)
          if ((now?.stamp ?? null) === vectors.stamp) return vectors.read
          const read = yield* loadForSearch(root)
          vectors.read = read
          vectors.stamp = now?.stamp ?? null
          vectors.mtime = now?.mtime ?? null
          vectors.loads += now === null ? 0 : 1
          yield* Effect.logInfo(
            read.ok
              ? `head serve: vector cache loaded, ${String(read.cache.vectors.size)} vectors in ${String(read.loadMs)} ms`
              : `head serve: vector arm off (${read.use.reason ?? "unknown"}${read.use.detail === null ? "" : `, ${read.use.detail}`})`
          )
          return read
        })
      )
    })

    /**
     * A query embed still running at its deadline: left to finish in a fiber of the server's scope
     * while fewer than {@link LATE_EMBEDS_MAX} are, else interrupted. Either way this returns without
     * waiting on the embed; closing the scope interrupts one that is finishing.
     */
    const late: LateEmbed = (embed) =>
      Effect.gen(function* () {
        if (activity.lateInFlight >= LATE_EMBEDS_MAX) {
          activity.lateStopped += 1
          yield* Effect.forkDetach(Fiber.interrupt(embed), { startImmediately: true })
          yield* Effect.logDebug(
            `head serve: a late query embed was stopped; ${String(activity.lateInFlight)} already finishing`
          )
          return "stopped" as const
        }
        activity.lateInFlight += 1
        activity.lateKept += 1
        const kept = Date.now()
        yield* Fiber.await(embed).pipe(
          Effect.tap((exit) =>
            Effect.logDebug(
              `head serve: a late query embed ${Exit.isSuccess(exit) ? "finished" : "failed"} ${String(Date.now() - kept)} ms after its deadline`
            )
          ),
          Effect.ensuring(
            Fiber.interrupt(embed).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  activity.lateInFlight -= 1
                })
              )
            )
          ),
          Effect.forkIn(scope, { startImmediately: true })
        )
        return "kept" as const
      })

    /** The held cache as an answer hands it on: `loadMs` 0, because the answer read no file. */
    const servedVectors: Effect.Effect<CacheRead> = heldVectors.pipe(
      Effect.map(
        (read): CacheRead =>
          read.ok
            ? { ...read, loadMs: 0 }
            : { ok: false, use: { ...read.use, loadMs: read.use.loadMs === null ? null : 0 } }
      )
    )

    /**
     * The background fill: embed the held version's active records whose content hash the held
     * cache lacks, {@link BACKFILL_BATCH_MAX} at a time, and write them to the cache file the way
     * `head embed` does, so the file and the held cache agree and a restart keeps them. It runs only
     * with a document embedder and a held cache (a store nobody embedded is `head embed`'s to fill,
     * not a background job's), one pass at a time; a trigger during a pass asks for one more, so
     * concurrent advances never embed a hash twice. Nothing waits on it: a search uses whatever the
     * held cache has when it asks. A failed batch is logged and counted, and the next trigger (the
     * next advance, or the warmup timer's next tick) tries again.
     *
     * The batch is embedded with no lock held. Landing it takes the cache permit: the file is
     * `stat`ed and read again when it changed meanwhile (a `head embed` beside the server), the new
     * vectors are added to what is held, and the file is written and its identity recorded, so the
     * server does not read back the file it just wrote.
     */
    const fillPass: Effect.Effect<"done" | "more"> = Effect.gen(function* () {
      const port = embedder.document
      if (port === undefined) return "done"
      const held = yield* heldVectors
      if (!held.ok) return "done"
      const version = state.version
      const started = Date.now()
      const filled = yield* Effect.result(
        fillVectors({ view: version, cache: held.cache, embedder: port, limit: BACKFILL_BATCH_MAX })
      )
      if (filled._tag === "Failure") {
        backfill.failures += 1
        backfill.lastError = filled.failure.reason
        yield* Effect.logWarning(
          `head serve: filling vectors for ${version.sha} failed (${filled.failure.reason}); trying again on the next advance or warmup`
        )
        return "done"
      }
      const { counts, remaining } = filled.success
      if (counts.embedded === 0) return "done"
      const landed = yield* vectorLock
        .withPermits(1)(
          Effect.gen(function* () {
            const seen = yield* stampOf(vectorsPath)
            let base = vectors.read
            if ((seen?.stamp ?? null) !== vectors.stamp) {
              base = yield* loadForSearch(root)
              vectors.loads += seen === null ? 0 : 1
            }
            // A file removed or refused meanwhile was the operator's doing; the fill does not recreate it.
            if (!base.ok) {
              vectors.read = base
              vectors.stamp = seen?.stamp ?? null
              vectors.mtime = seen?.mtime ?? null
              return false
            }
            const merged = new Map(base.cache.vectors)
            for (const [hash, vector] of filled.success.cache.vectors) {
              if (!merged.has(hash)) merged.set(hash, vector)
            }
            const next = { space: base.cache.space, vectors: merged }
            yield* ensureExcludedQuietly(root, [`${VECTORS_DIR}/`])
            yield* writeVectorCache({ stored: next, path: vectorsPath })
            const written = yield* stampOf(vectorsPath)
            vectors.read = { ok: true, cache: next, loadMs: base.loadMs }
            vectors.stamp = written?.stamp ?? null
            vectors.mtime = written?.mtime ?? null
            return true
          })
        )
        .pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              backfill.failures += 1
              backfill.lastError = `writing the cache failed (${failure.operation})`
              return false
            })
          )
        )
      if (!landed) return "done"
      backfill.embedded += counts.embedded
      backfill.batches += 1
      backfill.lastMs = Date.now() - started
      backfill.lastAt = Date.now()
      backfill.lastError = null
      yield* Effect.logInfo(
        `head serve: filled ${String(counts.embedded)} vectors for ${version.sha} in ${String(backfill.lastMs)} ms${remaining > 0 ? `, ${String(remaining)} to go` : ""}`
      )
      return remaining > 0 ? "more" : "done"
    })

    /** Start a fill in the server's scope, or ask the running one for another pass. Never waits. */
    const startBackfill: Effect.Effect<void> = Effect.suspend(() => {
      if (embedder.document === undefined) return Effect.void
      if (backfill.running) {
        backfill.again = true
        return Effect.void
      }
      backfill.running = true
      const passes: Effect.Effect<void> = Effect.gen(function* () {
        while (true) {
          backfill.again = false
          const outcome = yield* fillPass
          if (outcome === "done" && !backfill.again) return
        }
      })
      return passes.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            backfill.running = false
          })
        ),
        Effect.forkIn(scope),
        Effect.asVoid
      )
    })

    /** The advanced version's snapshot, in the background, unless one is already on disk. */
    const cache = (version: HeadVersion): Effect.Effect<void> =>
      snapshotLock
        .withPermits(1)(
          Effect.gen(function* () {
            if (yield* exists(snapshotPathFor(root, version.sha))) return
            yield* writeHeadSnapshot(root, version)
          })
        )
        .pipe(
          Effect.catch((failure) =>
            Effect.logWarning(
              `head serve: snapshot for ${version.sha} not written (${failure._tag}); the next cold load reads the older one`
            )
          ),
          Effect.forkIn(scope),
          Effect.asVoid
        )

    /**
     * Holding the permit: read the ref again and advance to wherever it is now. A request that
     * waited behind another's advance finds the version already there and returns it.
     */
    const advance: Effect.Effect<HeadVersion, GitFailure | InvalidMemory> = advanceLock.withPermits(
      1
    )(
      Effect.gen(function* () {
        const now = yield* revParse(root, ref)
        if (now === null || now === state.version.sha) return state.version
        const started = Date.now()
        const next = detached(yield* advanceHead(git, state.version, now))
        state.version = next
        state.advances += 1
        state.lastAdvanceMs = Date.now() - started
        yield* Effect.logInfo(
          `head serve: ${ref} advanced to ${now} in ${String(state.lastAdvanceMs)} ms (${String(next.size)} records)`
        )
        yield* cache(next)
        yield* startBackfill
        return next
      })
    )

    /** The version an answer is computed over: never older than the ref at this moment. */
    const fresh: Effect.Effect<HeadVersion, GitFailure | InvalidMemory> = Effect.gen(function* () {
      const tip = yield* revParse(root, ref)
      if (tip === null) {
        yield* Effect.logWarning(
          `head serve: ${ref} no longer resolves; answering at ${state.version.sha}`
        )
        return state.version
      }
      if (tip === state.version.sha) return state.version
      return yield* advance
    })

    /**
     * The version at an explicit commit, for `neighbors` and `exec`: a session is judged at its own
     * base, not at the ref's tip. Built from the held version by the same tree diff an advance uses
     * (the diff has no direction), and the last {@link VERSIONS_KEPT} kept, since a session's calls
     * share one base.
     */
    const others = new Map<string, HeadVersion>()
    const versionAt = (sha: string): Effect.Effect<HeadVersion, GitFailure | InvalidMemory> =>
      Effect.gen(function* () {
        if (sha === state.version.sha) return state.version
        const kept = others.get(sha)
        if (kept !== undefined) {
          others.delete(sha)
          others.set(sha, kept)
          return kept
        }
        const built = detached(yield* advanceHead(git, state.version, sha))
        others.set(sha, built)
        for (const old of others.keys()) {
          if (others.size <= VERSIONS_KEPT) break
          others.delete(old)
        }
        return built
      })

    /**
     * The version `/v1/exec` runs a session over: the tip, when the base is the ref's tip as this
     * request reads it; an ancestor of the tip, built from it; or why it is neither, so the client
     * loads it instead. A base off the ref's history (a session on another branch) could be built
     * too, but the diff would be as large as the two histories are apart, and that is a load the
     * client's snapshot path does better.
     */
    const execBase = (
      sha: string
    ): Effect.Effect<
      { readonly version: HeadVersion; readonly base: ExecBase } | { readonly unservable: string },
      GitFailure | InvalidMemory
    > =>
      Effect.gen(function* () {
        const tip = yield* fresh
        if (sha === tip.sha) return { version: tip, base: "tip" as const }
        const ancestor = yield* git.run(["merge-base", "--is-ancestor", sha, tip.sha]).pipe(
          Effect.as(true),
          Effect.catchTag("GitFailure", () => Effect.succeed(false))
        )
        if (!ancestor) {
          return {
            unservable: `the session's base ${sha} is neither ${ref}'s tip ${tip.sha} nor an ancestor of it`
          }
        }
        return yield* versionAt(sha).pipe(
          Effect.map((version) => ({ version, base: "ancestor" as const })),
          Effect.catch((failure) =>
            Effect.succeed({
              unservable: `building the version at ${sha} from ${ref}'s tip ${tip.sha} failed (${failure._tag})`
            })
          )
        )
      })

    /** The seed image of a base version, kept for the last {@link IMAGES_KEPT} bases. */
    const images = new Map<string, CachedImage>()
    const imageFor = (version: HeadVersion): CachedImage => {
      const kept = images.get(version.sha)
      if (kept !== undefined) {
        images.delete(version.sha)
        images.set(version.sha, kept)
        return kept
      }
      const built = cacheImage(version)
      images.set(version.sha, built)
      for (const old of images.keys()) {
        if (images.size <= IMAGES_KEPT) break
        images.delete(old)
      }
      return built
    }

    /**
     * One exec at a time per session id, so the second of two sees the first's harvest in the log it
     * reads rather than racing it to the append. A wait past {@link EXEC_QUEUE_WAIT_MS} is `busy`.
     */
    const gates = new Map<string, { readonly gate: Semaphore.Semaphore; users: number }>()
    const oneAtATime = <A, E>(
      id: string,
      effect: Effect.Effect<A, E>
    ): Effect.Effect<Option.Option<A>, E> =>
      Effect.gen(function* () {
        const entry = gates.get(id) ?? { gate: Semaphore.makeUnsafe(1), users: 0 }
        gates.set(id, entry)
        entry.users += 1
        return yield* Effect.acquireUseRelease(
          entry.gate.take(1).pipe(Effect.timeoutOption(EXEC_QUEUE_WAIT_MS)),
          (taken) => (Option.isSome(taken) ? Effect.map(effect, Option.some) : Effect.succeedNone),
          (taken) => (Option.isSome(taken) ? entry.gate.release(1) : Effect.void)
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.users -= 1
              if (entry.users === 0) gates.delete(id)
            })
          )
        )
      })

    const busy = (detail: string): ExecAnswer => ({ served: false, reason: "busy", detail })

    /** `/v1/exec`: the session's exec, run here over the version at its base, or declined. */
    const serveExec = (
      body: ExecRequest
    ): Effect.Effect<ExecAnswer, GitFailure | InvalidMemory | StorageFailure> =>
      oneAtATime(
        body.id,
        Effect.gen(function* () {
          const session = yield* resumeSession({ root, id: body.id })
          const base = yield* execBase(session.baseSha)
          if ("unservable" in base) {
            return { served: false, reason: "base-unservable", detail: base.unservable } as const
          }
          const outcome = yield* execOverHead({
            session,
            base: base.version,
            script: body.script,
            lang: body.lang,
            timeoutMs: body.timeoutMs,
            runtime: { runner: pool.runner(EXEC_QUEUE_WAIT_MS), baseImage: imageFor(base.version) }
          })
          return {
            served: true,
            base: base.base,
            outcome,
            head: served(base.version)
          } as const
        })
      ).pipe(
        Effect.map((answer) =>
          Option.getOrElse(answer, () =>
            busy(
              `session ${body.id} was still running an earlier exec after ${String(EXEC_QUEUE_WAIT_MS)} ms`
            )
          )
        ),
        Effect.catch((failure) =>
          failure._tag === "StorageFailure" && failure.operation === EXEC_BUSY
            ? Effect.succeed(
                busy(`no sandbox worker came free within ${String(EXEC_QUEUE_WAIT_MS)} ms`)
              )
            : Effect.fail(failure)
        )
      )

    /**
     * The exec body, read no further than {@link EXEC_BODY_MAX_BYTES}: a declared length past it is
     * refused before a byte is read, and a body that runs past it without one (chunked) is refused
     * at the byte that crosses it. Read from the Node request directly rather than through
     * `MaxBodySize`, whose reader destroys the socket at the cap, so the client got a reset where it
     * should get the 413. The rest of an oversized body is read and dropped, up to
     * {@link EXEC_DRAIN_MAX_BYTES}, so the answer reaches a client still sending; past that the
     * connection is cut.
     */
    const execBody = (
      request: HttpServerRequest.HttpServerRequest
    ): Effect.Effect<
      ExecRequest | { readonly tooLarge: number | null } | { readonly bad: string }
    > =>
      Effect.gen(function* () {
        const declared = Number(request.headers["content-length"])
        if (Number.isFinite(declared) && declared > EXEC_BODY_MAX_BYTES) {
          return { tooLarge: declared }
        }
        const { toIncomingMessage } = yield* Effect.promise(
          () => import("@effect/platform-node/NodeHttpServerRequest")
        )
        const read = yield* Effect.promise(() =>
          readCapped(toIncomingMessage(request), EXEC_BODY_MAX_BYTES)
        )
        if ("tooLarge" in read) return { tooLarge: null }
        if ("bad" in read) return { bad: read.bad }
        const parsed = (() => {
          try {
            return { ok: true as const, value: JSON.parse(read.text) as unknown }
          } catch (error) {
            return { ok: false as const, reason: String(error) }
          }
        })()
        if (!parsed.ok) return { bad: `the body is not JSON: ${parsed.reason}` }
        return yield* Schema.decodeUnknownEffect(ExecRequest, { onExcessProperty: "error" })(
          parsed.value
        ).pipe(Effect.catch((error) => Effect.succeed({ bad: String(error) })))
      })

    const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      state.requests += 1
      const path = new URL(request.url, "http://memhtml-head").pathname
      const route = `${request.method} ${path}`
      if (route === `GET ${HEAD_ROUTES.status}`) {
        yield* fresh
        yield* heldVectors
        return json(stats())
      }
      if (route === `POST ${HEAD_ROUTES.search}`) {
        const { embedDeadlineMs, ...body } = yield* HttpServerRequest.schemaBodyJson(
          SearchRequest,
          { onExcessProperty: "error" }
        )
        const version = yield* fresh
        const arm = yield* vectorsForQuery({
          cache: servedVectors,
          view: version,
          query: body.query,
          embedder,
          deadlineMs: embedDeadlineMs ?? deadlineMs,
          late
        })
        if (arm.use.reason === "embed-timeout") activity.timeouts += 1
        const started = performance.now()
        // The rest of the decoded body IS `searchHead`'s input, passed whole, plus the arm's inputs.
        const hits = searchHead(version, { ...body, ...arm.search })
        const searchMs = Math.round((performance.now() - started) * 100) / 100
        return json({ query: body.query, hits, vector: arm.use, searchMs, head: served(version) })
      }
      if (route === `POST ${HEAD_ROUTES.read}`) {
        const body = yield* HttpServerRequest.schemaBodyJson(ReadRequest, {
          onExcessProperty: "error"
        })
        const version = yield* fresh
        return json({ record: recordView(version, body.path), head: served(version) })
      }
      if (route === `POST ${HEAD_ROUTES.neighbors}`) {
        const body = yield* HttpServerRequest.schemaBodyJson(NeighborsRequest, {
          onExcessProperty: "error"
        })
        const version = yield* versionAt(body.sha)
        const prepared = yield* preparePuts({
          base: version,
          sessionOps: body.ops,
          lines: body.lines,
          at: body.at,
          cache: servedVectors,
          embedder
        })
        return json({ ...prepared, head: served(version) })
      }
      if (route === `POST ${HEAD_ROUTES.exec}`) {
        const body = yield* execBody(request)
        if ("tooLarge" in body) {
          return json(fail("ERR_INVALID_FLAG", execBodyTooLarge(body.tooLarge)), 413)
        }
        if ("bad" in body)
          return json(fail("ERR_INVALID_FLAG", `request refused: ${body.bad}`), 400)
        return json(yield* serveExec(body))
      }
      return json(
        fail(
          "ERR_UNKNOWN_COMMAND",
          `no route ${route}; routes: ${Object.values(HEAD_ROUTES).join(", ")}`
        ),
        404
      )
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          isBadRequest(error)
            ? json(fail("ERR_INVALID_FLAG", `request refused: ${String(error)}`), 400)
            : json(failureFor(error), 500)
        )
      )
    )

    yield* claimSocket(root, socket)
    // Before the bind, so the first request finds the cache held rather than paying for its read.
    yield* heldVectors
    yield* ensureExcludedQuietly(root, [HEAD_SOCKET])
    yield* attemptIo("head.serve.mkdir", () => mkdir(dirname(socket), { recursive: true }))
    // Registered before the listener, so it runs after the listener closes: the file goes last.
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(socket, { force: true })))

    // By its subpath and only here, for the reason `head-client.ts` gives: the package's barrel is
    // half a second of imports every other command would pay.
    const NodeHttpServer = yield* Effect.promise(
      () => import("@effect/platform-node/NodeHttpServer")
    )
    // The umask decides the mode `bind(2)` creates the socket with, so narrowing it around the bind
    // leaves no instant at which the file is reachable by anyone else. The `chmod` after it holds
    // the mode where a umask cannot be set (a worker thread).
    const context = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        try {
          return process.umask(0o177)
        } catch {
          return null
        }
      }),
      () =>
        Layer.build(
          NodeHttpServer.layer(() => createServer(), {
            path: socket,
            gracefulShutdownTimeout: SHUTDOWN_GRACE
          })
        ).pipe(
          Effect.catchTag("ServeError", (error) =>
            Effect.logError(`head serve: binding ${socket} failed: ${String(error.cause)}`).pipe(
              Effect.andThen(Effect.fail(StorageFailure.make({ operation: "head.serve.listen" })))
            )
          )
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous !== null) process.umask(previous)
        })
    )
    yield* attemptIo("head.serve.chmod", () => chmod(socket, 0o600))
    yield* HttpServer.serveEffect(app).pipe(Effect.provideContext(context))
    // The version it loaded may already hold records the cache lacks (commits since the last
    // `head embed`); the first pass fills them in the background.
    yield* startBackfill

    if (pollMs > 0) {
      yield* fresh.pipe(
        Effect.andThen(heldVectors),
        Effect.catch((failure) =>
          Effect.logWarning(`head serve: poll of ${ref} failed (${failure._tag}); retrying`)
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(pollMs))),
        Effect.forkIn(scope)
      )
    }

    /**
     * The warmup: one one-token query embed whenever none has ended for `warmIdleMs` and none is in
     * flight, and only while the arm could run (an embedder and a held cache), so a store nobody
     * embedded pays nothing. The first runs as soon as the server listens, since no embed has
     * happened yet. It sleeps until the idle clock would pass `warmIdleMs`, and looks again when an
     * embed that was in flight moved the clock while it slept.
     */
    const query = embedder.query
    if (warmIdleMs > 0 && query !== undefined) {
      const warm = Effect.gen(function* () {
        // A fill whose last batch failed is tried again on each tick, which is at most one a second.
        if (backfill.lastError !== null) yield* startBackfill
        const idleFor =
          activity.lastEndedAt === null
            ? Number.POSITIVE_INFINITY
            : Date.now() - activity.lastEndedAt
        if (idleFor < warmIdleMs) {
          yield* Effect.sleep(Duration.millis(warmIdleMs - idleFor))
          return
        }
        if (activity.inFlight > 0 || !vectors.read.ok) {
          yield* Effect.sleep(Duration.millis(Math.min(warmIdleMs, WARM_RECHECK_MS)))
          return
        }
        const started = Date.now()
        const warmed = yield* Effect.result(query.embedQuery(WARMUP_TEXT))
        activity.lastWarmupMs = Date.now() - started
        if (warmed._tag === "Success") activity.warmups += 1
        else activity.warmupFailures += 1
        yield* Effect.logDebug(
          warmed._tag === "Success"
            ? `head serve: warmed the embed path in ${String(activity.lastWarmupMs)} ms after ${idleFor === Number.POSITIVE_INFINITY ? "start" : `${String(idleFor)} ms idle`}`
            : `head serve: warming the embed path failed in ${String(activity.lastWarmupMs)} ms (${warmed.failure.reason})`
        )
      })
      yield* warm.pipe(Effect.forever, Effect.forkIn(scope))
    }

    return { socket, ref, held: () => state.version, stats }
  })

/** What `head serve` reports when it stops. */
export interface HeadServed {
  readonly socket: string
  readonly ref: string
  /** The commit the held version was at when the server stopped. */
  readonly sha: string
  readonly records: number
  /** The signal that stopped it. */
  readonly signal: string
  readonly loadSource: HeadSource
  readonly loadMs: number
  readonly advances: number
  readonly requests: number
  readonly uptimeMs: number
}

/** The first of SIGTERM or SIGINT, with both handlers removed once it arrives. */
export const untilSignal: Effect.Effect<NodeJS.Signals> = Effect.callback<NodeJS.Signals>(
  (resume) => {
    const signals: ReadonlyArray<NodeJS.Signals> = ["SIGTERM", "SIGINT"]
    const handler = (signal: NodeJS.Signals) => {
      for (const each of signals) process.off(each, handler)
      resume(Effect.succeed(signal))
    }
    for (const each of signals) process.on(each, handler)
    return Effect.sync(() => {
      for (const each of signals) process.off(each, handler)
    })
  }
)

/**
 * `head serve`: start a server and hold it until `stop` completes (SIGTERM or SIGINT by default),
 * then close it, which removes the socket, and report what it did.
 */
export const serveHead = (
  input: HeadServerInput & { readonly stop?: Effect.Effect<string> | undefined }
): Effect.Effect<HeadServed, GitFailure | InvalidMemory | StorageFailure | HeadServerRunning> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startHeadServer(input)
      const started = server.stats()
      yield* Effect.logInfo(
        `head serve: listening on ${server.socket} for ${server.ref} at ${started.sha} (${String(started.records)} records, ${started.loadSource} in ${String(started.loadMs)} ms, poll ${String(started.pollMs)} ms)`
      )
      const signal = yield* input.stop ?? untilSignal
      const final = server.stats()
      yield* Effect.logInfo(`head serve: ${signal}, closing ${server.socket}`)
      return {
        socket: server.socket,
        ref: server.ref,
        sha: final.sha,
        records: final.records,
        signal,
        loadSource: final.loadSource,
        loadMs: final.loadMs,
        advances: final.advances,
        requests: final.requests,
        uptimeMs: final.uptimeMs
      }
    })
  )
