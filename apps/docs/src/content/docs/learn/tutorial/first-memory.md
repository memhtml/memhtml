---
title: Write your first memory
description: Run memhtml write, read the file it commits into the git tree, and see why one fact goes in one file.
---

This tutorial writes one memory and then reads the file it produced. Read that file closely, because a
memory is a file in a git repository and everything else in the system is a projection of it or an
operation on it.

You need a scaffolded store, so [install and initialize one](/learn/tutorial/install/) first.

## Write it

```bash
memhtml write --title "One writer and many readers share the index" --type semantic \
  --claim "WAL admits a single writer at a time and any number of concurrent readers." \
  --body "So a memhtml command and a running memhtml serve mcp can work against one store." \
  --tag infra
```

```json
{
  "apiVersion": "1",
  "type": "memory.written",
  "data": {
    "path": "resources/infra/one-writer-and-many-readers-share-the-index.html",
    "created": true,
    "deduped": false,
    "commitSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "contentHash": "sha256:8744f8ea396a98bc283a023653e3cc143c0c4b1e2b442ad76c959e06e93b289e"
  }
}
```

Four things happened, in one git commit:

- The store chose the path. You passed no `--path`, so the first `--tag` routed an unplaced resource
  memory to `resources/infra/` and the title became the filename slug.
- Exactly one of `created` and `deduped` is true. Run the identical command again and you get
  `created: false`, `deduped: true`, `commitSha: null`, and an `existingPath` naming where the content
  already lives. A duplicate is never an error, and it writes nothing.
- The content hash covers the article. Dedup is structural: a partial unique index over active files
  means a duplicate cannot be indexed.
- The commit is the write. `git log` in the store is the history of what the agent learned.

## Read the file

```bash
cat "$MEMHTML_ROOT/resources/infra/one-writer-and-many-readers-share-the-index.html"
```

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>One writer and many readers share the index</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-12T19:21:52Z">
<meta name="memhtml-updated" content="2026-08-12T19:21:52Z">
<meta name="memhtml-content-hash" content="sha256:8744f8ea396a98bc283a023653e3cc143c0c4b1e2b442ad76c959e06e93b289e">
<meta name="memhtml-tag" content="infra">
</head>
<body>
<article>
<p><mark>WAL admits a single writer at a time and any number of concurrent readers.</mark> So a memhtml command and a running memhtml serve mcp can work against one store.</p>
</article>
</body>
</html>
```

Standard HTML5, view-source readable, with no framework and no front matter. The `<meta>` elements are
the typed head plane. The `<mark>` is the claim, the single load-bearing sentence, which becomes the
gist every listing shows and the span a correction targets. Note the markup: the claim sits at
`<article><p><mark>`, so the selector that finds it is the descendant `article mark`. The child
selector `article > mark` matches nothing.

The store generates the commit subject too:

```bash
git -C "$MEMHTML_ROOT" log --oneline
```

```
4e23275 memhtml(write): One writer and many readers share the index
1d12ed3 memhtml(init): scaffold the memory repository
```

## Why one fact per file

The claim is one sentence because the unit of a memory is the unit of a correction. `memhtml correct`
writes the superseding file and archives the target in one commit, so an interrupted run can never
leave two live memories contradicting each other. A file holding three facts cannot be corrected on
one of them without rewriting the other two, and the diff then stops telling a reviewer which fact
moved.

No file is deleted. Eviction is a `git mv` into `archive/<YYYY>/` with the original path mirrored
beneath, so `git log --follow` reads straight through a memory's whole life.

## Add structure the indexer understands

The `--claim` and `--body` form lets the template own the markup. When you need structure, pass
`--article-html` and own it yourself:

```bash
memhtml write --title "Drain the VIP before reverting a deploy" --type procedural --tag runbook \
  --article-html '<article>
  <p><mark>If a prod rollback is issued, drain the VIP before reverting the deploy.</mark>
  The revert alone leaves in-flight connections pinned to the old target group, observed on
  <time datetime="2026-07-28">July 28</time> during the <cite>checkout-api sev2</cite>.</p>
  <dl><dt>Applies to</dt><dd>ALB/NLB target-group deploys</dd></dl>
  <details><summary>How this was learned</summary><p>Three rollbacks replayed the same 500-spike.</p></details>
  <aside><p>Fly.io and Cloud Run drain automatically; this is AWS-specific.</p></aside>
</article>'
```

Every element carries indexer semantics, which is the structure Markdown cannot express.
`<time datetime>` is when the fact happened, so an episodic memory ranks by world-time rather than by
write-time. `<dl>` pairs index as facets, `<cite>` as citations, and `<details>` folds elaboration
behind a summary that `memhtml recall` always discloses.

Supplying `--article-html` takes on two constraints, both checked before anything is written: the
article must contain exactly one `<mark>`, and that `<mark>` must sit in the first `<p>` or `<li>`
outside any `<aside>` or `<details>`. The claim leads the article, so it can never be a caveat or hide
behind a fold. The store renders your article, runs the format check, and refuses with the list of
violations before it creates a file, stages it, or commits, so a refused write leaves the tree
byte-identical.

Supplying both `--claim` and `--article-html`, or neither, is refused.

## Write many at once

Past about three memories in one task, stop calling `memhtml write` N times. `memhtml apply` takes a
JSONL op stream, one complete JSON object per line:

```bash
cat > ops.jsonl <<'EOF'
{"op":"write","title":"Drain the VIP before reverting a deploy","type":"procedural","body":"If a prod rollback is issued, drain the VIP before reverting the deploy.","tag":"runbook"}
{"op":"write","title":"The pool ceiling is 64","type":"semantic","body":"The pool ceiling is 64.","tag":"infra"}
EOF
memhtml apply --file ops.jsonl --detect-conflicts
```

```json
{
  "apiVersion": "1",
  "type": "batch.applied",
  "data": {
    "results": [
      {
        "index": 0,
        "ok": true,
        "path": "resources/runbook/drain-the-vip-before-reverting-a-deploy.html",
        "deduped": false,
        "existing_path": null,
        "code": null,
        "error": null,
        "skipped": false,
        "conflict": null,
        "consolidated_into": null,
        "superseded_path": null
      },
      {
        "index": 1,
        "ok": true,
        "path": "resources/infra/the-pool-ceiling-is-64.html",
        "deduped": false,
        "existing_path": null,
        "code": null,
        "error": null,
        "skipped": false,
        "conflict": null,
        "consolidated_into": null,
        "superseded_path": null
      }
    ],
    "summary": {
      "total": 2,
      "written": 2,
      "deduped": 0,
      "failed": 0,
      "skipped": 0,
      "consolidated": 0
    },
    "commit_sha": "bd4d32c1dede8fc1e2aaf993ddedcda827c12261"
  }
}
```

N files, one commit, one index pass, and one result per op in input order. Each result names its own
`index`, so you can match results back to the lines you sent. The store validates the whole file's
shape before any op executes, so a malformed line 7 is exit 2 naming line 7 with nothing written.

A batch is atomic by default: the first refused op aborts it, nothing is written, and the surviving
ops report `skipped: true`. `--continue-on-error` makes it best-effort instead. `commit_sha` is null
exactly when nothing was committed, which happens on a batch that only deduped and on one that
aborted.

Note the field naming. The batch payload is snake_case (`commit_sha`, `existing_path`) where the
single-write payload is camelCase (`commitSha`). Read the key from the envelope you received. Each
surface spells its own field names, so a translation layer between the two spellings would hide which
surface answered.

Pass `--detect-conflicts` on any real batch. It reports what each op's claim contradicts:
an active memory, or an earlier op in the same call, which nothing else can see because neither op is
stored yet. It is propose-only, and every op still writes exactly as it would have, because sometimes
the contradiction is the answer. A memory recording that a runbook step changed necessarily
contradicts the memory stating the old step.

## The third door

Editing a file under `$MEMHTML_ROOT` with your normal file tools is equally legitimate. The tree is
the system of record, so a hand-written memory is as real as one the CLI wrote. `memhtml index update`
projects uncommitted working-tree changes as well as committed ones, so a dirty edit is searchable
before you commit it.

What you take on is everything the write path would have done: format validity (`memhtml doctor`
reports it, and `memhtml read <path>` reports per-file warnings), a path that does not collide,
noticing that the content already exists, and the commit. `memhtml sleep run` refuses to start on a
dirty tree, so an uncommitted edit blocks curation until you commit or stash it.

For an AI agent, the ordering is this. Prefer `memhtml apply` over your file tools for writes, because
the batch owns dedup, conflict detection, and the single commit. Reach for file tools when you are
repairing a file the parser refuses, which is the one case the write path cannot express.

Next: [retrieve what you just wrote](/learn/tutorial/first-retrieval/).
