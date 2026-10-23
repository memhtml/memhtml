import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

const ROOT = resolve(import.meta.dirname, "../..")
const SCRIPT = join(ROOT, "scripts/release-assets.mjs")
const VERSION = "0.16.2"
const TARBALL = `memhtml-${VERSION}.tgz`
const SBOM = `memhtml-${VERSION}.cyclonedx.json`
const CHECKSUMS = `memhtml-${VERSION}-SHA256SUMS`
const PRIMARY = [TARBALL, SBOM, CHECKSUMS]
const PROVENANCE = "https://slsa.dev/provenance/v1"
const hash = (bytes: string | Buffer, algorithm = "sha256", encoding: "hex" | "base64" = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding)

let scratch = ""
let assets = ""
let pkg = ""
let bin = ""
let fixture: Array<Record<string, unknown>> = []

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "release-assets-"))
  assets = join(scratch, "assets")
  pkg = join(scratch, "package")
  bin = join(scratch, "bin")
  await Promise.all([mkdir(assets), mkdir(pkg), mkdir(bin)])
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "memhtml", version: VERSION }))
  fixture = (
    await readFile(join(ROOT, "tests-integration/fixtures/release-attestations.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  // Tools are adapters: assert the requested archive is the one syft catalogs, and count packing.
  await writeFile(
    join(bin, "npm"),
    `#!${process.execPath}\n${`
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify(["npm", ...args]) + "\\n")
if (args[0] === "view") {
  const mode = process.env.REGISTRY_MODE
  if (mode === "E404" || mode === "ENETUNREACH" || mode === "E500") {
    console.log(JSON.stringify({error: {code: mode}})); process.exit(1)
  }
  if (mode === "malformed") {console.log("{}"); process.exit(0)}
  if (args[2] === "versions") {
    console.log(JSON.stringify(mode === "published" ? ["0.16.2"] : ["0.16.1"])); process.exit(0)
  }
  console.log(JSON.stringify({integrity: process.env.REGISTRY_INTEGRITY,
    tarball: process.env.REGISTRY_URL || "https://registry.npmjs.org/memhtml/-/memhtml-0.16.2.tgz"})); process.exit(0)
}
if (args[0] !== "pack") process.exit(9)
const registry = args[1] === "memhtml@0.16.2"
if (registry && process.env.DOWNLOAD_FAIL === "1") process.exit(5)
const pkg = registry ? {name:"memhtml", version:"0.16.2"} : JSON.parse(fs.readFileSync(path.join(args[1], "package.json")))
const filename = pkg.name + "-" + pkg.version + ".tgz"
const dir = args[args.indexOf("--pack-destination") + 1]
fs.writeFileSync(path.join(dir, filename), registry ? process.env.DOWNLOAD_BYTES || "registry bytes" : "packed bytes")
if (process.env.PACK_STRAY) fs.writeFileSync(path.join(dir, "stray.txt"), "stray")
console.log(JSON.stringify([{filename, name:pkg.name, version:pkg.version}]))
`}`
  )
  await writeFile(
    join(bin, "syft"),
    `#!${process.execPath}\n${`
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify(["syft", ...args]) + "\\n")
if (args[0] !== "scan" || args[1] !== "file:" + process.env.EXPECTED_TARBALL || !args.includes("+javascript-package-cataloger")) process.exit(8)
if (fs.readFileSync(process.env.EXPECTED_TARBALL, "utf8") !== process.env.EXPECTED_BYTES) process.exit(7)
if (process.env.SYFT_FAIL) process.exit(6)
const target = args[args.indexOf("-o") + 1].replace("cyclonedx-json=", "")
fs.writeFileSync(target, JSON.stringify(process.env.SYFT_INVALID ? {} :
  {bomFormat:"CycloneDX", specVersion:"1.6", components:[{name:"memhtml",version:"0.16.2"}]}))
`}`
  )
  await Promise.all([chmod(join(bin, "npm"), 0o755), chmod(join(bin, "syft"), 0o755)])
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TOOL_LOG: join(scratch, "tools.jsonl"),
      EXPECTED_TARBALL: join(assets, TARBALL),
      EXPECTED_BYTES: "packed bytes",
      GITHUB_OUTPUT: "",
      ...env
    }
  })
const stage = (env: Record<string, string> = {}, registry = false) =>
  run(["stage", pkg, assets, `memhtml-v${VERSION}`, ...(registry ? ["--registry"] : [])], env)

interface Envelope {
  payloadType: string
  payload: string
  signatures: Array<unknown>
}
const envelopeOf = (bundle: Record<string, unknown>) => bundle.dsseEnvelope as Envelope
const statementOf = (bundle: Record<string, unknown>) =>
  JSON.parse(Buffer.from(envelopeOf(bundle).payload, "base64").toString())
const bundleFor = (
  subjects: Array<{ name: string; digest: { sha256: string } }>,
  predicate = PROVENANCE
) => {
  const bundle = structuredClone(fixture[1]) as Record<string, unknown>
  const statement = statementOf(bundle)
  statement.subject = subjects
  statement.predicateType = predicate
  envelopeOf(bundle).payload = Buffer.from(JSON.stringify(statement)).toString("base64")
  return bundle
}
const signAssets = async () => {
  const subjects = await Promise.all(
    PRIMARY.map(async (name) => ({
      name,
      digest: { sha256: hash(await readFile(join(assets, name))) }
    }))
  )
  const bundlePath = join(scratch, "bundles.json")
  await writeFile(bundlePath, JSON.stringify(bundleFor(subjects)))
  for (const name of PRIMARY) {
    const result = run(["convert", bundlePath, join(assets, name), assets])
    expect(result.status, result.stderr).toBe(0)
  }
}

describe("release asset staging", () => {
  it("packs once, catalogs that archive, and checksums exactly the versioned tarball and SBOM", async () => {
    const outputs = join(scratch, "outputs")
    const result = stage({ GITHUB_OUTPUT: outputs })
    expect(result.status, result.stderr).toBe(0)
    expect((await readdir(assets)).sort()).toEqual([...PRIMARY].sort())
    expect(await readFile(join(assets, CHECKSUMS), "utf8")).toBe(
      `${hash("packed bytes")}  ${TARBALL}\n${hash(await readFile(join(assets, SBOM)))}  ${SBOM}\n`
    )
    const calls = (await readFile(join(scratch, "tools.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls.filter((call) => call[0] === "npm" && call[1] === "pack")).toHaveLength(1)
    expect(calls[1]?.[2]).toBe(`file:${join(assets, TARBALL)}`)
    expect(await readFile(outputs, "utf8")).toContain(`tarball=${join(assets, TARBALL)}\n`)
    expect(JSON.parse(result.stdout).publish).toBe("true")
  })
  it("refuses a preexisting stray file before packing", async () => {
    await writeFile(join(assets, "stray.txt"), "extra")
    const result = stage()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("asset census mismatch")
    expect(await readdir(bin)).toHaveLength(2)
    expect(await readdir(assets)).toEqual(["stray.txt"])
  })
  it("refuses an extra file introduced during packing", () => {
    const result = stage({ PACK_STRAY: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("asset census mismatch")
  })
  it.each([undefined, "", "latest", "0.16", "0.16.2/other"])(
    "refuses missing or invalid version %s",
    async (version) => {
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "memhtml", version }))
      const result = stage()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("release version")
      expect(await readdir(assets)).toEqual([])
    }
  )
  it("refuses a tag belonging to another version", () => {
    const result = run(["stage", pkg, assets, "memhtml-v0.16.1"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("tag does not match")
  })
  it.each([{ SYFT_FAIL: "1" }, { SYFT_INVALID: "1" }])(
    "refuses a failed or empty catalog %s",
    (env) => {
      expect(stage(env).status).toBe(1)
    }
  )
  it.each(["E404", "unpublished"])("allows publishing only on classified absence %s", (mode) => {
    const result = stage({ REGISTRY_MODE: mode }, true)
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).publish).toBe("true")
  })
  it.each(["ENETUNREACH", "E500", "malformed"])(
    "does not treat registry failure %s as unpublished",
    async (mode) => {
      const result = stage({ REGISTRY_MODE: mode }, true)
      expect(result.status).toBe(1)
      expect(await readdir(assets)).toEqual([])
    }
  )
  it("skips publishing when the registry tarball matches npm integrity", () => {
    const result = stage(
      {
        REGISTRY_MODE: "published",
        REGISTRY_INTEGRITY: `sha512-${hash("packed bytes", "sha512", "base64")}`,
        DOWNLOAD_BYTES: "packed bytes"
      },
      true
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).publish).toBe("false")
  })
  it("recovers and catalogs the verified published tarball when rebuilding changed bytes", async () => {
    const result = stage(
      {
        REGISTRY_MODE: "published",
        REGISTRY_INTEGRITY: `sha512-${hash("registry bytes", "sha512", "base64")}`,
        EXPECTED_BYTES: "registry bytes"
      },
      true
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).publish).toBe("false")
    expect(await readFile(join(assets, TARBALL), "utf8")).toBe("registry bytes")
    const calls = (await readFile(join(scratch, "tools.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const packs = calls.filter((call) => call[0] === "npm" && call[1] === "pack")
    expect(packs).toHaveLength(1)
    expect(packs[0]).toEqual([
      "npm",
      "pack",
      `memhtml@${VERSION}`,
      "--json",
      "--pack-destination",
      assets,
      "--registry",
      "https://registry.npmjs.org",
      "--ignore-scripts"
    ])
  })
  it.each([{ DOWNLOAD_BYTES: "tampered" }, { DOWNLOAD_FAIL: "1" }])(
    "refuses unverified registry recovery %s",
    (env) => {
      const result = stage(
        {
          REGISTRY_MODE: "published",
          REGISTRY_INTEGRITY: `sha512-${hash("registry bytes", "sha512", "base64")}`,
          ...env
        },
        true
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        env.DOWNLOAD_BYTES ? "published tarball integrity mismatch" : "npm failed"
      )
    }
  )
  it.each([
    { REGISTRY_INTEGRITY: "sha512-invalid" },
    { REGISTRY_URL: "https://example.com/package.tgz" }
  ])("refuses invalid registry metadata %s", (env) => {
    const result = stage(
      {
        REGISTRY_MODE: "published",
        REGISTRY_INTEGRITY: `sha512-${hash("packed bytes", "sha512", "base64")}`,
        ...env
      },
      true
    )
    expect(result.status).toBe(1)
  })
})

describe("provenance exports", () => {
  it("refuses a symlink asset without exporting sidecars", async () => {
    const target = join(scratch, "target.tgz")
    const asset = join(scratch, TARBALL)
    const bundlePath = join(scratch, "bundle.json")
    await writeFile(target, "packed bytes")
    await symlink(target, asset)
    await writeFile(
      bundlePath,
      JSON.stringify(bundleFor([{ name: TARBALL, digest: { sha256: hash("packed bytes") } }]))
    )
    const result = run(["convert", bundlePath, asset, assets])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("ELOOP")
    expect(await readdir(assets)).toEqual([])
  })
  it.each([
    { reversed: false, trailingNewline: true },
    { reversed: true, trailingNewline: true },
    { reversed: false, trailingNewline: false },
    { reversed: true, trailingNewline: false }
  ])(
    "selects SLSA provenance by predicate and bytes with reversed=$reversed and trailingNewline=$trailingNewline",
    async ({ reversed, trailingNewline }) => {
      const asset = join(scratch, "gh_2.103.0_linux_amd64.tar.gz")
      await writeFile(asset, "fixture bytes")
      const expected = bundleFor([
        { name: "gh_2.103.0_linux_amd64.tar.gz", digest: { sha256: hash("fixture bytes") } }
      ])
      const bundles = [fixture[0], expected]
      if (reversed) bundles.reverse()
      const path = join(scratch, "fixture.jsonl")
      await writeFile(
        path,
        bundles.map((bundle) => JSON.stringify(bundle)).join("\n") + (trailingNewline ? "\n" : "")
      )
      const result = run(["convert", path, asset, assets])
      expect(result.status, result.stderr).toBe(0)
      expect(
        JSON.parse(await readFile(join(assets, `${asset.split("/").at(-1)}.sigstore.json`), "utf8"))
      ).toEqual(expected)
      const dsse = await readFile(
        join(assets, "gh_2.103.0_linux_amd64.tar.gz.intoto.jsonl"),
        "utf8"
      )
      expect(dsse).toBe(`${JSON.stringify(expected.dsseEnvelope)}\n`)
      expect(dsse.trim().split("\n")).toHaveLength(1)
      expect(expected.verificationMaterial).toEqual(fixture[1]?.verificationMaterial)
    }
  )
  it.each(["other predicate", "wrong name", "wrong digest", "ambiguous", "malformed"])(
    "refuses %s",
    async (why) => {
      const asset = join(scratch, TARBALL)
      await writeFile(asset, "packed bytes")
      const bundle = bundleFor(
        [
          {
            name: why === "wrong name" ? "other.tgz" : TARBALL,
            digest: { sha256: hash(why === "wrong digest" ? "other bytes" : "packed bytes") }
          }
        ],
        why === "other predicate" ? "https://example.com/predicate" : PROVENANCE
      )
      if (why === "malformed") bundle.dsseEnvelope = {}
      const path = join(scratch, "bad.jsonl")
      await writeFile(
        path,
        [bundle, ...(why === "ambiguous" ? [bundle] : [])]
          .map((entry) => JSON.stringify(entry))
          .join("\n")
      )
      const result = run(["convert", path, asset, assets])
      expect(result.status).toBe(1)
      expect(await readdir(assets)).toEqual([])
    }
  )
  it("verifies the exact nine-file release census and matching exported envelopes", async () => {
    expect(stage().status).toBe(0)
    await signAssets()
    const result = run(["verify", assets, VERSION])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("verified 3 versioned assets")
  })
  it.each(["extra", "missing", "tarball", "checksums", "envelope", "bundle", "symlink"])(
    "refuses asset transport corruption %s",
    async (why) => {
      expect(stage().status).toBe(0)
      await signAssets()
      if (why === "extra") await writeFile(join(assets, "extra.txt"), "extra")
      if (why === "missing") await rm(join(assets, `${SBOM}.intoto.jsonl`))
      if (why === "tarball") await writeFile(join(assets, TARBALL), "tampered")
      if (why === "checksums") await writeFile(join(assets, CHECKSUMS), "invented checksums")
      if (why === "envelope") await writeFile(join(assets, `${SBOM}.intoto.jsonl`), "{}\n")
      if (why === "bundle")
        await writeFile(join(assets, `${CHECKSUMS}.sigstore.json`), JSON.stringify(fixture[0]))
      if (why === "symlink") {
        await rm(join(assets, TARBALL))
        const { symlink } = await import("node:fs/promises")
        await symlink(join(assets, SBOM), join(assets, TARBALL))
      }
      expect(run(["verify", assets, VERSION]).status).toBe(1)
    }
  )
  it("reports incomplete command wiring as usage", () => {
    expect(run([]).status).toBe(2)
    expect(run(["convert"]).status).toBe(2)
  })
})
