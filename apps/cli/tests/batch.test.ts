import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { Git, Indexer, IndexRecorder, Store } from "@memhtml/cli"
import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect, Layer, Logger } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { type BatchWriteParams, type BatchWriteResult, batchWrite } from "../src/operations.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * `batchWrite` over the REAL layer graph: one commit, one reindex, per-op results in input order.
 *
 * The composition under test is `layerAppWith` — the same `layerCore` production builds — because
 * the properties being asserted are properties of the COMPOSITION and not of the store: the reindex
 * count is a fact about how this function calls `indexer.update()`, the dedupe answers come from the
 * real `files_content_hash_active` index via the recorder's own lookup, and the session links are
 * real rows. A hand-assembled graph or a faked indexer would verify the shape of those calls and
 * miss every state transition behind them, which is this repo's standing lesson.
 *
 * The reindex count is taken by WRAPPING the real indexer rather than replacing it: `update()` still
 * runs, still reads `git diff`, still moves the watermark. Replacing it would make "reindexed once"
 * true of a function that indexed nothing.
 */

let clis: Array<Cli> = []

afterEach(async () => {
  const open = clis
  clis = []
  await Promise.all(open.map((cli) => cli.cleanup()))
})

/** Everything the harness's layer supplies. What `Effect.provide` discharges below. */
type AppServices = Layer.Success<Cli["layer"]>

/**
 * A counting wrapper over the real `Indexer`, plus the layer that installs it.
 *
 * `Layer.effect(Indexer)` reading `Indexer` from its own context and `provideMerge`-ing the base
 * under it — verified 2026-08-04 that the wrapper wins and the inner read resolves to the base's
 * service, so `update()` still does the real work. A `Layer.succeed` with a hand-built shape would
 * count calls to something that indexed nothing.
 */
const countingIndexer = (base: Layer.Layer<AppServices>) => {
  const calls: Array<string> = []
  const layer = Layer.effect(Indexer)(
    Effect.gen(function* () {
      const real = yield* Indexer
      return {
        ...real,
        update: (opts: Parameters<typeof real.update>[0]) => {
          calls.push("update")
          return real.update(opts)
        }
      }
    })
  ).pipe(Layer.provideMerge(base))
  return { calls, layer }
}

/** A harness whose `run` counts reindexes. */
const withCounter = async () => {
  const cli = await makeCli()
  clis.push(cli)
  const counted = countingIndexer(cli.layer)
  return {
    root: cli.root,
    calls: counted.calls,
    run: <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
      Effect.runPromise(Effect.provide(effect, counted.layer))
  }
}

/** One op, with only the fields a test cares about named. */
const op = (overrides: Record<string, unknown> = {}) => ({
  title: "A remembered fact",
  claim: "The claim this memory asserts.",
  memoryType: "semantic",
  ...overrides
})

const batch = (params: Partial<BatchWriteParams> & { readonly ops: BatchWriteParams["ops"] }) =>
  batchWrite(params as BatchWriteParams)

/** Article markup with prose but no claim span — constraint 1's exact violation. */
const NO_MARK = "<p>No mark at all.</p>"

const badOp = (title: string) => op({ title, claim: "", articleHtml: NO_MARK })

/** Every `.html` on disk under the repo, excluding the scaffold's own `README.html`. */
const htmlOnDisk = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .filter((path) => path !== "README.html")
    .sort()
}

const commitCount = Effect.gen(function* () {
  const git = yield* Git
  return Number((yield* git.run(["rev-list", "--count", "HEAD"])).trim())
})

const lastSubject = Effect.gen(function* () {
  const git = yield* Git
  return (yield* git.run(["log", "-1", "--format=%s"])).trim()
})

describe("batchWrite: one commit, one reindex", () => {
  it("writes three memories in ONE commit with ONE reindex", async () => {
    const cli = await withCounter()
    const before = await cli.run(commitCount)

    const result = await cli.run(
      batch({
        ops: [
          op({ title: "First fact", claim: "One." }),
          op({ title: "Second fact", claim: "Two." }),
          op({ title: "Third fact", claim: "Three." })
        ]
      })
    )

    // The two counts the primitive exists for. Three `memhtml write` calls would be three commits and
    // three `git diff`s; this is one of each.
    expect(await cli.run(commitCount)).toBe(before + 1)
    expect(cli.calls.length).toBe(1)
    expect(await cli.run(lastSubject)).toBe("memhtml(batch): 3 memories")

    expect(result.results.map((entry) => entry.index)).toEqual([0, 1, 2])
    expect(result.summary).toEqual({
      total: 3,
      written: 3,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect(result.commitSha).not.toBeNull()
    expect((await htmlOnDisk(cli.root)).length).toBe(3)
  })

  it("makes every written memory findable, so the ONE reindex really projected all three", async () => {
    /**
     * The assertion a fake indexer could not make. One `indexer.update()` has to project all three
     * files, not just the last, and it does because it reads the whole commit's diff rather than a
     * list of paths the batch handed it.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Alpha the first", claim: "Alpha." }),
          op({ title: "Beta the second", claim: "Beta." }),
          op({ title: "Gamma the third", claim: "Gamma." })
        ]
      })
    )
    const listed = await cli.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* Effect.forEach(result.results, (entry) =>
          store.readMemory(entry.path ?? "").pipe(Effect.map((read) => read.doc.article.gist))
        )
      })
    )
    expect(listed).toEqual(["Alpha.", "Beta.", "Gamma."])

    const { listMemories } = await import("../src/operations.js")
    const page = await cli.run(listMemories({ limit: 50 }))
    expect(page.files.map((file) => file.gist).sort()).toEqual(["Alpha.", "Beta.", "Gamma."])
  })

  it("does NOT reindex a batch that wrote nothing", async () => {
    /**
     * A dedupe-only batch commits nothing, so the index already describes the tree. Reindexing it
     * would move `index_state.head_sha` for a commit that never happened — the same reason
     * `writeMemory` guards on `result.created`.
     */
    const cli = await withCounter()
    await cli.run(batch({ ops: [op({ title: "The original", claim: "One fact." })] }))
    expect(cli.calls.length).toBe(1)

    const again = await cli.run(
      batch({ ops: [op({ title: "A different title", claim: "One fact." })] })
    )
    expect(again.results[0]).toMatchObject({ ok: true, deduped: true })
    expect(again.commitSha).toBeNull()
    // Still ONE: the second batch added no call.
    expect(cli.calls.length).toBe(1)
  })

  it("does NOT reindex an atomic abort", async () => {
    const cli = await withCounter()
    const result = await cli.run(
      batch({ ops: [op({ title: "Fine", claim: "Ok." }), badOp("Bad")] })
    )
    expect(result.summary.failed).toBe(1)
    expect(cli.calls.length).toBe(0)
    expect(await htmlOnDisk(cli.root)).toEqual([])
  })

  it("records ONE session link per written path, and none for a deduped op", async () => {
    /**
     * The dedupe is onto a file a DIFFERENT session wrote in an earlier batch, which is what makes
     * the distinction observable: a link recorded per RESULT would claim this session wrote a file
     * it only matched, putting a `wrote` row against a path this batch did not create. Deduping
     * within the same batch would produce the same row set either way, since the deduped op reports
     * the sibling's path and `recordLink` is idempotent on `(path, session, kind, at)`.
     */
    const cli = await withCounter()
    const earlier = await cli.run(
      batch({
        sessionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        ops: [op({ title: "Written earlier", claim: "An old fact." })]
      })
    )
    const earlierPath = earlier.results[0]?.path ?? ""

    const result = await cli.run(
      batch({
        sessionId: "f7e32699-d45b-4248-8ae6-894dfc606f49",
        ops: [
          op({ title: "Linked one", claim: "One." }),
          op({ title: "Linked two", claim: "Two." }),
          // Same content as the earlier batch's file, so it dedupes onto it and creates nothing.
          op({ title: "A third title", claim: "An old fact." })
        ]
      })
    )
    expect(result.summary).toEqual({
      total: 3,
      written: 2,
      deduped: 1,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect(result.results[2]).toMatchObject({ ok: true, deduped: true, path: earlierPath })

    const { traceLinks } = await import("../src/operations.js")
    const links = await cli.run(traceLinks({ sessionId: "f7e32699-d45b-4248-8ae6-894dfc606f49" }))
    // Two links for the two files THIS batch wrote. The third op wrote nothing, so a `wrote` link
    // for `earlierPath` would be a note about something this session did not do.
    expect(links.links.map((link) => link.path).sort()).toEqual(
      [result.results[0]?.path ?? "", result.results[1]?.path ?? ""].sort()
    )
    expect(links.links.every((link) => link.linkKind === "wrote")).toBe(true)
    // And the earlier file's own link still names only the session that actually wrote it.
    const earlierLinks = await cli.run(traceLinks({ path: earlierPath }))
    expect(earlierLinks.links.map((link) => link.sessionId)).toEqual([
      "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
    ])
  })
})

describe("decode failures are per-op, in the caller's index space", () => {
  it("refuses an unknown memory_type on op 2 and reports it at index 1", async () => {
    /**
     * Decode is the operations layer's own fold and the store never sees it — so a bad
     * `memory_type` has to be caught here, and its report has to land at the CALLER's index. The
     * bug this excludes is an index space that shifts by one for every op the store never saw.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Valid one", claim: "One." }),
          op({ title: "Bad type", claim: "Two.", memoryType: "nonsense" }),
          op({ title: "Valid three", claim: "Three." })
        ]
      })
    )
    expect(result.results[1]?.index).toBe(1)
    expect(result.results[1]?.code).toBe("ERR_INVALID_MEMORY")
    expect(result.results[1]?.error).toContain("unknown memory type: nonsense")
    // Atomic mode: nothing written, ops 0 and 2 skipped.
    expect(result.summary).toEqual({
      total: 3,
      written: 0,
      deduped: 0,
      failed: 1,
      skipped: 2,
      consolidated: 0
    })
    expect(cli.calls.length).toBe(0)
    expect(await htmlOnDisk(cli.root)).toEqual([])
  })

  it("keeps later ops at their own index when an earlier one fails decode in continue mode", async () => {
    // The index-shift bug, made visible: op 2 must report at index 2 even though the store only
    // ever saw two ops.
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        continueOnError: true,
        ops: [
          op({ title: "Survivor one", claim: "One." }),
          op({ title: "Bad type", claim: "Two.", memoryType: "nonsense" }),
          op({ title: "Survivor two", claim: "Three." })
        ]
      })
    )
    expect(result.results.map((entry) => entry.index)).toEqual([0, 1, 2])
    expect(result.results[0]).toMatchObject({ ok: true, path: "areas/inbox/survivor-one.html" })
    expect(result.results[1]).toMatchObject({ ok: false, code: "ERR_INVALID_MEMORY" })
    expect(result.results[2]).toMatchObject({ ok: true, path: "areas/inbox/survivor-two.html" })
    expect(result.summary).toEqual({
      total: 3,
      written: 2,
      deduped: 0,
      failed: 1,
      skipped: 0,
      consolidated: 0
    })
    // Still ONE commit and ONE reindex for the survivors.
    expect(cli.calls.length).toBe(1)
    expect(result.commitSha).not.toBeNull()
  })

  it("refuses a bad task due date per op, through the SAME decoder the singular write uses", async () => {
    /**
     * The message is asserted verbatim because there are TWO layers that would refuse this value and
     * they say different things. `decodeDueAt` — the singular write's own decoder, shared by this
     * fold — names the field and the expected forms; the store's render gate, one layer down, would
     * refuse the rendered `<meta name="memhtml-due" …>` instead. Both produce `ERR_INVALID_MEMORY`, so
     * a code-only assertion cannot tell a batch that reuses the decoder from one that skipped it and
     * fell through to the gate. Probed 2026-08-04 by deleting the decode: the gate caught it and the
     * loose assertion still passed.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        continueOnError: true,
        ops: [
          op({ title: "A task", claim: "Do it.", memoryType: "task", dueAt: "Aug 9 2026" }),
          op({ title: "A fine memory", claim: "Fine." })
        ]
      })
    )
    expect(result.results[0]?.code).toBe("ERR_INVALID_MEMORY")
    expect(result.results[0]?.error).toBe(
      "invalid memory: due date is not an ISO date or datetime: Aug 9 2026. Expected YYYY-MM-DD or YYYY-MM-DDThh:mm:ssZ"
    )
    expect(result.results[1]?.ok).toBe(true)
  })

  it("stamps the BATCH's provenance into every file head and onto the one commit", async () => {
    /**
     * The batch call carries the session the agent is in, and the ops carry none — which is the
     * shape both doors produce (`memhtml apply --session-id`, and MCP's tool-level provenance). Without
     * the fallback the files would land with no `memhtml-session` at all and the commit with no
     * `Memhtml-Session` trailer: the writes would be unattributable, which is what design §7's two-plane
     * link exists to prevent.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        sessionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        promptId: "pr_batch",
        ops: [
          op({ title: "Attributed one", claim: "One." }),
          op({ title: "Attributed two", claim: "Two." })
        ]
      })
    )
    const heads = await cli.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* Effect.forEach(result.results, (entry) =>
          store.readMemory(entry.path ?? "").pipe(Effect.map((read) => read.doc.metas.sessionId))
        )
      })
    )
    expect(heads).toEqual([
      "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
      "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
    ])
    const body = await cli.run(
      Effect.gen(function* () {
        const git = yield* Git
        return yield* git.run(["log", "-1", "--format=%B"])
      })
    )
    expect(body).toContain("Memhtml-Session: bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb")
    expect(body).toContain("Memhtml-Prompt: pr_batch")
  })

  it("lets an op's OWN provenance win over the batch's", async () => {
    // The more specific statement about where one memory came from — a `memhtml apply` file replaying a
    // previous session's writes names its session per line.
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        sessionId: "cccccccc-3333-4333-8333-cccccccccccc",
        ops: [
          op({
            title: "Own session",
            claim: "Mine.",
            sessionId: "dddddddd-4444-4444-8444-dddddddddddd"
          }),
          op({ title: "Batch session", claim: "Theirs." })
        ]
      })
    )
    const heads = await cli.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* Effect.forEach(result.results, (entry) =>
          store.readMemory(entry.path ?? "").pipe(Effect.map((read) => read.doc.metas.sessionId))
        )
      })
    )
    expect(heads).toEqual([
      "dddddddd-4444-4444-8444-dddddddddddd",
      "cccccccc-3333-4333-8333-cccccccccccc"
    ])
  })

  it("refuses a bad task status through the shared decoder too", async () => {
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        continueOnError: true,
        ops: [op({ title: "A task", claim: "Do it.", memoryType: "task", taskStatus: "maybe" })]
      })
    )
    expect(result.results[0]?.error).toContain("unknown task status: maybe")
  })
})

describe("the render gate reaches the doors as a per-op code (AC-6-8)", () => {
  it("maps a gate refusal to ERR_INVALID_MEMORY with the violation text", async () => {
    // Through `codeFor`/`messageFor`, the SAME mapping every envelope error takes — so `memhtml apply`
    // and `memory_write_batch` cannot report different codes for one refused op.
    const cli = await withCounter()
    const result = await cli.run(
      batch({ continueOnError: true, ops: [badOp("Refused"), op({ title: "Fine", claim: "Ok." })] })
    )
    expect(result.results[0]).toMatchObject({ index: 0, ok: false, code: "ERR_INVALID_MEMORY" })
    expect(result.results[0]?.error).toContain("no <mark>")
    expect(result.results[1]?.ok).toBe(true)
    expect(result.summary).toEqual({
      total: 2,
      written: 1,
      deduped: 0,
      failed: 1,
      skipped: 0,
      consolidated: 0
    })
  })

  it("reports every op even when all of them fail, committing and indexing nothing", async () => {
    const cli = await withCounter()
    const result = await cli.run(
      batch({ continueOnError: true, ops: [badOp("Bad one"), badOp("Bad two")] })
    )
    expect(result.results.map((entry) => entry.code)).toEqual([
      "ERR_INVALID_MEMORY",
      "ERR_INVALID_MEMORY"
    ])
    expect(result.commitSha).toBeNull()
    expect(cli.calls.length).toBe(0)
  })
})

describe("the fold's own properties reach the operations layer intact", () => {
  it("dedupes op 2 onto op 1 against the REAL content-hash index", async () => {
    // The store's dedupe hook here is the recorder's `activePathForHash` over real SQL, not a Map —
    // so this also pins that the intra-batch map and the index's own predicate agree.
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "One title", claim: "The same fact." }),
          op({ title: "Quite another", claim: "The same fact." })
        ]
      })
    )
    expect(result.results[1]).toMatchObject({
      ok: true,
      deduped: true,
      path: "areas/inbox/one-title.html",
      existingPath: "areas/inbox/one-title.html"
    })
    expect(await htmlOnDisk(cli.root)).toEqual(["areas/inbox/one-title.html"])
  })

  it("gives two same-titled ops distinct paths, both findable after the one reindex", async () => {
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Same title", claim: "One fact." }),
          op({ title: "Same title", claim: "Another fact." })
        ]
      })
    )
    expect(result.results.map((entry) => entry.path)).toEqual([
      "areas/inbox/same-title.html",
      "areas/inbox/same-title-2.html"
    ])
    const { listMemories } = await import("../src/operations.js")
    const page = await cli.run(listMemories({ limit: 50 }))
    // Both rows in SQL: one reindex projected both, and neither clobbered the other.
    expect(page.files.map((file) => file.path).sort()).toEqual([
      "areas/inbox/same-title-2.html",
      "areas/inbox/same-title.html"
    ])
  })

  it("writes two identical tasks as two files, exempt from dedup", async () => {
    const cli = await withCounter()
    const result: BatchWriteResult = await cli.run(
      batch({
        ops: [
          op({ title: "Drain the VIP", claim: "Do the thing.", memoryType: "task" }),
          op({ title: "Drain the VIP", claim: "Do the thing.", memoryType: "task" })
        ]
      })
    )
    expect(result.summary).toEqual({
      total: 2,
      written: 2,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect(new Set(result.results.map((entry) => entry.path)).size).toBe(2)

    const { listTasks } = await import("../src/operations.js")
    const tasks = await cli.run(listTasks({ limit: 50 }))
    expect(tasks.tasks.length).toBe(2)
  })

  it("returns an empty result and touches nothing for an empty op list", async () => {
    const cli = await withCounter()
    const result = await cli.run(batch({ ops: [] }))
    expect(result).toEqual({
      results: [],
      summary: { total: 0, written: 0, deduped: 0, failed: 0, skipped: 0, consolidated: 0 },
      commitSha: null
    })
    expect(cli.calls.length).toBe(0)
  })
})

/**
 * The `detect_conflicts` assist (AC-1-2): propose-only frame matching on the batch door.
 *
 * Every test in this block asserts TWO things — what the report says, and that the write landed
 * anyway. The second half is the contract: an assist that reported correctly while quietly refusing,
 * archiving, or reordering a write would pass any test that only read `conflict`, and it would be the
 * exact failure the propose-only design exists to prevent. So `htmlOnDisk` / `listMemories` appears
 * beside every conflict assertion rather than in a separate "and it still writes" test that a future
 * edit could delete on its own.
 *
 * Over the real layer graph for the reason the block above is: the matches come from real `files` rows
 * written by a real projection through migration 0009's real index, so a test that passes proves the
 * assist queries what the indexer actually wrote. A faked recorder would assert the shape of the call
 * and miss whether the column it reads is ever populated.
 */
describe("batchWrite: the detect_conflicts assist", () => {
  /** Two claims occupying ONE frame slot: same subject and relation, different values. */
  const CEILING_64 = "The pool ceiling is 64."
  const CEILING_128 = "The pool ceiling is 128."
  /** A third value in the same slot, for the "which one is reported" case. */
  const CEILING_256 = "The pool ceiling is 256."

  it("reports nothing at all when the flag is absent, on ops that WOULD conflict", async () => {
    /**
     * The flag-off lock at the operations layer, and it is deliberately run over a batch that would
     * light up with the flag on — two ops sharing one frame key. A flag-off test over non-conflicting
     * ops would pass against an implementation whose default was ON, since there would be nothing to
     * find either way.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Ceiling now", claim: CEILING_64 }),
          op({ title: "Ceiling later", claim: CEILING_128 })
        ]
      })
    )

    expect(result.results.every((entry) => entry.conflict === undefined)).toBe(true)
    expect(result.summary).toEqual({
      total: 2,
      written: 2,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect((await htmlOnDisk(cli.root)).length).toBe(2)
  })

  it("names the ACTIVE memory a claim contradicts, and writes the contradicting memory anyway", async () => {
    /**
     * The store-match case, end to end: the first batch's memory has to be COMMITTED and PROJECTED
     * before the second batch can find it, so this also proves the assist reads rows the real indexer
     * wrote rather than anything the batch held in memory.
     */
    const cli = await withCounter()
    const first = await cli.run(batch({ ops: [op({ title: "Ceiling now", claim: CEILING_64 })] }))
    const storedPath = first.results[0]?.path

    const second = await cli.run(
      batch({
        ops: [op({ title: "Ceiling later", claim: CEILING_128 })],
        detectConflicts: true
      })
    )

    const conflict = second.results[0]?.conflict
    // The PATH, so the caller can go read or correct it — and the CLAIM, so it can decide without.
    expect(conflict?.path).toBe(storedPath)
    expect(conflict?.claim).toBe(CEILING_64)
    // A store match is not an intra-batch one, and the null is how a caller tells them apart.
    expect(conflict?.batchIndex).toBeNull()

    // PROPOSE-ONLY. The op reported a conflict and still wrote: ok, a path, a commit, and BOTH
    // memories on disk and in SQL afterwards. This is the assertion the whole design rests on.
    expect(second.results[0]?.ok).toBe(true)
    expect(second.results[0]?.path).not.toBeUndefined()
    expect(second.summary).toEqual({
      total: 1,
      written: 1,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect(second.commitSha).not.toBeNull()
    expect((await htmlOnDisk(cli.root)).length).toBe(2)

    const { listMemories } = await import("../src/operations.js")
    const page = await cli.run(listMemories({ limit: 50 }))
    expect(page.files.map((file) => file.gist).sort()).toEqual([CEILING_128, CEILING_64])
  })

  it("names the EARLIER op when two ops in one batch share a slot, and writes both", async () => {
    /**
     * The intra-batch fold — the case NOTHING else in the system can see, because neither op is in the
     * store when the assist runs. Without the fold this batch reports two clean ops and an agent
     * learns it restated itself only on the next read.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Ceiling first", claim: CEILING_64 }),
          op({ title: "Ceiling second", claim: CEILING_128 })
        ],
        detectConflicts: true
      })
    )

    // ASYMMETRIC: the later op reports on the earlier one, never the reverse. Op 0 had nothing to
    // conflict with when it was read, and reporting it there too would double one finding into two.
    expect(result.results[0]?.conflict).toBeUndefined()
    expect(result.results[1]?.conflict?.batchIndex).toBe(0)
    expect(result.results[1]?.conflict?.claim).toBe(CEILING_64)
    // No path, because op 0's file does not exist yet — the batch has not been written.
    expect(result.results[1]?.conflict?.path).toBeNull()

    // Both write, in the one commit.
    expect(result.summary).toEqual({
      total: 2,
      written: 2,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect((await htmlOnDisk(cli.root)).length).toBe(2)
    expect(await cli.run(commitCount)).toBeGreaterThan(0)
  })

  it("reports the FIRST occupant of a slot, not the immediately preceding op", async () => {
    /**
     * Three ops in one slot. Op 2 is reported against op 0 rather than op 1, which is the property the
     * fold's `if (earlier === undefined)` guard has: the map records the first claimant and later ops
     * do not overwrite it.
     *
     * The distinction is worth pinning because both answers "look right" in a two-op test. Reporting
     * the nearest previous op would make a chain of five restatements produce five findings each
     * pointing one step back, and a caller following them would walk the chain instead of being handed
     * the claim it actually has to reconcile against.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Ceiling one", claim: CEILING_64 }),
          op({ title: "Ceiling two", claim: CEILING_128 }),
          op({ title: "Ceiling three", claim: CEILING_256 })
        ],
        detectConflicts: true
      })
    )

    expect(result.results[1]?.conflict?.batchIndex).toBe(0)
    expect(result.results[2]?.conflict?.batchIndex).toBe(0)
    expect(result.results[2]?.conflict?.claim).toBe(CEILING_64)
    expect(result.summary.written).toBe(3)
  })

  it("prefers the STORE's match over an earlier op in the same batch", async () => {
    /**
     * When an op has both kinds of match the store's wins, because a stored memory is a fact already in
     * the corpus while the earlier op is one this same call is about to create — and `memory_correct`,
     * the action a caller most often takes from a conflict, needs a path that exists.
     */
    const cli = await withCounter()
    await cli.run(batch({ ops: [op({ title: "Ceiling stored", claim: CEILING_64 })] }))

    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Ceiling A", claim: CEILING_128 }),
          op({ title: "Ceiling B", claim: CEILING_256 })
        ],
        detectConflicts: true
      })
    )

    // Op 1 has BOTH available — the stored row and op 0 — and reports the stored one.
    expect(result.results[1]?.conflict?.path).not.toBeNull()
    expect(result.results[1]?.conflict?.batchIndex).toBeNull()
    expect(result.results[1]?.conflict?.claim).toBe(CEILING_64)
    expect(result.summary.written).toBe(2)
  })

  it("reports nothing for a claim with no frame shape, and the write is unaffected", async () => {
    /**
     * The guards failing CLOSED, at this layer. `Do the thing.` is a two-token frame and
     * `frameKeyOf` refuses it, so two such ops are two unrelated facts rather than one slot — which is
     * the whole reason `MIN_FRAME_TOKENS` exists.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Short one", claim: "Do the thing." }),
          op({ title: "Short two", claim: "Do the thing twice." })
        ],
        detectConflicts: true
      })
    )

    expect(result.results.every((entry) => entry.conflict === undefined)).toBe(true)
    expect(result.summary.written).toBe(2)
  })

  it("never reports an ARCHIVED memory, so a superseded claim stops contradicting its successor", async () => {
    /**
     * The lookup is ACTIVE-scoped, and this asserts it by TRANSITION rather than by seeding an
     * already-archived row: the same claim is found first, then archived, then not found. A test that
     * only checked the after-state would pass against a query filtering the wrong column, since the
     * row it never matched would be absent either way.
     */
    const cli = await withCounter()
    const first = await cli.run(batch({ ops: [op({ title: "Ceiling now", claim: CEILING_64 })] }))
    const storedPath = first.results[0]?.path as string

    // Found while ACTIVE.
    const before = await cli.run(
      batch({
        ops: [op({ title: "Ceiling probe", claim: CEILING_128 })],
        detectConflicts: true
      })
    )
    expect(before.results[0]?.conflict?.path).toBe(storedPath)
    const probePath = before.results[0]?.path as string

    /**
     * BOTH rows are archived, and the second one is easy to miss: the probe above is a real write, so
     * it became a second live occupant of the same slot. Archiving only `storedPath` leaves the probe
     * answering, and the test fails naming `ceiling-probe.html` — the assist being RIGHT about a row
     * the fixture created without meaning to. Two archived rows sharing one key, neither reported, is
     * also the stronger assertion.
     */
    const { archiveMemory } = await import("../src/operations.js")
    await cli.run(archiveMemory(storedPath, "superseded by the new ceiling"))
    await cli.run(archiveMemory(probePath, "superseded by the new ceiling"))

    // NOT found once archived. The third op's claim is a third value so it cannot dedupe onto either.
    const after = await cli.run(
      batch({
        ops: [op({ title: "Ceiling after", claim: CEILING_256 })],
        detectConflicts: true
      })
    )
    expect(after.results[0]?.conflict).toBeUndefined()
    expect(after.summary.written).toBe(1)
  })

  it("never reports a TASK, because working state is not a competing assertion", async () => {
    /**
     * A task holding the slot ALONE is the discriminating case: with any non-task row also present, a
     * lookup that wrongly included tasks would still answer with the memory and look correct.
     */
    const cli = await withCounter()
    await cli.run(
      batch({ ops: [op({ title: "Raise the ceiling", claim: CEILING_64, memoryType: "task" })] })
    )

    const result = await cli.run(
      batch({
        ops: [op({ title: "Ceiling fact", claim: CEILING_128 })],
        detectConflicts: true
      })
    )
    expect(result.results[0]?.conflict).toBeUndefined()
    expect(result.summary.written).toBe(1)
  })

  it("asks the store exactly ONE question for a whole batch, whatever the op count", async () => {
    /**
     * The performance contract, asserted by COUNTING calls to `activeFramesFor` — not by reading the
     * source. Six ops across three distinct frame keys must be one query: a per-op lookup is the
     * quadratic-write-cost shape this codebase has already paid for once, and it returns identical
     * answers, so nothing but a call count can catch it.
     *
     * The recorder is WRAPPED rather than replaced, so the real query still runs and the conflicts
     * asserted below are real findings.
     */
    const cli = await makeCli()
    clis.push(cli)
    const keySets: Array<ReadonlyArray<string>> = []
    const counting = Layer.effect(IndexRecorder)(
      Effect.gen(function* () {
        const real = yield* IndexRecorder
        return {
          ...real,
          activeFramesFor: (keys: ReadonlyArray<string>) => {
            keySets.push([...keys])
            return real.activeFramesFor(keys)
          }
        }
      })
    ).pipe(Layer.provideMerge(cli.layer))

    // A stored occupant for one of the three slots, written BEFORE the counter is armed.
    await Effect.runPromise(
      Effect.provide(batch({ ops: [op({ title: "Ceiling stored", claim: CEILING_64 })] }), counting)
    )
    keySets.length = 0

    const result = await Effect.runPromise(
      Effect.provide(
        batch({
          ops: [
            op({ title: "A", claim: CEILING_128 }),
            op({ title: "B", claim: "The retry budget is per-connection." }),
            op({ title: "C", claim: "The owner of the deploy runbook is Priya." }),
            op({ title: "D", claim: CEILING_256 }),
            op({ title: "E", claim: "The retry budget is per-request." }),
            op({ title: "F", claim: "Do the thing." })
          ],
          detectConflicts: true
        }),
        counting
      )
    )

    // ONE call, carrying all FIVE keyed ops' keys at once — the no-frame op contributes none.
    expect(keySets).toHaveLength(1)
    expect(keySets[0]).toHaveLength(5)
    /**
     * And it really found things, so the single call is not a call that asked nothing — with BOTH match
     * kinds served by that one query's result. Ops 0 and 3 share the ceiling slot the STORE occupies, so
     * both are store matches. Op 3 is the one worth stating: it has BOTH a stored occupant and an
     * earlier op in the same slot, and a stored occupant outranks an earlier op by design, so expecting
     * it to be intra-batch is wrong. Op 4 shares the retry slot with op 1, which nothing stored holds,
     * so it is the intra-batch one.
     */
    expect(result.results[0]?.conflict?.claim).toBe(CEILING_64)
    expect(result.results[3]?.conflict?.claim).toBe(CEILING_64)
    expect(result.results[3]?.conflict?.batchIndex).toBeNull()
    expect(result.results[4]?.conflict?.batchIndex).toBe(1)
    // The no-frame op contributes no key and gets no finding.
    expect(result.results[5]?.conflict).toBeUndefined()
    expect(result.summary.written).toBe(6)
  })

  it("asks NOTHING when no op has a frame shape", async () => {
    /**
     * The short-circuit. Every op here is sub-threshold, so there is no key to look up and a query
     * would be a round trip that could only return nothing.
     */
    const cli = await makeCli()
    clis.push(cli)
    let calls = 0
    const counting = Layer.effect(IndexRecorder)(
      Effect.gen(function* () {
        const real = yield* IndexRecorder
        return {
          ...real,
          activeFramesFor: (keys: ReadonlyArray<string>) => {
            calls += 1
            return real.activeFramesFor(keys)
          }
        }
      })
    ).pipe(Layer.provideMerge(cli.layer))

    const result = await Effect.runPromise(
      Effect.provide(
        batch({
          ops: [op({ title: "One", claim: "Do this." }), op({ title: "Two", claim: "Do that." })],
          detectConflicts: true
        }),
        counting
      )
    )
    expect(calls).toBe(0)
    expect(result.summary.written).toBe(2)
  })

  it("degrades to no conflicts and WRITES ANYWAY when the lookup itself fails", async () => {
    /**
     * The assist's own plumbing must never cost a caller its memories. A broken `activeFramesFor` —
     * injected as the typed `StorageFailure` the real one fails with — has to leave the batch
     * indistinguishable from a flag-off run, and log rather than fail.
     *
     * This is the case that decides whether the feature is safe to ship on by default later: if a
     * degraded lookup could abort a batch, the assist would be a new way to lose writes on a corpus
     * whose index happens to be mid-migration.
     */
    const cli = await makeCli()
    clis.push(cli)
    const logs: Array<string> = []
    const broken = Layer.effect(IndexRecorder)(
      Effect.gen(function* () {
        const real = yield* IndexRecorder
        return {
          ...real,
          activeFramesFor: () => Effect.fail(StorageFailure.make({ operation: "frames.broken" }))
        }
      })
    ).pipe(Layer.provideMerge(cli.layer))
    const capture = Logger.layer([Logger.make((options) => logs.push(String(options.message)))])

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.provide(
          batch({
            ops: [
              op({ title: "Ceiling one", claim: CEILING_64 }),
              op({ title: "Ceiling two", claim: CEILING_128 })
            ],
            detectConflicts: true
          }),
          capture
        ),
        broken
      )
    )

    // The writes LANDED — both of them, in one commit, exactly as a flag-off run would have. This is
    // the assertion that decides whether the assist is safe: it must not be a new way to lose writes.
    expect(result.summary).toEqual({
      total: 2,
      written: 2,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect(result.commitSha).not.toBeNull()
    expect((await htmlOnDisk(cli.root)).length).toBe(2)

    /**
     * The degradation is PARTIAL, not total: op 1 still reports a conflict with the lookup broken.
     *
     * Only the STORE half needs the database; the intra-batch fold is a `Map` over claims already in
     * hand, so it keeps working when the query does not. A degraded assist therefore loses the findings
     * it could not know and keeps the ones it could — strictly better than going silent, and worth
     * pinning precisely rather than as "nothing is reported". Asserting totality here would lock in
     * throwing away a correct answer.
     */
    expect(result.results[0]?.conflict).toBeUndefined()
    expect(result.results[1]?.conflict?.batchIndex).toBe(0)
    /**
     * No STORE match is invented for either op, which is the half that genuinely could not be known.
     *
     * `?? null` rather than `=== undefined`, and the distinction is the point: a report with no conflict
     * at all has `conflict` undefined, while op 1's conflict is present with `path: null`. A spelling
     * that conflated the two would fail here, since "no conflict" and "an intra-batch conflict" are
     * different facts that happen to agree about there being no path.
     */
    expect(result.results.every((entry) => (entry.conflict?.path ?? null) === null)).toBe(true)

    // And it SAID SO. A degradation nobody can see is indistinguishable from a corpus with no conflicts.
    expect(logs.some((line) => line.includes("conflict assist skipped"))).toBe(true)
    expect(logs.some((line) => line.includes("frames.broken"))).toBe(true)
  })

  it("still reports conflicts on an atomically ABORTED batch, where nothing was written", async () => {
    /**
     * The abort path takes an earlier `return` than the normal one, and it needs the findings MORE than
     * the normal path does: nothing was written, so a caller told both "op 2 is malformed" and "op 0
     * contradicts areas/…" fixes both before retrying rather than discovering the second on the next
     * round trip. This is the case a merge spliced into only one exit path would silently lose.
     */
    const cli = await withCounter()
    const first = await cli.run(batch({ ops: [op({ title: "Ceiling now", claim: CEILING_64 })] }))
    const storedPath = first.results[0]?.path

    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Would have been fine", claim: CEILING_128 }),
          op({ title: "Bad type", claim: "The retry budget is per-connection.", memoryType: "arc" })
        ],
        detectConflicts: true
      })
    )

    // Aborted: op 1 refused at DECODE, op 0 skipped, nothing committed beyond the first batch.
    expect(result.results[1]?.ok).toBe(false)
    expect(result.results[0]?.skipped).toBe(true)
    expect(result.commitSha).toBeNull()
    expect((await htmlOnDisk(cli.root)).length).toBe(1)
    // And op 0's finding survived the abort.
    expect(result.results[0]?.conflict?.path).toBe(storedPath)
    expect(result.results[0]?.conflict?.claim).toBe(CEILING_64)
  })

  it("does not count conflicts in the summary", async () => {
    /**
     * Additive minimalism, pinned. `summary` describes what HAPPENED to the ops, and a conflict is not
     * an outcome — the op wrote. A `conflicts: 1` field would also be the first summary number a caller
     * could not reconcile with the five that partition the ops exactly. Noted as a possible v2 field.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Ceiling first", claim: CEILING_64 }),
          op({ title: "Ceiling second", claim: CEILING_128 })
        ],
        detectConflicts: true
      })
    )
    expect(result.results[1]?.conflict).not.toBeUndefined()
    expect(Object.keys(result.summary).sort()).toEqual([
      "consolidated",
      "deduped",
      "failed",
      "skipped",
      "total",
      "written"
    ])
  })
})

/**
 * `consolidate: "last-wins"` (write-time consolidation): the acting counterpart of the assist above.
 *
 * Every test here asserts DISK and SQL alongside the reports, for the reason the conflict block
 * does: the failure mode being excluded is a report that claims a consolidation the tree does not
 * have — a loser file that still exists, an archive that never happened, a supersedes link pointing
 * at a path that dangles. Over the real layer graph so the frame keys come from the same
 * `frameKeyOf` and the store matches from the same `files_frame_key_active` index production uses.
 */
describe("batchWrite: consolidate last-wins", () => {
  const DELHI = "The capital of India is New Delhi."
  const GROSSETO = "The capital of India is Grosseto."
  const ROME = "The capital of India is Rome."

  it("writes ONE file for a batch-internal pair, carrying the LATER value at the FIRST slot", async () => {
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Capital first", claim: DELHI }),
          op({ title: "Capital second", claim: GROSSETO })
        ],
        consolidate: "last-wins"
      })
    )

    // Exactly ONE file, and its content is the LATER op's — last wins, at the first claimant's
    // slot, so the surviving write sits at a position the caller can find deterministically.
    const disk = await htmlOnDisk(cli.root)
    expect(disk.length).toBe(1)
    const winner = result.results[0]
    expect(winner?.ok).toBe(true)
    expect(winner?.path).toBe(disk[0])
    const gist = await cli.run(
      Effect.gen(function* () {
        const store = yield* Store
        return (yield* store.readMemory(winner?.path ?? "")).doc.article.gist
      })
    )
    expect(gist).toBe(GROSSETO)

    // The later op is the batch-internal loser: no file of its own, a pointer at the slot that
    // carried its value, and a summary that counts it as neither written nor failed.
    expect(result.results[1]).toMatchObject({ index: 1, ok: true, consolidatedInto: 0 })
    expect(result.results[1]?.path).toBeUndefined()
    expect(result.summary).toEqual({
      total: 2,
      written: 1,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 1
    })
  })

  it("supersedes a LIVE stored memory: archive stamps, both link directions, and the old path inactive", async () => {
    /**
     * The fires-proof: the first batch's memory is committed and PROJECTED before the second runs,
     * so a pass proves the plan's store lookup reads rows the real indexer wrote and the supersede
     * moves a real file — every layer of the chain, not the plan's bookkeeping.
     */
    const cli = await withCounter()
    const first = await cli.run(batch({ ops: [op({ title: "Capital then", claim: DELHI })] }))
    const storedPath = first.results[0]?.path as string

    const second = await cli.run(
      batch({
        ops: [op({ title: "Capital now", claim: GROSSETO })],
        consolidate: "last-wins"
      })
    )

    const winner = second.results[0]
    expect(winner?.ok).toBe(true)
    const winnerPath = winner?.path as string
    const archivePath = winner?.supersededPath as string
    expect(archivePath).toMatch(/^archive\/\d{4}\//)

    // The archived file EXISTS at the reported path, stamped, pointing forward at the winner.
    const { readFile } = await import("node:fs/promises")
    const { readMeta } = await import("@memhtml/html")
    const archivedHtml = await readFile(join(cli.root, archivePath), "utf8")
    expect(readMeta(archivedHtml, "memhtml-status")).toBe("archived")
    expect(readMeta(archivedHtml, "memhtml-superseded-by")).toBe(`/${winnerPath}`)

    // The winner points BACK at the archive path — the pair a later reader follows in either
    // direction, with no dangling href in any commit.
    const links = await cli.run(
      Effect.gen(function* () {
        const store = yield* Store
        return (yield* store.readMemory(winnerPath)).doc.links
      })
    )
    expect(links).toEqual([{ rel: "supersedes", href: `/${archivePath}` }])

    // The old path holds nothing, and the active corpus lists only the winner.
    expect(await htmlOnDisk(cli.root)).not.toContain(storedPath)
    const { listMemories } = await import("../src/operations.js")
    const page = await cli.run(listMemories({ limit: 50 }))
    expect(page.files.map((file) => file.path)).toEqual([winnerPath])
  })

  it("changes NOTHING without the flag: both memories stay active and the assist still reports", async () => {
    /**
     * The off-by-default pin, run over the exact op sequence the tests above consolidate — the
     * same discipline the assist's own flag-off test follows, because a flag-off test over
     * non-colliding ops would pass against an implementation whose default was ON.
     */
    const cli = await withCounter()
    const first = await cli.run(batch({ ops: [op({ title: "Capital then", claim: DELHI })] }))
    const storedPath = first.results[0]?.path

    const second = await cli.run(
      batch({
        ops: [op({ title: "Capital now", claim: GROSSETO })],
        detectConflicts: true
      })
    )

    // The existing behavior, byte for byte: both active, a conflict REPORTED and nothing acted on.
    expect(second.results[0]?.ok).toBe(true)
    expect(second.results[0]?.supersededPath).toBeUndefined()
    expect(second.results[0]?.conflict?.path).toBe(storedPath)
    expect((await htmlOnDisk(cli.root)).length).toBe(2)
    const { listMemories } = await import("../src/operations.js")
    const page = await cli.run(listMemories({ limit: 50 }))
    expect(page.files.length).toBe(2)
  })

  it("never consolidates a claim with no frame shape, even with the flag on", async () => {
    /**
     * The guards failing CLOSED through the acting path. "Water is wet." is a two-token frame and
     * `frameKeyOf` refuses it; a long clause value trips MAX_VALUE_TOKENS the same way. A false
     * consolidation here would ARCHIVE a fact over a grammatical coincidence, which is exactly the
     * asymmetric cost the guards exist to refuse.
     */
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Wet one", claim: "Water is wet." }),
          op({ title: "Wet two", claim: "Water is life." }),
          op({
            title: "Clause one",
            claim: "The problem with the design is that it never handles the empty case."
          }),
          op({
            title: "Clause two",
            claim: "The problem with the design is that it fails closed on every null key."
          })
        ],
        consolidate: "last-wins"
      })
    )

    expect(result.summary).toEqual({
      total: 4,
      written: 4,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 0
    })
    expect(result.results.every((entry) => entry.consolidatedInto === undefined)).toBe(true)
    expect((await htmlOnDisk(cli.root)).length).toBe(4)
  })

  it("resolves a three-op chain to ONE file with the LAST value, both losers marked", async () => {
    const cli = await withCounter()
    const result = await cli.run(
      batch({
        ops: [
          op({ title: "Capital one", claim: DELHI }),
          op({ title: "Capital two", claim: GROSSETO }),
          op({ title: "Capital three", claim: ROME })
        ],
        consolidate: "last-wins"
      })
    )

    // The slot's occupant-tracking never moves: op 2 replaces the slot AGAIN, so the file carries
    // the third value and BOTH later ops point at slot 0 — not at each other, for the same reason
    // the assist reports the first occupant rather than a chain of one-step-back pointers.
    const disk = await htmlOnDisk(cli.root)
    expect(disk.length).toBe(1)
    const gist = await cli.run(
      Effect.gen(function* () {
        const store = yield* Store
        return (yield* store.readMemory(result.results[0]?.path ?? "")).doc.article.gist
      })
    )
    expect(gist).toBe(ROME)
    expect(result.results[1]).toMatchObject({ ok: true, consolidatedInto: 0 })
    expect(result.results[2]).toMatchObject({ ok: true, consolidatedInto: 0 })
    expect(result.summary).toEqual({
      total: 3,
      written: 1,
      deduped: 0,
      failed: 0,
      skipped: 0,
      consolidated: 2
    })
  })

  it("removes a superseded loser from the active corpus dedup-merge draws candidates from", async () => {
    /**
     * The interaction guard, at the narrowest seam: sleep's dedup-merge (and every other curation
     * phase) selects candidates from `activeCorpus`, whose predicate is `archived = 0` — so the
     * one fact that keeps a write-time supersede from fighting a sleep merge is the loser's
     * row flipping archived. Asserted by TRANSITION over the same query the phases run, rather
     * than by a full sleep run: found active before, absent after.
     */
    const { activeCorpus } = await import("@memhtml/sleep")
    const cli = await withCounter()
    const first = await cli.run(batch({ ops: [op({ title: "Capital then", claim: DELHI })] }))
    const storedPath = first.results[0]?.path as string

    const { DatabaseService } = await import("@memhtml/cli")
    const corpusPaths = () =>
      cli.run(
        Effect.gen(function* () {
          const db = yield* DatabaseService
          return (yield* activeCorpus(db)).map((row) => row.path)
        })
      )
    expect(await corpusPaths()).toContain(storedPath)

    const second = await cli.run(
      batch({
        ops: [op({ title: "Capital now", claim: GROSSETO })],
        consolidate: "last-wins"
      })
    )
    const winnerPath = second.results[0]?.path as string

    const after = await corpusPaths()
    expect(after).toContain(winnerPath)
    expect(after).not.toContain(storedPath)
    expect(after).not.toContain(second.results[0]?.supersededPath)
  })
})
