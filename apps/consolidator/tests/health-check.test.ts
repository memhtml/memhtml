import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createTcpServer, type Server as TcpServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import { healthy } from "../src/client.js"

/**
 * The readiness probe against LIVE loopback listeners, none of which is eve.
 *
 * The hazard this tier pins: the probe's port is released before eve binds it (the race is inherent,
 * see `reserveLoopbackPort`), so the process answering `/eve/v1/health` can be anything on the box —
 * and any generic HTTP server answers 200 to a path it routes. A `healthy()` that stopped at
 * `response.ok` would then hand the whole run to a non-eve listener: the turn posted to it, its
 * answer decoded, and a barren-looking payload is exactly what a generic 200 body is one step from. So
 * the check must read the
 * BODY and match eve's documented shape (`{ ok: true, status: "ready", workflowId }`,
 * node_modules/eve/dist/src/internal/nitro/routes/health.js), and every case below is a listener
 * that a status-line-only check accepts and this one must not.
 *
 * Real sockets rather than a mocked fetch, because the subject includes how the probe behaves
 * against a listener's actual wire behavior (accept-and-ignore, non-JSON bytes), which a mock would
 * restate rather than test.
 */

const servers: Array<Server | TcpServer> = []
/** Accepted-and-ignored sockets, destroyed at teardown so `close()` is not held open by them. */
const heldSockets: Array<{ destroy: () => void }> = []

afterEach(async () => {
  for (const socket of heldSockets.splice(0)) socket.destroy()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done())
        })
    )
  )
})

/** An HTTP server answering every request with one fixed status and body. */
const serve = (input: { readonly status: number; readonly body: string }): Promise<string> =>
  new Promise((settle) => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(input.status, { "content-type": "application/json" })
      response.end(input.body)
    })
    servers.push(server)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("no port")
      settle(`http://127.0.0.1:${String(address.port)}`)
    })
  })

/** The body eve's shipped handler returns. The value of `workflowId` is eve's own and not pinned. */
const EVE_BODY = JSON.stringify({
  ok: true,
  status: "ready",
  workflowId: "workflow//eve//entry"
})

describe("healthy() accepts only eve's documented health body", () => {
  it("accepts a 200 carrying the documented shape", async () => {
    expect(await healthy(await serve({ status: 200, body: EVE_BODY }))).toBe(true)
  })

  /**
   * THE regression case. A generic 200-server — a port-race winner, a dev server, anything routing
   * unknown paths to a handler — passes a status-line-only check, and everything downstream of a
   * false "ready" is silent: the turn is posted to a server that is not eve.
   *
   * (Mutation: restoring `return response.ok` in `healthy()` fails every case in this block.)
   */
  it("refuses a 200 whose body is not eve's health shape", async () => {
    expect(
      await healthy(await serve({ status: 200, body: JSON.stringify({ hello: "world" }) }))
    ).toBe(false)
  })

  it("refuses a 200 with an empty or non-JSON body", async () => {
    expect(await healthy(await serve({ status: 200, body: "" }))).toBe(false)
    expect(await healthy(await serve({ status: 200, body: "OK" }))).toBe(false)
  })

  it("refuses a body that is close but wrong in each required field", async () => {
    // `ok` must be `true`, not merely truthy-shaped.
    expect(
      await healthy(
        await serve({
          status: 200,
          body: JSON.stringify({ ok: "true", status: "ready", workflowId: "w" })
        })
      )
    ).toBe(false)
    // `status` must be the ready state, not any string.
    expect(
      await healthy(
        await serve({
          status: 200,
          body: JSON.stringify({ ok: true, status: "starting", workflowId: "w" })
        })
      )
    ).toBe(false)
    // `workflowId` must be a non-empty string: it is what says a workflow entry RESOLVED.
    expect(
      await healthy(
        await serve({ status: 200, body: JSON.stringify({ ok: true, status: "ready" }) })
      )
    ).toBe(false)
    expect(
      await healthy(
        await serve({
          status: 200,
          body: JSON.stringify({ ok: true, status: "ready", workflowId: "" })
        })
      )
    ).toBe(false)
  })

  it("refuses a JSON body that is not an object", async () => {
    expect(await healthy(await serve({ status: 200, body: "true" }))).toBe(false)
    expect(await healthy(await serve({ status: 200, body: '["ready"]' }))).toBe(false)
  })

  it("still refuses a non-2xx regardless of body", async () => {
    expect(await healthy(await serve({ status: 503, body: EVE_BODY }))).toBe(false)
  })

  it("refuses an origin nothing listens on", async () => {
    /** Bind-then-close: the port existed and is now free, which is the pre-listen startup window. */
    const origin = await serve({ status: 200, body: EVE_BODY })
    await new Promise<void>((done) => {
      const held = servers.pop()
      if (held === undefined) {
        done()
        return
      }
      held.close(() => done())
    })
    expect(await healthy(origin)).toBe(false)
  })

  it("refuses a listener that accepts and never answers, within the probe's own timeout", async () => {
    /** The shape a lost port race takes when the winner is a bare TCP listener. */
    const origin = await new Promise<string>((settle) => {
      const server = createTcpServer((socket) => {
        // Accept the socket and say nothing. Held for teardown, or it keeps close() from settling.
        heldSockets.push(socket)
        socket.once("error", () => {})
      })
      servers.push(server)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (address === null || typeof address === "string") throw new Error("no port")
        settle(`http://127.0.0.1:${String(address.port)}`)
      })
    })
    expect(await healthy(origin)).toBe(false)
  }, 10_000)
})
