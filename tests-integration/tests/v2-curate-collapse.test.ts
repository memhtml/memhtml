import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { snapshotPathFor } from "@memhtml/snapshot"
import { makeGit } from "@memhtml/store"
import { configureIdentity } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterAll, describe, expect, it } from "vitest"

import { runBuilt } from "./spawned.js"

/**
 * `memhtml curate collapse --model fake` through the BUILT binary, for the one property only a real
 * process shows: stdout carries exactly one envelope, whatever the run logs on the way.
 *
 * The held head a collapse reads (`makeHeadCache` in `curate-collapse.ts`) and the curator's tools
 * (`bindTools` in `curate-run.ts`) used to run their effects on a runtime of their own, outside the
 * command's stderr logger, so a line one of them logged reached stdout ahead of the envelope. The
 * case that shows it: the second collapse's held head finds, beside the first one's snapshot, a
 * snapshot of a commit the repository does not have (one gc'd with its branch), and the snapshot
 * lookup passes over it with git's `merge-base exited 128` line and a warning.
 *
 * (Mutation: `makeHeadCache` loading through `Effect.runPromise` -> red: the second collapse's
 * stdout opens with the `git merge-base` line and does not parse.)
 */

const AT = "2026-09-20T12:00:00Z"
const VERIFY = [
  "Verify against the primary source before asserting a result or claiming completion.",
  "Always verify the primary source before asserting completion of a result.",
  "Before claiming completion, verify the result against its primary source.",
  "Assert a result only after verifying it against the primary source."
]
const FILES = [
  ...VERIFY.map((claim, index) => ({
    path: `areas/inbox/verify-${String(index)}.html`,
    html: renderTemplate({
      title: `Verify before asserting ${String(index)}`,
      claim,
      body: [`Seen on run ${String(index)}.`],
      memoryType: "user_preference",
      at: AT,
      tags: ["verification"]
    })
  })),
  ...["a", "b"].map((side, index) => ({
    path: `areas/inbox/capital-${side}.html`,
    html: renderTemplate({
      title: `Capital of India ${side}`,
      claim: "The capital of India is New Delhi.",
      ...(index === 1 ? { body: ["Restated with a body."] } : {}),
      memoryType: "semantic",
      at: AT
    })
  }))
]

interface CollapseEnvelope {
  readonly type: string
  readonly data: { readonly summary: { readonly committed: number } }
}

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A fresh repo with the fixture committed on `main`. */
const freshRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-collapse-stdout-"))
  roots.push(root)
  const git = makeGit(root)
  await Effect.runPromise(git.run(["init", "-q", "-b", "main", "."]).pipe(Effect.orDie))
  await Effect.runPromise(configureIdentity(git))
  for (const file of FILES) {
    const target = join(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await Effect.runPromise(git.run(["add", "-A"]).pipe(Effect.orDie))
  await Effect.runPromise(git.run(["commit", "-q", "-m", "collapse fixture"]).pipe(Effect.orDie))
  return root
}

describe("curate collapse over the built binary", () => {
  it("writes exactly one envelope to stdout for a collapse that lands clusters, and logs to stderr", async () => {
    const root = await freshRepo()
    const collapse = (ref: string) =>
      runBuilt(root, ["curate", "collapse", "--model", "fake", "--ref", ref])
    const first = await collapse("curate/collapse-one")
    // Only its name is read before the lookup passes over it, so the bytes do not matter.
    const gone = snapshotPathFor(root, "f".repeat(40))
    await mkdir(dirname(gone), { recursive: true })
    await writeFile(gone, "a snapshot of a commit this repository does not have", "utf8")
    const second = await collapse("curate/collapse-two")
    for (const result of [first, second]) {
      expect(result.exitCode, result.stderr).toBe(0)
      // `JSON.parse` refuses anything before or after the one object, so this is the whole rule.
      const body = JSON.parse(result.stdout) as CollapseEnvelope
      expect(body.type).toBe("curate.collapse")
      expect(body.data.summary.committed).toBeGreaterThan(0)
    }
    // The second run did log on the load path; the lines went where logs go.
    expect(second.stderr).toContain("git merge-base exited 128")
    expect(second.stderr).toContain("passing over it")
    expect(second.stdout).not.toContain("git merge-base")
    // The first run's snapshot is not an ancestor of `main` either, and "no" logs nothing.
    expect(second.stderr).not.toContain("git merge-base exited 1:")
  }, 180_000)
})
