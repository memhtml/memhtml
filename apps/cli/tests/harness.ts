import { createHash } from "node:crypto"
import { rm } from "node:fs/promises"

import {
  type EmbedderShape,
  type EntityExtractorShape,
  layerAppWith,
  type RunResult,
  run
} from "@memhtml/cli"
import { ModelUnavailable } from "@memhtml/contracts/errors"
import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, type Layer } from "effect"

/**
 * The end-to-end harness: a real temp-dir git repo, real migrations against an on-disk SQLite
 * database, the real layer graph, and a deterministic embedder.
 *
 * Nothing here is a fake of the composition. `layerAppWith` is the SAME `layerCore` production
 * builds, with only the two network edges substituted — so a test that passes proves the wiring
 * ships, which a hand-assembled test graph would not. That is the standing lesson: a stateless fake
 * verifies the shape of a call and misses the state semantics behind it, and this suite's whole
 * subject is a write landing in git, then in SQL, then being found by a search.
 *
 * The database is ON DISK rather than `:memory:`, because it has to be: `layerDatabase` opens
 * `<repo>/.memhtml/index.db`, and every command in one test must see the writes of the last. An
 * in-memory database per layer build would make `write` then `search` two empty corpora.
 */

/** The vector width the fake produces. The real one, so a width check cannot pass by accident. */
export const FAKE_DIM = EMBED_DIM

/**
 * A deterministic, hash-seeded embedder whose cosine relations are assertable.
 *
 * The same bag-of-words construction `@memhtml/index`'s harness uses: each token hashes to two
 * components, then the vector is L2-normalized. Two texts sharing vocabulary have a genuinely high
 * cosine and two disjoint texts a low one — which is the property a ranking assertion needs, and
 * which neither a random nor a constant fake has.
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

/**
 * An embedder that always fails, for the degradation path.
 *
 * The failure travels through the ERROR channel as a typed `ModelUnavailable`, not as a throw: the
 * lexical floor only holds if retrieval can catch it, and a defect here would kill the fiber instead
 * of narrowing the search.
 */
export const failingEmbedder = (): EmbedderShape => {
  const fail = () =>
    Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "fake outage" }))
  return {
    document: { embed: fail },
    query: { embedQuery: fail }
  }
}

/** An absent embedder: `MEMHTML_EMBED=off`, and every `index rebuild --no-embed`. */
export const noEmbedder = (): EmbedderShape => ({ document: undefined, query: undefined })

/** A scaffolded repo plus a `run` bound to it. */
export interface Cli {
  readonly root: string
  /** `run(argv)` against this repo's own layer graph. */
  readonly run: (argv: ReadonlyArray<string>) => Promise<RunResult>
  /** The parsed `data` of a successful envelope, or a thrown assertion on a failure. */
  readonly json: <A = Record<string, unknown>>(argv: ReadonlyArray<string>) => Promise<A>
  /** The whole envelope, whatever it is. For asserting on a failure. */
  readonly envelope: (argv: ReadonlyArray<string>) => Promise<Record<string, unknown>>
  readonly layer: Layer.Layer<Layer.Success<ReturnType<typeof layerAppWith>>>
  readonly cleanup: () => Promise<void>
}

/**
 * A CLI over a fresh scaffolded repo.
 *
 * `--repo` is threaded on every invocation rather than set in the environment, because a test suite
 * running in parallel would otherwise share one `MEMHTML_ROOT` and two tests would write into one
 * corpus. The flag is also the path production takes for an operator running against a second repo,
 * so it is not a test-only affordance. The other half is `vitest.config.ts`, which pins `MEMHTML_ROOT`
 * to a throwaway under the temp dir and whose teardown fails the run if anything created it, so an
 * invocation that drops the flag lands nowhere that matters (issue #144).
 */
export const makeCli = async (
  options: {
    readonly embedder?: EmbedderShape | undefined
    /** Bound only by extraction tests; absent is the production default (writes unextracted). */
    readonly extractor?: EntityExtractorShape | undefined
    /** Absent reads the configured floor (the default in tests); a coverage test moves it. */
    readonly vectorCoverageFloor?: number | undefined
  } = {}
): Promise<Cli> => {
  const fixture = await Effect.runPromise(makeFixtureRepo())
  const embedder = options.embedder ?? fakeEmbedder()
  const layer = layerAppWith({
    repo: fixture.root,
    embedder,
    extractor: options.extractor,
    vectorCoverageFloor: options.vectorCoverageFloor
  })

  const invoke = (argv: ReadonlyArray<string>) => run([...argv, "--repo", fixture.root], layer)

  return {
    root: fixture.root,
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
    layer,
    cleanup: async () => {
      await fixture.cleanup()
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
}
