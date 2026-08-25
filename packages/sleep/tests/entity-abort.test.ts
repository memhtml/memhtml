import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { appendPendingMarks, parsePendingMarks, pendingMarksPath } from "../src/contract.js"
import type { PhaseEnv } from "../src/env.js"
import { ENTITY_PROMOTION_DETECTIONS, entityResolution } from "../src/phases/entity-resolution.js"
import { merge } from "../src/review.js"
import { instantFor, run } from "../src/run.js"
import { markEntityPromoted } from "../src/sql.js"
import { scriptedModel, value } from "../src/testing.js"
import {
  applyLedger,
  discardBranch,
  entityCounters,
  ledgerAtHead,
  pendingEntityMerges,
  promotedByPhaseRead
} from "./abort-fixture.js"
import {
  ENTITY_CORPUS,
  type Fixture,
  PERSON_ALIAS,
  PERSON_CANONICAL,
  seedEntityCorroboration,
  withFixture
} from "./fixture.js"

/**
 * An entity merge's promotion flag as a property of the STATE PLANE, not of git.
 *
 * `git branch -D` is this design's whole abort, and it can only be true if nothing a phase does outlives
 * its branch. `state.entity_corroboration.promoted`/`confirmed` assert that every `memhtml-entity` meta
 * naming an alias has been rewritten onto its canonical — a corpus-wide rename — and the flag lives in
 * `.memhtml/state.db`, which no discard can undo and no index rebuild can re-derive. So the phase records
 * an `entity-promoted` mark on its branch and `merge` applies it, and these cases state the plane BEFORE
 * the discard as well as after: a run that earned nothing would make every assertion after the discard
 * vacuous.
 *
 * A NEIGHBOUR RUN's row is seeded throughout, of the SAME entity type as the subject. The table is keyed
 * on the merge and shared across every run and every entity that ever reached the gate, so "the table is
 * empty" agrees exactly with a phase that writes the plane directly — and a `WHERE` that lost one of the
 * three key columns would reach the neighbour's row while a clean database hid it.
 *
 * **What the phase reads, and what it does not.** Entity resolution has no separate "already promoted"
 * query: the flag arrives on the row `bumpEntityCorroboration`'s `RETURNING` hands back, and it gates
 * only whether the mark is recorded — never whether the merge is applied. So these cases read `promoted`
 * through {@link promotedByPhaseRead}, which is that same bump at the row's own instant, rather than
 * through a second `SELECT` free to agree with a bug the production read has.
 */

const DATE = "2026-08-08"
/** A merge that landed BEFORE the one under test, whose row must be untouched by any of this. */
const NEIGHBOUR_ALIAS = "sanju"
const NEIGHBOUR_CANONICAL = "sanju kumar"

const SHORT_FORM = "areas/team/monday-signoff.html"
const MIXED_CASE = "areas/team/release-train-owner.html"

/** The `<meta>` line a `person:` entity holds, as the serializer writes it. */
const personMeta = (name: string) => `<meta name="memhtml-entity" content="person:${name}">`

const envFor = (fixture: Fixture, date: string = DATE): PhaseEnv => {
  const instant = instantFor(date)
  return {
    deps: fixture.deps,
    runId: `sleep/${date}`,
    branch: `sleep/${date}`,
    baseSha: "",
    date,
    at: instant.at,
    atMillis: instant.millis,
    dryRun: false
  }
}

const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/**
 * A model that clusters the two spellings of the one person and answers every other phase harmlessly.
 *
 * The member KEYS are read out of the prompt rather than hard-coded, because `m1`..`mN` follow the
 * batch's own sorted-name order and a hard-coded key would silently name a different member the day the
 * corpus grew. `entries: []` and `groups: []` are refusals arc synthesis and dedup handle, and the
 * fall-through payload decodes against no phase's schema, so the remaining LLM phases count a skipped
 * batch and stay green — what these cases need from a whole run is its entity merge, not its judgments.
 */
const entityModel = () =>
  scriptedModel((request) => {
    if (request.system.startsWith("You triage")) return value({ entries: [] })
    if (request.system.startsWith("You partition")) return value({ groups: [] })
    if (!request.system.startsWith("You group entity names")) {
      return value({ verdict: "neutral", confidence: 0.9, rationale: "compatible" })
    }
    const keyOf = (name: string): string | undefined =>
      /** Each member is wrapped as `<entity_mN>` with `name: <the name>` on its first line. */
      [...request.prompt.matchAll(/<entity_(m\d+)>\s*\nname: ([^\n]+)/g)].find(
        (match) => match[2]?.trim() === name
      )?.[1]
    const canonicalKey = keyOf(PERSON_CANONICAL)
    const aliasKey = keyOf(PERSON_ALIAS)
    if (canonicalKey === undefined || aliasKey === undefined) return value({ clusters: [] })
    return value({
      clusters: [
        {
          canonicalKey,
          memberKeys: [canonicalKey, aliasKey],
          confidence: 0.9,
          evidence: "the same rollout cadence and release train sign off under both names"
        }
      ]
    })
  })

/** The neighbour's landed merge: the same entity type, a different pair, already promoted. */
const seedNeighbour = (fixture: Fixture): Effect.Effect<void> =>
  seedEntityCorroboration(fixture.db, {
    entityType: "person",
    aliasName: NEIGHBOUR_ALIAS,
    canonicalName: NEIGHBOUR_CANONICAL,
    detections: ENTITY_PROMOTION_DETECTIONS,
    promoted: 1,
    confirmed: 1
  })

/** The subject's counter one night short, so THIS night's proposal is the second and really promotes. */
const seedSubject = (fixture: Fixture): Effect.Effect<void> =>
  seedEntityCorroboration(fixture.db, {
    entityType: "person",
    aliasName: PERSON_ALIAS,
    canonicalName: PERSON_CANONICAL,
    detections: ENTITY_PROMOTION_DETECTIONS - 1
  })

/** The neighbour's row as it must read at every point in every case here. */
const NEIGHBOUR_ROW = {
  entity_type: "person",
  alias_name: NEIGHBOUR_ALIAS,
  canonical_name: NEIGHBOUR_CANONICAL,
  detections: ENTITY_PROMOTION_DETECTIONS,
  promoted: 1,
  confirmed: 1
}

/** The subject's row while its promotion is still only a proposal on a branch. */
const SUBJECT_PENDING = {
  entity_type: "person",
  alias_name: PERSON_ALIAS,
  canonical_name: PERSON_CANONICAL,
  detections: ENTITY_PROMOTION_DETECTIONS,
  promoted: 0,
  confirmed: 0
}

/** The one mark an earned entity promotion records. */
const SUBJECT_MARK = {
  entityType: "person",
  aliasName: PERSON_ALIAS,
  canonicalName: PERSON_CANONICAL
}

describe("a discarded sleep branch discards its entity-merge promotion", () => {
  it("leaves the promotion unset after `git branch -D`, with the alias back on offer", async () => {
    /**
     * The finding. `promoted = 1, confirmed = 1` says the corpus carries the rename; the rename lives on
     * the branch and the flag would live in a plane no discard reaches. A phase that set it directly
     * leaves the plane asserting a corpus-wide rewrite that not one file carries — a false provenance
     * record, in the one store this system cannot rebuild from the tree.
     *
     * (Mutation: restoring `markEntityPromoted(env.deps.db, …)` inside entity-resolution in place of the
     * `marks.push` leaves the subject's row `promoted = 1, confirmed = 1` after the discard and fails
     * both the phase read and the row assertion. Verified by reverting that one call.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedNeighbour(fixture)
          yield* seedSubject(fixture)

          const env = envFor(fixture)
          yield* fixture.raw("checkout", "-b", env.runId)
          const outcome = yield* entityResolution(env)

          /** The merge really happened on the branch: the alias is gone from the tree it committed. */
          expect(outcome.counts.llmMerges).toBe(1)
          expect(outcome.commitSha).not.toBeNull()
          expect(yield* atHead(fixture, SHORT_FORM)).not.toContain(personMeta(PERSON_ALIAS))
          expect(yield* atHead(fixture, SHORT_FORM)).toContain(personMeta(PERSON_CANONICAL))

          /** And the write it earned is a MARK on the branch, with the plane still saying nothing. */
          expect(yield* pendingEntityMerges(fixture, env.runId)).toEqual([SUBJECT_MARK])
          expect(yield* entityCounters(fixture)).toEqual([SUBJECT_PENDING, NEIGHBOUR_ROW])

          yield* discardBranch(fixture, env.runId)

          /** The ledger went with the branch, so there is nothing left to apply by accident. */
          expect(yield* ledgerAtHead(fixture, env.runId)).toBeUndefined()
          expect(yield* atHead(fixture, SHORT_FORM)).toContain(personMeta(PERSON_ALIAS))

          /**
           * The phase's OWN read says the merge is still unpromoted, so a later night that reaches the
           * gate records it again and a landing merge can still apply it. The DETECTION stays, and that
           * is the deliberate half: `detections` counts nights on which a model read the corpus and
           * proposed the merge, and the discarded night did both.
           */
          const row = yield* promotedByPhaseRead(fixture, {
            entityType: "person",
            aliasName: PERSON_ALIAS,
            canonicalName: PERSON_CANONICAL,
            at: env.at
          })
          expect(row?.promoted).toBe(0)
          expect(row?.detections).toBe(ENTITY_PROMOTION_DETECTIONS)

          /** The plane is exactly the neighbour's landed merge plus the subject's still-pending one. */
          expect(yield* entityCounters(fixture)).toEqual([SUBJECT_PENDING, NEIGHBOUR_ROW])
        }),
      { seed: ENTITY_CORPUS, model: entityModel() }
    )
  })

  it("commits its ledger on a night that earned a promotion and rewrote no file", async () => {
    /**
     * A promotion can be earned with nothing to rewrite: every phase reads its candidates from an index
     * refreshed once in preflight, so a file an earlier phase archived is still listed as claiming the
     * alias when this phase runs, and the rewrite finds no bytes. Reproduced exactly that way — both
     * files carrying a rewritable meta leave the TREE while the index keeps their rows.
     *
     * The night still owes its merge a mark, and a phase that returned early on `filesRewritten === 0`
     * would leave the ledger STAGED AND UNCOMMITTED: no merge could find it, and whichever later phase
     * committed next would sweep it in, which is the cross-phase contamination per-phase commits exist to
     * prevent. The commit's file list is asserted exactly, so a night that minted a task instead of
     * committing the ledger fails rather than passing on the commit's mere existence.
     *
     * (Mutation: dropping `!pendingRecorded &&` from the phase's no-commit guard makes `commitSha` null
     * and leaves the ledger out of every commit. Verified by reverting that clause.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedNeighbour(fixture)
          yield* seedSubject(fixture)

          const env = envFor(fixture)
          yield* fixture.raw("checkout", "-b", env.runId)
          /** The index is NOT refreshed, which is the whole point: it still lists both names. */
          yield* fixture.raw("rm", SHORT_FORM, MIXED_CASE)
          yield* fixture.raw("commit", "-m", "archive the alias files out from under the phase")

          const outcome = yield* entityResolution(env)
          expect(outcome.counts.llmMerges).toBe(1)
          expect(outcome.counts.filesRewritten).toBe(0)
          expect(outcome.commitSha).not.toBeNull()

          const changed = yield* fixture.deps.git
            .run(["show", "--name-only", "--format=", outcome.commitSha as string])
            .pipe(
              Effect.map((text) =>
                text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "")
              ),
              Effect.orDie
            )
          expect(changed).toEqual([pendingMarksPath(env.runId)])
          expect(yield* pendingEntityMerges(fixture, env.runId)).toEqual([SUBJECT_MARK])
        }),
      { seed: ENTITY_CORPUS, model: entityModel() }
    )
  })

  it("records ONE mark for a merge it re-reads inside one night", async () => {
    /**
     * A resume of one night re-executes the phase, and this phase commits whenever it rewrites any file —
     * so a re-execution is ordinary. `bumpEntityCorroboration` keeps `detections` where it is for a
     * second pass at the same instant, so the merge is accepted again and the promotion is earned again,
     * while the plane still answers `promoted = 0` because nothing has merged yet.
     *
     * The LEDGER is what makes that safe, and it is this phase's whole same-run view: the record goes
     * through the same file the read does, and `appendPendingMarks` drops a line already present, so a
     * re-recorded mark writes nothing and stages nothing. Both passes are asserted, because an
     * implementation that recorded per merge with an unstable key order would append a second copy of a
     * write the branch had already earned — and `merge` would then report two pending marks for one.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedNeighbour(fixture)
          yield* seedSubject(fixture)

          const env = envFor(fixture)
          yield* fixture.raw("checkout", "-b", env.runId)

          const first = yield* entityResolution(env)
          expect(first.counts.llmMerges).toBe(1)
          expect(yield* pendingEntityMerges(fixture, env.runId)).toEqual([SUBJECT_MARK])

          const second = yield* entityResolution(env)
          expect(second.counts.llmMerges).toBe(1)
          expect(yield* pendingEntityMerges(fixture, env.runId)).toEqual([SUBJECT_MARK])
          expect(yield* entityCounters(fixture)).toEqual([SUBJECT_PENDING, NEIGHBOUR_ROW])
        }),
      { seed: ENTITY_CORPUS, model: entityModel() }
    )
  })
})

describe("`merge` applies an entity merge's promotion", () => {
  it("applies it once, reports it, and stays put on a second apply", async () => {
    /**
     * The other side of the abort: a run that LANDS must reach exactly the plane the direct write used to
     * reach, and reaching it twice must be indistinguishable from reaching it once, because a merge
     * retries. Driven through the whole `run` → `merge` path rather than through one phase, since the
     * ledger's committed location and the branch `merge` reads it from are the parts a phase test cannot
     * see.
     *
     * (Mutation: dropping the `entity-promoted` arm from `statementFor` in `sql.ts` is a compile error,
     * which is the point of the total switch; changing its `WHERE` to sort the two names leaves the
     * subject's row untouched and fails the assertion below.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedNeighbour(fixture)
          yield* seedSubject(fixture)

          const report = yield* run(fixture.deps, { date: DATE })
          expect(report.phases.filter((phase) => phase.status === "failed")).toEqual([])
          expect(
            report.phases.find((phase) => phase.phase === "entity-resolution")?.counts.llmMerges
          ).toBe(1)
          expect(yield* pendingEntityMerges(fixture, report.runId, report.branch)).toEqual([
            SUBJECT_MARK
          ])
          // Still a proposal while the branch sits in review, beside the neighbour's landed row.
          expect(yield* entityCounters(fixture)).toEqual([SUBJECT_PENDING, NEIGHBOUR_ROW])

          const merged = yield* merge(fixture.deps, report.runId)
          expect(merged.merged).toBe(true)
          /** Reported, and AGREEING: a shortfall between these two is a plane write that did not land. */
          expect(merged.marksPending).toBe(1)
          expect(merged.marksApplied).toBe(1)

          expect(yield* entityCounters(fixture)).toEqual([
            { ...SUBJECT_PENDING, promoted: 1, confirmed: 1 },
            NEIGHBOUR_ROW
          ])
          expect(yield* atHead(fixture, SHORT_FORM)).not.toContain(personMeta(PERSON_ALIAS))

          /**
           * Applying the same ledger again reaches the same plane, across every column a second
           * application could move. That is what makes a retried merge safe to run blind.
           */
          const before = yield* entityCounters(fixture)
          expect(yield* applyLedger(fixture, report.runId)).toBe(1)
          expect(yield* entityCounters(fixture)).toEqual(before)
        }),
      { seed: ENTITY_CORPUS, model: entityModel() }
    )
  })

  it("promotes only the row the mark names: the type and the two names, unsorted", async () => {
    /**
     * `entity_corroboration`'s primary key is `(entity_type, alias_name, canonical_name)`, and all three
     * parts are load-bearing. The orientation distinguishes two rows the table keeps apart — the merge one
     * way and the merge back, which `S0002_entity_corroboration.sql` records as a deliberate restart of
     * the counter — and the type is in the key because `person:api` and `service:api` are different
     * subjects whose names collide.
     *
     * So the neighbours are chosen to make each predicate INDIVIDUALLY necessary: for the promoted row,
     * one row differing only in orientation, one only in type, one only in alias, one only in canonical.
     * Dropping any single predicate from the applier's `WHERE` promotes one of them, and sorting the pair
     * promotes the reverse orientation instead. The mark is applied through the production statement, not
     * a hand-written `UPDATE`.
     *
     * The promoted mark names the merge BACK (`laith al-saadoon -> laith`) on purpose: the forward
     * orientation sorts to itself, so a sorted key would be invisible against it.
     *
     * (Mutation: sorting the two names in `statementFor`'s `entity-promoted` arm promotes the forward row
     * and leaves the reverse one; dropping `entity_type = ?` also promotes the `service` row; dropping
     * `alias_name = ?` also promotes `sanju -> laith`; dropping `canonical_name = ?` also promotes
     * `laith al-saadoon -> sanju kumar`. All four verified.)
     */
    await withFixture((fixture) =>
      Effect.gen(function* () {
        const counter = (aliasName: string, canonicalName: string, entityType = "person") =>
          seedEntityCorroboration(fixture.db, {
            entityType,
            aliasName,
            canonicalName,
            detections: ENTITY_PROMOTION_DETECTIONS
          })
        /** The one the mark names. */
        yield* counter(PERSON_CANONICAL, PERSON_ALIAS)
        /** Differs only in ORIENTATION. */
        yield* counter(PERSON_ALIAS, PERSON_CANONICAL)
        /** Differs only in TYPE. */
        yield* counter(PERSON_CANONICAL, PERSON_ALIAS, "service")
        /** Differs only in ALIAS. */
        yield* counter(NEIGHBOUR_ALIAS, PERSON_ALIAS)
        /** Differs only in CANONICAL. */
        yield* counter(PERSON_CANONICAL, NEIGHBOUR_CANONICAL)

        yield* markEntityPromoted(fixture.db, {
          entityType: "person",
          aliasName: PERSON_CANONICAL,
          canonicalName: PERSON_ALIAS,
          at: instantFor(DATE).at
        }).pipe(Effect.orDie)

        const row = (
          entityType: string,
          aliasName: string,
          canonicalName: string,
          promoted: number
        ) => ({
          entity_type: entityType,
          alias_name: aliasName,
          canonical_name: canonicalName,
          detections: ENTITY_PROMOTION_DETECTIONS,
          promoted,
          confirmed: promoted
        })
        expect(yield* entityCounters(fixture)).toEqual([
          row("person", PERSON_ALIAS, PERSON_CANONICAL, 0),
          row("person", PERSON_CANONICAL, PERSON_ALIAS, 1),
          row("person", PERSON_CANONICAL, NEIGHBOUR_CANONICAL, 0),
          row("person", NEIGHBOUR_ALIAS, PERSON_ALIAS, 0),
          row("service", PERSON_CANONICAL, PERSON_ALIAS, 0)
        ])
      })
    )
  })
})

describe("the entity-promoted mark's ledger line", () => {
  const mark = {
    kind: "entity-promoted",
    entityType: "person",
    aliasName: PERSON_ALIAS,
    canonicalName: PERSON_CANONICAL,
    at: "2026-08-08T00:00:00Z"
  } as const

  it("renders in a FIXED key order, so a re-record dedups and writes nothing", () => {
    /**
     * The rendered line is the mark's identity, and `appendPendingMarks` deduplicates on it — so a
     * re-record has to produce the same BYTES or a resume appends a second copy of a write the branch
     * already earned. The order is asserted as a literal for that reason: it is a property of the writer,
     * not of whatever key order a future edit happens to leave.
     */
    const line =
      `{"kind":"entity-promoted","entityType":"person","aliasName":"${PERSON_ALIAS}",` +
      `"canonicalName":"${PERSON_CANONICAL}","at":"${mark.at}"}`
    const once = appendPendingMarks(undefined, [mark])
    expect(once).toBe(`${line}\n`)
    // Byte-identical, which is what `recordPendingMarks` reads as "nothing to write and nothing to stage".
    expect(appendPendingMarks(once, [mark])).toBe(once)
    expect(parsePendingMarks(once)).toEqual({ marks: [mark], skipped: 0 })
  })

  it("declines a line missing any of the three key parts", () => {
    /**
     * A mark short a key column addresses no row, so the applier's `UPDATE` would match nothing while the
     * ledger read as applied. Counting it `skipped` is what makes the shortfall visible in the merge's own
     * `marksPending` above `marksApplied`.
     */
    for (const absent of ["entityType", "aliasName", "canonicalName", "at"] as const) {
      const fields: Record<string, unknown> = { ...mark }
      delete fields[absent]
      expect(parsePendingMarks(`${JSON.stringify(fields)}\n`)).toEqual({ marks: [], skipped: 1 })
    }
  })
})
