import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SCRIPT = join(REPO_ROOT, "scripts", "doc-citations.mjs")

/**
 * That `scripts/doc-citations.mjs` fails on each kind of bad citation, and passes the good ones.
 *
 * Every case runs the script with `--root` against a throwaway git repository holding one small
 * source file and a doc that cites it, so the assertions are about the rules rather than about the
 * state of this repository's own docs (which `mise run check` runs the script over directly). Each
 * bad case plants exactly ONE bad citation into an otherwise passing tree and requires exactly one
 * failure naming its file and line: a rule that stopped firing fails its case, and a rule that
 * started firing on a good citation fails the passing case.
 */

const SOURCE = `/** The store's surface. */
export interface StoreShape {
  readonly write: (path: string) => void
}

export const makeStore = (): StoreShape => {
  const write = (path: string): void => {
    void path
  }
  return { write }
}

export class Ledger {
  append(entry: string): string {
    return \`\${entry}\\n\`
  }
}

export type Rel = "supersedes" | "contradicts"
`

/** One citation of every passing form, plus spans that look like citations and are not. */
const GOOD_DOC = `# Good

The store is \`packages/demo/src/store.ts::makeStore\`, which writes through
\`packages/demo/src/store.ts::makeStore::write\` behind \`packages/demo/src/store.ts::StoreShape::write\`.
A ledger entry goes through \`packages/demo/src/store.ts::Ledger::append\`, and a rel is a
\`packages/demo/src/store.ts::Rel\`. The schema is \`packages/demo/migrations/0001_files.sql\`, the
sources sit in \`packages/demo/src/\`, every package has \`packages/*/src\`, and the build writes
\`packages/demo/dist/store.js\`.

Not citations: \`Schema::Struct\`, \`2026-08-24T13:00Z\`, \`23:59:60\`, \`http://127.0.0.1:4000\`.

\`\`\`text
packages/demo/src/store.ts:3 sits in a fence, which holds an example rather than a citation.
\`packages/demo/src/store.ts:3\`
\`\`\`
`

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

describe("scripts/doc-citations.mjs", () => {
  let scratch: string
  let serial = 0
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "doc-citations-tests-"))
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  /** A committed tree that passes, plus `extra` files written after the commit; returns its root. */
  const tree = async (extra: (head: string) => Record<string, string> = () => ({})) => {
    const root = join(scratch, `tree-${serial++}`)
    const files: Record<string, string> = {
      "packages/demo/src/store.ts": SOURCE,
      "packages/demo/migrations/0001_files.sql": "CREATE TABLE files (path TEXT PRIMARY KEY);\n",
      "docs/good.md": GOOD_DOC,
      "README.md": "# Demo\n\nSee `packages/demo/src/store.ts::makeStore`.\n"
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
    git(root, ["init", "-q", "-b", "main"])
    git(root, ["add", "."])
    git(root, ["commit", "-q", "-m", "fixture"])
    const head = git(root, ["rev-parse", "HEAD"])
    for (const [path, text] of Object.entries(extra(head))) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
    return root
  }

  it("passes every good citation form, and skips fences and look-alikes", async () => {
    const run = runCheck(await tree())
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain("doc citations ok: 6 symbol citations and 4 repository paths")
  })

  const ZERO = "0".repeat(40)
  it.each([
    ["a line", "docs/bad.md", "Writes (`packages/demo/src/store.ts:7`).", "cites a line"],
    ["a line range", "docs/bad.md", "Writes (`packages/demo/src/store.ts:6-11`).", "cites a line"],
    ["a continuation", "docs/bad.md", "Writes (`:7`).", "cites a line"],
    [
      "a list of lines",
      "docs/bad.md",
      "Writes (`packages/demo/src/store.ts:6, :14`).",
      "cites a line"
    ],
    ["a bare file name", "docs/bad.md", "Writes (`store.ts:7`).", "cites a line"],
    [
      "an undeclared top-level symbol",
      "docs/bad.md",
      "`packages/demo/src/store.ts::makeIndex`",
      "declares no `makeIndex`"
    ],
    [
      "a nested symbol its owner does not declare",
      "docs/bad.md",
      "`packages/demo/src/store.ts::makeStore::remove`",
      "declares no `makeStore::remove`"
    ],
    [
      "a member the named class does not declare, though the file does",
      "docs/bad.md",
      "`packages/demo/src/store.ts::Ledger::write`",
      "declares no `Ledger::write`"
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
      "a line in a docs-site page",
      "apps/docs/src/content/docs/internals/bad.md",
      "Writes (`packages/demo/src/store.ts:7`).",
      "cites a line"
    ],
    ["a line in CLAUDE.md", "CLAUDE.md", "Writes (`packages/demo/src/store.ts:7`).", "cites a line"]
  ])("fails on %s", async (_name, file, text, problem) => {
    const run = runCheck(await tree(() => ({ [file]: `# Bad\n\n${text}\n` })))
    expect(run.status, run.stdout).toBe(1)
    const line = `# Bad\n\n${text}`.split("\n").length
    expect(run.stderr).toContain(`${file}:${line}: `)
    expect(run.stderr).toContain(problem)
    expect(run.stderr).toContain("FAILED: 1 problem.")
  })

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
    ]
  ])("fails a docs/codebase page with %s", async (_name, page, problem) => {
    const run = runCheck(await tree(() => ({ "docs/codebase/architecture/overview.md": page() })))
    expect(run.status, run.stdout).toBe(1)
    expect(run.stderr).toContain("docs/codebase/architecture/overview.md:")
    expect(run.stderr).toContain(problem)
    expect(run.stderr).toContain("FAILED: 1 problem.")
  })

  it("reads no line citation where it does not apply", async () => {
    // A stamped codebase page, a frozen RFC, a dated bug report, a generated reference page, and a
    // tool's dot-directory under docs/codebase all keep their `path:N` citations: none is a hand doc.
    const stale = "Writes (`packages/demo/src/store.ts:7`).\n"
    const run = runCheck(
      await tree((head) => ({
        "docs/codebase/architecture/overview.md": `---\ncommit: ${head}\n---\n\n${stale}`,
        "docs/codebase/insights/debt.md": `# Debt\n\n> Built from commit [${head.slice(0, 7)}](x).\n\n${stale}`,
        "docs/codebase/.tool/notes.md": stale,
        "docs/rfcs/0001-demo.md": stale,
        "docs/bugs/2026-08-03-demo.md": stale,
        "docs/reference/mcp-tools.md": stale,
        "apps/docs/src/content/docs/agents.md": stale,
        "apps/docs/src/content/docs/api/index.md": stale
      }))
    )
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain("2 codebase pages stamped at 1 commit")
  })

  it("is part of `check`, and CI clones the history it reads", async () => {
    // Four declarations have to agree, the same shape lint-surface.test.ts asserts for lint:repo:
    // the root script, turbo's `//#` root task, `check`'s task list, and the mise task. A stamp
    // names an older commit, so the CI checkout must not be shallow.
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>
    }
    expect(manifest.scripts["docs:citations"]).toBe("node scripts/doc-citations.mjs")
    expect(manifest.scripts.check?.split(/\s+/)).toContain("docs:citations")
    expect(await readFile(join(REPO_ROOT, "turbo.json"), "utf8")).toContain('"//#docs:citations"')
    expect(await readFile(join(REPO_ROOT, "mise.toml"), "utf8")).toContain(
      '[tasks."docs:citations"]'
    )
    const workflow = await readFile(join(REPO_ROOT, ".github", "workflows", "check.yml"), "utf8")
    const job = workflow.slice(workflow.indexOf("\n  check:"), workflow.indexOf("\n  package:"))
    expect(job).toMatch(/actions\/checkout@\S+[^\n]*\n\s+with:\n\s+fetch-depth: 0\n/)
  })
})
