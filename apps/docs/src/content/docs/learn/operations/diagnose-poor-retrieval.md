---
title: Diagnose poor retrieval
description: Where to look when search returns the wrong thing, nothing errors, and the store looks fine, plus the full error-code table.
---

Three commands cover almost every case:

```bash
memhtml status           # HEAD, dirty paths, counts by type, edges, index freshness, embedder state
memhtml index status     # the watermark, the vector space, per-table row counts
memhtml doctor
```

## The four symptoms, and what each one means

`indexFresh: false` calls for `memhtml index update --embed`. The index describes one commit, and "fresh" means that commit is HEAD (`apps/cli/src/operations.ts:1524`). A stale index returns old answers rather than wrong ones, and the memory you wrote an hour ago is absent from them.

`embedderUp: false` means one of two things: the stored vectors came from a different embedding model than the configured one, or the index holds no vectors at all (`apps/cli/src/operations.ts:1530`). The field is read off the stored watermark rather than by calling Bedrock, so it never fails for a reason unrelated to the corpus. Compare `embedModel` against `configuredEmbedModel` on `memhtml index status`. If they differ, the fix is in [rebuild the index](/learn/operations/rebuild-the-index/). If they agree and `embeddings` is 0, run `memhtml index rebuild --embed`.

`degraded: true` on a search response means the query embedder returned nothing. Search still works: it ranked with three of its four arms, using full-text search, recency, and salience while vector similarity sat out. Check `MEMHTML_AWS_REGION` and the Bedrock credential. If `MEMHTML_EMBED=off` is set, that is your answer and someone chose it.

Quality feels wrong while nothing errors, so run `memhtml eval discriminate`. That command is the discrimination gate: it checks that each probe query ranks its target fact above deliberately wrong versions of the same fact. It tells you whether the ranking stack is broken or the corpus never held the answer, which reading search output cannot. See [check the discrimination gate](/learn/operations/check-the-discrimination-gate/).

## A search returns an empty result, never a driver error

Query text goes through `sanitizeFtsQuery` before it reaches `MATCH` (`packages/index/src/fts-query.ts:35`), because several forms common in prose are hard driver errors in SQLite's full-text search rather than empty results:

- an apostrophe, as in `don't`;
- a `type:name` entity reference such as `service:checkout-api`, which is exactly the form a hit's `entities` publishes;
- a leading hyphen, which the full-text search engine reads as negation.

A query that errors means something bypassed the sanitizer. Report that as a bug, and leave your own side unsanitized.

## The tree is dirty and sleep refuses

Preflight calls `requireCleanTree()` (`packages/sleep/src/phases/preflight.ts:22`) and fails with `ERR_DIRTY_TREE`, listing the paths. A phase that read the index while the tree held uncommitted edits would curate a corpus nobody else has. The refusal lands in phase one, so it costs nothing.

```bash
git -C "$MEMHTML_ROOT" status --porcelain
memhtml index update --embed      # the indexer DOES read dirty paths
# then commit or stash, and re-run
```

The indexer reads the dirty tree so your edit is searchable immediately, and sleep refuses the same tree so curation never runs against a state only you can see.

## Empty results with a cause outside the ranker

Before you suspect the ranker, read three fields off the search envelope:

- `scopeEmpty: true` means a scope was named, it narrowed the query, and nothing survived. Look for a typo in a `--workspace` or an `--entity` value. The field is never true for an unscoped empty result.
- `entityScope` echoes the scope back, so you can attribute an empty result. An `--entity` scope that matches nothing returns no hits and says so, and it never widens on its own.
- `hits: []` with `degraded: false` means the corpus does not contain it. Try `--include-archived`: eviction is a `git mv`, so an archived memory still exists and search excludes it by default.

Also remember that search excludes `task` memories by default. Use `memhtml task list` for the task working set, which is a direct indexed scan with blockers rather than ranked retrieval.

## Error codes

```
ERR_UNKNOWN_COMMAND  ERR_MISSING_ARGUMENT  ERR_INVALID_FLAG           ERR_UNEXPECTED_ARGUMENT
ERR_PATH_NOT_FOUND   ERR_INVALID_MEMORY    ERR_DUPLICATE_CONTENT      ERR_WRITE_CONFLICT
ERR_DIRTY_TREE       ERR_INDEX_STALE       ERR_EMBED_MODEL_MISMATCH   ERR_MODEL_UNAVAILABLE
ERR_STORAGE          ERR_GIT               ERR_DISCRIMINATION_FAILED  ERR_UNKNOWN
```

Sixteen codes (`apps/cli/src/envelope.ts:67`), append-only: a shipped code keeps its meaning forever and is never removed.

`ERR_UNEXPECTED_ARGUMENT` (`apps/cli/src/envelope.ts:74`) is a positional past what the command declares, and it carries its own code rather than reusing a neighbour's because it is a different mistake from either. It is not `ERR_INVALID_FLAG`, since the offending token is not a flag; and it is not `ERR_MISSING_ARGUMENT`, since the argument is surplus rather than absent, so the fix is dropping a word rather than adding one. `memhtml read a.html b.html` reads one memory, and without this code it would say nothing at all about the second.

Branch on `code` and never on the `error` prose, which changes freely as the wording improves. Most failures carry `suggestions`, and those are commands you can run (`apps/cli/src/errors.ts:136`):

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

The suite checks every `memhtml …` suggestion against the command table (`apps/cli/tests/cli.test.ts:392`), so a renamed command cannot leave a suggestion naming a command that no longer exists. A typo gets a candidate back rather than a dead end:

```json
{
  "apiVersion": "1",
  "error": "unknown command: serch x",
  "code": "ERR_UNKNOWN_COMMAND",
  "suggestions": ["search"]
}
```

That one exits 2, which marks a usage error you fix by changing the call. `ERR_PATH_NOT_FOUND` exits 1, which marks a runtime failure you fix by changing the repo or the environment.

For an AI agent that distinction is the whole triage. Exit 2 means re-read `memhtml manifest` and re-issue a corrected call. Exit 1 means the same call will fail identically until something outside the call changes.
