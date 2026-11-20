import * as Schema from "effect/Schema";

import { ConnectionId } from "./connection";
import { PollPauseReason } from "./daemon";

export class IssueTrackerError extends Schema.TaggedError<IssueTrackerError>()("IssueTrackerError", {
  reason: PollPauseReason,
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMillis: Schema.optional(Schema.Finite),
  connectionId: Schema.optional(ConnectionId),
  writeMayHaveCommitted: Schema.optional(Schema.Boolean),
}) {}

// A rate limit and a rejected credential are both `retryable: false` — do not retry *now* — yet both
// clear on their own. Only an `unavailable` refusal is the tracker declining the write itself.
export const issueTrackerErrorIsPermanent = (error: IssueTrackerError) =>
  error.retryable === false && error.reason === "unavailable";
