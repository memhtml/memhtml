import {
  DatabaseService,
  ExtractorPort,
  Indexer,
  IndexRecorder,
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
 * literal, and a class schema's decode expects an instance — the failure is a decode error on every
 * call, at runtime, for every tool. This is the one trap the whole surface is arranged around.
 *
 * **Sleep is deliberately absent.** It is a cron/operator action producing a reviewable branch, not
 * something an agent fires mid-conversation: a sleep run rewrites confidence across the corpus,
 * archives memories, and creates a branch a human is expected to read. `memhtml sleep run` is the
 * entry point, and if the fleet ever wants one here it is `sleep_status` (read-only) — the write
 * side stays behind an operator.
 *
 * Every `success` schema is also a `Schema.Struct`, so `tools/list` publishes a JSON Schema the
 * client can validate a response against rather than an opaque object.
 *
 * **Every tool declares `failure: ToolFailure`, and the omission is a silent wire bug.** A tool with
 * no declared failure schema gets `Schema.Never` (`Tool.ts:1265`), so `McpServer`'s declared-failure
 * predicate rejects everything and every failure — typed domain error included — is rewritten to
 * "Tool execution failed due to an internal server error" before it reaches the caller
 * (`McpServer.ts:831-847`). The declaration is what puts a tool's failures on the branch that passes
 * prose through; see `failure.ts` for the mechanism. `failureMode` is left at its `"error"` default
 * on purpose: the error CHANNEL is what `McpServer` catches, and `"return"` would instead fold the
 * failure into the success union, where the server would see a successful call carrying a failure
 * payload no MCP client knows to read.
 */

/** The eight types an agent may write. `arc` is system-written by the sleep cycle. */
const WritableType = Schema.Literals(WRITABLE_MEMORY_TYPES)

/** The nine MEMORY-class rels. A person or provenance rel cannot be named here. */
const MemoryRelSchema = Schema.Literals(MEMORY_RELS)

/**
 * A repo-root-relative path: `areas/oncall/rollback-order.html`.
 *
 * The git-tree form with no leading slash — which is `files.path`, and the ID of a memory. The
 * `<link href>` form in the HTML carries a leading slash and is converted at the store boundary, so
 * a tool never sees it.
 */
const MemoryPath = Schema.String

/**
 * `Schema.Finite`, not `Schema.Number`, for every numeric field.
 *
 * `Number` derives a JSON Schema with an `anyOf` carrying a STRING branch, because `Infinity` and
 * `NaN` are not JSON numbers and the codec represents them as strings — probed on this beta,
 * `Schema.Number` derives `{"anyOf":[{"type":"number"},{"type":"string","enum":["Infinity",
 * "-Infinity","NaN"]}]}`. A client reading that sees a union where the tool wants a number. `Finite`
 * derives a clean `{"type":"number"}`.
 */
const Finite = Schema.Finite

/** A count: a non-negative quantity. */
const Count = Schema.Int

/**
 * An optional parameter that a client may also send explicitly as `null`.
 *
 * A bare `Schema.optional(X)` is a WIRE BUG here, and it is the kind a byte-comparison fixture
 * cannot see: the derived JSON Schema publishes `{"anyOf":[{"type":"string"},{"type":"null"}]}` — telling
 * every client that `null` is acceptable — while the decoder rejects it with "Expected string |
 * undefined, got null" (both probed on effect 4.0.0-beta.102). So a client that read the schema and
 * did the obvious thing, sending `{"workspace": null}` for "no workspace", would get a decode error
 * on a call the published contract said was valid. Many clients serialize an absent optional exactly
 * that way.
 *
 * `optionalKey(NullOr(X))` makes the decoder accept all three forms a client can produce — absent,
 * a value, and `null` — and publishes the FLAT `{"anyOf":[{"type":"string"},{"type":"null"}]}`.
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
 * TOOL's — so `kit.toLayer({…})` accepts a handler that yields `Store`, and the requirement then
 * surfaces on the layer where `layerApp` satisfies it. Without the declaration a handler that reads
 * a service is a type error, and the only ways out are casting the handler or building the services
 * inside it: the first loses the check that the app layer provides what the tools need, and the
 * second gives every tool call its own database connection.
 *
 * Each tool declares only what it actually uses, so a handler that grows a dependency has to say so
 * — which keeps `memory_search` provably unable to reach the store and write.
 *
 * A FUNCTION per set, not a shared constant: the option's type is a mutable array, so handing the
 * same array to fourteen tools would let one tool's construction mutate the dependency list of the
 * other thirteen. Same reason `@memhtml/index`'s `TURSO_OPTS` is copied per connection.
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
 * `article_html` is the one parameter where the caller owns a format constraint — every other
 * parameter is a value the template places itself. An agent that learns the `<mark>` rule from an
 * `InvalidMemory` on its first write has already spent a round trip on something the tool could
 * have told it.
 *
 * The four clauses are the ones a caller can actually violate: format.md constraint 1 (exactly one
 * `<mark>`, inside the first `<p>` or `<li>`), constraint 3 (no `class`, `style`, or `<script>`),
 * the closed vocabulary, and the `<time datetime>` rule — which is not a constraint at all but a
 * CONSEQUENCE the caller has to know about, since the first such element becomes `files.event_at`
 * and the recency arm ranks episodic memories by it rather than by write time.
 */
const ARTICLE_HTML_CONTRACT =
  "Supply EXACTLY ONE of `body` or `article_html` — both or neither is refused. " +
  "`article_html` is raw <article> inner markup used verbatim, and the caller owns the format: exactly one <mark>, " +
  "inside the first <p> or the first <li>, and never inside <aside> or <details>; only elements from the closed " +
  "vocabulary in docs/format.md; no class attribute, no style attribute, no <script>, no event handlers. " +
  'The FIRST <time datetime="…"> element becomes the memory\'s event time, which is what the recency arm ranks ' +
  "by — so an episodic memory about last week should carry last week's date, not today's. Markup that violates " +
  "the format is refused before any file is written or committed. " +
  "Code snippets: in `body` prose, a paragraph that is entirely a fenced code block (```ts … ```) becomes " +
  '<figure><pre><code data-lang="ts">, whitespace verbatim, and the language promotes to a `lang:ts` entity; ' +
  "a blank line inside the fence does not split it. In `article_html`, author the same markup yourself — " +
  "data-lang, never class (forbidden) and never lang= (that names human languages)."

/**
 * When to batch and what a batch does, stated in the description of BOTH write tools.
 *
 * A shared constant for the same reason `ARTICLE_HTML_CONTRACT` is one: `memory_write` has to point at
 * `memory_write_batch` and `memory_write_batch` has to explain itself, and two hand-written versions of
 * one workflow drift the first time the semantics move. Written once, appended twice.
 *
 * And it lives in a DESCRIPTION because this server has nowhere else to put it. MCP has a server-level
 * `instructions` field for exactly this kind of cross-tool guidance, and effect 4.0.0-beta.102 never
 * emits it — see the comment in `server.ts` next to `layerStdio`. Tool descriptions are the only
 * channel, so a workflow rule that is not in one is a rule no agent reads.
 *
 * Every clause is something the caller decides or has to predict, and nothing else: the threshold that
 * makes batching worth it, the ordering guarantee it can index results by, the atomicity default it
 * would otherwise have to discover from a refusal, the flag that changes that default, and the two
 * outcomes an agent most often mistakes for errors — a dedupe, and a per-op failure in continue mode.
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
 * versions. It is not appended to `memory_write`'s description — the singular has no such flag, and a
 * paragraph about a parameter a tool does not accept is a paragraph that makes an agent try to send it.
 *
 * Every clause is something a caller acts on. The distinction from dedupe, because an agent that
 * thought this was dedupe would stop checking. The RULE, because it is grammatical rather than semantic
 * and an agent expecting meaning-matching would trust a null it should not. The two match sources, since
 * the intra-batch one is invisible to every other tool. The nulls, all four of them, because each one is
 * an absence of information rather than an absence of conflict. And the propose-only contract WITH its
 * reason — the BEAM caveat — spelled out rather than asserted: an agent told only "this does not block"
 * will assume it is a v1 limitation and hand-roll the archiving the design deliberately refuses.
 */
const CONFLICT_GUIDANCE =
  "Set detect_conflicts to true and each per-op result gains a `conflict` field naming what that op's claim CONTRADICTS. " +
  "This is not dedupe: dedupe catches an op whose content is IDENTICAL to something stored, while this catches an op that says something DIFFERENT about the same thing — the case dedupe is blind to, and the one that actually rots a corpus. " +
  "The match is grammatical rather than semantic. A claim splits into a frame — the subject and relation up to its LAST of/is/in/to/by/as — and a value, and two claims conflict when they share a frame: 'The pool ceiling is 64' and 'The pool ceiling is 128' both key on 'the pool ceiling is'. " +
  "conflict.path names an ACTIVE memory already holding that slot. conflict.batch_index names an EARLIER op in this same call, which no other tool can see because neither op is stored yet; it has no path for that reason. conflict.claim is the other claim's own text, so you can decide without a second call. " +
  "conflict is null when nothing matched, when detect_conflicts was absent, when the claim states no frame shape (the rule refuses frames under three tokens and values over six, so short claims and claims trailed by a clause are deliberately unmatched rather than loosely matched), and always on an op that used article_html — the claim is inside your markup there and is not read until the store renders it. " +
  "THE ASSIST NEVER CHANGES WHAT IS WRITTEN. An op carrying a conflict is written exactly as it would have been without the flag: nothing is archived, nothing is refused, later does not win, and the summary counts are unchanged. " +
  "That is deliberate, not a limitation — sometimes the contradiction IS the answer. A memory recording that a runbook step changed necessarily contradicts the memory stating the old step, and a system that resolved that for you would destroy the pair a reader needs in order to see the change at all. " +
  "So YOU decide, per conflict: keep both (they are about different things, or both are true), call memory_correct on the named path instead (the new claim supersedes the old one, which stays readable under archive/), or drop the op. " +
  "Archived memories never match, so a superseded claim stops contradicting the claim that superseded it."

/**
 * The fields that author ONE memory, shared by `memory_write`'s parameters and `memory_write_batch`'s
 * op struct.
 *
 * D7 says the batch op is "the same fields as memory_write" — written twice, that is a claim two
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
   * paragraph — see `claimFromProse`/`proseTail` in `@memhtml/cli`'s `prose.ts`, the one copy this door and
   * `memhtml apply` share. Optional because `article_html` is the other way to author the same article, and
   * the handler refuses a call that names both or neither.
   */
  body: Optional(Schema.String),
  /** Pre-authored article markup, used verbatim in place of `body`. See the description's contract. */
  article_html: Optional(Schema.String),
  memory_type: WritableType,
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
    "Write one memory to the corpus. Returns the existing path with deduped=true when an active memory already holds this exact content — a duplicate creates no file and no commit. " +
    ARTICLE_HTML_CONTRACT +
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
 * own `required` — probed on effect 4.0.0-beta.102, `Schema.Array(Schema.Struct({…}))` derives the
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
   * unconditionally — that is the disagreement, and it is what the decision is made on — and then
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
       * that op's file does not exist yet — the batch has not been written when the assist runs.
       */
      batch_index: Schema.NullOr(Count),
      /** The other claim's own text. */
      claim: Schema.String
    })
  )
})

const MemoryWriteBatch = Tool.make("memory_write_batch", {
  description:
    "Write many memories in ONE commit: every op is validated first, every surviving file is staged, and the batch commits and reindexes exactly once. " +
    "commit_sha is null when nothing was written — an all-deduped batch, or an aborted one. " +
    /**
     * Same order as `memory_write`'s — the article contract, then the batch workflow — so an agent that
     * has read one description finds the other's clauses where it expects them. Reversed here, the
     * guidance's closing XOR reminder would sit immediately before the full statement of that same rule,
     * which reads as a repetition rather than as two sections.
     */
    ARTICLE_HTML_CONTRACT +
    " " +
    BATCH_GUIDANCE +
    /**
     * LAST, after the workflow. The guidance states what a batch IS and an agent needs that before an
     * optional assist over it means anything; leading with the conflict rule would explain a field on a
     * result shape the reader has not been told about yet.
     */
    " " +
    CONFLICT_GUIDANCE,
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
     * Batch-level provenance: the session this call is being made in. An op that names its own wins,
     * because it is the more specific statement about where that one memory came from — which is what
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
      skipped: Count
    }),
    commit_sha: Schema.NullOr(Schema.String)
  })
})

const MemoryRead = Tool.make("memory_read", {
  description:
    "Read one memory in full: its head metadata, authored links, and complete article body. The only path to a <details> body, which recall never quotes. An explicit open of a named path COUNTS as salience — this is the read that moves the access plane, while a search or recall hit does not.",
  /**
   * `DatabaseService` is here because an explicit open bumps the access plane: `readMemory` reaches the
   * state plane through `bumpAccess`, so the tool has to declare it or the handler is a type error. The
   * widening is the salience rule made visible in the dependency set — `memory_search` still cannot
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
    "Ranked search over the corpus: lexical, vector, recency, and salience arms fused with RRF, then diversified. Each hit carries a `snippet` — the text of the file's best-matching chunk for this query (its opening chunk when the vector arm did not fire), truncated with a trailing `…` when cut. `degraded` is true when the vector arm did not fire, so the result came from fewer signals. Each hit also carries `entities` in `type:name` form; pass one of those values back as `entity` to make the next call the second hop of a chain — that is two calls, not a guess about spelling. An `entity` scope that matches nothing returns NO hits and says so through `scope_empty`: this tool never widens a scope it could not satisfy. Returning a path changes nothing: a hit is this ranker's guess, so it never bumps salience — call memory_read to open the one you chose, and memory_reinforce to record whether it was right.",
  dependencies: RETRIEVES(),
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Optional(Count),
    memory_types: Optional(Schema.Array(WritableType)),
    workspace: Optional(Schema.String),
    tags: Optional(Schema.Array(Schema.String)),
    /**
     * One entity reference in `type:name` form, the same spelling `memory_list` takes and the same
     * spelling a hit's `entities` publishes — so a value read off a hit is a valid scope verbatim.
     */
    entity: Optional(Schema.String),
    include_archived: Optional(Schema.Boolean)
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
         * The best-matching chunk's text for THIS query — the vector arm's winning chunk, or the
         * file's opening chunk on the degraded path — truncated with a trailing `…` when cut.
         */
        snippet: Schema.String,
        /**
         * This memory's entity references in `type:name` form, sorted, possibly empty.
         *
         * The next hop's `entity` parameter, published in the form that parameter accepts: the whole
         * point is that a caller chains by COPYING a value rather than by reconstructing one.
         */
        entities: Schema.Array(Schema.String)
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
    "Supersede a memory: write the corrected version and archive the target in ONE commit, linked in both directions. Never edits in place — the superseded memory stays readable under archive/. " +
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
    "The memory graph around one path, to at most two hops, in both directions. Includes sleep-mined edges: lateral retrieval is what they are for.",
  dependencies: READS(),
  parameters: Schema.Struct({
    path: MemoryPath,
    depth: Optional(Count),
    rels: Optional(Schema.Array(MemoryRelSchema))
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        /** 1-based distance from the centre: 1 or 2, never 0. */
        hop: Count,
        rel: Schema.String
      })
    ),
    edges: Count
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
    "Page through the corpus by facet. `next_cursor` is a keyset on the path, so a page stays correct even while a sleep cycle archives files.",
  dependencies: READS(),
  parameters: Schema.Struct({
    memory_type: Optional(WritableType),
    workspace: Optional(Schema.String),
    tag: Optional(Schema.String),
    entity: Optional(Schema.String),
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
    "Which memories a session produced, or which sessions touched a memory. Needs a session_id or a path — both absent is refused rather than returning every link ever recorded.",
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
   * Probed on effect 4.0.0-beta.102: an empty `Schema.Struct` derives
   * `{"anyOf":[{"type":"object"},{"type":"array"}]}` — a union with an ARRAY branch, because a struct
   * with no fields constrains nothing and the codec's encoded form admits both. A client reading that
   * cannot tell it should send `{}`, and a strict one may refuse to call the tool at all.
   * `Tool.EmptyParams` derives `{"type":"object","additionalProperties":false}`, which says exactly
   * "an object, and no fields" — the intent.
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
 * points at is the very next entry — a pointer whose target is thirteen tools away is one an agent
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
