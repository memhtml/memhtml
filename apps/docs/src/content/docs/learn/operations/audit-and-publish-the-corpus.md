---
title: Audit and publish the corpus
description: Every memhtml doctor finding and its fix, what --fix will and will not repair, and how memhtml publish resolves a conflict in a generated file.
---

```bash
memhtml doctor          # thirteen findings; ten of them decide healthy
memhtml doctor --fix    # repairs the two that need no judgement call
memhtml publish         # regenerate index.html listings and sitemap.xml, and commit
```

A healthy store answers with every finding list empty:

```json
{
  "apiVersion": "1",
  "type": "doctor.report",
  "data": {
    "root": "/home/you/memhtml",
    "healthy": true,
    "dangling": [],
    "orphanAccessRows": [],
    "inboxDepth": 0,
    "inboxCrowded": false,
    "inboxTaskDepth": 0,
    "inboxTasksCrowded": false,
    "overdueTasks": [],
    "staleBlockers": [],
    "untypedEntities": [],
    "untypedEntityTotal": 0,
    "warnings": [],
    "unparseable": [],
    "indexFresh": true,
    "indexHeadSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "embedModelMatches": true,
    "storedEmbedModel": "cohere.embed-v4:0@1024",
    "configuredEmbedModel": "cohere.embed-v4:0@1024",
    "vectorCoverage": 1,
    "vectorCoverageFloor": 0.95,
    "vectorCoverageLow": false,
    "chunks": 9402,
    "embeddings": 9402,
    "vectorCoverageRemedy": null,
    "dirty": []
  }
}
```

Every list is present and possibly empty, so a parser never has to branch on a missing key. `healthy` is true when every check comes back clean.

## The findings

| Finding                    | Meaning                                                                                                                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dangling`                 | A `<link>` points at a path the tree does not hold.                                                                                                                                                                                                                                                                                                                        | `--fix` rewrites it to the archive path, or drops it when the target is gone.                                                                                               |
| `orphanAccessRows`         | A `state.access` row whose path left the tree.                                                                                                                                                                                                                                                                                                                             | `--fix` prunes it.                                                                                                                                                          |
| `inboxCrowded`             | Over 20 active memories in `areas/inbox/`, which means the placement rules stopped matching what agents write.                                                                                                                                                                                                                                                             | Re-place them, or revisit the rules.                                                                                                                                        |
| `inboxTasksCrowded`        | Over 10 open tasks in `areas/inbox/tasks/`: work with no project.                                                                                                                                                                                                                                                                                                          | Drain it. A task inbox is a queue, and this one is filling up.                                                                                                              |
| `overdueTasks`             | An open task whose `memhtml-due` has passed.                                                                                                                                                                                                                                                                                                                               | Doctor is the only surface that reads `due_at`, because search excludes a task by default.                                                                                  |
| `staleBlockers`            | A `blocks` edge whose blocker is archived or absent.                                                                                                                                                                                                                                                                                                                       | Decide whether the blocked task is ready. Each file on its own is valid, and only the pair is wrong.                                                                        |
| `untypedEntities`          | A `memhtml-entity` meta written as a bare name, so it indexes under the `unknown` type.                                                                                                                                                                                                                                                                                    | Name a type in the producer. `unknown:checkout-api` is not reachable by `--entity service:checkout-api`.                                                                    |
| `warnings`                 | An element outside the closed vocabulary. The file still indexes.                                                                                                                                                                                                                                                                                                          | Author's intent, and doctor will not guess at it.                                                                                                                           |
| `unparseable`              | A file the parser refuses. It is absent from the index.                                                                                                                                                                                                                                                                                                                    | Read the violations with `memhtml read <path>`, fix the file, then `memhtml index rebuild`.                                                                                 |
| `indexFresh: false`        | The index describes an older commit.                                                                                                                                                                                                                                                                                                                                       | `memhtml index update --embed`.                                                                                                                                             |
| `embedModelMatches: false` | The stored vectors came from a different embedding model than the configured one.                                                                                                                                                                                                                                                                                          | Delete the database and rebuild: see [rebuild the index](/learn/operations/rebuild-the-index/).                                                                             |
| `vectorCoverageLow: true`  | Under `vectorCoverageFloor` (default 0.95, `MEMHTML_VECTOR_COVERAGE_FLOOR`) of the chunks carry a vector in the configured space while the plane is in use: some vector exists, or an embedder is configured. Search drops the vector arm and reports `degraded: true` with `vectorCoverage`. A store with zero vectors and no embedder is lexical-only and stays healthy. | `vectorCoverageRemedy` names it: `memhtml index embed` to backfill, or `memhtml index rebuild --embed`. Set `MEMHTML_EMBED=off` if the store is meant to stay lexical-only. |

The two inbox thresholds are `INBOX_WARN_DEPTH` 20 and `INBOX_TASK_WARN_DEPTH` 10 (`apps/cli/src/doctor.ts:69`, `apps/cli/src/doctor.ts:78`).

`overdueTasks`, `staleBlockers` and `untypedEntities` are the three findings excluded from `healthy`. The first two describe work that has fallen behind rather than a corpus that is wrong, and folding them in would make `healthy: false` the normal state. `untypedEntities` is excluded because `unknown` is a supported storage type: a bare name costs reachability, not correctness, and gating on it would turn a hand-authored corpus red for writing its metas the way the format allows. `untypedEntities` is capped at `UNTYPED_ENTITY_SAMPLE` 20 with the distinct count reported beside it as `untypedEntityTotal`, so a truncated sample cannot be read as the whole set.

Search excludes a `task` memory by default, so `memhtml doctor` is the only command that reports a task past its due date. If you use tasks, put this command on your cron.

## What `--fix` repairs, and why only two

`--fix` rewrites `dangling` hrefs and prunes `orphanAccessRows`. Everything else needs a decision doctor is not entitled to make: a crowded inbox might be a bad day or bad placement rules, an element outside the vocabulary might be exactly what the author meant, and an unparseable file needs a human to read the violations.

`--fix` splices the changed bytes in place (`apps/cli/src/repair.ts`) instead of writing the file out again through the serializer. The reason goes past avoiding a second implementation: a repair routed through the serializer would move the content hash of every file it touched, which would then read as a body change and would re-embed the file for nothing.

Under `--fix` the report gains a `repaired` object: hrefs `rewritten` (pointed at the target's archive path), hrefs `dropped` (the target has no file anywhere), `failedWrites`, `prunedAccessRows`, and the `commitSha` the href repairs landed in — `null` when nothing was rewritten (`apps/cli/src/doctor.ts:156`).

A repair counts only when its bytes reached disk. `failedWrites` lists the source paths whose repaired bytes could not be written, and those findings are still open: they stay in `dangling`, they are absent from `rewritten` and `dropped`, and they are never staged, so a re-run retries them. Both halves of that matter — staging an unchanged file would put the pre-repair bytes into a commit whose subject claims they were repaired, and counting it would report a finding as settled while it is still open. A non-empty `failedWrites` is the one part of a `--fix` report that needs a second look, usually at permissions on the paths it names.

## Publish

```bash
memhtml publish
```

```json
{
  "apiVersion": "1",
  "type": "publish.report",
  "data": {
    "root": "/home/you/memhtml",
    "artifacts": 5,
    "written": 5,
    "paths": [
      "index.html",
      "resources/index.html",
      "resources/infra/index.html",
      "resources/runbook/index.html",
      "sitemap.xml"
    ],
    "removed": [],
    "commitSha": "f1242b5e861ce09efb7fc1dfafd00f95b446215d"
  }
}
```

`memhtml publish` regenerates the per-directory `index.html` listings and `sitemap.xml` and commits them. It is deterministic to the byte (`apps/cli/src/publish.ts:36-38`), so two runs over an unchanged corpus write nothing and commit nothing, reporting `written: 0` and `commitSha: null`. That is what makes it safe on the cron. The listings come from the index, so on a store whose index holds no rows while HEAD carries memory files, such as a fresh clone, publish writes and commits nothing and fails with `ERR_INDEX_STALE`, and `memhtml index rebuild` followed by another publish is the fix.

Publish also removes the listing of a directory that no longer holds a record. Once every record at or below a directory has been archived or moved, the generator stops producing that directory's `index.html`, and publish deletes it with `git rm` in the same commit and names it in `removed` (`staleListings` at `apps/cli/src/artifacts.ts:200-223`). Publish reads that from the tree it is about to commit, not from the index alone, so a pull the index hasn't caught up with never costs a directory its listing. Archived records keep listings of their own under `archive/<YYYY>/`, and the root `index.html` and `sitemap.xml` are never removed. The filename under a bucket belongs to the generator, so an `index.html` you wrote by hand in an emptied directory goes too.

Those artifacts are what make the store browsable: open `$MEMHTML_ROOT/index.html` in a browser and walk the corpus with no tooling at all.

## Publish is also the conflict resolution

`.gitattributes` marks `index.html` and `sitemap.xml` with `merge=ours`, and that attribute needs the per-clone `merge.ours.driver` config that [`memhtml init`](/learn/operations/initialize-a-store/) sets. If a merge has already written conflict markers into a generated file, leave the file itself alone.

Finish the merge however git needs you to, then run `memhtml index update` and `memhtml publish` and let publish overwrite the artifact. The listings come from the index, so updating it first is what makes them describe the merged tree. The generator is the authority for a derived file, so an edit you make by hand only produces a version the next publish replaces.

One conflict on a listing is not a content conflict, and `merge=ours` doesn't settle it: one clone's publish removed a listing because its directory emptied, while the other clone wrote a record there and published a new version of that listing. Git reports `CONFLICT (modify/delete)` on the path. Settle it either way, with `git rm <path>` or `git add <path>`, and finish the merge. Then `memhtml index update` and `memhtml publish` write the listing back if its directory still holds a record and remove it if not. That record stays where it was written, rather than following the archive move, in a clone whose `merge.directoryRenames` is `false`. The setting protects the clone that runs the merge, and `memhtml init` sets it. After an upgrade, run `memhtml init` again in every existing clone, including one that only writes and pulls. `memhtml publish` sets it too, but only in the clone that publishes, so it is a fallback for publishing clones alone.

A merge can also finish cleanly and still leave the listings wrong. When one clone's publish removed a bucket listing and added a new listing under `archive/`, git can pair the two as a rename, such as `rename {resources => archive}/index.html (100%)`, and apply the other clone's version of the removed listing at the archive path. The merge exits 0, the bucket has no `index.html`, and `archive/index.html` lists live records. The same `memhtml index update` and `memhtml publish` repair both.
