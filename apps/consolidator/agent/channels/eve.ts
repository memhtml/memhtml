import { jwtHmac } from "eve/channels/auth"
import { eveChannel } from "eve/channels/eve"

import { runVerifierConfig } from "../../src/run-auth.js"

/**
 * The HTTP surface `src/client.ts` drives: `/eve/v1`, serving session create, follow-up, and
 * the NDJSON event stream.
 *
 * ## Every request needs a bearer JWT signed with THIS RUN's secret
 *
 * `jwtHmac` verifies an HS256 bearer token against a secret read from the spawn environment
 * (node_modules/eve/dist/src/public/channels/auth.d.ts:451; the config shape is `VerifyJwtHmacConfig`
 * at :41-60). The secret is minted per spawn from `randomBytes` by the client that starts this server
 * — `src/run-auth.ts` owns the whole mechanism, both halves of it, so what is signed and what is
 * accepted cannot drift. There is no fixed default and no config key: a credential that reached this
 * endpoint is good for one run, and a run's secret authenticates nothing after it.
 *
 * `[]` when the environment carries no usable secret, and that empty array is the FAIL-CLOSED path
 * rather than an accident of expression. `routeAuth` returns a 401 when its walk exhausts, "including
 * the empty-array case" (auth.d.ts:255-262, verified live: a spawn with the variable unset answers
 * `{"ok":false,"code":"unauthorized"}` with `www-authenticate: Bearer` on both the create and info
 * routes). So a server started without the variable serves nothing, which is the direction that
 * matters — a fall back to anonymous would be strictly worse than the `none()` this replaces, because
 * that at least announced itself.
 *
 * `runVerifierConfig` refuses an under-width secret for a measured reason: eve keys the verifier with
 * `createSecretKey(Buffer.from(secret, "utf8"))`
 * (node_modules/eve/dist/src/runtime/governance/auth/jwt-hmac.js) and jose does not check HS key width
 * on verify — probed 2026-08-09, a three-character secret verifies its own token. The width floor is
 * therefore this app's to enforce or nobody's.
 *
 * Beside the signature, `issuer`, `audiences`, and `subjects` are matched
 * (`areTokenClaimMatchersSatisfied`, node_modules/eve/dist/src/runtime/governance/auth/token-claims.js),
 * and eve rejects a token with no `sub` before consulting any matcher. That is what keeps a secret
 * leaked into some other eve app's environment from cross-authenticating here.
 *
 * ## The bind address STAYS, as defense in depth
 *
 * `eve start` binds ALL INTERFACES by default (node_modules/eve/docs/reference/cli.md, `eve start
 * --host`), so `src/client.ts` still spawns with `--host 127.0.0.1` from a constant that takes no
 * caller value — see `LOOPBACK_HOST` there. It is no longer the only control, and it is not redundant:
 * loopback bounds who can OPEN a connection, the token bounds who can be SERVED. Never start this
 * agent by hand without that flag.
 *
 * The server is also short-lived: the wrapper spawns it per run on an ephemeral port and kills it when
 * the run settles.
 *
 * ## What is still exposed
 *
 * **An attacker who can READ this process's spawn environment still wins.** Same-UID `/proc/<pid>/environ`
 * is the concrete path, and `MEMHTML_CONSOLIDATOR_RUN_SECRET` is in there for the server's whole life; a
 * reader mints valid tokens for as long as the run lasts. What is closed is the case the finding was
 * about — a different local UID, which can reach loopback and cannot read another UID's environment.
 * The remaining exposure is a same-UID one, and the mitigation for it is not in this app either: it is
 * whatever isolates the UID the sleep cycle runs as.
 *
 * That matters because of what the sandbox behind this endpoint can do. Egress is on, and eve hardcodes
 * it — an authenticated caller still gets a bash sandbox that reaches IMDS (`agent/sandbox/sandbox.ts`
 * records the measurement and why nothing here can turn it off). Auth is what makes reaching that
 * sandbox require a credential; it does not make the sandbox safe.
 *
 * If this app ever needs a non-loopback deployment, the secret channel is the thing to replace: an
 * environment variable is fine between a parent and the child it spawned and is not a way to
 * distribute a credential to a caller on another host. `httpBasic`, `oidc`, and `jwtEcdsa` are
 * exported from the same module.
 */
export default eveChannel({
  auth: (() => {
    const config = runVerifierConfig(process.env)
    return config === null ? [] : [jwtHmac(config)]
  })()
})
