import { describe, expect, it } from "vitest"

import { parseSidecar, renderSidecar, round4 } from "../src/sidecar.js"

/**
 * The state sidecar's bytes: `memhtml state export` writes them and `memhtml state import` reads them
 * back, so the pair has to round-trip, stay byte-stable over an unchanged plane, and survive a
 * truncated file by restoring what it does hold.
 */
describe("the state sidecar", () => {
  const rows = [
    {
      path: "areas/b.html",
      access_count: 3,
      reinforcement_count: 1,
      outcome_score: 0.30000000000000004,
      last_accessed_at: "2026-08-01T00:00:00Z",
      last_reinforced_at: null,
      updated_at: "2026-08-01T00:00:00Z"
    },
    {
      path: "areas/a.html",
      access_count: 0,
      reinforcement_count: 0,
      outcome_score: -0,
      last_accessed_at: null,
      last_reinforced_at: null,
      updated_at: "2026-08-01T00:00:00Z"
    }
  ]

  it("rounds to four decimals and normalizes negative zero", () => {
    // Four decimals is the domain's fixed-point grid, so a value on the grid is exact and a fifth
    // digit is float noise that would change the file's bytes without changing its meaning.
    expect(round4(0.30000000000000004)).toBe(0.3)
    expect(round4(-0)).toBe(0)
    expect(Object.is(round4(-0), 0)).toBe(true)
  })

  it("renders one JSON object per line with a trailing newline, and is byte-stable", () => {
    const rendered = renderSidecar(rows)
    expect(rendered.endsWith("\n")).toBe(true)
    expect(rendered.split("\n").filter((line) => line !== "")).toHaveLength(2)
    // Byte-stable: the same rows render identically, so an unchanged plane commits nothing.
    expect(renderSidecar(rows)).toBe(rendered)
    // The rounding reached the bytes.
    expect(rendered).toContain('"outcomeScore":0.3')
    expect(rendered).not.toContain("0.30000000000000004")
    expect(renderSidecar([])).toBe("")
  })

  it("round-trips through parse, skipping a corrupt line rather than failing the file", () => {
    const rendered = renderSidecar(rows)
    const parsed = parseSidecar(rendered)
    expect(parsed.skipped).toBe(0)
    expect(parsed.entries.map((entry) => entry.path)).toEqual(["areas/b.html", "areas/a.html"])
    expect(parsed.entries[0]?.outcomeScore).toBe(0.3)

    /**
     * A truncated file must restore every row it DOES hold. The sidecar is the only durable copy of
     * this plane, so refusing the whole file would turn a partial loss into a total one.
     */
    const damaged = `${rendered}{"path":"areas/c.html","accessCo`
    const recovered = parseSidecar(damaged)
    expect(recovered.skipped).toBe(1)
    expect(recovered.entries).toHaveLength(2)

    // A line with no path is not a row.
    expect(parseSidecar('{"accessCount":1}\n').entries).toHaveLength(0)
  })
})
