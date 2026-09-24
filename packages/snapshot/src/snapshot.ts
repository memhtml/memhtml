/**
 * The columnar cold-start cache: one Arrow IPC file per commit, one row per `MemoryRecord`.
 *
 * The file format (not the stream format) is used so a reader can seek to the footer and open
 * the table without scanning, and `tableFromIPC` over a Node `Buffer` keeps every value buffer
 * as a view into that Buffer: no column is copied until a cell is read. The commit sha the rows
 * were built from lives in the schema metadata under `SHA_METADATA_KEY`.
 *
 * The schema is declared once in `FIELDS`; the writer and the reader both walk that list, and the
 * reader refuses a file whose schema differs from it, so a stale or foreign `.arrow` file becomes a
 * `StorageFailure` rather than a table of undefined cells.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  type MemoryRecord,
  type RecordFacet,
  type RecordLink,
  StorageFailure
} from "@memhtml/contracts"
import {
  Bool,
  Field,
  Float64,
  List,
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Table,
  tableFromIPC,
  tableToIPC,
  Utf8,
  type Vector,
  vectorFromArray
} from "apache-arrow"
import { compareSchemas } from "apache-arrow/visitor/typecomparator"
import { Effect } from "effect"

/** Schema metadata key holding the commit sha the snapshot was built from. */
export const SHA_METADATA_KEY = "sha"

type LinkColumns = { rel: Utf8; href: Utf8 }
type FacetColumns = { name: Utf8; value: Utf8 }

/** Column types, in the order the file stores them. */
export type SnapshotColumns = {
  path: Utf8
  blobSha: Utf8
  contentHash: Utf8
  frameKey: Utf8
  title: Utf8
  memoryType: Utf8
  status: Utf8
  claim: Utf8
  createdAt: Utf8
  updatedAt: Utf8
  eventAt: Utf8
  confidence: Float64
  importance: Float64
  tags: List<Utf8>
  entities: List<Utf8>
  links: List<Struct<LinkColumns>>
  facets: List<Struct<FacetColumns>>
  bodyText: Utf8
  html: Utf8
  archived: Bool
}

type ColumnName = keyof SnapshotColumns

const text = () => new Utf8()
const textList = () => new List(new Field("item", text(), false))
const pair = (first: string, second: string) =>
  new List(
    new Field(
      "item",
      new Struct([new Field(first, text(), false), new Field(second, text(), false)]),
      false
    )
  )
const linkList = (): List<Struct<LinkColumns>> => pair("rel", "href")
const facetList = (): List<Struct<FacetColumns>> => pair("name", "value")

/** Column types, keyed by name, so every column's `Vector` type is exact on both sides. */
const COLUMN_TYPES: { readonly [K in ColumnName]: SnapshotColumns[K] } = {
  path: text(),
  blobSha: text(),
  contentHash: text(),
  frameKey: text(),
  title: text(),
  memoryType: text(),
  status: text(),
  claim: text(),
  createdAt: text(),
  updatedAt: text(),
  eventAt: text(),
  confidence: new Float64(),
  importance: new Float64(),
  tags: textList(),
  entities: textList(),
  links: linkList(),
  facets: facetList(),
  bodyText: text(),
  html: text(),
  archived: new Bool()
}

/** Storage order of the columns; the reader rejects any other order. */
const COLUMN_ORDER: ReadonlyArray<ColumnName> = [
  "path",
  "blobSha",
  "contentHash",
  "frameKey",
  "title",
  "memoryType",
  "status",
  "claim",
  "createdAt",
  "updatedAt",
  "eventAt",
  "confidence",
  "importance",
  "tags",
  "entities",
  "links",
  "facets",
  "bodyText",
  "html",
  "archived"
]

/** Nullable only where `MemoryRecord` allows null. */
const NULLABLE: ReadonlySet<ColumnName> = new Set<ColumnName>([
  "frameKey",
  "eventAt",
  "confidence",
  "importance"
])

/** The one declaration of the file's shape, derived from the three tables above. */
const FIELDS: ReadonlyArray<Field<SnapshotColumns[ColumnName]>> = COLUMN_ORDER.map(
  (name) => new Field(name, COLUMN_TYPES[name], NULLABLE.has(name))
)

/** The schema without metadata, for shape comparison on read. */
const SHAPE: Schema<SnapshotColumns> = new Schema([...FIELDS])

/** The directory every snapshot lives under, relative to the repo root. */
export const SNAPSHOTS_DIR = ".memhtml/snapshots"

/** `.memhtml/snapshots/<sha>.arrow` under `root`. */
export const snapshotPathFor = (root: string, sha: string): string =>
  join(root, SNAPSHOTS_DIR, `${sha}.arrow`)

type Columns = { [K in ColumnName]: Vector<SnapshotColumns[K]> }

/** One Arrow vector per column, built through the library's builders (`vectorFromArray`). */
const columnsOf = (records: ReadonlyArray<MemoryRecord>): Columns => ({
  path: vectorFromArray(
    records.map((record) => record.path),
    COLUMN_TYPES.path
  ),
  blobSha: vectorFromArray(
    records.map((record) => record.blobSha),
    COLUMN_TYPES.blobSha
  ),
  contentHash: vectorFromArray(
    records.map((record) => record.contentHash),
    COLUMN_TYPES.contentHash
  ),
  frameKey: vectorFromArray(
    records.map((record) => record.frameKey),
    COLUMN_TYPES.frameKey
  ),
  title: vectorFromArray(
    records.map((record) => record.title),
    COLUMN_TYPES.title
  ),
  memoryType: vectorFromArray(
    records.map((record) => record.memoryType),
    COLUMN_TYPES.memoryType
  ),
  status: vectorFromArray(
    records.map((record) => record.status),
    COLUMN_TYPES.status
  ),
  claim: vectorFromArray(
    records.map((record) => record.claim),
    COLUMN_TYPES.claim
  ),
  createdAt: vectorFromArray(
    records.map((record) => record.createdAt),
    COLUMN_TYPES.createdAt
  ),
  updatedAt: vectorFromArray(
    records.map((record) => record.updatedAt),
    COLUMN_TYPES.updatedAt
  ),
  eventAt: vectorFromArray(
    records.map((record) => record.eventAt),
    COLUMN_TYPES.eventAt
  ),
  confidence: vectorFromArray(
    records.map((record) => record.confidence),
    COLUMN_TYPES.confidence
  ),
  importance: vectorFromArray(
    records.map((record) => record.importance),
    COLUMN_TYPES.importance
  ),
  tags: vectorFromArray(
    records.map((record) => record.tags),
    COLUMN_TYPES.tags
  ),
  entities: vectorFromArray(
    records.map((record) => record.entities),
    COLUMN_TYPES.entities
  ),
  links: vectorFromArray(
    records.map((record) => record.links),
    COLUMN_TYPES.links
  ),
  facets: vectorFromArray(
    records.map((record) => record.facets),
    COLUMN_TYPES.facets
  ),
  bodyText: vectorFromArray(
    records.map((record) => record.bodyText),
    COLUMN_TYPES.bodyText
  ),
  html: vectorFromArray(
    records.map((record) => record.html),
    COLUMN_TYPES.html
  ),
  archived: vectorFromArray(
    records.map((record) => record.archived),
    COLUMN_TYPES.archived
  )
})

/**
 * Assemble the table under the declared schema. The builders mark every field nullable, and the
 * `Table` constructor rejects a schema whose nullability differs from its batches, so the batches
 * are rebuilt over the declared `Struct` with the builders' data as children.
 */
const tableOf = (records: ReadonlyArray<MemoryRecord>, sha: string): Table<SnapshotColumns> => {
  const schema = new Schema<SnapshotColumns>([...FIELDS], new Map([[SHA_METADATA_KEY, sha]]))
  const columns = columnsOf(records)
  const built = new Table<SnapshotColumns>(columns)
  const batches = built.batches.map(
    (batch) =>
      new RecordBatch(
        schema,
        makeData({
          type: new Struct<SnapshotColumns>([...FIELDS]),
          length: batch.numRows,
          nullCount: 0,
          children: batch.data.children
        })
      )
  )
  return new Table(schema, batches)
}

/** Wrap a filesystem call as a typed failure, logging the cause for an operator. */
const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`snapshot.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation: `snapshot.${operation}` }))
  )

/** Wrap a synchronous library call the same way. */
const attempt = <A>(operation: string, thunk: () => A): Effect.Effect<A, StorageFailure> =>
  Effect.try({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`snapshot.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation: `snapshot.${operation}` }))
  )

/**
 * Write every record as one row of an Arrow IPC file at `path`, creating parent directories.
 * The bytes land in a sibling temp file first and are renamed into place, so a reader never sees
 * a half-written snapshot.
 */
export const writeSnapshot = (input: {
  records: Iterable<MemoryRecord>
  sha: string
  path: string
}): Effect.Effect<{ bytes: number; rows: number }, StorageFailure> =>
  Effect.gen(function* () {
    const records = Array.from(input.records)
    const bytes = yield* attempt("write.encode", () =>
      tableToIPC(tableOf(records, input.sha), "file")
    )
    yield* attemptIo("write.mkdir", () => mkdir(dirname(input.path), { recursive: true }))
    const staging = `${input.path}.tmp`
    yield* attemptIo("write.file", () => writeFile(staging, bytes))
    yield* attemptIo("write.rename", () => rename(staging, input.path))
    return { bytes: bytes.byteLength, rows: records.length }
  })

const required = <A>(value: A | null | undefined, column: ColumnName, row: number): A => {
  if (value === null || value === undefined) {
    throw new Error(`snapshot: null in non-nullable column ${column} at row ${row}`)
  }
  return value
}

const textsOf = (
  cells: Vector<Utf8> | null,
  column: ColumnName,
  row: number
): ReadonlyArray<string> =>
  Array.from(required(cells, column, row), (cell) => required(cell, column, row))

const linksOf = (
  cells: Vector<Struct<LinkColumns>> | null,
  row: number
): ReadonlyArray<RecordLink> =>
  Array.from(required(cells, "links", row), (cell) => {
    const link = required(cell, "links", row)
    return { rel: required(link.rel, "links", row), href: required(link.href, "links", row) }
  })

const facetsOf = (
  cells: Vector<Struct<FacetColumns>> | null,
  row: number
): ReadonlyArray<RecordFacet> =>
  Array.from(required(cells, "facets", row), (cell) => {
    const facet = required(cell, "facets", row)
    return {
      name: required(facet.name, "facets", row),
      value: required(facet.value, "facets", row)
    }
  })

/** Resolve every declared column; the schema check ran first, so a null here is a defect. */
const columnsOfTable = (table: Table<SnapshotColumns>): Columns => {
  const pick = <K extends ColumnName>(name: K): Vector<SnapshotColumns[K]> => {
    const column = table.getChild(name)
    if (column === null) throw new Error(`snapshot: missing column ${name}`)
    return column
  }
  return {
    path: pick("path"),
    blobSha: pick("blobSha"),
    contentHash: pick("contentHash"),
    frameKey: pick("frameKey"),
    title: pick("title"),
    memoryType: pick("memoryType"),
    status: pick("status"),
    claim: pick("claim"),
    createdAt: pick("createdAt"),
    updatedAt: pick("updatedAt"),
    eventAt: pick("eventAt"),
    confidence: pick("confidence"),
    importance: pick("importance"),
    tags: pick("tags"),
    entities: pick("entities"),
    links: pick("links"),
    facets: pick("facets"),
    bodyText: pick("bodyText"),
    html: pick("html"),
    archived: pick("archived")
  }
}

const recordAt = (columns: Columns, row: number): MemoryRecord => ({
  path: required(columns.path.get(row), "path", row),
  blobSha: required(columns.blobSha.get(row), "blobSha", row),
  contentHash: required(columns.contentHash.get(row), "contentHash", row),
  frameKey: columns.frameKey.get(row),
  title: required(columns.title.get(row), "title", row),
  memoryType: required(columns.memoryType.get(row), "memoryType", row),
  status: required(columns.status.get(row), "status", row),
  claim: required(columns.claim.get(row), "claim", row),
  createdAt: required(columns.createdAt.get(row), "createdAt", row),
  updatedAt: required(columns.updatedAt.get(row), "updatedAt", row),
  eventAt: columns.eventAt.get(row),
  confidence: columns.confidence.get(row),
  importance: columns.importance.get(row),
  tags: textsOf(columns.tags.get(row), "tags", row),
  entities: textsOf(columns.entities.get(row), "entities", row),
  links: linksOf(columns.links.get(row), row),
  facets: facetsOf(columns.facets.get(row), row),
  bodyText: required(columns.bodyText.get(row), "bodyText", row),
  html: required(columns.html.get(row), "html", row),
  archived: required(columns.archived.get(row), "archived", row)
})

/**
 * Open the snapshot at `path` and materialize every row. Three refusals, each a `StorageFailure`
 * whose `operation` names the step: `snapshot.read.file` (unreadable path), `snapshot.read.decode`
 * (not an Arrow IPC file, or truncated), `snapshot.read.sha` (no sha in the schema metadata), and
 * `snapshot.read.schema` (columns differ from `FIELDS` by name, type, nullability, or order).
 */
export const readSnapshot = (
  path: string
): Effect.Effect<{ sha: string; records: ReadonlyArray<MemoryRecord> }, StorageFailure> =>
  Effect.gen(function* () {
    const buffer = yield* attemptIo("read.file", () => readFile(path))
    const table = yield* attempt("read.decode", () => tableFromIPC<SnapshotColumns>(buffer))
    const sha = table.schema.metadata.get(SHA_METADATA_KEY)
    if (sha === undefined) {
      return yield* Effect.fail(StorageFailure.make({ operation: "snapshot.read.sha" }))
    }
    // Read schema first: the reader rebuilds numeric types as their base class (`Float`, not
    // `Float64`) and the comparator asks `other instanceof type.constructor`, which only holds
    // with the declared subclass on the right.
    if (!compareSchemas(table.schema, SHAPE)) {
      return yield* Effect.fail(StorageFailure.make({ operation: "snapshot.read.schema" }))
    }
    const records = yield* attempt("read.rows", () => {
      const columns = columnsOfTable(table)
      return Array.from({ length: table.numRows }, (_, row) => recordAt(columns, row))
    })
    return { sha, records }
  })
