import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

/** `git -C <root>` with its exit status kept, for a merge whose refusal is the answer. */
const gitResult = (cli: Cli, ...args: ReadonlyArray<string>) =>
  spawnSync("git", ["-C", cli.root, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" }
  })

/**
 * Merge `from`'s `main` into `into`, the merge `git pull --no-rebase` makes. A fetch and a
 * `--no-ff` merge rather than a pull, so a `pull.*` or `merge.ff` setting in the machine's own
 * config cannot pick another path.
 */
const mergeFrom = (into: Cli, from: Cli) => {
  const fetched = gitResult(into, "fetch", "--quiet", from.root, "main")
  expect(fetched.status, fetched.stderr).toBe(0)
  return gitResult(into, "merge", "--no-ff", "--no-edit", "FETCH_HEAD")
}

/** Every path HEAD's tree carries. */
const headPaths = async (cli: Cli): Promise<ReadonlyArray<string>> =>
  (await cli.git("ls-tree", "-r", "-z", "--name-only", "HEAD")).split("\0").filter(Boolean)

describe("memhtml publish over an index behind HEAD", () => {
  it("keeps a live directory's listing after a pull the index has not seen", async () => {
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

describe("a merge after publish removed the listing of an emptied directory", () => {
  /**
   * A archives the only record in `resources/old/` and publishes, which removes the directory's
   * listing and leaves the directory empty in A. B, meanwhile, writes a record into that directory.
   * A per-file `git mv` that empties a directory reads to a merge as the directory's rename, so
   * without `merge.directoryRenames=false` B's record would follow it into `archive/`.
   */
  const diverge = async (options: { readonly publishInB: boolean }) => {
    const a = await origin()
    await write(a, "resources/old/a.html", "The old widget fact")
    await a.json(["publish"])
    const b = await cloneOf(a)
    await b.json(["index", "rebuild", "--embed"])

    await a.json(["archive", "resources/old/a.html", "--reason", "no longer current"])
    const published = await a.json<Published>(["publish"])
    expect(published.removed).toContain("resources/old/index.html")
    await write(b, "resources/old/d.html", "The new widget fact")
    if (options.publishInB) await b.json(["publish"])
    return { a, b }
  }

  /** HEAD's paths under `archive/` that end in the record B wrote. */
  const archivedCopies = async (cli: Cli) =>
    (await headPaths(cli)).filter((path) => path.startsWith("archive/") && path.endsWith("/d.html"))

  it("keeps the record the other clone wrote where it was written", async () => {
    const { a, b } = await diverge({ publishInB: false })

    const merged = mergeFrom(b, a)

    expect(merged.status, merged.stdout + merged.stderr).toBe(0)
    expect(await headPaths(b)).toContain("resources/old/d.html")
    expect(await archivedCopies(b)).toEqual([])
    await b.json(["index", "update"])
    const republished = await b.json<Published>(["publish"])
    expect(republished.removed).toEqual([])
    const listing = await readFile(join(b.root, "resources/old/index.html"), "utf8")
    expect(listing).toContain('href="/resources/old/d.html"')
  })

  it("settles a listing one clone removed and the other rewrote, by publishing", async () => {
    /**
     * When B has published too, its listing of `resources/old/` changed while A's was removed: a
     * modify/delete conflict, which the `merge=ours` driver does not settle, since it only merges
     * two sets of bytes. The documented resolution: settle the path either way, finish the merge,
     * update the index, and publish, which writes the listing back while its directory holds a
     * record.
     */
    const { a, b } = await diverge({ publishInB: true })

    const merged = mergeFrom(b, a)

    expect(merged.status).toBe(1)
    const unmerged = gitResult(b, "diff", "--name-only", "--diff-filter=U").stdout
    expect(unmerged.trim().split("\n")).toEqual(["resources/old/index.html"])
    expect(await archivedCopies(b)).toEqual([])
    await b.git("rm", "--quiet", "--", "resources/old/index.html")
    await b.git("commit", "--quiet", "--no-edit")
    await b.json(["index", "update"])
    const republished = await b.json<Published>(["publish"])

    expect(republished.removed).toEqual([])
    expect(await headPaths(b)).toContain("resources/old/index.html")
    const listing = await readFile(join(b.root, "resources/old/index.html"), "utf8")
    expect(listing).toContain('href="/resources/old/d.html"')
    expect(listing).not.toContain('href="/resources/old/a.html"')
  })
})
