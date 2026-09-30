import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"

import type { HeadView, MemoryRecord, OverlayOp } from "@memhtml/contracts"
import { frameKeyOf } from "@memhtml/domain"
import { addLink, contentHash, parseMemory, renderTemplate } from "@memhtml/html"
import { Effect } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { CORPUS_MOUNT, cutOffByTheRuntime } from "../src/exec.js"
import { CORPUS_SNAPSHOT_TMPDIR_PREFIX } from "../src/mount.js"
import {
  HEAD_EDIT_REASON,
  harvestOps,
  runSessionExec,
  type SessionExecReport
} from "../src/session-exec.js"

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
  Effect.runPromise(runSessionExec({ view, script, lang: "js" }))

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
   * into an existing head (what `addLink` does, done as bytes in the guest, which the harvester turns
   * into a `link` op), archives one file the way the store does (copy to `archive/<YYYY>/<path>`,
   * remove the source), and then does four things the harvester must refuse: a stray `.txt`, a
   * deletion with no twin, a generated `index.html`, and a write under `.git`.
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
   * Exactly four ops: two puts for the new files, one link for the head edit, one archive. The 46
   * untouched files produce nothing.
   *
   * (Mutation: disabling the `before.html === file.html` skip in `harvestOps` turns every untouched
   * file into a put; observed `expected [ { kind: 'put', ...(2) }, ...(50) ] to deeply equal
   * [ ..., ...(3) ]` here and three more cases red.)
   */
  it("harvests two new puts, one link for the head edit, and one archive op, nothing else", () => {
    const expected: OverlayOp[] = [
      { kind: "put", path: newA.path, html: newA.html },
      { kind: "put", path: newB.path, html: newB.html },
      { kind: "link", path: edited, rel: "supports", href: "/areas/inbox/fact-01.html" },
      {
        kind: "archive",
        path: archivedSource,
        to: archivedTo,
        html: view.get(archivedSource)?.html ?? ""
      }
    ]
    expect(report.ops).toEqual(expected)
  })

  it("the head edit is a link op and never a put of the edited path", () => {
    expect(report.ops.some((op) => op.kind === "put" && op.path === edited)).toBe(false)
    expect(report.rejected.some((entry) => entry.path === edited)).toBe(false)
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

describe("an unchanged record at a curation-reserved path is not a write", () => {
  const ARC = "areas/arcs/memory-is-a-value.html"
  const PERSON = "resources/people/someone.html"
  const INBOX = "areas/inbox/plain-fact.html"

  const html = (title: string, claim: string): string =>
    renderTemplate({
      title,
      claim,
      body: ["Seeded."],
      memoryType: "semantic",
      at: SEEDED_AT,
      entities: ["system:memhtml"]
    })

  let curated: HeadView
  beforeAll(async () => {
    curated = viewOver(
      await Effect.runPromise(
        Effect.all([
          recordFrom(ARC, html("Arc", "The corpus is held as a value")),
          recordFrom(PERSON, html("Someone", "Someone works on the store")),
          recordFrom(INBOX, html("Plain", "The capital of Plainland is Plaintown"))
        ])
      )
    )
  })

  /**
   * A session-scope run over a store holding curated records reports none of them.
   *
   * (Mutation: moving the `before.html === file.html` skip in `harvestOps` back below the
   * `presentFileProblem` check -> `rejected` carries the arc and the person record with "a reserved
   * path only curation writes" and the case is red.)
   */
  it("a no-op script over seeded arcs and people records harvests nothing and rejects nothing", async () => {
    const report = await Effect.runPromise(
      runSessionExec({ view: curated, script: "console.log('no-op')", lang: "js" })
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    expect(report.ops).toEqual([])
  }, 120_000)

  /**
   * The fix skips only UNCHANGED seeded files; a write at a reserved path is still refused.
   *
   * (Mutation: exempting every seeded path from `presentFileProblem`, `before !== undefined ? null :
   * presentFileProblem(...)` -> the edited arc comes back as a put and the case is red.)
   */
  it("a changed or a new file at a reserved path is still rejected under the session scope", () => {
    const seededSet = new Map(
      [...curated.records()].map((record) => [
        record.path,
        { html: record.html, contentHash: record.contentHash }
      ])
    )
    const arc = seededSet.get(ARC)
    if (arc === undefined) throw new Error("fixture")
    const after = [
      ...[...seededSet].map(([path, file]) => ({ path, html: file.html })),
      { path: "areas/arcs/new-arc.html", html: html("New arc", "A new arc names its sources") }
    ].map((file) =>
      file.path === ARC ? { path: ARC, html: arc.html.replace("Seeded.", "Edited.") } : file
    )
    const report = harvestOps({ seeded: seededSet, after, skippedGitDir: false })
    expect(report.ops).toEqual([])
    expect(report.rejected).toEqual([
      { path: ARC, reason: "a reserved path only curation writes" },
      { path: "areas/arcs/new-arc.html", reason: "a reserved path only curation writes" }
    ])
  })
})

describe("--lang bash runs the script as the shell program", () => {
  const runBash = (script: string, timeoutMs?: number): Promise<SessionExecReport> =>
    Effect.runPromise(runSessionExec({ view, script, lang: "bash", timeoutMs }))

  it("reads the corpus with shell tools and harvests nothing", async () => {
    const report = await runBash("grep -rl 'Country-1[0-9] is' /mnt/memhtml/areas | wc -l")
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.lang).toBe("bash")
    expect(report.stdout.trim()).toBe("10")
    expect(report.ops).toEqual([])
    expect(report.rejected).toEqual([])
  }, 120_000)

  it("is not JavaScript: a module's syntax is a bash parse error, and --lang js runs it", async () => {
    const asBash = await runBash("console.log(1 + 1)")
    expect(asBash.exitCode).not.toBe(0)
    const asJs = await Effect.runPromise(
      runSessionExec({ view, script: "console.log(1 + 1)", lang: "js" })
    )
    expect(asJs.exitCode, asJs.stderr).toBe(0)
    expect(asJs.lang).toBe("js")
    expect(asJs.stdout.trim()).toBe("2")
  }, 120_000)

  it("can still js-exec a module that imports the preloaded helper", async () => {
    const report = await runBash(
      [
        "cat > /tmp/count.mjs <<'JS'",
        'import { corpus } from "/workspace/lib/corpus.mjs"',
        "console.log(corpus().size)",
        "JS",
        "js-exec /tmp/count.mjs"
      ].join("\n")
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.stdout.trim()).toBe("50")
  }, 120_000)

  /**
   * A busy loop is cut off by the wall clock, not by a command count.
   *
   * (Mutation: dropping `maxCommandCount` and `maxLoopIterations` from the bash limits in
   * `runSessionExec` -> exit 126 "too many commands executed (>100000)" well before the bound, and
   * the case is red on the exit code.)
   */
  it("a bash loop past --timeout-ms is exit 124 with timedOut", async () => {
    const report = await runBash("while true; do :; done", 2_500)
    expect(report.stderr).toContain("exceeded execution deadline (2500ms)")
    expect(report.exitCode).toBe(124)
    expect(report.timedOut).toBe(true)
    expect(report.durationMs).toBeGreaterThanOrEqual(2_500)
    expect(report.ops).toEqual([])
  }, 120_000)

  it("classifies the bash deadline wordings, verbatim from just-bash 3.4.2, as a cut-off", () => {
    expect(cutOffByTheRuntime(124, "bash: execution exceeded execution deadline (1500ms)\n")).toBe(
      true
    )
    expect(cutOffByTheRuntime(124, "bash: sleep exceeded its execution deadline\n")).toBe(true)
    // The shell's own `timeout` builtin exits 124 with nothing on stderr: the script's 124.
    expect(cutOffByTheRuntime(124, "")).toBe(false)
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

describe("a head edit is an op only when it adds or removes links", () => {
  const LINKED = "areas/inbox/linked.html"
  const PLAIN = "areas/inbox/plain.html"
  const TARGET = "areas/inbox/target.html"
  const supports = '<link rel="memhtml-supports" href="/areas/inbox/target.html">'
  const relates = '<link rel="memhtml-relates_to" href="/areas/inbox/target.html">'

  let small: HeadView
  beforeAll(async () => {
    const plain = renderTemplate({
      title: "Plain",
      claim: "The capital of Plainland is Plaintown",
      body: ["No links yet."],
      memoryType: "semantic",
      at: SEEDED_AT
    })
    const target = renderTemplate({
      title: "Target",
      claim: "The capital of Targetland is Targettown",
      memoryType: "semantic",
      at: SEEDED_AT
    })
    const linked = addLink(
      renderTemplate({
        title: "Linked",
        claim: "The capital of Linkland is Linktown",
        memoryType: "semantic",
        at: SEEDED_AT
      }),
      "supports",
      "/areas/inbox/target.html"
    )
    small = viewOver(
      await Effect.runPromise(
        Effect.all([
          recordFrom(PLAIN, plain),
          recordFrom(TARGET, target),
          recordFrom(LINKED, linked)
        ])
      )
    )
  })

  /** A script that rewrites one seeded file through `edit(before)`. */
  const rewrite = (path: string, edit: string): Promise<SessionExecReport> =>
    Effect.runPromise(
      runSessionExec({
        view: small,
        lang: "js",
        script: [
          'import * as fs from "node:fs"',
          `const path = "/mnt/memhtml/${path}"`,
          'const before = fs.readFileSync(path, "utf8")',
          `fs.writeFileSync(path, ${edit})`
        ].join("\n")
      })
    )

  /**
   * (Mutation: dropping the `contentHashOrNull(file.html) === before.contentHash` branch in
   * `harvestOps` reports the edit as a `put` of the same path; observed `expected [ { kind: 'put',
   * ...(2) } ] to deeply equal [ { kind: 'link', ...(3) } ]` here and the two-link case red.)
   */
  it("appending one <link> yields exactly one link op and no put", async () => {
    const report = await rewrite(
      PLAIN,
      `before.replace("</head>", ${JSON.stringify(`${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([
      { kind: "link", path: PLAIN, rel: "supports", href: "/areas/inbox/target.html" }
    ])
    expect(report.rejected).toEqual([])
  }, 120_000)

  it("appending two <link>s yields two link ops in document order", async () => {
    const report = await rewrite(
      PLAIN,
      `before.replace("</head>", ${JSON.stringify(`${supports}\n${relates}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([
      { kind: "link", path: PLAIN, rel: "supports", href: "/areas/inbox/target.html" },
      { kind: "link", path: PLAIN, rel: "relates_to", href: "/areas/inbox/target.html" }
    ])
  }, 120_000)

  /**
   * (Mutation: `removed.map(...)` left out of the `links` result in `headEdit` drops the edit
   * silently; observed `expected [] to deeply equal [ { kind: 'unlink', ...(3) } ]` here and the
   * both-kinds case red.)
   */
  it("removing a <link> yields exactly one unlink op and no rejection", async () => {
    const report = await rewrite(LINKED, `before.replace(${JSON.stringify(supports)}, "")`)
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([
      { kind: "unlink", path: LINKED, rel: "supports", href: "/areas/inbox/target.html" }
    ])
    expect(report.rejected).toEqual([])
  }, 120_000)

  it("removing one <link> and adding another yields a link op then an unlink op", async () => {
    const report = await rewrite(
      LINKED,
      `before.replace(${JSON.stringify(supports)}, ${JSON.stringify(relates)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([
      { kind: "link", path: LINKED, rel: "relates_to", href: "/areas/inbox/target.html" },
      { kind: "unlink", path: LINKED, rel: "supports", href: "/areas/inbox/target.html" }
    ])
    expect(report.rejected).toEqual([])
  }, 120_000)

  /**
   * (Mutation: the `removed link(s)` note left out of `notes` in `headEdit` keeps the rejection but
   * loses the name of the removed link; observed `expected '...: the title changed' to contain
   * 'removed link(s) supports -> /areas/inbox/target.html'`.)
   */
  it("removing a link and changing the title is rejected naming both", async () => {
    const report = await rewrite(
      LINKED,
      `before.replace("<title>Linked</title>", "<title>Renamed</title>").replace(${JSON.stringify(supports)}, "")`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(LINKED)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("removed link(s) supports -> /areas/inbox/target.html")
    expect(rejection?.reason).toContain("the title changed")
  }, 120_000)

  /**
   * (Mutation: dropping the `was.title !== now.title` clause in `headEdit` turns this edit into a
   * link op; observed `expected [ { kind: 'link', ...(3) } ] to deeply equal []`.)
   */
  it("adding a link and changing the title is rejected naming both", async () => {
    const report = await rewrite(
      PLAIN,
      `before.replace("<title>Plain</title>", "<title>Renamed</title>").replace("</head>", ${JSON.stringify(`${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(PLAIN)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("added link(s) supports -> /areas/inbox/target.html")
    expect(rejection?.reason).toContain("the title changed")
  }, 120_000)

  /**
   * (Mutation: the head-edit branch taken for every changed seeded file, hash compared or not, turns
   * this into a link op; observed `expected [ { kind: 'link', ...(3) } ] to deeply equal
   * [ { kind: 'put', ...(2) } ]` on the kinds.)
   */
  it("adding a link and changing the claim is a put, not a link op", async () => {
    const report = await rewrite(
      PLAIN,
      `before.replace("Plaintown", "Elsewhere").replace("</head>", ${JSON.stringify(`${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    expect(report.ops.map((op) => [op.kind, op.path])).toEqual([["put", PLAIN]])
    const [put] = report.ops
    if (put?.kind !== "put") throw new Error("no put")
    expect(contentHash(put.html)).not.toBe(small.get(PLAIN)?.contentHash)
    const doc = await Effect.runPromise(parseMemory(put.html))
    expect(doc.links).toEqual([{ rel: "supports", href: "/areas/inbox/target.html" }])
  }, 120_000)

  /**
   * (Mutation: dropping the `metasOf(was) !== metasOf(now)` clause in `headEdit` loses the name of
   * the change; observed `expected '...: the head changed beyond the edited links' to contain 'a meta
   * changed'`, the residual-head clause catching what the meta clause no longer named.)
   */
  it("adding a link and a meta is rejected naming both", async () => {
    const confidence = '<meta name="memhtml-confidence" content="0.10">'
    const report = await rewrite(
      PLAIN,
      `before.replace("</head>", ${JSON.stringify(`${confidence}\n${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    expect(report.rejected).toHaveLength(1)
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(PLAIN)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("added link(s) supports -> /areas/inbox/target.html")
    expect(rejection?.reason).toContain("a meta changed")
  }, 120_000)

  /**
   * The content hash digests the article's TEXT, so wrapping a word in `<dfn>` keeps the hash and
   * reaches `headEdit`; without the markup comparison the link lands and the `<dfn>` (which would
   * promote a `concept:` entity) is dropped with no report.
   *
   * (Mutation: dropping the `collapseMarkup(was.article.html) !== collapseMarkup(now.article.html)`
   * clause in `headEdit` loses the name of the change; observed `expected '...: the head changed
   * beyond the added links' to contain 'the article markup changed'`.)
   */
  it("adding a link and changing article markup that keeps the words is rejected naming both", async () => {
    const report = await rewrite(
      PLAIN,
      `before.replace("No links yet.", "<dfn>No</dfn> links yet.").replace("</head>", ${JSON.stringify(`${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    expect(report.rejected).toHaveLength(1)
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(PLAIN)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("added link(s) supports -> /areas/inbox/target.html")
    expect(rejection?.reason).toContain("the article markup changed")
  }, 120_000)

  /**
   * Head content the parser accepts and `MemoryDoc` does not surface: a comment beside the link.
   *
   * (Mutation: dropping the `withoutMemhtmlLinks` comparison in `headEdit` turns this edit into a
   * link op and the comment vanishes unreported; observed `expected [ { kind: 'link', ...(3) } ] to
   * deeply equal []`.)
   */
  it("adding a link and a head comment is rejected naming the residual head change", async () => {
    const report = await rewrite(
      PLAIN,
      `before.replace("</head>", ${JSON.stringify(`<!-- note -->\n${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    expect(report.rejected).toHaveLength(1)
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(PLAIN)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("added link(s) supports -> /areas/inbox/target.html")
    expect(rejection?.reason).toContain("the head changed beyond the edited links")
  }, 120_000)

  /**
   * A byte change that added no link and changed nothing `MemoryDoc` names must still be reported:
   * without the fallthrough clause `headEdit` answers `{ links: [] }`, the file appears in neither
   * `ops` nor `rejected`, and the edit disappears from the report.
   *
   * (Mutation: dropping the `added.length === 0 && otherChanges.length === 0` clause in `headEdit`
   * leaves `rejected` empty; observed `expected [] to have a length of 1 but got +0` here and the
   * reindent case red.)
   */
  it("a head comment with no link added is rejected, not dropped", async () => {
    const report = await rewrite(
      PLAIN,
      `before.replace("</head>", ${JSON.stringify("<!-- note -->\n</head>")})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    expect(report.rejected).toHaveLength(1)
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(PLAIN)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("no link added")
  }, 120_000)

  /** A reindent is whitespace the hash ignores and nothing else: it is reported, as a byte change. */
  it("a reindented head with no link added is rejected as a byte change, never a put", async () => {
    const report = await rewrite(PLAIN, 'before.replace("<head>\\n", "<head>\\n  ")')
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    expect(report.rejected.map((entry) => entry.path)).toEqual([PLAIN])
    expect(report.rejected[0]?.reason).toContain("no link added or removed")
  }, 120_000)
})

describe("a head edit adds or removes entity labels the way it adds or removes links", () => {
  const PLAIN = "areas/inbox/plain.html"
  const TARGET = "areas/inbox/target.html"
  const TO = `archive/2026/${PLAIN}`
  const fixture = '<meta name="memhtml-entity" content="system:fixture">'
  const memhtml = '<meta name="memhtml-entity" content="system:memhtml">'
  const supports = '<link rel="memhtml-supports" href="/areas/inbox/target.html">'

  let small: HeadView
  beforeAll(async () => {
    const plain = renderTemplate({
      title: "Plain",
      claim: "The capital of Plainland is Plaintown",
      body: ["One label so far."],
      memoryType: "semantic",
      entities: ["system:fixture"],
      at: SEEDED_AT
    })
    const target = renderTemplate({
      title: "Target",
      claim: "The capital of Targetland is Targettown",
      memoryType: "semantic",
      entities: ["system:fixture"],
      at: SEEDED_AT
    })
    small = viewOver(
      await Effect.runPromise(Effect.all([recordFrom(PLAIN, plain), recordFrom(TARGET, target)]))
    )
  })

  /** A script that rewrites PLAIN through `edit(before)`, or moves it to TO when `archive` is set. */
  const rewrite = (edit: string, archive = false): Promise<SessionExecReport> =>
    Effect.runPromise(
      runSessionExec({
        view: small,
        lang: "js",
        script: [
          'import * as fs from "node:fs"',
          'const root = "/mnt/memhtml"',
          `const before = fs.readFileSync(root + "/${PLAIN}", "utf8")`,
          ...(archive
            ? [
                'fs.mkdirSync(root + "/archive/2026/areas/inbox", { recursive: true })',
                `fs.writeFileSync(root + "/${TO}", ${edit})`,
                `fs.unlinkSync(root + "/${PLAIN}")`
              ]
            : [`fs.writeFileSync(root + "/${PLAIN}", ${edit})`])
        ].join("\n")
      })
    )

  /**
   * (Mutations, each observed red here: `labeled.map(...)` left out of the `ops` result in
   * `headEdit` drops the edit silently, `expected [] to deeply equal [ { kind: 'label', ...(2) } ]`;
   * `doc.entities` put back into `metasOf` rejects it as "a meta changed"; the
   * `MEMHTML_ENTITY_ELEMENT` strip left out of `withoutHeadOps` rejects it as "the head changed
   * beyond the edited links and entities".)
   */
  it("appending one memhtml-entity meta yields exactly one label op and no put", async () => {
    const report = await rewrite(
      `before.replace(${JSON.stringify(fixture)}, ${JSON.stringify(`${fixture}\n${memhtml}`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    expect(report.ops).toEqual([{ kind: "label", path: PLAIN, entity: "system:memhtml" }])
  }, 120_000)

  /**
   * (Mutation: `unlabeled.map(...)` left out of the `ops` result in `headEdit`; observed
   * `expected [] to deeply equal [ { kind: 'unlabel', ...(2) } ]`.)
   */
  it("removing a memhtml-entity meta yields exactly one unlabel op and no rejection", async () => {
    const report = await rewrite(`before.replace(${JSON.stringify(`${fixture}\n`)}, "")`)
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    expect(report.ops).toEqual([{ kind: "unlabel", path: PLAIN, entity: "system:fixture" }])
  }, 120_000)

  it("swapping one entity for another beside a new link yields the link, the label, then the unlabel", async () => {
    const report = await rewrite(
      `before.replace(${JSON.stringify(fixture)}, ${JSON.stringify(memhtml)}).replace("</head>", ${JSON.stringify(`${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    expect(report.ops).toEqual([
      { kind: "link", path: PLAIN, rel: "supports", href: "/areas/inbox/target.html" },
      { kind: "label", path: PLAIN, entity: "system:memhtml" },
      { kind: "unlabel", path: PLAIN, entity: "system:fixture" }
    ])
  }, 120_000)

  /**
   * (Mutation: the `added entity label(s)` note left out of `notes` in `headEdit` keeps the
   * rejection but loses the name of the label; observed `expected '...: the title changed' to
   * contain 'added entity label(s) system:memhtml'`.)
   */
  it("adding an entity and changing the title is rejected naming both", async () => {
    const report = await rewrite(
      `before.replace("<title>Plain</title>", "<title>Renamed</title>").replace(${JSON.stringify(fixture)}, ${JSON.stringify(`${fixture}\n${memhtml}`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(PLAIN)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("added entity label(s) system:memhtml")
    expect(rejection?.reason).toContain("the title changed")
  }, 120_000)

  it("adding an entity and a head comment is rejected naming the residual head change", async () => {
    const report = await rewrite(
      `before.replace(${JSON.stringify(fixture)}, ${JSON.stringify(`${fixture}\n${memhtml}\n<!-- note -->`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops).toEqual([])
    const [rejection] = report.rejected
    expect(rejection?.reason).toContain("added entity label(s) system:memhtml")
    expect(rejection?.reason).toContain("the head changed beyond the edited links and entities")
  }, 120_000)

  /**
   * (Mutation: the twin branch's `headOps.push(...)` left out of `harvestOps` emits the archive
   * alone and the label is lost; observed `expected [ { kind: 'archive', ...(3) } ] to deeply equal
   * [ { kind: 'label', ...(2) }, ...(1) ]`.)
   */
  it("an entity added to the twin's head is a label op on the source, then the archive", async () => {
    const report = await rewrite(
      `before.replace(${JSON.stringify(fixture)}, ${JSON.stringify(`${fixture}\n${memhtml}`)})`,
      true
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    const twinHtml = (small.get(PLAIN)?.html ?? "").replace(fixture, `${fixture}\n${memhtml}`)
    expect(report.ops).toEqual([
      { kind: "label", path: PLAIN, entity: "system:memhtml" },
      { kind: "archive", path: PLAIN, to: TO, html: twinHtml }
    ])
  }, 120_000)
})

describe("an archive twin's head is held to the same rule as a file that stays put", () => {
  const PLAIN = "areas/inbox/plain.html"
  const TO = `archive/2026/${PLAIN}`
  const supports = '<link rel="memhtml-supports" href="/areas/inbox/target.html">'

  let small: HeadView
  beforeAll(async () => {
    const plain = renderTemplate({
      title: "Plain",
      claim: "The capital of Plainland is Plaintown",
      body: ["No links yet."],
      memoryType: "semantic",
      at: SEEDED_AT
    })
    const target = renderTemplate({
      title: "Target",
      claim: "The capital of Targetland is Targettown",
      memoryType: "semantic",
      at: SEEDED_AT
    })
    small = viewOver(
      await Effect.runPromise(
        Effect.all([recordFrom(PLAIN, plain), recordFrom("areas/inbox/target.html", target)])
      )
    )
  })

  /** Copy PLAIN to its archive path through `edit(before)`, then remove the source. */
  const archiveWith = (edit: string): Promise<SessionExecReport> =>
    Effect.runPromise(
      runSessionExec({
        view: small,
        lang: "js",
        script: [
          'import * as fs from "node:fs"',
          'const root = "/mnt/memhtml"',
          `const before = fs.readFileSync(root + "/${PLAIN}", "utf8")`,
          'fs.mkdirSync(root + "/archive/2026/areas/inbox", { recursive: true })',
          `fs.writeFileSync(root + "/${TO}", ${edit})`,
          `fs.unlinkSync(root + "/${PLAIN}")`
        ].join("\n")
      })
    )

  /**
   * The link travels: a `link` op on the SOURCE path precedes the archive, so `commitSession`'s
   * staging (which builds the destination from the source as the batch left it, never from
   * `op.html`) carries the edge into the archived copy.
   *
   * (Mutation: dropping the `headEdit(source, before.html, twinHtml)` call in the twin branch of
   * `harvestOps` emits the archive alone and the link is silently lost; observed `expected
   * [ { kind: 'archive', ...(3) } ] to deeply equal [ { kind: 'link', ...(3) }, ...(1) ]` here and
   * the retitled-twin case red.)
   */
  it("a link added to the twin's head is a link op on the source, then the archive", async () => {
    const report = await archiveWith(
      `before.replace("</head>", ${JSON.stringify(`${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    const twinHtml = (small.get(PLAIN)?.html ?? "").replace("</head>", `${supports}\n</head>`)
    expect(report.ops).toEqual([
      { kind: "link", path: PLAIN, rel: "supports", href: "/areas/inbox/target.html" },
      { kind: "archive", path: PLAIN, to: TO, html: twinHtml }
    ])
  }, 120_000)

  /**
   * (Mutation: the twin branch emits the archive whatever `headEdit` answers; observed `expected
   * [ [ 'archive', ...(1) ] ] to deeply equal [ [ 'put', ...(1) ] ]`.)
   */
  it("a twin whose head changed beyond added links rejects the source and leaves the twin a put", async () => {
    const report = await archiveWith(
      `before.replace("<title>Plain</title>", "<title>Renamed</title>").replace("</head>", ${JSON.stringify(`${supports}\n</head>`)})`
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.ops.map((op) => [op.kind, op.path])).toEqual([["put", TO]])
    expect(report.rejected).toHaveLength(1)
    const [rejection] = report.rejected
    expect(rejection?.path).toBe(PLAIN)
    expect(rejection?.reason).toContain(`vanished, and ${TO} holds this article`)
    expect(rejection?.reason).toContain(HEAD_EDIT_REASON)
    expect(rejection?.reason).toContain("added link(s) supports -> /areas/inbox/target.html")
    expect(rejection?.reason).toContain("the title changed")
  }, 120_000)

  it("a link removed from the twin's head is an unlink op on the source, then the archive", async () => {
    const dangling = '<link rel="memhtml-relates-to" href="/areas/inbox/gone.html">'
    const carrying = viewOver(
      await Effect.runPromise(
        Effect.all([
          recordFrom(
            PLAIN,
            (small.get(PLAIN)?.html ?? "").replace("</head>", `${dangling}\n</head>`)
          ),
          recordFrom("areas/inbox/target.html", small.get("areas/inbox/target.html")?.html ?? "")
        ])
      )
    )
    const report = await Effect.runPromise(
      runSessionExec({
        view: carrying,
        lang: "js",
        script: [
          'import * as fs from "node:fs"',
          'const root = "/mnt/memhtml"',
          `const before = fs.readFileSync(root + "/${PLAIN}", "utf8")`,
          'fs.mkdirSync(root + "/archive/2026/areas/inbox", { recursive: true })',
          `fs.writeFileSync(root + "/${TO}", before.replace(${JSON.stringify(dangling)}, ""))`,
          `fs.unlinkSync(root + "/${PLAIN}")`
        ].join("\n")
      })
    )
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    const twinHtml = (carrying.get(PLAIN)?.html ?? "").replace(dangling, "")
    expect(report.ops).toEqual([
      { kind: "unlink", path: PLAIN, rel: "relates_to", href: "/areas/inbox/gone.html" },
      { kind: "archive", path: PLAIN, to: TO, html: twinHtml }
    ])
  }, 120_000)

  it("a verbatim copy is one archive op and nothing else", async () => {
    const report = await archiveWith("before")
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.rejected).toEqual([])
    expect(report.ops).toEqual([
      { kind: "archive", path: PLAIN, to: TO, html: small.get(PLAIN)?.html ?? "" }
    ])
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

  it("a move over an earlier archived copy of the same path pairs as an archive", () => {
    // A record archived once, recreated at its path, and moved onto its old archive slot (the 64
    // people stubs on the live store, 2026-09-28). Mutation: the `reclaimsSlot` guard forced to
    // `false` -> the slot whose older copy shares the source's article is read as a head edit of
    // that copy, and its source is rejected as vanished.
    const record = (claim: string): string =>
      renderTemplate({ title: "Stub", claim, memoryType: "semantic", at: "2026-09-26T00:00:00Z" })
    const archivedCopy = (html: string): string =>
      html.replace('content="active"', 'content="archived"')
    const words = record("Alain Krok appears in this agent's memory.")
    const other = record("Clare Liguori appears in this agent's memory.")
    const files: ReadonlyArray<readonly [string, string]> = [
      ["resources/people/alain-krok.html", words],
      ["resources/people/clare-liguori.html", other],
      // Older words at the first slot, the same article under an archived head at the second.
      [
        "archive/2026/resources/people/alain-krok.html",
        archivedCopy(record("alain krok appears in this agent's memory."))
      ],
      ["archive/2026/resources/people/clare-liguori.html", archivedCopy(other)]
    ]
    const seeded = new Map(
      files.map(([path, html]) => [path, { html, contentHash: contentHash(html) }] as const)
    )
    const after = [
      { path: "archive/2026/resources/people/alain-krok.html", html: words },
      { path: "archive/2026/resources/people/clare-liguori.html", html: other }
    ]
    expect(harvestOps({ seeded, after, skippedGitDir: false, scope: "curate" })).toEqual({
      ops: [
        {
          kind: "archive",
          path: "resources/people/alain-krok.html",
          to: "archive/2026/resources/people/alain-krok.html",
          html: words
        },
        {
          kind: "archive",
          path: "resources/people/clare-liguori.html",
          to: "archive/2026/resources/people/clare-liguori.html",
          html: other
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

    // Under the curator's scope the arcs and people paths are puts; `.memhtml/` stays refused.
    // (Mutation: `presentFileProblem` calls `isReservedPath(path)` without the scope -> the two
    // curation paths stay rejected here and the case is red.)
    const curated = harvestOps({ seeded: seededSet, after, skippedGitDir: false, scope: "curate" })
    expect(curated.ops.map((op) => op.path)).toEqual([
      "areas/arcs/arc.html",
      "areas/inbox/good.html",
      "resources/people/someone.html"
    ])
    expect(curated.rejected.map((entry) => entry.path)).toEqual([
      ".memhtml/smuggled.html",
      "README.html"
    ])
    expect(curated.rejected[0]?.reason).toBe("a reserved path no session writes")
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

/**
 * A file gone from its path whose article now sits at exactly one new live path is a `move`, the
 * placement op; a deletion is still no op at all.
 *
 * (Mutation 2026-09-30: `landed?.length === 1` -> `landed !== undefined` in `harvestOps` -> "two new
 * copies of one article pair with nothing" is red: the first copy is taken as the move.)
 * (Mutation 2026-09-30: the move branch's `headEdit` result ignored, `edit = null` -> "a moved copy
 * that gained a link carries it as a link op on the source, staged before the move" is red.)
 */
describe("harvestOps pairs a moved file", () => {
  const FROM = "areas/inbox/moved-fact.html"
  const TO = "resources/moves/moved-fact.html"
  const html = renderTemplate({
    title: "Moved fact",
    claim: "A moved record keeps its article and its bytes.",
    memoryType: "semantic",
    at: SEEDED_AT,
    entities: ["system:fixture"]
  })
  const seeded = new Map([[FROM, { html, contentHash: contentHash(html) }]])

  it("a file copied unchanged to one new live path and removed is one move op", () => {
    expect(harvestOps({ seeded, after: [{ path: TO, html }], skippedGitDir: false })).toEqual({
      ops: [{ kind: "move", path: FROM, to: TO, html }],
      rejected: []
    })
  })

  it("a moved copy that gained a link carries it as a link op on the source, staged before the move", () => {
    const linked = addLink(html, "relates_to", "/areas/inbox/other.html")
    expect(
      harvestOps({ seeded, after: [{ path: TO, html: linked }], skippedGitDir: false }).ops
    ).toEqual([
      { kind: "link", path: FROM, rel: "relates_to", href: "/areas/inbox/other.html" },
      { kind: "move", path: FROM, to: TO, html: linked }
    ])
  })

  it("two new copies of one article pair with nothing, and a removal with no copy is refused", () => {
    const twice = harvestOps({
      seeded,
      after: [
        { path: TO, html },
        { path: "resources/elsewhere/moved-fact.html", html }
      ],
      skippedGitDir: false
    })
    expect(twice.ops.map((op) => op.kind)).toEqual(["put", "put"])
    expect(twice.rejected).toEqual([
      { path: FROM, reason: "vanished with no archive twin; deletion is not an operation" }
    ])
    expect(harvestOps({ seeded, after: [], skippedGitDir: false }).rejected).toEqual([
      { path: FROM, reason: "vanished with no archive twin; deletion is not an operation" }
    ])
  })

  it("an archive twin wins over a live copy, so archiving never reads as a move", () => {
    const twin = `archive/2026/${FROM}`
    const report = harvestOps({
      seeded,
      after: [
        { path: twin, html },
        { path: TO, html }
      ],
      skippedGitDir: false
    })
    expect(report.ops).toEqual([
      { kind: "put", path: TO, html },
      { kind: "archive", path: FROM, to: twin, html }
    ])
  })
})
