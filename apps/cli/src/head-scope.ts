import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { normalizePath } from "@memhtml/contracts/paths"
import { MEMORY_TYPES } from "@memhtml/contracts/types"
import { parseMemory } from "@memhtml/html"
import {
  chunkText,
  disclosureTextFor,
  EXCLUDED_BY_DEFAULT,
  entityRowsFor,
  truncateSnippet,
  workspaceOf
} from "@memhtml/index"
import { Effect, Exit } from "effect"

import type { HeadScope, HitDetail, ScopeReport } from "./head-protocol.js"

/**
 * The server half of `memory_search` and `memory_recall` over the head (`docs/v2-poc.md`, "Search
 * and recall on the head"): v1's scope rules as a predicate over records, and the per-hit fields v1's
 * index holds, computed from the record the answer ranked.
 *
 * Every rule here is v1's, read off the code that implements it there, so one scope admits one set
 * of files through either door: `assembleScope` (`@memhtml/index` `scope.ts`) for the predicate,
 * `projectFile` (`project.ts`) for the columns, `hydrate` and `archivedInScope` (`retrieval.ts`)
 * for `supersededBy` and the empty-scope pointer. The helpers v1 exports (`entityRowsFor`,
 * `disclosureTextFor`, `chunkText`, `truncateSnippet`, `workspaceOf`) are called, not copied.
 */

/**
 * What v1 derives from a file beyond the record's own fields: its `file_entities` rows (the
 * `memhtml-entity` metas plus one `concept:` per `<dfn>` and one `lang:` per `<code data-lang>`), the
 * recall disclosure text, and the opening chunk. Parsed once per record: records are immutable and
 * shared across versions by reference, so a `WeakMap` keyed on the record holds each parse exactly
 * as long as some version holds the record.
 */
interface Derived {
  readonly entityRefs: ReadonlyArray<string>
  readonly entityNames: ReadonlyArray<string>
  /** `entityRefs` ASCII-lowercased, the fold v1's entity scope applies with SQLite's `lower()`. */
  readonly entityKeys: ReadonlySet<string>
  readonly disclosureText: string
  readonly snippet: string
}

const derivedCache = new WeakMap<MemoryRecord, Derived>()

/**
 * SQLite's `lower()`: ASCII only. JavaScript's `toLowerCase` folds all of Unicode, so using it would
 * make `place:CAFÉ` match here and miss in v1.
 */
const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

const derivedOf = (record: MemoryRecord): Derived => {
  const held = derivedCache.get(record)
  if (held !== undefined) return held
  // Every record in a version parsed once already (`recordFrom`), so this parse cannot fail; a
  // failure would still leave the record's own fields, and it is read as a record with no derived
  // entities and its claim as the disclosure.
  const parsed = Effect.runSyncExit(parseMemory(record.html))
  const doc = Exit.isSuccess(parsed) ? parsed.value : undefined
  const rows =
    doc === undefined
      ? record.entities.map((entity) => {
          const at = entity.indexOf(":")
          return at < 1
            ? { entityType: "unknown", entityName: entity }
            : { entityType: entity.slice(0, at), entityName: entity.slice(at + 1) }
        })
      : entityRowsFor(doc)
  const entityRefs = [...new Set(rows.map((row) => `${row.entityType}:${row.entityName}`))].sort()
  const derived: Derived = {
    entityRefs,
    entityNames: rows.map((row) => row.entityName),
    entityKeys: new Set(entityRefs.map(asciiLower)),
    disclosureText: doc === undefined ? record.claim : disclosureTextFor(doc),
    snippet: truncateSnippet(chunkText(record.bodyText, record.contentHash)[0]?.text ?? "")
  }
  derivedCache.set(record, derived)
  return derived
}

/**
 * Did the scope narrow anything? v1's `scopeNarrows`: a named type, a workspace, a non-blank tag, an
 * entity, or a facet with both halves. What decides whether an empty answer is the scope's.
 */
export const scopeNarrows = (scope: HeadScope): boolean =>
  (scope.memoryTypes ?? []).length > 0 ||
  (scope.workspace !== undefined && scope.workspace !== "") ||
  (scope.tags ?? []).some((tag) => tag.trim() !== "") ||
  (scope.entity !== undefined && scope.entity !== "") ||
  (scope.facets ?? []).some((facet) => facet.name.trim() !== "" && facet.value.trim() !== "")

/**
 * The scope as a predicate over one record, archived or not; `searchHead` applies it to active
 * records inside each arm. Each axis is `assembleScope`'s condition for it:
 *
 * - types: any of the named ones that are in the vocabulary, else every type but `task`;
 * - workspace: strict equality with the directory under `projects/`, so an unplaced record never
 *   matches a named workspace;
 * - tags: any of the non-blank ones, compared as sent with the record's trimmed tags (v1 binds the
 *   caller's value and stores the trimmed one);
 * - entity: the trimmed reference against the record's `type:name` references, both ASCII-lowercased;
 * - facets: one condition per trimmed name, any of its trimmed values, conditions ANDed.
 */
export const admitFor = (scope: HeadScope): ((record: MemoryRecord) => boolean) => {
  const named = (scope.memoryTypes ?? []).filter((type) =>
    (MEMORY_TYPES as ReadonlyArray<string>).includes(type)
  )
  const types = named.length > 0 ? new Set(named) : null
  const workspace = scope.workspace !== undefined && scope.workspace !== "" ? scope.workspace : null
  const tags = (scope.tags ?? []).filter((tag) => tag.trim() !== "")
  const entity =
    scope.entity !== undefined && scope.entity !== "" ? asciiLower(scope.entity.trim()) : null
  const facets = new Map<string, Set<string>>()
  for (const facet of scope.facets ?? []) {
    const name = facet.name.trim()
    const value = facet.value.trim()
    if (name === "" || value === "") continue
    const values = facets.get(name) ?? new Set<string>()
    values.add(value)
    facets.set(name, values)
  }
  return (record) => {
    if (types === null ? record.memoryType === EXCLUDED_BY_DEFAULT : !types.has(record.memoryType))
      return false
    if (workspace !== null && workspaceOf(record.path) !== workspace) return false
    if (tags.length > 0) {
      const held = new Set(record.tags.map((tag) => tag.trim()))
      if (!tags.some((tag) => held.has(tag))) return false
    }
    if (entity !== null && !derivedOf(record).entityKeys.has(entity)) return false
    for (const [name, values] of facets) {
      if (!record.facets.some((facet) => facet.name === name && values.has(facet.value)))
        return false
    }
    return true
  }
}

/**
 * The record whose authored `supersedes` link names `path`, or `null`: v1's `superseded_by`, the
 * `src_path` of the winner's edge. v1 breaks a tie between two winners by the edge's index time,
 * which a version does not have; the record updated last wins here, then the path.
 */
export const supersededByOf = (view: HeadView, path: string): string | null => {
  const sources = new Set([...view.inbound(`/${path}`), ...view.inbound(path)])
  let best: MemoryRecord | null = null
  for (const source of sources) {
    const record = view.get(source)
    if (record === undefined || record.path === path) continue
    const names = record.links.some(
      (link) => link.rel === "supersedes" && normalizePath(link.href) === path
    )
    if (!names) continue
    if (
      best === null ||
      record.updatedAt > best.updatedAt ||
      (record.updatedAt === best.updatedAt && record.path < best.path)
    )
      best = record
  }
  return best?.path ?? null
}

/** The fields `memory_search` reports for one record, as v1's `files` row and joins hold them. */
export const hitDetailOf = (view: HeadView, record: MemoryRecord): HitDetail => {
  const derived = derivedOf(record)
  return {
    title: record.title,
    memoryType: record.memoryType,
    // `projectFile` stores `confidence ?? 1.0`: a file that states none is fully believed.
    confidence: record.confidence ?? 1,
    updatedAt: record.updatedAt,
    snippet: derived.snippet,
    entities: derived.entityRefs,
    entityNames: derived.entityNames,
    supersededBy: supersededByOf(view, record.path),
    disclosureText: derived.disclosureText
  }
}

/**
 * The scope's report for an answer with `hits` hits: v1's `scopeEmpty` and, when it is true, the
 * archived records the same scope matches, sorted by path, at most `max(1, limit)` of them, with the
 * total. The archived flag is what flips; every other axis is the one that emptied the search.
 */
export const scopeReportOf = (
  view: HeadView,
  scope: HeadScope,
  hits: number,
  limit: number
): ScopeReport => {
  const empty = hits === 0 && scopeNarrows(scope)
  if (!empty) return { empty, archivedMatches: 0, archived: [] }
  const admit = admitFor(scope)
  const matches: Array<MemoryRecord> = []
  for (const record of view.records()) {
    if (record.archived && admit(record)) matches.push(record)
  }
  matches.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return {
    empty,
    archivedMatches: matches.length,
    archived: matches.slice(0, Math.max(1, limit)).map((record) => ({
      path: record.path,
      supersededBy: supersededByOf(view, record.path)
    }))
  }
}
