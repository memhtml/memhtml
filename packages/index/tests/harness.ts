import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ModelUnavailable } from "@memhtml/contracts/errors"
import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { Effect } from "effect"

import { type DatabaseShape, makeDatabase, splitStatements } from "../src/database.js"
import type { EmbedPort } from "../src/indexer.js"
import type { QueryEmbedPort } from "../src/retrieval.js"
import { MIGRATIONS_DIR, STATE_MIGRATIONS_DIR } from "../src/schema-const.js"

/**
 * The integration harness: a real in-memory Turso carrying both planes, the real migrations, and a
 * deterministic embedder.
 *
 * Nothing here is a fake of the database. The migrations are the shipped SQL and the driver is the
 * shipped driver, because what these tests assert — a partial unique index refusing a duplicate, a
 * cascade reaching an embedding, MATCH order surviving a `ROW_NUMBER()` window — are facts about SQL
 * and the driver, and a fake would confirm the shape of the calls while the behavior went untested.
 */

/** Run a scoped program against a fresh database with both planes attached. */
export const withDb = <A, E>(body: (db: DatabaseShape) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase(":memory:", MIGRATIONS_DIR, {
          path: ":memory:",
          migrationsDir: STATE_MIGRATIONS_DIR
        })
        return yield* body(db)
      })
    )
  )

/** The index plane alone, for a test that must prove a state-reading arm is dropped when it is absent. */
export const withDbNoState = <A, E>(body: (db: DatabaseShape) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase(":memory:", MIGRATIONS_DIR)
        return yield* body(db)
      })
    )
  )

/**
 * Every migration filename in order. Read from disk rather than listed, so a new migration is
 * covered by an upgrade test without an edit here.
 */
export const migrationNames = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort()

/**
 * How many migrations sit after `through` — what {@link withDbThrough}'s `apply` returns.
 *
 * Derived rather than written down, because the literal is not the fact the test is about. An upgrade
 * test asserts that the PENDING migrations ran; the count of them is incidental, and hard-coding it
 * means every new migration file fails three unrelated upgrade tests with an off-by-one that reads
 * like a real regression. (It did exactly that when 0010 landed.)
 */
export const migrationsAfter = async (through: string): Promise<number> =>
  (await migrationNames()).filter((name) => name > through).length

/**
 * A database migrated only as far as `through` (inclusive), so a test can seed the PRE-upgrade
 * schema and then apply one migration over real rows.
 *
 * The pending migrations are hidden by copying the directory and deleting them, rather than by a
 * parameter on the runner: the runner applies whatever the directory holds, and a test-only "stop
 * here" option would be a second code path in the thing under test. `apply` then runs the real
 * `runMigrations` over the real files, in the real one-`immediate`-batch-per-file shape — which is
 * the shape that decides whether a `DROP TABLE`'s cascade is contained.
 */
export const withDbThrough = <A, E>(
  through: string,
  body: (db: DatabaseShape, apply: () => Promise<number>) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const all = yield* Effect.promise(() => migrationNames())
        const staged = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const dir = await mkdtemp(join(tmpdir(), "memhtml-migrations-"))
            for (const name of all.filter((candidate) => candidate <= through)) {
              await copyFile(join(MIGRATIONS_DIR, name), join(dir, name))
            }
            return dir
          }),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
        )

        const db = yield* makeDatabase(":memory:", staged, {
          path: ":memory:",
          migrationsDir: STATE_MIGRATIONS_DIR
        })

        /**
         * Apply the migrations after `through`, in order, each as ONE atomic batch.
         *
         * `writeAll` rather than a `run` per statement, because that is what the migration runner
         * does — one `db.batch(…, "immediate")` per file. Whether a `DROP TABLE`'s cascade is
         * contained by that transaction is exactly the kind of fact a per-statement loop would
         * answer differently, and the answer here has to be the production one.
         */
        const apply = async (): Promise<number> => {
          const pending = all.filter((name) => name > through)
          for (const name of pending) {
            const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8")
            await Effect.runPromise(
              db.writeAll(splitStatements(sql).map((statement) => ({ sql: statement, params: [] })))
            )
          }
          return pending.length
        }

        return yield* body(db, apply)
      })
    )
  )

/** How many vector components the fake embedder produces. */
export const FAKE_DIM = EMBED_DIM

/**
 * A deterministic, hash-seeded embedder whose cosine relations are ASSERTABLE.
 *
 * A random fake makes cosine assertions untestable and a constant fake makes every pair identical, so
 * neither can be used to check that the vector arm ranks anything. This one is a bag-of-words model:
 * each token hashes to a component index and contributes there, then the vector is L2-normalized. Two
 * texts sharing vocabulary therefore have a genuinely high cosine and two disjoint texts a low one —
 * the property the ranking tests need — while the mapping stays a pure function of the text, so a run
 * on another machine produces the same numbers.
 */
export const fakeVector = (text: string): Float32Array => {
  const vector = new Float32Array(FAKE_DIM)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const token of tokens) {
    const digest = createHash("sha256").update(token, "utf8").digest()
    // Two components per token, both derived from the same digest: one index is a token identity, and
    // a single component per token would make any two texts sharing one word collide too strongly.
    const first = digest.readUInt32BE(0) % FAKE_DIM
    const second = digest.readUInt32BE(4) % FAKE_DIM
    vector[first] = (vector[first] ?? 0) + 1
    vector[second] = (vector[second] ?? 0) + 0.5
  }
  let norm = 0
  for (const component of vector) norm += component * component
  if (norm === 0) return vector
  const scale = 1 / Math.sqrt(norm)
  for (let at = 0; at < vector.length; at += 1) vector[at] = (vector[at] ?? 0) * scale
  return vector
}

/** The deterministic embedder as both ports, plus a call counter so a test can assert zero calls. */
export interface FakeEmbedder extends EmbedPort, QueryEmbedPort {
  readonly calls: () => number
  readonly textsEmbedded: () => ReadonlyArray<string>
}

export const makeFakeEmbedder = (): FakeEmbedder => {
  let calls = 0
  const texts: Array<string> = []
  return {
    embed: (input) =>
      Effect.sync(() => {
        calls += 1
        texts.push(...input)
        return input.map(fakeVector)
      }),
    embedQuery: (text) =>
      Effect.sync(() => {
        calls += 1
        return fakeVector(text)
      }),
    calls: () => calls,
    textsEmbedded: () => texts
  }
}

/**
 * An embedder that always fails, for the degradation path.
 *
 * The failure must be a typed `ModelUnavailable`, not a thrown error: the whole point of the lexical
 * floor is that a Bedrock outage narrows retrieval instead of failing it, and that only holds if the
 * failure travels through the error channel the caller catches.
 */
export const failingEmbedder = (): FakeEmbedder => ({
  embed: () =>
    Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "fake outage" })),
  embedQuery: () =>
    Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "fake outage" })),
  calls: () => 0,
  textsEmbedded: () => []
})

/** What {@link memoryHtml} needs to build a valid file. */
export interface MemoryFixture {
  readonly title: string
  readonly claim: string
  readonly body?: string | undefined
  readonly memoryType?: string | undefined
  readonly createdAt?: string | undefined
  readonly updatedAt?: string | undefined
  readonly confidence?: string | undefined
  readonly importance?: string | undefined
  readonly entities?: ReadonlyArray<string> | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  readonly links?: ReadonlyArray<{ readonly rel: string; readonly href: string }> | undefined
  readonly status?: "active" | "archived" | undefined
  readonly archivedAt?: string | undefined
  readonly eventAt?: string | undefined
  readonly facets?:
    | ReadonlyArray<{ readonly name: string; readonly value: string; readonly dataValue?: string }>
    | undefined
  readonly citations?: ReadonlyArray<string> | undefined
  readonly definedTerms?: ReadonlyArray<string> | undefined
  /** `<figure><pre><code>` blocks, each with its optional `data-lang` value. */
  readonly codeBlocks?: ReadonlyArray<{ readonly code: string; readonly lang?: string }> | undefined
  readonly details?: { readonly summary: string; readonly body: string } | undefined
  readonly aside?: string | undefined
  readonly sessionId?: string | undefined
  readonly taskStatus?: string | undefined
  readonly dueAt?: string | undefined
}

/**
 * A valid memory file as bytes.
 *
 * Hand-written rather than produced by `@memhtml/html`'s template, and deliberately so: these are the
 * INPUT to the parser under test, and generating them with the same package that parses them would
 * let a template-and-parser pair agree on something the format does not say. The fixtures follow
 * `docs/format.md` directly.
 */
export const memoryHtml = (fixture: MemoryFixture): string => {
  const at = fixture.createdAt ?? "2026-08-01T00:00:00Z"
  const metas = [
    `<meta name="memhtml-type" content="${fixture.memoryType ?? "semantic"}">`,
    `<meta name="memhtml-status" content="${fixture.status ?? "active"}">`,
    `<meta name="memhtml-created" content="${at}">`,
    `<meta name="memhtml-updated" content="${fixture.updatedAt ?? at}">`,
    ...(fixture.confidence === undefined
      ? []
      : [`<meta name="memhtml-confidence" content="${fixture.confidence}">`]),
    ...(fixture.importance === undefined
      ? []
      : [`<meta name="memhtml-importance" content="${fixture.importance}">`]),
    ...(fixture.archivedAt === undefined
      ? []
      : [`<meta name="memhtml-archived" content="${fixture.archivedAt}">`]),
    ...(fixture.sessionId === undefined
      ? []
      : [`<meta name="memhtml-session" content="${fixture.sessionId}">`]),
    ...(fixture.taskStatus === undefined
      ? []
      : [`<meta name="memhtml-task-status" content="${fixture.taskStatus}">`]),
    ...(fixture.dueAt === undefined
      ? []
      : [`<meta name="memhtml-due" content="${fixture.dueAt}">`]),
    ...(fixture.entities ?? []).map((entity) => `<meta name="memhtml-entity" content="${entity}">`),
    ...(fixture.tags ?? []).map((tag) => `<meta name="memhtml-tag" content="${tag}">`),
    ...(fixture.links ?? []).map((link) => `<link rel="${link.rel}" href="${link.href}">`)
  ]

  const time =
    fixture.eventAt === undefined
      ? ""
      : ` Observed on <time datetime="${fixture.eventAt}">then</time>.`
  const facets =
    fixture.facets === undefined || fixture.facets.length === 0
      ? ""
      : `\n<dl>\n${fixture.facets
          .map(
            (facet) =>
              `<dt>${facet.name}</dt><dd>${
                facet.dataValue === undefined
                  ? facet.value
                  : `<data value="${facet.dataValue}">${facet.value}</data>`
              }</dd>`
          )
          .join("\n")}\n</dl>`
  const citations =
    fixture.citations === undefined || fixture.citations.length === 0
      ? ""
      : `\n<p>${fixture.citations.map((text) => `<cite>${text}</cite>`).join(" ")}</p>`
  const terms =
    fixture.definedTerms === undefined || fixture.definedTerms.length === 0
      ? ""
      : `\n<p>${fixture.definedTerms.map((term) => `<dfn>${term}</dfn>`).join(" ")} defined.</p>`
  const codeBlocks =
    fixture.codeBlocks === undefined || fixture.codeBlocks.length === 0
      ? ""
      : `\n${fixture.codeBlocks
          .map(
            (block) =>
              `<figure><pre><code${
                block.lang === undefined ? "" : ` data-lang="${block.lang}"`
              }>${block.code}</code></pre></figure>`
          )
          .join("\n")}`
  const details =
    fixture.details === undefined
      ? ""
      : `\n<details>\n<summary>${fixture.details.summary}</summary>\n<p>${fixture.details.body}</p>\n</details>`
  const aside = fixture.aside === undefined ? "" : `\n<aside>\n<p>${fixture.aside}</p>\n</aside>`
  const body = fixture.body === undefined ? "" : ` ${fixture.body}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${fixture.title}</title>
${metas.join("\n")}
</head>
<body>
<article>
<p><mark>${fixture.claim}</mark>${body}${time}</p>${facets}${citations}${terms}${codeBlocks}${details}${aside}
</article>
</body>
</html>
`
}
