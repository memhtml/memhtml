import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { type EmbedderShape, layerAppWith, writeMemory } from "@memhtml/cli"
import { reportFilename } from "@memhtml/sleep"
import { SLEEP_REPORTS_DIR } from "@memhtml/store"
import { makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Layer } from "effect"
import { McpSchema, McpServer } from "effect/unstable/ai"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { RESOURCE_TEMPLATES, Resources } from "../src/resources.js"

/**
 * A `resources/read` through the REAL registry: the router that matches a URI, the handler, the shared
 * use case, and the failure translation, against a real temp git repo and real migrations.
 *
 * `McpServer.findResource` is the function the `resources/read` RPC handler calls, so this exercises
 * everything a client's read touches except the transport frame. Calling a resource's `content`
 * function directly would skip the ROUTER, which is the half that decides whether a URI resolves at
 * all — and a resource whose route cannot match a real path is a resource no client can reach.
 */

const FAKE_DIM = 1024

/**
 * A request URI, expanded from the template the server publishes.
 *
 * Written this way rather than as a literal so the tests below cannot agree with a template that no
 * longer matches the route. `{path}` is the one hole the file template declares.
 */
const fileUri = (path: string): string => {
  const template = RESOURCE_TEMPLATES.find((entry) => entry.includes("/file/"))
  if (template === undefined) throw new Error("no file resource template is published")
  return template.replace("{path}", path)
}

/** The deterministic embedder, same construction as the CLI harness. */
const fakeEmbedder = (): EmbedderShape => {
  const vector = (text: string): Float32Array => {
    const out = new Float32Array(FAKE_DIM)
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const digest = createHash("sha256").update(token, "utf8").digest()
      const first = digest.readUInt32BE(0) % FAKE_DIM
      const second = digest.readUInt32BE(4) % FAKE_DIM
      out[first] = (out[first] ?? 0) + 1
      out[second] = (out[second] ?? 0) + 0.5
    }
    let norm = 0
    for (const component of out) norm += component * component
    if (norm === 0) return out
    const scale = 1 / Math.sqrt(norm)
    for (let at = 0; at < out.length; at += 1) out[at] = (out[at] ?? 0) * scale
    return out
  }
  const port = {
    embed: (texts: ReadonlyArray<string>) => Effect.sync(() => texts.map(vector)),
    embedQuery: (text: string) => Effect.sync(() => vector(text))
  }
  return { document: port, query: port }
}

/**
 * The initialized client a read runs as.
 *
 * `findResource` reads five fields off it and hands the whole value to the handler as the request
 * context; `getClient` is the reverse channel, which no resource opens. Built here rather than by
 * standing up a transport, because a handshake would test the transport and this file's subject is
 * the routing.
 */
const client: McpSchema.McpServerClient["Service"] = {
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: new McpSchema.ClientCapabilities({}),
  clientInfo: { name: "resource-read-test", version: "0.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: new McpSchema.ClientCapabilities({}),
    clientInfo: { name: "resource-read-test", version: "0.0.0" }
  },
  getClient: Effect.die("a resource never opens the reverse channel")
}

describe("a resources/read through the real registry", () => {
  let cleanup: () => Promise<void>
  /** One read, as the client sees it: the contents, or the JSON-RPC error prose. */
  let read: (
    uri: string
  ) => Promise<
    | { readonly ok: true; readonly text: string; readonly mimeType: string | undefined }
    | { readonly ok: false; readonly code: number; readonly message: string }
  >
  /** The multi-segment path the fixture's one memory landed at. */
  let memoryPath: string
  /** The run id whose report the fixture staged. */
  let runId: string
  /** The `uriTemplate` of every template the registry actually published. */
  let templates: ReadonlyArray<string>

  beforeAll(async () => {
    const fixture = await Effect.runPromise(makeFixtureRepo())
    cleanup = fixture.cleanup

    /**
     * `provideMerge`, and `McpServer.McpServer.layer` named on BOTH sides.
     *
     * `Resources` provides that same static layer internally, exactly as `McpServer.resource` does,
     * and a layer is memoized per build by identity — so naming it again here yields the registry the
     * resources wrote into rather than a second empty one. That is the same sharing `layerServer`
     * relies on between the resources and `layerStdio`.
     */
    const layer = Layer.mergeAll(Resources, McpServer.McpServer.layer).pipe(
      Layer.provideMerge(layerAppWith({ repo: fixture.root, embedder: fakeEmbedder() }))
    )

    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
      Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)))

    const written = await run(
      writeMemory({
        title: "Prod rollbacks drain the VIP first",
        claim: "Drain the VIP before reverting the deploy.",
        body: ["The revert alone leaves in-flight connections pinned to the retired target group."],
        memoryType: "procedural",
        workspace: "checkout-api",
        tags: [],
        entities: []
      })
    )
    memoryPath = written.path

    /**
     * The report file at exactly the path the sleep phase writes it to, named by the producer's own
     * `reportFilename`. Placed on disk rather than committed, because the resource reads the tree and
     * a commit would change nothing about the read — but the FILENAME is the point: derive it any
     * other way here and the test stops being able to fail when the resource looks elsewhere.
     */
    runId = "sleep/2026-08-02"
    const reportPath = join(fixture.root, SLEEP_REPORTS_DIR, reportFilename(runId))
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, "<!doctype html><title>Sleep run sleep/2026-08-02</title>", "utf8")

    templates = await run(
      McpServer.McpServer.useSync((server) =>
        server.resourceTemplates.map((entry) => entry.template.uriTemplate)
      )
    )

    read = (uri) =>
      run(
        McpServer.McpServer.use((server) => server.findResource(uri)).pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.map((result) => {
            const first = result.contents[0]
            const text = first !== undefined && "text" in first ? first.text : ""
            return {
              ok: true as const,
              text,
              mimeType: first?.mimeType
            }
          }),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              code: error.code as number,
              message: error.message
            })
          )
        )
      )
  })

  afterAll(async () => {
    await cleanup()
  })

  it("writes the fixture memory at a MULTI-SEGMENT path, which is what makes the rest of this file a test", () => {
    /**
     * Every PARA path has at least two segments and this fixture's has three, so a route that stopped
     * at the first `/` could not reach it. Asserted rather than assumed: a one-segment fixture would
     * let a single-segment route pass every case below.
     */
    expect(memoryPath.split("/").length).toBeGreaterThan(1)
    expect(memoryPath).toMatch(/^projects\/checkout-api\/.*\.html$/)
  })

  it("resolves a multi-segment path with the slashes RAW", async () => {
    /**
     * The URI is expanded from the PUBLISHED template rather than written out here, which is what ties
     * the two independent readings of the URI shape together: the string a client reads out of
     * `resources/templates`, and the route the server compiled. A template that drifted from its route
     * fails this read instead of passing a comparison of two constructed strings.
     */
    const result = await read(fileUri(memoryPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain("# Prod rollbacks drain the VIP first")
    expect(result.text).toContain("Drain the VIP before reverting the deploy.")
    expect(result.text).toContain("in-flight connections pinned to the retired target group")
    expect(result.mimeType).toBe("text/plain")
  })

  it("resolves the SAME path with its separators percent-encoded", async () => {
    const raw = await read(fileUri(memoryPath))
    const encoded = await read(fileUri(memoryPath.replaceAll("/", "%2F")))
    expect(encoded.ok).toBe(true)
    if (!encoded.ok || !raw.ok) return
    // One decode serves both spellings, so the two URIs name one resource rather than one resource
    // and one 404.
    expect(encoded.text).toBe(raw.text)
  })

  it("publishes exactly the two templates it routes", () => {
    /**
     * Read off the SAME registry the reads above resolved against, which is what makes this a check on
     * the published surface rather than on the `RESOURCE_TEMPLATES` literal restating itself. A
     * template registered under one string and routed under another would pass a literal comparison
     * and fail every read.
     */
    expect([...templates].sort()).toEqual([...RESOURCE_TEMPLATES].sort())
  })

  it("reads a sleep report under the filename the sleep phase writes", async () => {
    const result = await read(`memhtml://sleep/${runId}`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain("Sleep run sleep/2026-08-02")
    expect(result.mimeType).toBe("text/html")
  })

  /**
   * The failure discipline, and the three things a client-visible message must and must not carry.
   *
   * The absolute-path assertion is the one that matters: the fixture root is a temp directory whose
   * name identifies the machine, and a resource handler that dies hands the client
   * `Cause.prettyErrors(cause)[0].message`, which names the file the read was attempted at.
   */
  it("refuses a missing memory with its code and its suggestions, and no absolute path", async () => {
    const result = await read("memhtml://file/areas/oncall/not-a-memory.html")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain("/tmp/")
    expect(result.message).not.toContain("Error:")
    expect(result.message).toContain("ERR_PATH_NOT_FOUND")
    expect(result.message).toContain("areas/oncall/not-a-memory.html")
    expect(result.message).toContain("Try: ")
    expect(result.message).toContain("memory_search")
    // -32602, the code `McpServer` itself returns for a URI naming nothing.
    expect(result.code).toBe(-32602)
  })

  it("refuses a missing sleep report without naming a filesystem path", async () => {
    const result = await read("memhtml://sleep/sleep/1999-01-01")
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The report lives under `.memhtml/sleep/`, and the absolute join of it is what a died handler
    // puts on the wire. Neither the directory nor the temp root may appear.
    expect(result.message).not.toContain(SLEEP_REPORTS_DIR)
    expect(result.message).not.toContain("/tmp/")
    expect(result.message).not.toContain("ENOENT")
    expect(result.message).toContain("ERR_PATH_NOT_FOUND")
    expect(result.message).toContain("memory_status")
    expect(result.code).toBe(-32602)
  })

  /**
   * Containment, which the rest parameter makes necessary: it accepts `/`, so it also accepts a
   * traversal, and the store's reader joins a repo-relative path onto the git root with no check of
   * its own. A refusal here is the only thing between a client and an arbitrary file read.
   */
  it("refuses a traversal rather than reading outside the repo", async () => {
    const result = await read("memhtml://file/../../../../etc/passwd")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain("root:")
    /**
     * `ERR_PATH_NOT_FOUND` and not `ERR_INVALID_MEMORY`, and that distinction IS the assertion. The
     * store's reader has no traversal check of its own, so without the gate the file is opened and the
     * render gate refuses what came back — a refusal that arrives only because `/etc/passwd` is not
     * memory-shaped HTML. The code says whether the read happened.
     */
    expect(result.message).not.toContain("ERR_INVALID_MEMORY")
    expect(result.message).toContain("ERR_PATH_NOT_FOUND")
    expect(result.code).toBe(-32602)
  })

  /**
   * A malformed escape never reaches the handler: the router decodes the whole URI before it matches
   * anything, and an undecodable one matches no route at all, so this is `McpServer`'s own refusal
   * rather than this server's. Asserted anyway, because the OUTCOME is part of the resource contract —
   * one JSON-RPC code and no filesystem detail, whichever layer produced it.
   */
  it("refuses a malformed percent escape with no filesystem detail", async () => {
    const result = await read("memhtml://file/areas/oncall/%zz.html")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(-32602)
    expect(result.message).not.toContain("/tmp/")
    expect(result.message).not.toContain(".memhtml")
  })

  /**
   * A URI the ROUTE matches but the published template does not spell.
   *
   * The router collapses repeated slashes, so `memhtml:///file/…` reaches the handler while carrying a
   * prefix one character longer than the published one. Slicing at the published length would hand the
   * store a path shifted by a character; naming the prefix as a requirement refuses it instead, with
   * the code and the suggestions every other refusal carries.
   */
  it("refuses a URI the route matches but the published template does not spell", async () => {
    const result = await read(`memhtml:///file/${memoryPath}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(-32602)
    expect(result.message).toContain("ERR_PATH_NOT_FOUND")
    expect(result.message).toContain("memhtml://file/")
    expect(result.message).toContain("Try: ")
  })
})
