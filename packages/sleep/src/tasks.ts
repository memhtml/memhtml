import { createHash } from "node:crypto"

import type { StorageFailure } from "@memhtml/contracts/errors"
import { placementFor } from "@memhtml/contracts/paths"
import { SLUG_FALLBACK, SLUG_MAX_LENGTH, slugify } from "@memhtml/contracts/slug"
import { frameKeyOf } from "@memhtml/domain"
import {
  escapeAttribute,
  escapeText,
  isValidDatetime,
  parseMemory,
  renderTemplate
} from "@memhtml/html"
import { attemptIo, type GitFailure } from "@memhtml/store"
import { Effect } from "effect"

import {
  absoluteIn,
  archiveFile,
  hrefFor,
  meta,
  readFileBytes,
  stampFile,
  writeFileBytes
} from "./edits.js"
import type { PhaseEnv } from "./env.js"

/**
 * The minting discipline for a DETECTED task: one home for idempotence, evidence verification, the
 * nightly cap, and self-cleaning.
 *
 * Issue #44's shape is three detection surfaces sharing one discipline. The surfaces differ in what
 * they notice — a review band entity-resolution declined to merge, a near-duplicate pair the
 * divergence veto refused, a commitment a model found in a memory's own prose — and they agree on
 * everything that happens after: the finding becomes a `task` file authored `agent:sleep`, keyed on a
 * stable digest so a second night refreshes rather than duplicates, carrying its evidence verbatim,
 * inside a nightly volume cap, and closed when the finding stops appearing. That agreement is what
 * lives here. A copy of it per surface would be three chances to mint a task nobody can trust.
 *
 * ## A detected task is a `task`, and inherits every firewall by being one
 *
 * Nothing below teaches sleep about a new kind of file. `task` is already a memory type with its own
 * lifecycle (`todo/doing/blocked/done`, and `done` archives), its own edge class, its own placement
 * rule, and — the part that matters here — a standing exclusion from every sleep phase
 * (`SLEEP_EXCLUDED_TYPES`), from retrieval by default, from the salience arm, and from the
 * `files_content_hash_active` dedup index. So a file this module writes is invisible to dedup,
 * compress, retention, edge typing, entity resolution, and person links from the moment it lands,
 * with no phase needing to learn about it. That is the whole reason detection mints a task instead of
 * a new artifact class.
 *
 * ## The KEY is the path, not a meta and not the content hash
 *
 * A detected task's idempotence surface is its PATH: `areas/inbox/tasks/det-<12 hex>-<slug>.html`,
 * where the digest is {@link detectionKey} over the detector's name and a canonical finding string.
 * Three properties follow, and each is why the alternatives were declined:
 *
 * - **Not the content hash.** `files_content_hash_active` deliberately carves out open tasks — two
 *   open tasks with identical bodies are two real work items — so the structural dedup key cannot
 *   answer "have I already minted this finding". A detection that relied on it would mint a second
 *   task every night and the index would admit every one of them.
 * - **Not a new `memhtml-detection` meta.** The meta vocabulary is CLOSED and ordered
 *   (`packages/html/src/vocabulary.ts`), so a new name is a format change plus a parse change plus a
 *   projection plus a migration plus an index, and the lookup it would buy is a lookup the path
 *   already answers. A path also survives `rm index.db && rebuild` with no projection at all, which a
 *   queryable column does not.
 * - **Collision-free by construction.** Every stem begins with a distinct digest, so two different
 *   findings cannot land on one path however their titles slug. This module therefore needs none of
 *   the ordinal-suffix search `trace-consolidation`'s `freePath` performs, and cannot silently
 *   overwrite a file the way that probe exists to prevent: a path that is already taken is BY
 *   DEFINITION the same finding, which is the refresh case rather than a collision.
 *
 * ## The TREE is read, never the index
 *
 * Every lookup here is a `readdir` plus a file read under {@link DETECTED_TASK_DIR}. The index is
 * refreshed once, in preflight, and not again, so a task minted earlier in the same night is absent
 * from it — and two detectors reaching one finding in one night is exactly the case idempotence has
 * to cover. Reading the tree makes a mint see the mints before it. The cost is bounded by
 * {@link DETECTED_TASK_CAP} reads of one directory per phase, because self-cleaning keeps that
 * directory the size of the OPEN detected queue rather than of the corpus.
 *
 * ## What the code verifies, and what it cannot
 *
 * A quote is checked against the cited file's own article text and a mint whose quote is not there is
 * REFUSED ({@link mintDetectedTask} answers `unverified`). That is the issue's "proposal with
 * evidence, never an assertion", enforced rather than asked for: the one detector whose evidence a
 * model supplies is surface 3, and a fabricated sentence must not reach a file a human then reads as
 * a citation.
 *
 * A MEASUREMENT is a different thing and {@link DetectionEvidence} says so in the type. The evidence
 * behind an entity-resolution review candidate is a character-similarity ratio and two file counts —
 * a fact about the corpus that no sentence anywhere states — so there is nothing to verify it
 * against, and pretending otherwise by quoting an arbitrary claiming memory would manufacture a
 * citation to satisfy a check. The union keeps the difference visible at every call site instead of
 * leaving it to convention.
 *
 * A SESSION is the third, and it is the one place issue #44's "body must quote its source verbatim"
 * is deliberately NOT satisfied, because a stronger invariant refuses it. Surface 2's evidence is a
 * transcript line, and `.memhtml` holds no session content: the trace plane is a read-only index over
 * `~/.claude/projects`, and `phases/trace-consolidation.ts` states — with a byte-level test behind it —
 * that a distilled claim reaches the corpus and its verbatim quote does not. A quote copied into a
 * task body would be exactly the leak that test exists to catch. So the `session` arm carries the
 * session ID and no quote: the ID becomes a `memhtml-session` stamp (a projected column, so
 * `files.session_id` answers "which session opened this"), the body names the session as the place to
 * look, and the verbatim line goes where every other trace-consolidation quote goes, into the COMMIT
 * MESSAGE, which is not indexed, not chunked, not embedded, and not retrievable.
 *
 * What verifies a `session` quote is therefore not code in this file but the client boundary:
 * `ungroundedCommitmentReason` (`apps/consolidator/src/contract.ts`) refuses the whole turn when a
 * commitment cites a session the run did not make readable, and the phase additionally drops a
 * commitment whose session is outside the batch it asked about. Re-verifying the quote against
 * transcript bytes here was considered and declined: it would require `MEMHTML_TRACE_ROOT` in
 * `PhaseEnv`, which `consolidator.ts` records as the thing deliberately kept out of the environment
 * all sixteen phases share, and it would buy a check against a file that may have rotated away since
 * the consolidator read it.
 */

/**
 * Where a detected task lands: the ordinary task placement, asked of `@memhtml/contracts` rather than
 * retyped.
 *
 * A detected task is an ordinary task and files where one files. `placementFor` routes a workspaceless
 * task to `areas/inbox/tasks`, and `memhtml doctor` reports inbox depth, so a noisy detector shows up
 * as a health signal on the surface built to carry one. A parallel `detected/` tree would be a second
 * place to look for the same work and would sit outside the four PARA buckets the indexer reads.
 */
export const DETECTED_TASK_DIR = placementFor({ memoryType: "task" })

/** The filename prefix that makes a detected task recognizable from its path alone. */
export const DETECTION_PREFIX = "det-"

/**
 * Hex characters of the digest carried in a path.
 *
 * Twelve, which is git's own abbreviated-sha width and the same width the report renderer prints. It
 * leaves 48 bits against a queue whose size the cap and the sweep hold in the tens, and it costs 17
 * characters of the 80-character slug budget rather than 68.
 */
export const DETECTION_DIGEST_CHARS = 12

/** The tag every detected task carries first, so `task list` can filter the machine's queue. */
export const DETECTED_TAG = "detected"

/**
 * Detected tasks one night may mint, across every detector.
 *
 * Ten, from issue #44 verbatim: "a noisy detector that mints 200 tasks destroys the working set it
 * exists to serve". The budget is SHARED rather than per-detector, because the number a human can
 * review is a property of the human and not of how many detectors sleep happens to run. Overflow is
 * counted, never silently dropped — a detector pressing against the cap every night is a detector
 * whose threshold is wrong, and that is only visible in the counts.
 *
 * A REFRESH costs nothing. The cap bounds new work arriving in the queue, and re-stamping a task a
 * human has already been shown adds none.
 */
export const DETECTED_TASK_CAP = 10

/** Characters of a detected task's title. The same 90 a distilled memory's title is cut to. */
const TITLE_CHARS = 90

/**
 * The slug budget left for a title once the prefix and digest are spent.
 *
 * Derived, not chosen, so the two cannot drift into a stem that breaches `SLUG_MAX_LENGTH` — which
 * `isSlug` rejects, and every other path in the corpus satisfies it.
 */
const STEM_SLUG_CHARS = SLUG_MAX_LENGTH - DETECTION_PREFIX.length - DETECTION_DIGEST_CHARS - 1

/**
 * A finding's stable key: `det-<12 hex>` over the detector's name and a canonical finding string.
 *
 * The finding string is the CALLER's canonical form of what it noticed — an entity type plus two
 * sorted names, two sorted paths, a rel plus two sorted paths — and sorting is the caller's job
 * because only the caller knows which of its fields are unordered. What this adds is the
 * normalization every caller would otherwise repeat: NFC, lowercase, collapsed whitespace. So a
 * finding restated with different spacing on a later night keys the same, and a night that saw
 * `(a, b)` keys with a night that saw `(b, a)` provided the caller sorted.
 *
 * The detector's name is INSIDE the digest, so two detectors that happen to canonicalize one finding
 * identically still own separate tasks. They noticed different things about it, and a sweep is
 * per-detector: sharing a key would let one detector's sweep close the other's task.
 */
export const detectionKey = (detector: string, finding: string): string =>
  `${DETECTION_PREFIX}${createHash("sha256")
    .update(`${normalizeFinding(detector)} ${normalizeFinding(finding)}`, "utf8")
    .digest("hex")
    .slice(0, DETECTION_DIGEST_CHARS)}`

/** NFC, lowercase, collapsed whitespace, trimmed. The pre-digest form. */
const normalizeFinding = (text: string): string =>
  text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

/** The path a key and a title name. Total, and unique per key whatever the title slugs to. */
export const detectedTaskPath = (key: string, title: string): string => {
  const stem = slugify(title).slice(0, STEM_SLUG_CHARS).replace(/-+$/, "")
  return `${DETECTED_TASK_DIR}/${key}-${stem === "" ? SLUG_FALLBACK : stem}.html`
}

/** The key a detected task's path carries, or `undefined` when the path is not one. */
export const detectionKeyOf = (path: string): string | undefined => {
  const filename = path.slice(path.lastIndexOf("/") + 1)
  const match = new RegExp(
    `^(${DETECTION_PREFIX}[0-9a-f]{${String(DETECTION_DIGEST_CHARS)}})-`
  ).exec(filename)
  return match?.[1]
}

/** True when a path is a detected task's. The self-scan guard surface-3 reads. */
export const isDetectedTaskPath = (path: string): boolean => detectionKeyOf(path) !== undefined

/**
 * One night's shared minting budget: how many new tasks are left, and how many findings were turned
 * away.
 *
 * MUTABLE, and deliberately a value the run creates rather than a module-level counter. Phases run
 * sequentially in one process, so a module-level `let` would work in production and would leak
 * between test cases in the same file — the contaminating-state failure this repo has paid for
 * repeatedly. A per-run object cannot: two runs in one process hold two budgets, and a test driving
 * one phase gets its own.
 */
export interface DetectionBudget {
  remaining: number
  overflow: number
}

/** A fresh budget at the nightly cap. */
export const makeDetectionBudget = (cap: number = DETECTED_TASK_CAP): DetectionBudget => ({
  remaining: Math.max(0, Math.trunc(cap)),
  overflow: 0
})

/**
 * The run's shared budget, or a fresh one when the run did not supply it.
 *
 * `PhaseEnv.detectionBudget` is optional so the five existing construction sites keep compiling, and
 * the fallback is what makes a phase driven directly by a test behave like one inside a run: it gets
 * the full cap to itself. A caller must call this ONCE per phase invocation and thread the result,
 * because calling it per mint against an absent field would hand out a fresh cap every time.
 */
export const budgetFor = (env: PhaseEnv): DetectionBudget =>
  env.detectionBudget ?? makeDetectionBudget()

/**
 * What a detected task cites. A verified quote, or a measurement that has no source to verify
 * against.
 *
 * See the module header for why the two are separate constructors rather than one optional
 * `sourcePath`.
 */
export type DetectionEvidence =
  | {
      readonly kind: "quote"
      /** Must appear in `sourcePath`'s article text, modulo whitespace, or the mint is refused. */
      readonly quote: string
      readonly sourcePath: string
    }
  | { readonly kind: "measurement"; readonly detail: string }
  | {
      /**
       * A transcript line, cited by SESSION and carrying no quote. See the module header: the trace
       * plane's invariant is that `.memhtml` holds no session content, so the verbatim line goes into
       * the commit message and this arm carries only what may be stored.
       */
      readonly kind: "session"
      readonly sessionId: string
      /**
       * The commitment as the model RESTATED it, which is prose about the session rather than a span
       * out of it. Distinct from the verbatim quote by construction: the consolidator's contract asks
       * for `statement` and `evidence.quote` as separate fields precisely so one of them is storable.
       */
      readonly statement: string
    }

/** What {@link mintDetectedTask} is asked to write. */
export interface DetectionRequest {
  /** The detector's name. Rides into the digest and into the task's second tag. */
  readonly detector: string
  /** The caller's canonical form of what it noticed. Keyed, never rendered. */
  readonly finding: string
  /** The `<title>`, and the slug's source. Cut to 90 characters. */
  readonly title: string
  /** The one sentence that becomes the `<mark>`: the work item, stated as work. */
  readonly claim: string
  /** Optional context paragraph: the scores, counts, or predicate behind the finding. */
  readonly detail?: string | undefined
  readonly evidence: DetectionEvidence
  /** An ISO date for `memhtml-due`. A value the format would refuse is dropped, not written. */
  readonly dueHint?: string | undefined
}

/**
 * What a mint did.
 *
 * `capped` and `unverified` are counted refusals rather than failures: one bad finding must not cost
 * the phase that found it, exactly as one malformed model answer does not cost its batch's siblings.
 */
export type MintOutcome = "minted" | "refreshed" | "capped" | "unverified" | "framed"

/**
 * Mint a detected task, or refresh the one this finding already owns.
 *
 * Order matters and is stated once here, because each step's position is what makes it mean
 * something:
 *
 * 1. **The existing open detections are read from the tree.** A key already present is the refresh
 *    case, and refreshing costs no budget.
 * 2. **The evidence is verified before anything is written.** A quote absent from the file it cites
 *    refuses the whole mint. Checking after the write would leave a task in the tree asserting a
 *    citation the corpus does not support, and a later commit removing it would still be in the log.
 * 3. **The frame-key check runs against the OPEN queue only.** Two detectors describing one work
 *    item in different words key differently, so the digest cannot catch them; a shared claim slot
 *    can. It fires rarely by construction, because `frameKeyOf`'s guards fail closed on ordinary
 *    prose — which is the honest scope of this check and the reason it is the second net rather than
 *    the first.
 * 4. **The budget is spent last**, so a refusal at any earlier step does not consume a night's
 *    allowance.
 *
 * Staging only. The phase that called this commits, so a detected task lands in the SAME commit as
 * the work that found it, which is what puts it behind the discrimination gate and what makes the
 * commit reviewable as one decision.
 */
export const mintDetectedTask = (
  env: PhaseEnv,
  budget: DetectionBudget,
  request: DetectionRequest
): Effect.Effect<MintOutcome, StorageFailure | GitFailure> =>
  Effect.gen(function* () {
    const key = detectionKey(request.detector, request.finding)
    const open = yield* openDetections(env)

    const existing = open.find((detected) => detected.key === key)
    if (existing !== undefined) {
      /**
       * A second night refreshes the stamp and writes nothing else. Not the claim, not the evidence,
       * not the detail: a human may have edited the body or moved the status to `doing`, and a
       * detector overwriting that would take the queue away from the person it exists to serve.
       * `stampFile` returns false when the instant is already stamped, so a same-date re-run is free.
       */
      yield* stampFile(env, existing.path, [meta("memhtml-updated", env.at)])
      return "refreshed"
    }

    if (!(yield* evidenceHolds(env, request.evidence))) {
      yield* Effect.logWarning(
        `sleep.tasks ${request.detector} refused a mint: evidence not found in the source it cites`
      )
      return "unverified"
    }

    const frame = frameKeyOf(request.claim)
    if (frame !== null && open.some((detected) => frameKeyOf(detected.claim) === frame)) {
      return "framed"
    }

    if (budget.remaining <= 0) {
      budget.overflow += 1
      return "capped"
    }

    const title = titleOf(request.title)
    const path = detectedTaskPath(key, title)
    yield* writeFileBytes(
      env,
      path,
      renderTemplate({
        title,
        /**
         * `claim` is required by `NewMemoryInput` and UNREAD when `articleHtml` is present, since
         * `articleHtmlFor` returns the pre-authored markup verbatim. It is stated anyway rather than
         * stubbed, so the two never disagree about what this file's claim is: {@link detectedArticle}
         * builds the `<mark>` from this same value.
         */
        claim: request.claim,
        articleHtml: detectedArticle(env, request),
        memoryType: "task",
        taskStatus: "todo",
        at: env.at,
        /**
         * `agent:sleep`, which is the author separation issue #44 asks for: a human's queue and the
         * machine's are told apart by `memhtml-author` rather than by where they sit, so both live in
         * one list and `task list` can filter.
         */
        author: "agent:sleep",
        /**
         * The generic tag first and the detector second, so the pair reads as "detected, by this".
         * The ORDER is load-bearing: `memhtml-tag` is repeatable, the serializer emits repeatables in
         * the order given, and {@link openDetections} reads the detector back off the second value.
         */
        tags: [DETECTED_TAG, request.detector],
        /**
         * `from_session` provenance, per issue #44, as the ordinary `memhtml-session` meta rather than
         * anything new. It is already in the closed vocabulary, already projects to
         * `files.session_id`, and already carries exactly this meaning on a memory an agent wrote
         * during a session — so a detected task minted from a transcript answers "which session is
         * this from" through the same column every other provenance query reads. Only the `session`
         * evidence arm has one; a measurement and a corpus quote are not from a session, and stamping
         * the run's id there would make the column mean two things.
         */
        ...(request.evidence.kind === "session"
          ? { sessionId: request.evidence.sessionId.trim() }
          : {}),
        ...(dueOf(request.dueHint) === undefined ? {} : { dueAt: dueOf(request.dueHint) as string })
      })
    )
    yield* env.deps.git.add([path])
    budget.remaining -= 1
    return "minted"
  })

/**
 * Close every open detection of one detector whose key is not in `liveKeys`: stamp `done` and archive.
 *
 * Self-cleaning, per issue #44: "a finding that stops appearing closes its task with reason
 * `no longer detected`". A queue that only grows is a queue a human abandons, and the finding is the
 * only thing that can say a review is no longer wanted — the human declining to act on it cannot,
 * because that is indistinguishable from not having got to it yet.
 *
 * **`done` plus archive, matching `memhtml task status done` exactly.** `apps/cli/src/operations.ts`
 * stamps the status and then routes through `store.archiveMemory`, and this does the same two things
 * through sleep's staging discipline instead of through the store's own commit: the stamp goes on
 * first so it travels with the `git mv`, and `archiveFile` re-writes the stamped bytes at the
 * destination. `done` is not a resting state on its own; the archive tree plus `git log` is what
 * answers "what did I close".
 *
 * **The reason lives in the commit, not in a meta.** There is no `memhtml-*` name for it and the
 * vocabulary is closed, so the caller's `commitPhase` body carries `no longer detected` — which is
 * also where `store.archiveMemory` puts its own reason.
 *
 * **`liveKeys` must be every finding the detector SAW, not every finding it minted.** A finding
 * turned away by the cap is still live, and closing its task because a busy night declined to
 * refresh it would delete a real review the moment the queue got full.
 *
 * **Call this only on the night's full-strength path.** A phase that degraded — no model bound, a
 * batch whose call failed, an early return before its scan finished — did not evaluate the candidate
 * set, so its `liveKeys` describes what it managed to look at rather than what exists. Sweeping there
 * would close a human's queue every credential-free night. Each caller states the condition it
 * sweeps under.
 */
export const closeVanishedDetections = (
  env: PhaseEnv,
  detector: string,
  liveKeys: ReadonlySet<string>
): Effect.Effect<number, StorageFailure | GitFailure> =>
  Effect.gen(function* () {
    const open = yield* openDetections(env)
    let closed = 0
    for (const detected of open) {
      if (detected.detector !== detector) continue
      if (liveKeys.has(detected.key)) continue
      yield* stampFile(env, detected.path, [
        meta("memhtml-task-status", "done"),
        meta("memhtml-updated", env.at)
      ])
      const archived = yield* archiveFile(env, detected.path)
      if (archived !== null) closed += 1
    }
    return closed
  })

/**
 * Close ONE detected task by path: stamp `done` and archive, exactly as {@link closeVanishedDetections}
 * does per file. Answers `false` and writes nothing when the path is not a detected task's.
 *
 * The refusal is the point, and it is a HARD guard rather than a convention. Surface 2 closes a task
 * because a transcript says the work is done, which is a model's reading of somebody's prose — so this
 * is the one closure path whose trigger is not a fact the corpus can check. A human-opened task closed
 * on that basis is work silently taken out of somebody's queue by a sentence they did not write, and
 * `done` ARCHIVES, so the file also leaves the directory they look in. {@link isDetectedTaskPath} is
 * the discriminator because it reads the PATH: it needs no parse, no index row, and no meta, so it
 * cannot be defeated by a file whose head a model influenced.
 *
 * A caller that found its path through {@link openDetections} is already inside the guard, since that
 * function only returns detected paths. The check runs anyway, here, at the write: a second caller
 * arriving with a path from a query, a report, or a match on a title is the case this exists for, and a
 * guard that lived at the lookup instead would not cover it.
 *
 * The closing REASON goes in the caller's commit body, for the reason
 * {@link closeVanishedDetections} records: there is no `memhtml-*` name for it and the vocabulary is
 * closed.
 */
export const closeDetectedTask = (
  env: PhaseEnv,
  path: string
): Effect.Effect<boolean, StorageFailure | GitFailure> =>
  Effect.gen(function* () {
    if (!isDetectedTaskPath(path)) {
      yield* Effect.logWarning(
        `sleep.tasks refused to close ${path}: not a detected task, so no detector may close it`
      )
      return false
    }
    yield* stampFile(env, path, [
      meta("memhtml-task-status", "done"),
      meta("memhtml-updated", env.at)
    ])
    return (yield* archiveFile(env, path)) !== null
  })

/** One open detected task, as the tree holds it. */
export interface OpenDetection {
  readonly path: string
  /** The digest from the filename. */
  readonly key: string
  /** The detector that minted it: the second `memhtml-tag`. */
  readonly detector: string
  readonly title: string
  /** The `<mark>` claim, for the frame-key proximity check. */
  readonly claim: string
}

/**
 * Every OPEN detected task, read from the tree, path-ordered.
 *
 * Open means present under {@link DETECTED_TASK_DIR} and not stamped `done`. Both halves are needed
 * and neither is redundant: closing archives the file out of the directory, so presence is almost
 * sufficient — but a human may stamp `done` by hand through `memhtml task status`, or a run may be
 * interrupted between the stamp and the `git mv`, and a detector must not refresh or re-close a task
 * somebody already finished.
 *
 * **Parsed, not scanned for meta lines.** `memhtml-tag` is repeatable and the surgical `readMeta`
 * returns only the first value of a name, so the detector tag is unreachable without the real parser
 * — the same reason `entity-resolution`'s alias oracle parses person files. A file that does not
 * parse is skipped: it is not indexed either, so no detection is keyed on it.
 */
export const openDetections = (
  env: PhaseEnv
): Effect.Effect<ReadonlyArray<OpenDetection>, StorageFailure> =>
  Effect.gen(function* () {
    const filenames = yield* detectedFilenames(env)
    const out: Array<OpenDetection> = []
    for (const filename of filenames) {
      const path = `${DETECTED_TASK_DIR}/${filename}`
      const key = detectionKeyOf(path)
      if (key === undefined) continue
      const html = yield* readFileBytes(env, path)
      if (html === undefined) continue
      const doc = yield* parseMemory(html).pipe(Effect.orElseSucceed(() => undefined))
      if (doc === undefined) continue
      if (doc.metas.memoryType !== "task" || doc.metas.taskStatus === "done") continue
      const [first, second] = doc.tags
      if (first !== DETECTED_TAG || second === undefined) continue
      out.push({ path, key, detector: second, title: doc.title, claim: doc.article.gist })
    }
    return out
  })

/**
 * The `.html` filenames under {@link DETECTED_TASK_DIR} carrying the detection prefix, sorted.
 *
 * A missing directory is `[]`, not a failure: a corpus that has never had a detected task has no
 * `areas/inbox/tasks` at all, and that is the state every first night starts from. Any OTHER errno
 * still fails, because a permission error on the queue directory is a real fault that must not read
 * as an empty queue and take a sweep through every open detection.
 */
const detectedFilenames = (env: PhaseEnv): Effect.Effect<ReadonlyArray<string>, StorageFailure> =>
  attemptIo(`sleep.tasks.list:${DETECTED_TASK_DIR}`, async () => {
    const { readdir } = await import("node:fs/promises")
    try {
      const entries = await readdir(absoluteIn(env, DETECTED_TASK_DIR))
      return entries
        .filter((name) => name.startsWith(DETECTION_PREFIX) && name.endsWith(".html"))
        .sort()
    } catch (cause) {
      if ((cause as { readonly code?: string }).code === "ENOENT") return []
      throw cause
    }
  })

/**
 * True when the evidence is admissible: a quote only when the cited file's own article text carries it,
 * a measurement or a session citation whenever it is non-empty.
 *
 * Compared with whitespace collapsed on BOTH sides, and case-sensitively. Whitespace is not content
 * here — the same sentence read out of a `body_text` projection, out of a re-wrapped paragraph, and
 * out of the file's markup differ only in spacing, and refusing on that would refuse true quotes.
 * Case IS content: "the deploy is safe" and "the deploy is SAFE" are the same words and a citation
 * that changed the emphasis is not verbatim.
 *
 * The check reads the FILE, not the index row the caller found the sentence in. The tree is the
 * system of record and the index is refreshed once per night, so a row can name text an earlier
 * phase's commit has already replaced. A missing file refuses, which is the same posture every
 * other phase takes toward a path the tree no longer holds.
 *
 * A `session` citation has no file to read and this function says so rather than pretending to check
 * one. What stands behind it is `ungroundedCommitmentReason` at the client boundary plus the phase's
 * own batch-membership check; the module header records why re-reading the transcript here was
 * declined. The non-empty test is not the guard, it is the same floor the other two arms carry.
 */
const evidenceHolds = (
  env: PhaseEnv,
  evidence: DetectionEvidence
): Effect.Effect<boolean, StorageFailure> =>
  Effect.gen(function* () {
    if (evidence.kind === "measurement") return evidence.detail.trim() !== ""
    if (evidence.kind === "session") {
      return evidence.sessionId.trim() !== "" && evidence.statement.trim() !== ""
    }
    const quote = flatten(evidence.quote)
    if (quote === "") return false
    const html = yield* readFileBytes(env, evidence.sourcePath)
    if (html === undefined) return false
    const doc = yield* parseMemory(html).pipe(Effect.orElseSucceed(() => undefined))
    if (doc === undefined) return false
    return flatten(doc.article.bodyText).includes(quote)
  })

/** Whitespace collapsed to single spaces and trimmed. The comparison form for a quote. */
const flatten = (text: string): string => text.replace(/\s+/g, " ").trim()

/** A title: one line, sentence punctuation kept, cut to {@link TITLE_CHARS}. */
const titleOf = (title: string): string => flatten(title).slice(0, TITLE_CHARS).trim()

/**
 * A due hint the format accepts, or `undefined`.
 *
 * `memhtml-due` is compared and ordered AS A STRING by the overdue query, so a value that does not
 * sort alongside the others would corrupt it. `isValidDatetime` is the format's own predicate, so a
 * hint a model supplied is dropped rather than written and the task simply has no due date.
 */
const dueOf = (hint: string | undefined): string | undefined =>
  hint !== undefined && isValidDatetime(hint.trim()) ? hint.trim() : undefined

/**
 * A detected task's article: the claim, the detail, the evidence, and the provenance line.
 *
 * Authored as MARKUP rather than through the template's prose path, because the evidence needs
 * `<q cite>` — the vocabulary's own quotation element, which carries its source URI and projects into
 * `file_citations(text, href)`. That is what makes issue #44's "the parser can verify the quote still
 * exists in the cited source" a single query rather than a re-read of every task. `<blockquote>` is
 * NOT in the closed vocabulary, so the quote is inline in its own paragraph.
 *
 * Using `articleHtml` means this function owns constraint 1, so the `<mark>` is placed in the first
 * `<p>` here and nowhere else. Every interpolation goes through `escapeText`/`escapeAttribute`: a
 * model-supplied sentence reaches this string on surface 3, and the source path reaches it on all of
 * them.
 */
const detectedArticle = (env: PhaseEnv, request: DetectionRequest): string => {
  const paragraphs = [`<p><mark>${escapeText(flatten(request.claim))}</mark></p>`]
  if (request.detail !== undefined && request.detail.trim() !== "") {
    paragraphs.push(`<p>${escapeText(flatten(request.detail))}</p>`)
  }
  paragraphs.push(evidenceParagraph(request.evidence))
  paragraphs.push(
    `<p>Detected by <code>${escapeText(request.detector)}</code> on run ` +
      `<code>${escapeText(env.runId)}</code>. This is a proposal for a human to decide, not a ` +
      `finding the corpus asserts. It closes itself when the detector stops seeing it.</p>`
  )
  return paragraphs.join("\n")
}

/**
 * The one paragraph that states what the finding rests on, per evidence kind.
 *
 * Split out of {@link detectedArticle} once the third arm arrived, so the three readings sit beside
 * each other and the difference between them is legible. Each says out loud what a reader can do with
 * it: open the file and find the sentence, take the number on the corpus's word, or go back to the
 * session and read the line in the commit that opened this.
 *
 * The `session` arm carries NO quote, which is the trace-plane invariant and not an omission. See the
 * module header. It also carries no `<q cite>`, because there is nothing to cite: a session is not a
 * corpus path and `hrefFor` over an id would produce a link that resolves nowhere, which
 * `integrity`'s dangling-edge repair exists to prevent.
 */
const evidenceParagraph = (evidence: DetectionEvidence): string => {
  if (evidence.kind === "quote") {
    return (
      `<p>Evidence, verbatim from <code>${escapeText(evidence.sourcePath)}</code>: ` +
      `<q cite="${escapeAttribute(hrefFor(evidence.sourcePath))}">` +
      `${escapeText(flatten(evidence.quote))}</q></p>`
    )
  }
  if (evidence.kind === "session") {
    return (
      `<p>Evidence, from session <code>${escapeText(evidence.sessionId)}</code>: ` +
      `${escapeText(flatten(evidence.statement))} The verbatim line is in the commit that opened ` +
      `this task; a transcript span is not stored in the corpus.</p>`
    )
  }
  return `<p>Evidence, measured over the corpus: ${escapeText(flatten(evidence.detail))}</p>`
}
