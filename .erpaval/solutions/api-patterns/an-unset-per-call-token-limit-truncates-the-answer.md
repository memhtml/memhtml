# An unset per-call token limit truncates the answer, and a parked turn is not a contract violation

**Category:** api-patterns · **Session:** session-537237 · 2026-09-02

Two `sleep run`s ended trace-consolidation with `ConsolidatorContractViolation: the turn settled without a structured result although an outputSchema was sent` and `consolidated=0` (issue #113). The agent had not broken the contract, and there were two defects stacked on top of each other — the second one only became visible after a live repro removed the first.

**The blocking defect was a per-call limit nobody set.** eve passes no `maxOutputTokens` for a directly-authored provider model (it resolves that from the AI Gateway catalog, which does not know a Bedrock inference-profile id), and `@ai-sdk/amazon-bedrock@5.0.61` writes `inferenceConfig.maxTokens` only when the call settings name one. So the request carried no limit and Bedrock applied its own 4,096-token default. Measured on a four-transcript batch: 28 consecutive model calls returned `finishReason: "length"` at exactly 4,096 output tokens, all 15 `final_output` calls arrived as truncated JSON, and the turn died 11 minutes later on a provider `MODEL_CALL_FAILED`. The answer was never expressible. Fix: wrap the model with the `ai` package's `defaultSettingsMiddleware({ settings: { maxOutputTokens } })` — `wrapLanguageModel` preserves `specificationVersion`/`provider`/`modelId`, so eve's compiler still accepts it, and the built manifest carries the number.

**A budget baked at build time cannot be passed per run.** The first attempt at this fix computed a per-batch cap in the client and put it on the spawned server's environment. It had no effect: `eve build` bakes `limits` into `.output/server/index.mjs` and the runtime reads them from that manifest, so the session snapshot showed the build-time literal. Anything the agent definition decides is a build-time constant.

**And the reported failure was the wrong one.**

`agent/agent.ts` set `limits.maxOutputTokensPerSession: 50_000` with a comment saying eve would fail the next model call with `SESSION_TOKEN_LIMIT_REACHED`. That is eve's **task-mode** branch. A client session is **conversation-mode**, and `enforceSessionTokenLimit` (node_modules/eve/dist/src/harness/session-limit-enforcement.js) routes it to `parkOnSessionTokenLimit`: an `input.requested` of kind `session-limit` (Approve / Stop), then the turn epilogue. The client gets `MessageResult.status: "waiting"`, `data: undefined`, the request in `inputRequests`, and eve's workflow run stays `running`. A client that checks `status === "failed"` and then `data === undefined` files the park under the contract-violation arm, which is a claim about an answer that was never given.

Two readings that would have caught it earlier:

- **eve's per-run workflow records are on disk and name the cause.** `~/.cache/memhtml/eve/<version>/.eve/.workflow-data/runs/wrun_*.json` carries `$eve.output_tokens`, `$eve.input_tokens`, `status`, and timestamps; `events/` carries the `attr_set` that crossed the cap and the `step_created` that never ran. Five turns over two days read 49,850 / 50,368 / 50,930 / 51,696 / 52,956 against a 50,000 cap. Read those before reasoning about the model.
- **Provider-reported output tokens include reasoning tokens.** Under `reasoning: "high"` an "answer" cap of 50k bounds the READING; the one turn that did return a result stopped at 49,850 having read one transcript of four, which is the other face of issue #104's "receipt named 1 of 4".

A second shape arrives the same way and the first version of this fix got it wrong: a provider error that survives eve's retries goes through `emitRecoverableFailedTurn` — `turn.failed` with a code, then `session.waiting` — so the turn is parked for a human retry and its code is ONLY in the events. Reporting that as "parked on an input request nobody is present to answer (no input request was recorded)" is true and useless; `MODEL_CALL_FAILED after 92 model call(s), 28 of which were cut off at the per-call output limit` is the same event stream read properly.

## What actually catches it

Classify every terminal `status` a harness can hand back, not just the failing one: `"waiting"` with no human on the other end is a failure, and its reason should carry the harness's own numbers (`action.input` on the session-limit request is `{ kind, limit, usedTokens }`). Keep the classifier pure (`parkedTurnReason` in `contract.ts`) so the test tier drives it with the recorded fixture, and order it BEFORE the `data === undefined` arm — the order is the whole guard, since a parked turn also has no data.

Size a budget like the time budget (#99): base plus per-transcript, computed where the batch is known and passed to the agent on the child's environment (`eve start` spreads its env into the built server, and `defineAgent` runs at server boot, so `process.env` there is per-run). A flat cap in `agent.ts` cannot know the batch.

Mutation-verify text-shaped guards: `agent-files.test.ts`'s presence check `toContain("maxOutputTokensPerSession")` passed against the literal that caused the outage; the replacement strips comments and asserts the value is the env read and not a digit.

One more reading habit: `finishReason` on `message.completed` is the cheapest truth about a truncated answer. A run of `"length"` finishes is a per-call ceiling too small for the payload, and it is visible in the stream chunks without a model, a credential, or a rerun.

Related: [[a-timeout-option-that-aborts-what-it-bounds]] (a bound whose name misdescribes what it bounds, and an SDK default that looks configured), [[where-a-filesystem-first-agent-gets-built]] (why the agent is rebuilt per version and where its runtime state lives).
