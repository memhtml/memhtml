import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { type NewMemoryInput, renderTemplate } from "@memhtml/html"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Result } from "effect"

import { recordFrom } from "../src/index.js"

/**
 * Fixture plumbing shared by the head tests: a generated corpus in a real temp git repo, a commit
 * helper that writes or deletes files and commits them, and a `Map`-backed `HeadView` so the
 * fallback path in `indexesOf` is exercised by a view this package did not build.
 */

export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

export const runErr = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error("expected a failure, got a value")
  return result.failure
}

/** One generated memory: deterministic in `index`, varied across path, type, entity, and time. */
export const memoryFor = (index: number): { readonly path: string; readonly html: string } => {
  const bucket =
    index % 10 === 9
      ? "archive/2025/areas/inbox"
      : index % 3 === 0
        ? "projects/alpha"
        : "areas/inbox"
  const path = `${bucket}/fact-${index}.html`
  const month = String((index % 12) + 1).padStart(2, "0")
  const day = String((index % 27) + 1).padStart(2, "0")
  const at = `2026-${month}-${day}T12:00:00Z`
  const claim = `The capital of Country${index} is City${index}.`
  const body = `Region ${index % 5} grows crop${index % 7} and trades through port${index % 11}.`
  const input: NewMemoryInput = {
    title: `Fact ${index} about Country${index}`,
    claim,
    memoryType: index % 4 === 0 ? "episodic" : "semantic",
    at,
    entities: [`place:country${index}`, `topic:crop${index % 7}`],
    tags: [`region-${index % 5}`],
    ...(index > 0 ? { links: [{ rel: "relates_to", href: `/${memoryPathFor(index - 1)}` }] } : {}),
    ...(index % 4 === 0
      ? {
          articleHtml: `<p><mark>${claim}</mark> ${body} Recorded <time datetime="2025-${month}-${day}">that day</time>.</p>`
        }
      : { body: [body] })
  }
  return { path, html: renderTemplate(input) }
}

const memoryPathFor = (index: number): string => memoryFor(index).path

/** A file the parser refuses: no `<article>`, no metas. */
export const BROKEN_HTML =
  "<!doctype html>\n<html><head><title>x</title></head><body><p>no article</p></body></html>\n"

export interface Change {
  readonly path: string
  /** `null` deletes the file. */
  readonly html: string | null
}

/** Write or delete each change under the repo root, stage everything, commit, and return the sha. */
export const commitChanges = async (
  repo: FixtureRepo,
  changes: ReadonlyArray<Change>,
  message = "fixture"
): Promise<string> => {
  for (const change of changes) {
    const target = join(repo.root, change.path)
    if (change.html === null) {
      await rm(target, { force: true })
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, change.html, "utf8")
    }
  }
  await run(repo.git.run(["add", "-A"]))
  await run(repo.git.run(["commit", "-q", "--allow-empty", "-m", message]))
  const sha = await run(repo.git.revParseHead())
  if (sha === null) throw new Error("commit produced no HEAD")
  return sha
}

export interface Corpus {
  readonly repo: FixtureRepo
  readonly sha: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly html: string }>
}

/** A fixture repo holding `count` generated memories in one commit on top of the scaffold. */
export const makeCorpus = async (
  count: number,
  extra: ReadonlyArray<Change> = []
): Promise<Corpus> => {
  const repo = await run(makeFixtureRepo())
  const files = Array.from({ length: count }, (_, index) => memoryFor(index))
  const sha = await commitChanges(repo, [...files, ...extra], `corpus of ${count}`)
  return { repo, sha, files }
}

/** Every path in a commit's tree, read independently of the head's own `lsTreeR` call. */
export const treePaths = async (repo: FixtureRepo, sha: string): Promise<ReadonlyArray<string>> =>
  (await run(repo.git.run(["ls-tree", "-r", "--name-only", "-z", sha])))
    .split("\0")
    .filter((path) => path !== "")

/** The blob sha of a path at a commit, or `null` when the tree lacks it. */
export const blobAt = async (
  repo: FixtureRepo,
  sha: string,
  path: string
): Promise<string | null> => {
  const rows = await run(repo.git.lsTreeR(sha, [path]))
  const row = rows.find((entry) => entry.path === path)
  return row === undefined ? null : row.sha
}

/** A record from generated input, for tests that need no repo. */
export const recordOf = (input: {
  readonly path: string
  readonly html: string
}): Promise<MemoryRecord> => run(recordFrom(input))

/** A `HeadView` over a plain `Map`, the shape a test or a foreign package would supply. */
export const mapView = (records: Iterable<MemoryRecord>, sha: string | null = null): HeadView => {
  const map = new Map<string, MemoryRecord>()
  for (const record of records) map.set(record.path, record)
  const active = [...map.values()].filter((record) => !record.archived)
  return {
    sha,
    size: map.size,
    get: (path) => map.get(path),
    paths: () => map.keys(),
    records: () => map.values(),
    byContentHash: (hash) => active.find((record) => record.contentHash === hash)?.path,
    byFrameKey: (key) =>
      active.filter((record) => record.frameKey === key).map((record) => record.path),
    inbound: (href) =>
      [...map.values()]
        .filter((record) => record.links.some((link) => link.href === href))
        .map((record) => record.path),
    byEntity: (entity) =>
      [...map.values()]
        .filter((record) => record.entities.includes(entity))
        .map((record) => record.path)
  }
}
