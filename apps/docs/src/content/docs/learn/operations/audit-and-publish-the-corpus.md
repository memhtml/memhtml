---
title: Audit and publish the corpus
description: Every memhtml doctor finding and its fix, what --fix will and will not repair, and how memhtml publish resolves a conflict in a generated file.
---

```bash
memhtml doctor          # eight checks
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

Every list is present and possibly empty, so a parser never has to branch on a missing key. `healthy` is
true when every check is clean.

## The findings

| Finding | Meaning | Fix |
|---|---|---|
| `dangling` | A `<link>` points at a path the tree does not hold. | `--fix` rewrites it to the archive path, or drops it when the target is gone. |
| `orphanAccessRows` | A `state.access` row whose path left the tree. | `--fix` prunes it. |
| `inboxCrowded` | Over 20 active memories in `areas/inbox/`: the placement rules stopped matching what agents write. | Re-place them, or revisit the rules. |
| `inboxTasksCrowded` | Over 10 open tasks in `areas/inbox/tasks/`: work with no project. | Drain it. A task inbox is meant to be drained, not accumulated. |
| `overdueTasks` | An open task whose `memhtml-due` has passed. | Doctor is the **only** surface reading `due_at` — a task is default-excluded from search and skipped by every sleep phase. |
| `staleBlockers` | A `blocks` edge whose blocker is archived or absent. | Decide whether the blocked task is ready. Each file alone is valid; only the pair is wrong. |
| `warnings` | An element outside the closed vocabulary. The file still indexes. | Author's intent — doctor will not guess. |
| `unparseable` | A file the parser refuses. It is **not** in the index. | Read the violations with `memhtml read <path>`, fix the file, then `memhtml index rebuild`. |
| `indexFresh: false` | The index describes an older commit. | `memhtml index update --embed`. |
| `embedModelMatches: false` | Stored vectors are in a different space from the configured one. | Delete the database and rebuild — see [rebuild the index](/learn/operations/rebuild-the-index/). |

The two inbox thresholds are `INBOX_WARN_DEPTH` 20 and `INBOX_TASK_WARN_DEPTH` 10
(`apps/cli/src/doctor.ts:69`, `apps/cli/src/doctor.ts:78`).

`overdueTasks` is worth reading twice. A `task` memory is excluded from search by default and skipped by
every sleep phase, so `memhtml doctor` is the only thing in the system that will ever tell you a task went
past its due date. If you use tasks, this command belongs on your cron.

## What --fix repairs, and why only two

`--fix` repairs `dangling` hrefs and prunes `orphanAccessRows`. Everything else needs a decision doctor is
not entitled to make: a crowded inbox might be a bad day or bad placement rules, an element outside the
vocabulary might be exactly what the author meant, and an unparseable file needs a human to look at the
violations.

`--fix` under the hood reuses the sleep integrity phase's byte-splicing repair logic rather than a second
implementation. That is not code tidiness — a repair routed through the serializer would move the content
hash of every file it touched, which would look like a body change in the next `memhtml sleep review` and
would re-embed the file for no reason.

Under `--fix` the report gains a `repaired` object counting hrefs `rewritten` (pointed at the target's
archive path) and `dropped` (the target has no file anywhere).

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

`memhtml publish` regenerates the per-directory `index.html` listings and `sitemap.xml` and commits them.
It is **deterministic to the byte** (`apps/cli/src/publish.ts:10`), so two runs over an unchanged corpus
write nothing and commit nothing — `written: 0` and `commitSha: null`. That is what makes it safe on the
cron.

Those artifacts are what make the store browsable: open `$MEMHTML_ROOT/index.html` in a browser and walk
the corpus with no tooling at all.

## Publish is also the conflict resolution

`.gitattributes` marks `index.html` and `sitemap.xml` `merge=ours`, and that attribute needs the
per-clone `merge.ours.driver` config that [`memhtml init`](/learn/operations/initialize-a-store/) sets. If
a merge has already written conflict markers into a generated artifact, do not hand-edit it:

Finish the merge however git needs you to, then run `memhtml publish` and let it overwrite the artifact.
Regenerate rather than repair: the file is derived, so the generator is the authority and hand-editing it
only produces a version the next publish discards.
