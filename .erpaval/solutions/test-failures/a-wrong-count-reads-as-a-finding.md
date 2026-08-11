# A wrong count reads as a finding about the data, so census probes assert against a known total

**Tags**: probe-discipline, census, ground-truth, selectors, normalization, code-mode, quickjs
**Modules**: docs/code-mode.md, apps/cli (memhtml exec), packages/eval fixtures

## The two failures, both from one spike

Probing code-mode over a generated 305-file corpus, two numbers came back wrong, and neither looked
like a bug:

| Reported | Looked like | Actually was |
|---|---|---|
| `0/410 edges resolved` | "the corpus has no resolvable edges" | edge `href`s are root-absolute (`/areas/x.html`) while a directory walk yields corpus-relative keys — a normalization bug in the probe |
| `withClaim: 0` | "these memories carry no claims" | the selector was `article > mark`, taken from ROADMAP item 7's own prose; the real markup is `<article><p><mark>`, so the claim is a DESCENDANT and `article > mark` matches nothing |

Both were caught only by checking ground truth **outside** the sandbox — `test -f` on the edge
targets, and `grep -l '<mark>' | wc -l` for the claims. Neither would have been caught by reading the
probe, because the probe was internally consistent and the number it printed was a plausible fact
about a generated corpus.

## Why this failure mode is specific to census work

A crashing probe announces itself. A **counting** probe returns a number in the shape the caller
expected, and a zero is indistinguishable from a real absence. `withClaim: 0` was only suspicious
because it sat next to `edges: 410` — one wrong count beside correct ones. Had the selector bug and
the normalization bug landed together, every number would have been zero and the conclusion would
have been "the corpus is empty", which is a coherent story that no amount of re-reading the probe
disproves.

## The rule

**Assert against an independently-derived total; never report a count.** `410/410 resolved` is a
guard. `201 chains found` is a log line that cannot fail. The total has to come from outside the
system under test — a shell `grep | wc -l`, the fixture generator's own manifest, a `test -f` sweep —
because a total computed by the same broken code agrees with itself.

Corollary for the selector class specifically: a selector copied from prose is unverified input.
`article > mark` was in ROADMAP item 7's description, `docs/code-mode.md`, and `README.md`, so three
documents agreed on a selector that matches nothing. Agreement among documents is not evidence; the
markup is.

## Related

[[turso-second-opener-and-the-readonly-flag]] and
[[sandbox-egress-is-set-by-the-constructor]] are the same discipline in a different register: there
the probe ran, printed output, and measured the wrong boundary. Here the probe ran, printed output,
and measured the wrong thing about the right boundary. In both cases the output's existence was
mistaken for its validity.
