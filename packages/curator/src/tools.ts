import type { OverlayOp } from "@memhtml/contracts"
import type { Violation } from "@memhtml/session"
import { z } from "zod"

/**
 * The five tools a curator run is bound to, as an interface the binder implements.
 *
 * `@memhtml/curator` owns the loop and the tools the MODEL sees (`loop.ts`); it does not own a head,
 * a session, or a sandbox, because the sandbox helper lives in `apps/cli` and a package cannot import
 * an app. So the loop takes this interface, `apps/cli/src/curate-run.ts` binds it to the real head,
 * session, and `runSessionExec`, and the package's tests bind it to fakes. Every method is a plain
 * promise: the AI SDK's `execute` is async, and a fake in a test is a closure.
 */

export interface CuratorSearchHit {
  readonly path: string
  readonly score: number
  readonly claim: string
}

/** What `read` returns: the record's fields plus its bytes. `null` for a path the view lacks. */
export interface CuratorRecordView {
  readonly path: string
  readonly title: string
  readonly claim: string
  readonly memoryType: string
  readonly status: string
  readonly frameKey: string | null
  readonly confidence: number | null
  readonly importance: number | null
  readonly tags: ReadonlyArray<string>
  readonly entities: ReadonlyArray<string>
  readonly links: ReadonlyArray<{ readonly rel: string; readonly href: string }>
  readonly archived: boolean
  readonly html: string
}

/** One harvested op, summarized without its bytes. */
export interface OpSummary {
  readonly kind: OverlayOp["kind"]
  readonly path: string
  readonly to?: string
}

/**
 * What `exec` returns: `SessionExecReport`-shaped, plus what the binder did with the harvest. The
 * binder appends the harvested ops to the session only when the script exited 0 and no harvested op
 * carries any violation (`duplicate` and `claim-edit` included, the refusal `propose` applies), so an
 * op the commit would refuse never reaches the log; `appended` says how many landed.
 */
export interface CuratorExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
  readonly ops: ReadonlyArray<OpSummary>
  readonly appended: number
  readonly rejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>
  readonly violations: ReadonlyArray<Violation>
}

export interface CuratorProposeResult {
  readonly appended: number
  readonly violations: ReadonlyArray<Violation>
}

/** The session half of `status`; the loop adds steps and tokens. */
export interface CuratorSessionStatus {
  readonly baseSha: string
  readonly ref: string
  readonly ops: {
    readonly put: number
    readonly archive: number
    readonly link: number
    readonly unlink: number
    readonly label: number
    readonly unlabel: number
    readonly move: number
  }
}

export interface CuratorTools {
  search(query: string, limit: number): Promise<ReadonlyArray<CuratorSearchHit>>
  read(path: string): Promise<CuratorRecordView | null>
  exec(script: string): Promise<CuratorExecResult>
  propose(ops: ReadonlyArray<OverlayOp>): Promise<CuratorProposeResult>
  status(): Promise<CuratorSessionStatus>
}

/**
 * The op shape the MODEL proposes. An `archive` names only its source: the loop reads the source's
 * bytes through `read` and derives `to` as `archive/<YYYY>/<path>`, because the contract's
 * `OverlayOp.archive` carries the article's bytes to name which article is meant, and a model
 * restating a whole file is how a byte drifts. A `move` names its source and its destination and
 * the loop reads the bytes the same way; the binder adds the `unlink` and `link` pairs that repoint
 * the edges to the old path (`withRepoints`). `put`, `link`, `unlink`, `label`, and `unlabel` are
 * the contract's own shape.
 */
export const ProposedOp = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("put"),
    path: z.string().min(1).describe("Repo-relative path, e.g. areas/inbox/x.html."),
    html: z.string().min(1).describe("The whole memory file.")
  }),
  z.object({
    kind: z.literal("archive"),
    path: z.string().min(1).describe("The active record to archive."),
    to: z
      .string()
      .min(1)
      .optional()
      .describe("archive/<YYYY>/<path>; defaults to this year's archive of the same path.")
  }),
  z.object({
    kind: z.literal("link"),
    path: z.string().min(1).describe("The active record that gets the edge."),
    rel: z
      .string()
      .min(1)
      .describe("A rel from the closed vocabulary, e.g. supersedes, contradicts, part_of."),
    href: z.string().min(1).describe("Root-relative target, e.g. /archive/2026/areas/inbox/x.html.")
  }),
  z.object({
    kind: z.literal("unlink"),
    path: z.string().min(1).describe("The active record that loses the edge."),
    rel: z.string().min(1).describe("The rel of the edge to drop, as the record's links list it."),
    href: z
      .string()
      .min(1)
      .describe("The href of the edge to drop, exactly as the record's links list it.")
  }),
  z.object({
    kind: z.literal("label"),
    path: z.string().min(1).describe("The active record that gets the memhtml-entity."),
    entity: z
      .string()
      .min(1)
      .describe(
        "A lowercase type:name value the record does not carry yet, e.g. system:memhtml, project:hex-bonk, person:laith."
      )
  }),
  z.object({
    kind: z.literal("unlabel"),
    path: z.string().min(1).describe("The active record that loses the memhtml-entity."),
    entity: z
      .string()
      .min(1)
      .describe("The value to drop, exactly as the record's entities list it.")
  }),
  z.object({
    kind: z.literal("move"),
    path: z.string().min(1).describe("The active record to relocate, e.g. areas/inbox/x.html."),
    to: z
      .string()
      .min(1)
      .describe(
        "Its new live path, e.g. resources/hex-bonk/x.html (the briefing's inbox entry names one). Edges to the old path are repointed for you."
      )
  })
])
export type ProposedOp = z.infer<typeof ProposedOp>

/** `archive/<YYYY>/<path>` for `path`, the year taken from `now` in UTC. */
export const archivePathFor = (path: string, now: Date): string =>
  `archive/${String(now.getUTCFullYear())}/${path}`

/**
 * Proposed ops as overlay ops. An archive whose source `read` cannot find is reported rather than
 * silently dropped, so the model learns the path was wrong.
 */
export const toOverlayOps = async (
  proposed: ReadonlyArray<ProposedOp>,
  tools: Pick<CuratorTools, "read">,
  now: Date
): Promise<{ ops: ReadonlyArray<OverlayOp>; missing: ReadonlyArray<string> }> => {
  const ops: Array<OverlayOp> = []
  const missing: Array<string> = []
  for (const op of proposed) {
    if (op.kind === "archive" || op.kind === "move") {
      const record = await tools.read(op.path)
      if (record === null) {
        missing.push(op.path)
        continue
      }
      ops.push(
        op.kind === "archive"
          ? {
              kind: "archive",
              path: op.path,
              to: op.to ?? archivePathFor(op.path, now),
              html: record.html
            }
          : { kind: "move", path: op.path, to: op.to, html: record.html }
      )
      continue
    }
    ops.push(op)
  }
  return { ops, missing }
}
