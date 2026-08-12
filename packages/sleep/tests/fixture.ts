import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { StorageFailure } from "@memhtml/contracts/errors"
import type { DatabaseShape } from "@memhtml/index"
import {
  MIGRATIONS_DIR,
  makeDatabase,
  makeGitPort,
  makeIndexer,
  STATE_MIGRATIONS_DIR,
  STATE_SCHEMA
} from "@memhtml/index"
import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { makeStore } from "@memhtml/store"
import {
  configureIdentity,
  makeFixtureRepo,
  type FixtureRepo as StoreFixture
} from "@memhtml/store/testing"
import { Effect } from "effect"

import type { ConsolidatorPort } from "../src/consolidator.js"
import type { SleepDeps } from "../src/env.js"
import { makeFakeEmbedder, type ScriptedModel } from "../src/testing.js"

/**
 * The sleep test fixture: a real temp-dir git repo, a real in-memory SQLite database with the shipped
 * migrations, and the deterministic embedder — plus the corpus every phase test reads.
 *
 * Everything here is real except the model and the embedder. Sleep's subject is what a `git mv` plus a
 * head stamp in ONE commit does to rename detection, what an upsert's `RETURNING` says about a
 * promotion, and whether a failed phase leaves the index staged. A fake git or a stateless fake
 * database would confirm the calls and miss all three.
 */

/** One memory file to seed. */
export interface SeedFile {
  readonly path: string
  readonly html: string
}

/** A fixture: the repo, the services, and helpers for driving git directly. */
export interface Fixture {
  readonly root: string
  /**
   * Where a seeded transcript is written. OUTSIDE the memory repo, which is the property under test as
   * much as a convenience: `.memhtml` never holds session content, so a fixture that put transcripts in
   * the repo would let a phase that copied one into the corpus look correct.
   */
  readonly traceRoot: string
  readonly deps: SleepDeps
  readonly db: DatabaseShape
  readonly repo: StoreFixture
  /** Write files and commit them, returning the new HEAD. */
  readonly commit: (files: ReadonlyArray<SeedFile>, message: string) => Effect.Effect<string>
  /** Raw plumbing, for asserting on git's own output. */
  readonly raw: (...args: ReadonlyArray<string>) => Effect.Effect<string>
  /** Full index rebuild with embeddings, so the vector arms have vectors. */
  readonly reindex: () => Effect.Effect<void>
}

/** Whether a fixture binds a scripted model. Absent leaves the four LLM phases skipped. */
export interface FixtureOptions {
  readonly model?: ScriptedModel | undefined
  /** Absent leaves trace-consolidation skipped, which is what a credential-free run produces. */
  readonly consolidator?: ConsolidatorPort | undefined
  readonly seed?: ReadonlyArray<SeedFile> | undefined
}

/**
 * Build a fixture inside a `Effect.scoped` program.
 *
 * The database is `":memory:"` with both planes attached, and the migrations are the shipped SQL — so
 * a CHECK constraint, a partial unique index, and an `ON UPDATE CASCADE` all behave here exactly as
 * they do in production, which is the point of not faking them.
 */
export const withFixture = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E>,
  options: FixtureOptions = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* makeFixtureRepo()
        yield* Effect.addFinalizer(() => Effect.promise(() => repo.cleanup()))
        yield* configureIdentity(repo.git)

        const db = yield* makeDatabase(":memory:", MIGRATIONS_DIR, {
          path: ":memory:",
          migrationsDir: STATE_MIGRATIONS_DIR
        })

        const embeddings = makeFakeEmbedder()
        const gitPort = makeGitPort({
          git: repo.git,
          /**
           * `Effect.tryPromise`, never `Effect.promise`. A defect on ENOENT passes straight through
           * `Effect.catch` and kills the fiber, so an absent path would crash an index pass instead of
           * becoming the counted skip the indexer already handles — and sleep archives files, so an
           * absent path is the normal case here, not an edge one.
           */
          readFile: (path) =>
            Effect.tryPromise({
              try: async () => {
                const { readFile } = await import("node:fs/promises")
                return readFile(join(repo.root, path), "utf8")
              },
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
          embeddings,
          now: () => "2026-08-02T00:00:00Z"
        })

        const store = makeStore(repo.git)
        const deps: SleepDeps = {
          git: repo.git,
          store,
          db,
          indexer,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.consolidator === undefined ? {} : { consolidator: options.consolidator })
        }

        /**
         * Its own temp directory, outside the git repo. A trace root inside `repo.root` would make
         * every seeded transcript an untracked file, so `requireCleanTree` — which sleep's preflight
         * calls — would fail on a fixture that had only seeded a transcript.
         */
        const traceRoot = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "memhtml-sleep-traces-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
        )

        const commit = (files: ReadonlyArray<SeedFile>, message: string) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              for (const file of files) {
                const full = join(repo.root, file.path)
                await mkdir(dirname(full), { recursive: true })
                await writeFile(full, file.html, "utf8")
              }
            })
            yield* repo.git.add(files.map((file) => file.path))
            yield* repo.git.commit(message)
            return (yield* repo.git.run(["rev-parse", "HEAD"])).trim()
          }).pipe(Effect.orDie)

        const fixture: Fixture = {
          root: repo.root,
          traceRoot,
          deps,
          db,
          repo,
          commit,
          raw: (...args) => repo.git.run(args).pipe(Effect.orDie),
          reindex: () => indexer.rebuild({ embed: true }).pipe(Effect.asVoid, Effect.orDie)
        }

        if (options.seed !== undefined && options.seed.length > 0) {
          yield* commit(options.seed, "seed the fixture corpus")
          yield* fixture.reindex()
        }

        return yield* body(fixture)
      })
    )
  )

/** Everything {@link memoryHtml} needs. Mirrors the format's head exactly. */
export interface MemoryFixture {
  readonly title: string
  readonly claim: string
  readonly body?: string | undefined
  readonly memoryType?: string | undefined
  readonly createdAt?: string | undefined
  readonly updatedAt?: string | undefined
  readonly confidence?: string | undefined
  readonly importance?: string | undefined
  readonly validUntil?: string | undefined
  readonly reprieves?: string | undefined
  readonly taskStatus?: string | undefined
  readonly dueAt?: string | undefined
  readonly entities?: ReadonlyArray<string> | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  readonly links?: ReadonlyArray<{ readonly rel: string; readonly href: string }> | undefined
}

/**
 * A valid memory file as bytes.
 *
 * Hand-written rather than produced by `@memhtml/html`'s template, deliberately: these are the INPUT the
 * parser and the head editors operate on, and generating them with the same package that edits them
 * would let a template-and-editor pair agree on something the format does not say.
 */
export const memoryHtml = (fixture: MemoryFixture): string => {
  const at = fixture.createdAt ?? "2026-06-01T00:00:00Z"
  const metas = [
    `<meta name="memhtml-type" content="${fixture.memoryType ?? "semantic"}">`,
    `<meta name="memhtml-status" content="active">`,
    `<meta name="memhtml-created" content="${at}">`,
    `<meta name="memhtml-updated" content="${fixture.updatedAt ?? at}">`,
    ...(fixture.confidence === undefined
      ? []
      : [`<meta name="memhtml-confidence" content="${fixture.confidence}">`]),
    ...(fixture.importance === undefined
      ? []
      : [`<meta name="memhtml-importance" content="${fixture.importance}">`]),
    ...(fixture.validUntil === undefined
      ? []
      : [`<meta name="memhtml-valid-until" content="${fixture.validUntil}">`]),
    ...(fixture.reprieves === undefined
      ? []
      : [`<meta name="memhtml-reprieves" content="${fixture.reprieves}">`]),
    ...(fixture.taskStatus === undefined
      ? []
      : [`<meta name="memhtml-task-status" content="${fixture.taskStatus}">`]),
    ...(fixture.dueAt === undefined
      ? []
      : [`<meta name="memhtml-due" content="${fixture.dueAt}">`]),
    ...(fixture.entities ?? []).map((entity) => `<meta name="memhtml-entity" content="${entity}">`),
    ...(fixture.tags ?? []).map((tag) => `<meta name="memhtml-tag" content="${tag}">`),
    ...(fixture.links ?? []).map((one) => `<link rel="${one.rel}" href="${one.href}">`)
  ]
  const body = fixture.body === undefined ? "" : ` ${fixture.body}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${fixture.title}</title>
${metas.join("\n")}
</head>
<body>
<article>
<p><mark>${fixture.claim}</mark>${body}</p>
</article>
</body>
</html>
`
}

/**
 * The dedup fixture: a TRUE duplicate that must MERGE, and a NEGATION-FLIPPED near-twin that must be
 * VETOED. Both pairs clear the 0.92 cosine floor under the deterministic embedder.
 *
 * The flipped pair is the whole point, and the metarepo's narrator lesson is why: a corpus holding
 * only the true duplicate passes against a dedup phase whose veto does nothing, because there is
 * nothing for the veto to block. The flip is the NEIGHBOUR that makes the assertion non-vacuous — it
 * shares every token with its twin but one, so it scores higher than the true duplicate does, and the
 * one differing token inverts the claim.
 *
 * **Measured cosines under `fakeVector` (2026-08-02, computed against the article text the chunker
 * actually embeds):** true duplicate 0.9277, negation flip 0.9907, cross-pair 0.46. Both pairs are
 * therefore above the 0.92 threshold and the two topics do not interfere — the veto's effect is
 * isolated to one pair.
 *
 * **The true duplicate is REWORDED, not byte-identical.** An identical article yields an identical
 * `content_hash`, and `files_content_hash_active` is a partial unique index — so the second file
 * cannot even be INDEXED, and the fixture would fail at seed time with a constraint violation instead
 * of reaching the dedup phase. Structural dedup and semantic dedup are different mechanisms, and only
 * the second is what this phase is for.
 *
 * `entities` are shared inside each pair, so the conflict-detection scan (which requires a shared
 * entity) finds the same pairs.
 */
export const DEDUP_CORPUS: ReadonlyArray<SeedFile> = [
  {
    path: "areas/oncall/drain-the-vip-first.html",
    html: memoryHtml({
      title: "Drain the VIP before reverting a prod deploy",
      claim: "If a prod rollback is issued, drain the VIP before reverting the deploy.",
      body: "The revert alone leaves in-flight connections pinned to the old target group during a rollback of the checkout service.",
      memoryType: "procedural",
      createdAt: "2026-05-01T00:00:00Z",
      confidence: "0.90",
      importance: "8",
      entities: ["service:checkout-api"],
      tags: ["deploy"]
    })
  },
  {
    // The TRUE duplicate: the same fact, reworded, no divergence marker. Cosine 0.9277 — it MERGES.
    path: "areas/oncall/vip-drain-precedes-revert.html",
    html: memoryHtml({
      title: "VIP drain precedes the revert on a prod rollback",
      claim: "Drain the VIP before reverting the deploy when a prod rollback is issued.",
      body: "In-flight connections stay pinned to the old target group if only the revert runs during a checkout service rollback.",
      memoryType: "procedural",
      createdAt: "2026-05-02T00:00:00Z",
      confidence: "0.90",
      importance: "7",
      entities: ["service:checkout-api"],
      tags: ["deploy"]
    })
  },
  {
    path: "areas/deploy/blue-green-is-safe.html",
    html: memoryHtml({
      title: "Blue-green cutover is safe during business hours",
      claim: "A blue-green cutover on the payments gateway is safe to run during business hours.",
      body: "Connection draining completes before the old fleet is retired so every request finishes through the payments gateway cutover.",
      memoryType: "semantic",
      createdAt: "2026-05-03T00:00:00Z",
      confidence: "0.85",
      entities: ["service:payments-gateway"],
      tags: ["deploy"]
    })
  },
  {
    /**
     * The NEGATION FLIP. Token-for-token the memory above except for one `not`, so its cosine against
     * that memory measures 0.9907 — comfortably above the floor and HIGHER than the true duplicate's.
     * The veto must block it: the merge keeps the OLDER file, so folding this in would restore exactly
     * the claim this memory corrects.
     *
     * **Neither body carries any other negation marker, and that is required for this pair to be a
     * valid probe.** `negationDivergent` asks whether exactly ONE side carries a marker from the set —
     * it is a presence check over the whole text, not a per-claim comparison. An earlier draft of this
     * fixture had "so no request is dropped" in BOTH bodies, which put a marker on both sides and made
     * the predicate return false: the flip merged, and a veto test written against it would have
     * asserted a merge while claiming to assert a veto. See the note in T8.md §7 — the same masking
     * window applies to any negation-flip control generated for the discrimination gate.
     */
    path: "areas/deploy/blue-green-is-not-safe.html",
    html: memoryHtml({
      title: "Blue-green cutover is not safe during business hours",
      claim:
        "A blue-green cutover on the payments gateway is not safe to run during business hours.",
      body: "Connection draining completes before the old fleet is retired so every request finishes through the payments gateway cutover.",
      memoryType: "semantic",
      createdAt: "2026-05-04T00:00:00Z",
      confidence: "0.85",
      entities: ["service:payments-gateway"],
      tags: ["deploy"]
    })
  },
  {
    path: "areas/metrics/scrape-cadence.html",
    html: memoryHtml({
      title: "The metrics agent scrapes every exporter each minute",
      claim: "The metrics agent scrapes every exporter on the host once each minute.",
      body: "Scrape results land in the local buffer and flush to the collector on the next tick.",
      memoryType: "procedural",
      createdAt: "2026-05-05T00:00:00Z",
      confidence: "0.80",
      importance: "5",
      entities: ["service:metrics-agent"],
      tags: ["observability"]
    })
  },
  {
    /**
     * A SECOND true duplicate, on a third topic.
     *
     * Its purpose is ORDERING. `dedup-merge` processes decisions in descending similarity, so a
     * phase-failure test needs two mergeable pairs: one that archives cleanly and stages files, and one
     * whose move then fails. Without it the only reachable failure happens before anything is staged,
     * and the assertion that a failed phase leaves nothing staged is vacuous — verified by mutation
     * (removing the index reset left the suite green while the failure came first).
     *
     * **Measured 2026-08-02:** this pair scores 0.9323 and the oncall pair 0.9277, so THIS pair is
     * processed first and {@link LAST_DROP_PATH} names the oncall pair's drop side. Cross-topic cosine
     * is 0.50, so the three topics do not interfere.
     */
    path: "areas/metrics/exporter-scrape-interval.html",
    html: memoryHtml({
      title: "Every exporter is scraped once a minute",
      claim: "Every exporter on the host is scraped once each minute by the metrics agent.",
      body: "Results land in the local buffer and flush to the collector on the following tick.",
      memoryType: "procedural",
      createdAt: "2026-05-06T00:00:00Z",
      confidence: "0.80",
      importance: "5",
      entities: ["service:metrics-agent"],
      tags: ["observability"]
    })
  }
]

/**
 * The drop path of the LOWER-similarity true-duplicate pair, whose archive destination a failure test
 * squats so that dedup-merge's SECOND archive move fails after its first has already staged files.
 *
 * Which pair is second follows from the measured similarities (metrics 0.9323 before oncall 0.9277) and
 * from `mergeCandidates` preserving its input order, which is descending similarity.
 */
export const LAST_DROP_PATH = "areas/oncall/vip-drain-precedes-revert.html"

/**
 * Open tasks seeded BESIDE {@link DEDUP_CORPUS}, built so every sleep exclusion is non-vacuous.
 *
 * Tasks on unrelated topics with fresh timestamps would be skipped by every phase anyway, and a
 * task-invariance test over them would pass against a sleep cycle with no exclusions at all. Each
 * property below exists to reach one phase:
 *
 * - **Two near-identical tasks** (`t-runbook-*`) share almost all their vocabulary, so they clear
 *   the 0.92 near-duplicate floor — dedup-merge WOULD fold them, and folding archives real work.
 * - **A task sharing a memory's vocabulary** (`t-drain-runbook`) is embedding-near
 *   `drain-the-vip-first.html`, so relationship-mining would mine a memory-class `relates_to` from a
 *   task into the memory graph, and conflict-detection would judge the pair — both share
 *   `service:checkout-api`, which the conflict scan requires.
 * - **Old, low-confidence, low-importance, short** on `t-forgotten` puts it squarely in the EVICT
 *   band: retention-triage would archive it, and confidence-decay would rewrite its
 *   `memhtml-confidence` (0.90 is well above the floor, so the delta gate does not save it).
 * - **A passed `memhtml-valid-until`** on `t-forgotten` reaches the reprieve phase, which archives a
 *   TTL-passed file.
 * - **A `person:` entity** on `t-ask-imani` reaches person-links, which would mint
 *   `resources/people/imani.html` from a to-do item and stamp `memhtml-about-person` into the task.
 * - **A mixed-case entity** (`Service:Checkout-API`) reaches entity-resolution, which would
 *   normalize the meta and rewrite the task file.
 */
export const TASK_CORPUS: ReadonlyArray<SeedFile> = [
  {
    path: "areas/inbox/tasks/t-drain-runbook.html",
    html: memoryHtml({
      title: "Write the VIP drain step into the rollback runbook",
      claim: "The rollback runbook omits the VIP drain before reverting the deploy.",
      body: "The revert alone leaves in-flight connections pinned to the old target group during a rollback of the checkout service.",
      memoryType: "task",
      taskStatus: "doing",
      dueAt: "2026-08-09",
      createdAt: "2026-05-10T00:00:00Z",
      confidence: "0.90",
      importance: "8",
      entities: ["service:checkout-api"],
      tags: ["deploy"]
    })
  },
  {
    path: "areas/inbox/tasks/t-runbook-review-a.html",
    html: memoryHtml({
      title: "Review the deploy runbook before the next release",
      claim: "The deploy runbook needs a review before the next release ships.",
      body: "Walk each step against the current target-group configuration and note what has drifted.",
      memoryType: "task",
      taskStatus: "todo",
      createdAt: "2026-05-11T00:00:00Z",
      confidence: "0.90",
      importance: "5",
      entities: ["service:deploy-tooling"],
      tags: ["deploy"]
    })
  },
  {
    // The near-duplicate of the task above: dedup-merge would fold these two.
    path: "areas/inbox/tasks/t-runbook-review-b.html",
    html: memoryHtml({
      title: "Before the next release, review the deploy runbook",
      claim: "Before the next release ships, the deploy runbook needs a review.",
      body: "Walk each step against the current target-group config and note whatever has drifted.",
      memoryType: "task",
      taskStatus: "todo",
      createdAt: "2026-05-12T00:00:00Z",
      confidence: "0.90",
      importance: "5",
      entities: ["service:deploy-tooling"],
      tags: ["deploy"]
    })
  },
  {
    // EVICT-band by every signal, and TTL-passed: reaches retention-triage, reprieve, and decay.
    path: "areas/inbox/tasks/t-forgotten.html",
    html: memoryHtml({
      title: "Chase the stale bastion port",
      claim: "Nobody has confirmed the staging bastion port.",
      memoryType: "task",
      taskStatus: "blocked",
      createdAt: "2026-01-05T00:00:00Z",
      confidence: "0.90",
      importance: "1",
      validUntil: "2026-02-01T00:00:00Z",
      tags: ["ops"]
    })
  },
  {
    // A person entity and a mixed-case one: reaches person-links and entity-resolution.
    path: "areas/inbox/tasks/t-ask-imani.html",
    html: memoryHtml({
      title: "Ask Imani about the search relevance surface",
      claim: "Imani owns the search relevance surface and has not been asked yet.",
      memoryType: "task",
      taskStatus: "todo",
      createdAt: "2026-05-13T00:00:00Z",
      confidence: "0.90",
      importance: "6",
      entities: ["person:imani", "Service:Checkout-API"],
      tags: ["search"]
    })
  }
]

/**
 * Seed one `traces` row, and write the transcript file it points at.
 *
 * The FILE is real, not only the row, and that is deliberate even though the phase never opens one:
 * the phase's whole job is to hand a path to something that will read it, and a fixture whose paths
 * point at nothing could not tell a phase that passes the right path from one that passes a plausible
 * wrong path. A test asserting on what the consolidator RECEIVED can then check the bytes are there.
 *
 * `fileSize` defaults comfortably above the phase's byte floor and `fileMtime` well before any run
 * date used here, so a caller states only what it is varying — which is what keeps a floor test or a
 * quiet-window test about one dimension.
 */
export const seedTrace = (
  fixture: Fixture,
  input: {
    readonly sessionId: string
    readonly fileSize?: number | undefined
    readonly fileMtime?: string | undefined
    readonly lines?: ReadonlyArray<string> | undefined
  }
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const filePath = join(fixture.traceRoot, `${input.sessionId}.jsonl`)
    const lines = input.lines ?? [
      JSON.stringify({ type: "user", sessionId: input.sessionId, message: "a prompt" }),
      JSON.stringify({ type: "assistant", sessionId: input.sessionId, message: "an answer" })
    ]
    yield* Effect.promise(async () => {
      await mkdir(fixture.traceRoot, { recursive: true })
      await writeFile(filePath, `${lines.join("\n")}\n`, "utf8")
    })

    yield* fixture.db
      .run(
        `INSERT INTO traces (session_id, slug, file_path, file_size, file_mtime, indexed_at,
                             first_prompt, search_text)
         VALUES (?, ?, ?, ?, ?, ?, '', '')
         ON CONFLICT(session_id) DO UPDATE SET
           file_path = excluded.file_path, file_size = excluded.file_size,
           file_mtime = excluded.file_mtime`,
        [
          input.sessionId,
          "-fixture-project",
          filePath,
          input.fileSize ?? 64 * 1024,
          input.fileMtime ?? "2026-07-01T00:00:00Z",
          "2026-07-01T00:00:00Z"
        ]
      )
      .pipe(Effect.orDie)

    return filePath
  })

/**
 * Seed one `memory_session_links` row: a memory the corpus links to a session.
 *
 * Written directly rather than through the store's recorder, because the recorder writes this row at
 * MEMORY-WRITE time from a live session's own id, and no fixture can be inside a real Claude Code
 * session. What a test needs is the row's presence, which is what the manifest join reads.
 *
 * `link_kind` defaults to `wrote`, the kind the recorder writes on an ordinary memory write, and the
 * `at` value participates in the primary key so two links from one session to one path with different
 * instants are two rows — which is the shape a corrected memory produces.
 */
export const seedSessionLink = (
  fixture: Fixture,
  input: {
    readonly path: string
    readonly sessionId: string
    readonly linkKind?: "wrote" | "read" | "corrected" | "reinforced" | undefined
    readonly at?: string | undefined
  }
): Effect.Effect<void, never> =>
  fixture.db
    .run(
      `INSERT INTO memory_session_links (path, session_id, link_kind, at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path, session_id, link_kind, at) DO NOTHING`,
      [input.path, input.sessionId, input.linkKind ?? "wrote", input.at ?? "2026-07-01T12:00:00Z"]
    )
    .pipe(Effect.orDie)

/** Every consolidation watermark, session-ordered. What a test reads to assert the phase's last write. */
export const consolidationWatermarks = (
  fixture: Fixture
): Effect.Effect<ReadonlyArray<{ readonly session_id: string; readonly run_id: string }>, never> =>
  fixture.db
    .all<{ session_id: string; run_id: string }>(
      "SELECT session_id, run_id FROM trace_consolidations ORDER BY session_id"
    )
    .pipe(Effect.orDie)

/** Seed one `state.access` row, so a decay or reprieve test can name a reinforcement count. */
export const seedAccess = (
  db: DatabaseShape,
  input: {
    readonly path: string
    readonly accessCount?: number | undefined
    readonly reinforcementCount?: number | undefined
    readonly outcomeScore?: number | undefined
    readonly lastAccessedAt?: string | undefined
  }
): Effect.Effect<void, never> =>
  db
    .run(
      `INSERT INTO ${STATE_SCHEMA}.access
         (path, access_count, reinforcement_count, outcome_score, last_accessed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET access_count = excluded.access_count,
         reinforcement_count = excluded.reinforcement_count, outcome_score = excluded.outcome_score,
         last_accessed_at = excluded.last_accessed_at, updated_at = excluded.updated_at`,
      [
        input.path,
        input.accessCount ?? 0,
        input.reinforcementCount ?? 0,
        input.outcomeScore ?? 0,
        input.lastAccessedAt ?? null,
        "2026-08-01T00:00:00Z"
      ]
    )
    .pipe(Effect.orDie)

/** Bump a corroboration counter directly, so a promotion test starts at `detections = 1`. */
export const seedCorroboration = (
  db: DatabaseShape,
  input: { readonly srcPath: string; readonly dstPath: string; readonly detections: number }
): Effect.Effect<void, never> =>
  db
    .run(
      `INSERT INTO ${STATE_SCHEMA}.edge_corroboration (src_path, rel, dst_path, detections, updated_at)
       VALUES (?, 'contradicts', ?, ?, ?)
       ON CONFLICT(src_path, rel, dst_path) DO UPDATE SET detections = excluded.detections`,
      [input.srcPath, input.dstPath, input.detections, "2026-08-01T00:00:00Z"]
    )
    .pipe(Effect.orDie)
