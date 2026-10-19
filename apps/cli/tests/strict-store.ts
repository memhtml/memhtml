import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  decodeStoreConfig,
  STORE_CONFIG_FILE,
  type StorePolicy,
  storePolicyOf
} from "@memhtml/contracts"
import { makeGit } from "@memhtml/store"
import { Effect } from "effect"

/**
 * A strict store's `memhtml.config.json`: run narratives and review output refused, every record
 * anchored, the v1 doors closed inside a run, four writer-bucket patterns, the default quota. The
 * CLI's write-bar and curator tests run under it, because the library's own policy refuses nothing
 * and names no bucket; the same literal is restated in `@memhtml/session`'s and
 * `@memhtml/curator`'s test helpers, one package each.
 */
export const STRICT_STORE_CONFIG = {
  writeBar: {
    refusedTypes: [
      {
        type: "episodic",
        reason: "an episodic record narrates one run; runs belong in the trace index, not the store"
      },
      { type: "verdict", reason: "a verdict is review output, not a memory" }
    ],
    requireAnchor: true
  },
  v1Doors: "closed-in-session",
  curator: {
    writerBuckets: [
      "*-import",
      "working-thread*",
      "*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]",
      "trace-consolidation"
    ],
    placementQuota: 60
  }
} as const

const strictDecoded = decodeStoreConfig(JSON.stringify(STRICT_STORE_CONFIG))
if (!strictDecoded.ok)
  throw new Error(`STRICT_STORE_CONFIG does not decode: ${strictDecoded.reason}`)

/** {@link STRICT_STORE_CONFIG} as the effective policy. */
export const STRICT_POLICY: StorePolicy = storePolicyOf(strictDecoded.config).policy

/**
 * Write a policy file at `root` (the strict one unless `config` says otherwise; a string is
 * written verbatim, so a test can plant a malformed file) and, with `commit`, commit it the way a
 * store tracks its policy.
 */
export const writeStoreConfig = async (
  root: string,
  options: { readonly config?: unknown; readonly commit?: boolean } = {}
): Promise<string> => {
  const path = join(root, STORE_CONFIG_FILE)
  const config = options.config ?? STRICT_STORE_CONFIG
  await writeFile(
    path,
    typeof config === "string" ? config : `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  )
  if (options.commit === true) {
    const git = makeGit(root)
    await Effect.runPromise(git.run(["add", "--", STORE_CONFIG_FILE]).pipe(Effect.orDie))
    await Effect.runPromise(
      git
        .run(["commit", "-q", "-m", "chore: store policy", "--", STORE_CONFIG_FILE])
        .pipe(Effect.orDie)
    )
  }
  return path
}
