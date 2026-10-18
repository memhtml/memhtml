import { Context, Effect, Exit, Schedule, Scope } from "effect"

import { StorageFailure } from "./errors.js"

/**
 * The checkout lock: one cross-process lock per repository that every writer of the SHARED git
 * index holds while it changes that index and moves the branch the checkout follows.
 *
 * Two kinds of writer share one checkout, and neither can see the other's half-done state:
 *
 * - The v1 store stages with `git add` and then commits the WHOLE shared index (`git commit`). A
 *   commit that runs while another writer has staged something sweeps that something into its own
 *   commit, under its own subject.
 * - A v2 session commit moves the shared index and working tree to its new tree (`read-tree -m -u`)
 *   and then compare-and-swaps the ref. Between the two the index is one commit ahead of `HEAD`.
 *
 * Interleaved, the v1 commit takes the session's new file into its own commit, the session's swap
 * loses, the session's rollback leaves the file staged as deleted, and the next v1 commit removes it
 * from the branch. So each holds this lock around its sequence: the store from its first stage to its
 * commit (and its compensation on failure), the session commit around the checkout update, the swap,
 * and the rollback.
 *
 * It lives here, with zero I/O of its own, because the two writers are packages that cannot import
 * each other (`@memhtml/session` never imports `@memhtml/store`), and they must agree on three
 * things or the lock excludes nothing: the lock's path, its timing, and the reentrancy key below.
 * The filesystem half arrives as an injected function ({@link AcquireLockDirectory}), which each side
 * implements with `proper-lockfile` (an atomic `mkdir` of `<target>.lock` whose mtime the holder
 * refreshes, so a holder killed with no chance to clean up goes stale and is reclaimed).
 */

/**
 * The lock's target, relative to the repository root. proper-lockfile's lock is the directory
 * `.memhtml/checkout.lock` beside it; the target itself is never created.
 */
export const CHECKOUT_LOCK_PATH = ".memhtml/checkout"

/**
 * How long the lock may go without an mtime refresh before another writer may reclaim it. A live
 * holder refreshes every {@link CHECKOUT_LOCK_UPDATE_MS}, so only a holder that died (or whose event
 * loop stalled for this long) loses it.
 */
export const CHECKOUT_LOCK_STALE_MS = 10_000

/** How often a holder refreshes the lock's mtime. */
export const CHECKOUT_LOCK_UPDATE_MS = 2_000

/**
 * How long a writer waits for another writer to release the lock before it gives up with
 * {@link CHECKOUT_LOCKED}. Holds are milliseconds (a session's checkout update and swap) to about a
 * second (a v1 batch), so this is a short wait rather than fail-fast: the two writers are different
 * callers, and the loser should take its turn rather than fail. It is longer than
 * {@link CHECKOUT_LOCK_STALE_MS}, so a waiter outlasts a lock left by a killed holder and reclaims it.
 */
export const CHECKOUT_LOCK_WAIT_MS = 15_000

/** The first pause between attempts; pauses double up to {@link CHECKOUT_LOCK_MAX_PAUSE_MS}. */
export const CHECKOUT_LOCK_FIRST_PAUSE_MS = 10

/** The longest pause between two attempts. */
export const CHECKOUT_LOCK_MAX_PAUSE_MS = 250

/** The `StorageFailure` operation a writer gets when the wait ran out. */
export const CHECKOUT_LOCKED = "checkout.locked"

/** The `StorageFailure` operation for a lock that could not be taken for any other reason (EACCES). */
export const CHECKOUT_LOCK_FAILED = "checkout.lock"

/** The options each attempt hands the injected acquisition: proper-lockfile's, narrowed to what is used. */
export interface LockDirectoryOptions {
  readonly realpath: false
  readonly stale: number
  readonly update: number
  /** Always 0: the wait is this module's schedule, so it can be interrupted between attempts. */
  readonly retries: 0
  readonly onCompromised: (error: Error) => void
}

/**
 * Take the lock at `target` once, or reject. A lock another live holder owns rejects with an error
 * whose `code` is `ELOCKED`; any other rejection is a failure the wait does not retry. Resolves with
 * the release.
 */
export type AcquireLockDirectory = (
  target: string,
  options: LockDirectoryOptions
) => Promise<() => Promise<void>>

/**
 * The lock targets the current fiber already holds. A nested acquisition of a held target runs its
 * effect directly instead of waiting on itself until the wait runs out, so a writer that holds the
 * lock and calls another that takes it (a task status change that archives) cannot deadlock. Provided
 * per call, so it scopes to the holder's own effect and the fibers it forks, never to a sibling.
 */
export const CheckoutLockHeld = Context.Reference<ReadonlySet<string>>(
  "@memhtml/contracts/CheckoutLockHeld",
  { defaultValue: () => new Set<string>() }
)

export interface CheckoutLockOptions {
  /** The wait budget; {@link CHECKOUT_LOCK_WAIT_MS} unless a test shortens it. */
  readonly waitMs?: number | undefined
}

const isHeldByAnother = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ELOCKED"

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The checkout lock over an injected acquisition: `withCheckoutLockUsing(acquire)(target, effect)`
 * runs `effect` holding the lock at `target`.
 *
 * - Waits up to `waitMs` for another holder, pausing 10 ms and doubling to 250 ms between attempts,
 *   then fails with `StorageFailure` {@link CHECKOUT_LOCKED}. The wait is interruptible between
 *   attempts; each attempt is uninterruptible and registers its release in the same step, so an
 *   interrupt never strands a lock this fiber took.
 * - Releases on every exit: success, failure, defect, and interruption.
 * - Reentrant per fiber ({@link CheckoutLockHeld}): a nested call for a target this fiber holds runs
 *   `effect` without a second acquisition.
 * - A compromised lock (reclaimed by another writer because this holder missed its refreshes for
 *   {@link CHECKOUT_LOCK_STALE_MS}) is logged when the holder finishes, instead of proper-lockfile's
 *   default of throwing from a timer, which would kill the process mid-sequence.
 */
export const withCheckoutLockUsing =
  (acquire: AcquireLockDirectory) =>
  <A, E, R>(
    target: string,
    effect: Effect.Effect<A, E, R>,
    options: CheckoutLockOptions = {}
  ): Effect.Effect<A, E | StorageFailure, R> =>
    Effect.gen(function* () {
      const held = yield* CheckoutLockHeld
      if (held.has(target)) return yield* effect
      const waitMs = options.waitMs ?? CHECKOUT_LOCK_WAIT_MS
      let compromised: string | null = null
      const attempt = Effect.tryPromise({
        try: () =>
          acquire(target, {
            realpath: false,
            stale: CHECKOUT_LOCK_STALE_MS,
            update: CHECKOUT_LOCK_UPDATE_MS,
            retries: 0,
            onCompromised: (error) => {
              compromised = error.message
            }
          }),
        catch: (cause) => cause
      })
      const pauses = Schedule.min([
        Schedule.exponential(`${CHECKOUT_LOCK_FIRST_PAUSE_MS} millis`, 2),
        Schedule.spaced(`${CHECKOUT_LOCK_MAX_PAUSE_MS} millis`)
      ]).pipe(Schedule.upTo({ duration: `${waitMs} millis` }))
      const scope = yield* Scope.make()
      return yield* Effect.acquireRelease(attempt, (release) =>
        Effect.promise(() => release().catch(() => undefined))
      ).pipe(
        Effect.retry({ schedule: pauses, while: isHeldByAnother }),
        Effect.catch((cause) =>
          Effect.logError(
            isHeldByAnother(cause)
              ? `${target}.lock is held by another writer of this checkout and was not released within ${String(waitMs)} ms`
              : `${target}.lock could not be taken: ${messageOf(cause)}`
          ).pipe(
            Effect.andThen(
              Effect.fail(
                StorageFailure.make({
                  operation: isHeldByAnother(cause) ? CHECKOUT_LOCKED : CHECKOUT_LOCK_FAILED
                })
              )
            )
          )
        ),
        Scope.provide(scope),
        Effect.andThen(
          effect.pipe(Effect.provideService(CheckoutLockHeld, new Set([...held, target])))
        ),
        Effect.onExit((exit) =>
          Scope.close(scope, exit).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                compromised === null
                  ? Effect.void
                  : Effect.logWarning(
                      `${target}.lock was reclaimed by another writer while this one held it (${compromised})${Exit.isSuccess(exit) ? "" : "; the holder failed"}`
                    )
              )
            )
          )
        )
      )
    })
