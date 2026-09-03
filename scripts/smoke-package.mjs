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
 * With `--live` it additionally drives the two edges that reach the network, which is the only way to
 * prove them from an install: Bedrock embeddings, the sleep phases that call a model, and the
 * consolidator distilling a transcript through eve. Those three are the whole of what the default mode
 * cannot see, so `--live` is the difference between "every command answers" and "every command works".
 * It needs `AWS_BEARER_TOKEN_BEDROCK` (or SigV4 keys, or an LLM proxy on `MEMHTML_LLM_BASE_URL`) and
 * it spends real tokens.
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
 * A command's envelope AND what it logged, for a check whose failure mode is a run that SUCCEEDED.
 *
 * `envelope` is the right shape for the other checks: the envelope is the contract, stderr is a log,
 * and a broken command throws with its stderr attached. It is the wrong shape for a phase that reports
 * `ok` with zero counts and puts the cause in a log line — the process exits 0, so nothing throws, and
 * `execFile` resolves with a `stderr` that is then dropped. A sleep run whose consolidator was
 * unreachable is exactly that: `candidates: 0` on stdout, and
 * `sleep.trace-consolidation degraded: <tag>: <reason>` — naming the child's own last words — on the
 * stream the caller discarded.
 */
const envelopeWithLog = async (bin, args, env) => {
  const { stdout, stderr } = await exec(bin, args, { env, maxBuffer: 32 * 1024 * 1024 })
  return { data: JSON.parse(stdout).data, stderr }
}

/** How much of a child's stderr a check's detail carries: enough for a stack, not for a log. */
const STDERR_TAIL_CHARS = 400

/**
 * The END of what a child wrote, which is where a dying one says why.
 *
 * The same rule `apps/consolidator/src/child-stderr.ts` states for the two children the consolidator
 * spawns: a message rendered from the HEAD of a child's output shows its banner.
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
      // The count is SLEEP_PHASES.length, restated here because this script drives the installed
      // tarball and cannot import the workspace. A new phase moves both, or this check catches it.
      return { ok: phases === 17, detail: `phases=${String(phases)}` }
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
    const sleep = await checkSleepLifecycle({ bin, work, env })
    await checkEveryMcpTool({ mcpBin, env })
    await checkEveryResource({ mcpBin, env, sleep })
    await checkAgentBuild({ consumer, env })
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

  const execFile_ = join(work, "census.mjs")
  await writeFile(
    execFile_,
    'import { corpus } from "/workspace/lib/corpus.mjs"\nconsole.log(corpus().size)\n'
  )

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
    ["index rebuild", ["index", "rebuild"]],
    ["index status", ["index", "status"]],
    ["trace index", ["trace", "index"], traced],
    ["trace search", ["trace", "search", "VIP"], traced],
    // One of `--session-id` / `--path` is required, which is an either-or no `required` flag can
    // express, so neither is marked and a bare call is a usage error.
    ["trace links", ["trace", "links", "--session-id", "s1"], traced],
    ["sleep run", ["sleep", "run", "--dry-run"]],
    ["sleep status", ["sleep", "status"]],
    ["sleep plan", ["sleep", "plan"]],
    ["sleep review", ["sleep", "review", runId]],
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
 *
 * Returns the corpus and the run id, which is the ONE place a committed sleep report exists: the report
 * phase writes `.memhtml/sleep/<run-id>.html` on the run's branch and skips the write entirely on a dry
 * run, so `memhtml://sleep/{run-id}` is readable only where a real run has been fast-forwarded onto
 * `main`. `checkEveryResource` reads it from here.
 */
const checkSleepLifecycle = async ({ bin, work, env }) => {
  const corpus = join(work, "sleep-corpus")
  const sleepEnv = { ...env, MEMHTML_ROOT: corpus }

  await envelope(bin, ["init"], sleepEnv)
  await envelope(
    bin,
    [
      "write",
      "--title",
      "The only memory this corpus holds",
      "--claim",
      "One fact.",
      "--type",
      "semantic",
      "--workspace",
      "checkout-api"
    ],
    sleepEnv
  )
  await envelope(bin, ["sleep", "run"], sleepEnv)
  const runId = (await envelope(bin, ["sleep", "status"], sleepEnv)).data.runId
  const beforeMerge = (await exec("git", ["-C", corpus, "rev-parse", "main"])).stdout.trim()

  await check("sleep resume answers from the installed binary", async () => {
    const resumed = await envelope(bin, ["sleep", "resume", runId], sleepEnv)
    return {
      ok: resumed.type === "sleep.report",
      detail: `phases=${String((resumed.data?.phases ?? []).length)}`
    }
  })

  await check("sleep merge lands the run on main", async () => {
    const merged = await envelope(bin, ["sleep", "merge", runId], sleepEnv)
    const after = (await exec("git", ["-C", corpus, "rev-parse", "main"])).stdout.trim()
    // Both halves: the envelope says it merged, and git agrees that main moved.
    return {
      ok: merged.type === "sleep.merge" && merged.data?.merged === true && after !== beforeMerge,
      detail:
        merged.data?.merged === true
          ? `main moved to ${after.slice(0, 8)}`
          : `refusal=${String(merged.data?.refusal)}`
    }
  })

  return { corpus, runId }
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
 *
 * Against the SLEEP corpus, because it is the only one holding a committed sleep report (see
 * {@link checkSleepLifecycle}), and it also holds memories, so one session covers both templates.
 */
const checkEveryResource = async ({ mcpBin, env, sleep }) => {
  const session = await mcpSession(mcpBin, { ...env, MEMHTML_ROOT: sleep.corpus })
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
     * Every value carries a `/` — a memory path is `projects/<workspace>/<slug>.html` and a run id is
     * `sleep/<date>` — and that is the point rather than a coincidence: a named route parameter stops at
     * the next `/`, so a single-segment URI resolves under a route no real path can reach and proves
     * nothing. The check below refuses a single-segment value before any read is believed.
     */
    const READS = {
      "memhtml://file/{path}": ["{path}", memoryPath, "Written to be read back through a resource"],
      "memhtml://sleep/{run-id}": ["{run-id}", sleep.runId, sleep.runId],
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
            : `${memoryPath}, ${sleep.runId}, ${writeCommit.slice(0, 8)}`
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
 * A transcript the consolidation phase will actually pick up.
 *
 * Two gates decide that, and both are policy rather than accident: `TRACE_MIN_BYTES` is 8 KB, because a
 * memory distilled from a ten-line file could only restate one of those lines; and `file_mtime` must
 * predate `TRACE_QUIET_MILLIS` (one hour), because a transcript being written is a session still in
 * progress. A freshly copied fixture fails both, which is why the default mode's consolidation phase
 * reports `batch: 0` and never reaches the agent — correct behavior that looks like coverage.
 *
 * So this writes a multi-turn session over 8 KB with two facts worth keeping, and backdates it.
 */
const writeQualifyingTranscript = async (traceRoot) => {
  const sessionId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
  const dir = join(traceRoot, "projects", "-tmp-checkout-api")
  await exec("mkdir", ["-p", dir])
  const common = {
    sessionId,
    cwd: "/tmp/checkout-api",
    gitBranch: "main",
    entrypoint: "cli",
    version: "2.1.219",
    isSidechain: false,
    userType: "external"
  }
  const turns = [
    [
      "user",
      "The checkout-api deploy rolled back again. Connections kept landing on the old target group after we reverted."
    ],
    [
      "assistant",
      "The revert alone does not drain the VIP. In-flight connections stay pinned to the old target group until the VIP is drained, so reverting while the VIP still points at the old group keeps serving stale pods."
    ],
    ["user", "So what is the right order of operations?"],
    [
      "assistant",
      "Drain the VIP first, wait for connections to bleed off, then revert the deploy. Reversing that order is what produced the rollback: the deploy reverted while the VIP still routed to the old target group."
    ],
    ["user", "We also saw the health check pass while real requests were failing."],
    [
      "assistant",
      "The health check probes the pod directly rather than through the VIP, so it reports healthy while the VIP still routes to drained pods. A check that bypasses the VIP cannot observe VIP-level routing failures."
    ],
    ["user", "Anything else worth recording about this incident?"],
    [
      "assistant",
      "Two durable facts: draining the VIP must precede a revert, because the revert does not move connections; and a health check that bypasses the VIP cannot detect VIP-level routing failures, so a green check during an outage is expected."
    ],
    ["user", "Good. Note it against checkout-api."],
    [
      "assistant",
      "Recorded against checkout-api: the drain-before-revert ordering, and the health-check blind spot. Both are procedural rather than incidental, so they should outlive the incident."
    ]
  ]
  const lines = [JSON.stringify({ type: "mode", mode: "default", sessionId })]
  let at = Date.parse("2026-08-14T10:00:00.000Z")
  turns.forEach(([role, text], index) => {
    // Padded past the 8 KB floor with the turn's own words rather than filler, so what the model reads
    // is still a coherent session.
    const body = `${text} ${text.repeat(role === "assistant" ? 4 : 2)}`
    at += 6_000
    lines.push(
      JSON.stringify({
        ...common,
        type: role,
        uuid: `u${String(index + 1)}`,
        parentUuid: index === 0 ? null : `u${String(index)}`,
        promptId: `p${String(Math.ceil((index + 1) / 2))}`,
        timestamp: new Date(at).toISOString(),
        message:
          role === "user"
            ? { role: "user", content: body }
            : {
                role: "assistant",
                id: `msg${String(index + 1)}`,
                model: "claude-opus-5",
                content: [{ type: "text", text: body }]
              }
      })
    )
  })
  const file = join(dir, `${sessionId}.jsonl`)
  await writeFile(file, `${lines.join("\n")}\n`)
  // Three days back: comfortably outside the one-hour quiet window.
  await exec("touch", ["-d", "3 days ago", file])
  return file
}

/**
 * The two edges that reach the network, driven for real against the installed artifact.
 *
 * Everything else this file checks is exercised with the embedder and the model switched off, which is
 * what keeps the gate credential-free — and it means the vector arm of retrieval, the sleep phases that
 * call a model, and the consolidator's whole reason to exist have never run from an install. These
 * three checks are that gap, and nothing else covers it: the eval tier fakes the embedder and the
 * integration tier sets both to `off`.
 */
const checkLiveBedrock = async ({ bin, work, env }) => {
  const corpus = join(work, "live-corpus")
  const traceRoot = join(work, "live-traces")
  // The credential is whatever the ambient environment holds; EMBED and LLM are simply not disabled.
  const live = { ...env, MEMHTML_ROOT: corpus, MEMHTML_TRACE_ROOT: traceRoot }
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

  await writeQualifyingTranscript(traceRoot)
  await envelope(bin, ["trace", "index"], live)

  await check("the sleep cycle calls the model and distills a transcript", async () => {
    const { data: slept, stderr } = await envelopeWithLog(bin, ["sleep", "run"], live)
    const phase = (slept.phases ?? []).find((entry) => entry.phase === "trace-consolidation")
    const counts = phase?.counts ?? {}
    /**
     * `batch` proves the transcript qualified, `candidates` proves eve ran and the model answered.
     *
     * Two channels ride along, because every way this check fails reports `candidates=0` and the counts
     * alone cannot say which: the phase's own `detail` separates "the agent found nothing" from "the
     * agent could not be asked", and the run's log tail carries the REASON behind the second — the
     * typed tag is in the envelope, but the sentence naming what the spawned server said is only ever
     * on stderr.
     */
    const ok = slept.llmCalls >= 1 && counts.batch >= 1 && counts.candidates >= 1
    const why = phase?.detail === undefined ? "" : ` — ${String(phase.detail)}`
    return {
      ok,
      detail: `llmCalls=${String(slept.llmCalls)} batch=${String(counts.batch)} candidates=${String(counts.candidates)} written=${String(counts.written)}${why}${ok ? "" : `\n     ${tail(stderr)}`}`
    }
  })
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
    const { Effect } = await import(
      join(consumer, "node_modules", "effect", "dist", "index.js")
    ).catch(() => import("effect"))
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
    return {
      ok: !appRoot.includes("node_modules") && appRoot.startsWith(env.XDG_CACHE_HOME),
      detail: appRoot
    }
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
    /**
     * `detached: true` puts `eve start` at the head of its own process group, so the `finally` below
     * can kill the GROUP. `eve start` is a supervisor and the server it builds is a grandchild; a
     * SIGKILL to the supervisor alone orphaned that server on every run — 27 of them, the oldest two
     * days old, were found on the dev box on 2026-09-02 (issue #118). Production does not have this
     * hole: the real client spawns through `child-tether.ts`, and the server exits with its parent.
     */
    const child = spawn(
      process.execPath,
      [eveBin, "start", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: appRoot,
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...env,
          MEMHTML_SANDBOX_MOUNTS: JSON.stringify([{ mountPath: "/mnt/traces", hostPath: traces }]),
          MEMHTML_CONSOLIDATOR_RUN_SECRET: "smoke-secret-not-a-credential",
          AWS_REGION: env.AWS_REGION ?? "us-east-1"
        }
      }
    )
    /**
     * eve's own stderr, which is the only place a failed boot says why.
     *
     * A `pipe` nobody reads is worse than `ignore` twice over: the reason is lost, and a child that
     * wrote past the pipe's ~64 KiB buffer would BLOCK on the write and read as a hang. `eve start`
     * failing on a relocated build writes one line and exits 1, so a check that reported only the exit
     * code sent an operator to look for a cause the child had already handed over. Production does not
     * have this hole — `startFailureReason` in `apps/consolidator/src/client.ts` carries the tail into
     * its typed failure — so this is the script catching up to the client.
     */
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024)
    })
    try {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          return {
            ok: false,
            detail: `eve start exited ${String(child.exitCode)} — ${tail(stderr)}`
          }
        const answer = await fetch(`http://127.0.0.1:${String(port)}/eve/v1/health`)
          .then((response) => response.json())
          .catch(() => null)
        if (answer !== null) {
          /**
           * The WHOLE documented body, which is what `healthy()` in
           * `apps/consolidator/src/client.ts` enforces in production: `ok` alone is a field any
           * generic HTTP server can return, so a check that stopped there would pass this gate on a
           * listener that is not eve — and this is the one gate whose subject is the artifact. The
           * `workflowId` VALUE is not pinned; it embeds eve's own package and entry names.
           */
          const ready =
            answer.ok === true &&
            answer.status === "ready" &&
            typeof answer.workflowId === "string" &&
            answer.workflowId !== ""
          return {
            ok: ready,
            detail: `status=${String(answer.status)} workflowId=${String(answer.workflowId)}`
          }
        }
        await new Promise((done) => setTimeout(done, 1_000))
      }
      // A server that is alive and not answering says so on stderr too, or says nothing — and
      // "nothing" is itself the finding, so the tail is carried either way.
      return { ok: false, detail: `never became healthy — ${tail(stderr)}` }
    } finally {
      killGroup(child)
    }
  })
}

/**
 * Kill a detached child and everything it spawned. A negative pid addresses the process group the
 * child leads; the fallback covers a child that never got a pid (spawn failed) or one whose group is
 * already gone, where only the direct kill has anything left to do.
 */
const killGroup = (child) => {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL")
      return
    } catch {
      // The group is gone or was never created; fall through to the direct kill.
    }
  }
  child.kill("SIGKILL")
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
