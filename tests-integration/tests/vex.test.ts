import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The OpenVEX ledger, and the generated file that carries it to the one scanner that cannot read it.
 *
 * A suppression is the most dangerous artifact in a security setup: it silences a real signal, and
 * it keeps working long after the reasoning that justified it stops being true. So the ledger is
 * gated on three properties rather than trusted — it says what OpenVEX allows, it carries a reason a
 * human can audit, and the file generated from it has not drifted.
 *
 * What this tier deliberately does NOT assert is that a scanner honours the document, because that
 * needs the scanners, and `check` is offline and toolchain-free by construction. Probed by hand
 * 2026-08-18 instead, and recorded here so the gap is named rather than assumed:
 *   - grype 0.111.1  `--vex` moved extract-zip's 2 matches to `ignoredMatches`, tagged
 *                    `{namespace: "vex", vex-status: "not_affected"}` (0 remained in `matches`).
 *   - osv-scanner 2.5.0  `--config=osv-scanner.toml` printed "CVE-2026-56876 and 1 alias have been
 *                    filtered out because: not_affected: vulnerable_code_not_in_execute_path".
 *   - trivy 0.70.0   accepted `--vex` and emitted valid SARIF; it never reported this finding anyway,
 *                    because it suppresses dev dependencies by default.
 */

const VEX_PATH = join(REPO_ROOT, "security", "memhtml.openvex.json")

/** Every status OpenVEX v0.2.0 defines. A typo here is a statement that silently does nothing. */
const STATUSES = new Set(["not_affected", "affected", "fixed", "under_investigation"])

/** The five justifications OpenVEX v0.2.0 allows for `not_affected`, and no others. */
const JUSTIFICATIONS = new Set([
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist"
])

interface VexStatement {
  readonly vulnerability: { readonly name?: string; readonly aliases?: readonly string[] }
  readonly products?: readonly { readonly "@id"?: string }[]
  readonly status?: string
  readonly justification?: string
  readonly impact_statement?: string
}

interface VexDocument {
  readonly "@context"?: string
  readonly "@id"?: string
  readonly author?: string
  readonly timestamp?: string
  readonly version?: number
  readonly statements?: readonly VexStatement[]
}

const vex = JSON.parse(readFileSync(VEX_PATH, "utf8")) as VexDocument
const statements = vex.statements ?? []

describe("the OpenVEX ledger", () => {
  it("carries the document fields OpenVEX requires", () => {
    expect(vex["@context"]).toBe("https://openvex.dev/ns/v0.2.0")
    expect(vex["@id"]).toBeTypeOf("string")
    expect(vex.author).toBeTypeOf("string")
    expect(vex.version).toBeTypeOf("number")
    // RFC 3339, because a statement's whole meaning is "this was true at time T".
    expect(vex.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
    )
    expect(statements.length).toBeGreaterThan(0)
  })

  it("uses only statuses and justifications the spec defines", () => {
    /**
     * The load-bearing one. A scanner given an unrecognised status does not error — it declines to
     * match, so the finding reappears and the ledger reads as though it were applied. `not_affacted`
     * would be a silent no-op, which is the failure mode this whole file exists to prevent.
     */
    for (const statement of statements) {
      const id = statement.vulnerability.name ?? "<unnamed>"
      expect(STATUSES, `${id} status`).toContain(statement.status)
      if (statement.status === "not_affected") {
        // The spec requires one of the five for not_affected; anything else is unaudited silence.
        expect(JUSTIFICATIONS, `${id} justification`).toContain(statement.justification)
      }
    }
  })

  it("names a product by PURL on every statement", () => {
    // grype and trivy match a statement to a finding by the product identifier. A typo'd or absent
    // PURL is a statement that parses, validates, and suppresses nothing.
    for (const statement of statements) {
      const id = statement.vulnerability.name ?? "<unnamed>"
      expect(statement.products?.length ?? 0, `${id} products`).toBeGreaterThan(0)
      for (const product of statement.products ?? []) {
        expect(product["@id"], `${id} product @id`).toMatch(/^pkg:[a-z]+\//)
      }
    }
  })

  it("carries an auditable reason on every suppressing statement", () => {
    /**
     * A justification is an enum, which is a category rather than an argument. The impact statement
     * is where the evidence lives, and a suppression whose evidence is "n/a" is the thing VEX was
     * invented to replace. The floor is length, which is crude but catches the real failure — a
     * placeholder — without pretending to judge prose.
     */
    for (const statement of statements) {
      if (statement.status !== "not_affected" && statement.status !== "fixed") continue
      const id = statement.vulnerability.name ?? "<unnamed>"
      expect(statement.impact_statement, `${id} impact_statement`).toBeTypeOf("string")
      expect(
        (statement.impact_statement ?? "").length,
        `${id} impact_statement length`
      ).toBeGreaterThan(120)
    }
  })

  it("names every alias, so a scanner keying on the CVE still matches", () => {
    // osv-scanner reported this finding as GHSA-jmr9-qjv8-65gv while the Dependabot alert and trivy
    // name CVE-2026-56876. An ignore list built from the name alone stops applying the day a scanner
    // switches which id it reports, which is why the generator expands aliases.
    for (const statement of statements) {
      const aliases = statement.vulnerability.aliases ?? []
      for (const alias of aliases) {
        expect(alias, `${statement.vulnerability.name} alias`).toMatch(
          /^(CVE|GHSA|GO|OSV|RUSTSEC)-/
        )
      }
    }
  })
})

describe("osv-scanner.toml", () => {
  it("is exactly what the generator produces from the ledger", () => {
    /**
     * osv-scanner cannot read VEX, so its config is generated — and a generated file nobody
     * regenerates is worse than no file, because it looks current. Same drift gate as AGENTS.md and
     * the README figures, and driven the same way: the script's own `--check` mode, so the test
     * exercises the entry point CI runs rather than a second copy of the render logic.
     */
    const run = spawnSync("node", ["scripts/vex-to-osv-config.mjs", "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    })
    expect(`${run.stdout}${run.stderr}`).not.toContain("STALE")
    expect(run.status).toBe(0)
  })

  it("names every id and alias the ledger suppresses", async () => {
    const committed = await readFile(join(REPO_ROOT, "osv-scanner.toml"), "utf8")
    for (const statement of statements) {
      if (statement.status !== "not_affected" && statement.status !== "fixed") continue
      for (const id of [statement.vulnerability.name, ...(statement.vulnerability.aliases ?? [])]) {
        expect(committed, `osv-scanner.toml ignores ${id}`).toContain(`id = "${id}"`)
      }
    }
  })

  it("does NOT suppress a statement that says the finding is real", async () => {
    /**
     * The inversion worth locking: `affected` and `under_investigation` mean "this applies to us" and
     * "we do not know yet". Rendering either into an ignore list would turn the ledger into its
     * opposite, and would do so silently, since the file still generates and still parses.
     *
     * Driven through `--stdout` against a synthetic ledger in a temp dir, so the case proves the
     * shipped renderer's behaviour without writing anything into the repo.
     */
    const scratch = await mkdtemp(join(tmpdir(), "vex-"))
    try {
      for (const status of ["affected", "under_investigation"]) {
        const ledger = join(scratch, `${status}.json`)
        await writeFile(
          ledger,
          JSON.stringify({
            "@context": "https://openvex.dev/ns/v0.2.0",
            statements: [
              {
                vulnerability: { name: "CVE-9999-00000", aliases: ["GHSA-aaaa-bbbb-cccc"] },
                products: [{ "@id": "pkg:npm/example@1.0.0" }],
                status,
                impact_statement: "x".repeat(200)
              }
            ]
          })
        )
        const run = spawnSync("node", ["scripts/vex-to-osv-config.mjs", "--stdout", ledger], {
          cwd: REPO_ROOT,
          encoding: "utf8"
        })
        expect(run.status, `${status} render exited non-zero: ${run.stderr}`).toBe(0)
        expect(run.stdout, `${status} must not render an ignore entry`).not.toContain(
          "CVE-9999-00000"
        )
        expect(run.stdout).not.toContain("GHSA-aaaa-bbbb-cccc")
        expect(run.stdout).not.toContain("[[IgnoredVulns]]")
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
