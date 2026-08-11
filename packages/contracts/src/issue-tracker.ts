import * as Schema from "effect/Schema";
import { PollPauseReason } from "./daemon";

export class IssueTrackerError extends Schema.TaggedErrorClass<IssueTrackerError>()("IssueTrackerError", {
  reason: PollPauseReason,
  message: Schema.String,
  retryAfterMillis: Schema.optional(Schema.Finite),
}) {}
