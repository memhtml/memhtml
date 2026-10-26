#!/usr/bin/env node
/**
 * Hand-written docs cite code by symbol, and this is the check that keeps each citation true.
 *
 * A line number goes stale at the next commit that edits the cited file above it, and nothing
 * notices: the citation still reads as a citation, it just names some other line. A symbol survives
 * every edit that keeps the declaration, and when the declaration goes, this check fails at the
 * commit that removed it.
 *
 * The hand docs are every Markdown file under `docs/` except `docs/codebase/` (generated at a
 * commit), `docs/reference/` (generated from the code), `docs/rfcs/` (frozen proposals) and
 * `docs/bugs/` (dated reports), plus `README.md`, `CLAUDE.md`, and the docs site's authored pages
 * under `apps/docs/src/content/docs/` except the generated `api/` and `agents.md`. In each of them a
 * code span is checked by what it holds:
 *
 * - `path:N`, `path:N-M`, or a bare `:N` that continues one is a line citation, and it fails.
 * - `path::Symbol` must name a file that declares `Symbol` at its top level: a function, class,
 *   const, let, var, interface, type, enum or namespace, exported or not. `path::Outer::inner` must
 *   also find `inner` declared inside `Outer`: a member of a class, interface or object literal, or
 *   a function or const nested in its body. That last form exists because most of this codebase is
 *   Effect closures, where the code a sentence means is a const inside `makeStore`, not
 *   `makeStore` itself.
 * - A repository path (`apps/…`, `packages/…`, `scripts/…`, `tests-integration/…`) must exist.
 *   A glob or a `<placeholder>` is checked up to the directory before it, and a build output such as
 *   `dist/` up to the package that builds it, so the check never depends on a build having run.
 *
 * Every page under `docs/codebase/` is generated against one commit, and its line citations are
 * true for that commit, so they are never read against HEAD. The one rule there is that each page
 * names its commit, as `commit: <40-hex sha>` in its front matter or else on its
 * `> Built from commit` line, and that the commit exists in this clone (`git cat-file -e`). CI
 * therefore checks out full history: a shallow clone holds no commit but its own.
 *
 * Declarations are read by a small scanner rather than a parser. TypeScript 7, which the repository
 * compiles with, has no in-process compiler API, and a parser would be a new dependency for a
 * question this narrow. The scanner drops comments, strings, template text and regular expressions,
 * tracks bracket nesting, and reads the declaration forms above. It relies on the formatting biome
 * enforces, where a statement or member ends at the next line that starts at its own depth and
 * indentation. A file whose brackets do not balance after scanning is reported as unreadable
 * rather than guessed at.
 *
 *   node scripts/doc-citations.mjs              check this repository
 *   node scripts/doc-citations.mjs --root DIR   check the git checkout at DIR
 *
 * Exits 0 with a one-line summary, or 1 with one `file:line: problem` line per failure.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
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

/** A dot-directory under `docs/` holds a generator's working files, not pages. */
const isPage = (file) =>
  MARKDOWN.test(file) && !file.split("/").some((part) => part.startsWith("."))

const isHandDoc = (file) => {
  if (file === "README.md" || file === "CLAUDE.md") return true
  if (!isPage(file)) return false
  if (file.startsWith(SITE)) {
    const page = file.slice(SITE.length)
    return !page.startsWith("api/") && page !== "agents.md"
  }
  return (
    file.startsWith("docs/") &&
    !["docs/codebase/", "docs/reference/", "docs/rfcs/", "docs/bugs/"].some((dir) =>
      file.startsWith(dir)
    )
  )
}

const isCodebasePage = (file) => file.startsWith("docs/codebase/") && isPage(file)

// --- code spans in Markdown ----------------------------------------------------------------------

/**
 * Every inline code span in a Markdown file, with the line its opening backticks sit on.
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
  const flush = () => {
    if (block.length > 0) spans.push(...spansInBlock(block))
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

const spansInBlock = (block) => {
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
    spans.push({ content, line: lineAt(index) })
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
 * Every declaration in a source file, each with the declaration it sits inside. Returns `null` when
 * the brackets do not balance, which means the scanner misread the file and nothing it found can
 * be trusted.
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
  const record = (name, kind, at) => {
    const depth = stack.length
    while ((open.at(-1)?.depth ?? -1) >= depth) open.pop()
    const declaration = { name, kind, line: tokens[at].line, depth, indent: indentOf[at] }
    declaration.parent = open.at(-1) ?? null
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
        stack.push({ kind: members ? "members" : "block", angles: 0 })
        continue
      }
      if (token.value === "${" || token.value === "(" || token.value === "[") {
        stack.push({ kind: "expression", angles: 0 })
        continue
      }
      if (token.value === ":" && label === depth) {
        token.label = true
        label = -1
      }
      // A `<` written flush against a name opens type arguments (biome spaces a comparison), and
      // the commas inside `Map<K, V>` separate arguments, not members.
      const flush =
        previous?.type === "name" &&
        previous.line === token.line &&
        previous.column + previous.value.length === token.column
      if (container !== undefined && token.value === "<" && flush) container.angles++
      if (container !== undefined && token.value === ">" && container.angles > 0) container.angles--
      if (token.value === "}" || token.value === ")" || token.value === "]") {
        stack.pop()
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
  return stack.length === 0 ? declarations : null
}

const within = (declaration, ancestor) => {
  for (let at = declaration.parent; at !== null; at = at.parent) if (at === ancestor) return true
  return false
}

/** Whether `chain` (`["Outer", "inner"]`) names a top-level declaration and, in turn, ones inside it. */
export const declares = (declarations, chain) => {
  let found = declarations.filter((d) => d.depth === 0 && d.name === chain[0])
  for (const name of chain.slice(1)) {
    found = declarations.filter((d) => d.name === name && found.some((outer) => within(d, outer)))
  }
  return found.length > 0
}

// --- the rules -----------------------------------------------------------------------------------

const EXTENSIONS =
  "ts|tsx|mts|cts|js|mjs|cjs|json|jsonc|sql|md|mdx|yml|yaml|toml|d2|html|css|astro|sh"
const PATH = `[\\w@.\\/-]*(?:\\.(?:${EXTENSIONS}))`
const RANGE = "\\d+(?:-\\d+)?"
const LINE_CITATION = new RegExp(`^(?:${PATH})?:${RANGE}(?:\\s*,\\s*:?${RANGE})*$`)
const SYMBOL_CITATION = /^(?<path>[\w@./-]+)::(?<chain>[#$\w]+(?:::[#$\w]+)*)$/
const REPO_PATH = /^(?:apps|packages|scripts|tests-integration)\/\S*$/
/** Directories a build writes, which a clean checkout does not have. */
const OUTPUTS = new Set(["dist", "dist-package", "node_modules", "coverage", ".turbo", ".astro"])

/** The part of a repository path a clean checkout must hold: up to a glob, a placeholder, or a build output. */
const checkablePrefix = (path) => {
  const wild = path.search(/[*?[{<…$]/)
  const literal = wild === -1 ? path : path.slice(0, path.lastIndexOf("/", wild) + 1)
  const segments = literal.split("/")
  const output = segments.findIndex((segment) => OUTPUTS.has(segment))
  return output === -1 ? literal : `${segments.slice(0, output).join("/")}/`
}

const sources = new Map()
/** The declarations of one repository file, or a reason they cannot be read. */
const declarationsOf = (path) => {
  if (!sources.has(path)) {
    const absolute = join(ROOT, path)
    let entry
    if (!existsSync(absolute) || !statSync(absolute).isFile()) entry = { problem: "no such file" }
    else if (!CODE.test(path)) {
      entry = {
        problem: "symbols are read only from TypeScript and JavaScript; cite the bare path"
      }
    } else {
      const declarations = declarationsIn(readFileSync(absolute, "utf8"))
      entry =
        declarations === null ? { problem: "its declarations could not be read" } : { declarations }
    }
    sources.set(path, entry)
  }
  return sources.get(path)
}

const failures = []
const fail = (file, line, problem) => failures.push({ file, line, problem })
let symbols = 0
let paths = 0

const checkHandDoc = (file) => {
  for (const span of codeSpans(readFileSync(join(ROOT, file), "utf8"))) {
    const content = span.content.trim()
    if (LINE_CITATION.test(content)) {
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

/** Check every hand doc and every codebase page, report, and exit. */
const main = () => {
  const files = repositoryFiles()
  const handDocs = files.filter(isHandDoc)
  const codebasePages = files.filter(isCodebasePage)
  for (const file of handDocs) checkHandDoc(file)
  const stamps = new Set()
  for (const file of codebasePages) {
    const stamp = stampOf(readFileSync(join(ROOT, file), "utf8"))
    if (stamp.problem !== undefined) fail(file, 1, stamp.problem)
    else if (commitOf(stamp.sha) === null) {
      fail(file, stamp.line, `commit ${stamp.sha} does not exist in this clone`)
    } else stamps.add(commitOf(stamp.sha))
  }

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
      `${stamps.size} commit${stamps.size === 1 ? "" : "s"}`
  )
}

// Run only as a script, so a harness can import the scanner without running the check.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
