import { normalizeEntityName, PERSON_ENTITY_PREFIX } from "@memhtml/contracts/types"
import { cosine } from "@memhtml/domain"
import { parseMemory } from "@memhtml/html"
import type { GitFailure } from "@memhtml/store"
import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, offeredKeyFor, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import type { PendingMark } from "../contract.js"
import { pendingMarksPath, recordPendingMarks } from "../contract.js"
import { applyHeadEdits, meta, readFileBytes, rewriteEntityMeta, writeFileBytes } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody, type PhaseEnv, type SleepError } from "../env.js"
import { ENTITY_CLUSTER_SYSTEM, EntityClustering, entityClusterPrompt } from "../llm.js"
import {
  activeEntities,
  bumpEntityCorroboration,
  type EntityClaim,
  type EntityCount,
  entityClaims,
  entityVectors,
  pathsForEntity,
  peoplePaths
} from "../sql.js"
import { budgetFor, closeVanishedDetections, detectionKey, mintDetectedTask } from "../tasks.js"

/**
 * Phase 3, entity resolution. Cluster one entity type's names into subjects, then rewrite each alias
 * onto its canonical. ONE commit rewriting `memhtml-entity` values in place.
 *
 * Three stages, and the separation is what makes the phase safe:
 *
 * 1. **Pre (deterministic, cheap).** Normalize every name, exact-merge the ones that normalize
 *    together, auto-merge pairs at or above {@link AUTO_MERGE_THRESHOLD} character overlap, and merge
 *    every pair a person file DECLARES ({@link aliasPairs}). This pass alone is the whole phase when no
 *    model is bound, so a credential-free run still collapses `Checkout API` onto `checkout api` and
 *    still applies a seeded declaration. The same pass computes one MEMORY CENTROID per name, in
 *    O(files) and never per pair.
 * 2. **Core (one model call per entity type, sharded at {@link ENTITY_BATCH_SIZE}).** The model sees
 *    every name of one type as a numbered member list and returns a PARTITION into subjects. Never one
 *    call per pair: 59 entities on the measured corpus is one call, and the pair space is 1,711.
 * 3. **Post (deterministic, the one-way-door guards).** Which name survives a merge is decided by
 *    {@link unionPairs}'s weight-then-lexicographic rule and never by the model. All THREE pair sources
 *    — the character pass, the declarations, and the model — feed that ONE union-find, so no two of them
 *    can disagree about a canonical. A merge backed by a DECLARED alias applies at once and is never
 *    counted; a merge the model alone proposes is counted in `state.entity_corroboration` and applies
 *    only once {@link ENTITY_PROMOTION_DETECTIONS} different nights have reached it.
 *
 * **Why the model, and why centroids as its evidence.** Character overlap is measurably wrong on the
 * case this phase exists for. Measured on the live corpus: `laith` against `laith al-saadoon` scores
 * 0.476 and `sanju` against `sanju kumar` 0.625 — below even the 0.75 review band — so a short name and
 * its full form are structurally invisible to a character ratio, and the phase minted two person files
 * for one person. The signal that does separate them is not the name string but WHAT IS WRITTEN under
 * each name: the centroid of the vectors of every memory claiming a name. Two spellings of one person
 * have near-identical centroids; `checkout-api` and `payments-api` do not, however close their strings
 * or their domain.
 *
 * The centroid is EVIDENCE HANDED TO THE MODEL, not a threshold. A cosine floor over centroids would
 * make exactly the mistake a bare character ratio avoids, because two services in one domain are
 * written about in the same terms. What the deterministic code keeps is the part a threshold is good
 * at: the confidence floor, the corroboration count, and the choice of which name survives.
 *
 * **The `promoted` flag is PROPOSED, not set.** The rewritten `memhtml-entity` metas live on the sleep
 * branch and go away with `git branch -D`; `entity_corroboration.promoted` lives in
 * `.memhtml/state.db`, which no discard can undo and no index rebuild can re-derive. Setting it here
 * would make the abort partial in the direction that lies: the plane would assert that every file
 * claiming the alias now names the canonical, across a corpus that carries none of it. So the phase
 * records an `entity-promoted` `PendingMark` in the run's ledger and `merge` applies it once the
 * rewrites are on `main`. The `detections` counter is bumped DURING the phase and deliberately so — it
 * counts nights on which a model read the corpus and proposed the merge, which a discarded night did.
 *
 * **Every band that does not merge is COUNTED, not merged.** The 0.75-0.85 character band the model did
 * not cluster, and a cluster below {@link ENTITY_CONFIDENCE_FLOOR}, both land in `reviewCandidates`. An
 * entity merge is a one-way door on stored identity: no later commit separates two subjects whose
 * memories were fused, and the failure mode of an over-eager gate is silent and permanent.
 *
 * **And every one of them now also becomes a TASK.** `reviewCandidates: 2` in a report is issue #44's
 * motivating example of the failure this phase had: a decision the night deliberately deferred to a
 * human, reported as a number and then never seen again. A deferred decision IS a task, so
 * {@link mintReviewTasks} opens one per pair with the band, the score, and each name's file count as
 * its evidence, keyed so tomorrow refreshes rather than duplicates, and closed when the pair stops
 * being a candidate — because the pair merging, or the names disappearing, means the question is
 * answered. The counter survives beside it: the count says how many pairs the night deferred and the
 * tasks are the ones a human can act on.
 */

/** At or above this ratio two names are the same entity. Auto-merged with no model call. */
export const AUTO_MERGE_THRESHOLD = 0.85

/** At or above this ratio, below the auto threshold: counted for review, left unmerged. */
export const REVIEW_THRESHOLD = 0.75

/**
 * Confidence a model-proposed cluster must clear before it is even counted toward a merge.
 *
 * The same floor {@link STANCE_CONFIDENCE_FLOOR} sets for a contradiction, for the same reason: a false
 * merge is worse than a missed one, and this floor and the corroboration gate are two independent
 * guards on one door. A cluster below it is reported as a review candidate and nothing else.
 */
export const ENTITY_CONFIDENCE_FLOOR = 0.7

/** Nights a model-only merge must be proposed on before it is written into the files. */
export const ENTITY_PROMOTION_DETECTIONS = 2

/**
 * Names offered per model call. One type's whole name list fits one call at the measured corpus size
 * (59 entities); this is the shard boundary for a corpus that outgrows that.
 */
export const ENTITY_BATCH_SIZE = 500

/**
 * Names of one type fed to the QUADRATIC passes: the character pair pass and the centroid
 * neighbor scan. The same explicit-cap posture as compress's {@link DEEP_ENTITY_HUB_LIMIT}, because
 * both passes are O(n²) in the name count and nothing else in the phase bounds them —
 * {@link ENTITY_BATCH_SIZE} shards only the PROMPT, after the pair space has already been walked.
 * At this cap the pair space is 124,750: an LCS per pair for the character pass and a cosine per
 * pair for the neighbor scan, which is the work one type costs tonight at most. An uncapped type of
 * ten thousand names is 50 million LCS computations, each itself O(len²).
 *
 * The cap keeps the HIGHEST-SIGNAL names — most active claiming files first, ties lexicographic —
 * because a name's file count is how much corpus a merge of it would touch. A dropped name still
 * gets pass-one normalization and still applies a declared alias ({@link aliasPairs} reads the full
 * count map); what it forgoes is fuzzy matching and a seat in the model call. Drops are counted in
 * `namesCapped`, so a night that capped says so instead of reading as a night with nothing to merge.
 * At or below the cap the behavior is byte-identical to an uncapped pass.
 */
export const ENTITY_QUADRATIC_NAME_LIMIT = 500

/**
 * The highest-signal `limit` names: most files first, ties broken lexicographically so the kept set
 * is a function of the counts alone. PURE, so the cap and the tie-break are unit-assertable.
 * A map at or under the limit is returned as-is, which is what makes the cap invisible below it.
 */
export const capQuadraticNames = (
  counts: ReadonlyMap<string, number>,
  limit: number
): { readonly kept: ReadonlyMap<string, number>; readonly dropped: number } => {
  if (counts.size <= limit) return { kept: counts, dropped: 0 }
  const kept = new Map(
    [...counts.entries()]
      .sort(([leftName, leftFiles], [rightName, rightFiles]) =>
        leftFiles !== rightFiles ? rightFiles - leftFiles : leftName < rightName ? -1 : 1
      )
      .slice(0, limit)
  )
  return { kept, dropped: counts.size - kept.size }
}

/** Memory titles shown per name. Enough to say what a name is about, few enough to stay cheap. */
export const ENTITY_SAMPLE_TITLES = 3

/** Centroid neighbors shown per name, nearest first. */
export const ENTITY_NEIGHBORS = 3

/** Characters of each member's evidence block shown. A name plus three titles fits comfortably. */
export const ENTITY_MEMBER_CHARS = 600

/**
 * The one entity type the alias oracle speaks for, derived from the prefix rather than retyped.
 *
 * A declaration lives in a person file, and `resources/people/` is the only directory the format gives
 * a hand-edited identity surface. A service has no equivalent file to declare from, so offering an
 * `aliases` line for one would show the model a field that is always empty.
 */
const PERSON_TYPE = PERSON_ENTITY_PREFIX.slice(0, -1)

/**
 * Lowercase, NFC-normalize, collapse internal whitespace, trim. The pre-compare form.
 *
 * Re-exported from `@memhtml/contracts` rather than defined here, because the projection into
 * `file_entities` and the `entity` scope predicate apply the same rule. A second copy would let this
 * phase cluster on one spelling while the index stored and matched another, and nothing would fail —
 * the corroboration counter would just count merges of names that no query could reach.
 */
export { normalizeEntityName }

/**
 * A character-overlap similarity in `[0, 1]`: the longest common subsequence over the mean length.
 *
 * Chosen over Levenshtein because it is monotone in shared ordered characters, which is what a
 * separator or casing change actually is. `checkout-api` against `checkout api` differs in one
 * character and scores 0.92, while `checkout-api` against `payments-api` shares only the suffix and
 * scores 0.67. That sits below both thresholds, so two distinct services stay separate.
 *
 * It is the pre-pass and not the decision core. Its blind spot is short-name-against-full-name, which
 * is what the model call exists for.
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

/** One unordered name pair, as the pair passes produce and consume them. */
export type NamePair = readonly [string, string]

/** A pair as a stable key, so a set of pairs is order-independent. */
export const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`

/**
 * Union-find over an explicit pair list. The higher-count name wins the root; a tie goes to the
 * lexicographically smaller name.
 *
 * **This is the one place a canonical name is chosen, and every merge routes through it.** The
 * character pass, the alias oracle, and the model all contribute PAIRS to one call, so `A~B` from the
 * character ratio and `B~C` from the model land in one cluster with one root. Two separate union-finds
 * would let the two passes disagree about which name survives, and the rewrite would then depend on
 * which pass ran first.
 *
 * `names` is walked in sorted order and the pairs in the order given, so the partition is a function of
 * the input alone and a corpus that did not change resolves the same way twice.
 */
export const unionPairs = (
  counts: ReadonlyMap<string, number>,
  pairs: ReadonlyArray<NamePair>
): ReadonlyMap<string, string> => {
  const names = [...counts.keys()].sort()
  const parent = new Map<string, string>()

  const find = (name: string): string => {
    let current = name
    while ((parent.get(current) ?? current) !== current) {
      const next = parent.get(current) ?? current
      parent.set(current, parent.get(next) ?? next)
      current = next
    }
    return current
  }

  for (const [left, right] of pairs) {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft === rootRight) continue
    const weightLeft = counts.get(rootLeft) ?? 0
    const weightRight = counts.get(rootRight) ?? 0
    const leftWins =
      weightLeft > weightRight || (weightLeft === weightRight && rootLeft < rootRight)
    if (leftWins) parent.set(rootRight, rootLeft)
    else parent.set(rootLeft, rootRight)
  }

  const aliasToCanonical = new Map<string, string>()
  for (const name of names) {
    const root = find(name)
    if (root !== name) aliasToCanonical.set(name, root)
  }
  return aliasToCanonical
}

/** The character pass's verdict on every pair of one type's names. */
export interface CharacterPairs {
  /** At or above {@link AUTO_MERGE_THRESHOLD}. Merged with no model call. */
  readonly auto: ReadonlyArray<NamePair>
  /** In the review band. Merged only if the model clusters them and the post-pass lets it. */
  readonly review: ReadonlyArray<NamePair>
}

/**
 * Every pair of one type's names, split at the two thresholds. Names are walked in sorted order, so
 * the pair list is a function of the name set alone.
 */
export const characterPairs = (names: ReadonlyArray<string>): CharacterPairs => {
  const sorted = [...names].sort()
  const auto: Array<NamePair> = []
  const review: Array<NamePair> = []
  for (let outer = 0; outer < sorted.length; outer += 1) {
    for (let inner = outer + 1; inner < sorted.length; inner += 1) {
      const left = sorted[outer]
      const right = sorted[inner]
      if (left === undefined || right === undefined) continue
      const similarity = nameSimilarity(left, right)
      if (similarity >= AUTO_MERGE_THRESHOLD) auto.push([left, right])
      else if (similarity >= REVIEW_THRESHOLD) review.push([left, right])
    }
  }
  return { auto, review }
}

/** One cluster resolution: which names collapse onto which canonical, plus the review-band count. */
export interface EntityClusters {
  readonly aliasToCanonical: ReadonlyMap<string, string>
  readonly reviewCandidates: number
}

/**
 * The deterministic pre-pass over one type's names: auto-merge the character clusters, count the band.
 *
 * The whole phase when no model is bound, and the first of three pair sources when one is. The
 * review-band count here is provisional — the phase subtracts a band pair the model went on to cluster,
 * because a pair a later stage decided is not still awaiting a human.
 */
export const resolveClusters = (counts: ReadonlyMap<string, number>): EntityClusters => {
  const pairs = characterPairs([...counts.keys()])
  return {
    aliasToCanonical: unionPairs(counts, pairs.auto),
    reviewCandidates: pairs.review.length
  }
}

/**
 * One name's evidence: how many memories claim it, what they are titled, and where it sits in vector
 * space. `vec` is absent when no claiming memory has a usable vector.
 */
export interface EntityCentroid {
  /** The NORMALIZED name. The model never sees an un-normalized variant, since pass one merged them. */
  readonly name: string
  /** Distinct active memories claiming it. */
  readonly memories: number
  readonly titles: ReadonlyArray<string>
  /** The L2-normalized mean of its members' vectors, or absent when it has none. */
  readonly vec: Float64Array | undefined
}

/**
 * One memory centroid per normalized name, per entity type, in ONE pass over the claims.
 *
 * **Members are summed in SORTED PATH order, and that is a determinism requirement rather than tidiness.**
 * Floating-point addition is not associative — `1 + 1e-16 + 1e-16` is `1` and `1e-16 + 1e-16 + 1` is
 * `1.0000000000000002` (probed on node 24.19.0, in float64) — so a centroid summed in a different order
 * is different bytes, and different bytes reorder the nearest-neighbor list the model is shown. Two
 * nights over an unchanged corpus have to produce the same prompt, so the order is fixed here rather
 * than inherited from whatever order the rows arrived in.
 *
 * **A path claiming one name twice contributes its vector ONCE.** A file may carry both
 * `Service:Checkout-API` and `service:checkout-api`, two `file_entities` rows that normalize together,
 * and summing that memory twice would let one file's authoring quirk double its own weight in the
 * centroid.
 *
 * Accumulated in float64 over float32 inputs, because the sum of n unit vectors is not a unit vector
 * and float32 would round each partial sum. Cost is O(files), never O(names²).
 */
export const entityCentroids = (
  claims: ReadonlyArray<EntityClaim>,
  vectorForPath: ReadonlyMap<string, Float32Array>,
  options?: { readonly sampleTitles?: number | undefined }
): ReadonlyMap<string, ReadonlyArray<EntityCentroid>> => {
  const sampleTitles = options?.sampleTitles ?? ENTITY_SAMPLE_TITLES

  /** `type` -> normalized name -> its distinct claiming paths, and each path's title. */
  const byType = new Map<string, Map<string, Map<string, string>>>()
  for (const claim of claims) {
    const name = normalizeEntityName(claim.entity_name)
    if (name === "") continue
    let names = byType.get(claim.entity_type)
    if (names === undefined) {
      names = new Map()
      byType.set(claim.entity_type, names)
    }
    let paths = names.get(name)
    if (paths === undefined) {
      paths = new Map()
      names.set(name, paths)
    }
    paths.set(claim.path, claim.title)
  }

  const out = new Map<string, ReadonlyArray<EntityCentroid>>()
  for (const [entityType, names] of byType) {
    const centroids: Array<EntityCentroid> = []
    for (const name of [...names.keys()].sort()) {
      const paths = names.get(name)
      if (paths === undefined) continue
      const sorted = [...paths.keys()].sort()
      centroids.push({
        name,
        memories: sorted.length,
        titles: sorted.slice(0, sampleTitles).flatMap((path) => {
          const title = paths.get(path)
          return title === undefined || title.trim() === "" ? [] : [title.trim()]
        }),
        vec: meanVector(sorted.flatMap((path) => vectorForPath.get(path) ?? []))
      })
    }
    // Sorted by name, so the member list a batch offers — and therefore the `m1`..`mN` keys — is a
    // function of the corpus and not of the order the rows came back in.
    out.set(entityType, centroids)
  }
  return out
}

/**
 * The L2-normalized mean of vectors summed in the order given, or absent for an empty or zero set.
 *
 * Normalized so a cosine between two centroids does not depend on how many memories each was built
 * from, and so a one-memory name and a fifty-memory name are comparable at all.
 */
const meanVector = (vectors: ReadonlyArray<Float32Array>): Float64Array | undefined => {
  const first = vectors[0]
  if (first === undefined) return undefined
  const sum = new Float64Array(first.length)
  for (const vector of vectors) {
    const width = Math.min(sum.length, vector.length)
    for (let at = 0; at < width; at += 1) sum[at] = (sum[at] as number) + (vector[at] as number)
  }
  let norm = 0
  for (const component of sum) norm += component * component
  if (norm === 0) return undefined
  const scale = 1 / Math.sqrt(norm)
  for (let at = 0; at < sum.length; at += 1) sum[at] = (sum[at] as number) * scale
  return sum
}

/** One centroid neighbor: another name of the same type, and the cosine between the two centroids. */
export interface CentroidNeighbor {
  readonly name: string
  readonly sim: number
}

/**
 * The `k` nearest same-type centroids to `of`, ordered `sim` DESC then `name` ASC.
 *
 * The tie-break matches the pair kernel's (`sim` DESC, then the other key ASC), so two names whose
 * centroids are equidistant are listed in one fixed order and the prompt's bytes do not depend on the
 * input order. A name with no centroid has no neighbors, and a candidate with no centroid is not one.
 *
 * `cosine` from the domain rather than a dot product over the already-normalized vectors, so this
 * similarity is the same arithmetic every other reader of this vector space performs. Cost is O(n²) per
 * type, bounded by {@link ENTITY_BATCH_SIZE} being the point at which a type is sharded for the CALL —
 * at the measured 59 entities the pair space is 1,711 dot products, which is the work the phase used to
 * do with character ratios.
 */
export const nearestCentroids = (
  centroids: ReadonlyArray<EntityCentroid>,
  of: string,
  k: number
): ReadonlyArray<CentroidNeighbor> => {
  const subject = centroids.find((candidate) => candidate.name === of)
  const subjectVec = subject?.vec
  if (subjectVec === undefined) return []
  const scored: Array<CentroidNeighbor> = []
  for (const candidate of centroids) {
    if (candidate.name === of || candidate.vec === undefined) continue
    scored.push({ name: candidate.name, sim: cosine(subjectVec, candidate.vec) })
  }
  scored.sort((left, right) =>
    left.sim !== right.sim ? (left.sim < right.sim ? 1 : -1) : left.name < right.name ? -1 : 1
  )
  return scored.slice(0, k)
}

/**
 * One name's evidence block, as the model reads it.
 *
 * Neighbors are named by NAME and not by member key. A key names a member of THIS batch, and a
 * centroid neighbor may sit in another shard, so offering its key would invite an answer referencing a
 * member the batch never contained. The similarity is rendered at two decimals so a corpus whose
 * vectors moved in the sixteenth place does not change the prompt's bytes.
 */
export const entityMemberText = (input: {
  readonly centroid: EntityCentroid
  readonly neighbors: ReadonlyArray<CentroidNeighbor>
  readonly aliases: ReadonlyArray<string>
}): string => {
  const lines = [`name: ${input.centroid.name}`, `memories: ${input.centroid.memories}`]
  if (input.centroid.titles.length > 0) {
    lines.push("titles:", ...input.centroid.titles.map((title) => `- ${title}`))
  }
  if (input.neighbors.length > 0) {
    lines.push(
      "nearest by memory centroid:",
      ...input.neighbors.map((one) => `- ${one.name} (${one.sim.toFixed(2)})`)
    )
  }
  if (input.aliases.length > 0) {
    lines.push(`declared aliases: ${input.aliases.join(", ")}`)
  }
  return lines.join("\n")
}

/**
 * One merge as the post-pass will perform it: which name is rewritten away, and onto which.
 *
 * The orientation is the CODE's, from {@link unionPairs}'s weight-then-lexicographic rule. A model that
 * named the shorter form as its canonical still gets the rewrite the corpus's own file counts imply.
 */
export interface ProposedMerge {
  readonly alias: string
  readonly canonical: string
}

/**
 * Decompose one cluster of member names into oriented merges: the highest-count name survives, ties
 * broken lexicographically, and every other member rewrites onto it.
 *
 * **The model's `canonicalKey` does not decide this**, and the reason is worth stating. The canonical
 * name is what every `memhtml-entity` meta in the corpus is rewritten TO, and it becomes a person file's
 * path once person-links runs. Letting the model choose it would make a nightly job's write target a
 * model's answer. What `canonicalKey` is for is validation: a cluster whose canonical is not one of its
 * own members is a self-contradicting answer, and the caller drops it.
 *
 * A cluster of fewer than two names produces no merges, which is how a model refuses.
 */
export const decomposeCluster = (
  members: ReadonlyArray<string>,
  counts: ReadonlyMap<string, number>
): ReadonlyArray<ProposedMerge> => {
  const distinct = [...new Set(members)].sort()
  if (distinct.length < 2) return []
  let canonical = distinct[0] as string
  for (const name of distinct.slice(1)) {
    const held = counts.get(canonical) ?? 0
    const weight = counts.get(name) ?? 0
    if (weight > held || (weight === held && name < canonical)) canonical = name
  }
  return distinct.flatMap((name) => (name === canonical ? [] : [{ alias: name, canonical }]))
}

/**
 * Names one person file declares to be one person: its own `person:` entities plus its
 * `memhtml-alias` values, all normalized.
 *
 * One GROUP per file rather than a directed alias map, and symmetric by construction, because that is
 * what the declaration means. `resources/people/laith-al-saadoon.html` carrying
 * `<meta name="memhtml-alias" content="laith">` asserts that the two names are one subject, and the
 * assertion holds whichever of them the corpus's file counts make the canonical.
 */
export type AliasGroup = ReadonlySet<string>

/** True when some declaration names both. The alias oracle's whole question. */
export const aliasBacked = (
  groups: ReadonlyArray<AliasGroup>,
  left: string,
  right: string
): boolean => groups.some((group) => group.has(left) && group.has(right))

/**
 * Every pair of one type's names that a DECLARATION backs: the alias oracle as a pair source of its
 * own, answerable with no model and no corroboration.
 *
 * **This is what makes the oracle an oracle.** Issue #43 states that entity resolution consults
 * declared aliases FIRST and that an alias-backed merge auto-commits regardless of string distance. A
 * declaration read only where the model core reads it would deliver neither half: a credential-free
 * night would leave `laith` and `laith al-saadoon` split with a person file sitting in the corpus
 * saying they are one person, and even a night WITH credentials would apply the declaration only if
 * the model happened to propose that pair — so the operator surface the format invites someone to
 * hand-edit would work or not work depending on a model's attention.
 *
 * A pair the character pass already merges is left out, because counting it as an alias merge as well
 * would report one merge twice. Names are walked in sorted order, so the pair list is a function of the
 * name set and the declarations alone.
 */
export const aliasPairs = (
  groups: ReadonlyArray<AliasGroup>,
  counts: ReadonlyMap<string, number>
): ReadonlyArray<NamePair> => {
  const names = [...counts.keys()].sort()
  const out: Array<NamePair> = []
  for (let outer = 0; outer < names.length; outer += 1) {
    for (let inner = outer + 1; inner < names.length; inner += 1) {
      const left = names[outer]
      const right = names[inner]
      if (left === undefined || right === undefined) continue
      if (!aliasBacked(groups, left, right)) continue
      if (nameSimilarity(left, right) >= AUTO_MERGE_THRESHOLD) continue
      out.push([left, right])
    }
  }
  return out
}

/**
 * Read the alias declarations out of the person files.
 *
 * Parsed with the production parser rather than scanned for meta lines, because `memhtml-alias` is
 * repeatable and the surgical `readMeta` reads only the first of a name. A file that does not parse is
 * skipped: it is not indexed either, so it has no entities for a merge to be about.
 *
 * **Read from the FILES at phase time, and deliberately not projected to SQL.** The whole point of the
 * oracle is that a person file is hand-editable and operator-seedable — someone with an authoritative
 * directory writes the aliases in and the phase converges to auto-merge. A projection would put the
 * declaration behind an index refresh, so an alias written and committed during a session would not be
 * evidence until the next rebuild, and the one surface an operator is invited to edit would be the one
 * with a stale read. There are as many person files as there are people, and the phase reads each once.
 *
 * Read on EVERY run, including a credential-free one and a dry run, because the declarations are a
 * deterministic pair source rather than the model core's evidence. Reading them is pure, so a dry run
 * can count what they would merge without writing anything.
 */
const readAliasGroups = (env: PhaseEnv): Effect.Effect<ReadonlyArray<AliasGroup>> =>
  Effect.gen(function* () {
    const paths = yield* peoplePaths(env.deps.db).pipe(Effect.orElseSucceed(() => []))
    const groups: Array<AliasGroup> = []
    for (const row of paths) {
      const html = yield* readFileBytes(env, row.path).pipe(
        Effect.orElseSucceed(() => undefined as string | undefined)
      )
      if (html === undefined) continue
      const doc = yield* parseMemory(html).pipe(Effect.orElseSucceed(() => undefined))
      if (doc === undefined) continue
      const group = new Set<string>()
      for (const entity of doc.entities) {
        if (!entity.startsWith(PERSON_ENTITY_PREFIX)) continue
        const name = normalizeEntityName(entity.slice(PERSON_ENTITY_PREFIX.length))
        if (name !== "") group.add(name)
      }
      // A file that declares aliases but no person entity names no subject for them to be aliases OF,
      // so its declaration is not evidence about any pair.
      if (group.size === 0) continue
      for (const alias of doc.aliases) {
        const name = normalizeEntityName(alias)
        if (name !== "") group.add(name)
      }
      if (group.size > 1) groups.push(group)
    }
    return groups
  })

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

    /** `path -> [(oldRef, newRef)]`, accumulated across every pass. */
    const rewrites = new Map<string, Array<readonly [string, string]>>()
    const addRewrite = (path: string, from: string, to: string): void => {
      if (from === to) return
      const bucket = rewrites.get(path)
      if (bucket === undefined) rewrites.set(path, [[from, to]])
      else bucket.push([from, to])
    }

    let normalized = 0
    let fuzzyMerges = 0
    let llmMerges = 0
    let aliasMerges = 0
    /** Names the quadratic cap dropped, summed over types. See {@link ENTITY_QUADRATIC_NAME_LIMIT}. */
    let namesCapped = 0
    let pendingCorroboration = 0
    let reviewCandidates = 0
    let llmCalls = 0
    /** Model calls that came back malformed. The sweep's precondition reads this; see below. */
    let callsFailed = 0
    /**
     * Cluster member keys (or canonical keys) resolving to no offered member, dropped unacted. The
     * drop is the safe outcome and stays; the count makes a systematic naming pattern visible
     * instead of reading as a night in which the model proposed no merges (issue #58).
     */
    let unresolved = 0
    /**
     * Every pair this night deferred to a human, as a value rather than only a count.
     *
     * This is issue #44's motivating case in one variable. The phase used to report
     * `reviewCandidates: 2` and the number was never seen again: a decision the night deliberately
     * declined to make evaporated, and the human it was deferred TO was never told. Keeping the pairs
     * lets the phase mint one task per pair after the loop, with the evidence that made it a
     * candidate.
     */
    const deferred: Array<ReviewCandidate> = []
    /**
     * The state-plane writes this night has earned, recorded on the branch instead of performed.
     *
     * One entry per merge that reached {@link ENTITY_PROMOTION_DETECTIONS} tonight and whose counter row
     * does not already say so. Accumulated rather than written per merge, so the ledger is read and
     * rewritten once for the whole phase and its bytes are a function of the night's merges.
     */
    const marks: Array<PendingMark> = []

    /**
     * The model core is skipped entirely on a dry run and when no model is bound, and both leave the
     * deterministic passes running. A dry run must make no model call and bump no counter, because a
     * counter bumped by a run that wrote nothing would be a night of corroboration the corpus never
     * saw. An absent model is a credential-free run, not a broken one.
     *
     * **`dedup-merge`'s dry run makes the opposite choice and DOES spend its calls**, because there the
     * model's partition is the number an operator is asking for and a call costs nothing but money. Here
     * an honest preview would have to bump the corroboration counter — the merge count for night two
     * depends on it — and this phase's writes are identity rewrites, which is the one-way door where
     * manufacturing a night of evidence is worse than declining to preview.
     */
    const model = env.dryRun ? undefined : env.deps.model
    const modelKey = modelFor(env.deps, "entity-resolution")

    /**
     * The declarations, read UNCONDITIONALLY — before the model core, and whether or not one exists.
     *
     * The oracle is a deterministic pair source like the character pass, not evidence the model core
     * owns. Reading it here is what makes a person file an operator surface: seed one, and the merge it
     * declares lands on the next night with no credentials, no cosine, and no second night. Gathering it
     * under `model !== undefined` made the declaration effective only where a model had already proposed
     * the same pair, which is the narrower behavior issue #43 names as the defect.
     *
     * It is also the model core's evidence, unchanged: `aliasesFor` reads these same groups to render
     * the `declared aliases` line, so the model sees what the code already decided rather than being
     * asked about it.
     *
     * A read, never a write, so a DRY RUN performs it too. Its merges are counted like every other dry
     * run count and nothing is written, which is what an operator sizing a night needs.
     */
    const aliasGroups = yield* readAliasGroups(env)

    /** The centroids the model core needs, gathered once for every type rather than per type. */
    const centroidsByType =
      model === undefined
        ? undefined
        : yield* Effect.all([entityClaims(env.deps.db), entityVectors(env.deps.db)]).pipe(
            Effect.map(([claims, vectors]) =>
              entityCentroids(claims, new Map(vectors.map((entry) => [entry.key, entry.vec])), {
                sampleTitles: ENTITY_SAMPLE_TITLES
              })
            )
          )

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

      /**
       * The quadratic passes see at most {@link ENTITY_QUADRATIC_NAME_LIMIT} names, highest file
       * count first. `counts` itself stays whole: normalization already happened, the union-find and
       * the alias oracle read the full map, so a dropped name loses only fuzzy matching and its seat
       * in the model call.
       */
      const capped = capQuadraticNames(counts, ENTITY_QUADRATIC_NAME_LIMIT)
      namesCapped += capped.dropped
      if (capped.dropped > 0) {
        yield* Effect.logWarning(
          `sleep entity-resolution ${entityType}: ${capped.dropped} of ${counts.size} names ` +
            `dropped from the pair passes at the ${ENTITY_QUADRATIC_NAME_LIMIT}-name cap`
        )
      }

      /** Pass two: the character pass. Its auto pairs merge; its band pairs await a later stage. */
      const character = characterPairs([...capped.kept.keys()])
      const accepted: Array<NamePair> = [...character.auto]

      /**
       * Pass two-and-a-half: the DECLARED aliases, accepted straight into the union.
       *
       * Only for {@link PERSON_TYPE}, because that is the only type the format gives a declaration
       * surface — `resources/people/` — so an alias group can only ever be about a person, and running
       * this for `service` would compare names against groups that cannot hold them.
       *
       * These merges are recorded in `aliasMerges` and never in `entity_corroboration`. A declaration is
       * a human's assertion of identity rather than a machine's suspicion, so a second night would add no
       * evidence, and a counter row for it would tell a reader of that table there is a decision still
       * waiting.
       */
      const declared = entityType === PERSON_TYPE ? aliasPairs(aliasGroups, counts) : []
      accepted.push(...declared)
      aliasMerges += declared.length
      /** So the model core does not count a declared pair a second time. */
      const declaredKeys = new Set(declared.map(([left, right]) => pairKey(left, right)))

      /**
       * Pass three: the model core. One call per shard of one type, then a deterministic decision per
       * proposed merge. Every merge the model contributes is either alias-backed and immediate, or
       * corroborated across nights, or counted for review — the model never writes.
       */
      const clusteredPairs = new Set<string>()
      if (model !== undefined && centroidsByType !== undefined) {
        /**
         * The capped set bounds BOTH sides of the neighbor scan: `nearestCentroids` is a cosine per
         * (member, candidate) pair, so a capped member list against uncapped candidates would still
         * be O(members × type). A dropped name neither appears in a prompt nor in a neighbor line.
         */
        const centroids = (centroidsByType.get(entityType) ?? []).filter((centroid) =>
          capped.kept.has(centroid.name)
        )
        const members = centroids
        const aliasesFor = (name: string): ReadonlyArray<string> =>
          entityType === PERSON_TYPE
            ? [
                ...new Set(
                  aliasGroups
                    .filter((group) => group.has(name))
                    .flatMap((group) => [...group].filter((other) => other !== name))
                )
              ].sort()
            : []

        for (const shard of assembleBatches([members], {
          maxMembers: ENTITY_BATCH_SIZE,
          // A lone name has no other name to be the same subject as, so the question is meaningless
          // and a call asking it would spend a model call to be told nothing.
          minMembers: 2
        })) {
          const keyed = keyMembers(
            shard,
            (centroid) =>
              entityMemberText({
                centroid,
                neighbors: nearestCentroids(centroids, centroid.name, ENTITY_NEIGHBORS),
                aliases: aliasesFor(centroid.name)
              }),
            { charBudget: ENTITY_MEMBER_CHARS }
          )

          llmCalls += 1
          const clustering = yield* batchCall(
            model,
            `entity-resolution ${entityType} batch of ${shard.length}`,
            {
              schema: EntityClustering,
              system: ENTITY_CLUSTER_SYSTEM,
              prompt: entityClusterPrompt(keyed.keyed),
              modelKey,
              effort: "medium",
              toolDescription:
                "Emit one cluster per subject, naming the members that are the same subject."
            }
          )
          if (clustering === undefined) {
            /**
             * Counted, because the detected-task sweep's precondition reads it. A shard whose call
             * came back malformed left every one of its names unclustered, so the band pairs among
             * them are counted as review candidates by the pass below — which is correct for the
             * REPORT and would be wrong as the sweep's input, since the phase did not actually judge
             * them. See the sweep's own comment.
             */
            callsFailed += 1
            continue
          }

          /** This shard's unresolvable keys, so the warning below names the spellings that failed. */
          const unresolvedKeys: Array<string> = []

          for (const cluster of clustering.clusters) {
            /**
             * A key the batch never offered resolves to nothing, so an invented member cannot become a
             * rewrite. The canonical must be one of the cluster's own members: a cluster whose stated
             * canonical is outside it contradicts itself, and guessing which half was meant would be
             * the caller inventing a merge.
             */
            const droppedKeys = [...cluster.memberKeys, cluster.canonicalKey].filter(
              (key) => offeredKeyFor(keyed, key) === undefined
            )
            unresolved += droppedKeys.length
            unresolvedKeys.push(...droppedKeys)
            const memberNames = resolveKeys(keyed, cluster.memberKeys).map(
              (centroid) => centroid.name
            )
            const [canonicalMember] = resolveKeys(keyed, [cluster.canonicalKey])
            if (canonicalMember === undefined || !memberNames.includes(canonicalMember.name)) {
              continue
            }

            for (const merge of decomposeCluster(memberNames, counts)) {
              const key = pairKey(merge.alias, merge.canonical)
              clusteredPairs.add(key)
              // Already merged by the character pass. Corroborating a merge that has happened would
              // count a night of evidence for a decision no longer awaiting one.
              if (nameSimilarity(merge.alias, merge.canonical) >= AUTO_MERGE_THRESHOLD) continue

              /**
               * Already accepted by the declaration pass above, so the merge is happening and only the
               * counting is at stake: adding it again would report one merge as two, and corroborating
               * it would count a night of evidence toward a decision already made. The model agreeing
               * with a declaration is not new information — the declaration is the stronger evidence.
               */
              if (declaredKeys.has(key)) continue

              /**
               * A declaration the pass above could not have seen: the model named a pair whose two names
               * are in one alias group, but at least one of them is not in `counts` for this type — a
               * name the batch offered whose entity rows this type's bucket does not hold. Rare, and the
               * rule is the same one, so it is applied here rather than left to the corroboration path.
               */
              if (aliasBacked(aliasGroups, merge.alias, merge.canonical)) {
                accepted.push([merge.alias, merge.canonical])
                aliasMerges += 1
                continue
              }
              if (cluster.confidence < ENTITY_CONFIDENCE_FLOOR) {
                reviewCandidates += 1
                deferred.push({
                  entityType,
                  left: merge.alias,
                  right: merge.canonical,
                  reason: "below-floor",
                  score: cluster.confidence,
                  leftFiles: counts.get(merge.alias) ?? 0,
                  rightFiles: counts.get(merge.canonical) ?? 0
                })
                continue
              }

              const rows = yield* bumpEntityCorroboration(env.deps.db, {
                entityType,
                aliasName: merge.alias,
                canonicalName: merge.canonical,
                at: env.at
              })
              const row = rows[0]
              if (row === undefined || row.detections < ENTITY_PROMOTION_DETECTIONS) {
                pendingCorroboration += 1
                continue
              }
              accepted.push([merge.alias, merge.canonical])
              llmMerges += 1
              /**
               * The flag is PROPOSED, not set. `promoted = 1, confirmed = 1` asserts the corpus carries
               * the rewrite, and the rewrite lives on this branch while the flag would live in
               * `.memhtml/state.db`, which `git branch -D` cannot reach and an index rebuild cannot
               * re-derive — so setting it here leaves a discarded run's plane claiming a corpus-wide
               * rename that no file carries. The mark goes in the run's ledger and `merge` applies it.
               *
               * `row.promoted` is read straight off the bump's `RETURNING`, so it is the plane as MERGED
               * nights left it: 1 only when an earlier landed night already recorded this merge, in which
               * case there is nothing left to propose. A re-read inside one run reads 0 again and records
               * the same mark, which {@link recordPendingMarks} collapses to the line already there —
               * the ledger is itself this phase's same-run view, because both the read and the write go
               * through the one file. (Edge typing keeps a separate in-memory overlay because ITS
               * `promoted` read gates a write into the files and a `promoted` count; here the flag gates
               * only the recording of the mark, so a second read costs a dedup and nothing else.)
               */
              if (row.promoted === 0) {
                marks.push({
                  kind: "entity-promoted",
                  entityType,
                  aliasName: merge.alias,
                  canonicalName: merge.canonical,
                  at: env.at
                })
              }
            }
          }

          if (unresolvedKeys.length > 0) {
            yield* Effect.logWarning(
              `sleep.llm entity-resolution ${entityType} batch of ${shard.length} dropped ` +
                `${unresolvedKeys.length} cluster keys naming no offered member ` +
                `(${unresolvedKeys.slice(0, 3).join(", ")}${unresolvedKeys.length > 3 ? ", …" : ""})`
            )
          }
        }
      }

      /**
       * A band pair the model went on to cluster is no longer awaiting a human: it was decided, and
       * the decision is recorded either as a merge or as a below-floor review candidate already counted
       * above. Counting it here as well would report one pair twice.
       */
      const bandPairs = character.review.filter(
        ([left, right]) => !clusteredPairs.has(pairKey(left, right))
      )
      reviewCandidates += bandPairs.length
      for (const [left, right] of bandPairs) {
        deferred.push({
          entityType,
          left,
          right,
          reason: "character-band",
          score: nameSimilarity(left, right),
          leftFiles: counts.get(left) ?? 0,
          rightFiles: counts.get(right) ?? 0
        })
      }

      /** One union-find over every accepted pair, so the three sources cannot disagree on a root. */
      const aliasToCanonical = unionPairs(counts, accepted)

      for (const entity of bucket) {
        const afterNormalize = normalizedOf.get(entity.entity_name) ?? entity.entity_name
        const afterMerge = aliasToCanonical.get(afterNormalize) ?? afterNormalize
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
      namesCapped,
      fuzzyMerges,
      llmMerges,
      aliasMerges,
      pendingCorroboration,
      reviewCandidates,
      callsFailed,
      unresolved,
      tasksMinted: 0,
      tasksFramed: 0,
      tasksDismissed: 0,
      tasksClosed: 0,
      filesRewritten: rewrites.size
    }
    /**
     * A dry run stops here and mints nothing, matching what the rest of this phase already declines
     * to do on one. `reviewCandidates` is real on a dry run; the tasks it would open are not.
     */
    if (env.dryRun) return { ...emptyOutcome(counts), llmCalls }

    /**
     * The deferred decisions become task files, keyed and capped, in the SAME commit as the merges.
     *
     * One commit rather than two, because the two halves are one night's answer to the same question:
     * these pairs merged, those the phase declined to merge and handed to you. A reviewer reads the
     * pair together, and `commitPhase` commits whatever is staged, so the mints ride along.
     *
     * Mints happen even when nothing was rewritten, and that reordering is the whole point of surface
     * 1. The old early return on `rewrites.size === 0` would have skipped exactly the night this
     * feature exists for: a night whose only outcome was deferrals is a night with no rewrites.
     */
    /**
     * `unresolved === 0` joins the sweep gate for the reason `callsFailed === 0` is already in it: a
     * cluster key the phase could not map to a member is a name that was never judged, and sweeping
     * against a night that lost part of an answer closes reviews over a misspelling.
     */
    const tasks = yield* mintReviewTasks(
      env,
      deferred,
      model !== undefined && callsFailed === 0 && unresolved === 0
    )

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

    /**
     * The ledger, written once for the whole night and STAGED so this phase's own commit carries it.
     *
     * Staged rather than left on disk, because a plane write the branch does not commit is a write no
     * merge can find: the rewrite would be in the files with the counter still reading pending, and
     * every later night would re-propose a merge the corpus already made. Left unstaged it would also be
     * swept into whichever later phase commits next, which is the cross-phase contamination per-phase
     * commits exist to prevent.
     */
    const pendingRecorded = yield* recordPendingMarks(env.deps.git.root, env.runId, marks)
    if (pendingRecorded) yield* env.deps.git.add([pendingMarksPath(env.runId)])

    const final = {
      ...counts,
      tasksMinted: tasks.minted,
      tasksFramed: tasks.framed,
      tasksDismissed: tasks.dismissed,
      tasksClosed: tasks.closed,
      filesRewritten: rewritten
    }
    /**
     * Nothing staged, no commit. `commitPhase` already no-ops on an empty index, so this only spares
     * git the call — and it has to consider the MINTS and the LEDGER as well as the rewrites. A night
     * whose only output is deferred-decision tasks must still commit them, and a night that earned a
     * promotion whose alias files have since left the tree rewrites nothing while still owing its merge
     * a mark: returning early there would leave the ledger staged and uncommitted, so the next phase to
     * commit would carry it.
     */
    if (
      !pendingRecorded &&
      rewritten === 0 &&
      tasks.minted === 0 &&
      tasks.refreshed === 0 &&
      tasks.closed === 0
    ) {
      return { ...emptyOutcome(final), llmCalls }
    }
    const commitSha = yield* commitPhase(
      env,
      "entity-resolution",
      `normalize ${normalized} entity names, merge ${fuzzyMerges} aliases`,
      final,
      tasks.minted + tasks.closed === 0
        ? undefined
        : `deferred ${tasks.minted} alias decisions to review tasks` +
            (tasks.closed === 0 ? "" : `; closed ${tasks.closed}: no longer detected`)
    )
    return { counts: final, commitSha, llmCalls }
  })

/** The detector name every alias review task is keyed and swept under. */
export const ENTITY_REVIEW_DETECTOR = "entity-resolution"

/**
 * One pair this night declined to merge, with the evidence that made it a candidate.
 *
 * The two reasons are the two bands issue #43 named and #44 promotes to tasks, and they are kept
 * apart because the SCORE means different things: a `character-band` score is a longest-common-
 * subsequence ratio over the two name strings, and a `below-floor` score is the model's own stated
 * confidence that they are one subject. Rendering both as "similarity" would put two incomparable
 * numbers under one label in the evidence a human reads.
 */
export interface ReviewCandidate {
  readonly entityType: string
  readonly left: string
  readonly right: string
  readonly reason: "character-band" | "below-floor"
  readonly score: number
  readonly leftFiles: number
  readonly rightFiles: number
}

/**
 * Mint one review task per deferred pair, and sweep the ones that stopped being deferred.
 *
 * **The key is the entity TYPE plus the two names sorted**, and not the reason. A pair the character
 * band deferred last night and the model deferred below the floor tonight is ONE question a human has
 * to answer once — are these the same subject — so it must key the same however the night arrived at
 * it. Sorting is what makes `(laith, laith al-saadoon)` and the reverse one key; the pair is
 * unordered, because neither name is the subject of the question.
 *
 * **The evidence is a MEASUREMENT and says so.** There is no sentence anywhere in the corpus stating
 * that two names scored 0.79 against each other, so a quote would have to be manufactured. The
 * `DetectionEvidence` union makes that difference explicit rather than leaving it to a convention this
 * function could quietly break.
 *
 * **The sweep is gated on a night that had a MODEL and lost no call**, which `judged` carries.
 * `deferred` holds what the phase actually decided to defer, and a shard whose model call failed left
 * its names unclustered — so its band pairs are reported as review candidates without having been
 * judged. They ARE still live, so they belong in `liveKeys`; but a night that lost a call cannot
 * distinguish "the model decided this pair is fine" from "the model was never asked", and closing on
 * that reading would take a real review out of a human's queue because Bedrock throttled.
 *
 * **`callsFailed === 0` alone was the bug, because it is VACUOUSLY TRUE with no model bound.** The
 * caller now requires `model !== undefined` as well. A credential-free night runs only the two
 * deterministic passes, so it produces `character-band` deferrals and CANNOT produce a `below-floor`
 * one — a below-floor deferral is by definition a merge the model proposed under
 * `ENTITY_CONFIDENCE_FLOOR`, and there was no model to propose it. Its `deferred` therefore omits every
 * below-floor pair a model night opened, and sweeping against that closed those tasks on the first
 * night without credentials. `tasks.ts`'s `closeVanishedDetections` states this precondition as
 * "a phase that degraded — no model bound, a batch whose call failed — did not evaluate the candidate
 * set", and no-model is the arm that check had missed.
 */
const mintReviewTasks = (
  env: PhaseEnv,
  deferred: ReadonlyArray<ReviewCandidate>,
  judged: boolean
): Effect.Effect<
  {
    readonly minted: number
    readonly refreshed: number
    /** The frame-key proximity check's refusals. Counted so the task arithmetic sums. */
    readonly framed: number
    /** Pairs a human already closed, whose dismissal stands. See `tasks.ts`'s module header. */
    readonly dismissed: number
    readonly closed: number
  },
  SleepError | GitFailure
> =>
  Effect.gen(function* () {
    const budget = budgetFor(env)
    /**
     * Sorted and de-duplicated by key before minting, so the order tasks are opened in is a function
     * of the pairs and not of which entity type happened to be walked first — which matters once the
     * budget bites, because then the ORDER decides which pairs a human sees.
     */
    const byKey = new Map<string, ReviewCandidate>()
    for (const candidate of [...deferred].sort(compareCandidates)) {
      const key = detectionKey(ENTITY_REVIEW_DETECTOR, findingFor(candidate))
      if (!byKey.has(key)) byKey.set(key, candidate)
    }

    let minted = 0
    let refreshed = 0
    let framed = 0
    let dismissed = 0
    for (const candidate of byKey.values()) {
      const outcome = yield* mintDetectedTask(env, budget, {
        detector: ENTITY_REVIEW_DETECTOR,
        finding: findingFor(candidate),
        title: `Confirm whether ${candidate.left} and ${candidate.right} are one ${candidate.entityType}`,
        claim: `confirm: are "${candidate.left}" and "${candidate.right}" the same ${candidate.entityType}?`,
        detail:
          `Sleep declined to merge them and deferred the decision. Merging two entities is a ` +
          `one-way door: no later commit separates two subjects whose memories were fused.`,
        evidence: { kind: "measurement", detail: evidenceFor(candidate) }
      })
      if (outcome === "minted") minted += 1
      else if (outcome === "refreshed") refreshed += 1
      else if (outcome === "framed") framed += 1
      else if (outcome === "dismissed") dismissed += 1
    }

    const closed = judged
      ? yield* closeVanishedDetections(env, ENTITY_REVIEW_DETECTOR, new Set(byKey.keys()))
      : 0
    return { minted, refreshed, framed, dismissed, closed }
  })

/** The canonical finding string: the type and the two names, sorted. See {@link mintReviewTasks}. */
const findingFor = (candidate: ReviewCandidate): string =>
  candidate.left < candidate.right
    ? `${candidate.entityType} ${candidate.left} ${candidate.right}`
    : `${candidate.entityType} ${candidate.right} ${candidate.left}`

/** The evidence line: which band deferred it, at what number, and how much corpus is behind each name. */
const evidenceFor = (candidate: ReviewCandidate): string =>
  (candidate.reason === "character-band"
    ? `character overlap ${candidate.score.toFixed(2)}, inside the ${String(REVIEW_THRESHOLD)}-${String(AUTO_MERGE_THRESHOLD)} review band`
    : `the model proposed the merge at confidence ${candidate.score.toFixed(2)}, below the ${String(ENTITY_CONFIDENCE_FLOOR)} floor`) +
  `; "${candidate.left}" is claimed by ${String(candidate.leftFiles)} active memories and ` +
  `"${candidate.right}" by ${String(candidate.rightFiles)}`

/** Type, then the two names, then the reason. A total order, so the mint sequence is reproducible. */
const compareCandidates = (left: ReviewCandidate, right: ReviewCandidate): number => {
  const leftFinding = findingFor(left)
  const rightFinding = findingFor(right)
  if (leftFinding !== rightFinding) return leftFinding < rightFinding ? -1 : 1
  return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0
}
