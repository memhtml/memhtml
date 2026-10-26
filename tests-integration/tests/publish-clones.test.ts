import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeGit } from "@memhtml/store"
import { configureIdentity } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"

/**
 * `memhtml publish` across two clones of one store.
 *
 * Publish removes the listing of a directory that no longer holds a record, and both halves of that
 * meet another clone's history: the clone that publishes may hold an index that has not caught up
 * with a pull, and the clone that merges may have written into the directory the other one emptied.
 * Each case here clones a real repo through git and runs the shipped CLI in both.
 */

const stores: Array<Cli> = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.cleanup()
})

const origin = async (): Promise<Cli> => {
  const cli = await makeCli()
  stores.push(cli)
  return cli
}

/** A `git clone` of `source`, initialized the way the docs say to initialize a fresh clone. */
const cloneOf = async (source: Cli): Promise<Cli> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-integration-publish-clone-"))
  await rm(root, { recursive: true, force: true })
  await source.git("clone", "--quiet", source.root, root)
  await Effect.runPromise(configureIdentity(makeGit(root)))
  const cli = await makeCli({ root, init: false })
  stores.push(cli)
  await cli.json(["init"])
  return cli
}

const write = (cli: Cli, path: string, title: string) =>
  cli.json<{ readonly path: string }>([
    "write",
    "--type",
    "semantic",
    "--title",
    title,
    "--claim",
    `${title} holds.`,
    "--path",
    path
  ])

interface Published {
  readonly removed: ReadonlyArray<string>
  readonly commitSha: string | null
}

/** Every path HEAD's tree carries. */
const headPaths = async (cli: Cli): Promise<ReadonlyArray<string>> =>
  (await cli.git("ls-tree", "-r", "-z", "--name-only", "HEAD")).split("\0").filter(Boolean)

describe("memhtml publish over an index behind HEAD", () => {
  it("keeps the listing of a directory HEAD holds a record in, after a pull the index missed", async () => {
    const a = await origin()
    await write(a, "resources/acme-widget/a.html", "The acme widget fact")
    await a.json(["publish"])
    const b = await cloneOf(a)
    await b.json(["index", "rebuild", "--embed"])

    await write(a, "resources/new-area/b.html", "The new area fact")
    await a.json(["publish"])
    await b.git("pull", "--quiet", "--ff-only", a.root, "main")
    // No `index update`: B's rows still describe the commit before the pull.
    expect(await headPaths(b)).toContain("resources/new-area/index.html")

    const report = await b.json<Published>(["publish"])

    const head = await headPaths(b)
    expect(head).toContain("resources/new-area/b.html")
    expect(head).toContain("resources/new-area/index.html")
    expect(report.removed).toEqual([])
  })
})
