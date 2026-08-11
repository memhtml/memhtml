import { defineSandbox } from "eve/sandbox"
import { justbash } from "eve/sandbox/just-bash"

import { decodeSandboxMounts, mountReadOnlyRoots } from "../../src/mount.js"

/**
 * The sandbox the agent greps transcripts in.
 *
 * The backend is PINNED, and pinning it is the point. Omitting `backend` falls back to
 * `defaultBackend()`, which resolves Vercel Sandbox first whenever `process.env.VERCEL` is set
 * (node_modules/eve/docs/sandbox.mdx, "Backends") — a hosted sandbox is an anti-goal for this
 * app, and it would be selected by an ambient env var rather than by anything written here.
 * Docker and microsandbox are the other two candidates it would try; neither is a dependency
 * this repo takes. `justbash()` is unconditional.
 *
 * just-bash is a pure-JS bash interpreter over a virtual filesystem: no daemon, no VM, and no
 * real binaries. That is a real constraint on `agent/instructions.md` — `glob`, `grep`,
 * `read_file`, and `bash` work, `git` and `node` do not.
 *
 * What goes in is transcript text; what comes out is the model's structured answer, decoded against
 * `ConsolidationPayload`. The model call happens in the APP RUNTIME, not in the sandbox, so nothing
 * in the sandbox NEEDS egress.
 *
 * ## THE SANDBOX HAS FULL EGRESS ANYWAY, AND THIS APP CANNOT TURN IT OFF
 *
 * An earlier version of this comment justified the boundary with "no credential is ever placed
 * there." That is true and it is beside the point: nothing is placed there, and something can be
 * FETCHED. Measured 2026-08-09 (`node scripts/probe-sandbox-egress.mjs`, which reproduces this on
 * demand rather than asking a reader to trust it): from a sandbox built with eve's exact options,
 * `curl` reaches example.com with HTTP 200, an IMDSv2 token PUT returns 56 bytes, and the
 * instance-role name comes back — one request short of instance-role credentials.
 *
 * eve decides this, not just-bash, and eve does not offer a choice:
 * `network:{dangerouslyAllowFullInternetAccess:!0}` is a hardcoded literal in
 * node_modules/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js, and
 * `justBashSetNetworkPolicyUnsupported()` throws by design, so `setNetworkPolicy` is not a policy
 * left unset — it is a policy that cannot be set. Egress is a CONSTRUCTION-TIME decision belonging
 * to whoever calls `new Bash()` (just-bash registers `curl`/`wget` only when a `network` or `fetch`
 * option is provided — `just-bash/dist/Bash.d.ts:80`), and here that caller is eve.
 *
 * **This is a KNOWN, ACCEPTED LIMITATION, and it is accepted because the mitigation lives outside
 * eve**: a network namespace, an IMDS block, or an IMDS hop limit of 1 on the host running the
 * sleep cycle. Nothing in this app can close it, and no comment here should imply otherwise.
 *
 * `memhtml exec` does NOT inherit this. It shares the just-bash LIBRARY, not this boundary: it
 * constructs its own `Bash` with no `network` and no `fetch`, so `curl` is not a command there at
 * all and the QuickJS guest's `fetch` refuses on call. See `apps/cli/src/exec.ts`. The two
 * consumers therefore have different egress boundaries for one reason — they call the constructor
 * differently — and the shared lesson is
 * `.erpaval/solutions/architecture-patterns/sandbox-egress-is-set-by-the-constructor.md`.
 *
 * One trap worth stating because it looks like a check: `typeof fetch` is `"function"` in the guest
 * under BOTH constructions. The refusal happens on CALL. A guard written as "is `fetch` absent?"
 * would pass review and enforce nothing.
 *
 * `agent/sandbox/workspace/` is deliberately ABSENT. Files under it bake into the template at
 * BUILD time, which cannot express per-run transcripts. Nothing is written into `/workspace` at
 * session time either: transcripts arrive on the read-only mounts below, which is what keeps them
 * out of the model's context entirely (`src/client.ts`, `manifestFor`). `/workspace` stays as eve
 * shipped it — writable scratch space the agent owns and nothing else uses.
 *
 * That also removes a resident-bytes concern rather than bounding it. just-bash holds file content in
 * memory in the server process, so the superseded seeding path made every seeded byte resident for
 * the session's lifetime and needed a per-file cap to stay bounded; an `OverlayFs` reads through to
 * the host on demand, so a whole 37.2 MB transcript costs whatever the model actually reads of it.
 *
 * ## The read-only mounts, and why they arrive through the environment
 *
 * `filesystem` is just-bash's escape hatch, and the SHAPE of the call is what makes it usable:
 * `createBashSandbox` does `await t.filesystem({ appRoot, defaultFilesystem })` and uses the result
 * as the sandbox's filesystem verbatim
 * (node_modules/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js). So `defaultFilesystem`
 * — eve's own `ReadWriteFs` owning `/workspace`, `/tmp`, and the home directory — becomes the BASE of
 * the composition, and the mounts land beside it under `/mnt/*`. Nothing eve owns is shadowed.
 *
 * The roots are read from the spawn environment because this factory runs in the SERVER process while
 * the roots are decided by the client that spawned it: per-run values (a transcript root from config,
 * a pinned corpus worktree at the run's `baseSha`) that no build-time file can carry. `mount.ts` owns
 * the encoding, so the client and this file cannot disagree about it.
 *
 * The whole path was exercised live rather than reasoned about (2026-08-09): `eve build`, then
 * `eve start` with `MEMHTML_SANDBOX_MOUNTS` naming a host directory, then a session asked to `cat` a file
 * under the mount — the agent returned its content from inside the sandbox. So the factory does run,
 * the environment does reach it, and the mount does resolve at the declared path in a real session.
 *
 * A malformed variable THROWS, which eve wraps as "Failed to create the custom just-bash filesystem"
 * and surfaces as a failed session rather than a silently mount-less one. That direction is
 * deliberate: an agent that lost its corpus answers questions about an empty corpus, and an empty
 * answer reads as a finding about the data. The client validates before spawning
 * (`encodeSandboxMounts`) precisely because eve does NOT invoke this factory during template
 * prewarming (node_modules/eve/dist/src/public/sandbox/just-bash-sandbox.d.ts, `filesystem`), so a
 * bad root reaching here would first appear inside a live sleep run.
 */
export default defineSandbox({
  backend: justbash({
    filesystem: ({ defaultFilesystem }) =>
      mountReadOnlyRoots({
        roots: decodeSandboxMounts(process.env),
        base: defaultFilesystem
      }).filesystem
  })
})
