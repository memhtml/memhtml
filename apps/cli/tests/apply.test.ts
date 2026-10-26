import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Git } from "@memhtml/cli"
import { blockTagInArticle, renderTemplate } from "@memhtml/html"
import { Effect } from "effect"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"

import { decodeApply, decodeSessionPut } from "../src/apply.js"
import { GUIDE, GUIDE_OP_EXAMPLE, GUIDE_TOPICS } from "../src/commands.js"
import { EXIT_OK, EXIT_USAGE } from "../src/envelope.js"
import { claimFromProse, markupInProse, proseTail } from "../src/prose.js"
import { run } from "../src/run.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * `memhtml apply`: the CLI door over `batchWrite`, through the real `run` and the real layer graph.
 *
 * The core primitive's own properties — one commit, one reindex, dedupe against the folded state,
 * per-op index space — are `batch.test.ts`'s subject. What this file tests is what the DOOR owns and
 * nothing else: JSONL shape validation before any op executes, the two input paths, the snake_case
 * envelope, and the exit code. A door test that re-asserted the fold's arithmetic would pass for
 * reasons that have nothing to do with the door.
 *
 * Every invocation goes through `run(argv, layer, stdin)` — the same function `bin.ts` calls — so the
 * exit codes and the exact bytes asserted here are the ones an agent parses.
 */

let clis: Array<Cli> = []
let dirs: Array<string> = []

afterEach(async () => {
  const openClis = clis
  const openDirs = dirs
  clis = []
  dirs = []
  await Promise.all(openClis.map((cli) => cli.cleanup()))
  await Promise.all(openDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A scaffolded repo plus `apply`, which drives `run` with an injectable stdin. */
const withApply = async () => {
  const cli = await makeCli()
  clis.push(cli)
  const dir = await mkdtemp(join(tmpdir(), "memhtml-apply-"))
  dirs.push(dir)

  /** `run` against this repo, with the JSONL supplied as stdin text rather than a pipe. */
  const piped = (argv: ReadonlyArray<string>, stdin: string) =>
    run([...argv, "--repo", cli.root], cli.layer, () => Promise.resolve(stdin))

  /** `run` against this repo with the JSONL written to a real file, read through `--file`. */
  const fromFile = async (lines: ReadonlyArray<string>, extra: ReadonlyArray<string> = []) => {
    const path = join(dir, "ops.jsonl")
    await writeFile(path, `${lines.join("\n")}\n`, "utf8")
    return await run(["apply", "--file", path, ...extra, "--repo", cli.root], cli.layer, () =>
      // A `--file` invocation must never touch stdin. Failing loudly here is what proves it: a
      // reader consulted on the file path would make a piped and a `--file` call the same code path.
      Promise.reject(new Error("stdin was read on a --file invocation"))
    )
  }

  return { root: cli.root, dir, piped, fromFile, layer: cli.layer }
}

const parse = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>

interface ApplyOp {
  readonly index: number
  readonly ok: boolean
  readonly path: string | null
  readonly deduped: boolean
  readonly existing_path: string | null
  readonly code: string | null
  readonly error: string | null
  readonly skipped: boolean
  readonly conflict: {
    readonly path: string | null
    readonly batch_index: number | null
    readonly claim: string
  } | null
  readonly near_duplicates: ReadonlyArray<{
    readonly path: string | null
    readonly batch_index: number | null
    readonly similarity: number
    readonly claim: string
  }> | null
}

interface Applied {
  readonly results: ReadonlyArray<ApplyOp>
  readonly summary: {
    readonly total: number
    readonly written: number
    readonly deduped: number
    readonly failed: number
    readonly skipped: number
  }
  readonly commit_sha: string | null
  readonly near_duplicates_degraded: boolean
}

const applied = (stdout: string): Applied => {
  const body = parse(stdout)
  expect(body.type, `expected batch.applied, got ${JSON.stringify(body)}`).toBe("batch.applied")
  return body.data as Applied
}

/** One JSONL line, as a caller writes it: snake_case, `op` first. */
const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ op: "write", type: "semantic", ...fields })

const THREE = [
  line({ title: "First applied fact", body: "The first thing happened." }),
  line({ title: "Second applied fact", body: "The second thing happened." }),
  line({ title: "Third applied fact", body: "The third thing happened." })
]

/** Every `.html` under the repo, excluding the scaffold's own `README.html`. */
const htmlOnDisk = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return (
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      // `readdir` yields the platform separator; the index and every assertion speak forward slashes.
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(root.length + 1)
          .replaceAll("\\", "/")
      )
      .filter((path) => path !== "README.html")
      .sort()
  )
}

const commitCount = Effect.gen(function* () {
  const git = yield* Git
  return Number((yield* git.run(["rev-list", "--count", "HEAD"])).trim())
})

describe("memhtml apply: the JSONL door", () => {
  it("writes three memories from --file in ONE commit and reports them in input order", async () => {
    const cli = await withApply()
    const before = await Effect.runPromise(Effect.provide(commitCount, cli.layer))

    const result = await cli.fromFile(THREE)
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)

    expect(data.results.map((op) => op.index)).toEqual([0, 1, 2])
    expect(data.summary).toEqual({
      total: 3,
      written: 3,
      deduped: 0,
      failed: 0,
      skipped: 0
    })
    expect(data.commit_sha).not.toBeNull()
    // The whole point of the door: three memories, ONE commit. Three `memhtml write` calls make three.
    expect(await Effect.runPromise(Effect.provide(commitCount, cli.layer))).toBe(before + 1)
    expect((await htmlOnDisk(cli.root)).length).toBe(3)
  })

  it("admits `type: arc` and places it under areas/arcs/, in the batch's one commit (issue #88)", async () => {
    /**
     * The curated-import case the operator surface exists for: an op stream carrying arcs earned
     * under a prior system flows through the same decode, dedup, placement, and one-commit contract
     * as every other type — the alternative was hand-writing HTML into the tree past all four.
     */
    const cli = await withApply()
    const result = await cli.fromFile([
      line({ title: "A durable behavioral rule", body: "Verify before asserting, always." }),
      line({
        type: "arc",
        title: "Imported arc on verification",
        body: "Run the cheap direct check before stating a conclusion as fact."
      })
    ])
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)
    expect(data.summary.written).toBe(2)
    expect(data.commit_sha).not.toBeNull()
    const paths = await htmlOnDisk(cli.root)
    expect(paths.some((path) => path.startsWith("areas/arcs/imported-arc"))).toBe(true)
  })

  /**
   * Three spawned CLI runs in one case. Under `mise run check`, with every package's suite in
   * parallel, this took 5.1–5.4 s and tripped vitest's 5 s default three times in six gate runs on
   * 2026-09-02, and passed every time alone. The bound is the case's own, so a slow box fails on a
   * hang and not on load.
   */
  it("reads the same stream from stdin, via `apply -`, `apply --file -`, and a bare `apply`", async () => {
    // All three spellings, because the flag docs promise all three. A dash that fell through to
    // `--file` parsing would try to open a file named `-`.
    for (const argv of [["apply", "-"], ["apply", "--file", "-"], ["apply"]]) {
      const cli = await withApply()
      const result = await cli.piped(argv, `${THREE.join("\n")}\n`)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      const data = applied(result.stdout)
      expect(data.summary.written, argv.join(" ")).toBe(3)
      expect(data.commit_sha, argv.join(" ")).not.toBeNull()
    }
  }, 30_000)

  it("refuses a positional `-` beside a real --file, as exit 2 before any op runs", async () => {
    /**
     * Two streams claiming to be the one that applies. The refusal must be a usage error (exit 2,
     * decided in `validate`) rather than one source silently winning: a caller who piped ops AND
     * named a file cannot be given a commit built from only one of them.
     */
    const result = await run(["apply", "-", "--file", "ops.jsonl"], undefined, () =>
      Promise.reject(new Error("stdin was read on a refused invocation"))
    )
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect((parse(result.stdout) as { code: string }).code).toBe("ERR_INVALID_FLAG")
  })

  it("emits snake_case with absent fields as null, never as a missing key", async () => {
    /**
     * The payload contract. `commit_sha` is spec D6's own spelling, and it diverges from
     * `memory.written`'s `commitSha` deliberately so this payload is byte-comparable with
     * `memory_write_batch`'s over MCP. An agent branching on `deduped === true` must not also have to
     * handle the key being absent, so the booleans are always present and the rest are null.
     */
    const cli = await withApply()
    const data = applied((await cli.fromFile([THREE[0] as string])).stdout)
    const [op] = data.results
    expect(Object.keys(op as object).sort()).toEqual([
      "code",
      "conflict",
      "deduped",
      "error",
      "existing_path",
      "index",
      "near_duplicates",
      "ok",
      "path",
      "skipped"
    ])
    expect(op?.code).toBeNull()
    expect(op?.error).toBeNull()
    expect(op?.existing_path).toBeNull()
    expect(op?.deduped).toBe(false)
    expect(op?.skipped).toBe(false)
    /**
     * `conflict` is present-and-null on a run that did NOT pass `--detect-conflicts`, which is the same
     * rule the other nullable fields follow and it matters more here than for any of them: a client
     * reading an absent key cannot tell "this op contradicts nothing" from "this build does not check",
     * and those two lead to opposite decisions about whether to go looking.
     */
    expect(op?.conflict).toBeNull()
  })

  it("carries provenance from the flags, and lets a LINE's own session win", async () => {
    const cli = await withApply()
    const result = await cli.fromFile(
      [
        line({ title: "Batch attributed", body: "From the flag." }),
        line({
          title: "Line attributed",
          body: "From the line.",
          session_id: "dddddddd-4444-4444-8444-dddddddddddd"
        })
      ],
      ["--session-id", "cccccccc-3333-4333-8333-cccccccccccc"]
    )
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)

    const { readMemory } = await import("../src/operations.js")
    const sessions = await Effect.runPromise(
      Effect.provide(
        Effect.forEach(data.results, (op) =>
          readMemory(op.path ?? "").pipe(Effect.map((read) => read.doc.metas.sessionId))
        ),
        cli.layer
      )
    )
    expect(sessions).toEqual([
      "cccccccc-3333-4333-8333-cccccccccccc",
      "dddddddd-4444-4444-8444-dddddddddddd"
    ])
  })

  it("reports a per-op refusal WITHOUT re-mapping it, under --continue-on-error", async () => {
    /**
     * `ERR_INVALID_MEMORY` and the violation text arrive already mapped through `codeFor`/`messageFor`
     * inside `batchWrite` — the door passes them through. A door that re-mapped them would be a second
     * mapping that agrees with `memory_write_batch` today and drifts later.
     */
    const cli = await withApply()
    const result = await cli.fromFile(
      [
        line({ title: "No mark at all", article_html: "<p>Prose with no claim span.</p>" }),
        line({ title: "Perfectly fine", body: "This one is fine." })
      ],
      ["--continue-on-error"]
    )
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)
    expect(data.results[0]?.code).toBe("ERR_INVALID_MEMORY")
    expect(data.results[0]?.error).toContain("no <mark>")
    expect(data.results[1]?.ok).toBe(true)
    expect(data.summary).toEqual({
      total: 2,
      written: 1,
      deduped: 0,
      failed: 1,
      skipped: 0
    })
  })

  it("aborts atomically by default, reporting the survivor as skipped and writing nothing", async () => {
    const cli = await withApply()
    const result = await cli.fromFile([
      line({ title: "Would have been fine", body: "Never written." }),
      line({ title: "No mark at all", article_html: "<p>No claim span.</p>" })
    ])
    // Exit 0: the CALL succeeded and its report is the answer. A refused op is data, not a crash.
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)
    expect(data.summary).toEqual({
      total: 2,
      written: 0,
      deduped: 0,
      failed: 1,
      skipped: 1
    })
    expect(data.commit_sha).toBeNull()
    expect(await htmlOnDisk(cli.root)).toEqual([])
  })

  it("returns a duplicate as ok+deduped with the existing path, never as an error", async () => {
    const cli = await withApply()
    await cli.fromFile([line({ title: "The original", body: "One remembered fact." })])
    const again = await cli.fromFile([
      line({ title: "A different title", body: "One remembered fact." })
    ])
    const data = applied(again.stdout)
    expect(data.results[0]?.ok).toBe(true)
    expect(data.results[0]?.deduped).toBe(true)
    expect(data.results[0]?.existing_path).toBe("areas/inbox/the-original.html")
    expect(data.commit_sha).toBeNull()
  })
})

/**
 * `memhtml apply --detect-conflicts` (AC-1-2) through the REAL binary: argv parsing, the flag reaching
 * `batchWrite`, and the envelope carrying the nested `conflict` object.
 *
 * The flag is threaded through `run.ts`'s `bool(parsed, …)`, so a FlagSpec added to the manifest without
 * the wiring — or wired to the wrong name — publishes a documented flag that silently does nothing.
 * These tests are the pair that cannot both pass in that state.
 */
describe("memhtml apply --detect-conflicts (AC-1-2)", () => {
  const CEILING_64 = "The pool ceiling is 64."
  const CEILING_128 = "The pool ceiling is 128."

  it("names the ACTIVE memory a line contradicts, and writes the line anyway", async () => {
    const cli = await withApply()
    const first = await cli.fromFile([line({ title: "Ceiling now", body: CEILING_64 })])
    const storedPath = applied(first.stdout).results[0]?.path

    const second = await cli.fromFile(
      [line({ title: "Ceiling later", body: CEILING_128 })],
      ["--detect-conflicts"]
    )
    expect(second.exitCode).toBe(EXIT_OK)
    const data = applied(second.stdout)

    // The nested object, in snake_case, byte-comparable with `memory_write_batch`'s.
    expect(data.results[0]?.conflict?.path).toBe(storedPath)
    expect(data.results[0]?.conflict?.claim).toBe(CEILING_64)
    expect(data.results[0]?.conflict?.batch_index).toBeNull()

    /**
     * PROPOSE-ONLY at the CLI, and exit 0. A conflict is not a usage error and not a runtime one — the
     * call did exactly what it was asked. An implementation that made it exit 1 or 2 would break every
     * script that treats a non-zero exit as "the write did not happen", when it did.
     */
    expect(data.results[0]?.ok).toBe(true)
    expect(data.summary).toEqual({
      total: 1,
      written: 1,
      deduped: 0,
      failed: 0,
      skipped: 0
    })
    expect(data.commit_sha).not.toBeNull()
    expect((await htmlOnDisk(cli.root)).length).toBe(2)
  })

  it("names an EARLIER line for a conflict inside one file, and writes both", async () => {
    const cli = await withApply()
    const result = await cli.fromFile(
      [
        line({ title: "Ceiling first", body: CEILING_64 }),
        line({ title: "Ceiling second", body: CEILING_128 })
      ],
      ["--detect-conflicts"]
    )
    const data = applied(result.stdout)
    expect(data.results[0]?.conflict).toBeNull()
    expect(data.results[1]?.conflict?.batch_index).toBe(0)
    expect(data.results[1]?.conflict?.claim).toBe(CEILING_64)
    expect(data.results[1]?.conflict?.path).toBeNull()
    expect(data.summary.written).toBe(2)
    expect((await htmlOnDisk(cli.root)).length).toBe(2)
  })

  it("reports null without the flag, on the SAME file that conflicts with it", async () => {
    /**
     * The flag-off lock, over a file that WOULD light up. Run over non-conflicting lines it would also
     * pass against a build whose default was on, which is the whole failure it is meant to catch.
     */
    const cli = await withApply()
    const result = await cli.fromFile([
      line({ title: "Ceiling first", body: CEILING_64 }),
      line({ title: "Ceiling second", body: CEILING_128 })
    ])
    const data = applied(result.stdout)
    expect(data.results.every((op) => op.conflict === null)).toBe(true)
    expect(data.summary.written).toBe(2)
  })

  it("survives --dense, which strips nulls and must not eat a real conflict", async () => {
    /**
     * `--dense` drops null fields for the context-window case, so it drops `conflict` on every op that
     * has none — correct, and the reason the flag exists. What must NOT happen is a populated conflict
     * being dropped along with them, or its own inner `path: null` being stripped in a way that leaves a
     * caller unable to tell an intra-batch match from a malformed one.
     */
    const cli = await withApply()
    const result = await cli.fromFile(
      [
        line({ title: "Dense first", body: "The cache ttl is 300 seconds." }),
        line({ title: "Dense second", body: "The cache ttl is 900 seconds." })
      ],
      ["--detect-conflicts", "--dense"]
    )
    const data = applied(result.stdout)
    // Op 0 has no conflict, so `--dense` removed the key entirely.
    expect(data.results[0]).not.toHaveProperty("conflict")
    // Op 1's survived, and `batch_index: 0` is a number rather than a null so it survives too.
    expect(data.results[1]?.conflict?.batch_index).toBe(0)
    expect(data.results[1]?.conflict?.claim).toBe("The cache ttl is 300 seconds.")
    expect(data.summary.written).toBe(2)
  })
})

/**
 * `memhtml apply --detect-near-duplicates` through the REAL binary, for the same reason the
 * `--detect-conflicts` suite exists: a FlagSpec added to the manifest without the `run.ts` wiring —
 * or wired to the wrong name — publishes a documented flag that silently does nothing, and the
 * flag-on/flag-off pair below cannot both pass in that state. The assist's own semantics (thresholds,
 * intra-batch fold, degradation channels) are `batch.test.ts`'s subject; this suite owns the door:
 * argv, the snake_case envelope, and `--dense`.
 */
describe("memhtml apply --detect-near-duplicates", () => {
  const RUNBOOK =
    "The deploy runbook owner is Paula Reyes and the runbook lives in the operations wiki."
  const RUNBOOK_REWORDED =
    "Paula Reyes is the deploy runbook owner and the runbook lives in the operations wiki."

  it("names the ACTIVE memory a line nearly restates, in snake_case, and writes the line anyway", async () => {
    const cli = await withApply()
    const first = await cli.fromFile([line({ title: "Runbook owner", body: RUNBOOK })])
    const storedPath = applied(first.stdout).results[0]?.path

    const second = await cli.fromFile(
      [line({ title: "Runbook owner restated", body: RUNBOOK_REWORDED })],
      ["--detect-near-duplicates"]
    )
    expect(second.exitCode).toBe(EXIT_OK)
    const data = applied(second.stdout)

    // The nested list, in snake_case, byte-comparable with `memory_write_batch`'s.
    const hits = data.results[0]?.near_duplicates
    expect(hits).toHaveLength(1)
    expect(hits?.[0]?.path).toBe(storedPath)
    expect(hits?.[0]?.claim).toBe(RUNBOOK)
    expect(hits?.[0]?.batch_index).toBeNull()
    expect(hits?.[0]?.similarity).toBeGreaterThanOrEqual(0.92)
    expect(data.near_duplicates_degraded).toBe(false)

    // PROPOSE-ONLY at the CLI, exit 0, and both memories on disk.
    expect(data.results[0]?.ok).toBe(true)
    expect(data.summary.written).toBe(1)
    expect((await htmlOnDisk(cli.root)).length).toBe(2)
  })

  it("reports null without the flag, on the SAME pair that would light up", async () => {
    // The flag-off lock, over lines that WOULD match — run over unrelated lines it would also pass
    // against a build whose default was on.
    const cli = await withApply()
    await cli.fromFile([line({ title: "Runbook owner", body: RUNBOOK })])
    const second = await cli.fromFile([
      line({ title: "Runbook owner restated", body: RUNBOOK_REWORDED })
    ])
    const data = applied(second.stdout)
    // Present-and-null, the same rule every nullable field follows: a client reading an absent key
    // cannot tell "nothing matched" from "this build does not check".
    expect(data.results[0]).toHaveProperty("near_duplicates")
    expect(data.results[0]?.near_duplicates).toBeNull()
    expect(data.near_duplicates_degraded).toBe(false)
  })

  it("survives --dense, which strips nulls and must not eat a real finding", async () => {
    const cli = await withApply()
    const result = await cli.fromFile(
      [
        line({ title: "Runbook owner", body: RUNBOOK }),
        line({ title: "Runbook owner restated", body: RUNBOOK_REWORDED })
      ],
      ["--detect-near-duplicates", "--dense"]
    )
    const data = applied(result.stdout)
    // Line 0 has no finding, so `--dense` removed the key entirely.
    expect(data.results[0]).not.toHaveProperty("near_duplicates")
    // Line 1's survived, with the intra-batch `batch_index: 0` intact under the null-stripping.
    expect(data.results[1]?.near_duplicates?.[0]?.batch_index).toBe(0)
    expect(data.results[1]?.near_duplicates?.[0]?.claim).toBe(RUNBOOK)
    expect(data.summary.written).toBe(2)
  })
})

describe("shape validation happens before ANY op executes (AC-6-4)", () => {
  it("refuses a malformed line 2 of 3 with exit 2, naming line 2, leaving the repo untouched", async () => {
    /**
     * The ordering IS the contract. An apply that wrote line 1 and then refused line 2 would leave a
     * commit behind for a call that reported failure, and the caller's only recovery would be working
     * out which prefix landed. Exit 2 and not 1, because the caller wrote a bad file — the corpus is
     * fine, and a shell caller branching on the code must not see it as a runtime fault.
     */
    const cli = await withApply()
    const before = await Effect.runPromise(Effect.provide(commitCount, cli.layer))

    const result = await cli.fromFile([
      THREE[0] as string,
      '{"op":"write","title":"Broken",',
      THREE[2] as string
    ])

    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain("line 2")
    expect(body.error).toContain("not valid JSON")
    // Nothing written, nothing committed — and line 1 was perfectly valid.
    expect(await htmlOnDisk(cli.root)).toEqual([])
    expect(await Effect.runPromise(Effect.provide(commitCount, cli.layer))).toBe(before)
  })

  it("counts BLANK lines when numbering, so line 4 means the fourth line of the file", async () => {
    // An error naming line 4 has to mean the line a caller sees at line 4 in an editor. Skipping
    // blanks in the count would report line 3 for a file whose third line is empty.
    const cli = await withApply()
    const result = await cli.fromFile([THREE[0] as string, "", "", "{not json}"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(parse(result.stdout).error).toContain("line 4")
  })

  it("refuses an unknown op value naming the vocabulary", async () => {
    const cli = await withApply()
    const result = await cli.fromFile([
      JSON.stringify({ op: "correct", title: "Not yet", type: "semantic", body: "x." })
    ])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain("`op` must be one of: write")
    expect(body.error).toContain("line 1")
  })

  it("refuses a missing or blank required field, naming it", async () => {
    const cli = await withApply()
    for (const [fields, code] of [
      [{ op: "write", type: "semantic", body: "x." }, "ERR_MISSING_ARGUMENT"],
      [{ op: "write", title: "No type", body: "x." }, "ERR_MISSING_ARGUMENT"],
      [{ op: "write", title: "   ", type: "semantic", body: "x." }, "ERR_INVALID_FLAG"],
      [{ title: "No op", type: "semantic", body: "x." }, "ERR_MISSING_ARGUMENT"]
    ] as ReadonlyArray<readonly [Record<string, unknown>, string]>) {
      const result = await cli.fromFile([JSON.stringify(fields)])
      const label = JSON.stringify(fields)
      expect(result.exitCode, label).toBe(EXIT_USAGE)
      expect(parse(result.stdout).code, label).toBe(code)
    }
  })

  it("refuses an unknown FIELD rather than silently dropping it", async () => {
    // A misspelled `sesion_id` that applied anyway would write a memory with no provenance at all,
    // and the caller would have no way to notice — the same reason `validate` refuses an unknown flag.
    const cli = await withApply()
    const result = await cli.fromFile([
      line({ title: "Typo in a field", body: "x.", sesion_id: "abc" })
    ])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain("unknown field `sesion_id`")
    // And it lists the legal ones, so the caller fixes it without a second round trip.
    expect(body.error).toContain("session_id")
  })

  it("refuses an empty stream rather than exiting 0 having written nothing", async () => {
    // A broken pipe produces no bytes. An apply that reported success for it would make an upstream
    // failure invisible — the caller sees exit 0 and assumes its memories landed.
    const cli = await withApply()
    for (const text of ["", "\n\n  \n"]) {
      const result = await cli.piped(["apply", "-"], text)
      expect(result.exitCode).toBe(EXIT_USAGE)
      const body = parse(result.stdout)
      expect(body.code).toBe("ERR_MISSING_ARGUMENT")
      expect(body.error).toContain("no ops")
    }
  })

  it("refuses an unreadable --file with the path in the message", async () => {
    const cli = await withApply()
    const result = await run(
      ["apply", "--file", join(cli.dir, "absent.jsonl"), "--repo", cli.root],
      cli.layer,
      () => Promise.resolve("")
    )
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_PATH_NOT_FOUND")
    expect(body.error).toContain("absent.jsonl")
  })

  it("refuses a JSON array or scalar on a line, since JSONL is one object per line", async () => {
    const cli = await withApply()
    for (const raw of ["[]", '"a string"', "42", "null"]) {
      const result = await cli.fromFile([raw])
      expect(result.exitCode, raw).toBe(EXIT_USAGE)
      expect(parse(result.stdout).error, raw).toContain("not a JSON object")
    }
  })
})

describe("the line decoder, as a pure function", () => {
  it("maps snake_case onto WriteParams camelCase", async () => {
    const decoded = decodeApply(
      `${line({
        title: "Everything at once",
        type: "episodic",
        body: "The claim sentence. A tail paragraph.",
        path: "areas/inbox/pinned.html",
        workspace: "checkout",
        tag: ["infra", "oncall"],
        entity: "service:checkout-api",
        importance: 7,
        confidence: 0.9,
        session_id: "s",
        prompt_id: "p",
        turn_uuid: "t"
      })}\n`
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.ops[0]).toEqual({
      title: "Everything at once",
      memoryType: "episodic",
      claim: "The claim sentence.",
      body: ["A tail paragraph."],
      path: "areas/inbox/pinned.html",
      workspace: "checkout",
      tags: ["infra", "oncall"],
      entities: ["service:checkout-api"],
      importance: 7,
      confidence: 0.9,
      sessionId: "s",
      promptId: "p",
      turnUuid: "t"
    })
  })

  it("accepts a bare string for a list field, as the repeatable flags do", () => {
    const decoded = decodeApply(line({ title: "One tag", body: "x.", tag: "infra" }))
    expect(decoded.ok && decoded.ops[0]?.tags).toEqual(["infra"])
  })

  it("leaves claim empty and body absent on the article_html path", () => {
    // The markup is the whole article: a claim derived from prose that does not exist would be a
    // second, invisible authoring decision, and the `<mark>` inside the markup IS the claim.
    const decoded = decodeApply(
      line({ title: "Markup", article_html: "<p><mark>The claim.</mark></p>" })
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.ops[0]?.claim).toBe("")
    expect(decoded.ops[0]?.body).toBeUndefined()
    expect(decoded.ops[0]?.articleHtml).toBe("<p><mark>The claim.</mark></p>")
  })

  it("carries `strict_path` as a JSON boolean, and refuses the string spelling", () => {
    /**
     * A boolean field on a wire whose every other scalar is a string, so the two are decoded by
     * separate tables. `"true"` is the spelling a template-driven writer produces, and accepting it
     * as a string would hand `strictPath: "true"` down — truthy in JavaScript, absent to a `=== true`
     * guard. The caller's ask would read as satisfied and behave as if it had never been made.
     */
    const decoded = decodeApply(line({ title: "Strict", body: "x.", strict_path: true }))
    expect(decoded.ok && decoded.ops[0]?.strictPath).toBe(true)

    const asString = decodeApply(line({ title: "Strict", body: "x.", strict_path: "true" }))
    expect(asString.ok).toBe(false)
    if (asString.ok) return
    expect(asString.failure.code).toBe("ERR_INVALID_FLAG")
    expect(asString.failure.error).toContain("strict_path")

    // Absent means absent, not false: the key must not appear at all, so `exactOptionalPropertyTypes`
    // callers downstream see the same shape they do for every other unstated field.
    const absent = decodeApply(line({ title: "Lenient", body: "x." }))
    expect(absent.ok && Object.hasOwn(absent.ops[0] ?? {}, "strictPath")).toBe(false)
  })

  it("does NOT enforce the body/article_html XOR at the door: that is per-op, one layer down", () => {
    // The door owns SHAPE. A file where op 3 supplies both must still report per-op rather than
    // refusing the whole file, so the XOR stays the store's render gate's business.
    const both = decodeApply(
      line({ title: "Both", body: "Prose.", article_html: "<p><mark>M.</mark></p>" })
    )
    expect(both.ok).toBe(true)
    const neither = decodeApply(line({ title: "Neither" }))
    expect(neither.ok).toBe(true)
  })
})

/**
 * `memhtml session put` reads apply's write lines plus `label` and `unlabel` lines.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `labelAt`: drop the unknown-field loop -> "refuses a label line with a missing, empty, or extra
 *   field, naming the line and the door" (the extra field decodes).
 * - `labelAt`: drop the `requiredString(record, "entity", at)` check -> the same case (a label with
 *   no entity decodes).
 * - `decodeSessionPut`: route every non-write op through `labelAt` with no vocabulary check -> "names
 *   the three ops on an unknown one" (a `link` line decodes as an entity edit).
 */
describe("the session put decoder, as a pure function", () => {
  const labelLine = (fields: Record<string, unknown>): string => `${JSON.stringify(fields)}\n`

  it("decodes write, label, and unlabel lines in file order, writes exactly as apply does", () => {
    const write = `${line({ title: "A fact", body: "The thing that happened.", entity: "system:x" })}\n`
    const decoded = decodeSessionPut(
      `${write}${labelLine({ op: "label", path: "areas/inbox/a.html", entity: "system:memhtml" })}\n${labelLine({ op: "unlabel", path: "areas/inbox/a.html", entity: "system:x" })}`
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const applied = decodeApply(write)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(decoded.ops).toEqual([
      { op: "write", params: applied.ops[0] },
      { op: "label", path: "areas/inbox/a.html", entity: "system:memhtml" },
      { op: "unlabel", path: "areas/inbox/a.html", entity: "system:x" }
    ])
  })

  it("leaves apply writes-only: a label line is refused there", () => {
    const refused = decodeApply(
      labelLine({ op: "label", path: "areas/inbox/a.html", entity: "system:memhtml" })
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.failure.code).toBe("ERR_INVALID_FLAG")
    expect(refused.failure.error).toContain("memhtml apply: line 1")
  })

  it("refuses a label line with a missing, empty, or extra field, naming the line and the door", () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string, string]> = [
      [{ op: "label", path: "areas/inbox/a.html" }, "ERR_MISSING_ARGUMENT", "`entity`"],
      [{ op: "unlabel", entity: "system:x" }, "ERR_MISSING_ARGUMENT", "`path`"],
      [{ op: "label", path: "areas/inbox/a.html", entity: " " }, "ERR_INVALID_FLAG", "`entity`"],
      [{ op: "label", path: 7, entity: "system:x" }, "ERR_INVALID_FLAG", "`path`"],
      [
        { op: "label", path: "areas/inbox/a.html", entity: "system:x", title: "t" },
        "ERR_INVALID_FLAG",
        "unknown field `title` on a label line"
      ]
    ]
    for (const [fields, code, mention] of cases) {
      const decoded = decodeSessionPut(
        `${line({ title: "ok", body: "Fine." })}\n${labelLine(fields)}`
      )
      expect(decoded.ok, JSON.stringify(fields)).toBe(false)
      if (decoded.ok) continue
      expect(decoded.failure.code, JSON.stringify(fields)).toBe(code)
      expect(decoded.failure.error).toContain("memhtml session put: line 2")
      expect(decoded.failure.error).toContain(mention)
    }
  })

  it("names the three ops on an unknown one, and refuses a stream with none", () => {
    const unknown = decodeSessionPut(
      labelLine({ op: "link", path: "areas/inbox/a.html", entity: "x:y" })
    )
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.failure.code).toBe("ERR_INVALID_FLAG")
    expect(unknown.failure.error).toContain("write, label, unlabel")
    const missing = decodeSessionPut(labelLine({ path: "areas/inbox/a.html", entity: "x:y" }))
    expect(missing.ok || missing.failure.code).toBe("ERR_MISSING_ARGUMENT")
    const empty = decodeSessionPut("\n\n")
    expect(empty.ok || empty.failure.code).toBe("ERR_MISSING_ARGUMENT")
    // A malformed write line is refused under this door's name, by apply's own decoder.
    const badWrite = decodeSessionPut(`${labelLine({ op: "write", type: "semantic" })}`)
    expect(badWrite.ok || badWrite.failure.error).toContain("memhtml session put: line 1")
  })
})

/**
 * A prose `body` holding an HTML block tag, raw or escaped, is refused at both JSONL doors.
 *
 * The prose path escapes its text, so `<p>One.</p>` sent as `body` would land as the literal
 * characters `&lt;p&gt;One.` inside the claim's `<mark>`, a file the render gate accepts because
 * escaped text is valid content. The door is the one place that still knows the caller meant
 * markup, so it refuses there and names `article_html`. Code is exempt: a tag in backticks or a
 * fence is a record discussing markup, and it writes.
 */
describe("a prose body holding HTML block markup", () => {
  const MARKUP_LINE = JSON.stringify({
    op: "write",
    title: "T",
    type: "semantic",
    body: "<p>One.</p><p>Two.</p>"
  })

  it("is refused by session put with ERR_INVALID_FLAG, naming the tag and article_html", () => {
    const decoded = decodeSessionPut(`${MARKUP_LINE}\n`)
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.failure.code).toBe("ERR_INVALID_FLAG")
    expect(decoded.failure.error).toContain("memhtml session put: line 1")
    expect(decoded.failure.error).toContain("`<p>`")
    expect(decoded.failure.error).toContain("article_html")
    expect(decoded.failure.suggestions.some((entry) => entry.includes('"article_html"'))).toBe(true)
  })

  it("is refused by apply under its own name, naming the body line the tag is on", () => {
    const decoded = decodeApply(
      [
        line({ title: "Fine", body: "A plain fact." }),
        line({ title: "Escaped", body: "A claim.\n\nThen &lt;ul&gt; on the body's third line." })
      ].join("\n")
    )
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.failure.code).toBe("ERR_INVALID_FLAG")
    expect(decoded.failure.error).toContain("memhtml apply: line 2")
    expect(decoded.failure.error).toContain("`&lt;ul&gt;` on its line 3")
    expect(decoded.failure.error).toContain("article_html")
  })

  it("decodes a body that discusses a tag in backticks or a fence, and one with inline markup", () => {
    const backticks = decodeApply(
      line({ title: "Tags", body: "The `<p>` element holds one paragraph." })
    )
    expect(backticks.ok && backticks.ops[0]?.claim).toBe("The `<p>` element holds one paragraph.")
    const fenced = decodeApply(
      line({
        title: "Fenced",
        body: "A list in markup.\n\n```html\n<ul>\n  <li>x</li>\n</ul>\n```"
      })
    )
    expect(fenced.ok).toBe(true)
    // An inline element is not a block tag: it is escaped as text, the prose path's contract.
    const inline = decodeApply(
      line({ title: "Inline", body: 'Recorded on <time datetime="2031-01-01">new year</time>.' })
    )
    expect(inline.ok).toBe(true)
    // The markup path is the remedy the refusal names, and it is untouched.
    const markup = decodeApply(
      line({ title: "Markup", article_html: "<p><mark>One.</mark></p><p>Two.</p>" })
    )
    expect(markup.ok).toBe(true)
    // A line naming both fields is left to the per-op XOR refusal one layer down.
    const both = decodeApply(
      line({ title: "Both", body: "<p>One.</p>", article_html: "<p><mark>One.</mark></p>" })
    )
    expect(both.ok).toBe(true)
  })

  it("leaves the repo untouched when apply refuses, and writes the backticked record as text", async () => {
    const cli = await withApply()
    const before = await Effect.runPromise(Effect.provide(commitCount, cli.layer))
    const refused = await cli.fromFile([THREE[0] as string, MARKUP_LINE])
    expect(refused.exitCode).toBe(EXIT_USAGE)
    expect(parse(refused.stdout).code).toBe("ERR_INVALID_FLAG")
    expect(await htmlOnDisk(cli.root)).toEqual([])
    expect(await Effect.runPromise(Effect.provide(commitCount, cli.layer))).toBe(before)

    const written = applied(
      (
        await cli.fromFile([
          line({ title: "Paragraph element", body: "The `<p>` element holds one paragraph." })
        ])
      ).stdout
    )
    const path = written.results[0]?.path ?? ""
    expect(await readFile(join(cli.root, path), "utf8")).toContain(
      "<mark>The `&lt;p&gt;` element holds one paragraph.</mark>"
    )
  })

  it("passes the backticked record through session put and its commit, so the two checks agree", async () => {
    /**
     * `session put` runs the door's check on the line and then `validateOps` on the file the
     * template renders from it. A record the door lets through must not be refused at the commit,
     * so the same backticked body is driven through both.
     */
    const cli = await withApply()
    const session = (argv: ReadonlyArray<string>, input = "") =>
      run([...argv, "--repo", cli.root], undefined, () => Promise.resolve(input), false)
    expect((await session(["session", "start", "--id", "tags"])).exitCode).toBe(EXIT_OK)
    const put = await session(
      ["session", "put", "--id", "tags", "--file", "-", "--no-server"],
      `${line({ title: "Paragraph element", body: "The `<p>` element holds one paragraph." })}\n`
    )
    expect(put.exitCode, put.stdout).toBe(EXIT_OK)
    expect(parse(put.stdout).data).toMatchObject({ appended: 1, violations: [] })
    const committed = await session(["session", "commit", "--id", "tags", "--message", "m"])
    expect(parse(committed.stdout).data).toMatchObject({ kind: "committed" })
  })

  /** The fenced list below, in the claim's paragraph because no blank line sets it off. */
  const FENCE_IN_PARAGRAPH =
    "The list markup is below.\n```html\n<ul>\n  <li>x</li>\n</ul>\n```\nIt renders one item."

  it("judges the body as it renders: the claim's line joins the next, and a fence is code alone", () => {
    /**
     * The template builds the first `<p>` as the claim, a space, and the first body paragraph, and
     * renders a fence as code only when it is a paragraph of its own. Each body below reads one way
     * line by line and the other way rendered, and the door gives the rendered reading, the one
     * `validateOps` gives the file.
     */
    expect(markupInProse(FENCE_IN_PARAGRAPH)).toMatchObject({ line: 3, tag: "<ul>" })
    // The claim's backtick and the next line's first one pair up once the lines join.
    expect(markupInProse("Run `make.\n`<p>` is the paragraph element.")).toMatchObject({
      line: 2,
      tag: "<p>"
    })
    expect(markupInProse("Run `make.\n<p>` is the paragraph element.")).toBeUndefined()
    // Set off by blank lines, the same fence is a paragraph of its own and renders as code.
    expect(
      markupInProse(
        "The list markup is below.\n\n```html\n<ul>\n  <li>x</li>\n</ul>\n```\n\nIt renders one item."
      )
    ).toBeUndefined()
    // A line names the body's own line in any of the three line-break spellings.
    expect(markupInProse("A claim.\r\nNext.\r\n\r\nThen <ul> here.")).toMatchObject({ line: 4 })
    expect(markupInProse("  A claim.\rThen <ul> here.")).toMatchObject({ line: 2 })
  })

  it("refuses a fence in the claim's paragraph at both doors, and passes what renders as code", async () => {
    const cli = await withApply()
    const refused = await cli.fromFile([line({ title: "List markup", body: FENCE_IN_PARAGRAPH })])
    expect(refused.exitCode).toBe(EXIT_USAGE)
    expect(parse(refused.stdout).code).toBe("ERR_INVALID_FLAG")
    expect(parse(refused.stdout).error).toContain("`<ul>` on its line 3")
    expect(await htmlOnDisk(cli.root)).toEqual([])

    const session = (argv: ReadonlyArray<string>, input = "") =>
      run([...argv, "--repo", cli.root], undefined, () => Promise.resolve(input), false)
    expect((await session(["session", "start", "--id", "fences"])).exitCode).toBe(EXIT_OK)
    const put = (body: string) =>
      session(
        ["session", "put", "--id", "fences", "--file", "-", "--no-server"],
        `${line({ title: "Make", body })}\n`
      )
    const fenced = await put(FENCE_IN_PARAGRAPH)
    expect(fenced.exitCode).toBe(EXIT_USAGE)
    expect(parse(fenced.stdout).code).toBe("ERR_INVALID_FLAG")
    const spanned = await put("Run `make.\n<p>` is the paragraph element.")
    expect(spanned.exitCode, spanned.stdout).toBe(EXIT_OK)
    expect(parse(spanned.stdout).data).toMatchObject({ appended: 1, violations: [] })
    const committed = await session(["session", "commit", "--id", "fences", "--message", "m"])
    expect(parse(committed.stdout).data).toMatchObject({ kind: "committed" })
  })

  it("quotes the tag as written, cut to 80 characters", () => {
    const quoted = decodeApply(line({ title: "T", body: "A <p data-x=`v`> tag." }))
    expect(quoted.ok).toBe(false)
    if (quoted.ok) return
    expect(quoted.failure.error).toContain("`<p data-x=`v`>` on its line 1")
    const long = decodeApply(line({ title: "T", body: `A <p ${"a".repeat(1_000_000)}> tag.` }))
    expect(long.ok).toBe(false)
    if (long.ok) return
    expect(long.failure.error).toContain(`\`<p ${"a".repeat(74)}...\` on its line 1`)
    expect(long.failure.error.length).toBeLessThan(1000)
  })

  it("decodes a body naming a component, a generic, or a comparison that looks like a tag", () => {
    for (const body of [
      "A <Table> component renders the rows.",
      "Typed as React.FC<P>, it returns List<Article>.",
      "So x<p and q>0 holds for every row."
    ]) {
      expect(decodeApply(line({ title: "T", body })).ok, body).toBe(true)
    }
  })

  it("reads a 10M-character body line without running out of stack", async () => {
    const size = 10_000_000
    expect(decodeApply(line({ title: "T", body: `&lt;p ${"a".repeat(size)}` })).ok).toBe(true)
    const cli = await withApply()
    const refused = await cli.fromFile([
      line({ title: "T", body: `A claim. &lt;p ${"a".repeat(size)}&gt; ends it.` })
    ])
    expect(refused.exitCode).toBe(EXIT_USAGE)
    expect(parse(refused.stdout).code).toBe("ERR_INVALID_FLAG")
    expect(parse(refused.stdout).error).toContain(`\`&lt;p ${"a".repeat(71)}...\` on its line 1`)
    expect(refused.stdout.length).toBeLessThan(5000)
  }, 120_000)

  it("writes article_html whose <p> holds an escaped block tag at apply, and session put refuses it", async () => {
    /**
     * `article_html` on an `apply` line is verbatim markup: a caller may escape quoted text into a
     * `<p>` on purpose, so apply writes it. A `session put` line's file is judged by `validateOps`,
     * which holds a session's puts to the block-tag rule.
     */
    const cli = await withApply()
    const asText =
      "<p><mark>The reply opened with &lt;h1&gt;Manage API Access&lt;/h1&gt;.</mark></p>"
    const result = await cli.fromFile([line({ title: "Quoted heading", article_html: asText })])
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)
    expect(data.summary.written).toBe(1)
    expect(await readFile(join(cli.root, data.results[0]?.path ?? ""), "utf8")).toContain(
      "&lt;h1&gt;Manage API Access&lt;/h1&gt;"
    )

    const session = (argv: ReadonlyArray<string>, input = "") =>
      run([...argv, "--repo", cli.root], undefined, () => Promise.resolve(input), false)
    expect((await session(["session", "start", "--id", "rooms"])).exitCode).toBe(EXIT_OK)
    const put = await session(
      ["session", "put", "--id", "rooms", "--file", "-", "--no-server"],
      `${line({ title: "Quoted heading again", article_html: asText })}\n`
    )
    expect(parse(put.stdout).code).toBe("ERR_INVALID_MEMORY")
    expect(parse(put.stdout).error).toContain("holds the block tag `<h1>` as characters")
  })

  it("says the first sentence never ended when the claim ran on into a fence", () => {
    /**
     * The claim is the body's first sentence, up to the first `.`, `!`, or `?` and a space or a
     * line break, so a body whose first sentence has no end before a fence carries the fence in
     * its claim as text. The refusal says so, rather than advising the fence the writer used.
     */
    const fence = "```html\n<ul>\n  <li>x</li>\n</ul>\n```"
    const unended = markupInProse(`The template renders this markup:\n\n${fence}`)
    expect(unended).toMatchObject({ line: 4, tag: "<ul>", unended: true })
    // The same body with its first sentence ended is a claim, then a figure, and writes.
    expect(markupInProse(`The template renders this markup.\n\n${fence}`)).toBeUndefined()
    // A body that opens with a fence has it in the claim the same way.
    expect(markupInProse(`${fence}\n\nThe list has one item.`)).toMatchObject({
      line: 2,
      unended: true
    })
    // A tag on the claim's own first line is prose the writer typed, and gets the usual reason.
    expect(markupInProse("Use <ul> for lists:\n\nthen more.")?.unended).toBeUndefined()

    const decoded = decodeApply(
      line({ title: "T", body: `The template renders this markup:\n\n${fence}` })
    )
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.failure.error).toContain("`<ul>` on its line 4")
    expect(decoded.failure.error).toContain("first sentence never ends before the tag")
    const typed = decodeApply(line({ title: "T", body: "One.\n\nThen <ul> here." }))
    expect(!typed.ok && typed.failure.error).toContain("once the body's first sentence has ended")
  })
})

/**
 * Prose built from the pieces that move a tag in or out of code: backticks, fences, sentence
 * ends, line breaks in three spellings, NULs, both spellings of a tag, and names that only look
 * like one.
 */
const prosePiece = fc.constantFrom(
  "word",
  "List",
  "x",
  " ",
  ".",
  "!",
  "\n",
  "\n\n",
  "\r",
  "\r\n",
  "\0",
  "\t",
  "`",
  "``",
  "```",
  "```html",
  "<",
  ">",
  "/",
  "&",
  "&lt;",
  "&gt;",
  "p",
  "ul",
  "li",
  "h2",
  "pre",
  "Table",
  "<p>",
  "</p>",
  "<li ",
  "&lt;p&gt;",
  "a=`v`"
)

describe("the prose door and the rendered file", () => {
  it("refuses a body exactly when the file it renders holds a block tag as text", () => {
    /**
     * The door derives the claim and tail, judges what the template will render from them, and
     * names a line of the body; `blockTagInArticle` reads the file the template does render. For
     * any body, the two find the same tag or none, and the line the door names holds the tag's
     * opening. Only the opening, up to its first space: a tag can run from the claim into the
     * next line, which the `<p>` joins with a space.
     */
    fc.assert(
      fc.property(
        fc.array(prosePiece, { maxLength: 40 }).map((pieces) => pieces.join("")),
        (body) => {
          const refusal = markupInProse(body)
          const file = renderTemplate({
            title: "A fact",
            claim: claimFromProse(body),
            body: proseTail(body),
            memoryType: "semantic",
            at: "2031-01-01T00:00:00Z"
          })
          expect(refusal?.tag).toBe(blockTagInArticle(file)?.tag)
          if (refusal === undefined) return
          const named = body.split(/\r\n|\r|\n/)[refusal.line - 1] ?? ""
          expect(named.replaceAll("\0", "")).toContain(refusal.tag.split(/\s/)[0])
        }
      ),
      { numRuns: 3000 }
    )
  })
})

describe("claim derivation: prose becomes a claim and a tail", () => {
  it("takes the first sentence as the claim and the rest as paragraphs", () => {
    expect(claimFromProse("The first thing. The second thing.")).toBe("The first thing.")
    expect(proseTail("The first thing. The second thing.")).toEqual(["The second thing."])
    // No terminator: the whole body is the claim, with no tail.
    expect(claimFromProse("A fragment with no stop")).toBe("A fragment with no stop")
    expect(proseTail("A fragment with no stop")).toEqual([])
  })

  it("keeps a fenced code block one paragraph, blank lines and all", () => {
    /**
     * The mutation this locks: split on blank lines with no fence awareness. The block below
     * shatters into two paragraphs, neither a complete fence, and both land as escaped backtick
     * text — the exact flattening backlog item 7 exists to end.
     */
    const body = "The claim. Then setup:\n\n```ts\nif (a) {\n\n  b()\n}\n```\n\nAnd after."
    expect(proseTail(body)).toEqual([
      "Then setup:",
      "```ts\nif (a) {\n\n  b()\n}\n```",
      "And after."
    ])
  })

  it("keeps splitting normally when a backtick run is inline prose, not a fence", () => {
    const body = "The claim. Mention ``` in passing.\n\nA second paragraph."
    expect(proseTail(body)).toEqual(["Mention ``` in passing.", "A second paragraph."])
  })

  it("carries an unterminated fence to the end of the prose as one paragraph", () => {
    // The template then escapes it as text; the splitter's job is only not to shatter it.
    expect(proseTail("The claim. Next:\n\n```ts\nconst a = 1\n\nconst b = 2")).toEqual([
      "Next:",
      "```ts\nconst a = 1\n\nconst b = 2"
    ])
  })

  it("gives an applied memory a NON-EMPTY gist, which an empty claim would not", async () => {
    /**
     * The mutation this locks: drop the claim derivation and pass `claim: ""` with the prose as body.
     * `renderTemplate` then emits `<p><mark></mark> the prose</p>`.
     *
     * The consequence has CHANGED, and the test is worth keeping through the change. It used to
     * commit: exactly one `<mark>` in the first `<p>` passed `checkMemory` with zero violations, so
     * the file landed and indexed with an empty `files.gist`, and this assertion on the gist was the
     * only thing that could catch it (a write-succeeded assertion passed under the mutation, because
     * the mutation's whole problem was that it succeeded). `@memhtml/html` constraint 1 now refuses an
     * empty `<mark>`, so the mutation is REFUSED by the store's render gate instead.
     *
     * The assertion stays on the gist rather than moving to "the write succeeds", because what this
     * door owns is that the derived claim is the right TEXT — the store owns non-emptiness now, and a
     * derivation that returned `"x"` for every body would satisfy the gate and fail here.
     */
    const cli = await withApply()
    const data = applied(
      (
        await cli.fromFile([
          line({ title: "Gist bearing", body: "The load-bearing sentence. And a tail." })
        ])
      ).stdout
    )
    const { readMemory } = await import("../src/operations.js")
    const read = await Effect.runPromise(
      Effect.provide(readMemory(data.results[0]?.path ?? ""), cli.layer)
    )
    expect(read.doc.article.gist).toBe("The load-bearing sentence.")
    expect(read.doc.article.gist).not.toBe("")
  })

  /**
   * The article_html path still writes with `claim: ""`, end to end through the door.
   *
   * The pair to the empty-`<mark>` refusal `@memhtml/html` now enforces: this op carries NO claim field at
   * all and the decoder leaves `claim` empty (asserted one describe up), so the ONLY thing making the
   * file valid is the non-empty `<mark>` inside the caller's own markup. A constraint that had been
   * written against the `claim` PARAMETER rather than against the rendered `<mark>` would refuse this
   * write, and the markup escape hatch — the only way to author `<time datetime>`, so the only way to
   * reach `files.event_at` — would be dead.
   */
  it("writes an article_html op with an empty claim, taking the gist from the markup", async () => {
    const cli = await withApply()
    const result = await cli.fromFile([
      line({
        title: "Authored markup",
        article_html:
          '<p><mark>The authored claim.</mark> Recorded <time datetime="2026-07-28">then</time>.</p>'
      })
    ])
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)
    expect(data.summary).toEqual({
      total: 1,
      written: 1,
      deduped: 0,
      failed: 0,
      skipped: 0
    })
    const { readMemory } = await import("../src/operations.js")
    const read = await Effect.runPromise(
      Effect.provide(readMemory(data.results[0]?.path ?? ""), cli.layer)
    )
    expect(read.doc.article.gist).toBe("The authored claim.")
    // The event time came through as markup, which is the reason this path exists.
    expect(read.doc.article.eventAt).toBe("2026-07-28")
  })
})

describe("the manifest guide (AC-6-6)", () => {
  it("answers on a bare `memhtml`, `memhtml help`, `memhtml --help`, and `memhtml manifest`", async () => {
    /**
     * All four with NO layer, which is the point: the guide is the FIRST thing an agent reads and it
     * must answer on a machine with no repo, no database, and no credentials.
     *
     * `help` and `--help` are answered by the help arm in `run.ts`, which returns the manifest when no
     * command is named and stdout is a pipe. The pipe is passed explicitly (`stdoutIsTTY = false`)
     * rather than inherited from the test runner, because on a terminal the same two spellings render
     * the agent doc as Markdown, and a runner that kept a TTY would otherwise decide this assertion.
     */
    for (const argv of [[], ["help"], ["--help"], ["manifest"]]) {
      const result = await run(argv, undefined, undefined, false)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      const body = parse(result.stdout)
      expect(body.type, argv.join(" ")).toBe("cli.manifest")
      const guide = (body.data as { readonly guide: ReadonlyArray<{ readonly topic: string }> })
        .guide
      expect(
        guide.map((block) => block.topic),
        argv.join(" ")
      ).toEqual([
        "first-call",
        "write-surfaces",
        "when-to-batch",
        "conflicts",
        "authoring",
        "code-mode",
        "recall-discipline"
      ])
    }
  })

  it("survives --dense, which strips nulls and could have eaten the guide", async () => {
    const result = await run(["manifest", "--dense"])
    const data = parse(result.stdout).data as {
      readonly guide: ReadonlyArray<{ readonly topic: string; readonly body: string }>
    }
    // Length from GUIDE itself rather than a literal: the assertion is that `--dense` strips NOTHING
    // from the guide, and a hardcoded count makes adding a topic look like a `--dense` regression.
    expect(data.guide).toHaveLength(GUIDE.length)
    for (const block of data.guide) expect(block.body.length).toBeGreaterThan(200)
  })

  it("teaches the three write doors in `write-surfaces`", async () => {
    const guide = await liveGuide()
    const body = guide["write-surfaces"] ?? ""
    // The CLI door, both commands.
    expect(body).toContain("memhtml write")
    expect(body).toContain("memhtml apply")
    // The MCP door, named as it is invoked.
    expect(body).toContain("memhtml serve mcp")
    // The third door and the duty it carries — the one an agent will not guess is legal.
    expect(body).toContain("$MEMHTML_ROOT")
    expect(body).toContain("system of record")
    expect(body).toContain("you own the commit")
    /**
     * And the concurrency rule, which is the one an agent most needs to have right: it decides
     * whether writing while a server runs is safe. Both halves are asserted because each is
     * separately load-bearing — that concurrent use IS allowed, and that a checked-out curation
     * branch is the exception. A guide carrying only the permission would have an agent write onto a
     * curation branch; a guide carrying only the exception would have it refuse ordinary concurrent work.
     */
    expect(body).toContain("may share one store")
    expect(body).toContain("`curate/<date>` branch")
  })

  it("teaches when to batch, with an example line the test PARSES", async () => {
    /**
     * The example is parsed rather than pattern-matched, because an example an agent copies is only
     * worth carrying if it is valid. A prose-only example drifts silently the first time a field is
     * renamed — and this one is the exact string `GUIDE_OP_EXAMPLE` holds, so the doc, the manifest,
     * and this assertion read the same bytes.
     */
    const guide = await liveGuide()
    const body = guide["when-to-batch"] ?? ""
    expect(body).toContain("memhtml apply")
    const example = body.split("\n").find((entry) => entry.startsWith("{"))
    expect(example).toBe(GUIDE_OP_EXAMPLE)
    const op = JSON.parse(example as string) as Record<string, unknown>
    expect(op.op).toBe("write")
    expect(typeof op.title).toBe("string")
    expect(typeof op.type).toBe("string")
    // The semantics an agent would otherwise have to discover from a refusal.
    expect(body).toContain("ONE commit")
    expect(body).toContain("--continue-on-error")
    expect(body).toContain("deduped")
  })

  it("APPLIES its own example line, so the guide is executable and not just plausible", async () => {
    // The strongest form of "every claim is true of this build": the bytes the manifest hands an agent,
    // fed back through the door they describe.
    const cli = await withApply()
    const result = await cli.fromFile([GUIDE_OP_EXAMPLE])
    expect(result.exitCode).toBe(EXIT_OK)
    const data = applied(result.stdout)
    expect(data.summary.written).toBe(1)
    expect(data.commit_sha).not.toBeNull()
  })

  it("states the authoring XOR and both markup constraints", async () => {
    const guide = await liveGuide()
    const body = guide.authoring ?? ""
    expect(body).toContain("--claim")
    expect(body).toContain("--article-html")
    expect(body).toContain("article_html")
    expect(body).toContain("<mark>")
    expect(body).toContain("<time datetime>")
    // The reason a failed markup write is cheap, which is what makes retrying the right move.
    expect(body).toContain("before")
  })

  it("tells an agent to branch on the code in `first-call`", async () => {
    const guide = await liveGuide()
    expect(guide["first-call"]).toContain("Branch on `code`")
  })

  it("keeps the guide's topic list and the exported constant in agreement", () => {
    // Two projections of one array. A topic renamed in `GUIDE` and not in `GUIDE_TOPICS` would make
    // every cross-reference in this suite and in AGENTS.md silently wrong.
    expect(GUIDE_TOPICS).toEqual(GUIDE.map((block) => block.topic))
    expect(new Set(GUIDE_TOPICS).size).toBe(GUIDE_TOPICS.length)
    for (const block of GUIDE) {
      // Prose for an agent mid-task, not a label: complete sentences, ending in one.
      expect(block.body.length, block.topic).toBeGreaterThan(200)
      expect(block.body.trim().endsWith("."), block.topic).toBe(true)
    }
  })

  it("names `apply` in the command table with its own response type", async () => {
    const data = parse((await run(["manifest"])).stdout).data as {
      readonly commands: ReadonlyArray<{
        readonly name: string
        readonly flags: ReadonlyArray<{ readonly name: string }>
        readonly responseTypes: ReadonlyArray<string>
      }>
      readonly responseTypes: ReadonlyArray<string>
    }
    const apply = data.commands.find((command) => command.name === "apply")
    expect(apply?.responseTypes).toEqual(["batch.applied"])
    expect(apply?.flags.map((flag) => flag.name)).toEqual([
      "file",
      "continue-on-error",
      "detect-conflicts",
      "detect-near-duplicates",
      "session-id",
      "prompt-id",
      "turn-uuid"
    ])
    expect(data.responseTypes).toContain("batch.applied")
  })
})

/** The guide as a topic → body map, read from the LIVE manifest rather than from the module. */
const liveGuide = async (): Promise<Record<string, string>> => {
  const body = parse((await run(["manifest"])).stdout)
  const guide = (body.data as { readonly guide: ReadonlyArray<{ topic: string; body: string }> })
    .guide
  return Object.fromEntries(guide.map((block) => [block.topic, block.body]))
}
