#!/usr/bin/env node
/**
 * Install the assembled `memhtml` the way a user would, and drive every subsystem through it.
 *
 * `mise run check` proves the WORKSPACE works and is structurally blind to what npm serves: it
 * resolves `@memhtml/*` through pnpm's links, where every asset is on disk whether or not a manifest
 * names it. Three assets shipped broken under exactly that blindness. So this tier packs, installs into
 * a throwaway directory, and runs the binary — the only check whose subject is the artifact.
 *
 * Not part of `check`: it reaches the npm registry to resolve the external dependencies, and
 * `check` is offline and credential-free by construction. CI runs it as its own job, and the publish
 * job runs it on the tag before publishing.
 *
 * ## Two modes
 *
 * By DEFAULT every command runs with `MEMHTML_EMBED=off` and `MEMHTML_LLM=off`, so nothing needs a
 * credential and CI can gate on it. Everything else is real: a real git repository, real migrations, a
 * real QuickJS sandbox, and a real MCP session carrying `tools/call` and `resources/read` traffic over
 * stdio.
 *
 * With `--live` it additionally drives the edge that reaches the network, which is the only way to
 * prove it from an install: Bedrock embeddings. That is the whole of what the default mode cannot see,
 * so `--live` is the difference between "every command answers" and "every command works".
 * It needs `AWS_BEARER_TOKEN_BEDROCK` (or SigV4 keys, or an LLM proxy on `MEMHTML_LLM_BASE_URL`) and
 * it spends real tokens.
 */
import { execFile, spawn } from "node:child_process"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const STAGING = join(REPO_ROOT, "dist-package")

/**
 * Drop the variables by which the environment, not `-C`, decides which repository a git call
 * operates on. This script runs under lefthook's pre-push, where git exports an absolute `GIT_DIR`
 * from a linked worktree; inherited, it re-aims this script's own `git rev-parse`/`worktree` probes
 * — and, through the spawned children, every corpus the smoke builds — at the repository being
 * pushed. The installed CLI scrubs its own git spawns (`GIT_REPO_SELECTION_ENV`,
 * `packages/store/src/git.ts`); this is the same scrub for the harness's process tree.
 */
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES"
]) {
  delete process.env[name]
}

/** `--live` also drives Bedrock. Off by default so the gate stays credential-free. */
const LIVE = process.argv.includes("--live") || process.env.MEMHTML_SMOKE_LIVE === "1"

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  process.stderr.write(
    `${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}\n`
  )
}

/**
 * Run one check, and let a throw be a FAILED check rather than the end of the run.
 *
 * A broken artifact makes the CLI exit non-zero, which `execFile` raises. Aborting there would report
 * the first break and hide every other one, so an operator would fix and re-run once per defect.
 */
const check = async (name, body) => {
  try {
    const { ok, detail } = await body()
    record(name, ok, detail)
  } catch (cause) {
    record(name, false, String(cause).split("\n")[0])
  }
}

/** One envelope per command, on stdout, and nothing else. That contract is what makes this parseable. */
/**
 * One command's JSON envelope.
 *
 * A NONZERO exit needs nothing added here: `execFile`'s rejection already carries the child's whole
 * stderr in `error.message` (`Command failed: <cmd>\n<stderr>` — probed 2026-08-25 against node 24, a
 * 60 KiB stderr arriving intact), so letting it propagate reports the cause. What this shape cannot
 * carry is a command that exits 0 having logged why it degraded, which is {@link envelopeWithLog}.
 */
const envelope = async (bin, args, env) => {
  const { stdout } = await exec(bin, args, { env, maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout)
}

/**
 * One command's RAW stdout, its exit code, and a payload written to its stdin.
 *
 * `envelope` cannot express `memhtml hook`, and that is a contract rather than an inconvenience: a hook's
 * stdout is the HOST'S protocol — plain text for Claude Code and OpenCode, that host's JSON for Codex and
 * Cursor, or nothing at all — so parsing it as an envelope would fail on the one command whose success is
 * defined by never writing one. A hook also reads its payload on stdin, which `execFile` gives no seam
 * for. stderr comes back too, because a hook that decided to print nothing says why on that stream.
 */
const runRaw = (bin, args, env, stdin = "") =>
  new Promise((done, fail) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", fail)
    child.once("close", (code) => done({ stdout, stderr, exitCode: code ?? 0 }))
    child.stdin.end(stdin)
  })

/**
 * Is this stdout one of THIS tool's envelopes?
 *
 * Asserted NEGATIVELY for `memhtml hook`: a hook that wrote `{"apiVersion":"1",…}` into a host's context
 * window would exit 0, print something, and be wrong in the only way that matters. `apiVersion` is the
 * discriminator rather than "parses as JSON", because two hosts' hook protocols ARE JSON.
 */
const looksLikeEnvelope = (text) => {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && "apiVersion" in parsed
  } catch {
    return false
  }
}

/** How much of a child's stderr a check's detail carries: enough for a stack, not for a log. */
const STDERR_TAIL_CHARS = 400

/**
 * The END of what a child wrote, which is where a dying one says why.
 *
 * A message rendered from the HEAD of a child's output shows its banner, not its last words.
 */
const tail = (text) => text.slice(-STDERR_TAIL_CHARS).trim()

const main = async () => {
  const work = await mkdtemp(join(tmpdir(), "memhtml-smoke-"))
  const consumer = join(work, "consumer")
  const corpus = join(work, "corpus")
  const cache = join(work, "cache")

  try {
    const { stdout: packed } = await exec("npm", ["pack", "--json"], {
      cwd: STAGING,
      maxBuffer: 32 * 1024 * 1024
    })
    /**
     * npm ≤11 emits an array of pack reports; npm 12 emits an object keyed by package name
     * (probed live, npm 12.0.2: `{"memhtml": {"filename": …}}`). Accept both, and fail with the
     * raw head rather than a property-of-undefined when neither shape carries a filename.
     */
    const parsed = JSON.parse(packed)
    const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    if (typeof report?.filename !== "string") {
      throw new Error(`npm pack --json reported no filename: ${packed.slice(0, 200)}`)
    }
    const tarball = join(STAGING, report.filename)

    await exec("mkdir", ["-p", consumer])
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "memhtml-smoke-consumer", private: true, version: "1.0.0" }, null, 2)
    )
    await exec("npm", ["install", "--no-audit", "--no-fund", tarball], {
      cwd: consumer,
      maxBuffer: 64 * 1024 * 1024
    })

    const bin = join(consumer, "node_modules", ".bin", "memhtml")
    const mcpBin = join(consumer, "node_modules", ".bin", "memhtml-mcp")
    const env = {
      ...process.env,
      MEMHTML_ROOT: corpus,
      MEMHTML_EMBED: "off",
      MEMHTML_LLM: "off",
      XDG_CACHE_HOME: cache,
      /**
       * A git identity, supplied by ENVIRONMENT rather than config.
       *
       * `memhtml init` commits the scaffold, and `git commit` fails with exit 128 on a machine with no
       * identity — which a CI runner is. That is a real precondition of the tool rather than an
       * artifact defect (`packages/store/src/layout.ts` says so, and the fixture helper in
       * `packages/store/src/testing.ts` sets an identity for the same reason), so it is supplied here
       * rather than worked around. Env vars and not `git config`, because there is no repository to
       * configure until `init` has made one.
       *
       * Setting it here means this tier cannot see that precondition. `RUNBOOK.md` §1 and the install
       * tutorial state it instead, which is where a user hitting exit 128 would look.
       */
      GIT_AUTHOR_NAME: "memhtml smoke",
      GIT_AUTHOR_EMAIL: "smoke@memhtml.invalid",
      GIT_COMMITTER_NAME: "memhtml smoke",
      GIT_COMMITTER_EMAIL: "smoke@memhtml.invalid"
    }

    await check("manifest names the published binary", async () => {
      const manifest = await envelope(bin, ["manifest"], env)
      return { ok: manifest.data?.name === "memhtml", detail: manifest.data?.version }
    })

    await check("init scaffolds a git repository", async () => {
      const init = await envelope(bin, ["init"], env)
      return { ok: init.data?.created === true && typeof init.data?.headSha === "string" }
    })

    /**
     * The first memory's path, captured for the hook census.
     *
     * `memhtml hook user-prompt-submit` proves itself by naming a memory this corpus holds, and the path
     * is taken from the write's own report rather than composed from the title — the slug rule is the
     * store's, and a check that restated it would assert this script's guess at it.
     */
    let vipPath = ""

    await check("write commits one memory", async () => {
      const written = await envelope(
        bin,
        [
          "write",
          "--title",
          "Draining the VIP before a revert keeps connections off the old target group",
          "--claim",
          "Drain the VIP before reverting a deploy.",
          "--body",
          "The revert alone leaves in-flight connections pinned to the old target group.",
          "--type",
          "semantic",
          "--workspace",
          "checkout-api"
        ],
        env
      )
      vipPath = written.data?.path ?? ""
      return { ok: written.data?.created === true && Boolean(written.data?.commitSha) }
    })

    await check("the commit is in the corpus repo", async () => {
      // Against git itself, not against the report: the commit is the system of record.
      const { stdout: log } = await exec("git", ["-C", corpus, "log", "--oneline"])
      return { ok: log.split("\n").filter(Boolean).length >= 2 }
    })

    await check("search returns the memory", async () => {
      const found = await envelope(bin, ["search", "VIP revert"], env)
      return { ok: (found.data?.hits ?? []).length >= 1 }
    })

    await check("the index answers after migrating", async () => {
      // Migrations resolve from inside the tarball: the `../migrations` walk under test.
      const index = await envelope(bin, ["index", "status"], env)
      return { ok: index.type === "index.report" }
    })

    await check("code mode parses the corpus in the sandbox", async () => {
      const script = join(work, "traverse.mjs")
      await writeFile(
        script,
        'import { corpus, walk, ROOT } from "/workspace/lib/corpus.mjs"\n' +
          "console.log(JSON.stringify({ files: walk(ROOT).length, memories: corpus().size }))\n"
      )
      const ran = await envelope(bin, ["exec", "--file", script], env)
      const guest = JSON.parse((ran.data?.stdout ?? "{}").trim() || "{}")
      // The guest PARSED html, which only happens if node-html-parser's bytes reached QuickJS.
      return {
        ok: ran.data?.exitCode === 0 && guest.memories >= 1,
        detail: `memories=${String(guest.memories)}`
      }
    })

    for (const [label, target, args] of [
      ["memhtml-mcp", mcpBin, []],
      ["memhtml serve mcp", bin, ["serve", "mcp"]]
    ]) {
      await check(`${label} answers the MCP handshake`, async () => {
        const answer = await handshake(target, args, env)
        return { ok: answer?.result?.protocolVersion === "2025-06-18" }
      })
    }

    await checkEveryCommand({ bin, work, env, vipPath })
    await checkEveryMcpTool({ mcpBin, env })
    await checkEveryResource({ mcpBin, env })
    if (LIVE) await checkLiveBedrock({ bin, work, env })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Every command the binary declares, run against the installed artifact.
 *
 * The checks above are a scenario: they prove the paths a first-time user walks. They are not coverage,
 * and the difference matters here more than it usually would — this is the ONLY tier that runs the
 * published bytes, so a command it never invokes is a command nobody has ever run from an install.
 *
 * So the surface is enumerated from `memhtml manifest` — the binary's own table, which also drives its
 * argument parsing — and every entry is either INVOKED or EXCUSED with a reason. A command that is
 * neither fails the census, at the commit that adds it.
 *
 * Ordering is state, not taste: `read` needs something written, `link` needs two paths, `neighbors`
 * needs the link, and `archive` moves a file so it runs last.
 */
const checkEveryCommand = async ({ bin, work, env, vipPath }) => {
  const manifest = await envelope(bin, ["manifest"], env)
  const declared = manifest.data.commands.map((command) => command.name)

  const corpus = env.MEMHTML_ROOT

  /**
   * A throwaway `$HOME` for the `integrations` family, which is the one family that writes OUTSIDE the
   * corpus.
   *
   * `integrations install` at user scope writes `~/.claude.json`, `~/.claude/settings.json`, an
   * instruction file, a skill, and a receipt under `~/.config/memhtml`. Run with the inherited `HOME`
   * this tier would rewire the operator's own coding agents — and lefthook runs it on pre-push. So HOME
   * is a directory under `work`, which the `finally` in {@link main} removes. `~/.claude` is created
   * first because that is the directory a host's presence is detected by, so the install runs against
   * the shape a real machine has rather than an empty home.
   */
  const home = join(work, "home")
  await exec("mkdir", ["-p", join(home, ".claude")])
  // An operator's own `MEMHTML_TRACE_ROOT` would point the installed hooks at a real transcript tree and
  // make `doctor` read green here while failing on a clean runner, so the family sees the default root.
  const homed = Object.fromEntries(
    Object.entries({ ...env, HOME: home }).filter(([key]) => key !== "MEMHTML_TRACE_ROOT")
  )
  const traceRoot = join(work, "traces")
  await exec("mkdir", ["-p", join(traceRoot, "projects", "-smoke")])
  await writeFile(
    join(traceRoot, "projects", "-smoke", "s1.jsonl"),
    `${JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", message: { role: "user", content: "the VIP drain question" } })}\n`
  )
  const traced = { ...env, MEMHTML_TRACE_ROOT: traceRoot }

  /**
   * Two memories written HERE, so `link` gets distinct endpoints.
   *
   * Taking one path from `list` instead handed back the same memory twice — the list is
   * recency-ordered, so its first entry was the write just made — and `link` correctly refused a
   * self-edge. Each write reports its own path; use that.
   */
  const writeTwo = async (title, claim) =>
    (
      await envelope(
        bin,
        [
          "write",
          "--title",
          title,
          "--claim",
          claim,
          "--type",
          "semantic",
          "--workspace",
          "checkout-api"
        ],
        env
      )
    ).data.path

  const pathA = await writeTwo("A drain precedes every revert", "Drain, then revert.")
  const pathB = await writeTwo(
    "A revert without a drain keeps serving",
    "Reverting alone does not drain."
  )

  const task = await envelope(
    bin,
    ["task", "add", "--title", "Drain the VIP before the next revert"],
    env
  )
  const taskPath = task.data?.path

  const applyFile = join(work, "ops.jsonl")
  await writeFile(
    applyFile,
    // `body`, not `claim`: the batch op vocabulary is its own snake_case surface and `memhtml apply`
    // rejects an unknown field by name. `memhtml manifest` lists the accepted set.
    `${JSON.stringify({ op: "write", title: "Applied through the batch door", body: "Batch writes share one commit.", type: "semantic", workspace: "checkout-api" })}\n`
  )

  const sessionOpsFile = join(work, "session-ops.jsonl")
  await writeFile(
    sessionOpsFile,
    `${JSON.stringify({ op: "write", title: "Landed through a v2 session", body: "A session's overlay lands as one commit through its own index file.", type: "semantic" })}\n`
  )

  const curatorOpsFile = join(work, "curator-ops.jsonl")
  await writeFile(
    curatorOpsFile,
    `${JSON.stringify({ op: "write", title: "Landed through the curation door", body: "A curator session commits to its own branch and curate merge fast-forwards main to it.", type: "semantic" })}\n`
  )

  const execFile_ = join(work, "census.mjs")
  await writeFile(
    execFile_,
    'import { corpus } from "/workspace/lib/corpus.mjs"\nconsole.log(corpus().size)\n'
  )

  /**
   * `[command, argv, env, assert]`. A command with no entry here must appear in COVERED_ELSEWHERE below.
   *
   * `assert` is optional and takes the parsed envelope: the loop's own bar is "it answered with a
   * `type`", which is the right bar for a command whose payload other tiers assert, and too low for one
   * whose whole point is a particular payload. A row that names an assertion gets both.
   */
  const INVOCATIONS = [
    ["manifest", ["manifest"]],
    // Piped, so the answer is the `cli.help` envelope; the Markdown shape needs a terminal, which
    // this harness is not.
    ["help", ["help", "search"]],
    ["init", ["init"]],
    ["write", ["write", "--title", "Third memory", "--claim", "Three.", "--type", "semantic"]],
    ["apply", ["apply", "--file", applyFile]],
    ["read", ["read", pathA]],
    ["search", ["search", "VIP revert"]],
    ["recall", ["recall", "VIP revert"]],
    // `--title` alone is a usage error by design — the command's own suggestions name `--claim` or
    // `--article-html`, because a correction with no new content is a rename, not a correction.
    // Before `correct`: a correction rewrites its target to a new slug, so any path captured earlier is
    // stale afterwards. `link` refused the resulting dangling edge, which is the store being right.
    ["link", ["link", pathA, "relates_to", pathB]],
    ["neighbors", ["neighbors", pathA]],
    ["resolve", ["resolve", pathA]],
    ["reinforce", ["reinforce", pathA]],
    [
      "correct",
      [
        "correct",
        pathB,
        "--title",
        "A revert without a drain keeps serving",
        "--claim",
        "Reverting alone leaves the old group serving."
      ]
    ],
    ["list", ["list"]],
    ["entity activity", ["entity", "activity"]],
    ["task add", ["task", "add", "--title", "Second task"]],
    ["task list", ["task", "list"]],
    ["task status", ["task", "status", taskPath, "doing"]],
    ["index update", ["index", "update"]],
    ["index embed", ["index", "embed"]],
    ["index rebuild", ["index", "rebuild"]],
    ["index status", ["index", "status"]],
    ["trace index", ["trace", "index"], traced],
    ["trace search", ["trace", "search", "VIP"], traced],
    // One of `--session-id` / `--path` is required, which is an either-or no `required` flag can
    // express, so neither is marked and a bare call is a usage error.
    ["trace links", ["trace", "links", "--session-id", "s1"], traced],
    ["status", ["status"]],
    ["publish", ["publish"]],
    ["doctor", ["doctor"]],
    [
      "eval discriminate",
      ["eval", "discriminate", "--mode", "fake", "--probes", "4", "--size", "12"]
    ],
    ["exec", ["exec", "--file", execFile_]],
    ["state export", ["state", "export"]],
    ["state import", ["state", "import"]],
    ["agents-doc", ["agents-doc", "--out", join(work, "AGENTS.md")]],
    /*
     * The `integrations` family, in the order one host's life takes: install it, see it listed, check it,
     * print the shell snippet, remove it. Every row carries the throwaway `HOME`, because these are the
     * only commands here that write outside the corpus.
     *
     * `install` names a host explicitly. Bare `install` would detect hosts by home directory, and under a
     * home this script just created that is a check on this script's own mkdir.
     */
    [
      "integrations install",
      ["integrations", "install", "claude"],
      homed,
      (answer) => {
        /*
         * One ROW per host, because a bare `integrations install` installs every host whose home
         * directory exists and a single-host payload could not describe that run. This row is read by
         * name rather than by position.
         */
        const row = (answer.data?.hosts ?? []).find((one) => one.host === "claude")
        const entries = row?.entries ?? []
        return {
          ok:
            answer.type === "integrations.report" &&
            answer.data?.scope === "user" &&
            row?.changed === true &&
            entries.length > 0 &&
            entries.every(
              (entry) =>
                typeof entry.path === "string" &&
                typeof entry.role === "string" &&
                typeof entry.kind === "string"
            ),
          detail: `${String(entries.length)} entries under ${String(answer.data?.scope)} scope: ${entries.map((entry) => entry.role).join(", ")}`
        }
      }
    ],
    [
      "integrations list",
      ["integrations", "list"],
      homed,
      (answer) => {
        const rows = answer.data?.rows ?? []
        const claude = rows.find((one) => one.host === "claude")
        return {
          ok: answer.type === "integrations.list" && claude?.state === "installed",
          detail: rows.map((one) => `${String(one.host)}=${String(one.state)}`).join(" ")
        }
      }
    ],
    /*
     * `doctor` is the one row whose answer reaches back out of the tarball: its last check spawns the
     * `memhtml-mcp` the MCP entry names and waits for an `initialize` reply, so a bundle whose second
     * binary cannot start fails HERE rather than in a user's editor. The detail names every failing check
     * so a red run says which one.
     */
    [
      "integrations doctor",
      ["integrations", "doctor", "claude"],
      homed,
      (answer) => {
        const checks = (answer.data?.hosts ?? []).flatMap((host) => host.checks ?? [])
        const failing = checks.filter((one) => one.ok !== true)
        return {
          ok:
            answer.type === "integrations.doctor" &&
            checks.length > 0 &&
            checks.some((one) => one.name === "mcp-handshake") &&
            answer.data?.healthy === true,
          detail: `healthy=${String(answer.data?.healthy)}, ${String(checks.length)} checks${
            failing.length > 0
              ? `, FAILING: ${failing.map((one) => `${String(one.name)} (${String(one.detail)})`).join("; ")}`
              : ""
          }`
        }
      }
    ],
    // No `--write`: the snippet is reported and no rc file is touched, which is the default and the only
    // form that leaves nothing behind.
    [
      "integrations shell",
      ["integrations", "shell"],
      homed,
      (answer) => ({
        ok:
          answer.type === "integrations.shell" &&
          typeof answer.data?.snippet === "string" &&
          answer.data.snippet.includes("MEMHTML_ROOT"),
        detail: `${String((answer.data?.snippet ?? "").length)} chars`
      })
    ],
    [
      "integrations uninstall",
      ["integrations", "uninstall", "claude"],
      homed,
      (answer) => {
        const row = (answer.data?.hosts ?? []).find((one) => one.host === "claude")
        return {
          ok: answer.type === "integrations.report" && row?.changed === true,
          detail: `${String((row?.entries ?? []).length)} entries removed`
        }
      }
    ],
    /*
     * The v2 proof of concept, in the order one session's life takes: start it on main, append a put
     * from JSONL, run a script over head plus overlay, read it back, commit it (HEAD is main here, so
     * the shared index and working tree must follow: `worktreeSynced` is asserted, because a commit
     * that moved the ref without the index would be undone by the `archive` row below), and rebase
     * it. The head commands run after the commit so the snapshot they write and read is of a tree that
     * holds a session's commit.
     */
    ["session start", ["session", "start", "--id", "smoke"]],
    ["session put", ["session", "put", "--id", "smoke", "--file", sessionOpsFile]],
    ["session exec", ["session", "exec", "--id", "smoke", "--file", execFile_]],
    ["session status", ["session", "status", "--id", "smoke"]],
    [
      "session commit",
      ["session", "commit", "--id", "smoke", "--message", "smoke session"],
      env,
      (answer) => ({
        ok: answer.data?.kind === "committed" && answer.data?.worktreeSynced === true,
        detail: `${String(answer.data?.kind)}, worktreeSynced ${String(answer.data?.worktreeSynced)}`
      })
    ],
    ["session rebase", ["session", "rebase", "--id", "smoke"]],
    /*
     * The curation door: a second session on the unborn `curate/smoke`, created by its commit (HEAD
     * is main, so nothing follows: `worktreeSynced` is asserted false), then `curate merge` lands it
     * on main with the checkout following. `--skip-gate` because the gate's own row above already
     * runs the eval at a size this harness can afford, and here the subject is the landing. The
     * refusals (a missing ref, a non-descendant) are the integration tier's; `envelope` throws on a
     * non-zero exit, so a refusing row could not pass this table.
     */
    ["session start (curator)", ["session", "start", "--id", "curator", "--ref", "curate/smoke"]],
    ["session put (curator)", ["session", "put", "--id", "curator", "--file", curatorOpsFile]],
    [
      "session commit (curator)",
      ["session", "commit", "--id", "curator", "--message", "smoke curation"],
      env,
      (answer) => ({
        ok: answer.data?.kind === "committed" && answer.data?.worktreeSynced === false,
        detail: `${String(answer.data?.kind)} on ${String(answer.data?.ref)}`
      })
    ],
    [
      "curate merge",
      ["curate", "merge", "curate/smoke", "--skip-gate"],
      env,
      (answer) => ({
        ok:
          answer.data?.moved === true &&
          answer.data?.worktreeSynced === true &&
          answer.data?.gate?.ran === false,
        detail: `${String(answer.data?.from).slice(0, 7)} -> ${String(answer.data?.to).slice(0, 7)}, worktreeSynced ${String(answer.data?.worktreeSynced)}`
      })
    ],
    /*
     * The curator itself, on a branch of its own so the merge row above stays about the door and this
     * row about the loop. `--model fake` is the scripted, credential-free curator; over a corpus with
     * no duplicate frame-key pair it finishes with zero ops, so the assertion is on the loop having
     * run to `finish` rather than on a commit.
     */
    [
      "curate run",
      ["curate", "run", "--model", "fake", "--ref", "curate/smoke-run"],
      env,
      (answer) => ({
        ok:
          answer.data?.stoppedBy === "finish" &&
          Array.isArray(answer.data?.toolCalls) &&
          answer.data.toolCalls.includes("exec"),
        detail: `${String(answer.data?.outcome)}, stoppedBy ${String(answer.data?.stoppedBy)} after ${String(answer.data?.steps)} step(s)`
      })
    ],
    /*
     * The collapse, as a dry run: the planner cuts this small corpus (no cluster of two or more is
     * expected), prints the plan, and writes nothing. The assertion is on the planner having run and
     * the payload carrying the plan; the folds themselves are the integration tier's.
     */
    [
      "curate collapse",
      ["curate", "collapse", "--model", "fake", "--ref", "curate/smoke-collapse", "--dry-run"],
      env,
      (answer) => ({
        ok:
          answer.data?.dryRun === true &&
          typeof answer.data?.totals?.active === "number" &&
          Array.isArray(answer.data?.plan?.clusters),
        detail: `active ${String(answer.data?.totals?.active)}, clusters ${String(answer.data?.plan?.clusters?.length)}, planMs ${String(answer.data?.planMs)}`
      })
    ],
    ["head status", ["head", "status"]],
    ["head search", ["head", "search", "VIP revert"]],
    [
      "head snapshot",
      ["head", "snapshot", "--write"],
      env,
      (answer) => ({ ok: answer.data?.rows > 0, detail: `rows ${String(answer.data?.rows)}` })
    ],
    // Last: it `git mv`s a memory into archive/, which every command above would rather read.
    ["archive", ["archive", pathA, "--reason", "superseded by the corrected memory"]]
  ]

  /**
   * Commands covered by a check of their own rather than by the table, each naming which one.
   *
   * Not excuses. `serve mcp` is a long-running server, so its check is a handshake rather than an
   * envelope, and `head serve` is one too: its envelope arrives only when a signal stops it. `hook`
   * is the one command whose stdout is NOT an envelope: it writes the host's own hook protocol, so
   * the table's shared "it answered with a `type`" assertion would fail on the command working
   * correctly. `head embed` has nothing to embed with under this run's `MEMHTML_EMBED=off`, so its
   * answer here is a refusal at exit 1, which the table reads as a crash; its success path is the
   * live tier's. All four are invoked, just elsewhere.
   */
  const COVERED_ELSEWHERE = {
    "serve mcp": "`memhtml serve mcp answers the MCP handshake`",
    "head serve": "`head serve answers head search over its socket and removes it on SIGTERM`",
    hook: "`hook writes the host's protocol on stdout and never an envelope`",
    "head embed": "`head embed refuses with ERR_MODEL_UNAVAILABLE when the embedder is off`"
  }

  const invoked = new Set([...INVOCATIONS.map(([name]) => name), ...Object.keys(COVERED_ELSEWHERE)])
  const missing = declared.filter((name) => !invoked.has(name))
  await check("every declared command is invoked", async () => ({
    ok: missing.length === 0 && declared.length > 30,
    detail: `${String(invoked.size)}/${String(declared.length)}, ${String(Object.keys(COVERED_ELSEWHERE).length)} by a dedicated check${missing.length > 0 ? `, MISSING: ${missing.join(", ")}` : ""}`
  }))

  for (const [name, argv, commandEnv, assert] of INVOCATIONS) {
    await check(`${name} answers from the installed binary`, async () => {
      const answer = await envelope(bin, argv, commandEnv ?? env)
      // The envelope's own contract: a `type` on success, a `code` on failure. Either is a real
      // answer; a crash, a non-zero exit, or unparseable stdout is not, and `envelope` throws on those.
      const extra = assert === undefined ? undefined : assert(answer)
      return {
        ok: typeof answer.type === "string" && (extra?.ok ?? true),
        detail: extra === undefined ? (answer.type ?? answer.code) : extra.detail
      }
    })
  }

  await check(
    "head embed refuses with ERR_MODEL_UNAVAILABLE when the embedder is off",
    async () => {
      const ran = await runRaw(bin, ["head", "embed"], env)
      const answer = looksLikeEnvelope(ran.stdout) ? JSON.parse(ran.stdout) : {}
      return {
        ok: ran.exitCode === 1 && answer.code === "ERR_MODEL_UNAVAILABLE",
        detail: `exit ${String(ran.exitCode)}, ${String(answer.code ?? ran.stdout.slice(0, 200))}`
      }
    }
  )

  /**
   * `memhtml hook`, driven the way an installed hook is: a host's payload on stdin, and stdout read as
   * the HOST'S protocol rather than as an envelope.
   *
   * Three halves, and the third is the one that needs a check of its own. Exit 0, because a hook that
   * exits non-zero can block a turn on some hosts and is a refusal a user never asked for. Non-empty
   * stdout naming the memory this corpus holds, because a hook that prints nothing is indistinguishable
   * from one whose retrieval never ran — the failure mode the design deliberately makes silent. And
   * stdout that is NOT an envelope: `{"apiVersion":"1",…}` in a model's context window would satisfy
   * every other check here and be wrong in the only way that matters.
   */
  /**
   * `memhtml head serve`, the other long-running server: started from the installed binary, asked
   * through a second invocation of it (`head search` must answer with `head.source: "server"`, which
   * only the socket can produce), then stopped with SIGTERM, whose envelope is `head.served` and
   * after which the socket file is gone.
   */
  await check(
    "head serve answers head search over its socket and removes it on SIGTERM",
    async () => {
      const socket = join(corpus, ".memhtml", "head.sock")
      const server = spawn(bin, ["head", "serve"], { env, stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      let err = ""
      server.stdout.setEncoding("utf8")
      server.stderr.setEncoding("utf8")
      server.stdout.on("data", (chunk) => {
        out += chunk
      })
      const closed = new Promise((done) => server.once("close", (code) => done(code)))
      const listening = await new Promise((done) => {
        const timer = setTimeout(() => done(false), 60_000)
        server.stderr.on("data", (chunk) => {
          err += chunk
          if (err.includes("head serve: listening on")) {
            clearTimeout(timer)
            done(true)
          }
        })
        void closed.then(() => {
          clearTimeout(timer)
          done(false)
        })
      })
      if (!listening) {
        server.kill("SIGKILL")
        return { ok: false, detail: `never listened: ${tail(err)}` }
      }
      const answer = await envelope(bin, ["head", "search", "VIP revert"], env).catch(() => null)
      server.kill("SIGTERM")
      const code = await closed
      const served = (() => {
        try {
          return JSON.parse(out)
        } catch {
          return null
        }
      })()
      const gone = await access(socket).then(
        () => false,
        () => true
      )
      const source = answer?.data?.head?.source
      return {
        ok: source === "server" && code === 0 && served?.type === "head.served" && gone,
        detail: `search source ${String(source)}, exit ${String(code)}, ${String(served?.type)}, socket ${gone ? "removed" : "LEFT BEHIND"}`
      }
    }
  )

  await check("hook writes the host's protocol on stdout and never an envelope", async () => {
    const ran = await runRaw(
      bin,
      ["hook", "user-prompt-submit", "--host", "claude"],
      homed,
      `${JSON.stringify({ prompt: "VIP revert" })}\n`
    )
    const named = vipPath !== "" && ran.stdout.includes(vipPath)
    return {
      ok: ran.exitCode === 0 && named && !looksLikeEnvelope(ran.stdout),
      detail: named
        ? `exit ${String(ran.exitCode)}, ${String(ran.stdout.length)} chars naming ${vipPath}`
        : `exit ${String(ran.exitCode)}, stdout did not name ${vipPath || "the first memory"}: ${ran.stdout.slice(0, 200) || `(empty) ${tail(ran.stderr)}`}`
    }
  })

  void corpus
}

/**
 * Every resource template the server advertises, READ over stdio against the installed artifact.
 *
 * `resources/read` is a second RPC family with a ROUTER of its own, and no tool check reaches it: a
 * complete `tools/list` census says nothing about whether a URI a real client sends resolves to anything.
 * A route's named parameter stops at the next `/` while every memory path is multi-segment, so the whole
 * resource surface can be unreachable from an install with every other check here green.
 *
 * So the templates are enumerated from `resources/templates/list`, the discipline the command and tool
 * censuses use, and the census below asserts the published set and the READ set are the same set — a new
 * template fails it rather than going unread.
 */
const checkEveryResource = async ({ mcpBin, env }) => {
  const session = await mcpSession(mcpBin, env)
  try {
    const listed = await session.request("resources/templates/list", {})
    const templates = (listed.result?.resourceTemplates ?? []).map((entry) => entry.uriTemplate)

    /**
     * One memory written through this same session, so the file read addresses a path the SERVER named
     * rather than one this script composed — the same reason the tool census writes its own targets.
     */
    const written = await session.request("tools/call", {
      name: "memory_write",
      arguments: {
        title: "Written to be read back through a resource",
        body: "A resource read and a tool call address one path.",
        memory_type: "semantic",
        workspace: "checkout-api"
      }
    })
    const writePayload = JSON.parse(written.result?.content?.[0]?.text ?? "{}")
    const memoryPath = writePayload.path ?? ""
    /**
     * The commit the pinned template's first hole takes, read off `memory_resolve`'s `indexed_commit`.
     *
     * That tool is the one surface that names a commit for a SINGLE path: `memory_write` publishes
     * `path`, `created`, `deduped` and `existing_path`, and `commit_sha` belongs to
     * `memory_write_batch` alone. It is also the RIGHT commit rather than a substitute for one — a
     * pinned read resolves the path inside a commit's tree, and `indexed_commit` is the commit the
     * server says its own answer was taken against, so a read that succeeds proves the two agree.
     */
    const resolved = await session.request("tools/call", {
      name: "memory_resolve",
      arguments: { path: memoryPath }
    })
    const writeCommit = JSON.parse(resolved.result?.content?.[0]?.text ?? "{}").indexed_commit ?? ""

    /**
     * `[hole, value, expected]` per published template. A template with no entry fails the census.
     *
     * Every value carries a `/` — a memory path is `projects/<workspace>/<slug>.html` — and that is the
     * point rather than a coincidence: a named route parameter stops at the next `/`, so a
     * single-segment URI resolves under a route no real path can reach and proves nothing. The check
     * below refuses a single-segment value before any read is believed.
     */
    const READS = {
      "memhtml://file/{path}": ["{path}", memoryPath, "Written to be read back through a resource"],
      /**
       * Two holes, filled as ONE substitution, because the census substitutes once per template. The
       * value still carries separators — a commit sha, a slash, then a multi-segment path — so the
       * single-segment check below covers this route as well.
       */
      "memhtml://at/{commit}/{path}": [
        "{commit}/{path}",
        `${writeCommit}/${memoryPath}`,
        "Written to be read back through a resource"
      ]
    }

    const unread = templates.filter((template) => READS[template] === undefined)
    const unpublished = Object.keys(READS).filter((template) => !templates.includes(template))
    await check("every advertised resource template is read", async () => ({
      ok:
        templates.length === Object.keys(READS).length &&
        unread.length === 0 &&
        unpublished.length === 0,
      detail: `${String(templates.length)} published, ${String(Object.keys(READS).length)} read${unread.length > 0 ? `, UNREAD: ${unread.join(", ")}` : ""}${unpublished.length > 0 ? `, NOT PUBLISHED: ${unpublished.join(", ")}` : ""}`
    }))

    /*
     * Two ways a substitution proves nothing, refused together because they fail the same way — a read
     * under a route no client can reach. A SINGLE segment resolves under a route a real path never
     * takes, since a named route parameter stops at the next `/`. An EMPTY segment is a hole nothing
     * filled: `memhtml://at//<path>` is what an absent commit composes, and it reaches the router as a
     * URI whose commit is the empty string.
     */
    await check("every resource read names a MULTI-SEGMENT value with no empty hole", async () => {
      const bad = Object.entries(READS).flatMap(([template, [, value]]) => {
        const segments = String(value).split("/")
        return segments.length > 1 && segments.every((segment) => segment !== "") ? [] : [template]
      })
      return {
        ok: bad.length === 0,
        detail:
          bad.length > 0
            ? `SINGLE SEGMENT OR EMPTY HOLE: ${bad.join(", ")}`
            : `${memoryPath}, ${writeCommit.slice(0, 8)}`
      }
    })

    for (const template of templates) {
      const spec = READS[template]
      if (spec === undefined) continue
      const [hole, value, expected] = spec
      await check(`resources/read resolves ${template}`, async () => {
        const uri = template.replace(hole, value)
        const answer = await session.request("resources/read", { uri })
        const contents = answer.result?.contents ?? []
        const text = contents[0]?.text ?? ""
        // The BODY, not just a non-error: a refusal arrives as a JSON-RPC error, and an empty resource
        // would otherwise read as a resolved read.
        return {
          ok: answer.error === undefined && contents.length === 1 && text.includes(expected),
          detail:
            answer.error?.message ??
            `${String(text.length)} chars as ${String(contents[0]?.mimeType)}`
        }
      })
    }
  } finally {
    session.stop()
  }
}

/**
 * Every MCP tool the server advertises, called over stdio against the installed artifact.
 *
 * `initialize` proves the transport and nothing else. The tools are ONE of the server's two surfaces —
 * {@link checkEveryResource} drives the other — and until each tool is called from an install, "the MCP
 * server works" means "it answered a handshake". The list comes from `tools/list` rather than from a
 * literal, so a new tool is covered the day it is registered — or fails the census for want of arguments.
 */
const checkEveryMcpTool = async ({ mcpBin, env }) => {
  /**
   * Arguments per tool, spelled the way the SCHEMA spells them.
   *
   * The tool surface is its own vocabulary and does not mirror the CLI's flags: `memory_type` not
   * `type`, `target_path` not `target`, `src_path`/`dst_path` not `src`/`dst`, and `paths` is an array.
   * Guessing from the CLI produced `Invalid parameters … Missing key` on seven of the fourteen then
   * registered. The
   * census below reads each tool's `inputSchema.required` and fails when a key here does not cover it,
   * so a rename or a new required field surfaces as a failure rather than as a wrong call.
   */
  const ARGUMENTS = {
    memory_write: {
      title: "Written through the MCP door",
      body: "Tools and the CLI share one store.",
      memory_type: "semantic",
      workspace: "checkout-api"
    },
    // A batch op is `Schema.Struct(writeFields())` — the same fields as `memory_write`, so
    // `memory_type` and no `op` discriminator. `memhtml apply`'s JSONL vocabulary is the one with `op`.
    memory_write_batch: {
      ops: [
        {
          title: "Batched through the MCP door",
          body: "One commit per batch.",
          memory_type: "semantic",
          workspace: "checkout-api"
        }
      ]
    },
    memory_search: { query: "MCP door" },
    memory_recall: { query: "MCP door" },
    memory_list: {},
    memory_status: {},
    trace_search: { query: "VIP" },
    // One of `session_id` / `path` is required, which no `required` array can express.
    trace_links: { session_id: "s1" },
    memory_read: { path: "PLACEHOLDER" },
    memory_correct: {
      target_path: "CORRECTED",
      title: "Corrected through the MCP door",
      body: "The correction carries new content.",
      reason: "written by the MCP smoke tier"
    },
    memory_link: { src_path: "PLACEHOLDER", rel: "relates_to", dst_path: "SECOND" },
    memory_neighbors: { path: "PLACEHOLDER" },
    memory_resolve: { path: "PLACEHOLDER" },
    memory_reinforce: { paths: ["PLACEHOLDER"], signal: "positive" },
    memory_archive: { path: "DOOMED", reason: "written by the MCP smoke tier" }
  }

  const session = await mcpSession(mcpBin, env)
  try {
    const listed = await session.request("tools/list", {})
    const tools = listed.result?.tools ?? []

    const uncovered = tools.filter((tool) => ARGUMENTS[tool.name] === undefined).map((t) => t.name)
    const underspecified = tools.flatMap((tool) => {
      const supplied = new Set(Object.keys(ARGUMENTS[tool.name] ?? {}))
      return (tool.inputSchema?.required ?? [])
        .filter((key) => !supplied.has(key))
        .map((key) => `${tool.name}.${key}`)
    })
    await check("every advertised MCP tool has schema-complete arguments", async () => ({
      ok: uncovered.length === 0 && underspecified.length === 0 && tools.length > 10,
      detail: `${String(tools.length)} tools${uncovered.length > 0 ? `, UNCOVERED: ${uncovered.join(", ")}` : ""}${underspecified.length > 0 ? `, MISSING REQUIRED: ${underspecified.join(", ")}` : ""}`
    }))

    /**
     * Three paths the SERVER wrote, so the read/link/archive tools address memories it made itself.
     *
     * The BODY varies, not just the title: the store dedupes on content hash, so two writes with the
     * same body return the same path and `memory_link` then refuses a self-edge. And `archive` gets its
     * own memory because `memory_correct` rewrites the one it touches to a new slug, which left archive
     * addressing a path that no longer existed.
     */
    const writeOne = async (title, body) => {
      const answer = await session.request("tools/call", {
        name: "memory_write",
        arguments: { ...ARGUMENTS.memory_write, title, body }
      })
      return JSON.parse(answer.result?.content?.[0]?.text ?? "{}").path
    }
    const target = await writeOne("Written through the MCP door", "The first body, distinct.")
    const second = await writeOne(
      "A second memory through the MCP door",
      "The second body, also distinct."
    )
    const doomed = await writeOne(
      "A memory written to be archived",
      "The third body, distinct again."
    )
    const corrected = await writeOne(
      "A memory written to be corrected",
      "The fourth body, distinct too."
    )

    for (const tool of tools) {
      if (tool.name === "memory_write") continue
      await check(`MCP tool ${tool.name} answers`, async () => {
        const substitute = (value) =>
          value === "PLACEHOLDER"
            ? target
            : value === "SECOND"
              ? second
              : value === "DOOMED"
                ? doomed
                : value === "CORRECTED"
                  ? corrected
                  : value
        const args = Object.fromEntries(
          Object.entries(ARGUMENTS[tool.name] ?? {}).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.map(substitute) : substitute(value)
          ])
        )
        const answer = await session.request("tools/call", { name: tool.name, arguments: args })
        // `isError` is the protocol's own failure channel; a JSON-RPC `error` is a broken call. Both
        // are failures here: a tool that answers "that went wrong" has not been shown to work.
        return {
          ok: answer.error === undefined && answer.result?.isError !== true,
          detail:
            answer.error?.message ??
            (answer.result?.isError === true
              ? String(answer.result?.content?.[0]?.text ?? "isError").slice(0, 120)
              : "ok")
        }
      })
    }
  } finally {
    session.stop()
  }
}

/**
 * The edge that reaches the network, driven for real against the installed artifact.
 *
 * Everything else this file checks is exercised with the embedder and the model switched off, which is
 * what keeps the gate credential-free — and it means the vector arm of retrieval has never run from an
 * install. This check is that gap, and nothing else covers it: the eval tier fakes the embedder and
 * the integration tier sets both to `off`.
 */
const checkLiveBedrock = async ({ bin, work, env }) => {
  const corpus = join(work, "live-corpus")
  // The credential is whatever the ambient environment holds; EMBED and LLM are simply not disabled.
  const live = { ...env, MEMHTML_ROOT: corpus }
  delete live.MEMHTML_EMBED
  delete live.MEMHTML_LLM

  await check("a route to a model is present: a Bedrock credential, or an LLM proxy", async () => {
    const bearer = Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK)
    const sigv4 = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    // `MEMHTML_LLM_BASE_URL` routes every model call through an OpenAI/Anthropic-compatible proxy
    // instead, and a keyless loopback proxy is a supported deployment, so the URL alone is a route.
    const proxy = Boolean(process.env.MEMHTML_LLM_BASE_URL?.trim())
    // A FAILURE, not a skip: `--live` was asked for, and quietly proving nothing is the outcome this
    // whole tier exists to prevent.
    return {
      ok: bearer || sigv4 || proxy,
      detail: proxy ? "llm proxy" : bearer ? "bearer token" : sigv4 ? "sigv4" : "none"
    }
  })

  await envelope(bin, ["init"], live)
  await envelope(
    bin,
    [
      "write",
      "--title",
      "Draining the VIP precedes a revert",
      "--claim",
      "Drain the VIP before reverting a deploy.",
      "--type",
      "semantic",
      "--workspace",
      "checkout-api"
    ],
    live
  )

  await check("Bedrock embeddings are written and the model is named", async () => {
    await envelope(bin, ["index", "update"], live)
    const status = (await envelope(bin, ["index", "status"], live)).data
    return {
      ok: status.embeddings >= 1 && status.embedModelMatches === true,
      detail: `${String(status.embeddings)} embedding(s) from ${String(status.embedModel)}`
    }
  })

  await check("head embed fills the vector cache and head search runs the vector arm", async () => {
    const embedded = (await envelope(bin, ["head", "embed"], live)).data
    const searched = (await envelope(bin, ["head", "search", "VIP revert"], live)).data
    return {
      ok:
        embedded.embedded >= 1 &&
        searched.vector?.used === true &&
        searched.hits.some((hit) => hit.arms.includes("vector")),
      detail: `${String(embedded.embedded)} embedded, ${String(embedded.bytes)} bytes, vector ${JSON.stringify(searched.vector)}`
    }
  })
}

/**
 * One long-lived MCP session over stdio: initialize once, then send requests and match replies by id.
 *
 * The handshake check spawns a server per request, which is fine for one message and wrong for fifteen —
 * a fresh process per tool call would test process startup, and `memory_read` needs to see what
 * `memory_write` wrote in the same session.
 */
const mcpSession = async (bin, env) => {
  const child = spawn(bin, [], { env, stdio: ["pipe", "pipe", "ignore"] })
  const pending = new Map()
  let buffer = ""
  let nextId = 100

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith("{")) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const settle = pending.get(message.id)
      if (settle !== undefined) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })

  const request = (method, params) =>
    new Promise((done, fail) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        fail(new Error(`${method} did not answer within 60s`))
      }, 60_000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        done(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "memhtml-smoke", version: "1" }
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)

  return { request, stop: () => child.kill("SIGKILL") }
}

/** One `initialize` request over stdio, and the first line of the reply. */
const handshake = (bin, args, env) =>
  new Promise((done) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    const finish = (value) => {
      child.kill("SIGKILL")
      done(value)
    }
    const timer = setTimeout(() => finish(null), 60_000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      out += chunk
      const line = out.split("\n").find((candidate) => candidate.trim().startsWith("{"))
      if (line === undefined) return
      try {
        const parsed = JSON.parse(line)
        clearTimeout(timer)
        finish(parsed)
      } catch {
        // A partial line: wait for the rest.
      }
    })
    child.once("error", () => {
      clearTimeout(timer)
      finish(null)
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "memhtml-smoke", version: "1" }
        }
      })}\n`
    )
  })

await main()

const failed = results.filter((entry) => !entry.ok)
process.stdout.write(
  `${JSON.stringify({ checks: results.length, failed: failed.map((entry) => entry.name) }, null, 2)}\n`
)
if (failed.length > 0) process.exit(1)
