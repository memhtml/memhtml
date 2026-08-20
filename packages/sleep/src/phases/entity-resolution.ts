import { PERSON_ENTITY_PREFIX } from "@memhtml/contracts/types"
import { cosine } from "@memhtml/domain"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import { applyHeadEdits, meta, readFileBytes, rewriteEntityMeta, writeFileBytes } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody, type PhaseEnv } from "../env.js"
import { ENTITY_CLUSTER_SYSTEM, EntityClustering, entityClusterPrompt } from "../llm.js"
import { type DetectedFinding, makeMinter } from "../mint.js"
import {
  activeEntities,
  bumpEntityCorroboration,
  type EntityClaim,
  type EntityCount,
  entityClaims,
  entityVectors,
  markEntityPromoted,
  pathsForEntity,
  peoplePaths
} from "../sql.js"

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
 * **Every band that does not merge is COUNTED, not merged.** The 0.75-0.85 character band the model did
 * not cluster, and a cluster below {@link ENTITY_CONFIDENCE_FLOOR}, both land in `reviewCandidates`. An
 * entity merge is a one-way door on stored identity: no later commit separates two subjects whose
 * memories were fused, and the failure mode of an over-eager gate is silent and permanent.
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

/** Lowercase, NFC-normalize, collapse internal whitespace, trim. The pre-compare form. */
export const normalizeEntityName = (name: string): string =>
  name.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

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

/** The `type:name` form a `memhtml-entity` meta carries. */
const entityRef = (entityType: string, entityName: string): string => `${entityType}:${entityName}`

/** The detector name this phase mints under, and the first segment of every key it owns. */
export const ENTITY_DETECTOR = "entity-resolution"

/**
 * One pair a human has to decide, as this phase hands it to the minting kernel.
 *
 * A PAIR and never a cluster, which is the one structural decision in this whole path. A
 * below-floor cluster of three names is three names tonight and four the night a fourth spelling
 * lands, so a cluster-membership fingerprint churns and the corpus accumulates one dead task per
 * night per cluster that grew. Two names are the same two names forever, so the pair is what a
 * finding key can be stable over. {@link decomposeCluster} is what turns a cluster into pairs, and
 * it is the phase's OWN orientation function — the same one the merge path uses — so the alias and
 * the canonical a task names are the alias and the canonical the merge would have written.
 */
export interface ConfirmPair {
  readonly entityType: string
  /** The name that would be rewritten away. Normalized, from `counts`. */
  readonly alias: string
  /** The name that would survive. Normalized, from `counts`. */
  readonly canonical: string
  /** Distinct active non-task files claiming each name, from the phase's own folded `counts`. */
  readonly aliasFiles: number
  readonly canonicalFiles: number
  /** Cosine between the two names' memory centroids, absent when either has no vector. */
  readonly centroidCosine: number | undefined
  /**
   * The model's own evidence sentence, when a model proposed this pair.
   *
   * UNTRUSTED TEXT, and the reason it is typed as prose here rather than carried anywhere else. It
   * is a model's sentence about a corpus that stores instructions, so {@link confirmFinding} puts it
   * in a body PARAGRAPH — escaped by the template's prose path — and never in a `cite`, a `title`,
   * or a `claim`. A review-band pair the model never saw has none.
   */
  readonly modelEvidence: string | undefined
}

/**
 * The `entity:<type>\0<a>\0<b>` fingerprint of a pair, names sorted after normalization.
 *
 * SORTED, so the fingerprint is a property of the unordered pair. The orientation
 * {@link decomposeCluster} chooses depends on file counts, and a corpus where the short form gains a
 * memory flips which name is the alias — a fingerprint carrying that orientation would re-file the
 * same question as a new task on the night the counts crossed, and the old task would look absent
 * and be closed. `\0` as the separator for the same reason {@link pairKey} uses it: it cannot occur
 * in a normalized name, so no two distinct pairs can produce one fingerprint by concatenation.
 */
export const confirmFingerprint = (entityType: string, left: string, right: string): string =>
  `entity:${entityType}\u0000${pairKey(normalizeEntityName(left), normalizeEntityName(right))}`

/**
 * One `confirm:` finding for a pair: the pinned question, and the evidence a human needs to answer it.
 *
 * **The title and the claim are the same pinned sentence**, and the guillemets are what make it
 * readable when a name contains a space — `are laith and laith al-saadoon the same person` reads as
 * three names. The orientation shown is `decomposeCluster`'s, so the human sees the merge that would
 * actually happen rather than an unordered pair they then have to orient themselves.
 *
 * **Body is PROSE PARAGRAPHS, not `bodyHtml`.** This finding has nothing to quote: its evidence is
 * four numbers and possibly a model's sentence, none of which is text lifted from a file. The prose
 * path escapes every paragraph through the template, which is what keeps the model's sentence from
 * being markup; the `bodyHtml` path hands markup through untouched and is for the phases whose
 * evidence is a `<q cite>` of a real file.
 */
export const confirmFinding = (pair: ConfirmPair): DetectedFinding => {
  const question = `confirm: are «${pair.alias}» and «${pair.canonical}» the same ${pair.entityType}?`
  const similarity = nameSimilarity(pair.alias, pair.canonical)
  return {
    detector: ENTITY_DETECTOR,
    fingerprint: confirmFingerprint(pair.entityType, pair.alias, pair.canonical),
    title: question,
    claim: question,
    body: [
      `Character overlap between the two names is ${similarity.toFixed(3)}, against the ${AUTO_MERGE_THRESHOLD} auto-merge threshold and the ${REVIEW_THRESHOLD} review floor.`,
      `«${pair.alias}» is claimed by ${pair.aliasFiles} active file(s) and «${pair.canonical}» by ${pair.canonicalFiles}, so a merge would rewrite «${pair.alias}» onto «${pair.canonical}».`,
      ...(pair.centroidCosine === undefined
        ? []
        : [
            `The two names' memory centroids sit at ${pair.centroidCosine.toFixed(3)} cosine. A high number is evidence and not a decision: two services in one domain are written about in the same terms.`
          ]),
      ...(pair.modelEvidence === undefined || pair.modelEvidence.trim() === ""
        ? []
        : [`The model's stated reason, unverified: ${pair.modelEvidence.trim()}`])
    ],
    entities: [entityRef(pair.entityType, pair.canonical)]
  }
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
    let pendingCorroboration = 0
    let reviewCandidates = 0
    let llmCalls = 0

    /**
     * The two signals `universeComplete` needs that the phase did not previously track.
     *
     * Neither is a count an operator reads; both are the attestation's own evidence, which is why
     * they are plain locals rather than entries in the counts trailer. `isolatedFailures` is one per
     * `batchCall` that came back `undefined` — a batch whose call failed contributes no clusters, so
     * every pair it would have deferred looks decided tonight. `unaskedPairs` is the pair coverage
     * `assembleBatches` did not deliver: a type sharded at {@link ENTITY_BATCH_SIZE} asks about pairs
     * INSIDE each shard and never across them, so a sharded type leaves cross-shard pairs unexamined.
     *
     * **`unaskedPairs` counts PAIRS rather than names, and that is the difference between an
     * attestation and a permanently-false flag.** `assembleBatches` is given `minMembers: 2`, so a
     * type holding one name has its shard dropped — and a corpus with any singleton entity type
     * (the common case) would then never be complete. A lone name has no pair for the phase to have
     * missed, so its dropped shard costs nothing, and stating the shortfall in pairs says so.
     */
    let isolatedFailures = 0
    let unaskedPairs = 0
    /** Pairs among `n` names: what one shard of `n` members asks about. */
    const pairsAmong = (n: number): number => (n * (n - 1)) / 2

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

    /**
     * The minting pass, constructed BEFORE any deferral so its open-task snapshot is taken at phase
     * start rather than part-way through, and every pair the night defers is offered to the same
     * dedup state.
     *
     * The pairs are collected here and submitted in ONE sorted pass at the end (see below), so this
     * is only the kernel handle. `makeMinter` reads the index once and validates the detector name.
     */
    const minter = yield* makeMinter(env, ENTITY_DETECTOR)
    /** Every pair to confirm, keyed by fingerprint so one pair reached twice is offered once. */
    const confirmPairs = new Map<string, ConfirmPair>()
    const deferPair = (pair: ConfirmPair): void => {
      const fingerprint = confirmFingerprint(pair.entityType, pair.alias, pair.canonical)
      if (!confirmPairs.has(fingerprint)) confirmPairs.set(fingerprint, pair)
    }

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

      /** Pass two: the character pass. Its auto pairs merge; its band pairs await a later stage. */
      const character = characterPairs([...counts.keys()])
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
      /**
       * The cosine between two names' memory centroids, or absent.
       *
       * Absent on a night with no model, because the centroids are only gathered when the model core
       * runs — they are its evidence, and computing them for a deferral body alone would make a
       * credential-free night pay for a vector pass it has no other use for. A review-band task
       * minted on such a night therefore states the numbers it has and not this one, which is honest:
       * "computable" in AC-3-1 means the phase already holds the vectors.
       */
      const centroidCosine = (left: string, right: string): number | undefined => {
        const centroids = centroidsByType?.get(entityType)
        if (centroids === undefined) return undefined
        const leftVec = centroids.find((one) => one.name === left)?.vec
        const rightVec = centroids.find((one) => one.name === right)?.vec
        return leftVec === undefined || rightVec === undefined
          ? undefined
          : cosine(leftVec, rightVec)
      }
      /** One pair's evidence, gathered from what the phase already holds for this type. */
      const pairFor = (
        alias: string,
        canonical: string,
        modelEvidence?: string | undefined
      ): ConfirmPair => ({
        entityType,
        alias,
        canonical,
        aliasFiles: counts.get(alias) ?? 0,
        canonicalFiles: counts.get(canonical) ?? 0,
        centroidCosine: centroidCosine(alias, canonical),
        modelEvidence
      })

      if (model !== undefined && centroidsByType !== undefined) {
        const centroids = centroidsByType.get(entityType) ?? []
        const members = centroids.filter((centroid) => counts.has(centroid.name))
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

        const shards = assembleBatches([members], {
          maxMembers: ENTITY_BATCH_SIZE,
          // A lone name has no other name to be the same subject as, so the question is meaningless
          // and a call asking it would spend a model call to be told nothing.
          minMembers: 2
        })

        /**
         * The pair coverage this type's shards did NOT deliver, which is the truncation half of
         * `universeComplete`.
         *
         * Two ways a pair goes unexamined and both are counted here: a type sharded at
         * {@link ENTITY_BATCH_SIZE} never asks about a pair whose two names landed in different
         * shards, and a name with no centroid is filtered out of `members` entirely so none of its
         * pairs is asked about at all. Both mean the same thing to the attestation — the phase did
         * not look everywhere, so absence is not evidence tonight.
         */
        unaskedPairs +=
          pairsAmong(counts.size) -
          shards.reduce((total, shard) => total + pairsAmong(shard.length), 0)

        for (const shard of shards) {
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
          /**
           * The isolated failure, now COUNTED rather than only skipped. `batchCall` turns a malformed
           * tool payload into `undefined` so one bad batch does not fail a phase that has already
           * normalized real files — but a batch that answered nothing deferred nothing, so every open
           * task the batch would have kept alive looks absent tonight. Recording it is what lets
           * `closeAbsent` refuse.
           */
          if (clustering === undefined) {
            isolatedFailures += 1
            continue
          }

          for (const cluster of clustering.clusters) {
            /**
             * A key the batch never offered resolves to nothing, so an invented member cannot become a
             * rewrite. The canonical must be one of the cluster's own members: a cluster whose stated
             * canonical is outside it contradicts itself, and guessing which half was meant would be
             * the caller inventing a merge.
             */
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
              /**
               * Below the floor: the model proposed it and would not stand behind it, so it goes to a
               * human as a task and never toward a merge.
               *
               * Counted AND minted, which is the split AC-3-1 asks for: `reviewCandidates` stays the
               * night's aggregate an operator reads in the report trailer, and the task is the durable
               * artifact that survives the report. Deferred as the pair `decomposeCluster` oriented —
               * one finding per pair, so a three-name cluster becomes two questions and neither
               * churns when a fourth spelling arrives.
               */
              if (cluster.confidence < ENTITY_CONFIDENCE_FLOOR) {
                reviewCandidates += 1
                deferPair(pairFor(merge.alias, merge.canonical, cluster.evidence))
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
              if (row.promoted === 0) {
                yield* markEntityPromoted(env.deps.db, {
                  entityType,
                  aliasName: merge.alias,
                  canonicalName: merge.canonical,
                  at: env.at
                })
              }
            }
          }
        }
      }

      /**
       * A band pair the model went on to cluster is no longer awaiting a human: it was decided, and
       * the decision is recorded either as a merge or as a below-floor review candidate already counted
       * above. Counting it here as well would report one pair twice.
       */
      const undecided = character.review.filter(
        ([left, right]) => !clusteredPairs.has(pairKey(left, right))
      )
      reviewCandidates += undecided.length

      /**
       * The band pairs nothing decided tonight, each one a task.
       *
       * Oriented through {@link decomposeCluster} rather than by taking `[left, right]` as given.
       * `characterPairs` walks its names in SORTED order, so its pairs are alphabetical and
       * `[checkout-api, checkout api]` would show a human the merge backwards half the time. The
       * merge path's own rule is the one whose answer the human is being asked to approve.
       */
      for (const [left, right] of undecided) {
        for (const merge of decomposeCluster([left, right], counts)) {
          deferPair(pairFor(merge.alias, merge.canonical))
        }
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

    /**
     * The minting pass, run once over every type's deferrals, in FINGERPRINT order.
     *
     * **Sorted, and the reason is the cap rather than tidiness.** The kernel's `MINT_CAP` bounds what
     * one night writes and counts the rest as overflow, so which findings get written is decided by
     * submission order — and a corpus that grew one entity type would otherwise reshuffle the whole
     * night's order and write a different ten. Fingerprint order is a function of the pair set alone,
     * so two nights over an unchanged corpus mint the same tasks and the eleventh pair stays the
     * eleventh pair until it is decided.
     *
     * Submitted AFTER every type's loop rather than at each deferral, which is what makes one order
     * possible at all: the deferrals arrive per type, and submitting inline would order them by type
     * and let a new type displace a pair the previous night had already filed.
     */
    for (const fingerprint of [...confirmPairs.keys()].sort()) {
      const pair = confirmPairs.get(fingerprint)
      if (pair === undefined) continue
      yield* minter.submit(confirmFinding(pair))
    }
    const mintReport = minter.finish()

    /**
     * The attestation, and every clause of it is a way this night could have failed to look.
     *
     * `modelRan` is the whole model core: a dry run and a credential-free run both leave `model`
     * undefined, and neither examined a single pair — so on those nights every open `confirm:` task
     * looks absent and closing would archive the entire backlog. `isolatedFailures` is a batch that
     * answered nothing. `unaskedPairs` is coverage the sharding did not deliver.
     *
     * Note the asymmetry with the deterministic passes: the character pass and the alias oracle run
     * on EVERY night, so a no-model night does produce real review-band findings and mints them. It
     * still may not CLOSE, because a task minted from a below-floor cluster can only be re-detected
     * by a model, and the deterministic passes going quiet about it says nothing.
     *
     * ## A SHARDED type never becomes complete, so its tasks close only by hand
     *
     * `unaskedPairs` is the one clause that does not resolve on its own. `isolatedFailures` is a bad
     * payload that the next night probably does not repeat, and `model === undefined` is a credential
     * that gets configured — but a type holding more than {@link ENTITY_BATCH_SIZE} names is split, no
     * call ever spans two shards, and a corpus does not shrink. So every cross-shard pair stays
     * unexamined for as long as the type stays that large, `universeComplete` stays false, and the
     * `confirm:` tasks of that detector are closable only by a human marking them done. That is the
     * honest outcome — closing on a night that never asked would archive a real question — and it is
     * stated here and in `docs/tasks.md` rather than left for somebody to infer from a `closureSkipped`
     * that never goes away.
     *
     * **Not caused by a corpus with no EMBEDDINGS**, which is the intuitive suspect and is measurably
     * wrong: `members` filters on `counts.has(centroid.name)` and not on whether a centroid has a
     * vector, so a vector-less name is still offered, still keyed, and still asked about. Probed
     * 2026-08-20 by deleting every `embeddings` row and re-running over `ENTITY_CORPUS` — identical
     * calls, identical counts, identical closure. What such a corpus loses is the model's EVIDENCE:
     * `nearestCentroids` answers `[]`, so the `nearest by memory centroid` block leaves the prompt (2 of
     * 2 prompts carried it with vectors, 0 of 2 without) and the model is asked a poorer question about
     * exactly the case centroids exist for. `tests/entity-resolution-mint.test.ts` pins both halves.
     */
    const universeComplete =
      model !== undefined &&
      centroidsByType !== undefined &&
      isolatedFailures === 0 &&
      unaskedPairs === 0
    /**
     * The shortfall NAMED, because `closureSkipped` alone cannot be acted on.
     *
     * That count is the same `1` a dry run, a failed batch, and a sharded type all produce, and only the
     * third is permanent. An operator watching `confirm:` tasks never close needs to know which, and the
     * number is the pair coverage the clause actually read — so it also says how far from complete the
     * night was rather than only that it was.
     *
     * `logInfo` and not `logWarning`: nothing is broken. A sharded corpus is a large corpus, and the
     * phase is declining to close rather than failing to work — which is the same level
     * `edge-typing`'s "left this task open" line uses for the same kind of statement.
     */
    if (unaskedPairs > 0) {
      yield* Effect.logInfo(
        `sleep.entity-resolution left ${String(unaskedPairs)} pair(s) unasked across shards, ` +
          "so closure is withheld: a type larger than the shard size never reaches a complete pass"
      )
    }
    const closureCounts = yield* minter.closeAbsent(universeComplete)

    const counts = {
      entities: entities.length,
      namesNormalized: normalized,
      fuzzyMerges,
      llmMerges,
      aliasMerges,
      pendingCorroboration,
      reviewCandidates,
      filesRewritten: rewrites.size,
      ...mintReport.counts,
      ...closureCounts
    }
    /**
     * The mint pass writes task FILES, so a night that rewrote no entity meta may still have staged
     * something — and the commit gate has to ask the tree rather than `rewrites.size` alone, or a
     * night whose only output was three `confirm:` tasks would leave them staged and uncommitted for
     * the next phase's commit to absorb.
     */
    const stagedTasks = mintReport.minted.length > 0 || Object.keys(closureCounts).length > 0
    if ((rewrites.size === 0 && !stagedTasks) || env.dryRun) {
      return { ...emptyOutcome(counts), llmCalls }
    }

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
    /**
     * The closure REASON, stated here because there is nowhere else for it to go: no head meta in the
     * format carries one, so `closeTask` writes the archive and the move and the phase commit is where
     * a reviewer asking "why did this task disappear" is already reading.
     *
     * Named only when a closure happened, so an ordinary night's subject stays the one it was.
     */
    const closed = closureCounts.taskClosed ?? 0
    const commitSha = yield* commitPhase(
      env,
      "entity-resolution",
      /**
       * A MINT-ONLY night says what it did, mirroring `dedup-merge`'s arm on its own subject.
       *
       * `normalize 0 entity names, merge 0 aliases` was the subject of exactly the commit that filed new
       * `confirm:` tasks, and that is the ordinary shape of a deferring night rather than an unusual one:
       * the review band and the confidence floor exist so the phase REFUSES to merge, so its whole output
       * on those nights is the tasks the subject reported as nothing.
       *
       * The rewrite subject wins whenever a file was rewritten, so this is a branch: a night that
       * normalized a name AND filed a task still reports the rewrite, which is the write a reviewer audits.
       */
      rewritten === 0 && mintReport.minted.length > 0
        ? "file confirm: tasks for undecided entity pairs"
        : `normalize ${normalized} entity names, merge ${fuzzyMerges} aliases`,
      final,
      closed === 0
        ? undefined
        : `Closed ${closed} confirm task(s): the pair is no longer undecided on a complete pass — it merged, it left the review band, or its names left the corpus.`
    )
    return { counts: final, commitSha, llmCalls }
  })
