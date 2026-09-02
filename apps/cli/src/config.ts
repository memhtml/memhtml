import { homedir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_PROXY_MODEL_PREFIX,
  PROXY_API_KEY_VAR,
  PROXY_BASE_URL_VAR,
  PROXY_MODEL_MAP_VAR,
  PROXY_MODEL_PREFIX_VAR
} from "@memhtml/llm"
import { expandRoot } from "@memhtml/store"
import { Config } from "effect"

import { EXTRACTION_MODEL_ID } from "./extraction.js"
import { MCP_BIN_VAR } from "./serve.js"

/**
 * The whole environment surface, in one place, so `memhtml manifest` can describe it and a reader
 * does not have to grep for `process.env`.
 *
 * Every variable is read through `effect/Config` rather than `process.env` directly: a missing
 * required value becomes a typed failure with the variable's name in it, and a default is
 * declared next to the name it defaults for.
 */

/** One documented environment variable, for the manifest and the generated agent doc. */
export interface ConfigVar {
  readonly name: string
  readonly description: string
  /** The value used when the variable is absent, or `null` when absence is meaningful. */
  readonly fallback: string | null
}

export const CONFIG_VARS: ReadonlyArray<ConfigVar> = [
  {
    name: "MEMHTML_ROOT",
    description: "The memory repo's root: a git repository holding the corpus and `.memhtml/`.",
    fallback: join("~", "memhtml")
  },
  {
    name: "MEMHTML_TRACE_ROOT",
    description:
      "Where `memhtml trace index` reads Claude Code transcripts from. Read-only; never written.",
    fallback: join("~", ".claude")
  },
  {
    name: "MEMHTML_AWS_REGION",
    description: "The Bedrock region for embeddings and the sleep cycle's model-calling phases.",
    fallback: "us-east-1"
  },
  {
    name: "AWS_BEARER_TOKEN_BEDROCK",
    description:
      "Bedrock bearer token, read by the AWS SDK itself. Absent means the default credential chain; retrieval then degrades to the lexical floor rather than failing.",
    fallback: null
  },
  {
    /**
     * The three proxy names are imported from `@memhtml/llm` rather than retyped, for the reason
     * `MCP_BIN_VAR` is: the row and the `Config.string` read must name one string.
     */
    name: PROXY_BASE_URL_VAR,
    description:
      "An OpenAI- and Anthropic-compatible LLM proxy's origin, e.g. `http://127.0.0.1:4000` for an agentgateway listener. Set, every model call leaves through it instead of going to Bedrock directly: the Anthropic sleep models and the consolidator agent on `/v1/messages`, the OpenAI sleep model on `/v1/chat/completions`, embeddings on `/v1/embeddings`, entity extraction on `/v1/responses`. Absent means Bedrock directly, under `MEMHTML_AWS_REGION` and the Bedrock credential. A set-but-malformed value fails at startup naming this variable rather than falling back to the direct path.",
    fallback: null
  },
  {
    name: PROXY_API_KEY_VAR,
    description:
      "A bearer token for the LLM proxy, sent as `Authorization: Bearer <key>`. Read only when `MEMHTML_LLM_BASE_URL` is set; absent means the proxy takes no credential.",
    fallback: null
  },
  {
    name: PROXY_MODEL_PREFIX_VAR,
    description:
      "The prefix in front of every Bedrock model id a proxied request carries, so `global.anthropic.claude-opus-5` is asked for as `bedrock/global.anthropic.claude-opus-5`: the LiteLLM convention, which a LiteLLM proxy routes with one `bedrock/*` entry and which keeps the id after the slash exactly what Bedrock wants. Set it to `none` for a proxy that takes bare Bedrock ids. Read only when `MEMHTML_LLM_BASE_URL` is set.",
    fallback: DEFAULT_PROXY_MODEL_PREFIX
  },
  {
    name: PROXY_MODEL_MAP_VAR,
    description:
      "`from=to` pairs, comma-separated, naming single models to the proxy by exact id when the prefix rule does not fit: `cohere.embed-v4:0=cohere-embed-v4`. A mapped id is sent verbatim, without the prefix; every other id follows `MEMHTML_LLM_MODEL_PREFIX`. Read only when `MEMHTML_LLM_BASE_URL` is set.",
    fallback: null
  },
  {
    name: "MEMHTML_EMBED",
    description:
      "`off` disables the embedder entirely. An explicit opt-out, distinct from a missing credential: a missing credential degrades one search at call time, `off` degrades every search, and an operator reading this manifest needs those to be different states.",
    fallback: "on"
  },
  {
    name: "MEMHTML_LLM",
    description:
      "`off` makes every model-calling sleep phase report `no model bound` and stay `ok`, so a credential-free run is honest rather than red. `entity-resolution` still runs its deterministic normalization and character-overlap passes; the others do nothing.",
    fallback: "on"
  },
  {
    name: "MEMHTML_EXTRACT_ENTITIES",
    /**
     * The model id is interpolated from `extraction.ts`, never spelled here. That constant is the
     * one the transport calls and the one the strict output schema beside it is tested against, so a
     * second spelling in this row is a manifest that can name a model the code does not call. The
     * lane is also not `@memhtml/llm`'s: the extractor speaks the Bedrock mantle Responses API, which
     * is why this id is absent from `ModelKey`.
     */
    description: `\`on\` adds one \`${EXTRACTION_MODEL_ID}\` call per write batch that extracts \`memhtml-entity\` metas the ops did not declare. Opt-in, unlike MEMHTML_EMBED, because it changes what a write STORES: extracted entities land in the files as if authored, and the write itself never waits on or fails with the model. A failed extraction is a logged warning and an unextracted batch.`,
    fallback: "off"
  },
  {
    name: "OTEL_EXPORTER_OTLP_ENDPOINT",
    description:
      "An OTLP collector's base URL, e.g. `http://localhost:4318`. Set, the ~30 `Effect.withSpan` annotations already in the code (retrieval, embeddings, model calls, indexing, the sleep cycle, store writes, `db.*`, `git.*`) export as traces to `<endpoint>/v1/traces`, batched, flushed on exit. Unset, nothing is loaded and behavior is byte-identical. Export can never fail a command: a down collector is one stderr warning and a command that proceeds untraced.",
    fallback: null
  },
  {
    name: "OTEL_SERVICE_NAME",
    description:
      "Overrides the `service.name` resource attribute on exported traces. Absent, each process names itself: `memhtml-cli` or `memhtml-mcp`. Read only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.",
    fallback: null
  },
  {
    /**
     * The name is imported rather than retyped: this row and the `process.env` read at serve.ts:50
     * must name the same string, and a literal here would let a rename disclose a variable nothing
     * reads.
     */
    name: MCP_BIN_VAR,
    description:
      "An explicit path to the `memhtml-mcp` entry point, read only by the `memhtml serve mcp` supervisor. Absent means the sibling-path default. The two apps ship as one build, so `apps/cli/dist/serve.js` finds `apps/mcp/dist/bin.js` two directories over. An operator sets it for a split deployment that does not keep the apps side by side; it locates the server rather than configuring the store, so it changes no retrieval behavior.",
    fallback: null
  }
]

/**
 * `MEMHTML_ROOT`. Re-exported from `@memhtml/store`'s own config rather than redeclared, because the
 * store's config expands a leading `~`. This value arrives from a shell profile, an MCP client
 * config, and a cron line, and only the shell expands tildes on its own.
 */
export const MemhtmlRoot = Config.string("MEMHTML_ROOT").pipe(
  Config.withDefault(join("~", "memhtml")),
  Config.map(expandRoot)
)

/**
 * `MEMHTML_TRACE_ROOT`, defaulting to `~/.claude`.
 *
 * A parameter rather than a constant so the trace indexer is drivable against a fixture tree and
 * against an archived copy, which is also what keeps real transcripts out of the test suite.
 */
export const TraceRoot = Config.string("MEMHTML_TRACE_ROOT").pipe(
  Config.withDefault(join(homedir(), ".claude")),
  Config.map(expandRoot)
)
