import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  type ConsolidatorShape,
  hasConsolidatorCredentials,
  makeConsolidator
} from "@memhtml/consolidator"
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
import { makeSleep, Sleep, type SleepShape } from "@memhtml/sleep"
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

import { MemhtmlRoot, TraceRoot } from "./config.js"
import {
  type EntityExtractorShape,
  EXTRACTION_MODEL_ID,
  fetchMantleTransport,
  makeEntityExtractor
} from "./extraction.js"

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
export { Sleep } from "@memhtml/sleep"
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
    const enabled = yield* Config.string("MEMHTML_EMBED").pipe(
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

/** Retrieval, over the database and the query embedder. */
export const layerRetrieval: Layer.Layer<RetrievalShape, never, DatabaseShape | EmbedderShape> =
  Layer.effect(Retrieval)(
    Effect.gen(function* () {
      const db = yield* DatabaseService
      const embedder = yield* Embedder
      return makeRetrieval({ db, embeddings: embedder.query })
    })
  )

/**
 * The model behind the four LLM sleep phases, or absent.
 *
 * Absent is a run whose LLM phases report `skipped`, which `@memhtml/sleep` distinguishes from
 * `failed`, because a deterministic run on a fixture without credentials is not a broken run.
 */
export interface ModelPortShape {
  readonly model: ModelClientShape | undefined
}

export const ModelPort = Context.Service<ModelPortShape>("memhtml/ModelPort")

export const layerModelPort: Layer.Layer<ModelPortShape, never, ModelClientShape> = Layer.effect(
  ModelPort
)(
  Effect.gen(function* () {
    const enabled = yield* Config.string("MEMHTML_LLM").pipe(
      Config.withDefault("on"),
      Config.map((value) => value.trim().toLowerCase() !== "off")
    )
    if (!enabled) return { model: undefined }
    return { model: yield* ModelClient }
  })
).pipe(Layer.orDie)

/** A layer supplying the model port directly, for a test that scripts the model's answers. */
export const layerModelFrom = (model: ModelClientShape | undefined): Layer.Layer<ModelPortShape> =>
  Layer.succeed(ModelPort)({ model })

/**
 * Write-time entity extraction, or absent. Absent is the default.
 *
 * Opt-in (`MEMHTML_EXTRACT_ENTITIES=on`) where the embedder is opt-out, and the asymmetry is
 * deliberate. The write path has never carried a generative call, extraction changes what a write
 * stores rather than what a search finds, and a default-on model call in every agent's write path
 * is a behavior change an operator must choose. The failure mode does follow the embedder
 * precedent: a bound extractor that fails costs this batch its extracted entities and never the
 * write (`batchWrite` logs and proceeds).
 *
 * The transport is a bearer-token fetch against the Bedrock mantle endpoint rather than a fourth lane
 * in `@memhtml/llm`. GPT-5.6 Luna is mantle-only (no InvokeModel, no Converse), and that package holds
 * one vendor and one call shape by design. The bearer token is the same
 * `AWS_BEARER_TOKEN_BEDROCK` the SDK chain reads. An absent token with the flag on is a configuration
 * the operator asked for and cannot have, so it degrades per batch with a logged warning rather
 * than failing at layer build, matching how a missing embedder credential degrades a search.
 */
export interface ExtractorPortShape {
  readonly extractor: EntityExtractorShape | undefined
}

export const ExtractorPort = Context.Service<ExtractorPortShape>("memhtml/ExtractorPort")

export const layerExtractorPort: Layer.Layer<ExtractorPortShape> = Layer.effect(ExtractorPort)(
  Effect.gen(function* () {
    const enabled = yield* Config.string("MEMHTML_EXTRACT_ENTITIES").pipe(
      Config.withDefault("off"),
      Config.map((value) => value.trim().toLowerCase() === "on")
    )
    if (!enabled) return { extractor: undefined }
    const region = yield* Config.string("MEMHTML_AWS_REGION").pipe(Config.withDefault("us-east-1"))
    const token = yield* Config.string("AWS_BEARER_TOKEN_BEDROCK").pipe(Config.withDefault(""))
    if (token === "") {
      yield* Effect.logWarning(
        "MEMHTML_EXTRACT_ENTITIES=on but AWS_BEARER_TOKEN_BEDROCK is absent; writes proceed unextracted"
      )
      return { extractor: undefined }
    }
    return {
      extractor: makeEntityExtractor(fetchMantleTransport(region, token), EXTRACTION_MODEL_ID)
    }
  })
).pipe(Layer.orDie)

/** A layer supplying the extractor directly, for a test that scripts the extraction answers. */
export const layerExtractorFrom = (
  extractor: EntityExtractorShape | undefined
): Layer.Layer<ExtractorPortShape> => Layer.succeed(ExtractorPort)({ extractor })

/**
 * The consolidator behind trace consolidation, or absent.
 *
 * **This file is the only place that knows both halves exist**, which is why it is
 * here rather than in `@memhtml/sleep`. `apps/consolidator` is an eve agent over the AI SDK Bedrock
 * provider with a `just-bash` sandbox. Sleep declares the shape it consumes
 * (`packages/sleep/src/consolidator.ts`) and never imports any of that. The assignment below needs no
 * adapter and no cast, because TypeScript is structural and `ConsolidatorShape` satisfies
 * `ConsolidatorPort` field for field.
 *
 * **There is no host option, by construction.** The consolidator's eve channel now demands a bearer
 * JWT signed with a per-run secret (`apps/consolidator/agent/channels/eve.ts` via `jwtHmac`), so the
 * bind address is no longer the only thing keeping the agent off the network. It is still not optional,
 * because two layers are only depth while both are in place. `makeConsolidator` exposes no `host`
 * option at all and pins loopback itself (`apps/consolidator/src/client.ts`, `LOOPBACK_HOST`). Nothing
 * here may reintroduce one, and the absence of an option is the mechanism.
 */
export interface ConsolidatorPortShape {
  readonly consolidator: ConsolidatorShape | undefined
}

export const ConsolidatorPortService = Context.Service<ConsolidatorPortShape>(
  "memhtml/ConsolidatorPort"
)

/**
 * Two gates, both cheap, both before anything is spawned.
 *
 * `MEMHTML_LLM=off` is the same explicit opt-out `layerModelPort` reads, and it covers the consolidator
 * too, because an operator who turned the models off did not mean "except the expensive agent".
 *
 * `hasConsolidatorCredentials` is the credential preflight, read here as well as inside the client.
 * The redundancy is deliberate and the two reads do different jobs. This one decides whether the phase
 * sees a consolidator at all, so a credential-free environment gets `detail: "no consolidator bound"`,
 * the same shape the other three LLM phases report with no model, rather than a bound port that
 * fails on every call and reports a degradation. CI has no credentials and must read as skipped rather
 * than degraded.
 *
 * The check cannot be skipped in favor of the client's own, because the provider is lazy.
 * `createAmazonBedrock` and `provider(modelId)` both succeed with zero credentials and nothing fails
 * until the first request (verified in T-EVE-1's probe, recorded at
 * `apps/consolidator/src/contract.ts:301-319`).
 *
 * **`env` is a parameter, and it has to be.** `Config` reads its values through a `ConfigProvider`,
 * which a test substitutes, while `hasConsolidatorCredentials` reads `process.env` directly, and
 * effect's default provider snapshots `process.env` at module load (probed 2026-08-08: mutating
 * `process.env.MEMHTML_LLM` after importing `effect` changes nothing `Config.string` returns). A test
 * that set both by mutation would read a stale snapshot for one gate and a live object for the other,
 * and the two gates would disagree about which environment they are in. Threading the credential
 * environment through as an argument makes both injectable from one call. See
 * `apps/cli/tests/consolidator-wiring.test.ts`, where that disagreement produced a false defect
 * before this parameter existed.
 *
 * **It now requires `RootsShape`, for `traceRoot`.** That is how transcripts reach the agent. The
 * consolidator mounts the trace root read-only rather than sending transcripts as a model message
 * (`apps/consolidator/src/client.ts`, `manifestFor`, records what the superseded path actually did).
 * The root is `MEMHTML_TRACE_ROOT` and this file is where config becomes services, so it is read from the
 * same `Roots` service `memhtml trace index` scans with. One resolution of one variable is what
 * keeps the mounted tree and the indexed `traces` rows describing the same directory. A second
 * `Config.string("MEMHTML_TRACE_ROOT")` here would be a second place the `~/.claude` default lives.
 */
export const layerConsolidatorPort = (
  env: Record<string, string | undefined> = process.env
): Layer.Layer<ConsolidatorPortShape, never, RootsShape> =>
  Layer.effect(ConsolidatorPortService)(
    Effect.gen(function* () {
      const roots = yield* Roots
      const enabled = yield* Config.string("MEMHTML_LLM").pipe(
        Config.withDefault("on"),
        Config.map((value) => value.trim().toLowerCase() !== "off")
      )
      if (!enabled) return { consolidator: undefined }
      if (!hasConsolidatorCredentials(env)) {
        yield* Effect.logDebug(
          "trace consolidation unbound: no Bedrock credentials in the environment"
        )
        return { consolidator: undefined }
      }
      /**
       * The client is built over the same environment the gate just read. A client over ambient
       * `process.env` while the gate read an injected one would pass the gate and fail at the call,
       * which is the degradation-instead-of-skip outcome this gate exists to prevent.
       */
      return { consolidator: makeConsolidator({ env, traceRoot: roots.traceRoot }) }
    })
  ).pipe(Layer.orDie)

/** A layer supplying the consolidator directly, for a test that scripts its candidates. */
export const layerConsolidatorFrom = (
  consolidator: ConsolidatorShape | undefined
): Layer.Layer<ConsolidatorPortShape> => Layer.succeed(ConsolidatorPortService)({ consolidator })

/**
 * The sleep runner over the same services every other command uses.
 *
 * `@memhtml/sleep` deliberately ships no `SleepLive` that resolves its own git, database, and model.
 * A layer that built its own would open a second connection to one database file and a second git
 * wrapper on one root, and the run would then curate a corpus the indexer is not describing.
 */
export const layerSleep: Layer.Layer<
  SleepShape,
  never,
  GitShape | StoreShape | DatabaseShape | IndexerShape | ModelPortShape | ConsolidatorPortShape
> = Layer.effect(Sleep)(
  Effect.gen(function* () {
    const git = yield* Git
    const store = yield* Store
    const db = yield* DatabaseService
    const indexer = yield* Indexer
    const modelPort = yield* ModelPort
    const consolidatorPort = yield* ConsolidatorPortService
    return makeSleep({
      git,
      store,
      db,
      indexer,
      model: modelPort.model,
      consolidator: consolidatorPort.consolidator
    })
  })
)

/**
 * Everything above the embedder and the model, as one layer requiring only the roots and those two.
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
export const layerCore = Layer.mergeAll(layerSleep, layerRetrieval).pipe(
  Layer.provideMerge(Layer.mergeAll(layerIndexer, layerStore)),
  Layer.provideMerge(Layer.mergeAll(layerIndexGit, layerRecorder)),
  Layer.provideMerge(Layer.mergeAll(layerDatabase, layerGit))
)

/**
 * The production graph: roots from config, Bedrock behind both model ports, everything else over
 * them. `repoOverride` is `--repo`.
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
        layerModelPort.pipe(Layer.provide(ModelClientLive), Layer.orDie),
        layerExtractorPort,
        /**
         * `layerRoots` is provided to the consolidator port explicitly rather than merged beside it.
         * The consolidator needs `traceRoot` to mount, and a sibling in one `mergeAll` is not a
         * dependency. The roots layer is built once with `repoOverride` and fed in, so a `--repo`
         * run and the mounted trace root cannot come from two different resolutions.
         */
        layerConsolidatorPort().pipe(Layer.provide(layerRoots(repoOverride)))
      )
    )
  )

/**
 * The graph a test provides: the real composition, with the embedder and the model injected.
 *
 * Same `layerCore`, so a test exercises the wiring production uses rather than a parallel one. The
 * only substituted edges are the two that reach the network.
 */
export const layerAppWith = (options: {
  readonly repo: string
  readonly embedder: EmbedderShape
  readonly model?: ModelClientShape | undefined
  /**
   * Absent leaves trace consolidation skipped, which is the right default for every test that is not
   * about that phase. It is what a credential-free environment produces, and binding a live agent
   * from a test harness would spawn an eve server per case.
   */
  readonly consolidator?: ConsolidatorShape | undefined
  /** Absent leaves writes unextracted, the production default. Only extraction tests bind one. */
  readonly extractor?: EntityExtractorShape | undefined
}) =>
  layerCore.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerRoots(options.repo),
        layerEmbedderFrom(options.embedder),
        layerModelFrom(options.model),
        layerConsolidatorFrom(options.consolidator),
        layerExtractorFrom(options.extractor)
      )
    )
  )
