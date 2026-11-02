# RFC 0004: Checking references written in prose

- Status: Draft
- Created: 2026-10-25
- Applies to: memhtml 0.17.0 (68697d5)
- Related: RFC 0001, RFC 0003

## Summary

Writers point at other records from the article: a `[[slug]]` token, a store path, an `<a href>`, or a sentence saying the record replaces another. No tool reads these references, so they go stale silently when the target moves or is archived, and a supersede stated only in prose leaves the old record active. This RFC adds a read-only check that reports them in `memhtml doctor` and the curator briefing, with `link` suggestions that land only after a read of both records.

## Motivation

A store holds four records about a made-up `project:orchard-lamp`:

| id | path                                                                | claim                                                                  |
| -- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| R1 | `resources/orchard-lamp/request-ceiling.html`                       | The request ceiling of the orchard-lamp API is 50 requests per second. |
| R2 | `areas/inbox/release-checklist.html`                                | An orchard-lamp release needs a signed changelog.                      |
| R3 | `projects/orchard-lamp/load-test-plan.html`                         | The orchard-lamp load test peaks at 40 requests per second.            |
| R4 | `resources/orchard-lamp/request-ceiling-after-the-plan-change.html` | The request ceiling of the orchard-lamp API is 20 requests per second. |

R3 and R4 came through the prose path of `session put`, so their writers authored no `<link>`:

```html
<!-- R3 --><p>... It stays under the ceiling in [[request-ceiling]]. Run it after the steps in `areas/inbox/release-checklist.html`.</p>
<!-- R4 --><p>... This replaces [[request-ceiling]]: the provider lowered the ceiling.</p>
```

A scheduled curate run then moves R2 to `resources/orchard-lamp/release-checklist.html`, the home the inbox rule computes from its entity (`packages/curator/src/inbox.ts:32`). Now R3 names a file that is gone, and R1 stays active though R4 replaces it: the commit linked R4 `contradicts` R1, since the claims share a frame key, and kept both live (`docs/design.md:507`). Nothing in 0.17.0 reports either problem.

## Current behavior

- **Edges are head links.** `readLinks` and `parseMemory` read `<head>` only (`packages/html/src/editors.ts:272-289`, `packages/html/src/parse.ts:277-288`), and `inbound` and the `edges` rows come from those links (`packages/head/src/indexes.ts:108-109`, `packages/index/src/project.ts:359-363`). An article `<a href>` is prose with no field (`docs/format.md:88`). A search of `packages/` and `apps/` for `[[` finds no reader of article text (inference), only array literals, test data and two unrelated matchers, one for TOML (`packages/integrations/src/adapters/toml.ts:36-40`).
- **Move.** `withRepoints` repoints only holders that `view.inbound` names (`packages/session/src/moves.ts:21-60`), and `validateOps` refuses only a head edge left on the old path (`packages/session/src/validate.ts:457-487`).
- **Supersede.** The briefing's `supersededActive` (`packages/curator/src/briefing.ts:268-272`) and the head gate's inversion check (`packages/head/src/gate.ts:159-166`) read `supersedes` head links.
- **Repair.** Doctor joins `edges` to `files` (`apps/cli/src/repair.ts:85-94`), and `--fix` edits head lines only (`apps/cli/src/doctor.ts:78-82`). `danglingEdges` walks `record.links` and names the target's archived form and the first active record superseding it (`packages/curator/src/briefing.ts:259-267`, `:359-367`), which charter priority 8 links (`packages/curator/prompts/charter.md:34`).
- **Resolve.** `memhtml resolve` follows `supersedes` and `archive_move` only (`apps/cli/src/operations.ts:1424-1429`), so a moved path answers `unindexed` (`apps/cli/src/operations.ts:1556-1568`).
- **Why prose.** A `session put` write line has no links field (`apps/cli/src/apply.ts:37-54`).

Two gaps exist already. `contradictions` reads frame-key values alone (`packages/curator/src/briefing.ts:310-330`), so a record that an active one supersedes with the same key and a different value sits under `contradictions`, which priority 1 keeps live (`packages/curator/prompts/charter.md:27`), and under `supersededActive`, which priority 3 archives (`packages/curator/prompts/charter.md:29`). Once it is archived, the superseder's `contradicts` edge dangles with the superseder as `successor` (`packages/curator/src/briefing.ts:362-365`), and priority 8 would link a record to itself, which `validateOps` allows (`packages/session/src/validate.ts:326-347`) and the projection drops silently (`packages/index/src/project.ts:361`).

## Proposal

### 1. What counts as a reference

The rule is conservative, since a false finding costs attention every run. Only `<article>` is scanned.

```
reference  := wiki | path | href
wiki       := "[[" target ( "|" label )? "]]"
target     := slug | store-path | store-path without ".html"
slug       := [a-z0-9]+ ( "-" [a-z0-9]+ )*           isSlug, slug.ts:47-48
label      := 1 to 80 characters, none of "]", "|" or a line break
store-path := "/"? bucket "/" segment ( "/" segment )* ".html"
              whose normal form passes memoryPathViolation (paths.ts:83-101)
bucket     := "projects" | "areas" | "resources" | "archive"
segment    := [A-Za-z0-9_] [A-Za-z0-9._-]*
path       := a store-path in text, after the start, whitespace or one of ( [ " ' `
              and before the end, whitespace, one of ) ] " ' ` , or one of . ; : ! ?
              followed by whitespace or the end;
              or the whole trimmed text of an inline <code>, <kbd>, <samp> or <var>
href       := an <a href> or <q cite> value that is a store-path, "#fragment" dropped;
              a value holding "?" is not one
```

Every `<pre>` is skipped: it holds commands and data, and a TOML array header such as `[[lamp-wicks]]` is slug-shaped. Inline code yields a `path` only as its whole text, as the gist rule treats `code` as code (`packages/html/src/vocabulary.ts:229`).

Spans are claimed in the order wiki, href, path, so one span yields one reference: text inside a wiki token yields no `path`, and the text of an `<a>` or `<q>` whose `href` or `cite` yielded a reference yields no `path` for that target.

A **supersede phrase** gives a reference the intent `supersedes`, not `mention`, matched without case. Its **object** is the reference, optionally after `the` or `its` and up to three words that are not prepositions (`about at by for from in into of on over to under with`), the last of which may end in a comma. A word is a run of `[A-Za-z0-9'-]`, and words are separated by whitespace, so any other mark, such as `;`, ends the object. Only the sentence end, `:` or `,` may follow the reference. Three shapes count:

1. `this`, an optional `record`, `note`, `memory`, `file`, `entry` or `version`, then directly `supersedes` or `replaces`, then the object.
2. A sentence opening with `Supersedes` or `Replaces`, an optional `:`, then the object.
3. A `<dt>` whose whole text is `Supersedes` or `Replaces`: every reference in its `<dd>`s, the format's facet form (`docs/format.md:77`).

So "This version replaces the older ceiling, [[request-ceiling]]." matches, and "This does not replace [[request-ceiling]]", "This replaces nothing; see [[request-ceiling]]" and "This replaces the step in [[request-ceiling]]" do not. Text in `<q>` is someone else's words and yields no phrase. Sentences split at block boundaries and on `.`, `!` or `?` before whitespace.

### 2. The extractor: `proseRefs` in `@memhtml/html`

```ts
// packages/html/src/refs.ts
export interface ProseRef {
  readonly kind: "wiki" | "path" | "href"
  readonly intent: "mention" | "supersedes"
  readonly raw: string // as written
  readonly target: { readonly slug: string } | { readonly path: string } // no leading slash or fragment
  readonly start: number // half-open span of `raw` in the file's string
  readonly end: number
  readonly line: number
  readonly context: string // the nearest enclosing article element
}
export const proseRefs = (html: string): ReadonlyArray<ProseRef> // document order, pure, total
```

It is tolerant as `readLinks` is (`packages/html/src/editors.ts:272-278`): it validates nothing, and malformed input yields `[]`. Offsets come from the parse the head editors use (`packages/html/src/tree.ts:18-24`). Where a text node holds a character reference, the extractor walks its source beside the decoded text, counting the reference as the UTF-16 code units it decodes to, so a token's span comes from its decoded position, never from a search that could find an earlier copy.

### 3. The resolver: `resolveProseRefs` in `@memhtml/session`

A new module, `packages/session/src/refs.ts`, works over a `HeadView`; doctor and the curator may import it (`docs/design.md:30`):

```ts
export interface RemovalHistory {
  readonly removed: ReadonlyMap<string, string> // path -> hash of the article last removed there
  readonly complete: boolean // false when the window stopped at its bound or the clone is shallow
}
export interface ResolvedRef extends ProseRef {
  readonly source: string
  readonly resolution: "live" | "history" | "archived" | "moved" | "missing" | "ambiguous"
  readonly resolved: string | null // live path, archived path, or move destination
  readonly successor: string | null // live end of the supersedes chain, when it differs
  readonly steps: ReadonlyArray<{ readonly from: string; readonly to: string; readonly via: "archive_move" | "move" | "supersedes" }>
  readonly candidates: ReadonlyArray<string> // active matches, for `ambiguous`
  readonly linked: boolean // see section 5
  readonly historyChecked: boolean // false for `missing` with no or incomplete history
}
export const resolveProseRefs = (view: HeadView, source: string, refs: ReadonlyArray<ProseRef>, history?: RemovalHistory): ReadonlyArray<ResolvedRef>
```

| reference                               | rule, first match wins                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path `P`, active                        | `live`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| path `P` under `archive/`, held         | `history`, cited on purpose, as a `supersedes` link cites an archive (`packages/session/src/validate.ts:334-336`)                                                                                                                                                                                                                                                                                                                                              |
| path `P`, some `archive/<YYYY>/P` held  | `archived`, the newest, as the briefing finds it (`packages/curator/src/briefing.ts:274-281`)                                                                                                                                                                                                                                                                                                                                                                  |
| path `P` in `history.removed`, hash `H` | among all holders of `H`, one active gives `moved`; none active and one archived gives `archived` via `move`, `archive_move`; else `missing`                                                                                                                                                                                                                                                                                                                   |
| path `P`, otherwise                     | `missing`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| slug `S`                                | stem matches (`packages/contracts/src/slug.ts:2`) at the nearest level holding one: the source's directory, then its topic (each `<bucket>/<name>/` whose `<name>` is the source's second segment), then the store. One active match gives `live`, more give `ambiguous`. At the first two levels, a level with no active match takes its newest archived match by `originalPathFor` (`packages/contracts/src/paths.ts:225-229`) as `archived`. Else `missing` |
| wiki with a path target                 | as a path, `.html` appended when absent                                                                                                                                                                                                                                                                                                                                                                                                                        |

The topic level follows the inbox rule, which homes records by entity name and keeps filenames (`packages/curator/src/inbox.ts:32`, `:194-205`), so a subject's records share a second segment (inference). A store-wide archived match would follow a filename coincidence.

A move keeps the article's hash (`packages/contracts/src/record.ts:74-75`). The resolver maps each hash to all its holders, since `byContentHash` keeps the first active one (`packages/head/src/indexes.ts:102-105`), and it drops a reference to its own source.

From `resolved`, it walks `supersedes` forward to `successor`, preferring an active superseder, then sort order, within `memhtml resolve`'s bounds: a visited set and `RESOLVE_MAX_HOPS` (`apps/cli/src/operations.ts:1394`, `:1546`, `:1577`). That command breaks ties by the newest edge (`apps/cli/src/operations.ts:1493-1495`); a view cannot, since its links carry only rel and href (`packages/head/src/record.ts:56`). The briefing calls the same helper, `successorOf(view, path, maxHops)`, with `maxHops: 1`, so `danglingEdges` stays one hop.

### 4. The removal history, in `apps/cli`

`removalHistoryAt(root, sha, bound)` depends on its commit and bound alone. It reads the newest `bound` commits reachable from `sha`, as `git rev-list -n <bound> <sha>` lists them, through `git log --no-walk=unsorted --stdin --no-renames --raw --no-abbrev --format=%H`, and keeps the `D` lines under `projects/`, `areas/` and `resources/`; the newest removal of a path wins. It passes no pathspec, which makes git diff every commit to simplify history. `git cat-file --batch` reads each removed blob once for its content hash (`packages/html/src/hash.ts:153-156`). `complete` is false when `rev-list -n <bound + 1>` lists one more commit, or when `git rev-parse --is-shallow-repository` prints `true`: a shallow clone ends the list early and exits 0.

A cache in `.memhtml/prose-refs/` memoizes each commit's removals by commit id, for the last window only. A commit's diff never changes, so a run diffs only listed commits the cache lacks. It reads only entries for commits `rev-list` lists from `sha`, each of which passes `git merge-base --is-ancestor <entry> <sha>`, so an entry from a replayed or dropped curate branch is never read, and runs at one commit and bound agree whatever their caches hold. The cache also keeps `proseRefs` output by `blobSha` (`packages/contracts/src/record.ts:27-28`), not by content hash, which covers normalized text (`docs/format.md:104`) and so cannot pin offsets.

The directory joins `V2_IGNORE_PATTERNS` (`packages/store/src/layout.ts:62-73`), and its writer passes it to `ensureExcludedQuietly` (`packages/session/src/exclude.ts:12-18`, `:78-92`). Both writes are best effort: a failed one logs a warning, and the check reports from memory.

On synthetic `git fast-import` repositories (one run each, so read the figures as orders of magnitude), the newest 2,000 of 20,000 commits into one directory, where each diff reads the wide tree, took under 2 s (all of them, 8 to 9 s; all 10,000 commits over 100 directories, 0.2 s), and the `rev-list` alone about 10 ms.

Under `curate run --resume`, the view holds overlay moves that git lacks (`apps/cli/src/curate-run.ts:608`), so the binder adds them to `removed` first.

### 5. Findings and suggestions

A **finding** is reported only where a head link could clear it. So none comes from an archived source, which takes no head op (`packages/session/src/validate.ts:328-330`), or from a task, which takes no memory rel and keeps its article (`docs/format.md:164`, `docs/design.md:493`). None comes from a reference whose `resolved`, `successor` or a candidate is a task (`memoryType`, `packages/contracts/src/record.ts:33`), since a memory rel refuses a task at either end, or whose `successor` is its own source, which already replaced the target.

`linked` is true when the source's head links, by any rel, `resolved`, `successor`, a record on `steps`, or, for `ambiguous`, one of `candidates`.

| finding              | intent       | when                                                                                              |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `missing`            | either       | that resolution                                                                                   |
| `ambiguous`          | either       | that resolution, and `linked` false                                                               |
| `archived`, `moved`  | `mention`    | that resolution, and `linked` false                                                               |
| `unlinked_supersede` | `supersedes` | `live` or `moved`, and no `supersedes` link to `resolved`; a spliced `contradicts` does not count |

```ts
export type ProseRefFinding =
  Pick<ResolvedRef, "line" | "kind" | "intent" | "successor" | "candidates" | "historyChecked"> & {
    readonly path: string // the source
    readonly raw: string // a wiki token loses its label: `[[request-ceiling]]`
    readonly finding: "missing" | "archived" | "moved" | "ambiguous" | "unlinked_supersede"
    readonly target: string | null // `resolved`, else the written path
  }
export interface LinkSuggestion {
  readonly op: Extract<OverlayOp, { readonly kind: "link" }>
  readonly basis: "mention" | "supersede-phrase"
  readonly raw: string
  readonly line: number
}
export const suggestLinks = (view: HeadView, resolved: ReadonlyArray<ResolvedRef>): ReadonlyArray<LinkSuggestion>
```

A **suggestion** turns a finding into a head edge, which `withRepoints` and the dangling repair then keep.

- An `archived` or `moved` finding links `successor`, else `resolved`: `about_person` for a target under `resources/people/` (`packages/contracts/src/edges.ts:34-35`), else `relates_to`, the most generic memory rel (`packages/contracts/src/edges.ts:19-29`).
- An `unlinked_supersede` links `supersedes` to `resolved`, never the successor: the record replaces what it named.
- Nothing else gets one, nor does a source under `resources/people/`, which is outside the curator's mandate (`packages/curator/prompts/charter.md:28`). `suggestLinks` also refuses a task at either end and a link to the source itself, since `validateOps` checks neither edge classes nor self-links (`packages/session/src/validate.ts:326-347`). Suggestions are deduplicated on `(path, rel, href)` and sorted.

Every suggestion is a guess. A landed `relates_to` or `supersedes` suggestion is a full-strength memory edge (`packages/index/src/project.ts:366-368`) that PageRank, MMR and the retention bridge count read (`docs/design.md:87`), and `supersedes` also gates the contested signal (`packages/contracts/src/edges.ts:14-17`); an `about_person` one is a person edge. So **no suggestion lands without a read of both records**, except under `--model fake`, the scripted test model, which applies each as it handles dangling links (`docs/design.md:929`), on a branch that still needs `curate merge` (`docs/design.md:287`). An RFC 0001 recipe that runs no model may not apply one.

### 6. `memhtml doctor`

Doctor gains an eleventh check, over each active record's `html` (`packages/contracts/src/record.ts:46`) at `HEAD` through `loadHeadAt` (`apps/cli/src/v2.ts:213-217`). New `DoctorReport` fields, each always present (`apps/cli/src/doctor.ts:153`):

```ts
readonly proseRefsAt: string | null // the commit read
readonly proseRefs: ReadonlyArray<ProseRefFinding> // by path, then offset, cut at PROSE_REF_SAMPLE
readonly proseRefTotals: Readonly<Record<ProseRefFinding["finding"], number>> // uncapped
readonly proseRefHistoryComplete: boolean
readonly proseLinkSuggestions: ReadonlyArray<LinkSuggestion> // [] without --suggest-links
readonly proseLinkSuggestionsTotal: number // 0 without it
```

The flag `--suggest-links` (default `false`) fills the suggestion list and writes nothing. `--fix` leaves prose references alone, since it repairs only what needs no judgment (`apps/cli/src/doctor.ts:78-91`). `healthy` leaves the check out, on the untyped-entity precedent: a bare entity name is a supported form, and gating on it would turn a hand-authored corpus red (`apps/cli/src/doctor.ts:650-653`).

### 7. The briefing and the charter

`Briefing` gains `proseRefs`, `proseLinkSuggestions` and their totals, cut at `BRIEFING_GROUP_CAP` (`packages/curator/src/briefing.ts:207`). The history arrives as `BriefingOptions.proseRefHistory`, as `neighborsOf` does (`packages/curator/src/briefing.ts:145-146`), from the binder at `apps/cli/src/curate-run.ts:611-619`, so `briefingFromView` stays pure (`packages/curator/src/briefing.ts:236-239`). The only new record text is `raw`, a token or a path.

Two code changes close the gaps above. A contradiction group drops a member that an active member supersedes, then any group left with one value. `danglingEdges` never names an edge's own source as `successor`.

The charter's "Five more lists" (`packages/curator/prompts/charter.md:15`) becomes seven, and three priorities gain a sentence:

- Priority 1: "A pair joined by an authored `supersedes` edge is settled; the briefing lists it under `supersededActive` instead."
- Priority 3: "When you archive a record from `supersededActive`, also `unlink` each `contradicts` edge its `by` records carry to it, in the same proposal."
- Priority 8: "Then take `proseLinkSuggestions`, reading the source and the target first. Link a `mention` suggestion only when the reference plainly means that record, an `about_person` one only when the article is about that person, and a `supersede-phrase` one only when the article says it replaces the target. Never put a new article to change the prose."

### 8. Optional: notes at write time

`PreparedPuts` (`apps/cli/src/v2.ts:472-488`) gains `notes: ReadonlyArray<ProseRefFinding>`, computed per put over the session's view (`apps/cli/src/v2.ts:533`) and printed beside the neighbors. A note never blocks. Write time reads no history, so an unheld path is `missing`, `historyChecked: false`. The head server runs `preparePuts` too (`apps/cli/src/v2.ts:510-512`), so `NeighborsAnswer` (`apps/cli/src/head-protocol.ts:629-645`) gains an optional `notes`, and an older server's answer still decodes. `session exec` notes its harvested puts the same way.

### 9. Bounds

| bound                                       | value         | reason                                                                                                                                                                        |
| ------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| briefing lists; doctor's `PROSE_REF_SAMPLE` | 50            | the existing `BRIEFING_GROUP_CAP`; for doctor a chosen default, not measured, so both surfaces page alike                                                                     |
| doctor suggestion list                      | 200           | chosen default, not measured: `BATCH_CAP` (`docs/design.md:495`), the most one session could take, though each suggestion still needs a read                                  |
| `PROSE_REF_HISTORY_COMMITS`                 | 2,000 per run | chosen default, not measured on any store: under two seconds on the widest synthetic fixture, and a count, unlike a clock, keeps history a function of the commit (section 4) |
| successor walk                              | 16 hops       | the existing `RESOLVE_MAX_HOPS`                                                                                                                                               |
| wiki label                                  | 80 characters | chosen default, not measured: `SLUG_MAX_LENGTH` (`packages/contracts/src/slug.ts:8`), a short title's room, so a stray `[[` cannot swallow a paragraph                        |
| object gap                                  | 3 words       | chosen default, not measured: fits "the older ceiling", not a second clause                                                                                                   |
| references per file                         | none          | totals stay exact, at a cost linear in text                                                                                                                                   |

## Invariants and safety

- **The head stays the only edge plane.** No index, view index or retrieval arm reads prose references, and `rm index.db && rebuild` is unchanged.
- **Nothing a commit sees is written.** Doctor and `curate run` write only a gitignored cache, disposable like the index (`docs/design.md:7`). A suggestion lands only as a `link` op that `validateOps` judges, whose target is in the view (`packages/session/src/validate.ts:339-342`) and which moves no content hash (`docs/format.md:104`).
- **No write is refused, and no guess acts alone.** Notes are not violations, and every suggestion needs a read, except under `--model fake` (section 5).
- **No self-links.** Neither the resolver, `suggestLinks` nor `danglingEdges` ever offers to link a record to itself (sections 3, 5 and 7).
- **Deterministic and bounded.** One view and one history give the same sorted bytes, the history depends only on commit and bound, every list has a section 9 bound, and every cut list carries its total.

## Compatibility and migration

- No format change, migration, index change or config key. `doctor.report`, the briefing and `NeighborsAnswer` gain fields and lose none.
- Two existing briefing fields change behavior (section 7): `contradictions` loses superseded members, and `danglingEdges[].successor` is `null` where 0.17.0 named the edge's own source.
- An existing store gains one line in `.git/info/exclude`, never in its committed `.gitignore`. A failed write only warns (section 4).
- A first run reports every stale reference at once, sampled, with totals.

## Alternatives considered

**Make prose references a second edge source.** The strongest alternative projects them into `inbound` and `edges`, so every existing pass sees them. It loses twice.

- The passes could see these edges but not repair them: every repair is a head op, and changing the article is a claim edit (`packages/contracts/src/record.ts:69-70`). Worse (inference), the move rule (`packages/session/src/validate.ts:457-487`) would refuse to move a record a prose mention names, with no op to clear it.
- The head is the edge plane (`docs/code-mode.md:13`), with authored edges in the HTML and derived ones in the index (`docs/design.md:83`). A guessed edge would need its own class and a filter in every memory-graph query to stay out of ranking (`docs/design.md:87`); without them, it would feed ranking and the gate unread.

**Rewrite the prose when the target moves.** That edits active claims in place, which a session never does (`packages/contracts/src/record.ts:69-70`).

**Link at write time.** This asserts relationships nobody chose and checks no existing record.

**Refuse through the write bar.** This breaks hand-authored stores and the rule that a warning never blocks a write (`docs/format.md:108`).

**Leave it to code-mode scripts.** Each would rederive the grammar, and doctor would show nothing.

## Open questions

1. Should `[[Request ceiling]]` resolve through `slugify`, as paths come from titles (`packages/contracts/src/paths.ts:194-204`)?
2. Should `<a href="wiki:<slug>">` count? The format tolerates such links, with a warning (`docs/format.md:112`).
3. Should a store be able to count findings toward `healthy`? A policy key would make an older binary refuse the config (`docs/design.md:629`).
4. Should the English verbs be configurable, or the `Supersedes` facet be the documented form?
5. Should task sources get their own report, and may a store acknowledge a `missing` reference without a correction?

Out of scope, for a follow-up RFC on `memhtml resolve` that can reuse `removalHistoryAt`: a `move` hop, and its stale comment that nothing else renames a file (`apps/cli/src/operations.ts:1426-1427`).

## Implementation plan

Each PR ships alone and leaves the tree green.

1. **Briefing fixes** for the two 0.17.0 gaps, with priorities 1 and 3.
2. **`proseRefs`**, with a property test that it is total and `html.slice(start, end) === raw`.
3. **Resolver and suggestions**, with `successorOf` shared with the briefing.
4. **Removal history and caches**, with the ignore pattern and a synthetic timing test.
5. **Doctor check**: fields, flag, summary (`apps/cli/src/commands.ts:856-869`), check count (`apps/cli/src/doctor.ts:34`), and a `docs/design.md` §4 line that prose references are reported, never projected.
6. **Briefing section**: fields, `proseRefHistory`, the binder with overlay seeding, charter line 15 and priority 8, the fake model.
7. **Optional notes** in `session put`, `session exec`, `apps/cli/src/head-server.ts` and `NeighborsAnswer`.

## Acceptance tests

Each test runs on a synthetic fixture its PR ships: the four records plus any file it names. A `line` is checked against the fixture's bytes, as `html.slice(0, start).split("\n").length`.

| #  | file                                      | given                                                                                                                                                                                                                                                                                                                                                                                                                         | expect                                                                                                                                                                                                                                                                                                  |
| -- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | `packages/html/tests/refs.test.ts`        | `see [[request-ceiling]]`, `<code>areas/inbox/x.html</code>`, `<a href="/areas/y.html#top">`, one text node `a &amp; b &#x1F600; https://lamp.example/areas/z.html, or see areas/z.html`, `[[areas/x.html]]`, `<a href="/areas/y.html">areas/y.html</a>`                                                                                                                                                                      | `mention` refs `wiki`, `path`, `href`, `path`, `wiki`, `href`, normalized, `slice(start, end) === raw`, the fourth at the second `areas/z.html`                                                                                                                                                         |
| 2  | same                                      | `<pre><code>[[lamp-wicks]]\ncat areas/x.html</code></pre>`, `../areas/x.html`, `areas/orchard-lamp/`, `[[Request ceiling]]`, `areas/x.html.bak`, `/areas/x.html?ref=1`, `<a href="#top">`, an 81-character label, `see [[request-ceiling]]`                                                                                                                                                                                   | only the last ref                                                                                                                                                                                                                                                                                       |
| 3  | same                                      | "Supersedes: [[request-ceiling]].", the four section 1 examples, "This supersedes [[request-ceiling]] only for one region.", `<q>This replaces [[request-ceiling]]</q>`, `<dt>Replaces</dt><dd>[[request-ceiling]]</dd>`                                                                                                                                                                                                      | `supersedes` for the first two and the last, `mention` for the rest                                                                                                                                                                                                                                     |
| 4  | `packages/session/tests/refs.test.ts`     | R1 at `archive/2031/resources/orchard-lamp/request-ceiling.html`, superseded by R4; then only an archived `areas/other-topic/request-ceiling.html`; then active `resources/orchard-lamp/request-ceiling.html` and `areas/orchard-lamp/request-ceiling.html`, without and then with R3's head linking the first; then R1 archived and superseded by an archived R5, which an active R6 citing `[[request-ceiling]]` supersedes | R3's `[[request-ceiling]]` is `archived` with `successor` R4; `missing`; `ambiguous` with both and no suggestion, then no finding; R6's reference has `successor` R6, no finding and no suggestion                                                                                                      |
| 5  | same                                      | R2 moved; history complete with its old path, complete without it, incomplete without it, absent                                                                                                                                                                                                                                                                                                                              | `moved`; then `missing` with `historyChecked` true, false, false                                                                                                                                                                                                                                        |
| 6  | same                                      | R2 moved, then archived                                                                                                                                                                                                                                                                                                                                                                                                       | R3's path ref is `archived` via `move`, `archive_move`                                                                                                                                                                                                                                                  |
| 7  | same                                      | a held `archive/2031/` path cited; a self-citation; a task citing an archived memory; a people record citing a moved one; a record citing a moved people record; a record citing a moved task; a record saying it replaces a live task                                                                                                                                                                                        | `history` and no finding; nothing; nothing; a finding and no suggestion; an `about_person` suggestion; nothing; nothing                                                                                                                                                                                 |
| 8  | `packages/curator/tests/briefing.test.ts` | R4 keeps `contradicts` to R1's old path after R1's archive; 60 findings; an archived source citing a missing path                                                                                                                                                                                                                                                                                                             | that edge's `successor` is `null`; 50 findings by path, total 60; none from the archived source                                                                                                                                                                                                         |
| 9  | same                                      | the motivating view, one overlay per step                                                                                                                                                                                                                                                                                                                                                                                     | both suggestions land; R1 is in `supersededActive`, in no contradiction group; priority 3 archives R1 and unlinks R4's `contradicts`; R3's `[[request-ceiling]]` turns `archived`, `successor` R4, and its suggestion lands; then no finding, dangling edge or self-link                                |
| 10 | `apps/cli/tests/prose-history.test.ts`    | a temporary repo committing a move and an archive                                                                                                                                                                                                                                                                                                                                                                             | the moved path maps to R2's hash; an unwritten path is absent; bound 1 and a `--depth 1` clone give `complete: false`; a repeat call after a complete or bound-1 walk diffs nothing, with the same history; a call at a child diffs only the child; a cache entry from a dropped branch changes nothing |
| 11 | `apps/cli/tests/doctor.test.ts`           | the motivating store through real commits                                                                                                                                                                                                                                                                                                                                                                                     | `dangling: []`; exactly the two findings; `healthy` as without them; `--fix` leaves R3 and R4 byte-identical; `--suggest-links` gives exactly R3 `relates_to` R2's new path and R4 `supersedes` R1, and `[]` without the flag                                                                           |
| 12 | `apps/cli/tests/curate-run.test.ts`       | `curate run --model fake` on that store                                                                                                                                                                                                                                                                                                                                                                                       | one commit whose ops include both suggested links                                                                                                                                                                                                                                                       |
| 13 | `apps/cli/tests/v2.test.ts`               | `session put` citing an archived path, locally and through the head server                                                                                                                                                                                                                                                                                                                                                    | the same note from both, and the put appends                                                                                                                                                                                                                                                            |
