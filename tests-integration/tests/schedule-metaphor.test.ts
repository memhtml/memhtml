import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"

import { dirname, join, posix, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..")

/**
 * A repo-wide census over the word `nightly`, because sleep has no schedule and the prose said it did.
 *
 * Sleep reads a clock ONLY to stamp — one `clock.currentTimeMillis` for the run's timestamps and date
 * arithmetic for a validity bound — and never to decide whether to work. There is no scheduler in the
 * package and no default cadence anywhere. `nightly` promised a cadence the code cannot honour, and it
 * carried THREE different referents at once, which is the semantic-contract hazard in miniature: a run
 * without `--deep`, an unattended caller, and any sleep run at all. Each now has its own words.
 *
 * The census is over the WORD rather than over a per-file review, because that is the difference
 * between a sweep and a gate: a spot check passes the day it is written and says nothing about the
 * next paragraph somebody adds.
 *
 * **This reads the bytes with `readFile` rather than shelling out to `grep`**, and that is not a style
 * choice. `grep` silently skips a file it reads as binary — no warning, no non-zero exit — and one raw
 * NUL byte in `packages/sleep/src/tasks.ts` made a 1,100-line source file invisible to exactly that
 * kind of sweep. Every gate here that greps a tree carries the same hole.
 */

/** A directory whose contents are not authored here, or are a build product. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "dist-package",
  ".turbo",
  ".git",
  ".astro",
  ".sarif",
  ".codegraph",
  // Prior-session lessons and specs: a historical record of what was decided, not a live artifact.
  ".erpaval",
  // Packed snapshots of the tree, regenerated wholesale by their tools.
  ".repomix",
  ".packets"
])

/**
 * Extensions of files nobody authors PROSE in. Everything else is read.
 *
 * A DENYLIST rather than a list of authored extensions, and that is the load-bearing choice: an
 * allowlist silently drops every extension nobody thought of, so the census reports a total over a
 * subset while claiming to be repo-wide — a wrong count that reads as a clean result, which is the
 * failure this whole file exists to prevent. Measured 2026-08-26, an allowlist of the eighteen obvious
 * extensions skipped five `.jsonl` files, eleven `.svg` files, and three extensionless ones inside the
 * walked trees, and one of the `.jsonl` files held a live occurrence.
 *
 * A binary read as bytes costs a `readFile` and matches nothing, so the only reason to name one here is
 * to keep the walk from reading megabytes it cannot learn from.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".zip",
  ".gz",
  ".tgz",
  ".db",
  ".wasm"
])

/** Trees walked in full, plus the root files that are authored rather than generated. */
const WALKED = [
  "packages",
  "apps",
  "docs",
  "spec",
  "scripts",
  "tests-integration",
  ".github"
] as const

const ROOT_FILES = [
  "README.md",
  "ROADMAP.md",
  "RUNBOOK.md",
  "AGENTS.md",
  "RELEASING.md",
  "mise.toml",
  "turbo.json",
  "biome.json",
  "package.json"
] as const

/**
 * Where `nightly` may still appear, with its reason and its exact count.
 *
 * A BOUND, not a licence — the same shape the a11y gate's declared baseline has. Every entry is test
 * DATA: memory content in a fixture corpus, describing a fictional job that runs at night, which is a
 * fact about that corpus and not a claim about memhtml's cadence. The counts are exact in both
 * directions, so a new occurrence in one of these files fails here too, and a fixture whose text stops
 * saying it fails rather than leaving a stale allowance behind.
 *
 * `CLAUDE.md` is deliberately outside the walked set: it is this repository's own instruction file for
 * an agent working ON memhtml, not a shipped or published artifact, and its wording is the
 * maintainers'.
 *
 * This FILE is the other entry, and it has to be: a census names its own subject in order to describe
 * it, so the word appears in the table above and in the prose explaining why. A gate stating what it
 * refuses is not an artifact promising a cadence.
 */
const ALLOWED: ReadonlyArray<{
  readonly path: string
  readonly count: number
  readonly reason: string
}> = [
  {
    path: "apps/mcp/tests/roundtrip.test.ts",
    count: 5,
    reason:
      "memory content: two versions of a fact about a fictional batch window, plus the three queries that retrieve them"
  },
  {
    path: "packages/sleep/tests/fixture.ts",
    count: 3,
    reason:
      "memory content: a fixture pair about a fictional index-rebuild job, seeded to be deduped"
  },
  {
    path: "packages/sleep/tests/dedup.test.ts",
    count: 12,
    reason:
      "assertions keyed on the fixture's own claim text, quoted verbatim so a rename is caught"
  },
  {
    path: "packages/sleep/tests/deep.test.ts",
    count: 1,
    reason: "memory content: a deep-band fixture claim about a fictional ledger copy"
  }
]

/**
 * The one file excluded from the walk, named rather than pattern-matched.
 *
 * A census has to name its own subject in order to describe it, so the word appears here in the table
 * above and in the prose explaining it. Excluded as a single literal so the exclusion cannot grow: the
 * case below asserts the walk found this file and then dropped exactly it.
 */
const SELF = "tests-integration/tests/schedule-metaphor.test.ts"

/**
 * Repo-relative posix paths of authored files under one directory, at any depth.
 *
 * The walk PRUNES a skipped directory instead of filtering its paths out afterwards, and the difference
 * is not cosmetic: `readdir(recursive: true)` descends into every `node_modules` in the workspace
 * before anything can discard the results, which took this census from under a second to ninety-six.
 */
/** A filename's extension, or `""` for a name with no dot — which is read rather than skipped. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot)
}

const authoredUnder = async (dir: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = []
  const walk = async (relative: string): Promise<void> => {
    let entries: ReadonlyArray<Dirent>
    try {
      entries = await readdir(join(REPO_ROOT, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = posix.join(relative, entry.name.split(sep).join(posix.sep))
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(child)
      } else if (!BINARY_EXTENSIONS.has(extensionOf(entry.name))) {
        found.push(child)
      }
    }
  }
  await walk(dir)
  return found
}

/** Occurrences of the word in one file, case-insensitive, or `0` when it is unreadable as text. */
const occurrencesIn = async (path: string): Promise<number> => {
  try {
    const text = await readFile(join(REPO_ROOT, path), "utf8")
    return text.match(/nightly/gi)?.length ?? 0
  } catch {
    return 0
  }
}

const census = async (): Promise<{
  readonly scanned: number
  readonly excluded: number
  readonly byPath: ReadonlyMap<string, number>
}> => {
  const walked = (await Promise.all(WALKED.map(authoredUnder))).flat()
  const found = [...walked, ...ROOT_FILES]
  const paths = found.filter((path) => path !== SELF)
  const counts = await Promise.all(paths.map(occurrencesIn))
  const byPath = new Map<string, number>()
  for (const [at, path] of paths.entries()) {
    const count = counts[at] ?? 0
    if (count > 0) byPath.set(path, count)
  }
  return { scanned: paths.length, excluded: found.length - paths.length, byPath }
}

describe("sleep has no schedule, and no artifact says it does", () => {
  it("finds `nightly` only in fixture memory content, at exactly the declared counts", async () => {
    const { scanned, excluded, byPath } = await census()

    /**
     * The independently-derived total, which is what makes this a census rather than a report. A walk
     * that matched nothing — a wrong root, a wrong extension set, a `readdir` that threw — would
     * otherwise pass by finding no violations in an empty set, and this repo has twice had a wrong
     * count read as a finding.
     */
    expect(scanned).toBeGreaterThan(400)
    // Exactly one file is excluded, and the walk had to have REACHED it to drop it — otherwise the
    // exclusion would be silently covering a typo in the path.
    expect(excluded).toBe(1)

    const allowedByPath = new Map(ALLOWED.map((entry) => [entry.path, entry.count]))
    const unexpected = [...byPath]
      .filter(([path]) => !allowedByPath.has(path))
      .map(([path, count]) => `${path} (${String(count)})`)
    expect(unexpected, `undeclared \`nightly\`: ${unexpected.join(", ")}`).toEqual([])

    // Exact in both directions: a NEW occurrence in an allowed file fails, and an allowance whose
    // subject is gone fails rather than outliving the text it was written for.
    for (const entry of ALLOWED) {
      expect(byPath.get(entry.path), `${entry.path} — ${entry.reason}`).toBe(entry.count)
    }

    const total = [...byPath.values()].reduce((sum, count) => sum + count, 0)
    expect(total).toBe(ALLOWED.reduce((sum, entry) => sum + entry.count, 0))
  })

  it("reads every authored file as bytes, including one no `grep` sweep can see", async () => {
    /**
     * The census's own coverage, asserted against the file that motivated the method. `tasks.ts` held a
     * raw NUL, which makes `file(1)` report `data` and makes `grep` skip it in silence — so a sweep
     * built on `grep` reported zero matches in a file that had three. The escape landed in its own
     * commit, and this is what keeps the census honest about being able to read it either way.
     */
    const walked = (await Promise.all(WALKED.map(authoredUnder))).flat()
    expect(walked).toContain("packages/sleep/src/tasks.ts")
    const source = await readFile(join(REPO_ROOT, "packages/sleep/src/tasks.ts"), "utf8")
    expect(source.length).toBeGreaterThan(1000)
    expect(await occurrencesIn("packages/sleep/src/tasks.ts")).toBe(0)
  })

  it("keeps sleep's only clock reads on the STAMPING path", async () => {
    /**
     * The claim the prose now makes, checked against the source rather than trusted. `run.ts` takes one
     * clock reading to timestamp the run and `edits.ts` does date arithmetic for a validity bound;
     * nothing in the phase registry or the runner consults a clock to decide whether to do work, and no
     * package in the tree schedules anything.
     */
    const sleepSources = (await authoredUnder("packages/sleep/src")).filter((path) =>
      path.endsWith(".ts")
    )
    expect(sleepSources.length).toBeGreaterThan(20)

    const clockReaders: string[] = []
    for (const path of sleepSources) {
      const text = await readFile(join(REPO_ROOT, path), "utf8")
      if (/currentTimeMillis|Date\.now\(\)/.test(text)) clockReaders.push(path)
    }
    // ONE file reads the wall clock, and it reads it to stamp. A second reader is a scheduling decision
    // arriving somewhere a reviewer would not look for one.
    expect(clockReaders).toEqual(["packages/sleep/src/run.ts"])

    // And nothing sets a timer or subscribes to a schedule anywhere in the package.
    for (const path of sleepSources) {
      const text = await readFile(join(REPO_ROOT, path), "utf8")
      expect(text, `${path} schedules work`).not.toMatch(/setInterval|setTimeout|node-cron|cron\(/)
    }
  })
})
