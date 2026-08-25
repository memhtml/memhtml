import { STATE_SCHEMA } from "@memhtml/index"
import { Effect } from "effect"

import type { PendingMark } from "../src/contract.js"
import { parsePendingMarks, pendingMarksPath } from "../src/contract.js"
import type { EntityCorroborationRow } from "../src/sql.js"
import { applyPendingMarks, bumpEntityCorroboration, unconsolidatedSessions } from "../src/sql.js"
import type { Fixture } from "./fixture.js"

/**
 * Reads for the abort suites: the run's pending-mark ledger as GIT holds it, the state plane the
 * ledger is a proposal about, and the one operation a merge performs on it.
 *
 * Separate from `fixture.ts` because everything here is about the boundary between a branch and the
 * state plane, which is the property these suites exist to hold: a mark lives on the branch until a
 * merge applies it, so a test that read the ledger off DISK could not tell a recorded mark from an
 * uncommitted stray, and `git branch -D` would not discard the thing under test.
 */

/** The ledger's bytes at `HEAD`, or `undefined` when the revision holds no ledger for that run. */
export const ledgerAtHead = (
  fixture: Fixture,
  runId: string,
  revision = "HEAD"
): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `${revision}:${pendingMarksPath(runId)}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/**
 * The marks a revision's ledger carries, in ledger order.
 *
 * Read through `parsePendingMarks`, not through a second JSON reader, so a test asserting on a mark is
 * asserting on the same values `merge` will apply rather than on the file's shape.
 */
export const pendingMarks = (
  fixture: Fixture,
  runId: string,
  revision = "HEAD"
): Effect.Effect<ReadonlyArray<PendingMark>> =>
  ledgerAtHead(fixture, runId, revision).pipe(
    Effect.map((contents) => (contents === undefined ? [] : parsePendingMarks(contents).marks))
  )

/** The session ids a revision's ledger proposes to watermark, in ledger order. */
export const pendingSessions = (
  fixture: Fixture,
  runId: string,
  revision = "HEAD"
): Effect.Effect<ReadonlyArray<string>> =>
  pendingMarks(fixture, runId, revision).pipe(
    Effect.map((marks) =>
      marks.flatMap((mark) => (mark.kind === "session-consolidated" ? [mark.sessionId] : []))
    )
  )

/**
 * Apply a revision's ledger to the state plane: what `merge` does once the fast-forward lands.
 *
 * Its own helper rather than a `merge` call, because most cases here drive ONE phase against the
 * fixture's `main` and never make a branch at all. The applier is the same one `merge` uses, so a case
 * that needs the post-merge plane gets the production write and not a hand-rolled `INSERT`.
 */
export const applyLedger = (fixture: Fixture, runId: string): Effect.Effect<number> =>
  pendingMarks(fixture, runId).pipe(
    Effect.flatMap((marks) => applyPendingMarks(fixture.db, marks)),
    Effect.orDie
  )

/** Every corroboration counter, oriented as the table keys them. What a promotion test reads. */
export const corroborations = (
  fixture: Fixture
): Effect.Effect<
  ReadonlyArray<{
    readonly src_path: string
    readonly rel: string
    readonly dst_path: string
    readonly detections: number
    readonly promoted: number
    readonly confirmed: number
  }>
> =>
  fixture.db
    .all<{
      src_path: string
      rel: string
      dst_path: string
      detections: number
      promoted: number
      confirmed: number
    }>(
      `SELECT src_path, rel, dst_path, detections, promoted, confirmed
       FROM ${STATE_SCHEMA}.edge_corroboration ORDER BY src_path, rel, dst_path`
    )
    .pipe(Effect.orDie)

/** Every entity-merge counter with every column a promotion can move. Type-and-name ordered. */
export const entityCounters = (
  fixture: Fixture
): Effect.Effect<
  ReadonlyArray<{
    readonly entity_type: string
    readonly alias_name: string
    readonly canonical_name: string
    readonly detections: number
    readonly promoted: number
    readonly confirmed: number
  }>
> =>
  fixture.db
    .all<{
      entity_type: string
      alias_name: string
      canonical_name: string
      detections: number
      promoted: number
      confirmed: number
    }>(
      `SELECT entity_type, alias_name, canonical_name, detections, promoted, confirmed
       FROM ${STATE_SCHEMA}.entity_corroboration
       ORDER BY entity_type, alias_name, canonical_name`
    )
    .pipe(Effect.orDie)

/**
 * `promoted` as ENTITY RESOLUTION ITSELF reads it: the `RETURNING` of its own bump.
 *
 * The phase has no separate "already promoted" query — the flag arrives on the row the bump returns — so
 * a test that ran its own `SELECT` would be free to agree with a bug the production read has. Passing the
 * row's OWN `updated_at` as `at` makes the call non-mutating: `bumpEntityCorroboration` advances
 * `detections` only when the two differ, which is the same idempotence a resume of one night relies on.
 */
export const promotedByPhaseRead = (
  fixture: Fixture,
  input: {
    readonly entityType: string
    readonly aliasName: string
    readonly canonicalName: string
    readonly at: string
  }
): Effect.Effect<EntityCorroborationRow | undefined> =>
  bumpEntityCorroboration(fixture.db, input).pipe(
    Effect.map((rows) => rows[0]),
    Effect.orDie
  )

/** The entity merges a revision's ledger proposes to promote, in ledger order. */
export const pendingEntityMerges = (
  fixture: Fixture,
  runId: string,
  revision = "HEAD"
): Effect.Effect<
  ReadonlyArray<{
    readonly entityType: string
    readonly aliasName: string
    readonly canonicalName: string
  }>
> =>
  pendingMarks(fixture, runId, revision).pipe(
    Effect.map((marks) =>
      marks.flatMap((mark) =>
        mark.kind === "entity-promoted"
          ? [
              {
                entityType: mark.entityType,
                aliasName: mark.aliasName,
                canonicalName: mark.canonicalName
              }
            ]
          : []
      )
    )
  )

/**
 * The session ids the anti-join would hand the NEXT cycle, under the phase's own floors.
 *
 * The phase's selection verbatim rather than a `SELECT … FROM traces`, because "is this session
 * re-selectable" is a question about `unconsolidatedSessions`' anti-join, and a hand-written query
 * would be a second reader free to disagree with the one the phase uses.
 */
export const reselectable = (
  fixture: Fixture,
  options: { readonly settledBefore?: string; readonly limit?: number } = {}
): Effect.Effect<ReadonlyArray<string>> =>
  unconsolidatedSessions(fixture.db, {
    minBytes: 0,
    settledBefore: options.settledBefore ?? "2030-01-01T00:00:00Z",
    limit: options.limit ?? 50
  }).pipe(
    Effect.map((rows) => rows.map((row) => row.session_id)),
    Effect.orDie
  )

/** Every consolidation watermark the state plane holds, session-ordered. */
export const appliedWatermarks = (
  fixture: Fixture
): Effect.Effect<ReadonlyArray<{ readonly session_id: string; readonly run_id: string }>> =>
  fixture.db
    .all<{ session_id: string; run_id: string }>(
      "SELECT session_id, run_id FROM trace_consolidations ORDER BY session_id"
    )
    .pipe(Effect.orDie)

/**
 * Discard a sleep branch the way an operator does: leave it, then `git branch -D`.
 *
 * `-D` and not `-d`, because the branch is unmerged by construction — that is the whole case. The
 * checkout is what makes the delete legal, and it is also what a reviewer does when they decide the
 * night is not worth landing.
 */
export const discardBranch = (
  fixture: Fixture,
  branch: string,
  target = "main"
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* fixture.raw("checkout", target)
    yield* fixture.raw("branch", "-D", branch)
  }).pipe(Effect.asVoid)
