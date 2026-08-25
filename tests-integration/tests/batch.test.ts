import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GUIDE_TOPICS } from "@memhtml/cli"
import { DatabaseService } from "@memhtml/index"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"
import {
  type Client,
  connect,
  envelopeOf,
  failureText,
  handshake,
  runBare,
  runBuilt,
  structured,
  treeDigest
} from "./spawned.js"

/**
 * Spec 004's success metric, run as an experiment rather than restated as a claim: **ingesting the
 * 20-write Alice fixture through ONE call produces one commit, one reindex, and twenty per-op results,
 * and the same ingest through `memhtml apply` from JSONL matches.**
 *
 * The two doors are proven against ONE fixture ({@link FIXTURE}), projected into each door's wire shape
 * by {@link jsonlOf} and {@link mcpOpsOf}. That is the whole point of running both here: the doors share
 * an operations-layer `batchWrite` (`apps/cli/src/operations.ts`), so a per-door test proves the door,
 * and only a shared-fixture PAIR proves that two agents reading two surfaces get the same corpus. Every
 * arithmetic assertion below is written once and applied twice, so a divergence fails as a mismatch
 * between the doors rather than as one door's number being wrong in isolation.
 *
 * **What this tier adds over the unit suites.** `apps/cli/tests/apply.test.ts` and
 * `apps/mcp/tests/roundtrip.test.ts` already drive both doors in-process with an injected layer, and
 * they own the per-op semantics. What they structurally cannot see is the PROCESS: the exit code, the
 * one-envelope-on-stdout rule, NDJSON framing, `MEMHTML_EMBED=off` resolving to an absent embedder at
 * layer-build time in a process that is not this one, and the manifest guide as the BUILT binary emits
 * it. Those are the assertions here, and nothing else is.
 *
 * **Twenty ops, not three.** Three ops prove the fold; twenty prove the fold does not become N commits
 * or N index passes at scale, which is the cost claim `BATCH_GUIDANCE` and the manifest guide both make
 * to an agent deciding whether to batch. It is also the number in the spec's success metric, and the
 * number the eval harness pays a round trip for per memory today (spec G5).
 *
 * **BUILD ORDER.** Everything here drives `dist` through a child process. `turbo` makes
 * `test:integration` depend on `build`.
 */

/** One op in the shared fixture, in neither door's spelling. */
interface Op {
  readonly title: string
  readonly type: string
  readonly body?: string
  readonly articleHtml?: string
  readonly tags?: ReadonlyArray<string>
}

/**
 * The Alice fixture, kept in the lineage of `docs/bugs/2026-08-03-event-at-unreachable-through-write-paths.md`
 * so the two suites that use her are greppable from either end.
 *
 * Twenty ops: one carrying `article_html` with a `<time datetime>`, seventeen distinct prose ops, and
 * two whose bodies are BYTE-IDENTICAL to two earlier ops in the same batch. The duplicates are the
 * interesting ones — they exercise D5's intra-batch dedup, where the op an agent gets back a path for
 * deduped against a file that did not exist when the batch started and exists in the same commit that
 * the batch is about to make. A duplicate of an ALREADY-STORED file would take the store's own dedupe
 * lookup instead and prove the weaker half.
 */
const CITIES = [
  "Paris",
  "Lyon",
  "Marseille",
  "Toulouse",
  "Nice",
  "Nantes",
  "Bordeaux",
  "Lille",
  "Rennes",
  "Reims",
  "Dijon",
  "Angers",
  "Brest",
  "Tours",
  "Metz",
  "Caen",
  "Nancy"
] as const

/** The prose body of the visit op for a city, so a duplicate is built from the SAME expression. */
const visitProse = (city: string, week: number): string =>
  `Alice visited ${city} in week ${week}. She noted the trains ran on time.`

/** The markup the bug report could not reach through any write path, carried by op 0. */
const ALICE_MARKUP =
  "<p><mark>Alice moved to Paris.</mark> " +
  '<time datetime="2023-05-20T02:21:00Z">2023-05-20</time></p>'

/** The event time that markup's `<time>` element carries into `files.event_at`. */
const ALICE_EVENT_AT = "2023-05-20T02:21:00Z"

const FIXTURE: ReadonlyArray<Op> = [
  { title: "Alice moved to Paris", type: "episodic", articleHtml: ALICE_MARKUP },
  ...CITIES.map((city, at) => ({
    title: `Alice visited ${city}`,
    type: "episodic",
    body: visitProse(city, at + 1),
    tags: ["alice", "travel"]
  })),
  /**
   * The two intra-batch duplicates. Different TITLES — so `freePathFor` would happily give each its own
   * path — and identical bodies, which is what makes the dedup a content decision rather than a path
   * collision. Both point back at ops 1 and 2.
   */
  { title: "Alice went to Paris again", type: "episodic", body: visitProse("Paris", 1) },
  { title: "Alice went to Lyon again", type: "episodic", body: visitProse("Lyon", 2) }
]

/** The two duplicates' indices and the indices they must dedupe ONTO. */
const DUPLICATES = [
  { at: 18, of: 1 },
  { at: 19, of: 2 }
] as const

/** The arithmetic both doors must produce, stated once. */
const SUMMARY = {
  total: 20,
  written: 18,
  deduped: 2,
  failed: 0,
  skipped: 0,
  consolidated: 0
} as const

/** The fixture as the CLI door's JSONL: snake_case, one complete object per line. */
const jsonlOf = (ops: ReadonlyArray<Op>): string =>
  `${ops
    .map((op) =>
      JSON.stringify({
        op: "write",
        title: op.title,
        type: op.type,
        ...(op.body === undefined ? {} : { body: op.body }),
        ...(op.articleHtml === undefined ? {} : { article_html: op.articleHtml }),
        ...(op.tags === undefined ? {} : { tag: op.tags })
      })
    )
    .join("\n")}\n`

/** The fixture as the MCP door's `ops` array: the same snake_case, minus the `op` discriminator. */
const mcpOpsOf = (ops: ReadonlyArray<Op>): ReadonlyArray<Record<string, unknown>> =>
  ops.map((op) => ({
    title: op.title,
    memory_type: op.type,
    ...(op.body === undefined ? {} : { body: op.body }),
    ...(op.articleHtml === undefined ? {} : { article_html: op.articleHtml }),
    ...(op.tags === undefined ? {} : { tags: op.tags })
  }))

/**
 * One op's `conflict`, in the shape BOTH doors publish.
 *
 * `path` and `batch_index` are both nullable and exactly one is populated: a match against a stored
 * memory carries the path, a match against an earlier op in the same call carries that op's index, and
 * an op matching nothing has no conflict object at all (`conflict: null`).
 */
interface ConflictWire {
  readonly path: string | null
  readonly batch_index: number | null
  readonly claim: string
}

/** One per-op result, in the shape BOTH doors publish. */
interface OpResult {
  readonly index: number
  readonly ok: boolean
  readonly path: string | null
  readonly deduped: boolean
  readonly existing_path: string | null
  readonly code: string | null
  readonly error: string | null
  readonly skipped: boolean
  /** Always PRESENT on both doors, null when nothing matched or the assist was not asked for. */
  readonly conflict: ConflictWire | null
  /** The two `consolidate: "last-wins"` outcomes: present-and-null on both doors, like `conflict`. */
  readonly consolidated_into: number | null
  readonly superseded_path: string | null
}

/** The batch payload, in the shape BOTH doors publish. */
interface BatchPayload {
  readonly results: ReadonlyArray<OpResult>
  readonly summary: typeof SUMMARY
  readonly commit_sha: string | null
}

/**
 * Every assertion the fixture's own arithmetic implies, applied to whichever door produced it.
 *
 * One function rather than two copies, because the claim under test is that the doors AGREE — and two
 * copies of these assertions could drift into agreeing about different things. `label` names the door
 * so a failure says which one broke.
 */
const assertFixturePayload = (label: string, payload: BatchPayload): void => {
  expect(payload.summary, label).toEqual(SUMMARY)
  expect(payload.results, label).toHaveLength(20)

  // Input order, every op present, each naming its own index — the contract an agent matches results
  // back to lines with. `map` rather than a loop so a mismatch prints the whole sequence.
  expect(
    payload.results.map((result) => result.index),
    label
  ).toEqual([...Array(20).keys()])

  // Eighteen distinct paths for eighteen written ops: nothing was overwritten, and the two ops sharing
  // a title prefix with an earlier one still got their own file.
  const written = payload.results.filter((result) => result.ok && !result.deduped)
  expect(written, label).toHaveLength(18)
  expect(new Set(written.map((result) => result.path)).size, label).toBe(18)
  for (const result of written) {
    expect(result.path, label).toMatch(/\.html$/)
    expect(result.code, label).toBeNull()
    expect(result.error, label).toBeNull()
    expect(result.skipped, label).toBe(false)
  }

  /**
   * The dedupes: `ok: true`, never an error (D5), and pointing at the path the op they duplicate got in
   * THIS batch. That last clause is the intra-batch half — a store-only dedupe would have nothing to
   * point at, since neither file existed when the call began.
   */
  const deduped = payload.results.filter((result) => result.deduped)
  expect(
    deduped.map((result) => result.index),
    label
  ).toEqual(DUPLICATES.map((pair) => pair.at))
  for (const { at, of: origin } of DUPLICATES) {
    const result = payload.results[at]
    expect(result?.ok, `${label} op ${at}`).toBe(true)
    expect(result?.code, `${label} op ${at}`).toBeNull()
    expect(result?.error, `${label} op ${at}`).toBeNull()
    expect(result?.existing_path, `${label} op ${at}`).toBe(payload.results[origin]?.path)
  }

  // A commit happened, so `commit_sha` is a sha rather than the null a dedupe-only or aborted batch
  // reports.
  expect(payload.commit_sha, label).toMatch(/^[0-9a-f]{40}$/)
}

/** Every `files` row's path and event time, read after the server has let go of the database. */
const fileRows = (
  cli: Cli
): Promise<ReadonlyArray<{ path: string; event_at: string | null; gist: string }>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService
      return yield* db.all<{ path: string; event_at: string | null; gist: string }>(
        "SELECT path, event_at, gist FROM files ORDER BY path",
        []
      )
    }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
  )

/** The html files one commit touched. */
const filesInCommit = async (cli: Cli, ref: string): Promise<ReadonlyArray<string>> => {
  const output = await cli.git("show", "--name-only", "--format=", ref)
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".html"))
}

const commitCount = async (cli: Cli): Promise<number> =>
  Number.parseInt((await cli.git("rev-list", "--count", "HEAD")).trim(), 10)

describe("spec 004 success metric — the 20-op Alice fixture through memory_write_batch over real stdio", () => {
  let cli: Cli
  let payload: BatchPayload
  let commitsBefore: number
  let commitsAfter: number
  let headSubject: string
  let touched: ReadonlyArray<string>
  let rows: ReadonlyArray<{ path: string; event_at: string | null; gist: string }>
  let toolCount: number
  /** The abort probe's before/after tree digests and the wire text of its refusal. */
  let digestBeforeAbort: string
  let digestAfterAbort: string
  let commitsAfterAbort: number
  let abortText: string
  let statusAfterAbort: string
  let exit: { readonly exitCode: number; readonly envelope: Record<string, unknown> }

  beforeAll(async () => {
    /**
     * A real temp repo through the real `memhtml init`. `makeCli` builds its layer per invocation and
     * releases it (`run` ends in `Effect.scoped`), so the database is unlocked again by the time the
     * child server opens it — the only reason an in-process `memhtml init` and an out-of-process server
     * can share one repo.
     */
    cli = await makeCli()
    commitsBefore = await commitCount(cli)

    const client: Client = connect(cli.root)
    const opened = await handshake(client)
    expect(opened.protocolVersion).toBe("2025-06-18")

    const listed = await client.rpc("tools/list", {})
    toolCount = (listed.result as { readonly tools: ReadonlyArray<unknown> }).tools.length

    payload = structured(
      await client.rpc("tools/call", {
        name: "memory_write_batch",
        arguments: { ops: mcpOpsOf(FIXTURE) }
      })
    ) as unknown as BatchPayload

    commitsAfter = await commitCount(cli)
    headSubject = (await cli.git("log", "-1", "--format=%s")).trim()
    touched = await filesInCommit(cli, "HEAD")

    /**
     * The atomic abort, over the SAME session as the successful batch above.
     *
     * Deliberately after a batch that wrote 18 files, because the assertion is that the tree is
     * byte-identical — and a tree that was empty before the abort makes "unchanged" and "still empty"
     * the same observation. With a corpus present, a rollback that unlinked one file too many, or left
     * one behind, moves the digest.
     *
     * Five ops with the violation at index 2: the middle, so ops before it have already validated and
     * ops after it have not been reached. A violation at index 0 would pass on an implementation that
     * aborted before its first op no matter what.
     */
    digestBeforeAbort = await treeDigest(cli.root)
    const five = [0, 1, 2, 3, 4].map((at) => ({
      title: `Alice filed report ${at}`,
      memory_type: "semantic",
      body: `Report number ${at} says the trains ran on time. Nothing else to note.`
    }))
    const doomed: Record<string, unknown> = {
      title: "Alice filed report 2",
      memory_type: "semantic",
      // No `<mark>`: constraint 1, refused by the store's render gate before anything is written.
      article_html: "<p>A report with no claim span anywhere in its markup.</p>"
    }
    abortText = failureText(
      await client.rpc("tools/call", {
        name: "memory_write_batch",
        arguments: { ops: [five[0], five[1], doomed, five[3], five[4]] }
      })
    )
    digestAfterAbort = await treeDigest(cli.root)
    commitsAfterAbort = await commitCount(cli)
    statusAfterAbort = (await cli.git("status", "--porcelain")).trim()

    // Every row assertion below reads a settled store, so the shutdown is part of the setup.
    exit = await client.shutdown()
    rows = await fileRows(cli)
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("publishes fourteen tools, the batch among them", () => {
    expect(toolCount).toBe(14)
  })

  it("returns twenty per-op results in input order, eighteen written and two deduped", () => {
    assertFixturePayload("memory_write_batch", payload)
  })

  it("makes exactly ONE commit carrying all eighteen files", async () => {
    /**
     * The spec's central claim, and the reason the whole batch primitive exists. Asserted three ways
     * because each catches a different regression: the DELTA catches a door that looped the singular
     * write (18 commits), the FILE COUNT inside that one commit catches a batch that committed once but
     * staged one file, and the SHA identity catches a payload reporting a commit that is not the one
     * the tree now has.
     */
    expect(commitsAfter - commitsBefore).toBe(1)
    expect(touched).toHaveLength(18)
    expect(payload.commit_sha).toBe((await cli.git("rev-parse", "HEAD")).trim())
    // One subject for a batch, naming the count — not eighteen `memhtml(write)` subjects.
    expect(headSubject).toBe("memhtml(batch): 18 memories")
  })

  it("reindexes that one commit ONCE, leaving eighteen rows and no stragglers", () => {
    /**
     * The reindex COUNT is asserted at the operations tier (`apps/cli/tests/batch.test.ts`, where the
     * `Indexer` can be wrapped and counted). What is observable from out here is its RESULT, and the
     * result is the half that matters to a reader: every written path has a row, the two deduped ops
     * added none, and nothing else appeared.
     */
    expect(rows).toHaveLength(18)
    const written = payload.results
      .filter((result) => result.ok && !result.deduped)
      .map((result) => result.path)
    expect(rows.map((row) => row.path).sort()).toEqual([...written].sort())
  })

  it("carries event_at from the ONE op that authored a <time> element, and only that op", () => {
    /**
     * The batch does not bypass the authoring path: the `article_html` op's `<time datetime>` reaches
     * `files.event_at` exactly as it does through the singular write
     * (`mcp-stdio.test.ts` locks that for one memory), and the seventeen prose ops in the same commit
     * leave it NULL. Both halves, because a batch that stamped every row with the batch's own clock
     * would satisfy the first assertion alone.
     */
    const dated = rows.filter((row) => row.event_at !== null)
    expect(dated).toHaveLength(1)
    expect(dated[0]?.event_at).toBe(ALICE_EVENT_AT)
    expect(dated[0]?.path).toBe(payload.results[0]?.path)
    // And the claim came from the caller's own `<mark>`, not from an empty gist.
    expect(dated[0]?.gist).toBe("Alice moved to Paris.")
  })

  it("aborts atomically over the wire, leaving the tree byte-identical", () => {
    /**
     * "Byte-identical" taken literally — a digest over every file's path and contents — AND git's own
     * view of the same tree.
     *
     * Both, and the reason is measured rather than assumed: probed against the mutation that writes
     * during validation, `--porcelain` catches it too (it reports the leftover as `?? …`), and probed
     * against a stage-then-reset, it still reports the file. So the digest is NOT the strictly stronger
     * check it looks like on this repo, where nothing a batch writes is gitignored. What it is, is
     * INDEPENDENT of git's bookkeeping: it would still fail on a rollback that left the corpus altered
     * in a way the index agreed with, and it fails with a different signature — "these bytes moved"
     * rather than "this path is dirty". Two cheap assertions failing two ways is worth more here than
     * one, because a rollback bug is the kind that gets diagnosed from the failure text.
     */
    expect(digestAfterAbort).toBe(digestBeforeAbort)
    expect(commitsAfterAbort).toBe(commitsAfter)
    expect(statusAfterAbort).toBe("")
  })

  it("names the offending op in the abort text, with a code and no internal-error mask", () => {
    /**
     * The refusal as an AGENT receives it — the only place this text is observable, since `McpServer`
     * decides between passing a handler's message through and replacing it with its own internal-error
     * string, and that decision is invisible in-process.
     */
    expect(abortText).toContain("ERR_INVALID_MEMORY")
    // `ops[2]`, in the same index space `results[].index` uses, so the agent can find the line it sent.
    expect(abortText).toContain("ops[2]")
    expect(abortText).toContain("<mark>")
    // The consequence, which is what stops an agent hunting for a partial write to clean up.
    expect(abortText).toContain("nothing was written and no commit was made")
    expect(abortText.toLowerCase()).not.toContain("internal server error")
  })

  it("shuts the supervisor down cleanly, which is what released the database", () => {
    expect(exit.exitCode).toBe(0)
    expect(exit.envelope.type).toBe("serve.exit")
  })
})

describe("spec 004 success metric — the same fixture through `memhtml apply` on the BUILT binary", () => {
  let cli: Cli
  let scratch: string
  let payload: BatchPayload
  let mcpPayload: BatchPayload
  let commitsBefore: number
  let commitsAfter: number
  let headSubject: string
  let touched: ReadonlyArray<string>
  let rows: ReadonlyArray<{ path: string; event_at: string | null; gist: string }>
  let applyExit: number
  let applyStderr: string
  /** The malformed-line refusal: its exit code, its envelope, and the tree either side of it. */
  let refusal: Record<string, unknown>
  let refusalExit: number
  let digestBeforeRefusal: string
  let digestAfterRefusal: string
  let commitsAfterRefusal: number

  beforeAll(async () => {
    cli = await makeCli()
    scratch = await mkdtemp(join(tmpdir(), "memhtml-batch-ops-"))
    /**
     * The JSONL lives OUTSIDE the repo. A fixture file inside `$MEMHTML_ROOT` would be untracked content in
     * the tree the byte-identical assertions below hash, which would make the fixture itself part of
     * the subject.
     */
    const file = join(scratch, "ops.jsonl")
    await writeFile(file, jsonlOf(FIXTURE), "utf8")

    commitsBefore = await commitCount(cli)
    const spawned = await runBuilt(cli.root, ["apply", "--file", file])
    applyExit = spawned.exitCode
    applyStderr = spawned.stderr
    const envelope = envelopeOf(spawned)
    expect(envelope.type, `apply envelope: ${JSON.stringify(envelope).slice(0, 300)}`).toBe(
      "batch.applied"
    )
    payload = envelope.data as unknown as BatchPayload

    commitsAfter = await commitCount(cli)
    headSubject = (await cli.git("log", "-1", "--format=%s")).trim()
    touched = await filesInCommit(cli, "HEAD")
    rows = await fileRows(cli)

    /**
     * The malformed line, against the corpus the successful apply just wrote — so "nothing written"
     * is a statement about a tree with 18 files in it rather than about an empty one.
     *
     * Line 7 of ten, chosen for the same reason the MCP abort's violation sits at index 2: lines before
     * it are valid and would have applied if validation were per-line, and lines after it are valid and
     * would have applied if the refusal only skipped the bad one.
     */
    digestBeforeRefusal = await treeDigest(cli.root)
    const lines = jsonlOf(FIXTURE).trim().split("\n")
    const malformed = [
      ...lines.slice(0, 6),
      '{"op":"write","title":"Alice filed a truncated line",',
      ...lines.slice(7, 10)
    ].join("\n")
    const badFile = join(scratch, "malformed.jsonl")
    await writeFile(badFile, `${malformed}\n`, "utf8")
    const refused = await runBuilt(cli.root, ["apply", "--file", badFile])
    refusalExit = refused.exitCode
    refusal = envelopeOf(refused)
    digestAfterRefusal = await treeDigest(cli.root)
    commitsAfterRefusal = await commitCount(cli)

    /**
     * The MCP door's payload for the SAME fixture, in a SEPARATE repo, so the two doors can be compared
     * as data rather than by restating each one's numbers. A second repo rather than the first, because
     * replaying the fixture into a corpus that already holds it would dedupe all twenty ops and compare
     * two dedupe-only batches.
     */
    const other = await makeCli()
    try {
      const client: Client = connect(other.root)
      await handshake(client)
      mcpPayload = structured(
        await client.rpc("tools/call", {
          name: "memory_write_batch",
          arguments: { ops: mcpOpsOf(FIXTURE) }
        })
      ) as unknown as BatchPayload
      await client.shutdown()
    } finally {
      await other.cleanup()
    }
  })

  afterAll(async () => {
    await cli.cleanup()
    await rm(scratch, { recursive: true, force: true })
  })

  it("emits ONE `batch.applied` envelope on stdout and exits 0", () => {
    expect(applyExit).toBe(0)
    // stdout was parsed as exactly one envelope in `beforeAll`; stderr is where logs belong, and a
    // command that wrote its envelope there instead would have failed that parse.
    expect(applyStderr).not.toContain('"type"')
  })

  it("returns twenty per-op results in input order, eighteen written and two deduped", () => {
    assertFixturePayload("memhtml apply", payload)
  })

  it("makes exactly ONE commit carrying all eighteen files", async () => {
    expect(commitsAfter - commitsBefore).toBe(1)
    expect(touched).toHaveLength(18)
    expect(payload.commit_sha).toBe((await cli.git("rev-parse", "HEAD")).trim())
    expect(headSubject).toBe("memhtml(batch): 18 memories")
  })

  it("indexes the same eighteen files, with event_at on the one authored op", () => {
    expect(rows).toHaveLength(18)
    const dated = rows.filter((row) => row.event_at !== null)
    expect(dated).toHaveLength(1)
    expect(dated[0]?.event_at).toBe(ALICE_EVENT_AT)
    expect(dated[0]?.gist).toBe("Alice moved to Paris.")
  })

  it("agrees with `memory_write_batch` on the corpus it produced", () => {
    /**
     * The pair, which is the success metric's own wording ("the same ingest through `memhtml apply` matches").
     * Compared as the whole payload minus the sha — two repos cannot share a commit sha, and everything
     * else is a function of the fixture. If the doors ever disagree about a path, a dedupe target, or the
     * arithmetic, this is the assertion that says so in one diff.
     */
    const shaless = (value: BatchPayload) => ({ results: value.results, summary: value.summary })
    expect(shaless(payload)).toEqual(shaless(mcpPayload))
    // And both really committed — otherwise the comparison above could hold between two aborts.
    expect(payload.commit_sha).not.toBe(mcpPayload.commit_sha)
    expect(mcpPayload.commit_sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it("refuses a malformed line 7 with exit 2, naming the line, leaving the tree byte-identical", () => {
    /**
     * AC-6-4's whole-file-before-any-op contract, at the only tier where the exit code exists. Exit 2
     * rather than 1 is the load-bearing half: a usage error says the caller's FILE is wrong and the
     * corpus is fine, and an agent that read 1 would go looking for damage.
     */
    expect(refusalExit).toBe(2)
    expect(refusal.code).toBe("ERR_INVALID_FLAG")
    expect(String(refusal.error)).toContain("line 7")
    expect(digestAfterRefusal).toBe(digestBeforeRefusal)
    expect(commitsAfterRefusal).toBe(commitsAfter)
  })
})

/**
 * The recursive KEY SHAPE of a value: an object becomes its sorted keys mapped to their own shapes, and
 * a leaf becomes a marker for what kind of thing it is.
 *
 * Shapes rather than values, because the two doors run in two repos and cannot share a commit sha — and
 * shapes rather than key LISTS alone, because a key set cannot tell `conflict: null` from
 * `conflict: {…}`, and those are the two states the nested struct has. `null` gets its own marker rather
 * than collapsing into `"object"` for exactly that reason.
 */
const keyShapeOf = (value: unknown): unknown => {
  if (value === null) return "null"
  if (Array.isArray(value)) return value.map(keyShapeOf)
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, keyShapeOf(record[key])])
    )
  }
  return typeof value
}

/**
 * The PARITY ORACLE for the two doors' per-op wire shape.
 *
 * `memhtml apply`'s `opPayload` (`apps/cli/src/apply.ts:360-386`) and `memory_write_batch`'s `wireReport`
 * (`apps/mcp/src/handlers.ts:240-266`) are two hand-written camel→snake mappers over one
 * `BatchOpReport`, and both of their doc comments claim the payloads are byte-comparable so an agent
 * that has parsed one has parsed the other. Nothing checked it: the mappers are private, so no unit test
 * can compare them, and the fixture pair at the top of this file has no conflicts in it — every op there
 * reports `conflict: null`, which is the one state where a divergence inside the nested struct is
 * invisible.
 *
 * So this drives BOTH doors over one conflict-bearing fixture and asserts the shape three ways, each
 * catching a failure the others cannot:
 *
 * 1. **Each door against a PINNED key set.** Door-to-door equality alone passes when both mappers drift
 *    the same way — a key added to one and copy-pasted into the other is exactly how these two stay
 *    identical, and exactly how they would both leave the documented shape together. A literal list
 *    makes that show up as an edit to this file. It is the same oracle `apps/cli/tests/apply.test.ts:167`
 *    applies to one door, applied to both and extended one level down.
 * 2. **The NESTED conflict key set, on an op that has one.** The `batchIndex` → `batch_index` rename is
 *    performed twice, once per door, and it is the only rename either mapper does below the top level.
 * 3. **Door-to-door recursive shape equality, per op.** The pinned sets cannot see a door that reported
 *    a conflict where the other reported null: both spellings carry the `conflict` key. This is the
 *    assertion that says the doors made the same FINDINGS in the same places, not merely that they can
 *    both spell a conflict.
 *
 * Over the BUILT binary and a real stdio session, because that is the only tier where both doors exist
 * at once — one is a process writing an envelope and the other is a server answering a `tools/call`.
 */
describe("`memhtml apply` and `memory_write_batch` publish ONE per-op wire shape, conflicts included", () => {
  /**
   * The eleven keys a per-op result carries, sorted, on BOTH doors.
   *
   * Spelled out rather than derived from one door's output, which would make the assertion "this door
   * agrees with itself". `conflict` is in the list because it is present-and-null rather than optional —
   * a client reading an absent key cannot tell "this op contradicts nothing" from "this build does not
   * check", and the two lead to opposite decisions about whether to go looking.
   */
  const OP_KEYS = [
    "code",
    "conflict",
    "consolidated_into",
    "deduped",
    "error",
    "existing_path",
    "index",
    "ok",
    "path",
    "skipped",
    "superseded_path"
  ] as const

  /** The conflict struct's three keys, sorted. `batch_index` is the renamed `batchIndex`. */
  const CONFLICT_KEYS = ["batch_index", "claim", "path"] as const

  /** The claim seeded in a FIRST batch, so the probe's op 0 has a stored occupant to match. */
  const SEED = "The parity ceiling is 64."

  /**
   * The probe: four ops chosen so both conflict spellings and both no-conflict reasons appear in one
   * batch, which is what makes assertion 3 above able to fail.
   *
   * - op 0 restates {@link SEED}'s frame, so it is a STORE match: `path` set, `batch_index` null.
   * - op 1 opens a frame nothing holds, so it reports no conflict.
   * - op 2 restates op 1's frame, so it is an INTRA-BATCH match: `path` null, `batch_index` 1.
   * - op 3 states no frame shape at all (`frameKeyOf` refuses it), so it is the other null reason.
   *
   * Both null reasons matter: an op that MATCHED NOTHING and an op that was never KEYED reach
   * `conflict: null` through different branches of `detectFrameConflicts`
   * (`apps/cli/src/operations.ts:416-469`), and a mapper is downstream of both.
   */
  const PROBE: ReadonlyArray<Op> = [
    { title: "Parity ceiling later", type: "semantic", body: "The parity ceiling is 128." },
    {
      title: "Parity budget first",
      type: "semantic",
      body: "The parity budget is per-connection."
    },
    { title: "Parity budget second", type: "semantic", body: "The parity budget is per-request." },
    {
      title: "Parity ledger review",
      type: "episodic",
      body: "Alice reviewed the parity ledger twice on Tuesday."
    }
  ]

  let cli: Cli
  let scratch: string
  let applied: BatchPayload
  let called: BatchPayload

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "memhtml-batch-parity-"))

    /**
     * Door 1 — `memhtml apply --detect-conflicts` on the BUILT binary, over two files: the seed, then the
     * probe. Two invocations rather than one file of five lines, because op 0's finding must be a STORE
     * match — and a claim written in the same batch is an intra-batch match instead, which is the other
     * spelling and would leave the store branch untested on this door.
     */
    cli = await makeCli()
    const seedFile = join(scratch, "seed.jsonl")
    await writeFile(
      seedFile,
      jsonlOf([{ title: "Parity ceiling now", type: "semantic", body: SEED }]),
      "utf8"
    )
    const seeded = await runBuilt(cli.root, ["apply", "--file", seedFile])
    expect(envelopeOf(seeded).type, `seed: ${seeded.stdout.slice(0, 300)}`).toBe("batch.applied")

    const probeFile = join(scratch, "probe.jsonl")
    await writeFile(probeFile, jsonlOf(PROBE), "utf8")
    const spawned = await runBuilt(cli.root, ["apply", "--file", probeFile, "--detect-conflicts"])
    const envelope = envelopeOf(spawned)
    expect(envelope.type, `probe: ${spawned.stdout.slice(0, 300)}`).toBe("batch.applied")
    applied = envelope.data as unknown as BatchPayload

    /**
     * Door 2 — the same two batches over real stdio, in a SEPARATE repo. A second repo because replaying
     * the seed into a corpus that already holds it would dedupe rather than write, and a deduped op is a
     * different report than a written one.
     */
    const other = await makeCli()
    try {
      const client: Client = connect(other.root)
      await handshake(client)
      structured(
        await client.rpc("tools/call", {
          name: "memory_write_batch",
          arguments: {
            ops: mcpOpsOf([{ title: "Parity ceiling now", type: "semantic", body: SEED }])
          }
        })
      )
      called = structured(
        await client.rpc("tools/call", {
          name: "memory_write_batch",
          arguments: { ops: mcpOpsOf(PROBE), detect_conflicts: true }
        })
      ) as unknown as BatchPayload
      await client.shutdown()
    } finally {
      await other.cleanup()
    }
  })

  afterAll(async () => {
    await cli.cleanup()
    await rm(scratch, { recursive: true, force: true })
  })

  /**
   * The fixture really produced what the parity assertions need to be worth running.
   *
   * First, and it is not a formality: every assertion below is an equality between two shapes, and two
   * batches that both reported nothing would satisfy all of them. This is the test that says the probe
   * lit up — one store match, one intra-batch match, two nulls for two different reasons — on BOTH
   * doors, so the shape comparisons are comparing populated structs.
   */
  it("lights up both conflict spellings and both no-conflict reasons, on both doors", () => {
    for (const [label, payload] of [
      ["memhtml apply", applied],
      ["memory_write_batch", called]
    ] as const) {
      expect(payload.summary, label).toEqual({
        total: 4,
        written: 4,
        deduped: 0,
        failed: 0,
        skipped: 0,
        consolidated: 0
      })
      // Op 0 matched the SEEDED memory: a path, and no batch index because that memory predates the call.
      expect(payload.results[0]?.conflict?.path, label).toMatch(/\.html$/)
      expect(payload.results[0]?.conflict?.batch_index, label).toBeNull()
      expect(payload.results[0]?.conflict?.claim, label).toBe(SEED)
      // Op 1 opened its slot, so nothing to report; op 2 restated it and names op 1 with no path.
      expect(payload.results[1]?.conflict, label).toBeNull()
      expect(payload.results[2]?.conflict?.batch_index, label).toBe(1)
      expect(payload.results[2]?.conflict?.path, label).toBeNull()
      expect(payload.results[3]?.conflict, label).toBeNull()
      // PROPOSE-ONLY: a conflict is a note, so all four ops wrote and the batch committed.
      expect(
        payload.results.every((result) => result.ok),
        label
      ).toBe(true)
      expect(payload.commit_sha, label).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it("emits the same eleven per-op keys on both doors, and the same three inside a conflict", () => {
    for (const [label, payload] of [
      ["memhtml apply", applied],
      ["memory_write_batch", called]
    ] as const) {
      for (const result of payload.results) {
        expect(Object.keys(result as object).sort(), `${label} op ${result.index}`).toEqual([
          ...OP_KEYS
        ])
      }
      /**
       * The nested set, from the two ops that HAVE a conflict rather than from all four — a null carries
       * no keys, so folding it in would assert the empty set and pass on a door that reported nothing.
       */
      const conflicts = payload.results
        .map((result) => result.conflict)
        .filter((conflict): conflict is ConflictWire => conflict !== null)
      expect(conflicts, label).toHaveLength(2)
      for (const conflict of conflicts) {
        expect(Object.keys(conflict as object).sort(), label).toEqual([...CONFLICT_KEYS])
      }
    }
  })

  it("produces the same per-op shape on both doors, conflict struct included", () => {
    /**
     * The doors against EACH OTHER, per op, as recursive shapes. The pinned key sets above cannot see a
     * door that reported a conflict where the other reported null — `conflict` is a key on both — and
     * this is the assertion that can, because `"null"` and a three-key object are different shapes.
     *
     * `results` as one array rather than op by op, so a divergence prints the whole sequence and a
     * reader can see whether one op moved or the whole shape did.
     */
    expect(applied.results.map(keyShapeOf)).toEqual(called.results.map(keyShapeOf))
    // And the envelope around them, so a divergence in `summary` or `commit_sha` is not silently allowed.
    expect(keyShapeOf(applied)).toEqual(keyShapeOf(called))
  })
})

describe("the manifest guide, as the BUILT binary emits it with no repo and no arguments", () => {
  /**
   * The one thing `apps/cli/tests/apply.test.ts` structurally cannot assert.
   *
   * That suite calls `run([])` in-process and proves the manifest ARM carries the guide. It cannot prove
   * that the shipped binary reaches that arm from a bare argv — `bin.ts`, the argv slice, the single
   * JSON envelope on stdout (the binary's only output, with no flag to ask for it), the exit code, and
   * the guide surviving the build all sit outside it. And the guide's own
   * first claim is that it answers "on a machine with no repo, no database, and no credentials", which
   * is only testable by not giving it one: no `--repo`, no temp dir, no `memhtml init`.
   */
  it("answers a bare `memhtml` with every guide topic and exit 0", async () => {
    const spawned = await runBare()
    expect(spawned.exitCode).toBe(0)
    const envelope = envelopeOf(spawned)
    expect(envelope.type).toBe("cli.manifest")
    const data = envelope.data as {
      readonly guide: ReadonlyArray<{ readonly topic: string; readonly body: string }>
    }
    /**
     * The topic list comes from `GUIDE_TOPICS` — the built package's own export — rather than a literal
     * here. What this case is FOR is that the guide survives the build and reaches a bare argv from the
     * shipped binary, and a hardcoded list makes adding a topic look like that mechanism breaking. The
     * per-topic content assertions below are what stop this degenerating into `x === x`: a spawned
     * binary whose guide arrived empty or truncated fails them.
     */
    expect(data.guide.map((block) => block.topic)).toEqual([...GUIDE_TOPICS])
    /**
     * And the batch topic names the command it is telling the agent to run. The topic LIST alone would
     * pass on five empty bodies.
     */
    const batch = data.guide.find((block) => block.topic === "when-to-batch")
    expect(batch?.body).toContain("memhtml apply")
    /**
     * The `conflicts` topic likewise, and specifically the PROPOSE-ONLY sentence — the one claim an
     * agent acts wrongly on if it is missing. A topic present with prose that omitted it would leave an
     * agent hand-rolling the archiving the design deliberately refuses, which is worse than no topic.
     */
    const conflicts = data.guide.find((block) => block.topic === "conflicts")
    expect(conflicts?.body).toContain("--detect-conflicts")
    expect(conflicts?.body).toContain("THE ASSIST NEVER CHANGES WHAT IS WRITTEN")
    /**
     * The `code-mode` topic, and specifically the guest path a script has to import from. That string is
     * the one thing in the block an agent cannot derive or guess — a wrong path is a script that fails
     * at its first line — and it must match `GUEST_LIB` in `apps/cli/src/exec.ts`.
     */
    const codeMode = data.guide.find((block) => block.topic === "code-mode")
    expect(codeMode?.body).toContain("/workspace/lib/corpus.mjs")
    expect(codeMode?.body).toContain("memhtml exec")
  })
})
