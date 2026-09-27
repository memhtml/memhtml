import type { MemoryRecord } from "@memhtml/contracts"
import { type NewMemoryInput, renderTemplate } from "@memhtml/html"
import { HashMap } from "effect"
import { afterAll, describe, expect, it } from "vitest"

import {
  advanceHead,
  gateHeads,
  HEAD_GATE_TOLERANCE,
  HeadGateFailed,
  loadHead,
  probeQueryFor,
  probesFor,
  scoreProbes,
  versionFromRecords
} from "../src/index.js"
import { INDEXES } from "../src/indexes.js"
import { commitChanges, makeCorpus, mapView, memoryFor, recordOf, run } from "./helpers.js"

/**
 * The head gate (`gate.ts`): the same probes scored at two versions, a pass when the landed version
 * finds them no worse than the base did.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `gateHeads`: `passed: after.mrr >= floor` (drop the inversion clause) -> "a landing whose new
 *   record pushes a probe out of the top k grows the inversions and fails".
 * - `scoreProbes`: drop `byRank < rank` (report every superseded record that is ranked) -> "a
 *   superseded record ranked below its superseder is not an inversion".
 * - `gateHeads`: `const floor = round4(before.mrr)` (ignore the tolerance) -> "an MRR drop within
 *   the tolerance passes and one past it fails" (the within-tolerance half turns red).
 * - `probesFor`: drop `.filter((record) => isActiveAt(base, record.path))` -> "probes are records
 *   active in both versions, in a seeded order" (a record only the landed version holds is probed).
 * - `versionFromRecords`: build with `makeVersion(emptyIndexes, sha, null, [])` -> "agrees with the
 *   git-built version index for index" (size 0).
 */

const AT = "2026-03-01T12:00:00Z"

const record = (
  path: string,
  input: Partial<NewMemoryInput> & { readonly title: string; readonly claim: string }
): Promise<MemoryRecord> =>
  recordOf({
    path,
    html: renderTemplate({ memoryType: "semantic", at: AT, ...input })
  })

/**
 * Ten distinct records whose titles and claims share no token (stop words aside), so each probe
 * ranks its own record first and a twin of one leaves the other nine alone.
 */
const distinct = async (): Promise<ReadonlyArray<MemoryRecord>> =>
  Promise.all(
    [
      ["harbor", "Harbor cranes unload at dawn."],
      ["glacier", "Glacier ice calves in summer."],
      ["orchard", "Orchard rows run north to south."],
      ["furnace", "Furnace bricks crack under load."],
      ["lantern", "Lantern oil burns clean."],
      ["compass", "Compass needles drift near ore."],
      ["quarry", "Quarry stone weathers gray."],
      ["saddle", "Saddle leather softens with wax."],
      ["turbine", "Turbine blades pitch with wind."],
      ["velvet", "Velvet nap catches light."]
    ].map(([word, claim], index) =>
      record(`areas/inbox/${word}.html`, {
        title: word ?? "",
        claim: claim ?? "",
        at: `2026-03-${String(index + 1).padStart(2, "0")}T12:00:00Z`
      })
    )
  )

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("probeQueryFor", () => {
  it("is the title, else the first sentence of the claim", async () => {
    const titled = await record("areas/inbox/t.html", { title: "Rollback order", claim: "A. B." })
    expect(probeQueryFor(titled)).toBe("Rollback order")
    expect(probeQueryFor({ ...titled, title: "  " })).toBe("A.")
    expect(probeQueryFor({ ...titled, title: "", claim: "No terminal punctuation" })).toBe(
      "No terminal punctuation"
    )
    expect(
      probeQueryFor({ ...titled, title: "", claim: "Drain the VIP first! Then revert." })
    ).toBe("Drain the VIP first!")
  })
})

describe("probesFor", () => {
  it("probes are records active in both versions, in a seeded order", async () => {
    const records = await distinct()
    const [onlyLanded, archivedLater, ...shared] = records
    if (onlyLanded === undefined || archivedLater === undefined) throw new Error("fixture")
    const base = mapView([...shared, archivedLater], "base")
    const landed = mapView(
      [
        ...shared,
        onlyLanded,
        { ...archivedLater, path: `archive/2026/${archivedLater.path}`, archived: true }
      ],
      "landed"
    )
    const probes = probesFor(base, landed, { seed: 1, count: 100 })
    expect(probes.map((probe) => probe.path).sort()).toEqual(shared.map((item) => item.path).sort())
    expect(probes.map((probe) => probe.path)).not.toContain(onlyLanded.path)
    // Same seed, same order; another seed, another order over the same set.
    expect(probesFor(base, landed, { seed: 1, count: 100 })).toEqual(probes)
    const reseeded = probesFor(base, landed, { seed: 2, count: 100 })
    expect(reseeded.map((probe) => probe.path).sort()).toEqual(
      probes.map((probe) => probe.path).sort()
    )
    expect(reseeded).not.toEqual(probes)
    // `count` caps the sample, taking the first of the seeded order.
    expect(probesFor(base, landed, { seed: 1, count: 3 })).toEqual(probes.slice(0, 3))
  })
})

describe("gateHeads", () => {
  it("passes an unchanged corpus with equal numbers and no inversions", async () => {
    const records = await distinct()
    const report = gateHeads(mapView(records, "a"), mapView(records, "b"))
    expect(report).toMatchObject({
      mode: "head",
      passed: true,
      base: "a",
      landed: "b",
      probes: 10,
      mrr: 1,
      mrrBefore: 1,
      floor: 1 - HEAD_GATE_TOLERANCE,
      inversions: [],
      inversionsBefore: 0,
      added: 0,
      removed: 0
    })
    expect(
      report.results.every((result) => result.rankBefore === 1 && result.rankAfter === 1)
    ).toBe(true)
  })

  it("a landing whose new record pushes a probe out of the top k grows the inversions and fails", async () => {
    const records = await distinct()
    const target = records[0]
    if (target === undefined) throw new Error("fixture")
    // Same title, and "harbor" once more in its claim: it takes the lexical lead and rank 1 at
    // k = 1. Recency ranks only what the query matched, so it breaks ties and cannot win one.
    const twin = await record("areas/inbox/harbor2.html", {
      title: target.title,
      claim: "Harbor cranes unload in the harbor at dusk.",
      at: "2026-06-01T12:00:00Z"
    })
    const base = mapView(records, "base")
    const landed = mapView([...records, twin], "landed")
    // A tolerance of 1 puts the floor at 0, so only the inversion clause can refuse this landing.
    const report = gateHeads(base, landed, { k: 1, tolerance: 1 })
    expect(report.floor).toBe(0)
    expect(report.mrr).toBe(0.9)
    expect(report.passed).toBe(false)
    expect(report.inversionsBefore).toBe(0)
    expect(report.inversions).toEqual([
      { kind: "fell-out", path: target.path, query: probeQueryFor(target) }
    ])
    expect(report.added).toBe(1)
    const failure = new HeadGateFailed(report)
    expect(failure._tag).toBe("HeadGateFailed")
    expect(failure.reason).toContain("1 inversion(s) against 0 before")
    expect(failure.reason).toContain(`${target.path} fell out of the top 1`)
  })

  it("a superseded record outranking its superseder is an inversion; one ranked below is not", async () => {
    const records = await distinct()
    const target = records[0]
    if (target === undefined) throw new Error("fixture")
    // The older one says "harbor" in its title alone and ranks below the target on the lexical
    // arm; the newer one says it once more than the target and ranks above.
    const older = await record("areas/inbox/harbor2-old.html", {
      title: target.title,
      claim: "Cranes unload at noon.",
      at: "2025-01-01T12:00:00Z"
    })
    const newer = await record("areas/inbox/harbor2-new.html", {
      title: target.title,
      claim: "Harbor cranes unload in the harbor at midnight.",
      at: "2026-09-01T12:00:00Z"
    })
    const supersedingOlder = await record(target.path, {
      title: target.title,
      claim: target.claim,
      links: [{ rel: "supersedes", href: `/${older.path}` }]
    })
    const supersedingNewer = await record(target.path, {
      title: target.title,
      claim: target.claim,
      links: [{ rel: "supersedes", href: `/${newer.path}` }]
    })
    const base = mapView(records, "base")
    const rest = records.slice(1)
    // The superseded record ranks below the target: no inversion, and the gate passes.
    const below = gateHeads(base, mapView([...rest, supersedingOlder, older], "below"))
    expect(below.inversions).toEqual([])
    expect(below.passed).toBe(true)
    // The superseded record outranks the target: an inversion, and the gate fails.
    const above = gateHeads(base, mapView([...rest, supersedingNewer, newer], "above"))
    expect(above.inversions).toEqual([
      {
        kind: "superseded-outranks",
        path: target.path,
        query: probeQueryFor(target),
        by: newer.path,
        rank: 2,
        byRank: 1
      }
    ])
    expect(above.passed).toBe(false)
    expect(new HeadGateFailed(above).reason).toContain(
      `${newer.path} outranks ${target.path}, which supersedes it`
    )
  })

  it("an MRR drop within the tolerance passes and one past it fails", async () => {
    const records = await distinct()
    const target = records[0]
    if (target === undefined) throw new Error("fixture")
    const twin = await record("areas/inbox/harbor2.html", {
      title: target.title,
      claim: "Harbor cranes unload in the harbor at dusk.",
      at: "2026-06-01T12:00:00Z"
    })
    const base = mapView(records, "base")
    const landed = mapView([...records, twin], "landed")
    // Ten probes, one slips from rank 1 to rank 2: MRR 1 -> 0.95, still in the top 10.
    const within = gateHeads(base, landed, { tolerance: 0.06 })
    expect(within).toMatchObject({ mrrBefore: 1, mrr: 0.95, floor: 0.94, passed: true })
    expect(within.inversions).toEqual([])
    const past = gateHeads(base, landed, { tolerance: 0.02 })
    expect(past).toMatchObject({ mrrBefore: 1, mrr: 0.95, floor: 0.98, passed: false })
    expect(new HeadGateFailed(past).reason).toContain(
      "MRR 0.95 at landed is below the floor of 0.98"
    )
  })

  it("reports zero probes and passes when the two versions share no active record", async () => {
    const records = await distinct()
    const report = gateHeads(mapView([], "empty"), mapView(records, "full"))
    expect(report).toMatchObject({ passed: true, probes: 0, mrr: 0, mrrBefore: 0, added: 10 })
  })

  it("scores a probe absent from the top k as rank null", async () => {
    const records = await distinct()
    const view = mapView(records, "v")
    const scored = scoreProbes(view, [{ path: "areas/inbox/none.html", query: "zzz" }], 10)
    expect(scored.ranks).toEqual([null])
    expect(scored.mrr).toBe(0)
  })
})

describe("versionFromRecords", () => {
  it("agrees with the git-built version index for index, and advances sharing untouched records", async () => {
    const corpus = await makeCorpus(40)
    cleanups.push(() => corpus.repo.cleanup())
    const fromGit = await run(loadHead(corpus.repo.git, corpus.sha))
    const fromRecords = versionFromRecords(fromGit.records(), corpus.sha)
    expect(fromRecords.sha).toBe(corpus.sha)
    expect(fromRecords.size).toBe(fromGit.size)
    expect([...fromRecords.paths()].sort()).toEqual([...fromGit.paths()].sort())
    for (const item of fromGit.records()) {
      expect(fromRecords.byFrameKey(item.frameKey ?? "")).toEqual(
        fromGit.byFrameKey(item.frameKey ?? "")
      )
      expect(fromRecords.byContentHash(item.contentHash)).toBe(
        fromGit.byContentHash(item.contentHash)
      )
      for (const entity of item.entities) {
        expect(fromRecords.byEntity(entity)).toEqual(fromGit.byEntity(entity))
      }
    }
    expect(HashMap.size(fromRecords[INDEXES].lexical.postings)).toBe(
      HashMap.size(fromGit[INDEXES].lexical.postings)
    )
    expect(fromRecords.skipped).toBe(0)

    const edited = memoryFor(3)
    const next = await commitChanges(corpus.repo, [
      { path: edited.path, html: edited.html.replace("Country3", "Country3 renamed") }
    ])
    const advanced = await run(advanceHead(corpus.repo.git, fromRecords, next))
    expect(advanced.sha).toBe(next)
    expect(advanced.parent).toBe(fromRecords)
    for (const path of fromRecords.paths()) {
      if (path === edited.path) expect(advanced.get(path)).not.toBe(fromRecords.get(path))
      else expect(advanced.get(path)).toBe(fromRecords.get(path))
    }
  })
})
