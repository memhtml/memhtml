import { createReadStream } from "node:fs"
import { basename, dirname } from "node:path"
import { Effect } from "effect"
import { PROJECTS_DIR, SUBAGENTS_DIR } from "./discover.js"
import {
  type Accumulator,
  emptyAccumulator,
  finalizeExtract,
  foldLine,
  type SessionExtract
} from "./extract.js"

/**
 * The streaming half of the parser. It runs `createReadStream` over one transcript and splits the
 * buffer into lines.
 *
 * Line-at-a-time reading is required here. The corpus is 3.67 GB across 5,387 files with a 37 MB
 * maximum, and `readFile` on the tail of that distribution would hold a whole transcript plus its
 * parsed form in memory at once. Peak memory here is one chunk plus one line, whatever the file's
 * size.
 */

/** What one file's scan consumed, alongside the extract. */
export interface ParseResult {
  readonly extract: SessionExtract
  /** Byte offset the read began at, 0 for a full scan. */
  readonly startByte: number
  /**
   * Bytes occupied by *newline-terminated* lines, terminators included. The next read starts at
   * `startByte + bytesRead`, so this is what keeps a tail landing on a record boundary.
   */
  readonly bytesRead: number
}

/** How the reader learns a file's `slug` when the caller has not already discovered it. */
export interface FileIdentity {
  readonly slug: string
}

/**
 * The `projects/<slug>` directory a transcript sits under, derived from its path.
 *
 * A sidecar sits two levels deeper (`<slug>/<sessionId>/subagents/`), so the slug is the
 * grandparent's parent there. Returns `""` for a path outside the tree. The extract still carries
 * a real `session_id` from the records, so an unslugged file indexes rather than being lost.
 */
export const slugFromPath = (filePath: string): string => {
  const parent = dirname(filePath)
  if (basename(parent) === SUBAGENTS_DIR) {
    const slugDir = dirname(dirname(parent))
    return basename(slugDir) === PROJECTS_DIR ? "" : basename(slugDir)
  }
  return basename(parent) === PROJECTS_DIR ? "" : basename(parent)
}

/**
 * Stream a transcript from `startByte` and fold it into a {@link SessionExtract}.
 *
 * Cannot fail. A missing file, a permission rejection, a truncated line, and a line of binary
 * garbage all degrade to counters on the extract. This runs over thousands of files written by a
 * live process, so one unreadable transcript costs that transcript's rows and not the whole run.
 * The counters are what an operator reads in place of an error.
 *
 * `startByte` is a 0-based byte offset and must be one {@link watermarkPlan} produced. A
 * caller-invented offset can land mid-line, and that first partial line is then counted as
 * malformed rather than recovered.
 */
export const parseSessionFile = (
  filePath: string,
  startByte = 0,
  identity?: FileIdentity
): Effect.Effect<ParseResult, never> =>
  Effect.tryPromise({
    try: async () => {
      const accumulator = emptyAccumulator()
      const bytesRead = await foldStream(filePath, startByte, accumulator)
      return { accumulator, bytesRead }
    },
    catch: (cause) => cause
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`traces.parse could not read ${filePath}: ${describe(cause)}`).pipe(
        Effect.as({ accumulator: emptyAccumulator(), bytesRead: 0 })
      )
    ),
    Effect.map(({ accumulator, bytesRead }) => ({
      extract: finalizeExtract(accumulator, {
        filePath,
        slug: identity?.slug ?? slugFromPath(filePath)
      }),
      startByte,
      bytesRead
    })),
    Effect.withSpan("traces.parseSessionFile")
  )

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

const NEWLINE = 0x0a

/**
 * Fold every newline-terminated line and return the bytes those lines occupied.
 *
 * Splitting the raw buffer instead of handing the stream to `node:readline` is what makes the
 * returned byte count exact, and the count is what the watermark depends on. `readline` strips the
 * terminator without saying whether the final line had one, so a scan that races a live append
 * would count the partial tail as consumed, the watermark would advance past it, and the completed
 * record would be read next time with its head missing. That loses a turn on exactly the files a
 * daily run touches. Here an unterminated trailing line is neither folded nor counted, so the next
 * tail re-reads it whole.
 *
 * A CRLF transcript leaves `\r` on the end of each line, which `JSON.parse` accepts as whitespace,
 * so no terminator normalization is needed. Decoding per complete line is safe across chunk
 * boundaries because `0x0a` never occurs inside a UTF-8 multi-byte sequence.
 */
const foldStream = async (
  filePath: string,
  startByte: number,
  accumulator: Accumulator
): Promise<number> => {
  const stream = createReadStream(filePath, { start: startByte })

  let consumed = 0
  let pending = Buffer.alloc(0)
  try {
    for await (const chunk of stream) {
      const combined = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk])
      let lineStart = 0
      for (;;) {
        const at = combined.indexOf(NEWLINE, lineStart)
        if (at === -1) break
        const line = combined.subarray(lineStart, at)
        consumed += line.length + 1
        foldLine(accumulator, line.toString("utf8"))
        lineStart = at + 1
      }
      // Copied rather than a view, so holding the remainder cannot pin the whole chunk.
      pending = Buffer.from(combined.subarray(lineStart))
    }
  } finally {
    stream.destroy()
  }
  return consumed
}
