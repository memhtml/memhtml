# RFC 0001: Curation recipes

- Status: Draft
- Created: 2026-10-25
- Applies to: memhtml 0.17.0 (68697d5)
- Related: RFC 0002 (fold by fact), RFC 0003 (record lifecycle metadata), RFC 0004 (prose references)

## Summary

A curation recipe is a versioned store file that defines one curation job in five stages. **Select** fences the records it may touch. **Propose** emits typed proposals from a built-in proposer, a JSONL plan or a read-only script. **Judge** runs zero or more model judges, each answering accept, reject or amend, combined by a stated rule. **Apply** lands accepted proposals as sessions on one `curate/` branch, re-resolving each against the tip. **Check** runs mechanical checks and predicts the head gate. Every write is a proposal with a receipt line. `memhtml.config.json` holds the protected set and the landing rule, which a recipe can only tighten. `curate run` and `curate collapse` become the built-in `store-upkeep` and `fold` recipes.

## Motivation

memhtml's two curation jobs are commands whose rules live in code, so a third job is a script around `session exec` that inherits none of them. Take six records about a made-up `project:fernwick`:

| # | path                                           | claim                                                     |
| - | ---------------------------------------------- | --------------------------------------------------------- |
| 1 | `projects/fernwick/release-train.html`         | Fernwick ships a numbered release every six weeks.        |
| 2 | `projects/fernwick/sync-retry-limit.html`      | The Fernwick sync client retries a failed upload 5 times. |
| 3 | `areas/inbox/fernwick-upload-retries.html`     | A failed Fernwick upload is retried 5 times.              |
| 4 | `areas/inbox/fernwick-4-0-date.html`           | Fernwick 4.0 ships on 2031-05-12.                         |
| 5 | `projects/fernwick/offline-mode.html`          | Offline mode arrives in Fernwick 4.0.                     |
| 6 | `projects/fernwick/tasks/write-4-0-notes.html` | (a task) Write the 4.0 release notes.                     |

A tool, `link-finder`, reads the store at commit X and suggests five links: 5 `relates_to` 1, 4 `relates_to` 1, 5 `relates_to` 4, 3 `supports` 2, and 6 `relates_to` 4. Then a `curate run` files record 4 under `projects/fernwick/` and lands, and an unlanded curate branch folds records 2 and 3. Applying the plan with 0.17.0 hits five gaps:

1. **No curate door takes links.** `session put` reads only `write`, `label` and `unlabel` (`apps/cli/src/apply.ts:339`), so links need a `session exec` script. `memhtml link` and `memhtml task status` commit one edit each through the v1 store (`apps/cli/src/commands.ts:462-463`, `:691-692`; `packages/contracts/src/store-config.ts:34-35`), outside curate branches, `curate merge` and the gate.
2. **The moved record is lost.** `memhtml resolve` follows only `supersedes` and archive moves (`apps/cli/src/operations.ts:1429`).
3. **No verdict is recorded.** Link 5 to 1 joins a feature to the release cadence, two separate facts, and 4 to 1 is better as `example_of`. A model can say so, but the commit carries only a subject and a `Memhtml-Session` trailer (`packages/session/src/commit.ts:76-81`).
4. **Nothing fences task 6.** The planner and the charter shield tasks, but a session on a curate ref may change any record (`packages/session/src/validate.ts:91`).
5. **Nothing sees the unlanded fold.** If the links land first, the fold's replay archives record 3 with the new link inside it (by reading `packages/session/src/validate.ts:312-314`, `docs/design.md:498`). If the fold lands first, the links branch's replay is refused whole, naming no line to drop (`packages/session/src/validate.ts:328-330`, `apps/cli/src/v2.ts:1711-1716`).

## Current behavior

"By reading" marks an inference that no test pins.

- **`curate run`** is a six-tool model loop whose `propose` and `exec` append a call's ops whole or not at all, completing moves with `withRepoints` (`docs/design.md:923`; `apps/cli/src/curate-run.ts:384-398`, `:451-456`). Its budget is 40 steps, 20 minutes and 200 ops (`packages/curator/src/budget.ts:24-29`). It bases on `main`'s tip (`apps/cli/src/curate-run.ts:590-600`) and keeps ops for `--resume` after a model failure (`:640-646`).
- **`curate collapse`** plans with no model, then drives the plan: clusters (`packages/curator/src/planner/types.ts:1-13`, `:39-59`) plus `sha`, `tag` and `archiveYear` (`:80-91`). An archive chunk of 180 (`:112`) with any violation is skipped whole (`apps/cli/src/curate-collapse.ts:471-476`). It bases on its own ref's tip (`:355-367`) and tests members at planned paths only (by reading `:458-460`, `:624-625`). The fold writer gets all six tools (`:657-664`), though its charter forbids `exec` (`packages/curator/prompts/collapse.md:19`), and archiving a non-member only warns (`apps/cli/src/curate-collapse.ts:690-694`).
- **The shield.** The planner leaves out `resources/people/` records and tasks unless a ruling names them (`packages/curator/src/planner/plan.ts:173-174`, `:259-285`; `docs/design.md:942`), and the charter lets them take one edit, a missing entity (`packages/curator/prompts/charter.md:28`).
- **Ops.** There are seven op kinds (`packages/contracts/src/record.ts:81-88`), none for task status (`apps/cli/src/session-exec.ts:277-278`), and at most 200 per batch (`packages/session/src/validate.ts:44-45`).
- **`validateOps`** accepts a link to an archived record (`packages/session/src/validate.ts:335-342`) and one the source already carries (by reading `:326-347`), which `addLink` skips (`packages/html/src/editors.ts:231-235`).
- **Policy.** The `curator` block holds `writerBuckets` and `placementQuota` (`packages/contracts/src/store-config.ts:81-94`), decoded strictly (`:187`) and read from the working tree per decision (`apps/cli/src/store-config.ts:29-36`).
- **`curate merge`** fast-forwards when it can, with no replay (`apps/cli/src/v2.ts:1686-1694`; `docs/design.md:903`). Only the replay refuses a non-memory file (`docs/design.md:907`). It re-validates with no batch cap, lands one commit and moves the curate ref to it (`apps/cli/src/v2.ts:1705-1717`; `docs/design.md:908-911`).
- **Model calls.** The curator loop drives runs and folds (`packages/curator/src/loop.ts`), and write-time entity extraction uses `@memhtml/llm` (`apps/cli/src/extraction.ts:162-175`). None judges a proposed change or stores a per-op reason (by reading).
- **Other branches.** `lastCurateRef` names the newest other curate ref (`apps/cli/src/curate-run.ts:249-273`), and nothing compares unlanded branches (by reading).

## Proposal

### Recipe files

A store recipe is `.memhtml/recipes/<name>/recipe.json` plus the files it names, and the **runner** is the engine code that executes it. No session can write under `.memhtml/` (`packages/session/src/validate.ts:78`, `:89`), but a hand commit on a curate branch can, and a fast-forward `curate merge` lands it unchecked (`apps/cli/src/v2.ts:1686-1694`). PR 2 makes the fast-forward rebuild its diff into ops, refusing a non-memory path, and judge them with `validateOps` under the write bar, as the replay does (`apps/cli/src/v2.ts:1705-1710`).

A real run reads the recipe and `memhtml.config.json` from `main`'s tip commit, whatever its base, and records their tree and blob shas. If the working-tree policy differs from the committed one, the run refuses with `ERR_RECIPE`, because the CLI would otherwise judge by a policy no commit holds (`apps/cli/src/store-config.ts:29-36`). `--dry-run --worktree` reads both from the working tree and says so. A plan file is input, read from the working tree and pinned by sha256. Built-ins ship in `packages/curator/recipes/`, and their names are reserved. The worked example runs this recipe:

```json
{
  "recipe": 1,
  "name": "link-intake",
  "version": 2,
  "summary": "Add suggested links after one judge reads each.",
  "select": { "paths": ["projects/**", "areas/**"], "exclude": ["areas/arcs/**"], "age": { "field": "created", "min": "1d" } },
  "propose": { "from": "file", "kinds": ["link"] },
  "judge": {
    "judges": [{ "id": "rel-reader", "prompt": "rel-reader.md", "model": "proxy:<model>", "batch": 5, "context": { "chars": 1500 } }],
    "amendable": ["rel"],
    "combine": "veto",
    "noVerdict": "hold"
  },
  "apply": { "ref": "curate/{date}-link-intake" },
  "check": [{ "id": "targets-live", "mode": "refuse" }]
}
```

`select` and `propose` are required, `name` matches the directory and `^[a-z0-9][a-z0-9-]{0,62}$`, and `version` rises on every change. Decoding is strict, like the policy file's (`packages/contracts/src/store-config.ts:14-17`): an unknown key, a bad type or a missing file fails the recipe with a new `ERR_RECIPE` at exit 1, appended to the error codes (`apps/cli/src/envelope.ts:105-110`).

### Stage 1: select

`select` is a fence that every proposal meets, whoever proposed it. `paths` and `exclude` are globs matched with `node:path` `matchesGlob`, as `writerBuckets` is (`packages/contracts/src/store-config.ts:59-64`), and omitting `paths` selects every path. `types`, `entities`, `facets` and `age` (in `session prune`'s duration syntax, `docs/design.md:555`) read `MemoryRecord` fields (`packages/contracts/src/record.ts:25-49`), so selection needs no index. `protect` adds protected entries for this recipe.

A proposal is **inside the fence** when every member matches `select` and is active at the base, every protected entry matching a member allows the proposal's kind, and every new path it writes matches `paths` and not `exclude`. Targets need not match, and `targets-live` holds them to the tip. Built-in proposers see only selected records, and a script gets `/workspace/selected.txt`.

### Stage 2: propose

A **proposal** is one typed change. Its **members** are the records whose files it changes, and its **targets** are records it points at. It is one JSON object, one per line in a plan file:

```json
{"id": "s-3", "kind": "link", "path": "projects/fernwick/offline-mode.html", "rel": "relates_to", "href": "/areas/inbox/fernwick-4-0-date.html", "reason": "offline mode ships in 4.0"}
```

It has a unique `id` and a `kind`, and may carry a `reason` shown to judges, a `group` for `--only` and `--limit`, and `expect`, the content hash seen at each path. A plan header, `{"plan": 1, "base": "<commit>", "source": "link-finder"}`, makes the runner read each path's hash at that commit, so it can follow a moved record.

| kind               | fields                                        | ops emitted                                                       | class |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------- | ----- |
| `move`             | `path`, `to`                                  | a `move` and its repoints (`packages/session/src/moves.ts:21-60`) | 1     |
| `archive`          | `path`                                        | an `archive`                                                      | 2     |
| `status`           | `path`, `status`                              | a `status` op (PR 5), plus an `archive` when `done`               | 2     |
| `fold`             | `cluster`, `tag`, `archiveYear`, `largeGroup` | the collapse driver's canonical, archives and `supersedes` links  | 2     |
| `refresh`          | `path`, `html`                                | a successor `put`, an `archive` and a `supersedes` link           | 2     |
| `write`            | `html`, `path?`, `links?`                     | a `put` placed as `session put` places it, and its links          | 2     |
| `link`, `unlink`   | `path`, `rel`, `href`                         | one of the same kind                                              | 3     |
| `label`, `unlabel` | `path`, `entity`                              | one of the same kind                                              | 3     |
| `ops`              | `ops`                                         | one curator tool call's ops                                       | none  |

Members are the `path`, except a fold's members not ruled `keep`, every path an `ops` proposal changes, and none for a `write`. A `fold` carries a collapse cluster and the plan fields `foldCluster` reads (`apps/cli/src/curate-collapse.ts:640-648`, `:709`). A `rel` must be in `propose.rels`, by default the memory rels except `supersedes` and `contradicts` (`packages/contracts/src/edges.ts:14-29`), because a planted `supersedes` sends its target to the next curator's archive list (`packages/curator/prompts/charter.md:29`). Only `fold` and `refresh` emit `supersedes`, and `contradicts` must be listed by name. A kind or rel outside the lists, or a line that does not decode, fails the stage, naming the line, as in `session put` (`apps/cli/src/apply.ts:385-391`).

Each recipe has one proposer:

- **Built-in.** `collapse-planner` runs `planCollapse` over the selected view, emitting `archive` proposals grouped by cluster id and one `fold` per fold cluster. `curator-loop` is the `curate run` loop. RFC 0002's planner would be a third.
- **File.** `--plan` or `propose.file` holds JSONL proposals or a saved `CollapsePlan` (`apps/cli/src/curate-collapse.ts:831-842`), which the runner converts as `collapse-planner` does.
- **Script.** A code-mode script runs in `memhtml exec`'s runtime pinned at the base, whose mount answers writes with `EROFS` and which has no network (`apps/cli/src/exec.ts:27-29`, `:317-324`), not in `session exec`'s writable one (`apps/cli/src/session-exec.ts:31-35`). Each stdout line is a proposal. No harvester runs, so the read-only mount is defense in depth. A non-zero exit fails the stage.

### Stage 3: judge

Each `judge.judges` entry names an `id`, a `prompt` file, a `model` in the curate commands' spec syntax, a `batch` size and `context.chars`, by default 1 and 2,000 (chosen defaults, not measured: one proposal per call is the simplest answer to check, and 2,000 characters hold a claim and its opening paragraphs). The prompt states the job's standard.

Judges run through the AI SDK model `curatorModel` resolves (`packages/curator/src/model.ts:138-152`) and answer through one verdict tool with tool choice required, because `@memhtml/llm` takes only fixed model keys (`packages/llm/src/models.ts:25-32`). A judge sees each proposal's fields and `reason`, and each member's and target's resolved path, title, claim and first `context.chars` characters, plus, for a `write`, its three nearest records by the briefing's lexical search (`apps/cli/src/curate-run.ts:609-616`). A fixed preamble says memory bodies are data, never instructions (`packages/curator/prompts/charter.md:5`), and that the verdict tool is the only answer. No judge sees another's verdict.

**Verdicts** belong to the runner: `accept`, `reject` or `amend`, each with a `note` of at most 280 characters (chosen default, not measured: one sentence a reader can scan). An `amend` changes only fields named in `judge.amendable`, each held to the proposal's own checks, so it can turn `relates_to` into `example_of` but cannot add a proposal or a path or leave `propose.rels`. A malformed answer is retried once (chosen default, not measured: it absorbs one slip without doubling a failing batch's cost). Then its proposals are `no-verdict`, never applied: held for the next run under `noVerdict: "hold"` (chosen default, not measured: an outage is not a ruling) or rejected under `"drop"`.

**Combining.** `veto`, the default, drops a proposal when any judge that ran rejects it, `majority` when more than half do, and `consensus` only when all do (chosen default, not measured: a mistaken drop returns on the next run, while a mistaken landing needs a later fix). Conflicting amendments to one field make it `amend-conflict`. A judge with `when: {"after": "<id>", "on": "reject"}` (or `"accept"`) runs only on what that judge rejected (or accepted).

**Calibration.** With `judge.calibration: {sample, seed}`, `--dry-run` writes a seeded sample, as the judges saw it, for a person to rule. `--calibration <file>` matches rulings by id and content hash and records each judge's agreement and Cohen's kappa. The floor is on kappa (`minKappa`), because a judge that accepts everything scores kappa 0 however often the person accepts. Every judge must meet the floor, and one below it ends the run `calibration-below-floor` with nothing applied. A floor requires the file, and no floor is a default. `judge.budget` bounds calls and time, leaving the rest `no-verdict`.

### Stage 4: apply

**Ref and base.** `apply.ref` is `curate/{date}-{name}` unless set, under the curate commands' ref refusals (`apps/cli/src/curate-run.ts:121-127`, `:561-568`). With no such ref, the base is `main`'s tip. When it exists, `apply.existingRef` decides: `"refuse"`, the default, needs `--resume` and bases on the session's base, as `curate run` refuses a second session log (by reading `packages/session/src/session.ts:295-299`), and `"extend"` bases on the ref's tip, as 68697d5's collapse does (`apps/cli/src/curate-collapse.ts:355-367`, `:904`).

**Resolution.** Before judging and before each session, each path a proposal names:

1. stands if it is active with the expected content hash (from `expect`, else the plan's base);
2. else follows a move, `via: "move"`, to the active record with that hash, which a move keeps (`packages/contracts/src/record.ts:74-76`, `:59-60`);
3. else, before judging only, follows the `supersedes` chain from its archived form, at most eight hops (chosen default, not measured: a bound so a cycle ends);
4. else makes the proposal `stale`.

After judging, only moves are followed, since a later successor is content no judge saw. A link the source already carries is `noop`, and a link or unlink whose two ends resolve to one record is `stale`. Each resolution rechecks the fence and protection, and `age` reads the resolved record.

**Held.** A proposal is `held`, and refused, when it touches a path that another curate ref changed and `main` lacks. The scan reads every ref under `refs/heads/curate/` and `refs/remotes/*/curate/` except the run's own ref and its remote copies, each from its merge base with `main` (both sides of a rename, and the original behind an archive slot, `packages/contracts/src/paths.ts:225-229`), plus any non-empty local session log on such a ref, so a run never holds itself. The scan runs before judging, before each commit and before `gate` landing.

**Ordering and packing.** Classes apply in order, one class per session, and each session re-resolves against the branch tip, so a link whose target an earlier session archived goes `stale`. `ops` proposals land in one session in tool-call order, as `curate run` lands today. Whole proposals fill sessions of at most `apply.sessionOps` ops (chosen default, not measured: `BATCH_CAP`, also the maximum), and each proposal lands whole in one commit, except a fold the driver finishes in follow-up sessions (`apps/cli/src/curate-collapse.ts:80-82`). A move whose repoints exceed the cap is `over-cap`.

**Validation.** Before each commit, `validateOps` runs under the `curate` scope and the pinned write bar. The runner adds one rule: an `archive` onto an occupied archive slot is a violation, because the older copy may be a `supersedes` target. 68697d5 lets the new copy replace it (`packages/session/src/validate.ts:302-305`). A proposal with a violation leaves the session as `refused`, and the rest is validated again and lands.

**Folds.** `foldCluster` (`apps/cli/src/curate-collapse.ts:601-640`) runs under `apply.fold`'s charter, model and budget, `apply.concurrency` at a time, with three changes. The writer loses `exec`, as its charter asks. `identifiers-kept` and `mark-sentence` join the binder's propose-time judge (`apps/cli/src/curate-run.ts:384-398`), so the model can fix a failing canonical. And before commit, the fold is refused by a `put` outside `select.paths`, or by an op on any path but a member, a member's archive slot or a canonical. A canonical is any `put` the writer adds, and the collapse charter allows two (`packages/curator/prompts/collapse.md:11`).

**Trailers.** Session commits add `Memhtml-Recipe: <name>@<version>` and `Memhtml-Recipe-Run: <run id>`. `commitMessage` writes one trailer (`packages/session/src/commit.ts:76-81`), so PR 3 adds more, and a replay carries the union of its commits' run trailers onto `main`.

### Stage 5: check

Per-proposal checks run on each session before it commits, and a failure in `refuse` mode makes the proposal `refused`. Branch checks compare base and tip after the last session.

| check              | when           | what it holds                                                                                                                                                                                                                         |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identifiers-kept` | proposal       | Each member of a `fold` or `refresh` has every identifier in its article (tokens with a digit, `<code>` spans, paths, URLs and entity values) in the canonical that supersedes it. A canonical for records 2 and 3 without `5` fails. |
| `mark-sentence`    | proposal       | A `put`'s `<mark>` is one sentence of at most 40 words (chosen default, not measured: room for one plain sentence), beyond format's rule (`docs/format.md:110`).                                                                      |
| `targets-live`     | branch         | Each added link targets an active record, or for `supersedes` an existing one.                                                                                                                                                        |
| `no-protected`     | both, always   | No protected file changes except through an allowed kind or a move's repoint pair.                                                                                                                                                    |
| `receipted`        | branch, always | The branch's net effect equals the receipt's.                                                                                                                                                                                         |

`receipted` compares per-path effects, not op lists, because a tree diff loses ops (by reading `apps/cli/src/replay.ts:16-23`): a fold driver's `supersedes` links return inside the canonical's `put`, the commit path splices `memhtml-contradicts` links into puts (`docs/design.md:507`), and an op added and later undone vanishes. Receipt lines record the ops each session committed, driver ops included. The check applies them in order to the base view, with `withRepoints` and contradiction marking, and reads the diff through `reconstructOps` (`docs/design.md:905`). It passes when every path either side names agrees on location, article hash, edges and entities, and the diff touches no path the receipt leaves alone.

A recipe may add checks or raise `warn` to `refuse`, but `receipted` and `no-protected` always refuse. Then `gateHeads` (`packages/head/src/gate.ts:197-198`) gives `gate.predicted`. A failed branch check ends the run `checks-failed`, and nothing merges it.

### Landing

| rule   | at the end of a run                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`  | refuses every run but `--dry-run`                                                                                                                                                                 |
| `ask`  | stops and prints `next: memhtml curate merge <ref>`, as today (`apps/cli/src/curate-run.ts:665`)                                                                                                  |
| `gate` | repeats the held scan and calls `curateMerge` (`apps/cli/src/v2.ts:1654`) without `skipGate`, running the branch checks on the ops it rebuilds before anything lands; a refusal leaves the branch |

```
effective = strictest(recipe.landing, curator.recipes.<name>.landing ?? curator.landing ?? "ask")
```

Strictness runs `off`, `ask`, `gate`. The per-recipe policy key overrides the store-wide one, and the recipe's own `landing` can only tighten the result. A recipe that omits `landing` adds no limit. So `gate` needs the store owner's grant.

### Store policy

```json
{
  "curator": {
    "protected": [{ "paths": ["projects/fernwick/license-terms/**"], "allow": [], "reason": "license terms change only through a hand commit" }],
    "unprotect": [],
    "landing": "ask",
    "recipes": { "link-intake": { "landing": "gate" } }
  }
}
```

Two base entries always apply, and `curator.protected` adds to them:

| id       | matches               | allows            | reason                                                                                                                                         |
| -------- | --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `people` | `resources/people/**` | `label`           | identity records are written by curation at explicit paths (`docs/design.md:571`), and ranking, decaying or folding does not apply to identity |
| `tasks`  | type `task`           | `label`, `status` | a task changes through its status, never through a fold or a refresh                                                                           |

They restate the planner's shield and the charter's one allowed edit (`packages/curator/src/planner/plan.ts:173-174`, `packages/curator/prompts/charter.md:28`), and `status` is new, for PR 5's op. Only naming a base entry's id in `curator.unprotect` removes it, so adding an entry never drops one. Overlapping entries allow the intersection of their kinds, and `select.protect` joins for its recipe. Protection covers records at the base, and `select.paths` fences new ones.

A `collapse-planner` ruling, a person's decision about one path, admits a shielded record at 68697d5 (`packages/curator/src/planner/plan.ts:259-285`; `docs/design.md:942`). The runner keeps that for the base entries only, recording `admittedBy: "ruling"`.

`curator.landing` defaults to `ask` (chosen default, not measured: an owner opts in before a recipe merges itself), and a policy may name an uncommitted recipe. No recipe key reaches the batch cap, scope, gate, refs outside `curate/`, `receipted` or `no-protected`, and `memhtml config` reports the new keys (`packages/contracts/src/store-config.ts:136-143`).

### Receipts

Each run writes `.memhtml/receipts/<name>-<UTC instant>.jsonl`, local and git-ignored like sessions (`packages/session/src/exclude.ts:11-19`):

- **run**: recipe, version, tree sha and source, policy blob sha, ref, base, plan sha256 and header, the four landing values, and per judge its model, batch, `context.chars` and `promptSha256` (over preamble and prompt), plus a fold writer's model and charter hash.
- **proposal**: id, kind, decision, resolved paths, verdicts, the ops committed, session and commit.
- **end**: counts, checks, `gate.predicted`, landing, a sha256 of the lines above, and the landed commit, appended by `curate merge`.

A decision is `applied`, `dropped`, `refused`, `out-of-selection`, `protected`, `held`, `stale`, `noop`, `no-verdict`, `amend-conflict`, `over-cap` or `skipped`.

### CLI

```sh
memhtml curate recipe list
memhtml curate recipe run <name> [--dry-run] [--worktree] [--stop-after propose|judge] [--ref <ref>] [--resume] [--plan <file>] [--only <ids>] [--limit <n>] [--calibration <file>] [--model <spec>]
memhtml curate recipe check <name> [--worktree] [--ref <ref>] [--into main] [--receipt <file>]
```

`list` reports each recipe's version, proposer, judges, effective landing and decode problems. `run` reports an `outcome` (`committed`, `dry-run`, `no-ops`, `checks-failed`, `calibration-below-floor` or `merged`), counts, checks, `gate.predicted`, landing, the receipt and `next`. `--dry-run` runs every stage over an in-memory overlay, and `--stop-after propose` makes no model call. `--model` sets an unset proposer or fold-writer model, never a judge's. `check` decodes the recipe and reports its landing and protected set with no model call. With `--ref`, it rebuilds the replay ops as `curate merge` would and runs the branch checks against `--into`'s tip, finding the receipt through `Memhtml-Recipe-Run` trailers or `--receipt`, else failing `no-receipt`.

### Built-in recipes

| recipe         | today             | proposer                                                | ref, `existingRef`                 | checks, all `warn`                                  |
| -------------- | ----------------- | ------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `store-upkeep` | `curate run`      | `curator-loop`, `charter.md`, 40 steps, 20 minutes      | `curate/{date}`, `refuse`          | `targets-live`, `mark-sentence`                     |
| `fold`         | `curate collapse` | `collapse-planner` or a saved plan; sessions of 180 ops | `curate/{date}-collapse`, `extend` | `identifiers-kept`, `mark-sentence`, `targets-live` |

`curator-loop`'s tools write a proposal journal, which `--resume` reloads. Each `propose` or `exec` call is one `ops` proposal, applied or refused whole, so the alias swaps and supersede repairs the charter asks for in one proposal stay together (`packages/curator/prompts/charter.md:29`, `:31`). Its tools also apply the fence, protection and the occupied-slot rule (the fold writer's tools only the last): a call that breaks one is refused whole, as a call with a violation is today (`apps/cli/src/curate-run.ts:451-456`), and the result names the path and reason, so the model can call again without it.

Every flag keeps working: `--charter`, `--model`, `--max-steps` and `--wall-clock-ms` set the loop's or the fold writer's options, `--plan` becomes `from: file`, the other collapse flags set same-named options (`--only` and `--limit` over cluster-id groups), and `--dry-run`, `--resume` and `--ref` carry over.

### Worked example

Since commit X, a `store-upkeep` run moved record 4 to `projects/fernwick/4-0-date.html`, and the `sync-dedup` recipe's unlanded branch `curate/2031-04-01-sync-dedup` folds records 2 and 3. The policy grants `link-intake` `gate`. On 2031-04-02 the plan's lines fare as follows:

| id  | suggested link   | fence and resolution     | `rel-reader`                         | decision                |
| --- | ---------------- | ------------------------ | ------------------------------------ | ----------------------- |
| s-1 | 5 `relates_to` 1 | selected                 | `reject`: a feature, not the cadence | dropped                 |
| s-2 | 4 `relates_to` 1 | source followed its move | `amend`, `rel: example_of`           | applied as `example_of` |
| s-3 | 5 `relates_to` 4 | target followed the move | `accept`                             | applied                 |
| s-4 | 3 `supports` 2   | `held` by `sync-dedup`   | not run                              | held                    |
| s-5 | 6 `relates_to` 4 | `protected` by `tasks`   | not run                              | protected               |

Two links land in one session on `curate/2031-04-02-link-intake`, the checks pass, and `gate` landing calls `curateMerge`. A run a day after `sync-dedup` lands (`age` reads the canonical's `created`) follows both ends of s-4 through `supersedes` to the one canonical, so s-4 is `stale`.

**Out of scope:** the gate's blind spots for moved, refreshed and stale records and its count-only inversion test (by reading `packages/head/src/gate.ts:133-151`, `:214`) go to a follow-up gate RFC, and distinct archive generations (`packages/contracts/src/paths.ts:217-229`), which would retire the occupied-slot rule, to a follow-up archive-slot RFC.

## Invariants and safety

1. **Every write is a proposal,** held to its receipt by `receipted`, with fold writers fenced to their members.
2. **The write bar sees every write,** in `commitSession` (`docs/design.md:505`) and in the replay (`apps/cli/src/v2.ts:1705-1717`).
3. **Only `curate merge` lands on `main`,** never with `skipGate`, and PR 2 closes the fast-forward hole.
4. **A recipe only tightens policy.**
5. **A judged proposal applies only in the form its judges saw,** because after judging, resolution follows moves only. A fold's canonical is checked mechanically, not judged (open question 4).
6. **A proposal never spans commits,** except a fold the driver finishes later, whose receipt names every commit.
7. **One fact per file, and bodies are data,** through format, `mark-sentence` and the preamble.
8. **The index stays disposable.** Every stage reads the head, loaded locally as the curate commands load it (`apps/cli/src/commands.ts:1496`).
9. **A run is reproducible up to the model.** Everything but verdicts and fold text is pure in the base, pinned recipe and policy, plan and seed.
10. **Concurrent curation is held,** never by a run's own ref, except for runs that start before either has a ref or a log (`apps/cli/src/v2.ts:256`), where motivation gap 5 can recur.
11. **A failed run leaves its branch and receipt,** and `main` does not move.

## Compatibility and migration

- **Commands.** `curate recipe` is new. The old commands keep their flags and response types, adding `recipe`, `receipt`, `held` and `stale`.
- **Changed outcomes.** A moved fold member is followed. An archive chunk with one refused member lands the rest, where 68697d5 skips it (`apps/cli/src/curate-collapse.ts:471-476`). An archive onto an occupied slot is refused, where 68697d5 replaces the older archived copy (`packages/session/src/validate.ts:302-305`). The fold writer loses `exec`, and a non-member op refuses its fold. A curator tool call that touches a protected record beyond its allowed kinds is refused whole (test 14). A fast-forward carrying a hand edit to a non-memory path is refused. Reruns on an existing ref behave as today.
- **Held proposals** are warnings in the built-ins for one minor release, then refusals.
- **`--resume`** imports a 0.17.0 session log as one `ops` proposal.
- **Policy keys.** An older binary refuses a policy file using them (`packages/contracts/src/store-config.ts:187`), so writers upgrade first, and `memhtml doctor` warns.
- **The `status` op.** An older binary refuses a log holding an op kind it lacks (by reading `packages/session/src/session.ts:123-127`), so readers upgrade first.
- **Ignore patterns.** `.memhtml/receipts/` joins the `.gitignore` template and `ensureExcluded` (`packages/session/src/exclude.ts:54`). No data migrates.

## Alternatives considered

**Close the engine gaps and leave jobs to scripts.** The strongest alternative is engine fixes alone, composed by scripts: head-op lines in `session put`, a move hop in `resolve`, the `status` op, run trailers, a held-paths query and protection in `validateOps` (open question 5). It answers most of the motivation with far less surface, so this RFC adopts it as phase 1 (PRs 1 to 6). The runner is phase 2 because three things need one owner: the fence, the judges and the receipt must describe the same proposals, re-resolution happens per session between commits a script does not see, and `receipted` needs a receipt the engine wrote.

**Plugins with write access** give up the rule that every write is a typed proposal, and they run third-party code with the store's credentials. **A charter alone** (`apps/cli/src/commands.ts:1641-1646`) is a request to a model, not a rule: it cannot fence records, record verdicts or follow moves. **A pipeline of stage commands** would apply the fence at every stage and leave the receipt with no single writer. **Recipes as memory records** would let a curation job edit its own rules.

## Open questions

1. **Should receipts travel with the store?** A notes ref or a sidecar must survive the replay, which moves the curate ref (`docs/design.md:911`) and leaves the commits a receipt names open to garbage collection.
2. **How long does a hold last?** A `curate abandon <ref>` command or an age limit would bound it.
3. **Should verdicts be reused,** from a verdict store, when records, prompt hash and model are unchanged?
4. **Should a check call a model,** to catch a fold that keeps every identifier but changes the meaning?
5. **Should `no-protected` move into `validateOps`,** to cover a hand-written `session exec` on a curate ref?
6. **RFC 0003 and RFC 0004** add `select` fields and references to resolve, and nothing here waits on them.

## Implementation plan

Each PR ships alone and keeps both commands working. PRs 1 to 6 are phase 1.

1. **Policy keys** (`packages/contracts/src/store-config.ts`), with the planner's shield read from the base entries and rulings still admitting them, so no behavior changes.
2. **Fast-forward check** in `curate merge`.
3. **Commit trailers** (`packages/session/src/commit.ts`) and the replay's trailer union.
4. **`session put` head-op lines** and `links` on `write`.
5. **The `status` op.**
6. **Identity across moves:** a move hop in `memhtml resolve`, and `state.access` mirrored on rename as `onMove` mirrors an archive (`apps/cli/src/api-layer.ts:182-197`).
7. **Recipe format,** pinning, `recipe list` and `recipe check`.
8. **Propose and resolve:** proposals, the plan adapter, fence, protection, resolution, the held scan and scripts.
9. **Judges,** with `fake:<file>` judges for tests.
10. **Apply and check,** with `existingRef`, the occupied-slot rule, landing (a branch-check hook in `curateMerge`), receipts and `check --ref`.
11. **The `fold` and `store-upkeep` built-ins,** the latter with the journal and the 0.17.0 log import.

## Acceptance tests

The PR ships one synthetic fixture, `apps/cli/tests/recipes/fernwick/`: the six records, commit X, both recipes, the plan, the prompt `rel-reader.md`, fake judges (`fake:<file>`, mapping ids to verdicts and counting calls) and a fake fold writer, with the clock at 2031-04-02T06:00:00Z.

1. **Loading.** An extra key `judgez` fails `recipe check` and `recipe run` with `ERR_RECIPE` at exit 1. `recipe run` ignores an uncommitted `version` edit, which `--dry-run --worktree` records, and refuses over an uncommitted policy edit.
2. **Landing.** `recipe list` reports `ask` with no policy, `gate` with a per-recipe `gate`, and `ask` with a recipe `ask` or with a per-recipe `ask` beside `curator.landing: "gate"`. Under `"off"`, only `--dry-run` runs. Under `gate`, a passing run ends `merged`, and a failing `targets-live` ends `checks-failed` with `main` unmoved.
3. **Fence and protection.** An excluded path is `out-of-selection`, and a `label` line in a `link`-only recipe or a `supersedes` rel fails the stage. s-5 is `protected` with no judge call, though a `label` on it applies where allowed. A store entry keeps both base entries, `unprotect: ["tasks"]` sends s-5 to the judge, and an `archive` ruling under `fold` archives a task unless a store entry covers it.
4. **Moves.** s-2 records `via: "move"` and lands on `projects/fernwick/4-0-date.html`, which no 68697d5 command does. A link whose target gains a `supersedes` successor after judging is `stale`.
5. **Verdicts.** Fake verdicts s-1 `reject`, s-2 `amend {rel: example_of}` and s-3 `accept` drop s-1 and apply s-2 as `example_of` and s-3. `promptSha256` changes with a committed prompt edit. An amend to `href` or to `supersedes`, or an answer omitting s-3, is retried once, then `no-verdict`.
6. **Combining.** Judges A (s-1 and s-2 `reject`, s-3 `accept`) and B (s-1 `accept`, s-2 `reject`, s-3 `amend {rel: part_of}`): `veto` applies only s-3, as `part_of`, and `consensus` applies s-1 and s-3. With B set to `when: {after: "A", on: "reject"}`, B sees s-1 and s-2 only. Conflicting amends end `amend-conflict`.
7. **Held.** With `sync-dedup` unlanded, locally or only under `refs/remotes/origin/curate/`, s-4 is `held` with no judge call. Under a recipe allowing `move` and `link`, a plan that moves record 5 and links the moved record lands in two sessions, and the run's own ref holds neither. After `sync-dedup` merges, a run a day later follows both ends of s-4 to the canonical, and s-4 is `stale`.
8. **Packing.** On the generated fixture (`pnpm gen:fixture`, `docs/code-mode.md:134`), 430 links and no judge land as commits of 200, 200 and 30 ops with both trailers, each named in the receipt.
9. **Folds.** A fake writer whose first canonical drops `5` gets an `identifiers-kept` violation through `propose` and lands its second, and in `warn` mode the first lands with a warning. A writer that puts two canonicals, each superseding one member, passes `identifiers-kept` per member and lands. Archiving a non-member refuses the fold, where 68697d5 warns, an archive onto an occupied slot comes back to the writer as a violation, and `exec` is not bound. A two-sentence `<mark>` fails `mark-sentence`.
10. **Branch checks.** On a hand-built branch linking to a record archived on `main` after the cut, `recipe check --ref` fails `targets-live` against `main`'s tip (the 68697d5 replay accepts it, `packages/session/src/validate.ts:335-342`) and `receipted` with `no-receipt`. A fold whose driver adds its `supersedes` links and whose canonical gains a `memhtml-contradicts` link passes `receipted`, and a hand-added label fails it.
11. **Fast-forward.** A hand edit to `.memhtml/recipes/link-intake/recipe.json` on a curate branch that descends from `main` makes `curate merge` refuse, where 68697d5 fast-forwards.
12. **Calibration.** A person accepts 9 of 12 sampled proposals. Recipe A's one judge accepts all: agreement 9/12, kappa 0. Recipe B's one judge rejects 2 of the other 3 and 1 of the 9: agreement 10/12, kappa 5/9. With `minKappa: 0.5`, recipe A ends `calibration-below-floor` and recipe B applies, as does one recipe holding both judges. A floor with no `--calibration` refuses a real run.
13. **Scripts.** A bash script whose write under `/mnt/memhtml` fails, then prints one proposal and exits 0, yields it with the mount unchanged. A js `writeFileSync` there gets `EROFS`, two lines yield two proposals, and a network command exits 127.
14. **Built-ins.** Under one pinned clock for both binaries, on the 14-record fixture in `apps/cli/tests/curate-collapse.test.ts`, `curate collapse --model fake` prints the same `--dry-run` plan bytes as 68697d5 and lands the same tip tree sha, commit count and subjects, and a second run on the landed ref bases on its tip and commits nothing (`:349-357`). `curate run --model fake` matches on its fixture. With a dangling link added on a task under `projects/`, its one `exec` call is refused whole as `protected`, so neither the dedup nor either cut lands, where 68697d5 lands all three.
