# The memory file format — semantic HTML5, closed vocabulary

One fact per file. Standard HTML5, view-source readable, no `class`, no `<div>`/`<span>` except inside a
`<figure>`. The vocabulary is CLOSED (`packages/html/src/vocabulary.ts:145`): an element outside it is a
WARNING, not a refusal. Every element in it earns its place by carrying **indexer semantics** —
structure Markdown cannot express and that the index consumes mechanically. There is no sanitizer: the
vocabulary IS the policy, and `checkDocument` neither throws nor repairs (`constraints.ts:351`).

## Head (machine plane)

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Prod rollbacks drain the VIP before the deploy is reverted</title>
<meta name="memhtml-type" content="procedural">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-02T14:03:11Z">
<meta name="memhtml-updated" content="2026-08-02T14:03:11Z">
<meta name="memhtml-confidence" content="0.90">
<meta name="memhtml-importance" content="8">
<meta name="memhtml-content-hash" content="sha256:134d641234f3f309caa7d7dd7f0b1038372ea0609d484058db45f3a8fe91f88b">
<meta name="memhtml-author" content="agent:claude-fable-5">
<meta name="memhtml-session" content="f7e32699-d45b-4248-8ae6-894dfc606f49">
<meta name="memhtml-prompt" content="pr_01JQ8ZK3">
<meta name="memhtml-turn" content="t_7c1a">
<meta name="memhtml-entity" content="service:checkout-api">
<meta name="memhtml-entity" content="person:sanju">
<meta name="memhtml-tag" content="deploy">
<meta name="memhtml-tag" content="oncall">
<link rel="memhtml-supersedes" href="/archive/2026/areas/oncall/rollback-order.html">
<link rel="memhtml-part-of" href="/areas/arcs/reversibility-first.html">
</head>
```

Four metas are REQUIRED: `memhtml-type`, `memhtml-status`, `memhtml-created`, `memhtml-updated`
(`packages/html/src/vocabulary.ts:35`). The rest are optional; the `files` table owns their defaults,
so an omission is completed rather than refused.

`META_ORDER` (`vocabulary.ts:42`) is the full closed name vocabulary AND the serializer's emission order
(`serialize.ts:83`): the four required names, then `memhtml-confidence`, `memhtml-importance`,
`memhtml-content-hash`, `memhtml-author`, `memhtml-session`, `memhtml-prompt`, `memhtml-turn`, `memhtml-valid-from`,
`memhtml-valid-until`, `memhtml-reprieves`, `memhtml-archived`, `memhtml-superseded-by`, `memhtml-needs-revision`,
`memhtml-task-status`, `memhtml-due`, and finally the two repeatables `memhtml-entity` and `memhtml-tag`. It is a
diff-stability contract: a new scalar is APPENDED at the end of the scalar block, because inserting one
mid-list moves every following line in every file the next edit touches. The surgical head editors
insert in this order too (`editors.ts:79`).

Exactly two names are REPEATABLE, `memhtml-entity` and `memhtml-tag` (`vocabulary.ts:20`) — one value per
element, so a one-tag correction is a one-line diff. Any other name stated twice is a violation
(`constraints.ts:302`); a name with an empty `content` contributes nothing (`parse.ts:215`).
`memhtml-content-hash` is ADVISORY: the parser reports it verbatim and never repairs it (`document.ts:37`),
so a stale value is visible rather than reconciled. Metas outside `memhtml-` (`description`, `viewport`) are
ignored entirely (`constraints.ts:297`), as are `<link>` elements whose `rel` lacks the prefix
(`constraints.ts:256`).

## Body (human plane with machine hooks)

```html
<body>
<article>
<p><mark>If a prod rollback is issued, drain the <abbr title="Virtual IP">VIP</abbr> before reverting the deploy.</mark> The revert alone leaves in-flight connections pinned to the old target group, observed on <time datetime="2026-07-28">July 28</time> during the <cite>checkout-api sev2</cite>.</p>
<dl>
<dt>Applies to</dt><dd>ALB and NLB target-group deploys</dd>
<dt>Failure window</dt><dd><data value="120">about two minutes</data> of pinned connections</dd>
</dl>
<p>The mechanism is <dfn>connection draining</dfn>: deregistration holds an existing TCP connection open until the delay elapses, and a revert that skips it hands the old target group traffic it will refuse.</p>
<figure>
<pre><code data-lang="bash">aws elbv2 modify-target-group-attributes \
  --target-group-arn "$TG" \
  --attributes Key=deregistration_delay.timeout_seconds,Value=0</code></pre>
<figcaption>The drain command that must precede the revert.</figcaption>
</figure>
<details>
<summary>How this was learned</summary>
<p>Three rollbacks in July replayed the same 500-spike; the third was caught live with the target group still serving.</p>
</details>
<aside>
<p>Fly.io and Cloud Run drain automatically. This is AWS-target-group specific.</p>
</aside>
</article>
</body>
</html>
```

That file parses with zero violations and zero warnings, and yields the `content_hash` its own head
states, `gist` = the `<mark>` text, `event_at = 2026-07-28`, two facets (the second carrying
`numeric_value 120`), one citation, and four `file_entities` rows: `service:checkout-api`,
`person:sanju`, `concept:connection draining`, `lang:bash`.

## The vocabulary and what the indexer does with each element

| Element | Meaning | Indexer semantics |
|---|---|---|
| `<article>` | the memory; exactly one, and the hash scope | text → `files.body_text` (`packages/index/src/project.ts:160`), which drives `fts_text` (`:48`), `word_count` (`:37`), and the embedding chunks (`:152`) |
| `<mark>` | **the claim** — the one load-bearing span | `parse.ts:285` → `files.gist` (`project.ts:161`), the first `fts_text` field after the title, the first `disclosure_text` line (`project.ts:74`), and the span a correction targets |
| `<time datetime>` | when the fact HAPPENED, distinct from write time | FIRST in document order → `files.event_at` (`parse.ts:279`, `project.ts:173`); the recency arm ranks by `coalesce(event_at, updated_at)` (`packages/index/src/retrieval-sql.ts:125`) |
| `<dl>/<dt>/<dd>` | structured facets | positional pairs → `file_facets(path, name, value)` (`parse.ts:237`, `project.ts:282`); one `<dt>` may govern several `<dd>`s and each becomes its own row; disclosed as `name: value` (`project.ts:78`) |
| `<data value>` | machine value beside human phrasing | the first `<data value>` INSIDE a `<dd>`, as a finite number → `file_facets.numeric_value` (`parse.ts:257`). Unitless: the unit lives in the prose. Outside a `<dd>` it contributes no row |
| `<cite>` | source of the fact | → `file_citations` (`parse.ts:268`, `project.ts:289`); disclosed (`project.ts:79`) |
| `<q cite="…">` | verbatim quotation with source URI | as `<cite>`, plus the `cite` URI in `file_citations.href` (`parse.ts:272`) |
| `<dfn>` | the term a semantic memory defines | promotes to a `concept:<term>` entity row (`parse.ts:289`, `project.ts:328`) |
| `<figure>/<figcaption>` | attached artifact | caption text reaches FTS through `body_text`; it is NOT in `gist` and NOT in `disclosure_text` |
| `<details>/<summary>` | elaboration behind a fold | `<summary>` → `disclosure_text` (`parse.ts:292`, `project.ts:77`). The `<details>` body is searchable via `body_text` but never quoted — it reaches an agent only through `memory_read` (`project.ts:57`) |
| `<aside>` | scope caveat that is NOT the claim | `parse.ts:295`; in `body_text` and searchable, never in `disclosure_text` (`project.ts:61`) |
| `<abbr title>` | expansion | `parse.ts:305`. The element's TEXT is in `body_text`; the `title` value reaches no index column, so it is not searchable |
| `<pre>`, `<code>`, `<kbd>`, `<samp>`, `<var>` | technical content | all text in `body_text`. `<pre>` and `<code>` are excluded from `gist` (`vocabulary.ts:213`). Only `<pre>` preserves whitespace in the hash (`hash.ts:31`) |
| `<code data-lang="ts">` | the snippet's language | promotes to a `lang:ts` entity (`parse.ts:301`, `project.ts:330`), lowercased. A value outside `[A-Za-z0-9][A-Za-z0-9_+#.-]*` WARNS (`fences.ts:21`, `constraints.ts:330`). NEVER `class` (forbidden) or `lang=` (BCP-47 human language). From the fence's info string, or auto-detected at write time when it has none — see **Fences and `data-lang`** below |
| `<section>`; `<table>` (+ `caption/thead/tbody/tr/th/td`); `<p>`, `<ul>/<ol>/<li>`, `<a href>`, `<strong>/<em>`; `<address>` | grouping, tabular facts, ordinary prose, and a person file's contact surface | text → `body_text`, no field of their own. `<address>` is permitted ANYWHERE, not just under `resources/people/`: this module sees HTML, never a path (`vocabulary.ts:135`) |
| `<div>`, `<span>` | containers a pasted sample carries | permitted only under a `<figure>`; outside one they warn (`vocabulary.ts:142`, `constraints.ts:334`) |

`memhtml-entity` values become `file_entities` rows, split on the first colon; one with no colon is stored
under type `unknown` rather than dropped (`project.ts:322`). `memhtml-tag` values become `file_tags`. `<link
rel="memhtml-*">` elements become `edges` rows with the leading slash stripped and a self-loop dropped
(`project.ts:355`). Facet, citation, entity, and tag rows are deduplicated before insert, so a repeated
`<dt>`/`<dd>` pair cannot fail the batch (`project.ts:381`).

**Fences and `data-lang`.** A body paragraph that is a whole backtick fence becomes
`<figure><pre><code>` (`packages/html/src/fences.ts` owns the grammar; `template.ts:102` renders it).
The info string names the language and WINS outright: whatever the author wrote reaches `data-lang`
verbatim, subject only to `LANG_TOKEN`, so `js`, `c++`, and `objective-c` all pass through.

An UNLABELED fence is auto-detected, propose-only, at write time
(`packages/html/src/detect.ts`). The detector is highlight.js `highlightAuto` over its FULL grammar
set, scored as the per-line evidence margin between the winning grammar and its closest real
competitor — `1 - exp(-(top - runnerUp) / lines)`, with `runnerUp` zeroed when it normalizes to the
same language as the winner, because `pgsql` beating `n1ql` is a dialect duel and not disagreement.
`data-lang` is stamped only when confidence reaches **0.30** AND the detection lands in a closed
12-name vocabulary (`typescript`, `javascript`, `python`, `bash`, `json`, `sql`, `yaml`, `html`,
`toml`, `css`, `go`, `rust`); otherwise the attribute is simply absent, because wrong metadata
reaches `lang:` entities and search while a missing attribute costs nothing. Both gates are
independent: hljs will name `smali` at confidence 0.86 for a bash snippet, and confidence says only
"this grammar won by a wide margin", never "this grammar is one we stamp".

Neither the threshold nor the formula is a guess. `memhtml-evals`
(`results/detector-eval-2026-08-04.json`) swept highlight.js against `flourite` over a 332-snippet
corpus of real fences and file slices and took the point where measured precision first reached a
95% floor: threshold `0.28685957116771854`, precision 95.18%, coverage 25.0%. The deployed 0.30 is
that point rounded in the safe direction — confidence is monotone in evidence, so a higher threshold
can only drop marginal stamps.

Fences longer than 4096 characters (`DETECT_MAX_CHARS`) abstain without running the detector at
all: `highlightAuto` runs 192 grammars synchronously with super-linear cost (measured ~20s of
blocking CPU at 40KB on the pinned build), and the write path shares one single-threaded process
with every other request. Abstention above the cap is the same fail-closed "no stamp" as an
out-of-vocabulary detection.

Two properties follow, and both are enforced by tests. **Determinism:** highlight.js is pinned
EXACTLY (`11.11.1`, no caret) because relevance scores are grammar-dependent, so a version bump
would silently move every confidence and therefore which fences get stamped; a bump is a deliberate
decision that re-runs the eval and re-derives the threshold. **Rebuildability:** detection runs ONLY
on the write path, and the stamp is written into the file. Index rebuild reads `data-lang` back
(`parse.ts:301`) and never re-detects, so `rm index.db && rebuild` is a pure function of the tree
rather than of the installed highlight.js version. A grep lock over `@memhtml/index`'s emitted bytes
keeps it that way.

**The content hash.** `sha256` over the whitespace-normalized text content of `<article>`
(`packages/html/src/hash.ts:115`). Head and `<link>` edits are outside the scope by construction —
`contentHash` locates the `<article>` first even when handed whole-file bytes (`hash.ts:169`) — which
keeps confidence decay, access bookkeeping, and sleep's stamping from looking like content changes. A
block element contributes a collapsible space at each edge (`hash.ts:72`), so the digest is a function of
the article's words and not its indentation: a flat `<ul><li>one</li><li>two</li></ul>` and the same list
pretty-printed hash identically. Whitespace is preserved verbatim only inside `<pre>` (`hash.ts:31`), and
the outer trim applies only to a leading or trailing COLLAPSIBLE segment (`hash.ts:120`), so a `<pre>`
whose text begins with two spaces and the same `<pre>` without them are different digests — the
difference a `<pre>` exists to keep, while a bare `<code>` collapses like prose. U+00A0 is content, not
whitespace (`hash.ts:22`).

## Constraints

Six numbered constraints over the parsed tree (`packages/html/src/constraints.ts:29`), plus head
well-formedness and the meta-value rules. Violations are COLLECTED, never short-circuited, so one parse
tells an author everything wrong with the file (`constraints.ts:351`), and `InvalidMemory` carries them
joined by `"; "` (`constraints.ts:40`). A WARNING never blocks a write.

1. **Exactly one `<article>`** (`constraints.ts:115`); everything downstream assumes a single hash scope.
   **Exactly one `<mark>` within that article**, carrying non-empty text, positioned in the article's
   first `<p>`-or-`<li>` (`constraints.ts:165`). The position rule takes the first `<p>` or `<li>` in
   DOCUMENT ORDER (`constraints.ts:193`), so a `<mark>` in an `<li>` that follows a `<p>` is a violation,
   and a `<mark>` outside the `<article>` is not counted at all. Emptiness is the `files.gist` rule
   verbatim — `canonicalText` with `excludeCode`, then trimmed (`constraints.ts:146`) — so a claim
   reaching through a nested `<strong>` is NOT empty, while `<mark><code>drain --vip</code></mark>` IS:
   it would pass the count and placement rules and land a committed, indexed file with an empty
   `files.gist`, absent from every disclosure tier and from the recall pack's quoted body, invisible
   rather than merely wrong.
2. **Every `<time>` carries a `datetime`** this format can sort (`constraints.ts:205`): ISO `YYYY-MM-DD`,
   optionally with a time and zone, range-checked (`constraints.ts:67`). Narrower than HTML's own grammar
   because `files.event_at` and `files.due_at` are compared as strings — `2026-08` and `2026-13-45` are
   refused, `23:59:60` is admitted.
3. **No `class`, no `style` attribute, no `<script>`, no `<style>`, no `on*` handler**
   (`constraints.ts:227`, `vocabulary.ts:244`). Presentation belongs to a stylesheet, behavior nowhere.
4. **Every head `<link rel="memhtml-*">` names a closed-vocabulary rel and a root-relative href**
   (`constraints.ts:251`). The rel token is the rel with underscores hyphenated
   (`packages/contracts/src/edges.ts:109`), so `laterally_related` is `memhtml-laterally-related`. The href
   needs a leading slash, no scheme, no host, no `..` segment (`constraints.ts:89`): a relative href
   would break on the first `git mv` of the SOURCE file and `//host/x` would leave the repo.
5. **`<aside>` and `<details>` may not contain the `<mark>`** (`constraints.ts:187`). The claim is never a
   caveat and never behind a fold. A fold violation suppresses the position message, since a mark inside
   an `<aside>` is never in the first `<p>` and naming one mistake twice helps nobody.
6. **An element outside the closed vocabulary WARNS** (`constraints.ts:320`). The file still parses and
   still indexes, so a hand-authored file degrades gracefully. Warnings are deduplicated by element name:
   forty stray `<div>`s produce one actionable line.

**Head well-formedness** (`constraints.ts:278`): exactly one non-empty `<title>`; the four required
metas present; no `memhtml-`-prefixed name outside `META_ORDER`; no non-repeatable name stated twice. A
duplicate `memhtml-type` is a violation rather than a last-wins pick, because two writers disagreeing about
a memory's type should stop a write.

**Meta values** (`parse.ts:85`): a `memhtml-type` outside `MEMORY_TYPES`
(`packages/contracts/src/types.ts:18`) is a violation (`parse.ts:99`), as is a `memhtml-status` that is
neither `active` nor `archived` (`parse.ts:102`). A malformed OPTIONAL value is DROPPED rather than
failing the parse — `memhtml-confidence` outside `[0, 1]`, `memhtml-importance` outside the integers 1-10
(`parse.ts:67`), a non-ISO `memhtml-created`, a garbage `memhtml-content-hash` — because the omission and the
`files` default are the graceful reading, and `memhtml doctor` reports the drop.

## Task files

A task is one of the ten `memory_type` values (`packages/contracts/src/types.ts:18`) and an ordinary
memory file: one `<article>`, one `<mark>`, the same closed vocabulary, the same hash rules. It carries
two metas nothing else does. `memhtml-task-status` is `todo` | `doing` | `blocked` | `done`
(`types.ts:82`), a SEPARATE axis from `memhtml-status`, which stays `active`/`archived` for a task as for
anything else. `memhtml-due` is a deadline, distinct from `memhtml-valid-until`: that bounds when a remembered
FACT stops being true, this says when work is late.

The parser enforces **both directions of the coupling** (`packages/html/src/parse.ts:166`): a `task`
with no `memhtml-task-status` is a violation, because it has no lifecycle position and every `--status`
filter would omit the very task the surface exists to show; a `memhtml-task-status` on any other type is a
violation too, because it asserts a lifecycle nothing advances. `memhtml-due` reuses the `<time>` validator
(`parse.ts:187`), so `2026-8-9` is refused, and is NOT coupled to the type — a non-task may carry one.

`<mark>` is the task STATEMENT, what "done" would mean, because that is what `files.gist` stores and
what every listing shows. `<dl>` carries the facets a plan needs; `<details>` holds working notes so a
long investigation does not bury the statement.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Wire the drain step into the rollback runbook</title>
<meta name="memhtml-type" content="task">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-02T14:03:11Z">
<meta name="memhtml-updated" content="2026-08-02T16:40:02Z">
<meta name="memhtml-importance" content="7">
<meta name="memhtml-content-hash" content="sha256:f66c2faacb461c65ba97438bbffe01862bb2306f6504945bdeb168da1e5b75f7">
<meta name="memhtml-task-status" content="doing">
<meta name="memhtml-due" content="2026-08-20">
<meta name="memhtml-tag" content="deploy">
<link rel="memhtml-blocks" href="/projects/checkout-api/tasks/land-the-target-group-migration.html">
</head>
<body>
<article>
<p><mark>The rollback runbook tells an operator to drain the VIP before reverting the deploy.</mark> It currently says revert first, which is the failure <cite>areas/oncall/rollback-order.html</cite> describes.</p>
<dl>
<dt>Blocked on</dt><dd>the target-group migration</dd>
<dt>Estimate</dt><dd><data value="2">about two hours</data></dd>
</dl>
<details>
<summary>Working notes</summary>
<p>Step 4 is the one to change; steps 5 through 7 already assume a drained VIP.</p>
</details>
</article>
</body>
</html>
```

**A `<link rel="memhtml-blocks">` may only name another task.** The two task rels (`blocks`,
`subtask_of`) are their own edge class (`packages/contracts/src/edges.ts:54`), and `@memhtml/store`
refuses a link whose endpoints disagree with its class in either direction
(`packages/store/src/store.ts:838`) — a task rel needs two tasks, and a memory rel refuses a task at
either end. That is what keeps a to-do list out of PageRank, MMR, and the retention bridge count.

**Two open tasks with identical bodies are two real work items**, so content-hash dedup carves tasks
out (`store.ts:292`): the `files_content_hash_active` partial unique index and the write path's dedupe
lookup both filter `memory_type <> 'task'` (`store.ts:283`, `packages/index/src/traces-persist.ts:152`),
and a memory whose article matches an open task's is not deduped onto it either.

**Corrections.** `memory_correct` writes a fresh `<article>` with a new claim in `<mark>`, stamps
`memhtml-supersedes` toward the old file, and archives the old one (`store.ts:764`). No `<ins>`/`<del>` —
git is the diff.

## Writing markup directly

The prose path — `body` on the MCP tools, `--claim`/`--body` on the CLI — entity-escapes its argument
(`packages/html/src/markup.ts:36`), so an element written into prose reaches disk as text. That is
deliberate for prose, and it is why the two markup surfaces exist: `article_html` (`memory_write`,
`memory_correct`) and `--article-html` (`memhtml write`, `memhtml correct`) supply the `<article>`'s inner
markup VERBATIM (`packages/html/src/template.ts:120`). Exactly one of the two per call — both or
neither is refused, and a blank string counts as absent (`apps/mcp/src/handlers.ts:145`,
`apps/cli/src/run.ts:636`).

Verbatim means **the caller owns constraint 1**: the markup must carry its own single non-empty
`<mark>` in its first `<p>`-or-`<li>`, because the template is not placing it (`template.ts:133` is the
prose branch only). Every constraint above applies unchanged. `@memhtml/store` renders and then re-parses
the bytes before anything is written, staged, or committed (`packages/store/src/store.ts:455`), so a
violation is a typed `InvalidMemory` naming it and the tree is left byte-identical — never a file in a
commit that the indexer then declines to project. This is also the only way `<time datetime>`, and so
`files.event_at`, is reachable from an agent: the first such element becomes the event time the recency
arm ranks by, so an episodic memory about last week carries last week's date, not today's.

**A batch does not soften any of this.** `memhtml apply` and `memory_write_batch` write N files in ONE
commit, and every op goes through the same render-then-reparse gate individually — so one bad op in
twenty is refused with its own violation list, and in the default atomic mode the whole batch is
refused before any file exists. Content-hash dedup applies per op, resolved against the corpus AND
against earlier ops in the same batch, with the same `task` carve-out in both directions
(`store.ts:303`). The batch is a commit-shape optimization, never a validation shortcut;
`docs/design.md` "Batch writes" has the contract.
