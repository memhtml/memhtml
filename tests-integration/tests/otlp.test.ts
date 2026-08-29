import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"
import { runBuilt } from "./spawned.js"

/**
 * Issue #85's acceptance sketch, against the BUILT binary: the ~30 `Effect.withSpan` annotations
 * already in the code export as OTLP traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and the
 * opt-in changes nothing else — stdout stays one JSON envelope, the exit code is the command's own,
 * and a dead collector degrades to a warning rather than a failure.
 *
 * The collector is a mock HTTP sink rather than a real one: the contract under test ends at "an
 * OTLP JSON POST arrived at `/v1/traces` carrying the expected span names", and everything past
 * that belongs to whatever collector an operator runs.
 */

interface OtlpRequest {
  readonly path: string
  readonly body: string
}

const startSink = (): Promise<{ server: Server; url: string; requests: Array<OtlpRequest> }> =>
  new Promise((resolve) => {
    const requests: Array<OtlpRequest> = []
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

/** Every span name across every request the sink has seen, with its service.name resource. */
const spansOf = (requests: ReadonlyArray<OtlpRequest>) => {
  const names: Array<string> = []
  const services = new Set<string>()
  for (const request of requests) {
    const payload = JSON.parse(request.body) as {
      resourceSpans?: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
        scopeSpans: Array<{ spans: Array<{ name: string }> }>
      }>
    }
    for (const resourceSpan of payload.resourceSpans ?? []) {
      const service = resourceSpan.resource.attributes.find((a) => a.key === "service.name")
      if (service?.value.stringValue !== undefined) services.add(service.value.stringValue)
      for (const scope of resourceSpan.scopeSpans) {
        for (const span of scope.spans) names.push(span.name)
      }
    }
  }
  return { names, services }
}

describe("the opt-in OTLP trace exporter (issue #85)", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  describe("endpoint set to a live collector", () => {
    let sink: Awaited<ReturnType<typeof startSink>>

    beforeAll(async () => {
      sink = await startSink()
    })

    afterAll(() => {
      sink.server.close()
    })

    it("search exports retrieval.search with db.* children, envelope and exit code untouched", async () => {
      const spawned = await runBuilt(cli.root, ["search", "anything at all"], {
        OTEL_EXPORTER_OTLP_ENDPOINT: sink.url
      })
      expect(spawned.exitCode).toBe(0)
      // The whole stdout parses as ONE JSON value: the envelope contract, with the exporter live.
      const envelope = JSON.parse(spawned.stdout) as { type?: string }
      expect(envelope.type).toBe("memory.hits")
      // The exporter's own diagnostics never reach stdout; SDK chatter there would have broken the
      // parse above, and this asserts the stronger claim that spans went out-of-band entirely.
      expect(sink.requests.length).toBeGreaterThan(0)
      expect(sink.requests.every((request) => request.path === "/v1/traces")).toBe(true)
      const { names, services } = spansOf(sink.requests)
      expect(names).toContain("retrieval.search")
      expect(names.some((name) => name.startsWith("db."))).toBe(true)
      expect(services).toContain("memhtml-cli")
    })

    it("honors OTEL_SERVICE_NAME over the per-app default", async () => {
      const before = sink.requests.length
      const spawned = await runBuilt(cli.root, ["search", "renamed probe"], {
        OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
        OTEL_SERVICE_NAME: "renamed-cli"
      })
      expect(spawned.exitCode).toBe(0)
      const { services } = spansOf(sink.requests.slice(before))
      expect(services).toContain("renamed-cli")
      expect(services).not.toContain("memhtml-cli")
    })
  })

  describe("endpoint set to a dead port", () => {
    it("command succeeds with the same envelope, exit code 0, and one stderr warning", async () => {
      /** Bind, read the port, close: refused connections rather than timeouts. */
      const port = await new Promise<number>((resolve) => {
        const server = createServer()
        server.listen(0, "127.0.0.1", () => {
          const bound = (server.address() as AddressInfo).port
          server.close(() => resolve(bound))
        })
      })
      const spawned = await runBuilt(cli.root, ["search", "collector is down"], {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}`
      })
      expect(spawned.exitCode).toBe(0)
      const envelope = JSON.parse(spawned.stdout) as { type?: string }
      expect(envelope.type).toBe("memory.hits")
      const warnings = spawned.stderr
        .split("\n")
        .filter((line) => line.includes("span export") && line.includes("without tracing"))
      expect(warnings.length).toBe(1)
    })
  })

  describe("endpoint unset", () => {
    it("keeps stderr free of telemetry and stdout one envelope — the default is untouched", async () => {
      const spawned = await runBuilt(cli.root, ["search", "no telemetry configured"])
      expect(spawned.exitCode).toBe(0)
      expect((JSON.parse(spawned.stdout) as { type?: string }).type).toBe("memory.hits")
      expect(spawned.stderr).not.toContain("span export")
      expect(spawned.stderr).not.toContain("OTLP")
    })
  })
})
