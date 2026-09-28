import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { StorageFailure } from "@memhtml/contracts/errors"
import { memoryPathViolation, originalPathFor } from "@memhtml/contracts/paths"
import { contentHash, LINK_REL_PREFIX, type MemoryDoc, parseMemory } from "@memhtml/html"
import { type CommitScope, isReservedPath } from "@memhtml/session"
import { Effect, Result } from "effect"

import {
  ATOB_BOOTSTRAP,
  CORPUS_MOUNT,
  cutOffByTheRuntime,
  DEFAULT_TIMEOUT_MS,
  type ExecReport,
  GUEST_LIB,
  GUEST_SCRIPT,
  guestHelperPath,
  MAX_TIMEOUT_MS,
  parserSourcePath,
  SHELL_TIMEOUT_GRACE_MS,
  sandboxRunnerPath,
  withBridgeRetry
} from "./exec.js"
import type { ExecLang } from "./exec-lang.js"

/**
 * `session exec`: the v2 sandbox over head plus overlay (`docs/v2-poc.md`, "Sandbox over head plus
 * overlay").
 *
 * `memhtml exec` mounts a pinned git worktree read-only and offers no write path. This runtime differs
 * on both counts and keeps everything else: the guest filesystem is seeded from `view.records()`
 * straight out of memory, so there is no disk worktree, no `git worktree add`, and no temp directory;
 * the mount is writable, so a script edits the corpus as files; and after the script exits the
 * harvester diffs the mounted tree against the seeded bytes and turns the difference into overlay ops.
 * The session, not this module, validates those ops (`@memhtml/session` `validateOps`), so the
 * harvester's job is to say what changed and to refuse what cannot be an op at all.
 *
 * ## What the harvester emits
 *
 * - A new `.html` file is a `put` carrying the file's bytes. So is a seeded file whose article
 *   changed (its content hash differs): the store's rule that a claim is never edited in place is
 *   `validateOps`'s `claim-edit` refusal, not the harvester's, so the put is reported and refused
 *   there.
 * - A seeded file whose bytes changed but whose article content hash did not is a head edit
 *   candidate. The hash digests the article's canonical TEXT, not its bytes, so a markup change
 *   that keeps the words (a `<dfn>` wrap, a new `<aside>`) also keeps the hash; the harvester
 *   therefore parses both versions with `@memhtml/html`'s parser and compares the article markup
 *   as well as the heads. Every `<link rel="memhtml-...">` present after and absent before becomes
 *   one `link` op, and every one present before and absent after becomes one `unlink` op; every
 *   `<meta name="memhtml-entity">` value present after and absent before becomes one `label` op,
 *   and every one present before and absent after one `unlabel` op, because placing or dropping an
 *   edge or an entity are the head edits the store's operations can express. A title or any other
 *   meta changed, article markup changed, or any other head content changed is `rejected` ("head
 *   edit other than adding or removing links or entity labels is not an operation"), and when links
 *   or entities were added or removed beside such a change the reason names both, so the script's
 *   author can split the edit into head ops and a new file plus an archive. Nothing a script
 *   changed goes unreported: an edit is an op or it is a rejection.
 * - A seeded file that is gone, paired with a new `archive/<YYYY>/<its path>` file whose article
 *   content hash equals the seeded record's, is one `archive` op. Deletion is not an operation in
 *   this store (nothing is ever deleted; eviction is a move), so the pair is the only shape a
 *   vanished file can legitimately take. The twin's head is held to the same rule as a file that
 *   stays put: links and entities added to or removed from the copy become `link`, `unlink`,
 *   `label`, and `unlabel` ops on the SOURCE path, emitted before the archive so the commit's staging carries the edit into the archived
 *   copy (`commitSession` builds the destination from the source as the batch left it, never from
 *   the op's bytes); any other head or markup difference rejects the source and leaves the twin
 *   as a put.
 * - Everything else is `rejected` with a reason: a non-`.html` file, anything under `.git`, a
 *   generated `index.html` or `sitemap.xml`, a reserved path (`.memhtml/` under every scope,
 *   `areas/arcs/` and `resources/people/` unless the scope is `curate`), a path outside the PARA
 *   buckets, a vanished file with no archive twin, and a vanished file whose twin holds a different
 *   article. What the harvester lets through is then judged by `validateOps` before it is appended,
 *   so one bad file cannot make the whole session uncommittable.
 *
 * ## Reuse
 *
 * The bridge-fault classification and retry loop, the timeout classifier, the mount path, the report
 * shape, the `atob` bootstrap, the guest paths, and the host paths (the guest helper, the parser
 * bundle, and the sandbox runner) are all imported from `./exec.ts`. Nothing about the sandbox is
 * restated here, so the two runtimes cannot drift on how a guest is built, and this module resolves
 * no path from its own module location: the packaging census (`tests-integration/tests/packaging.test.ts`)
 * names `exec.ts` as the one place `guest/` files and `node-html-parser` are resolved.
 * `./mount.ts`'s `mountReadOnlyRoots` is not used because its one job is to put
 * a HOST directory into the guest read-only, and this runtime has neither a host directory nor a
 * read-only mount.
 *
 * ## Where the sandbox runs
 *
 * The mechanism (seed the guest filesystem, run just-bash, list what differs from the seed) is
 * `guest/sandbox-runner.mjs`, a plain module that runs on the host, and everything that decides what a
 * run means stays here: the limits, the command, the retry, the classifier, and the harvest. A
 * {@link SandboxRunner} carries a job to it: {@link inProcessRunner} (the CLI and the curator) or the
 * head server's worker pool (`exec-pool.ts`), which exists because just-bash holds the thread it runs
 * on. The guest is seeded from a {@link SeedImage}, the view's UTF-8 bytes, which the server keeps per
 * base version ({@link CachedImage}) so a call encodes only what its overlay rewrote. Measured on the
 * 7,437-record clone, a no-op `:` took 471 ms at p50 before (seeded from strings, harvested by a
 * recursive `readdir` walk that reads every file back as text), 168 ms in process now, and 127 ms in a
 * warm worker with the base's image kept.
 */

/**
 * The command and loop-iteration counts a `bash` script runs under: effectively unbounded, so the
 * wall clock is the bound.
 *
 * just-bash counts shell commands (`maxCommandCount`) and `while`/`for`/`until` iterations
 * (`maxLoopIterations`), 100,000 each by default, and a count that runs out ends the script with exit
 * 126 rather than 124. Measured on just-bash 3.4.2: `while true; do :; done` under the defaults stops
 * at 1,565 ms with `bash: too many commands executed (>100000), increase
 * executionLimits.maxCommandCount`, and with only the command count raised at 1,715 ms with `bash:
 * while loop: too many iterations (100000), increase executionLimits.maxLoopIterations`, both far
 * inside a 30 s bound. With both raised the same loop runs to the deadline and reports exit 124,
 * `bash: execution exceeded execution deadline (1500ms)` at a 1,500 ms bound, which is what
 * `--timeout-ms` promises. A `js` script is one shell command, so the counts never mattered there and
 * its limits are left exactly as they were. The other just-bash bounds stay at their defaults (call
 * depth 100, awk, sed, and jq iterations 100,000 each): each ends a runaway in milliseconds with its
 * own message and exit 126, and that is the script's failure, not a timeout.
 */
const BASH_COUNT_LIMIT = Number.MAX_SAFE_INTEGER

/** What `session exec` reports: the script's run plus what the harvester made of the tree it left. */
export interface SessionExecReport extends ExecReport {
  /** The language the script ran as. */
  readonly lang: ExecLang
  /**
   * Overlay ops harvested from the guest tree: `put`s, then the head ops (`link`s, `unlink`s,
   * `label`s, then `unlabel`s, per file), then `archive`s, each group sorted by path (a file's
   * links and entities in document order).
   */
  readonly ops: ReadonlyArray<OverlayOp>
  /** Files the harvester could not turn into an op, each with the reason, sorted by path. */
  readonly rejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

/**
 * Everything `session exec` needs: a version to see, a script to run and the language it is written
 * in, an optional bound, and the writer's scope (`session` unless a curator run says `curate`, which
 * opens the arcs and people prefixes the way `validateOps` does under the same scope). `lang` is
 * required: the CLI's default is `bash` and the curator sends `js`, so each caller states its own.
 */
export interface SessionExecInput {
  readonly view: HeadView
  readonly script: string
  readonly lang: ExecLang
  readonly timeoutMs?: number | undefined
  readonly scope?: CommitScope | undefined
}

/** Why a head edit that is not purely added or removed links and entities is refused. */
export const HEAD_EDIT_REASON =
  "head edit other than adding or removing links or entity labels is not an operation"

/** One file the walk found in the guest tree after the run. */
export interface GuestFile {
  /** Repo-relative, no leading slash. */
  readonly path: string
  readonly html: string
}

/** The seeded set, keyed by repo-relative path, carrying what the harvester compares against. */
export interface Seeded {
  readonly html: string
  readonly contentHash: string
}

/** `contentHash` that answers `null` for bytes with no article instead of throwing. */
const contentHashOrNull = (html: string): string | null => {
  try {
    return contentHash(html)
  } catch {
    return null
  }
}

/**
 * The reason a present file cannot be an op, or `null` when it can. The same reserved-path and
 * PARA-root rules `validateOps` applies under the same scope, asked here so the file lands in
 * `rejected` with a reason instead of in the log as an op no commit will ever accept.
 */
const presentFileProblem = (path: string, scope: CommitScope): string | null => {
  const name = path.slice(path.lastIndexOf("/") + 1)
  if (name === "index.html") return "index.html is a generated listing, not a memory"
  if (name === "sitemap.xml") return "sitemap.xml is generated, not a memory"
  if (!path.endsWith(".html")) return "not an .html file"
  if (isReservedPath(path, scope)) {
    return scope === "curate"
      ? "a reserved path no session writes"
      : "a reserved path only curation writes"
  }
  const pathReason = memoryPathViolation(path)
  if (pathReason !== undefined) return `not a memory path: ${pathReason}`
  return null
}

/** `parseMemory` as a plain value: the doc, or `null` when the bytes are not a memory. */
const parsedOrNull = (html: string): MemoryDoc | null => {
  const result = Effect.runSync(Effect.result(parseMemory(html)))
  return Result.isSuccess(result) ? result.success : null
}

const linkKey = (link: { readonly rel: string; readonly href: string }): string =>
  `${link.rel} -> ${link.href}`

/**
 * Markup with the whitespace the content hash ignores taken out: runs of ASCII whitespace become
 * one space and whitespace between tags is dropped, so a reindented document compares equal to
 * the original while any change to an element or attribute still shows.
 */
const collapseMarkup = (html: string): string =>
  html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim()

/**
 * Every `<link rel="memhtml-...">` element, whatever its attribute order or spelling of the rel.
 * Matched on the bytes rather than cut by `removeLink`, because the parser accepts a token the
 * editor does not spell (`memhtml-relates_to` parses as `relates_to`; the editor writes and cuts
 * `memhtml-relates-to`), and a link the parser counted must be the link this strips.
 */
const MEMHTML_LINK_ELEMENT = new RegExp(
  `<link\\s[^>]*\\brel\\s*=\\s*["']${LINK_REL_PREFIX}[^"']*["'][^>]*>`,
  "gi"
)

/**
 * Every `<meta name="memhtml-entity">` element, whatever its attribute order. Case-sensitive, unlike
 * {@link MEMHTML_LINK_ELEMENT}: the parser reads an entity only from that exact name, so a spelling
 * it would not read stays in the residual and is reported rather than stripped unseen.
 */
const MEMHTML_ENTITY_ELEMENT = /<meta\s[^>]*\bname\s*=\s*["']memhtml-entity["'][^>]*>/g

/**
 * The document with its memhtml links and entity metas taken out, so two heads compare on
 * everything else.
 */
const withoutHeadOps = (html: string): string =>
  html.replace(MEMHTML_LINK_ELEMENT, "").replace(MEMHTML_ENTITY_ELEMENT, "")

/**
 * What a head edit amounts to: the `link` ops for every edge added, the `unlink` ops for every edge
 * removed, the `label` ops for every entity added, and the `unlabel` ops for every entity removed,
 * or the reason it cannot be an op. Called only for a seeded file whose bytes changed
 * and whose article content hash did not. That hash is a digest of the article's canonical TEXT
 * (`@memhtml/html` `canonicalText`), so an equal hash proves the words are the same and nothing
 * more: the article's markup, the head, or only whitespace may differ, and this function tells
 * those apart. `null` when either version does not parse, in which case the caller falls back to a
 * `put` and `validateOps` reports the format violation.
 *
 * Three named differences reject the edit (title, a meta other than an entity, article markup); a
 * fourth, "the head changed beyond the edited links and entities", catches head content the parser
 * accepts and `MemoryDoc` does not surface (a comment, a `<meta>` outside the vocabulary): with
 * every memhtml link and entity meta taken out of both versions, what remains must collapse to the
 * same bytes. It runs only when links or entities were added or removed, so the fallthrough alone
 * names a byte change that edited neither, and no edit leaves here unnamed.
 */
const headEdit = (
  path: string,
  before: string,
  after: string
): { readonly ops: ReadonlyArray<OverlayOp> } | { readonly reason: string } | null => {
  const was = parsedOrNull(before)
  const now = parsedOrNull(after)
  if (was === null || now === null) return null

  const hadLinks = new Set(was.links.map(linkKey))
  const hasLinks = new Set(now.links.map(linkKey))
  const added = now.links.filter((link) => !hadLinks.has(linkKey(link)))
  const removed = was.links.filter((link) => !hasLinks.has(linkKey(link)))
  const hadEntities = new Set(was.entities)
  const hasEntities = new Set(now.entities)
  const labeled = [...hasEntities].filter((entity) => !hadEntities.has(entity))
  const unlabeled = [...hadEntities].filter((entity) => !hasEntities.has(entity))

  const edited = added.length + removed.length + labeled.length + unlabeled.length > 0

  const otherChanges: Array<string> = []
  if (was.title !== now.title) otherChanges.push("the title changed")
  // Entities are compared above as a set, so they are left out here: an entity added or removed is
  // an op, and any other meta changed is not.
  const metasOf = (doc: MemoryDoc): string => JSON.stringify([doc.metas, doc.tags, doc.aliases])
  if (metasOf(was) !== metasOf(now)) otherChanges.push("a meta changed")
  if (collapseMarkup(was.article.html) !== collapseMarkup(now.article.html)) {
    otherChanges.push("the article markup changed")
  }
  if (
    edited &&
    otherChanges.length === 0 &&
    collapseMarkup(withoutHeadOps(after)) !== collapseMarkup(withoutHeadOps(before))
  ) {
    otherChanges.push("the head changed beyond the edited links and entities")
  }
  if (!edited && otherChanges.length === 0) {
    otherChanges.push(
      "the bytes changed with no link added or removed and no entity label added or removed"
    )
  }

  if (otherChanges.length > 0) {
    const notes = [
      ...(added.length === 0 ? [] : [`added link(s) ${added.map(linkKey).join(", ")}`]),
      ...(removed.length === 0 ? [] : [`removed link(s) ${removed.map(linkKey).join(", ")}`]),
      ...(labeled.length === 0 ? [] : [`added entity label(s) ${labeled.join(", ")}`]),
      ...(unlabeled.length === 0 ? [] : [`removed entity label(s) ${unlabeled.join(", ")}`])
    ]
    const editNote = notes.length === 0 ? "" : `${notes.join(" and ")}, but also `
    return { reason: `${HEAD_EDIT_REASON}: ${editNote}${otherChanges.join("; ")}` }
  }
  return {
    ops: [
      ...added.map((link): OverlayOp => ({ kind: "link", path, rel: link.rel, href: link.href })),
      ...removed.map(
        (link): OverlayOp => ({ kind: "unlink", path, rel: link.rel, href: link.href })
      ),
      ...labeled.map((entity): OverlayOp => ({ kind: "label", path, entity })),
      ...unlabeled.map((entity): OverlayOp => ({ kind: "unlabel", path, entity }))
    ]
  }
}

/**
 * Turn the tree a script left behind into overlay ops and rejections.
 *
 * Exported and pure over plain values so the pairing rules are testable without a sandbox. The
 * order of the result is fixed: `put`s sorted by path, then the head ops (`link`s, `unlink`s,
 * `label`s, then `unlabel`s per file) sorted by path, then `archive`s sorted by source path, then `rejected` sorted by path,
 * so two runs over the same tree produce equal reports.
 */
export const harvestOps = (input: {
  readonly seeded: ReadonlyMap<string, Seeded>
  readonly after: ReadonlyArray<GuestFile>
  readonly skippedGitDir: boolean
  readonly scope?: CommitScope | undefined
}): { ops: ReadonlyArray<OverlayOp>; rejected: SessionExecReport["rejected"] } => {
  const scope = input.scope ?? "session"
  const rejected: { path: string; reason: string }[] = []
  const puts = new Map<string, string>()
  const headOps: Array<{ readonly path: string; readonly ops: ReadonlyArray<OverlayOp> }> = []
  const present = new Set<string>()

  for (const file of input.after) {
    present.add(file.path)
    const before = input.seeded.get(file.path)
    // An unchanged seeded file is not a write, so it is skipped before any rule about what may be
    // written. The order matters: the guest is seeded with the whole view, and a session-scope run
    // over a store holding curated records (`areas/arcs/`, `resources/people/`) would otherwise
    // reject every one of them on every run, a no-op included (101 on the 2026-09-27 clone).
    if (before !== undefined && before.html === file.html) continue
    const problem = presentFileProblem(file.path, scope)
    if (problem !== null) {
      rejected.push({ path: file.path, reason: problem })
      continue
    }
    // Same article, different bytes: a head edit. Only added or removed links and entities can be
    // an op.
    if (before !== undefined && contentHashOrNull(file.html) === before.contentHash) {
      const edit = headEdit(file.path, before.html, file.html)
      if (edit !== null) {
        if ("reason" in edit) rejected.push({ path: file.path, reason: edit.reason })
        else headOps.push({ path: file.path, ops: edit.ops })
        continue
      }
    }
    puts.set(file.path, file.html)
  }
  if (input.skippedGitDir) {
    rejected.push({ path: ".git", reason: "git's own storage is not part of the corpus" })
  }

  const archives: Extract<OverlayOp, { kind: "archive" }>[] = []
  for (const [source, before] of input.seeded) {
    if (present.has(source)) continue
    // The twin is a NEW file at `archive/<YYYY>/<source>` for some year. `originalPathFor` strips
    // exactly one `archive/<YYYY>/` prefix, so a candidate names this source iff it maps back to it.
    const twin = [...puts.keys()].find((candidate) => originalPathFor(candidate) === source)
    if (twin === undefined) {
      rejected.push({
        path: source,
        reason: "vanished with no archive twin; deletion is not an operation"
      })
      continue
    }
    const twinHtml = puts.get(twin) ?? ""
    if (contentHashOrNull(twinHtml) !== before.contentHash) {
      rejected.push({
        path: source,
        reason: `vanished, and ${twin} holds a different article, so it is not this file archived`
      })
      continue
    }
    // The same words, so this is the file archived. Its head is held to the stays-put rule: links
    // and entities the copy gained or lost are head ops on the source (staged before the archive,
    // so the commit carries them into the copy); anything else rejects the source and leaves the
    // twin a put.
    const edit = twinHtml === before.html ? null : headEdit(source, before.html, twinHtml)
    if (edit !== null && "reason" in edit) {
      rejected.push({
        path: source,
        reason: `vanished, and ${twin} holds this article under an edited head; ${edit.reason}`
      })
      continue
    }
    puts.delete(twin)
    if (edit !== null && edit.ops.length > 0) headOps.push({ path: source, ops: edit.ops })
    archives.push({ kind: "archive", path: source, to: twin, html: twinHtml })
  }

  const byPath = <T extends { readonly path: string }>(a: T, b: T): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  const putOps: OverlayOp[] = [...puts]
    .map(([path, html]): OverlayOp => ({ kind: "put", path, html }))
    .sort(byPath)
  const headOpsInOrder = headOps.sort(byPath).flatMap((entry) => entry.ops)
  return {
    ops: [...putOps, ...headOpsInOrder, ...archives.sort(byPath)],
    rejected: rejected.sort(byPath)
  }
}

// ---------------------------------------------------------------------------------------------
// The seed image
// ---------------------------------------------------------------------------------------------

/**
 * A corpus version as the bytes the guest is seeded with: one buffer or more, and per file its path
 * and the `[buffer, start, end]` of its UTF-8 bytes in `slots`. It is plain data, so it crosses a
 * `postMessage` to a worker as it is, and a `SharedArrayBuffer` in `buffers` crosses without a copy.
 * The runner seeds each file from a copy of its range and compares what the guest left against the
 * range itself (`guest/sandbox-runner.mjs`), so an image is never written after it is built and one
 * can serve any number of runs.
 */
export interface SeedImage {
  readonly buffers: ReadonlyArray<ArrayBufferLike>
  readonly paths: ReadonlyArray<string>
  readonly slots: Int32Array
}

/**
 * A base version's image, held by a long-lived caller (the head server) so a view over that version
 * reuses its bytes: `index` maps each path to the html the bytes encode and the file's position in
 * the image.
 */
export interface CachedImage {
  readonly sha: string
  readonly image: SeedImage
  readonly index: ReadonlyMap<string, { readonly html: string; readonly at: number }>
  readonly bytes: number
}

/** Pack `texts` as UTF-8 into one buffer, shared or not, answering each text's `[start, end]`. */
const pack = (
  texts: ReadonlyArray<string>,
  shared: boolean
): { readonly buffer: ArrayBufferLike; readonly ranges: Int32Array } => {
  const ranges = new Int32Array(texts.length * 2)
  let total = 0
  for (let index = 0; index < texts.length; index += 1) {
    const length = Buffer.byteLength(texts[index] ?? "", "utf8")
    ranges[index * 2] = total
    total += length
    ranges[index * 2 + 1] = total
  }
  const buffer = shared ? new SharedArrayBuffer(total) : new ArrayBuffer(total)
  const view = new Uint8Array(buffer)
  const encoder = new TextEncoder()
  for (let index = 0; index < texts.length; index += 1) {
    encoder.encodeInto(texts[index] ?? "", view.subarray(ranges[index * 2], ranges[index * 2 + 1]))
  }
  return { buffer, ranges }
}

/** The image of a version with a sha, in shared memory, for a caller that keeps it. */
export const cacheImage = (view: HeadView & { readonly sha: string }): CachedImage => {
  const records = [...view.records()]
  const texts = records.map((record) => record.html)
  const { buffer, ranges } = pack(texts, true)
  const slots = new Int32Array(records.length * 3)
  const index = new Map<string, { html: string; at: number }>()
  for (let at = 0; at < records.length; at += 1) {
    slots[at * 3] = 0
    slots[at * 3 + 1] = ranges[at * 2] ?? 0
    slots[at * 3 + 2] = ranges[at * 2 + 1] ?? 0
    index.set(records[at]?.path ?? "", { html: texts[at] ?? "", at })
  }
  return {
    sha: view.sha,
    image: { buffers: [buffer], paths: records.map((record) => record.path), slots },
    index,
    bytes: buffer.byteLength
  }
}

/**
 * The image of `view` and the seeded set the harvest compares against.
 *
 * With `base`, a record whose html is the very text `base` encoded (compared by value, so an overlay
 * that rewrote a path is never served the base's bytes for it) takes its bytes from `base`, and only
 * the rest are encoded, into one more buffer. Without it every record is encoded. Either way the
 * guest is seeded with exactly the UTF-8 of `view`'s html, path by path.
 */
export const seedFor = (
  view: HeadView,
  base?: CachedImage | undefined
): { readonly image: SeedImage; readonly seeded: ReadonlyMap<string, Seeded> } => {
  const seeded = new Map<string, Seeded>()
  const paths: Array<string> = []
  const reused: Array<number> = []
  const fresh: Array<string> = []
  for (const record of view.records()) {
    seeded.set(record.path, { html: record.html, contentHash: record.contentHash })
    paths.push(record.path)
    const hit = base?.index.get(record.path)
    if (hit !== undefined && hit.html === record.html) {
      reused.push(hit.at)
    } else {
      reused.push(-1)
      fresh.push(record.html)
    }
  }
  const baseBuffers = base?.image.buffers ?? []
  const packed = pack(fresh, false)
  const slots = new Int32Array(paths.length * 3)
  let next = 0
  for (let at = 0; at < paths.length; at += 1) {
    const from = reused[at] ?? -1
    if (from >= 0 && base !== undefined) {
      slots[at * 3] = base.image.slots[from * 3] ?? 0
      slots[at * 3 + 1] = base.image.slots[from * 3 + 1] ?? 0
      slots[at * 3 + 2] = base.image.slots[from * 3 + 2] ?? 0
    } else {
      slots[at * 3] = baseBuffers.length
      slots[at * 3 + 1] = packed.ranges[next * 2] ?? 0
      slots[at * 3 + 2] = packed.ranges[next * 2 + 1] ?? 0
      next += 1
    }
  }
  return { image: { buffers: [...baseBuffers, packed.buffer], paths, slots }, seeded }
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

/** One run of the sandbox, as `guest/sandbox-runner.mjs` takes it. Plain data, for a worker. */
export interface GuestJob {
  readonly image: SeedImage
  readonly mount: string
  readonly lib: string
  /** Where a `js` script is written before `js-exec` runs it; `null` for `bash`. */
  readonly scriptPath: string | null
  readonly script: string
  /** The shell program: the script itself for `bash`, `js-exec <scriptPath>` for `js`. */
  readonly command: string
  readonly bootstrap: string
  readonly executionLimits: Readonly<Record<string, number>>
  readonly helperSource: string
  readonly parserSource: string
}

/** What one run answers: the script's result, and the files it left different from the seed. */
export interface GuestRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  /** Every file whose bytes differ from its seed, and every new file, repo-relative. */
  readonly changed: ReadonlyArray<GuestFile>
  /** Every seeded path that is no longer a regular file. */
  readonly vanished: ReadonlyArray<string>
  readonly skippedGitDir: boolean
}

/**
 * How a run is carried out: in this process ({@link inProcessRunner}) or in a worker the caller
 * owns (`exec-pool.ts`). `deadlineMs` is the wall clock the whole run, seeding and walk included,
 * may take before a runner that can stop it does; the in-process runner cannot, and relies on
 * just-bash's own bound.
 */
export type SandboxRunner = (
  job: GuestJob,
  bounds: { readonly deadlineMs: number }
) => Effect.Effect<GuestRun, StorageFailure>

interface RunnerModule {
  readonly runGuest: (job: GuestJob) => Promise<GuestRun>
}

/** The runner module, imported once per process by URL (it is a file on disk, not a module in `src/`). */
let runnerModule: Promise<RunnerModule> | null = null
const loadRunner = (): Promise<RunnerModule> => {
  runnerModule ??= import(pathToFileURL(sandboxRunnerPath()).href) as Promise<RunnerModule>
  return runnerModule
}

/** Run the job on this thread. A command just-bash cannot interrupt holds the thread until it ends. */
export const inProcessRunner: SandboxRunner = (job) =>
  Effect.tryPromise({
    try: async () => (await loadRunner()).runGuest(job),
    catch: (cause) => StorageFailure.make({ operation: `session-exec.run: ${String(cause)}` })
  })

/**
 * How much longer than its script's bound a run may take before a runner that can stop it does: the
 * seeding, the walk, and the parse before the script starts, measured at under 200 ms on the
 * 7,437-record clone, with room for a loaded host.
 */
export const RUN_DEADLINE_GRACE_MS = 5_000

/** The bound a script runs under: `--timeout-ms`, else the default, never past the cap. */
export const effectiveTimeoutMs = (timeoutMs: number | undefined): number =>
  Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

/**
 * The execution limits a script runs under. `js`: exec.ts's two bounds, the shell's looser by the
 * grace so the JS bound reports (see `runExec`). `bash`: the script IS the shell program, so the
 * shell's deadline is the bound and it is `timeoutMs` exactly, with no grace: a bash loop told 5 s is
 * cut off at 5 s. The JS bound is the same number, so a `js-exec` inside a bash script is bounded as
 * well; which of the two fires reads `bash: js-exec exceeded its execution deadline`, and both
 * wordings are ones `cutOffByTheRuntime` knows. The counts are raised for `bash` alone
 * ({@link BASH_COUNT_LIMIT}).
 */
const executionLimitsFor = (lang: ExecLang, timeoutMs: number): Record<string, number> =>
  lang === "js"
    ? { maxJsTimeoutMs: timeoutMs, maxExecutionTimeMs: timeoutMs + SHELL_TIMEOUT_GRACE_MS }
    : {
        maxJsTimeoutMs: timeoutMs,
        maxExecutionTimeMs: timeoutMs,
        maxCommandCount: BASH_COUNT_LIMIT,
        maxLoopIterations: BASH_COUNT_LIMIT
      }

/** The wall clock a runner that can stop a run gives it: the shell's own bound plus the grace. */
export const runDeadlineMs = (lang: ExecLang, timeoutMs: number): number =>
  (executionLimitsFor(lang, timeoutMs).maxExecutionTimeMs ?? timeoutMs) + RUN_DEADLINE_GRACE_MS

/**
 * Path order as a recursive walk with sorted directory listings visits it: segment by segment, so
 * `a/x` comes before `a-b/x` although `-` sorts before `/`. The harvest pairs a vanished file with
 * the first archive twin in this order, so the runner's one-pass listing is put back in it.
 */
const walkOrder = (left: GuestFile, right: GuestFile): number => {
  const a = left.path.split("/")
  const b = right.path.split("/")
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index] ?? ""
    const y = b[index] ?? ""
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length - b.length
}

/**
 * Everything `runSessionExec` needs beyond {@link SessionExecInput}: how to run the job, and a base
 * image to reuse bytes from. Both are the head server's: the CLI and the curator run in process and
 * encode the view per call.
 */
export interface SessionExecRuntime {
  readonly runner?: SandboxRunner | undefined
  readonly baseImage?: CachedImage | undefined
}

/**
 * Run one script over a corpus version seeded from memory, and harvest what it wrote.
 *
 * The guest sees the whole `view` under {@link CORPUS_MOUNT}, archived records included, because
 * that is the tree a commit of the session would be built on. Each attempt seeds a fresh
 * `InMemoryFs` from the same image, so the bridge-fault retry ({@link withBridgeRetry}) starts from
 * a tree the previous attempt never touched; a partial write from a faulted attempt cannot leak
 * into the harvest, which is what makes re-running a writable sandbox sound here.
 *
 * The runner answers only the files that differ from the seed; the harvest sees every other seeded
 * file as present and unchanged, which is what it would have read from the tree, so `harvestOps`
 * gets the same input a full walk gave it.
 */
export const runSessionExec = (
  input: SessionExecInput & SessionExecRuntime
): Effect.Effect<SessionExecReport, StorageFailure> =>
  Effect.gen(function* () {
    const timeoutMs = effectiveTimeoutMs(input.timeoutMs)
    const runner = input.runner ?? inProcessRunner
    const helperSource = yield* Effect.tryPromise({
      try: () => readFile(guestHelperPath(), "utf8"),
      catch: (cause) =>
        StorageFailure.make({ operation: `session-exec.guest-helper: ${String(cause)}` })
    })
    const parserSource = yield* Effect.tryPromise({
      try: () => readFile(parserSourcePath(), "utf8"),
      catch: (cause) =>
        StorageFailure.make({ operation: `session-exec.guest-parser: ${String(cause)}` })
    })
    const { image, seeded } = seedFor(input.view, input.baseImage)
    const job: GuestJob = {
      image,
      mount: CORPUS_MOUNT,
      lib: GUEST_LIB,
      scriptPath: input.lang === "js" ? GUEST_SCRIPT : null,
      script: input.script,
      // A bash script is handed to the interpreter as its source text, not through `bash -c`, so no
      // outer shell quotes it: the bytes the agent's heredoc delivered are the program.
      command: input.lang === "js" ? `js-exec ${GUEST_SCRIPT}` : input.script,
      bootstrap: ATOB_BOOTSTRAP,
      executionLimits: executionLimitsFor(input.lang, timeoutMs),
      helperSource,
      parserSource
    }
    const deadlineMs = runDeadlineMs(input.lang, timeoutMs)

    // The run of the attempt that produced the returned report, read once the retry loop settles.
    const answer: { run: GuestRun | null } = { run: null }
    const attempt = (): Effect.Effect<ExecReport, StorageFailure> =>
      runner(job, { deadlineMs }).pipe(
        Effect.map((run): ExecReport => {
          answer.run = run
          return {
            corpusMount: CORPUS_MOUNT,
            sha: input.view.sha,
            exitCode: run.exitCode,
            stdout: run.stdout,
            stderr: run.stderr,
            durationMs: run.durationMs,
            timeoutMs,
            timedOut: cutOffByTheRuntime(run.exitCode, run.stderr)
          }
        })
      )
    const report = yield* withBridgeRetry(attempt)
    const run = answer.run
    if (run === null) {
      return yield* Effect.fail(
        StorageFailure.make({
          operation: "session-exec.harvest: no attempt left a tree to harvest"
        })
      )
    }
    const changedPaths = new Set(run.changed.map((file) => file.path))
    const vanished = new Set(run.vanished)
    const after: Array<GuestFile> = []
    for (const [path, seed] of seeded) {
      if (!vanished.has(path) && !changedPaths.has(path)) after.push({ path, html: seed.html })
    }
    after.push(...[...run.changed].sort(walkOrder))
    const harvested = harvestOps({
      seeded,
      after,
      skippedGitDir: run.skippedGitDir,
      scope: input.scope
    })
    return { ...report, lang: input.lang, ops: harvested.ops, rejected: harvested.rejected }
  })
