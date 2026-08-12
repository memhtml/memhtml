#!/usr/bin/env node
// What a just-bash sandbox can reach on the network, and who decides.
//
// Run it rather than reasoning about it. This file exists because "the sandbox has no network
// isolation to offer" was recorded as a flat fact about just-bash, and it is not one: egress is a
// CONSTRUCTION-TIME decision made by whoever calls `new Bash()`. eve makes it one way and hardcodes
// it; `memhtml exec` makes it the other way. A comment that states the boundary without naming who set
// it cannot be checked, and the previous version of that comment was wrong in the direction that
// matters — it claimed a boundary was sound because "no credential is ever placed there", which is
// true and beside the point when one can be FETCHED.
//
//   node scripts/probe-sandbox-egress.mjs
//
// Probes both constructions against three targets: a public host, the EC2 metadata service (IMDSv2,
// which on this box serves an instance role), and the QuickJS guest's own `fetch`.
//
// The IMDS probe is the one that matters. It is not a hypothetical: under eve's options it returns
// an instance-role NAME, which is the step before credentials. Nothing is exfiltrated here — the
// role name is printed and the credential body is never requested.

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

// Resolve just-bash through the package that declares it: under pnpm's strict node_modules a bare
// specifier does not resolve from `scripts/`, and hardcoding a `.pnpm` path silently drifts from the
// installed version. `apps/consolidator` pins 3.2.0 because that is what eve 0.31.0 loads.
//
// `require.resolve` is used only to LOCATE the package, then the ESM entry is taken from its own
// `exports.import`. Importing what `require.resolve` returns directly gets `dist/bundle/index.cjs`,
// and `js-exec` is BROKEN in that build: measured here, the first call fails `js-exec: Invalid URL`
// and every later one fails `Cannot read properties of undefined (reading 'execute')`, while the same
// script under `dist/bundle/index.js` runs and prints its answer. A probe built on the CJS entry
// would have reported the guest's `fetch` as unreachable under BOTH constructions — the right
// conclusion for the wrong reason, which is the failure mode this whole file exists to avoid.
// `just-bash` does not export `./package.json`, so the ESM entry is derived from the CJS one the
// resolver DOES return: same directory, `.js` rather than `.cjs`. Checked with `existsSync` so a
// future layout change fails loudly here instead of silently falling back to the broken build.
const HOST = new URL("../apps/consolidator/package.json", import.meta.url)
const require = createRequire(HOST)
const CJS_ENTRY = require.resolve("just-bash")
const ESM_ENTRY = CJS_ENTRY.replace(/\.cjs$/, ".js")
if (ESM_ENTRY === CJS_ENTRY || !existsSync(ESM_ENTRY)) {
  throw new Error(
    `expected an ESM sibling of ${CJS_ENTRY}; just-bash's layout changed and this probe needs updating`
  )
}
const { Bash } = await import(pathToFileURL(ESM_ENTRY).href)

const IMDS = "http://169.254.169.254"
const PUBLIC = "http://example.com"
const TIMEOUT = "3"

/** Whether `curl` is even a command in this sandbox, which is the first thing egress depends on. */
const curlRegistered = async (bash) => {
  const probe = await bash.exec("command -v curl")
  return probe.exitCode === 0
}

const probeCurl = async (label, bash) => {
  const registered = await curlRegistered(bash)
  console.log(`\n${label}`)
  console.log(`  curl registered as a command: ${registered ? "YES" : "NO"}`)
  if (!registered) {
    const attempt = await bash.exec(`curl -s -m ${TIMEOUT} ${PUBLIC}`)
    console.log(
      `  curl ${PUBLIC}: exit ${attempt.exitCode} — ${String(attempt.stderr ?? "").trim()}`
    )
    console.log("  IMDS: not attempted; there is no client to attempt it with")
    return
  }

  const pub = await bash.exec(
    `curl -s -m ${TIMEOUT} -o /dev/null -w '%{http_code}' ${PUBLIC}`
  )
  console.log(`  curl ${PUBLIC}: exit ${pub.exitCode}, HTTP ${String(pub.stdout ?? "").trim()}`)

  // IMDSv2 is a two-step protocol: PUT for a token, then GET carrying it. A v1-shaped GET returns
  // 401 on a v2-enforced instance, so a probe that only did the GET would report "IMDS unreachable"
  // from an instance where it is entirely reachable.
  const token = await bash.exec(
    `curl -s -m ${TIMEOUT} -X PUT "${IMDS}/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60"`
  )
  const value = String(token.stdout ?? "").trim()
  if (value.length === 0) {
    console.log(`  IMDSv2 token: none (exit ${token.exitCode}) — metadata service not reachable`)
    return
  }
  console.log(`  IMDSv2 token: obtained, ${String(value.length)} bytes`)

  // The role NAME only. Fetching the credential body would put a live secret in this script's
  // stdout, and the name already settles the question: a sandboxed process that can read this can
  // read the next path down.
  const role = await bash.exec(
    `curl -s -m ${TIMEOUT} -H "X-aws-ec2-metadata-token: ${value}" ${IMDS}/latest/meta-data/iam/security-credentials/`
  )
  const name = String(role.stdout ?? "").trim()
  console.log(
    name.length === 0
      ? "  instance role: none attached"
      : `  instance role: ${name} — credentials are one request further, NOT fetched here`
  )
}

/**
 * The QuickJS guest's own `fetch`, which is a separate surface from `curl`.
 *
 * `typeof fetch` is `"function"` in the guest under BOTH constructions, so a capability check on the
 * global proves nothing — the refusal happens on call. That is exactly the shape of a check that
 * reads as passing while enforcing nothing.
 */
const probeGuestFetch = async (label, options) => {
  // A FRESH `Bash` per `js-exec`, not the instance the curl probe used. Measured: a second `js-exec`
  // on an instance that already ran one fails `Cannot read properties of undefined (reading
  // 'execute')` — the QuickJS runtime is not re-entrant across calls in 3.2.0. Sharing the instance
  // would report the guest as broken rather than as network-refused.
  const bash = new Bash(options)
  await bash.exec("mkdir -p /workspace")
  await bash.exec(`cat > /workspace/egress-probe.mjs <<'JS'
console.log("typeof fetch: " + typeof fetch)
try {
  const response = await fetch("${IMDS}/latest/api/token", { method: "PUT" })
  console.log("REACHED " + response.status)
} catch (cause) {
  console.log("REFUSED " + String(cause && cause.message ? cause.message : cause).slice(0, 120))
}
JS`)
  const result = await bash.exec("js-exec /workspace/egress-probe.mjs")
  console.log(`  guest fetch (${label}): ${String(result.stdout ?? result.stderr ?? "").trim()}`)
}

// `javascript: true` on both, because `js-exec` is off by default and the guest-fetch question only
// exists once it is on. `python3` stays off in both; it is a separate opt-in.
const NO_NETWORK = { javascript: true }
// eve's EXACT option, read out of its shipped dist rather than its docs:
// `network:{dangerouslyAllowFullInternetAccess:!0}` is a literal in
// node_modules/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js, and
// `justBashSetNetworkPolicyUnsupported()` throws, so there is no knob to turn it down.
const EVE_SHAPED = {
  javascript: true,
  network: { dangerouslyAllowFullInternetAccess: true }
}

console.log("just-bash egress is decided at CONSTRUCTION, by the caller of `new Bash()`.")

await probeCurl("A. no `network` option — the `memhtml exec` construction", new Bash(NO_NETWORK))
await probeGuestFetch("no network option", NO_NETWORK)

await probeCurl(
  "B. `dangerouslyAllowFullInternetAccess` — eve's construction",
  new Bash(EVE_SHAPED)
)
await probeGuestFetch("eve's construction", EVE_SHAPED)

console.log(
  [
    "",
    "The difference is the whole finding:",
    "  Omitting `network` leaves curl/wget UNREGISTERED (`command not found`) and makes the guest's",
    "  fetch refuse on call with 'Network access not configured'. That is a real boundary, and it is",
    "  the one `memhtml exec` gets by not asking for egress.",
    "  eve's hardcoded full-access option registers curl and reaches both a public host and IMDS, so",
    "  the consolidator's sandbox can fetch an instance-role credential even though none was ever",
    "  placed in it. Mitigation for that path lives OUTSIDE eve (a network namespace, an IMDS block,",
    "  or a hop limit of 1), because eve exposes no option and rejects setNetworkPolicy outright."
  ].join("\n")
)
