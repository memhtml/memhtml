/**
 * `list`: one row per host per available scope, each `not-installed`, `installed`, or `modified`.
 *
 * The row is read from the receipt and from re-hashing what it claims — never from looking for something
 * that resembles our entry in a host's config. A hand-written `mcpServers.memhtml` is therefore
 * `not-installed` here, which is the honest answer: nothing recorded it, so nothing can uninstall it.
 *
 * A receipt that does not parse reads as `modified` with the parser's own sentence in `detail`, rather
 * than as `not-installed` — an operator who saw "not installed" would run install, which would write over
 * the only record of what an earlier one wrote.
 */

import { receiptDriftReader } from "./install.js"
import { compareEntries, inspectReceiptFile, receiptPath } from "./receipt.js"
import { HOSTS, type HostId, type InstallState, type Scope } from "./types.js"

export interface IntegrationRow {
  readonly host: HostId
  readonly scope: Scope
  /** `$HOME` at user scope, the git top level at project scope. */
  readonly root: string
  readonly state: InstallState
  readonly receiptPath: string
  /** The memhtml version that installed it, when a receipt says. */
  readonly version?: string
  /** The store it points at, when a receipt says. */
  readonly memhtmlRoot?: string
  /** What is wrong, on a `modified` row: the drifted path, or why the receipt cannot be read. */
  readonly detail?: string
}

const rowFor = async (host: HostId, scope: Scope, root: string): Promise<IntegrationRow> => {
  const path = receiptPath(scope, root, host)
  const inspected = await inspectReceiptFile(path)
  if (inspected.state === "absent") {
    return { host, scope, root, state: "not-installed", receiptPath: path }
  }
  const receipt = inspected.receipt
  if (receipt === null) {
    return {
      host,
      scope,
      root,
      state: "modified",
      receiptPath: path,
      detail: `the receipt cannot be read: ${inspected.problem ?? "unknown problem"}`
    }
  }
  const compared = await compareEntries(receipt.entries, receiptDriftReader(receipt))
  const first = compared.drift[0]
  return {
    host,
    scope,
    root,
    state: compared.state,
    receiptPath: path,
    version: receipt.version,
    memhtmlRoot: receipt.memhtmlRoot,
    ...(first === undefined
      ? {}
      : { detail: `${first.entry.role} at ${first.entry.path} no longer matches the receipt` })
  }
}

/**
 * Every host at user scope, and every host at project scope when a repository root is given.
 *
 * `HOSTS` order throughout, so two runs on one machine read the same way and a diff of the output is a
 * diff of the states.
 */
export const listIntegrations = async (
  home: string,
  projectRoot?: string
): Promise<ReadonlyArray<IntegrationRow>> => {
  const rows: Array<IntegrationRow> = []
  for (const host of HOSTS) rows.push(await rowFor(host, "user", home))
  if (projectRoot !== undefined) {
    for (const host of HOSTS) rows.push(await rowFor(host, "project", projectRoot))
  }
  return rows
}
