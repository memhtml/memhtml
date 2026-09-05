import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

/**
 * Reading the repository's own registries at build time.
 *
 * Two doors, and which one a registry comes through is decided by where it lives. Anything
 * `@memhtml/cli` exports arrives as a VALUE, imported directly — that is the whole point of
 * `apps/docs` depending on the CLI. Everything else is read out of its source file HERE, because
 * `apps/docs` declares no dependency on `@memhtml/contracts`, `@memhtml/sleep`, `@memhtml/index`, or
 * `@memhtml/mcp`, and a cross-package `dist` import would race turbo: the docs `build` task inherits
 * `^build` from its declared dependencies only, so `@memhtml/mcp#build` may still be running when
 * this file executes. Source text is present whatever the build order is.
 *
 * The reader is the TypeScript AST rather than a regular expression. A registry entry spans lines,
 * carries a doc comment worth publishing, and — in `apps/mcp` — builds its description by
 * concatenating shared constants, which is exactly the shape a regex reads wrongly and silently.
 * Every accessor here THROWS when a registry is missing, renamed, or shaped differently than it
 * reads: a build failure names the drift, where a fallback would publish a page that quietly lost a
 * row.
 *
 * ## `typescript` is a LIBRARY here, and that is why `apps/docs` pins a different major than the root
 *
 * The repository compiles with `typescript` 7.x at the root while `apps/docs/package.json` pins 6.x,
 * and the two are separate roles for one package name: 7.x is the compiler `tsc -b` runs, 6.x is the
 * in-process parser this file calls. Both of this package's uses need 6.x, measured 2026-08-14
 * against 7.0.2:
 *
 * - **There is no in-process parse.** `import ts from "typescript"` yields exactly
 *   `{ version, versionMajorMinor }`; the node predicates moved to `typescript/unstable/ast`, which
 *   exports no `createSourceFile`, and parsing goes through `typescript/unstable/sync`'s `API` — an
 *   out-of-process client that spawns the native compiler and holds project snapshots. Reading six
 *   standalone files at build time does not want a compiler server, and `unstable` is the vendor's own
 *   label for how settled that surface is.
 * - **`astro check` refuses it anyway.** `@astrojs/check@0.9.10` declares
 *   `peerDependencies: { typescript: "^5.0.0 || ^6.0.0" }`, and it is this package's `typecheck` task.
 *
 * `.github/dependabot.yml` therefore ignores `typescript` majors, and names both conditions that have
 * to change before the pin moves.
 */

const findRepoRoot = (): string => {
  let directory = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error("no pnpm-workspace.yaml above apps/docs/src/loaders")
    directory = parent
  }
  return directory
}

/** The monorepo root, found by walking up to `pnpm-workspace.yaml`. */
export const REPO_ROOT = findRepoRoot()

/** One repo-relative file, verbatim. */
export const sourceText = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8")

/** The `.sql`/`.json`/`.ts` files directly inside a repo-relative directory, in filename order. */
export const sourceNames = (relativeDir: string, extension: string): ReadonlyArray<string> =>
  readdirSync(join(REPO_ROOT, relativeDir))
    .filter((name) => name.endsWith(extension))
    .sort()

/**
 * Every `.ts` file under a repo-relative directory, recursively, in path order.
 *
 * Emitted output and installed packages are skipped: a census that counted `dist` would report each
 * hit twice, once in the source it came from and once in the JavaScript built from it.
 */
export const tsFilesUnder = (relativeDir: string): ReadonlyArray<string> => {
  const walk = (directory: string): ReadonlyArray<string> =>
    readdirSync(join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === "dist" ? [] : walk(path)
      }
      return entry.name.endsWith(".ts") ? [path] : []
    })
  return [...walk(relativeDir)].sort()
}

/**
 * The `case "X": return "Y"` pairs of a switch inside a top-level arrow function, plus its default.
 *
 * `apps/cli/src/errors.ts` states the whole domain-error-to-envelope-code mapping as one such
 * switch, and it is the only statement of it anywhere: reading it is how an error-code page can say
 * which failures produce a code without a human keeping a second table.
 */
export const switchReturnsOf = (
  relativePath: string,
  functionName: string
): ReadonlyArray<{ readonly match: string | undefined; readonly returns: string }> => {
  const initializer = declaration(relativePath, functionName).initializer
  const pairs: Array<{ match: string | undefined; returns: string }> = []
  const returned = (clause: ts.CaseOrDefaultClause): string | undefined => {
    for (const statement of clause.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) {
        const value = unwrap(statement.expression)
        if (ts.isStringLiteralLike(value)) return value.text
      }
    }
    return undefined
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const returns = returned(node)
      const matched = ts.isCaseClause(node) ? unwrap(node.expression) : undefined
      const match = matched && ts.isStringLiteralLike(matched) ? matched.text : undefined
      if (returns !== undefined) pairs.push({ match, returns })
    }
    ts.forEachChild(node, visit)
  }
  visit(initializer)
  if (pairs.length === 0)
    throw new Error(`${relativePath}: \`${functionName}\` switches on nothing`)
  return pairs
}

const parsed = new Map<string, ts.SourceFile>()

/**
 * Drop every parsed file, so the next read is off disk.
 *
 * One collection load reads each registry once and caches the parse, which is what keeps a build
 * from re-parsing the same file for a dozen pages. A dev server loads the collection again whenever
 * content changes, and a cache surviving that would serve pages built from the registry as it was
 * when the server started.
 */
export const resetSourceCache = (): void => {
  parsed.clear()
  declarations.clear()
}

/** One repo-relative TypeScript file as an AST, parsed once per load. */
export const sourceAst = (relativePath: string): ts.SourceFile => {
  const cached = parsed.get(relativePath)
  if (cached) return cached
  const file = ts.createSourceFile(
    relativePath,
    sourceText(relativePath),
    ts.ScriptTarget.Latest,
    true
  )
  parsed.set(relativePath, file)
  return file
}

const unwrap = (node: ts.Expression): ts.Expression => {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return unwrap(node.expression)
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression)
  return node
}

interface Declared {
  readonly statement: ts.VariableStatement
  readonly initializer: ts.Expression
}

const declarationsOf = (file: ts.SourceFile): ReadonlyMap<string, Declared> => {
  const found = new Map<string, Declared>()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      found.set(declaration.name.text, { statement, initializer: unwrap(declaration.initializer) })
    }
  }
  return found
}

const declarations = new Map<string, ReadonlyMap<string, Declared>>()

const topLevel = (relativePath: string): ReadonlyMap<string, Declared> => {
  const cached = declarations.get(relativePath)
  if (cached) return cached
  const found = declarationsOf(sourceAst(relativePath))
  declarations.set(relativePath, found)
  return found
}

const declaration = (relativePath: string, name: string): Declared => {
  const found = topLevel(relativePath).get(name)
  if (!found) throw new Error(`${relativePath} declares no top-level \`${name}\``)
  return found
}

/**
 * A doc comment, as Markdown-ready prose.
 *
 * `{@link X}` becomes a code span rather than being dropped: the target is a symbol name, which is
 * what a reader wants to see, and this site has no symbol index to link it into.
 */
export const docCommentOf = (file: ts.SourceFile, node: ts.Node): string | undefined => {
  const last = docBlocksOf(file, node).at(-1)
  return last === undefined ? undefined : cleanDocComment(last)
}

const docBlocksOf = (file: ts.SourceFile, node: ts.Node): ReadonlyArray<string> =>
  (ts.getLeadingCommentRanges(file.text, node.pos) ?? [])
    .map((range) => file.text.slice(range.pos, range.end))
    .filter((text) => text.startsWith("/**"))

const cleanDocComment = (block: string): string =>
  block
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .replace(/\{@link\s+([^}]+)\}/g, "`$1`")
    .trim()

/** The doc comment on a top-level declaration. */
export const docCommentFor = (relativePath: string, name: string): string | undefined =>
  docCommentOf(sourceAst(relativePath), declaration(relativePath, name).statement)

/**
 * A module's own prologue: the doc comment stating what the file is for.
 *
 * TypeScript attaches every comment between the imports and the first declaration to that
 * declaration, so a file opening with a prologue and then documenting its first constant leaves two
 * blocks in one node's leading trivia. The prologue is the first of them. Read from the first
 * statement that is not an import, since a prologue placed above the imports belongs to the file
 * rather than to any declaration.
 */
export const moduleDocOf = (relativePath: string): string | undefined => {
  const file = sourceAst(relativePath)
  const first = file.statements.find((statement) => !ts.isImportDeclaration(statement))
  if (!first) return undefined
  const block = docBlocksOf(file, first).at(0)
  return block === undefined ? undefined : cleanDocComment(block)
}

/** The identifiers a `const NAME = f(a, b, c)` initializer passes as arguments, in order. */
export const callArgumentIdentifiers = (
  relativePath: string,
  name: string
): ReadonlyArray<string> => {
  const { initializer } = declaration(relativePath, name)
  if (!ts.isCallExpression(initializer)) {
    throw new Error(`${relativePath}'s \`${name}\` is not a call`)
  }
  return initializer.arguments.map((argument) => {
    if (!ts.isIdentifier(argument)) {
      throw new Error(`${relativePath}'s \`${name}\` takes a non-identifier argument`)
    }
    return argument.text
  })
}

/** A `const NAME = ["a", "b"] as const` array of string literals. */
export const stringArrayConst = (relativePath: string, name: string): ReadonlyArray<string> => {
  const { initializer } = declaration(relativePath, name)
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`${relativePath}'s \`${name}\` is not an array literal`)
  }
  return initializer.elements.map((element) => {
    if (!ts.isStringLiteralLike(element)) {
      throw new Error(`${relativePath}'s \`${name}\` holds a non-literal member`)
    }
    return element.text
  })
}

/** The identifiers a `const NAME = [a, b]` array names, in order. */
const identifierArrayConst = (relativePath: string, name: string): ReadonlyArray<string> => {
  const { initializer } = declaration(relativePath, name)
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`${relativePath}'s \`${name}\` is not an array literal`)
  }
  return initializer.elements.map((element) => {
    if (!ts.isIdentifier(element)) {
      throw new Error(`${relativePath}'s \`${name}\` holds a non-identifier member`)
    }
    return element.text
  })
}

/** The `[a, b]` pairs a `const NAME: ReadonlyArray<readonly [X, Y]>` array names. */
export const stringPairArrayConst = (
  relativePath: string,
  name: string
): ReadonlyArray<readonly [string, string]> => {
  const { initializer } = declaration(relativePath, name)
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`${relativePath}'s \`${name}\` is not an array literal`)
  }
  return initializer.elements.map((element) => {
    const pair = unwrap(element)
    if (!ts.isArrayLiteralExpression(pair) || pair.elements.length !== 2) {
      throw new Error(`${relativePath}'s \`${name}\` holds a member that is not a pair`)
    }
    const [left, right] = pair.elements
    if (!left || !right || !ts.isStringLiteralLike(left) || !ts.isStringLiteralLike(right)) {
      throw new Error(`${relativePath}'s \`${name}\` holds a pair of non-literals`)
    }
    return [left.text, right.text] as const
  })
}

/**
 * A string-valued expression, folded.
 *
 * `apps/mcp` builds every tool description as `LITERAL + SHARED_CONSTANT + LITERAL`, so the value a
 * client reads exists nowhere in the file as one span. Folding resolves each identifier through the
 * file's own top-level declarations, which is what makes the published description and the page the
 * same bytes.
 */
const foldString = (
  relativePath: string,
  node: ts.Expression,
  seen: ReadonlySet<string> = new Set()
): string => {
  const expression = unwrap(node)
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      throw new Error(`${relativePath}: cannot fold a non-concatenating operator into a string`)
    }
    return (
      foldString(relativePath, expression.left, seen) +
      foldString(relativePath, expression.right, seen)
    )
  }
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) {
      throw new Error(`${relativePath}: \`${expression.text}\` folds into itself`)
    }
    return foldString(
      relativePath,
      declaration(relativePath, expression.text).initializer,
      new Set([...seen, expression.text])
    )
  }
  throw new Error(`${relativePath}: cannot fold \`${expression.getText()}\` into a string`)
}

const property = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue
    const key = member.name
    const text = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined
    if (text === name) return unwrap(member.initializer)
  }
  return undefined
}

const requiredProperty = (
  relativePath: string,
  object: ts.ObjectLiteralExpression,
  name: string
): ts.Expression => {
  const found = property(object, name)
  if (!found) throw new Error(`${relativePath}: an object literal is missing \`${name}\``)
  return found
}

/** A property whose value is a folded string. */
export const stringProperty = (
  relativePath: string,
  object: ts.ObjectLiteralExpression,
  name: string
): string => foldString(relativePath, requiredProperty(relativePath, object, name))

/** A property whose value is a `true`/`false` keyword. */
export const booleanProperty = (
  relativePath: string,
  object: ts.ObjectLiteralExpression,
  name: string
): boolean => {
  const value = requiredProperty(relativePath, object, name)
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false
  throw new Error(`${relativePath}: \`${name}\` is not a boolean literal`)
}

/** A property whose value is a numeric literal, kept as the authored text (`1.0`, not `1`). */
export const numericProperty = (
  relativePath: string,
  object: ts.ObjectLiteralExpression,
  name: string
): string => {
  const value = requiredProperty(relativePath, object, name)
  if (!ts.isNumericLiteral(value)) throw new Error(`${relativePath}: \`${name}\` is not numeric`)
  // `getText`, not `text`: the parsed `text` of `1.0` is `1`, and a weight table where one arm reads
  // `1` beside another's `0.5` invites a reader to think the scales differ.
  return value.getText()
}

/** One member of a registry that lists its members as identifiers: its own object literal. */
export interface ObjectMember {
  readonly identifier: string
  readonly object: ts.ObjectLiteralExpression
  readonly doc: string | undefined
}

/**
 * The object literals a `const NAME = [a, b, c]` registry names, in registry order.
 *
 * Registry order is a decision in this repository rather than an accident — `RANK_ARMS` fires in it
 * and `MemhtmlToolkit` publishes it — so the array is read for the order and each identifier is then
 * resolved to its own declaration, doc comment included.
 */
export const objectMembersOf = (
  relativePath: string,
  registryName: string
): ReadonlyArray<ObjectMember> =>
  objectMembersFor(relativePath, identifierArrayConst(relativePath, registryName))

/** The object literals a list of identifiers declares, in the order given. */
export const objectMembersFor = (
  relativePath: string,
  identifiers: ReadonlyArray<string>
): ReadonlyArray<ObjectMember> => {
  const file = sourceAst(relativePath)
  return identifiers.map((identifier) => {
    const { statement, initializer } = declaration(relativePath, identifier)
    if (!ts.isObjectLiteralExpression(initializer)) {
      throw new Error(`${relativePath}: \`${identifier}\` is not an object literal`)
    }
    return { identifier, object: initializer, doc: docCommentOf(file, statement) }
  })
}

/** One `const Identifier = X.make("name", { … })` declaration. */
export interface MakeCall {
  readonly identifier: string
  readonly name: string
  readonly object: ts.ObjectLiteralExpression
}

/**
 * Every `const Identifier = X.make("name", { … })` in a file, in source order.
 *
 * The declaring identifier comes back with the name because the registration list names the
 * identifier while the wire names the string, and reading the order of one needs the other.
 */
export const makeCallsOf = (relativePath: string, namespace: string): ReadonlyArray<MakeCall> => {
  const calls: Array<MakeCall> = []
  for (const [identifier, declared] of topLevel(relativePath)) {
    const call = declared.initializer
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) continue
    const target = call.expression
    if (
      !ts.isIdentifier(target.expression) ||
      target.expression.text !== namespace ||
      target.name.text !== "make"
    )
      continue
    const [first, second] = call.arguments
    if (
      !first ||
      !ts.isStringLiteralLike(first) ||
      !second ||
      !ts.isObjectLiteralExpression(second)
    )
      continue
    calls.push({ identifier, name: first.text, object: second })
  }
  return calls
}

/** One `const Identifier = factory({ … })` declaration: the spec object it hands the factory. */
export interface FactoryCall {
  readonly identifier: string
  readonly object: ts.ObjectLiteralExpression
}

/**
 * Every `const Identifier = factory({ … })` in a file, in source order.
 *
 * `apps/mcp` declares each resource by handing one spec object to a file-local factory, so a
 * resource's whole published surface — its URI template, name, description, and MIME type — is that
 * object's properties. The declaring identifier comes back with it because the registration list
 * names the identifier while the spec carries the wire values, and reading the order a server
 * publishes in needs the two joined.
 *
 * A generic call matches: TypeScript keeps `factory<E, R>({ … })`'s type arguments off the argument
 * list, so a spelled-out inference reads the same as an inferred one.
 */
export const factoryCallsOf = (
  relativePath: string,
  factoryName: string
): ReadonlyArray<FactoryCall> => {
  const calls: Array<FactoryCall> = []
  for (const [identifier, declared] of topLevel(relativePath)) {
    const call = declared.initializer
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue
    if (call.expression.text !== factoryName) continue
    const [first] = call.arguments
    if (!first || !ts.isObjectLiteralExpression(first)) continue
    calls.push({ identifier, object: first })
  }
  return calls
}

/**
 * A property naming a list of identifiers, written either inline or through a factory.
 *
 * `apps/mcp` declares a tool's ports both ways — `dependencies: [Store, DatabaseService]` and
 * `dependencies: READS()`, where `READS` is `() => [DatabaseService]` (a function per set, so one
 * tool's construction cannot mutate another's list). Both forms answer with the ports themselves,
 * because what a reader needs to know is which capabilities a tool can reach, not which spelling the
 * file used.
 */
export const identifierListProperty = (
  relativePath: string,
  object: ts.ObjectLiteralExpression,
  name: string
): ReadonlyArray<string> => {
  const value = requiredProperty(relativePath, object, name)
  const array = ts.isArrayLiteralExpression(value)
    ? value
    : factoryReturnedArray(relativePath, value)
  return array.elements.map((element) => {
    if (!ts.isIdentifier(element)) {
      throw new Error(`${relativePath}: \`${name}\` lists a non-identifier`)
    }
    return element.text
  })
}

const factoryReturnedArray = (
  relativePath: string,
  value: ts.Expression
): ts.ArrayLiteralExpression => {
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) {
    throw new Error(`${relativePath}: cannot read an identifier list from \`${value.getText()}\``)
  }
  const factory = declaration(relativePath, value.expression.text).initializer
  const body =
    ts.isArrowFunction(factory) && !ts.isBlock(factory.body) ? unwrap(factory.body) : undefined
  if (!body || !ts.isArrayLiteralExpression(body)) {
    throw new Error(`${relativePath}: \`${value.expression.text}\` returns no array literal`)
  }
  return body
}

/** One exported declaration of a module, as a reference page states it. */
export interface ExportedSymbol {
  readonly name: string
  /** What kind of thing was exported, in the vocabulary a reader of the page uses. */
  readonly kind: "constant" | "function" | "schema" | "class" | "interface" | "type"
  /** The declaration's head — its first line, without the doc comment and the `export` keyword. */
  readonly signature: string
  readonly doc: string | undefined
}

const kindOfInitializer = (initializer: ts.Expression): ExportedSymbol["kind"] => {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return "function"
  if (ts.isCallExpression(initializer)) {
    const callee = initializer.expression
    const root = ts.isPropertyAccessExpression(callee)
      ? callee.expression
      : ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)
        ? callee.expression.expression
        : callee
    if (ts.isIdentifier(root) && root.text === "Schema") return "schema"
  }
  return "constant"
}

/**
 * The head of a declaration: its first line, `export` dropped, a trailing `{` or `=` trimmed, and an
 * ellipsis when the declaration continues past that line — so a reader can tell `const X = [` from a
 * one-line constant and knows the source is where the rest is.
 */
const headOf = (file: ts.SourceFile, node: ts.Node): string => {
  const lines = node.getText(file).split("\n")
  const head = (lines[0] ?? "")
    .replace(/^export\s+(declare\s+)?/, "")
    .replace(/\s*[{=]\s*$/, "")
    .trim()
  return lines.length > 1 ? `${head} …` : head
}

/**
 * Every `export`ed top-level declaration of a module, in source order, with its doc comment.
 *
 * This is how a package's TSDoc reaches the Reference tier: the doc comments the maintainers already
 * write on `@memhtml/contracts` are the page, and the signature beside each is the declaration's own
 * first line. A declaration that exports several names (`export const a = 1, b = 2`) yields one
 * symbol per name. Re-exports (`export * from`) and default exports are skipped: the former point at
 * a module read on its own, the latter this repository does not write.
 */
export const exportedSymbolsOf = (relativePath: string): ReadonlyArray<ExportedSymbol> => {
  const file = sourceAst(relativePath)
  const symbols: Array<ExportedSymbol> = []
  const isExported = (node: ts.Node): boolean =>
    (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  for (const statement of file.statements) {
    if (!isExported(statement)) continue
    const doc = docCommentOf(file, statement)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        symbols.push({
          name: declaration.name.text,
          kind: kindOfInitializer(unwrap(declaration.initializer)),
          signature: headOf(file, statement),
          doc
        })
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push({
        name: statement.name.text,
        kind: "function",
        signature: headOf(file, statement),
        doc
      })
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      symbols.push({
        name: statement.name.text,
        kind: "class",
        signature: headOf(file, statement),
        doc
      })
    } else if (ts.isInterfaceDeclaration(statement)) {
      symbols.push({
        name: statement.name.text,
        kind: "interface",
        signature: headOf(file, statement),
        doc
      })
    } else if (ts.isTypeAliasDeclaration(statement)) {
      symbols.push({
        name: statement.name.text,
        kind: "type",
        signature: headOf(file, statement),
        doc
      })
    }
  }
  return symbols
}
