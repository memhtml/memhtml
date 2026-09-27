/**
 * The vector cache: one Arrow IPC file per vector space (an embedder's model id at one dimension),
 * one row per content hash, the vector as a fixed-size `Float32` list.
 *
 * It is a cache, never content: every row is rebuildable by embedding the article its content hash
 * names, so the directory is ignored by git and deleting it costs one `memhtml head embed`. The
 * space lives in the schema metadata as well as in the filename, and the reader refuses a file
 * whose metadata names another space, because two model ids can sanitize to one filename and a
 * vector from another space compares as a number with no meaning.
 *
 * The vector column is one contiguous `Float32Array` per record batch in the file, and the reader
 * hands out a `subarray` view per row over the `Buffer` it read, so opening 8,000 vectors copies no
 * float. The writer builds that one array and the column over it with `makeData` rather than a
 * builder, which would box eight million numbers on the way in.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { StorageFailure } from "@memhtml/contracts"
import {
  Field,
  FixedSizeList,
  Float32,
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Table,
  tableFromIPC,
  tableToIPC,
  Utf8,
  vectorFromArray
} from "apache-arrow"
import { compareSchemas } from "apache-arrow/visitor/typecomparator"
import { Effect } from "effect"

/** Schema metadata key holding the embedder's model id. */
export const MODEL_ID_METADATA_KEY = "modelId"

/** Schema metadata key holding the vector width, as a decimal string. */
export const DIMENSION_METADATA_KEY = "dimension"

/** The directory every vector cache lives under, relative to the repo root. */
export const VECTORS_DIR = ".memhtml/vectors"

/** One vector space: vectors from two different spaces are incomparable. */
export interface StoredVectorSpace {
  readonly modelId: string
  readonly dimension: number
}

/** A cache's contents: vectors of one space, by content hash. */
export interface StoredVectors {
  readonly space: StoredVectorSpace
  readonly vectors: ReadonlyMap<string, Float32Array>
}

/**
 * `.memhtml/vectors/<model id>@<dimension>.arrow` under `root`, with every character of the model id
 * outside `[A-Za-z0-9._-]` replaced by `_` (`cohere.embed-v4:0` becomes `cohere.embed-v4_0`), so the
 * name is one portable path segment.
 */
export const vectorCachePathFor = (root: string, space: StoredVectorSpace): string =>
  join(
    root,
    VECTORS_DIR,
    `${space.modelId.replace(/[^A-Za-z0-9._-]/g, "_")}@${String(space.dimension)}.arrow`
  )

const vectorType = (dimension: number): FixedSizeList<Float32> =>
  new FixedSizeList(dimension, new Field("item", new Float32(), false))

const fieldsFor = (dimension: number) => [
  new Field("contentHash", new Utf8(), false),
  new Field("vector", vectorType(dimension), false)
]

type VectorColumns = { contentHash: Utf8; vector: FixedSizeList<Float32> }

const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`vectors.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation: `vectors.${operation}` }))
  )

const attempt = <A>(operation: string, thunk: () => A): Effect.Effect<A, StorageFailure> =>
  Effect.try({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`vectors.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation: `vectors.${operation}` }))
  )

/** The table for `stored`, one batch, with the space in the schema metadata. */
const tableOf = (stored: StoredVectors): Table<VectorColumns> => {
  const { dimension } = stored.space
  const fields = fieldsFor(dimension)
  const schema = new Schema<VectorColumns>(
    fields,
    new Map([
      [MODEL_ID_METADATA_KEY, stored.space.modelId],
      [DIMENSION_METADATA_KEY, String(dimension)]
    ])
  )
  const hashes = [...stored.vectors.keys()]
  const flat = new Float32Array(hashes.length * dimension)
  for (const [row, hash] of hashes.entries()) {
    const vector = stored.vectors.get(hash)
    if (vector === undefined || vector.length !== dimension) {
      throw new Error(`vector for ${hash} has ${vector?.length ?? 0} dimensions, not ${dimension}`)
    }
    flat.set(vector, row * dimension)
  }
  const hashData = vectorFromArray(hashes, new Utf8()).data[0]
  if (hashData === undefined) throw new Error("the content hash column built no data")
  const vectorData = makeData({
    type: vectorType(dimension),
    length: hashes.length,
    nullCount: 0,
    child: makeData({ type: new Float32(), length: flat.length, nullCount: 0, data: flat })
  })
  const batch = new RecordBatch(
    schema,
    makeData({
      type: new Struct<VectorColumns>(fields),
      length: hashes.length,
      nullCount: 0,
      children: [hashData, vectorData]
    })
  )
  return new Table(schema, [batch])
}

/**
 * Write `stored` as one Arrow IPC file at `path`, creating parent directories. The bytes land in a
 * sibling temp file and are renamed into place, so a reader never sees half a cache. A vector whose
 * width differs from the space's dimension is refused (`vectors.write.encode`), since writing it
 * would store a row the reader's schema cannot describe.
 */
export const writeVectorCache = (input: {
  readonly stored: StoredVectors
  readonly path: string
}): Effect.Effect<{ readonly bytes: number; readonly rows: number }, StorageFailure> =>
  Effect.gen(function* () {
    const bytes = yield* attempt("write.encode", () => tableToIPC(tableOf(input.stored), "file"))
    yield* attemptIo("write.mkdir", () => mkdir(dirname(input.path), { recursive: true }))
    const staging = `${input.path}.tmp`
    yield* attemptIo("write.file", () => writeFile(staging, bytes))
    yield* attemptIo("write.rename", () => rename(staging, input.path))
    return { bytes: bytes.byteLength, rows: input.stored.vectors.size }
  })

/** A cache read from disk, with the file's size. */
export interface ReadVectors extends StoredVectors {
  readonly bytes: number
}

/**
 * Open the cache at `path` for `space`. A missing file is `null`, the answer for a store nobody has
 * embedded yet. Every other refusal is a `StorageFailure` whose `operation` names the step:
 * `vectors.read.file` (unreadable), `vectors.read.decode` (not an Arrow IPC file, or truncated),
 * `vectors.read.space` (the metadata names another model id or dimension, or none), and
 * `vectors.read.schema` (columns differ from the declared two by name, type, width, nullability,
 * or order).
 */
export const readVectorCache = (
  path: string,
  space: StoredVectorSpace
): Effect.Effect<ReadVectors | null, StorageFailure> =>
  Effect.gen(function* () {
    const buffer = yield* attemptIo("read.file", () =>
      readFile(path).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null
        throw cause
      })
    )
    if (buffer === null) return null
    const table = yield* attempt("read.decode", () => tableFromIPC<VectorColumns>(buffer))
    const metadata = table.schema.metadata
    if (
      metadata.get(MODEL_ID_METADATA_KEY) !== space.modelId ||
      metadata.get(DIMENSION_METADATA_KEY) !== String(space.dimension)
    ) {
      return yield* Effect.fail(StorageFailure.make({ operation: "vectors.read.space" }))
    }
    if (!compareSchemas(table.schema, new Schema(fieldsFor(space.dimension)))) {
      return yield* Effect.fail(StorageFailure.make({ operation: "vectors.read.schema" }))
    }
    const vectors = yield* attempt("read.rows", () => {
      const hashes = table.getChild("contentHash")
      const column = table.getChild("vector")
      if (hashes === null || column === null) throw new Error("a declared column is missing")
      const out = new Map<string, Float32Array>()
      for (let row = 0; row < table.numRows; row += 1) {
        const hash = hashes.get(row)
        const cell = column.get(row)
        if (hash === null || cell === null) throw new Error(`null in row ${row}`)
        // `toArray` on one cell of a single-chunk column is a `subarray` of the file's buffer.
        out.set(hash, cell.toArray())
      }
      return out
    })
    return { space, vectors, bytes: buffer.byteLength }
  })
