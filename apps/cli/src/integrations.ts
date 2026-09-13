import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { basename, dirname, join, parse as parsePath, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_TRACE_ROOT,
  detectHosts,
  doctor,
  expandHome,
  HOSTS,
  type HookMode,
  type HostId,
  type InstallReport,
  install,
  isHostId,
  listIntegrations,
  locateBinary,
  rcFileFor,
  readTextOrNull,
  renderShellSnippet,
  type Scope,
  uninstall,
  upsertShellFence,
  writeTextAtomic
} from "@memhtml/integrations"

import { buildManifest } from "./commands.js"
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  type Failure,
  fail,
  type Success,
  succeed
} from "./envelope.js"
import { failureFor } from "./errors.js"
import { MCP_BIN_VAR } from "./serve.js"

/**
 * The `memhtml integrations` family: resolve the machine's own facts, call `@memhtml/integrations`, and
 * shape one envelope.
 *
 * **Every one of the five answers WITHOUT building the app layer**, the way `agents-doc` does, and here
 * the reason is stronger than a side effect. `install` is the FIRST command on a fresh machine: there is
 * no store yet, and `layerApp` would `mkdir -p $MEMHTML_ROOT/.memhtml` and run every migration as a side
 * effect of writing a config file. So nothing below opens a database, and the store root is a value that
 * gets recorded into a host's config rather than a thing that gets opened. `doctor` is the one arm that
 * reaches a running memhtml at all, and it does it as a CHILD PROCESS — `node <cli> manifest` for the
 * version and the recorded MCP server for the handshake — which is also the only honest way to check
 * whether the config a host will use actually starts.
 *
 * `MEMHTML_REFUSE_ENV_ROOT` therefore does not apply, and `run.ts` places these arms above the refusal
 * deliberately: the variable exists so a call that OPENS a repo has to name it, and these calls open none.
 * A `--repo` here (or `MEMHTML_ROOT`, or the `~/memhtml` default `config.ts` documents) is the path
 * written into a host's config for a store that may not exist yet.
 */

/** What one arm answers: the envelope `run.ts` renders, and the process exit code. */
export interface IntegrationsAnswer {
  readonly payload: Success<unknown> | Failure
  readonly exitCode: number
}

export interface IntegrationsInput {
  /** The host positional, already proven to be in the vocabulary by `validate`. Absent means every one. */
  readonly host?: string | undefined
  /** `--project <path>`, resolved to its git top level. Absent means user scope. */
  readonly project?: string | undefined
  readonly hooks?: string | undefined
  readonly bareCommand?: boolean
  readonly force?: boolean
  readonly dryRun?: boolean
  /** `--repo`: the store to record. */
  readonly repo?: string | undefined
  /** `--write` on `integrations shell`. */
  readonly write?: boolean
  /** `--rc` on `integrations shell`. */
  readonly rc?: string | undefined
  /** `process.argv[1]`, the entry script this process was started as. */
  readonly entry?: string | undefined
}

/** `$HOME` when the environment names one, else the OS answer. A test pins the former. */
const homeOf = (): string => {
  const named = process.env.HOME?.trim()
  return named === undefined || named === "" ? homedir() : resolve(named)
}

/**
 * The store to record, in the order `config.ts` documents: `--repo`, then `MEMHTML_ROOT`, then
 * `~/memhtml`. A leading `~` is expanded here because this value arrives from a shell profile, an MCP
 * client config, and a cron line, and only the shell expands tildes on its own.
 */
const storeRootOf = (input: IntegrationsInput, home: string): string => {
  const named = input.repo?.trim()
  const configured = process.env.MEMHTML_ROOT?.trim()
  const raw =
    named !== undefined && named !== ""
      ? named
      : configured !== undefined && configured !== ""
        ? configured
        : join("~", "memhtml")
  return resolve(expandHome(raw, home))
}

/**
 * Where this host writes transcripts, or `undefined` when nothing can read them.
 *
 * `MEMHTML_TRACE_ROOT` wins for ANY host: an operator who exports it has stated where transcripts live,
 * and that statement is worth more than our table. Absent, only Claude Code has a default, because
 * `@memhtml/traces` reads Claude Code's format and no other — and a `undefined` here is what makes
 * install write no indexing hook rather than one with nothing to read.
 */
const traceRootOf = (host: HostId, home: string): string | undefined => {
  const named = process.env.MEMHTML_TRACE_ROOT?.trim()
  if (named !== undefined && named !== "") return resolve(expandHome(named, home))
  const fallback = DEFAULT_TRACE_ROOT[host]
  return fallback === null ? undefined : resolve(expandHome(fallback, home))
}

/**
 * The `memhtml` entry script, and why `process.argv[1]` alone is not enough.
 *
 * The published binary IS `argv[1]`, so that is the first answer and the right one. But this module also
 * runs in-process — under vitest, and inside any host that imports `run()` — where `argv[1]` is somebody
 * else's entry point, and recording it would write a host config that spawns vitest. So the name is
 * checked against the two spellings this package ships, and anything else falls back to walking from this
 * module: `./bin.js` beside the built `dist/integrations.js`, `./memhtml.mjs` in the published bundle, and
 * `../dist/bin.js` for the source tree a test loads.
 */
const CLI_ENTRY_NAMES: ReadonlySet<string> = new Set(["bin.js", "memhtml.mjs", "memhtml"])
const CLI_CANDIDATES = ["./bin.js", "./memhtml.mjs", "../dist/bin.js"] as const

const cliEntry = async (named: string | undefined): Promise<string> => {
  const argv = named?.trim()
  if (argv !== undefined && argv !== "" && CLI_ENTRY_NAMES.has(basename(argv))) {
    if ((await readTextOrNull(argv)) !== null) return argv
  }
  for (const candidate of CLI_CANDIDATES) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if ((await readTextOrNull(path)) !== null) return path
  }
  throw new Error("could not locate the memhtml entry script: run `pnpm build`")
}

const binaryOf = async (input: IntegrationsInput) => {
  const override = process.env[MCP_BIN_VAR]?.trim()
  return locateBinary({
    entry: await cliEntry(input.entry),
    version: buildManifest().version,
    ...(override === undefined || override === "" ? {} : { mcpOverride: override })
  })
}

/** A resolved `--project`, or the usage failure that explains why the value is unusable. */
type ProjectRoot =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly failure: Failure }

/**
 * `--project <path>` resolved to its git top level.
 *
 * A repository root rather than the path given, because the host files a project install writes are read
 * from the root: `.mcp.json` in a subdirectory is a file no host looks at. `ERR_INVALID_FLAG` at exit 2
 * for every failure here, because what is unusable is the VALUE on the command line — the path is not a
 * repository, or it resolves somewhere no install may write — and the fix is on the line rather than in
 * the store.
 */
const projectRootOf = (path: string, home: string): ProjectRoot => {
  const refuse = (reason: string): ProjectRoot => ({
    ok: false,
    failure: fail("ERR_INVALID_FLAG", `--project ${path}: ${reason}`, [
      "memhtml integrations install <host> --project .",
      "memhtml integrations list"
    ])
  })
  const resolved = resolve(expandHome(path.trim() === "" ? "." : path.trim(), home))
  const probe = spawnSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000
  })
  if (probe.error !== undefined || probe.status !== 0) {
    return refuse("not inside a git repository, so there is no top level to install into")
  }
  const root = resolve(probe.stdout.trim())
  if (root === "") return refuse("git named no top level")
  if (root === parsePath(root).root) return refuse("its git top level is the filesystem root")
  if (root === resolve(home)) {
    return refuse("its git top level is your home directory, which is user scope — drop --project")
  }
  return { ok: true, root }
}

/** The hosts one call covers: the named one, or every host whose config directory exists. */
const hostsOf = async (input: IntegrationsInput, home: string): Promise<ReadonlyArray<HostId>> => {
  const named = input.host?.trim()
  if (named !== undefined && named !== "" && isHostId(named)) return [named]
  return detectHosts(home)
}

/**
 * Any failure from the transaction layer, as an envelope.
 *
 * `IntegrationModified` travels through `failureFor` so it carries `ERR_INTEGRATION_MODIFIED` and the
 * suggestions `errors.ts` already publishes for it. Everything else is `ERR_STORAGE` rather than
 * `ERR_UNKNOWN`, and that is a deliberate reading of both codes: every remaining failure in this family
 * is a filesystem one — a symlinked config path, a directory where a file has to go, a fence whose
 * markers were duplicated by hand — and `ERR_STORAGE` is the code whose published meaning is exactly
 * that. `ERR_UNKNOWN` would tell a caller nothing it could act on, where the suggestions below name the
 * two calls that describe the problem.
 */
const failureOf = (error: unknown, host: HostId | undefined): IntegrationsAnswer => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return { payload: failureFor(error), exitCode: EXIT_RUNTIME }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    payload: fail("ERR_STORAGE", message, [
      `memhtml integrations doctor${host === undefined ? "" : ` ${host}`}`,
      `memhtml integrations install${host === undefined ? "" : ` ${host}`} --dry-run`
    ]),
    exitCode: EXIT_RUNTIME
  }
}

/** One host's half of an `integrations.report`. */
interface HostReport {
  readonly host: HostId
  readonly changed: boolean
  readonly memhtmlRoot?: string
  readonly state?: string
  readonly entries: InstallReport["entries"]
  readonly backups: ReadonlyArray<string>
  readonly receiptPath: string
  readonly nextSteps: ReadonlyArray<string>
  readonly contents?: Readonly<Record<string, string>>
}

const hookModeOf = (input: IntegrationsInput): HookMode => {
  const named = input.hooks?.trim()
  return named === "session" || named === "none" ? named : "all"
}

/**
 * `integrations install`.
 *
 * The report is keyed by HOST under `hosts`, even for a single one, because the host argument is optional:
 * `memhtml integrations install` wires every host it detects, and a flat report could describe only the
 * last of them. `changed` at the top is true when any host changed, so a script can branch on one field.
 */
export const integrationsInstall = async (
  input: IntegrationsInput
): Promise<IntegrationsAnswer> => {
  const home = homeOf()
  let scope: Scope = "user"
  let root = home
  if (input.project !== undefined) {
    const project = projectRootOf(input.project, home)
    if (!project.ok) return { payload: project.failure, exitCode: EXIT_USAGE }
    scope = "project"
    root = project.root
  }
  const hosts = await hostsOf(input, home)
  const memhtmlRoot = storeRootOf(input, home)
  const dryRun = input.dryRun === true
  try {
    const binary = await binaryOf(input)
    const reports: Array<HostReport> = []
    for (const host of hosts) {
      const traceRoot = traceRootOf(host, home)
      const report = await install({
        host,
        scope,
        root,
        memhtmlRoot,
        ...(traceRoot === undefined ? {} : { traceRoot }),
        hooks: hookModeOf(input),
        bareCommand: input.bareCommand === true,
        binary,
        force: input.force === true,
        dryRun
      })
      reports.push({
        host,
        changed: report.changed,
        memhtmlRoot: report.memhtmlRoot,
        entries: report.entries,
        backups: report.backups,
        receiptPath: report.receiptPath,
        nextSteps: report.nextSteps,
        ...(report.contents === undefined ? {} : { contents: report.contents })
      })
    }
    return {
      payload: succeed("integrations.report", {
        action: "install",
        scope,
        root,
        memhtmlRoot,
        dryRun,
        changed: reports.some((report) => report.changed),
        hosts: reports
      }),
      exitCode: EXIT_OK
    }
  } catch (error) {
    return failureOf(error, hosts.length === 1 ? hosts[0] : undefined)
  }
}

/** `integrations uninstall <host>`: the same envelope type, with the entries it removed. */
export const integrationsUninstall = async (
  input: IntegrationsInput
): Promise<IntegrationsAnswer> => {
  const home = homeOf()
  const named = input.host?.trim() ?? ""
  if (!isHostId(named)) {
    // `validate` refuses an unknown host at exit 2 before this runs; this is the belt.
    return {
      payload: fail("ERR_UNKNOWN_HOST", `unknown host: ${named}. One of: ${HOSTS.join(", ")}`, []),
      exitCode: EXIT_USAGE
    }
  }
  let scope: Scope = "user"
  let root = home
  if (input.project !== undefined) {
    const project = projectRootOf(input.project, home)
    if (!project.ok) return { payload: project.failure, exitCode: EXIT_USAGE }
    scope = "project"
    root = project.root
  }
  try {
    const report = await uninstall(named, scope, root)
    return {
      payload: succeed("integrations.report", {
        action: "uninstall",
        scope,
        root,
        dryRun: false,
        changed: report.changed,
        hosts: [
          {
            host: report.host,
            changed: report.changed,
            state: report.state,
            entries: report.removed,
            backups: [],
            receiptPath: report.receiptPath,
            nextSteps: []
          }
        ]
      }),
      exitCode: EXIT_OK
    }
  } catch (error) {
    return failureOf(error, named)
  }
}

/** `integrations list`: one row per host per scope. */
export const integrationsList = async (input: IntegrationsInput): Promise<IntegrationsAnswer> => {
  const home = homeOf()
  let projectRoot: string | undefined
  if (input.project !== undefined) {
    const project = projectRootOf(input.project, home)
    if (!project.ok) return { payload: project.failure, exitCode: EXIT_USAGE }
    projectRoot = project.root
  }
  try {
    const rows = await listIntegrations(home, projectRoot)
    return {
      payload: succeed("integrations.list", {
        home,
        projectRoot: projectRoot ?? null,
        rows
      }),
      exitCode: EXIT_OK
    }
  } catch (error) {
    return failureOf(error, undefined)
  }
}

/**
 * `integrations doctor`.
 *
 * With no host argument, every host that has a RECEIPT — a host with none has nothing to diagnose, and a
 * report of four "not installed" rows would bury the one host the operator asked about. `healthy` at the
 * top is true only when every reported host is.
 */
export const integrationsDoctor = async (input: IntegrationsInput): Promise<IntegrationsAnswer> => {
  const home = homeOf()
  let scope: Scope = "user"
  let root = home
  if (input.project !== undefined) {
    const project = projectRootOf(input.project, home)
    if (!project.ok) return { payload: project.failure, exitCode: EXIT_USAGE }
    scope = "project"
    root = project.root
  }
  const named = input.host?.trim()
  try {
    const hosts =
      named !== undefined && named !== "" && isHostId(named)
        ? [named]
        : (await listIntegrations(home, scope === "project" ? root : undefined))
            .filter((row) => row.scope === scope && row.state !== "not-installed")
            .map((row) => row.host)
    const reports: Array<{
      readonly host: HostId
      readonly healthy: boolean
      readonly checks: Awaited<ReturnType<typeof doctor>>["checks"]
    }> = []
    for (const host of hosts) {
      const result = await doctor(host, scope, root)
      reports.push({ host, healthy: result.healthy, checks: result.checks })
    }
    return {
      payload: succeed("integrations.doctor", {
        scope,
        root,
        healthy: reports.length > 0 && reports.every((report) => report.healthy),
        hosts: reports
      }),
      exitCode: EXIT_OK
    }
  } catch (error) {
    return failureOf(error, named !== undefined && isHostId(named) ? named : undefined)
  }
}

/**
 * `integrations shell`: print the snippet, and with `--write` put it in the rc file inside the fence.
 *
 * The one arm that exists for a HUMAN rather than for a host. Every installed MCP entry and hook line
 * already carries its own absolute command and its own `MEMHTML_ROOT`, so nothing about a host
 * integration depends on this ever running.
 *
 * No symlink refusal here, unlike every path install writes. A `~/.zshrc` symlinked into a dotfiles
 * repository is the normal setup rather than the hazard, and the operator named this file (or accepted the
 * documented default) instead of it being derived from a host's config.
 */
export const integrationsShell = async (input: IntegrationsInput): Promise<IntegrationsAnswer> => {
  const home = homeOf()
  const memhtmlRoot = storeRootOf(input, home)
  try {
    const binary = await binaryOf(input)
    const snippet = renderShellSnippet({ memhtmlRoot, binDir: dirname(binary.cli) })
    const named = input.rc?.trim()
    const rc =
      named === undefined || named === ""
        ? rcFileFor(process.env.SHELL, home)
        : resolve(expandHome(named, home))
    if (input.write !== true) {
      return {
        payload: succeed("integrations.shell", { rc, snippet, written: false, changed: false }),
        exitCode: EXIT_OK
      }
    }
    const current = await readTextOrNull(rc)
    const next = upsertShellFence(current, snippet)
    const changed = next !== current
    if (changed) await writeTextAtomic(rc, next)
    return {
      payload: succeed("integrations.shell", { rc, snippet, written: true, changed }),
      exitCode: EXIT_OK
    }
  } catch (error) {
    return failureOf(error, undefined)
  }
}
