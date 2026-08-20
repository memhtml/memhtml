# A sandbox's egress belongs to whoever constructs it, not to the sandbox library

**Tags**: sandbox, just-bash, quickjs, eve, egress, imds, credentials, probe-discipline, capability-check **Modules**: apps/consolidator/agent/sandbox, apps/cli (memhtml exec), scripts/probe-sandbox-egress.mjs **Probe**: `node scripts/probe-sandbox-egress.mjs` — run it rather than citing this file

## The measured behavior

`just-bash` 3.2.0 (the version eve 0.31.0 loads), `javascript: true` on both cases:

| Construction                                                                            | `curl`                       | Public host                    | IMDSv2                                                  | Guest `fetch`                                        |
| --------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------- |
| `new Bash({ javascript: true })`                                                        | **not a command** (exit 127) | unreachable — no client exists | not attempted                                           | **refused on call**: "Network access not configured" |
| `new Bash({ javascript: true, network: { dangerouslyAllowFullInternetAccess: true } })` | registered                   | HTTP 200                       | token PUT returns 56 bytes; instance-role name returned | reaches the endpoint                                 |

Network commands are registered **only when a `network` or `fetch` option is provided** — `just-bash/dist/Bash.d.ts:80` states it, and the exit-127 result is what it looks like in practice. So egress is a decision made at construction by the caller, and two consumers of the same sandbox library do not necessarily share one boundary.

That splits this repo's two consumers rather than uniting them:

- **The consolidator inherits full egress and cannot turn it down.** eve hardcodes `network:{dangerouslyAllowFullInternetAccess:!0}` as a literal in `node_modules/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js`, and `justBashSetNetworkPolicyUnsupported()` throws by design. There is no knob. Mitigation therefore lives OUTSIDE eve: a network namespace, an IMDS block, or an IMDS hop limit of 1.
- **`memhtml exec` constructs its own `Bash` and omits the option, so it has a real boundary.** Not a default it is trusting: the absence of the option is the mechanism.

## The IMDS reach is the finding, and the old comment missed it by being true

The prior comment justified the boundary with "no credential is ever placed there." That is accurate and beside the point. Nothing is placed there; something can be **fetched**. Under eve's options an IMDSv2 token PUT succeeds and the instance-role name comes back, which is one request short of instance-role credentials. A sandbox with no secrets in it is not a sandbox with no access to secrets.

The general form: a boundary argument that reasons about what was PUT inside must also account for what can be PULLED from inside. Those are different questions and only one of them was asked.

## `typeof fetch` is a capability check that enforces nothing

`typeof fetch === "function"` in the QuickJS guest under **both** constructions. The refusal happens on CALL, not on the global. So a guard written as "is `fetch` absent?" passes review, typechecks, reads as a security assertion, and distinguishes nothing — the same shape as a driver option that is accepted by the constructor's types and then ignored at runtime. When a safety property rests on a capability being unavailable, **call the thing** and assert the refusal.

## Two incidental facts that cost debugging time

1. **just-bash's CJS build has a broken `js-exec`.** `require.resolve("just-bash")` returns `dist/bundle/index.cjs`, where the first `js-exec` fails `Invalid URL` and every later one fails `Cannot read properties of undefined (reading 'execute')`. The ESM build (`dist/bundle/index.js`) works. A probe built on the CJS entry reports the guest's `fetch` as unreachable under BOTH constructions — the right conclusion for the wrong reason, and it would have hidden the whole finding.
2. **`js-exec` is not re-entrant in 3.2.0.** A second `js-exec` on the same `Bash` instance fails with the `execute` error even when the first succeeded. Use a fresh instance per execution.

## What to do with this

Ask "who called the constructor" before recording any sandbox's boundary, and state the mechanism alongside the claim so a reader can check it. A limitation that is accepted rather than fixed still has to name the party that could fix it: here, the mitigation is outside eve because eve exposes no option, and saying so is what keeps "accepted" from reading as "unexamined".
