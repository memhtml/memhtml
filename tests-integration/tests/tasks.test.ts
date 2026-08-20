import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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
      : request.system.startsWith("You partition")
        ? // dedup-merge's partition call. A refusal keeps the phase on its deterministic arm.
          value({ groups: [] })
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

describe("staleQuotes — a detected task's evidence, checked against the corpus", () => {
  /**
   * Its own fixture repo. `staleQuotes` is asserted as a per-task SET membership, and the
   * doctor-findings suite above deliberately accumulates overdue tasks, a stale blocker, and eleven
   * inbox tasks — a corpus where `healthy` is already false and where the archive holds two unrelated
   * files the year chase would walk. The positive and negative halves of this check need a corpus
   * where the ONLY reason a task appears is its own quote.
   */
  let cli: Cli

  /** `<detector>:<digest16>`, the shape `FINDING_KEY_PATTERN` accepts. One per fixture task. */
  const keyFor = (ordinal: number): string => `dedup:${ordinal.toString(16).padStart(16, "0")}`

  /**
   * Seed a task whose evidence quotes `cite` — as RAW BYTES, then indexed.
   *
   * Raw bytes rather than `task add`, for the reason `apps/cli/tests/tasks.test.ts:410-419` records:
   * `memhtml-finding-key` has no CLI flag by design, because only a detector mints one and offering
   * the flag would let an agent forge a machine identity. Writing the head a detector writes and
   * letting the real projection read it is what makes this a test of the check rather than of a
   * fixture.
   *
   * **The evidence element is `<q cite>` and that is the whole point of the markup here.**
   * `<blockquote>` is outside the closed vocabulary, so a task minted with one would carry an
   * `unknown:blockquote` warning forever AND its text would never reach `article.citations` — the
   * extraction this check reads. `packages/sleep/src/mint.ts` pins the same element on the minting
   * side, and this fixture is the consumer half of that contract.
   */
  const seedDetectedTask = async (input: {
    readonly slug: string
    readonly key: string
    readonly claim: string
    readonly quote: string
    readonly cite: string
    /** Omitted for the detected case; `false` writes a task with no finding key at all. */
    readonly detected?: boolean | undefined
  }): Promise<string> => {
    const path = `areas/inbox/tasks/${input.slug}.html`
    // `memhtml init` scaffolds `areas/` and nothing below it, and nothing in this suite calls
    // `task add`, which is what would otherwise create the task inbox on its way past.
    await mkdir(join(cli.root, "areas", "inbox", "tasks"), { recursive: true })
    await writeFile(
      join(cli.root, path),
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${input.slug}</title>
<meta name="memhtml-type" content="task">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-01T00:00:00Z">
<meta name="memhtml-updated" content="2026-08-01T00:00:00Z">
<meta name="memhtml-task-status" content="todo">
${input.detected === false ? "" : `<meta name="memhtml-finding-key" content="${input.key}">\n`}</head>
<body>
<article>
<p><mark>${input.claim}</mark></p>
<p><q cite="${input.cite}">${input.quote}</q></p>
</article>
</body>
</html>
`,
      "utf8"
    )
    await cli.git("add", path)
    await cli.git("commit", "-m", `memhtml(task): seed ${input.slug}`)
    return path
  }

  /**
   * Edit the `<mark>` claim of a memory so a quote of it stops being true, and PROVE the edit landed.
   *
   * The self-check is not ceremony: a plain `html.replace(text, …)` silently rewrote the `<title>`
   * instead of the claim, because a memory's title and its claim share their wording by construction
   * and `String.replace` takes the FIRST match. The quote stayed intact in the article, so the two
   * "the quote is gone" cases below were asserting nothing — found by mutating
   * `finding_key IS NOT NULL` out of doctor's query and watching the suite stay green. The edit is
   * scoped to the `<mark>` span and then read back, so a fixture that stops breaking the quote fails
   * here rather than passing quietly downstream.
   */
  const breakTheClaim = async (path: string, from: string, to: string): Promise<void> => {
    const before = await readFile(join(cli.root, path), "utf8")
    const after = before.replace(
      /<mark>([^<]*)<\/mark>/,
      (_whole, claim: string) => `<mark>${claim.replace(from, to)}</mark>`
    )
    expect(after).not.toBe(before)
    await writeFile(join(cli.root, path), after, "utf8")
    await cli.git("add", path)
    await cli.git("commit", "-m", `memhtml(correct): ${to}`)
  }

  interface QuoteReport {
    readonly staleQuotes: ReadonlyArray<{
      readonly path: string
      readonly citedPath: string
      readonly state: string
    }>
    readonly healthy: boolean
    readonly unparseable: ReadonlyArray<string>
  }

  const doctorReport = async (): Promise<QuoteReport> => {
    await cli.json(["index", "update", "--no-embed"])
    return cli.json<QuoteReport>(["doctor"])
  }

  beforeAll(async () => {
    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("clears a quote that is still in its cited file, and fires on one that is not", async () => {
    /**
     * Both halves in one case, over TWO source memories, because the check is a containment test and a
     * containment test that only ever fails proves nothing about what it accepts. The intact half is
     * the guard on the extraction itself: a selector that matched nothing would produce an empty
     * `staleQuotes` and read as "no findings", which is the standing hazard
     * `.erpaval/solutions/test-failures/a-wrong-count-reads-as-a-finding.md` names.
     */
    const intact = await writeMemory(cli, {
      title: "Prod rollbacks drain the VIP first",
      claim: "Drain the VIP before reverting the deploy.",
      body: ["The revert alone leaves in-flight connections pinned to the old target group."]
    })
    const edited = await writeMemory(cli, {
      title: "The staging bastion listens on a nonstandard port",
      claim: "The staging bastion listens on port 2222.",
      body: ["Every runbook that says 22 is describing the old host."]
    })

    const good = await seedDetectedTask({
      slug: "review-the-vip-drain-claim",
      key: keyFor(1),
      claim: "Two memories about the VIP drain look like near-duplicates.",
      quote: "Drain the VIP before reverting the deploy.",
      cite: `/${intact.path}`
    })
    const stale = await seedDetectedTask({
      slug: "review-the-bastion-port-claim",
      key: keyFor(2),
      claim: "Two memories about the bastion port look like near-duplicates.",
      quote: "The staging bastion listens on port 2222.",
      cite: `/${edited.path}`
    })

    // Both quotes are true right now, which is what makes the edit below the only difference.
    const before = await doctorReport()
    expect(before.staleQuotes).toEqual([])

    /**
     * The human edits the very sentence the detector flagged — 2222 becomes 22022. That is the
     * ordinary way a stale quote appears, and it is the finding being RESOLVED rather than a defect
     * appearing, which is why the check is report-only.
     */
    await breakTheClaim(edited.path, "port 2222", "port 22022")

    const report = await doctorReport()
    const finding = report.staleQuotes.find((entry) => entry.path === stale)
    expect(finding?.state).toBe("quote-gone")
    expect(finding?.citedPath).toBe(`/${edited.path}`)
    // The intact task is NOT reported, so the finding above is the edit and not the extraction.
    expect(report.staleQuotes.map((entry) => entry.path)).not.toContain(good)

    /**
     * `healthy` stays TRUE with a finding present. A stale quote is a fact about detected work, the
     * same claim `overdueTasks` and `staleBlockers` make — and the usual cause is a human fixing the
     * text a detector complained about, so failing the flag would punish the fix. This assertion is
     * the one that fails if someone folds the list into `healthy`.
     */
    expect(report.staleQuotes.length).toBeGreaterThan(0)
    expect(report.healthy).toBe(true)
  })

  it("reports a deleted cited file as missing, and follows an ARCHIVED one to its year", async () => {
    /**
     * The two halves of path resolution, in one case because they are the same lookup with different
     * answers. Eviction is a `git mv` into `archive/<YYYY>/` that preserves the bytes, so an archived
     * source still backs its quote and reporting it would make the check fire on every finding whose
     * evidence was archived — the common case, since a detected task outlives the memories it cites.
     * Only a path with no file ANYWHERE is `missing`.
     */
    const archived = await writeMemory(cli, {
      title: "The ingest lambda retries three times",
      claim: "The ingest lambda retries three times before dead-lettering.",
      body: ["A fourth attempt would exceed the visibility timeout."]
    })
    const deleted = await writeMemory(cli, {
      title: "The nightly export runs at 0200 UTC",
      claim: "The nightly export runs at 0200 UTC.",
      body: ["It is scheduled by an EventBridge rule, not by cron."]
    })

    const chased = await seedDetectedTask({
      slug: "review-the-ingest-retry-claim",
      key: keyFor(3),
      claim: "Two memories about the ingest retry look like near-duplicates.",
      quote: "The ingest lambda retries three times before dead-lettering.",
      cite: `/${archived.path}`
    })
    const orphaned = await seedDetectedTask({
      slug: "review-the-export-schedule-claim",
      key: keyFor(4),
      claim: "Two memories about the export schedule look like near-duplicates.",
      quote: "The nightly export runs at 0200 UTC.",
      cite: `/${deleted.path}`
    })

    // Not vacuous: neither task is a finding while both cited files sit where the tasks named them.
    const before = await doctorReport()
    expect(before.staleQuotes.map((entry) => entry.path)).not.toContain(chased)
    expect(before.staleQuotes.map((entry) => entry.path)).not.toContain(orphaned)

    await cli.json(["archive", archived.path, "--reason", "superseded by the retry policy doc"])
    await rm(join(cli.root, deleted.path))
    await cli.git("add", "-A")
    await cli.git("commit", "-m", "chore: drop the export schedule memory by hand")

    const report = await doctorReport()

    /**
     * The archive chase resolved: the cited path holds no file, and `archive/<YYYY>/<orig>` does. The
     * quote is still verifiable, so there is no finding — and this is the assertion that fails if the
     * chase is dropped, since a bare `known.has(cited)` would call this `missing`.
     */
    expect(report.staleQuotes.map((entry) => entry.path)).not.toContain(chased)
    // And the archive move really happened, so the clean result above is not a file that never moved.
    expect(
      await cli.json<TaskList>(["task", "list", "--include-archived", "--limit", "500"])
    ).toBeDefined()
    const moved = await readFile(
      join(cli.root, `archive/${new Date().getUTCFullYear()}/${archived.path}`),
      "utf8"
    )
    expect(moved).toContain("The ingest lambda retries three times before dead-lettering.")

    const finding = report.staleQuotes.find((entry) => entry.path === orphaned)
    expect(finding?.state).toBe("missing")
    // Reported at the path the TASK wrote, not at an archive path the chase failed to find.
    expect(finding?.citedPath).toBe(`/${deleted.path}`)
  })

  it("does not scan a HAND-AUTHORED task, however it quotes a file", async () => {
    /**
     * The contaminating neighbor, and without it `finding_key IS NOT NULL` is removable with this
     * suite still green: a fixture of only detected tasks cannot distinguish "checks every detected
     * task's quotes" from "checks every task's quotes". A human's task is not a machine finding — its
     * author owns its quotes, and `<q cite>` is a general vocabulary element any memory may use, so
     * doctor auditing hand-authored prose would report on writing nobody asked it to police.
     */
    const source = await writeMemory(cli, {
      title: "The canary weight starts at five percent",
      claim: "The canary weight starts at five percent.",
      body: ["It doubles every ten minutes once the error rate holds."]
    })
    const handAuthored = await seedDetectedTask({
      slug: "check-the-canary-weight-by-hand",
      key: keyFor(5),
      claim: "Someone should confirm the canary ramp against the deploy config.",
      quote: "The canary weight starts at five percent.",
      cite: `/${source.path}`,
      detected: false
    })

    await breakTheClaim(source.path, "five percent", "ten percent")

    const report = await doctorReport()
    // The quote is genuinely gone — the same edit that fires on a detected task — and this task is
    // still not reported, because it carries no finding key.
    expect(report.staleQuotes.map((entry) => entry.path)).not.toContain(handAuthored)
    // Not vacuous: the file IS a task the index holds, and it IS in the working set.
    const tasks = await cli.json<TaskList>(["task", "list", "--limit", "500"])
    expect(tasks.tasks.map((task) => task.path)).toContain(handAuthored)
    // And it carries no key, which is the column the exclusion turns on.
    const detected = await cli.json<TaskList>(["task", "list", "--detected", "--limit", "500"])
    expect(detected.tasks.map((task) => task.path)).not.toContain(handAuthored)
  })

  it("stops checking a task once it is DONE, so a closed finding never re-reports", async () => {
    /**
     * `archived = 0` and `task_status <> 'done'` are both on the query, mirroring
     * `openDetectedTasks`. A finished detected task's quote is history: the finding was settled, and
     * reporting its stale evidence would make the list grow forever and never reach zero — the same
     * reasoning `overdueTasks` records for its own two filters.
     */
    const source = await writeMemory(cli, {
      title: "The queue depth alarm fires at one thousand",
      claim: "The queue depth alarm fires at one thousand messages.",
      body: ["Below that the consumer catches up without paging anyone."]
    })
    const task = await seedDetectedTask({
      slug: "review-the-queue-depth-alarm-claim",
      key: keyFor(6),
      claim: "Two memories about the queue depth alarm look like near-duplicates.",
      quote: "The queue depth alarm fires at one thousand messages.",
      cite: `/${source.path}`
    })

    await breakTheClaim(source.path, "one thousand messages", "five thousand messages")

    // Not vacuous: OPEN, the stale quote IS reported. Without this the assertion below would hold on
    // a task whose quote was never broken.
    const open = await doctorReport()
    expect(open.staleQuotes.find((entry) => entry.path === task)?.state).toBe("quote-gone")

    const done = await cli.json<{ readonly archivePath: string | null }>([
      "task",
      "status",
      task,
      "done",
      "--reason",
      "the near-duplicate was merged by hand"
    ])
    const report = await doctorReport()
    // Gone under BOTH of its names: the open path it had and the archive path it moved to.
    const paths = report.staleQuotes.map((entry) => entry.path)
    expect(paths).not.toContain(task)
    expect(paths).not.toContain(done.archivePath)
  })
})
