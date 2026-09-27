import { access, chmod, lstat, mkdir, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { createConnection } from "node:net"
import { dirname } from "node:path"

import type { InvalidMemory } from "@memhtml/contracts/errors"
import { StorageFailure } from "@memhtml/contracts/errors"
import { advanceHead, type HeadVersion, searchHead } from "@memhtml/head"
import { DEFAULT_REF, ensureExcludedQuietly, HEAD_SOCKET } from "@memhtml/session"
import { snapshotPathFor } from "@memhtml/snapshot"
import { type GitFailure, makeGit } from "@memhtml/store"
import { Duration, Effect, Layer, Schedule, type Scope, Semaphore } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import type { EmbedderShape } from "./api-layer.js"
import { headRefOf, recordView } from "./curate-run.js"
import { fail } from "./envelope.js"
import { failureFor } from "./errors.js"
import { type HeadSource, writeHeadSnapshot } from "./head-cache.js"
import { askHead, CONNECT_TIMEOUT_MS } from "./head-client.js"
import {
  HEAD_PROTOCOL,
  HEAD_ROUTES,
  HeadServerRunning,
  HeadServerStatus,
  headSocketPath,
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
  loadForSearch,
  skippedUse,
  vectorsForQuery
} from "./head-vectors.js"
import { loadHeadAt, preparePuts, qualifyRef, revParse } from "./v2.js"

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
    const embedder: EmbedderShape = input.embedder ?? { document: undefined, query: undefined }
    const embedderOn = embedder.document !== undefined || embedder.query !== undefined
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
            loads: vectors.loads
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
            loads: vectors.loads
          }
    }
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
      vectors: vectorStatus()
    })

    const scope = yield* Effect.scope
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

    /** The held cache as an answer hands it on: `loadMs` 0, because the answer read no file. */
    const servedVectors: Effect.Effect<CacheRead> = heldVectors.pipe(
      Effect.map(
        (read): CacheRead =>
          read.ok
            ? { ...read, loadMs: 0 }
            : { ok: false, use: { ...read.use, loadMs: read.use.loadMs === null ? null : 0 } }
      )
    )

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
     * The version at an explicit commit, for `neighbors`: a session is judged at its own base, not
     * at the ref's tip. Built from the held version by the same tree diff an advance uses (the diff
     * has no direction), and the last one kept, since a session's puts share one base.
     */
    let other: HeadVersion | null = null
    const versionAt = (sha: string): Effect.Effect<HeadVersion, GitFailure | InvalidMemory> =>
      Effect.gen(function* () {
        if (sha === state.version.sha) return state.version
        if (other !== null && other.sha === sha) return other
        const built = detached(yield* advanceHead(git, state.version, sha))
        other = built
        return built
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
        const body = yield* HttpServerRequest.schemaBodyJson(SearchRequest, {
          onExcessProperty: "error"
        })
        const version = yield* fresh
        const arm = yield* vectorsForQuery({
          cache: servedVectors,
          view: version,
          query: body.query,
          embedder
        })
        const started = performance.now()
        // The decoded body IS `searchHead`'s input, passed whole, plus the arm's two inputs.
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
