import type { StorageFailure } from "@memhtml/contracts/errors"
import { ARCHIVE_BUCKET, PEOPLE_DIR } from "@memhtml/contracts/paths"
import type { KeyedVector } from "@memhtml/domain"
import { float32View, rankCandidatePairs, topNeighborPairs } from "@memhtml/domain"
import type { DatabaseShape } from "@memhtml/index"
import { STATE_SCHEMA } from "@memhtml/index"
import { Effect } from "effect"

import type { PendingMark } from "./contract.js"

/**
 * Every read a phase makes against the index, in one module.
 *
 * Gathered here instead of inlined per phase because these statements are where the index's
 * reading semantics live: `archived = 0` for active, `derived = 0` for an authored contradiction,
 * and `edge_class = 'memory'` for anything that may enter the graph. A phase that wrote its own
 * `WHERE` would be a second reader of a producer's private rules.
 *
 * A phase's own mutations go through git. The statements here that are not reads are the reporting
 * rows, the derived-edge insert, and the MERGE-TIME appliers — the state-plane writes a phase records
 * as a `PendingMark` and `merge` performs, so discarding a branch discards everything the run decided.
 */

/**
 * The memory type no phase of a sleep cycle touches.
 *
 * A task is live working state, and every one of the seventeen phases is a judgment about REMEMBERED
 * FACTS: decay says a claim is fading, dedup says two claims are one, edge typing says one claim
 * caused or contradicts another, retention says a claim has stopped earning its place. None of those hold for
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
/**
 * The facet names that make a memory a DATED RECORD: one whose identity is a time slot rather than a
 * claim. A daily journal carries `day=2026-09-02`; two journals share vocabulary and entities, so they
 * cluster, but each is the only record of its day and neither restates the other.
 */
export const DATED_RECORD_FACETS: ReadonlyArray<string> = ["day"]

/**
 * The paths among `paths` that are dated `episodic` records: the members compress summarizes but never
 * archives (issue #130). A fold over such members writes its canonical as an entry point and leaves
 * them active, so a facet address like `day=<date>` keeps resolving.
 */
export const datedEpisodicAmong = (
  db: DatabaseShape,
  paths: ReadonlyArray<string>
): Effect.Effect<ReadonlySet<string>, StorageFailure> =>
  paths.length === 0
    ? Effect.succeed(new Set<string>())
    : db
        .all<{ path: string }>(
          `SELECT f.path AS path FROM files f
           WHERE f.memory_type = 'episodic'
             AND f.path IN (${paths.map(() => "?").join(", ")})
             AND EXISTS (SELECT 1 FROM file_facets x
                          WHERE x.path = f.path
                            AND x.name IN (${DATED_RECORD_FACETS.map(() => "?").join(", ")}))`,
          [...paths, ...DATED_RECORD_FACETS]
        )
        .pipe(Effect.map((rows) => new Set(rows.map((row) => row.path))))

/**
 * The active paths that already carry an authored `part_of` edge to an ACTIVE file: the dated records
 * compress has summarized on an earlier run. Compress stamps that edge on every member it keeps, and
 * this is what keeps the same journals from being re-banded and re-folded into a second canonical the
 * next night: a kept member's retention inputs do not change by being summarized, so without a mark
 * the pass would select it again. Read at pass time, so a canonical archived since (its edge then
 * points at an archived file) releases its members for a fresh fold.
 */
export const summarizedDatedRecords = (
  db: DatabaseShape
): Effect.Effect<ReadonlySet<string>, StorageFailure> =>
  db
    .all<{ path: string }>(
      `SELECT DISTINCT e.src_path AS path FROM edges e
       JOIN files f ON f.path = e.src_path AND f.archived = 0
       JOIN files c ON c.path = e.dst_path AND c.archived = 0
       WHERE e.rel = 'part_of' AND e.edge_class = 'memory' AND e.derived = 0`
    )
    .pipe(Effect.map((rows) => new Set(rows.map((row) => row.path))))

export const activeCorpus = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<CorpusRow>, StorageFailure> =>
  db.all<CorpusRow>(
    `SELECT path, memory_type, title, gist, body_text, content_hash, confidence, importance,
            word_count, created_at, updated_at, valid_until, reprieves
     FROM files WHERE archived = 0 ORDER BY created_at ASC, path ASC`
  )

/**
 * The most recently touched active NON-TASK memories, newest first, capped.
 *
 * Task detection's candidate slice. Issue #44 asks for "recent/high-salience", and this is the RECENT
 * half alone, which is the deliberate cut. The salience half would mean a retention pass — label
 * propagation plus PageRank over the whole edge list plus the access plane — for a scan whose job is
 * to notice text nobody has resolved yet, and salience measures the opposite: how much a memory has
 * been leaned on since it was written. A commitment made last night has no access history at all, so
 * ranking by salience would systematically rank the phase's best candidates last.
 *
 * `updated_at DESC` and not `created_at`, because a memory CORRECTED yesterday carries yesterday's
 * text, which is the text a commitment would be in. `path ASC` breaks the tie, so the slice — and
 * therefore the batch boundaries and the `m1`..`mN` keys — is a function of the corpus rather than of
 * the order rows came back in.
 *
 * Tasks are excluded here, in the statement, matching every other read in this module. That is the
 * no-self-referential-loop guard issue #44 names, and putting it in SQL rather than in the phase means
 * a detected task cannot become evidence of another task even if a caller forgot to filter. The phase
 * carries a second, path-level check for the same invariant, because this one is keyed on a projected
 * column and the projection is refreshed once per night.
 */
export const recentActiveMemories = (
  db: DatabaseShape,
  options: { readonly limit: number }
): Effect.Effect<ReadonlyArray<CorpusRow>, StorageFailure> =>
  db.all<CorpusRow>(
    `SELECT path, memory_type, title, gist, body_text, content_hash, confidence, importance,
            word_count, created_at, updated_at, valid_until, reprieves
     FROM files
     WHERE archived = 0 AND memory_type NOT IN (${typePlaceholders()})
     ORDER BY updated_at DESC, path ASC
     LIMIT ?`,
    [...SLEEP_EXCLUDED_TYPES, options.limit]
  )

/** One candidate pair from a vector neighborhood, unoriented. */
export interface PairRow {
  readonly src: string
  readonly dst: string
  /** Cosine similarity, unitless in `[-1, 1]`, bit-identical to `@memhtml/domain`'s `cosine`. */
  readonly sim: number
}

/** A `memory_type NOT IN (…)` clause against alias `f`, or nothing when nothing is excluded. */
const typeFilterFor = (alias: string, excluded: ReadonlyArray<string>): string =>
  excluded.length === 0
    ? ""
    : ` AND ${alias}.memory_type NOT IN (${excluded.map(() => "?").join(", ")})`

/**
 * Every active file's first-chunk vector, decoded ONCE into the shape the pair kernel ranks.
 *
 * `ordinal = 0` collapses a file to its first chunk, not its best chunk. The format is one
 * fact per file, so almost every file is a single chunk. Taking the first keeps the pair set
 * symmetric, which `min(distance)` over all chunks would not. An asymmetric neighborhood
 * would make `(a, b)` a candidate while `(b, a)` is not, so which of two files was read first
 * would decide whether they merge.
 *
 * A row whose blob does not decode (empty or ragged) is dropped, the same exclusion the SQL
 * UDF's NULL produces for it in the retrieval arm.
 */
const firstChunkVectors = (
  db: DatabaseShape,
  excluded: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<KeyedVector>, StorageFailure> =>
  db
    .all<{ readonly path: string; readonly vec: Uint8Array }>(
      `SELECT f.path AS path, e.vec AS vec
       FROM files f
       JOIN chunks c ON c.path = f.path AND c.ordinal = 0
       JOIN embeddings e ON e.chunk_id = c.chunk_id
       WHERE f.archived = 0${typeFilterFor("f", excluded)}`,
      [...excluded]
    )
    .pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const vec = float32View(row.vec)
          return vec === undefined ? [] : [{ key: row.path, vec }]
        })
      )
    )

/**
 * Per-source top-`k` nearest neighbors above a similarity floor, over first-chunk vectors.
 *
 * The corpus filter is SQL, because that is where the index's reading semantics live. The pair
 * space is n² and ranks in TypeScript (`topNeighborPairs`), because a pair routed through the
 * `vector_distance_cos` UDF pays a fresh decode of BOTH 4 KB blobs per call — at a ~3k corpus
 * that is 8.45M calls and an OOM before the first phase records (issue #40), against ~12 MB
 * decoded once. The kernel reproduces this ordering exactly: floor, then per-source `sim` DESC /
 * `dst` ASC, then global `sim` DESC / `src` ASC / `dst` ASC, then the cap.
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
): Effect.Effect<ReadonlyArray<PairRow>, StorageFailure> =>
  firstChunkVectors(db, options.excludeTypes ?? []).pipe(
    Effect.map((vectors) =>
      topNeighborPairs(vectors, {
        floor: options.floor,
        perSourceK: options.perSourceK,
        limit: options.limit
      })
    )
  )

/**
 * Active non-task pairs that occupy the SAME frame key. Dedup's component seeds.
 *
 * A frame key is a claim's slot as surface grammar states it, so two active memories sharing one are
 * making a claim about the same thing by the corpus's own indexed evidence — no cosine, no model.
 * That is signal the vector floor can miss: "the owner of the deploy runbook is Priya" and "the owner
 * of the deploy runbook is Priya Raman" share a slot while their bodies share almost no vocabulary,
 * and their measured cosine under the fixture embedder is 0.59, far under any floor a night could
 * afford to mine at. Seeding components with these pairs puts them in front of the model, which is
 * the only reader that can say whether one is a rewording of the other.
 *
 * **The statement is OUTPUT-SENSITIVE: its cost follows the frame sharing that exists, not the pair
 * space.** The self-join is an equality on `frame_key`, which `files_frame_key_active` indexes under
 * exactly this predicate (`archived = 0 AND memory_type <> 'task' AND frame_key IS NOT NULL`,
 * migration 0009). So each row seeks its own key's bucket and emits one row per co-occupant, and a
 * corpus where no two memories share a slot emits nothing having read no pairs. `frame_key IS NOT
 * NULL` is stated even though the join equality already excludes NULL, because it is what makes the
 * partial index usable rather than leaving the planner to prove it.
 *
 * `r.path < l.path` orients each unordered pair once, which keeps the seed set the same size as the
 * edge set the component builder wants.
 *
 * **`memory_type <> 'task'` is written as the LITERAL the index uses, not as this module's
 * {@link SLEEP_EXCLUDED_TYPES} binding.** It is the same exclusion for the same reason — two open
 * tasks phrased alike are two things to do — but `NOT IN (?)` and `<> 'task'` are different
 * expressions to the planner, and only the second one matches `files_frame_key_active`'s predicate.
 * A bound form here would read as more general while quietly turning the seek into a scan.
 * `activeFramesFor` writes the literal for the same reason. `tests/units.test.ts` holds the two in
 * agreement, so a change to the excluded set cannot leave this statement behind silently.
 *
 * Measured plan (2026-08-19, node 24.19.0 against the shipped migrations): `SCAN l` then
 * `SEARCH r USING INDEX files_frame_key_active (frame_key=?)`. One side walks the KEYED rows, which
 * the partial index confines to the rows with a frame at all, and the other seeks.
 */
export const frameKeyPairs = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<{ readonly src: string; readonly dst: string }>, StorageFailure> =>
  db.all<{ src: string; dst: string }>(
    `SELECT l.path AS src, r.path AS dst
     FROM files l
     JOIN files r ON r.frame_key = l.frame_key AND r.path < l.path
       AND r.archived = 0 AND r.memory_type <> 'task' AND r.frame_key IS NOT NULL
     WHERE l.archived = 0 AND l.memory_type <> 'task' AND l.frame_key IS NOT NULL
     ORDER BY l.path ASC, r.path ASC`
  )

/**
 * Candidate pairs for edge typing: embedding-near, sharing an entity, and carrying no
 * AUTHORED edge between them in either direction.
 *
 * The shared-entity requirement is what keeps the model budget on pairs that could actually be about
 * one thing. The anti-join keeps the phase from re-typing a pair an agent already linked. An
 * authored `contradicts` or `caused_by` is a settled fact, and re-asking the model about it would let
 * a `none` answer look like new information.
 *
 * **`derived = 0` is what makes the anti-join correct.** Relationship mining runs one phase EARLIER and
 * writes a derived `relates_to` for every pair above 0.85 cosine, a strict superset of the
 * pairs above the 0.80 typing floor. An anti-join over ALL edges therefore excludes every candidate
 * this scan exists to find, and the phase reports `candidates: 0` forever with no error anywhere.
 * A mined edge is a machine suspicion, not a settled relationship; only an authored one closes a pair.
 * {@link minedPairs} reads that same mined set as the OTHER arm of edge typing's candidate union, and
 * carries the identical anti-join for the identical reason.
 *
 * The statement ENUMERATES pairs from the shared-entity join instead of filtering an n×n vector
 * self-join, so its cost follows the entity sharing that actually exists. Similarity then ranks in
 * TypeScript over vectors decoded once (`rankCandidatePairs`), with the enumerated set standing
 * where the ranking CTE's `WHERE` stood: the predicates run BEFORE per-source top-`k`. `re.path <
 * le.path` orients each pair once, dst below src.
 */
export const sharedEntityPairs = (
  db: DatabaseShape,
  options: {
    readonly floor: number
    readonly perSourceK: number
    readonly limit: number
    /**
     * Memory types to exclude, the same hole {@link neighborPairs} carries. `task` is excluded
     * because a task is intended work, not an asserted fact, so "these two contradict" and "this
     * one caused that one" are not judgments that can be true of it. Paying for a model call to
     * find out would also spend the candidate budget on rows no phase acts on.
     */
    readonly excludeTypes?: ReadonlyArray<string> | undefined
  }
): Effect.Effect<ReadonlyArray<PairRow>, StorageFailure> => {
  const excluded = options.excludeTypes ?? []
  const pairs = db.all<{ readonly src: string; readonly dst: string }>(
    `SELECT DISTINCT le.path AS src, re.path AS dst
     FROM file_entities le
     JOIN file_entities re ON re.entity_type = le.entity_type
       AND re.entity_name = le.entity_name AND re.path < le.path
     JOIN files fl ON fl.path = le.path AND fl.archived = 0${typeFilterFor("fl", excluded)}
     JOIN files fr ON fr.path = re.path AND fr.archived = 0${typeFilterFor("fr", excluded)}
     WHERE NOT EXISTS (
       SELECT 1 FROM edges e
       WHERE e.derived = 0
         AND ((e.src_path = le.path AND e.dst_path = re.path)
           OR (e.src_path = re.path AND e.dst_path = le.path))
     )`,
    [...excluded, ...excluded]
  )
  return Effect.all([pairs, firstChunkVectors(db, excluded)]).pipe(
    Effect.map(([candidatePairs, vectors]) =>
      rankCandidatePairs(candidatePairs, vectors, {
        floor: options.floor,
        perSourceK: options.perSourceK,
        limit: options.limit
      })
    )
  )
}

/**
 * The MINED edges of one rel, as candidate pairs: edge typing's second arm.
 *
 * Relationship mining runs one phase earlier and writes a derived `relates_to` for every pair above
 * its cosine floor, index-only. Those pairs are the corpus's own answer to "which memories look
 * related", and they are NOT a subset of {@link sharedEntityPairs}: two memories about one incident
 * that name no entity in common are invisible to the shared-entity join and obvious to the embedder.
 * Reading them here is what makes edge typing's recall the union of both signals rather than the
 * entity-authoring habits of whoever wrote the memories.
 *
 * `strength` is the mined edge's own cosine (`replaceMinedEdges` clamps it into `[0, 1]`), so the
 * caller can rank both arms of the union on one scale without re-decoding a vector. The statement
 * ORDERS BY it, descending, for the same reason {@link sharedEntityPairs} hands back a ranked list:
 * the caller's cap is a model-cost bound, and a cap over a path-ordered read would spend the night on
 * whichever pairs sort alphabetically first. `src_path` then `dst_path` break a tie, which is
 * `collectRanked`'s ordering, so both arms of the union arrive in one ordering.
 *
 * **Deliberately unbounded**, unlike the other arm: the caller ranks the UNION and caps that, so a
 * limit here would cut candidates before the two arms have been compared. The mined set is one row per
 * pair above mining's cosine floor (measured 1,498 on the production corpus), which is a read this
 * phase already performs once a night.
 *
 * Three filters, each load-bearing:
 *
 * - `derived = 1` restricts this to the machine-mined set. An authored `relates_to` is an agent's
 *   assertion, and re-typing it would let an unattended run overwrite a human judgment with a narrower rel.
 * - `edge_class = 'memory'` is the same firewall every graph read carries.
 * - The `derived = 0` anti-join drops a pair that already carries ANY authored edge either way, which
 *   is exactly {@link sharedEntityPairs}' rule. Without it a pair typed last night would be re-judged
 *   every night, because promoting a typed edge does not delete the mined `relates_to` underneath it.
 */
export const minedPairs = (
  db: DatabaseShape,
  options: {
    readonly rel: string
    /** The same `task` hole the rest of this module carries, applied to BOTH endpoints. */
    readonly excludeTypes?: ReadonlyArray<string> | undefined
  }
): Effect.Effect<ReadonlyArray<PairRow>, StorageFailure> => {
  const excluded = options.excludeTypes ?? []
  return db.all<PairRow>(
    `SELECT e.src_path AS src, e.dst_path AS dst, e.strength AS sim
     FROM edges e
     JOIN files fs ON fs.path = e.src_path AND fs.archived = 0${typeFilterFor("fs", excluded)}
     JOIN files fd ON fd.path = e.dst_path AND fd.archived = 0${typeFilterFor("fd", excluded)}
     WHERE e.derived = 1 AND e.edge_class = 'memory' AND e.rel = ?
       AND NOT EXISTS (
         SELECT 1 FROM edges a
         WHERE a.derived = 0
           AND ((a.src_path = e.src_path AND a.dst_path = e.dst_path)
             OR (a.src_path = e.dst_path AND a.dst_path = e.src_path))
       )
     ORDER BY e.strength DESC, e.src_path ASC, e.dst_path ASC`,
    [...excluded, ...excluded, options.rel]
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
 * an unattended run editing live working state.
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

/** One (entity, claiming file) pair, and the title that file carries. */
export interface EntityClaim {
  readonly entity_type: string
  readonly entity_name: string
  readonly path: string
  readonly title: string
}

/**
 * Every (entity, claiming active non-task file) pair in ONE statement, entity-ordered then path.
 *
 * The same corpus {@link activeEntities} counts, enumerated instead of aggregated. Entity resolution
 * needs both a per-entity memory centroid and a few sample titles per entity, and deriving either from
 * {@link pathsForEntity} would be one query per entity — 59 entities on the measured corpus, and one
 * round trip each for a join the database performs once.
 *
 * **The `ORDER BY` is for a reader, NOT for the centroid's determinism.** A centroid is a sum over its
 * members' vectors and float addition is not associative, so the summation order decides the bytes —
 * but `entityCentroids` re-sorts each entity's paths itself and does not inherit this order. That is
 * deliberate: the guarantee has to live where the sum happens, so a future caller reading these rows
 * through a different statement cannot silently lose it. (Confirmed by mutation: replacing this clause
 * with `ORDER BY e.path DESC` leaves the whole sleep suite green, while dropping the phase's own sort
 * fails it.)
 */
export const entityClaims = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<EntityClaim>, StorageFailure> =>
  db.all<EntityClaim>(
    `SELECT e.entity_type AS entity_type, e.entity_name AS entity_name,
            e.path AS path, f.title AS title
     FROM file_entities e JOIN files f ON f.path = e.path
     WHERE f.archived = 0 AND f.memory_type NOT IN (${typePlaceholders()})
     ORDER BY e.entity_type ASC, e.entity_name ASC, e.path ASC`,
    [...SLEEP_EXCLUDED_TYPES]
  )

/**
 * Every active file's first-chunk vector, path-keyed and decoded once. The centroid pass's input.
 *
 * Exported wrapper over the module-private statement the pair arms use, so entity resolution reads the
 * SAME vector space they do — `ordinal = 0`, the same drop of a blob that does not decode — instead of
 * a second SELECT free to disagree about which chunk represents a file.
 *
 * Tasks are excluded, matching {@link entityClaims}: a centroid built partly from working state would
 * describe what the agent intends to do about a subject rather than what it knows about one.
 */
export const entityVectors = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<KeyedVector>, StorageFailure> =>
  firstChunkVectors(db, SLEEP_EXCLUDED_TYPES)

/**
 * Every indexed person file, path-ordered. The alias oracle's file list.
 *
 * Selected by DIRECTORY, because that is what a person file is: `person-links` mints one per
 * `person:` entity under `PEOPLE_DIR`, and a hand-authored one placed there by an operator is just as
 * authoritative. Selecting by entity instead would miss a file whose subject the corpus has since
 * stopped mentioning, whose declaration is still the truth about those names.
 *
 * Archived files are included. Archiving a person file records that the corpus moved on from the
 * person, not that two of their names stopped being the same name, and an alias declaration losing its
 * force on archival would silently re-split a person the phase had already merged.
 *
 * **Which is why the archive prefix is matched too, and not just `archived = 0` left off.** Eviction is
 * the `git mv` into `archive/<YYYY>/<original-path>`, so an archived person file's PATH is
 * `archive/2026/resources/people/…` and no longer matches `resources/people/%` at all. A single
 * `LIKE` here would have said "archived files are included" while excluding every one of them, and the
 * re-split above is exactly what would have followed. The second pattern mirrors
 * `archivePathFor`'s shape (`%` for the year segment, which is four digits the statement need not
 * verify — a false match would be another file under `resources/people/`, which is a person file).
 *
 * The phase reads the BYTES of each of these; this statement only says which paths to open, because
 * `memhtml-alias` is repeatable and lives in the file rather than in any projection.
 */
export const peoplePaths = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<{ readonly path: string }>, StorageFailure> =>
  db.all<{ path: string }>(
    "SELECT path FROM files WHERE path LIKE ? OR path LIKE ? ORDER BY path ASC",
    [`${PEOPLE_DIR}/%`, `${ARCHIVE_BUCKET}/%/${PEOPLE_DIR}/%`]
  )

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
 *
 * **The deep grouping band is excluded, and the exclusion is what keeps DEFAULT-run scoring stable
 * across deep runs (issue #63).** Deep mining writes machine-mined `laterally_related` edges at a
 * floor (0.72) far below the default one, purely so label propagation can partition the inbox tail
 * for compress. Those edges persist in the index after the deep run, so without this predicate the
 * FIRST deep run would permanently change every subsequent default run's PageRank, communities, and
 * bridge counts — and therefore its eviction decisions — on a corpus whose files did not change.
 * The filter names `derived = 1` as well as the rel, so an AUTHORED `laterally_related` (an agent's
 * own assertion, addable through `memhtml link`) keeps exactly the graph standing it had.
 * {@link deepGroupingEdges} is the one reader of the band.
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
       AND NOT (e.derived = 1 AND e.rel = 'laterally_related')
     ORDER BY e.src_path ASC, e.rel ASC, e.dst_path ASC`
  )

/**
 * The deep grouping band: machine-mined `laterally_related` edges over active files (issue #63).
 *
 * The mirror of {@link memoryEdges}' exclusion, and deliberately a separate read instead of a flag on
 * it: the band has exactly one consumer intent — widening label propagation's partition for the deep
 * compress and placement phases — and a parameterized `memoryEdges` would let any caller widen the
 * retention graph by passing a boolean. `provenance = 'sleep'` is implied by `derived = 1` (the
 * table CHECK pins the pair) and stated anyway so the statement reads as what it is.
 */
export const deepGroupingEdges = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<EdgeRow>, StorageFailure> =>
  db.all<EdgeRow>(
    `SELECT e.src_path AS src_path, e.rel AS rel, e.dst_path AS dst_path,
            e.strength AS strength, e.derived AS derived
     FROM edges e
     JOIN files s ON s.path = e.src_path AND s.archived = 0
     JOIN files d ON d.path = e.dst_path AND d.archived = 0
     WHERE e.edge_class = 'memory' AND e.derived = 1 AND e.rel = 'laterally_related'
       AND e.provenance = 'sleep'
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
 * differs from `at`. Corroboration means "two DIFFERENT nights saw this", and edge typing
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

/**
 * Mark a corroborated edge promoted, so a later run reads it as file-borne instead of pending.
 *
 * **A MERGE-TIME write, and the single-mark form of {@link applyPendingMarks} rather than a second
 * statement.** `promoted = 1` takes the pair out of edge typing's promotion path permanently, and
 * `.memhtml/state.db` is the one plane a discarded branch cannot undo — so a phase that set it directly
 * would make its own abort partial: the branch's `<link rel="memhtml-contradicts">` goes away with the
 * branch and the flag saying the corpus already carries it does not, and no later night writes the edge
 * again. The phase records an `edge-promoted` `PendingMark` instead and the merge performs it.
 */
export const markPromoted = (
  db: DatabaseShape,
  input: {
    readonly srcPath: string
    readonly rel: string
    readonly dstPath: string
    readonly at: string
  }
): Effect.Effect<void, StorageFailure> =>
  applyPendingMarks(db, [
    {
      kind: "edge-promoted",
      srcPath: input.srcPath,
      rel: input.rel,
      dstPath: input.dstPath,
      at: input.at
    }
  ]).pipe(Effect.asVoid)

/**
 * One mark as the statement that performs it. The merge-time half of the ledger, one arm per kind.
 *
 * A total switch over the union, so a `PendingMark` arm added without an applier is a compile error
 * rather than a mark a merge silently drops. That direction matters more than the reverse: a kind with
 * no producer is dead code a reader can find, while a kind with no applier is a write a run earns,
 * commits, and never makes.
 */
const statementFor = (
  mark: PendingMark
): { readonly sql: string; readonly params: ReadonlyArray<string | number> } => {
  switch (mark.kind) {
    case "session-consolidated":
      return {
        /**
         * `ON CONFLICT DO UPDATE` instead of `DO NOTHING`, so a reconsolidation after a lost
         * `index.db` re-stamps the row with the run that actually re-read the session. A stale
         * `run_id` pointing at a branch that no longer exists is worse than no row, because it
         * reads as provenance.
         */
        sql: `INSERT INTO trace_consolidations (session_id, run_id, consolidated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                run_id = excluded.run_id, consolidated_at = excluded.consolidated_at`,
        params: [mark.sessionId, mark.runId, mark.at]
      }
    case "edge-promoted":
      return {
        sql: `UPDATE ${STATE_SCHEMA}.edge_corroboration
              SET promoted = 1, confirmed = 1, updated_at = ?
              WHERE src_path = ? AND rel = ? AND dst_path = ?`,
        params: [mark.at, mark.srcPath, mark.rel, mark.dstPath]
      }
    case "entity-promoted":
      /**
       * All THREE key columns in the `WHERE`, and the pair unsorted. `(entity_type, alias_name,
       * canonical_name)` is the row's primary key and the orientation distinguishes two rows the table
       * keeps apart — the merge one way and the merge back — so a clause that dropped the type, or that
       * sorted the names, would promote a row the run never counted.
       */
      return {
        sql: `UPDATE ${STATE_SCHEMA}.entity_corroboration
              SET promoted = 1, confirmed = 1, updated_at = ?
              WHERE entity_type = ? AND alias_name = ? AND canonical_name = ?`,
        params: [mark.at, mark.entityType, mark.aliasName, mark.canonicalName]
      }
  }
}

/**
 * Apply a merged run's pending state-plane marks, as ONE transaction. Returns how many were applied.
 *
 * **One `writeAll` batch, so the plane takes all of them or none.** A merge that applied half a
 * ledger would leave some sessions watermarked and the rest not, from one artifact, with nothing
 * recording where it stopped.
 *
 * **Every statement is idempotent, because a merge retries.** The watermark is an upsert on
 * `session_id`; both promotions are an `UPDATE … SET promoted = 1` that a second application re-states.
 * So applying one ledger twice reaches the same plane as applying it once, which is what lets a
 * caller re-run `merge` after a failure without reasoning about what the first attempt reached.
 *
 * Ledger ORDER is preserved, which is the order `contract.ts`'s `appendPendingMarks` records in: a
 * promotion presumes the counter row its own phase created, and the reverse order would update a row
 * that is not there.
 */
export const applyPendingMarks = (
  db: DatabaseShape,
  marks: ReadonlyArray<PendingMark>
): Effect.Effect<number, StorageFailure> =>
  db.writeAll(marks.map(statementFor)).pipe(Effect.as(marks.length))

/** One corroboration counter on a machine-proposed entity merge. */
export interface EntityCorroborationRow {
  readonly entity_type: string
  readonly alias_name: string
  readonly canonical_name: string
  readonly detections: number
  readonly promoted: number
}

/**
 * Bump an entity merge's detection counter and read the result back.
 *
 * The same `RETURNING` upsert {@link bumpCorroboration} uses, for the same reason: the promotion
 * decision is made in the database at the instant of the write, so two runs racing on one merge cannot
 * both read `detections = 1` and both decline to apply it, leaving a genuinely corroborated merge
 * pending forever.
 *
 * **And the bump is idempotent WITHIN one run's instant**, which entity resolution needs even more than
 * conflict detection does. This phase commits whenever it rewrites ANY file, so a night whose only work
 * was a deterministic normalization commits and leaves a trailer, while a night that only bumped
 * counters does not. `memhtml sleep resume` therefore re-executes this phase on the second pass, and
 * without the `updated_at` guard that pass would count as a second night's independent sighting and
 * apply a merge one night's evidence had not earned. `at` comes from the run's own date, so a resume of
 * the same run reuses it and a genuinely later night does not.
 *
 * Names are the NORMALIZED forms, which is what makes one merge one counter: `Checkout API` and
 * `checkout api` would otherwise be two rows for one merge and neither would reach two detections.
 *
 * **The bump happens DURING the phase while {@link markEntityPromoted} waits for the merge, and the line
 * between them is what each column MEANS.** `detections` counts nights on which a model, reading the
 * corpus, proposed this merge — a discarded night did read the corpus and did propose it, so the sighting
 * is true whether or not the branch landed, and deferring the bump would also cost the `RETURNING` race
 * guard above (a projected count is a second reader of this statement's own `updated_at` rule).
 * `promoted`/`confirmed` instead assert that the corpus CARRIES the rewrite, which a discarded branch
 * makes false. So the counter is phase-time and the flag is merge-time. {@link bumpCorroboration} splits
 * on the same line for the same reason.
 */
export const bumpEntityCorroboration = (
  db: DatabaseShape,
  input: {
    readonly entityType: string
    readonly aliasName: string
    readonly canonicalName: string
    readonly at: string
  }
): Effect.Effect<ReadonlyArray<EntityCorroborationRow>, StorageFailure> =>
  db.all<EntityCorroborationRow>(
    `INSERT INTO ${STATE_SCHEMA}.entity_corroboration
       (entity_type, alias_name, canonical_name, detections, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(entity_type, alias_name, canonical_name) DO UPDATE SET
       detections = detections + CASE
         WHEN entity_corroboration.updated_at = excluded.updated_at THEN 0 ELSE 1 END,
       updated_at = excluded.updated_at
     RETURNING entity_type, alias_name, canonical_name, detections, promoted`,
    [input.entityType, input.aliasName, input.canonicalName, input.at]
  )

/**
 * Mark a corroborated merge applied, so the plane records the rewrite the corpus carries.
 *
 * **A MERGE-TIME write, and the single-mark form of {@link applyPendingMarks} rather than a second
 * statement**, the same shape {@link markPromoted} has and for a stronger version of its reason.
 * `promoted = 1, confirmed = 1` asserts that every `memhtml-entity` meta naming the alias has been
 * rewritten onto the canonical, and that rewrite spans every file claiming the name. It lives on the
 * sleep branch; the flag lives in `.memhtml/state.db`, which no `git branch -D` can undo and no index
 * rebuild can re-derive. A phase that set it directly would leave a discarded run's plane asserting a
 * corpus-wide rename that no file carries. The phase records an `entity-promoted` `PendingMark` in the
 * run's ledger instead and `merge` performs it once the rewrites are on `main`.
 */
export const markEntityPromoted = (
  db: DatabaseShape,
  input: {
    readonly entityType: string
    readonly aliasName: string
    readonly canonicalName: string
    readonly at: string
  }
): Effect.Effect<void, StorageFailure> =>
  applyPendingMarks(db, [
    {
      kind: "entity-promoted",
      entityType: input.entityType,
      aliasName: input.aliasName,
      canonicalName: input.canonicalName,
      at: input.at
    }
  ]).pipe(Effect.asVoid)

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
 * The predicate that makes a session a CANDIDATE, as one clause two statements bind.
 *
 * Written once because {@link unconsolidatedSessions} selects the batch and
 * {@link settledSessionCount} counts the whole set, and a second copy of a selection rule is what lets
 * a plan report a number the phase does not agree with. Two parameters, in this order: `minBytes`, then
 * the settled-before instant.
 */
const SETTLED_SESSION_WHERE = `WHERE NOT EXISTS (
       SELECT 1 FROM trace_consolidations c WHERE c.session_id = t.session_id
     )
       AND t.file_size >= ?
       AND t.file_mtime < ?`

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
 * one agent session. Newest-first is what makes the cap deliberate: the cycle consolidates recent
 * sessions first and works backwards one batch per run, so the memories it earns soonest are the ones
 * about what the agent is doing now.
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
     ${SETTLED_SESSION_WHERE}
     ORDER BY t.file_mtime DESC, t.session_id ASC
     LIMIT ?`,
    [options.minBytes, options.settledBefore, options.limit]
  )

/**
 * How many sessions the consolidation phase WOULD have to choose from, unbounded by its per-run cap.
 *
 * The same clause {@link unconsolidatedSessions} binds, counted rather than paged, so a read that
 * reports the backlog cannot disagree with the phase about what a candidate is. The batch cap is a
 * separate fact the caller reports beside it: a count of 40 with a cap of 10 is four runs of work, and
 * a count that had been clamped to the cap would read as one.
 */
export const settledSessionCount = (
  db: DatabaseShape,
  options: { readonly minBytes: number; readonly settledBefore: string }
): Effect.Effect<number, StorageFailure> =>
  db
    .get<{ n: number }>(
      `SELECT count(*) AS n FROM traces t
     ${SETTLED_SESSION_WHERE}`,
      [options.minBytes, options.settledBefore]
    )
    .pipe(Effect.map((row) => row?.n ?? 0))

/**
 * Mark sessions consolidated, as ONE batch.
 *
 * **A MERGE-TIME write, reached through {@link applyPendingMarks} and not from a phase.** This table is
 * the anti-join {@link unconsolidatedSessions} selects on, so a row here removes its session from every
 * future batch — and it survives both `git branch -D` and `memhtml index rebuild` (migration 0010
 * records why). A phase that wrote it directly would make the abort partial in the one direction that
 * costs content: the branch's distilled memories go away with the branch and the row asserting the
 * transcript was handled stays, so the transcript is never read again. The phase records a
 * `PendingMark` on the branch instead, and this runs once the merge has landed the memories.
 *
 * Expressed as {@link applyPendingMarks} over `session-consolidated` marks rather than as its own
 * statement, so the upsert and its conflict clause exist once. One `writeAll` batch either way, for the
 * reason `replaceMinedEdges` gives: one batch, and no round trip per row.
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
  applyPendingMarks(
    db,
    input.sessionIds.map((sessionId) => ({
      kind: "session-consolidated" as const,
      sessionId,
      runId: input.runId,
      at: input.at
    }))
  ).pipe(Effect.asVoid)

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

/**
 * Authored memory-class edges POINTING AT one path: which files hold a `<link>` a move must rewrite.
 *
 * Placement triage's read (issue #63). `derived = 0` because a mined edge lives only in the index
 * and the next re-mine follows the moved vectors on its own; only a file-borne link needs a splice.
 * Both memory and task classes are included — a task may `blocks`-link a memory it waits on, and a
 * move that left that href dangling would break the task surface — but provenance and person edges
 * cannot point at an inbox memory by construction.
 */
export const inboundAuthoredEdges = (
  db: DatabaseShape,
  dstPath: string
): Effect.Effect<
  ReadonlyArray<{ readonly src_path: string; readonly rel: string }>,
  StorageFailure
> =>
  db.all<{ src_path: string; rel: string }>(
    `SELECT e.src_path AS src_path, e.rel AS rel
     FROM edges e
     WHERE e.derived = 0 AND e.dst_path = ?
     ORDER BY e.src_path ASC, e.rel ASC`,
    [dstPath]
  )

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

/**
 * Record the run row. The one write a dry run makes, marked so a report can say so.
 *
 * The upsert replaces the whole row: a run id is reused when a date's branch is deleted and the
 * sleep rerun, and `merge`'s main-advanced guard reads `base_sha` off this row — so the row must
 * describe the run that most recently executed under the id, not the date's first run (#110).
 */
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
     ON CONFLICT(run_id) DO UPDATE SET branch = excluded.branch, base_sha = excluded.base_sha,
       head_sha = excluded.head_sha, status = excluded.status,
       started_at = excluded.started_at, ended_at = excluded.ended_at`,
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
