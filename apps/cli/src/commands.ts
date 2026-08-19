import { MEMORY_RELS } from "@memhtml/contracts/edges"
import { TASK_STATUSES, WRITABLE_MEMORY_TYPES } from "@memhtml/contracts/types"
import { REINFORCE_SIGNALS } from "@memhtml/domain"
import { SLEEP_PHASES } from "@memhtml/sleep"

import { CONFIG_VARS } from "./config.js"
import { ERROR_CODES, type ResponseType } from "./envelope.js"
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
}

export interface CommandSpec {
  readonly name: string
  readonly summary: string
  readonly args: ReadonlyArray<ArgSpec>
  readonly flags: ReadonlyArray<FlagSpec>
  readonly responseTypes: ReadonlyArray<ResponseType>
}

/** Flags every command accepts. Listed once so the manifest cannot drift from behavior. */
export const GLOBAL_FLAGS: ReadonlyArray<FlagSpec> = [
  {
    name: "json",
    type: "boolean",
    description: "Emit the typed JSON envelope on stdout (default; logs go to stderr).",
    default: true
  },
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
  }
]

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
    responseTypes: ["cli.manifest"]
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
        description: "The memory type. `arc` is absent: an arc is synthesized by sleep.",
        values: WRITABLE_MEMORY_TYPES,
        required: true
      },
      {
        name: "path",
        type: "string",
        description: "An explicit path override. Ignored when it is not a valid memory path."
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
    responseTypes: ["memory.written"]
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
          "The JSONL file to read. One complete JSON object per line. Omit it (or pass `-`) to read the stream from stdin."
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
        name: "consolidate",
        type: "string",
        values: ["last-wins"],
        description:
          "Resolve frame-key matches instead of only reporting them: `--consolidate last-wins` makes the LATER op's value win a shared claim slot (one file, written at the FIRST index that claimed the slot, with each later restatement reporting `consolidated_into` naming that slot) and archives a stored ACTIVE memory a surviving slot displaces, reported as `superseded_path`. Off by default; claims with no frame shape are never consolidated."
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
    flags: [
      {
        name: "session-id",
        type: "string",
        description: "Records a `read` session link, so provenance is queryable both ways."
      }
    ],
    responseTypes: ["memory.detail"]
  },
  {
    name: "search",
    summary: "Ranked search: four RRF arms plus MMR. Degrades to the lexical floor.",
    args: [{ name: "query", description: "Prose. Never a query language.", required: true }],
    flags: [
      ...SCOPE_FLAGS,
      { name: "limit", type: "int", description: "Hits to return.", default: 10 }
    ],
    responseTypes: ["memory.hits"]
  },
  {
    name: "recall",
    summary: "A disclosure pack under a character budget: arcs and memories folded separately.",
    args: [{ name: "query", description: "Prose.", required: true }],
    flags: [
      ...SCOPE_FLAGS,
      {
        name: "budget",
        type: "int",
        description: "Characters of quoted body. Arcs get their own envelope on top.",
        default: 16_000
      }
    ],
    responseTypes: ["recall.pack"]
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
        description: "The new memory's type. Defaults to the target's.",
        values: WRITABLE_MEMORY_TYPES
      },
      { name: "reason", type: "string", description: "Why the correction was made." },
      { name: "session-id", type: "string", description: "Records a `corrected` session link." }
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
      { name: "path", description: "A memory path. Repeat the argument for more.", required: true }
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
    summary: "Page through the corpus by type, workspace, tag, entity, or PARA bucket.",
    args: [],
    flags: [
      {
        name: "type",
        type: "string",
        description: "One memory type.",
        values: WRITABLE_MEMORY_TYPES
      },
      { name: "workspace", type: "string", description: "One workspace." },
      { name: "tag", type: "string", description: "One tag." },
      { name: "entity", type: "string", description: "One `type:name` entity reference." },
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
    responseTypes: ["memory.list"]
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
    responseTypes: ["task.written"]
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
      }
    ],
    responseTypes: ["task.list"]
  },
  {
    name: "index rebuild",
    summary: "Rebuild index.db from the git tree at HEAD. Destroys nothing outside .memhtml/.",
    args: [],
    flags: [
      {
        name: "embed",
        type: "boolean",
        description: "Fill missing vectors from Bedrock. --no-embed makes the rebuild instant.",
        default: true
      }
    ],
    responseTypes: ["index.report"]
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
    args: [{ name: "query", description: "Prose.", required: true }],
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
    name: "sleep run",
    summary: "The nightly curation cycle: 15 phases, each an isolated commit on a review branch.",
    args: [],
    flags: [
      {
        name: "date",
        type: "string",
        description: "The run date, `YYYY-MM-DD`. Defaults to today. Names the branch."
      },
      {
        name: "phases",
        type: "string",
        description: `Comma-separated subset. All 15 by default: ${SLEEP_PHASES.join(", ")}.`
      },
      {
        name: "dry-run",
        type: "boolean",
        description: "Report per-phase counts and commit nothing.",
        default: false
      }
    ],
    responseTypes: ["sleep.report"]
  },
  {
    name: "sleep resume",
    summary: "Re-run only the phases with no Memhtml-Phase trailer on the branch.",
    args: [{ name: "run-id", description: "The run id, e.g. sleep/2026-08-02.", required: true }],
    flags: [],
    responseTypes: ["sleep.report"]
  },
  {
    name: "sleep review",
    summary: "Per-phase counts, the commit list, diff --stat, and a per-file classification.",
    args: [{ name: "run-id", description: "The run id.", required: true }],
    flags: [
      { name: "diff", type: "boolean", description: "Include the raw diff.", default: false }
    ],
    responseTypes: ["sleep.review"]
  },
  {
    name: "sleep merge",
    summary: "Fast-forward main to the run's branch, after the discrimination gate passes.",
    args: [{ name: "run-id", description: "The run id.", required: true }],
    flags: [
      {
        name: "skip-gate",
        type: "boolean",
        description:
          "Merge without re-running discrimination. A deliberate, logged override, never a default.",
        default: false
      }
    ],
    responseTypes: ["sleep.merge"]
  },
  {
    name: "sleep status",
    summary: "The latest sleep run and its per-phase outcomes.",
    args: [],
    flags: [],
    responseTypes: ["sleep.report"]
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
          "The script to run, as a path on the HOST. Omit it (or pass `-`) to read the script from stdin. Mutually exclusive with `--script`."
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
    summary: "Run the `memhtml-mcp` stdio server: 14 tools and 2 resources over this same repo.",
    args: [],
    flags: [],
    responseTypes: ["serve.exit"]
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
 * D8/G6). The manifest carries it on a bare `memhtml`, `memhtml help`, `memhtml --help`, and `memhtml manifest`, and
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
      "and environment variable the binary accepts. A bare `memhtml`, `memhtml help`, `memhtml --help`, and " +
      "`memhtml manifest` all return it, and all four answer on a machine with no repo, no database, and " +
      "no credentials, so this is also the liveness check when something else has failed. " +
      "Every command writes exactly ONE JSON envelope to stdout and nothing else; logs go to stderr. " +
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
      "Second, the MCP server: `memhtml serve mcp` speaks stdio with 14 tools and 2 resources over this " +
      "same repo, and it is the door to use when you are already an MCP client. " +
      "Third, editing files under $MEMHTML_ROOT directly with your normal file tools: the git tree IS the " +
      "system of record and `.memhtml/index.db` is only a projection of it, so a hand-written or hand-edited " +
      "memory file is as real as one this CLI wrote. `memhtml index update` projects uncommitted working-tree " +
      "changes as well as committed ones, so a dirty edit is searchable before you commit it. " +
      "What you take on by editing directly is everything the write path would have done for you: the " +
      "file must satisfy the format (run `memhtml doctor`, and `memhtml read <path>` reports per-file format " +
      "warnings), you own choosing a path that does not collide, you own noticing that the content " +
      "already exists somewhere else, and you own the commit. The nightly `memhtml sleep run` refuses to " +
      "start on a dirty tree, so an uncommitted edit blocks curation until it is committed or stashed. " +
      "A CLI command and a running `memhtml serve mcp` may share one store: the index is WAL SQLite, " +
      "which admits one writer at a time and any number of concurrent readers, so a second writer " +
      "waits its turn rather than failing. The one thing to keep clear of is `memhtml sleep run`, and " +
      "for a git reason rather than a database one: a run holds a checked-out `sleep/<date>` branch, " +
      "so a write landing during it commits onto that branch and is merged as if it were curation or " +
      "lost when the branch is dropped."
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
      "op carries the same optional fields `memhtml write` takes, in snake_case: `path`, `workspace`, `tag`, " +
      "`entity`, `importance`, `confidence`, `session_id`, `prompt_id`, `turn_uuid`. " +
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
      "When you have already decided that later wins (a re-scrape, a settings sync, any stream where " +
      "each line is the newest statement of its slot), pass `--consolidate last-wins` (the batch tool's " +
      '`consolidate: "last-wins"`) and the batch RESOLVES those matches instead of reporting them. ' +
      "Ops sharing a frame key write ONE file carrying the LATER value at the FIRST index that claimed " +
      "the slot; each later restatement reports `consolidated_into` naming that slot and the summary " +
      "counts it under `consolidated`, neither written nor failed. A stored ACTIVE memory occupying a " +
      "surviving slot is archived with a supersedes link from the new file, its archive path reported " +
      "as `superseded_path`, the same chain `memhtml correct` leaves, so ancestry reads identically. " +
      "OFF by default, and the key is the conflict rule's own: the frame split is a rule measured in " +
      "the eval harness before it was believed and ported verbatim into `@memhtml/domain`'s frame.ts, " +
      "which detection and consolidation share, so anything the rule refuses to key (short frames, " +
      "clause values) is never consolidated, and what you saw reported with `--detect-conflicts` is " +
      "exactly what this flag would have acted on.\n" +
      "Every supersede, `memhtml correct` and `--consolidate last-wins` alike, also stamps a VALIDITY " +
      "WINDOW, in the same one commit. The superseded memory gains `memhtml-valid-until` set to the " +
      "moment the new fact became true (the winner's own `memhtml-valid-from`, else its first " +
      "`<time datetime>`, else the operation's instant), and the winner gains `memhtml-valid-from` at " +
      "that same moment, so one window closes exactly where the next opens. Min-wins: a memory " +
      "already stating an EARLIER `memhtml-valid-until` keeps it, because a fact cannot outlive its " +
      "earliest stated bound. That is what `--as-of` on `memhtml search` reads: pass an ISO instant and " +
      "the result is what was believed valid AT THAT MOMENT. Since-superseded memories return, each " +
      "marked `superseded_by` naming what replaced it, and facts not yet valid then are absent. " +
      "History is read from the files, not replayed from git, so it survives a full index rebuild."
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
      "database. For ranked retrieval shell out to `memhtml search --json` and parse its envelope, which " +
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
  version: "0.3.0", // x-release-please-version
  summary: "Read, write, and curate the git-backed memory repo.",
  apiVersion: "1",
  /**
   * The prose an agent needs before the command table means anything, so it is listed before it.
   * A manifest that opened with 33 command specifications makes an agent infer the workflow from a
   * surface, while `guide` states it.
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
    supportsJson: true,
    supportsDense: true
  }))
})
