import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  type AcquireLockDirectory,
  CHECKOUT_LOCK_PATH,
  type CheckoutLockOptions,
  withCheckoutLockUsing
} from "@memhtml/contracts"
import type { StorageFailure } from "@memhtml/contracts/errors"
import type { Effect } from "effect"
import { lock } from "proper-lockfile"

/**
 * The checkout lock's target for a repository root (`@memhtml/contracts` `checkout-lock.ts`): the lock
 * itself is the directory `<root>/.memhtml/checkout.lock`. `@memhtml/session` computes the same
 * string, which is what makes a store write and a session commit exclude each other.
 */
export const checkoutLockTarget = (root: string): string => join(resolve(root), CHECKOUT_LOCK_PATH)

/**
 * One attempt through proper-lockfile, creating `.memhtml/` first when the store has none yet. The
 * lock is the physical directory the `mkdir` makes, so two processes that reach one store through a
 * symlink and through its real path contend for the same one.
 */
const acquire: AcquireLockDirectory = async (target, options) => {
  await mkdir(dirname(target), { recursive: true })
  return lock(target, options)
}

/**
 * Run `effect` holding the repository's checkout lock: wait up to 15 s for another writer of the
 * shared index (a session commit, or a v1 write in another process), then fail with `StorageFailure`
 * `checkout.locked`. Released on every exit. Reentrant within one fiber.
 *
 * Every store operation that commits takes it (through {@link makeStore}'s one-writer gate), and so
 * must any caller that stages and commits through `store.git` or the `Git` service directly.
 */
export const withCheckoutLock = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
  options?: CheckoutLockOptions
): Effect.Effect<A, E | StorageFailure, R> =>
  withCheckoutLockUsing(acquire)(checkoutLockTarget(root), effect, options)
