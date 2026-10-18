import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { StorageFailure } from "@memhtml/contracts"
import {
  Field,
  Float32,
  Schema,
  Table,
  tableFromIPC,
  tableToIPC,
  Utf8,
  vectorFromArray
} from "apache-arrow"
import { Effect, Result } from "effect"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import {
  DIMENSION_METADATA_KEY,
  MODEL_ID_METADATA_KEY,
  readVectorCache,
  STAGING_ABANDONED_MS,
  type StoredVectorSpace,
  VECTOR_CACHE_FORMAT,
  VECTOR_FORMAT_METADATA_KEY,
  VECTORS_DIR,
  vectorCachePathFor,
  writeVectorCache
} from "../src/index.js"

/**
 * The vector cache is rebuildable, so what matters is that a read returns exactly the vectors that
 * were written, for the space they were written in, and that a file from any other space is refused
 * rather than read as numbers.
 *
 * Mutation notes, one per guard (each was applied once and the named test went red):
 * - `readVectorCache`: drop the model id half of the metadata comparison, and "refuses another model
 *   id at the same dimension" fails because another space's vectors are read.
 * - `readVectorCache`: drop the dimension half, and "refuses another dimension of the same model id"
 *   fails with `vectors.read.schema` instead of `vectors.read.space`.
 * - `readVectorCache`: drop the `compareSchemas` check, and "refuses a foreign schema" fails with
 *   `vectors.read.rows` instead of `vectors.read.schema`.
 * - `readVectorCache`: drop the `ENOENT` branch, and "a missing file is null" fails with
 *   `vectors.read.file`.
 * - `tableOf`: drop the width check, and "refuses to write a vector of the wrong width" fails
 *   because the file is written.
 * - `readVectorCache`: drop the format check, and "reads a cache of another format version as
 *   absent" fails because the files read (and the one of another model id fails with
 *   `vectors.read.space`).
 * - `readVectorCache`: drop the `?? UNVERSIONED_FORMAT` default, and "reads a legacy cache with no
 *   format key as format 1" fails because the read answers `null`.
 * - `writeVectorCache`: drop the `sweepStaging` call, and "sweeps this cache's staging files a
 *   killed writer left" fails because the abandoned files stay.
 * - `sweepStaging`: remove every match whatever its age, and "sweeps this cache's staging files a
 *   killed writer left" fails because the fresh staging file is removed too.
 * - `writeVectorCache`: stage through the one fixed name `<path>.tmp` and `rename` it, and
 *   "survives concurrent writers of one cache in one process" fails with `vectors.write.rename`
 *   (ENOENT), the error the head server logged beside `head embed`.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const runErr = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await run(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error("expected a failure, got a value")
  return result.failure
}

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-vectors-"))
  roots.push(root)
  return root
}

const SPACE: StoredVectorSpace = { modelId: "cohere.embed-v4:0", dimension: 1024 }

/** A deterministic vector per row, so equality after a round trip is checkable per float. */
const vectorFor = (row: number, dimension: number): Float32Array =>
  Float32Array.from({ length: dimension }, (_, index) => Math.sin(row * 31 + index))

const hashFor = (row: number): string => `sha256:${row.toString(16).padStart(64, "0")}`

describe("vectorCachePathFor", () => {
  it("names one file per space under .memhtml/vectors, with the model id made one path segment", () => {
    expect(vectorCachePathFor("/r", SPACE)).toBe(
      join("/r", VECTORS_DIR, "cohere.embed-v4_0@1024.arrow")
    )
    expect(vectorCachePathFor("/r", { modelId: "a/b:c", dimension: 8 })).toBe(
      join("/r", VECTORS_DIR, "a_b_c@8.arrow")
    )
  })
})

// 8,000 vectors of 1,024 floats, the size of the live store, measured once at collection time so
// the numbers can ride in the test names.
const ROWS = 8_000
const measured = await (async () => {
  const root = await scratch()
  const path = vectorCachePathFor(root, SPACE)
  const vectors = new Map(
    Array.from({ length: ROWS }, (_, row) => [hashFor(row), vectorFor(row, SPACE.dimension)])
  )
  const writeStarted = performance.now()
  const written = await run(writeVectorCache({ stored: { space: SPACE, vectors }, path }))
  const writeMs = performance.now() - writeStarted
  const readStarted = performance.now()
  const read = await run(readVectorCache(path, SPACE))
  const readMs = performance.now() - readStarted
  return { root, path, vectors, written, writeMs, read, readMs }
})()

describe("the vector cache round trip", () => {
  it(`returns every vector that was written (${ROWS} x ${SPACE.dimension}, ${(measured.written.bytes / 1e6).toFixed(1)} MB, write ${measured.writeMs.toFixed(0)} ms, read ${measured.readMs.toFixed(0)} ms)`, () => {
    const { read, vectors, written } = measured
    expect(written.rows).toBe(ROWS)
    expect(read).not.toBeNull()
    expect(read?.space).toEqual(SPACE)
    expect(read?.bytes).toBe(written.bytes)
    expect(read?.vectors.size).toBe(ROWS)
    // Byte comparison per vector: exact to the bit, and cheap where a deep equal over eight million
    // floats is not.
    const bytes = (vector: Float32Array | undefined): Buffer =>
      vector === undefined
        ? Buffer.alloc(0)
        : Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
    let mismatched = 0
    for (const [hash, vector] of vectors) {
      if (!bytes(read?.vectors.get(hash)).equals(bytes(vector))) mismatched += 1
    }
    expect(mismatched).toBe(0)
  })

  it("hands out every vector as a view of one buffer, so the read copies no float", () => {
    const buffers = new Set([...(measured.read?.vectors.values() ?? [])].map((v) => v.buffer))
    expect(buffers.size).toBe(1)
  })

  it("leaves no staging file behind", async () => {
    expect(await readdir(join(measured.root, VECTORS_DIR))).toEqual([
      "cohere.embed-v4_0@1024.arrow"
    ])
  })

  it("round-trips any small set of vectors, the empty one included", async () => {
    const root = await scratch()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 16 }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 12 }),
        async (dimension, hashes) => {
          const space = { modelId: "fake", dimension }
          const vectors = new Map(
            hashes.map((hash, row) => [hash, vectorFor(row, dimension)] as const)
          )
          const path = vectorCachePathFor(root, space)
          await run(writeVectorCache({ stored: { space, vectors }, path }))
          const read = await run(readVectorCache(path, space))
          expect(read?.vectors).toEqual(vectors)
        }
      ),
      { numRuns: 40 }
    )
  })
})

describe("the vector cache refusals", () => {
  it("a missing file is null, not a failure", async () => {
    const root = await scratch()
    expect(await run(readVectorCache(vectorCachePathFor(root, SPACE), SPACE))).toBeNull()
  })

  it("refuses another model id at the same dimension", async () => {
    // `a:b` and `a_b` share a filename; the metadata is what tells them apart.
    const root = await scratch()
    const theirs = { modelId: "a:b", dimension: 4 }
    const ours = { modelId: "a_b", dimension: 4 }
    expect(vectorCachePathFor(root, theirs)).toBe(vectorCachePathFor(root, ours))
    const path = vectorCachePathFor(root, theirs)
    await run(
      writeVectorCache({
        stored: { space: theirs, vectors: new Map([["h", vectorFor(0, 4)]]) },
        path
      })
    )
    const failure = await runErr(readVectorCache(path, ours))
    expect(failure).toBeInstanceOf(StorageFailure)
    expect(failure.operation).toBe("vectors.read.space")
  })

  it("refuses another dimension of the same model id", async () => {
    const root = await scratch()
    const path = join(root, "cache.arrow")
    await run(
      writeVectorCache({
        stored: {
          space: { modelId: "m", dimension: 4 },
          vectors: new Map([["h", vectorFor(0, 4)]])
        },
        path
      })
    )
    const failure = await runErr(readVectorCache(path, { modelId: "m", dimension: 8 }))
    expect(failure.operation).toBe("vectors.read.space")
  })

  it("refuses a foreign schema that carries the right metadata", async () => {
    const root = await scratch()
    const path = join(root, "foreign.arrow")
    const schema = new Schema(
      [new Field("contentHash", new Utf8(), true), new Field("vector", new Float32(), true)],
      new Map([
        [VECTOR_FORMAT_METADATA_KEY, VECTOR_CACHE_FORMAT],
        [MODEL_ID_METADATA_KEY, "m"],
        [DIMENSION_METADATA_KEY, "4"]
      ])
    )
    const table = new Table(schema, {
      contentHash: vectorFromArray(["h"], new Utf8()),
      vector: vectorFromArray([1], new Float32())
    })
    await writeFile(path, tableToIPC(new Table(schema, table.batches), "file"))
    const failure = await runErr(readVectorCache(path, { modelId: "m", dimension: 4 }))
    expect(failure.operation).toBe("vectors.read.schema")
  })

  it("refuses bytes that are not an Arrow file", async () => {
    const root = await scratch()
    const path = join(root, "junk.arrow")
    await writeFile(path, "not arrow at all")
    const failure = await runErr(readVectorCache(path, SPACE))
    expect(failure.operation).toBe("vectors.read.decode")
  })

  it("refuses to write a vector of the wrong width", async () => {
    const root = await scratch()
    const path = join(root, "wide.arrow")
    const failure = await runErr(
      writeVectorCache({
        stored: {
          space: { modelId: "m", dimension: 4 },
          vectors: new Map([["h", vectorFor(0, 3)]])
        },
        path
      })
    )
    expect(failure.operation).toBe("vectors.write.encode")
    expect(await readdir(root)).toEqual([])
  })
})

describe("the vector cache format", () => {
  it(`writes format ${VECTOR_CACHE_FORMAT} into the metadata`, async () => {
    const table = tableFromIPC(await readFile(measured.path))
    expect(table.schema.metadata.get(VECTOR_FORMAT_METADATA_KEY)).toBe(VECTOR_CACHE_FORMAT)
  })

  /** A one-vector cache of `space` at `path`, and a rewrite of it with its metadata edited. */
  const relabelable = async (space: StoredVectorSpace) => {
    const root = await scratch()
    const path = vectorCachePathFor(root, space)
    await run(
      writeVectorCache({ stored: { space, vectors: new Map([["h", vectorFor(0, 4)]]) }, path })
    )
    const table = tableFromIPC(await readFile(path))
    const relabel = async (edit: (metadata: Map<string, string>) => void) => {
      const metadata = new Map(table.schema.metadata)
      edit(metadata)
      await writeFile(
        path,
        tableToIPC(new Table(new Schema(table.schema.fields, metadata), table.batches), "file")
      )
    }
    return { path, relabel }
  }

  it("reads a legacy cache with no format key as format 1, and the next write carries the key", async () => {
    const space = { modelId: "m", dimension: 4 }
    const { path, relabel } = await relabelable(space)
    // What every cache written before the key existed looks like: the same layout, no key.
    await relabel((metadata) => metadata.delete(VECTOR_FORMAT_METADATA_KEY))
    expect(tableFromIPC(await readFile(path)).schema.metadata.has(VECTOR_FORMAT_METADATA_KEY)).toBe(
      false
    )
    const read = await run(readVectorCache(path, space))
    expect([...(read?.vectors.keys() ?? [])]).toEqual(["h"])
    expect(read?.vectors.get("h")).toEqual(vectorFor(0, 4))
    // A legacy file is still judged on its space like any other.
    await relabel((metadata) => {
      metadata.delete(VECTOR_FORMAT_METADATA_KEY)
      metadata.set(MODEL_ID_METADATA_KEY, "another")
    })
    expect((await runErr(readVectorCache(path, space))).operation).toBe("vectors.read.space")
    await run(writeVectorCache({ stored: { space, vectors: read?.vectors ?? new Map() }, path }))
    const rewritten = tableFromIPC(await readFile(path)).schema.metadata
    expect(rewritten.get(VECTOR_FORMAT_METADATA_KEY)).toBe(VECTOR_CACHE_FORMAT)
  })

  it("reads a cache of another format version as absent, and leaves the file", async () => {
    const space = { modelId: "m", dimension: 4 }
    const { path, relabel } = await relabelable(space)
    await relabel((metadata) => metadata.set(VECTOR_FORMAT_METADATA_KEY, "2"))
    expect(await run(readVectorCache(path, space))).toBeNull()
    await relabel((metadata) => metadata.set(VECTOR_FORMAT_METADATA_KEY, "0"))
    expect(await run(readVectorCache(path, space))).toBeNull()
    // The version is judged before the space: a file of another layout says nothing reliable.
    await relabel((metadata) => {
      metadata.set(VECTOR_FORMAT_METADATA_KEY, "2")
      metadata.set(MODEL_ID_METADATA_KEY, "another")
    })
    expect(await run(readVectorCache(path, space))).toBeNull()
    // The miss leaves the file for the next write, which replaces it whole.
    expect((await stat(path)).size).toBeGreaterThan(0)
    await run(
      writeVectorCache({ stored: { space, vectors: new Map([["h2", vectorFor(1, 4)]]) }, path })
    )
    expect([...((await run(readVectorCache(path, space)))?.vectors.keys() ?? [])]).toEqual(["h2"])
  })
})

describe("the vector cache's writers", () => {
  it("survives concurrent writers of one cache in one process", async () => {
    const root = await scratch()
    const space = { modelId: "m", dimension: 8 }
    const path = vectorCachePathFor(root, space)
    await run(
      Effect.all(
        Array.from({ length: 8 }, (_, writer) =>
          writeVectorCache({
            stored: { space, vectors: new Map([[`h${String(writer)}`, vectorFor(writer, 8)]]) },
            path
          })
        ),
        { concurrency: "unbounded" }
      )
    )
    expect(await readdir(join(root, VECTORS_DIR))).toEqual(["m@8.arrow"])
    expect((await run(readVectorCache(path, space)))?.vectors.size).toBe(1)
  })

  it("sweeps this cache's staging files a killed writer left, past an hour old", async () => {
    const root = await scratch()
    const space = { modelId: "m", dimension: 4 }
    const path = vectorCachePathFor(root, space)
    await run(
      writeVectorCache({ stored: { space, vectors: new Map([["h", vectorFor(0, 4)]]) }, path })
    )
    const dir = join(root, VECTORS_DIR)
    const old = (Date.now() - STAGING_ABANDONED_MS - 60_000) / 1000
    const seeded = {
      abandoned: "m@4.arrow.1234567890",
      oldName: "m@4.arrow.tmp",
      fresh: "m@4.arrow.987654321",
      otherCache: "other@4.arrow.1234567890"
    }
    for (const [key, name] of Object.entries(seeded)) {
      await writeFile(join(dir, name), "staging bytes")
      if (key !== "fresh") await utimes(join(dir, name), old, old)
    }
    await run(
      writeVectorCache({ stored: { space, vectors: new Map([["h", vectorFor(0, 4)]]) }, path })
    )
    expect((await readdir(dir)).sort()).toEqual(
      ["m@4.arrow", seeded.fresh, seeded.otherCache].sort()
    )
  })
})
