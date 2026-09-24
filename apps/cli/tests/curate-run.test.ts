import { createHash } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { CURATOR_MODEL_VAR } from "@memhtml/curator"
import { frameKeyOf } from "@memhtml/domain"
import { contentHash, parseMemory, renderTemplate } from "@memhtml/html"
import { PROXY_BASE_URL_VAR } from "@memhtml/llm"
import { validateOps } from "@memhtml/session"
import { makeGit } from "@memhtml/store"
import { configureIdentity } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  bindTools,
  commitSummary,
  curateRefProblem,
  curateRun,
  curateSessionId,
  defaultCurateRef,
  memoryOverlay
} from "../src/curate-run.js"
import { EXIT_RUNTIME, EXIT_USAGE } from "../src/envelope.js"
import { parseArgv, run, validate } from "../src/run.js"
import { type LoadedHead, revParse } from "../src/v2.js"

/**
 * The usage guards `memhtml curate run` adds (`docs/v2-poc.md`, "Curator"). Every exit-2 case here
 * is decided before a repo opens; the one exit-1 case (`--resume` over a missing session) reaches the
 * session package and is a storage refusal, not a usage error, because the call was well-formed and
 * the thing it named is absent.
 *
 * Mutations, each run once with the change applied and the named case red (2026-09-23):
 * - `run.ts` `validateAgainst`: `curateRunFlags` result replaced with `undefined` -> "a --model
 *   outside the three shapes is refused" and "a non-positive budget is refused".
 * - `run.ts` v2 branch: default the spec to `"fake"` when nothing names a model -> "with no --model,
 *   no variable, and no proxy the call is refused naming the flag".
 * - `curate-run.ts` `curateRun`: `--resume` starts a new session in place of `resumeSession` ->
 *   "--resume over a missing session is exit 1 with ERR_STORAGE".
 * - `run.ts` `curateRunFlags`: the `--ref` check removed -> "a --ref outside curate/ is refused at
 *   exit 2 and main does not move" (the argv-level case answers `undefined`; the `run` case falls
 *   through to `curateRun`'s own refusal at exit 1, which is why both layers are asserted).
 * - `curate-run.ts` `curateRun`: the `curateRefProblem` refusal removed -> "curateRun itself refuses
 *   a ref outside curate/" (the fake lands `no-ops` on `refs/heads/main` and a session log appears).
 * - `curate-run.ts` `curateRun`: the `headRefOf` comparison removed -> "curateRun refuses the branch
 *   HEAD points at" (a session opens on the checked-out curate branch).
 * - `curate-run.ts` `bindTools` `judge`: `blocking` narrowed back to `format | reserved-path |
 *   batch-cap` -> "exec refuses a harvest carrying a claim-edit" (`appended` is 1 and the overlay
 *   holds an op `validateOps` refuses).
 * - `curate-run.ts` `CURATE_SCOPE` set to `"session"` -> "exec harvests an arcs put and a head link
 *   splice under the curator's scope" (the arcs file is rejected as a reserved path, `appended` is 1).
 * - `curate-run.ts` `curateRun`: the `modelError` branch made unreachable -> "a model the run cannot
 *   reach is exit 1 with ERR_MODEL_UNAVAILABLE" (the run answers exit 0 with `no-ops`). The case
 *   takes about six seconds: the AI SDK retries a refused connection twice with backoff before the
 *   loop sees the failure.
 */

const parse = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** A real, committed git repo with no memories, so a session command has a version to see. */
const repo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-curate-run-"))
  roots.push(root)
  const git = makeGit(root)
  await Effect.runPromise(git.run(["init", "-b", "main", "."]).pipe(Effect.orDie))
  await Effect.runPromise(configureIdentity(git))
  await Effect.runPromise(
    git.run(["commit", "--allow-empty", "-q", "-m", "empty"]).pipe(Effect.orDie)
  )
  return root
}

const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const name of [CURATOR_MODEL_VAR, PROXY_BASE_URL_VAR]) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
})
afterEach(() => {
  for (const name of [CURATOR_MODEL_VAR, PROXY_BASE_URL_VAR]) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe("curate run's flags", () => {
  it("a --model outside the three shapes is refused", () => {
    for (const model of ["gpt", "bedrock:", "proxy:", "openai:x", "Fake"]) {
      const failure = validate(parseArgv(["curate", "run", "--model", model]))
      expect(failure?.code, model).toBe("ERR_INVALID_FLAG")
      expect(failure?.error, model).toContain("--model")
      expect(failure?.suggestions[0], model).toBe("memhtml curate run --model fake")
    }
  })

  it("accepts each of the three shapes", () => {
    for (const model of ["fake", "bedrock:global.anthropic.claude-opus-5", "proxy:opus"]) {
      expect(validate(parseArgv(["curate", "run", "--model", model])), model).toBeUndefined()
    }
  })

  it("a non-positive budget is refused", () => {
    for (const flag of ["max-steps", "wall-clock-ms"]) {
      for (const value of ["0", "-3", "soon"]) {
        const failure = validate(
          parseArgv(["curate", "run", "--model", "fake", `--${flag}`, value])
        )
        expect(failure?.code, `${flag} ${value}`).toBe("ERR_INVALID_FLAG")
        expect(failure?.error, `${flag} ${value}`).toContain(`--${flag}`)
      }
      expect(validate(parseArgv(["curate", "run", "--model", "fake", `--${flag}`, "5"]))).toBe(
        undefined
      )
    }
  })

  it("with no --model, no variable, and no proxy the call is refused naming the flag", async () => {
    const root = await repo()
    const result = await run(["curate", "run", "--repo", root])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_MISSING_ARGUMENT")
    expect(body.error).toContain("--model")
    expect(body.error).toContain(CURATOR_MODEL_VAR)
  })

  it("a proxy spec with no proxy configured is refused naming the variable", async () => {
    const root = await repo()
    const result = await run(["curate", "run", "--model", "proxy:opus", "--repo", root])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain(PROXY_BASE_URL_VAR)
  })

  it("a malformed MEMHTML_CURATOR_MODEL is refused naming the variable", async () => {
    process.env[CURATOR_MODEL_VAR] = "nonsense"
    const root = await repo()
    const result = await run(["curate", "run", "--repo", root])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain(CURATOR_MODEL_VAR)
  })

  it("a --ref outside curate/ is refused at exit 2 and main does not move", async () => {
    for (const ref of [
      "main",
      "refs/heads/main",
      "feature/x",
      "refs/tags/curate/2026-09-23",
      "curate/"
    ]) {
      const failure = validate(parseArgv(["curate", "run", "--model", "fake", "--ref", ref]))
      expect(failure?.code, ref).toBe("ERR_INVALID_FLAG")
      expect(failure?.error, ref).toContain("--ref")
      expect(failure?.error, ref).toContain("refs/heads/curate/")
    }
    for (const ref of ["curate/2026-09-23", "refs/heads/curate/2026-09-23"]) {
      expect(validate(parseArgv(["curate", "run", "--model", "fake", "--ref", ref])), ref).toBe(
        undefined
      )
    }
    expect(curateRefProblem("main")).toContain("refs/heads/main is not under refs/heads/curate/")
    expect(curateRefProblem("curate/2026-09-23")).toBeUndefined()

    const root = await repo()
    const git = makeGit(root)
    const main = await Effect.runPromise(git.run(["rev-parse", "refs/heads/main"]))
    for (const ref of ["main", "refs/heads/main"]) {
      const result = await run(["curate", "run", "--model", "fake", "--ref", ref, "--repo", root])
      expect(result.exitCode, ref).toBe(EXIT_USAGE)
      expect(parse(result.stdout).code, ref).toBe("ERR_INVALID_FLAG")
    }
    expect(await Effect.runPromise(git.run(["rev-parse", "refs/heads/main"]))).toBe(main)
    expect(await sessionLogs(root)).toBe(false)
  })

  it("curateRun itself refuses a ref outside curate/, so a caller that skips the CLI cannot land on main", async () => {
    const root = await repo()
    const git = makeGit(root)
    const main = await Effect.runPromise(git.run(["rev-parse", "refs/heads/main"]))
    for (const ref of ["main", "refs/heads/main", "feature/x"]) {
      const result = await Effect.runPromise(
        Effect.result(curateRun({ root, model: "fake", ref, dryRun: false, resume: false }))
      )
      expect(result._tag, ref).toBe("Failure")
      if (result._tag !== "Failure") continue
      expect(result.failure._tag, ref).toBe("InvalidMemory")
      if (result.failure._tag === "InvalidMemory") {
        expect(result.failure.reason, ref).toContain("refs/heads/curate/")
      }
    }
    expect(await Effect.runPromise(git.run(["rev-parse", "refs/heads/main"]))).toBe(main)
    expect(await sessionLogs(root)).toBe(false)
  })

  it("curateRun refuses the branch HEAD points at, even under curate/", async () => {
    const root = await repo()
    const git = makeGit(root)
    await Effect.runPromise(git.run(["checkout", "-q", "-b", "curate/2026-09-23"]))
    const result = await Effect.runPromise(
      Effect.result(
        curateRun({ root, model: "fake", ref: "curate/2026-09-23", dryRun: false, resume: false })
      )
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure" && result.failure._tag === "InvalidMemory") {
      expect(result.failure.reason).toContain("checked out")
    } else {
      expect.fail(`expected an InvalidMemory refusal, got ${JSON.stringify(result)}`)
    }
    expect(await sessionLogs(root)).toBe(false)
    // The same ref is fine once HEAD is elsewhere: the run finds nothing to do and opens a session.
    await Effect.runPromise(git.run(["checkout", "-q", "main"]))
    const report = await Effect.runPromise(
      curateRun({ root, model: "fake", ref: "curate/2026-09-23", dryRun: false, resume: false })
    )
    expect(report.outcome).toBe("no-ops")
  })

  it("a model the run cannot reach is exit 1 with ERR_MODEL_UNAVAILABLE and the session kept for --resume", async () => {
    // Port 1 on the loopback refuses every connection, so the proxy path fails at the first call
    // with no network reached; the loop reports modelError and the binder turns it into the
    // ERR_MODEL_UNAVAILABLE envelope, leaving the (empty) session log for a later --resume.
    process.env[PROXY_BASE_URL_VAR] = "http://127.0.0.1:1"
    const root = await repo()
    const result = await run([
      "curate",
      "run",
      "--model",
      "proxy:unreachable",
      "--ref",
      "curate/model-error",
      "--repo",
      root
    ])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_MODEL_UNAVAILABLE")
    expect(String(body.error)).toContain("--resume")
    expect(await sessionLogs(root)).toBe(true)
    expect(await Effect.runPromise(revParse(root, "refs/heads/curate/model-error"))).toBeNull()
  }, 60_000)

  it("--resume over a missing session is exit 1 with ERR_STORAGE", async () => {
    const root = await repo()
    const result = await run([
      "curate",
      "run",
      "--model",
      "fake",
      "--resume",
      "--ref",
      "curate/absent",
      "--repo",
      root
    ])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_STORAGE")
    expect(String(body.error)).toContain("session")
  })
})

/** True when the repo holds any session log, which a refused run must never leave behind. */
const sessionLogs = (root: string): Promise<boolean> =>
  access(join(root, ".memhtml", "sessions")).then(
    () => true,
    () => false
  )

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

const VIEW_SHA = "0000000000000000000000000000000000000abc"

/** A `LoadedHead` over a `Map`, the way `session-exec.test.ts` builds a view: no git anywhere. */
const headOver = (records: ReadonlyArray<MemoryRecord>): LoadedHead => {
  const byPath = new Map(records.map((record) => [record.path, record]))
  const active = records.filter((record) => !record.archived)
  const view: HeadView & { readonly sha: string } = {
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
  return {
    view,
    sha: VIEW_SHA,
    records: byPath.size,
    skipped: 0,
    loadMs: 0,
    source: "git",
    snapshotPath: null
  }
}

describe("the exec tool refuses what the commit would refuse", () => {
  const EDITED = "areas/inbox/x.html"
  const ARCHIVED = "areas/inbox/y.html"
  const YEAR = String(new Date().getUTCFullYear())
  const memory = (path: string, claim: string, body: string): Effect.Effect<MemoryRecord> =>
    recordFrom(
      path,
      renderTemplate({
        title: path,
        claim,
        body: [body],
        memoryType: "semantic",
        at: "2026-09-20T00:00:00Z"
      })
    )

  it("exec refuses a harvest carrying a claim-edit, so the session stays landable", async () => {
    const records = await Effect.runPromise(
      Effect.all([
        memory(EDITED, "The capital of Newland is Newtown.", "Body one."),
        memory(ARCHIVED, "The capital of Otherland is Othertown.", "Body two.")
      ])
    )
    const head = headOver(records)
    const overlay = memoryOverlay()
    const tools = bindTools({ head, overlay, ref: "refs/heads/curate/2026-09-23" })

    // The natural move for the charter's placement and entity-resolution priorities: rewrite an
    // active record in place. The harvester reports it as a `put` of the same path.
    const edit = await tools.exec(
      [
        'import * as fs from "node:fs"',
        `const path = "/mnt/memhtml/${EDITED}"`,
        'const before = fs.readFileSync(path, "utf8")',
        'fs.writeFileSync(path, before.replace("Body one.", "Body one, now with a note."))'
      ].join("\n")
    )
    expect(edit.exitCode).toBe(0)
    expect(edit.ops).toEqual([{ kind: "put", path: EDITED }])
    expect(edit.violations).toEqual([{ kind: "claim-edit", path: EDITED }])
    expect(edit.appended).toBe(0)
    expect(overlay.ops()).toEqual([])

    // The control: an archive done the store's way carries no violation and is appended, and the
    // overlay it leaves is one `commitSession` would accept.
    const archive = await tools.exec(
      [
        'import * as fs from "node:fs"',
        'const root = "/mnt/memhtml"',
        `const from = "${ARCHIVED}"`,
        `const to = "archive/${YEAR}/${ARCHIVED}"`,
        'fs.mkdirSync(root + "/" + to.slice(0, to.lastIndexOf("/")), { recursive: true })',
        'fs.writeFileSync(root + "/" + to, fs.readFileSync(root + "/" + from, "utf8"))',
        'fs.unlinkSync(root + "/" + from)'
      ].join("\n")
    )
    expect(archive.exitCode).toBe(0)
    expect(archive.violations).toEqual([])
    expect(archive.appended).toBe(1)
    expect(overlay.ops().map((op) => op.kind)).toEqual(["archive"])
    expect(validateOps(head.view, overlay.ops())).toEqual([])
  }, 120_000)

  it("exec harvests an arcs put and a head link splice under the curator's scope", async () => {
    const records = await Effect.runPromise(
      Effect.all([
        memory(EDITED, "The capital of Newland is Newtown.", "Body one."),
        memory(ARCHIVED, "The capital of Otherland is Othertown.", "Body two.")
      ])
    )
    const head = headOver(records)
    const overlay = memoryOverlay()
    const tools = bindTools({ head, overlay, ref: "refs/heads/curate/2026-09-23" })
    const arc = renderTemplate({
      title: "Arc",
      claim: "Newland and Otherland both name their capital after the land.",
      body: ["Two capitals, one naming rule."],
      memoryType: "semantic",
      at: "2026-09-20T00:00:00Z"
    })
    const link = `<link rel="memhtml-part_of" href="/areas/arcs/naming.html">`
    const result = await tools.exec(
      [
        'import * as fs from "node:fs"',
        'const root = "/mnt/memhtml"',
        'fs.mkdirSync(root + "/areas/arcs", { recursive: true })',
        `fs.writeFileSync(root + "/areas/arcs/naming.html", ${JSON.stringify(arc)})`,
        `const path = root + "/${EDITED}"`,
        'const before = fs.readFileSync(path, "utf8")',
        `fs.writeFileSync(path, before.replace("</head>", ${JSON.stringify(`${link}\n</head>`)}))`
      ].join("\n")
    )
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.rejected).toEqual([])
    expect(result.violations).toEqual([])
    expect(result.ops).toEqual([
      { kind: "put", path: "areas/arcs/naming.html" },
      { kind: "link", path: EDITED }
    ])
    expect(result.appended).toBe(2)
    expect(overlay.ops()).toEqual([
      { kind: "put", path: "areas/arcs/naming.html", html: arc },
      { kind: "link", path: EDITED, rel: "part_of", href: "/areas/arcs/naming.html" }
    ])
    expect(await tools.status()).toEqual({
      baseSha: VIEW_SHA,
      ref: "refs/heads/curate/2026-09-23",
      ops: { put: 1, archive: 0, link: 1, unlink: 0 }
    })
    // The same overlay is what the landing validates, under the same scope.
    expect(validateOps(head.view, overlay.ops(), { scope: "curate" })).toEqual([])
    expect(validateOps(head.view, overlay.ops())).toEqual([
      { kind: "reserved-path", path: "areas/arcs/naming.html" }
    ])
  }, 120_000)
})

describe("the exec tool harvests a cut link as an unlink", () => {
  const SOURCE = "areas/inbox/source.html"
  const TARGET = "areas/inbox/target.html"
  const dangling = '<link rel="memhtml-relates-to" href="/areas/inbox/gone.html">'
  const kept = '<link rel="memhtml-supports" href="/areas/inbox/target.html">'

  it("cutting a dangling <link> line is one unlink op, appended, and the overlay commits clean", async () => {
    const records = await Effect.runPromise(
      Effect.all([
        recordFrom(
          SOURCE,
          renderTemplate({
            title: "Source",
            claim: "The capital of Sourceland is Sourcetown.",
            memoryType: "semantic",
            at: "2026-09-20T00:00:00Z"
          }).replace("</head>", `${dangling}\n${kept}\n</head>`)
        ),
        recordFrom(
          TARGET,
          renderTemplate({
            title: "Target",
            claim: "The capital of Targetland is Targettown.",
            memoryType: "semantic",
            at: "2026-09-20T00:00:00Z"
          })
        )
      ])
    )
    const head = headOver(records)
    const overlay = memoryOverlay()
    const tools = bindTools({ head, overlay, ref: "refs/heads/curate/2026-09-23" })
    const result = await tools.exec(
      [
        'import * as fs from "node:fs"',
        `const path = "/mnt/memhtml/${SOURCE}"`,
        'const before = fs.readFileSync(path, "utf8")',
        `fs.writeFileSync(path, before.replace(${JSON.stringify(`${dangling}\n`)}, ""))`
      ].join("\n")
    )
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.rejected).toEqual([])
    expect(result.violations).toEqual([])
    expect(result.ops).toEqual([{ kind: "unlink", path: SOURCE }])
    expect(result.appended).toBe(1)
    expect(overlay.ops()).toEqual([
      { kind: "unlink", path: SOURCE, rel: "relates_to", href: "/areas/inbox/gone.html" }
    ])
    expect(await tools.status()).toMatchObject({ ops: { put: 0, archive: 0, link: 0, unlink: 1 } })
    expect(validateOps(head.view, overlay.ops(), { scope: "curate" })).toEqual([])
    // The view the next tool call sees has the edge gone and the other one kept.
    const after = await tools.read(SOURCE)
    expect(after?.links).toEqual([{ rel: "supports", href: "/areas/inbox/target.html" }])
    // A second cut of the same edge is refused, not appended: the edge is no longer there.
    const again = await tools.propose([
      { kind: "unlink", path: SOURCE, rel: "relates_to", href: "/areas/inbox/gone.html" }
    ])
    expect(again.appended).toBe(0)
    expect(again.violations).toEqual([
      {
        kind: "format",
        path: SOURCE,
        reasons: ["unlink names an edge the source does not carry"]
      }
    ])
  }, 120_000)
})

describe("the ref and the subject", () => {
  it("defaults the ref to curate/<UTC date> and derives a one-segment session id", () => {
    expect(defaultCurateRef(new Date("2026-09-23T23:59:59Z"))).toBe("curate/2026-09-23")
    expect(curateSessionId("curate/2026-09-23")).toBe("curate-2026-09-23")
    expect(curateSessionId("refs/heads/curate/2026-09-23")).toBe("curate-2026-09-23")
  })

  it("takes the report's first non-blank line as the subject", () => {
    expect(commitSummary("\n\n  Archived two.  \nmore")).toBe("Archived two.")
    expect(commitSummary("   ")).toBe("curator run")
  })
})
