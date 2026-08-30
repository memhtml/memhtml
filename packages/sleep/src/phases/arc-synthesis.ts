import { ARCS_DIR } from "@memhtml/contracts/paths"
import { slugify } from "@memhtml/contracts/slug"
import { escapeText, renderTemplate } from "@memhtml/html"
import { Effect } from "effect"

import { isolate } from "../batch.js"
import { commitPhase } from "../commit.js"
import { hrefFor, link, meta, readFileBytes, stampFile, writeFileBytes } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody } from "../env.js"
import { freePathIn } from "../free-path.js"
import {
  ARC_EXECUTE_SYSTEM,
  ARC_TRIAGE_SYSTEM,
  ArcContent,
  ArcPlan,
  arcExecutePrompt,
  arcTriagePrompt
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
 * own behavior, and a reviewer reads it as one thing; a commit carrying four unrelated arcs is a
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

    /** The live arcs by path, so a colliding `create` can be recognized as an update in disguise. */
    const offeredArcPaths = new Set(pathForArcKey.values())
    /**
     * Every arc path this RUN has written. Two `create` entries in one plan can carry titles that
     * slug to one path, and the second whole-file write would silently replace the first — a
     * collision the disk probe alone cannot refuse before the first write has landed.
     */
    const claimedArcPaths = new Set<string>()

    for (const entry of actionable) {
      const namedArcPath = pathForArcKey.get(entry.slug)
      if (entry.action === "update" && namedArcPath === undefined) {
        // An `update` naming an arc the phase did not offer is a model error, not an instruction.
        skipped += 1
        continue
      }
      const title = entry.title.trim()
      if (title === "") {
        skipped += 1
        continue
      }

      /**
       * A `create` whose title slugs onto a LIVE arc the triage call was offered is an UPDATE of
       * that arc, whatever the plan called it. An arc file is written whole (see below), so taking
       * the model's `create` at its word would replace the existing arc's entire content with a
       * synthesis that never read it. Folding the entry onto the existing path hands the execute
       * call the current content, whose prompt then preserves what still holds.
       */
      const plannedCreatePath = `${ARCS_DIR}/${slugify(title)}.html`
      const existingPath =
        namedArcPath ??
        (offeredArcPaths.has(plannedCreatePath) && !claimedArcPaths.has(plannedCreatePath)
          ? plannedCreatePath
          : undefined)

      /**
       * The FULL existing file is read once; the model sees only the head. The head is where
       * a tiered arc keeps its claim and summary, so `ARC_CURRENT_CHARS` covers what the model
       * needs to preserve — but the file is written WHOLE below, so everything past the slice
       * would silently vanish on every update. `existingRaw` is held so the write site can carry
       * the arc's `<details>` folds forward verbatim (the grounding recall never quotes and the
       * model was never shown).
       */
      const existingRaw =
        existingPath === undefined ? undefined : yield* readFileBytes(env, existingPath)
      const current = existingRaw?.slice(0, ARC_CURRENT_CHARS)

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

      /**
       * A genuine create's path is PROBED, never assumed free. The slug comes from the model's own
       * title, so it can land on a file the phase was never offered — an arc a human demoted out of
       * the index, a non-arc file, another create this run already wrote — and an unprobed
       * whole-file write would replace it silently. A taken path gets a collision ordinal; an
       * exhausted probe skips the arc, because every member of the plan is still live either way.
       */
      const arcPath =
        existingPath ??
        (yield* freePathIn(env, ARCS_DIR, slugify(content.title.trim() || title), claimedArcPaths))
      if (arcPath === undefined) {
        skipped += 1
        yield* Effect.logWarning(
          `sleep.llm arc-synthesis skipped ${title}: every collision ordinal for its slug is taken`
        )
        continue
      }
      claimedArcPaths.add(arcPath)
      /**
       * An arc file is written whole, not stamped. Its BODY is what this phase produces, so the
       * head-editor rule does not apply: there is no bookkeeping edit to keep surgical, and
       * `renderTemplate` stamps a `memhtml-content-hash` computed from the article it just built.
       *
       * The article is TIERED, not flat. An arc is read two ways with very different budgets:
       * `recall` quotes `disclosure_text` (Tier 1 + Tier 2) under `ARC_BODY_BUDGET`, and
       * `memory_read` returns everything. A flat arc makes its whole body Tier 1, so a handful of
       * grown arcs exhaust the recall envelope and every other arc degrades to an index line.
       * So the claim stands alone as the `<mark>` paragraph, the model's summary headlines one
       * `<details>` fold, and the paragraphs live inside it — an arc can grow without inflating
       * what recall pays. The markup path is used because the `claim`/`body` prose path has no
       * fold vocabulary.
       */
      const foldedParagraphs = content.paragraphs
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== "")
        .map((paragraph) => `<p>${escapeText(paragraph)}</p>`)
        .join("\n")
      const summaryLine =
        (content.summary ?? "").trim() === "" ? "Elaboration" : (content.summary ?? "").trim()
      /**
       * An update CARRIES THE EXISTING FOLDS FORWARD verbatim. The model saw only the file's
       * head, so its output cannot restate what lived behind the folds — incident grounding,
       * merged generation-1 lineage — and a whole-file write without this block deletes that
       * material on every update (observed: the 2026-08-30 run stripped the grounding folds
       * from ten arcs). Folds ride below the fresh one, oldest last; Tier 3 is free at recall,
       * so accumulation costs a reader nothing until a deliberate re-draft consolidates it.
       */
      const carriedFolds =
        existingRaw === undefined ? [] : (existingRaw.match(/<details>[\s\S]*?<\/details>/g) ?? [])
      const articleParts = [
        `<p><mark>${escapeText(content.claim.trim())}</mark></p>`,
        ...(foldedParagraphs === ""
          ? []
          : [
              `<details>\n<summary>${escapeText(summaryLine)}</summary>\n${foldedParagraphs}\n</details>`
            ]),
        ...carriedFolds
      ]
      const articleHtml = articleParts.join("\n")
      yield* writeFileBytes(
        env,
        arcPath,
        renderTemplate({
          title: content.title.trim() === "" ? title : content.title.trim(),
          claim: content.claim,
          articleHtml,
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
