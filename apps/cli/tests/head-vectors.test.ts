import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { ModelUnavailable } from "@memhtml/contracts/errors"
import { recordFrom, vectorTextOf } from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import { EMBED_WATERMARK } from "@memhtml/llm"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { EmbedderShape } from "../src/api-layer.js"
import { EXIT_OK, EXIT_RUNTIME } from "../src/envelope.js"
import { HEAD_VECTOR_SPACE, headVectorsPath } from "../src/head-vectors.js"
import { run } from "../src/run.js"
import { failingEmbedder, fakeEmbedder, fakeVector, noEmbedder } from "./harness.js"

/**
 * The vector arm through the CLI (`docs/v2-poc.md`, "Vector arm"): `head embed` filling the cache,
 * `head search` and `session put` using it, and the degraded answer each gives when it cannot. The
 * embedder is the deterministic fake `run` takes as its last argument, the same one the harness binds
 * for v1; nothing here reaches the network.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `embedHead`: drop the `ensureExcludedQuietly` call -> "head embed leaves git status clean in a
 *   store whose .gitignore predates the vector cache" (`?? .memhtml/vectors/`).
 * - `embedHead`: `const unchanged = existing !== null && filled.counts.embedded === 0` -> `const
 *   unchanged = false` -> "a second head embed embeds nothing and leaves the file alone" (`written`
 *   is true and the mtime moves).
 * - `embedHead`: drop the `port === undefined` refusal -> "head embed with the embedder off is
 *   ERR_MODEL_UNAVAILABLE and writes nothing" (a defect, `ERR_UNKNOWN`, instead).
 * - `vectorsForQuery`: drop the `port === undefined` check -> "head search with the embedder off
 *   reports embedder-off" (the search dies reading an absent port).
 * - `vectorsForQuery`: drop the `embedded._tag === "Failure"` branch -> "a failed query embed
 *   degrades the search" (the search fails instead of answering).
 * - `loadForSearch`: drop the `read._tag === "Failure"` branch -> "an unreadable cache degrades the
 *   search" (the search fails with ERR_STORAGE).
 * - `vectorsForPuts`: drop the `embedded._tag === "Failure"` branch -> "session put with a failing
 *   embedder still appends and says why the arm was skipped".
 * - `run`: resolve the v2 arms' embedder from the environment even when one is passed (drop the
 *   `embedder !== undefined` arm) -> every case that expects `used: true` (the test env sets
 *   `MEMHTML_EMBED=off`).
 */

const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const WORDS = ["harbor", "glacier", "orchard", "furnace", "lantern", "compass", "quarry", "saddle"]

const memory = (word: string, claim?: string) => ({
  path: `areas/inbox/${word}.html`,
  html: renderTemplate({
    title: word,
    claim: claim ?? `The ${word} ledger records ${word} facts for the team.`,
    memoryType: "semantic",
    entities: [`system:${word}`],
    at: "2026-03-01T12:00:00Z"
  })
})

const commit = async (
  repo: FixtureRepo,
  files: ReadonlyArray<{ readonly path: string; readonly html: string }>,
  message = "fixture"
): Promise<string> => {
  for (const file of files) {
    const target = join(repo.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await runEffect(repo.git.run(["add", "-A"]))
  await runEffect(repo.git.run(["commit", "-q", "--allow-empty", "-m", message]))
  const sha = await runEffect(repo.git.revParseHead())
  if (sha === null) throw new Error("no HEAD")
  return sha
}

const corpus = async (): Promise<FixtureRepo> => {
  const repo = await runEffect(makeFixtureRepo())
  repos.push(repo)
  await commit(
    repo,
    WORDS.map((word) => memory(word)),
    "corpus"
  )
  return repo
}

const status = (repo: FixtureRepo): Promise<string> =>
  runEffect(repo.git.run(["status", "--porcelain"])).then((out) => out.trim())

/** One CLI call over `repo` with `embedder` bound to the v2 arms. */
const cli = async (
  repo: FixtureRepo,
  argv: ReadonlyArray<string>,
  embedder: EmbedderShape
): Promise<{ readonly exitCode: number; readonly envelope: Record<string, unknown> }> => {
  const result = await run([...argv, "--repo", repo.root], undefined, undefined, false, embedder)
  return {
    exitCode: result.exitCode,
    envelope: JSON.parse(result.stdout) as Record<string, unknown>
  }
}

const data = async <A>(
  repo: FixtureRepo,
  argv: ReadonlyArray<string>,
  embedder: EmbedderShape
): Promise<A> => {
  const { exitCode, envelope } = await cli(repo, argv, embedder)
  if (exitCode !== EXIT_OK) throw new Error(`exit ${exitCode}: ${JSON.stringify(envelope)}`)
  return envelope.data as A
}

interface Embedded {
  readonly records: number
  readonly reused: number
  readonly embedded: number
  readonly empty: number
  readonly cached: number
  readonly bytes: number
  readonly written: boolean
  readonly path: string
  readonly modelId: string
  readonly dimension: number
}

interface Hit {
  readonly path: string
  readonly score: number
  readonly arms: ReadonlyArray<string>
}

interface VectorUse {
  readonly used: boolean
  readonly reason: string | null
  readonly detail: string | null
  readonly cached: number | null
  readonly coverage: number | null
}

interface Searched {
  readonly hits: ReadonlyArray<Hit>
  readonly vector: VectorUse
}

describe("head embed", () => {
  it("embeds every active record once, writes the cache for the configured space, and reuses it next time", async () => {
    const repo = await corpus()
    const embedder = fakeEmbedder()
    const first = await data<Embedded>(repo, ["head", "embed"], embedder)
    expect(first).toMatchObject({
      records: WORDS.length,
      reused: 0,
      embedded: WORDS.length,
      empty: 0,
      cached: WORDS.length,
      written: true,
      modelId: HEAD_VECTOR_SPACE.modelId,
      dimension: HEAD_VECTOR_SPACE.dimension,
      path: headVectorsPath(repo.root)
    })
    expect(first.bytes).toBe((await stat(first.path)).size)
    expect(embedder.calls()).toBe(1)
    expect(await status(repo)).toBe("")

    // One more record: only it is paid for.
    await commit(repo, [memory("velvet")], "one more")
    const second = await data<Embedded>(repo, ["head", "embed"], embedder)
    expect(second).toMatchObject({
      records: WORDS.length + 1,
      reused: WORDS.length,
      embedded: 1,
      cached: WORDS.length + 1,
      written: true
    })
    expect(embedder.calls()).toBe(2)
  })

  it("a second head embed embeds nothing and leaves the file alone", async () => {
    const repo = await corpus()
    const embedder = fakeEmbedder()
    const first = await data<Embedded>(repo, ["head", "embed"], embedder)
    const before = (await stat(first.path)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    const again = await data<Embedded>(repo, ["head", "embed"], embedder)
    expect(again).toMatchObject({ reused: WORDS.length, embedded: 0, written: false })
    expect(again.bytes).toBe(first.bytes)
    expect(embedder.calls()).toBe(1)
    expect((await stat(first.path)).mtimeMs).toBe(before)
  })

  it("head embed leaves git status clean in a store whose .gitignore predates the vector cache", async () => {
    const repo = await corpus()
    const gitignore = await readFile(join(repo.root, ".gitignore"), "utf8")
    const old = gitignore.replace(".memhtml/vectors/\n", "")
    expect(old).not.toBe(gitignore)
    await commit(repo, [{ path: ".gitignore", html: old }], "a pre-vector .gitignore")
    await data<Embedded>(repo, ["head", "embed"], fakeEmbedder())
    expect(await status(repo)).toBe("")
    const exclude = await readFile(join(repo.root, ".git", "info", "exclude"), "utf8")
    expect(exclude.split("\n")).toContain(".memhtml/vectors/")
  })

  it("head embed with the embedder off is ERR_MODEL_UNAVAILABLE and writes nothing", async () => {
    const repo = await corpus()
    const { exitCode, envelope } = await cli(repo, ["head", "embed"], noEmbedder())
    expect(exitCode).toBe(EXIT_RUNTIME)
    expect(envelope.code).toBe("ERR_MODEL_UNAVAILABLE")
    expect(String(envelope.error)).toContain("MEMHTML_EMBED=off")
    await expect(stat(headVectorsPath(repo.root))).rejects.toThrow()
  })

  it("a failed embed is ERR_MODEL_UNAVAILABLE and leaves the cache it found", async () => {
    const repo = await corpus()
    const first = await data<Embedded>(repo, ["head", "embed"], fakeEmbedder())
    const bytes = await readFile(first.path)
    await commit(repo, [memory("velvet")], "one more")
    const { exitCode, envelope } = await cli(repo, ["head", "embed"], failingEmbedder())
    expect(exitCode).toBe(EXIT_RUNTIME)
    expect(envelope.code).toBe("ERR_MODEL_UNAVAILABLE")
    expect((await readFile(first.path)).equals(bytes)).toBe(true)
  })
})

describe("head search with the vector arm", () => {
  it("with no cache the search is the two-arm search and says so", async () => {
    const repo = await corpus()
    const withEmbedder = await data<Searched>(
      repo,
      ["head", "search", "orchard ledger"],
      fakeEmbedder()
    )
    const off = await data<Searched>(repo, ["head", "search", "orchard ledger"], noEmbedder())
    expect(withEmbedder.vector).toMatchObject({ used: false, reason: "no-cache", cached: null })
    expect(off.vector).toMatchObject({ used: false, reason: "embedder-off" })
    expect(JSON.stringify(withEmbedder.hits)).toBe(JSON.stringify(off.hits))
    expect(withEmbedder.hits.some((hit) => hit.arms.includes("vector"))).toBe(false)
  })

  it("with a cache and an embedder the arm runs, over the whole head", async () => {
    const repo = await corpus()
    const embedder = fakeEmbedder()
    await data<Embedded>(repo, ["head", "embed"], embedder)
    const searched = await data<Searched>(repo, ["head", "search", "orchard ledger"], embedder)
    expect(searched.vector).toMatchObject({
      used: true,
      reason: null,
      cached: WORDS.length,
      coverage: 1
    })
    expect(searched.hits[0]?.path).toBe("areas/inbox/orchard.html")
    // Its fused score is no other hit's, so recency decided nothing about it.
    expect(searched.hits[0]?.arms).toEqual(["lexical", "vector"])
  })

  it("head search with the embedder off reports embedder-off, even with a cache", async () => {
    const repo = await corpus()
    await data<Embedded>(repo, ["head", "embed"], fakeEmbedder())
    const off = await data<Searched>(repo, ["head", "search", "orchard ledger"], noEmbedder())
    expect(off.vector).toMatchObject({ used: false, reason: "embedder-off", cached: null })
    expect(off.hits.some((hit) => hit.arms.includes("vector"))).toBe(false)
  })

  it("a failed query embed degrades the search rather than failing it", async () => {
    const repo = await corpus()
    await data<Embedded>(repo, ["head", "embed"], fakeEmbedder())
    const degraded = await cli(repo, ["head", "search", "orchard ledger"], failingEmbedder())
    expect(degraded.exitCode).toBe(EXIT_OK)
    const payload = degraded.envelope.data as Searched
    expect(payload.vector).toMatchObject({
      used: false,
      reason: "embed-failed",
      detail: "fake outage",
      cached: WORDS.length
    })
    const off = await data<Searched>(repo, ["head", "search", "orchard ledger"], noEmbedder())
    expect(JSON.stringify(payload.hits)).toBe(JSON.stringify(off.hits))
  })

  it("an unreadable cache degrades the search and names the refusal", async () => {
    const repo = await corpus()
    const path = headVectorsPath(repo.root)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "not an arrow file")
    const degraded = await cli(repo, ["head", "search", "orchard"], fakeEmbedder())
    expect(degraded.exitCode).toBe(EXIT_OK)
    expect((degraded.envelope.data as Searched).vector).toMatchObject({
      used: false,
      reason: "cache-unreadable",
      detail: "vectors.read.decode"
    })
    await rm(path)
  })

  it("reports how much of the head the cache covers after new records land", async () => {
    const repo = await corpus()
    const embedder = fakeEmbedder()
    await data<Embedded>(repo, ["head", "embed"], embedder)
    await commit(repo, [memory("velvet"), memory("anvil")], "two more")
    const searched = await data<Searched>(repo, ["head", "search", "velvet"], embedder)
    expect(searched.vector.coverage).toBeCloseTo(WORDS.length / (WORDS.length + 2), 12)
    // The new record has no vector yet, so only the lexical arm finds it. Its lexical rank 1 scores
    // exactly what the vector arm's first record scores, so the two tie and recency names both.
    const velvet = searched.hits.find((hit) => hit.path === "areas/inbox/velvet.html")
    expect(velvet?.arms).toEqual(["lexical", "recency"])
  })
})

describe("session put neighbors with the vector arm", () => {
  const putOps = async (repo: FixtureRepo, word: string): Promise<string> => {
    const file = join(dirname(repo.root), `${word}-${Date.now()}.jsonl`)
    await writeFile(
      file,
      `${JSON.stringify({
        op: "write",
        title: `${word} note`,
        type: "semantic",
        body: `The ${word} ledger records ${word} facts for the team, again.`,
        entity: `system:${word}`
      })}\n`
    )
    return file
  }

  interface Put {
    readonly appended: number
    readonly neighbors: ReadonlyArray<{ readonly path: string; readonly hits: ReadonlyArray<Hit> }>
    readonly vector: VectorUse
  }

  it("embeds each put's text as a document and ranks neighbors with the arm", async () => {
    const repo = await corpus()
    await data<Embedded>(repo, ["head", "embed"], fakeEmbedder())
    const texts: Array<ReadonlyArray<string>> = []
    // A document port that records what it was sent, and a query port that fails: a put is compared
    // as a document, so the query port must never be the one called.
    const recording: EmbedderShape = {
      document: {
        embed: (batch) =>
          Effect.sync(() => {
            texts.push([...batch])
            return batch.map(fakeVector)
          })
      },
      query: {
        embedQuery: () =>
          Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "not for puts" }))
      }
    }
    await data(repo, ["session", "start", "--id", "s1"], recording)
    const file = await putOps(repo, "orchard")
    const put = await data<Put>(repo, ["session", "put", "--id", "s1", "--file", file], recording)
    expect(put.appended).toBe(1)
    expect(put.vector).toMatchObject({ used: true, reason: null, cached: WORDS.length })
    expect(texts).toHaveLength(1)
    const log = JSON.parse(
      await readFile(join(repo.root, ".memhtml", "sessions", "s1.json"), "utf8")
    ) as { ops: ReadonlyArray<{ path: string; html: string }> }
    const record = await runEffect(
      recordFrom({
        path: log.ops[0]?.path ?? "",
        html: log.ops[0]?.html ?? ""
      })
    )
    expect(texts[0]).toEqual([vectorTextOf(record)])
    expect(put.neighbors[0]?.hits[0]?.path).toBe("areas/inbox/orchard.html")
    expect(put.neighbors[0]?.hits[0]?.arms).toContain("vector")
  })

  it("session put with no cache ranks neighbors on two arms and says why", async () => {
    const repo = await corpus()
    await data(repo, ["session", "start", "--id", "s1"], fakeEmbedder())
    const put = await data<Put>(
      repo,
      ["session", "put", "--id", "s1", "--file", await putOps(repo, "orchard")],
      fakeEmbedder()
    )
    expect(put.vector).toMatchObject({ used: false, reason: "no-cache" })
    expect(put.neighbors[0]?.hits.some((hit) => hit.arms.includes("vector"))).toBe(false)
  })

  it("session put with a failing embedder still appends and says why the arm was skipped", async () => {
    const repo = await corpus()
    await data<Embedded>(repo, ["head", "embed"], fakeEmbedder())
    await data(repo, ["session", "start", "--id", "s1"], fakeEmbedder())
    const put = await data<Put>(
      repo,
      ["session", "put", "--id", "s1", "--file", await putOps(repo, "orchard")],
      failingEmbedder()
    )
    expect(put.appended).toBe(1)
    expect(put.vector).toMatchObject({ used: false, reason: "embed-failed", detail: "fake outage" })
    expect(put.neighbors[0]?.hits.some((hit) => hit.arms.includes("vector"))).toBe(false)
  })
})
