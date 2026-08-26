import { RRF_K } from "@memhtml/domain"
import { describe, expect, it } from "vitest"
import {
  activeArms,
  buildRrfSql,
  buildSnippetSql,
  RANK_ARMS,
  SALIENCE_EXCLUDED_PREFIX,
  SALIENCE_EXCLUDED_TYPE,
  truncateSnippet
} from "../src/retrieval-sql.js"
import { SNIPPET_MAX_CHARS, TRACE_TABLES } from "../src/schema-const.js"
import { assembleScope, EXCLUDED_BY_DEFAULT } from "../src/scope.js"

/**
 * The assembler, as a pure function over the arm registry. These are the assertions that make the
 * degradation path and the trace firewall structural rather than aspirational.
 */

const holes = () => assembleScope().holes

describe("the arm registry", () => {
  it("declares exactly the four arms the design names, at their weights", () => {
    expect(RANK_ARMS.map((arm) => [arm.name, arm.weight])).toEqual([
      ["fts", 1.0],
      ["vector", 1.0],
      ["recency", 0.5],
      ["salience", 0.4]
    ])
  })

  it("marks the vector arm as the only one needing an embedding, and salience as the only one needing state", () => {
    expect(RANK_ARMS.filter((arm) => arm.needsEmbedding).map((arm) => arm.name)).toEqual(["vector"])
    expect(RANK_ARMS.filter((arm) => arm.needsState).map((arm) => arm.name)).toEqual(["salience"])
  })
})

describe("buildRrfSql", () => {
  it("folds all four arms when a vector and the state plane are both available", () => {
    const sql = buildRrfSql({ hasQueryVector: true, hasState: true, holes: holes() })
    for (const name of ["fts", "vector", "recency", "salience"]) {
      expect(sql).toContain(`${name} AS (`)
    }
    expect(sql).toContain("SUM(s) AS score")
    expect(sql).toContain("GROUP BY path")
  })

  it("inlines the weights as literals and RRF_K as the domain constant", () => {
    const sql = buildRrfSql({ hasQueryVector: true, hasState: true, holes: holes() }) ?? ""
    // Weights are trusted config, not caller input: inlining keeps the bound tuple at four regardless
    // of how many arms fire.
    expect(sql).toContain(`1.0000 / (rank + ${RRF_K})`)
    expect(sql).toContain(`0.5000 / (rank + ${RRF_K})`)
    expect(sql).toContain(`0.4000 / (rank + ${RRF_K})`)
    expect(RRF_K).toBe(60)
  })

  it("drops the vector arm and every reference to ?4 when there is no query vector", () => {
    const sql = buildRrfSql({ hasQueryVector: false, hasState: true, holes: holes() }) ?? ""
    expect(sql).not.toContain("vector AS (")
    expect(sql).not.toContain("vector_distance_cos")
    // The load-bearing assertion: with the arm gone, ?4 must appear NOWHERE, so the caller's
    // four-value prefix leaves it unbound and unreferenced and ?1-?3 keep their meaning.
    expect(sql).not.toContain("?4")
    expect(sql).toContain("?1")
    expect(sql).toContain("?2")
    expect(sql).toContain("?3")
  })

  it("drops the salience arm and every state reference when no state plane is attached", () => {
    const sql = buildRrfSql({ hasQueryVector: true, hasState: false, holes: holes() }) ?? ""
    expect(sql).not.toContain("salience AS (")
    expect(sql).not.toContain("state.access")
  })

  it("returns undefined rather than a broken statement when every arm is inert", () => {
    expect(
      buildRrfSql({
        hasQueryVector: false,
        hasState: false,
        holes: holes(),
        arms: RANK_ARMS.filter((arm) => arm.needsEmbedding || arm.needsState)
      })
    ).toBeUndefined()
  })

  it("treats a zero-weight arm as structurally absent", () => {
    const sql =
      buildRrfSql({
        hasQueryVector: true,
        hasState: true,
        holes: holes(),
        arms: RANK_ARMS.map((arm) => (arm.name === "recency" ? { ...arm, weight: 0 } : arm))
      }) ?? ""
    expect(sql).not.toContain("recency AS (")
  })

  it("leaves no {alias} token unsubstituted in any assembled form", () => {
    for (const hasQueryVector of [true, false]) {
      for (const hasState of [true, false]) {
        const scoped = assembleScope({
          memoryTypes: ["semantic"],
          workspace: "memhtml",
          tags: ["deploy"],
          entity: "service:checkout-api",
          includeArchived: false
        })
        const sql = buildRrfSql({ hasQueryVector, hasState, holes: scoped.holes }) ?? ""
        if (sql === "") continue
        expect(
          sql,
          `unsubstituted alias at vector=${hasQueryVector} state=${hasState}`
        ).not.toContain("{alias}")
      }
    }
  })
})

describe("activeArms", () => {
  it("keeps registry order, which RRF's commuting sum makes a presentation detail", () => {
    expect(
      activeArms({ hasQueryVector: true, hasState: true, holes: holes() }).map((arm) => arm.name)
    ).toEqual(["fts", "vector", "recency", "salience"])
  })

  it("degrades to the lexical floor when neither a vector nor state is available", () => {
    expect(
      activeArms({ hasQueryVector: false, hasState: false, holes: holes() }).map((arm) => arm.name)
    ).toEqual(["fts", "recency"])
  })
})

/**
 * The salience arm's own exclusions, and the fact that they are ITS exclusions and nobody else's.
 *
 * Salience ranks interchangeable candidates. A task is reached by `task_status`/`due_at` and a
 * person-reference record by entity key, so ranking either by decayed access reward would reward
 * staleness in the first case and decay identity in the second. The assertion that matters is the
 * LOCALITY: the predicates live inside `salienceArm.sql` and not in the shared `fileFilter`, because an
 * excluded row must keep its FTS, vector, and recency ranks — the arm has no opinion, the query is not
 * narrowed.
 */
describe("the salience arm's type scoping", () => {
  it("excludes tasks and resources/people from the salience arm and from no other arm", () => {
    /**
     * Asserted against an OPTED-IN scope, and it has to be: under the default scope the shared filter
     * emits its own `{alias}.memory_type <> 'task'` into every arm, so a naive grep for that predicate
     * cannot tell the arm's rule from the query's default. `memory_types: ["task"]` replaces the
     * default with an `IN` list, leaving the arm's own copy as the only one in the statement.
     */
    const scoped = assembleScope({ memoryTypes: ["task"] }).holes
    for (const arm of RANK_ARMS) {
      const sql = arm.sql(scoped)
      const expected = arm.name === "salience"
      expect(sql.includes(`memory_type <> '${SALIENCE_EXCLUDED_TYPE}'`), `${arm.name}`).toBe(
        expected
      )
      // The prefix predicate has no counterpart in any scope, so it is checked under both shapes.
      for (const holed of [scoped, holes()]) {
        expect(arm.sql(holed).includes(`NOT LIKE '${SALIENCE_EXCLUDED_PREFIX}%'`), arm.name).toBe(
          expected
        )
      }
    }
  })

  it("keeps the exclusions out of the shared filter, which every arm receives", () => {
    // In the fileFilter these would narrow the whole query rather than one arm's opinion, and an
    // opted-in `memory_types: ["task"]` search would then return nothing at all.
    for (const scope of [
      assembleScope(),
      assembleScope({ memoryTypes: ["task"] }),
      assembleScope({ includeArchived: true, workspace: "memhtml" })
    ]) {
      expect(scope.holes.fileFilter).not.toContain("NOT LIKE")
      expect(scope.holes.fileFilter).not.toContain(SALIENCE_EXCLUDED_PREFIX)
    }
  })

  it("holds the exclusions even when the caller explicitly opts task in", () => {
    /**
     * The load-bearing case. `memory_types: ["task"]` replaces the default `<> 'task'` in the shared
     * filter with an `IN` list, so this is the one query where a task reaches every arm's candidate
     * set — and the arm's own predicate is what makes its rank salience-invariant there. Without it the
     * opt-in is exactly the query the rule exists for and the rule would not apply to it.
     */
    const scoped = assembleScope({ memoryTypes: ["task"] })
    const salience = RANK_ARMS.find((arm) => arm.name === "salience")
    expect(salience).toBeDefined()
    const sql = salience?.sql(scoped.holes) ?? ""
    expect(sql).toContain(`f.memory_type <> '${SALIENCE_EXCLUDED_TYPE}'`)
    expect(sql).toContain("f.memory_type IN (?5)")
  })

  it("names the exclusions as constants rather than repeating the literals", () => {
    // One value per rule, the `EXCLUDED_BY_DEFAULT` precedent: the arm, this test, and the docs all
    // read the same constant, so a change cannot leave one of the three behind.
    expect(SALIENCE_EXCLUDED_TYPE).toBe("task")
    expect(SALIENCE_EXCLUDED_PREFIX).toBe("resources/people/")
  })
})

/**
 * The trace firewall. `.memhtml` never holds session content and a trace row can never enter RRF
 * retrieval — the predecessor memory system enforced that with a separate Postgres schema, and here it is a table-name
 * firewall, so the enforcement IS this test.
 *
 * Every assemblable statement is checked, across both degradation axes and both scope shapes, because
 * a firewall that holds for the default form and leaks for the scoped one is not a firewall.
 */
describe("trace firewall", () => {
  it("names no trace table in any statement the assembler can produce", () => {
    const scopes = [
      assembleScope(),
      assembleScope({ includeArchived: true }),
      assembleScope({ memoryTypes: ["semantic", "arc"], workspace: "memhtml", tags: ["a", "b"] }),
      // The entity axis is checked here too: its subquery is the newest table name to enter this
      // filter, and a firewall that holds for three scope shapes and leaks for the fourth is not one.
      assembleScope({ entity: "person:sanju" })
    ]
    let checked = 0
    for (const scope of scopes) {
      for (const hasQueryVector of [true, false]) {
        for (const hasState of [true, false]) {
          const sql = buildRrfSql({ hasQueryVector, hasState, holes: scope.holes })
          if (sql === undefined) continue
          checked += 1
          for (const table of [
            ...TRACE_TABLES,
            "memory_session_links",
            "sleep_runs",
            "sleep_phases",
            /**
             * `trace_consolidations` is the newest run-state table and it is named here for the same
             * reason `sleep_runs` is: the sleep cycle now WRITES memories derived from transcripts, and
             * the firewall's claim is that no trace-plane row reaches retrieval — a consolidated memory
             * reaches it as an ordinary `files` row, which is correct, while the watermark saying it
             * happened must not.
             */
            "trace_consolidations"
          ]) {
            expect(sql, `${table} reached retrieval SQL`).not.toContain(table)
          }
        }
      }
    }
    // The count is asserted so a future refactor that silently stops assembling cannot pass this test
    // by producing nothing to check.
    expect(checked).toBe(16)
  })

  it("names no trace table in any arm's own template", () => {
    for (const arm of RANK_ARMS) {
      const sql = arm.sql(holes())
      for (const table of TRACE_TABLES) {
        expect(sql, `${arm.name} named ${table}`).not.toContain(table)
      }
    }
  })
})

describe("the as-of temporal lens", () => {
  it("assembles the exact pre-change filter when asOf is absent — the byte-identical pin", () => {
    /**
     * The load-bearing pin: a caller that names no `asOf` must get TODAY's SQL, byte for byte.
     * Asserted as the literal string rather than as properties, because the property form would
     * pass a filter that reordered or reworded the conditions — and the claim is bytes.
     */
    const expected =
      "\n         AND {alias}.archived = 0\n         AND {alias}.memory_type <> 'task'"
    expect(assembleScope().holes.fileFilter).toBe(expected)
    expect(assembleScope({}).holes.fileFilter).toBe(expected)
    // An explicit undefined and an empty string are both "not asked", never a lens over nothing.
    expect(assembleScope({ asOf: undefined }).holes.fileFilter).toBe(expected)
    expect(assembleScope({ asOf: "" }).holes.fileFilter).toBe(expected)
    expect(assembleScope().params).toEqual([])
  })

  it("replaces the archived filter with the validity window when asOf is present", () => {
    const scoped = assembleScope({ asOf: "2024-01-01T00:00:00Z" })
    // Archived rows ENTER the candidate set: a superseded memory that was valid then is archived
    // now, and excluding it would make the point-in-time view show the present.
    expect(scoped.holes.fileFilter).not.toContain("archived = 0")
    // The window predicate, with the stamping rule's own coalesce order.
    expect(scoped.holes.fileFilter).toContain(
      "coalesce({alias}.valid_from, {alias}.event_at, {alias}.created_at) <= ?5"
    )
    expect(scoped.holes.fileFilter).toContain(
      "({alias}.valid_until IS NULL OR {alias}.valid_until > ?6)"
    )
    // One instant, two ends of the window: the value binds twice.
    expect(scoped.params).toEqual(["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])
  })

  it("reaches every arm through the shared filter, with no {alias} left behind", () => {
    /**
     * The lens is a SCOPE, so it must narrow every arm's candidate set — a lens that applied to
     * three arms and not the fourth would let a not-yet-valid memory earn a rank in the arm it
     * leaked from.
     */
    const scoped = assembleScope({ asOf: "2024-01-01T00:00:00Z" })
    for (const arm of RANK_ARMS) {
      const sql = arm.sql(scoped.holes)
      expect(sql, arm.name).toContain("valid_until")
      expect(sql, arm.name).not.toContain("{alias}")
    }
  })

  it("keeps the later scope placeholders numbered after the window's two", () => {
    // The window consumes ?5 and ?6, so a workspace scope must land at ?7 — a shifted number
    // would silently bind the wrong value, the exact failure the ?5-upward contract exists for.
    const scoped = assembleScope({ asOf: "2024-01-01T00:00:00Z", workspace: "memhtml" })
    expect(scoped.holes.fileFilter).toContain("{alias}.workspace = ?7")
    expect(scoped.params).toEqual(["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", "memhtml"])
  })
})

describe("buildSnippetSql", () => {
  it("returns undefined for zero paths rather than assembling IN ()", () => {
    expect(buildSnippetSql({ hasQueryVector: true, pathCount: 0 })).toBeUndefined()
    expect(buildSnippetSql({ hasQueryVector: false, pathCount: 0 })).toBeUndefined()
  })

  it("binds the query vector at ?1 and paths from ?2 when a vector exists", () => {
    const sql = buildSnippetSql({ hasQueryVector: true, pathCount: 3 }) ?? ""
    expect(sql).toContain("vector_distance_cos(e.vec, ?1)")
    expect(sql).toContain("IN (?2, ?3, ?4)")
    // A chunk with no embedding must survive the join with a NULL distance, not vanish: a sparse
    // vector plane is a legal state and the file still needs a snippet.
    expect(sql).toContain("LEFT JOIN embeddings")
    expect(sql).toContain("CASE WHEN e.chunk_id IS NULL THEN NULL")
  })

  it("binds paths from ?1 and selects only ordinal 0 on the degraded path", () => {
    const sql = buildSnippetSql({ hasQueryVector: false, pathCount: 2 }) ?? ""
    expect(sql).toContain("IN (?1, ?2)")
    expect(sql).toContain("ordinal = 0")
    // No vector, no distance function: the degraded statement must run with no embedding at all.
    expect(sql).not.toContain("vector_distance_cos")
    expect(sql).not.toContain("?3")
  })

  it("names no trace table in either form, same firewall as the fused statement", () => {
    for (const hasQueryVector of [true, false]) {
      const sql = buildSnippetSql({ hasQueryVector, pathCount: 4 }) ?? ""
      for (const table of TRACE_TABLES) {
        expect(sql, `${table} reached snippet SQL`).not.toContain(table)
      }
    }
  })
})

describe("truncateSnippet", () => {
  it("returns short text verbatim, with no marker", () => {
    expect(truncateSnippet("A short chunk.")).toBe("A short chunk.")
  })

  it("keeps a chunk exactly at the ceiling uncut", () => {
    const exact = "x".repeat(SNIPPET_MAX_CHARS)
    expect(truncateSnippet(exact)).toBe(exact)
  })

  it("cuts an oversized chunk to the ceiling with a … marker INSIDE it", () => {
    const cut = truncateSnippet("y".repeat(SNIPPET_MAX_CHARS + 1))
    expect(cut.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS)
    expect(cut.endsWith("…")).toBe(true)
    // The marker replaces text rather than extending past the ceiling, so a consumer budgeting
    // SNIPPET_MAX_CHARS per hit is never off by one.
    expect(cut.slice(0, -1)).toBe("y".repeat(SNIPPET_MAX_CHARS - 1))
  })

  it("does not leave trailing whitespace before the marker", () => {
    const text = `${"z".repeat(SNIPPET_MAX_CHARS - 3)}   overflow`
    const cut = truncateSnippet(text)
    expect(cut.endsWith(" …")).toBe(false)
    expect(cut.endsWith("…")).toBe(true)
  })
})

describe("assembleScope", () => {
  it("excludes archived rows and tasks when the caller names no scope at all", () => {
    const scope = assembleScope()
    expect(scope.holes.fileFilter).toContain("{alias}.archived = 0")
    expect(scope.holes.fileFilter).toContain(`{alias}.memory_type <> '${EXCLUDED_BY_DEFAULT}'`)
    // Inlined, not bound: the exclusion is this function's own default rather than caller input,
    // and binding it would consume `?5` and shift every scope parameter below it.
    expect(scope.params).toEqual([])
  })

  it("keeps excluding tasks even when only archived rows are asked for", () => {
    /**
     * The two axes are independent. `includeArchived` widens the STATUS axis, and a done task is
     * an archived task — so a caller asking for archived memories would otherwise start seeing
     * every task ever finished, which is the one place this default has to hold hardest.
     */
    const scope = assembleScope({ includeArchived: true })
    expect(scope.holes.fileFilter).not.toContain("archived = 0")
    expect(scope.holes.fileFilter).toContain(`{alias}.memory_type <> '${EXCLUDED_BY_DEFAULT}'`)
  })

  it("emits the task exclusion for an empty type list, not only an absent one", () => {
    // `memoryTypes: []` reaches here from a CLI flag nobody passed and from an MCP client that
    // sends the key with no values; both mean "no type filter", which means the default applies.
    for (const scope of [
      assembleScope({ memoryTypes: [] }),
      assembleScope({ workspace: "memhtml" })
    ]) {
      expect(scope.holes.fileFilter).toContain(`memory_type <> '${EXCLUDED_BY_DEFAULT}'`)
    }
  })

  it("honors a caller who names task, and never both filters at once", () => {
    const optedIn = assembleScope({ memoryTypes: ["task"] })
    expect(optedIn.holes.fileFilter).toContain("memory_type IN (?5)")
    expect(optedIn.params).toEqual(["task"])
    // The exclusion would make the opt-in unreachable, so the two branches are exclusive.
    expect(optedIn.holes.fileFilter).not.toContain("<>")

    const mixed = assembleScope({ memoryTypes: ["semantic", "task"] })
    expect(mixed.holes.fileFilter).toContain("memory_type IN (?5, ?6)")
    expect(mixed.params).toEqual(["semantic", "task"])
  })

  it("still excludes tasks when a caller names other types only", () => {
    // The `IN` list does the excluding here, so the two mechanisms never both fire — but the
    // OUTCOME is what matters and it is the same: no task reaches a query that did not ask.
    const scope = assembleScope({ memoryTypes: ["semantic", "procedural"] })
    expect(scope.params).not.toContain("task")
    expect(scope.holes.fileFilter).toContain("memory_type IN (?5, ?6)")
  })

  it("puts the exclusion in EVERY arm's assembled SQL, not only the fold's", () => {
    /**
     * The firewall-style grep. The filter is built once and each arm substitutes its own alias, so
     * an arm that forgot the hole would surface as a task appearing in one arm's candidate set and
     * missing from the others' — a leak no type catches and RRF would happily rank.
     */
    for (const hasQueryVector of [true, false]) {
      for (const hasState of [true, false]) {
        const sql = buildRrfSql({ hasQueryVector, hasState, holes: assembleScope().holes })
        if (sql === undefined) continue
        for (const arm of activeArms({ hasQueryVector, hasState, holes: assembleScope().holes })) {
          const armSql = arm.sql(assembleScope().holes)
          expect(armSql, `${arm.name} lost the task exclusion`).toContain(
            `memory_type <> '${EXCLUDED_BY_DEFAULT}'`
          )
        }
      }
    }
  })

  it("numbers scope placeholders from ?5, after the assembler's fixed four-value prefix", () => {
    const scope = assembleScope({ memoryTypes: ["semantic", "arc"] })
    expect(scope.holes.fileFilter).toContain("memory_type IN (?5, ?6)")
    expect(scope.params).toEqual(["semantic", "arc"])
  })

  it("makes workspace a STRICT equality, so a scoped query never sees a NULL-workspace page", () => {
    const scope = assembleScope({ workspace: "memhtml" })
    expect(scope.holes.fileFilter).toContain("workspace = ?5")
    // Not `IS NULL OR` — an unplaced memory is not "in every workspace".
    expect(scope.holes.fileFilter).not.toContain("IS NULL")
  })

  it("makes tags an ANY-of overlap, so each tag broadens rather than narrows", () => {
    const scope = assembleScope({ tags: ["deploy", "oncall"] })
    expect(scope.holes.fileFilter).toContain("EXISTS (SELECT 1 FROM file_tags ft")
    expect(scope.holes.fileFilter).toContain("ft.tag IN (?5, ?6)")
  })

  it("keeps placeholder order and parameter order in agreement across every axis", () => {
    const scope = assembleScope({
      memoryTypes: ["semantic"],
      workspace: "memhtml",
      tags: ["deploy", "oncall"],
      entity: "service:checkout-api"
    })
    expect(scope.holes.fileFilter).toContain("memory_type IN (?5)")
    expect(scope.holes.fileFilter).toContain("workspace = ?6")
    expect(scope.holes.fileFilter).toContain("ft.tag IN (?7, ?8)")
    expect(scope.holes.fileFilter).toContain("e.entity_name) = lower(?9)")
    expect(scope.params).toEqual([
      "semantic",
      "memhtml",
      "deploy",
      "oncall",
      "service:checkout-api"
    ])
  })

  it("ignores a memory type outside the closed vocabulary rather than binding it", () => {
    const scope = assembleScope({ memoryTypes: ["gossip" as "semantic"] })
    expect(scope.params).toEqual([])
    expect(scope.holes.fileFilter).not.toContain("memory_type IN")
  })

  it("ignores an empty workspace and a whitespace-only tag", () => {
    const scope = assembleScope({ workspace: "", tags: ["  ", "real"] })
    expect(scope.params).toEqual(["real"])
    expect(scope.holes.fileFilter).not.toContain("workspace =")
  })
})

/**
 * The entity scope, at the level a result assertion cannot see.
 *
 * Every assertion here is about the assembled TEXT, and that is the point rather than a convenience:
 * a mis-grouped or arm-missing entity predicate returns plausible rows on any fixture small enough to
 * write down, so the shape is the only place the defect is visible. The behavioral half — scoped-on
 * excludes, unscoped includes, same corpus — lives in `retrieval.test.ts`.
 */
describe("assembleScope: the entity axis", () => {
  const ENTITY = "service:checkout-api"

  it("emits the same EXISTS predicate memory_list issues, against file_entities", () => {
    // One predicate, two doors. `listMemories` (apps/cli/src/operations.ts:977) narrows a LISTING by
    // the same reference; two spellings of "carries this entity" could disagree about a colon in a
    // name and each would look correct alone.
    const scope = assembleScope({ entity: ENTITY })
    expect(scope.holes.fileFilter).toContain("EXISTS (SELECT 1 FROM file_entities e")
    expect(scope.holes.fileFilter).toContain("e.path = {alias}.path")
    expect(scope.params).toEqual([ENTITY])
  })

  it("PARENTHESIZES the type:name concatenation rather than trusting operator precedence", () => {
    /**
     * A shape assertion by necessity. The comparison rebuilds the reference from two columns, and an
     * unparenthesized `e.entity_type || ':' || e.entity_name = ?` is the kind of predicate that
     * returns believable rows either way on a small corpus — this repo has already shipped an
     * appended predicate whose `AND`/`OR` grouping scoped only half a disjunction while every result
     * assertion stayed green. So the STATEMENT is asserted to carry the grouping.
     */
    const filter = assembleScope({ entity: ENTITY }).holes.fileFilter
    // `lower(...)` is now what supplies the grouping, and it supplies it for the same reason the bare
    // parentheses did: the concatenation must bind tighter than the comparison.
    expect(filter).toContain("lower(e.entity_type || ':' || e.entity_name) = ")
    // And the ungrouped spelling appears nowhere, so the assertion above cannot be satisfied by a
    // statement that carries both forms.
    expect(filter).not.toContain("e.entity_type || ':' || e.entity_name = ")
  })

  it("folds case on BOTH sides, so a caller need not reproduce an author's casing", () => {
    /**
     * A caller copies a reference out of a hit's own `entities` list, or types one from memory. Comparing
     * it raw against an authored row returns an empty set from a corpus that holds the memory — a silent
     * miss, with no error and nothing pointing at spelling as the cause.
     *
     * The fold has to be on ONE side of the JS/SQL seam. JS `toLowerCase` is full-Unicode and SQLite's
     * `lower()` is ASCII-only, so folding the bound value in TypeScript and the column in SQL would make
     * a non-ASCII name match through one door and miss through the other. Both sides go through the same
     * `lower()`, and the raw spelling is what binds.
     */
    const scope = assembleScope({ entity: "Service:Checkout-API" })
    expect(scope.holes.fileFilter).toContain(
      "lower(e.entity_type || ':' || e.entity_name) = lower(?5)"
    )
    expect(scope.params).toEqual(["Service:Checkout-API"])
  })

  it("trims the reference, so padding is not part of an entity's identity", () => {
    expect(assembleScope({ entity: "  service:checkout-api  " }).params).toEqual([
      "service:checkout-api"
    ])
  })

  it("binds the reference rather than inlining it, so a name holding a quote cannot break the statement", () => {
    // Entity names are caller input — unlike EXCLUDED_BY_DEFAULT and the salience arm's literals,
    // which are this system's own rules and are inlined for exactly that reason.
    const scope = assembleScope({ entity: "person:o'brien" })
    expect(scope.params).toEqual(["person:o'brien"])
    expect(scope.holes.fileFilter).not.toContain("o'brien")
  })

  it("puts the entity condition in EVERY arm's assembled SQL, not only the fold's", () => {
    /**
     * The leak this catches is specific: an arm missing the hole would keep ranking candidates from
     * OUTSIDE the scope, RRF would sum them with the scoped arms' contributions, and the response
     * would carry a hit that does not carry the entity. No type sees that, and on a small fixture the
     * row that leaks is usually plausible.
     *
     * Checked per arm across both degradation axes, because the filter is built once and each arm
     * substitutes its own alias — the substitution is where an arm can drop it.
     */
    const scoped = assembleScope({ entity: ENTITY })
    let checked = 0
    for (const hasQueryVector of [true, false]) {
      for (const hasState of [true, false]) {
        for (const arm of activeArms({ hasQueryVector, hasState, holes: scoped.holes })) {
          const armSql = arm.sql(scoped.holes)
          checked += 1
          expect(armSql, `${arm.name} lost the entity scope`).toContain(
            "EXISTS (SELECT 1 FROM file_entities e"
          )
          expect(armSql, `${arm.name} lost the grouping`).toContain(
            "lower(e.entity_type || ':' || e.entity_name) = lower(?5)"
          )
          // The arm substituted its OWN alias into the subquery's correlation, so the predicate is
          // about the row that arm is ranking rather than about a `files` row it never reads.
          expect(armSql, `${arm.name} left {alias} unsubstituted`).not.toContain("{alias}")
        }
      }
    }
    // A guard over an empty collection reports as nothing at all rather than as a failure.
    expect(checked).toBe(12)
  })

  it("numbers the entity placeholder after every axis that can precede it", () => {
    /**
     * Placeholder numbering is a contract with the RRF assembler (`?5` upward), and the entity
     * condition is assembled LAST — so its number is a function of how many values every other axis
     * bound. A shifted number does not error on this driver, it reads as NULL and matches nothing,
     * which is indistinguishable from an over-narrow scope. Each combination is spelled out.
     */
    const cases: ReadonlyArray<
      readonly [Parameters<typeof assembleScope>[0], string, ReadonlyArray<string>]
    > = [
      [{ entity: ENTITY }, "?5", [ENTITY]],
      [{ memoryTypes: ["semantic"], entity: ENTITY }, "?6", ["semantic", ENTITY]],
      [{ workspace: "memhtml", entity: ENTITY }, "?6", ["memhtml", ENTITY]],
      [{ tags: ["deploy", "oncall"], entity: ENTITY }, "?7", ["deploy", "oncall", ENTITY]],
      [
        {
          memoryTypes: ["semantic", "arc"],
          workspace: "memhtml",
          tags: ["deploy"],
          entity: ENTITY
        },
        "?9",
        ["semantic", "arc", "memhtml", "deploy", ENTITY]
      ]
    ]
    for (const [scope, placeholder, params] of cases) {
      const assembled = assembleScope(scope)
      expect(
        assembled.holes.fileFilter,
        `entity placeholder for ${JSON.stringify(scope)}`
      ).toContain(`lower(e.entity_type || ':' || e.entity_name) = lower(${placeholder})`)
      // The VALUE at that position, not just the number: params is positional, so agreeing on the
      // number while disagreeing on the order would bind a tag where the entity belongs.
      expect(assembled.params).toEqual(params)
      expect(assembled.params.at(-1)).toBe(ENTITY)
    }
  })

  it("leaves the filter entity-free when no entity is named, and when an empty string is", () => {
    // The empty string reaches here from a CLI flag nobody passed and from an MCP client sending the
    // key with no value; both mean "no entity scope", and binding it would narrow to nothing.
    for (const scope of [
      assembleScope(),
      assembleScope({ entity: "" }),
      assembleScope({ tags: ["deploy"] })
    ]) {
      expect(scope.holes.fileFilter).not.toContain("file_entities")
      expect(scope.params).not.toContain("")
    }
  })

  it("scopes by entity independently of the tag axis, sharing neither alias nor subquery", () => {
    // Both are EXISTS subqueries over a side table, so an alias collision would make one silently
    // correlate against the other's row.
    const filter = assembleScope({ tags: ["deploy"], entity: ENTITY }).holes.fileFilter
    expect(filter).toContain("FROM file_tags ft")
    expect(filter).toContain("FROM file_entities e")
    expect(filter).toContain("ft.tag IN (?5)")
    expect(filter).toContain("lower(e.entity_type || ':' || e.entity_name) = lower(?6)")
  })
})
