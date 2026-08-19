import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { renderTemplate } from "@memhtml/html"
import { detectedTaskPath, detectionKey } from "@memhtml/sleep"
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

/**
 * `task list --detected`: issue #44's author separation, as the flag that makes it usable.
 *
 * A detected task is a PROPOSAL with evidence and a human-opened task is a decision already made, so
 * they are two different reading sessions. The filter is what lets a human review the machine's queue
 * without sorting the two by hand.
 *
 * The detected tasks here are written through `@memhtml/sleep`'s OWN `renderTemplate` inputs and its own
 * `detectedTaskPath`, not through hand-written HTML at a hand-written path. That is the load-bearing
 * choice in this suite: the filter matches on the PATH SHAPE, so a fixture that spelled the path itself
 * would pass against a filter and a minter that had drifted apart. Borrowing the minter's own path
 * function means a change to the digest width, the prefix, or the placement rule moves both sides.
 */
const runProcess = promisify(execFile)

/**
 * Stage and commit whatever a fixture just wrote, as one commit.
 *
 * The sleep cycle writes a detected task and COMMITS it on the sleep branch, so a committed file is the
 * production state rather than a test convenience — and it is load-bearing for the archive arm, because
 * `task status done` routes through `store.archiveMemory`, whose `git mv` refuses an untracked path.
 */
const commitAll = async (cli: Cli, subject: string): Promise<void> => {
  await runProcess("git", ["add", "-A"], { cwd: cli.root })
  await runProcess("git", ["commit", "-m", subject], { cwd: cli.root })
}

describe("task list --detected", () => {
  let cli: Cli
  /** The detected task's path, as `@memhtml/sleep` itself would name it. */
  let detectedPath: string
  let humanPath: string

  beforeAll(async () => {
    cli = await makeCli()

    const human = await cli.json<TaskWritten>([
      "task",
      "add",
      "--title",
      "Rotate the staging credentials before the audit"
    ])
    humanPath = human.path

    /**
     * A detected task, at the path `mintDetectedTask` would give it, with the head it would write.
     *
     * Written to disk and picked up by `index update` rather than committed by a command, because
     * nothing in the CLI mints one — the sleep cycle does, on its own branch, and `index update` reads
     * the dirty working tree as well as HEAD. What this fixture has to be faithful about is the PATH and
     * the `memhtml-author`, since those are the two things the filter and the author separation rest on.
     */
    const key = detectionKey("trace-commitment", "wire the capture path before the next release")
    detectedPath = detectedTaskPath(
      key,
      "Commitment: wire the capture path before the next release"
    )
    const absolute = join(cli.root, detectedPath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(
      absolute,
      renderTemplate({
        title: "Commitment: wire the capture path before the next release",
        claim: "confirm: the agent committed to wire the capture path before the next release",
        body: ["Detected from a consolidated session; a proposal for a human to decide."],
        memoryType: "task",
        taskStatus: "todo",
        at: "2026-08-08T00:00:00Z",
        author: "agent:sleep",
        sessionId: "session-a",
        tags: ["detected", "trace-commitment"]
      }),
      "utf8"
    )
    await commitAll(cli, "sleep(trace-consolidation): detect 1 commitments, close 0 completed")
    await cli.json(["index", "update", "--no-embed"])
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  /**
   * The fixture is only meaningful if the unfiltered list sees BOTH. A repo where the detected file
   * never indexed would make every "the filter returns one row" assertion below vacuously true.
   */
  it("has both tasks in the unfiltered list, so the filter has something to exclude", async () => {
    const all = await cli.json<TaskList>(["task", "list"])
    const paths = all.tasks.map((task) => task.path)
    expect(paths).toContain(humanPath)
    expect(paths).toContain(detectedPath)
  })

  /**
   * (Mutation: dropping the `f.path GLOB ?` condition returns both tasks and fails the `toEqual` here;
   * spelling the pattern as `LIKE 'areas/inbox/tasks/det-%'` passes this case and fails the
   * near-miss case below, which is why both exist.)
   */
  it("returns only the detected task, not the human-opened one", async () => {
    const detected = await cli.json<TaskList>(["task", "list", "--detected"])
    expect(detected.tasks.map((task) => task.path)).toEqual([detectedPath])
    // The payload SHAPE is unchanged: a filter, not a new response type, so no consumer's parse moves.
    const row = detected.tasks[0]
    expect(row?.taskStatus).toBe("todo")
    expect(row?.blockedBy).toEqual([])
    expect(detected.nextCursor).toBeNull()
  })

  /**
   * The character class, which is the whole reason this is a `GLOB` and not a `LIKE`.
   *
   * Three near misses, each a real filename a corpus could hold: a stem whose digest is not hex, one
   * whose digest is too short, and a task whose title simply begins with the letters `det`. A
   * prefix-only `LIKE` matches all three, and each would put a hand-opened task into the machine's queue
   * — which is the one thing this flag exists to prevent.
   */
  it("rejects near misses a prefix-only LIKE would admit", async () => {
    for (const [stem, title] of [
      ["det-zzzzzzzzzzzz-not-hex", "A stem whose digest is not hexadecimal"],
      ["det-0123456789-too-short", "A stem whose digest is too short"],
      ["detonate-the-staging-database", "A task whose title merely starts with det"]
    ] as const) {
      const path = `areas/inbox/tasks/${stem}.html`
      const absolute = join(cli.root, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(
        absolute,
        renderTemplate({
          title,
          claim: title,
          memoryType: "task",
          taskStatus: "todo",
          at: "2026-08-08T00:00:00Z",
          author: "agent:sleep"
        }),
        "utf8"
      )
    }
    await commitAll(cli, "test: three near-miss task filenames")
    await cli.json(["index", "update", "--no-embed"])

    // The near misses ARE in the corpus — asserted, or this case proves nothing about the pattern.
    const all = await cli.json<TaskList>(["task", "list"])
    expect(all.tasks.length).toBeGreaterThanOrEqual(5)
    const detected = await cli.json<TaskList>(["task", "list", "--detected"])
    expect(detected.tasks.map((task) => task.path)).toEqual([detectedPath])
  })

  /**
   * The flag COMPOSES with the others rather than replacing them, which is what makes it a filter. And
   * `--include-archived` has to reach a CLOSED detected task, or "what did the machine propose and what
   * happened to it" is unanswerable — a closure archives under `archive/<year>/`, so the pattern is
   * anchored on the filename rather than the directory for exactly this case.
   */
  it("composes with --status and reaches an archived detected task with --include-archived", async () => {
    const todo = await cli.json<TaskList>(["task", "list", "--detected", "--status", "todo"])
    expect(todo.tasks.map((task) => task.path)).toEqual([detectedPath])
    const doing = await cli.json<TaskList>(["task", "list", "--detected", "--status", "doing"])
    expect(doing.tasks).toEqual([])

    // `done` archives, exactly as `closeDetectedTask` does through sleep's own staging discipline.
    const closed = await cli.json<TaskUpdated>([
      "task",
      "status",
      detectedPath,
      "done",
      "--reason",
      "completion detected"
    ])
    expect(closed.archived).toBe(true)
    expect(closed.archivePath).toMatch(/^archive\/\d{4}\/areas\/inbox\/tasks\/det-/)

    // Absent by default, because `done` archives; present with the flag, at its archived path.
    expect((await cli.json<TaskList>(["task", "list", "--detected"])).tasks).toEqual([])
    const archived = await cli.json<TaskList>(["task", "list", "--detected", "--include-archived"])
    expect(archived.tasks.map((task) => task.path)).toEqual([closed.archivePath])
    expect(archived.tasks[0]?.archived).toBe(true)
  })
})
