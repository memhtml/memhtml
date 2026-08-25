import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { escapeAttribute, escapeText } from "@memhtml/html"
import { type GitShape, initRepo, makeGit } from "@memhtml/store"
import { Effect } from "effect"

import { articleFor, buildCorpus, type CorpusSpec, type MemorySpec } from "./corpus.js"

/**
 * Write a {@link CorpusSpec} into a real git repository.
 *
 * The only module here that touches a filesystem. Everything about the corpus's SHAPE is decided in
 * `corpus.ts` as a pure function of `(seed, now)`, so this module has no decisions to make and a
 * fixture is reproducible by construction. The discrimination gate rests on that property, because
 * it means a change in the numbers came from the ranking and not from the corpus.
 *
 * The fixture corpus is NEVER committed to this repo. It is generated into a temp directory by the
 * test suite and by `memhtml eval discriminate`, and `pnpm gen:fixture` writes one somewhere an operator
 * names for inspection. A committed corpus would be a second source of truth for a generator that
 * already produces it deterministically.
 */

/** A generated fixture repo, with the root, the git service over it, and the spec behind it. */
export interface FixtureCorpus {
  readonly root: string
  readonly git: GitShape
  readonly spec: CorpusSpec
  /** How many files were written, generated artifacts excluded. */
  readonly written: number
  readonly cleanup: () => Promise<void>
}

/**
 * `user.name`/`user.email` per repo rather than from the environment. CI has no global git identity
 * and `git commit` refuses without one, which would fail the gate for a reason unrelated to ranking.
 */
const FIXTURE_IDENTITY: ReadonlyArray<readonly [string, string]> = [
  ["user.name", "memhtml eval fixture"],
  ["user.email", "eval@memhtml.invalid"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  // No background maintenance, for the reason `@memhtml/store/testing` gives: `git commit` starts
  // `maintenance run --auto` detached, and a fixture removed at the end of a test can still have git
  // writing into `.git/objects`, so `cleanup` fails with ENOTEMPTY in whichever case ran last.
  ["gc.auto", "0"],
  ["maintenance.auto", "false"]
]

/**
 * One spec as a memory file's bytes.
 *
 * Hand-assembled rather than routed through `@memhtml/html`'s `renderTemplate`, because of the
 * element kits. `renderTemplate` escapes each `body` string as TEXT, which is right for an agent's
 * tool parameter and wrong for a `<dl>` the fixture means as markup. The head is written in
 * `META_ORDER` so a generated file is byte-identical to what the serializer would emit for the same
 * metadata. The rest of the system then treats the fixture as an ordinary document.
 */
export const memoryFileFor = (spec: MemorySpec): string => {
  const archived = spec.archivedAt !== undefined
  const metas: Array<readonly [string, string]> = [
    ["memhtml-type", spec.memoryType],
    ["memhtml-status", archived ? "archived" : "active"],
    ["memhtml-created", spec.createdAt],
    ["memhtml-updated", spec.updatedAt],
    ["memhtml-confidence", spec.confidence.toFixed(2)],
    ["memhtml-importance", String(spec.importance)],
    ["memhtml-author", "agent:claude-opus-5"],
    ...(spec.sessionId === undefined
      ? []
      : [["memhtml-session", spec.sessionId] as readonly [string, string]]),
    ...(spec.validUntil === undefined
      ? []
      : [["memhtml-valid-until", spec.validUntil] as readonly [string, string]]),
    ...(spec.archivedAt === undefined
      ? []
      : [["memhtml-archived", spec.archivedAt] as readonly [string, string]]),
    ...spec.entities.map((entity) => ["memhtml-entity", entity] as readonly [string, string]),
    ...spec.tags.map((tag) => ["memhtml-tag", tag] as readonly [string, string])
  ]

  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeText(spec.title)}</title>`,
    ...metas.map(
      ([name, content]) =>
        `<meta name="${escapeAttribute(name)}" content="${escapeAttribute(content)}">`
    ),
    ...spec.links.map(
      (link) => `<link rel="${escapeAttribute(link.rel)}" href="${escapeAttribute(link.href)}">`
    ),
    "</head>",
    "<body>",
    "<article>",
    articleFor(spec),
    "</article>",
    "</body>",
    "</html>"
  ]
  return `${lines.join("\n")}\n`
}

/**
 * Generate the corpus into `root`, committing it.
 *
 * ONE commit for the whole corpus. A commit per memory would make the fixture's git history the
 * dominant cost of every eval run. The gate is about ranking, and `git log` over a generated corpus
 * tells a reader nothing.
 */
export const writeCorpus = (root: string, git: GitShape, spec: CorpusSpec): Effect.Effect<number> =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      for (const memory of spec.memories) {
        const absolute = join(root, memory.path)
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, memoryFileFor(memory), "utf8")
      }
    })
    yield* git.add(spec.memories.map((memory) => memory.path)).pipe(Effect.orDie)
    yield* git.commit(`memhtml(write): seed the eval fixture corpus`).pipe(Effect.orDie)
    return spec.memories.length
  })

/** What {@link makeFixtureCorpus} takes. Every field has a default, so a caller can pass nothing. */
export interface FixtureOptions {
  readonly seed?: number | undefined
  readonly size?: number | undefined
  readonly probes?: number | undefined
  /**
   * The run instant the corpus's stamps are anchored behind, UTC millis. Effect's `Clock` when
   * absent, which is the one place the fixture pipeline consults time at all — `buildCorpus`
   * requires it, so a test pinning this value pins every stamp in the tree.
   */
  readonly now?: number | undefined
  /** Where to generate. A fresh temp directory when absent. */
  readonly root?: string | undefined
}

/**
 * A scaffolded memory repo carrying a generated corpus.
 *
 * `initRepo` is the real one, so the fixture carries the real `.gitignore`, the real
 * `.gitattributes`, and the real `merge.ours.driver` config. That config is per-clone, and the
 * `merge=ours` attribute does nothing without it.
 */
export const makeFixtureCorpus = (options: FixtureOptions = {}): Effect.Effect<FixtureCorpus> =>
  Effect.gen(function* () {
    const root =
      options.root ??
      (yield* Effect.promise(() => mkdtemp(join(tmpdir(), "memhtml-eval-fixture-"))))
    yield* Effect.promise(() => mkdir(root, { recursive: true }))

    const git = makeGit(root)
    yield* git.run(["init", "-b", "main", "."]).pipe(Effect.orDie)
    for (const [key, value] of FIXTURE_IDENTITY) {
      yield* git.setConfig(key, value).pipe(Effect.orDie)
    }
    yield* initRepo(git).pipe(Effect.orDie)

    // The Clock service rather than a bare `Date.now()`, so a test can pin the whole corpus's
    // timeline with `TestClock` while a real run anchors to the actual run instant.
    const now = options.now ?? (yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const spec = buildCorpus({ ...options, now })
    const written = yield* writeCorpus(root, git, spec)

    return {
      root,
      git,
      spec,
      written,
      // Retried for the same reason the store's fixture retries: a temp tree can briefly have a
      // writer that is not this process.
      cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
