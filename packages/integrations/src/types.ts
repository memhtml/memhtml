/**
 * The closed vocabularies and shared shapes of the integrations family.
 *
 * Every other module in this package, and `apps/cli`'s `integrations` and `hook` commands, imports from
 * here rather than restating a list, so a host added in `HOSTS` is a host the parser, the manifest, the
 * doctor, and the smoke census all learn about at once.
 */

/** The four coding agents this package can wire, in the order the docs present them. */
export const HOSTS = ["claude", "codex", "cursor", "opencode"] as const
export type HostId = (typeof HOSTS)[number]

export const isHostId = (value: string): value is HostId =>
  (HOSTS as ReadonlyArray<string>).includes(value)

/** `user` anchors at `$HOME`; `project` anchors at a git repository's top level. */
export const SCOPES = ["user", "project"] as const
export type Scope = (typeof SCOPES)[number]

/**
 * The lifecycle events `memhtml hook` understands, host-neutral. Each host's installer maps these onto
 * the host's own event names (`SessionStart`, `sessionStart`, `session.created`, …) and the hook
 * engine maps the host's stdin payload back.
 */
export const HOOK_EVENTS = [
  "session-start",
  "user-prompt-submit",
  "pre-compact",
  "session-end"
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export const isHookEvent = (value: string): value is HookEvent =>
  (HOOK_EVENTS as ReadonlyArray<string>).includes(value)

/** Which hooks `integrations install` writes. */
export const HOOK_MODES = ["all", "session", "none"] as const
export type HookMode = (typeof HOOK_MODES)[number]

/**
 * How the installed configs invoke this binary. `absolute` records `process.execPath` plus the
 * resolved entry script, so a GUI host with no shell PATH still finds it; `bare` writes `memhtml` and
 * `memhtml-mcp` and leaves PATH to the operator.
 */
export interface BinaryLocation {
  /** The node executable, absolute. */
  readonly node: string
  /** The `memhtml` entry script, absolute and realpath-resolved. */
  readonly cli: string
  /** The `memhtml-mcp` entry script, absolute and realpath-resolved. */
  readonly mcp: string
  /** The version the binary reports, recorded so doctor can tell an upgrade from a move. */
  readonly version: string
}

/** One command line the host will run: the MCP server, or a hook. */
export interface CommandLine {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export interface InstallOptions {
  readonly host: HostId
  readonly scope: Scope
  /** `$HOME` for user scope, the git top level for project scope. Absolute. */
  readonly root: string
  /** The store the integration points at. Absolute. */
  readonly memhtmlRoot: string
  /** Where this host writes transcripts, when known; absent means no indexing hooks. */
  readonly traceRoot?: string
  readonly hooks: HookMode
  readonly bareCommand: boolean
  readonly binary: BinaryLocation
  readonly force: boolean
  readonly dryRun: boolean
}

/**
 * One thing install writes. `kind` says how ownership is checked: a `file` is wholly ours and its
 * SHA-256 is the receipt's claim; a `fragment` lives inside a file other tools also own (a JSON key, a
 * TOML fence, a Markdown block, a hooks array entry) and only the fragment's rendered bytes are claimed.
 */
export interface ManagedWrite {
  readonly kind: "file" | "fragment"
  /** Absolute path of the file touched. */
  readonly path: string
  /** What the fragment is, for reports: `mcp-entry`, `hooks`, `instruction-block`, `skill`, `plugin`, `rules`. */
  readonly role: ManagedRole
  /** The bytes install owns: the whole file, or the fragment as rendered. */
  readonly content: string
}

export const MANAGED_ROLES = [
  "mcp-entry",
  "hooks",
  "instruction-block",
  "skill",
  "plugin",
  "rules"
] as const
export type ManagedRole = (typeof MANAGED_ROLES)[number]

/**
 * The receipt: ownership proof and the record of what to remove. One per host per scope, at
 * `receiptPath(...)`. `files` maps the absolute path plus role to the SHA-256 of the owned bytes.
 */
export interface Receipt {
  readonly package: "memhtml"
  readonly version: string
  readonly host: HostId
  readonly scope: Scope
  readonly root: string
  readonly memhtmlRoot: string
  readonly binary: BinaryLocation
  readonly bareCommand: boolean
  readonly hooks: HookMode
  readonly installedAt: string
  readonly entries: ReadonlyArray<ReceiptEntry>
}

export interface ReceiptEntry {
  readonly path: string
  readonly role: ManagedRole
  readonly kind: "file" | "fragment"
  readonly sha256: string
}

export const INSTALL_STATES = ["not-installed", "installed", "modified"] as const
export type InstallState = (typeof INSTALL_STATES)[number]

/** One row of `integrations doctor`. */
export interface DoctorCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
  readonly suggestions: ReadonlyArray<string>
}
