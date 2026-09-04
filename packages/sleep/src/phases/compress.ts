import { INBOX_DIR } from "@memhtml/contracts/paths"
import { slugify } from "@memhtml/contracts/slug"
import { excludeSelfSupersede, labelPropagation } from "@memhtml/domain"
import { renderTemplate } from "@memhtml/html"
import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import { archiveFile, hrefFor, link, meta, stampFile, writeFileBytes } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody, type PhaseEnv, takeLlmCall } from "../env.js"
import { freePathIn } from "../free-path.js"
import { COMPRESS_SYSTEM, CompressSynthesis, compressPrompt } from "../llm.js"
import { runRetentionPass, type ScoredMemory } from "../retention.js"
import {
  activeCorpus,
  datedEpisodicAmong,
  deepGroupingEdges,
  entityClaims,
  isSleepExcluded,
  memoryEdges,
  summarizedDatedRecords
} from "../sql.js"
import { mineAllBands } from "./relationship-mining.js"

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
 * **A dated episodic record is summarized by compress, never archived by it** (issue #130). Compress is
 * lossy by design, and that is the right trade for near-duplicate `semantic` memories that say the same
 * thing. A daily journal is not a restatement of the day before: it shares vocabulary and entities, so
 * it clusters, but it is the only record of its day, and a stable facet address (`day=<date>`) has to
 * keep resolving. So members that are `episodic` and carry a dated facet (`DATED_RECORD_FACETS`) are
 * absorbed into the canonical, linked from it as `relates_to`, stamped `part_of` the canonical, and
 * left active; the canonical is an entry point over them rather than a replacement. Members of every
 * other kind are archived, so one batch can archive its semantic members and keep its dated ones. The
 * `part_of` stamp is also the idempotence mark: a dated record that already carries one to an active
 * canonical (`summarizedDatedRecords`), or that this run kept in an earlier pass, is not a candidate
 * again, because being summarized changes none of its retention inputs and the pass would otherwise
 * select the same journals every night. This phase is the only one the exemption covers: retention
 * triage still evicts a dated record whose score falls into the evict band, and dedup-merge still
 * folds one that clears the near-duplicate floor; both leave the archived file in place, and the
 * search pointer (`archivedMatches`) is what makes either move legible to a faceted query.
 *
 * `dedup-merge` is a HARD prerequisite. Compressing before duplicates are folded would synthesize a
 * canonical over a pair the merge phase then archives one half of.
 *
 * ## Deep mode (issue #63)
 *
 * Under `--deep` three things change about WHICH memories a fold can reach, and nothing about what
 * happens to a fold:
 *
 * 1. **Communities come from the widened graph.** Label propagation runs over the default memory
 *    edges PLUS the deep grouping band (`laterally_related`, mined at 0.72), so inbox files whose
 *    best neighbor sits under the default 0.85 floor get a partition. Retention SCORES stay the
 *    default function — the band decides grouping, never eviction.
 * 2. **Entity groups are a second community source.** Candidates the widened graph still leaves
 *    communityless are grouped by shared `file_entities` reference under a synthetic
 *    `entity:<type>:<name>` label, because two memories about one subject can share no vocabulary at
 *    all. Hub entities (more than {@link DEEP_ENTITY_HUB_LIMIT} active claimants) are stop-words and
 *    are skipped.
 * 3. **The phase iterates until quiet.** A pass that produced canonicals re-indexes the branch,
 *    re-mines both bands, recomputes retention, and folds again — a canonical is a new neighbor and
 *    a new community member — until a pass folds nothing or {@link DEEP_COMPRESS_MAX_PASSES} hits.
 *
 * Every model call in deep mode is charged against the run's shared `--max-llm-calls` budget first;
 * an exhausted budget skips the batch with reason `budget` and the run stays green, the same
 * degradation posture a model outage has.
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

/**
 * Deep compress passes before the loop stops regardless of yield (issue #63). Each extra pass costs
 * a full re-index, a re-mine, and another round of model calls, and the third pass's yield on any
 * real corpus is folds of folds — past that the loop is spending calls to rename its own output.
 */
export const DEEP_COMPRESS_MAX_PASSES = 3

/**
 * Active files an entity may be claimed by before deep grouping treats it as a stop-word
 * (issue #63). An entity on sixty-plus files ("service:api", a person who appears everywhere) says
 * which corpus this is, not which memories are one topic, and batching its claimants would fold
 * unrelated facts for sharing a byline. Groups under the limit still slice to
 * {@link COMPRESS_BATCH_SIZE} through the same kernel as every other group.
 */
export const DEEP_ENTITY_HUB_LIMIT = 64

/** The synthetic community-label prefix entity groups use. No git path starts with this. */
export const ENTITY_LABEL_PREFIX = "entity:"

/** One pass's outcome, folded into the phase totals by the loop. */
interface PassTally {
  /** Dated episodic members a canonical was written over and which stayed active. */
  kept: number
  candidates: number
  communities: number
  entityGroups: number
  batches: number
  canonicals: number
  archived: number
  skipped: number
  failed: number
  refused: number
  budget: number
  llmCalls: number
}

/**
 * The community label of every active path under the WIDENED graph: default memory edges plus the
 * deep grouping band, one label-propagation pass (issue #63).
 *
 * Computed here rather than inside `runRetentionPass`, deliberately: retention's partition feeds
 * eviction scoring and must not move when a deep band is present in the index, so the widened
 * partition is a second, compress-only computation over reads this module already owns.
 */
export const deepCommunityLabels = (
  env: PhaseEnv
): Effect.Effect<ReadonlyMap<string, string | undefined>, never> =>
  Effect.gen(function* () {
    const corpus = yield* activeCorpus(env.deps.db)
    /**
     * The NON-DEEP edge set: `memoryEdges` is every authored and mined memory edge at the default
     * 0.85 floor, which is what the deep grouping band below widens. The name says which set it is,
     * because the two are unioned one line down and a reader has to be able to tell them apart.
     */
    const standard = yield* memoryEdges(env.deps.db)
    const band = yield* deepGroupingEdges(env.deps.db)
    return labelPropagation(
      corpus.map((row) => row.path),
      [...standard, ...band].map((edge) => ({
        src: edge.src_path,
        dst: edge.dst_path,
        strength: edge.strength
      }))
    )
  }).pipe(Effect.orElseSucceed(() => new Map<string, string | undefined>()))

/**
 * Assign an `entity:<type>:<name>` label to every candidate the graph left communityless, greedily,
 * one label per file (issue #63). PURE, so the hub cap and the one-label rule are unit-assertable
 * without a corpus.
 *
 * Entities are walked in lexicographic (type, name) order and each claims its unclaimed candidates,
 * so the assignment is a pure function of the corpus: a file naming two entities lands with the
 * lexicographically first, and the run makes the same batches twice over. A group needs two members
 * to mean anything, matching {@link COMPRESS_MIN_BATCH}.
 *
 * **The hub cap reads the entity's ACTIVE claimant count, not its needing count.** An entity on a
 * hundred files whose tail happens to leave only three in the inbox band is still a stop-word:
 * what those three share is a byline, not a topic.
 */
export const assignEntityLabels = (
  claims: ReadonlyArray<{
    readonly entity_type: string
    readonly entity_name: string
    readonly path: string
  }>,
  needing: ReadonlySet<string>
): { readonly labels: ReadonlyMap<string, string>; readonly hubsSkipped: number } => {
  const byEntity = new Map<string, Array<string>>()
  for (const claim of claims) {
    const key = `${claim.entity_type}:${claim.entity_name}`
    const bucket = byEntity.get(key)
    if (bucket === undefined) byEntity.set(key, [claim.path])
    else bucket.push(claim.path)
  }

  const labels = new Map<string, string>()
  let hubsSkipped = 0
  for (const [key, paths] of [...byEntity.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1
  )) {
    if (paths.length > DEEP_ENTITY_HUB_LIMIT) {
      hubsSkipped += 1
      continue
    }
    const members = paths.filter((path) => needing.has(path) && !labels.has(path))
    if (members.length < COMPRESS_MIN_BATCH) continue
    for (const member of members) labels.set(member, `${ENTITY_LABEL_PREFIX}${key}`)
  }
  return { labels, hubsSkipped }
}

/** {@link assignEntityLabels} over the index's own claim rows. */
const entityLabelsFor = (
  env: PhaseEnv,
  needing: ReadonlySet<string>
): Effect.Effect<{ readonly labels: ReadonlyMap<string, string>; readonly hubsSkipped: number }> =>
  entityClaims(env.deps.db).pipe(
    Effect.map((claims) => assignEntityLabels(claims, needing)),
    Effect.orElseSucceed(() => ({ labels: new Map<string, string>(), hubsSkipped: 0 }))
  )

export const compress: PhaseBody = (env) =>
  Effect.gen(function* () {
    const model = env.deps.model
    if (model === undefined) {
      return {
        ...emptyOutcome({ candidates: 0, batches: 0, canonicals: 0 }),
        detail: "no model bound"
      }
    }

    const modelKey = modelFor(env.deps, "compress")
    const passes: Array<PassTally> = []
    let lastCommit: string | null = null
    /**
     * Every canonical path this RUN has written, across batches and across deep passes. Two batches
     * whose canonicals the model titled identically slug to one path, and the second write would
     * silently replace the first — the disk probe alone cannot refuse it, because by then the first
     * canonical is a real file a probe reads as merely "taken", and before the first write it is not
     * even that. The set is the half of the taken-path question disk cannot answer; see `free-path.ts`.
     */
    const claimedCanonicals = new Set<string>()
    /** Dated members this run kept, so a later pass of the same run does not fold them again. */
    const keptThisRun = new Set<string>()

    for (let passAt = 0; passAt < (env.deep === undefined ? 1 : DEEP_COMPRESS_MAX_PASSES); ) {
      passAt += 1
      const pass = yield* runRetentionPass(env.deps.db, env.at)
      const summarized = yield* summarizedDatedRecords(env.deps.db)
      const banded = pass.scored.filter(
        (entry) =>
          entry.score.action === "compress" &&
          entry.row.memory_type !== "arc" &&
          // A fold rewrites several memories into one canonical claim. Three tasks cannot become
          // one task: each is a separate thing an agent owes, and a synthesis would archive two of
          // them behind a claim that does neither.
          !isSleepExcluded(entry.row.memory_type) &&
          // A dated record already summarized, tonight or on an earlier night, stays active and out
          // of the band: its inputs never change by being kept, so nothing else would stop the refold.
          !summarized.has(entry.row.path) &&
          !keptThisRun.has(entry.row.path)
      )

      /**
       * Which label a candidate folds under. By default: the retention pass's own community, and a
       * memory without one is not a candidate — the exact selection this phase has always made.
       * Deep: the widened partition first, then an entity label for what the graph still missed.
       */
      const widened = env.deep === undefined ? undefined : yield* deepCommunityLabels(env)
      const communityOf = (entry: ScoredMemory): string | undefined =>
        widened === undefined ? entry.community : widened.get(entry.row.path)

      const graphLabelled = banded.filter((entry) => communityOf(entry) !== undefined)
      const needing =
        env.deep === undefined
          ? new Set<string>()
          : new Set(
              banded
                .filter((entry) => communityOf(entry) === undefined)
                .map((entry) => entry.row.path)
            )
      const entities =
        env.deep === undefined
          ? { labels: new Map<string, string>(), hubsSkipped: 0 }
          : yield* entityLabelsFor(env, needing)

      const candidates = [
        ...graphLabelled,
        ...banded.filter((entry) => entities.labels.has(entry.row.path))
      ].slice(0, COMPRESS_CANDIDATE_LIMIT)

      /** Community -> its COMPRESS-band members, both orders fixed so batching is reproducible. */
      const byCommunity = new Map<string, Array<ScoredMemory>>()
      for (const entry of candidates) {
        const label = communityOf(entry) ?? entities.labels.get(entry.row.path)
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

      const tally: PassTally = {
        candidates: candidates.length,
        communities: byCommunity.size,
        entityGroups: new Set(entities.labels.values()).size,
        batches: batches.length,
        canonicals: 0,
        archived: 0,
        kept: 0,
        skipped: 0,
        failed: 0,
        refused: 0,
        budget: 0,
        llmCalls: 0
      }
      passes.push(tally)
      if (batches.length === 0 || env.dryRun) break

      for (const batch of batches) {
        /** Opaque keys again, so `absorbedKeys` cannot name a path. */
        const keyed = keyMembers(
          batch,
          (entry) => `${entry.row.title}\n${entry.row.gist}\n${entry.row.body_text}`,
          { charBudget: COMPRESS_MEMBER_CHARS }
        )

        /**
         * The deep budget is charged BEFORE the call, and an exhausted budget is its own skip
         * reason: a night that stopped because the operator's cap ran out and a night whose model
         * fell over need different mornings-after, and `skipped` alone cannot say which this was.
         */
        if (!takeLlmCall(env.deep)) {
          tally.skipped += 1
          tally.budget += 1
          continue
        }

        tally.llmCalls += 1
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
          tally.skipped += 1
          tally.failed += 1
          continue
        }

        /** A key the batch never offered resolves to nothing, so a fold reaches only offered files. */
        const absorbed = resolveKeys(keyed, synthesis.absorbedKeys).map((entry) => entry.row.path)
        if (absorbed.length < 2 || synthesis.title.trim() === "" || synthesis.claim.trim() === "") {
          // A refusal, or a fold of a single member. Both leave every member active.
          tally.skipped += 1
          tally.refused += 1
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
        const canonicalDir = directory ?? INBOX_DIR
        const barePath = `${canonicalDir}/${slugify(synthesis.title)}.html`

        /**
         * The canonical's path is PROBED before anything moves. A title's slug is not unique: a
         * batch can slug onto a file outside the batch — a memory a human hand-corrected, another
         * batch's canonical from this same run — and the unprobed write silently replaced it as a
         * MODIFY no report line mentioned. The one collision that is NOT a collision is a bare path
         * that is itself an ABSORBED member: folding into a member is this phase's own design (see
         * the module header on `excludeSelfSupersede`), the member's content is carried forward, and
         * the write is the fold. Every other occupant gets an ordinal via the shared probe.
         */
        const canonicalPath = absorbed.includes(barePath)
          ? barePath
          : yield* freePathIn(env, canonicalDir, slugify(synthesis.title), claimedCanonicals)
        if (canonicalPath === undefined) {
          tally.skipped += 1
          tally.refused += 1
          yield* Effect.logWarning(
            `sleep.llm compress batch of ${batch.length} refused: every collision ordinal for ` +
              `"${synthesis.title.trim()}" is taken, so no member was archived`
          )
          continue
        }
        const members = excludeSelfSupersede(canonicalPath, absorbed)
        if (members.length === 0) {
          tally.skipped += 1
          tally.refused += 1
          yield* Effect.logWarning(
            `sleep.llm compress batch of ${batch.length} refused: every absorbed member was the canonical itself`
          )
          continue
        }

        /**
         * Dated episodic members are kept active and linked from the canonical; the rest are archived
         * FIRST, and the canonical is written only if at least one member was actually moved or kept.
         * A batch whose members an earlier phase already evicted would otherwise leave a canonical
         * behind claiming to supersede files it never absorbed.
         */
        const kept = yield* datedEpisodicAmong(env.deps.db, members)
        const archivedPaths: Array<string> = []
        for (const member of members) {
          if (kept.has(member)) continue
          const archivedPath = yield* archiveFile(env, member, [
            meta("memhtml-superseded-by", hrefFor(canonicalPath))
          ])
          if (archivedPath !== null) archivedPaths.push(archivedPath)
        }
        if (archivedPaths.length === 0 && kept.size === 0) {
          tally.skipped += 1
          tally.refused += 1
          yield* Effect.logWarning(
            `sleep.llm compress batch of ${batch.length} refused: every member was already gone from the tree`
          )
          continue
        }

        /**
         * Claimed at the WRITE, not at the allocation: a batch that bails between the two (every
         * member already gone) never occupied the path, so a later batch may still take it. Once
         * written the bytes are on disk and the probe would refuse it anyway; the set is the
         * belt-and-braces half for any window where the write has been decided but not yet flushed.
         */
        claimedCanonicals.add(canonicalPath)
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
        // The kept members stay where they are. The canonical points at them, and each of them is
        // stamped `part_of` the canonical: the record that keeps the next pass from folding them again,
        // and the hop that leads a reader from the journal to its summary. Neither is a supersession, so
        // `git log --follow` on a journal reads one unbroken life.
        for (const member of members) {
          if (!kept.has(member)) continue
          yield* stampFile(env, canonicalPath, [link("relates_to", hrefFor(member))])
          yield* stampFile(env, member, [link("part_of", hrefFor(canonicalPath))])
          keptThisRun.add(member)
        }
        yield* env.deps.git.add([canonicalPath])
        tally.archived += archivedPaths.length
        tally.kept += kept.size
        tally.canonicals += 1

        const commitSha = yield* commitPhase(
          env,
          "compress",
          `fold ${members.length} memories into ${synthesis.title}`,
          totalsOf(passes)
        )
        if (commitSha !== null) lastCommit = commitSha
      }

      /**
       * Iterate-until-quiet, deep only (issue #63). A pass that folded nothing has reached the
       * fixed point; one that folded something changed the neighbor structure, so the branch is
       * re-indexed (renames tracked, new canonicals embedded), both bands are re-mined over the new
       * vectors, and the next pass sees the canonicals as members. A run without `--deep` exits
       * here unconditionally, which is what keeps its behavior single-pass and byte-identical.
       */
      if (env.deep === undefined || tally.canonicals === 0) break
      if (passAt >= DEEP_COMPRESS_MAX_PASSES) break
      yield* env.deps.indexer.update({ embed: true })
      yield* mineAllBands(env)
    }

    return {
      counts: totalsOf(passes),
      commitSha: lastCommit,
      llmCalls: passes.reduce((total, tally) => total + tally.llmCalls, 0)
    }
  })

/**
 * The pass tallies as one counts record. Work counters SUM across passes; `candidates` and
 * `communities` describe the corpus the run STARTED from (the first pass), because a sum of
 * re-scans of one shrinking corpus counts nothing a reviewer can reconcile. On a default
 * single-pass run the keys are the single-pass set plus `kept`, and the deep-only keys appear only
 * when a deep quantity is nonzero or a second pass ran,
 * which cannot happen without the flag. Response counts are append-only, so the deep keys are
 * additions and no shipped key changes meaning.
 */
const totalsOf = (passes: ReadonlyArray<PassTally>): Record<string, number> => {
  const first = passes[0]
  const sum = (of: (tally: PassTally) => number): number =>
    passes.reduce((total, tally) => total + of(tally), 0)
  const deepish =
    passes.length > 1 || (first?.entityGroups ?? 0) > 0 || sum((tally) => tally.budget) > 0
  return {
    candidates: first?.candidates ?? 0,
    communities: first?.communities ?? 0,
    batches: sum((tally) => tally.batches),
    canonicals: sum((tally) => tally.canonicals),
    archived: sum((tally) => tally.archived),
    kept: sum((tally) => tally.kept),
    skipped: sum((tally) => tally.skipped),
    failed: sum((tally) => tally.failed),
    refused: sum((tally) => tally.refused),
    ...(deepish
      ? {
          passes: passes.length,
          entityGroups: first?.entityGroups ?? 0,
          budgetSkipped: sum((tally) => tally.budget)
        }
      : {})
  }
}
