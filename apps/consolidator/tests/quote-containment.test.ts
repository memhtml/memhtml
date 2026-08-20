import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { fabricatedQuoteReason, type ReachableTranscript } from "../src/client.js"
import { decodedTranscriptStrings, quoteAppearsIn } from "../src/contract.js"

/**
 * The one grounding check that OPENS A FILE, driven against real JSONL bytes on disk.
 *
 * `tests/contract.test.ts` exercises `quoteAppearsIn` as a pure function over two strings and needs no
 * file for it. That is the right tier for the rule and the wrong one for this: the defect class this
 * suite exists for is a mismatch between the form a quote is RENDERED in and the form the transcript
 * is STORED in, and neither form is visible when both sides of the comparison are typed into the test.
 *
 * ## What a raw-bytes-only comparison gets wrong
 *
 * A transcript is JSONL, so a message's text reaches the file JSON-ENCODED: a double quote the user
 * typed is two bytes `\"`, and a newline inside one message is the two characters `\` and `n`. A model
 * that reads the file through a JSON parser — which is the only sane way to read it — quotes the
 * DECODED text. So two ordinary honest quotes fail byte containment:
 *
 * - a quote carrying a `"` the speaker typed, because the file holds `\"` and nothing normalizes it;
 * - a quote spanning a message-internal newline, because whitespace collapsing is a no-op on the two
 *   literal characters `\n` and the needle's real newline collapses to a space that is not there.
 *
 * And the consequence is not a lost commitment. `fabricatedQuoteReason` refuses the WHOLE TURN, so the
 * batch produces nothing, so it is never watermarked, so the next night selects the same batch and
 * fails the same way — a livelock on an honest answer, costing every candidate in the batch nightly.
 * That is why the check ships with both arms from day one.
 *
 * ## Why the fabrication tests still have to fail
 *
 * The decoded arm widens what containment ACCEPTS, which is the direction that can silently disable a
 * gate. So every case below that asserts a pass is paired with a fabrication over the SAME transcript:
 * a paraphrase of a line that really is in the file, from a session that really was read, which is the
 * realistic shape of the thing this check exists to catch.
 */

let root: string
/** `sessionId` -> the host path its JSONL was written to. */
const paths = new Map<string, string>()

/**
 * The speaker's own text, exactly as a model reading through a JSON parser would render it.
 *
 * Held as separate constants so the test's expected needle and the file's content cannot drift: the
 * file is written by JSON-ENCODING these, and the assertions quote them directly. A test that typed
 * the escape sequences into the fixture and the rendered form into the assertion would be asserting
 * that two hand-written strings correspond, which is the property under test.
 */
const QUOTED = `He said "ship it" so I'll wire the retry next session`
const MULTILINE = "I'll take the migration next:\nthe review lands Friday"
const PLAIN = "I will leave the pin until the review."

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "memhtml-quote-"))
  /**
   * `JSON.stringify` per line, which is what makes this a real transcript rather than a fixture of the
   * escaping. `session-a`'s file therefore holds `\"ship it\"` and a two-character `\n` on disk, and
   * no assertion below has to spell either.
   */
  const written: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]> = [
    [
      "session-a",
      [
        { type: "user", message: { role: "user", content: QUOTED } },
        { type: "user", message: { role: "user", content: MULTILINE } },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: PLAIN }] }
        }
      ]
    ],
    [
      /** A file with one unparseable line, to prove a truncated tail costs that line and not the run. */
      "session-torn",
      [{ type: "user", message: { role: "user", content: QUOTED } }]
    ]
  ]
  for (const [sessionId, lines] of written) {
    const file = join(root, `${sessionId}.jsonl`)
    const body = lines.map((line) => JSON.stringify(line)).join("\n")
    await writeFile(
      file,
      sessionId === "session-torn"
        ? `${body}\n{"type":"user","message":{"content":"tr`
        : `${body}\n`,
      "utf8"
    )
    paths.set(sessionId, file)
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const reachable = (...sessionIds: ReadonlyArray<string>): ReadonlyArray<ReachableTranscript> =>
  sessionIds.map((sessionId) => ({
    entry: { sessionId, filePath: paths.get(sessionId) ?? join(root, `${sessionId}.jsonl`) },
    guestPath: `/mnt/traces/${sessionId}.jsonl`
  }))

/** One quote cited from one session, in either list — the smallest answer this check judges. */
const answerQuoting = (
  sessionId: string,
  quote: string,
  list: "commitments" | "candidates" = "commitments"
) => ({
  candidates: list === "candidates" ? [{ evidence: [{ sessionId, quote }] }] : [],
  commitments: list === "commitments" ? [{ evidence: { sessionId, quote } }] : []
})

const reasonFor = (
  answer: Parameters<typeof fabricatedQuoteReason>[0],
  transcripts: ReadonlyArray<ReachableTranscript>
): Promise<string | null> => Effect.runPromise(fabricatedQuoteReason(answer, transcripts))

describe("decodedTranscriptStrings", () => {
  it("recovers the DECODED text of every string a JSONL line carries, at any depth", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: QUOTED }] },
      counts: { turns: 3 },
      flagged: false,
      nothing: null
    })
    const strings = decodedTranscriptStrings(`${line}\n`)
    /** The nested `text` is reached, and it is the RENDERED form rather than the file's bytes. */
    expect(strings).toContain(QUOTED)
    expect(line).not.toContain(QUOTED)
    /** Values only. A key is a field name the speaker never said, so it is not quotable evidence. */
    expect(strings).not.toContain("content")
    /** Non-strings contribute nothing: a number is not a quote and `String(3)` is not evidence. */
    expect(strings).not.toContain("3")
  })

  it("skips an unparseable line rather than losing the file", () => {
    const good = JSON.stringify({ content: PLAIN })
    /** A live process writes these, so a torn final line is the ordinary state of today's file. */
    expect(decodedTranscriptStrings(`${good}\n{"content":"tr`)).toEqual([PLAIN])
    expect(decodedTranscriptStrings("not json at all\n")).toEqual([])
  })

  it("returns nothing for a line that parses to a bare scalar", () => {
    /** `JSON.parse("3")` succeeds. A line with no object around it names no field and no speaker. */
    expect(decodedTranscriptStrings("3\ntrue\nnull\n")).toEqual([])
    /** A bare JSON string IS text, and it is reachable, so it counts. */
    expect(decodedTranscriptStrings(JSON.stringify(PLAIN))).toEqual([PLAIN])
  })
})

describe("fabricatedQuoteReason accepts the RENDERED form of a stored line", () => {
  it("passes a quote carrying a double quote the speaker typed", async () => {
    /**
     * THE livelock case. On disk this line holds `\"ship it\"`, so the needle is not a substring of the
     * file's bytes however whitespace is normalized — and the answer is honest. A raw-bytes-only check
     * refuses the whole turn on it, discards every candidate in the batch, leaves the batch
     * unwatermarked, and does it again the next night.
     *
     * (Mutation: dropping the decoded arm makes this return a `commitment 0 quotes session-a …` reason.)
     */
    expect(QUOTED).toContain('"')
    expect(await reasonFor(answerQuoting("session-a", QUOTED), reachable("session-a"))).toBeNull()
  })

  it("passes a quote spanning a message-internal newline", async () => {
    /**
     * The other half, and it fails byte containment for a DIFFERENT reason than the quote character:
     * the file holds the two characters `\` and `n`, and `quoteAppearsIn` collapses runs of real
     * whitespace, so the needle's newline becomes a space that the file's backslash-n cannot match.
     * Both spellings of the needle are driven — the model may render the break as a newline or as a
     * space, and both are the same sentence.
     */
    expect(
      await reasonFor(answerQuoting("session-a", MULTILINE), reachable("session-a"))
    ).toBeNull()
    expect(
      await reasonFor(
        answerQuoting("session-a", MULTILINE.replaceAll("\n", " ")),
        reachable("session-a")
      )
    ).toBeNull()
  })

  it("still passes a quote that is verbatim in the RAW bytes", async () => {
    /**
     * The raw arm is tried FIRST and still decides. `PLAIN` needs no decoding: it carries no escape,
     * so it is a substring of the file either way.
     */
    expect(JSON.stringify(PLAIN)).toContain(PLAIN)
    expect(await reasonFor(answerQuoting("session-a", PLAIN), reachable("session-a"))).toBeNull()
  })

  it("passes a quote from a file whose LAST line is torn", async () => {
    /** One unparseable line costs that line. A live process is still writing these files. */
    expect(
      await reasonFor(answerQuoting("session-torn", QUOTED), reachable("session-torn"))
    ).toBeNull()
  })

  it("applies to CANDIDATE evidence on the same terms", async () => {
    /** Both lists walk one loop, and the label in the reason is the only thing that differs. */
    expect(
      await reasonFor(answerQuoting("session-a", QUOTED, "candidates"), reachable("session-a"))
    ).toBeNull()
  })
})

describe("fabricatedQuoteReason still REFUSES a fabricated quote", () => {
  it("refuses a paraphrase of a line that really is in the file", async () => {
    /**
     * The gate, non-vacuous against the widened check: the same session, the same subject, a sentence
     * nobody said. Neither the raw bytes nor any decoded string holds it.
     */
    const reason = await reasonFor(
      answerQuoting("session-a", "I will wire the retry in the next session"),
      reachable("session-a")
    )
    expect(reason).not.toBeNull()
    expect(reason).toContain("session-a")
    expect(reason).toContain("does not")
    /** The reason carries a TRUNCATED quote and never the transcript: it is logged and reported. */
    expect(reason).not.toContain(PLAIN)
  })

  it("refuses a fabricated CANDIDATE quote with the candidate label", async () => {
    const reason = await reasonFor(
      answerQuoting("session-a", "a sentence nobody said in any session", "candidates"),
      reachable("session-a")
    )
    expect(reason).not.toBeNull()
    expect(reason).toContain("candidate 0")
  })

  it("refuses a quote assembled across TWO messages", async () => {
    /**
     * The decoded arm tests each string SEPARATELY rather than one joined blob, and this is the case
     * that separates the two. Joining every decoded string with a newline would make the tail of one
     * message plus the head of the next a contiguous run after collapsing — so a model could stitch a
     * sentence out of two turns and have it verify. That is a fabricated quote with real words in it.
     */
    const stitched = `${MULTILINE.split("\n")[1] ?? ""} ${PLAIN}`
    const reason = await reasonFor(answerQuoting("session-a", stitched), reachable("session-a"))
    expect(reason).not.toBeNull()
  })

  it("refuses when the cited transcript cannot be re-read", async () => {
    /**
     * An unreadable file is a REFUSAL and not a skip, which is the opposite of every other transcript
     * read in this client — and the asymmetry is the point: the model already claimed to have read this
     * file and quoted it, so a file this process cannot open means the claim cannot be checked, and
     * passing an unverifiable commitment through is the same as not checking.
     */
    const reason = await reasonFor(answerQuoting("session-gone", PLAIN), [
      {
        entry: { sessionId: "session-gone", filePath: join(root, "not-written.jsonl") },
        guestPath: "/mnt/traces/not-written.jsonl"
      }
    ])
    expect(reason).toContain("could not be re-read")
  })

  it("refuses a session the run never read, before opening anything", async () => {
    const reason = await reasonFor(answerQuoting("session-b", PLAIN), reachable("session-a"))
    expect(reason).toContain("did not read")
  })

  it("has no opinion about an answer that cites nothing", async () => {
    expect(await reasonFor({ candidates: [], commitments: [] }, reachable("session-a"))).toBeNull()
  })
})

describe("metadata-shaped quotes are the RAW arm's accepted residual, not the decoded arm's", () => {
  it("accepts a metadata token through the raw arm alone — the decoded arm adds nothing to it", async () => {
    /**
     * Review asked whether the decoded arm lets a quote match transcript METADATA (a role, a type)
     * rather than speech. It cannot add that acceptance: a metadata value carries no JSON escape, so
     * its decoded form IS its byte form, and the RAW arm — the original contract, a substring search
     * over the whole file — already accepts it. This case pins both halves: the token passes
     * containment (through raw bytes), and the decoded list holds nothing the bytes don't
     * (`"user"` appears in `decodedTranscriptStrings` output only as itself, byte-identical).
     * Tightening this means restricting the RAW arm by parsing field layouts, recorded in
     * `decodedTranscriptStrings`' docs as declined; the schema's min-length floor and the reviewer
     * seeing the degenerate "quote" verbatim in the task body bound the damage.
     */
    expect(await reasonFor(answerQuoting("session-a", "user"), reachable("session-a"))).toBeNull()
    const bytes = JSON.stringify({ type: "user", message: { role: "user", content: PLAIN } })
    expect(quoteAppearsIn("user", bytes)).toBe(true)
  })
})

describe("the decoded arm does not weaken quoteAppearsIn itself", () => {
  it("leaves case, punctuation, and the empty needle exactly as they were", () => {
    /**
     * The widening is in WHAT TEXT is searched and not in how a needle is compared, so the pure rule
     * still refuses everything it would refuse alone: a lowercased quote, an added `!`, and the empty
     * needle whose `includes` is true against anything.
     */
    expect(quoteAppearsIn(QUOTED.toLowerCase(), QUOTED)).toBe(false)
    expect(quoteAppearsIn(`${QUOTED}!`, QUOTED)).toBe(false)
    expect(quoteAppearsIn("", QUOTED)).toBe(false)
  })
})
