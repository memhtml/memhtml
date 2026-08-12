import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const DIST = new URL("../dist", import.meta.url).pathname

/**
 * Every module specifier that survives compilation, per emitted file. A type-only import is
 * erased by `verbatimModuleSyntax`, so what this reads is exactly what Node would resolve at
 * runtime.
 */
const runtimeImports = async (): Promise<ReadonlyMap<string, ReadonlyArray<string>>> => {
  const entries = await readdir(DIST, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name))

  // `from` needs a preceding word boundary: this package's own string literal
  // `"memhtml-valid-from"` ends in the keyword, and a bare `from["']` matches inside it and then
  // captures the rest of the line as a phantom specifier.
  const pattern = /(?:(?<![\w$-])from\s*|require\(\s*|import\(\s*)["']([^"'\n]+)["']/g
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
 * `@memhtml/html` is the format layer: parse, serialize, hash. A driver, an AWS client, or a git
 * call reaching it would make the format untestable without infrastructure and would let a
 * caller's I/O failure surface as a parse error. `parse5`, `effect`, `@memhtml/contracts`,
 * `node:crypto`, and `highlight.js` are the permitted imports; relative paths are the package's
 * own modules.
 *
 * `highlight.js` passes the same bar the other four do: pure, synchronous, no I/O and no ambient
 * state, so it cannot make a parse fail for an environmental reason. It is here because the fence
 * language detector (`src/detect.ts`) is part of the write path, and the write path is this
 * package. It is pinned EXACTLY rather than by range, because its relevance scores are what the
 * detector's threshold was calibrated against.
 *
 * `node:module` is `createRequire` only — the machinery that lets `detect.ts` load highlight.js
 * LAZILY (first detection, not module load) while staying synchronous. It reaches nothing the
 * eager import would not; the read path just stops paying ~100ms/~12MB for grammars it never runs.
 */
const ALLOWED = [
  "parse5",
  "effect",
  "@memhtml/contracts",
  "node:crypto",
  "highlight.js",
  "node:module"
]

const FORBIDDEN = [
  "node:sqlite",
  "@aws-sdk",
  "@aws/",
  "node:fs",
  "node:child_process",
  "@memhtml/domain",
  "@memhtml/store",
  "@memhtml/index",
  "@memhtml/llm"
]

describe("html layering", () => {
  it("emits at least one module to inspect", async () => {
    const byFile = await runtimeImports()
    expect(byFile.size).toBeGreaterThan(0)
  })

  it("imports nothing outside the permitted set at runtime", async () => {
    const byFile = await runtimeImports()
    for (const [file, specifiers] of byFile) {
      for (const specifier of specifiers) {
        const allowed = ALLOWED.some(
          (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
        )
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

  it("keeps the domain's ranking math out of the format layer", async () => {
    const byFile = await runtimeImports()
    for (const file of byFile.keys()) {
      const source = await readFile(file, "utf8")
      for (const symbol of ["RRF_K", "MMR_LAMBDA", "cosine"]) {
        expect(source.includes(symbol), `${file} mentions ${symbol}`).toBe(false)
      }
    }
  })
})
