import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { type MemoryRecord, StorageFailure } from "@memhtml/contracts"
import {
  type Data,
  Field,
  Schema,
  Table,
  tableFromIPC,
  tableToIPC,
  Utf8,
  vectorFromArray
} from "apache-arrow"
import { instance as getVisitor } from "apache-arrow/visitor/get"
import { Effect, Result } from "effect"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import {
  FORMAT_METADATA_KEY,
  readSnapshot,
  readSnapshotIfPresent,
  SHA_METADATA_KEY,
  SNAPSHOT_FORMAT,
  snapshotPathFor,
  writeSnapshot
} from "../src/index.js"

/**
 * The snapshot is a cache of parsed records, so the one property that matters is that what comes
 * back is what went in, byte for byte and null for null, over records shaped by a generator rather
 * than by hand. Everything else here is the refusal surface: a file that is not a snapshot must be a
 * `StorageFailure` whose `operation` says which check refused it, never a table of undefined cells.
 *
 * Mutation notes, one per guard (each was applied once and the named test went red):
 * - `readSnapshot`: delete the `sha === undefined` branch; "refuses a file without a sha" fails
 *   because the read succeeds with `sha: undefined`.
 * - `readSnapshot`: delete the `compareSchemas` branch; "refuses a foreign schema" fails because
 *   the failure arrives as `snapshot.read.rows` instead of `snapshot.read.schema`.
 * - `readSnapshot`: delete the format check; "refuses a file of no format version, or another" fails
 *   because both files read.
 * - `readSnapshotIfPresent`: drop the `ENOENT` branch; "answers null for a file that is not there"
 *   fails with `snapshot.read.file`.
 * - `writeSnapshot`: delete the `mkdir` step; the collection-time write of 1,000 records fails with
 *   `snapshot.write.file` (ENOENT) because `snapshotPathFor` names a directory that does not exist
 *   yet under a fresh temp root, so the whole file reports as a failed suite.
 * - `writeSnapshot`: stage through the one fixed name `<path>.tmp` and `rename` it (the writer before
 *   `write-file-atomic`); "survives writers of one sha in four processes at once" fails with
 *   `snapshot.write.rename` (ENOENT) in a child, because one process renamed another's staging file
 *   away, and "survives concurrent writers of one sha in one process" fails the same way.
 * - The lazy read: decode the one row through the column (`html.toArray()[500]`, an eager read)
 *   instead of through the row proxy; "decodes 1 html cell for one row" fails with 1,000 visits.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const runErr = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await run(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error("expected a failure, got a value")
  return result.failure
}

const SHA = "0123456789abcdef0123456789abcdef01234567"

// Graphemes rather than code points, so multibyte and combining sequences reach the Utf8 columns.
const text = fc.string({ unit: "grapheme", maxLength: 40 })
const hex = (length: number) =>
  fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: length, maxLength: length })
const iso = fc.integer({ min: 0, max: 1_800_000_000_000 }).map((ms) => new Date(ms).toISOString())
const unitInterval = fc.double({ min: 0, max: 1, noNaN: true })
const slug = fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 20 })

const linkArb = fc.record({
  rel: fc.constantFrom("memhtml-supersedes", "memhtml-contradicts", "related", "cites"),
  href: slug.map((s) => `/areas/inbox/${s}.html`)
})

const facetArb = fc.record({ name: text, value: text })

type Body = Omit<MemoryRecord, "path" | "html">

const bodyArb: fc.Arbitrary<Body> = fc.record({
  blobSha: hex(40),
  contentHash: hex(64).map((h) => `sha256:${h}`),
  frameKey: fc.option(text, { nil: null }),
  title: text,
  memoryType: fc.constantFrom("fact", "event", "preference", "procedure", "insight"),
  status: fc.constantFrom("active", "superseded", "archived"),
  claim: text,
  createdAt: iso,
  updatedAt: iso,
  eventAt: fc.option(iso, { nil: null }),
  confidence: fc.option(unitInterval, { nil: null }),
  importance: fc.option(unitInterval, { nil: null }),
  tags: fc.array(text, { maxLength: 5 }),
  entities: fc.array(text, { maxLength: 4 }),
  links: fc.array(linkArb, { maxLength: 4 }),
  facets: fc.array(facetArb, { maxLength: 3 }),
  bodyText: fc.string({ unit: "grapheme", maxLength: 400 }),
  archived: fc.boolean()
})

/** A record with a path derived from its index and an html body that carries its parsed fields. */
const recordFrom = (body: Body, index: number): MemoryRecord => {
  const path = `${body.archived ? "archive" : "areas/inbox"}/memory-${index}.html`
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${body.title}</title>`,
    ...body.links.map((link) => `<link rel="${link.rel}" href="${link.href}">`),
    "</head><body><article>",
    `<p><mark>${body.claim}</mark></p>`,
    `<p>${body.bodyText}</p>`,
    "</article></body></html>"
  ].join("\n")
  return { ...body, path, html }
}

const recordArb: fc.Arbitrary<MemoryRecord> = fc
  .tuple(bodyArb, fc.nat({ max: 1_000_000 }))
  .map(([body, index]) => recordFrom(body, index))

const generate = (count: number): ReadonlyArray<MemoryRecord> =>
  fc.sample(bodyArb, { numRuns: count, seed: 20260923 }).map(recordFrom)

const root = await mkdtemp(join(tmpdir(), "memhtml-snapshot-"))
afterAll(() => rm(root, { recursive: true, force: true }))

// Measured once at collection time so the numbers can sit in the test names, as the spec asks.
const thousand = generate(1000)
const thousandPath = snapshotPathFor(root, SHA)
const written = await run(writeSnapshot({ records: thousand, sha: SHA, path: thousandPath }))
const readStart = performance.now()
const readBack = await run(readSnapshot(thousandPath))
const readMs = performance.now() - readStart

/**
 * The lazy-read measurement. `tableFromIPC` over a `Buffer` keeps each column's value buffer as a
 * view into that Buffer, which the identity check below proves. apache-arrow has no public counter
 * on cell reads, but its row proxy resolves every property through the singleton `GetVisitor`
 * (`apache-arrow/visitor/get` `instance`), whose dispatch looks `visitUtf8` up per call, so an
 * instance override records exactly the Utf8 cells a row read decodes, by row. Laziness is asserted
 * on those counts and nothing else: a wall-clock comparison of one row against all rows depends on
 * what else the host is running, and failed two full parallel runs in three.
 */
const lazy = await (async () => {
  const buffer = await readFile(thousandPath)
  const table = tableFromIPC(buffer)
  const html = table.getChild("html")
  if (html === null) throw new Error("no html column")
  const zeroCopy = html.data.every((chunk: Data) => chunk.values.buffer === buffer.buffer)

  type Utf8Visit = (data: Data<Utf8>, index: number) => string | null
  const visitor = getVisitor as unknown as { visitUtf8: Utf8Visit }
  const original = visitor.visitUtf8
  // Every Utf8 cell decoded, by row index.
  const rows: Array<number> = []
  visitor.visitUtf8 = (data, index) => {
    rows.push(index)
    return original.call(getVisitor, data, index)
  }
  try {
    const one = table.get(500)?.html
    const oneRows = rows.splice(0)
    let allLength = 0
    for (let row = 0; row < table.numRows; row += 1) {
      allLength += table.get(row)?.html.length ?? 0
    }
    const allRows = rows.splice(0)
    return {
      batches: table.batches.length,
      zeroCopy,
      one,
      oneVisits: oneRows.length,
      oneRows,
      allVisits: allRows.length,
      allRows,
      allLength
    }
  } finally {
    visitor.visitUtf8 = original
  }
})()

describe("snapshotPathFor", () => {
  it("names .memhtml/snapshots/<sha>.arrow under the root", () => {
    expect(snapshotPathFor("/repo", SHA)).toBe(`/repo/.memhtml/snapshots/${SHA}.arrow`)
  })
})

describe("writeSnapshot / readSnapshot", () => {
  it(`round-trips 1,000 records: ${written.bytes} bytes on disk, read in ${readMs.toFixed(1)} ms`, async () => {
    expect(written.rows).toBe(1000)
    expect((await stat(thousandPath)).size).toBe(written.bytes)
    expect(readBack.sha).toBe(SHA)
    expect(readBack.records).toHaveLength(1000)
    expect(readBack.records).toEqual(thousand)
  })

  it("leaves no staging file behind", async () => {
    expect(await readdir(dirname(thousandPath))).toEqual([`${SHA}.arrow`])
  })

  it(`writes format ${SNAPSHOT_FORMAT} and the sha into the schema metadata`, async () => {
    const table = tableFromIPC(await readFile(thousandPath))
    expect(table.schema.metadata.get(FORMAT_METADATA_KEY)).toBe(SNAPSHOT_FORMAT)
    expect(table.schema.metadata.get(SHA_METADATA_KEY)).toBe(SHA)
  })

  it("round-trips the empty set", async () => {
    const path = join(root, "empty.arrow")
    const result = await run(writeSnapshot({ records: [], sha: "empty-sha", path }))
    expect(result.rows).toBe(0)
    expect(result.bytes).toBeGreaterThan(0)
    const back = await run(readSnapshot(path))
    expect(back).toEqual({ sha: "empty-sha", records: [] })
  })

  it("round-trips generated record sets of any shape (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(recordArb, { maxLength: 6 }), async (records) => {
        const path = join(root, `property-${process.hrtime.bigint()}.arrow`)
        await run(writeSnapshot({ records, sha: SHA, path }))
        const back = await run(readSnapshot(path))
        expect(back.records).toEqual(records)
      }),
      { numRuns: 30 }
    )
  })
})

describe("readSnapshot refusals", () => {
  const failure = async (path: string) => {
    const error = await runErr(readSnapshot(path))
    expect(error).toBeInstanceOf(StorageFailure)
    return error.operation
  }

  it("names snapshot.read.file for a missing path", async () => {
    expect(await failure(join(root, "absent.arrow"))).toBe("snapshot.read.file")
  })

  it("names snapshot.read.decode for bytes that are not an Arrow IPC file", async () => {
    const path = join(root, "garbage.arrow")
    await writeFile(path, "definitely not an arrow file, but long enough to have a footer")
    expect(await failure(path)).toBe("snapshot.read.decode")
  })

  it("names snapshot.read.decode for a truncated snapshot", async () => {
    const path = join(root, "truncated.arrow")
    const whole = await readFile(thousandPath)
    await writeFile(path, whole.subarray(0, 200))
    expect(await failure(path)).toBe("snapshot.read.decode")
  })

  /** The 1,000-record snapshot rewritten with `edit` applied to its schema metadata. */
  const relabeled = async (name: string, edit: (metadata: Map<string, string>) => void) => {
    const path = join(root, name)
    const table = tableFromIPC(await readFile(thousandPath))
    const metadata = new Map(table.schema.metadata)
    edit(metadata)
    await writeFile(
      path,
      tableToIPC(new Table(new Schema(table.schema.fields, metadata), table.batches), "file")
    )
    return path
  }

  it("refuses a file of no format version, or another (snapshot.read.format)", async () => {
    const none = await relabeled("no-format.arrow", (metadata) => {
      metadata.delete(FORMAT_METADATA_KEY)
    })
    expect(await failure(none)).toBe("snapshot.read.format")
    for (const other of ["0", "2", ""]) {
      const path = await relabeled(`format-${other}.arrow`, (metadata) => {
        metadata.set(FORMAT_METADATA_KEY, other)
      })
      expect(await failure(path), other).toBe("snapshot.read.format")
    }
  })

  it("refuses a file without a sha (snapshot.read.sha)", async () => {
    const path = await relabeled("no-sha.arrow", (metadata) => {
      metadata.delete(SHA_METADATA_KEY)
    })
    expect(tableFromIPC(await readFile(path)).schema.metadata.get(SHA_METADATA_KEY)).toBeUndefined()
    expect(await failure(path)).toBe("snapshot.read.sha")
  })

  it("refuses a foreign schema (snapshot.read.schema)", async () => {
    const path = join(root, "foreign.arrow")
    const foreign = new Table({ path: vectorFromArray(["areas/inbox/a.html"], new Utf8()) })
    const schema = new Schema(
      [new Field("path", new Utf8(), true)],
      new Map([
        [SHA_METADATA_KEY, SHA],
        [FORMAT_METADATA_KEY, SNAPSHOT_FORMAT]
      ])
    )
    await writeFile(path, tableToIPC(new Table(schema, foreign.batches), "file"))
    expect(await failure(path)).toBe("snapshot.read.schema")
  })
})

describe("readSnapshotIfPresent", () => {
  it("answers null for a file that is not there", async () => {
    expect(await run(readSnapshotIfPresent(join(root, "never-written.arrow")))).toBeNull()
  })

  it("reads a snapshot the way readSnapshot does, and refuses what it refuses", async () => {
    expect(await run(readSnapshotIfPresent(thousandPath))).toEqual(readBack)
    const path = join(root, "garbage-if-present.arrow")
    await writeFile(path, "definitely not an arrow file, but long enough to have a footer")
    const error = await runErr(readSnapshotIfPresent(path))
    expect(error.operation).toBe("snapshot.read.decode")
  })
})

const execFileP = promisify(execFile)
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url))

/**
 * The script a child process runs: write the snapshot of the records in `recordsPath` at `path`,
 * `rounds` times, from the package's built `dist` (the suite's own build step makes it). Evaluated
 * with the package as its working directory, so `effect` resolves from the package's dependencies.
 */
const WRITER = `
import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { writeSnapshot } from "./dist/index.js"
const [path, sha, recordsPath, rounds] = process.argv.slice(1)
const records = JSON.parse(await readFile(recordsPath, "utf8"))
for (let round = 0; round < Number(rounds); round += 1) {
  const result = await Effect.runPromise(Effect.result(writeSnapshot({ records, sha, path })))
  if (result._tag === "Failure") {
    process.stderr.write(\`round \${round}: \${result.failure.operation}\n\`)
    process.exit(1)
  }
}
`

describe("concurrent writers of one sha", () => {
  const SIBLING = "1111111111111111111111111111111111111111"

  it("survives concurrent writers of one sha in one process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memhtml-snapshot-same-"))
    try {
      const path = join(dir, `${SIBLING}.arrow`)
      const records = thousand.slice(0, 200)
      await run(
        Effect.all(
          Array.from({ length: 8 }, () => writeSnapshot({ records, sha: SIBLING, path })),
          { concurrency: "unbounded" }
        )
      )
      expect(await readdir(dir)).toEqual([`${SIBLING}.arrow`])
      expect((await run(readSnapshot(path))).records).toEqual(records)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("survives writers of one sha in four processes at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memhtml-snapshot-procs-"))
    try {
      const path = join(dir, `${SIBLING}.arrow`)
      const records = thousand.slice(0, 200)
      const recordsPath = join(dir, "records.json")
      await writeFile(recordsPath, JSON.stringify(records))
      const children = Array.from({ length: 4 }, () =>
        execFileP(
          process.execPath,
          ["--input-type=module", "-e", WRITER, path, SIBLING, recordsPath, "25"],
          { cwd: PACKAGE_DIR, encoding: "utf8" }
        ).then(
          () => "ok",
          (error: { readonly stderr?: string }) => `failed: ${error.stderr ?? String(error)}`
        )
      )
      expect(await Promise.all(children)).toEqual(["ok", "ok", "ok", "ok"])
      expect((await readdir(dir)).sort()).toEqual([`${SIBLING}.arrow`, "records.json"])
      expect((await run(readSnapshot(path))).records).toEqual(records)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("lazy read over a Buffer", () => {
  it(`opens ${lazy.batches} batch with every html value buffer a view into the input Buffer`, () => {
    expect(lazy.batches).toBe(1)
    expect(lazy.zeroCopy).toBe(true)
  })

  it("decodes 1 html cell for one row, that row's, and 1000 for all rows, each once", () => {
    expect(lazy.one).toBe(thousand[500]?.html)
    expect(lazy.oneVisits).toBe(1)
    expect(lazy.oneRows).toEqual([500])
    expect(lazy.allVisits).toBe(1000)
    expect(lazy.allRows).toEqual(Array.from({ length: 1000 }, (_, row) => row))
    expect(lazy.allLength).toBe(thousand.reduce((sum, record) => sum + record.html.length, 0))
  })
})
