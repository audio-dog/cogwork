import * as Cause from "effect/Cause";

const fallback = "The daemon request failed. Check the daemon log for details.";

export const daemonFailureMessage = (cause: Cause.Cause<unknown>) => {
  const squashed = Cause.squash(cause);
  const hasMessageProperty = typeof squashed === "object" && squashed !== null && "message" in squashed;
  const message = hasMessageProperty ? squashed.message : null;
  const hasUsableMessage = typeof message === "string" && message.length > 0;
  return hasUsableMessage ? message : fallback;
};
