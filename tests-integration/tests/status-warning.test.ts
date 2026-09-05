import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"
import { runBuilt } from "./spawned.js"

/**
 * `memhtml status` says a stale index out loud (issue #145).
 *
 * The payload's `indexFresh` is for the caller who parses it. The WARN is for the one who cannot: the
 * operator of a `serve mcp` process, whose agents call `memory_status` through the same `statusReport`
 * and whose only view of the store is the server's stderr. Driven through the BUILT binary because
 * stderr is a process-boundary fact the in-process harness does not return.
 */

interface StatusPayload {
  readonly data: {
    readonly headSha: string
    readonly indexFresh: boolean
    readonly indexHeadSha: string | null
  }
}

/** A minimal memory committed with git alone, so the watermark is left one commit behind HEAD. */
const commitBehindTheIndex = async (cli: Cli, path: string): Promise<void> => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Committed past the index</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-02T00:00:00Z">
<meta name="memhtml-updated" content="2026-08-02T00:00:00Z">
<meta name="memhtml-confidence" content="0.80">
<meta name="memhtml-importance" content="1">
</head>
<body>
<article>
<p><mark>This memory reached the tree without the write path.</mark></p>
</article>
</body>
</html>
`
  await mkdir(dirname(join(cli.root, path)), { recursive: true })
  await writeFile(join(cli.root, path), html, "utf8")
  await cli.git("add", path)
  await cli.git("commit", "-m", "memhtml(write): committed past the index")
}

describe("status warns on stderr while the index is stale", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
    await writeMemory(cli, {
      title: "A memory the index has seen",
      claim: "The write path indexes what it commits."
    })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("names both commits and the recovery once per call, and falls silent once the index is current", async () => {
    await commitBehindTheIndex(cli, "areas/inbox/committed-past-the-index.html")
    const head = (await cli.git("rev-parse", "HEAD")).trim()

    const stale = await runBuilt(cli.root, ["status"])
    expect(stale.exitCode).toBe(0)
    const payload = JSON.parse(stale.stdout) as StatusPayload
    expect(payload.data.headSha).toBe(head)
    expect(payload.data.indexFresh).toBe(false)
    expect(payload.data.indexHeadSha).not.toBe(head)

    // Exactly one line: the flag is per call, and a status polled every minute must not shout N times.
    const warnings = stale.stderr.split("\n").filter((line) => line.includes("index describes"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("WARN")
    expect(warnings[0]).toContain(
      `index describes ${String(payload.data.indexHeadSha)}, HEAD is ${head}`
    )
    expect(warnings[0]).toContain("run memhtml index update --embed")

    // The recovery the line names is the one that silences it.
    const updated = await runBuilt(cli.root, ["index", "update"])
    expect(updated.exitCode).toBe(0)
    const fresh = await runBuilt(cli.root, ["status"])
    expect(fresh.exitCode).toBe(0)
    expect((JSON.parse(fresh.stdout) as StatusPayload).data.indexFresh).toBe(true)
    expect(fresh.stderr).not.toContain("index describes")
  })

  it("warns once on a store nothing has indexed yet, naming the absent watermark", async () => {
    /**
     * `memhtml init` commits the layout and indexes nothing, so there is no watermark row at all. That
     * is stale by definition rather than a special case: the line says "no commit" where a sha would
     * go, and the recovery it names is the same one.
     */
    const untouched = await makeCli()
    try {
      const status = await runBuilt(untouched.root, ["status"])
      expect(status.exitCode).toBe(0)
      const payload = JSON.parse(status.stdout) as StatusPayload
      expect(payload.data.indexFresh).toBe(false)
      expect(payload.data.indexHeadSha).toBeNull()
      const warnings = status.stderr.split("\n").filter((line) => line.includes("index describes"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(`index describes no commit, HEAD is ${payload.data.headSha}`)
      expect(warnings[0]).toContain("run memhtml index update --embed")
    } finally {
      await untouched.cleanup()
    }
  })
})
