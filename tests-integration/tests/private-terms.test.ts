import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * No tracked file names a person or an internal system.
 *
 * This repository is public, and its fixtures, prompts, and comments were first written against a
 * private deployment. A name that survives an edit reads like any other word, so a review doesn't
 * catch it. This test reads every tracked text file and fails on a word from the list below.
 *
 * The list holds SHA-256 digests of the lowercased terms rather than the terms, so this file doesn't
 * spell out the names it keeps out. That's to keep the names out of the tree, and it isn't secrecy:
 * a short name's digest is easy to reverse. To add a term, append its digest, which
 * `printf %s 'term' | sha256sum` prints.
 *
 * A term matches a whole word, so a term inside a longer word (`anchor` holding a term's letters)
 * doesn't match. Words are runs of letters and digits, split at a camelCase boundary, and a
 * hyphenated word also matches each run of its parts, so `person:x`, `x-runtime`, `xOnly`, and
 * `X_WRITE` all match a term `x`, and a hyphenated term matches inside a longer hyphenated word.
 * Two runs joined by one `-`, `_`, or space also match as their concatenation, the rule the docs
 * site's own gate uses, so a term listed as `xy` matches `x-y`, `x_y`, `x y`, and `xY`.
 *
 * The docs site's sources under `apps/docs/` are scanned like every other file. The site also
 * gates its own built pages with `DENIED_TERMS` and `DENYLIST` in `apps/docs/src/gates.ts`, which
 * reads what the build emits; this scan reads what is tracked.
 *
 * (Mutation 2026-10-18: `apps/docs/` filtered out of the scan again -> "names none of them in any
 * tracked text file" is red on the docs-site census, 0 files against 104. A digest planted for a
 * word the site's sources use found 73 lines under `apps/docs/` with the filter gone, none with it.)
 */
const PRIVATE_TERMS: ReadonlyArray<{ readonly sha256: string; readonly kind: string }> = [
  {
    sha256: "06c20e3fb0d261208540c9ded490d91c9e8e070e701f0f706dd70e94bad55cda",
    kind: "a first name"
  },
  {
    sha256: "271e94cfcd262c77c7a40c49e0ff132acfa7d8de088ac0077fcdac5d60ada9c2",
    kind: "a username"
  },
  {
    sha256: "b3f895b54216d88d11970c9315727ca685855ceed93116c64ed509b72903a39f",
    kind: "a username"
  },
  { sha256: "8396b9ea9983463207c723629337286fdad83f174130137bec8b0c95b5c246f6", kind: "a surname" },
  { sha256: "8ed6fea82bfdd4ec9eb047413e1d764ab06ef63fcc1031c8dd43a59686836a2e", kind: "a surname" },
  {
    sha256: "3431f67b1c3a2caa558fd24fc37b02659abcccb614370bbb0cd9e93a64e4c0f1",
    kind: "a first name"
  },
  { sha256: "594e944ffb2d785934838dd19eaf07f7383c4a4064f78d9b983a8223217e8b28", kind: "a surname" },
  { sha256: "dcc4a2c7ff1ce726522e41836bf44ae0c05cae992a0ecb086cb213d9f7d39cae", kind: "a surname" },
  {
    sha256: "21749f1628aa21d31e1b225048909f410a3335192abf7c1558836fbbb6310328",
    kind: "an agent runtime"
  },
  { sha256: "c2fe160fcb644b2f7f3dd68522a5a2516e2356143ea77f0a45617791f3ac10fb", kind: "a service" },
  {
    sha256: "d92bddf73d00e0914db6a5129783fa96d03951382f394c6ea6eaf9ad02bbeb0d",
    kind: "a model gateway"
  },
  {
    sha256: "56e57ada05a8887e0a051408ae8950a8e1c9b1674dee493591de94bf4d3e2dde",
    kind: "a model gateway"
  },
  {
    sha256: "8758607d0bcaa8a6efc8f92aa63bf367a6f088001d8fd2f16d1583c356a1a23f",
    kind: "an account system"
  },
  {
    sha256: "2a0abe451aede7f7139e3b7be00c2adff97b5ef4a50c6b5f4a2165125b55cc15",
    kind: "a sign-in service"
  },
  {
    sha256: "58f339a72bedc8fc349a91652662d4b1d154910df5f6e46fbeb570c50249bce8",
    kind: "a repository"
  },
  { sha256: "1c1e89d4424683f5fd00dcaa2850ef86dbdc13000afffaf76e96c0d6d50a7cd3", kind: "a project" },
  { sha256: "c429d18b25401f1f8a831607f208834fa5403e577ff0ac57039789f9386d80d9", kind: "a project" },
  {
    sha256: "9ac4bde162a7672fd4ab2d0065287baa69607c782892a53d8e6bd2328da3e5da",
    kind: "an agent runtime, joined"
  },
  {
    sha256: "155fc49c04765c9f2b82f27d20c343d2e1bc615b04df50bc17e5d2e64176b57b",
    kind: "a model gateway, joined"
  },
  {
    sha256: "9344cf2501b9a9bc0bb18ad4d09afd7873b2eea038f691e9a4669c54f2f37325",
    kind: "a private repository, joined"
  },
  {
    sha256: "ea7f0f5d622fee8408f61974dc51225c40ab9830eafff1e2acf86d48b519b2a3",
    kind: "a private lessons directory"
  }
]

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

const WORD = /[a-z0-9]+(?:-[a-z0-9]+)*/g

/** A line lowercased, with a space at each camelCase boundary first. */
const lowered = (line: string): string => line.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()

/** Each word of a line, lowercased, split at camelCase boundaries first. */
const wordsOf = (line: string): ReadonlyArray<string> => lowered(line).match(WORD) ?? []

/** Each pair of adjacent runs joined by exactly one `-`, `_`, or space, concatenated. */
const joinedPairsOf = (line: string): ReadonlyArray<string> =>
  Array.from(lowered(line).matchAll(/(?=(?<![a-z0-9])([a-z0-9]+)[-_ ]([a-z0-9]+))/g), (pair) => {
    const [, first, second] = pair
    return `${first}${second}`
  })

/**
 * The term a word holds, or `undefined`. A hyphenated word is tried as every run of its parts, so a
 * single-part term matches one part and a hyphenated term matches inside a longer hyphenated word.
 */
const matcher = (digests: ReadonlySet<string>): ((word: string) => string | undefined) => {
  const seen = new Map<string, string | undefined>()
  return (word) => {
    if (seen.has(word)) return seen.get(word)
    const parts = word.split("-")
    let found: string | undefined
    for (let start = 0; start < parts.length && found === undefined; start += 1) {
      for (let end = start + 1; end <= parts.length; end += 1) {
        const run = parts.slice(start, end).join("-")
        if (digests.has(sha256(run))) {
          found = run
          break
        }
      }
    }
    seen.set(word, found)
    return found
  }
}

interface Finding {
  readonly path: string
  readonly line: number
  readonly word: string
}

/** Every line of `text` that holds a term, as `{ path, line, word }`. */
const findTerms = (
  path: string,
  text: string,
  match: (word: string) => string | undefined
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []
  text.split("\n").forEach((line, index) => {
    for (const word of wordsOf(line)) {
      if (match(word) !== undefined) findings.push({ path, line: index + 1, word })
    }
    for (const word of joinedPairsOf(line)) {
      if (match(word) !== undefined) findings.push({ path, line: index + 1, word })
    }
  })
  return findings
}

const gitFiles = (...pathspec: ReadonlyArray<string>): ReadonlyArray<string> => {
  const listed = spawnSync("git", ["ls-files", "-z", "--", ...pathspec], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
  expect(listed.status, listed.stderr).toBe(0)
  return listed.stdout.split("\0").filter((path) => path !== "")
}

/** A file is text when its first 8 KiB hold no NUL byte, the test git itself uses. */
const isText = (bytes: Buffer): boolean => !bytes.subarray(0, 8192).includes(0)

describe("private terms", () => {
  it("lists each digest once, as 64 hex digits", () => {
    const digests = PRIVATE_TERMS.map((term) => term.sha256)
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(digests).size).toBe(digests.length)
  })

  it("matches a term in every spelling a fixture or a comment uses, and nowhere else", () => {
    // Placeholders stand in for the real terms, so this case proves the matcher without naming one.
    const match = matcher(new Set([sha256("sasha"), sha256("agent-runtime"), sha256("quuxfrob")]))
    const hits = (line: string): ReadonlyArray<string> =>
      findTerms("sample", line, match).map((finding) => finding.word)
    expect(hits("person:sasha owns it")).toEqual(["sasha"])
    expect(hits("let conceptSasha = sashaOnly")).toEqual(["sasha", "sasha"])
    expect(hits("const SASHA_WRITE = 1")).toEqual(["sasha"])
    expect(hits("Sasha moved")).toEqual(["sasha"])
    expect(hits("resources/agent-runtime/x.html")).toEqual(["agent-runtime"])
    expect(hits("the-agent-runtime-retries")).toEqual(["the-agent-runtime-retries"])
    expect(hits("sashaa, sash, agent, runtime, agent-runtimes")).toEqual([])
    expect(hits("quux-frob, quux_frob, quux frob, quuxFrob, quuxfrob")).toEqual([
      "quuxfrob",
      "quuxfrob",
      "quuxfrob",
      "quuxfrob",
      "quuxfrob"
    ])
    expect(hits("quux, frob, xquux frob, quux frobs, quux  frob")).toEqual([])
  })

  it("names none of them in any tracked text file", () => {
    const scanned = gitFiles()
    // The census: the docs site's sources are part of the scan, as git lists them.
    expect(scanned.filter((path) => path.startsWith("apps/docs/")).length).toBe(
      gitFiles("apps/docs").length
    )
    expect(gitFiles("apps/docs").length).toBeGreaterThan(0)

    const match = matcher(new Set(PRIVATE_TERMS.map((term) => term.sha256)))
    const findings: Array<Finding> = []
    let textFiles = 0
    for (const path of scanned) {
      const bytes = readFileSync(join(REPO_ROOT, path))
      if (!isText(bytes)) continue
      textFiles += 1
      findings.push(...findTerms(path, bytes.toString("utf8"), match))
    }
    // A scan that read almost nothing would pass vacuously.
    expect(textFiles).toBeGreaterThan(scanned.length * 0.9)
    expect(
      findings.map((finding) => `${finding.path}:${finding.line}: ${finding.word}`),
      "rename each word to a placeholder (people: sasha or laura; services: agent-runtime)"
    ).toEqual([])
  })
})
