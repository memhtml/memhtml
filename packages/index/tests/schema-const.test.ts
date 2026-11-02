import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

/**
 * The migration directories are resolved from the module's own URL, and a URL's `pathname`
 * percent-encodes the path: an install under `My Projects/` reads `My%20Projects/`, a directory that
 * does not exist, and on win32 it carries a leading `/E:/`. The built module is copied under a
 * directory whose name has a space, beside the two directories it names, and imported from there.
 *
 * (Mutation: reading `.pathname` instead of `fileURLToPath` in `schema-const.ts` fails both
 * assertions.)
 */
describe("schema-const migration directories", () => {
  const roots: Array<string> = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it("resolve to the directories on disk under a path with a space", async () => {
    const root = await mkdtemp(join(tmpdir(), "memhtml schema "))
    roots.push(root)
    await mkdir(join(root, "dist"))
    await mkdir(join(root, "migrations"))
    await mkdir(join(root, "state-migrations"))
    const built = (name: string): string =>
      fileURLToPath(new URL(`../dist/${name}`, import.meta.url))
    const copied = join(root, "dist", "schema-const.js")
    await copyFile(built("schema-const.js"), copied)
    // The source map travels with the module when the build wrote one, so the import logs no
    // missing-map error.
    await copyFile(built("schema-const.js.map"), `${copied}.map`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      }
    )

    const module = (await import(pathToFileURL(copied).href)) as {
      MIGRATIONS_DIR: string
      STATE_MIGRATIONS_DIR: string
    }
    expect(existsSync(module.MIGRATIONS_DIR)).toBe(true)
    expect(existsSync(module.STATE_MIGRATIONS_DIR)).toBe(true)
  })
})
