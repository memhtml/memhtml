# Dedup heuristics must know the claim genre

**Category:** architecture-patterns **Session:** session-1887c1 (task detection, PR #47) **Tags:** dedup, jaccard, templates, mint, sleep, tasks

A token-overlap restatement guard (claim Jaccard >= 0.6) is correct for FREE-TEXT claims ("I'll update the runbook" vs "I'll update the runbook this week", 0.714) and wrong-by-construction for TEMPLATED claims: two entity `confirm:` pairs sharing a canonical differ in one slot token and score 0.778-0.900; three mutually-vetoed dedup `review:` claims scored 0.8462/0.9231/0.9231. Under a template, distinct fingerprints ARE distinct work items; a universal Jaccard arm silently collapses them with `taskDeduped` as the only trace.

**Mechanism:** the arm moved behind `MinterOptions.restatementDedup` (packages/sleep/src/mint.ts): trace-consolidation opts in, the three pair detectors stay out. The detector knows which kind of claim it writes.

**Testing corollary:** the opt-in flag was unobservable until a fixture existed with

> = 2 distinct findings sharing a file — without it, `{ restatementDedup: true }` survives as a mutation. A dedup-behavior test needs a corpus where the wrong setting changes the mint count.
