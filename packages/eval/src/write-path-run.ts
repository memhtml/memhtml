import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  type FixtureTranscript,
  type LabeledCandidate,
  TRANSCRIPTS,
  WRITE_PATH_CORPUS
} from "./write-path-corpus.js"
import { admitCandidate, type GateBatch, type GateStage } from "./write-path-gate.js"
import {
  describeWritePath,
  type LabeledDecision,
  summarizeWritePath,
  type WritePathReport
} from "./write-path-metrics.js"

/**
 * The write-path discrimination arm: run the labeled corpus through the gate, report, and freeze.
 *
 * The 2026-08-27 plan named no floor for this arm, so the floor is the MEASURED BASELINE MINUS FIVE
 * POINTS, stated as such. Baseline: F1 0.9333 (precision 0.9655, recall 0.9032) on corpus v1 (31 good, 31 bad) at memhtml 0.14.0,
 * measured 2026-09-09 with every decision recorded in the frozen manifest beside this package. A
 * regression that costs the gate more than one and a half items on this corpus fails the tier; a
 * change that moves any single decision fails the replay check regardless of F1, so the floor is the
 * coarse alarm and the manifest is the fine one.
 *
 * Reproducibility. The corpus is static data, the transcripts are static data, and the gate is pure
 * over them apart from re-reading the transcripts it just wrote to a temp directory, so two runs on
 * two machines produce byte-identical decisions. The manifest records the sha256 of both inputs so a
 * drifted decision can be attributed: same hashes and a different decision means the GATE changed;
 * a different hash means the corpus did.
 */

/** The measured baseline this floor was derived from. Recorded so the derivation is checkable. */
export const WRITE_PATH_BASELINE_F1 = 0.9333

/**
 * F1 floor: the baseline minus five points, rounded down to two decimals.
 *
 * Five points and not zero, because the floor is the alarm for a class-sized regression and the
 * manifest is the alarm for a one-item one; a floor pinned at the baseline would fire on every
 * deliberate corpus edit and train the reader to refreeze without looking.
 */
export const WRITE_PATH_F1_FLOOR = Math.floor((WRITE_PATH_BASELINE_F1 - 0.05) * 100) / 100

/** Where the frozen manifest lives, relative to this module (`src/` and `dist/` are siblings). */
export const MANIFEST_URL = new URL(
  "../fixtures/write-path-discrimination.manifest.json",
  import.meta.url
)

export const MANIFEST_SCHEMA_VERSION = 1

/** One frozen decision: enough to detect drift, nothing that needs a transcript to read. */
export interface FrozenDecision {
  readonly id: string
  readonly label: "good" | "bad"
  readonly class: string
  readonly accepted: boolean
  readonly stage: GateStage
}

/** The freeze/replay manifest. */
export interface WritePathManifest {
  readonly schemaVersion: number
  /** The memhtml workspace version the decisions were frozen at. */
  readonly memhtmlVersion: string
  /** When the freeze ran, ISO-8601. Informational; not compared on replay. */
  readonly frozenAt: string
  /** sha256 of the corpus as JSON, so a changed candidate is attributable. */
  readonly corpusSha256: string
  /** sha256 of the two transcripts' JSONL, so a changed fixture line is attributable. */
  readonly transcriptsSha256: string
  /** The stages, in order, and the production functions each one calls. */
  readonly gate: ReadonlyArray<{ readonly stage: GateStage; readonly source: string }>
  readonly f1Floor: number
  readonly metrics: {
    readonly items: number
    readonly precision: number
    readonly recall: number
    readonly f1: number
    readonly accuracy: number
    readonly confusion: WritePathReport["confusion"]
  }
  readonly decisions: ReadonlyArray<FrozenDecision>
}

/** The gate's stage table as the manifest records it. One place, so the manifest cannot drift. */
export const GATE_SOURCES: ReadonlyArray<{ readonly stage: GateStage; readonly source: string }> = [
  {
    stage: "door:schema",
    source:
      "apps/consolidator/src/contract.ts CandidateMemory, decoded with onExcessProperty: error"
  },
  { stage: "door:grounding", source: "apps/consolidator/src/contract.ts ungroundedEvidenceReason" },
  { stage: "door:quote", source: "apps/consolidator/src/client.ts fabricatedQuoteReason" },
  {
    stage: "phase:refusal",
    source: "packages/sleep/src/phases/trace-consolidation.ts candidateRefusalFor"
  }
]

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/** The corpus hash. Plain `JSON.stringify` over static data with a fixed key order. */
export const corpusSha256 = (corpus: ReadonlyArray<LabeledCandidate> = WRITE_PATH_CORPUS): string =>
  sha256(JSON.stringify(corpus))

export const transcriptsSha256 = (
  transcripts: ReadonlyArray<FixtureTranscript> = TRANSCRIPTS
): string => sha256(transcripts.map((one) => `${one.sessionId}\n${one.jsonl}`).join("\n\n"))

/**
 * Write the transcripts into a fresh temp directory and hand back the batch the door reads.
 *
 * `fabricatedQuoteReason` re-reads a cited transcript from its host path, which is the production
 * shape (the phase never holds transcript bytes), so the fixture has to be on disk. Scoped: the
 * directory is removed when the caller's scope closes, on the failure path too.
 */
export const withBatch = <A, E, R>(
  body: (batch: GateBatch) => Effect.Effect<A, E, R>,
  transcripts: ReadonlyArray<FixtureTranscript> = TRANSCRIPTS
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "memhtml-write-path-")))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true }))
      )
      const reachable = []
      for (const transcript of transcripts) {
        const filePath = join(root, `${transcript.sessionId}.jsonl`)
        yield* Effect.promise(() => writeFile(filePath, transcript.jsonl, "utf8"))
        reachable.push({ entry: { sessionId: transcript.sessionId, filePath }, hostPath: filePath })
      }
      return yield* body({ reachable })
    })
  )

/** Run every labeled candidate through the gate, in corpus order. */
export const decideAll = (
  batch: GateBatch,
  corpus: ReadonlyArray<LabeledCandidate> = WRITE_PATH_CORPUS
): Effect.Effect<ReadonlyArray<LabeledDecision>> =>
  Effect.gen(function* () {
    const decisions: Array<LabeledDecision> = []
    for (const item of corpus) {
      const decision = yield* admitCandidate(item.candidate, batch)
      decisions.push({ id: item.id, label: item.label, class: item.class, ...decision })
    }
    return decisions
  })

/** What {@link runWritePathDiscrimination} takes. */
export interface WritePathOptions {
  readonly f1Floor?: number | undefined
  readonly corpus?: ReadonlyArray<LabeledCandidate> | undefined
  readonly transcripts?: ReadonlyArray<FixtureTranscript> | undefined
}

/**
 * Run the arm end to end.
 *
 * Never fails, for the reason `run.ts` gives for the retrieval arm: the report IS the answer and a
 * caller maps `passed` to an exit code or an assertion. A failing report logs one line at error level.
 */
export const runWritePathDiscrimination = (
  options: WritePathOptions = {}
): Effect.Effect<WritePathReport> =>
  Effect.gen(function* () {
    const f1Floor = options.f1Floor ?? WRITE_PATH_F1_FLOOR
    const corpus = options.corpus ?? WRITE_PATH_CORPUS
    const report = yield* withBatch(
      (batch) => decideAll(batch, corpus).pipe(Effect.map((d) => summarizeWritePath(d, f1Floor))),
      options.transcripts ?? TRANSCRIPTS
    )
    if (!report.passed) yield* Effect.logError(`eval write-path: ${describeWritePath(report)}`)
    return report
  })

/** Build the manifest a run would freeze. */
export const manifestFor = (
  report: WritePathReport,
  context: { readonly memhtmlVersion: string; readonly frozenAt: string }
): WritePathManifest => ({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  memhtmlVersion: context.memhtmlVersion,
  frozenAt: context.frozenAt,
  corpusSha256: corpusSha256(),
  transcriptsSha256: transcriptsSha256(),
  gate: GATE_SOURCES,
  f1Floor: report.f1Floor,
  metrics: {
    items: report.items,
    precision: report.precision,
    recall: report.recall,
    f1: report.f1,
    accuracy: report.accuracy,
    confusion: report.confusion
  },
  decisions: report.decisions.map((decision) => ({
    id: decision.id,
    label: decision.label,
    class: decision.class,
    accepted: decision.accepted,
    stage: decision.stage
  }))
})

/** One decision that replayed differently from the frozen one. */
export interface ReplayDrift {
  readonly id: string
  readonly frozen: { readonly accepted: boolean; readonly stage: GateStage } | null
  readonly fresh: { readonly accepted: boolean; readonly stage: GateStage } | null
}

/**
 * Every id whose fresh decision differs from the frozen one, plus ids present on one side only.
 *
 * Per item rather than a hash of the whole list, because a replay that fails has to say WHICH
 * candidate moved and where it now stops; a boolean would send the reader back to run it by hand.
 */
export const replayDrift = (
  frozen: WritePathManifest,
  fresh: WritePathReport
): ReadonlyArray<ReplayDrift> => {
  const was = new Map(frozen.decisions.map((d) => [d.id, d] as const))
  const now = new Map(fresh.decisions.map((d) => [d.id, d] as const))
  const drift: Array<ReplayDrift> = []
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const before = was.get(id)
    const after = now.get(id)
    const same =
      before !== undefined &&
      after !== undefined &&
      before.accepted === after.accepted &&
      before.stage === after.stage
    if (same) continue
    drift.push({
      id,
      frozen: before === undefined ? null : { accepted: before.accepted, stage: before.stage },
      fresh: after === undefined ? null : { accepted: after.accepted, stage: after.stage }
    })
  }
  return drift
}

/** Read the frozen manifest beside this package. */
export const readManifest = (): Effect.Effect<WritePathManifest> =>
  Effect.promise(async () => JSON.parse(await readFile(MANIFEST_URL, "utf8")) as WritePathManifest)

/** Write the frozen manifest beside this package. Only `freeze-write-path.ts` calls this. */
export const writeManifest = (manifest: WritePathManifest): Effect.Effect<void> =>
  Effect.promise(() => writeFile(MANIFEST_URL, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"))
