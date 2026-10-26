---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Tech debt

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

memhtml's debt doesn't sit in code markers: the sources hold no TODO, FIXME, HACK or XXX comments and no lint or type suppressions. It sits in version pins, dependency overrides, declared gate baselines, comments and documents that name superseded versions, and a few small clones and casts. The sources hold no debt markers (see Explicit markers).

The repository has no confirmed debt in frequently revised files, so the page has no such section. The scope is the tracked source at HEAD; generated files (`AGENTS.md`, `CHANGELOG.md`) are out of scope.

## Ranked register

Rank weighs the cost to fix against what leaving the item costs. The pre-release Effect pin comes first because every Effect upgrade touches the whole workspace, and the stale-version comments follow because they mislead readers about what the code was checked against.

| Rank | Debt item                                                                                                                                                                                                                              | Category           | Cost to fix | Citation                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- | --------------------------------------------- |
| 1    | Effect v4 is described as pre-release, and the four Effect packages move as one pinned set (`effect`, `@effect/platform-node`, `@effect/platform-node-shared`, `@effect/vitest` at `4.0.5`), so any upgrade is a workspace-wide change | version pin        | L           | `pnpm-workspace.yaml:56-68`                   |
| 2    | CLAUDE.md still heads its Effect API notes "Effect 4.0.0-rc.109 differs from recall" while the catalog pins `4.0.5`                                                                                                                    | version pin        | S           | `CLAUDE.md:90`                                |
| 3    | The MCP server's comment on the missing `instructions` field says it was verified against effect `4.0.0-rc.109`, an older version than the pinned one                                                                                  | version pin        | S           | `apps/mcp/src/server.ts:28`                   |
| 4    | The backlog's upstream-watch note says the server comment names beta.107 and that the catalog pins rc.109; both are out of date against the code                                                                                       | version pin        | S           | `docs/backlog.md:73`                          |
| 5    | The mise `[env]` comment says lefthook gets "the pinned 2.5.10" Biome, while the root manifest declares `2.5.15`                                                                                                                       | version pin        | S           | `mise.toml:67-68`                             |
| 6    | The mise lockfile covers two platforms only, `linux-x64` and `macos-arm64`, so other hosts resolve tools without a locked entry                                                                                                        | version pin        | M           | `mise.toml:22`                                |
| 7    | Two scoped dependency overrides patch transitive advisories: `nanoid@<3.3.17` and `postcss-nested>postcss-selector-parser@<7.1.6`; each is meant to be deleted once upstream resolves the fix                                          | version pin        | S           | `pnpm-workspace.yaml:49-54`                   |
| 8    | The docs site ships one declared layout shift, `div.right-sidebar`, bounded but not fixed; the backlog holds the deferred grid-track fix                                                                                               | wrong abstraction  | M           | `apps/docs/src/gates.ts:221-231`              |
| 9    | One declared accessibility failure, Starlight's search button (`label-content-name-mismatch`), whose fix means shadowing the theme component                                                                                           | wrong abstraction  | M           | `apps/docs/src/gates.ts:169-187`              |
| 10   | An OpenVEX `not_affected` statement suppresses `GHSA-vfj7-8cjw-p6xm` for `braces@3.0.3` as `vulnerable_code_not_in_execute_path`                                                                                                       | version pin        | S           | `security/memhtml.openvex.json:12-27`         |
| 11   | CLAUDE.md sends readers to `.lessons/` and cites a lesson file there, and the directory isn't tracked in this checkout                                                                                                                 | dead code adjacent | S           | `CLAUDE.md:7`                                 |
| 12   | `summarize` is cloned line for line between the CLI and the MCP door; the MCP copy differs only in its return type                                                                                                                     | duplicated logic   | S           | `apps/cli/src/operations.ts:946-958`          |
| 13   | `wireReport` (MCP) and `opPayload` (CLI) perform the same snake_case rename of a batch report; the comments say the duplication is on purpose, to keep the two payloads byte-comparable                                                | duplicated logic   | S           | `apps/mcp/src/handlers.ts:261`                |
| 14   | `as unknown as` casts bridge untyped seams: CJS default exports in the curator planner, the `node:sqlite` row type, the global `fetch` type, and a `WriteParams` assembled field by field                                              | error handling     | S           | `packages/curator/src/planner/graph.ts:31-32` |

Row 12's MCP copy is at `apps/mcp/src/handlers.ts:312-326`. Row 13's CLI copy is at `apps/cli/src/apply.ts:516`, and the comment that declares the duplication deliberate is at `apps/mcp/src/handlers.ts:273`. Row 14's other casts are at `packages/index/src/database.ts:365`, `packages/llm/src/proxy.ts:220` and `apps/cli/src/apply.ts:302`.

## Explicit markers

The code has no explicit debt markers. A search for `TODO`, `FIXME`, `HACK`, `XXX` and `@deprecated` across `apps/*/src`, `packages/*/src`, `scripts` and `tests-integration/tests` returns no comment marker. The repository records debt in prose instead: `docs/backlog.md`, `ROADMAP.md`, `docs/rfcs/`, `docs/bugs/`, the declared baselines in `apps/docs/src/gates.ts` and the VEX ledger in `security/memhtml.openvex.json`. The register's other inputs were a search of the same paths for `biome-ignore`, `@ts-expect-error`, `@ts-ignore` and `as unknown as` casts, and a reading of the pin and baseline files (`pnpm-workspace.yaml`, `mise.toml`, `apps/docs/src/gates.ts`, `security/memhtml.openvex.json`) and the open items in `docs/backlog.md`.

## Pattern-level smells

### Version facts copied into prose

The pinned Effect version is restated in comments and documents, and those copies drift whenever the catalog moves. Shows up in:

- `CLAUDE.md:90`
- `apps/mcp/src/server.ts:28`
- `docs/backlog.md:73`
- `mise.toml:68`

Cost: a reader trusts a comment that names a version the code no longer runs, and the next upgrade has to hunt down every copy by hand.

### Twin doors with cloned helpers

The CLI and the MCP server each carry their own copy of the batch summary and the wire-shape mapping instead of importing one helper. The handler comments call this deliberate, because it keeps the two payloads byte-comparable. Shows up in:

- `apps/cli/src/operations.ts:946-958`
- `apps/mcp/src/handlers.ts:312-326`
- `apps/cli/src/apply.ts:516`
- `apps/mcp/src/handlers.ts:261`

Cost: a new field in `BatchOpReport` (`apps/cli/src/operations.ts:406-420`) has to be added to both copies of the summary and mapping code. `tests-integration/tests/batch.test.ts:626-631` holds a parity test that drives both doors over one fixture, so a field missed in one door is caught only for the cases that fixture covers.

### Casts at untyped seams

Where a driver, a CJS package or a hand-assembled record meets typed code, the code casts through `unknown` and leaves it to the caller to match the shape. The `database.ts` comment calls the cast "the seam where an untyped driver row becomes a typed row". Shows up in:

- `packages/index/src/database.ts:356-365`
- `packages/curator/src/planner/graph.ts:25-32`
- `packages/llm/src/proxy.ts:220`
- `apps/cli/src/apply.ts:302`

Cost: a wrong column name or a changed upstream default export typechecks and fails only at run time.

### Upstream defects held as declared baselines

The docs gates don't fix two upstream Starlight defects. They declare them as bounded exceptions, so every other failure still fails the gate. Shows up in:

- `apps/docs/src/gates.ts:169-187`
- `apps/docs/src/gates.ts:221-231`

Cost: the layout-shift entry can't assert that the shift still fires, so it stays in place until someone deletes it, and the grid-track fix in `docs/backlog.md:80-84` stays deferred.

### Very large command modules

The CLI concentrates its logic in a few files of more than 2,000 lines each (`wc -l apps/cli/src/operations.ts apps/cli/src/run.ts apps/cli/src/v2.ts apps/cli/src/commands.ts`). Shows up in:

- `apps/cli/src/operations.ts`
- `apps/cli/src/run.ts`
- `apps/cli/src/v2.ts`
- `apps/cli/src/commands.ts`

Cost: unrelated commands share one file, so their edits land together in history and in review.

## See also

- [REPORT](../REPORT.md): 7 shared source citations
- [system overview](../architecture/system-overview.md): 4 shared source citations
- [debugging guide](debugging-guide.md): 4 shared source citations
- [risk hotspots](../analysis/risk-hotspots.md): 3 shared source citations
- [data flow](../architecture/data-flow.md): 3 shared source citations
