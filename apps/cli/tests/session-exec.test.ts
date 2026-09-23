import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"

import { CORPUS_SNAPSHOT_TMPDIR_PREFIX } from "@memhtml/consolidator"
import type { HeadView, MemoryRecord, OverlayOp } from "@memhtml/contracts"
import { frameKeyOf } from "@memhtml/domain"
import { contentHash, parseMemory, renderTemplate } from "@memhtml/html"
import { Effect } from "effect"
import { beforeAll, describe, expect, it } from "vitest"

import { CORPUS_MOUNT } from "../src/exec.js"
import { harvestOps, runSessionExec, type SessionExecReport } from "../src/session-exec.js"

/**
 * `session exec` (docs/v2-poc.md, "Sandbox over head plus overlay").
 *
 * The corpus under test is a `HeadView` over a plain `Map`, seeded with 50 records built the way the
 * head package builds them: `renderTemplate` for bytes, `parseMemory` for fields, `contentHash` for
 * the dedup key, `frameKeyOf` for the frame key. No git repository exists anywhere in this file, and
 * the last case proves the runtime never made one.
 *
 * Every mutation-verified guard names its mutation in a comment beside the case that catches it.
 */

const SEEDED_AT = "2026-09-20T00:00:00Z"
const VIEW_SHA = "0000000000000000000000000000000000000abc"

/** git's blob sha, computed locally, so the test double carries what `recordFrom` would. */
const blobShaOf = (html: string): string => {
  const bytes = Buffer.from(html, "utf8")
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
}

/** One `MemoryRecord` from bytes, through the real parser. */
const recordFrom = (path: string, html: string): Effect.Effect<MemoryRecord> =>
  Effect.gen(function* () {
    const doc = yield* Effect.orDie(parseMemory(html))
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
      links: doc.links.map((link) => ({ rel: link.rel, href: link.href })),
      facets: doc.article.facets.map((facet) => ({ name: facet.name, value: facet.value })),
      bodyText: doc.article.bodyText,
      html,
      archived: path.startsWith("archive/")
    }
  })

/** A `HeadView` over a `Map`, indexes derived once from the records. */
const viewOver = (records: ReadonlyArray<MemoryRecord>): HeadView => {
  const byPath = new Map(records.map((record) => [record.path, record]))
  const active = records.filter((record) => !record.archived)
  return {
    sha: VIEW_SHA,
    size: byPath.size,
    get: (path) => byPath.get(path),
    paths: () => byPath.keys(),
    records: () => byPath.values(),
    byContentHash: (hash) => active.find((record) => record.contentHash === hash)?.path,
    byFrameKey: (key) => active.filter((record) => record.frameKey === key).map((r) => r.path),
    inbound: (href) =>
      records
        .filter((record) => record.links.some((link) => link.href === href))
        .map((r) => r.path),
    byEntity: (entity) =>
      records.filter((record) => record.entities.includes(entity)).map((r) => r.path)
  }
}

const seededPath = (index: number): string =>
  `areas/inbox/fact-${String(index).padStart(2, "0")}.html`

/** Fifty distinct memories; every claim has the frame `the capital of <x> is`, so frame keys are live. */
const seedHtml = (index: number): string =>
  renderTemplate({
    title: `Fact ${index}`,
    claim: `The capital of Country-${index} is City-${index}`,
    body: [`Body ${index}.`],
    memoryType: "semantic",
    at: SEEDED_AT,
    tags: [`t${index % 5}`],
    entities: [`place:country-${index}`]
  })

const newMemory = (slug: string, claim: string): { path: string; html: string } => ({
  path: `areas/inbox/${slug}.html`,
  html: renderTemplate({
    title: slug,
    claim,
    body: ["Written by the session."],
    memoryType: "semantic",
    at: SEEDED_AT
  })
})

let view: HeadView
let seeded: MemoryRecord[]

beforeAll(async () => {
  seeded = await Effect.runPromise(
    Effect.all(Array.from({ length: 50 }, (_, i) => recordFrom(seededPath(i + 1), seedHtml(i + 1))))
  )
  view = viewOver(seeded)
})

const runScript = (script: string): Promise<SessionExecReport> =>
  Effect.runPromise(runSessionExec({ view, script }))

/** The snapshot-pin directories under the OS temp dir, which this runtime must never create. */
const pinDirs = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(tmpdir())).filter((name) => name.startsWith(CORPUS_SNAPSHOT_TMPDIR_PREFIX)).sort()

describe("runSessionExec seeds the guest from memory, runs, and harvests", () => {
  const supportsLink = '<link rel="memhtml-supports" href="/areas/inbox/fact-01.html">'
  const newA = newMemory("new-a", "The capital of Newland is Newtown")
  const newB = newMemory("new-b", "The capital of Otherland is Othertown")
  const edited = seededPath(3)
  const archivedSource = seededPath(5)
  const archivedTo = `archive/2026/${archivedSource}`
  const deletedNoTwin = seededPath(7)

  /**
   * The script reads the corpus through the preloaded helper, writes two new files, splices one link
   * into an existing head (what `addLink` does, done as bytes in the guest), archives one file the
   * way the store does (copy to `archive/<YYYY>/<path>`, remove the source), and then does four things
   * the harvester must refuse: a stray `.txt`, a deletion with no twin, a generated `index.html`, and
   * a write under `.git`.
   */
  const script = `
import * as fs from "node:fs"
import { corpus } from "/workspace/lib/corpus.mjs"
const memories = corpus()
const root = "/mnt/memhtml"
const NEW = ${JSON.stringify([newA, newB])}
for (const file of NEW) fs.writeFileSync(root + "/" + file.path, file.html)
const editedPath = root + "/" + ${JSON.stringify(edited)}
const before = fs.readFileSync(editedPath, "utf8")
fs.writeFileSync(editedPath, before.replace("</head>", ${JSON.stringify(`${supportsLink}\n</head>`)}))
fs.mkdirSync(root + "/archive/2026/areas/inbox", { recursive: true })
fs.writeFileSync(root + "/" + ${JSON.stringify(archivedTo)}, fs.readFileSync(root + "/" + ${JSON.stringify(archivedSource)}, "utf8"))
fs.unlinkSync(root + "/" + ${JSON.stringify(archivedSource)})
fs.writeFileSync(root + "/notes.txt", "a stray note")
fs.unlinkSync(root + "/" + ${JSON.stringify(deletedNoTwin)})
fs.writeFileSync(root + "/areas/index.html", "<html><body>listing</body></html>")
fs.mkdirSync(root + "/.git/refs/heads", { recursive: true })
fs.writeFileSync(root + "/.git/refs/heads/foo.html", "0123456789abcdef")
console.log(JSON.stringify({ seen: memories.size, claim: memories.get("/areas/inbox/fact-01.html")?.claim ?? null }))
`

  let report: SessionExecReport
  let pinsBefore: ReadonlyArray<string>

  beforeAll(async () => {
    pinsBefore = await pinDirs()
    report = await runScript(script)
  }, 120_000)

  it("runs the script to completion against a corpus read through the preloaded helper", () => {
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.timedOut).toBe(false)
    expect(report.corpusMount).toBe(CORPUS_MOUNT)
    expect(report.sha).toBe(VIEW_SHA)
    expect(JSON.parse(report.stdout)).toEqual({
      seen: 50,
      claim: "The capital of Country-1 is City-1"
    })
  })

  /**
   * Exactly four ops: two puts for the new files, one put for the head edit, one archive. The 46
   * untouched files produce nothing.
   *
   * (Mutation: disabling the `before.html === file.html` skip in `harvestOps` turns every untouched
   * file into a put; observed `expected [ { kind: 'put', ...(2) }, ...(50) ] to deeply equal
   * [ ..., ...(3) ]` here and three more cases red.)
   */
  it("harvests two new puts, one head-edit put, and one archive op, nothing else", () => {
    const editedRecord = view.get(edited)
    if (editedRecord === undefined) throw new Error("fixture lost the edited record")
    const editedHtml = editedRecord.html.replace("</head>", `${supportsLink}\n</head>`)

    const expected: OverlayOp[] = [
      { kind: "put", path: editedRecord.path, html: editedHtml },
      { kind: "put", path: newA.path, html: newA.html },
      { kind: "put", path: newB.path, html: newB.html },
      {
        kind: "archive",
        path: archivedSource,
        to: archivedTo,
        html: view.get(archivedSource)?.html ?? ""
      }
    ]
    expect(report.ops).toEqual(expected)
  })

  it("the head edit left the article and therefore the content hash untouched", async () => {
    const put = report.ops.find((op) => op.kind === "put" && op.path === edited)
    if (put === undefined || put.kind !== "put") throw new Error("no put for the edited file")
    expect(contentHash(put.html)).toBe(view.get(edited)?.contentHash)
    const doc = await Effect.runPromise(parseMemory(put.html))
    expect(doc.links).toEqual([{ rel: "supports", href: "/areas/inbox/fact-01.html" }])
  })

  it("the archive op carries the source path, the archive path, and the same bytes", () => {
    const archive = report.ops.find((op) => op.kind === "archive")
    if (archive === undefined || archive.kind !== "archive") throw new Error("no archive op")
    expect(archive.path).toBe(archivedSource)
    expect(archive.to).toBe(archivedTo)
    expect(archive.html).toBe(view.get(archivedSource)?.html)
  })

  /**
   * (Mutation: disabling the `.git` skip in `walkGuestTree` reports `.git/refs/heads/foo.html` as a
   * fifth put and drops the `.git` rejection; observed this case and the ops case red.)
   * (Mutation: disabling the `index.html` branch of `presentFileProblem` turns `areas/index.html`
   * into a fifth put; observed this case, the ops case, and the plain-values case red.)
   */
  it("rejects the stray .txt, the deletion with no twin, the generated listing, and .git", () => {
    expect(report.rejected).toEqual([
      { path: ".git", reason: "git's own storage is not part of the corpus" },
      {
        path: deletedNoTwin,
        reason: "vanished with no archive twin; deletion is not an operation"
      },
      { path: "areas/index.html", reason: "index.html is a generated listing, not a memory" },
      { path: "notes.txt", reason: "not an .html file" }
    ])
  })

  /**
   * No `git worktree add`, no `mkdtemp`: the snapshot-pin prefix `memhtml exec` uses is what a
   * worktree pin would leave under the OS temp dir, and the set of those entries is unchanged.
   * Filtered to that prefix rather than the whole listing because sibling suites in the same vitest
   * run create their own temp directories concurrently, and a whole-listing comparison would report
   * their work as this runtime's.
   */
  it("made no snapshot-pin directory under os.tmpdir()", async () => {
    expect(await pinDirs()).toEqual(pinsBefore)
  })
})

describe("the archive pairing requires the twin to hold the same article", () => {
  /**
   * (Mutation: disabling the `contentHashOrNull(twinHtml) !== before.contentHash` check in
   * `harvestOps` pairs the changed twin into an `archive` op; observed `expected [] to deeply equal
   * [ { ...(2) } ]` on `rejected`.)
   */
  it("rejects a vanished source whose archive twin's claim changed, and keeps the twin as a put", async () => {
    const source = seededPath(9)
    const to = `archive/2026/${source}`
    const report = await runScript(`
import * as fs from "node:fs"
const root = "/mnt/memhtml"
const html = fs.readFileSync(root + "/" + ${JSON.stringify(source)}, "utf8")
fs.mkdirSync(root + "/archive/2026/areas/inbox", { recursive: true })
fs.writeFileSync(root + "/" + ${JSON.stringify(to)}, html.replace("City-9", "Somewhere-Else"))
fs.unlinkSync(root + "/" + ${JSON.stringify(source)})
`)
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([
      {
        path: source,
        reason: `vanished, and ${to} holds a different article, so it is not this file archived`
      }
    ])
    expect(report.ops.map((op) => [op.kind, op.path])).toEqual([["put", to]])
  }, 120_000)
})

describe("harvestOps over plain values", () => {
  const seededSet = new Map([
    [
      "areas/inbox/a.html",
      {
        html: "<html><article><p><mark>A</mark></p></article></html>",
        contentHash: contentHash("<article><p><mark>A</mark></p></article>")
      }
    ],
    [
      "areas/inbox/b.html",
      {
        html: "<html><article><p><mark>B</mark></p></article></html>",
        contentHash: contentHash("<article><p><mark>B</mark></p></article>")
      }
    ]
  ])

  it("an unchanged tree yields no ops and no rejections", () => {
    const after = [...seededSet].map(([path, file]) => ({ path, html: file.html }))
    expect(harvestOps({ seeded: seededSet, after, skippedGitDir: false })).toEqual({
      ops: [],
      rejected: []
    })
  })

  it("a twin under a different year still pairs, because the year is a label", () => {
    const a = seededSet.get("areas/inbox/a.html")
    if (a === undefined) throw new Error("fixture")
    const after = [
      { path: "areas/inbox/b.html", html: seededSet.get("areas/inbox/b.html")?.html ?? "" },
      { path: "archive/2031/areas/inbox/a.html", html: a.html }
    ]
    expect(harvestOps({ seeded: seededSet, after, skippedGitDir: false })).toEqual({
      ops: [
        {
          kind: "archive",
          path: "areas/inbox/a.html",
          to: "archive/2031/areas/inbox/a.html",
          html: a.html
        }
      ],
      rejected: []
    })
  })

  it("rejects a reserved path and a non-PARA root with a reason, so neither reaches the log", () => {
    // Mutation: `presentFileProblem` drops the `isReservedPath` and `memoryPathViolation` clauses ->
    // these four come back as puts and the case is red.
    const junk = "<html><article><p><mark>J</mark></p></article></html>"
    const after = [
      ...[...seededSet].map(([path, file]) => ({ path, html: file.html })),
      { path: ".memhtml/smuggled.html", html: junk },
      { path: "areas/arcs/arc.html", html: junk },
      { path: "resources/people/someone.html", html: junk },
      { path: "README.html", html: junk },
      { path: "areas/inbox/good.html", html: junk }
    ]
    const report = harvestOps({ seeded: seededSet, after, skippedGitDir: false })
    expect(report.ops).toEqual([{ kind: "put", path: "areas/inbox/good.html", html: junk }])
    expect(report.rejected).toEqual([
      { path: ".memhtml/smuggled.html", reason: "a reserved path only curation writes" },
      {
        path: "README.html",
        reason:
          "not a memory path: it is not rooted in a PARA bucket (projects, areas, resources, archive)"
      },
      { path: "areas/arcs/arc.html", reason: "a reserved path only curation writes" },
      { path: "resources/people/someone.html", reason: "a reserved path only curation writes" }
    ])
  })

  it("sitemap.xml and a nested index.html are rejected by name, a .txt by extension", () => {
    const after = [
      ...[...seededSet].map(([path, file]) => ({ path, html: file.html })),
      { path: "sitemap.xml", html: "<urlset/>" },
      { path: "areas/index.html", html: "<html/>" },
      { path: "areas/readme.txt", html: "hi" }
    ]
    expect(harvestOps({ seeded: seededSet, after, skippedGitDir: false }).rejected).toEqual([
      { path: "areas/index.html", reason: "index.html is a generated listing, not a memory" },
      { path: "areas/readme.txt", reason: "not an .html file" },
      { path: "sitemap.xml", reason: "sitemap.xml is generated, not a memory" }
    ])
  })
})
