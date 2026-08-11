import type { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"

import type { InvokeClient } from "../src/client.js"

/**
 * A recording `InvokeClient`. Every test asserts against the bytes that would have gone to
 * Bedrock rather than against a mock's recollection of the call, which is what lets the
 * batch boundaries, `output_dimension`, and the `thinking` key be pinned with no network.
 */
export interface Recorder extends InvokeClient {
  /** One entry per call, in call order: the decoded request body. */
  readonly bodies: ReadonlyArray<Record<string, unknown>>
  readonly modelIds: ReadonlyArray<string>
}

const decode = (command: InvokeModelCommand): Record<string, unknown> => {
  const body = command.input.body
  const text = typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * Build a recorder whose responses come from `reply`, which receives the decoded request
 * and the 0-based call offset so a test can vary the response per call (a short batch, a
 * truncated second response).
 */
export const recorder = (
  reply: (body: Record<string, unknown>, callOffset: number) => unknown
): Recorder => {
  const bodies: Array<Record<string, unknown>> = []
  const modelIds: Array<string> = []
  return {
    bodies,
    modelIds,
    send: (command) => {
      const body = decode(command)
      const offset = bodies.length
      bodies.push(body)
      modelIds.push(command.input.modelId ?? "")
      const payload = reply(body, offset)
      return Promise.resolve({
        body: new TextEncoder().encode(JSON.stringify(payload))
      })
    }
  }
}

/** A client whose every call rejects, for the transport-failure paths. */
export const rejecting = (error: Error): InvokeClient => ({
  send: () => Promise.reject(error)
})

/** A float vector of the given width, deterministic so an assertion can name a value. */
export const vector = (width: number, seed: number): ReadonlyArray<number> =>
  Array.from({ length: width }, (_, index) => (seed + index) / 1000)

/** A well-formed embed response for `count` texts at `width` dimensions. */
export const embedReply = (count: number, width: number) => ({
  id: "probe",
  response_type: "embeddings_by_type",
  embeddings: { float: Array.from({ length: count }, (_, index) => vector(width, index)) }
})
