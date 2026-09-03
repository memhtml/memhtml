/**
 * The worker half of `src/command-bound.ts`: one shell command, on a thread the parent can kill.
 *
 * Plain .mjs loaded by `new Worker(path)` at run time, never typechecked and never bundled — the same
 * shape as `tether/parent-tether.mjs`, and shipped the same way (`tsdown.config.ts` copies it;
 * `tests-integration/tests/packaging.test.ts` carries its claim). `just-bash` resolves from this
 * file's own location, which in a checkout is `apps/consolidator/node_modules` and in an install is
 * the published package's dependency.
 *
 * The filesystem is the composition `src/mount.ts` documents, restated here because this thread
 * cannot import that module's compiled form from an installed package: a `MountableFs` over a
 * writable base, with each declared root an `OverlayFs` mounted read-only at `mountPoint: "/"`. The
 * base is a `ReadWriteFs` on the host scratch directory the client created, so `/workspace` is the
 * same directory across every command of a run. `tests/command-bound.test.ts` proves the read-only
 * edge (EROFS under a mount) and the persistence edge against the installed just-bash.
 */
import { parentPort, workerData } from "node:worker_threads"
import { Bash, MountableFs, OverlayFs, ReadWriteFs } from "just-bash"

const post = (report) => parentPort?.postMessage(report)

const run = async () => {
  const { command, mountsEncoded, scratchRoot } = workerData
  const base = new ReadWriteFs({ root: scratchRoot, maxFileReadSize: Number.MAX_SAFE_INTEGER })
  const filesystem = new MountableFs({ base })
  const roots = mountsEncoded.trim() === "" ? [] : JSON.parse(mountsEncoded)
  for (const root of roots) {
    filesystem.mount(
      root.mountPath,
      new OverlayFs({ root: root.hostPath, mountPoint: "/", readOnly: true })
    )
  }
  const bash = new Bash({
    fs: filesystem,
    cwd: "/workspace",
    env: { HOME: "/workspace", PWD: "/workspace", TMPDIR: "/tmp" },
    // Bounds what one command may accumulate in memory; the parent trims what the model sees.
    executionLimits: { maxOutputSize: 8 * 1024 * 1024 }
  })
  const result = await bash.exec(command)
  post({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
}

run().catch((cause) => {
  post({
    exitCode: 126,
    stdout: "",
    stderr: `the sandbox could not run the command: ${String(cause)}`
  })
})
