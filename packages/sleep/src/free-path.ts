import type { StorageFailure } from "@memhtml/contracts/errors"
import { withCollisionOrdinal } from "@memhtml/contracts/slug"
import { Effect } from "effect"

import { readFileBytes } from "./edits.js"
import type { PhaseEnv } from "./env.js"

/**
 * Free-path probing for a phase that WRITES a new file at a slug-derived path.
 *
 * A slug is a pure function of a title, so two different memories can slug to one path: a title
 * restated on a later night, two claims differing only past `SLUG_MAX_LENGTH`, or two batches of one
 * run whose canonicals the model titled identically. A write that does not probe first silently
 * replaces whatever occupies the path — a memory a human hand-corrected, an arc holding weeks of
 * synthesis — and the commit lands as a MODIFY carrying no mention that anything was lost.
 * `trace-consolidation` reproduced that live (2026-08-08) and grew its own private probe; this module
 * is the same rule for the phases that synthesize titles, `compress` and `arc-synthesis`.
 *
 * **DISK IS AUTHORITATIVE, and `claimed` is only the half disk cannot answer.** A path is taken if
 * EITHER source says so — the same reading `store.freePathFor` and `trace-consolidation`'s `freePath`
 * state. Disk answers for every file that exists, including ones this run already wrote; `claimed`
 * answers for paths this run has allocated whose bytes a probe might not see (a candidate allocated
 * but not yet flushed, a dry pass that must still not double-allocate). Probing one without the other
 * is the exact bug an earlier `trace-consolidation` had.
 *
 * The suffix goes through `withCollisionOrdinal`, so it lands INSIDE the slug length budget. Plain
 * concatenation pushes a maximum-length stem past `SLUG_MAX_LENGTH`, which `isSlug` rejects.
 *
 * Exhaustion returns `undefined` and the caller SKIPS the write. A fall-through path would be taken
 * unconditionally on the thousand-and-first collision and overwrite whatever sat there, forever.
 */

/** Collision ordinals tried before a candidate is refused. The store's own ceiling, verbatim. */
export const FREE_PATH_ORDINAL_LIMIT = 1000

/**
 * The lowest-ordinal `.html` path under `directory` for `stem` that holds no file and has not been
 * claimed in this run, or `undefined` when the ordinals are exhausted.
 *
 * Ordinal 1 is the bare `<directory>/<stem>.html`, matching `withCollisionOrdinal`'s convention, so
 * the ordinary no-collision case produces byte-identical paths to an unprobed write.
 */
export const freePathIn = (
  env: PhaseEnv,
  directory: string,
  stem: string,
  claimed: ReadonlySet<string>
): Effect.Effect<string | undefined, StorageFailure> =>
  Effect.gen(function* () {
    for (let ordinal = 1; ordinal <= FREE_PATH_ORDINAL_LIMIT; ordinal += 1) {
      const candidate = `${directory}/${withCollisionOrdinal(stem, ordinal)}.html`
      if (claimed.has(candidate)) continue
      if ((yield* readFileBytes(env, candidate)) === undefined) return candidate
    }
    return undefined
  })
