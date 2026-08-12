---
title: Initialize a store
description: Scaffold a memory repository, and why a fresh clone must run memhtml init before its first merge touches a generated file.
---

```bash
export MEMHTML_ROOT=~/memhtml
memhtml init
memhtml index rebuild --embed
```

`memhtml init` is **convergent**: each step asks the repository what is already true and supplies only
what is missing (`packages/store/src/layout.ts:183`). It reaches the same end state from an empty
directory, from a fully scaffolded repository, and from one left half-initialized by an interrupted run.
Re-running it is always safe, and on a converged store it writes nothing:

```json
{
  "apiVersion": "1",
  "type": "repo.init",
  "data": {
    "root": "/home/you/memhtml",
    "created": false,
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "wrote": []
  }
}
```

## memhtml init is required on a fresh clone

This is the part that bites, and it has nothing to do with the database.

`.gitattributes` marks `index.html` and `sitemap.xml` `merge=ours`. That attribute is **inert** without
the matching `merge.ours.driver` git config (`packages/store/src/layout.ts:76`) — and git config is
per-clone and is not cloned. So a clone that skips `memhtml init` gets conflict markers written into a
generated file the first time a merge touches one.

Verify it:

```bash
git -C "$MEMHTML_ROOT" config --get merge.ours.driver
```

```
true
```

Anything other than `true` means run `memhtml init`. If a conflict has already landed in a generated
artifact, the resolution is `memhtml publish` — regenerate rather than hand-edit.

The scaffolded `.gitattributes` is three lines:

```
index.html merge=ours
sitemap.xml merge=ours
*.html diff=html
```

## A clone carries the tree and the sidecar, not the databases

`.memhtml/index.db` and `.memhtml/state.db` are both gitignored (`packages/store/src/layout.ts:55`),
along with their WAL and shared-memory companions:

```
.memhtml/index.db
.memhtml/state.db
.memhtml/index.db-*
.memhtml/state.db-*
```

So what a clone gives you is the tree plus `.memhtml/state/access.jsonl`. That is why `memhtml state
import` is a step in [recovery](/learn/operations/recover-from-a-lost-index/) and not an optimization:
without it the salience retrieval arm has no signal, and ranking is silently poorer rather than broken.

## What the scaffold contains

`memhtml init` creates the four PARA buckets and the directories the system writes into on its own:

```
projects/       areas/          resources/      archive/
areas/arcs/     areas/inbox/    resources/people/
.memhtml/state/   .memhtml/sleep/
.gitignore      .gitattributes  README.html
```

`areas/arcs/` holds behavioural arcs, which only sleep writes. `resources/people/` is the person plane.
`areas/inbox/` is where an unplaceable memory lands, and [`memhtml
doctor`](/learn/operations/audit-and-publish-the-corpus/) warns when it gets crowded, because a full
inbox means the placement rules stopped matching what agents write.

`memhtml init` also applies the migrations, so `.memhtml/index.db` exists and holds nothing until
`memhtml index rebuild` projects the tree into it.

Every scaffold file is written **only when absent**, so a re-run never overwrites an edited one — the
`README.html` you rewrote stays rewritten.

## Then build the projection

```bash
memhtml index rebuild --embed
```

`--embed` fills vectors from Bedrock and is the only step here that costs anything. `--no-embed` makes it
instant, leaves retrieval on its lexical floor, and a later `memhtml index rebuild --embed` closes the
gap. [Rebuild the index](/learn/operations/rebuild-the-index/) covers the difference between `rebuild`
and `update`, and the one refusal a rebuild alone cannot clear.
