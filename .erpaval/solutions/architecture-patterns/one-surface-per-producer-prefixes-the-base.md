# A base segment is correct on whichever surface its producer touched

**Category:** architecture-patterns · **Session:** session-046ecf · 2026-08-12

A docs site that serves both rendered HTML and each page's raw Markdown has **two outputs built from
different inputs**, and a path prefix applied by one producer is absent from the other. Every
occurrence of this in `apps/docs` shipped silently, because each surface looked right to whoever built
it.

Four instances, all measured:

- `starlight-base-path` rewrites the **rendered tree**; `starlight-md-txt` builds each raw route from
  the page's **Markdown source**. Authored links were correct in HTML and base-less in 450 raw routes.
- The Reference loader prefixed the base into its own bodies, so the inverse held: its raw routes were
  right and its HTML was `/memhtml/memhtml/reference/…` across 88 pages.
- Rewriting the collection's entry bodies does **not** reach a file-backed page — the raw route
  re-reads it from disk — so only loader-injected pages changed. The fix has to run on the emitted
  output (`astro:build:done`), the one place both kinds of page have converged.
- `astro:build:done` carries `dir`, `routes`, `pages`, `assets` and `logger` and **no `base`**. Read one
  from the hook and the first use throws.

## Treating the base as a bare prefix breaks at the root, in one direction only

`${base}/` is `//` when base is `/`, and `base.length + 1` eats the first character of the path. Three
separate places shipped that arithmetic — a static test server (every page 404'd, so axe audited error
pages), and two assertions. Each was correct against the base it was written for.

**Normalise once and export it.** A `BASE_SEGMENT` carrying a guaranteed trailing slash makes the root
and a path segment the same code. And the analogous defect at the root is not a doubled segment but a
protocol-relative `//path` — a URL naming a *host* — so an assertion has to change shape with the base
rather than go vacuous at one of them.

## Consequences worth keeping

- **Serve at an origin root when you can.** Every consumer of the base becomes a no-op; the bug class
  does not need managing, it stops existing. GitHub serves a root only from `<org>.github.io`, and a
  publisher repo that checks out the public source and builds it needs no credential.
- **A passing link validator is not evidence about the raw surface.**
  `starlight-links-validator` can only judge a target whose headings it recorded in its own remark pass,
  so loader-injected pages are excluded — and that exclusion hid the double-prefix. Assert against the
  bytes in `dist/`.
- **Contradictory reports across surfaces are the signal.** Two agents each reported the other's
  surface broken and their own fine. Neither was wrong.

Related: [[a-wrong-count-reads-as-a-finding]], [[result-identical-but-wrong]].
