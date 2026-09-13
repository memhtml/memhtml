/**
 * `uninstall`: remove exactly what the receipt claims, and nothing else.
 *
 * The receipt is the only license to delete. Every entry is re-hashed against disk first, and one that
 * no longer matches refuses the WHOLE uninstall with `IntegrationModified` — there is no `--force`,
 * because overwriting an edit is recoverable from a backup and deleting a file somebody has made their
 * own is not.
 *
 * Nothing is inferred from the config files themselves. An MCP entry or a hook that looks like ours but
 * that no receipt names is left alone, which is the difference between "an entry we wrote" and "an entry
 * that resembles ours" — only the first licenses a delete.
 */

import { readdir, rm, rmdir } from "node:fs/promises"
import { basename, dirname } from "node:path"

import { IntegrationModified } from "./errors.js"
import {
  readTextOrNull,
  restoreText,
  snapshotText,
  type TextSnapshot,
  writeTextAtomic
} from "./fs.js"
import { hostSpec } from "./hosts.js"
import { type EntryReport, editorFor, receiptDriftReader } from "./install.js"
import {
  compareEntries,
  inspectReceiptFile,
  readReceipt,
  receiptPath,
  removeReceipt
} from "./receipt.js"
import { SKILL_DIR_NAME } from "./render/skill.js"
import { HOSTS, type HostId, type InstallState, type Receipt, type Scope } from "./types.js"

export interface UninstallReport {
  readonly host: HostId
  readonly scope: Scope
  readonly root: string
  /** `not-installed` when there was no receipt, `installed` when the removal ran. */
  readonly state: InstallState
  readonly removed: ReadonlyArray<EntryReport>
  readonly receiptPath: string
  /** False when there was nothing to remove, so an uninstall is re-runnable and says so. */
  readonly changed: boolean
}

/** The directory names uninstall may remove once empty: ours entirely, never a host's own root. */
const REMOVABLE_DIRS: ReadonlySet<string> = new Set([SKILL_DIR_NAME, ".memhtml-integrations"])

/**
 * Remove `dir` when it is one of ours and nothing is left in it.
 *
 * `~/.claude` and `~/.cursor` are the host's, so an empty one stays: the host created it and may be
 * about to write to it. `skills/memhtml/` and `.memhtml-integrations/` are directories install created
 * and nothing else writes to, so leaving an empty one behind is litter an operator would have to explain.
 */
const removeIfOursAndEmpty = async (dir: string): Promise<void> => {
  if (!REMOVABLE_DIRS.has(basename(dir))) return
  try {
    const remaining = await readdir(dir)
    if (remaining.length > 0) return
    await rmdir(dir)
  } catch {
    // A directory that is gone, or one the operator has locked, is not this command's business.
  }
}

/**
 * Every path ANOTHER host's receipt claims at this scope.
 *
 * Codex, Cursor, and OpenCode share one `~/.agents/skills/memhtml/SKILL.md`, so removing Codex must not
 * delete the skill Cursor is still wired to. The shared file stays and this host's receipt goes, which
 * leaves both hosts' claims true.
 */
const claimedElsewhere = async (receipt: Receipt): Promise<ReadonlySet<string>> => {
  const claimed = new Set<string>()
  for (const other of HOSTS) {
    if (other === receipt.host) continue
    const sibling = await readReceipt(receiptPath(receipt.scope, receipt.root, other))
    if (sibling === null) continue
    for (const entry of sibling.entries) claimed.add(entry.path)
  }
  return claimed
}

/**
 * Unwire one host at one scope.
 *
 * Absent receipt is SUCCESS with `state: "not-installed"`, so the call is re-runnable and a
 * machine-teardown script does not have to ask first.
 */
export const uninstall = async (
  host: HostId,
  scope: Scope,
  root: string
): Promise<UninstallReport> => {
  const path = receiptPath(scope, root, host)
  const inspected = await inspectReceiptFile(path)
  if (inspected.state === "absent") {
    return {
      host,
      scope,
      root,
      state: "not-installed",
      removed: [],
      receiptPath: path,
      changed: false
    }
  }
  const receipt = inspected.receipt
  if (receipt === null) {
    /**
     * A receipt that does not parse is not a license to delete anything. Reported rather than repaired:
     * the entry list is the only record of what to remove, and guessing it from the config files is the
     * inference this whole module exists to avoid.
     */
    throw new Error(
      `the receipt at ${path} cannot be read (${inspected.problem ?? "unknown problem"}), so nothing was removed: read it, then delete it by hand if you mean to`
    )
  }

  const compared = await compareEntries(receipt.entries, receiptDriftReader(receipt))
  if (compared.state === "modified") {
    const first = compared.drift[0]
    throw new IntegrationModified({
      host,
      path: first?.entry.path ?? path,
      detail:
        first === undefined
          ? "the receipt no longer matches what is on disk"
          : first.actual === null
            ? `the ${first.entry.role} we recorded is gone from the file, so uninstall cannot tell what to remove`
            : `the ${first.entry.role} we recorded was edited since install, and uninstall never overwrites an edit`
    })
  }

  const spec = hostSpec(receipt.host, receipt.scope, receipt.root)
  const shared = await claimedElsewhere(receipt)
  const paths = [...new Set(receipt.entries.map((entry) => entry.path))]
  const snapshots: Array<TextSnapshot> = []
  try {
    for (const target of [...paths, path]) snapshots.push(await snapshotText(target))
    for (const target of paths) {
      if (shared.has(target)) continue
      let text: string | null = await readTextOrNull(target)
      for (const entry of receipt.entries) {
        if (entry.path !== target) continue
        text = editorFor(spec, entry, receipt.binary, receipt.bareCommand).strip(text)
      }
      if (text === null) {
        await rm(target, { force: true })
        await removeIfOursAndEmpty(dirname(target))
      } else {
        await writeTextAtomic(target, text)
      }
    }
    await removeReceipt(path)
    await removeIfOursAndEmpty(dirname(path))
  } catch (error) {
    for (const snapshot of [...snapshots].reverse()) {
      try {
        await restoreText(snapshot)
      } catch {
        // Best effort: the original failure is the one worth reporting.
      }
    }
    throw error
  }

  return {
    host,
    scope,
    root,
    state: "installed",
    removed: receipt.entries.map((entry) => ({
      path: entry.path,
      role: entry.role,
      kind: entry.kind,
      // `unchanged` for a file a sibling host still claims: the receipt's claim is gone, the file is not.
      action: shared.has(entry.path) ? ("unchanged" as const) : ("removed" as const)
    })),
    receiptPath: path,
    changed: receipt.entries.length > 0
  }
}
