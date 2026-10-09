# memhtml-public · CLI

Describes the source at 0.15.1 (main 845ab02, 2026-10-07). Citations are `path:line` into that tree.

The `memhtml` binary is the operator surface for a memhtml root. Its entry point, `bin.ts`, passes `process.argv` to `run` and writes the result with `process.stdout.write` (`apps/cli/src/bin.ts:5`, `apps/cli/src/bin.ts:22`).

Every subcommand is one entry in the `COMMANDS` array (`apps/cli/src/commands.ts:179-1302`). The same array drives the parser, the validator, `memhtml manifest`, `memhtml help`, and the generated `AGENTS.md`. At 0.15.1 it holds 47 commands, and this page has a section for 41 of them.

The six commands without a section are `integrations install`, `integrations uninstall`, `integrations list`, `integrations doctor`, `integrations shell`, and `hook`. `docs/design.md` §12.1, "Host integrations", covers the receipt, the fragment grain, and the hook posture. Two docs-site task pages cover their use: `apps/docs/src/content/docs/learn/operations/wire-a-coding-agent.md` ("Wire up your coding agent") and `apps/docs/src/content/docs/learn/operations/hooks-and-recall.md` ("Hooks and recall"). They appear below only where they share a mechanism with the other commands.

Start with `memhtml manifest`. It returns the whole contract: every command, argument, flag, response type, error code, and environment variable, built by walking `COMMANDS` (`buildManifest` at `apps/cli/src/commands.ts:1551-1579`). It opens no store.

The code in this repository is the software. The memory corpus lives in a separate git repository, the memhtml root. A command acts on the root named by `--repo`, else `$MEMHTML_ROOT`, else `~/memhtml` (`layerRoots` at `apps/cli/src/api-layer.ts:107-116`, `MemhtmlRoot` at `apps/cli/src/config.ts:188-191`).

## Output

A command writes one JSON envelope to stdout. A success is `{apiVersion, type, data}`, and `type` names the shape of `data`. A failure is `{apiVersion, error, code, suggestions}` (`Success` and `Failure` at `apps/cli/src/envelope.ts:62-73`). Branch on `type` and `code`. The `error` prose changes freely.

Three commands write something else to stdout. `help` on a terminal writes Markdown from `renderAgentsDoc` or `renderCommandHelp` (`apps/cli/src/run.ts:1325-1336`). `serve mcp` spawns the server child with `stdio: "inherit"` and writes its `serve.exit` envelope after the child exits (`spawn` at `apps/cli/src/serve.ts:87-90`, `apps/cli/src/run.ts:1690`). `hook` writes the host's own protocol (`apps/cli/src/run.ts:1550-1604`).

Logs go to stderr (`LogToStderr` at `apps/cli/src/run.ts:1817-1819`). `bin.ts` calls `process.exit` from the `process.stdout.write` callback, so a slow pipe reader still gets the whole envelope (`apps/cli/src/bin.ts:22`).

Exit 0 is success. Exit 2 is a usage error, fixed by changing the call. Exit 1 is a runtime failure, fixed by changing the root or the environment (`EXIT_OK`, `EXIT_USAGE`, `EXIT_RUNTIME` at `apps/cli/src/envelope.ts:120-122`).

Three outcomes do not follow the envelope-per-exit pattern. `sleep run` and `sleep resume` exit 1 with a success envelope when a phase failed (`sleepExit` at `apps/cli/src/run.ts:318-319`). `exec` exits 0 when the script itself failed, and reports the script's exit code in the `exec.report` payload (`apps/cli/src/run.ts:1756`). A failure to build the app layer writes no envelope at all; see the next section.

## Conventions

A command section has a usage block, what the command does, its `Arguments:` and `Flags:` lists, a `Response:` line, the fields a caller reads, its error codes, and a `Failure:` paragraph.

A list item reads `` `--name` (type, default, required, repeatable, one of …): "description" ``. The parenthesized part is the manifest's own metadata, with the default written as JSON. The quoted part is the flag's description in `commands.ts`, which `memhtml help` prints. The page adds code formatting around tags and paths and changes no other character. Prose outside the quotes is this page's.

`repeatable` is what the manifest declares. The parser keeps every occurrence of every flag, and each dispatch arm chooses whether it reads all of them (`list`) or the last one (`str`) (`apps/cli/src/run.ts:227-237`). Where the two disagree, the command section says so.

## How a command fails

`run` handles a call in a fixed order, and the step that fails decides the exit code and what is touched (`run` at `apps/cli/src/run.ts:1424-1824`).

1. `parseArgv` turns argv into a command, positionals, and flag arrays. It never fails (`apps/cli/src/run.ts:148-225`).
2. `help`, `--help`, and `-h` are answered at once, before validation (`apps/cli/src/run.ts:1440-1442`). A bare `memhtml` answers the manifest (`apps/cli/src/run.ts:1444`).
3. `validate` refuses a malformed call with exit 2 before any service is built (`apps/cli/src/run.ts:1446-1447`).
4. `manifest`, `agents-doc`, `eval discriminate`, and the `integrations` family answer without opening a root (`apps/cli/src/run.ts:1462-1658`). `hook` is answered in the same block, but it opens an existing store and never scaffolds one (`hookStoreReady` at `apps/cli/src/run.ts:1587`, `layerApp` at `apps/cli/src/run.ts:1601`).
5. With `MEMHTML_REFUSE_ENV_ROOT` set and no `--repo`, every remaining command is refused with `ERR_REPO_REQUIRED` at exit 2 (`envRootRefusal` at `apps/cli/src/run.ts:1077-1090`, `apps/cli/src/run.ts:1665-1666`).
6. `serve mcp` and `exec` resolve the root themselves and build no app layer (`apps/cli/src/run.ts:1681-1770`).
7. `apply` reads and decodes its whole op stream; a bad stream is exit 2 with nothing opened (`apps/cli/src/run.ts:1784-1795`).
8. Every other command runs its `dispatch` arm inside `layerApp(--repo)`. A typed failure becomes an envelope through `failureFor` at exit 1, and a defect becomes `ERR_UNKNOWN` at exit 1 (`apps/cli/src/run.ts:1797-1808`).

Step 8 has a side effect before the command runs. Building `layerApp` opens the database through `layerDatabase`, which creates `<root>/.memhtml/` with `mkdir -p`, creates `index.db` and `state.db`, sets WAL, and applies pending migrations (`layerDatabase` at `apps/cli/src/api-layer.ts:126-136`, `makeDatabase` at `packages/index/src/database.ts:322-349`). A read command on a root that does not exist therefore creates `<root>/.memhtml/`. An index read such as `search` then answers empty at exit 0, while a file or git read fails. On a migrated store the build changes nothing.

A failure while building that layer gets no envelope. `layerDatabase` is `Layer.orDie`, and the layer is provided outside the `catchCause` that turns defects into `ERR_UNKNOWN` (`apps/cli/src/api-layer.ts:136`, `apps/cli/src/run.ts:1803-1808`). A root that is a file, an unreadable database, a failed migration, or an unusable `MEMHTML_VECTOR_COVERAGE_FLOOR` ends with empty stdout, a stack on stderr, and exit 1.

Every command can return the usage codes at exit 2: `ERR_UNKNOWN_COMMAND`, `ERR_MISSING_ARGUMENT`, `ERR_INVALID_FLAG`, `ERR_UNEXPECTED_ARGUMENT`, and `ERR_REPO_REQUIRED` where step 5 applies (`USAGE_ERROR_CODES` at `apps/cli/src/help.ts:26-32`). Every command run through step 8 can also return `ERR_STORAGE` and `ERR_UNKNOWN` at exit 1. The per-command `Errors:` lists below name the rest.

## What a failed write leaves behind

The store-backed writes are `write`, `apply`, `correct`, `link`, `archive`, and `task add`, plus `task status done`. Each fails in one of three phases.

1. Validation runs before the store touches disk: the strict-path gate, the render gate, the content-hash dedupe lookup, and placement (`writeMemory` at `packages/store/src/store.ts:707-739`). A refusal here leaves the tree byte-identical.
2. The file writes, `git add`, and `git commit` run under a journal. On a failure the store unstages every path it touched and restores each one's earlier bytes (`restore` at `packages/store/src/store.ts:519-535`). If that restore fails, `compensated` only logs it and the tree is left dirty (`packages/store/src/store.ts:550-562`). Directories made by `mkdir` stay. The journal also runs when `git commit` landed and the `rev-parse` after it failed: the commit stays, and the restore removes the commit's new files from the worktree and puts back the earlier bytes of the files it changed (`commit` at `packages/store/src/git.ts:397-413`).
3. After the commit, the operation calls `reindex` (`apps/cli/src/operations.ts:267-271`). That step can fail with `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` after the commit landed. The call exits 1, but the memory is in git.

A blind retry after a phase-3 failure writes the memory again under a `-2` path. Dedupe reads the index through `activePathForHash`, and the index has not seen the commit (`packages/index/src/traces-persist.ts:196-203`). Two active files with one content hash then make every later reindex fail on the unique index over active non-task content hashes, so every later write commits and exits 1 until one of the pair is archived (`files_content_hash_active` at `packages/index/migrations/0008_tasks.sql:126-127`).

The journal compensates any failure the fiber sees: a typed failure, a defect, or an interruption (`Effect.onError` in `compensated` at `packages/store/src/store.ts:550-562`). A killed process skips it. `bin.ts` installs no signal handler, so a killed process can leave files written or staged (`apps/cli/src/bin.ts:1-22`).

The commit is `git commit -m` with no pathspec, after a `git diff --cached --quiet` check, so it also commits any path that was already staged in the root (`commit` at `packages/store/src/git.ts:397-413`). `init`, `publish`, `state export`, `doctor --fix`, and `task status` commit the same way.

Writes in one process take turns behind one permit, `oneWriterAtATime`, created in `makeStore` (`packages/store/src/store.ts:1396-1416`). A second process on the same root, such as `memhtml serve mcp` beside a CLI command, has its own permit. Across processes the only guard is git's own index lock, held per git command rather than per write, so a contended git command fails with `ERR_GIT`. `init`, `task status`, `publish`, `state export`, `doctor --fix`, and the sleep cycle's phase commits do not take the permit at all (`initRepo` at `apps/cli/src/run.ts:341-346`, `commitPhase` at `packages/sleep/src/commit.ts:69-83`).

SQLite writes are serialized by the database, not by memhtml. `index.db` runs in WAL mode with a 5000 ms busy timeout, and a busy failure is retried with backoff (`BUSY_TIMEOUT_MS` at `packages/index/src/database.ts:22`, `packages/index/src/database.ts:147-150`). `state.db` is attached after the WAL pragma runs, so it stays in the default rollback-journal mode (`packages/index/src/database.ts:341-349`). No lock spans an index operation and a git operation.

## Global flags

Three flags apply to every command. They are declared once in `GLOBAL_FLAGS`, so the manifest and the parser read one declaration (`apps/cli/src/commands.ts:62-82`).

Flags:

- `--dense` (boolean, default `false`): "Minify JSON and drop null fields, for pasting into a context window."
- `--repo` (string, default `""`): "Path to the memory repo. Defaults to $MEMHTML_ROOT."
- `--help` (boolean, default `false`): "Describe this command instead of running it: usage, arguments, flags, response type, examples. Also `-h`. Markdown when stdout is a terminal, a `cli.help` envelope when piped or with --json. Flags other than --json and --dense are ignored, nothing is opened or written, exit 0."

`--dense` drops null and undefined fields at every depth and minifies (`stripNulls` and `render` at `apps/cli/src/envelope.ts:176-189`). Empty arrays stay.

`--repo` is trimmed and used as given (`layerRoots` at `apps/cli/src/api-layer.ts:112-113`). A leading `~` in it is not expanded, while the same value in `MEMHTML_ROOT` is (`MemhtmlRoot` at `apps/cli/src/config.ts:188-191`). A blank `--repo` falls back to the environment.

`--help` keeps `--json`, `--dense`, and `--repo` and drops every other flag on the line (`HELP_FLAGS` at `apps/cli/src/run.ts:1308-1311`). It never opens a root.

There is no global `--json` flag. The envelope is the only output most commands have, so `--json` is declared on `help` alone, the one command with a second shape (`GLOBAL_FLAGS` at `apps/cli/src/commands.ts:62-82`, the `help` entry at `apps/cli/src/commands.ts:188-212`).

The parser accepts `--flag value`, `--flag=value`, `--no-flag`, bare `--flag`, and `-h` for `--help` (`parseArgv` at `apps/cli/src/run.ts:148-205`). Only a flag the table types `string` or `int` takes the next token as its value, and only when that token does not start with `--` (`apps/cli/src/run.ts:185-191`). `--no-<name>` works only for a declared flag name.

A boolean reads `false` for `--no-flag`, `--flag=false`, `--flag=0`, and `--flag=no`, and `true` otherwise (`bool` at `apps/cli/src/run.ts:239-245`). A boolean followed by `true`, `false`, `yes`, `no`, `0`, or `1` as a separate word is refused; the next section has the rule (`BOOLEAN_VALUE_TOKENS` at `apps/cli/src/run.ts:121`).

An `int` flag goes through `Number.parseInt`, so `7.9` reads as 7 and a value that does not parse is silently treated as absent (`int` at `apps/cli/src/run.ts:248-253`). The few number-valued `string` flags go through `Number.parseFloat` the same way (`num` at `apps/cli/src/run.ts:256-261`). Neither reader checks a range. A value-taking flag given with no value is stored as `true`, which every reader treats as absent.

## Flag and argument validation

`validate` checks a call against this command's spec and the three globals, never against the union of every command's flags (`validateAgainst` at `apps/cli/src/run.ts:1176-1271`). A flag that is valid on another command is still `ERR_INVALID_FLAG` here, with that command among the suggestions. `memhtml list --status todo` is refused and points at `task list`.

The rules run in this order, and the first refusal wins:

1. A flag this command does not declare: `ERR_INVALID_FLAG` (`apps/cli/src/run.ts:1188-1202`).
2. A boolean flag followed by a value-shaped word, such as `--embed false`: `ERR_INVALID_FLAG`, naming `--embed=false` and `--no-embed` (`strayBooleanFlags` at `apps/cli/src/run.ts:995-1004`).
3. A positional past what the command declares: `ERR_UNEXPECTED_ARGUMENT`, unless the last argument is `repeatable` (`surplusArgs` at `apps/cli/src/run.ts:1028-1043`). A bare `-` is exempt on `apply` and `exec`, where it names stdin (`STDIN_MARKER_COMMANDS` at `apps/cli/src/run.ts:1014`).
4. A required positional absent: `ERR_MISSING_ARGUMENT` (`apps/cli/src/run.ts:1212-1221`).
5. A required flag absent: `ERR_MISSING_ARGUMENT` (`apps/cli/src/run.ts:1223-1232`).
6. `write` and `correct` without exactly one of `--claim` and `--article-html` (`claimOrArticle` at `apps/cli/src/run.ts:924-949`).
7. `exec` and `apply` input doors (`execFlags` at `apps/cli/src/run.ts:847-889`, `applyFlags` at `apps/cli/src/run.ts:899-910`).
8. An `--as-of` outside `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ssZ`: `ERR_INVALID_FLAG` (`asOfFlag` at `apps/cli/src/run.ts:970-982`).
9. A value outside a flag's declared `values`: `ERR_INVALID_FLAG` with the nearest spellings. Every occurrence of a repeated flag is checked (`apps/cli/src/run.ts:1256-1268`).

Then the closed vocabularies that arrive as positionals are checked, for `hook` and the `integrations` verbs only (`vocabularyPositionals` at `apps/cli/src/run.ts:1123-1143`). The rel of `link`, the status of `task status`, and the paths of every command are checked later, at exit 1.

Every refusal of a known command ends with that command's help pointer, `memhtml help <cmd>`, appended once in `validate` (`apps/cli/src/run.ts:1162-1172`). An unknown command gets nearest names instead, measured against the whole typed invocation, so `memhtml index rebiuld` suggests `index rebuild` (`unknownCommand` at `apps/cli/src/run.ts:806-817`).

The help pointer is added only by `validate`. Refusals raised later, such as `apply`'s line errors, carry their own suggestions and no pointer.

## manifest

```
memhtml manifest
```

Returns `buildManifest()`: `name`, `version`, `summary`, `apiVersion`, `guide`, `globalFlags`, `errorCodes`, `config`, `responseTypes`, and `commands` (`apps/cli/src/commands.ts:1551-1579`). Each command entry carries its `args`, `flags`, `responseTypes`, `examples` (always an array), `supportsJson`, and `supportsDense`.

This command takes no arguments and no flags (`apps/cli/src/commands.ts:180-187`).

Response: `cli.manifest`.

`responseTypes` is derived from the commands, not copied from `RESPONSE_TYPES`; at 0.15.1 both hold 41 types (`apps/cli/src/commands.ts:1566`, `RESPONSE_TYPES` at `apps/cli/src/envelope.ts:12-58`). `guide` holds seven topic blocks, the prose an agent reads first (`GUIDE` at `apps/cli/src/commands.ts:1335-1542`).

Errors: only the usage codes. `memhtml manifest --sha 1` is `ERR_INVALID_FLAG` at exit 2.

Failure: `manifest` is answered after `validate` and before any root is resolved (`apps/cli/src/run.ts:1462-1464`). It opens no store, reads no environment variable, and writes nothing, so it works as a liveness check. A bare `memhtml` returns the same envelope without validation (`apps/cli/src/run.ts:1444`).

## help

```
memhtml help [command]
memhtml help index rebuild --json
memhtml <command> --help
```

Describes one command, or the whole manifest when no command is named (`help` at `apps/cli/src/run.ts:1294-1377`).

Arguments:

- `[command]` (optional, repeatable): "The command to describe, one or two words (`search`, `index rebuild`). Omitted: the whole manifest, as Markdown on a terminal and as the cli.manifest envelope when piped."

Flags:

- `--json` (boolean, default `false`): "Emit the cli.help envelope even when stdout is a terminal. Wins over the terminal check, so a script can never receive Markdown by accident."

Response: `cli.help`, `cli.manifest`.

`cli.help` is the manifest's entry for the command plus four derived fields: `usage`, `globalFlags`, `usageErrorCodes`, and `seeAlso` (`helpData` at `apps/cli/src/help.ts:64-74`). `usage` always ends in `[flags]` (`usageOf` at `apps/cli/src/help.ts:39-45`). `seeAlso` lists the commands sharing this one's noun or one of its response types (`seeAlsoOf` at `apps/cli/src/help.ts:52-61`).

Output shape follows one rule. With stdout a terminal and no `--json`, the answer is Markdown: `renderCommandHelp` for one command, the whole generated `AGENTS.md` from `renderAgentsDoc` for none. Otherwise it is the envelope (`apps/cli/src/run.ts:1325-1336`, `apps/cli/src/run.ts:1374-1376`).

The `--help` form keeps only `--help`, `--json`, `--dense`, and `--repo`, so `memhtml search --type x --help` describes `search` (`apps/cli/src/run.ts:1308-1311`). The spelled-out form validates every flag as a flag of `help`, so `memhtml help search --limit 5` is refused.

Errors:

- `ERR_UNKNOWN_COMMAND` (exit 2) for a name that is not a command. A noun alone, such as `memhtml help index`, lists the family as suggestions (`apps/cli/src/run.ts:1358-1372`).
- `ERR_UNEXPECTED_ARGUMENT` (exit 2) for a known command followed by a stray word (`apps/cli/src/run.ts:1343-1357`).

Failure: help never resolves a root, never opens a store, and writes nothing. A refusal is an envelope at exit 2 even on a terminal.

## init

```
memhtml init
```

Scaffolds a memory repository at the root (`initRepo` at `packages/store/src/layout.ts:183-211`). It runs `git init -b main` if the root is not yet a repository, sets `merge.ours.driver` in the local git config, writes each missing scaffold file, stages the scaffold paths, and commits them.

This command takes no arguments and no flags (`apps/cli/src/commands.ts:213-219`).

Response: `repo.init`.

A caller reads `root`, `created`, `headSha`, and `wrote` (`InitResult` at `packages/store/src/layout.ts:103-111`). `created` is true when this call ran `git init` (`packages/store/src/layout.ts:210`). `wrote` lists the scaffold files this call created. The scaffold is the PARA bucket `.gitkeep` files, `.gitignore` for the two databases, `.gitattributes` with the `merge=ours` listings driver, and `README.html` (`SCAFFOLD_DIRS`, `GITIGNORE`, and `GITATTRIBUTES` at `packages/store/src/layout.ts:41-73`).

`init` is dispatched inside `layerApp`, so it also creates and migrates `.memhtml/index.db` and `state.db` (`apps/cli/src/run.ts:341-346`).

Re-running `init` on a scaffolded repository writes no file and makes no commit: `wrote` is empty and `headSha` is unchanged. It is not a no-op for git config, which it sets again. On an existing repository without the scaffold it reports `created: false`, writes the scaffold, and commits it. An existing `.gitignore`, `.gitattributes`, or `README.html` is kept as it is and never merged (`packages/store/src/layout.ts:113-128`). Files already in a non-empty directory are left untracked.

Errors:

- `ERR_GIT` (exit 1) from `git init`, `git config`, `git add`, or `git commit`, for example when git has no identity configured (`initRepo` at `packages/store/src/layout.ts:186-209`).
- `ERR_STORAGE` (exit 1) from a scaffold write, with operation `init.mkdir` or `init.write:<path>`.

Failure: `init` is not transactional. The writes land first, then `git add`, then `git commit` (`packages/store/src/layout.ts:200-209`). If the commit fails, the scaffold stays written and staged, and a re-run finishes the commit. The commit also takes any path that was already staged.

## write

```
memhtml write --title <title> --type <type> --claim <sentence> [--body <paragraph>]...
memhtml write --title <title> --type <type> --article-html <markup>
```

Writes one memory, commits it, and reindexes (`writeMemory` at `apps/cli/src/operations.ts:335-344`). The store runs the strict-path gate, renders and checks the article, looks up the content hash, picks a free path, then writes, stages, and commits under a journal (`writeMemory` at `packages/store/src/store.ts:707-767`). It reindexes only when a file was created, then records a `wrote` session link.

Flags:

- `--title` (string, required): "The memory's title. Becomes the `<title>` and the filename slug."
- `--claim` (string): "The one load-bearing sentence. Becomes the `<mark>` span and files.gist. Exactly one of --claim or --article-html."
- `--body` (string, repeatable): "A prose paragraph after the claim. Repeatable, one `<p>` each."
- `--article-html` (string): "Raw `<article>` markup used verbatim in place of --claim/--body. Must contain exactly one `<mark>` in the first `<p>` or `<li>`; the first `<time datetime>` becomes the memory's event time. The store refuses format violations before any commit. Exactly one of --claim or --article-html."
- `--type` (string, required, one of `episodic`, `semantic`, `procedural`, `agent_insight`, `user_preference`, `error_pattern`, `verdict`, `precedent`, `arc`, `task`): "The memory type. `arc` is admitted here, on the operator surface, for curated import and deliberately authored rules; the agent tools (`memory_write`) still refuse it, because an agent naming an arc asserts a conclusion the corpus has not earned."
- `--path` (string): "An explicit path override. One that is not a usable memory path (rooted in a PARA bucket, ending in .html, no `.` or `..` segment) is IGNORED and the placement rule decides instead, so a malformed override lands the memory somewhere you did not name — pass --strict-path to have it refused instead. One a file ALREADY occupies is REFUSED with ERR_WRITE_CONFLICT and nothing is written or committed: this corpus overwrites nothing, and an explicit path gets no `-2` suffix because you named one path. To replace what a memory says, use `memhtml correct <path>`."
- `--strict-path` (boolean, default `false`): "Refuse an unusable --path instead of letting the placement rule decide. By default a --path that is not a usable memory path is re-derived, so the memory lands somewhere you did not name and the response reports that other path as a success. With this flag the write is REFUSED with ERR_INVALID_MEMORY naming the clause the path broke, and nothing is written, staged, or committed. It governs the path you NAMED: with no --path there is nothing to be strict about and the flag changes nothing, while an EMPTY or blank --path is named rather than absent and is refused — that is what your own path template renders when it produced nothing. An OCCUPIED path is refused with ERR_WRITE_CONFLICT with or without it."
- `--workspace` (string): "Routes the memory to `projects/<slug>/`."
- `--tag` (string): "A tag. Repeatable; the first one routes an unplaced resource memory."
- `--entity` (string, repeatable): "A `type:name` entity reference, e.g. service:checkout-api. Repeatable."
- `--importance` (int): "1-10, a display ordinal. The retention scorer divides by 10."
- `--confidence` (string): "0-1. 1.0 is an unqualified assertion."
- `--session-id` (string): "The Claude Code session. Stamped into the head AND indexed as a link."
- `--prompt-id` (string): "The prompt within that session."
- `--turn-uuid` (string): "The turn within that session."

Response: `memory.written`.

A caller reads `path`, `created`, `deduped`, `existingPath`, `commitSha`, and `contentHash` (`WriteResult` at `packages/store/src/store.ts:95-105`). Exactly one of `created` and `deduped` is true. On a dedupe, `path` and `existingPath` name the stored file, `commitSha` is null, and nothing is written or committed (`packages/store/src/store.ts:719-729`).

A duplicate is never an error. `ERR_DUPLICATE_CONTENT` is in `ERROR_CODES`, but no code path constructs `DuplicateContent`. The lookup skips stored tasks and archived memories, so a write whose article matches an active non-task memory of any type dedupes onto it (`activePathForHash` at `packages/index/src/traces-persist.ts:196-203`).

`--tag` is declared without `repeatable`, but the dispatch arm reads every occurrence with `list` (`apps/cli/src/run.ts:362`). `--importance` and `--confidence` are not range-checked (`apps/cli/src/run.ts:364-365`). Without `--strict-path`, an unusable `--path` is replaced by the placement rule and the write still succeeds.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) when `--strict-path` refuses the path, when the render gate refuses the article (for example an empty `<mark>` from `--claim=`), or when `--type` was given with no value (`strictPathRefusal` at `packages/store/src/store.ts:692-705`, `renderChecked` at `packages/store/src/store.ts:661-668`).
- `ERR_WRITE_CONFLICT` (exit 1) when an explicit `--path` is occupied and the content is not already stored. Nothing is written (`WriteConflict` in `freePathFor` at `packages/store/src/store.ts:417-441`). A duplicate dedupes first, so it returns `deduped: true` at the stored path, exit 0 (`packages/store/src/store.ts:719-729`).
- `ERR_STORAGE` (exit 1) when the dedupe lookup or the file write fails, or after 1000 slug collisions, as `write.pathExhausted` (`packages/store/src/store.ts:447-466`).
- `ERR_GIT` (exit 1) from `git hash-object`, `add`, `commit`, or `rev-parse` (`packages/store/src/git.ts:385-413`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` (exit 1) from `reindex`, after the commit landed (`apps/cli/src/operations.ts:267-271`).

Failure: a usage error is refused before anything is opened. A gate refusal, a dedupe, or a conflict leaves the tree byte-identical. A git or storage failure during the write is compensated by the journal. A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit and removes its new file from the worktree. A `reindex` failure leaves the memory committed and unindexed, and a retry writes a second copy (see [What a failed write leaves behind](#what-a-failed-write-leaves-behind)). A failure to record the session link is logged and swallowed (`recordLink` at `apps/cli/src/operations.ts:201-217`). No model is called: entity extraction runs only in `apply`.

## apply

```
memhtml apply --file ops.jsonl
memhtml apply --file -
memhtml apply -
```

Writes many memories from a JSONL op stream (`batchWrite` at `apps/cli/src/operations.ts:882-1083`). The whole stream is read and shape-checked before any service is built (`decodeApply` at `apps/cli/src/apply.ts:297-326`, `apps/cli/src/run.ts:1784-1795`). Then the optional assists run, every op is decoded, entities are extracted, and `writeMemories` validates every op before one write, stage, and commit (`writeMemories` at `packages/store/src/store.ts:893-1020`). One `reindex` follows.

Flags:

- `--file` (string): "The JSONL file to read. One complete JSON object per line. Omit it, pass `--file -`, or pass a positional `-` to read the stream from stdin; stdin beside a real --file is refused."
- `--continue-on-error` (boolean, default `false`): "Best-effort: a refused op is reported and skipped while every surviving op lands in the one commit. Atomic by default. The first refused op aborts the batch and nothing is written."
- `--detect-conflicts` (boolean, default `false`): "Report each op's frame-matches as a per-op `conflict`: the ACTIVE memory (or the earlier op) whose claim occupies the same subject-and-relation slot. PROPOSE-ONLY: every op still writes exactly as it would have, because sometimes the contradiction is the answer. You decide: write anyway, `memhtml correct` the match, or drop the line."
- `--detect-near-duplicates` (boolean, default `false`): "Report each op's embedding near-duplicates as a per-op `near_duplicates` list: ACTIVE memories (or earlier ops in this stream) whose text sits at or above cosine 0.92 against this op's claim and body, best first, with the measured similarity. The vector sibling of --detect-conflicts: that flag catches a DIFFERENT value in the same grammatical slot, this one catches a REWORDING of the same fact. PROPOSE-ONLY for the same reason, and the score is geometry — negations also sit above 0.92, so read the paired claim before folding anything. Costs one embedding call per batch; ops written as `article_html` are never checked; when the embedder cannot run (MEMHTML_EMBED=off, or the call failed) the result carries `near_duplicates_degraded: true` and every `near_duplicates` is null, meaning UNCHECKED rather than unique."
- `--consolidate` (string, one of `last-wins`): "Resolve frame-key matches instead of only reporting them: `--consolidate last-wins` makes the LATER op's value win a shared claim slot (one file, written at the FIRST index that claimed the slot, with each later restatement reporting `consolidated_into` naming that slot) and archives a stored ACTIVE memory a surviving slot displaces, reported as `superseded_path`. Off by default; claims with no frame shape are never consolidated."
- `--session-id` (string): "The Claude Code session for every op that names none. A line's own `session_id` wins over this."
- `--prompt-id` (string): "The prompt within that session."
- `--turn-uuid` (string): "The turn within that session."

Response: `batch.applied`.

A caller reads `results`, `summary`, `commit_sha`, and `near_duplicates_degraded` (`applyPayload` at `apps/cli/src/apply.ts:434-439`). Each result carries `index`, `ok`, `path`, `deduped`, `existing_path`, `code`, `error`, `skipped`, `conflict`, `near_duplicates`, `consolidated_into`, and `superseded_path`, in input order (`opPayload` at `apps/cli/src/apply.ts:383-432`). `summary` counts `total`, `written`, `deduped`, `failed`, `skipped`, and `consolidated` (`apps/cli/src/operations.ts:1131-1147`). `commit_sha` is null when nothing was committed.

A refused op is data, not an error envelope. By default the first refused op aborts the batch: nothing is written, the refused op carries its `code` and `error`, and the rest report `skipped: true`, all at exit 0 (`apps/cli/src/operations.ts:954-962`). With `--continue-on-error` the survivors land in the one commit. The per-op codes are `ERR_INVALID_MEMORY` and `ERR_WRITE_CONFLICT`, mapped by the same `codeFor` every envelope uses (`reportFailure` at `apps/cli/src/operations.ts:505-510`).

A model failure never fails a batch. A failed extraction is logged and the batch is written without extracted entities (`extractor.extract` at `apps/cli/src/operations.ts:984-988`). A failed or disabled embedder sets `near_duplicates_degraded` (`embedder.embed` at `apps/cli/src/operations.ts:670-681`).

`--consolidate last-wins` breaks the one-commit rule. When a surviving slot displaces a stored active memory, a second pass supersedes it in its own commit and its own `reindex`, and `commit_sha` names only the batch commit (`apps/cli/src/operations.ts:1039-1068`).

On a line that carries both `body` and `article_html`, nothing refuses the pair: the article is written and the body is dropped (`apps/cli/src/apply.ts:256-275`). `status` and `due` on a non-task op are ignored.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for a positional `-` beside a real `--file`, a line that is not a JSON object, an unknown field, or a field of the wrong type (`lineError` at `apps/cli/src/apply.ts:74-79`).
- `ERR_MISSING_ARGUMENT` (exit 2) for a line without `op`, `title`, or `type`, or a stream with no ops (`apps/cli/src/apply.ts:311-323`).
- `ERR_PATH_NOT_FOUND` (exit 2) when `--file` cannot be read (`applyText` at `apps/cli/src/apply.ts:341-351`).
- `ERR_STORAGE` or `ERR_GIT` (exit 1) from the dedupe lookup, placement, write, stage, or commit of the batch.
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` (exit 1) from `reindex`, after the commit landed.

Failure: a bad stream is refused at exit 2 before any database or git command runs. An atomic abort writes nothing. A git or storage failure during the write pass is compensated by one journal over every path the pass reached (`makeJournal` at `packages/store/src/store.ts:983-999`). A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit and removes the batch's new files from the worktree. A `reindex` failure after the commit replaces the whole payload with an error envelope, so the caller never sees the per-op paths, and a blind retry writes every op again under `-2` paths. A failed supersede pass is logged, leaves `superseded_path` null, and keeps the batch commit (`supersedeMemories` at `apps/cli/src/operations.ts:1053-1057`).

The atomicity is one call's: one validation pass, one journal, one commit. `writeMemories` and the supersede pass take the per-process permit separately, so another writer in the same process can land between them.

## read

```
memhtml read <path>
```

Reads one memory file from the working tree, parses it, and returns it (`readMemory` at `apps/cli/src/operations.ts:1162-1169`, `readRaw` at `packages/store/src/store.ts:468-473`). It reads uncommitted edits too, and does not consult the index.

Arguments:

- `<path>` (required): "Repo-root-relative path to the memory."

Flags:

- `--session-id` (string): "Records a `read` session link, so provenance is queryable both ways."
- `--prompt-id` (string): "The prompt within that session."
- `--turn-uuid` (string): "The turn within that session."

Response: `memory.detail`.

A caller reads `path`, `title`, `metas`, `entities`, `tags`, `links`, `gist`, `body`, `html`, `archived`, and `warnings` (`apps/cli/src/run.ts:394-413`). `archived` is true when the `status` meta is `archived`. `warnings` lists the file's format warnings.

`read` is not read-only. A successful read bumps the path's access row in `state.db`, at most once per 900 seconds (`bumpAccess` at `apps/cli/src/operations.ts:1217-1229`, `REINFORCE_COOLDOWN_S` at `packages/domain/src/ranking.ts:17`). With `--session-id` it also inserts a `read` row into `memory_session_links` in `index.db` (`recordLink` at `apps/cli/src/operations.ts:198-217`). `--prompt-id` and `--turn-uuid` are ignored without `--session-id`.

Errors:

- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at the path. The suggestions start with `memhtml resolve` (`PathNotFound` in `SUGGESTIONS` at `apps/cli/src/errors.ts:155-159`).
- `ERR_INVALID_MEMORY` (exit 1) when the file does not parse; the message lists the violations.

Failure: a refused read writes nothing beyond the layer build's own side effect. Both bookkeeping writes swallow their failures as stderr warnings, so a locked `state.db` delays the read and then returns it at exit 0 (`bumpAccess` at `apps/cli/src/operations.ts:1217-1227`).

## search

```
memhtml search <query> [--limit 10]
```

Ranked search over the index: the full-text, vector, recency, and salience arms fused by reciprocal rank, a polarity re-score, then MMR (`search` at `packages/index/src/retrieval.ts:502-594`). The vector arm runs only when the share of chunks with a vector in the configured space clears the coverage floor (`gatedQueryVector` at `packages/index/src/retrieval.ts:304-316`).

Arguments:

- `<query>` (required): "Prose. A double-quoted span demands those words in that order; nothing else is syntax."

Flags:

- `--type` (string, repeatable, one of `episodic`, `semantic`, `procedural`, `agent_insight`, `user_preference`, `error_pattern`, `verdict`, `precedent`, `task`): "Restrict to one memory type. Repeatable; each occurrence broadens (ANY-of)."
- `--workspace` (string): "Restrict to one workspace. STRICT: a scoped query never returns a memory with no workspace."
- `--tag` (string, repeatable): "Restrict to memories carrying any of these tags. Repeatable; each broadens."
- `--entity` (string): "Restrict to memories carrying one `type:name` entity reference, e.g. service:checkout-api, the form a hit's `entities` publishes, so a hop is a copy. A scope matching nothing returns no hits and says so; it never widens."
- `--facet` (string, repeatable): "Restrict to memories carrying a `<dl>` facet, as name=value; the value may contain `=`, the name may not. Repeatable, and the composition is fixed: values under the SAME name broaden (--facet doc-type=runbook --facet doc-type=guide is either), DIFFERENT names narrow (--facet doc-type=runbook --facet tier=1 is both). This is the extension axis: memhtml's element and meta vocabularies are closed, so a consumer's own document kinds, states, and tiers live in `<dt>`/`<dd>` pairs and are queried here. The match is on the facet's TEXT with no case folding, so write the halves you mean to query. The stored form is the element's text content, which the parser collapses whitespace runs in and trims — so `<dd>runbook  rollback</dd>` is stored and queried single-spaced. There is no numeric comparison: a `<data value>` is indexed UNITLESS because the unit lives in the prose beside it, so the caller owns the unit and matches the text it wrote."
- `--include-archived` (boolean, default `false`): "Include archived memories. Eviction is a `git mv`, so they still exist."
- `--as-of` (string): "Point-in-time view: returns what was believed valid at this ISO instant, including since-superseded memories (marked superseded_by). The validity window is `coalesce(valid_from, event_at, created_at) <= as-of < valid_until`."
- `--limit` (int, default `10`): "Hits to return."

Response: `memory.hits`.

A caller reads `hits`, each with `path`, `title`, `gist`, `memoryType`, `score`, `confidence`, `updatedAt`, `snippet`, `entities`, and `supersededBy` (`packages/index/src/retrieval.ts:556-593`). Beside them are `degraded` (no query vector), `vectorCoverage`, `arms`, `entityScope`, `scopeEmpty`, and, when a scope matched nothing, `archivedMatches` and `archived`. `score` is the hit's rank after the polarity step, not the fused sum.

The seven flags before `--limit` are `SCOPE_FLAGS`, shared with `recall` (`apps/cli/src/commands.ts:120-167`). `--type` takes the nine writable types, so `--type arc` is refused at exit 2. An unscoped search excludes tasks only; `--type task` opts them in.

A `--facet` without `=`, or with an empty half, is dropped silently and the search runs unscoped on that axis (`parseFacetFilters` at `packages/index/src/scope.ts:57-70`). `--entity` is trimmed and case-folded on both sides. `--limit` has no clamp; `0` or a negative value returns no hits.

A query that matches no term still returns hits, because the recency and salience arms need no term.

Errors:

- `ERR_STORAGE` (exit 1) from a database read. It is the only runtime code: an embedder failure sets `degraded: true` instead of failing, and a stale index answers for the commit it describes.

Failure: `search` writes nothing, not even an access bump: `searchMemories` calls retrieval and nothing else (`apps/cli/src/operations.ts:1188-1192`). It reads in several statements with no snapshot, so a path removed between two of them drops out of the answer.

## recall

```
memhtml recall <query> [--budget 16000]
```

Builds a disclosure pack under a character budget (`recall` at `packages/index/src/retrieval.ts:596-648`). It runs the same coverage gate and fusion as `search` over a fixed pool of 30 candidates, with the polarity step and no MMR. Arcs fold under their own fixed 9000-character budget and every other memory under `--budget` (`ARC_BODY_BUDGET` at `packages/index/src/disclosure.ts:20`).

Arguments:

- `<query>` (required): "Prose. A double-quoted span demands those words in that order; nothing else is syntax."

Flags:

- `--type` (string, repeatable, one of `episodic`, `semantic`, `procedural`, `agent_insight`, `user_preference`, `error_pattern`, `verdict`, `precedent`, `task`): "Restrict to one memory type. Repeatable; each occurrence broadens (ANY-of)."
- `--workspace` (string): "Restrict to one workspace. STRICT: a scoped query never returns a memory with no workspace."
- `--tag` (string, repeatable): "Restrict to memories carrying any of these tags. Repeatable; each broadens."
- `--entity` (string): "Restrict to memories carrying one `type:name` entity reference, e.g. service:checkout-api, the form a hit's `entities` publishes, so a hop is a copy. A scope matching nothing returns no hits and says so; it never widens."
- `--facet` (string, repeatable): "Restrict to memories carrying a `<dl>` facet, as name=value; the value may contain `=`, the name may not. Repeatable, and the composition is fixed: values under the SAME name broaden (--facet doc-type=runbook --facet doc-type=guide is either), DIFFERENT names narrow (--facet doc-type=runbook --facet tier=1 is both). This is the extension axis: memhtml's element and meta vocabularies are closed, so a consumer's own document kinds, states, and tiers live in `<dt>`/`<dd>` pairs and are queried here. The match is on the facet's TEXT with no case folding, so write the halves you mean to query. The stored form is the element's text content, which the parser collapses whitespace runs in and trims — so `<dd>runbook  rollback</dd>` is stored and queried single-spaced. There is no numeric comparison: a `<data value>` is indexed UNITLESS because the unit lives in the prose beside it, so the caller owns the unit and matches the text it wrote."
- `--include-archived` (boolean, default `false`): "Include archived memories. Eviction is a `git mv`, so they still exist."
- `--as-of` (string): "Point-in-time view: returns what was believed valid at this ISO instant, including since-superseded memories (marked superseded_by). The validity window is `coalesce(valid_from, event_at, created_at) <= as-of < valid_until`."
- `--budget` (int, default `16000`): "Characters of quoted body. Arcs get their own envelope on top."

Response: `recall.pack`.

A caller reads `arcs` and `memories`, each with `disclosed`, `indexLines`, `spentChars`, and `truncated`, plus top-level `spentChars`, `truncated`, `degraded`, and `vectorCoverage` (`packages/index/src/retrieval.ts:640-647`). A disclosed entry carries `path`, `title`, `gist`, `memoryType`, and `body`. An index line carries the same fields without `body`.

The scope flags behave as on `search`. `--type arc` is refused here too, although the pack has an arc envelope. `--budget` has no clamp; `0` turns every hit into an index line.

Errors:

- `ERR_STORAGE` (exit 1), as on `search`.

Failure: `recall` writes nothing. An embedder failure degrades the pack rather than failing it.

## correct

```
memhtml correct <target> --title <title> --claim <sentence>
memhtml correct <target> --title <title> --article-html <markup>
```

Supersedes a memory (`correctMemory` at `apps/cli/src/operations.ts:1256-1284`). It reads the target, defaults the new type to the target's, renders the new article, and places it. The store counts the target's own path as vacated only for an explicit path, and the CLI passes none (`freePathFor` at `packages/store/src/store.ts:417-441`). Then, under one journal, it archives the target with its stamps, writes the new file with a `supersedes` link to the archive path, and makes one commit (`correctMemory` at `packages/store/src/store.ts:1030-1129`). It reindexes and records a `corrected` session link.

Arguments:

- `<target>` (required): "The memory being corrected."

Flags:

- `--title` (string, required): "The new memory's title."
- `--claim` (string): "The corrected claim. Exactly one of --claim or --article-html."
- `--body` (string, repeatable): "A prose paragraph. Repeatable."
- `--article-html` (string): "Raw `<article>` markup for the superseding memory, used verbatim in place of --claim/--body. Must contain exactly one `<mark>` in the first `<p>` or `<li>`; the first `<time datetime>` becomes the memory's event time. The store refuses format violations before any commit. Exactly one of --claim or --article-html."
- `--type` (string, one of `episodic`, `semantic`, `procedural`, `agent_insight`, `user_preference`, `error_pattern`, `verdict`, `precedent`, `arc`, `task`): "The new memory's type. Defaults to the target's, so correcting an arc keeps it one."
- `--reason` (string): "Why the correction was made."
- `--session-id` (string): "Records a `corrected` session link."
- `--prompt-id` (string): "The prompt within that session."
- `--turn-uuid` (string): "The turn within that session."

Response: `memory.corrected`.

A caller reads `path`, `archivedPath`, `commitSha`, and `contentHash` (`CorrectResult` at `packages/store/src/store.ts:159-166`).

The correction inherits the type and nothing else. The operation passes no workspace, tags, entities, importance, confidence, task status, due date, or links, so placement comes from the type and the new title (`apps/cli/src/operations.ts:1264-1277`). A correction of a `projects/<ws>/` memory can land in `areas/inbox/`.

`--reason` is accepted and recorded nowhere. The store never reads it, and the commit subject is built from the title.

There is no dedupe on this path. A correction whose article matches another active memory, tasks aside, commits, and every later reindex fails until one copy is archived; see [What a failed write leaves behind](#what-a-failed-write-leaves-behind).

Errors:

- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at `<target>`.
- `ERR_INVALID_MEMORY` (exit 1) when the target does not parse, the render gate refuses the new article, or the valid-from stamp does not parse (`renderChecked` at `packages/store/src/store.ts:1047`).
- `ERR_GIT` (exit 1) when `git mv` finds the archive path taken, which happens when a file at the same path was archived earlier the same year. The journal restores the tree.
- `ERR_STORAGE` or `ERR_GIT` (exit 1) during the write, and the three `reindex` codes after the commit.

Failure: everything before the journal leaves the tree byte-identical. A failure under the journal restores the target and removes the new file; an empty archive year directory can remain. The `state.access` row already moved to the archive path is not restored (`hooks.onMove` in `stageArchive` at `packages/store/src/store.ts:596`). A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit, puts the target back at its old path, and removes the archive copy and the new file from the worktree. After the commit, a retry fails with `ERR_PATH_NOT_FOUND` because the target moved, so it cannot duplicate.

## link

```
memhtml link <src> <rel> <dst>
```

Adds an authored `<link>` to the source file and commits it (`linkMemories` at `apps/cli/src/operations.ts:1293-1303`). The rel is decoded first. The store refuses a self-link, reads both files' types to check the endpoint classes, adds the link, and commits only if the file changed (`linkMemories` at `packages/store/src/store.ts:1308-1343`). It reindexes only after a commit.

Arguments:

- `<src>` (required): "The asserting memory or task."
- `<rel>` (required): "One of: supersedes, contradicts, caused_by, leads_to, part_of, relates_to, example_of, supports, laterally_related, blocks, subtask_of. A task rel needs two tasks; a memory rel refuses a task endpoint."
- `<dst>` (required): "The memory or task being pointed at."

Response: `memory.linked`.

A caller reads `commitSha`, `srcPath`, `dstPath`, and `rel` (`apps/cli/src/operations.ts:1302`). A null `commitSha` means the same rel and href were already present, or the source had no head to insert into (`addLink` at `packages/html/src/editors.ts:217-229`, `packages/store/src/store.ts:1328`).

The rel vocabulary is `AUTHORABLE_RELS`: the nine `MEMORY_RELS` plus the two `TASK_RELS`, `blocks` and `subtask_of` (`apps/cli/src/operations.ts:124`, `TASK_RELS` at `packages/contracts/src/edges.ts:54`). A task rel needs two tasks, and a memory rel refuses a task endpoint.

The idempotence is an exact match on rel and href, where href is `/` plus the normalized `<dst>` (`packages/html/src/editors.ts:222-226`). Normalizing strips leading and doubled slashes only, so `<dst>` spelled with a `./` segment is a different href: it adds a second link, and the source then fails the format check.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a rel outside the vocabulary, a self-link, or an endpoint class mismatch (`decodeAuthorableRel` at `apps/cli/src/operations.ts:140-147`).
- `ERR_PATH_NOT_FOUND` (exit 1) when either endpoint has no file.
- `ERR_STORAGE` or `ERR_GIT` (exit 1) during the write, and the three `reindex` codes after the commit.

Failure: a refused link writes nothing. A failure under the journal restores the source's bytes. A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit and puts the pre-link bytes back in the worktree. After a commit followed by a failed `reindex`, a retry finds the link present, returns a null `commitSha`, and skips `reindex`, so the index stays without the edge until the next `index update`.

## neighbors

```
memhtml neighbors <path> [--depth 1] [--limit 200] [--rel <rel>]...
```

Returns the memory graph around one path, one or two hops out, from one SQL statement over `edges` of class `memory` (`neighborsQuery` at `apps/cli/src/operations.ts:1404-1453`). Rows fold to one node per path at its nearest hop (`neighborsOf` at `apps/cli/src/operations.ts:1484-1578`).

Arguments:

- `<path>` (required): "The center of the neighborhood."

Flags:

- `--depth` (int, default `1`): "1 or 2. Never more."
- `--limit` (int, default `200`): "Distinct nodes to return, clamped to 200. `nodesDropped` counts the paths the walk reached and this limit turned away, and `scanSaturated` says the walk stopped at its own 10000-row cap, which no limit recovers."
- `--rel` (string, repeatable, one of `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related`): "Restrict to these rels. Repeatable."

Response: `memory.neighbors`.

A caller reads `center`, `depth`, `limit`, `nodes` (each with `path`, `title`, `hop`, `rel`, and `derived`), `edges`, `nodesDropped`, and `scanSaturated` (`apps/cli/src/operations.ts:1555-1577`). `depth` and `limit` echo the clamped values. `nodesDropped` counts the paths the walk reached and the limit turned away. `scanSaturated` is true when the statement hit its own 10000-row cap, which no limit recovers.

`--depth` is clamped to 1 or 2 rather than refused, and `--limit` is clamped to 1 through `NEIGHBORS_LIMIT`, 200 (`apps/cli/src/operations.ts:1360`, `apps/cli/src/operations.ts:1488-1492`). Archived nodes are included.

Errors:

- `ERR_STORAGE` (exit 1). A center with no file is not an error: the answer has no nodes.

Failure: `neighbors` writes nothing, and its one statement is one consistent read.

## resolve

```
memhtml resolve <path>
```

Follows a possibly moved path forward to the memory that holds the fact now (`resolveMemory` at `apps/cli/src/operations.ts:1733-1798`). At each hop, a path with no `files` row follows the newest archive row whose `origin_path` matches it, and a live path follows the newest authored `supersedes` edge pointing at it (`resolveQueries` at `apps/cli/src/operations.ts:1686-1695`). The walk stops after `RESOLVE_MAX_HOPS`, 16 hops (`apps/cli/src/operations.ts:1588`).

Arguments:

- `<path>` (required): "The path a receipt, citation, or older answer recorded."

Response: `memory.resolved`.

A caller reads `requested`, `path`, `hops`, `steps` (each `from`, `to`, and `via`), `stopReason`, `title`, and `indexedCommit` (`apps/cli/src/operations.ts:1789-1797`). `stopReason` is one of `live`, `archived`, `unindexed`, `cycle`, and `hop_limit`, and only `live` means `path` is citable (`RESOLVE_STOP_REASONS` at `apps/cli/src/operations.ts:1613`). `via` is `supersedes` or `archive_move`.

The answer describes `indexedCommit`, not HEAD. `unindexed` can mean the path never existed, or that the index has not seen the commit holding it. `hops: 0` with `live` does not mean the bytes are unchanged, because `link` and the sleep phases edit a file in place (`stampFile` at `packages/sleep/src/edits.ts:131-144`). A CLI correction always lands at a new path. `correct` passes no path, so the target is still on disk when the slug is chosen, and one that keeps its title and placement takes the next `-N` suffix, such as `-2` (`freePathFor` at `packages/store/src/store.ts:417-466`).

Errors:

- `ERR_STORAGE` (exit 1). An unknown path is `stopReason: "unindexed"` at exit 0.

Failure: `resolve` writes nothing. It reads the watermark and then one or two statements per hop, with no snapshot across them.

## archive

```
memhtml archive <path> --reason <reason>
```

Soft-evicts a memory (`archiveMemory` at `apps/cli/src/operations.ts:1306-1314`). The store reads the file, then under a journal moves it with `git mv` into `archive/<YYYY>/<path>`, writes the archive stamps, stages it, mirrors the access row, and commits (`archiveMemory` at `packages/store/src/store.ts:1131-1157`). It reindexes after the commit.

Arguments:

- `<path>` (required): "The memory to archive."

Flags:

- `--reason` (string, required): "Why it was evicted."

Response: `memory.archived`.

A caller reads `path`, `archivePath`, and `commitSha` (`ArchiveResult` at `packages/store/src/store.ts:169-173`).

`--reason` appears only in the commit subject, `memhtml(archive): <path> — <reason>` (`packages/store/src/store.ts:1151`). The `<path> — <reason>` part is cut to 72 characters, so a long path can leave no trace of the reason (`commitSubject` at `packages/store/src/plumbing.ts:393-397`). It is not stamped into the file. The file is not parsed, so an archived path archives again into a nested `archive/<YYYY>/archive/<YYYY>/`.

Errors:

- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at the path.
- `ERR_GIT` (exit 1) when the archive path is taken by an earlier eviction of the same path in the same year. The journal restores the tree.
- `ERR_STORAGE` or `ERR_GIT` (exit 1) during the move or commit, and the three `reindex` codes after the commit.

Failure: a refusal writes nothing. A failure under the journal puts the file back, but the `state.access` row already moved to the archive path is not restored (`makeJournal` at `packages/store/src/store.ts:1140-1154`, `hooks.onMove` at `packages/store/src/store.ts:596`). A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit, puts the file back at its old path, and removes the archive copy from the worktree. A failure to mirror the access row is logged only. After the commit, a retry fails with `ERR_PATH_NOT_FOUND`.

## reinforce

```
memhtml reinforce <path> [<path>...] [--signal neutral]
```

Bumps access bookkeeping in `state.db` for each distinct path (`reinforceMemories` at `apps/cli/src/operations.ts:1317-1327`). One upsert per 500 paths carries the cooldown in its `WHERE` clause, and `RETURNING` reports which paths were bumped (`packages/index/src/reinforce.ts:69-120`). No file is touched and nothing is committed.

Arguments:

- `<path>` (required, repeatable): "A memory path. Repeat the argument for more."

Flags:

- `--signal` (string, default `"neutral"`, one of `positive`, `negative`, `neutral`): "`neutral` bumps access without claiming the memory was right."

Response: `memory.reinforced`.

A caller reads `bumped`, `cooledDown`, and `signal` (`apps/cli/src/operations.ts:1323-1326`). The signal vocabulary is `REINFORCE_SIGNALS` (`packages/domain/src/reinforce.ts:31`).

The cooldown is 900 seconds per path, `REINFORCE_COOLDOWN_S` (`packages/domain/src/ranking.ts:17`). It is enforced inside the SQL statement, so it holds across processes. `read` bumps the same row, so a `read` followed within the cooldown by `reinforce --signal positive` drops the signal. Paths are neither checked against the tree nor normalized, so a path with no file gets its own row.

Errors:

- `ERR_STORAGE` (exit 1) from the upsert.

Failure: each 500-path slice is its own statement, so a failure in a later slice keeps the earlier slices applied. A retry inside the cooldown reports those paths in `cooledDown`.

## list

```
memhtml list [--type <type>] [--para <bucket>] [--limit 50] [--cursor <path>]
```

Pages through `files` with one `SELECT`, keyset-paginated on `path` (`listMemories` at `apps/cli/src/operations.ts:1825-1920`).

Flags:

- `--type` (string, one of `episodic`, `semantic`, `procedural`, `agent_insight`, `user_preference`, `error_pattern`, `verdict`, `precedent`, `arc`, `task`): "One memory type. `arc` pages the authored and synthesized arcs alike."
- `--workspace` (string): "One workspace."
- `--tag` (string): "One tag."
- `--entity` (string): "One `type:name` entity reference."
- `--facet` (string, repeatable): "Restrict to memories carrying a `<dl>` facet, as name=value; the value may contain `=`, the name may not. Repeatable, and the composition is fixed: values under the SAME name broaden (--facet doc-type=runbook --facet doc-type=guide is either), DIFFERENT names narrow (--facet doc-type=runbook --facet tier=1 is both). This is the extension axis: memhtml's element and meta vocabularies are closed, so a consumer's own document kinds, states, and tiers live in `<dt>`/`<dd>` pairs and are queried here. The match is on the facet's TEXT with no case folding, so write the halves you mean to query. The stored form is the element's text content, which the parser collapses whitespace runs in and trims — so `<dd>runbook  rollback</dd>` is stored and queried single-spaced. There is no numeric comparison: a `<data value>` is indexed UNITLESS because the unit lives in the prose beside it, so the caller owns the unit and matches the text it wrote."
- `--para` (string, one of `projects`, `areas`, `resources`, `archive`): "One PARA bucket."
- `--limit` (int, default `50`): "Rows per page."
- `--cursor` (string): "The `next_cursor` from the previous page: the last path returned."
- `--include-archived` (boolean, default `false`): "Include archived memories."

Response: `memory.list`.

A caller reads `files`, each with `path`, `title`, `memoryType`, `gist`, `workspace`, `para`, `confidence`, `importance`, `archived`, and `updatedAt`, and `nextCursor` (`apps/cli/src/operations.ts:1905-1919`). The field is `nextCursor`, although the flag description says `next_cursor`. A null `nextCursor` means the last page.

`--limit` is clamped to 1 through 500 without saying so (`listMemories` at `apps/cli/src/operations.ts:1828`). A `--cursor` that is no real path is applied as a bound, not refused. Tasks are listed by default. `--para archive` returns nothing without `--include-archived`, because an archived memory is one whose bucket is `archive`. `--tag`, `--entity`, and `--workspace` keep the last occurrence; only `--facet` composes.

Errors:

- `ERR_STORAGE` (exit 1).

Failure: `list` writes nothing. Each page is one statement, so its `nextCursor` agrees with its rows. Across pages, a row never repeats, but a row that moves behind the cursor is skipped.

## entity activity

```
memhtml entity activity [--type <entity-type>] [--limit 50] [--include-archived]
```

Every stored entity reference with its file count and last activity, newest first, from one `GROUP BY` over `file_entities` joined to `files` (`entityActivityQuery` at `apps/cli/src/operations.ts:2008-2050`, `entityActivity` at `apps/cli/src/operations.ts:2091-2122`).

Flags:

- `--type` (string): "Restrict to one entity type, e.g. `service`. The half before the colon in a `type:name` reference."
- `--limit` (int, default `50`): "Rows to return, 1 to 500. An ask outside that is clamped into it rather than refused, and `limit` echoes the bound the answer was built under. `entityCount` is the total matching the scope, so a clamped answer is visible."
- `--include-archived` (boolean, default `false`): "Aggregate archived memories too. Excluded by default: eviction is a `git mv`, so an archived memory still exists and would otherwise keep an entity looking active."

Response: `entity.activity`.

A caller reads `entities`, `entityCount`, and `limit`. Each row has `entity`, `entityType`, `entityName`, `fileCount`, `lastActivityAt`, `lastEventAt`, and `lastWrittenAt`. `lastActivityAt` is `max(coalesce(event_at, updated_at))`, the recency arm's rule. `lastEventAt` is `max(event_at)` and can be null. `lastWrittenAt` is `max(updated_at)`. `entityCount` counts every match before the limit, so a clamped answer shows.

The limit is clamped to 1 through `ENTITY_ACTIVITY_MAX`, 500 (`apps/cli/src/operations.ts:1937`). There is no cursor, so a corpus with more than 500 entities cannot be fully listed here. A row is one stored spelling: `Checkout-API` and `checkout-api` are two rows. Tasks are counted.

Errors:

- `ERR_STORAGE` (exit 1).

Failure: `entity activity` writes nothing, and its one statement is one consistent read. It does not read `state.db`.

## task add

```
memhtml task add --title <title> [--status todo] [--due <iso>]
```

Opens a task. The dispatch arm calls `writeMemory` with type `task` and the claim defaulting to the title, so the store path is the one `write` takes (`apps/cli/src/run.ts:523-555`). The status and due date are decoded only for tasks (`apps/cli/src/operations.ts:296-303`).

Flags:

- `--title` (string, required): "What the task is. Becomes the `<title>` and the filename slug."
- `--claim` (string): "The task statement, as the `<mark>` span. Defaults to --title."
- `--body` (string, repeatable): "A prose paragraph of working notes. Repeatable, one `<p>` each."
- `--status` (string, default `"todo"`, one of `todo`, `doing`, `blocked`, `done`): "The opening status. `todo` unless you are recording work already underway."
- `--due` (string): "An ISO date or datetime deadline. Compared as a string, so the form matters."
- `--workspace` (string): "Routes the task to `projects/<slug>/tasks/`."
- `--tag` (string, repeatable): "A tag. Repeatable; tags scope search but never route a task."
- `--entity` (string, repeatable): "A `type:name` entity reference. Repeatable."
- `--session-id` (string): "The Claude Code session that opened the task."
- `--prompt-id` (string): "The prompt within that session."
- `--turn-uuid` (string): "The turn within that session."

Response: `task.written`.

A caller reads `path`, `created`, `deduped`, `existingPath`, `taskStatus`, `dueAt`, and `commitSha` (`apps/cli/src/run.ts:539-553`). `taskStatus` and `dueAt` echo the flags; they are not read back from the file.

Two tasks are never deduped against each other, so every retry opens a new `-N` file. The single-write path still asks the dedupe question, though, and the lookup excludes stored tasks and archived memories: a task whose article matches an active non-task memory returns that memory's path with `deduped: true`, and no task is written (`activePathForHash` at `packages/index/src/traces-persist.ts:196-203`). `--status done` opens a task that is not archived, and `task status <path> done` then reports `unchanged: true` and archives nothing, because the `unchanged` return comes first (`apps/cli/src/operations.ts:2194-2202`). Use `memhtml archive` to close it.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a `--due` outside `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ssZ`, or a render-gate refusal (`decodeDueAt` at `apps/cli/src/operations.ts:167-174`).
- The write and `reindex` codes of `write`, except `ERR_WRITE_CONFLICT`: there is no `--path`.

Failure: as `write`.

## task status

```
memhtml task status <path> <status> [--reason <reason>]
```

Moves a task's status (`setTaskStatus` at `apps/cli/src/operations.ts:2171-2246`). It decodes the status, parses the file, refuses a non-task, and returns early when the status is unchanged. Otherwise it stamps the head metas and writes the file. For `todo`, `doing`, and `blocked` it then stages, commits, and reindexes. For `done` it archives the task through `archiveMemory` with the reason `--reason` or `task done`, then reindexes.

Arguments:

- `<path>` (required): "The task file."
- `<status>` (required): "One of: todo, doing, blocked, done."

Flags:

- `--reason` (string): "Why it closed. Recorded on the archive commit when the status is `done`."

Response: `task.updated`.

A caller reads `path`, `taskStatus`, `archived`, `archivePath`, `commitSha`, and `unchanged` (`TaskStatusResult` at `apps/cli/src/operations.ts:2141-2151`). `--reason` is used only for `done`, and only in the archive commit subject, where the `<path> — <reason>` part is cut to 72 characters. A long path can leave no trace of the reason (`commitSubject` at `packages/store/src/plumbing.ts:393-397`).

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a status outside `TASK_STATUSES`, a file that is not a task, or a file that does not parse (`decodeTaskStatus` at `apps/cli/src/operations.ts:150-157`).
- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at the path.
- `ERR_STORAGE` (exit 1) as `task.write:<path>`, and `ERR_GIT` (exit 1) from `add`, `commit`, or the archive move.
- The three `reindex` codes after the commit.

Failure: the stamp write is not journaled and does not take the per-process permit (`apps/cli/src/operations.ts:2209-2217`). For a status other than `done`, a failed stage or commit leaves the file modified and possibly staged, and that dirty tree stops `sleep run`. For `done`, the archive journal records the already-stamped bytes, so a failed archive leaves the stamped file in place, and the `state.access` row already moved to the archive path is not restored. A retry after a landed commit reports `unchanged: true` for a non-`done` status and `ERR_PATH_NOT_FOUND` for `done`.

## task list

```
memhtml task list [--status <status>] [--workspace <ws>] [--due-before <iso>] [--detected] [--limit 50] [--cursor <path>]
```

The task working set from one `SELECT` over `files` where the type is `task`, with a correlated `blockedBy` subquery over task `blocks` edges, keyset-paginated on `path` (`listTasks` at `apps/cli/src/operations.ts:2335-2424`). It never runs ranked retrieval.

Flags:

- `--status` (string, one of `todo`, `doing`, `blocked`, `done`): "One task status."
- `--workspace` (string): "One workspace."
- `--due-before` (string): "An ISO date. Returns tasks due strictly before it, by calendar day."
- `--limit` (int, default `50`): "Rows per page."
- `--cursor` (string): "The `next_cursor` from the previous page: the last path returned."
- `--include-archived` (boolean, default `false`): "Include finished tasks. `done` archives, so they are otherwise absent."
- `--detected` (boolean, default `false`): "Only tasks the sleep cycle detected, never ones opened by hand. The machine's queue: each is a proposal carrying the evidence it was detected from."

Response: `task.list`.

A caller reads `tasks`, each with `path`, `title`, `taskStatus`, `dueAt`, `workspace`, `archived`, `updatedAt`, and `blockedBy`, and `nextCursor`.

`--due-before` compares the first ten characters, so it is strictly before by calendar day, and it drops tasks with no due date. `--detected` matches the file name pattern the sleep cycle's detector writes (`apps/cli/src/operations.ts:2296`). `--limit` is clamped to 1 through 500 silently. A bogus `--cursor` behaves as on `list`.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a `--due-before` outside the two datetime forms, raised after the layer is built (`decodeDueAt` at `apps/cli/src/operations.ts:2353`).
- `ERR_STORAGE` (exit 1).

Failure: `task list` writes nothing. Pagination behaves as on `list`.

## index rebuild

```
memhtml index rebuild [--no-embed] [--force]
```

Rebuilds `index.db` from the git tree at HEAD (`rebuild` at `packages/index/src/indexer.ts:674-697`, which calls `reproject` at `packages/index/src/indexer.ts:618-672`). It reads HEAD, lists the PARA buckets, and reads every blob before it truncates anything. Then it reprojects, restores the stashed vectors, writes the watermark, and, with `--embed`, fills every chunk that has no vector.

Flags:

- `--embed` (boolean, default `true`): "Fill missing vectors from Bedrock. --no-embed makes the rebuild instant and leaves new or changed chunks without a vector; the vectors already stored survive either way when the model is unchanged. With MEMHTML_EMBED=off, --embed is held to the same rules as --no-embed."
- `--force` (boolean, default `false`): "Run a rebuild that cannot write vectors (--no-embed, or --embed with MEMHTML_EMBED=off) over a store that already carries them. Without it that call is refused with ERR_REBUILD_NO_EMBED_REFUSED, because a store with vectors was embedded on purpose. Accepted and inert when the rebuild can embed."

Response: `index.report`.

A caller reads `mode: "rebuild"`, `headSha`, `filesIndexed`, `chunksIndexed`, `edgesIndexed`, `embeddingsWritten`, `embeddingsPreserved`, and `skipped` (`indexer.rebuild` at `apps/cli/src/run.ts:581-589`, `packages/index/src/indexer.ts:663-671`). `embeddingsPreserved` counts the stored vectors whose chunk came back with the same id.

A rebuild keeps its vectors only in the configured space. `truncateForRebuild` stashes the `embeddings` rows of that space in a temporary table and deletes the memory tables in one transaction (`packages/index/src/indexer.ts:398-416`). After the projections land it re-inserts every stashed row whose chunk id exists again (`packages/index/src/indexer.ts:426-437`). On a model change the stash is empty and every old vector is gone. Sleep-derived edges live only in the index, so a rebuild drops them until the next sleep run.

Errors:

- `ERR_REBUILD_NO_EMBED_REFUSED` (exit 1) when the rebuild cannot write vectors, because of `--no-embed` or because no embedder is bound, over a store that has any stored vector, without `--force` (`packages/index/src/indexer.ts:689-695`). Under `MEMHTML_EMBED=off` a bare `index rebuild` is refused this way over a store that has vectors; over one with none it runs (`refuseNoEmbedOverVectors` at `packages/index/src/indexer.ts:354-366`). A WARN on stderr carries the count (`RebuildNoEmbedRefused` at `packages/index/src/indexer.ts:199-213`).
- `ERR_EMBED_MODEL_MISMATCH` (exit 1) when the rebuild cannot embed and the stored model differs from the configured one. `--force` does not bypass it, because `guardEmbedModel` runs first (`packages/index/src/indexer.ts:691`). With an embedder bound, `index rebuild --embed` is the migration path and has no such guard.
- `ERR_STORAGE` (exit 1) from a database error or any git error, including an unborn HEAD. The indexer reaches git through a port that maps every git failure to `StorageFailure` (`apps/cli/src/api-layer.ts:170-171`).

An embedding failure never fails the rebuild: `embedMissing` logs the failed `embeddings.embed` call and returns the count written so far (`packages/index/src/indexer.ts:573-585`).

Failure: a git failure happens before the truncate and leaves the old index whole. After the truncate the projections are written in batches of 500, each its own transaction, and the watermark is written last. A process that dies in between leaves `head_sha` null over partly filled tables, which `index update` reports as `ERR_INDEX_STALE`. The stash is in SQLite's temporary schema and dies with the process, so an interrupted rebuild loses the vectors it meant to keep, and the recovery rebuild has to embed them again.

The atomic part is the truncate, one transaction. Nothing locks a rebuild against another process: a concurrent `index update`, or a write's `reindex` after its commit, sees the null watermark and fails with `ERR_INDEX_STALE`, and a `search` during the window reads the partial tables.

## index embed

```
memhtml index embed [--dry-run]
```

Fills every chunk that has no vector in the configured space, without a rebuild (`backfill` at `packages/index/src/indexer.ts:708-726`). It checks the model, runs `embedMissing` over the whole table in persisted slices, and counts. It writes only to `embeddings`.

Flags:

- `--dry-run` (boolean, default `false`): "Report the gap (embeddingsRemaining) and write nothing."

Response: `index.report`.

A caller reads `mode: "embed"`, `headSha` (the watermark, or null), `chunks`, `embeddings` (rows in every space), `embeddingsWritten`, and `embeddingsRemaining`, the chunks still without a vector in the configured space (`indexer.backfill` at `apps/cli/src/run.ts:591-596`). With `MEMHTML_EMBED=off` it writes nothing and reports the gap.

This is the recovery from a sparse vector plane. `index update --embed` embeds only the chunks its own pass projected, so a chunk whose embedding failed is not revisited unless an update projects the same text again, as it does for a still-dirty file or a store with no watermark row (`embedMissing` at `packages/index/src/indexer.ts:1002`). `index embed` is the store-wide fill.

Errors:

- `ERR_EMBED_MODEL_MISMATCH` (exit 1) when the stored model differs from the configured one, also with `--dry-run` (`guardEmbedModel` at `packages/index/src/indexer.ts:710`).
- `ERR_STORAGE` (exit 1).

Failure: each slice is embedded and then written in 500-row transactions, so an interruption keeps every committed batch and a rerun sees only the remainder. `--dry-run` writes no row. It works during the stale-index window, with `headSha: null`.

## index update

```
memhtml index update [--no-embed]
```

Indexes what moved since the recorded watermark, plus the working tree (`update` at `packages/index/src/indexer.ts:808-1019`). It checks the model, diffs the watermark against HEAD, reads `git status` under the repository's untracked-files setting, projects the committed changes and then the working-tree ones, writes the watermark, and embeds the chunks this pass projected. With no watermark row at all it reprojects everything. The status call is a plain `git status --porcelain=v2 -z` (`statusPorcelainV2` at `packages/store/src/git.ts:380-383`). A file inside a new untracked directory shows only as that directory and is not seen, and `status.showUntrackedFiles=no` hides every untracked file.

Flags:

- `--embed` (boolean, default `true`): "Fill missing vectors."

Response: `index.report`.

A caller reads `mode: "update"`, `headSha`, `unchanged`, `added`, `modified`, `removed`, `renamed`, `dirty`, `embeddingsWritten`, and `skipped` (`indexer.update` at `apps/cli/src/run.ts:598-603`, `packages/index/src/indexer.ts:1008-1018`). Any dirty indexable path makes `unchanged` false.

Every write path reindexes through this pass. `reindex` calls `update` rather than naming the paths it wrote, because a `git mv` is one rename in the diff and only the diff can express an archive as a move (`reindex` at `apps/cli/src/operations.ts:248-271`).

The working-tree half is one-way. An edit that is indexed and then reverted with `git checkout` leaves the edited text in the index, and an untracked file indexed and then deleted keeps its row. A rebuild clears both.

Errors:

- `ERR_INDEX_STALE` (exit 1) when the watermark row has a null `head_sha`, the trace of an unfinished rebuild (`packages/index/src/indexer.ts:842-846`). `index update` raises it, and so does every write command's `reindex`, after its commit has landed (`reindex` at `apps/cli/src/operations.ts:267-271`). The suggestion is `memhtml index rebuild` (`IndexStale` in `SUGGESTIONS` at `apps/cli/src/errors.ts:180`).
- `ERR_EMBED_MODEL_MISMATCH` (exit 1) when the stored model differs from the configured one (`guardEmbedModel` at `packages/index/src/indexer.ts:810`).
- `ERR_STORAGE` (exit 1) from a database or git error, such as a watermark commit that is gone from history. A working-tree file that git cannot hash or read is not an error: it is listed in `skipped` as `path is unreadable` (`projectFromTree` at `packages/index/src/indexer.ts:981-985`).

`--no-embed` over a store with vectors is allowed; only `rebuild` has the interlock.

Failure: projection writes go in transactions of 500 statements, and the watermark is written after them (`applyProjectionWrites` and `writeState` at `packages/index/src/indexer.ts:994-995`, `WRITE_BATCH_SIZE` at `packages/index/src/schema-const.ts:87`). An interrupted update leaves its committed batches in place under the old watermark, with no stale marker, until the next update or write re-applies them. The watermark advances before embedding. An embedding failure still advances it. A later update fills those chunks only if it projects them again; `index embed` and `index rebuild --embed` fill them store-wide.

## index status

```
memhtml index status
```

Reads the index watermark and row counts, with no git call (`indexReport` at `apps/cli/src/views.ts:22-73`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:799-805`).

Response: `index.report`.

A caller reads `mode: "status"`, `headSha` (the watermark, not git HEAD), `embedModel`, `embedDim`, `embedModelMatches`, `configuredEmbedModel`, `rebuiltAt`, `updatedAt`, `files`, `activeFiles`, `chunks`, `embeddings` (every space), `vectorCoverage` (the configured space), `vectorCoverageFloor`, `edges`, `derivedEdges`, `tags`, `entities`, `traces`, and `hasState` (`apps/cli/src/views.ts:38-72`). It has no freshness flag; `status` and `doctor` compare the watermark to HEAD.

Errors: none at runtime. Every read falls back to zero or null, so a broken database reads as an empty one (`apps/cli/src/views.ts:33-36`).

Failure: `index status` writes nothing beyond the layer build's side effect. A never-indexed store reports `embedModelMatches: false`, and the stale-index window reports `headSha: null` over existing rows.

## trace index

```
memhtml trace index
```

Scans `$MEMHTML_TRACE_ROOT` for Claude Code transcripts (`indexTraces` at `apps/cli/src/operations.ts:2462-2505`). It finds `projects/<slug>/<id>.jsonl` files and their subagent sidecars, decides per file to skip, tail, or rescan from the stored watermarks, parses everything, and then persists file by file (`scanTraceRoot` at `packages/traces/src/scan.ts:88-163`). The trace root is only read.

This command takes no arguments and no flags (`apps/cli/src/commands.ts:806-812`).

Response: `trace.report`.

A caller reads `traceRoot`, `filesSeen`, `skipped`, `tailed`, `rescanned`, `filesFailed`, `bytesRead`, `sessionsWritten`, `promptsWritten`, and `tailsMerged` (`apps/cli/src/operations.ts:2491-2504`). `skipped + tailed + rescanned + filesFailed` equals `filesSeen` (`packages/traces/src/scan.ts:49-53`). `sessionsWritten` counts files that wrote a row, sidecars included.

Errors:

- `ERR_STORAGE` (exit 1) for a trace directory that cannot be listed, or a database error. A missing trace root succeeds with zeros, and an unreadable file counts in `filesFailed` and keeps its watermark (`readFailed` at `packages/traces/src/scan.ts:126-143`).

Failure: nothing is written until the scan finishes. Each file's row, prompts, and watermark then commit in one transaction, so an interruption keeps the files already persisted. Two concurrent runs are not locked against each other. Trace tables survive `index rebuild`.

## trace search

```
memhtml trace search <query> [--cwd <dir>] [--since <iso>] [--limit 20]
```

Full-text search over session first prompts and AI titles in `traces_fts`, all-terms first and then any-terms (`searchTraces` at `apps/cli/src/operations.ts:2531-2592`). A query with no indexable term lists sessions by `started_at`, newest first. It never enters memory retrieval.

Arguments:

- `<query>` (required): "Prose. A double-quoted span demands those words in that order; nothing else is syntax."

Flags:

- `--cwd` (string): "Restrict to sessions from this directory."
- `--since` (string): "ISO-8601 lower bound on started_at."
- `--limit` (int, default `20`): "Sessions to return."

Response: `trace.sessions`.

A caller reads `sessions`, each with `sessionId`, `slug`, `cwd`, `startedAt`, `promptCount`, `firstPrompt`, and `aiTitle`, and `degraded` (`apps/cli/src/operations.ts:2577-2591`). Here `degraded` means the query had no indexable terms and the answer is a recency listing, which is not what it means on `search`.

`--since` is compared as a string and not validated, so a malformed value returns nothing at exit 0. `--cwd` must match exactly. `--limit` is clamped to 1 through 200 silently (`apps/cli/src/operations.ts:2535`).

Errors:

- `ERR_STORAGE` (exit 1). The trace tables are empty until `trace index` has run.

Failure: `trace search` writes nothing.

## trace links

```
memhtml trace links [--session-id <id>] [--path <path>]
```

Reads the memory-session links from either side, newest first, capped at 500 rows (`traceLinks` at `apps/cli/src/operations.ts:2607-2658`). Both flags together narrow to their intersection.

Flags:

- `--session-id` (string): "Every memory this session touched."
- `--path` (string): "Every session that touched this memory."

Response: `trace.links`.

A caller reads `links`, each with `path`, `sessionId`, `promptId`, `turnUuid`, `linkKind`, and `at` (`apps/cli/src/operations.ts:2645-2654`). `linkKind` is `wrote`, `read`, `corrected`, or `reinforced`. The 500-row cap has no truncation marker.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) when neither flag has a value. It is raised after the layer is built, so it is a runtime code for what is a call-shape mistake (`InvalidMemory` at `apps/cli/src/operations.ts:2612-2618`).
- `ERR_STORAGE` (exit 1).

Failure: `trace links` writes nothing.

## sleep run

```
memhtml sleep run [--date YYYY-MM-DD] [--phases <list>] [--dry-run] [--deep] [--max-llm-calls <n>] [--trace-sessions <n>]
```

The curation cycle (`run` at `packages/sleep/src/run.ts:132-261`). It picks the run id `sleep/<date>`, or the next free suffix up to `-100`, creates that branch, checks it out, and reads HEAD back before any phase runs. Then it runs the selected phases in `SLEEP_PHASES` order and records each phase's result as a row, except on a dry run (`recordOne` at `packages/sleep/src/run.ts:831-839`). Only if a phase failed does it try to return HEAD to the starting branch. `--dry-run` creates no branch and runs on the current HEAD.

Flags:

- `--date` (string): "The run date, `YYYY-MM-DD`. Defaults to today. Names the branch."
- `--phases` (string): "Comma-separated subset. All 17 by default: preflight, dedup-merge, entity-resolution, person-links, relationship-mining, edge-typing, confidence-decay, arc-synthesis, retention-triage, compress, reprieve, trace-consolidation, task-detection, placement-triage, integrity, state-export, report."
- `--dry-run` (boolean, default `false`): "Report per-phase counts and commit nothing."
- `--deep` (boolean, default `false`): "The deep-sleep cycle: mine a lower grouping band, group by shared entity, re-file inbox singletons, and iterate compress until a pass folds nothing. Reaches the inbox tail the default community gate cannot; costs more model calls. Same branch, review, and merge gate as a run without this flag."
- `--max-llm-calls` (int): "Cap on model calls the deep mechanisms may spend, shared across all deep phases. Exhaustion skips remaining batches with reason `budget` and the run stays green. Read only with --deep; absent means uncapped."
- `--trace-sessions` (int): "Sessions handed to trace-consolidation this run. Defaults to 10. The consolidation turn's time budget scales with this count, so a host with large transcripts can trade batch size for turn time."

Response: `sleep.report`.

A caller reads `runId`, `branch`, `baseSha`, `headSha`, `dryRun`, `llmCalls`, `phases`, `failedPhases`, `commits`, and `reaped` (`sleepRunReport` at `apps/cli/src/views.ts:143-159`). Each phase row has `phase`, `status` (`ok`, `failed`, or `skipped`), `counts`, `commitSha`, `llmCalls`, and an optional `detail`. `baseSha` is HEAD when the run started, not `main`. `commits` holds each phase's last commit, except a failed phase's: it reports `commitSha: null` even when it committed earlier (`packages/sleep/src/run.ts:715-722`).

The phases are `SLEEP_PHASES`, 17 in this order: `preflight`, `dedup-merge`, `entity-resolution`, `person-links`, `relationship-mining`, `edge-typing`, `confidence-decay`, `arc-synthesis`, `retention-triage`, `compress`, `reprieve`, `trace-consolidation`, `task-detection`, `placement-triage`, `integrity`, `state-export`, `report` (`packages/sleep/src/contract.ts:43-61`). `--phases` runs its subset in this order, whatever order it was given in (`sleepPhases` at `apps/cli/src/views.ts:90-111`).

`preflight` and `relationship-mining` never commit (`NON_COMMITTING_PHASES` at `packages/sleep/src/contract.ts:241`). The other 15 commit only when they staged something, and `arc-synthesis`, `compress`, and `trace-consolidation` can commit more than once. What a run guarantees per phase is failure isolation, not one commit.

`LLM_PHASES` lists the 8 phases that spend model calls when a model is bound: `dedup-merge`, `entity-resolution`, `edge-typing`, `arc-synthesis`, `compress`, `trace-consolidation`, `task-detection`, `placement-triage` (`packages/sleep/src/contract.ts:169-178`). With `MEMHTML_LLM=off`, `dedup-merge` and `entity-resolution` still run their deterministic passes and can commit; dedup falls back to the `NEAR_DUPLICATE_THRESHOLD` floor (`packages/sleep/src/phases/dedup-merge.ts:291-297`). The other six report `no model bound` (or `no consolidator bound`), write nothing, and stay `ok`. `placement-triage` is deep-only and returns `ok` without work on a run without `--deep`.

`--max-llm-calls` is read only with `--deep`, and only `compress` and `placement-triage` consume it. `--trace-sessions` must be a positive integer after `parseInt`, so `abc` silently means the default of 10 (`traceSessionsFlag` at `apps/cli/src/views.ts:121-133`). `--date` is not validated: a value that is not a date still names the branch, and its writes are stamped with the epoch.

A dirty tree is not an error envelope. `preflight` fails with detail `DirtyTree`, the other 16 phases are `skipped`, and the command exits 1 with the report. The same holds for a stale index, an embed-model mismatch, and vector coverage under the fixed 0.5 floor when the vector plane is in use, meaning a vector is stored or an embedder is bound (`vectorPlaneInUse` at `packages/sleep/src/phases/preflight.ts:60-62`).

`--phases` does not add `preflight` (`selected` at `packages/sleep/src/run.ts:136-139`). A subset without it runs no clean-tree check, no index refresh, and no coverage check. Its phase commits then take whatever is already staged, plus any uncommitted edit in a file a phase rewrites, because a phase reads the working tree and stages the whole file (`stampFile` at `packages/sleep/src/edits.ts:131-144`).

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a `--phases` name outside `SLEEP_PHASES` or a `--trace-sessions` below 1, raised inside dispatch after the layer is built (`sleepPhases` at `apps/cli/src/views.ts:98-105`, `traceSessionsFlag` at `apps/cli/src/views.ts:121-133`).
- Any failed phase: exit 1 with a success `sleep.report` (`sleepExit` at `apps/cli/src/run.ts:318-319`).

The sleep service has no error channel, so a git or index failure arrives as a failed phase, never as `ERR_GIT` or `ERR_DIRTY_TREE`.

Failure: an aborted run, such as one whose branch cannot be created or whose 100 ids are taken, writes no row of its own and no commit. The reaper runs before the branch is created, so an abort after it may already have stamped earlier stuck rows `abandoned` and lists them in `reaped` (`reapStuckRuns` at `packages/sleep/src/run.ts:159`). A failed checkout leaves HEAD where it was, while the read-back abort fires after `checkout -b` succeeded, so that branch exists (`enterRunBranch` at `packages/sleep/src/run.ts:420-443`). A `preflight` failure leaves an empty `sleep/<date>` branch and a `failed` row.

A failed phase, `preflight` included, unstages the whole index and then restores only the paths it dirtied, so the operator's own staged changes come out unstaged. When git status cannot be read, the restore is skipped with a WARN (`discardPhaseWrites` at `packages/sleep/src/run.ts:781-817`). Every commit before the failed phase stays, and later phases still run unless they depend on it. After a failed phase the run tries to return HEAD to the starting branch. From a detached HEAD, or when that checkout fails, HEAD stays on the sleep branch with a WARN (`leaveRunBranch` at `packages/sleep/src/run.ts:481-509`). A successful run leaves HEAD on the sleep branch with the row in `review`.

A run is not isolated from other writers. No lock stops a second `sleep run` in another process on the same root. A CLI write that lands while HEAD is on the sleep branch commits onto that branch, so `sleep merge` lands it and `git branch -D` loses it. Some state written during phases, such as corroboration counts and derived edges, survives discarding the branch.

## sleep resume

```
memhtml sleep resume <run-id>
```

Re-runs the phases with no `Memhtml-Phase` trailer on the run's branch (`resume` at `packages/sleep/src/run.ts:277-410`). It needs the run row for the base commit, checks out the branch, reads the trailers over `base..HEAD`, and reports the trailed phases as `skipped`.

Arguments:

- `<run-id>` (required): "The run id, e.g. sleep/2026-08-02."

Response: `sleep.report`.

The payload has the shape `sleep run` returns, with all 17 phases, `dryRun: false`, and an empty `reaped`.

A phase that finished `ok` without committing has no trailer, so it runs again. A multi-commit phase that failed after its first commit has a trailer, so resume skips it. Resume takes no flags, so it always uses the default `--trace-sessions` and no `--deep`. It does not check the run's status: a merged or abandoned run resumes too.

Errors:

- Exit 1 with a success `sleep.report` when any phase failed, including the case of an unknown run id, where every phase is `failed` with `no such run` (`apps/cli/src/run.ts:655-661`).

Failure: when resume cannot read the row or check out the branch, it writes no row and leaves HEAD where it was (`abortedRun` at `packages/sleep/src/run.ts:300-323`). Otherwise the run row is rewritten as `failed` or `review`. After a failed phase, resume tries to return HEAD to the starting branch, with the same detached-HEAD and failed-checkout exceptions as `sleep run`; on success HEAD stays on the sleep branch.

## sleep review

```
memhtml sleep review <run-id> [--diff]
```

Reports a run without changing it (`review` at `packages/sleep/src/review.ts:55-98`). It returns the phase rows from the database, the commits over `base..branch`, `git diff --stat`, and a per-file classification by content hash.

Arguments:

- `<run-id>` (required): "The run id."

Flags:

- `--diff` (boolean, default `false`): "Include the raw diff."

Response: `sleep.review`.

A caller reads `runId`, `branch`, `baseSha`, `headSha`, `phases`, `commits` (each `sha`, `phase`, and `counts`), `diffStat`, and `files` (each `path`, `classification`, and an optional `fromPath`), plus `diff` with `--diff` (`packages/sleep/src/contract.ts:332-342`). `classification` is `meta-only`, `body-changed`, `archived`, `created`, or `deleted`. A commit that no phase made has `phase: null`.

`headSha` is the current HEAD, not the branch tip, and `--diff` diffs `baseSha..headSha` while `diffStat` and `files` use `base..branch` (`apps/cli/src/run.ts:668-676`). With HEAD on `main`, the two can describe different ranges. The raw diff is fetched only on request because its size is unbounded.

Errors: none at runtime. Every git call falls back to an empty value, and a run id with no row is not an error.

Failure: `sleep review` writes nothing and checks nothing out. It exits 0 even when the run failed: its dispatch arm returns no exit code, unlike `sleep run`'s `sleepExit` (`apps/cli/src/run.ts:663-677`).

## sleep merge

```
memhtml sleep merge <run-id> [--skip-gate]
```

Lands a run on `main` (`merge` at `packages/sleep/src/review.ts:256-389`). It tries to check out `main`, compares what moved on `main` since the base with what the run changed, runs the discrimination gate, and lands the branch: a fast-forward when `main` has not moved, a merge commit when it moved on disjoint paths. Then it applies the run's pending marks, writes the row as `merged`, and runs `index update` with embedding.

Arguments:

- `<run-id>` (required): "The run id."

Flags:

- `--skip-gate` (boolean, default `false`): "Merge without re-running discrimination. A deliberate, logged override, never a default."

Response: `sleep.merge`.

A caller reads `runId`, `branch`, `merged`, `headSha`, and on a refusal `refusal` and sometimes `overlap` (`packages/sleep/src/contract.ts:345-403`). `refusal` is `main-advanced`, `gate-failed`, or `no-run`. A merged run adds `marksPending`, `marksApplied`, `indexUpdated`, and either the index counts (`indexHeadSha`, `indexAdded`, `indexModified`, `indexRemoved`, `indexRenamed`, `embeddingsWritten`, `indexSkipped`) or `indexError`.

The CLI composes the gate: `discriminationGate()` in fake mode, over its own generated corpus (`apps/cli/src/run.ts:704-707`). The gate measures the ranking stack and does not read the run's branch. `--skip-gate` runs no gate and logs a WARN.

Deferred state writes land here. `trace-consolidation`, `edge-typing`, and `entity-resolution` record marks in a committed ledger, `.memhtml/sleep/<run-id with / as ->.pending.jsonl`, and merge reads that ledger from the branch tip and applies it after the branch lands (`packages/sleep/src/review.ts:549-573`). `marksPending` and `marksApplied` differ when an apply fell short.

Errors: no runtime code. Every refusal is a success envelope at exit 0, including `gate-failed`, so a caller has to read `merged` (the `sleep.merge` arm at `apps/cli/src/run.ts:708`).

Failure: merge tries to check out `main` and ignores a failure (`checkoutBranch` at `packages/sleep/src/review.ts:274`). HEAD then stays where it was, which usually yields a false `main-advanced` whose `overlap` is the run's own paths. When that checkout succeeds, every refusal after the row lookup leaves HEAD on `main`. A merge conflict is aborted and reported as `main-advanced`, and so is a fast-forward that failed for another reason, such as a missing branch. A failed mark apply and a failed index update do not fail the merge: `main` has moved, `indexUpdated` is false with `indexError`, and a WARN names the recovery. The row is written `merged` before the index update, and the branch is not deleted. Merge does not read the run's status, so a failed run can be merged.

## sleep status

```
memhtml sleep status
```

Reports the latest run by start time, dry runs included (`apps/cli/src/run.ts:748-763`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:930-936`).

Response: `sleep.report`.

A caller reads `runId`, `branch`, `baseSha`, `headSha` (the current HEAD), `phases`, and `commits`, here a count. This shape shares the `sleep.report` type with `sleep run` but has no `dryRun`, `llmCalls`, `failedPhases`, or `reaped`.

Errors: none at runtime. With no run recorded it answers an empty `runId`, `branch`, and `baseSha`, the current HEAD as `headSha`, no phases, and `commits: 0` at exit 0 (`packages/sleep/src/review.ts:84-87`).

Failure: `sleep status` writes nothing, and exits 0 when the run it reports failed.

## sleep plan

```
memhtml sleep plan
```

Answers whether a run would change anything, from index aggregates, without running a phase (`plan` at `packages/sleep/src/plan.ts:155-317`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:937-945`).

Response: `sleep.plan`.

A caller reads `verdict`, `signals`, `unknown`, `lastRun`, `sessionsPerRun`, `indexedCommit`, and `indexFresh` (`packages/sleep/src/plan.ts:81-110`). `verdict` is `would-change` when any signal count is above zero. It is `no-signal` only when every count is zero, every uncountable input is empty, the state plane is attached, and `indexFresh` is true. Otherwise it is `unknown`. `signals` has `memories_since_last_run`, `unembedded_chunks`, `settled_sessions`, `dangling_authored_edges`, and `pending_entity_merges`. `unknown` has the inputs that cost a scan to count, each with `inputCount` and `unknownReason`.

`sessionsPerRun` is the default batch of 10 and ignores `--trace-sessions`. `unembedded_chunks` counts even when no embedder is bound, so a lexical-only store always reads `would-change`.

Errors: none at runtime. A failed aggregate counts as zero, and a failed watermark read makes the index not fresh, so `no-signal` is then out of reach.

Failure: `sleep plan` writes nothing.

## status

```
memhtml status
```

Corpus health from git and the index (`statusReport` at `apps/cli/src/operations.ts:2676-2753`). It runs `git rev-parse HEAD` and `git status`, counts rows in `index.db`, reads vector coverage and the last sleep run, and writes a WARN to stderr when the index is stale.

This command takes no arguments and no flags (`apps/cli/src/commands.ts:946-952`).

Response: `status.health`.

A caller reads `root`, `headSha`, `dirty`, `dirtyPaths`, `countsByType` (active files, tasks included), `archivedCount`, `edges`, `derivedEdges`, `chunks`, `embeddings` (every space), `traces`, `indexFresh`, `indexHeadSha`, `embedModel`, `embedderUp`, `vectorCoverage`, `vectorCoverageFloor`, `hasState`, and `lastSleep` (`apps/cli/src/operations.ts:2726-2752`). `indexFresh` is the watermark equal to HEAD. `embedderUp` is a watermark check, true when the stored model matches the configured one and a vector exists; it does not call the embedder. `root` echoes `--repo` as given.

Errors:

- `ERR_GIT` (exit 1) when the root is not a git repository.
- `ERR_STORAGE` (exit 1) from a count; only the watermark and last-run reads are guarded.

Failure: `status` writes nothing; `git status` runs with `GIT_OPTIONAL_LOCKS=0` (`packages/store/src/git.ts:168-172`). HEAD and the watermark are read separately, so a write between the two can make one answer describe two moments. A stale index is exit 0 with `indexFresh: false`.

## publish

```
memhtml publish
```

Regenerates the per-directory `index.html` listings and `sitemap.xml` from the `files` rows in `index.db`, writes the ones whose bytes changed, stages every artifact, and commits (`publish` at `apps/cli/src/publish.ts:59-83`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:953-959`).

Response: `publish.report`.

A caller reads `root`, `artifacts`, `written`, `paths` (the rewritten files), and `commitSha`, null when the git index already matched HEAD (`PublishReport` at `apps/cli/src/publish.ts:28-37`).

The listings come from the index, not the tree, and nothing checks freshness, so a stale index is published as it stands. A listing for a directory that has emptied is not deleted.

Errors:

- `ERR_STORAGE` (exit 1) from the database read or `publish.write:<path>`.
- `ERR_GIT` (exit 1) from `add` or `commit`.

Failure: the files are written, then staged, then committed, with no journal. If the commit fails, the artifacts stay staged, and a rerun returns `written: 0` with a real `commitSha`. The commit takes anything else already staged and does not reindex, so `indexFresh` reads false until the next `index update`.

## doctor

```
memhtml doctor [--fix]
```

Builds a health report from the index and the files (`doctor` at `apps/cli/src/doctor.ts:638-770`). With `--fix` it rewrites or drops dangling hrefs, deletes orphan access rows, and commits the touched files (`apps/cli/src/doctor.ts:540-629`).

Flags:

- `--fix` (boolean, default `false`): "Repair dangling hrefs and prune orphan access rows. The other findings need a decision."

Response: `doctor.report`.

A caller reads `healthy` first. The findings are `dangling`, `orphanAccessRows`, `inboxDepth`, `inboxCrowded`, `inboxTaskDepth`, `inboxTasksCrowded`, `overdueTasks`, `staleBlockers`, `untypedEntities`, `untypedEntityTotal`, `stuckSleepRuns`, `warnings`, `unparseable`, and `dirty`. The index fields are `indexFresh`, `indexHeadSha`, `headSha`, `embedModelMatches`, `storedEmbedModel`, `configuredEmbedModel`, `vectorCoverage`, `vectorCoverageFloor`, `vectorCoverageLow`, `chunks`, `embeddings`, and `vectorCoverageRemedy` (`apps/cli/src/doctor.ts:181-263`). With `--fix` the report adds `repaired: {rewritten, dropped, failedWrites, prunedAccessRows, commitSha}`.

`healthy` leaves out `overdueTasks`, `staleBlockers`, `untypedEntities`, and `dirty` (`apps/cli/src/doctor.ts:710-741`). `vectorCoverageLow` is true only when a vector exists or an embedder is bound and coverage is under the floor. `unparseable` also lists indexed paths whose file is gone.

Errors:

- `ERR_GIT` (exit 1) from `--fix`'s `add` or `commit` (`apps/cli/src/doctor.ts:619-625`).

Every check falls back to an empty finding, so a database failure reads as nothing found. The command exits 0 whether or not the store is healthy.

Failure: `--fix` writes the files, deletes the orphan rows one autocommitted statement at a time, and then stages and commits. A write that failed lands in `failedWrites` and is never staged, so it stays a finding (`apps/cli/src/doctor.ts:584-594`). If the commit fails, the files stay rewritten and staged, the orphan rows are already gone, and the error envelope drops the counts. A successful fix does not reindex, so the next `doctor` lists the repaired link until `index update` runs. The commit takes anything else already staged.

## eval discriminate

```
memhtml eval discriminate [--mode fake] [--seed <n>] [--now <ms>] [--size 200] [--probes 36] [--mrr-floor 0.85]
```

The refusable retrieval gate. It generates a fixture corpus in a temporary directory with an in-memory database, indexes it through the real ranking stack, and requires every probe's target to outrank each of its wrong-fact controls, with mean reciprocal rank at or above the floor (`runDiscrimination` called at `apps/cli/src/run.ts:1490-1519`). It builds no app layer and opens no root.

Flags:

- `--mode` (string, default `"fake"`, one of `fake`, `live`): "`fake` is the deterministic embedder CI measures; `live` needs AWS_BEARER_TOKEN_BEDROCK and refuses loudly without it."
- `--seed` (int): "The fixture corpus seed. A failing run is reproducible from this number."
- `--now` (int): "The run instant the fixture corpus anchors its stamps behind, UTC milliseconds since the epoch. The other half of reproducing a failing run: the corpus is a function of (seed, now), and the recency arm ranks on those stamps. Defaults to the clock, and rides back in the report."
- `--size` (int, default `200`): "Base memories to generate."
- `--probes` (int, default `36`): "Probes to run. Design §5 wants ≥30."
- `--mrr-floor` (string, default `"0.85"`): "Mean-reciprocal-rank floor. Lowering it is a deliberate, visible choice."

Response: `eval.discrimination`.

A caller reads `passed`, `mrr`, `mrrFloor`, `probes`, `discriminated`, `inversions`, `results`, `seed`, `now`, `corpusSize`, `mode`, `requested`, `skipped`, `corpusMrr`, and `degradedProbes`. The success envelope carries this payload only when the gate passed.

Errors:

- `ERR_DISCRIMINATION_FAILED` (exit 1) for any inversion, an MRR under the floor, zero probes, or `--mode live` without `AWS_BEARER_TOKEN_BEDROCK` (`DiscriminationFailed` at `apps/cli/src/run.ts:1503-1507`). The failure envelope has no `data`, so `seed`, `now`, and the inversions are not in it. The suggestions include `memhtml sleep review`, which needs a run id to be valid.
- `ERR_UNKNOWN` (exit 1) for anything else (`apps/cli/src/run.ts:1508-1512`).

An unparseable `--seed`, `--size`, `--probes`, or `--mrr-floor` falls back to its default silently.

Failure: the temporary corpus is removed once the stack is built, whether the gate then passes or fails. A failure while building the stack leaves the directory, because the finalizer is added only after `buildStack` returns (`withStack` at `packages/eval/src/harness.ts:248-258`). Nothing outside it is written.

## exec

```
memhtml exec --file <script.mjs>
memhtml exec --script <source>
memhtml exec --file -
cat script.mjs | memhtml exec
```

Runs a read-only traversal script over a pinned commit in a sandbox (`execCommand` at `apps/cli/src/exec.ts:481-533`). It resolves the root, resolves `--sha` or HEAD, adds a detached git worktree for that commit in a temporary directory, mounts it read-only at `/mnt/memhtml`, runs the script under QuickJS through `js-exec`, and removes the worktree.

Flags:

- `--file` (string): "The script to run, as a path on the HOST. Omit it, pass `--file -`, or pass a positional `-` to read the script from stdin. Mutually exclusive with `--script`."
- `--script` (string): "The script source, inline. Mutually exclusive with `--file` and with reading stdin."
- `--timeout-ms` (int, default `30000`): "Wall-clock bound on the script. Exceeding it is `exitCode` 124 with `timedOut: true`, not an error envelope. Capped at 600000."
- `--sha` (string): "The commit to mount, materialized as a detached worktree. Defaults to HEAD. Never the live working tree, whose gitignored .memhtml/index.db a worktree omits."

Response: `exec.report`.

A caller reads `exitCode`, `stdout`, `stderr`, `timedOut`, `sha`, `corpusMount`, `durationMs`, and `timeoutMs` (`ExecReport` at `apps/cli/src/exec.ts:245-260`). `sha` is `--sha` as given, not the resolved commit, so `--sha HEAD~1` reports `HEAD~1`. A script that exits non-zero is a success envelope at exit 0, and a script past `--timeout-ms` is `exitCode: 124` with `timedOut: true`.

The bounds are constants: `DEFAULT_TIMEOUT_MS` is 30000 and `MAX_TIMEOUT_MS` is 600000 (`apps/cli/src/exec.ts:47`, `apps/cli/src/exec.ts:57`). The mount is an `OverlayFs` with `readOnly: true` (`apps/consolidator/src/mount.ts:193-198`). The sandbox is a `Bash` instance built with no network and no Python option, so no flag can turn either on (`apps/cli/src/exec.ts:389-396`). A gitignored `.memhtml/index.db` is absent from a worktree, so the script cannot reach the ranked planes.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for two script doors, an explicit `-` beside a door, or a `--timeout-ms` that is not a positive integer up to the cap (`execFlags` at `apps/cli/src/run.ts:847-889`). Piped stdin beside a door is ignored, and the door's script runs.
- `ERR_MISSING_ARGUMENT` (exit 2) for a blank script (`apps/cli/src/run.ts:1728-1740`).
- `ERR_PATH_NOT_FOUND` (exit 2) when `--file` cannot be read (`readScript` at `apps/cli/src/exec.ts:444-454`).
- `ERR_INVALID_MEMORY` (exit 1) when the commit cannot be materialized, such as a bad `--sha` or an unborn HEAD (`InvalidMemory` at `apps/cli/src/exec.ts:495-523`), and when the read-only mount fails (`apps/cli/src/exec.ts:365-366`).
- `ERR_GIT` (exit 1) when the root is not a git repository and `--sha` is omitted, from the HEAD read (`revParseHead` at `apps/cli/src/exec.ts:491-494`). With `--sha` the same root answers `ERR_INVALID_MEMORY` and leaves a temporary directory behind.
- `ERR_STORAGE` (exit 1) when a module fails to load, when the sandbox fails to seed or run, or when the bridge faults on all 3 attempts. A bridge fault reruns the script, so one call can run it up to 3 times (`BRIDGE_ATTEMPTS` at `apps/cli/src/exec.ts:207`, `withBridgeRetry` at `apps/cli/src/exec.ts:222-242`).

Failure: the worktree is released by a scope finalizer, so a script failure, a timeout, and a typed failure all run the release (`apps/cli/src/exec.ts:516-525`). The finalizer ignores a failed `git worktree remove`, so the `.git/worktrees` entry can remain (`release` at `apps/consolidator/src/mount.ts:344-351`). A bad `--sha` leaves an empty temporary directory, because the directory is made before the failing `git worktree add`. A killed process skips the finalizer and leaves the worktree and its `.git/worktrees` entry; `exec` never runs `git worktree prune`.

## state export

```
memhtml state export
```

Writes the `state.access` rows to `.memhtml/state/access.jsonl` and commits it, unless the bytes already match (`stateExport` at `apps/cli/src/state.ts:54-89`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:1080-1087`).

Response: `state.export`.

A caller reads `path`, `rows`, `bytes`, `written`, and `commitSha` (`apps/cli/src/state.ts:26-32`). `bytes` is the sidecar string's length in UTF-16 code units, not bytes (`apps/cli/src/state.ts:67`, `apps/cli/src/state.ts:85`).

The sidecar holds `state.access` only. The corroboration tables in `state.db` are not exported. An empty plane, such as a fresh clone before `state import`, overwrites the sidecar with an empty file and commits that.

Errors:

- `ERR_STORAGE` (exit 1) and `ERR_GIT` (exit 1).

Failure: the file is written, staged, and committed with no journal. If the commit fails, the sidecar stays written and staged, and a rerun sees matching bytes, returns `written: false`, and does not commit it; the next unrelated commit takes it. The commit takes anything else already staged.

## state import

```
memhtml state import
```

Replays the committed sidecar into `state.db` in one transaction (`stateImport` at `apps/cli/src/state.ts:103-163`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:1088-1094`).

Response: `state.import`.

A caller reads `path`, `rows`, `restored`, `skipped` (lines that did not parse or name no path), and `hasState` (`apps/cli/src/state.ts:35-44`, `parseSidecar` at `packages/sleep/src/phases/state-export.ts:97-125`). A missing or unreadable sidecar succeeds with `rows: 0` (`readFileOrNull` at `apps/cli/src/state.ts:108`).

`access_count` and `reinforcement_count` merge by max, and the `last_*_at` columns by max as text. `outcome_score` and `updated_at` take the sidecar's value (`apps/cli/src/state.ts:137-143`). When a path already has a row and both sides of a `last_*_at` column are NULL, the column is stored as `''`, so the next export commits a changed sidecar (`apps/cli/src/state.ts:141-142`). Paths are not checked against the tree.

Errors:

- `ERR_STORAGE` (exit 1), including one parsed line that breaks a `CHECK` constraint.

Failure: the upsert is one SQLite transaction, so a failure restores nothing and an import either lands whole or not at all.

## agents-doc

```
memhtml agents-doc [--check] [--out AGENTS.md]
```

Renders `AGENTS.md` from the command table and writes it when it differs, or with `--check` compares without writing (`runAgentsDoc` at `apps/cli/src/agents-doc.ts:236-278`). It builds no app layer, so it scaffolds no root (`apps/cli/src/run.ts:1466-1474`).

Flags:

- `--check` (boolean, default `false`): "Compare the committed doc to the regenerated one and fail on a difference."
- `--out` (string): "Where to write. Defaults to ./AGENTS.md."

Response: `agents.doc`.

A caller reads `path` (absolute), `bytes`, `inSync`, and `written` (`AgentsDocResult` at `apps/cli/src/agents-doc.ts:227-234`). `bytes` is the rendered string's length in UTF-16 code units, not bytes. `--out` resolves against the working directory.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) from `--check` when the file is out of date or missing. Drift is a failure envelope, not a success with `inSync: false`, and the suggestion is `memhtml manifest` rather than the fix (`InvalidMemory` at `apps/cli/src/agents-doc.ts:257-269`).
- `ERR_STORAGE` (exit 1) when the write fails.

Failure: `--check` never writes. Without it, an in-sync file is not rewritten. An unreadable existing file counts as missing.

## serve mcp

```
memhtml serve mcp
```

Supervises the `memhtml-mcp` stdio server, 15 tools and 3 resource templates over the same root (`serveMcp` at `apps/cli/src/serve.ts:82-111`). It resolves the root, finds the server entry, spawns it with stdio inherited, and waits. It builds no app layer, so the parent holds no database handle (`apps/cli/src/run.ts:1681-1700`).

This command takes no arguments and no command-specific flags (`apps/cli/src/commands.ts:1110-1116`).

Response: `serve.exit`.

A caller reads `server` (the entry path), `exitCode`, and `signal` (`ServeResult` at `apps/cli/src/serve.ts:24-29`). The envelope is written after the child exits, at exit 0 even when the child exited non-zero. A child killed by a signal reports `exitCode: 0` with the signal name.

The child gets the whole parent environment with `MEMHTML_ROOT` set to the resolved root, which is how a `--repo` reaches it (`apps/cli/src/serve.ts:87-90`). `MEMHTML_MCP_BIN` overrides the entry; otherwise the supervisor takes the first existing sibling build path (`mcpEntryPoint` at `apps/cli/src/serve.ts:56-80`).

Errors:

- `ERR_STORAGE` (exit 1) when no entry is found, as `serve.resolveMcp`, or when the spawn fails, as `serve.spawn` (`apps/cli/src/serve.ts:75-94`). An `MEMHTML_MCP_BIN` that names a missing file is not caught here: node starts, exits non-zero, and that is the `serve.exit` report.

Failure: the supervisor kills the child only when its own fiber is interrupted. No signal handler connects a SIGTERM sent to the parent alone, so that child keeps running.

## Error codes

Branch on `code`, never on `error`. `ERROR_CODES` is append-only: a shipped code keeps its meaning and is never removed (`apps/cli/src/envelope.ts:75-115`). It holds 21 codes.

Exit 2 codes come from `validate`, `help`, `envRootRefusal` (`ERR_REPO_REQUIRED`, `apps/cli/src/run.ts:1665-1666`), the `integrations` `--project` check (`ERR_INVALID_FLAG`, `projectRootOf` at `apps/cli/src/integrations.ts:171-178`), and the `apply` and `exec` input readers, all before a service is built. Exit 1 codes come from `codeFor`, which maps a typed failure's `_tag` to a code and maps every other tag, and every untagged value, to `ERR_UNKNOWN` (`codeFor` at `apps/cli/src/errors.ts:41-79`). Only `ERR_PATH_NOT_FOUND` appears at both exits.

- `ERR_UNKNOWN_COMMAND` (exit 2): no command by that name; the suggestions are the nearest names (`apps/cli/src/run.ts:806-817`).
- `ERR_MISSING_ARGUMENT` (exit 2): a required positional or flag is absent, `write` or `correct` has neither `--claim` nor `--article-html`, `exec` got a blank script, or `apply` got no ops.
- `ERR_INVALID_FLAG` (exit 2): a flag the command does not take, a boolean given a separate value, a value outside a closed vocabulary, a bad `--as-of`, conflicting input doors, or a malformed `apply` line.
- `ERR_UNEXPECTED_ARGUMENT` (exit 2): a positional past what the command declares.
- `ERR_REPO_REQUIRED` (exit 2): `MEMHTML_REFUSE_ENV_ROOT` is set and the call opens a root without `--repo`. The suggestions are `memhtml <cmd> --repo <path>` and `memhtml help <cmd>` (`envRootRefusal` at `apps/cli/src/run.ts:1077-1090`).
- `ERR_PATH_NOT_FOUND` (exit 1, or exit 2 from the `apply` and `exec` file readers): no file at the path. The suggestions start with `memhtml resolve` (`PathNotFound` in `SUGGESTIONS` at `apps/cli/src/errors.ts:155-159`).
- `ERR_INVALID_MEMORY` (exit 1): a file or input that breaks the format or a value check, including positional vocabularies, `--phases`, `--due`, `--due-before`, `trace links` with no flag, an unmaterializable `exec --sha`, and `agents-doc --check` drift. The suggestion is `memhtml manifest`.
- `ERR_DUPLICATE_CONTENT` (exit 1): mapped, but no code path raises it; a duplicate write is a success with `deduped: true`.
- `ERR_WRITE_CONFLICT` (exit 1): an explicit `--path` that is occupied, or two `apply` ops naming one path. The suggestions are `memhtml read <path>` and `memhtml correct <path>` (`apps/cli/src/errors.ts:169-173`).
- `ERR_DIRTY_TREE` (exit 1): mapped, but no CLI command returns it; `sleep run` reports a dirty tree as a failed `preflight` phase.
- `ERR_INDEX_STALE` (exit 1): `index update`, or a write's `reindex`, found a watermark with no commit. The only suggestion is `memhtml index rebuild`, because `index update` is what raised it (`IndexStale` in `SUGGESTIONS` at `apps/cli/src/errors.ts:177-180`).
- `ERR_EMBED_MODEL_MISMATCH` (exit 1): the index was built in another vector space. The suggestion is `memhtml index rebuild --embed`.
- `ERR_MODEL_UNAVAILABLE` (exit 1): mapped, but no command on this page returns it; embedding and extraction failures degrade instead.
- `ERR_STORAGE` (exit 1): a database, filesystem, or indexer-side git failure. It carries no suggestions.
- `ERR_GIT` (exit 1): a store-side git command failed. The message names the subcommand and exit code; it carries no suggestions.
- `ERR_DISCRIMINATION_FAILED` (exit 1): `eval discriminate` failed its gate.
- `ERR_UNKNOWN` (exit 1): a defect, or a tag `codeFor` does not know, such as `LlmContractViolation` (`messageFor` at `apps/cli/src/errors.ts:90-124`).
- `ERR_REBUILD_NO_EMBED_REFUSED` (exit 1): `index rebuild` that cannot embed over a store with vectors, without `--force`. The suggestions are `memhtml index rebuild --embed`, `memhtml index rebuild --no-embed --force`, and `memhtml index embed` (`RebuildNoEmbedRefused` in `SUGGESTIONS` at `apps/cli/src/errors.ts:184-188`).
- `ERR_UNKNOWN_HOST` (exit 2): an `integrations` host outside the vocabulary.
- `ERR_UNKNOWN_HOOK_EVENT` (exit 2): a `hook` event outside the vocabulary (`vocabularyPositionals` at `apps/cli/src/run.ts:1123-1143`).
- `ERR_INTEGRATION_MODIFIED` (exit 1): an `integrations` install or uninstall found a managed file changed since the receipt.

A suggestion has to be a call that moves the failure. `SUGGESTIONS` is a record keyed by tag rather than a `switch`, so a test can drive every string through the real parser (`SUGGESTIONS` at `apps/cli/src/errors.ts:148-204`). `failureFor` builds every runtime envelope from `codeFor`, `messageFor`, and `suggestionsFor` (`apps/cli/src/errors.ts:212-213`).

## Environment variables

Every variable is one entry in `CONFIG_VARS`, which `memhtml manifest` reads to describe them (`apps/cli/src/config.ts:62-181`). There are 17.

- `MEMHTML_ROOT`: the root, default `~/memhtml`, with a leading `~` expanded (`apps/cli/src/config.ts:63-67`, `MemhtmlRoot` at `apps/cli/src/config.ts:188-191`). `--repo` wins over it.
- `MEMHTML_REFUSE_ENV_ROOT`: any value but `0`, `false`, `no`, or `off` (blank is off) makes a call that opens a root require `--repo`, refusing with `ERR_REPO_REQUIRED` at exit 2 (`apps/cli/src/config.ts:68-77`, `refusesEnvRoot` at `apps/cli/src/config.ts:59-60`). `manifest`, `help`, `agents-doc`, `eval discriminate`, and the `integrations` family are unaffected, and `hook` warns and stays silent instead.
- `MEMHTML_TRACE_ROOT`: where `trace index` reads transcripts, default `~/.claude`, read only (`apps/cli/src/config.ts:78-83`, `TraceRoot` at `apps/cli/src/config.ts:199-202`).
- `MEMHTML_AWS_REGION`: the Bedrock region for embeddings and model calls, default `us-east-1` (`apps/cli/src/config.ts:84-88`).
- `AWS_BEARER_TOKEN_BEDROCK`: the Bedrock bearer token, read by the AWS SDK. Absent means the default credential chain (`apps/cli/src/config.ts:89-94`).
- `MEMHTML_LLM_BASE_URL`: an OpenAI- and Anthropic-compatible proxy origin. Set, every model and embedding call goes through it. A malformed value fails at startup (`PROXY_BASE_URL_VAR` entry at `apps/cli/src/config.ts:95-104`).
- `MEMHTML_LLM_API_KEY`: the proxy's bearer token, read only with `MEMHTML_LLM_BASE_URL` (`apps/cli/src/config.ts:105-110`).
- `MEMHTML_LLM_MODEL_PREFIX`: the prefix on every proxied Bedrock model id, default `bedrock/`; `none` sends bare ids (`apps/cli/src/config.ts:111-116`).
- `MEMHTML_LLM_MODEL_MAP`: comma-separated `from=to` pairs that rename single models for the proxy (`PROXY_MODEL_MAP_VAR` entry at `apps/cli/src/config.ts:117-122`).
- `MEMHTML_OPENAI_PROMPT_CACHE`: `off` (default) or `implicit`, for the OpenAI sleep model's prompt caching; any other value fails at startup (`apps/cli/src/config.ts:123-128`).
- `MEMHTML_EMBED`: `off` disables the embedder; only `off`, trimmed and case-insensitive, does (`apps/cli/src/config.ts:129-134`, `apps/cli/src/api-layer.ts:243-247`).
- `MEMHTML_VECTOR_COVERAGE_FLOOR`: the coverage share below which `search` and `recall` drop the vector arm, default `0.95` (`apps/cli/src/config.ts:135-140`). The range check accepts values above 0 up to 1, and a value outside it fails the layer build with no envelope (`apps/cli/src/api-layer.ts:311-316`).
- `MEMHTML_LLM`: `off` unbinds the model and the consolidator (`apps/cli/src/config.ts:141-146`). `dedup-merge` and `entity-resolution` still run their deterministic passes and can commit; the other six `LLM_PHASES` report no model, write nothing, and stay `ok`.
- `MEMHTML_EXTRACT_ENTITIES`: `off` removes the entity-extraction model call that `apply` makes per batch; `MEMHTML_LLM=off` removes it too (`apps/cli/src/config.ts:147-157`).
- `OTEL_EXPORTER_OTLP_ENDPOINT`: an OTLP collector base URL; set, spans export to `<endpoint>/v1/traces` (`apps/cli/src/config.ts:158-163`).
- `OTEL_SERVICE_NAME`: overrides `service.name` on exported traces, read only with the endpoint set (`apps/cli/src/config.ts:164-169`).
- `MEMHTML_MCP_BIN`: an explicit path to the `memhtml-mcp` entry for `serve mcp` (`MCP_BIN_VAR` entry at `apps/cli/src/config.ts:170-180`). The `integrations` family reads it too.

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at 845ab02.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 35 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 32 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 31 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 30 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 24 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 18 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 18 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 17 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 16 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 14 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 13 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 12 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 12 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 11 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 11 shared source citations
