import type { ChildProcess } from "node:child_process"

/**
 * Stop a spawned child AND everything it spawned, by process group.
 *
 * `eve start` is a supervisor. It spawns the built server as a grandchild
 * (node_modules/eve/dist/src/internal/nitro/host/start-production-server.js: a plain `spawn` with
 * no `detached`), and the agent loop, the model calls, and the just-bash sandbox all run in that
 * grandchild. A signal addressed to the supervisor's pid alone reaches one layer of the tree. The
 * supervisor's own SIGTERM handler forwards a SIGTERM and escalates to SIGKILL after 20 s — but a
 * SIGKILLed supervisor forwards nothing, and a grandchild whose event loop is held by a synchronous
 * regex cannot run the SIGTERM handler it installed, so the SIGTERM the supervisor does forward is
 * ignored. That is the 2026-09-03 orphan: the cron's built server still at 100% CPU 7.5 hours after
 * its client had reported a timeout and stopped the supervisor.
 *
 * So the client spawns `eve start` with `detached: true`, making its pid a process-group id, and this
 * function signals the GROUP: SIGTERM first, for the members that can act on it, then SIGKILL after
 * the grace, unconditionally. Unconditional because the leader may already have exited while a
 * blocked grandchild still holds the group; `ESRCH` on that final signal is the good outcome and is
 * the only error swallowed.
 *
 * `tests/process-group.test.ts` drives a real tree — a stand-in supervisor over a grandchild that
 * installs a SIGTERM handler and then spins — and asserts both pids are gone; its first case is the
 * reproduction, showing the pid-addressed kill leaving the grandchild alive.
 */

/** How long the SIGTERM gets before SIGKILL. The client's previous per-pid escalation used the same. */
export const KILL_GRACE_MS = 5_000

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
  }
}

/** The slice of a `ChildProcess` this needs; narrow so a test can hand in a real child or a stand-in. */
export type GroupLeader = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">

export const killProcessGroup = async (
  child: GroupLeader,
  graceMs: number = KILL_GRACE_MS
): Promise<void> => {
  const pid = child.pid
  if (pid === undefined) return
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (!exited()) {
    signalGroup(pid, "SIGTERM")
    await new Promise<void>((done) => {
      const timer = setTimeout(done, graceMs)
      child.once("exit", () => {
        clearTimeout(timer)
        done()
      })
    })
  }
  signalGroup(pid, "SIGKILL")
}
