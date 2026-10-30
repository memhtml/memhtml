#!/usr/bin/env node
/**
 * Hand-written docs cite code by symbol, and this is the check that keeps each citation true.
 *
 * A line number goes stale at the next commit that edits the cited file above it, and nothing
 * notices: the citation still reads as a citation, it just names some other line. A symbol survives
 * every edit that keeps the declaration, and when the declaration goes, this check fails at the
 * commit that removed it.
 *
 * The hand docs are every Markdown file at the repository root except the generated `AGENTS.md`
 * and `CHANGELOG.md`; every one under `docs/` except `docs/codebase/` (generated at a commit),
 * `docs/reference/` (generated from the code), `docs/rfcs/` (frozen proposals) and `docs/bugs/`
 * (dated reports); and the docs site's authored pages under `apps/docs/src/content/docs/`, except
 * the generated `api/`. In each of them a code span is checked by what it holds:
 *
 * - `path:N`, `path:N-M`, `path:N:C`, `path#LN`, a list such as `path:N, :M`, or any of those
 *   followed by a name, is a line citation, and it fails. So does a bare `:N` that continues a
 *   span naming a file earlier in the same paragraph or table. A bare `:N` with no file before
 *   it, such as a port, is not a citation.
 * - `path::Symbol` must name a file that declares `Symbol` at its top level: a function, class,
 *   const, let, var, interface, type, enum or namespace, exported or not. `path::Outer::inner`
 *   must find `inner` declared directly in `Outer`, and each further link directly in the one
 *   before it: a member of a class, interface or enum, a key of an object or type literal in
 *   `Outer`'s own value (call arguments included, as in `Tool.make("name", { parameters })`), or
 *   a declaration in `Outer`'s body. A name that only appears deeper is not one: a key of an
 *   object built inside a function body, a destructured parameter, a type parameter, or a const
 *   in a nested function, which is cited through that function. The nested form exists because
 *   most of this codebase is Effect closures, where the code a sentence means is a const inside
 *   `makeStore`, not `makeStore` itself.
 * - A repository path (`apps/…`, `packages/…`, `scripts/…`, `tests-integration/…`, `docs/…`)
 *   must exist. A glob or a `<placeholder>` is checked up to the directory before it, and a build
 *   output such as `dist/` up to the package that builds it, so the check never depends on a
 *   build having run. A bare file name is a root-level file when the root holds it or held it at
 *   a commit in HEAD's history, and then it must exist: a renamed `RUNBOOK.md` fails every doc
 *   that still names it, while `index.html`, which this repository's root never held, names a
 *   store's file.
 *
 * Every page under `docs/codebase/` is generated against one commit, and its line citations are
 * true for that commit, so they are never read against HEAD. Each page names its commit, as
 * `commit: <40-hex sha>` in its front matter or else on its `> Built from commit` line. The
 * commit must exist in this clone (`git cat-file -e`) and be an ancestor of HEAD (`git
 * merge-base --is-ancestor`), and every line citation on the page must name a file that commit
 * holds, with its lines inside that file's length there; a bare `:N` reads as it does in a hand
 * doc. CI therefore checks out full history in every job that runs `check`: a shallow clone
 * holds no commit but its own.
 *
 * Declarations are read by a small scanner rather than a parser. TypeScript 7, which the repository
 * compiles with, has no in-process compiler API, and a parser would be a new dependency for a
 * question this narrow. The scanner drops comments, strings, template text and regular expressions,
 * tracks bracket nesting, and reads the declaration forms above. It relies on the formatting biome
 * enforces, where a statement or member ends at the next line that starts at its own depth and
 * indentation. A file whose brackets do not balance after scanning, or close with the wrong kind,
 * is reported as unreadable rather than guessed at.
 *
 *   node scripts/doc-citations.mjs              check this repository
 *   node scripts/doc-citations.mjs --root DIR   check the git checkout at DIR
 *
 * Exits 0 with a one-line summary, or 1 with one `file:line: problem` line per failure.
 */
import { spawnSync } from "node:child_process"
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const rootArgument = process.argv.indexOf("--root")
const ROOT =
  rootArgument === -1
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(process.argv[rootArgument + 1] ?? ".")

// --- which files are read ------------------------------------------------------------------------

const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 })

/**
 * Tracked files plus untracked ones git does not ignore, so a page written but not yet added is
 * checked too, and a generated page under an ignored directory is not.
 */
const repositoryFiles = () => {
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  if (listed.status !== 0) {
    console.error(`doc citations FAILED: git ls-files in ${ROOT}: ${listed.stderr.trim()}`)
    process.exit(1)
  }
  const files = listed.stdout.split("\0").filter((file) => file !== "")
  return [...new Set(files)].filter((file) => existsSync(join(ROOT, file))).sort()
}

const MARKDOWN = /\.mdx?$/
const SITE = "apps/docs/src/content/docs/"
/** The root-level Markdown a command writes: `mise run agents-doc` and release-please. */
const GENERATED_AT_ROOT = new Set(["AGENTS.md", "CHANGELOG.md"])
/** The directories under `docs/` whose pages are generated, frozen, or dated. */
const NOT_HAND_WRITTEN = ["docs/codebase/", "docs/reference/", "docs/rfcs/", "docs/bugs/"]

/** A dot-directory under `docs/` holds a generator's working files, not pages. */
const isPage = (file) =>
  MARKDOWN.test(file) && !file.split("/").some((part) => part.startsWith("."))

const isHandDoc = (file) => {
  if (!isPage(file)) return false
  if (!file.includes("/")) return !GENERATED_AT_ROOT.has(file)
  // The site's pages are authored, `agents.md` included; the TypeDoc tier under `api/` is generated.
  if (file.startsWith(SITE)) return !file.slice(SITE.length).startsWith("api/")
  return file.startsWith("docs/") && !NOT_HAND_WRITTEN.some((dir) => file.startsWith(dir))
}

const isCodebasePage = (file) => file.startsWith("docs/codebase/") && isPage(file)

// --- code spans in Markdown ----------------------------------------------------------------------

/**
 * Every inline code span in a Markdown file, with the line its opening backticks sit on and the
 * index of the block (paragraph, list, or table) it sits in.
 *
 * Front matter and fenced blocks are skipped: a fence holds an example, not a citation. A span is
 * closed by the next backtick run of the same length inside the same block, as CommonMark reads it,
 * so a span that wraps onto a second line is still one span.
 */
export const codeSpans = (text) => {
  const lines = text.split("\n")
  const spans = []
  let start = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1)
    if (end !== -1) start = end + 1
  }
  let fence = null
  let block = []
  let blocks = 0
  const flush = () => {
    if (block.length > 0) spans.push(...spansInBlock(block, blocks++))
    block = []
  }
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (marker !== undefined) {
      flush()
      fence = marker
      continue
    }
    if (line.trim() === "") flush()
    else block.push({ text: line, line: index + 1 })
  }
  flush()
  return spans
}

const spansInBlock = (block, blockIndex) => {
  const text = block.map((entry) => entry.text).join("\n")
  const lineAt = (offset) => {
    let seen = 0
    for (const entry of block) {
      seen += entry.text.length + 1
      if (offset < seen) return entry.line
    }
    return block.at(-1)?.line ?? 0
  }
  const spans = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === "\\") {
      index += 2
      continue
    }
    if (char !== "`") {
      index++
      continue
    }
    let run = 1
    while (text[index + run] === "`") run++
    const fenceText = "`".repeat(run)
    let close = text.indexOf(fenceText, index + run)
    while (close !== -1 && (text[close + run] === "`" || text[close - 1] === "`")) {
      let skip = close
      while (text[skip] === "`") skip++
      close = text.indexOf(fenceText, skip)
    }
    if (close === -1) {
      index += run
      continue
    }
    let content = text.slice(index + run, close).replace(/\n/g, " ")
    if (/^ .*[^ ].* $/.test(content)) content = content.slice(1, -1)
    spans.push({ content, line: lineAt(index), block: blockIndex })
    index = close + run
  }
  return spans
}

// --- declarations in TypeScript and JavaScript ---------------------------------------------------

const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/** After one of these a `/` starts a regular expression; after anything else it divides. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await"
])

const PUNCTUATION = ["...", "=>", "?.", "??", "&&", "||"]

/**
 * Split source into name, string, number and punctuation tokens. Comments vanish; a string, a
 * regular expression, or a run of template text becomes one opaque token; `${` and its closing `}`
 * are punctuation, so bracket nesting stays balanced across template literals.
 */
const tokenize = (source) => {
  const tokens = []
  const braces = []
  let index = 0
  let line = 1
  const push = (type, value, startLine, column) =>
    tokens.push({ type, value, line: startLine, endLine: line, column })
  let lineStart = 0
  const advance = (to) => {
    for (let at = index; at < to; at++) {
      if (source[at] === "\n") {
        line++
        lineStart = at + 1
      }
    }
    index = to
  }
  /** Template text from `index`, up to and including the closing backtick or the next `${`. */
  const template = () => {
    const startLine = line
    const column = index - lineStart
    let at = index
    while (at < source.length) {
      if (source[at] === "\\") at += 2
      else if (source[at] === "`") {
        advance(at + 1)
        push("string", "`", startLine, column)
        return
      } else if (source[at] === "$" && source[at + 1] === "{") {
        advance(at)
        push("string", "`", startLine, column)
        const braceLine = line
        const braceColumn = index - lineStart
        advance(at + 2)
        braces.push("template")
        push("punct", "${", braceLine, braceColumn)
        return
      } else at++
    }
    advance(source.length)
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "\n" || char === " " || char === "\t" || char === "\r") {
      advance(index + 1)
      continue
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      advance(end === -1 ? source.length : end)
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      advance(end === -1 ? source.length : end + 2)
      continue
    }
    const startLine = line
    const column = index - lineStart
    if (char === '"' || char === "'") {
      let at = index + 1
      while (at < source.length && source[at] !== char && source[at] !== "\n") {
        at += source[at] === "\\" ? 2 : 1
      }
      const value = source.slice(index + 1, at)
      advance(at + 1)
      push("string", value, startLine, column)
      continue
    }
    if (char === "`") {
      advance(index + 1)
      template()
      continue
    }
    if (char === "/") {
      const previous = tokens.at(-1)
      const regex =
        previous === undefined ||
        (previous.type === "punct" && ![")", "]", "}"].includes(previous.value)) ||
        (previous.type === "name" && REGEX_AFTER_WORD.has(previous.value))
      if (regex) {
        let at = index + 1
        let inClass = false
        while (at < source.length && source[at] !== "\n") {
          if (source[at] === "\\") at++
          else if (source[at] === "[") inClass = true
          else if (source[at] === "]") inClass = false
          else if (source[at] === "/" && !inClass) break
          at++
        }
        if (source[at] === "/") {
          at++
          while (/[a-z]/.test(source[at] ?? "")) at++
          advance(at)
          push("regex", "/", startLine, column)
          continue
        }
      }
    }
    const word = /^#?[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/.exec(
      source.slice(index, index + 200)
    )
    if (word !== null) {
      advance(index + word[0].length)
      push("name", word[0], startLine, column)
      continue
    }
    const number = /^\.?\d[\w.]*/.exec(source.slice(index, index + 100))
    if (number !== null) {
      advance(index + number[0].length)
      push("number", number[0], startLine, column)
      continue
    }
    const multi = PUNCTUATION.find((mark) => source.startsWith(mark, index))
    const mark = multi ?? char
    if (mark === "{") braces.push(mark)
    if (mark === "}" && braces.pop() === "template") {
      advance(index + 1)
      push("punct", "}", startLine, column)
      template()
      continue
    }
    advance(index + mark.length)
    push("punct", mark, startLine, column)
  }
  return tokens
}

const DECLARING = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "interface",
  "type",
  "enum",
  "namespace"
])

const MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "abstract",
  "override",
  "declare",
  "async",
  "get",
  "set",
  "accessor"
])

/** What may follow a member's name: a method, a property type or value, or a shorthand entry. */
const AFTER_MEMBER = new Set(["(", "<", ":", "=", "?", "!", ",", "}", ";"])

/** A line opening with one of these continues the statement above it rather than starting one. */
const CONTINUES = new Set([
  "}",
  ")",
  "]",
  ">",
  "=",
  ",",
  ".",
  "?.",
  "=>",
  "|",
  "&",
  "&&",
  "||",
  "??",
  "?",
  ":",
  "+",
  "-",
  "*"
])

/** A line after one of these continues it, so its first token cannot start a member. */
const OPEN_ENDED = new Set([
  "=",
  "=>",
  ":",
  "?",
  "|",
  "&",
  "&&",
  "||",
  "??",
  "(",
  "[",
  "+",
  "-",
  "*"
])

/**
 * A `{` after one of these opens an object literal or a type literal, whose entries are members.
 * After anything else (`)`, `=>`, a return type, `else`) it opens a block of statements.
 */
const MEMBERS_AFTER = new Set([
  "=",
  "(",
  "[",
  ",",
  ":",
  "?",
  "|",
  "&",
  "<",
  "...",
  "!",
  "return",
  "yield",
  "await",
  "extends",
  "satisfies",
  "as",
  "keyof",
  "typeof",
  "default"
])

const isNameish = (token) =>
  token !== undefined && (token.type === "name" || (token.type === "string" && token.value !== "`"))

/**
 * Whether `token` sits on `previous`'s line with no space between them. Only for a name or
 * punctuation before it, whose value is its source text; a string token's value drops its quotes.
 */
const touching = (previous, token) =>
  previous !== undefined &&
  previous.line === token.line &&
  previous.column + previous.value.length === token.column

/** The bracket that closes each opening one. */
const CLOSER = { "{": "}", "${": "}", "(": ")", "[": "]" }

/**
 * Every declaration in a source file, each with the declaration it sits directly inside. Returns
 * `null` when the brackets do not balance, which means the scanner misread the file and nothing it
 * found can be trusted.
 *
 * Three things that look like members are not recorded, because none of them declares anything
 * its owner exposes: a key of an object literal inside a function body (a call's argument, a
 * returned object), which belongs to the expression rather than to the function; anything inside a
 * parameter list, so a destructured parameter or a parameter's type literal; and a type parameter,
 * which sits inside angle brackets. A parameter list is told from a call by what follows its `)`:
 * `=>`, a body, or a return type.
 */
export const declarationsIn = (source) => {
  const tokens = tokenize(source)
  const indentOf = []
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]
    const previous = tokens[at - 1]
    token.first = previous === undefined || token.line > previous.endLine
    indentOf[at] = token.first ? token.column : (indentOf[at - 1] ?? 0)
  }
  const stack = []
  const open = []
  const declarations = []
  let header = -1
  let label = -1
  // The token after the newest declaration's name and type parameters: a `(` there opens its
  // parameters, even written flush against the name like a call.
  let paramsAt = -1
  let balanced = true
  const afterTypeParameters = (name) => {
    let at = name + 1
    if (tokens[at]?.value !== "<") return at
    for (let angles = 0; at < tokens.length; at++) {
      if (tokens[at].value === "<") angles++
      else if (tokens[at].value === ">" && --angles === 0) return at + 1
    }
    return at
  }
  const record = (name, kind, at) => {
    const depth = stack.length
    while ((open.at(-1)?.depth ?? -1) >= depth) open.pop()
    const parent = open.at(-1) ?? null
    paramsAt = afterTypeParameters(at)
    // A key counts only in its owner's own value. Once a function body opens between the owner and
    // the object, the object is something the function builds, not something it declares.
    const frames = stack.slice(parent?.depth ?? 0)
    if (kind === "member" && frames.some((frame) => frame.kind === "block")) return
    const declaration = { name, kind, line: tokens[at].line, depth, indent: indentOf[at], parent }
    declarations.push(declaration)
    open.push(declaration)
  }
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]
    const previous = tokens[at - 1]
    const next = tokens[at + 1]
    const depth = stack.length
    if (token.first && !CONTINUES.has(token.value)) {
      // A new line at this depth and no deeper indentation ends the statement or member above.
      while (open.length > 0) {
        const last = open.at(-1)
        if (last.depth !== depth || last.indent < token.column) break
        open.pop()
      }
    }
    const container = stack.at(-1)
    if (token.type === "punct") {
      if (token.value === "{") {
        const body = header === depth && !MEMBERS_AFTER.has(previous?.value ?? "")
        if (body) header = -1
        // The colon that ends a `case` label opens a block, not a property value.
        const members = body || (MEMBERS_AFTER.has(previous?.value ?? ";") && !previous?.label)
        stack.push({ kind: members ? "members" : "block", angles: 0, closer: "}" })
        continue
      }
      if (token.value === "(") {
        // A call is written flush against its callee; `if (`, `= (` and `: (` are spaced.
        const call =
          touching(previous, token) &&
          (previous.type === "name" || [")", "]", "?."].includes(previous.value))
        stack.push({
          kind: "expression",
          angles: 0,
          closer: ")",
          from: declarations.length,
          params: at === paramsAt,
          call
        })
        continue
      }
      if (token.value === "${" || token.value === "[") {
        stack.push({ kind: "expression", angles: 0, closer: CLOSER[token.value] })
        continue
      }
      if (token.value === ":" && label === depth) {
        token.label = true
        label = -1
      }
      // A `<` flush against a name opens type arguments (biome spaces a comparison), and so does
      // one after punctuation such as `:` or `=`, where no comparison can start, as in
      // `run: <A, E>(...)`. Inside them, the commas of `Map<K, V>` separate arguments, not members.
      const typeArguments =
        (previous?.type === "name" && touching(previous, token)) ||
        (previous?.type === "punct" && ![")", "]", "}"].includes(previous.value))
      if (container !== undefined && token.value === "<" && typeArguments) container.angles++
      if (container !== undefined && token.value === ">" && container.angles > 0) container.angles--
      if (token.value === "}" || token.value === ")" || token.value === "]") {
        const frame = stack.pop()
        if (frame?.closer !== token.value) balanced = false
        const parameters =
          frame?.closer === ")" &&
          (next?.value === "=>" ||
            ((frame.params || !frame.call) && (next?.value === "{" || next?.value === ":")))
        // A parameter list, or the head of an `if`, `for` or `catch`: what it binds is not a
        // declaration of the scope around it.
        if (parameters) declarations.length = frame.from
        while ((open.at(-1)?.depth ?? -1) > stack.length) open.pop()
        continue
      }
    }
    if (token.type !== "name" && token.type !== "string") continue
    if ((token.value === "case" || token.value === "default") && container?.kind === "block") {
      label = depth
    }
    const memberStart =
      container?.kind === "members" &&
      container.angles === 0 &&
      (previous?.value === "{" ||
        previous?.value === "," ||
        previous?.value === ";" ||
        (token.first && !OPEN_ENDED.has(previous?.value ?? "")))
    if (memberStart) {
      let name = at
      while (MODIFIERS.has(tokens[name]?.value) && isNameish(tokens[name + 1])) name++
      if (tokens[name]?.value === "*") name++
      if (isNameish(tokens[name]) && AFTER_MEMBER.has(tokens[name + 1]?.value ?? "")) {
        record(tokens[name].value, "member", name)
        at = name
        continue
      }
    }
    if (token.type !== "name" || !DECLARING.has(token.value)) continue
    // `x.type` is a property and `as const` an assertion; neither declares anything.
    if (previous?.value === "." || previous?.value === "?." || previous?.value === "as") continue
    // `const enum E` is an enum, and `function* g` a function.
    const enumerated = token.value === "enum" || (token.value === "const" && next?.value === "enum")
    const name = at + (next?.value === "*" || (token.value === "const" && enumerated) ? 2 : 1)
    if (token.value === "class" || token.value === "interface" || enumerated) header = depth
    const declared = tokens[name]
    const after = tokens[name + 1]?.value
    if (declared?.type !== "name") continue
    if (token.value === "type" && after !== "=" && after !== "<") continue
    if (token.value === "namespace" && after !== "{" && after !== ".") continue
    record(declared.value, enumerated ? "enum" : token.value, name)
    at = name
  }
  return balanced && stack.length === 0 ? declarations : null
}

/**
 * Whether `chain` (`["Outer", "inner"]`) names a top-level declaration and then, link by link, a
 * declaration directly inside the one before it. Directly: `inner` declared three functions down
 * inside `Outer` is not `Outer::inner`.
 */
export const declares = (declarations, chain) => {
  let found = declarations.filter((d) => d.depth === 0 && d.name === chain[0])
  for (const name of chain.slice(1)) {
    found = declarations.filter((d) => d.name === name && found.includes(d.parent))
  }
  return found.length > 0
}

// --- the rules -----------------------------------------------------------------------------------

const EXTENSIONS = [
  "ts|tsx|mts|cts|js|mjs|cjs",
  "json|jsonc|jsonl|yml|yaml|toml|lock",
  "sql|md|mdx|txt|d2|html|css|astro|sh"
].join("|")
/** A file: a name with one of those extensions, or any path with a directory in it. */
const PATH = `(?:[\\w@.\\/-]*\\.(?:${EXTENSIONS})|[\\w@.-]+(?:\\/[\\w@.-]+)+)`
/** One cited line or range: `:12`, `:12-20`, `:12:5` (with a column), `#L12`, or `#L12-L20`. */
const LINES = ":\\d+(?::\\d+)?(?:-\\d+(?::\\d+)?)?|#L\\d+(?:C\\d+)?(?:-L?\\d+(?:C\\d+)?)?"
/** A line citation: an optional path, its lines, more after commas, and any trailing name. */
const LINE_CITATION = new RegExp(
  `^(${PATH})?((?:${LINES})(?:\\s*,\\s*(?:${LINES}|\\d+(?:-\\d+)?))*)(?:\\s.*)?$`
)
/** A span that starts by naming a file, which a following bare `:N` continues. */
const NAMES_FILE = new RegExp(`^${PATH}(?=$|[:#\\s])`)
const SYMBOL_CITATION = /^(?<path>[\w@./-]+)::(?<chain>[#$\w]+(?:::[#$\w]+)*)$/
const REPO_PATH = /^(?:apps|packages|scripts|tests-integration|docs)\/\S*$/
/** A bare file name, which is a repository path only when it names a root-level file. */
const BARE_FILE = new RegExp(`^[\\w.-]+\\.(?:${EXTENSIONS})$`)
/** Directories a build writes, which a clean checkout does not have. */
const OUTPUTS = new Set(["dist", "dist-package", "node_modules", "coverage", ".turbo", ".astro"])

/**
 * The path and the cited line ranges of a line citation, or `null` for a span that is not one.
 * `path` is `null` for a bare `:N`, which continues whatever file the text named before it.
 */
export const lineCitation = (content) => {
  const match = LINE_CITATION.exec(content)
  if (match === null) return null
  // A column after either end (`:12:5`, `#L12C5`) is read past, never as a line of its own.
  const ends = /(\d+)(?:[:C]\d+)?(?:-L?(\d+)(?:[:C]\d+)?)?/g
  const ranges = [...(match[2] ?? "").matchAll(ends)].map((range) => {
    const first = Number(range[1])
    return [first, range[2] === undefined ? first : Number(range[2])]
  })
  return { path: match[1] ?? null, ranges }
}

/** The part of a repository path a clean checkout must hold: up to a glob, a placeholder, or a build output. */
const checkablePrefix = (path) => {
  const wild = path.search(/[*?[{<…$]/)
  const literal = wild === -1 ? path : path.slice(0, path.lastIndexOf("/", wild) + 1)
  const segments = literal.split("/")
  const output = segments.findIndex((segment) => OUTPUTS.has(segment))
  return output === -1 ? literal : `${segments.slice(0, output).join("/")}/`
}

/**
 * A descriptor for the regular file at `absolute`, or `null` when nothing is there or it is not a
 * regular file. The caller checks and reads through this one descriptor, so the file it reads is
 * the file it checked.
 */
const openRegularFile = (absolute) => {
  let descriptor
  try {
    descriptor = openSync(absolute, "r")
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
    throw error
  }
  if (fstatSync(descriptor).isFile()) return descriptor
  closeSync(descriptor)
  return null
}

const sources = new Map()
/** The declarations of one repository file, or a reason they cannot be read. */
const declarationsOf = (path) => {
  if (!sources.has(path)) {
    const descriptor = openRegularFile(join(ROOT, path))
    let entry
    if (descriptor === null) entry = { problem: "no such file" }
    else {
      try {
        if (!CODE.test(path)) {
          entry = {
            problem: "symbols are read only from TypeScript and JavaScript; cite the bare path"
          }
        } else {
          const declarations = declarationsIn(readFileSync(descriptor, "utf8"))
          entry =
            declarations === null
              ? { problem: "its declarations could not be read" }
              : { declarations }
        }
      } finally {
        closeSync(descriptor)
      }
    }
    sources.set(path, entry)
  }
  return sources.get(path)
}

const failures = []
const fail = (file, line, problem) => failures.push({ file, line, problem })
let symbols = 0
let paths = 0
/** Bare file names the root does not hold now, each with every span that names it. */
const absentNames = new Map()

const checkHandDoc = (file) => {
  // The block of the last span that named a file: a bare `:N` in that block continues it.
  let namedIn = -1
  for (const span of codeSpans(readFileSync(join(ROOT, file), "utf8"))) {
    const content = span.content.trim()
    const cited = lineCitation(content)
    const continues = cited?.path === null && namedIn === span.block
    if (NAMES_FILE.test(content)) namedIn = span.block
    if (cited !== null && (cited.path !== null || continues)) {
      fail(file, span.line, `\`${content}\` cites a line; cite \`path::Symbol\` or the bare path`)
      continue
    }
    const symbol = SYMBOL_CITATION.exec(content)
    // `Schema::Struct` is not a citation; one names a file, so its path has a `/` or an extension.
    if (symbol?.groups !== undefined && /[./]/.test(symbol.groups.path)) {
      symbols++
      const { path, chain } = symbol.groups
      const source = declarationsOf(path)
      if (source.problem !== undefined)
        fail(file, span.line, `\`${content}\`: ${path}: ${source.problem}`)
      else if (!declares(source.declarations, chain.split("::"))) {
        fail(file, span.line, `\`${content}\`: ${path} declares no \`${chain}\``)
      }
      continue
    }
    if (REPO_PATH.test(content)) {
      paths++
      if (!existsSync(join(ROOT, checkablePrefix(content)))) {
        fail(file, span.line, `\`${content}\` names a path that does not exist`)
      }
      continue
    }
    if (BARE_FILE.test(content)) {
      if (existsSync(join(ROOT, content))) paths++
      else
        absentNames.set(content, [...(absentNames.get(content) ?? []), { file, line: span.line }])
    }
  }
}

/**
 * Fail every bare name that HEAD's history held at the root and the root no longer holds. One
 * `git log` over all of them, each as a literal root-level pathspec, lists the ones it touched.
 */
const checkRootFiles = () => {
  if (absentNames.size === 0) return
  const pathspecs = [...absentNames.keys()].map((name) => `:(top,literal)${name}`)
  const listed = git(["log", "--format=", "--name-only", "-z", "HEAD", "--", ...pathspecs])
  const held = new Set(listed.stdout.split(/[\0\n]/).filter((name) => name !== ""))
  for (const [name, spans] of absentNames) {
    if (!held.has(name)) continue
    paths += spans.length
    for (const { file, line } of spans) {
      fail(file, line, `\`${name}\` names a root-level file that does not exist`)
    }
  }
}

const commits = new Map()
/** The full sha of a stamped commit, or `null` when the clone does not hold it. */
const commitOf = (sha) => {
  if (!commits.has(sha)) {
    const exists = git(["cat-file", "-e", `${sha}^{commit}`]).status === 0
    commits.set(sha, exists ? git(["rev-parse", `${sha}^{commit}`]).stdout.trim() : null)
  }
  return commits.get(sha)
}

const ancestry = new Map()
/** Whether a commit is HEAD or one of its ancestors, so that the page describes this history. */
const isAncestor = (sha) => {
  if (!ancestry.has(sha)) {
    ancestry.set(sha, git(["merge-base", "--is-ancestor", sha, "HEAD"]).status === 0)
  }
  return ancestry.get(sha)
}

/** The commit a generated page says it describes, from its front matter or its `Built from` line. */
const stampOf = (text) => {
  const lines = text.split("\n")
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1)
    for (const line of lines.slice(1, end === -1 ? 1 : end)) {
      const field = /^commit:\s*["']?([^"'\s]*)["']?\s*$/.exec(line)
      if (field !== null) {
        return /^[0-9a-f]{40}$/.test(field[1] ?? "")
          ? { sha: field[1], line: lines.indexOf(line) + 1 }
          : { problem: `front matter \`commit: ${field[1]}\` is not a 40-hex sha` }
      }
    }
  }
  const built = lines.findIndex((line) => /^>\s*Built from commit\b/.test(line))
  const sha = /Built from commit\W*([0-9a-f]{7,40})\b/.exec(lines[built] ?? "")?.[1]
  if (sha !== undefined) return { sha, line: built + 1 }
  return {
    problem: "names no commit: add `commit: <sha>` front matter or a `> Built from commit` line"
  }
}

const stamps = new Set()
/** Every line citation on a stamped page, to be read at the page's commit. */
const pageCitations = []

const checkCodebasePage = (file) => {
  const text = readFileSync(join(ROOT, file), "utf8")
  const stamp = stampOf(text)
  const sha = stamp.problem === undefined ? commitOf(stamp.sha) : null
  if (stamp.problem !== undefined) fail(file, 1, stamp.problem)
  else if (sha === null) fail(file, stamp.line, `commit ${stamp.sha} does not exist in this clone`)
  else if (!isAncestor(sha)) {
    fail(file, stamp.line, `commit ${stamp.sha} is not an ancestor of HEAD`)
  } else collectPageCitations(file, text, sha)
}

/** Queue every line citation on a page stamped at `sha`, to be read at that commit. */
const collectPageCitations = (file, text, sha) => {
  stamps.add(sha)
  // The file the block last named, which a bare `:N` continues, as in a hand doc.
  let named = { block: -1, path: "" }
  for (const span of codeSpans(text)) {
    const content = span.content.trim()
    const cited = lineCitation(content)
    const path = cited?.path ?? (named.block === span.block ? named.path : null)
    const naming = NAMES_FILE.exec(content)?.[0]
    if (naming !== undefined) named = { block: span.block, path: naming }
    if (cited !== null && path !== null) {
      pageCitations.push({ file, line: span.line, content, sha, path, ranges: cited.ranges })
    }
  }
}

/**
 * The line count of each `sha:path` object, or `null` where the commit holds no file at that path.
 * One `git cat-file --batch` reads them all: each answer is `<oid> <type> <size>` and the bytes, or
 * `<object> missing`.
 */
const lineCountsAt = (objects) => {
  const run = spawnSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input: `${objects.join("\n")}\n`,
    maxBuffer: 1 << 30
  })
  const out = run.stdout ?? Buffer.alloc(0)
  const counts = new Map()
  let at = 0
  for (const object of objects) {
    const end = out.indexOf(10, at)
    if (end === -1) break
    const header = out.toString("utf8", at, end).split(" ")
    at = end + 1
    const size = Number(header[2])
    if (header.length !== 3 || !Number.isInteger(size)) {
      counts.set(object, null)
      continue
    }
    let lines = 0
    for (let byte = at; byte < at + size; byte++) if (out[byte] === 10) lines++
    if (size > 0 && out[at + size - 1] !== 10) lines++
    counts.set(object, header[1] === "blob" ? lines : null)
    at += size + 1
  }
  return counts
}

/** Read every stamped page's line citations at that page's commit. */
const checkPageCitations = () => {
  const objects = [...new Set(pageCitations.map(({ sha, path }) => `${sha}:${path}`))]
  const counts = lineCountsAt(objects)
  for (const { file, line, content, sha, path, ranges } of pageCitations) {
    const lines = counts.get(`${sha}:${path}`) ?? null
    const at = sha.slice(0, 12)
    if (lines === null) fail(file, line, `\`${content}\`: ${path} is not a file at ${at}`)
    else if (ranges.some(([first, last]) => first < 1 || last < first || last > lines)) {
      fail(file, line, `\`${content}\`: ${path} has ${lines} lines at ${at}`)
    }
  }
}

/** Check every hand doc and every codebase page, report, and exit. */
const main = () => {
  const files = repositoryFiles()
  const handDocs = files.filter(isHandDoc)
  const codebasePages = files.filter(isCodebasePage)
  for (const file of handDocs) checkHandDoc(file)
  checkRootFiles()
  for (const file of codebasePages) checkCodebasePage(file)
  checkPageCitations()

  if (failures.length > 0) {
    for (const { file, line, problem } of failures) console.error(`${file}:${line}: ${problem}`)
    console.error(
      `doc citations FAILED: ${failures.length} problem${failures.length === 1 ? "" : "s"}. ` +
        "Cite code as `path::Symbol` (or `path::Outer::inner`), never by line; " +
        "regenerate docs/codebase/ rather than editing it."
    )
    process.exit(1)
  }
  console.log(
    `doc citations ok: ${symbols} symbol citations and ${paths} repository paths in ` +
      `${handDocs.length} hand docs; ${codebasePages.length} codebase pages stamped at ` +
      `${stamps.size} commit${stamps.size === 1 ? "" : "s"}, ` +
      `${pageCitations.length} line citations read there`
  )
}

// Run only as a script, so a harness can import the scanner without running the check.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
