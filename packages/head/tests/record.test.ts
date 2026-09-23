import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { contentHash } from "@memhtml/html"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { afterEach, describe, expect, it } from "vitest"

import { blobShaOf, isArchivedPath, recordFrom } from "../src/index.js"
import { BROKEN_HTML, memoryFor, run, runErr } from "./helpers.js"

const repos: Array<FixtureRepo> = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

/** What `git hash-object` says about the same bytes, written to disk so git reads them itself. */
const gitHashOf = async (content: string): Promise<string> => {
  const repo = await run(makeFixtureRepo())
  repos.push(repo)
  const path = "areas/inbox/probe.html"
  await writeFile(join(repo.root, path), content, "utf8")
  return run(repo.git.hashObject(path))
}

describe("blobShaOf", () => {
  it("equals git hash-object on ASCII content", async () => {
    const html = memoryFor(1).html
    expect(blobShaOf(html)).toBe(await gitHashOf(html))
  })

  it("equals git hash-object on multibyte content, where byte length is not string length", async () => {
    const html = memoryFor(2).html.replace("Region", "Región café 日本語 🌍")
    expect(Buffer.byteLength(html, "utf8")).toBeGreaterThan(html.length)
    expect(blobShaOf(html)).toBe(await gitHashOf(html))
  })

  it("equals git hash-object on the empty string", async () => {
    expect(blobShaOf("")).toBe(await gitHashOf(""))
  })
})

describe("recordFrom", () => {
  it("projects every parsed field onto the record", async () => {
    const { path, html } = memoryFor(4)
    const record = await run(recordFrom({ path, html }))
    expect(record.path).toBe(path)
    expect(record.blobSha).toBe(blobShaOf(html))
    expect(record.contentHash).toBe(contentHash(html))
    expect(record.title).toBe("Fact 4 about Country4")
    expect(record.claim).toBe("The capital of Country4 is City4.")
    expect(record.frameKey).toBe("the capital of country4 is")
    expect(record.memoryType).toBe("episodic")
    expect(record.status).toBe("active")
    expect(record.createdAt).toBe("2026-05-05T12:00:00Z")
    expect(record.updatedAt).toBe("2026-05-05T12:00:00Z")
    expect(record.eventAt).toBe("2025-05-05")
    expect(record.confidence).toBeNull()
    expect(record.importance).toBeNull()
    expect(record.tags).toEqual(["region-4"])
    expect(record.entities).toEqual(["place:country4", "topic:crop4"])
    expect(record.links).toEqual([{ rel: "relates_to", href: "/projects/alpha/fact-3.html" }])
    expect(record.facets).toEqual([])
    expect(record.bodyText).toContain("Region 4 grows crop4")
    expect(record.html).toBe(html)
    expect(record.archived).toBe(false)
  })

  it("reads eventAt as null when the article names no time", async () => {
    const record = await run(recordFrom(memoryFor(1)))
    expect(record.eventAt).toBeNull()
  })

  it("marks a record archived when and only when its path is under archive/", async () => {
    const archived = await run(recordFrom(memoryFor(9)))
    expect(archived.path.startsWith("archive/")).toBe(true)
    expect(archived.archived).toBe(true)
    expect(isArchivedPath("archive/2025/areas/inbox/x.html")).toBe(true)
    expect(isArchivedPath("areas/archive-notes/x.html")).toBe(false)
    expect(isArchivedPath("archives/x.html")).toBe(false)
  })

  it("fails with the parser's InvalidMemory on a file with no article", async () => {
    const error = await runErr(recordFrom({ path: "areas/inbox/broken.html", html: BROKEN_HTML }))
    expect(error._tag).toBe("InvalidMemory")
    expect(error.reason.length).toBeGreaterThan(0)
  })
})
