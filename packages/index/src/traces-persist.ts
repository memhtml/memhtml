import type { StorageFailure } from "@memhtml/contracts/errors"
import { Context, Effect } from "effect"

import type { DatabaseShape, Write } from "./database.js"
import { EXCLUDED_BY_DEFAULT } from "./scope.js"

/**
 * Persistence for the trace plane and the memory-session links.
 *
 * The trace SCANNER lives in `@memhtml/traces`, which depends on this package — so this module states
 * the shapes it consumes structurally rather than importing them. `@memhtml/traces` types bind by shape,
 * and the dependency arrow stays pointed one way.
 *
 * That one-way arrow is also why the tail merge is an INJECTED function rather than an import. A
 * tail's extract describes the appended slice and not the session: its `firstPrompt` is a prompt from
 * the middle of the conversation, its `startedAt` is an hour after the session began, its
 * `turnCount` counts only new turns, and its prompt ordinals restart at 0. Merging it correctly is
 * the producer's own reading semantics, so `@memhtml/traces` owns `mergeTailExtract` and this module
 * requires it as a parameter — {@link persistScanned} cannot write a tail without calling it, which
 * makes "never upsert a tail extract directly" a type-level obligation instead of a convention.
 */

/** One prompt row, structurally `@memhtml/traces`'s `PromptRow`. */
export interface PromptRowLike {
  readonly promptId: string
  readonly turnUuid: string
  /** 0-based position among the distinct prompts of THIS session, first-appearance order. */
  readonly ordinal: number
  readonly at: string
  readonly agentId: string | null
  readonly textHead: string
}

/** One session's extract, structurally `@memhtml/traces`'s `SessionExtract`. */
export interface SessionExtractLike {
  readonly filePath: string
  readonly slug: string
  readonly sessionId: string | null
  readonly cwd: string | null
  readonly gitBranch: string | null
  readonly entrypoint: string | null
  readonly version: string | null
  readonly model: string | null
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly promptCount: number
  readonly turnCount: number
  readonly agentIds: ReadonlyArray<string>
  readonly firstPrompt: string
  readonly aiTitle: string | null
  readonly prompts: ReadonlyArray<PromptRowLike>
}

/** A stat-based watermark, structurally `@memhtml/traces`'s `Watermark`. `mtimeMs` is epoch MILLISECONDS. */
export interface WatermarkLike {
  readonly size: number
  readonly mtimeMs: number
  /** 0-based byte offset: one past the last byte consumed, and the `start` of the next read. */
  readonly byteOff: number
}

/** One scanned file, structurally `@memhtml/traces`'s `ScannedFile`. */
export interface ScannedFileLike {
  readonly file: { readonly filePath: string; readonly kind: "session" | "subagent" }
  readonly action: "skip" | "tail" | "rescan"
  readonly extract: SessionExtractLike | null
  readonly agentCount: number
  readonly watermark: WatermarkLike
}

/** `@memhtml/traces`'s `mergeTailExtract`, as a requirement. */
export type TailMerger = (
  stored: SessionExtractLike,
  tail: SessionExtractLike
) => SessionExtractLike

/** The kinds of link a memory can have to a session. */
export const LINK_KINDS = ["wrote", "read", "corrected", "reinforced"] as const
export type LinkKind = (typeof LINK_KINDS)[number]

/** One `memory_session_links` row. */
export interface SessionLink {
  readonly path: string
  readonly sessionId: string
  readonly promptId?: string | undefined
  readonly turnUuid?: string | undefined
  readonly linkKind: LinkKind
  readonly at: string
}

/**
 * The write-path recorder. The store calls this after a successful write, correction, read, or
 * reinforcement, so the link exists in BOTH planes: file-borne as `memhtml-session`/`memhtml-prompt`/
 * `memhtml-turn` (survives a rebuild) and indexed here (queryable in both directions).
 *
 * A service rather than a bare function because the store must not depend on this package — the CLI
 * composes the two, and the store holds only the shape.
 */
export interface IndexRecorderShape {
  readonly recordLink: (link: SessionLink) => Effect.Effect<void, StorageFailure>
  /** The content-hash dedup lookup the store's write path gates on. */
  readonly activePathForHash: (contentHash: string) => Effect.Effect<string | null, StorageFailure>
  /**
   * The live claims occupying each of the given frame keys — the conflict assist's substrate.
   *
   * BATCH by signature, not by convenience: one query per key-set, never one per key. A per-op
   * lookup is the quadratic-write-cost shape the fleet has already paid for once, and a batch write
   * of N memories asking N questions of a table this size is precisely that mistake with a different
   * predicate. A caller holding one key passes a one-element array.
   */
  readonly activeFramesFor: (
    keys: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<FrameMatch>>, StorageFailure>
}

/**
 * One live claim already occupying a frame key.
 *
 * `gist` travels with `path` because the conflict is only reportable WITH it: two rows sharing a
 * frame key state the same relation, and the VALUES are what differ — so a caller handed paths alone
 * would have to re-read every candidate file to say what the disagreement is. One query carries both.
 */
export interface FrameMatch {
  readonly path: string
  readonly gist: string
}

export const IndexRecorder = Context.Service<IndexRecorderShape>("memhtml/IndexRecorder")

export const makeIndexRecorder = (db: DatabaseShape): IndexRecorderShape => ({
  /**
   * Idempotent on `(path, session_id, link_kind, at)` — the primary key. Two recorders racing on the
   * same instant record one row rather than failing the write they were describing: a provenance
   * link is a fact about what happened, and losing the memory over a duplicate note about it would
   * invert the priority.
   */
  recordLink: (link) =>
    db.run(
      `INSERT INTO memory_session_links (path, session_id, prompt_id, turn_uuid, link_kind, at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path, session_id, link_kind, at) DO NOTHING`,
      [
        link.path,
        link.sessionId,
        link.promptId ?? null,
        link.turnUuid ?? null,
        link.linkKind,
        link.at
      ]
    ),
  /**
   * `memory_type <> 'task'` mirrors the `files_content_hash_active` partial unique index EXACTLY,
   * and the agreement is the point: this query is the write path's dedup question and that index is
   * the database's answer, so a predicate on one and not the other is a write the store declines
   * that the database would have accepted — or worse, accepts and the database refuses.
   *
   * Both directions of the carve-out matter. Two open tasks with identical bodies are two real
   * work items, so neither is deduped onto the other. And a NEW memory whose article happens to
   * match an open task's must not be deduped onto that task: the caller would get back a task's
   * path as the home of its fact, and the fact would never be stored.
   */
  activePathForHash: (contentHash) =>
    db
      .get<{ path: string }>(
        `SELECT path FROM files
         WHERE content_hash = ? AND archived = 0 AND memory_type <> '${EXCLUDED_BY_DEFAULT}'`,
        [contentHash]
      )
      .pipe(Effect.map((row) => row?.path ?? null)),
  /**
   * ONE query for the whole key-set, via an `IN` list sized to the input. The alternative — a `get`
   * per key — turns a batch write of N memories into N round trips against a corpus-sized table,
   * which is the quadratic-write-cost pattern this codebase has already been bitten by. The shape is
   * the guarantee: the signature takes an array, so a caller CANNOT accidentally loop.
   *
   * The predicate mirrors `files_frame_key_active` (0009) clause for clause, and the seemingly
   * redundant `frame_key IS NOT NULL` is the load-bearing part of that. `frame_key IN (…)` already
   * cannot match NULL, so the clause changes no result — but a partial index is only usable when the
   * query's WHERE clause IMPLIES the index's predicate, and this planner does not derive
   * "not null" from the `IN` (probed 2026-08-07 on @tursodatabase/database 0.7.2 over 400 rows after
   * `ANALYZE`: without the clause `EXPLAIN QUERY PLAN` reports `SCAN files`, with it
   * `SEARCH files USING INDEX files_frame_key_active (frame_key=?)`). Dropping it as dead code
   * therefore turns every conflict lookup into a full table scan while returning identical rows —
   * invisible to every correctness test and visible only as latency at corpus scale.
   *
   * `memory_type <> 'task'` also carries meaning beyond the index. A task is intermediate working
   * state, so an open to-do phrased as a claim is not a competing assertion about the world — folding
   * one into a conflict report would have the assist tell an agent its own to-do list contradicts its
   * knowledge.
   *
   * Keys with no live occupant are ABSENT from the map rather than present-and-empty: a caller asks
   * `map.get(key)` and `undefined` already means "nothing holds this slot", so an empty array would be
   * a second encoding of one fact. An empty input short-circuits without touching the database — a
   * zero-length `IN ()` is a syntax error on this driver, and a query with nothing to ask is not a
   * query.
   */
  activeFramesFor: (keys) =>
    Effect.gen(function* () {
      const unique = [...new Set(keys.filter((key) => key !== ""))]
      if (unique.length === 0) return new Map<string, ReadonlyArray<FrameMatch>>()

      const rows = yield* db.all<{ frame_key: string; path: string; gist: string }>(
        `SELECT frame_key, path, gist FROM files
         WHERE frame_key IN (${unique.map(() => "?").join(", ")})
           AND archived = 0 AND memory_type <> '${EXCLUDED_BY_DEFAULT}'
           AND frame_key IS NOT NULL
         ORDER BY path`,
        [...unique]
      )

      const byKey = new Map<string, Array<FrameMatch>>()
      for (const row of rows) {
        const bucket = byKey.get(row.frame_key)
        const match: FrameMatch = { path: row.path, gist: row.gist }
        if (bucket === undefined) byKey.set(row.frame_key, [match])
        else bucket.push(match)
      }
      return byKey
    })
})

/** The `trace_watermarks` reader `@memhtml/traces`'s `scanTraceRoot` takes as its callback. */
export const readWatermark =
  (db: DatabaseShape) =>
  (filePath: string): Effect.Effect<WatermarkLike | null, StorageFailure> =>
    db
      .get<{ size: number; mtime: string; byte_off: number }>(
        "SELECT size, mtime, byte_off FROM trace_watermarks WHERE file_path = ?",
        [filePath]
      )
      .pipe(
        Effect.map((row) =>
          row === undefined
            ? null
            : {
                size: row.size,
                // The column is ISO-8601 TEXT and the scanner works in epoch milliseconds. The
                // conversion lives at this boundary, once, so neither side carries two units.
                mtimeMs: Date.parse(row.mtime),
                byteOff: row.byte_off
              }
        )
      )

/** The `trace_watermarks` upsert. */
export const writeWatermark = (
  filePath: string,
  watermark: WatermarkLike,
  scannedAt: string
): Write => ({
  sql: `INSERT INTO trace_watermarks (file_path, size, mtime, byte_off, scanned_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
          byte_off = excluded.byte_off, scanned_at = excluded.scanned_at`,
  params: [
    filePath,
    watermark.size,
    new Date(watermark.mtimeMs).toISOString(),
    watermark.byteOff,
    scannedAt
  ]
})

/**
 * Reconstruct a stored session's extract from its rows, for the tail merge.
 *
 * Only the fields the merge reads are reconstructed; `counters` is not, because it is scan
 * bookkeeping rather than session content and the row does not carry it. That is why the merger is
 * typed on {@link SessionExtractLike} — the persisted row is genuinely a subset of what a fresh
 * parse yields, and pretending otherwise would mean inventing counter values the database never saw.
 */
export const readStoredExtract = (
  db: DatabaseShape,
  sessionId: string
): Effect.Effect<SessionExtractLike | null, StorageFailure> =>
  Effect.gen(function* () {
    const row = yield* db.get<{
      slug: string
      cwd: string | null
      git_branch: string | null
      entrypoint: string | null
      version: string | null
      model: string | null
      started_at: string | null
      ended_at: string | null
      prompt_count: number
      turn_count: number
      agent_count: number
      first_prompt: string
      ai_title: string | null
      file_path: string
    }>(
      `SELECT slug, cwd, git_branch, entrypoint, version, model, started_at, ended_at,
              prompt_count, turn_count, agent_count, first_prompt, ai_title, file_path
       FROM traces WHERE session_id = ?`,
      [sessionId]
    )
    if (row === undefined) return null

    const prompts = yield* db.all<{
      prompt_id: string
      turn_uuid: string
      ordinal: number
      at: string
      agent_id: string | null
      text_head: string
    }>(
      `SELECT prompt_id, turn_uuid, ordinal, at, agent_id, text_head
       FROM trace_prompts WHERE session_id = ? ORDER BY ordinal`,
      [sessionId]
    )

    return {
      filePath: row.file_path,
      slug: row.slug,
      sessionId,
      cwd: row.cwd,
      gitBranch: row.git_branch,
      entrypoint: row.entrypoint,
      version: row.version,
      model: row.model,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      promptCount: row.prompt_count,
      turnCount: row.turn_count,
      // Not reconstructible from the row: `agent_count` is a number, and the id list that produced
      // it is not stored (it is a scan-time union of this file's ids with the sidecar filenames).
      // The merge unions both sides, so an empty stored list makes the tail's ids authoritative —
      // correct, because the sidecar set is re-derived on every scan.
      agentIds: [],
      firstPrompt: row.first_prompt,
      aiTitle: row.ai_title,
      prompts: prompts.map((prompt) => ({
        promptId: prompt.prompt_id,
        turnUuid: prompt.turn_uuid,
        ordinal: prompt.ordinal,
        at: prompt.at,
        agentId: prompt.agent_id,
        textHead: prompt.text_head
      }))
    }
  })

/** What one file's persistence produced. */
export interface PersistOutcome {
  readonly sessionId: string | null
  readonly action: "skip" | "tail" | "rescan"
  /** True when the tail merger ran. False for a skip and for a rescan. */
  readonly merged: boolean
  readonly promptsWritten: number
}

/**
 * Persist one scanned file: the `traces` row, its `trace_prompts`, and its watermark.
 *
 * The three actions are genuinely different writes:
 *
 * - **skip** — the file was not opened, so there is no extract. Nothing is written at all, including
 *   the watermark: the stored one already describes this exact file, and rewriting it would move
 *   `scanned_at` on a file nobody read.
 * - **rescan** — the extract describes the whole file and REPLACES the stored row outright, prompts
 *   delete-and-inserted. Merging here would fold the file into a stale copy of itself.
 * - **tail** — the extract describes only the appended slice. The stored row is read back and
 *   `mergeTail` combines them. Writing the tail's extract directly would reset `first_prompt` to a
 *   mid-conversation prompt, move `started_at` forward, and collide every prompt at ordinal 0.
 *
 * A session with no id is dropped: `traces.session_id` is the primary key, and a `file-history-*`
 * -only file has no session to be about.
 *
 * `file_path` on the row is the MAIN transcript's. A session's sidecars are separate scanned files
 * upserting into one row, and letting a sidecar claim the row's `file_path` would point the citation
 * at a subagent's slice of the conversation.
 */
export const persistScanned = (
  db: DatabaseShape,
  scanned: ScannedFileLike,
  mergeTail: TailMerger,
  indexedAt: string
): Effect.Effect<PersistOutcome, StorageFailure> =>
  Effect.gen(function* () {
    if (scanned.action === "skip" || scanned.extract === null) {
      return {
        sessionId: scanned.extract?.sessionId ?? null,
        action: scanned.action,
        merged: false,
        promptsWritten: 0
      }
    }

    const sessionId = scanned.extract.sessionId
    if (sessionId === null) {
      yield* db.writeAll([writeWatermark(scanned.file.filePath, scanned.watermark, indexedAt)])
      return { sessionId: null, action: scanned.action, merged: false, promptsWritten: 0 }
    }

    let extract = scanned.extract
    let merged = false
    if (scanned.action === "tail") {
      const stored = yield* readStoredExtract(db, sessionId)
      if (stored !== null) {
        extract = mergeTail(stored, scanned.extract)
        merged = true
      }
    }

    const isMain = scanned.file.kind === "session"
    const searchText = [extract.firstPrompt, extract.aiTitle ?? ""]
      .filter((part) => part !== "")
      .join("\n")

    const writes: Array<Write> = [
      {
        sql: `INSERT INTO traces (
                session_id, slug, cwd, git_branch, entrypoint, model, version, started_at, ended_at,
                prompt_count, turn_count, agent_count, first_prompt, ai_title, file_path, file_size,
                file_mtime, search_text, indexed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                slug = excluded.slug, cwd = excluded.cwd, git_branch = excluded.git_branch,
                entrypoint = excluded.entrypoint, model = excluded.model, version = excluded.version,
                started_at = excluded.started_at, ended_at = excluded.ended_at,
                prompt_count = excluded.prompt_count, turn_count = excluded.turn_count,
                agent_count = max(agent_count, excluded.agent_count),
                first_prompt = excluded.first_prompt, ai_title = excluded.ai_title,
                file_path = CASE WHEN ?20 = 1 THEN excluded.file_path ELSE file_path END,
                file_size = CASE WHEN ?20 = 1 THEN excluded.file_size ELSE file_size END,
                file_mtime = CASE WHEN ?20 = 1 THEN excluded.file_mtime ELSE file_mtime END,
                search_text = excluded.search_text, indexed_at = excluded.indexed_at`,
        params: [
          sessionId,
          extract.slug,
          extract.cwd,
          extract.gitBranch,
          extract.entrypoint,
          extract.model,
          extract.version,
          extract.startedAt,
          extract.endedAt,
          extract.promptCount,
          extract.turnCount,
          scanned.agentCount,
          extract.firstPrompt,
          extract.aiTitle,
          scanned.file.filePath,
          scanned.watermark.size,
          new Date(scanned.watermark.mtimeMs).toISOString(),
          searchText,
          indexedAt,
          isMain ? 1 : 0
        ]
      },
      /**
       * Delete-and-insert, not upsert. The merged prompt list is authoritative and complete for this
       * session, and an upsert would leave behind a prompt row whose ordinal the merge renumbered —
       * two rows claiming one position, which stops `ordinal` from being an order at all.
       */
      { sql: "DELETE FROM trace_prompts WHERE session_id = ?", params: [sessionId] },
      ...extract.prompts.map((prompt) => ({
        sql: `INSERT INTO trace_prompts (session_id, prompt_id, turn_uuid, ordinal, at, agent_id, text_head)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          sessionId,
          prompt.promptId,
          prompt.turnUuid,
          prompt.ordinal,
          prompt.at,
          prompt.agentId,
          prompt.textHead
        ] satisfies Write["params"]
      })),
      writeWatermark(scanned.file.filePath, scanned.watermark, indexedAt)
    ]

    yield* db.writeAll(writes)
    return { sessionId, action: scanned.action, merged, promptsWritten: extract.prompts.length }
  }).pipe(Effect.withSpan("traces.persistScanned"))
