import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { Bash, type IFileSystem, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from "just-bash"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  CORPUS_SNAPSHOT_TMPDIR_PREFIX,
  decodeSandboxMounts,
  encodeSandboxMounts,
  mountReadOnlyRoots,
  pinCorpusSnapshot,
  readOnlyRootsProblem,
  SANDBOX_MOUNTS_ENV,
  SandboxMountInvalid
} from "../src/mount.js"

/**
 * The mount tier: does the composition put a host directory where a caller can read it, and does
 * read-only mean read-only?
 *
 * Real directories and a real `just-bash`, no mock. The whole subject is how two filesystem
 * implementations compose their path prefixes, and a mocked filesystem would compose the mock's.
 *
 * **Every path assertion below reads a FILE's CONTENT at an exact path, and that is the design.** The
 * `mountPoint` bug this guards against does not change how many files are visible — all three
 * spellings expose the same tree, at three different prefixes — so a count assertion passes under
 * every one of them. The case named "proves a file COUNT cannot distinguish the three mountPoint
 * spellings" demonstrates that rather than leaving it as a claim in prose.
 */

const run = promisify(execFile)

let host: string
let corpus: string
let traces: string

beforeAll(async () => {
  host = await mkdtemp(join(tmpdir(), "consolidator-mount-"))
  corpus = join(host, "corpus")
  traces = join(host, "traces")
  await mkdir(join(corpus, "areas"), { recursive: true })
  await mkdir(traces, { recursive: true })
  await writeFile(join(corpus, "areas", "a.html"), "<article><p><mark>alpha</mark></p></article>")
  await writeFile(join(corpus, "root.html"), "<article><p><mark>root</mark></p></article>")
  await writeFile(join(traces, "s1.jsonl"), '{"type":"user"}\n')
  /**
   * Over `OverlayFs`'s 10 MB default read cap, which is the whole subject of the read-cap case below.
   * A real transcript is one JSON record per line and the fixture keeps that shape, because a
   * command reads whole lines.
   */
  await writeFile(join(traces, "big.jsonl"), `{"text":"${"z".repeat(11 * 1024 * 1024)}"}\n`)
})

afterAll(async () => {
  await rm(host, { recursive: true, force: true })
})

/** Read a guest path, returning `null` on any failure so a test can assert absence. */
const readGuest = async (filesystem: IFileSystem, path: string): Promise<string | null> => {
  try {
    return String(await filesystem.readFile(path, "utf8"))
  } catch {
    return null
  }
}

describe("the mount resolves at the path a caller would write", () => {
  it("puts a host file at <mountPath>/<relative path>", async () => {
    const { filesystem } = mountReadOnlyRoots({
      roots: [{ mountPath: "/mnt/memhtml", hostPath: corpus }]
    })
    expect(await readGuest(filesystem, "/mnt/memhtml/areas/a.html")).toContain("alpha")
    expect(await readGuest(filesystem, "/mnt/memhtml/root.html")).toContain("root")
  })

  /**
   * Multiple roots side by side, each answering only its own paths. The consolidator passes three and
   * `memhtml exec` passes one, so "several roots do not bleed into each other" is a property both rest on.
   */
  it("keeps sibling roots separate", async () => {
    const { filesystem } = mountReadOnlyRoots({
      roots: [
        { mountPath: "/mnt/memhtml", hostPath: corpus },
        { mountPath: "/mnt/traces", hostPath: traces }
      ]
    })
    expect(await readGuest(filesystem, "/mnt/memhtml/root.html")).toContain("root")
    expect(await readGuest(filesystem, "/mnt/traces/s1.jsonl")).toContain("user")
    // Neither root answers the other's path, which is what "separate" has to mean.
    expect(await readGuest(filesystem, "/mnt/memhtml/s1.jsonl")).toBeNull()
    expect(await readGuest(filesystem, "/mnt/traces/root.html")).toBeNull()
  })

  /**
   * The measurement that makes the path assertions above load-bearing rather than incidental.
   *
   * Three `mountPoint` spellings on the nested overlay, hand-composed here because
   * `mountReadOnlyRoots` deliberately offers no way to get the two broken ones. Each resolves the
   * SAME host file at a DIFFERENT guest path — and `find`'s file count is identical across all three,
   * which is why the helper's own tests read paths.
   *
   * (Mutation: changing `mountPoint: "/"` to `mountPoint: root.mountPath` in `mountReadOnlyRoots`
   * fails every path assertion in this file and changes no count in this case.)
   */
  it("proves a file COUNT cannot distinguish the three mountPoint spellings", async () => {
    const spellings: ReadonlyArray<readonly [string, string | undefined, string]> = [
      ["root", "/", "/mnt/memhtml/areas/a.html"],
      ["omitted", undefined, "/mnt/memhtml/home/user/project/areas/a.html"],
      ["mount path", "/mnt/memhtml", "/mnt/memhtml/mnt/memhtml/areas/a.html"]
    ]
    const counts: string[] = []
    for (const [label, mountPoint, expectedPath] of spellings) {
      const filesystem = new MountableFs()
      filesystem.mount(
        "/mnt/memhtml",
        new OverlayFs({
          root: corpus,
          readOnly: true,
          ...(mountPoint === undefined ? {} : { mountPoint })
        })
      )
      // The file is reachable at exactly one of the three prefixes, and it is a different one each
      // time. `label` rides into the assertion message so a failure names the spelling that broke.
      expect(await readGuest(filesystem, expectedPath), label).toContain("alpha")
      const found = await new Bash({ fs: filesystem }).exec(
        "find /mnt/memhtml -name '*.html' | wc -l"
      )
      counts.push(String(found.stdout).trim())
    }
    // The whole point: identical counts, three different working paths.
    expect(counts).toEqual(["2", "2", "2"])
  })
})

describe("read-only is enforced, not declared", () => {
  /**
   * (Mutation: dropping `readOnly: true` in `mountReadOnlyRoots` makes this write SUCCEED and the
   * assertion fail. The write goes to the overlay's copy-on-write memory layer, not to disk, so a
   * regression here would not be visible on the host — which is exactly why the guard asserts the
   * refusal rather than checking the host file afterwards.)
   */
  it("refuses a write through the composed filesystem with EROFS", async () => {
    const { filesystem } = mountReadOnlyRoots({
      roots: [{ mountPath: "/mnt/memhtml", hostPath: corpus }]
    })
    await expect(filesystem.writeFile("/mnt/memhtml/pwn.html", "x")).rejects.toThrow(/EROFS/)
  })

  /**
   * The read cap, which is a CORRECTNESS property rather than a limit: unset, `OverlayFs` throws
   * `EFBIG` past 10 MB and just-bash reports that to a command as "No such file or directory", so an
   * oversized transcript looks absent instead of unreadable — and the consolidator's instructions
   * tell the agent to drop a session whose transcript it cannot open. Measured 2026-09-03 on an
   * 11.5 MB transcript: `ls -la` printed its size while `grep -c -F` said the file did not exist.
   *
   * The first assertion is the REPRODUCTION against a default-capped overlay, so the second cannot
   * pass vacuously; both drive the installed just-bash rather than a description of it.
   *
   * (Mutation: dropping `maxFileReadSize` from `mountReadOnlyRoots` makes the second block report the
   * same "No such file" as the first.)
   */
  it("reads a file past the 10 MB default cap, which an uncapped overlay reports as missing", async () => {
    const guestPath = "/mnt/traces/big.jsonl"
    const uncapped = new MountableFs({ base: new InMemoryFs() })
    uncapped.mount("/mnt/traces", new OverlayFs({ root: traces, mountPoint: "/", readOnly: true }))
    const missed = await new Bash({ fs: uncapped }).exec(`grep -c -F zzz ${guestPath}`)
    expect(missed.exitCode).not.toBe(0)
    expect(missed.stderr).toContain("No such file or directory")

    const { filesystem } = mountReadOnlyRoots({
      roots: [{ mountPath: "/mnt/traces", hostPath: traces }]
    })
    const found = await new Bash({ fs: filesystem }).exec(`grep -c -F zzz ${guestPath}`)
    expect(found.exitCode).toBe(0)
    expect(found.stdout.trim()).toBe("1")
  })

  it("refuses a write from inside bash", async () => {
    const { filesystem } = mountReadOnlyRoots({
      roots: [{ mountPath: "/mnt/memhtml", hostPath: corpus }]
    })
    await expect(
      new Bash({ fs: filesystem }).exec("echo x > /mnt/memhtml/pwn.html")
    ).rejects.toThrow(/EROFS/)
  })

  /** Confinement: neither a relative escape nor an absolute host path reaches outside the root. */
  it("confines reads to the mounted root", async () => {
    const { filesystem } = mountReadOnlyRoots({
      roots: [{ mountPath: "/mnt/memhtml", hostPath: corpus }]
    })
    expect(await readGuest(filesystem, "/mnt/memhtml/../../../etc/hostname")).toBeNull()
    expect(await readGuest(filesystem, "/etc/hostname")).toBeNull()
    // A `..` that stays inside the root is fine, so the rule is confinement rather than a ban on dots.
    expect(await readGuest(filesystem, "/mnt/memhtml/areas/../root.html")).toContain("root")
  })

  /**
   * A symlink under a mounted root is NOT followed, because `OverlayFs.allowSymlinks` defaults to
   * false. Asserted rather than assumed because it costs real reachability: `~/.claude/skills/*`
   * carries symlinks to directories outside the trace root, and those files read as absent in the
   * sandbox. A future edit that passed `allowSymlinks: true` to gain them would also gain a read path
   * out of the root, and this is where that trade shows up.
   */
  it("does not follow a symlink out of the root, and says so by failing the read", async () => {
    const outside = await mkdtemp(join(tmpdir(), "consolidator-outside-"))
    try {
      await writeFile(join(outside, "secret.txt"), "not-for-the-sandbox")
      await symlink(join(outside, "secret.txt"), join(corpus, "linked.txt"))
      const { filesystem } = mountReadOnlyRoots({
        roots: [{ mountPath: "/mnt/memhtml", hostPath: corpus }]
      })
      // Listed by the directory read, and unreadable — the two together are the actual behavior.
      expect(await filesystem.readdir("/mnt/memhtml")).toContain("linked.txt")
      expect(await readGuest(filesystem, "/mnt/memhtml/linked.txt")).toBeNull()
    } finally {
      await rm(join(corpus, "linked.txt"), { force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("the base filesystem keeps its own paths", () => {
  /**
   * eve's contract for the `filesystem` factory: the returned filesystem must preserve eve-owned
   * paths such as `/workspace` (node_modules/eve/dist/src/public/sandbox/just-bash-sandbox.d.ts). The
   * base is exercised as the same `ReadWriteFs` shape eve constructs, so what passes here is what the
   * factory returns in a live session.
   *
   * (Mutation: mounting a root at `/` — which `readOnlyRootsProblem` refuses — is the shape that
   * would break this, since it would shadow the base entirely.)
   */
  it("leaves /workspace writable under the mounts", async () => {
    const workspaceHost = await mkdtemp(join(tmpdir(), "consolidator-ws-"))
    try {
      const base = new ReadWriteFs({ allowSymlinks: true, root: workspaceHost })
      const { filesystem } = mountReadOnlyRoots({
        roots: [{ mountPath: "/mnt/memhtml", hostPath: corpus }],
        base
      })
      await filesystem.mkdir("/workspace", { recursive: true })
      await filesystem.writeFile("/workspace/notes.txt", "written")
      expect(await readGuest(filesystem, "/workspace/notes.txt")).toBe("written")
      // And the read-only mount is still read-only beside it.
      expect(await readGuest(filesystem, "/mnt/memhtml/root.html")).toContain("root")
      await expect(filesystem.writeFile("/mnt/memhtml/x.html", "x")).rejects.toThrow(/EROFS/)
    } finally {
      await rm(workspaceHost, { recursive: true, force: true })
    }
  })
})

describe("roots are validated before anything is spawned", () => {
  /**
   * The reason this is eager: eve does NOT invoke the `filesystem` factory during template
   * prewarming, so an unvalidated bad root surfaces on the first LIVE session — inside a sleep run
   * that has already committed earlier phases.
   */
  it("rejects a host path that does not exist", () => {
    const problem = readOnlyRootsProblem([
      { mountPath: "/mnt/memhtml", hostPath: join(host, "definitely-absent") }
    ])
    expect(problem).not.toBeNull()
    expect(problem).toContain("definitely-absent")
  })

  it("rejects a host path that is a file rather than a directory", () => {
    const problem = readOnlyRootsProblem([
      { mountPath: "/mnt/memhtml", hostPath: join(corpus, "root.html") }
    ])
    expect(problem).toContain("not a directory")
  })

  it("rejects a relative or unnormalized mount path", () => {
    expect(readOnlyRootsProblem([{ mountPath: "mnt/memhtml", hostPath: corpus }])).toContain(
      "absolute, normalized"
    )
    expect(readOnlyRootsProblem([{ mountPath: "/mnt/memhtml/", hostPath: corpus }])).toContain(
      "absolute, normalized"
    )
  })

  it("rejects mounting at the root the base filesystem owns", () => {
    expect(readOnlyRootsProblem([{ mountPath: "/", hostPath: corpus }])).toContain("not mountable")
  })

  /** `MountableFs.mount` throws on both of these; catching them here names the pair of paths. */
  it("rejects duplicate and nested mount paths", () => {
    expect(
      readOnlyRootsProblem([
        { mountPath: "/mnt/memhtml", hostPath: corpus },
        { mountPath: "/mnt/memhtml", hostPath: traces }
      ])
    ).toContain("twice")
    expect(
      readOnlyRootsProblem([
        { mountPath: "/mnt/memhtml", hostPath: corpus },
        { mountPath: "/mnt/memhtml/inner", hostPath: traces }
      ])
    ).toContain("nest")
  })

  it("accepts the shape the consolidator passes", () => {
    expect(
      readOnlyRootsProblem([
        { mountPath: "/mnt/traces", hostPath: traces },
        { mountPath: "/mnt/memhtml", hostPath: corpus }
      ])
    ).toBeNull()
  })

  it("throws SandboxMountInvalid rather than composing a bad filesystem", () => {
    expect(() =>
      mountReadOnlyRoots({ roots: [{ mountPath: "/mnt/memhtml", hostPath: join(host, "absent") }] })
    ).toThrow(SandboxMountInvalid)
  })
})

describe("roots cross the process boundary intact", () => {
  /**
   * The factory runs in the eve SERVER while the roots are chosen by the CLIENT that spawned it, so
   * this round trip is the actual channel, not a serialization convenience.
   */
  it("round-trips through the environment in order", () => {
    const roots = [
      { mountPath: "/mnt/traces", hostPath: traces },
      { mountPath: "/mnt/memhtml", hostPath: corpus }
    ]
    const decoded = decodeSandboxMounts({ [SANDBOX_MOUNTS_ENV]: encodeSandboxMounts(roots) })
    expect(decoded).toEqual(roots)
  })

  it("reads an absent or blank variable as no mounts", () => {
    expect(decodeSandboxMounts({})).toEqual([])
    expect(decodeSandboxMounts({ [SANDBOX_MOUNTS_ENV]: "  " })).toEqual([])
  })

  /**
   * A present-but-broken variable THROWS, and the split from the absent case is the guard.
   *
   * Absent means "this sandbox mounts nothing", which is a real configuration. Malformed means the
   * spawner meant to mount something and this process would otherwise run without it — and an agent
   * whose corpus quietly went missing answers questions about an empty corpus, which reads as a
   * finding about the data rather than as a broken mount.
   *
   * (Mutation: making `decodeSandboxMounts` return `[]` on a parse failure instead of throwing passes
   * the absent cases above and fails all four below.)
   */
  it("REFUSES a malformed variable instead of silently mounting nothing", () => {
    expect(() => decodeSandboxMounts({ [SANDBOX_MOUNTS_ENV]: "{not json" })).toThrow(
      SandboxMountInvalid
    )
    expect(() =>
      decodeSandboxMounts({ [SANDBOX_MOUNTS_ENV]: '{"mountPath":"/mnt/memhtml"}' })
    ).toThrow(SandboxMountInvalid)
    expect(() => decodeSandboxMounts({ [SANDBOX_MOUNTS_ENV]: "[null]" })).toThrow(
      SandboxMountInvalid
    )
    expect(() =>
      decodeSandboxMounts({ [SANDBOX_MOUNTS_ENV]: '[{"mountPath":"/mnt/memhtml"}]' })
    ).toThrow(SandboxMountInvalid)
  })

  /** A root that decodes cleanly but names a vanished directory is still refused on the way in. */
  it("re-validates on decode, so a stale root cannot reach a mount", () => {
    const stale = JSON.stringify([{ mountPath: "/mnt/memhtml", hostPath: join(host, "vanished") }])
    expect(() => decodeSandboxMounts({ [SANDBOX_MOUNTS_ENV]: stale })).toThrow(SandboxMountInvalid)
  })

  it("refuses to encode a root it would refuse to decode", () => {
    expect(() => encodeSandboxMounts([{ mountPath: "relative", hostPath: corpus }])).toThrow(
      SandboxMountInvalid
    )
  })
})

describe("the corpus snapshot is pinned, not live", () => {
  /**
   * The defect this exists for: a sleep run checks out its own branch in the LIVE working tree
   * (`packages/sleep/src/run.ts:96`) and earlier phases commit onto it, so a mount of the live
   * directory changes underneath the session reading it. Asserted as a difference, not as a mechanism:
   * the snapshot is taken, then the live tree is changed, then the snapshot is read and still shows
   * the old content.
   *
   * (Mutation: replacing `pinCorpusSnapshot`'s worktree with `hostPath: input.repoRoot` — mounting the
   * live tree — fails the two assertions after the commit below, and nothing else in this file.)
   */
  it("keeps showing baseSha's content after the live tree moves on", async () => {
    const repo = await mkdtemp(join(tmpdir(), "consolidator-repo-"))
    let snapshot: Awaited<ReturnType<typeof pinCorpusSnapshot>> | null = null
    try {
      const git = (...args: string[]) => run("git", ["-C", repo, ...args])
      await git("init", "--initial-branch=main")
      await git("config", "user.email", "t@example.com")
      await git("config", "user.name", "t")
      await writeFile(join(repo, "note.html"), "<mark>original</mark>")
      await git("add", "note.html")
      await git("commit", "-m", "base")
      const baseSha = (await git("rev-parse", "HEAD")).stdout.trim()

      snapshot = await pinCorpusSnapshot({ repoRoot: repo, sha: baseSha })

      // What a later sleep phase does to the live tree, mid-session.
      await git("checkout", "-b", "sleep/2026-08-09")
      await writeFile(join(repo, "note.html"), "<mark>rewritten by a later phase</mark>")
      await git("commit", "-am", "a later phase")

      const { filesystem } = mountReadOnlyRoots({
        roots: [{ mountPath: "/mnt/memhtml", hostPath: snapshot.hostPath }]
      })
      const seen = await readGuest(filesystem, "/mnt/memhtml/note.html")
      expect(seen).toContain("original")
      expect(seen).not.toContain("rewritten")
    } finally {
      await snapshot?.release()
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("releases the worktree, and tolerates a second release", async () => {
    const repo = await mkdtemp(join(tmpdir(), "consolidator-repo-rel-"))
    try {
      const git = (...args: string[]) => run("git", ["-C", repo, ...args])
      await git("init", "--initial-branch=main")
      await git("config", "user.email", "t@example.com")
      await git("config", "user.name", "t")
      await writeFile(join(repo, "a.html"), "<mark>a</mark>")
      await git("add", "a.html")
      await git("commit", "-m", "base")
      const sha = (await git("rev-parse", "HEAD")).stdout.trim()

      const snapshot = await pinCorpusSnapshot({ repoRoot: repo, sha })
      expect((await git("worktree", "list")).stdout).toContain(snapshot.hostPath)
      await snapshot.release()
      await snapshot.release()
      expect((await git("worktree", "list")).stdout).not.toContain(snapshot.hostPath)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /**
   * The mkdtemp PARENT goes with the worktree, and it is a second step: `git worktree remove` deletes
   * only the tree it was handed, so a release that stopped there leaves an empty
   * `memhtml-corpus-snapshot-*` directory in `tmpdir()` on the CLEAN path — every `memhtml exec`, with
   * nothing failing and nothing to look at.
   *
   * The census across two cycles is what makes it a leak assertion rather than a path assertion: the
   * name is a random suffix, and one-per-run is exactly what an unswept prefix looks like.
   *
   * (Mutation: dropping the `rm(parent)` from `release` leaves both parents and fails the count.)
   */
  it("removes the temp parent it created, not only the worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "consolidator-repo-parent-"))
    const countSnapshots = async (): Promise<number> =>
      (await readdir(tmpdir())).filter((name) => name.startsWith(CORPUS_SNAPSHOT_TMPDIR_PREFIX))
        .length
    try {
      const git = (...args: string[]) => run("git", ["-C", repo, ...args])
      await git("init", "--initial-branch=main")
      await git("config", "user.email", "t@example.com")
      await git("config", "user.name", "t")
      await writeFile(join(repo, "a.html"), "<mark>a</mark>")
      await git("add", "a.html")
      await git("commit", "-m", "base")
      const sha = (await git("rev-parse", "HEAD")).stdout.trim()

      const before = await countSnapshots()
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const snapshot = await pinCorpusSnapshot({ repoRoot: repo, sha })
        const parent = dirname(snapshot.hostPath)
        // The prefix is the one the sweep in `client.ts` matches; a mkdtemp under any other name would
        // be unreachable by it.
        expect(parent.startsWith(join(tmpdir(), CORPUS_SNAPSHOT_TMPDIR_PREFIX))).toBe(true)
        await snapshot.release()
        expect(existsSync(parent)).toBe(false)
      }
      expect(await countSnapshots()).toBe(before)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("the environment cannot re-aim the snapshot at another repository", () => {
  /**
   * The same hazard `packages/store/src/git.ts` scrubs at `GIT_REPO_SELECTION_ENV`: git exports an
   * absolute `GIT_DIR` into hook processes run from a linked worktree, every descendant inherits
   * it, and a `git worktree add -C <corpus>` inheriting it would materialize a snapshot of the
   * HOOK's repository — or fail on a sha that repository does not hold. The corpus named by
   * `repoRoot` must win.
   *
   * (Mutation: dropping the `delete` loop from `gitChildEnv` in `mount.ts` makes the pin fail —
   * the declared repo holds the sha and the environment-named one does not.)
   */
  it("pins the declared repo's sha even when GIT_DIR names another repo", async () => {
    const corpus = await mkdtemp(join(tmpdir(), "consolidator-repo-envaim-a-"))
    const other = await mkdtemp(join(tmpdir(), "consolidator-repo-envaim-b-"))
    const saved = new Map<string, string | undefined>()
    let snapshot: Awaited<ReturnType<typeof pinCorpusSnapshot>> | undefined
    try {
      for (const repo of [corpus, other]) {
        const git = (...args: string[]) => run("git", ["-C", repo, ...args])
        await git("init", "--initial-branch=main")
        await git("config", "user.email", "t@example.com")
        await git("config", "user.name", "t")
        await writeFile(join(repo, "who.html"), `<mark>${repo}</mark>`)
        await git("add", "who.html")
        await git("commit", "-m", "base")
      }
      const sha = (await run("git", ["-C", corpus, "rev-parse", "HEAD"])).stdout.trim()

      for (const [name, value] of [
        ["GIT_DIR", join(other, ".git")],
        ["GIT_WORK_TREE", other],
        ["GIT_INDEX_FILE", join(other, ".git", "index")]
      ] as const) {
        saved.set(name, process.env[name])
        process.env[name] = value
      }

      snapshot = await pinCorpusSnapshot({ repoRoot: corpus, sha })
      const pinned = (await run("cat", [join(snapshot.hostPath, "who.html")])).stdout
      expect(pinned).toContain(corpus)
      expect(pinned).not.toContain(other)
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await snapshot?.release()
      await rm(corpus, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })

  /**
   * The scrub list is restated here because this package cannot import `@memhtml/store`; this is
   * the assertion that pins the two spellings to each other, so a variable added to one side
   * cannot silently stay inheritable on the other.
   */
  it("scrubs the same variable set the store scrubs", async () => {
    const { GIT_REPO_SELECTION_ENV } = await import("../src/mount.js")
    const storeSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dirname("."), "..", "..", "packages", "store", "src", "git.ts"), "utf8")
    )
    const literal = /GIT_REPO_SELECTION_ENV: ReadonlyArray<string> = \[([^\]]+)\]/.exec(storeSource)
    expect(literal).not.toBeNull()
    const storeNames = [...(literal?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1])
    expect([...GIT_REPO_SELECTION_ENV]).toEqual(storeNames)
  })
})
