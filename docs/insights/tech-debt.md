# memhtml-public · Tech debt

This register was assembled from four channels, in this order.

First, a comment-marker scan. Two independent passes over the codebase found zero markers, so this channel is empty. The repo records debt in ranked prose ledgers instead of in code comments. `docs/backlog.md:3` states the rule for one of them, "Ranked. Each item names its evidence; nothing here is speculative," and `ROADMAP.md:8-9` names `docs/backlog.md` as "the fine-grained ledger" with itself as "the system-level view."

Second, those ledgers. `docs/backlog.md`, `ROADMAP.md`, `docs/bugs/`, and the EARS requirements in `spec/memhtml.symspec.json` each carry deferred items that name their own unfired trigger. Every ledger item that became a row below was re-checked against source before it was filed, and two were dropped because the code showed them already closed.

Third, manifest version pins. These cover the Effect pre-release catalog, the unstable subpath imports, the security override, and the cases where a declared schema version disagrees with the pinned version.

Fourth, pattern-level smells the reviewer chose to flag. These are duplicated agent-facing prose across the two doors, one oversized function, a phase whose destructive decision is never asserted, comment evidence citing paths a clone cannot read, and the ledger-outlives-its-defect pattern.

Category vocabulary is closed to eight values: `marker`, `wrong abstraction`, `error handling`, `dead code adjacent`, `deprecated pattern`, `version pin`, `duplicated logic`, `missing tests`. Cost is `S`, `M`, or `L`. Rank multiplies cost to fix by consequence of leaving, so a cheap fix with a real consequence outranks an expensive fix with a contained one.

A row leaves the register only by being closed in code, and it leaves through the **Closed** section below rather than by being deleted, which is the discipline `docs/backlog.md` keeps with its `~~struck~~ — DONE (verified <date>)` headings. The reason is the failure mode this register's own smell section names: a ledger that outlives its defect, and its mirror, a fix with no record that the ledger ever claimed otherwise.

Two limits apply to what follows. Every debt item in the register is either a deferred capability the maintainers already argued for in writing, or a smell this review found. Nothing was invented to reach a row count. The register also describes only this repository, which is the software that manages a separate `memhtml root` directory located by `$MEMHTML_ROOT`. No memory lives here. Where an item's consequence lands on the root rather than on the repo, the row says so.

## Ranked register

| Rank | Debt item                                                                                                                                                                                                                                                                                                                                                                                             | Category           | Cost to fix | Citation                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| 1    | The task family is CLI-only, so an agent holding only the MCP door cannot open, advance, or list a task. `setTaskStatus` and `listTasks` exist as use cases with a CLI adapter and no MCP adapter, against a layer whose rule is one adapter per tool.                                                                                                                                                | wrong abstraction  | M           | `docs/tasks.md:158`, `apps/cli/src/operations.ts:1319`, `apps/cli/src/operations.ts:41-48`    |
| 2    | `memory_archive` moves a task into the archive without touching `task_status`, leaving a `todo`-status file under `archive/` in the root.                                                                                                                                                                                                                                                             | wrong abstraction  | S           | `docs/tasks.md:168-169`                                                                       |
| 3    | Agent-facing workflow prose is hand-written twice, once per door, with no shared constant and no test asserting the two agree. An agent reading the CLI manifest and an agent reading `tools/list` can be told different rules.                                                                                                                                                                       | duplicated logic   | M           | `apps/mcp/src/tools.ts:143`, `apps/cli/src/commands.ts:909`                                   |
| 4    | The sleep `reprieve` phase archives TTL-passed memories out of the root, and no test asserts its `reprieved` or `expired` counts. Only the domain scoring function is covered.                                                                                                                                                                                                                        | missing tests      | S           | `packages/sleep/src/phases/reprieve.ts:91`, `packages/domain/tests/retention.test.ts:343`     |
| 5    | Thirty-eight doc-comment citations point into `node_modules/eve/...`, several with exact line numbers. `node_modules` is gitignored, so a reader in a fresh clone cannot check any of them, and an eve bump invalidates them silently.                                                                                                                                                                | dead code adjacent | M           | `apps/consolidator/src/run-auth.ts:103`, `.gitignore:1`                                       |
| 6    | The MCP door runs on a pre-release Effect catalog pinned to `4.0.0-rc.109` and imports from the explicitly unstable `effect/unstable/ai` subpath. The project's own notes say v4 breaks between versions.                                                                                                                                                                                             | version pin        | L           | `pnpm-workspace.yaml:93-96`, `apps/mcp/src/tools.ts:13`, `CLAUDE.md:93`                       |
| 7    | The consolidator's agent sandbox has full network egress and this repo cannot turn it off. A measured probe from inside reaches a public host, obtains an IMDSv2 token, and reads the instance-role name. Mitigation has to live outside the dependency.                                                                                                                                              | wrong abstraction  | L           | `apps/consolidator/src/run-auth.ts:13-20`, `ROADMAP.md:522-528`                               |
| 8    | `batchWrite` runs about 185 lines in one function body and carries two coordinate systems at once: the caller's op index space and the store's result positions, bridged by an `originOf` array. _judgment-call_                                                                                                                                                                                      | wrong abstraction  | M           | `apps/cli/src/operations.ts:641-825`, `apps/cli/src/operations.ts:679-680`                    |
| 9    | The conflict assist is write-time only. `memory_search` and `memory_recall` return a hit whose slot holds two live claims as though the fact were uncontested, even though `frame_key` is indexed and available.                                                                                                                                                                                      | wrong abstraction  | M           | `docs/backlog.md:126-128`                                                                     |
| 10   | An `article_html` op reports no conflicts at all, because the claim lives inside the caller's markup and the ops layer never parses it. Fixing it means moving the assist behind the store's own render.                                                                                                                                                                                              | wrong abstraction  | L           | `docs/backlog.md:132-136`                                                                     |
| 11   | A store created before migration 0009 carries NULL `frame_key` until `memhtml index rebuild` runs, so the conflict assist silently finds fewer conflicts on an older root.                                                                                                                                                                                                                            | deprecated pattern | S           | `docs/backlog.md:141-144`, `ROADMAP.md:44-47`                                                 |
| 12   | `docs/code-mode.md` ships its cookbook helper against cheerio, which is not a dependency of any manifest and is known to be unloadable in the sandbox the recipes now run in. The doc's own caveat contradicts its code.                                                                                                                                                                              | dead code adjacent | S           | `docs/code-mode.md:59-63`, `ROADMAP.md:321-325`                                               |
| 13   | `pinCorpusSnapshot` is implemented and tested but wired to nothing. A snapshot is a git worktree that needs release, and the object that would hold it is built once per client, so the lifetimes do not match.                                                                                                                                                                                       | dead code adjacent | M           | `apps/consolidator/src/mount.ts:258`, `apps/consolidator/src/client.ts:250-261`               |
| 14   | Counted-drop sites record how many records were unusable and never why, so an operator reading `skipped` or `droppedLines` cannot distinguish a truncated write from a schema change.                                                                                                                                                                                                                 | error handling     | S           | `packages/sleep/src/phases/state-export.ts:120-122`, `packages/traces/src/extract.ts:254-258` |
| 15   | The salience read rule is argued from mechanism and never measured. No benchmark in the campaign exercises salience, because every row runs against a fresh store with no repeated access.                                                                                                                                                                                                            | missing tests      | L           | `ROADMAP.md:185-190`, `spec/memhtml.symspec.json` requirement GYM-1                           |
| 16   | The discrimination gate's fixture is saturated at MRR 1.0 with zero inversions over 36 probes, so it can detect a ranking regression and can no longer measure an improvement.                                                                                                                                                                                                                        | missing tests      | M           | `ROADMAP.md:437-442`                                                                          |
| 17   | Sleep-cycle watermarks live only in `index.db`, which is a rebuildable projection. Losing it loses every watermark, and the next cycle re-reads and re-distills those sessions.                                                                                                                                                                                                                       | wrong abstraction  | M           | `ROADMAP.md:530-533`                                                                          |
| 18   | `apps/cli/guest/corpus.mjs` is 193 lines of runtime-loaded source that `tsc` never sees, so its imports, its `atob` shim, and its selector contract carry no type check. biome does lint it — `files.includes` names `**/*.mjs` and the root `lint:repo` task runs `biome check .` — which catches syntax and unused bindings but not a shape disagreement with the corpus it parses. _judgment-call_ | missing tests      | S           | `apps/cli/src/exec.ts:95-107`, `biome.json:5-13`, `package.json:15`                           |
| 19   | The MCP server cannot publish server-level `instructions`, because the dependency declares the field and gives `layerStdio` no argument for it. Tool descriptions are the only guidance channel an agent gets.                                                                                                                                                                                        | version pin        | L           | `apps/mcp/src/server.ts:24-37`, `docs/backlog.md:148-153`                                     |
| 20   | Any new MCP tool must declare `failure: ToolFailure` or its errors reach the agent as "internal server error". Only convention and wire tests enforce this, and no type signature does.                                                                                                                                                                                                               | deprecated pattern | M           | `docs/backlog.md:154-156`                                                                     |

## Closed

Each entry names the row it retires, the date the closure was verified against source, and the code that settles it. An entry stays here rather than being deleted, so a reader who finds the same shape again knows it was already argued once.

- **~~The doc-sync ledger entry is stale in both directions~~** — DONE (verified 2026-08-18). `docs/backlog.md:27-29` carries the closure. `RESPONSE_TYPES` holds 32 members (`apps/cli/src/envelope.ts:12-45`) and `docs/design.md` cites the enum by path rather than enumerating members, so that line cannot drift from the constant. The register's own **A ledger that outlives the defect it describes** smell below is the general case, and this was its live instance.
- **~~Three-way disagreement about the biome version~~** — DONE (verified 2026-08-25). `biome.json:2` declares the `2.5.8` schema, all fifteen manifests pin `@biomejs/biome` at `2.5.8`, and `mise.toml` names no version in prose, so there is one number in one shape.
- **~~`apps/cli/guest/corpus.mjs` is linted by nothing~~** — DONE (verified 2026-08-25), for the lint half only. `biome.json`'s `files.includes` names `**/*.mjs` and the root `lint:repo` task runs `biome check .` over `biome.json`'s own include set rather than each package's `src tests` (`package.json:15`), so every `.mjs` in the repo is checked. The type-check half stands as register row 18: `tsc` still never sees this file.

## Explicit markers

The codebase contains no explicit debt markers. Two independent passes searched for them, and neither found any in source:

- A `jq` pass over every line of all 347 files in the flattened codebase at `docs/.repomix/codebase.json`, matching `\b(TODO|FIXME|HACK|XXX|REFACTOR|DEPRECATED|deprecated|@deprecated)\b`, returned exactly one hit, and that hit is a string literal in data rather than a comment. `` - `  "deprecated",`: `packages/domain/src/merge.ts:104` ``
- A filesystem `grep -rnE` over `apps`, `packages`, `tests-integration`, `scripts`, `spec`, `mise-tasks`, and `.github` matched 12 files, all of them generated Lighthouse report artifacts under `apps/docs/.lighthouseci/`, which are neither source nor in scope for this document.

No `@deprecated` decorator, no `// DEPRECATED` comment, and no `// REFACTOR` comment exists anywhere in the in-scope source.

Written ledgers replace markers here, and each ledger states its own rules:

- `` - `Ranked. Each item names its evidence; nothing here is speculative.`: `docs/backlog.md:3` ``
- `` - `Every item below names its evidence — a measured number, a probe, or a commit — and nothing here is speculative. Ranked within each horizon. `docs/backlog.md` remains the fine-grained ledger; this file is the system-level view the benchmarks bought.`: `ROADMAP.md:6-9` ``

Because of that practice, deferred work is written as a named decision with a named trigger instead of an inline note. Three examples, quoted verbatim:

- `` - `Two things remain open and are accepted rather than fixed:`: `ROADMAP.md:515` ``
- `` - `**Step 5, prompt caching, is deliberately NOT built, and its trigger is recorded.**`: `ROADMAP.md:498-499` ``
- `` - `It is deliberately not passed here and not passed at all yet, for a reason that is about lifetime rather than plumbing: a snapshot is a git worktree that must be RELEASED, so it belongs to a per-run scope — and this object is built once per client, outside any run.`: `apps/consolidator/src/client.ts:254-257` ``

The same practice appears in the EARS requirements carrying `status: draft` in `spec/memhtml.symspec.json`. Several do, and each has a `verificationNote` naming its unfired condition. Count them in the file rather than here. Verbatim examples:

- ``- `The mcp server shall expose the task family as task_add, task_status, and task_list tools.`: `spec/memhtml.symspec.json` requirement TASK-1``
- ``- `While a corpus approaches one hundred thousand chunks, the retrieval shall serve vector search through an approximate nearest neighbor index.`: `spec/memhtml.symspec.json` requirement ANN-1``
- ``- `The design doc shall derive the response-type list from the enum.`: `spec/memhtml.symspec.json` requirement DOCSYNC-1``

That last one is the register's rank 5. The requirement and the two ledger entries behind it describe a defect the code no longer has.

## Pattern-level smells

### One workflow, two hand-written copies, one per agent door

The two surfaces an agent calls, the `memhtml` CLI and the MCP stdio server, publish the same authoring and batching rules as two independently written prose strings. Both tell the caller to supply exactly one of `body` or `article_html`. Both state that the markup must carry exactly one `<mark>` inside the first `<p>` or `<li>`. Both explain that the first `<time datetime>` element becomes the memory's event time, which is what the recency arm ranks by. Both describe a fenced code block becoming `<figure><pre><code data-lang>` and promoting to a `lang:` entity. Both state that a batch is atomic by default with a flag for best-effort, and that a dedupe is not a failure. Neither string is derived from the other. Inside the MCP package the risk is already handled. `apps/mcp/src/tools.ts:159-163` says two hand-written versions of one workflow "drift the first time the semantics move", which is why `ARTICLE_HTML_CONTRACT` and `BATCH_GUIDANCE` are shared constants. That sharing does not extend past the package edge. A grep for `BATCH_GUIDANCE` across every test directory finds one prose mention and no assertion, so the only drift test that exists checks that the MCP constant appears in MCP descriptions, and it cannot notice the CLI drifting. The consequence lands on agents rather than on maintainers. Two agents holding two different doors to the same root can operate from two different contracts, and neither can tell.

Shows up in:

- `apps/mcp/src/tools.ts:143`
- `apps/mcp/src/tools.ts:195`
- `apps/cli/src/commands.ts:909`
- `apps/cli/src/commands.ts:893`
- `tests-integration/tests/batch.test.ts:43`

Cost: M. The fix is one shared constants module in `@memhtml/contracts` that both doors import, plus one test asserting that the strings the two doors publish are the same string.

### Comment evidence that cites paths a clone cannot read

The comments in this codebase carry their own evidence, in the form of measured numbers, named probes, and dated verifications. The problem is where that evidence lives. Thirty-eight doc-comment citations across the consolidator point into `node_modules/eve/dist/...` or `node_modules/eve/docs/...`, and several carry exact line numbers, such as the client-types citation at `apps/consolidator/src/run-auth.ts:103`. `node_modules/` is the first line of `.gitignore`, so none of those citations is checkable from a fresh clone, and a dependency bump moves all of them with nothing to notice. The dependency has already moved. Eight comments cite "eve 0.33.0" as the version their claims were verified against while the manifest pins `0.38.3`. This counts as debt because the comments carry security-relevant conclusions. `apps/consolidator/src/run-auth.ts:13-20` establishes that the sandbox has full network egress by pointing at a hardcoded literal in eve's compiled output, and the mitigation strategy for the whole app depends on that literal still being there.

Shows up in:

- `apps/consolidator/src/run-auth.ts:13-20`
- `apps/consolidator/src/run-auth.ts:35`
- `apps/consolidator/src/run-auth.ts:103`
- `apps/consolidator/src/mount.ts:16`
- `apps/consolidator/agent/agent.ts:30`

Cost: M. Two options work. A test can read the cited file and assert the literal is still there, which turns the comment into a gate. Or the comment can carry a version stamp that a bump task has to refresh.

### A ledger that outlives the defect it describes

Written ledgers replace comment markers here, and they share one failure mode with markers. An entry can stay in the ledger after its defect is gone. The doc-sync item is the pattern's settled instance, closed 2026-08-18 (`docs/backlog.md:27-29`, and the **Closed** section above). It said `design.md`'s ResponseType line names 16 of 31 members, `ROADMAP.md:579-580` repeats it, and DOCSYNC-1 in `spec/memhtml.symspec.json` carries it as a draft requirement with the same count in its verification note. A direct check of the source disagreed on both counts. `RESPONSE_TYPES` holds 32 members, and `docs/design.md:878` cites the constant by path instead of listing anything, so a grep for any response-type literal in that document returns zero. The entry was wrong about the enum's size and wrong that the defect exists. The wider problem is that three documents agreed on a number none of them re-derived, which is the same shape as the selector error `ROADMAP.md:328-330` records, where "three documents agreed on the wrong selector; the markup settled it." Two other entries drift the same way to a smaller degree. `docs/code-mode.md:59-63` still presents cheerio as the cookbook's parser after `ROADMAP.md:321-325` measured that cheerio cannot load in the sandbox the recipes now run in.

Shows up in:

- `docs/backlog.md:27-29`
- `ROADMAP.md:579-580`
- `apps/cli/src/envelope.ts:12-45`
- `docs/design.md:878`
- `docs/code-mode.md:59-63`

Cost: S per instance. DOCSYNC-1 already names the fix that closes the whole class, which is to derive the doc line from the enum the way `AGENTS.md` is derived from the command table.

### A destructive sleep phase whose decision is never asserted

The sleep cycle's `reprieve` phase decides whether a TTL-passed memory earns another two weeks or gets archived out of the root, and it reports that decision as a count of what it reprieved and what it expired. No test asserts either number. The scoring function underneath it is well covered, with property tests for monotonicity, importance ordering, and the negative-outcome clamp at `packages/domain/tests/retention.test.ts:343`, so the arithmetic is covered. The phase body is not. `tests-integration/tests/sleep.test.ts:149` asserts `report.phases` has `SLEEP_PHASES.length` entries — against the enum rather than a literal, so adding a phase cannot leave an integration file asserting a stale count — and then inspects `retention-triage` and `report` by name. A grep for `reprieved` or `expired` across every sleep test and every integration test finds no assertion on either field. `packages/sleep/tests/run.test.ts:378` names reprieve only in prose, as one of eleven predecessors that ran before the phase under test. The result is that the one phase that deletes a user's memories from the managed root passes the definition-of-done gate with no check that it archived what it should have or spared what it should have. This package also has the weakest coverage ratio in the repo, at 31 source files against 8 test files where every other package sits near 1:1.

Shows up in:

- `packages/sleep/src/phases/reprieve.ts:91`
- `packages/sleep/src/phases/reprieve.ts:11`
- `tests-integration/tests/sleep.test.ts:149`
- `packages/sleep/tests/run.test.ts:378`
- `packages/domain/tests/retention.test.ts:343`

Cost: S. The fix is one phase test with a TTL-passed high-salience memory and a TTL-passed cold one, asserting the counts and the resulting paths, and shown to fail when the reprieve predicate is inverted.

### An assist that only half the doors can use

Write-time conflict detection was the campaign's largest measured win, and it reaches callers unevenly. The prose door has it, so `memory_write_batch` and `memhtml apply --detect-conflicts` return a per-op `conflict` naming the colliding path, batch index, and claim. Three gaps remain, each documented and each with a different cause. An `article_html` op reports nothing at all, because the claim lives inside the caller's markup and the ops layer never parses it. An agent that authors markup to get event-time control gives up conflict detection in exchange. Retrieval also reports nothing, so a `memory_search` hit whose slot holds two live claims looks like one uncontested fact even though `frame_key` sits indexed on `files`. A root created before migration 0009 carries NULL `frame_key` until a rebuild, so the assist finds fewer conflicts there rather than wrong ones. All three fail toward under-reporting rather than false reports, which is why they were deferred. The cost of leaving them is that an agent's confidence in "no conflict reported" depends on which door it used and how old the root is, and nothing in the response tells it which situation it is in.

Shows up in:

- `docs/backlog.md:132-136`
- `docs/backlog.md:126-128`
- `docs/backlog.md:141-144`
- `ROADMAP.md:44-47`
- `apps/cli/src/operations.ts:658-661`

Cost: L for the `article_html` half, because the assist has to move behind the store's own render. Adding a second parse would add a second place the gist rule can drift. Cost is M for the retrieval half, and S for making the pre-0009 degradation visible in the response instead of only in a migration header.

## See also

- [memhtml-public · System overview](../architecture/system-overview.md): 2 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 2 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 2 shared source citations
