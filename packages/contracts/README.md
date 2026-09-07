`@memhtml/contracts`: schemas, enums, errors, and path algebra. Zero I/O.

This is the innermost workspace package: it imports only `effect`, and every other package imports it. It holds the words the rest of the system agrees on. The closed vocabularies say what a memory can be. The path algebra says where one lives in the tree. The edge model says how one memory points at another. The slug rules say how a title becomes a filename. The tagged errors say how an operation can fail.

## Modules

Each module is its own import path, and the package root re-exports all five. The pages beside this one are generated from the TSDoc in the source, one page per module.

| Import path                 | What it holds                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@memhtml/contracts/edges`  | The edge vocabulary and the `Edge` schema. Four edge classes that never mix, so a person or task edge stays out of PageRank, MMR, and the retention bridge count. |
| `@memhtml/contracts/errors` | The tagged errors every operation can fail with, each carrying only what a caller needs to recover and nothing that leaks corpus content.                         |
| `@memhtml/contracts/paths`  | Path algebra. Every function is pure and total, and a path is always the repo-root-relative git-tree form: no leading slash, forward slashes only.                |
| `@memhtml/contracts/slug`   | Slugs and filenames: how a title becomes `[a-z0-9-]`, how an episodic entry carries its date, and how a collision gets a suffix.                                  |
| `@memhtml/contracts/types`  | The closed vocabularies (memory type, status, PARA bucket, task status), the `type:name` entity reference, and the scalar schemas for importance and confidence.  |

## Where else this is documented

The Reference tier's [contracts page](https://memhtml.github.io/reference/contracts/) lists every exported symbol with its doc comment, derived from the same source at build time. The [closed vocabularies page](https://memhtml.github.io/reference/vocabulary/) lists each vocabulary's values.
