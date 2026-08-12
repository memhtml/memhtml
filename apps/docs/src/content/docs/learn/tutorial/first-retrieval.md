---
title: Retrieve it
description: Run memhtml search and memhtml recall against the memory you wrote, and learn what actually separates the two.
---

Two commands read the corpus by relevance. They share every scope flag and they are not
interchangeable: `search` answers *which memories match*, `recall` answers *what should I put in a
context window*. This tutorial runs both against the memory from [the previous
page](/learn/tutorial/first-memory/) and reads the difference off the envelopes.

## Search

```bash
memhtml search "one writer many readers"
```

```json
{
  "apiVersion": "1",
  "type": "memory.hits",
  "data": {
    "hits": [
      {
        "path": "resources/infra/one-writer-and-many-readers-share-the-index.html",
        "title": "One writer and many readers share the index",
        "gist": "WAL admits a single writer at a time and any number of concurrent readers.",
        "memoryType": "semantic",
        "score": 1,
        "confidence": 1,
        "updatedAt": "2026-08-12T19:21:52Z",
        "snippet": "WAL admits a single writer at a time and any number of concurrent readers. So a memhtml command and a running memhtml serve mcp can work against one store.",
        "entities": [],
        "supersededBy": null
      }
    ],
    "degraded": true,
    "arms": [
      "fts",
      "recency",
      "salience"
    ],
    "entityScope": null,
    "scopeEmpty": false
  }
}
```

The three fields under `hits` are the ones to read before the hits themselves.

**`arms` is which ranking arms actually contributed.** There are four —
`fts`, `vector`, `recency`, and `salience` (`packages/index/src/retrieval-sql.ts:243`) — fused with
reciprocal rank fusion in one SQL statement and then diversified with MMR in TypeScript. The output
above lists three because that store has no embedder bound, so the arm needing a query vector was
dropped before assembly. With an embedder bound, `arms` includes `"vector"` and `degraded` is `false`.

**`degraded: true` means the vector arm did not fire.** It is surfaced rather than silent, because an
agent comparing two searches needs to know that one of them was ranked by fewer signals. Retrieval never
errors because Bedrock is down; the search gets narrower instead.

**`scopeEmpty` distinguishes an empty corpus from an over-narrow scope.** It is `true` only when a scope
was named, it narrowed the query, and nothing survived it — never for an unscoped empty result. That is
the difference between "there is no answer" and "there is a typo in your `--workspace`", and
`hits.length` cannot tell you which.

`score` is the fused RRF score. It is unitless and comparable only *within one result set*: comparing a
score of 0.5 in one search to 0.5 in another means nothing.

`snippet` is this file's best-matching chunk for this query — nearest to the query vector when the
vector arm ran, and the article's opening text on the degraded path.

`entities` publishes each reference in `type:name` form (`service:checkout-api`, never bare
`checkout-api`). That form is a contract with the `--entity` scope, not a display choice: a value from
this array is usable verbatim as the next search's scope, which makes a two-hop chain two calls rather
than a guess about spelling.

### Scoping a search

```bash
memhtml search "rollback" --type procedural --limit 5
memhtml search "rollback" --entity service:checkout-api
memhtml search "rollback" --workspace checkout-api
memhtml search "rollback" --include-archived
memhtml search "rollback" --as-of 2026-06-01T00:00:00Z
```

`--type` and `--tag` are repeatable and each occurrence *broadens* — an ANY-of. `--workspace` is strict:
a scoped query never returns a memory with no workspace. `--as-of` is a point-in-time view, returning
what was believed valid at that instant, including since-superseded memories each marked
`supersededBy` — the history is read from validity windows stamped in the files, so it survives a full
index rebuild.

A query is prose, never a query language. You can type an apostrophe, a `type:name` reference, or a
leading hyphen and get results rather than a driver error: query text is sanitized before it reaches
`MATCH` (`packages/index/src/fts-query.ts:35`). A search that *errors* is a bug, not a bad query.

## Recall

```bash
memhtml recall "one writer many readers" --budget 2000
```

```json
{
  "apiVersion": "1",
  "type": "recall.pack",
  "data": {
    "arcs": {
      "disclosed": [],
      "indexLines": [],
      "spentChars": 0,
      "truncated": false
    },
    "memories": {
      "disclosed": [
        {
          "path": "resources/infra/one-writer-and-many-readers-share-the-index.html",
          "title": "One writer and many readers share the index",
          "gist": "WAL admits a single writer at a time and any number of concurrent readers.",
          "memoryType": "semantic",
          "body": "WAL admits a single writer at a time and any number of concurrent readers."
        }
      ],
      "indexLines": [],
      "spentChars": 74,
      "truncated": false
    },
    "spentChars": 74,
    "truncated": false,
    "degraded": true
  }
}
```

Same ranking underneath, different product. `recall` layers a **disclosure fold** on top of it:

- **Two envelopes, not one list.** `arcs` and `memories` are folded separately under their own character
  budgets, so an arc — a behavioural summary that sleep synthesizes — does not compete with the memories
  it summarizes.
- **`disclosed` is quoted, `indexLines` is not.** A candidate that fits the budget arrives with its
  body. One that does not becomes an index line: claim plus path, so you can drill down deliberately with
  `memhtml read`. Rank order is authoritative — a candidate is never promoted past a better-ranked one to
  make it fit — but the fold *continues* past a candidate that did not fit, because the budget is a
  character budget and not a position cut-off. Without that, one long memory in the middle of the list
  would silently truncate every shorter one after it.
- **`spentChars` never exceeds the budget**, and `truncated: true` says at least one candidate became an
  index line instead of a quote. That is the signal to raise `--budget` (default 16000) or narrow the
  scope.
- **Both folds cap quotes at two memories per entity name.** A capped memory still gets its index line,
  so the cap narrows depth rather than dropping the memory.

`recall` also always discloses what is behind a `<details>` summary, which `search`'s snippet does not.

## Which to use

Use **`search`** when you want paths and ranks: you are going to pick one, follow an edge, or chain a
second query off a hit's `entities`.

Use **`recall`** when the output is going straight into a model's context window. The budget is the whole
point — you get as much quoted body as you asked for and an honest index of what did not fit, rather
than a truncated list that pretends to be complete.

For an AI agent the pattern that works is ranked retrieval first, traversal second: `search` or `recall`
to get the handful of paths the ranking stack says matter, then `memhtml exec` to walk edges, join, count,
and filter from there in one execution. Starting with a full-corpus scan means starting with no relevance
signal.

:::agent
**For an agent.** The query argument is prose, not a query language — there are no operators to bind an
`AND`, a field match, or a wildcard to, so writing one puts those characters into the text being matched.
Add `--dense` when the output goes into a prompt: it drops null fields and minifies. And a question that
needs more than one hop is one `memhtml exec` script, not a `search` followed by N `read` calls.
:::

## What retrieval does not do to your store

**Neither command bumps the access plane**, however many paths it returns. Salience counts *chosen
opens*: `memhtml read` of a named path bumps it, and so does the `memhtml://file/{path}` MCP resource,
because both are a decision. A path merely returned by a ranker is the ranker's guess, and counting it
would make today's top five rank higher tomorrow purely for having been listed — while the memory that
should displace them never appears to earn a first bump.

So a corpus that has been searched all day and never read has an empty access plane, and that is correct
rather than a bug. `memhtml reinforce <path> --signal positive|negative` is the explicit channel and the
only thing that moves the outcome EWMA.

[Retrieval](/internals/four-arm-retrieval/) carries the arm weights, the RRF constant, and the MMR pass.
[Diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/) is the page for when the ranking
is wrong rather than merely narrow.

Next: [wire up the MCP server](/learn/tutorial/mcp-server/).
