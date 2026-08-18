---
title: The memory file format
description: A fixed HTML5 vocabulary where every element carries indexing meaning, two hashes with two separate jobs, and a validity check that runs before anything is written.
---

A memory is one fact in one file of standard HTML5, readable in view-source. The markup carries no
`class` attribute, and `<div>` and `<span>` appear only inside a `<figure>`. The set of elements the
format allows is fixed and listed in code (`packages/html/src/vocabulary.ts:145`); this page calls that
set the closed vocabulary. An element outside it produces a warning and never blocks a write. There is
no sanitizer, so the closed vocabulary is the whole of the policy, and `checkDocument` reports what it
finds without throwing and without repairing anything (`packages/html/src/constraints.ts:351`).

## 1. The machine plane

The document head carries a flat namespace of `memhtml-*` tokens, hyphenated rather than
colon-prefixed. A `rel` token cannot contain a colon, and the same naming has to work for
`<link rel="memhtml-supersedes">` as for a `<meta name>` (`packages/contracts/src/edges.ts:101-110`).
A key that may appear more than once appears as a repeated element, so correcting one tag produces a
one-line diff.

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

Four metas are required: `memhtml-type`, `memhtml-status`, `memhtml-created`, and `memhtml-updated`
(`packages/html/src/vocabulary.ts:35`). The rest are optional, and the index's `files` table owns their
defaults, so omitting one completes the row rather than refusing the write.

Exactly two names may repeat, `memhtml-entity` and `memhtml-tag`
(`packages/html/src/vocabulary.ts:20`), one value per element. Stating any other name twice is a
violation (`packages/html/src/constraints.ts:302`). `memhtml-content-hash` is advisory: the parser
reports whatever the file says and never recomputes it (`packages/html/src/document.ts:37`), so a stale
value stays visible instead of being quietly reconciled.

`META_ORDER` (`packages/html/src/vocabulary.ts:42`) is both the closed list of meta names and the
order the serializer emits them in (`packages/html/src/serialize.ts:83`), which makes it a
diff-stability contract. A new scalar meta is
appended at the end of the scalar block, because inserting one mid-list would shift every following
line in every file the next edit touches. The surgical head editors insert in the same order
(`packages/html/src/editors.ts:79`).

## 2. The human plane with machine hooks

Each element in the closed vocabulary earns its place by carrying indexing meaning: structure that
Markdown cannot express and that the index consumes mechanically.

| Element | Meaning | Indexer semantics |
|---|---|---|
| `<article>` | the memory; exactly one, and the scope the content hash covers | text becomes `files.body_text` (`packages/index/src/project.ts:160`), which drives `fts_text`, `word_count`, and the embedding chunks |
| `<mark>` | the claim, the one span the memory turns on | `packages/html/src/parse.ts:289` fills `files.gist`, the first `fts_text` field after the title, the first `disclosure_text` line, and the span a correction targets |
| `<time datetime>` | when the fact happened, as distinct from when it was written | the first one in document order fills `files.event_at` (`packages/html/src/parse.ts:284`); the recency ranker sorts on `coalesce(event_at, updated_at)` |
| `<dl>/<dt>/<dd>` | structured facets | positional pairs become `file_facets(path, name, value)` rows; one `<dt>` may govern several `<dd>`s and each becomes its own row |
| `<data value>` | a machine value beside the human phrasing | the first `<data value>` inside a `<dd>`, read as a finite number, fills `file_facets.numeric_value` (`packages/html/src/parse.ts:261`). It carries no unit; the unit lives in the prose |
| `<cite>`, `<q cite>` | where the fact came from | rows in `file_citations` (`packages/html/src/parse.ts:272`), with the `cite` URI going into `file_citations.href` |
| `<dfn>` | the term a semantic memory defines | promotes to a `concept:<term>` entity row (`packages/html/src/parse.ts:293`) |
| `<details>/<summary>` | elaboration behind a fold | `<summary>` reaches `disclosure_text`; the body is searchable through `body_text` and is never quoted back |
| `<aside>` | a scope caveat that is not the claim | searchable through `body_text`, and absent from `disclosure_text` (`packages/index/src/project.ts:61`) |
| `<code data-lang="ts">` | the snippet's language | promotes to a `lang:ts` entity (`packages/html/src/parse.ts:305`), lowercased. Never `class`, never `lang=` |
| `<pre>`, `<code>`, `<kbd>`, `<samp>`, `<var>` | technical content | all text reaches `body_text`; `<pre>` and `<code>` are excluded from `gist`; only `<pre>` preserves whitespace in the hash |
| `<div>`, `<span>` | containers a pasted sample brings with it | permitted under a `<figure>` only; elsewhere they warn (`packages/html/src/vocabulary.ts:142`) |

## 3. Two hashes, two jobs

`memhtml-content-hash` is a `sha256` digest over the whitespace-normalized text of `<article>` alone,
with `<pre>` taken verbatim (`packages/html/src/hash.ts:7-19`, `packages/html/src/hash.ts:115`). It is
the key that detects duplicate content, and head edits cannot move it: `contentHash` locates the
`<article>` first even when handed the bytes of a whole file
(`packages/html/src/hash.ts:169`). That property is what keeps confidence decay, access bookkeeping,
and every stamp the nightly pipeline writes from looking like a content change. Without it the nightly
decay pass would present the whole corpus as new content, and duplicate detection would collapse.

A block element contributes one collapsible space at each of its edges
(`packages/html/src/hash.ts:72`), so the digest depends on the article's words and not on its
indentation. Whitespace is preserved exactly inside `<pre>` (`packages/html/src/hash.ts:31`), and the
outer trim applies only to a leading or trailing collapsible segment
(`packages/html/src/hash.ts:120`). A `<pre>` whose text begins with two spaces therefore hashes
differently from the same `<pre>` without them, which is the distinction a `<pre>` exists to keep.
U+00A0 counts as content rather than as whitespace (`packages/html/src/hash.ts:22`).

The git blob sha of the whole file is a second hash, and it is the indexer's key for deciding what
changed. The two are never substituted for one another. A head-only edit moves the blob sha and leaves
the content hash where it was, and that case is what the index's narrow write rules are built around.

## 4. Head edits go through byte-splice editors

`setMeta` (`packages/html/src/editors.ts:154`), `addLink`
(`packages/html/src/editors.ts:216`), and `readMeta` (`packages/html/src/editors.ts:263`) edit bytes
directly instead of parsing the file and serializing it again. A serializer round trip drops a newline
inside a `<pre>`, which would move the content hash of every file a bookkeeping pass touched
(`packages/store/src/store.ts:417-419`).

## 5. The checker collects every violation

Six numbered constraints run over the parsed tree (`packages/html/src/constraints.ts:29`), alongside
checks on head well-formedness and on meta values. The checker collects every violation instead of
stopping at the first, so one parse tells an author everything that is wrong with the file
(`packages/html/src/constraints.ts:351`), and `InvalidMemory` carries the list joined by `"; "`. A
warning never blocks a write.

1. Exactly one `<article>` (`packages/html/src/constraints.ts:115`), and exactly one `<mark>` inside
   it, carrying non-empty text, positioned in the article's first `<p>` or `<li>` in document order
   (`packages/html/src/constraints.ts:165`, `packages/html/src/constraints.ts:193`). Emptiness is
   tested by the same rule that fills `files.gist`, namely `canonicalText` with `excludeCode` and then
   a trim (`packages/html/src/constraints.ts:146`). So `<mark><code>drain --vip</code></mark>` counts
   as empty. It would satisfy the count and placement rules and land a committed, indexed file whose
   `files.gist` is blank, which makes the memory invisible to search rather than merely wrong.
2. Every `<time>` carries a `datetime` this format can sort
   (`packages/html/src/constraints.ts:205`). The rule is narrower than HTML's own grammar because
   `files.event_at` and `files.due_at` are compared as strings.
3. No `class`, no `style`, no `<script>`, no `<style>`, and no `on*` handler
   (`packages/html/src/constraints.ts:227`). Presentation belongs to a stylesheet, and behavior
   belongs nowhere in a memory file.
4. Every head `<link rel="memhtml-*">` names a rel from the closed vocabulary and a root-relative
   href (`packages/html/src/constraints.ts:251`). A relative href would break on the first `git mv` of
   the source file, and a protocol-relative `//host/x` would point outside the repository.
5. Neither `<aside>` nor `<details>` may contain the `<mark>`
   (`packages/html/src/constraints.ts:187`), so the claim is never stated as a caveat and never hidden
   behind a fold.
6. An element outside the closed vocabulary warns (`packages/html/src/constraints.ts:320`). Warnings
   are deduplicated by element name, so forty stray `<div>`s produce one actionable line.

A malformed value on an optional meta is dropped rather than failing the parse. That covers a
confidence outside `[0, 1]`, an importance outside 1 to 10, and a timestamp that is not ISO-8601
(`packages/html/src/parse.ts:67`). Dropping is the graceful reading, because omission plus the `files`
default is a usable row, and `memhtml doctor` reports the drop. A duplicate `memhtml-type` is treated
as a violation instead of a last-value-wins pick, because two writers disagreeing about a memory's
type should stop the write.

## 6. The render gate

`renderTemplate` (`packages/html/src/template.ts:203`) places the `<mark>` claim itself, so the
ordinary prose write path cannot produce a file that breaks the claim-leads-the-article rule. The
`articleHtml` surface passes a caller's markup through unchanged
(`packages/html/src/template.ts:120-123`), which is what that surface is for: it is the only route by
which an agent can write `<time datetime>`, and so the only route to `files.event_at`.

The store therefore runs `checkMemory` (`packages/html/src/parse.ts:349`) over the rendered bytes and
refuses before writing anything (`packages/store/src/store.ts:455-462`). Without that check a bad file
would land in a commit and the indexer would then decline to project it, leaving a memory present in
the tree, absent from every search, and visible only as a log line.

A batch write gets the same treatment. Each operation goes through render-then-reparse individually, so
one bad operation out of twenty is refused with its own list of violations, and in the default atomic
mode the whole batch is refused before any file exists.

## 7. Fences and `data-lang`

A body paragraph that consists of a whole backtick fence becomes `<figure><pre><code>`
(`packages/html/src/fences.ts` owns the grammar, and `packages/html/src/template.ts:102` renders it).
An info string naming the language wins outright and reaches `data-lang` unchanged, subject only to
`LANG_TOKEN`.

An unlabelled fence goes to a detector at write time (`packages/html/src/detect.ts`). The detector
proposes a language and never overrides one the author gave. It runs highlight.js `highlightAuto`
over that library's full grammar set and scores the result as the per-line evidence margin between
the winning grammar and its closest real competitor: `1 - exp(-(top - runnerUp) / lines)`.
`runnerUp` is zeroed when it normalizes to the same language as the winner, because `pgsql` beating
`n1ql` is one language under two grammar names.

`data-lang` is stamped only when confidence reaches 0.30 and the detected language is one of a closed
12-name vocabulary. Otherwise the attribute is absent, because a wrong value reaches `lang:` entities
and search while a missing attribute costs nothing. The two gates are independent of each other:
highlight.js will name `smali` at confidence 0.86 for a bash snippet, so confidence says only that one
grammar won by a wide margin and says nothing about whether that grammar is one worth stamping.

Both the threshold and the formula come from a measurement. A 332-snippet corpus of real fences and
file slices was swept against an alternative detector, and the threshold is the point where measured
precision first reached a 95% floor: `0.28685957116771854`, precision 95.18%, coverage 25.0%. The
deployed 0.30 is that point rounded upward, which is the safe direction, because confidence rises
monotonically with evidence and a higher threshold can only drop marginal stamps.

A fence longer than 4096 characters (`DETECT_MAX_CHARS`) abstains without running the detector.
`highlightAuto` runs 192 grammars synchronously and its cost grows faster than linearly with input
size: about 20s of blocking CPU at 40KB on the pinned build. The write path shares one single-threaded
process with every other request, so a fence that large would stall all of them.

Two properties follow, each enforced by a test. Detection is deterministic because highlight.js is
pinned exactly, to `11.11.2` with no caret. Relevance scores depend on the grammar set, so a version
bump would move every confidence value and silently change which fences get stamped. The index stays
rebuildable because detection runs on the write path only and the result is written into the file. An
index rebuild reads `data-lang` back (`packages/html/src/parse.ts:301`) and never re-detects, so
`rm index.db && rebuild` is a function of the tree alone rather than of the installed highlight.js
version. A grep over `@memhtml/index`'s emitted bytes keeps it that way.

## 8. Task files

A task is one of the ten `memory_type` values (`packages/contracts/src/types.ts:18`) and an ordinary
memory file in every other respect: one `<article>`, one `<mark>`, the same closed vocabulary, the same
hash rules. It carries two metas nothing else carries. `memhtml-task-status` takes `todo`, `doing`,
`blocked`, or `done` (`packages/contracts/src/types.ts:82`), on an axis separate from
`memhtml-status`, which stays `active` or `archived` for a task exactly as for anything else.
`memhtml-due` is a deadline, which is a different question from `memhtml-valid-until`: the deadline
says when work is late, and `memhtml-valid-until` bounds when a remembered fact stops being true.

Two axes are cheaper here than four `memhtml-status` values. Every archive, correction, and publish
path switches on `active` versus `archived`, so adding a fifth value there would change the meaning of
each of them at once. Finishing a task therefore stamps `done` and archives the file through the same
`archiveMemory` machinery, rather than leaving `done` as a resting state in the lifecycle vocabulary.

The parser enforces the coupling in both directions (`packages/html/src/parse.ts:166`). A `task` with
no `memhtml-task-status` is a violation, because it has no position in the lifecycle and every
`--status` filter would omit the very task the surface exists to show. A `memhtml-task-status` on any
other type is also a violation, because it asserts a lifecycle that nothing advances.

The `<mark>` on a task holds the task statement, meaning what "done" would consist of. That is what
`files.gist` stores and what every listing displays.
