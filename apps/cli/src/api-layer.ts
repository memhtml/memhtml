import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { StorageFailure } from "@memhtml/contracts/errors"
import {
  DatabaseService,
  type DatabaseShape,
  type EmbedPort,
  Indexer,
  type IndexerShape,
  IndexGit,
  IndexRecorder,
  type IndexRecorderShape,
  MIGRATIONS_DIR,
  makeDatabase,
  makeGitPort,
  makeIndexer,
  makeIndexRecorder,
  makeRetrieval,
  type QueryEmbedPort,
  Retrieval,
  type RetrievalShape,
  STATE_MIGRATIONS_DIR
} from "@memhtml/index"
import {
  EMBED_DIM,
  EMBED_WATERMARK,
  Embeddings,
  EmbeddingsLive,
  type EmbeddingsShape,
  ModelClient,
  ModelClientLive,
  type ModelClientShape
} from "@memhtml/llm"
import {
  Git,
  type GitShape,
  INDEX_DB_PATH,
  makeGit,
  makeStore,
  STATE_DB_PATH,
  Store,
  type StoreShape
} from "@memhtml/store"
import { Config, Context, Effect, Layer } from "effect"

import { MemhtmlRoot, TraceRoot, VectorCoverageFloor } from "./config.js"
import { type EntityExtractorShape, makeEntityExtractor } from "./extraction.js"

/**
 * The service tags, re-exported from the composition root.
 *
 * A handler imports its services from here rather than from six packages, so "which tag does this
 * come from" is answered once. `IndexGit` is the case that needs care. `@memhtml/store` publishes
 * `memhtml/Git` for its `GitShape` and `@memhtml/index` publishes `memhtml/IndexGit` for a different
 * shape, and the two appearing side by side in this list keeps them from being confused.
 */
export { DatabaseService, Indexer, IndexGit, IndexRecorder, Retrieval } from "@memhtml/index"
export { Embeddings, ModelClient } from "@memhtml/llm"
export { Git, Store } from "@memhtml/store"

/**
 * `AppLive`: the one place every service is wired to every other.
 *
 * Built bottom-up with `Layer.provideMerge`, so each level both consumes what is below it and
 * stays visible to what is above. Every command handler and every MCP tool then reads the same
 * tags, which keeps a handler down to decode, call, envelope, with no composition logic
 * of its own to drift from its sibling in the other app.
 *
 * Real dependencies force the order:
 *
 * 1. **Root**: `MEMHTML_ROOT`/`MEMHTML_TRACE_ROOT`, needed to open anything.
 * 2. **Database**: `index.db` with `state.db` ATTACHed. `Indexer` and `Retrieval` both need it,
 *    and so does the recorder the store's dedupe hook calls.
 * 3. **Git**: the store's subprocess wrapper, plus the indexer's own port over it.
 * 4. **Recorder**: `makeIndexRecorder(db)` supplies both the store's `dedupeLookup` and the
 *    session-link writer, which is why the store cannot come before the database.
 * 5. **Store**: over git, with the recorder's hooks attached.
 * 6. **Indexer / Retrieval**: over the database and the git port.
 *
 * The one cycle in the design is broken at step 4. The store needs a SQL lookup to answer "does
 * this content already exist", and `@memhtml/store` is SQL-free by design. The lookup arrives as an
 * injected function, so the arrow still points inward and this file is the only module that knows
 * both halves exist.
 */

/** The resolved roots, as a service so a handler reads the repo path without re-reading config. */
export interface RootsShape {
  /** `MEMHTML_ROOT`, absolute, `~` expanded. */
  readonly memhtmlRoot: string
  /** `MEMHTML_TRACE_ROOT`, absolute. Read-only, so nothing under it is ever written. */
  readonly traceRoot: string
}

export const Roots = Context.Service<RootsShape>("memhtml/Roots")

/**
 * The roots layer. `repoOverride` is `--repo`, and it wins over `MEMHTML_ROOT` so an operator running
 * against a second repo does not have to mutate their environment to do it.
 */
export const layerRoots = (repoOverride?: string | undefined): Layer.Layer<RootsShape> =>
  Layer.effect(Roots)(
    Effect.gen(function* () {
      const fromConfig = yield* MemhtmlRoot
      const traceRoot = yield* TraceRoot
      const memhtmlRoot =
        repoOverride !== undefined && repoOverride.trim() !== "" ? repoOverride.trim() : fromConfig
      return { memhtmlRoot, traceRoot }
    })
  ).pipe(Layer.orDie)

/**
 * The database, rooted in the repo's `.memhtml/`.
 *
 * Both planes on one connection, always. The salience retrieval arm `LEFT JOIN`s `state.access`
 * in the same statement as `main.files`, so a connection without the attachment silently drops
 * that arm. `DatabaseShape.hasState` is what the arm registry consults, and it is `false` only
 * for a caller that deliberately asked for the index alone.
 */
export const layerDatabase: Layer.Layer<DatabaseShape, never, RootsShape> = Layer.effect(
  DatabaseService
)(
  Effect.gen(function* () {
    const roots = yield* Roots
    return yield* makeDatabase(join(roots.memhtmlRoot, INDEX_DB_PATH), MIGRATIONS_DIR, {
      path: join(roots.memhtmlRoot, STATE_DB_PATH),
      migrationsDir: STATE_MIGRATIONS_DIR
    })
  })
).pipe(Layer.orDie)

/** Git over the repo root. The store's shape, under the store's own tag. */
export const layerGit: Layer.Layer<GitShape, never, RootsShape> = Layer.effect(Git)(
  Effect.gen(function* () {
    const roots = yield* Roots
    return makeGit(roots.memhtmlRoot)
  })
)

/**
 * The indexer's git port, over the store's git service.
 *
 * `readFile` is `Effect.tryPromise` rather than `Effect.promise`. `Effect.promise` turns an ENOENT
 * into a defect, and a defect travels past the `Effect.catch` the indexer wraps each projection in.
 * An absent path would then kill the fiber mid-update instead of becoming the counted skip the indexer
 * already handles. An agent listing a path it just archived is the normal case, which makes this
 * the difference between a working `index update` and a crash on an ordinary day.
 */
export const layerIndexGit: Layer.Layer<
  Context.Service.Identifier<typeof IndexGit>,
  never,
  RootsShape | GitShape
> = Layer.effect(IndexGit)(
  Effect.gen(function* () {
    const roots = yield* Roots
    const git = yield* Git
    return makeGitPort({
      git,
      readFile: (path) =>
        Effect.tryPromise({
          try: () => readFile(join(roots.memhtmlRoot, path), "utf8"),
          catch: (cause) => cause
        }),
      fail: (operation) =>
        Effect.fail(StorageFailure.make({ operation: `git.${operation}` })) as never
    })
  })
)

/** The recorder: the dedupe lookup the store gates writes on, and the session-link writer. */
export const layerRecorder: Layer.Layer<IndexRecorderShape, never, DatabaseShape> = Layer.effect(
  IndexRecorder
)(
  Effect.gen(function* () {
    const db = yield* DatabaseService
    return makeIndexRecorder(db)
  })
)

/**
 * The store, with the recorder's dedupe hook attached.
 *
 * `onMove` mirrors `state.access.path` across an archive. Cross-database foreign keys do not
 * exist, so the mirror is an explicit call at the one place a path can change; without it every
 * eviction leaves an orphan access row and the salience arm stops finding the memory it describes.
 */
export const layerStore: Layer.Layer<
  StoreShape,
  never,
  GitShape | IndexRecorderShape | DatabaseShape
> = Layer.effect(Store)(
  Effect.gen(function* () {
    const git = yield* Git
    const recorder = yield* IndexRecorder
    const db = yield* DatabaseService
    return makeStore(git, {
      dedupeLookup: recorder.activePathForHash,
      onMove: (from, to) =>
        db.run("UPDATE state.access SET path = ? WHERE path = ?", [to, from]).pipe(
          // A move whose mirror fails must not fail the move. The archive commit has already
          // landed, and the orphan row is what `memhtml doctor` reports. Losing the commit to a
          // bookkeeping error would be worse than an orphan.
          Effect.catch((error) =>
            Effect.logWarning(`state.access mirror missed ${from} -> ${to}: ${error.operation}`)
          )
        )
    })
  })
)

/**
 * The embeddings ports, or absent.
 *
 * Absent is a supported configuration rather than an error. `index rebuild --no-embed` and every test
 * run without credentials take this path, and retrieval then assembles without the vector arm and
 * reports `degraded: true`. Making the embedder mandatory would turn a Bedrock outage into a dead
 * CLI, which is the failure the lexical floor exists to prevent.
 */
export interface EmbedderShape {
  readonly document: EmbedPort | undefined
  readonly query: QueryEmbedPort | undefined
}

export const Embedder = Context.Service<EmbedderShape>("memhtml/Embedder")

/**
 * Bedrock embeddings when the region resolves, absent when `MEMHTML_EMBED` is `off`.
 *
 * The switch is an explicit opt-out rather than credential sniffing. A missing credential is
 * discovered at call time and degrades one search. A deliberate `off` degrades every search, and
 * an operator reading `memhtml manifest` needs those to be different states.
 */
export const layerEmbedder: Layer.Layer<EmbedderShape, never, EmbeddingsShape> = Layer.effect(
  Embedder
)(
  Effect.gen(function* () {
    const enabled = yield* Config.String("MEMHTML_EMBED").pipe(
      Config.withDefault("on"),
      Config.map((value) => value.trim().toLowerCase() !== "off")
    )
    if (!enabled) return { document: undefined, query: undefined }
    const embeddings = yield* Embeddings
    return { document: embeddings, query: embeddings }
  })
).pipe(Layer.orDie)

/** A layer supplying the embedder ports directly, for a test that wants a deterministic vector. */
export const layerEmbedderFrom = (embedder: EmbedderShape): Layer.Layer<EmbedderShape> =>
  Layer.succeed(Embedder)(embedder)

/** The indexer, over the database and the git port. */
export const layerIndexer: Layer.Layer<
  IndexerShape,
  never,
  DatabaseShape | Context.Service.Identifier<typeof IndexGit> | EmbedderShape
> = Layer.effect(Indexer)(
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const git = yield* IndexGit
    const embedder = yield* Embedder
    return makeIndexer({
      db,
      git,
      embedWatermark: EMBED_WATERMARK,
      embedDim: EMBED_DIM,
      embeddings: embedder.document,
      // Wall-clock through the Effect clock would need an Effect here; the indexer wants a plain
      // thunk for `indexed_at`. A test that must pin the instant builds the indexer directly.
      now: () => new Date().toISOString()
    })
  })
)

/**
 * The retrieval policy: the one retrieval tunable the environment sets.
 *
 * A service rather than a constant read at each site, because two surfaces judge the same ratio
 * against it: `search`/`recall` drop the vector arm below it and `doctor` reports `vectorCoverageLow`
 * below it. One resolution of `MEMHTML_VECTOR_COVERAGE_FLOOR` is what keeps a search that degraded and
 * a doctor that says healthy from being the same store read through two floors.
 */
export interface RetrievalPolicyShape {
  /** `MEMHTML_VECTOR_COVERAGE_FLOOR`, in `(0, 1]`. */
  readonly vectorCoverageFloor: number
}

export const RetrievalPolicy = Context.Service<RetrievalPolicyShape>("memhtml/RetrievalPolicy")

/**
 * The policy from config. A set-but-unusable value DIES naming the variable: `0` or a negative would
 * switch the gate off silently (nothing is below zero), a value above `1` would drop the vector arm on
 * a fully covered index, and neither is a floor anyone meant. A value that does not parse as a number
 * already fails inside `Config.Number`.
 */
export const layerRetrievalPolicy: Layer.Layer<RetrievalPolicyShape> = Layer.effect(
  RetrievalPolicy
)(
  Effect.gen(function* () {
    const floor = yield* VectorCoverageFloor
    if (!Number.isFinite(floor) || floor <= 0 || floor > 1) {
      return yield* Effect.die(
        new Error(`MEMHTML_VECTOR_COVERAGE_FLOOR must be a number in (0, 1]; got ${String(floor)}`)
      )
    }
    return { vectorCoverageFloor: floor }
  })
).pipe(Layer.orDie)

/** A layer supplying the policy directly, for a test that moves the floor. */
export const layerRetrievalPolicyFrom = (
  vectorCoverageFloor: number
): Layer.Layer<RetrievalPolicyShape> => Layer.succeed(RetrievalPolicy)({ vectorCoverageFloor })

/**
 * Retrieval, over the database, the query embedder, and the policy.
 *
 * `embedWatermark` is the configured space, so coverage counts only the vectors a query vector from
 * this embedder is comparable with. It is the same constant the indexer writes under, passed from the
 * same place, which is what keeps the two from disagreeing about which space is "configured".
 */
export const layerRetrieval: Layer.Layer<
  RetrievalShape,
  never,
  DatabaseShape | EmbedderShape | RetrievalPolicyShape
> = Layer.effect(Retrieval)(
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const embedder = yield* Embedder
    const policy = yield* RetrievalPolicy
    return makeRetrieval({
      db,
      embeddings: embedder.query,
      embedWatermark: EMBED_WATERMARK,
      vectorCoverageFloor: policy.vectorCoverageFloor
    })
  })
)

/**
 * Write-time entity extraction, or absent.
 *
 * On by default since 2026-09-02, like the embedder: `MEMHTML_EXTRACT_ENTITIES=off` removes it, and so
 * does `MEMHTML_LLM=off`, because an operator who turned the models off did not mean "except the
 * one in the write path" — and that switch is what keeps the credential-free tiers (`check`, the
 * non-live smoke) from placing a live call now that the default is on. Extraction changes what a
 * write STORES rather than what a search finds, so a store run with it on for a month and then off
 * holds two populations of files; the docs say so where the variable is described. The failure mode
 * follows the embedder precedent: a bound extractor that fails costs this batch its extracted
 * entities and never the write (`batchWrite` logs and proceeds).
 *
 * The extractor is a consumer of `ModelClient`, InvokeModel on bedrock-runtime or the LLM proxy
 * `MEMHTML_LLM_BASE_URL` names, so there is one answer to where every model call goes and one
 * credential story: the SDK's default chain, or the proxy's key. A
 * missing credential is discovered at the first write batch and degrades that batch, as a missing
 * embedder credential degrades a search; nothing is checked at layer build.
 */
export interface ExtractorPortShape {
  readonly extractor: EntityExtractorShape | undefined
}

export const ExtractorPort = Context.Service<ExtractorPortShape>("memhtml/ExtractorPort")

export const layerExtractorPort: Layer.Layer<ExtractorPortShape, never, ModelClientShape> =
  Layer.effect(ExtractorPort)(
    Effect.gen(function* () {
      const enabled = yield* Config.String("MEMHTML_EXTRACT_ENTITIES").pipe(
        Config.withDefault("on"),
        Config.map((value) => value.trim().toLowerCase() !== "off")
      )
      const modelsOn = yield* Config.String("MEMHTML_LLM").pipe(
        Config.withDefault("on"),
        Config.map((value) => value.trim().toLowerCase() !== "off")
      )
      if (!enabled || !modelsOn) return { extractor: undefined }
      return { extractor: makeEntityExtractor(yield* ModelClient) }
    })
  ).pipe(Layer.orDie)

/** A layer supplying the extractor directly, for a test that scripts the extraction answers. */
export const layerExtractorFrom = (
  extractor: EntityExtractorShape | undefined
): Layer.Layer<ExtractorPortShape> => Layer.succeed(ExtractorPort)({ extractor })

/**
 * Everything above the embedder, as one layer requiring only the roots and it.
 *
 * Written top-down because that is what `Layer.provideMerge(that)` means. It feeds `that`'s output
 * into `self`'s requirements, so the consumer is `self` and each `.pipe` step below adds the level
 * beneath it. Chaining in dependency order instead, with the database first, reads naturally and is
 * wrong. It would provide git to the database and leave `GitShape` in the final requirement set, which
 * typechecks as an unsatisfied layer rather than failing where the mistake is.
 *
 * Split out from `layerApp` so a test provides a deterministic embedder and a real temp repo with
 * no Bedrock anywhere in the graph. The composition under test is then the same composition
 * production runs, which a hand-assembled test wiring would not be.
 */
export const layerCore = layerRetrieval.pipe(
  Layer.provideMerge(Layer.mergeAll(layerIndexer, layerStore)),
  Layer.provideMerge(Layer.mergeAll(layerIndexGit, layerRecorder)),
  Layer.provideMerge(Layer.mergeAll(layerDatabase, layerGit))
)

/**
 * The production graph: roots from config, Bedrock (or the LLM proxy) behind the embedder and the
 * extractor, everything else over them. `repoOverride` is `--repo`.
 *
 * This is the one composition production runs. `memhtml serve mcp` runs the same one in a child
 * process, so an MCP tool and its CLI twin cannot be looking at different databases.
 */
export const layerApp = (repoOverride?: string | undefined) =>
  layerCore.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerRoots(repoOverride),
        layerEmbedder.pipe(Layer.provide(EmbeddingsLive), Layer.orDie),
        layerExtractorPort.pipe(Layer.provide(ModelClientLive), Layer.orDie),
        layerRetrievalPolicy
      )
    )
  )

/**
 * The graph a test provides: the real composition, with the embedder and the extractor injected.
 *
 * Same `layerCore`, so a test exercises the wiring production uses rather than a parallel one. The
 * only substituted edges are the ones that reach the network.
 */
export const layerAppWith = (options: {
  readonly repo: string
  readonly embedder: EmbedderShape
  /** Absent leaves writes unextracted, the production default. Only extraction tests bind one. */
  readonly extractor?: EntityExtractorShape | undefined
  /**
   * Absent reads `MEMHTML_VECTOR_COVERAGE_FLOOR` the way production does, which in a credential-free
   * test environment is the default. A test that moves the floor names it here.
   */
  readonly vectorCoverageFloor?: number | undefined
}) =>
  layerCore.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerRoots(options.repo),
        layerEmbedderFrom(options.embedder),
        layerExtractorFrom(options.extractor),
        options.vectorCoverageFloor === undefined
          ? layerRetrievalPolicy
          : layerRetrievalPolicyFrom(options.vectorCoverageFloor)
      )
    )
  )
