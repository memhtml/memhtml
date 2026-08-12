---
title: The memory file format
description: A closed HTML5 vocabulary whose every element carries indexer semantics, two hashes with two jobs, and a render gate that refuses before anything is written.
---

One fact per file. Standard HTML5, view-source readable, no `class`, no `<div>`/`<span>` except inside
a `<figure>`. The vocabulary is closed (`packages/html/src/vocabulary.ts:145`): an element outside it
is a warning, not a refusal. There is no sanitizer — the vocabulary *is* the policy, and
`checkDocument` neither throws nor repairs (`packages/html/src/constraints.ts:351`).

## 1. The machine plane

The head is a flat `memhtml-*` token space, hyphenated rather than colon-prefixed, because `rel`
tokens cannot hold a colon and the same convention has to carry to
`<link rel="memhtml-supersedes">` (`packages/contracts/src/edges.ts:101-110`). Repeatable keys are
repeated elements, so a one-tag correction is a one-line diff.

```html
<meta name="memhtml-type" content="procedural">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-02T14:03:11Z">
<meta name="memhtml-updated" content="2026-08-02T14:03:11Z">
<meta name="memhtml-confidence" content="0.90">
<meta name="memhtml-content-hash" content="sha256:134d64…">
<meta name="memhtml-entity" content="service:checkout-api">
<meta name="memhtml-tag" content="deploy">
<link rel="memhtml-supersedes" href="/archive/2026/areas/oncall/rollback-order.html">
```

Four metas are required — `memhtml-type`, `memhtml-status`, `memhtml-created`, `memhtml-updated`
(`packages/html/src/vocabulary.ts:35`). The rest are optional, and the `files` table owns their
defaults, so an omission is completed rather than refused.

Exactly two names are repeatable, `memhtml-entity` and `memhtml-tag`
(`packages/html/src/vocabulary.ts:20`), one value per element. Any other name stated twice is a
violation (`packages/html/src/constraints.ts:302`). `memhtml-content-hash` is advisory: the parser
reports it verbatim and never repairs it (`packages/html/src/document.ts:37`), so a stale value is
visible rather than reconciled.

`META_ORDER` (`packages/html/src/vocabulary.ts:42`) is both the closed name vocabulary and the
serializer's emission order (`packages/html/src/serialize.ts:83`). It is a diff-stability contract: a
new scalar meta is appended at the end of the scalar block, because inserting one mid-list moves every
following line in every file the next edit touches. The surgical head editors insert in the same
order (`packages/html/src/editors.ts:79`).

## 2. The human plane with machine hooks

Every element in the vocabulary earns its place by carrying indexer semantics — structure Markdown
cannot express and the index consumes mechanically.

| Element | Meaning | Indexer semantics |
|---|---|---|
| `<article>` | the memory; exactly one, and the hash scope | text → `files.body_text` (`packages/index/src/project.ts:160`), which drives `fts_text`, `word_count`, and the embedding chunks |
| `<mark>` | the claim — the one load-bearing span | `packages/html/src/parse.ts:285` → `files.gist`, the first `fts_text` field after the title, the first `disclosure_text` line, and the span a correction targets |
| `<time datetime>` | when the fact happened, distinct from write time | first in document order → `files.event_at` (`packages/html/src/parse.ts:279`); the recency arm ranks by `coalesce(event_at, updated_at)` |
| `<dl>/<dt>/<dd>` | structured facets | positional pairs → `file_facets(path, name, value)`; one `<dt>` may govern several `<dd>`s and each becomes its own row |
| `<data value>` | machine value beside human phrasing | the first `<data value>` inside a `<dd>`, as a finite number → `file_facets.numeric_value` (`packages/html/src/parse.ts:257`). Unitless — the unit lives in the prose |
| `<cite>`, `<q cite>` | source of the fact | → `file_citations` (`packages/html/src/parse.ts:268`), the `cite` URI into `file_citations.href` |
| `<dfn>` | the term a semantic memory defines | promotes to a `concept:<term>` entity row (`packages/html/src/parse.ts:289`) |
| `<details>/<summary>` | elaboration behind a fold | `<summary>` → `disclosure_text`; the body is searchable through `body_text` but never quoted |
| `<aside>` | scope caveat that is not the claim | in `body_text` and searchable, never in `disclosure_text` (`packages/index/src/project.ts:61`) |
| `<code data-lang="ts">` | the snippet's language | promotes to a `lang:ts` entity (`packages/html/src/parse.ts:301`), lowercased. Never `class`, never `lang=` |
| `<pre>`, `<code>`, `<kbd>`, `<samp>`, `<var>` | technical content | all text in `body_text`; `<pre>`/`<code>` excluded from `gist`; only `<pre>` preserves whitespace in the hash |
| `<div>`, `<span>` | containers a pasted sample carries | permitted only under a `<figure>`; outside one they warn (`packages/html/src/vocabulary.ts:142`) |

## 3. Two hashes, two jobs

`memhtml-content-hash` is `sha256` over the whitespace-normalized text of `<article>` alone, `<pre>`
verbatim (`packages/html/src/hash.ts:7-19`, `packages/html/src/hash.ts:115`). It is the dedup key and
it is invariant under head edits by construction — `contentHash` locates the `<article>` first even
when handed whole-file bytes (`packages/html/src/hash.ts:169`). That invariance is what keeps
confidence decay, access bookkeeping, and every sleep stamp from looking like content changes. Without
it the nightly decay pass would present the whole corpus as new content and dedup would collapse.

A block element contributes a collapsible space at each edge (`packages/html/src/hash.ts:72`), so the
digest is a function of the article's words and not its indentation. Whitespace is preserved verbatim
only inside `<pre>` (`packages/html/src/hash.ts:31`), and the outer trim applies only to a leading or
trailing collapsible segment (`packages/html/src/hash.ts:120`) — so a `<pre>` whose text begins with
two spaces and the same `<pre>` without them are different digests, which is the difference a `<pre>`
exists to keep. U+00A0 is content, not whitespace (`packages/html/src/hash.ts:22`).

The git blob sha of the whole file is the indexer's change key. It is a separate thing, and the two
are never substituted for one another: a head-only edit moves the blob sha and not the content hash,
which is exactly the case the index's narrow write rules are built around.

## 4. Head edits go through byte-splice editors

`setMeta` (`packages/html/src/editors.ts:154`), `addLink` (`packages/html/src/editors.ts:216`), and
`readMeta` (`packages/html/src/editors.ts:261`) edit bytes rather than parsing and re-serializing. A
serializer round trip drops a `<pre>` newline, moving the content hash of every file a bookkeeping
pass touched (`packages/store/src/store.ts:417-419`).

## 5. Constraints, collected rather than short-circuited

Six numbered constraints run over the parsed tree (`packages/html/src/constraints.ts:29`), plus head
well-formedness and the meta-value rules. Violations are collected, never short-circuited, so one
parse tells an author everything wrong with the file
(`packages/html/src/constraints.ts:351`), and `InvalidMemory` carries them joined by `"; "`. A warning
never blocks a write.

1. **Exactly one `<article>`** (`packages/html/src/constraints.ts:115`), and **exactly one `<mark>`
   within it**, carrying non-empty text, positioned in the article's first `<p>`-or-`<li>` in document
   order (`packages/html/src/constraints.ts:165`, `packages/html/src/constraints.ts:193`). Emptiness is
   the `files.gist` rule verbatim — `canonicalText` with `excludeCode`, then trimmed
   (`packages/html/src/constraints.ts:146`) — so `<mark><code>drain --vip</code></mark>` is empty: it
   would pass the count and placement rules and land a committed, indexed file with an empty
   `files.gist`, invisible rather than merely wrong.
2. **Every `<time>` carries a `datetime` this format can sort**
   (`packages/html/src/constraints.ts:205`), narrower than HTML's own grammar because `files.event_at`
   and `files.due_at` are compared as strings.
3. **No `class`, no `style`, no `<script>`, no `<style>`, no `on*` handler**
   (`packages/html/src/constraints.ts:227`). Presentation belongs to a stylesheet, behaviour nowhere.
4. **Every head `<link rel="memhtml-*">` names a closed-vocabulary rel and a root-relative href**
   (`packages/html/src/constraints.ts:251`). A relative href would break on the first `git mv` of the
   source file, and `//host/x` would leave the repo.
5. **`<aside>` and `<details>` may not contain the `<mark>`**
   (`packages/html/src/constraints.ts:187`). The claim is never a caveat and never behind a fold.
6. **An element outside the closed vocabulary warns** (`packages/html/src/constraints.ts:320`), with
   warnings deduplicated by element name, so forty stray `<div>`s produce one actionable line.

A malformed *optional* meta value is dropped rather than failing the parse — a confidence outside
`[0, 1]`, an importance outside 1-10, a non-ISO timestamp (`packages/html/src/parse.ts:67`) — because
the omission and the `files` default are the graceful reading, and `memhtml doctor` reports the drop.
A duplicate `memhtml-type`, by contrast, is a violation rather than a last-wins pick: two writers
disagreeing about a memory's type should stop a write.

## 6. The render gate

`renderTemplate` (`packages/html/src/template.ts:203`) places the `<mark>` claim itself, so the
ordinary prose write path cannot violate the claim-leads-the-article constraint. But `articleHtml`
passes a caller's markup through verbatim (`packages/html/src/template.ts:120-123`), which is the
point of that surface — it is the only way `<time datetime>`, and so `files.event_at`, is reachable
from an agent.

So the store runs `checkMemory` (`packages/html/src/parse.ts:349`) over the *rendered bytes* and
refuses before anything is written (`packages/store/src/store.ts:455-462`). Without the gate a bad
file lands in a commit and the indexer then declines to project it: present in the tree, absent from
every search, visible only as a log line.

A batch does not soften this. Every op goes through the same render-then-reparse gate individually,
so one bad op in twenty is refused with its own violation list, and in the default atomic mode the
whole batch is refused before any file exists.

## 7. Fences and `data-lang`

A body paragraph that is a whole backtick fence becomes `<figure><pre><code>`
(`packages/html/src/fences.ts` owns the grammar; `packages/html/src/template.ts:102` renders it). An
info string naming the language wins outright and reaches `data-lang` verbatim, subject only to
`LANG_TOKEN`.

An unlabelled fence is auto-detected, propose-only, at write time (`packages/html/src/detect.ts`). The
detector is highlight.js `highlightAuto` over its full grammar set, scored as the per-line evidence
margin between the winning grammar and its closest real competitor —
`1 - exp(-(top - runnerUp) / lines)`, with `runnerUp` zeroed when it normalizes to the same language as
the winner, because `pgsql` beating `n1ql` is a dialect duel and not disagreement.

`data-lang` is stamped only when confidence reaches **0.30** and the detection lands in a closed
12-name vocabulary; otherwise the attribute is simply absent, because wrong metadata reaches `lang:`
entities and search while a missing attribute costs nothing. Both gates are independent: highlight.js
will name `smali` at confidence 0.86 for a bash snippet, and confidence says only "this grammar won by
a wide margin", never "this grammar is one we stamp".

Neither the threshold nor the formula is a guess. A 332-snippet corpus of real fences and file slices
was swept against an alternative detector, and the threshold is the point where measured precision
first reached a 95% floor: `0.28685957116771854`, precision 95.18%, coverage 25.0%. The deployed 0.30
is that point rounded in the safe direction — confidence is monotone in evidence, so a higher
threshold can only drop marginal stamps.

Fences longer than 4096 characters (`DETECT_MAX_CHARS`) abstain without running the detector at all:
`highlightAuto` runs 192 grammars synchronously with super-linear cost (measured about 20s of blocking
CPU at 40KB on the pinned build), and the write path shares one single-threaded process with every
other request.

Two properties follow, both enforced by tests. **Determinism:** highlight.js is pinned exactly
(`11.11.2`, no caret), because relevance scores are grammar-dependent and a version bump would
silently move every confidence and therefore which fences get stamped. **Rebuildability:** detection
runs only on the write path and the stamp is written into the file; index rebuild reads `data-lang`
back (`packages/html/src/parse.ts:301`) and never re-detects, so `rm index.db && rebuild` is a pure
function of the tree rather than of the installed highlight.js version. A grep lock over
`@memhtml/index`'s emitted bytes keeps it that way.

## 8. Task files

A task is one of the ten `memory_type` values (`packages/contracts/src/types.ts:18`) and an ordinary
memory file: one `<article>`, one `<mark>`, the same closed vocabulary, the same hash rules. It carries
two metas nothing else does. `memhtml-task-status` is `todo` | `doing` | `blocked` | `done`
(`packages/contracts/src/types.ts:82`), a separate axis from `memhtml-status`, which stays
`active`/`archived` for a task as for anything else. `memhtml-due` is a deadline, distinct from
`memhtml-valid-until`: that bounds when a remembered fact stops being true, this says when work is
late.

Two axes rather than four `memhtml-status` values, because `active`/`archived` is what every archive,
correction, and publish path switches on, and a fifth value there would silently change the meaning of
each of them. `done` is therefore not a resting state in this vocabulary's sense: finishing a task
stamps `done` *and* archives the file through the same `archiveMemory` machinery.

The parser enforces both directions of the coupling (`packages/html/src/parse.ts:166`). A `task` with
no `memhtml-task-status` is a violation, because it has no lifecycle position and every `--status`
filter would omit the very task the surface exists to show; a `memhtml-task-status` on any other type
is a violation too, because it asserts a lifecycle nothing advances.

The `<mark>` is the task statement — what "done" would mean — because that is what `files.gist` stores
and what every listing shows.
