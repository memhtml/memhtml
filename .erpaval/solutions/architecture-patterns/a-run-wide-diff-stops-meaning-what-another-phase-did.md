# A run-wide diff stops meaning "what another phase did" the moment one phase sweeps the corpus

**Tags**: git, pipeline, guards, sleep, counts **Modules**: packages/sleep, packages/store

## The rule

**A "did another step already touch this?" guard scoped by `git diff base..HEAD` is only correct while no step writes to everything.** One phase that restamps a metadata line across the whole corpus puts ~100% of the tree in that diff, and every later guard reading it refuses ~100% of its work — structurally, every run, with a green report. Scope the guard by COMMIT instead: read each commit's own diff and decide per commit whether its write carried a decision.

**Enumerate the exempt sweeps, not the pinning steps.** A step wrongly treated as a sweep lets a later step move a file it just wrote (a committed href that dangles, a decision folded into a rename nobody reads); a step wrongly pinning costs one run's yield on work still available next run. Asymmetric costs decide the default: a newly added step pins until someone argues otherwise.

**Membership names what a step DECIDES, not how wide or deep its diff is.** A content-hash rule ("the article bytes are identical, so the change was cosmetic") is unsound for exactly the cases that matter: splicing one `<link>` leaves the hash identical and authors a real edge, and the mover's own repair reads an index nothing refreshes mid-run, so the edge is invisible to it and the move leaves a dangling href.

**A failed read must WIDEN the guard, never empty it.** `orElseSucceed(() => [])` on the diff turns the guard off at the one moment it cannot tell what happened. Three rungs, each its own value the caller cannot collapse: scoped, widened-to-the-whole-range, and unreadable — where unreadable degrades the step the way an absent model does, and because the read happens before the batch loop it costs zero model calls instead of a full budget spent on proposals that will all refuse.

**Read the run's own facts from its commits, not from an accumulator.** The commits are the only source that survives a resume: after a killed attempt the finished phases exist only as commits, so an in-memory record is empty exactly when a phase already wrote.

**A pooled counter hides a mechanism.** Nine refusal classes summing into one `refused` made two full runs unreadable without grepping logs, and one message covered two different facts ("another phase wrote this" and "this step already moved it"), reporting duplicates as cross-phase contamination. One count key per class, all pre-seeded to 0 (an absent key is a key someone has to go looking for), `refused` kept as the total, and a census asserting the parts sum to it. Add the guard's own diagnostics too — set size, commits counted, commits excluded, whether the read widened — so "it refused everything" becomes "it read 2674 files from 1 commit", which reads as a finding on sight.

## Measured git facts (git 2.50.1, 2026-08-26)

- `git diff --name-only A..B` **collapses a rename to its destination**: a pure `git mv` reports only the new path, so the path that went away is missing from the very set meant to be conservative. `--no-renames` reports both. `git diff-tree` detects no renames in this form at all — probed under `diff.renames` unset, `true`, and `copies`, all three reporting both paths.
- `git diff-tree -r --name-only <merge>` reports **zero paths** without `-m`, and `<root-commit>` reports **zero paths** without `--root`. Both at exit 0.
- Under `--stdin`, without `--no-commit-id` each commit's own 40-hex sha arrives as a line among the paths; an **abbreviated** sha is echoed as its own output line and produces no diff at all, so a caller receives one bogus path, no real ones, and exit 0. Validate the input form rather than documenting it.
- Without `-z`, `core.quotePath` renders a non-ASCII path as `"areas/x/caf\303\251.html"` — quoted and octal-escaped, equal to nothing a caller compares it to. Every path-parsing call needs `-z`.
- A doc comment claiming `GIT_CONFIG_*` neutralized user config named variables the code never set, so user config **is** read: state every parsed format with an explicit flag rather than inheriting a default.

## What the mutation pass showed

Nine mutations, each landing on a different case: reverting the guard body reddened the sweep case and one half of the trailer pair; adding a link-authoring phase to the sweep list reddened the phase case; treating an unrecognized trailer as a sweep reddened the unknown-provenance case; `every` → `some` reddened the two-value-trailer case; emptying the widen fallback and letting the unreadable set proceed each reddened its own rung; dropping one count pre-seed reddened seven; folding the two refusal classes back together reddened the duplicate-answer case.

Two shapes worth reusing. **A matched pair is the strongest lock for a mechanism**: two runs making the byte-identical edit to the same file, producing the same diff, differing only in the commit trailer, with opposite outcomes — the read is then the only variable, and any mutation of the exempt list turns one half red. And **an exact-array pin shadows every derived assertion after it**: mutating the constant alone always fails on the pin, so the disjointness and ordering checks had never been watched fail. Mutate the constant AND the pin together to see which derived check is live, and order the derived checks so the broadest one (ordering, which any out-of-place member trips) comes last.

## Also

- The one hole this fix opens is declared rather than closed: `edge-typing` writes a directional rel into the subject only, with an href at an object it does not stamp, so the object is now movable while the edge is invisible to both the mover's repair and the integrity pass. Reachable only under `--deep`, only when the object is an active inbox candidate, and only when nothing re-indexed in between; the residual is one machine-proposed edge dropped with a warning next run.
- The describe letters in a guard suite are a declared sequence — `guard a` through `guard f` were taken, so the new one is `g`. A duplicate letter reads as a rename nobody finished.
