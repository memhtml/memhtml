# v2 proof of concept: the corpus as a value

Branch `v2-poc`. This document is the spec every implementer on the branch reads first. It records what the proof of concept builds, the contract each package implements, and the definition of done. `docs/design.md` describes the shipped v1 system; this file describes what changes.

## Why

Three measurements on the live store (2026-09-22, 8,213 files, 2,216 commits) motivate the change. Two thirds of active memories sit in `areas/inbox/` because placement is decided at write time and retrieval never reads paths. Retention triage put 2,851 of 2,955 scored memories in the compress band while compress processed 7 a night, so the sixteen-phase pipeline disagrees with itself about the corpus. One 124 s `memory_search` holding the single SQLite writer blocked the index update behind it, because every reader and every writer share one process and one database.

The v2 shape keeps what the benchmark campaign and the filesystem-memory literature both support: git as the system of record, one fact per file, the closed HTML vocabulary, and a human at the merge of curation. It changes how the corpus is held in memory, how a session writes, and how conflicts are settled.

## The shape

The corpus is a value. Every version is immutable, a session sees exactly one version plus its own deltas, sharing is by pointer, and change is by append. Five clusters, top to bottom:

1. Agents. N sessions. Each holds a pointer to a head version, an overlay log of its own operations, and nothing else.
2. DRAM. One head process holds the parsed corpus as a persistent map from path to `MemoryRecord`, with derived indexes. Advancing to a new commit builds a new version that shares every untouched node with the old one.
3. Commit path. Mechanical, no model call. Validate, check disjointness against `main`, check frame-key conflicts, write blobs, write tree, commit, update the ref with compare-and-swap.
4. Disk. The git object store is truth. A columnar snapshot per commit is the cold-start cache. A per-session index file plus a ref is the durable twin of a session's overlay.
5. Curation. Judgment runs as a session on a `curate/<date>` branch behind the existing gate. It is never in the write path.

## Scope of the proof of concept

In scope: packages `@memhtml/head`, `@memhtml/session`, `@memhtml/snapshot`; a sandbox that runs a script over head plus overlay and harvests its writes into the overlay; CLI commands `session start|put|exec|commit|status`, `head status|search|snapshot`; an integration test that drives N concurrent sessions through disjoint, overlapping, duplicate, and frame-key-conflicting commits; this document plus a `design.md` section.

Out of scope, recorded here so nobody builds them by accident: a long-lived head server process; vector retrieval over the head (the interface exists, the fake embedder is the only implementation); any change to the v1 write path, sleep pipeline, or MCP server; migration of the live store.

## Shared contract: `@memhtml/contracts` `record.ts`

`MemoryRecord`, `HeadView`, `OverlayOp`, `hrefToPath`, `pathToHref`. Already written. Every new package imports these and nothing else from each other except as listed below. A change to this file is an orchestrator decision, not an implementer's.

## `@memhtml/head`

Owns `packages/head`. Depends on contracts, domain (`frameKeyOf`), html (`parseMemory`, `contentHash`), store (`makeGit` for `revParseHead`, `lsTreeR`, `catFileBatch`, `diffTreeNames`).

Exports:

```ts
export const recordFrom: (input: { path: string; html: string }) => Effect.Effect<MemoryRecord, InvalidMemory>
export const blobShaOf: (html: string) => string  // sha1("blob <byteLength>\0" + bytes), must equal git hash-object
export interface HeadVersion extends HeadView {
  readonly sha: string
  readonly parent: HeadVersion | null
  readonly lexical: LexicalIndex
}
export const loadHead: (git: GitShape, sha: string) => Effect.Effect<HeadVersion, GitFailure | InvalidMemory>
export const advanceHead: (git: GitShape, from: HeadVersion, to: string) => Effect.Effect<HeadVersion, GitFailure | InvalidMemory>
export const withOverlay: (base: HeadView, ops: ReadonlyArray<OverlayOp>) => Effect.Effect<HeadView, InvalidMemory>
export const searchHead: (view: HeadView, input: { query: string; limit?: number; now?: string }) => ReadonlyArray<SearchHit>
export interface SearchHit { readonly path: string; readonly score: number; readonly arms: ReadonlyArray<"lexical" | "recency"> ; readonly claim: string }
```

Rules:

- Records live in an `effect` `HashMap<string, MemoryRecord>`. Every derived index is also a persistent structure (`HashMap`, `HashSet`). `advanceHead` re-parses only the paths `diffTreeNames(from.sha, to)` names and rebuilds only the index entries those records touch. A test proves structural sharing: after advancing by one file, the untouched records are the same object references (`toBe`), and the property holds under `fast-check` over random edit sets.
- `loadHead` streams blobs with one `catFileBatch` call. A file that fails `parseMemory` is skipped and counted in a `skipped` field on the version, never thrown, because the live store holds files older than the current constraints.
- Indexes: `byContentHash` (active only), `byFrameKey` (active only), `inbound` (by href), `byEntity`, and the lexical index (token to path set, tokens lowercased on `\W+`, stop words dropped). The lexical index is per version and shares untouched buckets with its parent.
- `searchHead` fuses a lexical arm (BM25 over title plus claim plus body, or a simpler TF-IDF, stated in a comment) and a recency arm (`eventAt ?? updatedAt`) with RRF k=60, weights 1.0 and 0.5, over active records only. Ranking is deterministic.
- `withOverlay` applies ops in order: `put` parses and inserts, `archive` moves the record to `to` with `archived: true`, `link` re-parses the file with the edge added (use `@memhtml/html` `addLink`, whose head-only splice leaves the content hash unchanged). The result is a `HeadView` whose `sha` is the base's.
- Census tests: a generated fixture of at least 300 files (`@memhtml/eval` `gen-fixture` writes one; or build one inline from `renderTemplate`) loaded through a real temp git repo, asserting the record count equals the `ls-tree` count minus the skipped count, computed independently.

Deltas landed, where the implementation departs from the contract above:

- `advanceHead` reads the changed paths with `git diff-tree -r -z --name-only --no-renames <from> <to>` through `GitShape.run` plus `parseNulPathList`, rather than the store's `diffTreeNames`. The two trees are compared directly, so a range of many commits costs one subprocess, and a rename contributes both of its paths.
- `loadHead` reports `skipped` (a count) and `skippedFiles` (path plus the parser's reason), so a census can name what it left out.
- `README.html` at the repository root is skipped by design: the scaffold writes it memory-shaped, it predates the format's constraints, and `isCandidatePath` admits it so the skip is counted rather than hidden.

## `@memhtml/session`

Owns `packages/session`. Depends on contracts, domain, html. Spawns git itself with `node:child_process` `execFile`, because the store's `Git` service strips `GIT_INDEX_FILE` from every child. Never imports `@memhtml/store`.

Exports:

```ts
export interface Plumbing {
  readTree(sha: string): Effect<void, GitFailure>                       // into the session index file
  hashObjectWrite(bytes: Uint8Array): Effect<string, GitFailure>         // -w --stdin
  updateIndexAdd(entries: ReadonlyArray<{ mode: "100644"; sha: string; path: string }>): Effect<void, GitFailure>   // --add --cacheinfo, batched via --index-info on stdin
  updateIndexRemove(paths: ReadonlyArray<string>): Effect<void, GitFailure>   // --force-remove
  writeTree(): Effect<string, GitFailure>
  commitTree(tree: string, parents: ReadonlyArray<string>, message: string): Effect<string, GitFailure>
  updateRef(ref: string, next: string, expected: string | null): Effect<"updated" | "raced", GitFailure>   // update-ref with old value; a non-zero exit whose stderr names the ref as changed is "raced"
  revParse(ref: string): Effect<string | null, GitFailure>
  diffTreePaths(from: string, to: string): Effect<ReadonlyArray<string>, GitFailure>   // diff-tree -r --name-only --no-renames
  readTreeIntoWorktree(from: string, to: string): Effect<void, GitFailure>   // read-tree -m -u from to, on the shared index (no GIT_INDEX_FILE); waits briefly on a held index.lock
  headRef(): Effect<string | null, GitFailure>                              // the branch HEAD points at, null when detached
  dirtyPaths(paths: ReadonlyArray<string>): Effect<ReadonlyArray<string>, GitFailure>   // status --porcelain over the shared index, limited to paths; staged, modified, or untracked
  isAncestor(sha: string, ref: string): Effect<boolean, GitFailure>         // merge-base --is-ancestor
}
export const makePlumbing: (input: { root: string; indexFile: string }) => Plumbing

export interface Session {
  readonly id: string
  readonly baseSha: string
  readonly ref: string                 // refs/heads/main by default, refs/heads/curate/<date> for a curator
  readonly ops: ReadonlyArray<OverlayOp>
  readonly pending?: string            // a commit built and possibly landed by a call that was killed; settled by the next commit
}
export const startSession: (input: { root: string; id: string; base: HeadView & { sha: string }; ref?: string; force?: boolean }) => Effect<Session, GitFailure | StorageFailure>   // an id that already has a log fails with StorageFailure `session.exists` unless force
export const resumeSession: (input: { root: string; id: string }) => Effect<Session, StorageFailure>
export const appendOps: (session: Session, ops: ReadonlyArray<OverlayOp>) => Effect<Session, StorageFailure>   // persists the log, under the session's lock
export const withSessionLock: <A, E, R>(root: string, id: string, effect: Effect<A, E, R>) => Effect<A, E | StorageFailure, R>   // exclusive per id; a held lock fails at once with `session.locked`
export type CommitScope = "session" | "curate"
export interface ValidateOptions { scope?: CommitScope }   // default "session"
export const validateOps: (view: HeadView, ops: ReadonlyArray<OverlayOp>, options?: ValidateOptions) => ReadonlyArray<Violation>
export const isReservedPath: (path: string, scope?: CommitScope) => boolean
export type Violation =
  | { kind: "format"; path: string; reasons: ReadonlyArray<string> }
  | { kind: "duplicate"; path: string; existing: string }
  | { kind: "claim-edit"; path: string }          // put over an active path with a different content hash
  | { kind: "reserved-path"; path: string }       // .memhtml/, index.html, sitemap.xml under every scope; areas/arcs/ and resources/people/ unless scope is "curate"
  | { kind: "batch-cap"; count: number; cap: number }   // cap 200 ops
export const commitSession: (input: { session: Session; head: HeadView & { sha: string }; message: string; archivedAt?: string; scope?: CommitScope }) => Effect<CommitOutcome, GitFailure | StorageFailure>   // scope names the subject (memhtml(<scope>): ...) and is passed to validateOps
export type CommitOutcome =
  | { kind: "committed"; sha: string; paths: ReadonlyArray<string>; contradictions: ReadonlyArray<{ path: string; against: string }>; worktreeSynced: boolean; recovered: boolean }
  | { kind: "rebase-needed"; overlapping: ReadonlyArray<string>; mainSha: string }
  | { kind: "refused"; violations: ReadonlyArray<Violation> }
  | { kind: "worktree-dirty"; paths: ReadonlyArray<string> }   // HEAD is the ref and the checkout holds uncommitted state at a path this commit writes or removes; nothing moved
export const rebaseSession: (session: Session, onto: HeadView & { sha: string }) => Session   // moves baseSha, keeps ops; validation happens at the next commit
```

Commit algorithm, in order. The whole call holds the session's lock (`withSessionLock`), so two commits of one id cannot interleave on the shared `.idx` and a `put` cannot rewrite the log mid-commit; a second writer fails with `session.locked` rather than waiting.

0. Recovery. A log carrying `pending` names a commit an earlier call built and may have landed before it was killed. If `isAncestor(pending, ref)` it landed: answer `committed` for it with `recovered: true` (paths from `diff-tree`, contradictions not re-derived), clear the log, record provenance. Otherwise roll the checkout back if it had followed (`readTreeIntoWorktree(pending, pending^)`), drop `pending`, and continue.
1. `validateOps(head, session.ops, { scope })`; any violation returns `refused` and writes nothing. The scope is the caller's (`session` by default, `curate` from the curator), so an `areas/arcs/` or `resources/people/` path lands only from a curator's commit. An `archive` op's `html` must carry the source record's article (`contentHash` equal), because the body written is the source as the commit sees it, not the op's bytes.
2. `mainSha = revParse(session.ref)`. If it differs from `head.sha`, the version that was validated, return `rebase-needed` with `mainSha` and `overlapping` = the paths the ops touch that `diffTreePaths(head.sha, mainSha)` names (possibly empty). There is no path-disjoint fast path: a duplicate content hash or a frame-key rival is a collision between different paths, so only a head rebuilt at the tip can judge it, and the CAS in step 6 must cover the version step 1 and step 3 read. `parent = mainSha ?? head.sha`.
3. Frame-key check against the head: for each `put` whose record has a frame key that `head.byFrameKey` resolves to a different active path, add `<link rel="memhtml-contradicts" href="/that/path">` to the new file's head (`addLink`) and record the pair in `contradictions`. Both stay live. Nothing is auto-archived.
4. `readTree(parent)` into the session index file; `hashObjectWrite` each body; `updateIndexAdd` for puts and archive destinations; `updateIndexRemove` for archive sources; `writeTree`; `commitTree(tree, [parent], message)` with the `memhtml(session): ...` subject form and a `Memhtml-Session: <id>` trailer. An archive destination's body is the source as staged (an earlier op in the batch, else `head.get(path).html`) with the archive stamps, so a link the source gained since the op was minted travels with the copy.
5. If `headRef()` is `session.ref`, the checkout follows before the ref moves: `dirtyPaths(paths)` non-empty returns `worktree-dirty` and nothing moves; else `readTreeIntoWorktree(parent, commit)` brings the shared index and working tree to the new tree (a two-tree merge, so uncommitted edits at other paths survive). Moving the ref first would leave `HEAD` ahead of the index on any failure, and git then reports the session's own files as staged deletions that the next `git commit -a` or v1 `write` commits; a checkout left one step ahead by a failure here shows them as staged additions, which step 0 reverts and no human commit can turn into a loss.
6. Write `pending: commit` to the log. `updateRef(ref, commit, expected = mainSha)`. `raced` means someone else advanced between step 2 and now: roll the checkout back, clear `pending`, return `rebase-needed` with the new `mainSha`; the caller rebases and retries.
7. Persist the log at once (`baseSha: commit`, `ops: []`, no `pending`), then set `refs/memhtml/sessions/<id>` to the commit for provenance as a best effort (a failure is logged, never raised). `worktreeSynced` is true when the checkout followed in step 5 and false when the ref is not checked out.

Session state on disk: `.memhtml/sessions/<id>.idx` (the git index file), `.memhtml/sessions/<id>.json` (`{ id, baseSha, ref, ops, pending? }`, written atomically via a temp file and rename), and `.memhtml/sessions/<id>.lock` while a writer holds the session (proper-lockfile: an atomic `mkdir` whose mtime is refreshed while held, so a lock left by a killed process goes stale in 30 s and is reclaimed). All are gitignored by `.memhtml/`.

Tests, all against a real temp git repo created with `git init -b main` and the store's `configureIdentity`:

- `blobShaOf` equals `git hash-object` for ASCII and multibyte content.
- Two sessions on the same base committing disjoint files both land; the second sees exactly one `rebase-needed` with `overlapping: []`, then `committed` after a rebase, and `git log` shows two commits.
- Two sessions putting the same path: the second gets `rebase-needed`, rebases, and then `refused` with `claim-edit` if its hash differs or `duplicate` if identical.
- Same content hash from two sessions: the second is `rebase-needed` while its head is stale (the duplicate never lands on a disjoint advance) and `refused` with `duplicate` naming the first's path once rebased. Frame-key rivals from two sessions behave the same way, and the second carries a contradicts link to the first.
- An archive op carries a link added by an earlier link op in the same batch, and one minted before main linked its source carries main's link after the rebase.
- A checkout of the ref follows the commit, also beside an unrelated uncommitted edit; a session path the checkout holds uncommitted is `worktree-dirty` with nothing moved; a porcelain commit from the shared index after a session commit keeps the session's file on main.
- A commit killed after the swap (log restored with `pending`) is `committed` with `recovered: true` on the next call; a `pending` that never reached the ref is dropped and the checkout rolled back.
- Two commits of one session at once: one lands, the other fails with `session.locked`, the log is empty and the file is on main.
- `startSession` on an id that has a log fails with `session.exists` and keeps the log; `force` replaces it.
- Frame-key conflict: both files live after commit, the new one carries the contradicts link, `git cat-file` shows it.
- `updateRef` race: advance the ref by hand between validation and update, assert `rebase-needed`.
- Every guard is mutation-verified: the test file states, per guard, the one-line change that makes it fail (a comment naming the function and condition), and the suite was run once with that change applied.

Deltas landed, where the implementation departs from the contract above:

- `Session` carries `root` (the repository root). It is not persisted: the log is found by root plus id, so the two cannot disagree.
- `CommitOutcome.committed` carries `worktreeSynced: boolean` (the ref was checked out and the shared index and working tree moved with it) and `recovered: boolean` (step 0 answered for an earlier call's commit). `worktree-dirty` is a fourth outcome kind.
- `Plumbing` gains `headRef()`, `dirtyPaths(paths)`, and `isAncestor(sha, ref)`. All read the shared index or the object graph, and step 5 reads them before the ref moves.
- There is no `syncWorktree` option: when `HEAD` is the session's ref the checkout always follows, because a ref that moves without its index makes git report the session's own files as deletions; when it is not, there is nothing to follow.
- `commitSession` takes an optional `archivedAt`, the instant archive ops stamp, so a test can pin it. It defaults to now.
- `saveSession` is exported, so a caller that rebased can persist the moved base without appending an op. It takes the session's lock; `saveSessionLocked` is the variant for a caller already holding it.
- `Session.pending` and `startSession`'s `force` are as described above; `session status` reports `pending` (`null` when none).

## `@memhtml/snapshot`

Owns `packages/snapshot`. Depends on contracts and `apache-arrow`.

```ts
export const writeSnapshot: (input: { records: Iterable<MemoryRecord>; sha: string; path: string }) => Effect<{ bytes: number; rows: number }, StorageFailure>
export const readSnapshot: (path: string) => Effect<{ sha: string; records: ReadonlyArray<MemoryRecord> }, StorageFailure>
export const snapshotPathFor: (root: string, sha: string) => string   // .memhtml/snapshots/<sha>.arrow
```

One Arrow IPC file, one row per record, list-typed columns for tags, entities, links (struct), facets (struct); `sha` in the schema metadata. Round-trip test over a generated set of 1,000 records asserts deep equality and reports bytes and read time in the test name. A second test opens the file with `tableFromIPC` over a `Buffer` and confirms zero copies of the `html` column are made before a row is touched (assert the table's batch count and that reading one row does not iterate the others, via a counter on a lazy vector accessor if the library exposes one; if it does not, state that in the test and measure read time for one row versus all rows).

## Sandbox over head plus overlay: `apps/cli/src/session-exec.ts`

Owns that one new file plus `apps/cli/tests/session-exec.test.ts`. Reuses the sandbox construction in `apps/cli/src/exec.ts` and `apps/consolidator/src/mount.ts` by import, without editing either. Does not touch `commands.ts` or `run.ts`.

```ts
export const runSessionExec: (input: { view: HeadView; script: string; timeoutMs?: number; scope?: CommitScope }) => Effect<SessionExecReport, StorageFailure>
export interface SessionExecReport extends ExecReport { readonly ops: ReadonlyArray<OverlayOp>; readonly rejected: ReadonlyArray<{ path: string; reason: string }> }
```

The guest filesystem is seeded from `view.records()` under `/mnt/memhtml` with no disk worktree and no `git worktree add`. The mount is writable. After the script exits, the harvester walks `/mnt/memhtml`, compares each file's bytes against the seeded set, and turns a new `.html` into a `put`, a seeded `.html` whose article changed (content hash differs) into a `put` of the same path (which `validateOps` refuses as `claim-edit`; that is the store's rule, and the harvester only reports it), and a missing file into a `rejected` entry (deletion is not an operation; archiving is a `put` at the archive path plus the source going missing, which the harvester pairs into one `archive` op when the article hash matches). Files outside `.html`, under `.git`, or named `index.html` are rejected with a reason. The `corpus.mjs` helper is preloaded exactly as `exec` does it. A test seeds 50 records, runs a script that writes two files and edits one head, and asserts the harvested ops.

The link rule: a seeded file still at its path whose bytes changed but whose article content hash did not is a head edit candidate. The hash digests the article's canonical text, not its bytes, so an equal hash proves the words are the same and nothing more; the harvester parses both versions with `@memhtml/html`'s `parseMemory` and compares their heads and their article markup. Every `<link rel="memhtml-...">` present after and absent before becomes one `{ kind: "link", path, rel, href }` op, so an edge can be placed from code mode by splicing a line before `</head>`. A link removed, a title or meta changed, article markup changed with the words kept (a `<dfn>` wrap, a new `<aside>`), or any other head content changed (a comment, a `<meta>` outside the vocabulary) is `rejected` with the reason `head edit other than adding links is not an operation`; when links were added beside such a change the reason names both the added links and the other change, and a byte change that added no link is rejected as such. Every changed seeded file is therefore in `ops` or in `rejected`, never silently dropped. The archive twin is held to the same rule: a link added to the twin's head becomes a `link` op on the source path, emitted before the archive op so the commit's staging (which builds the archived copy from the source as the batch left it, never from the op's bytes) carries the edge into the copy; any other head or markup difference between the source and its twin rejects the source and leaves the twin as a put.

`runSessionExec` takes an optional `scope` (`CommitScope`, default `session`), which the harvester's reserved-path check uses the way `validateOps` does: under `curate` an `areas/arcs/` or `resources/people/` file is a `put`, while `.memhtml/`, `index.html`, and `sitemap.xml` stay rejected.

## CLI commands (integrator)

Add to `COMMANDS`, `RESPONSE_TYPES`, and `dispatch`, then regenerate `AGENTS.md`:

| command          | flags                                                                         | response type                                      |
| ---------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `session start`  | `--id`, `--ref`, `--force`                                                    | `session.started`                                  |
| `session put`    | `--id`, `--file` (JSONL of `write` ops as `apply` takes)                      | `session.appended`                                 |
| `session exec`   | `--id`, `--script` or `--file`, `--timeout-ms`                                | `session.exec.report`                              |
| `session commit` | `--id`, `--message`                                                           | `session.committed` (data carries `CommitOutcome`) |
| `session rebase` | `--id`                                                                        | `session.rebased`                                  |
| `session status` | `--id`                                                                        | `session.status`                                   |
| `head status`    |                                                                               | `head.status` (sha, records, skipped, load ms)     |
| `head search`    | `query`, `--limit`                                                            | `head.search`                                      |
| `head snapshot`  | `--write` / `--read`                                                          | `head.snapshot`                                    |
| `curate merge`   | `ref`, `--into` (default `main`), `--skip-gate`                               | `curate.merged`                                    |
| `curate run`     | `--ref`, `--model`, `--max-steps`, `--wall-clock-ms`, `--dry-run`, `--resume` | `curate.run`                                       |

`session rebase` is the caller's half of the retry loop: `session commit` answers `rebase-needed` whenever the ref has moved past the session's base and never retries on its own, so a caller reloads the base with `session rebase` and commits again, or reads the `refused` that follows and decides. `session exec` appends its harvest only when the script exited 0 and no harvested op carries a violation a rebase cannot cure (format, reserved path, batch cap), judged the way `session put` judges its puts; the report carries `violations` and `blocking` either way. `session start` on an id that already has a log is refused (`ERR_STORAGE`, `session.exists`) unless `--force`. The head is loaded per invocation in this proof of concept: from the snapshot at `.memhtml/snapshots/<sha>.arrow` when one exists for `HEAD`, else from git, and `head status` reports which. A long-lived head process is deferred.

### Curation door

A curator is a session on a branch. `session start --id curate-2026-09-23 --ref curate/2026-09-23` opens it on `main`'s tip (a bare branch name gets `refs/heads/` prepended; the ref does not exist yet, so the base is `HEAD`), the curator works through `session put` and `session exec` like any other session, and its first `session commit` creates the branch: step 2 finds no ref, so the parent is the base, and the compare-and-swap in step 6 expects the ref to be absent. `main` and the checkout do not move, because the ref committed to is not the one `HEAD` points at.

`curate merge <ref> [--into main] [--skip-gate]` is the door back. Both refs must resolve; then the landing takes one of two shapes, decided by `merge-base --is-ancestor`. In either shape a call that fails leaves the repository as it found it, and the discrimination gate runs after every refusal and before anything moves.

When `ref` is a descendant of `--into`, the landing is a fast-forward, in order:

1. The discrimination gate from `@memhtml/eval` runs in `fake` mode over its generated fixture corpus, the same call the v1 merge composed. A failing gate is exit 1, `ERR_DISCRIMINATION_FAILED`, with the inversion count, probe count, MRR, and floor in the message, and nothing has moved. `--skip-gate` is a logged override for a checkout without the eval corpus; the payload's `gate.ran` says which happened.
2. When `HEAD` is `--into`, the checkout follows before the ref moves, the way `commitSession` step 5 does it: an uncommitted change at a path the landing touches is `ERR_DIRTY_TREE` and nothing moves; otherwise `read-tree -m -u from to` brings the shared index and working tree along.
3. `update-ref --into to from` as a compare-and-swap through the session package's `Plumbing.updateRef`. A `raced` answer means another writer advanced `--into` while the gate ran: the checkout is rolled back and the call refuses naming the new tip.

When `ref` is not a descendant of `--into`, because `--into` moved past the curator's base (on the live store fleet writes land on `main` every few minutes, so this is the usual case), the landing is a replay: the curator's operation log is rebuilt from the branch and committed as one fresh session on `--into`'s tip. A commit on a curate ref is a pure function of overlay ops, so the difference between two trees is decidable back into ops, and anything that is not was written by hand. In order:

1. The merge base of `ref` and `--into` is computed, and `git diff-tree -r -z --no-renames <base> <tip>` names every path the two trees disagree on, with the bodies read in one `cat-file --batch` (`apps/cli/src/replay.ts`, `readCurateDelta`). The reconstruction (`reconstructOps`) is the harvester's comparison from `session exec` (`harvestOps` in `session-exec.ts`, called with the base tree as the seeded set and the tip tree as what the script left): an added `.html` is a `put`; a file gone from its path beside an added `archive/<YYYY>/<that path>` whose article content hash equals the source's is one `archive`; a file still at its path with the same article whose head gained `<link rel="memhtml-...">` edges is one `link` per edge, and so is an edge the archive twin's head gained (a `link` on the source, staged before the archive so the copy carries it). One thing differs from a sandbox run: an archive twin carries the stamps `commitSession` wrote (`memhtml-status archived`, `memhtml-archived <instant>`), which the harvester would read as a meta change, so the seeded side of an archived source is restamped with the same `archiveBody` at the instant the twin names before the comparison. The ops come out in the harvester's order, puts then links then archives, which `validateOps` accepts because a link may name a target its batch creates later. Anything else refuses the merge naming the path and the reason, with nothing moved: a file deleted with no twin, an article changed in place (the harvester reports this as a put for `validateOps` to refuse as `claim-edit`; the replay refuses it by name first), a link removed, a title or meta changed, a twin whose article differs, a file that is not a memory, a type change. A removed link is refused rather than replayed as an `unlink`, since the op vocabulary has no such op.
2. The head is loaded at `--into`'s tip, a session is started on `--into` with id `merge-<first seven of the tip sha>` and `force` (so a merge killed mid-way can be rerun), the reconstructed ops are appended, and `validateOps` judges them under the `curate` scope against that tip. Any violation refuses the whole merge with the violations listed and nothing moved: a `duplicate` or `claim-edit` because `--into` gained the same fact meanwhile, a link whose target is gone, a reserved path.
3. The gate, exactly as in the fast-forward shape.
4. `commitSession` under scope `curate`, with the subject `memhtml(curate): <the curate tip's subject, its own memhtml(curate): prefix taken off> (replayed onto <short sha of the tip landed on>)`, through a rebase-and-retry loop bounded at eight (`MERGE_ATTEMPTS`, the bound `curate run` uses): `rebase-needed` reloads the head at the new tip, moves the session's base, and tries again; a `refused` after a rebase surfaces the violations; `worktree-dirty` is `ERR_DIRTY_TREE`. The commit path does the compare-and-swap on the ref and syncs the checkout when `HEAD` is `--into`. The archive ops are stamped at the instant the curator's twins carry when every twin agrees on one, else at now.
5. Once landed, the curate ref is moved to the landed commit with a compare-and-swap against its old tip, so `ref` descends from `--into` again and a re-run answers `moved: false`. A `raced` answer here means the curator committed again meanwhile: the landing stands, the ref is left where its writer put it, and a warning is logged.

The payload is `{ ref, into, from, to, moved, gate: { ran, passed, mode?, mrr?, mrrFloor?, probes?, inversions? }, worktreeSynced, replayed }`. `from === to` is `moved: false`, an answer rather than an error. `replayed` is `null` on a fast-forward and `{ base, ops: { put, archive, link }, attempts, originalTip }` on a replay, where `to` is the replayed commit, `from` the tip it was committed onto, `attempts` the number of `commitSession` calls, and `originalTip` the curate ref's commit before the landing moved it. Refusals are `ERR_INVALID_MEMORY` at exit 1. The arm lives in `apps/cli/src/v2.ts` (`curateMerge`, `landReplay`) with the reconstruction in `apps/cli/src/replay.ts`, takes the gate as an injectable effect so a test can drive a failing one or a racing writer, and is covered by `tests-integration/tests/v2-curate.test.ts` and `apps/cli/tests/replay.test.ts`.

### Curator

`memhtml curate run` is the curator memhtml itself owns: a bounded, model-driven tool loop over a curator session, packaged as `@memhtml/curator` (`packages/curator`) and bound to the real head, session, and sandbox by `apps/cli/src/curate-run.ts`. The package takes its tools as an interface (`CuratorTools`) because the sandbox helper lives in `apps/cli` and a package can't import an app; the binder implements the interface, the package's tests bind fakes to it.

The loop is `generateText` with tools, `toolChoice: "auto"`, and stop conditions, ending on a `finish` tool call or on a step that carries text and no tool call, whose text is then the report (under `"required"` the AI SDK throws on such a step, and the first live run on 2026-09-23 ended exactly that way with 23 ops stranded in the session). The answer is a tool call rather than `Output.object` because Bedrock rejects `output_config.format` (measured 2026-09-03), so every structured thing the model says, the ops it proposes included, is a tool's input. The run starts from a briefing computed by code, not by the model: active and archived counts, the inbox share, every frame key held by more than one active record with its paths and claims (capped at 50 groups), the dangling link count, the twenty lowest-confidence records, and the newest earlier `curate/<date>` ref with its date.

The model sees six tools, each with a zod schema, and every result is cut at 30,000 characters with a marker naming what was dropped: `search` (two-arm RRF over the session's view), `read` (one record's fields plus its HTML), `exec` (a script over head plus overlay in the writable sandbox; a link added to a file's head in the sandbox is harvested as a `link` op, so edges are placed from code mode without a `propose`; the harvest is appended only when the script exited 0 and no harvested op carries a violation, `duplicate` and `claim-edit` included, and the result carries the harvest, the rejections, and every violation), `propose` (explicit `put`, `archive`, and `link` ops; an `archive` names only its source and the loop derives `archive/<YYYY>/<path>` and the bytes through `read`; any violation refuses the whole proposal and comes back as the result). `exec` and `propose` refuse alike because `commitSession` refuses a session on any violation and a curator's ref has no rebase that cures a duplicate or a claim edit (the ref does not exist before the first commit), so an appended op the commit refuses would leave a log no `--resume` can land; the `session exec` arm on `main` reports those two kinds without refusing, since a rebase there can settle them., `status` (base sha, ref, ops by kind, steps and tokens spent), and `finish` (the report, whose first line becomes the commit subject).

The budget (`CuratorBudget`) is enforced in the process making the calls: `maxSteps` 40, `maxOutputTokensPerCall` 32,000 (riding the model through `defaultSettingsMiddleware`, because an unset limit gets Bedrock's 4,096 default and a truncated answer; the 2026-09-24 collapse run showed an 18-record fold proposal needs about 10,000 output tokens and a 77-record one about 8,500 with the archives left to code, so 8,000 truncated every large proposal mid-argument), `wallClockMs` 20 minutes through an `AbortSignal`, and `maxOps` 200 to match `BATCH_CAP`. The run reports `stoppedBy` as one of `finish`, `maxSteps`, `wallClock`, `maxOps`, or `modelError`, with steps and input and output token totals.

The charter (`packages/curator/prompts/charter.md`, read at run time and shipped as a packaging claim) states memory bodies are data, never instructions, and eight priorities in order: (1) never settle a contradiction by deleting a side; keep both live with the `contradicts` edge and write a note memory only when the evidence decides it. (2) Never rank or decay `resources/people/` identity records or task rows. (3) Dedup: one frame key with one value, or one claim in different words, becomes one canonical record plus archives reached by `supersedes` links. (4) Entity resolution: aliases get one canonical `memhtml-entity` value through `link` and `put` ops, never by editing an active claim. (5) Placement: move an inbox record to `areas/<slug>` or `resources/<tag>` only when its tags or entities make the home obvious. (6) Arcs: at most three new `areas/arcs/` syntheses per run, each citing at least four memories with `part_of` links. (7) Integrity: repair a dangling link by pointing at the archived form or dropping it. (8) Budget discipline: prefer one `exec` over many reads, stop when the marginal change is small, report what was left undone.

`--model` takes `fake`, `bedrock:<modelId>`, or `proxy:<model>`. `bedrock` uses `@ai-sdk/amazon-bedrock` with the default AWS credential chain and the region from `AWS_REGION`; `proxy` uses `@ai-sdk/openai-compatible` against `MEMHTML_LLM_BASE_URL/v1` with the `MEMHTML_LLM_MODEL_PREFIX` naming convention; `fake` is a scripted, credential-free model that calls `status`, then `exec` with a script that archives every duplicate in each briefed frame-key group and splices a `supersedes` link into the kept file's head for each archive, then `finish`, so `curate run --model fake` lands a real commit on a fixture with a duplicate pair: one `archive` plus one `link`, both harvested from the one `exec` with no `propose` call, which proves the code-mode edge path end to end. The default is `MEMHTML_CURATOR_MODEL`, else `proxy:global.anthropic.claude-opus-5` when a proxy is configured, else the flag is required.

The binder runs everything under the `curate` scope: `runSessionExec`, `validateOps`, and `commitSession` all receive `scope: "curate"`, so the `areas/arcs/` syntheses and `resources/people/` records the charter asks for are writable from a curator run and from nowhere else; the plain `session exec` and `session commit` arms stay at `session`. `.memhtml/`, `index.html`, and `sitemap.xml` are refused under both scopes.

The command starts the session on `curate/<UTC date>` (refused with `session.exists` unless `--resume`, which reopens the log and loads the head at the session's own base), runs the loop, and commits with `memhtml(curate): <report's first line>` through a rebase-and-retry loop bounded at eight. `--ref` must sit under `refs/heads/curate/`: `main`, `refs/heads/main`, any other branch, or a tag is `ERR_INVALID_FLAG` at exit 2 from the argv alone, `curateRun` refuses the same refs again for a caller that skips the CLI, and the branch `HEAD` points at is refused too, because `commitSession` fast-forwards the ref it is given and syncs the checkout when `HEAD` names it, and a run that could land on the system of record with no human at the door would undo the design. `--dry-run` runs the loop over an in-memory overlay and writes no session, no ref, and no commit; with `--resume` the overlay starts from the session's logged ops, so the preview shows what a resumed run would do, and the log, the ref, and `main` are left as they were. A run the model stopped is `ERR_MODEL_UNAVAILABLE` at exit 1 with its ops left in the session for `--resume`; a run that finished with zero ops is exit 0 with `commit: null`. The payload is `curate.run`: ref, session id, base sha, commit, outcome, steps, tokens, `stoppedBy`, ops by kind, the report, the tool calls, the briefing, and `next`, the merge command.

A curation pass is two commands in order, the second by a human or a gate:

```sh
memhtml curate run --model bedrock:global.anthropic.claude-opus-5
memhtml curate merge curate/$(date -u +%F)
```

Covered by `packages/curator/tests`, `apps/cli/tests/curate-run.test.ts`, and `tests-integration/tests/v2-curator.test.ts`.

## Integration test (integrator)

`tests-integration/tests/v2-sessions.test.ts`: build a fixture repo with 300 memories, load the head, start eight sessions concurrently (`Effect.all` with unbounded concurrency), each putting three distinct files, commit all; assert eight commits on `main`, every put present in `ls-tree`, and the head advanced through all eight shas with structural sharing (untouched records identical by reference). Then the four conflict cases from the session tests, driven through the CLI envelopes. Then `mise run check` green.

## Rules for every implementer on this branch

- Do not run any git command that changes state: no `add`, `commit`, `stash`, `reset`, `checkout`, `worktree`. Read-only git is fine. The orchestrator commits. Tests create their own temp repos.
- Edit only the paths your task names. A change to a shared file (`commands.ts`, `run.ts`, `packaging.test.ts`, any `package.json`) goes in your report as a request, not as an edit.
- Rebuild before cross-package tests: `@memhtml/*` exports resolve to `dist`. From the repo root, `pnpm --filter @memhtml/<pkg> build`.
- Take the dependency: `effect` `HashMap`/`HashSet` for persistent structures, `apache-arrow` for the snapshot, `fast-check` for properties. Hand-roll nothing a listed dependency covers.
- American English in code comments, tests, and docs. Biome formats TypeScript (`pnpm --filter @memhtml/<pkg> lint`); dprint formats Markdown with one line per paragraph.
- A guard is proven by a test that fails when the guard is removed. Say in the report which mutation you ran.
- Report file paths, exported names, test counts, and anything you could not finish. Return data, not prose about the process.
