import { createHash } from "node:crypto"

import { placementFor } from "@memhtml/contracts/paths"
import { SLUG_FALLBACK, SLUG_MAX_LENGTH, slugify } from "@memhtml/contracts/slug"

/**
 * The path algebra of a machine-detected task: how `task list --detected` recognizes one from its path
 * alone, with no `author` column and no commit message to read.
 *
 * A detected task is an ordinary task and files where one files. `placementFor` routes a workspaceless
 * task to `areas/inbox/tasks`, and `memhtml doctor` reports inbox depth, so a noisy detector shows up
 * as a health signal on the surface built to carry one. A parallel `detected/` tree would be a second
 * place to look for the same work and would sit outside the four PARA buckets the indexer reads.
 */
export const DETECTED_TASK_DIR = placementFor({ memoryType: "task" })

/** The filename prefix that makes a detected task recognizable from its path alone. */
export const DETECTION_PREFIX = "det-"

/**
 * Hex characters of the digest carried in a path.
 *
 * Twelve, which is git's own abbreviated-sha width. It leaves 48 bits against a queue whose size a cap
 * holds in the tens, and it costs 17 characters of the 80-character slug budget rather than 68.
 */
export const DETECTION_DIGEST_CHARS = 12

/**
 * The slug budget left for a title once the prefix and digest are spent.
 *
 * Derived, not chosen, so the two cannot drift into a stem that breaches `SLUG_MAX_LENGTH`, which
 * `isSlug` rejects and every other path in the corpus satisfies.
 */
const STEM_SLUG_CHARS = SLUG_MAX_LENGTH - DETECTION_PREFIX.length - DETECTION_DIGEST_CHARS - 1

/**
 * A finding's stable key: `det-<12 hex>` over the detector's name and a canonical finding string.
 *
 * The finding string is the CALLER's canonical form of what it noticed, and sorting its unordered
 * fields is the caller's job. What this adds is the normalization every caller would otherwise repeat:
 * NFC, lowercase, collapsed whitespace. So a finding restated with different spacing keys the same.
 *
 * The detector's name is INSIDE the digest, so two detectors that happen to canonicalize one finding
 * identically still own separate tasks.
 *
 * **The separator is `\u0000`, written as the escape and not as the byte.** A NUL cannot occur in a
 * normalized detector name or finding, which is what makes it an unambiguous delimiter: without one,
 * `("ab", "c")` and `("a", "bc")` would digest the same input and share a task. Spelling it as a RAW
 * NUL in the source made the file `data` rather than text, and `grep` silently skips a file it reads
 * as binary. The escape hands `sha256` byte-identical input, so no key moves.
 */
export const detectionKey = (detector: string, finding: string): string =>
  `${DETECTION_PREFIX}${createHash("sha256")
    .update(`${normalizeFinding(detector)}\u0000${normalizeFinding(finding)}`, "utf8")
    .digest("hex")
    .slice(0, DETECTION_DIGEST_CHARS)}`

/** NFC, lowercase, collapsed whitespace, trimmed. The pre-digest form. */
const normalizeFinding = (text: string): string =>
  text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

/** The path a key and a title name. Total, and unique per key whatever the title slugs to. */
export const detectedTaskPath = (key: string, title: string): string => {
  const stem = slugify(title).slice(0, STEM_SLUG_CHARS).replace(/-+$/, "")
  return `${DETECTED_TASK_DIR}/${key}-${stem === "" ? SLUG_FALLBACK : stem}.html`
}

/** The key a detected task's path carries, or `undefined` when the path is not one. */
export const detectionKeyOf = (path: string): string | undefined => {
  const filename = path.slice(path.lastIndexOf("/") + 1)
  const match = new RegExp(
    `^(${DETECTION_PREFIX}[0-9a-f]{${String(DETECTION_DIGEST_CHARS)}})-`
  ).exec(filename)
  return match?.[1]
}

/** True when a path is a detected task's. */
export const isDetectedTaskPath = (path: string): boolean => detectionKeyOf(path) !== undefined
