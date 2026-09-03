import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The agent's system prompt, read from `prompts/instructions.md` at the package root.
 *
 * A FILE rather than a string constant, because the prompt is the corpus's editorial policy and is
 * reproduced verbatim on the docs site (`apps/docs/.../internals/the-consolidator.md`, held equal by
 * `apps/docs/tests/reproduced-sources.test.ts`); one authored Markdown file is the thing both read.
 * It ships as an asset beside `dist/` (`tsdown.config.ts` copies `prompts/`, and
 * `tests-integration/tests/packaging.test.ts` carries the claim), resolved from this module's own
 * location so the same expression finds it in the workspace and in an install.
 */

/** This package's root, resolved from this module rather than from `process.cwd()`. */
const packageRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const instructionsPath = (): string => join(packageRoot(), "prompts", "instructions.md")

let cached: string | undefined

/** The prompt text, read once per process. */
export const consolidatorInstructions = (): string => {
  cached ??= readFileSync(instructionsPath(), "utf8")
  return cached
}
