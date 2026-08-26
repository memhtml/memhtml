import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { correctMemory, type EmbedderShape, layerAppWith, writeMemory } from "@memhtml/cli"
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

/**
 * A pinned request URI, expanded from the published template's TWO holes.
 *
 * Both are filled from the template rather than concatenated, for the same reason as `fileUri`: a
 * template that reordered its holes, or renamed one, has to fail a read here rather than pass a
 * comparison of two strings this file built.
 */
const pinnedUriFor = (commit: string, path: string): string => {
  const template = RESOURCE_TEMPLATES.find((entry) => entry.includes("/at/"))
  if (template === undefined) throw new Error("no pinned resource template is published")
  return template.replace("{commit}", commit).replace("{path}", path)
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
  /**
   * A SECOND memory, corrected with a reworded title so the path it was written at is now vacant.
   *
   * Separate from `memoryPath` on purpose: the file resource's own tests read that one, and correcting
   * it would make them fail for a reason that has nothing to do with routing.
   */
  let pinnedPath: string
  /** The commit that wrote `pinnedPath` — the sha a receipt taken at that moment would carry. */
  let pinnedCommit: string
  /** Where the correction of `pinnedPath` landed. */
  let correctedPath: string
  /** The correction's own commit, so a read of `correctedPath` at a REAL sha is available. */
  let correctedCommit: string
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

    const pinned = await run(
      writeMemory({
        title: "The build box runs on a spinning disk",
        claim: "The build box stores its workspace on a spinning disk.",
        body: ["Parallel checkouts thrash the head, so the build serializes them."],
        memoryType: "semantic",
        workspace: "build-box",
        tags: [],
        entities: []
      })
    )
    pinnedPath = pinned.path
    if (pinned.commitSha === null) throw new Error("the write committed nothing to pin to")
    pinnedCommit = pinned.commitSha
    const corrected = await run(
      correctMemory({
        targetPath: pinnedPath,
        title: "The build box runs on an NVMe drive",
        claim: "The build box stores its workspace on an NVMe drive."
      })
    )
    correctedPath = corrected.path
    if (corrected.commitSha === null) throw new Error("the correction committed nothing")
    correctedCommit = corrected.commitSha

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

  it("publishes exactly the templates it routes", () => {
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

  it("vacates the pinned path, which is what makes the pin worth having", async () => {
    /**
     * The fixture's precondition, asserted rather than assumed. The correction reworded the title, so
     * the memory moved and the cited path holds nothing — if it still resolved, every assertion below
     * would pass against a resource that ignored its commit parameter entirely.
     */
    expect(correctedPath).not.toBe(pinnedPath)
    const live = await read(fileUri(pinnedPath))
    expect(live.ok).toBe(false)
    expect(pinnedCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("reads a memory AS OF a commit, at a path the tree no longer holds", async () => {
    const result = await read(pinnedUriFor(pinnedCommit, pinnedPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The ORIGINAL fact, not the correction's. The two differ in one word, which is exactly the kind of
    // drift a receipt is written to survive.
    expect(result.text).toContain("# The build box runs on a spinning disk")
    expect(result.text).toContain("spinning disk")
    expect(result.text).not.toContain("NVMe")
    expect(result.mimeType).toBe("text/plain")
  })

  it("returns the same bytes for the escaped spelling of a pinned path", async () => {
    const raw = await read(pinnedUriFor(pinnedCommit, pinnedPath))
    const encoded = await read(pinnedUriFor(pinnedCommit, pinnedPath.replaceAll("/", "%2F")))
    expect(encoded.ok).toBe(true)
    if (!encoded.ok || !raw.ok) return
    expect(encoded.text).toBe(raw.text)
  })

  it("refuses a ref that can MOVE, which is the whole contract of the pinned form", async () => {
    /**
     * `HEAD` and the branch name both resolve TODAY and mean something else after the next commit. A
     * resource that accepted them would publish a citation URI that silently re-points, which is worse
     * than having no pinned form at all, because the receipt would still look verified.
     *
     * The path here is `correctedPath`, which EXISTS at HEAD, so `git ls-tree HEAD -- <it>` would come
     * back with a blob and the read would succeed if the shape gate were absent. Naming a vacated path
     * instead would make this pass for the wrong reason.
     */
    for (const ref of ["HEAD", "main", "HEAD~1", "v1.0.0"]) {
      const result = await read(`memhtml://at/${ref}/${correctedPath}`)
      expect(result.ok, ref).toBe(false)
      if (result.ok) continue
      expect(result.message, ref).toContain("ERR_PATH_NOT_FOUND")
      expect(result.code, ref).toBe(-32602)
    }
    // And the same path at a real sha DOES read, so the refusals above are attributable to the ref
    // SHAPE rather than to anything about the path.
    const atSha = await read(pinnedUriFor(correctedCommit, correctedPath))
    expect(atSha.ok).toBe(true)
    if (!atSha.ok) return
    expect(atSha.text).toContain("NVMe")
  })

  it("refuses a well-formed sha this repository does not hold, without leaking git's own message", async () => {
    const absent = "0".repeat(40)
    const result = await read(pinnedUriFor(absent, pinnedPath))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("ERR_PATH_NOT_FOUND")
    // `git ls-tree` on an unknown object says "Not a valid object name" and names its argv; the client
    // gets a refusal about the URI it sent, and the real cause goes to stderr.
    expect(result.message).not.toContain("ls-tree")
    expect(result.message).not.toContain("Not a valid object")
    expect(result.message).not.toContain("/tmp/")
    expect(result.code).toBe(-32602)
  })

  it("refuses a NON-MEMORY file the commit really holds, rather than serving the tree", async () => {
    /**
     * The containment that a traversal cannot demonstrate. `../../etc/passwd` is refused by git itself
     * as a pathspec outside the repository, so a traversal case passes with the gate deleted; what only
     * `isValidMemoryPath` refuses is a path INSIDE the tree that is not a memory. A scaffolded repo has
     * a root `README.html`, and `git ls-tree <sha> -- README.html` returns its blob, so without the gate
     * this resource would hand a client any file in any commit of the repository.
     *
     * `ERR_PATH_NOT_FOUND` and not `ERR_INVALID_MEMORY`, and the distinction IS the assertion — the same
     * one the file resource's traversal case makes. The second code would mean the bytes were read and
     * then failed to parse, which is a read that happened.
     */
    const result = await read(pinnedUriFor(pinnedCommit, "README.html"))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain("ERR_INVALID_MEMORY")
    expect(result.message).toContain("ERR_PATH_NOT_FOUND")
    expect(result.code).toBe(-32602)
  })

  it("refuses a traversal in the pinned path", async () => {
    const result = await read(pinnedUriFor(pinnedCommit, "../../../../etc/passwd"))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain("root:")
    expect(result.message).toContain("ERR_PATH_NOT_FOUND")
    expect(result.code).toBe(-32602)
  })

  it("refuses a pinned URI carrying only one segment, which names no path at all", async () => {
    // The degenerate shape: a commit and nothing after it. Refused rather than read as a path, which
    // would hand the store an empty pathspec and let git answer with the whole tree.
    const result = await read(`memhtml://at/${pinnedCommit}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(-32602)
  })
})
