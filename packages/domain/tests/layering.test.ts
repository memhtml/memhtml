import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const DIST = new URL("../dist", import.meta.url).pathname

/**
 * Every module specifier that survives compilation, per emitted file. A type-only
 * import is erased by `verbatimModuleSyntax`, so what this reads is exactly what
 * Node would resolve at runtime.
 */
const runtimeImports = async (): Promise<ReadonlyMap<string, ReadonlyArray<string>>> => {
  const entries = await readdir(DIST, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name))

  const pattern = /(?:from\s*|require\(\s*|import\(\s*)["']([^"']+)["']/g
  const byFile = new Map<string, ReadonlyArray<string>>()
  for (const file of files) {
    const source = await readFile(file, "utf8")
    byFile.set(
      file,
      [...source.matchAll(pattern)].map((match) => match[1] as string)
    )
  }
  return byFile
}

/**
 * `@memhtml/domain` is the pure-math layer: retention, decay, RRF, MMR, merge guards.
 * A driver, an AWS client, or a filesystem call reaching it would make the math
 * untestable without infrastructure and would let a caller's I/O failure surface as
 * a scoring bug. `effect` is the one permitted import, and relative paths are the
 * package's own modules.
 */
const FORBIDDEN = [
  "node:sqlite",
  "@aws-sdk",
  "@aws/",
  "node:fs",
  "node:child_process",
  "node:path",
  "parse5",
  "@memhtml/"
]

describe("domain layering", () => {
  it("emits at least one module to inspect", async () => {
    const byFile = await runtimeImports()
    expect(byFile.size).toBeGreaterThan(0)
  })

  it("imports nothing but effect at runtime", async () => {
    const byFile = await runtimeImports()
    for (const [file, specifiers] of byFile) {
      for (const specifier of specifiers) {
        const allowed = specifier === "effect" || specifier.startsWith("effect/")
        const relative = specifier.startsWith(".")
        expect(allowed || relative, `${file} imports ${specifier}`).toBe(true)
      }
    }
  })

  it("names no forbidden dependency anywhere in the emitted bytes", async () => {
    const byFile = await runtimeImports()
    for (const file of byFile.keys()) {
      const source = await readFile(file, "utf8")
      for (const forbidden of FORBIDDEN) {
        expect(source.includes(forbidden), `${file} mentions ${forbidden}`).toBe(false)
      }
    }
  })
})
