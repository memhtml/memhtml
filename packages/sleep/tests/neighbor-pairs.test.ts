import type { StorageFailure } from "@memhtml/contracts/errors"
import type { DatabaseShape } from "@memhtml/index"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { conflictCandidates, neighborPairs, type PairRow } from "../src/sql.js"
import { DEDUP_CORPUS, TASK_CORPUS, withFixture } from "./fixture.js"

/**
 * The pair scans against an INDEPENDENT oracle: the same selection written entirely in SQL, the
 * whole pair space through the `vector_distance_cos` UDF. That formulation decodes both blobs on
 * every one of its n² calls, which is exactly what the kernel exists to avoid (issue #40) — at
 * fixture scale it is cheap, and it exercises none of the kernel's code, so agreement between the
 * two is evidence rather than tautology.
 *
 * Pair identity and order must agree EXACTLY. Sims agree to a tolerance instead, because the
 * oracle's similarity is `1 - (1 - cosine)` — the UDF works in distance space — and that double
 * subtraction costs up to an ulp, while the kernel reports `cosine` itself (bit-identity to
 * `cosine` is locked in `packages/domain/tests/neighbors.test.ts`).
 */

const SEED = [...DEDUP_CORPUS, ...TASK_CORPUS]

interface ScanOptions {
  readonly floor: number
  readonly perSourceK: number
  readonly limit: number
  readonly excludeTypes?: ReadonlyArray<string> | undefined
}

const neighborOracle = (
  db: DatabaseShape,
  options: ScanOptions
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

const conflictOracle = (
  db: DatabaseShape,
  options: ScanOptions
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

const expectEquivalent = (actual: ReadonlyArray<PairRow>, oracle: ReadonlyArray<PairRow>) => {
  expect(actual.map((pair) => [pair.src, pair.dst])).toEqual(
    oracle.map((pair) => [pair.src, pair.dst])
  )
  actual.forEach((pair, at) => {
    expect(Math.abs(pair.sim - (oracle[at] as PairRow).sim)).toBeLessThan(1e-9)
  })
}

/** The three unordered memory pairs the fixture's measured cosines put above 0.90. */
const ONCALL_KEEP = "areas/oncall/drain-the-vip-first.html"
const ONCALL_DROP = "areas/oncall/vip-drain-precedes-revert.html"
const FLIP_SAFE = "areas/deploy/blue-green-is-safe.html"
const FLIP_NOT_SAFE = "areas/deploy/blue-green-is-not-safe.html"
const METRICS_A = "areas/metrics/scrape-cadence.html"
const METRICS_B = "areas/metrics/exporter-scrape-interval.html"

describe("the pair scans against the all-SQL oracle", () => {
  it("agrees on the clean corpus, at the phase floors and at a low-floor sweep", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const atPhaseFloor: ScanOptions = {
            floor: 0.9,
            perSourceK: 5,
            limit: 500,
            excludeTypes: ["task"]
          }
          const neighbors = yield* neighborPairs(fixture.db, atPhaseFloor)
          expectEquivalent(neighbors, yield* neighborOracle(fixture.db, atPhaseFloor))
          /**
           * Independently derived, not read from output: the fixture documents three memory pairs
           * above 0.90 (0.9907, 0.9323, 0.9277) and cross-pair cosines at ~0.5, and each unordered
           * pair appears once per endpoint's neighborhood. Without this count the equivalence
           * above would hold just as well on two implementations that both return [].
           */
          expect(neighbors).toHaveLength(6)

          const conflicts = yield* conflictCandidates(fixture.db, atPhaseFloor)
          expectEquivalent(conflicts, yield* conflictOracle(fixture.db, atPhaseFloor))
          // The same three pairs: each shares its entity, none carries an authored edge.
          expect(conflicts.map((pair) => [pair.src, pair.dst])).toEqual([
            [FLIP_SAFE, FLIP_NOT_SAFE],
            [METRICS_A, METRICS_B],
            [ONCALL_DROP, ONCALL_KEEP]
          ])

          /**
           * Low floor, tight caps, tasks included: the global limit and the per-source cap both
           * bind here, so the two implementations must agree about ORDERING under contention,
           * not merely about membership.
           */
          const sweep: ScanOptions = { floor: 0, perSourceK: 3, limit: 7 }
          expectEquivalent(
            yield* neighborPairs(fixture.db, sweep),
            yield* neighborOracle(fixture.db, sweep)
          )
          expectEquivalent(
            yield* conflictCandidates(fixture.db, sweep),
            yield* conflictOracle(fixture.db, sweep)
          )
        }),
      { seed: SEED }
    )
  })

  it("agrees on the CONTAMINATED corpus: an archived endpoint, an authored edge, a derived edge", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * The neighbor's rows, per the metarepo lesson: a clean corpus cannot distinguish a
           * scan that honors `archived = 0` and `derived = 0` from one that ignores both.
           * An authored contradiction closes the metrics pair; a mined `relates_to` must NOT
           * close the flip pair; archiving one oncall endpoint removes that pair from every
           * neighborhood.
           */
          yield* fixture.db.run(
            `INSERT INTO edges (src_path, rel, dst_path, edge_class, derived, strength, provenance, created_at)
             VALUES (?, 'contradicts', ?, 'memory', 0, 1.0, 'authored', '2026-08-01T00:00:00Z')`,
            [METRICS_A, METRICS_B]
          )
          yield* fixture.db.run(
            `INSERT INTO edges (src_path, rel, dst_path, edge_class, derived, strength, provenance, created_at)
             VALUES (?, 'relates_to', ?, 'memory', 1, 0.99, 'sleep', '2026-08-01T00:00:00Z')`,
            [FLIP_SAFE, FLIP_NOT_SAFE]
          )
          yield* fixture.db.run("UPDATE files SET archived = 1 WHERE path = ?", [ONCALL_DROP])

          const atPhaseFloor: ScanOptions = {
            floor: 0.9,
            perSourceK: 5,
            limit: 500,
            excludeTypes: ["task"]
          }
          const neighbors = yield* neighborPairs(fixture.db, atPhaseFloor)
          expectEquivalent(neighbors, yield* neighborOracle(fixture.db, atPhaseFloor))
          // The archived endpoint takes its pair with it; edges do not gate this scan.
          expect(neighbors.map((pair) => pair.src).sort()).toEqual([
            FLIP_NOT_SAFE,
            FLIP_SAFE,
            METRICS_B,
            METRICS_A
          ])

          const conflicts = yield* conflictCandidates(fixture.db, atPhaseFloor)
          expectEquivalent(conflicts, yield* conflictOracle(fixture.db, atPhaseFloor))
          // Authored closes metrics, archived removes oncall, the DERIVED edge closes nothing.
          expect(conflicts.map((pair) => [pair.src, pair.dst])).toEqual([
            [FLIP_SAFE, FLIP_NOT_SAFE]
          ])
        }),
      { seed: SEED }
    )
  })
})
