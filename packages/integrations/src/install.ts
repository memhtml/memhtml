/**
 * `install`: plan every file install would touch, prove we own what is already there, then land the
 * whole set or none of it.
 *
 * Three properties hold this module together, and every decision below serves one of them.
 *
 * **A plan is pure.** Each artifact becomes a {@link PlannedWrite} carrying three total functions of the
 * file's current text: `apply` returns the whole new file, `strip` removes our part (`null` means the
 * file may go), and `ownedNow` extracts the bytes we claim so their SHA-256 can be compared with the
 * receipt. Nothing in a plan touches disk, so `--dry-run` is the same code path as a real install with
 * the last step removed, and the rendered content a dry run reports is byte-for-byte what a real one
 * would write.
 *
 * **A human's edit wins.** Before anything is written, every receipt claim is re-hashed against disk and
 * every unclaimed artifact is checked for something already sitting where ours goes. Either one refuses
 * with `IntegrationModified` and writes NOTHING. `--force` is the override, and it keeps the prior bytes
 * beside the file as a timestamped backup the report names.
 *
 * **All or nothing.** Every target file is snapshotted, the writes land one file at a time, and the
 * receipt is written LAST — so a receipt on disk always describes files that exist. Any throw restores
 * every snapshot and removes every backup, which leaves a failed install indistinguishable from one that
 * never ran.
 */

import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { parse as parsePath, resolve as resolvePath } from "node:path"

import {
  readJsonPath,
  removeArrayEntries,
  removeJsonPath,
  upsertArrayEntries,
  upsertJsonPath
} from "./adapters/json.js"
import {
  isClaudeImportOnly,
  readFencedBlock,
  removeFencedBlock,
  upsertFencedBlock
} from "./adapters/markdown.js"
import {
  hasUnfencedTable,
  readFencedToml,
  removeFencedToml,
  upsertFencedToml
} from "./adapters/toml.js"
import { cliCommand, type HookCommandOptions, mcpCommand } from "./command-line.js"
import { IntegrationModified } from "./errors.js"
import {
  assertNoSymlinkComponents,
  readTextOrNull,
  restoreText,
  sha256,
  snapshotText,
  type TextSnapshot,
  writeTextAtomic
} from "./fs.js"
import { type HostSpec, hostSpec } from "./hosts.js"
import { compareEntries, inspectReceiptFile, receiptPath, writeReceipt } from "./receipt.js"
import {
  renderClaudeImportBlock,
  renderCursorRules,
  renderInstructionBlock
} from "./render/block.js"
import { claudeHooks, claudeOwned, codexHooks, cursorHooks } from "./render/hooks.js"
import { claudeMcpEntry, codexMcpToml, cursorMcpEntry, opencodeMcpEntry } from "./render/mcp.js"
import { renderOpenCodePlugin } from "./render/plugin.js"
import { renderSkill } from "./render/skill.js"
import type {
  BinaryLocation,
  HostId,
  InstallOptions,
  ManagedRole,
  ManagedWrite,
  Receipt,
  ReceiptEntry,
  Scope
} from "./types.js"

/**
 * What happened to one managed path. `planned` is the dry-run answer and `removed` is uninstall's, so
 * one vocabulary describes every row either verb reports.
 */
export const ENTRY_ACTIONS = ["created", "updated", "unchanged", "planned", "removed"] as const
export type EntryAction = (typeof ENTRY_ACTIONS)[number]

/** One artifact, plus the three total functions that make it a transaction step. */
export interface PlannedWrite extends ManagedWrite {
  /** The whole new file, given its current text (`null` when absent); `null` means the file goes. */
  readonly apply: (current: string | null) => string | null
  /** The file with our part removed; `null` when nothing of the caller's would be left. */
  readonly strip: (current: string | null) => string | null
  /** The bytes we claim as they are on disk NOW, or `null` when our part is absent. */
  readonly ownedNow: (current: string | null) => string | null
  /**
   * A write that REMOVES an artifact the previous receipt claims and claims nothing itself: the hooks or
   * plugin of an install being re-run with `--hooks none`. Reported as `removed`, absent from the new
   * receipt. Without it the new receipt would drop the entry while the hooks stayed armed on disk, with
   * no record left to remove them by.
   */
  readonly retire?: true
}

export interface InstallPlan {
  readonly host: HostId
  readonly scope: Scope
  readonly root: string
  readonly memhtmlRoot: string
  readonly writes: ReadonlyArray<PlannedWrite>
  readonly nextSteps: ReadonlyArray<string>
  readonly receiptPath: string
  /** The receipt as it stands, or `null` when this host is not installed at this scope. */
  readonly previous: Receipt | null
  /** Set when a receipt is present but unreadable, which only `--force` gets past; it is backed up. */
  readonly previousProblem?: string
}

export interface EntryReport {
  readonly path: string
  readonly role: ManagedRole
  readonly kind: "file" | "fragment"
  readonly action: EntryAction
}

export interface InstallReport {
  readonly host: HostId
  readonly scope: Scope
  readonly root: string
  readonly memhtmlRoot: string
  /** False when every managed fragment already matched the plan and the receipt already described it. */
  readonly changed: boolean
  readonly dryRun: boolean
  readonly entries: ReadonlyArray<EntryReport>
  /** Prior bytes kept beside a file `--force` overwrote, absolute. */
  readonly backups: ReadonlyArray<string>
  readonly receiptPath: string
  readonly nextSteps: ReadonlyArray<string>
  /** The whole new text of every file, dry run only. */
  readonly contents?: Readonly<Record<string, string>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A JSON document with nothing left in it, as the signal that its file may go.
 *
 * Applies to a config install CREATED: strip removes our key, the parent object it created empties, and
 * what remains is `{}` — a file the host now has to parse for no reason. A document that still carries
 * one of the operator's keys is never touched.
 */
const emptyJsonOrNull = (text: string): string | null => {
  const value = readJsonPath(text, [])
  return isRecord(value) && Object.keys(value).length === 0 ? null : text
}

const blankOrNull = (text: string): string | null => (text.trim().length === 0 ? null : text)

/**
 * A read that answers `null` for every spelling of "there is no file here".
 *
 * `readTextOrNull` catches `ENOENT` alone, deliberately, so an unreadable file cannot read as an absent
 * one. `ENOTDIR` is the third spelling of absent — a component of the path is a regular file — and it
 * has to be treated as absence HERE, because refusing the whole install would deny the write phase the
 * chance to fail on the same obstacle, where the rollback path can put everything back.
 */
const currentText = async (path: string): Promise<string | null> => {
  try {
    return await readTextOrNull(path)
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined
    if (code === "ENOTDIR") return null
    throw error
  }
}

/**
 * A snapshot that tolerates the same three spellings of absence {@link currentText} does.
 *
 * `snapshotText` reads through `readTextOrNull`, so a path whose parent is a regular file throws ENOTDIR
 * while being SNAPSHOTTED — before the write phase, which is the phase that has to fail on that obstacle
 * so the rollback path can put the earlier files back. Measured: without this the whole install failed
 * before writing anything, which is a correct outcome reached by a route that leaves rollback untested.
 */
const snapshotOf = async (path: string): Promise<TextSnapshot> => {
  try {
    return await snapshotText(path)
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined
    if (code === "ENOTDIR") return { path, text: null, mode: null }
    throw error
  }
}

/** How one artifact's bytes are read back out of a file and removed from it. */
interface Editor {
  readonly ownedNow: (current: string | null) => string | null
  readonly strip: (current: string | null) => string | null
}

/** A file that is wholly ours: the skill, the OpenCode plugin, the Cursor rule. */
const wholeFileEditor: Editor = {
  ownedNow: (current) => current,
  strip: () => null
}

/**
 * One JSON key.
 *
 * The claimed bytes are `JSON.stringify` of the value at the key rather than the file's own slice of
 * text, so the claim survives an operator reformatting the document around it and still changes the
 * moment a value inside it changes.
 *
 * Strip removes the key and then every ANCESTOR object it leaves empty, because `{"mcpServers": {}}` is
 * a container install created and an uninstall that left it behind has not restored the file.
 */
const jsonKeyEditor = (keyPath: ReadonlyArray<string>): Editor => ({
  ownedNow: (current) => {
    const value = readJsonPath(current, keyPath)
    return value === undefined ? null : JSON.stringify(value)
  },
  strip: (current) => {
    let text = removeJsonPath(current, keyPath)
    for (let depth = keyPath.length - 1; depth > 0; depth -= 1) {
      const prefix = keyPath.slice(0, depth)
      const value = readJsonPath(text, prefix)
      if (!isRecord(value) || Object.keys(value).length > 0) break
      text = removeJsonPath(text, prefix)
    }
    return emptyJsonOrNull(text)
  }
})

/** Codex's `config.toml` fence. A read of malformed markers is drift, not a crash — see {@link safe}. */
const tomlFenceEditor: Editor = {
  ownedNow: (current) => safe(() => readFencedToml(current)),
  strip: (current) => blankOrNull(removeFencedToml(current))
}

/** A Markdown instruction block. */
const markdownBlockEditor: Editor = {
  ownedNow: (current) => safe(() => readFencedBlock(current)),
  strip: (current) => blankOrNull(removeFencedBlock(current))
}

/**
 * A read that turns a malformed fence into "our fragment is not there".
 *
 * The fence adapters throw on duplicated or unpaired markers, which is right for a WRITE — a repair
 * guess can delete the operator's lines. On the ownership read it has to become `null`, so the file
 * reads as drifted and the install refuses with the code the operator can act on, instead of surfacing
 * a parse error from inside a hash comparison.
 */
const safe = (read: () => string | null): string | null => {
  try {
    return read()
  } catch {
    return null
  }
}

/**
 * A host's hooks object: the keys are the host's own event names, the values arrays of entries.
 *
 * The claim covers every owned entry under EVERY event key present in the file, sorted by key, not just
 * the events this install renders. A leftover entry from a wider `--hooks` mode is then visible as
 * drift rather than surviving invisibly beside the current set.
 */
const hooksEditor = (
  keyPath: ReadonlyArray<string>,
  owned: (entry: unknown) => boolean,
  versionKey?: { readonly keyPath: ReadonlyArray<string>; readonly value: number }
): Editor => ({
  ownedNow: (current) => {
    const groups = readJsonPath(current, keyPath)
    if (!isRecord(groups)) return null
    const mine: Record<string, ReadonlyArray<unknown>> = {}
    for (const event of Object.keys(groups).sort()) {
      const entries = groups[event]
      if (!Array.isArray(entries)) continue
      const ours = entries.filter((entry) => owned(entry))
      if (ours.length > 0) mine[event] = ours
    }
    return Object.keys(mine).length === 0 ? null : JSON.stringify(mine)
  },
  strip: (current) => {
    let text = current ?? ""
    const groups = readJsonPath(current, keyPath)
    if (isRecord(groups)) {
      for (const event of Object.keys(groups)) {
        text = removeArrayEntries(text, [...keyPath, event], owned)
      }
    }
    const after = readJsonPath(text, keyPath)
    if (isRecord(after) && Object.keys(after).length === 0) text = removeJsonPath(text, keyPath)
    /**
     * Cursor's `{"version": 1}` goes only when nothing else is left. Install writes it to make a file
     * Cursor will read, so leaving it behind on an uninstall would leave a file the operator never had;
     * removing it while their own hooks remain would break the file.
     */
    if (versionKey !== undefined) {
      const document = readJsonPath(text, [])
      const only = versionKey.keyPath[0]
      if (
        only !== undefined &&
        isRecord(document) &&
        Object.keys(document).length === 1 &&
        document[only] === versionKey.value
      ) {
        text = removeJsonPath(text, versionKey.keyPath)
      }
    }
    return emptyJsonOrNull(text)
  }
})

/**
 * The editor for one receipt entry, derived from the host's spec and the receipt's own binary.
 *
 * The binary comes from the RECEIPT rather than from what resolves today, because ownership of a hooks
 * entry is decided by the command line that was written: an upgrade moves the entry script, and an entry
 * matched against the new path would read as somebody else's.
 */
export const editorFor = (
  spec: HostSpec,
  entry: Pick<ReceiptEntry, "role" | "kind">,
  binary: BinaryLocation,
  bare: boolean
): Editor => {
  if (entry.kind === "file") return wholeFileEditor
  switch (entry.role) {
    case "mcp-entry":
      return spec.mcp.format === "json" ? jsonKeyEditor(spec.mcp.keyPath) : tomlFenceEditor
    case "hooks":
      return spec.hooks.format === "json-arrays"
        ? hooksEditor(
            spec.hooks.keyPath,
            (candidate) => claudeOwned(candidate, binary, bare),
            spec.hooks.versionKey
          )
        : wholeFileEditor
    case "instruction-block":
      return markdownBlockEditor
    default:
      return wholeFileEditor
  }
}

/** Which entry of a receipt claims this path and role, if any. */
export const claimOf = (
  receipt: Receipt | null,
  path: string,
  role: ManagedRole
): ReceiptEntry | undefined =>
  receipt?.entries.find((entry) => entry.path === path && entry.role === role)

/**
 * Re-hash every receipt claim against disk.
 *
 * Handed to `compareEntries`, which is what turns the result into `installed` or `modified`. The reader
 * is built from the receipt alone — its host, scope, root, binary — so an entry the CURRENT plan no
 * longer renders is still checked, which is what stops an uninstall from deleting a leftover a human has
 * since edited.
 */
export const receiptDriftReader =
  (receipt: Receipt) =>
  async (entry: ReceiptEntry): Promise<string | null> => {
    const text = await currentText(entry.path)
    if (text === null) return null
    const spec = hostSpec(receipt.host, receipt.scope, receipt.root)
    const owned = editorFor(spec, entry, receipt.binary, receipt.bareCommand).ownedNow(text)
    return owned === null ? null : sha256(owned)
  }

const hookOptionsOf = (options: InstallOptions): HookCommandOptions =>
  options.traceRoot === undefined
    ? { memhtmlRoot: options.memhtmlRoot }
    : { memhtmlRoot: options.memhtmlRoot, traceRoot: options.traceRoot }

/**
 * The env every host's MCP entry carries.
 *
 * `MEMHTML_ROOT` explicitly, because a GUI host launches the server from its own environment and the
 * `~/memhtml` default is unlikely to be the store the operator meant. Nothing else: the entry locates a
 * store and configures none of the model or credential surface, which the server reads from the
 * environment it is launched in like every other process.
 */
const mcpEnv = (options: InstallOptions): Readonly<Record<string, string>> => ({
  MEMHTML_ROOT: options.memhtmlRoot
})

/**
 * The predicate that recognizes a hooks entry as ours, for install.
 *
 * The union of the binary being installed and the one the receipt records, because an upgrade moves the
 * entry script: matched against the new path alone, the entry the last install wrote would read as
 * somebody else's and survive beside the new one, so every session would run the hook twice.
 */
const installOwned =
  (options: InstallOptions, previous: Receipt | null) =>
  (entry: unknown): boolean =>
    claudeOwned(entry, options.binary, options.bareCommand) ||
    (previous !== null && claudeOwned(entry, previous.binary, previous.bareCommand))

/**
 * One fragment write, whose CLAIM is what the editor reads back out of a file we just wrote.
 *
 * Not the raw render, and that is the fix for a defect this caught: the fence adapters store a body with
 * its trailing blank lines trimmed, so a claim of the rendered bytes hashed something no file ever
 * contains and every re-install read as drift. Rendering once into an empty file and asking the editor
 * what it owns makes the claim true by construction, whatever an adapter normalizes.
 */
const fragment = (
  role: ManagedRole,
  path: string,
  rendered: string,
  editor: Editor,
  apply: (current: string | null) => string
): PlannedWrite => ({
  kind: "fragment",
  role,
  path,
  content: editor.ownedNow(apply(null)) ?? rendered,
  apply,
  strip: editor.strip,
  ownedNow: editor.ownedNow
})

const wholeFile = (role: ManagedRole, path: string, content: string): PlannedWrite => ({
  kind: "file",
  role,
  path,
  content,
  apply: () => content,
  strip: wholeFileEditor.strip,
  ownedNow: wholeFileEditor.ownedNow
})

/**
 * Every artifact one install would write, as pure functions, plus the receipt it would replace.
 *
 * Reads disk in exactly two places, and both are questions a renderer cannot answer: whether this
 * host is already installed (the receipt, which decides which command lines count as ours), and whether
 * a project already keeps its instructions in `AGENTS.md` (which decides where Claude Code's block
 * lands).
 */
export const planInstall = async (options: InstallOptions): Promise<InstallPlan> => {
  const spec = hostSpec(options.host, options.scope, options.root)
  const receipt = receiptPath(options.scope, options.root, options.host)
  const inspected = await inspectReceiptFile(receipt)
  /**
   * A receipt that is there and cannot be read is not "not installed". Planning over it as a fresh
   * install would overwrite the only record of what an earlier install wrote, so it refuses like any
   * other edit we cannot account for; `--force` proceeds as a fresh install and keeps the bytes beside it.
   */
  if (inspected.state === "invalid" && !options.force) {
    throw new IntegrationModified({
      host: options.host,
      path: receipt,
      detail: `the receipt cannot be read (${inspected.problem ?? "unknown problem"}), and install never overwrites a receipt it cannot account for`
    })
  }
  const previous = inspected.receipt
  const bare = options.bareCommand
  const mcp = mcpCommand(options.binary, bare)
  const cli = cliCommand(options.binary, bare)
  const env = mcpEnv(options)
  const hookOpts = hookOptionsOf(options)
  const owned = installOwned(options, previous)
  const writes: Array<PlannedWrite> = []

  // The MCP entry, in whichever document this host keeps its servers in.
  if (spec.mcp.format === "json") {
    const entry =
      options.host === "opencode"
        ? opencodeMcpEntry(mcp, env)
        : options.host === "cursor"
          ? cursorMcpEntry(mcp, env)
          : claudeMcpEntry(mcp, env)
    const keyPath = spec.mcp.keyPath
    writes.push(
      fragment(
        "mcp-entry",
        spec.mcp.file,
        JSON.stringify(entry),
        jsonKeyEditor(keyPath),
        (current) => upsertJsonPath(current, keyPath, entry)
      )
    )
  } else {
    const block = codexMcpToml(mcp, env)
    writes.push(
      fragment("mcp-entry", spec.mcp.file, block, tomlFenceEditor, (current) =>
        upsertFencedToml(current, block)
      )
    )
  }

  // The hooks, or the plugin that is this host's hook surface.
  if (options.hooks !== "none") {
    if (spec.hooks.format === "json-arrays") {
      const rendered =
        options.host === "cursor"
          ? cursorHooks(options.binary, bare, options.hooks, hookOpts)
          : options.host === "codex"
            ? codexHooks(options.binary, bare, options.hooks, hookOpts)
            : claudeHooks(options.binary, bare, options.hooks, hookOpts)
      const target = spec.hooks
      const claimed: Record<string, ReadonlyArray<unknown>> = {}
      for (const event of Object.keys(rendered).sort()) {
        const entries = rendered[event]
        if (entries !== undefined && entries.length > 0) claimed[event] = entries
      }
      const editor = hooksEditor(target.keyPath, owned, target.versionKey)
      writes.push(
        fragment("hooks", target.file, JSON.stringify(claimed), editor, (current) => {
          let text = current ?? ""
          const version = target.versionKey
          if (version !== undefined && readJsonPath(text, version.keyPath) === undefined) {
            text = upsertJsonPath(text, version.keyPath, version.value)
          }
          // Ours are dropped from every event key the file carries, so a narrower `--hooks` mode on a
          // re-install removes the events it no longer wants rather than leaving them armed.
          const existing = readJsonPath(text, target.keyPath)
          if (isRecord(existing)) {
            for (const event of Object.keys(existing)) {
              if (claimed[event] === undefined) {
                text = removeArrayEntries(text, [...target.keyPath, event], owned)
              }
            }
          }
          for (const [event, entries] of Object.entries(claimed)) {
            text = upsertArrayEntries(text, [...target.keyPath, event], entries, owned)
          }
          const after = readJsonPath(text, target.keyPath)
          if (isRecord(after) && Object.keys(after).length === 0) {
            text = removeJsonPath(text, target.keyPath)
          }
          return text
        })
      )
    } else {
      const plugin = renderOpenCodePlugin(options.binary, bare, options.hooks, hookOpts)
      if (plugin.length > 0) writes.push(wholeFile("plugin", spec.hooks.file, plugin))
    }
  } else if (previous !== null) {
    // `--hooks none` over an install that wrote hooks: strip what the previous receipt claims, so the
    // hooks leave the disk in the same transaction that drops them from the receipt.
    for (const entry of previous.entries) {
      if (entry.role !== "hooks" && entry.role !== "plugin") continue
      const editor = editorFor(spec, entry, previous.binary, previous.bareCommand)
      writes.push({
        kind: entry.kind,
        role: entry.role,
        path: entry.path,
        content: "",
        apply: editor.strip,
        strip: editor.strip,
        ownedNow: editor.ownedNow,
        retire: true
      })
    }
  }

  // The instruction prose.
  const instruction = spec.instruction
  if (instruction !== null) {
    const body = renderInstructionBlock({
      host: options.host,
      memhtmlRoot: options.memhtmlRoot,
      cli,
      hasMcp: true
    })
    if (instruction.format === "cursor-rules") {
      writes.push(wholeFile("rules", instruction.file, renderCursorRules(body)))
    } else {
      const agentsFile = instruction.agentsFile
      /**
       * Claude Code at project scope. A repository that already keeps its instructions in `AGENTS.md`
       * gets the block THERE and a `@AGENTS.md` import in `CLAUDE.md` — Claude Code resolves an `@` line
       * as an import, so the prose exists once and both readers see it. A `CLAUDE.md` that is ALREADY
       * only that import is left alone: it is a pointer the operator chose, and writing our block into
       * it would show the same text twice in every session (openwiki #841).
       */
      const useAgents = agentsFile !== undefined && (await currentText(agentsFile)) !== null
      const blockFile = useAgents && agentsFile !== undefined ? agentsFile : instruction.file
      writes.push(
        fragment("instruction-block", blockFile, body, markdownBlockEditor, (current) =>
          upsertFencedBlock(current, body)
        )
      )
      if (useAgents) {
        const importBody = renderClaudeImportBlock().trim()
        const pointer = await currentText(instruction.file)
        if (!isClaudeImportOnly(pointer)) {
          writes.push(
            fragment(
              "instruction-block",
              instruction.file,
              importBody,
              markdownBlockEditor,
              (current) => upsertFencedBlock(current, importBody)
            )
          )
        }
      }
    }
  }

  writes.push(
    wholeFile("skill", spec.skill, renderSkill({ memhtmlRoot: options.memhtmlRoot, cli }))
  )

  return {
    host: options.host,
    scope: options.scope,
    root: options.root,
    memhtmlRoot: options.memhtmlRoot,
    writes,
    nextSteps: spec.nextSteps,
    receiptPath: receipt,
    previous,
    ...(inspected.state === "invalid" && inspected.problem !== undefined
      ? { previousProblem: inspected.problem }
      : {})
  }
}

/** The paths one plan touches, in write order, each once. */
const pathsOf = (writes: ReadonlyArray<PlannedWrite>): ReadonlyArray<string> => [
  ...new Set(writes.map((write) => write.path))
]

/**
 * A project root that is not a place to install.
 *
 * `/` and `$HOME` are refused because a `git rev-parse --show-toplevel` that answers either of them is a
 * repository whose blast radius is every repository under it — and at `$HOME` the project files would
 * also collide with the user-scope install, where two receipts would each claim the same bytes.
 */
const assertUsableRoot = (options: InstallOptions): void => {
  if (options.scope !== "project") return
  const root = resolvePath(options.root)
  if (root === parsePath(root).root) {
    throw new Error(`refusing ${root} as a project root: it is the filesystem root`)
  }
  if (root === resolvePath(homedir())) {
    throw new Error(
      `refusing ${root} as a project root: it is the home directory, which is user scope — install without --project`
    )
  }
}

const backupPathFor = (path: string, stamp: string): string => `${path}.memhtml-backup-${stamp}`

/** A filename-safe ISO instant: the colons a timestamp carries are not portable in a path. */
const stampNow = (): string => new Date().toISOString().replaceAll(":", "-")

/**
 * Wire one host at one scope.
 *
 * The order is the contract, and each step exists because skipping it produced a real failure mode:
 * validate the root, refuse a symlinked path, re-hash the receipt, refuse an artifact we do not own,
 * then — only then — snapshot, write, and record.
 */
export const install = async (options: InstallOptions): Promise<InstallReport> => {
  assertUsableRoot(options)
  const plan = await planInstall(options)
  const spec = hostSpec(options.host, options.scope, options.root)
  const paths = pathsOf(plan.writes)
  for (const path of [...paths, plan.receiptPath]) await assertNoSymlinkComponents(path)

  const before = new Map<string, string | null>()
  for (const path of paths) before.set(path, await currentText(path))

  const drifted = new Set<string>()
  if (plan.previous !== null) {
    const compared = await compareEntries(plan.previous.entries, receiptDriftReader(plan.previous))
    if (compared.state === "modified") {
      const first = compared.drift[0]
      if (first !== undefined && !options.force) {
        throw new IntegrationModified({
          host: options.host,
          path: first.entry.path,
          detail:
            first.actual === null
              ? `the ${first.entry.role} we recorded is gone from the file`
              : `the ${first.entry.role} we recorded now hashes to ${first.actual.slice(0, 12)}, not ${first.entry.sha256.slice(0, 12)}`
        })
      }
      for (const entry of compared.drift) drifted.add(entry.entry.path)
    }
  }

  /**
   * An artifact that is there and that no receipt claims.
   *
   * This is the fresh-machine case the drift check cannot see: a `mcpServers.memhtml` somebody added by
   * hand, a `SKILL.md` from another tool, a hooks entry left by an install whose receipt was deleted.
   * Overwriting it silently would be indistinguishable from adopting it, so it is refused and `--force`
   * is the way to say "mine now", with the prior bytes kept.
   */
  const unowned = new Set<string>()
  for (const write of plan.writes) {
    if (write.retire === true) continue
    if (claimOf(plan.previous, write.path, write.role) !== undefined) continue
    const text = before.get(write.path) ?? null
    const owned = write.ownedNow(text)
    if (owned === null) continue
    /**
     * A file whose bytes are ALREADY exactly what we would write is not a foreign file: it is the same
     * artifact a sibling host wrote. Codex, Cursor, and OpenCode share one `~/.agents/skills/memhtml/
     * SKILL.md` by design, so without this `integrations install` with no host argument would refuse on
     * the second host it wired.
     */
    if (owned === write.content) continue
    unowned.add(write.path)
    if (!options.force) {
      throw new IntegrationModified({
        host: options.host,
        path: write.path,
        detail: `a ${write.role} is already there and no memhtml receipt claims it`
      })
    }
  }

  /**
   * Codex's own `[mcp_servers.memhtml]`, written by hand outside our fence.
   *
   * Invisible to `ownedNow`, which reads only inside the fence, and appending a second table produces a
   * file Codex refuses to load — so this one is checked by name. With `--force` the fence is written
   * anyway and the prior bytes are kept beside the file, which is the only recoverable form of an
   * operator insisting.
   */
  if (spec.mcp.format === "toml-fence") {
    const text = before.get(spec.mcp.file) ?? null
    if (hasUnfencedTable(text, spec.mcp.table)) {
      unowned.add(spec.mcp.file)
      if (!options.force) {
        throw new IntegrationModified({
          host: options.host,
          path: spec.mcp.file,
          detail: `[${spec.mcp.table}] is written by hand outside the memhtml fence; a second table would make the file unloadable`
        })
      }
    }
  }

  // The new text of each file, folded so two artifacts in one file compose in plan order. `null` is a
  // file that goes: a retired plugin, or a hooks file that held nothing but ours.
  const next = new Map<string, string | null>()
  for (const path of paths) {
    let text = before.get(path) ?? null
    for (const write of plan.writes) {
      if (write.path === path) text = write.apply(text)
    }
    next.set(path, text)
  }

  const claimed = plan.writes.filter((write) => write.retire !== true)
  const entries: ReadonlyArray<ReceiptEntry> = claimed.map((write) => ({
    path: write.path,
    role: write.role,
    kind: write.kind,
    sha256: sha256(write.content)
  }))

  const sameEntries =
    plan.previous !== null &&
    plan.previous.entries.length === entries.length &&
    entries.every((entry, index) => {
      const prior = plan.previous?.entries[index]
      return (
        prior !== undefined &&
        prior.path === entry.path &&
        prior.role === entry.role &&
        prior.kind === entry.kind &&
        prior.sha256 === entry.sha256
      )
    })
  const sameOptions =
    plan.previous !== null &&
    plan.previous.memhtmlRoot === options.memhtmlRoot &&
    plan.previous.bareCommand === options.bareCommand &&
    plan.previous.hooks === options.hooks &&
    plan.previous.version === options.binary.version &&
    plan.previous.binary.node === options.binary.node &&
    plan.previous.binary.cli === options.binary.cli &&
    plan.previous.binary.mcp === options.binary.mcp &&
    plan.previous.binary.version === options.binary.version
  const filesUnchanged = paths.every((path) => next.get(path) === before.get(path))
  const changed = !(sameEntries && sameOptions && filesUnchanged)

  const actionOf = (write: PlannedWrite): EntryAction => {
    if (write.retire === true) return "removed"
    if (options.dryRun) return "planned"
    const text = before.get(write.path) ?? null
    if (write.ownedNow(text) === write.content && next.get(write.path) === text) return "unchanged"
    return text === null ? "created" : "updated"
  }

  const reported: ReadonlyArray<EntryReport> = plan.writes.map((write) => ({
    path: write.path,
    role: write.role,
    kind: write.kind,
    action: actionOf(write)
  }))

  const report = (backups: ReadonlyArray<string>): InstallReport => ({
    host: options.host,
    scope: options.scope,
    root: options.root,
    memhtmlRoot: options.memhtmlRoot,
    changed,
    dryRun: options.dryRun,
    entries: reported,
    backups,
    receiptPath: plan.receiptPath,
    nextSteps: plan.nextSteps
  })

  if (options.dryRun) {
    return {
      ...report([]),
      // A retired file has no content to show; its row above says `removed`.
      contents: Object.fromEntries(
        paths.flatMap((path) => {
          const text = next.get(path)
          return text === null || text === undefined ? [] : [[path, text] as const]
        })
      )
    }
  }

  // Nothing to do, and that includes the receipt: rewriting it would move `installedAt` and make an
  // idempotent re-run look like work in every diff of a dotfiles repository.
  if (!changed) return report([])

  const snapshots: Array<TextSnapshot> = []
  const backups: Array<string> = []
  try {
    for (const path of [...paths, plan.receiptPath]) snapshots.push(await snapshotOf(path))
    if (options.force) {
      const stamp = stampNow()
      if (plan.previousProblem !== undefined) {
        const text = await currentText(plan.receiptPath)
        if (text !== null) {
          const backup = backupPathFor(plan.receiptPath, stamp)
          await writeTextAtomic(backup, text)
          backups.push(backup)
        }
      }
      for (const path of paths) {
        if (!drifted.has(path) && !unowned.has(path)) continue
        const text = before.get(path)
        if (text === null || text === undefined) continue
        const backup = backupPathFor(path, stamp)
        await writeTextAtomic(backup, text)
        backups.push(backup)
      }
    }
    for (const path of paths) {
      const text = next.get(path) ?? null
      if (text === null) await rm(path, { force: true })
      else await writeTextAtomic(path, text)
    }
    const receipt: Receipt = {
      package: "memhtml",
      version: options.binary.version,
      host: options.host,
      scope: options.scope,
      root: options.root,
      memhtmlRoot: options.memhtmlRoot,
      binary: options.binary,
      bareCommand: options.bareCommand,
      hooks: options.hooks,
      installedAt: new Date().toISOString(),
      entries
    }
    await writeReceipt(plan.receiptPath, receipt)
  } catch (error) {
    // The rollback path, which runs while something is already wrong: every step is best-effort and
    // none of them may throw, or the original failure would be replaced by a failure to undo it.
    for (const snapshot of [...snapshots].reverse()) {
      try {
        await restoreText(snapshot)
      } catch {
        // Reported through the original error, which is the one the operator has to read.
      }
    }
    for (const backup of backups) {
      try {
        await restoreText({ path: backup, text: null, mode: null })
      } catch {
        // As above.
      }
    }
    throw error
  }

  return report(backups)
}
