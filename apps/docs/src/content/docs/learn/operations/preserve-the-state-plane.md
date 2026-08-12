---
title: Preserve the state plane
description: Export and import the access plane — the one set of facts the git tree cannot reproduce — and the multi-machine hazard it carries.
---

```bash
memhtml state export      # write .memhtml/state/access.jsonl and commit it
memhtml state import      # replay the sidecar into state.db
```

`state.db` is gitignored and **not** rebuildable from git. Access counts, reinforcement counts, and the
outcome EWMA are the one set of facts the tree cannot reproduce, so the committed sidecar
`.memhtml/state/access.jsonl` is what survives (`apps/cli/src/state.ts:54`).

## Export

```json
{
  "apiVersion": "1",
  "type": "state.export",
  "data": {
    "path": ".memhtml/state/access.jsonl",
    "rows": 0,
    "bytes": 0,
    "written": true,
    "commitSha": "7ebc0ce7226c84b0ab29a77d0289bf6c8ade9280"
  }
}
```

The export is **byte-stable**: an unchanged plane produces an identical file, so `written: false` and
`commitSha: null` on a re-run mean the sidecar already held exactly this state. That is what makes it
safe on a schedule.

Sleep runs `state-export` as its penultimate phase, so the sidecar refreshes once per night regardless of
query volume. Run it by hand before a machine goes away, because anything since the last export is what
you lose.

## Import

```json
{
  "apiVersion": "1",
  "type": "state.import",
  "data": {
    "path": ".memhtml/state/access.jsonl",
    "rows": 0,
    "restored": 0,
    "skipped": 0,
    "hasState": true
  }
}
```

The import **upserts with `max()` on the monotone counters** rather than truncating
(`apps/cli/src/state.ts:131`). Importing onto a live plane therefore cannot discard counters the sidecar
predates — an import is non-destructive, always, which is why it is safe to run on a machine that has
been reading for a week.

`rows` is what the sidecar held and `restored` is what was written into `state.access`; they differ when
the live plane already had higher counters. `skipped` counts sidecar lines that did not parse — never
fatal, because a partial file restores what it holds.

## The multi-machine hazard

Two machines both committing memories is the conflict path git handles. The state plane is different.

**`.memhtml/state/access.jsonl` is a whole-file merge, so two machines' access counts do not combine.**
The later commit wins and the other machine's reads are lost. `memhtml state import` merging by max is
what makes an *import* non-destructive; the *file* merge is still last-writer-wins.

**Mitigation today is one writer.** A second machine that reads the repo should `memhtml state import` and
never `memhtml state export`.

**Detection is an access count that goes down across a pull, and nothing alarms on it.** If you run more
than one machine, that is the thing to watch for by hand:

```bash
memhtml state export        # note `rows`
git pull
memhtml state import        # `rows` from the sidecar; a drop is the symptom
```

Making the counters merge-commutative — max-of, or per-machine sub-counters summed — is the prerequisite
for real multi-machine use. Until then, treat a second machine as read-only for state.

## Why this plane exists at all

It is the salience retrieval arm's input: the durable record of which memories were *chosen*, attached in
the same SQL statement as the other three arms. A store with no state plane still retrieves — the arm is
dropped and the fold gets narrower — so the failure mode of losing it is silently poorer ranking rather
than an error.

That is also why [recovery](/learn/operations/recover-from-a-lost-index/) puts `memhtml state import`
*before* the index rebuild: the arm has signal on the very first query rather than after the first night.

[The state plane and its committed sidecar](/internals/index-plane-and-state-plane/)
develops it.
