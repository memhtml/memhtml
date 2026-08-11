import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type EmbedderShape, layerAppWith, type RunResult, run } from "@memhtml/cli"
import { ModelUnavailable } from "@memhtml/contracts/errors"
import { EMBED_DIM, EMBED_WATERMARK, type ModelClientShape } from "@memhtml/llm"
import { makeGit } from "@memhtml/store"
import { configureIdentity } from "@memhtml/store/testing"
import { Effect, type Layer } from "effect"

/**
 * The cross-package harness: a real temp git repo, real migrations on an on-disk Turso, the real layer
 * graph, and a deterministic embedder.
 *
 * `layerAppWith` is the SAME `layerCore` production builds, with only the two network edges
 * substituted. That is the point of this tier: a stateless fake verifies the shape of a call and
 * misses the state semantics behind it, and every contract here is about state crossing planes — a
 * file in git, a row in SQL, a vector on that row's chunk, a sidecar in a commit.
 *
 * The database is ON DISK rather than `:memory:`, because it has to be: `layerDatabase` opens
 * `<repo>/.memhtml/index.db` and every command in one test must see the last one's writes. An in-memory
 * database per layer build would make `write` then `search` two empty corpora.
 */

/** The vector width the fake produces. The real one, so a width check cannot pass by accident. */
export const FAKE_DIM = EMBED_DIM

/**
 * The deterministic embedder: a hash-seeded bag of words, L2-normalized.
 *
 * The same construction every other package's harness uses, so a cosine relationship asserted here
 * holds in `@memhtml/index`'s and `@memhtml/sleep`'s suites too. Two texts sharing vocabulary have a genuinely
 * high cosine and two disjoint texts a low one — the property a ranking assertion needs, which neither
 * a random nor a constant fake has.
 */
export const fakeVector = (text: string): Float32Array => {
  const vector = new Float32Array(FAKE_DIM)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const token of tokens) {
    const digest = createHash("sha256").update(token, "utf8").digest()
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

/** The deterministic embedder as both ports, plus a call counter. */
export const fakeEmbedder = (): EmbedderShape & { readonly calls: () => number } => {
  let calls = 0
  const port = {
    embed: (texts: ReadonlyArray<string>) =>
      Effect.sync(() => {
        calls += 1
        return texts.map(fakeVector)
      }),
    embedQuery: (text: string) =>
      Effect.sync(() => {
        calls += 1
        return fakeVector(text)
      })
  }
  return { document: port, query: port, calls: () => calls }
}

/** An embedder that always fails, through the ERROR channel so the lexical floor can catch it. */
export const failingEmbedder = (): EmbedderShape => {
  const fail = () =>
    Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "integration outage" }))
  return { document: { embed: fail }, query: { embedQuery: fail } }
}

/** A scaffolded repo plus a `run` bound to it. */
export interface Cli {
  readonly root: string
  readonly run: (argv: ReadonlyArray<string>) => Promise<RunResult>
  /** The parsed `data` of a successful envelope, or a thrown assertion on a failure. */
  readonly json: <A = Record<string, unknown>>(argv: ReadonlyArray<string>) => Promise<A>
  /** The whole envelope, whatever it is. For asserting on a failure. */
  readonly envelope: (argv: ReadonlyArray<string>) => Promise<Record<string, unknown>>
  /** Raw git plumbing against the repo, for asserting on git's own output. */
  readonly git: (...args: ReadonlyArray<string>) => Promise<string>
  readonly layer: Layer.Layer<Layer.Success<ReturnType<typeof layerAppWith>>>
  readonly cleanup: () => Promise<void>
}

/** What {@link makeCli} takes. Every field has a default. */
export interface CliOptions {
  readonly embedder?: EmbedderShape | undefined
  readonly model?: ModelClientShape | undefined
  /** An existing directory to use as the repo, for a clean-clone test that supplies its own. */
  readonly root?: string | undefined
  /** Skip `memhtml init`, for a test that wants an empty directory. */
  readonly init?: boolean | undefined
}

/**
 * A CLI over a scaffolded repo.
 *
 * `--repo` is threaded on every invocation rather than exported into the environment, because a suite
 * running in parallel would otherwise share one `MEMHTML_ROOT` and two tests would write into one corpus.
 * The flag is also the path an operator takes to run against a second repo, so it is not a test-only
 * affordance.
 *
 * `memhtml init` is the REAL one — so the fixture carries the real `.gitignore`, the real
 * `.gitattributes`, and the `merge.ours.driver` config, which is per-clone and which the `merge=ours`
 * attribute is inert without.
 */
export const makeCli = async (options: CliOptions = {}): Promise<Cli> => {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "memhtml-integration-")))
  const gitService = makeGit(root)

  const raw = (...args: ReadonlyArray<string>): Promise<string> =>
    Effect.runPromise(gitService.run(args).pipe(Effect.orDie))

  if (options.init !== false) {
    await Effect.runPromise(gitService.run(["init", "-b", "main", "."]).pipe(Effect.orDie))
    await Effect.runPromise(configureIdentity(gitService))
  }

  const embedder = options.embedder ?? fakeEmbedder()
  const layer = layerAppWith({
    repo: root,
    embedder,
    ...(options.model === undefined ? {} : { model: options.model })
  })

  const invoke = (argv: ReadonlyArray<string>) => run([...argv, "--repo", root], layer)

  const cli: Cli = {
    root,
    run: invoke,
    envelope: async (argv) => JSON.parse((await invoke(argv)).stdout) as Record<string, unknown>,
    json: async <A>(argv: ReadonlyArray<string>) => {
      const result = await invoke(argv)
      const body = JSON.parse(result.stdout) as Record<string, unknown>
      if (body.error !== undefined) {
        throw new Error(
          `memhtml ${argv.join(" ")} failed: ${String(body.code)} ${String(body.error)}`
        )
      }
      return body.data as A
    },
    git: raw,
    layer,
    cleanup: () => rm(root, { recursive: true, force: true })
  }

  if (options.init !== false) await cli.json(["init"])
  return cli
}

/** A memory written through the CLI, as `memory.written` reports it. */
export interface Written {
  readonly path: string
  readonly created: boolean
  readonly deduped: boolean
  readonly existingPath: string | undefined
  readonly commitSha: string | null
  readonly contentHash: string
}

/** Write one memory, naming only what a test cares about. */
export const writeMemory = (
  cli: Cli,
  input: {
    readonly title: string
    readonly claim: string
    readonly type?: string | undefined
    readonly body?: ReadonlyArray<string> | undefined
    readonly workspace?: string | undefined
    readonly tags?: ReadonlyArray<string> | undefined
    readonly entities?: ReadonlyArray<string> | undefined
    readonly sessionId?: string | undefined
  }
): Promise<Written> =>
  cli.json<Written>([
    "write",
    "--type",
    input.type ?? "procedural",
    "--title",
    input.title,
    "--claim",
    input.claim,
    ...(input.body ?? []).flatMap((text) => ["--body", text]),
    ...(input.workspace === undefined ? [] : ["--workspace", input.workspace]),
    ...(input.tags ?? []).flatMap((tag) => ["--tag", tag]),
    ...(input.entities ?? []).flatMap((entity) => ["--entity", entity]),
    ...(input.sessionId === undefined ? [] : ["--session-id", input.sessionId])
  ])
