import { type HeadView, normalizePath, type OverlayOp, pathToHref } from "@memhtml/contracts"

import { type CommitScope, isReservedPath } from "./validate.js"

/**
 * The edge repoints a batch of moves and archives needs, completed from the view.
 *
 * A `move` relocates one record and nothing else, and an `archive` moves one under its
 * `archive/<YYYY>/` slot, so every live edge that named the old path has to be moved by an `unlink`
 * of it and a `link` of the same rel to the destination (the slot, for an archive), in the same
 * batch; `validateOps` refuses a batch that leaves one behind. The pairs are mechanical (the view's
 * `inbound` index names every holder), so a writer should never have to compute them: `session
 * exec` completes its harvest with this, the curator's binder completes a proposal with it before
 * it judges it, and `curate collapse` completes the archives its driver adds. `session commit` and
 * the curator's own landing complete the whole log again against the version they commit over, and
 * `curate merge` completes a replay against the tip it lands on, because the ref may have gained an
 * edge to the old path after the log was written. A log already complete gains nothing.
 *
 * The repoints go in before the batch's first `move` or `archive`, so a holder the batch itself
 * moves is edited at its old path and the edit travels with it. A holder the batch archives is left
 * alone (its archived copy keeps the edge as history, which `validateOps` allows), an edge the batch
 * already unlinks (at the holder's path, or at the path the batch moved it to) is left to the batch,
 * and a source the batch puts a new record at again needs nothing. So is a holder `scope` may not
 * write ({@link isReservedPath}: an arc or a people record under `session`), whose edge is the
 * curator's to repoint; `validateOps` lets an archive leave it and names it on a move. Edges a
 * batch's own puts or `link`s aim at the old path are not the view's to know; `validateOps` names
 * them.
 */
export const withRepoints = (
  view: HeadView,
  ops: ReadonlyArray<OverlayOp>,
  scope: CommitScope = "session"
): ReadonlyArray<OverlayOp> => {
  const first = ops.findIndex((op) => op.kind === "move" || op.kind === "archive")
  if (first === -1) return ops
  const leaving = new Set(
    ops.flatMap((op) => (op.kind === "archive" ? [normalizePath(op.path)] : []))
  )
  const reoccupied = new Set(
    ops.flatMap((op) => (op.kind === "put" ? [normalizePath(op.path)] : []))
  )
  // An edge the batch unlinks, keyed by the path its holder had when the batch began: an unlink at
  // the destination of a holder the batch moved is that holder's edge, so a repoint written there
  // (by an earlier exec of the log, over the overlaid view) is not made again at the old path.
  const origin = new Map<string, string>()
  const unlinked = new Set<string>()
  for (const op of ops) {
    if (op.kind === "move") {
      const from = normalizePath(op.path)
      origin.set(normalizePath(op.to), origin.get(from) ?? from)
    } else if (op.kind === "unlink") {
      const path = normalizePath(op.path)
      unlinked.add(`${origin.get(path) ?? path}\n${op.rel}\n${op.href}`)
    }
  }
  const repoints: Array<OverlayOp> = []
  for (const op of ops) {
    if (op.kind !== "move" && op.kind !== "archive") continue
    const from = normalizePath(op.path)
    if (reoccupied.has(from)) continue
    const href = pathToHref(from)
    for (const holder of [...view.inbound(href)].sort()) {
      const record = view.get(holder)
      if (record === undefined || record.archived || leaving.has(normalizePath(holder))) continue
      if (isReservedPath(holder, scope)) continue
      for (const link of record.links) {
        if (link.href !== href) continue
        const key = `${normalizePath(holder)}\n${link.rel}\n${href}`
        if (unlinked.has(key)) continue
        unlinked.add(key)
        repoints.push(
          { kind: "unlink", path: record.path, rel: link.rel, href },
          { kind: "link", path: record.path, rel: link.rel, href: pathToHref(op.to) }
        )
      }
    }
  }
  return [...ops.slice(0, first), ...repoints, ...ops.slice(first)]
}
