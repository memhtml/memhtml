import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { makeFixtureCorpus } from "@memhtml/eval"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  BRIDGE_ATTEMPTS,
  bridgeFault,
  CORPUS_MOUNT,
  cutOffByTheRuntime,
  type ExecReport,
  execCommand,
  MAX_TIMEOUT_MS,
  runExec,
  withBridgeRetry
} from "../src/exec.js"
import { run } from "../src/run.js"

/**
 * `memhtml exec` — the code-mode runtime (ROADMAP item 7b, spec CODE-1 and CODE-2).
 *
 * Two tiers, and the split is deliberate. `runExec` takes a plain DIRECTORY, so the sandbox's own
 * properties — read-only, confinement, no egress, the timeout — are asserted without a git repository
 * in the way. `execCommand` and `run` take a REPO, which is where the pin and the envelope contract
 * live. A single tier over a repo would make every sandbox assertion also a test of `git worktree`.
 *
 * **Every census assertion below compares against a total derived OUTSIDE the sandbox**, by `grep` over
 * the same files. That is not belt-and-braces: the spike reported `0/410 edges resolved` and
 * `withClaim: 0`, and each read as a finding about the corpus rather than as a bug in the reader
 * — the 2026-08 spike's key lesson. A test asserting "some chains were found"
 * passes under both bugs. {@link groundTruth} is the independent oracle, and it uses string matching
 * rather than the parser under test, so the two cannot be wrong the same way.
 */

const runProcess = promisify(execFile)

/** The real fixture corpus, in a real git repo. `@memhtml/eval`'s generator is a pure function of a seed. */
let fixture: Awaited<ReturnType<typeof makeFixture>>
let host: string

const makeFixture = () => Effect.runPromise(makeFixtureCorpus())

/**
 * The corpus's shape, counted by grep over the files on disk.
 *
 * Deliberately NOT `node-html-parser` and not the guest helper: an oracle sharing the subject's parser
 * shares its bugs. `grep -l '<mark>'` is what caught the spike's `article > mark` selector error, and
 * counting `link rel="memhtml-` with a regex is what would catch a querySelector that stopped matching.
 */
const groundTruth = async (root: string) => {
  const sh = async (command: string): Promise<string> =>
    (await runProcess("bash", ["-lc", command], { cwd: root })).stdout.trim()

  const files = Number(
    await sh(`find . -name '*.html' -not -name 'index.html' -not -path './.git/*' | wc -l`)
  )
  const withMark = Number(
    await sh(`grep -rl '<mark>' --include='*.html' . | grep -v '^./.git/' | wc -l`)
  )
  const links = Number(
    await sh(`grep -rho 'link rel="memhtml-[a-z-]*"' --include='*.html' . | wc -l`)
  )
  // Each href tested with `test -f`, which is the same check the spike used to prove that
  // `0/410 resolved` was a normalization bug and not a corpus without edges.
  const resolvable = Number(
    await sh(
      `grep -rho 'link rel="memhtml-[a-z-]*" href="[^"]*"' --include='*.html' . ` +
        `| sed 's/.*href="//;s/"//' | while read h; do test -f ".$h" && echo ok; done | wc -l`
    )
  )
  return { files, withMark, links, resolvable }
}

/** Run a script and return the parsed JSON its stdout carried, failing loudly on a non-zero exit. */
const answer = async (script: string, corpusPath: string): Promise<Record<string, unknown>> => {
  const report = await Effect.runPromise(runExec({ script, corpusPath }))
  if (report.exitCode !== 0) {
    throw new Error(`script exited ${report.exitCode}: ${report.stderr}`)
  }
  return JSON.parse(report.stdout) as Record<string, unknown>
}

beforeAll(async () => {
  fixture = await makeFixture()
  host = await mkdtemp(join(tmpdir(), "memhtml-exec-"))
}, 120_000)

afterAll(async () => {
  await fixture.cleanup()
  await rm(host, { recursive: true, force: true })
})

describe("the census asserts against a total derived outside the sandbox", () => {
  /**
   * The headline: the corpus is fully parsed, and both counts match grep exactly.
   *
   * `withClaim` equalling `files` is the assertion that carries the selector correction. ROADMAP item 7
   * documents the claim selector as `article > mark`, which matches NOTHING — the markup is
   * `<article><p><mark>` — so a helper written from that prose reports `withClaim: 0` beside a correct
   * edge count, which is exactly the shape the spike shipped.
   *
   * (Mutation: changing `article mark` to `article > mark` in `apps/cli/guest/corpus.mjs` makes
   * `withClaim` 0 while `memories` stays 305, failing "every file has a claim" and passing the file
   * count. Observed: `expected 0 to be 305`.)
   */
  it("parses every file and finds a claim in every one, both matching grep", async () => {
    const truth = await groundTruth(fixture.root)
    expect(truth.files).toBeGreaterThan(300)
    expect(truth.withMark).toBe(truth.files)

    const seen = await answer(
      `import { corpus } from "/workspace/lib/corpus.mjs"
       const memories = corpus()
       let withClaim = 0
       for (const memory of memories.values()) if (memory.claim !== "") withClaim++
       console.log(JSON.stringify({ memories: memories.size, withClaim }))`,
      fixture.root
    )

    expect(seen.memories).toBe(truth.files)
    // Not "greater than zero". The equality is the guard: a selector that silently matches nothing
    // reads as a fact about the corpus, and only a known total exposes it.
    expect(seen.withClaim).toBe(truth.files)
  }, 120_000)

  /**
   * Edge resolution as a RATE against a total, not a count of chains found.
   *
   * `dangling: 0` alone would pass a helper that found no edges at all. Asserting `resolved` equals the
   * grep-derived `resolvable` total is what makes the normalization correct rather than merely
   * self-consistent — edge hrefs are root-absolute (`/areas/x.html`) while a walk yields mount-relative
   * paths, and the spike's first traversal reported 0 of 410 because of exactly that gap.
   *
   * (Mutation: dropping the `idFor` normalization in `corpus.mjs` — keying by the raw walk path — makes
   * `resolved` 0 and `dangling` 410, failing both assertions. Observed: `expected 0 to be 410`.)
   */
  it("resolves every edge, matching the count grep can resolve with test -f", async () => {
    const truth = await groundTruth(fixture.root)
    expect(truth.links).toBeGreaterThan(0)

    const seen = await answer(
      `import { corpus, edges } from "/workspace/lib/corpus.mjs"
       const { resolved, dangling } = edges(corpus())
       console.log(JSON.stringify({ resolved: resolved.length, dangling: dangling.length }))`,
      fixture.root
    )

    expect(seen.resolved).toBe(truth.resolvable)
    expect(seen.dangling).toBe(truth.links - truth.resolvable)
  }, 120_000)

  /**
   * The capability item 7 is FOR: a multi-hop walk in one execution.
   *
   * Asserted as a specific hop count against a chain the test itself constructs, rather than as
   * "the corpus contains a long chain" — a property of the fixture generator that a seed change would
   * break, reported as a code-mode regression. The corpus here is authored: five files in a
   * supersedence line, so 5 is the answer and 1 (no walk) and 2 (one hop only) both fail.
   */
  it("walks an authored 5-file chain to its end in one execution", async () => {
    const walkRoot = join(host, "chain")
    for (const [at, next] of [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5]
    ]) {
      await writeFile(
        join(await ensure(walkRoot), `m${at}.html`),
        memoryHtml(`claim ${at}`, [{ rel: "memhtml-supersedes", href: `/m${next}.html` }])
      )
    }
    await writeFile(join(walkRoot, "m5.html"), memoryHtml("claim 5", []))

    const seen = await answer(
      `import { corpus, chain } from "/workspace/lib/corpus.mjs"
       const walked = chain(corpus(), "/m1.html", "memhtml-supersedes")
       console.log(JSON.stringify({ hops: walked.length, walked }))`,
      walkRoot
    )
    expect(seen.hops).toBe(5)
    expect(seen.walked).toEqual(["/m1.html", "/m2.html", "/m3.html", "/m4.html", "/m5.html"])
  }, 120_000)

  /**
   * A cycle terminates and reports the path travelled, rather than hanging or truncating.
   *
   * Nothing in the format forbids `A memhtml-supersedes B memhtml-supersedes A`, and a hop CAP would return a
   * truncated walk that reads like a real chain. The guard is a membership test, so the answer is the
   * distinct path and nothing more.
   *
   * (Mutation: replacing `!travelled.includes(at)` with `travelled.length < 8` in `chain` returns 8
   * entries with `/a.html` repeated, failing both assertions. Observed: `expected 8 to be 2`.)
   */
  it("terminates on a cyclic edge set instead of looping", async () => {
    const cycleRoot = await ensure(join(host, "cycle"))
    await writeFile(
      join(cycleRoot, "a.html"),
      memoryHtml("a", [{ rel: "memhtml-supersedes", href: "/b.html" }])
    )
    await writeFile(
      join(cycleRoot, "b.html"),
      memoryHtml("b", [{ rel: "memhtml-supersedes", href: "/a.html" }])
    )

    const seen = await answer(
      `import { corpus, chain } from "/workspace/lib/corpus.mjs"
       const walked = chain(corpus(), "/a.html", "memhtml-supersedes")
       console.log(JSON.stringify({ hops: walked.length, walked }))`,
      cycleRoot
    )
    expect(seen.hops).toBe(2)
    expect(seen.walked).toEqual(["/a.html", "/b.html"])
  }, 120_000)

  /**
   * Generated `index.html` listings are NOT memories.
   *
   * `memhtml publish` writes one per directory, so a real `$MEMHTML_ROOT` has as many as it has directories and
   * a census counting them is inflated by that number. Asserted on a hand-built corpus because the
   * fixture generator emits none — a test resting only on the fixture would pass with the skip removed.
   *
   * (Mutation: dropping `entry !== "index.html"` from `walk` in `corpus.mjs` makes this 3 rather than 2.
   * Observed: `expected 3 to be 2`.)
   */
  it("skips the generated index.html listings", async () => {
    const listingRoot = await ensure(join(host, "listing"))
    await writeFile(join(listingRoot, "real.html"), memoryHtml("real", []))
    await writeFile(join(listingRoot, "also-real.html"), memoryHtml("also", []))
    await writeFile(join(listingRoot, "index.html"), memoryHtml("a generated listing", []))

    const seen = await answer(
      `import { corpus } from "/workspace/lib/corpus.mjs"
       console.log(JSON.stringify({ memories: corpus().size }))`,
      listingRoot
    )
    expect(seen.memories).toBe(2)
  }, 120_000)

  /**
   * `.git` is git's storage, not the corpus, and a ref is a file at a name the author chose.
   *
   * Asserted with a branch called `foo.html`, because that is the shape where the skip is a CORRECTNESS
   * fix rather than a saving: `.git/refs/heads/foo.html` is a real path a real repository holds, and a
   * walk that descends into it reports a census one higher than any grep of the corpus can find. The
   * saving is real too and measured on the fixture: 578 of its 935 entries are git's.
   *
   * (Mutation: dropping `entry !== ".git"` from `walk` in `corpus.mjs` makes this 2 rather than 1.
   * Observed: `expected 2 to be 1`.)
   */
  it("does not descend into .git, where a ref can be named like a memory", async () => {
    const vcsRoot = await ensure(join(host, "vcs"))
    await writeFile(join(vcsRoot, "real.html"), memoryHtml("real", []))
    await writeFile(
      join(await ensure(join(vcsRoot, ".git", "refs", "heads")), "foo.html"),
      "0000000000000000000000000000000000000000\n"
    )

    const seen = await answer(
      `import { corpus } from "/workspace/lib/corpus.mjs"
       console.log(JSON.stringify({ memories: corpus().size }))`,
      vcsRoot
    )
    expect(seen.memories).toBe(1)
  }, 120_000)
})

/**
 * **A sandbox that fails to answer is the RUNTIME failing, not the script.**
 *
 * The guest's filesystem calls are synchronous round trips over a `SharedArrayBuffer`, and when that
 * handshake does not complete `just-bash`'s `SyncBackend` throws a message of its own — which reaches
 * `stderr` looking exactly like a script that threw. Observed once on a 4-vCPU CI runner (2026-08-14,
 * run 31830358200): `at isDirectory (/workspace/lib/corpus.mjs:45:28): Error code: 0`, on a tree
 * byte-identical to one that had passed minutes before.
 *
 * Both tiers here are UNIT tiers over injected values, and that is forced rather than lazy: 72 executions
 * under 3x CPU oversubscription produced no fault (measured 2026-08-14), so a test driving the real
 * sandbox cannot tell a working retry from a fault that never fired. What is testable is the
 * classification and the loop, so both are separate functions.
 */
describe("a bridge fault is the runtime's failure, and the script is re-run", () => {
  /** The two phrases, verbatim from `just-bash@3.2.0`'s bundle, as `formatError` delivers them. */
  it("names the bridge's own two wordings, and nothing else", () => {
    expect(
      bridgeFault(1, "at isDirectory (/workspace/lib/corpus.mjs:45:28): Error code: 0\n")
    ).toBe("Error code: 0")
    expect(bridgeFault(1, "at walk (/workspace/lib/corpus.mjs:59:29): Error code: 7\n")).toBe(
      "Error code: 7"
    )
    expect(
      bridgeFault(1, "at readFileSync (/workspace/script.mjs:3:9): Operation timed out\n")
    ).toBe("Operation timed out")
    // A script's own diagnostic is the script's, and re-running it would only produce it again.
    expect(
      bridgeFault(1, "at <eval> (/workspace/script.mjs:2:7): the selector matched nothing\n")
    ).toBeNull()
    /**
     * A cut-off script is NOT a bridge fault, and this is the case that keeps the retry from mattering
     * where it must not: a runaway loop re-run three times would burn three full bounds before
     * answering. `cutOffByTheRuntime` owns that wording, and the two classifications may not overlap.
     */
    expect(bridgeFault(124, "js-exec: Execution timeout: exceeded 400ms limit\n")).toBeNull()
    expect(cutOffByTheRuntime(124, "js-exec: Execution timeout: exceeded 400ms limit")).toBe(true)
    // Exit 0 is an answer. A script printing the phrase deliberately has still answered.
    expect(bridgeFault(0, "Error code: 0\n")).toBeNull()
  })

  const reportWith = (exitCode: number, stderr: string): ExecReport => ({
    corpusMount: CORPUS_MOUNT,
    sha: null,
    exitCode,
    stdout: exitCode === 0 ? '{"memories":305}' : "",
    stderr,
    durationMs: 1,
    timeoutMs: 30_000,
    timedOut: false
  })

  const faulted = reportWith(1, "at isDirectory (/workspace/lib/corpus.mjs:45:28): Error code: 0\n")

  it("re-runs a faulted attempt and answers with the attempt that succeeded", async () => {
    const attempted: Array<number> = []
    const report = await Effect.runPromise(
      withBridgeRetry((attemptIndex) => {
        attempted.push(attemptIndex)
        return Effect.succeed(attemptIndex === 1 ? faulted : reportWith(0, ""))
      })
    )
    expect(attempted).toEqual([1, 2])
    expect(report.exitCode).toBe(0)
    expect(report.stdout).toBe('{"memories":305}')
  })

  /**
   * A script's own failure is run ONCE.
   *
   * The count is the assertion, not the returned report: a loop that retried every non-zero exit would
   * return the same report here and pass on the report alone.
   */
  it("does not re-run a script that failed on its own terms", async () => {
    const attempted: Array<number> = []
    const own = reportWith(
      1,
      "at <eval> (/workspace/script.mjs:2:7): the selector matched nothing\n"
    )
    const report = await Effect.runPromise(
      withBridgeRetry((attemptIndex) => {
        attempted.push(attemptIndex)
        return Effect.succeed(own)
      })
    )
    expect(attempted).toEqual([1])
    expect(report).toBe(own)
  })

  /**
   * Exhaustion leaves through the ERROR channel, so `memhtml exec` exits 1 with `ERR_STORAGE` rather
   * than handing an agent an `exec.report` whose diagnostic is about a `stat` it never made.
   */
  it("fails as the runtime once every attempt faults", async () => {
    const attempted: Array<number> = []
    const outcome = await Effect.runPromise(
      Effect.result(
        withBridgeRetry((attemptIndex) => {
          attempted.push(attemptIndex)
          return Effect.succeed(faulted)
        })
      )
    )
    expect(attempted).toHaveLength(BRIDGE_ATTEMPTS)
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure._tag).toBe("StorageFailure")
      // The evidence rides along: the operator sees which phrase the bridge answered with.
      expect(String((outcome.failure as { operation?: string }).operation)).toContain(
        "Error code: 0"
      )
    }
  })
})

describe("the corpus is read-only, and the mount proves it (CODE-2)", () => {
  /**
   * **CODE-2's store half.** A script attempting a write is refused with `EROFS`.
   *
   * The refusal is asserted rather than the host file's absence afterwards, and that matters: a write
   * that got through would land in the overlay's copy-on-write MEMORY layer, so the host file would be
   * unchanged either way and a "the file did not change" assertion would pass against a sandbox with
   * no read-only flag at all.
   *
   * Both a top-level path and one inside a subdirectory, because the overlay routes them differently.
   *
   * (Mutation: dropping `readOnly: true` from `mountReadOnlyRoots` in `apps/consolidator/src/mount.ts`
   * makes both writes SUCCEED and this test fail. Observed: `expected 'wrote' to match /EROFS/`.)
   */
  it("REFUSES a write from inside the script with EROFS", async () => {
    const report = await Effect.runPromise(
      runExec({
        script: `import * as fs from "node:fs"
          const attempt = (path) => { try { fs.writeFileSync(path, "x"); return "wrote" } catch (e) { return String(e) } }
          console.log(JSON.stringify({
            top: attempt("${CORPUS_MOUNT}/pwn.html"),
            nested: attempt("${CORPUS_MOUNT}/areas/pwn.html")
          }))`,
        corpusPath: fixture.root
      })
    )
    expect(report.exitCode).toBe(0)
    const seen = JSON.parse(report.stdout) as { top: string; nested: string }
    expect(seen.top).toMatch(/EROFS/)
    expect(seen.nested).toMatch(/EROFS/)
  }, 120_000)

  /**
   * Reads are confined to the mounted root: no `..` escape, no absolute host path.
   *
   * `/etc/hostname` exists on every host running this suite, so its absence inside the guest is a
   * statement about the boundary rather than about the file.
   */
  it("confines reads to the mount", async () => {
    const seen = await answer(
      `import * as fs from "node:fs"
       const attempt = (path) => { try { return fs.readFileSync(path, "utf8").slice(0, 20) } catch (e) { return "refused" } }
       console.log(JSON.stringify({
         absolute: attempt("/etc/hostname"),
         traversal: attempt("${CORPUS_MOUNT}/../../../etc/hostname")
       }))`,
      fixture.root
    )
    expect(seen.absolute).toBe("refused")
    expect(seen.traversal).toBe("refused")
  }, 120_000)
})

describe("no ranked plane is reachable, by absence rather than by guard (CODE-1 scope)", () => {
  /**
   * **The index is not exposed, and the mechanism is WHAT IS MOUNTED.**
   *
   * Two facts compose. `.memhtml/index.db` is gitignored (`packages/store/src/layout.ts`), and a gitignored
   * file is absent from a checkout of a commit — so pinning a worktree omits it. That is the real
   * boundary, because read-only is NO barrier to a reader: probed 2026-08-09, `sqlite3` over a
   * read-only `OverlayFs` mount of a directory holding a live database returned its rows, exit 0.
   *
   * The database is created here as a REAL sqlite file with a readable row, so the assertion is that a
   * script cannot reach a database that genuinely exists on the host beside the corpus — not that
   * there was nothing to find.
   *
   * (Mutation: changing `execCommand` to pass `corpusPath: input.memhtmlRoot` — mounting the live tree
   * instead of the pinned worktree — makes `indexBytes` a number and `sqliteRows` the row's value,
   * failing both assertions. Observed: `expected 8192 to be 'refused'`.)
   */
  it("cannot read .memhtml/index.db, because a pinned worktree does not contain it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "memhtml-exec-repo-"))
    try {
      const git = (...args: ReadonlyArray<string>) => runProcess("git", ["-C", repo, ...args])
      await git("init", "--initial-branch=main")
      await git("config", "user.email", "t@example.com")
      await git("config", "user.name", "t")
      await writeFile(join(repo, ".gitignore"), ".memhtml/index.db\n")
      await writeFile(join(repo, "note.html"), memoryHtml("a claim", []))
      await ensure(join(repo, ".memhtml"))
      // A real database with a real row, so "refused" cannot mean "there was nothing there".
      await runProcess("sqlite3", [
        join(repo, ".memhtml", "index.db"),
        "create table files(gist); insert into files values('a-ranked-plane-row');"
      ])
      await git("add", "-A")
      await git("commit", "-m", "base")

      const report = await Effect.runPromise(
        Effect.scoped(
          execCommand({
            script: `import * as fs from "node:fs"
              const attempt = (fn) => { try { return fn() } catch (e) { return "refused" } }
              console.log(JSON.stringify({
                indexBytes: attempt(() => fs.readFileSync("${CORPUS_MOUNT}/.memhtml/index.db").length),
                corpusFiles: fs.readdirSync("${CORPUS_MOUNT}").filter((n) => n.endsWith(".html")).length
              }))`,
            memhtmlRoot: repo
          })
        )
      )
      expect(report.exitCode).toBe(0)
      const seen = JSON.parse(report.stdout) as Record<string, unknown>
      expect(seen.indexBytes).toBe("refused")
      // And the corpus IS there, so "refused" is about the database and not about a broken mount.
      expect(seen.corpusFiles).toBe(1)

      // The host file exists and is readable from OUTSIDE, which is what makes the guest's
      // "refused" a boundary rather than a missing fixture.
      const onHost = await readFile(join(repo, ".memhtml", "index.db"))
      expect(onHost.byteLength).toBeGreaterThan(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, 120_000)

  /**
   * The guest's own `sqlite3` finds nothing to open either.
   *
   * A second door onto the same question, because `node:fs` and the bundled `sqlite3` command reach the
   * filesystem by different paths and a script would reach for whichever worked.
   */
  it("leaves the guest's sqlite3 with no database to open", async () => {
    const report = await Effect.runPromise(
      runExec({
        script: `console.log("unused")`,
        corpusPath: fixture.root
      })
    )
    expect(report.exitCode).toBe(0)
    // The fixture repo is a working tree with no `.memhtml/index.db` at all, and `runExec` mounts a plain
    // directory — so this asserts the shape the pinned path produces. The pin's own guarantee is the
    // case above, where a database genuinely exists beside the corpus.
    expect(report.sha).toBeNull()
  }, 120_000)
})

describe("the sandbox has no network client, and that is this runtime's choice", () => {
  /**
   * `curl` is not a command, and the guest's `fetch` refuses on CALL.
   *
   * just-bash registers its network commands only when a `network` or `fetch` option is passed to
   * `new Bash()` (`just-bash@3.2.0` `dist/Bash.d.ts:80`), and `apps/cli/src/exec.ts` passes neither.
   * So egress is decided by the CONSTRUCTOR, not by a default — the consolidator's sandbox does reach
   * the network because eve passes `dangerouslyAllowFullInternetAccess`, and `memhtml exec` does not
   * because this runtime omits the option.
   *
   * `typeof fetch` is asserted to be `"function"` on purpose: it IS one, so a capability check on the
   * global reads as passing while enforcing nothing. The refusal is on the call.
   *
   * (Mutation: adding `network: { dangerouslyAllowFullInternetAccess: true }` to the `new Bash(...)`
   * options in `exec.ts` makes `fetchResult` an HTTP status. Observed: `expected 200 to match
   * /not configured/i`.)
   */
  it("REFUSES a fetch from the guest and has no curl at all", async () => {
    const seen = await answer(
      `const attempt = async () => { try { const r = await fetch("https://example.com"); return r.status } catch (e) { return String(e) } }
       console.log(JSON.stringify({ fetchType: typeof fetch, fetchResult: await attempt() }))`,
      fixture.root
    )
    // A function, and useless — which is why the assertion is on the call's outcome.
    expect(seen.fetchType).toBe("function")
    expect(String(seen.fetchResult)).toMatch(/not configured/i)
  }, 120_000)
})

describe("a script is bounded in time", () => {
  /**
   * A runaway loop is cut off, reported as `timedOut`, and does NOT become an error envelope.
   *
   * The bound is the only thing between an infinite guest loop and a `memhtml exec` that never returns:
   * QuickJS runs the script in a worker with no reaper of its own. Probed at 700ms: exit 124 at 724ms.
   *
   * `timedOut` is asserted rather than just the exit code, because 124 is also reachable from a script
   * that exits 124 itself — the field has to mean "the runtime cut it off".
   *
   * (Mutation: dropping `maxJsTimeoutMs` from the `executionLimits` in `exec.ts` leaves just-bash's own
   * 30s default in force, so a 400ms bound is not applied and this test hangs past its own 120s
   * vitest timeout rather than returning. Observed: the suite fails on "Test timed out in 120000ms".)
   */
  it("cuts off a runaway script at the bound and says so", async () => {
    const started = Date.now()
    const report = await Effect.runPromise(
      runExec({
        script: "let spun = 0; for (;;) { spun += 1 }",
        corpusPath: fixture.root,
        timeoutMs: 400
      })
    )
    expect(report.timedOut).toBe(true)
    expect(report.exitCode).toBe(124)
    expect(report.timeoutMs).toBe(400)
    // The bound is real wall clock, not a reported intention. Generous upper edge: the assertion is
    // that it returned at all, and roughly when asked, not a latency measurement.
    expect(Date.now() - started).toBeLessThan(30_000)
    /**
     * The diagnostic names the number the caller set, which is what the shell bound's grace margin
     * buys. Equal bounds are a race, and the shell's message — "exceeded its execution deadline" —
     * carries no number at all.
     *
     * (Mutation: setting `maxExecutionTimeMs: timeoutMs` in `exec.ts` — no grace — makes the shell bound
     * win and drops the limit from `stderr`. Observed: `expected 'bash: js-exec exceeded its execution
     * deadline' to contain '400ms'`.)
     */
    expect(report.stderr).toContain("400ms")
  }, 120_000)

  /**
   * Both wordings just-bash uses for a cut-off classify as `timedOut`.
   *
   * Tested against the pure function rather than through a run, and that is the honest shape: the shell
   * bound's grace margin means the JS bound always wins live, so the shell wording never reaches a real
   * report and a test driving `runExec` could not distinguish a correct pattern from `/timeout/` alone.
   * The two strings below are verbatim from a probe, not paraphrased.
   *
   * (Mutation: narrowing the pattern to `/timeout|aborted/` in `exec.ts` fails the deadline case and
   * nothing else — and it SURVIVES every end-to-end timeout test, which is why this case exists.
   * Observed: `expected false to be true`.)
   */
  it("classifies both of just-bash's cut-off wordings, including the one with no 'timeout' in it", () => {
    expect(cutOffByTheRuntime(124, "js-exec: Execution timeout: exceeded 400ms limit")).toBe(true)
    expect(cutOffByTheRuntime(124, "bash: js-exec exceeded its execution deadline")).toBe(true)
    expect(cutOffByTheRuntime(124, "bash: execution aborted")).toBe(true)
    // A script that chose 124 itself is NOT a timeout, which is why the wording is checked at all.
    expect(cutOffByTheRuntime(124, "Error: I exited 124 deliberately")).toBe(false)
    expect(cutOffByTheRuntime(1, "js-exec: Execution timeout: exceeded 400ms limit")).toBe(false)
  })
})

describe("the envelope contract", () => {
  /** The happy path over a real repo, through `run` — the same bytes an agent parses. */
  it("answers one exec.report envelope naming the sha it mounted", async () => {
    const result = await run([
      "exec",
      "--repo",
      fixture.root,
      "--script",
      `import { corpus } from "/workspace/lib/corpus.mjs"
       console.log(JSON.stringify({ memories: corpus().size }))`
    ])
    expect(result.exitCode).toBe(0)
    const envelope = JSON.parse(result.stdout) as {
      type: string
      data: { sha: string; stdout: string; corpusMount: string }
    }
    expect(envelope.type).toBe("exec.report")
    expect(envelope.data.corpusMount).toBe(CORPUS_MOUNT)
    // A 40-character sha, so the report names a commit a caller can pass back as `--sha`.
    expect(envelope.data.sha).toMatch(/^[0-9a-f]{40}$/)

    const truth = await groundTruth(fixture.root)
    expect((JSON.parse(envelope.data.stdout) as { memories: number }).memories).toBe(truth.files)
  }, 120_000)

  /**
   * **A failing SCRIPT is exit 0 with a report; a failing RUNTIME is exit 1.**
   *
   * The split is the contract. Mapping a guest's exit onto the CLI's own would make an agent unable to
   * tell "your selector is wrong" from "the sandbox could not start", and would bury the script's
   * diagnostic inside an `error` string that agents are told never to branch on.
   *
   * (Mutation: returning `EXIT_RUNTIME` when `report.exitCode !== 0` in `run.ts`'s exec arm fails the
   * first assertion. Observed: `expected 1 to be 0`.)
   */
  it("reports a thrown script as exit 0 with the diagnostic on stderr", async () => {
    const result = await run([
      "exec",
      "--repo",
      fixture.root,
      "--script",
      `throw new Error("the selector matched nothing")`
    ])
    expect(result.exitCode).toBe(0)
    const envelope = JSON.parse(result.stdout) as {
      type: string
      data: { exitCode: number; stderr: string }
    }
    expect(envelope.type).toBe("exec.report")
    expect(envelope.data.exitCode).not.toBe(0)
    expect(envelope.data.stderr).toContain("the selector matched nothing")
  }, 120_000)

  /** An unreachable sha is the RUNTIME failing, so it is exit 1 with a code an agent branches on. */
  it("fails with exit 1 on a sha that does not exist", async () => {
    const result = await run([
      "exec",
      "--repo",
      fixture.root,
      "--sha",
      "0000000000000000000000000000000000000000",
      "--script",
      "console.log(1)"
    ])
    expect(result.exitCode).toBe(1)
    const envelope = JSON.parse(result.stdout) as { code: string }
    expect(envelope.code).toBe("ERR_INVALID_MEMORY")
  }, 120_000)

  it("reads the script from stdin under `--file -`, the flag spelling of the dash", async () => {
    /**
     * The docs promise three stdin spellings — a bare call, a positional `-`, and `--file -` — and
     * the third used to fall through to `readScript("-")`, which tried to open a FILE named `-`
     * and answered `ERR_PATH_NOT_FOUND` to a caller doing what the flag's own description says.
     */
    const result = await run(["exec", "--repo", fixture.root, "--file", "-"], undefined, () =>
      Promise.resolve(`console.log(JSON.stringify({ viaStdin: true }))`)
    )
    expect(result.exitCode).toBe(0)
    const envelope = JSON.parse(result.stdout) as { type: string; data: { stdout: string } }
    expect(envelope.type).toBe("exec.report")
    expect(JSON.parse(envelope.data.stdout)).toEqual({ viaStdin: true })
  }, 120_000)

  /**
   * `--dense` must not strip anything load-bearing.
   *
   * `--dense` drops nulls, and `sha` is null exactly when a directory was mounted rather than a commit
   * — which never happens through the CLI, so every field a caller needs survives. Asserted because the
   * failure mode is silent: a payload whose meaning depends on a null key would lose it here.
   */
  it("keeps every load-bearing field under --dense", async () => {
    const result = await run([
      "exec",
      "--repo",
      fixture.root,
      "--dense",
      "--script",
      "console.log('{}')"
    ])
    const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> }
    for (const key of [
      "corpusMount",
      "sha",
      "exitCode",
      "stdout",
      "stderr",
      "durationMs",
      "timeoutMs",
      "timedOut"
    ]) {
      expect(Object.keys(envelope.data)).toContain(key)
    }
  }, 120_000)
})

describe("usage errors are exit 2, decided before anything is mounted", () => {
  /**
   * The XOR over the script doors.
   *
   * `validate`'s return becomes exit 2 while a failure raised in `dispatch` becomes exit 1, so this
   * check cannot live in the arm: a mutually-exclusive-parameter refusal raised after dispatch is
   * masked as a runtime error
   * (`.erpaval/solutions/api-patterns/xor-params-and-mcp-error-masking.md`).
   *
   * (Mutation: moving the `execFlags` call out of `validate` and into the exec arm as a raised failure
   * turns every case here into exit 1. Observed: `expected 1 to be 2`.)
   */
  it("refuses --file beside --script", async () => {
    const result = await run(["exec", "--file", "a.mjs", "--script", "console.log(1)"])
    expect(result.exitCode).toBe(2)
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("ERR_INVALID_FLAG")
  })

  it("refuses a `-` stdin marker beside a door, in both spellings", async () => {
    for (const argv of [
      ["exec", "-", "--script", "console.log(1)"],
      ["exec", "--file", "-", "--script", "console.log(1)"]
    ]) {
      const result = await run(argv)
      expect(result.exitCode, argv.join(" ")).toBe(2)
      expect((JSON.parse(result.stdout) as { code: string }).code).toBe("ERR_INVALID_FLAG")
    }
  })

  /**
   * A non-positive bound is REFUSED, not clamped.
   *
   * just-bash treats a non-positive `maxJsTimeoutMs` as no bound at all, so `--timeout-ms 0` would read
   * as "be quick" and mean "run forever" — the one thing a sandbox may not do.
   *
   * (Mutation: relaxing the check to `timeout < 0` accepts `--timeout-ms 0` and this fails.
   * Observed: `expected 0 to be 2`.)
   */
  it("refuses a zero, negative, or over-cap timeout", async () => {
    for (const value of ["0", "-1", String(MAX_TIMEOUT_MS + 1)]) {
      const result = await run(["exec", "--timeout-ms", value, "--script", "console.log(1)"])
      expect(result.exitCode, `--timeout-ms ${value}`).toBe(2)
      expect((JSON.parse(result.stdout) as { code: string }).code).toBe("ERR_INVALID_FLAG")
    }
  })

  // `--repo` on these two because the suite pins `MEMHTML_REFUSE_ENV_ROOT`, and that refusal is
  // decided before this arm's own checks; the repo is incidental to what each asserts.
  it("refuses a blank script rather than reporting an empty answer", async () => {
    const result = await run(["exec", "--script", "   ", "--repo", fixture.root])
    expect(result.exitCode).toBe(2)
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("ERR_MISSING_ARGUMENT")
  })

  it("refuses an unreadable --file with a path-not-found code", async () => {
    const result = await run([
      "exec",
      "--file",
      join(host, "definitely-absent.mjs"),
      "--repo",
      fixture.root
    ])
    expect(result.exitCode).toBe(2)
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("ERR_PATH_NOT_FOUND")
  })
})

/** A minimal memory file, in the shape the format guarantees: the claim is a `<p>` descendant. */
const memoryHtml = (
  claim: string,
  links: ReadonlyArray<{ readonly rel: string; readonly href: string }>
): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${claim}</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
${links.map((link) => `<link rel="${link.rel}" href="${link.href}">`).join("\n")}
</head>
<body>
<article><p><mark>${claim}</mark></p></article>
</body>
</html>
`

/** `mkdir -p`, returning the path so a caller can inline it. */
const ensure = async (path: string): Promise<string> => {
  await runProcess("mkdir", ["-p", path])
  return path
}
