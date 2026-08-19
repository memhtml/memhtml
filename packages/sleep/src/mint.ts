import { createHash } from "node:crypto"

import { InvalidMemory, type StorageFailure } from "@memhtml/contracts/errors"
import { placementFor } from "@memhtml/contracts/paths"
import { slugify, withCollisionOrdinal } from "@memhtml/contracts/slug"
import { FINDING_KEY_PATTERN } from "@memhtml/contracts/types"
import { renderTemplate } from "@memhtml/html"
import type { GitFailure } from "@memhtml/store"
import { Effect } from "effect"

import { archiveFile, meta, readFileBytes, writeFileBytes } from "./edits.js"
import type { PhaseEnv } from "./env.js"
import { openDetectedTasks } from "./sql.js"

/**
 * The shared minting kernel: how a detector phase turns a finding into a task file, and how it
 * closes one whose finding is gone.
 *
 * Four phases detect work a human should do — an entity pair the model would not decide, a
 * near-duplicate the veto refused, a contradiction one night short of promotion, a commitment
 * spoken in a transcript. Each is a different question with the same file-level consequence, and
 * the consequence is the part that is easy to get wrong: an idempotency key, dedup against what is
 * already open, a cap on how much one night may add, and a closure that does not reach a task a
 * human has picked up. Four copies of that would be four chances to file a duplicate every night
 * forever, which is the failure mode a to-do list cannot survive.
 *
 * **The kernel STAGES; it never commits.** Same posture as `edits.ts`, for the same reason: the
 * phase owns its commit, so a phase that mints two tasks and closes a third produces one reviewable
 * commit rather than three.
 *
 * **Writes stream at {@link Minter.submit} rather than batching into {@link Minter.finish}.** That
 * is the one place this kernel departs from the house validate-all-then-write-once shape, and the
 * reason is dedup: the index projects COMMITTED plus working-tree state as of phase start, so a task
 * this night already minted is invisible to it. The minter therefore carries its own in-run set of
 * keys, claims, and claimed paths, and a second finding restating the first has to be able to see
 * the first. Streaming keeps ONE such set instead of a pending list plus a set that must agree with
 * it. `finish` seals the report; it does not perform the writes.
 */

/**
 * New task files one detector may add in one night.
 *
 * The guard is on the DIFF a human reviews, not on the detection: a corpus that suddenly produced
 * 400 confirm-this-pair findings is a corpus problem, and turning it into 400 new files in one
 * commit would make the night unreviewable and the inbox useless the morning after. Ten is a
 * morning's worth of decisions. Overflow is not lost — it is counted as `mintOverflow`, and the
 * findings still enter `presentKeys` so the same night's closure pass cannot mistake a capped
 * finding for a vanished one (see {@link Minter.closeAbsent}).
 *
 * Same shape and same reasoning as `EDGE_PROMOTION_CAP`: bound what gets WRITTEN, and let the count
 * say the bound was hit.
 */
export const MINT_CAP = 10

/**
 * The tag every detected task carries, which is what makes "machine-detected" visible in the file
 * itself rather than only in `files.finding_key`.
 */
export const DETECTED_TAG = "detected"

/** Author of a minted task. Detected work is sleep's, and the separation is the point. */
export const MINT_AUTHOR = "agent:sleep"

/**
 * The claim overlap at which two findings are one finding.
 *
 * A detector's fingerprint is exact, so the finding key catches only a finding restated
 * IDENTICALLY. The case it misses is the same work item phrased slightly differently between two
 * nights or two detectors' passes over shifted evidence — "I'll update the runbook" against "I'll
 * update the runbook this week" — where the fingerprints differ and the task does not. Token overlap
 * at 0.6 catches that pair (measured 5/7 = 0.714) while leaving unrelated claims far below: two
 * one-line claims about different subjects share little more than their function words.
 */
export const CLAIM_JACCARD_FLOOR = 0.6

/**
 * Collision ordinals tried before a mint is refused.
 *
 * Duplicated from `phases/trace-consolidation.ts` deliberately, along with the probe below. The two
 * are the same four lines around the same rule, and hoisting them into a shared allocator would put
 * one path-allocation door in front of two callers whose collision behavior differs — that phase
 * skips a candidate, this one refuses a mint — for no gain beyond removing four lines.
 */
const PATH_ORDINAL_LIMIT = 1000

/** What a phase submits: one thing a human should decide, with the evidence for it. */
export interface DetectedFinding {
  /**
   * The detecting phase, and the first segment of the finding key. Must equal the detector the
   * minter was made for; see the guard in {@link makeMinter}.
   */
  readonly detector: string
  /**
   * The detector-owned canonical string identifying WHAT was found, which the kernel hashes into
   * the finding key. Two nights that find the same thing must produce byte-identical fingerprints,
   * so a fingerprint carries no timestamp, no run id, and no session id.
   */
  readonly fingerprint: string
  readonly title: string
  /** The one load-bearing sentence. Becomes the `<mark>` span, `files.gist`, and the Jaccard input. */
  readonly claim: string
  /**
   * Pre-authored article markup, used verbatim. The evidence-quoting path: a cited quote per side
   * of a contradiction cannot be expressed as prose paragraphs. It must carry its own `<mark>` —
   * `renderTemplate` hands `articleHtml` through untouched, so constraint 1 is the caller's here,
   * exactly as it is on the store's write path.
   *
   * **The cited-quote element is `<q cite="/path">`, NOT `<blockquote>`.** `blockquote` is outside
   * `KNOWN_ELEMENTS`, so a task minted with one parses carrying an `unknown:blockquote` warning AND
   * its quoted text never reaches `article.citations` — which is the projection doctor's stale-quote
   * check reads, so the evidence would be unverifiable. Measured 2026-08-19; `tests/mint.test.ts`
   * pins the working form.
   */
  readonly bodyHtml?: string | undefined
  /** Prose paragraphs, when the finding has no markup to place. Ignored when `bodyHtml` is given. */
  readonly body?: ReadonlyArray<string> | undefined
  readonly entities?: ReadonlyArray<string> | undefined
  /** Routes the task under `projects/<workspace>/tasks/` instead of `areas/inbox/tasks/`. */
  readonly workspace?: string | undefined
  /** Provenance of a finding read out of a transcript. Becomes the `memhtml-session` meta. */
  readonly sessionId?: string | undefined
}

/** One minted task: where it landed and the key that will recognize it next night. */
export interface MintedTask {
  readonly path: string
  readonly findingKey: string
}

/** What a minting pass did, for the phase to fold into its own counts. */
export interface MintReport {
  /**
   * The tasks minted, in submission order. Populated on a DRY RUN too, with the paths the mint
   * would have taken — an operator sizing a night is asking exactly that.
   */
  readonly minted: ReadonlyArray<MintedTask>
  /** The counts vocabulary, zero-valued keys omitted so a phase's trailer stays readable. */
  readonly counts: Record<string, number>
  /**
   * Every SUBMITTED finding's key, including the ones dedup skipped and the ones the cap held
   * back. The closure pass reads this as "still detected", and a capped finding is still detected.
   */
  readonly presentKeys: ReadonlySet<string>
}

/**
 * `<detector>:<first 16 hex of sha256(fingerprint)>` — a detected task's whole identity.
 *
 * Sixteen hex characters is 64 bits, which is not a cryptographic claim and does not need to be:
 * the space being separated is one detector's findings over one corpus, tens per night, and a
 * collision costs one wrongly deduplicated task rather than a security property. The prefix keeps
 * the key short enough to read in a `git diff` and in a filename-adjacent meta, and the detector
 * segment is what lets `openDetectedTasks` answer one detector's set with an index range.
 *
 * `sha256` over the fingerprint, hex, sliced — the same `createHash` idiom `@memhtml/html`'s
 * `contentHash` and `@memhtml/index`'s chunk id use, so the corpus has one hashing habit.
 */
export const findingKeyOf = (detector: string, fingerprint: string): string =>
  `${detector}:${createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 16)}`

/**
 * The word set of a claim: lowercased, every non-alphanumeric run treated as a separator.
 *
 * Deliberately crude. The comparison it feeds is "is this the same work item", and stemming or a
 * stop-word list would make the number depend on a vocabulary that has to be maintained and that
 * differs per detector. Punctuation-to-space rather than punctuation-dropped, so `runbook.` and
 * `runbook` are one token while `I'll` becomes two — which is fine, because both sides of the
 * comparison are tokenized the same way.
 */
const claimTokens = (claim: string): ReadonlySet<string> =>
  new Set(
    claim
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token !== "")
  )

/**
 * Jaccard overlap of two claims' word sets, in `[0, 1]`. Identical claims score 1 and disjoint ones
 * 0.
 *
 * Two empty claims score 0, not 1. An empty claim is a detector bug, and scoring the pair 1 would
 * make one such finding suppress every later one for the night.
 */
export const claimJaccard = (left: string, right: string): number => {
  const a = claimTokens(left)
  const b = claimTokens(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) {
    if (b.has(token)) shared += 1
  }
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/**
 * Close one detected task: stamp `done` and archive it, staged, in ONE move.
 *
 * The status stamp rides `archiveFile`'s `extraEdits` rather than a separate `stampFile` pass, so
 * the tree never holds a task that is archived and still `todo`, or `done` and still at its live
 * path. `openDetectedTasks` carries `task_status <> 'done'` precisely because that window used to
 * exist across two commits; keeping the stamp inside the move means this kernel does not reopen it.
 *
 * Returns the archive path, or `null` when the live path holds no file — an earlier phase moved it,
 * and the tree is the system of record. Callers count the `null` as no closure.
 *
 * **The closure REASON is not written here, and there is nowhere for it to go.** No head meta in the
 * format carries one, and `store.archiveMemory` puts its reason in the commit subject
 * (`packages/store/src/store.ts:888-900`). So a caller states the reason in the phase commit it
 * makes — which is also where a reviewer is reading when they ask why a task disappeared.
 */
export const closeTask = (
  env: PhaseEnv,
  path: string
): Effect.Effect<string | null, StorageFailure | GitFailure> =>
  archiveFile(env, path, [meta("memhtml-task-status", "done")])

/** One detector's minting pass over one night. */
export interface Minter {
  /**
   * Offer one finding. Skips and counts when it is already open or a restatement, mints when it is
   * new and under the cap, counts overflow when it is not. Either way the finding's key enters
   * `presentKeys`.
   */
  readonly submit: (
    finding: DetectedFinding
  ) => Effect.Effect<void, StorageFailure | GitFailure | InvalidMemory>
  /** The pass's report. A pure read of accumulated state; calling it twice is the same answer. */
  readonly finish: () => MintReport
  /**
   * Archive this detector's open tasks whose findings are GONE — but only under a truthful
   * `universeComplete`.
   *
   * Absence is only evidence when the detector actually looked everywhere. A night whose model call
   * failed, whose batch assembly truncated, or which ran with no credentials at all detects nothing
   * and therefore finds every open task "absent" — closing on that would delete the whole detected
   * backlog on the first bad night. So the attestation is the phase's, computed from what the phase
   * knows about its own completeness, and a `false` closes nothing and says so in the counts.
   *
   * A task whose `task_status` is not `todo` is never closed here either. Somebody moved it to
   * `doing` or `blocked`, which means a human owns it now; the detector's evidence going quiet is
   * not permission to archive their work item.
   */
  readonly closeAbsent: (
    universeComplete: boolean
  ) => Effect.Effect<Record<string, number>, StorageFailure | GitFailure>
}

/**
 * Make the minting pass for one detector, reading the open detected tasks it must not re-file.
 *
 * **One read of `openDetectedTasks`, used for BOTH dedup arms.** The exact-key arm could equally
 * call `taskPathForFindingKey` per finding, and `sql.ts` states the two helpers agree by
 * construction — but the Jaccard arm needs every open task's gist anyway, so answering both from
 * one snapshot is one query instead of one-per-finding AND makes the two arms structurally unable to
 * disagree about what "already open" means. The snapshot cannot go stale mid-pass in a way that
 * matters: nothing this night writes reaches `files` until the next index pass, which is why the
 * in-run sets below exist.
 *
 * The detector name is validated ONCE, here, against the pattern the format itself enforces. A
 * detector containing an uppercase letter or a space would hash into a key that
 * `FINDING_KEY_PATTERN` rejects, and `@memhtml/html` drops a rejected value to ABSENT — so every
 * task would be minted with NO finding key, nothing would ever recognize them, and the phase would
 * re-file its whole finding set every night with no error anywhere. Failing at construction turns
 * that into one loud stop.
 */
export const makeMinter = (
  env: PhaseEnv,
  detector: string
): Effect.Effect<Minter, StorageFailure | InvalidMemory> =>
  Effect.gen(function* () {
    if (!FINDING_KEY_PATTERN.test(findingKeyOf(detector, "probe"))) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `detector ${JSON.stringify(detector)} does not form a valid finding key`
        })
      )
    }

    const open = yield* openDetectedTasks(env.deps.db, detector)

    /** Keys open at phase start, plus every key this pass has minted. */
    const openKeys = new Set(open.map((row) => row.finding_key))
    /** Claims open at phase start, plus every claim this pass has minted. The Jaccard corpus. */
    const openClaims = open.map((row) => row.gist)
    /** Paths this pass has taken, which disk cannot answer for on a dry run or before a write. */
    const claimedPaths = new Set<string>()

    const presentKeys = new Set<string>()
    const minted: Array<MintedTask> = []
    const counts = new Map<string, number>()
    const bump = (key: string): void => {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    /**
     * The first free path under the task directory for this title, or `undefined` when a thousand
     * ordinals are taken.
     *
     * DISK IS AUTHORITATIVE and `claimedPaths` is only the half disk cannot answer — a path is taken
     * if either says so. The same rule and the same reasoning as
     * `phases/trace-consolidation.ts:659-674`, duplicated rather than shared (see
     * {@link PATH_ORDINAL_LIMIT}). Two findings whose titles slug identically are the ordinary case
     * here, not a rare one: `confirm: are «a» and «b» the same person?` truncates at 80 characters,
     * so two long names sharing a prefix collide.
     */
    const freePath = (
      finding: DetectedFinding
    ): Effect.Effect<string | undefined, StorageFailure> =>
      Effect.gen(function* () {
        /**
         * `placementFor`'s task arm routes on workspace ALONE — a task about a person is still a
         * task, and routing it into `resources/people/` would put working state on the durable
         * identity surface. The other fields are passed for the record, not because they route.
         */
        const directory = placementFor({
          memoryType: "task",
          tags: [DETECTED_TAG],
          ...(finding.entities === undefined ? {} : { entities: finding.entities }),
          ...(finding.workspace === undefined ? {} : { workspace: finding.workspace })
        })
        const stem = slugify(finding.title)
        for (let ordinal = 1; ordinal <= PATH_ORDINAL_LIMIT; ordinal += 1) {
          const candidate = `${directory}/${withCollisionOrdinal(stem, ordinal)}.html`
          if (claimedPaths.has(candidate)) continue
          if ((yield* readFileBytes(env, candidate)) === undefined) return candidate
        }
        return undefined
      })

    const submit = (
      finding: DetectedFinding
    ): Effect.Effect<void, StorageFailure | GitFailure | InvalidMemory> =>
      Effect.gen(function* () {
        /**
         * A finding filed under another detector's name would be keyed, deduplicated, and later
         * CLOSED by the wrong phase's attestation — this phase's `closeAbsent` would not see its key
         * as present and the owning phase would archive it on a night it detected nothing. The
         * mismatch is a caller bug with a silent, delayed consequence, so it fails here.
         */
        if (finding.detector !== detector) {
          return yield* Effect.fail(
            InvalidMemory.make({
              reason: `finding declares detector ${JSON.stringify(finding.detector)} but the minter is ${JSON.stringify(detector)}`
            })
          )
        }

        const findingKey = findingKeyOf(detector, finding.fingerprint)
        /**
         * Recorded BEFORE any skip, which is AC-2-2's whole point: a finding held back by the cap,
         * or one already open, is still DETECTED. Leaving either out of `presentKeys` would let the
         * same night's closure pass read it as vanished and archive the task the finding is about.
         */
        presentKeys.add(findingKey)

        if (openKeys.has(findingKey)) {
          bump("taskAlreadyOpen")
          return
        }

        const restated = openClaims.some(
          (gist) => claimJaccard(finding.claim, gist) >= CLAIM_JACCARD_FLOOR
        )
        if (restated) {
          bump("taskDeduped")
          return
        }

        if (minted.length >= MINT_CAP) {
          bump("mintOverflow")
          return
        }

        const path = yield* freePath(finding)
        if (path === undefined) {
          /**
           * A refusal, counted rather than forced. The alternative — one fixed overflow path — is
           * the overwrite the probe exists to prevent, made unconditional. Outside the AC-3-4
           * vocabulary on purpose: folding a thousand-way path collision into `taskDeduped` would
           * report a corpus problem as a successful deduplication.
           */
          yield* Effect.logWarning(
            `sleep.mint ${detector} refused ${findingKey}: no free path for ${slugify(finding.title)}`
          )
          bump("pathExhausted")
          return
        }

        claimedPaths.add(path)
        openKeys.add(findingKey)
        openClaims.push(finding.claim)
        minted.push({ path, findingKey })
        bump("taskMinted")

        /**
         * The dry-run asymmetry: everything above ran, so the counts and the paths are the real
         * preview, and only the two lines that touch the tree are skipped.
         */
        if (env.dryRun) return

        yield* writeFileBytes(
          env,
          path,
          renderTemplate({
            title: finding.title,
            claim: finding.claim,
            memoryType: "task",
            at: env.at,
            author: MINT_AUTHOR,
            tags: [DETECTED_TAG],
            findingKey,
            ...(finding.bodyHtml === undefined ? {} : { articleHtml: finding.bodyHtml }),
            ...(finding.body === undefined ? {} : { body: finding.body }),
            ...(finding.entities === undefined ? {} : { entities: finding.entities }),
            ...(finding.sessionId === undefined ? {} : { sessionId: finding.sessionId })
          })
        )
        yield* env.deps.git.add([path])
      })

    const finish = (): MintReport => ({
      minted: [...minted],
      counts: Object.fromEntries(counts),
      presentKeys: new Set(presentKeys)
    })

    const closeAbsent = (
      universeComplete: boolean
    ): Effect.Effect<Record<string, number>, StorageFailure | GitFailure> =>
      Effect.gen(function* () {
        /**
         * The candidates come from the SAME snapshot the dedup arms read, deliberately. A re-read
         * would return the identical rows — nothing this night wrote has been indexed — while
         * inviting a reader to believe the two lists could differ. Tasks minted a moment ago are
         * excluded anyway, by their own keys being in `presentKeys`.
         */
        const absent = open.filter((row) => !presentKeys.has(row.finding_key))

        /**
         * Not complete, so nothing closes and the count says how many closures were withheld.
         * Returned BEFORE any status is examined, so on an incomplete night `closureSkipped` means
         * "the whole pass" and nothing else.
         */
        if (!universeComplete) {
          return absent.length === 0 ? {} : { closureSkipped: absent.length }
        }

        let closed = 0
        let skipped = 0
        for (const row of absent) {
          /**
           * The todo-only guard. A `doing` or `blocked` task is one a human took, and a detector
           * whose evidence went quiet — because the human is mid-fix, which is the common reason —
           * has not earned the right to archive it. Counted, so an operator can see the backlog the
           * closure pass is leaving alone.
           */
          if (row.task_status !== "todo") {
            skipped += 1
            continue
          }
          if (env.dryRun) {
            closed += 1
            continue
          }
          if ((yield* closeTask(env, row.path)) !== null) closed += 1
        }

        return {
          ...(closed === 0 ? {} : { taskClosed: closed }),
          ...(skipped === 0 ? {} : { closureSkipped: skipped })
        }
      })

    return { submit, finish, closeAbsent }
  })
