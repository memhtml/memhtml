# `files.event_at` is unreachable through every write path

**Filed:** 2026-08-03 · **Status:** resolved 2026-08-03 · **Severity:** high for episodic recall — the recency arm silently ranks by write time instead of event time for every memory written by an agent.

**Resolution.** Fixed by option (b), the `articleHtml` passthrough, with the guardrail (b) was conditioned on. `article_html` on `memory_write`/`memory_correct` and `--article-html` on `memhtml
write`/`memhtml correct` carry the `<article>`'s inner markup verbatim, exclusive with the prose path (exactly one, enforced at the wire boundary). The objection to (b) — that it moves the format burden onto the caller with only the sanitizer behind it — is answered by a render gate in `@memhtml/store`: every write and correction is re-parsed before anything is written, staged, or committed, so a constraint violation is a typed `InvalidMemory` on a byte-identical tree rather than a commit the indexer declines to project. The tool descriptions state the contract so an agent learns it from `tools/list` instead of from its first refusal. (a) was not implemented and is no longer needed for this bug; it remains available and composes, as noted below. Locked end-to-end by `tests-integration/tests/mcp-stdio.test.ts`, which replays the repro below over real `memhtml serve mcp` stdio and asserts both the unescaped `<time>` on disk and `files.event_at` in the index. See `docs/format.md` §"Writing markup directly".

## Summary

The format says event time travels in the body as a `<time datetime>` element and the indexer maps the first occurrence to `files.event_at` (`docs/format.md` §vocabulary, row `<time datetime>`; `packages/index/src/project.ts:166`; `packages/html/src/parse.ts:280`). But both write surfaces — the MCP `memory_write` tool and the CLI `memhtml write` — escape the entire body as text, so a `<time>` element an agent supplies reaches disk as `&lt;time …&gt;` literal text inside the `<mark>` span. The parse-side extraction never sees an element, `event_at` stays NULL, and the recency arm's `coalesce(event_at, updated_at)` (`packages/index/src/retrieval-sql.ts:125`) falls back to write time on every agent-written memory. There is no parameter, flag, or tool argument that sets event time. The only files that carry an `event_at` today are hand-authored ones.

## Repro (run 2026-08-03, against `main` at `aad9007`)

```bash
export MEMHTML_ROOT=$(mktemp -d) MEMHTML_EMBED=off
node apps/cli/dist/bin.js init
node apps/cli/dist/bin.js serve mcp   # then over stdio JSON-RPC:
```

Call `memory_write` with:

```json
{
  "title": "Alice moved to Paris",
  "memory_type": "episodic",
  "body": "<p><time datetime=\"2023-05-20T02:21:00Z\">2023-05-20T02:21:00Z</time> Alice moved to Paris.</p>"
}
```

The file that reaches `areas/inbox/` holds the markup entity-escaped inside the claim span:

```html
<p><mark>&lt;p&gt;&lt;time datetime="2023-05-20T02:21:00Z"&gt;2023-05-20T02:21:00Z&lt;/time&gt; Alice moved to Paris.&lt;/p&gt;</mark></p>
```

The indexed row (queried against `.memhtml/index.db`):

```json
{
  "path": "areas/inbox/20260803-alice-moved-to-paris.html",
  "event_at": null,
  "updated_at": "2026-08-03T18:12:41Z",
  "gist": "<p><time datetime=\"2023-05-20T02:21:00Z\">…</time> Alice moved to Paris.</p>"
}
```

Control: hand-editing the same file so the `<time>` element is real markup and re-parsing with `parseMemory` yields `eventAt: "2023-05-20T02:21:00Z"`. The extraction works; no authored input can reach it.

## Mechanism (each step verified in source this session)

1. **The MCP handler passes plain text down.** `memory_write` splits the tool's `body` string into a claim and paragraph tail via `claimOf`/`restOf` and hands both to `writeMemory` as plain-text fields (`apps/mcp/src/handlers.ts:140-157`; `claimOf`/`restOf` at `apps/mcp/src/handlers.ts:116-127`). The tool's parameter schema (`apps/mcp/src/tools.ts:95-113`) has no timestamp and no markup field.
2. **The CLI does the same.** `memhtml write` maps `--claim`/`--body` straight onto the same `writeMemory` operation (`apps/cli/src/run.ts:189-205`), whose `WriteParams` (`apps/cli/src/operations.ts:179-194`) carry no event time and no markup field either.
3. **The template escapes everything.** `articleHtmlFor` wraps the claim in `<mark>` and runs the claim and every paragraph through `escapeText` (`packages/html/src/template.ts:88-101`), which entity-escapes `&`, `<`, and `>` (`packages/html/src/markup.ts:36-41`). Any element an agent embeds in prose becomes text.
4. **The escape hatch exists but nothing reaches it.** `NewMemoryInput.articleHtml` — "pre-authored article markup, used verbatim" (`packages/html/src/template.ts:33-38`) — would bypass the escaping, and `articleHtmlFor` honors it (`packages/html/src/template.ts:89-91`). Grep across `packages/` and `apps/` finds no caller outside `@memhtml/html`'s own tests: neither the MCP tool nor the CLI exposes it, and `WriteParams` cannot express it.
5. **So the extraction never fires.** `parseMemory` reads `eventAt` from the first `<time>` _element_ (`packages/html/src/parse.ts:280`); an escaped one is a text node. The projection writes `doc.article.eventAt ?? null` into `files.event_at` (`packages/index/src/project.ts:166`), and the recency arm orders by `coalesce(event_at, updated_at)` (`packages/index/src/retrieval-sql.ts:118-132`).

A secondary effect, visible in the repro: because the escaped markup contains no sentence terminator that `claimOf`'s regex accepts, the entire escaped blob becomes the `<mark>` claim, so `files.gist` — the Tier-1 disclosure line — is raw escaped HTML rather than prose.

## Impact

- **Backdating is impossible for agents.** Any memory written through MCP or the CLI sorts by when it was written down, never by when the fact happened — exactly the failure mode the `coalesce` was designed against (`packages/index/src/retrieval-sql.ts:114-116`).
- **Temporal reasoning degrades in the public benchmark.** The Track B eval harness (`memhtml-evals`, external) ingests LongMemEval sessions whose dataset timestamps are load-bearing for temporal-reasoning questions; its adapter carries a header-comment workaround (`src/adapter/memhtml.ts`) noting the timestamp survives only as body text.
- **The docs promise what the tools cannot do.** `docs/format.md`'s `<time datetime>` row documents behavior no supported write path can trigger.

## Fix options

### (a) An explicit event-time parameter on `memory_write` and `memhtml write` — recommended

Add `event_at` (MCP) / `--event-at` (CLI) to `WriteParams` and `NewMemoryInput`, validated by the existing `isValidDatetime` (`packages/html/src/constraints.ts:65-79`) before the commit, exactly as `decodeDueAt` already gates `--due` (`apps/cli/src/operations.ts:245-248`). The template renders it as a real `<time datetime="…">…</time>` element in the first paragraph after the `<mark>` span, so the file stays the source of truth and the parser, the indexer, and `memhtml doctor` all see the same element a hand-author would have written. The strongest case for doing (b) instead is that (a) covers only event time while `articleHtml` covers every structured element — but that generality is the argument against it below, and event time is the only extraction with a benchmark-visible failure today.

- Matches the template's own design position: "an agent that had to hand-author the `<mark>` placement would violate constraint 1 regularly; a template that places it cannot" (`packages/html/src/template.ts:15-16`). The same reasoning applies to `<time>`.
- Validation is one existing function; a bad value becomes a typed `InvalidMemory` before any file is rendered, the same path the task metas take (`apps/cli/src/operations.ts:233-248`).
- Cost: a tool-schema field, a CLI flag, a template line, and an `AGENTS.md` regeneration (`memhtml agents-doc`).

### (b) Expose the `articleHtml` passthrough

Surface `NewMemoryInput.articleHtml` on the tool and the CLI. The caller then owns constraint 1 (exactly one `<mark>`, inside the first `<p>`/`<li>`) and every other format constraint. This is the general fix — it would also unblock a correction that carries a `<dl>` or `<figure>` — but it moves the format burden onto every calling agent, which is the exact failure the template exists to prevent, and it widens the input surface to raw markup that today only the sanitizer and doctor stand behind. Constraint violations would surface as parse refusals or doctor warnings after the agent already composed the markup, rather than as a typed error on one field.

**Recommendation: (a).** It fixes the only extraction that is benchmark-visible, keeps the template owning the format, and validates with machinery that already exists. (b) remains worth doing later for structured corrections, as its own change with its own guardrails (for instance a parse-and-refuse gate on write), and nothing in (a) forecloses it — an explicit `event_at` and a passthrough compose.

## Non-goals of this report

No fix is implemented here. The eval harness's workaround stays in its own repo.

_(As filed. The fix landed separately — see the Resolution above. The eval harness's workaround is still its own repo's to remove.)_
