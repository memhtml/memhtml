import { type HeadView, normalizePath, type OverlayOp, pathToHref } from "@memhtml/contracts"

/**
 * The edge repoints a batch of moves needs, completed from the view.
 *
 * A `move` relocates one record and nothing else, so every live edge that named the old path has to
 * be moved by an `unlink` of it and a `link` of the same rel to the destination, in the same batch;
 * `validateOps` refuses a batch that leaves one behind. The pairs are mechanical (the view's
 * `inbound` index names every holder), so a writer should never have to compute them: the curator's
 * binder completes a proposal with this before it judges it, and `curate merge` completes a replay
 * with it against the tip it lands on, where `main` may have gained an edge to the old path after
 * the curator ran.
 *
 * The repoints go in before the batch's first `move`, so a holder the batch itself moves is edited
 * at its old path and the edit travels with it. A holder the batch archives is left alone (its
 * archived copy keeps the edge as history, which `validateOps` allows), an edge the batch already
 * unlinks is left to the batch, and a source the batch puts a new record at again needs nothing.
 * Edges a batch's own puts or `link`s aim at the old path are not the view's to know; `validateOps`
 * names them.
 */
export const withRepoints = (
  view: HeadView,
  ops: ReadonlyArray<OverlayOp>
): ReadonlyArray<OverlayOp> => {
  const first = ops.findIndex((op) => op.kind === "move")
  if (first === -1) return ops
  const leaving = new Set(
    ops.flatMap((op) => (op.kind === "archive" ? [normalizePath(op.path)] : []))
  )
  const reoccupied = new Set(
    ops.flatMap((op) => (op.kind === "put" ? [normalizePath(op.path)] : []))
  )
  const unlinked = new Set(
    ops.flatMap((op) =>
      op.kind === "unlink" ? [`${normalizePath(op.path)}\n${op.rel}\n${op.href}`] : []
    )
  )
  const repoints: Array<OverlayOp> = []
  for (const op of ops) {
    if (op.kind !== "move") continue
    const from = normalizePath(op.path)
    if (reoccupied.has(from)) continue
    const href = pathToHref(from)
    for (const holder of [...view.inbound(href)].sort()) {
      const record = view.get(holder)
      if (record === undefined || record.archived || leaving.has(normalizePath(holder))) continue
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
