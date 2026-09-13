/**
 * `doctor`: check one host's wiring end to end, and finish by proving the server the config names
 * actually starts.
 *
 * Every row is a fact read from disk or from a child process. The two rows that need a child are
 * injected as {@link DoctorProbes} — the version the recorded CLI reports, and a live MCP `initialize`
 * handshake — so the whole diagnostic is drivable without spawning anything, and the default
 * implementations below are what the CLI passes.
 *
 * Two rules the checks obey rather than the other way round. The store-root row READS the directory and
 * looks for `.memhtml/`; it never calls `memhtml status`, because `status` on a bare directory scaffolds
 * a store and a diagnostic that creates what it is checking always passes. And Codex's hook trust is
 * reported as informational with `ok: true`: trust is keyed to a hook's hash inside the host, nothing
 * outside it can read the decision, and a red row for something unknowable would train an operator to
 * ignore the report.
 */

import { spawn } from "node:child_process"
import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { readJsonPath } from "./adapters/json.js"
import { cliCommand, mcpCommand } from "./command-line.js"
import { exists, isDirectory, readTextOrNull } from "./fs.js"
import { hostSpec } from "./hosts.js"
import { editorFor, receiptDriftReader } from "./install.js"
import { compareEntries, inspectReceiptFile, receiptPath } from "./receipt.js"
import { claudeOwned } from "./render/hooks.js"
import type { CommandLine, DoctorCheck, HostId, Receipt, Scope } from "./types.js"

/** What one probe answers. `value` is the version a `manifest` probe read, when it read one. */
export interface ProbeResult {
  readonly ok: boolean
  readonly detail: string
  readonly value?: string
}

/**
 * The two checks that need a child process.
 *
 * Split into two named probes rather than one generic `spawn`, because the two consume their child
 * completely differently — one reads a JSON envelope off a process that exits, the other holds a
 * long-lived stdio server open through a two-message handshake — and a caller handed one function could
 * not tell which behavior a row wanted.
 */
export interface DoctorProbes {
  /** Run `<cli> manifest` and report the version it prints. */
  readonly version: (
    cli: CommandLine,
    env: Readonly<Record<string, string>>
  ) => Promise<ProbeResult>
  /** Complete an MCP `initialize` handshake with the server this command line names. */
  readonly handshake: (
    mcp: CommandLine,
    env: Readonly<Record<string, string>>
  ) => Promise<ProbeResult>
}

export interface DoctorOptions {
  /** Override either probe; the rest fall back to the spawning defaults. */
  readonly probes?: Partial<DoctorProbes>
}

export interface DoctorResult {
  readonly healthy: boolean
  readonly checks: ReadonlyArray<DoctorCheck>
}

/** How long the handshake may take. A stdio server that has not answered by then is not wired. */
export const HANDSHAKE_TIMEOUT_MS = 5_000

/** How long the version probe may take. `manifest` opens nothing, so this is generous already. */
export const VERSION_TIMEOUT_MS = 10_000

/** The protocol revision `memhtml-mcp` speaks, and the only adapter it ships. */
export const MCP_PROTOCOL_VERSION = "2025-06-18"

/** The name `serverInfo` must carry for the handshake to be with OUR server. */
export const MCP_SERVER_NAME = "memhtml"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const check = (
  name: string,
  ok: boolean,
  detail: string,
  suggestions: ReadonlyArray<string> = []
): DoctorCheck => ({ name, ok, detail, suggestions })

/**
 * `<cli> manifest`, read for its version.
 *
 * `manifest` is the one command that answers with no store, no database, and no credential, which is
 * why it is the probe: a version check that opened the store would fail for reasons about the store.
 */
export const spawnVersion: DoctorProbes["version"] = (cli, env) =>
  new Promise<ProbeResult>((resolve) => {
    let settled = false
    let out = ""
    const child = spawn(cli.command, [...cli.args, "manifest"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env }
    })
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          detail: `\`manifest\` did not answer within ${VERSION_TIMEOUT_MS} ms`
        }),
      VERSION_TIMEOUT_MS
    )
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      out += chunk
    })
    child.on("error", (error) =>
      finish({ ok: false, detail: `could not run ${cli.command}: ${error.message}` })
    )
    child.on("close", () => {
      try {
        const parsed: unknown = JSON.parse(out)
        const data = isRecord(parsed) ? parsed.data : undefined
        const version = isRecord(data) ? data.version : undefined
        if (typeof version === "string") {
          finish({ ok: true, detail: `reports ${version}`, value: version })
          return
        }
        finish({ ok: false, detail: "`manifest` answered without a version" })
      } catch {
        finish({ ok: false, detail: "`manifest` did not answer one JSON envelope" })
      }
    })
  })

/** The two lines a client sends to open an MCP session, exactly as the tutorial documents them. */
const handshakeLines = (): string =>
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "memhtml-doctor", version: "0" }
    }
  })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`

/** `serverInfo.name` out of one NDJSON line, when the line is the `initialize` result. */
const serverInfoOf = (line: string): { readonly name: string; readonly version: string } | null => {
  if (line.trim().length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const result = parsed.result
  if (!isRecord(result)) return null
  const info = result.serverInfo
  if (!isRecord(info) || typeof info.name !== "string") return null
  return { name: info.name, version: typeof info.version === "string" ? info.version : "?" }
}

/**
 * Spawn the recorded server and complete `initialize`.
 *
 * The check that catches a config which READS correctly and starts nothing: a moved entry script, a node
 * that no longer exists, a bundle missing an asset. Every failure mode resolves rather than rejects, so
 * one bad row cannot take the report down with it, and the child is killed on every path — a doctor that
 * left a server holding the store's database open would be worse than no doctor.
 */
export const spawnHandshake: DoctorProbes["handshake"] = (mcp, env) =>
  new Promise<ProbeResult>((resolve) => {
    let settled = false
    let out = ""
    const child = spawn(mcp.command, [...mcp.args], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...env }
    })
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          detail: `no initialize result within ${HANDSHAKE_TIMEOUT_MS} ms`
        }),
      HANDSHAKE_TIMEOUT_MS
    )
    child.on("error", (error) =>
      finish({ ok: false, detail: `could not spawn ${mcp.command}: ${error.message}` })
    )
    child.on("exit", (code, signal) =>
      finish({
        ok: false,
        detail: `the server exited (${signal ?? `code ${String(code)}`}) before answering initialize`
      })
    )
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      out += chunk
      for (const line of out.split("\n")) {
        const info = serverInfoOf(line)
        if (info === null) continue
        finish(
          info.name === MCP_SERVER_NAME
            ? {
                ok: true,
                detail: `${info.name} ${info.version} answered initialize`,
                value: info.version
              }
            : { ok: false, detail: `the server called itself ${info.name}, not ${MCP_SERVER_NAME}` }
        )
        return
      }
    })
    child.stdin?.on("error", () => {
      // A server that closed stdin has already failed; the exit handler reports it.
    })
    child.stdin?.write(handshakeLines())
  })

export const DEFAULT_PROBES: DoctorProbes = { version: spawnVersion, handshake: spawnHandshake }

/** Every `command` string in one hook entry, whichever host's entry shape it is. */
const commandStrings = (entry: unknown): ReadonlyArray<string> => {
  if (!isRecord(entry)) return []
  const found: Array<string> = []
  if (typeof entry.command === "string") found.push(entry.command)
  if (Array.isArray(entry.hooks)) {
    for (const handler of entry.hooks) {
      if (isRecord(handler) && typeof handler.command === "string") found.push(handler.command)
    }
  }
  return found
}

const TRACE_ROOT_JSON = /"--trace-root"\s*,\s*"((?:[^"\\]|\\.)*)"/
const TRACE_ROOT_SHELL = /--trace-root\s+(?:'([^']*)'|"([^"]*)"|(\S+))/

/**
 * The transcript root an installed hook names, or `undefined` when none does.
 *
 * Read out of the installed command line rather than out of the receipt, because the receipt has no field
 * for it: the hook line IS the record of what install decided, in both spellings it ships — a shell
 * string for the three hosts that store a hook as text, and a JSON argv array inside the OpenCode plugin.
 */
export const traceRootIn = (text: string): string | undefined => {
  const asJson = TRACE_ROOT_JSON.exec(text)
  if (asJson?.[1] !== undefined) {
    try {
      const decoded: unknown = JSON.parse(`"${asJson[1]}"`)
      if (typeof decoded === "string" && decoded.length > 0) return decoded
    } catch {
      // Falls through to the shell spelling.
    }
  }
  const asShell = TRACE_ROOT_SHELL.exec(text)
  const found = asShell?.[1] ?? asShell?.[2] ?? asShell?.[3]
  return found === undefined || found.length === 0 ? undefined : found
}

/** True when `root` holds a `*.jsonl` within two directory levels. */
const hasTranscript = async (root: string, depth = 2): Promise<boolean> => {
  let entries: ReadonlyArray<Dirent<string>>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) return true
  }
  if (depth === 0) return false
  for (const entry of entries) {
    if (entry.isDirectory() && (await hasTranscript(join(root, entry.name), depth - 1))) return true
  }
  return false
}

/**
 * Every check for one host at one scope.
 *
 * An absent or unreadable receipt answers with that ONE row and stops: nothing else is knowable without
 * it, and a report of twelve failures whose single cause is "not installed" is a report nobody reads to
 * the end.
 */
export const doctor = async (
  host: HostId,
  scope: Scope,
  root: string,
  opts: DoctorOptions = {}
): Promise<DoctorResult> => {
  const probes: DoctorProbes = { ...DEFAULT_PROBES, ...opts.probes }
  const path = receiptPath(scope, root, host)
  const inspected = await inspectReceiptFile(path)
  const install = `memhtml integrations install ${host}${scope === "project" ? " --project ." : ""}`
  if (inspected.state === "absent") {
    return {
      healthy: false,
      checks: [
        check(
          "receipt",
          false,
          `no receipt at ${path}: ${host} is not installed at ${scope} scope`,
          [install, "memhtml integrations list"]
        )
      ]
    }
  }
  const receipt = inspected.receipt
  if (receipt === null) {
    return {
      healthy: false,
      checks: [
        check(
          "receipt",
          false,
          `the receipt at ${path} is not usable: ${inspected.problem ?? "unknown problem"}`,
          [`${install} --force`]
        )
      ]
    }
  }

  const checks: Array<DoctorCheck> = [
    check("receipt", true, `${path}, written ${receipt.installedAt} by memhtml ${receipt.version}`)
  ]
  const spec = hostSpec(receipt.host, receipt.scope, receipt.root)
  const env = { MEMHTML_ROOT: receipt.memhtmlRoot }

  for (const [name, target] of [
    ["binary-node", receipt.binary.node],
    ["binary-cli", receipt.binary.cli],
    ["binary-mcp", receipt.binary.mcp]
  ] as const) {
    const there = await exists(target)
    checks.push(
      check(
        name,
        there,
        there ? target : `${target} is gone: the toolchain moved since install`,
        there ? [] : [install]
      )
    )
  }

  const version = await probes.version(cliCommand(receipt.binary, receipt.bareCommand), env)
  const matches = version.ok && version.value === receipt.binary.version
  checks.push(
    check(
      "cli-version",
      matches,
      version.ok
        ? matches
          ? `${version.value} matches the receipt`
          : `the binary reports ${version.value ?? "?"} and the receipt records ${receipt.binary.version}: it was upgraded since install`
        : version.detail,
      matches ? [] : [install]
    )
  )

  const storeThere = await isDirectory(receipt.memhtmlRoot)
  const indexThere = storeThere && (await isDirectory(join(receipt.memhtmlRoot, ".memhtml")))
  checks.push(
    check(
      "store-root",
      indexThere,
      indexThere
        ? `${receipt.memhtmlRoot} holds .memhtml/`
        : storeThere
          ? `${receipt.memhtmlRoot} exists but holds no .memhtml/: it is a directory, not a store`
          : `${receipt.memhtmlRoot} does not exist`,
      indexThere ? [] : [`memhtml init --repo ${receipt.memhtmlRoot}`]
    )
  )

  const compared = await compareEntries(receipt.entries, receiptDriftReader(receipt))
  for (const entry of receipt.entries) {
    const drifted = compared.drift.find((row) => row.entry === entry)
    checks.push(
      check(
        `entry:${entry.role}`,
        drifted === undefined,
        drifted === undefined
          ? `${entry.path} matches the receipt`
          : drifted.actual === null
            ? `${entry.path} no longer carries the ${entry.role} the receipt claims`
            : `${entry.path} was edited since install`,
        drifted === undefined
          ? []
          : [`${install} --force`, `memhtml integrations uninstall ${host}`]
      )
    )
  }

  if (receipt.hooks === "none") {
    checks.push(check("hooks", true, "installed with --hooks none, so no hook is expected"))
  } else if (spec.hooks.format === "plugin-file") {
    const there = await exists(spec.hooks.file)
    checks.push(
      check(
        "hooks",
        there,
        there ? spec.hooks.file : `the plugin at ${spec.hooks.file} is gone`,
        there ? [] : [install]
      )
    )
  } else {
    const text = await readTextOrNull(spec.hooks.file)
    const owned = editorFor(
      spec,
      { role: "hooks", kind: "fragment" },
      receipt.binary,
      receipt.bareCommand
    ).ownedNow(text)
    checks.push(
      check(
        "hooks",
        owned !== null,
        owned === null
          ? `${spec.hooks.file} carries no memhtml hook entry`
          : `${spec.hooks.file} carries our entries`,
        owned === null ? [install] : []
      )
    )
  }

  if (spec.instruction === null) {
    checks.push(
      check(
        "instruction-block",
        true,
        `${spec.displayName} has no user-level instruction file; the discipline is in the skill and in the project rule`
      )
    )
  } else {
    /**
     * The BLOCK, not the file. A `CLAUDE.md` somebody emptied still exists, so a row that checked for the
     * file would stay green over an instruction file carrying none of our prose. Cursor's project rule is
     * a whole file of ours and is covered by the same read, since its editor owns the whole text.
     */
    const claimed = receipt.entries.filter(
      (entry) => entry.role === "instruction-block" || entry.role === "rules"
    )
    const missing: Array<string> = []
    for (const entry of claimed) {
      const text = await readTextOrNull(entry.path)
      const owned = editorFor(spec, entry, receipt.binary, receipt.bareCommand).ownedNow(text)
      if (owned === null) missing.push(entry.path)
    }
    const present = claimed.length > 0 && missing.length === 0
    checks.push(
      check(
        "instruction-block",
        present,
        present
          ? claimed.map((entry) => entry.path).join(", ")
          : claimed.length === 0
            ? "the receipt claims no instruction file"
            : `no memhtml block in ${missing.join(", ")}`,
        present ? [] : [install]
      )
    )
  }

  const skill = receipt.entries.find((entry) => entry.role === "skill")
  const skillThere = skill !== undefined && (await exists(skill.path))
  checks.push(
    check(
      "skill",
      skillThere,
      skillThere ? (skill?.path ?? "") : `no SKILL.md at ${spec.skill}`,
      skillThere ? [] : [install]
    )
  )

  /**
   * The transcript root, when a hook names one. Absent is not a failure: three of the four hosts have no
   * transcript format memhtml can read, so no indexing hook is installed for them and there is nothing to
   * check. An empty root IS a failure, because the hook is armed and reading nothing.
   */
  const hookText = await readTextOrNull(spec.hooks.file)
  const commands =
    spec.hooks.format === "json-arrays"
      ? ownedHookCommands(hookText, spec.hooks.keyPath, receipt)
      : hookText === null
        ? []
        : [hookText]
  const traceRoot = commands.map((line) => traceRootIn(line)).find((found) => found !== undefined)
  if (traceRoot !== undefined) {
    const populated = await hasTranscript(traceRoot)
    checks.push(
      check(
        "trace-root",
        populated,
        populated
          ? `${traceRoot} holds transcripts`
          : `${traceRoot} holds no *.jsonl within two levels: the indexing hooks have nothing to read`,
        populated ? [] : ["memhtml trace index --trace-root <where this host writes transcripts>"]
      )
    )
  }

  /**
   * The live handshake, and the one condition under which it is NOT attempted.
   *
   * Starting the server opens the store, and opening a store creates `.memhtml/` — so running this row
   * over a root that has none would scaffold the very thing the row above just reported missing, and the
   * next `doctor` would read green. The store-root row is therefore a gate on this one, with a detail
   * that says so rather than a silent skip.
   */
  const handshake = indexThere
    ? await probes.handshake(mcpCommand(receipt.binary, receipt.bareCommand), env)
    : {
        ok: false,
        detail: `not attempted: ${receipt.memhtmlRoot} holds no .memhtml/, and starting the server would create one`
      }
  checks.push(
    check(
      "mcp-handshake",
      handshake.ok,
      handshake.detail,
      handshake.ok ? [] : [install, `memhtml init --repo ${receipt.memhtmlRoot}`]
    )
  )

  if (host === "codex") {
    checks.push(
      check(
        "hook-trust",
        true,
        "Codex hooks must be trusted in /hooks; trust is keyed to the hook's hash and is not verifiable from outside the host"
      )
    )
  }

  return { healthy: checks.every((row) => row.ok), checks }
}

/** Every command string of every hook entry the receipt's binary owns. */
const ownedHookCommands = (
  text: string | null,
  keyPath: ReadonlyArray<string>,
  receipt: Receipt
): ReadonlyArray<string> => {
  const groups = readJsonPath(text, keyPath)
  if (!isRecord(groups)) return []
  const found: Array<string> = []
  for (const entries of Object.values(groups)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (claudeOwned(entry, receipt.binary, receipt.bareCommand)) {
        found.push(...commandStrings(entry))
      }
    }
  }
  return found
}
