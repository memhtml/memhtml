/**
 * The bounded stderr every child spawned from this package keeps, and the slice a failure message
 * renders from it.
 *
 * Two children are spawned here — `eve build` (`agent-build.ts`) and `eve start` (`client.ts`) — and
 * each reads its child's stderr for exactly one purpose: to carry the last thing the child said into a
 * typed failure. Both halves of that are load-bearing, and they are only correct together, which is why
 * they live in one module rather than as a constant per call site:
 *
 * - **Retention is a TAIL.** An unbounded accumulator grows for the child's whole life, and the start
 *   child's handle lives for a full turn — ten minutes — so a chatty server would hold every byte it
 *   ever logged in this process's heap.
 * - **The message renders that same TAIL.** A message sliced from the HEAD of a capped buffer shows
 *   the bytes from just before the cap first bit, which for any child that wrote past the cap is a
 *   window ending {@link STDERR_TAIL_CHARS} before the fatal line: a cap that works and a diagnostic
 *   that defeats it. What a dying child wrote last is at the END.
 */

/**
 * How much of a child's stderr is retained.
 *
 * The stream is read only so a failure can carry the child's last words, and
 * {@link stderrMessageTail} takes 400 characters off it — so retention past that is context, not data.
 * 64 KiB keeps the recent context and bounds the hold regardless of how long the child runs.
 */
export const STDERR_TAIL_CHARS = 64 * 1024

/** How much of the retained tail rides into a failure message: enough for a stack, not for a log. */
export const STDERR_MESSAGE_CHARS = 400

/** Append a chunk to a retained tail, keeping the LAST {@link STDERR_TAIL_CHARS} characters. */
export const appendStderrTail = (retained: string, chunk: string): string =>
  (retained + chunk).slice(-STDERR_TAIL_CHARS)

/** The END of a retained tail, which is where a dying child's fatal line is. */
export const stderrMessageTail = (retained: string): string => retained.slice(-STDERR_MESSAGE_CHARS)
