import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Result } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { guestPathFor, makeConsolidator } from "../src/client.js"
import { type ConsolidatorError, ConsolidatorUnavailable } from "../src/contract.js"
import { CORPUS_SNAPSHOT_TMPDIR_PREFIX } from "../src/mount.js"

/**
 * The seeding tier: transcripts reach the sandbox through a READ-ONLY MOUNT, and a transcript that
 * does not resolve there is never reported as analyzed.
 *
 * ## What this suite replaced, and why the old one had to go
 *
 * It supersedes `tail-cap.test.ts`, which tested a positional tail reader that no longer exists. That
 * reader was there because the client SENT transcript bytes — as `clientContext`, which eve renders as
 * one user-role model context message (node_modules/eve/dist/src/client/types.d.ts:83-88) — so a
 * per-file byte cap was the only thing bounding what entered the model's context. Nothing is sent now,
 * so there is no cap to test and the hazards moved: they are about which paths RESOLVE inside the
 * composed mount, which is what every case below is about.
 *
 * ## Credential-free and server-free, deliberately
 *
 * Every case drives a real run against a bogus `appRoot`, so `eve start` cannot succeed and the run
 * dies at the spawn — which is exactly the observable that separates "the batch was unreachable" from
 * "the batch was fine and the server was not there". Two DIFFERENT `ConsolidatorUnavailable` reasons,
 * and reading the reason rather than the tag is what makes these cases non-vacuous. CI has no
 * credentials and none is needed past the injected env.
 *
 * Real files and real symlinks in a temp dir, because the subject is how `OverlayFs` resolves a guest
 * path against a host root, and a mocked filesystem would test the mock.
 */

const clientSource = (): Promise<string> =>
  readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "client.ts"), "utf8")

/**
 * Strip comments, so a text assertion is about CODE and not about prose.
 *
 * Load-bearing here beyond tidiness: `client.ts` documents the `clientContext` mechanism at length in
 * `manifestFor`'s comment, so a raw-text search for it passes over a file whose code is correct AND
 * over one whose code is broken. Same helper `start-port.test.ts` uses, for the same reason.
 */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

let host: string
let root: string
let outside: string
let projects: string

beforeAll(async () => {
  /**
   * `outside` is a SIBLING of the trace root, not a child of it. That placement is the fixture's whole
   * content for the containment case — an "outside" directory nested under the mounted root is inside
   * it, so the case would assert nothing and would pass against a client with no containment check at
   * all. (It did, once: the first version of this file put it at `join(root, "outside")` and the case
   * reached the spawn.)
   */
  host = await mkdtemp(join(tmpdir(), "consolidator-seeding-"))
  root = join(host, "trace-root")
  outside = join(host, "outside")
  projects = join(root, "projects", "-home-dev-checkout-api")
  await mkdir(projects, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(projects, "s1.jsonl"), `${JSON.stringify({ type: "user" })}\n`, "utf8")
  await writeFile(join(outside, "s-outside.jsonl"), `${JSON.stringify({ type: "user" })}\n`, "utf8")
  // A symlink INSIDE the root pointing at a real file, also inside it. `allowSymlinks` defaults to
  // false, so this is the case where the file exists, the link exists, and the read still fails.
  await symlink(join(projects, "s1.jsonl"), join(projects, "s-linked.jsonl"))
})

afterAll(async () => {
  await rm(host, { recursive: true, force: true })
})

/**
 * Run a consolidation to its failure and return the TYPED failure.
 *
 * The typed value, never a rendered cause: `String(cause)` renders `Cause([Fail(...)])` — the tag but
 * none of the payload — and every case here turns on the REASON, because the tag is the same whether
 * the batch was unreachable or the server was missing.
 */
const failureOf = async (input: {
  readonly transcripts: ReadonlyArray<{ sessionId: string; filePath: string }>
  readonly traceRoot?: string | undefined
}): Promise<ConsolidatorError> => {
  const consolidator = makeConsolidator({
    env: { AWS_BEARER_TOKEN_BEDROCK: "test" },
    appRoot: "/nonexistent/app/root",
    traceRoot: input.traceRoot ?? root
  })
  const result = await Effect.runPromise(
    Effect.result(consolidator.consolidate({ transcripts: input.transcripts }))
  )
  if (!Result.isFailure(result)) throw new Error("expected the run to fail")
  return result.failure
}

/** The reachable fixture: a real file under the mounted root. Gets a run as far as the spawn. */
const reachable = () => [{ sessionId: "s1", filePath: join(projects, "s1.jsonl") }]

describe("a transcript that does not resolve in the sandbox is not analyzed", () => {
  /**
   * The whole batch unreachable is the one case that must FAIL rather than proceed, and it must fail
   * without spawning: a server started to analyze nothing costs a process and a model call for an
   * answer already known.
   *
   * The reason names the trace root, because the operator action differs by cause — a stale
   * `MEMHTML_TRACE_ROOT` is a config fix while a pruned transcript is nothing to fix — and the root is the
   * datum that distinguishes them.
   */
  it("fails with ConsolidatorUnavailable when nothing resolves under the trace root", async () => {
    const failure = await failureOf({
      transcripts: [
        { sessionId: "gone-a", filePath: join(projects, "gone-a.jsonl") },
        { sessionId: "gone-b", filePath: join(projects, "gone-b.jsonl") }
      ]
    })
    expect(failure).toBeInstanceOf(ConsolidatorUnavailable)
    expect(failure.reason).toContain("resolve under the mounted trace root")
    expect(failure.reason).toContain(root)
  })

  /**
   * A file that EXISTS on the host but lies outside the mounted root is unreachable, and this is the
   * case a host `stat` cannot see: `s-outside.jsonl` is real and readable to this process, and no
   * mount covers it. It is the shape a stale `MEMHTML_TRACE_ROOT` takes — rows indexed from one root, a
   * client mounting another — and on the superseded seeding path it was INVISIBLE, because the client
   * read host paths directly and never needed a root at all.
   *
   * The END-TO-END assertion here is the weak one and is kept only as a composition check; the guard
   * that matters is `guestPathFor`'s, asserted directly in the suite below. Deleting the containment
   * arm SURVIVES this case — observed, not assumed: the escaped path fails its `stat` too, so the run
   * still ends unreachable with the same message. Reaching the failing observable meant testing the
   * pure function, where the escaped PATH itself is visible rather than only its consequence.
   */
  it("refuses a real host file that lies OUTSIDE the mounted root", async () => {
    const failure = await failureOf({
      transcripts: [{ sessionId: "s-outside", filePath: join(outside, "s-outside.jsonl") }]
    })
    expect(failure).toBeInstanceOf(ConsolidatorUnavailable)
    expect(failure.reason).toContain("resolve under the mounted trace root")
  })

  /**
   * A SYMLINK inside the root reads as absent, and this case exists because the measured behavior is
   * asymmetric in a way that would produce a false positive: `exists()` returns TRUE for the link
   * while `readFile`/`stat` fail with ENOENT (both probed 2026-08-09 against just-bash 3.2.0, since
   * `allowSymlinks` defaults to false).
   *
   * So a reachability check written with `exists` would report this session as analyzed, and the phase
   * would watermark a transcript nothing could open. `~/.claude/skills/*` really does hold such links.
   *
   * (Mutation: swapping the `stat` probe in `partitionReachable` for `exists` makes the linked session
   * reachable, the batch non-empty, and the run reach the spawn — so this case's reason assertion
   * fails while the tag assertion still passes.)
   */
  it("treats a symlinked transcript as unreachable, which `exists` alone would not", async () => {
    const failure = await failureOf({
      transcripts: [{ sessionId: "s-linked", filePath: join(projects, "s-linked.jsonl") }]
    })
    expect(failure).toBeInstanceOf(ConsolidatorUnavailable)
    expect(failure.reason).toContain("resolve under the mounted trace root")
  })

  /**
   * A DIRECTORY at a transcript's path is unreachable too. It resolves and it is not a file, which the
   * probe distinguishes — a check that only asked whether the path resolved would hand the model a
   * path that every read of it fails on.
   */
  it("refuses a path that resolves to a directory rather than a file", async () => {
    const failure = await failureOf({
      transcripts: [{ sessionId: "s-dir", filePath: projects }]
    })
    expect(failure).toBeInstanceOf(ConsolidatorUnavailable)
    expect(failure.reason).toContain("resolve under the mounted trace root")
  })

  /**
   * The NON-VACUITY CONTROL for every case above, and the case that makes them mean something.
   *
   * One reachable transcript beside two unreachable ones gets the run PAST the reachability gate and
   * into the spawn, where it dies for an unrelated reason. Same tag, DIFFERENT reason — and that
   * difference is the entire signal: it proves the unreachable siblings were skipped rather than fatal,
   * and that the cases above are reporting unreachability rather than a run that fails no matter what.
   */
  it("proceeds when ONE transcript resolves, skipping the siblings that do not", async () => {
    const failure = await failureOf({
      transcripts: [
        { sessionId: "gone-c", filePath: join(projects, "gone-c.jsonl") },
        { sessionId: "s-linked", filePath: join(projects, "s-linked.jsonl") },
        ...reachable()
      ]
    })
    expect(failure).toBeInstanceOf(ConsolidatorUnavailable)
    // NOT the unreachable reason: the run got past the gate.
    expect(failure.reason).not.toContain("resolve under the mounted trace root")
    // It died at the spawn instead, which is where an app root with no `.output/` fails.
    expect(failure.reason).toContain("eve start")
  })

  /**
   * A trace root that does not exist at all fails as unreachable rather than THROWING.
   *
   * `mountReadOnlyRoots` throws `SandboxMountInvalid` on a host path that is not a directory
   * (`OverlayFs`'s constructor checks eagerly — measured, see `mount.ts`), and a throw out of
   * `consolidate` would be a DEFECT rather than a typed failure: it travels past the `Effect.result`
   * the sleep phase wraps this call in, so INV-3 would break and a misconfigured root would fail the
   * night instead of degrading it.
   */
  it("reports a nonexistent trace root as a typed failure, not a defect", async () => {
    const failure = await failureOf({
      transcripts: reachable(),
      traceRoot: join(root, "no-such-root")
    })
    expect(failure).toBeInstanceOf(ConsolidatorUnavailable)
    expect(failure._tag).toBe("ConsolidatorUnavailable")
  })
})

describe("guestPathFor keeps a composed path inside the mount", () => {
  /**
   * The containment guard, tested where its FAILURE IS VISIBLE.
   *
   * ## The mechanism, measured rather than reasoned about
   *
   * `MountableFs` resolves `..` in a guest path BEFORE it decides which mount to route to, so enough
   * `../` segments climb out of the mount and land on the BASE filesystem. Probed 2026-08-09 against
   * just-bash 3.2.0 with a base holding `/workspace/secret.txt`: reading
   * `/mnt/traces/../../workspace/secret.txt` returned the base's content. In production that base is
   * eve's own `defaultFilesystem`, which owns `/workspace`, `/tmp`, and the home directory.
   *
   * So a `filePath` outside the trace root produces a `relative()` of `../../..`, and an unchecked
   * composition would put a path inside the AGENT'S OWN WORKSPACE into the manifest, labelled as a
   * transcript to analyze. Reachable through a stale `MEMHTML_TRACE_ROOT`, with nothing adversarial needed.
   *
   * ## Why not through `consolidate`
   *
   * Because the end-to-end route CANNOT see it. An escaped path fails its `stat` as well, so the run
   * ends unreachable either way and the aggregate failure message is identical — the mutation survives
   * there, which was observed before this suite existed. What distinguishes the two states is the
   * composed path itself, and this is the only place it is a value.
   *
   * (Mutation: dropping the `within.startsWith("..")` arm returns
   * `{ guestPath: "/mnt/traces/../../workspace/secret.txt" }` and fails the first case below on both
   * assertions. Dropping the trailing `includes("..")` belt-and-braces arm as well changes nothing
   * here, which is the honest reading of it: it guards a future edit to the arithmetic, not this one.)
   */
  const root = "/host/trace-root"

  it("REFUSES a path outside the root instead of composing one that escapes", () => {
    const escaped = guestPathFor({
      filePath: "/host/outside/s.jsonl",
      traceRoot: root,
      mountPath: "/mnt/traces"
    })
    expect("reason" in escaped).toBe(true)
    /**
     * And no `guestPath` at all, which the return SHAPE enforces — the two arms are disjoint, so there
     * is no state carrying both a reason and a usable path for a caller to read past.
     */
    expect("guestPath" in escaped).toBe(false)
  })

  it("refuses the root itself, an absolute-elsewhere path, and a relative one", () => {
    for (const filePath of [root, "/", "relative/s.jsonl"]) {
      const refused = guestPathFor({ filePath, traceRoot: root, mountPath: "/mnt/traces" })
      expect("reason" in refused, filePath).toBe(true)
    }
    // A non-absolute ROOT is refused too: it makes every `relative()` below it meaningless.
    expect(
      "reason" in
        guestPathFor({ filePath: "/a/b.jsonl", traceRoot: "rel", mountPath: "/mnt/traces" })
    ).toBe(true)
  })

  /**
   * The NON-VACUITY CONTROL. A refusing-everything implementation passes every case above, so a
   * contained path has to compose — and it has to compose to the EXACT string, since the mount prefix
   * plus the relative remainder is the arithmetic under test.
   */
  it("composes the exact guest path for a contained transcript", () => {
    const resolved = guestPathFor({
      filePath: `${root}/projects/-home-dev-api/s1.jsonl`,
      traceRoot: root,
      mountPath: "/mnt/traces"
    })
    expect(resolved).toEqual({ guestPath: "/mnt/traces/projects/-home-dev-api/s1.jsonl" })
  })

  /** Nested `..` INSIDE an otherwise contained path still resolves within the root, so it is fine. */
  it("accepts a path whose `..` segments cancel inside the root", () => {
    const resolved = guestPathFor({
      filePath: `${root}/projects/../projects/s1.jsonl`,
      traceRoot: root,
      mountPath: "/mnt/traces"
    })
    expect(resolved).toEqual({ guestPath: "/mnt/traces/projects/s1.jsonl" })
  })
})

describe("transcripts never enter the model's context", () => {
  /**
   * The regression guard for the security finding this whole change is, asserted as SOURCE SHAPE.
   *
   * It has to be a source assertion rather than a behavioral one, and that is a real limitation stated
   * plainly: the defect was that transcripts rode into the model's context as a `clientContext` payload,
   * and observing what did NOT enter a context requires a live model call. What is checkable without
   * one is that the client composes no such payload — there is no `clientContext` in it at all, and the
   * seeding turn that carried it is gone.
   *
   * Comments are stripped first, so the doc comment in `manifestFor` that EXPLAINS `clientContext` does
   * not satisfy the assertion. That is not hypothetical: the mechanism is documented at length in that
   * comment, so a text search over the raw file passes while the code is broken.
   *
   * (Mutation: adding `clientContext: { files: [] }` to the `sessions.create` call fails the first
   * assertion. Restoring the two-turn seeding shape — a create followed by `session.send` — fails the
   * single-turn assertion.)
   */
  it("composes no clientContext, and runs ONE turn rather than a seed plus an analysis", async () => {
    const code = codeOnly(await clientSource())
    expect(code).not.toContain("clientContext")
    /**
     * One `sessions.create` and no `session.send`. The second turn existed only to seed, so its absence
     * is what makes "the first model call reads the transcripts" true rather than aspirational.
     */
    expect(code).toContain("client.sessions.create(")
    expect(code).not.toMatch(/\.send\(/)
    // And no `write_file` instruction: the model is no longer asked to place its own input.
    expect(code).not.toContain("write_file")
  })

  /**
   * The transcripts reach the sandbox as a MOUNT, and the mount is composed from the constructor's
   * trace root. Both halves are asserted because either alone is satisfiable while broken: a client
   * that declared the mount path and passed no root would mount nothing, and one that passed a root to
   * something other than a mount would be the seeding path with extra steps.
   */
  it("mounts the trace root read-only at the guest path the instructions name", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain('const TRACES_MOUNT = "/mnt/traces"')
    expect(code).toMatch(/\{ mountPath: TRACES_MOUNT, hostPath: traceRoot \}/)
  })
})

describe("the watermark is bounded by the answer's read receipt", () => {
  /**
   * The rule itself — the receipt intersected with the reachable set, and never the batch — is
   * `watermarkableSessionIds`, tested as a pure function in `contract.test.ts`. What this tier owns
   * is the WIRING: `runTurn` must route `analyzedSessionIds` through the rule rather than assigning
   * the reachable set directly, because the reachable set is measured before the model runs and
   * proves nothing about reading. Asserted as code shape for the same reason the `clientContext`
   * case above is: the behavioral route needs a live model turn.
   *
   * (Mutation: restoring `analyzedSessionIds: readableIds` in `runTurn` fails both assertions.)
   */
  it("routes analyzedSessionIds through watermarkableSessionIds, never the raw reachable set", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain("watermarkableSessionIds(decoded.success, readableIds)")
    expect(code).not.toMatch(/analyzedSessionIds:\s*readableIds/)
  })

  /**
   * The breadth of the receipt is logged at the same place the watermark is decided, and the wiring is
   * asserted here for the same reason as above: the rule is pure and tested in `contract.test.ts`, while
   * reaching the log line behaviorally needs a live model turn. Without the call, a turn that read one
   * transcript of thirty-two watermarks all thirty-two and says nothing an operator can see.
   *
   * (Mutation: deleting the `underCitedWatermarkWarning` call from `runTurn` fails both assertions.)
   */
  it("logs the narrow-receipt warning beside the watermark it describes", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain("underCitedWatermarkWarning(decoded.success, readableIds)")
    expect(code).toMatch(/Effect\.logWarning\(underCited\)/)
  })
})

describe("nothing is left behind, and nothing extra is written", () => {
  /**
   * The manifest's temp directory is REMOVED even though the run failed at the spawn.
   *
   * It is acquired outside the server's own `acquireUseRelease` so that it outlives the server that
   * reads it, which is the correct nesting and also the one that could leak: a release attached to the
   * wrong scope would leave a directory per failed night. Asserted by counting `memhtml-consolidator-run-*`
   * directories across the run rather than by naming one, since the name is a random suffix.
   *
   * (Mutation: dropping the outer `acquireUseRelease`'s release — leaving the `mkdtemp` unpaired —
   * leaves one directory behind and fails this case.)
   */
  it("removes the per-run manifest directory on the failure path", async () => {
    const before = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("memhtml-consolidator-run-")
    ).length

    await failureOf({ transcripts: reachable() })

    const after = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("memhtml-consolidator-run-")
    ).length
    expect(after).toBe(before)
  })

  /**
   * The mounted trace root is untouched: read-only means the run adds nothing to the tree it read.
   *
   * A census of the mounted directory before and after, which is available here because the fixture is
   * a real directory. The stronger EROFS-level assertions live in `mount.test.ts` against the composed
   * filesystem itself; this one is about the whole run, where a stray write would be a manifest or a
   * scratch file landing beside the transcripts.
   */
  it("writes nothing into the mounted trace root", async () => {
    const before = (await readdir(projects)).sort()
    await failureOf({ transcripts: reachable() })
    expect((await readdir(projects)).sort()).toEqual(before)
  })

  /**
   * A run directory a PAST process was SIGKILLed out of is unreachable by any finalizer — in-process
   * cleanup is code, and the process is gone. The next run sweeps this app's own temp prefix for
   * entries older than a day; a YOUNG sibling may belong to a live concurrent run and must survive.
   * Ages are forged with `utimes` rather than waited out.
   *
   * (Mutation: dropping the `sweepOrphanedTempDirectories()` call from `consolidate` leaves the stale
   * orphan on disk and fails the first assertion.)
   */
  it("sweeps a stale orphaned run directory on startup, and spares a fresh one", async () => {
    const stale = await mkdtemp(join(tmpdir(), "memhtml-consolidator-run-"))
    await writeFile(join(stale, "MANIFEST.json"), "{}\n")
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    await utimes(stale, twoDaysAgo, twoDaysAgo)

    const fresh = await mkdtemp(join(tmpdir(), "memhtml-consolidator-run-"))
    try {
      await failureOf({ transcripts: reachable() })
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      await rm(stale, { recursive: true, force: true })
      await rm(fresh, { recursive: true, force: true })
    }
  })

  /**
   * The sweep's SCOPE is every temp prefix this app creates, not only the one this file's code writes.
   *
   * `memhtml exec` pins a corpus snapshot under `memhtml-corpus-snapshot-*` (`mount.ts`) and dies the
   * same way a run does, and nothing else on the box sweeps that prefix — a sweep of the wrong scope is
   * the same defect as no sweep, one prefix at a time. The age gate is the same one, so a young snapshot
   * that may belong to a live `exec` survives.
   *
   * (Mutation: narrowing the sweep back to `RUN_TMPDIR_PREFIX` leaves the stale snapshot and fails the
   * first assertion.)
   */
  it("sweeps a stale pinned corpus snapshot too, and spares a fresh one", async () => {
    const stale = await mkdtemp(join(tmpdir(), CORPUS_SNAPSHOT_TMPDIR_PREFIX))
    await mkdir(join(stale, "tree"), { recursive: true })
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    await utimes(stale, twoDaysAgo, twoDaysAgo)

    const fresh = await mkdtemp(join(tmpdir(), CORPUS_SNAPSHOT_TMPDIR_PREFIX))
    try {
      await failureOf({ transcripts: reachable() })
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      await rm(stale, { recursive: true, force: true })
      await rm(fresh, { recursive: true, force: true })
    }
  })
})
