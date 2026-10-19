import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  type AcquireLockDirectory,
  CHECKOUT_LOCK_PATH,
  type CheckoutLockOptions,
  type StorageFailure,
  withCheckoutLockUsing
} from "@memhtml/contracts"
import type { Effect } from "effect"
import { lock } from "proper-lockfile"

/**
 * The checkout lock's target for a repository root (`@memhtml/contracts` `checkout-lock.ts`): the lock
 * is the directory `<root>/.memhtml/checkout.lock`. `@memhtml/store` computes the same string from
 * the same constant, which is what makes a session commit and a v1 store write exclude each other.
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
 * shared index (a v1 write from any process, another session's commit, a curate merge), then fail
 * with `StorageFailure` `checkout.locked`. Released on every exit. Reentrant within one fiber.
 */
export const withCheckoutLock = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
  options?: CheckoutLockOptions
): Effect.Effect<A, E | StorageFailure, R> =>
  withCheckoutLockUsing(acquire)(checkoutLockTarget(root), effect, options)
