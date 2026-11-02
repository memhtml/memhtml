---
title: Set the store policy
description: Every key of memhtml.config.json with its library default, an example for a strict store, why a typo in the file stops writes instead of loosening them, and how memhtml config reports the policy in force.
---

```bash
memhtml config                                     # the policy in force, and where each value came from
git -C ~/memhtml add memhtml.config.json && git -C ~/memhtml commit -m "store policy"
```

`memhtml.config.json` at the store root holds the rules every writer to one store has to agree on: what the write bar refuses, whether the old record-creating commands stay open inside an agent run, and how the curator files records. With no file, every key takes the library's default: the bar refuses no type and requires no anchor, and the old record-creating commands close only inside an agent run. A store that wants a stricter bar writes the file.

## Where the file lives and when it's read

The file sits beside the corpus at the store root and is tracked in git, so a clone carries its rules with it. It isn't a memory. It's never indexed, no session can write it, and `list`, `publish`, and the sitemap leave it out.

Every process reads the file from the working tree, with no cache between calls: the CLI once per command that judges or creates a record, the head server once per request that judges one, and the MCP server once per record-creating tool call. An edit takes effect on the next call in every process, with no restart. Commit the file so every clone agrees, and use `memhtml config` to check that the working-tree copy is the committed one.

A broken file can't stop reads, search, or status, because none of them judges a record.

## The keys

Every key is optional, and an absent key is its library default.

| Key                      | Type                                                   | Default               | What it does                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writeBar.refusedTypes`  | an array of memory types, or of `{ "type", "reason" }` | `[]`                  | Types no session may write, the curator's included. The refusal shows the writer your `reason`, or a default sentence for a bare type name.                               |
| `writeBar.requireAnchor` | boolean                                                | `false`               | Every new record a session writes must name what it's about: at least one `memhtml-entity`, or a path under `projects/<slug>/`.                                           |
| `v1Doors`                | `"open"`, `"closed-in-session"`, or `"closed"`         | `"closed-in-session"` | Whether `memhtml write`, `apply`, `correct`, `task add`, and the MCP `memory_write`, `memory_write_batch`, and `memory_correct` tools may create records.                 |
| `curator.writerBuckets`  | an array of directory-name globs                       | `[]`                  | Directory names that name a writer, not a subject. The curator's briefing never offers one as a home, and `curate collapse` won't put a canonical in its members' bucket. |
| `curator.placementQuota` | an integer from 0 to 200                               | `60`                  | How many inbox records one `curate run` should file into their homes.                                                                                                     |

### writeBar

The write bar judges every record a session writes, through `session put`, `session exec`, `session commit`, and every curator command. `refusedTypes` takes a type by name, or with the reason the writer should read:

```json
{
  "writeBar": {
    "refusedTypes": [{ "type": "episodic", "reason": "a run narrative belongs in the trace index, not in memory" }, "verdict"],
    "requireAnchor": true
  }
}
```

A put that breaks the bar refuses the whole call and adds nothing:

```json
{
  "apiVersion": "1",
  "error": "invalid memory: session put refused, nothing appended: areas/inbox/builds-are-slow-on-mondays.html: below the write bar: names no system, project, or person: add at least one memhtml-entity (<meta name=\"memhtml-entity\" content=\"system:<name>\"> in the head, an entities value in a write op, or a label op) or write it in a workspace (projects/<slug>/)",
  "code": "ERR_INVALID_MEMORY",
  "suggestions": ["memhtml manifest"]
}
```

`requireAnchor` also holds for a `move`, whose destination has to be anchored, and for an `unlabel` that would leave a record with no entity outside `projects/<slug>/`. An archive is an existing record moving, so the anchor rule doesn't judge it. A task is anchored like any other record, by a `projects/<slug>/tasks/` path or by an entity.

### v1Doors

`memhtml write`, `apply`, `correct`, and `task add` commit straight to the store, and the write bar never sees them. `v1Doors` decides when they stay open:

| Mode                | `MEMHTML_SESSION` set            | `MEMHTML_SESSION` unset           |
| ------------------- | -------------------------------- | --------------------------------- |
| `open`              | open                             | open                              |
| `closed-in-session` | refused with `ERR_SESSION_BOUND` | open                              |
| `closed`            | refused with `ERR_SESSION_BOUND` | refused with `ERR_V1_DOOR_CLOSED` |

Both refusals exit 2 before anything opens, and their suggestions carry a `session put` line with placeholders to fill in. The default closes the doors only inside an agent run, because a run that writes through a session should land all its records through the bar and in one commit. `closed` makes sessions the only way records go in.

The MCP server has no per-call session. Its `memory_write`, `memory_write_batch`, and `memory_correct` tools read `MEMHTML_SESSION` from the server's own environment. Under `closed-in-session`, a server an agent runtime starts inside a run is closed, and a shared server started outside any run is open.

No mode closes reads. No mode closes the edits of records that already exist either: `link`, `archive`, `task status`, and `reinforce` on the CLI, and `memory_link`, `memory_archive`, and `memory_reinforce` on MCP.

### curator

`writerBuckets` takes globs over a single directory name, matched with `*` for any run of characters, `?` for one, and `[0-9]` for a class. A `/` is refused, because a pattern names a directory and never a path. `placementQuota` is capped at 200, the most operations one `curate run` commit can hold. Both feed the curator's briefing, and `placementQuota` also fills the `{{placementQuota}}` placeholder in its [charter](/learn/operations/curate-the-corpus/#brief-the-model-with-your-own-charter).

## What no setting turns off

The policy can only add refusals to the write bar. These hold for every session write in every store, whatever the file says:

- a file that doesn't parse as a memory, or has no single claim
- a duplicate of an active record's article
- a put over an active record with a different article
- a reserved path: `.memhtml/`, `memhtml.config.json`, any `index.html` or `sitemap.xml`, and outside curation `areas/arcs/` and `resources/people/`
- more than 200 operations in one `session commit`

At commit, a put whose claim has the same [frame key](/glossary/#conflict-assist-and-frame-key) as an active record at another path gets a `memhtml-contradicts` link to it, and both records stay live. A record that agrees with the put, that the put supersedes, or that the same batch archives gets no link.

## A strict store

This file refuses run narratives and review verdicts, and requires every record a session writes to name its subject. It keeps the default doors and tells the curator that two kinds of directories are writer buckets:

```json
{
  "writeBar": {
    "refusedTypes": [
      { "type": "episodic", "reason": "a run narrative belongs in the trace index, not in memory" },
      { "type": "verdict", "reason": "review output isn't a memory; keep it with the review" }
    ],
    "requireAnchor": true
  },
  "v1Doors": "closed-in-session",
  "curator": {
    "writerBuckets": ["*-import", "*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"],
    "placementQuota": 60
  }
}
```

The second bucket pattern matches a directory named with a trailing date, such as `notes-2026-10-18`. The date records when a writer made the directory and says nothing about the subject.

## A typo stops writes

The file is decoded strictly, and a problem is never read as "unset". Each of these is `ERR_STORE_CONFIG` at exit 1: a key the schema doesn't know (`requireAnchors` for `requireAnchor`), a value of the wrong type, an unknown memory type, a type listed twice, JSON that doesn't parse, and a file that can't be read. For the typo, the CLI prints:

```json
{
  "apiVersion": "1",
  "error": "the store's policy file /home/you/memhtml/memhtml.config.json is not usable, so nothing that needs the policy runs: Expected no excess property   at [\"writeBar\"][\"requireAnchors\"]",
  "code": "ERR_STORE_CONFIG",
  "suggestions": ["memhtml config", "fix or remove /home/you/memhtml/memhtml.config.json, then retry"]
}
```

Every command that needs the policy refuses this way until the file is fixed: `session put`, `session exec`, and `session commit`, the curator commands, the record-creating CLI commands and MCP tools, `memhtml config` itself, and the head server's commit, exec, and neighbors routes. The rule exists because a typo in a policy file must never quietly loosen the policy it was meant to state.

## Read the policy in force

```bash
memhtml config
```

```json
{
  "apiVersion": "1",
  "type": "config.report",
  "data": {
    "file": { "path": "/home/you/memhtml/memhtml.config.json", "present": true, "git": "committed" },
    "store": {
      "writeBar.refusedTypes": {
        "value": [{ "type": "episodic", "reason": "a run narrative belongs in the trace index, not in memory" }],
        "source": "file"
      },
      "writeBar.requireAnchor": { "value": true, "source": "file" },
      "v1Doors": { "value": "closed-in-session", "source": "default" },
      "curator.writerBuckets": { "value": [], "source": "default" },
      "curator.placementQuota": { "value": 60, "source": "default" }
    },
    "process": {
      "MEMHTML_EMBED_WARM_IDLE_MS": { "value": 0, "source": "default", "readBy": "head serve" },
      "MEMHTML_EXEC_POOL_SIZE": { "value": 4, "source": "default", "readBy": "head serve" },
      "MEMHTML_EXEC_WORKER_HEAP_MB": { "value": 2048, "source": "default", "readBy": "head serve" }
    }
  }
}
```

`file.git` says whether the working-tree copy matches git: `committed`, `modified`, `untracked`, or `absent`, and `unknown` when git can't answer. Each key under `store` carries its effective `value` and a `source` of `file` or `default`. `process` lists three of the variables `head serve` reads, each with a `source` of `env` or `default`, and adds a `problem` when a value is one the server would refuse. The command reads only the file, its git status, and the environment, so it answers on a store whose index was never built.

## Tighten the policy on a live store

The bar is read again when a session commits, so a stricter file also judges operations that were added before you changed it. An open session can then answer `refused` at commit time for a line its put accepted. Before you tighten the bar, find the sessions still holding operations with `memhtml session prune --older-than 0s --dry-run`, or let the runtime's `--drop-refused` take the refused lines out. [Write through a session](/learn/operations/write-through-a-session/) covers both.
