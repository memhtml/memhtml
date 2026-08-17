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

    await checkAgentBuild({ consumer, env })
  } finally {
    await rm(work, { recursive: true, force: true })
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
