import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { type EdgeRel, isEdgeRel } from "@memhtml/contracts/edges"
import { INBOX_DIR, normalizePath, TASKS_SUBDIR } from "@memhtml/contracts/paths"
import { checkMemory, parseMemory } from "@memhtml/html"
import { DatabaseService, type DatabaseShape, STATE_SCHEMA } from "@memhtml/index"
import { EMBED_WATERMARK } from "@memhtml/llm"
import {
  allPaths,
  applyHeadEdits,
  archivedFormOf,
  danglingEdges,
  hrefFor,
  link,
  meta,
  unlink
} from "@memhtml/sleep"
import { attemptIo, commitSubject, readFileOrNull } from "@memhtml/store"
import { Effect } from "effect"

import { Git, Store } from "./api-layer.js"

/**
 * `memhtml doctor`: the corpus's own health check, and `--fix` for the two findings a repair can settle
 * without a judgement call.
 *
 * Nine checks, and each one is a claim the design makes about the corpus rather than a lint:
 *
 * 1. **Dangling `<link>` hrefs**: an authored edge pointing at a path the tree does not hold. Design
 *    §2.3 has no foreign key on `edges` deliberately (a `<link>` may name a file the indexer has not
 *    reached), so a LEFT JOIN is the only thing that finds these.
 * 2. **Orphan state rows**: a `state.access` row whose path left the tree. There are no
 *    cross-database foreign keys, so the store mirrors a move explicitly and an interrupted mirror
 *    leaves a row describing nothing.
 * 3. **Inbox depth**: design §2.1 rule 6 routes an unplaceable memory to `areas/inbox/` and says
 *    doctor reports the depth as a health signal. A deep inbox is a placement rule that stopped
 *    matching what agents write, which nothing else surfaces.
 * 4. **Vocabulary warnings**: format constraint 6. An element outside the closed vocabulary still
 *    indexes, so the only way it ever becomes visible is here.
 * 5. **Index staleness**: the index is a projection of a commit, so "fresh" means the commit it
 *    describes is the commit we are on. Plus the vector-space watermark, because a stored space that
 *    differs from the configured one makes every cosine in the index incomparable.
 * 6. **Overdue tasks**: a task is default-excluded from search and skipped by every sleep phase, so
 *    nothing else in the system will ever mention that a deadline passed. Doctor is the only surface
 *    that reads `due_at`.
 * 7. **Stale task blockers**: a `blocks` edge whose blocker is archived or absent. This is the one
 *    task-graph state no single file can reveal, since each file individually is valid and the pair
 *    is a task waiting on something that will never move.
 * 8. **Task inbox depth**: a task in `areas/inbox/tasks/` is work with no project, and a task inbox
 *    is meant to be drained rather than accumulated.
 * 9. **Stale detected-task quotes**: a machine-minted task's `<q cite>` evidence whose cited file left
 *    the tree or no longer contains the quote. A detected task's whole value is that a reviewer can
 *    check the finding against the corpus, and the quote is the only thing standing behind it — so a
 *    quote that stopped being true makes the task unreviewable while it still reads as actionable.
 *
 * **`--fix` repairs exactly two of the nine, and the repair logic is imported from the sleep
 * integrity phase rather than re-ported.** `archivedFormOf` decides whether a dangling target moved
 * to the archive or is genuinely gone, and `applyHeadEdits`/`link`/`unlink`/`meta` are the byte-splice
 * editors that change one head line without touching the article. A parse→serialize round trip drops
 * a `<pre>` newline per write, so a "repair" through the serializer would move the content hash of
 * every file it touched. A second implementation of either would be the consumer-side reimplementation
 * of producer semantics the fleet has paid for repeatedly.
 *
 * The other seven report and do not repair. An inbox memory or task needs a human or an agent to
 * decide where it belongs, a vocabulary warning needs the author's intent, and a stale index needs
 * `memhtml index update`, which doctor names in its own suggestions rather than running behind the
 * operator's back. An overdue task needs the work done or the deadline moved, a stale blocker needs
 * someone to decide whether the blocked task is actually ready, and a stale quote needs a reviewer to
 * judge whether the finding survived the edit that broke its evidence.
 */

/** How deep the inbox may get before doctor calls it a finding. */
export const INBOX_WARN_DEPTH = 20

/**
 * How many unplaced tasks may sit in `areas/inbox/tasks/` before doctor calls it a finding.
 *
 * Lower than {@link INBOX_WARN_DEPTH} because the two crowds mean different things. An unplaced
 * memory is a placement rule that stopped matching. An unplaced task is work with no project, which
 * is the state a to-do list rots in, and a task inbox is meant to be drained rather than accumulated.
 */
export const INBOX_TASK_WARN_DEPTH = 10

/** One dangling href, and what a repair would do about it. */
export interface DanglingFinding {
  readonly srcPath: string
  readonly rel: string
  readonly dstPath: string
  /** The archive path the target moved to, or `null` when the target is genuinely gone. */
  readonly rewriteTo: string | null
}

/** One file carrying vocabulary warnings. */
export interface WarningFinding {
  readonly path: string
  readonly warnings: ReadonlyArray<string>
}

/** One open task past its deadline. */
export interface OverdueTaskFinding {
  readonly path: string
  readonly taskStatus: string | null
  /** The `memhtml-due` value, verbatim. An ISO date or datetime. */
  readonly dueAt: string
}

/** One open task whose blocker can never close it. */
export interface StaleBlockerFinding {
  readonly path: string
  readonly blockerPath: string
  /** `archived`: the blocker is finished or evicted. `missing`: no file at that path at all. */
  readonly blockerState: "archived" | "missing"
}

/** One detected task whose cited evidence no longer backs it. */
export interface StaleQuoteFinding {
  /** The TASK's path: the file carrying the `<q cite>`. */
  readonly path: string
  /** The `cite` attribute verbatim as the task wrote it: root-relative, before any archive chase. */
  readonly citedPath: string
  /**
   * `missing`: no file at the cited path, active or archived. `quote-gone`: the file is there and the
   * quote is not in it.
   */
  readonly state: "missing" | "quote-gone"
}

/** What a doctor pass found. Every list is present and possibly empty, so a parser never branches. */
export interface DoctorReport {
  readonly root: string
  /** True when every check is clean. */
  readonly healthy: boolean
  readonly dangling: ReadonlyArray<DanglingFinding>
  /** `state.access` rows whose path is absent from `files`. */
  readonly orphanAccessRows: ReadonlyArray<string>
  readonly inboxDepth: number
  /** True when the inbox is past {@link INBOX_WARN_DEPTH}. */
  readonly inboxCrowded: boolean
  /** Open tasks in `areas/inbox/tasks/`: work with no project. */
  readonly inboxTaskDepth: number
  /** True when the task inbox is past {@link INBOX_TASK_WARN_DEPTH}. */
  readonly inboxTasksCrowded: boolean
  /** Open tasks whose `memhtml-due` has passed, earliest first. */
  readonly overdueTasks: ReadonlyArray<OverdueTaskFinding>
  /** Open tasks blocked by a task that is archived or absent from the tree. */
  readonly staleBlockers: ReadonlyArray<StaleBlockerFinding>
  /** Open DETECTED tasks whose `<q cite>` evidence no longer exists in the cited file. */
  readonly staleQuotes: ReadonlyArray<StaleQuoteFinding>
  readonly warnings: ReadonlyArray<WarningFinding>
  /** Files the index holds that failed to parse when doctor re-read them. */
  readonly unparseable: ReadonlyArray<string>
  readonly indexFresh: boolean
  readonly indexHeadSha: string | null
  readonly headSha: string | null
  /** True when the stored vector space IS the configured one. */
  readonly embedModelMatches: boolean
  readonly storedEmbedModel: string | null
  readonly configuredEmbedModel: string
  readonly dirty: ReadonlyArray<string>
  /** Present under `--fix`: what the repair actually did. */
  readonly repaired?: RepairReport | undefined
}

/** What `--fix` changed. */
export interface RepairReport {
  /** Dangling hrefs rewritten to the target's archive path. */
  readonly rewritten: number
  /** Dangling hrefs dropped because the target has no file anywhere. */
  readonly dropped: number
  /** Orphan `state.access` rows deleted. */
  readonly prunedAccessRows: number
  /** The commit the href repairs landed in, or `null` when nothing was rewritten. */
  readonly commitSha: string | null
}

/** Every `state.access` path the index has no `files` row for. */
const orphanAccess = (db: DatabaseShape): Effect.Effect<ReadonlyArray<string>, never, never> =>
  db.hasState
    ? db
        .all<{ path: string }>(
          `SELECT a.path AS path FROM ${STATE_SCHEMA}.access a
           LEFT JOIN files f ON f.path = a.path
           WHERE f.path IS NULL ORDER BY a.path ASC`
        )
        .pipe(
          Effect.map((rows) => rows.map((row) => row.path)),
          Effect.orElseSucceed(() => [])
        )
    : Effect.succeed([])

/** How many ACTIVE memories sit in the inbox. An archived one is no longer awaiting placement. */
const inboxDepth = (db: DatabaseShape): Effect.Effect<number, never, never> =>
  db
    .get<{ n: number }>(
      "SELECT count(*) AS n FROM files WHERE archived = 0 AND path LIKE ? || '/%'",
      [INBOX_DIR]
    )
    .pipe(
      Effect.map((row) => row?.n ?? 0),
      Effect.orElseSucceed(() => 0)
    )

/**
 * How many ACTIVE tasks sit in the task inbox.
 *
 * `memory_type = 'task'` as well as the path prefix, because `areas/inbox/tasks/` is a directory and
 * a directory is not a type: a hand-authored memory filed there would inflate the task count and make
 * the finding say something it does not mean.
 */
const inboxTaskDepth = (db: DatabaseShape): Effect.Effect<number, never, never> =>
  db
    .get<{ n: number }>(
      `SELECT count(*) AS n FROM files
       WHERE archived = 0 AND memory_type = 'task' AND path LIKE ? || '/%'`,
      [`${INBOX_DIR}/${TASKS_SUBDIR}`]
    )
    .pipe(
      Effect.map((row) => row?.n ?? 0),
      Effect.orElseSucceed(() => 0)
    )

/**
 * Open tasks past their deadline.
 *
 * `substr(due_at, 1, 10)` states that the comparison is one of calendar days. The bound is always a
 * bare `YYYY-MM-DD` (today, from the clock), and enumerated against that bound the truncation changes
 * no answer, because a time-bearing due date on the bound's own day sorts after it either way. It
 * stays as the statement of intent. `listTasks`' `--due-before` takes a caller-supplied bound that may
 * carry a time, where the truncation does change answers, and one form across both queries keeps
 * "overdue" meaning the same thing in the two places an operator reads it.
 *
 * **`archived = 0` and `task_status <> 'done'` both change the result** (mutation-verified
 * 2026-08-02). A finished task's deadline is history, and reporting it would make the finding grow
 * forever and never reach zero.
 */
const overdueTasks = (
  db: DatabaseShape,
  today: string
): Effect.Effect<ReadonlyArray<OverdueTaskFinding>, never, never> =>
  db
    .all<{ path: string; task_status: string | null; due_at: string }>(
      `SELECT path, task_status, due_at FROM files
       WHERE memory_type = 'task' AND archived = 0 AND due_at IS NOT NULL
         AND substr(due_at, 1, 10) < ? AND task_status <> 'done'
       ORDER BY due_at ASC, path ASC`,
      [today]
    )
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ path: row.path, taskStatus: row.task_status, dueAt: row.due_at }))
      ),
      Effect.orElseSucceed(() => [])
    )

/**
 * Open tasks whose blocker can never close them.
 *
 * A `blocks` edge points blocker → blocked, so the blocked task is the edge's `dst_path`. A LEFT JOIN
 * rather than an inner one, because the two failure modes differ. An archived blocker is finished work
 * whose edge nobody cleared, and a missing one is an edge whose source has no `files` row. Either way
 * the blocked task waits on something that will never move. This is the one task-graph state no single
 * file can reveal, since each file is individually valid and only the pair is wrong.
 *
 * **The `archived` arm is the reachable one, and `missing` is defense in depth.** Probed and
 * mutation-confirmed 2026-08-02: deleting a blocker's file makes `indexer.update` clear
 * `edges WHERE src_path = ?` in the same batch, so an edge cannot outlive its source file and the
 * `missing` branch has nothing to find. Removing that `DELETE` turns the branch on, and it stays for
 * that reason. `edges` carries no foreign key deliberately, so a future writer of edge rows would not
 * inherit the indexer's discipline.
 *
 * **`edge_class = 'task'` is redundant with `rel = 'blocks'` today.** The migration's per-class CHECKs
 * refuse `blocks` under every other class, so a mutation dropping it leaves the suite green. It is kept
 * because every memory-graph query filters on the class column, and a reader who saw this one trust
 * the rel alone would learn the wrong rule about where the firewall lives.
 *
 * Report-only. Clearing the edge is an authoring decision, since the blocked task may be genuinely
 * ready or the blocker may have been archived prematurely. `--fix` guessing between those would rewrite
 * a plan.
 */
const staleBlockers = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<StaleBlockerFinding>, never, never> =>
  db
    .all<{ path: string; blocker_path: string; blocker_state: string }>(
      `SELECT t.path AS path, e.src_path AS blocker_path,
              CASE WHEN b.path IS NULL THEN 'missing' ELSE 'archived' END AS blocker_state
       FROM files t
       JOIN edges e ON e.dst_path = t.path AND e.edge_class = 'task' AND e.rel = 'blocks'
       LEFT JOIN files b ON b.path = e.src_path
       WHERE t.memory_type = 'task' AND t.archived = 0 AND t.task_status <> 'done'
         AND (b.path IS NULL OR b.archived = 1)
       ORDER BY t.path ASC, e.src_path ASC`
    )
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          path: row.path,
          blockerPath: row.blocker_path,
          blockerState:
            row.blocker_state === "missing" ? ("missing" as const) : ("archived" as const)
        }))
      ),
      Effect.orElseSucceed(() => [])
    )

/**
 * True when `quote` appears in `text` with runs of whitespace collapsed to one space on BOTH sides.
 *
 * **A deliberate twin of `quoteAppearsIn` in `apps/consolidator/src/contract.ts:285-291`, not an
 * import**, and the definition is character-for-character the same three lines. The two checks verify
 * the same property against different substrates — that one there against a mounted transcript, this
 * one against a memory file — and the consolidator's copy is the one its own tier exercises with no
 * transcript on disk. Reaching it from here means importing `@memhtml/consolidator`'s barrel, which
 * re-exports `mount.js` and puts `just-bash`'s ~6 MB bundle on `memhtml doctor`'s module graph; that is
 * the exact cost `apps/cli/src/exec.ts:314-325` documents keeping on the exec path alone. The two
 * definitions must AGREE, so a fix to one is ported to the other rather than unified.
 *
 * Collapsing whitespace is the only normalization, and that is a concession to markup rather than
 * leniency: a minting phase writes a quote into a `<q>` where the serializer is free to re-wrap it,
 * and the parser collapses it back. Case, punctuation, and quote characters compare as written,
 * because each of those is a way a "quote" could differ from the source in a way that changes what it
 * says.
 */
const quoteAppearsIn = (quote: string, text: string): boolean => {
  const flatten = (value: string): string => value.replace(/\s+/g, " ").trim()
  const needle = flatten(quote)
  /** An empty needle is `includes`-true against anything, which would gate nothing. */
  if (needle === "") return false
  return flatten(text).includes(needle)
}

/** One cited quote of a task: where it points and what it claims is there. */
interface CitedQuote {
  readonly citedPath: string
  readonly text: string
}

/**
 * The cited evidence of one memory, from the format's own parse.
 *
 * **The evidence element is `<q cite="/path">`, NOT `<blockquote>`, and that is what makes this check
 * possible at all.** `blockquote` is outside `KNOWN_ELEMENTS`, so a task minted with one carries the
 * constraint-6 warning `<blockquote> is outside the closed vocabulary` forever AND its quoted text
 * never reaches `article.citations`, which would leave the evidence unverifiable by anything. `<q>` is
 * in the closed vocabulary and `packages/html/src/parse.ts:313-319`'s `readCitations` already lifts
 * `<q cite>` into `article.citations` as `{text, href}` — the same extraction that fills
 * `file_citations` (`packages/index/src/project.ts:304-309`). `packages/sleep/src/mint.ts:102-113`
 * pins the element choice on the minting side.
 *
 * So doctor reads the citations off `parseMemory` rather than re-parsing with a second library or
 * re-implementing the extraction. One consequence is deliberate: a citation with no `href` — a bare
 * `<cite>The Book</cite>` — is not evidence about a repo path and is dropped here, so only a `<q cite>`
 * is checked.
 *
 * `parseMemory` over `file_citations` even though the table holds the same rows, for two reasons. The
 * `href` is stored but the projection dedupes by TEXT alone, so two quotes of the same sentence from
 * two files collapse to one row and the second citation's path is lost — a pair mint quoting both
 * sides of a near-duplicate is exactly that shape. And the index is a projection of a commit: doctor's
 * whole job includes reporting when the index disagrees with the tree, so a check that read the
 * projection would go blind precisely when a stale index is the problem.
 */
const citedQuotesOf = (html: string): Effect.Effect<ReadonlyArray<CitedQuote>, never, never> =>
  parseMemory(html).pipe(
    Effect.map((doc) =>
      doc.article.citations.flatMap((citation) =>
        citation.href === undefined || citation.href.trim() === ""
          ? []
          : [{ citedPath: citation.href, text: citation.text }]
      )
    ),
    /** An unparseable file is `unparseable`'s finding; it does not also become a quote finding. */
    Effect.orElseSucceed(() => [])
  )

/**
 * The searchable text of a cited file: its article's text, as the format's own parse yields it.
 *
 * **Compared as TEXT and never as bytes, and the difference decides most real cases.** A quote is a
 * run of prose the source renders, and the source renders it through markup: `&amp;` in the file is
 * `&` in the quote, `&nbsp;` is U+00A0, and a `<strong>` mid-sentence splits the run in the bytes
 * while a reader sees one sentence. A containment check against raw HTML would report `quote-gone` on
 * every one of those and be wrong each time.
 *
 * `article.bodyText` is the field that already means this — it is whitespace-collapsed article text
 * with entities decoded, and it is what the FTS index and the embedder tokenize, so "the corpus
 * contains this sentence" means the same thing here as in a search. Both sides of the comparison come
 * out of one parser, which is what makes containment mean "this text is in that file" rather than
 * "two libraries agreed about entity tables".
 *
 * An unparseable cited file yields the empty string, so its quote reports `quote-gone` rather than
 * throwing — and that file is `unparseable`'s own finding on its own line.
 */
const searchableTextOf = (html: string): Effect.Effect<string, never, never> =>
  parseMemory(html).pipe(
    Effect.map((doc) => doc.article.bodyText),
    Effect.orElseSucceed(() => "")
  )

/**
 * Open DETECTED tasks whose cited evidence no longer backs them.
 *
 * The rows are the same open-detected-task set `packages/sleep/src/sql.ts`'s `openDetectedTasks`
 * reads, minus the detector range: doctor asks about every detector at once, so
 * `finding_key IS NOT NULL` alone is the filter. **`memory_type = 'task'` and `finding_key IS NOT NULL`
 * both change the result and neither is decoration.** A hand-authored task quoting a file is not a
 * detected finding and its author owns its quotes; a non-task memory citing a path is ordinary prose,
 * and `<q cite>` is a general-purpose vocabulary element every memory may use.
 * `task_status <> 'done'` rides along beside `archived = 0` for the reason that helper records: the
 * two agree at rest and disagree for the instant between a status edit and its `git mv`.
 *
 * **The archive chase is `archivedFormOf`, the same function `--fix` uses on a dangling href**, so
 * "the file moved to the archive" means one thing across both checks. An archived cited file is NOT a
 * finding: eviction is a `git mv` that preserves the bytes, so the quote is still verifiable and the
 * evidence still stands. Only a path with no file anywhere is `missing`.
 *
 * `citedPath` is reported VERBATIM as the task wrote it, not as the archive path the chase found. The
 * operator's next move is to read the task file and judge the finding, and a rewritten path would not
 * appear in the bytes they open.
 *
 * Report-only, and `healthy` excludes it for the reason `overdueTasks` and `staleBlockers` are
 * excluded: a stale quote is a fact about DETECTED WORK, not a defect in the corpus. The usual way one
 * appears is a human editing the very text a detector flagged — which is the finding being resolved,
 * and turning that into `healthy: false` would punish the fix. Repair is refused for the same reason
 * one arm is impossible and the other is a judgement: doctor cannot re-derive a quote it did not mint,
 * and closing the task is a decision about whether the finding survived the edit.
 *
 * Session-cited evidence is out of coverage BY CONSTRUCTION rather than by omission, and that is the
 * accepted residual: transcript-borne evidence is written as plain text naming a session id and
 * carries no `cite` attribute at all, because a session is not a repo path. The consolidator client,
 * the one process with the transcripts mounted, verifies that containment before the payload is ever
 * returned (`apps/consolidator/src/client.ts`).
 */
const staleQuotes = (
  db: DatabaseShape,
  root: string,
  known: ReadonlySet<string>,
  year: number
): Effect.Effect<ReadonlyArray<StaleQuoteFinding>, never, never> =>
  Effect.gen(function* () {
    const tasks = yield* db
      .all<{ path: string }>(
        `SELECT path FROM files
         WHERE memory_type = 'task' AND archived = 0 AND finding_key IS NOT NULL
           AND task_status <> 'done'
         ORDER BY path ASC`
      )
      .pipe(Effect.orElseSucceed(() => []))

    const findings: Array<StaleQuoteFinding> = []
    /** One read per cited file however many tasks quote it: a pair mint cites both sides. */
    const contents = new Map<string, string | null>()
    const contentOf = (path: string) =>
      Effect.gen(function* () {
        const cached = contents.get(path)
        if (cached !== undefined) return cached
        const html = yield* readFileOrNull(join(root, path)).pipe(Effect.orElseSucceed(() => null))
        contents.set(path, html)
        return html
      })

    for (const task of tasks) {
      const html = yield* readFileOrNull(join(root, task.path)).pipe(
        Effect.orElseSucceed(() => null)
      )
      /**
       * A task file the index names and the tree does not is already `unparseable`'s finding, and
       * reporting the same missing file twice under two names would double-count one problem.
       */
      if (html === null) continue

      for (const quote of yield* citedQuotesOf(html)) {
        /**
         * `normalizePath` strips the leading slash of the root-relative href form the format requires
         * (`isRootRelativeHref`), so a `cite="/areas/x.html"` compares against the `files.path` values
         * `known` holds. Reported unnormalized, below.
         */
        const cited = normalizePath(quote.citedPath)
        const resolved = known.has(cited) ? cited : archivedFormOf(cited, known, year)
        if (resolved === undefined) {
          findings.push({ path: task.path, citedPath: quote.citedPath, state: "missing" })
          continue
        }
        const source = yield* contentOf(resolved)
        if (source === null) {
          findings.push({ path: task.path, citedPath: quote.citedPath, state: "missing" })
          continue
        }
        if (!quoteAppearsIn(quote.text, yield* searchableTextOf(source))) {
          findings.push({ path: task.path, citedPath: quote.citedPath, state: "quote-gone" })
        }
      }
    }
    return findings
  })

/**
 * Re-read every active file and collect its format warnings.
 *
 * Re-read rather than taken from the index, because a warning is not a stored column. The indexer
 * counts a parse failure and projects what it can, and constraint 6 is deliberately non-fatal. Doctor
 * is the one caller that wants the list, so it is the one caller that pays for the read.
 */
const collectWarnings = (
  root: string,
  paths: ReadonlyArray<string>
): Effect.Effect<
  { readonly warnings: ReadonlyArray<WarningFinding>; readonly unparseable: ReadonlyArray<string> },
  never,
  never
> =>
  Effect.gen(function* () {
    const warnings: Array<WarningFinding> = []
    const unparseable: Array<string> = []
    for (const path of paths) {
      const html = yield* readFileOrNull(join(root, path)).pipe(Effect.orElseSucceed(() => null))
      if (html === null) {
        unparseable.push(path)
        continue
      }
      const checked = checkMemory(html)
      if (checked.violations.length > 0) unparseable.push(path)
      if (checked.warnings.length > 0) warnings.push({ path, warnings: checked.warnings })
    }
    return { warnings, unparseable }
  })

/** The year a run's repairs partition archive lookups under: the current calendar year. */
const currentYear = Effect.clockWith((clock) =>
  Effect.map(clock.currentTimeMillis, (millis) => new Date(millis).getUTCFullYear())
)

/** Today as `YYYY-MM-DD`, through the Effect clock so a test can pin what "overdue" means. */
const todayDate = Effect.clockWith((clock) =>
  Effect.map(clock.currentTimeMillis, (millis) => new Date(millis).toISOString().slice(0, 10))
)

/** An ISO-8601 UTC second, for the `memhtml-updated` stamp a repair writes. */
const nowSecond = Effect.clockWith((clock) =>
  Effect.map(clock.currentTimeMillis, (millis) => `${new Date(millis).toISOString().slice(0, 19)}Z`)
)

/**
 * Repair the dangling hrefs and prune the orphan access rows.
 *
 * The href repair mirrors the integrity phase exactly, using its own `archivedFormOf` and its own
 * head editors. A dangling target that moved under `archive/<YYYY>/` gets its href rewritten, so the
 * edge still says something true. A target with no file anywhere gets the link dropped with a
 * warning, because the edge asserts a relationship to nothing and leaving it would produce the same
 * finding on every rebuild forever.
 *
 * Remove-then-add on the same file in one pass, so a repair replaces one line rather than dropping a
 * line and appending another elsewhere in the head. A re-run is then a no-op: once the href points at
 * the archive path the removal matches nothing and the addition is already present.
 */
const repair = (
  root: string,
  findings: ReadonlyArray<DanglingFinding>,
  orphans: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const git = yield* Git
    const db = yield* DatabaseService
    const at = yield* nowSecond

    let rewritten = 0
    let dropped = 0
    const touched: Array<string> = []

    for (const finding of findings) {
      if (!isEdgeRel(finding.rel)) continue
      const rel = finding.rel as EdgeRel
      const absolute = join(root, finding.srcPath)
      const html = yield* readFileOrNull(absolute).pipe(Effect.orElseSucceed(() => null))
      if (html === null) continue

      const edits =
        finding.rewriteTo === null
          ? [unlink(rel, hrefFor(finding.dstPath)), meta("memhtml-updated", at)]
          : [
              unlink(rel, hrefFor(finding.dstPath)),
              link(rel, hrefFor(finding.rewriteTo)),
              meta("memhtml-updated", at)
            ]
      const edited = applyHeadEdits(html, edits)
      if (edited === html) continue

      if (finding.rewriteTo === null) {
        yield* Effect.logWarning(
          `doctor dropped a dangling ${rel} from ${finding.srcPath}: target has no file`
        )
      }
      yield* attemptIo(`doctor.write:${finding.srcPath}`, async () => {
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, edited, "utf8")
      }).pipe(Effect.orElseSucceed(() => undefined))
      touched.push(finding.srcPath)
      if (finding.rewriteTo === null) dropped += 1
      else rewritten += 1
    }

    let prunedAccessRows = 0
    if (orphans.length > 0 && db.hasState) {
      /**
       * One statement per path rather than an `IN` list, because the list is unbounded. A driver
       * parameter limit reached mid-prune would fail the whole batch and leave every row in place.
       */
      for (const path of orphans) {
        const done = yield* db
          .run(`DELETE FROM ${STATE_SCHEMA}.access WHERE path = ?`, [path])
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          )
        if (done) prunedAccessRows += 1
      }
    }

    let commitSha: string | null = null
    if (touched.length > 0) {
      yield* git.add(touched)
      const commit = yield* git.commit(
        commitSubject("link", `repair ${rewritten + dropped} dangling links`)
      )
      commitSha = commit.sha
    }

    return { rewritten, dropped, prunedAccessRows, commitSha } satisfies RepairReport
  })

/**
 * Run the health check, optionally repairing.
 *
 * The findings are gathered before any repair and the report carries the pre-repair lists alongside
 * `repaired`, which is what makes a `--fix` run auditable. An operator reads what was wrong and what
 * was done about it in one envelope, rather than a clean report that says nothing happened.
 */
export const doctor = (options: { readonly fix: boolean }) =>
  Effect.gen(function* () {
    const git = yield* Git
    const store = yield* Store
    const db = yield* DatabaseService

    const headSha = yield* git.revParseHead().pipe(Effect.orElseSucceed(() => null))
    const dirty = yield* store.dirtyPaths().pipe(Effect.orElseSucceed(() => []))

    const state = yield* db
      .get<{ head_sha: string | null; embed_model: string }>(
        "SELECT head_sha, embed_model FROM index_state WHERE id = 1"
      )
      .pipe(Effect.orElseSucceed(() => undefined))

    const known = new Set(
      (yield* allPaths(db).pipe(Effect.orElseSucceed(() => []))).map((row) => row.path)
    )
    const year = yield* currentYear
    const edges = yield* danglingEdges(db).pipe(Effect.orElseSucceed(() => []))
    const dangling: ReadonlyArray<DanglingFinding> = edges.map((edge) => {
      const dstPath = normalizePath(edge.dst_path)
      return {
        srcPath: edge.src_path,
        rel: edge.rel,
        dstPath,
        rewriteTo: archivedFormOf(dstPath, known, year) ?? null
      }
    })

    const orphanAccessRows = yield* orphanAccess(db)
    const depth = yield* inboxDepth(db)
    const taskDepth = yield* inboxTaskDepth(db)
    const overdue = yield* overdueTasks(db, yield* todayDate)
    const stale = yield* staleBlockers(db)
    /**
     * `known` and `year` are the ones the dangling-href chase above already computed, so a cited path
     * and a `<link>` href resolve against one snapshot of the tree and one archive lookback.
     */
    const quotes = yield* staleQuotes(db, git.root, known, year)

    const active = yield* db
      .all<{ path: string }>("SELECT path FROM files WHERE archived = 0 ORDER BY path ASC")
      .pipe(Effect.orElseSucceed(() => []))
    const { warnings, unparseable } = yield* collectWarnings(
      git.root,
      active.map((row) => row.path)
    )

    const repaired = options.fix ? yield* repair(git.root, dangling, orphanAccessRows) : undefined

    const indexFresh = state?.head_sha !== null && state?.head_sha === headSha
    const embedModelMatches = state?.embed_model === EMBED_WATERMARK

    return {
      root: git.root,
      /**
       * `healthy` is computed from the findings and not from the repair. A `--fix` run that repaired
       * everything still reports the corpus as it was found. A command that flipped itself green by
       * fixing what it found would make "doctor is clean" unfalsifiable.
       */
      healthy:
        dangling.length === 0 &&
        orphanAccessRows.length === 0 &&
        depth <= INBOX_WARN_DEPTH &&
        /**
         * The task inbox counts toward `healthy` for the same reason the memory inbox does: an
         * unplaced item is a routing signal. `overdueTasks`, `staleBlockers`, and `staleQuotes` are
         * excluded, because those three are facts about the work rather than defects in the corpus. A
         * repo whose owner is late on a to-do is structurally sound, and folding them in would make
         * `healthy: false` the normal state and stop anyone reading the flag at all. Every other
         * finding here is a defect in the corpus; those three describe work that has fallen behind or
         * a detected finding whose evidence a human has since edited.
         */
        taskDepth <= INBOX_TASK_WARN_DEPTH &&
        warnings.length === 0 &&
        unparseable.length === 0 &&
        indexFresh &&
        embedModelMatches,
      dangling,
      orphanAccessRows,
      inboxDepth: depth,
      inboxCrowded: depth > INBOX_WARN_DEPTH,
      inboxTaskDepth: taskDepth,
      inboxTasksCrowded: taskDepth > INBOX_TASK_WARN_DEPTH,
      overdueTasks: overdue,
      staleBlockers: stale,
      staleQuotes: quotes,
      warnings,
      unparseable,
      indexFresh,
      indexHeadSha: state?.head_sha ?? null,
      headSha,
      embedModelMatches,
      storedEmbedModel: state?.embed_model ?? null,
      configuredEmbedModel: EMBED_WATERMARK,
      dirty,
      ...(repaired === undefined ? {} : { repaired })
    } satisfies DoctorReport
  })
