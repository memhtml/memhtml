# What a second opener of a live index can do, and how the same question got answered wrongly twice

**Tags**: turso, libsql, wal, locking, read-only, code-mode, probe-discipline
**Modules**: packages/index, apps/cli/src/serve.ts, scripts/probe-turso-locking.mjs
**Probe**: `node scripts/probe-turso-locking.mjs` — run it rather than citing this file

## The measured behaviour

`@tursodatabase/database` 0.7.2, with the repo's exact `experimental: ["index_method","attach"]`
flags (`packages/index/src/database.ts:39`), against a database held open by a **separate process**
that keeps writing:

| Second opener | Open | Read | Write |
|---|---|---|---|
| `connect(path)` — default, from another process | **fails**: `Locking error: Failed locking file` | — | — |
| `connect(path, { readonly: true })` — another process | succeeds | succeeds | refused: `Resource is read-only` |
| `PRAGMA query_only = 1` — another process | **fails at open** | — | — |
| checkpointed copy + `chmod 0444` + `readonly` | succeeds | succeeds (stale) | refused |
| `connect(path, { readonly: true })` — **same** process as the writer | succeeds | succeeds | **ALLOWED**, including `DROP TABLE` |

Four consequences, in the order they change a design:

1. **The lock is a WRITER lock.** `journal_mode` is already `wal` by driver default — nothing in the
   repo sets it. WAL is why a read-only opener gets in at all; it is not why a default opener is
   refused. A default `connect()` wants a writable handle, and there is one writer at a time.
2. **`readonly: true` is the mechanism, and it is enforced cross-process.** INSERT, UPDATE, and
   `DROP TABLE` all fail with `Resource is read-only`.
3. **`PRAGMA query_only` cannot serve this case.** It is a statement, so it needs a connection, and
   the open is the step that fails. It is the right tool only for de-privileging a handle you
   already hold, which is not the situation any second process is in.
4. **A read-only handle is pinned at open.** Three sequential opens against the same live writer read
   1, then 11, then 21 rows, while each individual handle reported the same count 1.5s apart. A
   long-lived reader silently serves an ever-staler snapshot. Reopen per query if freshness matters.

## Why this is written down at this length

The question "can a second process read the index" was answered wrongly **twice in one session**,
in opposite directions, and both wrong answers were backed by a probe that ran and printed output.

- **Round one** believed a recorded lesson: "Turso's lock is exclusive." True as recorded, from a
  real incident (`memhtml serve mcp` deadlocking its own child, `apps/cli/src/serve.ts:72`). It got
  restated as "a second handle onto a live index fails," which drops the qualifier that carries the
  meaning.
- **Round two** probed two connections in **one process**, found reads and writes both worked, and
  concluded the lock claim was false and `readonly: true` was decorative. Both conclusions were
  artifacts of the process boundary the probe failed to cross. Same-process results do not transfer:
  the last row of the table above is that finding, preserved as the trap it is.
- **Round three** spawned a real second process, and the original lesson turned out to be right
  about the lock and incomplete about the flag.

The failure mode is not carelessness. Each probe tested a case that **looked** equivalent to the
real one. The generalizable rule: when a constraint is about a boundary — process, connection,
privilege, host — the probe must cross that exact boundary, and a probe that crosses a *similar*
boundary is not weaker evidence, it is evidence about something else. Name the boundary in the
probe's own output so a reader can see which one was crossed.

Corollary for lessons: a terse lesson decays into a wrong one. "Turso's lock is exclusive" kept its
mechanism and lost its scope. Record the qualifier in the claim itself, not in the surrounding prose.

## What depends on this

- **`memhtml exec` (ROADMAP item 7) exposes no index handle in v1** — structural and lexical planes only,
  a decision that stands on scope rather than on this finding. If a handle is ever added: it is a
  second process, so `readonly: true` is both available and enforced, and the pin-at-open staleness
  is the property to design around.
- **The RUNBOOK rule stands** (`RUNBOOK.md`, section 4): never run a CLI command against a repo while
  `memhtml serve mcp` is serving it. Every CLI command builds a writable app layer, so it takes the
  default path that fails. The rule is unchanged; its stated mechanism is now precise.
- **Integration tests must still shut the server down** before asserting index rows
  (`tests-integration/tests/mcp-stdio.test.ts`) — assertions need a writable handle.
