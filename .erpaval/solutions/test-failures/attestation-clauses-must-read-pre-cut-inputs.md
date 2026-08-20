# Attestation clauses must read pre-cut inputs

**Category:** test-failures **Session:** session-1887c1 (task detection, PR #47) **Tags:** attestation, truncation, caps, sleep, close-by-absence, vacuous-locks

A completeness attestation ("no truncation occurred, so absence of a finding is evidence") is structurally vacuous when its clause inspects the OUTPUT of the cut it guards: `packGroups` slices oversized groups before returning, so `batches.some(group => group.length > cap)` is false even when slicing occurred. The tripwire could never fire, and the failure it guards is archive-the-backlog: closure runs on a night whose candidate set was silently cut.

**Rule:** every truncation clause reads the PRE-cut input of its own cap (component lengths before packing, mined-pair count before LIMIT), with the comparison exact: truncation happened when input EXCEEDS the cap, not equals it (`>=` on a post-cut length permanently withholds closure for exactly-at-cap corpora — safe direction, still wrong). Pin each clause with a corpus that actually trips its cap and assert the attestation flips false; the mutation "inspect post-cut output" must fail that test.

Related: the entity-resolution attestation had the dual bug — stated over NAMES it counted coverage a singleton type can never have (minMembers drops its shard), making the attestation permanently false; stated over PAIRS a singleton contributes zero. The unit of the attestation must be the unit the detector actually asks about.
