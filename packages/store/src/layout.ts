import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { StorageFailure } from "@memhtml/contracts/errors"
import { ARCS_DIR, INBOX_DIR, PEOPLE_DIR } from "@memhtml/contracts/paths"
import { PARA_BUCKETS } from "@memhtml/contracts/types"
import { Effect } from "effect"

import type { GitFailure, GitShape } from "./git.js"
import { commitSubject } from "./plumbing.js"

/**
 * The memory repo's on-disk shape, and the one operation that creates it.
 *
 * The store never creates the root implicitly. A typo in `MEMHTML_ROOT` that silently scaffolded a
 * second empty memory repo would be worse than an error, because the agent would go on writing
 * into it and only a later search would come up empty. `memhtml init` is the single explicit path,
 * and it is idempotent so a re-run against a live repo is safe.
 */

/** Where the index, the state plane, and the committed sidecars live. */
export const MEMHTML_DIR = ".memhtml"

/** The gitignored, rebuildable index database, relative to the root. */
export const INDEX_DB_PATH = `${MEMHTML_DIR}/index.db`

/** The gitignored state plane. NOT rebuildable from git — its sidecar is what survives. */
export const STATE_DB_PATH = `${MEMHTML_DIR}/state.db`

/** The committed append-only sidecar the state plane exports to. */
export const STATE_SIDECAR_PATH = `${MEMHTML_DIR}/state/access.jsonl`

/** Where a sleep run's committed report lands, one file per run id. */
export const SLEEP_REPORTS_DIR = `${MEMHTML_DIR}/sleep`

/**
 * Every directory `memhtml init` creates. The four PARA buckets plus the three system directories
 * whose names other packages resolve paths against. An agent's first write must land in a
 * directory that exists, and `placementFor` can return `areas/inbox` on its very first call.
 */
export const SCAFFOLD_DIRS: ReadonlyArray<string> = [
  ...PARA_BUCKETS,
  ARCS_DIR,
  PEOPLE_DIR,
  INBOX_DIR,
  `${MEMHTML_DIR}/state`,
  SLEEP_REPORTS_DIR
]

/**
 * `.gitignore`. Both databases are excluded and nothing else is. `index.db` is rebuildable
 * from the tree, and `state.db` is reproduced from its committed JSONL sidecar, so a fresh
 * clone plus `memhtml state import` plus `memhtml index rebuild` yields the whole system.
 */
export const GITIGNORE = `${INDEX_DB_PATH}
${STATE_DB_PATH}
${INDEX_DB_PATH}-*
${STATE_DB_PATH}-*
`

/**
 * `.gitattributes`. The generated artifacts are the design's one merge-conflict source, and
 * `merge=ours` plus a regeneration pass is how a conflict in them is resolved.
 *
 * The attribute alone does nothing. Probed live 2026-08-02, with `merge=ours` set and no
 * driver configured, git still conflicts and writes conflict markers into the file. The
 * `merge.ours.driver` config in {@link initRepo} is what makes the attribute effective, and
 * config is per-clone, so `memhtml init` on a fresh clone must set it again.
 */
export const GITATTRIBUTES = `index.html merge=ours
sitemap.xml merge=ours
*.html diff=html
`

/** The config that makes `merge=ours` in `.gitattributes` actually resolve a conflict. */
export const MERGE_OURS_DRIVER = { key: "merge.ours.driver", value: "true" } as const

/**
 * The root `README.html`, browsable with no server. Deliberately a memory-shaped document
 * rather than Markdown, so the repo's own entry point demonstrates the format it stores.
 */
export const README = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Memory</title>
</head>
<body>
<article>
<p><mark>This repository is one agent's memory: one fact per file, as semantic HTML5.</mark>
Directories follow PARA — <code>projects/</code>, <code>areas/</code>, <code>resources/</code>,
<code>archive/</code>. Nothing is ever deleted; eviction moves a file to
<code>archive/&lt;YYYY&gt;/</code> with its original path mirrored beneath, so
<code>git log --follow</code> reads straight through.</p>
<p>The index under <code>.memhtml/</code> is derived and gitignored. This tree is the system of
record.</p>
</article>
</body>
</html>
`

/** What {@link initRepo} did. `created: false` means the repo already existed and nothing changed. */
export interface InitResult {
  readonly root: string
  /** True when this call created the repository. False on an idempotent re-run. */
  readonly created: boolean
  /** The initial commit's sha, or the existing HEAD on a re-run. */
  readonly headSha: string | null
  /** Files this call wrote. Empty on a fully idempotent re-run. */
  readonly wrote: ReadonlyArray<string>
}

/** Write a file only when it is absent, so a re-run never overwrites an edited scaffold file. */
const writeIfAbsent = (
  root: string,
  relativePath: string,
  contents: string
): Effect.Effect<boolean, StorageFailure> =>
  Effect.gen(function* () {
    const absolute = join(root, relativePath)
    const existing = yield* readFileOrNull(absolute)
    if (existing !== null) return false
    yield* attemptIo(`init.write:${relativePath}`, async () => {
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, contents, "utf8")
    })
    return true
  })

/** A file's contents, or `null` when it is absent. Any other rejection is a real failure. */
export const readFileOrNull = (
  absolutePath: string
): Effect.Effect<string | null, StorageFailure> =>
  Effect.tryPromise({
    try: () => readFile(absolutePath, "utf8"),
    catch: (cause) => cause
  }).pipe(
    Effect.catch((cause) => {
      const code = (cause as { code?: unknown } | null)?.code
      return code === "ENOENT" || code === "EISDIR"
        ? Effect.succeed(null)
        : Effect.logError(`store.read failed: ${String(code ?? cause)}`).pipe(
            Effect.andThen(Effect.fail(StorageFailure.make({ operation: "read" })))
          )
    })
  )

/** Wrap a filesystem call as a typed failure, logging the errno for an operator. */
export const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`store.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation }))
  )

/** Every path `memhtml init` scaffolds. A `.gitkeep` per directory, plus the three root files. */
const SCAFFOLD_FILES: ReadonlyArray<readonly [string, string]> = [
  ...SCAFFOLD_DIRS.map((directory) => [`${directory}/.gitkeep`, ""] as const),
  [".gitignore", GITIGNORE],
  [".gitattributes", GITATTRIBUTES],
  ["README.html", README]
]

/**
 * Scaffold a memory repo at `root` and make its initial commit.
 *
 * **Convergent, not merely idempotent.** Every step asks the repo what is already true and
 * supplies only what is missing, so this reaches the same end state from an empty directory,
 * from a fully scaffolded repo (writing nothing and committing nothing), and from a repo left
 * half-initialized by an interrupted earlier run. That last state really occurs, because
 * `git commit` fails on a machine with no git identity and leaves the scaffold staged. A
 * function that short-circuited on "I wrote no files this time" would report success over a
 * repo with an unborn HEAD.
 *
 * `.gitkeep` files hold the empty PARA directories, because git tracks files and not
 * directories. Without them a fresh clone would have no `areas/inbox/` for the first write to
 * land in, and `placementFor` returns that directory before any memory exists.
 */
export const initRepo = (git: GitShape): Effect.Effect<InitResult, GitFailure | StorageFailure> =>
  Effect.gen(function* () {
    const root = git.root
    const alreadyRepo = yield* git.isRepo()
    if (!alreadyRepo) {
      yield* attemptIo("init.mkdir", () => mkdir(root, { recursive: true }))
      // `-b main` rather than relying on `init.defaultBranch`. A repo whose branch name
      // depends on the operator's global config would make every branch reference in sleep
      // and in the runbook conditional on whose machine ran `memhtml init`.
      yield* git.run(["init", "-b", "main", "."])
    }

    // Config is per-clone, so this is re-set on every init. A fresh clone of a memory repo
    // inherits `.gitattributes` but not the driver that makes `merge=ours` mean anything.
    yield* git.setConfig(MERGE_OURS_DRIVER.key, MERGE_OURS_DRIVER.value)

    const wrote: Array<string> = []
    for (const [path, contents] of SCAFFOLD_FILES) {
      if (yield* writeIfAbsent(root, path, contents)) wrote.push(path)
    }

    // Stage the whole scaffold rather than only what this call wrote, and let `commit` decide.
    // It no-ops on an index that matches HEAD, so a fully initialized repo stays untouched
    // while a half-staged one is carried to a commit.
    yield* git.add(SCAFFOLD_FILES.map(([path]) => path))
    const commit = yield* git.commit(commitSubject("init", "scaffold the memory repository"))
    const headSha = commit.sha ?? (yield* git.revParseHead())
    return { root, created: !alreadyRepo, headSha, wrote }
  }).pipe(Effect.withSpan("store.initRepo"))
