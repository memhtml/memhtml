# Spec 007 — task detection (issue #44) — rev 2 after adversarial review

Mint task files from evidence the store already sees, not just explicit `task add`. Scope for this PR: surfaces 1 and 2 plus the shared minting discipline, the `--detected` filter, and the doctor quote check. Surface 3 (batched corpus scan) ships later per the issue. Doctor-recurrence minting is deferred with surface 3 (needs night-over-night persistence no current plane provides).

Rev 2 changes (from adversarial review): frame-key dedup REMOVED (value-blind conflict key misused as task identity — false-dedups distinct tasks, and its AC-4-3 closure counterpart can never fire); entity fingerprints are PAIR-based, never cluster-based; close-by-absence additionally gated on `task_status = 'todo'` (a human-touched task is never machine-closed by absence); `universeComplete` defined as zero isolated batch failures AND zero truncation at every cap on the candidate path, enumerated per phase; edge-typing closer specified explicitly (including quote-gone); MINT_CAP bounds new mints only — all findings flow to presentKeys; surface-2 dedup/closure use normalized- token Jaccard, and the consolidator client verifies quote containment against the mounted transcripts; malformed finding key is a warning + null projection, not a parse violation; claim templates are pinned per detector.

## Design decisions

- **Detected tasks are ordinary `memory_type: task` files.** They inherit every exclusion (salience, sleep candidates, retrieval default, dedupe carve-out, edge-class firewall) for free. No new type.
- **Idempotency anchor: head meta `memhtml-finding-key`**, value `<detector>:<digest16>`, digest16 = first 16 hex of sha256 over the detector's canonical fingerprint. Fingerprints use the STABLE unit per detector (pairs, statements — never model-cluster membership):
  - entity-resolution: `entity:<type>\0<nameA>\0<nameB>` (sorted normalized pair)
  - dedup-merge: `dedup:<pathA>\0<pathB>` (sorted)
  - edge-typing: `edge:<src>\0<dst>` (sorted)
  - trace-consolidation: `commit:<normalized statement>` (session id is provenance, NOT identity — the same commitment restated in another session is the same task)
- **Author separation**: minted tasks carry `memhtml-author: agent:sleep` and tag `detected`. `task list --detected` filters `finding_key IS NOT NULL`.
- **Evidence in the task body, verbatim.** File-borne sources quoted via `<q cite="<repo-relative path>">` inside a paragraph (`<blockquote>` is outside the closed vocabulary — discovered at implementation; `<q cite>` is extracted into file_citations by the parser); transcript sources quoted as plain text naming the session id. Doctor verifies file-borne quotes; session-cited quotes are OUT of doctor's coverage (accepted residual, recorded here) — the consolidator client, the one process with transcripts mounted, verifies containment before returning instead.
- **Claim templates pinned** (distinguishing content in the claim, stable wording):
  - `confirm: are «<a>» and «<b>» the same <type>?`
  - `review: <basename(a)> and <basename(b)> are near-duplicates vetoed for divergence`
  - `resolve: <basename(src)> and <basename(dst)> may contradict`
  - `commitment: <statement>`
- **Volume cap**: `MINT_CAP = 10` NEW mints per detector per night, deterministic detector order, overflow counted (`mintOverflow`). Findings beyond the cap still contribute their keys to `presentKeys`, so closure attestation is unaffected by the cap and already-open tasks are never starved or churned.
- **Closure discipline**:
  - Close-by-absence only when (a) the detector attests `universeComplete` — its model pass ran, ZERO batches were isolated-failed, and ZERO truncation occurred at ANY cap on its candidate path (each phase enumerates its caps below) — and (b) the task's `task_status` is still `todo`. Close = stamp done + archive, reason `no longer detected`, staged into the phase commit.
  - entity-resolution caps: ENTITY_BATCH_SIZE assembly, isolate failures.
  - dedup-merge caps: DEDUP_PAIR_LIMIT, DEDUP_MAX_COMPONENTS, packGroups truncation, isolate failures. No-model nights are never universeComplete for detectors that need the model arm.
  - edge-typing: NEVER closes by absence (capped, sampled candidate scan). Instead the phase runs an explicit closer over open `edge-typing:*` tasks (range scan on the finding-key index): close when the corroboration row promoted (reason `promoted to edge`), when either endpoint is archived or missing (reason `endpoint gone`), or when either cited quote no longer exists in its source (reason `evidence gone` — the human edited the contradiction away). Closer is bounded by the open-task count, not the candidate scan.
  - trace-consolidation: resolutions (below) close matching open commitment tasks; no absence closure (sessions are an unbounded universe).
- **Dedup at mint (beyond exact key)**: normalized-token Jaccard >= 0.6 between the candidate claim and each open detected task claim OF THE SAME DETECTOR — a deterministic, cheap restatement guard (catches "I'll update the runbook" vs "I'll update the runbook this week"). Frame-key comparison is explicitly NOT used (value-blind). Embedding dedup deferred with surface 3 (needs a query-embed port in PhaseEnv); residual fuzzy-restatement noise is bounded by MINT_CAP and recorded as a follow-up.
- **No self-referential loops**: tasks are already excluded from every phase's candidate SQL (`SLEEP_EXCLUDED_TYPES`, locked by per-phase tests). Surface 2's commitment gate accepts only user-attributed actors (assistant self-talk is not a human commitment).

## EARS acceptance criteria

### AC-1 foundations

- AC-1-1 [P] (html/contracts) WHEN a memory is rendered with `findingKey`, the system SHALL serialize `<meta name="memhtml-finding-key" content="...">` (META_ORDER after `memhtml-due`), parse it as a single optional string, and round-trip byte-stable. A value failing `^[a-z0-9-]+:[0-9a-f]{16}$` SHALL surface as a vocabulary WARNING and project as null — never a parse violation (a typo'd meta must not make a human's task file vanish from `task list`).
- AC-1-2 [P] (index) WHEN a file carrying a valid `memhtml-finding-key` is projected, the system SHALL populate `files.finding_key` (nullable TEXT, new numbered migration, partial index WHERE archived = 0 AND memory_type = 'task'). Query helpers: open detected tasks by detector prefix (explicit range `key >= '<d>:' AND key < '<d>;'`, never LIKE) returning {path, gist, finding_key, task_status}, and lookup-by-exact-key.

### AC-2 shared minting kernel (packages/sleep/src/mint.ts)

- AC-2-1 WHEN a phase submits `DetectedFinding` {detector, fingerprint, title, claim, bodyHtml, entities?, workspace?, sessionId?}, the kernel SHALL compute the finding key, and IF an open task with that exact key exists OR an open detected task of the same detector has claim Jaccard >= 0.6, skip and count (`taskAlreadyOpen` / `taskDeduped`); ELSE render via renderTemplate (memoryType task, author agent:sleep, tag detected, findingKey, sessionId provenance when given), place via placementFor + freePath probe, write + stage. The kernel never commits.
- AC-2-2 The cap bounds NEW MINTS: the kernel mints the first MINT_CAP non-skipped findings in submission order and counts overflow; ALL submitted findings' keys enter the night's presentKeys regardless of cap.
- AC-2-3 closeAbsent(detector, presentKeys, universeComplete): WHEN universeComplete, the kernel SHALL close (stamp done + archive, staged, counted) every open task whose key has the detector prefix, is not in presentKeys, AND whose task_status = 'todo'; WHEN not universeComplete it SHALL close nothing and count closureSkipped. Same-input re-runs stage nothing.
- AC-2-4 Dry-run aware: counts only, no writes.

### AC-3 sleep phases emit tasks

- AC-3-1 (entity-resolution) Below-floor model clusters SHALL be decomposed to alias→canonical pairs (decomposeCluster); those pairs and undecided review-band pairs mint `confirm:` tasks (pair fingerprints; body carries nameSimilarity, per-name active-file counts, model evidence sentence when present, nearest-centroid cosine when computable). universeComplete = model pass ran AND zero isolated batch failures AND zero assembly truncation.
- AC-3-2 (dedup-merge) Proposed pairs at/above NEAR_DUPLICATE_THRESHOLD that mergeVetoed excludes (re-applied per pair to separate true vetoes from the residual) mint `review:` tasks quoting both divergent texts via blockquote cite=path. universeComplete = model arm ran AND zero isolated failures AND no truncation at DEDUP_PAIR_LIMIT, DEDUP_MAX_COMPONENTS, or packGroups.
- AC-3-3 (edge-typing) Above-floor contradicts verdicts with detections < PROMOTION_DETECTIONS mint `resolve:` tasks (both quotes + verdict rationale). The phase ALSO runs the explicit closer of the design section every night it runs, including no-model nights (the closer is deterministic).
- AC-3-4 Counts vocabulary across all minting phases: taskMinted, taskAlreadyOpen, taskDeduped, mintOverflow, taskClosed, closureSkipped (zero-valued keys omitted). Counts flow to the nightly report unchanged.

### AC-4 trace-consolidation extracts commitments

- AC-4-1 (consolidator contract) ConsolidationPayload SHALL gain `commitments: Array<Commitment>` {statement ≤300, actor: "user"|"assistant", dueHint?, evidence: CandidateEvidence, confidence: Finite 0..1} and `resolutions: Array<Resolution>` {statement ≤300, evidence, confidence}. Both are optional-with-default-[] on the wire (a schema-forced model that omits them decodes clean). The agent instructions SHALL cover both lists: first-person commitments only, never hypotheticals, verbatim quotes. `ungroundedEvidenceReason` SHALL extend to commitment and resolution evidence. The client SHALL additionally verify each commitment/resolution quote appears (whitespace-normalized) in the named session's transcript file and refuse the whole turn on fabrication, mirroring the grounding stance.
- AC-4-2 (sleep post-filter) Mint a `commitment:` task per commitment passing ALL deterministic gates: confidence >= COMMITMENT_FLOOR (0.7), actor === "user", evidence sessionId in the analyzed batch, non-empty quote. Body quotes the evidence naming the session; renderTemplate receives sessionId (memhtml-session provenance). Fingerprint = normalized statement (no session id). Failures counted per gate, never minted.
- AC-4-3 (closure) A resolution passing the same floor SHALL close (done + archive, reason quoting the resolution) every open `commitment:` task whose claim Jaccard vs the resolution statement >= 0.6 AND whose task_status is todo; otherwise nothing. No fuzzy matching below the floor in v1.
- AC-4-4 Commitment minting obeys MINT_CAP and the AC-3-4 counts vocabulary.

### AC-5 CLI + doctor + docs

- AC-5-1 `task list --detected` (boolean FlagSpec) adds `f.finding_key IS NOT NULL`; manifest/AGENTS.md regenerate; usage + behavior covered in CLI tests.
- AC-5-2 (doctor) For every open detected task with `<q cite>` (was blockquote; corrected at implementation — see design decisions), verify the cited path resolves to an active file — or its archived form (chase archive/<YYYY>/<orig>) — whose text contains the quote (whitespace-normalized). Failures land in `staleQuotes:
  ReadonlyArray<StaleQuoteFinding {path, citedPath, state:
  "missing"|"quote-gone"}>` on DoctorReport, report-only, excluded from `healthy` (facts about detected work). Session-cited quotes are explicitly out of coverage.
- AC-5-3 docs/tasks.md + sleep docs describe detection, finding keys, closure discipline, --detected, and the accepted residuals (session quotes unverifiable by doctor; fuzzy restatement noise pending embedding dedup).

### Out of scope (follow-ups in the PR description)

- Surface 3 (batched corpus detection pass) — reuses the batch kernel.
- Doctor-recurrence minting (needs a findings ledger).
- Embedding-based mint dedup (needs a query-embed port in PhaseEnv).
- MCP task tools (existing backlog item 4).
