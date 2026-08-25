#!/usr/bin/env node
/**
 * The README's figures, rendered from the same `.d2` sources the docs site renders to SVG.
 *
 * GitHub renders Mermaid natively and renders D2 not at all, so a `.d2` fence at the repo's front door
 * would show a first-time visitor raw source. D2 0.7.1's ASCII renderer resolves that without a second
 * drawing: `d2 --ascii-mode=standard` turns one source into a monospace figure a fenced block can
 * carry. The site's SVG and the README's figure are therefore the same statement about the system, and
 * the pair cannot drift — two hand-maintained drawings of one system is the defect this avoids.
 *
 * The output is COMMITTED, between the marker comments below, because a reader of the raw README on
 * GitHub gets no build step. `apps/docs/tests/figures.test.ts` runs this with `--check` and fails on
 * drift, which is the same posture as `AGENTS.md`: generated, committed, and gated by a test rather
 * than by a pipeline step nobody watches.
 *
 * Trailing spaces are stripped from every line. D2 pads each row out to the drawing's full width, and
 * an editor or a formatter that trims them would otherwise show this file as drifted forever.
 *
 *   node scripts/readme-figures.mjs            rewrite README.md in place
 *   node scripts/readme-figures.mjs --check    exit 1 if the committed figures are stale
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Resolved from import.meta.url, not process.cwd(), so the task is correct from any directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const figureDir = join(repoRoot, "apps", "docs", "src", "content", "docs", "internals", "_figures")
const readmePath = join(repoRoot, "README.md")

/**
 * The figures the README carries, and nothing else.
 *
 * Six more `.d2` sources sit beside these in `_figures/`; they are site-only, because a figure that
 * needs an eight-node dependency graph or a diamond does not survive the ASCII renderer. The four here
 * are authored against its limits: short ASCII-only labels, no `\n`, and none of the shapes it draws
 * in asterisks.
 */
const FIGURES = ["system-topology", "three-actors", "memory-lifecycle", "sleep-branch"]

const renderAscii = (name) => {
  const source = join(figureDir, `${name}.d2`)
  let stdout
  try {
    stdout = execFileSync(
      "d2",
      ["--ascii-mode=standard", "--stdout-format", "txt", source, "-"],
      // cwd is the figure directory so `...@_register` resolves; stderr is inherited so a compile
      // error reaches the operator instead of being swallowed into a diff.
      { cwd: figureDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    )
  } catch (cause) {
    const hint =
      cause.code === "ENOENT"
        ? "the `d2` binary is not on PATH — run `mise install`, which pins 0.7.1"
        : `d2 exited ${cause.status ?? "abnormally"} on ${name}.d2`
    throw new Error(`cannot render ${name}: ${hint}`)
  }
  const lines = stdout
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
  return lines.join("\n")
}

/** The fenced block, plus its markers, exactly as it must appear in the README. */
const blockFor = (name, ascii) =>
  `<!-- figure:${name} -->\n\`\`\`text\n${ascii}\n\`\`\`\n<!-- /figure:${name} -->`

const rewrite = (readme) => {
  let next = readme
  for (const name of FIGURES) {
    const open = `<!-- figure:${name} -->`
    const close = `<!-- /figure:${name} -->`
    const from = next.indexOf(open)
    const to = next.indexOf(close)
    if (from < 0 || to < 0 || to < from) {
      throw new Error(
        `README.md carries no \`${open}\` … \`${close}\` pair. ` +
          "Every figure this script owns is delimited by that pair; add it where the figure belongs."
      )
    }
    next = next.slice(0, from) + blockFor(name, renderAscii(name)) + next.slice(to + close.length)
  }
  return next
}

const readme = readFileSync(readmePath, "utf8")
const rendered = rewrite(readme)
const checking = process.argv.includes("--check")

if (rendered === readme) {
  console.log(`README figures up to date: ${FIGURES.join(", ")}`)
  process.exit(0)
}

if (checking) {
  console.error(
    "README figures are STALE against their `.d2` sources.\n" +
      "Run `mise run figures:readme` and commit the result."
  )
  process.exit(1)
}

writeFileSync(readmePath, rendered)
console.log(`README figures rewritten: ${FIGURES.join(", ")}`)
