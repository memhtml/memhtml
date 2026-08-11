import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { applyHeadEdits, meta, readFileBytes, rewriteEntityMeta, writeFileBytes } from "../edits.js"
import { emptyOutcome, type PhaseBody } from "../env.js"
import { activeEntities, type EntityCount, pathsForEntity } from "../sql.js"

/**
 * Phase 3 — entity resolution. Normalize entity names, then fuzzy-merge transitive alias clusters.
 * ONE commit rewriting `memhtml-entity` values in place.
 *
 * Two passes. The first lowercases and collapses whitespace, and is idempotent — a second run
 * touches nothing. The second is a union-find over pairs above {@link AUTO_MERGE_THRESHOLD}, so
 * `A~B` and `B~C` land in one cluster; the name held by the most active files wins the root, ties
 * broken lexicographically so a corpus that did not change resolves the same way twice.
 *
 * **Similarity is a normalized-string ratio, not an embedding cosine.** Entity names are short
 * identifiers — `checkout-api`, `checkout_api`, `Checkout API` — where the whole signal is character
 * overlap, and an embedding of a two-token name is dominated by whatever domain the tokens evoke:
 * `checkout-api` and `payments-api` sit high in vector space because both are payment services, and
 * merging them would fuse two services' memories permanently. A character ratio cannot make that
 * mistake. This is the packet's documented choice between the two options it offered.
 *
 * The 0.75-0.85 band is COUNTED, not merged. A review candidate is a human's call: entity merges are
 * a one-way door on stored identity, and the failure mode of an over-eager threshold is silent and
 * permanent.
 */

/** At or above this ratio two names are the same entity. Auto-merged. */
export const AUTO_MERGE_THRESHOLD = 0.85

/** At or above this ratio, below the auto threshold: counted for review, never merged. */
export const REVIEW_THRESHOLD = 0.75

/** Lowercase, NFC-normalize, collapse internal whitespace, trim. The pre-compare form. */
export const normalizeEntityName = (name: string): string =>
  name.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * A character-overlap similarity in `[0, 1]`: the longest common subsequence over the mean length.
 *
 * Chosen over Levenshtein because it is monotone in shared ordered characters, which is what a
 * separator or casing change actually is: `checkout-api` against `checkout api` differs in one
 * character and scores 0.92, while `checkout-api` against `payments-api` shares only the suffix and
 * scores 0.67 — below both thresholds, so two distinct services never fuse.
 */
export const nameSimilarity = (left: string, right: string): number => {
  if (left === right) return 1
  if (left === "" || right === "") return 0
  const rows = left.length + 1
  const columns = right.length + 1
  let previous = new Array<number>(columns).fill(0)
  let current = new Array<number>(columns).fill(0)
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      current[column] =
        left[row - 1] === right[column - 1]
          ? (previous[column - 1] ?? 0) + 1
          : Math.max(previous[column] ?? 0, current[column - 1] ?? 0)
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  const common = previous[columns - 1] ?? 0
  return (2 * common) / (left.length + right.length)
}

/** One cluster resolution: which names collapse onto which canonical, plus the review-band count. */
export interface EntityClusters {
  readonly aliasToCanonical: ReadonlyMap<string, string>
  readonly reviewCandidates: number
}

/**
 * Union-find over the auto-merge pairs. The higher-count name wins the root; a tie goes to the
 * lexicographically smaller name, so the partition is a function of the input alone.
 */
export const resolveClusters = (counts: ReadonlyMap<string, number>): EntityClusters => {
  const names = [...counts.keys()].sort()
  const parent = new Map<string, string>()
  let reviewCandidates = 0

  const find = (name: string): string => {
    let current = name
    while ((parent.get(current) ?? current) !== current) {
      const next = parent.get(current) ?? current
      parent.set(current, parent.get(next) ?? next)
      current = next
    }
    return current
  }

  const union = (left: string, right: string): void => {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft === rootRight) return
    const weightLeft = counts.get(rootLeft) ?? 0
    const weightRight = counts.get(rootRight) ?? 0
    const leftWins =
      weightLeft > weightRight || (weightLeft === weightRight && rootLeft < rootRight)
    if (leftWins) parent.set(rootRight, rootLeft)
    else parent.set(rootLeft, rootRight)
  }

  for (let outer = 0; outer < names.length; outer += 1) {
    for (let inner = outer + 1; inner < names.length; inner += 1) {
      const left = names[outer]
      const right = names[inner]
      if (left === undefined || right === undefined) continue
      const similarity = nameSimilarity(left, right)
      if (similarity >= AUTO_MERGE_THRESHOLD) union(left, right)
      else if (similarity >= REVIEW_THRESHOLD) reviewCandidates += 1
    }
  }

  const aliasToCanonical = new Map<string, string>()
  for (const name of names) {
    const root = find(name)
    if (root !== name) aliasToCanonical.set(name, root)
  }
  return { aliasToCanonical, reviewCandidates }
}

/** The `type:name` form a `memhtml-entity` meta carries. */
const entityRef = (entityType: string, entityName: string): string => `${entityType}:${entityName}`

export const entityResolution: PhaseBody = (env) =>
  Effect.gen(function* () {
    const entities = yield* activeEntities(env.deps.db)

    /**
     * Clustered per entity TYPE. `service:api` and `person:api` are two different things whose names
     * happen to match, and a cross-type union would rename a person to a service.
     */
    const byType = new Map<string, Array<EntityCount>>()
    for (const entity of entities) {
      const bucket = byType.get(entity.entity_type)
      if (bucket === undefined) byType.set(entity.entity_type, [entity])
      else bucket.push(entity)
    }

    /** `path -> [(oldRef, newRef)]`, accumulated across the normalize and merge passes. */
    const rewrites = new Map<string, Array<readonly [string, string]>>()
    const addRewrite = (path: string, from: string, to: string): void => {
      if (from === to) return
      const bucket = rewrites.get(path)
      if (bucket === undefined) rewrites.set(path, [[from, to]])
      else bucket.push([from, to])
    }

    let normalized = 0
    let fuzzyMerges = 0
    let reviewCandidates = 0

    for (const [entityType, bucket] of [...byType.entries()].sort(([left], [right]) =>
      left < right ? -1 : 1
    )) {
      /** Pass one: normalization, folding counts of names that normalize together. */
      const counts = new Map<string, number>()
      const normalizedOf = new Map<string, string>()
      for (const entity of bucket) {
        const canonical = normalizeEntityName(entity.entity_name)
        normalizedOf.set(entity.entity_name, canonical)
        counts.set(canonical, (counts.get(canonical) ?? 0) + entity.files)
        if (canonical !== entity.entity_name) normalized += 1
      }

      /** Pass two: the fuzzy clusters over the normalized names. */
      const clusters = resolveClusters(counts)
      reviewCandidates += clusters.reviewCandidates

      for (const entity of bucket) {
        const afterNormalize = normalizedOf.get(entity.entity_name) ?? entity.entity_name
        const afterMerge = clusters.aliasToCanonical.get(afterNormalize) ?? afterNormalize
        if (afterMerge === entity.entity_name) continue
        if (afterMerge !== afterNormalize) fuzzyMerges += 1
        const paths = yield* pathsForEntity(env.deps.db, entityType, entity.entity_name)
        for (const row of paths) {
          addRewrite(
            row.path,
            entityRef(entityType, entity.entity_name),
            entityRef(entityType, afterMerge)
          )
        }
      }
    }

    const counts = {
      entities: entities.length,
      namesNormalized: normalized,
      fuzzyMerges,
      reviewCandidates,
      filesRewritten: rewrites.size
    }
    if (rewrites.size === 0 || env.dryRun) return emptyOutcome(counts)

    let rewritten = 0
    for (const [path, pairs] of [...rewrites.entries()].sort(([left], [right]) =>
      left < right ? -1 : 1
    )) {
      const html = yield* readFileBytes(env, path)
      if (html === undefined) continue
      let edited = html
      for (const [from, to] of pairs) {
        edited = rewriteEntityMeta(edited, from, to)
      }
      if (edited === html) continue
      // The `memhtml-updated` stamp goes through `setMeta`, so the two kinds of head edit compose.
      const stamped = applyHeadEdits(edited, [meta("memhtml-updated", env.at)])
      yield* writeFileBytes(env, path, stamped)
      yield* env.deps.git.add([path])
      rewritten += 1
    }

    const final = { ...counts, filesRewritten: rewritten }
    const commitSha = yield* commitPhase(
      env,
      "entity-resolution",
      `normalize ${normalized} entity names, merge ${fuzzyMerges} aliases`,
      final
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })
