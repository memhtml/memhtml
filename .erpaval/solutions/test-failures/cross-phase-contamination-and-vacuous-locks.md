# Pipeline tests: the contaminating state is another PHASE's write; locks are vacuous until mutated

**Tags**: testing, mutation, sleep, pipeline, hypothesis, integration
**Modules**: packages/sleep, packages/domain, packages/eval

## The seventh variant of the fleet's recurring mistake

The metarepo lesson says "seed a NEIGHBOUR's rows". In a multi-phase pipeline the neighbour is the
**preceding phase**: conflict-detection's anti-join was blinded by relationship-mining's derived
edges written one phase earlier (`candidates: 0` forever, green suite, phantom arm); archive ops hit
paths an earlier phase already moved (the COMMON case between retention-triage and reprieve);
compress superseded content it hadn't absorbed yet; corroboration double-counted on resume. **A
phase test fixture must include the writes of every phase that runs before it**, not a clean corpus.

## Mutation-verify every lock — the hit rate says why

Across this session's ten tasks, agents ran ~40 deliberate mutations; **about a quarter of locks
were vacuous on first writing** (passed against the reintroduced bug). Recurring causes worth
checking for directly:
- the property bounds the wrong direction (a cap tested from above misses under-disclosure);
- the generator never exercises the guarded region (`fc.string({maxLength: 200})` kebab-folds to
  ~10 chars — a length cap is never hit);
- the fixture sits at a fixed point where guarded and unguarded code agree (decay delta-gate on an
  already-converged value);
- the failure occurs before the mutated code runs (unstage-reset mutated, but nothing was staged).

A gate can also be *doing nothing* rather than *wrong*: T10 wrote a plausible MMR normalization fix,
mutation-tested it, found reverting changed no output, and discovered the fix was a no-op — the
mutation discipline caught a phantom FIX, not just a phantom test.

## Also: measure the eval before trusting it

The discrimination gate's first run scored MRR 0.045 with 22 inversions — five defects in the
*harness* (hash-colliding fixtures, controls that dropped the target's element kit and measured
document length, probes outside the recency window, an empty state plane, punctuation tie-breaks).
An eval that has never failed for a harness reason has probably never been inspected.
