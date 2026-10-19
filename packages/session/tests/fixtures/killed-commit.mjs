/**
 * A session commit that dies by SIGKILL at one exact step, for `tests/checkout.test.ts`. A kill runs
 * no finalizer, releases no lock, and writes nothing more, which no in-process simulation can do.
 *
 * Run as `node killed-commit.mjs <root> <id> <step>` against the BUILT package (`../../dist`, which
 * `turbo run test` builds first; after a source edit outside turbo, `pnpm --filter
 * @memhtml/session build`). `<step>`:
 * - `after-intent`: inside the checkout lock, after `pending` was written, before anything shared moved;
 * - `after-checkout`: right after the shared index and working tree moved, before the ref did;
 * - `after-swap`: right after the ref moved, before the log was cleared.
 *
 * The head is an empty view at the session's base: the session puts one new file, which no rule
 * judges against the corpus, and the session package has no head loader of its own.
 */
import { Effect } from "effect"

import { commitSession, makePlumbing, resumeSession } from "../../dist/index.js"

const [root, id, step] = process.argv.slice(2)
if (root === undefined || id === undefined || step === undefined) {
  process.stderr.write("usage: killed-commit.mjs <root> <id> <step>\n")
  process.exit(2)
}

const die = Effect.sync(() => {
  process.kill(process.pid, "SIGKILL")
})

/** The real plumbing, with the kill spliced in after the one step named on the line. */
const plumbing = (indexFile) => {
  const real = makePlumbing({ root, indexFile })
  return {
    ...real,
    headRef: () =>
      step === "after-intent" ? die.pipe(Effect.andThen(real.headRef())) : real.headRef(),
    readTreeIntoWorktree: (from, to) =>
      real
        .readTreeIntoWorktree(from, to)
        .pipe(Effect.tap(() => (step === "after-checkout" ? die : Effect.void))),
    updateRef: (ref, next, expected) =>
      real
        .updateRef(ref, next, expected)
        .pipe(Effect.tap(() => (step === "after-swap" ? die : Effect.void)))
  }
}

const program = Effect.gen(function* () {
  const session = yield* resumeSession({ root, id })
  const empty = () => [][Symbol.iterator]()
  const head = {
    sha: session.baseSha,
    size: 0,
    get: () => undefined,
    paths: empty,
    records: empty,
    byContentHash: () => undefined,
    byFrameKey: () => [],
    inbound: () => [],
    byEntity: () => []
  }
  return yield* commitSession({ session, head, message: "killed", plumbing })
})

const outcome = await Effect.runPromise(program)
process.stdout.write(`${JSON.stringify(outcome)}\n`)
