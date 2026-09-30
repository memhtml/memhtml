import { access, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { CurateMerged, CurateRunReport } from "@memhtml/cli"
import { renderTemplate } from "@memhtml/html"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"

/**
 * Placement end to end (`docs/v2-poc.md`, "Curator"): `curate run --model fake` over a fixture whose
 * inbox holds one record with an obvious home files it there with one `move`, the arc that cited it
 * follows it through an `unlink` and a `link` the binder added, and nothing dangles; then `main`
 * gains a fleet record citing the old path, and `curate merge` replays the branch onto that tip,
 * completes the repoint for the new edge too, and lands through the head gate.
 *
 * Every claim about the tree is read back with `git`, independently of the payloads.
 *
 * Mutation (2026-09-30): `withRepoints(head.view, ...)` -> the reconstruction's ops alone in
 * `curateMerge` -> "curate merge replays the move onto a main that cited the old path, and repoints
 * that edge too" is red: the replay is refused naming the fleet record's stale edge.
 */

const AT = "2026-09-20T12:00:00Z"
const REF = "curate/2026-09-30"
const QUALIFIED = `refs/heads/${REF}`
const FROM = "areas/inbox/hex-bonk-retries-a-stalled-stream.html"
const TO = "resources/hex-bonk/hex-bonk-retries-a-stalled-stream.html"
const ARC = "areas/arcs/hex-bonk-stream-arc.html"
const UNPLACED = "areas/inbox/an-unplaced-fact.html"
const FLEET = "areas/inbox/a-fleet-record-citing-the-retry.html"

const memory = (
  title: string,
  claim: string,
  entities: ReadonlyArray<string>,
  links: ReadonlyArray<{ readonly rel: "part_of" | "relates_to"; readonly href: string }> = []
): string =>
  renderTemplate({
    title,
    claim,
    body: [`${title} is part of the placement fixture.`],
    memoryType: "semantic",
    at: AT,
    entities: [...entities],
    links: [...links]
  })

/** Records outside the inbox, so the head gate has probes active at both ends of the landing. */
const filler = Array.from({ length: 30 }, (_, index) => ({
  path: `projects/filler/filler-${String(index).padStart(2, "0")}.html`,
  html: memory(
    `Filler ${index}`,
    `Filler fact ${index} names harbor ${index % 7} and pier ${index % 5}.`,
    [`system:filler-${index % 4}`]
  )
}))

const FIXTURE = [
  ...filler,
  {
    path: "resources/hex-bonk/schedules-fire-from-the-database.html",
    html: memory("Schedules fire from the database", "hex-bonk schedules fire from one table.", [
      "service:hex-bonk"
    ])
  },
  {
    path: "resources/hex-bonk/a-steer-reaches-a-running-session.html",
    html: memory("A steer reaches a running session", "A hex-bonk steer lands mid-run.", [
      "service:hex-bonk"
    ])
  },
  {
    path: FROM,
    html: memory(
      "hex-bonk retries a stalled stream",
      "hex-bonk retries a model stream that stalls for five minutes.",
      ["service:hex-bonk"]
    )
  },
  {
    path: UNPLACED,
    html: memory("An unplaced fact", "The unplaced fact names nothing any home holds.", [
      "system:nowhere"
    ])
  },
  {
    path: ARC,
    html: memory(
      "hex-bonk stream arc",
      "Together the stream records show hex-bonk bounds every model call.",
      ["service:hex-bonk"],
      [{ rel: "part_of", href: `/${FROM}` }]
    )
  }
]

let cli: Cli

const onDisk = (path: string): Promise<boolean> =>
  access(join(cli.root, path)).then(
    () => true,
    () => false
  )
const blobAt = async (ref: string, path: string): Promise<string> =>
  (await cli.git("rev-parse", `${ref}:${path}`)).trim()

/** Every `memhtml-*` edge in the tree at `ref` whose root-relative target is no file there. */
const danglingAt = async (ref: string): Promise<ReadonlyArray<string>> => {
  const paths = (await cli.git("ls-tree", "-r", "--name-only", ref))
    .split("\n")
    .filter((path) => path.endsWith(".html"))
  const present = new Set(paths)
  const dangling: Array<string> = []
  for (const path of paths) {
    const html = await cli.git("show", `${ref}:${path}`)
    for (const match of html.matchAll(/<link rel="memhtml-[^"]+" href="\/([^"]+)"/g)) {
      const target = match[1] ?? ""
      if (!present.has(target)) dangling.push(`${path} -> ${target}`)
    }
  }
  return dangling
}

beforeAll(async () => {
  cli = await makeCli()
  for (const file of FIXTURE) {
    const target = join(cli.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await cli.git("add", "-A")
  await cli.git("commit", "-q", "-m", "placement fixture")
}, 180_000)

afterAll(async () => {
  await cli.cleanup()
})

describe("curate run --model fake files an inbox record into its home", () => {
  it("briefs the record with its home and evidence, moves it, and repoints the arc", async () => {
    const main = (await cli.git("rev-parse", "refs/heads/main")).trim()
    const report = await cli.json<CurateRunReport>([
      "curate",
      "run",
      "--model",
      "fake",
      "--ref",
      REF
    ])
    expect(report.outcome, report.report).toBe("committed")
    expect(report.toolCalls).toEqual(["status", "exec", "propose", "finish"])
    expect(report.ops).toEqual({
      put: 0,
      archive: 0,
      link: 1,
      unlink: 1,
      label: 0,
      unlabel: 0,
      move: 1
    })
    expect(report.briefing.inboxTotal).toBe(2)
    expect(report.briefing.inboxWithHome).toBe(1)
    expect(report.briefing.inbox[0]).toMatchObject({
      path: FROM,
      home: {
        dir: "resources/hex-bonk",
        to: TO,
        kind: "existing",
        records: 2,
        named: ["service:hex-bonk"],
        shared: [{ entity: "service:hex-bonk", records: 2 }]
      }
    })
    expect(report.briefing.inbox[1]).toMatchObject({ path: UNPLACED, home: null })
    const subject = (await cli.git("log", "-1", "--format=%s", QUALIFIED)).trim()
    expect(subject).toBe("memhtml(curate): Filed 1 inbox record(s) into their homes.")

    // The tree: the same blob at the home, nothing at the inbox path, the arc citing the new path,
    // the unplaced record untouched, and no edge anywhere naming a file the tree lacks.
    expect(await blobAt(QUALIFIED, TO)).toBe(await blobAt(main, FROM))
    const paths = (await cli.git("ls-tree", "-r", "--name-only", QUALIFIED)).split("\n")
    expect(paths).not.toContain(FROM)
    expect(await blobAt(QUALIFIED, UNPLACED)).toBe(await blobAt(main, UNPLACED))
    const arc = await cli.git("show", `${QUALIFIED}:${ARC}`)
    expect(arc).toContain(`<link rel="memhtml-part-of" href="/${TO}">`)
    expect(arc).not.toContain(`/${FROM}`)
    expect(await danglingAt(QUALIFIED)).toEqual([])
    // main and the checkout did not move.
    expect((await cli.git("rev-parse", "refs/heads/main")).trim()).toBe(main)
    expect(await onDisk(FROM)).toBe(true)
  })

  it("curate merge replays the move onto a main that cited the old path, and repoints that edge too", async () => {
    // A fleet session lands on main after the curator ran, citing the record at its inbox path.
    await writeFile(
      join(cli.root, FLEET),
      memory(
        "A fleet record citing the retry",
        "A fleet run leaned on the stalled-stream retry to finish its call.",
        ["service:hex-bonk"],
        [{ rel: "relates_to", href: `/${FROM}` }]
      ),
      "utf8"
    )
    await cli.git("add", FLEET)
    await cli.git("commit", "-q", "-m", "fleet record")
    const tip = (await cli.git("rev-parse", "refs/heads/main")).trim()

    const merged = await cli.json<CurateMerged>(["curate", "merge", REF])
    expect(merged.moved).toBe(true)
    expect(merged.from).toBe(tip)
    expect(merged.gate).toMatchObject({ ran: true, passed: true })
    expect(merged.replayed).toMatchObject({ ops: { move: 1, link: 1, unlink: 1 } })

    const landed = merged.to
    expect((await cli.git("rev-parse", "refs/heads/main")).trim()).toBe(landed)
    expect(await blobAt(landed, TO)).toBe(await blobAt(tip, FROM))
    const fleet = await cli.git("show", `${landed}:${FLEET}`)
    expect(fleet).toContain(`<link rel="memhtml-relates-to" href="/${TO}">`)
    expect(fleet).not.toContain(`/${FROM}`)
    expect(await danglingAt(landed)).toEqual([])
    // The checkout followed main.
    expect(await onDisk(FROM)).toBe(false)
    expect(await onDisk(TO)).toBe(true)
  })
})
