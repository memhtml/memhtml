#!/usr/bin/env node
/**
 * Stage the bytes npm publishes, then export their provenance for release downloads.
 *
 * stage <package-dir> <output-dir> <tag> [--registry]
 * convert <bundle-json-or-jsonl> <asset> <output-dir>
 * verify <asset-dir> <version>
 *
 * npm owns packing, syft catalogs that tarball, and gh owns signature verification.
 * This script checks the file census and binds every exported envelope to those bytes.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { appendFile, mkdir, open, readdir, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

const PROVENANCE = "https://slsa.dev/provenance/v1"
const REGISTRY = "https://registry.npmjs.org"
const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding)

const versionNames = (version) => {
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)
  ) {
    throw new Error("missing or invalid release version")
  }
  return {
    tarball: `memhtml-${version}.tgz`,
    sbom: `memhtml-${version}.cyclonedx.json`,
    checksums: `memhtml-${version}-SHA256SUMS`
  }
}

const fileBytes = async (path) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0) throw new Error(`not a nonempty regular file: ${path}`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

const census = async (dir, expected) => {
  const actual = (await readdir(dir)).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(
      `asset census mismatch: expected ${expected.join(", ")}; found ${actual.join(", ")}`
    )
  }
  await Promise.all(actual.map((name) => fileBytes(join(dir, name))))
}

const command = (tool, args, cwd) => {
  const result = spawnSync(tool, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  return result
}

const successful = (tool, args, cwd) => {
  const result = command(tool, args, cwd)
  if (result.status !== 0) throw new Error(`${tool} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

/** Only the registry's explicit package-not-found response means absence. */
const publishedDist = (version) => {
  const result = command("npm", ["view", "memhtml", "versions", "--json", "--registry", REGISTRY])
  const data = JSON.parse(result.stdout)
  if (result.status !== 0) {
    if (data?.error?.code === "E404") return null
    throw new Error(`npm registry query failed: ${data?.error?.code ?? result.status}`)
  }
  const versions = typeof data === "string" ? [data] : data
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    versions.some((v) => typeof v !== "string")
  ) {
    throw new Error("npm registry returned invalid versions")
  }
  if (!versions.includes(version)) return null
  const dist = JSON.parse(
    successful("npm", ["view", `memhtml@${version}`, "dist", "--json", "--registry", REGISTRY])
  )
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist?.integrity ?? "")) {
    throw new Error("published tarball has no valid SHA512 integrity")
  }
  const url = new URL(dist.tarball)
  if (
    url.origin !== REGISTRY ||
    url.username ||
    url.password ||
    url.pathname !== `/memhtml/-/memhtml-${version}.tgz`
  ) {
    throw new Error("published tarball URL does not match the package and version")
  }
  return dist
}

const checksumText = async (dir, names) => {
  const lines = []
  for (const name of [names.tarball, names.sbom]) {
    lines.push(`${digest(await fileBytes(join(dir, name)))}  ${name}`)
  }
  return `${lines.join("\n")}\n`
}

const stage = async (packageDir, outputDir, tag, registry) => {
  const pkg = JSON.parse((await fileBytes(join(packageDir, "package.json"))).toString("utf8"))
  const names = versionNames(pkg.version)
  if (pkg.name !== "memhtml") throw new Error("expected the assembled memhtml package")
  if (tag !== `memhtml-v${pkg.version}`)
    throw new Error("release tag does not match the package version")
  const dir = resolve(outputDir)
  await mkdir(dir, { recursive: true })
  await census(dir, [])
  const dist = registry ? publishedDist(pkg.version) : null

  // Pack once: new releases use the assembled package; retries fetch the published archive.
  // This exact pathname is the publish subject and the attestation subject.
  const packSpec = dist ? `memhtml@${pkg.version}` : resolve(packageDir)
  const packed = JSON.parse(
    successful("npm", [
      "pack",
      packSpec,
      "--json",
      "--pack-destination",
      dir,
      "--registry",
      REGISTRY,
      "--ignore-scripts"
    ])
  )
  if (
    !Array.isArray(packed) ||
    packed.length !== 1 ||
    packed[0]?.filename !== names.tarball ||
    packed[0]?.name !== pkg.name ||
    packed[0]?.version !== pkg.version
  ) {
    throw new Error("npm pack returned an unexpected tarball or version")
  }
  await census(dir, [names.tarball])
  const tarball = join(dir, names.tarball)
  if (dist && `sha512-${digest(await fileBytes(tarball), "sha512", "base64")}` !== dist.integrity) {
    throw new Error("published tarball integrity mismatch")
  }
  successful("syft", [
    "scan",
    `file:${tarball}`,
    "--select-catalogers",
    "+javascript-package-cataloger",
    "--source-name",
    "memhtml",
    "-o",
    `cyclonedx-json=${join(dir, names.sbom)}`
  ])
  const sbom = JSON.parse(await fileBytes(join(dir, names.sbom)))
  if (
    sbom.bomFormat !== "CycloneDX" ||
    typeof sbom.specVersion !== "string" ||
    !Array.isArray(sbom.components) ||
    !sbom.components.some((c) => c.name === "memhtml" && c.version === pkg.version)
  ) {
    throw new Error("syft did not catalog the versioned memhtml tarball as CycloneDX")
  }
  await writeFile(join(dir, names.checksums), await checksumText(dir, names))
  await census(dir, Object.values(names))
  const outputs = {
    version: pkg.version,
    publish: String(dist === null),
    ...Object.fromEntries(Object.entries(names).map(([key, name]) => [key, join(dir, name)]))
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    )
  }
  console.log(JSON.stringify(outputs))
}

const statementOf = (bundle) => {
  const envelope = bundle?.dsseEnvelope
  if (
    envelope?.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string" ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0 ||
    !bundle.verificationMaterial ||
    typeof bundle.mediaType !== "string"
  ) {
    throw new Error("invalid Sigstore DSSE bundle")
  }
  return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"))
}

const hasSubject = (statement, name, sha256) =>
  statement._type === "https://in-toto.io/Statement/v1" &&
  Array.isArray(statement.subject) &&
  statement.subject.some((subject) => subject.name === name && subject.digest?.sha256 === sha256)

const provenanceFor = (bundles, name, sha256) => {
  const matches = bundles.filter((bundle) => {
    const statement = statementOf(bundle)
    return statement.predicateType === PROVENANCE && hasSubject(statement, name, sha256)
  })
  if (matches.length !== 1)
    throw new Error(
      `expected one SLSA provenance bundle for ${name} and its SHA256; found ${matches.length}`
    )
  return matches[0]
}

const parseBundles = (raw) => {
  try {
    return [JSON.parse(raw)]
  } catch {
    return raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
  }
}

const convert = async (bundlePath, assetPath, outputDir) => {
  const name = basename(assetPath)
  const bytes = await fileBytes(assetPath)
  const bundle = provenanceFor(
    parseBundles((await fileBytes(bundlePath)).toString("utf8")),
    name,
    digest(bytes)
  )
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, `${name}.sigstore.json`), `${JSON.stringify(bundle)}\n`)
  await writeFile(
    join(outputDir, `${name}.intoto.jsonl`),
    `${JSON.stringify(bundle.dsseEnvelope)}\n`
  )
  console.log(`release-assets: exported SLSA provenance for ${name}`)
}

const verify = async (dir, version) => {
  const names = versionNames(version)
  const primary = Object.values(names)
  await census(
    dir,
    primary.flatMap((name) => [name, `${name}.sigstore.json`, `${name}.intoto.jsonl`])
  )
  if (
    (await fileBytes(join(dir, names.checksums))).toString("utf8") !==
    (await checksumText(dir, names))
  ) {
    throw new Error("SHA256SUMS does not match the tarball and SBOM")
  }
  for (const name of primary) {
    const bundle = provenanceFor(
      [JSON.parse((await fileBytes(join(dir, `${name}.sigstore.json`))).toString("utf8"))],
      name,
      digest(await fileBytes(join(dir, name)))
    )
    if (
      (await fileBytes(join(dir, `${name}.intoto.jsonl`))).toString("utf8") !==
      `${JSON.stringify(bundle.dsseEnvelope)}\n`
    ) {
      throw new Error(`DSSE envelope differs from its Sigstore bundle: ${name}`)
    }
  }
  console.log(
    `release-assets: verified ${primary.length} versioned assets and their provenance exports`
  )
}

const [verb, ...args] = process.argv.slice(2)
try {
  if (verb === "stage" && (args.length === 3 || (args.length === 4 && args[3] === "--registry"))) {
    await stage(args[0], args[1], args[2], args[3] === "--registry")
  } else if (verb === "convert" && args.length === 3) {
    await convert(...args)
  } else if (verb === "verify" && args.length === 2) {
    await verify(...args)
  } else {
    console.error(
      "usage: release-assets.mjs stage <package-dir> <output-dir> <tag> [--registry] | convert <bundle> <asset> <output-dir> | verify <asset-dir> <version>"
    )
    process.exitCode = 2
  }
} catch (error) {
  console.error(`release-assets: ${error.message}`)
  process.exitCode = 1
}
