import type { Ruling, Verdict } from "./types.js"

/**
 * Rulings arrive as JSONL, one object per line, in the shape the 2026-09-24 audit wrote them:
 * `{ "path": "areas/inbox/x.html", "verdict": "fold", "theme": "loop-guard", "reason": "..." }`.
 * Blank lines are skipped. A line that is not an object with a path and a known verdict is an
 * error naming its line number, because a rulings file that half-parses would archive half a list.
 */

export const VERDICTS: ReadonlyArray<Verdict> = ["keep", "fold", "trace", "archive"]

const isVerdict = (value: unknown): value is Verdict =>
  typeof value === "string" && (VERDICTS as ReadonlyArray<string>).includes(value)

export const parseRulings = (text: string): ReadonlyArray<Ruling> => {
  const rulings: Array<Ruling> = []
  const lines = text.split("\n")
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`rulings line ${String(index + 1)} is not JSON`)
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`rulings line ${String(index + 1)} is not an object`)
    }
    const row = parsed as Record<string, unknown>
    if (typeof row.path !== "string" || row.path === "") {
      throw new Error(`rulings line ${String(index + 1)} has no path`)
    }
    if (!isVerdict(row.verdict)) {
      throw new Error(
        `rulings line ${String(index + 1)} (${row.path}) has verdict ${JSON.stringify(row.verdict)}; one of ${VERDICTS.join(", ")}`
      )
    }
    rulings.push({
      path: row.path.replace(/^\/+/, ""),
      verdict: row.verdict,
      ...(typeof row.theme === "string" && row.theme !== "" ? { theme: row.theme } : {}),
      ...(typeof row.reason === "string" && row.reason !== "" ? { reason: row.reason } : {})
    })
  }
  return rulings
}

/** The last ruling per path wins, so a later file can override an earlier one by appending. */
export const rulingsByPath = (rulings: ReadonlyArray<Ruling>): ReadonlyMap<string, Ruling> => {
  const byPath = new Map<string, Ruling>()
  for (const ruling of rulings) byPath.set(ruling.path, ruling)
  return byPath
}
