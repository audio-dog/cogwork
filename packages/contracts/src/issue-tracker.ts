import * as Schema from "effect/Schema";
import { ConnectionId } from "./connection";
import { PollPauseReason } from "./daemon";

export class IssueTrackerError extends Schema.TaggedError<IssueTrackerError>()("IssueTrackerError", {
  reason: PollPauseReason,
  message: Schema.String,
  retryAfterMillis: Schema.optional(Schema.Finite),
  connectionId: Schema.optional(ConnectionId),
}) {}
