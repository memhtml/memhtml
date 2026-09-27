import * as Http from "node:http"
import * as Https from "node:https"
import { createConnection } from "node:net"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

import { HEAD_ROUTES, type HeadRoute, headSocketPath } from "./head-protocol.js"

/**
 * The client half of the head server (`docs/v2-poc.md`, "Head server"): one request over the
 * store's socket, answered or not.
 *
 * {@link askHead} never fails. `null` means no server answered, for any reason: no socket file, a
 * socket nobody listens on (a server that was killed), a connect that did not complete inside
 * {@link CONNECT_TIMEOUT_MS}, an answer that did not arrive inside {@link ANSWER_TIMEOUT_MS}, a
 * non-200 status, or a body the schema refuses. Every caller then takes the local path it would have
 * taken with no server at all, so a server can only ever make a call faster, never make it fail.
 *
 * The transport is `@effect/platform-node`'s `node:http` client with an `http.Agent` whose
 * `createConnection` dials the socket instead of a host, the extension point Node documents for
 * exactly this. The agent keeps no connection alive: a CLI call makes one request and exits, and an
 * idle kept-alive socket would hold the server's graceful shutdown open.
 *
 * The client module is imported on the first ask, by its subpath, and never at process start: the
 * package's barrel costs about half a second to import (it loads every Node adapter, Redis's
 * included), and every CLI invocation would pay it while three commands use it.
 */

/**
 * How long a client waits for the socket to accept. A local socket accepts in well under a
 * millisecond or refuses at once, so this bounds only a server too wedged to accept at all.
 */
export const CONNECT_TIMEOUT_MS = 100

/**
 * How long a client waits for the answer once connected. The server reads the ref before every
 * answer and advances when it moved, which on a large delta is seconds, so this is generous; past it
 * the local load is no slower than waiting.
 */
export const ANSWER_TIMEOUT_MS = 10_000

/** A server's answer and how long the round trip took. */
export interface Answered<A> {
  readonly data: A
  readonly ms: number
}

/** An agent that dials `socket` and abandons a connect that has not completed in time. */
const socketAgent = (socket: string): Http.Agent => {
  const agent = new Http.Agent({ keepAlive: false })
  agent.createConnection = () => {
    const connection = createConnection({ path: socket })
    const timer = setTimeout(
      () => connection.destroy(new Error(`connect to ${socket} timed out`)),
      CONNECT_TIMEOUT_MS
    )
    const clear = () => clearTimeout(timer)
    connection.once("connect", clear)
    connection.once("error", clear)
    connection.once("close", clear)
    return connection
  }
  return agent
}

/** The first errno-style `code` along an error's `cause` chain, e.g. `ENOENT` or `ECONNREFUSED`. */
const errnoOf = (error: unknown): string | undefined => {
  let current: unknown = error
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    if (typeof code === "string" && code.startsWith("E")) return code
    const next = current as { readonly cause?: unknown; readonly reason?: unknown }
    current = next.reason ?? next.cause
  }
  return undefined
}

/** The two answers that mean "no server here", which are expected and not worth a warning. */
const NO_SERVER = new Set(["ENOENT", "ECONNREFUSED"])

/** A server answered with a status other than 200; the body is the server's failure envelope. */
class ServerRefused {
  readonly _tag = "ServerRefused"
  constructor(
    readonly status: number,
    readonly body: string
  ) {}
}

/**
 * Ask the server on `root`'s socket. `body` is sent as JSON with a `POST`; without one the request
 * is a `GET`. The answer is decoded with `schema` and `null` stands for every way of not getting one.
 */
export const askHead = <A>(input: {
  readonly root: string
  readonly route: HeadRoute
  readonly schema: Schema.Decoder<A>
  readonly body?: unknown
}): Effect.Effect<Answered<A> | null> => {
  const socket = headSocketPath(input.root)
  const started = performance.now()
  const url = `http://memhtml-head${HEAD_ROUTES[input.route]}`
  return Effect.gen(function* () {
    const NodeHttpClient = yield* Effect.promise(
      () => import("@effect/platform-node/NodeHttpClient")
    )
    return yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const request =
        input.body === undefined
          ? HttpClientRequest.get(url)
          : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(input.body))
      const response = yield* client.execute(request)
      if (response.status !== 200) {
        return yield* Effect.fail(new ServerRefused(response.status, yield* response.text))
      }
      const json = yield* response.json
      const data = yield* Schema.decodeUnknownEffect(input.schema)(json)
      return { data, ms: Math.round(performance.now() - started) }
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttpNoAgent),
      Effect.provideService(NodeHttpClient.HttpAgent, {
        http: socketAgent(socket),
        https: new Https.Agent()
      })
    )
  }).pipe(
    Effect.timeout(ANSWER_TIMEOUT_MS),
    Effect.catchCause((cause) => {
      const errno = errnoOf(cause)
      if (errno !== undefined && NO_SERVER.has(errno)) {
        return Effect.logDebug(`no head server on ${socket} (${errno})`).pipe(Effect.as(null))
      }
      return Effect.logWarning(
        `head server on ${socket} did not answer ${HEAD_ROUTES[input.route]}; loading locally: ${String(cause).slice(0, 500)}`
      ).pipe(Effect.as(null))
    })
  )
}
