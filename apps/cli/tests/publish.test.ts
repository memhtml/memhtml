import { execFile } from "node:child_process"
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import type { PublishReport } from "../src/publish.js"
import { type Cli, makeCli } from "./harness.js"

const exec = promisify(execFile)

/**
 * `memhtml publish` over a tree whose directories have emptied.
 *
 * A listing is generated for every directory holding an indexed record and for each ancestor, and
 * nothing else may delete one: `index.html` is reserved in every session scope and deletion is not
 * an operation. So publish is the only place a listing whose directory no longer holds a record can
 * leave the tree, and these cases pin that it does, in the same commit, named in the report, while
 * the root listing, the sitemap, and every listing the generator still produces stay put.
 */

const stores: Array<Cli> = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.cleanup()
})

const store = async (): Promise<Cli> => {
  const cli = await makeCli()
  stores.push(cli)
  return cli
}

const git = async (cli: Cli, ...args: ReadonlyArray<string>): Promise<string> =>
  (await exec("git", ["-C", cli.root, ...args])).stdout

/** Every path HEAD's tree carries. */
const headPaths = async (cli: Cli): Promise<ReadonlyArray<string>> =>
  (await git(cli, "ls-tree", "-r", "-z", "--name-only", "HEAD")).split("\0").filter(Boolean)

/** The paths HEAD's own commit deleted. */
const deletedByHead = async (cli: Cli): Promise<ReadonlyArray<string>> => {
  const diff = ["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "--no-renames", "HEAD"]
  const fields = (await git(cli, ...diff)).split("\0").filter(Boolean)
  const deleted: Array<string> = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    if (fields[at] === "D") deleted.push(fields[at + 1] ?? "")
  }
  return deleted
}

const exists = async (cli: Cli, path: string): Promise<boolean> =>
  access(join(cli.root, path)).then(
    () => true,
    () => false
  )

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

const publish = (cli: Cli) => cli.json<PublishReport>(["publish"])

describe("memhtml publish removes a listing whose directory holds no record", () => {
  it("removes the listing of a directory whose records were all archived", async () => {
    const cli = await store()
    await write(cli, "resources/old/a-fact.html", "The old widget fact")
    await write(cli, "resources/acme-widget/b.html", "The acme widget fact")
    await publish(cli)
    expect(await headPaths(cli)).toContain("resources/old/index.html")

    await cli.json(["archive", "resources/old/a-fact.html", "--reason", "no longer current"])
    const report = await publish(cli)

    expect(await deletedByHead(cli)).toEqual(["resources/old/index.html"])
    expect(await headPaths(cli)).not.toContain("resources/old/index.html")
    expect(await exists(cli, "resources/old/index.html")).toBe(false)
    expect(report.removed).toEqual(["resources/old/index.html"])
    expect(report.commitSha).not.toBeNull()
    expect((await git(cli, "status", "--porcelain")).trim()).toBe("")

    // The parent still holds a record below it, so it keeps its listing, and stops linking the
    // directory that emptied.
    const resources = await readFile(join(cli.root, "resources/index.html"), "utf8")
    expect(resources).toContain('href="/resources/acme-widget/index.html"')
    expect(resources).not.toContain("/resources/old/")
  })

  it("keeps the listing of a directory that holds only archived records", async () => {
    /**
     * Archived records are indexed rows under `archive/<YYYY>/`, and `generateIndexes` lists every
     * directory holding a row. So the archive mirror of an emptied directory has a listing, and it
     * is no candidate for removal; neither are its ancestors up to `archive/index.html`.
     */
    const cli = await store()
    await write(cli, "resources/old/a-fact.html", "The old widget fact")
    await publish(cli)
    const archived = await cli.json<{ readonly archivePath: string }>([
      "archive",
      "resources/old/a-fact.html",
      "--reason",
      "no longer current"
    ])
    const report = await publish(cli)

    const mirror = dirname(archived.archivePath)
    const year = archived.archivePath.split("/")[1] ?? ""
    const kept = [
      "index.html",
      "archive/index.html",
      `archive/${year}/index.html`,
      `archive/${year}/resources/index.html`,
      `${mirror}/index.html`,
      "sitemap.xml"
    ]
    const head = await headPaths(cli)
    for (const path of kept) {
      expect(head, path).toContain(path)
      expect(report.removed, path).not.toContain(path)
    }
    const listing = await readFile(join(cli.root, mirror, "index.html"), "utf8")
    expect(listing).toContain(`href="/${archived.archivePath}"`)
    // The live side emptied entirely, so its bucket listing goes with the directory's.
    expect(report.removed).toEqual(["resources/index.html", "resources/old/index.html"])
  })

  it("removes a hand-committed listing in a directory with no record", async () => {
    const cli = await store()
    await write(cli, "areas/inbox/a-fact.html", "The inbox fact")
    const handWritten = "<!doctype html>\n<title>old</title>\n<p>A listing of nothing.</p>\n"
    for (const path of ["resources/old/index.html", "notes/index.html"]) {
      await mkdir(join(cli.root, dirname(path)), { recursive: true })
      await writeFile(join(cli.root, path), handWritten, "utf8")
    }
    await git(cli, "add", "--", "resources/old/index.html", "notes/index.html")
    await git(cli, "commit", "--quiet", "-m", "add two listings by hand")
    // Untracked, so publish leaves it alone: only a tracked listing is the generator's to remove.
    await mkdir(join(cli.root, "resources/scratch"), { recursive: true })
    await writeFile(join(cli.root, "resources/scratch/index.html"), handWritten, "utf8")

    const report = await publish(cli)

    expect(await deletedByHead(cli)).toEqual(["resources/old/index.html"])
    expect(await exists(cli, "resources/old/index.html")).toBe(false)
    expect(report.removed).toEqual(["resources/old/index.html"])
    // `notes/` is outside the four buckets, so its `index.html` is not the generator's.
    expect(await headPaths(cli)).toContain("notes/index.html")
    expect(await exists(cli, "resources/scratch/index.html")).toBe(true)
  })

  it("keeps the root listing and the sitemap when the store has emptied", async () => {
    /**
     * With no record left, the generator produces the sitemap alone and no root `index.html`. The
     * root listing is not under a bucket, so it is never a removal candidate, and every bucket
     * listing is one.
     */
    const cli = await store()
    await write(cli, "areas/inbox/a-fact.html", "The inbox fact")
    await publish(cli)
    await git(cli, "rm", "--quiet", "--", "areas/inbox/a-fact.html")
    await git(cli, "commit", "--quiet", "-m", "remove the only record by hand")
    await cli.json(["index", "update"])

    const report = await publish(cli)

    expect(report.removed).toEqual(["areas/inbox/index.html", "areas/index.html"])
    const head = await headPaths(cli)
    expect(head).toContain("index.html")
    expect(head).toContain("sitemap.xml")
    expect(head).not.toContain("areas/index.html")
    expect(head).not.toContain("areas/inbox/index.html")
  })

  it("removes exactly the stale path when its directory name is a glob pattern", async () => {
    /**
     * `git rm` reads its arguments as pathspecs, where `[b]` is a character class: a bare
     * `resources/a[b]/index.html` also matches `resources/ab/index.html`, the listing of a
     * directory that still holds a record. Each removal is a literal path, so only the stale one
     * goes.
     */
    const cli = await store()
    await write(cli, "resources/ab/live.html", "The live widget fact")
    await write(cli, "resources/a[b]/gone.html", "The gone widget fact")
    await publish(cli)
    await cli.json(["archive", "resources/a[b]/gone.html", "--reason", "no longer current"])

    const report = await publish(cli)

    expect(report.removed).toEqual(["resources/a[b]/index.html"])
    expect(report.paths).not.toContain("resources/ab/index.html")
    expect(await headPaths(cli)).toContain("resources/ab/index.html")
    expect(await exists(cli, "resources/ab/index.html")).toBe(true)
  })

  it("stages no removal when a write fails, so the next commit cannot carry one", async () => {
    /**
     * Every store write commits the whole shared git index (`git commit` with no pathspec), so a
     * removal staged by a publish that then failed would land in the next, unrelated commit. The
     * removals are staged only after every artifact is written. The failure is a real one, a listing
     * made read-only, as in `doctor.test.ts`.
     */
    const cli = await store()
    await write(cli, "resources/old/a-fact.html", "The old widget fact")
    await write(cli, "resources/live/b.html", "The live widget fact")
    await publish(cli)
    await cli.json(["archive", "resources/old/a-fact.html", "--reason", "no longer current"])
    await write(cli, "resources/live/c.html", "The second live widget fact")
    const listing = join(cli.root, "resources/live/index.html")
    await chmod(listing, 0o444)
    try {
      const failed = await cli.envelope(["publish"])
      expect(failed.code).toBe("ERR_STORAGE")
    } finally {
      await chmod(listing, 0o644)
    }

    expect((await git(cli, "diff", "--cached", "--name-status")).trim()).toBe("")
    await write(cli, "resources/live/d.html", "The third live widget fact")
    expect(await deletedByHead(cli)).toEqual([])
    expect(await headPaths(cli)).toContain("resources/old/index.html")
  })

  it("commits nothing on a second run once the stale listings are gone", async () => {
    const cli = await store()
    await write(cli, "resources/old/a-fact.html", "The old widget fact")
    await write(cli, "resources/acme-widget/b.html", "The acme widget fact")
    await publish(cli)
    await cli.json(["archive", "resources/old/a-fact.html", "--reason", "no longer current"])
    await publish(cli)
    const head = (await git(cli, "rev-parse", "HEAD")).trim()

    const again = await publish(cli)

    expect(again.removed).toEqual([])
    expect(again.written).toBe(0)
    expect(again.commitSha).toBeNull()
    expect((await git(cli, "rev-parse", "HEAD")).trim()).toBe(head)
  })
})
