import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { type EdgeRel, relClassFor } from "@memhtml/contracts/edges"
import {
  DirtyTree,
  InvalidMemory,
  PathNotFound,
  StorageFailure,
  WriteConflict
} from "@memhtml/contracts/errors"
import {
  archivePathFor,
  isValidMemoryPath,
  memoryPathFor,
  normalizePath,
  type PlacementInput
} from "@memhtml/contracts/paths"
import { filenameFor, slugify, withCollisionOrdinal } from "@memhtml/contracts/slug"
import type { MemoryDoc, NewMemoryInput } from "@memhtml/html"
import {
  addLink,
  checkMemory,
  contentHash,
  parseMemory,
  readMeta,
  renderTemplate,
  setMeta,
  VIOLATION_SEPARATOR
} from "@memhtml/html"
import { Config, Context, Effect, Layer } from "effect"

import { Git, type GitFailure, type GitShape, makeGit } from "./git.js"
import { attemptIo, readFileOrNull } from "./layout.js"
import { commitSubject, provenanceTrailers } from "./plumbing.js"

/**
 * The memory store: every operation that changes the corpus, expressed as one git commit.
 *
 * One commit per operation is the whole contract. It makes `git log` a readable history of
 * what the agent learned, makes `diff base..HEAD` a reviewable sleep run, and makes rollback
 * mean something. It also means the store, not its caller, owns staging — a caller that staged
 * its own files could bundle two unrelated writes into one commit and destroy that property.
 */

/** Session provenance for a write. Stamped into the file's head AND onto the commit as trailers. */
export interface WriteProvenance {
  readonly sessionId?: string | undefined
  readonly promptId?: string | undefined
  readonly turnUuid?: string | undefined
}

/** What `memory_write` supplies: the format's own input plus placement and provenance. */
export type WriteInput = NewMemoryInput &
  WriteProvenance & {
    /** An explicit path override. Ignored when it is not a usable memory path. */
    readonly path?: string | undefined
    readonly workspace?: string | undefined
  }

/**
 * The result of a write. `created` and `deduped` are mutually exclusive: exactly one is true.
 *
 * `existingPath` is set only on a dedupe, and it is the path that already holds this content —
 * so an agent that wrote a duplicate learns where the original is in the same response, with
 * no second query.
 */
export interface WriteResult {
  /** The path the content lives at: the new file, or the existing one on a dedupe. */
  readonly path: string
  readonly created: boolean
  readonly deduped: boolean
  readonly existingPath?: string | undefined
  /** The commit this write produced, or `null` on a dedupe (which commits nothing). */
  readonly commitSha: string | null
  /** The article's content hash, the value `dedupeLookup` was asked about. */
  readonly contentHash: string
}

/**
 * One op's outcome inside a batch. Exactly one of `ok`/`skipped` describes what happened to it,
 * and `index` is its position in the INPUT list — so a caller reads its own array back in order
 * even when the middle of it failed.
 *
 * `skipped` means "this op was never attempted": the batch aborted before reaching it, or aborted
 * after validating it but before anything touched disk. It is deliberately distinct from a failure,
 * because retrying a skipped op is correct and retrying a failed one is not.
 */
export interface BatchOpResult {
  readonly index: number
  readonly ok: boolean
  /** The path this op's content lives at: the new file, or the existing one on a dedupe. */
  readonly path?: string | undefined
  readonly deduped?: boolean | undefined
  readonly existingPath?: string | undefined
  /** The op's failure, present iff `ok` is false and `skipped` is false. */
  readonly error?: StoreError | undefined
  readonly skipped?: boolean | undefined
  /** The article's content hash, present whenever the op got as far as rendering. */
  readonly contentHash?: string | undefined
}

/**
 * What a batch did. `commitSha` is `null` when nothing was written — an all-deduped batch, or an
 * aborted one — because a batch that changed no file makes no commit.
 *
 * The counts are a summary of `results` and cannot disagree with it: they are derived from the same
 * array in one pass, so a caller may branch on either.
 */
export interface BatchWriteResult {
  readonly results: ReadonlyArray<BatchOpResult>
  readonly summary: {
    readonly total: number
    readonly written: number
    readonly deduped: number
    readonly failed: number
    readonly skipped: number
  }
  readonly commitSha: string | null
  /** Every path this batch created, in input order. Empty on a dedupe-only or aborted batch. */
  readonly writtenPaths: ReadonlyArray<string>
}

/** A memory as read from the tree: its path, its bytes, and its parsed form. */
export interface ReadResult {
  readonly path: string
  readonly html: string
  readonly doc: MemoryDoc
}

/** What a correction produced. */
export interface CorrectResult {
  /** The new file's path. */
  readonly path: string
  /** The corrected file's new, archived path. */
  readonly archivedPath: string
  readonly commitSha: string | null
  readonly contentHash: string
}

/** What an archive produced. */
export interface ArchiveResult {
  readonly path: string
  readonly archivePath: string
  readonly commitSha: string | null
}

/**
 * What a supersede produced. `commitSha` is `null` exactly when the pair list was empty — a
 * consolidation with nothing to consolidate touches neither disk nor git, so there is no commit
 * to name. `archived` maps each loser to where it now lives, in input order.
 */
export interface SupersedeResult {
  readonly commitSha: string | null
  readonly archived: ReadonlyArray<{
    readonly loserPath: string
    readonly archivePath: string
  }>
}

/**
 * Asks whether an active file already holds this content hash, answering its path or `null`.
 *
 * An injected function rather than a repository method, because the answer lives in SQL and
 * this package is SQL-free by design — T7 wires it to the `files_content_hash_active` partial
 * unique index, and a test wires it to a Map. The store's only knowledge is that a non-null
 * answer means "do not write".
 */
export type DedupeLookup = (
  contentHash: string
) => Effect.Effect<string | null, StorageFailure | GitFailure>

/**
 * Notified after a path moves, before the commit. How `state.access.path` follows an archive:
 * cross-database foreign keys do not exist, so the mirror is an explicit call the store makes
 * at the one place a path can change.
 */
export type MoveCallback = (
  from: string,
  to: string
) => Effect.Effect<void, StorageFailure | GitFailure>

/** The hooks a caller supplies. Both default to inert, so the store works with neither. */
export interface StoreHooks {
  readonly dedupeLookup?: DedupeLookup | undefined
  readonly onMove?: MoveCallback | undefined
}

/** Every failure a store operation can produce. */
export type StoreError =
  | GitFailure
  | StorageFailure
  | InvalidMemory
  | PathNotFound
  | WriteConflict
  | DirtyTree

export interface StoreShape {
  readonly root: string
  readonly git: GitShape
  readonly writeMemory: (input: WriteInput) => Effect.Effect<WriteResult, StoreError>
  /**
   * N writes, ONE commit. The batch primitive `memhtml apply` and `memory_write_batch` are doors over.
   *
   * Atomic by default: every op is validated — rendered through the gate, asked the dedupe
   * question, given a claimed path — BEFORE any file is written, so a refusal leaves the tree
   * byte-identical with nothing to roll back. `continueOnError` flips to best-effort, where the
   * survivors land in the one commit and each failure is reported in place.
   *
   * The whole reason this is not a loop over {@link writeMemory} at the caller: N calls means N
   * commits and therefore N reindexes, and two ops sharing a title would collide because
   * `freePathFor` reads DISK — it cannot see a path an earlier op in the same batch has claimed but
   * not yet written. Both properties belong to the fold, not to the caller.
   *
   * The error channel is for a failure of the batch MECHANISM (a git command, a rollback), never
   * for an op: a rejected op is a `BatchOpResult` with `ok: false`, including in atomic mode, so a
   * caller always gets its per-op array back.
   */
  readonly writeMemories: (
    inputs: ReadonlyArray<WriteInput>,
    options?: { readonly continueOnError?: boolean | undefined } | undefined
  ) => Effect.Effect<BatchWriteResult, StoreError>
  readonly readMemory: (path: string) => Effect.Effect<ReadResult, StoreError>
  /**
   * Correct a memory: write a new file carrying `memhtml-supersedes` toward the target, archive the
   * target with `memhtml-superseded-by` pointing back, ONE commit.
   *
   * Both halves in one commit because a correction is one fact about the corpus. Split across
   * two, an interrupted run would leave a superseding file whose target is still active — two
   * live memories asserting contradictory things, with nothing in the tree saying which won.
   */
  readonly correctMemory: (
    target: string,
    input: WriteInput & { readonly reason?: string | undefined }
  ) => Effect.Effect<CorrectResult, StoreError>
  readonly archiveMemory: (path: string, reason: string) => Effect.Effect<ArchiveResult, StoreError>
  /**
   * Consolidate N winner/loser pairs of EXISTING files: each loser is archived with
   * `memhtml-superseded-by` pointing at its winner, each winner gains a `supersedes` link pointing
   * at the loser's ARCHIVE path, ONE commit for all pairs.
   *
   * `correctMemory`'s mechanics without the write: a correction creates the winner, while here
   * both files are already in the tree — write-time consolidation decided the winner AFTER its
   * batch committed, so the supersedence is a second fact about the corpus and gets its own
   * commit. One commit for ALL pairs because the pairs came from one consolidation decision;
   * split, an interrupted run would leave some slots consolidated and some not with nothing in
   * the history saying which pass produced which.
   *
   * Both files are read BEFORE any staging, so a pair naming a missing path fails typed
   * (`PathNotFound`) with the tree byte-identical — the same refusal-first order every other
   * operation here follows.
   */
  readonly supersedeMemories: (
    pairs: ReadonlyArray<{ readonly winnerPath: string; readonly loserPath: string }>
  ) => Effect.Effect<SupersedeResult, StoreError>
  /**
   * Add a `<link rel="memhtml-…">` edge to the source file and commit it. Idempotent.
   *
   * Refuses a class/endpoint mismatch with `InvalidMemory`: a memory-class rel touching a `task`
   * file, or a task-class rel touching a non-task. Only the store sees both files' types, so this
   * is where the task/memory graph separation is enforced on the way in — the `edges` CHECK pairs a
   * rel with its class and cannot reach the endpoints' types at all.
   */
  readonly linkMemories: (
    srcPath: string,
    rel: EdgeRel,
    dstPath: string
  ) => Effect.Effect<{ readonly commitSha: string | null }, StoreError>
  /** Paths with uncommitted changes. Empty means a clean tree. */
  readonly dirtyPaths: () => Effect.Effect<ReadonlyArray<string>, StoreError>
  /** Fail with `DirtyTree` unless the working tree is clean. What sleep's preflight calls. */
  readonly requireCleanTree: () => Effect.Effect<void, StoreError>
  /**
   * Merge `commitish` into the current branch, surfacing a content conflict as a typed
   * `WriteConflict` carrying both blob shas.
   */
  readonly mergeBranch: (commitish: string) => Effect.Effect<void, StoreError>
}

export const Store = Context.Service<StoreShape>("memhtml/Store")

/**
 * `MEMHTML_ROOT`, defaulting to `~/memhtml`. A leading `~` is expanded, because this value
 * reaches the process from a shell profile, an MCP client config, and a cron line — and only
 * the shell expands tildes, so the other two would otherwise create a literal `./~` directory.
 */
export const MemhtmlRootConfig = Config.string("MEMHTML_ROOT").pipe(
  Config.withDefault(join("~", "memhtml")),
  Config.map(expandRoot)
)

/** Expand `~` and resolve to an absolute path. */
export function expandRoot(raw: string): string {
  const trimmed = raw.trim()
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/** ISO-8601 UTC to the second, the format every `memhtml-*` timestamp carries. */
export const isoSecond = (millis: number): string =>
  `${new Date(millis).toISOString().slice(0, 19)}Z`

/** The calendar year an archive path partitions under. */
const yearOf = (millis: number): number => new Date(millis).getUTCFullYear()

/**
 * The one memory type a batch's own dedupe map exempts, in BOTH directions.
 *
 * A mirror of the injected `dedupeLookup`'s own predicate — `@memhtml/index`'s `activePathForHash`
 * filters `memory_type <> 'task'` to match the `files_content_hash_active` partial unique index —
 * and it has to be restated here because the store's intra-batch map is a SECOND dedupe oracle that
 * the hook never sees. Two open tasks with identical bodies are two real work items, so neither is
 * deduped onto the other; and a memory whose article happens to match a task's must not be deduped
 * onto that task, or the caller would be handed a task's path as the home of its fact.
 *
 * Restated rather than imported: `@memhtml/store` is SQL-free and must not depend on `@memhtml/index`. A
 * test pins the two-way carve-out, which is what keeps this constant honest.
 */
const DEDUPE_EXEMPT_TYPE = "task"

/**
 * True when an input is subject to content-hash dedup at all.
 *
 * ONE predicate rather than a `memoryType !== "task"` test at each of the three places the batch
 * touches its hash map — the two reads and the write. Three copies is three chances for the
 * carve-out to hold in one direction and not the other, which is the exact bug the injected
 * lookup's own comment warns about (`@memhtml/index`'s `activePathForHash`), and a mutation that broke
 * one copy would leave the other two covering for it.
 */
const dedupable = (input: WriteInput): boolean => input.memoryType !== DEDUPE_EXEMPT_TYPE

/** One op that passed validation and is waiting for the batch's single write pass. */
interface PendingWrite {
  readonly index: number
  readonly path: string
  readonly html: string
  readonly input: WriteInput
  readonly contentHash: string
}

/**
 * The subject a batch commit carries: the one title when a batch wrote one file, a count otherwise.
 *
 * A batch of one is an ordinary write as far as `git log --oneline` is concerned, and naming it
 * `1 memories` would make a common case read badly for no gain. `commitSubject` caps and flattens
 * the title, so an agent-supplied one cannot become a commit body.
 */
const subjectFor = (pending: ReadonlyArray<PendingWrite>): string =>
  pending.length === 1 && pending[0] !== undefined
    ? pending[0].input.title
    : `${pending.length} memories`

/** True when a write input carries session provenance worth stamping as a commit trailer. */
const hasProvenance = (entry: PendingWrite): boolean =>
  Object.keys(provenanceTrailers(entry.input)).length > 0

/**
 * The store over a git service. Exported so tests build it against a temp-dir repo with the
 * real git binary: this package's job IS git's behaviour, so a fake git would verify only that
 * the right strings were assembled and would miss every state transition that matters.
 */
export const makeStore = (git: GitShape, hooks: StoreHooks = {}): StoreShape => {
  const absolute = (path: string): string => join(git.root, path)

  /** Now, as both a millisecond instant and the ISO string the metas carry. */
  const now = Effect.clockWith((clock) => clock.currentTimeMillis)

  /**
   * A free path for a title: the placement rule's own path, then `-2`, `-3`, … until one is
   * absent from disk. The collision suffix belongs here rather than in `@memhtml/contracts`
   * because deciding "taken" requires touching the filesystem, and the path algebra is pure.
   *
   * `claimed` is the set of paths a caller has already promised to write but has not written yet.
   * It exists for exactly one caller — {@link writeMemories}, which validates every op before
   * touching disk — and without it two ops sharing a title in one batch would both be handed the
   * unsuffixed path, and the second write would silently overwrite the first. Disk is authoritative
   * for everything else; a path is taken if EITHER source says so.
   */
  const freePathFor = (
    input: PlacementInput & { readonly title: string; readonly at: Date },
    claimed: ReadonlySet<string> = new Set()
  ): Effect.Effect<string, StorageFailure> =>
    Effect.gen(function* () {
      const first = memoryPathFor(input)
      // An explicit valid path is authoritative: the caller named it, and silently writing to
      // `…-2.html` instead would leave the caller holding a path with no file behind it.
      if (input.path !== undefined && isValidMemoryPath(input.path)) return first
      const directory = first.slice(0, first.lastIndexOf("/"))
      const base = slugify(input.title)
      const episodic = input.memoryType === "episodic"
      for (let ordinal = 1; ordinal <= 1000; ordinal += 1) {
        const candidate = `${directory}/${filenameFor({
          slug: withCollisionOrdinal(base, ordinal),
          episodic,
          at: input.at
        })}`
        if (claimed.has(candidate)) continue
        if ((yield* readFileOrNull(absolute(candidate))) === null) return candidate
      }
      return yield* Effect.fail(StorageFailure.make({ operation: "write.pathExhausted" }))
    })

  /** Write bytes, creating the parent directory. Git will not create it, and neither will `mv`. */
  const writeFileAt = (path: string, html: string): Effect.Effect<void, StorageFailure> =>
    attemptIo(`write:${path}`, async () => {
      const { mkdir, writeFile } = await import("node:fs/promises")
      const { dirname } = await import("node:path")
      await mkdir(dirname(absolute(path)), { recursive: true })
      await writeFile(absolute(path), html, "utf8")
    })

  const readRaw = (path: string): Effect.Effect<string, PathNotFound | StorageFailure> =>
    Effect.gen(function* () {
      const normalized = normalizePath(path)
      const html = yield* readFileOrNull(absolute(normalized))
      return html === null ? yield* Effect.fail(PathNotFound.make({ path: normalized })) : html
    })

  /**
   * Move a file to its archive path with the archive stamps applied, staged but not committed.
   * The caller commits, which is what lets a correction put the new file and the archived one
   * in one commit.
   */
  const stageArchive = (
    path: string,
    at: number,
    stamps: ReadonlyArray<readonly [string, string]>
  ): Effect.Effect<string, StoreError> =>
    Effect.gen(function* () {
      const normalized = normalizePath(path)
      const html = yield* readRaw(normalized)
      const target = archivePathFor(normalized, yearOf(at))

      // `git mv` refuses a destination whose parent does not exist — probed live 2026-08-02:
      // `fatal: renaming … failed: No such file or directory`. The year partition is new every
      // January, so this is not a rare path.
      yield* attemptIo(`archive.mkdir:${target}`, async () => {
        const { mkdir } = await import("node:fs/promises")
        const { dirname } = await import("node:path")
        await mkdir(dirname(absolute(target)), { recursive: true })
      })
      yield* git.mv(normalized, target)

      // The head edits go through `setMeta`, never parse→serialize: the editors splice by
      // source offset, so the article's bytes — and therefore the content hash and the dedupe
      // key — cannot move on a bookkeeping pass.
      let stamped = html
      for (const [name, value] of stamps) stamped = setMeta(stamped, name, value)
      if (stamped !== html) yield* writeFileAt(target, stamped)
      yield* git.add([target])
      yield* (hooks.onMove ?? (() => Effect.void))(normalized, target)
      return target
    })

  /** The `<link href>` document-reference form of a git-tree path. */
  const hrefFor = (path: string): string => `/${normalizePath(path)}`

  /**
   * A winner's valid-from moment: its explicit `memhtml-valid-from`, else its first
   * `<time datetime>` event time, else the operation's own instant. The coalesce order mirrors
   * the recency arm's `coalesce(event_at, updated_at)`: an explicit statement of validity beats
   * an event time, and an event time beats "whenever the supersede happened to run".
   *
   * The parse runs on bytes already read — before any staging — so a winner the format refuses
   * fails the whole operation typed, with the tree byte-identical. Validity stamping rides inside
   * the supersede's one commit and shares its all-or-nothing refusal; there is no degraded path
   * where the archive lands and the window does not.
   */
  const validFromOf = (html: string, fallback: string): Effect.Effect<string, InvalidMemory> =>
    Effect.gen(function* () {
      const explicit = readMeta(html, "memhtml-valid-from")
      if (explicit !== undefined) return explicit
      const doc = yield* parseMemory(html)
      return doc.article.eventAt ?? fallback
    })

  /**
   * The loser's `memhtml-valid-until` stamp, min-wins: the fact stopped being true at the EARLIER
   * of its own stated bound and the winner's valid-from — a fact cannot outlive its earliest
   * stated bound, so a pre-existing earlier value is kept and no stamp is emitted. These columns
   * compare lexicographically as strings by design (0008_tasks.sql), so `<` is the comparison.
   */
  const validUntilStampFor = (
    loserHtml: string,
    winnerValidFrom: string
  ): ReadonlyArray<readonly [string, string]> => {
    const existing = readMeta(loserHtml, "memhtml-valid-until")
    if (existing !== undefined && existing !== "" && existing < winnerValidFrom) return []
    return [["memhtml-valid-until", winnerValidFrom]]
  }

  /**
   * Render a file's bytes from a write input, with provenance in the head and the content hash
   * already stamped. `renderTemplate` computes the hash from the article it just built, so the
   * file that reaches disk agrees with the indexer's own recomputation on the first read.
   */
  const renderFor = (input: WriteInput, at: string): string => renderTemplate({ ...input, at })

  /**
   * Render, then REFUSE the bytes if `checkMemory` reports a violation. Every write and every
   * correction goes through here.
   *
   * The gate exists because `articleHtml` hands the caller the article verbatim
   * (`packages/html/src/template.ts:88-101`), and a caller that omits the `<mark>` — or reaches
   * for a forbidden element — produces a file the format rejects. Without this, that file lands
   * in a commit and the indexer then declines to project it: present in the tree, absent from
   * every search, visible only as a log line. The claim/body path cannot trip the gate, since
   * the template places the `<mark>` itself; running it unconditionally anyway costs one parse
   * and means no future template change can quietly reintroduce the same class of file.
   *
   * Checked BEFORE the file is written, staged, or committed, for the same reason the dedupe
   * question is asked first: a refusal leaves the tree byte-identical, with nothing to roll back.
   * `correctMemory`'s `addLink` runs after this — the link is head-plane and no article
   * constraint can see it, so gating the pre-link bytes checks everything a check could reach.
   */
  const renderChecked = (input: WriteInput, at: string): Effect.Effect<string, InvalidMemory> =>
    Effect.suspend(() => {
      const html = renderFor(input, at)
      const { violations } = checkMemory(html)
      return violations.length > 0
        ? Effect.fail(InvalidMemory.make({ reason: violations.join(VIOLATION_SEPARATOR) }))
        : Effect.succeed(html)
    })

  const writeMemory = (input: WriteInput): Effect.Effect<WriteResult, StoreError> =>
    Effect.gen(function* () {
      const millis = yield* now
      const at = isoSecond(millis)
      const html = yield* renderChecked(input, at)
      const hash = contentHash(html)

      // The dedupe question is asked BEFORE any file is written, so a duplicate leaves the
      // tree byte-identical: no file, no stage, no commit, nothing for the next `git status`
      // to report. A write-then-check order would need a rollback, and a rollback of a git
      // operation is a second failure mode.
      const existing = yield* (hooks.dedupeLookup ?? (() => Effect.succeed(null)))(hash)
      if (existing !== null) {
        return {
          path: existing,
          created: false,
          deduped: true,
          existingPath: existing,
          commitSha: null,
          contentHash: hash
        }
      }

      const path = yield* freePathFor({
        title: input.title,
        memoryType: input.memoryType,
        at: new Date(millis),
        path: input.path,
        workspace: input.workspace,
        entities: input.entities,
        tags: input.tags
      })

      yield* writeFileAt(path, html)
      yield* git.add([path])
      const commit = yield* git.commit(commitSubject("write", input.title), {
        trailers: provenanceTrailers(input)
      })
      return {
        path,
        created: true,
        deduped: false,
        commitSha: commit.sha,
        contentHash: hash
      }
    }).pipe(Effect.withSpan("store.writeMemory"))

  /**
   * Undo a partial batch: unstage every path the batch claimed and remove the files it wrote.
   *
   * `git reset -- <paths>` rather than `git rm --cached -- <paths>`. Probed live 2026-08-04: `rm
   * --cached` exits 128 with `fatal: pathspec … did not match any files` as soon as ONE path in the
   * list was never staged — which is precisely the state a `git.add` that failed part-way leaves,
   * so the rollback would fail on exactly the input it exists for. `reset` exits 0 for an unstaged
   * path and exits 0 against an unborn HEAD, both verified.
   *
   * The unlink is second and unconditional, because a file that was written but never staged is
   * invisible to git and would otherwise survive the rollback as an untracked file — which is not a
   * byte-identical tree.
   */
  const rollbackBatch = (paths: ReadonlyArray<string>): Effect.Effect<void, StoreError> =>
    Effect.gen(function* () {
      if (paths.length === 0) return
      yield* git.run(["reset", "-q", "--", ...paths])
      yield* attemptIo("batch.rollback", async () => {
        const { rm } = await import("node:fs/promises")
        for (const path of paths) await rm(absolute(path), { force: true })
      })
    })

  /**
   * Validate one op against the batch's FOLDED state, answering either the pending write it earned
   * or the result that ends it.
   *
   * The three stages are the singular write's first three, in the same order and for the same
   * reason: the render gate refuses bad bytes before anything is written, the dedupe question is
   * asked before a path is claimed, and only then does a path get taken. The differences are both
   * about the fold — the dedupe question is asked of THIS batch first and the store second, and the
   * path claim consults the batch's own claimed set.
   */
  const validateOp = (
    input: WriteInput,
    index: number,
    at: string,
    millis: number,
    batchHashes: ReadonlyMap<string, string>,
    claimed: ReadonlySet<string>
  ): Effect.Effect<
    { readonly pending: PendingWrite } | { readonly result: BatchOpResult },
    StorageFailure | GitFailure
  > =>
    Effect.gen(function* () {
      // AC-6-8: the render gate, per op, never bypassed. The failure is a per-op result rather
      // than an error channel value, so a continue-mode batch reports it in place.
      const rendered = yield* Effect.result(renderChecked(input, at))
      if (rendered._tag === "Failure") {
        return { result: { index, ok: false, error: rendered.failure } }
      }
      const html = rendered.success
      const hash = contentHash(html)

      /**
       * The batch's OWN accepted hashes first, then the store's. Order matters: the store's lookup
       * reads the index, which does not yet know about anything this batch wrote, so consulting it
       * alone would let two identical ops in one batch both be written. Neither oracle applies to a
       * task — see {@link DEDUPE_EXEMPT_TYPE}.
       */
      const exempt = !dedupable(input)
      const inBatch = exempt ? undefined : batchHashes.get(hash)
      if (inBatch !== undefined) {
        return {
          result: {
            index,
            ok: true,
            path: inBatch,
            deduped: true,
            existingPath: inBatch,
            contentHash: hash
          }
        }
      }
      const existing = exempt
        ? null
        : yield* (hooks.dedupeLookup ?? (() => Effect.succeed(null)))(hash)
      if (existing !== null) {
        return {
          result: {
            index,
            ok: true,
            path: existing,
            deduped: true,
            existingPath: existing,
            contentHash: hash
          }
        }
      }

      const path = yield* freePathFor(
        {
          title: input.title,
          memoryType: input.memoryType,
          at: new Date(millis),
          path: input.path,
          workspace: input.workspace,
          entities: input.entities,
          tags: input.tags
        },
        claimed
      )
      return { pending: { index, path, html, input, contentHash: hash } }
    })

  /** The counts, derived from the results in one pass so they cannot disagree with them. */
  const summarize = (
    results: ReadonlyArray<BatchOpResult>
  ): BatchWriteResult["summary"] & { readonly total: number } => {
    let written = 0
    let deduped = 0
    let failed = 0
    let skipped = 0
    for (const result of results) {
      if (result.skipped === true) skipped += 1
      else if (!result.ok) failed += 1
      else if (result.deduped === true) deduped += 1
      else written += 1
    }
    return { total: results.length, written, deduped, failed, skipped }
  }

  const writeMemories = (
    inputs: ReadonlyArray<WriteInput>,
    options: { readonly continueOnError?: boolean | undefined } = {}
  ): Effect.Effect<BatchWriteResult, StoreError> =>
    Effect.gen(function* () {
      const continueOnError = options.continueOnError === true
      const millis = yield* now
      const at = isoSecond(millis)

      /**
       * One instant for the whole batch, taken once. A per-op clock read would give two episodic
       * ops written either side of midnight different date prefixes — and worse, would make the
       * batch's `memhtml-created` stamps disagree about when one indivisible operation happened.
       */
      const results: Array<BatchOpResult | undefined> = inputs.map(() => undefined)
      const pending: Array<PendingWrite> = []
      const batchHashes = new Map<string, string>()
      const claimed = new Set<string>()
      let aborted = false

      /**
       * Fold one accepted op's `(hash, path)` into the batch's own dedupe oracle, through the SAME
       * {@link dedupable} predicate the reads use — so the carve-out cannot hold in one direction
       * and not the other.
       */
      const remember = (input: WriteInput, hash: string, path: string): void => {
        if (dedupable(input)) batchHashes.set(hash, path)
      }

      // Phase 1 — validate everything, write nothing. This is the atomicity mechanism (D2): an
      // atomic abort happens here, before any file exists, so there is nothing to roll back.
      for (const [index, input] of inputs.entries()) {
        const outcome = yield* validateOp(input, index, at, millis, batchHashes, claimed)
        if ("result" in outcome) {
          results[index] = outcome.result
          if (outcome.result.ok) {
            // A dedupe is not a failure, and it contributes its hash so a THIRD identical op in the
            // same batch resolves to the same path rather than being written.
            if (outcome.result.contentHash !== undefined && outcome.result.path !== undefined) {
              remember(input, outcome.result.contentHash, outcome.result.path)
            }
            continue
          }
          if (!continueOnError) {
            aborted = true
            break
          }
          continue
        }
        pending.push(outcome.pending)
        claimed.add(outcome.pending.path)
        remember(input, outcome.pending.contentHash, outcome.pending.path)
      }

      /**
       * An atomic abort: every op other than the failed one reports `skipped`, INCLUDING the ones
       * that already validated. Nothing was written, so reporting an earlier op as `ok` with a path
       * would hand the caller a path with no file behind it — the same lie `freePathFor` refuses to
       * tell about an explicit path override.
       */
      if (aborted) {
        const final = results.map((result, index) =>
          result !== undefined && !result.ok && result.skipped !== true
            ? result
            : ({ index, ok: false, skipped: true } satisfies BatchOpResult)
        )
        return {
          results: final,
          summary: summarize(final),
          commitSha: null,
          writtenPaths: []
        }
      }

      // Phase 2 — one write pass, one stage, one commit. Every path here has been validated and
      // claimed, so nothing in this phase can be refused on the batch's own terms.
      if (pending.length === 0) {
        const final = results.map(
          (result, index) => result ?? ({ index, ok: false, skipped: true } satisfies BatchOpResult)
        )
        return { results: final, summary: summarize(final), commitSha: null, writtenPaths: [] }
      }

      const paths = pending.map((entry) => entry.path)
      const commit = yield* Effect.gen(function* () {
        for (const entry of pending) yield* writeFileAt(entry.path, entry.html)
        yield* git.add(paths)
        return yield* git.commit(commitSubject("batch", subjectFor(pending)), {
          // The trailers come from the FIRST op that carries provenance. A batch is one commit, so
          // it gets one `Memhtml-Session` — and every op's own `memhtml-session` head meta is already in
          // its file, which is where per-op provenance lives.
          trailers: provenanceTrailers(pending.find(hasProvenance)?.input ?? {})
        })
      }).pipe(
        /**
         * A failure anywhere in the write/stage/commit sequence rolls the whole batch back and
         * re-fails. The observable contract is the same as an atomic abort's — a byte-identical
         * tree — so the mechanism has to cover the case where SOME files exist and SOME are staged.
         */
        Effect.tapError(() => rollbackBatch(paths))
      )

      const final = results.map((result, index) => {
        if (result !== undefined) return result
        const entry = pending.find((candidate) => candidate.index === index)
        return entry === undefined
          ? ({ index, ok: false, skipped: true } satisfies BatchOpResult)
          : ({
              index,
              ok: true,
              path: entry.path,
              deduped: false,
              contentHash: entry.contentHash
            } satisfies BatchOpResult)
      })
      return {
        results: final,
        summary: summarize(final),
        commitSha: commit.sha,
        writtenPaths: paths
      }
    }).pipe(Effect.withSpan("store.writeMemories"))

  const readMemory = (path: string): Effect.Effect<ReadResult, StoreError> =>
    Effect.gen(function* () {
      const normalized = normalizePath(path)
      const html = yield* readRaw(normalized)
      const doc = yield* parseMemory(html)
      return { path: normalized, html, doc }
    }).pipe(Effect.withSpan("store.readMemory"))

  const correctMemory = (
    target: string,
    input: WriteInput & { readonly reason?: string | undefined }
  ): Effect.Effect<CorrectResult, StoreError> =>
    Effect.gen(function* () {
      const millis = yield* now
      const at = isoSecond(millis)
      const normalizedTarget = normalizePath(target)
      // Read first: a correction of a path with no file behind it must fail before anything is
      // written, or the tree gains an orphan superseding file with nothing to supersede.
      const targetHtml = yield* readRaw(normalizedTarget)

      const archivePath = archivePathFor(normalizedTarget, yearOf(millis))
      const html = yield* renderChecked(input, at)
      const hash = contentHash(html)
      /**
       * The validity hand-off, `supersedeMemories`' exact rule: the correction's valid-from is its
       * explicit meta, else its first `<time datetime>`, else now — the target was valid over
       * [its own valid-from|created, that moment), min-wins against any earlier bound it already
       * states. Stamped inside this one commit, so it shares the correction's refusal.
       */
      const validFrom = yield* validFromOf(html, at)

      const path = yield* freePathFor({
        title: input.title,
        memoryType: input.memoryType,
        at: new Date(millis),
        path: input.path,
        workspace: input.workspace,
        entities: input.entities,
        tags: input.tags
      })
      // The supersedes link points at the target's ARCHIVE path, which is where the file will
      // be once this commit lands. Pointing at the pre-archive path would create a dangling
      // href in the same commit that made it dangle.
      const linked = addLink(html, "supersedes", hrefFor(archivePath))
      yield* writeFileAt(
        path,
        readMeta(linked, "memhtml-valid-from") === undefined
          ? setMeta(linked, "memhtml-valid-from", validFrom)
          : linked
      )
      yield* git.add([path])

      const archivedPath = yield* stageArchive(normalizedTarget, millis, [
        ["memhtml-status", "archived"],
        ["memhtml-updated", at],
        ["memhtml-archived", at],
        ["memhtml-superseded-by", hrefFor(path)],
        ...validUntilStampFor(targetHtml, validFrom)
      ])

      const commit = yield* git.commit(commitSubject("correct", input.title), {
        trailers: provenanceTrailers(input)
      })
      return { path, archivedPath, commitSha: commit.sha, contentHash: hash }
    }).pipe(Effect.withSpan("store.correctMemory"))

  const archiveMemory = (path: string, reason: string): Effect.Effect<ArchiveResult, StoreError> =>
    Effect.gen(function* () {
      const millis = yield* now
      const at = isoSecond(millis)
      const normalized = normalizePath(path)
      const archivePath = yield* stageArchive(normalized, millis, [
        ["memhtml-status", "archived"],
        ["memhtml-updated", at],
        ["memhtml-archived", at]
      ])
      const commit = yield* git.commit(commitSubject("archive", `${normalized} — ${reason}`))
      return { path: normalized, archivePath, commitSha: commit.sha }
    }).pipe(Effect.withSpan("store.archiveMemory"))

  const supersedeMemories = (
    pairs: ReadonlyArray<{ readonly winnerPath: string; readonly loserPath: string }>
  ): Effect.Effect<SupersedeResult, StoreError> =>
    Effect.gen(function* () {
      // No pairs, no commit: touching git for an empty consolidation would put a commit in the
      // history that changed nothing, and `commitSha: null` already means "nothing happened".
      if (pairs.length === 0) return { commitSha: null, archived: [] }

      const millis = yield* now
      const at = isoSecond(millis)
      const normalized = pairs.map((pair) => ({
        winner: normalizePath(pair.winnerPath),
        loser: normalizePath(pair.loserPath)
      }))

      // EVERY endpoint is read before ANY staging, so one missing path refuses the whole call
      // with the tree byte-identical — the same order correctMemory reads its target first, and
      // the winners' bytes are what the link edits below splice into, so the reads are also the
      // inputs. Winners are read into a map because two pairs may share one winner. The winners'
      // valid-from moments are computed here too — the parse can refuse, and a refusal must land
      // before any staging for the same byte-identical reason.
      const winnerHtml = new Map<string, string>()
      const winnerValidFrom = new Map<string, string>()
      const loserHtml = new Map<string, string>()
      for (const pair of normalized) {
        if (!winnerHtml.has(pair.winner)) {
          const html = yield* readRaw(pair.winner)
          winnerHtml.set(pair.winner, html)
          winnerValidFrom.set(pair.winner, yield* validFromOf(html, at))
        }
        loserHtml.set(pair.loser, yield* readRaw(pair.loser))
      }

      const archived: Array<{ readonly loserPath: string; readonly archivePath: string }> = []
      for (const pair of normalized) {
        /**
         * The validity window this supersede closes: the loser was valid over
         * [its own valid-from|created, the winner's valid-from). Min-wins on a pre-existing
         * bound — a fact cannot outlive its earliest stated `memhtml-valid-until` — and the
         * winner's own valid-from is stamped below so an as-of query reads both ends of the
         * hand-off from the files rather than inferring one from the commit.
         */
        const validFrom = winnerValidFrom.get(pair.winner) ?? at
        const archivePath = yield* stageArchive(pair.loser, millis, [
          ["memhtml-status", "archived"],
          ["memhtml-updated", at],
          ["memhtml-archived", at],
          ["memhtml-superseded-by", hrefFor(pair.winner)],
          ...validUntilStampFor(loserHtml.get(pair.loser) ?? "", validFrom)
        ])
        // The supersedes link points at the loser's ARCHIVE path — where the file is once this
        // commit lands. Pointing at the pre-archive path would create a dangling href in the
        // same commit that made it dangle, correctMemory's exact rule.
        const html = winnerHtml.get(pair.winner) ?? (yield* readRaw(pair.winner))
        const linked = addLink(html, "supersedes", hrefFor(archivePath))
        const stamped =
          readMeta(linked, "memhtml-valid-from") === undefined
            ? setMeta(linked, "memhtml-valid-from", validFrom)
            : linked
        if (stamped !== html) {
          winnerHtml.set(pair.winner, stamped)
          yield* writeFileAt(pair.winner, stamped)
          yield* git.add([pair.winner])
        }
        archived.push({ loserPath: pair.loser, archivePath })
      }

      const subject =
        normalized.length === 1 && normalized[0] !== undefined
          ? `${normalized[0].winner} supersedes ${normalized[0].loser}`
          : `${normalized.length} memories superseded`
      const commit = yield* git.commit(commitSubject("consolidate", subject))
      return { commitSha: commit.sha, archived }
    }).pipe(Effect.withSpan("store.supersedeMemories"))

  /**
   * Refuse an edge whose class disagrees with its endpoints' types.
   *
   * The `edges` CHECK constraints pair a rel with its CLASS, and nothing in SQL can pair a class
   * with the TYPE of the files at either end — so this is the only place the task/memory graph
   * separation can be enforced on the way in. Enforced here rather than at the CLI because the
   * store is the single write path: both the CLI and any future caller reach the corpus through it.
   *
   * Both directions are refusals, and each has its own failure mode. A memory-class rel with a task
   * endpoint puts a work item into PageRank, MMR, and the retention bridge count, where a to-do
   * list would reweight the retention of knowledge. A task-class rel with a memory endpoint claims
   * a memory `blocks` something, which nothing advances and nothing can close.
   *
   * Provenance rels are unaffected: a task legitimately came from a session, and `from_session`
   * points at a trace rather than at a memory file, so neither endpoint rule applies.
   */
  const requireEndpointClasses = (
    rel: EdgeRel,
    src: string,
    dst: string
  ): Effect.Effect<void, StoreError> =>
    Effect.gen(function* () {
      const edgeClass = relClassFor(rel)
      if (edgeClass !== "memory" && edgeClass !== "task") return

      const srcType = yield* typeOf(src)
      const dstType = yield* typeOf(dst)

      if (edgeClass === "memory") {
        const offender = srcType === "task" ? src : dstType === "task" ? dst : undefined
        if (offender !== undefined) {
          return yield* Effect.fail(
            InvalidMemory.make({
              reason: `${rel} is a memory rel and ${offender} is a task: a task never enters the memory graph`
            })
          )
        }
        return
      }

      const offender = srcType !== "task" ? src : dstType !== "task" ? dst : undefined
      if (offender !== undefined) {
        return yield* Effect.fail(
          InvalidMemory.make({
            reason: `${rel} is a task rel and ${offender} is not a task: both endpoints must be tasks`
          })
        )
      }
    })

  /**
   * The `memhtml-type` of the file at a path.
   *
   * Read with the head editor rather than `parseMemory`: a link between two valid files must not
   * fail because a THIRD constraint is violated somewhere in one of their articles, and the type is
   * a head meta the editors read without parsing the document.
   */
  const typeOf = (path: string): Effect.Effect<string | undefined, StoreError> =>
    readRaw(path).pipe(Effect.map((html) => readMeta(html, "memhtml-type")))

  const linkMemories = (
    srcPath: string,
    rel: EdgeRel,
    dstPath: string
  ): Effect.Effect<{ readonly commitSha: string | null }, StoreError> =>
    Effect.gen(function* () {
      const src = normalizePath(srcPath)
      const dst = normalizePath(dstPath)
      if (src === dst) {
        return yield* Effect.fail(
          InvalidMemory.make({ reason: `a memory cannot link to itself: ${src}` })
        )
      }
      // Before any write: a refused link leaves the tree byte-identical, with nothing to unstage.
      yield* requireEndpointClasses(rel, src, dst)
      const html = yield* readRaw(src)
      const linked = addLink(html, rel, hrefFor(dst))
      // `addLink` is idempotent on the `(rel, href)` pair, so a re-run writes nothing and
      // commits nothing — which is what makes the sleep conflict phase's repeated promotion of
      // one corroborated edge cost one commit in total rather than one per night.
      if (linked === html) return { commitSha: null }
      yield* writeFileAt(src, linked)
      yield* git.add([src])
      const commit = yield* git.commit(commitSubject("link", `${rel} ${src} -> ${dst}`))
      return { commitSha: commit.sha }
    }).pipe(Effect.withSpan("store.linkMemories"))

  const dirtyPaths = (): Effect.Effect<ReadonlyArray<string>, StoreError> =>
    git
      .statusPorcelainV2()
      .pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) => (entry.kind === "ignored" ? [] : [entry.path]))
        )
      )

  const requireCleanTree = (): Effect.Effect<void, StoreError> =>
    Effect.gen(function* () {
      const paths = yield* dirtyPaths()
      if (paths.length > 0) return yield* Effect.fail(DirtyTree.make({ paths }))
    })

  const mergeBranch = (commitish: string): Effect.Effect<void, StoreError> =>
    Effect.gen(function* () {
      const outcome = yield* git.merge(commitish)
      if (outcome.merged) return

      // A conflict is where `WriteConflict` comes from, and the index is the only place the
      // two competing blob shas exist: stage 2 is ours, stage 3 is theirs. Reading them before
      // the abort is mandatory — `merge --abort` discards the unmerged index.
      const stages = yield* git.unmergedStages()
      const conflicted = outcome.conflicted[0] ?? stages[0]?.path ?? commitish
      const ours = stages.find((stage) => stage.path === conflicted && stage.stage === 2)
      const theirs = stages.find((stage) => stage.path === conflicted && stage.stage === 3)
      yield* git.mergeAbort()
      return yield* Effect.fail(
        WriteConflict.make({
          path: conflicted,
          ourSha: ours?.sha ?? "",
          theirSha: theirs?.sha ?? ""
        })
      )
    }).pipe(Effect.withSpan("store.mergeBranch"))

  return {
    root: git.root,
    git,
    writeMemory,
    writeMemories,
    readMemory,
    correctMemory,
    archiveMemory,
    supersedeMemories,
    linkMemories,
    dirtyPaths,
    requireCleanTree,
    mergeBranch
  }
}

/**
 * The live store, rooted at `MEMHTML_ROOT`. The hooks are absent here on purpose: `dedupeLookup`
 * needs a database and `onMove` needs the state plane, both of which live one layer out — a
 * store layer that reached for them would invert the dependency direction and drag SQL into
 * this package. T7 composes `makeStore(makeGit(root), { dedupeLookup, onMove })` instead.
 */
export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const root = yield* MemhtmlRootConfig
    return makeStore(makeGit(root))
  })
)

/** The git layer for the configured root, for a caller that wants plumbing without the store. */
export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const root = yield* MemhtmlRootConfig
    return makeGit(root)
  })
)
