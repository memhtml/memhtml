import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { STORE_CONFIG_FILE } from "@memhtml/contracts"
import { isCandidatePath } from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import { isIndexablePath } from "@memhtml/index"
import { isReservedPath, sessionStateFile } from "@memhtml/session"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { processTuning } from "../src/config-report.js"
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../src/envelope.js"
import {
  defaultExecPoolSize,
  EXEC_POOL_SIZE_DEFAULT_CAP,
  parsePoolSetting,
  WORKER_HEAP_MB
} from "../src/exec-pool.js"
import { startHeadServer } from "../src/head-server.js"
import { run } from "../src/run.js"
import { v1DoorState } from "../src/store-config.js"
import { fakeEmbedder, makeCli } from "./harness.js"
import { STRICT_STORE_CONFIG, writeStoreConfig } from "./strict-store.js"

/**
 * The store's policy file, `memhtml.config.json` at the store root, as the CLI reads it: absent is
 * the library's neutral defaults, a strict file reproduces a strict bar on every write path, a
 * malformed file refuses every command that needs the policy, and `v1Doors` chooses which v1 record
 * doors are open. The process tuning variables `head serve` reads are here too, because `memhtml
 * config` reports both halves.
 *
 * Mutations, each run once with the change applied and the named case red (2026-10-18):
 * - `v2.ts` `sessionPut`: the local `preparePuts` given no `writeBar` -> "refuses the same writes on
 *   every path" (the episodic put is appended); `sessionExec`'s local `execOverHead` given none ->
 *   the same case (the bare harvest is appended).
 * - `head-server.ts`: `/v1/neighbors` or `/v1/exec` given no `writeBar` -> the same case, its server
 *   legs.
 * - `v2.ts` `sessionCommit`: `commitSession` given no `writeBar` -> "the commit judges by the policy
 *   at commit time" (the session commits).
 * - `v2.ts` `curateMerge`: the replay's `validateOps` given no `writeBar` -> "curate merge judges a
 *   replay by the store's bar" (the narrative lands).
 * - `curate-run.ts` `curateRun`: `land` given the library bar -> "curate run lands under the store's
 *   bar" (the resumed narrative commits); the briefing given no `placementQuota` -> "curate run
 *   briefs with the store's quota" (60, not 7). The tools given the library bar SURVIVES here: the
 *   scripted fake never proposes an op below a strict bar, so `bindTools`'s own cases in
 *   `curate-run.test.ts`, which hand it the bar, are what hold that seam.
 * - `curate-collapse.ts` `curateCollapse`: the planner given no `writerBuckets` -> "curate collapse
 *   plans a fold's home away from a writer bucket" (the home stays `areas/vendor-import`).
 * - `@memhtml/curator` `readCharterFile`: the blank check removed -> "curate run briefs with the
 *   store's quota" (a blank charter runs).
 * - `store-config.ts` `loadStorePolicy`: a decode failure answered as the defaults -> "refuses every
 *   command that needs the policy" (the put lands); every read error answered as absent -> "a policy
 *   path that is a directory fails closed too" (the put lands under defaults).
 * - `store-config.ts` `v1DoorState`: `closed` treated as `closed-in-session` -> "closed refuses the
 *   record doors in every process" (the write lands).
 * - `run.ts` `run`: the pre-validate policy read removed -> the same case (`apply --file -` reads
 *   an empty stdin and answers ERR_MISSING_ARGUMENT before its arm's guard runs).
 * - `run.ts` the `write` arm's `guardV1Door` removed -> "an injected layer defers the door to the
 *   arm's guard" (the write lands).
 * - `run.ts` the `config` arm reading another root -> "reports each key the file sets".
 * - `exec-pool.ts` `defaultExecPoolSize`: the cap dropped -> "the exec pool defaults from the host,
 *   capped".
 */

const SESSION_VAR = "MEMHTML_SESSION"
const AT = "2026-03-01T12:00:00Z"

type Body = Record<string, unknown>

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
const scopes: Array<Scope.Closeable> = []
let saved: string | undefined

beforeEach(() => {
  saved = process.env[SESSION_VAR]
  delete process.env[SESSION_VAR]
})

afterEach(async () => {
  if (saved === undefined) delete process.env[SESSION_VAR]
  else process.env[SESSION_VAR] = saved
  await Promise.all(scopes.splice(0).map((scope) => run_(Scope.close(scope, Exit.void))))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

/** A committed corpus of one labeled record on `main`. */
const corpus = async (): Promise<FixtureRepo> => {
  const repo = await run_(makeFixtureRepo())
  repos.push(repo)
  const target = join(repo.root, "areas", "inbox", "harbor.html")
  await mkdir(dirname(target), { recursive: true })
  await writeFile(
    target,
    renderTemplate({
      title: "harbor",
      claim: "Harbor facts are recorded here.",
      memoryType: "semantic",
      at: AT,
      entities: ["system:fixture"]
    }),
    "utf8"
  )
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", "corpus"]))
  return repo
}

/** `memhtml <argv> --repo <root>` in process, stdin from `input`, parsed. */
const cli = async (
  root: string,
  argv: ReadonlyArray<string>,
  input = ""
): Promise<{ exitCode: number; body: Body }> => {
  const result = await run(
    [...argv, "--repo", root],
    undefined,
    () => Promise.resolve(input),
    false
  )
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as Body }
}

const dataOf = (body: Body) => body.data as Body

const serve = async (root: string): Promise<void> => {
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  await run_(
    startHeadServer({ root, pollMs: 0, embedder: fakeEmbedder() }).pipe(Scope.provide(scope))
  )
}

/** One put line: a run narrative that names nothing, below a strict bar on both counts. */
const NARRATIVE = `${JSON.stringify({ op: "write", title: "Run 44", type: "episodic", body: "Run 44 folded two records." })}\n`

/** A script that writes one record naming nothing, at `areas/inbox/<name>.html`. */
const bareScript = (name: string) =>
  [
    `cat > /mnt/memhtml/areas/inbox/${name}.html <<'HTML'`,
    renderTemplate({
      title: `A ${name} that names nothing`,
      claim: `This ${name} is about nothing in particular.`,
      memoryType: "semantic",
      at: AT,
      entities: []
    }).trimEnd(),
    "HTML",
    ""
  ].join("\n")

const BARE_SCRIPT = bareScript("bare-note")

const WRITE = [
  "write",
  "--title",
  "Door fact",
  "--claim",
  "The door fact holds.",
  "--type",
  "semantic"
]

const opsOf = async (root: string, id: string): Promise<ReadonlyArray<Body>> =>
  (JSON.parse(await readFile(sessionStateFile(root, id), "utf8")) as { ops: ReadonlyArray<Body> })
    .ops

describe("with no policy file, the library's defaults", () => {
  it("accept a run narrative and a record that names nothing, on every path, and commit them", async () => {
    const repo = await corpus()
    await cli(repo.root, ["session", "start", "--id", "open"])
    const put = await cli(
      repo.root,
      ["session", "put", "--id", "open", "--file", "-", "--no-server"],
      NARRATIVE
    )
    expect(put.exitCode).toBe(EXIT_OK)
    expect(dataOf(put.body)).toMatchObject({ appended: 1 })
    const exec = await cli(
      repo.root,
      ["session", "exec", "--id", "open", "--no-server"],
      BARE_SCRIPT
    )
    expect(dataOf(exec.body)).toMatchObject({ appended: 1, violations: [] })
    await serve(repo.root)
    const served = await cli(
      repo.root,
      ["session", "exec", "--id", "open"],
      bareScript("second-note")
    )
    expect(dataOf(served.body)).toMatchObject({ appended: 1, violations: [] })
    expect((dataOf(served.body).head as Body).source).toBe("server")
    const committed = await cli(repo.root, ["session", "commit", "--id", "open", "--message", "m"])
    expect(dataOf(committed.body)).toMatchObject({ kind: "committed" })
  })

  it("report every key as the default, the file absent, and the process tuning at its defaults", async () => {
    const repo = await corpus()
    const report = await cli(repo.root, ["config"])
    expect(report.exitCode).toBe(EXIT_OK)
    expect(report.body.type).toBe("config.report")
    const data = dataOf(report.body)
    expect(data.file).toEqual({
      path: join(repo.root, STORE_CONFIG_FILE),
      present: false,
      git: "absent"
    })
    expect(data.store).toEqual({
      "writeBar.refusedTypes": { value: [], source: "default" },
      "writeBar.requireAnchor": { value: false, source: "default" },
      v1Doors: { value: "closed-in-session", source: "default" },
      "curator.writerBuckets": { value: [], source: "default" },
      "curator.placementQuota": { value: 60, source: "default" }
    })
    expect(processTuning({})).toEqual({
      MEMHTML_EMBED_WARM_IDLE_MS: { value: 0, source: "default", readBy: "head serve" },
      MEMHTML_EXEC_POOL_SIZE: {
        value: defaultExecPoolSize(),
        source: "default",
        readBy: "head serve"
      },
      MEMHTML_EXEC_WORKER_HEAP_MB: {
        value: WORKER_HEAP_MB,
        source: "default",
        readBy: "head serve"
      }
    })
  })
})

describe("a strict policy file", () => {
  it("refuses the same writes on every path: session put, session exec here and through the server", async () => {
    const repo = await corpus()
    await writeStoreConfig(repo.root)
    await cli(repo.root, ["session", "start", "--id", "strict"])
    const put = await cli(
      repo.root,
      ["session", "put", "--id", "strict", "--file", "-", "--no-server"],
      NARRATIVE
    )
    expect(put.exitCode).toBe(EXIT_RUNTIME)
    expect(put.body.code).toBe("ERR_INVALID_MEMORY")
    expect(String(put.body.error)).toContain("runs belong in the trace index")
    expect(String(put.body.error)).toContain("memhtml-entity")

    const local = await cli(
      repo.root,
      ["session", "exec", "--id", "strict", "--no-server"],
      BARE_SCRIPT
    )
    expect(dataOf(local.body)).toMatchObject({ appended: 0 })
    expect((dataOf(local.body).violations as ReadonlyArray<Body>).map((v) => v.kind)).toEqual([
      "write-bar"
    ])

    await serve(repo.root)
    const servedPut = await cli(
      repo.root,
      ["session", "put", "--id", "strict", "--file", "-"],
      NARRATIVE
    )
    expect(servedPut.exitCode).toBe(EXIT_RUNTIME)
    expect(String(servedPut.body.error)).toContain("runs belong in the trace index")
    const served = await cli(repo.root, ["session", "exec", "--id", "strict"], BARE_SCRIPT)
    expect((dataOf(served.body).head as Body).source).toBe("server")
    expect(dataOf(served.body)).toMatchObject({ appended: 0 })
    expect((dataOf(served.body).violations as ReadonlyArray<Body>).map((v) => v.kind)).toEqual([
      "write-bar"
    ])
    expect(await opsOf(repo.root, "strict")).toEqual([])
  })

  it("the commit judges by the policy at commit time, not the one the puts were appended under", async () => {
    const repo = await corpus()
    await cli(repo.root, ["session", "start", "--id", "late"])
    const put = await cli(
      repo.root,
      ["session", "put", "--id", "late", "--file", "-", "--no-server"],
      NARRATIVE
    )
    expect(dataOf(put.body)).toMatchObject({ appended: 1 })
    await writeStoreConfig(repo.root, { commit: true })
    const before = await run_(repo.git.revParseHead())
    const committed = await cli(repo.root, ["session", "commit", "--id", "late", "--message", "m"])
    const data = dataOf(committed.body)
    expect(data.kind).toBe("refused")
    expect((data.violations as ReadonlyArray<Body>).map((v) => v.kind)).toEqual(["write-bar"])
    expect(await run_(repo.git.revParseHead())).toBe(before)
  })

  it("reports each key the file sets as the file's, and whether git holds the file", async () => {
    const repo = await corpus()
    await writeStoreConfig(repo.root)
    const untracked = dataOf((await cli(repo.root, ["config"])).body)
    expect(untracked.file).toMatchObject({ present: true, git: "untracked" })
    expect(untracked.store).toMatchObject({
      "writeBar.refusedTypes": {
        value: STRICT_STORE_CONFIG.writeBar.refusedTypes,
        source: "file"
      },
      "writeBar.requireAnchor": { value: true, source: "file" },
      v1Doors: { value: "closed-in-session", source: "file" },
      "curator.writerBuckets": { value: STRICT_STORE_CONFIG.curator.writerBuckets, source: "file" },
      "curator.placementQuota": { value: 60, source: "file" }
    })
    await writeStoreConfig(repo.root, { commit: true })
    expect(dataOf((await cli(repo.root, ["config"])).body).file).toMatchObject({
      git: "committed"
    })
    await writeStoreConfig(repo.root, { config: { v1Doors: "open" } })
    const modified = dataOf((await cli(repo.root, ["config"])).body)
    expect(modified.file).toMatchObject({ git: "modified" })
    expect(modified.store).toMatchObject({
      v1Doors: { value: "open", source: "file" },
      "writeBar.requireAnchor": { value: false, source: "default" }
    })
  })
})

describe("a malformed policy file fails closed", () => {
  it("refuses every command that needs the policy with ERR_STORE_CONFIG, and leaves reads alone", async () => {
    const repo = await corpus()
    // A misspelled key: read as unset, it would silently drop the anchor rule it meant to state.
    await writeStoreConfig(repo.root, { config: '{"writeBar":{"requireAnchors":true}}\n' })
    await cli(repo.root, ["session", "start", "--id", "bad"])
    const before = await run_(repo.git.revParseHead())

    for (const [argv, input] of [
      [["session", "put", "--id", "bad", "--file", "-", "--no-server"], NARRATIVE],
      [["session", "exec", "--id", "bad", "--no-server"], BARE_SCRIPT],
      [["session", "commit", "--id", "bad", "--message", "m"], ""],
      [["config"], ""],
      [["write", "--title", "T", "--claim", "A fact.", "--type", "semantic"], ""]
    ] as const) {
      const result = await cli(repo.root, argv, input)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_RUNTIME)
      expect(result.body.code, argv.join(" ")).toBe("ERR_STORE_CONFIG")
      expect(String(result.body.error)).toContain("requireAnchors")
      expect(result.body.suggestions).toContain("memhtml config")
    }
    expect(await opsOf(repo.root, "bad")).toEqual([])
    expect(await run_(repo.git.revParseHead())).toBe(before)

    // Reads never read the policy.
    expect((await cli(repo.root, ["session", "status", "--id", "bad"])).exitCode).toBe(EXIT_OK)
    expect((await cli(repo.root, ["head", "status", "--no-server"])).exitCode).toBe(EXIT_OK)
  })

  it("a policy path that is a directory fails closed too, rather than reading as absent", async () => {
    const repo = await corpus()
    await mkdir(join(repo.root, STORE_CONFIG_FILE))
    await cli(repo.root, ["session", "start", "--id", "dir"])
    const put = await cli(
      repo.root,
      ["session", "put", "--id", "dir", "--file", "-", "--no-server"],
      NARRATIVE
    )
    expect(put.exitCode).toBe(EXIT_RUNTIME)
    expect(put.body.code).toBe("ERR_STORE_CONFIG")
    expect(String(put.body.error)).toContain("cannot read it (EISDIR)")
  })
})

describe("v1Doors", () => {
  it("closed refuses the record doors in every process, and leaves the edits of records open", async () => {
    const repo = await corpus()
    await writeStoreConfig(repo.root, { config: { v1Doors: "closed" } })
    const before = await run_(repo.git.revParseHead())
    for (const argv of [
      WRITE,
      [
        "task",
        "add",
        "--title",
        "Rotate the key",
        "--claim",
        "The key expires.",
        "--workspace",
        "w"
      ],
      ["apply", "--file", "-"]
    ]) {
      const result = await cli(repo.root, argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
      expect(result.body.code, argv.join(" ")).toBe("ERR_V1_DOOR_CLOSED")
      expect(String(result.body.error)).toContain('sets v1Doors to "closed"')
      expect(result.body.suggestions).toContain("memhtml session start --id s1")
    }
    expect(await run_(repo.git.revParseHead())).toBe(before)
    // Refused before anything opened: no v1 command has built this store's index yet.
    await expect(access(join(repo.root, ".memhtml", "index.db"))).rejects.toThrow()
    const archived = await cli(repo.root, [
      "archive",
      "areas/inbox/harbor.html",
      "--reason",
      "stale"
    ])
    expect(archived.exitCode, JSON.stringify(archived.body)).toBe(EXIT_OK)
  })

  it("open admits the record doors even inside a run session", async () => {
    const repo = await corpus()
    await writeStoreConfig(repo.root, { config: { v1Doors: "open" } })
    process.env[SESSION_VAR] = "run-open"
    const result = await cli(repo.root, WRITE)
    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf(result.body).created).toBe(true)
  })

  it("closed-in-session, the default, closes them only in a run session, with the session code", async () => {
    const repo = await corpus()
    expect((await cli(repo.root, WRITE)).exitCode).toBe(EXIT_OK)
    process.env[SESSION_VAR] = "run-default"
    const refused = await cli(repo.root, [...WRITE.slice(0, 2), "Door fact two", ...WRITE.slice(3)])
    expect(refused.exitCode).toBe(EXIT_USAGE)
    expect(refused.body.code).toBe("ERR_SESSION_BOUND")
  })

  it("an injected layer defers the door to the arm's guard, which still refuses at exit 2", async () => {
    const harness = await makeCli()
    try {
      await writeStoreConfig(harness.root, { config: { v1Doors: "closed" } })
      // No --repo: the root is the layer's, so the refusal is the `write` arm's own guard.
      const result = await run(WRITE, harness.layer, undefined, false)
      expect(result.exitCode).toBe(EXIT_USAGE)
      const body = JSON.parse(result.stdout) as Body
      expect(body.code).toBe("ERR_V1_DOOR_CLOSED")
      const listed = await harness.json<{ files: ReadonlyArray<Body> }>(["list"])
      expect(listed.files).toEqual([])
    } finally {
      await harness.cleanup()
    }
  })

  it("decides open or closed per mode and session", () => {
    expect(v1DoorState("open", "s")).toEqual({ open: true })
    expect(v1DoorState("closed-in-session", undefined)).toEqual({ open: true })
    expect(v1DoorState("closed-in-session", "s")).toEqual({ open: false, session: "s" })
    expect(v1DoorState("closed", undefined)).toEqual({ open: false, session: null })
    expect(v1DoorState("closed", "s")).toEqual({ open: false, session: "s" })
  })
})

describe("the curate commands under the store's policy", () => {
  /** A `curate/x` branch carrying one run narrative, with `main` moved on since, so a merge replays. */
  const divergedCurateBranch = async (repo: FixtureRepo): Promise<void> => {
    await run_(repo.git.run(["checkout", "-q", "-b", "curate/x"]))
    const narrative = join(repo.root, "areas", "inbox", "run-44.html")
    await writeFile(
      narrative,
      renderTemplate({
        title: "Run 44",
        claim: "Run 44 folded two records into one.",
        memoryType: "episodic",
        at: AT,
        entities: []
      }),
      "utf8"
    )
    await run_(repo.git.run(["add", "--", "areas/inbox/run-44.html"]))
    await run_(repo.git.run(["commit", "-q", "-m", "memhtml(curate): curated x"]))
    await run_(repo.git.run(["checkout", "-q", "main"]))
    const moved = join(repo.root, "areas", "inbox", "orchard.html")
    await writeFile(
      moved,
      renderTemplate({
        title: "orchard",
        claim: "Orchard facts are recorded here.",
        memoryType: "semantic",
        at: AT,
        entities: ["system:fixture"]
      }),
      "utf8"
    )
    await run_(repo.git.run(["add", "--", "areas/inbox/orchard.html"]))
    await run_(repo.git.run(["commit", "-q", "-m", "main moved"]))
  }

  it("curate merge judges a replay by the store's bar, and the defaults land it", async () => {
    const repo = await corpus()
    await divergedCurateBranch(repo)
    await writeStoreConfig(repo.root)
    const before = await run_(repo.git.revParseHead())
    const refused = await cli(repo.root, ["curate", "merge", "curate/x", "--skip-gate"])
    expect(refused.exitCode).toBe(EXIT_RUNTIME)
    expect(String(refused.body.error)).toContain("was refused, nothing moved")
    expect(String(refused.body.error)).toContain("runs belong in the trace index")
    expect(await run_(repo.git.revParseHead())).toBe(before)

    await writeStoreConfig(repo.root, { config: {} })
    const landed = await cli(repo.root, ["curate", "merge", "curate/x", "--skip-gate"])
    expect(landed.exitCode, JSON.stringify(landed.body)).toBe(EXIT_OK)
    expect(dataOf(landed.body).moved).toBe(true)
  })

  it("curate collapse plans a fold's home away from a writer bucket only when the store names it", async () => {
    const repo = await corpus()
    const claims = [
      "Verify against the primary source before asserting a result or claiming completion.",
      "Always verify the primary source before asserting completion of a result.",
      "Before claiming completion, verify the result against its primary source.",
      "Assert a result only after verifying it against the primary source."
    ]
    for (const [index, claim] of claims.entries()) {
      const target = join(repo.root, "areas", "vendor-import", `verify-${String(index)}.html`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(
        target,
        renderTemplate({
          title: `Verify before asserting ${String(index)}`,
          claim,
          body: [`Seen on run ${String(index)}.`],
          memoryType: "user_preference",
          at: AT,
          tags: ["verification"],
          entities: ["system:fixture"]
        }),
        "utf8"
      )
    }
    await run_(repo.git.run(["add", "-A"]))
    await run_(repo.git.run(["commit", "-q", "-m", "an importer's records"]))
    const homeOfFold = async (): Promise<string | undefined> => {
      const planned = await cli(repo.root, [
        "curate",
        "collapse",
        "--model",
        "fake",
        "--dry-run",
        "--ref",
        "curate/policy-collapse"
      ])
      expect(planned.exitCode, JSON.stringify(planned.body)).toBe(EXIT_OK)
      const plan = dataOf(planned.body).plan as {
        clusters: ReadonlyArray<{ kind: string; home: string; members: ReadonlyArray<Body> }>
      }
      return plan.clusters.find(
        (cluster) =>
          cluster.kind === "fold" &&
          cluster.members.some((member) => String(member.path).startsWith("areas/vendor-import/"))
      )?.home
    }
    expect(await homeOfFold()).toBe("areas/vendor-import")
    await writeStoreConfig(repo.root)
    const strictHome = await homeOfFold()
    expect(strictHome).toBeDefined()
    expect(strictHome).not.toBe("areas/vendor-import")

    // `--charter` names the file every fold is briefed with; one that cannot be read stops the run.
    const charter = join(repo.root, ".memhtml", "collapse-charter.md")
    await writeFile(charter, "Fold the cluster into one canonical.{{refusedTypesClause}}\n", "utf8")
    const collapse = ["curate", "collapse", "--model", "fake", "--dry-run", "--ref", "curate/c"]
    const briefed = await cli(repo.root, [...collapse, "--charter", charter])
    expect(briefed.exitCode, JSON.stringify(briefed.body)).toBe(EXIT_OK)
    expect(dataOf(briefed.body).charter).toBe(charter)
    const missing = await cli(repo.root, [...collapse, "--charter", `${charter}.absent`])
    expect(missing.exitCode).toBe(EXIT_RUNTIME)
    expect(missing.body.code).toBe("ERR_STORAGE")
    expect(String(missing.body.error)).toContain("charter-file")
  })

  it("curate run lands under the store's bar: a resumed session carrying a narrative is refused at landing", async () => {
    const repo = await corpus()
    const id = "curate-land"
    await cli(repo.root, ["session", "start", "--id", id, "--ref", "curate/land"])
    const put = await cli(
      repo.root,
      ["session", "put", "--id", id, "--file", "-", "--no-server"],
      NARRATIVE
    )
    expect(dataOf(put.body)).toMatchObject({ appended: 1 })
    const resume = ["curate", "run", "--model", "fake", "--ref", "curate/land", "--resume"]

    await writeStoreConfig(repo.root)
    const refused = await cli(repo.root, resume)
    expect(refused.exitCode, JSON.stringify(refused.body)).toBe(EXIT_RUNTIME)
    expect(String(refused.body.error)).toContain("refused at commit")
    expect(String(refused.body.error)).toContain("runs belong in the trace index")

    await writeStoreConfig(repo.root, { config: {} })
    const landed = await cli(repo.root, resume)
    expect(landed.exitCode, JSON.stringify(landed.body)).toBe(EXIT_OK)
    expect(dataOf(landed.body).outcome).toBe("committed")
  })

  it("curate run briefs with the store's quota and answers which charter it ran under", async () => {
    const repo = await corpus()
    await writeStoreConfig(repo.root, { config: { curator: { placementQuota: 7 } } })
    const charter = join(repo.root, ".memhtml", "charter.md")
    await mkdir(dirname(charter), { recursive: true })
    await writeFile(
      charter,
      "File at most {{placementQuota}} records.{{refusedTypesRule}}\n",
      "utf8"
    )
    const ran = await cli(repo.root, [
      "curate",
      "run",
      "--model",
      "fake",
      "--dry-run",
      "--ref",
      "curate/policy",
      "--charter",
      charter
    ])
    expect(ran.exitCode, JSON.stringify(ran.body)).toBe(EXIT_OK)
    const data = dataOf(ran.body)
    expect(data.charter).toBe(charter)
    expect((data.briefing as Body).placementQuota).toBe(7)

    // A charter with no text would brief the curator with nothing; it is refused before any model call.
    await writeFile(charter, " \n", "utf8")
    const blank = await cli(repo.root, [
      "curate",
      "run",
      "--model",
      "fake",
      "--dry-run",
      "--ref",
      "curate/policy",
      "--charter",
      charter
    ])
    expect(blank.exitCode).toBe(EXIT_RUNTIME)
    expect(blank.body.code).toBe("ERR_STORAGE")
    expect(String(blank.body.error)).toContain("has no text")
  })
})

describe("the policy file is never a record", () => {
  it("is no candidate, indexes nothing, is reserved in every scope, and stays out of list and publish", async () => {
    expect(isCandidatePath(STORE_CONFIG_FILE)).toBe(false)
    expect(isIndexablePath(STORE_CONFIG_FILE)).toBe(false)
    for (const scope of ["session", "curate"] as const) {
      expect(isReservedPath(STORE_CONFIG_FILE, scope)).toBe(true)
    }
    const harness = await makeCli()
    try {
      const written = await harness.json<{ path: string }>(WRITE)
      await writeStoreConfig(harness.root, { commit: true })
      await harness.json(["index", "rebuild"])
      const listed = await harness.json<{ files: ReadonlyArray<Body> }>(["list"])
      expect(listed.files.map((file) => file.path)).toEqual([written.path])
      const published = await harness.json<Body>(["publish"])
      expect(JSON.stringify(published)).not.toContain(STORE_CONFIG_FILE)
      const sitemap = await readFile(join(harness.root, "sitemap.xml"), "utf8")
      expect(sitemap).toContain(written.path)
      expect(sitemap).not.toContain(STORE_CONFIG_FILE)
      const doctor = await harness.json<Body>(["doctor"])
      expect(JSON.stringify(doctor)).not.toContain(STORE_CONFIG_FILE)
    } finally {
      await harness.cleanup()
    }
  })
})

describe("the process tuning head serve reads", () => {
  it("the exec pool defaults from the host, capped", () => {
    expect(defaultExecPoolSize(1)).toBe(1)
    expect(defaultExecPoolSize(2)).toBe(1)
    expect(defaultExecPoolSize(4)).toBe(3)
    expect(defaultExecPoolSize(5)).toBe(EXEC_POOL_SIZE_DEFAULT_CAP)
    expect(defaultExecPoolSize(96)).toBe(EXEC_POOL_SIZE_DEFAULT_CAP)
    expect(parsePoolSetting(" 8 ", 1, 64)).toEqual({ ok: true, value: 8 })
    for (const raw of ["0", "65", "1.5", "-1", "four", ""]) {
      expect(parsePoolSetting(raw, 1, 64).ok, raw).toBe(false)
    }
  })

  it("reads each variable as env, and names a value head serve would refuse", () => {
    const tuning = processTuning({
      MEMHTML_EMBED_WARM_IDLE_MS: "45000",
      MEMHTML_EXEC_POOL_SIZE: "four",
      MEMHTML_EXEC_WORKER_HEAP_MB: "1024"
    })
    expect(tuning.MEMHTML_EMBED_WARM_IDLE_MS).toEqual({
      value: 45_000,
      source: "env",
      readBy: "head serve"
    })
    expect(tuning.MEMHTML_EXEC_POOL_SIZE).toMatchObject({ value: null, source: "env" })
    expect(tuning.MEMHTML_EXEC_POOL_SIZE?.problem).toContain("head serve refuses to start")
    expect(tuning.MEMHTML_EXEC_WORKER_HEAP_MB).toMatchObject({ value: 1024, source: "env" })
  })

  it("head serve refuses a malformed pool variable at exit 2 before it opens anything", async () => {
    const repo = await corpus()
    for (const [name, raw] of [
      ["MEMHTML_EXEC_POOL_SIZE", "0"],
      ["MEMHTML_EXEC_WORKER_HEAP_MB", "32"]
    ] as const) {
      const previous = process.env[name]
      process.env[name] = raw
      try {
        const result = await cli(repo.root, ["head", "serve"])
        expect(result.exitCode, name).toBe(EXIT_USAGE)
        expect(result.body.code).toBe("ERR_INVALID_FLAG")
        expect(String(result.body.error)).toContain(name)
      } finally {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }
    }
  })
})
