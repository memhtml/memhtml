---
title: Audit and publish the corpus
description: Every memhtml doctor finding and its fix, what --fix will and will not repair, and how memhtml publish resolves a conflict in a generated file.
---

```bash
memhtml doctor          # ten findings; eight of them decide healthy
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
    "warnings": [],
    "unparseable": [],
    "indexFresh": true,
    "indexHeadSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "embedModelMatches": true,
    "storedEmbedModel": "cohere.embed-v4:0@1024",
    "configuredEmbedModel": "cohere.embed-v4:0@1024",
    "dirty": []
  }
}
```

Every list is present and possibly empty, so a parser never has to branch on a missing key. `healthy` is true when every check comes back clean.

## The findings

| Finding                    | Meaning                                                                                                        | Fix                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dangling`                 | A `<link>` points at a path the tree does not hold.                                                            | `--fix` rewrites it to the archive path, or drops it when the target is gone.                                             |
| `orphanAccessRows`         | A `state.access` row whose path left the tree.                                                                 | `--fix` prunes it.                                                                                                        |
| `inboxCrowded`             | Over 20 active memories in `areas/inbox/`, which means the placement rules stopped matching what agents write. | Re-place them, or revisit the rules.                                                                                      |
| `inboxTasksCrowded`        | Over 10 open tasks in `areas/inbox/tasks/`: work with no project.                                              | Drain it. A task inbox is a queue, and this one is filling up.                                                            |
| `overdueTasks`             | An open task whose `memhtml-due` has passed.                                                                   | Doctor is the only surface that reads `due_at`, because search excludes a task by default and every sleep phase skips it. |
| `staleBlockers`            | A `blocks` edge whose blocker is archived or absent.                                                           | Decide whether the blocked task is ready. Each file on its own is valid, and only the pair is wrong.                      |
| `warnings`                 | An element outside the closed vocabulary. The file still indexes.                                              | Author's intent, and doctor will not guess at it.                                                                         |
| `unparseable`              | A file the parser refuses. It is absent from the index.                                                        | Read the violations with `memhtml read <path>`, fix the file, then `memhtml index rebuild`.                               |
| `indexFresh: false`        | The index describes an older commit.                                                                           | `memhtml index update --embed`.                                                                                           |
| `embedModelMatches: false` | The stored vectors came from a different embedding model than the configured one.                              | Delete the database and rebuild: see [rebuild the index](/learn/operations/rebuild-the-index/).                           |

The two inbox thresholds are `INBOX_WARN_DEPTH` 20 and `INBOX_TASK_WARN_DEPTH` 10 (`apps/cli/src/doctor.ts:69`, `apps/cli/src/doctor.ts:78`).

Search excludes a `task` memory by default and every sleep phase skips it, so `memhtml doctor` is the only command that reports a task past its due date. If you use tasks, put this command on your cron.

## What `--fix` repairs, and why only two

`--fix` rewrites `dangling` hrefs and prunes `orphanAccessRows`. Everything else needs a decision doctor is not entitled to make: a crowded inbox might be a bad day or bad placement rules, an element outside the vocabulary might be exactly what the author meant, and an unparseable file needs a human to read the violations.

`--fix` reuses the repair the sleep integrity phase already implements, which splices the changed bytes in place instead of writing the file out again through the serializer. The reason goes past avoiding a second implementation: a repair routed through the serializer would move the content hash of every file it touched, which would then read as a body change in the next `memhtml sleep review` and would re-embed the file for nothing.

Under `--fix` the report gains a `repaired` object counting hrefs `rewritten` (pointed at the target's archive path) and `dropped` (the target has no file anywhere).

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
    "commitSha": "f1242b5e861ce09efb7fc1dfafd00f95b446215d"
  }
}
```

`memhtml publish` regenerates the per-directory `index.html` listings and `sitemap.xml` and commits them. It is deterministic to the byte (`apps/cli/src/publish.ts:10`), so two runs over an unchanged corpus write nothing and commit nothing, reporting `written: 0` and `commitSha: null`. That is what makes it safe on the cron.

Those artifacts are what make the store browsable: open `$MEMHTML_ROOT/index.html` in a browser and walk the corpus with no tooling at all.

## Publish is also the conflict resolution

`.gitattributes` marks `index.html` and `sitemap.xml` with `merge=ours`, and that attribute needs the per-clone `merge.ours.driver` config that [`memhtml init`](/learn/operations/initialize-a-store/) sets. If a merge has already written conflict markers into a generated file, leave the file itself alone.

Finish the merge however git needs you to, then run `memhtml publish` and let it overwrite the artifact. The generator is the authority for a derived file, so an edit you make by hand only produces a version the next publish discards.
