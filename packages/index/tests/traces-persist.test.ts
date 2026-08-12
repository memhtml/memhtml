import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import type { DatabaseShape } from "../src/database.js"
import {
  LINK_KINDS,
  makeIndexRecorder,
  persistScanned,
  readStoredExtract,
  readWatermark,
  type ScannedFileLike,
  type SessionExtractLike,
  type TailMerger,
  writeWatermark
} from "../src/traces-persist.js"
import { withDb } from "./harness.js"

/**
 * Trace-plane persistence.
 *
 * The tail merger is INJECTED, and the tests here prove why: on a tail, `persistScanned` cannot write
 * without calling it, and a naive merger visibly corrupts the row. `@memhtml/traces` owns
 * `mergeTailExtract` because a tail's extract describes the appended SLICE and not the session, and a
 * consumer reimplementing that rule is the mistake the fleet has paid for repeatedly.
 */

const AT = "2026-08-02T00:00:00Z"
const SESSION = "11111111-1111-4111-8111-111111111111"

const extract = (over: Partial<SessionExtractLike> = {}): SessionExtractLike => ({
  filePath: "/tmp/fixture/projects/-tmp-a/session.jsonl",
  slug: "-tmp-a",
  sessionId: SESSION,
  cwd: "/tmp/a",
  gitBranch: "main",
  entrypoint: "cli",
  version: "2.1.0",
  model: "claude-opus-5",
  startedAt: "2026-08-01T10:00:00Z",
  endedAt: "2026-08-01T11:00:00Z",
  promptCount: 2,
  turnCount: 8,
  agentIds: [],
  firstPrompt: "Explain the watermark rule.",
  aiTitle: "Watermarks",
  prompts: [
    {
      promptId: "p1",
      turnUuid: "u1",
      ordinal: 0,
      at: "2026-08-01T10:00:00Z",
      agentId: null,
      textHead: "Explain the watermark rule."
    },
    {
      promptId: "p2",
      turnUuid: "u2",
      ordinal: 1,
      at: "2026-08-01T10:30:00Z",
      agentId: null,
      textHead: "And the tail case?"
    }
  ],
  ...over
})

const scanned = (over: Partial<ScannedFileLike> = {}): ScannedFileLike => ({
  file: { filePath: "/tmp/fixture/projects/-tmp-a/session.jsonl", kind: "session" },
  action: "rescan",
  extract: extract(),
  agentCount: 1,
  watermark: { size: 4096, mtimeMs: Date.parse("2026-08-02T00:00:00Z"), byteOff: 4096 },
  ...over
})

/**
 * A merger that only records that it was called and returns the tail verbatim.
 *
 * Deliberately WRONG in the way a hand-rolled merge is wrong — it takes the tail's `firstPrompt`,
 * `startedAt`, and ordinals — so the test below can show the corruption a direct tail upsert produces.
 * The production path binds `@memhtml/traces`'s real `mergeTailExtract`.
 */
const naiveMerger = (): { readonly merge: TailMerger; readonly calls: () => number } => {
  let calls = 0
  return {
    merge: (_stored, tail) => {
      calls += 1
      return tail
    },
    calls: () => calls
  }
}

/** A merger standing in for the real one on the fields this test asserts. */
const correctMerger = (): { readonly merge: TailMerger; readonly calls: () => number } => {
  let calls = 0
  return {
    merge: (stored, tail) => {
      calls += 1
      const seen = new Map(stored.prompts.map((row) => [row.promptId, row]))
      for (const row of tail.prompts) {
        if (!seen.has(row.promptId)) seen.set(row.promptId, { ...row, ordinal: seen.size })
      }
      return {
        ...tail,
        // Identity comes from the older side; current state from the newer.
        startedAt: stored.startedAt,
        firstPrompt: stored.firstPrompt === "" ? tail.firstPrompt : stored.firstPrompt,
        turnCount: stored.turnCount + tail.turnCount,
        prompts: [...seen.values()],
        promptCount: seen.size
      }
    },
    calls: () => calls
  }
}

describe("persistScanned", () => {
  it("writes the traces row, its prompts, and its watermark on a rescan", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const merger = naiveMerger()
        const result = yield* persistScanned(db, scanned(), merger.merge, AT)
        const row = yield* db.get<Record<string, unknown>>(
          "SELECT * FROM traces WHERE session_id = ?",
          [SESSION]
        )
        const prompts = yield* db.all<{ prompt_id: string; ordinal: number }>(
          "SELECT prompt_id, ordinal FROM trace_prompts WHERE session_id = ? ORDER BY ordinal",
          [SESSION]
        )
        const watermark = yield* db.get<{ size: number; byte_off: number; mtime: string }>(
          "SELECT size, byte_off, mtime FROM trace_watermarks WHERE file_path = ?",
          ["/tmp/fixture/projects/-tmp-a/session.jsonl"]
        )
        return { result, row, prompts, watermark, calls: merger.calls() }
      })
    )

    expect(outcome.result).toMatchObject({ sessionId: SESSION, action: "rescan", merged: false })
    // A rescan's extract already describes the whole file; merging would fold it into a stale copy.
    expect(outcome.calls).toBe(0)
    expect(outcome.row?.slug).toBe("-tmp-a")
    expect(outcome.row?.first_prompt).toBe("Explain the watermark rule.")
    expect(outcome.row?.prompt_count).toBe(2)
    expect(outcome.row?.agent_count).toBe(1)
    expect(outcome.prompts).toEqual([
      { prompt_id: "p1", ordinal: 0 },
      { prompt_id: "p2", ordinal: 1 }
    ])
    expect(outcome.watermark?.size).toBe(4096)
    expect(outcome.watermark?.byte_off).toBe(4096)
    // The scanner reports epoch milliseconds; the column stores ISO-8601, converted at this boundary.
    expect(outcome.watermark?.mtime).toBe("2026-08-02T00:00:00.000Z")
  })

  it("writes nothing at all on a skip", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const merger = naiveMerger()
        const result = yield* persistScanned(
          db,
          scanned({ action: "skip", extract: null, agentCount: 0 }),
          merger.merge,
          AT
        )
        const counts = yield* db.get<{ traces: number; watermarks: number }>(
          `SELECT (SELECT count(*) FROM traces) AS traces,
                  (SELECT count(*) FROM trace_watermarks) AS watermarks`
        )
        return { result, counts, calls: merger.calls() }
      })
    )
    expect(outcome.result.action).toBe("skip")
    expect(outcome.counts).toEqual({ traces: 0, watermarks: 0 })
    // Not even the watermark: the stored one already describes this exact file, so rewriting it would
    // move `scanned_at` on a file nobody opened.
    expect(outcome.calls).toBe(0)
  })

  it("MUST route a tail through the injected merger", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* persistScanned(db, scanned(), naiveMerger().merge, AT)
        const merger = correctMerger()
        const result = yield* persistScanned(
          db,
          scanned({
            action: "tail",
            extract: extract({
              // A tail's own view: it began mid-conversation and its ordinals restart at 0.
              firstPrompt: "And now the third question.",
              startedAt: "2026-08-01T11:30:00Z",
              endedAt: "2026-08-01T12:00:00Z",
              turnCount: 3,
              promptCount: 1,
              prompts: [
                {
                  promptId: "p3",
                  turnUuid: "u3",
                  ordinal: 0,
                  at: "2026-08-01T11:30:00Z",
                  agentId: null,
                  textHead: "And now the third question."
                }
              ]
            })
          }),
          merger.merge,
          AT
        )
        return { result, calls: merger.calls() }
      })
    )
    // findings-t1.md:16 — the obligation is structural: `persistScanned` cannot write a tail without
    // the merger, so there is no path that upserts a tail extract directly.
    expect(outcome.calls).toBe(1)
    expect(outcome.result).toMatchObject({ action: "tail", merged: true })
  })

  it("keeps the session's identity through a correctly merged tail", async () => {
    const row = await withDb((db) =>
      Effect.gen(function* () {
        yield* persistScanned(db, scanned(), naiveMerger().merge, AT)
        yield* persistScanned(
          db,
          scanned({
            action: "tail",
            extract: extract({
              firstPrompt: "And now the third question.",
              startedAt: "2026-08-01T11:30:00Z",
              endedAt: "2026-08-01T12:00:00Z",
              turnCount: 3,
              promptCount: 1,
              prompts: [
                {
                  promptId: "p3",
                  turnUuid: "u3",
                  ordinal: 0,
                  at: "2026-08-01T11:30:00Z",
                  agentId: null,
                  textHead: "And now the third question."
                }
              ]
            })
          }),
          correctMerger().merge,
          AT
        )
        const traces = yield* db.get<{
          first_prompt: string
          started_at: string
          ended_at: string
          turn_count: number
          prompt_count: number
        }>(
          "SELECT first_prompt, started_at, ended_at, turn_count, prompt_count FROM traces WHERE session_id = ?",
          [SESSION]
        )
        const prompts = yield* db.all<{ prompt_id: string; ordinal: number }>(
          "SELECT prompt_id, ordinal FROM trace_prompts WHERE session_id = ? ORDER BY ordinal",
          [SESSION]
        )
        return { traces, prompts }
      })
    )
    expect(row.traces?.first_prompt).toBe("Explain the watermark rule.")
    expect(row.traces?.started_at).toBe("2026-08-01T10:00:00Z")
    expect(row.traces?.ended_at).toBe("2026-08-01T12:00:00Z")
    expect(row.traces?.turn_count).toBe(11)
    expect(row.traces?.prompt_count).toBe(3)
    // Ordinals renumbered across the boundary rather than colliding at 0.
    expect(row.prompts).toEqual([
      { prompt_id: "p1", ordinal: 0 },
      { prompt_id: "p2", ordinal: 1 },
      { prompt_id: "p3", ordinal: 2 }
    ])
  })

  it("shows the corruption a naive tail merge produces, which is why the merge is the producer's", async () => {
    const row = await withDb((db) =>
      Effect.gen(function* () {
        yield* persistScanned(db, scanned(), naiveMerger().merge, AT)
        yield* persistScanned(
          db,
          scanned({
            action: "tail",
            extract: extract({
              firstPrompt: "And now the third question.",
              startedAt: "2026-08-01T11:30:00Z",
              turnCount: 3,
              promptCount: 1,
              prompts: [
                {
                  promptId: "p3",
                  turnUuid: "u3",
                  ordinal: 0,
                  at: "2026-08-01T11:30:00Z",
                  agentId: null,
                  textHead: "And now the third question."
                }
              ]
            })
          }),
          naiveMerger().merge,
          AT
        )
        return yield* db.get<{ first_prompt: string; started_at: string; turn_count: number }>(
          "SELECT first_prompt, started_at, turn_count FROM traces WHERE session_id = ?",
          [SESSION]
        )
      })
    )
    // Every one of these is wrong, and none of them fails a constraint — the row is well-formed and
    // says the session began at 11:30 with a mid-conversation prompt. That is why the merge cannot be
    // guessed at the consumer.
    expect(row?.first_prompt).toBe("And now the third question.")
    expect(row?.started_at).toBe("2026-08-01T11:30:00Z")
    expect(row?.turn_count).toBe(3)
  })

  it("drops a file with no session id but still advances its watermark", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const result = yield* persistScanned(
          db,
          scanned({ extract: extract({ sessionId: null }) }),
          naiveMerger().merge,
          AT
        )
        const traces = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM traces")
        const watermarks = yield* db.get<{ n: number }>(
          "SELECT count(*) AS n FROM trace_watermarks"
        )
        return { result, traces: traces?.n, watermarks: watermarks?.n }
      })
    )
    // A `file-history-*`-only file has no session to be about, but it WAS read — so not advancing the
    // watermark would re-read it on every scan forever.
    expect(outcome.result.sessionId).toBeNull()
    expect(outcome.traces).toBe(0)
    expect(outcome.watermarks).toBe(1)
  })

  it("keeps the main transcript's file_path when a sidecar upserts the same session", async () => {
    const row = await withDb((db) =>
      Effect.gen(function* () {
        yield* persistScanned(db, scanned(), naiveMerger().merge, AT)
        yield* persistScanned(
          db,
          scanned({
            file: {
              filePath: "/tmp/fixture/projects/-tmp-a/session/subagents/agent-aaa.jsonl",
              kind: "subagent"
            },
            agentCount: 1,
            watermark: { size: 99, mtimeMs: Date.parse("2026-08-02T01:00:00Z"), byteOff: 99 }
          }),
          naiveMerger().merge,
          AT
        )
        return yield* db.get<{ file_path: string; file_size: number; agent_count: number }>(
          "SELECT file_path, file_size, agent_count FROM traces WHERE session_id = ?",
          [SESSION]
        )
      })
    )
    // Letting a sidecar claim the row's file_path would point the citation at one subagent's slice.
    expect(row?.file_path).toBe("/tmp/fixture/projects/-tmp-a/session.jsonl")
    expect(row?.file_size).toBe(4096)
    expect(row?.agent_count).toBe(1)
  })

  it("delete-and-inserts prompts, leaving no row at a renumbered ordinal", async () => {
    const prompts = await withDb((db) =>
      Effect.gen(function* () {
        yield* persistScanned(db, scanned(), naiveMerger().merge, AT)
        yield* persistScanned(
          db,
          scanned({
            extract: extract({
              promptCount: 1,
              prompts: [
                {
                  promptId: "p9",
                  turnUuid: "u9",
                  ordinal: 0,
                  at: "2026-08-01T10:00:00Z",
                  agentId: null,
                  textHead: "A rewritten transcript."
                }
              ]
            })
          }),
          naiveMerger().merge,
          AT
        )
        return yield* db.all<{ prompt_id: string; ordinal: number }>(
          "SELECT prompt_id, ordinal FROM trace_prompts WHERE session_id = ?",
          [SESSION]
        )
      })
    )
    // An upsert would leave p1 and p2 behind, and two rows claiming ordinal 0 stops it being an order.
    expect(prompts).toEqual([{ prompt_id: "p9", ordinal: 0 }])
  })

  it("cascades prompt rows away with their traces row", async () => {
    const remaining = await withDb((db) =>
      Effect.gen(function* () {
        yield* persistScanned(db, scanned(), naiveMerger().merge, AT)
        yield* db.run("DELETE FROM traces WHERE session_id = ?", [SESSION])
        return yield* db.get<{ n: number }>("SELECT count(*) AS n FROM trace_prompts")
      })
    )
    expect(remaining?.n).toBe(0)
  })
})

describe("the watermark reader and writer", () => {
  it("round-trips through the ISO/epoch-milliseconds boundary", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const original = {
          size: 512,
          mtimeMs: Date.parse("2026-08-02T03:04:05.000Z"),
          byteOff: 500
        }
        yield* db.writeAll([writeWatermark("/tmp/a.jsonl", original, AT)])
        const read = yield* readWatermark(db)("/tmp/a.jsonl")
        const absent = yield* readWatermark(db)("/tmp/never-scanned.jsonl")
        return { original, read, absent }
      })
    )
    expect(outcome.read).toEqual(outcome.original)
    // `null` for a file never scanned is what the scanner's plan reads as "rescan".
    expect(outcome.absent).toBeNull()
  })

  it("overwrites a file's watermark rather than accumulating rows", async () => {
    const rows = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.writeAll([
          writeWatermark("/tmp/a.jsonl", { size: 100, mtimeMs: 1, byteOff: 100 }, AT)
        ])
        yield* db.writeAll([
          writeWatermark("/tmp/a.jsonl", { size: 200, mtimeMs: 2, byteOff: 200 }, AT)
        ])
        return yield* db.all<{ size: number }>("SELECT size FROM trace_watermarks")
      })
    )
    expect(rows).toEqual([{ size: 200 }])
  })
})

describe("readStoredExtract", () => {
  it("returns null for a session with no row", async () => {
    const stored = await withDb((db) => readStoredExtract(db, "absent-session"))
    expect(stored).toBeNull()
  })

  it("reconstructs the fields the tail merge reads", async () => {
    const stored = await withDb((db) =>
      Effect.gen(function* () {
        yield* persistScanned(db, scanned(), naiveMerger().merge, AT)
        return yield* readStoredExtract(db, SESSION)
      })
    )
    expect(stored).toMatchObject({
      sessionId: SESSION,
      slug: "-tmp-a",
      cwd: "/tmp/a",
      startedAt: "2026-08-01T10:00:00Z",
      turnCount: 8,
      firstPrompt: "Explain the watermark rule."
    })
    expect(stored?.prompts.map((prompt) => prompt.promptId)).toEqual(["p1", "p2"])
  })
})

describe("the index recorder", () => {
  it("declares exactly the four link kinds the schema CHECK allows", async () => {
    expect(LINK_KINDS).toEqual(["wrote", "read", "corrected", "reinforced"])
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const recorder = makeIndexRecorder(db)
        for (const kind of LINK_KINDS) {
          yield* recorder.recordLink({
            path: "areas/a.html",
            sessionId: SESSION,
            linkKind: kind,
            at: AT
          })
        }
        return yield* db.all<{ link_kind: string }>(
          "SELECT link_kind FROM memory_session_links ORDER BY link_kind"
        )
      })
    )
    expect(outcome.map((row) => row.link_kind).sort()).toEqual([...LINK_KINDS].sort())
  })

  it("is idempotent on the same instant, so a duplicate note never fails the write it describes", async () => {
    const rows = await withDb((db) =>
      Effect.gen(function* () {
        const recorder = makeIndexRecorder(db)
        const link = {
          path: "areas/a.html",
          sessionId: SESSION,
          promptId: "p1",
          turnUuid: "u1",
          linkKind: "wrote" as const,
          at: AT
        }
        yield* recorder.recordLink(link)
        yield* recorder.recordLink(link)
        return yield* db.all<{ path: string }>("SELECT path FROM memory_session_links")
      })
    )
    expect(rows).toHaveLength(1)
  })

  it("records a link for a session whose transcript has not been scanned", async () => {
    const rows = await withDb((db) =>
      Effect.gen(function* () {
        yield* makeIndexRecorder(db).recordLink({
          path: "areas/a.html",
          sessionId: "never-scanned",
          linkKind: "wrote",
          at: AT
        })
        return yield* db.all<{ session_id: string }>("SELECT session_id FROM memory_session_links")
      })
    )
    // No FK to `traces` by design: a memory is written before its transcript is indexed, and refusing
    // the link would lose provenance the file itself already carries.
    expect(rows).toEqual([{ session_id: "never-scanned" }])
  })

  it("answers the dedup lookup with the active path only", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFile(db, "areas/a.html", "sha256:aaa", 0)
        yield* seedFile(db, "archive/2026/areas/b.html", "sha256:bbb", 1)
        const recorder = makeIndexRecorder(db)
        return {
          active: yield* recorder.activePathForHash("sha256:aaa"),
          archived: yield* recorder.activePathForHash("sha256:bbb"),
          absent: yield* recorder.activePathForHash("sha256:zzz")
        }
      })
    )
    expect(outcome.active).toBe("areas/a.html")
    // An archived file's hash is free to be written again — that is what makes a correction possible
    // after an eviction.
    expect(outcome.archived).toBeNull()
    expect(outcome.absent).toBeNull()
  })

  it("never answers with a task's path, and agrees with the index that admits the row", async () => {
    /**
     * The dedup carve-out's TWO halves, asserted together because they are one property: this query
     * is the write path's dedup question and `files_content_hash_active` is the database's answer,
     * so a predicate on one and not the other is a disagreement no type catches.
     *
     * The contaminating state is the open task, seeded FIRST — which is the ordering that matters.
     * A new memory whose article happens to match a live task's body must NOT be deduped onto that
     * task: the caller would be handed a task's path as the home of its fact, write nothing, and
     * the fact would be lost with a successful-looking response. The test then proves the database
     * agrees by actually inserting that memory.
     *
     * (Verified by mutation: dropping `AND memory_type <> 'task'` from the query makes the lookup
     * return the task's path AND makes the memory insert fail the unique index.)
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFile(db, "areas/inbox/tasks/t1.html", "sha256:shared", 0, "task")
        const recorder = makeIndexRecorder(db)
        const beforeWrite = yield* recorder.activePathForHash("sha256:shared")

        // The store would now write the memory, because the lookup said nothing holds this hash.
        const written = yield* Effect.result(
          seedFile(db, "areas/oncall/m1.html", "sha256:shared", 0, "semantic")
        )
        // And a SECOND memory at that hash is refused by both the lookup and the index.
        const afterWrite = yield* recorder.activePathForHash("sha256:shared")
        const twin = yield* Effect.result(
          seedFile(db, "areas/oncall/m2.html", "sha256:shared", 0, "semantic")
        )
        return { beforeWrite, written, afterWrite, twin }
      })
    )

    expect(outcome.beforeWrite).toBeNull()
    expect(Result.isSuccess(outcome.written)).toBe(true)
    expect(outcome.afterWrite).toBe("areas/oncall/m1.html")
    expect(Result.isFailure(outcome.twin)).toBe(true)
  })

  it("lets two identical-bodied open tasks both exist, in the lookup and the index alike", async () => {
    // Two open tasks with the same body are two real work items, so neither the lookup nor the
    // index folds one onto the other.
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFile(db, "areas/inbox/tasks/a.html", "sha256:dup", 0, "task")
        const second = yield* Effect.result(
          seedFile(db, "areas/inbox/tasks/b.html", "sha256:dup", 0, "task")
        )
        return {
          second,
          lookup: yield* makeIndexRecorder(db).activePathForHash("sha256:dup"),
          rows: yield* db.get<{ n: number }>(
            "SELECT count(*) AS n FROM files WHERE content_hash = 'sha256:dup'"
          )
        }
      })
    )
    expect(Result.isSuccess(outcome.second)).toBe(true)
    expect(outcome.lookup).toBeNull()
    expect(outcome.rows?.n).toBe(2)
  })
})

/**
 * `activeFramesFor` — the conflict assist's substrate, against the real driver.
 *
 * What has to be true is a conjunction, and each half is silent on its own: the query must find the
 * live claims occupying a slot, and it must find NOTHING else, because a row that leaks in becomes a
 * conflict report about a memory that was evicted or a to-do item. Batching is the third property and
 * it is a performance contract, so it is asserted by COUNTING queries rather than by reading the SQL.
 */
describe("activeFramesFor", () => {
  const KEY = "the capital of india is"
  const OTHER = "the largest city of india is"

  it("answers with the active non-task holders of each key, path and gist together", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFramed(db, "areas/facts/a.html", KEY, "The capital of India is New Delhi.")
        yield* seedFramed(db, "areas/facts/b.html", KEY, "The capital of India is Grosseto.")
        yield* seedFramed(db, "areas/facts/c.html", OTHER, "The largest city of India is Mumbai.")
        const found = yield* makeIndexRecorder(db).activeFramesFor([KEY, OTHER])
        return { first: found.get(KEY), second: found.get(OTHER), size: found.size }
      })
    )

    // The gist rides along because the conflict is only reportable WITH it: the frame is what the two
    // rows SHARE, so the values are the whole content of the disagreement.
    expect(outcome.first).toEqual([
      { path: "areas/facts/a.html", gist: "The capital of India is New Delhi." },
      { path: "areas/facts/b.html", gist: "The capital of India is Grosseto." }
    ])
    expect(outcome.second).toEqual([
      { path: "areas/facts/c.html", gist: "The largest city of India is Mumbai." }
    ])
    expect(outcome.size).toBe(2)
  })

  it("drops a match once it is archived, which is the eviction becoming visible", async () => {
    /**
     * The `archived = 0` half, proven by TRANSITION rather than by seeding an archived row: the same
     * row is found, then archived exactly as an eviction archives it, then not found. An
     * already-archived fixture would pass even against a query that filtered on the wrong column.
     *
     * (Verified by mutation: dropping `AND archived = 0` from `activeFramesFor` leaves the row in the
     * `after` result and fails this test.)
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFramed(db, "areas/facts/a.html", KEY, "The capital of India is New Delhi.")
        const recorder = makeIndexRecorder(db)
        const before = yield* recorder.activeFramesFor([KEY])
        yield* db.run("UPDATE files SET archived = 1, para = 'archive', path = ? WHERE path = ?", [
          "archive/2026/areas/facts/a.html",
          "areas/facts/a.html"
        ])
        const after = yield* recorder.activeFramesFor([KEY])
        return { before: before.get(KEY), after: after.get(KEY), afterSize: after.size }
      })
    )

    expect(outcome.before).toHaveLength(1)
    // An evicted memory is not a live claim, so it cannot contradict one.
    expect(outcome.after).toBeUndefined()
    expect(outcome.afterSize).toBe(0)
  })

  it("never answers with a task, even when the task holds the key alone", async () => {
    /**
     * The `memory_type <> 'task'` carve-out, mirroring `files_frame_key_active`. Seeded as the ONLY
     * holder, which is the case that discriminates: with a memory beside it the test would pass on a
     * query that merely happened to order the memory first.
     *
     * (Verified by mutation: dropping the clause makes the first expectation return the task's path.)
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFramed(
          db,
          "areas/inbox/tasks/t.html",
          KEY,
          "The capital of India is unverified.",
          0,
          "task"
        )
        const recorder = makeIndexRecorder(db)
        const taskOnly = yield* recorder.activeFramesFor([KEY])
        yield* seedFramed(db, "areas/facts/a.html", KEY, "The capital of India is New Delhi.")
        const withMemory = yield* recorder.activeFramesFor([KEY])
        return { taskOnly: taskOnly.get(KEY), withMemory: withMemory.get(KEY) }
      })
    )

    expect(outcome.taskOnly).toBeUndefined()
    // An agent's own to-do list must never be reported as contradicting its knowledge.
    expect(outcome.withMemory).toEqual([
      { path: "areas/facts/a.html", gist: "The capital of India is New Delhi." }
    ])
  })

  it("omits a key nobody holds rather than mapping it to an empty array", async () => {
    // `map.get(key) === undefined` already means "nothing holds this slot", so an empty array would be
    // a second encoding of one fact and a caller would have to handle both.
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFramed(db, "areas/facts/a.html", KEY, "The capital of India is New Delhi.")
        const found = yield* makeIndexRecorder(db).activeFramesFor([KEY, "nobody holds this"])
        return { size: found.size, absent: found.get("nobody holds this") }
      })
    )
    expect(outcome.size).toBe(1)
    expect(outcome.absent).toBeUndefined()
  })

  it("SEEKS the partial index rather than scanning the table", async () => {
    /**
     * The performance contract, at the planner. This lookup exists to be O(matches) instead of
     * O(corpus), and the entire mechanism is `files_frame_key_active` being CHOSEN — a query returning
     * the right rows by scanning would pass every other test in this file forever.
     *
     * What it locks is the PLAN, and not any one clause of the query. `activeFramesFor` mirrors the
     * index predicate clause for clause, and the clause the planner needs from it is `archived = 0`:
     * probed 2026-08-12 on node 24.19.0 (SQLite 3.53.3), dropping `archived = 0` reports `SCAN files`,
     * while `AND frame_key IS NOT NULL` can be deleted and the seek survives, because `frame_key IN (…)`
     * cannot match NULL and the planner derives that for itself. So a mutation of that one clause passes
     * here — the seek is what this case defends.
     *
     * The plan is taken of the SQL `activeFramesFor` ITSELF issues — captured off the `db` shape and
     * prefixed with `EXPLAIN QUERY PLAN` — rather than of a copy pasted into this test. A pasted copy
     * explains its own string: it reports the seek it was written with, whatever the production query
     * has since become.
     *
     * The 400-row seed and the `ANALYZE` buy nothing from this planner. Probed 2026-08-12 on node
     * 24.19.0 (SQLite 3.53.3) with one third of rows keyed, the plan is `SEARCH … USING INDEX
     * files_frame_key_active` at 0, 10, 200, 400, and 800 rows, with `ANALYZE` and without it
     * (`sqlite_stat1` reads "67 1" / "134 1" / "267 1" at 200 / 400 / 800). The choice is cost-based in
     * principle, so a future planner could want the rows back — but nothing here depends on them today.
     *
     * **Its own 120s timeout, and the 400-row seed is why.** Seeding 400 rows one statement at a time
     * plus `ANALYZE` measured 35-38 s wall on a loaded box (2026-08-08, load average ~30) against the
     * suite's 30 s default — so this case flakes under a parallel `turbo run test` while passing in
     * ~8 s on an idle one. Raising the whole suite's timeout would hide a real hang in the other 26
     * cases, so the allowance is here, where the work is. The same load-sensitivity
     * `packages/sleep/vitest.config.ts` records.
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        for (let at = 0; at < 400; at += 1) {
          yield* seedFramed(
            db,
            `areas/facts/bulk-${at}.html`,
            at % 3 === 0 ? `key-${at}` : null,
            "The capital of India is New Delhi."
          )
        }
        yield* db.run("ANALYZE")

        // Capture the real query, then explain exactly that string with exactly those binds.
        let issued: { sql: string; params: ReadonlyArray<unknown> } | null = null
        const capturing: DatabaseShape = {
          ...db,
          all: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
            issued = { sql, params: params ?? [] }
            return (db.all as never as (s: string, p?: ReadonlyArray<unknown>) => Effect.Effect<A>)(
              sql,
              params
            )
          }) as DatabaseShape["all"]
        }
        const matches = yield* makeIndexRecorder(capturing).activeFramesFor(["key-3", "key-6"])
        const captured = issued as { sql: string; params: ReadonlyArray<unknown> } | null
        if (captured === null) return { detail: "NO QUERY ISSUED", sql: "", found: 0 }

        const plan = yield* db.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${captured.sql}`,
          captured.params as never
        )
        return {
          detail: plan.map((row) => row.detail).join(" | "),
          sql: captured.sql,
          found: (matches.get("key-3") ?? []).length
        }
      })
    )

    // The lookup really ran and really matched, so the plan describes a query that does the work.
    expect(outcome.found).toBe(1)
    expect(outcome.detail).toContain("files_frame_key_active")
    expect(outcome.detail).toContain("SEARCH")
    expect(outcome.detail).not.toContain("SCAN files")
  }, 120_000)

  it("never queries a NULL frame_key row, because an IN list cannot match NULL", async () => {
    // Most rows have no frame shape. They must be invisible to this lookup even when a caller passes
    // something falsy-adjacent, which is also why `files_frame_key_active` carries `IS NOT NULL`.
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFramed(db, "areas/facts/nokey.html", null, "Water is wet.")
        const found = yield* makeIndexRecorder(db).activeFramesFor([""])
        const rows = yield* db.get<{ n: number }>(
          "SELECT count(*) AS n FROM files WHERE frame_key IS NULL"
        )
        return { size: found.size, nulls: rows?.n }
      })
    )
    expect(outcome.nulls).toBe(1)
    expect(outcome.size).toBe(0)
  })

  it("asks ONE query for a whole key-set, and none at all for an empty one", async () => {
    /**
     * The batching contract, asserted by counting `all` calls rather than by inspecting the SQL — the
     * shape of the string is not the property, the number of round trips is. A `get` per key would
     * turn a batch write of N memories into N queries against a corpus-sized table, which is the
     * quadratic-write-cost pattern this codebase has already paid for once.
     *
     * (Verified by mutation: replacing the `IN` list with a per-key loop makes `queries` 5 and fails.)
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFramed(db, "areas/facts/a.html", KEY, "The capital of India is New Delhi.")
        let queries = 0
        const counted: DatabaseShape = {
          ...db,
          all: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
            queries += 1
            return (db.all as never as (s: string, p?: ReadonlyArray<unknown>) => Effect.Effect<A>)(
              sql,
              params
            )
          }) as DatabaseShape["all"]
        }
        const recorder = makeIndexRecorder(counted)
        const many = yield* recorder.activeFramesFor([KEY, OTHER, "k3", "k4", "k5"])
        const afterFive = queries
        const empty = yield* recorder.activeFramesFor([])
        return { queries, afterFive, emptySize: empty.size, found: many.get(KEY)?.length }
      })
    )

    // Five keys, one round trip.
    expect(outcome.afterFive).toBe(1)
    // And an empty key-set short-circuits: a zero-length `IN ()` is a syntax error on this driver, and
    // a query with nothing to ask is not a query.
    expect(outcome.queries).toBe(1)
    expect(outcome.emptySize).toBe(0)
    expect(outcome.found).toBe(1)
  })

  it("collapses a duplicated key into ONE bind, not one per occurrence", async () => {
    /**
     * A caller assembling keys from a batch of memories will repeat them — several memories in one
     * batch restating the same slot is the common case, not the edge case. The dedupe is a BIND-COUNT
     * property, so that is what is asserted here.
     *
     * The result is deliberately NOT the assertion: `IN (?, ?, ?)` bound to the same value three times
     * returns one row regardless, so a test that only checked `toHaveLength(1)` would pass with the
     * dedupe deleted. (Confirmed by mutation — that is exactly what happened on the first version of
     * this test, and the bind-count assertion below is the fix.) Binds are finite and this list is
     * caller-sized; a 500-memory batch restating one slot would otherwise bind 500 placeholders for a
     * one-value question.
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedFramed(db, "areas/facts/a.html", KEY, "The capital of India is New Delhi.")
        const bindCounts: Array<number> = []
        const counted: DatabaseShape = {
          ...db,
          all: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
            bindCounts.push(params?.length ?? 0)
            return (db.all as never as (s: string, p?: ReadonlyArray<unknown>) => Effect.Effect<A>)(
              sql,
              params
            )
          }) as DatabaseShape["all"]
        }
        const found = yield* makeIndexRecorder(counted).activeFramesFor([KEY, KEY, KEY, OTHER, KEY])
        return { bindCounts, matches: found.get(KEY) }
      })
    )

    // Five keys in, two distinct, two placeholders bound.
    expect(outcome.bindCounts).toEqual([2])
    expect(outcome.matches).toHaveLength(1)
  })
})

/** A `files` row carrying an explicit `frame_key`, for the lookup's tests. */
const seedFramed = (
  db: DatabaseShape,
  path: string,
  frameKey: string | null,
  gist: string,
  archived = 0,
  memoryType = "semantic"
) =>
  db.run(
    `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, gist, fts_text,
       disclosure_text, para, archived, task_status, frame_key, created_at, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, 'T', 'b', ?, 'f', 'd', ?, ?, ?, ?, ?, ?, ?)`,
    [
      path,
      `blob-${path}`,
      `sha256:${path}`,
      memoryType,
      gist,
      archived === 1 ? "archive" : "areas",
      archived,
      memoryType === "task" ? "todo" : null,
      frameKey,
      AT,
      AT,
      AT
    ]
  )

const seedFile = (
  db: DatabaseShape,
  path: string,
  hash: string,
  archived: number,
  memoryType = "semantic"
) =>
  db.run(
    `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, gist, fts_text,
       disclosure_text, para, archived, task_status, created_at, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, 'T', 'b', 'g', 'f', 'd', ?, ?, ?, ?, ?, ?)`,
    [
      path,
      `blob-${path}`,
      hash,
      memoryType,
      archived === 1 ? "archive" : "areas",
      archived,
      memoryType === "task" ? "todo" : null,
      AT,
      AT,
      AT
    ]
  )
