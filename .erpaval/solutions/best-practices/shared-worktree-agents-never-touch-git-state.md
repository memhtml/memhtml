# Shared-worktree parallel agents never touch git state

**Category:** best-practices **Session:** session-1887c1 (task detection, PR #47) **Tags:** orchestration, subagents, git, stash, parallel

Two incidents in one session, both from parallel Act agents sharing one worktree: one agent ran `git stash` to "baseline" and swept a sibling's 14 in-flight files (restored byte-identical, but only by luck and reflog); something ran `git reset` mid-task and wiped four files another agent rebuilt from its packet's write log.

**Rules that held for the rest of the session:**

- The orchestrator owns git ENTIRELY. Agent prompts say: never stash/reset/restore/ checkout --; baseline with scoped `turbo --filter` runs; revert your own mutations by keeping a scratch copy, not via git.
- Checkpoint-commit each landed task immediately, so a later accident has a small blast radius and `git status` stays a readable map of in-flight work.
- Disjoint file ownership per wave, stated in each prompt WITH the sibling's file list; shared chokepoints (a cross-cutting test both would edit) are escalated to the orchestrator, not patched by whoever hits them first.
- A sibling's in-flight edits make scoped gates transiently red; agents note and re-run rather than fixing files outside their scope.

The packet-on-disk write protocol is what made the reset survivable: the agent rebuilt from its own work log.
