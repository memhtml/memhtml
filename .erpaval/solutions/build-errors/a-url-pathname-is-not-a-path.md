# A URL pathname is not a path: `.pathname` dies on Windows before the first statement runs

**Tags**: windows, node-url, fileurltopath, migrations, portability, enoent **Modules**: packages/index/src, every package's tests that resolve a fixture from `import.meta.url`

## The failure, and why CI never saw it

`MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname` produces `/E:/Chyuan/...` on Windows — a leading slash followed by a drive letter. Hand that to `readdir` and it resolves as drive `E:` rooted inside `\E:` on the current drive, so the migration scan dies with `ENOENT: scandir 'E:\E:\...\migrations'` **before the first SQL statement runs**: the indexer cannot start on win32 at all. Baseline-proven by stash: `@memhtml/index` carried 8+ red suites (migrations, FTS, database) that vanish entirely once the one production constant is fixed.

Linux CI cannot see this class — a URL pathname happens to BE a legal POSIX path — so the bug sat in a shipped, tested package through ten releases. The same construct sat in 16 more places: every test fixture resolved from `import.meta.url` (`.pathname`), one docs-site integration hook (`dir.pathname`), and a `dirname(new URL(import.meta.url).pathname)` package-root walk.

## The rule

**`fileURLToPath(new URL(...))`, never `new URL(...).pathname`, wherever a URL becomes a filesystem path.** The check is mechanical: `grep -rn "import.meta.url).pathname"`. Grep the CONSTRUCT, not the symptom — the production site and the sixteen test sites were one construct, and fixing only the production one would have left every fixture-resolution test Windows-red ([[fix-the-sibling-path-with-the-same-shape]]).

Corollary for generated artifacts that ship as source: a file RENDERED from a value built with platform separators (`join("~", "x")` → `~\x` on win32) makes `--check`-style byte gates fail on the other platform. See [[a-display-default-never-carries-a-platform-separator]].

## Verification discipline

A stash-baseline run (stash the fix, run the failing suite, pop) is what separates "pre-existing environmental failure" from "regression I introduced" — both looked identical from a red test name. The migration-scan failure, the chmod-denial failures, and the just-bash sandbox failures all present as ordinary red tests; only the baseline run sorts them.
