import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * The client side of `tether/parent-tether.mjs`: the argv and environment that put the tether in
 * front of a spawned eve child (issue #100).
 *
 * One module for both spawn sites — `eve start` in `client.ts` and `eve build` in `agent-build.ts` —
 * for the reason `child-stderr.ts` already records about those same two children: a rule applied to
 * one child and not its sibling is the defect class this repo has shipped before. The leak the tether
 * closes is the SERVER (a live listener holding the run secret past its client's death), but a build
 * child orphaned the same way would grind on producing output nothing will consult, and the
 * markerless-cache rule already makes an interrupted build safe to kill.
 *
 * `--import` rather than a wrapper process, because it runs INSIDE the child: nothing extra to
 * supervise, no stream forwarding, and no second process whose own death would re-orphan the first.
 * Node consumes the flag pair before the entry point, so eve's CLI sees exactly the argv it saw
 * without the tether.
 */

/**
 * Where the spawning process's pid crosses to the child. The tether compares `process.ppid` against
 * this value; the literal is restated in `tether/parent-tether.mjs`, which `node --import` loads as
 * plain source outside this package's module graph, and `tests/parent-tether.test.ts` pins the two
 * spellings to each other.
 */
export const PARENT_PID_ENV = "MEMHTML_CONSOLIDATOR_PARENT_PID"

/** This package's root, resolved from this module rather than from `process.cwd()`. */
const packageRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The tether module's location, as the `file:` URL `--import` takes. A URL rather than a bare path,
 * because `--import` resolves its argument as an import specifier and an absolute Windows path is
 * not one.
 */
export const parentTetherUrl = (): string =>
  pathToFileURL(join(packageRoot(), "tether", "parent-tether.mjs")).href

/**
 * The node argv that runs `entry` with the tether loaded first: `--import` runs the tether before
 * any of the entry's own code, so the watch is installed from the child's first instruction and a
 * parent death in the spawn-to-boot window is caught by the tether's immediate check.
 */
export const tetheredNodeArgs = (
  entry: string,
  args: ReadonlyArray<string>
): ReadonlyArray<string> => ["--import", parentTetherUrl(), entry, ...args]

/**
 * The environment entry that arms the tether: this process's own pid, which is the child's ppid for
 * exactly as long as this process lives. Without it the tether module loads and installs nothing.
 */
export const tetherEnv = (): Record<string, string> => ({
  [PARENT_PID_ENV]: String(process.pid)
})
