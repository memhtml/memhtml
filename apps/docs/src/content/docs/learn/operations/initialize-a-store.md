---
title: Initialize a store
description: Scaffold a memory repository, and why a fresh clone must run memhtml init before its first merge touches a generated file.
---

```bash
export MEMHTML_ROOT=~/memhtml
memhtml init
memhtml index rebuild --embed
```

`memhtml init` asks the repository what is already there and writes only what is missing (`packages/store/src/layout.ts::initRepo`). It reaches the same end state from an empty directory, from a fully scaffolded repository, and from one an interrupted run left half-finished. Re-running it is always safe, and on a store that already has everything it writes nothing:

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

Run it even when you cloned a store someone else already initialized. The scaffolded files travel with the clone; the git config one of them depends on does not.

`.gitattributes` marks `index.html` and `sitemap.xml` with `merge=ours`, which tells git to keep the local version of those two files instead of merging them line by line. The attribute does nothing on its own: git only honors it when the clone's own config also names the driver as `merge.ours.driver` (`packages/store/src/layout.ts::MERGE_OURS_DRIVER`), and git config is per clone and never travels with a clone. So a clone that skips `memhtml init` gets conflict markers written into a generated file the first time a merge touches one.

Check the config directly:

```bash
git -C "$MEMHTML_ROOT" config --get merge.ours.driver
```

```
true
```

Anything other than `true` means you still need to run `memhtml init`. If a merge has already written conflict markers into a generated file, run `memhtml publish` and let it regenerate the file rather than editing it by hand.

`memhtml init` sets a second value beside the driver: `merge.directoryRenames=false`. Archiving moves a record to `archive/<YYYY>/` under its same path, one file at a time. When that move takes the last file out of a directory, git's merge reads it as the whole directory moving, and a record another clone wrote into that directory meanwhile follows it into `archive/`, or the merge stops with `CONFLICT (file location)`. Every move the store makes names its own destination, so the setting costs nothing:

```bash
git -C "$MEMHTML_ROOT" config --get merge.directoryRenames
```

```
false
```

A clone initialized before `memhtml init` set this value prints nothing. The setting protects the clone that runs the merge, so after an upgrade, run `memhtml init` again in every existing clone, including one that only writes and pulls. On a scaffolded store it changes nothing else. `memhtml publish` sets the value too, but only in the clone that publishes, so it is a fallback for publishing clones alone.

The scaffolded `.gitattributes` is three lines:

```
index.html merge=ours
sitemap.xml merge=ours
*.html diff=html
```

## What a clone gives you

`.memhtml/index.db` and `.memhtml/state.db` are both gitignored (`packages/store/src/layout.ts::GITIGNORE`), along with the write-ahead log and shared-memory files SQLite keeps beside them, the session logs, the head's snapshots and vector cache, and a head server's socket:

```
.memhtml/index.db
.memhtml/state.db
.memhtml/index.db-*
.memhtml/state.db-*
.memhtml/sessions/
.memhtml/snapshots/
.memhtml/vectors/
.memhtml/head.sock
```

A store scaffolded before 0.16 has only the first four lines. The commands that write the other four add each missing pattern to `.git/info/exclude` the first time they run, so `git status` stays clean without an edit to the committed `.gitignore`.

A clone therefore hands you the tree, the committed sidecar `.memhtml/state/access.jsonl`, and the store policy `memhtml.config.json` when the store has one, and no databases at all. That sidecar is why `memhtml state import` is a step in [recovery](/learn/operations/recover-from-a-lost-index/). Retrieval ranks a query with four arms: full-text search, vector similarity, recency, and salience. Salience favors the memories you have opened and reinforced before, so skipping the import leaves that arm without the sidecar's history, and ranking gets quietly worse instead of failing. The clone's first `memhtml state export` can then replace the committed sidecar with this clone's own rows, or with an empty file.

## What the scaffold contains

`memhtml init` creates four top-level buckets, following the PARA convention, plus the directories the system writes into on its own:

```
projects/       areas/          resources/      archive/
areas/arcs/     areas/inbox/    resources/people/
.memhtml/state/   .memhtml/sleep/   (the second held the sleep pipeline's reports, removed in 0.16; init still creates it empty)
.gitignore      .gitattributes  README.html
```

`areas/arcs/` holds behavioral arcs: memories that summarize a pattern running across many other memories, written by curation rather than by an agent's `memory_write`. `resources/people/` is the person plane. A memory the placement rules cannot place lands in `areas/inbox/`, and [`memhtml doctor`](/learn/operations/audit-and-publish-the-corpus/) warns you when that directory gets crowded, because a full inbox means the placement rules stopped matching what agents write.

`memhtml init` also applies the database migrations, so `.memhtml/index.db` exists from the start and holds nothing until `memhtml index rebuild` projects the tree into it.

Every scaffold file is written only when it is absent, so a re-run leaves an edited one alone. The `README.html` you rewrote stays rewritten.

`memhtml init` writes no `memhtml.config.json`, so a new store runs under the library's lenient defaults. Write and commit the file when the store needs a stricter write bar, as [set the store policy](/learn/operations/set-the-store-policy/) describes.

## Then build the index

```bash
memhtml index rebuild --embed
```

`--embed` fills in the vectors by calling Bedrock, and it is the only step here that costs money. `--no-embed` finishes instantly and leaves retrieval running on full-text search, recency, and salience; a later `memhtml index embed` fills the vectors in and closes the gap without a rebuild. [Rebuild the index](/learn/operations/rebuild-the-index/) covers when `update` is enough instead of `rebuild`, and the one refusal a rebuild alone cannot clear.
