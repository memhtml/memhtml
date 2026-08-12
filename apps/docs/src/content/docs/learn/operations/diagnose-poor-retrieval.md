---
title: Diagnose poor retrieval
description: Where to look when search returns the wrong thing, nothing errors, and the store looks fine — plus the full error-code table.
---

Three commands cover almost every case:

```bash
memhtml status           # HEAD, dirty paths, counts by type, edges, index freshness, embedder state
memhtml index status     # the watermark, the vector space, per-table row counts
memhtml doctor
```

## The four symptoms, and what each one means

**`indexFresh: false`** → `memhtml index update --embed`.

The index describes a commit; "fresh" means that commit is HEAD (`apps/cli/src/operations.ts:1524`). A
stale index does not return wrong answers so much as *old* ones, and the memory you wrote an hour ago is
simply absent.

**`embedderUp: false`** → the stored watermark disagrees with the configured model, or there are zero
vectors (`apps/cli/src/operations.ts:1530`).

It is read off the stored watermark rather than by probing Bedrock, so it never fails for a reason
unrelated to the corpus. Compare `embedModel` against `configuredEmbedModel` on `memhtml index status`: if
they differ, the fix is in [rebuild the index](/learn/operations/rebuild-the-index/). If they agree and
`embeddings` is 0, run `memhtml index rebuild --embed`.

**`degraded: true` on a search response** → the query embedder returned nothing.

Search still works on the lexical floor; the fold ran with three arms instead of four. Check
`MEMHTML_AWS_REGION` and the Bedrock credential. If `MEMHTML_EMBED=off` is set, that is the answer and it
was a decision.

**Quality feels wrong but nothing errors** → `memhtml eval discriminate`.

That is what it is for. It separates a broken ranking stack from a corpus that does not hold the answer,
and no amount of reading search output will do that. See [check the discrimination
gate](/learn/operations/check-the-discrimination-gate/).

## A search should never error instead of returning nothing

Query text goes through `sanitizeFtsQuery` before it reaches `MATCH`
(`packages/index/src/fts-query.ts:35`), because several forms common in prose are hard driver errors rather
than empty results:

- an apostrophe — `don't`;
- a `type:name` entity reference — `service:checkout-api`, which is exactly the form a hit's `entities`
  publishes;
- a leading hyphen, which FTS reads as negation.

**A query that errors means the sanitizer was bypassed.** That is a bug to report, not a configuration
problem to work around, and you should not sanitize on your side.

## The tree is dirty and sleep refuses

Preflight calls `requireCleanTree()` (`packages/sleep/src/phases/preflight.ts:22`) and fails with
`ERR_DIRTY_TREE` listing the paths. A phase reading the index while the tree holds uncommitted edits would
curate a corpus nobody has. The refusal lands in phase one, so it costs nothing.

```bash
git -C "$MEMHTML_ROOT" status --porcelain
memhtml index update --embed      # the indexer DOES read dirty paths
# then commit or stash, and re-run
```

Those two facts sit together on purpose: the indexer reads the dirty tree so your edit is searchable
immediately, and sleep refuses it so curation never runs against a tree only you can see.

## Empty results that are not a retrieval problem

Before assuming the ranker, read three fields off the search envelope:

- **`scopeEmpty: true`** — a scope was named, it narrowed the query, and nothing survived. That is a typo
  in a `--workspace` or an `--entity`, not a missing memory. It is never true for an unscoped empty result.
- **`entityScope`** — echoed back so an empty result is attributable. An `--entity` scope that matches
  nothing returns no hits and says so; it never widens.
- **`hits: []` with `degraded: false`** — the corpus does not contain it. Try `--include-archived`:
  eviction is a `git mv`, so an archived memory still exists and is excluded by default.

Also remember that a `task` memory is **default-excluded from search**. Use `memhtml task list` for the
task working set — it is a direct indexed scan with blockers, never ranked retrieval.

## Error codes

```
ERR_UNKNOWN_COMMAND   ERR_MISSING_ARGUMENT      ERR_INVALID_FLAG        ERR_PATH_NOT_FOUND
ERR_INVALID_MEMORY    ERR_DUPLICATE_CONTENT     ERR_WRITE_CONFLICT      ERR_DIRTY_TREE
ERR_INDEX_STALE       ERR_EMBED_MODEL_MISMATCH  ERR_MODEL_UNAVAILABLE   ERR_STORAGE
ERR_GIT               ERR_DISCRIMINATION_FAILED ERR_UNKNOWN
```

Fifteen codes (`apps/cli/src/envelope.ts:66`), append-only: a shipped code never changes meaning and is
never removed.

**Branch on `code`, never on the `error` prose**, which changes freely as wording improves. Most failures
carry `suggestions`, and those are commands you can run (`apps/cli/src/errors.ts:128`):

```json
{
  "apiVersion": "1",
  "error": "no memory at areas/inbox/nope.html",
  "code": "ERR_PATH_NOT_FOUND",
  "suggestions": [
    "memhtml search <what you were looking for>",
    "memhtml list"
  ]
}
```

Every `memhtml …` suggestion is checked against the command table by the suite
(`apps/cli/tests/cli.test.ts:392`), so a renamed command cannot leave a suggestion naming a command that no
longer exists. A typo gets a candidate rather than a dead end:

```json
{
  "apiVersion": "1",
  "error": "unknown command: serch x",
  "code": "ERR_UNKNOWN_COMMAND",
  "suggestions": ["search"]
}
```

That one exits **2** — a usage error you fix by changing the call — where `ERR_PATH_NOT_FOUND` exits **1**,
a runtime failure you fix by changing the repo or the environment.

For an AI agent that distinction is the whole triage: exit 2 means re-read `memhtml manifest` and re-issue a
corrected call, exit 1 means re-issuing the same call will fail identically until something outside the call
changes.
