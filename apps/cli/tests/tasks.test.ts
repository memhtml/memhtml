import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { EXIT_RUNTIME, EXIT_USAGE } from "../src/envelope.js"
import { AUTHORABLE_RELS } from "../src/operations.js"
import { run } from "../src/run.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * The `memhtml task` family through `run(argv)`: placement, the hash-invariant status edit, the
 * `done`-archives transition, the blockers column, and every refusal.
 *
 * The whole family is sugar over the same use cases `write`/`link`/`archive` call, so what these
 * assertions are ABOUT is the composition: that `task add` reaches the placement rule, that
 * `task status` edits one head line without moving the content hash, and that `done` produces a
 * rename rather than a status word. Each is a state transition across git and SQL, which is the gap a
 * stateless fake cannot see.
 */

interface TaskWritten {
  readonly path: string
  readonly created: boolean
  readonly deduped: boolean
  readonly existingPath: string | null
  readonly taskStatus: string
  readonly dueAt: string | null
  readonly commitSha: string | null
}

interface TaskUpdated {
  readonly path: string
  readonly taskStatus: string
  readonly archived: boolean
  readonly archivePath: string | null
  readonly commitSha: string | null
  readonly unchanged: boolean
}

interface TaskList {
  readonly tasks: ReadonlyArray<{
    readonly path: string
    readonly title: string
    readonly taskStatus: string | null
    readonly dueAt: string | null
    readonly workspace: string | null
    readonly archived: boolean
    readonly blockedBy: ReadonlyArray<string>
  }>
  readonly nextCursor: string | null
}

/** One file's `memhtml-*` head metas as a record, read off disk. */
const metasOf = async (cli: Cli, path: string): Promise<Record<string, string>> => {
  const html = await readFile(join(cli.root, path), "utf8")
  const out: Record<string, string> = {}
  for (const match of html.matchAll(/<meta name="(memhtml-[^"]+)" content="([^"]*)">/g)) {
    out[match[1] as string] = match[2] as string
  }
  return out
}

describe("usage validation, before any service is touched", () => {
  /**
   * Every assertion here runs with NO layer, so it must be answered by `validate` alone. Reaching a
   * service would open a real repo — which is what makes these the cheap refusals an agent hits on a
   * typo rather than after a database round trip.
   */
  it("refuses a status outside the vocabulary and names the whole set", async () => {
    const result = await run(["task", "list", "--status", "in-progress"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain("todo, doing, blocked, done")
  })

  it("names the two positional arguments `task status` requires", async () => {
    const result = await run(["task", "status"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.code).toBe("ERR_MISSING_ARGUMENT")
    expect(body.error).toContain("path")
  })

  it("requires --title on `task add`", async () => {
    const result = await run(["task", "add"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect((JSON.parse(result.stdout) as Record<string, unknown>).error).toContain("--title")
  })

  it("suggests `task list` for a near miss on the compound name", async () => {
    const result = await run(["task", "lst"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect((JSON.parse(result.stdout) as Record<string, unknown>).suggestions).toContain(
      "task list"
    )
  })
})

describe("the authorable rel vocabulary", () => {
  it("admits the task rels and withholds the system-minted ones", () => {
    /**
     * The asymmetry is the design decision, not an oversight: a `blocks` edge between two tasks is a
     * real authored assertion, while a `person` edge is written by sleep's person-links phase against
     * the hand-edited identity surface and `from_session` is derived from provenance the caller
     * already supplied. Authoring either by hand puts a guess where a derivation belongs.
     */
    expect(AUTHORABLE_RELS).toContain("blocks")
    expect(AUTHORABLE_RELS).toContain("subtask_of")
    expect(AUTHORABLE_RELS).toContain("relates_to")
    expect(AUTHORABLE_RELS).not.toContain("about_person")
    expect(AUTHORABLE_RELS).not.toContain("authored_by")
    expect(AUTHORABLE_RELS).not.toContain("from_session")
  })
})

describe("the task lifecycle, end to end", () => {
  let cli: Cli
  let first: TaskWritten

  beforeAll(async () => {
    cli = await makeCli()
    first = await cli.json<TaskWritten>([
      "task",
      "add",
      "--title",
      "Wire the drain step into the rollback runbook",
      "--workspace",
      "checkout-api",
      "--due",
      "2026-08-20",
      "--body",
      "The runbook still tells an operator to revert first."
    ])
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("places a workspace task under projects/<slug>/tasks/ and opens it as todo", async () => {
    expect(first.created).toBe(true)
    expect(first.path).toMatch(/^projects\/checkout-api\/tasks\/.*\.html$/)
    expect(first.taskStatus).toBe("todo")
    expect(first.dueAt).toBe("2026-08-20")

    const metas = await metasOf(cli, first.path)
    expect(metas["memhtml-type"]).toBe("task")
    // The two axes stay separate: an open task is an ACTIVE memory, and `done` is the only thing that
    // moves `memhtml-status`.
    expect(metas["memhtml-status"]).toBe("active")
    expect(metas["memhtml-task-status"]).toBe("todo")
    expect(metas["memhtml-due"]).toBe("2026-08-20")
  })

  it("places a workspace-less task in the task inbox", async () => {
    const inbox = await cli.json<TaskWritten>([
      "task",
      "add",
      "--title",
      "Decide where the retention weights live"
    ])
    expect(inbox.path).toMatch(/^areas\/inbox\/tasks\/.*\.html$/)
  })

  it("defaults the claim to the title rather than requiring a second phrasing", async () => {
    const written = await cli.json<TaskWritten>([
      "task",
      "add",
      "--title",
      "Audit the trace watermark resolution"
    ])
    const detail = await cli.json<{ readonly gist: string }>(["read", written.path])
    expect(detail.gist).toBe("Audit the trace watermark resolution")
  })

  it("moves the status leaving the article and its hash byte-identical", async () => {
    const before = await metasOf(cli, first.path)
    const articleBefore = await cli.json<{ readonly html: string }>(["read", first.path])

    const updated = await cli.json<TaskUpdated>(["task", "status", first.path, "doing"])
    expect(updated.taskStatus).toBe("doing")
    expect(updated.archived).toBe(false)
    expect(updated.commitSha).not.toBeNull()

    const after = await metasOf(cli, first.path)
    expect(after["memhtml-task-status"]).toBe("doing")
    /**
     * The load-bearing assertion of the whole family, in both halves: the article's markup is the
     * same bytes AND the hash the file claims for itself is unmoved.
     *
     * `setMeta` splices by source offset, so a head edit cannot reach the article — which is what
     * keeps the dedupe key, every chunk id, and therefore every embedding hanging off this file valid
     * across a status change. A parse→serialize round trip drops a `<pre>` newline per write and
     * would move both.
     */
    expect(after["memhtml-content-hash"]).toBe(before["memhtml-content-hash"])
    const articleAfter = await cli.json<{ readonly html: string }>(["read", first.path])
    expect(articleAfter.html).toBe(articleBefore.html)
    /**
     * `memhtml-updated` is re-stamped, and the assertion is on its SHAPE rather than on a difference from
     * `memhtml-created`. The stamps are ISO seconds off one clock, so a write and a status change inside
     * the same second produce the same string — a `not.toBe` here fails whenever the test machine is
     * fast, which is a flake rather than a finding. The unchanged case is the one where the timestamp
     * matters, and `reports a repeat of the same status as unchanged` covers it.
     */
    expect(after["memhtml-updated"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it("reports a repeat of the same status as unchanged, committing nothing", async () => {
    const repeat = await cli.json<TaskUpdated>(["task", "status", first.path, "doing"])
    expect(repeat.unchanged).toBe(true)
    expect(repeat.commitSha).toBeNull()
    // A fresh `memhtml-updated` with no status change would claim the task moved when it did not, so the
    // stamp is skipped along with the write.
    const status = await cli.json<{ readonly dirty: boolean }>(["status"])
    expect(status.dirty).toBe(false)
  })

  it("refuses a status change on a memory that is not a task", async () => {
    const memory = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "procedural",
      "--title",
      "Drain the VIP before reverting",
      "--claim",
      "Drain the VIP before reverting the deploy."
    ])
    const result = await cli.run(["task", "status", memory.path, "doing"])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("not a task")

    // The refusal wrote nothing: a `memhtml-task-status` on a procedural memory is a parse violation, so
    // a file carrying one would index as nothing at all.
    const metas = await metasOf(cli, memory.path)
    expect(metas["memhtml-task-status"]).toBeUndefined()
  })

  it("refuses a due date that would not sort against the other instants", async () => {
    const result = await cli.run([
      "task",
      "add",
      "--title",
      "A task with an unsortable deadline",
      "--due",
      "next tuesday"
    ])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("ISO date")
  })

  it("lists open tasks with their status, due date, and blockers", async () => {
    const blocker = await cli.json<TaskWritten>([
      "task",
      "add",
      "--title",
      "Land the migration before the runbook edit",
      "--workspace",
      "checkout-api"
    ])
    await cli.json(["link", blocker.path, "blocks", first.path])

    const listed = await cli.json<TaskList>(["task", "list"])
    const target = listed.tasks.find((task) => task.path === first.path)
    expect(target?.taskStatus).toBe("doing")
    expect(target?.dueAt).toBe("2026-08-20")
    expect(target?.workspace).toBe("checkout-api")
    expect(target?.blockedBy).toEqual([blocker.path])
    // A task nothing blocks reports an empty list, never a null: a caller reading `null` cannot tell
    // "unblocked" from "not computed".
    expect(listed.tasks.find((task) => task.path === blocker.path)?.blockedBy).toEqual([])
  })

  it("filters by status, workspace, and calendar-day deadline", async () => {
    const doing = await cli.json<TaskList>(["task", "list", "--status", "doing"])
    expect(doing.tasks.map((task) => task.path)).toEqual([first.path])

    const scoped = await cli.json<TaskList>(["task", "list", "--workspace", "checkout-api"])
    expect(scoped.tasks.length).toBeGreaterThan(0)
    for (const task of scoped.tasks) expect(task.workspace).toBe("checkout-api")

    // Strictly before, by calendar day: the day OF the deadline is not late.
    const onTheDay = await cli.json<TaskList>(["task", "list", "--due-before", "2026-08-20"])
    expect(onTheDay.tasks.map((task) => task.path)).not.toContain(first.path)
    const after = await cli.json<TaskList>(["task", "list", "--due-before", "2026-08-21"])
    expect(after.tasks.map((task) => task.path)).toContain(first.path)

    /**
     * **The one case where truncating BOTH sides changes the answer**, established by enumeration
     * (2026-08-02): a due date stored as a BARE DAY, filtered by a bound that carries a time on that
     * same day. Whole-string, `"2026-08-25" < "2026-08-25T09:00:00Z"` is TRUE — the shorter string is a
     * prefix and sorts first — so the task due sometime on the 25th is reported as due before 09:00 on
     * the 25th, which it is not: a day-granularity deadline is not late until the day is over.
     *
     * Every other combination agrees between the two forms, which is why the fixture needs THIS one:
     * with only day-vs-day or time-vs-day cases the truncation is removable with the suite green.
     */
    const dayTask = await cli.json<TaskWritten>([
      "task",
      "add",
      "--title",
      "Rotate the signing key sometime on the twenty-fifth",
      "--due",
      "2026-08-25"
    ])
    const sameDayMorning = await cli.json<TaskList>([
      "task",
      "list",
      "--due-before",
      "2026-08-25T09:00:00Z"
    ])
    expect(sameDayMorning.tasks.map((task) => task.path)).not.toContain(dayTask.path)
    // The next day's morning DOES make it late: the calendar day it was due has ended.
    const nextMorning = await cli.json<TaskList>([
      "task",
      "list",
      "--due-before",
      "2026-08-26T09:00:00Z"
    ])
    expect(nextMorning.tasks.map((task) => task.path)).toContain(dayTask.path)
  })

  it("archives on `done`, as a rename `git log --follow` reads through", async () => {
    const done = await cli.json<TaskUpdated>([
      "task",
      "status",
      first.path,
      "done",
      "--reason",
      "the runbook now drains first"
    ])
    expect(done.taskStatus).toBe("done")
    expect(done.archived).toBe(true)
    expect(done.archivePath).toMatch(/^archive\/\d{4}\/projects\/checkout-api\/tasks\//)

    // The archived file carries BOTH stamps: the done status and the archive bookkeeping, in one
    // commit — which is what makes "what did I finish" the archive tree plus `git log`.
    const metas = await metasOf(cli, done.archivePath as string)
    expect(metas["memhtml-task-status"]).toBe("done")
    expect(metas["memhtml-status"]).toBe("archived")
    expect(metas["memhtml-archived"]).toBeDefined()

    // And the index followed the move rather than leaving the live row behind.
    const open = await cli.json<TaskList>(["task", "list"])
    expect(open.tasks.map((task) => task.path)).not.toContain(first.path)
    const all = await cli.json<TaskList>(["task", "list", "--include-archived"])
    expect(all.tasks.map((task) => task.path)).toContain(done.archivePath)
  })
})
