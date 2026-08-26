import { isEdgeRel } from "@memhtml/contracts/edges"
import {
  ARCS_DIR,
  INBOX_DIR,
  isValidMemoryPath,
  normalizePath,
  PEOPLE_DIR,
  paraBucketOf
} from "@memhtml/contracts/paths"
import { attemptIo } from "@memhtml/store"
import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import { absoluteIn, hrefFor, link, meta, readFileBytes, stampFile, unlink } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody, takeLlmCall } from "../env.js"
import {
  PLACEMENT_CONFIDENCE_FLOOR,
  PLACEMENT_KEEP,
  PLACEMENT_SYSTEM,
  PlacementTriage,
  placementPrompt
} from "../llm.js"
import { activeCorpus, inboundAuthoredEdges, isSleepExcluded } from "../sql.js"
import { deepCommunityLabels } from "./compress.js"

/**
 * Phase 14, placement triage. DEEP-ONLY (issue #63): propose a topic directory for each inbox
 * memory that even deep grouping left communityless, and `git mv` the ones the model places with
 * confidence. ONE COMMIT.
 *
 * The mechanism this phase exists for: a bulk-imported inbox is mostly NOT compressible — each file
 * is a distinct fact — and what keeps the inbox crowded is that nothing ever re-files them. `doctor`
 * reports `inboxCrowded` and no phase acts on it. This one does, under the same discipline as every
 * other mutation: on the review branch, in its own commit, reversible by discarding the branch.
 *
 * **On a default run the phase returns immediately**, before any read, with a reason — the same
 * shape `compress` has for a missing model. That is the whole no-flag contract: a run without
 * `--deep` cannot reach a single line of this phase's work.
 *
 * The deterministic guardrails, each enforced in code after the model answers:
 *
 * - a destination must be an EXISTING directory (as the index knows them) or one of at most
 *   {@link PLACEMENT_NEW_DIR_CAP} new `areas/<topic>` or `resources/<topic>` directories per run —
 *   first proposed, first minted, lexicographic order within one batch;
 * - the managed surfaces refuse: the inbox itself, `areas/arcs`, `resources/people`, anything under
 *   `archive/`, and any path outside the PARA buckets;
 * - tasks never move (excluded from the scan AND re-checked per row, matching the double guard
 *   task-detection carries);
 * - a file another phase already touched this run never moves, read from `git diff --name-only
 *   base..HEAD` — a `mv` of a path compress just archived would fail, and one of a path an earlier
 *   phase stamped would tear that phase's edit out of its own commit's diff;
 * - `keep-inbox`, an unknown key, a below-floor confidence, and an omitted member all leave the
 *   file where it is.
 *
 * **Inbound hrefs are rewritten in the same commit.** Integrity's dangling-href repair chases a
 * target into the ARCHIVE by deriving `archivePathFor`; a placement move is not an archive, so this
 * phase rewrites `<link>` elements in the files that point at each moved path itself, the same
 * remove-then-add splice integrity uses. The indexer tracks the rename (`diff -M` + `movePath`), so
 * chunks and embeddings carry over and nothing re-embeds.
 */

/** Inbox memories offered per model call. Placement is a lighter question than a fold, so wider. */
export const PLACEMENT_BATCH_SIZE = 16

/** Inbox memories considered per run. The model-cost guard, in the spirit of compress's 2000. */
export const PLACEMENT_CANDIDATE_LIMIT = 2000

/** Characters of each member shown. Placement needs the topic, not every fact. */
export const PLACEMENT_MEMBER_CHARS = 600

/**
 * New topic directories one run may mint. Small on purpose: a new directory is a new place every
 * future reader and `placementFor` caller has to know about, and a bulk import that genuinely needs
 * thirty new topics should earn them over several reviewed runs, not one.
 */
export const PLACEMENT_NEW_DIR_CAP = 5

export const placementTriage: PhaseBody = (env) =>
  Effect.gen(function* () {
    if (env.deep === undefined) {
      return { ...emptyOutcome({ candidates: 0 }), detail: "deep-only phase; run with --deep" }
    }
    const model = env.deps.model
    if (model === undefined) {
      return { ...emptyOutcome({ candidates: 0 }), detail: "no model bound" }
    }

    /**
     * Candidates: active inbox memories with no community even under the WIDENED graph — default
     * edges plus the deep grouping band, the same partition deep compress groups by. Issue #63's
     * "true singleton" is exactly this: a file even the 0.72 band could not attach to anything.
     * A file the widened graph DID reach belongs to compress's pipeline (this run or a later one),
     * not to placement; an ENTITY-grouped file is deliberately still placeable, because entity
     * grouping is a compress-band mechanism and a KEEP-band inbox file it cannot fold still needs
     * a home.
     */
    const widened = yield* deepCommunityLabels(env)
    const corpus = yield* activeCorpus(env.deps.db)
    const inInbox = (path: string): boolean =>
      path.startsWith(`${INBOX_DIR}/`) && !path.startsWith(`${INBOX_DIR}/tasks/`)
    const candidates = corpus
      .filter(
        (row) =>
          inInbox(row.path) &&
          !isSleepExcluded(row.memory_type) &&
          row.memory_type !== "arc" &&
          widened.get(row.path) === undefined
      )
      .sort((left, right) => (left.path < right.path ? -1 : 1))
      .slice(0, PLACEMENT_CANDIDATE_LIMIT)

    /**
     * The directories the corpus already has, from the index's own path set: every distinct
     * directory holding an active file under `areas/` or `resources/`, minus the managed surfaces.
     * Offered to the model verbatim and used as the validation set, so the question and the gate
     * cannot disagree.
     */
    const managed = new Set([INBOX_DIR, `${INBOX_DIR}/tasks`, ARCS_DIR, PEOPLE_DIR])
    const existingDirs = [
      ...new Set(
        corpus
          .map((row) => row.path.slice(0, row.path.lastIndexOf("/")))
          .filter(
            (dir) => (dir.startsWith("areas/") || dir.startsWith("resources/")) && !managed.has(dir)
          )
      )
    ].sort()

    /** Paths this run already touched. A move of one would cross-contaminate another phase's diff. */
    const touched = new Set(
      env.baseSha === ""
        ? []
        : yield* env.deps.git.run(["diff", "--name-only", `${env.baseSha}..HEAD`]).pipe(
            Effect.map((out) =>
              out
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
            ),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>)
          )
    )

    const batches = assembleBatches([candidates], { maxMembers: PLACEMENT_BATCH_SIZE })
    const counts: Record<string, number> = {
      candidates: candidates.length,
      batches: batches.length,
      proposed: 0,
      applied: 0,
      refused: 0,
      keptInbox: 0,
      newDirs: 0,
      budgetSkipped: 0,
      failed: 0
    }
    if (batches.length === 0 || env.dryRun) return emptyOutcome(counts)

    const modelKey = modelFor(env.deps, "placement-triage")
    const mintedDirs = new Set<string>()
    const movedFrom = new Map<string, string>()
    let llmCalls = 0

    for (const batch of batches) {
      const keyed = keyMembers(batch, (row) => `${row.title}\n${row.gist}\n${row.body_text}`, {
        charBudget: PLACEMENT_MEMBER_CHARS
      })

      if (!takeLlmCall(env.deep)) {
        counts.budgetSkipped = (counts.budgetSkipped ?? 0) + 1
        continue
      }
      llmCalls += 1
      const answer = yield* batchCall(model, `placement batch of ${batch.length}`, {
        schema: PlacementTriage,
        system: PLACEMENT_SYSTEM,
        prompt: placementPrompt(existingDirs, keyed.keyed),
        modelKey,
        effort: "high",
        toolDescription: "Propose a destination directory (or keep-inbox) per offered memory."
      })
      if (answer === undefined) {
        counts.failed = (counts.failed ?? 0) + 1
        continue
      }

      /**
       * Placements resolve through the kernel, so an invented key drops. Sorted by (destination,
       * key) so within one answer the minting order of new directories is a function of the answer's
       * CONTENT rather than of its field order.
       */
      const resolvedRows = answer.placements
        .filter((placement) => placement.destination.trim() !== "")
        .sort((left, right) =>
          left.destination < right.destination
            ? -1
            : left.destination > right.destination
              ? 1
              : left.memberKey < right.memberKey
                ? -1
                : 1
        )

      for (const placement of resolvedRows) {
        const rows = resolveKeys(keyed, [placement.memberKey])
        const row = rows[0]
        if (row === undefined) continue
        counts.proposed = (counts.proposed ?? 0) + 1

        const destination = normalizePath(placement.destination.trim())
        if (destination === PLACEMENT_KEEP) {
          counts.keptInbox = (counts.keptInbox ?? 0) + 1
          continue
        }
        const refuse = (reason: string): Effect.Effect<void> => {
          counts.refused = (counts.refused ?? 0) + 1
          return Effect.logWarning(
            `sleep.placement refused ${row.path} -> ${destination}: ${reason}`
          )
        }

        if (placement.confidence < PLACEMENT_CONFIDENCE_FLOOR) {
          yield* refuse("below the confidence floor")
          continue
        }
        const bucket = paraBucketOf(destination)
        if (
          (bucket !== "areas" && bucket !== "resources") ||
          managed.has(destination) ||
          destination === row.path.slice(0, row.path.lastIndexOf("/")) ||
          destination
            .split("/")
            .some((segment) => segment === "" || segment === "." || segment === "..")
        ) {
          yield* refuse("not a placeable directory")
          continue
        }
        // Tasks never move: excluded from the scan, and re-checked here because the scan reads a
        // projected column refreshed once per night.
        if (isSleepExcluded(row.memory_type)) {
          yield* refuse("tasks never move")
          continue
        }
        if (touched.has(row.path) || movedFrom.has(row.path)) {
          yield* refuse("another phase touched this file this run")
          continue
        }
        const isNew = !existingDirs.includes(destination) && !mintedDirs.has(destination)
        if (isNew && mintedDirs.size >= PLACEMENT_NEW_DIR_CAP) {
          yield* refuse("the new-directory cap for this run is spent")
          continue
        }

        const filename = row.path.slice(row.path.lastIndexOf("/") + 1)
        const target = `${destination}/${filename}`
        if (!isValidMemoryPath(target)) {
          yield* refuse("the destination path is not a valid memory path")
          continue
        }
        if ((yield* readFileBytes(env, target)) !== undefined) {
          yield* refuse("the destination already holds a file by that name")
          continue
        }
        if ((yield* readFileBytes(env, row.path)) === undefined) {
          yield* refuse("the source file is already gone from the tree")
          continue
        }

        // `git mv` refuses a destination whose parent does not exist; a new topic directory's never does.
        yield* attemptIo(`sleep.placement.mkdir:${target}`, async () => {
          const { mkdir } = await import("node:fs/promises")
          const { dirname } = await import("node:path")
          await mkdir(dirname(absoluteIn(env, target)), { recursive: true })
        })
        yield* env.deps.git.mv(row.path, target)
        yield* stampFile(env, target, [meta("memhtml-updated", env.at)])
        if (isNew) {
          mintedDirs.add(destination)
          counts.newDirs = (counts.newDirs ?? 0) + 1
        }
        movedFrom.set(row.path, target)
        counts.applied = (counts.applied ?? 0) + 1
      }
    }

    /**
     * Inbound href repair, inside the same commit as the moves. Every authored `<link>` whose
     * target moved is respliced in ITS OWN file to the new path — remove-then-add, integrity's
     * idempotent shape — so the branch never carries a commit whose links dangle by construction.
     */
    let rewritten = 0
    for (const [from, to] of [...movedFrom.entries()].sort(([left], [right]) =>
      left < right ? -1 : 1
    )) {
      const inbound = yield* inboundAuthoredEdges(env.deps.db, from)
      for (const edge of inbound) {
        if (!isEdgeRel(edge.rel)) continue
        const holder = movedFrom.get(edge.src_path) ?? edge.src_path
        const changed = yield* stampFile(env, holder, [
          unlink(edge.rel, hrefFor(from)),
          link(edge.rel, hrefFor(to)),
          meta("memhtml-updated", env.at)
        ])
        if (changed) rewritten += 1
      }
    }
    counts.hrefsRewritten = rewritten

    const commitSha = yield* commitPhase(
      env,
      "placement-triage",
      `re-file ${counts.applied ?? 0} inbox memories into topic directories`,
      counts
    )
    return { counts, commitSha, llmCalls }
  })
