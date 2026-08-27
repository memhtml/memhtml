import { Effect, Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"

/**
 * The opt-in OTLP trace exporter, gated on `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Every interesting phase of this system already carries an `Effect.withSpan` annotation —
 * retrieval, embeddings, model calls, indexing, the sleep cycle, store writes, trace scanning, plus
 * the dynamic `db.<operation>` and `git.<command>` families. Effect's tracer is a `Context.Reference`
 * with an in-process default, so those spans are constructed and discarded unless a runtime assembly
 * overrides the reference. This layer is that override, and the call sites need no changes: providing
 * it is the whole integration.
 *
 * The exporter is effect's own `OtlpTracer` from `effect/unstable/observability` rather than the
 * OpenTelemetry JS SDK. On the v4 line the OTLP client lives inside `effect` itself (JSON
 * serialization, batching, retry, flush-on-scope-close), so export adds ZERO dependencies —
 * `@effect/opentelemetry` and the `@opentelemetry/*` peer set exist for integrating an already-running
 * OTel SDK, which is not this repo's situation.
 */

/** The two module graphs the exporter needs, loaded only when the endpoint is set. */
export interface TelemetryModules {
  readonly http: typeof import("effect/unstable/http")
  readonly observability: typeof import("effect/unstable/observability")
}

const loadModules = async (): Promise<TelemetryModules> => {
  const [http, observability] = await Promise.all([
    import("effect/unstable/http"),
    import("effect/unstable/observability")
  ])
  return { http, observability }
}

export interface TelemetryOptions {
  /**
   * The `service.name` resource attribute when `OTEL_SERVICE_NAME` is absent: which of the runtime
   * assemblies this process is (`memhtml-cli`, `memhtml-mcp`), because one collector typically
   * receives both and the operator's first question is which process a trace came from.
   */
  readonly serviceName: string
  /**
   * The environment snapshot, defaulting to `process.env`, read when the factory is CALLED rather
   * than through `effect/Config` — Config's default provider snapshots `process.env` at module load
   * (`apps/cli/src/api-layer.ts:417-424`), and this factory runs once per invocation, so a test that
   * sets the variable after import must still be seen.
   */
  readonly env?: Record<string, string | undefined> | undefined
  /**
   * The module loader, injectable so a test can PROVE the disabled path loads nothing: the
   * acceptance bar is not "no spans exported" but "no exporter code even evaluated", and only a
   * loader spy can tell those apart.
   */
  readonly load?: (() => Promise<TelemetryModules>) | undefined
}

/**
 * A wrapper over the exporter's HTTP client that logs ONE warning on the first failed export and
 * stays silent after.
 *
 * The exporter itself already never fails the program: after its retries it catches the cause,
 * disables itself for sixty seconds, and emits only a DEBUG log — invisible at the default level. A
 * command pointed at a down collector would silently export nothing, and "opt-in that silently does
 * nothing" is indistinguishable from "opt-in that was never read". One warning names the failure;
 * one rather than one-per-batch because a long `sleep run` against a dead collector would
 * otherwise write hundreds of identical lines into a log someone has to read. It goes through
 * `Effect.logWarning`, so it lands wherever the assembly's logger writes — stderr in both, because
 * both set `Logger.LogToStderr` (stdout is the envelope / the RPC stream).
 */
const warnOnce = (
  client: HttpClient.HttpClient,
  http: TelemetryModules["http"],
  url: string
): HttpClient.HttpClient => {
  let warned = false
  return http.HttpClient.tapError(client, () =>
    Effect.suspend(() => {
      if (warned) return Effect.void
      warned = true
      return Effect.logWarning(
        `telemetry: span export to ${url} failed; the command continues without tracing`
      )
    })
  )
}

/**
 * The tracer layer for one runtime assembly.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` unset or blank returns `Layer.empty`: byte-identical behavior to
 * today, no exporter module loaded, no socket opened. Set, the layer overrides effect's tracer
 * reference with a batching OTLP HTTP exporter aimed at `<endpoint>/v1/traces` (the standard
 * per-signal path; a trailing slash on the endpoint is tolerated because both spellings arrive
 * from shell profiles).
 *
 * Export can never fail a command. The exporter retries transient failures, then disables itself
 * and drops the batch — the program's error channel never sees it, so the envelope, the exit code,
 * and the MCP stream are exactly what they would have been. The final batch of a short-lived
 * process is flushed when the layer's scope closes (`Effect.scoped` in the CLI, `Layer.launch` in
 * the server), bounded by the exporter's own shutdown timeout so a dead collector delays exit by
 * seconds, never hangs it.
 */
export const layerTelemetry = (options: TelemetryOptions): Layer.Layer<never> => {
  const env = options.env ?? process.env
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim()
  if (endpoint === undefined || endpoint === "") return Layer.empty
  const serviceName = env["OTEL_SERVICE_NAME"]?.trim() || options.serviceName
  const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`
  const load = options.load ?? loadModules
  return Layer.unwrap(
    Effect.map(Effect.promise(load), ({ http, observability }) =>
      observability.OtlpTracer.layer({ url, resource: { serviceName } }).pipe(
        Layer.provide(observability.OtlpSerialization.layerJson),
        Layer.provide(
          Layer.effect(
            http.HttpClient.HttpClient,
            Effect.map(Effect.service(http.HttpClient.HttpClient), (client) =>
              warnOnce(client, http, url)
            )
          ).pipe(Layer.provide(http.FetchHttpClient.layer))
        )
      )
    )
  )
}
