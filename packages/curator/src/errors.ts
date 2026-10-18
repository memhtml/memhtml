import { Schema } from "effect"

/**
 * A `--model` spec the factory cannot build: an unknown prefix, a blank id, or `proxy:` with no
 * `MEMHTML_LLM_BASE_URL` to send it to. `Schema.TaggedError` supplies `_tag`, so the fields do not.
 */
export class CuratorModelSpecInvalid extends Schema.TaggedError<CuratorModelSpecInvalid>()(
  "CuratorModelSpecInvalid",
  {
    spec: Schema.String,
    reason: Schema.String
  }
) {}
