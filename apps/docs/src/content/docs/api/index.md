---
title: API
description: The generated reference for the workspace packages, one directory per package and one page per module, built from the TSDoc in the source on every site build.
---

Every page below this one is generated from the TSDoc on a package's exported surface; this index is the tier's one authored page. The generated pages are not committed: `starlight-typedoc` writes them into `api/<package>/` on every `astro check` and `astro build`, those directories are gitignored, and so a page always describes the source at the commit the site was built from. When a signature on a page and a signature in the source disagree, the source is newer and the site is behind.

## What is covered

| Package              | Pages                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@memhtml/contracts` | [Overview](/api/contracts/) and one page per import path: [edges](/api/contracts/edges/), [errors](/api/contracts/errors/), [paths](/api/contracts/paths/), [slug](/api/contracts/slug/), [types](/api/contracts/types/). |
| `@memhtml/traces`    | [One page](/api/traces/), because the package publishes a single import path.                                                                                                                                             |
| `@memhtml/eval`      | [One page](/api/eval/): the corpus generator and the discrimination gate, one import path.                                                                                                                                |
| `@memhtml/domain`    | [One page](/api/domain/): the pure arithmetic of retention, decay, fusion, diversification, merge guards and graph scores, one import path.                                                                               |

Each package's overview page is its `README.md` from the repository, with the module list appended by the generator. The remaining workspace packages are added one per maintenance run, smallest exported surface first, once their generated pages pass the same gates as the authored ones.

## How to read a page

Every declaration is rendered as a fenced code block in the shape TypeScript would print it, followed by the doc comment from the source. Parameters are listed one per line rather than in a table, so an object-literal type keeps its braces inside a code span. "Defined in" lines are omitted on purpose: the module a symbol belongs to is the page it sits on, and the [Reference](/reference/contracts/) tier names each symbol's file.

The generator excludes external symbols, so a type that comes from `effect` is named but not expanded. Follow the import path shown at the top of the page to read it in its own package.

## Adding a package

Each package is its own `starlightTypeDoc` plugin instance in `apps/docs/astro.config.ts`, writing to its own directory under `api/`. The plugin refuses two instances whose output directories nest or overlap, which is why the tier is one directory per package rather than one flat directory. The comment block above the first instance records every option and the reason it is set.
