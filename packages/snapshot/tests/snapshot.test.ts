import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

import { readSnapshot, SHA_METADATA_KEY, snapshotPathFor, writeSnapshot } from "../src/index.js"

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
 * - `writeSnapshot`: delete the `mkdir` step; the collection-time write of 1,000 records fails with
 *   `snapshot.write.file` (ENOENT) because `snapshotPathFor` names a directory that does not exist
 *   yet under a fresh temp root, so the whole file reports as a failed suite.
 * - `writeSnapshot`: write to `path` directly instead of staging plus rename; "leaves no staging
 *   file behind" still passes, so that step is a design choice, not a guard this suite proves.
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
 * instance override counts exactly the Utf8 cells a row read decodes.
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
  let visits = 0
  visitor.visitUtf8 = (data, index) => {
    visits += 1
    return original.call(getVisitor, data, index)
  }
  try {
    table.get(0)?.html
    visits = 0
    const oneStart = performance.now()
    const one = table.get(500)?.html
    const oneMs = performance.now() - oneStart
    const oneVisits = visits
    visits = 0
    const allStart = performance.now()
    let allLength = 0
    for (let row = 0; row < table.numRows; row += 1) {
      allLength += table.get(row)?.html.length ?? 0
    }
    const allMs = performance.now() - allStart
    return {
      batches: table.batches.length,
      zeroCopy,
      one,
      oneVisits,
      oneMs,
      allVisits: visits,
      allMs,
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
    await expect(stat(`${thousandPath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" })
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

  it("refuses a file without a sha (snapshot.read.sha)", async () => {
    const path = join(root, "no-sha.arrow")
    const table = tableFromIPC(await readFile(thousandPath))
    const stripped = new Table(new Schema(table.schema.fields), table.batches)
    expect(stripped.schema.metadata.get(SHA_METADATA_KEY)).toBeUndefined()
    await writeFile(path, tableToIPC(stripped, "file"))
    expect(await failure(path)).toBe("snapshot.read.sha")
  })

  it("refuses a foreign schema (snapshot.read.schema)", async () => {
    const path = join(root, "foreign.arrow")
    const foreign = new Table({ path: vectorFromArray(["areas/inbox/a.html"], new Utf8()) })
    const schema = new Schema(
      [new Field("path", new Utf8(), true)],
      new Map([[SHA_METADATA_KEY, SHA]])
    )
    await writeFile(path, tableToIPC(new Table(schema, foreign.batches), "file"))
    expect(await failure(path)).toBe("snapshot.read.schema")
  })
})

describe("lazy read over a Buffer", () => {
  it(`opens ${lazy.batches} batch with every html value buffer a view into the input Buffer`, () => {
    expect(lazy.batches).toBe(1)
    expect(lazy.zeroCopy).toBe(true)
  })

  it(`decodes ${lazy.oneVisits} html cell for one row (${lazy.oneMs.toFixed(3)} ms) vs ${lazy.allVisits} for all rows (${lazy.allMs.toFixed(1)} ms)`, () => {
    expect(lazy.one).toBe(thousand[500]?.html)
    expect(lazy.oneVisits).toBe(1)
    expect(lazy.allVisits).toBe(1000)
    expect(lazy.allLength).toBe(thousand.reduce((sum, record) => sum + record.html.length, 0))
    expect(lazy.oneMs).toBeLessThan(lazy.allMs)
  })
})
