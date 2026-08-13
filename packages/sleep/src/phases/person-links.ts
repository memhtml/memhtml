import { PEOPLE_DIR } from "@memhtml/contracts/paths"
import { slugify } from "@memhtml/contracts/slug"
import { PERSON_ENTITY_PREFIX } from "@memhtml/contracts/types"
import { renderTemplate } from "@memhtml/html"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { hrefFor, link, meta, readFileBytes, stampFile, writeFileBytes } from "../edits.js"
import { emptyOutcome, type PhaseBody } from "../env.js"
import { activeEntities, pathsForEntity } from "../sql.js"

/**
 * Phase 4, person links. Every `person:*` entity gets a file under `resources/people/`, and every
 * memory claiming that person gains a `memhtml-about-person` link. ONE commit.
 *
 * Runs immediately after entity resolution, so it keys on names that have already normalized and
 * fuzzy-merged: `Sanju`, `sanju`, and `sanju ` are one person by the time this phase sees them, and
 * running it first would mint three person files and split one person's memories across them.
 *
 * The person file is created only when it is absent, and its content stays as written. It is a
 * durable identity surface an agent (or a human) edits by hand, and regenerating it every night would
 * silently discard anything written there. A person file that already exists is only ever linked
 * TO, never rewritten.
 */
export const personLinks: PhaseBody = (env) =>
  Effect.gen(function* () {
    const entities = yield* activeEntities(env.deps.db)
    const people = entities.filter(
      (entity) => entity.entity_type === "person" && entity.entity_name.trim() !== ""
    )
    if (people.length === 0) {
      return emptyOutcome({ people: 0, filesCreated: 0, linksAdded: 0 })
    }

    /** `person:<name>` -> the file that represents them. Slugified, so the path is a valid one. */
    const pathFor = (name: string): string => `${PEOPLE_DIR}/${slugify(name)}.html`

    let created = 0
    let linked = 0
    let dryLinks = 0

    for (const person of people) {
      const personPath = pathFor(person.entity_name)
      const claimants = yield* pathsForEntity(env.deps.db, "person", person.entity_name)
      const targets = claimants.filter((row) => row.path !== personPath)

      const existing = yield* readFileBytes(env, personPath)
      if (env.dryRun) {
        if (existing === undefined) created += 1
        dryLinks += targets.length
        continue
      }

      if (existing === undefined) {
        /**
         * A minimal person file, `semantic` and `person:<name>`-tagged so `placementFor` would put
         * it exactly here. The path and the metadata agree, which is what keeps a later rebuild
         * from re-placing it.
         */
        yield* writeFileBytes(
          env,
          personPath,
          renderTemplate({
            title: person.entity_name,
            claim: `${person.entity_name} appears in this agent's memory.`,
            memoryType: "semantic",
            at: env.at,
            author: "agent:sleep",
            entities: [`${PERSON_ENTITY_PREFIX}${person.entity_name}`]
          })
        )
        yield* env.deps.git.add([personPath])
        created += 1
      }

      for (const target of targets) {
        /**
         * `addLink` is idempotent on the `(rel, href)` pair, so a night that already linked this
         * memory writes nothing and stages nothing. That keeps this phase's commit empty on an
         * unchanged corpus, and an empty commit is never made.
         */
        const changed = yield* stampFile(env, target.path, [
          link("about_person", hrefFor(personPath)),
          meta("memhtml-updated", env.at)
        ])
        if (changed) linked += 1
      }
    }

    const counts = {
      people: people.length,
      filesCreated: created,
      linksAdded: env.dryRun ? dryLinks : linked
    }
    if (env.dryRun || (created === 0 && linked === 0)) return emptyOutcome(counts)

    const commitSha = yield* commitPhase(
      env,
      "person-links",
      `link ${linked} memories to ${people.length} people`,
      counts
    )
    return { counts, commitSha, llmCalls: 0 }
  })
