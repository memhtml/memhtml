import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * The per-run credential the agent server demands and the client presents.
 *
 * ## What this replaces, and why the composition was worse than either half
 *
 * `agent/channels/eve.ts` used to authenticate every caller anonymously with `none()`, and the only
 * thing keeping the agent off the network was the bind address. Loopback is not an authorization
 * boundary on a shared host: any local UID could drive the session endpoint for a run's duration,
 * which is free Opus tokens plus a bash sandbox. That alone was rated MEDIUM (CWE-306).
 *
 * The sandbox half is what makes it more than that. The sandbox has FULL network egress and this app
 * cannot turn it off — `network:{dangerouslyAllowFullInternetAccess:!0}` is a hardcoded literal in
 * node_modules/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js, and
 * `justBashSetNetworkPolicyUnsupported()` throws by design. Measured 2026-08-09
 * (`node scripts/probe-sandbox-egress.mjs`): `curl` reaches example.com, an IMDSv2 token PUT returns
 * 56 bytes, and the instance-role name comes back. So the unauthenticated endpoint was a handle on a
 * sandbox that reaches IMDS. `agent/sandbox/sandbox.ts` records that egress cannot be closed here;
 * this module closes the handle.
 *
 * ## The mechanism
 *
 * One HS256 bearer JWT over a secret this process mints per spawn from `randomBytes`, verified by
 * eve's own `jwtHmac` strategy (node_modules/eve/dist/src/public/channels/auth.d.ts:451, config shape
 * at :41-60). The secret crosses to the server on the SPAWN ENVIRONMENT, which is the same channel
 * `mount.ts` uses for mount roots and for the same reason: the auth policy is evaluated in the eve
 * SERVER process while the value is decided by the CLIENT that spawns it.
 *
 * **No eve import here.** `VerifyJwtHmacConfig` is a plain interface, so {@link RunVerifierConfig}
 * restates it structurally — the same move `contract.ts` makes for `JsonObject`, and it is what keeps
 * eve out of `src/`'s import graph so the test tier stays server-free. TypeScript is structural, so
 * the value {@link runVerifierConfig} returns is assignable to `jwtHmac`'s parameter with no cast.
 *
 * Every claim and bound below was verified against the installed eve 0.31.0 by driving
 * `verifyJwtHmac` directly (2026-08-09): a token from {@link signRunToken} verifies as
 * `principalType: "service"`, and `null`, a non-JWT string, a token signed with a different secret,
 * an expired token, one with no `sub`, one with a foreign `sub`, and one with a foreign `aud` each
 * return `{ ok: false }`. `tests/run-auth.test.ts` is that probe kept as a test.
 */

/**
 * The variable a spawning client uses to hand the server the run's secret.
 *
 * Named for its LIFETIME rather than its content, because the lifetime is the security property: one
 * spawn, one secret. A value that survived a run — a fixed default, a config key, anything a caller
 * could supply — would reopen the window this closes, since the window is exactly "how long is a
 * credential that reaches this endpoint good for".
 */
export const RUN_SECRET_ENV = "MEMHTML_CONSOLIDATOR_RUN_SECRET"

/**
 * How many random bytes a run secret carries. 32 = 256 bits, matching HS256's hash output.
 *
 * RFC 7518 §3.2 requires an HMAC key at least the size of the hash output, and eve keys the verifier
 * with `createSecretKey(Buffer.from(secret, "utf8"))`
 * (node_modules/eve/dist/src/runtime/governance/auth/jwt-hmac.js) — so the KEY MATERIAL is the
 * base64url text, 43 bytes, carrying these 32 bytes of entropy. Both the byte count and the encoded
 * length clear the floor.
 *
 * The floor is not enforced anywhere else. Probed against the installed eve: a three-character secret
 * verifies its own token happily, because jose does not check HS key width on verify. So
 * {@link runSecretFrom} enforces it, or a hand-set variable would be a password.
 */
const SECRET_BYTES = 32

/**
 * The minimum length a secret read from the environment may have, in characters.
 *
 * `base64url(32 bytes)` is exactly 43 unpadded characters, so this is the length {@link mintRunSecret}
 * produces rather than a number picked to be round. A shorter value is REFUSED rather than accepted
 * with a warning: an under-width HMAC key is the one failure mode eve's verifier will not catch.
 */
const MIN_SECRET_CHARS = 43

/** The signature algorithm, on both sides, as one constant so they cannot drift apart. */
const ALGORITHM = "HS256" as const

/** The `node:crypto` hash name `HS256` denotes. Paired with {@link ALGORITHM} and never separately. */
const HMAC_HASH = "sha256"

/**
 * `iss`, `aud`, and `sub`, all three matched by the verifier.
 *
 * Redundant with the signature and deliberately so: a secret that leaked into some other eve app's
 * environment still mints nothing this channel accepts, because `subjects` and `audiences` are
 * checked after the signature (`areTokenClaimMatchersSatisfied` in
 * node_modules/eve/dist/src/runtime/governance/auth/token-claims.js). They cost one string compare
 * each and they make a misconfiguration fail closed instead of cross-authenticating.
 *
 * `sub` is REQUIRED by eve independently of `subjects`: the strategy rejects a token whose `sub` is
 * absent or empty before it looks at any matcher (jwt-hmac.js, verified live).
 */
const ISSUER = "memhtml-consolidator"
const AUDIENCE = "memhtml-consolidator/eve"
const SUBJECT = "memhtml-consolidator-client"

/**
 * How long one token is good for. Seconds.
 *
 * Short because it does not have to cover the run: the client passes the FUNCTION form of eve's
 * `TokenValue`, which resolves before every HTTP call
 * (node_modules/eve/dist/src/client/types.d.ts:49-69), so a 10-minute turn presents a fresh token on
 * every request rather than one token held open for the turn. That decouples the credential's
 * lifetime from `TURN_TIMEOUT_MS` entirely — a stream reconnect ten minutes in signs a new token.
 *
 * 120s rather than something tighter because the bound that matters is the SERVER's lifetime (one
 * run), and a token has to survive being minted before a request that then queues behind a model
 * call's connection setup.
 */
const TOKEN_TTL_SECONDS = 120

/**
 * Clock skew the verifier tolerates, in seconds. eve defaults to 30.
 *
 * 5 because there is no skew to tolerate: the signer and the verifier are two processes on ONE host
 * reading one clock, so the 30s default is budget for a distributed issuer this deployment does not
 * have. It is the difference between a token being good for 125s and 150s.
 */
const CLOCK_SKEW_SECONDS = 5

/**
 * eve's `VerifyJwtHmacConfig`, restated structurally.
 *
 * Field for field with node_modules/eve/dist/src/public/channels/auth.d.ts:41-60, minus the two
 * optional matchers this app does not use. Declared rather than imported to keep `src/` free of eve
 * — see the note at the top of this module.
 */
export interface RunVerifierConfig {
  readonly algorithm: "HS256" | "HS384" | "HS512"
  readonly audiences: readonly string[]
  readonly issuer: string
  readonly secret: string
  readonly clockSkewSeconds: number
  readonly subjects: readonly string[]
}

/**
 * A fresh secret for one spawn.
 *
 * `randomBytes` and not `randomUUID`: a UUIDv4 carries 122 bits in a fixed 36-character shape, which
 * is under the HS256 key floor {@link SECRET_BYTES} exists to clear. base64url so the value is safe
 * in an environment variable with no quoting question — `+`, `/`, and `=` are all avoided.
 */
export const mintRunSecret = (): string => randomBytes(SECRET_BYTES).toString("base64url")

/**
 * The run's secret as read from an environment, or `null` when there is no usable one.
 *
 * `null` is the FAIL-CLOSED signal and the callers on both sides treat it that way: the channel turns
 * it into a 401 by handing `routeAuth` a walk with nothing that can accept. Absent, blank, and
 * under-width all collapse to `null` on purpose — the caller's move is the same for each (refuse), and
 * distinguishing them in a return value would invite a caller to accept one of them.
 *
 * Never logged and never returned in a message. The value is the credential.
 */
export const runSecretFrom = (env: Record<string, string | undefined>): string | null => {
  const raw = env[RUN_SECRET_ENV]
  if (raw === undefined) return null
  const secret = raw.trim()
  if (secret.length < MIN_SECRET_CHARS) return null
  return secret
}

/**
 * The verifier configuration for an environment, or `null` when it holds no usable secret.
 *
 * Both sides of the boundary read their claims from the constants above through this one function and
 * {@link signRunToken}, so a mismatch between what is signed and what is accepted is not expressible
 * — which matters because every claim mismatch fails the same silent way, as `{ ok: false }` with no
 * detail (eve returns no reason so routes cannot leak which check failed, auth.d.ts:9-19).
 */
export const runVerifierConfig = (
  env: Record<string, string | undefined>
): RunVerifierConfig | null => {
  const secret = runSecretFrom(env)
  if (secret === null) return null
  return {
    algorithm: ALGORITHM,
    audiences: [AUDIENCE],
    issuer: ISSUER,
    secret,
    clockSkewSeconds: CLOCK_SKEW_SECONDS,
    subjects: [SUBJECT]
  }
}

/** base64url of a JSON value, which is the encoding both JWT segments use. */
const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

/**
 * Sign one short-lived bearer token for the run.
 *
 * Hand-rolled over `node:crypto` because eve exports NO signer: `jwtHmac`, `verifyJwtHmac`, and the
 * jose bundle behind them are verify-only on the public surface (checked across every subpath export
 * of eve 0.31.0), so the alternative to these six lines is a new dependency for one HMAC. The claims
 * are the ones {@link runVerifierConfig} matches, which is the whole correctness condition and the
 * reason both live in this module.
 *
 * `exp` is derived from the call, not from the spawn, so each call produces a token valid
 * {@link TOKEN_TTL_SECONDS} from now — that is what makes the per-request function form work.
 */
export const signRunToken = (input: { readonly secret: string }): string => {
  const now = Math.floor(Date.now() / 1_000)
  const head = segment({ alg: ALGORITHM, typ: "JWT" })
  const body = segment({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS
  })
  const signature = createHmac(HMAC_HASH, Buffer.from(input.secret, "utf8"))
    .update(`${head}.${body}`)
    .digest("base64url")
  return `${head}.${body}.${signature}`
}

/**
 * Whether two secrets are the same value, compared in constant time.
 *
 * For a test that has to assert the secret the client minted is the secret the spawn carried without
 * ever reading either one. `timingSafeEqual` throws on a length mismatch, so that case is answered
 * before the compare rather than by catching.
 */
export const sameRunSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}
