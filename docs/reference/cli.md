# memhtml-public · CLI

Describes the source at 0.16.0 (2026-10-18). Citations are `path:line` into that tree.

The `memhtml` binary is the operator surface for a memhtml root. Its entry point, `bin.ts`, passes `process.argv` to `run` and writes the result with `process.stdout.write` (`apps/cli/src/bin.ts:5`, `apps/cli/src/bin.ts:22`).

Every subcommand is one entry in the `COMMANDS` array (`apps/cli/src/commands.ts:185-1746`). The same array drives the parser, the validator, `memhtml manifest`, `memhtml help`, and the generated `AGENTS.md`. At 0.16.0 it holds 57 commands, and this page has a section for 51 of them.

The six commands without a section are `integrations install`, `integrations uninstall`, `integrations list`, `integrations doctor`, `integrations shell`, and `hook`. `docs/design.md` §12.1, "Host integrations", covers the receipt, the fragment grain, and the hook posture. Two docs-site task pages cover their use: `apps/docs/src/content/docs/learn/operations/wire-a-coding-agent.md` ("Wire up your coding agent") and `apps/docs/src/content/docs/learn/operations/hooks-and-recall.md` ("Hooks and recall"). They appear below only where they share a mechanism with the other commands.

Start with `memhtml manifest`. It returns the whole contract: every command, argument, flag, response type, error code, and environment variable, built by walking `COMMANDS` (`buildManifest` at `apps/cli/src/commands.ts:1995-2023`). It opens no store.

The code in this repository is the software. The memory corpus lives in a separate git repository, the memhtml root. A command acts on the root named by `--repo`, else `$MEMHTML_ROOT`, else `~/memhtml` (`layerRoots` at `apps/cli/src/api-layer.ts:100-109`, `MemhtmlRoot` at `apps/cli/src/config.ts:282-286`).

The commands fall into two families. The v1 commands (`write`, `apply`, `search`, the `index` and `trace` families, and the rest) read and write through the SQLite index under `.memhtml/`. The v2 commands (`session …`, `head …`, `curate …`) treat the corpus as an immutable version built from git, change it through a session's overlay log, and never open `index.db` (`isV2Command` at `apps/cli/src/run.ts:1228-1229`). `docs/design.md` §15 covers why, and §16 to §23 cover each part.

Removed in 0.16: the sleep pipeline (`sleep run`, `sleep resume`, `sleep review`, `sleep merge`, `sleep status`, `sleep plan`), the consolidator, `apply --consolidate` with its `consolidated_into`, `superseded_path`, and `consolidated` fields, and the `lastSleep` and `stuckSleepRuns` status fields. Curation runs on a branch through `curate run`, `curate collapse`, and `curate merge` instead. The four `sleep.*` response type strings stay in the append-only `RESPONSE_TYPES` list, and no command answers them (`apps/cli/src/envelope.ts:20-23`). `init` still scaffolds the empty reports directory `.memhtml/sleep/`, so an existing store's layout doesn't change (`SLEEP_REPORTS_DIR` at `packages/store/src/layout.ts:33-34`). The operator migration guide is <https://memhtml.github.io/learn/operations/migrate-to-0-16/>.

## Output

A command writes one JSON envelope to stdout. A success is `{apiVersion, type, data}`, and `type` names the shape of `data`. A failure is `{apiVersion, error, code, suggestions}` (`Success` and `Failure` at `apps/cli/src/envelope.ts:92-103`). Branch on `type` and `code`. The `error` prose changes freely.

Four commands write something else to stdout, or write it late. `help` on a terminal writes Markdown from `renderAgentsDoc` (`apps/cli/src/run.ts:1586-1590`) or `renderCommandHelp` (`apps/cli/src/run.ts:1628-1630`). `serve mcp` spawns the server child with `stdio: "inherit"` and writes its `serve.exit` envelope after the child exits (`spawn` at `apps/cli/src/serve.ts:87-90`, `apps/cli/src/run.ts:1969`). `head serve` runs until SIGTERM or SIGINT stops it and writes its `head.served` envelope then (`apps/cli/src/run.ts:2283-2297`). `hook` writes the host's own protocol (`apps/cli/src/run.ts:1829-1883`).

Logs go to stderr (`LogToStderr` at `apps/cli/src/run.ts:2442`). `bin.ts` calls `process.exit` from the `process.stdout.write` callback, so a slow pipe reader still gets the whole envelope (`apps/cli/src/bin.ts:22`).

Exit 0 is success. Exit 2 is a usage error, fixed by changing the call. Exit 1 is a runtime failure, fixed by changing the root or the environment (`EXIT_OK`, `EXIT_USAGE`, `EXIT_RUNTIME` at `apps/cli/src/envelope.ts:166-168`).

Three outcomes don't follow the envelope-per-exit pattern. `exec` and `session exec` exit 0 when the script itself failed, and report the script's exit code in the payload (`apps/cli/src/run.ts:2055`, `apps/cli/src/run.ts:2375`). `session commit` exits 0 with a `session.committed` envelope whatever its outcome, so a `refused`, `rebase-needed`, or `worktree-dirty` commit is a success envelope that committed nothing, and a caller reads its `kind` field (`apps/cli/src/v2.ts:1927-1928`, `apps/cli/src/run.ts:2375`). A failure to build the app layer writes no envelope at all; see the next section.

## Conventions

A command section has a usage block, what the command does, its `Arguments:` and `Flags:` lists, a `Response:` line, the fields a caller reads, its error codes, and a `Failure:` paragraph.

A list item reads `` `--name` (type, default, required, repeatable, one of …): "description" ``. The parenthesized part is the manifest's own metadata, with the default written as JSON. The quoted part is the flag's description in `commands.ts`, which `memhtml help` prints. The page adds code formatting around tags and paths and changes no other character. Prose outside the quotes is this page's.

`repeatable` is what the manifest declares. The parser keeps every occurrence of every flag, and each dispatch arm chooses whether it reads all of them (`list`) or the last one (`str`) (`apps/cli/src/run.ts:267-276`). Where the two disagree, the command section says so.

## How a command fails

`run` handles a call in a fixed order, and the step that fails decides the exit code and what is touched (`run` at `apps/cli/src/run.ts:1684-2447`).

1. `parseArgv` turns argv into a command, positionals, and flag arrays. It never fails (`apps/cli/src/run.ts:187-264`).
2. `help`, `--help`, and `-h` are answered at once, before validation (`apps/cli/src/run.ts:1701-1703`). A bare `memhtml` answers the manifest (`apps/cli/src/run.ts:1705`).
3. For the four record-creating v1 doors (`write`, `apply`, `correct`, `task add`), `run` reads the store's `memhtml.config.json` when it knows the root without a layer. A file that doesn't decode is `ERR_STORE_CONFIG` at exit 1 here, before validation (`apps/cli/src/run.ts:1715-1723`).
4. `validate` refuses a malformed call with exit 2 before any service is built (`apps/cli/src/run.ts:1725-1726`). A closed v1 door is refused here too; see [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).
5. `manifest`, `agents-doc`, `eval discriminate`, and the `integrations` family answer without opening a root (`apps/cli/src/run.ts:1741-1937`). `hook` is answered in the same block, but it opens an existing store and never scaffolds one (`hookStoreReady` at `apps/cli/src/run.ts:1866`, `layerApp` at `apps/cli/src/run.ts:1880`).
6. With `MEMHTML_REFUSE_ENV_ROOT` set and no `--repo`, every remaining command is refused with `ERR_REPO_REQUIRED` at exit 2 (`envRootRefusal` at `apps/cli/src/run.ts:1295-1308`, `apps/cli/src/run.ts:1944-1945`).
7. `serve mcp`, `config`, and `exec` resolve the root themselves and build no app layer (`apps/cli/src/run.ts:1960-2069`).
8. The v2 commands resolve the root themselves too. Before anything opens, `run` reads their file inputs (the `session exec` script, the `session put` op stream), their environment variables, and the curator's model, and refuses a bad one at exit 2 (`apps/cli/src/run.ts:2081-2263`). Then `runV2` or the command's own function runs with no app layer, and a typed failure becomes an envelope through `failureFor` at exit 1 (`apps/cli/src/run.ts:2265-2387`).
9. `apply` reads and decodes its whole op stream. A bad stream is exit 2 with nothing opened (`apps/cli/src/run.ts:2401-2412`).
10. Every other command runs its `dispatch` arm inside `layerApp(--repo)`. A typed failure becomes an envelope through `failureFor` at exit 1, a closed v1 door found inside the layer is exit 2, and a defect becomes `ERR_UNKNOWN` at exit 1 (`apps/cli/src/run.ts:2414-2446`).

Step 10 has a side effect before the command runs. Building `layerApp` opens the database through `layerDatabase`, which creates `<root>/.memhtml/` with `mkdir -p`, creates `index.db` and `state.db`, sets WAL, and applies pending migrations (`layerDatabase` at `apps/cli/src/api-layer.ts:119-129`, `makeDatabase` at `packages/index/src/database.ts:311-352`). A read command on a root that doesn't exist therefore creates `<root>/.memhtml/`. An index read such as `search` then answers empty at exit 0, while a file or git read fails. On a migrated store the build changes nothing. The v2 commands skip this step, so they never create or migrate `index.db`.

A failure while building that layer gets no envelope. `layerDatabase` is `Layer.orDie`, and the layer is provided outside the `catchCause` that turns defects into an `ERR_UNKNOWN` envelope (`apps/cli/src/api-layer.ts:129`, `apps/cli/src/run.ts:2426-2431`). A root that is a file, an unreadable database, a failed migration, or an unusable `MEMHTML_VECTOR_COVERAGE_FLOOR` ends with empty stdout, a stack on stderr, and exit 1. The v2 commands build their embedder inside the program, so a failed embedder build there is caught and answers with an `ERR_UNKNOWN` envelope (`apps/cli/src/run.ts:2271-2278`, `apps/cli/src/run.ts:2377-2381`).

Every command can return the usage codes at exit 2: `ERR_UNKNOWN_COMMAND`, `ERR_MISSING_ARGUMENT`, `ERR_INVALID_FLAG`, `ERR_UNEXPECTED_ARGUMENT`, and `ERR_REPO_REQUIRED` where step 6 applies. `memhtml help` lists `ERR_SESSION_BOUND` and `ERR_V1_DOOR_CLOSED` among them too, though only the four record doors return them (`USAGE_ERROR_CODES` at `apps/cli/src/help.ts:26-34`). Every command run through step 8 or step 10 can also return `ERR_STORAGE` and `ERR_UNKNOWN` at exit 1. The per-command `Errors:` lists below name the rest.

## What a failed write leaves behind

The store-backed writes are `write`, `apply`, `correct`, `link`, `archive`, and `task add`, plus `task status done`. Each fails in one of three phases. `session commit` and `curate merge` write through a different path; their sections say what they leave.

1. Validation runs before the store touches disk: the strict-path gate, the render gate, the content-hash dedupe lookup, and placement (`writeMemory` at `packages/store/src/store.ts:722-760`). A refusal here leaves the tree byte-identical.
2. The file writes, `git add`, and `git commit` run under a journal. On a failure the store unstages every path it touched and restores each one's earlier bytes (`restore` at `packages/store/src/store.ts:534-550`). If that restore fails, `compensated` only logs it and the tree is left dirty (`packages/store/src/store.ts:565-577`). Directories made by `mkdir` stay. The journal also runs when `git commit` landed and the `rev-parse` after it failed. The commit stays, and the restore removes the commit's new files from the worktree and puts back the earlier bytes of the files it changed (`commit` at `packages/store/src/git.ts:453-472`).
3. After the commit, the operation calls `reindex` (`apps/cli/src/operations.ts:267-271`). That step can fail with `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` after the commit landed. The call exits 1, but the memory is in git.

A blind retry after a phase-3 failure writes the memory again under a `-2` path. Dedupe reads the index through `activePathForHash`, and the index hasn't seen the commit (`packages/index/src/traces-persist.ts:196-203`). Two active files with one content hash then make every later reindex fail on the unique index over active non-task content hashes, so every later write commits and exits 1 until one of the pair is archived (`files_content_hash_active` at `packages/index/migrations/0008_tasks.sql:126-127`).

The journal compensates any failure the fiber sees: a typed failure, a defect, or an interruption (`Effect.onError` in `compensated` at `packages/store/src/store.ts:565-577`). A killed process skips it. `bin.ts` installs no signal handler, so a killed process can leave files written or staged (`apps/cli/src/bin.ts:1-22`).

The commit is `git commit -m` with no pathspec, after a `git diff --cached --quiet` check, so it also commits any path that was already staged in the root (`commit` at `packages/store/src/git.ts:453-472`). `init`, `publish`, `state export`, `doctor --fix`, and `task status` commit the same way.

Writes take turns twice. In one process, every store write waits for one permit, `oneWriterAtATime`, and then takes the checkout lock (`exclusive` at `packages/store/src/store.ts:1419-1423`). The checkout lock is a lock directory at `.memhtml/checkout.lock` that every writer of the shared git index holds while it stages and commits, in any process (`CHECKOUT_LOCK_PATH` at `packages/contracts/src/checkout-lock.ts:35`, `checkoutLockTarget` at `packages/store/src/checkout-lock.ts:19`). A session commit holds it around its checkout update and ref swap, and `curate merge` around its fast-forward (`landOnRef` at `packages/session/src/commit.ts:284-333`). `Git.commit` takes it as a backstop, and `init`, `task status`, `publish`, `state export`, and `doctor --fix` take it around their own stage and commit (`packages/store/src/git.ts:453-455`, `packages/store/src/layout.ts:273`, `apps/cli/src/operations.ts:2024`, `apps/cli/src/publish.ts:160`, `apps/cli/src/state.ts:85`, `apps/cli/src/doctor.ts:544`). It's reentrant within one fiber, so a write that archives through another write doesn't wait on itself (`CheckoutLockHeld` at `packages/contracts/src/checkout-lock.ts:94-97`).

A waiter retries the lock for up to 15 s, pausing 10 ms and doubling to 250 ms. Then it fails with `StorageFailure` `checkout.locked`, which is `ERR_STORAGE` at exit 1, having written nothing (`CHECKOUT_LOCK_WAIT_MS` and `CHECKOUT_LOCKED` at `packages/contracts/src/checkout-lock.ts:54-63`, `withCheckoutLockUsing` at `packages/contracts/src/checkout-lock.ts:128-195`). A holder refreshes the lock every 2 s, and a lock with no refresh for 10 s is stale and reclaimed, so a lock left by a killed process blocks writers for up to about 10 s (`CHECKOUT_LOCK_STALE_MS` and `CHECKOUT_LOCK_UPDATE_MS` at `packages/contracts/src/checkout-lock.ts:42-45`).

SQLite writes are serialized by the database. `index.db` runs in WAL mode with a 5000 ms busy timeout, and a busy failure is retried with backoff (`BUSY_TIMEOUT_MS` at `packages/index/src/database.ts:22`, `packages/index/src/database.ts:147-150`). `state.db` is attached after the WAL pragma runs, so it stays in the default rollback-journal mode (`packages/index/src/database.ts:341-352`). No lock spans an index operation and a git operation.

## Run sessions and the v1 doors

`MEMHTML_SESSION` names the v2 session a process writes through. An agent runtime exports it to every subprocess of one run, for example `run-<run id>`, and commits that session when the run ends. `run` reads it trimmed, and blank is unset (`SESSION_VAR` and `sessionFromEnv` at `apps/cli/src/config.ts:99-105`). `docs/design.md` §18 covers run sessions, and §19 covers the write bar and the store policy.

Set, it does three things.

1. Every `session` command except `session prune` takes it as the default `--id`. With neither `--id` nor the variable, the call is `ERR_MISSING_ARGUMENT` at exit 2, and a variable that isn't a session id is `ERR_INVALID_FLAG` at exit 2 naming the variable (`sessionIdFlag` at `apps/cli/src/run.ts:936-971`, `sessionIdOf` at `apps/cli/src/run.ts:979-988`).
2. `session put` and `session exec` start the session on first use when the id came from the variable. The start costs one `rev-parse` on `refs/heads/main` (or `HEAD` when there's no `main`), and a second first use at the same moment waits up to 5 s for the first one's log and goes on with it (`ensureSession` at `apps/cli/src/v2.ts:442-469`). An id given with `--id` must name a started session.
3. A put or a harvest in the run's own session is held to a stricter bar. `duplicate` and `claim-edit` refuse the call there too, as well as the four kinds that always refuse it, so the run's log only holds ops that would land when they're written (`RUN_BOUND_BLOCKING_VIOLATIONS` at `apps/cli/src/v2.ts:350-357`). The id counts as the run's whenever it equals the variable, given on the line or not.

The v1 doors that create a record are `write`, `apply`, `correct`, and `task add` (`RECORD_CREATING_V1_COMMANDS` at `apps/cli/src/doors.ts:44-76`). They commit straight to the store with no write bar, so the store's policy file, `memhtml.config.json` at the root, can close them with its `v1Doors` key (`V1_DOOR_MODES` at `packages/contracts/src/store-config.ts:37`, `v1DoorState` at `apps/cli/src/store-config.ts:111-118`).

| `v1Doors`                         | `MEMHTML_SESSION` set | `MEMHTML_SESSION` unset |
| --------------------------------- | --------------------- | ----------------------- |
| `open`                            | open                  | open                    |
| `closed-in-session` (the default) | `ERR_SESSION_BOUND`   | open                    |
| `closed`                          | `ERR_SESSION_BOUND`   | `ERR_V1_DOOR_CLOSED`    |

The default is `closed-in-session` (`DEFAULT_V1_DOORS` at `packages/contracts/src/store-config.ts:123`). Both refusals are exit 2 and open nothing. `run` judges the door in `validate` when it can read the root before building a layer, from `--repo` or from the environment (`apps/cli/src/run.ts:1715-1726`, `sessionBoundRefusal` at `apps/cli/src/run.ts:1003-1016`). Otherwise the arm's own guard judges it inside the layer, and the answer is still exit 2 (`guardV1Door` at `apps/cli/src/store-config.ts:125-133`, `apps/cli/src/run.ts:2418-2422`). `codeFor` picks the code by whether a session closed the door (`V1DoorClosed` at `apps/cli/src/errors.ts:97-98`). The suggestions are the session commands that do the same job, as `session put` lines that run as written (`sessionDoorRefusal` and `closedDoorRefusal` at `apps/cli/src/doors.ts:85-106`).

The edits of existing records, `link`, `archive`, `task status`, and `reinforce`, aren't record doors, and no mode closes them (`apps/cli/src/doors.ts:12-13`). The other v1 commands ignore the variable. The MCP server's `memory_write`, `memory_write_batch`, and `memory_correct` follow the same mode, reading `MEMHTML_SESSION` from the server's own environment (`apps/mcp/src/handlers.ts:338`, `apps/mcp/src/handlers.ts:406`, `apps/mcp/src/handlers.ts:658`). `memhtml config` shows the store's mode.

The policy file is read from the working tree each time a door, a session write, or a curate command needs it, and never cached (`loadStorePolicy` at `apps/cli/src/store-config.ts:64-93`). An absent file is the library defaults. A file that exists and can't be read or doesn't decode is `ERR_STORE_CONFIG` at exit 1 for every command that needs the policy.

## Global flags

Three flags apply to every command. They're declared once in `GLOBAL_FLAGS`, so the manifest and the parser read one declaration (`apps/cli/src/commands.ts:68-88`).

Flags:

- `--dense` (boolean, default `false`): "Minify JSON and drop null fields, for pasting into a context window."
- `--repo` (string, default `""`): "Path to the memory repo. Defaults to $MEMHTML_ROOT."
- `--help` (boolean, default `false`): "Describe this command instead of running it: usage, arguments, flags, response type, examples. Also `-h`. Markdown when stdout is a terminal, a `cli.help` envelope when piped or with --json. Flags other than --json and --dense are ignored, nothing is opened or written, exit 0."

`--dense` drops null and undefined fields at every depth and minifies (`stripNulls` and `render` at `apps/cli/src/envelope.ts:222-235`). Empty arrays stay.

`--repo` is trimmed and used as given (`layerRoots` at `apps/cli/src/api-layer.ts:100-109`). A leading `~` in it isn't expanded, while the same value in `MEMHTML_ROOT` is (`MemhtmlRoot` at `apps/cli/src/config.ts:282-286`). A blank `--repo` falls back to the environment.

`--help` keeps `--json`, `--dense`, and `--repo` and drops every other flag on the line (`HELP_FLAGS` at `apps/cli/src/run.ts:1562-1565`). It never opens a root.

There's no global `--json` flag. The envelope is the only output most commands have, so `--json` is declared on `help` alone, the one command with a second shape (`GLOBAL_FLAGS` at `apps/cli/src/commands.ts:59-88`, the `help` entry at `apps/cli/src/commands.ts:194-218`).

The parser accepts `--flag value`, `--flag=value`, `--no-flag`, bare `--flag`, and `-h` for `--help` (`parseArgv` at `apps/cli/src/run.ts:187-244`). Only a flag the table types `string` or `int` takes the next token as its value, and only when that token doesn't start with `--` (`apps/cli/src/run.ts:224-230`). `--no-<name>` works only for a declared flag name, which is how a boolean that defaults to `true` is turned off, as with `--no-embed` and `--no-server`.

A boolean reads `false` for `--no-flag`, `--flag=false`, `--flag=0`, and `--flag=no`, and `true` otherwise (`bool` at `apps/cli/src/run.ts:279-284`). A boolean followed by `true`, `false`, `yes`, `no`, `0`, or `1` as a separate word is refused; the next section has the rule (`BOOLEAN_VALUE_TOKENS` at `apps/cli/src/run.ts:160`).

An `int` flag goes through `Number.parseInt`, so `7.9` reads as 7 and a value that doesn't parse is silently treated as absent (`int` at `apps/cli/src/run.ts:287-292`). The few number-valued `string` flags go through `Number.parseFloat` the same way (`num` at `apps/cli/src/run.ts:295-300`). Neither reader checks a range, though some commands check their own integers in `validate`. A value-taking flag given with no value is stored as `true`, which every reader treats as absent.

## Flag and argument validation

`validate` checks a call against this command's spec and the three globals, never against the union of every command's flags (`validateAgainst` at `apps/cli/src/run.ts:1403-1525`). A flag that's valid on another command is still `ERR_INVALID_FLAG` here, with that command among the suggestions. `memhtml list --status todo` is refused and points at `task list`.

The rules run in this order, and the first refusal wins:

1. A flag this command doesn't declare: `ERR_INVALID_FLAG` (`apps/cli/src/run.ts:1419-1433`).
2. A boolean flag followed by a value-shaped word, such as `--embed false`: `ERR_INVALID_FLAG`, naming `--embed=false` and `--no-embed` (`strayBooleanFlags` at `apps/cli/src/run.ts:1161-1170`).
3. A positional past what the command declares: `ERR_UNEXPECTED_ARGUMENT`, unless the last argument is `repeatable` (`surplusArgs` at `apps/cli/src/run.ts:1199-1214`). A bare `-` is exempt on `apply`, `exec`, `session exec`, and `session put`, where it names stdin (`STDIN_MARKER_COMMANDS` at `apps/cli/src/run.ts:1180-1185`).
4. A record door the store's `v1Doors` closes: `ERR_SESSION_BOUND` or `ERR_V1_DOOR_CLOSED` (`sessionBoundRefusal` at `apps/cli/src/run.ts:1003-1016`, called at `apps/cli/src/run.ts:1446-1447`).
5. A `session` command other than `session prune` with no `--id` and no `MEMHTML_SESSION`: `ERR_MISSING_ARGUMENT`. An id that isn't one path segment of letters, digits, `.`, `_`, or `-`, starting with a letter or digit and at most 128 characters: `ERR_INVALID_FLAG` (`sessionIdFlag` at `apps/cli/src/run.ts:936-971`, `SESSION_ID` at `packages/session/src/session.ts:62`).
6. A required positional absent: `ERR_MISSING_ARGUMENT` (`apps/cli/src/run.ts:1451-1460`).
7. A required flag absent: `ERR_MISSING_ARGUMENT` (`apps/cli/src/run.ts:1462-1471`).
8. `write` and `correct` without exactly one of `--claim` and `--article-html` (`claimOrArticle` at `apps/cli/src/run.ts:1090-1115`).
9. The input doors of `exec` and `session exec` (at most one of `--file` and `--script`, no `-` beside one, a `--timeout-ms` from 1 to 600000), and of `apply` (`execFlags` at `apps/cli/src/run.ts:755-811`, `applyFlags` at `apps/cli/src/run.ts:821-832`).
10. `head snapshot` without exactly one of `--write` and `--read` (`headSnapshotFlags` at `apps/cli/src/run.ts:1032-1050`).
11. A `session prune --older-than` that isn't a duration with a unit (`sessionPruneFlags` at `apps/cli/src/run.ts:1019-1030`).
12. A `head serve --poll-ms` below 0 or a blank `--ref` (`headServeFlags` at `apps/cli/src/run.ts:1057-1076`).
13. A `curate merge` with a blank `--into` or a ref that would land on itself (`curateMergeFlags` at `apps/cli/src/run.ts:843-860`).
14. A `curate run` or `curate collapse` `--ref` outside `curate/`, a `--model` of no known shape, or a budget integer below 1 (`curateRunFlags` at `apps/cli/src/run.ts:879-920`).
15. An `--as-of` outside `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ssZ`: `ERR_INVALID_FLAG` (`asOfFlag` at `apps/cli/src/run.ts:1136-1148`).
16. A value outside a flag's declared `values`: `ERR_INVALID_FLAG` with the nearest spellings. Every occurrence of a repeated flag is checked (`apps/cli/src/run.ts:1510-1522`).

Then the closed vocabularies that arrive as positionals are checked, for `hook` and the `integrations` verbs only (`vocabularyPositionals` at `apps/cli/src/run.ts:1341-1361`). The rel of `link`, the status of `task status`, and the paths of every command are checked later, at exit 1.

Every refusal of a known command ends with that command's help pointer, `memhtml help <cmd>`, appended once in `validate` (`apps/cli/src/run.ts:1387-1390`). An unknown command gets nearest names instead, measured against the whole typed invocation, so `memhtml index rebiuld` suggests `index rebuild` (`unknownCommand` at `apps/cli/src/run.ts:712-723`).

The help pointer is added only by `validate`. Refusals raised later, such as `apply`'s line errors and the v2 environment checks, carry their own suggestions and no pointer.

## manifest

```
memhtml manifest
```

Returns `buildManifest()` (`apps/cli/src/commands.ts:1995-2023`). Its fields are `name`, `version`, `summary`, `apiVersion`, `guide`, `globalFlags`, `errorCodes`, `config`, `responseTypes`, and `commands`. Each command entry carries its `name`, `summary`, `args`, `flags`, `responseTypes`, `examples` (always an array), `supportsJson`, and `supportsDense` (`apps/cli/src/commands.ts:2011-2022`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:186-193`).

Response: `cli.manifest`.

`responseTypes` is derived from the commands and holds 53 types (`apps/cli/src/commands.ts:2010`). `RESPONSE_TYPES` holds 57, and the difference is four retired strings that the list keeps because it's append-only (`RESPONSE_TYPES` at `apps/cli/src/envelope.ts:12-88`). `guide` holds seven topic blocks, the prose an agent reads first. Their topics are `first-call`, `write-surfaces`, `when-to-batch`, `conflicts`, `authoring`, `code-mode`, and `recall-discipline` (`GUIDE` at `apps/cli/src/commands.ts:1779-1986`).

Errors: only the usage codes. `memhtml manifest --sha 1` is `ERR_INVALID_FLAG` at exit 2.

Failure: `manifest` is answered after `validate` and before any root is resolved (`apps/cli/src/run.ts:1741-1743`). It opens no store, reads no environment variable, and writes nothing, so it works as a liveness check. A bare `memhtml` returns the same envelope without validation (`apps/cli/src/run.ts:1705`).

## help

```
memhtml help [command]
memhtml help index rebuild --json
memhtml <command> --help
```

Describes one command, or the whole manifest when no command is named (`help` at `apps/cli/src/run.ts:1548-1631`). It's answered before the store's policy file is read and before `validate` runs (`apps/cli/src/run.ts:1701-1703`).

Arguments:

- `[command]` (optional, repeatable): "The command to describe, one or two words (`search`, `index rebuild`). Omitted: the whole manifest, as Markdown on a terminal and as the cli.manifest envelope when piped."

Flags:

- `--json` (boolean, default `false`): "Emit the cli.help envelope even when stdout is a terminal. Wins over the terminal check, so a script can never receive Markdown by accident."

Response: `cli.help`, `cli.manifest`.

`cli.help` is the manifest's entry for the command plus four derived fields, `usage`, `globalFlags`, `usageErrorCodes`, and `seeAlso` (`helpData` at `apps/cli/src/help.ts:66-76`). `usage` always ends in `[flags]` (`usageOf` at `apps/cli/src/help.ts:41-47`). `usageErrorCodes` lists the seven codes in `USAGE_ERROR_CODES`, which are `ERR_UNKNOWN_COMMAND`, `ERR_MISSING_ARGUMENT`, `ERR_INVALID_FLAG`, `ERR_UNEXPECTED_ARGUMENT`, `ERR_REPO_REQUIRED`, `ERR_SESSION_BOUND`, and `ERR_V1_DOOR_CLOSED` (`apps/cli/src/help.ts:26-34`). `seeAlso` lists the commands sharing this one's noun or one of its response types (`seeAlsoOf` at `apps/cli/src/help.ts:54-63`).

Output shape follows one rule. With stdout a terminal and no `--json`, the answer is Markdown. A named command gets `renderCommandHelp`, and a call that names no command gets the whole generated `AGENTS.md` from `renderAgentsDoc`. Otherwise the answer is the envelope (`apps/cli/src/run.ts:1579`, `apps/cli/src/run.ts:1586-1590`, `apps/cli/src/run.ts:1628-1630`).

The `--help` form keeps only `--help`, `--json`, `--dense`, and `--repo` (`HELP_FLAGS` at `apps/cli/src/run.ts:1562-1565`), so `memhtml search --type x --help` describes `search`. The spelled-out form validates every flag as a flag of `help`, so `memhtml help search --limit 5` is refused.

Errors:

- `ERR_UNKNOWN_COMMAND` (exit 2) for a name that isn't a command. A noun alone, such as `memhtml help index`, lists the family as suggestions (`apps/cli/src/run.ts:1612-1626`).
- `ERR_UNEXPECTED_ARGUMENT` (exit 2) for a known command followed by a stray word (`apps/cli/src/run.ts:1597-1611`).

Failure: help never resolves a root, never opens a store, and writes nothing. A refusal is an envelope at exit 2 even on a terminal.

## init

```
memhtml init
```

Scaffolds a memory repository at the root (`initRepo` at `packages/store/src/layout.ts:246-281`). It runs `git init -b main` if the root isn't a repository yet, sets `merge.ours.driver` and `merge.directoryRenames=false` in the local git config, and writes each missing scaffold file. The second keeps a merge from reading an archive move that emptied a directory as that directory's rename (`MERGE_DIRECTORY_RENAMES` in `packages/store/src/layout.ts`). Then it stages the scaffold paths and commits them while it holds the checkout lock `.memhtml/checkout.lock` (`packages/store/src/layout.ts:269-278`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:219-225`).

Response: `repo.init`.

A caller reads `root`, `created`, `headSha`, and `wrote` (`InitResult` at `packages/store/src/layout.ts:166-174`). `created` is true when this call ran `git init` (`packages/store/src/layout.ts:280`). `headSha` is the commit this call made, or the existing `HEAD` when it made none (`packages/store/src/layout.ts:279`). `wrote` lists the scaffold files this call created, in scaffold order (`SCAFFOLD_FILES` at `packages/store/src/layout.ts:224-229`).

The scaffold is twelve files. Nine are `.gitkeep` files, one in each directory of `SCAFFOLD_DIRS` (`packages/store/src/layout.ts:33-48`). Those directories are the four PARA buckets, `areas/arcs`, `resources/people`, `areas/inbox`, `.memhtml/state`, and one reports directory under `.memhtml/`. No command in this build writes into that reports directory, and it stays in the scaffold so an existing store's layout doesn't change. The note at the top of this page names it. `.gitignore` lists the two databases and their `-*` side files, the three v2 state directories `.memhtml/sessions/`, `.memhtml/snapshots/`, and `.memhtml/vectors/`, and the head server's socket `.memhtml/head.sock` (`GITIGNORE` at `packages/store/src/layout.ts:84-89`, `V2_IGNORE_PATTERNS` at `packages/store/src/layout.ts:68-73`). `.gitattributes` sets `merge=ours` on `index.html` and `sitemap.xml` and `diff=html` on `*.html` (`GITATTRIBUTES` at `packages/store/src/layout.ts:100-103`). `README.html` is a memory-shaped page that describes the repository (`README` at `packages/store/src/layout.ts:145-163`).

`init`'s dispatch arm (`apps/cli/src/run.ts:357-362`) runs inside `layerApp` (`apps/cli/src/run.ts:2431`), so it also creates and migrates `.memhtml/index.db` and `state.db`.

Re-running `init` on a scaffolded repository writes no file and makes no commit. `wrote` is empty and `headSha` is unchanged. It sets the git config again. On an existing repository without the scaffold it reports `created: false`, writes the scaffold, and commits it. An existing `.gitignore`, `.gitattributes`, or `README.html` is kept unchanged and never merged (`writeIfAbsent` at `packages/store/src/layout.ts:177-191`). Files already in a non-empty directory are left untracked. Because `init` never rewrites an existing `.gitignore`, a store scaffolded by an earlier release keeps one without the v2 patterns, and the first writer of each v2 directory appends its pattern to `.git/info/exclude` instead (`packages/session/src/exclude.ts:11-18`, `ensureExcluded` at `packages/session/src/exclude.ts:54-76`).

Errors:

- `ERR_GIT` (exit 1) from `git init`, `git config`, `git add`, `git commit`, or `git rev-parse`, for example when git has no identity configured (`initRepo` at `packages/store/src/layout.ts:246-281`).
- `ERR_STORAGE` (exit 1) from a scaffold read or write, with operation `read`, `init.mkdir`, or `init.write:<path>` (`readFileOrNull` at `packages/store/src/layout.ts:194-209`, `writeIfAbsent` at `packages/store/src/layout.ts:177-191`).
- `ERR_STORAGE` (exit 1) with operation `checkout.locked` when another writer of the checkout holds `.memhtml/checkout.lock` past the 15 s wait (`packages/store/src/layout.ts:273-278`, `CHECKOUT_LOCK_WAIT_MS` at `packages/contracts/src/checkout-lock.ts:54`).

Failure: `init` isn't transactional. The scaffold writes land first, and `git add` and `git commit` run after them under the checkout lock (`packages/store/src/layout.ts:264-278`). If the lock wait runs out, the scaffold stays written and unstaged. If the commit fails, the scaffold stays written and staged. A re-run finishes the commit either way. That re-run reports an empty `wrote`, because the files already exist, and `created: false`, because the first run already ran `git init`. The commit also takes any path that was already staged.

## write

```
memhtml write --title <title> --type <type> --claim <sentence> [--body <paragraph>]...
memhtml write --title <title> --type <type> --article-html <markup>
```

Writes one memory, commits it, and reindexes (`writeMemory` at `apps/cli/src/operations.ts:344-353`). It checks the store's `v1Doors` policy first, once before `validate` when the root is known and again in its dispatch arm (`apps/cli/src/run.ts:1715-1726`, `guardV1Door` at `apps/cli/src/run.ts:366`, `apps/cli/src/store-config.ts:125-133`). The type is decoded through the operator vocabulary before the store runs (`decodeOperatorType` at `apps/cli/src/operations.ts:107-114`). The store then runs the strict-path gate, renders and checks the article, looks up the content hash, picks a free path, and writes, stages, and commits under a journal (`writeMemory` at `packages/store/src/store.ts:722-782`). All of that runs inside `exclusive`, which holds the per-process permit and the checkout lock (`packages/store/src/store.ts:1420-1429`). It reindexes only when a file was created, then records a `wrote` session link (`apps/cli/src/operations.ts:350-351`).

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

A caller reads `path`, `created`, `deduped`, `existingPath`, `commitSha`, and `contentHash` (`WriteResult` at `packages/store/src/store.ts:96-106`). Exactly one of `created` and `deduped` is true. On a dedupe, `path` and `existingPath` name the stored file, `commitSha` is null, and nothing is written or committed (`packages/store/src/store.ts:734-744`).

A duplicate is never an error. `ERR_DUPLICATE_CONTENT` is in `ERROR_CODES`, but no code path constructs `DuplicateContent`. The lookup skips stored tasks and archived memories, so a write whose article matches an active non-task memory of any type dedupes onto it (`activePathForHash` at `packages/index/src/traces-persist.ts:196-202`).

`--tag` is declared without `repeatable`, but the dispatch arm reads every occurrence with `list` (`apps/cli/src/run.ts:379`). `--importance` and `--confidence` aren't range-checked (`apps/cli/src/run.ts:381-382`). Without `--strict-path`, an unusable `--path` is replaced by the placement rule and the write still succeeds.

Errors:

- `ERR_SESSION_BOUND` (exit 2) when `MEMHTML_SESSION` is set and the store's `v1Doors` is `closed-in-session` (the default) or `closed`, and `ERR_V1_DOOR_CLOSED` (exit 2) when `v1Doors` is `closed` and no session is set. Nothing is opened (`sessionBoundRefusal` at `apps/cli/src/run.ts:1003-1016`, `v1DoorState` at `apps/cli/src/store-config.ts:111-118`). See [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).
- `ERR_STORE_CONFIG` (exit 1) when the store's `memhtml.config.json` exists and can't be read or doesn't decode (`loadStorePolicy` at `apps/cli/src/store-config.ts:64-93`, `apps/cli/src/run.ts:1719-1720`).
- `ERR_INVALID_MEMORY` (exit 1) when `--strict-path` refuses the path, when the render gate refuses the article (for example an empty `<mark>` from `--claim=`), or when `--type` was given with no value (`strictPathRefusal` at `packages/store/src/store.ts:707-720`, `renderChecked` at `packages/store/src/store.ts:676-683`, `decodeOperatorType` at `apps/cli/src/operations.ts:107-114`).
- `ERR_WRITE_CONFLICT` (exit 1) when an explicit `--path` is occupied and the content isn't already stored. Nothing is written (`WriteConflict` in `freePathFor` at `packages/store/src/store.ts:432-472`). A duplicate dedupes first, so it returns `deduped: true` at the stored path, exit 0 (`packages/store/src/store.ts:734-744`).
- `ERR_STORAGE` (exit 1) when the dedupe lookup or the file write fails, or after 1000 slug collisions, as `write.pathExhausted` (`packages/store/src/store.ts:459-471`).
- `ERR_STORAGE` (exit 1) with operation `checkout.locked` when another writer of the checkout holds `.memhtml/checkout.lock` past the 15 s wait. Nothing is written (`exclusive` at `packages/store/src/store.ts:1420-1423`, `CHECKOUT_LOCK_WAIT_MS` at `packages/contracts/src/checkout-lock.ts:54`).
- `ERR_GIT` (exit 1) from `git hash-object`, `add`, `commit`, or `rev-parse` (`packages/store/src/git.ts:404-435`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` (exit 1) from `reindex`, after the commit landed (`apps/cli/src/operations.ts:267-271`).

Failure: a usage error or a closed door is refused before anything is opened. An unusable `memhtml.config.json` is refused before anything is opened too, and since the file is read ahead of `validate`, `ERR_STORE_CONFIG` answers even a call that has other usage errors (`apps/cli/src/run.ts:1715-1726`). A gate refusal, a dedupe, a conflict, or a lock wait that runs out leaves the tree byte-identical. A git or storage failure during the write is compensated by the journal (`compensated` at `packages/store/src/store.ts:565-577`). A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit and removes its new file from the worktree. A `reindex` failure leaves the memory committed and unindexed, and a retry writes a second copy (see [What a failed write leaves behind](#what-a-failed-write-leaves-behind)). A failure to record the session link is logged and swallowed (`recordLink` at `apps/cli/src/operations.ts:201-218`). Entity extraction runs only in `apply`, so `write` calls no extraction model. `reindex` embeds the new chunks when an embedder is bound, and an embedding failure there is logged and doesn't fail the write (`packages/index/src/indexer.ts:577-584`).

## apply

```
memhtml apply --file ops.jsonl
memhtml apply --file -
memhtml apply -
```

Writes many memories from a JSONL op stream (`batchWrite` at `apps/cli/src/operations.ts:746-893`). It checks the store's `v1Doors` policy first, before the stream is read when the root is known and again in its dispatch arm (`apps/cli/src/run.ts:1715-1726`, `guardV1Door` at `apps/cli/src/run.ts:396`). The whole stream is read and shape-checked before any service is built (`decodeApply` at `apps/cli/src/apply.ts:302-331`, `apps/cli/src/run.ts:2401-2412`). Then the optional assists run, every op is decoded, entities are extracted, and `writeMemories` validates every op before one write, stage, and commit (`writeMemories` at `packages/store/src/store.ts:908-1035`). That store call holds the per-process permit and the checkout lock (`packages/store/src/store.ts:1430`). One `reindex` follows (`apps/cli/src/operations.ts:878`).

Flags:

- `--file` (string): "The JSONL file to read. One complete JSON object per line. Omit it, pass `--file -`, or pass a positional `-` to read the stream from stdin; stdin beside a real --file is refused."
- `--continue-on-error` (boolean, default `false`): "Best-effort: a refused op is reported and skipped while every surviving op lands in the one commit. Atomic by default. The first refused op aborts the batch and nothing is written."
- `--detect-conflicts` (boolean, default `false`): "Report each op's frame-matches as a per-op `conflict`: the ACTIVE memory (or the earlier op) whose claim occupies the same subject-and-relation slot. PROPOSE-ONLY: every op still writes exactly as it would have, because sometimes the contradiction is the answer. You decide: write anyway, `memhtml correct` the match, or drop the line."
- `--detect-near-duplicates` (boolean, default `false`): "Report each op's embedding near-duplicates as a per-op `near_duplicates` list: ACTIVE memories (or earlier ops in this stream) whose text sits at or above cosine 0.92 against this op's claim and body, best first, with the measured similarity. The vector sibling of --detect-conflicts: that flag catches a DIFFERENT value in the same grammatical slot, this one catches a REWORDING of the same fact. PROPOSE-ONLY for the same reason, and the score is geometry — negations also sit above 0.92, so read the paired claim before folding anything. Costs one embedding call per batch; ops written as `article_html` are never checked; when the embedder cannot run (MEMHTML_EMBED=off, or the call failed) the result carries `near_duplicates_degraded: true` and every `near_duplicates` is null, meaning UNCHECKED rather than unique."
- `--session-id` (string): "The Claude Code session for every op that names none. A line's own `session_id` wins over this."
- `--prompt-id` (string): "The prompt within that session."
- `--turn-uuid` (string): "The turn within that session."

Response: `batch.applied`.

A caller reads `results`, `summary`, `commit_sha`, and `near_duplicates_degraded` (`applyPayload` at `apps/cli/src/apply.ts:540-545`). Each result carries `index`, `ok`, `path`, `deduped`, `existing_path`, `code`, `error`, `skipped`, `conflict`, and `near_duplicates`, in input order (`opPayload` at `apps/cli/src/apply.ts:496-538`). `summary` counts `total`, `written`, `deduped`, `failed`, and `skipped` (`summarize` at `apps/cli/src/operations.ts:941-953`). `commit_sha` is null when nothing was committed.

A refused op is data inside the payload. By default the first refused op aborts the batch. Nothing is written, the refused op carries its `code` and `error`, and the rest report `skipped: true`, all at exit 0 (`apps/cli/src/operations.ts:810-818`, `packages/store/src/store.ts:968-980`). With `--continue-on-error` the survivors land in the one commit. The per-op codes are `ERR_INVALID_MEMORY` and `ERR_WRITE_CONFLICT`, mapped by the same `codeFor` every envelope uses (`reportFailure` at `apps/cli/src/operations.ts:484-489`).

A model failure never fails a batch. A failed extraction is logged and the batch is written without extracted entities (`extractor.extract` at `apps/cli/src/operations.ts:840-845`). A failed or disabled embedder sets `near_duplicates_degraded` (`embedder.embed` at `apps/cli/src/operations.ts:649-661`).

On a line that carries both `body` and `article_html`, nothing refuses the pair. The article is written and the body is dropped (`apps/cli/src/apply.ts:261-280`, `articleHtmlFor` at `packages/html/src/template.ts:125-128`). `status` and `due` on a non-task op are ignored (`toWriteInput` at `apps/cli/src/operations.ts:299-312`).

Errors:

- `ERR_SESSION_BOUND` (exit 2) when `MEMHTML_SESSION` is set and the store's `v1Doors` is `closed-in-session` (the default) or `closed`, and `ERR_V1_DOOR_CLOSED` (exit 2) when `v1Doors` is `closed` and no session is set. Nothing is opened (`sessionBoundRefusal` at `apps/cli/src/run.ts:1003-1016`, `v1DoorState` at `apps/cli/src/store-config.ts:111-118`). See [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).
- `ERR_STORE_CONFIG` (exit 1) when the store's `memhtml.config.json` exists and can't be read or doesn't decode (`loadStorePolicy` at `apps/cli/src/store-config.ts:64-93`, `apps/cli/src/run.ts:1719-1720`).
- `ERR_INVALID_FLAG` (exit 2) for a positional `-` beside a real `--file` (`applyFlags` at `apps/cli/src/run.ts:820-830`), and for a line that isn't a JSON object, an unknown field, an `op` other than `write`, or a field of the wrong type (`lineError` at `apps/cli/src/apply.ts:83-88`).
- `ERR_MISSING_ARGUMENT` (exit 2) for a line without `op`, `title`, or `type`, or a stream with no ops (`apps/cli/src/apply.ts:128-130`, `apps/cli/src/apply.ts:202-208`, `apps/cli/src/apply.ts:316-328`).
- `ERR_PATH_NOT_FOUND` (exit 2) when `--file` can't be read (`applyText` at `apps/cli/src/apply.ts:450-466`).
- `ERR_STORAGE` or `ERR_GIT` (exit 1) from the dedupe lookup, placement, write, stage, or commit of the batch.
- `ERR_STORAGE` (exit 1) with operation `checkout.locked` when another writer of the checkout holds `.memhtml/checkout.lock` past the 15 s wait. Nothing is written (`exclusive` at `packages/store/src/store.ts:1420-1423`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` (exit 1) from `reindex`, after the commit landed.

Failure: a bad stream, a closed door, or an unusable policy file is refused before any database or git command runs. When the root is known before the layer, the door and the policy file are judged before the stream is read. An atomic abort writes nothing, and so does a lock wait that runs out. A git or storage failure during the write pass is compensated by one journal over every path the pass reached (`makeJournal` at `packages/store/src/store.ts:998-1014`). A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit and removes the batch's new files from the worktree. A `reindex` failure after the commit replaces the whole payload with an error envelope, so the caller never sees the per-op paths, and a blind retry writes every op again under `-2` paths.

The atomicity covers one call. It's one validation pass, one journal, and one commit, made in one hold of the per-process permit and the checkout lock (`packages/store/src/store.ts:1420-1430`). The assists and the entity extraction run before that hold, and `reindex` runs after it.

## read

```
memhtml read <path>
```

Reads one memory file from the working tree, parses it, and returns it (`readMemory` at `apps/cli/src/operations.ts:968-975`, `readMemory` at `packages/store/src/store.ts:1037-1043`). It reads uncommitted edits too, and doesn't consult the index.

Arguments:

- `<path>` (required): "Repo-root-relative path to the memory."

Flags:

- `--session-id` (string): "Records a `read` session link, so provenance is queryable both ways."
- `--prompt-id` (string): "The prompt within that session."
- `--turn-uuid` (string): "The turn within that session."

Response: `memory.detail`.

A caller reads `path`, `title`, `metas`, `entities`, `tags`, `links`, `gist`, `body`, `html`, `archived`, and `warnings` (`apps/cli/src/run.ts:407-426`). `archived` is true when the `status` meta is `archived`. `warnings` lists the file's format warnings.

`read` isn't read-only. A successful read bumps the path's access row in `state.db`, at most once per 900 seconds (`bumpAccess` at `apps/cli/src/operations.ts:1023-1035`, `REINFORCE_COOLDOWN_S` at `packages/domain/src/ranking.ts:24`). With `--session-id` it also inserts a `read` row into `memory_session_links` in `index.db` (`recordLink` at `apps/cli/src/operations.ts:201-218`). `--prompt-id` and `--turn-uuid` are ignored without `--session-id`. Neither write takes the checkout lock, and `read` never reads the store's policy file (`apps/cli/src/store-config.ts:38-43`).

Errors:

- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at the path. The suggestions start with `memhtml resolve` (`PathNotFound` in `SUGGESTIONS` at `apps/cli/src/errors.ts:188-199`).
- `ERR_INVALID_MEMORY` (exit 1) when the file doesn't parse. The message lists the violations.

Failure: a refused read writes nothing beyond the layer build's own side effect. Both bookkeeping writes swallow their failures as stderr warnings, so a locked `state.db` delays the read and then returns it at exit 0 (`bumpAccess` at `apps/cli/src/operations.ts:1023-1035`).

## search

```
memhtml search <query> [--limit 10]
```

Runs a ranked search over the SQLite index (`searchMemories` at `apps/cli/src/operations.ts:994-998`, `layerRetrieval` at `apps/cli/src/api-layer.ts:320-336`). The full-text, vector, recency, and salience arms are fused by reciprocal rank. A polarity step re-scores the fused pool, and MMR picks the final hits (`search` at `packages/index/src/retrieval.ts:506-598`). The vector arm runs only when the share of chunks with a vector in the configured space clears the coverage floor (`gatedQueryVector` at `packages/index/src/retrieval.ts:308-320`).

The command always reads the index. The MCP server's `memory_search` asks a running head server first and falls back to this same retrieval (`apps/mcp/src/handlers.ts:581`, `searchOnHead` at `apps/cli/src/head-retrieval.ts:128-165`), and `memhtml head search` searches the head itself. `session commit` doesn't reindex, so a record a session landed reaches this answer after the next `memhtml index update`, or after the next v1 write, whose `reindex` diffs from the watermark (`sessionCommit` at `apps/cli/src/v2.ts:1099`, `reindex` at `apps/cli/src/operations.ts:267-271`).

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

A caller reads `hits`, each with `path`, `title`, `gist`, `memoryType`, `score`, `confidence`, `updatedAt`, `snippet`, `entities`, and `supersededBy` (`packages/index/src/retrieval.ts:560-597`). Beside them are `degraded` (no query vector), `vectorCoverage`, `arms`, `entityScope`, `scopeEmpty`, `archivedMatches`, and `archived`. The last two are `0` and empty unless a scope matched nothing outside `--as-of` (`packages/index/src/retrieval.ts:549-558`). `score` is `1 / rank` in the fused order, lowered for a polarity-flipped twin (`polarityScored` at `packages/index/src/polarity.ts:78-109`).

The seven flags before `--limit` are `SCOPE_FLAGS`, shared with `recall` (`apps/cli/src/commands.ts:126-173`). `--type` takes the nine writable types, so `--type arc` is refused at exit 2. An unscoped search excludes tasks only, and `--type task` opts them in (`assembleScope` at `packages/index/src/scope.ts:236-280`).

A `--facet` without `=`, or with an empty half, is dropped silently and the search runs unscoped on that axis (`parseFacetFilters` at `packages/index/src/scope.ts:57-70`). `--entity` is trimmed and case-folded on both sides (`packages/index/src/scope.ts:309-313`). `--limit` has no clamp, and `0` or a negative value returns no hits (`applyMmr` at `packages/domain/src/mmr.ts:36-41`).

A query that matches no term still returns hits, because the recency and salience arms need no term.

Errors:

- `ERR_STORAGE` (exit 1) from a database read. It's the only runtime code. An embedder failure sets `degraded: true` and the search still answers, and a stale index answers for the commit it describes.

Failure: `search` writes nothing, and it doesn't bump access either. `searchMemories` calls retrieval and nothing else (`apps/cli/src/operations.ts:994-998`). It reads in several statements with no snapshot, so a path removed between two of them drops out of the answer.

## recall

```
memhtml recall <query> [--budget 16000]
```

Builds a disclosure pack under a character budget (`recall` at `packages/index/src/retrieval.ts:600-652`). It runs the same coverage gate and fusion as `search` over a fixed pool of 30 candidates, with the polarity step and no MMR. Arcs fold under their own fixed 9000-character budget and every other memory under `--budget` (`ARC_BODY_BUDGET` at `packages/index/src/disclosure.ts:20`). Like `search`, the command always reads the index. The MCP server's `memory_recall` asks a running head server first (`apps/mcp/src/handlers.ts:619`).

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

A caller reads `arcs` and `memories`, each with `disclosed`, `indexLines`, `spentChars`, and `truncated`, plus top-level `spentChars`, `truncated`, `degraded`, and `vectorCoverage` (`packages/index/src/retrieval.ts:644-651`). A disclosed entry carries `path`, `title`, `gist`, `memoryType`, and `body`. An index line carries the same fields without `body` (`foldDisclosure` at `packages/index/src/disclosure.ts:93-134`). A candidate becomes an index line when its body doesn't fit what's left of the budget, or when two quoted memories already share one of its entity names (`MAX_PER_ENTITY` at `packages/index/src/disclosure.ts:32`).

The scope flags behave as on `search`. `--type arc` is refused here too, although the pack has an arc envelope. `--budget` has no clamp, and `0` turns every hit into an index line.

Errors:

- `ERR_STORAGE` (exit 1), as on `search`.

Failure: `recall` writes nothing. An embedder failure degrades the pack, and the call still answers.

## correct

```
memhtml correct <target> --title <title> --claim <sentence>
memhtml correct <target> --title <title> --article-html <markup>
```

Supersedes a memory (`correctMemory` at `apps/cli/src/operations.ts:1062-1090`). The dispatch arm checks the store's `v1Doors` policy first (`guardV1Door` at `apps/cli/src/run.ts:450`). The operation reads the target, defaults the new type to the target's, renders the new article, and places it. The store counts the target's own path as vacated only for an explicit path, and the CLI passes none (`freePathFor` at `packages/store/src/store.ts:432-472`). Then, under one journal, it archives the target with its stamps, writes the new file with a `supersedes` link to the archive path, and makes one commit (`correctMemory` at `packages/store/src/store.ts:1045-1144`). The target's stamps include `memhtml-superseded-by`, and a `memhtml-valid-until` unless it already states an earlier one. The new file gets a `memhtml-valid-from` when it states none (`packages/store/src/store.ts:1094-1127`). The operation then reindexes and records a `corrected` session link.

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

A caller reads `path`, `archivedPath`, `commitSha`, and `contentHash` (`CorrectResult` at `packages/store/src/store.ts:160-167`).

The correction inherits the type and nothing else. The operation passes no workspace, tags, entities, importance, confidence, task status, due date, or links, so placement comes from the type and the new title (`apps/cli/src/operations.ts:1070-1083`). A correction of a `projects/<ws>/` memory can land in `areas/inbox/`.

`--reason` is accepted and recorded nowhere. The store never reads it, and the commit subject is built from the title (`packages/store/src/store.ts:1131`).

There's no dedupe on this path. A correction whose article matches another active memory, tasks aside, commits, and every later reindex fails until one copy is archived (`files_content_hash_active` at `packages/index/migrations/0008_tasks.sql:126-127`). See [What a failed write leaves behind](#what-a-failed-write-leaves-behind).

Errors:

- `ERR_SESSION_BOUND` (exit 2) when `MEMHTML_SESSION` is set and the store's `v1Doors` is `closed-in-session` (the default) or `closed`, and `ERR_V1_DOOR_CLOSED` (exit 2) when `v1Doors` is `closed` and no session is set (`sessionBoundRefusal` at `apps/cli/src/run.ts:1003-1016`). Nothing is opened. See [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).
- `ERR_STORE_CONFIG` (exit 1) when the store's `memhtml.config.json` exists and can't be read or doesn't decode (`loadStorePolicy` at `apps/cli/src/store-config.ts:64-93`, `apps/cli/src/run.ts:1715-1723`).
- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at `<target>`.
- `ERR_INVALID_MEMORY` (exit 1) when the target doesn't parse, or when the new article fails the render gate or the parse that reads its valid-from (`renderChecked` and `validFromOf` at `packages/store/src/store.ts:1062-1070`).
- `ERR_GIT` (exit 1) when `git mv` finds the archive path taken, which happens when a file at the same path was archived earlier the same year. The journal restores the tree.
- `ERR_STORAGE` (exit 1) with operation `checkout.locked` when another writer holds the checkout lock through the whole 15-second wait. The store step runs under that lock, so nothing is written (`exclusive` at `packages/store/src/store.ts:1419-1423`).
- `ERR_STORAGE` or `ERR_GIT` (exit 1) during the write, and the three `reindex` codes after the commit.

Failure: a door refusal and everything before the journal leave the tree byte-identical. A failure under the journal restores the target and removes the new file, and an empty archive year directory can remain. The `state.access` row already moved to the archive path isn't restored (`hooks.onMove` at `packages/store/src/store.ts:611`). A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit, puts the target back at its old path, and removes the archive copy and the new file from the worktree. After the commit, a retry fails with `ERR_PATH_NOT_FOUND` because the target moved, so it can't duplicate.

## link

```
memhtml link <src> <rel> <dst>
```

Adds an authored `<link>` to the source file and commits it (`linkMemories` at `apps/cli/src/operations.ts:1099-1109`). The rel is decoded first. The store refuses a self-link, reads both files' types to check the endpoint classes, adds the link, and commits only if the file changed (`linkMemories` at `packages/store/src/store.ts:1323-1358`). It reindexes only after a commit. `link` creates no record, so it isn't one of the v1 record doors, and neither `v1Doors` nor a broken `memhtml.config.json` stops it (`RECORD_CREATING_V1_COMMANDS` at `apps/cli/src/doors.ts:44-76`).

Arguments:

- `<src>` (required): "The asserting memory or task."
- `<rel>` (required): "One of: supersedes, contradicts, caused_by, leads_to, part_of, relates_to, example_of, supports, laterally_related, blocks, subtask_of. A task rel needs two tasks; a memory rel refuses a task endpoint."
- `<dst>` (required): "The memory or task being pointed at."

Response: `memory.linked`.

A caller reads `commitSha`, `srcPath`, `dstPath`, and `rel` (`apps/cli/src/operations.ts:1108`). A null `commitSha` means the same rel and href were already present, or the source had no head to insert into (`addLink` at `packages/html/src/editors.ts:226-238`, `packages/store/src/store.ts:1343`).

The rel vocabulary is `AUTHORABLE_RELS`, the nine `MEMORY_RELS` plus the two `TASK_RELS`, `blocks` and `subtask_of` (`AUTHORABLE_RELS` at `apps/cli/src/operations.ts:124`, `TASK_RELS` at `packages/contracts/src/edges.ts:54`). A task rel needs two tasks, and a memory rel refuses a task endpoint (`requireEndpointClasses` at `packages/store/src/store.ts:1279-1311`).

The idempotence is an exact match on rel and href, where href is `/` plus the normalized `<dst>` (`packages/html/src/editors.ts:231-235`). Normalizing strips leading slashes, doubled slashes, and a trailing slash, and nothing else (`normalizePath` at `packages/contracts/src/paths.ts:57-60`). So a `<dst>` spelled with a `./` segment is a different href. It adds a second link, and the source then fails the format check, which refuses a `.` segment in an href (`isRootRelativeHref` at `packages/html/src/constraints.ts:99-107`).

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a rel outside the vocabulary, a self-link, or an endpoint class mismatch (`decodeAuthorableRel` at `apps/cli/src/operations.ts:140-147`, `packages/store/src/store.ts:1331-1337`).
- `ERR_PATH_NOT_FOUND` (exit 1) when either endpoint has no file.
- `ERR_STORAGE` (exit 1) with operation `checkout.locked` when another writer holds the checkout lock through the whole 15-second wait. Nothing is written (`exclusive` at `packages/store/src/store.ts:1419-1435`).
- `ERR_STORAGE` or `ERR_GIT` (exit 1) during the write, and the three `reindex` codes after the commit.

Failure: a refused link writes nothing. A failure under the journal restores the source's bytes. A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit and puts the pre-link bytes back in the worktree. After a commit followed by a failed `reindex`, a retry finds the link present, returns a null `commitSha`, and skips `reindex`, so the index stays without the edge until the next `index update`.

## neighbors

```
memhtml neighbors <path> [--depth 1] [--limit 200] [--rel <rel>]...
```

Returns the memory graph around one path, one or two hops out, from one SQL statement over `edges` of class `memory` (`neighborsQuery` at `apps/cli/src/operations.ts:1210-1259`). Rows fold to one node per path at its nearest hop (`neighborsOf` at `apps/cli/src/operations.ts:1290-1384`).

Arguments:

- `<path>` (required): "The center of the neighborhood."

Flags:

- `--depth` (int, default `1`): "1 or 2. Never more."
- `--limit` (int, default `200`): "Distinct nodes to return, clamped to 200. `nodesDropped` counts the paths the walk reached and this limit turned away, and `scanSaturated` says the walk stopped at its own 10000-row cap, which no limit recovers."
- `--rel` (string, repeatable, one of `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related`): "Restrict to these rels. Repeatable."

Response: `memory.neighbors`.

A caller reads `center`, `depth`, `limit`, `nodes` (each with `path`, `title`, `hop`, `rel`, and `derived`), `edges`, `nodesDropped`, and `scanSaturated` (`apps/cli/src/operations.ts:1364-1383`). `depth` and `limit` echo the clamped values. `edges` is the count of distinct edges the walk enumerated. `nodesDropped` counts the paths the walk reached and the limit turned away. `scanSaturated` is true when the statement hit its own 10000-row cap, which no limit recovers.

`derived` is true when any edge reaching the node is a derived edge, a row with a stored derived provenance. No command in this build writes one, and a rebuild empties `edges`, so `derived` is `false` on any index this build rebuilt (`packages/index/migrations/0008_tasks.sql:184-200`, `MEMORY_TABLES` at `packages/index/src/schema-const.ts:51-60`).

`--depth` is clamped to 1 or 2, and `--limit` is clamped to 1 through `NEIGHBORS_LIMIT`, 200 (`apps/cli/src/operations.ts:1166`, `apps/cli/src/operations.ts:1294-1298`). Neither is refused. Archived nodes are included.

Errors:

- `ERR_STORAGE` (exit 1). A center with no file isn't an error. The walk still follows any indexed edge that names the path, so a dangling link to a moved path still shows its source as a node.

Failure: `neighbors` writes nothing, and its one statement is one consistent read.

## resolve

```
memhtml resolve <path>
```

Follows a possibly moved path forward to the memory that holds the fact now (`resolveMemory` at `apps/cli/src/operations.ts:1539-1604`). At each hop, a path with no `files` row follows the newest archive row whose `origin_path` matches it. A path with a `files` row, live or archived, follows the newest authored `supersedes` edge pointing at it (`resolveQueries` at `apps/cli/src/operations.ts:1492-1499`). The walk stops after `RESOLVE_MAX_HOPS`, 16 hops (`apps/cli/src/operations.ts:1394`).

Arguments:

- `<path>` (required): "The path a receipt, citation, or older answer recorded."

Response: `memory.resolved`.

A caller reads `requested`, `path`, `hops`, `steps` (each `from`, `to`, and `via`), `stopReason`, `title`, and `indexedCommit` (`apps/cli/src/operations.ts:1595-1603`). `stopReason` is one of `live`, `archived`, `unindexed`, `cycle`, and `hop_limit`, and only `live` means `path` is citable (`RESOLVE_STOP_REASONS` at `apps/cli/src/operations.ts:1419`). `via` is `supersedes` or `archive_move` (`RESOLVE_STEP_VIA` at `apps/cli/src/operations.ts:1429`).

The answer describes the commit named in `indexedCommit`, which can trail HEAD. `unindexed` can mean the path never existed, or that the index hasn't seen the commit holding it, such as a record a session commit landed before the next `index update`.

`hops: 0` with `live` doesn't mean the bytes are unchanged, because several writes edit a file in place at its own path. `link` adds its `<link>` to the source file (`packages/store/src/store.ts:1347-1356`). `task status` to any status but `done` rewrites the task's status and updated metas (`apps/cli/src/operations.ts:2009-2028`). `doctor --fix` rewrites or drops a dangling link in the file that holds it (`apps/cli/src/doctor.ts:484-509`). A session commit's `link`, `unlink`, `label`, and `unlabel` ops rewrite the file they name, and `session exec` harvests an edit to an existing file into those ops (`stage` at `packages/session/src/commit.ts:112-174`, `apps/cli/src/session-exec.ts:305-313`). A path that an archive or a correction vacated can also be taken again by a later write with the same title and placement, and `resolve` then answers that later file at `hops: 0` (`apps/cli/src/operations.ts:1552-1571`).

A CLI correction always lands at a new path. `correct` passes no path, so the target is still on disk when the slug is chosen, and one that keeps its title and placement takes the next `-N` suffix, such as `-2` (`freePathFor` at `packages/store/src/store.ts:432-472`).

Errors:

- `ERR_STORAGE` (exit 1). An unknown path is `stopReason: "unindexed"` at exit 0.

Failure: `resolve` writes nothing. It reads the watermark and then one or two statements per hop, with no snapshot across them.

## archive

```
memhtml archive <path> --reason <reason>
```

Soft-evicts a memory (`archiveMemory` at `apps/cli/src/operations.ts:1112-1120`). The store reads the file, then under a journal moves it with `git mv` into `archive/<YYYY>/<path>`, writes the archive stamps, stages it, mirrors the access row, and commits (`archiveMemory` at `packages/store/src/store.ts:1146-1172`). The store step runs under the checkout lock (`exclusive` at `packages/store/src/store.ts:1419-1433`). The operation reindexes after the commit.

Arguments:

- `<path>` (required): "The memory to archive."

Flags:

- `--reason` (string, required): "Why it was evicted."

Response: `memory.archived`.

A caller reads `path`, `archivePath`, and `commitSha` (`ArchiveResult` at `packages/store/src/store.ts:170-174`).

`--reason` appears only in the commit subject, `memhtml(archive): <path> — <reason>` (`packages/store/src/store.ts:1166`). The `<path> — <reason>` part is cut to 72 characters, so a long path can leave no trace of the reason (`commitSubject` at `packages/store/src/plumbing.ts:393-398`). It isn't stamped into the file. The file isn't parsed, so an archived path archives again into a nested `archive/<YYYY>/archive/<YYYY>/`.

Errors:

- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at the path.
- `ERR_GIT` (exit 1) when the archive path is taken by an earlier eviction of the same path in the same year. The journal restores the tree.
- `ERR_STORAGE` (exit 1) with operation `checkout.locked` when another writer holds the checkout lock through the whole 15-second wait. Nothing is written.
- `ERR_STORAGE` or `ERR_GIT` (exit 1) during the move or commit, and the three `reindex` codes after the commit.

Failure: a refusal writes nothing. A failure under the journal puts the file back, but the `state.access` row already moved to the archive path isn't restored (`makeJournal` at `packages/store/src/store.ts:1155-1169`, `hooks.onMove` at `packages/store/src/store.ts:611`). A restore that itself fails is logged and leaves the tree dirty. A failure after the commit landed keeps the commit, puts the file back at its old path, and removes the archive copy from the worktree. A failure to mirror the access row is logged only (`onMove` at `apps/cli/src/api-layer.ts:197-205`). After the commit, a retry fails with `ERR_PATH_NOT_FOUND`.

## reinforce

```
memhtml reinforce <path> [<path>...] [--signal neutral]
```

Bumps access bookkeeping in `state.db` for each distinct path (`reinforceMemories` at `apps/cli/src/operations.ts:1123-1133`). One upsert per 500 paths carries the cooldown in its `WHERE` clause, and `RETURNING` reports which paths were bumped (`packages/index/src/reinforce.ts:69-120`). No file is touched and nothing is committed, so it takes no checkout lock.

Arguments:

- `<path>` (required, repeatable): "A memory path. Repeat the argument for more."

Flags:

- `--signal` (string, default `"neutral"`, one of `positive`, `negative`, `neutral`): "`neutral` bumps access without claiming the memory was right."

Response: `memory.reinforced`.

A caller reads `bumped`, `cooledDown`, and `signal` (`apps/cli/src/operations.ts:1131-1132`). The signal vocabulary is `REINFORCE_SIGNALS` (`packages/domain/src/reinforce.ts:31`).

The cooldown is 900 seconds per path, `REINFORCE_COOLDOWN_S` (`packages/domain/src/ranking.ts:24`). It's enforced inside the SQL statement, so it holds across processes. `read` bumps the same row, so a `read` followed within the cooldown by `reinforce --signal positive` drops the signal. Paths are neither checked against the tree nor normalized, so a path with no file gets its own row.

Errors:

- `ERR_STORAGE` (exit 1) from the upsert.

Failure: each 500-path slice is its own statement, so a failure in a later slice keeps the earlier slices applied. A retry inside the cooldown reports those paths in `cooledDown`.

## list

```
memhtml list [--type <type>] [--para <bucket>] [--limit 50] [--cursor <path>]
```

Pages through `files` with one `SELECT`, keyset-paginated on `path` (`listMemories` at `apps/cli/src/operations.ts:1631-1726`). `files` holds only memory files, the `.html` files under the four PARA buckets other than `index.html` and `sitemap.xml`. The store's `memhtml.config.json`, its root `README.html`, and everything under `.memhtml/` never appear (`isIndexablePath` at `packages/index/src/indexer.ts:243-251`).

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

A caller reads `files`, each with `path`, `title`, `memoryType`, `gist`, `workspace`, `para`, `confidence`, `importance`, `archived`, and `updatedAt`, and `nextCursor` (`apps/cli/src/operations.ts:1711-1725`). The field is `nextCursor`, although the flag description says `next_cursor`. A null `nextCursor` means the last page.

`--limit` is clamped to 1 through 500 without saying so (`listMemories` at `apps/cli/src/operations.ts:1634`). A `--cursor` that names no real path is still applied as a bound. Tasks are listed by default. `--para archive` returns nothing without `--include-archived`, because an archived memory is one whose bucket is `archive`. `--tag`, `--entity`, and `--workspace` keep the last occurrence, and only `--facet` composes. `--entity` is trimmed and case-folded on both sides, as on `search` (`apps/cli/src/operations.ts:1658-1668`).

Errors:

- `ERR_STORAGE` (exit 1).

Failure: `list` writes nothing. Each page is one statement, so its `nextCursor` agrees with its rows. Across pages, a row never repeats, but a row that moves behind the cursor is skipped.

## entity activity

```
memhtml entity activity [--type <entity-type>] [--limit 50] [--include-archived]
```

Every stored entity reference with its file count and last activity, newest first, from one `GROUP BY` over `file_entities` joined to `files` (`entityActivityQuery` at `apps/cli/src/operations.ts:1814-1856`, `entityActivity` at `apps/cli/src/operations.ts:1896-1927`).

Flags:

- `--type` (string): "Restrict to one entity type, e.g. `service`. The half before the colon in a `type:name` reference."
- `--limit` (int, default `50`): "Rows to return, 1 to 500. An ask outside that is clamped into it rather than refused, and `limit` echoes the bound the answer was built under. `entityCount` is the total matching the scope, so a clamped answer is visible."
- `--include-archived` (boolean, default `false`): "Aggregate archived memories too. Excluded by default: eviction is a `git mv`, so an archived memory still exists and would otherwise keep an entity looking active."

Response: `entity.activity`.

A caller reads `entities`, `entityCount`, and `limit`. Each row has `entity`, `entityType`, `entityName`, `fileCount`, `lastActivityAt`, `lastEventAt`, and `lastWrittenAt` (`apps/cli/src/operations.ts:1910-1926`). `lastActivityAt` is `max(coalesce(event_at, updated_at))`, the recency arm's rule. `lastEventAt` is `max(event_at)` and can be null. `lastWrittenAt` is `max(updated_at)`. `entityCount` counts every match before the limit, so a clamped answer shows.

The limit is clamped to 1 through `ENTITY_ACTIVITY_MAX`, 500 (`apps/cli/src/operations.ts:1743`). There's no cursor, so a corpus with more than 500 entities can't be fully listed here. `--type` is trimmed and matched without case (`apps/cli/src/operations.ts:1826-1837`). A row is one stored spelling, so `Checkout-API` and `checkout-api` are two rows. Tasks are counted.

Errors:

- `ERR_STORAGE` (exit 1).

Failure: `entity activity` writes nothing, and its one statement is one consistent read. It doesn't read `state.db`.

## task add

```
memhtml task add --title <title> [--status todo] [--due <iso>]
```

Opens a task. It checks the store's `v1Doors` policy first, once before validation when the root is known and again in the dispatch arm (`apps/cli/src/run.ts:1715-1726`, `guardV1Door` at `apps/cli/src/run.ts:539`). The arm then calls `writeMemory` with type `task` and the claim defaulting to the title, so the store path is the one `write` takes (`apps/cli/src/run.ts:537-570`). The status and due date are decoded only for tasks (`apps/cli/src/operations.ts:306-313`).

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

A caller reads `path`, `created`, `deduped`, `existingPath`, `taskStatus`, `dueAt`, and `commitSha` (`apps/cli/src/run.ts:556-568`). `taskStatus` and `dueAt` echo the flags. They aren't read back from the file.

Two tasks are never deduped against each other, so every retry opens a new `-N` file. The single-write path still asks the dedupe question, though, and the lookup excludes stored tasks and archived memories (`activePathForHash` at `packages/index/src/traces-persist.ts:196-203`). So a task whose article matches an active non-task memory returns that memory's path with `deduped: true`, and no task is written (`writeMemory` at `packages/store/src/store.ts:722-744`). `--status done` opens a task that isn't archived. `task status <path> done` then reports `unchanged: true` and archives nothing, because the `unchanged` return comes first (`apps/cli/src/operations.ts:1999-2007`). Use `memhtml archive` to close it.

Errors:

- `ERR_SESSION_BOUND` (exit 2) when `MEMHTML_SESSION` is set and the store's `v1Doors` is `closed-in-session` (the default) or `closed`, and `ERR_V1_DOOR_CLOSED` (exit 2) when `v1Doors` is `closed` and no session is set (`sessionBoundRefusal` at `apps/cli/src/run.ts:1003-1016`, `v1DoorState` at `apps/cli/src/store-config.ts:111-118`). Nothing is opened. See [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).
- `ERR_STORE_CONFIG` (exit 1) when the store's `memhtml.config.json` exists and can't be read or doesn't decode (`loadStorePolicy` at `apps/cli/src/store-config.ts:64-93`, `apps/cli/src/run.ts:1719-1720`).
- `ERR_INVALID_MEMORY` (exit 1) for a `--due` outside `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ssZ`, or a render-gate refusal (`decodeDueAt` at `apps/cli/src/operations.ts:167-174`).
- The other write and `reindex` codes of `write`, except `ERR_WRITE_CONFLICT`, which only an explicit `--path` can raise (`freePathFor` at `packages/store/src/store.ts:432-472`). `task add` has no `--path`.

Failure: as `write`. The store write runs inside `exclusive`, so a `checkout.locked` refusal comes before the render and leaves the tree as it was (`packages/store/src/store.ts:1429`).

## task status

```
memhtml task status <path> <status> [--reason <reason>]
```

Moves a task's status (`setTaskStatus` at `apps/cli/src/operations.ts:1976-2059`). It decodes the status, parses the file, refuses a non-task, and returns early when the status is unchanged. Otherwise it stamps the head metas `memhtml-task-status` and `memhtml-updated`. For `todo`, `doing`, and `blocked` it writes the file, stages it, and commits inside `store.exclusive`, which holds the per-process permit and the checkout lock, and then reindexes (`apps/cli/src/operations.ts:2020-2030`, `exclusive` at `packages/store/src/store.ts:1420-1423`). For `done` it writes the stamped file and then archives the task through `archiveMemory`, which takes the lock for the move and the commit, with the reason `--reason` or `task done`, and then reindexes (`apps/cli/src/operations.ts:2048-2050`). No `v1Doors` mode closes it, because it edits an existing record and creates none (`apps/cli/src/doors.ts:9-13`).

Arguments:

- `<path>` (required): "The task file."
- `<status>` (required): "One of: todo, doing, blocked, done."

Flags:

- `--reason` (string): "Why it closed. Recorded on the archive commit when the status is `done`."

Response: `task.updated`.

A caller reads `path`, `taskStatus`, `archived`, `archivePath`, `commitSha`, and `unchanged` (`TaskStatusResult` at `apps/cli/src/operations.ts:1947-1956`, `apps/cli/src/run.ts:579`). `--reason` is used only for `done`, and only in the archive commit subject, where the path and the reason share a 72-character budget, path first. A long path can leave no trace of the reason (`commitSubject` at `packages/store/src/plumbing.ts:393-398`).

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a status outside `TASK_STATUSES`, a file that isn't a task, or a file that doesn't parse (`decodeTaskStatus` at `apps/cli/src/operations.ts:150-157`, `apps/cli/src/operations.ts:1986-1992`).
- `ERR_PATH_NOT_FOUND` (exit 1) when no file is at the path (`readRaw` at `packages/store/src/store.ts:483-488`).
- `ERR_STORAGE` (exit 1) as `task.write:<path>`, and `ERR_GIT` (exit 1) from `add`, `commit`, or the archive move.
- `ERR_STORAGE` (exit 1) as `checkout.locked` when another writer of the checkout holds `.memhtml/checkout.lock` for the whole 15 s wait (`withCheckoutLock` at `packages/store/src/checkout-lock.ts:39-44`).
- The three `reindex` codes after the commit.

Failure: for `todo`, `doing`, and `blocked`, a `checkout.locked` failure comes before the write and leaves the file as it was. The stamp write isn't journaled, so a failed stage or commit leaves the file modified and possibly staged (`apps/cli/src/operations.ts:2014-2029`). The next v1 write's commit then includes a staged stamp, because `commit` commits the whole index (`commit` at `packages/store/src/git.ts:453-472`). For `done`, the stamp is written before `archiveMemory` takes the lock, and the archive journal records the already-stamped bytes. A failed archive, `checkout.locked` included, leaves the stamped file in place and unstaged. When the failure comes after the move, the `state.access` row already moved to the archive path isn't restored (`stageArchive` at `packages/store/src/store.ts:584-613`). A retry after a landed commit reports `unchanged: true` for a non-`done` status and `ERR_PATH_NOT_FOUND` for `done`.

## task list

```
memhtml task list [--status <status>] [--workspace <ws>] [--due-before <iso>] [--detected] [--limit 50] [--cursor <path>]
```

`task list` reads the task working set with one `SELECT` over `files` where the type is `task`, with a correlated `blockedBy` subquery over task `blocks` edges, keyset-paginated on `path` (`listTasks` at `apps/cli/src/operations.ts:2148-2237`). It never runs ranked retrieval.

Flags:

- `--status` (string, one of `todo`, `doing`, `blocked`, `done`): "One task status."
- `--workspace` (string): "One workspace."
- `--due-before` (string): "An ISO date. Returns tasks due strictly before it, by calendar day."
- `--limit` (int, default `50`): "Rows per page."
- `--cursor` (string): "The `next_cursor` from the previous page: the last path returned."
- `--include-archived` (boolean, default `false`): "Include finished tasks. `done` archives, so they are otherwise absent."
- `--detected` (boolean, default `false`): "Only machine-detected tasks (a `det-<digest>-` filename), never ones opened by hand. Each is a proposal carrying the evidence it was detected from."

Response: `task.list`.

A caller reads `tasks`, each with `path`, `title`, `taskStatus`, `dueAt`, `workspace`, `archived`, `updatedAt`, and `blockedBy`, and `nextCursor` (`apps/cli/src/operations.ts:2222-2236`).

`--due-before` compares the first ten characters, so it's strictly before by calendar day, and it drops tasks with no due date. `--detected` adds a case-sensitive `GLOB` on the path. It keeps a task whose file name is `det-`, twelve lowercase hex digits, a hyphen, and any stem ending in `.html`, in any directory, so an archived one under `archive/<year>/` matches too (`DETECTED_TASK_GLOB` at `apps/cli/src/operations.ts:2109`). That's the name `detectedTaskPath` builds from a detector's key (`apps/cli/src/detected-tasks.ts:52-66`). No command in this build calls it, so the filter finds only tasks some other writer filed under that name. `--limit` is clamped to 1 through 500 silently (`apps/cli/src/operations.ts:2151`). A bogus `--cursor` behaves as on `list`.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) for a `--due-before` outside the two datetime forms, raised after the layer is built (`decodeDueAt` at `apps/cli/src/operations.ts:2166`).
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

A caller reads `mode: "rebuild"`, `headSha`, `filesIndexed`, `chunksIndexed`, `edgesIndexed`, `embeddingsWritten`, `embeddingsPreserved`, and `skipped` (`indexer.rebuild` at `apps/cli/src/run.ts:596-604`, `packages/index/src/indexer.ts:663-671`). `embeddingsPreserved` counts the stored vectors whose chunk came back with the same id.

A rebuild keeps its vectors only in the configured space. `truncateForRebuild` stashes the `embeddings` rows of that space in a temporary table and deletes the memory tables in one transaction (`packages/index/src/indexer.ts:398-416`). After the projections land it re-inserts every stashed row whose chunk id exists again (`packages/index/src/indexer.ts:426-437`). On a model change the stash is empty and every old vector is gone.

The truncate deletes every `edges` row, and the reprojection writes back only the authored edges each file's `<link rel="memhtml-*">` elements state, with `derived = 0` (`MEMORY_TABLES` at `packages/index/src/schema-const.ts:51-60`, `authoredEdgesFor` at `packages/index/src/project.ts:352-370`). Derived edges (`derived = 1`) exist only in the index, and no command in this build writes them. So a rebuild drops every derived edge for good. An `index update` keeps them, because a file's reprojection deletes only its own `derived = 0` edges (`packages/index/src/project.ts:241`). A source file that leaves the corpus takes all its edges with it (`deletePath` at `packages/index/src/indexer.ts:740-743`).

Errors:

- `ERR_REBUILD_NO_EMBED_REFUSED` (exit 1) when the rebuild can't write vectors, because of `--no-embed` or because no embedder is bound, over a store that has any stored vector, without `--force` (`packages/index/src/indexer.ts:689-695`). Under `MEMHTML_EMBED=off` a bare `index rebuild` is refused this way over a store that has vectors. Over one with none it runs (`refuseNoEmbedOverVectors` at `packages/index/src/indexer.ts:354-366`). A WARN on stderr carries the count (`RebuildNoEmbedRefused` at `packages/index/src/indexer.ts:199-213`).
- `ERR_EMBED_MODEL_MISMATCH` (exit 1) when the rebuild can't embed and the stored model differs from the configured one. `--force` doesn't bypass it, because `guardEmbedModel` runs first (`packages/index/src/indexer.ts:691`). With an embedder bound, `index rebuild --embed` is the migration path and has no such guard.
- `ERR_STORAGE` (exit 1) from a database error or any git error, including an unborn HEAD. The indexer reaches git through a port that maps every git failure to `StorageFailure` (`apps/cli/src/api-layer.ts:163-164`).

An embedding failure never fails the rebuild. `embedMissing` logs the failed `embeddings.embed` call and returns the count written so far (`packages/index/src/indexer.ts:573-585`).

Failure: a git failure happens before the truncate and leaves the old index whole. After the truncate the projections are written in batches of 500, each its own transaction, and the watermark is written last. A process that dies in between leaves `head_sha` null over partly filled tables, which `index update` reports as `ERR_INDEX_STALE`. The stash is in SQLite's temporary schema and dies with the process, so an interrupted rebuild loses the vectors it meant to keep, and the recovery rebuild has to embed them again.

The atomic part is the truncate, one transaction. Nothing locks a rebuild against another process. A concurrent `index update`, or a write's `reindex` after its commit, sees the null watermark and fails with `ERR_INDEX_STALE`, and a `search` during the window reads the partial tables.

## index embed

```
memhtml index embed [--dry-run]
```

Fills every chunk that has no vector in the configured space, without a rebuild (`backfill` at `packages/index/src/indexer.ts:708-726`). It checks the model, runs `embedMissing` over the whole table in persisted slices, and counts. It writes only to `embeddings`.

Flags:

- `--dry-run` (boolean, default `false`): "Report the gap (embeddingsRemaining) and write nothing."

Response: `index.report`.

A caller reads `mode: "embed"`, `headSha` (the watermark, or null), `chunks`, `embeddings` (rows in every space), `embeddingsWritten`, and `embeddingsRemaining`, the chunks still without a vector in the configured space (`indexer.backfill` at `apps/cli/src/run.ts:606-611`). With `MEMHTML_EMBED=off` it writes nothing and reports the gap.

This is the recovery from a sparse vector plane. `index update --embed` embeds only the chunks its own pass projected, so a chunk whose embedding failed isn't revisited unless an update projects the same text again, as it does for a still-dirty file or a store with no watermark row (`embedMissing` at `packages/index/src/indexer.ts:1002`). `index embed` is the store-wide fill.

Errors:

- `ERR_EMBED_MODEL_MISMATCH` (exit 1) when the stored model differs from the configured one, also with `--dry-run` (`guardEmbedModel` at `packages/index/src/indexer.ts:710`).
- `ERR_STORAGE` (exit 1).

Failure: each slice is embedded and then written in 500-row transactions, so an interruption keeps every committed batch and a rerun sees only the remainder. `--dry-run` writes no row. It works during the stale-index window, with `headSha: null`.

## index update

```
memhtml index update [--no-embed]
```

Indexes what moved since the recorded watermark, plus the working tree (`update` at `packages/index/src/indexer.ts:808-1019`). It checks the model, diffs the watermark against HEAD, reads `git status` under the repository's untracked-files setting, projects the committed changes and then the working-tree ones, writes the watermark, and embeds the chunks this pass projected. With no watermark row at all it reprojects everything. The status call is a plain `git status --porcelain=v2 -z` (`statusPorcelainV2` at `packages/store/src/git.ts:399-402`). A file inside a new untracked directory shows only as that directory and isn't seen, and `status.showUntrackedFiles=no` hides every untracked file.

Flags:

- `--embed` (boolean, default `true`): "Fill missing vectors."

Response: `index.report`.

A caller reads `mode: "update"`, `headSha`, `unchanged`, `added`, `modified`, `removed`, `renamed`, `dirty`, `embeddingsWritten`, and `skipped` (`indexer.update` at `apps/cli/src/run.ts:613-618`, `packages/index/src/indexer.ts:1008-1018`). Any dirty indexable path makes `unchanged` false.

Both the diff and the status are filtered to indexable paths (`packages/index/src/indexer.ts:854-858`). An indexable path ends in `.html`, sits under one of the four PARA buckets, and isn't a generated `index.html` or `sitemap.xml` (`isIndexablePath` at `packages/index/src/indexer.ts:243-251`). So an edit to the store's `memhtml.config.json` or any other file outside the buckets, committed or not, leaves `unchanged` true.

Every write path reindexes through this pass. `reindex` calls `update` and doesn't name the paths it wrote, because a `git mv` is one rename in the diff and only the diff can express an archive as a move (`reindex` at `apps/cli/src/operations.ts:248-271`).

The working-tree half is one-way. An edit that's indexed and then reverted with `git checkout` leaves the edited text in the index, and an untracked file indexed and then deleted keeps its row. A rebuild clears both.

Errors:

- `ERR_INDEX_STALE` (exit 1) when the watermark row has a null `head_sha`, the trace of an unfinished rebuild (`packages/index/src/indexer.ts:842-846`). `index update` raises it, and so does every write command's `reindex`, after its commit has landed (`reindex` at `apps/cli/src/operations.ts:267-271`). The suggestion is `memhtml index rebuild` (the `IndexStale` entry at `apps/cli/src/errors.ts:220`).
- `ERR_EMBED_MODEL_MISMATCH` (exit 1) when the stored model differs from the configured one (`guardEmbedModel` at `packages/index/src/indexer.ts:810`).
- `ERR_STORAGE` (exit 1) from a database or git error, such as a watermark commit that's gone from history. A working-tree file that git can't hash or read isn't an error. It's listed in `skipped` as `path is unreadable` (`projectFromTree` at `packages/index/src/indexer.ts:981-985`).

`--no-embed` over a store with vectors is allowed. Only `rebuild` has the interlock.

Failure: projection writes go in transactions of 500 statements, and the watermark is written after them (`applyProjectionWrites` and `writeState` at `packages/index/src/indexer.ts:994-995`, `WRITE_BATCH_SIZE` at `packages/index/src/schema-const.ts:89`). An interrupted update leaves its committed batches in place under the old watermark, with no stale marker, until the next update or write re-applies them. The watermark advances before embedding. An embedding failure still advances it. A later update fills those chunks only if it projects them again. `index embed` and `index rebuild --embed` fill them store-wide.

## index status

```
memhtml index status
```

Reads the index watermark and row counts, with no git call (`indexReport` at `apps/cli/src/views.ts:26-70`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:798-804`).

Response: `index.report`.

A caller reads `mode: "status"`, `headSha` (the recorded watermark), `embedModel`, `embedDim`, `embedModelMatches`, `configuredEmbedModel`, `rebuiltAt`, `updatedAt`, `files`, `activeFiles`, `chunks`, `embeddings` (every space), `vectorCoverage` (the configured space), `vectorCoverageFloor`, `edges`, `derivedEdges`, `tags`, `entities`, `traces`, and `hasState` (`apps/cli/src/views.ts:35-69`). `derivedEdges` counts the `edges` rows with `derived = 1`, which no command in this build writes. It has no freshness flag. `status` and `doctor` compare the watermark to HEAD.

Errors: none at runtime. Every read falls back to zero or null, so a broken database reads as an empty one (`apps/cli/src/views.ts:30-33`, `count` at `apps/cli/src/views.ts:72-76`).

Failure: `index status` writes nothing beyond the layer build's side effect. A never-indexed store reports `embedModelMatches: false`, and the stale-index window reports `headSha: null` over existing rows.

## trace index

```
memhtml trace index
```

Scans `$MEMHTML_TRACE_ROOT` for Claude Code transcripts (`indexTraces` at `apps/cli/src/operations.ts:2275-2318`). It finds `projects/<slug>/<id>.jsonl` files and their subagent sidecars, decides per file to skip, tail, or rescan from the stored watermarks, parses everything, and then persists file by file (`scanTraceRoot` at `packages/traces/src/scan.ts:88-163`). The trace root is only read.

This command takes no arguments and no flags (`apps/cli/src/commands.ts:805-811`).

Response: `trace.report`.

A caller reads `traceRoot`, `filesSeen`, `skipped`, `tailed`, `rescanned`, `filesFailed`, `bytesRead`, `sessionsWritten`, `promptsWritten`, and `tailsMerged` (`apps/cli/src/operations.ts:2304-2317`). `skipped + tailed + rescanned + filesFailed` equals `filesSeen`, because the scan's four counters partition its files (`ScanReport` at `packages/traces/src/scan.ts:49-55`). `sessionsWritten` counts files that wrote a row, sidecars included.

Errors:

- `ERR_STORAGE` (exit 1) for a trace directory that can't be listed, or a database error. A missing trace root succeeds with zeros (`readDirOrEmpty` at `packages/traces/src/discover.ts:67-83`), and an unreadable file counts in `filesFailed` and keeps its watermark (`readFailed` at `packages/traces/src/scan.ts:126-143`).

Failure: nothing is written until the scan finishes. Each file's row, prompts, and watermark then commit in one transaction, so an interruption keeps the files already persisted. Two concurrent runs aren't locked against each other. Trace tables survive `index rebuild` (`TRACE_TABLES` at `packages/index/src/schema-const.ts:63`).

## trace search

```
memhtml trace search <query> [--cwd <dir>] [--since <iso>] [--limit 20]
```

Runs a full-text search over session first prompts and AI titles in `traces_fts`, all-terms first and then any-terms (`searchTraces` at `apps/cli/src/operations.ts:2344-2405`). A query with no indexable term lists sessions by `started_at`, newest first. It never enters memory retrieval.

Arguments:

- `<query>` (required): "Prose. A double-quoted span demands those words in that order; nothing else is syntax."

Flags:

- `--cwd` (string): "Restrict to sessions from this directory."
- `--since` (string): "ISO-8601 lower bound on started_at."
- `--limit` (int, default `20`): "Sessions to return."

Response: `trace.sessions`.

A caller reads `sessions`, each with `sessionId`, `slug`, `cwd`, `startedAt`, `promptCount`, `firstPrompt`, and `aiTitle`, and `degraded` (`apps/cli/src/operations.ts:2393-2404`). Here `degraded` means the query had no indexable terms, so the answer is a recency listing. `search` uses the same field name for its own condition.

`--since` is compared as a string and isn't validated. A malformed value gets no refusal, and a word such as `yesterday` sorts after every ISO date and returns nothing at exit 0. `--cwd` must match exactly. `--limit` is clamped to 1 through 200 silently (`apps/cli/src/operations.ts:2347`).

Errors:

- `ERR_STORAGE` (exit 1). The trace tables are empty until `trace index` has run.

Failure: `trace search` writes nothing.

## trace links

```
memhtml trace links [--session-id <id>] [--path <path>]
```

Reads the memory-session links from either side, newest first, capped at 500 rows (`traceLinks` at `apps/cli/src/operations.ts:2420-2471`). Both flags together narrow to their intersection.

Flags:

- `--session-id` (string): "Every memory this session touched."
- `--path` (string): "Every session that touched this memory."

Response: `trace.links`.

A caller reads `links`, each with `path`, `sessionId`, `promptId`, `turnUuid`, `linkKind`, and `at` (`apps/cli/src/operations.ts:2461-2470`). `linkKind` is `wrote`, `read`, `corrected`, or `reinforced` (`LINK_KINDS` at `packages/index/src/traces-persist.ts:79`). The 500-row cap has no truncation marker.

Errors:

- `ERR_INVALID_MEMORY` (exit 1) when neither flag has a value. It's raised after the layer is built, so it's a runtime code for a call-shape mistake (`InvalidMemory` at `apps/cli/src/operations.ts:2427-2431`).
- `ERR_STORAGE` (exit 1).

Failure: `trace links` writes nothing.

## status

```
memhtml status
```

Corpus health from git and the index (`statusReport` at `apps/cli/src/operations.ts:2489-2556`). It runs `git rev-parse HEAD` and `git status`, counts rows in `index.db`, reads vector coverage, and writes a WARN to stderr when the index is stale (`apps/cli/src/operations.ts:2526-2531`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:840-846`).

Response: `status.health`.

A caller reads `root`, `headSha`, `dirty`, `dirtyPaths`, `countsByType` (active files, tasks included), `archivedCount`, `edges`, `derivedEdges`, `chunks`, `embeddings` (every space), `traces`, `indexFresh`, `indexHeadSha`, `embedModel`, `embedderUp`, `vectorCoverage`, `vectorCoverageFloor`, and `hasState` (`apps/cli/src/operations.ts:2533-2555`). `indexFresh` is true when the index watermark equals HEAD. `embedderUp` is a watermark check, true when the stored model matches the configured one and a vector exists. It doesn't call the embedder. `root` echoes `--repo` as given.

Errors:

- `ERR_GIT` (exit 1) when the root isn't a git repository (`apps/cli/src/operations.ts:2495`).
- `ERR_STORAGE` (exit 1) from a count or the vector coverage read. Only the watermark read is guarded (`apps/cli/src/operations.ts:2498`).

Failure: `status` writes nothing to the tree and takes no lock. `git status` runs with `GIT_OPTIONAL_LOCKS=0` (`GIT_ENV` at `packages/store/src/git.ts:183-191`). HEAD and the watermark are read separately, so a write between the two can make one answer describe two moments. A stale index is exit 0 with `indexFresh: false`.

## publish

```
memhtml publish
```

Regenerates the per-directory `index.html` listings and `sitemap.xml` from the `files` rows in `index.db`, writes the ones whose bytes changed, stages every artifact, removes every tracked listing whose directory no longer holds a record, and commits, all inside the checkout lock (`publish` at `apps/cli/src/publish.ts:149-185`). Before it writes anything, it refuses an index that holds no file rows while HEAD carries memory files (`refuseEmptyIndex` at `apps/cli/src/publish.ts:82-96`). Inside the lock it first sets `merge.directoryRenames=false` in the clone's config when the clone lacks it, as `init` does, because a listing removal can empty a directory (`ensureConfig` in `packages/store/src/layout.ts`). The setting protects the clone that runs the merge, so this covers only a clone that publishes, and an existing clone that only writes and pulls needs `memhtml init` run again.

This command takes no arguments and no flags (`apps/cli/src/commands.ts:847-853`).

Response: `publish.report`.

A caller reads `root`, `artifacts`, `written`, `paths` (the rewritten files), `removed` (the listings removed, path-ordered), and `commitSha`, null when the git index already matched HEAD (`PublishReport` at `apps/cli/src/publish.ts:42-56`).

The listings come from the index's `files` rows. Apart from the empty-index refusal, nothing checks freshness, so a stale index is published as it stands. A listing is generated for every directory holding a row and for each of its ancestors, and archived records are rows, so their directories under `archive/<YYYY>/` keep their listings. Removal is decided from the tree as well: a tracked `index.html` under one of the four buckets is removed with `git rm` in the same commit and named in `removed` only when the generator doesn't produce it and git tracks no record at or below its directory, by the indexer's path rule (`staleListings` at `apps/cli/src/artifacts.ts:200-223`). That includes an `index.html` written by hand in such a directory, since the filename under a bucket is the generator's. The root `index.html` and `sitemap.xml` are never removed, and neither is a file outside the buckets or one git doesn't track. Each artifact is staged as a literal path, so a directory named with a `[`, `*` or `?` never stages an untracked page beside it for a later publish to remove (`add` at `packages/store/src/git.ts:444-449`). So an index behind the tree, after a pull it hasn't seen, an interrupted rebuild, or a record that no longer parses, never removes the listing of a directory that still holds a record. Its listings still show only the rows it has, so run `memhtml index update` before publishing after a pull. The listings name only indexed memory files, so `memhtml.config.json` and everything under `.memhtml/` stay out of them (`isIndexablePath` at `packages/index/src/indexer.ts:243-251`).

Errors:

- `ERR_INDEX_STALE` (exit 1) when the index holds no file rows and HEAD carries at least one memory file, as on a fresh clone before `index rebuild`. Nothing is written, and the suggestion is `memhtml index rebuild` (`refuseEmptyIndex` at `apps/cli/src/publish.ts:82-96`, `apps/cli/src/errors.ts:220`).
- `ERR_STORAGE` (exit 1) from the database read, from `publish.write:<path>`, or as `checkout.locked` when another writer holds `.memhtml/checkout.lock` past the 15 s wait (`apps/cli/src/publish.ts:160-175`, `CHECKOUT_LOCK_WAIT_MS` at `packages/contracts/src/checkout-lock.ts:54`).
- `ERR_GIT` (exit 1) from the HEAD read or the `ls-tree` behind the empty-index check, or from `config`, `ls-files`, `rm`, `add`, or `commit`.

Failure: the files are written and staged, the stale listings are removed, and the result is committed inside the checkout lock, with no journal (`apps/cli/src/publish.ts:157-175`). A `checkout.locked` failure leaves the tree untouched, because the lock is taken before the first write. The removals are staged last. A failed write leaves the files written before it on disk and unstaged, and neither it nor a failed `git add` or `git rm` leaves a deletion staged, so the next store write, whose commit takes everything staged, can't carry one. If the commit fails, the artifacts stay written and staged and the removals stay staged, and a rerun returns `written: 0` and an empty `removed` with a real `commitSha`. The commit takes anything else already staged and doesn't reindex, so `indexFresh` reads false until the next `index update`.

## doctor

```
memhtml doctor [--fix]
```

Builds a health report from the index and the files (`doctor` at `apps/cli/src/doctor.ts:567-692`). With `--fix` it rewrites or drops dangling hrefs, deletes orphan access rows, and commits the touched files inside the checkout lock (`repair` at `apps/cli/src/doctor.ts:462-558`).

Flags:

- `--fix` (boolean, default `false`): "Repair dangling hrefs and prune orphan access rows. The other findings need a decision."

Response: `doctor.report`.

A caller reads `healthy` first. The findings are `dangling`, `orphanAccessRows`, `inboxDepth`, `inboxCrowded`, `inboxTaskDepth`, `inboxTasksCrowded`, `overdueTasks`, `staleBlockers`, `untypedEntities`, `untypedEntityTotal`, `warnings`, `unparseable`, and `dirty`. The index fields are `indexFresh`, `indexHeadSha`, `headSha`, `embedModelMatches`, `storedEmbedModel`, `configuredEmbedModel`, `vectorCoverage`, `vectorCoverageFloor`, `vectorCoverageLow`, `chunks`, `embeddings`, and `vectorCoverageRemedy` (`DoctorReport` at `apps/cli/src/doctor.ts:154-213`). With `--fix` the report adds `repaired: {rewritten, dropped, failedWrites, prunedAccessRows, commitSha}` (`RepairReport` at `apps/cli/src/doctor.ts:216-231`).

`healthy` (`apps/cli/src/doctor.ts:638-664`) leaves out `overdueTasks`, `staleBlockers`, `untypedEntities`, and `dirty`. `vectorCoverageLow` is true only when a vector exists or an embedder is bound, and coverage is under the floor (`apps/cli/src/doctor.ts:628-629`). `unparseable` also lists indexed paths whose file is gone (`collectWarnings` at `apps/cli/src/doctor.ts:410-432`).

Doctor reads the index and the memory files the index lists. It doesn't read `memhtml.config.json` or any session's state. `dirty` is every path `git status` reports that git doesn't ignore, so an uncommitted `memhtml.config.json` appears there (`dirtyPaths` at `packages/store/src/store.ts:1360-1367`). A session's files under `.memhtml/sessions/` don't, because the store's `.gitignore` ignores them, and a store scaffolded before 0.16 gets the same pattern in `.git/info/exclude` when a session starts (`GITIGNORE` at `packages/store/src/layout.ts:84-89`, `ensureExcludedQuietly` at `packages/session/src/session.ts:256`).

Errors:

- `ERR_GIT` (exit 1) from `--fix`'s `add` or `commit` (`apps/cli/src/doctor.ts:544-553`).
- `ERR_STORAGE` (exit 1) from `--fix` as `checkout.locked` when another writer holds `.memhtml/checkout.lock` past the 15 s wait (`apps/cli/src/doctor.ts:544-553`).

Every check falls back to an empty finding, so a database failure reads as nothing found. The command exits 0 whether or not the store is healthy.

Failure: `--fix` writes the files and deletes the orphan rows one autocommitted statement at a time before it takes the checkout lock, and then stages and commits inside it (`apps/cli/src/doctor.ts:522-555`). A write that failed lands in `failedWrites` and is never staged, so it stays a finding (`apps/cli/src/doctor.ts:500-516`). If the lock wait runs out, the files stay rewritten and unstaged. If the commit fails, they stay rewritten and staged. Either way the orphan rows are already gone, and the error envelope drops the counts. A successful fix doesn't reindex, so the next `doctor` lists the repaired link until `index update` runs. The commit takes anything else already staged.

## config

```
memhtml config
memhtml config --repo ~/memhtml
```

Shows the policy the store runs under and the process tuning this environment sets, each value with its source (`configReport` at `apps/cli/src/config-report.ts:83-84`). It reads `memhtml.config.json` from the store root's working tree, asks git whether that file is committed, and reads three environment variables. It builds no app layer, so it answers on a store whose index was never built (`apps/cli/src/run.ts:2004-2017`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:875-883`).

Response: `config.report`.

A caller reads `file`, `store`, and `process` (`storeConfigReport` at `apps/cli/src/store-config.ts:159-189`, `processTuning` at `apps/cli/src/config-report.ts:62-75`).

- `file` has `path`, `present`, and `git`, which is `committed`, `modified`, `untracked`, `absent`, or `unknown` when `git status` fails (`trackingOf` at `apps/cli/src/store-config.ts:145-156`).
- `store` has the five policy keys, `writeBar.refusedTypes` (each `type` and `reason`), `writeBar.requireAnchor`, `v1Doors`, `curator.writerBuckets`, and `curator.placementQuota`. Each is `{value, source}`, with `source` `file` or `default`. The defaults are no refused types, no anchor rule, `closed-in-session`, no writer buckets, and a quota of 60 (`DEFAULT_STORE_POLICY` at `packages/contracts/src/store-config.ts:118-134`).
- `process` has `MEMHTML_EMBED_WARM_IDLE_MS`, `MEMHTML_EXEC_POOL_SIZE`, and `MEMHTML_EXEC_WORKER_HEAP_MB`, as `head serve` would read them here. Each has `value`, `source` (`env` or `default`), `readBy: "head serve"`, and a `problem` when the value is one `head serve` would refuse, with `value: null` (`setting` at `apps/cli/src/config-report.ts:39-56`). The pool size's default is this host's.

The file is read again by every command that needs it, so what `config` shows is what the next write is judged by. A server started in another environment may run with other `process` values.

Errors:

- `ERR_STORE_CONFIG` (exit 1) when the file exists and can't be read or doesn't decode, naming what's wrong. The suggestions are `memhtml config` and an edit of the file (`StoreConfigInvalid` at `apps/cli/src/errors.ts:256-261`).
- `ERR_REPO_REQUIRED` (exit 2) under `MEMHTML_REFUSE_ENV_ROOT` with no `--repo` (`ROOT_WITHOUT_LAYER` at `apps/cli/src/run.ts:1221`).

Failure: `config` writes nothing. A root with no git repository answers with `git: unknown`, and a root that doesn't exist answers with every key at its default.

## eval discriminate

```
memhtml eval discriminate [--mode fake] [--seed <n>] [--now <ms>] [--size 200] [--probes 36] [--mrr-floor 0.85]
```

The refusable retrieval gate. It generates a fixture corpus in a temporary directory with an in-memory database, indexes it through the real ranking stack, and requires every probe's target to outrank each of its wrong-fact controls, with mean reciprocal rank at or above the floor (`runDiscrimination` called at `apps/cli/src/run.ts:1769-1798`, `passed` at `packages/eval/src/discriminate.ts:218`). It builds no app layer and opens no root.

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

- `ERR_DISCRIMINATION_FAILED` (exit 1) for any inversion, an MRR under the floor, zero probes, or `--mode live` without `AWS_BEARER_TOKEN_BEDROCK` (`DiscriminationFailed` at `apps/cli/src/run.ts:1782-1786`, `packages/eval/src/run.ts:94-123`). The failure envelope has no `data`, so `seed`, `now`, and the inversions aren't in it. The one suggestion is `memhtml eval discriminate` with no flags, which runs the gate again at the default seed and the current clock (the `DiscriminationFailed` entry at `apps/cli/src/errors.ts:237`).
- `ERR_UNKNOWN` (exit 1) for anything else (`apps/cli/src/run.ts:1787-1791`).

An unparseable `--seed`, `--size`, `--probes`, or `--mrr-floor` falls back to its default silently (`int` and `num` at `apps/cli/src/run.ts:287-301`).

Failure: the temporary corpus is removed once the stack is built, whether the gate then passes or fails. A failure while building the stack leaves the directory, because the finalizer is added only after `buildStack` returns (`withStack` at `packages/eval/src/harness.ts:247-257`). Nothing outside it is written.

## exec

```
memhtml exec --file <script.mjs>
memhtml exec --script <source>
memhtml exec --file -
cat script.mjs | memhtml exec
```

Runs a read-only traversal script over a pinned commit in a sandbox (`execCommand` at `apps/cli/src/exec.ts:532-584`). It resolves the root, resolves `--sha` or HEAD, adds a detached git worktree for that commit in a temporary directory, mounts it read-only at `/mnt/memhtml`, runs the script under QuickJS through `js-exec`, and removes the worktree. The temporary directory is named `memhtml-corpus-snapshot-*` under the OS temp directory (`CORPUS_SNAPSHOT_TMPDIR_PREFIX` at `apps/cli/src/mount.ts:202`, `pinCorpusSnapshot` at `apps/cli/src/mount.ts:253-285`).

Flags:

- `--file` (string): "The script to run, as a path on the HOST. Omit it, pass `--file -`, or pass a positional `-` to read the script from stdin. Mutually exclusive with `--script`."
- `--script` (string): "The script source, inline. Mutually exclusive with `--file` and with reading stdin."
- `--timeout-ms` (int, default `30000`): "Wall-clock bound on the script. Exceeding it is `exitCode` 124 with `timedOut: true`, not an error envelope. A value above 600000 is refused."
- `--sha` (string): "The commit to mount: a sha, an abbreviation, or a ref, resolved to the full sha the report names and materialized as a detached worktree. Defaults to HEAD. A value starting with a dash is refused. Never the live working tree, whose gitignored .memhtml/index.db a worktree omits."

Response: `exec.report`.

A caller reads `exitCode`, `stdout`, `stderr`, `timedOut`, `sha`, `corpusMount`, `durationMs`, and `timeoutMs` (`ExecReport` at `apps/cli/src/exec.ts:272-287`). `sha` is `--sha` as given, trimmed, so `--sha HEAD~1` reports `HEAD~1`. Without `--sha` it's the resolved HEAD (`apps/cli/src/exec.ts:541-545`). A script that exits non-zero is a success envelope at exit 0, and a script past `--timeout-ms` is `exitCode: 124` with `timedOut: true` (`apps/cli/src/run.ts:2055`).

The bounds are constants. `DEFAULT_TIMEOUT_MS` is 30000 and `MAX_TIMEOUT_MS` is 600000 (`apps/cli/src/exec.ts:51`, `apps/cli/src/exec.ts:61`). The shell's own bound is the script's bound plus `SHELL_TIMEOUT_GRACE_MS`, 2000, so the script's bound fires first and its message names the limit (`apps/cli/src/exec.ts:70`, `apps/cli/src/exec.ts:411-418`). The mount is an `OverlayFs` with `readOnly: true` and `maxFileReadSize` set to `MAX_MOUNTED_FILE_READ_BYTES`, which is `Number.MAX_SAFE_INTEGER`, so a file over just-bash's 10 MB default reads in full (`mountReadOnlyRoots` at `apps/cli/src/mount.ts:172-192`, `apps/cli/src/mount.ts:45`). The sandbox is a `Bash` instance built with no network and no Python option, so no flag can turn either on (`apps/cli/src/exec.ts:411-418`). A gitignored `.memhtml/index.db` is absent from a worktree, so the script can't reach the ranked planes.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for two script doors, an explicit `-` beside a door, or a `--timeout-ms` that isn't a positive integer up to the cap (`execFlags` at `apps/cli/src/run.ts:755-811`). Piped stdin beside a door is ignored, and the door's script runs (`apps/cli/src/run.ts:2024-2025`).
- `ERR_MISSING_ARGUMENT` (exit 2) for a blank script (`apps/cli/src/run.ts:2027-2040`).
- `ERR_PATH_NOT_FOUND` (exit 2) when `--file` can't be read (`readScript` at `apps/cli/src/exec.ts:466-476`).
- `ERR_INVALID_MEMORY` (exit 1) when the commit can't be materialized, such as a bad `--sha` or an unborn HEAD (`InvalidMemory` at `apps/cli/src/exec.ts:546-576`), and when the read-only mount fails (`apps/cli/src/exec.ts:382-389`).
- `ERR_GIT` (exit 1) when the root isn't a git repository and `--sha` is omitted, from the HEAD read (`revParseHead` at `apps/cli/src/exec.ts:541-545`). With `--sha` the same root answers `ERR_INVALID_MEMORY` and leaves a temporary directory behind.
- `ERR_STORAGE` (exit 1) when a module fails to load, when the sandbox fails to seed or run, or when the bridge faults on all 3 attempts. A bridge fault reruns the script, so one call can run it up to 3 times (`BRIDGE_ATTEMPTS` at `apps/cli/src/exec.ts:234`, `withBridgeRetry` at `apps/cli/src/exec.ts:249-269`).

Failure: the worktree is released by a scope finalizer, so a script failure, a timeout, and a typed failure all run the release (`apps/cli/src/exec.ts:567-576`). The release ignores a failed `git worktree remove`, so the `.git/worktrees` entry can remain, and it then removes the temporary directory (`release` at `apps/cli/src/mount.ts:266-283`). A bad `--sha` leaves an empty temporary directory, because the directory is made before the failing `git worktree add` (`apps/cli/src/mount.ts:257-261`). A killed process skips the finalizer and leaves the worktree and its `.git/worktrees` entry. `exec` never runs `git worktree prune`.

## state export

```
memhtml state export
```

Writes the `state.access` rows to `.memhtml/state/access.jsonl` and commits it inside the checkout lock, unless the bytes already match (`stateExport` at `apps/cli/src/state.ts:64-106`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:988-995`).

Response: `state.export`.

A caller reads `path`, `rows`, `bytes`, `written`, and `commitSha` (`StateExportReport` at `apps/cli/src/state.ts:36-42`). `bytes` is the sidecar string's length in UTF-16 code units, so a path with characters outside ASCII makes it differ from the file's size (`apps/cli/src/state.ts:77`, `apps/cli/src/state.ts:102`).

The sidecar holds `state.access` only. The corroboration tables in `state.db` aren't exported. An empty plane, such as a fresh clone before `state import`, overwrites the sidecar with an empty file and commits that (`renderSidecar` at `packages/index/src/sidecar.ts:92-93`).

Errors:

- `ERR_STORAGE` (exit 1) from the `state.access` read, from `state.write:.memhtml/state/access.jsonl`, or as `checkout.locked` when another writer holds `.memhtml/checkout.lock` past the 15 s wait (`apps/cli/src/state.ts:83-97`).
- `ERR_GIT` (exit 1) from `add` or `commit`.

Failure: the byte comparison runs before the lock. The file is then written, staged, and committed inside the checkout lock, with no journal (`apps/cli/src/state.ts:72-97`). A `checkout.locked` failure leaves the sidecar unwritten. If the commit fails, the sidecar stays written and staged, and a rerun sees matching bytes, returns `written: false`, and doesn't commit it. A later commit from the shared index, such as the next v1 write's, takes it. The commit takes anything else already staged.

## state import

```
memhtml state import
```

Replays the committed sidecar into `state.db` in one transaction (`stateImport` at `apps/cli/src/state.ts:120-180`). It stages and commits nothing, so it takes no checkout lock.

This command takes no arguments and no flags (`apps/cli/src/commands.ts:996-1002`).

Response: `state.import`.

A caller reads `path`, `rows`, `restored`, `skipped` (lines that didn't parse or name no path), and `hasState` (`StateImportReport` at `apps/cli/src/state.ts:45-54`, `parseSidecar` at `packages/index/src/sidecar.ts:102-130`). A missing or unreadable sidecar succeeds with `rows: 0` (`readFileOrNull` at `apps/cli/src/state.ts:125`). With no state plane attached, or no parsed rows, the import restores nothing and still reports the parsed count (`apps/cli/src/state.ts:138-146`).

`access_count` and `reinforcement_count` merge by max, and the `last_*_at` columns by max as text. `outcome_score` and `updated_at` take the sidecar's value (`apps/cli/src/state.ts:154-160`). When a path already has a row and both sides of a `last_*_at` column are NULL, the column is stored as `''`, so the next export commits a changed sidecar (`apps/cli/src/state.ts:158-159`). Paths aren't checked against the tree.

Errors:

- `ERR_STORAGE` (exit 1), including one parsed line that breaks a `CHECK` constraint, such as a negative count or an `outcomeScore` outside -1 to 1 (`packages/index/state-migrations/S0001_access.sql:21-25`).

Failure: the upsert is one SQLite transaction, so a failure restores nothing and an import either lands whole or not at all (`writeAll` at `packages/index/src/database.ts:374-389`).

## agents-doc

```
memhtml agents-doc [--check] [--out AGENTS.md]
```

Renders `AGENTS.md` from the command table and writes it when it differs, or with `--check` compares without writing (`runAgentsDoc` at `apps/cli/src/agents-doc.ts:242-278`). It builds no app layer, so it scaffolds no root (`apps/cli/src/run.ts:1745-1753`).

Flags:

- `--check` (boolean, default `false`): "Compare the committed doc to the regenerated one and fail on a difference."
- `--out` (string): "Where to write. Defaults to ./AGENTS.md."

Response: `agents.doc`.

A caller reads `path` (absolute), `bytes`, `inSync`, and `written` (`AgentsDocResult` at `apps/cli/src/agents-doc.ts:227-234`). `bytes` is the rendered string's length in UTF-16 code units, so it differs from the file's size when the doc holds characters outside ASCII. `--out` resolves against the working directory (`apps/cli/src/agents-doc.ts:247`).

Errors:

- `ERR_INVALID_MEMORY` (exit 1) from `--check` when the file is out of date or missing (`InvalidMemory` at `apps/cli/src/agents-doc.ts:257-267`). Drift is a failure envelope, so a `--check` success always carries `inSync: true`. The suggestion is `memhtml manifest`, and the fix, `memhtml agents-doc`, appears only in the `error` text (`apps/cli/src/errors.ts:234`).
- `ERR_STORAGE` (exit 1) when the write fails (`apps/cli/src/agents-doc.ts:273-276`).

Failure: `--check` never writes. Without it, an in-sync file isn't rewritten. An unreadable existing file counts as missing.

## serve mcp

```
memhtml serve mcp
```

Supervises the `memhtml-mcp` stdio server, 15 tools and 2 resource templates over the same root (`serveMcp` at `apps/cli/src/serve.ts:82-111`, `MemhtmlToolkit` at `apps/mcp/src/tools.ts:1041-1057`, `Resources` at `apps/mcp/src/resources.ts:323`). The templates are `memhtml://file/{path}` and `memhtml://at/{commit}/{path}` (`RESOURCE_TEMPLATES` at `apps/mcp/src/resources.ts:326`). It resolves the root, finds the server entry, spawns it with stdio inherited, and waits. It builds no app layer, so the parent holds no database handle (`apps/cli/src/run.ts:1960-1979`).

This command takes no arguments and no command-specific flags (`apps/cli/src/commands.ts:1018-1024`).

Response: `serve.exit`.

A caller reads `server` (the entry path), `exitCode`, and `signal` (`ServeResult` at `apps/cli/src/serve.ts:24-29`). The envelope is written after the child exits, at exit 0 even when the child exited non-zero. A child killed by a signal reports `exitCode: 0` with the signal name (`apps/cli/src/serve.ts:95-103`).

The child gets the whole parent environment with `MEMHTML_ROOT` set to the resolved root, which is how a `--repo` reaches it (`apps/cli/src/serve.ts:87-90`). `MEMHTML_MCP_BIN`, trimmed, overrides the entry, and a blank value counts as unset. Otherwise the supervisor takes the first existing sibling build path, `./memhtml-mcp.mjs` in the published package and then `../../mcp/dist/bin.js` in the workspace (`MCP_CANDIDATES` at `apps/cli/src/serve.ts:54`, `mcpEntryPoint` at `apps/cli/src/serve.ts:56-80`).

Errors:

- `ERR_STORAGE` (exit 1) when no entry is found, as `serve.resolveMcp` (`apps/cli/src/serve.ts:75-79`), or when the spawn fails, as `serve.spawn` (`apps/cli/src/serve.ts:92-94`). An `MEMHTML_MCP_BIN` that names a missing file isn't caught here. Node starts, exits non-zero, and that exit is the `serve.exit` report.

Failure: the supervisor kills the child only when its own fiber is interrupted (`apps/cli/src/serve.ts:105-109`). No signal handler connects a SIGTERM sent to the parent alone, so that child keeps running (`apps/cli/src/bin.ts:1-22`).

## session start

```
memhtml session start --id s1
memhtml session start --id curate-2026-09-23 --ref refs/heads/curate/2026-09-23
memhtml session start --id s1 --force
```

Opens a v2 session: a pointer to one corpus version plus an empty overlay log (`sessionStart` at `apps/cli/src/v2.ts:386-411`). It qualifies `--ref` with `refs/heads/` when the name doesn't start with `refs/`, and defaults it to `refs/heads/main` (`qualifyRef` at `apps/cli/src/v2.ts:278-281`). The base is the ref's tip, or `HEAD` when the ref doesn't resolve yet, which is how a curator's branch starts before its first commit (`baseShaFor` at `apps/cli/src/v2.ts:260-271`). It loads the version at that commit the cheapest way it can, from that commit's snapshot, from an ancestor's snapshot advanced over the changed paths, or from git, and reports what the load cost (`loadHeadAt` at `apps/cli/src/v2.ts:217-236`). Then `startSession` takes the session's lock, refuses an id that already has a log unless `--force` is set, adds `.memhtml/sessions/` to `.git/info/exclude` when the store's `.gitignore` predates it, checks that the base names a commit, and writes the log (`startSession` at `packages/session/src/session.ts:230-264`). `docs/design.md` §17 covers sessions.

The session's state is one file, `.memhtml/sessions/<id>.json`, holding `id`, `baseSha`, `ref`, `ops`, and an optional `pending` (`SessionState` at `packages/session/src/session.ts:124-130`). Every write to it goes through a temporary file and a rename (`writeState` at `packages/session/src/session.ts:194-206`). The lock is a directory at `.memhtml/sessions/<id>.lock`, and a second writer of the same id fails at once with `session.locked` (`withSessionLock` at `packages/session/src/session.ts:161-188`).

Flags:

- `--id` (string): "The session id: one path segment, letters, digits, `.`, `_`, `-`. State lives at `.memhtml/sessions/<id>.json` (its overlay log); a commit stages through a temporary index of its own and keeps nothing else. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."
- `--ref` (string): "The ref commits land on. Defaults to `refs/heads/main`. A ref that does not exist yet (a curator's `refs/heads/curate/<date>`) starts from HEAD and is created by the first commit."
- `--force` (boolean, default `false`): "Discard an existing log under this id and start over. Without it, an id that already has a log is refused with ERR_STORAGE (session.exists) so a retried start cannot lose an overlay in progress; `session status --id <id>` reads the existing one."

Response: `session.started`.

A caller reads `id`, `baseSha`, `ref`, `ops` (always 0), and `head` (`apps/cli/src/v2.ts:404-410`). `head` is the load report every head-loading v2 payload carries: `sha`, `records`, `skipped`, `loadMs`, `source`, `snapshotPath`, `ancestorSha`, and `reparsed` (`HeadStats` at `apps/cli/src/v2.ts:154-176`). `source` is `snapshot`, `snapshot+advance`, `git`, or, on the commands that ask the head server, `server`. `skipped` counts the files a git load's parser refused, and it's null after a snapshot load.

`session start` never asks the head server. It needs no start under `MEMHTML_SESSION`, because `session put` and `session exec` start a run's session on first use; see [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).

Errors:

- `ERR_INVALID_FLAG` (exit 2) for an `--id` or a `MEMHTML_SESSION` that isn't a session id, and `ERR_MISSING_ARGUMENT` (exit 2) with neither (`sessionIdFlag` at `apps/cli/src/run.ts:936-971`).
- `ERR_STORAGE` (exit 1) as `session.exists` when the id has a log and `--force` is absent, and as `session.locked` when another writer holds the id (`packages/session/src/session.ts:248-253`, `packages/session/src/session.ts:177-184`).
- `ERR_INVALID_MEMORY` (exit 1) for a root with no commit (`baseShaFor` at `apps/cli/src/v2.ts:260-271`).
- `ERR_GIT` (exit 1) when the root isn't a git repository, or the base names no commit (`packages/session/src/session.ts:257-260`).

Failure: nothing is written before the base checks out and the head loads, so a failure leaves no log. `--force` replaces the log in one rename, so it never leaves a half-written file. It discards the old overlay's ops with no copy.

## session put

```
memhtml session put --id s1 --file ops.jsonl
memhtml session put --id s1 --file ops.jsonl --no-server
printf '%s\n' '{"op":"label","path":"areas/inbox/x.html","entity":"system:memhtml"}' | memhtml session put --id s1 --file -
```

Appends write ops, and `label` or `unlabel` ops on existing records, to a session's overlay log (`sessionPut` at `apps/cli/src/v2.ts:611-699`). The whole op stream is read and decoded before anything opens. A `write` line goes through the same decoder `apply` uses, and a `label` or `unlabel` line names a `path` and an `entity` (`decodeSessionPut` at `apps/cli/src/apply.ts:391-441`, `apps/cli/src/run.ts:2127-2135`). Under `MEMHTML_SESSION` with no log yet, the session is started first (`ensureSession` at `apps/cli/src/v2.ts:442-469`).

Then it asks the head server's `/v1/neighbors` route to place, judge, and rank the new ops over the version at the session's base. A session on a `refs/heads/curate/` branch is judged here under the `curate` scope, and so is any call the server doesn't answer within 100 ms to accept or 10 s to answer (`apps/cli/src/v2.ts:630-647`, `askHead` at `apps/cli/src/head-client.ts:226-229`). The local path reads the store policy, loads the base, and runs `preparePuts` (`apps/cli/src/v2.ts:650-668`):

1. Each write is rendered the way the store would write it and placed at the path the store would choose. A valid explicit `path` is used as given, and a derived path already held by the view or by an earlier op in the call takes the store's `-2`, `-3` suffix (`putPathFor` at `apps/cli/src/v2.ts:305-328`).
2. Every op in the log plus the new ones is judged against the base with `validateOps`, under the store's write bar (`apps/cli/src/v2.ts:556-559`, `validateOps` at `packages/session/src/validate.ts:181`). The violation kinds are `format`, `duplicate`, `claim-edit`, `reserved-path`, `batch-cap` (200 ops), and `write-bar` (`Violation` and `BATCH_CAP` at `packages/session/src/validate.ts:24-45`).
3. A `format`, `reserved-path`, `batch-cap`, or `write-bar` violation at a path this call touches refuses the whole call, and in a run's own session so do `duplicate` and `claim-edit` (`BLOCKING_VIOLATIONS` at `apps/cli/src/v2.ts:334-339`, `apps/cli/src/v2.ts:560-568`). Outside a run those two are reported and left to the caller, because a rebase can change the answer.
4. With nothing blocking, each put gets its three nearest existing records, ranked the way `head search` ranks. The vector arm joins when the store has a vector cache and an embedder is bound, with each put's text embedded as a document in one call per batch (`apps/cli/src/v2.ts:569-592`, `vectorsForPuts` at `apps/cli/src/head-vectors.ts:280-315`).

The append always happens in this process, under the session's lock, and only when the log on disk still holds the ops this call read (`appendOps` at `packages/session/src/session.ts:325-335`).

Flags:

- `--id` (string): "The session to append to. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT. With the id taken from $MEMHTML_SESSION and no log yet, the session is started on `refs/heads/main`'s tip first (one `rev-parse`, no head load), so a run's first write needs no `session start`; a `--id` given on the line must name a started session."
- `--file` (string, required): "JSONL, one object per line. A `write` line takes the same fields `memhtml apply` accepts; each is rendered to the file the store would write and lands at the path the store would choose. A `label` line, `{"op":"label","path":"areas/inbox/x.html","entity":"system:memhtml"}`, adds one `memhtml-entity` to an existing record's head, and an `unlabel` line with the same fields removes one; neither touches the article, so the record keeps its content hash. A label value is a lowercase `type:name` (`service:memhtml`, `project:agent-runtime`, `person:laura`) the record does not carry yet; an unlabel names a value the record carries, exactly as written. `-` reads stdin. A malformed op, a reserved path, a label that is malformed or already carried, an unlabel of a value the record lacks, an unlabel that leaves a record with no entity outside `projects/<slug>/` while the store requires an anchor, or a record below the write bar refuses the whole call and appends nothing. The bar is the store's policy, `writeBar` in `memhtml.config.json` at the store root (`memhtml config` shows the effective values): `refusedTypes` names the types no writer may put, each refused with the reason the file gives, and `requireAnchor` makes every record name the system, project, or person it is about (an `entities` value, or a `workspace`; a task is anchored by either). With no file the bar refuses no type and requires no anchor; the format and integrity refusals hold either way, and a file that does not decode refuses the call with ERR_STORE_CONFIG. The bar holds for every writer and every type, the curator and tasks included. The response lists each put's nearest existing records under `neighbors`, so a near-duplicate can be skipped and the related records linked before the commit. `neighbors` is ranked the way `head search` ranks, the vector arm included when the store has a vector cache (`memhtml head embed`) and an embedder is configured: each put's own text is embedded as a document, one call per batch. When the arm cannot run the neighbors come from the lexical arm alone and `vector` says why (`used: false` with a `reason`); the put itself never fails for it."
- `--server` (boolean, default `true`): "Ask the head server on `.memhtml/head.sock` first (`memhtml head serve`), falling back to loading the head here when no server accepts within 100 ms or answers within 10 s; `--no-server` always loads here. The placements, violations, and neighbors (label lines included, the vector arm run with the server's cache and embedder) are then computed by the server over the version at the session's base; the append always happens here. The payload's `head.source` is `server` when the server answered."

`--file` is required in the table, so a bare `session put` reading stdin is refused. `--file -` reads stdin, and so does a positional `-`, which wins over a `--file` path given beside it (`apps/cli/src/run.ts:2128-2130`).

Response: `session.appended`.

A caller reads `id`, `started` (true when this call started the session), `baseSha`, `appended` (ops this call added), `ops` (the log's length after it), `paths` (where the puts landed, in input order), `labels`, `neighbors` (per put, its `path` and `hits`), `vector`, `violations`, and `head` (`apps/cli/src/v2.ts:678-698`). `violations` lists every violation over the whole log, the ones that didn't block included, so a `duplicate` reported here is one the next commit will refuse unless a rebase changes it. `vector` is null when the call ranked nothing.

Errors:

- `ERR_PATH_NOT_FOUND` (exit 2) when `--file` can't be read, and `ERR_INVALID_FLAG` or `ERR_MISSING_ARGUMENT` (exit 2) for a line that isn't a JSON object, an `op` outside `write`, `label`, and `unlabel`, a bad field, or a stream with no ops. The message names the line (`applyText` at `apps/cli/src/apply.ts:450-466`, `decodeSessionPut` at `apps/cli/src/apply.ts:391-441`).
- `ERR_INVALID_MEMORY` (exit 1) when a blocking violation refuses the call, naming each one (`apps/cli/src/v2.ts:670-676`), or when a write line's values don't decode, such as a bad `due`.
- `ERR_STORE_CONFIG` (exit 1) when `memhtml.config.json` exists and doesn't decode (`apps/cli/src/v2.ts:654`).
- `ERR_STORAGE` (exit 1) as `session.read` for an id with no log, `session.decode` for a log that doesn't decode, `session.locked` for a held lock, `session.moved` when another writer changed the log during the call, and `session.put.pathExhausted` when every suffix through `-1000` is taken (`resumeSession` at `packages/session/src/session.ts:290-301`, `LOG_MOVED` at `packages/session/src/session.ts:304`, `apps/cli/src/v2.ts:327`).
- `ERR_GIT`, `ERR_INVALID_MEMORY`, or `ERR_STORAGE` (exit 1) from loading the base.

Failure: a refused call appends nothing, and the log is written whole or not at all. An implicit start that was followed by a refused put leaves the started session with an empty log. Nothing is committed: the ops wait in the log for `session commit`.

## session exec

```
memhtml session exec --id s1 <<'SH'
grep -rl 'memhtml-entity" content="system:memhtml' /mnt/memhtml/projects | wc -l
SH
memhtml session exec --id s1 --lang js --file curate.mjs
memhtml session exec --id s1 --script 'grep -c memhtml /mnt/memhtml/projects/memhtml/*.html' --timeout-ms 5000
```

Runs a script over the session's view, the base version plus its overlay, in a writable sandbox, and harvests what it wrote into overlay ops (`sessionExec` at `apps/cli/src/v2.ts:853-929`). The script arrives through one of three doors, as on `exec`, and `run` reads it before anything opens. A blank script, and a request body over 1,048,576 bytes, are refused at exit 2 (`apps/cli/src/run.ts:2083-2125`, `EXEC_BODY_MAX_BYTES` at `apps/cli/src/head-protocol.ts:292`). Under `MEMHTML_SESSION` with no log yet, the session is started first.

Then it asks the head server's `/v1/exec` route to run it. The server reads the log, takes the version at the session's base when that's its tip or an ancestor of it, runs the script in a worker, harvests, validates, and appends, one exec per session at a time. The client waits for the server's two 30 s queues, the run's own deadline, and 10 s more before it calls the answer lost (`execAnswerTimeoutMs` at `apps/cli/src/v2.ts:835-836`, `EXEC_QUEUE_WAIT_MS` at `apps/cli/src/head-protocol.ts:315`). The script runs here when the server isn't reachable, answers any status but 200, or declines with `base-unservable` or `busy`. When the server took the script and its answer was lost, the call fails instead, because the server may have appended the harvest (`apps/cli/src/v2.ts:874-915`).

The local run reads the store policy, loads the base, and calls `execOverHead`, the function the server calls too (`apps/cli/src/v2.ts:916-928`, `execOverHead` at `apps/cli/src/v2.ts:728-813`):

1. The guest filesystem is seeded in memory from the view's records, with no worktree on disk, and mounted writable at `/mnt/memhtml` (`runSessionExec` at `apps/cli/src/session-exec.ts:724-798`). A `bash` script is the shell program itself, and a `js` script runs as a module through `js-exec` with `/workspace/lib/corpus.mjs` preloaded. There's no network.
2. The run is bounded by `--timeout-ms`, capped at 600000. Past it the report is `exitCode` 124 with `timedOut: true`. Bash command and loop counts are unbounded, so the wall clock is the bound, and the other just-bash limits end a runaway with exit 126 (`executionLimitsFor` at `apps/cli/src/session-exec.ts:671-680`, `BASH_COUNT_LIMIT` at `apps/cli/src/session-exec.ts:118`). A bridge fault reruns the script on a fresh seed, up to 3 attempts in all (`withBridgeRetry` at `apps/cli/src/exec.ts:249-269`).
3. The harvester diffs the tree against the seed. A new `.html` file is a `put`, an unchanged article whose head gained or lost `memhtml-` links or entity metas gives `link`, `unlink`, `label`, and `unlabel` ops, a file gone with an archive twin is an `archive`, and a file copied unchanged to one new live path is a `move`. Anything else is listed under `rejected` with a reason (`harvestOps` at `apps/cli/src/session-exec.ts:328`). `docs/design.md` §21 covers the harvest.
4. The log plus the harvest is judged against the base, with the blocking kinds `session put` uses at the harvested paths (`apps/cli/src/v2.ts:752-762`).
5. The harvest is appended only when the script exited 0 and nothing blocks. The append takes the session's lock and writes only over the log the call read, so a put, exec, commit, or rebase that wrote the log while the script ran keeps the harvest out, and `blocking` says why (`apps/cli/src/v2.ts:763-783`, `appendRefusal` at `apps/cli/src/v2.ts:702-707`).

Flags:

- `--id` (string): "The session whose view the script sees. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT. With the id taken from $MEMHTML_SESSION and no log yet, the session is started on `refs/heads/main`'s tip first, as `session put` does."
- `--file` (string): "The script, as a path on the HOST. Omit it, pass `--file -`, or a positional `-` to read stdin, which is the usual door: a heredoc (`memhtml session exec --id s1 <<'SH'` ... `SH`) delivers the script with no quoting to get wrong. Mutually exclusive with `--script`. A new file the script writes is held to the write bar `session put` states; one below it blocks the whole harvest. An existing file whose article is unchanged may gain or lose `<link rel="memhtml-...">` lines and `<meta name="memhtml-entity">` lines in its head: each becomes a `link`, `unlink`, `label`, or `unlabel` op, and any other head edit is rejected with a reason. A file copied unchanged to exactly one new live path and removed from its old one becomes a `move`, which keeps its bytes and its content hash; every edge a live record carries to the old path must be repointed in the same script (the old `<link>` line cut and one naming the new path added), or the harvest is blocked naming the edge. A file removed with no copy is rejected: deletion is not an operation."
- `--script` (string): "The script source, inline. Mutually exclusive with `--file` and with stdin."
- `--lang` (string, default `"bash"`, one of `bash`, `js`): "The script's language, echoed as `lang` in the report. `bash` runs it as a shell program: `cat`, `grep -r`, `sed -i`, `find` (with `-exec`), `xargs`, `jq`, `awk`, pipes, redirection, and nested heredocs all work on the corpus at `/mnt/memhtml`, so `cat > /mnt/memhtml/projects/<slug>/<name>.html <<'HTML'` ... `HTML` writes a record and a `sed -i` that splices a `<meta name="memhtml-entity">` line into a head labels one. Use absolute paths. `js-exec <file>` runs a JavaScript module from inside a bash script. `js` runs the whole script as a JavaScript module through `js-exec` with `/workspace/lib/corpus.mjs` preloaded, as `memhtml exec` does. The mount, the timeout, and the harvest are the same for both. There is no network in either: `curl` is not a command."
- `--timeout-ms` (int, default `30000`): "Wall-clock bound on the script. Exceeding it is `exitCode` 124 with `timedOut: true`, for a bash loop and a `js-exec` module alike. Other sandbox bounds end a runaway sooner with exit 126 and the bound named on stderr: call depth 100, and 100,000 iterations inside one `awk`, `sed`, or `jq`. A value above 600000 is refused. Under the head server a run still going 5 s past the bound (a single command the shell cannot interrupt) has its worker stopped, and it reports exit 124 with nothing harvested."
- `--server` (boolean, default `true`): "Ask the head server on `.memhtml/head.sock` to run the script (`memhtml head serve`); `--no-server` always runs it here. The server reads the session's log, takes the version at the session's base when that is its ref's tip or an ancestor of it, runs the script in a worker, harvests, validates, and appends exactly as a local run does, one exec per session at a time; the payload's `head.source` is `server` and `server.base` says `tip` or `ancestor`. The script runs here instead when the connection to a server never completes (no socket, nobody listening, any connect error, no accept within 100 ms, or a socket path past the platform's limit, which is never dialed), when the server answers anything but 200, or when it declines (`server.reason` `base-unservable` or `busy`); `server.reason` names why (`disabled` under `--no-server`, `no-server`, `refused`). When the server took the script and its answer was lost, the call fails with ERR_STORAGE rather than run it twice. Either way the request body (the script as JSON) is capped at 1,048,576 bytes: a larger script is ERR_INVALID_FLAG at exit 2 before anything runs."

Response: `session.exec.report`.

A caller reads `exitCode`, `stdout`, `stderr`, `timedOut`, `durationMs`, and `timeoutMs` for the script, then `ops` (what the harvester produced), `appended` (how many went into the log, all or none), `opsTotal`, `harvested` (each op's `kind` and `path`, plus `to` for an archive), `rejected`, `violations`, and `blocking` (`apps/cli/src/v2.ts:784-812`). Beside them are `id`, `baseSha`, `lang`, `corpusMount`, `sha` (the base the script saw), `started`, `head`, and `server` (`apps/cli/src/v2.ts:928`). `server` has `used`, `base` (`tip` or `ancestor`), `reason` (`disabled`, `no-server`, `refused`, `base-unservable`, or `busy`), and `detail` (`ExecServerUse` at `apps/cli/src/v2.ts:822-827`).

A script that fails is a success envelope at exit 0, like `exec`. Read `appended` to learn whether anything reached the log: a non-zero exit, a blocking violation, or a log that moved during the run all leave it at 0 while `harvested` still shows what a clean run would have taken.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for two script doors, a `-` beside one, a `--timeout-ms` that isn't a positive integer up to 600000, or a request body over 1,048,576 bytes (`execFlags` at `apps/cli/src/run.ts:755-811`, `apps/cli/src/run.ts:2115-2123`).
- `ERR_MISSING_ARGUMENT` (exit 2) for a blank script, and `ERR_PATH_NOT_FOUND` (exit 2) when `--file` can't be read (`apps/cli/src/run.ts:2087-2102`).
- `ERR_STORAGE` (exit 1) when the server took the script and gave no usable answer, naming `session status` (`apps/cli/src/v2.ts:908-913`). Also as `session.read` or `session.decode` for the log, and when the guest helper can't be read or every bridge attempt faults.
- `ERR_STORE_CONFIG` (exit 1) on the local path when `memhtml.config.json` doesn't decode (`apps/cli/src/v2.ts:916`).
- `ERR_GIT`, `ERR_INVALID_MEMORY`, or `ERR_STORAGE` (exit 1) from loading the base.

Failure: the sandbox writes nothing to disk, and a faulted attempt's partial tree is thrown away with its seed. Only the append touches the log. When the server's answer is lost, read `memhtml session status --id <id>` before running the script again, since the harvest may already be in the log.

## session commit

```
memhtml session commit --id s1 --message 'three facts about the checkout api'
memhtml session commit --id run-42 --message 'run 42' --drop-refused
memhtml session commit --id s1 --message 'three facts' --no-server
```

Lands the session's overlay on its ref as one commit, or says why it can't (`sessionCommit` at `apps/cli/src/v2.ts:1099-1151`). It reads the store policy first, so a policy file that doesn't decode fails here on either path (`apps/cli/src/v2.ts:1114-1116`). Then it asks the head server's `/v1/commit` route, unless `--no-server` is set, and commits here when the server didn't take the commit. Either way the commit is `commitOverHead` over the version at the session's base (`commitOverHead` at `apps/cli/src/v2.ts:944-996`), which calls `commitSession` (`commitSession` at `packages/session/src/commit.ts:427-582`). The whole commit holds the session's lock, and these are its steps:

0. A log that carries `pending` names a commit an earlier call built and may have landed before it was killed. Under the checkout lock, a `pending` the ref already reaches is answered `committed` with `recovered: true`. One it doesn't reach has any checkout update it made undone, and the commit goes on (`settlePending` at `packages/session/src/commit.ts:348-383`).
1. `validateOps` judges every op against the base, under the session's scope and the store's write bar. Any violation is `refused`, and nothing is written (`packages/session/src/commit.ts:495-500`).
2. A ref that moved past the base is `rebase-needed`, whether or not the changed paths overlap the session's, because a duplicate or a frame-key collision can sit on a different path (`packages/session/src/commit.ts:502-508`).
3. A put whose claim shares a frame key with another active record gets a `memhtml-contradicts` link to it. Both stay live (`markContradictions` at `packages/session/src/commit.ts:180-211`).
4. Blobs, the tree, and the commit object are written through a temporary index under the OS temp directory, removed on every exit (`withTemporaryIndex` at `packages/session/src/commit.ts:230-247`). The subject is `memhtml(session): <message>`, cut to 72 characters, with a `Memhtml-Session: <id>` trailer, and `memhtml(curate): …` for a session on a curate branch (`commitSubject` and `commitMessage` at `packages/session/src/commit.ts:68-80`).
5. The commit is saved to the log as `pending` before anything shared moves (`packages/session/src/commit.ts:536-537`).
6. `landOnRef` runs uninterruptibly under the checkout lock. It re-reads the ref and answers `rebase-needed` when it moved. When `HEAD` is the ref, uncommitted state at a path the commit touches is `worktree-dirty`, and otherwise `read-tree -m -u` moves the shared index and working tree. Then `update-ref` swaps the ref as a compare-and-swap, and a lost swap rolls the checkout back (`landOnRef` at `packages/session/src/commit.ts:284-333`). `worktree-dirty`, a lost race, and `checkout.locked` clear `pending`.
7. The log is saved on the new commit with zero ops (`packages/session/src/commit.ts:569-571`).

A `committed` outcome then writes the new commit's snapshot, best-effort (`apps/cli/src/v2.ts:983-986`). `docs/design.md` §17 covers the commit order and the conflict tiers, and §22 the server's commit route.

Flags:

- `--id` (string): "The session to commit. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."
- `--message` (string, required): "The commit summary. Rendered as `memhtml(session): <summary>` with a Memhtml-Session trailer. When HEAD is the session's ref, the shared index and working tree move to the new commit with it (`worktreeSynced: true`); uncommitted state at a path the commit writes or removes is answered `worktree-dirty` and nothing moves. A ref that moved past the session's base is `rebase-needed`: run `session rebase` and commit again. The checkout move and the ref swap run under the checkout lock `.memhtml/checkout.lock`, which every v1 write holds from its stage to its commit, so neither commits the other's files; the commit waits up to 15 s for it, then fails with ERR_STORAGE (`checkout.locked`) having moved nothing. The commit it builds is written to the log as `pending` before anything shared moves, so a call killed at any point is settled by the next `session commit`: `committed` with `recovered: true` when it had landed, else the checkout is put back and the commit is made again. A `committed` outcome also writes the new commit's snapshot (`snapshot`: path, bytes, ms, pruned; null when that best-effort write failed), so the next load hits the cache."
- `--drop-refused` (boolean): "On a `refused` outcome, drop every op that touches a path a violation names, record each in `.memhtml/sessions/<id>.dropped.jsonl`, and commit the rest; repeat until the commit is clean or nothing is left. `dropped` lists each removed op with its reasons. A batch-cap refusal names no path, so it is never dropped. Meant for a runtime's end-of-run commit, where there is no agent turn left to fix a line: an agent in a turn should read the refusal and rewrite the line instead."
- `--server` (boolean, default `true`): "Ask the head server on `.memhtml/head.sock` to commit (`memhtml head serve`); `--no-server` always commits here. The server reads the session's log, judges it against the version at the session's base from what it holds (its tip, an ancestor built from it, or a load for a base off its ref's history), runs the same commit this process would, one commit at a time, then holds the new commit and writes its snapshot; the payload is the same either way, with `via` `server` or `local` and `server` saying why (`used`, `base`, `reason`, `detail`). The commit runs here when no server accepts within 100 ms, when the server answers a 4xx (an older server without the route), or when it declines (`server.reason` `other-ref` for a session on a ref the server does not follow, `session-unreadable`, `base-unservable`, or `busy` after 20000 ms behind another commit). When the server took the commit and answered 5xx, or gave no answer within `MEMHTML_COMMIT_DEADLINE_MS` (60000 ms by default), the call fails with ERR_STORAGE naming `session status` and does not commit here, because the server may have moved the ref."

`--drop-refused` declares no default in the table, and an absent flag reads as false (`apps/cli/src/run.ts:2351`). Each round drops the ops at the paths the refusal names, rewrites the log without them, appends them to the `.dropped.jsonl` trail, and commits again. A round ends at a clean commit, an empty log, or a refusal no op carries, such as the batch cap (`apps/cli/src/v2.ts:965-982`, `opsToDrop` at `apps/cli/src/v2.ts:1165-1184`).

Response: `session.committed`.

A caller reads `kind` first. Every outcome carries `id`, `ref`, `baseSha`, `snapshot`, `dropped`, `via`, and `server` (`CommitResult` at `apps/cli/src/head-protocol.ts:734-764`, `SessionCommitted` at `apps/cli/src/v2.ts:1080-1083`). The payload has no `head`.

- `committed`: `sha`, `paths` (written or removed), `contradictions` (each `path` and `against`), `worktreeSynced` (true when `HEAD` is the ref and the checkout followed), and `recovered` (true when this call found an earlier call's `pending` commit on the ref and reports it, with empty `contradictions`). `snapshot` has `sha`, `path`, `bytes`, `rows`, `ms`, and `pruned`, or is null when the write failed (`CommitOutcome` at `packages/session/src/commit.ts:24-57`).
- `refused`: `violations`, each with its `kind` and `path` (`count` and `cap` for `batch-cap`). Nothing was written. Fix or drop the ops, or rebase when the violations come from a stale base.
- `rebase-needed`: `mainSha` (where the ref is now) and `overlapping` (the session's paths the ref's move changed). Run `session rebase`, then commit again. The command doesn't retry.
- `worktree-dirty`: `paths`, the uncommitted paths in the checkout that block the move. Nothing moved.
- `dropped`: every op `--drop-refused` took out, each with `kind`, `path`, and `reasons`. It's empty without the flag.

`via` is `server` or `local`. `server` says how the server was used: `used`, `base` (`tip`, `ancestor`, or `loaded`, for a base the server built off its ref's history), `reason`, and `detail` (`CommitServerUse` at `apps/cli/src/v2.ts:1006-1011`, `CommitBase` at `apps/cli/src/head-protocol.ts:772`). `reason` is `disabled` under `--no-server`, `no-server` when no connection completed, `refused` when the server answered a status below 500, or the server's own decline: `other-ref`, `session-unreadable`, `base-unservable`, or `busy` after 20 s behind another commit (`CommitDeclined` at `apps/cli/src/head-protocol.ts:782-787`, `COMMIT_QUEUE_WAIT_MS` at `apps/cli/src/head-protocol.ts:384`).

The server path falls back to the local commit only when nothing ran on the server. A connection that never completed, an answer below 500, and a decline all commit here. A server that took the commit and answered 500 or above, or gave no usable answer within `MEMHTML_COMMIT_DEADLINE_MS` (60000 ms by default, `0` for no bound), fails the call with `ERR_STORAGE` naming `session status`, because the server may have moved the ref (`unanswered` at `apps/cli/src/v2.ts:1047-1077`, `commitAnswerTimeoutMs` at `apps/cli/src/v2.ts:1021-1024`). An `ops` count of 0 in `session status` then means the commit landed. The server answers 500 for any failure inside the route, including a git or storage failure during the commit (`apps/cli/src/head-server.ts:1469-1476`).

Every outcome exits 0. Only a failure to run the commit at all is an error envelope.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for a malformed `MEMHTML_COMMIT_DEADLINE_MS`, which has to be a whole number of milliseconds (`apps/cli/src/run.ts:2204-2209`, `parseDeadlineMs` at `apps/cli/src/head-vectors.ts:57-68`).
- `ERR_STORE_CONFIG` (exit 1) when `memhtml.config.json` exists and doesn't decode, on either path.
- `ERR_STORAGE` (exit 1) when the server took the commit and failed or didn't answer in time, naming `session status`. Also as `checkout.locked` after 15 s behind another writer, `session.locked` when another call holds the id, `session.moved` when the log changed after this call read it, `session.read` for an id with no log, and `session.index` when no temporary index directory could be made (`requireLogUnmoved` at `packages/session/src/session.ts:311-319`, `packages/session/src/commit.ts:242`).
- `ERR_GIT` (exit 1) from a git step of the commit.

Failure: `refused` and `rebase-needed` write nothing. A failure before step 5 leaves the log and the ref as they were, and the temporary index is removed on every exit. A process killed after step 5 leaves `pending` in the log, and the next `session commit` settles it, reporting `recovered: true` when the commit had landed. A killed process can also leave `.memhtml/checkout.lock` behind, which goes stale after 10 s. A v1 write after that can commit the dead commit's staged files in its own commit, and settling `pending` leaves those committed bytes in place (`packages/session/src/commit.ts:340-345`). `--drop-refused` rewrites the log before each retry, so ops it dropped stay out of the log even when the retry fails, and they're kept in the `.dropped.jsonl` trail. A failed snapshot write is logged and reported as `snapshot: null`. The commit stands.

## session rebase

```
memhtml session rebase --id s1
memhtml session rebase --id s1 --no-server
```

Moves a session's base to its ref's tip, keeping every op (`sessionRebase` at `apps/cli/src/v2.ts:1229-1269`). Run it after a `rebase-needed` commit, then commit again. The head server's `/v1/rebase` route rebases onto the tip it holds, after the same advance check every answer makes, so no head is loaded here. Without the server, this process resolves the ref's tip, or `HEAD` when the ref doesn't resolve, loads that version, and rebases onto it (`apps/cli/src/v2.ts:1264-1268`). Both paths call `rebaseOver`, which moves the base and saves the log under the session's lock, only when the log still holds the ops this call read (`rebaseOver` at `apps/cli/src/v2.ts:1205-1220`, `saveSession` at `packages/session/src/session.ts:351-356`). Nothing is validated here. The next commit judges the kept ops against the new base.

Flags:

- `--id` (string): "The session to rebase. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."
- `--server` (boolean, default `true`): "Ask the head server on `.memhtml/head.sock` to rebase onto the tip it holds (`memhtml head serve`), so no head is loaded here; `--no-server` always loads the tip here. The rules are `session commit`'s: the payload is the same either way, `head.source` is `server` and `via` names the path, `server` says why, a 4xx or a decline rebases here, and a 5xx or no answer within `MEMHTML_COMMIT_DEADLINE_MS` fails with ERR_STORAGE rather than rebase again."

Response: `session.rebased`.

A caller reads `id`, `ref`, `from` (the old base), `baseSha` (the new one), `moved` (false when the base was already the tip), `ops` (kept), `head`, `via`, and `server` (`RebaseResult` at `apps/cli/src/head-protocol.ts:812-819`, `apps/cli/src/v2.ts:1250-1268`). Through the server, `server.base` is always `tip`. The fallback rules and the `MEMHTML_COMMIT_DEADLINE_MS` wait are `session commit`'s, through the same `unanswered` (`apps/cli/src/v2.ts:1238-1263`).

Errors:

- `ERR_INVALID_FLAG` (exit 2) for a malformed `MEMHTML_COMMIT_DEADLINE_MS`.
- `ERR_STORAGE` (exit 1) when the server took the rebase and failed or didn't answer in time, naming `session status`. Also as `session.read`, `session.locked`, or `session.moved` for the log.
- `ERR_INVALID_MEMORY` (exit 1) for a root with no commit, and `ERR_GIT` or `ERR_STORAGE` (exit 1) from loading the tip.

Failure: the only write is the log's, in one rename, so a failed rebase leaves the session on its old base with every op.

## session status

```
memhtml session status --id s1
```

Reads the session's log as persisted and where its ref stands relative to the base (`sessionStatus` at `apps/cli/src/v2.ts:1272-1298`). It loads no head and never asks the head server.

Flags:

- `--id` (string): "The session to describe. Defaults to $MEMHTML_SESSION; with neither, the call is ERR_MISSING_ARGUMENT."

Response: `session.status`.

A caller reads `id`, `ref`, `baseSha`, `refSha` (null when the ref doesn't exist yet), `behind` (true when the ref has moved past the base), `ops` and its counts by kind (`puts`, `archives`, `links`, `unlinks`, `labels`, `unlabels`, `moves`), `paths` (every path the ops touch, sorted), and `pending` (`apps/cli/src/v2.ts:1278-1297`). A non-null `pending` is a commit a killed call built, which the next `session commit` settles. After a commit that failed with a lost server answer, `ops: 0` means the commit landed.

Errors:

- `ERR_STORAGE` (exit 1) as `session.read` for an id with no log, `session.parse` or `session.decode` for a log that doesn't decode, and `session.id-mismatch` for a log naming another id (`decodeLog` at `packages/session/src/session.ts:270-287`).
- `ERR_GIT` (exit 1) when the ref can't be read.

Failure: `session status` writes nothing and takes no lock. The log is replaced by rename, so it never reads a half-written one.

## session prune

```
memhtml session prune --older-than 7d --dry-run
memhtml session prune --older-than 48h
```

Removes session state that nothing reads again and that's older than the cutoff (`sessionPrune` at `apps/cli/src/v2.ts:1328-1346`, `pruneSessions` at `packages/session/src/prune.ts:174-276`). It names no session, so `--id` and `MEMHTML_SESSION` don't apply (`apps/cli/src/run.ts:937-938`). Under `.memhtml/sessions/` it removes `<id>.idx` index files, stale `<id>.lock` directories, and `<id>.json` logs that hold zero ops, and it deletes refs under `refs/memhtml/sessions/`, which no commit of this build writes (`SESSION_REFS_PREFIX` at `packages/session/src/session.ts:80`). A log that still holds ops is never removed. It's listed under `unlanded` so an operator can land it.

Each id is handled under its own session lock, at most 16 at once. An id whose lock was refreshed inside the cutoff, or inside the 30 s stale window, is listed under `busy` and left alone, and so is one whose lock another writer takes first (`packages/session/src/prune.ts:227-249`, `SESSION_LOCK_STALE_MS` at `packages/session/src/session.ts:67`). A file counts by its mtime, and a ref by its commit's committer time. The refs go in one `update-ref --stdin` transaction after the files (`packages/session/src/prune.ts:251-255`).

Flags:

- `--older-than` (string, required): "The cutoff, as a duration with a unit: `7d`, `48h`, `90m`, `1.5h`, or `2 weeks`. A file counts by its last write, a ref by its commit's committer time; a lock directory also has to be stale (no refresh for 30 s), so a live writer's is never touched. Session state under `.memhtml/sessions/`: `<id>.idx` index files (a whole git index each, which no commit of this build reads or writes), `<id>.lock` directories a killed writer left (reclaimed otherwise only by the next writer of the same id, and a run's id is never written again), and `<id>.json` logs with zero ops (a session whose commit landed, or that never wrote). Every id is handled under its session lock, so a writer of it is never pruned from under; an id whose lock is held is listed under `busy`. A log that still holds ops is a run whose writes have not landed: it is kept and listed under `unlanded` with its `id`, `ops`, `pending`, `modifiedAt`, and `age`, so it can be landed with `session commit --id <id> --message <summary> --drop-refused`. A log that does not decode is kept and listed under `unreadable`. `<id>.dropped.jsonl` trails are kept."
- `--dry-run` (boolean, default `false`): "Report what a run would remove, with the same counts and lists, and remove nothing. Takes no lock."

The duration goes through `ms`. A bare number and a negative value are refused, so `--older-than 7` can't mean seven milliseconds (`parseOlderThan` at `apps/cli/src/v2.ts:1305-1322`).

Response: `session.pruned`.

A caller reads `dryRun`, `cutoff` (an ISO instant), `olderThanMs`, `olderThan` (as given), the counts `indexes` (with `bytes`), `refs`, `locks`, and `logs`, then `unlanded`, `busy`, and `unreadable` (`PruneReport` at `packages/session/src/prune.ts:65-80`, `apps/cli/src/v2.ts:1341-1345`). Each `unlanded` entry has `id`, `ops`, `pending`, `modifiedAt`, `ageMs`, and `age` in `ms`'s short form, oldest first.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for an `--older-than` that isn't a duration with a unit (`sessionPruneFlags` at `apps/cli/src/run.ts:1019-1030`).
- `ERR_GIT` (exit 1) when the refs can't be listed or deleted, such as on a root that isn't a git repository.

Failure: a file that can't be removed is skipped and left out of the counts (`removeQuietly` at `packages/session/src/prune.ts:118-125`). The files go before the refs, so a ref failure leaves the files already removed. `--dry-run` takes no lock, so its lists can differ from what a real run removes a moment later.

## head status

```
memhtml head status
memhtml head status --no-server
```

Reports the corpus version and where it came from (`headStatus` at `apps/cli/src/v2.ts:1353-1380`). With `--server` on, the default, it asks the head server's `GET /v1/status` first, and an answer becomes the payload with nothing loaded in this process (`apps/cli/src/v2.ts:1361-1376`). Otherwise it resolves HEAD and builds the version there the cheapest way that exists (`headSha` at `apps/cli/src/v2.ts:284-294`, `loadVersion` at `apps/cli/src/head-cache.ts:177-224`). That's HEAD's own snapshot at `.memhtml/snapshots/<sha>.arrow`, else the snapshot of an ancestor commit advanced over the memory paths that differ, else a full tree read from git. Ancestor snapshots are tried best first, by fewest changed paths and then the newer file (`ancestorSnapshots` at `apps/cli/src/head-cache.ts:94-119`). The command builds no app layer, so it opens no `index.db` and scaffolds nothing under the root (`isV2Command` at `apps/cli/src/run.ts:1228-1229`, `apps/cli/src/run.ts:2081`).

The ask treats every way of not getting a usable answer as no server (`askHeadFor` at `apps/cli/src/head-client.ts:148-219`, `askHead` at `apps/cli/src/head-client.ts:226-229`). That covers no socket file, a socket nobody listens on, any connect error, a connect that doesn't complete within 100 ms (`CONNECT_TIMEOUT_MS` at `apps/cli/src/head-client.ts:44`), an answer that doesn't arrive within 10 s (`ANSWER_TIMEOUT_MS` at `apps/cli/src/head-client.ts:51`), a status other than 200, and a body the schema refuses. A socket path past the platform's limit is never dialed (`apps/cli/src/head-client.ts:151-158`). In each case the command loads locally, so a server can speed the call up and can't make it fail.

Flags:

- `--server` (boolean, default `true`): "Ask the head server on `.memhtml/head.sock` first (`memhtml head serve`), falling back to loading the head here when no server accepts within 100 ms or answers within 10 s; `--no-server` always loads here. The payload's `head.source` is `server` when the server answered."

Response: `head.status`.

A caller reads `sha`, `records`, `skipped`, `loadMs`, `source`, `snapshotPath`, `ancestorSha`, `reparsed`, and `server` (`HeadStats` at `apps/cli/src/v2.ts:154-176`). On a local load (`loadHeadAt` at `apps/cli/src/v2.ts:217-237`), `sha` is HEAD's commit and `records` counts every record in the version, archived ones included (`viewOf` at `packages/head/src/indexes.ts:134-138`). `skipped` counts the candidate `.html` files the git read couldn't parse, and it's `null` when the version came from a snapshot, which holds records only. `loadMs` is the load's wall time. `source` is `snapshot`, `snapshot+advance`, or `git`, and `snapshotPath` names the file read, HEAD's own or the ancestor's, or `null` from git. `ancestorSha` and `reparsed` are set only under `snapshot+advance`, as the ancestor commit and the number of memory paths that differ between it and HEAD (`changedCandidates` at `apps/cli/src/head-cache.ts:72-79`). `server` is `null`.

When a server answered, `sha`, `records`, and `skipped` are the server's, `loadMs` is the round trip, `source` is `server`, and the three snapshot fields are `null` (`servedStats` at `apps/cli/src/v2.ts:201-210`). `server` is then the server's whole status (`HeadServerStatus` at `apps/cli/src/head-protocol.ts:497-526`). It carries `pid`, `root`, `socket`, the `ref` the server follows, the `sha` and `records` it holds after this request's advance, `loadSource` and `loadMs` of its first load, `lastAdvanceMs`, `advances`, `requests`, `uptimeMs`, `pollMs`, and `startedAt`. Three objects follow. `vectors` describes the vector cache the server holds, with `held`, `reason`, `entries`, `coverage`, `pending` (article texts with no vector yet), and `backfill` (`VectorCacheStatus` at `apps/cli/src/head-protocol.ts:440-452`). `embed` carries the query-embed deadline, the warmup idle bound, and the embed counters (`EmbedActivityStatus` at `apps/cli/src/head-protocol.ts:474-486`). `exec` carries the exec pool's `size`, `idle`, `busy`, `started`, `killed`, and `jobs` (`ExecPoolStatus` at `apps/cli/src/head-protocol.ts:456-463`).

Errors:

- `ERR_INVALID_MEMORY` (exit 1) when HEAD is unborn, so there's no commit to build a version from (`headSha` at `apps/cli/src/v2.ts:284-294`). Only the local path raises it.
- `ERR_GIT` (exit 1) when the root isn't a git repository or doesn't exist, from the HEAD read (`revParseHead` at `packages/store/src/git.ts:308-318`), and when a git read during the load fails. A snapshot that can't be read never fails the load. It counts as a miss, and the load tries the next source (`loadVersion` at `apps/cli/src/head-cache.ts:167-224`).

Failure: `head status` writes no snapshot and no state. A snapshot it tries that reads but isn't a cache of its sha, because it's garbage, truncated, of another format or schema, or names another sha in its metadata, is deleted with a warning so the next load doesn't pay to read it again (`cachedRecords` at `apps/cli/src/head-cache.ts:131-165`). A file that can't be read at all is left in place. Through a server, the status request can advance the server's held version, and the server then writes that version's snapshot in the background (`advance` at `apps/cli/src/head-server.ts:938-956`).

## head search

```
memhtml head search 'vip drain' --limit 5
memhtml head search 'vip drain' --no-server
```

Ranks the version at HEAD, or the head server's version of its ref when one answers (`headSearch` at `apps/cli/src/v2.ts:1399-1448`). With `--server` on it posts the query, the `--limit` when one is given, and, when `MEMHTML_EMBED_DEADLINE_MS` is set, that value as `embedDeadlineMs` to `/v1/search`. It falls back to a local search in every case `head status` falls back in (`apps/cli/src/v2.ts:1412-1432`). The local search loads the head as `head status` does and then prepares the vector arm in order of cost (`vectorsForQuery` at `apps/cli/src/head-vectors.ts:206-266`). The embedder switch reads nothing, the cache read touches the disk, and only a store with both pays for one query embed under the deadline (`embedWithin` at `apps/cli/src/head-vectors.ts:175-193`). The cache is `.memhtml/vectors/<model>@<dimension>.arrow`, which `head embed` writes (`loadForSearch` at `apps/cli/src/head-vectors.ts:147-161`).

The fold is `searchHead` over the active records (`packages/head/src/search.ts:211-264`). The lexical arm is BM25 with `k1` 1.2 and `b` 0.75 over each record's title, claim, and body text, kept to the best 40 (`lexicalArm` at `packages/head/src/search.ts:116-143`, `indexedText` at `packages/head/src/lexical.ts:105-106`, `LEXICAL_ARM_LIMIT` at `packages/head/src/search.ts:79`). The vector arm scores every active record that has a vector by cosine against the query vector, brute force, and keeps the best 40 (`vectorArm` at `packages/head/src/search.ts:173-184`). Equal scores inside an arm share one rank (`armRanks` at `packages/head/src/search.ts:98-110`). The arms fuse by reciprocal rank with `k` 60 and weight 1.0 each (`packages/head/src/search.ts:231-234`, `RRF_K` at `packages/domain/src/ranking.ts:8`). Recency only breaks exact ties. Hits with equal fused scores go newest first by `eventAt`, else `updatedAt`, and then by path (`byScoreThenNewerThenPath` at `packages/head/src/search.ts:155-166`). There's no salience arm and no MMR step, and no index database is opened. `docs/design.md` §16 has the reasoning.

Arguments:

- `<query>` (required): "Free text to rank against."

Flags:

- `--limit` (int, default `10`): "Hits to return."
- `--server` (boolean, default `true`): "Ask the head server on `.memhtml/head.sock` first (`memhtml head serve`), falling back to loading the head here when no server accepts within 100 ms or answers within 10 s; `--no-server` always loads here. The payload's `head.source` is `server` when the server answered."

Response: `head.search`.

A caller reads `query`, `hits`, `vector`, `searchMs`, and `head` (`apps/cli/src/v2.ts:1423-1447`). A hit carries `path`, `score`, `arms`, and `claim` (`SearchHit` at `packages/head/src/search.ts:46-55`). `score` is the fused reciprocal-rank sum, so a hit that one arm alone ranked first scores 1/61. `arms` names `lexical` and `vector` for the arms that ranked the hit, plus `recency` when its fused score equals the hit beside it, which is when recency or path placed it (`packages/head/src/search.ts:243-263`). `vector` reports the arm (`VectorUse` at `apps/cli/src/head-vectors.ts:93-109`). It holds `used`, and `reason`, which is `null` when the arm ran and otherwise one of `embedder-off`, `no-cache`, `cache-unreadable`, `embed-failed`, and `embed-timeout` (`VectorSkipReason` at `apps/cli/src/head-vectors.ts:40-51`). `detail` gives the failure's words for the last three. `cached` is the number of vectors in the cache, `coverage` is the share of the version's active records whose content hash has a vector, `loadMs` is the cache read (0 from a server, which holds the cache), and `embedMs` is the query embed. `searchMs` times the fold alone, in hundredths of a millisecond (`apps/cli/src/v2.ts:1443-1446`). `head` has the fields `head status` reports, without `server`, and with `source: "server"` and the round trip as `loadMs` when a server answered.

The query embed waits at most `MEMHTML_EMBED_DEADLINE_MS`, else 450 ms (`EMBED_DEADLINE_DEFAULT_MS` at `apps/cli/src/head-protocol.ts:123`), and `0` waits as long as the embed takes. Past the deadline the search answers from BM25 with `reason: "embed-timeout"`, and a local search stops the late embed (`stopLateEmbed` at `apps/cli/src/head-vectors.ts:83-87`). With the variable unset, a search through a server gets the server's deadline. Only `head search` and `head serve` read the variable (`apps/cli/src/run.ts:2161-2167`). The vector arm never fails the call. Every reason it can't run degrades `vector` and leaves the BM25 answer.

A cache file whose format key names another format reads as absent and reports `no-cache` (`readVectorCache` at `packages/snapshot/src/vectors.ts:203-249`). A file of another vector space, a corrupt file, or one with other columns reports `cache-unreadable` with the reader's refusal as `detail`.

`head search` takes no scope flags. It searches every active record, tasks included. `--limit` has no clamp, and `0` or a negative value returns no hits (`packages/head/src/search.ts:255-256`). A query with no indexed term returns no hits when the vector arm doesn't run. When it runs, cosine scores every active record that has a vector, so up to 40 hits can come back on meaning alone.

Errors:

- `ERR_INVALID_FLAG` (exit 2) when `MEMHTML_EMBED_DEADLINE_MS` isn't a whole number of milliseconds. The refusal names the variable, and nothing is opened (`msFromEnv` at `apps/cli/src/run.ts:2144-2160`, `parseDeadlineMs` at `apps/cli/src/head-vectors.ts:57-68`).
- `ERR_INVALID_MEMORY` (exit 1) when HEAD is unborn, on the local path (`headSha` at `apps/cli/src/v2.ts:284-294`).
- `ERR_GIT` (exit 1) when the root isn't a git repository, or a git read during the load fails.

Failure: a local `head search` writes nothing, apart from deleting a snapshot it can't use, as `head status` does. Through a server, the request can advance the server's version, and an embed past its deadline may keep running in the server after the answer.

## head serve

```
memhtml head serve
memhtml head serve --ref main --poll-ms 500
```

Holds the head loaded and answers lookups over the store's socket until SIGTERM or SIGINT (`serveHead` at `apps/cli/src/head-server.ts:1626-1655`). `docs/design.md` §22 covers the protocol, the consistency rule, commit and exec, and the embed path in depth. The start runs in a fixed order (`startHeadServer` at `apps/cli/src/head-server.ts:535-1589`). It refuses a socket path past the platform's limit before it loads anything (`refuseLongSocket` at `apps/cli/src/head-server.ts:474-491`). It picks the ref to follow, which is `--ref` with `refs/heads/` prepended when it doesn't start with `refs/`, else the branch HEAD points at, else `refs/heads/main` (`followedRef` at `apps/cli/src/head-server.ts:522-525`). It resolves the ref's tip and loads that version the cheapest way, as `head status` does (`apps/cli/src/head-server.ts:587-595`). It starts the exec pool with one warm worker (`apps/cli/src/head-server.ts:706-710`). Then it claims the socket, reads the vector cache when an embedder is bound, binds, and starts the background fill, the poll, and the warmup (`apps/cli/src/head-server.ts:1479-1586`). Once it listens it logs one line to stderr and waits for a signal.

The socket is `.memhtml/head.sock`, carrying JSON over HTTP, and the server never opens a TCP port (`headEndpoint` at `apps/cli/src/head-protocol.ts:60-66`). It's bound with the umask narrowed to `0177` and then set to mode `0600`, so no other user can reach it even for an instant (`apps/cli/src/head-server.ts:1499-1526`). The server adds `.memhtml/head.sock` to `.git/info/exclude` before the bind. A socket file already there is probed first (`claimSocket` at `apps/cli/src/head-server.ts:497-519`, `probeSocket` at `apps/cli/src/head-server.ts:430-468`). A connect that completes, or that neither completes nor refuses within 100 ms, means a live server, and this one refuses. `ECONNREFUSED` means a killed server left the file, and it's replaced with a warning. The path limit is counted in UTF-8 bytes, 107 on Linux and Android and 103 on every other POSIX platform (`socketPathMax` at `apps/cli/src/head-protocol.ts:84-87`). Under win32 the server listens on the named pipe `\\.\pipe\memhtml-<the first 16 hex digits of the SHA-256 of the resolved store path>` instead, which has no file, mode, or length limit (`headPipeName` at `apps/cli/src/head-protocol.ts:54-57`).

The seven routes share the `/v1/` prefix (`HEAD_ROUTES` at `apps/cli/src/head-protocol.ts:21-29`), and every request body is decoded with unknown fields refused (`app` at `apps/cli/src/head-server.ts:1353-1477`). `GET /v1/status` answers the status `head status` shows under `server`. `POST /v1/search` runs `head search`'s fold over the held version with the held cache, and the MCP server's `memory_search` and `memory_recall` call it too, with a scope and per-hit detail (`ask` at `apps/cli/src/head-retrieval.ts:93-110`). `POST /v1/read` answers one record by path. `POST /v1/neighbors` computes what `session put` checks before it appends, at the commit the request names. `POST /v1/exec` runs a `session exec` script and appends its harvest. `POST /v1/commit` runs `session commit`, and `POST /v1/rebase` moves a session's base to the held tip. An unknown route answers 404 with `ERR_UNKNOWN_COMMAND`, a body that isn't JSON or has an unknown field answers 400 with `ERR_INVALID_FLAG`, and a typed failure answers 500 with the CLI's failure envelope.

Before it answers status, search, read, exec, commit, or rebase, the server reads the ref with one `rev-parse` (`fresh` at `apps/cli/src/head-server.ts:959-969`). When the ref moved, it advances the held version over the changed paths under one permit, so an answer is never older than the ref at the moment of the request (`advance` at `apps/cli/src/head-server.ts:938-956`). `/v1/neighbors` answers at the commit its request names (`versionAt` at `apps/cli/src/head-server.ts:995-999`). Every `--poll-ms` milliseconds the poll does the same read between requests, and `--poll-ms 0` leaves advancing to requests alone (`apps/cli/src/head-server.ts:1532-1548`). After each advance the new version's snapshot is written in the background unless the file exists (`cache` at `apps/cli/src/head-server.ts:916-932`). A ref that stops resolving leaves the server answering at the version it holds.

With an embedder bound, the server holds the vector cache `head embed` writes. Before each answer that uses it and after each poll it stats the file, and a changed inode, size, or mtime makes it read the file again (`heldVectors` at `apps/cli/src/head-server.ts:732-753`). With `MEMHTML_EMBED=off` the arm is off with `embedder-off`, and the server never reads the file. A search waits for its query embed at most the request's `embedDeadlineMs`, else `MEMHTML_EMBED_DEADLINE_MS`, else 450 ms, and past it answers `embed-timeout` (`apps/cli/src/head-server.ts:550`, `apps/cli/src/head-server.ts:1369-1377`). One late embed is left to finish in the background, and any other is interrupted (`late` at `apps/cli/src/head-server.ts:760-791`, `LATE_EMBEDS_MAX` at `apps/cli/src/head-protocol.ts:494`). The warmup is off by default (`EMBED_WARM_IDLE_DEFAULT_MS` at `apps/cli/src/head-protocol.ts:140`). With `MEMHTML_EMBED_WARM_IDLE_MS` above 0, an embedder, and a held cache, the server issues one one-token query embed whenever no embed has ended for that long and none is in flight (`apps/cli/src/head-server.ts:1557-1586`). When the start, an advance, or a commit here brings records the held cache has no vector for, a background fill embeds them 96 at a time and writes the cache file the way `head embed` does (`fillPass` at `apps/cli/src/head-server.ts:818-887`, `BACKFILL_BATCH_MAX` at `apps/cli/src/head-protocol.ts:430`). The fill runs only while a cache is held, so a store nobody has run `head embed` on gets none. A failed batch is retried on the next advance, warmup tick, or poll.

`/v1/exec` runs each script in a pool of worker threads, so a busy script never holds the thread that answers lookups (`makeExecPool` at `apps/cli/src/exec-pool.ts:137-319`). `MEMHTML_EXEC_POOL_SIZE` workers run at once. Unset, that's one fewer than `os.availableParallelism()`, at least 1 and at most 4 (`defaultExecPoolSize` at `apps/cli/src/exec-pool.ts:60-61`). Each worker's old-generation heap is capped at `MEMHTML_EXEC_WORKER_HEAP_MB`, 2048 by default (`WORKER_HEAP_MB` at `apps/cli/src/exec-pool.ts:67`). A worker still running at the run's deadline is terminated, and the run answers `exitCode` 124 with nothing harvested (`apps/cli/src/exec-pool.ts:271-285`). Execs of one session run one at a time. A wait of more than 30 s for that session's earlier exec, or for a free worker, is declined `busy`, and the client runs the script itself (`oneAtATime` at `apps/cli/src/head-server.ts:1059-1079`, `EXEC_QUEUE_WAIT_MS` at `apps/cli/src/head-protocol.ts:315`). A body past 1 MiB answers 413 (`EXEC_BODY_MAX_BYTES` at `apps/cli/src/head-protocol.ts:292`).

`/v1/commit` reads the session's log and the store's policy per request, judges the session against the version at its base, and runs the same commit the CLI runs locally (`serveCommit` at `apps/cli/src/head-server.ts:1264-1290`). The base version is the held tip, an ancestor built from it, or, for a base off the ref's history, a loaded version (`commitBase` at `apps/cli/src/head-server.ts:1145-1171`). A committed outcome moves the held version to the new commit and writes its snapshot before the answer, so the next request pays no load (`landed` at `apps/cli/src/head-server.ts:1205-1230`). One commit or rebase runs at a time. A request that waits more than 20 s for the permit is declined `busy` having done nothing, and a commit that started runs to its end whatever interrupts its request (`holdingPermit` at `apps/cli/src/head-server.ts:385-396`, `COMMIT_QUEUE_WAIT_MS` at `apps/cli/src/head-protocol.ts:384`). A session on another ref is declined `other-ref`, and one whose log doesn't read is declined `session-unreadable` (`sessionToWrite` at `apps/cli/src/head-server.ts:1244-1261`). After any decline the client commits or rebases locally. The curate commands always load locally (`apps/cli/src/v2.ts:141`).

The first SIGTERM or SIGINT stops the server (`untilSignal` at `apps/cli/src/head-server.ts:1608-1620`). Closing gives requests in flight 2 s (`SHUTDOWN_GRACE` at `apps/cli/src/head-server.ts:262`), stops the poll and the warmup, terminates the exec workers, and removes the socket file last (`apps/cli/src/head-server.ts:1488`).

Flags:

- `--ref` (string): "The ref to follow, as a branch name or a full ref; `refs/heads/` is prepended when absent. Default: the branch HEAD points at, else `main`."
- `--poll-ms` (int, default `1000`): "How often the server reads the ref between requests, in milliseconds; 0 leaves advancing to requests alone. Every request reads the ref regardless."

Response: `head.served`.

The envelope is written once, after the signal, at exit 0 (`apps/cli/src/run.ts:2285-2297`, `apps/cli/src/run.ts:2375`). A caller reads `socket`, `ref` (the full ref followed), `sha` (the held version's commit at the stop), `records`, `signal`, `loadSource` and `loadMs` (the first load), `advances` (one per observed ref move), `requests`, and `uptimeMs` (`HeadServed` at `apps/cli/src/head-server.ts:1592-1605`). While it serves, stderr carries the listening line, every advance, and every warning.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for a negative or non-integer `--poll-ms` or a blank `--ref` (`headServeFlags` at `apps/cli/src/run.ts:1057-1075`). The same code answers a malformed `MEMHTML_EMBED_DEADLINE_MS` or `MEMHTML_EMBED_WARM_IDLE_MS`, a `MEMHTML_EXEC_POOL_SIZE` outside 1 to 64, and a `MEMHTML_EXEC_WORKER_HEAP_MB` outside 64 to 65536, each naming the variable (`apps/cli/src/run.ts:2161-2167`, `apps/cli/src/run.ts:2191-2203`, `parsePoolSetting` at `apps/cli/src/exec-pool.ts:83-95`). Nothing is opened.
- `ERR_HEAD_SERVER_RUNNING` (exit 1) when a live server holds the socket. The message names its pid, ref, and sha from that server's own status, and the suggestion is `memhtml head status` (`claimSocket` at `apps/cli/src/head-server.ts:497-519`, `apps/cli/src/errors.ts:85-86`). The claim runs after the load, so the second process pays for a full load before it refuses.
- `ERR_STORAGE` (exit 1) for a socket path past the limit, as `HeadSocketPathTooLong` with `socket`, `bytes`, `max`, and `platform`, raised before anything loads (`HeadSocketPathTooLong` at `apps/cli/src/head-protocol.ts:852-860`, `apps/cli/src/errors.ts:89-90`). The suggestions are `memhtml head status --no-server` and a shorter store path, and every client on that store loads locally.
- `ERR_STORAGE` (exit 1) as `head.serve.ref` when the ref doesn't resolve, which includes an unborn HEAD (`apps/cli/src/head-server.ts:590-594`). It's also `head.serve.notSocket` when another kind of file holds the socket path, `head.serve.probe` for a probe error other than `ECONNREFUSED` and `ENOENT`, and `head.serve.listen` when the bind fails.
- `ERR_GIT` (exit 1) when the root isn't a git repository, from its first git call (`headRefOf` at `apps/cli/src/curate-run.ts:276-285`), or when a git read during the load fails.

Failure: a start refused for the socket path, the ref, or a live server leaves the store as it was, and a live server keeps its socket. A server stopped by a signal removes its socket file. One killed with SIGKILL leaves `.memhtml/head.sock` behind. Clients then get `ECONNREFUSED` and load locally, and the next `head serve` replaces the file. A background snapshot or vector cache write cut by the kill can leave a staging file `<file>.<number>`, which the next write of that cache sweeps once it's an hour old (`STAGING_ABANDONED_MS` at `packages/snapshot/src/staging.ts:25`). A kill during a `/v1/commit` leaves the session's `pending` commit for that session's next commit to settle (`packages/session/src/commit.ts:336-346`), and a checkout lock left behind goes stale after 10 s (`CHECKOUT_LOCK_STALE_MS` at `packages/contracts/src/checkout-lock.ts:42`). The signal handlers are installed only once the server listens, so a signal during the load ends the process with no envelope (`apps/cli/src/head-server.ts:1634-1639`).

## head embed

```
memhtml head embed
```

Fills the vector cache for the version at HEAD (`headEmbed` at `apps/cli/src/v2.ts:1454-1464`, `embedHead` at `apps/cli/src/head-vectors.ts:351-401`). It loads the head locally as `head status --no-server` does and never asks a server. It reads `.memhtml/vectors/<model>@<dimension>.arrow`, where an absent file is an empty cache, embeds every active record whose content hash the cache lacks in one embed call, and writes the file back when anything was added. The space is the configured embedder's model id at its dimension, so the file for Cohere Embed v4 at 1024 floats is `.memhtml/vectors/cohere.embed-v4_0@1024.arrow` (`HEAD_VECTOR_SPACE` at `apps/cli/src/head-vectors.ts:35`, `vectorCachePathFor` at `packages/snapshot/src/vectors.ts:87-92`). A record embeds its article's body text, trimmed and cut at 1,800 characters (`vectorTextOf` at `packages/head/src/vectors.ts:33-34`). Two records sharing a content hash cost one embed, archived records and empty articles are skipped, and entries for hashes the version doesn't hold stay (`fillVectors` at `packages/head/src/vectors.ts:97-153`). The write adds `.memhtml/vectors/` to `.git/info/exclude`, lands through a staging file renamed into place, and sweeps this cache's staging files older than an hour (`writeVectorCache` at `packages/snapshot/src/vectors.ts:173-186`). A running head server with an embedder bound reads the new file on its next request or poll (`heldVectors` at `apps/cli/src/head-server.ts:732-753`).

This command takes no arguments and no flags (`apps/cli/src/commands.ts:1516-1524`).

Response: `head.embedded`.

A caller reads `sha`, `path`, `modelId`, `dimension`, the fill counts, `cached`, `bytes`, `written`, the timings, and `head` (`apps/cli/src/v2.ts:1463`, `HeadEmbedded` at `apps/cli/src/head-vectors.ts:324-342`). The counts are over the version's active records (`FillCounts` at `packages/head/src/vectors.ts:60-69`). `records` is the active records, `reused` is those whose content hash already had a vector, `embedded` is the distinct texts sent to the embedder, and `empty` is the active records with no text. `cached` is the vectors in the file after the call, including ones for records outside the version, and `bytes` is the file's size. `written` is `false` when every active record was already covered and the file was left alone (`apps/cli/src/head-vectors.ts:378-387`). With no cache file it writes one even when nothing needed a vector. `loadMs`, `embedMs`, `saveMs`, and `ms` time the cache read, the embed call, the write, and the whole fill. `head` is the `HeadStats` of the load.

A cache whose format key names another format reads as absent, so the call embeds every active record and rewrites the file whole (`packages/snapshot/src/vectors.ts:218-224`). A file with no format key reads as format 1.

Errors:

- `ERR_MODEL_UNAVAILABLE` (exit 1) with `MEMHTML_EMBED=off`, after the head load and before the cache is read (`apps/cli/src/head-vectors.ts:357-366`), and when the embed call fails. The suggestions are `retry: search still works on the lexical floor` and `memhtml status` (`apps/cli/src/errors.ts:229`).
- `ERR_STORAGE` (exit 1) when the cache file can't be read, doesn't decode, names another vector space in its metadata (`vectors.read.space`), or has other columns (`readVectorCache` at `packages/snapshot/src/vectors.ts:203-249`). The file is left for the operator to delete, because it may belong to another space whose name sanitizes to the same one. A failed write is `ERR_STORAGE` too.
- `ERR_INVALID_MEMORY` (exit 1) when HEAD is unborn (`headSha` at `apps/cli/src/v2.ts:284-294`).
- `ERR_GIT` (exit 1) when the root isn't a git repository, or a git read during the load fails.

Failure: the file is written once, after every vector came back, so a failed or interrupted call leaves the cache as it was, and a rerun embeds the whole gap again. The rename means a reader never sees half a cache. A killed run can leave a staging file `<file>.<number>`, which the next write of this cache sweeps once it's an hour old (`STAGING_ABANDONED_MS` at `packages/snapshot/src/staging.ts:25`). `head embed` and the head server's background fill can write at once, and the last rename wins.

## head snapshot

```
memhtml head snapshot --write
memhtml head snapshot --read
```

Writes or reads the cold-start cache for the commit HEAD names (`headSnapshot` at `apps/cli/src/v2.ts:1471-1490`). `--write` builds the version from git and never from a snapshot, so a stale file can't re-cache itself (`apps/cli/src/v2.ts:1476`). It then writes `.memhtml/snapshots/<sha>.arrow` (`writeHeadSnapshot` at `apps/cli/src/head-cache.ts:242-260`). That adds `.memhtml/snapshots/` to `.git/info/exclude`, writes one Arrow IPC file with a row per record and the sha and format `"1"` in the schema metadata (`SNAPSHOT_FORMAT` at `packages/snapshot/src/snapshot.ts:61`, `tableOf` at `packages/snapshot/src/snapshot.ts:274-297`), and renames it into place from a staging file with no `fsync` (`writeSnapshot` at `packages/snapshot/src/snapshot.ts:330-345`). Last it prunes the directory to the newest four snapshots by mtime and sweeps staging files older than an hour (`pruneSnapshots` at `packages/snapshot/src/prune.ts:82-100`, `SNAPSHOTS_KEPT` at `packages/snapshot/src/prune.ts:20`). `--read` opens HEAD's file and decodes every row (`readSnapshot` at `packages/snapshot/src/snapshot.ts:504-509`).

Every ref-moving v2 commit writes this file itself (`snapshotAfterCommit` at `apps/cli/src/head-cache.ts:270-288`). The command is for a store whose HEAD moved by other means, such as a v1 write or a pull.

Flags:

- `--write` (boolean, default `false`): "Build the head from git and write its snapshot. Exactly one of --write / --read."
- `--read` (boolean, default `false`): "Open HEAD's snapshot and report its row count and sha. Exactly one of --write / --read."

Response: `head.snapshot`.

A caller reads `mode`, `sha`, `path`, and `rows` in both modes, plus `bytes`, `ms`, and `pruned` under `--write` (`apps/cli/src/v2.ts:1478-1489`). `pruned` lists the shas the prune removed, newest first. Under `--read`, `sha` is the sha the file's metadata names, and the command doesn't compare it with HEAD.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for both `--write` and `--read`, and `ERR_MISSING_ARGUMENT` (exit 2) for neither (`headSnapshotFlags` at `apps/cli/src/run.ts:1032-1049`).
- `ERR_STORAGE` (exit 1) from `--read` when HEAD's file is missing (`snapshot.read.file`) or isn't a snapshot this build reads. That's `snapshot.read.decode` for a file that isn't Arrow IPC or is truncated, `snapshot.read.format` for another format, `snapshot.read.sha` for no sha, `snapshot.read.schema` for other columns, and `snapshot.read.rows` for a null where the schema allows none (`packages/snapshot/src/snapshot.ts:495-509`). A head load treats the same file as a miss and deletes it, and `--read` leaves it in place.
- `ERR_STORAGE` (exit 1) from `--write` when the encode, the directory, the file write, or the prune fails.
- `ERR_INVALID_MEMORY` (exit 1) when HEAD is unborn, in both modes (`headSha` at `apps/cli/src/v2.ts:284-294`).
- `ERR_GIT` (exit 1) when the root isn't a git repository, or a git read during `--write`'s load fails.

Failure: `--read` writes nothing. `--write` replaces any file for that sha by rename, so a reader never sees half a snapshot, and a failed write leaves the old file. write-file-atomic removes its staging file when the write fails or the process exits on a signal. A process killed outright leaves `<sha>.arrow.<number>`, which the next prune sweeps once it's an hour old (`sweepStaging` at `packages/snapshot/src/staging.ts:33-72`). A failed prune fails the call after the new file is in place.

## curate merge

```
memhtml curate merge curate/2026-09-23
memhtml curate merge refs/heads/curate/2026-09-23 --into main
memhtml curate merge curate/2026-09-23 --skip-gate
```

Lands a curator branch on its target, `main` by default (`curateMerge` at `apps/cli/src/v2.ts:1624-1765`). It's the one command that moves `main` to what a curator committed. It reads the store policy, qualifies both names with `refs/heads/`, and resolves both refs. Then, in order, refusals first, the gate second, and movement last:

1. When the target is an ancestor of the branch, the landing is a fast-forward. Otherwise the target moved past the branch's base, and the landing is a replay. The branch's changes since the merge base are rebuilt as session operations from the two trees, a fresh session `merge-<short sha>` is started on the target's tip with those ops, and `validateOps` judges them under the `curate` scope with no batch cap (`replayPlan` at `apps/cli/src/v2.ts:1551-1585`, `apps/cli/src/v2.ts:1663-1688`, `reconstructOps` at `apps/cli/src/replay.ts:135-188`). A change that isn't an operation, or any violation, refuses the merge naming the paths, with nothing moved.
2. The head gate loads the version at the target's tip and at the branch's tip and scores the same probes at both: up to 200 records active in both, sampled by a seeded digest of their paths and each queried by its title. It passes when the landed MRR is at least the base's minus 0.02 and the inversions didn't grow. An inversion is a probe whose target is outside the top 10, or a record the target supersedes ranking above it (`headGate` at `apps/cli/src/head-gate.ts:93-109`, `gateHeads` at `packages/head/src/gate.ts:198-235`, `HEAD_GATE_PROBES` at `packages/head/src/gate.ts:31-34`). It's deterministic and makes no model call. `--skip-gate` skips it with a logged warning (`apps/cli/src/v2.ts:1690-1699`).
3. A fast-forward lands through `landOnRef` under the checkout lock. The target must still be where it was read, the checkout follows when `HEAD` is the target, and the ref swap is a compare-and-swap (`apps/cli/src/v2.ts:1730-1750`). Then the landed version's snapshot is written (`apps/cli/src/v2.ts:1752-1753`).
4. A replay lands through `commitSession` with the subject `memhtml(curate): <the branch tip's subject> (replayed onto <short sha>)`, retrying on `rebase-needed` up to 8 times. Once it lands, the curator ref is moved to the landed commit, so a re-run answers `moved: false` (`landReplay` at `apps/cli/src/v2.ts:1771-1852`, `MERGE_ATTEMPTS` at `apps/cli/src/v2.ts:1535`).

`docs/design.md` §23 covers the curation door, and §16 covers the head gate.

Arguments:

- `<ref>` (required): "The curator branch, as `curate/2026-09-23` or `refs/heads/curate/2026-09-23`; `refs/heads/` is prepended when absent. Refused (ERR_INVALID_MEMORY) when it does not exist. When --into has moved past the branch's base, the landing is a replay: the branch's changes since the merge base are read back as session operations and committed onto --into under the curate scope, `memhtml(curate): <subject> (replayed onto <sha>)`, and the payload's `replayed` names the base, the op counts, the attempts, and the branch's original tip (`null` on a fast-forward). Refused (ERR_INVALID_MEMORY, nothing moved) when the branch carries a change that is not an operation (an article edited in place, a file deleted with no archive twin, a link removed, a meta changed), named by path, or when the ops collide with what --into gained meanwhile (`duplicate`, `claim-edit`, a link whose target is gone)."

Flags:

- `--into` (string, default `"main"`): "The branch to fast-forward, `refs/heads/` prepended when absent. When HEAD is this branch and the checkout is clean at every path the landing changes, the shared index and working tree move with it (`worktreeSynced: true`); an uncommitted edit at one of those paths is refused (ERR_DIRTY_TREE) and nothing moves."
- `--skip-gate` (boolean, default `false`): "Land without running the head gate. A deliberate, logged override, never a default. The gate loads the version at --into and the version at the ref, probes a seeded sample of the records active in both by their titles, and refuses (ERR_DISCRIMINATION_FAILED, nothing moves) when the landed version's MRR falls more than the tolerance below the base's or its inversions grow; the payload's `gate` carries mode `head`, probes, mrr, mrrBefore, floor, and inversions."

The argument's description lists a removed link among the refusals. The replay rebuilds a link removed on the branch as an `unlink` op through the same harvester `session exec` uses, so it lands (`reconstructOps` at `apps/cli/src/replay.ts:135-188`). An article edited in place, a deleted file with no archive twin, and a changed title or non-entity meta are refused.

Response: `curate.merged`.

A caller reads `moved` first, then `ref`, `into`, `from` (the target before), `to` (the target after), `gate`, `worktreeSynced`, `replayed`, and `snapshot` (`CurateMerged` at `apps/cli/src/v2.ts:1513-1532`). `moved: false` means there was nothing to land. `gate` has `ran` and `passed`, and for the head gate `mode: "head"`, `mrr`, `mrrBefore`, `mrrFloor`, `floor`, `probes`, `inversions`, `inversionsBefore`, `base`, and `landed` (`GateReport` and `gateReportOf` at `apps/cli/src/head-gate.ts:31-82`). Under `--skip-gate` it's `{ran: false, passed: null}`. `replayed` is null on a fast-forward, and after a replay it has `base` (the merge base), `ops` (counts by kind), `attempts`, and `originalTip` (`ReplayReport` at `apps/cli/src/v2.ts:1493-1510`).

Errors:

- `ERR_INVALID_FLAG` (exit 2) for a blank `--into`, or a ref and target that qualify to the same name (`curateMergeFlags` at `apps/cli/src/run.ts:843-860`).
- `ERR_INVALID_MEMORY` (exit 1) when the branch or the target doesn't exist, the two share no history, the branch carries a change that isn't an operation, the replayed ops are refused, the target moved during a fast-forward, or the target moved 8 times during a replay (`apps/cli/src/v2.ts:1640-1655`, `apps/cli/src/v2.ts:1744-1750`, `apps/cli/src/v2.ts:1847-1851`).
- `ERR_DISCRIMINATION_FAILED` (exit 1) when the head gate refuses. The suggestions are a `head search` for a probe that fell out and the `--skip-gate` form (`HeadGateFailed` at `apps/cli/src/errors.ts:79-80`, `apps/cli/src/errors.ts:239-242`). The failure envelope carries no `data`, so the gate's numbers are only in its message and on stderr.
- `ERR_DIRTY_TREE` (exit 1) when `HEAD` is the target and an uncommitted edit sits at a path the landing changes (`apps/cli/src/v2.ts:1741-1743`).
- `ERR_STORE_CONFIG` (exit 1) when `memhtml.config.json` doesn't decode, and `ERR_STORAGE` (exit 1) as `checkout.locked` after 15 s behind another writer.
- `ERR_GIT` (exit 1) from a git step.

Failure: every refusal and a failing gate come before anything moves. A fast-forward moves the checkout and the ref as one section, and a lost swap rolls the checkout back. A replay commits through the session commit path, so it shares that path's `pending` recovery, and its `merge-<short sha>` session log stays under `.memhtml/sessions/` with zero ops after it lands. A failed snapshot write is logged and reported as `snapshot: null`. The landing stands. When the curator commits again while its replay lands, the curator ref is left where its writer put it, with a warning.

## curate run

```
memhtml curate run --model fake
memhtml curate run --model bedrock:global.anthropic.claude-opus-5 --max-steps 60
memhtml curate run --ref curate/2026-09-23 --model proxy:global.anthropic.claude-opus-5 --resume
```

Runs the curator. A model works through a briefing inside one session on a `curate/` branch, and what it proposes is committed to that branch (`curateRun` at `apps/cli/src/curate-run.ts:529-679`). `@memhtml/curator` owns the loop, the charter, the budget, and the model factory, and this command binds the loop's tools to the head, the session, and the sandbox. `docs/design.md` §23 covers the design. A run goes through these steps.

1. `run` judges the argv before anything opens. `curateRunFlags` checks `--ref`, the shape of `--model`, and the two budgets (`apps/cli/src/run.ts:879-920`). The v2 branch then resolves the model from `--model`, else `MEMHTML_CURATOR_MODEL`, else `proxy:global.anthropic.claude-opus-5` when `MEMHTML_LLM_BASE_URL` is set, still at exit 2 and before any repo opens (`apps/cli/src/run.ts:2211-2263`, `DEFAULT_CURATOR_MODEL_ID` at `packages/curator/src/model.ts:31`). The command builds no app layer and never opens `index.db` (`isV2Command` at `apps/cli/src/run.ts:1228-1229`). It doesn't read `MEMHTML_SESSION`, because its session is always the one its ref names.
2. The ref and the session id come from `--ref`. A name that doesn't start with `refs/` gets `refs/heads/` in front (`qualifyRef` at `apps/cli/src/v2.ts:278-281`). An absent or blank `--ref` is `curate/<UTC date>` from the clock (`defaultCurateRef` at `apps/cli/src/curate-run.ts:130-131`, `apps/cli/src/curate-run.ts:543-545`). The session id is the ref without `refs/heads/`, with slashes as dashes, so `refs/heads/curate/2026-09-23` is session `curate-2026-09-23` (`curateSessionId` at `apps/cli/src/curate-run.ts:137-140`).
3. `curateRun` judges the ref again. A ref outside `refs/heads/curate/` is refused a second time for a caller that skips the CLI, and the branch `HEAD` points at is refused because a commit there would move the working tree (`curateRefProblem` at `apps/cli/src/curate-run.ts:121-127`, `headRefOf` at `apps/cli/src/curate-run.ts:276-285`, `apps/cli/src/curate-run.ts:550-561`).
4. The store's policy is read once for the run from `memhtml.config.json`, or the library defaults when the file is absent (`loadStorePolicy` at `apps/cli/src/store-config.ts:64-93`, `apps/cli/src/curate-run.ts:565`).
5. The charter is a template. The command reads the shipped `packages/curator/prompts/charter.md`, fresh on every run, or the `--charter` file in its place (`CURATOR_CHARTER` at `packages/curator/src/charter.ts:40-43`, `charterFor` at `apps/cli/src/curate-run.ts:165-177`). `renderCharter` fills `{{placementQuota}}` with `curator.placementQuota`, and fills `{{refusedTypesRule}}` and `{{refusedTypesClause}}` with a sentence and a clause naming `writeBar.refusedTypes`, or with nothing when the store refuses no type (`packages/curator/src/charter.ts:100-109`). Any other text, another `{{...}}` included, is used as written.
6. The model is built, and nothing is called yet (`curatorModel` at `packages/curator/src/model.ts:138-152`). `fake` is a scripted model that needs no credentials. `bedrock:<id>` goes through `@ai-sdk/amazon-bedrock` with the region from `AWS_REGION` (`us-east-1` when unset) and the default AWS credential chain, unless `AWS_BEARER_TOKEN_BEDROCK` is set (`bedrockModel` at `packages/curator/src/model.ts:86-92`). `AWS_REGION` isn't one of the CLI's `CONFIG_VARS`, and the CLI's own `MEMHTML_AWS_REGION` doesn't reach this client (`CONFIG_VARS` at `apps/cli/src/config.ts:107-275`, `MEMHTML_AWS_REGION` at `apps/cli/src/config.ts:141-145`). `proxy:<model>` goes through an OpenAI-compatible client at `MEMHTML_LLM_BASE_URL/v1`, with the model named by the `MEMHTML_LLM_MODEL_MAP` and `MEMHTML_LLM_MODEL_PREFIX` rules (`proxyModel` at `packages/curator/src/model.ts:94-121`). Every call carries an output ceiling of 32,000 tokens (`withOutputCeiling` at `packages/curator/src/model.ts:128-135`).
7. The head is loaded in this process. Without `--resume`, the base is `main`'s tip, else `HEAD`'s commit, and a repository with no commit is refused (`apps/cli/src/curate-run.ts:582-593`). With `--resume`, the base is the session log's own `baseSha` (`apps/cli/src/curate-run.ts:578-581`). `loadHeadAt` reads that commit's snapshot, else an ancestor's snapshot advanced over the changed paths, else git (`loadHeadAt` at `apps/cli/src/v2.ts:217-237`, `loadVersion` at `apps/cli/src/head-cache.ts:177-225`). The curate commands never ask the head server (`apps/cli/src/v2.ts:141`).
8. The session opens. Without `--resume` or `--dry-run`, `startSession` writes an empty log at `.memhtml/sessions/<id>.json` naming the curate ref, and refuses an id that already has a log (`startSession` at `packages/session/src/session.ts:230-261`, `apps/cli/src/curate-run.ts:594-598`). `--resume` reopens the log (`resumeSession` at `packages/session/src/session.ts:290-301`). `--dry-run` keeps the ops in memory, seeded from the log under `--resume` (`memoryOverlay` at `apps/cli/src/curate-run.ts:323-333`, `apps/cli/src/curate-run.ts:581`).
9. Code computes a briefing over the base plus the session's ops, with no model call (`briefingFromView` at `packages/curator/src/briefing.ts:240-401`). It counts active, archived, and inbox records, splits every shared frame key into `duplicates` and `contradictions` by the value the claims state, lists the lowest-confidence records, and names five work lists by path (`recent`, `unlabeled`, `supersededActive`, `danglingEdges`, and `inbox`), each capped and carrying its total. `recent` holds the records created since the newest other `refs/heads/curate/*` ref's commit, each with its three nearest records by the head's lexical search (`lastCurateRef` at `apps/cli/src/curate-run.ts:253-273`, `apps/cli/src/curate-run.ts:601-612`). The inbox list reads `curator.writerBuckets` and `curator.placementQuota` from the policy. The model receives the briefing as one user message, with the numbers in a fenced JSON block (`renderBriefing` at `packages/curator/src/briefing.ts:410-423`).
10. `runCurator` calls `generateText` with the rendered charter as the system prompt and six tools, `search`, `read`, `exec`, `propose`, `status`, and `finish` (`runCurator` at `packages/curator/src/loop.ts:102-279`). `search` and `read` answer over the base plus the ops appended so far (`bindTools` at `apps/cli/src/curate-run.ts:357-460`). `exec` runs a JavaScript module in the sandbox under the `curate` scope and harvests its file changes into ops, which it appends only when the script exits 0 (`apps/cli/src/curate-run.ts:408-437`). `propose` takes explicit ops. A proposed `archive` or `move` names only its source, and the loop reads the bytes (`toOverlayOps` at `packages/curator/src/tools.ts:172-201`). Every tool result is cut at 30,000 characters, and a tool that throws answers the model with an error result while the run goes on (`TOOL_RESULT_CAP` at `packages/curator/src/loop.ts:40`, `guarded` at `packages/curator/src/loop.ts:131-140`).
11. The write bar judges every op before it's appended. `validateOps` judges the whole would-be batch under the `curate` scope and the store's `writeBar`, and any violation on a path the new ops touch, or the 200-op batch cap, refuses all of them and hands the violations back to the model (`judge` at `apps/cli/src/curate-run.ts:377-391`). The violation kinds are `format`, `duplicate`, `claim-edit`, `reserved-path`, `batch-cap`, and `write-bar` (`Violation` at `packages/session/src/validate.ts:23-42`). A `write-bar` violation is a new record of a type `writeBar.refusedTypes` names, or, under `writeBar.requireAnchor`, a new record with no entity outside `projects/<slug>/` (`writeBarReasons` at `packages/session/src/validate.ts:131-145`). The `curate` scope admits `areas/arcs/` and `resources/people/` (`CURATE_SCOPE` at `apps/cli/src/curate-run.ts:102-108`).
12. The budget bounds the loop, and `stoppedBy` names what ended it (`packages/curator/src/loop.ts:258-267`). `finish` means the model called `finish`, or answered with text and no tool call, and that text is the report (`packages/curator/src/loop.ts:239-246`). `maxSteps` is `--max-steps` model calls. `wallClock` is `--wall-clock-ms` over model calls and tool runs together. `maxOps` is 200 appended ops, the session's batch cap (`DEFAULT_BUDGET` at `packages/curator/src/budget.ts:24-29`). `modelError` is a provider or runtime failure inside the one `generateText` call (`packages/curator/src/loop.ts:212-256`). A run that stops without `finish` gets a report naming the limit (`stopReport` at `packages/curator/src/loop.ts:281-302`).
13. A session with ops is committed to the curate ref under the `curate` scope, and the commit judges the ops against the write bar once more (`land` at `apps/cli/src/curate-run.ts:470-520`). The subject is `memhtml(curate):` followed by the report's first non-blank line, cut at 72 characters, and the body carries a `Memhtml-Session: <id>` trailer (`commitSummary` at `apps/cli/src/curate-run.ts:523-527`, `commitSubject` and `commitMessage` at `packages/session/src/commit.ts:68-80`). A run that stopped on a budget commits what it appended, under the stop report's first line. The first commit creates the ref. A `rebase-needed` answer reloads the head at the ref's tip, moves the session's base there, and tries again, up to 8 attempts (`COMMIT_ATTEMPTS` at `apps/cli/src/curate-run.ts:100`). The ref moves by compare-and-swap under the checkout lock, and the checkout stays where it is because `HEAD` doesn't name the ref (`landOnRef` at `packages/session/src/commit.ts:284-333`). The new commit's snapshot is written next, best-effort (`snapshotAfterCommit` at `apps/cli/src/head-cache.ts:270-288`).
14. The run writes to its `curate/` ref and nowhere else, so nothing it proposes reaches `main`. `curate merge <ref>` is the way back, and the payload's `next` is that call (`apps/cli/src/curate-run.ts:652`). See [curate merge](#curate-merge).

Flags:

- `--ref` (string): "The curator branch, `refs/heads/` prepended when absent. Defaults to `curate/<UTC date>`. Must sit under `curate/`: `main`, `refs/heads/main`, any other branch, or a tag is ERR_INVALID_FLAG at exit 2, and the branch HEAD points at is ERR_INVALID_MEMORY at exit 1, so a run can never land on the system of record or move the checkout. The session id is the ref with slashes as dashes (curate-2026-09-23)."
- `--model` (string): "The model: `fake` (a scripted, credential-free curator that plays the dedup rule), `bedrock:<modelId>` (the default AWS credential chain, region from AWS_REGION), or `proxy:<model>` (an OpenAI-compatible proxy at MEMHTML_LLM_BASE_URL, named with the MEMHTML_LLM_MODEL_PREFIX convention). Defaults to MEMHTML_CURATOR_MODEL, else `proxy:<default model>` when MEMHTML_LLM_BASE_URL is set; otherwise the flag is required."
- `--max-steps` (int, default `40`): "Model calls the run may make before it is stopped (`stoppedBy: maxSteps`)."
- `--wall-clock-ms` (int, default `1200000`): "Wall clock for the whole run, model calls and tool executions together (`stoppedBy: wallClock`)."
- `--dry-run` (boolean, default `false`): "Run the loop over an in-memory overlay: no session is written, nothing is appended, nothing is committed, and the ref stays where it was. With --resume, the overlay starts from the session's logged ops and the log is left as it was. The payload reports what would have been proposed."
- `--resume` (boolean, default `false`): "Reuse the existing session on the ref instead of refusing with ERR_STORAGE (session.exists). The head is loaded at the session's own base. A missing session is ERR_STORAGE at exit 1."
- `--charter` (string): "A file to brief the model with in place of the shipped charter. Its placeholders are filled from the store's `memhtml.config.json` as the shipped one's are: `{{placementQuota}}` (curator.placementQuota), `{{refusedTypesRule}}` (a sentence naming writeBar.refusedTypes, or nothing when the store refuses none), and `{{refusedTypesClause}}` (the same as a clause); any other text is used as written. The write bar still judges every op the run proposes. A file that cannot be read or has no text is ERR_STORAGE at exit 1 before any model call."

Response: `curate.run`.

A caller reads `outcome`, `commit`, `stoppedBy`, `ops`, and `report` (`CurateRunReport` at `apps/cli/src/curate-run.ts:189-220`). `outcome` is `committed`, `dry-run`, or `no-ops`, and `commit` is the landed sha or null. `stoppedBy` is `finish`, `maxSteps`, `wallClock`, or `maxOps`, because a `modelError` stop fails the run. `ops` counts the session's ops when the loop ended, by kind, under `put`, `archive`, `link`, `unlink`, `label`, `unlabel`, and `move` (`opsByKind` at `apps/cli/src/curate-run.ts:222-230`). `report` is the `finish` text or the stop report. `steps`, `tokens`, and `toolCalls` are the run's spend and its tool names in call order. `rebases` counts the landing's rebase rounds, and `snapshot` is the snapshot write or null. `head` says where the base came from (`source` is `snapshot`, `snapshot+advance`, or `git`). `briefing` is the whole briefing the model saw, `placementQuota` included. `charter` is the `--charter` path as given, or null for the shipped charter. `ref`, `sessionId`, `baseSha`, `model`, `dryRun`, `resumed`, and `next` echo the run (`apps/cli/src/curate-run.ts:636-653`).

A dry run answers `outcome: "dry-run"` with `commit: null`, `rebases: 0`, and `snapshot: null`, and its `ops` counts what the session would hold, a resumed session's logged ops included (`apps/cli/src/curate-run.ts:655-658`). A dry run still runs the whole loop against the model, so it spends model calls and tokens. A run that appended nothing answers `outcome: "no-ops"` with the same nulls (`apps/cli/src/curate-run.ts:659-661`).

The session log stays on disk after every run that opened one. After a commit it sits on the new commit with zero ops (`packages/session/src/commit.ts:569-571`), so a second run on the same ref, which by default means the same UTC day, is refused with `session.exists` until it passes `--resume`. A resumed run loads the head at the log's base, which after a commit is the curate ref's tip, so it sees what the earlier run landed. A run from another day is resumed by naming its ref with `--ref`. `memhtml session prune` removes zero-op logs past its cutoff (`packages/session/src/prune.ts:34-38`).

Errors:

- `ERR_INVALID_FLAG` (exit 2) for a `--ref` outside `refs/heads/curate/` (`main`, `refs/heads/main`, another branch, `curate/` with nothing after it, or a tag such as `refs/tags/curate/x`), for a `--model` that isn't `fake`, `bedrock:<id>`, or `proxy:<id>` (a blank id after the colon included), and for a `--max-steps` or `--wall-clock-ms` that isn't a positive integer (`curateRunFlags` at `apps/cli/src/run.ts:879-920`). A blank `--ref` is the default ref.
- `ERR_INVALID_FLAG` (exit 2) when the spec comes from `MEMHTML_CURATOR_MODEL` and has the wrong shape, naming the variable, and when the resolved spec is `proxy:` and `MEMHTML_LLM_BASE_URL` is unset or blank (`apps/cli/src/run.ts:2238-2261`). These two are judged after `validate`, so they carry no `memhtml help` pointer.
- `ERR_MISSING_ARGUMENT` (exit 2) when there's no `--model`, `MEMHTML_CURATOR_MODEL` is unset, and `MEMHTML_LLM_BASE_URL` is unset (`apps/cli/src/run.ts:2225-2237`).
- `ERR_INVALID_MEMORY` (exit 1) when the ref is the branch `HEAD` points at (`apps/cli/src/curate-run.ts:554-561`), when the repository has no commit (`apps/cli/src/curate-run.ts:586-592`), when the commit refuses the session's ops as `refused`, and when the ref moved on all 8 attempts (`apps/cli/src/curate-run.ts:505-519`). The last two keep the log for `--resume`.
- `ERR_STORAGE` (exit 1) as `session.exists` when the ref's session already has a log and `--resume` is absent (`packages/session/src/session.ts:247-253`), and as `session.read` when `--resume` finds no log (`resumeSession` at `packages/session/src/session.ts:290-301`).
- `ERR_STORAGE` (exit 1) as `curator.charter-file <path>: ...` when the `--charter` file can't be read or holds only whitespace. It's read after the policy and before the model is built (`readCharterFile` at `packages/curator/src/charter.ts:51-64`, `apps/cli/src/curate-run.ts:565-571`).
- `ERR_STORAGE` (exit 1) as `checkout.locked` when the landing waited 15 s for the checkout lock (`CHECKOUT_LOCK_WAIT_MS` at `packages/contracts/src/checkout-lock.ts:54`), and as `session.moved` when another writer changed the session's log during the run, which the commit checks first (`requireLogUnmoved` at `packages/session/src/session.ts:311`, `packages/session/src/commit.ts:458`).
- `ERR_STORE_CONFIG` (exit 1) when the store's `memhtml.config.json` exists and can't be read or doesn't decode. Nothing has been written (`loadStorePolicy` at `apps/cli/src/store-config.ts:64-93`).
- `ERR_MODEL_UNAVAILABLE` (exit 1) when the model can't be built at run time. That's a `proxy:` spec with a malformed `MEMHTML_LLM_BASE_URL` or `MEMHTML_LLM_MODEL_MAP`, raised as `CuratorModelSpecInvalid` before the session opens (`packages/curator/src/errors.ts:7-13`, `proxyModel` at `packages/curator/src/model.ts:94-121`, the `CuratorModelSpecInvalid` arm at `apps/cli/src/errors.ts:63-64`).
- `ERR_MODEL_UNAVAILABLE` (exit 1) when a model call fails during the loop (`stoppedBy` is `modelError`). The run fails without committing, and the message says how many ops stay in the session for `--resume` (`apps/cli/src/curate-run.ts:627-634`). Under `--dry-run` those ops were in memory and are gone. The message starts with "bedrock refused" whatever the provider (the `ModelUnavailable` message at `apps/cli/src/errors.ts:130-131`).
- `ERR_DIRTY_TREE` (exit 1) when the commit answers `worktree-dirty`, which takes a checkout of the ref after the run started plus uncommitted changes at a path the commit touches (`apps/cli/src/curate-run.ts:511-512`).
- `ERR_GIT` (exit 1) from `symbolic-ref`, `rev-parse`, `for-each-ref`, the head load, or the commit's plumbing.

Failure: a usage error is refused before anything opens. A refusal at the ref check, the policy read, the charter read, or the model build leaves nothing behind, because the session hasn't opened yet. Once it has, every op the tools append is written to the log as it's appended (`sessionOverlay` at `apps/cli/src/curate-run.ts:336-351`). A model failure, a commit refusal, a ref that kept moving, or a `checkout.locked` wait leaves that log with its ops, the ref where it was, and no commit. A curator commit never drops refused ops, so it writes no `<id>.dropped.jsonl` trail. The failure envelope replaces the payload, so the run's `report`, `toolCalls`, `briefing`, and token counts are lost, and nothing else records the model's conversation. A process killed after the commit saved `pending` is settled by the next commit of that session (`packages/session/src/commit.ts:465-491`). A snapshot write that fails after the commit is logged as a warning and reported as `snapshot: null`, and the commit stays. `--dry-run` writes no session, no ref, and no commit, and leaves a resumed log as it was. Its head load can still remove a snapshot file that isn't a cache this build reads (`cachedRecords` at `apps/cli/src/head-cache.ts:140-165`). A retry with `--resume` reopens the log, briefs the model over the base plus the logged ops, and lands those ops with whatever the new run adds. A retry without `--resume`, after the session opened, is refused with `session.exists`.

## curate collapse

```
memhtml curate collapse --model fake --dry-run
memhtml curate collapse --model fake --rulings audit/verdicts.jsonl --dry-run
memhtml curate collapse --model fake --plan plan.json --only theme-loop-guard,archive-none-episodic
```

Plans a collapse of the corpus with no model call, then carries it out on one `curate/` branch (`curateCollapse` at `apps/cli/src/curate-collapse.ts:857-1002`). Archive clusters are archived with no model. Each fold cluster becomes one canonical record through a curator session, and the driver archives every member behind it. Keep clusters are reported and left alone. `docs/design.md` §23 covers the design. A collapse goes through these steps.

1. `run` judges the argv as it does for `curate run`, with `--concurrency` and `--limit` added to the positive integers (`curateRunFlags` at `apps/cli/src/run.ts:879-920`). The model is resolved in the same block, and every call needs one, `--dry-run` included (`apps/cli/src/run.ts:2211-2263`).
2. The `--plan` and `--rulings` files are read before the command starts (`apps/cli/src/run.ts:2311-2320`, `readPlanFile` and `readRulingsFile` at `apps/cli/src/curate-collapse.ts:839-855`). A plan must be a JSON object with a `clusters` array (`readPlan` at `apps/cli/src/curate-collapse.ts:825-836`). A rulings file is JSONL with blank lines skipped. Each line is an object with a `path` and a `verdict` of `keep`, `fold`, `trace`, or `archive`, and the last ruling for a path wins (`parseRulings` at `packages/curator/src/planner/rulings.ts:15-47`, `rulingsByPath` at `packages/curator/src/planner/rulings.ts:50-54`).
3. The ref defaults to `curate/<UTC date>-collapse`, so it never shares a session id with `curate run`'s ref (`defaultCollapseRef` at `apps/cli/src/curate-collapse.ts:103-104`). A ref outside `refs/heads/curate/` and the branch `HEAD` points at are refused here as well (`apps/cli/src/curate-collapse.ts:871-884`).
4. The command reads the store's policy, builds the model, and then reads the charter, the shipped `packages/curator/prompts/collapse.md` or the `--charter` file, filled from the policy as `curate run` fills its own (`apps/cli/src/curate-collapse.ts:893-895`, `COLLAPSE_CHARTER` at `packages/curator/src/charter.ts:119-122`). A `bedrock:` spec takes its region from `AWS_REGION`, `us-east-1` when unset, as in `curate run` (`packages/curator/src/model.ts:88`).
5. The base is the ref's tip, else `main`'s tip, else `HEAD`'s commit, so a second collapse on the same ref plans over what the first one landed (`tipOf` at `apps/cli/src/curate-collapse.ts:349-361`). The head is loaded once in this process through the snapshot cache and held for the run, and every later tip is that version advanced by delta (`makeHeadCache` at `apps/cli/src/curate-collapse.ts:276-346`). The head server is never asked (`apps/cli/src/v2.ts:141`).
6. `planCollapse` cuts the active records into clusters, with no model call and no I/O (`planCollapse` at `packages/curator/src/planner/plan.ts:234-426`). Rulings come first. A path ruled `archive` or `trace` joins its partition's archive cluster, a path ruled `fold` with a `theme` joins that theme's fold cluster, and a path ruled `keep` leaves every cut (`packages/curator/src/planner/plan.ts:255-313`). Without a ruling, records under `resources/people/` and `task` rows are excluded (`isShielded` at `packages/curator/src/planner/plan.ts:173-174`). The rest are partitioned by source, the `memhtml-author` meta or `(none)`, and memory type (`packages/curator/src/planner/plan.ts:315-322`). Inside a partition, a frame key two or more records share is a fold when they state one value or one claim, and a keep cluster of contradiction candidates when they don't (`frameGroupAgrees` at `packages/curator/src/planner/plan.ts:160-170`, `packages/curator/src/planner/plan.ts:327-353`). What's left is cut by Louvain over a lexical kNN graph plus shared entities, and a community of two or more is a fold, or a keep cluster past 120 members (`packages/curator/src/planner/plan.ts:355-386`, `DEFAULT_PLANNER_OPTIONS` at `packages/curator/src/planner/types.ts:117-124`).
7. Every cluster gets a home, a canonical memory type, and an anchor (`toCluster` at `packages/curator/src/planner/plan.ts:430-466`). The home is the members' majority directory, or `areas/<slug of the title>` when that directory is the inbox or matches a `curator.writerBuckets` pattern (`homeFor` at `packages/curator/src/planner/plan.ts:123-138`). The type is the members' majority type outside `arc`, `task`, and `writeBar.refusedTypes`, else `semantic` (`canonicalType` at `packages/curator/src/planner/plan.ts:109-117`). Clusters sort archive, then fold, then keep, then by size, largest first, then by id (`packages/curator/src/planner/plan.ts:392-397`). With `--plan`, the saved plan is used as given and the planner doesn't run, so `--rulings` has no effect past its read (`apps/cli/src/curate-collapse.ts:901-911`).
8. The archive and fold clusters are the executable ones. `--only` keeps the ids it names and refuses when none of them is executable, `--limit` keeps the first N in plan order, and every other cluster goes under `untouched` (`apps/cli/src/curate-collapse.ts:913-935`).
9. A dry run stops there. Every selected cluster is previewed with outcome `dry-run`, the whole plan is printed, and no model is called (`apps/cli/src/curate-collapse.ts:939-940`).
10. Archive clusters run first, one at a time (`apps/cli/src/curate-collapse.ts:947-953`). Each is archived in chunks of 180, one session per chunk named `collapse-<cluster id>-<n>`, each judged against the tip it starts from, and each committed as `memhtml(curate): archive <n> records: <cluster id>` (`archiveCluster` at `apps/cli/src/curate-collapse.ts:435-501`, `ARCHIVE_CHUNK` at `packages/curator/src/planner/types.ts:112`). A member that's gone, already archived, or whose `archive/<year>/<path>` destination exists is skipped and named. A member ruled `keep` is never archived. A chunk the validator refuses becomes a warning, and its paths are skipped.
11. Fold clusters then run in a pool of `--concurrency` lanes (`apps/cli/src/curate-collapse.ts:954-959`). A fold loads the tip and is `skipped` when no member is still active. Code writes its briefing with the canonical title, the home, the type, the plan's `collapse-<date>` tag, every member's claim, excerpt, entities, tags, and ruling, and one member's whole HTML (`renderCollapseBriefing` at `packages/curator/src/collapse-briefing.ts:109`). The fold opens session `collapse-<cluster id>` with `force`, which discards an earlier log of that id, and runs the loop under the collapse charter with the per-fold `--max-steps` and `--wall-clock-ms` and the 200-op cap (`FOLD_BUDGET` at `apps/cli/src/curate-collapse.ts:98`, `foldCluster` at `apps/cli/src/curate-collapse.ts:596-823`).
12. A fold must end with a canonical `put`. The driver then appends an `archive` for each member the model left and a `supersedes` link from the canonical to each archived path it lacks, while the batch cap allows. When that completion fails validation, it's dropped with a warning and the model's ops go on alone (`apps/cli/src/curate-collapse.ts:693-736`). The session lands as `memhtml(curate): fold <cluster id> into <canonical> (<n> archived)`. Follow-up sessions named `collapse-<cluster id>-more-<round>` archive and link every member the first session didn't settle (`followUp` at `apps/cli/src/curate-collapse.ts:522-593`). A fold of more than 180 active members briefs the first 170. Past 30 briefed members, the briefing tells the model to write the `put` alone, and the driver adds every archive and link (`LARGE_GROUP` and `FOLD_FIRST_SESSION_MEMBERS` at `packages/curator/src/planner/types.ts:109-115`, `apps/cli/src/curate-collapse.ts:631-634`).
13. Every session is judged under the `curate` scope and the store's write bar, and lands through the same rebase-and-retry `curate run` uses, 8 attempts each, so concurrent folds take turns at the one ref (`landOps` at `apps/cli/src/curate-collapse.ts:401-428`). A rebase reads the new tip from the held head.
14. After the last cluster, the command reads the ref's tip and writes its snapshot when the ref moved, best-effort (`apps/cli/src/curate-collapse.ts:966-972`). Nothing reaches `main`. `curate merge <ref>` is the way back, and `next` is that call.

Flags:

- `--ref` (string): "The curator branch, `refs/heads/` prepended when absent. Defaults to `curate/<UTC date>-collapse`. Must sit under `curate/` (ERR_INVALID_FLAG at exit 2 otherwise), and the branch HEAD points at is ERR_INVALID_MEMORY at exit 1. Every cluster lands on this one ref through the rebase-and-retry loop, so concurrent folds serialize at it. Sessions are named `collapse-<cluster id>`."
- `--model` (string): "The model each fold runs under: `fake`, `bedrock:<modelId>`, or `proxy:<model>`, resolved as `curate run` resolves it (MEMHTML_CURATOR_MODEL, else `proxy:<default>` when MEMHTML_LLM_BASE_URL is set). Archive clusters use no model."
- `--plan` (string): "A saved plan (the `plan` field of a --dry-run payload) to execute in place of computing one. Members are re-checked against the ref's tip per cluster, and `planShaMismatch` says when the plan named another sha."
- `--rulings` (string): "A JSONL file of audit rulings, one `{path, verdict, theme?, reason?}` per line with verdict one of keep, fold, trace, archive. Archive and trace rulings become archive clusters, fold rulings group by theme, keep rulings take a record out of every cut, and each is quoted in its cluster's briefing."
- `--concurrency` (int, default `4`): "Fold sessions run at once; each lands on the one ref through the rebase-and-retry loop."
- `--only` (string): "Comma-separated cluster ids to execute; every other cluster is reported under `untouched` and left alone. ERR_INVALID_MEMORY when none names an archive or fold cluster."
- `--limit` (int): "Execute only the first N archive or fold clusters in plan order."
- `--dry-run` (boolean, default `false`): "Compute the plan and print it whole under `plan`, with every executable cluster previewed as `dry-run`; no session, no ref, and no commit is written."
- `--max-steps` (int, default `14`): "Model calls one fold may make before it is stopped."
- `--wall-clock-ms` (int, default `900000`): "Wall clock for one fold, model calls and tool executions together."
- `--charter` (string): "A file to brief every fold with in place of the shipped collapse charter, its placeholders filled from the store's `memhtml.config.json` as `curate run --charter` fills them. Archive clusters use no charter. A file that cannot be read or has no text is ERR_STORAGE at exit 1 before any cluster runs."

Response: `curate.collapse`.

A caller reads `clusters`, `summary`, `untouched`, and `tip` (`CurateCollapseReport` at `apps/cli/src/curate-collapse.ts:164-201`). `clusters` holds one outcome per executed or previewed cluster, in plan order (`ClusterOutcome` at `apps/cli/src/curate-collapse.ts:138-162`). Each carries `id`, `kind`, `members`, `outcome`, `commits`, `canonical`, `ops`, `driver`, `steps`, `tokens`, `stoppedBy`, `rebases`, `skipped`, `warnings`, `error`, and `ms`. `outcome` is `committed`, `dry-run`, `skipped`, `refused`, `modelError`, or `failed` (`ClusterOutcomeKind` at `apps/cli/src/curate-collapse.ts:130-136`). `commits` lists every commit the cluster landed, and `driver` counts the archives and links the driver added beside the model's. `summary` counts `committed` clusters, `failed` ones (`failed`, `refused`, and `modelError` together), `archived` records, `canonicals`, and `commits` (`apps/cli/src/curate-collapse.ts:987-996`). `untouched` lists each cluster this run didn't execute with its `id`, `kind`, `members`, and `rationale`, which covers every keep cluster and whatever `--only` and `--limit` left out. `tip` is the ref's commit after the run, or null when the ref still doesn't exist.

`plan` is the whole plan on a dry run and null otherwise, and it's the file `--plan` replays (`apps/cli/src/curate-collapse.ts:984`). `planSource` is `computed` or `file`, and `planMs` is 0 for a file. `planShaMismatch` is true when a `--plan` file names a sha other than `base`, the tip this run planned over (`apps/cli/src/curate-collapse.ts:981-982`). `totals` is the plan's census. `charter` is the `--charter` path as given, or null for the shipped collapse charter. `head`, `snapshot`, `ref`, `model`, `dryRun`, and `next` are as in `curate run`.

A cluster's outcome is data. The command answers `curate.collapse` at exit 0 when clusters fail, and one cluster's failure doesn't stop the others. A model failure inside a fold is that cluster's `modelError` outcome (`apps/cli/src/curate-collapse.ts:663-665`). A fold that ended without a canonical `put`, or whose ops failed validation before the commit, is `refused` (`apps/cli/src/curate-collapse.ts:669-677`, `apps/cli/src/curate-collapse.ts:742-752`). A fold whose first commit landed and whose follow-up then failed is `committed` with `error` set (`apps/cli/src/curate-collapse.ts:806-821`). An archive cluster that landed nothing is `skipped`, and one that hit a failure is `failed` after the chunks before it landed. A fold with no active member is `skipped`, and its `error` says so.

The held head loads in the command's own fiber, one load at a time (`makeHeadCache` at `apps/cli/src/curate-collapse.ts:280`), so a line that load logs goes to stderr with the command's other logs, and stdout carries exactly one envelope.

Errors:

- `ERR_INVALID_FLAG` (exit 2) for a `--ref` outside `refs/heads/curate/`, a `--model` of the wrong shape, and a `--max-steps`, `--wall-clock-ms`, `--concurrency`, or `--limit` that isn't a positive integer (`curateRunFlags` at `apps/cli/src/run.ts:879-920`).
- `ERR_INVALID_FLAG` (exit 2) for a `MEMHTML_CURATOR_MODEL` of the wrong shape and for a `proxy:` spec with no `MEMHTML_LLM_BASE_URL`, and `ERR_MISSING_ARGUMENT` (exit 2) when no model is named anywhere (`apps/cli/src/run.ts:2225-2261`).
- `ERR_STORAGE` (exit 1) when `--plan` can't be read, isn't JSON, or has no `clusters` array, and when `--rulings` can't be read or has a line that isn't an object with a `path` and a known verdict, naming the line. Both are read before the ref is checked (`readPlanFile` and `readRulingsFile` at `apps/cli/src/curate-collapse.ts:839-855`, `parseRulings` at `packages/curator/src/planner/rulings.ts:15-47`).
- `ERR_INVALID_MEMORY` (exit 1) when the ref is the branch `HEAD` points at (`apps/cli/src/curate-collapse.ts:878-884`), when the repository has no commit (`tipOf` at `apps/cli/src/curate-collapse.ts:349-361`), and when `--only` names no archive or fold cluster in the plan (`apps/cli/src/curate-collapse.ts:915-925`). A failure to load or advance the held head is reported as `ERR_INVALID_MEMORY` too (`apps/cli/src/curate-collapse.ts:342-343`).
- `ERR_STORE_CONFIG` (exit 1) when the store's `memhtml.config.json` exists and can't be read or doesn't decode (`apps/cli/src/curate-collapse.ts:893`).
- `ERR_MODEL_UNAVAILABLE` (exit 1) when the model can't be built, from `CuratorModelSpecInvalid`, before any cluster runs and on a dry run as well (`apps/cli/src/curate-collapse.ts:894`, the `CuratorModelSpecInvalid` arm at `apps/cli/src/errors.ts:63-64`).
- `ERR_STORAGE` (exit 1) when the `--charter` file can't be read or holds only whitespace, before any cluster runs and on a dry run as well (`apps/cli/src/curate-collapse.ts:895`, `readCharterFile` at `packages/curator/src/charter.ts:51-64`).
- `ERR_GIT` (exit 1) from `symbolic-ref` or `rev-parse` outside a cluster. Inside a cluster, a git or storage failure becomes that cluster's `error`.

Failure: a usage error, an unreadable `--plan` or `--rulings`, and every refusal before the first cluster leave nothing behind. Clusters land one commit at a time, so a run that stops partway keeps every commit the earlier clusters and chunks landed on the ref, and the outcomes say which. A fold that was `refused` or hit `modelError` leaves its log at `.memhtml/sessions/collapse-<cluster id>.json` with the ops it appended, and each landed session leaves a zero-op log beside it. No session drops refused ops, so the command writes no `<id>.dropped.jsonl` trail. A driver completion that failed validation is dropped from its batch with a warning, and the follow-up sessions archive and link what it would have. The model's reports aren't kept. A fold refused for having no canonical `put` quotes its report's first line in `error`. `--dry-run` writes no session, no ref, and no commit. A retry has no `--resume`. It plans again over the ref's tip, where the members earlier clusters archived are gone, and every fold opens its session with `force`, which discards an earlier log of the same id (`apps/cli/src/curate-collapse.ts:643-649`). A replayed `--plan` re-checks each cluster's members against the tip and skips the ones already archived.

## Error codes

Branch on `code`, never on `error`. `ERROR_CODES` is append-only, so a shipped code keeps its meaning and is never removed (`apps/cli/src/envelope.ts:110-161`). It holds 25 codes.

Exit 2 codes come from `validate`, `help`, `envRootRefusal` (`ERR_REPO_REQUIRED`, `envRootRefusal` at `apps/cli/src/run.ts:1295-1308`), the `integrations` `--project` check (`ERR_INVALID_FLAG`, `projectRootOf` at `apps/cli/src/integrations.ts:171-178`), the input readers of `apply`, `exec`, `session put`, and `session exec`, and the checks `run` makes on the v2 environment variables and the curator's model. All of those answer before a service is built. A closed v1 record door is exit 2 as well, wherever it's found (`apps/cli/src/run.ts:2414-2422`). Exit 1 codes come from `codeFor`, which maps a typed failure's `_tag` to a code and maps every other tag, and every untagged value, to `ERR_UNKNOWN` (`codeFor` at `apps/cli/src/errors.ts:42-102`). Only `ERR_PATH_NOT_FOUND` appears at both exits.

- `ERR_UNKNOWN_COMMAND` (exit 2): no command by that name. The suggestions are the nearest names (`unknownCommand` at `apps/cli/src/run.ts:712-723`).
- `ERR_MISSING_ARGUMENT` (exit 2): a required positional or flag is absent, `write` or `correct` has neither `--claim` nor `--article-html`, `exec` or `session exec` got a blank script, `apply` or `session put` got no ops, a `session` command has neither `--id` nor `MEMHTML_SESSION`, or `curate run` or `curate collapse` has no model to run.
- `ERR_INVALID_FLAG` (exit 2): a flag the command doesn't take, a boolean given a separate value, a value outside a closed vocabulary, a bad `--as-of`, conflicting input doors, a malformed `apply` or `session put` line, a `session exec` request body over 1,048,576 bytes, or a malformed environment variable the command reads (`MEMHTML_SESSION`, the deadline and pool variables, `MEMHTML_CURATOR_MODEL`). A variable's refusal names the variable.
- `ERR_UNEXPECTED_ARGUMENT` (exit 2): a positional past what the command declares.
- `ERR_REPO_REQUIRED` (exit 2): `MEMHTML_REFUSE_ENV_ROOT` is set and the call opens a root without `--repo`. The suggestions are `memhtml <cmd> --repo <path>` and `memhtml help <cmd>`.
- `ERR_PATH_NOT_FOUND` (exit 1, or exit 2 from the `apply`, `exec`, `session put`, and `session exec` file readers): no file at the path. The suggestions start with `memhtml resolve` (`PathNotFound` at `apps/cli/src/errors.ts:195-199`).
- `ERR_INVALID_MEMORY` (exit 1): a file or input that breaks the format or a value check, including positional vocabularies, `--due`, `--due-before`, `trace links` with no flag, an unmaterializable `exec --sha`, `agents-doc --check` drift, a `session put` or harvest a blocking violation refuses, and a `curate merge` the replay refuses. The suggestion is `memhtml manifest`.
- `ERR_DUPLICATE_CONTENT` (exit 1): mapped, but no code path raises it. A duplicate write is a success with `deduped: true`.
- `ERR_WRITE_CONFLICT` (exit 1): an explicit `--path` that's occupied, or two `apply` ops naming one path. The suggestions are `memhtml read <path>` and `memhtml correct <path>` (`apps/cli/src/errors.ts:209-213`).
- `ERR_DIRTY_TREE` (exit 1): `curate merge`, or the commit at the end of `curate run`, found an uncommitted edit at a path the landing changes while `HEAD` is the target. The suggestions are `git -C $MEMHTML_ROOT status` and committing or stashing the changes (`apps/cli/src/errors.ts:214`, `apps/cli/src/v2.ts:1741-1743`, `apps/cli/src/curate-run.ts:511-512`).
- `ERR_INDEX_STALE` (exit 1): `index update`, or a write's `reindex`, found a watermark with no commit. The only suggestion is `memhtml index rebuild`, because `index update` is what raised it (`IndexStale` at `apps/cli/src/errors.ts:220`).
- `ERR_EMBED_MODEL_MISMATCH` (exit 1): the index was built in another vector space. The suggestion is `memhtml index rebuild --embed`.
- `ERR_MODEL_UNAVAILABLE` (exit 1): `head embed` with no document embedder bound, `curate run` when its model call fails, and `curate run` or `curate collapse` when a `--model` spec can't be built at run time (`apps/cli/src/head-vectors.ts:358-366`, `apps/cli/src/curate-run.ts:627-633`, `CuratorModelSpecInvalid` at `apps/cli/src/errors.ts:63-64`). The v1 embedding and extraction failures degrade instead.
- `ERR_STORAGE` (exit 1): a database, filesystem, or indexer-side git failure. That includes `checkout.locked` after 15 s behind another writer, the session log failures (`session.read`, `session.locked`, `session.moved`, and the rest), and a head-server answer that `session commit`, `session rebase`, or `session exec` lost after the server took the call. It carries no suggestions, except when `head serve` can't bind a socket path that long (`HeadSocketPathTooLong` at `apps/cli/src/errors.ts:89-90`, `apps/cli/src/errors.ts:246-249`).
- `ERR_GIT` (exit 1): a store-side git command failed. The message names the subcommand and exit code, and it carries no suggestions.
- `ERR_DISCRIMINATION_FAILED` (exit 1): `eval discriminate` failed its gate, or the head gate refused a `curate merge` (`HeadGateFailed` at `apps/cli/src/errors.ts:79-80`).
- `ERR_UNKNOWN` (exit 1): a defect, or a tag `codeFor` doesn't know, such as `LlmContractViolation` (`messageFor` at `apps/cli/src/errors.ts:113-164`).
- `ERR_REBUILD_NO_EMBED_REFUSED` (exit 1): `index rebuild` that can't embed over a store with vectors, without `--force`. The suggestions are `memhtml index rebuild --embed`, `memhtml index rebuild --no-embed --force`, and `memhtml index embed` (`RebuildNoEmbedRefused` at `apps/cli/src/errors.ts:224-228`).
- `ERR_UNKNOWN_HOST` (exit 2): an `integrations` host outside the vocabulary.
- `ERR_UNKNOWN_HOOK_EVENT` (exit 2): a `hook` event outside the vocabulary (`vocabularyPositionals` at `apps/cli/src/run.ts:1341-1361`).
- `ERR_INTEGRATION_MODIFIED` (exit 1): an `integrations` install or uninstall found a managed file changed since the receipt.
- `ERR_HEAD_SERVER_RUNNING` (exit 1): `head serve` found a live server on the store's socket. The message names its pid, and the suggestion is `memhtml head status` (`apps/cli/src/head-server.ts:505-512`, `HeadServerRunning` at `apps/cli/src/errors.ts:244`).
- `ERR_SESSION_BOUND` (exit 2): `write`, `apply`, `correct`, or `task add` with `MEMHTML_SESSION` set, while the store's `v1Doors` is `closed-in-session` (the default) or `closed`. The suggestions are the session doors that do the same job (`sessionDoorRefusal` at `apps/cli/src/doors.ts:97-106`). See [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).
- `ERR_V1_DOOR_CLOSED` (exit 2): one of the same four doors with no session set, while `v1Doors` is `closed`. The suggestions start, write, and commit a session `s1` (`closedDoorRefusal` at `apps/cli/src/doors.ts:85-94`).
- `ERR_STORE_CONFIG` (exit 1): the store's `memhtml.config.json` exists and can't be read or doesn't decode, so nothing that needs the policy runs. The suggestions are `memhtml config` and fixing or removing the file (`StoreConfigInvalid` at `apps/cli/src/errors.ts:256-261`).

A suggestion has to be a call that moves the failure. `SUGGESTIONS` is a record keyed by tag, so a test can drive every string through the real parser (`SUGGESTIONS` at `apps/cli/src/errors.ts:188-270`). `failureFor` builds every runtime envelope from `codeFor`, `messageFor`, and `suggestionsFor` (`apps/cli/src/errors.ts:278-279`).

## Environment variables

Every variable is one entry in `CONFIG_VARS`, which `memhtml manifest` reads to describe them (`apps/cli/src/config.ts:107-275`). There are 25.

- `MEMHTML_ROOT`: the root, default `~/memhtml`, with a leading `~` expanded (`apps/cli/src/config.ts:108-117`, `MemhtmlRoot` at `apps/cli/src/config.ts:282-286`). `--repo` wins over it.
- `MEMHTML_REFUSE_ENV_ROOT`: any value but `0`, `false`, `no`, or `off` (blank is off) makes a call that opens a root require `--repo`, refusing with `ERR_REPO_REQUIRED` at exit 2 (`apps/cli/src/config.ts:118-127`, `refusesEnvRoot` at `apps/cli/src/config.ts:80-81`). `manifest`, `help`, `agents-doc`, `eval discriminate`, and the `integrations` family are unaffected, and `hook` warns and stays silent instead.
- `MEMHTML_SESSION`: the v2 session a process writes through, trimmed, with blank read as unset (`SESSION_VAR` entry at `apps/cli/src/config.ts:128-134`, `sessionFromEnv` at `apps/cli/src/config.ts:102-105`). It's the default `--id` for every `session` command but `session prune`, it starts the session on first use from `session put` and `session exec`, and under the store's `v1Doors` it closes the record-creating v1 doors and MCP tools. See [Run sessions and the v1 doors](#run-sessions-and-the-v1-doors).
- `MEMHTML_TRACE_ROOT`: where `trace index` reads transcripts, default `~/.claude`, read only (`apps/cli/src/config.ts:135-140`, `TraceRoot` at `apps/cli/src/config.ts:294-297`).
- `MEMHTML_AWS_REGION`: the Bedrock region for embeddings and the entity extractor's model calls, default `us-east-1` (`apps/cli/src/config.ts:141-145`, `LlmConfig` at `packages/llm/src/client.ts:162-163`).
- `AWS_BEARER_TOKEN_BEDROCK`: the Bedrock bearer token, read by the AWS SDK. Absent means the default credential chain (`apps/cli/src/config.ts:146-151`). The curator's `bedrock:` model takes the credential chain only when it's absent or blank (`bedrockModel` at `packages/curator/src/model.ts:86-92`).
- `MEMHTML_LLM_BASE_URL`: an OpenAI- and Anthropic-compatible proxy origin. Set, every model and embedding call goes through it, and `curate run` and `curate collapse` default their model to `proxy:` with the default curator model. A malformed value fails at startup (`PROXY_BASE_URL_VAR` entry at `apps/cli/src/config.ts:152-161`, `apps/cli/src/run.ts:2219-2224`).
- `MEMHTML_LLM_API_KEY`: the proxy's bearer token, read only with `MEMHTML_LLM_BASE_URL` (`apps/cli/src/config.ts:162-167`).
- `MEMHTML_LLM_MODEL_PREFIX`: the prefix on every proxied Bedrock model id, default `bedrock/`. `none` sends bare ids (`apps/cli/src/config.ts:168-173`).
- `MEMHTML_LLM_MODEL_MAP`: comma-separated `from=to` pairs that rename single models for the proxy (`PROXY_MODEL_MAP_VAR` entry at `apps/cli/src/config.ts:174-179`).
- `MEMHTML_CURATOR_MODEL`: the default `--model` for `curate run` and `curate collapse`, as `fake`, `bedrock:<modelId>`, or `proxy:<model>`. With neither the flag nor the variable, the default is `proxy:` with the default curator model when `MEMHTML_LLM_BASE_URL` is set, and otherwise the call is `ERR_MISSING_ARGUMENT` at exit 2. A spec that doesn't parse, and a `proxy:` spec with no proxy, are `ERR_INVALID_FLAG` at exit 2 (`CURATOR_MODEL_VAR` entry at `apps/cli/src/config.ts:180-185`, `apps/cli/src/run.ts:2218-2263`).
- `MEMHTML_OPENAI_PROMPT_CACHE`: `off` (default) or `implicit`, for the OpenAI entity extractor's prompt caching. Any other value fails at startup (`apps/cli/src/config.ts:186-191`).
- `MEMHTML_EMBED`: `off` disables the embedder. Only `off`, trimmed and case-insensitive, does (`apps/cli/src/config.ts:192-197`, `layerEmbedder` at `apps/cli/src/api-layer.ts:232-243`). `head search`, `head embed`, `session put`, and `head serve` bind the same embedder, so `off` also drops the vector arm from the head's searches and placements, and `head embed` fails (`V2_EMBEDDING_COMMANDS` at `apps/cli/src/run.ts:1236-1241`).
- `MEMHTML_EMBED_DEADLINE_MS`: how long `head search` waits for its query embed, in whole milliseconds, default 450, with `0` for no bound. Past it the search answers without the vector arm, reporting `embed-timeout`. `head serve` reads it as the deadline for a request that names none, and `head search` sends it to the server when it's set (`EMBED_DEADLINE_VAR` entry at `apps/cli/src/config.ts:198-202`, `EMBED_DEADLINE_DEFAULT_MS` at `apps/cli/src/head-protocol.ts:123`).
- `MEMHTML_EMBED_WARM_IDLE_MS`: read by `head serve` only, default 0, which leaves warmup off. Set to a whole number of milliseconds, the server issues one one-token query embed after that long with no embed, so a proxy that drops idle connections stays warm. It runs only with an embedder bound and a vector cache held (`EMBED_WARM_IDLE_VAR` entry at `apps/cli/src/config.ts:203-207`, `EMBED_WARM_IDLE_DEFAULT_MS` at `apps/cli/src/head-protocol.ts:140`).
- `MEMHTML_COMMIT_DEADLINE_MS`: how long `session commit` and `session rebase` wait for the head server's answer, in whole milliseconds, default 60000, with `0` for no bound. Past it the call fails with `ERR_STORAGE` naming `session status` and doesn't commit here (`COMMIT_DEADLINE_VAR` entry at `apps/cli/src/config.ts:208-212`, `COMMIT_DEADLINE_DEFAULT_MS` at `apps/cli/src/head-protocol.ts:373`).
- `MEMHTML_EXEC_POOL_SIZE`: read by `head serve` only, the number of `/v1/exec` sandbox workers that run at once, a whole number from 1 to 64. Unset, it's the cores the process may use less one, at least 1 and at most 4 (`EXEC_POOL_SIZE_VAR` entry at `apps/cli/src/config.ts:213-217`, `defaultExecPoolSize` at `apps/cli/src/exec-pool.ts:60-61`).
- `MEMHTML_EXEC_WORKER_HEAP_MB`: read by `head serve` only, each sandbox worker's old-generation heap limit in whole MB, from 64 to 65536, default 2048. A worker past it is stopped, and its job fails with `ERR_STORAGE` (`EXEC_WORKER_HEAP_VAR` entry at `apps/cli/src/config.ts:218-222`, `WORKER_HEAP_MB` at `apps/cli/src/exec-pool.ts:67-71`).
- `MEMHTML_MCP_HEAD`: read by the MCP server on every `memory_search` and `memory_recall`. By default both ask the head server first and answer from the index when no server answers within 2 s, or when the call names `include_archived`, `as_of`, a double-quoted phrase, or no term the head indexes. `off` sends every call to the index (`MCP_HEAD_VAR` entry at `apps/cli/src/config.ts:223-228`, `routeFor` at `apps/cli/src/head-retrieval.ts:68-80`, `HEAD_RETRIEVAL_TIMEOUT_MS` at `apps/cli/src/head-retrieval.ts:42`).
- `MEMHTML_VECTOR_COVERAGE_FLOOR`: the coverage share below which `search` and `recall` drop the vector arm, default `0.95` (`apps/cli/src/config.ts:229-234`). The range check accepts values above 0 up to 1, and a value outside it fails the layer build with no envelope (`layerRetrievalPolicy` at `apps/cli/src/api-layer.ts:294-305`).
- `MEMHTML_LLM`: `off` unbinds the write-time entity extractor, so a batch writes exactly what it was given (`apps/cli/src/config.ts:235-240`, `layerExtractorPort` at `apps/cli/src/api-layer.ts:362-376`). The curate commands take their model from `--model` and don't read it.
- `MEMHTML_EXTRACT_ENTITIES`: `off` removes the entity-extraction model call that `apply` makes per batch. `MEMHTML_LLM=off` removes it too (`apps/cli/src/config.ts:241-251`).
- `OTEL_EXPORTER_OTLP_ENDPOINT`: an OTLP collector base URL. Set, spans export to `<endpoint>/v1/traces` (`apps/cli/src/config.ts:252-257`).
- `OTEL_SERVICE_NAME`: overrides `service.name` on exported traces, read only with the endpoint set (`apps/cli/src/config.ts:258-263`).
- `MEMHTML_MCP_BIN`: an explicit path to the `memhtml-mcp` entry for `serve mcp` (`MCP_BIN_VAR` entry at `apps/cli/src/config.ts:264-274`). The `integrations` family reads it too.

One variable outside the table changes a v2 command. The curator's `bedrock:` model takes its region from `AWS_REGION`, default `us-east-1`, and doesn't read `MEMHTML_AWS_REGION` (`bedrockModel` at `packages/curator/src/model.ts:86-92`).

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at cf76951.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 81 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 71 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 68 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 67 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 58 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 41 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 38 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 35 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 32 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 31 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 31 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 29 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 27 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 22 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 14 shared source citations
