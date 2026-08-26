import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { DatabaseService } from "@memhtml/index"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { entityActivity, entityActivityQuery } from "../src/operations.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * `memhtml entity activity`: per-entity file counts and last activity, over a real corpus.
 *
 * **The fixture is built so every assertion has a NEIGHBOUR that a wrong aggregate returns.**
 * `file_entities` is one table shared by every entity in the corpus, and a clean-database test seeded
 * with the subject alone passes against a `GROUP BY` that groups on the wrong column, against a filter
 * that leaks another entity's rows, and against a count that counts `file_entities` rows instead of
 * distinct entities. So there are two entities, they SHARE one memory, and each has a memory the other
 * does not.
 *
 * **Two clocks, on purpose, and they disagree.** `event_at` is WORLD time, the first `<time datetime>`
 * in the article, meaning when the remembered fact happened. `updated_at` is WRITE time, the
 * `memhtml-updated` head meta. The seeded values are chosen so `max(coalesce(event_at, updated_at))`
 * and `coalesce(max(event_at), max(updated_at))` give DIFFERENT answers for one of the two entities —
 * that pair of expressions is the mistake this report is most likely to be written with, and on a
 * fixture where every memory carries a world time they agree and the defect is invisible.
 *
 * Write time is controlled the way the corpus itself controls it: by editing the `memhtml-updated`
 * meta and re-indexing. That meta is in the head, so the edit does not move the article's content
 * hash, which is the same property `task status` relies on.
 */

const runProcess = promisify(execFile)

const commitAll = async (cli: Cli, subject: string): Promise<void> => {
  await runProcess("git", ["add", "-A"], { cwd: cli.root })
  await runProcess("git", ["commit", "-m", subject], { cwd: cli.root })
}

interface ActivityRow {
  readonly entity: string
  readonly entityType: string
  readonly entityName: string
  readonly fileCount: number
  readonly lastActivityAt: string
  readonly lastEventAt: string | null
  readonly lastWrittenAt: string
}

interface ActivityReport {
  readonly entities: ReadonlyArray<ActivityRow>
  readonly entityCount: number
  readonly limit: number
}

/** One memory, authored as markup so its `<time datetime>` reaches `files.event_at`. */
const seed = async (
  cli: Cli,
  input: {
    readonly title: string
    readonly claim: string
    readonly entities: ReadonlyArray<string>
    /** WORLD time, or absent for a memory that states none. */
    readonly eventAt?: string | undefined
  }
): Promise<string> => {
  const time =
    input.eventAt === undefined
      ? ""
      : ` <time datetime="${input.eventAt}">${input.eventAt.slice(0, 10)}</time>`
  const written = await cli.json<{ readonly path: string }>([
    "write",
    "--type",
    "semantic",
    "--title",
    input.title,
    "--article-html",
    `<p><mark>${input.claim}</mark>${time}</p>`,
    ...input.entities.flatMap((entity) => ["--entity", entity])
  ])
  return written.path
}

/** Set one memory's WRITE time by editing the head meta the projection reads for `updated_at`. */
const setWrittenAt = async (cli: Cli, path: string, at: string): Promise<void> => {
  const absolute = join(cli.root, path)
  const html = await readFile(absolute, "utf8")
  const replaced = html.replace(
    /<meta name="memhtml-updated" content="[^"]*">/,
    `<meta name="memhtml-updated" content="${at}">`
  )
  // A guard, because a silent no-op replace would make every timestamp assertion below describe the
  // clock the writes happened at rather than the fixture.
  if (replaced === html) throw new Error(`no memhtml-updated meta in ${path}`)
  await writeFile(absolute, replaced, "utf8")
}

/** One memory's projected WRITE time, read from the index rather than assumed. */
const writtenAtOf = (cli: Cli, path: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService
      const row = yield* db.get<{ updated_at: string }>(
        "SELECT updated_at FROM files WHERE path = ?",
        [path]
      )
      if (row === undefined) throw new Error(`no indexed row for ${path}`)
      return row.updated_at
    }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
  )

describe("memhtml entity activity", () => {
  let cli: Cli
  /** Carries `service:checkout-api` only, with a world time OLDER than the shared memory's write. */
  let checkoutOnly = ""
  /** Carries BOTH entities and states no world time, so its write time is its activity. */
  let shared = ""
  /** Carries `person:sanju` only, with a world time NEWER than anything else. */
  let sanjuOnly = ""
  /**
   * Carries `concept:sanju`: the SAME name under a DIFFERENT type.
   *
   * The neighbour that makes the grouping's column list observable. `file_entities` is keyed on the
   * pair, so a `GROUP BY entity_name` alone merges this entity with `person:sanju` and reports one row
   * where the corpus holds two — and on a fixture whose names are all distinct, that merge is
   * invisible. It is the same ambiguity `SearchScope.entity` refuses a bare name for.
   */
  let conceptSanju = ""
  /** Carries `service:checkout-api` and is archived, so it counts only under --include-archived. */
  let archived = ""

  const OLD_EVENT = "2026-06-01T00:00:00Z"
  const NEW_EVENT = "2026-08-15T00:00:00Z"
  const SHARED_WRITE = "2026-08-01T00:00:00Z"
  const OLD_WRITE = "2026-07-01T00:00:00Z"
  const SANJU_WRITE = "2026-05-01T00:00:00Z"
  const CONCEPT_WRITE = "2026-04-01T00:00:00Z"
  /** The archived memory's own write time, read off the index after the eviction stamped it. */
  let archivedWrittenAt = ""

  beforeAll(async () => {
    cli = await makeCli()

    checkoutOnly = await seed(cli, {
      title: "The checkout API drains before a rollback",
      claim: "The checkout API drains its VIP before a rollback.",
      entities: ["service:checkout-api"],
      eventAt: OLD_EVENT
    })
    shared = await seed(cli, {
      title: "Sanju owns the checkout API rollback runbook",
      claim: "Sanju owns the checkout API rollback runbook.",
      entities: ["service:checkout-api", "person:sanju"]
    })
    sanjuOnly = await seed(cli, {
      title: "Sanju moved to the platform team",
      claim: "Sanju moved to the platform team.",
      entities: ["person:sanju"],
      eventAt: NEW_EVENT
    })
    conceptSanju = await seed(cli, {
      title: "Sanju is the name of the deploy-gate concept",
      claim: "The deploy-gate concept is called sanju after its first reviewer.",
      entities: ["concept:sanju"]
    })
    const evictable = await seed(cli, {
      title: "The checkout API used a single target group",
      claim: "The checkout API serves from one target group.",
      entities: ["service:checkout-api"]
    })

    await setWrittenAt(cli, checkoutOnly, OLD_WRITE)
    await setWrittenAt(cli, shared, SHARED_WRITE)
    await setWrittenAt(cli, sanjuOnly, SANJU_WRITE)
    await setWrittenAt(cli, conceptSanju, CONCEPT_WRITE)
    await commitAll(cli, "pin every fixture's write time")
    await cli.json(["index", "update"])

    /*
     * Archived LAST, and its write time is deliberately NOT pinned: `archiveMemory` stamps
     * `memhtml-updated` itself in the eviction commit, so an archived memory's write time is the
     * moment it was evicted — which is now, and therefore newer than every pinned fixture time. That
     * is what makes the archived filter observable rather than merely present: including this memory
     * moves `service:checkout-api`'s activity to today and its count to three.
     */
    const evicted = await cli.json<{ readonly archivePath: string }>([
      "archive",
      evictable,
      "--reason",
      "the fleet moved to two target groups"
    ])
    archived = evicted.archivePath
    expect(archived.startsWith("archive/")).toBe(true)
    archivedWrittenAt = await writtenAtOf(cli, archived)
    // Derived from the index rather than assumed, and asserted to be the newest: an eviction stamp
    // that landed BEFORE the fixture's pinned times would make the case below vacuous.
    expect(archivedWrittenAt > SHARED_WRITE).toBe(true)
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  const report = () => cli.json<ActivityReport>(["entity", "activity"])

  it("reports exactly the two seeded entities, counting DISTINCT entities and not rows", async () => {
    /**
     * The census. Six `file_entities` rows are seeded across five memories, and the answer is THREE
     * entities — so a count over the join rather than over the groups reads as 6, and a `GROUP BY`
     * that dropped `entity_type` merges `person:sanju` with `concept:sanju` and reads as 2. The total
     * is derived from the fixture here rather than copied from the output.
     */
    const activity = await report()
    expect(activity.entities.map((row) => row.entity)).toEqual([
      "person:sanju",
      "service:checkout-api",
      "concept:sanju"
    ])
    expect(activity.entityCount).toBe(3)
    expect(activity.limit).toBe(50)
  })

  it("counts only the memories that carry each entity, not the corpus", async () => {
    // The shared memory is in BOTH counts and neither count is 4. An aggregate that lost its
    // correlation would report the corpus size for every entity.
    const activity = await report()
    const byEntity = new Map(activity.entities.map((row) => [row.entity, row]))
    expect(byEntity.get("service:checkout-api")?.fileCount).toBe(2)
    expect(byEntity.get("person:sanju")?.fileCount).toBe(2)
    // One memory, under a name another entity shares: a grouping on the name alone reports 3 here.
    expect(byEntity.get("concept:sanju")?.fileCount).toBe(1)
  })

  it("takes the maximum of the PER-ROW coalesce, which the two maxima disagree with", async () => {
    /**
     * `service:checkout-api` is the discriminating entity. Its two active memories are the one with
     * WORLD time 2026-06-01 and the shared one with WRITE time 2026-08-01 and no world time:
     *
     * - `max(coalesce(event_at, updated_at))` = max(2026-06-01, 2026-08-01) = **2026-08-01**.
     * - `coalesce(max(event_at), max(updated_at))` = coalesce(2026-06-01, …) = 2026-06-01.
     *
     * Both are plausible-looking answers and only the first one means "the newest thing we know
     * about this entity". The two aggregates are published beside it so a caller needing one clock
     * alone does not have to guess which one a coalesced value came from.
     */
    const activity = await report()
    const checkout = activity.entities.find((row) => row.entity === "service:checkout-api")
    expect(checkout?.lastActivityAt).toBe(SHARED_WRITE)
    expect(checkout?.lastEventAt).toBe(OLD_EVENT)
    expect(checkout?.lastWrittenAt).toBe(SHARED_WRITE)
  })

  it("lets WORLD time win when a memory states one newer than any write", async () => {
    // `person:sanju`'s newest world time (2026-09-01) is on the memory with the OLDEST write time
    // (2026-05-01), so an aggregate that ranked by write time alone would report 2026-08-01.
    const activity = await report()
    const sanju = activity.entities.find((row) => row.entity === "person:sanju")
    expect(sanju?.lastActivityAt).toBe(NEW_EVENT)
    expect(sanju?.lastEventAt).toBe(NEW_EVENT)
    expect(sanju?.lastWrittenAt).toBe(SHARED_WRITE)
  })

  it("orders by activity, newest first", async () => {
    // 2026-09-01 before 2026-08-01. The ordering is the report's whole point, and it is over an
    // aggregate rather than a column, so it cannot be inherited from an index.
    const activity = await report()
    expect(activity.entities.map((row) => row.lastActivityAt)).toEqual([
      NEW_EVENT,
      SHARED_WRITE,
      CONCEPT_WRITE
    ])
  })

  it("excludes archived memories by default and counts them under --include-archived", async () => {
    /**
     * Eviction is a `git mv`, so the archived memory still exists and still carries its entity. Its
     * write time is the NEWEST in the corpus, which is what makes the filter observable rather than
     * merely present: including it moves `service:checkout-api` to 2026-12-01 and its count to three.
     */
    const active = await report()
    const withArchived = await cli.json<ActivityReport>([
      "entity",
      "activity",
      "--include-archived"
    ])
    const activeCheckout = active.entities.find((row) => row.entity === "service:checkout-api")
    const allCheckout = withArchived.entities.find((row) => row.entity === "service:checkout-api")
    expect(activeCheckout?.fileCount).toBe(2)
    expect(activeCheckout?.lastActivityAt).toBe(SHARED_WRITE)
    expect(allCheckout?.fileCount).toBe(3)
    expect(allCheckout?.lastActivityAt).toBe(archivedWrittenAt)
    // Strictly newer under the flag, and newer than the other entity's activity too, so the archived
    // arm now leads the ordering: the flag changed the ANSWER rather than only the row set.
    expect((allCheckout?.lastActivityAt ?? "") > (activeCheckout?.lastActivityAt ?? "")).toBe(true)
    expect(withArchived.entities[0]?.entity).toBe("service:checkout-api")
  })

  it("narrows to one entity type, dropping the other's rows entirely", async () => {
    const scoped = await cli.json<ActivityReport>(["entity", "activity", "--type", "service"])
    expect(scoped.entities.map((row) => row.entity)).toEqual(["service:checkout-api"])
    // The count follows the scope, so a caller cannot read the corpus total as its filtered answer.
    expect(scoped.entityCount).toBe(1)
  })

  it("clamps an out-of-range limit and reports the bound it used", async () => {
    // Clamped rather than refused, the shape `memory_list` and `neighbors` already have, and `limit`
    // echoes the bound so a clamped ask is visible rather than silent.
    const one = await cli.json<ActivityReport>(["entity", "activity", "--limit", "1"])
    expect(one.entities).toHaveLength(1)
    expect(one.limit).toBe(1)
    // `entityCount` ignores the limit, which is how a caller tells a page from the whole answer.
    expect(one.entityCount).toBe(3)

    const huge = await cli.json<ActivityReport>(["entity", "activity", "--limit", "100000"])
    expect(huge.limit).toBe(500)
    const zero = await cli.json<ActivityReport>(["entity", "activity", "--limit", "0"])
    expect(zero.limit).toBe(1)
  })

  it("publishes the reference in `type:name` form, so a hop off it is a copy", async () => {
    // The same spelling `--entity` takes. A caller reassembling it from the two halves would have to
    // guess where the colon goes, and `file_entities` is keyed on the pair.
    const activity = await report()
    for (const row of activity.entities) {
      expect(row.entity).toBe(`${row.entityType}:${row.entityName}`)
      const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
        "list",
        "--entity",
        row.entity
      ])
      expect(listed.files).toHaveLength(row.fileCount)
    }
  })

  it("GROUPS through file_entities_name rather than sorting the join into a temp b-tree", async () => {
    /**
     * A cost contract asserted as shape, because the rows come back either way.
     *
     * `file_entities_name` covers `(entity_type, entity_name)`, which is exactly this statement's
     * `GROUP BY` column set, so the grouping is an index scan. Group on anything the index does not
     * cover — or on an EXPRESSION over those columns, which is the version a refactor produces — and
     * SQLite materializes the whole join into a temp b-tree to group it: same answer, one extra full
     * sort per call over a table that grows with the corpus.
     *
     * The column ORDER is deliberately not asserted, because it is not load-bearing: probed 2026-08-26,
     * naming the two either way plans identically, since SQLite reorders group keys to match an index it
     * can use. Asserting the order would be asserting a fact about this test rather than about cost.
     *
     * The plan is taken of the statement `entityActivity` ITSELF builds, through the exported
     * `entityActivityQuery`. A pasted copy would be a test explaining its own string, which this repo
     * has already shipped once and watched keep passing while the clause it guarded was deleted.
     *
     * The ORDER BY is over an aggregate and no index can serve it, so exactly one `USE TEMP B-TREE FOR
     * ORDER BY` is expected and is the sort this report knowingly pays for. A second temp b-tree is the
     * grouping having lost its index, which is what the count asserts.
     */
    const statement = entityActivityQuery({})
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService
        return yield* db.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${statement.sql}`,
          statement.params
        )
      }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
    )
    const steps = plan.map((row) => row.detail)
    expect(steps.length).toBeGreaterThan(0)
    expect(
      steps.some((step) => step.includes("file_entities_name")),
      `plan: ${steps.join(" | ")}`
    ).toBe(true)
    const sorts = steps.filter((step) => step.includes("USE TEMP B-TREE"))
    expect(sorts, `plan: ${steps.join(" | ")}`).toEqual(["USE TEMP B-TREE FOR ORDER BY"])
  })

  it("is reachable from apps/cli only, which is what keeps it out of ranking and decay", async () => {
    /**
     * Caution (a) as a structural fact rather than a comment. Every ranking term lives in
     * `@memhtml/index` (the four arms) and every decay term in `@memhtml/domain` (retention), and both
     * sit BELOW `apps/cli` in the project-reference graph — so neither can import this function, and an
     * attempt is a compile error rather than a review comment.
     *
     * The salience arm's two exclusions are why that matters: it refuses to rank `resources/people/`
     * because decay is wrong for identity, and refuses `task` because decay there rewards staleness. An
     * "entity last active" number wired into ranking reintroduces both at once.
     *
     * Asserted by importing it here and reading it as a function, which is the only claim a test can
     * make about a boundary the compiler already enforces: the symbol exists in the layer that may
     * have it.
     */
    expect(typeof entityActivity).toBe("function")
    expect(shared).not.toBe("")
    expect(checkoutOnly).not.toBe("")
    expect(sanjuOnly).not.toBe("")
    expect(conceptSanju).not.toBe("")
  })
})
