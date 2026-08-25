import http2 from "node:http2"
import type { AddressInfo } from "node:net"

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { describe, expect, it } from "vitest"

import { makeBedrockClient, REQUEST_HANDLER_OPTIONS } from "../src/client.js"

/**
 * What {@link REQUEST_HANDLER_OPTIONS} does to a call, measured rather than restated.
 *
 * A bound is only correct relative to the answer it has to allow, and a test that reads the
 * constant back cannot tell a bound that protects a sleep phase from one that kills it: both
 * satisfy `requestTimeout === 300_000`. So these drive a real `InvokeModel` through the SDK's
 * real `NodeHttp2Handler` against a LOOPBACK h2c server. No credential is read from the
 * environment, no name is resolved, and no Bedrock endpoint is contacted — the client is
 * pointed at `127.0.0.1` with a fixture key, and the server is this process.
 *
 * The shipped options and the answer they must allow are compressed by ONE factor, so the
 * assertion is about the ORDER between a bound and a legitimate answer rather than about
 * either number. At {@link COMPRESSION} the shipped 300s request bound becomes 1.5s and
 * {@link SLOW_ANSWER_MILLIS} stands in for an 80s answer — well inside the "slowest observed
 * answers are minutes" this client is built for. Any millisecond bound added to the shipped
 * options is compressed by the same factor, so one that fires before a legitimate answer
 * fails here.
 */

const COMPRESSION = 200
const SLOW_ANSWER_MILLIS = 400

/** The shipped options with every millisecond bound divided by {@link COMPRESSION}. */
const compressedOptions = (): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(REQUEST_HANDLER_OPTIONS as Record<string, unknown>).map(([key, value]) =>
      key.endsWith("Timeout") && typeof value === "number"
        ? [key, value / COMPRESSION]
        : [key, value]
    )
  )

interface Loopback {
  readonly endpoint: string
  readonly close: () => Promise<void>
}

const listen = async (onStream: (stream: http2.ServerHttp2Stream) => void): Promise<Loopback> => {
  const server = http2.createServer()
  server.on("stream", onStream)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/**
 * `maxAttempts` and `retryMode` are `makeBedrockClient`'s own values, so what the retry layer
 * does with a rejection is part of what these cases measure. `attempts` is narrowed per case,
 * because ten attempts at a compressed bound would make the suite's runtime the subject.
 */
const probe = async (
  endpoint: string,
  handler: Record<string, unknown>,
  attempts: number
): Promise<{ readonly outcome: "answered" | "rejected"; readonly error?: unknown }> => {
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "AKIAFIXTUREONLY", secretAccessKey: "fixture-not-a-secret" },
    maxAttempts: attempts,
    retryMode: "adaptive",
    requestHandler: handler
  })
  try {
    await client.send(
      new InvokeModelCommand({
        modelId: "fixture.model",
        contentType: "application/json",
        accept: "application/json",
        body: "{}"
      })
    )
    return { outcome: "answered" }
  } catch (error) {
    return { outcome: "rejected", error }
  } finally {
    client.destroy()
  }
}

describe("REQUEST_HANDLER_OPTIONS", () => {
  it("reaches the handler the SDK resolves, and names nothing that handler ignores", async () => {
    /**
     * The presence half. `NodeHttp2Handler` resolves its options lazily, so this reads the
     * provider the constructor stored rather than waiting for a first request. A plain options
     * object REPLACES bedrock-runtime's own default provider, so `disableConcurrentStreams`
     * has to be restated here or the client silently moves from one isolated session per
     * request to a pooled multiplexed one.
     */
    const client = makeBedrockClient("us-east-1")
    const handler = client.config.requestHandler as unknown as {
      readonly configProvider: Promise<Record<string, unknown>>
    }
    const resolved = await handler.configProvider
    expect(resolved.requestTimeout).toBe(300_000)
    expect(resolved.disableConcurrentStreams).toBe(true)
    // `NodeHttp2Handler` reads `sessionTimeout` as the SESSION's own inactivity timer and
    // destroys the session unconditionally when it fires, in flight or not. See
    // {@link REQUEST_HANDLER_OPTIONS}.
    expect(resolved.sessionTimeout).toBeUndefined()
    // A key the handler never reads would look like a bound and be none.
    expect(resolved.connectionTimeout).toBeUndefined()
    client.destroy()
  })

  it("lets an answer that takes minutes arrive", async () => {
    /**
     * The meaning half, and the one a shape assertion cannot make: waiting for a slow answer
     * is "no activity" on the h2 SESSION, so a session-level bound below the slowest
     * legitimate answer aborts a working call. Probed 2026-08-25 with a 50 ms `sessionTimeout`
     * against this same 400 ms server: rejected at 71 ms with a bare
     * `Error: Unexpected error: http2 request did not get a response`.
     */
    const server = await listen((stream) => {
      setTimeout(() => {
        if (stream.destroyed) return
        stream.respond({ ":status": 200, "content-type": "application/json" })
        stream.end(JSON.stringify({ ok: true }))
      }, SLOW_ANSWER_MILLIS)
    })
    try {
      const result = await probe(server.endpoint, compressedOptions(), 1)
      expect(result.error).toBeUndefined()
      expect(result.outcome).toBe("answered")
    } finally {
      await server.close()
    }
  }, 30_000)

  it("reports a socket that never answers as a TimeoutError the retry layer re-attempts", async () => {
    /**
     * What `requestTimeout` buys, and why it is the bound that belongs here: it is armed on
     * the STREAM, and its rejection carries `name: "TimeoutError"`, which is what @smithy/core's
     * service-error-classification matches — so a dead socket is re-attempted. `attempts > 1`
     * is the assertion that says so; a bare `Error` with no `code` and no `$metadata` matches
     * no predicate and would report exactly one attempt.
     */
    const server = await listen(() => {})
    try {
      const result = await probe(server.endpoint, compressedOptions(), 2)
      expect(result.outcome).toBe("rejected")
      const error = result.error as { readonly name?: string; readonly $metadata?: unknown }
      expect(error.name).toBe("TimeoutError")
      expect((error.$metadata as { readonly attempts?: number } | undefined)?.attempts).toBe(2)
    } finally {
      await server.close()
    }
  }, 30_000)
})
