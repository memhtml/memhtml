import { join } from "node:path"

import { Roots, readMemory } from "@memhtml/cli"
import { isValidMemoryPath, normalizePath } from "@memhtml/contracts/paths"
import { reportFilename } from "@memhtml/sleep"
import { readFileOrNull, SLEEP_REPORTS_DIR } from "@memhtml/store"
import { Context, Effect, Layer } from "effect"
import { McpSchema, McpServer } from "effect/unstable/ai"

import { resourceFailure, type ToolFailure, toResourceFailure } from "./failure.js"

/**
 * The two resources, design.md §8.
 *
 * A resource is for CITATION-grade drill-down: a client that got a path from `memory_search` can
 * fetch `memhtml://file/<path>` and show a human the file behind an answer, without spending a tool call
 * and without the tool response having had to carry the whole body.
 */

/** The URI scheme both resources publish under, matching `SERVER_NAME`. */
const SCHEME = "memhtml"

/**
 * The router pattern that matches one resource's URIs, and why it is spelled this way.
 *
 * `McpServer` matches a `resources/read` URI with find-my-way (`effect/unstable/http/FindMyWay`,
 * effect 4.0.0-rc.109), and two of that router's rules decide this string:
 *
 * - A single `:` opens a NAMED PARAMETER, and `::` is the escape for a literal colon. The scheme's
 *   colon therefore has to be doubled; left single, `memhtml:` registers a parameter named `""`.
 * - A named parameter's value ENDS AT THE NEXT `/`, so `:path` matches exactly one segment and cannot
 *   reach `areas/oncall/x.html`. Every memory path has at least two segments and an archived one has
 *   at least four, so a single-segment route leaves the resource unreachable in normal use. `*` is the
 *   rest parameter, the only construct that matches across `/`, and the router requires it to be the
 *   LAST character of the pattern.
 *
 * The captured value does not arrive through the parameter array. `McpServer` folds a matched route's
 * parameters into a POSITIONAL array by `Number(name)`, and the rest parameter's name is `*`, so
 * `Number("*")` is `NaN` and the slot is never filled. The handler therefore reads its one parameter
 * out of the URI, which the match always carries — see {@link capturedOf}.
 */
const routerPathFor = (section: string): string => `${SCHEME}:://${section}/*`

/** The literal head of every URI a section serves, up to and including its parameter's slash. */
const prefixOf = (section: string): string => `${SCHEME}://${section}/`

/**
 * The part of a URI after `memhtml://<section>/`, percent-escapes decoded, or a refusal.
 *
 * ONE decode covers both spellings a client can send. `areas/oncall/x.html` passes through unchanged,
 * and `areas%2Foncall%2Fx.html` decodes to the same string, so a client that escaped the separators
 * and a client that did not name the same resource.
 *
 * The prefix has to be present VERBATIM. The router tolerates repeated slashes and this does not, so
 * `memhtml:///file/x.html` matches the route and is then refused here, rather than sliced at an offset
 * a character away from the one that matched.
 *
 * The `decodeURIComponent` guard is a boundary rather than a branch the route can reach today: the
 * router decodes a whole URI before it matches anything, so `%zz` matches nothing and never arrives.
 * An undecodable value that did arrive is a URI this server cannot read rather than a file that is
 * missing, and it is refused with the URI echoed back for the caller to compare against what it sent.
 */
const capturedOf = (
  uri: string,
  section: string,
  refuse: (uri: string) => ToolFailure
): Effect.Effect<string, ToolFailure> => {
  const prefix = prefixOf(section)
  if (!uri.startsWith(prefix)) return Effect.fail(refuse(uri))
  try {
    return Effect.succeed(decodeURIComponent(uri.slice(prefix.length)))
  } catch {
    return Effect.fail(refuse(uri))
  }
}

/** One resource: what it publishes, how its URIs route, and what a read of it returns. */
interface TemplateSpec<E, R> {
  /** The path segment after the scheme, which is also the route's static prefix. */
  readonly section: string
  /**
   * The RFC 6570 template `resources/templates` publishes, as a LITERAL.
   *
   * Not composed from {@link prefixOf}, and that is the point: the template a client reads and the
   * route the server matches are two independent readings of one URI shape, and a test that compared
   * a constructed template against a constructed route would compare a value with itself. The tie is
   * `tests/resources.test.ts`, which builds its request URI out of the PUBLISHED template and expects
   * the read to resolve, so a template that drifted from its route fails a read rather than a literal.
   */
  readonly uriTemplate: string
  readonly name: string
  readonly description: string
  readonly mimeType: string
  /** This URI names nothing this resource can read. */
  readonly refuse: (uri: string) => ToolFailure
  /** The body, given the URI and the value its rest parameter captured. */
  readonly read: (uri: string, captured: string) => Effect.Effect<string, E, R>
}

/**
 * One resource template, registered on the server.
 *
 * `McpServer.addResourceTemplate` rather than the `McpServer.resource` tagged template, because the
 * tagged template compiles its parameters to named router parameters and those stop at a `/` — see
 * {@link routerPathFor}. Registering the route directly is what lets one published template serve a
 * path of any depth.
 *
 * **Every failure is sanitized here, and the handler never dies.** A defect becomes a stated refusal
 * through `catchDefect` and a typed failure becomes one through `toResourceFailure`, both AFTER
 * `tapCause` has put the real cause on stderr, where an operator reads it. An `Effect.orDie` in its
 * place hands the client `Cause.prettyErrors(cause)[0].message`: an absolute filesystem path for a
 * missing sleep report, and a `PathNotFound` stripped of its `ERR_*` code and its suggestions.
 *
 * `Layer.provide(McpServer.layer)` mirrors what `McpServer.resource` does with the same static layer
 * reference, so the registry this writes into is the one `layerStdio` serves from: a layer is
 * memoized per build, so naming it here twice is naming it once.
 */
const templateLayer = <E, R>(spec: TemplateSpec<E, R>): Layer.Layer<never, never, R> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* McpServer.McpServer
      const services = yield* Effect.context<R>()
      yield* registry.addResourceTemplate({
        template: new McpSchema.ResourceTemplate({
          uriTemplate: spec.uriTemplate,
          name: spec.name,
          description: spec.description,
          mimeType: spec.mimeType
        }),
        routerPath: routerPathFor(spec.section),
        annotations: Context.empty(),
        completions: {},
        handle: (uri) =>
          capturedOf(uri, spec.section, spec.refuse).pipe(
            Effect.flatMap((captured) => spec.read(uri, captured)),
            Effect.map((text) => ({ contents: [{ uri, mimeType: spec.mimeType, text }] })),
            Effect.tapCause(Effect.logError),
            Effect.catchDefect(() =>
              Effect.fail(
                resourceFailure("ERR_UNKNOWN", "the server could not read that resource", [
                  "retry the read once",
                  "report this to the operator if it persists — the server's own log carries the detail"
                ])
              )
            ),
            Effect.mapError(toResourceFailure),
            Effect.provideContext(services)
          )
      })
    })
  ).pipe(Layer.provide(McpServer.McpServer.layer))

/** `memhtml://file/{path}`: nothing readable behind this URI. */
const fileRefusal = (uri: string): ToolFailure =>
  resourceFailure("ERR_PATH_NOT_FOUND", `nothing to read at ${uri}`, [
    `re-request it as ${prefixOf("file")}<repo-root-relative path>, the form resources/templates publishes`,
    "call memory_search or memory_list for a path this corpus holds"
  ])

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
 * This read BUMPS salience, through the same `readMemory` the `memory_read` tool calls. The bump is
 * deliberate: the caller named one specific path, which is a chosen open. A client
 * fetching the file behind an answer is making the same statement an agent makes with `memory_read`,
 * and the plane should not be able to tell them apart.
 *
 * **`isValidMemoryPath` gates the path before the store sees it, and that is containment rather than
 * validation.** The rest parameter accepts `/`, so it also accepts `../../etc/passwd`, and the store's
 * reader joins a repo-relative path onto the git root without a traversal check of its own. The gate
 * refuses any path carrying a `.` or `..` segment, any path outside the four PARA buckets, and
 * anything not ending in `.html`, which is every memory path and nothing else.
 */
export const FileResource = templateLayer({
  section: "file",
  uriTemplate: "memhtml://file/{path}",
  name: "Memory file",
  description:
    "One memory's title, claim, and body text, by repo-root-relative path. For showing a human the file behind an answer.",
  mimeType: "text/plain",
  refuse: fileRefusal,
  read: (uri, captured) =>
    Effect.gen(function* () {
      if (!isValidMemoryPath(captured)) return yield* Effect.fail(fileRefusal(uri))
      const result = yield* readMemory(normalizePath(captured))
      return [
        `# ${result.doc.title}`,
        "",
        result.doc.article.gist,
        "",
        result.doc.article.bodyText
      ].join("\n")
    })
})

/** `memhtml://sleep/{run-id}`: no committed report behind this URI. */
const sleepRefusal = (uri: string): ToolFailure =>
  resourceFailure("ERR_PATH_NOT_FOUND", `no sleep report at ${uri}`, [
    "call memory_status to read the id and the status of the last sleep run",
    "report this to the operator if memory_status names this run — its report never committed"
  ])

/**
 * A sleep run's report, by run id.
 *
 * The report is a COMMITTED file under `.memhtml/sleep/`, so this resource reads the tree rather than the
 * database: the report is the durable artifact of a run and the `sleep_runs` row is reporting
 * convenience.
 *
 * **The filename comes from `reportFilename`, the function the sleep phase writes it with.** A run id
 * is `sleep/<YYYY-MM-DD>` and a `/` is not legal in a filename, so the producer folds the separator to
 * a hyphen and the file is `sleep-2026-08-02.html`. Deriving that here a second time is the
 * consumer-side reimplementation of a producer's naming rule that this repo forbids; importing it
 * means the two cannot disagree. It also contains the read for free, since folding every `/` leaves a
 * caller no way to name a directory.
 *
 * The run id is taken VERBATIM, in the `sleep/<date>` spelling `memory_status.last_sleep.run_id`
 * publishes, so the value a client copies out of a status call is the value this resource takes.
 */
export const SleepResource = templateLayer({
  section: "sleep",
  uriTemplate: "memhtml://sleep/{run-id}",
  name: "Sleep run report",
  description:
    "One sleep run's committed HTML report: per-phase counts, commits, and what the run changed.",
  mimeType: "text/html",
  refuse: sleepRefusal,
  read: (uri, runId) =>
    Effect.gen(function* () {
      const roots = yield* Roots
      const html = yield* readFileOrNull(
        join(roots.memhtmlRoot, SLEEP_REPORTS_DIR, reportFilename(runId))
      )
      return html === null ? yield* Effect.fail(sleepRefusal(uri)) : html
    })
})

/** Both resources as one layer, for the server to provide. */
export const Resources = Layer.mergeAll(FileResource, SleepResource)

/** The templates, for a test to assert the surface without a handshake. */
export const RESOURCE_TEMPLATES = ["memhtml://file/{path}", "memhtml://sleep/{run-id}"] as const
