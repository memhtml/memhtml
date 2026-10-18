/**
 * The host half of the `session exec` sandbox: build the guest filesystem from a seed image, run one
 * script under just-bash, and report which files the script left different from the seed.
 *
 * Not TypeScript and not built, like `corpus.mjs` beside it, but for a different reason: this module
 * runs on the HOST, never in the guest, and it has to load the same way in three places. The CLI
 * imports it in process (`apps/cli/src/session-exec.ts`), and the head server starts it as a
 * `worker_threads` entry (`apps/cli/src/exec-pool.ts`) so a runaway script never holds the server's
 * event loop. A worker entry must be a JavaScript file on disk, and this directory sits at the same
 * place relative to `src/`, `dist/`, and the published bundle, which is why the file lives here and
 * why `exec.ts` resolves its path the way it resolves `corpus.mjs`.
 *
 * Policy stays in TypeScript. Everything that decides what a run means (the execution limits, the
 * mount point, the helper and parser sources, the bootstrap, the retry on a bridge fault, the
 * timeout classifier, and the harvest's rules) is computed by `session-exec.ts` and handed in with
 * the job, so this file holds mechanism only and the two callers cannot disagree about a rule.
 *
 * ## The seed image
 *
 * A job carries the corpus as bytes, not strings: `buffers` (ArrayBuffers or SharedArrayBuffers)
 * and, per file, its path and the `[buffer, start, end]` of its bytes in `slots`. Each file is
 * seeded as a COPY of its bytes (`slice`), because just-bash keeps the Uint8Array it is given by
 * reference (measured on 3.4.2: `readFileBuffer` returns the very array `writeFileSync` stored) and
 * the image may be shared with later runs. The harvest then compares what the guest holds against
 * the image's own bytes, which no script can reach, so "unchanged" means byte-identical to what was
 * seeded.
 *
 * ## The walk
 *
 * `getAllPaths()` lists every entry of the corpus filesystem in one pass. The recursive
 * `readdirWithFileTypes` walk it replaces scanned every entry once per directory (just-bash
 * implements `readdir` as a filter over all paths), which cost 125 to 146 ms over the 7,437-record
 * clone where this costs 37 to 47. Only regular files count, found with `lstat`, so a symlink or a
 * directory at a seeded path reads as that file gone, as the recursive walk read it. An entry named
 * `.git` at the root is skipped with everything under it and reported as `skippedGitDir`.
 */

import { Buffer } from "node:buffer"
import { isMainThread, parentPort, workerData } from "node:worker_threads"

/** The `workerData.role` the pool starts this file with. */
export const WORKER_ROLE = "memhtml-session-exec"

const loadJustBash = () => import("just-bash")

/** True when two byte ranges hold the same bytes. */
const sameBytes = (left, right) =>
  left.byteLength === right.byteLength &&
  Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength)
  )

/**
 * Run one job and answer `{ exitCode, stdout, stderr, durationMs, changed, vanished,
 * skippedGitDir }`.
 *
 * `changed` holds every regular file whose bytes differ from its seed, and every file that had no
 * seed, as `{ path, html }` with the path repo-relative (no leading slash) and the text decoded the
 * way just-bash decodes a `readFile` as UTF-8. `vanished` holds every seeded path that is no longer a
 * regular file. A seeded file with identical bytes is in neither.
 */
export const runGuest = async (job) => {
  const { Bash, InMemoryFs, MountableFs } = await loadJustBash()
  const { image } = job
  const views = image.buffers.map((buffer) => new Uint8Array(buffer))
  const seedOf = new Map()
  const corpus = new InMemoryFs()
  for (let index = 0; index < image.paths.length; index += 1) {
    const at = index * 3
    const bytes = views[image.slots[at]].subarray(image.slots[at + 1], image.slots[at + 2])
    const path = `/${image.paths[index]}`
    seedOf.set(path, bytes)
    corpus.writeFileSync(path, bytes.slice())
  }
  const filesystem = new MountableFs({ base: new InMemoryFs() })
  filesystem.mount(job.mount, corpus)
  // No `network` and no `fetch` option: that omission is what leaves the guest without a network
  // client (`exec.ts`).
  const bash = new Bash({
    fs: filesystem,
    javascript: { bootstrap: job.bootstrap },
    executionLimits: job.executionLimits
  })
  await filesystem.mkdir(job.lib, { recursive: true })
  await filesystem.writeFile(`${job.lib}/nhp.mjs`, job.parserSource)
  await filesystem.writeFile(`${job.lib}/corpus.mjs`, job.helperSource)
  if (job.scriptPath !== null) await filesystem.writeFile(job.scriptPath, job.script)

  const started = Date.now()
  const result = await bash.exec(job.command)
  const durationMs = Date.now() - started

  const changed = []
  const present = new Set()
  let skippedGitDir = false
  for (const path of corpus.getAllPaths()) {
    if (path === "/.git" || path.startsWith("/.git/")) {
      skippedGitDir = true
      continue
    }
    const stat = await corpus.lstat(path)
    if (!stat.isFile) continue
    present.add(path)
    const seed = seedOf.get(path)
    if (seed !== undefined && sameBytes(await corpus.readFileBuffer(path), seed)) continue
    changed.push({ path: path.slice(1), html: await corpus.readFile(path, "utf8") })
  }
  const vanished = []
  for (const path of seedOf.keys()) if (!present.has(path)) vanished.push(path.slice(1))

  return {
    exitCode: result.exitCode,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    durationMs,
    changed,
    vanished,
    skippedGitDir
  }
}

/**
 * As a worker: import just-bash once, say `ready`, then answer each `{ id, job }` with `{ id, ok,
 * result }` or `{ id, ok: false, error }`. One job at a time; the pool never posts a second before
 * the first is answered.
 */
if (!isMainThread && workerData?.role === WORKER_ROLE && parentPort !== null) {
  const port = parentPort
  await loadJustBash()
  port.on("message", async (message) => {
    try {
      port.postMessage({ id: message.id, ok: true, result: await runGuest(message.job) })
    } catch (error) {
      port.postMessage({ id: message.id, ok: false, error: String(error?.stack ?? error) })
    }
  })
  port.postMessage({ ready: true })
}
