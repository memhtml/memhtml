import { FINDING_KEY_PATTERN } from "@memhtml/contracts/types"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import {
  CLAIM_JACCARD_FLOOR,
  claimJaccard,
  DETECTED_TAG,
  type DetectedFinding,
  findingKeyOf,
  MINT_AUTHOR,
  MINT_CAP,
  makeMinter
} from "../src/mint.js"
import { instantFor } from "../src/run.js"
import { DEDUP_CORPUS, type Fixture, memoryHtml, withFixture } from "./fixture.js"

/**
 * The minting kernel, against a real repo and a real database.
 *
 * Nothing here is faked. The kernel's whole subject is what reaches the TREE — a task file at a
 * placed path carrying a finding key, a `git mv` with a status stamp riding it, a night that stages
 * nothing — and a fake git or a stateless database would confirm the calls and miss all three.
 *
 * The vacuous-lock lesson governs this file: four behaviors here are stated invariants that a corpus
 * without a counter-example would "pass" trivially, so each names the mutation that breaks it and the
 * packet records the run. Those four are the todo-only closure guard, the cap-versus-`presentKeys`
 * split, the same-detector restriction on the Jaccard arm, and the in-run dedup set.
 */

const DATE = "2026-08-19"

const envFor = (fixture: Fixture, dryRun = false): PhaseEnv => {
  const instant = instantFor(DATE)
  return {
    deps: fixture.deps,
    runId: `sleep/${DATE}`,
    branch: `sleep/${DATE}`,
    baseSha: "",
    date: DATE,
    at: instant.at,
    atMillis: instant.millis,
    dryRun
  }
}

const DETECTOR = "entity-resolution"

/** A finding with everything defaulted, so a case states only the field it is varying. */
const finding = (input: Partial<DetectedFinding> = {}): DetectedFinding => ({
  detector: DETECTOR,
  fingerprint: "entity:person\0laith\0laith al-saadoon",
  title: "confirm: are laith and laith al-saadoon the same person?",
  claim: "The names laith and laith al-saadoon may denote one person.",
  body: ["Name similarity 0.476, below the review band."],
  ...input
})

/** Everything the working tree holds that HEAD does not: the kernel stages, so this is its output. */
const dirty = (fixture: Fixture): Effect.Effect<ReadonlyArray<string>> =>
  fixture.deps.store.dirtyPaths().pipe(Effect.orDie)

/** A file's current bytes on disk, or `undefined`. The kernel writes without committing. */
const onDisk = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    const { readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    try {
      return await readFile(join(fixture.root, path), "utf8")
    } catch {
      return undefined
    }
  })

/** A seeded open detected task, exactly as a previous night's mint would have left it. */
const detectedTask = (input: {
  readonly title: string
  readonly claim: string
  readonly findingKey: string
  readonly taskStatus?: string | undefined
}) =>
  memoryHtml({
    title: input.title,
    claim: input.claim,
    memoryType: "task",
    taskStatus: input.taskStatus ?? "todo",
    findingKey: input.findingKey,
    createdAt: "2026-08-01T00:00:00Z",
    tags: [DETECTED_TAG]
  })

describe("findingKeyOf", () => {
  it("is deterministic, well-formed, and stable digest-for-digest", () => {
    const first = findingKeyOf(DETECTOR, "entity:person\0a\0b")
    expect(findingKeyOf(DETECTOR, "entity:person\0a\0b")).toBe(first)
    expect(first).toMatch(FINDING_KEY_PATTERN)

    /**
     * The digest is PINNED, not merely self-consistent. A key is a cross-night identity, so a change
     * to the hash input, the algorithm, or the slice length silently re-files every open detected
     * task as new — visible as one duplicate per finding per night, and nothing else. A recomputed
     * expectation would move with the change and say nothing.
     */
    expect(first).toBe("entity-resolution:fcc40a1932d424dc")
    expect(findingKeyOf("edge-typing", "edge:a\0b")).toBe("edge-typing:4880c5015ff3ad3b")
  })

  it("separates a detector from one whose name is its prefix", () => {
    /**
     * `edge` against `edge-typing` on the same fingerprint. The two keys must differ in their FIRST
     * segment, because `openDetectedTasks` brackets a detector's keys by an ASCII range — and a
     * fingerprint that collapsed the two names would put one detector's findings inside the other's
     * range.
     */
    expect(findingKeyOf("edge", "x").startsWith("edge:")).toBe(true)
    expect(findingKeyOf("edge-typing", "x").startsWith("edge-typing:")).toBe(true)
    expect(findingKeyOf("edge", "x")).not.toBe(findingKeyOf("edge-typing", "x"))
  })
})

describe("claimJaccard", () => {
  it("scores identity 1, disjoint 0, and the restatement above the floor", () => {
    expect(claimJaccard("the runbook is stale", "the runbook is stale")).toBe(1)
    expect(
      claimJaccard("the checkout api rejects tokens", "blue green cutover business hours")
    ).toBe(0)

    /**
     * The spec's own example, and the reason this arm exists at all: the two fingerprints differ, so
     * the exact-key arm cannot see them as one finding, and the task is the same task. Measured
     * 5/7 = 0.714, which is 0.114 of headroom over the floor.
     */
    const restated = claimJaccard("I'll update the runbook", "I'll update the runbook this week")
    expect(restated).toBeCloseTo(0.714, 3)
    expect(restated).toBeGreaterThanOrEqual(CLAIM_JACCARD_FLOOR)

    /** And a near-miss BELOW it, so the floor is a threshold rather than a formality. */
    expect(
      claimJaccard("the deploy runbook needs a review", "the deploy runbook is stale")
    ).toBeLessThan(CLAIM_JACCARD_FLOOR)
  })

  it("scores an empty claim 0 against anything, itself included", () => {
    /**
     * An empty claim is a detector bug. Scoring the pair 1 — which `0/0` invites — would make one
     * such finding suppress every later finding for the whole night, silently.
     */
    expect(claimJaccard("", "")).toBe(0)
    expect(claimJaccard("", "the runbook is stale")).toBe(0)
    expect(claimJaccard("...", "!!!")).toBe(0)
  })

  it("ignores punctuation and case, so a rewrapped claim is the same claim", () => {
    expect(claimJaccard("The Runbook, is stale.", "the runbook is stale")).toBe(1)
  })
})

describe("submit and finish", () => {
  it("mints one task file at the placed path with every stamp the format needs", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          yield* minter.submit(finding())
          const report = minter.finish()

          expect(report.counts).toEqual({ taskMinted: 1 })
          expect(report.minted).toHaveLength(1)

          const path = report.minted[0]?.path ?? ""
          /** Routed by `placementFor`'s task arm: no workspace, so the inbox's task subdirectory. */
          expect(path).toBe(
            "areas/inbox/tasks/confirm-are-laith-and-laith-al-saadoon-the-same-person.html"
          )
          expect(report.presentKeys.has(report.minted[0]?.findingKey ?? "")).toBe(true)

          /** STAGED, not committed. The phase owns the commit; the kernel must not have made one. */
          expect(yield* dirty(fixture)).toEqual([path])

          const html = yield* onDisk(fixture, path)
          expect(html).toBeDefined()
          const doc = yield* parseMemory(html ?? "").pipe(Effect.orDie)
          expect(doc.warnings).toEqual([])
          expect(doc.metas.memoryType).toBe("task")
          expect(doc.metas.taskStatus).toBe("todo")
          expect(doc.metas.author).toBe(MINT_AUTHOR)
          expect(doc.metas.findingKey).toBe(report.minted[0]?.findingKey)
          expect(doc.tags).toEqual([DETECTED_TAG])
          expect(doc.article.gist).toBe(finding().claim)
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("carries a session id into provenance and pre-authored markup verbatim", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), "trace-consolidation")
          yield* minter.submit(
            finding({
              detector: "trace-consolidation",
              title: "commitment: update the rollback runbook",
              claim: "The rollback runbook was promised an update.",
              /**
               * `<q cite>`, NOT `<blockquote>`. `blockquote` is outside `KNOWN_ELEMENTS`, so a task
               * minted with one parses with an `unknown:blockquote` warning and its quoted text never
               * reaches `article.citations` — which is the projection doctor's stale-quote check reads.
               * The kernel hands `articleHtml` through untouched, so the element choice is the
               * caller's and this case is what pins it for the four phases.
               */
              bodyHtml:
                "<p><mark>The rollback runbook was promised an update.</mark></p>" +
                '<p><q cite="/areas/oncall/drain-the-vip-first.html">' +
                "If a prod rollback is issued, drain the VIP before reverting the deploy.</q></p>",
              sessionId: "session-a"
            })
          )
          const report = minter.finish()

          const html = (yield* onDisk(fixture, report.minted[0]?.path ?? "")) ?? ""
          const doc = yield* parseMemory(html).pipe(Effect.orDie)
          expect(doc.warnings).toEqual([])
          expect(doc.metas.sessionId).toBe("session-a")
          /** The evidence quote survives as a real citation, which doctor later verifies. */
          expect(doc.article.citations).toEqual([
            {
              text: "If a prod rollback is issued, drain the VIP before reverting the deploy.",
              href: "/areas/oncall/drain-the-vip-first.html"
            }
          ])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("routes a workspace finding under that project's task directory", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          yield* minter.submit(finding({ workspace: "Ingest Migration" }))
          expect(minter.finish().minted[0]?.path).toBe(
            "projects/ingest-migration/tasks/confirm-are-laith-and-laith-al-saadoon-the-same-person.html"
          )
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("skips a finding whose key is already open in the tree", async () => {
    const key = findingKeyOf(DETECTOR, finding().fingerprint)

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          yield* minter.submit(finding())
          const report = minter.finish()

          expect(report.counts).toEqual({ taskAlreadyOpen: 1 })
          expect(report.minted).toEqual([])
          /** And the key is still PRESENT, so the same night's closure pass leaves that task alone. */
          expect(report.presentKeys.has(key)).toBe(true)
          expect(yield* dirty(fixture)).toEqual([])
        }),
      {
        seed: [
          ...DEDUP_CORPUS,
          {
            path: "areas/inbox/tasks/t-already-open.html",
            html: detectedTask({
              title: "confirm: are laith and laith al-saadoon the same person?",
              claim: "The names laith and laith al-saadoon may denote one person.",
              findingKey: key
            })
          }
        ]
      }
    )
  })

  it("recognizes its OWN mint from earlier in the same night", async () => {
    /**
     * The in-run set, and the reason writes stream instead of batching. `openDetectedTasks` reads the
     * INDEX, refreshed once in preflight, so a task minted a moment ago is invisible to it — a second
     * submit of one fingerprint would mint a second file at `…-2.html` every night forever.
     *
     * (Mutation, both measured: dropping `openKeys.add` after a mint makes this
     * `{ taskMinted: 1, taskDeduped: 1 }` — the Jaccard arm catches an IDENTICAL claim, so the
     * count degrades rather than the behavior. Dropping `openClaims.push` as well makes it
     * `taskMinted: 2`, which is the second file at `…-2.html` every night forever.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          yield* minter.submit(finding())
          yield* minter.submit(finding())
          const report = minter.finish()

          expect(report.counts).toEqual({ taskMinted: 1, taskAlreadyOpen: 1 })
          expect(yield* dirty(fixture)).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("deduplicates a restatement whose fingerprint differs, in-run and against the tree", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          yield* minter.submit(finding({ claim: "I'll update the runbook" }))
          yield* minter.submit(
            finding({
              // A DIFFERENT fingerprint, so only the Jaccard arm can catch this.
              fingerprint: "entity:person\0other\0pair",
              title: "confirm: a differently titled restatement",
              claim: "I'll update the runbook this week"
            })
          )
          const report = minter.finish()

          expect(report.counts).toEqual({ taskMinted: 1, taskDeduped: 1 })
          expect(report.presentKeys.size).toBe(2)
          expect(yield* dirty(fixture)).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("does NOT deduplicate against another detector's open task with the same claim", async () => {
    /**
     * The same-detector restriction, and it is load-bearing rather than tidy. Two detectors reach the
     * same subject from different evidence — edge typing's `resolve:` on a contradiction and
     * dedup-merge's `review:` on the vetoed pair behind it — and those are two decisions a human
     * makes separately. A cross-detector Jaccard arm would silently suppress whichever detector
     * happened to run second, forever, with `taskDeduped` as the only trace.
     *
     * (Mutation: dropping the detector argument from `openDetectedTasks` makes this `taskDeduped: 1`
     * and mints nothing.)
     */
    const claim = "The names laith and laith al-saadoon may denote one person."

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          yield* minter.submit(finding({ claim }))
          const report = minter.finish()

          expect(report.counts).toEqual({ taskMinted: 1 })
          /** The other detector's task really is there and open, so the negative is not vacuous. */
          expect(yield* onDisk(fixture, "areas/inbox/tasks/t-other-detector.html")).toBeDefined()
        }),
      {
        seed: [
          ...DEDUP_CORPUS,
          {
            path: "areas/inbox/tasks/t-other-detector.html",
            html: detectedTask({
              title: "review: the same subject from another detector",
              claim,
              findingKey: findingKeyOf("dedup-merge", "pair:a\0b")
            })
          }
        ]
      }
    )
  })

  it("gives two findings whose titles slug identically two different paths", async () => {
    /**
     * The in-run path collision. Two `confirm:` titles over long names share their first 80
     * characters routinely, and disk cannot answer for a file the kernel wrote a moment ago and has
     * not committed — so the second write would land as a silent overwrite with `taskMinted: 2`
     * still reported.
     *
     * The claims are deliberately disjoint, so the Jaccard arm is not what separates them.
     */
    const stem =
      "confirm are these two very long entity names describing one and the same person or not"

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          yield* minter.submit(
            finding({ title: `${stem} alfa`, fingerprint: "f1", claim: "Alfa bravo cielo delta." })
          )
          yield* minter.submit(
            finding({ title: `${stem} bravo`, fingerprint: "f2", claim: "Ferro gusto halo ilex." })
          )
          const report = minter.finish()

          expect(report.counts).toEqual({ taskMinted: 2 })
          const paths = report.minted.map((one) => one.path)
          expect(new Set(paths).size).toBe(2)
          /** Both files really hold content, so "two paths" is not two names for one write. */
          for (const path of paths) {
            expect(yield* onDisk(fixture, path)).toBeDefined()
          }
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("refuses a finding whose detector disagrees with the minter's", async () => {
    /**
     * A wrong-detector finding would be keyed, deduplicated, and later CLOSED by a phase whose
     * `presentKeys` never contains it — so the owning detector would archive it on a night it
     * detected nothing at all. Silent and delayed, which is why it is a failure and not a count.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          const result = yield* minter
            .submit(finding({ detector: "edge-typing" }))
            .pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          expect(yield* dirty(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("refuses a detector name that cannot form a well-formed finding key", async () => {
    /**
     * An uppercase or spaced detector hashes into a key `FINDING_KEY_PATTERN` rejects, and
     * `@memhtml/html` drops a rejected value to ABSENT — so every task would be minted with no key,
     * nothing would ever recognize one, and the phase would re-file its whole finding set every
     * night with no error anywhere. One loud stop at construction instead.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          for (const bad of ["Entity Resolution", "entity_resolution", "entity:resolution"]) {
            const result = yield* makeMinter(envFor(fixture), bad).pipe(Effect.result)
            expect(result._tag, bad).toBe("Failure")
          }
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

describe("MINT_CAP", () => {
  it("bounds NEW MINTS while every submitted key still enters presentKeys", async () => {
    /**
     * The cap-versus-`presentKeys` split, and the two halves fail differently. Without the cap a bad
     * night writes a hundred files into one commit; without every key in `presentKeys` the same
     * night's closure pass reads the capped findings as VANISHED and archives the tasks they are
     * about — so the overflow would not merely be deferred, it would delete the backlog.
     *
     * (Mutation: moving `presentKeys.add` below the cap check leaves `presentKeys.size` at
     * `MINT_CAP`, and the closure test in this file starts closing minted-this-night tasks.)
     */
    const submissions = MINT_CAP + 2

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          for (let index = 0; index < submissions; index += 1) {
            yield* minter.submit(
              finding({
                fingerprint: `pair-${index}`,
                title: `confirm: pair ${index}`,
                // Disjoint vocabulary per finding, so the Jaccard arm folds none of them.
                claim: `Whether item${index} denotes subject${index} is undecided.`
              })
            )
          }
          const report = minter.finish()

          expect(report.counts).toEqual({ taskMinted: MINT_CAP, mintOverflow: 2 })
          expect(report.minted).toHaveLength(MINT_CAP)
          expect(report.presentKeys.size).toBe(submissions)
          expect(yield* dirty(fixture)).toHaveLength(MINT_CAP)
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

describe("closeAbsent", () => {
  const ABSENT_KEY = findingKeyOf(DETECTOR, "gone:pair")
  const DOING_KEY = findingKeyOf(DETECTOR, "picked-up:pair")
  const PRESENT_KEY = findingKeyOf(DETECTOR, "still-there:pair")

  const ABSENT_PATH = "areas/inbox/tasks/t-absent.html"
  const DOING_PATH = "areas/inbox/tasks/t-doing.html"
  const PRESENT_PATH = "areas/inbox/tasks/t-present.html"

  const CLOSURE_SEED = [
    ...DEDUP_CORPUS,
    {
      path: ABSENT_PATH,
      html: detectedTask({
        title: "confirm: a pair nobody detects any more",
        claim: "Alfa and bravo may denote one service.",
        findingKey: ABSENT_KEY
      })
    },
    {
      // Somebody moved it to `doing`: a human owns this work item now.
      path: DOING_PATH,
      html: detectedTask({
        title: "confirm: a pair a human picked up",
        claim: "Cielo and delta may denote one service.",
        findingKey: DOING_KEY,
        taskStatus: "doing"
      })
    },
    {
      path: PRESENT_PATH,
      html: detectedTask({
        title: "confirm: a pair still detected tonight",
        claim: "Ferro and gusto may denote one service.",
        findingKey: PRESENT_KEY
      })
    }
  ]

  /** Submit the one finding that keeps `PRESENT_PATH`'s key present, and nothing else. */
  const submitPresent = (minter: {
    readonly submit: (one: DetectedFinding) => Effect.Effect<void, unknown>
  }) =>
    minter.submit(
      finding({
        fingerprint: "still-there:pair",
        title: "confirm: a pair still detected tonight",
        claim: "Ferro and gusto may denote one service."
      })
    )

  it("archives an absent todo task, leaves a doing one, and leaves a present one", async () => {
    /**
     * All three arms in one case, because the corpus is what makes each non-vacuous: without the
     * `doing` task the todo-only guard has nothing to refuse, and without the present one "closed
     * everything" would pass.
     *
     * (Mutation: deleting the `row.task_status !== "todo"` guard closes the `doing` task and
     * `closureSkipped` disappears from the counts.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const env = envFor(fixture)
          const minter = yield* makeMinter(env, DETECTOR)
          yield* submitPresent(minter)
          // The still-detected finding was already open, so the mint pass itself writes nothing.
          expect(minter.finish().counts).toEqual({ taskAlreadyOpen: 1 })

          const counts = yield* minter.closeAbsent(true)
          expect(counts).toEqual({ taskClosed: 1, closureSkipped: 1 })

          /** The absent task moved, and its move carries the `done` stamp in the SAME staged change. */
          expect(yield* onDisk(fixture, ABSENT_PATH)).toBeUndefined()
          const archived = yield* onDisk(fixture, `archive/2026/${ABSENT_PATH}`)
          expect(archived).toBeDefined()
          const doc = yield* parseMemory(archived ?? "").pipe(Effect.orDie)
          expect(doc.metas.taskStatus).toBe("done")
          expect(doc.metas.status).toBe("archived")
          expect(doc.metas.findingKey).toBe(ABSENT_KEY)

          /** The other two are untouched on disk, byte for byte. */
          expect(yield* onDisk(fixture, DOING_PATH)).toBe(
            detectedTask({
              title: "confirm: a pair a human picked up",
              claim: "Cielo and delta may denote one service.",
              findingKey: DOING_KEY,
              taskStatus: "doing"
            })
          )
          expect(yield* onDisk(fixture, PRESENT_PATH)).toBeDefined()

          /**
           * ONE staged change, and it is the move — `git status --porcelain=v2` reports a staged
           * rename as a single entry naming the destination, not two entries. So the stamped `done`
           * really did ride the `git mv` rather than landing as a separate edit on the source.
           */
          expect(yield* dirty(fixture)).toEqual([`archive/2026/${ABSENT_PATH}`])
        }),
      { seed: CLOSURE_SEED }
    )
  })

  it("closes nothing and counts the whole pass when the universe is incomplete", async () => {
    /**
     * The attestation guard. A night whose model call failed detects nothing, so EVERY open task
     * looks absent — closing on that would archive the entire detected backlog on the first bad
     * night. `closureSkipped` counts what was withheld, which is what an operator reads.
     *
     * (Mutation: dropping the `universeComplete` early return makes this close the two todo tasks
     * and the tree stops being clean.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture), DETECTOR)
          const counts = yield* minter.closeAbsent(false)

          // All three seeded tasks are absent from an empty submission set.
          expect(counts).toEqual({ closureSkipped: 3 })
          expect(yield* dirty(fixture)).toEqual([])
          for (const path of [ABSENT_PATH, DOING_PATH, PRESENT_PATH]) {
            expect(yield* onDisk(fixture, path)).toBeDefined()
          }
        }),
      { seed: CLOSURE_SEED }
    )
  })

  it("is a no-op on a second pass over the same inputs", async () => {
    /**
     * Idempotency, end to end and in ONE fixture, because the second pass has to see the first
     * pass's tree. BOTH mechanisms are exercised: dedup catches the re-mint by exact key, and the
     * closure is a no-op because `openDetectedTasks` no longer returns a task it archived.
     *
     * The corpus is `DEDUP_CORPUS` plus ONE absent detected task, deliberately narrower than
     * {@link CLOSURE_SEED}: a `doing` task would make night two report a permanent `closureSkipped`
     * (correctly — the guard refuses it every night), and the empty-counts assertion is what makes
     * "nothing happened" checkable rather than "nothing NEW happened".
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const env = envFor(fixture)
          const first = yield* makeMinter(env, DETECTOR)
          yield* first.submit(finding())
          expect(first.finish().counts).toEqual({ taskMinted: 1 })
          expect(yield* first.closeAbsent(true)).toEqual({ taskClosed: 1 })

          /** Commit and re-index: the state a second night actually starts from. */
          yield* fixture.deps.git.add(["."]).pipe(Effect.orDie)
          yield* fixture.deps.git.commit("night one").pipe(Effect.orDie)
          yield* fixture.reindex()
          expect(yield* dirty(fixture)).toEqual([])

          const second = yield* makeMinter(env, DETECTOR)
          yield* second.submit(finding())

          expect(second.finish().counts).toEqual({ taskAlreadyOpen: 1 })
          expect(yield* second.closeAbsent(true)).toEqual({})
          /** THE assertion: the second night stages nothing at all. */
          expect(yield* dirty(fixture)).toEqual([])
        }),
      {
        seed: [
          ...DEDUP_CORPUS,
          {
            path: ABSENT_PATH,
            html: detectedTask({
              title: "confirm: a pair nobody detects any more",
              claim: "Alfa and bravo may denote one service.",
              findingKey: ABSENT_KEY
            })
          }
        ]
      }
    )
  })
})

describe("a dry run", () => {
  it("computes every count and path and leaves the tree byte-identical", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const env = envFor(fixture, true)
          const minter = yield* makeMinter(env, DETECTOR)
          yield* minter.submit(finding())
          yield* minter.submit(
            finding({
              fingerprint: "second:pair",
              title: "confirm: a second pair",
              claim: "Alfa bravo cielo."
            })
          )
          const report = minter.finish()

          /** The preview is REAL: two mints with their placed paths, not a bare count. */
          expect(report.counts).toEqual({ taskMinted: 2 })
          expect(report.minted.map((one) => one.path)).toEqual([
            "areas/inbox/tasks/confirm-are-laith-and-laith-al-saadoon-the-same-person.html",
            "areas/inbox/tasks/confirm-a-second-pair.html"
          ])

          const closure = yield* minter.closeAbsent(true)
          expect(closure).toEqual({ taskClosed: 3 })

          /** And nothing reached the tree: no new file, no move, nothing staged. */
          expect(yield* dirty(fixture)).toEqual([])
          for (const path of report.minted) {
            expect(yield* onDisk(fixture, path.path)).toBeUndefined()
          }
          expect(yield* onDisk(fixture, "areas/inbox/tasks/t-absent.html")).toBeDefined()
        }),
      {
        seed: [
          ...DEDUP_CORPUS,
          {
            path: "areas/inbox/tasks/t-absent.html",
            html: detectedTask({
              title: "confirm: a pair nobody detects any more",
              claim: "Alfa and bravo may denote one service.",
              findingKey: findingKeyOf(DETECTOR, "gone:pair")
            })
          },
          {
            path: "areas/inbox/tasks/t-absent-2.html",
            html: detectedTask({
              title: "confirm: a second pair nobody detects",
              claim: "Cielo and delta may denote one service.",
              findingKey: findingKeyOf(DETECTOR, "gone:pair-2")
            })
          },
          {
            path: "areas/inbox/tasks/t-absent-3.html",
            html: detectedTask({
              title: "confirm: a third pair nobody detects",
              claim: "Ferro and gusto may denote one service.",
              findingKey: findingKeyOf(DETECTOR, "gone:pair-3")
            })
          }
        ]
      }
    )
  })

  it("still gives two identically-slugged findings two paths, with nothing on disk", async () => {
    /**
     * The DRY RUN is where the in-run claimed-path set is the only thing standing between two
     * findings and one path — and it is the only place, which is why this case exists separately.
     *
     * On a real night writes stream, so by the time the second finding probes, its rival's file is
     * already on disk and the disk arm answers. On a dry run nothing is ever written, so the disk arm
     * answers "free" forever and a preview would report the same path twice — an operator sizing the
     * night would see two mints landing on one file and could not tell whether that was the preview's
     * fault or the corpus's.
     *
     * (Mutation-verified: deleting `claimedPaths.has(candidate)` from the probe leaves the whole
     * suite green EXCEPT this case, which reports one path twice. Every other collision case here
     * passes on the disk arm alone.)
     */
    const stem =
      "confirm are these two very long entity names describing one and the same person or not"

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const minter = yield* makeMinter(envFor(fixture, true), DETECTOR)
          yield* minter.submit(
            finding({ title: `${stem} alfa`, fingerprint: "f1", claim: "Alfa bravo cielo delta." })
          )
          yield* minter.submit(
            finding({ title: `${stem} bravo`, fingerprint: "f2", claim: "Ferro gusto halo ilex." })
          )
          const paths = minter.finish().minted.map((one) => one.path)

          expect(paths).toHaveLength(2)
          expect(new Set(paths).size).toBe(2)
          /** And neither exists: the second path is `-2`, allocated against a file never written. */
          for (const path of paths) {
            expect(yield* onDisk(fixture, path)).toBeUndefined()
          }
          expect(yield* dirty(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})
