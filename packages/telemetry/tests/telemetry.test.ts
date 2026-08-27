import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { Effect, type Layer, Logger } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { layerTelemetry, type TelemetryModules } from "../src/index.js"

/**
 * A minimal OTLP/HTTP sink: accepts every POST, records body and path. A real collector is a
 * service dependency the suite must not have; the contract under test is "spans leave the process
 * as an OTLP JSON POST to `/v1/traces`", and an HTTP listener is the whole of that contract's
 * other side.
 */
interface Sink {
  readonly server: Server
  readonly url: string
  readonly requests: Array<{ path: string; body: string }>
}

const startSink = (): Promise<Sink> =>
  new Promise((resolve) => {
    const requests: Array<{ path: string; body: string }> = []
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8")
      })
      request.on("end", () => {
        requests.push({ path: request.url ?? "", body })
        response.writeHead(200, { "content-type": "application/json" })
        response.end("{}")
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${String(address.port)}`, requests })
    })
  })

/**
 * A program with a parent and a child span, run to completion INSIDE a scope so the exporter's
 * scope finalizer flushes the batch before the promise settles — the same shape as the CLI's
 * `Effect.scoped` pipeline and a short-lived invocation's only flush.
 */
const traced = (layer: Layer.Layer<never>) =>
  Effect.runPromise(
    Effect.succeed("leaf")
      .pipe(
        Effect.withSpan("test.child"),
        Effect.withSpan("test.parent", { attributes: { probe: true } })
      )
      .pipe(Effect.provide(layer), Effect.scoped)
  )

describe("layerTelemetry", () => {
  it("returns Layer.empty and never invokes the loader when the endpoint is unset", async () => {
    let loaded = 0
    const load = (): Promise<TelemetryModules> => {
      loaded += 1
      return Promise.reject(new Error("the disabled path must not load exporter modules"))
    }
    const layer = layerTelemetry({ serviceName: "memhtml-test", env: {}, load })
    await Effect.runPromise(
      Effect.succeed(1).pipe(Effect.withSpan("test.noop"), Effect.provide(layer), Effect.scoped)
    )
    expect(loaded).toBe(0)
  })

  it("treats a blank endpoint as unset", () => {
    let loaded = 0
    layerTelemetry({
      serviceName: "memhtml-test",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "   " },
      load: () => {
        loaded += 1
        return Promise.reject(new Error("unreachable"))
      }
    })
    expect(loaded).toBe(0)
  })

  describe("with a live sink", () => {
    let sink: Sink

    beforeAll(async () => {
      sink = await startSink()
    })

    afterAll(() => {
      sink.server.close()
    })

    it("exports the existing withSpan hierarchy as OTLP JSON to <endpoint>/v1/traces", async () => {
      await traced(
        layerTelemetry({
          serviceName: "memhtml-test",
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: sink.url }
        })
      )
      expect(sink.requests.length).toBeGreaterThan(0)
      const request = sink.requests[0]
      expect(request?.path).toBe("/v1/traces")
      const payload = JSON.parse(request?.body ?? "") as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
          scopeSpans: Array<{
            spans: Array<{ name: string; spanId: string; parentSpanId?: string }>
          }>
        }>
      }
      const resource = payload.resourceSpans[0]
      const serviceName = resource?.resource.attributes.find((a) => a.key === "service.name")
      expect(serviceName?.value.stringValue).toBe("memhtml-test")
      const spans = resource?.scopeSpans.flatMap((scope) => scope.spans) ?? []
      const names = spans.map((span) => span.name)
      expect(names).toContain("test.parent")
      expect(names).toContain("test.child")
      const parent = spans.find((span) => span.name === "test.parent")
      const child = spans.find((span) => span.name === "test.child")
      expect(child?.parentSpanId).toBe(parent?.spanId)
    })

    it("prefers OTEL_SERVICE_NAME over the assembly's default", async () => {
      const before = sink.requests.length
      await traced(
        layerTelemetry({
          serviceName: "memhtml-test",
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: sink.url, OTEL_SERVICE_NAME: "renamed" }
        })
      )
      const request = sink.requests[before]
      const payload = JSON.parse(request?.body ?? "") as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
        }>
      }
      const serviceName = payload.resourceSpans[0]?.resource.attributes.find(
        (a) => a.key === "service.name"
      )
      expect(serviceName?.value.stringValue).toBe("renamed")
    })

    it("tolerates a trailing slash on the endpoint", async () => {
      const before = sink.requests.length
      await traced(
        layerTelemetry({
          serviceName: "memhtml-test",
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: `${sink.url}/` }
        })
      )
      expect(sink.requests[before]?.path).toBe("/v1/traces")
    })
  })

  describe("with a dead collector", () => {
    /**
     * A port with nothing behind it: bind, read the number, close. The connection is then refused
     * rather than timing out, so the failure path runs in milliseconds.
     */
    const deadPort = (): Promise<number> =>
      new Promise((resolve) => {
        const server = createServer()
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as AddressInfo).port
          server.close(() => resolve(port))
        })
      })

    it("completes the program, logs one warning, and never touches the error channel", async () => {
      const port = await deadPort()
      const warnings: Array<string> = []
      const captured = Logger.make((options) => {
        if (options.logLevel === "Warn") warnings.push(String(options.message))
      })
      const value = await Effect.runPromise(
        Effect.succeed("survived")
          .pipe(Effect.withSpan("test.dead-collector"))
          .pipe(
            Effect.provide(
              layerTelemetry({
                serviceName: "memhtml-test",
                env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}` }
              })
            ),
            Effect.provide(Logger.layer([captured])),
            Effect.scoped
          )
      )
      expect(value).toBe("survived")
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("span export")
      expect(warnings[0]).toContain("continues without tracing")
    })
  })
})
