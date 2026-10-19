import { Result, Schema } from "effect"

import { MemoryType } from "./types.js"

/**
 * The store's policy file: what every process that writes to one store must agree on, kept at the
 * store root and tracked in git beside the corpus, so a clone carries its rules with it.
 *
 * The library's defaults are neutral: the write bar refuses no type and requires no anchor, the v1
 * record doors close only inside a run session, and the curator treats no directory as a writer's
 * bucket. A deployment that wants a stricter bar writes the file; nothing in the code names one
 * deployment's choices.
 *
 * Decoding is strict and fails closed. An unknown key (`requireAnchors` for `requireAnchor`), a
 * value of the wrong type, an unknown memory type, or a type listed twice is refused with a reason
 * naming where the file broke, never read as "unset": a typo in a policy file must not loosen the
 * policy it was meant to state. This module is pure; the read lives in the CLI (`store-config.ts`).
 */

/** The file's name, at the store root. Not a memory: it does not end in `.html`. */
export const STORE_CONFIG_FILE = "memhtml.config.json"

/**
 * How the v1 doors that create a record (`memhtml write`, `apply`, `correct`, `task add`, and the
 * MCP `memory_write`, `memory_write_batch`, `memory_correct` tools) behave. They commit straight
 * to the store with no write bar, where a session is judged by it.
 *
 * - `open`: always open.
 * - `closed-in-session`: closed in a process whose environment carries `MEMHTML_SESSION`, the
 *   session an agent runtime hands every subprocess of a run, and open elsewhere. The library
 *   default, because it is the session contract: a process that has a barred door uses it.
 * - `closed`: closed in every process; records go in through sessions only.
 *
 * Reads and the edits of existing records (`link`, `archive`, `task status`, `reinforce`) are not
 * record-creating doors and no mode closes them.
 */
export const V1_DOOR_MODES = ["open", "closed-in-session", "closed"] as const
export type V1DoorMode = (typeof V1_DOOR_MODES)[number]

/**
 * The most records one curator run may file, restating `BATCH_CAP` in `@memhtml/session` (which
 * this package cannot import): a run's moves and their repoints land in one commit of at most that
 * many ops, so a larger quota could never be met.
 */
export const PLACEMENT_QUOTA_MAX = 200

/** The quota when the file sets none: 60 placements plus their repoints fit one proposal. */
export const DEFAULT_PLACEMENT_QUOTA = 60

/**
 * One refused type: its name alone, refused with {@link refusedTypeReason}, or the name with the
 * reason the refusal gives, worded for the writer who has to change the record.
 */
const RefusedType = Schema.Union([
  MemoryType,
  Schema.Struct({ type: MemoryType, reason: Schema.String.check(Schema.isNonEmpty()) })
])

/**
 * A writer-bucket pattern: a glob over ONE directory name (`*-import`, `working-thread*`), matched
 * with `node:path` `matchesGlob`, so `*` matches any run of characters, `?` one, and `[0-9]` a
 * class. A `/` would name a path rather than a directory, and is refused.
 */
const BucketPattern = Schema.String.check(Schema.isNonEmpty(), Schema.isPattern(/^[^/]+$/))

/** The file's shape. Every key is optional; an absent key is the library default. */
export const StoreConfig = Schema.Struct({
  writeBar: Schema.optionalKey(
    Schema.Struct({
      /** Types no session may write, the curator's included. Default: none. */
      refusedTypes: Schema.optionalKey(Schema.Array(RefusedType)),
      /**
       * Every new record must name what it is about: a `memhtml-entity`, or a path under
       * `projects/<slug>/`. Also holds a `move` destination and an `unlabel` that drops a record's
       * last entity. Default: off.
       */
      requireAnchor: Schema.optionalKey(Schema.Boolean)
    })
  ),
  v1Doors: Schema.optionalKey(Schema.Literals(V1_DOOR_MODES)),
  curator: Schema.optionalKey(
    Schema.Struct({
      /**
       * Directory names that say who wrote a record rather than what it is about, so placement
       * never files a record there and the collapse planner never keeps a canonical there.
       * Default: none.
       */
      writerBuckets: Schema.optionalKey(Schema.Array(BucketPattern)),
      /** Inbox records one `curate run` should file. Default {@link DEFAULT_PLACEMENT_QUOTA}. */
      placementQuota: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: PLACEMENT_QUOTA_MAX }))
      )
    })
  )
})
export type StoreConfig = typeof StoreConfig.Type

/** The write bar's policy half: what `validateOps` refuses beyond format and integrity. */
export interface WriteBarPolicy {
  /** Each refused type with the reason its refusal gives. */
  readonly refusedTypes: ReadonlyMap<string, string>
  readonly requireAnchor: boolean
}

export interface CuratorPolicy {
  readonly writerBuckets: ReadonlyArray<string>
  readonly placementQuota: number
}

/** The whole effective policy, every key resolved. */
export interface StorePolicy {
  readonly writeBar: WriteBarPolicy
  readonly v1Doors: V1DoorMode
  readonly curator: CuratorPolicy
}

/** The library's own write bar: no refused type, no anchor rule. */
export const DEFAULT_WRITE_BAR: WriteBarPolicy = {
  refusedTypes: new Map(),
  requireAnchor: false
}

export const DEFAULT_V1_DOORS: V1DoorMode = "closed-in-session"

export const DEFAULT_CURATOR_POLICY: CuratorPolicy = {
  writerBuckets: [],
  placementQuota: DEFAULT_PLACEMENT_QUOTA
}

export const DEFAULT_STORE_POLICY: StorePolicy = {
  writeBar: DEFAULT_WRITE_BAR,
  v1Doors: DEFAULT_V1_DOORS,
  curator: DEFAULT_CURATOR_POLICY
}

/** Every key the file can set, as a dotted path, in the order `memhtml config` reports them. */
export const STORE_POLICY_KEYS = [
  "writeBar.refusedTypes",
  "writeBar.requireAnchor",
  "v1Doors",
  "curator.writerBuckets",
  "curator.placementQuota"
] as const
export type StorePolicyKey = (typeof STORE_POLICY_KEYS)[number]

/** Where one key's effective value came from. */
export type StorePolicySource = "file" | "default"

export type StorePolicySources = Readonly<Record<StorePolicyKey, StorePolicySource>>

/** The reason a type listed by name alone gives when the bar refuses it. */
export const refusedTypeReason = (type: string): string =>
  `\`${type}\` is a type this store's write bar refuses (writeBar.refusedTypes in ${STORE_CONFIG_FILE})`

/** The policy a decoded file states, every absent key at its library default, and each key's source. */
export const storePolicyOf = (
  config: StoreConfig
): { readonly policy: StorePolicy; readonly sources: StorePolicySources } => {
  const refusedTypes = new Map<string, string>()
  for (const entry of config.writeBar?.refusedTypes ?? []) {
    if (typeof entry === "string") refusedTypes.set(entry, refusedTypeReason(entry))
    else refusedTypes.set(entry.type, entry.reason)
  }
  const source = (present: boolean): StorePolicySource => (present ? "file" : "default")
  return {
    policy: {
      writeBar: {
        refusedTypes,
        requireAnchor: config.writeBar?.requireAnchor ?? DEFAULT_WRITE_BAR.requireAnchor
      },
      v1Doors: config.v1Doors ?? DEFAULT_V1_DOORS,
      curator: {
        writerBuckets: config.curator?.writerBuckets ?? DEFAULT_CURATOR_POLICY.writerBuckets,
        placementQuota: config.curator?.placementQuota ?? DEFAULT_CURATOR_POLICY.placementQuota
      }
    },
    sources: {
      "writeBar.refusedTypes": source(config.writeBar?.refusedTypes !== undefined),
      "writeBar.requireAnchor": source(config.writeBar?.requireAnchor !== undefined),
      v1Doors: source(config.v1Doors !== undefined),
      "curator.writerBuckets": source(config.curator?.writerBuckets !== undefined),
      "curator.placementQuota": source(config.curator?.placementQuota !== undefined)
    }
  }
}

const decodeConfig = Schema.decodeUnknownResult(StoreConfig, { onExcessProperty: "error" })

/** The type named by one `refusedTypes` entry, in either spelling. */
const typeOf = (
  entry: NonNullable<NonNullable<StoreConfig["writeBar"]>["refusedTypes"]>[number]
) => (typeof entry === "string" ? entry : entry.type)

/**
 * Decode the file's text: `{ ok: true, config }`, or `{ ok: false, reason }` naming what is wrong
 * and where. JSON that does not parse, a top level that is not an object, an excess key at any
 * depth, a value outside its key's type, and a type refused twice are each a reason, never a
 * default.
 */
export const decodeStoreConfig = (
  text: string
):
  | { readonly ok: true; readonly config: StoreConfig }
  | { readonly ok: false; readonly reason: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})`
    }
  }
  const decoded = decodeConfig(parsed)
  if (Result.isFailure(decoded)) {
    return { ok: false, reason: decoded.failure.message.replaceAll("\n", " ") }
  }
  const seen = new Set<string>()
  for (const entry of decoded.success.writeBar?.refusedTypes ?? []) {
    const type = typeOf(entry)
    if (seen.has(type)) {
      return {
        ok: false,
        reason: `writeBar.refusedTypes lists \`${type}\` twice; name each type once`
      }
    }
    seen.add(type)
  }
  return { ok: true, config: decoded.success }
}
