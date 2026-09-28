import { MEMORY_RELS } from "@memhtml/contracts/edges"
import { RECALL_DISCIPLINE_TEXT } from "@memhtml/contracts/guidance"
import { MEMORY_TYPES, TASK_STATUSES, WRITABLE_MEMORY_TYPES } from "@memhtml/contracts/types"
import { REINFORCE_SIGNALS } from "@memhtml/domain"
import { HOOK_EVENTS, HOSTS } from "@memhtml/integrations"

import { CONFIG_VARS } from "./config.js"
import { ERROR_CODES, type ResponseType } from "./envelope.js"
import { DEFAULT_EXEC_LANG, EXEC_LANGS } from "./exec-lang.js"
import { EMBED_DEADLINE_DEFAULT_MS } from "./head-protocol.js"
import { AUTHORABLE_RELS } from "./operations.js"

export interface FlagSpec {
  readonly name: string
  readonly type: "string" | "int" | "boolean"
  readonly description: string
  readonly default?: string | number | boolean
  readonly values?: ReadonlyArray<string>
  readonly required?: boolean
  /** True when the flag may be repeated, each occurrence appending a value. */
  readonly repeatable?: boolean
}

export interface ArgSpec {
  readonly name: string
  readonly description: string
  readonly required: boolean
  /**
   * True when this argument may repeat, each occurrence adding one value.
   *
   * Only legal on the LAST argument, and it is what tells `validate` that a positional past the
   * declared count belongs to the command rather than being a surplus token. Without it a variadic
   * command is indistinguishable from a caller who typed one word too many.
   */
  readonly repeatable?: boolean
}

export interface CommandSpec {
  readonly name: string
  readonly summary: string
  readonly args: ReadonlyArray<ArgSpec>
  readonly flags: ReadonlyArray<FlagSpec>
  readonly responseTypes: ReadonlyArray<ResponseType>
  /**
   * Complete invocations, each beginning `memhtml <name>`, that `memhtml help <name>` prints and the
   * manifest carries. They live beside the flags they exercise so a renamed flag is caught by the
   * test that parses every example through the real parser and validator (`help.test.ts`), rather
   * than by a reader who tried one. Optional: a command with no example prints none, and help
   * never fabricates one from the usage line.
   */
  readonly examples?: ReadonlyArray<string>
}

/**
 * Flags every command accepts. Listed once so the manifest cannot drift from behavior.
 *
 * There is no global `--json` flag: the typed JSON envelope is the only output every command has, so
 * a flag for it would be parsed, advertised, and read by nothing. Logs go to stderr. The one command
 * with a second output shape is `help`, which renders Markdown on a terminal, and `--json` is
 * declared on THAT command alone (`memhtml help <command> --json`, or `memhtml <command> --help --json`)
 * so the flag is advertised exactly where it changes something.
 */
export const GLOBAL_FLAGS: ReadonlyArray<FlagSpec> = [
  {
    name: "dense",
    type: "boolean",
    description: "Minify JSON and drop null fields, for pasting into a context window.",
    default: false
  },
  {
    name: "repo",
    type: "string",
    description: "Path to the memory repo. Defaults to $MEMHTML_ROOT.",
    default: ""
  },
  {
    name: "help",
    type: "boolean",
    description:
      "Describe this command instead of running it: usage, arguments, flags, response type, examples. Also `-h`. Markdown when stdout is a terminal, a `cli.help` envelope when piped or with --json. Flags other than --json and --dense are ignored, nothing is opened or written, exit 0.",
    default: false
  }
]

/**
 * The `--strict-path` help.
 *
 * It states the DEFAULT as well as the opt-in, because the default is the surprising half: a caller
 * reaching for this flag is a caller who just discovered that a malformed `--path` was re-derived, and
 * the help has to confirm that reading rather than leave it inferred. The refusal's code is named too,
 * since a caller branches on `code` and never on the prose.
 */
const STRICT_PATH_FLAG =
  "Refuse an unusable --path instead of letting the placement rule decide. " +
  "By default a --path that is not a usable memory path is re-derived, so the memory lands somewhere you did not name and the response reports that other path as a success. " +
  "With this flag the write is REFUSED with ERR_INVALID_MEMORY naming the clause the path broke, and nothing is written, staged, or committed. " +
  "It governs the path you NAMED: with no --path there is nothing to be strict about and the flag changes nothing, while an EMPTY or blank --path is named rather than absent and is refused — that is what your own path template renders when it produced nothing. " +
  "An OCCUPIED path is refused with ERR_WRITE_CONFLICT with or without it."

/**
 * The `--facet` help, shared by every command that scopes on one.
 *
 * The composition rule is IN the help because it is a semantic contract rather than a convenience: a
 * caller who read `--facet a=1 --facet b=2` as "either" would act on a superset, and one who read
 * `--facet a=1 --facet a=2` as "both" would act on an empty result. Neither mistake is visible in
 * the rows that come back.
 *
 * The unitless clause is there for the same reason. `file_facets.numeric_value` exists, and offering
 * a numeric comparison over it would be offering an inequality on an unlabelled number — the unit
 * lives in the human phrasing beside the value, so the caller owns it, and it owns it by matching the
 * text the corpus holds.
 */
const FACET_FLAG =
  "Restrict to memories carrying a `<dl>` facet, as name=value; the value may contain `=`, the name may not. " +
  "Repeatable, and the composition is fixed: values under the SAME name broaden (--facet doc-type=runbook --facet doc-type=guide is either), " +
  "DIFFERENT names narrow (--facet doc-type=runbook --facet tier=1 is both). " +
  "This is the extension axis: memhtml's element and meta vocabularies are closed, so a consumer's own document kinds, states, and tiers live in `<dt>`/`<dd>` pairs and are queried here. " +
  "The match is on the facet's TEXT with no case folding, so write the halves you mean to query. The stored form is the element's text content, which the parser collapses whitespace runs in and trims — so `<dd>runbook  rollback</dd>` is stored and queried single-spaced. There is no numeric comparison: a `<data value>` is indexed UNITLESS because the unit lives in the prose beside it, so the caller owns the unit and matches the text it wrote."

/** Flags every retrieval command shares, so `search` and `recall` cannot scope differently. */
const SCOPE_FLAGS: ReadonlyArray<FlagSpec> = [
  {
    name: "type",
    type: "string",
    description: "Restrict to one memory type. Repeatable; each occurrence broadens (ANY-of).",
    values: WRITABLE_MEMORY_TYPES,
    repeatable: true
  },
  {
    name: "workspace",
    type: "string",
    description:
      "Restrict to one workspace. STRICT: a scoped query never returns a memory with no workspace."
  },
  {
    name: "tag",
    type: "string",
    description: "Restrict to memories carrying any of these tags. Repeatable; each broadens.",
    repeatable: true
  },
  {
    name: "entity",
    type: "string",
    // Singular, unlike --tag, because the scope exists to chain one hop off a hit's own entity list,
    // which is one reference at a time. Same spelling `memhtml list --entity` takes, so the two are
    // one vocabulary rather than two facets that happen to share a word.
    description:
      "Restrict to memories carrying one `type:name` entity reference, e.g. service:checkout-api, the form a hit's `entities` publishes, so a hop is a copy. A scope matching nothing returns no hits and says so; it never widens."
  },
  {
    name: "facet",
    type: "string",
    description: FACET_FLAG,
    repeatable: true
  },
  {
    name: "include-archived",
    type: "boolean",
    description: "Include archived memories. Eviction is a `git mv`, so they still exist.",
    default: false
  },
  {
    name: "as-of",
    type: "string",
    description:
      "Point-in-time view: returns what was believed valid at this ISO instant, including since-superseded memories (marked superseded_by). The validity window is coalesce(valid_from, event_at, created_at) <= as-of < valid_until."
  }
]

/**
 * The single source of parsing, validation, and the manifest. A command lands here
 * before it lands anywhere else, so `memhtml manifest` and `memhtml agents-doc` describe
 * what the binary actually accepts rather than what someone remembered to document.
 *
 * A subcommand is one entry with a space in its name (`index rebuild`), not a nested tree.
 * Flattening keeps `nearest()` able to suggest across the whole surface, a typo in the noun
 * (`memhtml indx rebuild`) and a typo in the verb (`memhtml index rebiuld`) both get a candidate, and
 * keeps one table driving parsing, the manifest, and the generated doc.
 */
export const COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    name: "manifest",
    summary: "Emit this CLI's full machine-readable contract.",
    args: [],
    flags: [],
    responseTypes: ["cli.manifest"],
    examples: ["memhtml manifest --dense"]
  },
  {
    name: "help",
    summary:
      "Describe one command: usage, arguments, flags, response type, examples. Markdown on a terminal, a cli.help envelope when piped.",
    args: [
      {
        name: "command",
        description:
          "The command to describe, one or two words (`search`, `index rebuild`). Omitted: the whole manifest, as Markdown on a terminal and as the cli.manifest envelope when piped.",
        required: false,
        repeatable: true
      }
    ],
    flags: [
      {
        name: "json",
        type: "boolean",
        description:
          "Emit the cli.help envelope even when stdout is a terminal. Wins over the terminal check, so a script can never receive Markdown by accident.",
        default: false
      }
    ],
    responseTypes: ["cli.help", "cli.manifest"],
    examples: ["memhtml help search", "memhtml help index rebuild --json", "memhtml search --help"]
  },
  {
    name: "init",
    summary: "Scaffold a memory repo at --repo/$MEMHTML_ROOT: git init, PARA dirs, merge driver.",
    args: [],
    flags: [],
    responseTypes: ["repo.init"]
  },
  {
    name: "write",
    summary: "Write one memory. Content-hash duplicates return the existing path, uncommitted.",
    args: [],
    flags: [
      {
        name: "title",
        type: "string",
        description: "The memory's title. Becomes the <title> and the filename slug.",
        required: true
      },
      {
        name: "claim",
        type: "string",
        description:
          "The one load-bearing sentence. Becomes the <mark> span and files.gist. Exactly one of --claim or --article-html."
      },
      {
        name: "body",
        type: "string",
        description: "A prose paragraph after the claim. Repeatable, one <p> each.",
        repeatable: true
      },
      {
        name: "article-html",
        type: "string",
        description:
          "Raw <article> markup used verbatim in place of --claim/--body. Must contain exactly one <mark> in the first <p> or <li>; the first <time datetime> becomes the memory's event time. The store refuses format violations before any commit. Exactly one of --claim or --article-html."
      },
      {
        name: "type",
        type: "string",
        description:
          "The memory type. `arc` is admitted here, on the operator surface, for curated import and deliberately authored rules; the agent tools (`memory_write`) still refuse it, because an agent naming an arc asserts a conclusion the corpus has not earned.",
        values: MEMORY_TYPES,
        required: true
      },
      {
        name: "path",
        type: "string",
        description:
          "An explicit path override. One that is not a usable memory path (rooted in a PARA bucket, ending in .html, no `.` or `..` segment) is IGNORED and the placement rule decides instead, so a malformed override lands the memory somewhere you did not name — pass --strict-path to have it refused instead. One a file ALREADY occupies is REFUSED with ERR_WRITE_CONFLICT and nothing is written or committed: this corpus overwrites nothing, and an explicit path gets no `-2` suffix because you named one path. To replace what a memory says, use `memhtml correct <path>`."
      },
      {
        name: "strict-path",
        type: "boolean",
        description: STRICT_PATH_FLAG,
        default: false
      },
      { name: "workspace", type: "string", description: "Routes the memory to projects/<slug>/." },
      {
        name: "tag",
        type: "string",
        description: "A tag. Repeatable; the first one routes an unplaced resource memory."
      },
      {
        name: "entity",
        type: "string",
        description: "A `type:name` entity reference, e.g. service:checkout-api. Repeatable.",
        repeatable: true
      },
      {
        name: "importance",
        type: "int",
        description: "1-10, a display ordinal. The retention scorer divides by 10."
      },
      { name: "confidence", type: "string", description: "0-1. 1.0 is an unqualified assertion." },
      {
        name: "session-id",
        type: "string",
        description: "The Claude Code session. Stamped into the head AND indexed as a link."
      },
      { name: "prompt-id", type: "string", description: "The prompt within that session." },
      { name: "turn-uuid", type: "string", description: "The turn within that session." }
    ],
    responseTypes: ["memory.written"],
    examples: [
      'memhtml write --title "One writer and many readers share the index" --claim "WAL admits a single writer at a time and any number of concurrent readers." --type semantic --tag infra',
      'memhtml write --title "Checkout retries" --claim "The checkout service retries twice." --type procedural --entity service:checkout --workspace payments'
    ]
  },
  {
    name: "apply",
    summary:
      "Write many memories from a JSONL op stream: ONE commit, ONE index update, per-op results.",
    args: [],
    flags: [
      {
        name: "file",
        type: "string",
        description:
          "The JSONL file to read. One complete JSON object per line. Omit it, pass `--file -`, or pass a positional `-` to read the stream from stdin; stdin beside a real --file is refused."
      },
      {
        name: "continue-on-error",
        type: "boolean",
        description:
          "Best-effort: a refused op is reported and skipped while every surviving op lands in the one commit. Atomic by default. The first refused op aborts the batch and nothing is written.",
        default: false
      },
      {
        name: "detect-conflicts",
        type: "boolean",
        description:
          "Report each op's frame-matches as a per-op `conflict`: the ACTIVE memory (or the earlier op) whose claim occupies the same subject-and-relation slot. PROPOSE-ONLY: every op still writes exactly as it would have, because sometimes the contradiction is the answer. You decide: write anyway, `memhtml correct` the match, or drop the line.",
        default: false
      },
      {
        name: "detect-near-duplicates",
        type: "boolean",
        description:
          "Report each op's embedding near-duplicates as a per-op `near_duplicates` list: ACTIVE memories (or earlier ops in this stream) whose text sits at or above cosine 0.92 against this op's claim and body, best first, with the measured similarity. The vector sibling of --detect-conflicts: that flag catches a DIFFERENT value in the same grammatical slot, this one catches a REWORDING of the same fact. PROPOSE-ONLY for the same reason, and the score is geometry — negations also sit above 0.92, so read the paired claim before folding anything. Costs one embedding call per batch; ops written as `article_html` are never checked; when the embedder cannot run (MEMHTML_EMBED=off, or the call failed) the result carries `near_duplicates_degraded: true` and every `near_duplicates` is null, meaning UNCHECKED rather than unique.",
        default: false
      },
      {
        name: "session-id",
        type: "string",
        description:
          "The Claude Code session for every op that names none. A line's own `session_id` wins over this."
      },
      { name: "prompt-id", type: "string", description: "The prompt within that session." },
      { name: "turn-uuid", type: "string", description: "The turn within that session." }
    ],
    responseTypes: ["batch.applied"]
  },
  {
    name: "read",
    summary: "Read one memory: its metas, links, article, and format warnings.",
    args: [{ name: "path", description: "Repo-root-relative path to the memory.", required: true }],
    /**
     * The whole provenance triple, because the `read` arm stamps the whole triple.
     * `memory_session_links` carries `prompt_id` and `turn_uuid` beside `session_id`, so a command
     * that declared only the session would record a coarser link for a read than the write path
     * records for the same turn, and one triple could not be threaded through a write-then-read
     * flow. MCP's `memory_read` narrows to `session_id`; this surface is the one an agent threads a
     * triple through.
     */
    flags: [
      {
        name: "session-id",
        type: "string",
        description: "Records a `read` session link, so provenance is queryable both ways."
      },
      { name: "prompt-id", type: "string", description: "The prompt within that session." },
      { name: "turn-uuid", type: "string", description: "The turn within that session." }
    ],
    responseTypes: ["memory.detail"],
    examples: ["memhtml read areas/inbox/one-writer-and-many-readers-share-the-index.html --dense"]
  },
  {
    name: "search",
    summary: "Ranked search: four RRF arms plus MMR. Degrades to the lexical floor.",
    args: [
      {
        name: "query",
        description:
          "Prose. A double-quoted span demands those words in that order; nothing else is syntax.",
        required: true
      }
    ],
    flags: [
      ...SCOPE_FLAGS,
      { name: "limit", type: "int", description: "Hits to return.", default: 10 }
    ],
    responseTypes: ["memory.hits"],
    examples: [
      'memhtml search "why the VIP drain was reverted" --limit 5',
      "memhtml search rollback --type semantic --type procedural --tag infra",
      "memhtml search deploy --facet doc-type=runbook --include-archived --dense"
    ]
  },
  {
    name: "recall",
    summary: "A disclosure pack under a character budget: arcs and memories folded separately.",
    args: [
      {
        name: "query",
        description:
          "Prose. A double-quoted span demands those words in that order; nothing else is syntax.",
        required: true
      }
    ],
    flags: [
      ...SCOPE_FLAGS,
      {
        name: "budget",
        type: "int",
        description: "Characters of quoted body. Arcs get their own envelope on top.",
        default: 16_000
      }
    ],
    responseTypes: ["recall.pack"],
    examples: [
      'memhtml recall "what do we know about the checkout service" --budget 8000',
      "memhtml recall incident --workspace payments --as-of 2026-08-01T00:00:00Z"
    ]
  },
  {
    name: "correct",
    summary: "Supersede a memory: write the new file and archive the target in ONE commit.",
    args: [{ name: "target", description: "The memory being corrected.", required: true }],
    flags: [
      { name: "title", type: "string", description: "The new memory's title.", required: true },
      {
        name: "claim",
        type: "string",
        description: "The corrected claim. Exactly one of --claim or --article-html."
      },
      {
        name: "body",
        type: "string",
        description: "A prose paragraph. Repeatable.",
        repeatable: true
      },
      {
        name: "article-html",
        type: "string",
        description:
          "Raw <article> markup for the superseding memory, used verbatim in place of --claim/--body. Must contain exactly one <mark> in the first <p> or <li>; the first <time datetime> becomes the memory's event time. The store refuses format violations before any commit. Exactly one of --claim or --article-html."
      },
      {
        name: "type",
        type: "string",
        description:
          "The new memory's type. Defaults to the target's, so correcting an arc keeps it one.",
        values: MEMORY_TYPES
      },
      { name: "reason", type: "string", description: "Why the correction was made." },
      { name: "session-id", type: "string", description: "Records a `corrected` session link." },
      { name: "prompt-id", type: "string", description: "The prompt within that session." },
      { name: "turn-uuid", type: "string", description: "The turn within that session." }
    ],
    responseTypes: ["memory.corrected"]
  },
  {
    name: "link",
    summary: "Add an authored edge to the source file and commit it. Idempotent.",
    args: [
      { name: "src", description: "The asserting memory or task.", required: true },
      {
        name: "rel",
        // The task rels are authorable here rather than in `memory_link`, because a `blocks` edge
        // between two tasks is a real authored assertion, while a person or provenance rel is minted.
        description: `One of: ${AUTHORABLE_RELS.join(", ")}. A task rel needs two tasks; a memory rel refuses a task endpoint.`,
        required: true
      },
      { name: "dst", description: "The memory or task being pointed at.", required: true }
    ],
    flags: [],
    responseTypes: ["memory.linked"]
  },
  {
    name: "neighbors",
    summary: "The memory graph around one path, to a fixed depth of at most two hops.",
    args: [{ name: "path", description: "The center of the neighborhood.", required: true }],
    flags: [
      { name: "depth", type: "int", description: "1 or 2. Never more.", default: 1 },
      {
        name: "limit",
        type: "int",
        description:
          "Distinct nodes to return, clamped to 200. `nodesDropped` counts the paths the walk reached and this limit turned away, and `scanSaturated` says the walk stopped at its own 10000-row cap, which no limit recovers.",
        default: 200
      },
      {
        name: "rel",
        type: "string",
        description: "Restrict to these rels. Repeatable.",
        values: MEMORY_RELS,
        repeatable: true
      }
    ],
    responseTypes: ["memory.neighbors"]
  },
  {
    name: "resolve",
    summary: "Follow a possibly-moved path forward to the memory that carries the fact now.",
    args: [
      {
        name: "path",
        description: "The path a receipt, citation, or older answer recorded.",
        required: true
      }
    ],
    // No flags. The walk has nothing to tune: both mechanisms that move a memory are followed, the
    // hop bound is a property of the answer rather than a preference, and a caller who wants one hop
    // reads `steps`.
    flags: [],
    responseTypes: ["memory.resolved"]
  },
  {
    name: "archive",
    summary: "Soft-evict: `git mv` into archive/<YYYY>/ with the archive stamps. Never a delete.",
    args: [{ name: "path", description: "The memory to archive.", required: true }],
    flags: [{ name: "reason", type: "string", description: "Why it was evicted.", required: true }],
    responseTypes: ["memory.archived"]
  },
  {
    name: "reinforce",
    summary: "Bump access bookkeeping, gated by a 900-second per-path cooldown.",
    args: [
      {
        name: "path",
        description: "A memory path. Repeat the argument for more.",
        required: true,
        repeatable: true
      }
    ],
    flags: [
      {
        name: "signal",
        type: "string",
        description: "`neutral` bumps access without claiming the memory was right.",
        values: REINFORCE_SIGNALS,
        default: "neutral"
      }
    ],
    responseTypes: ["memory.reinforced"]
  },
  {
    name: "list",
    summary: "Page through the corpus by type, workspace, tag, entity, facet, or PARA bucket.",
    args: [],
    flags: [
      {
        name: "type",
        type: "string",
        description: "One memory type. `arc` pages the authored and synthesized arcs alike.",
        values: MEMORY_TYPES
      },
      { name: "workspace", type: "string", description: "One workspace." },
      { name: "tag", type: "string", description: "One tag." },
      { name: "entity", type: "string", description: "One `type:name` entity reference." },
      // Repeatable here where `--tag` and `--entity` are not, because the facet axis composes: the
      // whole point of an open vocabulary is asking for a conjunction of a consumer's own keys, and
      // one predicate per call would make that N calls the caller has to intersect by hand.
      { name: "facet", type: "string", description: FACET_FLAG, repeatable: true },
      {
        name: "para",
        type: "string",
        description: "One PARA bucket.",
        values: ["projects", "areas", "resources", "archive"]
      },
      { name: "limit", type: "int", description: "Rows per page.", default: 50 },
      {
        name: "cursor",
        type: "string",
        description: "The `next_cursor` from the previous page: the last path returned."
      },
      {
        name: "include-archived",
        type: "boolean",
        description: "Include archived memories.",
        default: false
      }
    ],
    responseTypes: ["memory.list"],
    examples: [
      "memhtml list --type episodic --limit 20",
      "memhtml list --facet doc-type=daily-journal --include-archived"
    ]
  },
  {
    name: "entity activity",
    summary: "Every entity with its file count and its last activity, newest first. Report only.",
    args: [],
    flags: [
      {
        name: "type",
        type: "string",
        description:
          "Restrict to one entity type, e.g. `service`. The half before the colon in a `type:name` reference."
      },
      {
        name: "limit",
        type: "int",
        description:
          "Rows to return, 1 to 500. An ask outside that is clamped into it rather than refused, and `limit` echoes the bound the answer was built under. `entityCount` is the total matching the scope, so a clamped answer is visible.",
        default: 50
      },
      {
        name: "include-archived",
        type: "boolean",
        description:
          "Aggregate archived memories too. Excluded by default: eviction is a `git mv`, so an archived memory still exists and would otherwise keep an entity looking active.",
        default: false
      }
    ],
    responseTypes: ["entity.activity"]
  },
  /**
   * The task family: CRUDL over the 10th memory type, without retrieval.
   *
   * Sugar over the same use cases everything else uses. `task add` is `writeMemory` with
   * `--type task`, and `task status` is one head meta plus (for `done`) the archive machinery. The
   * design intent is that an agent works tasks with `Read`, `Edit`, and `ls` as readily as with these.
   * A task is a file in a directory, and this family exists so the common moves are one call rather
   * than three.
   */
  {
    name: "task add",
    summary: "Open a task: a `task` memory in projects/<ws>/tasks/ or areas/inbox/tasks/.",
    args: [],
    flags: [
      {
        name: "title",
        type: "string",
        description: "What the task is. Becomes the <title> and the filename slug.",
        required: true
      },
      {
        name: "claim",
        type: "string",
        description: "The task statement, as the <mark> span. Defaults to --title."
      },
      {
        name: "body",
        type: "string",
        description: "A prose paragraph of working notes. Repeatable, one <p> each.",
        repeatable: true
      },
      {
        name: "status",
        type: "string",
        description: "The opening status. `todo` unless you are recording work already underway.",
        values: TASK_STATUSES,
        default: "todo"
      },
      {
        name: "due",
        type: "string",
        description: "An ISO date or datetime deadline. Compared as a string, so the form matters."
      },
      {
        name: "workspace",
        type: "string",
        description: "Routes the task to projects/<slug>/tasks/."
      },
      {
        name: "tag",
        type: "string",
        description: "A tag. Repeatable; tags scope search but never route a task.",
        repeatable: true
      },
      {
        name: "entity",
        type: "string",
        description: "A `type:name` entity reference. Repeatable.",
        repeatable: true
      },
      {
        name: "session-id",
        type: "string",
        description: "The Claude Code session that opened the task."
      },
      { name: "prompt-id", type: "string", description: "The prompt within that session." },
      { name: "turn-uuid", type: "string", description: "The turn within that session." }
    ],
    responseTypes: ["task.written"],
    examples: [
      'memhtml task add --title "Rotate the deploy key" --claim "The deploy key expires on the first." --due 2026-10-01'
    ]
  },
  {
    name: "task status",
    summary: "Move a task's status. `done` stamps AND archives it, in one commit.",
    args: [
      { name: "path", description: "The task file.", required: true },
      { name: "status", description: `One of: ${TASK_STATUSES.join(", ")}.`, required: true }
    ],
    flags: [
      {
        name: "reason",
        type: "string",
        description: "Why it closed. Recorded on the archive commit when the status is `done`."
      }
    ],
    responseTypes: ["task.updated"]
  },
  {
    name: "task list",
    summary: "The task working set: a direct indexed scan with blockers, never ranked retrieval.",
    args: [],
    flags: [
      {
        name: "status",
        type: "string",
        description: "One task status.",
        values: TASK_STATUSES
      },
      { name: "workspace", type: "string", description: "One workspace." },
      {
        name: "due-before",
        type: "string",
        description: "An ISO date. Returns tasks due strictly before it, by calendar day."
      },
      { name: "limit", type: "int", description: "Rows per page.", default: 50 },
      {
        name: "cursor",
        type: "string",
        description: "The `next_cursor` from the previous page: the last path returned."
      },
      {
        name: "include-archived",
        type: "boolean",
        description: "Include finished tasks. `done` archives, so they are otherwise absent.",
        default: false
      },
      {
        name: "detected",
        type: "boolean",
        description:
          "Only machine-detected tasks (a `det-<digest>-` filename), never ones opened by hand. " +
          "Each is a proposal carrying the evidence it was detected from.",
        default: false
      }
    ],
    responseTypes: ["task.list"]
  },
  {
    name: "index rebuild",
    summary:
      "Rebuild index.db from the git tree at HEAD, keeping every stored vector whose chunk survives. Destroys nothing outside .memhtml/.",
    args: [],
    flags: [
      {
        name: "embed",
        type: "boolean",
        description:
          "Fill missing vectors from Bedrock. --no-embed makes the rebuild instant and leaves new or changed chunks without a vector; the vectors already stored survive either way when the model is unchanged. With MEMHTML_EMBED=off, --embed is held to the same rules as --no-embed.",
        default: true
      },
      {
        name: "force",
        type: "boolean",
        description:
          "Run a rebuild that cannot write vectors (--no-embed, or --embed with MEMHTML_EMBED=off) over a store that already carries them. Without it that call is refused with ERR_REBUILD_NO_EMBED_REFUSED, because a store with vectors was embedded on purpose. Accepted and inert when the rebuild can embed.",
        default: false
      }
    ],
    responseTypes: ["index.report"],
    examples: [
      "memhtml index rebuild --no-embed",
      "memhtml index rebuild --no-embed --force",
      "memhtml index rebuild --repo /srv/memory"
    ]
  },
  {
    name: "index update",
    summary: "Index only what moved since the recorded watermark, plus the dirty working tree.",
    args: [],
    flags: [
      { name: "embed", type: "boolean", description: "Fill missing vectors.", default: true }
    ],
    responseTypes: ["index.report"]
  },
  {
    name: "index embed",
    summary:
      "Fill every chunk that has no vector in the configured space, without a rebuild. Safe to rerun; reports the gap it left.",
    args: [],
    flags: [
      {
        name: "dry-run",
        type: "boolean",
        description: "Report the gap (embeddingsRemaining) and write nothing.",
        default: false
      }
    ],
    responseTypes: ["index.report"],
    examples: ["memhtml index embed", "memhtml index embed --dry-run"]
  },
  {
    name: "index status",
    summary: "The index watermark, the vector space it was built in, and its row counts.",
    args: [],
    flags: [],
    responseTypes: ["index.report"]
  },
  {
    name: "trace index",
    summary: "Scan $MEMHTML_TRACE_ROOT for Claude Code transcripts, reading only what changed.",
    args: [],
    flags: [],
    responseTypes: ["trace.report"]
  },
  {
    name: "trace search",
    summary: "FTS over session first-prompts and AI titles. Never enters memory retrieval.",
    args: [
      {
        name: "query",
        description:
          "Prose. A double-quoted span demands those words in that order; nothing else is syntax.",
        required: true
      }
    ],
    flags: [
      { name: "cwd", type: "string", description: "Restrict to sessions from this directory." },
      { name: "since", type: "string", description: "ISO-8601 lower bound on started_at." },
      { name: "limit", type: "int", description: "Sessions to return.", default: 20 }
    ],
    responseTypes: ["trace.sessions"]
  },
  {
    name: "trace links",
    summary: "The memory-session links, from either side.",
    args: [],
    flags: [
      { name: "session-id", type: "string", description: "Every memory this session touched." },
      { name: "path", type: "string", description: "Every session that touched this memory." }
    ],
    responseTypes: ["trace.links"]
  },
  {
    name: "status",
    summary: "Corpus health: HEAD, dirty state, counts by type, edges, index freshness.",
    args: [],
    flags: [],
    responseTypes: ["status.health"]
  },
  {
    name: "publish",
    summary: "Regenerate the per-directory index.html listings and sitemap.xml, and commit them.",
    args: [],
    flags: [],
    responseTypes: ["publish.report"]
  },
  {
    name: "doctor",
    summary:
      "Corpus health: dangling hrefs, orphan state rows, inbox depth, vocabulary, staleness.",
    args: [],
    flags: [
      {
        name: "fix",
        type: "boolean",
        description:
          "Repair dangling hrefs and prune orphan access rows. The other findings need a decision.",
        default: false
      }
    ],
    responseTypes: ["doctor.report"]
  },
  {
    name: "eval discriminate",
    summary: "The refusable retrieval gate: every probe must outrank its own wrong-fact twins.",
    args: [],
    flags: [
      {
        name: "mode",
        type: "string",
        description:
          "`fake` is the deterministic embedder CI measures; `live` needs AWS_BEARER_TOKEN_BEDROCK and refuses loudly without it.",
        values: ["fake", "live"],
        default: "fake"
      },
      {
        name: "seed",
        type: "int",
        description: "The fixture corpus seed. A failing run is reproducible from this number."
      },
      {
        name: "now",
        type: "int",
        description:
          "The run instant the fixture corpus anchors its stamps behind, UTC milliseconds since the epoch. The other half of reproducing a failing run: the corpus is a function of (seed, now), and the recency arm ranks on those stamps. Defaults to the clock, and rides back in the report."
      },
      { name: "size", type: "int", description: "Base memories to generate.", default: 200 },
      {
        name: "probes",
        type: "int",
        description: "Probes to run. Design §5 wants ≥30.",
        default: 36
      },
      {
        name: "mrr-floor",
        type: "string",
        description: "Mean-reciprocal-rank floor. Lowering it is a deliberate, visible choice.",
        default: "0.85"
      }
    ],
    responseTypes: ["eval.discrimination"]
  },
  /**
   * Code-mode (ROADMAP item 7b): one script, one execution, one envelope.
   *
   * The flag surface answers three questions a script cannot answer for itself, and nothing else.
   *
   * **How does the script arrive?** Three doors, exactly one per call, enforced in `validate` so a
   * wrong combination is exit 2. `--file` for a script under version control, `--script` for the
   * inline one-liner an agent composes, and a bare `memhtml exec` (or `-`) for stdin, which is the same
   * three-door shape and the same `-` spelling `memhtml apply` already uses for its op stream, so an
   * agent that learned one learned both. `--script` rather than a positional argument, because the
   * positional slot on a two-word command is where a run-id or a path goes on every other command
   * here, and a multi-line program in that slot would read as one.
   *
   * **How long may it run?** `--timeout-ms`, bounded and defaulted, because the guest is a QuickJS
   * worker with no reaper of its own and an unbounded script holds the CLI process open. The
   * millisecond unit is in the flag name rather than left to a note, since `--timeout 30` is
   * ambiguous by a factor of a thousand.
   *
   * **Which tree does it see?** `--sha`, defaulting to `HEAD`. Never the live working tree, which is
   * a containment decision rather than a convenience. A mounted `$MEMHTML_ROOT` exposes `.memhtml/index.db`
   * to the guest, whose `sqlite3` reads it happily (probed 2026-08-09: a read-only mount is no barrier
   * to a reader). A gitignored file is absent from a detached worktree, so pinning a commit is what
   * keeps the ranked planes out of reach, and the read-only mount is the second layer rather than
   * the only one. A pin also makes the answer reproducible. `sha` rides back in the envelope, so a
   * rerun is exact.
   *
   * There is deliberately no flag for the guest's own opt-ins. `javascript` is on because `js-exec`
   * is the feature. `python` and `network` are off and unofferable, so no invocation can turn either
   * on. `apps/cli/src/exec.ts` carries the mechanism and the egress probe.
   */
  {
    name: "exec",
    summary:
      "Run a read-only traversal script over the corpus in a sandbox: multi-hop in ONE execution.",
    args: [],
    flags: [
      {
        name: "file",
        type: "string",
        description:
          "The script to run, as a path on the HOST. Omit it, pass `--file -`, or pass a positional `-` to read the script from stdin. Mutually exclusive with `--script`."
      },
      {
        name: "script",
        type: "string",
        description:
          "The script source, inline. Mutually exclusive with `--file` and with reading stdin."
      },
      {
        name: "timeout-ms",
        type: "int",
        description:
          "Wall-clock bound on the script. Exceeding it is `exitCode` 124 with `timedOut: true`, not an error envelope. Capped at 600000.",
        default: 30000
      },
      {
        name: "sha",
        type: "string",
        description:
          "The commit to mount, materialized as a detached worktree. Defaults to HEAD. Never the live working tree, whose gitignored .memhtml/index.db a worktree omits."
      }
    ],
    responseTypes: ["exec.report"]
  },
  {
    name: "state export",
    summary:
      "Write .memhtml/state/access.jsonl, the only durable copy of the state plane, and commit.",
    args: [],
    flags: [],
    responseTypes: ["state.export"]
  },
  {
    name: "state import",
    summary: "Replay the committed sidecar into state.db. Counters merge by max, never last-wins.",
    args: [],
    flags: [],
    responseTypes: ["state.import"]
  },
  {
    name: "agents-doc",
    summary: "Regenerate AGENTS.md from this command table. --check fails on drift.",
    args: [],
    flags: [
      {
        name: "check",
        type: "boolean",
        description: "Compare the committed doc to the regenerated one and fail on a difference.",
        default: false
      },
      { name: "out", type: "string", description: "Where to write. Defaults to ./AGENTS.md." }
    ],
    responseTypes: ["agents.doc"]
  },
  {
    name: "serve mcp",
    summary: "Run the `memhtml-mcp` stdio server: 15 tools and 2 resources over this same repo.",
    args: [],
    flags: [],
    responseTypes: ["serve.exit"]
  },
  {
    name: "integrations install",
    summary:
      "Wire a coding agent to this store: its MCP entry, its hooks, a fenced block in its instruction file, and a skill, recorded in a receipt so uninstall removes exactly what install wrote.",
    args: [
      {
        name: "host",
        description: `Which coding agent to wire: one of ${HOSTS.join(", ")}. Omitted: every host whose home directory exists is installed (Claude Code by \`~/.claude\`, Codex by \`~/.codex\`, Cursor by \`~/.cursor\`, OpenCode by \`~/.config/opencode\`).`,
        required: false
      }
    ],
    flags: [
      {
        name: "project",
        type: "string",
        description:
          "Install at repository scope instead of user scope: the path is resolved to its git root, and the host's PROJECT files are written (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`, root `AGENTS.md`/`CLAUDE.md`). `/` and `$HOME` are refused as a root."
      },
      {
        name: "hooks",
        type: "string",
        description:
          "Which hooks to install. `all` (default) adds session-start recall, per-prompt recall where the host can inject it, and transcript indexing before compaction where a transcript format exists; `session` adds session-start recall only; `none` writes the MCP entry, block, and skill and no hook.",
        values: ["all", "session", "none"],
        default: "all"
      },
      {
        name: "bare-command",
        type: "boolean",
        description:
          "Write bare `memhtml` / `memhtml-mcp` commands into the host config instead of the absolute path of this binary. Absolute is the default because GUI hosts do not inherit a shell PATH and a moved toolchain alias has orphaned a bare command before; choose bare when you manage PATH yourself.",
        default: false
      },
      {
        name: "force",
        type: "boolean",
        description:
          "Overwrite a managed file or entry that was modified since the last install. Without it a modification is refused with ERR_INTEGRATION_MODIFIED and nothing is written; with it the prior bytes are kept beside the file as a timestamped backup named in the report.",
        default: false
      },
      {
        name: "dry-run",
        type: "boolean",
        description:
          "Report every file and entry install WOULD write, with the rendered content, and write nothing.",
        default: false
      }
    ],
    responseTypes: ["integrations.report"],
    examples: [
      "memhtml integrations install",
      "memhtml integrations install claude",
      "memhtml integrations install codex --hooks session",
      "memhtml integrations install cursor --project .",
      "memhtml integrations install opencode --dry-run"
    ]
  },
  {
    name: "integrations uninstall",
    summary:
      "Remove exactly what install wrote for one host, matched against the receipt; a managed file that was modified since is refused.",
    args: [
      {
        name: "host",
        description: `Which coding agent to unwire: one of ${HOSTS.join(", ")}.`,
        required: true
      }
    ],
    flags: [
      {
        name: "project",
        type: "string",
        description: "Uninstall the repository-scope integration rooted at this path's git root."
      }
    ],
    responseTypes: ["integrations.report"],
    examples: [
      "memhtml integrations uninstall claude",
      "memhtml integrations uninstall cursor --project ."
    ]
  },
  {
    name: "integrations list",
    summary:
      "For every host: installed, modified, or not installed, at user scope and at the named project scope.",
    args: [],
    flags: [
      {
        name: "project",
        type: "string",
        description: "Also report the repository-scope integration rooted at this path's git root."
      }
    ],
    responseTypes: ["integrations.list"],
    examples: ["memhtml integrations list", "memhtml integrations list --project ."]
  },
  {
    name: "integrations doctor",
    summary:
      "Check a host's wiring end to end: binary path and version, store root, MCP entry, hooks, instruction block, skill, transcript root, and a live `initialize` handshake with the server the entry names.",
    args: [
      {
        name: "host",
        description: `Which coding agent to check: one of ${HOSTS.join(", ")}. Omitted: every host with a receipt.`,
        required: false
      }
    ],
    flags: [
      {
        name: "project",
        type: "string",
        description: "Check the repository-scope integration rooted at this path's git root."
      }
    ],
    responseTypes: ["integrations.doctor"],
    examples: ["memhtml integrations doctor", "memhtml integrations doctor claude"]
  },
  {
    name: "integrations shell",
    summary:
      "Print an eval-able shell snippet that exports MEMHTML_ROOT and puts this binary's directory on PATH; --write appends it to your rc file inside a fence.",
    args: [],
    flags: [
      {
        name: "write",
        type: "boolean",
        description:
          "Append the snippet to the rc file inside `# MEMHTML:START` / `# MEMHTML:END` markers, replacing a prior fenced block. Without it the snippet is only reported.",
        default: false
      },
      {
        name: "rc",
        type: "string",
        description:
          "The rc file to write. Defaults to `~/.zshrc` when $SHELL ends in zsh, else `~/.bashrc`."
      }
    ],
    responseTypes: ["integrations.shell"],
    examples: ["memhtml integrations shell", "memhtml integrations shell --write"]
  },
  {
    name: "hook",
    summary:
      "The engine every installed hook calls. Reads the host's hook payload on stdin, runs recall or transcript indexing under a hard time bound, and writes the HOST'S protocol to stdout (plain text or the host's JSON), never this envelope; any failure prints nothing and exits 0, so a hook can never block a turn.",
    args: [
      {
        name: "event",
        description: `Which lifecycle event fired: one of ${HOOK_EVENTS.join(", ")}.`,
        required: true
      }
    ],
    flags: [
      {
        name: "host",
        type: "string",
        description: "Which host's payload shape to read and which output dialect to write.",
        values: [...HOSTS],
        required: true
      },
      {
        name: "trace-root",
        type: "string",
        description:
          "Where this host writes transcripts, for the events that index them. Defaults to $MEMHTML_TRACE_ROOT."
      },
      {
        name: "limit",
        type: "int",
        description: "Hits to inject on a per-prompt recall.",
        default: 5
      },
      {
        name: "budget",
        type: "int",
        description: "Character budget for the session-start context pack.",
        default: 3000
      }
    ],
    responseTypes: ["hook.output"],
    examples: [
      "memhtml hook session-start --host claude",
      "memhtml hook user-prompt-submit --host codex --limit 3",
      "memhtml hook pre-compact --host claude --trace-root ~/.claude"
    ]
  },
  /**
   * The v2 proof of concept (`docs/v2-poc.md`): a session is a pointer to one corpus version plus an
   * overlay log of its own operations, and a commit is mechanical (validate, check disjointness
   * against the ref, mark frame-key contradictions, write a tree through the session's own git index,
   * compare-and-swap the ref). None of these commands opens `index.db`: the head is built from git or
   * from a columnar snapshot on every call, and `head status` says which.
   *
   * `--id` names the session everywhere because its state lives under `.memhtml/sessions/<id>`. The one
   * ambient session is `MEMHTML_SESSION`, which an agent runtime exports to every subprocess of a run:
   * with it set, `--id` defaults to its value, `session put` and `session exec` start that session on
   * first use, and the v1 doors that create a record refuse (`ERR_SESSION_BOUND`), so the run's writes
   * all meet the write bar and land in one commit. With neither, `--id` is a missing argument. A
   * commit that finds the ref moved over a path it touched
   * answers `rebase-needed` rather than retrying, so `session rebase` is its own command and the
   * caller owns the loop.
   */
  {
    name: "session start",
    summary:
      "Open a v2 session on the ref's tip: a pointer to that version plus an empty overlay log.",
    args: [],
    flags: [
      {
        name: "id",
        type: "string",
        description:
          "The session id: one path segment, letters, digits, `.`, `_`, `-`. State lives at .memhtml/sessions/<id>.idx (the session's git index) and <id>.json (its overlay log). Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."
      },
      {
        name: "ref",
        type: "string",
        description:
          "The ref commits land on. Defaults to refs/heads/main. A ref that does not exist yet (a curator's refs/heads/curate/<date>) starts from HEAD and is created by the first commit."
      },
      {
        name: "force",
        type: "boolean",
        description:
          "Discard an existing log under this id and start over. Without it, an id that already has a log is refused with ERR_STORAGE (session.exists) so a retried start cannot lose an overlay in progress; `session status --id <id>` reads the existing one.",
        default: false
      }
    ],
    responseTypes: ["session.started"],
    examples: [
      "memhtml session start --id s1",
      "memhtml session start --id curate-2026-09-23 --ref refs/heads/curate/2026-09-23",
      "memhtml session start --id s1 --force"
    ]
  },
  {
    name: "session put",
    summary:
      "Append write ops, and label or unlabel ops on existing records, to a session's overlay from a JSONL file.",
    args: [],
    flags: [
      {
        name: "id",
        type: "string",
        description:
          "The session to append to. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT. With the id taken from $MEMHTML_SESSION and no log yet, the session is started on refs/heads/main's tip first (a `rev-parse` and a `read-tree`, no head load), so a run's first write needs no `session start`; a `--id` given on the line must name a started session."
      },
      {
        name: "file",
        type: "string",
        description:
          'JSONL, one object per line. A `write` line takes the same fields `memhtml apply` accepts; each is rendered to the file the store would write and lands at the path the store would choose. A `label` line, `{"op":"label","path":"areas/inbox/x.html","entity":"system:memhtml"}`, adds one `memhtml-entity` to an existing record\'s head, and an `unlabel` line with the same fields removes one; neither touches the article, so the record keeps its content hash. A label value is a lowercase `type:name` (`service:memhtml`, `project:hex-bonk`, `person:laith`) the record does not carry yet; an unlabel names a value the record carries, exactly as written. `-` reads stdin. A malformed op, a reserved path, a label that is malformed or already carried, an unlabel of a value the record lacks, an unlabel that leaves a record with no entity outside `projects/<slug>/`, or a record below the write bar refuses the whole call and appends nothing. The bar: a memory names the system, project, or person it is about (an `entities` value, or a `workspace`), carries a mechanism or a decision, and is something a future run would look up; a run narrative (`episodic`) or review output (`verdict`) is refused, because runs live in the trace index. The bar holds for every writer and every type, the curator and tasks included: a task names an entity unless its `workspace` anchors it. The response lists each put\'s nearest existing records under `neighbors`, so a near-duplicate can be skipped and the related records linked before the commit. `neighbors` is ranked the way `head search` ranks, the vector arm included when the store has a vector cache (`memhtml head embed`) and an embedder is configured: each put\'s own text is embedded as a document, one call per batch. When the arm cannot run the neighbors come from the lexical arm alone and `vector` says why (`used: false` with a `reason`); the put itself never fails for it.',
        required: true
      },
      {
        name: "server",
        type: "boolean",
        description:
          "Ask the head server on .memhtml/head.sock first (`memhtml head serve`), falling back to loading the head here when no server accepts within 100 ms or answers within 10 s; `--no-server` always loads here. The placements, violations, and neighbors (label lines included, the vector arm run with the server's cache and embedder) are then computed by the server over the version at the session's base; the append always happens here. The payload's `head.source` is `server` when the server answered.",
        default: true
      }
    ],
    responseTypes: ["session.appended"],
    examples: [
      "memhtml session put --id s1 --file ops.jsonl",
      "memhtml session put --id s1 --file ops.jsonl --no-server"
    ]
  },
  {
    name: "session exec",
    summary:
      "Run a script over the session's view (head plus overlay) in a writable sandbox and harvest its writes into the overlay.",
    args: [],
    flags: [
      {
        name: "id",
        type: "string",
        description:
          "The session whose view the script sees. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT. With the id taken from $MEMHTML_SESSION and no log yet, the session is started on refs/heads/main's tip first, as `session put` does."
      },
      {
        name: "file",
        type: "string",
        description:
          'The script, as a path on the HOST. Omit it, pass `--file -`, or a positional `-` to read stdin, which is the usual door: a heredoc (`memhtml session exec --id s1 <<\'SH\'` ... `SH`) delivers the script with no quoting to get wrong. Mutually exclusive with `--script`. A new file the script writes is held to the write bar `session put` states; one below it blocks the whole harvest. An existing file whose article is unchanged may gain or lose `<link rel="memhtml-...">` lines and `<meta name="memhtml-entity">` lines in its head: each becomes a `link`, `unlink`, `label`, or `unlabel` op, and any other head edit is rejected with a reason.'
      },
      {
        name: "script",
        type: "string",
        description: "The script source, inline. Mutually exclusive with `--file` and with stdin."
      },
      {
        name: "lang",
        type: "string",
        description:
          "The script's language, echoed as `lang` in the report. `bash` runs it as a shell program: `cat`, `grep -r`, `sed -i`, `find` (with `-exec`), `xargs`, `jq`, `awk`, pipes, redirection, and nested heredocs all work on the corpus at `/mnt/memhtml`, so `cat > /mnt/memhtml/projects/<slug>/<name>.html <<'HTML'` ... `HTML` writes a record and a `sed -i` that splices a `<meta name=\"memhtml-entity\">` line into a head labels one. Use absolute paths. `js-exec <file>` runs a JavaScript module from inside a bash script. `js` runs the whole script as a JavaScript module through `js-exec` with `/workspace/lib/corpus.mjs` preloaded, as `memhtml exec` does. The mount, the timeout, and the harvest are the same for both. There is no network in either: `curl` is not a command.",
        values: EXEC_LANGS,
        default: DEFAULT_EXEC_LANG
      },
      {
        name: "timeout-ms",
        type: "int",
        description:
          "Wall-clock bound on the script. Exceeding it is `exitCode` 124 with `timedOut: true`, for a bash loop and a `js-exec` module alike. Other sandbox bounds end a runaway sooner with exit 126 and the bound named on stderr: call depth 100, and 100,000 iterations inside one `awk`, `sed`, or `jq`. Capped at 600000. Under the head server a run still going 5 s past the bound (a single command the shell cannot interrupt) has its worker stopped, and it reports exit 124 with nothing harvested.",
        default: 30000
      },
      {
        name: "server",
        type: "boolean",
        description:
          "Ask the head server on .memhtml/head.sock to run the script (`memhtml head serve`); `--no-server` always runs it here. The server reads the session's log, takes the version at the session's base when that is its ref's tip or an ancestor of it, runs the script in a worker, harvests, validates, and appends exactly as a local run does, one exec per session at a time; the payload's `head.source` is `server` and `server.base` says `tip` or `ancestor`. The script runs here instead when no server accepts within 100 ms, when the server answers anything but 200, or when it declines (`server.reason` `base-unservable` or `busy`); `server.reason` names why (`disabled` under `--no-server`, `no-server`, `refused`). When the server took the script and its answer was lost, the call fails with ERR_STORAGE rather than run it twice. Either way the request body (the script as JSON) is capped at 1,048,576 bytes: a larger script is ERR_INVALID_FLAG at exit 2 before anything runs.",
        default: true
      }
    ],
    responseTypes: ["session.exec.report"],
    examples: [
      "memhtml session exec --id s1 <<'SH'\ngrep -rl 'memhtml-entity\" content=\"system:memhtml' /mnt/memhtml/projects | wc -l\nSH",
      "memhtml session exec --id s1 --lang js --file curate.mjs",
      "memhtml session exec --id s1 --script 'grep -c memhtml /mnt/memhtml/projects/memhtml/*.html' --timeout-ms 5000",
      "memhtml session exec --id s1 --no-server <<'SH'\ngrep -c memhtml /mnt/memhtml/areas/inbox/*.html\nSH"
    ]
  },
  {
    name: "session commit",
    summary:
      "Land the session's overlay on its ref as one commit, or report why it cannot: `refused`, `rebase-needed`, or `worktree-dirty`.",
    args: [],
    flags: [
      {
        name: "id",
        type: "string",
        description:
          "The session to commit. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."
      },
      {
        name: "message",
        type: "string",
        description:
          "The commit summary. Rendered as `memhtml(session): <summary>` with a Memhtml-Session trailer. When HEAD is the session's ref, the shared index and working tree move to the new commit with it (`worktreeSynced: true`); uncommitted state at a path the commit writes or removes is answered `worktree-dirty` and nothing moves. A ref that moved past the session's base is `rebase-needed`: run `session rebase` and commit again. A `committed` outcome also writes the new commit's snapshot (`snapshot`: path, bytes, ms, pruned; null when that best-effort write failed), so the next load hits the cache.",
        required: true
      }
    ],
    responseTypes: ["session.committed"],
    examples: [
      "memhtml session commit --id s1 --message 'three facts about the checkout api'",
      "memhtml session commit --id curate-2026-09-23 --message 'curated'"
    ]
  },
  {
    name: "session rebase",
    summary:
      "Move a session's base to its ref's tip, keeping every op. Run it after a `rebase-needed` commit outcome, then commit again.",
    args: [],
    flags: [
      {
        name: "id",
        type: "string",
        description:
          "The session to rebase. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."
      }
    ],
    responseTypes: ["session.rebased"],
    examples: ["memhtml session rebase --id s1"]
  },
  {
    name: "session status",
    summary:
      "The session's base, ref, and overlay log as persisted, and whether the ref has moved past the base.",
    args: [],
    flags: [
      {
        name: "id",
        type: "string",
        description:
          "The session to describe. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."
      }
    ],
    responseTypes: ["session.status"],
    examples: ["memhtml session status --id s1"]
  },
  {
    name: "head status",
    summary:
      "Report the corpus version and where it came from: the head server's (`source: server`, with the server's ref, load, advances, and uptime under `server`) when one answers on .memhtml/head.sock, else the version at HEAD built here, with its sha, record count, skipped files, load time, and source: `snapshot` (HEAD's own .arrow file), `snapshot+advance` (an ancestor's snapshot advanced over the changed paths, with `ancestorSha` and `reparsed`), or `git`.",
    args: [],
    flags: [
      {
        name: "server",
        type: "boolean",
        description:
          "Ask the head server on .memhtml/head.sock first (`memhtml head serve`), falling back to loading the head here when no server accepts within 100 ms or answers within 10 s; `--no-server` always loads here. The payload's `head.source` is `server` when the server answered.",
        default: true
      }
    ],
    responseTypes: ["head.status"],
    examples: ["memhtml head status", "memhtml head status --no-server"]
  },
  {
    name: "head search",
    summary: `Retrieval over the version at HEAD, or over the head server's version of its ref when one answers, RRF-fused: BM25, plus a vector arm (cosine over Cohere Embed v4 vectors, weight 1.0 as in v1's search) when \`.memhtml/vectors/\` holds a cache for the configured embedder and \`MEMHTML_EMBED\` is not \`off\`. Recency is the tie-break: only hits with exactly equal fused scores are ordered newest first, so it never lifts a weaker match over a better one. The query is embedded once with the query input type. The query embed has a deadline, \`MEMHTML_EMBED_DEADLINE_MS\` (${String(EMBED_DEADLINE_DEFAULT_MS)} ms by default): past it the search answers without the arm rather than wait. When the arm cannot run (embedder off, no cache yet, an unreadable cache, the query embed failed or passed its deadline) the search answers from BM25 alone and \`vector\` reports \`used: false\` with a \`reason\`; it never fails for it. Each hit's \`arms\` names the arms it scored on, and \`recency\` when an exact tie was broken by it. No index database.`,
    args: [{ name: "query", description: "Free text to rank against.", required: true }],
    flags: [
      { name: "limit", type: "int", description: "Hits to return.", default: 10 },
      {
        name: "server",
        type: "boolean",
        description:
          "Ask the head server on .memhtml/head.sock first (`memhtml head serve`), falling back to loading the head here when no server accepts within 100 ms or answers within 10 s; `--no-server` always loads here. The payload's `head.source` is `server` when the server answered.",
        default: true
      }
    ],
    responseTypes: ["head.search"],
    examples: [
      "memhtml head search 'vip drain' --limit 5",
      "memhtml head search 'vip drain' --no-server"
    ]
  },
  /**
   * The head server (`docs/v2-poc.md`, "Head server"). Long-running: it writes its one envelope
   * when SIGTERM or SIGINT stops it, and logs to stderr while it serves.
   */
  {
    name: "head serve",
    summary: `Hold the head loaded and answer lookups over .memhtml/head.sock (mode 0600, JSON over HTTP, routes /v1/status, /v1/search, /v1/read, /v1/neighbors, /v1/exec) until SIGTERM or SIGINT. The server loads its ref's tip once the cheapest way (snapshot, snapshot+advance, or git), reads the ref before every answer and advances over the changed paths when it moved, so an answer is never older than the ref at the moment of the request, and polls between requests. With an embedder bound (not \`MEMHTML_EMBED=off\`) it also holds the vector cache \`head embed\` writes, reads it again when the file's mtime changes, and runs the vector arm for \`/v1/search\` and \`/v1/neighbors\` the way \`head search\` and \`session put\` do locally, answering with the same \`vector\` field. A \`/v1/search\` waits for its query embed at most the body's \`embedDeadlineMs\`, else \`MEMHTML_EMBED_DEADLINE_MS\`, else ${String(EMBED_DEADLINE_DEFAULT_MS)} ms, and answers \`embed-timeout\` without the arm past it, leaving at most one late embed to finish in the background; and when no embed has ended for \`MEMHTML_EMBED_WARM_IDLE_MS\` and none is in flight it issues one one-token embed, so the first search after a quiet stretch is warm (\`status\` reports both under \`embed\`). An advance that brings records the cache has no vector for embeds them in the background, a bounded batch at a time, and writes them to the cache file as \`head embed\` would (\`status\` reports \`vectors.pending\` and \`vectors.backfill\`). \`head status\`, \`head search\`, \`session put\`, and \`session exec\` ask it first, and \`/v1/exec\` runs the script in a pool of worker threads (four at once, one per session id at a time) so a runaway script never stalls a lookup; \`session commit\` and the curate commands always load locally, because they judge the exact version they commit against. A live server on the socket refuses a second one (ERR_HEAD_SERVER_RUNNING); a socket left by a killed server is replaced. The socket is removed on exit, and the envelope reports the ref, final sha, advances, requests, and uptime.`,
    args: [],
    flags: [
      {
        name: "ref",
        type: "string",
        description:
          "The ref to follow, as a branch name or a full ref; `refs/heads/` is prepended when absent. Default: the branch HEAD points at, else `main`."
      },
      {
        name: "poll-ms",
        type: "int",
        description:
          "How often the server reads the ref between requests, in milliseconds; 0 leaves advancing to requests alone. Every request reads the ref regardless.",
        default: 1000
      }
    ],
    responseTypes: ["head.served"],
    examples: ["memhtml head serve", "memhtml head serve --ref main --poll-ms 500"]
  },
  {
    name: "head embed",
    summary:
      "Fill the vector cache for the version at HEAD: embed every active record whose article text has no vector yet (keyed by content hash, so an unchanged record is never embedded twice, across every version) and write `.memhtml/vectors/<model>@<dimension>.arrow`, a rebuildable cache git ignores. Reports records, reused, embedded, the cache file's bytes, and the time spent. Needs an embedder: with `MEMHTML_EMBED=off` it fails with ERR_MODEL_UNAVAILABLE. Run it after commits land to keep `head search`'s vector arm covering new records; `vector.coverage` on a search says how much of the head it covers.",
    args: [],
    flags: [],
    responseTypes: ["head.embedded"],
    examples: ["memhtml head embed"]
  },
  {
    name: "head snapshot",
    summary:
      "Write the version at HEAD as .memhtml/snapshots/<sha>.arrow, the cold-start cache, pruning to the newest four, or read that file back and report it. Every ref-moving commit writes this file itself; the command is for a store whose HEAD moved by other means.",
    args: [],
    flags: [
      {
        name: "write",
        type: "boolean",
        description:
          "Build the head from git and write its snapshot. Exactly one of --write / --read.",
        default: false
      },
      {
        name: "read",
        type: "boolean",
        description:
          "Open HEAD's snapshot and report its row count and sha. Exactly one of --write / --read.",
        default: false
      }
    ],
    responseTypes: ["head.snapshot"],
    examples: ["memhtml head snapshot --write", "memhtml head snapshot --read"]
  },
  /**
   * The curation door (`docs/v2-poc.md`, "Curation door"). A curator is a session on a
   * `curate/<date>` branch, and this is the one command that moves `main` to what it committed. It
   * never merges: the branch must already be a descendant of the target, so the landing is a
   * fast-forward, and the compare-and-swap on the target ref means a writer that advanced it in
   * between makes the call refuse rather than overwrite.
   */
  {
    name: "curate merge",
    summary:
      "Land a curator branch on its target: fast-forward --into to the ref when the ref descends from it, else replay the ref's operations (its puts, archives, and links since the merge base) as one fresh commit on --into's tip; the head gate (the same probes ranked at both tips) runs first either way, the checkout comes along when --into is HEAD, the landed version's snapshot is written, and after a replay the curator ref is moved to the landed commit.",
    args: [
      {
        name: "ref",
        description:
          "The curator branch, as `curate/2026-09-23` or `refs/heads/curate/2026-09-23`; `refs/heads/` is prepended when absent. Refused (ERR_INVALID_MEMORY) when it does not exist. When --into has moved past the branch's base, the landing is a replay: the branch's changes since the merge base are read back as session operations and committed onto --into under the curate scope, `memhtml(curate): <subject> (replayed onto <sha>)`, and the payload's `replayed` names the base, the op counts, the attempts, and the branch's original tip (`null` on a fast-forward). Refused (ERR_INVALID_MEMORY, nothing moved) when the branch carries a change that is not an operation (an article edited in place, a file deleted with no archive twin, a link removed, a meta changed), named by path, or when the ops collide with what --into gained meanwhile (`duplicate`, `claim-edit`, a link whose target is gone).",
        required: true
      }
    ],
    flags: [
      {
        name: "into",
        type: "string",
        description:
          "The branch to fast-forward, `refs/heads/` prepended when absent. When HEAD is this branch and the checkout is clean at every path the landing changes, the shared index and working tree move with it (`worktreeSynced: true`); an uncommitted edit at one of those paths is refused (ERR_DIRTY_TREE) and nothing moves.",
        default: "main"
      },
      {
        name: "skip-gate",
        type: "boolean",
        description:
          "Land without running the head gate. A deliberate, logged override, never a default. The gate loads the version at --into and the version at the ref, probes a seeded sample of the records active in both by their titles, and refuses (ERR_DISCRIMINATION_FAILED, nothing moves) when the landed version's MRR falls more than the tolerance below the base's or its inversions grow; the payload's `gate` carries mode `head`, probes, mrr, mrrBefore, floor, and inversions.",
        default: false
      }
    ],
    responseTypes: ["curate.merged"],
    examples: [
      "memhtml curate merge curate/2026-09-23",
      "memhtml curate merge refs/heads/curate/2026-09-23 --into main",
      "memhtml curate merge curate/2026-09-23 --skip-gate"
    ]
  },
  /**
   * The curator memhtml itself owns (`docs/v2-poc.md`, "Curator"): a bounded, model-driven tool
   * loop over a curator session on `curate/<date>`, committed to that branch and never to `main`.
   * `curate merge` is the door back, so a curation pass is these two commands in order.
   */
  {
    name: "curate run",
    summary:
      "Run the curator: start (or resume) a session on curate/<date>, brief a model on the corpus, let it search, read, exec, and propose within a budget, then commit the session to the branch as `memhtml(curate): <report line>`.",
    args: [],
    flags: [
      {
        name: "ref",
        type: "string",
        description:
          "The curator branch, `refs/heads/` prepended when absent. Defaults to curate/<UTC date>. Must sit under curate/: `main`, `refs/heads/main`, any other branch, or a tag is ERR_INVALID_FLAG at exit 2, and the branch HEAD points at is ERR_INVALID_MEMORY at exit 1, so a run can never land on the system of record or move the checkout. The session id is the ref with slashes as dashes (curate-2026-09-23)."
      },
      {
        name: "model",
        type: "string",
        description:
          "The model: `fake` (a scripted, credential-free curator that plays the dedup rule), `bedrock:<modelId>` (the default AWS credential chain, region from AWS_REGION), or `proxy:<model>` (an OpenAI-compatible proxy at MEMHTML_LLM_BASE_URL, named with the MEMHTML_LLM_MODEL_PREFIX convention). Defaults to MEMHTML_CURATOR_MODEL, else `proxy:<default model>` when MEMHTML_LLM_BASE_URL is set; otherwise the flag is required."
      },
      {
        name: "max-steps",
        type: "int",
        description: "Model calls the run may make before it is stopped (`stoppedBy: maxSteps`).",
        default: 40
      },
      {
        name: "wall-clock-ms",
        type: "int",
        description:
          "Wall clock for the whole run, model calls and tool executions together (`stoppedBy: wallClock`).",
        default: 1200000
      },
      {
        name: "dry-run",
        type: "boolean",
        description:
          "Run the loop over an in-memory overlay: no session is written, nothing is appended, nothing is committed, and the ref stays where it was. With --resume, the overlay starts from the session's logged ops and the log is left as it was. The payload reports what would have been proposed.",
        default: false
      },
      {
        name: "resume",
        type: "boolean",
        description:
          "Reuse the existing session on the ref instead of refusing with ERR_STORAGE (session.exists). The head is loaded at the session's own base. A missing session is ERR_STORAGE at exit 1.",
        default: false
      }
    ],
    responseTypes: ["curate.run"],
    examples: [
      "memhtml curate run --model fake",
      "memhtml curate run --model bedrock:global.anthropic.claude-opus-5 --max-steps 60",
      "memhtml curate run --ref curate/2026-09-23 --model proxy:global.anthropic.claude-opus-5 --resume",
      "memhtml curate run --model fake --dry-run"
    ]
  },
  /**
   * The collapse (`docs/v2-poc.md`, "Collapse"): a planner cuts the corpus into archive, fold, and
   * keep clusters with no model call, then archive clusters land through validated sessions and each
   * fold runs one bounded curator session, all on one `curate/` branch. `curate merge` is the door
   * back, as for `curate run`.
   */
  {
    name: "curate collapse",
    summary:
      "Plan and run a collapse of the corpus on a curate/ branch: cut the head into archive, fold, and keep clusters by source and type, frame key, and lexical similarity (rulings first when given), archive the archive clusters with no model, fold each fold cluster into one canonical through a curator session with the driver completing every archive and supersedes link, and leave keep clusters alone.",
    args: [],
    flags: [
      {
        name: "ref",
        type: "string",
        description:
          "The curator branch, `refs/heads/` prepended when absent. Defaults to curate/<UTC date>-collapse. Must sit under curate/ (ERR_INVALID_FLAG at exit 2 otherwise), and the branch HEAD points at is ERR_INVALID_MEMORY at exit 1. Every cluster lands on this one ref through the rebase-and-retry loop, so concurrent folds serialize at it. Sessions are named collapse-<cluster id>."
      },
      {
        name: "model",
        type: "string",
        description:
          "The model each fold runs under: `fake`, `bedrock:<modelId>`, or `proxy:<model>`, resolved as `curate run` resolves it (MEMHTML_CURATOR_MODEL, else `proxy:<default>` when MEMHTML_LLM_BASE_URL is set). Archive clusters use no model."
      },
      {
        name: "plan",
        type: "string",
        description:
          "A saved plan (the `plan` field of a --dry-run payload) to execute in place of computing one. Members are re-checked against the ref's tip per cluster, and `planShaMismatch` says when the plan named another sha."
      },
      {
        name: "rulings",
        type: "string",
        description:
          "A JSONL file of audit rulings, one `{path, verdict, theme?, reason?}` per line with verdict one of keep, fold, trace, archive. Archive and trace rulings become archive clusters, fold rulings group by theme, keep rulings take a record out of every cut, and each is quoted in its cluster's briefing."
      },
      {
        name: "concurrency",
        type: "int",
        description:
          "Fold sessions run at once; each lands on the one ref through the rebase-and-retry loop.",
        default: 4
      },
      {
        name: "only",
        type: "string",
        description:
          "Comma-separated cluster ids to execute; every other cluster is reported under `untouched` and left alone. ERR_INVALID_MEMORY when none names an archive or fold cluster."
      },
      {
        name: "limit",
        type: "int",
        description: "Execute only the first N archive or fold clusters in plan order."
      },
      {
        name: "dry-run",
        type: "boolean",
        description:
          "Compute the plan and print it whole under `plan`, with every executable cluster previewed as `dry-run`; no session, no ref, and no commit is written.",
        default: false
      },
      {
        name: "max-steps",
        type: "int",
        description: "Model calls one fold may make before it is stopped.",
        default: 14
      },
      {
        name: "wall-clock-ms",
        type: "int",
        description: "Wall clock for one fold, model calls and tool executions together.",
        default: 900000
      }
    ],
    responseTypes: ["curate.collapse"],
    examples: [
      "memhtml curate collapse --model fake --dry-run",
      "memhtml curate collapse --model fake --rulings audit/verdicts.jsonl --dry-run",
      "memhtml curate collapse --model bedrock:global.anthropic.claude-opus-5 --rulings audit/verdicts.jsonl --concurrency 6",
      "memhtml curate collapse --model fake --plan plan.json --only theme-loop-guard,archive-none-episodic",
      "memhtml curate collapse --model fake --limit 3"
    ]
  }
]

export const COMMAND_NAMES = COMMANDS.map((command) => command.name)

/** One prose block of the manifest's guide: a topic key an agent can cite, and the prose. */
export interface GuideBlock {
  readonly topic: string
  readonly body: string
}

/**
 * The example op line, quoted verbatim into the `when-to-batch` block.
 *
 * A constant rather than a literal inside the prose, because a test parses it. An example an agent
 * copies has to be valid JSONL, and it stays valid because the doc and the parser read the
 * same bytes. A prose-only example drifts silently the first time a field is renamed.
 */
export const GUIDE_OP_EXAMPLE =
  '{"op":"write","title":"One writer and many readers share the index","type":"semantic","body":"WAL admits a single writer at a time and any number of concurrent readers, so a CLI command and a running `memhtml serve mcp` can work against one store.","tag":"infra"}'

/**
 * The guide: what an agent reads on its first call, before it has written anything.
 *
 * Prose, in a structured field, authored here beside `COMMANDS`, which is the design (spec
 * D8/G6). The manifest carries it on a bare `memhtml`, `memhtml manifest`, and a piped `memhtml help`, and
 * `memhtml agents-doc` renders these same strings into `AGENTS.md`, so the doc and the live answer cannot
 * disagree. Prose kept in a separate Markdown file would be a second copy that drifts, and prose kept
 * only in `AGENTS.md` would be invisible to an agent that never opens the repo.
 *
 * Written for an LLM agent mid-task rather than for an operator browsing: complete sentences, action
 * first, and every claim true of this build rather than of the design. A guide that describes an
 * intention is worse than no guide, because an agent acts on it.
 */
export const GUIDE: ReadonlyArray<GuideBlock> = [
  {
    topic: "first-call",
    body:
      "You are reading this CLI's manifest: every command, argument, flag, response type, error code, " +
      "and environment variable the binary accepts. A bare `memhtml` and `memhtml manifest` return it, and " +
      "so do `memhtml help` and `memhtml --help` when stdout is a pipe; all of them answer on a machine with " +
      "no repo, no database, and no credentials, so this is also the liveness check when something else has " +
      "failed. For one command, `memhtml help <command>` or `memhtml <command> --help` returns that command's " +
      "entry as a `cli.help` envelope with a usage line and examples (Markdown instead when stdout is a " +
      "terminal; add `--json` to force the envelope). " +
      "Every command writes exactly ONE JSON envelope to stdout and nothing else, with one exception: help " +
      "on a terminal writes Markdown, and piped or with `--json` it is an envelope like every other command. " +
      "Logs go to stderr. " +
      "A success is `{apiVersion, type, data}` and a failure is `{apiVersion, error, code, suggestions}`. " +
      "Branch on `code`, never on the `error` prose: the codes and response types are append-only and a " +
      "shipped one never changes meaning, while the prose changes freely as wording improves. " +
      "Exit 0 is success, exit 2 is a usage error you fix by changing the call, exit 1 is a runtime " +
      "failure you fix by changing the repo or the environment. Add `--dense` to any command to get " +
      "minified JSON with null fields dropped, which is what you want when the output goes into a prompt."
  },
  {
    topic: "write-surfaces",
    body:
      "There are three ways to put a memory into the corpus, and they are all legitimate. " +
      "First, this CLI: `memhtml write` for one memory, `memhtml apply` for many. " +
      "Second, the MCP server: `memhtml serve mcp` speaks stdio with the same tools and resources over this " +
      "same repo, and it is the door to use when you are already an MCP client. " +
      "Third, editing files under $MEMHTML_ROOT directly with your normal file tools: the git tree IS the " +
      "system of record and `.memhtml/index.db` is only a projection of it, so a hand-written or hand-edited " +
      "memory file is as real as one this CLI wrote. `memhtml index update` projects uncommitted working-tree " +
      "changes as well as committed ones, so a dirty edit is searchable before you commit it. " +
      "What you take on by editing directly is everything the write path would have done for you: the " +
      "file must satisfy the format (run `memhtml doctor`, and `memhtml read <path>` reports per-file format " +
      "warnings), you own choosing a path that does not collide, you own noticing that the content " +
      "already exists somewhere else, and you own the commit. " +
      "A CLI command and a running `memhtml serve mcp` may share one store: the index is WAL SQLite, " +
      "which admits one writer at a time and any number of concurrent readers, so a second writer " +
      "waits its turn rather than failing. The one thing to keep clear of is a checked-out " +
      "`curate/<date>` branch: a write landing while one is checked out commits onto that branch and " +
      "is merged as if it were curation or lost when the branch is dropped. " +
      "Under `MEMHTML_SESSION` (an agent runtime exports it to every subprocess of a run) the first door " +
      "is the session one instead: `write`, `apply`, `correct`, and `task add` answer ERR_SESSION_BOUND, " +
      "and a record goes in through `memhtml session exec` (a heredoc that writes the file under " +
      "`/mnt/memhtml`) or `memhtml session put`, both held to the write bar, and the runtime commits the " +
      "run's session when the run ends."
  },
  {
    topic: "when-to-batch",
    body:
      "Writing more than about three memories in one task? Call `memhtml apply` once with a JSONL op stream " +
      "instead of running `memhtml write` N times. A batch stages every file, makes ONE commit, and " +
      "reindexes ONCE, where N separate writes make N commits and pay N index passes over N diffs. " +
      "Pass the stream as `memhtml apply --file ops.jsonl`, or pipe it: `memhtml apply -` and a bare `memhtml apply` " +
      "both read stdin. One complete JSON object per line, no wrapping array, no pretty-printing. A " +
      "line looks like this:\n" +
      `${GUIDE_OP_EXAMPLE}\n` +
      "`op` is `write` (the only verb in the vocabulary today), `title` and `type` are required, and each " +
      "op carries the same optional fields `memhtml write` takes, in snake_case: `path`, `strict_path`, " +
      "`workspace`, `tag`, `entity`, `importance`, `confidence`, `status`, `due`, `session_id`, " +
      "`prompt_id`, `turn_uuid`. " +
      "The whole file is validated for shape before ANY op executes, so a malformed line 7 is exit 2 " +
      "naming line 7 with nothing written. A failed apply costs you nothing but the call. " +
      "You get one result per op in INPUT ORDER, each naming its own `index`, so you can match results " +
      "back to the lines you sent. " +
      "A batch is ATOMIC by default: the first refused op aborts the whole batch, no file is written, no " +
      "commit is made, and the surviving ops report `skipped: true`. Pass `--continue-on-error` for " +
      "best-effort instead, and a refused op comes back as one failed result carrying its own `code` and " +
      "`error` while every op that succeeded lands in the one commit. " +
      "A duplicate is never an error: an op whose exact content is already stored comes back `ok: true` " +
      "with `deduped: true` and the existing path, so re-applying a file you already applied is safe and " +
      "writes nothing. `commit_sha` is null exactly when nothing was committed: a batch that only " +
      "deduped, or one that aborted."
  },
  {
    topic: "conflicts",
    body:
      "Pass `--detect-conflicts` to `memhtml apply` and each result gains a `conflict` field naming what " +
      "that op's claim contradicts. Dedupe catches an op whose content is IDENTICAL to something stored; " +
      "this catches an op that says something DIFFERENT about the same thing, the case dedupe is blind " +
      "to and the one that actually rots a corpus. " +
      "The match is grammatical, not semantic: a claim is split into a frame (the subject and relation, " +
      "up to its last `of`/`is`/`in`/`to`/`by`/`as`) and a value, and two claims conflict when they share " +
      "a frame. `The pool ceiling is 64` and `The pool ceiling is 128` share `the pool ceiling is`. " +
      "`conflict.path` names an ACTIVE memory already holding that slot; `conflict.batch_index` names an " +
      "EARLIER op in this same call, which is the case nothing else can see because neither op is stored " +
      "yet; `conflict.claim` is the other claim's own text, so you can decide without a second read. " +
      "It is null when nothing matched, and also when the claim has no frame shape. The rule refuses " +
      "frames under three tokens and values over six, so short claims and claims trailed by a clause are " +
      "deliberately unmatched rather than loosely matched. On a line using `article_html` instead of " +
      "`body` it is always null, because the claim lives inside your markup and is not read until the " +
      "store renders it. " +
      "THE ASSIST NEVER CHANGES WHAT IS WRITTEN. An op carrying a conflict is written exactly as it " +
      "would have been without the flag: nothing is archived, nothing is refused, and later does not win. " +
      "That is deliberate, because sometimes the contradiction IS the answer. A memory recording that a " +
      "runbook step changed necessarily contradicts the memory stating the old step, and a system that " +
      "resolved that for you would delete the pair a reader needs in order to see the change at all. " +
      "You decide per conflict: keep both (they are about different things, or both are true), " +
      "`memhtml correct <path>` instead (the new claim supersedes the old one, and the old one stays readable " +
      "under archive/), or drop the line (you were about to restate something already stored). " +
      "Archived memories never match, so a superseded claim stops contradicting the claim that superseded it.\n" +
      "Every supersede through `memhtml correct` also stamps a VALIDITY " +
      "WINDOW, in the same one commit. The superseded memory gains `memhtml-valid-until` set to the " +
      "moment the new fact became true (the winner's own `memhtml-valid-from`, else its first " +
      "`<time datetime>`, else the operation's instant), and the winner gains `memhtml-valid-from` at " +
      "that same moment, so one window closes exactly where the next opens. Min-wins: a memory " +
      "already stating an EARLIER `memhtml-valid-until` keeps it, because a fact cannot outlive its " +
      "earliest stated bound. That is what `--as-of` on `memhtml search` reads: pass an ISO instant and " +
      "the result is what was believed valid AT THAT MOMENT. Since-superseded memories return, each " +
      "marked `superseded_by` naming what replaced it, and facts not yet valid then are absent. " +
      "History is read from the files, not replayed from git, so it survives a full index rebuild.\n" +
      "The frame rule deliberately refuses to match a REWORDING — same fact, different words shares no " +
      "frame key — and dedupe refuses it too, because the bytes differ. That gap is " +
      "`--detect-near-duplicates` (the batch tool's `detect_near_duplicates`): each result gains a " +
      "`near_duplicates` list naming ACTIVE memories (or earlier ops in this same stream) whose text " +
      "sits at or above cosine 0.92 against the op's claim and body, best first, each entry carrying " +
      "the other claim's text, the measured `similarity`, and one of `path` or `batch_index`, the same " +
      "split `conflict` uses. PROPOSE-ONLY, exactly like `--detect-conflicts`, and for one more reason: " +
      "the score is geometry, and geometry is weak on the tokens that carry polarity — a claim and its " +
      "negation also sit above 0.92 — so read the paired claim before folding anything. This flag is " +
      "for a batch writer that wants to learn it restated the corpus before a curator does. It costs one " +
      "embedding call per batch. On an `article_html` line it is always null (the claim lives inside " +
      "your markup), and when the embedder cannot run at all (`MEMHTML_EMBED=off`, or the call failed) " +
      "the result carries `near_duplicates_degraded: true` and every `near_duplicates` is null, " +
      "meaning UNCHECKED rather than unique."
  },
  {
    topic: "authoring",
    body:
      "Every write authors the article in exactly one of two ways, and supplying both or neither is " +
      "refused. Either you write prose and the template owns the markup (`--claim` is the one " +
      "load-bearing sentence and becomes the `<mark>` claim span and `files.gist`, and each `--body` " +
      "is one paragraph after it) or you supply `--article-html` and own the markup yourself. " +
      "On a `memhtml apply` line the prose form is the `body` field, whose first sentence becomes the claim, " +
      "and the markup form is `article_html`. " +
      "When you supply markup you own two constraints. It must contain EXACTLY ONE `<mark>`, and that " +
      "`<mark>` must sit in the article's first `<p>` or `<li>` and not inside an `<aside>` or " +
      "`<details>`. The claim leads the article and is never a caveat or behind a fold. And the first " +
      "`<time datetime>` in your markup becomes the memory's event time, which is what recency ranks " +
      "on, so a memory about something that happened last year should say so rather than being ranked " +
      "as today's news. " +
      "Markup is checked before anything is written: the store renders your article, runs the format " +
      "check, and refuses with the list of violations before it creates a file, stages it, or commits. " +
      "A refused write leaves the tree byte-identical, so a failed attempt costs nothing and you can fix " +
      "the markup and retry. " +
      "Code goes in the prose path as a fenced block: a body paragraph that is entirely a ``` fence " +
      "becomes <figure><pre><code>, whitespace preserved verbatim, and the fence's info string " +
      "(```ts) is stamped as data-lang and promoted to a `lang:ts` entity, so `memhtml list --entity " +
      "lang:ts` finds every memory carrying TypeScript. A blank line inside a fence does NOT split " +
      'paragraphs. On the markup path write the same <figure><pre><code data-lang="ts"> yourself; ' +
      "never `class` (forbidden) and never `lang=` (that attribute names human languages)."
  },
  {
    topic: "code-mode",
    body:
      "Answering a question that takes MORE THAN ONE HOP through the corpus? Write it as a script and " +
      "run `memhtml exec` once, instead of spending a tool call per hop. Supersedence ancestry, live " +
      "contradiction pairs, orphan census, entity co-occurrence, 'which of these 40 paths has no " +
      "backlink': each of those is one traversal in code and N round trips through `memhtml read` and " +
      "`memhtml neighbors`. Measured on a 305-file corpus: a full census in 598ms, and 410 edges resolved " +
      "into 201 chains, longest 8 hops, in one execution at 430ms. " +
      "The script runs under QuickJS in a sandbox with the corpus mounted READ-ONLY at `/mnt/memhtml`, and " +
      "a helper is already seeded for you at `/workspace/lib/corpus.mjs`. Import it: " +
      '`import { corpus, backlinks, chain, edges } from "/workspace/lib/corpus.mjs"`. `corpus()` ' +
      "returns a Map keyed by root-absolute path (the SAME string an edge's href holds, so " +
      "`memories.get(link.href)` resolves with no path juggling) and each value carries `claim`, " +
      "`memoryType`, `status`, `tags`, `entities`, `links`, `facets`, `citations`, `eventAt`, and a " +
      "`document` escape hatch for any selector the fields do not cover. " +
      "Print your answer as JSON on stdout with `console.log`; it comes back verbatim in `data.stdout`, " +
      "so keep it small and structured rather than dumping the corpus. " +
      "THREE THINGS IT CANNOT DO, by design. It cannot write: the corpus is read-only and a write " +
      "answers EROFS, so every write still goes through `memhtml write` / `memhtml apply`, which own commits, " +
      "dedup, and conflict detection. It cannot rank: no cosine, no RRF, no salience, and no index " +
      "database. For ranked retrieval shell out to `memhtml search` and parse its envelope, which " +
      "the one-envelope-per-command contract already makes a code-mode API. And it cannot reach the " +
      "network: there is no curl and the guest's `fetch` refuses on call. " +
      "The intended opening move is ranked retrieval FIRST, code-mode second: `memhtml search` or " +
      "`memhtml recall` to get the handful of paths the ranking stack says matter, then `memhtml exec` to walk, " +
      "join, count, and filter from there. Starting in code-mode means starting with a full-corpus scan " +
      "and no relevance signal. " +
      "A non-zero `exitCode` in the response is YOUR script failing, not the command failing. Read " +
      "`data.stderr` for the diagnostic and the exit code is still 0. A script that runs past " +
      "`--timeout-ms` (default 30000) comes back `exitCode: 124` with `timedOut: true`. " +
      "The tree you get is a pinned commit, HEAD by default, named in `data.sha`, so an answer is " +
      "reproducible with `--sha`, and an uncommitted edit is NOT visible to the script."
  },
  /**
   * The one topic whose text lives in `@memhtml/contracts/guidance` rather than here, because it is
   * rendered by three more surfaces (the instruction block and the skill `memhtml integrations install`
   * writes, and the retrieval tools' descriptions), and four hand-written copies of one discipline
   * would drift the first time a rule moved.
   */
  {
    topic: "recall-discipline",
    body: RECALL_DISCIPLINE_TEXT
  }
]

export const GUIDE_TOPICS = GUIDE.map((block) => block.topic)

/**
 * Derived from `COMMANDS` and `GLOBAL_FLAGS` by walking them, so adding a flag
 * updates the manifest automatically. A hand-written manifest drifts the first
 * time someone adds a flag and forgets to edit it.
 */
export const buildManifest = () => ({
  name: "memhtml",
  version: "0.15.1", // x-release-please-version
  summary: "Read, write, and curate the git-backed memory repo.",
  apiVersion: "1",
  /**
   * The prose an agent needs before the command table means anything, so it is listed before it.
   * A manifest that opens with the command specifications makes an agent infer the workflow from a
   * surface, while `guide` states it. No count appears here: `commands` is `COMMANDS` walked, so the
   * only honest quantity is its `length`.
   */
  guide: GUIDE,
  globalFlags: GLOBAL_FLAGS,
  errorCodes: ERROR_CODES,
  config: CONFIG_VARS,
  responseTypes: [...new Set(COMMANDS.flatMap((command) => command.responseTypes))],
  commands: COMMANDS.map((command) => ({
    name: command.name,
    summary: command.summary,
    args: command.args,
    flags: command.flags,
    responseTypes: command.responseTypes,
    // Always an array, so an agent reading `examples: []` knows the command has none rather than
    // wondering whether the field exists. `--dense` strips nulls, never empty arrays.
    examples: command.examples ?? [],
    supportsJson: true,
    supportsDense: true
  }))
})
