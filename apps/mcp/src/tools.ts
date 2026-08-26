import {
  DatabaseService,
  ExtractorPort,
  Indexer,
  IndexRecorder,
  NEIGHBORS_LIMIT,
  Retrieval,
  Store
} from "@memhtml/cli"
import { MEMORY_RELS } from "@memhtml/contracts/edges"
import { PARA_BUCKETS, WRITABLE_MEMORY_TYPES } from "@memhtml/contracts/types"
import { REINFORCE_SIGNALS } from "@memhtml/domain"
import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

import { ToolFailure } from "./failure.js"

/**
 * The fourteen tools: design.md §8 verbatim, plus `memory_write_batch` (spec 004 D7).
 *
 * **`parameters` is always `Schema.Struct`, never `Schema.Class`.** A client sends a plain object
 * literal, and a class schema's decode expects an instance. The failure is a decode error on every
 * call, at runtime, for every tool. This is the one trap the whole surface is arranged around.
 *
 * **Sleep is deliberately absent.** It is a cron/operator action producing a reviewable branch, not
 * something an agent fires mid-conversation: a sleep run rewrites confidence across the corpus,
 * archives memories, and creates a branch a human is expected to read. `memhtml sleep run` is the
 * entry point. A read-only `sleep_status` is the only shape this surface could ever take for it; the
 * write side stays behind an operator.
 *
 * Every `success` schema is also a `Schema.Struct`, so `tools/list` publishes a JSON Schema the
 * client can validate a response against rather than an opaque object.
 *
 * **A `description` has to FOLD to a string by AST**, so it is built from string literals, `+`, and
 * identifiers declared in this file — never a template literal with a substitution and never an
 * imported value. The docs site reads each description straight out of this source
 * (`foldString` in `apps/docs/src/loaders/repo-sources.ts`) so the reference page and the published
 * bytes are the same string; an expression it cannot fold throws at that build instead of rendering
 * a paraphrase. A number that must not drift from a constant is asserted in `tests/tools.test.ts`
 * against the constant, which is the check a literal cannot make for itself.
 *
 * **Every tool declares `failure: ToolFailure`, and the omission is a silent wire bug.** A tool with
 * no declared failure schema gets `Schema.Never` (`Tool.make`'s `options?.failure ?? Schema.Never`,
 * effect 4.0.0-rc.109), so `McpServer`'s `isDeclaredFailure` predicate rejects everything and every
 * failure, typed domain error included, is rewritten to `INTERNAL_TOOL_ERROR_MESSAGE`, "Tool
 * execution failed due to an internal server error", before it reaches the caller. The declaration is
 * what puts a tool's failures on the branch that passes prose through; see `failure.ts` for the
 * mechanism. `failureMode` is left at its `"error"` default on purpose: the error CHANNEL is what
 * `McpServer` catches, and `"return"` would instead fold the failure into the success union, where the
 * server would see a successful call carrying a failure payload no MCP client knows to read.
 */

/** The eight types an agent may write. `arc` is system-written by the sleep cycle. */
const WritableType = Schema.Literals(WRITABLE_MEMORY_TYPES)

/** The nine MEMORY-class rels. A person or provenance rel cannot be named here. */
const MemoryRelSchema = Schema.Literals(MEMORY_RELS)

/**
 * A repo-root-relative path: `areas/oncall/rollback-order.html`.
 *
 * The git-tree form with no leading slash, which is `files.path`, and the ID of a memory. The
 * `<link href>` form in the HTML carries a leading slash and is converted at the store boundary, so
 * a tool never sees it.
 */
const MemoryPath = Schema.String

/**
 * `Schema.Finite`, not `Schema.Number`, for every numeric field.
 *
 * `Number` derives a JSON Schema with an `anyOf` carrying a STRING branch, because `Infinity` and
 * `NaN` are not JSON numbers and the codec represents them as strings. Probed on effect
 * 4.0.0-rc.109, `Schema.Number` derives `{"anyOf":[{"type":"number"},{"type":"string","enum":
 * ["Infinity","-Infinity","NaN"]}]}`. A client reading that sees a union where the tool wants a
 * number. `Finite` derives a clean `{"type":"number"}`.
 */
const Finite = Schema.Finite

/** A count: a non-negative quantity. */
const Count = Schema.Int

/**
 * An optional parameter that a client may also send explicitly as `null`.
 *
 * A bare `Schema.optional(X)` is a WIRE BUG here, and it is the kind a byte-comparison fixture
 * cannot see: the derived JSON Schema publishes `{"anyOf":[{"type":"string"},{"type":"null"}]}` , telling
 * every client that `null` is acceptable, while the decoder rejects it with "Expected string |
 * undefined, got null" (both probed on effect 4.0.0-rc.109). So a client that read the schema and
 * did the obvious thing, sending `{"workspace": null}` for "no workspace", would get a decode error
 * on a call the published contract said was valid. Many clients serialize an absent optional exactly
 * that way.
 *
 * `optionalKey(NullOr(X))` makes the decoder accept all three forms a client can produce (absent,
 * a value, and `null`) and publishes the FLAT `{"anyOf":[{"type":"string"},{"type":"null"}]}`.
 * `optional` rather than `optionalKey` would derive a nested `anyOf` wrapping that union in a second
 * one, which is the same contract spelled in a way a client has to unwrap twice to read.
 *
 * `null` and absent both mean "not supplied", which is what the handlers normalize to `undefined`.
 */
const Optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

/**
 * The services a tool handler may reach for, declared per tool.
 *
 * `Tool.make`'s `dependencies` is what moves a service from the handler's requirement set into the
 * TOOL's, so `kit.toLayer({…})` accepts a handler that yields `Store`, and the requirement then
 * surfaces on the layer where `layerApp` satisfies it. Without the declaration a handler that reads
 * a service is a type error, and the only ways out are casting the handler or building the services
 * inside it: the first loses the check that the app layer provides what the tools need, and the
 * second gives every tool call its own database connection.
 *
 * Each tool declares only what it actually uses, so a handler that grows a dependency has to say so,
 * which keeps `memory_search` provably unable to reach the store and write.
 *
 * A FUNCTION per set, not a shared constant: the option's type is a mutable array, so handing the
 * same array to fourteen tools would let one tool's construction mutate the dependency list of the
 * other thirteen.
 */
const READS = () => [DatabaseService]
// ExtractorPort is in the write set because `batchWrite` reads it (the write-time entity assist);
// the port resolves to `{ extractor: undefined }` unless MEMHTML_EXTRACT_ENTITIES=on.
const WRITES = () => [Store, Indexer, IndexRecorder, ExtractorPort]
const RETRIEVES = () => [Retrieval, DatabaseService]

/**
 * The `article_html` contract, stated in the description of every tool that takes it.
 *
 * A description, not a doc comment on the parameter: `tools/list` publishes `description` and an
 * agent chooses and fills a tool from it, so a contract stated anywhere else is a contract the
 * caller never reads. And it has to be stated HERE rather than left to the store's refusal, because
 * `article_html` is the one parameter whose CONTENT the caller has to get right; every other value is
 * one the template places itself, and the only other parameter carrying a rule of its own is `path`
 * (see `PATH_OVERRIDE_CONTRACT`, which is about placement rather than format). An agent that learns
 * the `<mark>` rule from an `InvalidMemory` on its first write has already spent a round trip on
 * something the tool could have told it.
 *
 * The four clauses are the ones a caller can actually violate: format.md constraint 1 (exactly one
 * `<mark>`, inside the first `<p>` or `<li>`), constraint 3 (no `class`, `style`, or `<script>`),
 * the closed vocabulary, and the `<time datetime>` rule. That last one is a CONSEQUENCE the caller
 * has to know about rather than a constraint: the first such element becomes `files.event_at`,
 * and the recency arm ranks episodic memories by it rather than by write time.
 */
const ARTICLE_HTML_CONTRACT =
  "Supply EXACTLY ONE of `body` or `article_html`. Both or neither is refused. " +
  "`article_html` is raw <article> inner markup used verbatim, and the caller owns the format: exactly one <mark>, " +
  "inside the first <p> or the first <li>, and never inside <aside> or <details>; only elements from the closed " +
  "vocabulary in docs/format.md; no class attribute, no style attribute, no <script>, no event handlers. " +
  'The FIRST <time datetime="…"> element becomes the memory\'s event time, which is what the recency arm ranks ' +
  "by, so an episodic memory about last week should carry last week's date, not today's. Markup that violates " +
  "the format is refused before any file is written or committed. " +
  "Code snippets: in `body` prose, a paragraph that is entirely a fenced code block (```ts … ```) becomes " +
  '<figure><pre><code data-lang="ts">, whitespace verbatim, and the language promotes to a `lang:ts` entity; ' +
  "a blank line inside the fence does not split it. In `article_html`, author the same markup yourself: " +
  "data-lang, never class (forbidden) and never lang= (that names human languages)."

/**
 * What an explicit `path` does, stated in the description of every tool that accepts one.
 *
 * A description rather than a doc comment for `ARTICLE_HTML_CONTRACT`'s reason: `tools/list` publishes
 * `description`, and a rule stated anywhere else is a rule the caller never reads. This one belongs
 * there because BOTH of its branches are surprising, and each is surprising in the opposite direction.
 * An unusable path is silently re-derived rather than refused, so an agent that expected a refusal gets
 * a memory somewhere it did not choose. An OCCUPIED path is refused rather than overwritten, so an
 * agent that expected last-write-wins gets `ERR_WRITE_CONFLICT` and no file. Learning either from a
 * response costs a round trip, and learning the second one wrong costs the corpus a memory.
 *
 * The recovery is named, because a write is not it: eviction here is a `git mv` into `archive/` and
 * nothing is ever removed, so replacing a memory is `memory_correct`, which archives what it supersedes
 * in the same commit.
 */
const PATH_OVERRIDE_CONTRACT =
  "`path` is optional and rarely worth sending: without it the placement rule picks the directory from the memory's type, workspace, and entities, and the title becomes the filename. " +
  "A `path` that is not a usable memory path (rooted in a PARA bucket, ending in .html, no . or .. segment) is IGNORED, and the placement rule decides instead — so a malformed override lands the memory somewhere you did not name. " +
  "A `path` that a file ALREADY occupies is REFUSED with ERR_WRITE_CONFLICT, and nothing is written or committed: this corpus overwrites nothing, and an explicit path gets no -2 suffix because you named one path. " +
  "To replace what a memory says, call memory_correct on it — that archives the file it supersedes in the same commit and leaves it readable under archive/."

/**
 * When to batch and what a batch does, stated in the description of BOTH write tools.
 *
 * A shared constant for the same reason `ARTICLE_HTML_CONTRACT` is one: `memory_write` has to point at
 * `memory_write_batch` and `memory_write_batch` has to explain itself, and two hand-written versions of
 * one workflow drift the first time the semantics move. Written once, appended twice.
 *
 * And it lives in a DESCRIPTION because this server has nowhere else to put it. MCP has a server-level
 * `instructions` field for exactly this kind of cross-tool guidance, and effect 4.0.0-rc.109 never
 * emits it. See the comment in `server.ts` next to `layerStdio`. Tool descriptions are the only
 * channel, so a workflow rule that is not in one is a rule no agent reads.
 *
 * Every clause is something the caller decides or has to predict, and nothing else: the threshold that
 * makes batching worth it, the ordering guarantee it can index results by, the atomicity default it
 * would otherwise have to discover from a refusal, the flag that changes that default, and the two
 * outcomes an agent most often mistakes for errors, a dedupe and a per-op failure in continue mode.
 * The cost of leaving any of them out is a wrong assumption an agent acts on for the rest of the task.
 */
const BATCH_GUIDANCE =
  "Call memory_write_batch ONCE rather than memory_write N times whenever this task will write more than about three memories: " +
  "a batch stages every file, makes ONE commit, and reindexes ONCE, so it costs less than N calls and leaves a history a reader can follow. " +
  "It returns one result per op in INPUT ORDER, each naming that op's index, its path, and whether it deduped. " +
  "A batch is ATOMIC by default: the first refused op aborts the whole call, no file is written and no commit is made, and the failure names the offending op as ops[N]. " +
  "Set continue_on_error to true for best-effort instead, and a refused op comes back as a failed result carrying its own code and reason while every surviving op lands in the one commit. " +
  "A duplicate is never a failure: an op whose exact content is already stored returns ok with deduped=true and the existing path. " +
  "Each op supplies EXACTLY ONE of body or article_html, the same rule memory_write follows."

/**
 * The `detect_conflicts` assist, stated in `memory_write_batch`'s description.
 *
 * A constant beside `BATCH_GUIDANCE` for the same reason that one exists, and for one more: a test
 * asserts the whole string is present, so the semantics and the published prose cannot drift into two
 * versions. It is not appended to `memory_write`'s description. The singular has no such flag, and a
 * paragraph about a parameter a tool does not accept is a paragraph that makes an agent try to send it.
 *
 * Every clause is something a caller acts on. The distinction from dedupe, because an agent that
 * thought this was dedupe would stop checking. The RULE, because it is grammatical rather than semantic
 * and an agent expecting meaning-matching would trust a null it should not. The two match sources, since
 * the intra-batch one is invisible to every other tool. The nulls, all four of them, because each one is
 * an absence of information rather than an absence of conflict. And the propose-only contract WITH its
 * reason, the BEAM caveat, spelled out rather than asserted: an agent told only "this does not block"
 * will assume it is a v1 limitation and hand-roll the archiving the design deliberately refuses.
 */
const CONFLICT_GUIDANCE =
  "Set detect_conflicts to true and each per-op result gains a `conflict` field naming what that op's claim CONTRADICTS. " +
  "This is not dedupe: dedupe catches an op whose content is IDENTICAL to something stored, while this catches an op that says something DIFFERENT about the same thing, the case dedupe is blind to, and the one that actually rots a corpus. " +
  "The match is grammatical rather than semantic. A claim splits into a frame (the subject and relation up to its LAST of/is/in/to/by/as) and a value, and two claims conflict when they share a frame: 'The pool ceiling is 64' and 'The pool ceiling is 128' both key on 'the pool ceiling is'. " +
  "conflict.path names an ACTIVE memory already holding that slot. conflict.batch_index names an EARLIER op in this same call, which no other tool can see because neither op is stored yet; it has no path for that reason. conflict.claim is the other claim's own text, so you can decide without a second call. " +
  "conflict is null when nothing matched, when detect_conflicts was absent, when the claim states no frame shape (the rule refuses frames under three tokens and values over six, so short claims and claims trailed by a clause are deliberately unmatched rather than loosely matched), and always on an op that used article_html. The claim is inside your markup there and is not read until the store renders it. " +
  "THE ASSIST NEVER CHANGES WHAT IS WRITTEN. An op carrying a conflict is written exactly as it would have been without the flag: nothing is archived, nothing is refused, later does not win, and the summary counts are unchanged. " +
  "That is deliberate, not a limitation. Sometimes the contradiction IS the answer. A memory recording that a runbook step changed necessarily contradicts the memory stating the old step, and a system that resolved that for you would destroy the pair a reader needs in order to see the change at all. " +
  "So YOU decide, per conflict: keep both (they are about different things, or both are true), call memory_correct on the named path instead (the new claim supersedes the old one, which stays readable under archive/), or drop the op. " +
  "Archived memories never match, so a superseded claim stops contradicting the claim that superseded it."

/**
 * The `consolidate` opt-in, stated in `memory_write_batch`'s description.
 *
 * A third constant beside the two above and AFTER `CONFLICT_GUIDANCE` in the description, because it
 * is the acting counterpart of the assist: an agent has to know what a conflict IS before "resolve it
 * last-wins" means anything, and stating the flag first would make the propose-only contract above
 * read as contradicted two paragraphs later.
 */
const CONSOLIDATE_GUIDANCE =
  'Set consolidate to "last-wins" and the batch RESOLVES frame-key matches instead of only reporting them: for ops sharing a claim slot (the same deterministic frame key the conflict rule uses), the LATER value wins. Exactly one file is written, at the FIRST index that claimed the slot, and every later restatement reports consolidated_into naming that slot instead of a path of its own. ' +
  "A stored ACTIVE memory occupying a surviving slot is archived with a supersedes link from the new file, its archive path reported on the winner as superseded_path. " +
  "Off by default, and claims with no frame shape are never consolidated. The guards fail closed, so this only ever acts on claims the conflict rule would have matched."

/**
 * The `facets` contract, stated in the description of every tool that scopes on one.
 *
 * A description rather than a doc comment, for `ARTICLE_HTML_CONTRACT`'s reason: `tools/list` publishes
 * `description`, so a rule stated anywhere else is a rule the caller never reads. This one belongs
 * there because the COMPOSITION is a semantic contract an agent cannot recover from the rows. An agent
 * that read two names as "either" acts on a superset, and one that read two values under one name as
 * "both" acts on an empty set, and each result looks like a plausible corpus answer.
 *
 * The unitless clause is the second thing a caller would otherwise assume wrong. `file_facets` holds a
 * `numeric_value` beside every `<data value>`, and no tool exposes an inequality over it, because the
 * unit lives in the human phrasing the number sits in. An agent told nothing would ask for one; told
 * this, it matches the text its own corpus wrote.
 *
 * Written once and appended twice, so the two doors cannot publish two versions of one rule.
 */
const FACET_SCOPE_CONTRACT =
  "`facets` narrows by the corpus's own <dl> facets, each entry spelled name=value (the value may contain =, the name may not). " +
  'THE COMPOSITION IS FIXED: values under the SAME name broaden, so ["doc-type=runbook","doc-type=guide"] is either; DIFFERENT names narrow, so ["doc-type=runbook","tier=1"] is both. ' +
  "This is the extension axis. memhtml's element and meta vocabularies are closed, so your own document kinds, states, and tiers belong in <dt>/<dd> pairs inside the article, and this is how you query them back. " +
  "The match is on the facet's TEXT, exactly as authored, with no case folding, so write the facet names you query. " +
  "There is no numeric comparison and that is deliberate: a <data value> is indexed UNITLESS, because the unit lives in the prose beside it, so you own the unit and match the text you wrote."

/**
 * The fields that author ONE memory, shared by `memory_write`'s parameters and `memory_write_batch`'s
 * op struct.
 *
 * D7 says the batch op is "the same fields as memory_write". Written twice, that is a claim two
 * literals make about each other and stop making the first time a field is added to one of them. An
 * agent that learned `tags` from `memory_write` and had it silently dropped by a batch op would get a
 * memory it could not find by the facet it filed it under. Shared, the widening is automatic and the
 * published schemas cannot disagree.
 *
 * A FUNCTION returning a fresh literal, matching `READS`/`WRITES` above: the field record is handed to
 * a schema constructor and nothing here should be able to observe another tool's construction.
 */
const writeFields = () => ({
  title: Schema.String,
  /**
   * Prose. The first sentence becomes the `<mark>` claim and the rest becomes one `<p>` per blank-line
   * paragraph. See `claimFromProse`/`proseTail` in `@memhtml/cli`'s `prose.ts`, the one copy this door and
   * `memhtml apply` share. Optional because `article_html` is the other way to author the same article, and
   * the handler refuses a call that names both or neither.
   */
  body: Optional(Schema.String),
  /** Pre-authored article markup, used verbatim in place of `body`. See the description's contract. */
  article_html: Optional(Schema.String),
  memory_type: WritableType,
  /**
   * An explicit placement override. Unusable values are re-derived and occupied ones are refused;
   * `PATH_OVERRIDE_CONTRACT` states both branches in the description, which is where a caller reads
   * them. The refusal is `@memhtml/store`'s `freePathFor`, so this door and `memhtml apply` share it.
   */
  path: Optional(MemoryPath),
  workspace: Optional(Schema.String),
  tags: Optional(Schema.Array(Schema.String)),
  entities: Optional(Schema.Array(Schema.String)),
  importance: Optional(Count),
  confidence: Optional(Finite),
  session_id: Optional(Schema.String),
  prompt_id: Optional(Schema.String),
  turn_uuid: Optional(Schema.String)
})

const MemoryWrite = Tool.make("memory_write", {
  description:
    "Write one memory to the corpus. Returns the existing path with deduped=true when an active memory already holds this exact content. A duplicate creates no file and no commit. " +
    ARTICLE_HTML_CONTRACT +
    " " +
    PATH_OVERRIDE_CONTRACT +
    " " +
    BATCH_GUIDANCE,
  dependencies: WRITES(),
  parameters: Schema.Struct(writeFields()),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    created: Schema.Boolean,
    deduped: Schema.Boolean,
    existing_path: Schema.NullOr(MemoryPath)
  })
})

/**
 * One op in a batch: a whole `memory_write` payload, with the tool name standing in for D4's `op`
 * discriminator.
 *
 * A nested `Schema.Struct`, which is what makes the array's `items` a published object schema with its
 * own `required`. Probed on effect 4.0.0-rc.109, `Schema.Array(Schema.Struct({…}))` derives the
 * struct INLINE under `items` rather than hoisting it into a `$defs` a client would have to resolve.
 * So `ops[].title` is as legible to a caller reading `tools/list` as `memory_write`'s own `title`, and
 * the `Optional` discipline carries in unchanged: an optional inside an op publishes the same FLAT
 * `{"anyOf":[{…},{"type":"null"}]}` and accepts absent, a value, or `null`.
 */
const BatchOp = Schema.Struct(writeFields())

/** One op's outcome, mirroring `memhtml apply`'s own per-op payload field for field, in snake_case. */
const BatchOpResult = Schema.Struct({
  /** This op's position in the `ops` array the caller sent. Results come back in that order too. */
  index: Count,
  ok: Schema.Boolean,
  /**
   * Every field below is PRESENT and nullable rather than optional, for the reason `memory_write`'s
   * `existing_path` is: a client reading an absent key cannot tell "this op did not dedupe" from "this
   * server does not report dedupes", and an agent deciding whether to retry needs that distinction.
   */
  path: Schema.NullOr(MemoryPath),
  deduped: Schema.Boolean,
  existing_path: Schema.NullOr(MemoryPath),
  /** The stable `ERR_*` code for this op's refusal, null when it did not fail. */
  code: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /**
   * True when this op was never attempted: an atomic abort reports every op other than the offending
   * one as skipped, which is how a caller tells "refused" from "not reached".
   */
  skipped: Schema.Boolean,
  /**
   * What this op's claim contradicts, when `detect_conflicts` was on and something matched. Null when
   * the flag was off, when nothing matched, or when the claim states no frame shape.
   *
   * `Schema.NullOr(Schema.Struct(…))`, present like every field above rather than optional: a client
   * reading an absent key cannot tell "this op conflicts with nothing" from "this server does not
   * report conflicts", and the two lead to opposite decisions.
   *
   * ONE struct with both source fields nullable rather than a union of two, so a client reads `claim`
   * unconditionally (that is the disagreement, and it is what the decision is made on) and then
   * whichever of `path`/`batch_index` is non-null. A `Schema.Union` would publish two near-identical
   * three-field shapes under an `anyOf` and force every consumer to discriminate before reading the
   * field it wanted, which is the same trap the `body`/`article_html` XOR avoids by not being a union.
   */
  conflict: Schema.NullOr(
    Schema.Struct({
      /** The ACTIVE memory already holding this frame key. Null for an intra-batch match. */
      path: Schema.NullOr(MemoryPath),
      /**
       * The EARLIER op in THIS call holding it. Null for a store match, and it has no path because
       * that op's file does not exist yet. The batch has not been written when the assist runs.
       */
      batch_index: Schema.NullOr(Count),
      /** The other claim's own text. */
      claim: Schema.String
    })
  ),
  /**
   * Set on a batch-internal LOSER under `consolidate: "last-wins"`: a later op with the same frame
   * key replaced this op's value before anything was written, and the number is the caller-space
   * index of the op whose position carries the surviving value. Null everywhere else, present like
   * every field above so a client can tell "not consolidated" from "not reported".
   */
  consolidated_into: Schema.NullOr(Count),
  /**
   * Set on a WINNER whose write superseded a live stored memory under `consolidate: "last-wins"`:
   * the loser's ARCHIVE path, where its bytes now live. Null when nothing stored occupied the
   * slot, and when the supersede degraded (the batch still wrote; the corpus is merely
   * unconsolidated).
   */
  superseded_path: Schema.NullOr(Schema.String)
})

const MemoryWriteBatch = Tool.make("memory_write_batch", {
  description:
    "Write many memories in ONE commit: every op is validated first, every surviving file is staged, and the batch commits and reindexes exactly once. " +
    "commit_sha is null when nothing was written: an all-deduped batch, or an aborted one. " +
    /**
     * Same order as `memory_write`'s (the article contract, then the batch workflow), so an agent that
     * has read one description finds the other's clauses where it expects them. Reversed here, the
     * guidance's closing XOR reminder would sit immediately before the full statement of that same rule,
     * which reads as a repetition rather than as two sections.
     */
    ARTICLE_HTML_CONTRACT +
    " " +
    PATH_OVERRIDE_CONTRACT +
    " " +
    BATCH_GUIDANCE +
    /**
     * LAST, after the workflow, and consolidation after the conflict rule it acts on. The guidance
     * states what a batch IS and an agent needs that before an optional assist over it means anything;
     * leading with the conflict rule would explain a field on a result shape the reader has not been
     * told about yet.
     */
    " " +
    CONFLICT_GUIDANCE +
    " " +
    CONSOLIDATE_GUIDANCE,
  dependencies: WRITES(),
  parameters: Schema.Struct({
    ops: Schema.Array(BatchOp),
    /** Best-effort mode: a refused op is reported and skipped, survivors land in the one commit. */
    continue_on_error: Optional(Schema.Boolean),
    /**
     * Report each op's frame-matches as a per-op `conflict`. Propose-only: it changes nothing about what
     * is written. `Optional` rather than defaulted-true because the assist costs one extra query per
     * batch, and a caller that did not ask for the field would be paying for an answer it does not read.
     */
    detect_conflicts: Optional(Schema.Boolean),
    /**
     * Opt-in deterministic last-wins consolidation over the conflict rule's own frame keys. A
     * `Literals` of one value rather than a boolean, so the vocabulary can widen (a `first-wins`, a
     * semantic mode) without a shipped `true` changing meaning under a caller.
     */
    consolidate: Optional(Schema.Literals(["last-wins"])),
    /**
     * Batch-level provenance: the session this call is being made in. An op that names its own wins,
     * because it is the more specific statement about where that one memory came from, which is what
     * lets a batch replay writes from an earlier session without relabelling them.
     */
    session_id: Optional(Schema.String),
    prompt_id: Optional(Schema.String),
    turn_uuid: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    results: Schema.Array(BatchOpResult),
    /** Derived from `results` in one pass, so the counts cannot disagree with the array. */
    summary: Schema.Struct({
      total: Count,
      written: Count,
      deduped: Count,
      failed: Count,
      skipped: Count,
      /** Batch-internal losers under `consolidate: "last-wins"`: neither written nor failed. */
      consolidated: Count
    }),
    commit_sha: Schema.NullOr(Schema.String)
  })
})

const MemoryRead = Tool.make("memory_read", {
  description:
    "Read one memory in full: its head metadata, authored links, and complete article body. The only path to a <details> body, which recall never quotes. An explicit open of a named path COUNTS as salience. This is the read that moves the access plane, while a search or recall hit does not.",
  /**
   * `DatabaseService` is here because an explicit open bumps the access plane: `readMemory` reaches the
   * state plane through `bumpAccess`, so the tool has to declare it or the handler is a type error. The
   * widening is the salience rule made visible in the dependency set. `memory_search` still cannot
   * reach it, which is what keeps a ranker's guess out of the plane.
   */
  dependencies: [Store, IndexRecorder, DatabaseService],
  parameters: Schema.Struct({
    path: MemoryPath,
    session_id: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    title: Schema.String,
    body: Schema.String,
    gist: Schema.String,
    memory_type: Schema.String,
    meta: Schema.Record(Schema.String, Schema.String),
    links: Schema.Array(Schema.Struct({ rel: Schema.String, href: Schema.String })),
    archived: Schema.Boolean,
    warnings: Schema.Array(Schema.String)
  })
})

const MemorySearch = Tool.make("memory_search", {
  description:
    "Ranked search over the corpus: lexical, vector, recency, and salience arms fused with RRF, then diversified. Each hit carries a `snippet`: the text of the file's best-matching chunk for this query (its opening chunk when the vector arm did not fire), truncated with a trailing `…` when cut. `degraded` is true when the vector arm did not fire, so the result came from fewer signals. Each hit also carries `entities` in `type:name` form; pass one of those values back as `entity` to make the next call the second hop of a chain. That is two calls, not a guess about spelling. An `entity` scope that matches nothing returns NO hits and says so through `scope_empty`: this tool never widens a scope it could not satisfy. `as_of` is a point-in-time view: pass an ISO instant and the result is what was believed valid at that moment, including since-superseded memories (marked superseded_by). Returning a path changes nothing: a hit is this ranker's guess, so it never bumps salience. Call memory_read to open the one you chose, and memory_reinforce to record whether it was right. " +
    FACET_SCOPE_CONTRACT,
  dependencies: RETRIEVES(),
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Optional(Count),
    memory_types: Optional(Schema.Array(WritableType)),
    workspace: Optional(Schema.String),
    tags: Optional(Schema.Array(Schema.String)),
    /**
     * One entity reference in `type:name` form, the same spelling `memory_list` takes and the same
     * spelling a hit's `entities` publishes, so a value read off a hit is a valid scope verbatim.
     */
    entity: Optional(Schema.String),
    /**
     * `<dl>` facet predicates as `name=value` strings. AND across distinct names, OR within one name;
     * the description carries the rule, because that is what a caller reads.
     */
    facets: Optional(Schema.Array(Schema.String)),
    include_archived: Optional(Schema.Boolean),
    /**
     * Point-in-time view: returns what was believed valid at this moment, including
     * since-superseded memories (marked superseded_by). The window is
     * `coalesce(valid_from, event_at, created_at) <= as_of < valid_until`. The supersede path
     * stamps both ends, so history is read from the files rather than replayed from git.
     */
    as_of: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    hits: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        gist: Schema.String,
        memory_type: Schema.String,
        /** The fused RRF score. Unitless and comparable only within one result set. */
        score: Finite,
        confidence: Finite,
        updated_at: Schema.String,
        /**
         * The best-matching chunk's text for THIS query (the vector arm's winning chunk, or the
         * file's opening chunk on the degraded path), truncated with a trailing `…` when cut.
         */
        snippet: Schema.String,
        /**
         * This memory's entity references in `type:name` form, sorted, possibly empty.
         *
         * The next hop's `entity` parameter, published in the form that parameter accepts: the whole
         * point is that a caller chains by COPYING a value rather than by reconstructing one.
         */
        entities: Schema.Array(Schema.String),
        /**
         * The path of the memory that superseded this one, or `null` when nothing has. Non-null
         * only for an archived hit, which reaches a result through `as_of` or
         * `include_archived`, so a point-in-time answer is legible as history. Present and
         * nullable like `consolidated_into`: a client must be able to tell "not superseded" from
         * "this build does not report supersession".
         */
        superseded_by: Schema.NullOr(Schema.String)
      })
    ),
    degraded: Schema.Boolean,
    arms: Schema.Array(Schema.String),
    /** The `entity` this search was scoped to, or `null` when it was not scoped by entity. */
    entity_scope: Schema.NullOr(Schema.String),
    /**
     * True when a scope was named, it narrowed the query, and nothing survived it.
     *
     * A boolean in every case, following `degraded`: this is the field that makes an empty scoped
     * result attributable to the scope, and it would be worth nothing if its absence had to be read
     * as `false`.
     */
    scope_empty: Schema.Boolean
  })
})

const MemoryRecall = Tool.make("memory_recall", {
  description:
    "A context pack under a character budget: full bodies for what fits, one index line each for what does not. Arcs are folded under their own envelope so a synthesis cannot crowd out the evidence behind it.",
  dependencies: RETRIEVES(),
  parameters: Schema.Struct({
    query: Schema.String,
    budget_chars: Optional(Count),
    workspace: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    sections: Schema.Struct({
      arcs: Schema.Array(
        Schema.Struct({
          path: MemoryPath,
          title: Schema.String,
          gist: Schema.String,
          body: Schema.String
        })
      ),
      memories: Schema.Array(
        Schema.Struct({
          path: MemoryPath,
          title: Schema.String,
          gist: Schema.String,
          body: Schema.String
        })
      ),
      /** What did not fit: claim plus path, for a deliberate drill-down. */
      lateral: Schema.Array(
        Schema.Struct({ path: MemoryPath, title: Schema.String, gist: Schema.String })
      )
    }),
    spent_chars: Count,
    truncated: Schema.Boolean,
    degraded: Schema.Boolean
  })
})

const MemoryCorrect = Tool.make("memory_correct", {
  description:
    "Supersede a memory: write the corrected version and archive the target in ONE commit, linked in both directions. Never edits in place. The superseded memory stays readable under archive/. " +
    ARTICLE_HTML_CONTRACT,
  dependencies: WRITES(),
  parameters: Schema.Struct({
    target_path: MemoryPath,
    title: Schema.String,
    /** The corrected prose; first sentence becomes the new `<mark>`. Exclusive with `article_html`. */
    body: Optional(Schema.String),
    /** Pre-authored markup for the superseding article, used verbatim. Exclusive with `body`. */
    article_html: Optional(Schema.String),
    reason: Schema.String,
    session_id: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    superseded: Schema.Array(MemoryPath),
    archived: Schema.Array(MemoryPath)
  })
})

const MemoryLink = Tool.make("memory_link", {
  description:
    "Assert an edge between two memories. Written into the source file's head, so it survives an index rebuild. Idempotent: re-linking the same pair commits nothing.",
  dependencies: [Store, Indexer],
  parameters: Schema.Struct({
    src_path: MemoryPath,
    rel: MemoryRelSchema,
    dst_path: MemoryPath,
    strength: Optional(Finite)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    ok: Schema.Boolean,
    rel: Schema.String,
    src_path: MemoryPath,
    dst_path: MemoryPath
  })
})

const MemoryNeighbors = Tool.make("memory_neighbors", {
  description:
    "The memory graph around one path, to at most two hops, in both directions. Includes sleep-mined edges: lateral retrieval is what they are for, and each node's `derived` says which kind of edge reached it. " +
    "`nodes` holds at most 200 distinct paths, each at its minimal hop. `limit` chooses that ceiling and an ask outside 1..200 is clamped into it rather than refused, the same shape `memory_list` and `trace_search` have; `node_limit` echoes the bound the answer was built under. " +
    "`edges` counts something DIFFERENT and is not a node count: it is the distinct edges the walk enumerated, including edges to paths the node clamp dropped, so it can exceed what the returned nodes account for. " +
    "TWO markers report truncation, because they need different answers: `dropped_node_count` is the paths the walk reached and `limit` turned away, which a larger `limit` returns, while `scan_saturated` is the walk stopping at its own 10000-edge-row cap, which no `limit` recovers — narrow that one with `rels` or `depth: 1` instead.",
  dependencies: READS(),
  parameters: Schema.Struct({
    path: MemoryPath,
    depth: Optional(Count),
    rels: Optional(Schema.Array(MemoryRelSchema)),
    /**
     * Distinct paths `nodes` may hold, 1 to {@link NEIGHBORS_LIMIT}, defaulting to the ceiling.
     *
     * Clamped rather than refused, because a caller asking for more than the ceiling wants the
     * ceiling — `memory_list`'s 500 and `trace_search`'s 200 are the same shape. The value the server
     * actually used comes back as `node_limit`, so a clamped ask is visible rather than silent.
     */
    limit: Optional(Count)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        /** 1-based distance from the center: 1 or 2, never 0. */
        hop: Count,
        rel: Schema.String,
        /**
         * True when a SLEEP-MINED edge reaches this node, false when only authored `<link>` edges do.
         *
         * The max over every edge that reached the node, not the `rel` field's companion: a node an
         * authored edge and a mined edge both reach is `derived: true`, because the question a caller
         * asks of this field is "may this connection be a machine's suspicion", and one mined route is
         * enough for the answer to be yes.
         *
         * Published because the description advertises mined edges as the point of the tool, and
         * without this field a caller cannot tell a suspicion from an assertion — which is exactly the
         * distinction it needs in order to decide how much to trust a lateral hop.
         */
        derived: Schema.Boolean
      })
    ),
    /**
     * DISTINCT edges the walk enumerated, keyed on `(src, rel, dst)`, over both hops and both
     * directions. Scope: this one call's walk, not the corpus — `memory_status.edges` is the corpus
     * total and the two are different coordinate spaces.
     *
     * It is NOT `nodes.length` and must not be read as one: two memories joined by two rels are one
     * node and two edges, and an edge landing on a path the node clamp dropped is counted here and
     * absent there. Bounded by the walk's own 10000-row scan cap, which `scan_saturated` reports.
     */
    edges: Count,
    /**
     * The node ceiling this answer was built under: the SERVER's clamp of the caller's `limit` into
     * `1..200` ({@link NEIGHBORS_LIMIT}), not the raw ask, so a client that sent 10000 reads back 200
     * and knows the answer is a ceiling rather than a corpus fact. A quantity of distinct paths, scoped
     * to this one call.
     *
     * `node_limit` and not `limit`, because this answer carries TWO bounds and they are not
     * interchangeable: this one governs `nodes`, and the walk's own 10000-edge-row cap governs
     * everything, which is what `scan_saturated` reports.
     */
    node_limit: Count,
    /**
     * Distinct paths the walk reached and `node_limit` turned away, filled by the server.
     *
     * A COUNT of paths absent from `nodes`, scoped to this call, so `nodes.length +
     * dropped_node_count` is every path the walk found. `0` means `nodes` holds all of them, which is
     * how a client tells a complete neighborhood from a clamped one. A larger `limit`, up to
     * {@link NEIGHBORS_LIMIT}, returns them.
     *
     * `_count` because it is a quantity, and this repo's four numeric suffixes are not
     * interchangeable — an `_offset`, a `_seq`, and an `_index` are all different things. `edges`
     * keeps its bare name because it is already a published field a client branches on.
     */
    dropped_node_count: Count,
    /**
     * True when the walk stopped at its own 10000-edge-row cap, so edges past the cap were never
     * enumerated and NO `limit` recovers them — the truncation `dropped_node_count` cannot describe.
     * Narrow the walk with `rels` or `depth: 1` to get an exhaustive answer.
     *
     * A plain boolean, never a null union: an absent or null marker cannot be told from a server that
     * does not report saturation, and this is the field that says whether `nodes` and `edges` describe
     * the whole neighborhood.
     */
    scan_saturated: Schema.Boolean
  })
})

const MemoryArchive = Tool.make("memory_archive", {
  description:
    "Soft-evict a memory: `git mv` into archive/<YYYY>/ with the archive stamps. Nothing is ever deleted, and `git log --follow` reads straight through.",
  dependencies: [Store, Indexer],
  parameters: Schema.Struct({
    path: MemoryPath,
    reason: Schema.String
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    archive_path: MemoryPath
  })
})

const MemoryReinforce = Tool.make("memory_reinforce", {
  description:
    "Record that a memory helped or misled. Gated by a 900-second per-path cooldown, so a replayed query cannot inflate a memory's ranking; `cooled_down` lists the paths the cooldown held back.",
  dependencies: READS(),
  parameters: Schema.Struct({
    paths: Schema.Array(MemoryPath),
    signal: Schema.Literals(REINFORCE_SIGNALS)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    bumped: Schema.Array(MemoryPath),
    cooled_down: Schema.Array(MemoryPath)
  })
})

const MemoryList = Tool.make("memory_list", {
  description:
    "Page through the corpus by facet. `next_cursor` is a keyset on the path, so a page stays correct even while a sleep cycle archives files. " +
    FACET_SCOPE_CONTRACT,
  dependencies: READS(),
  parameters: Schema.Struct({
    memory_type: Optional(WritableType),
    workspace: Optional(Schema.String),
    tag: Optional(Schema.String),
    entity: Optional(Schema.String),
    /** `<dl>` facet predicates as `name=value` strings, composing exactly as `memory_search`'s do. */
    facets: Optional(Schema.Array(Schema.String)),
    para: Optional(Schema.Literals(PARA_BUCKETS)),
    limit: Optional(Count),
    cursor: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        memory_type: Schema.String,
        gist: Schema.String,
        workspace: Schema.NullOr(Schema.String),
        para: Schema.String,
        confidence: Finite,
        importance: Count,
        archived: Schema.Boolean,
        updated_at: Schema.String
      })
    ),
    next_cursor: Schema.NullOr(Schema.String)
  })
})

const TraceSearch = Tool.make("trace_search", {
  description:
    "Find past Claude Code sessions by what was asked in them. A read-only index over transcript files: no session content is stored, only pointers and capped heads.",
  dependencies: READS(),
  parameters: Schema.Struct({
    query: Schema.String,
    cwd: Optional(Schema.String),
    since: Optional(Schema.String),
    limit: Optional(Count)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({
        session_id: Schema.String,
        slug: Schema.String,
        cwd: Schema.NullOr(Schema.String),
        started_at: Schema.NullOr(Schema.String),
        prompt_count: Count,
        first_prompt: Schema.String,
        ai_title: Schema.NullOr(Schema.String)
      })
    )
  })
})

const TraceLinks = Tool.make("trace_links", {
  description:
    "Which memories a session produced, or which sessions touched a memory. Needs a session_id or a path. Both absent is refused rather than returning every link ever recorded.",
  dependencies: READS(),
  parameters: Schema.Struct({
    session_id: Optional(Schema.String),
    path: Optional(MemoryPath)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    links: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        session_id: Schema.String,
        prompt_id: Schema.NullOr(Schema.String),
        turn_uuid: Schema.NullOr(Schema.String),
        link_kind: Schema.String,
        at: Schema.String
      })
    )
  })
})

const MemoryStatus = Tool.make("memory_status", {
  description:
    "Corpus health in one call: HEAD, dirty state, counts by type, edge totals, whether the index describes the current commit, and when sleep last ran.",
  dependencies: [Store, DatabaseService],
  /**
   * `Tool.EmptyParams`, not `Schema.Struct({})`.
   *
   * Probed on effect 4.0.0-rc.109: an empty `Schema.Struct` derives
   * `{"anyOf":[{"type":"object"},{"type":"array"}]}`, a union with an ARRAY branch, because a struct
   * with no fields constrains nothing and the codec's encoded form admits both. A client reading that
   * cannot tell it should send `{}`, and a strict one may refuse to call the tool at all.
   * `Tool.EmptyParams` derives `{"type":"object","additionalProperties":false}`, which says exactly
   * "an object, and no fields", the intent.
   */
  parameters: Tool.EmptyParams,
  failure: ToolFailure,
  success: Schema.Struct({
    head_sha: Schema.NullOr(Schema.String),
    dirty: Schema.Boolean,
    counts_by_type: Schema.Record(Schema.String, Count),
    archived_count: Count,
    edges: Count,
    /** True when the index's watermark IS the current HEAD. A row count cannot answer this. */
    index_fresh: Schema.Boolean,
    embedder_up: Schema.Boolean,
    last_sleep: Schema.NullOr(
      Schema.Struct({
        run_id: Schema.String,
        status: Schema.String,
        started_at: Schema.String
      })
    )
  })
})

/**
 * The toolkit. Exactly fourteen: design.md §8's thirteen plus `memory_write_batch`.
 *
 * Order is the read order of the table in §8, which is also roughly the order an agent needs them:
 * write and read, then the three retrieval shapes, then the graph operations, then the trace plane,
 * then status.
 *
 * The batch sits SECOND, directly after `memory_write`, rather than appended at the end. `tools/list`
 * publishes this order and an agent reads it top-down, so the tool `memory_write`'s own description
 * points at is the very next entry. A pointer whose target is thirteen tools away is one an agent
 * reads after it has already decided how to write.
 */
export const MemhtmlToolkit = Toolkit.make(
  MemoryWrite,
  MemoryWriteBatch,
  MemoryRead,
  MemorySearch,
  MemoryRecall,
  MemoryCorrect,
  MemoryLink,
  MemoryNeighbors,
  MemoryArchive,
  MemoryReinforce,
  MemoryList,
  TraceSearch,
  TraceLinks,
  MemoryStatus
)

/**
 * The tool names, derived from the toolkit rather than restated.
 *
 * Two lists would drift: a placeholder list that once said fourteen names and a toolkit that now
 * builds thirteen would leave a test asserting the list and proving nothing about the server.
 */
export const TOOL_NAMES = Object.keys(MemhtmlToolkit.tools) as ReadonlyArray<
  keyof typeof MemhtmlToolkit.tools
>

export type ToolName = (typeof TOOL_NAMES)[number]
