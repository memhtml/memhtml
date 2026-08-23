import { INBOX_DIR } from "@memhtml/contracts/paths"
import { slugify } from "@memhtml/contracts/slug"
import { excludeSelfSupersede } from "@memhtml/domain"
import { renderTemplate } from "@memhtml/html"
import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import { archiveFile, hrefFor, link, meta, stampFile, writeFileBytes } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody } from "../env.js"
import { COMPRESS_SYSTEM, CompressSynthesis, compressPrompt } from "../llm.js"
import { runRetentionPass, type ScoredMemory } from "../retention.js"
import { isSleepExcluded } from "../sql.js"

/**
 * Phase 10, compress. COMPRESS-band memories grouped by community, folded into a synthesized
 * canonical in batches. ONE COMMIT PER BATCH.
 *
 * The batching runs on the shared kernel in `batch.ts`: this phase sorts the communities and their
 * members, and `assembleBatches`, `keyMembers`, `compressPrompt`, and `resolveKeys` do the slicing,
 * the opaque keying, the prompt framing, and the key resolution that four other phases also need. The
 * kernel preserves the order it is handed and does no sorting of its own, so the two sorts below are
 * what make a night's batch boundaries and member keys reproducible.
 *
 * Grouped by community instead of by similarity, because a community is the graph's own answer to
 * "what belongs together". A similarity group folds two memories that happen to share vocabulary,
 * while a community folds memories the corpus itself has linked. Communities below the minimum size
 * collapse to `undefined` and are skipped. A pair passed off as a community would make every
 * cross-pair edge look like a bridge, and would fold two memories that are merely adjacent.
 *
 * **A member is archived only when the model names it in `absorbedKeys`.** The phase archives a
 * file only when it can show the content was carried forward, so an omitted member stays active,
 * which is the safe outcome. Declining to fold is a valid model answer, and `absorbedKeys: []`
 * produces no archive and no commit.
 *
 * **The canonical is excluded from its own members.** A batch can fold into a memory that IS one of
 * the members, and archiving it would destroy the file just folded into. `excludeSelfSupersede` is
 * the guard, and it exists because that case is reachable whenever the model writes a canonical whose
 * slug matches an existing one.
 *
 * `dedup-merge` is a HARD prerequisite. Compressing before duplicates are folded would synthesize a
 * canonical over a pair the merge phase then archives one half of.
 */

/** Members per model call. Small enough that every member's facts fit the answer's attention. */
export const COMPRESS_BATCH_SIZE = 8

/**
 * Members a batch needs before it is worth a call. A batch of one is not a fold: it would rewrite a
 * lone memory into a "canonical" saying the same thing under a new path, and archive the original.
 */
export const COMPRESS_MIN_BATCH = 2

/** COMPRESS-band candidates considered per cycle. The model-cost guard. */
export const COMPRESS_CANDIDATE_LIMIT = 2000

/** Characters of each member shown. A fold must see the facts, so this is wider than arc evidence. */
export const COMPRESS_MEMBER_CHARS = 1200

export const compress: PhaseBody = (env) =>
  Effect.gen(function* () {
    const model = env.deps.model
    if (model === undefined) {
      return {
        ...emptyOutcome({ candidates: 0, batches: 0, canonicals: 0 }),
        detail: "no model bound"
      }
    }

    const pass = yield* runRetentionPass(env.deps.db, env.at)
    const candidates = pass.scored
      .filter(
        (entry) =>
          entry.score.action === "compress" &&
          entry.row.memory_type !== "arc" &&
          // A fold rewrites several memories into one canonical claim. Three tasks cannot become
          // one task: each is a separate thing an agent owes, and a synthesis would archive two of
          // them behind a claim that does neither.
          !isSleepExcluded(entry.row.memory_type) &&
          entry.community !== undefined
      )
      .slice(0, COMPRESS_CANDIDATE_LIMIT)

    /** Community -> its COMPRESS-band members, both orders fixed so batching is reproducible. */
    const byCommunity = new Map<string, Array<ScoredMemory>>()
    for (const entry of candidates) {
      const label = entry.community
      if (label === undefined) continue
      const bucket = byCommunity.get(label)
      if (bucket === undefined) byCommunity.set(label, [entry])
      else bucket.push(entry)
    }

    /**
     * Both sorts are this phase's, and the kernel keeps the order they produce. Communities are
     * walked lexicographically by label so a night's call order is fixed, and each community's members
     * by `row.path` so the `m1`..`mN` keys land on the same files twice over.
     */
    const groups = [...byCommunity.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([, members]) =>
        [...members].sort((left, right) =>
          left.row.path < right.row.path ? -1 : left.row.path > right.row.path ? 1 : 0
        )
      )
    const batches = assembleBatches(groups, {
      maxMembers: COMPRESS_BATCH_SIZE,
      minMembers: COMPRESS_MIN_BATCH
    })

    const counts = {
      candidates: candidates.length,
      communities: byCommunity.size,
      batches: batches.length,
      canonicals: 0,
      archived: 0,
      skipped: 0,
      failed: 0,
      refused: 0
    }
    if (batches.length === 0) return emptyOutcome(counts)
    if (env.dryRun) return emptyOutcome(counts)

    const modelKey = modelFor(env.deps, "compress")
    let llmCalls = 0
    let canonicals = 0
    let archived = 0
    /**
     * `skipped` stays the total, and `failed` + `refused` partition it. The two are different
     * diagnoses with different fixes — a failed call is the model or the wire (already logged by
     * `isolate`), a refusal is an answer the phase declined to act on (logged below) — and a night
     * reporting only their sum cannot say which one it had. 47 of 47 batches once skipped as
     * refusals with nothing on stderr, and the sum read as flaky calls.
     */
    let skipped = 0
    let failed = 0
    let refused = 0
    let lastCommit: string | null = null

    for (const batch of batches) {
      /** Opaque keys again, so `absorbedKeys` cannot name a path. */
      const keyed = keyMembers(
        batch,
        (entry) => `${entry.row.title}\n${entry.row.gist}\n${entry.row.body_text}`,
        { charBudget: COMPRESS_MEMBER_CHARS }
      )

      llmCalls += 1
      const synthesis = yield* batchCall(model, `compress batch of ${batch.length}`, {
        schema: CompressSynthesis,
        system: COMPRESS_SYSTEM,
        prompt: compressPrompt(keyed.keyed),
        modelKey,
        effort: "high",
        toolDescription: "Emit the canonical memory and the members whose content it absorbs."
      })
      if (synthesis === undefined) {
        // The call itself failed; `isolate` already logged the reason.
        skipped += 1
        failed += 1
        continue
      }

      /** A key the batch never offered resolves to nothing, so a fold reaches only offered files. */
      const absorbed = resolveKeys(keyed, synthesis.absorbedKeys).map((entry) => entry.row.path)
      if (absorbed.length < 2 || synthesis.title.trim() === "" || synthesis.claim.trim() === "") {
        // A refusal, or a fold of a single member. Both leave every member active.
        skipped += 1
        refused += 1
        yield* Effect.logWarning(
          `sleep.llm compress batch of ${batch.length} refused: the model absorbed ` +
            `${absorbed.length} of ${synthesis.absorbedKeys.length} named keys` +
            (synthesis.absorbedKeys.length > 0 && absorbed.length === 0
              ? ` (none of the named keys resolved: ${synthesis.absorbedKeys.slice(0, 3).join(", ")}${synthesis.absorbedKeys.length > 3 ? ", …" : ""})`
              : "")
        )
        continue
      }

      /**
       * The canonical is placed in the batch's own directory when the members agree on one, and in the
       * inbox otherwise. Placing it under a member's directory keeps a compressed group where a reader
       * would look for it, and `memhtml doctor` reports inbox depth so a disagreeing batch is visible.
       */
      const directories = new Set(absorbed.map((path) => path.slice(0, path.lastIndexOf("/"))))
      const directory = directories.size === 1 ? [...directories][0] : INBOX_DIR
      const canonicalPath = `${directory ?? INBOX_DIR}/${slugify(synthesis.title)}.html`
      const members = excludeSelfSupersede(canonicalPath, absorbed)
      if (members.length === 0) {
        skipped += 1
        refused += 1
        yield* Effect.logWarning(
          `sleep.llm compress batch of ${batch.length} refused: every absorbed member was the canonical itself`
        )
        continue
      }

      /**
       * The members are archived FIRST, and the canonical is written only if at least one member was
       * actually moved. A batch whose members an earlier phase already evicted would otherwise leave a
       * canonical behind claiming to supersede files it never absorbed.
       */
      const archivedPaths: Array<string> = []
      for (const member of members) {
        const archivedPath = yield* archiveFile(env, member, [
          meta("memhtml-superseded-by", hrefFor(canonicalPath))
        ])
        if (archivedPath !== null) archivedPaths.push(archivedPath)
      }
      if (archivedPaths.length === 0) {
        skipped += 1
        refused += 1
        yield* Effect.logWarning(
          `sleep.llm compress batch of ${batch.length} refused: every member was already gone from the tree`
        )
        continue
      }

      yield* writeFileBytes(
        env,
        canonicalPath,
        renderTemplate({
          title: synthesis.title.trim(),
          claim: synthesis.claim,
          body: synthesis.paragraphs,
          memoryType: "semantic",
          at: env.at,
          author: "agent:sleep"
        })
      )
      for (const archivedPath of archivedPaths) {
        yield* stampFile(env, canonicalPath, [link("supersedes", hrefFor(archivedPath))])
      }
      yield* env.deps.git.add([canonicalPath])
      archived += archivedPaths.length
      canonicals += 1

      const commitSha = yield* commitPhase(
        env,
        "compress",
        `fold ${members.length} memories into ${synthesis.title}`,
        { ...counts, canonicals, archived, skipped, failed, refused }
      )
      if (commitSha !== null) lastCommit = commitSha
    }

    const final = { ...counts, canonicals, archived, skipped, failed, refused }
    return { counts: final, commitSha: lastCommit, llmCalls }
  })
