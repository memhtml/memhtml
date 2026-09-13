/**
 * The JSON and JSONC configs: `~/.claude.json`, `~/.claude/settings.json`, `.mcp.json`, Cursor's
 * `mcp.json` and `hooks.json`, OpenCode's `opencode.json`.
 *
 * Every edit here is one `{offset, length, content}` splice, computed from `parseTree`'s offsets and
 * applied with `applyEdits`, and that is the invariant the whole adapter exists for: **the only bytes an
 * upsert or a remove changes are the ones it inserts, replaces, or deletes.** Uninstall has to hand a file
 * another tool owns back byte for byte, and the receipt's ownership hash is only worth something if that
 * holds.
 *
 * `JSON.parse` + `JSON.stringify` would be shorter and would silently delete every comment in an OpenCode
 * config and reindent a file the operator formats their own way. `jsonc-parser`'s own `modify` is closer and
 * still too wide: `withFormatting` grows each edit to whole lines and re-prints them with `keepLines: false`,
 * so inserting `mcpServers.memhtml` beside an INLINE `"review": { "command": … }` re-flows the neighbour over
 * three lines — a change to bytes nobody asked us to touch, and one an uninstall cannot undo. So the offsets
 * are read from the tree and the splice is written here.
 *
 * New content is shaped to the document it lands in: a container that already runs over several lines gets
 * `,\n<indent>"key": <value>` after its last member, at the indent that member sits at, with the value
 * pretty-printed two-space stepped from there; a container on one line gets `, "key": <value>` inline. An
 * empty `{}` opens up over lines, which is also how a file created from nothing is written.
 *
 * A `null` or blank input is treated as `{}`, so "create the file" and "edit the file" are one code path,
 * and output always ends with a newline.
 */

import {
  applyEdits,
  type Edit,
  findNodeAtLocation,
  getNodeValue,
  type JSONPath,
  type Node,
  type ParseError,
  type ParseOptions,
  parseTree
} from "jsonc-parser"

/** One step of new indentation, matching biome's own JSON formatting. */
const INDENT = "  "

/** Trailing commas are tolerated on read: every host that ships a JSONC config accepts them. */
const PARSE: ParseOptions = { allowTrailingComma: true }

const normalize = (text: string | null): string =>
  text === null || text.trim().length === 0 ? "{}" : text

const withTrailingNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`)

const path = (segments: ReadonlyArray<string | number>): JSONPath => [...segments]

/**
 * The parsed tree, or `undefined` when the text does not parse even with comments allowed.
 *
 * `parseTree` is fault tolerant and returns a partial tree for broken input, so the error list is what
 * decides: a half-parsed config must read as unparseable rather than as one missing a key, or install
 * would "repair" it by writing a valid file over the operator's typo and losing the rest.
 */
const treeOf = (text: string): Node | undefined => {
  const errors: Array<ParseError> = []
  const root = parseTree(text, errors, PARSE)
  return errors.length === 0 ? root : undefined
}

const nodeAt = (text: string, segments: ReadonlyArray<string | number>): Node | undefined => {
  const root = treeOf(text)
  return root === undefined ? undefined : findNodeAtLocation(root, path(segments))
}

/**
 * The value at `segments`, or `undefined` when the path is absent or the document does not parse. A JSON
 * `null` comes back as `null`, so absent and present-but-null stay distinguishable.
 */
export const readJsonPath = (
  text: string | null,
  segments: ReadonlyArray<string | number>
): unknown => {
  const node = nodeAt(normalize(text), segments)
  if (node === undefined) return undefined
  const value: unknown = getNodeValue(node)
  return value
}

/** Does this container's own text run over more than one line? */
const spansLines = (text: string, container: Node): boolean =>
  text.slice(container.offset, container.offset + container.length).includes("\n")

/**
 * The whitespace between the newline before `offset` and `offset` itself, or `undefined` when something
 * other than whitespace shares that line — a member written after a comma rather than on its own line has
 * no indent to copy.
 */
const runBefore = (text: string, offset: number): string | undefined => {
  const start = text.lastIndexOf("\n", offset - 1) + 1
  const run = text.slice(start, offset)
  return /^[\t ]*$/.test(run) ? run : undefined
}

/** The indentation of the line the container itself starts on. */
const ownIndent = (text: string, container: Node): string => {
  const start = text.lastIndexOf("\n", container.offset - 1) + 1
  return /^[\t ]*/.exec(text.slice(start))?.[0] ?? ""
}

/**
 * Where a member of this container belongs: read off the member already there, and two spaces in from the
 * container's own line when there is none to read.
 */
const indentFor = (text: string, container: Node, member: Node | undefined): string =>
  (member === undefined ? undefined : runBefore(text, member.offset)) ??
  `${ownIndent(text, container)}${INDENT}`

/**
 * One value as text: two-space stepped and re-anchored at `indent`, or on one line.
 *
 * `JSON.stringify(value, null, 2)` indents from column zero, so every line after the first gets `indent`
 * in front of it and the block lands under the key that names it.
 */
const rendered = (value: unknown, indent: string, pretty: boolean): string =>
  pretty ? JSON.stringify(value, null, 2).split("\n").join(`\n${indent}`) : JSON.stringify(value)

/** One new member of a container, which only the container knows the indent and the shape for. */
type Member = (indent: string, pretty: boolean) => string

/** `"key": value` in an object, and the bare value in an array. */
const memberText = (segment: string | number, value: unknown): Member =>
  typeof segment === "number"
    ? (indent, pretty) => rendered(value, indent, pretty)
    : (indent, pretty) => `${JSON.stringify(segment)}: ${rendered(value, indent, pretty)}`

const nullMember: Member = () => "null"

/** The property node for a key, or the element node for an index. */
const memberOf = (container: Node, segment: string | number): Node | undefined => {
  const children = container.children ?? []
  if (typeof segment === "number") return container.type === "array" ? children[segment] : undefined
  if (container.type !== "object") return undefined
  return children.find((child) => child.children?.[0]?.value === segment)
}

/** A property's value, or the element itself. */
const heldValue = (member: Node): Node | undefined =>
  member.type === "property" ? member.children?.[1] : member

/** `value` wrapped in the containers `segments` names, which is how a missing parent chain is created. */
const wrapped = (segments: ReadonlyArray<string | number>, value: unknown): unknown => {
  let result = value
  for (let at = segments.length - 1; at >= 0; at -= 1) {
    const segment = segments[at]
    if (typeof segment === "number") {
      result = [...Array.from({ length: segment }, () => null), result]
    } else if (segment !== undefined) {
      result = { [segment]: result }
    }
  }
  return result
}

/**
 * The one edit that adds members to a container, and the only place new bytes are shaped.
 *
 * A container with members already in it is appended to after the last of them, so nothing before that
 * offset can move. An empty one opens up over lines — except an empty container that carries a comment,
 * where the new members go in front of the comment rather than over it.
 */
const addMembers = (text: string, container: Node, members: ReadonlyArray<Member>): Edit => {
  const children = container.children ?? []
  const last = children[children.length - 1]
  const indent = indentFor(text, container, last)
  if (last !== undefined) {
    const pretty = spansLines(text, container)
    const content = members
      .map((member) =>
        pretty ? `,\n${indent}${member(indent, true)}` : `, ${member(indent, false)}`
      )
      .join("")
    return { offset: last.offset + last.length, length: 0, content }
  }
  const body = members.map((member) => `${indent}${member(indent, true)}`).join(",\n")
  const inside = text.slice(container.offset + 1, container.offset + container.length - 1)
  if (inside.trim().length > 0) {
    return { offset: container.offset + 1, length: 0, content: `\n${body}` }
  }
  const open = container.type === "array" ? "[" : "{"
  const close = container.type === "array" ? "]" : "}"
  return {
    offset: container.offset,
    length: container.length,
    content: `${open}\n${body}\n${ownIndent(text, container)}${close}`
  }
}

/** Overwrite one node's span, pretty or inline by the rule its container sets. */
const replaceEdit = (text: string, node: Node, value: unknown): Edit => {
  const member = node.parent?.type === "property" ? node.parent : node
  const container = member.parent
  const pretty = container === undefined || spansLines(text, container)
  const indent =
    container === undefined ? ownIndent(text, node) : indentFor(text, container, member)
  return { offset: node.offset, length: node.length, content: rendered(value, indent, pretty) }
}

/**
 * The edit that sets `segments` under `container`, walking as deep as the document already goes.
 *
 * A key that is there has its VALUE replaced and nothing else. A key that is not is appended. A scalar
 * where an object was expected is replaced by the chain of objects the rest of the path needs, since a
 * `"hooks": 3` cannot be descended into.
 */
const upsertEdit = (
  text: string,
  container: Node,
  segments: ReadonlyArray<string | number>,
  value: unknown
): Edit => {
  const segment = segments[0]
  if (segment === undefined) return replaceEdit(text, container, value)
  const fits =
    typeof segment === "number" ? container.type === "array" : container.type === "object"
  if (!fits) return replaceEdit(text, container, wrapped(segments, value))
  const rest = segments.slice(1)
  const member = memberOf(container, segment)
  if (member === undefined) {
    const gap =
      typeof segment === "number" ? Math.max(0, segment - (container.children?.length ?? 0)) : 0
    return addMembers(text, container, [
      ...Array.from({ length: gap }, () => nullMember),
      memberText(segment, wrapped(rest, value))
    ])
  }
  const inner = heldValue(member)
  if (inner === undefined) return replaceEdit(text, container, wrapped(segments, value))
  if (rest.length === 0) return replaceEdit(text, inner, value)
  return inner.type === "object" || inner.type === "array"
    ? upsertEdit(text, inner, rest, value)
    : replaceEdit(text, inner, wrapped(rest, value))
}

/**
 * The edit that takes one member out, and the exact inverse of {@link addMembers}.
 *
 * With a member before it, the span runs from the end of that one to the end of ours, which is what takes
 * the separating comma and the newline with it. First of several, the span runs to the start of the next.
 * The only member, and the container closes back up to `{}` or `[]` — and an object that is itself a
 * property's value goes too, because `{"mcpServers": {}}` is a container install created and leaving it
 * behind has not restored the file. The cascade stops at the root object, which is never removed.
 */
const removeEdit = (text: string, node: Node): Edit | undefined => {
  const member = node.parent?.type === "property" ? node.parent : node
  const container = member.parent
  if (container === undefined) return undefined
  const siblings = container.children ?? []
  const at = siblings.indexOf(member)
  if (at < 0) return undefined
  const end = member.offset + member.length
  const previous = at > 0 ? siblings[at - 1] : undefined
  if (previous !== undefined) {
    const from = previous.offset + previous.length
    return { offset: from, length: end - from, content: "" }
  }
  const next = siblings[at + 1]
  if (next !== undefined) {
    return { offset: member.offset, length: next.offset - member.offset, content: "" }
  }
  if (container.type === "object" && container.parent?.type === "property") {
    return removeEdit(text, container)
  }
  const inside = container.offset + 1
  const kept = `${text.slice(inside, member.offset)}${text.slice(end, container.offset + container.length - 1)}`
  return kept.trim().length === 0
    ? {
        offset: container.offset,
        length: container.length,
        content: container.type === "array" ? "[]" : "{}"
      }
    : { offset: inside, length: end - inside, content: "" }
}

/**
 * Set `segments` to `value`, creating every missing intermediate object on the way. Comments, key order,
 * and the existing indentation of untouched lines all survive, and a document that does not parse is left
 * exactly as it is rather than rewritten into one that does.
 */
export const upsertJsonPath = (
  text: string | null,
  segments: ReadonlyArray<string | number>,
  value: unknown
): string => {
  const base = normalize(text)
  const root = treeOf(base)
  if (root === undefined) return withTrailingNewline(base)
  return withTrailingNewline(applyEdits(base, [upsertEdit(base, root, segments, value)]))
}

/** Remove `segments`. A path that is already absent is a no-op, not an error. */
export const removeJsonPath = (
  text: string | null,
  segments: ReadonlyArray<string | number>
): string => {
  const base = normalize(text)
  const node = nodeAt(base, segments)
  if (node === undefined) return withTrailingNewline(base)
  const edit = removeEdit(base, node)
  return withTrailingNewline(edit === undefined ? base : applyEdits(base, [edit]))
}

const arrayAt = (text: string, segments: ReadonlyArray<string | number>): Node | undefined => {
  const node = nodeAt(text, segments)
  return node === undefined || node.type !== "array" ? undefined : node
}

const elements = (node: Node): ReadonlyArray<unknown> =>
  (node.children ?? []).map((child) => getNodeValue(child) as unknown)

/**
 * Drop every element `owned` matches, one at a time, re-reading the tree between each so the offsets stay
 * true. Each element goes as its own splice, so the ones the operator wrote keep their exact bytes —
 * rewriting the whole array would re-print an inline entry beside ours.
 */
const withoutOwned = (
  text: string,
  segments: ReadonlyArray<string | number>,
  owned: (entry: unknown) => boolean
): string => {
  let current = text
  for (;;) {
    const node = arrayAt(current, segments)
    if (node === undefined) return current
    const children = node.children ?? []
    const mine = children.find((child) => owned(getNodeValue(child) as unknown))
    if (mine === undefined) return current
    const edit = removeEdit(current, mine)
    if (edit === undefined) return current
    current = applyEdits(current, [edit])
  }
}

/**
 * Rewrite the array at `segments` as "everything the operator put there, then everything we put there".
 *
 * This is how a hooks array is edited: `owned` recognizes our own entries by their `command` string, they
 * are dropped, and `entries` is appended. Re-running install is therefore idempotent — the second run
 * removes exactly what the first added and appends the same thing — and a hook the operator wrote by hand
 * keeps its position among the survivors AND its own bytes, down to whether it was written on one line.
 *
 * An existing value that is not an array is treated as absent and replaced, since a `hooks.SessionStart`
 * that is an object is not something we can merge into.
 */
export const upsertArrayEntries = (
  text: string | null,
  segments: ReadonlyArray<string | number>,
  entries: ReadonlyArray<unknown>,
  owned: (entry: unknown) => boolean
): string => {
  const base = normalize(text)
  if (treeOf(base) === undefined) return withTrailingNewline(base)
  if (arrayAt(base, segments) === undefined) return upsertJsonPath(base, segments, [...entries])
  const stripped = withoutOwned(base, segments, owned)
  if (entries.length === 0) return withTrailingNewline(stripped)
  const node = arrayAt(stripped, segments)
  if (node === undefined) return upsertJsonPath(stripped, segments, [...entries])
  const members = entries.map(
    (entry): Member =>
      (indent, pretty) =>
        rendered(entry, indent, pretty)
  )
  return withTrailingNewline(applyEdits(stripped, [addMembers(stripped, node, members)]))
}

/**
 * Drop every entry `owned` matches from the array at `segments`, and drop the key itself once nothing is
 * left — an uninstall that leaves `"SessionStart": []` behind has not restored the file.
 */
export const removeArrayEntries = (
  text: string | null,
  segments: ReadonlyArray<string | number>,
  owned: (entry: unknown) => boolean
): string => {
  const base = normalize(text)
  const node = arrayAt(base, segments)
  if (node === undefined) return withTrailingNewline(base)
  const kept = elements(node).filter((entry) => !owned(entry))
  if (kept.length === 0) return removeJsonPath(base, segments)
  return withTrailingNewline(withoutOwned(base, segments, owned))
}

/** The whole document as a value, or `undefined` when it does not parse. Comments are allowed. */
export const parseJsonc = (text: string): unknown => {
  const root = treeOf(text)
  if (root === undefined) return undefined
  const value: unknown = getNodeValue(root)
  return value
}
