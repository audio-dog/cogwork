import * as Schema from "effect/Schema";
import { ConnectionId } from "./connection";
import { PollPauseReason } from "./daemon";

export class IssueTrackerError extends Schema.TaggedError<IssueTrackerError>()("IssueTrackerError", {
  reason: PollPauseReason,
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMillis: Schema.optional(Schema.Finite),
  connectionId: Schema.optional(ConnectionId),
}) {}

export const issueTrackerErrorIsPermanent = (error: IssueTrackerError) => error.retryable === false;
