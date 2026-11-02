import { STORE_CONFIG_FILE } from "@memhtml/contracts"

import { SESSION_VAR } from "./config.js"

/**
 * The v1 doors that create a record, and what each refusal says when the store's `v1Doors` mode
 * (`memhtml.config.json`) closes them.
 *
 * Each of `write`, `apply`, `correct`, and `task add` commits straight to the store through
 * `@memhtml/store`, and none runs the write bar `validateOps` holds every session to
 * (`writeBarReasons` in `@memhtml/session`), so a record the store's bar would refuse lands through
 * any of them. Edits of existing records (`link`, `archive`, `task status`, `reinforce`) create
 * nothing the bar judges, and no mode closes them.
 *
 * A module of its own, importing nothing from the command table, so `run.ts` (the refusal before
 * anything opens) and `errors.ts` (the same refusal raised inside a layer) share one copy.
 */

/**
 * A `session put` suggestion that runs as written: `line` is one JSONL write line, piped on stdin,
 * with `--id` when the caller has no `MEMHTML_SESSION` to name the session for it.
 */
const putLine = (line: Record<string, string>, id?: string): string =>
  `printf '%s\\n' '${JSON.stringify({ op: "write", ...line })}' | memhtml session put${id === undefined ? "" : ` --id ${id}`} --file -`

/** The write line each door's suggestions carry. */
const LINES: Readonly<Record<string, Record<string, string>>> = {
  write: { title: "<title>", type: "semantic", body: "<the fact>", entity: "project:<slug>" },
  apply: { title: "<title>", type: "semantic", body: "<the fact>", entity: "system:<name>" },
  correct: {
    title: "<corrected title>",
    type: "semantic",
    body: "<the corrected fact>",
    entity: "project:<slug>"
  },
  "task add": { title: "<task>", type: "task", body: "<what to do>", workspace: "<slug>" }
}

/**
 * Each record-creating door with the session command that does its job (`how`) and the suggestions
 * a refusal under `MEMHTML_SESSION` carries. Exported so a test decodes every suggested line with
 * the decoder `session put` uses.
 */
export const RECORD_CREATING_V1_COMMANDS: ReadonlyMap<
  string,
  { readonly how: string; readonly suggestions: ReadonlyArray<string> }
> = new Map([
  [
    "write",
    {
      how: "write the record as a session put line, or as a file under /mnt/memhtml from `memhtml session exec <<'SH'`",
      suggestions: [putLine(LINES.write ?? {}), "memhtml help session exec"]
    }
  ],
  [
    "apply",
    {
      how: "`memhtml session put` reads the same write lines `apply` reads",
      suggestions: ["memhtml session put --file ops.jsonl", putLine(LINES.apply ?? {})]
    }
  ],
  [
    "correct",
    {
      how: "write the corrected record under its own title with a `memhtml-supersedes` link to the old one's archive slot, /archive/<year>/<the old one's path> or /archive/<year>.<n>/<the old one's path> when an earlier archiving holds that one, and move the old one to that slot, in one `memhtml session exec <<'SH'`",
      suggestions: ["memhtml help session exec", putLine(LINES.correct ?? {})]
    }
  ],
  [
    "task add",
    {
      how: 'a task is a session put write line with `"type":"task"`, anchored by a workspace or an entity',
      suggestions: [putLine(LINES["task add"] ?? {}), "memhtml help session put"]
    }
  ]
])

/** The session id the `closed`-mode suggestions name, for a caller with no `MEMHTML_SESSION`. */
const SUGGESTED_ID = "s1"

/**
 * The refusal of `door` with no session set, under the store's `closed` mode: records go in through
 * a session the caller starts, writes, and commits itself.
 */
export const closedDoorRefusal = (
  door: string
): { readonly error: string; readonly suggestions: ReadonlyArray<string> } => ({
  error: `${door} creates a record with no write bar, and this store's ${STORE_CONFIG_FILE} sets v1Doors to "closed", so records go in through a session held to the bar: start one with \`memhtml session start --id <id>\`, write with \`memhtml session put\` or \`memhtml session exec\`, and land it with \`memhtml session commit\``,
  suggestions: [
    `memhtml session start --id ${SUGGESTED_ID}`,
    putLine(LINES[door] ?? LINES.write ?? {}, SUGGESTED_ID),
    `memhtml session commit --id ${SUGGESTED_ID} --message <subject>`
  ]
})

/** The refusal of `door` in a process carrying `session` (`MEMHTML_SESSION`). */
export const sessionDoorRefusal = (
  door: string,
  session: string
): { readonly error: string; readonly suggestions: ReadonlyArray<string> } => {
  const instead = RECORD_CREATING_V1_COMMANDS.get(door)
  return {
    error: `${door} creates a record with no write bar, and ${SESSION_VAR} is set (${JSON.stringify(session)}), so this process writes through that session: ${instead?.how ?? "write through `memhtml session put` or `memhtml session exec`"}. The write bar judges each record as it is written and the session lands as one commit`,
    suggestions: instead?.suggestions ?? ["memhtml help session put"]
  }
}
