import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The authored-file tier: eve is filesystem-first, so the agent's behavior is decided by files
 * that no unit test would otherwise open. These are cheap guards on the facts that are expensive
 * to rediscover — every one of them is a hazard the live probe actually hit.
 *
 * Text assertions, not prose review. Each checks that a specific decision is still recorded, not
 * that the wording is good.
 */

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent")
const read = (...parts: string[]): Promise<string> => readFile(join(agentDir, ...parts), "utf8")

/**
 * Read a prose file as one lowercase line.
 *
 * Markdown is hard-wrapped at 100 columns, so a phrase these tests care about is frequently split
 * across a newline. Matching the raw text would make every assertion below sensitive to where the
 * wrap happens to fall — a reflow would "fail" a guard whose subject never changed. Collapsing
 * whitespace asserts the phrase, not its typography.
 */
const readProse = async (...parts: string[]): Promise<string> =>
  (await read(...parts)).toLowerCase().replace(/\s+/g, " ")

describe("agent/instructions.md", () => {
  /** eve REQUIRES this file. Its absence is a build failure, so assert it exists and is real. */
  it("exists and is substantial", async () => {
    const text = await read("instructions.md")
    expect(text.length).toBeGreaterThan(1_000)
  })

  /** TRACE-2 lives here per §3 of the packet; this is the sentence that carries it. */
  it("states the more-than-one-grep bar", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("grep")
    expect(text).toContain("across")
  })

  it("names the required cross-session lenses without reducing the task to error counting", async () => {
    const text = await readProse("instructions.md")
    // The three the requirement names verbatim.
    expect(text).toContain("recurring error shape")
    expect(text).toContain("tool-failure sequence")
    expect(text).toContain("decision with")
    // And the explicit statement that error shapes are not the whole job.
    expect(text).toContain("one lens, not the whole job")
  })

  it("names restating one line as below the bar", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("restating one line")
  })

  /**
   * An empty result must read as success, or the agent pads to look useful — and the payload the prompt
   * offers as that success has to be one the decoder ACCEPTS.
   *
   * The asserted example carries all three required fields. `{"candidates": []}` alone fails
   * `Schema.decodeUnknownEffect` on two missing keys, the client maps that to
   * `ConsolidatorContractViolation`, and the whole night is refused with the batch unwatermarked — so a
   * prompt advertising it would turn every quiet night into a failed run.
   */
  it("permits an empty result through a payload the decoder accepts", async () => {
    const text = await read("instructions.md")
    expect(text).toContain("Returning no candidates is a correct answer")
    expect(text).toContain(
      '{"candidates": [], "commitments": [], "readSessionIds": ["<every session you read>"]}'
    )
    // No shorter example anywhere, since the shorter one is the payload that fails to decode.
    expect(text).not.toContain('{"candidates": []}')
  })

  /**
   * The commitments half of the output, per issue #44's surface 2. The schema REQUIRES the field, so
   * instructions that never mentioned it would leave the agent filling a list it was not told the rules
   * for — which is the case that mints tasks out of hypotheticals.
   *
   * Text assertions on the DECISIONS, not on the wording: first-person only, the `other` escape hatch
   * that keeps the labelling honest, hypotheticals excluded, and `resolved` scoped to the same session.
   */
  it("states the commitment rules the phase's post-filter enforces", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("first person only")
    // `other` exists so a third party's commitment is reported accurately rather than relabelled.
    expect(text).toContain('actor: "other"')
    expect(text).toContain("never a hypothetical")
    // `resolved` is a fact about the SAME session; a later session's completion is not its job.
    expect(text).toContain("same session")
  })

  /** The second list must also read as legitimately empty, or the agent invents commitments. */
  it("permits an empty commitment list", async () => {
    const text = await read("instructions.md")
    expect(text).toContain('"commitments": []')
    expect(text).toContain('{"candidates": [], "commitments": [], "readSessionIds":')
  })

  /**
   * The read receipt's rules, stated where the agent reads them.
   *
   * The schema REQUIRES `readSessionIds` and the watermark advances over exactly it, so instructions
   * that named the field without saying what it costs would get a list filled to look thorough — and a
   * session named but not read is a transcript recorded as consolidated and never offered again.
   * Assertions on the DECISIONS: the field exists, naming a session means it is never offered again, and
   * omitting one costs a re-read rather than the transcript.
   *
   * (Mutation: dropping the "never offered" sentence fails this while every other prose case stays
   * green, which is exactly the sentence an editor would trim as repetition.)
   */
  it("states what naming a session in the read receipt costs", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("readsessionids")
    expect(text).toContain("never offered to you again")
    expect(text).toContain("offered again on a later night")
  })

  /**
   * ONE quote for a commitment, against the candidate bar's two. The distinction has to be in the
   * instructions or the agent applies the more prominent rule — the "at least two" it read further up —
   * and then either pads a second quote or drops findings it could have reported.
   */
  it("asks for exactly one verbatim quote per commitment, not the candidate bar's two", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("exactly one quote")
  })

  /**
   * Transcripts are recordings of other agent sessions and are therefore full of
   * instruction-shaped text — system prompts, tool definitions, earlier agents' rules. The same
   * hazard `packages/llm/src/model-client.ts:68-71` handles with `wrapAsData`.
   */
  it("tells the agent transcript content is data, never instructions", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("data, not instructions")
    expect(text).toContain("ignore previous instructions")
  })

  it("requires at least two verbatim evidence quotes", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("at least two")
    expect(text).toContain("verbatim")
  })

  /**
   * The instructions must be honest about what the agent was given, and what it was given CHANGED: it
   * used to be per-file byte tails seeded through a model message, and it is now whole transcripts on a
   * read-only mount. So the old "a truncated file holds only its tail" warning is not softened here,
   * it is FALSE — nothing truncates a transcript any more — and a warning that describes a limit that
   * no longer exists would tell the agent to hedge a claim for a reason that does not apply.
   *
   * What is still true is that the agent's own READS are bounded: eve caps `read_file` at 2000 lines
   * or 50 KB per call (node_modules/eve/dist/src/execution/sandbox/truncate-output.js). That is a limit
   * of how it looked rather than of what it holds, and the instructions have to say which.
   */
  it("attributes a partial view to the READER's limits, not to withheld data", async () => {
    const text = await readProse("instructions.md")
    expect(text).toContain("read_file")
    expect(text).toContain("how you looked")
    // And it no longer claims a transcript arrives as a tail, because none does.
    expect(text).not.toContain("holds only its")
  })

  /** The mount paths here must match the ones the client mounts. See `TRACES_MOUNT` in `client.ts`. */
  it("names the mounts the client composes, and not the superseded workspace path", async () => {
    const text = await read("instructions.md")
    expect(text).toContain("/mnt/traces")
    expect(text).toContain("/mnt/run/MANIFEST.json")
    /**
     * The old path is asserted ABSENT rather than merely unmentioned. `/workspace/traces` is where the
     * seeding turn asked the model to write transcripts, and instructions still naming it would send
     * the agent to glob an empty directory — which reads as a corpus finding ("no transcripts") rather
     * than as a broken path.
     */
    expect(text).not.toContain("/workspace/traces")
  })
})

describe("agent/agent.ts", () => {
  it("pins the Opus 5 global profile through the Bedrock provider", async () => {
    const text = await read("agent.ts")
    expect(text).toContain("createAmazonBedrock")
    expect(text).toContain("global.anthropic.claude-opus-5")
  })

  /**
   * eve's window catalog does not know this model id, so an omitted window breaks compaction — and a
   * window declared TOO SMALL breaks it just as surely in the other direction, which is why the number
   * is asserted rather than only its presence.
   *
   * 1,000,000 is what Opus 5 serves on the Bedrock global inference profile. The previous 200_000 was
   * not a measurement: it was the conservative value chosen when the catalog came up empty, and at a
   * fifth of the real window eve compacts a session that had four fifths of its budget left. For a
   * transcript-reading agent that is not a performance cost — compaction discards the earlier reads a
   * cross-session pattern is assembled from, which is the one thing this agent exists to find.
   *
   * (Mutation: restoring `200_000` fails this case. A presence-only assertion survives it, which is why
   * it was not enough.)
   */
  it("declares the FULL context window Opus 5 serves, not the catalog fallback", async () => {
    const text = await read("agent.ts")
    expect(text).toMatch(/modelContextWindowTokens:\s*1_000_000/)
    expect(text).not.toMatch(/modelContextWindowTokens:\s*200_000/)
  })

  /**
   * The probe's hardest-won fact: Opus 5 REJECTS `reasoningConfig: { type: "enabled" }` and eve
   * drops unsupported `providerOptions` silently, so the pairing fails while looking configured.
   * Provider-agnostic `reasoning` only.
   */
  it("uses provider-agnostic reasoning and no reasoningConfig", async () => {
    const text = await read("agent.ts")
    expect(text).toContain('reasoning: "high"')
    expect(text).not.toMatch(/^\s*(?!.*\*).*reasoningConfig/m)
  })

  /**
   * Both ceilings come from `src/output-budget.ts`, never from a literal here.
   *
   * The literal `50_000` that stood on the session cap bounded the READING (reasoning tokens are
   * output tokens under `reasoning: "high"`), and the ABSENT per-call cap let Bedrock apply its own
   * 4,096-token default, which truncated every attempt at the structured answer (issue #113).
   * Comments are stripped before matching, because agent.ts records that history in its own prose and
   * a raw-text search would match the story rather than the code.
   *
   * (Mutation: restoring `maxOutputTokensPerSession: 50_000` fails the first assertion; dropping the
   * `wrapLanguageModel` wrapper fails the second.)
   */
  it("takes both output-token ceilings from output-budget.ts, not from literals", async () => {
    const code = (await read("agent.ts"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    expect(code).toMatch(/maxOutputTokensPerSession:\s*sessionOutputTokenLimit\(/)
    expect(code).not.toMatch(/maxOutputTokensPerSession:\s*\d/)
    expect(code).toMatch(/maxOutputTokens:\s*MODEL_CALL_OUTPUT_TOKEN_LIMIT/)
    expect(code).toContain("wrapLanguageModel(")
    expect(code).toContain("defaultSettingsMiddleware(")
  })
})

describe("agent/sandbox/sandbox.ts", () => {
  /**
   * `defaultBackend()` resolves Vercel Sandbox first whenever `process.env.VERCEL` is set, so an
   * unpinned backend is selected by an ambient env var. Both are anti-goals (§10).
   */
  it("pins just-bash and never reaches for defaultBackend", async () => {
    const text = await read("sandbox", "sandbox.ts")
    expect(text).toContain("justbash()")
    expect(text).toContain('from "eve/sandbox/just-bash"')
    expect(text).not.toMatch(/^\s*(?!.*\*).*defaultBackend\(/m)
    expect(text).not.toContain('from "eve/sandbox/vercel"')
  })
})

describe("agent/channels/eve.ts", () => {
  /**
   * The channel requires a bearer JWT over the run's secret. `tests/run-auth.test.ts` owns the guards
   * on the mechanism — including the one that proves `none()` is gone — because they belong beside the
   * signer they are checked against. What is left here is this tier's own question: the file records
   * WHERE the credential comes from, since it is the only file in `agent/` a reader would consult to
   * learn that the server's auth policy depends on a spawn-time environment variable.
   */
  it("names the per-run secret and the environment it arrives on", async () => {
    const text = await read("channels", "eve.ts")
    expect(text).toContain("runVerifierConfig(process.env)")
    expect(text).toContain("MEMHTML_CONSOLIDATOR_RUN_SECRET")
  })
})

describe("the sandbox workspace seed directory", () => {
  /**
   * Its ABSENCE is the design. Files under `agent/sandbox/workspace/` bake into the template at
   * BUILD time, so a committed transcript there would be baked into every run's sandbox — stale
   * at best, and a corpus leak into a build artifact at worst.
   */
  it("does not exist, because seeds bake at build time", async () => {
    await expect(
      readFile(join(agentDir, "sandbox", "workspace", ".keep"), "utf8")
    ).rejects.toThrow()
  })
})
