import { createHash } from "node:crypto"
import type { MemoryRecord } from "@memhtml/contracts"
import type { InvalidMemory } from "@memhtml/contracts/errors"
import { ARCHIVE_BUCKET } from "@memhtml/contracts/paths"
import { frameKeyOf } from "@memhtml/domain"
import { contentHash, parseMemory } from "@memhtml/html"
import { Effect } from "effect"

/**
 * One file becomes one `MemoryRecord`.
 *
 * The record is the flat projection every v2 index derives from, so this is the only place a
 * memory file is parsed on the head's read path. `parseMemory` owns every format rule; this module
 * adds the two hashes and the archive flag and copies the rest across field by field, so a
 * `MemoryRecord` never carries a value the parser did not produce.
 */

/**
 * The git blob sha of `html`: sha1 over `"blob <byteLength>\0"` followed by the UTF-8 bytes.
 *
 * Computed locally rather than asked of git, because a session's overlay holds files git has not
 * seen yet and their records need the sha a later `hash-object -w` will produce. The byte length
 * is the UTF-8 length and not `html.length`, which is what makes multibyte content agree with git.
 */
export const blobShaOf = (html: string): string => {
  const bytes = Buffer.from(html, "utf8")
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
}

/** True when `path` sits under the archive bucket, which is what `archived` means on a record. */
export const isArchivedPath = (path: string): boolean => path.startsWith(`${ARCHIVE_BUCKET}/`)

/** Parse one file into its record. Fails with the parser's own `InvalidMemory`. */
export const recordFrom = (input: {
  readonly path: string
  readonly html: string
}): Effect.Effect<MemoryRecord, InvalidMemory> =>
  parseMemory(input.html).pipe(
    Effect.map(
      (doc): MemoryRecord => ({
        path: input.path,
        blobSha: blobShaOf(input.html),
        contentHash: contentHash(doc),
        frameKey: frameKeyOf(doc.article.gist),
        title: doc.title,
        memoryType: doc.metas.memoryType,
        status: doc.metas.status,
        claim: doc.article.gist,
        createdAt: doc.metas.createdAt,
        updatedAt: doc.metas.updatedAt,
        eventAt: doc.article.eventAt ?? null,
        confidence: doc.metas.confidence ?? null,
        importance: doc.metas.importance ?? null,
        tags: doc.tags,
        entities: doc.entities,
        links: doc.links.map((link) => ({ rel: link.rel, href: link.href })),
        facets: doc.article.facets.map((facet) => ({ name: facet.name, value: facet.value })),
        bodyText: doc.article.bodyText,
        html: input.html,
        archived: isArchivedPath(input.path)
      })
    )
  )
