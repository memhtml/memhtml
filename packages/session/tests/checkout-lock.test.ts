import { mkdir, mkdtemp, rm, stat, symlink, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKOUT_LOCK_STALE_MS, CHECKOUT_LOCKED } from "@memhtml/contracts"
import { Effect, Exit, Fiber, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { checkoutLockTarget, withCheckoutLock } from "../src/checkout-lock.js"

/**
 * The checkout lock's policy (`@memhtml/contracts` `checkout-lock.ts`) through the session's wrapper:
 * a bounded wait, a typed failure at its end, a release on every exit, reentrancy within a fiber,
 * reclaim of a lock a killed holder left, and one lock per store however its path is spelled.
 *
 * Every holder below that stands for ANOTHER writer runs in a root fiber of its own
 * (`Effect.runPromise` / `runFork`), so it does not inherit the reentrancy reference.
 *
 * Mutation notes, each run once with the change applied and the named case red:
 * - `Effect.retry(...)` dropped -> "waits for a holder that releases within the budget".
 * - `Schedule.upTo({ duration })` dropped -> "gives up with checkout.locked" (it waits forever and
 *   the case times out).
 * - `acquireRelease`'s release replaced with `Effect.void` -> "releases the lock on success, failure,
 *   defect, and interruption".
 * - `if (held.has(target)) return yield* effect` dropped -> "is reentrant" (the nested call waits on
 *   its own lock and fails with checkout.locked).
 */

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-checkout-lock-"))
  roots.push(root)
  return root
}

const lockDir = (root: string): string => join(root, ".memhtml", "checkout.lock")

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

/** Another writer holding the lock until `release()` is called. Resolves `held` once it holds it. */
const holdFrom = (root: string) => {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let markHeld: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    markHeld = resolve
  })
  const done = Effect.runPromise(
    withCheckoutLock(
      root,
      Effect.promise(async () => {
        markHeld()
        await released
      })
    )
  )
  return { held, release, done }
}

describe("withCheckoutLock", () => {
  it("targets <root>/.memhtml/checkout, the path the store's twin computes", () => {
    expect(checkoutLockTarget("/srv/store")).toBe("/srv/store/.memhtml/checkout")
    expect(checkoutLockTarget("/srv/store/")).toBe("/srv/store/.memhtml/checkout")
  })

  it("waits for a holder that releases within the budget, then runs", async () => {
    const root = await tempRoot()
    const other = holdFrom(root)
    await other.held
    setTimeout(other.release, 300)
    const began = Date.now()
    const value = await Effect.runPromise(withCheckoutLock(root, Effect.succeed("ran")))
    expect(value).toBe("ran")
    expect(Date.now() - began).toBeGreaterThanOrEqual(250)
    await other.done
    expect(await exists(lockDir(root))).toBe(false)
  })

  it("gives up with checkout.locked once the wait runs out, and leaves the holder's lock alone", async () => {
    const root = await tempRoot()
    const other = holdFrom(root)
    await other.held
    const began = Date.now()
    const result = await Effect.runPromise(
      Effect.result(withCheckoutLock(root, Effect.succeed("ran"), { waitMs: 400 }))
    )
    const waited = Date.now() - began
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "StorageFailure",
      operation: CHECKOUT_LOCKED
    })
    expect(waited).toBeGreaterThanOrEqual(350)
    expect(waited).toBeLessThan(3_000)
    expect(await exists(lockDir(root))).toBe(true)
    other.release()
    await other.done
  })

  it("releases the lock on success, failure, defect, and interruption", async () => {
    const root = await tempRoot()
    const free = () =>
      Effect.runPromise(withCheckoutLock(root, Effect.succeed(true), { waitMs: 0 }))

    await Effect.runPromise(withCheckoutLock(root, Effect.void))
    expect(await exists(lockDir(root))).toBe(false)

    const failed = await Effect.runPromiseExit(withCheckoutLock(root, Effect.fail("no")))
    expect(Exit.isFailure(failed)).toBe(true)
    expect(await free()).toBe(true)

    const died = await Effect.runPromiseExit(withCheckoutLock(root, Effect.die("boom")))
    expect(Exit.isFailure(died)).toBe(true)
    expect(await free()).toBe(true)

    const fiber = Effect.runFork(withCheckoutLock(root, Effect.never))
    while (!(await exists(lockDir(root)))) await new Promise((resolve) => setTimeout(resolve, 10))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(await exists(lockDir(root))).toBe(false)
    expect(await free()).toBe(true)
  })

  it("an interrupt while waiting strands no lock", async () => {
    const root = await tempRoot()
    const other = holdFrom(root)
    await other.held
    const waiter = Effect.runFork(withCheckoutLock(root, Effect.never))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await Effect.runPromise(Fiber.interrupt(waiter))
    other.release()
    await other.done
    // Neither the holder's lock nor one the interrupted waiter might have taken is left behind.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await exists(lockDir(root))).toBe(false)
  })

  it("is reentrant within one fiber: a nested call runs without waiting on itself", async () => {
    const root = await tempRoot()
    const nested = withCheckoutLock(
      root,
      withCheckoutLock(root, Effect.succeed("inner"), { waitMs: 200 }),
      { waitMs: 200 }
    )
    expect(await Effect.runPromise(nested)).toBe("inner")
    expect(await exists(lockDir(root))).toBe(false)
  })

  it("reclaims a lock a killed holder left once it is stale, and refuses a fresh one", async () => {
    const root = await tempRoot()
    await mkdir(lockDir(root), { recursive: true })
    const fresh = await Effect.runPromise(
      Effect.result(withCheckoutLock(root, Effect.void, { waitMs: 0 }))
    )
    expect(Result.isFailure(fresh)).toBe(true)
    const past = new Date(Date.now() - CHECKOUT_LOCK_STALE_MS - 5_000)
    await utimes(lockDir(root), past, past)
    await Effect.runPromise(withCheckoutLock(root, Effect.void, { waitMs: 0 }))
    expect(await exists(lockDir(root))).toBe(false)
  })

  it("is one lock through a symlink and through the real path", async () => {
    const real = await tempRoot()
    const links = await tempRoot()
    const linked = join(links, "store")
    await symlink(real, linked)
    const other = holdFrom(real)
    await other.held
    const result = await Effect.runPromise(
      Effect.result(withCheckoutLock(linked, Effect.void, { waitMs: 200 }))
    )
    expect(Result.isFailure(result)).toBe(true)
    other.release()
    await other.done
  })
})
