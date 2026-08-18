import type { StorageFailure } from "@memhtml/contracts/errors"
import type { DatabaseShape } from "@memhtml/index"
import { STATE_SCHEMA } from "@memhtml/index"
import { Effect } from "effect"

/**
 * Every read a phase makes against the index, in one module.
 *
 * Gathered here instead of inlined per phase because these statements are where the index's
 * reading semantics live: `archived = 0` for active, `derived = 0` for an authored contradiction,
 * and `edge_class = 'memory'` for anything that may enter the graph. A phase that wrote its own
 * `WHERE` would be a second reader of a producer's private rules. Every statement below is a read;
 * a phase's writes go through git, through `state.*`, or through the derived-edge insert.
 */

/**
 * The memory type no phase of a sleep cycle touches.
 *
 * A task is live working state, and every one of the fifteen phases is a judgment about REMEMBERED
 * FACTS: decay says a claim is fading, dedup says two claims are one, conflict detection says two
 * claims disagree, retention says a claim has stopped earning its place. None of those hold for
 * a thing an agent intends to do, and each would be wrong applied to one. A task the agent has
 * not got to yet is not a claim losing confidence, and two open tasks with the same body are two
 * things to do, not one fact stored twice.
 *
 * Stated once, here, and spread into every phase's exclusion. Nine call sites each writing
 * `"task"` would be nine chances for one to be missed, and a phase that still scored tasks
 * would show up as a task file whose confidence drifts every night with no reader anywhere.
 *
 * DONE tasks need no exclusion: finishing one archives it, and every phase's corpus is
 * `archived = 0` already.
 */
export const SLEEP_EXCLUDED_TYPES: ReadonlyArray<string> = ["task"]

/** True when a row's type is one no phase acts on. The in-memory form of the exclusion above. */
export const isSleepExcluded = (memoryType: string): boolean =>
  SLEEP_EXCLUDED_TYPES.includes(memoryType)

/** One active file with everything the deterministic phases score it on. */
export interface CorpusRow {
  readonly path: string
  readonly memory_type: string
  readonly title: string
  readonly gist: string
  readonly body_text: string
  readonly content_hash: string
  readonly confidence: number
  readonly importance: number
  readonly word_count: number
  readonly created_at: string
  readonly updated_at: string
  readonly valid_until: string | null
  readonly reprieves: number
}

/**
 * Every active memory, oldest first.
 *
 * `created_at ASC` affects the outcome. Dedup-merge orients each pair so the OLDER file is the keeper,
 * and a stable oldest-first read makes that orientation reproducible across runs on an unchanged
 * corpus. Which file survives a night follows from it.
 */
export const activeCorpus = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<CorpusRow>, StorageFailure> =>
  db.all<CorpusRow>(
    `SELECT path, memory_type, title, gist, body_text, content_hash, confidence, importance,
            word_count, created_at, updated_at, valid_until, reprieves
     FROM files WHERE archived = 0 ORDER BY created_at ASC, path ASC`
  )

/** One candidate pair from a vector neighborhood, unoriented. */
export interface PairRow {
  readonly src: string
  readonly dst: string
  /** Cosine similarity, unitless in `[-1, 1]`. `1 - vector_distance_cos`. */
  readonly sim: number
}

/**
 * Per-source top-`k` nearest neighbors above a similarity floor, over first-chunk vectors.
 *
 * `ordinal = 0` collapses a file to its first chunk, not its best chunk. The format is one
 * fact per file, so almost every file is a single chunk. Taking the first keeps the pair set
 * symmetric, which `min(distance)` over all chunks would not. An asymmetric neighborhood
 * would make `(a, b)` a candidate while `(b, a)` is not, so which of two files was read first
 * would decide whether they merge.
 *
 * `ROW_NUMBER() OVER (PARTITION BY src ...)` is the per-source cap. `vector_distance_cos` takes two
 * STORED blobs here instead of a blob and a bound parameter. It can, because it is a registered
 * SQL function over two `Uint8Array` arguments (`packages/index/src/database.ts`) and not a driver
 * builtin with a fixed calling shape.
 */
export const neighborPairs = (
  db: DatabaseShape,
  options: {
    readonly floor: number
    readonly perSourceK: number
    readonly limit: number
    /** Memory types to exclude, e.g. `arc`, since a synthesis is not a near-duplicate of its members. */
    readonly excludeTypes?: ReadonlyArray<string> | undefined
  }
): Effect.Effect<ReadonlyArray<PairRow>, StorageFailure> => {
  const excluded = options.excludeTypes ?? []
  const typeFilter =
    excluded.length === 0 ? "" : ` AND f.memory_type NOT IN (${excluded.map(() => "?").join(", ")})`
  return db.all<PairRow>(
    `WITH vecs AS (
       SELECT f.path AS path, e.vec AS vec
       FROM files f
       JOIN chunks c ON c.path = f.path AND c.ordinal = 0
       JOIN embeddings e ON e.chunk_id = c.chunk_id
       WHERE f.archived = 0${typeFilter}
     ),
     pairs AS (
       SELECT l.path AS src, r.path AS dst, 1 - vector_distance_cos(l.vec, r.vec) AS sim
       FROM vecs l JOIN vecs r ON r.path <> l.path
     ),
     ranked AS (
       SELECT src, dst, sim, ROW_NUMBER() OVER (PARTITION BY src ORDER BY sim DESC, dst ASC) AS k
       FROM pairs WHERE sim >= ?
     )
     SELECT src, dst, sim FROM ranked WHERE k <= ? ORDER BY sim DESC, src ASC, dst ASC LIMIT ?`,
    [...excluded, options.floor, options.perSourceK, options.limit]
  )
}

/**
 * Candidate pairs for conflict detection: embedding-near, sharing an entity, and carrying no
 * AUTHORED edge between them in either direction.
 *
 * The shared-entity requirement is what keeps the model budget on pairs that could actually be about
 * one thing. The anti-join keeps the phase from re-judging a pair an agent already linked. An
 * authored `contradicts` is a settled fact, and re-asking the model about it would let a `neutral`
 * answer look like new information.
 *
 * **`derived = 0` is what makes the anti-join correct.** Relationship mining runs one phase EARLIER and
 * writes a derived `relates_to` for every pair above 0.85 cosine, a strict superset of the
 * pairs above the 0.80 conflict floor. An anti-join over ALL edges therefore excludes every candidate
 * this phase exists to find, and the phase reports `candidates: 0` forever with no error anywhere.
 * A mined edge is a machine suspicion, not a settled relationship; only an authored one closes a pair.
 */
export const conflictCandidates = (
  db: DatabaseShape,
  options: {
    readonly floor: number
    readonly perSourceK: number
    readonly limit: number
    /**
     * Memory types to exclude, the same hole {@link neighborPairs} carries. `task` is excluded
     * because a task is intended work, not an asserted fact, so "these two contradict" is not a
     * judgment that can be true of it. Paying for a model call to find out would also spend the
     * candidate budget on rows no phase acts on.
     */
    readonly excludeTypes?: ReadonlyArray<string> | undefined
  }
): Effect.Effect<ReadonlyArray<PairRow>, StorageFailure> => {
  const excluded = options.excludeTypes ?? []
  const typeFilter =
    excluded.length === 0 ? "" : ` AND f.memory_type NOT IN (${excluded.map(() => "?").join(", ")})`
  return db.all<PairRow>(
    `WITH vecs AS (
       SELECT f.path AS path, e.vec AS vec
       FROM files f
       JOIN chunks c ON c.path = f.path AND c.ordinal = 0
       JOIN embeddings e ON e.chunk_id = c.chunk_id
       WHERE f.archived = 0${typeFilter}
     ),
     pairs AS (
       SELECT l.path AS src, r.path AS dst, 1 - vector_distance_cos(l.vec, r.vec) AS sim
       FROM vecs l JOIN vecs r ON r.path < l.path
       WHERE EXISTS (
         SELECT 1 FROM file_entities le
         JOIN file_entities re ON re.entity_type = le.entity_type AND re.entity_name = le.entity_name
         WHERE le.path = l.path AND re.path = r.path
       )
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         WHERE e.derived = 0
           AND ((e.src_path = l.path AND e.dst_path = r.path)
             OR (e.src_path = r.path AND e.dst_path = l.path))
       )
     ),
     ranked AS (
       SELECT src, dst, sim, ROW_NUMBER() OVER (PARTITION BY src ORDER BY sim DESC, dst ASC) AS k
       FROM pairs WHERE sim >= ?
     )
     SELECT src, dst, sim FROM ranked WHERE k <= ? ORDER BY sim DESC, src ASC, dst ASC LIMIT ?`,
    [...excluded, options.floor, options.perSourceK, options.limit]
  )
}

/** One `type:name` entity as authored, with how many active files claim it. */
export interface EntityCount {
  readonly entity_type: string
  readonly entity_name: string
  readonly files: number
}

/**
 * Every entity on an active NON-TASK file, with its file count. The union-find's input.
 *
 * Tasks are excluded here instead of in the two phases that read this, so both get the exclusion
 * from one statement, and this module is where the index's reading semantics belong.
 *
 * The exclusion does more than leave a task's bytes alone. A person mentioned ONLY by a task
 * ("ask Imani about the migration ledger") would otherwise mint `resources/people/imani.html`, a
 * durable hand-editable identity surface created from a to-do item. A task's entity references
 * are also the agent's own handles on its own work: renaming one to a corpus-wide canonical is a
 * nightly job editing live working state.
 */
export const activeEntities = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<EntityCount>, StorageFailure> =>
  db.all<EntityCount>(
    `SELECT e.entity_type AS entity_type, e.entity_name AS entity_name, count(*) AS files
     FROM file_entities e JOIN files f ON f.path = e.path
     WHERE f.archived = 0 AND f.memory_type NOT IN (${typePlaceholders()})
     GROUP BY e.entity_type, e.entity_name
     ORDER BY e.entity_type ASC, e.entity_name ASC`,
    [...SLEEP_EXCLUDED_TYPES]
  )

/**
 * Which active non-task files claim one entity.
 *
 * The same exclusion as {@link activeEntities}, and it has to be BOTH: person-links reads its link
 * targets from here, so a task would still be edited even with the entity list already filtered.
 */
export const pathsForEntity = (
  db: DatabaseShape,
  entityType: string,
  entityName: string
): Effect.Effect<ReadonlyArray<{ readonly path: string }>, StorageFailure> =>
  db.all<{ path: string }>(
    `SELECT e.path AS path FROM file_entities e JOIN files f ON f.path = e.path
     WHERE f.archived = 0 AND e.entity_type = ? AND e.entity_name = ?
       AND f.memory_type NOT IN (${typePlaceholders()})
     ORDER BY e.path ASC`,
    [entityType, entityName, ...SLEEP_EXCLUDED_TYPES]
  )

/** `?` per excluded type, so the exclusion binds instead of interpolating a value into SQL. */
const typePlaceholders = (): string => SLEEP_EXCLUDED_TYPES.map(() => "?").join(", ")

/** One memory-class edge between two active files. */
export interface EdgeRow {
  readonly src_path: string
  readonly rel: string
  readonly dst_path: string
  readonly strength: number
  readonly derived: number
}

/**
 * The memory-class edge list over active files, both authored and derived.
 *
 * `edge_class = 'memory'` is the firewall. A person or provenance edge cannot enter PageRank, label
 * propagation, or the retention bridge count, and this query is what makes that true. The CHECK
 * constraint alone does not.
 */
export const memoryEdges = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<EdgeRow>, StorageFailure> =>
  db.all<EdgeRow>(
    `SELECT e.src_path AS src_path, e.rel AS rel, e.dst_path AS dst_path,
            e.strength AS strength, e.derived AS derived
     FROM edges e
     JOIN files s ON s.path = e.src_path AND s.archived = 0
     JOIN files d ON d.path = e.dst_path AND d.archived = 0
     WHERE e.edge_class = 'memory'
     ORDER BY e.src_path ASC, e.rel ASC, e.dst_path ASC`
  )

/** Per-path counts of inbound edges that bear on retention. */
export interface RetentionEdgeCounts {
  readonly path: string
  /** Inbound `supports`/`reinforces`-class edges. A quantity. */
  readonly reinforcements: number
  /**
   * Inbound AUTHORED contradictions only, `derived = 0`. A sleep-mined suspicion is excluded here
   * instead of downstream, so an uncorroborated machine guess cannot evict a memory. The
   * `derived` column is the firewall the retention scorer relies on.
   */
  readonly contradictions: number
}

export const retentionEdgeCounts = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<RetentionEdgeCounts>, StorageFailure> =>
  db.all<RetentionEdgeCounts>(
    `SELECT f.path AS path,
            sum(CASE WHEN e.rel = 'supports' THEN 1 ELSE 0 END) AS reinforcements,
            sum(CASE WHEN e.rel = 'contradicts' AND e.derived = 0 THEN 1 ELSE 0 END) AS contradictions
     FROM files f
     LEFT JOIN edges e ON e.dst_path = f.path AND e.edge_class = 'memory'
     WHERE f.archived = 0
     GROUP BY f.path ORDER BY f.path ASC`
  )

/** One path's durable access bookkeeping. Absent from the result means it was not accessed. */
export interface AccessRow {
  readonly path: string
  readonly access_count: number
  readonly reinforcement_count: number
  readonly outcome_score: number
  readonly last_accessed_at: string | null
  readonly last_reinforced_at: string | null
  readonly updated_at: string
}

/**
 * The whole `state.access` table, path-ordered.
 *
 * Ordered in SQL instead of sorted afterwards so the state-export phase's sidecar is byte-stable.
 * Two runs over an unchanged plane produce an identical file and therefore no commit.
 */
export const accessRows = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<AccessRow>, StorageFailure> =>
  db.hasState
    ? db.all<AccessRow>(
        `SELECT path, access_count, reinforcement_count, outcome_score,
                last_accessed_at, last_reinforced_at, updated_at
         FROM ${STATE_SCHEMA}.access ORDER BY path ASC`
      )
    : db.all<AccessRow>("SELECT NULL AS path WHERE 0")

/** One corroboration counter on a machine-detected edge. */
export interface CorroborationRow {
  readonly src_path: string
  readonly rel: string
  readonly dst_path: string
  readonly detections: number
  readonly promoted: number
}

/**
 * Bump a detection counter and read the result back.
 *
 * `RETURNING` makes the promotion decision authoritative instead of inferred. The upsert
 * decides in the database at the instant of the write and reports the new count, so two runs racing on
 * one pair cannot both read `detections = 1` and both decline to promote.
 *
 * **The bump is idempotent WITHIN one run's instant.** `detections` advances only when `updated_at`
 * differs from `at`. Corroboration means "two DIFFERENT nights saw this", and conflict detection
 * commits only when something is promoted, so a run that judged pairs and promoted nothing leaves no
 * trailer and `memhtml sleep resume` re-executes it. Without the guard that second pass would count as a
 * second detection and promote a contradiction one night's evidence had not earned. That puts a machine
 * suspicion into a file, which is the exact one-way door the corroboration gate exists to hold.
 * `at` is derived from the run's own date, so a resume of the same run reuses it and a genuinely later
 * night does not.
 */
export const bumpCorroboration = (
  db: DatabaseShape,
  input: {
    readonly srcPath: string
    readonly rel: string
    readonly dstPath: string
    readonly at: string
  }
): Effect.Effect<ReadonlyArray<CorroborationRow>, StorageFailure> =>
  db.all<CorroborationRow>(
    `INSERT INTO ${STATE_SCHEMA}.edge_corroboration (src_path, rel, dst_path, detections, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(src_path, rel, dst_path) DO UPDATE SET
       detections = detections + CASE WHEN edge_corroboration.updated_at = excluded.updated_at THEN 0 ELSE 1 END,
       updated_at = excluded.updated_at
     RETURNING src_path, rel, dst_path, detections, promoted`,
    [input.srcPath, input.rel, input.dstPath, input.at]
  )

/** Mark a corroborated edge promoted, so a later run reads it as file-borne instead of pending. */
export const markPromoted = (
  db: DatabaseShape,
  input: {
    readonly srcPath: string
    readonly rel: string
    readonly dstPath: string
    readonly at: string
  }
): Effect.Effect<void, StorageFailure> =>
  db.run(
    `UPDATE ${STATE_SCHEMA}.edge_corroboration
     SET promoted = 1, confirmed = 1, updated_at = ?
     WHERE src_path = ? AND rel = ? AND dst_path = ?`,
    [input.at, input.srcPath, input.rel, input.dstPath]
  )

/** Sessions with no memory linked to them, which is what trace-consolidation counts in v1. */
export const unlinkedSessionCount = (db: DatabaseShape): Effect.Effect<number, StorageFailure> =>
  db
    .get<{ n: number }>(
      `SELECT count(*) AS n FROM traces t
       WHERE NOT EXISTS (SELECT 1 FROM memory_session_links l WHERE l.session_id = t.session_id)`
    )
    .pipe(Effect.map((row) => row?.n ?? 0))

/** One session trace-consolidation may read: its id and where its transcript lives. */
export interface UnconsolidatedSession {
  readonly session_id: string
  /** Absolute path to the JSONL under `MEMHTML_TRACE_ROOT`. The phase hands it over without opening it. */
  readonly file_path: string
  readonly file_size: number
  readonly file_mtime: string
}

/**
 * One session's manifest row: the session, its transcript, and the memories already linked to it.
 *
 * ## What the manifest is for, and why it is a join and not a file list
 *
 * The consolidator reads transcripts off a read-only mount and is handed this as its index
 * (`apps/consolidator/src/client.ts`, `manifestFor`). Two of the three groups of columns are here
 * because a TRANSCRIPT'S OWN BYTES DO NOT STATE THEM, so a model without them would either infer them
 * or work without them:
 *
 * - The session's identity and span: `slug`, `cwd`, `git_branch`, `started_at`, `ended_at`,
 *   `prompt_count`, `turn_count`. A JSONL file records turns; which project directory it was recorded
 *   under, and how long the session ran, are `traces` columns.
 * - The memories already linked to it, from `memory_session_links`. This is the expensive one and the
 *   reason the shape is a join. The bar in `agent/instructions.md` is "more signal than one grep", and
 *   a pattern already written down is not new signal. A model would otherwise read the corpus to
 *   discover that this session already produced a memory; one join answers it.
 *
 * ## One row PER LINK, deliberately flat
 *
 * A session with three linked memories comes back as three rows and a session with none as one row
 * carrying `memory_path: null`. Neither `group_concat` nor one query per session: a delimiter-joined
 * column would put a path inside a string that a `,` in a path would then split, and the loop is the
 * per-row round trip this module's other statements exist to avoid. {@link manifestRowsFor} is the
 * grouper, in TypeScript, where the grouping is a `Map` and not a SQL feature.
 */
export interface SessionManifestRow {
  readonly session_id: string
  readonly file_path: string
  readonly file_size: number
  readonly file_mtime: string
  readonly slug: string
  readonly cwd: string | null
  readonly git_branch: string | null
  readonly started_at: string | null
  readonly ended_at: string | null
  readonly prompt_count: number
  readonly turn_count: number
  /** `null` when the session has no linked memory at all: a LEFT JOIN miss, not an empty path. */
  readonly memory_path: string | null
  readonly link_kind: string | null
}

/**
 * The manifest rows for a named set of sessions.
 *
 * **`sessionIds` is bound, one `?` per id, and that is not optional.** Every value in this module
 * binds. An id interpolated into the text would reach SQL as syntax, and a session id from `traces` is
 * a value the trace scanner read out of a filename under `~/.claude/projects`.
 *
 * **The set is passed in instead of re-derived.** The caller already selected its batch through
 * {@link unconsolidatedSessions}, and re-running that selection here would be a second query free to
 * disagree with the first. The two would race a concurrently-written `trace_consolidations` row, and
 * the manifest would describe a batch the phase is not sending. So the batch is a parameter and this
 * statement is a pure lookup over it.
 *
 * **`ORDER BY t.file_mtime DESC` matches the batch's own order** so the manifest reads newest-first
 * like the selection did, then `session_id ASC` for a stable tie-break, then `l.path ASC` so a
 * session's linked memories are in a fixed order. That makes a generated manifest a pure
 * function of the plane and therefore assertable byte-for-byte.
 *
 * Measured plan (2026-08-12, node 24.19.0 against the shipped migrations):
 * `SEARCH t USING INDEX sqlite_autoindex_traces_1 (session_id=?)` then
 * `SEARCH l USING INDEX msl_session (session_id=?) LEFT-JOIN`. Both sides seek, `traces` by its
 * primary key and the links by `msl_session` (`packages/index/migrations/0005_traces.sql`), so the
 * cost is per-batch and not per-corpus.
 */
export const sessionManifestRows = (
  db: DatabaseShape,
  sessionIds: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<SessionManifestRow>, StorageFailure> =>
  sessionIds.length === 0
    ? Effect.succeed([])
    : db.all<SessionManifestRow>(
        `SELECT t.session_id AS session_id, t.file_path AS file_path, t.file_size AS file_size,
                t.file_mtime AS file_mtime, t.slug AS slug, t.cwd AS cwd,
                t.git_branch AS git_branch, t.started_at AS started_at, t.ended_at AS ended_at,
                t.prompt_count AS prompt_count, t.turn_count AS turn_count,
                l.path AS memory_path, l.link_kind AS link_kind
         FROM traces t
         LEFT JOIN memory_session_links l ON l.session_id = t.session_id
         WHERE t.session_id IN (${sessionIds.map(() => "?").join(", ")})
         ORDER BY t.file_mtime DESC, t.session_id ASC, l.path ASC, l.link_kind ASC`,
        [...sessionIds]
      )

/**
 * Sessions the sleep cycle has not distilled yet: big enough to hold something, settled enough to be
 * over, newest first, capped.
 *
 * **The anti-join is the trigger.** `trace_consolidations` holds one row per session already read, so
 * its absence is what makes a session a candidate, not a link count and not a memory's presence. Those
 * two are different questions. {@link unlinkedSessionCount} asks whether the AGENT wrote a memory
 * during a session, which stays interesting as a trend even after the cycle has read the transcript.
 *
 * **`file_size >= minBytes` skips a session that transacted nothing.** Measured over the live corpus
 * at `~/.claude/projects` on 2026-08-08 (11,361 transcripts): only 34 sit below 8 KiB, and each of
 * those holds 5-13 JSONL lines, a session opened and abandoned. p01 is 43.6 KB, so an 8 KiB floor
 * costs ~0.3% of sessions and none that did any work. The floor is a parameter, not a literal
 * here, so the caller states it and a test can move it.
 *
 * **`file_mtime < settledBefore` is the live-session guard.** A transcript is written by a process
 * that may still be running. Consolidating a session mid-turn would read half a conversation and
 * then watermark it as done, with the interesting part arriving after the row that says it was handled.
 * The caller derives the cutoff from the RUN's own instant, not from a clock.
 *
 * **`ORDER BY file_mtime DESC` + `LIMIT` is the first-run guard, and the order carries the policy.** A
 * fresh install faces a year of transcripts, and an uncapped batch would hand thousands of files to
 * one agent session. Newest-first is what makes the cap deliberate: the cycle
 * consolidates recent sessions first and works backwards a batch per night, so the memories it earns
 * soonest are the ones about what the agent is doing now.
 */
export const unconsolidatedSessions = (
  db: DatabaseShape,
  options: {
    readonly minBytes: number
    /** ISO-8601 instant a session's transcript must predate. Derived from the run, not a clock. */
    readonly settledBefore: string
    readonly limit: number
  }
): Effect.Effect<ReadonlyArray<UnconsolidatedSession>, StorageFailure> =>
  db.all<UnconsolidatedSession>(
    `SELECT t.session_id AS session_id, t.file_path AS file_path,
            t.file_size AS file_size, t.file_mtime AS file_mtime
     FROM traces t
     WHERE NOT EXISTS (
       SELECT 1 FROM trace_consolidations c WHERE c.session_id = t.session_id
     )
       AND t.file_size >= ?
       AND t.file_mtime < ?
     ORDER BY t.file_mtime DESC, t.session_id ASC
     LIMIT ?`,
    [options.minBytes, options.settledBefore, options.limit]
  )

/**
 * Mark sessions consolidated, as ONE batch.
 *
 * Written AFTER the phase's commits land, and that ordering is the crash-safety property. A process
 * killed between the commits and this write reconsolidates those sessions next night, which costs a
 * model call and produces a duplicate candidate a reviewer declines. The reverse order would lose the
 * transcripts silently: watermarked as read, with no memory to show for it and nothing anywhere
 * saying so.
 *
 * `writeAll`, not a loop, for the reason `replaceMinedEdges` gives: one batch per phase, and no
 * round trip per row.
 *
 * `ON CONFLICT DO UPDATE` instead of `DO NOTHING`, so a reconsolidation after a lost `index.db`
 * re-stamps the row with the run that actually re-read the session. A stale `run_id` pointing at a
 * branch that no longer exists is worse than no row, because it reads as provenance.
 *
 * An empty list needs no guard here: `writeAll` short-circuits a zero-length batch without touching
 * the database (`packages/index/src/database.ts:302-304`).
 */
export const markSessionsConsolidated = (
  db: DatabaseShape,
  input: {
    readonly runId: string
    readonly at: string
    readonly sessionIds: ReadonlyArray<string>
  }
): Effect.Effect<void, StorageFailure> =>
  db.writeAll(
    input.sessionIds.map((sessionId) => ({
      sql: `INSERT INTO trace_consolidations (session_id, run_id, consolidated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              run_id = excluded.run_id, consolidated_at = excluded.consolidated_at`,
      params: [sessionId, input.runId, input.at] as ReadonlyArray<string | number>
    }))
  )

/** How many sessions carry a consolidation watermark. A report count, and a test's read. */
export const consolidatedSessionCount = (
  db: DatabaseShape
): Effect.Effect<number, StorageFailure> =>
  db
    .get<{ n: number }>("SELECT count(*) AS n FROM trace_consolidations")
    .pipe(Effect.map((row) => row?.n ?? 0))

/** Sessions with at least one memory linked to them. */
export const linkedSessionCount = (db: DatabaseShape): Effect.Effect<number, StorageFailure> =>
  db
    .get<{ n: number }>(
      `SELECT count(DISTINCT t.session_id) AS n FROM traces t
       JOIN memory_session_links l ON l.session_id = t.session_id`
    )
    .pipe(Effect.map((row) => row?.n ?? 0))

/** A `<link rel="memhtml-*">` whose target is not in the tree. The integrity phase's input. */
export interface DanglingEdge {
  readonly src_path: string
  readonly rel: string
  readonly dst_path: string
}

/**
 * Authored edges pointing at a path the index does not hold.
 *
 * `derived = 0` only: a mined edge lives in the index and nowhere else, so a dangling one is
 * repaired by the next rebuild instead of by rewriting a file. This finds the ones that are in a
 * file, which are the ones a commit has to fix.
 */
export const danglingEdges = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<DanglingEdge>, StorageFailure> =>
  db.all<DanglingEdge>(
    `SELECT e.src_path AS src_path, e.rel AS rel, e.dst_path AS dst_path
     FROM edges e
     LEFT JOIN files f ON f.path = e.dst_path
     WHERE e.derived = 0 AND f.path IS NULL
     ORDER BY e.src_path ASC, e.rel ASC, e.dst_path ASC`
  )

/** Every indexed path, active or archived. The integrity phase's repair target set. */
export const allPaths = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<{ readonly path: string }>, StorageFailure> =>
  db.all<{ path: string }>("SELECT path FROM files ORDER BY path ASC")

/** A directory listing entry for the generated `index.html` files. */
export interface PublishRow {
  readonly path: string
  readonly title: string
  readonly gist: string
  readonly memory_type: string
  readonly updated_at: string
}

/** Every indexed file with what a generated listing shows. Path-ordered, so output is stable. */
export const publishRows = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<PublishRow>, StorageFailure> =>
  db.all<PublishRow>(
    `SELECT path, title, gist, memory_type, updated_at FROM files ORDER BY path ASC`
  )

/** A snapshot of the corpus's size, for the preflight and report counts. */
export interface CorpusSnapshot {
  readonly files: number
  readonly archived: number
  readonly chunks: number
  readonly embeddings: number
  readonly edges: number
  readonly derivedEdges: number
}

export const corpusSnapshot = (db: DatabaseShape): Effect.Effect<CorpusSnapshot, StorageFailure> =>
  db
    .get<{
      files: number
      archived: number
      chunks: number
      embeddings: number
      edges: number
      derived_edges: number
    }>(
      `SELECT
         (SELECT count(*) FROM files WHERE archived = 0) AS files,
         (SELECT count(*) FROM files WHERE archived = 1) AS archived,
         (SELECT count(*) FROM chunks) AS chunks,
         (SELECT count(*) FROM embeddings) AS embeddings,
         (SELECT count(*) FROM edges) AS edges,
         (SELECT count(*) FROM edges WHERE derived = 1) AS derived_edges`
    )
    .pipe(
      Effect.map((row) => ({
        files: row?.files ?? 0,
        archived: row?.archived ?? 0,
        chunks: row?.chunks ?? 0,
        embeddings: row?.embeddings ?? 0,
        edges: row?.edges ?? 0,
        derivedEdges: row?.derived_edges ?? 0
      }))
    )

/**
 * Replace this run's mined edges, then insert the new set.
 *
 * Scoped to `provenance = 'sleep'` so the delete cannot reach an authored edge, and applied as one
 * `writeAll` batch so a corpus is never left with the old mined set deleted and the new one not yet
 * written. In that window the lateral retrieval arm would return nothing.
 */
export const replaceMinedEdges = (
  db: DatabaseShape,
  input: {
    readonly runId: string
    readonly at: string
    readonly rel: string
    readonly pairs: ReadonlyArray<PairRow>
  }
): Effect.Effect<void, StorageFailure> =>
  db.writeAll([
    {
      sql: "DELETE FROM edges WHERE derived = 1 AND provenance = 'sleep' AND rel = ?",
      params: [input.rel]
    },
    ...input.pairs.map((pair) => ({
      sql: `INSERT INTO edges
              (src_path, rel, dst_path, edge_class, derived, strength, provenance, sleep_run, created_at)
            VALUES (?, ?, ?, 'memory', 1, ?, 'sleep', ?, ?)
            ON CONFLICT(src_path, rel, dst_path) DO UPDATE SET
              strength = excluded.strength, sleep_run = excluded.sleep_run`,
      params: [
        pair.src,
        input.rel,
        pair.dst,
        Math.max(0, Math.min(1, pair.sim)),
        input.runId,
        input.at
      ] as ReadonlyArray<string | number>
    }))
  ])

/** Record the run row. The one write a dry run makes, marked so a report can say so. */
export const recordRun = (
  db: DatabaseShape,
  input: {
    readonly runId: string
    readonly branch: string
    readonly baseSha: string
    readonly headSha: string | null
    readonly status: "running" | "review" | "merged" | "abandoned" | "failed"
    readonly startedAt: string
    readonly endedAt: string | null
  }
): Effect.Effect<void, StorageFailure> =>
  db.run(
    `INSERT INTO sleep_runs (run_id, branch, base_sha, head_sha, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET head_sha = excluded.head_sha, status = excluded.status,
       ended_at = excluded.ended_at`,
    [
      input.runId,
      input.branch,
      input.baseSha,
      input.headSha,
      input.status,
      input.startedAt,
      input.endedAt
    ]
  )

/** Record one phase row. Reporting only; the commit trailers are what a resume reads. */
export const recordPhase = (
  db: DatabaseShape,
  input: {
    readonly runId: string
    readonly phase: string
    readonly ordinal: number
    readonly status: string
    readonly commitSha: string | null
    readonly counts: string
    readonly error: string | null
    readonly llmCalls: number
    readonly startedAt: string
    readonly endedAt: string
  }
): Effect.Effect<void, StorageFailure> =>
  db.run(
    `INSERT INTO sleep_phases
       (run_id, phase, ordinal, status, commit_sha, counts, error, llm_calls, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, phase) DO UPDATE SET ordinal = excluded.ordinal, status = excluded.status,
       commit_sha = excluded.commit_sha, counts = excluded.counts, error = excluded.error,
       llm_calls = excluded.llm_calls, started_at = excluded.started_at, ended_at = excluded.ended_at`,
    [
      input.runId,
      input.phase,
      input.ordinal,
      input.status,
      input.commitSha,
      input.counts,
      input.error,
      input.llmCalls,
      input.startedAt,
      input.endedAt
    ]
  )

/** A recorded run, for `resume`, `review`, and `merge` to find their base. */
export interface RunRow {
  readonly run_id: string
  readonly branch: string
  readonly base_sha: string
  readonly head_sha: string | null
  readonly status: string
  readonly started_at: string
  readonly ended_at: string | null
}

export const readRun = (
  db: DatabaseShape,
  runId: string
): Effect.Effect<RunRow | undefined, StorageFailure> =>
  db.get<RunRow>(
    `SELECT run_id, branch, base_sha, head_sha, status, started_at, ended_at
     FROM sleep_runs WHERE run_id = ?`,
    [runId]
  )

/** The newest recorded run, for a `review`/`merge` with no run id. */
export const latestRun = (db: DatabaseShape): Effect.Effect<RunRow | undefined, StorageFailure> =>
  db.get<RunRow>(
    `SELECT run_id, branch, base_sha, head_sha, status, started_at, ended_at
     FROM sleep_runs ORDER BY started_at DESC, run_id DESC LIMIT 1`
  )

/** One recorded phase row, for `review` to report the run it did not itself execute. */
export interface PhaseRow {
  readonly phase: string
  readonly ordinal: number
  readonly status: string
  readonly commit_sha: string | null
  readonly counts: string
  readonly error: string | null
  readonly llm_calls: number
}

export const readPhases = (
  db: DatabaseShape,
  runId: string
): Effect.Effect<ReadonlyArray<PhaseRow>, StorageFailure> =>
  db.all<PhaseRow>(
    `SELECT phase, ordinal, status, commit_sha, counts, error, llm_calls
     FROM sleep_phases WHERE run_id = ? ORDER BY ordinal ASC`,
    [runId]
  )
