import type { OverlayOp } from "@memhtml/contracts"
import { addLink, contentHash } from "@memhtml/html"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { commitSession } from "../src/commit.js"
import { withRepoints } from "../src/moves.js"
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
  treePaths
} from "./helpers.js"

/**
 * The `move` op (`docs/v2-poc.md`, "Curator", placement): the one way a record changes path while
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
 *   a holder the batch archives).
 * - stage: the `move` case left out of `stage` -> "commits a move as the same blob at the new path,
 *   with the holder's edge repointed" (the old path is still in the tree).
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<Repo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const SHA = "0".repeat(40)
const FROM = "areas/inbox/agentd-timeout.html"
const TO = "resources/microvms-agentd/agentd-timeout.html"
const HOLDER = "areas/arcs/agentd-arc.html"
const PLACED = memory("agentd timeout", "agentd kills an exec after its stated timeout.", {
  entities: ["project:microvms-agentd"]
})
const ARC = addLink(
  memory("agentd arc", "Four agentd memories together show the runtime bounds every exec.", {
    entities: ["project:microvms-agentd"]
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
    await recordFrom("resources/microvms-agentd/other.html", memory("Other", "Another fact."))
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
        link("resources/microvms-agentd/other.html", "relates_to", `/${FROM}`)
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
      reasonsFor([...repoint, move(FROM, "resources/microvms-agentd/other.html", PLACED)])
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
          { kind: "unlabel", path: TO, entity: "project:microvms-agentd" }
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
    const head = mapHead(SHA, [await recordFrom("projects/atelier/build.html", bare)])
    expect(
      validateOps(
        head,
        [move("projects/atelier/build.html", "resources/atelier/build.html", bare)],
        {
          scope: "curate"
        }
      )
    ).toEqual([
      { kind: "write-bar", path: "resources/atelier/build.html", reasons: [UNANCHORED_REASON] }
    ])
    expect(
      validateOps(
        head,
        [
          { kind: "label", path: "projects/atelier/build.html", entity: "project:atelier" },
          move("projects/atelier/build.html", "resources/atelier/build.html", bare)
        ],
        { scope: "curate" }
      )
    ).toEqual([])
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
    const completed = withRepoints(head, [moved])
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
    expect(withRepoints(head, dropped)).toEqual(dropped)
    const retire: OverlayOp = {
      kind: "archive",
      path: HOLDER,
      to: `archive/2026/${HOLDER}`,
      html: ARC
    }
    expect(withRepoints(head, [retire, moved])).toEqual([retire, moved])
    expect(validateOps(head, [retire, moved], { scope: "curate" })).toEqual([])
  })

  it("repoints a holder the batch also moves at its old path, so the edit travels", async () => {
    const second = "areas/inbox/agentd-arc-note.html"
    const note = addLink(
      memory("agentd note", "The agentd timeout is stated per exec.", {
        entities: ["project:microvms-agentd"]
      }),
      "relates_to",
      `/${FROM}`
    )
    const head = mapHead(SHA, [await recordFrom(FROM, PLACED), await recordFrom(second, note)])
    const secondTo = "resources/microvms-agentd/agentd-arc-note.html"
    const completed = withRepoints(head, [move(FROM, TO, PLACED), move(second, secondTo, note)])
    expect(completed.slice(0, 2)).toEqual([
      unlink(second, "relates_to", `/${FROM}`),
      link(second, "relates_to", `/${TO}`)
    ])
    expect(validateOps(head, completed, { scope: "curate" })).toEqual([])
  })
})

describe("commitSession lands a move", () => {
  it("commits a move as the same blob at the new path, with the holder's edge repointed", async () => {
    const repo = await makeRepo()
    repos.push(repo)
    await commitFiles(repo.root, { [FROM]: PLACED, [HOLDER]: ARC })
    const head = await loadHead(repo.root)
    const before = await fileAt(repo.root, "main", FROM)
    const ops = withRepoints(head, [move(FROM, TO, PLACED)])
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
