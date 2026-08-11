import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { ModelUnavailable, StorageFailure } from "@memhtml/contracts/errors"
import {
  type DatabaseShape,
  type EmbedPort,
  MIGRATIONS_DIR,
  makeDatabase,
  makeGitPort,
  makeIndexer,
  makeRetrieval,
  type QueryEmbedPort,
  type RetrievalShape,
  STATE_MIGRATIONS_DIR,
  STATE_SCHEMA
} from "@memhtml/index"
import { EMBED_DIM, EMBED_WATERMARK, Embeddings, EmbeddingsLive } from "@memhtml/llm"
import { Effect, type Scope } from "effect"

import { type FixtureCorpus, type FixtureOptions, makeFixtureCorpus } from "./fixture.js"

/**
 * The stack the discrimination gate measures: a generated fixture repo, a real database with the
 * shipped migrations, the real indexer, and the real four-arm retrieval.
 *
 * Nothing here is a fake of the ranking stack. The only substituted edge is the embedder, and that
 * substitution is the whole reason the gate can run in CI: the deterministic embedder's cosine
 * relations are a pure function of the text, so the numbers are reproducible on any machine with no
 * credentials — while `live` mode swaps in Bedrock and measures the same probes against the real
 * vector space.
 *
 * The database is `":memory:"` deliberately. The eval reads its own throwaway corpus and never the
 * operator's `index.db`, so opening a file would take Turso's writer lock on a database the gate
 * does not query — and `memhtml eval discriminate` would then refuse to run while `memhtml-mcp` is serving
 * the repo, which is exactly when an operator wants to check the gate.
 */

/** The vector width the fake produces: the real one, so a width check cannot pass by accident. */
export const FAKE_DIM = EMBED_DIM

/**
 * The deterministic embedder: a hash-seeded bag of words, L2-normalized.
 *
 * The same construction `@memhtml/index` and `@memhtml/sleep` use in their own harnesses. Two texts sharing
 * vocabulary have a genuinely high cosine and two disjoint texts a low one — which is what makes a
 * negation-flipped control a real adversary here rather than a random vector the arm trivially
 * separates. A random fake would make the gate meaningless in the easy direction and a constant fake
 * in the hard one.
 */
export const fakeVector = (text: string): Float32Array => {
  const vector = new Float32Array(FAKE_DIM)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const token of tokens) {
    const digest = createHash("sha256").update(token, "utf8").digest()
    const first = digest.readUInt32BE(0) % FAKE_DIM
    const second = digest.readUInt32BE(4) % FAKE_DIM
    vector[first] = (vector[first] ?? 0) + 1
    vector[second] = (vector[second] ?? 0) + 0.5
  }
  let norm = 0
  for (const component of vector) norm += component * component
  if (norm === 0) return vector
  const scale = 1 / Math.sqrt(norm)
  for (let at = 0; at < vector.length; at += 1) vector[at] = (vector[at] ?? 0) * scale
  return vector
}

/** Both embed ports plus a call counter. */
export interface EvalEmbedder extends EmbedPort, QueryEmbedPort {
  readonly calls: () => number
}

export const fakeEmbedder = (): EvalEmbedder => {
  let calls = 0
  return {
    embed: (texts) =>
      Effect.sync(() => {
        calls += 1
        return texts.map(fakeVector)
      }),
    embedQuery: (text) =>
      Effect.sync(() => {
        calls += 1
        return fakeVector(text)
      }),
    calls: () => calls
  }
}

/**
 * An embedder that always fails, for the lexical-floor scenario.
 *
 * The failure travels through the ERROR channel as a typed `ModelUnavailable`, never as a throw: the
 * floor only holds if retrieval can catch it, and a defect would kill the fiber instead of narrowing
 * the search.
 */
export const failingEmbedder = (): EvalEmbedder => {
  const fail = () =>
    Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "eval floor scenario" }))
  return { embed: fail, embedQuery: fail, calls: () => 0 }
}

/** The real Bedrock embedder, for `live` mode. Built only when a caller asks for it. */
export const liveEmbedder = (): Effect.Effect<EvalEmbedder> =>
  Effect.gen(function* () {
    const embeddings = yield* Embeddings
    return {
      embed: embeddings.embed,
      embedQuery: embeddings.embedQuery,
      calls: () => 0
    }
  }).pipe(Effect.provide(EmbeddingsLive), Effect.orDie)

/** A built stack: the fixture, the database, and retrieval over both. */
export interface EvalStack {
  readonly fixture: FixtureCorpus
  readonly db: DatabaseShape
  readonly retrieval: RetrievalShape
  /** How many files the indexer projected, so a caller can assert the corpus really landed. */
  readonly indexed: number
  readonly embedCalls: () => number
}

/** What {@link buildStack} takes beyond the fixture options. */
export interface StackOptions extends FixtureOptions {
  /** The embedder to measure through. `fakeEmbedder()` when absent. */
  readonly embedder?: EvalEmbedder | undefined
}

/**
 * Build the whole stack inside a scope: generate the corpus, index it, and return retrieval over it.
 *
 * `Effect.acquireRelease` owns the database, so the caller's `Effect.scoped` closes the connection —
 * and the fixture's own `cleanup` removes the temp tree. Both matter in a CLI: a command that leaked
 * a Turso handle would keep a WAL file alive under `/tmp` for the life of the process.
 */
export const buildStack = (
  options: StackOptions = {}
): Effect.Effect<EvalStack, never, Scope.Scope> =>
  Effect.gen(function* () {
    const embedder = options.embedder ?? fakeEmbedder()
    const fixture = yield* makeFixtureCorpus(options)

    const db = yield* makeDatabase(":memory:", MIGRATIONS_DIR, {
      path: ":memory:",
      migrationsDir: STATE_MIGRATIONS_DIR
    }).pipe(Effect.orDie)

    const gitPort = makeGitPort({
      git: fixture.git,
      /**
       * `Effect.tryPromise`, never `Effect.promise`. A defect on ENOENT travels past `Effect.catch`
       * and kills the fiber, so an absent path would crash the index pass instead of becoming the
       * counted skip the indexer already handles.
       */
      readFile: (path) =>
        Effect.tryPromise({
          try: () => readFile(join(fixture.root, path), "utf8"),
          catch: (cause) => cause
        }),
      fail: (operation) =>
        Effect.fail(StorageFailure.make({ operation: `git.${operation}` })) as never
    })

    const indexer = makeIndexer({
      db,
      git: gitPort,
      embedWatermark: EMBED_WATERMARK,
      embedDim: EMBED_DIM,
      embeddings: embedder,
      // A fixed instant: `indexed_at` has no bearing on ranking, and a clock read would make two
      // runs over one corpus differ in a column the gate is not about.
      now: () => "2026-08-02T00:00:00Z"
    })

    const report = yield* indexer.rebuild({ embed: true }).pipe(Effect.orDie)

    /**
     * Seed the state plane from the spec.
     *
     * After the rebuild, not before: `state.access.path` has no foreign key onto `files` (cross-database
     * ones do not exist), so seeding first would work — but the row set would then be unverifiable
     * against the corpus. Seeding after means every row names a path the index holds, which is also what
     * `memhtml doctor`'s orphan check asserts.
     *
     * The plane is seeded at all because an empty one makes the salience arm inert: it scores over a
     * `LEFT JOIN state.access`, so with no rows every term collapses to a function of `updated_at` and
     * the arm becomes a second recency arm. See `buildAccess` for why controls are excluded.
     */
    yield* db
      .writeAll(
        fixture.spec.access.map((row) => ({
          sql: `INSERT INTO ${STATE_SCHEMA}.access
                  (path, access_count, reinforcement_count, outcome_score, last_accessed_at,
                   last_reinforced_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO NOTHING`,
          params: [
            row.path,
            row.accessCount,
            row.reinforcementCount,
            row.outcomeScore,
            row.lastAccessedAt,
            row.reinforcementCount === 0 ? null : row.lastAccessedAt,
            row.lastAccessedAt
          ]
        }))
      )
      .pipe(Effect.orDie)

    return {
      fixture,
      db,
      retrieval: makeRetrieval({ db, embeddings: embedder }),
      indexed: report.filesIndexed,
      embedCalls: () => embedder.calls()
    }
  })

/**
 * Build the stack, run `body`, then tear both down.
 *
 * A scoped helper rather than a fixture the caller assembles, so the temp tree is removed on the
 * failure path too: an eval that exits 1 on an inversion must not leave a 200-file corpus under
 * `/tmp` every time the gate refuses.
 */
export const withStack = <A, E, R>(
  body: (stack: EvalStack) => Effect.Effect<A, E, R>,
  options: StackOptions = {}
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* buildStack(options)
      yield* Effect.addFinalizer(() => Effect.promise(() => stack.fixture.cleanup()))
      return yield* body(stack)
    })
  )
