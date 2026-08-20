# Parallel worktree agents converge on shared barrel/fixture files — union-resolve mechanically, then hunt the seams

**Tags**: worktrees, parallel-agents, merge-conflicts, barrel-exports, fixtures
**Modules**: packages/sleep (src/index.ts, phases/index.ts, contract.ts, env.ts, llm.ts, tests/fixture.ts, tests/units.test.ts)

## The shape

Three Act agents built three sleep phases in parallel worktrees off one kernel commit
(session-69043c, PR #45). Every agent was told "shared files are append-only regions", and every
agent still collided on the same six files: the package barrel, the phases barrel, the phase
vocabulary (LLM_PHASES/DEFAULT_MODELS), the shared prompt module, the test fixture corpus, and the
pin test. The collisions are structural, not discipline failures — a barrel has one export list and
a vocabulary has one array, so N parallel authors produce N conflicting hunks there no matter what
the prompts say.

## What worked and what bit

- Regex union-resolve (`HEAD content + branch content` per hunk) cleared ~80% of hunks correctly,
  but produced three classes of damage the compiler caught and one it did not:
  1. **Fused array entries** — two fixture objects sharing an opening `{` merged into one broken
     literal, and one entry landed inside the WRONG corpus array (payments entry into
     DEDUP_FRAME_CORPUS). Grep for the entry name after resolving; count occurrences.
  2. **Duplicate identifiers** — both branches exported `unionPairs` from different modules; the
     barrel needed explicit `as` aliases with a comment naming the other module's claim.
  3. **Semantic pins** — the LLM_PHASES literal test came from branch A while the array came from
     A+B+C; the union compiled and failed at runtime. Any test that pins a LITERAL list must be
     re-derived after the merge, not union-resolved.
  4. (silent) **Replacement hunks disguised as unions** — T-4 DELETED the stance judge; the union
     would have kept dead STANCE_* code beside its replacement. Distinguish "both added" from
     "one replaced" before applying a blanket union: check whether the branch side deletes what
     HEAD carries.
- The rename branch (conflict-detection → edge-typing) conflicts with EVERYTHING; merge it last,
  and treat its hunks as replacements by default.

## How to apply

Give each parallel agent a per-file protocol (append-only regions, one-line vocabulary entries),
merge branches sequentially smallest-first with the rename/delete branch last, union-resolve
mechanically, then run three seam hunts before the gates: duplicate-identifier typecheck, grep for
every fixture entry name added by more than one branch, and re-derive every literal-pin test from
the merged source. Budget an orchestrator hour for this; it is cheaper than serializing three
multi-hour agents.
