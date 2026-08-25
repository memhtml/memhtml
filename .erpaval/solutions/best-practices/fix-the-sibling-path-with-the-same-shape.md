# A fix lands on the surface the finding named, and leaves its twin

**Category:** best-practices · **Session:** session-27698a · 2026-08-25

A review names one call site. The fix lands there and is correct. The identical construct one function away is untouched, because nobody looked for it — the finding was the search, and the finding was singular.

Five instances in one sprint, each found only by an adversarial pass over work already reported complete:

| Fixed                                                               | Left                                                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundedNumber` guards empty content (`packages/html/src/parse.ts`) | `readDataValue`, same file, bare `Number(raw)` → `<data value="">` stored as `0`                                                                            |
| `<time datetime>` validated against the tightened grammar           | `memhtml-created` / `-updated` / `-valid-from` / `-valid-until` / `-archived` reached the same raw-string SQL columns through `single()` with no validation |
| the eve **start** child's stderr capped at 64 KiB                   | the eve **build** child's `stderr += chunk`, uncapped                                                                                                       |
| `markPromoted` moved to merge time                                  | `markEntityPromoted`, the entity twin, still wrote mid-phase                                                                                                |
| the run-temp-dir sweep scoped to its prefix                         | `memhtml-corpus-snapshot-` mkdtemp parent, leaked on the clean path, no sweep covering it                                                                   |

The tell is grammatical: a finding says "at `X:120`", and a fix that reads only `X:120` cannot see that `X:275` does the same thing to a different field. Two of these were **worse** than the original — the datetime metas are required stamps feeding `ORDER BY coalesce(event_at, updated_at)`, so the inversion the grammar fix existed to remove stayed fully constructible.

The same shape appears one level up, in the fix itself: closing the `</label>` delimiter for the exact tag left `</label >`, `</label\t>` and `</label foo>`, which are the same end tag to an HTML tokenizer.

## What actually catches it

Before closing a finding, grep for the **construct**, not the symptom — the helper name, the SDK option, the write to that table, the regex shape — and enumerate every hit. Then ask which of them the fix reaches. A fix note that says "also checked A, B, C; C is the only other caller" is the artifact; a fix note naming one line is a fix that has not looked.

Cheaper still: put the guard where the construct is, not where the finding was. `boundedNumber` and `readDataValue` now share one emptiness rule; the two spawned children share one stderr module; the five datetime metas route through the one predicate. A shared helper cannot be half-fixed.

See [[cross-phase-contamination-and-vacuous-locks]] for the test-side twin of this, and [[a-stated-invariant-with-no-gate-is-not-an-invariant]] for what happens when the untouched twin is the one a comment claims is covered.
