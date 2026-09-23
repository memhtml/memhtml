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

Out of scope, recorded here so nobody builds them by accident: the curator prompt and any model call; a long-lived head server process; vector retrieval over the head (the interface exists, the fake embedder is the only implementation); any change to the v1 write path, sleep pipeline, or MCP server; migration of the live store.

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
  readTreeIntoWorktree(from: string, to: string): Effect<void, GitFailure>   // read-tree -m -u from to, on the shared index (no GIT_INDEX_FILE)
}
export const makePlumbing: (input: { root: string; indexFile: string }) => Plumbing

export interface Session {
  readonly id: string
  readonly baseSha: string
  readonly ref: string                 // refs/heads/main by default, refs/heads/curate/<date> for a curator
  readonly ops: ReadonlyArray<OverlayOp>
}
export const startSession: (input: { root: string; id: string; base: HeadView & { sha: string }; ref?: string }) => Effect<Session, GitFailure | StorageFailure>
export const resumeSession: (input: { root: string; id: string }) => Effect<Session, StorageFailure>
export const appendOps: (session: Session, ops: ReadonlyArray<OverlayOp>) => Effect<Session, StorageFailure>   // persists the log
export const validateOps: (view: HeadView, ops: ReadonlyArray<OverlayOp>) => ReadonlyArray<Violation>
export type Violation =
  | { kind: "format"; path: string; reasons: ReadonlyArray<string> }
  | { kind: "duplicate"; path: string; existing: string }
  | { kind: "claim-edit"; path: string }          // put over an active path with a different content hash
  | { kind: "reserved-path"; path: string }       // areas/arcs/, resources/people/, .memhtml/, index.html, sitemap.xml
  | { kind: "batch-cap"; count: number; cap: number }   // cap 200 ops
export const commitSession: (input: { session: Session; head: HeadView & { sha: string }; message: string; syncWorktree?: boolean }) => Effect<CommitOutcome, GitFailure | StorageFailure>
export type CommitOutcome =
  | { kind: "committed"; sha: string; paths: ReadonlyArray<string>; contradictions: ReadonlyArray<{ path: string; against: string }> }
  | { kind: "rebase-needed"; overlapping: ReadonlyArray<string>; mainSha: string }
  | { kind: "refused"; violations: ReadonlyArray<Violation> }
export const rebaseSession: (session: Session, onto: HeadView & { sha: string }) => Session   // moves baseSha, keeps ops; validation happens at the next commit
```

Commit algorithm, in order:

1. `validateOps(head, session.ops)`; any violation returns `refused` and writes nothing.
2. `mainSha = revParse(session.ref)`. If it differs from `session.baseSha`, compute `changed = diffTreePaths(baseSha, mainSha)` and `touched = paths of ops (put path, archive path and to, link path)`. If the intersection is non-empty, return `rebase-needed`. A disjoint advance continues with `parent = mainSha`.
3. Frame-key check against the head: for each `put` whose record has a frame key that `head.byFrameKey` resolves to a different active path, add `<link rel="memhtml-contradicts" href="/that/path">` to the new file's head (`addLink`) and record the pair in `contradictions`. Both stay live. Nothing is auto-archived.
4. `readTree(parent)` into the session index file; `hashObjectWrite` each put and archive body; `updateIndexAdd` for puts and archive destinations; `updateIndexRemove` for archive sources; `writeTree`; `commitTree(tree, [parent], message)` with the `memhtml(session): ...` subject form and a `Memhtml-Session: <id>` trailer.
5. `updateRef(ref, commit, expected = parent)`. `raced` means someone else advanced between step 2 and now: return `rebase-needed` with the new `mainSha`; the caller rebases and retries. Also set `refs/memhtml/sessions/<id>` to the commit for provenance.
6. If `syncWorktree` and the repo has a working tree checked out at `ref` whose `status --porcelain` is empty, `readTreeIntoWorktree(parent, commit)` so the working tree and shared index follow. Otherwise leave the working tree alone and report `worktreeSynced: false`.

Session state on disk: `.memhtml/sessions/<id>.idx` (the git index file) and `.memhtml/sessions/<id>.json` (`{ id, baseSha, ref, ops }`). Both are gitignored by `.memhtml/`.

Tests, all against a real temp git repo created with `git init -b main` and the store's `configureIdentity`:

- `blobShaOf` equals `git hash-object` for ASCII and multibyte content.
- Two sessions on the same base committing disjoint files both land; the second sees `committed` after one `rebase-needed` at most, and `git log` shows two commits.
- Two sessions putting the same path: the second gets `rebase-needed`, rebases, and then `refused` with `claim-edit` if its hash differs or `duplicate` if identical.
- Same content hash from two sessions: the second is `refused` with `duplicate` naming the first's path.
- Frame-key conflict: both files live after commit, the new one carries the contradicts link, `git cat-file` shows it.
- `updateRef` race: advance the ref by hand between validation and update, assert `rebase-needed`.
- Every guard is mutation-verified: the test file states, per guard, the one-line change that makes it fail (a comment naming the function and condition), and the suite was run once with that change applied.

Deltas landed, where the implementation departs from the contract above:

- `Session` carries `root` (the repository root). It is not persisted: the log is found by root plus id, so the two cannot disagree.
- `CommitOutcome.committed` carries `worktreeSynced: boolean`, so a caller can tell a commit whose working tree followed from one whose working tree was left alone.
- `Plumbing` gains `headRef()` (the branch `HEAD` points at, or `null` when detached) and `worktreeStatus()` (`status --porcelain --untracked-files=no` over the shared index). Both read the shared index, and step 6 reads them before the ref moves.
- `commitSession` takes an optional `archivedAt`, the instant archive ops stamp, so a test can pin it. It defaults to now.
- `saveSession` is exported, so a caller that rebased can persist the moved base without appending an op.

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
export const runSessionExec: (input: { view: HeadView; script: string; timeoutMs?: number }) => Effect<SessionExecReport, StorageFailure>
export interface SessionExecReport extends ExecReport { readonly ops: ReadonlyArray<OverlayOp>; readonly rejected: ReadonlyArray<{ path: string; reason: string }> }
```

The guest filesystem is seeded from `view.records()` under `/mnt/memhtml` with no disk worktree and no `git worktree add`. The mount is writable. After the script exits, the harvester walks `/mnt/memhtml`, compares each file's bytes against the seeded set, and turns a new or changed `.html` into a `put`, a missing file into a `rejected` entry (deletion is not an operation; archiving is a `put` at the archive path plus the source going missing, which the harvester pairs into one `archive` op when the article hash matches). Files outside `.html`, under `.git`, or named `index.html` are rejected with a reason. The `corpus.mjs` helper is preloaded exactly as `exec` does it. A test seeds 50 records, runs a script that writes two files and edits one head, and asserts the harvested ops.

## CLI commands (integrator)

Add to `COMMANDS`, `RESPONSE_TYPES`, and `dispatch`, then regenerate `AGENTS.md`:

| command          | flags                                                    | response type                                      |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `session start`  | `--id`, `--ref`                                          | `session.started`                                  |
| `session put`    | `--id`, `--file` (JSONL of `write` ops as `apply` takes) | `session.appended`                                 |
| `session exec`   | `--id`, `--script` or `--file`, `--timeout-ms`           | `session.exec.report`                              |
| `session commit` | `--id`, `--message`, `--sync-worktree`                   | `session.committed` (data carries `CommitOutcome`) |
| `session rebase` | `--id`                                                   | `session.rebased`                                  |
| `session status` | `--id`                                                   | `session.status`                                   |
| `head status`    |                                                          | `head.status` (sha, records, skipped, load ms)     |
| `head search`    | `query`, `--limit`                                       | `head.search`                                      |
| `head snapshot`  | `--write` / `--read`                                     | `head.snapshot`                                    |

`session rebase` is the caller's half of the retry loop: `session commit` answers `rebase-needed` and never retries on its own, so a caller reloads the base with `session rebase` and commits again, or reads the `refused` that follows and decides. The head is loaded per invocation in this proof of concept: from the snapshot at `.memhtml/snapshots/<sha>.arrow` when one exists for `HEAD`, else from git, and `head status` reports which. A long-lived head process is deferred.

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
