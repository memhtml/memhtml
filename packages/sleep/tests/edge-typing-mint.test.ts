import { archivePathFor } from "@memhtml/contracts/paths"
import { parseMemory } from "@memhtml/html"
import { STATE_SCHEMA } from "@memhtml/index"
import { Effect, Logger } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { findingKeyOf, MINT_AUTHOR, MINT_CAP } from "../src/mint.js"
import {
  EDGE_DETECTOR,
  EDGE_QUOTE_CHARS,
  edgeTyping,
  edgeTypingCandidates,
  evidenceQuote,
  PROMOTION_DETECTIONS,
  resolveFingerprint
} from "../src/phases/edge-typing.js"
import { instantFor } from "../src/run.js"
import { openDetectedTasks } from "../src/sql.js"
import { scriptedModel, value } from "../src/testing.js"
import {
  DEDUP_CORPUS,
  type Fixture,
  memoryHtml,
  type SeedFile,
  seedCorroboration,
  withFixture
} from "./fixture.js"

/**
 * Edge typing's `resolve:` mint and its EXPLICIT closer, against a real repo and a real database.
 *
 * The phase's judging, batching, promotion, and cap already have their tier in `llm-phases.test.ts`.
 * This file is about the two behaviors task detection added, and they pull in opposite directions: one
 * FILES a task for a contradiction the corroboration gate refuses to write, and the other ARCHIVES one
 * whose finding the corpus has since settled. Both are asserted through the phase rather than through a
 * helper, because the placement of each is the property — the mint sits on the branch that used to
 * `continue` silently, and the closer runs on EVERY terminal path including the no-model one.
 *
 * The vacuous-lock rule governs the closure cases especially: "the task closed" is trivially true of a
 * closer that archives everything, so every case here also names something that must survive.
 */

const DATE = "2026-08-19"

const envFor = (fixture: Fixture, dryRun = false, date: string = DATE): PhaseEnv => {
  const instant = instantFor(date)
  return {
    deps: fixture.deps,
    runId: `sleep/${date}`,
    branch: `sleep/${date}`,
    baseSha: "",
    date,
    at: instant.at,
    atMillis: instant.millis,
    dryRun
  }
}

const SAFE = "areas/deploy/blue-green-is-safe.html"
const NOT_SAFE = "areas/deploy/blue-green-is-not-safe.html"

/** The flip pair's two files, reused rather than re-authored so their measured cosine still holds. */
const fileAt = (path: string): SeedFile => {
  const found = DEDUP_CORPUS.find((file) => file.path === path)
  if (found === undefined) throw new Error(`the fixture corpus no longer holds ${path}`)
  return found
}
const FLIP_PAIR = [fileAt(SAFE), fileAt(NOT_SAFE)]

/** A third corpus file on an unrelated topic, for a task that cites more paths than a pair has. */
const THIRD = "areas/metrics/scrape-cadence.html"

/**
 * The keys of the offered pairs whose text contains `needle`.
 *
 * A reply keyed by ORDINAL would answer about whichever pair the batch's sort put first and would
 * silently move onto another pair the day the ordering changed. Matching on the pair's own text is how
 * a scripted reply names the pair it means. Same helper, same reasoning, as `llm-phases.test.ts`.
 */
const pairKeysWithText = (prompt: string, needle: string): ReadonlyArray<string> =>
  [...prompt.matchAll(/<pair_(m\d+)>\n([\s\S]*?)\n<\/pair_m\d+>/g)].flatMap((match) =>
    (match[2] ?? "").includes(needle) ? [match[1] as string] : []
  )

/** Every offered pair's key, for a reply that means "all of them". */
const offeredKeys = (prompt: string): ReadonlyArray<string> => [
  ...new Set([...prompt.matchAll(/<pair_(m\d+)>/g)].map((match) => match[1] as string))
]

/** One `contradicts` verdict per pair whose text matches, `none` for the rest by omission. */
const contradictsOn = (needle: string, rationale = "Both name the same cutover and disagree.") =>
  scriptedModel((request) =>
    value({
      verdicts: pairKeysWithText(request.prompt, needle).map((pairKey) => ({
        pairKey,
        rel: "contradicts",
        direction: "src_to_dst",
        confidence: 0.93,
        rationale
      }))
    })
  )

/** A model that answers `contradicts` for EVERY pair it is offered, for the cap and volume cases. */
const contradictsAll = () =>
  scriptedModel((request) =>
    value({
      verdicts: offeredKeys(request.prompt).map((pairKey) => ({
        pairKey,
        rel: "contradicts",
        direction: "src_to_dst",
        confidence: 0.93,
        rationale: "scripted"
      }))
    })
  )

/** One file's bytes on disk, or `undefined`. The phase stages before it commits. */
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

/** The open `edge-typing:*` tasks the index projects, after a reindex. */
const openResolveTasks = (fixture: Fixture) =>
  openDetectedTasks(fixture.db, EDGE_DETECTOR).pipe(Effect.orDie)

/** The one `resolve:` task the flip-pair corpus mints, as a path plus its parsed doc. */
const theTask = (fixture: Fixture) =>
  Effect.gen(function* () {
    const [row] = yield* openResolveTasks(fixture)
    expect(row).toBeDefined()
    const html = (yield* onDisk(fixture, row?.path ?? "")) ?? ""
    const doc = yield* parseMemory(html).pipe(Effect.orDie)
    return { path: row?.path ?? "", status: row?.task_status ?? "", doc }
  })

/**
 * Edit one endpoint so its cited quote no longer occurs in it, committing the way a human would.
 *
 * The article is REPLACED rather than appended to, because appending leaves the original sentence in
 * place and the quote still matches — the point is the text the detector flagged being gone.
 */
const rewriteEndpoint = (fixture: Fixture, path: string, claim: string, body: string) =>
  fixture
    .commit(
      [
        {
          path,
          html: memoryHtml({
            title: "Blue-green cutover, corrected",
            claim,
            body,
            memoryType: "semantic",
            createdAt: "2026-05-04T00:00:00Z",
            confidence: "0.85",
            entities: ["service:payments-gateway"],
            tags: ["deploy"]
          })
        }
      ],
      "a human resolves the contradiction by editing one side"
    )
    .pipe(Effect.asVoid)

/** Move a file into the archive in the TREE, the way an eviction phase would. */
const archiveInTree = (fixture: Fixture, path: string) =>
  Effect.gen(function* () {
    const destination = archivePathFor(path, 2026)
    yield* Effect.promise(async () => {
      const { mkdir, rename } = await import("node:fs/promises")
      const { dirname, join } = await import("node:path")
      await mkdir(dirname(join(fixture.root, destination)), { recursive: true })
      await rename(join(fixture.root, path), join(fixture.root, destination))
    })
    yield* fixture.raw("add", "-A")
    yield* fixture.raw("commit", "-m", "archive one endpoint")
    return destination
  })

/** Stamp a task's `memhtml-task-status`, committing, so the index projects the new status. */
const setTaskStatus = (fixture: Fixture, path: string, status: string) =>
  Effect.gen(function* () {
    const html = (yield* onDisk(fixture, path)) ?? ""
    const edited = html.replace(
      /<meta name="memhtml-task-status" content="[a-z]+">/,
      `<meta name="memhtml-task-status" content="${status}">`
    )
    expect(edited).not.toBe(html)
    yield* fixture.commit([{ path, html: edited }], `a human takes the task: ${status}`)
    yield* fixture.reindex()
  })

describe("evidenceQuote", () => {
  it("collapses whitespace and cuts at a word boundary with no ellipsis", () => {
    /**
     * The no-ellipsis rule is a CORRECTNESS requirement, not a style choice: the quote has to stay
     * findable in the source, and a prefix plus `…` is not a substring of anything. A task minted with
     * one would report its own evidence as gone on the very next night — and would close itself.
     */
    expect(evidenceQuote("  one   two\nthree  ")).toBe("one two three")
    const long = `${"alpha ".repeat(80)}omega`
    const cut = evidenceQuote(long)
    expect(cut.length).toBeLessThanOrEqual(EDGE_QUOTE_CHARS)
    expect(cut).not.toContain("…")
    expect(cut.endsWith("alpha")).toBe(true)
    // And it really is a prefix of the collapsed source, which is what containment needs.
    expect(long.replace(/\s+/g, " ").trim().startsWith(cut)).toBe(true)
  })
})

describe("resolveFingerprint", () => {
  it("is a property of the UNORDERED pair, so an arm's orientation cannot re-file the task", () => {
    /**
     * The two candidate arms orient a pair differently and `unionPairs` keeps whichever saw it first.
     * A fingerprint carrying that orientation would re-file the same question as a new task on the
     * night the arms' order changed, while the old task looked absent to any closer.
     */
    expect(resolveFingerprint(SAFE, NOT_SAFE)).toBe(resolveFingerprint(NOT_SAFE, SAFE))
    expect(resolveFingerprint(`/${SAFE}`, NOT_SAFE)).toBe(resolveFingerprint(SAFE, NOT_SAFE))
    // Distinct pairs stay distinct: the `\0` separator cannot occur in a path.
    expect(resolveFingerprint(SAFE, NOT_SAFE)).not.toBe(resolveFingerprint(SAFE, "areas/a/b.html"))
  })
})

describe("edge-typing mints resolve tasks", () => {
  it("mints one task for a single-detection contradiction, quoting both sides with their paths", async () => {
    /**
     * The headline behavior. The pair is judged `contradicts` above the confidence floor and the
     * corroboration gate refuses to write the edge, which is exactly the branch that used to
     * `continue` in silence: the sighting lived only as a counter in the state plane, and a reviewer
     * had no way to see it. Every assertion below is about it being visible AND verifiable.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })

          // Detection, not promotion: nothing was written into either memory.
          expect(outcome.counts.contradictions).toBe(1)
          expect(outcome.counts.promoted).toBe(0)
          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.commitSha).not.toBeNull()
          expect(yield* onDisk(fixture, SAFE)).not.toContain("memhtml-contradicts")

          yield* fixture.reindex()
          const { path, doc } = yield* theTask(fixture)
          expect(path).toBe(
            "areas/inbox/tasks/resolve-blue-green-is-not-safe-and-blue-green-is-safe-may-contradict.html"
          )

          /** A well-formed detected task: no warnings, so `<q cite>` is inside the vocabulary. */
          expect(doc.warnings).toEqual([])
          expect(doc.metas.memoryType).toBe("task")
          expect(doc.metas.taskStatus).toBe("todo")
          expect(doc.metas.author).toBe(MINT_AUTHOR)
          expect(doc.metas.findingKey).toBe(
            findingKeyOf(EDGE_DETECTOR, resolveFingerprint(SAFE, NOT_SAFE))
          )
          expect(doc.article.gist).toBe(
            "resolve: blue-green-is-not-safe and blue-green-is-safe may contradict"
          )

          /**
           * BOTH sides quoted, each against its own path, and the quotes reached
           * `article.citations` — which is the projection doctor's stale-quote check and this phase's
           * own evidence-gone arm both read. A `<blockquote>` would land nothing here.
           */
          const cites = doc.article.citations.map((one) => one.href)
          expect(cites).toHaveLength(2)
          expect(cites).toContain(`/${SAFE}`)
          expect(cites).toContain(`/${NOT_SAFE}`)

          /** Each quote is actually IN the file it cites — the property the closer depends on. */
          for (const citation of doc.article.citations) {
            const source = (yield* onDisk(fixture, (citation.href ?? "").slice(1))) ?? ""
            const sourceDoc = yield* parseMemory(source).pipe(Effect.orDie)
            expect(sourceDoc.article.bodyText.replace(/\s+/g, " ")).toContain(
              citation.text.replace(/\s+/g, " ")
            )
          }

          /** The model's rationale is PROSE, escaped, and appears in no attribute. */
          expect(doc.article.bodyText).toContain("Both name the same cutover and disagree.")
          expect(doc.article.bodyText).toContain("0.93")
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("reports taskAlreadyOpen on a second night still below the gate, minting no duplicate", async () => {
    /**
     * The idempotency claim, and the one that matters most for a nightly job: a detector that re-filed
     * its finding every night would fill the inbox with one task per night forever. Night two's
     * verdict is the same and the pair is STILL below the promotion gate — night one bumped the
     * counter to 1 and night two to 2, so the second night promotes... which is why the counter is
     * held back below. See the promotion case for the other half.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const model = contradictsOn("is not safe")
          const one = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model }
          })
          expect(one.counts.taskMinted).toBe(1)
          yield* fixture.reindex()

          /**
           * The counter is reset to zero detections at a THIRD date, so night two is again a single
           * detection rather than the corroborating second one. Without this the second night would
           * promote and the closer would archive the task — a different behavior, covered separately.
           */
          yield* fixture.db.run(`DELETE FROM ${STATE_SCHEMA}.edge_corroboration`).pipe(Effect.orDie)

          const two = yield* edgeTyping({
            ...envFor(fixture, false, "2026-08-20"),
            deps: { ...fixture.deps, model }
          })
          expect(two.counts.taskAlreadyOpen).toBe(1)
          expect(two.counts.taskMinted).toBeUndefined()
          // ONE task in the tree, not two. The dedup is by exact finding key.
          expect(yield* openResolveTasks(fixture)).toHaveLength(1)
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("mints nothing for a pair the same night promotes, since the edge is now file-borne", async () => {
    /**
     * The gate's other side. A promoted row means both files gained the `contradicts` link, so there
     * is no open question — a task asking a human to look would be noise the closer archived on its
     * next pass. Seeded one detection short so THIS night is the corroborating second.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const [pair] = yield* edgeTypingCandidates(fixture.db).pipe(Effect.orDie)
          expect(pair).toBeDefined()
          yield* seedCorroboration(fixture.db, {
            srcPath: pair?.src ?? "",
            dstPath: pair?.dst ?? "",
            detections: PROMOTION_DETECTIONS - 1
          })

          const outcome = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })
          expect(outcome.counts.promoted).toBe(1)
          expect(outcome.counts.taskMinted).toBeUndefined()
          yield* fixture.reindex()
          expect(yield* openResolveTasks(fixture)).toEqual([])
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("mints nothing for a pair whose counter is ALREADY promoted from an earlier night", async () => {
    /**
     * The other half of the mint guard, and the reachable one. A pair promoted on some earlier night
     * carries `promoted = 1` forever, and it normally never returns as a candidate because both arms
     * anti-join AUTHORED edges — but a human deleting the two `<link>` lines puts it back in the scan
     * while the counter stays promoted. `bumpCorroboration` then reports `detections >= 2` with
     * `promoted = 1`, which lands on the mint branch.
     *
     * Nothing is minted, and the alternative is a loop rather than a mere extra file: the closer's
     * FIRST arm closes any `resolve:` task whose pair is promoted, so a mint here would file a task
     * and archive it on the same night, every night, forever. Reproduced by seeding the counter
     * promoted with neither file carrying the link, which is exactly the post-deletion state.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const [pair] = yield* edgeTypingCandidates(fixture.db).pipe(Effect.orDie)
          expect(pair).toBeDefined()
          yield* fixture.db
            .run(
              `INSERT INTO ${STATE_SCHEMA}.edge_corroboration
                 (src_path, rel, dst_path, detections, promoted, confirmed, updated_at)
               VALUES (?, 'contradicts', ?, ?, 1, 1, ?)`,
              [pair?.src ?? "", pair?.dst ?? "", PROMOTION_DETECTIONS, "2026-08-01T00:00:00Z"]
            )
            .pipe(Effect.orDie)
          // Non-vacuous: the pair really is still a candidate, because neither file carries the link.
          expect(yield* onDisk(fixture, SAFE)).not.toContain("memhtml-contradicts")

          const outcome = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })
          expect(outcome.counts.contradictions).toBe(1)
          expect(outcome.counts.taskMinted).toBeUndefined()
          yield* fixture.reindex()
          expect(yield* openResolveTasks(fixture)).toEqual([])
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("bounds one night's new tasks at MINT_CAP and counts the overflow", async () => {
    /**
     * The cap is on the DIFF a human reviews. A corpus that suddenly produced sixty contradictions is
     * a corpus problem, and turning it into sixty new files in one commit would make the night
     * unreviewable. Non-vacuous: the corpus offers genuinely more contradicting pairs than the cap.
     */
    const WIDE: ReadonlyArray<SeedFile> = Array.from({ length: 16 }, (_, offset) => ({
      path: `areas/queue/queue-${String(offset).padStart(2, "0")}.html`,
      html: memoryHtml({
        title: `Queue drain note ${offset}`,
        claim: `The queue drain worker leases a visibility window before acknowledging, note ${offset}.`,
        body: `Draining leases a visibility window per message and acknowledges after the handler returns, variant ${offset}.`,
        createdAt: `2026-04-${String((offset % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        entities: ["service:queue-drain"],
        tags: ["queue"]
      })
    }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const candidates = yield* edgeTypingCandidates(fixture.db).pipe(Effect.orDie)
          expect(candidates.length).toBeGreaterThan(MINT_CAP)

          const outcome = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsAll() }
          })
          expect(outcome.counts.taskMinted).toBe(MINT_CAP)
          expect(outcome.counts.mintOverflow).toBe(candidates.length - MINT_CAP)
          yield* fixture.reindex()
          expect(yield* openResolveTasks(fixture)).toHaveLength(MINT_CAP)
        }),
      { seed: WIDE }
    )
  })

  it("mints the same ten tasks twice over one corpus, whatever order the model answers in", async () => {
    /**
     * Which ten of sixteen findings become files is decided by SUBMISSION order, so submitting in
     * verdict order would make the answer depend on the model's own ordering — and two runs over an
     * unchanged corpus would write different tasks. The findings are collected and submitted in
     * FINGERPRINT order instead, which is a function of the pair set alone.
     *
     * Driven by giving the second run a model that answers in REVERSED verdict order. A test that ran
     * the same model twice would pass against a phase that submitted inline.
     */
    const WIDE: ReadonlyArray<SeedFile> = Array.from({ length: 16 }, (_, offset) => ({
      path: `areas/queue/queue-${String(offset).padStart(2, "0")}.html`,
      html: memoryHtml({
        title: `Queue drain note ${offset}`,
        claim: `The queue drain worker leases a visibility window before acknowledging, note ${offset}.`,
        body: `Draining leases a visibility window per message and acknowledges after the handler returns, variant ${offset}.`,
        createdAt: `2026-04-${String((offset % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        entities: ["service:queue-drain"],
        tags: ["queue"]
      })
    }))
    const reversed = () =>
      scriptedModel((request) =>
        value({
          verdicts: [...offeredKeys(request.prompt)].reverse().map((pairKey) => ({
            pairKey,
            rel: "contradicts",
            direction: "src_to_dst",
            confidence: 0.93,
            rationale: "scripted"
          }))
        })
      )
    const pathsFor = (model: ReturnType<typeof contradictsAll>) =>
      withFixture(
        (fixture) =>
          Effect.gen(function* () {
            yield* edgeTyping({ ...envFor(fixture), deps: { ...fixture.deps, model } })
            yield* fixture.reindex()
            return (yield* openResolveTasks(fixture)).map((row) => row.path).sort()
          }),
        { seed: WIDE }
      )

    const forward = await pathsFor(contradictsAll())
    const backward = await pathsFor(reversed())
    expect(forward).toHaveLength(MINT_CAP)
    expect(backward).toEqual(forward)
  })
})

describe("edge-typing closes resolve tasks", () => {
  it("closes on promotion, whatever the task's status, and states the reason in the commit", async () => {
    /**
     * Arm one. Night one mints; the counter is left at one detection so night two is the corroborating
     * second and promotes into both files. The contradiction is now FILE-BORNE, so the task asking a
     * human to look at it is moot — and that is true whether or not somebody picked the task up, which
     * is why this arm is NOT guarded by the todo-only rule. Driven at `doing` for exactly that reason.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const model = contradictsOn("is not safe")
          const one = yield* edgeTyping({ ...envFor(fixture), deps: { ...fixture.deps, model } })
          expect(one.counts.taskMinted).toBe(1)
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          yield* setTaskStatus(fixture, minted.path, "doing")

          const two = yield* edgeTyping({
            ...envFor(fixture, false, "2026-08-20"),
            deps: { ...fixture.deps, model }
          })
          expect(two.counts.promoted).toBe(1)
          expect(two.counts.taskClosed).toBe(1)

          /** Archived AND stamped done, in one move: the tree never holds an archived `todo`. */
          const archived = archivePathFor(minted.path, 2026)
          expect(yield* onDisk(fixture, minted.path)).toBeUndefined()
          const doc = yield* parseMemory((yield* onDisk(fixture, archived)) ?? "").pipe(
            Effect.orDie
          )
          expect(doc.metas.taskStatus).toBe("done")
          expect(doc.metas.status).toBe("archived")
          /** The key survives the move, so a later night cannot re-file the same finding. */
          expect(doc.metas.findingKey).toBe(
            findingKeyOf(EDGE_DETECTOR, resolveFingerprint(SAFE, NOT_SAFE))
          )

          /** The REASON has nowhere in the format to live, so the commit carries it. */
          const message = yield* fixture.raw("log", "-1", "--format=%B")
          expect(message).toContain("promoted to edge")
          expect(message).toContain(minted.path)
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("closes on a promotion recorded in the OPPOSITE orientation to the task's citations", async () => {
    /**
     * The orientation hole, and it took a mutation to find. `edge_corroboration` is keyed on
     * `(src_path, rel, dst_path)` in whatever order the CANDIDATE arm produced, while a task's
     * citations are written in the mint's own order — and nothing makes those two agree. On the flip
     * pair they happen to coincide, so dropping half of the promoted lookup left the whole suite green
     * (measured 2026-08-19); a corpus whose arm oriented the other way would then have every promoted
     * `resolve:` task survive forever, invisible to every other case here.
     *
     * Reproduced by seeding the counter DIRECTLY in the reversed orientation and marking it promoted,
     * with no model bound at all — so the closer's SQL is the only thing under test and the candidate
     * arm's own ordering cannot rescue it.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          const [first, second] = minted.doc.article.citations.map((one) => one.href ?? "")

          yield* fixture.db.run(`DELETE FROM ${STATE_SCHEMA}.edge_corroboration`).pipe(Effect.orDie)
          /** REVERSED against the task's own citation order, which is the whole point. */
          yield* fixture.db
            .run(
              `INSERT INTO ${STATE_SCHEMA}.edge_corroboration
                 (src_path, rel, dst_path, detections, promoted, confirmed, updated_at)
               VALUES (?, 'contradicts', ?, 2, 1, 1, ?)`,
              [(second ?? "").slice(1), (first ?? "").slice(1), "2026-08-19T00:00:00Z"]
            )
            .pipe(Effect.orDie)

          const outcome = yield* edgeTyping(envFor(fixture, false, "2026-08-20"))
          expect(outcome.counts.taskClosed).toBe(1)
          expect(yield* fixture.raw("log", "-1", "--format=%B")).toContain("promoted to edge")
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("closes when one endpoint leaves the active tree, whatever the task's status", async () => {
    /**
     * Arm two. Eviction is a `git mv` into the archive, and a contradiction with an evicted memory is
     * not a live conflict a human can resolve — so an ARCHIVED endpoint ends the finding just as a
     * deleted one does. Also driven at `doing`: the endpoint being gone is a fact about the tree, not
     * a guess about whether somebody is mid-fix.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const model = contradictsOn("is not safe")
          yield* edgeTyping({ ...envFor(fixture), deps: { ...fixture.deps, model } })
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          yield* setTaskStatus(fixture, minted.path, "doing")

          const destination = yield* archiveInTree(fixture, NOT_SAFE)
          // Non-vacuous: the endpoint really is gone from its live path and present in the archive.
          expect(yield* onDisk(fixture, NOT_SAFE)).toBeUndefined()
          expect(yield* onDisk(fixture, destination)).toBeDefined()

          const two = yield* edgeTyping({
            ...envFor(fixture, false, "2026-08-20"),
            deps: { ...fixture.deps, model }
          })
          expect(two.counts.taskClosed).toBe(1)
          expect(yield* onDisk(fixture, archivePathFor(minted.path, 2026))).toBeDefined()
          expect(yield* fixture.raw("log", "-1", "--format=%B")).toContain("endpoint gone")
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("closes a todo task when the human edits the cited quote away", async () => {
    /**
     * Arm three, and the LOAD-BEARING one: the ordinary way a contradiction gets fixed is a human
     * editing one of the two claims, and that edit IS the finding being resolved. Without this clause
     * the fix leaves the task open forever, and an inbox nobody can empty is an inbox nobody reads.
     *
     * The endpoint's article is REPLACED, not appended to — appending leaves the flagged sentence in
     * place and the quote still matches, so the case would assert nothing.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const model = contradictsOn("is not safe")
          yield* edgeTyping({ ...envFor(fixture), deps: { ...fixture.deps, model } })
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          const quote = minted.doc.article.citations.find(
            (one) => one.href === `/${NOT_SAFE}`
          )?.text
          expect(quote).toBeDefined()

          yield* rewriteEndpoint(
            fixture,
            NOT_SAFE,
            "The blue-green cutover window is now agreed with the payments gateway owners.",
            "Both notes were reconciled after the review and neither claims a hazard."
          )
          /** Non-vacuous: the quote genuinely no longer occurs in the endpoint's text. */
          const edited = yield* parseMemory((yield* onDisk(fixture, NOT_SAFE)) ?? "").pipe(
            Effect.orDie
          )
          expect(edited.article.bodyText).not.toContain(quote ?? "")

          /**
           * Night two runs with NO model bound, which makes two points at once: the closer is
           * deterministic, and this arm needs no re-detection to fire. The counter is also left at one
           * detection, so nothing could have promoted.
           */
          const two = yield* edgeTyping(envFor(fixture, false, "2026-08-20"))
          expect(two.counts.taskClosed).toBe(1)
          expect(two.detail).toBe("no model bound")
          expect(yield* onDisk(fixture, minted.path)).toBeUndefined()
          const closed = yield* parseMemory(
            (yield* onDisk(fixture, archivePathFor(minted.path, 2026))) ?? ""
          ).pipe(Effect.orDie)
          expect(closed.metas.taskStatus).toBe("done")
          expect(yield* fixture.raw("log", "-1", "--format=%B")).toContain("evidence gone")
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("leaves a doing task open when only the evidence went, since the human may be mid-fix", async () => {
    /**
     * The status SPLIT, which is the packet's §9 decision and the case that separates this closer from
     * `closeAbsent`'s blanket todo-only rule. A quote that stopped matching while somebody holds the
     * task is most likely THEIR edit in progress, and archiving their work item from under them is
     * exactly what the todo-only rule exists to prevent. The two arms above close a `doing` task; this
     * one does not — and the pairing is what makes the split real rather than an accident of ordering.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const model = contradictsOn("is not safe")
          yield* edgeTyping({ ...envFor(fixture), deps: { ...fixture.deps, model } })
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          yield* setTaskStatus(fixture, minted.path, "doing")

          yield* rewriteEndpoint(
            fixture,
            NOT_SAFE,
            "The blue-green cutover window is now agreed with the payments gateway owners.",
            "Both notes were reconciled after the review and neither claims a hazard."
          )
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          const two = yield* edgeTyping(envFor(fixture, false, "2026-08-20"))
          expect(two.counts.taskClosed).toBeUndefined()
          expect(two.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)

          /** Still at its live path, still `doing`, and nothing staged. */
          const doc = yield* parseMemory((yield* onDisk(fixture, minted.path)) ?? "").pipe(
            Effect.orDie
          )
          expect(doc.metas.taskStatus).toBe("doing")
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("closes nothing while both endpoints stand and their quotes still match", async () => {
    /**
     * The negative control the other four cases need. "The task closed" is trivially true of a closer
     * that archives everything, so this asserts the pass runs over an open task and leaves it alone —
     * repeatedly. A closer that closed by ABSENCE would archive here on night two, because the pair is
     * re-judged but the finding key is not what the closer reads.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const model = contradictsOn("is not safe")
          yield* edgeTyping({ ...envFor(fixture), deps: { ...fixture.deps, model } })
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          yield* fixture.db.run(`DELETE FROM ${STATE_SCHEMA}.edge_corroboration`).pipe(Effect.orDie)

          for (const date of ["2026-08-20", "2026-08-21"]) {
            const outcome = yield* edgeTyping(envFor(fixture, false, date))
            expect(outcome.counts.taskClosed).toBeUndefined()
            expect(outcome.commitSha).toBeNull()
          }
          expect(yield* onDisk(fixture, minted.path)).toBeDefined()
          expect(yield* openResolveTasks(fixture)).toHaveLength(1)
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("runs the closer on a night with no model bound at all", async () => {
    /**
     * The placement claim, stated as its own case. The closer sits BEFORE the `model === undefined`
     * return, so a credential-free night — every CI run and every unconfigured install — still notices
     * an archived endpoint. Wiring it after that return would have made `resolve:` tasks immortal on
     * exactly the nights nothing else happens. The mutation that breaks this is moving the
     * `resolveClosure` call below the early return; it fails here and in the evidence-gone case.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          yield* archiveInTree(fixture, NOT_SAFE)

          const outcome = yield* edgeTyping(envFor(fixture, false, "2026-08-20"))
          expect(outcome.detail).toBe("no model bound")
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.taskClosed).toBe(1)
          /** The closure got its OWN commit rather than being left for a later phase to absorb. */
          expect(outcome.commitSha).not.toBeNull()
          const message = yield* fixture.raw("log", "-1", "--format=%B")
          expect(message).toContain("Memhtml-Phase: edge-typing")
          expect(message).toContain("endpoint gone")
          expect(yield* onDisk(fixture, minted.path)).toBeUndefined()
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("counts a closure on a dry run and leaves the tree byte-identical", async () => {
    /**
     * The dry-run asymmetry, applied to the closer: every read runs, so the count is the real preview,
     * and only the archive move is skipped. An operator sizing a night is asking exactly that.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })
          yield* fixture.reindex()
          const minted = yield* theTask(fixture)
          yield* archiveInTree(fixture, NOT_SAFE)
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          const outcome = yield* edgeTyping({
            ...envFor(fixture, true, "2026-08-20"),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })
          expect(outcome.counts.taskClosed).toBe(1)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
          expect(yield* onDisk(fixture, minted.path)).toBeDefined()
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("leaves a task alone whose citations cannot name exactly two endpoints", async () => {
    /**
     * The closer recovers the pair from the task's `<q cite>` hrefs, which is a coupling to the mint
     * template — the finding key is a digest, so the paths are not in it, and no head meta carries a
     * pair. A task whose citations do not name exactly two paths is one the closer cannot reason
     * about: guessing would archive the wrong finding. So it declines, and says nothing.
     *
     * BOTH sides of "exactly two" are driven, because they fail against different wrong code. ONE
     * citation is caught by the destructuring alone. THREE is caught only by the `!== 2` clause — and
     * that is the one that matters: three cited paths means a `src`, a `dst`, and something else, and
     * taking the first two would pick a pair the finding is not about and archive a task over it. Both
     * quotes are also deliberately STALE against their files, so a closer that skipped this guard would
     * fall through to the evidence-gone arm and close.
     *
     * **And the skip is LOGGED, which is the one thing this case did not assert before.** Declining here is
     * permanent, unlike every other `continue` in the closer: the phase has no absence pass, so no arm can
     * ever reach these two tasks and they sit in the inbox until somebody deletes them. That is worth a line
     * an operator can find, and the cited COUNT is the diagnosis — one path means a hand-edit removed a
     * quote, three means the file is not a pair task at all.
     */
    const ONE_CITE = "areas/inbox/tasks/resolve-hand-edited.html"
    const THREE_CITE = "areas/inbox/tasks/resolve-hand-edited-wide.html"
    const STALE = "A quote that is not in that file at all."
    const handShaped = (path: string, cites: ReadonlyArray<string>): SeedFile => ({
      path,
      html: memoryHtml({
        title: "resolve: something and something else may contradict",
        claim: "resolve: something and something else may contradict",
        body: cites.map((cite) => `<q cite="/${cite}">${STALE}</q>`).join(" "),
        memoryType: "task",
        taskStatus: "todo",
        findingKey: findingKeyOf(EDGE_DETECTOR, `edge:hand edited ${path}`),
        createdAt: "2026-08-01T00:00:00Z",
        tags: ["detected"]
      })
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.commit(
            [handShaped(ONE_CITE, [SAFE]), handShaped(THREE_CITE, [SAFE, NOT_SAFE, THIRD])],
            "seed two tasks the closer cannot orient"
          )
          yield* fixture.reindex()
          // Non-vacuous: the closer really does walk both rows.
          const paths = (yield* openResolveTasks(fixture)).map((row) => row.path)
          expect(paths).toContain(ONE_CITE)
          expect(paths).toContain(THREE_CITE)

          const logs: Array<string> = []
          const capture = Logger.layer([
            Logger.make((options) => logs.push(String(options.message)))
          ])
          const outcome = yield* edgeTyping(envFor(fixture, false, "2026-08-20")).pipe(
            Effect.provide(capture)
          )
          expect(outcome.counts.taskClosed).toBeUndefined()
          expect(yield* onDisk(fixture, ONE_CITE)).toBeDefined()
          expect(yield* onDisk(fixture, THREE_CITE)).toBeDefined()

          /** Both skips are named, and each line carries ITS OWN cited count. */
          const said = logs.filter((line) => line.includes("not the two endpoints"))
          expect(said, logs.join(" | ")).toHaveLength(2)
          expect(said.find((line) => line.includes(ONE_CITE))).toContain("name 1 path(s)")
          expect(said.find((line) => line.includes(THREE_CITE))).toContain("name 3 path(s)")
        }),
      { seed: [...FLIP_PAIR, fileAt(THIRD)] }
    )
  })
})

/**
 * The commit SUBJECT on a night whose only output was tasks.
 *
 * A subject is the one line of a commit a human reads in `git log`, and both of these phases wrote a fixed
 * one naming their edge or merge work — so a night that promoted nothing and filed three findings said
 * `promote 0 typed edges and 0 corroborated contradictions`, which reads as a night that did nothing while
 * three new files sat in the commit. `dedup-merge` already had the arm (`file review tasks for vetoed
 * near-duplicates` when `merged === 0`), and these two now mirror it.
 *
 * Asserted on the SUBJECT LINE alone rather than on the whole message, because the counts trailer carries
 * `taskMinted` either way and a `toContain` over the full message would pass against the old subject.
 */
describe("edge-typing's mint-only commit subject", () => {
  /** The first line of HEAD's message, which is what a log reader sees. */
  const subjectOf = (fixture: Fixture): Effect.Effect<string> =>
    fixture.raw("log", "-1", "--format=%s").pipe(Effect.map((text) => text.trim()))

  it("says what it DID on a night that minted and promoted nothing", async () => {
    /**
     * The headline corpus of this whole file: one below-gate contradiction, one task, zero edges written.
     * That is the ordinary shape of a first night — the corroboration gate holds every new sighting back —
     * so this subject is what a reviewer meets most often, and `promote 0 typed edges` was actively
     * misleading about it.
     *
     * (Mutation: reverting to the unconditional subject fails the first two assertions here and nothing
     * else in this file, since every other case reads the BODY for a closure reason.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })

          /** Non-vacuous: a task really was filed and no edge really was written. */
          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.promoted).toBe(0)
          expect(outcome.counts.typed).toBe(0)
          expect(outcome.commitSha).not.toBeNull()

          const subject = yield* subjectOf(fixture)
          expect(subject).toContain("file resolve: tasks for detected contradictions")
          expect(subject).not.toContain("promote 0")
          /** Still a sleep commit of this phase, so `sleep resume` and `sleep review` are unaffected. */
          expect(subject).toContain("sleep(edge-typing)")
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("keeps the promotion subject on a night that WROTE an edge", async () => {
    /**
     * The other side, so the new arm is a branch rather than a rename. The second night is the
     * corroborating one, so it promotes into both files — and its subject has to stay the edge subject
     * even though the same commit also closes the task the first night filed.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const model = contradictsOn("is not safe")
          yield* edgeTyping({ ...envFor(fixture), deps: { ...fixture.deps, model } })
          yield* fixture.reindex()

          const two = yield* edgeTyping({
            ...envFor(fixture, false, "2026-08-20"),
            deps: { ...fixture.deps, model }
          })
          expect(two.counts.promoted).toBe(1)

          const subject = yield* subjectOf(fixture)
          expect(subject).toContain("promote 0 typed edges and 1 corroborated contradictions")
          expect(subject).not.toContain("file resolve:")
        }),
      { seed: FLIP_PAIR }
    )
  })

  it("keeps the closure subject on a night that ONLY closed", async () => {
    /**
     * The third subject this phase can write, unchanged. A closure-only night goes through `closureOnly`,
     * which has always had its own subject — so the new arm must not reach it. Driven with no model bound,
     * which is the path `closureOnly` owns.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictsOn("is not safe") }
          })
          yield* fixture.reindex()
          yield* archiveInTree(fixture, NOT_SAFE)

          const outcome = yield* edgeTyping(envFor(fixture, false, "2026-08-20"))
          expect(outcome.counts.taskClosed).toBe(1)
          expect(yield* subjectOf(fixture)).toContain("close 1 resolve task(s)")
        }),
      { seed: FLIP_PAIR }
    )
  })
})
