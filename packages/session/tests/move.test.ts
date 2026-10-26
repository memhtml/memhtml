import { archivePathFor, type OverlayOp } from "@memhtml/contracts"
import { addLink, contentHash } from "@memhtml/html"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { commitSession } from "../src/commit.js"
import { afterDroppedVacates, missingRepoints, withRepoints } from "../src/moves.js"
import { appendOps, startSession } from "../src/session.js"
import { UNANCHORED_REASON, validateOps } from "../src/validate.js"
import {
  blobShaOf,
  commitFiles,
  fileAt,
  git,
  loadHead,
  makeRepo,
  mapHead,
  memory,
  type Repo,
  recordFrom,
  STRICT_BAR,
  treePaths
} from "./helpers.js"

/**
 * The `move` op (`docs/design.md` §17, "Move"): the one way a record changes path while
 * staying the same record.
 *
 * Before it, placement had no correct shape. A `put` of an inbox record's bytes at its new home is a
 * `duplicate` of the inbox copy, because the head's content-hash index still names the inbox path
 * while the same batch archives it (the first case below pins that, measured on a clone of the live
 * store on 2026-09-30 with the exact violation this test asserts), and a rename in a sandbox is a
 * file "vanished with no archive twin".
 *
 * Mutation notes, each run once with the change applied and the named case red (2026-09-30):
 * - validate, inbound: `for (const link of stale)` -> `stale.slice(0, 0)` -> "a
 *   move that leaves an edge to the old path behind is refused, and one that repoints it passes".
 * - validate, destination: the `view.get(to) !== undefined` reason dropped -> "refuses a move onto
 *   a path that holds a record, under archive/, or written twice" (the occupied slot passes).
 * - validate, departed: `isLiveSource` without the `movedAway` clause -> "a record that moved is
 *   edited at its destination and never at the path it left" (the link on the old path passes).
 * - withRepoints: the `leaving.has(...)` skip dropped -> "withRepoints repoints every live holder
 *   before the first move and leaves archived holders and settled edges alone" (an unlink lands on
 *   a holder the batch archives); the `unlinked.has(key)` skip dropped -> the same case (a second
 *   pair lands beside the batch's own unlink). Both calls run under `curate` (2026-10-26): under
 *   `session` the holder, an arc, is skipped as reserved whichever skip is dropped.
 * - validate, destination anchor (2026-10-18): `bar.requireAnchor &&` dropped from the move loop ->
 *   "a moved record keeps to the write bar's anchor rule at its destination" (the library default
 *   bar refuses the bare move).
 * - stage: the `move` case left out of `stage` -> "commits a move as the same blob at the new path,
 *   with the holder's edge repointed" (the old path is still in the tree).
 * - withRepoints, archives (2026-10-26): the `archive` kind left out of the first-op search and the
 *   loop -> "repoints every live edge to the archived path at its archive slot, before the archive"
 *   (the archive comes back alone) and "commits the archive with the successor's supersedes edge at
 *   the archive slot" (the landed edge names the vacated path).
 * - withRepoints, scope (2026-10-26): the `isReservedPath(holder, scope)` skip dropped -> "leaves a
 *   holder the scope may not write to the curator, and repoints it under curate" (the arc is
 *   repointed under `session`).
 * - commit, step 3 (2026-10-26): `markContradictions` made to link a rival the batch archives like
 *   any other -> "marks no contradiction against a rival the same batch archives" (the successor is
 *   marked against the path the archive empties).
 * - withRepoints, moved holders (2026-10-26): batch unlinks keyed by the path they name, not the
 *   path the holder had when the batch began -> "takes an unlink at the path the batch moved a
 *   holder to as that holder's repoint" (a second pair is added at the old path).
 * - withRepoints, puts at a source (2026-10-26): every source the batch puts at skipped, whatever
 *   the kind and order -> "repoints a live holder's edge to a path the batch puts and then
 *   archives, and not one it puts at after the archive" (the archive comes back alone); only a
 *   move's source skipped -> the same case (the archive before the claim edit gains a pair).
 * - afterDroppedVacates (2026-10-26): the `held.has(to)` check dropped, or the check that the record
 *   is live -> "takes the pairs and leaves the other kept ops alone when the destination is held or
 *   the record is not live" (the edges are aimed at the slot); the pairs taken only when those
 *   checks pass -> the same case (the pairs stay); the ops at a dropped move's destination left
 *   there -> "makes the ops kept at a dropped move's destination at its source"; `liveAt` stopped at
 *   the vacate's own source -> "follows a chain the round dropped whole back to the path the
 *   record still has"; `tangled` answering false -> "names no record through a path two dropped
 *   ops aim at or two leave, and leaves the edges as written"; `removed` or `retargeted`
 *   reporting the op's current path rather than the log's -> "reports a kept op it moved and then
 *   took or aimed back at the path the log held it at". The rest of it is pinned through `session
 *   commit --drop-refused` in `apps/cli/tests/head-server-commit.test.ts`.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<Repo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const SHA = "0".repeat(40)
const FROM = "areas/inbox/agentd-timeout.html"
const TO = "resources/vm-runner/agentd-timeout.html"
const HOLDER = "areas/arcs/agentd-arc.html"
const PLACED = memory("agentd timeout", "agentd kills an exec after its stated timeout.", {
  entities: ["project:vm-runner"]
})
const ARC = addLink(
  memory("agentd arc", "Four agentd memories together show the runtime bounds every exec.", {
    entities: ["project:vm-runner"]
  }),
  "part_of",
  `/${FROM}`
)

const move = (path: string, to: string, html: string): OverlayOp => ({
  kind: "move",
  path,
  to,
  html
})
const unlink = (path: string, rel: string, href: string): OverlayOp => ({
  kind: "unlink",
  path,
  rel,
  href
})
const link = (path: string, rel: string, href: string): OverlayOp => ({
  kind: "link",
  path,
  rel,
  href
})

const view = async () =>
  mapHead(SHA, [
    await recordFrom(FROM, PLACED),
    await recordFrom(HOLDER, ARC),
    await recordFrom(
      "archive/2026/areas/inbox/gone.html",
      addLink(memory("Gone", "A retired fact."), "relates_to", `/${FROM}`)
    ),
    await recordFrom("resources/vm-runner/other.html", memory("Other", "Another fact."))
  ])

describe("placement before move", () => {
  it("a put of an inbox record's bytes at its home is a duplicate, archive or no archive", async () => {
    const head = await view()
    const refused = validateOps(
      head,
      [
        { kind: "put", path: TO, html: PLACED },
        { kind: "archive", path: FROM, to: `archive/2026/${FROM}`, html: PLACED }
      ],
      { scope: "curate" }
    )
    expect(refused).toContainEqual({ kind: "duplicate", path: TO, existing: FROM })
  })
})

describe("validateOps judges a move", () => {
  it("a move that leaves an edge to the old path behind is refused, and one that repoints it passes", async () => {
    const head = await view()
    const alone = validateOps(head, [move(FROM, TO, PLACED)], { scope: "curate" })
    expect(alone).toEqual([
      {
        kind: "format",
        path: FROM,
        reasons: [
          `moved to ${TO}, but ${HOLDER} still carries part_of -> /${FROM}: repoint it with an unlink of that edge and a link of the same rel to /${TO} in the same batch`
        ]
      }
    ])
    // The repoint may come before or after the move in the order; the archived holder keeps its
    // edge as history and is never asked to move it.
    const repoint = [unlink(HOLDER, "part_of", `/${FROM}`), link(HOLDER, "part_of", `/${TO}`)]
    expect(validateOps(head, [...repoint, move(FROM, TO, PLACED)], { scope: "curate" })).toEqual([])
    expect(validateOps(head, [move(FROM, TO, PLACED), ...repoint], { scope: "curate" })).toEqual([])
    // A link this batch aims at the old path dangles the same way.
    const aimed = validateOps(
      head,
      [
        ...repoint,
        move(FROM, TO, PLACED),
        link("resources/vm-runner/other.html", "relates_to", `/${FROM}`)
      ],
      { scope: "curate" }
    )
    expect(aimed).toHaveLength(1)
    expect(aimed[0]).toMatchObject({ kind: "format", path: FROM })
  })

  it("refuses a move onto a path that holds a record, under archive/, or written twice", async () => {
    const head = await view()
    const reasonsFor = (ops: ReadonlyArray<OverlayOp>) =>
      validateOps(head, ops, { scope: "curate" }).flatMap((violation) =>
        violation.kind === "format" ? violation.reasons : [violation.kind]
      )
    const repoint = [unlink(HOLDER, "part_of", `/${FROM}`), link(HOLDER, "part_of", `/${TO}`)]
    expect(
      reasonsFor([...repoint, move(FROM, "resources/vm-runner/other.html", PLACED)])
    ).toContain("move destination already holds a record")
    expect(reasonsFor([...repoint, move(FROM, `archive/2026/${FROM}`, PLACED)])).toContain(
      "move destination is under archive/; retiring a record is the archive op"
    )
    expect(reasonsFor([move(FROM, FROM, PLACED)])).toContain("move destination is the source path")
    expect(reasonsFor([move(FROM, "notes/x.html", PLACED)])[0]).toMatch(/^move destination: /)
    expect(
      reasonsFor([
        ...repoint,
        { kind: "put", path: TO, html: memory("New", "A different fact.") },
        move(FROM, TO, PLACED)
      ])
    ).toContain("move destination is written earlier in this batch")
    // A put after the move at its destination is an edit of the moved record's claim.
    expect(
      reasonsFor([
        ...repoint,
        move(FROM, TO, PLACED),
        { kind: "put", path: TO, html: memory("New", "A different fact.") }
      ])
    ).toContain("claim-edit")
    expect(
      reasonsFor([...repoint, move(FROM, TO, memory("Other", "Not this article."))])
    ).toContain("move op's article differs from the source record's")
    expect(reasonsFor([move("areas/inbox/missing.html", TO, PLACED)])[0]).toMatch(
      /^move source is not an active record/
    )
    expect(reasonsFor([move("archive/2026/areas/inbox/gone.html", TO, PLACED)])[0]).toMatch(
      /^move source is not an active record/
    )
  })

  it("a record that moved is edited at its destination and never at the path it left", async () => {
    const head = await view()
    const repoint = [unlink(HOLDER, "part_of", `/${FROM}`), link(HOLDER, "part_of", `/${TO}`)]
    // The destination takes head ops like any live record, and carries the source's entities.
    expect(
      validateOps(
        head,
        [
          ...repoint,
          move(FROM, TO, PLACED),
          { kind: "label", path: TO, entity: "system:agentd" },
          { kind: "unlabel", path: TO, entity: "project:vm-runner" }
        ],
        { scope: "curate" }
      )
    ).toEqual([])
    const stale = validateOps(
      head,
      [...repoint, move(FROM, TO, PLACED), link(FROM, "relates_to", `/${HOLDER}`)],
      { scope: "curate" }
    )
    expect(stale).toEqual([
      { kind: "format", path: FROM, reasons: ["link source is not an active record in the head"] }
    ])
    const archived = validateOps(
      head,
      [
        ...repoint,
        move(FROM, TO, PLACED),
        { kind: "archive", path: FROM, to: `archive/2026/${FROM}`, html: PLACED }
      ],
      { scope: "curate" }
    )
    expect(archived).toContainEqual({
      kind: "format",
      path: FROM,
      reasons: ["archive source was moved away earlier in this batch"]
    })
    // Moved twice in one batch: the second finds nothing at the path.
    const twice = validateOps(
      head,
      [
        ...repoint,
        move(FROM, TO, PLACED),
        move(FROM, "resources/agentd/agentd-timeout.html", PLACED)
      ],
      { scope: "curate" }
    )
    expect(twice[0]).toMatchObject({ kind: "format", path: FROM })
  })

  it("a moved record keeps to the write bar's anchor rule at its destination", async () => {
    const bare = memory("Workspace fact", "The workspace builds with one command.", {
      entities: []
    })
    const head = mapHead(SHA, [await recordFrom("projects/workshop/build.html", bare)])
    const bareMove = [move("projects/workshop/build.html", "resources/workshop/build.html", bare)]
    expect(validateOps(head, bareMove, { scope: "curate", writeBar: STRICT_BAR })).toEqual([
      { kind: "write-bar", path: "resources/workshop/build.html", reasons: [UNANCHORED_REASON] }
    ])
    expect(
      validateOps(
        head,
        [
          { kind: "label", path: "projects/workshop/build.html", entity: "project:workshop" },
          move("projects/workshop/build.html", "resources/workshop/build.html", bare)
        ],
        { scope: "curate", writeBar: STRICT_BAR }
      )
    ).toEqual([])
    // The library default bar holds no anchor rule, so the bare move lands.
    expect(validateOps(head, bareMove, { scope: "curate" })).toEqual([])
  })

  it("a reserved destination is refused under the session scope and open to the curator", async () => {
    const head = await view()
    const people = "resources/people/agentd-timeout.html"
    const ops = [
      unlink(HOLDER, "part_of", `/${FROM}`),
      link(HOLDER, "part_of", `/${people}`),
      move(FROM, people, PLACED)
    ]
    // The holder is an arc, so the session scope refuses its edits too; the destination is the point.
    expect(validateOps(head, ops)).toContainEqual({ kind: "reserved-path", path: people })
    expect(validateOps(head, ops, { scope: "curate" })).toEqual([])
  })
})

describe("withRepoints", () => {
  it("withRepoints repoints every live holder before the first move and leaves archived holders and settled edges alone", async () => {
    const head = await view()
    const moved = move(FROM, TO, PLACED)
    const completed = withRepoints(head, [moved], "curate")
    expect(completed).toEqual([
      unlink(HOLDER, "part_of", `/${FROM}`),
      link(HOLDER, "part_of", `/${TO}`),
      moved
    ])
    expect(validateOps(head, completed, { scope: "curate" })).toEqual([])
    // No move, no change; an edge the batch already unlinks is the batch's; a holder it archives
    // keeps its edge.
    const labelOnly: OverlayOp = { kind: "label", path: FROM, entity: "system:agentd" }
    expect(withRepoints(head, [labelOnly])).toEqual([labelOnly])
    const dropped = [unlink(HOLDER, "part_of", `/${FROM}`), moved]
    expect(withRepoints(head, dropped, "curate")).toEqual(dropped)
    const retire: OverlayOp = {
      kind: "archive",
      path: HOLDER,
      to: `archive/2026/${HOLDER}`,
      html: ARC
    }
    expect(withRepoints(head, [retire, moved], "curate")).toEqual([retire, moved])
    expect(validateOps(head, [retire, moved], { scope: "curate" })).toEqual([])
  })

  it("repoints a holder the batch also moves at its old path, so the edit travels", async () => {
    const second = "areas/inbox/agentd-arc-note.html"
    const note = addLink(
      memory("agentd note", "The agentd timeout is stated per exec.", {
        entities: ["project:vm-runner"]
      }),
      "relates_to",
      `/${FROM}`
    )
    const head = mapHead(SHA, [await recordFrom(FROM, PLACED), await recordFrom(second, note)])
    const secondTo = "resources/vm-runner/agentd-arc-note.html"
    const completed = withRepoints(head, [move(FROM, TO, PLACED), move(second, secondTo, note)])
    expect(completed.slice(0, 2)).toEqual([
      unlink(second, "relates_to", `/${FROM}`),
      link(second, "relates_to", `/${TO}`)
    ])
    expect(validateOps(head, completed, { scope: "curate" })).toEqual([])
  })
})

/** A retired claim, the live claim that supersedes it, and the slot the retired one archives to. */
const RETIRED = "resources/acme-widget/b.html"
const SUCCESSOR = "resources/acme-widget/a.html"
const SLOT = archivePathFor(RETIRED, 2031)
const RETIRED_HTML = memory("Widget batch size", "The acme widget ships in batches of twelve.", {
  entities: ["project:acme-widget"],
  at: "2031-03-01T12:00:00Z"
})
const SUCCESSOR_HTML = addLink(
  memory("Widget batch size, revised", "The acme widget ships in batches of twenty.", {
    entities: ["project:acme-widget"],
    at: "2031-03-02T12:00:00Z"
  }),
  "supersedes",
  `/${RETIRED}`
)
const retire = (path: string, html: string): OverlayOp => ({
  kind: "archive",
  path,
  to: archivePathFor(path, 2031),
  html
})

describe("withRepoints completes an archive", () => {
  it("repoints every live edge to the archived path at its archive slot, before the archive", async () => {
    const head = mapHead(SHA, [
      await recordFrom(SUCCESSOR, SUCCESSOR_HTML),
      await recordFrom(RETIRED, RETIRED_HTML)
    ])
    const archived = retire(RETIRED, RETIRED_HTML)
    const completed = withRepoints(head, [archived])
    expect(completed).toEqual([
      unlink(SUCCESSOR, "supersedes", `/${RETIRED}`),
      link(SUCCESSOR, "supersedes", `/${SLOT}`),
      archived
    ])
    expect(validateOps(head, completed)).toEqual([])
  })

  it("leaves a holder the batch archives, an archived holder, and an edge the batch cuts alone, and edits a holder the batch moves at its old path", async () => {
    const note = "resources/acme-widget/c.html"
    const noteHtml = addLink(
      addLink(
        memory("Widget packing note", "Widget batches are packed by hand.", {
          entities: ["project:acme-widget"]
        }),
        "relates_to",
        `/${RETIRED}`
      ),
      "part_of",
      `/${RETIRED}`
    )
    const history = archivePathFor("resources/acme-widget/d.html", 2030)
    const head = mapHead(SHA, [
      await recordFrom(SUCCESSOR, SUCCESSOR_HTML),
      await recordFrom(RETIRED, RETIRED_HTML),
      await recordFrom(note, noteHtml),
      await recordFrom(
        history,
        addLink(memory("Old widget note", "An older widget fact."), "relates_to", `/${RETIRED}`)
      )
    ])
    const archived = retire(RETIRED, RETIRED_HTML)
    // Every edge a live holder carries gets its own pair; the archived holder is history.
    const completed = withRepoints(head, [archived])
    expect(completed).toEqual([
      unlink(SUCCESSOR, "supersedes", `/${RETIRED}`),
      link(SUCCESSOR, "supersedes", `/${SLOT}`),
      unlink(note, "relates_to", `/${RETIRED}`),
      link(note, "relates_to", `/${SLOT}`),
      unlink(note, "part_of", `/${RETIRED}`),
      link(note, "part_of", `/${SLOT}`),
      archived
    ])
    expect(validateOps(head, completed)).toEqual([])
    // A holder the batch archives keeps its edge in its archived copy; an edge the batch already
    // cuts is the batch's.
    const both = [
      unlink(note, "part_of", `/${RETIRED}`),
      unlink(note, "relates_to", `/${RETIRED}`),
      retire(SUCCESSOR, SUCCESSOR_HTML),
      archived
    ]
    expect(withRepoints(head, both)).toEqual(both)
    expect(validateOps(head, both)).toEqual([])
    // A holder the batch moves is repointed before the first move or archive, so the edit travels.
    const moved = "resources/acme-gadget/a.html"
    const travels = withRepoints(head, [
      unlink(note, "part_of", `/${RETIRED}`),
      unlink(note, "relates_to", `/${RETIRED}`),
      move(SUCCESSOR, moved, SUCCESSOR_HTML),
      archived
    ])
    expect(travels.slice(2, 4)).toEqual([
      unlink(SUCCESSOR, "supersedes", `/${RETIRED}`),
      link(SUCCESSOR, "supersedes", `/${SLOT}`)
    ])
    expect(validateOps(head, travels)).toEqual([])
  })

  it("repoints a live holder's edge to a path the batch puts and then archives, and not one it puts at after the archive", async () => {
    const note = "resources/acme-widget/c.html"
    const noteHtml = addLink(
      memory("Widget packing note", "Widget batches are packed by hand.", {
        entities: ["project:acme-widget"]
      }),
      "relates_to",
      `/${RETIRED}`
    )
    // The note's edge names a path the head does not hold; the batch writes a record there and
    // retires it, so the edge follows the record to its slot.
    const head = mapHead(SHA, [await recordFrom(note, noteHtml)])
    const written: OverlayOp = { kind: "put", path: RETIRED, html: RETIRED_HTML }
    const archived = retire(RETIRED, RETIRED_HTML)
    const completed = withRepoints(head, [written, archived])
    expect(completed).toEqual([
      written,
      unlink(note, "relates_to", `/${RETIRED}`),
      link(note, "relates_to", `/${SLOT}`),
      archived
    ])
    expect(validateOps(head, completed)).toEqual([])
    expect(missingRepoints(head, [written, archived]).ops).toEqual(completed.slice(1, 3))
    expect(missingRepoints(head, completed)).toEqual({ ops: [], overflow: [] })
    // A put at the path after the archive is a claim edit, refused whatever the edges, so the
    // archive gets no pairs for it.
    const live = mapHead(SHA, [
      await recordFrom(RETIRED, RETIRED_HTML),
      await recordFrom(note, noteHtml)
    ])
    const again: OverlayOp = {
      kind: "put",
      path: RETIRED,
      html: memory("Widget batch size, again", "The acme widget ships in batches of thirty.", {
        entities: ["project:acme-widget"]
      })
    }
    expect(withRepoints(live, [archived, again])).toEqual([archived, again])
    expect(missingRepoints(live, [archived, again])).toEqual({ ops: [], overflow: [] })
    expect(validateOps(live, [archived, again]).map((violation) => violation.kind)).toContain(
      "claim-edit"
    )
  })

  it("leaves a holder the scope may not write to the curator, and repoints it under curate", async () => {
    const arc = "areas/arcs/acme-widget-arc.html"
    const arcHtml = addLink(
      memory("Acme widget arc", "Four widget memories together show how batches grew.", {
        entities: ["project:acme-widget"]
      }),
      "part_of",
      `/${RETIRED}`
    )
    const head = mapHead(SHA, [
      await recordFrom(RETIRED, RETIRED_HTML),
      await recordFrom(arc, arcHtml)
    ])
    const archived = retire(RETIRED, RETIRED_HTML)
    // Under `session` the arc is the curator's to edit, so the archive goes alone and lands.
    expect(withRepoints(head, [archived])).toEqual([archived])
    expect(validateOps(head, [archived])).toEqual([])
    const curated = withRepoints(head, [archived], "curate")
    expect(curated).toEqual([
      unlink(arc, "part_of", `/${RETIRED}`),
      link(arc, "part_of", `/${SLOT}`),
      archived
    ])
    expect(validateOps(head, curated, { scope: "curate" })).toEqual([])
  })

  it("takes an unlink at the path the batch moved a holder to as that holder's repoint", async () => {
    const note = "resources/acme-widget/c.html"
    const placed = "resources/acme-gadget/c.html"
    const noteHtml = addLink(
      memory("Widget packing note", "Widget batches are packed by hand.", {
        entities: ["project:acme-widget"]
      }),
      "relates_to",
      `/${RETIRED}`
    )
    const head = mapHead(SHA, [
      await recordFrom(RETIRED, RETIRED_HTML),
      await recordFrom(note, noteHtml)
    ])
    // One exec moved the note; a later one archived the record it cites and repointed the note
    // where it now is, over the overlaid view. Completing the whole log again adds nothing.
    const log = [
      move(note, placed, noteHtml),
      unlink(placed, "relates_to", `/${RETIRED}`),
      link(placed, "relates_to", `/${SLOT}`),
      retire(RETIRED, RETIRED_HTML)
    ]
    expect(withRepoints(head, log)).toEqual(log)
    expect(validateOps(head, log)).toEqual([])
  })

  it("commits the archive with the successor's supersedes edge at the archive slot", async () => {
    const repo = await makeRepo()
    repos.push(repo)
    await commitFiles(repo.root, { [SUCCESSOR]: SUCCESSOR_HTML, [RETIRED]: RETIRED_HTML })
    const head = await loadHead(repo.root)
    const ops = withRepoints(head, [retire(RETIRED, RETIRED_HTML)])
    const session = await run(
      startSession({ root: repo.root, id: "retire", base: head }).pipe(
        Effect.flatMap((s) => appendOps(s, ops))
      )
    )
    const outcome = await run(commitSession({ session, head, message: "retire one claim" }))
    if (outcome.kind !== "committed") throw new Error(JSON.stringify(outcome))
    const paths = await treePaths(repo.root, outcome.sha)
    expect(paths).toContain(SLOT)
    expect(paths).not.toContain(RETIRED)
    const successor = await fileAt(repo.root, outcome.sha, SUCCESSOR)
    expect(successor).toContain(`<link rel="memhtml-supersedes" href="/${SLOT}">`)
    expect(successor).not.toContain(`href="/${RETIRED}"`)
    // Every edge in the landed tree names a file in the landed tree.
    for (const path of paths.filter((one) => one.endsWith(".html"))) {
      const html = await fileAt(repo.root, outcome.sha, path)
      for (const match of html.matchAll(/<link rel="memhtml-[^"]+" href="\/([^"]+)"/g)) {
        expect(paths, `${path} -> ${match[1]}`).toContain(match[1])
      }
    }
  })

  it("marks no contradiction against a rival the same batch archives", async () => {
    const repo = await makeRepo()
    repos.push(repo)
    await commitFiles(repo.root, { [RETIRED]: RETIRED_HTML })
    const head = await loadHead(repo.root)
    // The successor shares the retired claim's frame key and names it at its archive slot.
    const successor = addLink(
      memory("Widget batch size, revised", "The acme widget ships in batches of twenty.", {
        entities: ["project:acme-widget"],
        at: "2031-03-02T12:00:00Z"
      }),
      "supersedes",
      `/${SLOT}`
    )
    const ops = withRepoints(head, [
      { kind: "put", path: SUCCESSOR, html: successor },
      retire(RETIRED, RETIRED_HTML)
    ])
    expect(validateOps(head, ops)).toEqual([])
    const session = await run(
      startSession({ root: repo.root, id: "replace", base: head }).pipe(
        Effect.flatMap((s) => appendOps(s, ops))
      )
    )
    const outcome = await run(commitSession({ session, head, message: "replace one claim" }))
    if (outcome.kind !== "committed") throw new Error(JSON.stringify(outcome))
    expect(outcome.contradictions).toEqual([])
    const landed = await fileAt(repo.root, outcome.sha, SUCCESSOR)
    expect(landed).not.toContain("memhtml-contradicts")
    expect(landed).toContain(`<link rel="memhtml-supersedes" href="/${SLOT}">`)
  })
})

describe("missingRepoints completes a written log by appending to it", () => {
  const NOTE = "resources/acme-widget/c.html"
  const NOTE_HTML = addLink(
    memory("Widget packing note", "Widget batches are packed by hand.", {
      entities: ["project:acme-widget"]
    }),
    "relates_to",
    `/${RETIRED}`
  )
  const headWithCiters = async () =>
    mapHead(SHA, [
      await recordFrom(SUCCESSOR, SUCCESSOR_HTML),
      await recordFrom(RETIRED, RETIRED_HTML),
      await recordFrom(NOTE, NOTE_HTML)
    ])

  it("appends each missing pair after the log, at the path the log leaves its holder", async () => {
    const head = await headWithCiters()
    // A log written with no repoints: the note moves, then the record it cites is archived.
    const placed = "resources/acme-gadget/c.html"
    const log = [move(NOTE, placed, NOTE_HTML), retire(RETIRED, RETIRED_HTML)]
    const completion = missingRepoints(head, log)
    expect(completion).toEqual({
      ops: [
        unlink(SUCCESSOR, "supersedes", `/${RETIRED}`),
        link(SUCCESSOR, "supersedes", `/${SLOT}`),
        unlink(placed, "relates_to", `/${RETIRED}`),
        link(placed, "relates_to", `/${SLOT}`)
      ],
      overflow: []
    })
    const completed = [...log, ...completion.ops]
    expect(validateOps(head, completed)).toEqual([])
    // Complete now, so a second pass adds nothing.
    expect(missingRepoints(head, completed)).toEqual({ ops: [], overflow: [] })
    // A log whose exec already repointed (withRepoints) needs nothing either.
    expect(missingRepoints(head, withRepoints(head, log))).toEqual({ ops: [], overflow: [] })
  })

  it("names the archive whose pairs would take a log within the cap over it, and adds nothing", async () => {
    const head = await headWithCiters()
    const log = [retire(RETIRED, RETIRED_HTML)]
    // Two holders: four ops, so the log of one op reaches five.
    expect(missingRepoints(head, log, "session", 5).ops).toHaveLength(4)
    expect(missingRepoints(head, log, "session", 4)).toEqual({
      ops: [],
      overflow: [
        {
          kind: "format",
          path: RETIRED,
          reasons: [
            `archived to ${SLOT}, and repointing the 2 edges live records carry to /${RETIRED} that the log does not repoint would take it to 5 ops, over the cap of 4: archive it in a session of its own`
          ]
        }
      ]
    })
    // A log already over the cap is refused as it stands: nothing added, nothing named.
    expect(missingRepoints(head, log, "session", 0)).toEqual({ ops: [], overflow: [] })
  })
})

describe("afterDroppedVacates settles the ops a drop round keeps", () => {
  const NOTE = "resources/acme-widget/c.html"
  const OTHER = "resources/acme-widget/e.html"
  const NOTE_HTML = addLink(
    memory("Widget packing note", "Widget batches are packed by hand.", {
      entities: ["project:acme-widget"]
    }),
    "relates_to",
    `/${RETIRED}`
  )
  const OTHER_HTML = memory("Widget crate note", "Widget crates hold four batches.", {
    entities: ["project:acme-widget"]
  })
  const headOf = async () =>
    mapHead(SHA, [
      await recordFrom(RETIRED, RETIRED_HTML),
      await recordFrom(NOTE, NOTE_HTML),
      await recordFrom(OTHER, OTHER_HTML)
    ])
  // A put superseding the record at its slot, the note's repoint pair, and a link to the slot.
  const successor: OverlayOp = {
    kind: "put",
    path: SUCCESSOR,
    html: addLink(
      memory("Widget batch size, revised", "The acme widget ships in batches of twenty.", {
        entities: ["project:acme-widget"]
      }),
      "supersedes",
      `/${SLOT}`
    )
  }
  const pair = [unlink(NOTE, "relates_to", `/${RETIRED}`), link(NOTE, "relates_to", `/${SLOT}`)]
  const cites = link(OTHER, "part_of", `/${SLOT}`)

  it("takes a dropped archive's pairs out and aims the kept edges to its slot at the record", async () => {
    const head = await headOf()
    const archived = retire(RETIRED, RETIRED_HTML)
    const settled = afterDroppedVacates(head, [successor, ...pair, cites], [archived])
    const rewritten = {
      ...successor,
      html: addLink(
        memory("Widget batch size, revised", "The acme widget ships in batches of twenty.", {
          entities: ["project:acme-widget"]
        }),
        "supersedes",
        `/${RETIRED}`
      )
    }
    expect(settled).toEqual({
      keep: [rewritten, link(OTHER, "part_of", `/${RETIRED}`)],
      removed: [
        { kind: "unlink", path: NOTE, detail: "relates_to", vacate: archived },
        { kind: "link", path: NOTE, detail: "relates_to", vacate: archived }
      ],
      retargeted: [
        { kind: "put", path: SUCCESSOR, detail: "supersedes", vacate: archived, home: RETIRED },
        { kind: "link", path: OTHER, detail: "part_of", vacate: archived, home: RETIRED }
      ],
      returned: [],
      homes: new Map()
    })
    expect(validateOps(head, settled.keep)).toEqual([])
  })

  it("takes the pairs and leaves the other kept ops alone when the destination is held or the record is not live", async () => {
    const head = await headOf()
    const kept = [successor, ...pair, cites]
    const archived = retire(RETIRED, RETIRED_HTML)
    const taken = (vacate: OverlayOp) => [
      { kind: "unlink", path: NOTE, detail: "relates_to", vacate },
      { kind: "link", path: NOTE, detail: "relates_to", vacate }
    ]
    const pairOnly = { keep: [successor, cites], retargeted: [], returned: [], homes: new Map() }
    // A kept op writes the slot, so the edges to it resolve there.
    const held: OverlayOp = { kind: "put", path: SLOT, html: RETIRED_HTML }
    expect(afterDroppedVacates(head, [...kept, held], [archived])).toEqual({
      ...pairOnly,
      keep: [successor, cites, held],
      removed: taken(archived)
    })
    // The version already holds the slot, an older copy of the path: the edges to it name that.
    const older = mapHead(SHA, [
      await recordFrom(RETIRED, RETIRED_HTML),
      await recordFrom(NOTE, NOTE_HTML),
      await recordFrom(OTHER, OTHER_HTML),
      await recordFrom(
        SLOT,
        memory("Widget batch size, earlier", "The acme widget shipped in sixes.")
      )
    ])
    expect(afterDroppedVacates(older, kept, [archived])).toEqual({
      ...pairOnly,
      removed: taken(archived)
    })
    // The record is not in the view, so there is nowhere to aim the edges back to.
    const elsewhere = mapHead(SHA, [await recordFrom(NOTE, NOTE_HTML)])
    expect(afterDroppedVacates(elsewhere, kept, [archived])).toEqual({
      ...pairOnly,
      removed: taken(archived)
    })
    // Only an archive or a move vacates a path.
    expect(afterDroppedVacates(head, kept, [link(OTHER, "part_of", `/${SLOT}`)])).toEqual({
      ...pairOnly,
      keep: kept,
      removed: []
    })
  })

  it("follows a chain the round dropped whole back to the path the record still has", async () => {
    const head = await headOf()
    const placed = "resources/acme-gadget/b.html"
    const further = "resources/acme-gadget/old/b.html"
    const slotted = archivePathFor(placed, 2031)
    const first = move(RETIRED, placed, RETIRED_HTML)
    // A put citing where a second move would take the record, and one superseding the slot an
    // archive of it there would fill.
    const cites: OverlayOp = {
      kind: "put",
      path: SUCCESSOR,
      html: addLink(
        memory("Widget note", "Widget batches end up in the gadget area."),
        "relates_to",
        `/${further}`
      )
    }
    const moved = afterDroppedVacates(head, [cites], [first, move(placed, further, RETIRED_HTML)])
    expect(moved.keep).toEqual([
      {
        ...cites,
        html: addLink(
          memory("Widget note", "Widget batches end up in the gadget area."),
          "relates_to",
          `/${RETIRED}`
        )
      }
    ])
    expect(moved.homes).toEqual(
      new Map([
        [placed, RETIRED],
        [further, RETIRED]
      ])
    )
    const supersedes: OverlayOp = {
      ...successor,
      html: successor.html.replace(`/${SLOT}`, `/${slotted}`)
    }
    const archived = afterDroppedVacates(head, [supersedes], [first, retire(placed, RETIRED_HTML)])
    expect(archived.keep).toEqual([
      { ...successor, html: successor.html.replace(`/${SLOT}`, `/${RETIRED}`) }
    ])
    expect(archived.retargeted.map((edge) => [edge.path, edge.detail])).toEqual([
      [SUCCESSOR, "supersedes"]
    ])
  })

  it("makes the ops kept at a dropped move's destination at its source", async () => {
    const head = await headOf()
    const placed = "resources/acme-gadget/c.html"
    const moved = move(NOTE, placed, NOTE_HTML)
    // The note's repoint for the archive, appended after the move at the path it takes the note
    // to, and a label there.
    const kept = [
      retire(RETIRED, RETIRED_HTML),
      unlink(placed, "relates_to", `/${RETIRED}`),
      link(placed, "relates_to", `/${SLOT}`),
      { kind: "label", path: placed, entity: "system:packing" } as const
    ]
    const settled = afterDroppedVacates(head, kept, [moved])
    expect(settled).toEqual({
      keep: [
        kept[0],
        unlink(NOTE, "relates_to", `/${RETIRED}`),
        link(NOTE, "relates_to", `/${SLOT}`),
        { kind: "label", path: NOTE, entity: "system:packing" }
      ],
      removed: [],
      retargeted: [],
      returned: [
        { kind: "unlink", path: placed, detail: "relates_to", vacate: moved, home: NOTE },
        { kind: "link", path: placed, detail: "relates_to", vacate: moved, home: NOTE },
        { kind: "label", path: placed, detail: "system:packing", vacate: moved, home: NOTE }
      ],
      homes: new Map([[placed, NOTE]])
    })
    expect(validateOps(head, settled.keep)).toEqual([])
    // So the archive's repoint stands where the note stays, and nothing is added for it.
    expect(missingRepoints(head, settled.keep)).toEqual({ ops: [], overflow: [] })
  })

  // Reported as the log held them: the note's pair the commit appended at the path the move takes
  // it to, made at the note's path for the move and then taken with the archive.
  it("reports a kept op it moved and then took or aimed back at the path the log held it at", async () => {
    const head = await headOf()
    const placed = "resources/acme-gadget/c.html"
    const moved = move(NOTE, placed, NOTE_HTML)
    const archived = retire(RETIRED, RETIRED_HTML)
    const pairThere = [
      unlink(placed, "relates_to", `/${RETIRED}`),
      link(placed, "relates_to", `/${SLOT}`)
    ]
    const taken = afterDroppedVacates(head, pairThere, [moved, archived])
    expect(taken).toEqual({
      keep: [],
      removed: [
        { kind: "unlink", path: placed, detail: "relates_to", vacate: archived },
        { kind: "link", path: placed, detail: "relates_to", vacate: archived }
      ],
      retargeted: [],
      returned: [],
      homes: new Map([[placed, NOTE]])
    })
    // A link at the move's destination to the archive's slot, not a pair: made at the note's path
    // for the move, then aimed back at the record for the archive.
    const cites = link(placed, "supersedes", `/${SLOT}`)
    const aimed = afterDroppedVacates(head, [cites], [moved, archived])
    expect(aimed.keep).toEqual([link(NOTE, "supersedes", `/${RETIRED}`)])
    expect(aimed.returned).toEqual([
      { kind: "link", path: placed, detail: "supersedes", vacate: moved, home: NOTE }
    ])
    expect(aimed.retargeted).toEqual([
      { kind: "link", path: placed, detail: "supersedes", vacate: archived, home: RETIRED }
    ])
  })

  it("names no record through a path two dropped ops aim at or two leave, and leaves the edges as written", async () => {
    const head = await headOf()
    const shared = "resources/acme-gadget/x.html"
    const further = "resources/acme-gadget/y.html"
    const citesFurther: OverlayOp = {
      kind: "put",
      path: SUCCESSOR,
      html: addLink(
        memory("Widget note", "Widget records end up in the gadget area."),
        "relates_to",
        `/${further}`
      )
    }
    const labelFurther: OverlayOp = { kind: "label", path: further, entity: "system:gadget" }
    const none = { removed: [], retargeted: [], returned: [], homes: new Map() }
    // Two records moved to one path, then that path moved on: which one went on is not known.
    const intoOne = [
      move(RETIRED, shared, RETIRED_HTML),
      move(OTHER, shared, OTHER_HTML),
      move(shared, further, RETIRED_HTML)
    ]
    expect(afterDroppedVacates(head, [citesFurther, labelFurther], intoOne)).toEqual({
      ...none,
      keep: [citesFurther, labelFurther]
    })
    // One path left twice: the record there moved away, another moved in and moved on.
    const leftTwice = [
      move(OTHER, "resources/acme-gadget/d.html", OTHER_HTML),
      move(RETIRED, OTHER, RETIRED_HTML),
      move(OTHER, further, RETIRED_HTML)
    ]
    expect(afterDroppedVacates(head, [citesFurther, labelFurther], leftTwice)).toEqual({
      ...none,
      keep: [citesFurther, labelFurther]
    })
  })
})

describe("commitSession lands a move", () => {
  it("commits a move as the same blob at the new path, with the holder's edge repointed", async () => {
    const repo = await makeRepo()
    repos.push(repo)
    await commitFiles(repo.root, { [FROM]: PLACED, [HOLDER]: ARC })
    const head = await loadHead(repo.root)
    const before = await fileAt(repo.root, "main", FROM)
    const ops = withRepoints(head, [move(FROM, TO, PLACED)], "curate")
    const session = await run(
      startSession({
        root: repo.root,
        id: "place",
        base: head,
        ref: "refs/heads/curate/place"
      }).pipe(Effect.flatMap((s) => appendOps(s, ops)))
    )
    const outcome = await run(
      commitSession({ session, head, message: "file one inbox record", scope: "curate" })
    )
    if (outcome.kind !== "committed") throw new Error(JSON.stringify(outcome))
    const paths = await treePaths(repo.root, outcome.sha)
    expect(paths).toContain(TO)
    expect(paths).not.toContain(FROM)
    // The same bytes: the blob git stores at the new path is the one it stored at the old path.
    const after = await fileAt(repo.root, outcome.sha, TO)
    expect(after).toBe(before)
    expect((await git(repo.root, ["rev-parse", `${outcome.sha}:${TO}`])).trim()).toBe(
      blobShaOf(before)
    )
    expect(contentHash(after)).toBe(contentHash(PLACED))
    const arc = await fileAt(repo.root, outcome.sha, HOLDER)
    expect(arc).toContain(`href="/${TO}"`)
    expect(arc).not.toContain(`href="/${FROM}"`)
    // Every edge in the landed tree names a file in the landed tree.
    for (const path of paths.filter((one) => one.endsWith(".html"))) {
      const html = await fileAt(repo.root, outcome.sha, path)
      for (const match of html.matchAll(/<link rel="memhtml-[^"]+" href="\/([^"]+)"/g)) {
        expect(paths, `${path} -> ${match[1]}`).toContain(match[1])
      }
    }
  })

  it("a put whose frame key a moved record holds is marked against the record's new path", async () => {
    const repo = await makeRepo()
    repos.push(repo)
    const capital = memory("Capital", "The capital of India is New Delhi.")
    await commitFiles(repo.root, { "areas/inbox/capital.html": capital })
    const head = await loadHead(repo.root)
    const session = await run(
      startSession({ root: repo.root, id: "rival", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            move("areas/inbox/capital.html", "resources/india/capital.html", capital),
            {
              kind: "put",
              path: "areas/inbox/capital-2.html",
              html: memory("Capital, again", "The capital of India is Mumbai.")
            }
          ])
        )
      )
    )
    const outcome = await run(commitSession({ session, head, message: "rival" }))
    if (outcome.kind !== "committed") throw new Error(JSON.stringify(outcome))
    expect(outcome.contradictions).toEqual([
      { path: "areas/inbox/capital-2.html", against: "resources/india/capital.html" }
    ])
    expect(await fileAt(repo.root, outcome.sha, "areas/inbox/capital-2.html")).toContain(
      '<link rel="memhtml-contradicts" href="/resources/india/capital.html">'
    )
  })
})
