import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { jwtHmac, verifyJwtHmac } from "eve/channels/auth"
import { describe, expect, it } from "vitest"

import {
  mintRunSecret,
  RUN_SECRET_ENV,
  runSecretFrom,
  runVerifierConfig,
  sameRunSecret,
  signRunToken
} from "../src/run-auth.js"

/**
 * The run-credential tier: the signer this app wrote and the verifier eve ships, checked against each
 * other rather than each against a description of the other.
 *
 * **This is the one test file that imports eve, and the import is what makes the guards non-vacuous.**
 * Every other tier stays eve-free so it needs no server — `contract.ts` records that rule — and this
 * file does not break it: `verifyJwtHmac` is a pure async function over a string and a config object,
 * with no server, no credential, no network, and no filesystem. A test that instead asserted "the
 * config names HS256" would pass against a signer that produced garbage, which is exactly the vacuous
 * shape this repo has shipped before. What is asserted here is the ACCEPTANCE VERDICT of the code that
 * will run in production.
 *
 * The rejection cases are the point. A guard that only proves a good token is accepted cannot tell an
 * authenticator from `none()`.
 */

const secretFor = (secret: string): Record<string, string | undefined> => ({
  [RUN_SECRET_ENV]: secret
})

/** A config over a fresh secret, unwrapped. Fails loudly rather than returning null into an assertion. */
const configFor = (secret: string) => {
  const config = runVerifierConfig(secretFor(secret))
  if (config === null) throw new Error("expected a minted secret to yield a verifier config")
  return config
}

describe("the minted secret", () => {
  /**
   * SHAPE only, never the value — the repo rule, and it costs nothing here because every property
   * worth asserting is a property of the shape. 43 characters is `base64url(32 bytes)` unpadded, and
   * 32 bytes is HS256's hash width: RFC 7518 §3.2 wants an HMAC key at least the size of the hash
   * output, and eve keys the verifier with the UTF-8 bytes of this string
   * (node_modules/eve/dist/src/runtime/governance/auth/jwt-hmac.js).
   */
  it("carries at least 256 bits in a url-safe encoding", () => {
    const secret = mintRunSecret()
    expect(secret.length).toBe(43)
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  /**
   * Per-run means per-mint, and this is the assertion that a fixed default would fail. Sixteen draws
   * rather than two, so a generator seeded once per process — the plausible regression, not an
   * adversarial one — cannot pass by luck.
   */
  it("differs on every mint", () => {
    const drawn = new Set(Array.from({ length: 16 }, () => mintRunSecret()))
    expect(drawn.size).toBe(16)
  })
})

describe("reading the secret out of an environment", () => {
  it("accepts a minted secret", () => {
    const secret = mintRunSecret()
    const read = runSecretFrom(secretFor(secret))
    expect(read).not.toBeNull()
    // Compared, never printed. An equality assertion on the value would put it in a failure diff.
    expect(read !== null && sameRunSecret(read, secret)).toBe(true)
  })

  /**
   * Absent, blank, and under-width all read as NO SECRET, and the third is the measured one:
   * `verifyJwtHmac` accepts a three-character secret's own token (probed 2026-08-09 against eve
   * 0.31.0 — jose does not check HS key width on verify), so an under-width value would otherwise be
   * a working password. The floor is this app's to enforce or nobody's.
   */
  it("refuses an absent, blank, or under-width value", () => {
    expect(runSecretFrom({})).toBeNull()
    expect(runSecretFrom(secretFor(""))).toBeNull()
    expect(runSecretFrom(secretFor("   "))).toBeNull()
    expect(runSecretFrom(secretFor("abc"))).toBeNull()
    expect(runSecretFrom(secretFor("x".repeat(42)))).toBeNull()
    expect(runSecretFrom(secretFor("x".repeat(43)))).not.toBeNull()
  })

  /** No secret means no verifier config, which is the value the channel turns into an empty auth walk. */
  it("yields no verifier config without a usable secret", () => {
    expect(runVerifierConfig({})).toBeNull()
    expect(runVerifierConfig(secretFor("abc"))).toBeNull()
  })
})

describe("eve's own verifier on this app's tokens", () => {
  /** The happy path, decided by the code that decides it in production. */
  it("accepts a token signed with the run's secret", async () => {
    const secret = mintRunSecret()
    const result = await verifyJwtHmac(signRunToken({ secret }), configFor(secret))
    expect(result.ok).toBe(true)
    // A service principal, not the anonymous one `none()` produced. That difference is the change.
    expect(result.ok && result.sessionAuth.principalType).toBe("service")
    expect(result.ok && result.sessionAuth.authenticator).toBe("jwt-hmac")
  })

  /**
   * The rejection this whole change exists for: no credential at all. `extractBearerToken` returns
   * `null` for a missing or non-Bearer `Authorization` header
   * (node_modules/eve/dist/src/public/channels/auth.d.ts:138-144), so `null` here is the request the
   * old `none()` policy served.
   *
   * (Mutation: replacing `jwtHmac(config)` with `none()` in `agent/channels/eve.ts` cannot fail this
   * case, which is why the live 401 check and the channel-source guards below exist beside it.)
   */
  it("refuses a request carrying no token", async () => {
    const result = await verifyJwtHmac(null, configFor(mintRunSecret()))
    expect(result.ok).toBe(false)
  })

  /** A WRONG token, in the four ways one is wrong. Each returns `{ ok: false }` with no detail. */
  it("refuses a token signed with a different secret", async () => {
    const config = configFor(mintRunSecret())
    const forged = signRunToken({ secret: mintRunSecret() })
    expect((await verifyJwtHmac(forged, config)).ok).toBe(false)
  })

  it("refuses a token that is not a JWT at all", async () => {
    const config = configFor(mintRunSecret())
    expect((await verifyJwtHmac("not-a-jwt", config)).ok).toBe(false)
    expect((await verifyJwtHmac("", config)).ok).toBe(false)
  })

  /**
   * A token whose payload was edited keeps its old signature, so this is the tamper case rather than a
   * second forgery case: the segments are re-encoded with a foreign `sub` and the original MAC left in
   * place. It fails on the signature before any matcher runs.
   */
  it("refuses a token whose claims were edited after signing", async () => {
    const secret = mintRunSecret()
    const [head, body, signature] = signRunToken({ secret }).split(".")
    const claims = JSON.parse(Buffer.from(String(body), "base64url").toString("utf8")) as Record<
      string,
      unknown
    >
    const edited = Buffer.from(JSON.stringify({ ...claims, sub: "someone-else" }), "utf8").toString(
      "base64url"
    )
    const tampered = `${String(head)}.${edited}.${String(signature)}`
    expect((await verifyJwtHmac(tampered, configFor(secret))).ok).toBe(false)
  })

  /**
   * A correctly signed token from a PREVIOUS run does not authenticate to this one, which is the
   * property "per-run secret" is worth having for. Nothing about the token is malformed — it is a
   * valid token for a server that no longer exists.
   */
  it("refuses a valid token minted for a different run", async () => {
    const past = mintRunSecret()
    const present = mintRunSecret()
    const carriedOver = signRunToken({ secret: past })
    expect((await verifyJwtHmac(carriedOver, configFor(past))).ok).toBe(true)
    expect((await verifyJwtHmac(carriedOver, configFor(present))).ok).toBe(false)
  })

  /**
   * The claim matchers, exercised as the belt-and-braces they are. `issuer` and `audiences` are checked
   * after the signature, so a secret that leaked into another eve app's environment still mints nothing
   * this channel accepts. Asserted by verifying a real token against a config whose issuer or audience
   * was moved, since this module offers no way to sign the wrong ones.
   */
  it("binds the token to this app's issuer and audience", async () => {
    const secret = mintRunSecret()
    const token = signRunToken({ secret })
    const config = configFor(secret)
    expect((await verifyJwtHmac(token, { ...config, issuer: "somebody-else" })).ok).toBe(false)
    expect((await verifyJwtHmac(token, { ...config, audiences: ["another/app"] })).ok).toBe(false)
    expect((await verifyJwtHmac(token, { ...config, subjects: ["another-caller"] })).ok).toBe(false)
  })

  /**
   * The token is SHORT-LIVED, and this asserts it from the token rather than from the constant: `exp`
   * is within a few minutes of `iat`, so a credential that escapes is stale in minutes rather than
   * good for the process's life. The client re-signs per request, so a tight TTL costs nothing.
   */
  it("expires within minutes of being signed", () => {
    const [, body] = signRunToken({ secret: mintRunSecret() }).split(".")
    const claims = JSON.parse(Buffer.from(String(body), "base64url").toString("utf8")) as {
      iat: number
      exp: number
    }
    expect(claims.exp - claims.iat).toBeGreaterThan(0)
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300)
  })

  /**
   * The config this app builds is accepted by the STRATEGY factory, not only by the bare verifier.
   * `jwtHmac` is what `agent/channels/eve.ts` calls, and it wraps the verifier with a declared `Bearer`
   * challenge (auth.d.ts:447-451) — so this is the assignability of `RunVerifierConfig` to
   * `VerifyJwtHmacConfig` proven at runtime as well as by the typechecker, which matters because the
   * interface is restated structurally rather than imported.
   */
  it("satisfies the jwtHmac strategy factory eve's channel is handed", () => {
    expect(typeof jwtHmac(configFor(mintRunSecret()))).toBe("function")
  })
})

/**
 * The authored-file half. `agent/channels/eve.ts` and the client's spawn are the two places the
 * mechanism is WIRED, and neither is reachable from a unit test — the channel is loaded by eve in a
 * server process and the spawn needs a built `.output/`. These read them as text, which is the same
 * tier `agent-files.test.ts` and `start-port.test.ts` already use for the same reason.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Strip comments, so a text assertion is about CODE and not about prose that mentions the name. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const codeOf = async (...parts: string[]): Promise<string> =>
  codeOnly(await readFile(join(packageRoot, ...parts), "utf8"))

describe("the channel fails closed", () => {
  /**
   * `none()` is GONE, not merely unused. It is the one export that accepts every request and terminates
   * the walk (auth.d.ts:278-294), so its presence anywhere in this file's code would be a policy no
   * amount of `jwtHmac` beside it could override — `routeAuth` stops at the first entry that returns a
   * context.
   *
   * (Mutation: restoring `auth: [none()]` fails this case, and so does appending `none()` after the
   * `jwtHmac` entry, which is the subtler regression — an array that ends in `none()` reads as
   * "authenticate, with a fallback" and is in fact "accept everything".)
   */
  it("names no anonymous authenticator", async () => {
    const code = await codeOf("agent", "channels", "eve.ts")
    expect(code).toContain("jwtHmac")
    expect(code).not.toMatch(/\bnone\(/)
    expect(code).not.toMatch(/\blocalDev\(/)
    expect(code).not.toMatch(/\bplaceholderAuth\(/)
  })

  /**
   * A missing secret yields `[]`, and `[]` is a 401: `routeAuth` rejects when its walk exhausts,
   * "including the empty-array case" (auth.d.ts:255-262). The alternative a reviewer should look for is
   * an `??`-style fallback to an accepting entry, which would be strictly worse than the `none()` this
   * replaced — that at least announced itself.
   *
   * (Mutation: changing the ternary to `config === null ? [none()] : [jwtHmac(config)]` fails the case
   * above; changing it to always build a config from a defaulted secret fails this one.)
   */
  it("hands eve an empty auth walk when the environment holds no secret", async () => {
    const code = await codeOf("agent", "channels", "eve.ts")
    expect(code).toMatch(/config === null \? \[\] : \[jwtHmac\(config\)\]/)
    expect(code).toContain("runVerifierConfig(process.env)")
  })
})

describe("the client presents a per-run credential", () => {
  /**
   * The secret is minted at the SPAWN, and it is minted rather than read: a value from `options.env`,
   * from a constant, or from a caller would survive across runs, and the window this change closes is
   * exactly how long a credential that reaches the endpoint stays good.
   *
   * (Mutation: hoisting `mintRunSecret()` out of the retry loop into a module constant fails the second
   * assertion, because the call then no longer sits in the spawn's argument object.)
   */
  it("mints a fresh secret per spawn and carries it on the child's environment", async () => {
    const code = await codeOf("src", "client.ts")
    expect(code).toContain("[RUN_SECRET_ENV]: secret")
    expect(code).toMatch(/secret: mintRunSecret\(\)/)
    // Never a default and never caller-supplied: no option names it, and no fallback exists.
    expect(code).not.toMatch(/readonly secret\?:/)
    expect(code).not.toMatch(/mintRunSecret\(\)\s*\?\?/)
  })

  /**
   * The token rides on eve's own `auth` option in the FUNCTION form, which resolves per request
   * (node_modules/eve/dist/src/client/types.d.ts:49-69). That is what lets a two-minute token serve a
   * ten-minute turn: a stream reconnect signs a new one.
   *
   * (Mutation: replacing the thunk with `signRunToken({ secret: server.secret })` — a value, not a
   * function — fails this case, and would silently 401 any request made more than `TOKEN_TTL_SECONDS`
   * after the session was created.)
   */
  it("signs a token per request rather than once per turn", async () => {
    const code = await codeOf("src", "client.ts")
    expect(code).toMatch(/auth: \{ bearer: \(\) => signRunToken\(\{ secret: server\.secret \}\) \}/)
    // Credential-bearing, so a redirect must not carry the header off-origin.
    expect(code).toContain('redirect: "manual"')
  })

  /**
   * The bind address survives the change. It is now defence in depth rather than the whole boundary,
   * and depth is only depth while both layers are there — an agent reading "auth is handled now" could
   * plausibly relax this, so the guard is restated in this file beside the auth it complements.
   */
  it("keeps the loopback bind address, unoverridable", async () => {
    const code = await codeOf("src", "client.ts")
    expect(code).toContain('const LOOPBACK_HOST = "127.0.0.1"')
    expect(code).toMatch(/"--host",\s*LOOPBACK_HOST/)
    expect(code).not.toMatch(/readonly host\?:/)
  })

  /**
   * No secret in a log line, a failure message, or a comment. The failure paths are where this would
   * slip: `startServerOnPort` composes a reason from the child's stderr and the origin, and
   * `startServer` logs a retry warning — neither may interpolate the credential.
   *
   * Asserted over the whole file rather than over those two strings, because the property is "nowhere",
   * and `secret` appearing inside any template literal or log call is the shape that would break it.
   */
  it("never renders the secret into a message", async () => {
    const source = await readFile(join(packageRoot, "src", "client.ts"), "utf8")
    expect(source).not.toMatch(/\$\{[^}]*secret[^}]*}/i)
    expect(source).not.toMatch(/log\w*\([^)]*secret/i)
    expect(source).not.toMatch(/String\(\s*\w*secret/i)
  })
})
