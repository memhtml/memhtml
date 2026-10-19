import type { CheckoutLockOptions, StorageFailure } from "@memhtml/contracts"
import { Effect } from "effect"

import { withCheckoutLock } from "./checkout-lock.js"
import type { GitFailure } from "./errors.js"
import type { Plumbing } from "./plumbing.js"

/**
 * Settle a `pending` commit, under the checkout lock: a commit an earlier `commitSession` built and
 * wrote to the log before it touched the checkout, and then may have died at any point (or failed to
 * write the log after the ref moved). Shared by the commit's step 0 and by every log write that adds
 * ops (`appendOps`), so an op appended after a kill lands on top of the settled commit instead of
 * being cleared with it.
 *
 * - Reachable from the ref: it landed. The caller treats the log's ops as committed.
 * - Not reachable: it never landed. When `HEAD` is the ref, `read-tree -m -u pending <tip>` undoes a
 *   checkout update that ran without its swap. That two-tree merge changes only the paths where the
 *   shared index still holds `pending`'s version and the tip holds another, so it is a no-op when the
 *   checkout never followed, and when another writer has since committed the same bytes (a v1 commit
 *   after the dead holder's lock went stale) it leaves them, where rolling back to `pending^` would
 *   stage their deletion. With the tip still at `pending^`, it is exactly that rollback.
 * - A `pending` naming no object (pruned by `git gc`) never landed and has nothing to roll back from.
 */
export const settlePending = (input: {
  readonly root: string
  readonly git: Plumbing
  readonly ref: string
  readonly pending: string
  readonly lock?: CheckoutLockOptions | undefined
}): Effect.Effect<
  { readonly landed: false } | { readonly landed: true; readonly worktreeSynced: boolean },
  GitFailure | StorageFailure
> => {
  const { git, ref, pending } = input
  return withCheckoutLock(
    input.root,
    Effect.uninterruptible(
      Effect.gen(function* () {
        if ((yield* git.revParse(pending)) === null) return { landed: false } as const
        const checkedOut = (yield* git.headRef()) === ref
        if (yield* git.isAncestor(pending, ref)) {
          return { landed: true, worktreeSynced: checkedOut } as const
        }
        const tip = yield* git.revParse(ref)
        if (checkedOut && tip !== null) {
          yield* git
            .readTreeIntoWorktree(pending, tip)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning(`${ref}: checkout not rolled back from pending ${pending}`)
              )
            )
        }
        return { landed: false } as const
      })
    ),
    input.lock
  )
}
