import { mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import type { SearchHit, SearchResult } from "@memhtml/index"
import { Effect, Exit, Scope } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { headSocketPath } from "../src/head-protocol.js"
import { MCP_HEAD_VAR, recallOnHead, routeFor, searchOnHead } from "../src/head-retrieval.js"
import { startHeadServer } from "../src/head-server.js"
import { recallMemories, type SearchParams, searchMemories } from "../src/operations.js"
import { type Cli, makeCli, noEmbedder } from "./harness.js"

/**
 * `memory_search` and `memory_recall` over the head server (`head-retrieval.ts`, `head-scope.ts`),
 * against v1's index path over the same commit, in process: one fixture repo, `index update` for the
 * index, a head server on the repo's socket, and both calls made with the same parameters.
 *
 * The index ranks with four arms, one of them recency over every record in scope, so its answer is
 * padded with records that share no word with the query; the head answers with the records an arm
 * matched. So the cases compare what the two doors say about each record the head returns (every
 * field but `score`), and state the head's set of paths outright.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `head-scope.ts` `admitFor`: never exclude by type when none is named (drop the
 *   `EXCLUDED_BY_DEFAULT` test) -> "leaves tasks out unless a type list names them".
 * - `head-scope.ts` `admitFor`: compare the scope's entity unfolded -> "scopes by entity, case
 *   folded, derived references included".
 * - `head-scope.ts` `derivedOf`: derive entities with no `<dfn>` or `<code data-lang>` -> "reports
 *   every field the index reports" and "scopes by entity".
 * - `head-scope.ts` `hitDetailOf`: `confidence: record.confidence ?? 0` -> "reports every field the
 *   index reports".
 * - `head-scope.ts` `scopeReportOf`: `empty` always false -> "points an empty scope at the archived
 *   records it still matches".
 * - `head-scope.ts` `scopeReportOf`: `supersededBy: null` for the archived pointer -> the same case.
 * - `head-retrieval.ts` `routeFor`: drop the `asOf` test -> "sends what the head cannot answer to the
 *   index".
 * - `head-server.ts` search route: drop `admit` from the `searchHead` input -> four cases, "leaves
 *   tasks out" and "scopes by workspace, tags, and facets" among them.
 */

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const AT = "2026-03-01T12:00:00Z"

const LONG_TAIL = Array.from(
  { length: 60 },
  (_, index) => `Orchard row ${String(index)} was pruned by hand.`
).join(" ")

const FILES: ReadonlyArray<{ readonly path: string; readonly html: string }> = [
  {
    path: "areas/inbox/harbor.html",
    html: renderTemplate({
      title: "Harbor cranes",
      claim: "Harbor cranes unload the ships at dawn.",
      memoryType: "semantic",
      at: AT,
      entities: ["system:port"],
      tags: ["ops"]
    })
  },
  {
    path: "areas/inbox/glacier.html",
    html: renderTemplate({
      title: "Glacier motion",
      claim: "",
      articleHtml:
        '<p><mark>A glacier moves slowly downhill.</mark> The <dfn>Firn Line</dfn> marks where snow turns to ice.</p><dl><dt>tier</dt><dd>1</dd></dl><p>Measured with <code data-lang="ts">const glacier = 1</code> in the field.</p><details><summary>How the glacier was measured</summary><p>Stakes were drilled into the ice.</p></details>',
      memoryType: "semantic",
      at: AT,
      confidence: 0.6
    })
  },
  {
    path: "projects/alpha/orchard.html",
    html: renderTemplate({
      title: "Orchard pruning",
      claim: "The orchard was pruned in February.",
      body: [LONG_TAIL],
      memoryType: "episodic",
      at: AT,
      entities: ["Person:Ana"],
      tags: ["field"]
    })
  },
  {
    path: "areas/inbox/furnace-task.html",
    html: renderTemplate({
      title: "Clean the harbor furnace",
      claim: "The harbor furnace filter needs cleaning.",
      memoryType: "task",
      at: AT
    })
  },
  {
    path: "archive/2026/areas/inbox/lantern.html",
    html: renderTemplate({
      title: "Lantern wattage",
      claim: "",
      articleHtml:
        "<p><mark>The lantern draws forty watts.</mark></p><dl><dt>tier</dt><dd>9</dd></dl>",
      memoryType: "semantic",
      at: "2026-01-01T00:00:00Z"
    })
  },
  {
    path: "areas/inbox/lantern-v2.html",
    html: renderTemplate({
      title: "Lantern wattage",
      claim: "The lantern draws sixty watts.",
      memoryType: "semantic",
      at: AT,
      links: [{ rel: "supersedes", href: "/archive/2026/areas/inbox/lantern.html" }]
    })
  }
]

let cli: Cli
const scope = Scope.makeUnsafe()

const write = async (files: ReadonlyArray<{ readonly path: string; readonly html: string }>) => {
  for (const file of files) {
    const target = join(cli.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
}

const git = async (argv: ReadonlyArray<string>) => {
  const { spawnSync } = await import("node:child_process")
  const result = spawnSync("git", ["-C", cli.root, ...argv], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${argv.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

beforeAll(async () => {
  cli = await makeCli({ embedder: noEmbedder() })
  await write(FILES)
  await git(["add", "-A"])
  await git(["commit", "-q", "-m", "fixture"])
  await cli.json(["index", "update"])
  await run_(
    startHeadServer({ root: cli.root, pollMs: 0, embedder: noEmbedder() }).pipe(
      Scope.provide(scope)
    )
  )
}, 60_000)

afterAll(async () => {
  await run_(Scope.close(scope, Exit.void))
  await cli.cleanup()
})

const onIndex = (params: SearchParams): Promise<SearchResult> =>
  run_(searchMemories(params).pipe(Effect.provide(cli.layer), Effect.orDie))

const onHead = async (params: SearchParams): Promise<SearchResult> => {
  const answer = await run_(searchOnHead(cli.root, params))
  if (answer === null) throw new Error("the head did not answer")
  return answer
}

const paths = (result: SearchResult): ReadonlyArray<string> =>
  result.hits.map((hit) => hit.path).sort()

const withoutScore = ({ score: _score, ...rest }: SearchHit) => rest

describe("memory_search on the head", () => {
  it("reports every field the index reports for the records it returns", async () => {
    for (const query of ["harbor cranes", "glacier ice", "orchard pruned", "lantern watts"]) {
      const head = await onHead({ query, limit: 20 })
      const index = await onIndex({ query, limit: 20 })
      expect(head.hits.length).toBeGreaterThan(0)
      const byPath = new Map(index.hits.map((hit) => [hit.path, hit]))
      for (const hit of head.hits) {
        const twin = byPath.get(hit.path)
        expect(twin, `${query}: ${hit.path}`).toBeDefined()
        expect(withoutScore(hit)).toEqual(withoutScore(twin as SearchHit))
      }
      // The best match leads on both doors.
      expect(head.hits[0]?.path).toBe(index.hits[0]?.path)
      const { hits: _h, arms: _a, ...headRest } = head
      const { hits: _i, arms: _b, ...indexRest } = index
      expect(headRest).toEqual(indexRest)
    }
    const glacier = (await onHead({ query: "glacier" })).hits[0]
    expect(glacier?.entities).toEqual(["concept:Firn Line", "lang:ts"])
    expect(glacier?.confidence).toBe(0.6)
    const orchard = (await onHead({ query: "orchard" })).hits[0]
    expect(orchard?.snippet.endsWith("…")).toBe(true)
    expect(orchard?.confidence).toBe(1)
  })

  it("leaves tasks out unless a type list names them", async () => {
    expect(paths(await onHead({ query: "harbor furnace" }))).toEqual(["areas/inbox/harbor.html"])
    expect(paths(await onHead({ query: "harbor furnace", memoryTypes: ["task"] }))).toEqual([
      "areas/inbox/furnace-task.html"
    ])
    const index = await onIndex({ query: "harbor furnace", memoryTypes: ["task"] })
    expect(paths(index)).toEqual(["areas/inbox/furnace-task.html"])
  })

  it("scopes by workspace, tags, and facets the way the index does", async () => {
    const cases: ReadonlyArray<[SearchParams, ReadonlyArray<string>]> = [
      [{ query: "orchard harbor", workspace: "alpha" }, ["projects/alpha/orchard.html"]],
      [{ query: "orchard harbor", tags: ["ops", " field"] }, ["areas/inbox/harbor.html"]],
      [
        { query: "glacier harbor", facets: [{ name: "tier", value: "1" }] },
        ["areas/inbox/glacier.html"]
      ]
    ]
    for (const [params, expected] of cases) {
      expect(paths(await onHead(params))).toEqual(expected)
      expect(paths(await onIndex(params))).toEqual(expected)
    }
  })

  it("scopes by entity, case folded, derived references included", async () => {
    for (const entity of ["person:ana", "PERSON:ANA"]) {
      expect(paths(await onHead({ query: "orchard glacier", entity }))).toEqual([
        "projects/alpha/orchard.html"
      ])
    }
    for (const entity of ["concept:firn line", "lang:ts"]) {
      const head = await onHead({ query: "glacier orchard", entity })
      expect(paths(head)).toEqual(["areas/inbox/glacier.html"])
      expect(paths(await onIndex({ query: "glacier orchard", entity }))).toEqual(paths(head))
      expect(head.entityScope).toBe(entity)
    }
  })

  it("points an empty scope at the archived records it still matches", async () => {
    const params = { query: "lantern", facets: [{ name: "tier", value: "9" }] }
    const head = await onHead(params)
    const index = await onIndex(params)
    expect(head.hits).toEqual([])
    expect(head.scopeEmpty).toBe(true)
    expect(head.archivedMatches).toBe(1)
    expect(head.archived).toEqual([
      {
        path: "archive/2026/areas/inbox/lantern.html",
        supersededBy: "areas/inbox/lantern-v2.html"
      }
    ])
    expect({ ...head, arms: [] }).toEqual({ ...index, arms: [] })
  })

  it("finds a record committed after the index was last updated, which the index does not", async () => {
    await write([
      {
        path: "areas/inbox/compass.html",
        html: renderTemplate({
          title: "Compass declination",
          claim: "The compass declination here is eleven degrees east.",
          memoryType: "semantic",
          at: AT
        })
      }
    ])
    await git(["add", "-A"])
    await git(["commit", "-q", "-m", "after the index"])
    const params = { query: "compass declination" }
    expect((await onHead(params)).hits[0]?.path).toBe("areas/inbox/compass.html")
    expect(paths(await onIndex(params))).not.toContain("areas/inbox/compass.html")
  })
})

describe("memory_recall on the head", () => {
  it("folds the head's candidates the way the index folds its own", async () => {
    const head = await run_(recallOnHead(cli.root, { query: "glacier", budgetChars: 10_000 }))
    const index = await run_(
      recallMemories({ query: "glacier", budgetChars: 10_000 }).pipe(
        Effect.provide(cli.layer),
        Effect.orDie
      )
    )
    if (head === null) throw new Error("the head did not answer")
    const glacierHead = head.memories.disclosed.find((entry) => entry.path.includes("glacier"))
    const glacierIndex = index.memories.disclosed.find((entry) => entry.path.includes("glacier"))
    expect(glacierHead).toEqual(glacierIndex)
    // The quote is tiers 1 and 2: the claim, the summary, the facet, never the details body.
    expect(glacierHead?.body).toContain("How the glacier was measured")
    expect(glacierHead?.body).not.toContain("Stakes were drilled")
    expect(head.degraded).toBe(index.degraded)
    // A budget too small for the quote turns it into an index line.
    const tight = await run_(recallOnHead(cli.root, { query: "glacier", budgetChars: 10 }))
    expect(tight?.memories.disclosed).toEqual([])
    expect(tight?.memories.indexLines.map((line) => line.path)).toContain(
      "areas/inbox/glacier.html"
    )
    expect(tight?.truncated).toBe(true)
  })
})

describe("routing", () => {
  it("sends what the head cannot answer to the index", () => {
    const base = { query: "harbor cranes" }
    expect(routeFor(base, {})).toEqual({ route: "head" })
    expect(routeFor({ ...base, limit: 3, workspace: "alpha", entity: "person:ana" }, {})).toEqual({
      route: "head"
    })
    expect(routeFor({ ...base, includeArchived: true }, {})).toEqual({
      route: "index",
      reason: "include-archived"
    })
    expect(routeFor({ ...base, asOf: "2026-02-01T00:00:00Z" }, {})).toEqual({
      route: "index",
      reason: "as-of"
    })
    expect(routeFor({ query: 'the "harbor cranes" note' }, {})).toEqual({
      route: "index",
      reason: "phrase"
    })
    for (const query of ["the of and", "?! --", ""]) {
      expect(routeFor({ query }, {})).toEqual({ route: "index", reason: "no-terms" })
    }
    expect(routeFor(base, { [MCP_HEAD_VAR]: "off" })).toEqual({
      route: "index",
      reason: "disabled"
    })
  })

  it("answers null with no server, and for a server that refuses the scoped body", async () => {
    const lone = await makeCli({ embedder: noEmbedder() })
    try {
      expect(await run_(searchOnHead(lone.root, { query: "harbor" }))).toBeNull()
      // An older server refuses the unknown `scope` and `detail` fields with 400.
      await mkdir(join(lone.root, ".memhtml"), { recursive: true })
      const socket = headSocketPath(lone.root)
      const refusing = createServer((_request, response) => {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "request refused", code: "ERR_INVALID_FLAG" }))
      })
      await new Promise<void>((resolve) => refusing.listen(socket, resolve))
      try {
        expect(await run_(searchOnHead(lone.root, { query: "harbor" }))).toBeNull()
        expect(await run_(recallOnHead(lone.root, { query: "harbor" }))).toBeNull()
      } finally {
        await new Promise<void>((resolve) => refusing.close(() => resolve()))
        await rm(socket, { force: true })
      }
    } finally {
      await lone.cleanup()
    }
  })
})
