# Code-mode — navigating the store with code instead of tool calls

The working cookbook for reading the corpus with an HTML parser rather than a chain of
tool calls. ROADMAP.md carries the sequencing; this file is the code.

## The contract that makes it possible

The format's closed vocabulary (docs/format.md) is a selector API. Every memory file
guarantees:

| selector | meaning |
|---|---|
| `article mark` (exactly one, non-empty) | the claim — what `files.gist` stores |
| `meta[name="memhtml-type"]` etc. | the typed head plane, one value per element |
| `link[rel^="memhtml-"]` | an authored edge; the href is a repo-relative path, which is the id |
| `article dl dt + dd` | facets, the same pairs `file_facets` indexes |
| `article cite` | citations, the same rows `file_citations` holds |
| `article time[datetime]` (first) | `event_at` |

`article mark` is a descendant selector, not a child one: constraint 1 puts the `<mark>`
inside the first `<p>` or `<li>`, so `article > mark` matches nothing.

Any HTML parser — cheerio, linkedom, bs4, lxml — reads the corpus with no schema
negotiation, **as long as it can load in the runtime you are actually in.** The examples below
use cheerio because they run under bun or node. (`@memhtml/html` itself uses parse5 with strict
constraint checking — the right tool for the WRITE path. Code-mode is the read path, where
a lenient parser over already-validated files is fine.)

**In the `memhtml exec` sandbox the parser is `node-html-parser`, and the substitution is not free.**
The sandbox runs QuickJS, where `Function.prototype.toString` is non-writable, so an
`Object.assign` onto a function throws whenever the source object carries a `toString` — which is
exactly what cheerio does at initialization. linkedom fails identically through `cssom`. Two of the
four parsers named above are therefore unusable there, measured rather than assumed. QuickJS also
has no base64 builtins, so `node-html-parser` needs a small `atob` shim. Everything else in this
document carries over unchanged, because the contract is the selectors, not the library.

## The rules

1. **Read-only.** A code-mode script never writes into the tree. Writes go through
   `memhtml apply` / `memory_write*`, which own commits, dedup, conflicts, and validation.
   A dirty tree after a code-mode run is a bug in the run.
2. **No salience side effects — automatically, and no longer an exception.** Reading files
   off disk touches no access row. Since salience bumps only on a CHOSEN open through
   `memory_read` / `memhtml read`, that makes code-mode the same rule everything else follows —
   no chosen open, no bump — rather than a carve-out from a rule about reads in general.
   A script that wants a traversal to count calls `memhtml read` or `memhtml reinforce` on the paths
   it actually consulted.
3. **Structural and lexical planes only.** No cosine, no RRF, no salience ranking.
   For ranked retrieval, shell out to `memhtml search --json` and consume the envelope —
   every CLI command's one-envelope contract makes it a code-mode API already.
4. **Search finds entry points; code traverses from there.** The intended opening move for a
   consuming agent is ranked retrieval first, code-mode second: run `memhtml search` or `memhtml recall`
   to get a handful of paths the four-arm RRF blend says are relevant, then switch to code-mode to
   walk edges, count, join, and filter from those paths. Starting in code-mode means starting with
   a full-corpus scan and no relevance signal, which is the expensive way to find a starting point
   the ranked planes already know. Starting in RRF and staying there means paying a tool call per
   hop for traversal that one script does in one pass.

## The helper (~100 lines, cheerio)

```ts
// memhtml-code.ts — read-only code-mode surface. Writes go through `memhtml apply`.
import { load, type CheerioAPI } from "cheerio"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export interface Memhtml {
  path: string // repo-relative, leading slash — matches href convention
  title: string
  type: string
  status: string
  claim: string // <mark> text — the gist
  tags: string[]
  entities: string[]
  links: { rel: string; href: string }[]
  facets: Record<string, string>
  citations: string[]
  eventAt?: string
  $: CheerioAPI // escape hatch: full DOM for anything the fields don't cover
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    if (!p.endsWith(".html")) return []
    if (name === "index.html" || name === "README.html") return []
    return [p]
  })

const meta = ($: CheerioAPI, name: string): string[] =>
  $(`meta[name="${name}"]`)
    .map((_, el) => $(el).attr("content") ?? "")
    .get()
    .filter(Boolean)

export const parseMemhtml = (root: string, file: string): Memhtml => {
  const $ = load(readFileSync(file, "utf8"))
  const facets: Record<string, string> = {}
  $("article dl dt").each((_, dt) => {
    const key = $(dt).text().trim()
    const val = $(dt).next("dd").text().trim()
    if (key) facets[key] = val
  })
  return {
    path: `/${relative(root, file)}`,
    title: $("title").text(),
    type: meta($, "memhtml-type")[0] ?? "",
    status: meta($, "memhtml-status")[0] ?? "",
    claim: $("article mark").first().text().trim(),
    tags: meta($, "memhtml-tag"),
    entities: meta($, "memhtml-entity"),
    links: $('link[rel^="memhtml-"]')
      .map((_, el) => ({ rel: $(el).attr("rel") ?? "", href: $(el).attr("href") ?? "" }))
      .get(),
    facets,
    citations: $("article cite")
      .map((_, el) => $(el).text().trim())
      .get(),
    eventAt: $("article time[datetime]").first().attr("datetime"),
    $,
  }
}

/** Load every memory under $MEMHTML_ROOT (or the given root) into a path-keyed map. */
export const corpus = (root: string = process.env.MEMHTML_ROOT ?? "."): Map<string, Memhtml> => {
  const byPath = new Map<string, Memhtml>()
  for (const file of walk(root)) {
    const m = parseMemhtml(root, file)
    byPath.set(m.path, m)
  }
  return byPath
}

/** Reverse the authored edge set: who points AT this path, and how. */
export const backlinks = (memhtmls: Map<string, Memhtml>) => {
  const incoming = new Map<string, { from: string; rel: string }[]>()
  for (const m of memhtmls.values())
    for (const l of m.links) {
      const list = incoming.get(l.href) ?? []
      list.push({ from: m.path, rel: l.rel })
      incoming.set(l.href, list)
    }
  return incoming
}

/** Follow one rel from a starting path to exhaustion (supersedence chains, part-of ancestry). */
export const chain = (memhtmls: Map<string, Memhtml>, start: string, rel: string): string[] => {
  const seen: string[] = []
  let at: string | undefined = start
  while (at && !seen.includes(at)) {
    seen.push(at)
    at = memhtmls.get(at)?.links.find((l) => l.rel === rel)?.href
  }
  return seen
}
```

## Five recipes, with the outputs the fixture corpus yields

Corpus: `pnpm gen:fixture --out /tmp/memhtml-fixture`. The generator is a pure function of its
seed — `DEFAULT_SEED = 20260802` and `DEFAULT_CORPUS_SIZE = 200` in
`packages/eval/src/corpus.ts` — so the defaults always produce the same 304 files:
200 base memories, 4 people files, 90 synthetic controls, and a 10-file `archive/2025/`
tier. Every number below is reproducible rather than observed once. All five recipes run in
one `bun demo.ts`, corpus load included, in well under a second.

**1. Type census** — no tool enumerates this.

```ts
const byType = new Map<string, number>()
for (const m of memhtmls.values()) byType.set(m.type, (byType.get(m.type) ?? 0) + 1)
// → semantic 81, procedural 68, episodic 23, and 22 each of precedent,
//   user_preference, verdict, agent_insight, error_pattern, arc
```

**2. Live contradiction pairs** — sleep's conflict-detection finds these nightly and
deliberately never resolves them; nothing lists the open set on demand.

```ts
const live = [...memhtmls.values()]
  .filter((m) => m.status === "active")
  .flatMap((m) =>
    m.links
      .filter((l) => l.rel === "memhtml-contradicts" && memhtmls.get(l.href)?.status === "active")
      .map((l) => [m.path, l.href] as const)
  )
// → 38 pairs
```

**3. Orphan census** — active memories with no edges either direction; hub candidates.

```ts
const incoming = backlinks(memhtmls)
const orphans = [...memhtmls.values()].filter(
  (m) => m.status === "active" && !incoming.has(m.path) && m.links.length === 0
)
// → 11 of 304
```

**4. Entity co-occurrence** — which services get remembered together. Zero pairs on the
fixture corpus, because the generator stamps one service entity per file. On a real corpus
this is the "what does checkout-api entangle with" question.

**5. Supersedence chain walk** — correction ancestry read from the tree, no git needed.

```ts
chain(memhtmls, "/areas/pipelines/refuted-reading-batch-loader-...-65.html", "memhtml-supersedes")
// → [ the live file, "/archive/2025/areas/pipelines/...-65-earlier.html" ]
```

## Interactive: bun repl and bun -e

Both work with cheerio installed alongside the helper — `bun repl` resolves imports from
the cwd's `node_modules`:

```
$ cd $MEMHTML_TOOLS && bun repl
> const { corpus, backlinks, chain } = await import("./memhtml-code.ts")
> const memhtmls = corpus("/path/to/memhtml-root")
> memhtmls.size
304
> [...memhtmls.values()].filter(m => m.type === "error_pattern" && m.status === "active")
     .map(m => m.claim).slice(0, 2)
[ "A cdn-edge trial edge node that revalidates twice in 5 minutes is the failure signature.",
  "A cdn-edge frankfurt edge node that revalidates twice in 5 minutes is the failure signature." ]
```

For agents, `bun -e '…'` is the better door — one shot, one stdout, no TTY. `bun repl`
suits a human exploring; note it is REPL-only sugar (top-level await, `_` last result)
and its transcript interleaves terminal control codes, so an agent capturing output
should always prefer `bun -e` or a script file.

## What this is not

- Not a write path. `memory_correct`'s 1→1 shape and sleep's gated N→1 composition are
  load-bearing; code-mode must never grow a serializer.
- Not retrieval. The discrimination gate's whole point is that lexical/structural reads
  cannot distinguish a claim from its negation-flip at a distance — ranked search stays
  with the four-arm RRF stack.
- Not an index handle. `memhtml exec` (item 7b) SHIPPED without one, deliberately: the ranked
  planes stay behind `memhtml search`, which a script reaches by shelling out. The earlier plan
  named a read-only `index.db` handle here; that was dropped on scope, not on feasibility
  (`.erpaval/solutions/architecture-patterns/turso-second-opener-and-the-readonly-flag.md`
  records what a second opener can actually do). A `memory_eval` MCP tool (item 7c) is still
  demand-pulled; ROADMAP.md carries the sequencing.

## `memhtml exec` — the shipped runtime

The helper above is the HOST version, for `bun` and `node`. Inside `memhtml exec` the same surface is
preloaded for you and the parser differs for the runtime reason stated at the top:

```
$ memhtml exec --script 'import { corpus, edges } from "/workspace/lib/corpus.mjs"
  const memories = corpus()
  const { resolved, dangling } = edges(memories)
  console.log(JSON.stringify({ memories: memories.size, resolved: resolved.length, dangling: dangling.length }))'
```

```json
{ "apiVersion": "1", "type": "exec.report",
  "data": { "corpusMount": "/mnt/memhtml", "sha": "f39a98e…", "exitCode": 0,
            "stdout": "{\"memories\":305,\"resolved\":410,\"dangling\":0}\n",
            "stderr": "", "durationMs": 3609, "timeoutMs": 30000, "timedOut": false } }
```

What the runtime guarantees, each measured rather than declared (`apps/cli/tests/exec.test.ts`):

- **Read-only.** A write from the script answers `EROFS`. Reads are confined to the mount: neither
  `/etc/hostname` nor a `..` escape resolves.
- **A pinned commit, never the live tree.** `--sha` defaults to `HEAD` and is materialized as a
  detached worktree. That is what keeps `.memhtml/index.db` out of reach — it is gitignored, so a
  checkout omits it. Read-only alone would NOT: the guest's `sqlite3` reads a read-only-mounted
  database fine.
- **No network.** There is no `curl`, and the guest's `fetch` refuses on call.
- **Bounded.** `--timeout-ms` defaults to 30000 and caps at 600000. A cut-off script is
  `exitCode: 124` with `timedOut: true`.
- **A failing script is exit 0.** The report carries `exitCode` and `stderr`; the CLI's exit 1 is
  reserved for the runtime failing to run the script at all.

The helper's `path` keys are root-absolute, matching the `href` convention exactly, so
`memories.get(link.href)` resolves with no normalization. Generated `index.html` listings are not
counted as memories.
