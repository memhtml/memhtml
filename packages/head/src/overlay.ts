import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { isEdgeRel } from "@memhtml/contracts/edges"
import { InvalidMemory } from "@memhtml/contracts/errors"
import { isWellFormedEntity } from "@memhtml/contracts/types"
import { addLink, addMeta, removeLink, removeMeta } from "@memhtml/html"
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
 *
 * `label` and `unlabel` are the same pair for one `memhtml-entity` meta: the file is re-parsed, so
 * `byEntity` gains or loses the path through the same `insertRecord` every other index follows.
 * `label` fails on a path the view lacks or a value that is not a well-formed entity; `unlabel` on
 * a path the view lacks or an entity the file does not carry.
 *
 * `move` takes the record at its path as the view holds it and inserts it at `to` with the same
 * bytes, so `inbound` still names the holders of edges to the old path until the batch repoints
 * them. It fails on a path the view does not hold live.
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
    case "label": {
      const existing = viewOf(indexes, null).get(op.path)
      if (existing === undefined) {
        return Effect.fail(
          InvalidMemory.make({ reason: `label op names a path the view does not hold: ${op.path}` })
        )
      }
      if (!isWellFormedEntity(op.entity)) {
        return Effect.fail(InvalidMemory.make({ reason: `malformed entity: ${op.entity}` }))
      }
      // `addMeta` splices one head line in after the last entity, so the content hash is unchanged.
      return recordFrom({
        path: op.path,
        html: addMeta(existing.html, "memhtml-entity", op.entity)
      }).pipe(Effect.map((record) => insertRecord(indexes, record)))
    }
    case "unlabel": {
      const existing = viewOf(indexes, null).get(op.path)
      if (existing === undefined) {
        return Effect.fail(
          InvalidMemory.make({
            reason: `unlabel op names a path the view does not hold: ${op.path}`
          })
        )
      }
      // The same rule as `unlink`: dropping a label the file does not carry is a stale op, and a
      // silent no-op would let the log describe a change the commit never makes.
      if (!existing.entities.includes(op.entity)) {
        return Effect.fail(
          InvalidMemory.make({
            reason: `unlabel op names an entity ${op.path} does not carry: ${op.entity}`
          })
        )
      }
      return recordFrom({
        path: op.path,
        html: removeMeta(existing.html, "memhtml-entity", op.entity)
      }).pipe(Effect.map((record) => insertRecord(indexes, record)))
    }
    case "move": {
      const existing = viewOf(indexes, null).get(op.path)
      if (existing === undefined || existing.archived) {
        return Effect.fail(
          InvalidMemory.make({
            reason: `move op names a path the view does not hold live: ${op.path}`
          })
        )
      }
      // The record as the view holds it (head edits an earlier op made included), re-parsed at its
      // destination, so every index follows the path and the content hash stays the record's.
      return recordFrom({ path: op.to, html: existing.html }).pipe(
        Effect.map((record) => insertRecord(removeRecord(indexes, op.path), record))
      )
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
