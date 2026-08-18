---
title: Initialize a store
description: Scaffold a memory repository, and why a fresh clone must run memhtml init before its first merge touches a generated file.
---

```bash
export MEMHTML_ROOT=~/memhtml
memhtml init
memhtml index rebuild --embed
```

`memhtml init` asks the repository what is already there and writes only what is missing
(`packages/store/src/layout.ts:183`). It reaches the same end state from an empty directory, from a
fully scaffolded repository, and from one an interrupted run left half-finished. Re-running it is
always safe, and on a store that already has everything it writes nothing:

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

## Run memhtml init in every clone

Run it even when you cloned a store someone else already initialized. The scaffolded files travel
with the clone; the git config one of them depends on does not.

`.gitattributes` marks `index.html` and `sitemap.xml` with `merge=ours`, which tells git to keep the
local version of those two files instead of merging them line by line. The attribute does nothing on
its own: git only honors it when the clone's own config also names the driver as
`merge.ours.driver` (`packages/store/src/layout.ts:76`), and git config is per clone and never
travels with a clone. So a clone that skips `memhtml init` gets conflict markers written into a
generated file the first time a merge touches one.

Check the config directly:

```bash
git -C "$MEMHTML_ROOT" config --get merge.ours.driver
```

```
true
```

Anything other than `true` means you still need to run `memhtml init`. If a merge has already
written conflict markers into a generated file, run `memhtml publish` and let it regenerate the file
rather than editing it by hand.

The scaffolded `.gitattributes` is three lines:

```
index.html merge=ours
sitemap.xml merge=ours
*.html diff=html
```

## What a clone gives you

`.memhtml/index.db` and `.memhtml/state.db` are both gitignored
(`packages/store/src/layout.ts:55`), along with the write-ahead log and shared-memory files SQLite
keeps beside them:

```
.memhtml/index.db
.memhtml/state.db
.memhtml/index.db-*
.memhtml/state.db-*
```

A clone therefore hands you the tree and the committed sidecar `.memhtml/state/access.jsonl`, and no
databases at all. That sidecar is why `memhtml state import` is a step in
[recovery](/learn/operations/recover-from-a-lost-index/). Retrieval ranks a
query with four arms: full-text search, vector similarity, recency, and salience. Salience favors
the memories you have opened and reinforced before, so skipping the import leaves that arm with no
signal and ranking gets quietly worse instead of failing.

## What the scaffold contains

`memhtml init` creates four top-level buckets, following the PARA convention, plus the directories
the system writes into on its own:

```
projects/       areas/          resources/      archive/
areas/arcs/     areas/inbox/    resources/people/
.memhtml/state/   .memhtml/sleep/
.gitignore      .gitattributes  README.html
```

Only the nightly sleep cycle writes into `areas/arcs/`, which holds behavioral arcs: memories that
summarize a pattern running across many other memories. `resources/people/` is the person plane. A
memory the placement rules cannot place lands in `areas/inbox/`, and
[`memhtml doctor`](/learn/operations/audit-and-publish-the-corpus/) warns you when that directory
gets crowded, because a full inbox means the placement rules stopped matching what agents write.

`memhtml init` also applies the database migrations, so `.memhtml/index.db` exists from the start and
holds nothing until `memhtml index rebuild` projects the tree into it.

Every scaffold file is written only when it is absent, so a re-run leaves an edited one alone. The
`README.html` you rewrote stays rewritten.

## Then build the index

```bash
memhtml index rebuild --embed
```

`--embed` fills in the vectors by calling Bedrock, and it is the only step here that costs money.
`--no-embed` finishes instantly and leaves retrieval running on full-text search, recency, and
salience; a later `memhtml index rebuild --embed` fills the vectors in and closes the gap.
[Rebuild the index](/learn/operations/rebuild-the-index/) covers when `update` is enough instead of
`rebuild`, and the one refusal a rebuild alone cannot clear.
