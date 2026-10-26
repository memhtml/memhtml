import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SCRIPT = join(REPO_ROOT, "scripts", "doc-citations.mjs")

/**
 * That `scripts/doc-citations.mjs` fails on each kind of bad citation, and passes the good ones.
 *
 * Every case runs the script with `--root` against a throwaway git repository holding a few small
 * source files and a doc that cites them, so the assertions are about the rules rather than about
 * the state of this repository's own docs (which `mise run check` runs the script over directly).
 * Each bad case plants exactly ONE bad citation into an otherwise passing tree and requires exactly
 * one failure naming its file and line: a rule that stopped firing fails its case, and a rule that
 * started firing on a good citation fails the passing case.
 */

const SOURCE = `/** The store's surface. */
export interface StoreShape {
  readonly write: (path: string) => void
  readonly exclusive: <A, E, R>(effect: A) => A
  batch(options: { readonly atomic: boolean }): void
}

export const makeStore = (): StoreShape => {
  const write = (path: string): void => {
    const step = path.length
    void step
  }
  report({ operation: "make" })
  return { write, exclusive: (effect) => effect, batch: () => undefined }
}

export const openStore = ({ root }: { readonly root: string }): string => root

export const Tool = make("tool", {
  parameters: Struct({ limit: 1 })
})

export class Ledger {
  append(entry: string): string {
    return \`\${entry}\\n\`
  }
}

export type Rel = "supersedes" | "contradicts"
`

/**
 * Declaration keywords and braces inside every place the scanner must not read as code. If any of
 * them leaked, a name below would be declared; if any brace were counted, the file would not
 * balance and every citation of it would fail.
 */
const NOISE = `// export const inLineComment = { a: 1 }
/* export function inBlockComment() { */
/**
 * export class InDocComment {
 */
export const quoted = "export const inString = { b: 2 }"
export const single = 'function inSingle() {'
export const template = \`class InTemplate { \${"}"} const inTemplate = \${\`{ \${1} }\`}\`
export const pattern = /\\{ const inRegex = \\}[/{]/g
export const ratio = (total: number, count: number): number => total / count / 2
export const kept = { after: pattern.source.length / 2 }
`

/** One citation of every passing form, plus spans that look like citations and are not. */
const GOOD_DOC = `# Good

The store is \`packages/demo/src/store.ts::makeStore\`, which writes through
\`packages/demo/src/store.ts::makeStore::write\` behind
\`packages/demo/src/store.ts::StoreShape::write\`, one step at a time
(\`packages/demo/src/store.ts::makeStore::write::step\`). A ledger entry goes through
\`packages/demo/src/store.ts::Ledger::append\`, a rel is a \`packages/demo/src/store.ts::Rel\`, and
the tool takes \`packages/demo/src/store.ts::Tool::parameters::limit\`. The scanner reads
\`packages/demo/src/noise.ts::kept::after\` and \`packages/demo/src/noise.ts::ratio\` past the
noise. The schema is \`packages/demo/migrations/0001_files.sql\`, the sources sit in
\`packages/demo/src/\`, every package has \`packages/*/src\`, the build writes
\`packages/demo/dist/store.js\`, this page is \`docs/good.md\`, and the root holds \`README.md\`.

Not citations: \`Schema::Struct\`, \`2026-08-24T13:00Z\`, \`23:59:60\`, \`http://127.0.0.1:4000\`,
a port \`:4000\`, and a store's \`index.html\`.

\`\`\`text
packages/demo/src/store.ts:3 sits in a fence, which holds an example rather than a citation.
\`packages/demo/src/store.ts:3\`
\`\`\`
`

const BASE: Readonly<Record<string, string>> = {
  "packages/demo/src/store.ts": SOURCE,
  "packages/demo/src/noise.ts": NOISE,
  "packages/demo/migrations/0001_files.sql": "CREATE TABLE files (path TEXT PRIMARY KEY);\n",
  "docs/good.md": GOOD_DOC,
  "README.md": "# Demo\n\nSee `packages/demo/src/store.ts::makeStore`.\n",
  "RUNBOOK.md": "# Runbook\n\nStart with `packages/demo/src/store.ts::makeStore`.\n"
}

const git = (cwd: string, args: string[]) => {
  const run = spawnSync(
    "git",
    ["-c", "user.name=doc-citations", "-c", "user.email=doc@example.invalid", ...args],
    { cwd, encoding: "utf8" }
  )
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`)
  return run.stdout.trim()
}

const runCheck = (root: string) =>
  spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", timeout: 60_000 })

/** The jobs of a GitHub workflow, read from its two-space job keys under `jobs:`. */
const jobsOf = (workflow: string) =>
  workflow
    .slice(workflow.search(/^jobs:\s*$/m))
    .split(/^(?= {2}[\w-]+:\s*$)/m)
    .slice(1)
    .map((body) => ({ name: /^ {2}([\w-]+):/.exec(body)?.[1] ?? "", body }))

describe("scripts/doc-citations.mjs", () => {
  let scratch: string
  let serial = 0
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "doc-citations-tests-"))
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  /**
   * A committed tree that passes, then `extra` files written and `removed` files deleted after the
   * commit; returns its root. `extra` gets the commit and the root, so a case can commit again.
   */
  const tree = async (
    extra: (head: string, root: string) => Record<string, string> = () => ({}),
    removed: ReadonlyArray<string> = []
  ) => {
    const root = join(scratch, `tree-${serial++}`)
    for (const [path, text] of Object.entries(BASE)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
    git(root, ["init", "-q", "-b", "main"])
    git(root, ["add", "."])
    git(root, ["commit", "-q", "-m", "fixture"])
    const head = git(root, ["rev-parse", "HEAD"])
    for (const [path, text] of Object.entries(extra(head, root))) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
    for (const path of removed) await rm(join(root, path))
    return root
  }

  /** Requires exactly one failure, at `file:line`, carrying `problem`. */
  const failsOnce = (run: ReturnType<typeof runCheck>, at: string, problem: string) => {
    expect(run.status, run.stdout).toBe(1)
    expect(run.stderr).toContain(`${at}: `)
    expect(run.stderr).toContain(problem)
    expect(run.stderr).toContain("FAILED: 1 problem.")
  }

  it("passes every good citation form, and skips fences and look-alikes", async () => {
    const run = runCheck(await tree())
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(
      "doc citations ok: 11 symbol citations and 6 repository paths in 3 hand docs"
    )
  })

  const ZERO = "0".repeat(40)
  const store = "packages/demo/src/store.ts"
  it.each([
    ["a line", "docs/bad.md", `Writes (\`${store}:7\`).`, "cites a line"],
    ["a line range", "docs/bad.md", `Writes (\`${store}:6-11\`).`, "cites a line"],
    ["a line and column", "docs/bad.md", `Writes (\`${store}:12:5\`).`, "cites a line"],
    ["a #L anchor", "docs/bad.md", `Writes (\`${store}#L12\`).`, "cites a line"],
    ["a line before a name", "docs/bad.md", `Writes (\`${store}:7 write\`).`, "cites a line"],
    ["a continuation", "docs/bad.md", `Writes (\`${store}\`, \`:7\`).`, "`:7` cites a line"],
    ["a list of lines", "docs/bad.md", `Writes (\`${store}:6, :14\`).`, "cites a line"],
    ["a bare file name", "docs/bad.md", "Writes (`store.ts:7`).", "cites a line"],
    [
      "an undeclared top-level symbol",
      "docs/bad.md",
      `\`${store}::makeIndex\``,
      "declares no `makeIndex`"
    ],
    [
      "a name declared only inside another, cited as top level",
      "docs/bad.md",
      `\`${store}::write\``,
      "declares no `write`"
    ],
    [
      "a nested symbol its owner does not declare",
      "docs/bad.md",
      `\`${store}::makeStore::remove\``,
      "declares no `makeStore::remove`"
    ],
    [
      "a member the named class does not declare, though the file does",
      "docs/bad.md",
      `\`${store}::Ledger::write\``,
      "declares no `Ledger::write`"
    ],
    [
      "a const inside a nested function, cited past that function",
      "docs/bad.md",
      `\`${store}::makeStore::step\``,
      "declares no `makeStore::step`"
    ],
    [
      "an object key in a call inside a function body",
      "docs/bad.md",
      `\`${store}::makeStore::operation\``,
      "declares no `makeStore::operation`"
    ],
    [
      "a key of an object a function body returns",
      "docs/bad.md",
      `\`${store}::makeStore::exclusive\``,
      "declares no `makeStore::exclusive`"
    ],
    [
      "a destructured parameter",
      "docs/bad.md",
      `\`${store}::openStore::root\``,
      "declares no `openStore::root`"
    ],
    [
      "a key of a parameter's type literal",
      "docs/bad.md",
      `\`${store}::StoreShape::batch::atomic\``,
      "declares no `StoreShape::batch::atomic`"
    ],
    [
      "a type parameter",
      "docs/bad.md",
      `\`${store}::StoreShape::E\``,
      "declares no `StoreShape::E`"
    ],
    [
      "a key one object below the one cited",
      "docs/bad.md",
      `\`${store}::Tool::limit\``,
      "declares no `Tool::limit`"
    ],
    [
      "a symbol in a missing file",
      "docs/bad.md",
      "`packages/demo/src/gone.ts::makeStore`",
      "no such file"
    ],
    [
      "a symbol in a file the scanner cannot read",
      "docs/bad.md",
      "`packages/demo/migrations/0001_files.sql::files`",
      "cite the bare path"
    ],
    [
      "a repository path that does not exist",
      "docs/bad.md",
      "See `packages/demo/src/gone.ts`.",
      "names a path that does not exist"
    ],
    [
      "a docs path that does not exist",
      "docs/bad.md",
      "See `docs/reference/cli.md`.",
      "names a path that does not exist"
    ],
    [
      "a line in a docs-site page",
      "apps/docs/src/content/docs/internals/bad.md",
      `Writes (\`${store}:7\`).`,
      "cites a line"
    ],
    [
      "a line in the docs site's agents page",
      "apps/docs/src/content/docs/agents.md",
      `Writes (\`${store}:7\`).`,
      "cites a line"
    ],
    ["a line in CLAUDE.md", "CLAUDE.md", `Writes (\`${store}:7\`).`, "cites a line"],
    ["a line in a root-level doc", "RUNBOOK.md", `Writes (\`${store}:7\`).`, "cites a line"]
  ])("fails on %s", async (_name, file, text, problem) => {
    const run = runCheck(await tree(() => ({ [file]: `# Bad\n\n${text}\n` })))
    failsOnce(run, `${file}:${`# Bad\n\n${text}`.split("\n").length}`, problem)
  })

  it.each([
    "inLineComment",
    "inBlockComment",
    "InDocComment",
    "inString",
    "inSingle",
    "InTemplate",
    "inTemplate",
    "inRegex"
  ])("reads no declaration of %s out of a comment, string, template or regex", async (name) => {
    const doc = `# Bad\n\nSee \`packages/demo/src/noise.ts::${name}\`.\n`
    const run = runCheck(await tree(() => ({ "docs/bad.md": doc })))
    failsOnce(run, "docs/bad.md:3", `declares no \`${name}\``)
  })

  it.each([
    ["an opener with no closer", "export const broken = () => {\n  return 1\n"],
    ["a closer with no opener", "export const broken = () => 1\n}\n"],
    ["a closer of the wrong kind", "export const broken = (value: number) => {\n  return value)\n"]
  ])("fails a symbol in a file whose brackets do not balance: %s", async (_name, source) => {
    const run = runCheck(
      await tree(() => ({
        "packages/demo/src/broken.ts": source,
        "docs/bad.md": "# Bad\n\nSee `packages/demo/src/broken.ts::broken`.\n"
      }))
    )
    failsOnce(run, "docs/bad.md:3", "its declarations could not be read")
  })

  it("fails a root-level file the root held and no longer holds, and only that", async () => {
    // `RUNBOOK.md` is in the fixture commit and gone from the tree; `index.html` never was at the
    // root, so naming it is naming a store's file, not this repository's.
    const doc = "# Bad\n\nSee `RUNBOOK.md`, and a store's `index.html`.\n"
    const run = runCheck(await tree(() => ({ "docs/bad.md": doc }), ["RUNBOOK.md"]))
    failsOnce(run, "docs/bad.md:3", "`RUNBOOK.md` names a root-level file that does not exist")
  })

  /** A stamped page at `head`, holding `body`. */
  const page = (head: string, body: string) =>
    `---\ncommit: ${head}\n---\n\n# Overview\n\n${body}\n`
  const LINES = SOURCE.split("\n").length - 1
  it.each([
    ["no stamp", () => "# Overview\n\nSee `packages/demo/src/store.ts:7`.\n", "names no commit"],
    ["a short front-matter sha", () => "---\ncommit: abc1234\n---\n\n# Overview\n", "40-hex"],
    [
      "a commit the clone does not hold",
      () => `---\ncommit: ${ZERO}\n---\n\n# Overview\n`,
      `commit ${ZERO} does not exist`
    ],
    [
      "a Built-from line naming a missing commit",
      () => `# Overview\n\n> Built from commit \`${ZERO}\`.\n`,
      `commit ${ZERO} does not exist`
    ],
    [
      "a commit that is not an ancestor of HEAD",
      (head: string, root: string) =>
        page(git(root, ["commit-tree", `${head}^{tree}`, "-m", "elsewhere"]), ""),
      "is not an ancestor of HEAD"
    ],
    [
      "a citation of a file the commit does not hold",
      (head: string) => page(head, "See `packages/demo/src/gone.ts:3`."),
      "packages/demo/src/gone.ts is not a file at"
    ],
    [
      "a line past the end of the file at the commit",
      (head: string) => page(head, `See \`${store}:${LINES + 1}\`.`),
      `${store} has ${LINES} lines at`
    ],
    [
      "a range that runs backwards",
      (head: string) => page(head, `See \`${store}:9-3\`.`),
      `${store} has ${LINES} lines at`
    ],
    [
      "a continuation past the end of the file it continues",
      (head: string) => page(head, `See \`${store}:3\` and \`:${LINES + 1}\`.`),
      `\`:${LINES + 1}\`: ${store} has ${LINES} lines at`
    ]
  ])("fails a docs/codebase page with %s", async (_name, body, problem) => {
    const run = runCheck(
      await tree((head, root) => ({ "docs/codebase/architecture/overview.md": body(head, root) }))
    )
    expect(run.status, run.stdout).toBe(1)
    expect(run.stderr).toContain("docs/codebase/architecture/overview.md:")
    expect(run.stderr).toContain(problem)
    expect(run.stderr).toContain("FAILED: 1 problem.")
  })

  it("reads no line citation against HEAD where it does not apply", async () => {
    // A stamped codebase page keeps its `path:N` citations, read at its own commit instead, in
    // every form the generated pages use. A frozen RFC, a dated bug report, a generated reference
    // page, the generated root docs, the site's TypeDoc tier, and a tool's dot-directory under
    // docs/codebase are not hand docs at all.
    const stale = "Writes (`packages/demo/src/store.ts:7`).\n"
    const built = (head: string) =>
      `# Debt\n\n> Built from commit [${head.slice(0, 7)}](x).\n\n${stale}`
    const forms = [
      `\`${store}:7\`, \`${store}:6-11\`, \`:3\`, and \`:2-4\`;`,
      `\`${store}:9 makeStore\` and \`README.md:1\`; \`${store}\` at \`:12\`.`
    ].join("\n")
    const run = runCheck(
      await tree((head) => ({
        "docs/codebase/architecture/overview.md": page(head, forms),
        "docs/codebase/insights/debt.md": built(head),
        "docs/codebase/.tool/notes.md": stale,
        "docs/rfcs/0001-demo.md": stale,
        "docs/bugs/2026-08-03-demo.md": stale,
        "docs/reference/mcp-tools.md": stale,
        "AGENTS.md": stale,
        "CHANGELOG.md": stale,
        "apps/docs/src/content/docs/api/index.md": stale
      }))
    )
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(
      "2 codebase pages stamped at 1 commit, 8 line citations read there"
    )
  })

  it("ignores a generator's working directories under docs/codebase/", () => {
    const ignored = (path: string) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: REPO_ROOT }).status === 0
    expect(ignored("docs/codebase/.work/notes.md")).toBe(true)
    expect(ignored("docs/codebase/architecture/overview.md")).toBe(false)
  })

  it("is part of `check`, and each CI job that runs it clones the history it reads", async () => {
    // Four declarations have to agree, the same shape lint-surface.test.ts asserts for lint:repo:
    // the root script, turbo's `//#` root task, `check`'s task list, and the mise task. A stamp
    // names an older commit, so no checkout in a job that runs `check` may be shallow.
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>
    }
    expect(manifest.scripts["docs:citations"]).toBe("node scripts/doc-citations.mjs")
    expect(manifest.scripts.check?.split(/\s+/)).toContain("docs:citations")
    expect(await readFile(join(REPO_ROOT, "turbo.json"), "utf8")).toContain('"//#docs:citations"')
    expect(await readFile(join(REPO_ROOT, "mise.toml"), "utf8")).toContain(
      '[tasks."docs:citations"]'
    )

    const directory = join(REPO_ROOT, ".github", "workflows")
    const checking: Array<string> = []
    for (const name of (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file))) {
      for (const job of jobsOf(await readFile(join(directory, name), "utf8"))) {
        // A line that is the whole command, alone or in a `run: |` block; a comment is not one.
        if (
          !/^\s*(?:-\s+)?(?:run:\s+)?(?:pnpm(?: run)? check|mise run check)\s*$/m.test(job.body)
        ) {
          continue
        }
        checking.push(`${name}#${job.name}`)
        const checkouts = job.body
          .split(/^(?= {6}- )/m)
          .filter((step) => /uses: actions\/checkout@/.test(step))
        expect(checkouts.length, `${name}#${job.name} checks out the repository`).toBeGreaterThan(0)
        for (const step of checkouts) {
          expect(step, `${name}#${job.name} checks out full history`).toMatch(
            /^\s+fetch-depth: 0\s*$/m
          )
        }
      }
    }
    // The census is read from the workflows, so a new job that runs `check` is covered; these two
    // are named so that a parser that found nothing cannot pass.
    expect(checking).toContain("check.yml#check")
    expect(checking).toContain("release-please.yml#publish")
  })
})
