/**
 * The recall discipline: how an agent uses a memory store well, stated once.
 *
 * The CLI's `GUIDE` teaches the mechanics of the binary (the envelope, the three write doors, when to
 * batch, the authoring rule). The MCP tool descriptions teach each tool's arguments. Neither says WHEN
 * to recall, how to treat a hit, when to write, or how to cite, and an agent that has only the
 * mechanics answers from a gap it could have searched. This module is that missing layer, and it is
 * in `@memhtml/contracts` so that every surface renders the same words: the manifest's
 * `recall-discipline` guide topic, the fenced block `memhtml integrations install` writes into a
 * host's instruction file, the skill it installs, and the pointer the retrieval tools carry.
 *
 * The text names both doors where they differ (`memory_search` on MCP, `memhtml search` on the CLI)
 * so the same paragraph is correct whichever surface the reader is on. Written in the second person
 * to an agent mid-task: action first, every claim true of this build.
 */

/** One paragraph per rule, in the order an agent meets them: recall, read, cite, reinforce, write. */
export const RECALL_DISCIPLINE: ReadonlyArray<string> = [
  "Search before you answer from memory. Start every task that could touch a past decision, an incident, " +
    "a preference, or a person with `memory_search` (MCP) or `memhtml search --dense` (CLI), phrased as prose. " +
    "For a context pack rather than a hit list use `memory_recall` / `memhtml recall` and ALWAYS pass a " +
    "character budget (`budget_chars`, `--budget`; 6000 covers most questions), so one long page cannot fill " +
    "your window.",
  "A hit is the ranker's guess, never a citation. Its `snippet` is the chunk that best matched YOUR query, " +
    "which may not be the sentence you need. Open the one or two paths you will rely on with `memory_read` / " +
    "`memhtml read` before you quote, attribute, or act on a memory. Pass one of a hit's `entities` " +
    "(`type:name`) back as the `entity` scope to make the next call a second hop rather than a guess about spelling.",
  "Recalled memories say what was true when they were written. Before you recommend a file, flag, endpoint, " +
    "or schedule a memory names, verify it still exists. An absent path was archived, not deleted: retry with " +
    "`include_archived` / `--include-archived` before concluding the fact is gone, and `memory_resolve` / " +
    "`memhtml resolve` walks a superseded path forward to its live successor. Cite a path only when `stop_reason` " +
    "is `live`, and prefer the pinned `memhtml://at/{commit}/{path}` form when the citation must not move.",
  "Reinforce after use. When a memory helped, call `memory_reinforce` / `memhtml reinforce` with `positive`; " +
    "when it misled, `negative`. That signal is the salience arm's only outcome channel, and a hit you merely " +
    "saw does not count: only an opened path and an explicit signal move it.",
  "Write what is durable, one fact per memory. A decision and its reason, a correction to something stored, " +
    "an incident and what fixed it, a stated preference, a fact about a person or a system you had to look " +
    "up. Not transcripts, not summaries of a session, not anything you can re-derive from the code in front " +
    "of you. State the claim in one sentence, put the evidence and the source in the body, and prefer " +
    "`memory_correct` / `memhtml correct` over a second memory when you are replacing a fact rather than " +
    "adding one."
]

/** The discipline as one string, paragraphs joined by a blank line: the form a guide topic renders. */
export const RECALL_DISCIPLINE_TEXT = RECALL_DISCIPLINE.join("\n\n")

/**
 * Two sentences for a surface that cannot carry the paragraphs, appended to the retrieval tools'
 * descriptions so an MCP-only agent still meets the two rules that most often go wrong.
 */
export const RECALL_DISCIPLINE_SHORT =
  "A hit is the ranker's guess, never a citation: open the path with memory_read before you quote or act on it, " +
  "and call memory_reinforce afterwards with positive or negative so the salience arm learns whether it helped."
