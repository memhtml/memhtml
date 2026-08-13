import { ARCS_DIR } from "@memhtml/contracts/paths"
import { slugify } from "@memhtml/contracts/slug"
import { renderTemplate } from "@memhtml/html"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { hrefFor, link, meta, readFileBytes, stampFile, writeFileBytes } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody } from "../env.js"
import {
  ARC_EXECUTE_SYSTEM,
  ARC_TRIAGE_SYSTEM,
  ArcContent,
  ArcPlan,
  arcExecutePrompt,
  arcTriagePrompt,
  isolate
} from "../llm.js"
import { runRetentionPass } from "../retention.js"
import { isSleepExcluded } from "../sql.js"

/**
 * Phase 8, arc synthesis. One triage call plans the night; one execute call writes each actionable
 * arc. ONE COMMIT PER ARC.
 *
 * The two-call split is a cost decision that held up in use. A single call asked to both choose and
 * write produces content for arcs it should have skipped, and the writing is the expensive half. So
 * the triage call sees every live arc plus the recent evidence and returns only a plan, and only the
 * `update`/`create` entries cost a second call.
 *
 * **One commit per arc, not one for the phase.** An arc is a standalone assertion about the agent's
 * own behaviour, and a reviewer reads it as one thing; a commit carrying four unrelated arcs is a
 * commit nobody reviews. It also means a model failure on the third arc leaves the first two
 * committed, so the per-item isolation reaches the git history and not only the counters.
 *
 * **The slug of a new arc is minted here, from the title.** A model-chosen slug is a model-chosen file
 * path, which is a path-traversal surface and a collision surface at once.
 */

/** Memories offered to the triage call as evidence. The most retained, so the arc rests on signal. */
export const ARC_EVIDENCE_LIMIT = 40

/** Characters of each evidence memory shown. An arc is synthesized from claims, not from bodies. */
export const ARC_EVIDENCE_CHARS = 240

/** Characters of an existing arc shown to the execute call. */
export const ARC_CURRENT_CHARS = 3000

export const arcSynthesis: PhaseBody = (env) =>
  Effect.gen(function* () {
    const model = env.deps.model
    if (model === undefined) {
      return { ...emptyOutcome({ arcs: 0, planned: 0, written: 0 }), detail: "no model bound" }
    }

    const pass = yield* runRetentionPass(env.deps.db, env.at)
    const arcs = pass.scored.filter((entry) => entry.row.memory_type === "arc")
    /**
     * Tasks are not evidence. An arc is a claim about how this agent BEHAVES, drawn from what it
     * has learned; a task is what it intends to do next. Offering tasks to the triage call would
     * let an arc be synthesized from intentions instead of outcomes. The phase then stamps
     * `memhtml-part-of` onto each supporting file, which for a task would be a memory-class edge into
     * the graph the task class exists to stay out of.
     */
    const evidence = pass.scored
      .filter((entry) => entry.row.memory_type !== "arc" && !isSleepExcluded(entry.row.memory_type))
      .sort((left, right) => right.score.score - left.score.score)
      .slice(0, ARC_EVIDENCE_LIMIT)

    if (evidence.length === 0) {
      return emptyOutcome({ arcs: arcs.length, planned: 0, written: 0, skipped: 0 })
    }

    /**
     * Evidence is keyed by an OPAQUE ordinal, not by path. The model's `evidenceKeys` come back as
     * whatever it was given, and a path in that field would let a model response name a file the
     * phase then reads. So the key space is one the phase controls and can reject.
     */
    const evidenceKeyed = evidence.map((entry, offset) => ({
      key: `e${offset + 1}`,
      path: entry.row.path,
      text: `${entry.row.gist} ${entry.row.body_text}`.slice(0, ARC_EVIDENCE_CHARS)
    }))
    const pathForKey = new Map(evidenceKeyed.map((entry) => [entry.key, entry.path]))
    const evidenceText = evidenceKeyed.map((entry) => `- [${entry.key}] ${entry.text}`).join("\n")

    /** Live arcs keyed the same way, so the plan's `slug` is likewise an opaque handle. */
    const arcKeyed = arcs.map((entry, offset) => ({
      key: `a${offset + 1}`,
      path: entry.row.path,
      title: entry.row.title,
      outcome: entry.access.outcomeScore
    }))
    const pathForArcKey = new Map(arcKeyed.map((entry) => [entry.key, entry.path]))
    const arcsText =
      arcKeyed.length === 0
        ? "(no arcs yet)"
        : arcKeyed
            .map((entry) => `- [${entry.key}] ${entry.title} (utility=${entry.outcome.toFixed(2)})`)
            .join("\n")

    if (env.dryRun) {
      return emptyOutcome({ arcs: arcs.length, planned: 0, written: 0, skipped: 0 })
    }

    const modelKey = modelFor(env.deps, "arc-synthesis")
    let llmCalls = 1
    const plan = yield* isolate(
      "arc-synthesis triage",
      model.generateObject({
        schema: ArcPlan,
        system: ARC_TRIAGE_SYSTEM,
        prompt: arcTriagePrompt(arcsText, evidenceText),
        modelKey,
        effort: "high",
        toolDescription: "Emit the triage plan: one entry per existing arc, plus any creations."
      })
    )
    if (plan === undefined) {
      return {
        ...emptyOutcome({ arcs: arcs.length, planned: 0, written: 0, skipped: 1 }),
        detail: "triage call produced no plan"
      }
    }

    const actionable = plan.entries.filter(
      (entry) => entry.action === "update" || entry.action === "create"
    )
    let written = 0
    let skipped = plan.entries.length - actionable.length
    let lastCommit: string | null = null

    for (const entry of actionable) {
      const existingPath = pathForArcKey.get(entry.slug)
      if (entry.action === "update" && existingPath === undefined) {
        // An `update` naming an arc the phase did not offer is a model error, not an instruction.
        skipped += 1
        continue
      }
      const title = entry.title.trim()
      if (title === "") {
        skipped += 1
        continue
      }

      const current =
        existingPath === undefined
          ? undefined
          : (yield* readFileBytes(env, existingPath))?.slice(0, ARC_CURRENT_CHARS)

      const supporting = entry.evidenceKeys.flatMap((key) => {
        const found = evidenceKeyed.find((candidate) => candidate.key === key)
        return found === undefined ? [] : [found]
      })
      const supportingText =
        supporting.length === 0
          ? evidenceText
          : supporting.map((one) => `- [${one.key}] ${one.text}`).join("\n")

      llmCalls += 1
      const content = yield* isolate(
        `arc-synthesis execute ${entry.slug === "" ? title : entry.slug}`,
        model.generateObject({
          schema: ArcContent,
          system: ARC_EXECUTE_SYSTEM,
          prompt: arcExecutePrompt({
            title,
            rationale: entry.rationale,
            ...(current === undefined ? {} : { current }),
            evidenceText: supportingText
          }),
          modelKey,
          effort: "high",
          toolDescription: "Emit the arc's title, its one load-bearing claim, and its paragraphs."
        })
      )
      if (content === undefined) {
        skipped += 1
        continue
      }

      const arcPath = existingPath ?? `${ARCS_DIR}/${slugify(content.title || title)}.html`
      /**
       * An arc file is written whole, not stamped. Its BODY is what this phase produces, so the
       * head-editor rule does not apply: there is no bookkeeping edit to keep surgical, and
       * `renderTemplate` stamps a `memhtml-content-hash` computed from the article it just built.
       */
      yield* writeFileBytes(
        env,
        arcPath,
        renderTemplate({
          title: content.title.trim() === "" ? title : content.title.trim(),
          claim: content.claim,
          body: content.paragraphs,
          memoryType: "arc",
          at: env.at,
          author: "agent:sleep"
        })
      )
      yield* env.deps.git.add([arcPath])

      /**
       * Each supporting memory gains `memhtml-part-of` toward the arc. That is what makes an arc
       * traversable back to its evidence after a rebuild. The arc's own file names no paths, so
       * without the inbound links the synthesis would be unattributable.
       */
      for (const one of supporting) {
        const path = pathForKey.get(one.key)
        if (path === undefined || path === arcPath) continue
        yield* stampFile(env, path, [
          link("part_of", hrefFor(arcPath)),
          meta("memhtml-updated", env.at)
        ])
      }

      const commitSha = yield* commitPhase(env, "arc-synthesis", `${entry.action} arc ${title}`, {
        arcs: arcs.length,
        planned: actionable.length,
        written: written + 1,
        skipped
      })
      if (commitSha !== null) lastCommit = commitSha
      written += 1
    }

    const counts = { arcs: arcs.length, planned: actionable.length, written, skipped }
    return { counts, commitSha: lastCommit, llmCalls }
  })
