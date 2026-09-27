import { readFile } from "node:fs/promises"

import type { HeadView, OverlayOp } from "@memhtml/contracts"
import {
  type DirtyTree,
  InvalidMemory,
  type ModelUnavailable,
  StorageFailure
} from "@memhtml/contracts/errors"
import {
  ARCHIVE_CHUNK,
  COLLAPSE_CHARTER,
  type CollapseCluster,
  type CollapsePlan,
  type CuratorModelSpecInvalid,
  type CuratorRunInput,
  curatorModel,
  FOLD_FIRST_SESSION_MEMBERS,
  parseRulings,
  planCollapse,
  type Ruling,
  renderCollapseBriefing,
  runCurator,
  type StoppedBy
} from "@memhtml/curator"
import { advanceHead, type HeadVersion, recordFrom } from "@memhtml/head"
import {
  appendOps,
  BATCH_CAP,
  type Session,
  startSession,
  type Violation,
  validateOps
} from "@memhtml/session"
import { type GitFailure, makeGit } from "@memhtml/store"
import { Effect } from "effect"

import {
  bindTools,
  CURATE_SCOPE,
  curateRefProblem,
  headRefOf,
  land,
  type OpsByKind,
  sessionOverlay
} from "./curate-run.js"
import {
  type HeadSource,
  loadVersion,
  type SnapshotWritten,
  snapshotAfterCommit
} from "./head-cache.js"
import { type HeadStats, headStats, type LoadedHead, qualifyRef, revParse } from "./v2.js"

/**
 * `memhtml curate collapse`: the 2026-09-24 collapse as a command (`docs/v2-poc.md`, "Collapse").
 *
 * The planner (`@memhtml/curator` `planCollapse`) cuts the head at the curator ref's tip into
 * archive, fold, and keep clusters with no model call; this module executes the first two kinds on
 * the one `--ref` and reports the third. Everything lands through validated sessions under the
 * `curate` scope and the same rebase-and-retry the other curator arms use, so concurrent clusters
 * serialize at the ref rather than overwrite each other, and `curate merge` stays the only door to
 * `main`.
 *
 * ## Archive clusters
 *
 * No model. Members are archived in chunks of {@link ARCHIVE_CHUNK}, one session per chunk, each
 * validated against the tip the chunk starts from; a member already archived or whose destination
 * exists is skipped and named.
 *
 * ## Fold clusters
 *
 * One curator session each under the collapse charter, briefed by code with the members' paths,
 * claims, excerpts, rulings, and one member's whole HTML. The model writes the canonical `put`; the
 * driver then completes what the model left: an `archive` for every member still active and a
 * `supersedes` link the canonical lacks for each, inside the same session while `BATCH_CAP` allows
 * and in follow-up sessions after, so every member ends archived and reached from the canonical.
 * Over `largeGroup` members the briefing tells the model to write the put alone and the driver does
 * all of the bookkeeping, which is the rule that let the 77-member fold land in 81 seconds after the
 * first pass had truncated every proposal.
 *
 * ## The head is held once
 *
 * Every session and every rebase needs the tip's view, and a store of eight thousand files takes
 * thirty seconds to load from git. The first load goes through the snapshot cache (`head-cache.ts`
 * `loadVersion`: the tip's own snapshot, else an ancestor's advanced, else git); after it one
 * `HeadVersion` is held for the run and advanced by delta (`advanceHead`) to each new tip, behind
 * one in-flight promise so concurrent clusters share a load instead of racing for it. After the
 * last landing the ref's tip is snapshotted (`snapshotAfterCommit`, best-effort) so the next
 * command that reads it, `curate merge` first of all, starts from the cache.
 */

/** The budget one fold runs under: the measured 2026-09-24 settings. */
export const FOLD_BUDGET = { maxSteps: 14, wallClockMs: 15 * 60_000, maxOps: BATCH_CAP }

export const DEFAULT_CONCURRENCY = 4

/** `curate/<UTC date>-collapse`, beside `curate run`'s `curate/<UTC date>` so the two never share a session id. */
export const defaultCollapseRef = (now: Date): string =>
  `curate/${now.toISOString().slice(0, 10)}-collapse`

export interface CurateCollapseInput {
  readonly root: string
  readonly ref?: string | undefined
  /** The model spec, already resolved by `run.ts`. */
  readonly model: string
  /** A saved plan to execute in place of computing one. */
  readonly plan?: CollapsePlan | undefined
  readonly rulings?: ReadonlyArray<Ruling> | undefined
  readonly concurrency?: number | undefined
  /** Cluster ids to execute; every other cluster is reported and left alone. */
  readonly only?: ReadonlyArray<string> | undefined
  /** Execute the first `limit` executable clusters in plan order. */
  readonly limit?: number | undefined
  readonly dryRun: boolean
  readonly maxSteps?: number | undefined
  readonly wallClockMs?: number | undefined
  readonly now?: (() => Date) | undefined
}

export type ClusterOutcomeKind =
  | "committed"
  | "dry-run"
  | "skipped"
  | "refused"
  | "modelError"
  | "failed"

export interface ClusterOutcome {
  readonly id: string
  readonly kind: CollapseCluster["kind"]
  readonly members: number
  readonly outcome: ClusterOutcomeKind
  /** Every commit this cluster landed, in order; several for a chunked archive or a large fold. */
  readonly commits: ReadonlyArray<string>
  /** The canonical the fold wrote, or `null` for an archive cluster or a fold that wrote none. */
  readonly canonical: string | null
  /**
   * Every op the cluster landed by kind; `unlink`, `label`, and `unlabel` count what the model did,
   * because the driver only archives and links.
   */
  readonly ops: OpsByKind
  /** Archives and links the driver added beside the model's own. */
  readonly driver: { readonly archive: number; readonly link: number }
  readonly steps: number
  readonly tokens: { readonly input: number; readonly output: number }
  readonly stoppedBy: StoppedBy | null
  readonly rebases: number
  readonly skipped: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly error: string | null
  readonly ms: number
}

export interface CurateCollapseReport {
  readonly ref: string
  /** The tip the plan was computed over and the first session started from. */
  readonly base: string
  readonly model: string
  readonly dryRun: boolean
  readonly planSource: "computed" | "file"
  readonly planMs: number
  /** True when a loaded plan names another sha than the base; members are re-checked per cluster. */
  readonly planShaMismatch: boolean
  readonly totals: CollapsePlan["totals"]
  /** The whole plan on a dry run, so it can be saved and replayed with `--plan`; `null` otherwise. */
  readonly plan: CollapsePlan | null
  /** Executed (or previewed) clusters, in plan order. */
  readonly clusters: ReadonlyArray<ClusterOutcome>
  /** Clusters the plan holds and this run did not execute: keep clusters, and those `--only`/`--limit` left out. */
  readonly untouched: ReadonlyArray<{
    readonly id: string
    readonly kind: CollapseCluster["kind"]
    readonly members: number
    readonly rationale: string
  }>
  readonly summary: {
    readonly committed: number
    readonly failed: number
    readonly archived: number
    readonly canonicals: number
    readonly commits: number
  }
  readonly head: HeadStats
  /** The ref's commit after the run, or `null` when nothing landed and the ref is unborn. */
  readonly tip: string | null
  /** The cache write for `tip` after a run that moved the ref; `null` on a dry run, when nothing landed, or when the write failed. */
  readonly snapshot: SnapshotWritten | null
  readonly next: string
}

const opsByKind = (ops: ReadonlyArray<OverlayOp>): OpsByKind => ({
  put: ops.filter((op) => op.kind === "put").length,
  archive: ops.filter((op) => op.kind === "archive").length,
  link: ops.filter((op) => op.kind === "link").length,
  unlink: ops.filter((op) => op.kind === "unlink").length,
  label: ops.filter((op) => op.kind === "label").length,
  unlabel: ops.filter((op) => op.kind === "unlabel").length
})

const NO_OPS: OpsByKind = { put: 0, archive: 0, link: 0, unlink: 0, label: 0, unlabel: 0 }

const describeViolation = (violation: Violation): string => {
  switch (violation.kind) {
    case "format":
      return `${violation.path}: ${violation.reasons.join("; ")}`
    case "reserved-path":
      return `${violation.path}: reserved path`
    case "batch-cap":
      return `${violation.count} ops exceeds the cap of ${violation.cap}`
    case "duplicate":
      return `${violation.path}: duplicate of ${violation.existing}`
    case "claim-edit":
      return `${violation.path}: claim edit`
    case "write-bar":
      return `${violation.path}: below the write bar: ${violation.reasons.join("; ")}`
  }
}

const describeError = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<string, unknown>
    const parts = [record._tag, record.reason, record.operation, record.message]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .map(String)
    if (parts.length > 0) return parts.join(": ")
  }
  return String(cause)
}

/** The session id for a cluster's session, one path segment of letters, digits, `.`, `_`, `-`. */
export const collapseSessionId = (clusterId: string, suffix = ""): string =>
  `collapse-${clusterId}${suffix}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 128)

const archivePathFor = (path: string, year: string): string => `archive/${year}/${path}`

const isActive = (view: HeadView, path: string): boolean => {
  const record = view.get(path)
  return record !== undefined && !record.archived
}

/** The `supersedes` hrefs a record carries. */
const supersedesOf = (view: HeadView, path: string): ReadonlySet<string> =>
  new Set(
    (view.get(path)?.links ?? [])
      .filter((link) => link.rel === "supersedes")
      .map((link) => link.href)
  )

/** One held head version for the run, advanced by delta to each tip a cluster needs. */
export interface HeadCache {
  readonly at: (sha: string) => Effect.Effect<LoadedHead, GitFailure | InvalidMemory>
}

/**
 * The first load takes the cheapest path `loadVersion` finds (the same one `loadHeadAt` takes), so
 * a tip with a snapshot costs a file read rather than the git walk; every later tip is the held
 * version advanced by delta, reported as `snapshot+advance` from the sha it was advanced from when
 * the first load came from a snapshot, and as `git` otherwise. `skipped` is known only for a git
 * load, as in `loadHeadAt`. The shape is the one `loadHeadAt` returns, so a payload built from
 * either reads the same.
 */
export const makeHeadCache = (root: string): HeadCache => {
  interface Held {
    readonly version: HeadVersion
    readonly source: HeadSource
    readonly snapshotPath: string | null
    readonly ancestorSha: string | null
    readonly reparsed: number | null
  }
  let held: Held | null = null
  let inflight: Promise<Held> | null = null
  const git = makeGit(root)
  const asLoaded = (current: Held, loadMs: number): LoadedHead => ({
    view: current.version,
    sha: current.version.sha,
    records: current.version.size,
    skipped: current.source === "git" ? current.version.skipped : null,
    loadMs,
    source: current.source,
    snapshotPath: current.snapshotPath,
    ancestorSha: current.ancestorSha,
    reparsed: current.reparsed
  })
  const load = (sha: string): Promise<Held> => {
    const previous = held
    const next: Effect.Effect<Held, GitFailure | InvalidMemory | StorageFailure> =
      previous === null
        ? loadVersion(root, sha).pipe(
            Effect.map((loaded) => ({
              version: loaded.version,
              source: loaded.source,
              snapshotPath: loaded.snapshotPath,
              ancestorSha: loaded.ancestorSha,
              reparsed: loaded.reparsed
            }))
          )
        : advanceHead(git, previous.version, sha).pipe(
            Effect.map((version) => ({
              version,
              source: previous.source === "git" ? "git" : "snapshot+advance",
              snapshotPath: previous.snapshotPath,
              ancestorSha: previous.source === "git" ? null : previous.version.sha,
              reparsed: null
            }))
          )
    return Effect.runPromise(next).then((current) => {
      held = current
      return current
    })
  }
  return {
    at: (sha) =>
      Effect.tryPromise({
        try: async () => {
          const started = Date.now()
          for (;;) {
            if (held !== null && held.version.sha === sha) return asLoaded(held, 0)
            if (inflight === null) break
            await inflight.catch(() => undefined)
          }
          inflight = load(sha)
          try {
            return asLoaded(await inflight, Date.now() - started)
          } finally {
            inflight = null
          }
        },
        catch: (cause) =>
          InvalidMemory.make({ reason: `curate collapse: loading ${sha}: ${describeError(cause)}` })
      })
  }
}

/** The ref's tip, else `main`'s, else `HEAD`: the version a new cluster session sees. */
const tipOf = (root: string, ref: string): Effect.Effect<string, GitFailure | InvalidMemory> =>
  Effect.gen(function* () {
    const sha =
      (yield* revParse(root, ref)) ??
      (yield* revParse(root, "refs/heads/main")) ??
      (yield* makeGit(root).revParseHead())
    if (sha === null) {
      return yield* Effect.fail(
        InvalidMemory.make({ reason: `${root} has no commit: a collapse needs a version to see` })
      )
    }
    return sha
  })

interface Driver {
  readonly root: string
  readonly ref: string
  readonly plan: CollapsePlan
  readonly heads: HeadCache
  readonly now: () => Date
}

const emptyOutcome = (
  cluster: CollapseCluster,
  outcome: ClusterOutcomeKind,
  started: number
): ClusterOutcome => ({
  id: cluster.id,
  kind: cluster.kind,
  members: cluster.members.length,
  outcome,
  commits: [],
  canonical: null,
  ops: NO_OPS,
  driver: { archive: 0, link: 0 },
  steps: 0,
  tokens: { input: 0, output: 0 },
  stoppedBy: null,
  rebases: 0,
  skipped: [],
  warnings: [],
  error: null,
  ms: Date.now() - started
})

/** Members a cluster may archive: every member not ruled `keep`. */
const archivable = (cluster: CollapseCluster): ReadonlyArray<string> =>
  cluster.members.filter((member) => member.ruling?.verdict !== "keep").map((member) => member.path)

/** Open a session on the tip, append `ops`, and land it. One commit, or the failure. */
const landOps = (
  driver: Driver,
  id: string,
  loaded: LoadedHead,
  ops: ReadonlyArray<OverlayOp>,
  message: string
): Effect.Effect<
  { readonly sha: string; readonly rebases: number },
  GitFailure | StorageFailure | InvalidMemory | DirtyTree
> =>
  Effect.gen(function* () {
    let session: Session = yield* startSession({
      root: driver.root,
      id,
      base: loaded.view,
      ref: driver.ref,
      force: true
    })
    session = yield* appendOps(session, ops)
    return yield* land({
      root: driver.root,
      session,
      head: loaded,
      message,
      reload: driver.heads.at
    })
  })

/**
 * An archive cluster: chunks of {@link ARCHIVE_CHUNK}, each judged against the tip it starts from.
 * A chunk with a violation is reported and skipped rather than failing the cluster, because the
 * next chunk is independent of it.
 */
const archiveCluster = (driver: Driver, cluster: CollapseCluster): Effect.Effect<ClusterOutcome> =>
  Effect.gen(function* () {
    const started = Date.now()
    const paths = archivable(cluster)
    const commits: Array<string> = []
    const skipped: Array<string> = []
    const warnings: Array<string> = []
    let archived = 0
    let rebases = 0
    let error: string | null = null
    for (let at = 0, chunk = 1; at < paths.length; at += ARCHIVE_CHUNK, chunk += 1) {
      const slice = paths.slice(at, at + ARCHIVE_CHUNK)
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const loaded = yield* driver.heads.at(yield* tipOf(driver.root, driver.ref))
          const ops: Array<OverlayOp> = []
          for (const path of slice) {
            const record = loaded.view.get(path)
            const to = archivePathFor(path, driver.plan.archiveYear)
            if (record === undefined || record.archived || loaded.view.get(to) !== undefined) {
              skipped.push(path)
              continue
            }
            ops.push({ kind: "archive", path, to, html: record.html })
          }
          if (ops.length === 0) return
          const violations = validateOps(loaded.view, ops, { scope: CURATE_SCOPE })
          if (violations.length > 0) {
            warnings.push(
              `chunk ${String(chunk)} refused: ${violations.slice(0, 5).map(describeViolation).join(" | ")}`
            )
            skipped.push(...ops.map((op) => op.path))
            return
          }
          const landed = yield* landOps(
            driver,
            collapseSessionId(cluster.id, `-${String(chunk)}`),
            loaded,
            ops,
            `archive ${String(ops.length)} records: ${cluster.id}`
          )
          commits.push(landed.sha)
          rebases += landed.rebases
          archived += ops.length
        })
      )
      if (result._tag === "Failure") {
        error = describeError(result.failure)
        break
      }
    }
    return {
      ...emptyOutcome(cluster, "committed", started),
      outcome: error !== null ? "failed" : commits.length === 0 ? "skipped" : "committed",
      commits,
      ops: { ...NO_OPS, archive: archived },
      driver: { archive: archived, link: 0 },
      rebases,
      skipped,
      warnings,
      error,
      ms: Date.now() - started
    }
  })

/** The `supersedes` hrefs a put's own bytes carry, or none when the bytes do not parse. */
const supersedesInPut = (put: OverlayOp): Effect.Effect<ReadonlySet<string>> =>
  put.kind !== "put"
    ? Effect.succeed(new Set())
    : recordFrom({ path: put.path, html: put.html }).pipe(
        Effect.map(
          (record) =>
            new Set(
              record.links.filter((link) => link.rel === "supersedes").map((link) => link.href)
            )
        ),
        Effect.catch(() => Effect.succeed(new Set<string>()))
      )

/**
 * Archive-plus-link sessions for the members a fold still owes after its model session landed: the
 * rest of a large cluster, and whatever `BATCH_CAP` pushed out of the first session. Each member
 * costs an archive and a link; a member already archived costs the link alone.
 */
const followUp = (
  driver: Driver,
  cluster: CollapseCluster,
  canonical: string,
  owed: ReadonlyArray<string>,
  results: {
    commits: Array<string>
    driver: { archive: number; link: number }
    skipped: Array<string>
    rebases: number
  }
): Effect.Effect<void, GitFailure | StorageFailure | InvalidMemory | DirtyTree> =>
  Effect.gen(function* () {
    const work = [...owed]
    let round = 0
    while (work.length > 0) {
      round += 1
      const loaded = yield* driver.heads.at(yield* tipOf(driver.root, driver.ref))
      const view = loaded.view
      if (!isActive(view, canonical)) {
        return yield* Effect.fail(
          InvalidMemory.make({
            reason: `curate collapse: canonical ${canonical} is not active at ${loaded.sha}`
          })
        )
      }
      const linked = supersedesOf(view, canonical)
      const ops: Array<OverlayOp> = []
      while (work.length > 0 && ops.length + 2 <= BATCH_CAP) {
        const path = work.shift() as string
        const to = archivePathFor(path, driver.plan.archiveYear)
        const record = view.get(path)
        const destinationExists = view.get(to) !== undefined
        if (record !== undefined && !record.archived && !destinationExists) {
          ops.push({ kind: "archive", path, to, html: record.html })
        } else if (record !== undefined && !record.archived) {
          // Still active, but its destination is taken: an earlier archive of the same bytes.
          results.skipped.push(path)
        }
        // The link needs a target: the archive this batch writes, or one already in the tree.
        const targetWillExist =
          destinationExists || ops.some((op) => op.kind === "archive" && op.path === path)
        const href = `/${to}`
        if (targetWillExist && !linked.has(href)) {
          ops.push({ kind: "link", path: canonical, rel: "supersedes", href })
        }
      }
      if (ops.length === 0) continue
      const violations = validateOps(view, ops, { scope: CURATE_SCOPE })
      if (violations.length > 0) {
        return yield* Effect.fail(
          InvalidMemory.make({
            reason: `curate collapse: follow-up ${String(round)} of ${cluster.id} refused: ${violations.slice(0, 10).map(describeViolation).join(" | ")}`
          })
        )
      }
      const landed = yield* landOps(
        driver,
        collapseSessionId(cluster.id, `-more-${String(round)}`),
        loaded,
        ops,
        `fold ${cluster.id}: archive ${String(ops.filter((op) => op.kind === "archive").length)} more members behind ${canonical}`
      )
      results.commits.push(landed.sha)
      results.rebases += landed.rebases
      results.driver.archive += ops.filter((op) => op.kind === "archive").length
      results.driver.link += ops.filter((op) => op.kind === "link").length
    }
  })

/** One fold: brief, run the model, complete the bookkeeping, land, follow up. Never throws: the outcome says. */
const foldCluster = (
  driver: Driver,
  cluster: CollapseCluster,
  model: CuratorRunInput["model"],
  charter: string,
  budget: { readonly maxSteps: number; readonly wallClockMs: number; readonly maxOps: number }
): Effect.Effect<ClusterOutcome> =>
  Effect.gen(function* () {
    const started = Date.now()
    const base = emptyOutcome(cluster, "committed", started)
    /** What the follow-up sessions add; the first session's own completion is counted beside it. */
    const results = {
      commits: [] as Array<string>,
      driver: { archive: 0, link: 0 },
      skipped: [] as Array<string>,
      warnings: [] as Array<string>,
      rebases: 0
    }
    let completed = { archive: 0, link: 0 }
    const attempt = Effect.gen(function* () {
      const loaded = yield* driver.heads.at(yield* tipOf(driver.root, driver.ref))
      const view = loaded.view
      const active = archivable(cluster).filter((path) => isActive(view, path))
      results.skipped.push(...archivable(cluster).filter((path) => !isActive(view, path)))
      const context = cluster.members
        .filter((member) => member.ruling?.verdict === "keep" && isActive(view, member.path))
        .map((member) => member.path)
      if (active.length === 0) {
        return {
          ...base,
          outcome: "skipped" as const,
          skipped: results.skipped,
          error: "no active members at the ref tip"
        }
      }
      const first =
        active.length > ARCHIVE_CHUNK ? active.slice(0, FOLD_FIRST_SESSION_MEMBERS) : active
      const rest = active.slice(first.length)
      const driverCompletes = first.length > driver.plan.options.largeGroup
      const briefing = renderCollapseBriefing({
        plan: driver.plan,
        cluster,
        members: [...first, ...context],
        view,
        now: driver.now(),
        driverCompletes
      })
      const session = yield* startSession({
        root: driver.root,
        id: collapseSessionId(cluster.id),
        base: view,
        ref: driver.ref,
        force: true
      })
      const overlay = sessionOverlay(session)
      const tools = bindTools({ head: loaded, overlay, ref: driver.ref })
      const run = yield* runCurator({ tools, model, briefing, charter, budget, now: driver.now })
      const spent = {
        steps: run.steps,
        tokens: { input: run.inputTokens, output: run.outputTokens },
        stoppedBy: run.stoppedBy
      }
      if (run.stoppedBy === "modelError") {
        return { ...base, ...spent, outcome: "modelError" as const, error: run.error }
      }
      const ops = [...overlay.ops()]
      const puts = ops.filter((op) => op.kind === "put")
      const put = puts[0]
      if (put === undefined || put.kind !== "put") {
        return {
          ...base,
          ...spent,
          outcome: "refused" as const,
          ops: opsByKind(ops),
          error: `the session ended without a canonical put (${run.stoppedBy}): ${run.report.split("\n")[0] ?? ""}`
        }
      }
      const canonical = put.path
      if (!canonical.startsWith(`${cluster.home}/`)) {
        results.warnings.push(`${canonical} is outside home ${cluster.home}/`)
      }
      if (puts.length > 2) results.warnings.push(`${String(puts.length)} puts (expected 1 or 2)`)
      const archivedByModel = new Set(ops.flatMap((op) => (op.kind === "archive" ? [op.path] : [])))
      const foreign = [...archivedByModel].filter((path) => !active.includes(path))
      if (foreign.length > 0) {
        results.warnings.push(`the model archived non-members: ${foreign.slice(0, 5).join(", ")}`)
      }
      const linkedByPut = new Set<string>()
      for (const one of puts) for (const href of yield* supersedesInPut(one)) linkedByPut.add(href)
      for (const op of ops)
        if (op.kind === "link" && op.rel === "supersedes") linkedByPut.add(op.href)

      // Completion inside the same session while the cap allows: archives the model left, then the
      // supersedes links the canonical lacks. A link on a put path in the same batch is valid.
      const completion: Array<OverlayOp> = []
      for (const path of first) {
        if (archivedByModel.has(path)) continue
        if (ops.length + completion.length >= BATCH_CAP) break
        const record = view.get(path)
        if (
          record === undefined ||
          view.get(archivePathFor(path, driver.plan.archiveYear)) !== undefined
        )
          continue
        completion.push({
          kind: "archive",
          path,
          to: archivePathFor(path, driver.plan.archiveYear),
          html: record.html
        })
      }
      const willArchive = new Set([...archivedByModel, ...completion.map((op) => op.path)])
      const links: Array<OverlayOp> = []
      for (const path of first) {
        if (!willArchive.has(path)) continue
        const href = `/${archivePathFor(path, driver.plan.archiveYear)}`
        if (linkedByPut.has(href)) continue
        if (ops.length + completion.length + links.length >= BATCH_CAP) break
        links.push({ kind: "link", path: canonical, rel: "supersedes", href })
      }
      let extra = [...completion, ...links]
      if (extra.length > 0) {
        const violations = validateOps(view, [...ops, ...extra], { scope: CURATE_SCOPE })
        if (violations.length > 0) {
          results.warnings.push(
            `driver completion refused, landing the model's ops alone: ${violations.slice(0, 5).map(describeViolation).join(" | ")}`
          )
          extra = []
        } else {
          yield* overlay.append(extra)
          completed = { archive: completion.length, link: links.length }
        }
      }
      const finalOps = overlay.ops()
      const violations = validateOps(view, finalOps, { scope: CURATE_SCOPE })
      if (violations.length > 0) {
        return {
          ...base,
          ...spent,
          outcome: "refused" as const,
          canonical,
          ops: opsByKind(finalOps),
          warnings: results.warnings,
          error: `refused before commit, the log stays in session ${collapseSessionId(cluster.id)}: ${violations.slice(0, 10).map(describeViolation).join(" | ")}`
        }
      }
      const current = overlay.session()
      if (current === null) throw new Error("a session overlay has a session")
      const landed = yield* land({
        root: driver.root,
        session: current,
        head: loaded,
        message: `fold ${cluster.id} into ${canonical} (${String(finalOps.filter((op) => op.kind === "archive").length)} archived)`,
        reload: driver.heads.at
      })
      results.commits.push(landed.sha)
      results.rebases += landed.rebases

      // Whatever the first session did not settle: the rest of a large cluster, the members the cap
      // pushed out, and any archived member the canonical does not yet point at.
      const landedArchives = new Set(
        finalOps.flatMap((op) => (op.kind === "archive" ? [op.path] : []))
      )
      const landedLinks = new Set([
        ...linkedByPut,
        ...finalOps.flatMap((op) => (op.kind === "link" ? [op.href] : []))
      ])
      const owed = active.filter(
        (path) =>
          !landedArchives.has(path) ||
          !landedLinks.has(`/${archivePathFor(path, driver.plan.archiveYear)}`)
      )
      const owedAll = [...new Set([...rest, ...owed])]
      if (owedAll.length > 0) yield* followUp(driver, cluster, canonical, owedAll, results)
      return {
        ...base,
        ...spent,
        outcome: "committed" as const,
        commits: results.commits,
        canonical,
        ops: {
          put: puts.length,
          archive: finalOps.filter((op) => op.kind === "archive").length + results.driver.archive,
          link: finalOps.filter((op) => op.kind === "link").length + results.driver.link,
          unlink: finalOps.filter((op) => op.kind === "unlink").length,
          label: finalOps.filter((op) => op.kind === "label").length,
          unlabel: finalOps.filter((op) => op.kind === "unlabel").length
        },
        driver: {
          archive: completed.archive + results.driver.archive,
          link: completed.link + results.driver.link
        },
        rebases: results.rebases,
        skipped: results.skipped,
        warnings: results.warnings
      }
    })
    const result = yield* Effect.result(attempt)
    const outcome: ClusterOutcome =
      result._tag === "Success"
        ? result.success
        : {
            ...base,
            outcome: results.commits.length > 0 ? "committed" : "failed",
            commits: results.commits,
            driver: {
              archive: completed.archive + results.driver.archive,
              link: completed.link + results.driver.link
            },
            skipped: results.skipped,
            warnings: results.warnings,
            error: describeError(result.failure)
          }
    return { ...outcome, ms: Date.now() - started }
  })

const readPlan = (plan: unknown): CollapsePlan => {
  if (
    typeof plan !== "object" ||
    plan === null ||
    !Array.isArray((plan as { clusters?: unknown }).clusters)
  ) {
    throw new Error(
      "a plan is an object with a clusters array, as curate collapse --dry-run prints it"
    )
  }
  return plan as CollapsePlan
}

/** Read a saved plan or a rulings file for `run.ts`, as a storage failure when the file is unusable. */
export const readPlanFile = (path: string): Effect.Effect<CollapsePlan, StorageFailure> =>
  Effect.tryPromise({
    try: async () => readPlan(JSON.parse(await readFile(path, "utf8"))),
    catch: (cause) =>
      StorageFailure.make({ operation: `curate collapse --plan ${path}: ${describeError(cause)}` })
  })

export const readRulingsFile = (
  path: string
): Effect.Effect<ReadonlyArray<Ruling>, StorageFailure> =>
  Effect.tryPromise({
    try: async () => parseRulings(await readFile(path, "utf8")),
    catch: (cause) =>
      StorageFailure.make({
        operation: `curate collapse --rulings ${path}: ${describeError(cause)}`
      })
  })

export const curateCollapse = (
  input: CurateCollapseInput
): Effect.Effect<
  CurateCollapseReport,
  | GitFailure
  | StorageFailure
  | InvalidMemory
  | DirtyTree
  | ModelUnavailable
  | CuratorModelSpecInvalid
> =>
  Effect.gen(function* () {
    const now = input.now ?? (() => new Date())
    const ref = qualifyRef(
      input.ref === undefined || input.ref.trim() === "" ? defaultCollapseRef(now()) : input.ref
    )
    const problem = curateRefProblem(ref)
    if (problem !== undefined) {
      return yield* Effect.fail(InvalidMemory.make({ reason: `curate collapse --ref: ${problem}` }))
    }
    if ((yield* headRefOf(input.root)) === ref) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate collapse --ref: ${ref} is checked out (HEAD names it), so a commit there would move the working tree; the collapse writes only to a branch nobody has checked out`
        })
      )
    }
    const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      return yield* Effect.fail(
        InvalidMemory.make({ reason: "curate collapse --concurrency must be a positive integer" })
      )
    }
    const model = yield* curatorModel(input.model)
    const charter = yield* COLLAPSE_CHARTER

    const heads = makeHeadCache(input.root)
    const base = yield* tipOf(input.root, ref)
    const loaded = yield* heads.at(base)
    const planStarted = Date.now()
    const plan = input.plan ?? planCollapse(loaded.view, { rulings: input.rulings, now: now() })
    const planMs = input.plan === undefined ? Date.now() - planStarted : 0

    const executable = plan.clusters.filter((cluster) => cluster.kind !== "keep")
    let selected = executable
    if (input.only !== undefined && input.only.length > 0) {
      const wanted = new Set(input.only)
      selected = selected.filter((cluster) => wanted.has(cluster.id))
      if (selected.length === 0) {
        return yield* Effect.fail(
          InvalidMemory.make({
            reason: `curate collapse --only: none of ${input.only.join(", ")} names an archive or fold cluster in the plan`
          })
        )
      }
    }
    if (input.limit !== undefined) selected = selected.slice(0, Math.max(0, input.limit))
    const selectedIds = new Set(selected.map((cluster) => cluster.id))
    const untouched = plan.clusters
      .filter((cluster) => !selectedIds.has(cluster.id))
      .map((cluster) => ({
        id: cluster.id,
        kind: cluster.kind,
        members: cluster.members.length,
        rationale: cluster.rationale
      }))

    const driver: Driver = { root: input.root, ref, plan, heads, now }
    let clusters: ReadonlyArray<ClusterOutcome>
    if (input.dryRun) {
      clusters = selected.map((cluster) => emptyOutcome(cluster, "dry-run", Date.now()))
    } else {
      const budget = {
        maxSteps: input.maxSteps ?? FOLD_BUDGET.maxSteps,
        wallClockMs: input.wallClockMs ?? FOLD_BUDGET.wallClockMs,
        maxOps: FOLD_BUDGET.maxOps
      }
      // Archives first and one at a time: bulk, cheap, and they shrink what the folds see. Then the
      // folds through a bounded pool; each lands on the one ref through the rebase-and-retry loop.
      const archives = yield* Effect.all(
        selected
          .filter((cluster) => cluster.kind === "archive")
          .map((c) => archiveCluster(driver, c))
      )
      const folds = yield* Effect.all(
        selected
          .filter((cluster) => cluster.kind === "fold")
          .map((c) => foldCluster(driver, c, model, charter, budget)),
        { concurrency }
      )
      const byId = new Map([...archives, ...folds].map((outcome) => [outcome.id, outcome]))
      clusters = selected.flatMap((cluster) => {
        const outcome = byId.get(cluster.id)
        return outcome === undefined ? [] : [outcome]
      })
    }
    const tip = yield* revParse(input.root, ref)
    // The ref moved: cache its version so `curate merge` loads the tip from a snapshot. Best-effort
    // by construction, and from the held version, which `heads.at` advances to the tip by delta.
    const snapshot =
      input.dryRun || tip === null || tip === base
        ? null
        : yield* snapshotAfterCommit(input.root, tip, (yield* heads.at(tip)).view)
    return {
      ref,
      base,
      model: input.model,
      dryRun: input.dryRun,
      planSource: input.plan === undefined ? "computed" : "file",
      planMs,
      planShaMismatch:
        input.plan !== undefined && input.plan.sha !== null && input.plan.sha !== base,
      totals: plan.totals,
      plan: input.dryRun ? plan : null,
      clusters,
      untouched,
      summary: {
        committed: clusters.filter((one) => one.outcome === "committed").length,
        failed: clusters.filter(
          (one) =>
            one.outcome === "failed" || one.outcome === "refused" || one.outcome === "modelError"
        ).length,
        archived: clusters.reduce((sum, one) => sum + one.ops.archive, 0),
        canonicals: clusters.reduce((sum, one) => sum + one.ops.put, 0),
        commits: clusters.reduce((sum, one) => sum + one.commits.length, 0)
      },
      head: headStats(loaded),
      tip,
      snapshot,
      next: `memhtml curate merge ${ref}`
    }
  })
