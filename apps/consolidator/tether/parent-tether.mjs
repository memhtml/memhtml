/**
 * Exit this process when the parent that spawned it dies (issue #100).
 *
 * Loaded with `node --import` in front of every eve child this app spawns — `eve start` in
 * `src/client.ts` and `eve build` in `src/agent-build.ts` — so it runs INSIDE the child, before any
 * eve code, from the first instruction of the process's life. An Effect finalizer in the client can
 * stop a child on every path in-process code runs on, but SIGKILL and the OOM killer end the client
 * before any finalizer executes, and eve's own CLI neither watches its parent pid nor exits when
 * stdin closes (probed against the shipped dist; `eve start` takes only `--host`/`--port`). What
 * such a death used to leak is a live loopback listener holding the run secret in its environment —
 * a process census on one development host found 19 of them, several older than two days.
 *
 * The mechanism is the PARENT PID, not a timer and not stdin. The client stamps its own pid into
 * MEMHTML_CONSOLIDATOR_PARENT_PID at spawn; the kernel reparents an orphan the instant its parent
 * dies, so `process.ppid` moving off that value IS the parent's death, with no pid-reuse hazard —
 * a recycled pid cannot become this process's parent again. The poll costs one getppid() a second.
 *
 * On orphaning it sends ITSELF SIGTERM rather than calling `process.exit`, so eve's own shutdown
 * runs: `eve start` installs SIGINT/SIGTERM handlers that terminate the built server it supervises
 * (its `terminate` SIGTERMs the child and SIGKILLs after 20s), which is what tears down the whole
 * tree rather than one layer of it. The hard `process.exit` below is the backstop for a process
 * that ignores the signal; both timers are unref()ed so the tether can never keep a dying process
 * alive on its own.
 *
 * INERT without the environment variable: a hand-run `eve start` or `eve dev` loads no tether, and
 * a load with the variable absent or malformed installs nothing. The variable names the pid the
 * spawner CLAIMS to be; a claim that already disagrees with `process.ppid` at load time means the
 * parent died between spawn and this module running, and that is an orphan too.
 *
 * Plain .mjs, read by `node --import` at run time and never typechecked — the same shape as
 * `apps/cli/guest/corpus.mjs`. It ships in the published package: `tsdown.config.ts` copies it and
 * `tests-integration/tests/packaging.test.ts` carries its claim.
 */

const PARENT_PID_ENV = "MEMHTML_CONSOLIDATOR_PARENT_PID"

/** One getppid() per second: cheap against the seconds-to-days lifetimes this bounds. */
const POLL_INTERVAL_MS = 1_000

/**
 * How long the SIGTERM gets before the hard exit. eve's own forced-exit backstop is 900ms and the
 * client's stop() escalates to SIGKILL after 5s, so five seconds is the widest bound already in
 * this process tree's vocabulary rather than a new one.
 */
const FORCED_EXIT_GRACE_MS = 5_000

/** 128 + SIGTERM(15): the code a SIGTERM death reports, claimed explicitly on the backstop path. */
const ORPHANED_EXIT_CODE = 143

const declared = Number(process.env[PARENT_PID_ENV] ?? "")

if (Number.isInteger(declared) && declared > 0) {
  let dying = false

  const shutdown = () => {
    if (dying) return
    dying = true
    clearInterval(poll)
    process.stderr.write(
      `parent-tether: parent process ${String(declared)} is gone (ppid is now ` +
        `${String(process.ppid)}); shutting down\n`
    )
    setTimeout(() => process.exit(ORPHANED_EXIT_CODE), FORCED_EXIT_GRACE_MS).unref()
    try {
      process.kill(process.pid, "SIGTERM")
    } catch {
      process.exit(ORPHANED_EXIT_CODE)
    }
  }

  const poll = setInterval(() => {
    if (process.ppid !== declared) shutdown()
  }, POLL_INTERVAL_MS)
  poll.unref()

  // The parent may have died between the spawn and this module loading; check once immediately.
  if (process.ppid !== declared) shutdown()
}
