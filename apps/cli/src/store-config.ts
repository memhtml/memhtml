import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  DEFAULT_STORE_POLICY,
  decodeStoreConfig,
  STORE_CONFIG_FILE,
  STORE_POLICY_KEYS,
  type StorePolicy,
  type StorePolicyKey,
  type StorePolicySource,
  type StorePolicySources,
  storePolicyOf,
  type V1DoorMode
} from "@memhtml/contracts"
import { StoreConfigInvalid, V1DoorClosed } from "@memhtml/contracts/errors"
import { makeGit } from "@memhtml/store"
import { Effect } from "effect"

import { Roots } from "./api-layer.js"
import { sessionFromEnv } from "./config.js"

/**
 * The store's policy file, read: `memhtml.config.json` at the store root (`@memhtml/contracts`
 * `StoreConfig` for its shape and defaults).
 *
 * ## When it is read
 *
 * From the store root's working tree, at the moment a policy decision is made, and never cached
 * across decisions: the CLI reads it once per command that judges or creates a record (`session
 * put`, `session exec`, `session commit`, the curate commands, and the v1 record doors), the head
 * server once per `/v1/neighbors` and `/v1/exec` request, and the MCP server once per
 * record-creating tool call. An edit therefore takes effect on the next call in every process on
 * the checkout, with no restart, and every process on one checkout reads one file. Commit the file
 * so every clone of the store agrees; `memhtml config` reports whether the working-tree copy is
 * committed.
 *
 * ## Failing closed
 *
 * An absent file is the library's defaults. A file that does not decode, or one that exists and
 * cannot be read (a directory by that name, no permission), is {@link StoreConfigInvalid}: every
 * command that needs the policy refuses with `ERR_STORE_CONFIG` rather than running under defaults
 * the operator did not choose. Commands that need no policy (reads, search, status) never read it.
 */

/** Where a store's policy file lives. */
export const storeConfigPath = (root: string): string => join(root, STORE_CONFIG_FILE)

/** The policy a store states, every key resolved, with where each value came from. */
export interface LoadedStorePolicy {
  /** The file's absolute path, whether or not it exists. */
  readonly path: string
  /** True when the file exists; `false` means every key is the library default. */
  readonly present: boolean
  readonly policy: StorePolicy
  readonly sources: StorePolicySources
}

const ALL_DEFAULT: StorePolicySources = Object.fromEntries(
  STORE_POLICY_KEYS.map((key) => [key, "default"])
) as Record<StorePolicyKey, StorePolicySource>

/** Read and decode the store's policy file ({@link LoadedStorePolicy}), failing closed. */
export const loadStorePolicy = (
  root: string
): Effect.Effect<LoadedStorePolicy, StoreConfigInvalid> =>
  Effect.gen(function* () {
    const path = storeConfigPath(root)
    // Opened directly rather than stat-ed first: absence is the one error that means "defaults".
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause
    }).pipe(
      Effect.catch((cause) => {
        const code = (cause as { code?: unknown } | null)?.code
        return code === "ENOENT" || code === "ENOTDIR"
          ? Effect.succeed(null)
          : Effect.fail(
              StoreConfigInvalid.make({
                path,
                reason: `cannot read it (${typeof code === "string" ? code : String(cause)})`
              })
            )
      })
    )
    if (text === null) {
      return { path, present: false, policy: DEFAULT_STORE_POLICY, sources: ALL_DEFAULT }
    }
    const decoded = decodeStoreConfig(text)
    if (!decoded.ok)
      return yield* Effect.fail(StoreConfigInvalid.make({ path, reason: decoded.reason }))
    return { path, present: true, ...storePolicyOf(decoded.config) }
  })

/**
 * Where the store's policy comes from right now, for a status to report: `file` (present and
 * decodes), `defaults` (absent: the library defaults apply, which refuse no type and anchor
 * nothing), or `invalid` (present and unreadable or malformed: every write that needs the policy
 * refuses with `ERR_STORE_CONFIG`, and `reason` says why). Never fails, so a status still answers
 * over a broken file.
 */
export interface PolicySource {
  readonly source: "file" | "defaults" | "invalid"
  readonly path: string
  readonly reason: string | null
}

/** {@link PolicySource} from one read of the store's policy file. */
export const policySourceOf = (root: string): Effect.Effect<PolicySource> =>
  loadStorePolicy(root).pipe(
    Effect.map(
      (loaded): PolicySource => ({
        source: loaded.present ? "file" : "defaults",
        path: loaded.path,
        reason: null
      })
    ),
    Effect.catchTag("StoreConfigInvalid", (invalid) =>
      Effect.succeed<PolicySource>({
        source: "invalid",
        path: invalid.path,
        reason: invalid.reason
      })
    )
  )

/** One line naming a {@link PolicySource}, as `head serve` logs it at startup. */
export const describePolicySource = (policy: PolicySource): string => {
  switch (policy.source) {
    case "file":
      return `policy from ${policy.path}`
    case "defaults":
      return `${STORE_CONFIG_FILE} absent: library defaults`
    case "invalid":
      return `${policy.path} does not decode (${policy.reason ?? "unknown"}): every write that needs the policy refuses with ERR_STORE_CONFIG until it is fixed`
  }
}

/** {@link loadStorePolicy} at the root the app layer resolved (`--repo`, else `MEMHTML_ROOT`). */
export const loadStorePolicyHere = Effect.gen(function* () {
  const roots = yield* Roots
  return yield* loadStorePolicy(roots.memhtmlRoot)
})

/**
 * Whether a v1 record door is open under `mode` in a process carrying `session`
 * (`MEMHTML_SESSION`, or `undefined`): `open`, or `closed` with the session that closed it (`null`
 * when the store's `closed` mode closed it with no session set).
 *
 * MCP has no per-call session binding, so the MCP server reads `MEMHTML_SESSION` from its own
 * environment exactly as the CLI does: a server an agent runtime starts inside a run (the variable
 * exported to it) is closed under `closed-in-session`, and a shared server started outside any run
 * is open. `closed` closes both surfaces whatever the environment says.
 */
export const v1DoorState = (
  mode: V1DoorMode,
  session: string | undefined
): { readonly open: true } | { readonly open: false; readonly session: string | null } => {
  if (mode === "open") return { open: true }
  if (session !== undefined) return { open: false, session }
  return mode === "closed" ? { open: false, session: null } : { open: true }
}

/**
 * Refuse a v1 record door the store's policy closes, reading the policy at the layer's root: the
 * guard every record-creating CLI arm and MCP tool runs before it writes. `door` names the command
 * or tool for the refusal.
 */
export const guardV1Door = (door: string) =>
  Effect.gen(function* () {
    const loaded = yield* loadStorePolicyHere
    const state = v1DoorState(loaded.policy.v1Doors, sessionFromEnv())
    if (state.open) return
    return yield* Effect.fail(
      V1DoorClosed.make({ door, mode: loaded.policy.v1Doors, session: state.session })
    )
  })

/** One key's effective value and its source, as `memhtml config` reports it. */
export interface ConfigEntry<A> {
  readonly value: A
  readonly source: StorePolicySource | "env"
}

/** Whether the working-tree file matches what git holds for it. */
export type ConfigTracking = "committed" | "modified" | "untracked" | "absent" | "unknown"

/** `git status --porcelain` for the one file, read as {@link ConfigTracking}. */
const trackingOf = (root: string, present: boolean): Effect.Effect<ConfigTracking> =>
  makeGit(root)
    .run(["status", "--porcelain", "--", STORE_CONFIG_FILE])
    .pipe(
      Effect.map((out): ConfigTracking => {
        const line = out.trimEnd()
        if (line === "") return present ? "committed" : "absent"
        if (line.startsWith("??")) return "untracked"
        return present ? "modified" : "absent"
      }),
      Effect.orElseSucceed((): ConfigTracking => "unknown")
    )

/** The `config.report` payload's store half: the file, its git state, every key and its source. */
export const storeConfigReport = (root: string) =>
  Effect.gen(function* () {
    const loaded = yield* loadStorePolicy(root)
    const { policy, sources } = loaded
    return {
      file: {
        path: loaded.path,
        present: loaded.present,
        git: yield* trackingOf(root, loaded.present)
      },
      store: {
        "writeBar.refusedTypes": {
          value: [...policy.writeBar.refusedTypes].map(([type, reason]) => ({ type, reason })),
          source: sources["writeBar.refusedTypes"]
        },
        "writeBar.requireAnchor": {
          value: policy.writeBar.requireAnchor,
          source: sources["writeBar.requireAnchor"]
        },
        v1Doors: { value: policy.v1Doors, source: sources.v1Doors },
        "curator.writerBuckets": {
          value: policy.curator.writerBuckets,
          source: sources["curator.writerBuckets"]
        },
        "curator.placementQuota": {
          value: policy.curator.placementQuota,
          source: sources["curator.placementQuota"]
        }
      } satisfies Record<StorePolicyKey, ConfigEntry<unknown>>
    }
  })
