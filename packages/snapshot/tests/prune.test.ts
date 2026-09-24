import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { afterAll, describe, expect, it } from "vitest"

import {
  listSnapshots,
  pruneSnapshots,
  SNAPSHOTS_DIR,
  SNAPSHOTS_KEPT,
  snapshotPathFor
} from "../src/index.js"

/**
 * The snapshot directory as a set (`prune.ts`).
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `pruneSnapshots`: `entries.slice(keep + 1)` -> "keeps the newest four by mtime and reports the
 *   rest, newest first" (five files survive).
 * - `listSnapshots`: drop the `SNAPSHOT_FILE` match (list every name) -> "lists only <sha>.arrow
 *   files, newest first" (the staging file and the stray are listed).
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-snapshot-prune-"))
  roots.push(root)
  return root
}

const shaOf = (index: number): string => index.toString(16).padStart(40, "0")

/** `count` snapshot files whose mtimes step one second apart, index 0 the oldest. */
const seed = async (root: string, count: number): Promise<ReadonlyArray<string>> => {
  await mkdir(join(root, SNAPSHOTS_DIR), { recursive: true })
  const shas: Array<string> = []
  const base = Math.floor(Date.now() / 1000) - count - 10
  for (let index = 0; index < count; index += 1) {
    const sha = shaOf(index)
    const path = snapshotPathFor(root, sha)
    await writeFile(path, "arrow bytes", "utf8")
    await utimes(path, base + index, base + index)
    shas.push(sha)
  }
  return shas
}

describe("listSnapshots", () => {
  it("is empty for a root with no snapshot directory", async () => {
    expect(await run(listSnapshots(await scratch()))).toEqual([])
  })

  it("lists only <sha>.arrow files, newest first", async () => {
    const root = await scratch()
    const shas = await seed(root, 3)
    await writeFile(join(root, SNAPSHOTS_DIR, `${shaOf(9)}.arrow.tmp`), "staging", "utf8")
    await writeFile(join(root, SNAPSHOTS_DIR, "notes.txt"), "stray", "utf8")
    const listed = await run(listSnapshots(root))
    expect(listed.map((entry) => entry.sha)).toEqual([...shas].reverse())
    expect(listed.every((entry) => entry.path === snapshotPathFor(root, entry.sha))).toBe(true)
    expect(listed[0]?.mtimeMs).toBeGreaterThan(listed[2]?.mtimeMs ?? Number.POSITIVE_INFINITY)
  })
})

describe("pruneSnapshots", () => {
  it(`keeps the newest ${SNAPSHOTS_KEPT} by mtime and reports the rest, newest first`, async () => {
    const root = await scratch()
    const shas = await seed(root, 7)
    const pruned = await run(pruneSnapshots(root))
    expect(pruned).toEqual([shaOf(2), shaOf(1), shaOf(0)])
    const left = (await readdir(join(root, SNAPSHOTS_DIR))).sort()
    expect(left).toEqual(shas.slice(3).map((sha) => `${sha}.arrow`))
    // A second prune over a directory already at the bound removes nothing.
    expect(await run(pruneSnapshots(root))).toEqual([])
  })

  it("takes an explicit keep, zero included", async () => {
    const root = await scratch()
    await seed(root, 3)
    expect(await run(pruneSnapshots(root, { keep: 1 }))).toEqual([shaOf(1), shaOf(0)])
    expect(await run(pruneSnapshots(root, { keep: 0 }))).toEqual([shaOf(2)])
    expect(await readdir(join(root, SNAPSHOTS_DIR))).toEqual([])
  })

  it("is a no-op without a snapshot directory", async () => {
    expect(await run(pruneSnapshots(await scratch()))).toEqual([])
  })
})
