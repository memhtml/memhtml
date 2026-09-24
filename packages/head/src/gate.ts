import { createHash } from "node:crypto"

import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { hrefToPath } from "@memhtml/contracts"

import { searchHead } from "./search.js"

/**
 * The head gate: does the version being landed still find what the base version found?
 *
 * The gate is stated over two versions of the same corpus, never over a fixture. Probes are a
 * seeded sample of the records active in BOTH versions, each queried by its own title (or the first
 * sentence of its claim when the title is blank), and `searchHead` is scored at the base and at the
 * landed version with the same probes, so the two numbers differ only by what the landing changed.
 * A record the landing adds is not probed: it has no rank at the base to compare against, and it
 * becomes a probe at the next landing, when it is part of the base. A record the landing archives
 * leaves the probe set for the same reason, and the probe of the record it was folded into is what
 * measures whether the fold helped.
 *
 * Two inversion kinds, both counted at both versions: a probe whose target is not in the top `k`
 * (`fell-out`), and a record the target supersedes (a `supersedes` link from the target) ranking
 * above the target (`superseded-outranks`). The gate passes when the landed MRR is at least the base
 * MRR minus `tolerance` and the inversion count did not grow. The tolerance exists because a landing
 * that archives a near-duplicate legitimately reshuffles BM25's document frequencies by a hair; a
 * drop past it is a landing that made the corpus harder to search.
 *
 * Everything here is deterministic and credential-free: the sample is fixed by `seed`, both arms of
 * `searchHead` are deterministic, and no embedder is involved.
 */

export const HEAD_GATE_PROBES = 200
export const HEAD_GATE_K = 10
export const HEAD_GATE_TOLERANCE = 0.02
export const HEAD_GATE_SEED = 1

export interface HeadGateOptions {
  /** How many probes to sample. Fewer when the comparable set is smaller. */
  readonly probes?: number | undefined
  /** The top-`k` a target must appear in. */
  readonly k?: number | undefined
  /** How far below the base MRR the landed MRR may sit and still pass. */
  readonly tolerance?: number | undefined
  readonly seed?: number | undefined
}

export interface HeadGateProbe {
  readonly path: string
  readonly query: string
}

export type HeadGateInversion =
  | {
      readonly kind: "fell-out"
      readonly path: string
      readonly query: string
    }
  | {
      readonly kind: "superseded-outranks"
      readonly path: string
      readonly query: string
      /** The superseded record that ranked above its superseder. */
      readonly by: string
      /** The target's rank, `null` when it was not in the top `k`. */
      readonly rank: number | null
      readonly byRank: number
    }

export interface HeadGateResult extends HeadGateProbe {
  readonly rankBefore: number | null
  readonly rankAfter: number | null
}

export interface HeadGateReport {
  readonly mode: "head"
  readonly passed: boolean
  readonly base: string | null
  readonly landed: string | null
  readonly probes: number
  readonly k: number
  readonly seed: number
  readonly tolerance: number
  /** Mean reciprocal rank of the probes at the landed version, four decimals; `0` with no probes. */
  readonly mrr: number
  /** The same probes at the base version. */
  readonly mrrBefore: number
  /** `mrrBefore - tolerance`, clamped at zero. The landed MRR must reach it. */
  readonly floor: number
  readonly inversions: ReadonlyArray<HeadGateInversion>
  readonly inversionsBefore: number
  /** Active records at the landed version that were not active at the base. */
  readonly added: number
  /** Active records at the base that are not active at the landed version. */
  readonly removed: number
  readonly results: ReadonlyArray<HeadGateResult>
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

const FIRST_SENTENCE = /^[\s\S]*?[.!?](?=\s|$)/

/** The query a record is probed by: its title, else the first sentence of its claim, else the claim. */
export const probeQueryFor = (record: MemoryRecord): string => {
  const title = record.title.trim()
  if (title !== "") return title
  const claim = record.claim.trim()
  const sentence = FIRST_SENTENCE.exec(claim)?.[0]?.trim()
  return sentence === undefined || sentence === "" ? claim : sentence
}

const activeRecords = (view: HeadView): ReadonlyArray<MemoryRecord> =>
  [...view.records()].filter((record) => !record.archived)

const isActiveAt = (view: HeadView, path: string): boolean => {
  const record = view.get(path)
  return record !== undefined && !record.archived
}

/**
 * The seeded order key of a path: the first eight hex digits of sha1 over `<seed>:<path>`. A
 * cryptographic digest rather than a string hash because a polynomial hash keeps the paths' order
 * under a changed prefix, and a seed that does not reorder the sample is not a seed.
 */
const orderKey = (seed: number, path: string): string =>
  createHash("sha1")
    .update(`${String(seed)}:${path}`)
    .digest("hex")
    .slice(0, 8)

/**
 * The probes: records active in both versions, ordered by a seeded digest of their path so the
 * sample is a fixed function of `(seed, paths)` and not of insertion order, the first `count` of them.
 */
export const probesFor = (
  base: HeadView,
  landed: HeadView,
  options: { readonly seed: number; readonly count: number }
): ReadonlyArray<HeadGateProbe> =>
  activeRecords(landed)
    .filter((record) => isActiveAt(base, record.path))
    .map((record) => ({
      path: record.path,
      query: probeQueryFor(record),
      order: orderKey(options.seed, record.path)
    }))
    .sort(
      (left, right) =>
        (left.order < right.order ? -1 : left.order > right.order ? 1 : 0) ||
        (left.path < right.path ? -1 : 1)
    )
    .slice(0, Math.max(0, options.count))
    .map(({ path, query }) => ({ path, query }))

interface Scored {
  readonly ranks: ReadonlyArray<number | null>
  readonly mrr: number
  readonly inversions: ReadonlyArray<HeadGateInversion>
}

const supersededBy = (view: HeadView, path: string): ReadonlyArray<string> => {
  const record = view.get(path)
  if (record === undefined) return []
  return record.links
    .filter((link) => link.rel === "supersedes")
    .map((link) => hrefToPath(link.href))
    .filter((target) => view.get(target) !== undefined)
}

/** Score every probe at one version. */
export const scoreProbes = (
  view: HeadView,
  probes: ReadonlyArray<HeadGateProbe>,
  k: number
): Scored => {
  const ranks: Array<number | null> = []
  const inversions: Array<HeadGateInversion> = []
  for (const probe of probes) {
    const hits = searchHead(view, { query: probe.query, limit: k })
    const rankOf = (path: string): number | null => {
      const index = hits.findIndex((hit) => hit.path === path)
      return index === -1 ? null : index + 1
    }
    const rank = rankOf(probe.path)
    ranks.push(rank)
    if (rank === null) inversions.push({ kind: "fell-out", ...probe })
    for (const by of supersededBy(view, probe.path)) {
      const byRank = rankOf(by)
      if (byRank !== null && (rank === null || byRank < rank)) {
        inversions.push({ kind: "superseded-outranks", ...probe, by, rank, byRank })
      }
    }
  }
  const reciprocal = ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0)
  const mrr = ranks.length === 0 ? 0 : round4(reciprocal / ranks.length)
  return { ranks, mrr, inversions }
}

/** Run the gate over two versions. Pure; never throws for any pair of views. */
export const gateHeads = (
  base: HeadView,
  landed: HeadView,
  options: HeadGateOptions = {}
): HeadGateReport => {
  const k = options.k ?? HEAD_GATE_K
  const seed = options.seed ?? HEAD_GATE_SEED
  const tolerance = options.tolerance ?? HEAD_GATE_TOLERANCE
  const probes = probesFor(base, landed, { seed, count: options.probes ?? HEAD_GATE_PROBES })
  const before = scoreProbes(base, probes, k)
  const after = scoreProbes(landed, probes, k)
  const floor = round4(Math.max(0, before.mrr - tolerance))
  const baseActive = activeRecords(base)
  const landedActive = activeRecords(landed)
  return {
    mode: "head",
    passed: after.mrr >= floor && after.inversions.length <= before.inversions.length,
    base: base.sha,
    landed: landed.sha,
    probes: probes.length,
    k,
    seed,
    tolerance,
    mrr: after.mrr,
    mrrBefore: before.mrr,
    floor,
    inversions: after.inversions,
    inversionsBefore: before.inversions.length,
    added: landedActive.filter((record) => !isActiveAt(base, record.path)).length,
    removed: baseActive.filter((record) => !isActiveAt(landed, record.path)).length,
    results: probes.map((probe, index) => ({
      ...probe,
      rankBefore: before.ranks[index] ?? null,
      rankAfter: after.ranks[index] ?? null
    }))
  }
}

/** The one-line account of a failed report, in the same shape the eval gate's failure reads. */
export const describeHeadGateFailure = (report: HeadGateReport): string => {
  const parts: Array<string> = []
  if (report.mrr < report.floor) {
    parts.push(
      `MRR ${String(report.mrr)} at ${report.landed ?? "the landed version"} is below the floor of ${String(report.floor)} (${String(report.mrrBefore)} at ${report.base ?? "the base"} minus ${String(report.tolerance)})`
    )
  }
  if (report.inversions.length > report.inversionsBefore) {
    parts.push(
      `${String(report.inversions.length)} inversion(s) against ${String(report.inversionsBefore)} before: ${report.inversions
        .slice(0, 5)
        .map((inversion) =>
          inversion.kind === "fell-out"
            ? `${inversion.path} fell out of the top ${String(report.k)}`
            : `${inversion.by} outranks ${inversion.path}, which supersedes it`
        )
        .join("; ")}`
    )
  }
  return `head gate over ${String(report.probes)} probe(s): ${parts.join("; ") || "passed"}`
}

/**
 * A failed head gate, as a tagged error the CLI maps to `ERR_DISCRIMINATION_FAILED`, the code every
 * refused landing carries. The whole report rides along, because a refusal an operator cannot read
 * is a refusal they override.
 */
export class HeadGateFailed {
  readonly _tag = "HeadGateFailed"
  constructor(readonly report: HeadGateReport) {}
  get reason(): string {
    return describeHeadGateFailure(this.report)
  }
}
