import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { MemoryRecord } from "@memhtml/contracts"
import { advanceHead, type HeadVersion, loadHead } from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import {
  appendOps,
  type CommitOutcome,
  commitSession,
  rebaseSession,
  type Session,
  saveSession,
  startSession
} from "@memhtml/session"
import { type GitShape, makeGit } from "@memhtml/store"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"

/**
 * The v2 proof of concept end to end (`docs/v2-poc.md`, "Integration test (integrator)"): a
 * 300-memory fixture, eight sessions started concurrently on one version, each committing three
 * disjoint files through the rebase-and-retry loop, and the head advanced through every resulting
 * commit with structural sharing. Then the four conflict cases from the session suite, driven through
 * the CLI envelopes rather than the package API, so what is asserted is what an agent sees.
 *
 * **The fixture is written to the tree and committed with porcelain**, not applied through the CLI:
 * `memhtml apply` would also index 300 files into SQLite, and nothing here reads the index. The head
 * is loaded from that commit through the real `@memhtml/head` over the real git repository.
 *
 * **Every count below is derived independently of the code under test**: commits by `rev-list`,
 * paths by `ls-tree`, the eight shas by walking `rev-list --reverse`. The structural-sharing claim is
 * `toBe` on record objects across versions, which a deep-equal rebuild would pass and a rebuild is the
 * thing the claim rules out.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `v2.ts` `sessionPut`: `if (blocking.length > 0)` -> `if (false)` -> "session put refuses a
 *   reserved path and appends nothing".
 * - `v2.ts` `sessionExec`: `const clean = report.exitCode === 0` -> `const clean = true` -> "session
 *   exec appends the harvest only when the script exited 0".
 */

const SESSIONS = 8
const PUTS_PER_SESSION = 3
const FIXTURE_SIZE = 300
const RETRY_BOUND = 16
const AT = "2026-09-20T12:00:00Z"

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

/** One fixture memory, deterministic in `index`. Distinct claims, so no two share a content hash. */
const fixtureMemory = (index: number): { readonly path: string; readonly html: string } => ({
  path: `areas/inbox/fixture-${String(index).padStart(3, "0")}.html`,
  html: renderTemplate({
    title: `Fixture ${index}`,
    claim: `Fixture fact ${index} names region ${index % 7}.`,
    body: [`Region ${index % 7} trades through port ${index % 11} and grows crop ${index % 5}.`],
    memoryType: "semantic",
    at: AT,
    tags: [`region-${index % 7}`],
    entities: [`place:region${index % 7}`]
  })
})

/** The memory that seeds the frame-key case: `the capital of India is` with one value. */
const CAPITAL_PATH = "areas/inbox/capital-of-india.html"
const CAPITAL = renderTemplate({
  title: "Capital of India",
  claim: "The capital of India is New Delhi.",
  memoryType: "semantic",
  at: AT
})

/** A memory a session puts: distinct per (session, slot), so eight times three are twenty-four files. */
const sessionMemory = (session: number, slot: number) => ({
  path: `projects/session-${session}/note-${slot}.html`,
  html: renderTemplate({
    title: `Session ${session} note ${slot}`,
    claim: `Session ${session} learned fact ${slot} about lane ${session * 10 + slot}.`,
    memoryType: "semantic",
    at: AT
  })
})

let cli: Cli
let git: GitShape
let fixtureSha: string
let fixtureHead: HeadVersion

/** Write files under the repo and commit them through porcelain; the new HEAD. */
const commitFiles = async (
  files: ReadonlyArray<{ readonly path: string; readonly html: string }>,
  message: string
): Promise<string> => {
  for (const file of files) {
    const target = join(cli.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await cli.git("add", "-A")
  await cli.git("commit", "-q", "-m", message)
  return (await cli.git("rev-parse", "HEAD")).trim()
}

/** Every path in a commit's tree, independently of the head's own `lsTreeR`. */
const treePaths = async (ref: string): Promise<ReadonlySet<string>> =>
  new Set(
    (await cli.git("ls-tree", "-r", "-z", "--name-only", ref)).split("\0").filter((p) => p !== "")
  )

/** A JSONL file of `write` ops for `session put`, under the repo's parent so it is never a memory. */
let scratchDir: string
const opsFile = async (
  name: string,
  ops: ReadonlyArray<Record<string, unknown>>
): Promise<string> => {
  const file = join(scratchDir, `${name}.jsonl`)
  await writeFile(file, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`)
  return file
}

beforeAll(async () => {
  cli = await makeCli()
  git = makeGit(cli.root)
  scratchDir = join(cli.root, "..", `memhtml-v2-ops-${process.pid}`)
  await mkdir(scratchDir, { recursive: true })
  const files = Array.from({ length: FIXTURE_SIZE }, (_, index) => fixtureMemory(index))
  fixtureSha = await commitFiles([...files, { path: CAPITAL_PATH, html: CAPITAL }], "fixture")
  fixtureHead = await run(loadHead(git, fixtureSha))
}, 180_000)

afterAll(async () => {
  await rm(scratchDir, { recursive: true, force: true })
  await cli.cleanup()
})

describe("eight concurrent sessions on one version", () => {
  /** Commit with the caller's rebase loop: on `rebase-needed`, reload at main, rebase, save, retry. */
  const commitWithRetry = (
    session: Session,
    message: string
  ): Effect.Effect<{ readonly outcome: CommitOutcome; readonly retries: number }, unknown> =>
    Effect.gen(function* () {
      let current = session
      let head: HeadVersion = fixtureHead
      let retries = 0
      while (true) {
        const outcome = yield* commitSession({ session: current, head, message })
        if (outcome.kind !== "rebase-needed") return { outcome, retries }
        if (retries >= RETRY_BOUND) {
          return yield* Effect.fail(
            new Error(`${session.id}: ${RETRY_BOUND} rebases were not enough`)
          )
        }
        retries += 1
        // Reload at the ref's new tip: dedup and frame keys are only as fresh as the head passed in.
        head = yield* loadHead(git, outcome.mainSha)
        current = rebaseSession(current, head)
        yield* saveSession(current)
      }
    })

  let outcomes: ReadonlyArray<{ readonly outcome: CommitOutcome; readonly retries: number }>
  const expectedPaths = Array.from({ length: SESSIONS }, (_, session) =>
    Array.from({ length: PUTS_PER_SESSION }, (_, slot) => sessionMemory(session, slot).path)
  ).flat()

  it("loads the fixture head with the record count ls-tree implies", async () => {
    const paths = await treePaths(fixtureSha)
    const candidates = [...paths].filter(
      (path) => path.endsWith(".html") && !path.endsWith("/index.html") && path !== "index.html"
    )
    // README.html is a candidate the parser refuses (skipped by design); everything else parses.
    expect(fixtureHead.size).toBe(candidates.length - fixtureHead.skipped)
    expect(fixtureHead.size).toBe(FIXTURE_SIZE + 1)
  })

  it("starts eight sessions concurrently, each with three puts, and lands all eight on main", async () => {
    const sessions = await run(
      Effect.all(
        Array.from({ length: SESSIONS }, (_, index) =>
          startSession({ root: cli.root, id: `c${index}`, base: fixtureHead }).pipe(
            Effect.flatMap((session) =>
              appendOps(
                session,
                Array.from({ length: PUTS_PER_SESSION }, (_, slot) => ({
                  kind: "put" as const,
                  ...sessionMemory(index, slot)
                }))
              )
            )
          )
        ),
        { concurrency: "unbounded" }
      )
    )
    expect(sessions).toHaveLength(SESSIONS)
    for (const session of sessions) expect(session.baseSha).toBe(fixtureSha)

    outcomes = await run(
      Effect.all(
        sessions.map((session) => commitWithRetry(session, `session ${session.id}`)),
        { concurrency: "unbounded" }
      )
    )
    for (const { outcome } of outcomes) expect(outcome.kind).toBe("committed")
    const retries = outcomes.map((entry) => entry.retries)
    console.info(
      `v2-sessions: rebases per session under eight concurrent commits: ${retries.join(",")}`
    )
    // Eight writers racing one ref: at least one loses the compare-and-swap and retries, none needs
    // more than the bound. The count is reported in the assertion message so a run records it.
    expect(Math.max(...retries), `retries per session: ${retries.join(",")}`).toBeLessThan(
      RETRY_BOUND
    )

    const count = Number((await cli.git("rev-list", "--count", `${fixtureSha}..main`)).trim())
    expect(count).toBe(SESSIONS)
    const paths = await treePaths("main")
    for (const path of expectedPaths) expect(paths.has(path), path).toBe(true)
  }, 180_000)

  it("advances the head through all eight shas with structural sharing", async () => {
    const shas = (await cli.git("rev-list", "--reverse", `${fixtureSha}..main`)).trim().split("\n")
    expect(shas).toHaveLength(SESSIONS)
    let version = fixtureHead
    for (const sha of shas) {
      const changed = new Set(
        (await cli.git("diff-tree", "-r", "-z", "--name-only", version.sha, sha))
          .split("\0")
          .filter((path) => path !== "")
      )
      const next = await run(advanceHead(git, version, sha))
      expect(next.sha).toBe(sha)
      expect(next.parent).toBe(version)
      // Every record the commit did not touch is the SAME object, not an equal one.
      let shared = 0
      for (const record of version.records()) {
        if (changed.has(record.path)) continue
        expect(next.get(record.path)).toBe(record)
        shared += 1
      }
      expect(shared).toBe(version.size)
      expect(next.size).toBe(version.size + PUTS_PER_SESSION)
      version = next
    }
    expect(version.size).toBe(fixtureHead.size + SESSIONS * PUTS_PER_SESSION)
    for (const path of expectedPaths) expect(version.get(path)?.path).toBe(path)
    // And a fresh load of the tip agrees with the advanced chain, record for record.
    const fresh = await run(loadHead(git, version.sha))
    expect(fresh.size).toBe(version.size)
    for (const record of fresh.records()) {
      expect((version.get(record.path) as MemoryRecord).contentHash).toBe(record.contentHash)
    }
  }, 180_000)
})

describe("the conflict cases, through the CLI envelopes", () => {
  interface Started {
    readonly id: string
    readonly baseSha: string
    readonly ref: string
  }
  interface Appended {
    readonly appended: number
    readonly paths: ReadonlyArray<string>
    readonly violations: ReadonlyArray<{ readonly kind: string }>
  }
  type Committed = { readonly id: string } & CommitOutcome

  const start = (id: string) => cli.json<Started>(["session", "start", "--id", id])
  const put = (id: string, file: string) =>
    cli.json<Appended>(["session", "put", "--id", id, "--file", file])
  const commit = (id: string) =>
    cli.json<Committed>(["session", "commit", "--id", id, "--message", `commit ${id}`])
  const rebase = (id: string) =>
    cli.json<{ readonly moved: boolean; readonly baseSha: string }>([
      "session",
      "rebase",
      "--id",
      id
    ])

  it("same path: rebase-needed, then refused with claim-edit or duplicate after the rebase", async () => {
    const shared = "areas/inbox/shared-slot.html"
    const one = {
      op: "write",
      title: "Shared",
      type: "semantic",
      path: shared,
      body: "Shared one."
    }
    const two = { ...one, body: "Shared two." }
    await Promise.all([start("sp-a"), start("sp-b"), start("sp-c")])
    await put("sp-a", await opsFile("sp-a", [one]))
    await put("sp-b", await opsFile("sp-b", [two]))
    await put("sp-c", await opsFile("sp-c", [one]))

    const first = await commit("sp-a")
    expect(first.kind).toBe("committed")
    if (first.kind !== "committed") return

    const blocked = await commit("sp-b")
    expect(blocked.kind).toBe("rebase-needed")
    if (blocked.kind !== "rebase-needed") return
    expect(blocked.overlapping).toEqual([shared])
    expect(blocked.mainSha).toBe(first.sha)

    const status = await cli.json<{ behind: boolean; refSha: string }>([
      "session",
      "status",
      "--id",
      "sp-b"
    ])
    expect(status.behind).toBe(true)
    expect(status.refSha).toBe(first.sha)

    expect((await rebase("sp-b")).moved).toBe(true)
    const edited = await commit("sp-b")
    expect(edited.kind).toBe("refused")
    if (edited.kind !== "refused") return
    expect(edited.violations).toEqual([{ kind: "claim-edit", path: shared }])

    await rebase("sp-c")
    const identical = await commit("sp-c")
    expect(identical.kind).toBe("refused")
    if (identical.kind !== "refused") return
    expect(identical.violations).toEqual([{ kind: "duplicate", path: shared, existing: shared }])
    expect((await cli.git("rev-parse", "refs/heads/main")).trim()).toBe(first.sha)
  })

  it("duplicate hash from two sessions: refused naming the first's path once the head is fresh", async () => {
    const claim = "Twins share exactly one claim about lane forty."
    await Promise.all([start("dh-a"), start("dh-b")])
    await put(
      "dh-a",
      await opsFile("dh-a", [{ op: "write", title: "Twin A", type: "semantic", body: claim }])
    )
    const second = await put(
      "dh-b",
      await opsFile("dh-b", [{ op: "write", title: "Twin B", type: "semantic", body: claim }])
    )
    // Judged against the base the session sees, the twin is unknown: no advisory violation yet.
    expect(second.violations).toEqual([])

    const first = await commit("dh-a")
    expect(first.kind).toBe("committed")
    // Dedup is only as fresh as the head passed in, so the caller reloads before retrying.
    expect((await rebase("dh-b")).moved).toBe(true)
    const refused = await commit("dh-b")
    expect(refused.kind).toBe("refused")
    if (refused.kind !== "refused") return
    expect(refused.violations).toEqual([
      { kind: "duplicate", path: "areas/inbox/twin-b.html", existing: "areas/inbox/twin-a.html" }
    ])
  })

  it("frame-key contradiction: both files live and the new one carries the contradicts link", async () => {
    await start("fk")
    await put(
      "fk",
      await opsFile("fk", [
        {
          op: "write",
          title: "Capital revised",
          type: "semantic",
          body: "The capital of India is Mumbai."
        }
      ])
    )
    const outcome = await commit("fk")
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed") return
    const rival = "areas/inbox/capital-revised.html"
    expect(outcome.contradictions).toEqual([{ path: rival, against: CAPITAL_PATH }])
    const paths = await treePaths(outcome.sha)
    expect(paths.has(CAPITAL_PATH)).toBe(true)
    expect(paths.has(rival)).toBe(true)
    const committed = await cli.git("cat-file", "-p", `${outcome.sha}:${rival}`)
    expect(committed).toContain(`<link rel="memhtml-contradicts" href="/${CAPITAL_PATH}">`)
    expect(await cli.git("cat-file", "-p", `${outcome.sha}:${CAPITAL_PATH}`)).toBe(CAPITAL)
  })

  it("ref race: another writer holding the ref between validation and update is rebase-needed", async () => {
    await start("race")
    await put(
      "race",
      await opsFile("race", [
        { op: "write", title: "Raced note", type: "semantic", body: "The raced note lands second." }
      ])
    )
    /**
     * A CLI invocation offers no hook between step 2 (`rev-parse`) and step 5 (`update-ref`), so the
     * race is staged the way git itself reports one: another writer holds `refs/heads/main.lock` while
     * this commit runs. `update-ref` fails with `cannot lock ref 'refs/heads/main'`, the same
     * classification a moved ref earns, and the commit path hands back `rebase-needed` with the ref's
     * current value rather than treating the lock as a git failure.
     */
    const before = (await cli.git("rev-parse", "refs/heads/main")).trim()
    const lock = join(cli.root, ".git", "refs", "heads", "main.lock")
    await writeFile(lock, "")
    try {
      const raced = await commit("race")
      expect(raced.kind).toBe("rebase-needed")
      if (raced.kind !== "rebase-needed") return
      expect(raced.overlapping).toEqual([])
      expect(raced.mainSha).toBe(before)
      expect((await cli.git("rev-parse", "refs/heads/main")).trim()).toBe(before)
    } finally {
      await rm(lock, { force: true })
    }
    // The session kept its op; once the other writer is gone the retry lands.
    expect((await rebase("race")).moved).toBe(false)
    const landed = await commit("race")
    expect(landed.kind).toBe("committed")
    if (landed.kind !== "committed") return
    expect(landed.paths).toEqual(["areas/inbox/raced-note.html"])
    expect((await cli.git("rev-parse", "refs/heads/main")).trim()).toBe(landed.sha)
  })
})

describe("the put and exec doors", () => {
  it("session put refuses a reserved path and appends nothing", async () => {
    await cli.json(["session", "start", "--id", "reserved"])
    const envelope = await cli.envelope([
      "session",
      "put",
      "--id",
      "reserved",
      "--file",
      await opsFile("reserved", [
        {
          op: "write",
          title: "Sneaky",
          type: "semantic",
          path: "resources/people/someone.html",
          body: "A session may not write a person file."
        }
      ])
    ])
    expect(envelope.code).toBe("ERR_INVALID_MEMORY")
    expect(String(envelope.error)).toContain("reserved path")
    const status = await cli.json<{ ops: number }>(["session", "status", "--id", "reserved"])
    expect(status.ops).toBe(0)
  })

  it("session put lands at the store's path and suffixes a collision inside one batch", async () => {
    await cli.json(["session", "start", "--id", "paths"])
    const appended = await cli.json<{ paths: ReadonlyArray<string> }>([
      "session",
      "put",
      "--id",
      "paths",
      "--file",
      await opsFile("paths", [
        { op: "write", title: "Same title", type: "semantic", body: "First of a pair." },
        { op: "write", title: "Same title", type: "semantic", body: "Second of a pair." },
        {
          op: "write",
          title: "Placed",
          type: "procedural",
          tag: "runbooks",
          body: "A procedural memory with a tag lands under resources."
        }
      ])
    ])
    expect(appended.paths).toEqual([
      "areas/inbox/same-title.html",
      "areas/inbox/same-title-2.html",
      "resources/runbooks/placed.html"
    ])
  })

  it("session exec appends the harvest only when the script exited 0", async () => {
    await cli.json(["session", "start", "--id", "ex"])
    const template = renderTemplate({
      title: "Written by a script",
      claim: "A script wrote this memory into the overlay.",
      memoryType: "semantic",
      at: AT
    })
    const writes = `import { writeFileSync } from "node:fs"\nwriteFileSync("/mnt/memhtml/areas/inbox/from-script.html", ${JSON.stringify(template)})\n`
    interface Report {
      readonly exitCode: number
      readonly ops: number
      readonly appended: number
      readonly opsTotal: number
      readonly harvested: ReadonlyArray<{ readonly kind: string; readonly path: string }>
    }
    const exec = (script: string) =>
      cli.json<Report>(["session", "exec", "--id", "ex", "--script", script])

    const failed = await exec(`${writes}process.exit(3)\n`)
    expect(failed.exitCode).toBe(3)
    expect(failed.ops).toBe(1)
    expect(failed.appended).toBe(0)
    expect(failed.opsTotal).toBe(0)

    const clean = await exec(writes)
    expect(clean.exitCode).toBe(0)
    expect(clean.harvested).toEqual([{ kind: "put", path: "areas/inbox/from-script.html" }])
    expect(clean.appended).toBe(1)
    expect(clean.opsTotal).toBe(1)

    const outcome = await cli.json<CommitOutcome>([
      "session",
      "commit",
      "--id",
      "ex",
      "--message",
      "from a script"
    ])
    expect(outcome.kind).toBe("committed")
    expect((await treePaths("main")).has("areas/inbox/from-script.html")).toBe(true)
  }, 120_000)
})

describe("the head commands", () => {
  it("head status loads from git, then from the snapshot head snapshot --write leaves", async () => {
    const sha = (await cli.git("rev-parse", "HEAD")).trim()
    interface Status {
      readonly sha: string
      readonly records: number
      readonly skipped: number | null
      readonly source: string
      readonly loadMs: number
    }
    const fromGit = await cli.json<Status>(["head", "status"])
    expect(fromGit.sha).toBe(sha)
    expect(fromGit.source).toBe("git")
    const paths = await treePaths(sha)
    const candidates = [...paths].filter(
      (path) => path.endsWith(".html") && !path.endsWith("/index.html") && path !== "index.html"
    )
    expect(fromGit.records + (fromGit.skipped ?? 0)).toBe(candidates.length)

    const written = await cli.json<{ rows: number; sha: string; bytes: number }>([
      "head",
      "snapshot",
      "--write"
    ])
    expect(written.sha).toBe(sha)
    expect(written.rows).toBe(fromGit.records)
    expect(written.bytes).toBeGreaterThan(0)

    const read = await cli.json<{ rows: number; sha: string }>(["head", "snapshot", "--read"])
    expect(read).toMatchObject({ rows: fromGit.records, sha })

    const fromSnapshot = await cli.json<Status>(["head", "status"])
    expect(fromSnapshot.source).toBe("snapshot")
    expect(fromSnapshot.records).toBe(fromGit.records)
    expect(fromSnapshot.skipped).toBeNull()
  })

  it("head search ranks the fixture by lexical match, deterministically", async () => {
    interface Search {
      readonly hits: ReadonlyArray<{ readonly path: string; readonly arms: ReadonlyArray<string> }>
    }
    const first = await cli.json<Search>(["head", "search", "capital of India", "--limit", "3"])
    expect(first.hits.length).toBeGreaterThan(0)
    expect(first.hits.length).toBeLessThanOrEqual(3)
    const lexical = first.hits.filter((hit) => hit.arms.includes("lexical")).map((hit) => hit.path)
    expect(lexical).toContain(CAPITAL_PATH)
    const second = await cli.json<Search>(["head", "search", "capital of India", "--limit", "3"])
    // The ranking is the claim; `head.loadMs` beside it is a measurement and varies by run.
    expect(second.hits).toEqual(first.hits)
  })
})
