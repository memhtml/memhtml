# A display default never carries a platform separator — and a tilde the expander cannot see becomes a directory

**Tags**: windows, path-separators, display-values, tilde-expansion, generated-docs, byte-gates **Modules**: apps/cli/src/config.ts, packages/store/src/store.ts, AGENTS.md (generated)

## Two failures from one construct

`join("~", "memhtml")` is platform code, and both places it fed were hurt by that:

1. **A generated doc's bytes differed by platform.** The manifest's `MEMHTML_ROOT` row is a DISPLAY default that `agents-doc` renders into AGENTS.md. On win32 `join` produced `~\memhtml`, so the regenerated doc differed from the committed one in bytes that carry no information — and `agents-doc --check`, the drift gate, can never pass on two platforms at once for a reason unrelated to any change.
2. **The same platform spelling defeated the expander.** `expandRoot` recognized `~/` only, so the runtime default (`join("~", "memhtml")` → `~\memhtml` on win32) fell through as a literal path and RESOLVED relative to the process CWD. Observed end state: an unexplained `apps/cli/~/memhtml/areas/arcs/x.html` in the repo — and, because the fixture had no `.git` of its own, the CLI's commit landed in the parent repository's history under the CLI's own commit-subject format. A test-environment default became a real commit on the working branch.

## The rule

**A value that is DISPLAYED or PUBLISHED is a literal; a value that reaches a filesystem goes through the one expander, and the expander accepts every spelling the platform's config surfaces produce.**

- `CONFIG_VARS[].fallback` and `Config.withDefault` for `MEMHTML_ROOT` now carry the literal `"~/memhtml"`; `expandRoot` owns the tilde and the platform spelling of the path it becomes.
- `expandRoot` expands `~`, `~/…` AND `~\…` — a value that arrived through a Windows-native `.env` or MCP-client env block carries the backslash, and the forward-slash-only check is what turned it into a literal `~` directory.
- Byte-gates over generated docs (`agents-doc --check`) are only sound if every input to the generator is platform-invariant; a separator inside any rendered string breaks the gate on exactly one platform, which is the hardest kind of CI flake to attribute.

## Related

[[a-url-pathname-is-not-a-path]] is the same class from the other side: there a URL was treated as a path; here a path was built with a platform's separator and then DISPLAYED as if it were not. Both fail only on one platform, which is why both survived ten releases of green CI.
