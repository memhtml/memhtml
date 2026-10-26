import { type HeadView, normalizePath, type OverlayOp, pathToHref } from "@memhtml/contracts"
import { addLink, readLinks, removeLink } from "@memhtml/html"

import { BATCH_CAP, type CommitScope, isReservedPath, type Violation } from "./validate.js"

/**
 * The edge repoints a batch of moves and archives needs, completed from the view.
 *
 * A `move` relocates one record and nothing else, and an `archive` moves one under its
 * `archive/<YYYY>/` slot, so every live edge that named the old path has to be moved by an `unlink`
 * of it and a `link` of the same rel to the destination (the slot, for an archive), in the same
 * batch; `validateOps` refuses a batch that leaves one behind. The pairs are mechanical (the view's
 * `inbound` index names every holder), so a writer should never have to compute them: `session
 * exec` completes its harvest with this, the curator's binder completes a proposal with it before
 * it judges it, `curate collapse` completes the archives its driver adds, and `curate merge`
 * completes a replay against the tip it lands on. A log already written is completed by
 * {@link missingRepoints} instead, which appends what it lacks.
 *
 * The repoints go in before the batch's first `move` or `archive`, so a holder the batch itself
 * moves is edited at its old path and the edit travels with it. A holder the batch archives is left
 * alone (its archived copy keeps the edge as history, which `validateOps` allows), an edge the batch
 * already unlinks (at the holder's path, or at the path the batch moved it to) is left to the batch,
 * and a move's source the batch puts a new record at needs nothing, nor does an archive's source
 * the batch puts at after the archive (a claim edit, refused whatever the edges). A holder `scope`
 * may not write ({@link isReservedPath}: an arc or a people record under `session`) is left alone
 * too, its edge the curator's to repoint; `validateOps` lets an archive leave it and names it on a
 * move. Edges a batch's own puts or `link`s aim at the old path are not the view's to know;
 * `validateOps` names them.
 */
export const withRepoints = (
  view: HeadView,
  ops: ReadonlyArray<OverlayOp>,
  scope: CommitScope = "session"
): ReadonlyArray<OverlayOp> => {
  const first = ops.findIndex((op) => op.kind === "move" || op.kind === "archive")
  if (first === -1) return ops
  const repoints = repointsByVacate(view, ops, scope).flatMap((group) => group.pairs)
  return [...ops.slice(0, first), ...repoints, ...ops.slice(first)]
}

/**
 * The repoints a log already written lacks against `view`, the version a commit lands it on, made
 * to go after the log rather than inside it, so the log is only ever appended to (§D2).
 *
 * They are {@link withRepoints}' pairs with each holder at the path the log moves it to, since an
 * edit after a move is made at the destination. Every pair is judged by `validateOps` as part of the
 * log, whose dangling-edge rule runs after the whole batch, so a pair after the archive it repoints
 * for passes like one before it. A log that is already complete gains nothing.
 *
 * `overflow` names, as a `format` violation on its source, each archive or move whose pairs would
 * take a log within `cap` over it, taking the pairs in log order while they fit; when it is not
 * empty the commit should write nothing and refuse with it, so `--drop-refused` can drop those ops,
 * with what {@link afterDroppedVacates} takes after them, and land the rest. A log already over
 * `cap` gains nothing and names nothing: its own `batch-cap` refusal stands.
 */
export const missingRepoints = (
  view: HeadView,
  ops: ReadonlyArray<OverlayOp>,
  scope: CommitScope = "session",
  cap: number = BATCH_CAP
): { readonly ops: ReadonlyArray<OverlayOp>; readonly overflow: ReadonlyArray<Violation> } => {
  if (ops.length > cap) return { ops: [], overflow: [] }
  // Where the log moves a holder. A batch moves a record once at most (a moved record's new path is
  // not a move source), so one step finds where it ends.
  const movedTo = new Map(
    ops.flatMap((op) => (op.kind === "move" ? [[normalizePath(op.path), op.to] as const] : []))
  )
  const added: Array<OverlayOp> = []
  const overflow: Array<Violation> = []
  for (const { index, pairs } of repointsByVacate(view, ops, scope)) {
    const vacate = ops[index]
    if (vacate === undefined || (vacate.kind !== "move" && vacate.kind !== "archive")) continue
    const settled = pairs.map((op) => ({
      ...op,
      path: movedTo.get(normalizePath(op.path)) ?? op.path
    }))
    if (ops.length + added.length + settled.length > cap) {
      const verb = vacate.kind === "archive" ? "archived" : "moved"
      const edges = settled.length === 2 ? "1 edge" : `${String(settled.length / 2)} edges`
      overflow.push({
        kind: "format",
        path: vacate.path,
        reasons: [
          `${verb} to ${vacate.to}, and repointing the ${edges} live records carry to ${pathToHref(vacate.path)} that the log does not repoint would take it to ${String(ops.length + added.length + settled.length)} ops, over the cap of ${String(cap)}: ${vacate.kind === "archive" ? "archive" : "move"} it in a session of its own`
        ]
      })
      continue
    }
    added.push(...settled)
  }
  return { ops: overflow.length > 0 ? [] : added, overflow }
}

/** Each `move` or `archive` in `ops`, by index, with the repoint pairs it needs from the view. */
const repointsByVacate = (
  view: HeadView,
  ops: ReadonlyArray<OverlayOp>,
  scope: CommitScope
): ReadonlyArray<{ readonly index: number; readonly pairs: ReadonlyArray<OverlayOp> }> => {
  const leaving = new Set(
    ops.flatMap((op) => (op.kind === "archive" ? [normalizePath(op.path)] : []))
  )
  // The op indices at which the batch puts each path.
  const putsAt = new Map<string, Array<number>>()
  ops.forEach((op, index) => {
    if (op.kind !== "put") return
    const path = normalizePath(op.path)
    putsAt.set(path, [...(putsAt.get(path) ?? []), index])
  })
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
  const groups: Array<{ readonly index: number; readonly pairs: ReadonlyArray<OverlayOp> }> = []
  ops.forEach((op, index) => {
    if (op.kind !== "move" && op.kind !== "archive") return
    const from = normalizePath(op.path)
    // A put at a move's source is a new record there, which the edges may name. A put at an
    // archive's source after the archive is a claim edit, refused whatever the edges; one before it
    // is the record the archive takes, so its edges follow it to the slot.
    const puts = putsAt.get(from) ?? []
    if (op.kind === "move" ? puts.length > 0 : puts.some((at) => at > index)) return
    const href = pathToHref(from)
    const pairs: Array<OverlayOp> = []
    for (const holder of [...view.inbound(href)].sort()) {
      const record = view.get(holder)
      if (record === undefined || record.archived || leaving.has(normalizePath(holder))) continue
      if (isReservedPath(holder, scope)) continue
      for (const link of record.links) {
        if (link.href !== href) continue
        const key = `${normalizePath(holder)}\n${link.rel}\n${href}`
        if (unlinked.has(key)) continue
        unlinked.add(key)
        pairs.push(
          { kind: "unlink", path: record.path, rel: link.rel, href },
          { kind: "link", path: record.path, rel: link.rel, href: pathToHref(op.to) }
        )
      }
    }
    if (pairs.length > 0) groups.push({ index, pairs })
  })
  return groups
}

/** One op {@link afterDroppedVacates} took or rewrote, with the archive or move it followed. */
export interface VacateFollower {
  readonly kind: OverlayOp["kind"]
  /** The op's path as the log held it. */
  readonly path: string
  /** The edge's rel, or the entity a `label` or `unlabel` names. */
  readonly detail: string
  readonly vacate: OverlayOp
  /** The path the record still has, for an op made there or an edge aimed back at it. */
  readonly home?: string
}

/**
 * What a log keeps once `session commit --drop-refused` has taken `dropped` out of it, for each
 * `archive` or `move` among them.
 *
 * Its own repoint pairs always go with it: each `link` to its destination and the `unlink` of the
 * same holder and rel from its source, so the holder keeps its edge to the record where it is,
 * whatever holds the destination, and no other op on the holder is refused for it.
 *
 * Two rewrites follow only when neither `view` nor a kept op holds the destination and the record
 * is still live in `view`, at the vacate's source or, for a chain the round dropped whole (a move
 * and a second move or an archive of the same record), at the source the chain began from. Each
 * kept head op at a dropped move's destination is made there instead: a repoint the commit
 * appended after the move, for a holder the move took, then repoints the holder where it stays.
 * Every other edge a kept `put` or `link` aims at the destination is aimed back there too: a
 * successor's `supersedes` edge to the slot of a record whose archive was dropped then names the
 * live record, which the curator archives later as it does any superseded record, rather than a
 * file that was never written. A held destination keeps the edges aimed at it, which name the
 * record that holds it; a record that is not live (an archive of a record the batch put, dropped
 * with the put) leaves them as they are.
 *
 * `removed` lists the ops taken, `retargeted` each edge aimed back, and `returned` each op made at
 * the record's path, all with the vacate they followed; `homes` maps each dropped move's
 * destination that got the rewrites to that path.
 */
export const afterDroppedVacates = (
  view: HeadView,
  keep: ReadonlyArray<OverlayOp>,
  dropped: ReadonlyArray<OverlayOp>
): {
  readonly keep: ReadonlyArray<OverlayOp>
  readonly removed: ReadonlyArray<VacateFollower>
  readonly retargeted: ReadonlyArray<VacateFollower>
  readonly returned: ReadonlyArray<VacateFollower>
  readonly homes: ReadonlyMap<string, string>
} => {
  const held = new Set(
    keep.flatMap((op) =>
      op.kind === "put"
        ? [normalizePath(op.path)]
        : op.kind === "archive" || op.kind === "move"
          ? [normalizePath(op.to)]
          : []
    )
  )
  // Where each dropped vacate's destination came from, so a chain of them is followed back to the
  // path the record still has.
  const cameFrom = new Map<string, string>()
  for (const op of dropped) {
    if (op.kind === "archive" || op.kind === "move") {
      cameFrom.set(normalizePath(op.to), normalizePath(op.path))
    }
  }
  const liveAt = (path: string): string | undefined => {
    const seen = new Set<string>()
    for (let at: string | undefined = path; at !== undefined; at = cameFrom.get(at)) {
      const record = view.get(at)
      if (record !== undefined) return record.archived ? undefined : record.path
      if (seen.has(at)) return undefined
      seen.add(at)
    }
    return undefined
  }
  let ops: Array<OverlayOp> = [...keep]
  // The op each rewritten op was in the log, and the ops made at the record's path, by the op made.
  const original = new Map<OverlayOp, OverlayOp>()
  const returnedBy = new Map<OverlayOp, VacateFollower>()
  const removed: Array<VacateFollower> = []
  const retargeted: Array<VacateFollower> = []
  const homes = new Map<string, string>()
  for (const vacate of dropped) {
    if (vacate.kind !== "archive" && vacate.kind !== "move") continue
    const from = normalizePath(vacate.path)
    const to = normalizePath(vacate.to)
    const fromHref = pathToHref(from)
    const toHref = pathToHref(to)
    const taken = new Set<OverlayOp>()
    for (const op of ops) {
      if (op.kind !== "link" || op.href !== toHref) continue
      const unlink = ops.find(
        (other) =>
          other.kind === "unlink" &&
          !taken.has(other) &&
          normalizePath(other.path) === normalizePath(op.path) &&
          other.rel === op.rel &&
          other.href === fromHref
      )
      if (unlink === undefined) continue
      taken.add(unlink)
      taken.add(op)
    }
    const home = view.get(to) !== undefined || held.has(to) ? undefined : liveAt(from)
    const rewrite = home === undefined ? undefined : { path: home, href: pathToHref(home) }
    if (rewrite !== undefined && vacate.kind === "move") homes.set(to, rewrite.path)
    const next: Array<OverlayOp> = []
    for (const op of ops) {
      if (taken.has(op) && (op.kind === "link" || op.kind === "unlink")) {
        returnedBy.delete(op)
        removed.push({
          kind: op.kind,
          path: (original.get(op) ?? op).path,
          detail: op.rel,
          vacate
        })
        continue
      }
      if (rewrite === undefined) {
        next.push(op)
        continue
      }
      if (
        vacate.kind === "move" &&
        op.kind !== "put" &&
        op.kind !== "archive" &&
        op.kind !== "move" &&
        normalizePath(op.path) === to
      ) {
        const made = { ...op, path: rewrite.path }
        original.set(made, original.get(op) ?? op)
        returnedBy.delete(op)
        returnedBy.set(made, {
          kind: op.kind,
          path: (original.get(op) ?? op).path,
          detail: op.kind === "link" || op.kind === "unlink" ? op.rel : op.entity,
          vacate,
          home: rewrite.path
        })
        next.push(made)
        continue
      }
      if (op.kind === "link" && op.href === toHref) {
        next.push({ ...op, href: rewrite.href })
        retargeted.push({
          kind: op.kind,
          path: op.path,
          detail: op.rel,
          vacate,
          home: rewrite.path
        })
        continue
      }
      if (op.kind === "put") {
        const aimed = readLinks(op.html).filter((link) => link.href === toHref)
        if (aimed.length > 0) {
          let html = op.html
          for (const link of aimed) {
            html = addLink(removeLink(html, link.rel, toHref), link.rel, rewrite.href)
            retargeted.push({
              kind: op.kind,
              path: op.path,
              detail: link.rel,
              vacate,
              home: rewrite.path
            })
          }
          next.push({ ...op, html })
          continue
        }
      }
      next.push(op)
    }
    ops = next
  }
  return { keep: ops, removed, retargeted, returned: [...returnedBy.values()], homes }
}
