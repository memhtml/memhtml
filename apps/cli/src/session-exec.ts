import { readFile } from "node:fs/promises"

import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { StorageFailure } from "@memhtml/contracts/errors"
import { memoryPathViolation, originalPathFor } from "@memhtml/contracts/paths"
import { contentHash, LINK_REL_PREFIX, type MemoryDoc, parseMemory } from "@memhtml/html"
import { type CommitScope, isReservedPath } from "@memhtml/session"
import { Effect, Result } from "effect"
import type { InMemoryFs as InMemoryFsShape } from "just-bash"

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
  withBridgeRetry
} from "./exec.js"

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
 *   one `link` op, and every one present before and absent after becomes one `unlink` op, because
 *   placing or dropping an edge are the two head edits the store's operations can express. A title
 *   or meta changed, article markup changed, or any other head content changed is `rejected`
 *   ("head edit other than adding or removing links is not an operation"), and when links were
 *   added or removed beside such a change the reason names both, so the script's author can split
 *   the edit into edge ops and a new file plus an archive. Nothing a script changed goes
 *   unreported: an edit is an op or it is a rejection.
 * - A seeded file that is gone, paired with a new `archive/<YYYY>/<its path>` file whose article
 *   content hash equals the seeded record's, is one `archive` op. Deletion is not an operation in
 *   this store (nothing is ever deleted; eviction is a move), so the pair is the only shape a
 *   vanished file can legitimately take. The twin's head is held to the same rule as a file that
 *   stays put: links added to or removed from the copy become `link` and `unlink` ops on the SOURCE
 *   path, emitted before the archive so the commit's staging carries the edit into the archived
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
 * shape, the `atob` bootstrap, the guest paths, and the two host paths (the guest helper and the
 * parser bundle) are all imported from `./exec.ts`. Nothing about the sandbox is restated here, so
 * the two runtimes cannot drift on how a guest is built, and this module resolves no path from its
 * own module location: the packaging census (`tests-integration/tests/packaging.test.ts`) names
 * `exec.ts` as the one place `guest/corpus.mjs` and `node-html-parser` are resolved.
 * `./mount.ts`'s `mountReadOnlyRoots` is not used because its one job is to put
 * a HOST directory into the guest read-only, and this runtime has neither a host directory nor a
 * read-only mount.
 */

/** What `session exec` reports: the script's run plus what the harvester made of the tree it left. */
export interface SessionExecReport extends ExecReport {
  /**
   * Overlay ops harvested from the guest tree: `put`s, then the edge ops (`link`s, then `unlink`s,
   * per file), then `archive`s, each group sorted by path (a file's links in document order).
   */
  readonly ops: ReadonlyArray<OverlayOp>
  /** Files the harvester could not turn into an op, each with the reason, sorted by path. */
  readonly rejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

/**
 * Everything `session exec` needs: a version to see, a script to run, an optional bound, and the
 * writer's scope (`session` unless a curator run says `curate`, which opens the arcs and people
 * prefixes the way `validateOps` does under the same scope).
 */
export interface SessionExecInput {
  readonly view: HeadView
  readonly script: string
  readonly timeoutMs?: number | undefined
  readonly scope?: CommitScope | undefined
}

/** The stated reason a head edit that is not purely added or removed links is refused. */
export const HEAD_EDIT_REASON = "head edit other than adding or removing links is not an operation"

/** One file the walk found in the guest tree after the run. */
interface GuestFile {
  /** Repo-relative, no leading slash. */
  readonly path: string
  readonly html: string
}

/** The seeded set, keyed by repo-relative path, carrying what the harvester compares against. */
interface Seeded {
  readonly html: string
  readonly contentHash: string
}

/**
 * Walk the corpus filesystem and return every regular file, `.git` excluded at the top.
 *
 * `.git` is skipped rather than rejected file by file for the reason `apps/cli/guest/corpus.mjs`
 * gives: a ref is a file at a name its author chose, and a walk that descends there spends most
 * of its calls on entries no op can carry. The skip is at the directory, so one `rejected` entry
 * names the directory instead of one per ref. Paths come back repo-relative with no leading slash,
 * which is the `MemoryRecord.path` convention.
 */
const walkGuestTree = async (
  filesystem: InMemoryFsShape
): Promise<{ files: GuestFile[]; skippedGitDir: boolean }> => {
  const files: GuestFile[] = []
  let skippedGitDir = false
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await filesystem.readdirWithFileTypes(dir)) {
      const full = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`
      if (full === "/.git") {
        skippedGitDir = true
        continue
      }
      if (entry.isDirectory) {
        await visit(full)
      } else if (entry.isFile) {
        files.push({ path: full.slice(1), html: await filesystem.readFile(full, "utf8") })
      }
    }
  }
  await visit("/")
  return { files, skippedGitDir }
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

/** The document with its memhtml links taken out, so two heads compare on everything else. */
const withoutMemhtmlLinks = (html: string): string => html.replace(MEMHTML_LINK_ELEMENT, "")

/**
 * What a head edit amounts to: the `link` ops for every edge added and the `unlink` ops for every
 * edge removed, or the reason it cannot be an op. Called only for a seeded file whose bytes changed
 * and whose article content hash did not. That hash is a digest of the article's canonical TEXT
 * (`@memhtml/html` `canonicalText`), so an equal hash proves the words are the same and nothing
 * more: the article's markup, the head, or only whitespace may differ, and this function tells
 * those apart. `null` when either version does not parse, in which case the caller falls back to a
 * `put` and `validateOps` reports the format violation.
 *
 * Three named differences reject the edit (title, meta, article markup); a fourth, "the head
 * changed beyond the edited links", catches head content the parser accepts and `MemoryDoc` does
 * not surface (a comment, a `<meta>` outside the vocabulary): with every memhtml link taken out of
 * both versions, what remains must collapse to the same bytes. It runs only when links were added
 * or removed, so the fallthrough alone names a byte change that edited no link, and no edit leaves
 * here unnamed.
 */
const headEdit = (
  path: string,
  before: string,
  after: string
): { readonly links: ReadonlyArray<OverlayOp> } | { readonly reason: string } | null => {
  const was = parsedOrNull(before)
  const now = parsedOrNull(after)
  if (was === null || now === null) return null

  const hadLinks = new Set(was.links.map(linkKey))
  const hasLinks = new Set(now.links.map(linkKey))
  const added = now.links.filter((link) => !hadLinks.has(linkKey(link)))
  const removed = was.links.filter((link) => !hasLinks.has(linkKey(link)))

  const edited = added.length + removed.length > 0

  const otherChanges: Array<string> = []
  if (was.title !== now.title) otherChanges.push("the title changed")
  const metasOf = (doc: MemoryDoc): string =>
    JSON.stringify([doc.metas, doc.entities, doc.tags, doc.aliases])
  if (metasOf(was) !== metasOf(now)) otherChanges.push("a meta changed")
  if (collapseMarkup(was.article.html) !== collapseMarkup(now.article.html)) {
    otherChanges.push("the article markup changed")
  }
  if (
    edited &&
    otherChanges.length === 0 &&
    collapseMarkup(withoutMemhtmlLinks(after)) !== collapseMarkup(withoutMemhtmlLinks(before))
  ) {
    otherChanges.push("the head changed beyond the edited links")
  }
  if (!edited && otherChanges.length === 0) {
    otherChanges.push("the bytes changed with no link added or removed")
  }

  if (otherChanges.length > 0) {
    const notes = [
      ...(added.length === 0 ? [] : [`added link(s) ${added.map(linkKey).join(", ")}`]),
      ...(removed.length === 0 ? [] : [`removed link(s) ${removed.map(linkKey).join(", ")}`])
    ]
    const editNote = notes.length === 0 ? "" : `${notes.join(" and ")}, but also `
    return { reason: `${HEAD_EDIT_REASON}: ${editNote}${otherChanges.join("; ")}` }
  }
  return {
    links: [
      ...added.map((link): OverlayOp => ({ kind: "link", path, rel: link.rel, href: link.href })),
      ...removed.map(
        (link): OverlayOp => ({ kind: "unlink", path, rel: link.rel, href: link.href })
      )
    ]
  }
}

/**
 * Turn the tree a script left behind into overlay ops and rejections.
 *
 * Exported and pure over plain values so the pairing rules are testable without a sandbox. The
 * order of the result is fixed: `put`s sorted by path, then the edge ops (`link`s then `unlink`s
 * per file) sorted by path, then `archive`s sorted by source path, then `rejected` sorted by path,
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
  const links: Array<{ readonly path: string; readonly ops: ReadonlyArray<OverlayOp> }> = []
  const present = new Set<string>()

  for (const file of input.after) {
    present.add(file.path)
    const problem = presentFileProblem(file.path, scope)
    if (problem !== null) {
      rejected.push({ path: file.path, reason: problem })
      continue
    }
    const before = input.seeded.get(file.path)
    if (before !== undefined && before.html === file.html) continue
    // Same article, different bytes: a head edit. Only added or removed links can be an op.
    if (before !== undefined && contentHashOrNull(file.html) === before.contentHash) {
      const edit = headEdit(file.path, before.html, file.html)
      if (edit !== null) {
        if ("reason" in edit) rejected.push({ path: file.path, reason: edit.reason })
        else links.push({ path: file.path, ops: edit.links })
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
    // the copy gained or lost are `link` and `unlink` ops on the source (staged before the archive,
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
    if (edit !== null && edit.links.length > 0) links.push({ path: source, ops: edit.links })
    archives.push({ kind: "archive", path: source, to: twin, html: twinHtml })
  }

  const byPath = <T extends { readonly path: string }>(a: T, b: T): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  const putOps: OverlayOp[] = [...puts]
    .map(([path, html]): OverlayOp => ({ kind: "put", path, html }))
    .sort(byPath)
  const linkOps = links.sort(byPath).flatMap((entry) => entry.ops)
  return {
    ops: [...putOps, ...linkOps, ...archives.sort(byPath)],
    rejected: rejected.sort(byPath)
  }
}

/**
 * Run one script over a corpus version seeded from memory, and harvest what it wrote.
 *
 * The guest sees the whole `view` under {@link CORPUS_MOUNT}, archived records included, because
 * that is the tree a commit of the session would be built on. Each attempt builds a fresh
 * `InMemoryFs` from the same records, so the bridge-fault retry ({@link withBridgeRetry}) starts
 * from a tree the previous attempt never touched; a partial write from a faulted attempt cannot
 * leak into the harvest, which is what makes re-running a writable sandbox sound here.
 *
 * `new Bash()` takes no `network` or `fetch` option, for the reason `exec.ts` records: that
 * omission is the mechanism that leaves the guest without a network client.
 */
export const runSessionExec = (
  input: SessionExecInput
): Effect.Effect<SessionExecReport, StorageFailure> =>
  Effect.gen(function* () {
    const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

    // Dynamic for the same measured reason as exec.ts: just-bash is ~6 MB across 20 chunks, and a
    // static edge here would put it on the graph of every command.
    const { Bash, InMemoryFs, MountableFs } = yield* Effect.tryPromise({
      try: () => import("just-bash"),
      catch: (cause) =>
        StorageFailure.make({ operation: `session-exec.sandbox-load: ${String(cause)}` })
    })
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

    const seeded = new Map<string, Seeded>()
    for (const record of input.view.records()) {
      seeded.set(record.path, { html: record.html, contentHash: record.contentHash })
    }

    // The corpus filesystem of the attempt that produced the returned report. Set inside each
    // attempt, read once after the retry loop settles on a report that is the script's own.
    const answer: { corpus: InMemoryFsShape | null } = { corpus: null }

    const attempt = (): Effect.Effect<ExecReport, StorageFailure> =>
      Effect.gen(function* () {
        const corpus = new InMemoryFs()
        yield* Effect.try({
          try: () => {
            for (const [path, file] of seeded) corpus.writeFileSync(`/${path}`, file.html)
          },
          catch: (cause) =>
            StorageFailure.make({ operation: `session-exec.seed: ${String(cause)}` })
        })
        const filesystem = new MountableFs({ base: new InMemoryFs() })
        filesystem.mount(CORPUS_MOUNT, corpus)

        const bash = new Bash({
          fs: filesystem,
          javascript: { bootstrap: ATOB_BOOTSTRAP },
          executionLimits: {
            maxJsTimeoutMs: timeoutMs,
            maxExecutionTimeMs: timeoutMs + SHELL_TIMEOUT_GRACE_MS
          }
        })

        yield* Effect.tryPromise({
          try: async () => {
            await filesystem.mkdir(GUEST_LIB, { recursive: true })
            await filesystem.writeFile(`${GUEST_LIB}/nhp.mjs`, parserSource)
            await filesystem.writeFile(`${GUEST_LIB}/corpus.mjs`, helperSource)
            await filesystem.writeFile(GUEST_SCRIPT, input.script)
          },
          catch: (cause) =>
            StorageFailure.make({ operation: `session-exec.seed: ${String(cause)}` })
        })

        const started = Date.now()
        const result = yield* Effect.tryPromise({
          try: () => bash.exec(`js-exec ${GUEST_SCRIPT}`),
          catch: (cause) => StorageFailure.make({ operation: `session-exec.run: ${String(cause)}` })
        })
        const durationMs = Date.now() - started
        answer.corpus = corpus

        const stderr = String(result.stderr ?? "")
        return {
          corpusMount: CORPUS_MOUNT,
          sha: input.view.sha,
          exitCode: result.exitCode,
          stdout: String(result.stdout ?? ""),
          stderr,
          durationMs,
          timeoutMs,
          timedOut: cutOffByTheRuntime(result.exitCode, stderr)
        }
      })

    const report = yield* withBridgeRetry(attempt)
    const corpus = answer.corpus
    if (corpus === null) {
      return yield* Effect.fail(
        StorageFailure.make({
          operation: "session-exec.harvest: no attempt left a tree to harvest"
        })
      )
    }
    const { files, skippedGitDir } = yield* Effect.tryPromise({
      try: () => walkGuestTree(corpus),
      catch: (cause) => StorageFailure.make({ operation: `session-exec.harvest: ${String(cause)}` })
    })
    const harvested = harvestOps({ seeded, after: files, skippedGitDir, scope: input.scope })
    return { ...report, ops: harvested.ops, rejected: harvested.rejected }
  })
