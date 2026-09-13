/**
 * The receipt: what install wrote, where, and the SHA-256 of the bytes it claims.
 *
 * It is the whole ownership story. `list` reads it to say what is installed, `doctor` re-hashes what is on
 * disk against it to tell an upgrade from an operator's edit, and `uninstall` removes only the entries it
 * names — so a hook or MCP entry someone added by hand is never collateral. Nothing is inferred from the
 * config files themselves, because "an entry that looks like ours" and "an entry we wrote" are different
 * claims and only the second one licenses a delete.
 *
 * A malformed receipt is reported, never repaired and never guessed at. `readReceipt` answers `null` for
 * both absent and invalid and is for readers that only display; every writer (`install`, `uninstall`)
 * goes through `inspectReceiptFile`, which splits the two apart, so a present-but-unreadable receipt
 * refuses rather than reading as "not installed" and inviting an install that overwrites a real one.
 */

import { rm } from "node:fs/promises"
import { isAbsolute, join, normalize, resolve, sep } from "node:path"

import { readTextOrNull, writeTextAtomic } from "./fs.js"
import {
  HOOK_MODES,
  HOSTS,
  type HostId,
  type InstallState,
  MANAGED_ROLES,
  type Receipt,
  type ReceiptEntry,
  SCOPES,
  type Scope
} from "./types.js"

/** User scope hides the receipt under `.config`; project scope keeps it visible at the repo root. */
export const receiptPath = (scope: Scope, root: string, host: HostId): string =>
  scope === "user"
    ? join(root, ".config", "memhtml", "integrations", `${host}.json`)
    : join(root, ".memhtml-integrations", `${host}.json`)

/** What a receipt file turned out to be. `problem` is present exactly when `state` is `invalid`. */
export interface ReceiptFileInspection {
  readonly state: "absent" | "valid" | "invalid"
  readonly receipt: Receipt | null
  readonly problem?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === "string"

const oneOf = (value: unknown, allowed: ReadonlyArray<string>): boolean =>
  isString(value) && allowed.includes(value)

const KINDS = ["file", "fragment"] as const

/**
 * Every path a receipt may claim sits under its own `root`: `$HOME` at user scope, the repository at
 * project scope, by construction of `hostSpec`. A receipt naming anything else is not one install wrote,
 * and honouring it would let an edited receipt point `uninstall` at a file this integration never owned.
 * Normalized-and-absolute also rules out a `..` segment walking back out.
 */
const insideRoot = (path: string, root: string): boolean =>
  isAbsolute(path) &&
  normalize(path) === path &&
  (path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))

/**
 * The shape check, hand-rolled rather than an Effect `Schema`, for the same reason the rest of this layer
 * is plain async: the validator runs on the rollback and doctor paths, and it returns a sentence a human
 * reads. It names the first field that is wrong, and it is exhaustive over `Receipt` — a field added to
 * the interface without a line here would let an older receipt read as valid and then fail at use.
 */
const validate = (value: unknown): string | null => {
  if (!isRecord(value)) return "not a JSON object"
  if (value.package !== "memhtml") return '`package` is not "memhtml"'
  if (!isString(value.version)) return "`version` is not a string"
  if (!oneOf(value.host, HOSTS)) return `\`host\` is not one of ${HOSTS.join(", ")}`
  if (!oneOf(value.scope, SCOPES)) return `\`scope\` is not one of ${SCOPES.join(", ")}`
  if (!isString(value.root)) return "`root` is not a string"
  if (!isAbsolute(value.root) || normalize(value.root) !== value.root) {
    return "`root` is not an absolute, normalized path"
  }
  if (!isString(value.memhtmlRoot)) return "`memhtmlRoot` is not a string"
  const binary = value.binary
  if (!isRecord(binary)) return "`binary` is not an object"
  for (const field of ["node", "cli", "mcp", "version"]) {
    if (!isString(binary[field])) return `\`binary.${field}\` is not a string`
  }
  if (typeof value.bareCommand !== "boolean") return "`bareCommand` is not a boolean"
  if (!oneOf(value.hooks, HOOK_MODES)) return `\`hooks\` is not one of ${HOOK_MODES.join(", ")}`
  if (!isString(value.installedAt)) return "`installedAt` is not a string"
  if (!Array.isArray(value.entries)) return "`entries` is not an array"
  for (const [index, entry] of value.entries.entries()) {
    if (!isRecord(entry)) return `\`entries[${index}]\` is not an object`
    if (!isString(entry.path)) return `\`entries[${index}].path\` is not a string`
    if (!insideRoot(entry.path, value.root)) {
      return `\`entries[${index}].path\` is not an absolute, normalized path under \`root\``
    }
    if (!oneOf(entry.role, MANAGED_ROLES)) {
      return `\`entries[${index}].role\` is not one of ${MANAGED_ROLES.join(", ")}`
    }
    if (!oneOf(entry.kind, KINDS)) return `\`entries[${index}].kind\` is not "file" or "fragment"`
    if (!isString(entry.sha256)) return `\`entries[${index}].sha256\` is not a string`
  }
  return null
}

/** Absent, valid, or invalid-with-a-reason. The only reader that can tell those three apart. */
export const inspectReceiptFile = async (path: string): Promise<ReceiptFileInspection> => {
  const text = await readTextOrNull(path)
  if (text === null) return { state: "absent", receipt: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { state: "invalid", receipt: null, problem: `not valid JSON: ${detail}` }
  }
  const problem = validate(parsed)
  if (problem !== null) return { state: "invalid", receipt: null, problem }
  const receipt = parsed as Receipt
  // The receipt must be the one that belongs at this path: a Codex receipt copied over Cursor's, or one
  // from another root, would otherwise license edits to files its host and scope never wrote.
  const expected = receiptPath(receipt.scope, receipt.root, receipt.host)
  if (resolve(expected) !== resolve(path)) {
    return {
      state: "invalid",
      receipt: null,
      problem: `names ${receipt.host} at ${receipt.scope} scope under ${receipt.root}, which belongs at ${expected}`
    }
  }
  return { state: "valid", receipt }
}

/** The receipt, or `null` when there is none or it cannot be trusted. */
export const readReceipt = async (path: string): Promise<Receipt | null> =>
  (await inspectReceiptFile(path)).receipt

/** Write the receipt atomically, pretty-printed, so a diff of one reads as a diff of one thing. */
export const writeReceipt = async (path: string, receipt: Receipt): Promise<void> => {
  await writeTextAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`)
}

/** Delete the receipt. Absent is success: uninstall must be re-runnable. */
export const removeReceipt = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

/** One entry whose bytes on disk no longer hash to what the receipt claims. `null` means gone. */
export interface ReceiptDrift {
  readonly entry: ReceiptEntry
  readonly actual: string | null
}

/**
 * Hash every entry against disk and report `installed` or `modified`.
 *
 * `current` is supplied by the caller because only it knows how to extract a fragment — the SHA-256 of a
 * whole file for `kind: "file"`, of the rendered fence or JSON entry for `kind: "fragment"` — and it
 * answers `null` when the file or the fragment is gone. A missing fragment is drift rather than a separate
 * state: from the operator's side, "someone deleted our hook" and "someone edited our hook" both mean the
 * config no longer matches the receipt, and both must block an uninstall that would delete their work.
 *
 * `not-installed` is never returned here. That is the absence of a receipt, which is the caller's
 * question, not this function's.
 */
export const compareEntries = async (
  entries: ReadonlyArray<ReceiptEntry>,
  current: (entry: ReceiptEntry) => Promise<string | null>
): Promise<{ readonly state: InstallState; readonly drift: ReadonlyArray<ReceiptDrift> }> => {
  const drift: Array<ReceiptDrift> = []
  for (const entry of entries) {
    const actual = await current(entry)
    if (actual !== entry.sha256) drift.push({ entry, actual })
  }
  return { state: drift.length === 0 ? "installed" : "modified", drift }
}
