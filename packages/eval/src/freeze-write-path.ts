#!/usr/bin/env node
import { readFile } from "node:fs/promises"

import { Effect } from "effect"

import { describeWritePath } from "./write-path-metrics.js"
import {
  MANIFEST_URL,
  manifestFor,
  runWritePathDiscrimination,
  writeManifest
} from "./write-path-run.js"

/**
 * `pnpm freeze:write-path` re-runs the write-path discrimination arm and rewrites its frozen manifest.
 *
 * This is the ONE sanctioned way the manifest changes, and it is a human-initiated step for the same
 * reason `tools:bump` is: the manifest diff is the record of which decisions moved, and it needs a
 * reviewer. The eval tier never writes it; it replays against it and fails on drift, printing the
 * ids that moved and this command's name.
 *
 * Refuses to freeze a FAILING report. A manifest recording an F1 below the floor would make the
 * replay check pass on a gate the floor check fails, which is two gates disagreeing about one run.
 * Lower the floor deliberately (and say why, in `write-path-run.ts`) before freezing a lower baseline.
 *
 * One JSON object on stdout, like every other machine surface in this repo. Exit 0 wrote the
 * manifest; exit 1 refused.
 */
const main = Effect.gen(function* () {
  const report = yield* runWritePathDiscrimination()
  if (!report.passed) {
    process.stderr.write(`freeze refused: ${describeWritePath(report)}\n`)
    return 1
  }
  const workspace = JSON.parse(
    yield* Effect.promise(() => readFile(new URL("../../../package.json", import.meta.url), "utf8"))
  ) as { readonly version: string }
  const manifest = manifestFor(report, {
    memhtmlVersion: workspace.version,
    frozenAt: new Date().toISOString()
  })
  yield* writeManifest(manifest)
  process.stdout.write(
    `${JSON.stringify({
      wrote: MANIFEST_URL.pathname,
      items: report.items,
      precision: report.precision,
      recall: report.recall,
      f1: report.f1,
      f1Floor: report.f1Floor
    })}\n`
  )
  return 0
})

process.exitCode = await Effect.runPromise(main)
