import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { isArchivePath } from "@memhtml/contracts"
import { frameKeyOf } from "@memhtml/domain"
import { contentHash, parseMemory, renderTemplate } from "@memhtml/html"
import { Effect } from "effect"

import { GIT_REPO_SELECTION_ENV } from "../src/plumbing.js"

/**
 * Test doubles and fixture helpers. `@memhtml/head` is written concurrently and may not be imported,
 * so the record parser and the `HeadView` over a `Map` live here.
 */

const execFileP = promisify(execFile)

/** Run git in a repo and return trimmed stdout. Scrubs the same repo-selecting variables the code does. */
export const git = async (
  root: string,
  args: ReadonlyArray<string>,
  input?: string
): Promise<string> => {
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: "C" }
  for (const name of GIT_REPO_SELECTION_ENV) delete env[name]
  const child = execFileP("git", ["-C", root, ...args], { env, encoding: "utf8" })
  if (child.child.stdin !== null) {
    child.child.stdin.on("error", () => {})
    child.child.stdin.end(input ?? "")
  }
  const { stdout } = await child
  return stdout.trim()
}

export interface Repo {
  readonly root: string
  readonly cleanup: () => Promise<void>
}

/** A temp repo on `main` with a local identity and `.memhtml/` gitignored. */
export const makeRepo = async (): Promise<Repo> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-session-"))
  await git(root, ["init", "-q", "-b", "main", "."])
  await git(root, ["config", "user.name", "memhtml test"])
  await git(root, ["config", "user.email", "test@memhtml.invalid"])
  await writeFile(join(root, ".gitignore"), ".memhtml/\n", "utf8")
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Write files into the working tree and commit them through porcelain; the new HEAD sha. */
export const commitFiles = async (
  root: string,
  files: Readonly<Record<string, string>>,
  message = "fixture"
): Promise<string> => {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents, "utf8")
  }
  await git(root, ["add", "-A"])
  await git(root, ["commit", "-q", "-m", message])
  return git(root, ["rev-parse", "HEAD"])
}

/** A valid memory file from a title and a claim. */
export const memory = (
  title: string,
  claim: string,
  extra: { readonly body?: ReadonlyArray<string>; readonly at?: string } = {}
): string =>
  renderTemplate({
    title,
    claim,
    body: extra.body,
    memoryType: "semantic",
    at: extra.at ?? "2026-09-23T12:00:00Z"
  })

/** sha1("blob <byteLength>\0" + bytes), which must equal `git hash-object`. */
export const blobShaOf = (html: string): string => {
  const bytes = Buffer.from(html, "utf8")
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
}

/** The record a file becomes, the way the head builds one. */
export const recordFrom = async (path: string, html: string): Promise<MemoryRecord> => {
  const doc = await Effect.runPromise(parseMemory(html))
  return {
    path,
    blobSha: blobShaOf(html),
    contentHash: contentHash(html),
    frameKey: frameKeyOf(doc.article.gist),
    title: doc.title,
    memoryType: doc.metas.memoryType,
    status: doc.metas.status,
    claim: doc.article.gist,
    createdAt: doc.metas.createdAt,
    updatedAt: doc.metas.updatedAt,
    eventAt: doc.article.eventAt ?? null,
    confidence: doc.metas.confidence ?? null,
    importance: doc.metas.importance ?? null,
    tags: doc.tags,
    entities: doc.entities,
    links: doc.links,
    facets: doc.article.facets.map((facet) => ({ name: facet.name, value: facet.value })),
    bodyText: doc.article.bodyText,
    html,
    archived: isArchivePath(path)
  }
}

export interface MapHead extends HeadView {
  readonly sha: string
  /** Called on every `byFrameKey`, so a test can act between step 2 and step 5 of a commit. */
  onByFrameKey?: (key: string) => void
}

/** A `HeadView` over a plain `Map`, indexes computed eagerly. */
export const mapHead = (sha: string, records: Iterable<MemoryRecord>): MapHead => {
  const byPath = new Map<string, MemoryRecord>()
  for (const record of records) byPath.set(record.path, record)
  const active = [...byPath.values()].filter((record) => !record.archived)
  const hashes = new Map(active.map((record) => [record.contentHash, record.path] as const))
  const frames = new Map<string, Array<string>>()
  const inbound = new Map<string, Array<string>>()
  const entities = new Map<string, Array<string>>()
  const push = (map: Map<string, Array<string>>, key: string, path: string): void => {
    const list = map.get(key)
    if (list === undefined) map.set(key, [path])
    else list.push(path)
  }
  for (const record of active) {
    if (record.frameKey !== null) push(frames, record.frameKey, record.path)
  }
  for (const record of byPath.values()) {
    for (const link of record.links) push(inbound, link.href, record.path)
    for (const entity of record.entities) push(entities, entity, record.path)
  }
  const head: MapHead = {
    sha,
    size: byPath.size,
    get: (path) => byPath.get(path),
    paths: () => byPath.keys(),
    records: () => byPath.values(),
    byContentHash: (hash) => hashes.get(hash),
    byFrameKey: (key) => {
      head.onByFrameKey?.(key)
      return frames.get(key) ?? []
    },
    inbound: (href) => inbound.get(href) ?? [],
    byEntity: (entity) => entities.get(entity) ?? []
  }
  return head
}

/** Load a head view from a commit by reading every `.html` blob in its tree. */
export const loadHead = async (root: string, ref = "main"): Promise<MapHead> => {
  const sha = await git(root, ["rev-parse", `${ref}^{commit}`])
  const listing = await git(root, ["ls-tree", "-r", "-z", "--name-only", sha])
  const paths = listing.split("\0").filter((path) => path.endsWith(".html"))
  const records: Array<MemoryRecord> = []
  for (const path of paths) {
    const html = await execFileP("git", ["-C", root, "show", `${sha}:${path}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    })
    records.push(await recordFrom(path, html.stdout))
  }
  return mapHead(sha, records)
}

/** Paths in a commit's tree, sorted. */
export const treePaths = async (root: string, ref: string): Promise<ReadonlyArray<string>> =>
  (await git(root, ["ls-tree", "-r", "-z", "--name-only", ref]))
    .split("\0")
    .filter((path) => path !== "")
    .sort()

/** One file's bytes at a commit. */
export const fileAt = async (root: string, ref: string, path: string): Promise<string> => {
  const { stdout } = await execFileP("git", ["-C", root, "show", `${ref}:${path}`], {
    encoding: "utf8"
  })
  return stdout
}
