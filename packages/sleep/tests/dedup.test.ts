import { archivePathFor, originalPathFor } from "@memhtml/contracts/paths"
import { NEAR_DUPLICATE_THRESHOLD } from "@memhtml/domain"
import { contentHash, readMeta } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { PhaseEnv } from "../src/env.js"
import {
  DEDUP_COMPONENT_FLOOR,
  DEDUP_MAX_COMPONENT,
  dedupMerge
} from "../src/phases/dedup-merge.js"
import { instantFor } from "../src/run.js"
import { frameKeyPairs, neighborPairs } from "../src/sql.js"
import { type ScriptedModel, scriptedModel, value, violation } from "../src/testing.js"
import {
  BAND_DROP_PATH,
  BAND_KEEP_PATH,
  DEDUP_BAND_CORPUS,
  DEDUP_CORPUS,
  DEDUP_FRAME_CORPUS,
  DEDUP_VETO_TRIPLE,
  DEDUP_WIDE_FRAME_CORPUS,
  dedupComponentCorpus,
  type Fixture,
  FRAME_DROP_PATH,
  FRAME_KEEP_PATH,
  memoryHtml,
  TASK_CORPUS,
  VETO_KEEP_PATH,
  VETO_MERGE_DROP_PATH,
  VETO_REFUSED_PATH,
  withFixture
} from "./fixture.js"

/**
 * The dedup-merge phase: its two arms, and the veto that both of them route through.
 *
 * **The `describe("dedup-merge")` block binds NO MODEL, and that is the oracle.** Those tests are
 * unchanged from before the phase could call one, and they assert the deterministic arm: mine at 0.92,
 * orient older-keeper, filter, commit. A regression on that arm shows up as one of them failing, which
 * is exactly the guarantee the phase's header claims — a night with no credentials folds what it always
 * folded.
 *
 * The corpus carries a true duplicate AND a negation-flipped near-twin whose cosine is HIGHER than the
 * duplicate's (0.9907 against 0.9277, measured). So the veto's effect is observable: without it, the
 * flipped pair merges — and because the merge keeps the OLDER file, it would restore exactly the claim
 * the newer memory was written to correct. That is why the fixture holds a neighbor and not just a
 * subject.
 *
 * `describe("dedup-merge with a model")` then asserts the batched arm. Every test there names a
 * MEASURED fixture cosine, because the whole subject is which side of a floor a pair falls on, and a
 * fixture whose cosine was assumed would make each assertion a coin flip.
 */

const DATE = "2026-08-02"

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

/**
 * A path's bytes at HEAD, or `undefined` when HEAD does not hold it.
 *
 * Reads `git show` through the store's own `run`, NOT through `fixture.raw`: `raw` is `orDie`, so a
 * missing path becomes a DEFECT that `orElseSucceed` cannot catch — the test would crash where it
 * means to observe an absence, which is half of what a veto assertion is.
 */
const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

const KEEPER = "areas/oncall/drain-the-vip-first.html"
const DUPLICATE = "areas/oncall/vip-drain-precedes-revert.html"
const SAFE = "areas/deploy/blue-green-is-safe.html"
const NOT_SAFE = "areas/deploy/blue-green-is-not-safe.html"

describe("dedup-merge", () => {
  it("merges the true duplicate with a supersedes link and vetoes the negation flip", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const env = envFor(fixture)
          const outcome = yield* dedupMerge(env)

          /**
           * The corpus holds THREE candidate pairs above the threshold: two true duplicates and the
           * negation flip. Exactly one is vetoed, and the count is asserted alongside the per-file
           * observations below — the counter alone would not say WHICH pair was refused.
           */
          expect(outcome.counts.vetoed).toBe(1)
          expect(outcome.counts.merged).toBe(2)
          expect(outcome.commitSha).not.toBeNull()

          // The DUPLICATE moved into the archive, under the year the run's own date names.
          const archived = archivePathFor(DUPLICATE, 2026)
          expect(yield* atHead(fixture, archived)).toBeDefined()
          expect(yield* atHead(fixture, DUPLICATE)).toBeUndefined()
          expect(originalPathFor(archived)).toBe(DUPLICATE)

          // The keeper is the OLDER file, and it gained a supersedes toward the ARCHIVE path — not
          // toward the pre-archive path, which would dangle in the same commit that made it dangle.
          const keeper = yield* atHead(fixture, KEEPER)
          expect(keeper).toContain(`<link rel="memhtml-supersedes" href="/${archived}">`)

          // The archived file points back, and carries the archive stamps.
          const dropped = yield* atHead(fixture, archived)
          expect(readMeta(dropped ?? "", "memhtml-status")).toBe("archived")
          expect(readMeta(dropped ?? "", "memhtml-archived")).toBe(`${DATE}T00:00:00Z`)
          expect(dropped).toContain(`content="/${KEEPER}"`)

          /**
           * THE VETO. Both halves of the flipped pair are still live at their original paths, and
           * neither gained a supersedes. This is the assertion the whole fixture exists to make.
           */
          expect(yield* atHead(fixture, SAFE)).toBeDefined()
          expect(yield* atHead(fixture, NOT_SAFE)).toBeDefined()
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-supersedes")
          expect(yield* atHead(fixture, NOT_SAFE)).not.toContain("memhtml-supersedes")
          expect(yield* atHead(fixture, archivePathFor(NOT_SAFE, 2026))).toBeUndefined()
          expect(yield* atHead(fixture, archivePathFor(SAFE, 2026))).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("keeps the keeper's content hash unchanged: the supersedes link is a HEAD edit", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, KEEPER)
          yield* dedupMerge(envFor(fixture))
          const after = yield* atHead(fixture, KEEPER)

          expect(after).not.toBe(before)
          /**
           * The bytes changed and the ARTICLE hash did not. That is what the byte-splice head editors
           * buy: a `<link>` addition provably cannot move the dedup key, so a merge cannot make the
           * keeper collide with — or stop colliding with — another file's content.
           */
          expect(contentHash(after ?? "")).toBe(contentHash(before ?? ""))
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("counts on a dry run and writes nothing", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* dedupMerge(envFor(fixture, true))

          // The counts are REAL on a dry run — including the veto. Only the writes are withheld.
          expect(outcome.counts.merged).toBe(2)
          expect(outcome.counts.vetoed).toBe(1)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("is a fixed point on a second run: the merged duplicate is no longer a candidate", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))
          // Re-index so the phase sees the post-merge corpus, exactly as the next night's run would.
          yield* fixture.reindex()
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          const second = yield* dedupMerge(envFor(fixture))
          expect(second.counts.merged).toBe(0)
          expect(second.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

/**
 * The frame-key seed query, directly.
 *
 * It exists to find pairs the cosine floor cannot, so a test over it has to show BOTH halves: the pair
 * is emitted, and no floor a night could afford would have emitted it. The fixture's measured 0.5892
 * makes the second half checkable rather than asserted.
 */
describe("frameKeyPairs", () => {
  it("emits the same-slot pair that NO cosine floor reaches, and nothing else", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const seeds = yield* frameKeyPairs(fixture.db)

          /**
           * Exactly one pair over the whole seeded corpus, and oriented ONCE — asserted as `dst < src`
           * rather than by naming which path lands where. The two paths differ at a `-` against a `.`,
           * so hard-coding the sides would encode a byte-order accident as if it were the query's
           * contract, and the ORIENTATION is what the statement promises.
           */
          expect(seeds).toHaveLength(1)
          const seed = seeds[0] as { readonly src: string; readonly dst: string }
          expect([seed.src, seed.dst].toSorted()).toEqual(
            [FRAME_KEEP_PATH, FRAME_DROP_PATH].toSorted()
          )
          expect(seed.dst < seed.src).toBe(true)

          /**
           * And the mining arm does not reach it, at a floor well BELOW the phase's own. Without this
           * the test above would hold just as well on a corpus where the cosine arm already found the
           * pair, and the seed would be buying nothing.
           */
          const mined = yield* neighborPairs(fixture.db, {
            floor: 0.7,
            perSourceK: 10,
            limit: 500,
            excludeTypes: ["arc", "task"]
          })
          const namesFramePair = (pair: { src: string; dst: string }) =>
            [pair.src, pair.dst].every(
              (path) => path === FRAME_KEEP_PATH || path === FRAME_DROP_PATH
            )
          expect(mined.filter(namesFramePair)).toEqual([])
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_FRAME_CORPUS] }
    )
  })

  it("emits no pair with a TASK endpoint, at the corpus where two tasks share a slot", async () => {
    /**
     * Two open tasks phrased alike are two things to do. The exclusion is in the statement AND in the
     * partial index's predicate, and this asserts the statement's copy: both task claims below key on
     * the same frame, so a query without the carve-out would emit them.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const seeds = yield* frameKeyPairs(fixture.db)
          expect(seeds.some((pair) => `${pair.src} ${pair.dst}`.includes("/tasks/"))).toBe(false)
          // The memory pair on the same shape IS still found, so the filter is not just refusing all.
          expect(seeds).toHaveLength(1)
          expect([seeds[0]?.src, seeds[0]?.dst].sort()).toEqual(
            [FRAME_KEEP_PATH, FRAME_DROP_PATH].sort()
          )
        }),
      {
        seed: [
          ...DEDUP_FRAME_CORPUS,
          {
            path: "areas/inbox/tasks/t-confirm-owner-a.html",
            html: memoryHtml({
              title: "Confirm the deploy runbook owner",
              claim: "The owner of the deploy runbook is unconfirmed.",
              memoryType: "task",
              taskStatus: "todo",
              createdAt: "2026-03-05T00:00:00Z"
            })
          },
          {
            path: "areas/inbox/tasks/t-confirm-owner-b.html",
            html: memoryHtml({
              title: "Record the deploy runbook owner",
              claim: "The owner of the deploy runbook is unrecorded.",
              memoryType: "task",
              taskStatus: "todo",
              createdAt: "2026-03-06T00:00:00Z"
            })
          }
        ]
      }
    )
  })

  it("emits nothing for an ARCHIVED endpoint", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          expect(yield* frameKeyPairs(fixture.db)).toHaveLength(1)
          yield* fixture.db.run("UPDATE files SET archived = 1 WHERE path = ?", [FRAME_DROP_PATH])
          // An evicted memory is not a live claim, so it cannot occupy a slot alongside one.
          expect(yield* frameKeyPairs(fixture.db)).toEqual([])
        }),
      { seed: DEDUP_FRAME_CORPUS }
    )
  })
})

describe("dedup-merge with a model", () => {
  /** Every prompt the phase sent, so a test can assert on the bytes and on the call count. */
  const partitionsBy = (
    choose: (prompt: string) => ReadonlyArray<ReadonlyArray<string>>
  ): ScriptedModel =>
    scriptedModel((request) =>
      value({ groups: choose(request.prompt).map((keys) => ({ memberKeys: keys })) })
    )

  /** The offered keys of the members whose text contains `needle`, read out of the prompt itself. */
  const keysMatching = (prompt: string, needles: ReadonlyArray<string>): Array<string> => {
    const found: Array<string> = []
    for (const match of prompt.matchAll(/<member_(m\d+)>\n([\s\S]*?)\n<\/member_\1>/g)) {
      const key = match[1] ?? ""
      const text = match[2] ?? ""
      if (needles.some((needle) => text.includes(needle))) found.push(key)
    }
    return found
  }

  it("MERGES a 0.8673 pair the deterministic floor cannot see — the headline behavior", async () => {
    /**
     * The band pair measures 0.8673: above `DEDUP_COMPONENT_FLOOR` 0.86 and below
     * `NEAR_DUPLICATE_THRESHOLD` 0.92. So the model's answer is the ONLY thing that can fold it, and the
     * same corpus with no model bound (asserted below) leaves it alone.
     */
    expect(DEDUP_COMPONENT_FLOOR).toBeLessThan(0.8673)
    expect(NEAR_DUPLICATE_THRESHOLD).toBeGreaterThan(0.8673)

    const model = partitionsBy((prompt) => [
      keysMatching(prompt, ["nightly index rebuild", "read by the nightly"])
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.llmGroups).toBe(1)
          expect(outcome.llmCalls).toBeGreaterThan(0)

          // The OLDER member is the keeper, and it points at the archive path.
          const archived = archivePathFor(BAND_DROP_PATH, 2026)
          expect(yield* atHead(fixture, archived)).toBeDefined()
          expect(yield* atHead(fixture, BAND_DROP_PATH)).toBeUndefined()
          expect(yield* atHead(fixture, BAND_KEEP_PATH)).toContain(
            `<link rel="memhtml-supersedes" href="/${archived}">`
          )
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_BAND_CORPUS], model }
    )
  })

  it("leaves that same 0.8673 pair alone with NO model, which is what makes the merge the model's", async () => {
    /**
     * The control for the test above. Without it, "the model merged it" would hold just as well against
     * a phase that had quietly lowered its merge floor to 0.86 and never called anything.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.components).toBe(0)
          expect(yield* atHead(fixture, BAND_DROP_PATH)).toBeDefined()
          expect(yield* atHead(fixture, BAND_KEEP_PATH)).not.toContain("memhtml-supersedes")
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_BAND_CORPUS] }
    )
  })

  it("folds a FRAME-SEEDED pair whose cosine (0.5892) no floor reaches", async () => {
    /**
     * The seed's whole point, end to end. The two memories share a frame slot and almost no vocabulary,
     * so the component exists only because `frameKeyPairs` produced the edge — and the pair's synthetic
     * similarity is `DEDUP_COMPONENT_FLOOR` itself, which is why `DEDUP_ADMIT_FLOOR` is 0 and not the
     * floor. (Mutation: setting the filter's threshold to `DEDUP_COMPONENT_FLOOR` fails here, and
     * reports the pair as a VETO rather than as a skip.)
     */
    const model = partitionsBy((prompt) => [keysMatching(prompt, ["Priya"])])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.llmGroups).toBe(1)
          expect(outcome.counts.vetoed).toBe(0)
          const archived = archivePathFor(FRAME_DROP_PATH, 2026)
          expect(yield* atHead(fixture, archived)).toBeDefined()
          expect(yield* atHead(fixture, FRAME_KEEP_PATH)).toContain(
            `<link rel="memhtml-supersedes" href="/${archived}">`
          )
        }),
      { seed: DEDUP_FRAME_CORPUS, model }
    )
  })

  it("VETOES the negation pair inside a model group and merges the rest of it", async () => {
    /**
     * The veto as a PER-PAIR post-filter, which is the property batching puts at risk. The model is
     * given `{safe, not-safe, safe-2}` and groups all three; the implied pairs are
     * `safe→not-safe` (0.9898, negation-divergent) and `safe→safe-2` (0.8903, clean).
     *
     * A phase that applied the veto per GROUP would either fold the negation in or refuse the honest
     * duplicate. Both files of the vetoed pair staying live, while the clean pair folds, is the only
     * outcome that shows the filter runs on pairs.
     */
    const model = partitionsBy((prompt) => [keysMatching(prompt, ["blue-green"])])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          // The clean pair merged: `safe` is the oldest of the three, so it is the keeper.
          const archived = archivePathFor(VETO_MERGE_DROP_PATH, 2026)
          expect(yield* atHead(fixture, archived)).toBeDefined()
          expect(yield* atHead(fixture, VETO_KEEP_PATH)).toContain(
            `<link rel="memhtml-supersedes" href="/${archived}">`
          )

          // THE VETO. The negation is still live at its own path and gained no supersedes.
          expect(yield* atHead(fixture, VETO_REFUSED_PATH)).toBeDefined()
          expect(yield* atHead(fixture, VETO_REFUSED_PATH)).not.toContain("memhtml-supersedes")
          expect(yield* atHead(fixture, archivePathFor(VETO_REFUSED_PATH, 2026))).toBeUndefined()
          expect(outcome.counts.vetoed).toBeGreaterThan(0)
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_VETO_TRIPLE], model }
    )
  })

  it("holds the both-roles guard ACROSS two model groups that share a path", async () => {
    /**
     * The corruption the guard exists to stop, arriving from ONE model answer instead of from two
     * nights: given `(gf → a)` then `(b → gf)`, both commit, `gf` absorbs `a` and is then archived into
     * `b`, superseding `a`'s content into a file the same batch destroyed.
     *
     * The two groups below overlap on the oncall keeper. The phase must commit the first and refuse the
     * second, so the shared path holds ONE role: three files, one archive, and the keeper never moved.
     */
    const model = partitionsBy((prompt) => [
      keysMatching(prompt, ["drain the VIP", "Drain the VIP"]),
      // The same keeper again, this time paired with the metrics memory. Refused.
      keysMatching(prompt, ["drain the VIP", "scrapes every exporter"])
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))

          const keeper = "areas/oncall/drain-the-vip-first.html"
          const firstDrop = "areas/oncall/vip-drain-precedes-revert.html"
          const secondDrop = "areas/metrics/scrape-cadence.html"

          // The keeper is still at its own path: it was never itself archived.
          expect(yield* atHead(fixture, keeper)).toBeDefined()
          expect(yield* atHead(fixture, archivePathFor(keeper, 2026))).toBeUndefined()
          // The first group's drop is archived…
          expect(yield* atHead(fixture, archivePathFor(firstDrop, 2026))).toBeDefined()
          // …and the second group's is NOT, because its keeper was already claimed.
          expect(yield* atHead(fixture, secondDrop)).toBeDefined()
          expect(yield* atHead(fixture, archivePathFor(secondDrop, 2026))).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("DROPS a group that spans two components rather than splitting it", async () => {
    /**
     * A model that grouped across components disagreed with the measurement that separated them, and
     * there is no reason to trust the surviving half of that answer more than the discarded part.
     *
     * The band pair and the frame pair are separate components: the highest cosine between the two
     * fixtures is 0.6212, well under the 0.86 recall floor, and their frame keys differ. So one group
     * naming a member of each really does span two components, and split in half it would fold both
     * pairs. It folds neither.
     */
    const model = partitionsBy((prompt) => [
      [...keysMatching(prompt, ["nightly index rebuild"]), ...keysMatching(prompt, ["Priya"])]
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          // The two components really were offered, so the group genuinely spanned them.
          expect(outcome.counts.components).toBe(2)
          expect(outcome.counts.llmGroups).toBe(0)
          expect(outcome.counts.merged).toBe(0)
          // Every member of the spanning group is still live and unsuperseded.
          for (const path of [BAND_KEEP_PATH, BAND_DROP_PATH, FRAME_KEEP_PATH, FRAME_DROP_PATH]) {
            expect(yield* atHead(fixture, path)).toBeDefined()
            expect(yield* atHead(fixture, path)).not.toContain("memhtml-supersedes")
          }
        }),
      { seed: [...DEDUP_BAND_CORPUS, ...DEDUP_FRAME_CORPUS], model }
    )
  })

  it("DROPS the keys a batch never offered, and a group left with fewer than two", async () => {
    const model = partitionsBy((prompt) => [
      // One real key plus three the batch never offered: the group falls under two and is skipped.
      [...keysMatching(prompt, ["nightly index rebuild"]).slice(0, 1), "m99", BAND_DROP_PATH, ""]
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))
          expect(outcome.counts.llmGroups).toBe(0)
          expect(yield* atHead(fixture, BAND_DROP_PATH)).toBeDefined()
          expect(yield* atHead(fixture, BAND_KEEP_PATH)).not.toContain("memhtml-supersedes")
        }),
      { seed: DEDUP_BAND_CORPUS, model }
    )
  })

  it("still folds a valid group carrying an INVENTED key alongside its real ones", async () => {
    /**
     * The unknown key has to be dropped, not counted — and the two gates it could wrongly trip are
     * different, which is why this case is separate from the one above.
     *
     * There the group had ONE real key, so the `< 2` gate refused it whatever the unknown key did.
     * Here it has two real keys plus an invented one, so the only thing the unknown key can break is
     * CONTAINMENT: `componentOfKey.get("m99")` is `undefined`, and a check that counted `undefined` as a
     * component would see two components and drop a group that is entirely inside one.
     *
     * (Verified by mutation: reading the containment set as
     * `new Set(group.memberKeys.map((key) => componentOfKey.get(key)))` leaves the test above green and
     * fails here.)
     */
    const model = partitionsBy((prompt) => [
      [...keysMatching(prompt, ["nightly index rebuild", "read by the nightly"]), "m99"]
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          expect(outcome.counts.llmGroups).toBe(1)
          expect(outcome.counts.merged).toBe(1)
          // The invented key named no file, so nothing outside the offered pair was touched.
          const archived = archivePathFor(BAND_DROP_PATH, 2026)
          expect(yield* atHead(fixture, archived)).toBeDefined()
          expect(yield* atHead(fixture, BAND_KEEP_PATH)).toContain(
            `<link rel="memhtml-supersedes" href="/${archived}">`
          )
        }),
      { seed: DEDUP_BAND_CORPUS, model }
    )
  })

  it("truncates a component past the size cap to its LOWEST paths", async () => {
    /**
     * Ten memories in one frame slot (measured: max pairwise cosine 0.6365, so NOT ONE mined edge joins
     * them — the component is purely frame-derived) against a cap of eight.
     *
     * The assertion is on what the model was OFFERED, not on what merged. The cap governs which members
     * reach a call, and reading it off the prompt is the only place it is observable: the both-roles
     * guard then limits the whole component to one fold whatever the cap admitted (asserted separately
     * below), so a merge count could not tell 8 offered from 10.
     */
    const model = partitionsBy(() => [])

    const calls = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))
          return model.calls
        }),
      { seed: DEDUP_WIDE_FRAME_CORPUS, model }
    )

    // One component, one call, and exactly `DEDUP_MAX_COMPONENT` members inside it.
    expect(calls).toHaveLength(1)
    const prompt = calls[0]?.prompt ?? ""
    const offered = [...prompt.matchAll(/<member_(m\d+)>/g)].map((match) => match[1])
    expect(offered).toHaveLength(DEDUP_MAX_COMPONENT)
    expect(DEDUP_WIDE_FRAME_CORPUS).toHaveLength(DEDUP_MAX_COMPONENT + 2)

    /**
     * And which eight: the LOWEST PATHS. Truncating by cosine instead would make the considered set a
     * property of the floor rather than of the corpus. The two highest are DEFERRED — they are still
     * live, so tonight's folds shrink the component and tomorrow reaches them.
     */
    const claims = DEDUP_WIDE_FRAME_CORPUS.map((file) => file.path)
      .toSorted()
      .map((path) => path.replace("areas/ingest/primary-region-", "").replace(".html", ""))
    for (const name of claims.slice(0, DEDUP_MAX_COMPONENT)) {
      expect(prompt).toContain(`The primary region of the ingest cluster is ${name}.`)
    }
    for (const name of claims.slice(DEDUP_MAX_COMPONENT)) {
      expect(prompt).not.toContain(`The primary region of the ingest cluster is ${name}.`)
    }
  })

  it("folds ONE pair of a large component per night, because a path holds one role", async () => {
    /**
     * The other half of the story above, and the reason the truncation test reads the prompt.
     *
     * A model that groups eight members implies seven pairs, all sharing one keeper — and the
     * both-roles guard fixes a path's role for the batch, so the first pair commits and the remaining
     * six are refused. That is not a shortfall: superseding six files into a keeper in one commit is
     * exactly the transitive chain the guard exists to break, and the survivors are candidates again
     * tomorrow against a keeper that now carries the absorbed content.
     */
    const model = partitionsBy((prompt) => [
      [...prompt.matchAll(/<member_(m\d+)>/g)].map((match) => match[1] ?? "")
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          // One group proposed, one fold committed.
          expect(outcome.counts.llmGroups).toBe(1)
          expect(outcome.counts.merged).toBe(1)

          const paths = DEDUP_WIDE_FRAME_CORPUS.map((file) => file.path).toSorted()
          const keeper = paths[0] ?? ""
          const firstDrop = paths[1] ?? ""

          // The lowest path is the keeper and the second lowest is its drop.
          expect(yield* atHead(fixture, keeper)).toBeDefined()
          expect(yield* atHead(fixture, archivePathFor(firstDrop, 2026))).toBeDefined()
          expect(yield* atHead(fixture, keeper)).toContain("memhtml-supersedes")
          // Every other member is still live: the guard refused six pairs on the shared keeper.
          for (const path of paths.slice(2)) {
            expect(yield* atHead(fixture, path)).toBeDefined()
            expect(yield* atHead(fixture, archivePathFor(path, 2026))).toBeUndefined()
          }
        }),
      { seed: DEDUP_WIDE_FRAME_CORPUS, model }
    )
  })

  it("ISOLATES a failing batch: only its own components are skipped", async () => {
    /**
     * `dedup-merge` is a HARD prerequisite of compress and retention-triage, so failing the phase over
     * one malformed tool payload would cancel two later phases as well as this night. The corpus is 21
     * independent two-file components, which at 40 members per call is two batches — so the FIRST call
     * fails and the second must still fold its own components.
     */
    const model = scriptedModel((request, offset) =>
      offset === 0
        ? violation("scripted bad tool payload")
        : value({
            groups: [...request.prompt.matchAll(/component_\d+ holds ([^.]+)\./g)].map((match) => ({
              memberKeys: (match[1] ?? "").split(", ")
            }))
          })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))

          // The phase SUCCEEDED, with the failure recorded as a count rather than raised.
          expect(outcome.llmCalls).toBeGreaterThan(1)
          expect(outcome.counts.skipped).toBe(1)
          // And the surviving batch did real work: the failure cost only its own components.
          expect(outcome.counts.llmGroups).toBeGreaterThan(0)
          expect(outcome.counts.merged).toBeGreaterThan(0)
          expect(outcome.commitSha).not.toBeNull()
        }),
      { seed: dedupComponentCorpus(21), model }
    )
  })

  it("packs whole components into shared calls rather than one call per component", async () => {
    /**
     * The cost property the batching kernel exists for: 21 components would be 21 calls one at a time.
     * The measured envelope in issue #43 is ~15-25 calls a NIGHT over a 2,907-memory corpus, which only
     * holds if a call carries many components.
     */
    const model = partitionsBy(() => [])

    const calls = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))
          return model.calls
        }),
      { seed: dedupComponentCorpus(21), model }
    )

    /**
     * 21 components in 2 calls. Measured: `DEDUP_BATCH_MEMBERS` is 40 and each component is 2 members,
     * so 20 components fill the first call and the 21st starts a second — the member cap binds before
     * the character budget does at this fixture's size.
     */
    expect(calls).toHaveLength(2)
    const componentsPerCall = calls.map(
      (call) => [...call.prompt.matchAll(/component_\d+ holds/g)].length
    )
    expect(componentsPerCall).toEqual([20, 1])
    // Every component reached a call exactly once: packing bounds cost, it does not drop work.
    expect(componentsPerCall.reduce((total, one) => total + one, 0)).toBe(21)

    for (const call of calls) {
      /**
       * The system prompt is the SAME bytes every time and is marked cacheable, so a night's batches
       * share one prefix instead of re-billing it per call. A phase that forgot the flag would look
       * identical in its counts and in its written files.
       */
      expect(call.system).toBe(calls[0]?.system)
      expect(call.cacheSystem).toBe(true)
      // Only the member list varies, which is what makes that prefix worth caching.
      expect(call.prompt).not.toBe(calls[0] === call ? "" : calls[0]?.prompt)
    }
  })

  it("refuses every group and still folds what the DETERMINISTIC floor proves", async () => {
    /**
     * `groups: []` is a valid answer and the safe one. The phase must then behave as it does with no
     * model: the 0.9277 and 0.9323 pairs fold, the 0.9898 negation is vetoed. This is what keeps the
     * deterministic floor from regressing when a model is bound but unhelpful.
     */
    const model = partitionsBy(() => [])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* dedupMerge(envFor(fixture))
          expect(outcome.counts.llmGroups).toBe(0)
          expect(outcome.counts.merged).toBe(2)
          expect(outcome.counts.vetoed).toBe(1)
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("does NOT fold a recall-band pair the model declined to group", async () => {
    /**
     * The recall floor is a MINING floor, not a merge floor. A pair at 0.8673 that the model left out
     * of every group stays put: the model's silence about it is the answer, and folding it anyway would
     * make 0.86 the merge threshold by the back door.
     */
    const model = partitionsBy(() => [])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))
          expect(yield* atHead(fixture, BAND_DROP_PATH)).toBeDefined()
          expect(yield* atHead(fixture, BAND_KEEP_PATH)).not.toContain("memhtml-supersedes")
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_BAND_CORPUS], model }
    )
  })

  it("is a fixed point on a second run over the post-merge corpus", async () => {
    const model = partitionsBy((prompt) => [
      keysMatching(prompt, ["nightly index rebuild", "read by the nightly"])
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const first = yield* dedupMerge(envFor(fixture))
          expect(first.counts.merged).toBeGreaterThan(0)
          yield* fixture.reindex()
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          const second = yield* dedupMerge(envFor(fixture))
          expect(second.counts.merged).toBe(0)
          expect(second.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_BAND_CORPUS], model }
    )
  })

  it("counts on a dry run and writes nothing, model call included", async () => {
    const model = partitionsBy((prompt) => [
      keysMatching(prompt, ["nightly index rebuild", "read by the nightly"])
    ])

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* dedupMerge(envFor(fixture, true))

          // The counts are real — including what the model proposed. Only the writes are withheld.
          expect(outcome.counts.llmGroups).toBe(1)
          expect(outcome.counts.merged).toBeGreaterThan(0)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_BAND_CORPUS], model }
    )
  })

  it("offers members under OPAQUE keys, never under a path", async () => {
    /**
     * This corpus stores instructions, so a member's own text can read as a directive about naming — and
     * a prompt that named paths would let the model answer with a write target it inferred rather than
     * one it was offered.
     */
    const model = partitionsBy(() => [])

    const calls = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))
          return model.calls
        }),
      { seed: [...DEDUP_CORPUS, ...DEDUP_BAND_CORPUS], model }
    )

    for (const call of calls) {
      expect(call.prompt).not.toContain(".html")
      expect(call.prompt).not.toContain("areas/")
      // The keys really are the opaque form.
      expect(call.prompt).toMatch(/<member_m\d+>/)
    }
  })

  it("puts no TASK in a component, at a floor the near-duplicate task pair clears", async () => {
    const model = partitionsBy(() => [])

    const calls = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* dedupMerge(envFor(fixture))
          return model.calls
        }),
      { seed: [...DEDUP_CORPUS, ...TASK_CORPUS], model }
    )

    /**
     * The task pair's own cosine clears 0.86, so a phase without the exclusion WOULD batch it — and
     * folding two open tasks archives real work an agent still owes. Asserted on the prompt text, since
     * the exclusion is invisible in the counts.
     */
    for (const call of calls) {
      expect(call.prompt).not.toContain("deploy runbook needs a review")
      expect(call.prompt).not.toContain("staging bastion port")
    }
  })
})
