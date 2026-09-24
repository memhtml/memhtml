import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { addLink, renderTemplate, setMeta } from "@memhtml/html"
import { archiveBody } from "@memhtml/session"
import { Effect } from "effect"
import { afterAll, describe, expect, it } from "vitest"

import {
  ARTICLE_EDIT_REASON,
  commitSubjectOf,
  mergeBase,
  parseDiffTreeRaw,
  readCurateDelta,
  reconstructOps
} from "../src/replay.js"

/**
 * The replay's reconstruction (`docs/v2-poc.md`, "Curation door"): two trees in, the curator's
 * operation log out, or a rejection naming the path that was written by hand.
 *
 * The bytes are built the way the commit path builds them: `renderTemplate` for a record,
 * `archiveBody` for an archive twin (the same stamps `commitSession` writes), `addLink` for an edge.
 * No git repository is involved until the last block, which drives `readCurateDelta` against a real
 * one so the raw `diff-tree` parse is checked against git's own output rather than a hand-typed
 * sample alone.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `reconstructOps`: drop the `archiveBody(html, stamp)` restamp of the seeded side -> "an archive
 *   twin stamped by the commit path is one archive op" (the stamps read as a meta change and the
 *   source is rejected).
 * - `reconstructOps`: drop the `input.before.has(op.path)` filter -> "an article edited in place is
 *   rejected by path" (the edit comes back as a put).
 * - `parseDiffTreeRaw`: drop the `fields.pop()` of the trailing empty field -> "parses git's raw
 *   NUL-framed output" (a record with an empty header throws).
 */

const AT = "2026-09-20T12:00:00Z"
const ARCHIVED_AT = "2026-09-23T08:15:00Z"

const memory = (index: number): { readonly path: string; readonly html: string } => ({
  path: `areas/inbox/replay-fixture-${String(index)}.html`,
  html: renderTemplate({
    title: `Replay fixture ${index}`,
    claim: `Replay fixture fact ${index} names harbor ${index % 3}.`,
    memoryType: "semantic",
    at: AT
  })
})

const kept = memory(0)
const archived = memory(1)
const added = memory(2)
const twinPath = `archive/2026/${archived.path}`

describe("reconstructOps rebuilds the curator's log from two trees", () => {
  it("an added record is a put, an archive twin stamped by the commit path is one archive op, and an added edge is one link op", () => {
    const linked = addLink(kept.html, "supersedes", `/${twinPath}`)
    const twin = addLink(archiveBody(archived.html, ARCHIVED_AT), "supports", `/${added.path}`)
    const result = reconstructOps({
      before: new Map([
        [kept.path, kept.html],
        [archived.path, archived.html]
      ]),
      after: new Map([
        [kept.path, linked],
        [added.path, added.html],
        [twinPath, twin]
      ])
    })
    expect(result.rejected).toEqual([])
    expect(result.ops).toEqual([
      { kind: "put", path: added.path, html: added.html },
      { kind: "link", path: kept.path, rel: "supersedes", href: `/${twinPath}` },
      { kind: "link", path: archived.path, rel: "supports", href: `/${added.path}` },
      { kind: "archive", path: archived.path, to: twinPath, html: twin }
    ])
    expect(result.counts).toEqual({ put: 1, archive: 1, link: 2, unlink: 0 })
    expect(result.archivedAt).toBe(ARCHIVED_AT)
  })

  it("puts come before links and links before archives, whatever order the maps hold", () => {
    const result = reconstructOps({
      before: new Map([[archived.path, archived.html]]),
      after: new Map([
        [twinPath, archiveBody(archived.html, ARCHIVED_AT)],
        [added.path, addLink(added.html, "supersedes", `/${twinPath}`)]
      ])
    })
    expect(result.rejected).toEqual([])
    expect(result.ops.map((op) => op.kind)).toEqual(["put", "archive"])
  })

  it("an article edited in place is rejected by path", () => {
    const edited = kept.html.replace("harbor 0", "harbor 7")
    const result = reconstructOps({
      before: new Map([[kept.path, kept.html]]),
      after: new Map([[kept.path, edited]])
    })
    expect(result.ops).toEqual([])
    expect(result.rejected).toEqual([{ path: kept.path, reason: ARTICLE_EDIT_REASON }])
  })

  it("a file deleted with no archive twin is rejected by path", () => {
    const result = reconstructOps({
      before: new Map([[kept.path, kept.html]]),
      after: new Map()
    })
    expect(result.ops).toEqual([])
    expect(result.rejected).toEqual([
      { path: kept.path, reason: "vanished with no archive twin; deletion is not an operation" }
    ])
  })

  it("a removed link replays as one unlink; a changed meta is rejected as a head edit", () => {
    const withLink = addLink(kept.html, "supports", `/${archived.path}`)
    const removed = reconstructOps({
      before: new Map([[kept.path, withLink]]),
      after: new Map([[kept.path, kept.html]])
    })
    expect(removed.ops).toEqual([
      { kind: "unlink", path: kept.path, rel: "supports", href: `/${archived.path}` }
    ])
    expect(removed.rejected).toEqual([])

    const meta = reconstructOps({
      before: new Map([[kept.path, kept.html]]),
      after: new Map([[kept.path, setMeta(kept.html, "memhtml-confidence", "0.2")]])
    })
    expect(meta.ops).toEqual([])
    expect(meta.rejected[0]?.reason).toContain("a meta changed")
  })

  it("an unstamped twin holding the same bytes (a hand git mv) is still one archive op, with no instant to keep", () => {
    const result = reconstructOps({
      before: new Map([[archived.path, archived.html]]),
      after: new Map([[twinPath, archived.html]])
    })
    expect(result.rejected).toEqual([])
    expect(result.ops).toEqual([
      { kind: "archive", path: archived.path, to: twinPath, html: archived.html }
    ])
    expect(result.archivedAt).toBeNull()
  })

  it("a twin whose head gained a meta beside the stamps is rejected as a meta change", () => {
    const result = reconstructOps({
      before: new Map([[archived.path, archived.html]]),
      after: new Map([
        [twinPath, setMeta(archiveBody(archived.html, ARCHIVED_AT), "memhtml-confidence", "0.2")]
      ])
    })
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.path).toBe(archived.path)
    expect(result.rejected[0]?.reason).toContain("a meta changed")
  })

  it("an archive twin whose article differs is rejected, and a file that is not a memory too", () => {
    const result = reconstructOps({
      before: new Map([[archived.path, archived.html]]),
      after: new Map([
        [twinPath, archiveBody(archived.html.replace("harbor 1", "harbor 9"), ARCHIVED_AT)],
        ["areas/inbox/notes.txt", "plain text"]
      ])
    })
    // The twin stays a put in the harvester's answer; the rejection is what makes the merge refuse.
    expect(result.rejected.map((entry) => entry.path).sort()).toEqual(
      [archived.path, "areas/inbox/notes.txt"].sort()
    )
    expect(result.rejected.find((entry) => entry.path === archived.path)?.reason).toContain(
      "holds a different article"
    )
  })

  it("twins stamped at two instants leave archivedAt null", () => {
    const other = memory(3)
    const result = reconstructOps({
      before: new Map([
        [archived.path, archived.html],
        [other.path, other.html]
      ]),
      after: new Map([
        [twinPath, archiveBody(archived.html, ARCHIVED_AT)],
        [`archive/2026/${other.path}`, archiveBody(other.html, "2026-09-23T09:00:00Z")]
      ])
    })
    expect(result.rejected).toEqual([])
    expect(result.counts.archive).toBe(2)
    expect(result.archivedAt).toBeNull()
  })
})

describe("parseDiffTreeRaw", () => {
  const A = "a".repeat(40)
  const B = "b".repeat(40)
  const ZERO = "0".repeat(40)

  it("parses git's raw NUL-framed output", () => {
    const raw = [
      `:000000 100644 ${ZERO} ${A} A`,
      "areas/inbox/new.html",
      `:100644 000000 ${B} ${ZERO} D`,
      "areas/inbox/gone.html",
      `:100644 100644 ${A} ${B} M`,
      "areas/inbox/café.html",
      ""
    ].join("\0")
    expect(parseDiffTreeRaw(raw)).toEqual([
      { status: "A", path: "areas/inbox/new.html", beforeSha: null, afterSha: A },
      { status: "D", path: "areas/inbox/gone.html", beforeSha: B, afterSha: null },
      { status: "M", path: "areas/inbox/café.html", beforeSha: A, afterSha: B }
    ])
    expect(parseDiffTreeRaw("")).toEqual([])
  })

  it("throws on a record that is not a raw entry rather than returning half a diff", () => {
    expect(() => parseDiffTreeRaw("areas/inbox/new.html\0")).toThrow(/not a raw entry/)
  })
})

describe("readCurateDelta against a real repository", () => {
  const exec = promisify(execFile)
  const roots: Array<string> = []
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  const git = async (root: string, ...args: ReadonlyArray<string>): Promise<string> =>
    (
      await exec("git", ["-C", root, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com"
        }
      })
    ).stdout.trim()

  const write = async (root: string, path: string, html: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), html, "utf8")
  }

  it("reads the changed paths' bodies at both ends, the merge base, and the tip's subject", async () => {
    const root = await mkdtemp(join(tmpdir(), "memhtml-replay-"))
    roots.push(root)
    await git(root, "init", "-q", "-b", "main")
    await write(root, kept.path, kept.html)
    await write(root, archived.path, archived.html)
    await git(root, "add", "-A")
    await git(root, "commit", "-q", "-m", "base")
    const base = await git(root, "rev-parse", "HEAD")

    await git(root, "checkout", "-q", "-b", "curate/x")
    await write(root, added.path, added.html)
    await write(root, twinPath, archiveBody(archived.html, ARCHIVED_AT))
    await rm(join(root, archived.path))
    await write(root, kept.path, addLink(kept.html, "supersedes", `/${twinPath}`))
    await git(root, "add", "-A")
    await git(root, "commit", "-q", "-m", "memhtml(curate): curated x")
    const tip = await git(root, "rev-parse", "HEAD")

    await git(root, "checkout", "-q", "main")
    await write(root, "areas/inbox/unrelated.html", memory(9).html)
    await git(root, "add", "-A")
    await git(root, "commit", "-q", "-m", "main moved")
    const main = await git(root, "rev-parse", "HEAD")

    expect(await Effect.runPromise(mergeBase(root, main, tip))).toBe(base)
    expect(await Effect.runPromise(commitSubjectOf(root, tip))).toBe("curated x")

    const delta = await Effect.runPromise(readCurateDelta(root, base, tip))
    expect(delta.unsupported).toEqual([])
    expect([...delta.before.keys()].sort()).toEqual([archived.path, kept.path].sort())
    expect([...delta.after.keys()].sort()).toEqual([added.path, twinPath, kept.path].sort())
    expect(delta.before.get(archived.path)).toBe(archived.html)
    expect(delta.after.get(twinPath)).toBe(archiveBody(archived.html, ARCHIVED_AT))

    const result = reconstructOps({ before: delta.before, after: delta.after })
    expect(result.rejected).toEqual([])
    expect(result.counts).toEqual({ put: 1, archive: 1, link: 1, unlink: 0 })
  })
})
