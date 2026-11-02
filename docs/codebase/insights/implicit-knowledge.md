---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Implicit knowledge

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

Reviewers confirmed no implicit assumption, undeclared environment variable, implicit contract or implicit decision in this repository (every candidate was rejected or left unreviewed), so the tree records nothing the code assumes without saying. The analysis measured string literals in telling roles (hosts, ARNs, account ids, regions, absolute paths), swallowed exceptions, environment variable reads and unexplained constants, and scored each candidate by surprise, reach and silence. The candidates reviewers judged had their reasons in a nearby doc comment, a named configuration table or a documented default, so none of them stands as a finding. A doc comment explains the deep-link endpoints (`apps/docs/src/lib/agent-surface.ts:42-52`). A named configuration table holds the Cursor URL (`apps/docs/src/lib/agent-surface.ts:82` `DEEP_LINK_TARGETS`). A documented default covers `DOCS_BASE` (`apps/docs/astro.config.ts:43`, comment at `apps/docs/astro.config.ts:36-41`).
