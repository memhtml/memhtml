import { execFileSync } from "node:child_process"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { checkMemory } from "@memhtml/html"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { commitMessage, commitSession, commitSubject } from "../src/commit.js"
import {
  appendOps,
  rebaseSession,
  resumeSession,
  sessionRef,
  sessionStateFile,
  startSession
} from "../src/session.js"
import {
  commitFiles,
  fileAt,
  git,
  loadHead,
  type MapHead,
  makeRepo,
  memory,
  type Repo,
  treePaths
} from "./helpers.js"

/**
 * The commit algorithm against real temp repos. Every repo here has `main` checked out, so the
 * checkout-follows path (step 5) runs in most cases; the curator-ref case is the one where it does not.
 *
 * Mutation notes, one per guard, each run once with the change applied and the named test red:
 * - step 0: `isAncestor` result treated as false -> "a commit killed after the swap is recovered".
 * - step 1: `if (violations.length > 0)` -> `if (false)` -> "refuses ... and writes nothing".
 * - step 1 scope: `validateOps(head, session.ops)` with no scope -> "the curate scope lands an
 *   areas/arcs/ file that the session scope refuses" (the curator's commit is `refused`).
 * - step 2: `mainSha !== head.sha` -> `overlapping.length > 0` (the path-disjoint fast path) ->
 *   "a disjoint advance ... is rebase-needed" and "duplicate hash ... never lands without a rebase".
 * - step 3: drop the `addLink(linked, "contradicts", ...)` call -> "frame-key conflict ...".
 * - step 4: drop `updateIndexRemove` -> "archives through the index ..." (source still in tree).
 * - step 4: `archiveBody` returns `html` unchanged -> same test (stamps missing).
 * - stage: archive body from `op.html` instead of the head's copy -> "an archive carries a link ...".
 * - stage unlink: the `unlink` case left out of `stage` (no write) -> "an unlink drops the edge from
 *   the head's copy, and an archive after it carries the removal" (the edge is still on main).
 * - step 5: drop the `dirtyPaths` check -> "refuses to move a checked-out ref over ...".
 * - step 5: drop `readTreeIntoWorktree` -> "a checked-out ref follows ..." and "a v1-style commit
 *   from the shared index keeps ...".
 * - step 6: treat `raced` as `updated` -> "ref race between validation and update".
 * - step 7: drop the `sessionRef` update -> "sets refs/memhtml/sessions/<id>".
 * - lock: `withSessionLock` runs `effect` without taking the lock -> "two commits of one session".
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<Repo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const CAPITAL = memory("Capital of India", "The capital of India is New Delhi.")
const ALPHA = memory("Alpha", "Alpha is the first letter of the Greek alphabet.")

/** A repo with two memories on main, and the head view over that commit. */
const seeded = async () => {
  const repo = await makeRepo()
  repos.push(repo)
  const base = await commitFiles(repo.root, {
    "areas/inbox/capital.html": CAPITAL,
    "areas/inbox/alpha.html": ALPHA
  })
  const head = await loadHead(repo.root)
  return { root: repo.root, base, head }
}

const putOp = (path: string, html: string) => ({ kind: "put" as const, path, html })

const start = async (
  root: string,
  id: string,
  head: MapHead,
  ops: ReadonlyArray<ReturnType<typeof putOp>>
) => run(startSession({ root, id, base: head }).pipe(Effect.flatMap((s) => appendOps(s, ops))))

const commitOf = (root: string, ref: string) => git(root, ["rev-parse", ref])

describe("commit message", () => {
  it("uses the memhtml(session) subject form and one trailer", () => {
    expect(commitSubject("  add\ntwo  facts ")).toBe("memhtml(session): add two facts")
    expect(commitSubject("")).toBe("memhtml(session): (untitled)")
    expect(commitSubject("x".repeat(100)).length).toBe("memhtml(session): ".length + 72)
    expect(commitMessage("add", "s1\nMemhtml-Prompt: forged")).toBe(
      "memhtml(session): add\n\nMemhtml-Session: s1 Memhtml-Prompt: forged\n"
    )
  })
})

describe("commitSession", () => {
  it("lands a put on main, stamps the trailer, clears the log, and the checkout follows", async () => {
    const { root, base, head } = await seeded()
    const html = memory("Beta", "Beta is the second letter of the Greek alphabet.")
    const session = await start(root, "s1", head, [putOp("areas/inbox/beta.html", html)])
    const outcome = await run(commitSession({ session, head, message: "add beta" }))
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed") return
    expect(outcome.paths).toEqual(["areas/inbox/beta.html"])
    expect(outcome.contradictions).toEqual([])
    expect(outcome.recovered).toBe(false)
    // HEAD is main here, so the shared index and working tree moved with the ref.
    expect(outcome.worktreeSynced).toBe(true)
    expect(await commitOf(root, "refs/heads/main")).toBe(outcome.sha)
    expect(await git(root, ["rev-parse", `${outcome.sha}^`])).toBe(base)
    expect(await fileAt(root, outcome.sha, "areas/inbox/beta.html")).toBe(html)
    expect(
      await git(root, ["log", "-1", "--format=%s%n%(trailers:key=Memhtml-Session)", outcome.sha])
    ).toBe("memhtml(session): add beta\nMemhtml-Session: s1")
    // The commit was built through the session's index, and the checkout caught up: git sees a
    // clean tree at the new HEAD rather than the session's file as a staged deletion.
    expect(await readFile(join(root, "areas/inbox/beta.html"), "utf8")).toBe(html)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    const resumed = await run(resumeSession({ root, id: "s1" }))
    expect(resumed.ops).toEqual([])
    expect(resumed.baseSha).toBe(outcome.sha)
    expect(resumed.pending).toBeUndefined()
  })

  it("a v1-style commit from the shared index keeps the session's file on main", async () => {
    const { root, head } = await seeded()
    const html = memory("Kept", "A session's file survives the next porcelain commit.")
    const session = await start(root, "keep", head, [putOp("areas/inbox/kept.html", html)])
    const outcome = await run(commitSession({ session, head, message: "kept" }))
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    // The v1 store commits from the shared index: `git add -- <paths>` then `git commit`.
    await writeFile(join(root, "areas/inbox/later.html"), memory("Later", "A v1 write."), "utf8")
    await git(root, ["add", "--", "areas/inbox/later.html"])
    await git(root, ["commit", "-q", "-m", "v1 write"])
    const paths = await treePaths(root, "main")
    expect(paths).toContain("areas/inbox/kept.html")
    expect(paths).toContain("areas/inbox/later.html")
    expect(await git(root, ["diff", "--name-status", `${outcome.sha}`, "main"])).toBe(
      "A\tareas/inbox/later.html"
    )
  })

  it("sets refs/memhtml/sessions/<id> to the commit, and moves it on a second commit", async () => {
    const { root, head } = await seeded()
    const s1 = await start(root, "prov", head, [putOp("areas/inbox/b.html", memory("B", "B one."))])
    const first = await run(commitSession({ session: s1, head, message: "one" }))
    if (first.kind !== "committed") throw new Error(first.kind)
    expect(await commitOf(root, sessionRef("prov"))).toBe(first.sha)
    const again = await run(
      appendOps(await run(resumeSession({ root, id: "prov" })), [
        putOp("areas/inbox/c.html", memory("C", "C one."))
      ])
    )
    const second = await run(
      commitSession({ session: again, head: await loadHead(root), message: "two" })
    )
    if (second.kind !== "committed") throw new Error(second.kind)
    expect(await commitOf(root, sessionRef("prov"))).toBe(second.sha)
  })

  it("refuses a batch with a violation and writes nothing", async () => {
    const { root, base, head } = await seeded()
    const session = await start(root, "bad", head, [
      putOp("areas/inbox/ok.html", memory("Ok", "A fine fact.")),
      putOp("areas/arcs/reserved.html", memory("Arc", "Not for a session."))
    ])
    const outcome = await run(commitSession({ session, head, message: "nope" }))
    expect(outcome).toEqual({
      kind: "refused",
      violations: [{ kind: "reserved-path", path: "areas/arcs/reserved.html" }]
    })
    expect(await commitOf(root, "refs/heads/main")).toBe(base)
    await expect(commitOf(root, sessionRef("bad"))).rejects.toThrow()
  })

  it("the curate scope lands an areas/arcs/ file that the session scope refuses", async () => {
    const { root, base, head } = await seeded()
    const arc = memory("Arc", "Four memories together show the port trade follows the region.")
    const refused = await start(root, "arc-session", head, [putOp("areas/arcs/trade.html", arc)])
    expect(await run(commitSession({ session: refused, head, message: "arc" }))).toEqual({
      kind: "refused",
      violations: [{ kind: "reserved-path", path: "areas/arcs/trade.html" }]
    })
    expect(
      await run(commitSession({ session: refused, head, message: "arc", scope: "session" }))
    ).toEqual({
      kind: "refused",
      violations: [{ kind: "reserved-path", path: "areas/arcs/trade.html" }]
    })
    expect(await commitOf(root, "refs/heads/main")).toBe(base)

    // The curator's ref is unborn and not checked out, the way `curate run` opens it.
    const curator = await run(
      startSession({ root, id: "arc-curate", base: head, ref: "refs/heads/curate/arcs" }).pipe(
        Effect.flatMap((s) => appendOps(s, [putOp("areas/arcs/trade.html", arc)]))
      )
    )
    const landed = await run(
      commitSession({ session: curator, head, message: "arc", scope: "curate" })
    )
    expect(landed.kind).toBe("committed")
    if (landed.kind !== "committed") return
    expect(landed.paths).toEqual(["areas/arcs/trade.html"])
    expect(await commitOf(root, "refs/heads/curate/arcs")).toBe(landed.sha)
    expect(await fileAt(root, landed.sha, "areas/arcs/trade.html")).toBe(arc)
    expect(await git(root, ["log", "-1", "--format=%s", landed.sha])).toBe("memhtml(curate): arc")
    // `.memhtml/` is refused under the curator's scope too.
    const smuggled = await run(
      startSession({ root, id: "smuggle", base: head, ref: "refs/heads/curate/smuggle" }).pipe(
        Effect.flatMap((s) => appendOps(s, [putOp(".memhtml/state.html", arc)]))
      )
    )
    const outcome = await run(
      commitSession({ session: smuggled, head, message: "smuggle", scope: "curate" })
    )
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.violations).toContainEqual({
        kind: "reserved-path",
        path: ".memhtml/state.html"
      })
    }
    expect(await commitOf(root, "refs/heads/main")).toBe(base)
  })

  it("a disjoint advance of the ref is rebase-needed with no overlap, then lands after one rebase", async () => {
    const { root, base, head } = await seeded()
    const s1 = await start(root, "one", head, [
      putOp("areas/inbox/one.html", memory("One", "One."))
    ])
    const s2 = await start(root, "two", head, [
      putOp("areas/inbox/two.html", memory("Two", "Two."))
    ])
    const first = await run(commitSession({ session: s1, head, message: "one" }))
    expect(first.kind).toBe("committed")
    if (first.kind !== "committed") return
    // The second sees main past the version it validated against. The paths are disjoint, so
    // `overlapping` is empty, but dedup and frame keys were judged at the old head, so it rebases.
    const stale = await run(commitSession({ session: s2, head, message: "two" }))
    expect(stale).toEqual({ kind: "rebase-needed", overlapping: [], mainSha: first.sha })
    expect(await commitOf(root, "refs/heads/main")).toBe(first.sha)
    const advanced = await loadHead(root)
    const second = await run(
      commitSession({ session: rebaseSession(s2, advanced), head: advanced, message: "two" })
    )
    expect(second.kind).toBe("committed")
    if (second.kind !== "committed") return
    expect(await git(root, ["rev-parse", `${second.sha}^`])).toBe(first.sha)
    expect((await git(root, ["log", "--format=%s", `${base}..main`])).split("\n")).toEqual([
      "memhtml(session): two",
      "memhtml(session): one"
    ])
    expect(await treePaths(root, "main")).toContain("areas/inbox/one.html")
    expect(await treePaths(root, "main")).toContain("areas/inbox/two.html")
  })

  it("same path: rebase-needed, then refused with claim-edit or duplicate after the rebase", async () => {
    const { root, head } = await seeded()
    const shared = memory("Shared", "Shared claim one.")
    const s1 = await start(root, "a", head, [putOp("areas/inbox/shared.html", shared)])
    const s2 = await start(root, "b", head, [
      putOp("areas/inbox/shared.html", memory("Shared", "Shared claim two."))
    ])
    const s3 = await start(root, "c", head, [putOp("areas/inbox/shared.html", shared)])
    const first = await run(commitSession({ session: s1, head, message: "a" }))
    if (first.kind !== "committed") throw new Error(first.kind)

    const blocked = await run(commitSession({ session: s2, head, message: "b" }))
    expect(blocked).toEqual({
      kind: "rebase-needed",
      overlapping: ["areas/inbox/shared.html"],
      mainSha: first.sha
    })
    const advanced = await loadHead(root)
    const edited = await run(
      commitSession({ session: rebaseSession(s2, advanced), head: advanced, message: "b" })
    )
    expect(edited).toEqual({
      kind: "refused",
      violations: [{ kind: "claim-edit", path: "areas/inbox/shared.html" }]
    })

    const identical = await run(
      commitSession({ session: rebaseSession(s3, advanced), head: advanced, message: "c" })
    )
    expect(identical).toEqual({
      kind: "refused",
      violations: [
        { kind: "duplicate", path: "areas/inbox/shared.html", existing: "areas/inbox/shared.html" }
      ]
    })
    expect(await commitOf(root, "refs/heads/main")).toBe(first.sha)
  })

  it("same content hash from two sessions: the second is refused naming the first's path", async () => {
    const { root, head } = await seeded()
    const claim = memory("Twin A", "Twins share one claim.")
    const s1 = await start(root, "t1", head, [putOp("areas/inbox/twin-a.html", claim)])
    const s2 = await start(root, "t2", head, [
      putOp("areas/inbox/twin-b.html", memory("Twin B", "Twins share one claim."))
    ])
    const first = await run(commitSession({ session: s1, head, message: "a" }))
    if (first.kind !== "committed") throw new Error(first.kind)
    // Without a rebase the twin is judged against a head that never saw twin-a, and the paths are
    // disjoint: the commit must still not land, or main holds two active records with one hash.
    const stale = await run(commitSession({ session: s2, head, message: "b" }))
    expect(stale).toEqual({ kind: "rebase-needed", overlapping: [], mainSha: first.sha })
    expect(await treePaths(root, "main")).not.toContain("areas/inbox/twin-b.html")
    const advanced = await loadHead(root)
    const second = await run(
      commitSession({ session: rebaseSession(s2, advanced), head: advanced, message: "b" })
    )
    expect(second).toEqual({
      kind: "refused",
      violations: [
        { kind: "duplicate", path: "areas/inbox/twin-b.html", existing: "areas/inbox/twin-a.html" }
      ]
    })
  })

  it("frame-key rivals from two sessions never land without a rebase, and the second links both", async () => {
    const { root, head } = await seeded()
    const x = await start(root, "fx", head, [
      putOp("areas/inbox/cap-x.html", memory("Capital x", "The capital of India is Mumbai."))
    ])
    const y = await start(root, "fy", head, [
      putOp("areas/inbox/cap-y.html", memory("Capital y", "The capital of India is Chennai."))
    ])
    const first = await run(commitSession({ session: x, head, message: "x" }))
    if (first.kind !== "committed") throw new Error(first.kind)
    const stale = await run(commitSession({ session: y, head, message: "y" }))
    expect(stale.kind).toBe("rebase-needed")
    const advanced = await loadHead(root)
    const second = await run(
      commitSession({ session: rebaseSession(y, advanced), head: advanced, message: "y" })
    )
    if (second.kind !== "committed") throw new Error(second.kind)
    expect(second.contradictions.map((entry) => entry.against).sort()).toEqual([
      "areas/inbox/cap-x.html",
      "areas/inbox/capital.html"
    ])
    const landed = await fileAt(root, second.sha, "areas/inbox/cap-y.html")
    expect(landed).toContain('<link rel="memhtml-contradicts" href="/areas/inbox/cap-x.html">')
  })

  it("frame-key conflict: both files live, the new one carries the contradicts link", async () => {
    const { root, head } = await seeded()
    const rival = memory("Capital, revised", "The capital of India is Mumbai.")
    const session = await start(root, "fk", head, [putOp("areas/inbox/capital-2.html", rival)])
    const outcome = await run(commitSession({ session, head, message: "rival" }))
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed") return
    expect(outcome.contradictions).toEqual([
      { path: "areas/inbox/capital-2.html", against: "areas/inbox/capital.html" }
    ])
    const paths = await treePaths(root, outcome.sha)
    expect(paths).toContain("areas/inbox/capital.html")
    expect(paths).toContain("areas/inbox/capital-2.html")
    const committed = await fileAt(root, outcome.sha, "areas/inbox/capital-2.html")
    expect(committed).toContain('<link rel="memhtml-contradicts" href="/areas/inbox/capital.html">')
    expect(await fileAt(root, outcome.sha, "areas/inbox/capital.html")).toBe(CAPITAL)
  })

  it("archives through the index with the archive stamps, never through the working tree", async () => {
    const { root, head } = await seeded()
    const session = await run(
      startSession({ root, id: "arch", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            {
              kind: "archive",
              path: "areas/inbox/alpha.html",
              to: "archive/2026/areas/inbox/alpha.html",
              html: ALPHA
            }
          ])
        )
      )
    )
    const at = "2026-09-23T15:00:00.000Z"
    const outcome = await run(
      commitSession({ session, head, message: "archive alpha", archivedAt: at })
    )
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    expect(outcome.paths).toEqual(["archive/2026/areas/inbox/alpha.html", "areas/inbox/alpha.html"])
    const paths = await treePaths(root, outcome.sha)
    expect(paths).not.toContain("areas/inbox/alpha.html")
    expect(paths).toContain("archive/2026/areas/inbox/alpha.html")
    const archived = await fileAt(root, outcome.sha, "archive/2026/areas/inbox/alpha.html")
    expect(archived).toContain('<meta name="memhtml-status" content="archived">')
    expect(archived).toContain(`<meta name="memhtml-archived" content="${at}">`)
    // A rename git can follow: same article bytes, head stamps only.
    expect(
      await git(root, ["diff", "--name-status", "-M", `${outcome.sha}^`, outcome.sha])
    ).toMatch(/^R0\d\d\tareas\/inbox\/alpha\.html\tarchive\/2026\/areas\/inbox\/alpha\.html$/)
    // The checkout followed: the source is gone from disk and the archived copy is on it.
    await expect(stat(join(root, "areas/inbox/alpha.html"))).rejects.toThrow()
    expect(await readFile(join(root, "archive/2026/areas/inbox/alpha.html"), "utf8")).toBe(archived)
  })

  it("the default archive stamp is whole seconds, so the archived file still parses", async () => {
    // A millisecond stamp is refused by the format's ISO rule, and a refused archive is invisible to
    // every reader: the 2026-09-24 collapse run archived 2,170 records that way. Mutation: nowIso
    // back to `new Date().toISOString()` -> this case is red on the checkMemory violation.
    const { root, head } = await seeded()
    const session = await run(
      startSession({ root, id: "stamp", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            {
              kind: "archive",
              path: "areas/inbox/alpha.html",
              to: "archive/2026/areas/inbox/alpha.html",
              html: ALPHA
            }
          ])
        )
      )
    )
    const outcome = await run(commitSession({ session, head, message: "archive alpha" }))
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    const archived = await fileAt(root, outcome.sha, "archive/2026/areas/inbox/alpha.html")
    const stamp = /name="memhtml-archived" content="([^"]+)"/.exec(archived)?.[1]
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(checkMemory(archived).violations).toEqual([])
  })

  it("an archive carries a link added by an earlier link op in the same batch", async () => {
    const { root, head } = await seeded()
    const session = await run(
      startSession({ root, id: "arch-link", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            {
              kind: "link",
              path: "areas/inbox/alpha.html",
              rel: "supports",
              href: "/areas/inbox/capital.html"
            },
            {
              kind: "archive",
              path: "areas/inbox/alpha.html",
              to: "archive/2026/areas/inbox/alpha.html",
              html: ALPHA
            }
          ])
        )
      )
    )
    const outcome = await run(commitSession({ session, head, message: "link then archive" }))
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    const archived = await fileAt(root, outcome.sha, "archive/2026/areas/inbox/alpha.html")
    expect(archived).toContain('<link rel="memhtml-supports" href="/areas/inbox/capital.html">')
    expect(archived).toContain('<meta name="memhtml-status" content="archived">')
  })

  it("an archive minted before main linked its source carries main's link after the rebase", async () => {
    const { root, head } = await seeded()
    // Session lk adds an inbound edge to beta's future source and lands it.
    const lk = await run(
      startSession({ root, id: "lk", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            {
              kind: "link",
              path: "areas/inbox/alpha.html",
              rel: "relates_to",
              href: "/areas/inbox/capital.html"
            }
          ])
        )
      )
    )
    // Session ar, on the older base, archives alpha with the bytes it saw.
    const ar = await run(
      startSession({ root, id: "ar", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            {
              kind: "archive",
              path: "areas/inbox/alpha.html",
              to: "archive/2026/areas/inbox/alpha.html",
              html: ALPHA
            }
          ])
        )
      )
    )
    const linked = await run(commitSession({ session: lk, head, message: "link" }))
    if (linked.kind !== "committed") throw new Error(linked.kind)
    const blocked = await run(commitSession({ session: ar, head, message: "archive" }))
    expect(blocked.kind).toBe("rebase-needed")
    const advanced = await loadHead(root)
    const outcome = await run(
      commitSession({ session: rebaseSession(ar, advanced), head: advanced, message: "archive" })
    )
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    const archived = await fileAt(root, outcome.sha, "archive/2026/areas/inbox/alpha.html")
    expect(archived).toContain('<link rel="memhtml-relates-to" href="/areas/inbox/capital.html">')
    expect(await treePaths(root, outcome.sha)).not.toContain("areas/inbox/alpha.html")
  })

  it("applies a link op to the head's copy of the file", async () => {
    const { root, head } = await seeded()
    const session = await run(
      startSession({ root, id: "lnk", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            {
              kind: "link",
              path: "areas/inbox/alpha.html",
              rel: "relates_to",
              href: "/areas/inbox/capital.html"
            }
          ])
        )
      )
    )
    const outcome = await run(commitSession({ session, head, message: "link" }))
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    expect(await fileAt(root, outcome.sha, "areas/inbox/alpha.html")).toContain(
      '<link rel="memhtml-relates-to" href="/areas/inbox/capital.html">'
    )
  })

  it("an unlink drops the edge from the head's copy, and an archive after it carries the removal", async () => {
    const repo = await makeRepo()
    repos.push(repo)
    const root = repo.root
    const edge = '<link rel="memhtml-supports" href="/areas/inbox/capital.html">'
    const stale = '<link rel="memhtml-relates-to" href="/areas/inbox/gone.html">'
    const linked = ALPHA.replace("</head>", `${edge}\n${stale}\n</head>`)
    await commitFiles(root, {
      "areas/inbox/capital.html": CAPITAL,
      "areas/inbox/alpha.html": linked,
      "areas/inbox/beta.html": memory("Beta", "Beta is the second letter.").replace(
        "</head>",
        `${stale}\n</head>`
      )
    })
    const head = await loadHead(root)
    const session = await run(
      startSession({ root, id: "unlink", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            // The dangling edge dropped from a file that stays put ...
            {
              kind: "unlink",
              path: "areas/inbox/alpha.html",
              rel: "relates_to",
              href: "/areas/inbox/gone.html"
            },
            // ... and from one archived later in the same batch.
            {
              kind: "unlink",
              path: "areas/inbox/beta.html",
              rel: "relates_to",
              href: "/areas/inbox/gone.html"
            },
            {
              kind: "archive",
              path: "areas/inbox/beta.html",
              to: "archive/2026/areas/inbox/beta.html",
              html: head.get("areas/inbox/beta.html")?.html ?? ""
            }
          ])
        )
      )
    )
    const outcome = await run(commitSession({ session, head, message: "drop dangling" }))
    if (outcome.kind !== "committed") throw new Error(JSON.stringify(outcome))
    const alpha = await fileAt(root, outcome.sha, "areas/inbox/alpha.html")
    expect(alpha).not.toContain(stale)
    expect(alpha).toContain(edge)
    expect(checkMemory(alpha).violations).toEqual([])
    const archived = await fileAt(root, outcome.sha, "archive/2026/areas/inbox/beta.html")
    expect(archived).not.toContain(stale)
    expect(archived).toContain('<meta name="memhtml-status" content="archived">')
    expect(await treePaths(root, outcome.sha)).not.toContain("areas/inbox/beta.html")
    // The checkout followed, so the working tree agrees with the tree.
    expect(await readFile(join(root, "areas/inbox/alpha.html"), "utf8")).toBe(alpha)
  })

  it("ref race between validation and update: rebase-needed with the ref's new value", async () => {
    const { root, base, head } = await seeded()
    // The intruder commit shares the base tree, so its diff is empty and step 2 finds no overlap:
    // only the compare-and-swap can see it.
    const intruder = execFileSync(
      "git",
      ["-C", root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "intruder"],
      { encoding: "utf8" }
    ).trim()
    let moved = 0
    head.onByFrameKey = () => {
      // Step 3 runs after step 2's revParse and before step 5's updateRef.
      if (moved++ === 0)
        execFileSync("git", ["-C", root, "update-ref", "refs/heads/main", intruder, base])
    }
    const session = await start(root, "race", head, [
      putOp(
        "areas/inbox/capital-3.html",
        memory("Capital again", "The capital of India is Chennai.")
      )
    ])
    const outcome = await run(commitSession({ session, head, message: "raced" }))
    expect(moved).toBe(1)
    expect(outcome).toEqual({ kind: "rebase-needed", overlapping: [], mainSha: intruder })
    expect(await commitOf(root, "refs/heads/main")).toBe(intruder)
    await expect(commitOf(root, sessionRef("race"))).rejects.toThrow()
    // The session keeps its ops for the retry, carries no pending commit, and the checkout was
    // rolled back to the ref's value: the raced tree is not on disk.
    const resumed = await run(resumeSession({ root, id: "race" }))
    expect(resumed.ops).toHaveLength(1)
    expect(resumed.pending).toBeUndefined()
    await expect(stat(join(root, "areas/inbox/capital-3.html"))).rejects.toThrow()
    expect(await git(root, ["status", "--porcelain"])).toBe("")
  })

  it("a commit killed after the swap is recovered by the next commit, not refused as its own duplicate", async () => {
    const { root, head } = await seeded()
    const html = memory("Killed", "The process died after update-ref returned.")
    const session = await start(root, "kill", head, [putOp("areas/inbox/killed.html", html)])
    const before = await readFile(sessionStateFile(root, "kill"), "utf8")
    const first = await run(commitSession({ session, head, message: "killed" }))
    if (first.kind !== "committed") throw new Error(first.kind)
    // Simulate the kill: the log is as it was before the call, plus the intent written before the
    // swap. The commit is on main; the caller never heard so.
    await writeFile(
      sessionStateFile(root, "kill"),
      JSON.stringify({ ...JSON.parse(before), pending: first.sha }),
      "utf8"
    )
    const retry = await run(
      commitSession({ session: await run(resumeSession({ root, id: "kill" })), head, message: "x" })
    )
    expect(retry).toEqual({
      kind: "committed",
      sha: first.sha,
      paths: ["areas/inbox/killed.html"],
      contradictions: [],
      worktreeSynced: true,
      recovered: true
    })
    const resumed = await run(resumeSession({ root, id: "kill" }))
    expect(resumed).toMatchObject({ baseSha: first.sha, ops: [] })
    expect(resumed.pending).toBeUndefined()
    expect(await commitOf(root, sessionRef("kill"))).toBe(first.sha)
    expect(await git(root, ["rev-list", "--count", "main"])).toBe("2")
  })

  it("a pending commit that never reached the ref is dropped and the checkout rolled back", async () => {
    const { root, base, head } = await seeded()
    const html = memory("Orphan", "A tree built and staged, then the process died before the swap.")
    await start(root, "orphan", head, [putOp("areas/inbox/orphan.html", html)])
    // An orphan commit with the session's tree, and a checkout left one step ahead by the kill.
    const blob = await git(root, ["hash-object", "-w", "--stdin"], html)
    const orphan = await run(
      Effect.gen(function* () {
        const { plumbingFor } = yield* Effect.promise(() => import("../src/session.js"))
        const plumbing = plumbingFor(root, "orphan-tree")
        yield* plumbing.readTree(base)
        yield* plumbing.updateIndexAdd([
          { mode: "100644", sha: blob, path: "areas/inbox/orphan.html" }
        ])
        const tree = yield* plumbing.writeTree()
        return yield* plumbing.commitTree(tree, [base], "orphan\n")
      })
    )
    await git(root, ["read-tree", "-m", "-u", base, orphan])
    expect(await git(root, ["status", "--porcelain"])).toBe("A  areas/inbox/orphan.html")
    await writeFile(
      sessionStateFile(root, "orphan"),
      JSON.stringify({
        ...JSON.parse(await readFile(sessionStateFile(root, "orphan"), "utf8")),
        pending: orphan
      }),
      "utf8"
    )
    const outcome = await run(
      commitSession({
        session: await run(resumeSession({ root, id: "orphan" })),
        head,
        message: "again"
      })
    )
    if (outcome.kind !== "committed") throw new Error(JSON.stringify(outcome))
    expect(outcome.recovered).toBe(false)
    expect(outcome.sha).not.toBe(orphan)
    expect(await commitOf(root, "refs/heads/main")).toBe(outcome.sha)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    expect(await readFile(join(root, "areas/inbox/orphan.html"), "utf8")).toBe(html)
  })

  it("two commits of one session at once: one lands, the other is refused as locked, nothing is lost", async () => {
    const { root, head } = await seeded()
    const html = memory("Same", "Two callers submitted the same session's commit.")
    const session = await start(root, "same", head, [putOp("areas/inbox/new.html", html)])
    const results = await run(
      Effect.all(
        [
          Effect.result(commitSession({ session, head, message: "a" })),
          Effect.result(commitSession({ session, head, message: "b" }))
        ],
        { concurrency: "unbounded" }
      )
    )
    const landed = results.filter(Result.isSuccess).map((result) => result.success)
    const refused = results.filter(Result.isFailure).map((result) => result.failure)
    expect(landed).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ _tag: "StorageFailure", operation: "session.locked" })
    expect(landed[0]?.kind).toBe("committed")
    expect(await treePaths(root, "main")).toContain("areas/inbox/new.html")
    expect(await fileAt(root, "main", "areas/inbox/new.html")).toBe(html)
    expect((await run(resumeSession({ root, id: "same" }))).ops).toEqual([])
  })

  it("a checked-out ref follows the commit even beside an unrelated uncommitted edit", async () => {
    const { root, head } = await seeded()
    const edited = `${ALPHA}<!-- local edit -->\n`
    await writeFile(join(root, "areas/inbox/alpha.html"), edited, "utf8")
    const other = memory("Other", "Another fact.")
    const session = await start(root, "dirty", head, [putOp("areas/inbox/other.html", other)])
    const outcome = await run(commitSession({ session, head, message: "dirty" }))
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    expect(outcome.worktreeSynced).toBe(true)
    expect(await commitOf(root, "refs/heads/main")).toBe(outcome.sha)
    // The session's file reached the working tree, the human's edit is untouched, and git reports
    // exactly that edit: no staged deletion of the session's file for a `git commit -a` to land.
    expect(await readFile(join(root, "areas/inbox/other.html"), "utf8")).toBe(other)
    expect(await readFile(join(root, "areas/inbox/alpha.html"), "utf8")).toBe(edited)
    // (The helper trims stdout, so the leading unstaged-column space is gone.)
    expect(await git(root, ["status", "--porcelain"])).toBe("M areas/inbox/alpha.html")
    await git(root, ["commit", "-q", "-am", "human edit"])
    expect(await treePaths(root, "main")).toContain("areas/inbox/other.html")
  })

  it("refuses to move a checked-out ref over a session path the checkout holds uncommitted", async () => {
    const { root, base, head } = await seeded()
    // An untracked file at the very path the session puts, and a modified file at the one it archives.
    await mkdir(join(root, "areas/inbox"), { recursive: true })
    await writeFile(join(root, "areas/inbox/new.html"), "<!-- a draft -->\n", "utf8")
    await writeFile(join(root, "areas/inbox/alpha.html"), `${ALPHA}<!-- edit -->\n`, "utf8")
    const session = await run(
      startSession({ root, id: "clash", base: head }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [
            putOp("areas/inbox/new.html", memory("New", "A new fact.")),
            {
              kind: "archive",
              path: "areas/inbox/alpha.html",
              to: "archive/2026/areas/inbox/alpha.html",
              html: ALPHA
            }
          ])
        )
      )
    )
    const outcome = await run(commitSession({ session, head, message: "clash" }))
    expect(outcome).toEqual({
      kind: "worktree-dirty",
      paths: ["areas/inbox/alpha.html", "areas/inbox/new.html"]
    })
    // Nothing moved: not the ref, not the checkout, not the log.
    expect(await commitOf(root, "refs/heads/main")).toBe(base)
    expect(await readFile(join(root, "areas/inbox/new.html"), "utf8")).toBe("<!-- a draft -->\n")
    await expect(commitOf(root, sessionRef("clash"))).rejects.toThrow()
    const resumed = await run(resumeSession({ root, id: "clash" }))
    expect(resumed.ops).toHaveLength(2)
    expect(resumed.pending).toBeUndefined()
  })

  it("a blocked provenance ref does not fail a commit that landed", async () => {
    const { root, head } = await seeded()
    // A ref UNDER the session's provenance name makes that name unwritable (directory/file clash).
    await git(root, ["update-ref", `${sessionRef("prov-blocked")}/child`, head.sha])
    const session = await start(root, "prov-blocked", head, [
      putOp("areas/inbox/pb.html", memory("PB", "Provenance is a best effort."))
    ])
    const outcome = await run(commitSession({ session, head, message: "pb" }))
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed") return
    expect(await commitOf(root, "refs/heads/main")).toBe(outcome.sha)
    await expect(commitOf(root, sessionRef("prov-blocked"))).rejects.toThrow()
    expect((await run(resumeSession({ root, id: "prov-blocked" }))).baseSha).toBe(outcome.sha)
  })

  it("creates a curator ref that does not exist yet", async () => {
    const { root, base, head } = await seeded()
    const ref = "refs/heads/curate/2026-09-23"
    const session = await run(
      startSession({ root, id: "cur", base: head, ref }).pipe(
        Effect.flatMap((s) =>
          appendOps(s, [putOp("areas/inbox/cur.html", memory("Cur", "Curated."))])
        )
      )
    )
    const outcome = await run(commitSession({ session, head, message: "curate" }))
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    expect(await commitOf(root, ref)).toBe(outcome.sha)
    expect(await git(root, ["rev-parse", `${outcome.sha}^`])).toBe(base)
    expect(await commitOf(root, "refs/heads/main")).toBe(base)
    // HEAD is main, not the curator ref: nothing to follow, and the checkout is untouched.
    expect(outcome.worktreeSynced).toBe(false)
    await expect(stat(join(root, "areas/inbox/cur.html"))).rejects.toThrow()
    expect(await git(root, ["status", "--porcelain"])).toBe("")
  })
})
