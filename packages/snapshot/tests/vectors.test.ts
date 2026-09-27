import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { StorageFailure } from "@memhtml/contracts"
import { Field, Float32, Schema, Table, tableToIPC, Utf8, vectorFromArray } from "apache-arrow"
import { Effect, Result } from "effect"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import {
  DIMENSION_METADATA_KEY,
  MODEL_ID_METADATA_KEY,
  readVectorCache,
  type StoredVectorSpace,
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
