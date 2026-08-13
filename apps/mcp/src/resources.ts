import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { Roots, readMemory } from "@memhtml/cli"
import { SLEEP_REPORTS_DIR } from "@memhtml/store"
import { Effect, Layer, Schema } from "effect"
import { McpSchema, McpServer } from "effect/unstable/ai"

/**
 * The two resources, design.md §8.
 *
 * A resource is for CITATION-grade drill-down: a client that got a path from `memory_search` can
 * fetch `memhtml://file/<path>` and show a human the file behind an answer, without spending a tool call
 * and without the tool response having had to carry the whole body.
 *
 * `McpSchema.param` names each template parameter, so `tools/list`'s sibling `resources/templates`
 * publishes `{path}` and `{run-id}` as named rather than positional holes.
 */

/** `memhtml://file/{path}`: one memory's rendered content. */
const pathParam = McpSchema.param("path", Schema.String)

/** `memhtml://sleep/{run-id}`: one sleep run's committed HTML report. */
const runIdParam = McpSchema.param("run-id", Schema.String)

/**
 * A memory file, by path.
 *
 * The BODY is returned, not the raw HTML file. A client asking a resource for a citation wants the
 * text a human reads; the markup is the storage format, and handing back a full document with a head
 * full of `memhtml-*` metas would spend a client's rendering budget on bookkeeping. The metadata is
 * available through `memory_read`, which is the tool for exactly that.
 *
 * A missing path fails the read rather than answering with an empty resource: a citation that
 * silently resolves to nothing is worse than one that says the file is gone.
 *
 * This read BUMPS salience, through the same `readMemory` the `memory_read` tool calls, and that is
 * correct rather than incidental: the caller named one specific path, which is a chosen open. A client
 * fetching the file behind an answer is making the same statement an agent makes with `memory_read`,
 * and the plane should not be able to tell them apart.
 */
export const FileResource = McpServer.resource`memhtml://file/${pathParam}`({
  name: "Memory file",
  description:
    "One memory's title, claim, and body text, by repo-root-relative path. For showing a human the file behind an answer.",
  mimeType: "text/plain",
  content: (_uri, path) =>
    Effect.gen(function* () {
      const result = yield* readMemory(path)
      return [
        `# ${result.doc.title}`,
        "",
        result.doc.article.gist,
        "",
        result.doc.article.bodyText
      ].join("\n")
    }).pipe(Effect.orDie)
})

/**
 * A sleep run's report, by run id.
 *
 * The report is a COMMITTED file under `.memhtml/sleep/`, so this resource reads the tree rather than the
 * database: the report is the durable artifact of a run and the `sleep_runs` row is reporting
 * convenience. A run id arrives as `sleep/2026-08-02`, and the file is named for its last segment.
 */
export const SleepResource = McpServer.resource`memhtml://sleep/${runIdParam}`({
  name: "Sleep run report",
  description:
    "One sleep run's committed HTML report: per-phase counts, commits, and what the run changed.",
  mimeType: "text/html",
  content: (_uri, runId) =>
    Effect.gen(function* () {
      const roots = yield* Roots
      // The last segment only: a run id is `sleep/<date>` and the file is `<date>.html`, so joining
      // the whole id would look for `.memhtml/sleep/sleep/<date>.html`.
      const name = runId.split("/").at(-1) ?? runId
      const path = join(roots.memhtmlRoot, SLEEP_REPORTS_DIR, `${name}.html`)
      return yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => cause
      })
    }).pipe(Effect.orDie)
})

/** Both resources as one layer, for the server to provide. */
export const Resources = Layer.mergeAll(FileResource, SleepResource)

/** The templates, for a test to assert the surface without a handshake. */
export const RESOURCE_TEMPLATES = ["memhtml://file/{path}", "memhtml://sleep/{run-id}"] as const
