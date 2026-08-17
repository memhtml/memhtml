#!/usr/bin/env node
/**
 * Install the assembled `memhtml` the way a user would, and drive every subsystem through it.
 *
 * `mise run check` proves the WORKSPACE works and is structurally blind to what npm serves: it
 * resolves `@memhtml/*` through pnpm's links, where every asset is on disk whether or not a manifest
 * names it. Three assets shipped broken under exactly that blindness. So this tier packs, installs into
 * a throwaway directory, and runs the binary — the only check whose subject is the artifact.
 *
 * Not part of `check`: it reaches the npm registry to resolve the twelve external dependencies, and
 * `check` is offline and credential-free by construction. CI runs it as its own job, and the publish
 * job runs it on the tag before publishing.
 *
 * Every command runs with `MEMHTML_EMBED=off` and `MEMHTML_LLM=off`, so nothing here needs a
 * credential. That bounds what it can prove — the model and embedder edges are covered by the eval and
 * integration tiers — and everything else is real: a real git repository, real migrations, a real
 * QuickJS sandbox, a real MCP handshake.
 */
import { execFile, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const STAGING = join(REPO_ROOT, "dist-package")

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  process.stderr.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}\n`)
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
const envelope = async (bin, args, env) => {
  const { stdout } = await exec(bin, args, { env, maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout)
}

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
    const tarball = join(STAGING, JSON.parse(packed)[0].filename)

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
      XDG_CACHE_HOME: cache
    }

    await check("manifest names the published binary", async () => {
      const manifest = await envelope(bin, ["manifest"], env)
      return { ok: manifest.data?.name === "memhtml", detail: manifest.data?.version }
    })

    await check("init scaffolds a git repository", async () => {
      const init = await envelope(bin, ["init"], env)
      return { ok: init.data?.created === true && typeof init.data?.headSha === "string" }
    })

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

    await check("the sleep cycle runs every phase", async () => {
      const slept = await envelope(bin, ["sleep", "run", "--dry-run"], env)
      const phases = (slept.data?.phases ?? []).length
      return { ok: phases === 15, detail: `phases=${String(phases)}` }
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

    await checkEveryCommand({ bin, work, env })
    await checkSleepLifecycle({ bin, work, env })
    await checkEveryMcpTool({ mcpBin, env })
    await checkAgentBuild({ consumer, env })
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
const checkEveryCommand = async ({ bin, work, env }) => {
  const manifest = await envelope(bin, ["manifest"], env)
  const declared = manifest.data.commands.map((command) => command.name)

  const corpus = env.MEMHTML_ROOT
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
        ["write", "--title", title, "--claim", claim, "--type", "semantic", "--workspace", "checkout-api"],
        env
      )
    ).data.path

  const pathA = await writeTwo("A drain precedes every revert", "Drain, then revert.")
  const pathB = await writeTwo("A revert without a drain keeps serving", "Reverting alone does not drain.")

  const task = await envelope(bin, ["task", "add", "--title", "Drain the VIP before the next revert"], env)
  const taskPath = task.data?.path

  const applyFile = join(work, "ops.jsonl")
  await writeFile(
    applyFile,
    // `body`, not `claim`: the batch op vocabulary is its own snake_case surface and `memhtml apply`
    // rejects an unknown field by name. `memhtml manifest` lists the accepted set.
    `${JSON.stringify({ op: "write", title: "Applied through the batch door", body: "Batch writes share one commit.", type: "semantic", workspace: "checkout-api" })}\n`
  )

  const execFile_ = join(work, "census.mjs")
  await writeFile(execFile_, 'import { corpus } from "/workspace/lib/corpus.mjs"\nconsole.log(corpus().size)\n')

  const sleepRun = await envelope(bin, ["sleep", "run", "--dry-run"], env)
  const runId = sleepRun.data?.runId

  /** `[command, argv, env]`. A command with no entry here must appear in EXCUSED below. */
  const INVOCATIONS = [
    ["manifest", ["manifest"]],
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
    ["reinforce", ["reinforce", pathA]],
    ["correct", ["correct", pathB, "--title", "A revert without a drain keeps serving", "--claim", "Reverting alone leaves the old group serving."]],
    ["list", ["list"]],
    ["task add", ["task", "add", "--title", "Second task"]],
    ["task list", ["task", "list"]],
    ["task status", ["task", "status", taskPath, "doing"]],
    ["index update", ["index", "update"]],
    ["index rebuild", ["index", "rebuild"]],
    ["index status", ["index", "status"]],
    ["trace index", ["trace", "index"], traced],
    ["trace search", ["trace", "search", "VIP"], traced],
    // One of `--session-id` / `--path` is required, which is an either-or no `required` flag can
    // express, so neither is marked and a bare call is a usage error.
    ["trace links", ["trace", "links", "--session-id", "s1"], traced],
    ["sleep run", ["sleep", "run", "--dry-run"]],
    ["sleep status", ["sleep", "status"]],
    ["sleep review", ["sleep", "review", runId]],
    ["status", ["status"]],
    ["publish", ["publish"]],
    ["doctor", ["doctor"]],
    ["eval discriminate", ["eval", "discriminate", "--mode", "fake", "--probes", "4", "--size", "12"]],
    ["exec", ["exec", "--file", execFile_]],
    ["state export", ["state", "export"]],
    ["state import", ["state", "import"]],
    ["agents-doc", ["agents-doc", "--out", join(work, "AGENTS.md")]],
    // Last: it `git mv`s a memory into archive/, which every command above would rather read.
    ["archive", ["archive", pathA, "--reason", "superseded by the corrected memory"]]
  ]

  /**
   * Commands covered by a check of their own rather than by the table, each naming which one.
   *
   * Not excuses. `serve mcp` is a long-running server, so its check is a handshake rather than an
   * envelope, and the sleep lifecycle needs a corpus whose `main` has not advanced — every write above
   * moves `main`, which makes `sleep merge` refuse with `main-advanced`, a correct answer that proves
   * the refusal rather than the merge. Both are invoked, just elsewhere.
   */
  const COVERED_ELSEWHERE = {
    "serve mcp": "`memhtml serve mcp answers the MCP handshake`",
    "sleep resume": "`checkSleepLifecycle`",
    "sleep merge": "`checkSleepLifecycle`"
  }

  const invoked = new Set([...INVOCATIONS.map(([name]) => name), ...Object.keys(COVERED_ELSEWHERE)])
  const missing = declared.filter((name) => !invoked.has(name))
  await check("every declared command is invoked", async () => ({
    ok: missing.length === 0 && declared.length > 30,
    detail: `${String(invoked.size)}/${String(declared.length)}, ${String(Object.keys(COVERED_ELSEWHERE).length)} by a dedicated check${missing.length > 0 ? `, MISSING: ${missing.join(", ")}` : ""}`
  }))

  for (const [name, argv, commandEnv] of INVOCATIONS) {
    await check(`${name} answers from the installed binary`, async () => {
      const answer = await envelope(bin, argv, commandEnv ?? env)
      // The envelope's own contract: a `type` on success, a `code` on failure. Either is a real
      // answer; a crash, a non-zero exit, or unparseable stdout is not, and `envelope` throws on those.
      return { ok: typeof answer.type === "string", detail: answer.type ?? answer.code }
    })
  }

  void corpus
}

/**
 * The sleep cycle end to end, on a corpus of its own: run, resume, review, then a merge that lands.
 *
 * A separate corpus because `sleep merge` fast-forwards `main` to the run's branch and refuses with
 * `main-advanced` when `main` has moved since the branch point — which every write in the table above
 * does. Sharing one corpus therefore proves the refusal and never the merge, and the merge is the half
 * that mutates the system of record.
 *
 * The gate is the reason this is worth reaching. `sleep merge` re-runs the discrimination gate before
 * landing anything (`apps/cli/src/run.ts`, where the composition is deliberately visible), so the gate
 * generates its own ~300-file fixture corpus with its own database — which is why the merge's log names
 * a file count and a sha belonging to neither the corpus nor this repo. It passes in fake mode, so this
 * asserts `merged: true` and that `main` actually moved.
 */
const checkSleepLifecycle = async ({ bin, work, env }) => {
  const corpus = join(work, "sleep-corpus")
  const sleepEnv = { ...env, MEMHTML_ROOT: corpus }

  await envelope(bin, ["init"], sleepEnv)
  await envelope(
    bin,
    ["write", "--title", "The only memory this corpus holds", "--claim", "One fact.", "--type", "semantic", "--workspace", "checkout-api"],
    sleepEnv
  )
  await envelope(bin, ["sleep", "run"], sleepEnv)
  const runId = (await envelope(bin, ["sleep", "status"], sleepEnv)).data.runId
  const beforeMerge = (await exec("git", ["-C", corpus, "rev-parse", "main"])).stdout.trim()

  await check("sleep resume answers from the installed binary", async () => {
    const resumed = await envelope(bin, ["sleep", "resume", runId], sleepEnv)
    return { ok: resumed.type === "sleep.report", detail: `phases=${String((resumed.data?.phases ?? []).length)}` }
  })

  await check("sleep merge lands the run on main", async () => {
    const merged = await envelope(bin, ["sleep", "merge", runId], sleepEnv)
    const after = (await exec("git", ["-C", corpus, "rev-parse", "main"])).stdout.trim()
    // Both halves: the envelope says it merged, and git agrees that main moved.
    return {
      ok: merged.type === "sleep.merge" && merged.data?.merged === true && after !== beforeMerge,
      detail: merged.data?.merged === true ? `main moved to ${after.slice(0, 8)}` : `refusal=${String(merged.data?.refusal)}`
    }
  })
}

/**
 * Every MCP tool the server advertises, called over stdio against the installed artifact.
 *
 * `initialize` proves the transport and nothing else. The tools are the MCP surface, and until each one
 * is called from an install, "the MCP server works" means "it answered a handshake". The list comes from
 * `tools/list` rather than from a literal, so a new tool is covered the day it is registered — or fails
 * the census for want of arguments.
 */
const checkEveryMcpTool = async ({ mcpBin, env }) => {
  /**
   * Arguments per tool, spelled the way the SCHEMA spells them.
   *
   * The tool surface is its own vocabulary and does not mirror the CLI's flags: `memory_type` not
   * `type`, `target_path` not `target`, `src_path`/`dst_path` not `src`/`dst`, and `paths` is an array.
   * Guessing from the CLI produced `Invalid parameters … Missing key` on seven of the fourteen. The
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
    const second = await writeOne("A second memory through the MCP door", "The second body, also distinct.")
    const doomed = await writeOne("A memory written to be archived", "The third body, distinct again.")
    const corrected = await writeOne("A memory written to be corrected", "The fourth body, distinct too.")

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
 * The consolidator's agent: built out of `node_modules`, then booted.
 *
 * The most fragile path in the artifact and the only one the CLI commands above cannot reach — the
 * credential preflight returns before it, so a credential-free run never touches it. Without this the
 * whole eve chain is unproven: dropping `src/` from the assembled package leaves the other ten checks
 * green (measured).
 *
 * Both halves matter. `eve build` succeeding proves `agent/` resolved `../../src/*.js`. `eve start`
 * answering proves the build has the INLINED shape — built from inside `node_modules` it also exits 0
 * and then dies on an unsettled top-level await, so a build that merely succeeds proves nothing.
 */
const checkAgentBuild = async ({ consumer, env }) => {
  /**
   * The installed package root, which is what the bundle's own `packageRoot()` resolves to: the
   * emitted code sits in `dist/`, so `..` from there is here, and `agent/` and `src/` sit beside it.
   */
  const installed = join(consumer, "node_modules", "memhtml")
  let appRoot
  await check("the agent builds outside node_modules", async () => {
    const { Effect } = await import(join(consumer, "node_modules", "effect", "dist", "index.js"))
      .catch(() => import("effect"))
    // The bundle exports nothing, so the staged SOURCE is imported instead. It is the same file eve
    // compiles, and importing it is how this tier reaches a path no CLI command can (the credential
    // preflight returns before consolidation).
    const { resolveAgentAppRoot, eveBinPath } = await import(
      join(REPO_ROOT, "apps", "consolidator", "dist", "agent-build.js")
    )
    /**
     * `process.env`, not the child `env` above: this call runs IN THIS PROCESS, and the cache location
     * is read from the ambient environment. Passing it only to spawned children left a 17 MB build in
     * the developer's real `~/.cache` on every run.
     */
    const before = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = env.XDG_CACHE_HOME
    try {
      appRoot = await Effect.runPromise(
        resolveAgentAppRoot({ packageRoot: installed, configured: undefined, eveBin: eveBinPath() })
      )
    } finally {
      if (before === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = before
    }
    return { ok: !appRoot.includes("node_modules") && appRoot.startsWith(env.XDG_CACHE_HOME), detail: appRoot }
  })

  if (appRoot === undefined) {
    record("the built agent server answers its health route", false, "no app root to start")
    return
  }

  await check("the built agent server answers its health route", async () => {
    const eveBin = join(consumer, "node_modules", "eve", "bin", "eve.js")
    const port = 47500 + Math.floor(process.pid % 500)
    const traces = join(consumer, "traces")
    await exec("mkdir", ["-p", join(traces, "projects", "-smoke")])
    await writeFile(join(traces, "projects", "-smoke", "s1.jsonl"), "{}\n")
    const child = spawn(process.execPath, [eveBin, "start", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: appRoot,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...env,
        MEMHTML_SANDBOX_MOUNTS: JSON.stringify([{ mountPath: "/mnt/traces", hostPath: traces }]),
        MEMHTML_CONSOLIDATOR_RUN_SECRET: "smoke-secret-not-a-credential",
        AWS_REGION: env.AWS_REGION ?? "us-east-1"
      }
    })
    try {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null) return { ok: false, detail: `eve start exited ${String(child.exitCode)}` }
        const answer = await fetch(`http://127.0.0.1:${String(port)}/eve/v1/health`)
          .then((response) => response.json())
          .catch(() => null)
        if (answer !== null) return { ok: answer.ok === true, detail: `status=${String(answer.status)}` }
        await new Promise((done) => setTimeout(done, 1_000))
      }
      return { ok: false, detail: "never became healthy" }
    } finally {
      child.kill("SIGKILL")
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
