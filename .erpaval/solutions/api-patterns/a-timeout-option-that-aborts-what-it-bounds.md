# An SDK timeout option can abort the request it looks like it bounds

**Category:** api-patterns · **Session:** session-27698a · 2026-08-25

Two `BedrockRuntimeClient`s had no timeout at all, so a hung socket never errored, never retried, and stalled a sleep phase indefinitely. The fix set both a request and a session bound:

```ts
requestHandler: { requestTimeout: 300_000, sessionTimeout: 10_000 }
```

That made it strictly worse. Probed 2026-08-25 against a loopback h2 server, with the values scaled down by one factor:

| options                                         | 1500 ms answer         |
| ----------------------------------------------- | ---------------------- |
| `{requestTimeout: 300000, sessionTimeout: 500}` | **rejected at 508 ms** |
| `{requestTimeout: 300000}`                      | 200 OK at 1511 ms      |

`@aws-sdk/client-bedrock-runtime` resolves `NodeHttp2Handler`, whose connection manager does `session.setTimeout(config.sessionTimeout, ensureDestroyed)`, and `destroy()` is unconditional with no in-flight check. So `sessionTimeout` is not an idle-session bound — **it kills a live request**. Every InvokeModel was capped at 10 s time-to-first-byte, in a file whose own comment says the slowest legitimate answers take minutes.

Two things compound it. The rejection is a bare `Error` with no `code` and no `$metadata`, so smithy's classifier matches nothing and `maxAttempts: 10` never retries. And `requestTimeout` becomes unreachable, because the session timer always fires first — so a genuinely dead socket is reported at 10 s as "did not get a response" instead of as a retryable `TimeoutError`.

`requestTimeout` alone is the correct bound: it is armed on the _stream_, it bounds a dead socket, and its error is retryable.

**Second trap in the same three lines:** naming a `requestHandler` **replaces** bedrock-runtime's own default provider, which resolves to exactly `{disableConcurrentStreams: true}`. Omitting it silently swapped one isolated session per request for a pooled multiplexed one — a connection-model change nobody asked for, invisible in every test.

Third, for calibration: the option the review _suggested_, `connectionTimeout`, does not exist on this handler at all. A misspelled or unsupported handler option is silently ignored, which looks exactly like a fix and changes nothing.

## What actually catches it

Read the handler the SDK actually resolves — `dist-es/runtimeConfig.js` names it — then read that handler's own type declaration for the option set. Do not reason from the option's name.

And drive a request through it. The test that shipped this defect asserted the config object's properties and then restated the constant back to itself (`expect(TIMEOUTS.requestTimeout).toBe(300_000)`), so it could not tell a bound that protects a phase from one that kills it — the repo's "contracts pin shape, not meaning" hazard, in a timeout. A loopback h2 server answering slowly is fully offline and needs no credentials.

Scale the shipped values and the allowed answer by the _same_ factor in the test. Then any millisecond bound added later is compressed identically and fails if it fires before a legitimate answer, which makes the test guard the class rather than the instance.

Related: [[xor-params-and-mcp-error-masking]] for the other shape of an error that loses its own classification.
