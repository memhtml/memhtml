import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { ModelUnavailable } from "@memhtml/contracts/errors"
import { vectorTextOf } from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { EmbedderShape } from "../src/api-layer.js"
import { askHead } from "../src/head-client.js"
import { HeadServerStatus, SearchAnswer } from "../src/head-protocol.js"
import {
  type HeadServer,
  type HeadServerInput,
  startHeadServer,
  WARMUP_TEXT
} from "../src/head-server.js"
import { loadForSearch } from "../src/head-vectors.js"
import { run } from "../src/run.js"
import { headSearch, loadHeadAt } from "../src/v2.js"
import { fakeEmbedder, fakeVector } from "./harness.js"

/**
 * The head server's embed path (`docs/v2-poc.md`, "Head server"): the query embed's deadline, the
 * one late embed it lets finish, the warmup that keeps the path to the proxy warm, and the
 * background fill that embeds what a commit brought. Every embedder here is a fake that sleeps, so
 * a deadline is checked against the wall clock of a real socket round trip and nothing reaches a
 * model.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `head-vectors.ts` `embedWithin`: await the embed (`Effect.result(embed)`) instead of racing the
 *   join against the deadline -> "answers at its deadline with the lexical hits" (the answer takes
 *   the embed's full 1.5 s).
 * - `head-server.ts` `late`: drop the `lateInFlight >= LATE_EMBEDS_MAX` branch -> "lets one late
 *   embed finish and stops the rest" (three embeds keep running, none stopped).
 * - `head-server.ts` warmup: drop the `activity.inFlight > 0` check -> "warms after idle, never
 *   while an embed is in flight" (a warmup fires while the slow search embed runs).
 * - `head-server.ts` warmup: drop the `idleFor < warmIdleMs` sleep -> "does not warm while
 *   searches keep the path busy" (warmups pile up between the searches).
 * - `head-server.ts` warmup: fork the timer with `Effect.forkDetach` instead of into the server's
 *   scope -> "stops the warmup timer and a finishing late embed when it closes" (the fake keeps
 *   being called after the scope closed).
 * - `head-server.ts` `advance`: drop `yield* startBackfill` -> "embeds a committed record in the
 *   background, into the file too" (`pending` stays 1).
 * - `head-server.ts` warmup: drop the `backfill.lastError !== null` retry -> "keeps searching while
 *   the fill fails, and retries it on the warmup tick" (`pending` stays 1 after the embedder
 *   recovers).
 * - `head-server.ts` `startBackfill`: drop the `backfill.running` early return -> "never embeds a
 *   record twice under concurrent advances" (nine texts embedded for four records).
 * - `head-server.ts` `late`: fork the watcher without `startImmediately` -> "stops the warmup timer
 *   and a finishing late embed when it closes" (a scope closed before the watcher's first step
 *   interrupts it before its `ensuring` exists, so the embed runs on).
 * - `head-server.ts` warmup: drop the `!vectors.read.ok` check -> "never warms a store with no
 *   vector cache" (four warmups).
 * - `head-vectors.ts` `stopLateEmbed`: answer `stopped` without interrupting -> "bounds the local
 *   path too, stopping the embed it leaves" (the embed is never interrupted).
 */

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const repos: Array<FixtureRepo> = []
const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => run_(Scope.close(scope, Exit.void))))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const WORDS = ["harbor", "glacier", "orchard", "furnace", "lantern", "compass"]

const memory = (word: string, claim?: string) => ({
  path: `areas/inbox/${word}.html`,
  html: renderTemplate({
    title: word,
    claim: claim ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)} facts are recorded here.`,
    memoryType: "semantic",
    at: "2026-03-01T12:00:00Z",
    entities: ["system:fixture"]
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
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", message]))
  const sha = await run_(repo.git.revParseHead())
  if (sha === null) throw new Error("no HEAD")
  return sha
}

/** A corpus with its vector cache written by `head embed`, so the arm can run. */
const embeddedCorpus = async (): Promise<FixtureRepo> => {
  const repo = await run_(makeFixtureRepo())
  repos.push(repo)
  await commit(
    repo,
    WORDS.map((word) => memory(word)),
    "corpus"
  )
  const embedded = await run(
    ["head", "embed", "--repo", repo.root],
    undefined,
    undefined,
    false,
    fakeEmbedder()
  )
  expect(embedded.exitCode).toBe(0)
  return repo
}

/** A server in its own scope, closed after the test unless the test closes it first. */
const serve = async (
  root: string,
  embedder: EmbedderShape,
  options: Partial<HeadServerInput> = {}
): Promise<{ server: HeadServer; scope: Scope.Closeable }> => {
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  const server = await run_(
    startHeadServer({ root, pollMs: 0, embedder, warmIdleMs: 0, ...options }).pipe(
      Scope.provide(scope)
    )
  )
  return { server, scope }
}

/**
 * The deterministic embedder behind a sleep, counting what it was asked. `queryMs` and `documentMs`
 * are read on every call, so a test can slow or speed the fake mid-run, and `failDocuments` makes
 * the document port fail while it is true.
 */
const slowEmbedder = (options: { queryMs?: number; documentMs?: number } = {}) => {
  const state = {
    queryMs: options.queryMs ?? 0,
    documentMs: options.documentMs ?? 0,
    failDocuments: false,
    queries: [] as Array<string>,
    documents: [] as Array<string>,
    running: 0,
    maxRunning: 0,
    interrupted: 0
  }
  const timed = <A>(ms: number, value: () => A): Effect.Effect<A, ModelUnavailable> =>
    Effect.suspend(() => {
      state.running += 1
      state.maxRunning = Math.max(state.maxRunning, state.running)
      return Effect.sleep(ms).pipe(
        Effect.map(value),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            state.interrupted += 1
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            state.running -= 1
          })
        )
      )
    })
  const embedder: EmbedderShape = {
    document: {
      embed: (texts) =>
        Effect.suspend(() => {
          if (state.failDocuments) {
            return Effect.fail(
              ModelUnavailable.make({ modelId: "fake", reason: "the fake is down" })
            )
          }
          state.documents.push(...texts)
          return timed(state.documentMs, () => texts.map(fakeVector))
        })
    },
    query: {
      embedQuery: (text) =>
        Effect.suspend(() => {
          state.queries.push(text)
          return timed(text === WARMUP_TEXT ? 0 : state.queryMs, () => fakeVector(text))
        })
    }
  }
  return { embedder, state }
}

const search = (root: string, body: { query: string; embedDeadlineMs?: number }) =>
  run_(askHead({ root, route: "search", schema: SearchAnswer, body }))

const status = async (root: string) => {
  const answered = await run_(askHead({ root, route: "status", schema: HeadServerStatus }))
  if (answered === null) throw new Error("no status")
  return answered.data
}

/** Poll `check` until it holds or `ms` pass; the last value either way. */
const until = async <A>(ms: number, read: () => Promise<A> | A, check: (value: A) => boolean) => {
  const deadline = Date.now() + ms
  let value = await read()
  while (!check(value) && Date.now() < deadline) {
    await sleep(25)
    value = await read()
  }
  return value
}

describe("the query embed's deadline", () => {
  it("answers at its deadline with the lexical hits, and names the timeout", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder({ queryMs: 1500 })
    await serve(repo.root, embedder)
    const started = Date.now()
    const answered = await search(repo.root, { query: "orchard facts", embedDeadlineMs: 150 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(150 + 250)
    expect(answered?.data.vector).toMatchObject({
      used: false,
      reason: "embed-timeout",
      cached: WORDS.length,
      coverage: 1
    })
    expect(answered?.data.vector.detail).toContain("left to finish in the background")
    expect(answered?.data.vector.embedMs).toBeGreaterThanOrEqual(150)
    expect(answered?.data.hits[0]?.path).toBe("areas/inbox/orchard.html")
    expect(answered?.data.hits[0]?.arms).toEqual(["lexical"])
    expect(state.queries).toEqual(["orchard facts"])
    expect((await status(repo.root)).embed).toMatchObject({
      timeouts: 1,
      lateKept: 1,
      lateStopped: 0,
      lateInFlight: 1
    })
  })

  it("applies the server's own deadline to a request that names none, and 0 waits it out", async () => {
    const repo = await embeddedCorpus()
    const { embedder } = slowEmbedder({ queryMs: 400 })
    await serve(repo.root, embedder, { embedDeadlineMs: 100 })
    expect((await status(repo.root)).embed.deadlineMs).toBe(100)
    const bounded = await search(repo.root, { query: "orchard facts" })
    expect(bounded?.data.vector.reason).toBe("embed-timeout")
    const unbounded = await search(repo.root, { query: "orchard facts", embedDeadlineMs: 0 })
    expect(unbounded?.data.vector).toMatchObject({ used: true, reason: null })
    expect(unbounded?.data.vector.embedMs).toBeGreaterThanOrEqual(400)
  })

  it("lets one late embed finish and stops the rest", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder({ queryMs: 1000 })
    const { server } = await serve(repo.root, embedder)
    const answers = await Promise.all(
      ["orchard facts", "harbor facts", "glacier facts"].map((query) =>
        search(repo.root, { query, embedDeadlineMs: 60 })
      )
    )
    for (const answer of answers) expect(answer?.data.vector.reason).toBe("embed-timeout")
    const embed = (await status(repo.root)).embed
    expect(embed).toMatchObject({ timeouts: 3, lateKept: 1, lateStopped: 2 })
    const settled = await until(
      500,
      () => state.running,
      (running) => running === 1
    )
    expect(settled).toBe(1)
    expect(state.interrupted).toBe(2)
    // The one kept finishes and frees its slot with no request arriving to drive it.
    const freed = await until(
      1500,
      () => server.stats().embed.lateInFlight,
      (count) => count === 0
    )
    expect(freed).toBe(0)
    expect(state.running).toBe(0)
    expect(state.interrupted).toBe(2)
  })

  it("bounds the local path too, stopping the embed it leaves", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder({ queryMs: 1500 })
    const started = Date.now()
    const answered = await run_(
      headSearch({
        root: repo.root,
        query: "orchard facts",
        embedder,
        server: false,
        embedDeadlineMs: 120
      })
    )
    expect(Date.now() - started).toBeLessThan(1500)
    expect(answered.vector).toMatchObject({ used: false, reason: "embed-timeout" })
    expect(answered.vector.detail).toContain("stopped")
    expect(answered.hits[0]?.path).toBe("areas/inbox/orchard.html")
    await until(
      500,
      () => state.interrupted,
      (count) => count === 1
    )
    expect(state.interrupted).toBe(1)
  })

  it("refuses a malformed MEMHTML_EMBED_DEADLINE_MS at exit 2 and a negative body field with 400", async () => {
    const repo = await embeddedCorpus()
    const before = process.env.MEMHTML_EMBED_DEADLINE_MS
    process.env.MEMHTML_EMBED_DEADLINE_MS = "soon"
    try {
      const refused = await run(["head", "search", "orchard", "--repo", repo.root])
      expect(refused.exitCode).toBe(2)
      expect(JSON.parse(refused.stdout)).toMatchObject({ code: "ERR_INVALID_FLAG" })
      expect(refused.stdout).toContain("MEMHTML_EMBED_DEADLINE_MS")
    } finally {
      if (before === undefined) delete process.env.MEMHTML_EMBED_DEADLINE_MS
      else process.env.MEMHTML_EMBED_DEADLINE_MS = before
    }
    const { embedder } = slowEmbedder()
    await serve(repo.root, embedder)
    const negative = await run_(
      askHead({
        root: repo.root,
        route: "search",
        schema: SearchAnswer,
        body: { query: "orchard", embedDeadlineMs: -1 }
      })
    )
    // A refused body is a non-200, which the client reads as no server.
    expect(negative).toBeNull()
  })
})

describe("the warmup", () => {
  it("warms at start and after idle, never while an embed is in flight", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder({ queryMs: 700 })
    await serve(repo.root, embedder, { warmIdleMs: 200 })
    const warmups = () => state.queries.filter((text) => text === WARMUP_TEXT).length
    // No embed has happened yet, so the first warmup runs as soon as the server listens.
    expect(await until(500, warmups, (count) => count >= 1)).toBe(1)

    // A search with no deadline holds an embed in flight for 700 ms, past the 200 ms idle bound.
    const searching = search(repo.root, { query: "orchard facts", embedDeadlineMs: 0 })
    await sleep(550)
    expect(state.running).toBe(1)
    expect(warmups()).toBe(1)
    await searching
    // Idle again: the next warmup comes about 200 ms after that embed ended.
    expect(await until(800, warmups, (count) => count >= 2)).toBe(2)
    const embed = (await status(repo.root)).embed
    expect(embed).toMatchObject({ warmIdleMs: 200, warmups: 2, warmupFailures: 0, inFlight: 0 })
    expect(embed.lastWarmupMs).not.toBeNull()
  })

  it("does not warm while searches keep the path busy", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder()
    await serve(repo.root, embedder, { warmIdleMs: 300 })
    const warmups = () => state.queries.filter((text) => text === WARMUP_TEXT).length
    expect(await until(500, warmups, (count) => count >= 1)).toBe(1)
    const ends = Date.now() + 1200
    while (Date.now() < ends) {
      await search(repo.root, { query: "orchard facts" })
      await sleep(100)
    }
    expect(warmups()).toBe(1)
    expect((await status(repo.root)).embed.warmups).toBe(1)
  })

  it("never warms a store with no vector cache", async () => {
    const repo = await run_(makeFixtureRepo())
    repos.push(repo)
    await commit(repo, [memory("orchard")])
    const { embedder, state } = slowEmbedder()
    await serve(repo.root, embedder, { warmIdleMs: 100 })
    await sleep(400)
    expect(state.queries).toEqual([])
    expect((await status(repo.root)).embed.warmups).toBe(0)
  })

  it("stops the warmup timer and a finishing late embed when it closes", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder({ queryMs: 2000 })
    const { scope } = await serve(repo.root, embedder, { warmIdleMs: 100 })
    const answered = await search(repo.root, { query: "orchard facts", embedDeadlineMs: 50 })
    expect(answered?.data.vector.reason).toBe("embed-timeout")
    expect(state.running).toBe(1)
    await run_(Scope.close(scope, Exit.void))
    expect(state.running).toBe(0)
    expect(state.interrupted).toBe(1)
    const calls = state.queries.length
    await sleep(500)
    expect(state.queries.length).toBe(calls)
  })
})

describe("the background fill", () => {
  it("embeds a committed record in the background, into the file too", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder()
    const { server } = await serve(repo.root, embedder)
    const before = await status(repo.root)
    expect(before.vectors).toMatchObject({ pending: 0, loads: 1 })

    await commit(repo, [memory("quarry", "Quarry stone is cut in winter.")])
    // The next request advances; the fill runs after it, off the request's path, with no further
    // request arriving to drive it.
    await search(repo.root, { query: "quarry stone" })
    const after = await until(
      2000,
      () => server.stats(),
      (now) => now.vectors.pending === 0
    )
    expect(after.vectors).toMatchObject({
      pending: 0,
      entries: WORDS.length + 1,
      coverage: 1,
      // The server recorded the file it wrote rather than reading it back.
      loads: 1,
      backfill: { running: false, embedded: 1, batches: 1, failures: 0, lastError: null }
    })
    const quarry = (await run_(loadHeadAt(repo.root, after.sha))).view.get(
      "areas/inbox/quarry.html"
    )
    if (quarry === undefined) throw new Error("no quarry record")
    expect(state.documents).toEqual([vectorTextOf(quarry)])
    const onDisk = await run_(loadForSearch(repo.root))
    expect(onDisk.ok && onDisk.cache.vectors.has(quarry.contentHash)).toBe(true)
    const found = await search(repo.root, { query: "quarry stone" })
    expect(found?.data.hits[0]?.path).toBe("areas/inbox/quarry.html")
    expect(found?.data.hits[0]?.arms).toContain("vector")
  })

  it("keeps searching while the fill fails, and retries it on the warmup tick", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder()
    state.failDocuments = true
    const { server } = await serve(repo.root, embedder, { warmIdleMs: 150 })
    await commit(repo, [memory("quarry", "Quarry stone is cut in winter.")])
    const started = Date.now()
    const answered = await search(repo.root, { query: "quarry stone" })
    expect(Date.now() - started).toBeLessThan(1000)
    // Found by the lexical arm alone until it has a vector, so not necessarily first.
    expect(answered?.data.hits.map((hit) => hit.path)).toContain("areas/inbox/quarry.html")
    const failed = await until(
      1000,
      () => server.stats(),
      (now) => now.vectors.backfill.failures >= 1
    )
    expect(failed.vectors).toMatchObject({ pending: 1 })
    expect(failed.vectors.backfill.lastError).toContain("the fake is down")

    state.failDocuments = false
    const recovered = await until(
      2000,
      () => server.stats(),
      (now) => now.vectors.pending === 0
    )
    expect(recovered.vectors).toMatchObject({
      pending: 0,
      backfill: { embedded: 1, lastError: null }
    })
    // No commit landed after the failure: the retry came from the warmup timer.
    expect(recovered.advances).toBe(1)
  })

  it("never embeds a record twice under concurrent advances", async () => {
    const repo = await embeddedCorpus()
    const { embedder, state } = slowEmbedder({ documentMs: 500 })
    const { server } = await serve(repo.root, embedder)
    const words = ["quarry", "saddle", "turbine", "velvet"]
    for (const word of words) {
      await commit(repo, [memory(word, `${word} is a new record about ${word}.`)])
      await Promise.all(Array.from({ length: 6 }, () => status(repo.root)))
    }
    const done = await until(
      5000,
      () => server.stats(),
      (now) => now.vectors.pending === 0 && !now.vectors.backfill.running
    )
    expect(done.vectors.pending).toBe(0)
    expect(state.documents).toHaveLength(words.length)
    expect(new Set(state.documents).size).toBe(words.length)
    expect(done.vectors.backfill.embedded).toBe(words.length)
  })
})
