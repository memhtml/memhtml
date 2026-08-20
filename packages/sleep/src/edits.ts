import type { EdgeRel } from "@memhtml/contracts/edges"
import type { StorageFailure } from "@memhtml/contracts/errors"
import { archivePathFor, normalizePath } from "@memhtml/contracts/paths"
import { withCollisionOrdinal } from "@memhtml/contracts/slug"
import { addLink, addMeta, escapeAttribute, readMeta, removeLink, setMeta } from "@memhtml/html"
import { attemptIo, type GitFailure, readFileOrNull } from "@memhtml/store"
import { Effect } from "effect"

import type { PhaseEnv } from "./env.js"

/**
 * The file-level operations a phase performs. Each one stages; none commits.
 *
 * Staging without committing is what lets one phase produce ONE commit covering every file it
 * touched: dedup-merge stamps a keeper and moves several dropped files, and splitting that across
 * commits would leave an interrupted run with a `memhtml-supersedes` pointing at a file still sitting at
 * its live path.
 *
 * **Every head edit goes through `setMeta`/`addLink`/`removeLink`.** They splice by source offset, so
 * the article's bytes provably do not move on a bookkeeping pass, and neither does the content hash or
 * the dedupe key. A parse→serialize round trip drops a `<pre>` newline per write, which would
 * make a no-op decay pass look like a content change in `git diff` and, worse, move the dedup key of
 * a file nobody edited.
 */

/** The `<link href>` document-reference form of a git-tree path: repo-root-relative, leading slash. */
export const hrefFor = (path: string): string => `/${normalizePath(path)}`

/**
 * Rewrite ONE repeatable `memhtml-entity` value in place, collapsing onto a value already present.
 *
 * The surgical editors cannot express this: `setMeta` writes the first meta of a name and `addMeta`
 * appends, and entity resolution has to change the third of four `memhtml-entity` lines. So the line is
 * spliced by exact match against what the serializer writes. That stays head-only, and the article's
 * bytes are provably outside the edited range because the match is a complete `<meta …>` line.
 *
 * Collapsing instead of doubling is required for correctness. Two aliases of one entity on the SAME
 * file both rewrite to the canonical, and two identical `memhtml-entity` metas project to two identical
 * `file_entities` rows whose primary key rejects the second. That fails the whole `writeAll` batch and
 * takes the rest of the indexing pass with it.
 */
export const rewriteEntityMeta = (html: string, from: string, to: string): string => {
  const fromLine = entityMetaLine(from)
  if (!html.includes(fromLine)) return html
  if (html.includes(entityMetaLine(to))) {
    const at = html.indexOf(fromLine)
    const lineEnd = html.indexOf("\n", at)
    return html.slice(0, at) + html.slice(lineEnd === -1 ? at + fromLine.length : lineEnd + 1)
  }
  return html.replace(fromLine, entityMetaLine(to))
}

/** One `memhtml-entity` line, byte-identical to what `@memhtml/html`'s serializer and editors emit. */
const entityMetaLine = (value: string): string =>
  `<meta name="memhtml-entity" content="${escapeAttribute(value)}">`

/** An absolute filesystem path inside the memory repo. */
export const absoluteIn = (env: PhaseEnv, path: string): string =>
  `${env.deps.git.root}/${normalizePath(path)}`

/** One file's current bytes, or `undefined` when the path holds no file. */
export const readFileBytes = (
  env: PhaseEnv,
  path: string
): Effect.Effect<string | undefined, StorageFailure> =>
  readFileOrNull(absoluteIn(env, path)).pipe(Effect.map((html) => html ?? undefined))

/** Write bytes, creating the parent directory. Neither git nor `mv` will create one. */
export const writeFileBytes = (
  env: PhaseEnv,
  path: string,
  html: string
): Effect.Effect<void, StorageFailure> =>
  attemptIo(`sleep.write:${path}`, async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    const absolute = absoluteIn(env, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, html, "utf8")
  })

/** One head edit: a meta to set or append, a link to add, or a link to drop. */
export type HeadEdit =
  | { readonly kind: "meta"; readonly name: string; readonly value: string }
  | { readonly kind: "addMeta"; readonly name: string; readonly value: string }
  | { readonly kind: "addLink"; readonly rel: EdgeRel; readonly href: string }
  | { readonly kind: "removeLink"; readonly rel: EdgeRel; readonly href?: string | undefined }

/** A meta edit, as a value. */
export const meta = (name: string, value: string): HeadEdit => ({ kind: "meta", name, value })

/**
 * An APPEND to a repeatable meta, as a value. `setMeta` writes the first value of a name and cannot
 * express a second, so a phase adding one more `memhtml-tag` needs this constructor.
 *
 * Idempotent, because `addMeta` returns the input unchanged when the value is already present — which is
 * what keeps a re-run of a phase that appends a tag free, the same property `stampFile` reads.
 */
export const addTag = (value: string): HeadEdit => ({
  kind: "addMeta",
  name: "memhtml-tag",
  value
})

/** A link addition, as a value. */
export const link = (rel: EdgeRel, href: string): HeadEdit => ({ kind: "addLink", rel, href })

/** A link removal, as a value. Omitting `href` drops every link of that rel. */
export const unlink = (rel: EdgeRel, href?: string): HeadEdit =>
  href === undefined ? { kind: "removeLink", rel } : { kind: "removeLink", rel, href }

/** Apply head edits to bytes in order. Pure. */
export const applyHeadEdits = (html: string, edits: ReadonlyArray<HeadEdit>): string => {
  let out = html
  for (const edit of edits) {
    if (edit.kind === "meta") out = setMeta(out, edit.name, edit.value)
    else if (edit.kind === "addMeta") out = addMeta(out, edit.name, edit.value)
    else if (edit.kind === "addLink") out = addLink(out, edit.rel, edit.href)
    else out = removeLink(out, edit.rel, edit.href)
  }
  return out
}

/**
 * Apply head edits to a file and stage it. Returns true when the bytes actually changed.
 *
 * The no-change return is what makes a re-run of any bookkeeping phase free: `setMeta` writing the
 * value already present and `addLink` on a pair already present both return the input unchanged, so
 * nothing is written, nothing is staged, and the phase's commit is empty and therefore skipped.
 */
export const stampFile = (
  env: PhaseEnv,
  path: string,
  edits: ReadonlyArray<HeadEdit>
): Effect.Effect<boolean, StorageFailure | GitFailure> =>
  Effect.gen(function* () {
    const html = yield* readFileBytes(env, path)
    if (html === undefined) return false
    const edited = applyHeadEdits(html, edits)
    if (edited === html) return false
    yield* writeFileBytes(env, path, edited)
    yield* env.deps.git.add([normalizePath(path)])
    return true
  })

/**
 * Move a file to its archive path with the archive stamps applied, staged not committed. Returns the
 * archive path, or `null` when the source path holds no file.
 *
 * **A missing source path returns `null` instead of failing, which this module depends on.** Every
 * phase reads its candidates from the INDEX, which is refreshed once in preflight and not again, so a
 * path an earlier phase archived is still listed active at its old path when a later phase reads it.
 * Two phases legitimately reach the same file: retention triage evicts a memory scoring below the
 * floor, the reprieve phase expires a memory whose TTL passed, and one memory is frequently both. The
 * TREE is the system of record, so a path with no file behind it is not a candidate. That gives a
 * re-run the same idempotence the design claims, applied WITHIN a run.
 *
 * (Found by an integration test on a real repo, 2026-08-02: retention triage evicted a TTL-passed
 * memory and the reprieve phase then failed on the same path. A stateless fake would have passed.
 * The metarepo's recurring lesson, sixth variant: the contaminating state was another PHASE's write.)
 *
 * `mkdir -p` first, because `git mv` rejects a destination whose parent does not exist (probed live
 * 2026-08-02, `fatal: renaming … failed: No such file or directory`). The year partition is new
 * every January, so this is not a rare path.
 *
 * The stamps ride in the SAME commit as the move, so nothing downstream may gate on a
 * `R100` similarity score. Rename similarity is computed tree-to-tree, so a head stamp in the same
 * commit lowers it (measured R059-R087 on real memory files). `originalPathFor` is the authoritative
 * inverse of the archive mapping, and no correctness path here reads the score.
 *
 * **The destination is PROBED, and a taken one gets an ordinal.** `git mv` onto a path that already
 * holds a file exits 128 (`fatal: destination exists`, measured 2026-08-19), which fails the whole
 * phase rather than the one file. That is reachable — not hypothetically — because one live path can be
 * archived TWICE INSIDE ONE YEAR, and the year is the only partition the mapping has:
 *
 * - A DETECTED task's path is deliberately deterministic (`tasks.ts`: the digest keys the finding, so a
 *   finding restated tomorrow lands on the same path on purpose). Mint, sweep-close, the finding
 *   reappears, sweep-close again — and the second close aims at the first close's archive path.
 * - Any path a human restores out of the archive and lets a later night evict again is the same shape
 *   with no detector involved.
 *
 * So the fix is here rather than in `tasks.ts`: the collision is a property of the ARCHIVE mapping, and
 * every phase that archives — retention triage, reprieve, dedup's drops, compress's members — has the
 * same exposure. The ordinal is `-2`, `-3`, … at the first FREE candidate, deterministic given the tree,
 * and it goes through `withCollisionOrdinal` so it lands inside `SLUG_MAX_LENGTH` exactly as
 * `trace-consolidation`'s `freePath` and the store's own collision loop do.
 *
 * **A suffixed destination is no longer `originalPathFor`'s inverse, and that is the stated cost.** The
 * first archiving of a path keeps the unsuffixed name, so `integrity`'s dangling-href repair still finds
 * it and every existing inverse assertion holds; a SECOND archiving of one path is a second file whose
 * name says so. Nothing reads the inverse to decide a write — `integrity` searches a known-path set and
 * falls back to dropping the edge — so the alternative (failing the phase) is strictly worse.
 *
 * Exhausting the ordinals logs and answers `null`, which leaves the file at its live path. `null`
 * already means "not archived" to every caller, so an exhausted probe is counted as a file that did not
 * move rather than one that was destroyed.
 */
export const archiveFile = (
  env: PhaseEnv,
  path: string,
  extraEdits: ReadonlyArray<HeadEdit> = []
): Effect.Effect<string | null, StorageFailure | GitFailure> =>
  Effect.gen(function* () {
    const normalized = normalizePath(path)
    const html = yield* readFileBytes(env, normalized)
    if (html === undefined) return null

    const target = yield* freeArchivePath(env, normalized)
    if (target === undefined) {
      yield* Effect.logWarning(
        `sleep.archive refused ${normalized}: every archive ordinal is taken, so the file stays live`
      )
      return null
    }

    yield* attemptIo(`sleep.archive.mkdir:${target}`, async () => {
      const { mkdir } = await import("node:fs/promises")
      const { dirname } = await import("node:path")
      await mkdir(dirname(absoluteIn(env, target)), { recursive: true })
    })
    yield* env.deps.git.mv(normalized, target)

    const stamped = applyHeadEdits(html, [
      meta("memhtml-status", "archived"),
      meta("memhtml-updated", env.at),
      meta("memhtml-archived", env.at),
      ...extraEdits
    ])
    if (stamped !== html) yield* writeFileBytes(env, target, stamped)
    yield* env.deps.git.add([target])
    return target
  })

/**
 * Archive ordinals tried before a file is left where it is. The store's own ceiling and
 * `trace-consolidation`'s, verbatim, so the three collision loops in this repo agree on the number.
 */
const ARCHIVE_ORDINAL_LIMIT = 1000

/**
 * The lowest free archive path for a live path, or `undefined` when every ordinal is taken.
 *
 * DISK is the only authority, and it is enough: a phase archiving one path twice in one run cannot
 * happen, because the first `git mv` takes the file away and `archiveFile`'s own missing-source read
 * answers `null` for the second. So there is no in-run `claimed` set to union in, which is the one
 * half `trace-consolidation`'s `freePath` needs and this does not.
 */
const freeArchivePath = (
  env: PhaseEnv,
  normalized: string
): Effect.Effect<string | undefined, StorageFailure> =>
  Effect.gen(function* () {
    const year = yearOf(env.date)
    for (let ordinal = 1; ordinal <= ARCHIVE_ORDINAL_LIMIT; ordinal += 1) {
      const candidate = withArchiveOrdinal(archivePathFor(normalized, year), ordinal)
      if ((yield* readFileBytes(env, candidate)) === undefined) return candidate
    }
    return undefined
  })

/**
 * A path with a collision ordinal spliced into its filename STEM, before the extension.
 *
 * Before the extension rather than after, so the result is still an `.html` path the indexer reads and
 * the parser accepts. Ordinal 1 is the bare path, matching `withCollisionOrdinal`'s own convention, so
 * the ordinary single-archiving case produces byte-identical paths to what this function replaced.
 */
export const withArchiveOrdinal = (path: string, ordinal: number): string => {
  if (ordinal <= 1) return path
  const cut = path.lastIndexOf("/")
  const directory = path.slice(0, cut + 1)
  const filename = path.slice(cut + 1)
  const dot = filename.lastIndexOf(".")
  const stem = dot <= 0 ? filename : filename.slice(0, dot)
  const extension = dot <= 0 ? "" : filename.slice(dot)
  return `${directory}${withCollisionOrdinal(stem, ordinal)}${extension}`
}

/** The calendar year an archive path partitions under, from the run's own injected date. */
export const yearOf = (date: string): number => {
  const year = Number(date.slice(0, 4))
  return Number.isFinite(year) && year > 0 ? year : new Date(`${date}T00:00:00Z`).getUTCFullYear()
}

/** A head meta's current value, or `undefined`. Reads bytes; no parse. */
export const metaOf = (html: string, name: string): string | undefined => readMeta(html, name)

/** A confidence meta as a number in `[0, 1]`, defaulting to 1.0 exactly as the `files` column does. */
export const confidenceOf = (html: string): number => {
  const raw = readMeta(html, "memhtml-confidence")
  if (raw === undefined) return 1
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

/** A reprieve count as a non-negative integer, defaulting to 0. */
export const reprievesOf = (html: string): number => {
  const raw = readMeta(html, "memhtml-reprieves")
  if (raw === undefined) return 0
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/**
 * A confidence rendered for the `memhtml-confidence` meta: three decimals, no exponent.
 *
 * Three decimals, not two, because the commit gate is a 0.005 delta. At two decimals a change of
 * exactly 0.005 would round to the same string on both sides and the phase would gate a commit it
 * then could not make, leaving the file's stated confidence permanently behind the computed one.
 */
export const renderConfidence = (value: number): string =>
  Math.max(0, Math.min(1, value)).toFixed(3)

/** An ISO date `days` after `date`, for the reprieve extension. Pure, UTC, no clock read. */
export const datePlusDays = (date: string, days: number): string => {
  const base = Date.parse(`${date}T00:00:00Z`)
  const shifted = new Date((Number.isFinite(base) ? base : 0) + days * 86_400_000)
  return `${shifted.toISOString().slice(0, 19)}Z`
}

/** The href form of a path as it appears in a file, for comparing against a `<link href>`. */
export const hrefsEqual = (left: string, right: string): boolean =>
  normalizePath(left) === normalizePath(right)
