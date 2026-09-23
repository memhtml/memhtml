import { execFileSync } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { commitMessage, commitSession, commitSubject } from "../src/commit.js"
import {
  appendOps,
  rebaseSession,
  resumeSession,
  sessionRef,
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
 * The six-step commit algorithm against real temp repos.
 *
 * Mutation notes, one per guard, each run once with the change applied and the named test red:
 * - step 1: `if (violations.length > 0)` -> `if (false)` -> "refuses ... and writes nothing".
 * - step 2: `overlapping.length > 0` -> `false` -> "same path: rebase-needed, then refused".
 * - step 3: drop the `addLink(linked, "contradicts", ...)` call -> "frame-key conflict ...".
 * - step 4: drop `updateIndexRemove` -> "archives through the index ..." (source still in tree).
 * - step 4: `archiveBody` returns `html` unchanged -> same test (stamps missing).
 * - step 5: treat `raced` as `updated` -> "ref race between validation and update".
 * - step 5: drop the `sessionRef` update -> "sets refs/memhtml/sessions/<id>".
 * - step 6: `worktreeEligible` ignores `worktreeStatus` -> "leaves a dirty working tree alone".
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
  it("lands a put on main, stamps the trailer, clears the log, and leaves the working tree alone", async () => {
    const { root, base, head } = await seeded()
    const html = memory("Beta", "Beta is the second letter of the Greek alphabet.")
    const session = await start(root, "s1", head, [putOp("areas/inbox/beta.html", html)])
    const outcome = await run(commitSession({ session, head, message: "add beta" }))
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed") return
    expect(outcome.paths).toEqual(["areas/inbox/beta.html"])
    expect(outcome.contradictions).toEqual([])
    expect(outcome.worktreeSynced).toBe(false)
    expect(await commitOf(root, "refs/heads/main")).toBe(outcome.sha)
    expect(await git(root, ["rev-parse", `${outcome.sha}^`])).toBe(base)
    expect(await fileAt(root, outcome.sha, "areas/inbox/beta.html")).toBe(html)
    expect(
      await git(root, ["log", "-1", "--format=%s%n%(trailers:key=Memhtml-Session)", outcome.sha])
    ).toBe("memhtml(session): add beta\nMemhtml-Session: s1")
    // Not through the working tree: the file is in the commit and not on disk.
    await expect(stat(join(root, "areas/inbox/beta.html"))).rejects.toThrow()
    const resumed = await run(resumeSession({ root, id: "s1" }))
    expect(resumed.ops).toEqual([])
    expect(resumed.baseSha).toBe(outcome.sha)
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

  it("two sessions on one base committing disjoint files both land", async () => {
    const { root, base, head } = await seeded()
    const s1 = await start(root, "one", head, [
      putOp("areas/inbox/one.html", memory("One", "One."))
    ])
    const s2 = await start(root, "two", head, [
      putOp("areas/inbox/two.html", memory("Two", "Two."))
    ])
    const first = await run(commitSession({ session: s1, head, message: "one" }))
    expect(first.kind).toBe("committed")
    // The second sees main moved, finds no overlap, and commits on top without a rebase.
    const second = await run(commitSession({ session: s2, head, message: "two" }))
    expect(second.kind).toBe("committed")
    if (second.kind !== "committed" || first.kind !== "committed") return
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
    expect(await readFile(join(root, "areas/inbox/alpha.html"), "utf8")).toBe(ALPHA)
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
    // The session keeps its ops for the retry.
    expect((await run(resumeSession({ root, id: "race" }))).ops).toHaveLength(1)
  })

  it("syncWorktree moves a clean checkout of the ref to the new commit", async () => {
    const { root, head } = await seeded()
    const html = memory("Synced", "This file reaches the working tree.")
    const session = await start(root, "sync", head, [putOp("areas/inbox/synced.html", html)])
    const outcome = await run(commitSession({ session, head, message: "sync", syncWorktree: true }))
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    expect(outcome.worktreeSynced).toBe(true)
    expect(await readFile(join(root, "areas/inbox/synced.html"), "utf8")).toBe(html)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
  })

  it("leaves a dirty working tree alone and reports worktreeSynced false", async () => {
    const { root, head } = await seeded()
    await writeFile(join(root, "areas/inbox/alpha.html"), `${ALPHA}<!-- local edit -->\n`, "utf8")
    const session = await start(root, "dirty", head, [
      putOp("areas/inbox/other.html", memory("Other", "Another fact."))
    ])
    const outcome = await run(
      commitSession({ session, head, message: "dirty", syncWorktree: true })
    )
    if (outcome.kind !== "committed") throw new Error(outcome.kind)
    expect(outcome.worktreeSynced).toBe(false)
    expect(await commitOf(root, "refs/heads/main")).toBe(outcome.sha)
    await expect(stat(join(root, "areas/inbox/other.html"))).rejects.toThrow()
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
  })
})
