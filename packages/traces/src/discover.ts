import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"

import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"

/**
 * Discovery over the session-transcript tree. `.memhtml` never holds session content — the `traces`
 * table is a read-only index over this tree (design §7), and this module is the only place that
 * names its layout.
 */

/** The subdirectory holding a session's subagent sidecars. */
export const SUBAGENTS_DIR = "subagents"

/** The `projects/` directory the per-cwd slug directories live under. */
export const PROJECTS_DIR = "projects"

/** A sidecar filename is `agent-<agentId>.jsonl`; the `.meta.json` beside it is not a transcript. */
const SIDECAR_PATTERN = /^agent-(.+)\.jsonl$/

/** A main session's filename stem is its `sessionId`. */
const SESSION_PATTERN = /^(.+)\.jsonl$/

/**
 * - `session` — `<root>/projects/<slug>/<sessionId>.jsonl`, the main transcript.
 * - `subagent` — `<root>/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl`. Its
 *   records carry the parent `sessionId` too, so it indexes into the same session row.
 */
export type SessionFileKind = "session" | "subagent"

/** One discovered transcript file with the stat the watermark decision needs. */
export interface SessionFile {
  /** Absolute path, built from the caller's `traceRoot`. */
  readonly filePath: string
  /** The `projects/<slug>` directory name — the cwd slug, `traces.slug`. */
  readonly slug: string
  /**
   * The session this file belongs to, read from the path: the filename stem for a main session,
   * the owning directory name for a sidecar. Path-derived rather than parsed, so discovery costs
   * one `readdir` per directory and never opens a file.
   */
  readonly sessionId: string
  readonly kind: SessionFileKind
  /** Set only on a sidecar, from its `agent-<agentId>.jsonl` filename. */
  readonly agentId: string | null
  readonly size: number
  readonly mtimeMs: number
}

/** The errno of a rejected `node:fs` call, when it carries one. */
const errnoOf = (cause: unknown): string | null => {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : null
}

/**
 * Directory entries, or `[]` when the directory is absent.
 *
 * Absence is a normal state, not a failure: a session directory has no `subagents/` until its
 * first subagent runs, and a machine with no transcripts has no `projects/` at all. `ENOTDIR`
 * counts as absence too — a *file* where a slug directory was expected holds no transcripts. Any
 * other rejection, permission denied above all, is a real {@link StorageFailure}: silently
 * returning `[]` for an unreadable tree would report a successful scan of zero sessions.
 */
const readDirOrEmpty = (
  path: string,
  operation: string
): Effect.Effect<ReadonlyArray<Dirent>, StorageFailure> =>
  Effect.tryPromise({
    try: () => readdir(path, { withFileTypes: true }),
    catch: (cause) => cause
  }).pipe(
    Effect.catch((cause) => {
      const code = errnoOf(cause)
      return code === "ENOENT" || code === "ENOTDIR"
        ? Effect.succeed<ReadonlyArray<Dirent>>([])
        : Effect.logError(`${operation} failed: ${String(code ?? cause)}`).pipe(
            Effect.andThen(Effect.fail(StorageFailure.make({ operation })))
          )
    })
  )

/**
 * Every transcript file under `traceRoot`, main sessions and subagent sidecars alike.
 *
 * `traceRoot` is a parameter with `~/.claude` as the caller's default — never hardcoded here, so a
 * test drives a fixture tree and an operator can point the indexer at an archive.
 *
 * A file that vanishes between `readdir` and `stat` is dropped rather than failed: transcripts are
 * written by a live process that may compact or delete one mid-scan, and the next run rediscovers
 * whatever is there.
 */
export const discoverSessions = (
  traceRoot: string
): Effect.Effect<ReadonlyArray<SessionFile>, StorageFailure> =>
  Effect.gen(function* () {
    const projectsDir = join(traceRoot, PROJECTS_DIR)
    const slugEntries = yield* readDirOrEmpty(projectsDir, "traces.discover.projects")

    const files: Array<SessionFile> = []

    for (const slugEntry of slugEntries) {
      if (!slugEntry.isDirectory()) continue
      const slug = slugEntry.name
      const slugDir = join(projectsDir, slug)
      const entries = yield* readDirOrEmpty(slugDir, "traces.discover.slug")

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionId = entry.name
          const sidecarDir = join(slugDir, sessionId, SUBAGENTS_DIR)
          const sidecars = yield* readDirOrEmpty(sidecarDir, "traces.discover.subagents")

          for (const sidecar of sidecars) {
            if (!sidecar.isFile()) continue
            const match = SIDECAR_PATTERN.exec(sidecar.name)
            if (match?.[1] === undefined) continue
            const filePath = join(sidecarDir, sidecar.name)
            const stats = yield* statOrNull(filePath)
            if (stats === null) continue
            files.push({
              filePath,
              slug,
              sessionId,
              kind: "subagent",
              agentId: match[1],
              size: stats.size,
              mtimeMs: stats.mtimeMs
            })
          }
          continue
        }

        if (!entry.isFile()) continue
        const match = SESSION_PATTERN.exec(entry.name)
        if (match?.[1] === undefined) continue
        const filePath = join(slugDir, entry.name)
        const stats = yield* statOrNull(filePath)
        if (stats === null) continue
        files.push({
          filePath,
          slug,
          sessionId: match[1],
          kind: "session",
          agentId: null,
          size: stats.size,
          mtimeMs: stats.mtimeMs
        })
      }
    }

    return files
  })

/**
 * A file's size and mtime, or `null` when it disappeared between listing and stat.
 *
 * `mtimeMs` is TRUNCATED to a whole millisecond, and that is load-bearing rather than tidy.
 * `node:fs`'s `Stats.mtimeMs` is a float carrying sub-millisecond precision on Linux (measured
 * 2026-08-02: `1785650975408.8376`), while the `trace_watermarks.mtime` column is ISO-8601 text,
 * which has exactly millisecond resolution. So a stored watermark reads back as the integer
 * `1785650975408` and never equals the float the next stat reports — the skip test
 * `curr.mtimeMs === prev.mtimeMs` fails for EVERY unchanged file, and every run re-reads the whole
 * corpus. Truncating here makes the value's resolution match the only serialized form it has, so
 * the equality is round-trip-safe by construction rather than by a comparison tolerance.
 */
const statOrNull = (
  filePath: string
): Effect.Effect<{ readonly size: number; readonly mtimeMs: number } | null, never> =>
  Effect.tryPromise({
    try: () => stat(filePath),
    catch: () => "gone" as const
  }).pipe(
    Effect.map((stats) => ({ size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) })),
    Effect.catch(() => Effect.succeed(null))
  )

/**
 * The `agentId`s of a session's sidecars, from filenames alone. Feeds `agent_count` without
 * opening a sidecar — the count is a property of the tree, and the sidecars' own records are
 * indexed on their own pass.
 */
export const sidecarAgentIds = (
  files: ReadonlyArray<SessionFile>,
  sessionId: string
): ReadonlyArray<string> => [
  ...new Set(
    files.flatMap((file) =>
      file.kind === "subagent" && file.sessionId === sessionId && file.agentId !== null
        ? [file.agentId]
        : []
    )
  )
]

/** The session id a transcript path names, or `null` when the path is not one. Pure. */
export const sessionIdFromPath = (filePath: string, traceRoot: string): string | null => {
  const normalized = filePath.replaceAll("\\", "/")
  const rootPrefix = `${join(traceRoot, PROJECTS_DIR).replaceAll("\\", "/")}/`
  if (!normalized.startsWith(rootPrefix)) return null
  const segments = normalized.slice(rootPrefix.length).split("/")
  // <slug>/<sessionId>.jsonl
  if (segments.length === 2) {
    const match = SESSION_PATTERN.exec(basename(segments[1] ?? ""))
    return match?.[1] ?? null
  }
  // <slug>/<sessionId>/subagents/agent-<agentId>.jsonl
  if (segments.length === 4 && segments[2] === SUBAGENTS_DIR) return segments[1] ?? null
  return null
}
