import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"
import { cliEntryPoint } from "./spawned.js"

/**
 * `session exec` driven the way an agent drives it: the BUILT binary, a real temp store, and the
 * script delivered as a heredoc on stdin by a real `/bin/bash` (`docs/v2-poc.md`, "Heredoc scripts").
 *
 * The heredoc is the point, so it is not simulated by writing a string to the child's stdin: each
 * case hands bash one command line ending in `<<'SH'`, the script, and `SH`, which is the text an
 * agent's shell tool runs. The opener is quoted, so bash expands nothing inside it and the bytes the
 * script holds (`$`, backticks, quotes, a nested `<<'HTML'`) reach `memhtml` exactly as written.
 *
 * The child runs with `MEMHTML_ROOT` and `MEMHTML_TRACE_ROOT` removed and `MEMHTML_REFUSE_ENV_ROOT`
 * set, so `--repo` is the only door to a store and a call that dropped it would be refused.
 *
 * Mutations, each run once with the change applied and the named cases red:
 * - `session-exec.ts` `runSessionExec`: the job's `command: input.lang === "js" ? ... : input.script`
 *   -> always `js-exec ${GUEST_SCRIPT}` -> (a), (b), (c), and (e) (every bash script is a JS parse
 *   error).
 * - the same line -> always `input.script` -> (d) (the JS module is a bash parse error).
 * - `exec-lang.ts` `DEFAULT_EXEC_LANG` -> `"js"` -> (a), (b), (c), and (e), which pass no `--lang`.
 * - `run.ts`: `lang: ... ?? DEFAULT_EXEC_LANG` -> `lang: DEFAULT_EXEC_LANG` -> (d) (`--lang js` is
 *   ignored).
 * - `v2.ts` `sessionExec`: drop `lang: report.lang` from the payload -> every case's `lang` check.
 * - `session-exec.ts`: drop `maxCommandCount` and `maxLoopIterations` from the bash limits -> (e)
 *   (exit 126 "too many commands executed" long before the bound).
 * - `curate-run.ts`: the curator's `lang: "js"` -> `lang: "bash"` -> four exec cases in
 *   `apps/cli/tests/curate-run.test.ts` and five in `v2-curator.test.ts` (the fake model's JS is a
 *   bash parse error), which is why `lang` is a required field rather than a default.
 */

const AT = "2026-09-20T12:00:00Z"
const SLUG = "heredoc-demo"

/** A seeded record under the workspace, anchored by its path, so it clears the write bar. */
const demoRecord = (index: number) => ({
  path: `projects/${SLUG}/fact-${index}.html`,
  html: renderTemplate({
    title: `Heredoc demo fact ${index}`,
    claim: `The heredoc demo pipeline runs stage ${index} per record.`,
    body: [`Stage ${index} reads one record and writes one line.`],
    memoryType: "semantic",
    at: AT
  })
})

/** A curated record: `session exec` must neither write it nor report it (the reserved-path fix). */
const ARC = {
  path: "areas/arcs/heredoc-demo-arc.html",
  html: renderTemplate({
    title: "Heredoc demo arc",
    claim: "The heredoc demo stages form one pipeline.",
    memoryType: "semantic",
    at: AT,
    entities: ["system:heredoc-demo"]
  })
}

const SEEDED = [1, 2, 3].map(demoRecord)

/** The fields of `session.exec.report` these cases read. */
interface ExecData {
  readonly lang: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly timeoutMs: number
  readonly ops: number
  readonly appended: number
  readonly opsTotal: number
  readonly harvested: ReadonlyArray<{ readonly kind: string; readonly path: string }>
  readonly rejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>
  readonly blocking: ReadonlyArray<string>
}

let cli: Cli

/** The child's environment: no ambient store, no transcript root, no model, `--repo` required. */
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEMHTML_EMBED: "off",
    MEMHTML_LLM: "off",
    MEMHTML_REFUSE_ENV_ROOT: "1"
  }
  delete env.MEMHTML_ROOT
  delete env.MEMHTML_TRACE_ROOT
  return env
}

/** Single-quote one word for bash. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * Run `memhtml <argv> --repo <root>` through `/bin/bash` with `script` as a quoted heredoc on its
 * stdin, and parse the one envelope it prints.
 */
const heredoc = (
  argv: ReadonlyArray<string>,
  script: string
): Promise<{ readonly exitCode: number; readonly envelope: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const words = [process.execPath, cliEntryPoint, ...argv, "--repo", cli.root].map(quoted)
    const line = `${words.join(" ")} <<'SH'\n${script}\nSH\n`
    const child = spawn("/bin/bash", ["-c", line], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.once("error", reject)
    child.once("close", (code) => {
      try {
        resolve({ exitCode: code ?? 0, envelope: JSON.parse(stdout) as Record<string, unknown> })
      } catch {
        reject(new Error(`no envelope (exit ${String(code)}): ${stdout}\n${stderr}`))
      }
    })
  })

/** `session exec --id <id> [extra]` with a heredoc, answered as its `data`. */
const exec = async (
  id: string,
  script: string,
  extra: ReadonlyArray<string> = []
): Promise<ExecData> => {
  const { exitCode, envelope } = await heredoc(["session", "exec", "--id", id, ...extra], script)
  expect(envelope.error, JSON.stringify(envelope)).toBeUndefined()
  expect(envelope.type).toBe("session.exec.report")
  expect(exitCode).toBe(0)
  return envelope.data as ExecData
}

beforeAll(async () => {
  cli = await makeCli()
  for (const file of [...SEEDED, ARC]) {
    const target = join(cli.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await cli.git("add", "-A")
  await cli.git("commit", "-q", "-m", "seed the heredoc fixture")
}, 60_000)

afterAll(async () => {
  await cli.cleanup()
})

describe("session exec reads a bash heredoc by default", () => {
  it("(a) a grep | wc read returns its stdout and harvests nothing", async () => {
    await cli.json(["session", "start", "--id", "read"])
    const report = await exec(
      "read",
      `grep -rl 'heredoc demo pipeline' /mnt/memhtml/projects | wc -l`
    )
    expect(report.lang).toBe("bash")
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.stdout.trim()).toBe(String(SEEDED.length))
    expect(report.ops).toBe(0)
    expect(report.harvested).toEqual([])
    // The seeded arc is unchanged, so it is not a write and is not reported.
    expect(report.rejected).toEqual([])
    expect(report.opsTotal).toBe(0)
  }, 120_000)

  it("(b) a nested heredoc that writes a record at the bar harvests one put", async () => {
    await cli.json(["session", "start", "--id", "write"])
    const path = `projects/${SLUG}/written-by-heredoc.html`
    const html = renderTemplate({
      title: "Written by a heredoc",
      claim: "A nested heredoc inside a session exec script writes one record into the overlay.",
      body: ["The outer heredoc is the script; the inner one is the file's bytes, `$HOME` intact."],
      memoryType: "semantic",
      at: AT
    })
    const report = await exec(
      "write",
      [
        `cat > /mnt/memhtml/${path} <<'HTML'`,
        html.trimEnd(),
        "HTML",
        `wc -c < /mnt/memhtml/${path}`
      ].join("\n")
    )
    expect(report.lang).toBe("bash")
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.stdout.trim()).toBe(String(Buffer.byteLength(html.trimEnd(), "utf8") + 1))
    expect(report.harvested).toEqual([{ kind: "put", path }])
    expect(report.blocking).toEqual([])
    expect(report.appended).toBe(1)

    const committed = await cli.json<{ readonly kind: string }>([
      "session",
      "commit",
      "--id",
      "write",
      "--message",
      "a record from a heredoc"
    ])
    expect(committed.kind).toBe("committed")
    expect(await cli.git("show", `main:${path}`)).toBe(`${html.trimEnd()}\n`)
  }, 120_000)

  it("(c) a sed -i that splices one memhtml-entity meta into a head harvests one label op", async () => {
    await cli.json(["session", "start", "--id", "label"])
    const target = SEEDED[1]?.path ?? ""
    const report = await exec(
      "label",
      `sed -i 's#</head>#<meta name="memhtml-entity" content="system:heredoc-demo">\\n</head>#' /mnt/memhtml/${target}`
    )
    expect(report.lang).toBe("bash")
    expect(report.exitCode, report.stderr).toBe(0)
    expect(report.harvested).toEqual([{ kind: "label", path: target }])
    expect(report.rejected).toEqual([])
    expect(report.blocking).toEqual([])
    expect(report.appended).toBe(1)
    const status = await cli.json<{ readonly labels: number }>([
      "session",
      "status",
      "--id",
      "label"
    ])
    expect(status.labels).toBe(1)
  }, 120_000)

  it("(d) --lang js still runs the script as a JavaScript module", async () => {
    await cli.json(["session", "start", "--id", "js"])
    const report = await exec(
      "js",
      [
        'import { corpus } from "/workspace/lib/corpus.mjs"',
        "const memories = corpus()",
        "console.log(JSON.stringify({ size: memories.size, sum: 1 + 1 }))"
      ].join("\n"),
      ["--lang", "js"]
    )
    expect(report.lang).toBe("js")
    expect(report.exitCode, report.stderr).toBe(0)
    // Counted outside the sandbox: every memory file on main, which by now includes (b)'s commit.
    const onMain = (await cli.git("ls-tree", "-r", "--name-only", "main"))
      .split("\n")
      .filter((path) => /^(projects|areas|resources|archive)\/.*\.html$/.test(path)).length
    expect(onMain).toBeGreaterThan(SEEDED.length)
    expect(JSON.parse(report.stdout)).toEqual({ size: onMain, sum: 2 })
    expect(report.ops).toBe(0)
  }, 120_000)

  it("(e) a bash loop past --timeout-ms reports exit 124 and timedOut", async () => {
    await cli.json(["session", "start", "--id", "loop"])
    const report = await exec("loop", "while true; do :; done", ["--timeout-ms", "2500"])
    expect(report.lang).toBe("bash")
    expect(report.stderr).toContain("exceeded execution deadline (2500ms)")
    expect(report.exitCode).toBe(124)
    expect(report.timedOut).toBe(true)
    expect(report.timeoutMs).toBe(2500)
    expect(report.appended).toBe(0)
  }, 120_000)

  it("a bad --lang is a usage error at exit 2 naming both languages", async () => {
    const { exitCode, envelope } = await heredoc(
      ["session", "exec", "--id", "read", "--lang", "python"],
      "print(1)"
    )
    expect(exitCode).toBe(2)
    expect(envelope.code).toBe("ERR_INVALID_FLAG")
    expect(String(envelope.error)).toContain("bash, js")
  }, 60_000)
})
