import {
  ARCS_DIR,
  type HeadView,
  INBOX_DIR,
  type MemoryRecord,
  PEOPLE_DIR,
  slugify,
  TASKS_SUBDIR,
  withCollisionOrdinal
} from "@memhtml/contracts"

/**
 * The inbox work list: every active record under `areas/inbox/`, each with the home code would file
 * it under and the evidence for that home, so the curator's placement priority is a list of
 * judgments rather than a search (`docs/v2-poc.md`, "Curator").
 *
 * ## Why code computes the home
 *
 * On 2026-09-30, 534 of the live store's 806 active records sat in the inbox, the fleet added 9 to
 * 66 more a day, and the two curator runs so far had moved none: the charter ranked placement sixth
 * with no list to work from, and no op could move a record at all (a `put` of its bytes at a new
 * path is a `duplicate` of the inbox copy; `move` is the op that fixes that). What makes a home
 * obvious is mechanical enough to compute: the record names the home (an entity or a tag whose name
 * is the home's directory name, the rule v1's write path filed `resources/<tag>/` by), or the
 * home's records carry the record's entities.
 *
 * ## The rule
 *
 * A home is a directory `areas/<slug>/` or `resources/<tag>/` holding at least one active record,
 * except the inbox itself, `areas/arcs/`, `resources/people/`, and the writer buckets
 * ({@link isBucketHome}: an importer's `*-import`, a dated `working-thread-*`, and
 * `trace-consolidation`, which name who wrote a record rather than what it is about). An entity
 * carried by more than {@link GENERIC_ENTITY_SHARE} of the active records (never fewer than
 * {@link GENERIC_ENTITY_FLOOR}) is the store's subject rather than a record's, and places nothing:
 * `person:laith` on 209 of 838 active records on 2026-09-30.
 *
 * Each candidate scores {@link NAMED_WEIGHT} per entity whose name is the home's directory name, 1
 * per tag that is, and 1 per record at the home carrying each of the record's entities. The best
 * candidate is the record's `home` when it is named by an entity or has at least
 * {@link SHARED_MIN} carrier records, and strictly outscores the next; a tag match alone is
 * evidence, not a home. With no such home, a record whose project, repo, service, system, or topic
 * entity is carried by at least {@link NEW_HOME_MIN} inbox records gets a new
 * `resources/<entity name>/` home, so the records that share it can open it together. Anything else
 * is listed with `home: null`, for the model to judge or leave.
 */

/** One home a record could be filed under, with what makes it that home. */
export interface CandidateHome {
  /** `areas/<slug>` or `resources/<tag>`, with no trailing slash. */
  readonly dir: string
  /** The path the record moves to: the directory plus its own filename, or a free variant of it. */
  readonly to: string
  /** `existing` for a directory that holds records now, `new` for one the move would open. */
  readonly kind: "existing" | "new"
  /** Active records at the directory now; `0` for a new home. */
  readonly records: number
  readonly score: number
  /** The record's entities whose name is the directory's name. */
  readonly named: ReadonlyArray<string>
  /** The record's tags whose slug is the directory's name. */
  readonly tagged: ReadonlyArray<string>
  /** The record's entities the home's records carry, with how many of them carry each. */
  readonly shared: ReadonlyArray<{ readonly entity: string; readonly records: number }>
  /** For a new home: the inbox records carrying the naming entity, this one included. */
  readonly peers?: number
}

/** One inbox record with its code-computed home, or `null` when none is obvious. */
export interface InboxRecord {
  readonly path: string
  /** The claim, cut at {@link INBOX_CLAIM_CHARS}; `read` has the rest. */
  readonly claim: string
  readonly memoryType: string
  readonly entities: ReadonlyArray<string>
  readonly home: CandidateHome | null
  /**
   * The best existing directory the record did not get, with its score, so a close call is visible:
   * the runner-up to an existing home, else the best candidate that was not confident.
   */
  readonly alternative: { readonly dir: string; readonly score: number } | null
}

/** One destination the inbox list would fill, with how many inbox records it would take. */
export interface InboxHome {
  readonly dir: string
  readonly kind: "existing" | "new"
  readonly inbox: number
}

export interface InboxWorkList {
  readonly inbox: ReadonlyArray<InboxRecord>
  /** Every eligible inbox record, before the cap. */
  readonly inboxTotal: number
  /** How many of them carry a `home`. */
  readonly inboxWithHome: number
  /** The destinations, most records first, capped at {@link INBOX_HOMES_CAP}. */
  readonly inboxHomes: ReadonlyArray<InboxHome>
}

/**
 * Inbox records one run should file, the charter's placement quota. The fleet filed 9 to 66 records
 * a day into the inbox in the week to 2026-09-30 (84 over the last three days), so a quota below
 * about 30 never drains it; 60 moves plus their repoints (5 live edges named an inbox record that
 * day) take about 60 of the 200-op cap, leaving the rest for the priorities ranked around it, and fit
 * one `propose` call of a few thousand output tokens.
 */
export const PLACEMENT_QUOTA = 60

/** Records the inbox list quotes: a run's quota plus room to skip a third of it and still fill it. */
export const BRIEFING_INBOX_CAP = 80
export const INBOX_HOMES_CAP = 20
export const INBOX_CLAIM_CHARS = 200
/** An entity carried by more than this share of the active records places nothing. */
export const GENERIC_ENTITY_SHARE = 0.2
/** ...and never a floor lower than this many records, so a small store keeps its entities. */
export const GENERIC_ENTITY_FLOOR = 10
export const NAMED_WEIGHT = 3
/** Carrier records a home needs, with no entity naming it, to be the record's home. */
export const SHARED_MIN = 2
/** Inbox records that must carry one entity before it opens a new home. */
export const NEW_HOME_MIN = 3
/** Entity types that name what a directory of records is about; a person or a file does not. */
export const NEW_HOME_TYPES: ReadonlySet<string> = new Set([
  "project",
  "repo",
  "service",
  "system",
  "topic"
])

const INBOX = `${INBOX_DIR}/`
const INBOX_TASKS = `${INBOX_DIR}/${TASKS_SUBDIR}/`
/** Directories that are never a placement home: where records come from, and the curated planes. */
const NOT_HOMES: ReadonlySet<string> = new Set([INBOX_DIR, ARCS_DIR, PEOPLE_DIR])
const HOME_BUCKETS: ReadonlyArray<string> = ["areas", "resources"]

/**
 * True when a directory name is a writer's bucket rather than a subject: an importer's
 * (`wiki-kernel-import`, 70 active records on 2026-09-30), a dated working thread
 * (`working-thread-2026-09-10`), or trace consolidation's, the writer the 2026-09-24 audit found
 * filing a lesson from every run.
 */
export const isBucketHome = (name: string): boolean =>
  name.endsWith("-import") ||
  name.startsWith("working-thread") ||
  /-\d{4}-\d{2}-\d{2}$/.test(name) ||
  name === "trace-consolidation"

/** The `areas/<x>` or `resources/<x>` directory a path sits under, or `null`. */
const homeDirOf = (path: string): string | null => {
  const segments = path.split("/")
  if (segments.length < 3 || !HOME_BUCKETS.includes(segments[0] ?? "")) return null
  return `${segments[0]}/${segments[1]}`
}

/** The names an entity can go by as a directory: its name slugged, and its last `/` segment's. */
const entitySlugs = (entity: string): ReadonlyArray<string> => {
  const name = entity.slice(entity.indexOf(":") + 1)
  const last = name.slice(name.lastIndexOf("/") + 1)
  return [...new Set([slugify(name), slugify(last)])]
}

const entityType = (entity: string): string => entity.slice(0, Math.max(0, entity.indexOf(":")))

const cut = (text: string, chars: number): string =>
  text.length <= chars ? text : `${text.slice(0, chars - 1)}…`

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** True when a record is an inbox record the list quotes: not a task, a verdict, or a people record. */
export const isPlaceable = (record: MemoryRecord, headlineTypes: ReadonlySet<string>): boolean =>
  !record.archived &&
  record.path.startsWith(INBOX) &&
  !record.path.startsWith(INBOX_TASKS) &&
  !headlineTypes.has(record.memoryType)

/** `dir/<the record's filename>`, or the first `-<n>` variant no record in the view holds. */
const destinationIn = (view: HeadView, dir: string, path: string, taken: Set<string>): string => {
  const filename = path.slice(path.lastIndexOf("/") + 1)
  const stem = filename.replace(/\.html$/, "")
  for (let ordinal = 1; ; ordinal += 1) {
    const to = `${dir}/${withCollisionOrdinal(stem, ordinal)}.html`
    if (view.get(to) === undefined && !taken.has(to)) {
      taken.add(to)
      return to
    }
  }
}

/**
 * The inbox work list over a view. Pure and deterministic: the same view yields the same list.
 * `headlineTypes` are the types whose claim is a headline (`task`, `verdict`), which the list
 * excludes as every other briefing list does.
 */
export const inboxWorkList = (
  view: HeadView,
  headlineTypes: ReadonlySet<string>
): InboxWorkList => {
  const active: Array<MemoryRecord> = []
  for (const record of view.records()) if (!record.archived) active.push(record)
  const genericCap = Math.max(GENERIC_ENTITY_FLOOR, GENERIC_ENTITY_SHARE * active.length)
  const carriers = new Map<string, number>()
  for (const record of active) {
    for (const entity of new Set(record.entities)) {
      carriers.set(entity, (carriers.get(entity) ?? 0) + 1)
    }
  }
  const specific = (entity: string): boolean => (carriers.get(entity) ?? 0) <= genericCap

  // Homes, with per home the count of its records carrying each entity.
  const homes = new Map<string, { records: number; entities: Map<string, number> }>()
  const everyDir = new Set<string>()
  for (const record of active) {
    const dir = homeDirOf(record.path)
    if (dir === null) continue
    everyDir.add(dir)
    const name = dir.slice(dir.indexOf("/") + 1)
    if (NOT_HOMES.has(dir) || isBucketHome(name)) continue
    const home = homes.get(dir) ?? { records: 0, entities: new Map<string, number>() }
    home.records += 1
    for (const entity of new Set(record.entities)) {
      home.entities.set(entity, (home.entities.get(entity) ?? 0) + 1)
    }
    homes.set(dir, home)
  }
  const homesByName = new Map<string, Array<string>>()
  for (const dir of homes.keys()) {
    const name = dir.slice(dir.indexOf("/") + 1)
    homesByName.set(name, [...(homesByName.get(name) ?? []), dir])
  }

  const placeable = active
    .filter((record) => isPlaceable(record, headlineTypes))
    .sort((a, b) => byText(a.path, b.path))
  const inboxCarriers = new Map<string, number>()
  for (const record of placeable) {
    for (const entity of new Set(record.entities)) {
      inboxCarriers.set(entity, (inboxCarriers.get(entity) ?? 0) + 1)
    }
  }

  const taken = new Set<string>()
  const entries: Array<InboxRecord> = placeable.map((record) => {
    const candidates = new Map<
      string,
      { named: Set<string>; tagged: Set<string>; shared: Map<string, number> }
    >()
    const candidate = (dir: string) => {
      const known = candidates.get(dir)
      if (known !== undefined) return known
      const fresh = { named: new Set<string>(), tagged: new Set<string>(), shared: new Map() }
      candidates.set(dir, fresh)
      return fresh
    }
    const entities = [...new Set(record.entities)].filter(specific)
    for (const entity of entities) {
      for (const slug of entitySlugs(entity)) {
        for (const dir of homesByName.get(slug) ?? []) candidate(dir).named.add(entity)
      }
      for (const [dir, home] of homes) {
        const count = home.entities.get(entity) ?? 0
        if (count > 0) candidate(dir).shared.set(entity, count)
      }
    }
    for (const tag of new Set(record.tags)) {
      for (const dir of homesByName.get(slugify(tag)) ?? []) candidate(dir).tagged.add(tag)
    }
    const scored = [...candidates]
      .map(([dir, found]) => {
        const shared = [...found.shared]
          .map(([entity, records]) => ({ entity, records }))
          .sort((a, b) => b.records - a.records || byText(a.entity, b.entity))
        const sharedRecords = shared.reduce((sum, one) => sum + one.records, 0)
        return {
          dir,
          named: [...found.named].sort(byText),
          tagged: [...found.tagged].sort(byText),
          shared,
          sharedRecords,
          score: NAMED_WEIGHT * found.named.size + found.tagged.size + sharedRecords
        }
      })
      .sort((a, b) => b.score - a.score || byText(a.dir, b.dir))
    const [best, next] = scored
    const asHome = (found: (typeof scored)[number], to: string): CandidateHome => ({
      dir: found.dir,
      to,
      kind: "existing",
      records: homes.get(found.dir)?.records ?? 0,
      score: found.score,
      named: found.named,
      tagged: found.tagged,
      shared: found.shared
    })
    const confident =
      best !== undefined &&
      (best.named.length > 0 || best.sharedRecords >= SHARED_MIN) &&
      (next === undefined || best.score > next.score)
    let home: CandidateHome | null =
      confident && best !== undefined
        ? asHome(best, destinationIn(view, best.dir, record.path, taken))
        : null
    if (home === null) {
      // A new home, named by the entity the most inbox records share with this one.
      const opener = entities
        .filter((entity) => NEW_HOME_TYPES.has(entityType(entity)))
        .filter((entity) => (inboxCarriers.get(entity) ?? 0) >= NEW_HOME_MIN)
        .map((entity) => ({
          entity,
          dir: `resources/${slugify(entitySlugs(entity).at(-1) ?? "")}`
        }))
        .filter(({ dir }) => !everyDir.has(dir) && !isBucketHome(dir.slice(dir.indexOf("/") + 1)))
        .sort(
          (a, b) =>
            (inboxCarriers.get(b.entity) ?? 0) - (inboxCarriers.get(a.entity) ?? 0) ||
            byText(a.entity, b.entity)
        )[0]
      if (opener !== undefined) {
        home = {
          dir: opener.dir,
          to: destinationIn(view, opener.dir, record.path, taken),
          kind: "new",
          records: 0,
          score: NAMED_WEIGHT,
          named: [opener.entity],
          tagged: [],
          shared: [],
          peers: inboxCarriers.get(opener.entity) ?? 0
        }
      }
    }
    const runnerUp = home?.kind === "existing" ? next : best
    return {
      path: record.path,
      claim: cut(record.claim, INBOX_CLAIM_CHARS),
      memoryType: record.memoryType,
      entities: record.entities,
      home,
      alternative: runnerUp === undefined ? null : { dir: runnerUp.dir, score: runnerUp.score }
    }
  })

  const byHome = new Map<string, InboxHome>()
  for (const entry of entries) {
    if (entry.home === null) continue
    const known = byHome.get(entry.home.dir)
    byHome.set(entry.home.dir, {
      dir: entry.home.dir,
      kind: entry.home.kind,
      inbox: (known?.inbox ?? 0) + 1
    })
  }
  // Records with a home first, grouped by home so one proposal files a directory's worth: existing
  // homes before new ones, the home taking the most records first, then by path. The rest follow by
  // path. So the capped list leads with the placements the evidence is strongest for.
  const rank = (entry: InboxRecord): readonly [number, number, string] =>
    entry.home === null
      ? [2, 0, ""]
      : [
          entry.home.kind === "existing" ? 0 : 1,
          -(byHome.get(entry.home.dir)?.inbox ?? 0),
          entry.home.dir
        ]
  entries.sort((a, b) => {
    const [ka, na, da] = rank(a)
    const [kb, nb, db] = rank(b)
    return ka - kb || na - nb || byText(da, db) || byText(a.path, b.path)
  })
  return {
    inbox: entries.slice(0, BRIEFING_INBOX_CAP),
    inboxTotal: entries.length,
    inboxWithHome: entries.filter((entry) => entry.home !== null).length,
    inboxHomes: [...byHome.values()]
      .sort((a, b) => b.inbox - a.inbox || byText(a.dir, b.dir))
      .slice(0, INBOX_HOMES_CAP)
  }
}
