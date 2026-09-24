import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { isEdgeRel } from "@memhtml/contracts/edges"
import { InvalidMemory } from "@memhtml/contracts/errors"
import { addLink, removeLink } from "@memhtml/html"
import { Effect } from "effect"

import { type Indexes, indexesOf, insertRecord, removeRecord, viewOf } from "./indexes.js"
import { recordFrom } from "./record.js"

/**
 * A session's view: the base version plus its own overlay log, applied in order.
 *
 * The result shares every untouched node with the base, exactly as an advanced version does,
 * because it is built by the same two writers. Its `sha` is the base's: an overlay has no commit of
 * its own until a session commits it, and a caller that reads `sha` is asking which version the
 * ops were written against.
 *
 * `link` and `unlink` are mirror images: both re-parse the file with one head line spliced in or
 * cut out, both leave the article and its content hash alone, and both fail on a path the view
 * lacks or a rel outside the vocabulary. `unlink` also fails on an edge the file does not carry.
 */

const applyOp = (indexes: Indexes, op: OverlayOp): Effect.Effect<Indexes, InvalidMemory> => {
  switch (op.kind) {
    case "put":
      return recordFrom({ path: op.path, html: op.html }).pipe(
        Effect.map((record) => insertRecord(indexes, record))
      )
    case "archive":
      return recordFrom({ path: op.to, html: op.html }).pipe(
        Effect.map((record) =>
          insertRecord(removeRecord(indexes, op.path), { ...record, archived: true })
        )
      )
    case "link": {
      const existing = viewOf(indexes, null).get(op.path)
      if (existing === undefined) {
        return Effect.fail(
          InvalidMemory.make({ reason: `link op names a path the view does not hold: ${op.path}` })
        )
      }
      if (!isEdgeRel(op.rel)) {
        return Effect.fail(InvalidMemory.make({ reason: `unknown link rel: ${op.rel}` }))
      }
      // `addLink` splices into the head only, so the record's content hash is unchanged and its
      // dedupe identity survives the edge.
      return recordFrom({ path: op.path, html: addLink(existing.html, op.rel, op.href) }).pipe(
        Effect.map((record) => insertRecord(indexes, record))
      )
    }
    case "unlink": {
      const existing = viewOf(indexes, null).get(op.path)
      if (existing === undefined) {
        return Effect.fail(
          InvalidMemory.make({
            reason: `unlink op names a path the view does not hold: ${op.path}`
          })
        )
      }
      if (!isEdgeRel(op.rel)) {
        return Effect.fail(InvalidMemory.make({ reason: `unknown link rel: ${op.rel}` }))
      }
      // The edge must be there to drop: an unlink of an edge the file does not carry is a stale
      // op (the target was already unlinked, or the op names the wrong file), and a silent no-op
      // would let it land in a commit that changes nothing while the log says it did.
      if (!existing.links.some((link) => link.rel === op.rel && link.href === op.href)) {
        return Effect.fail(
          InvalidMemory.make({
            reason: `unlink op names an edge ${op.path} does not carry: ${op.rel} -> ${op.href}`
          })
        )
      }
      // `removeLink` cuts the one head line, so the content hash is unchanged like `addLink`.
      return recordFrom({
        path: op.path,
        html: removeLink(existing.html, op.rel, op.href)
      }).pipe(Effect.map((record) => insertRecord(indexes, record)))
    }
  }
}

/** The base with `ops` applied in order. Fails on the first op that does not parse or resolve. */
export const withOverlay = (
  base: HeadView,
  ops: ReadonlyArray<OverlayOp>
): Effect.Effect<HeadView, InvalidMemory> =>
  Effect.reduce(ops, () => indexesOf(base), applyOp).pipe(
    Effect.map((indexes) => viewOf(indexes, base.sha))
  )
