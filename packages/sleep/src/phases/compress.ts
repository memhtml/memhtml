import { INBOX_DIR } from "@memhtml/contracts/paths"
import { slugify } from "@memhtml/contracts/slug"
import { excludeSelfSupersede } from "@memhtml/domain"
import { renderTemplate } from "@memhtml/html"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { archiveFile, hrefFor, link, meta, stampFile, writeFileBytes } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody } from "../env.js"
import { COMPRESS_SYSTEM, CompressSynthesis, compressPrompt, isolate } from "../llm.js"
import { runRetentionPass, type ScoredMemory } from "../retention.js"
import { isSleepExcluded } from "../sql.js"

/**
 * Phase 10, compress. COMPRESS-band memories grouped by community, folded into a synthesized
 * canonical in batches. ONE COMMIT PER BATCH.
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

    const batches: Array<ReadonlyArray<ScoredMemory>> = []
    for (const [, members] of [...byCommunity.entries()].sort(([left], [right]) =>
      left < right ? -1 : 1
    )) {
      const ordered = [...members].sort((left, right) =>
        left.row.path < right.row.path ? -1 : left.row.path > right.row.path ? 1 : 0
      )
      // A batch of one is not a fold. Skipping it is what keeps the phase from rewriting a lone
      // memory into a "canonical" that says the same thing under a new path.
      for (let at = 0; at < ordered.length; at += COMPRESS_BATCH_SIZE) {
        const slice = ordered.slice(at, at + COMPRESS_BATCH_SIZE)
        if (slice.length >= 2) batches.push(slice)
      }
    }

    const counts = {
      candidates: candidates.length,
      communities: byCommunity.size,
      batches: batches.length,
      canonicals: 0,
      archived: 0,
      skipped: 0
    }
    if (batches.length === 0) return emptyOutcome(counts)
    if (env.dryRun) return emptyOutcome(counts)

    const modelKey = modelFor(env.deps, "compress")
    let llmCalls = 0
    let canonicals = 0
    let archived = 0
    let skipped = 0
    let lastCommit: string | null = null

    for (const batch of batches) {
      /** Opaque keys again, so `absorbedKeys` cannot name a path. */
      const keyed = batch.map((entry, offset) => ({
        key: `m${offset + 1}`,
        path: entry.row.path,
        title: entry.row.title,
        text: `${entry.row.title}\n${entry.row.gist}\n${entry.row.body_text}`.slice(
          0,
          COMPRESS_MEMBER_CHARS
        )
      }))
      const pathForKey = new Map(keyed.map((entry) => [entry.key, entry.path]))

      llmCalls += 1
      const synthesis = yield* isolate(
        `compress batch of ${batch.length}`,
        model.generateObject({
          schema: CompressSynthesis,
          system: COMPRESS_SYSTEM,
          prompt: compressPrompt(keyed.map((entry) => ({ key: entry.key, text: entry.text }))),
          modelKey,
          effort: "high",
          toolDescription: "Emit the canonical memory and the members whose content it absorbs."
        })
      )
      if (synthesis === undefined) {
        skipped += 1
        continue
      }

      const absorbed = [
        ...new Set(
          synthesis.absorbedKeys.flatMap((key) => {
            const path = pathForKey.get(key)
            return path === undefined ? [] : [path]
          })
        )
      ]
      if (absorbed.length < 2 || synthesis.title.trim() === "" || synthesis.claim.trim() === "") {
        // A refusal, or a fold of a single member. Both leave every member active.
        skipped += 1
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
        { ...counts, canonicals, archived, skipped }
      )
      if (commitSha !== null) lastCommit = commitSha
    }

    const final = { ...counts, canonicals, archived, skipped }
    return { counts: final, commitSha: lastCommit, llmCalls }
  })
