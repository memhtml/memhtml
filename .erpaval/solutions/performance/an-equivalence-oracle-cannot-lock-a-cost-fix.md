# An equivalence oracle cannot lock a cost fix — on revert it becomes the subject

**Category:** performance · **Session:** session-27698a · 2026-08-25

`applyMmr` was changed from recomputing the max similarity to the selected set per candidate per round, O(k²n), to a per-candidate running max, O(kn) — measured 4,621,650 cosine calls down to 94,050 at n=1000/k=100.

It was tested the obvious way: a property test comparing the optimised selection order against an inline `naiveMmr` oracle over random inputs, 1000 runs. That test is genuinely good — mutating the cache bookkeeping three different ways (dropping the splice, overwriting instead of max-ing, folding the wrong selection) each fails it.

**Reinstating the exact pre-fix fold passes all 24 cases.** Because the oracle _is_ the from-scratch algorithm, reverting the subject makes the two identical and the equivalence holds trivially. So nothing in the suite failed on the behaviour the fix existed to remove, and a later refactor could reintroduce 4.6M dot products silently.

The general form: **a test that pins correctness by comparing against a reference implementation cannot also pin the cost of not being the reference implementation.** The two claims need two tests.

## What actually catches it

Count the operation, not the output. Wrap the hot call, assert the count scales like `k·n` rather than `k²·n`, and prefer a _ratio_ across two pool sizes over an absolute number so the assertion survives a fixture change. Against the from-scratch fold this fails by 9x on the budget and 18x on the growth ratio — 73,530 calls against a budget of 8,000, growth 3.96 against a bound of 2.5.

Then check the counter can count. An upper-bound assertion passes vacuously at zero, and inlining the dot product so `cosine` is never imported does exactly that — so the census asserts the probe observed _something_ and fails with "the cosine probe counted nothing". Without that, the cost lock is one refactor away from being decorative.

`EXPLAIN QUERY PLAN` is the SQL form of the same discipline, and it caught a comment that was simply false: a `LIMIT` was described as bounding a join's work, while the plan shows `MERGE (UNION ALL)` with a temp b-tree sort per arm, so the whole quadratic row set is enumerated and sorted _before_ the limit applies. The rows come back either way. Lock the plan shape, and state in the comment what is bounded and what is not.

Related: [[profile-before-fixing-named-suspects]] for choosing the target, [[nxn-through-a-per-call-boundary]] for the shape this fix removes, and [[cross-phase-contamination-and-vacuous-locks]] for the general rule that a lock nobody reverted is a guess.
