# Verify quotes against the projection the verifier reads

**Category:** test-failures **Session:** session-1887c1 (task detection, PR #47) **Tags:** citations, doctor, body-text, jsonl, containment, evidence

Two independent instances of one failure shape in a single session: a verbatim quote was cut from (or checked against) a REPRESENTATION the verifier never reads, so every honest quote failed containment.

1. **Producer side:** dedup-merge and edge-typing first quoted from the model-facing text join (`gist + "\n" + body_text`, where body_text already opens with the gist). The quote read `<gist> <gist> <body>` and was a substring of NO file — every minted task reported `quote-gone` in doctor's stale-quote check the night it was written. Fix: cut quotes from `files.body_text`, the projection doctor's containment searches. Invisible without an explicit per-citation assertion (`cited.article.bodyText contains citation.text`).

2. **Checker side:** the consolidator client compared rendered quotes against RAW JSONL bytes, where `"` is stored `\"` and an internal newline is literal `\n` — an honest quote refused the whole turn, the batch never watermarked, and the same sessions re-selected nightly (a livelock). Fix: accept a match against raw bytes OR any single JSON-decoded string; strings tested individually so a quote stitched across two messages still refuses.

**Rule:** whoever writes a quote and whoever verifies it must read the SAME projection; name that projection in a comment at both sites, and pin with a containment test whose fixture text includes a double quote and a newline.
