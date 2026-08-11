import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { renderAgentsDoc } from "../src/agents-doc.js"
import { COMMANDS, GUIDE, GUIDE_OP_EXAMPLE } from "../src/commands.js"
import { CONFIG_VARS } from "../src/config.js"
import { ERROR_CODES, EXIT_OK, EXIT_RUNTIME } from "../src/envelope.js"
import { run } from "../src/run.js"

/** The repo root, three levels up from this file: `apps/cli/tests` → `memhtml`. */
const REPO_ROOT = new URL("../../..", import.meta.url).pathname
const DOC_PATH = join(REPO_ROOT, "AGENTS.md")

describe("the generated agent doc", () => {
  it("is deterministic: two renders are byte-identical", () => {
    // A generator carrying a timestamp, a version of anything but the CLI, or an iteration over an
    // unordered structure would make the drift check below useless — it would fail on every run.
    expect(renderAgentsDoc()).toBe(renderAgentsDoc())
  })

  it("names every command, its flags, and its args", () => {
    const doc = renderAgentsDoc()
    for (const command of COMMANDS) {
      expect(doc).toContain(`### \`memhtml ${command.name}\``)
      expect(doc).toContain(command.summary)
      for (const flag of command.flags) expect(doc).toContain(`\`--${flag.name}\``)
      for (const arg of command.args) expect(doc).toContain(arg.name)
    }
  })

  it("names every error code and every documented variable", () => {
    const doc = renderAgentsDoc()
    for (const code of ERROR_CODES) expect(doc).toContain(code)
    for (const variable of CONFIG_VARS) expect(doc).toContain(variable.name)
  })

  it("renders every guide block, verbatim, under its own topic heading", () => {
    /**
     * The doc and `memhtml manifest` are two projections of ONE array (`GUIDE`), and this is what keeps
     * them from becoming two copies of similar prose. Asserted VERBATIM — the whole body string, not a
     * phrase from it — because a renderer that reflowed, truncated, or escaped the prose would leave
     * an agent reading the doc with different instructions from one calling the binary.
     *
     * The topic is asserted as a code-quoted heading so the key from `guide[].topic` is greppable in
     * the doc: an agent told to read the `when-to-batch` block has to be able to find it.
     */
    const doc = renderAgentsDoc()
    for (const block of GUIDE) {
      expect(doc).toContain(`### \`${block.topic}\``)
      for (const paragraph of block.body.split("\n")) expect(doc).toContain(paragraph)
    }
  })

  it("fences the example op line as JSON so an agent can copy it unescaped", () => {
    // The example is the one piece of the guide an agent COPIES rather than reads, so it has to survive
    // Markdown unwrapped. A fenced block also stops a Markdown renderer from mangling the quotes.
    const doc = renderAgentsDoc()
    expect(doc).toContain(`\`\`\`json\n${GUIDE_OP_EXAMPLE}\n\`\`\``)
    // And it is still valid JSONL after the round trip through the renderer.
    expect(() => JSON.parse(GUIDE_OP_EXAMPLE)).not.toThrow()
  })

  it("puts the guide BEFORE the command table, since it is what makes the table mean anything", () => {
    // Ordering is content here. The three doors, when to batch, and the authoring XOR are decisions an
    // agent makes before it picks a command, so a guide after 33 command specifications is a guide
    // read too late.
    const doc = renderAgentsDoc()
    expect(doc.indexOf("## Guide")).toBeLessThan(doc.indexOf("## Commands"))
    expect(doc.indexOf("## Guide")).toBeGreaterThan(-1)
  })

  it("tells an agent to branch on the code rather than the prose", () => {
    // The one instruction in the doc that is a CONTRACT rather than a description: the `error` string
    // changes freely as wording improves, and a client matching on it breaks silently.
    expect(renderAgentsDoc()).toContain("Never branch on the `error` string")
  })

  it("matches the committed AGENTS.md", async () => {
    /**
     * The drift check. The doc is generated from the same `COMMANDS` array that drives parsing, so a
     * command added without regenerating fails HERE — which is the whole point of generating it. The
     * fix is one command: `memhtml agents-doc`.
     */
    const committed = await readFile(DOC_PATH, "utf8")
    expect(committed).toBe(renderAgentsDoc())
  })

  it("passes its own --check, and answers without building the app layer", async () => {
    /**
     * No layer argument, deliberately. `agents-doc` reads only the command table, and building the
     * app graph would open `$MEMHTML_ROOT/.memhtml/index.db` and run every migration — so a `--check` in CI
     * would scaffold a memory repo as a side effect of rendering Markdown.
     */
    const result = await run(["agents-doc", "--check", "--out", DOC_PATH])
    expect(result.exitCode).toBe(EXIT_OK)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.type).toBe("agents.doc")
    expect((body.data as { inSync: boolean }).inSync).toBe(true)
    expect((body.data as { written: boolean }).written).toBe(false)
  })

  it("refuses --check against a missing file rather than writing one", async () => {
    // A check that fixed the drift it found would turn an uncommitted change into a green pipeline.
    const result = await run([
      "agents-doc",
      "--check",
      "--out",
      join(REPO_ROOT, "AGENTS.absent.md")
    ])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("memhtml agents-doc")
  })
})
