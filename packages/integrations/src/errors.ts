import { Schema } from "effect"

/**
 * A receipt-owned file or entry no longer matches its receipt. Install refuses without `--force`, and
 * uninstall refuses always, so a human's edit to a config file survives both. `path` is the managed
 * file, `detail` names what differs (a hash, a missing entry, an unmanaged sibling entry).
 */
export class IntegrationModified extends Schema.TaggedError<IntegrationModified>()(
  "IntegrationModified",
  {
    host: Schema.String,
    path: Schema.String,
    detail: Schema.String
  }
) {}
