import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { originalPathFor } from "@memhtml/contracts/paths"
import { scriptedModel, value } from "@memhtml/sleep/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"

/**
 * The plan's verification item 2, end to end through the shipped binary's own `run`, plus item 3's
 * doctor fixture.
 *
 * Every package proves its own half — `@memhtml/contracts` the placement algebra, `@memhtml/index` the dedup
 * carve-out and the scope exclusion, `@memhtml/store` the endpoint guard, `@memhtml/sleep` the nine phase
 * skips. What only a test spanning all of them can prove is that the SURFACE composes them: that
 * `memhtml task add` reaches the placement rule AND the carve-out, that `task status … done` is a rename
 * the index follows, that a full sleep run over a task-seeded corpus leaves the tasks byte-identical,
 * and that `rm index.db && memhtml index rebuild` reproduces the two new columns.
 *
 * **Renames are asserted as renames, never as `R100`** (finding #23): an archive commit stamps its
 * head in the SAME commit and rename similarity is computed tree-to-tree, so a head stamp lowers the
 * score. `originalPathFor` is the authoritative inverse and no correctness path reads the score.
 */

const DATE = "2026-08-02"

/** A model that answers every LLM phase with "nothing to do", so no LLM phase commits. */
const inertModel = () =>
  scriptedModel((request) =>
    request.system.startsWith("You triage")
      ? value({ entries: [] })
      : value({ verdict: "neutral", confidence: 0.9, rationale: "compatible claims" })
  )

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

interface TaskRow {
  readonly path: string
  readonly title: string
  readonly taskStatus: string | null
  readonly dueAt: string | null
  readonly workspace: string | null
  readonly archived: boolean
  readonly blockedBy: ReadonlyArray<string>
}

interface TaskList {
  readonly tasks: ReadonlyArray<TaskRow>
  readonly nextCursor: string | null
}

/** Open a task through the CLI, naming only what a test cares about. */
const addTask = (
  cli: Cli,
  input: {
    readonly title: string
    readonly claim?: string | undefined
    readonly body?: ReadonlyArray<string> | undefined
    readonly workspace?: string | undefined
    readonly status?: string | undefined
    readonly due?: string | undefined
  }
): Promise<TaskWritten> =>
  cli.json<TaskWritten>([
    "task",
    "add",
    "--title",
    input.title,
    ...(input.claim === undefined ? [] : ["--claim", input.claim]),
    ...(input.body ?? []).flatMap((text) => ["--body", text]),
    ...(input.workspace === undefined ? [] : ["--workspace", input.workspace]),
    ...(input.status === undefined ? [] : ["--status", input.status]),
    ...(input.due === undefined ? [] : ["--due", input.due])
  ])

describe("verification item 2 — the task lifecycle across every plane", () => {
  let cli: Cli
  let runbookTask: TaskWritten
  let migrationTask: TaskWritten

  beforeAll(async () => {
    cli = await makeCli({ model: inertModel() })

    runbookTask = await addTask(cli, {
      title: "Wire the drain step into the rollback runbook",
      claim: "The rollback runbook must tell an operator to drain the VIP before reverting.",
      body: ["It currently says revert first, which is the failure the memory corpus describes."],
      workspace: "checkout-api",
      due: "2026-08-20"
    })

    migrationTask = await addTask(cli, {
      title: "Land the target-group migration before the runbook edit",
      claim: "The target-group migration lands before the runbook edit.",
      workspace: "checkout-api"
    })

    // A MEMORY sharing the tasks' whole vocabulary, so every retrieval assertion below is about the
    // type filter rather than about the query missing.
    await writeMemory(cli, {
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "Drain the VIP before reverting the deploy.",
      body: ["The revert alone leaves in-flight connections pinned to the old target group."],
      workspace: "checkout-api",
      tags: ["deploy"],
      entities: ["service:checkout-api"]
    })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("1. lands a workspace task in projects/<ws>/tasks/, status todo", async () => {
    expect(runbookTask.created).toBe(true)
    expect(runbookTask.path).toMatch(/^projects\/checkout-api\/tasks\/.*\.html$/)
    expect(runbookTask.taskStatus).toBe("todo")

    // The file itself, not only the report: the head is what survives a rebuild.
    const html = await readFile(join(cli.root, runbookTask.path), "utf8")
    expect(html).toContain('<meta name="memhtml-type" content="task">')
    expect(html).toContain('<meta name="memhtml-task-status" content="todo">')
    expect(html).toContain('<meta name="memhtml-due" content="2026-08-20">')
    // The two axes stay separate — `active` is what every archive and publish path switches on.
    expect(html).toContain('<meta name="memhtml-status" content="active">')

    // And it is COMMITTED, with the task-scoped subject.
    const subject = await cli.git("log", "-1", "--format=%s", "--", runbookTask.path)
    expect(subject.trim()).toContain("memhtml(write):")
  })

  it("2. does NOT dedupe an identical second task: two files, two rows", async () => {
    /**
     * The carve-out, at the surface. Two open tasks with identical bodies are two real work items —
     * "review the migration" said twice about two migrations — so the partial unique index excludes
     * `memory_type = 'task'` and `activePathForHash` carries the same predicate. A dedupe here would
     * hand the caller the first task's path as the home of the second's work.
     */
    const twin = await addTask(cli, {
      title: "Land the target-group migration before the runbook edit",
      claim: "The target-group migration lands before the runbook edit.",
      workspace: "checkout-api"
    })
    expect(twin.deduped).toBe(false)
    expect(twin.created).toBe(true)
    expect(twin.path).not.toBe(migrationTask.path)

    // Same content hash, two live files — which is exactly what the memory path refuses.
    const first = await readFile(join(cli.root, migrationTask.path), "utf8")
    const second = await readFile(join(cli.root, twin.path), "utf8")
    const hashOf = (html: string) => /memhtml-content-hash" content="([^"]+)"/.exec(html)?.[1]
    expect(hashOf(second)).toBe(hashOf(first))
    expect((await stat(join(cli.root, twin.path))).isFile()).toBe(true)

    // The contaminating state, in the other direction: a MEMORY whose article matches an open task's
    // must not be deduped onto that task — the caller would get a task's path as the home of its fact.
    const asMemory = await cli.json<{ readonly deduped: boolean; readonly path: string }>([
      "write",
      "--type",
      "procedural",
      "--title",
      "Land the target-group migration before the runbook edit",
      "--claim",
      "The target-group migration lands before the runbook edit."
    ])
    expect(asMemory.deduped).toBe(false)
    expect(asMemory.path).not.toBe(migrationTask.path)

    await cli.json(["task", "status", twin.path, "done", "--reason", "duplicate of the original"])
    await cli.json(["archive", asMemory.path, "--reason", "written only to probe the carve-out"])
  })

  it("3. moves the status as a one-line diff with the content hash unchanged", async () => {
    const before = await readFile(join(cli.root, runbookTask.path), "utf8")
    const updated = await cli.json<TaskUpdated>(["task", "status", runbookTask.path, "doing"])
    expect(updated.taskStatus).toBe("doing")
    expect(updated.archived).toBe(false)

    const after = await readFile(join(cli.root, runbookTask.path), "utf8")
    const hashOf = (html: string) => /memhtml-content-hash" content="([^"]+)"/.exec(html)?.[1]
    /**
     * The load-bearing property: `setMeta` splices by source offset, so the article's bytes cannot
     * move on a status change — which keeps the dedupe key, every chunk id, and every embedding
     * hanging off this file valid. A parse→serialize round trip drops a `<pre>` newline per write.
     */
    expect(hashOf(after)).toBe(hashOf(before))
    expect(after.slice(after.indexOf("<article>"))).toBe(before.slice(before.indexOf("<article>")))

    /**
     * The diff is head-only, asserted against git's own patch rather than against a LINE COUNT.
     *
     * A count is the wrong assertion and would flake: `memhtml-updated` is re-stamped to the same ISO
     * second when the write and the status change land inside one second, so the change is one line on
     * a fast machine and two otherwise. What is invariant is WHICH lines can move — `memhtml-*` metas and
     * nothing else — and that is also the stronger claim, since a rewrite of the whole head would
     * satisfy a count of two just as readily.
     */
    const patch = await cli.git("diff", "-U0", "HEAD~1..HEAD", "--", runbookTask.path)
    const changed = patch
      .split("\n")
      .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
      .map((line) => line.slice(1).trim())
    expect(changed.length).toBeGreaterThan(0)
    for (const line of changed) expect(line).toMatch(/^<meta name="memhtml-[a-z-]+" content=".*">$/)
    expect(changed.some((line) => line.includes('name="memhtml-task-status"'))).toBe(true)
  })

  it("3b. edits a HAND-AUTHORED task's status without rewriting the rest of the file", async () => {
    /**
     * **The mutation-verified form of "never parse→serialize".** Probed live 2026-08-02, then
     * confirmed by mutation: replacing `setMeta` with `serializeMemory` leaves `memhtml-content-hash`
     * UNCHANGED on every CLI-written task, because the hash is computed over whitespace-normalized
     * article text and the serializer's output normalizes to the same text. So a hash assertion over a
     * machine-written task cannot see the difference, and the assertion in `3.` above is real but
     * insufficient on its own.
     *
     * What the serializer DOES destroy is everything the format does not model: aligned `content`
     * columns, an HTML comment, a non-`memhtml-` meta, and the article's own indentation. A memory repo is
     * hand-editable by design — `git log` is the audit trail and a human reads the diffs — so a status
     * change that reflowed a hand-authored file would make every subsequent diff unreadable and would
     * silently drop the author's own annotations.
     *
     * The fixture is therefore a task committed by hand, and the assertion is BYTE equality outside
     * the one line that changed.
     */
    const path = "projects/checkout-api/tasks/hand-authored-drain-check.html"
    const authored = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Check the drain step by hand before the runbook lands</title>
<meta name="memhtml-type"        content="task">
<meta name="memhtml-status"      content="active">
<meta name="memhtml-created"     content="2026-08-01T00:00:00Z">
<meta name="memhtml-updated"     content="2026-08-01T00:00:00Z">
<meta name="memhtml-task-status" content="todo">
<!-- opened by hand from the sev2 retro; keep the alignment, it is read in diffs -->
<meta name="author" content="ada">
</head>
<body>
<article>
  <p><mark>Check the drain step by hand before the runbook lands.</mark></p>
  <dl>
    <dt>Blocked on</dt><dd>the target-group migration</dd>
  </dl>
</article>
</body>
</html>
`
    await writeFile(join(cli.root, path), authored, "utf8")
    await cli.git("add", path)
    await cli.git("commit", "-m", "memhtml(write): check the drain step by hand")
    await cli.json(["index", "update"])

    await cli.json<TaskUpdated>(["task", "status", path, "doing"])
    const edited = await readFile(join(cli.root, path), "utf8")

    // Exactly two lines differ: the status and the `memhtml-updated` stamp. Everything else — the aligned
    // columns, the comment, the non-`memhtml-` meta, the article's indentation — is byte-identical.
    expect(edited).toContain('<meta name="memhtml-task-status" content="doing">')
    expect(edited).toContain(
      "<!-- opened by hand from the sev2 retro; keep the alignment, it is read in diffs -->"
    )
    expect(edited).toContain('<meta name="author" content="ada">')
    expect(edited).toContain('<meta name="memhtml-type"        content="task">')
    expect(edited).toContain(
      "  <p><mark>Check the drain step by hand before the runbook lands.</mark></p>"
    )

    /**
     * Exactly two lines move, and here a COUNT is a sound assertion where it was not in `3.`: the
     * fixture's `memhtml-updated` is stamped `2026-08-01`, so it can never already equal today and the
     * re-stamp is unconditional. Both changed lines are `memhtml-*` metas in the canonical unaligned form
     * `setMeta` writes — the surrounding alignment is what the serializer would have reflowed.
     */
    const numstat = await cli.git("diff", "--numstat", "HEAD~1..HEAD", "--", path)
    expect(numstat.trim().split("\t").slice(0, 2)).toEqual(["2", "2"])
  })

  it("4. links a task-class `blocks` edge, refusing the memory-class mixes", async () => {
    const linked = await cli.json<{ readonly rel: string; readonly commitSha: string | null }>([
      "link",
      migrationTask.path,
      "blocks",
      runbookTask.path
    ])
    expect(linked.rel).toBe("blocks")
    expect(linked.commitSha).not.toBeNull()

    // A memory-class rel with a task endpoint is refused: a `blocks`-shaped to-do reaching PageRank
    // would let a task list reweight the retention of knowledge.
    const memory = (
      await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
        "list",
        "--type",
        "procedural"
      ])
    ).files[0]?.path as string
    const refusedMemoryRel = await cli.envelope(["link", memory, "relates_to", runbookTask.path])
    expect(refusedMemoryRel.code).toBe("ERR_INVALID_MEMORY")

    // And a task rel with a memory endpoint: nothing advances a memory that a task "blocks".
    const refusedTaskRel = await cli.envelope(["link", migrationTask.path, "blocks", memory])
    expect(refusedTaskRel.code).toBe("ERR_INVALID_MEMORY")
  })

  it("5. `task list` and a plain directory read both see the task", async () => {
    const listed = await cli.json<TaskList>(["task", "list", "--status", "doing"])
    const row = listed.tasks.find((task) => task.path === runbookTask.path)
    expect(row?.taskStatus).toBe("doing")
    expect(row?.dueAt).toBe("2026-08-20")
    expect(row?.workspace).toBe("checkout-api")
    // The blockers column: one edges join, `edge_class='task' AND rel='blocks'`, dst = this path.
    expect(row?.blockedBy).toEqual([migrationTask.path])

    /**
     * The CRUDL-without-retrieval contract, asserted literally. A task is a file in a directory, so
     * `ls` is a complete listing of the working set and no index is required to read it — which is the
     * property that makes an agent able to work tasks with `Read` and `Edit` alone.
     */
    const entries = await readdir(join(cli.root, "projects/checkout-api/tasks"))
    expect(entries).toContain(runbookTask.path.split("/").at(-1))
  })

  it("6. `done` archives as a rename, and `--follow` reads through it", async () => {
    const done = await cli.json<TaskUpdated>([
      "task",
      "status",
      runbookTask.path,
      "done",
      "--reason",
      "the runbook now drains first"
    ])
    expect(done.archived).toBe(true)
    const archivePath = done.archivePath as string
    expect(archivePath).toMatch(/^archive\/\d{4}\/projects\/checkout-api\/tasks\//)

    // Both stamps in ONE commit: the done status and the archive bookkeeping.
    const html = await readFile(join(cli.root, archivePath), "utf8")
    expect(html).toContain('<meta name="memhtml-task-status" content="done">')
    expect(html).toContain('<meta name="memhtml-status" content="archived">')

    /**
     * A RENAME with git's own default similarity floor — never `R100`, which is arithmetically
     * impossible for an archive that also stamps its head in the same commit. `originalPathFor` is
     * what actually inverts the move.
     */
    const raw = await cli.git("diff", "--name-status", "-M", "HEAD~1..HEAD")
    const rename = raw
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([status, , to]) => status?.startsWith("R") === true && to === archivePath)
    expect(rename).toBeDefined()
    const score = rename?.[0] ?? ""
    expect(Number(score.slice(1))).toBeGreaterThanOrEqual(50)
    expect(originalPathFor(archivePath)).toBe(runbookTask.path)

    const follow = await cli.git("log", "--follow", "--format=%H", "--", archivePath)
    expect(
      follow
        .trim()
        .split("\n")
        .filter((line) => line !== "").length
    ).toBeGreaterThan(1)

    // The index FOLLOWED the move rather than leaving the live row behind — the reason the write path
    // calls `indexer.update()` and never `indexPaths`.
    const open = await cli.json<TaskList>(["task", "list"])
    expect(open.tasks.map((task) => task.path)).not.toContain(runbookTask.path)
    const all = await cli.json<TaskList>(["task", "list", "--include-archived"])
    expect(all.tasks.map((task) => task.path)).toContain(archivePath)
  })

  it("6b. archiving the BLOCKED side dangles the blocker's href, which doctor repairs", async () => {
    /**
     * The state transition the surface actually produces, probed live 2026-08-02, and it is not the
     * one an author would guess.
     *
     * `movePath` updates `files.path` and `edges.src_path` and deliberately NOT `edges.dst_path`: an
     * edge row is derived from the SOURCE file's `<link>` elements, so the row must keep saying what
     * the file says. Archiving the BLOCKED task therefore leaves the blocker's href pointing at the
     * pre-archive path — a dangling href, which is `memhtml doctor`'s finding and the sleep integrity
     * phase's repair, exactly as it is for a memory-class edge. Nothing about the task class is
     * special here, and that is the point: one repair path serves all four classes.
     */
    const archived = (await cli.json<TaskList>(["task", "list", "--include-archived"])).tasks.find(
      (task) => task.path.startsWith("archive/") && task.dueAt === "2026-08-20"
    )
    expect(archived).toBeDefined()

    const found = await cli.json<{
      readonly dangling: ReadonlyArray<{
        readonly srcPath: string
        readonly rel: string
        readonly dstPath: string
        readonly rewriteTo: string | null
      }>
    }>(["doctor"])
    const finding = found.dangling.find((entry) => entry.srcPath === migrationTask.path)
    expect(finding?.rel).toBe("blocks")
    expect(finding?.dstPath).toBe(runbookTask.path)
    // The repair is derivable rather than searched for: `archivePathFor` is injective and
    // `originalPathFor` inverts it, so no rename-similarity score is consulted.
    expect(finding?.rewriteTo).toBe(archived?.path)

    await cli.json(["doctor", "--fix"])
    await cli.json(["index", "update"])

    // The href now names the archive path, so the edge says something true again — and `blockedBy`
    // reports it, which is what makes a finished blocker visible on the task it blocked.
    const html = await readFile(join(cli.root, migrationTask.path), "utf8")
    expect(html).toContain(`href="/${archived?.path as string}"`)
    const repaired = await cli.json<TaskList>(["task", "list", "--include-archived"])
    expect(repaired.tasks.find((task) => task.path === archived?.path)?.blockedBy).toEqual([
      migrationTask.path
    ])
    expect(
      (await cli.json<{ readonly dangling: ReadonlyArray<unknown> }>(["doctor"])).dangling
    ).toEqual([])
  })

  it("7. a full sleep run leaves every task byte-identical and mines no edge onto one", async () => {
    /**
     * The nine sleep skips, composed at the surface. Asserted on git BLOBS rather than on the report:
     * a phase that reported zero while writing a `memhtml-confidence` stamp would pass a count assertion,
     * and the whole claim of the skips is that live work is untouched.
     *
     * The comparison names each task FILE explicitly rather than globbing `/tasks/`, because the
     * integrity phase legitimately generates a `tasks/index.html` listing per directory — a generated
     * artifact is not a task, and a glob would report the design working as the invariant failing.
     */
    const taskFiles = (
      await cli.json<TaskList>(["task", "list", "--include-archived", "--limit", "500"])
    ).tasks.map((task) => task.path)
    // Not vacuous: there are tasks in the tree for the run to have left alone.
    expect(taskFiles.length).toBeGreaterThan(1)

    const blobsAt = async (commitish: string): Promise<ReadonlyArray<string>> => {
      const out: Array<string> = []
      for (const path of taskFiles) {
        out.push(`${path} ${(await cli.git("rev-parse", `${commitish}:${path}`)).trim()}`)
      }
      return out
    }
    const before = await blobsAt("HEAD")

    const report = await cli.json<{
      readonly phases: ReadonlyArray<{ readonly phase: string; readonly status: string }>
      readonly failedPhases: ReadonlyArray<string>
    }>(["sleep", "run", "--date", DATE])
    expect(report.phases).toHaveLength(15)
    expect(report.failedPhases).toEqual([])

    // Every task file's blob is unchanged: no stamp, no link, no confidence rewrite, no move.
    expect(await blobsAt(`sleep/${DATE}`)).toEqual(before)

    /**
     * And no derived memory-class rel reached a task's head. `memhtml-part-of` is arc-synthesis' stamp,
     * `memhtml-laterally-related` is relationship-mining's, `memhtml-about-person` is person-links' — each is a
     * memory- or person-class edge into a graph a task must never enter.
     */
    for (const path of taskFiles) {
      const html = await cli.git("show", `sleep/${DATE}:${path}`)
      expect(html).not.toContain("memhtml-part-of")
      expect(html).not.toContain("memhtml-laterally-related")
      expect(html).not.toContain("memhtml-about-person")
    }
    /**
     * person-links would mint a `resources/people/<name>.html` — the durable hand-edited identity
     * surface — out of a to-do item. The assertion is on a person FILE and not on the directory:
     * `memhtml init` scaffolds `resources/people/.gitkeep`, so a directory check would pass against a
     * repo that had never run init and fail against every repo that had.
     */
    const branchTree = (await cli.git("ls-tree", "-r", "--name-only", `sleep/${DATE}`)).split("\n")
    expect(
      branchTree.filter((path) => path.startsWith("resources/people/") && path.endsWith(".html"))
    ).toEqual([])
  })

  it("8. `memory_search` excludes tasks by default and includes them when named", async () => {
    const query = "target-group migration before the runbook edit"
    const excluded = await cli.json<{
      readonly hits: ReadonlyArray<{ readonly path: string; readonly memoryType: string }>
    }>(["search", query])
    // The default is the whole corpus MINUS tasks, and the query is one a task would win: the memory
    // sharing its vocabulary is what proves the filter rather than an empty result.
    expect(excluded.hits.length).toBeGreaterThan(0)
    expect(excluded.hits.every((hit) => hit.memoryType !== "task")).toBe(true)

    const included = await cli.json<{
      readonly hits: ReadonlyArray<{ readonly path: string; readonly memoryType: string }>
    }>(["search", query, "--type", "task"])
    expect(included.hits.length).toBeGreaterThan(0)
    expect(included.hits.every((hit) => hit.memoryType === "task")).toBe(true)
  })

  it("9. `rm index.db && memhtml index rebuild` reproduces task_status and due_at", async () => {
    /**
     * The rebuildability contract extended to the two new columns. They are projected from the parsed
     * head, so a rebuild reading the tree alone must reach the same values — which is what makes the
     * columns a projection rather than state, and `index.db` disposable.
     */
    await cli.json(["sleep", "merge", `sleep/${DATE}`])
    /**
     * `index update` after the merge, deliberately. `memhtml sleep merge` fast-forwards `main` and does
     * NOT reindex — probed live 2026-08-02: `memhtml status` reports `indexFresh: false` immediately
     * after a successful merge, which is why `RUNBOOK.md` §3 has `memhtml index update` as the next step
     * and why `sleep.test.ts` rebuilds before its own post-merge assertions. Comparing a stale index
     * against a fresh rebuild would make this test fail for the watermark rather than for the columns.
     */
    await cli.json(["index", "update"])
    const before = await cli.json<TaskList>([
      "task",
      "list",
      "--include-archived",
      "--limit",
      "500"
    ])
    expect(before.tasks.length).toBeGreaterThan(1)

    for (const file of ["index.db", "index.db-wal", "index.db-shm"]) {
      await rm(join(cli.root, ".memhtml", file), { force: true })
    }
    await cli.json(["index", "rebuild", "--embed"])

    const after = await cli.json<TaskList>(["task", "list", "--include-archived", "--limit", "500"])
    // Compared as a row SET, not as counts: a rebuild that dropped one status and duplicated another
    // passes a count comparison, which is the class of bug this exists to catch.
    const canonical = (list: TaskList) =>
      list.tasks
        .map(
          (task) =>
            `${task.path}|${task.taskStatus}|${task.dueAt}|${task.workspace}|${task.archived}|${task.blockedBy.join(",")}`
        )
        .sort()
    expect(canonical(after)).toEqual(canonical(before))
    // And not vacuous on the columns under test: at least one of each is non-null.
    expect(after.tasks.some((task) => task.taskStatus === "done")).toBe(true)
    expect(after.tasks.some((task) => task.dueAt !== null)).toBe(true)
  })
})

describe("verification item 3 — doctor reports the task findings", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("reports an overdue task, a stale blocker, and the task-inbox depth", async () => {
    /**
     * One fixture carrying all three findings, because they are found by three different queries over
     * the same rows and a per-finding fixture would not prove they compose.
     *
     * The dates are in the PAST relative to any run of this suite: `--due 2026-01-05` is overdue on
     * every day after it, and the alternative — pinning the clock — would test a fixture rather than
     * the query the operator runs.
     */
    const overdue = await addTask(cli, {
      title: "Ship the deprecation notice for the v1 endpoint",
      due: "2026-01-05"
    })

    /**
     * **The contaminating state, and it is what makes the overdue lock non-vacuous.** A FINISHED task
     * whose deadline also passed: it is archived, and its `memhtml-task-status` is `done`. Without it the
     * filters `archived = 0` and `task_status <> 'done'` are both removable with the suite still green
     * (measured by mutation, 2026-08-02) — a fixture of only-open tasks cannot distinguish "reports
     * every overdue task" from "reports every overdue OPEN task", and reporting a finished one would
     * make the finding grow forever and never reach zero.
     */
    const finishedButLate = await addTask(cli, {
      title: "Rotate the v1 signing key",
      due: "2026-01-06"
    })
    await cli.json([
      "task",
      "status",
      finishedButLate.path,
      "done",
      "--reason",
      "rotated late, but rotated"
    ])

    const blocked = await addTask(cli, {
      title: "Delete the v1 endpoint",
      status: "blocked"
    })
    const blocker = await addTask(cli, { title: "Migrate the last v1 caller" })
    await cli.json(["link", blocker.path, "blocks", blocked.path])

    /**
     * A NON-task memory filed in the task inbox directory, hand-authored — the contaminating
     * neighbor, and without it `inboxTaskDepth`'s `memory_type = 'task'` filter is removable with the
     * suite still green (measured by mutation, 2026-08-02). A directory is not a type: the count
     * claims to be work awaiting a project, and a memory that happens to sit there is neither.
     */
    const strayPath = `${"areas/inbox/tasks"}/a-note-filed-in-the-wrong-place.html`
    await writeFile(
      join(cli.root, strayPath),
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A note someone filed in the task directory</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-01T00:00:00Z">
<meta name="memhtml-updated" content="2026-08-01T00:00:00Z">
</head>
<body>
<article>
<p><mark>The v1 endpoint was introduced in the 2024 checkout rewrite.</mark></p>
</article>
</body>
</html>
`,
      "utf8"
    )
    await cli.git("add", strayPath)
    await cli.git("commit", "-m", "memhtml(write): a note filed in the task directory")
    await cli.json(["index", "update"])

    // The blocker finishes, which archives it — and the `blocks` edge now points at a file that will
    // never move again. Nothing in a single file reveals this; only the pair does.
    await cli.json(["task", "status", blocker.path, "done", "--reason", "the caller moved"])

    const report = await cli.json<{
      readonly overdueTasks: ReadonlyArray<{
        readonly path: string
        readonly taskStatus: string | null
        readonly dueAt: string
      }>
      readonly staleBlockers: ReadonlyArray<{
        readonly path: string
        readonly blockerPath: string
        readonly blockerState: string
      }>
      readonly inboxTaskDepth: number
      readonly inboxTasksCrowded: boolean
      readonly healthy: boolean
    }>(["doctor"])

    expect(report.overdueTasks.map((task) => task.path)).toContain(overdue.path)
    expect(report.overdueTasks.find((task) => task.path === overdue.path)?.dueAt).toBe("2026-01-05")
    // The finished-but-late task is NOT reported, under either of its two names: it archived out of
    // `archived = 0` and it stamped out of `task_status <> 'done'`.
    expect(report.overdueTasks.map((task) => task.path)).not.toContain(finishedButLate.path)
    for (const task of report.overdueTasks) {
      expect(task.path.startsWith("archive/")).toBe(false)
      expect(task.taskStatus).not.toBe("done")
    }

    const stale = report.staleBlockers.find((finding) => finding.path === blocked.path)
    expect(stale?.blockerState).toBe("archived")
    // The blocker is reported at its ARCHIVE path, which is where the edge points after the move.
    expect(stale?.blockerPath).toMatch(/^archive\/\d{4}\/areas\/inbox\/tasks\//)

    /**
     * Four tasks were opened with no workspace, so all four landed in the task inbox; the two that
     * finished archived out of it. The stray SEMANTIC memory sitting in the same directory is not
     * counted — the count is of work awaiting a project, and a directory is not a type.
     */
    expect(report.inboxTaskDepth).toBe(2)
    expect(report.inboxTasksCrowded).toBe(false)

    /**
     * `healthy` stays TRUE. An overdue task and a stale blocker are facts about the WORK, not defects
     * in the corpus — folding them in would make `healthy: false` the normal state and stop anyone
     * reading the flag. This assertion is the one that would fail if someone "helpfully" added them.
     */
    expect(report.healthy).toBe(true)
  })

  it("reports a blocker whose FILE left the tree, via the mechanism that clears its edge", async () => {
    /**
     * **The `missing` arm is defense in depth, not the mechanism, and this test says so rather than
     * faking a state the system cannot reach.** Probed live 2026-08-02, then confirmed by mutation:
     *
     * - Deleting a blocker's file and running `index update` clears `edges WHERE src_path = ?` in the
     *   same batch (`indexer.ts`'s `deletePath`), so the edge goes with the file and there is nothing
     *   for the `missing` arm to find.
     * - Removing that `DELETE FROM edges` line and re-running THIS scenario turns the arm on:
     *   `blockerState: "missing"` appears. So the SQL is correct and the state is unreachable while
     *   an edge row is derived from its source file — which is the design, since a `<link>` is the
     *   only thing that can assert one.
     *
     * What IS assertable is the mechanism: the edge is gone, the blocked task reports no blocker, and
     * doctor names the un-indexed file so an operator learns the index needs updating. The `missing`
     * arm stays as the second line, because `edges` deliberately carries no foreign key and a future
     * writer of edge rows would not inherit `deletePath`'s discipline.
     */
    const blocked = await addTask(cli, {
      title: "Delete the second v1 endpoint",
      status: "blocked"
    })
    const ghost = await addTask(cli, { title: "A blocker whose file will be removed" })
    await cli.json(["link", ghost.path, "blocks", blocked.path])

    // Not vacuous: the edge exists and is reported before the deletion.
    const linked = await cli.json<TaskList>(["task", "list", "--status", "blocked"])
    expect(linked.tasks.find((task) => task.path === blocked.path)?.blockedBy).toEqual([ghost.path])

    await rm(join(cli.root, ghost.path))
    await cli.git("add", "-A")
    await cli.git("commit", "-m", "chore: drop the blocker file by hand")

    // Before the reindex the index still describes the old tree, and doctor says which file it cannot
    // read — the finding that tells an operator to run `memhtml index update`.
    const stale = await cli.json<{ readonly unparseable: ReadonlyArray<string> }>(["doctor"])
    expect(stale.unparseable).toContain(ghost.path)

    await cli.json(["index", "update"])
    const report = await cli.json<{
      readonly staleBlockers: ReadonlyArray<{ readonly path: string }>
      readonly dangling: ReadonlyArray<{ readonly dstPath: string }>
    }>(["doctor"])
    // The edge went with the file, so there is no stale blocker and no dangling href either.
    expect(report.staleBlockers.map((entry) => entry.path)).not.toContain(blocked.path)
    expect(report.dangling.map((entry) => entry.dstPath)).not.toContain(blocked.path)
    const after = await cli.json<TaskList>(["task", "list", "--status", "blocked"])
    expect(after.tasks.find((task) => task.path === blocked.path)?.blockedBy).toEqual([])
  })

  it("calls a crowded task inbox out at eleven unplaced tasks", async () => {
    /**
     * The threshold is 10, lower than the memory inbox's 20, because the two crowds mean different
     * things: an unplaced memory is a placement rule that stopped matching, an unplaced task is work
     * with no project. Asserted at the boundary rather than well past it — a test that opened fifty
     * tasks would pass against a threshold of 49.
     */
    const before = await cli.json<{ readonly inboxTaskDepth: number }>(["doctor"])
    for (let ordinal = before.inboxTaskDepth; ordinal <= 10; ordinal += 1) {
      await addTask(cli, { title: `An unplaced task number ${ordinal}` })
    }
    const report = await cli.json<{
      readonly inboxTaskDepth: number
      readonly inboxTasksCrowded: boolean
      readonly healthy: boolean
    }>(["doctor"])
    expect(report.inboxTaskDepth).toBe(11)
    expect(report.inboxTasksCrowded).toBe(true)
    // This one DOES fail `healthy`: an unplaced task is a routing signal, the same claim the memory
    // inbox's depth makes.
    expect(report.healthy).toBe(false)
  })
})
