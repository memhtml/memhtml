`@memhtml/telemetry`: the opt-in trace exporter. It sends the spans memhtml already records to an OpenTelemetry collector over OTLP HTTP, and it does nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

The package exports one function and two interfaces. `layerTelemetry` takes a `TelemetryOptions` and returns an Effect layer that a runtime assembly provides. The CLI provides it with the service name `memhtml-cli` (`apps/cli/src/run.ts`), and the MCP server with `memhtml-mcp` (`apps/mcp/src/server.ts`).

With `OTEL_EXPORTER_OTLP_ENDPOINT` unset or blank, the layer is `Layer.empty` and no socket is opened.

With the variable set, the layer replaces Effect's tracer with Effect's own `OtlpTracer`, which batches spans and posts them as JSON to `<endpoint>/v1/traces`, with trailing slashes on the endpoint dropped. The `service.name` resource attribute is `OTEL_SERVICE_NAME` when that variable is set and not blank, and the assembly's `serviceName` otherwise.

`layerTelemetry` reads `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` when it is called, from `options.env` when given and `process.env` otherwise. `TelemetryModules` names the two Effect modules the exporter needs, `effect/http` and `effect/observability`. This package imports them only when the endpoint is set, through a loader that `options.load` replaces so a test can check that the disabled path never calls it.

A failed export does not fail the command or change the envelope on stdout, the exit code or the MCP stream. The exporter retries transient failures, then stops exporting for a while. The first failed connection to the collector logs one warning on stderr, and an error status from the collector logs none.

## Modules

The package is one module, `src/index.ts`, published as the import path `@memhtml/telemetry`, so this page is its whole exported surface.
