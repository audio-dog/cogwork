import { LinearError, LinearErrorType, RatelimitedLinearError } from "@linear/sdk";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { IssueTrackerError } from "../issue-tracker";

export const unavailable = (message: string) => new IssueTrackerError({ reason: "unavailable", message });
export const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

export const markWriteMayHaveCommitted = (error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: error.reason,
    message: error.message,
    retryable: error.retryable,
    retryAfterMillis: error.retryAfterMillis,
    connectionId: error.connectionId,
    writeMayHaveCommitted: true,
  });

export const classifyCreateFailure = (error: IssueTrackerError) => {
  const mayHaveCommitted = error.reason === "unavailable" && error.retryable !== false;
  return mayHaveCommitted ? markWriteMayHaveCommitted(error) : error;
};

const isAuthStatus = (status: number | undefined) => status === 401 || status === 403;
const transientErrorTypes = new Set([
  LinearErrorType.NetworkError,
  LinearErrorType.InternalError,
  LinearErrorType.LockTimeout,
]);

const reasonFor = (cause: unknown): IssueTrackerError["reason"] => {
  if (cause instanceof RatelimitedLinearError) return "rate-limited";
  if (
    cause instanceof LinearError &&
    (isAuthStatus(cause.status) || cause.type === LinearErrorType.AuthenticationError)
  ) {
    return "auth";
  }
  return "unavailable";
};

const isTransportCause = (cause: LinearError) =>
  cause.type === LinearErrorType.Unknown && cause.raw instanceof TypeError;

const permanentErrorTypes = new Set([LinearErrorType.Forbidden, LinearErrorType.FeatureNotAccessible]);

const isPermanentCause = (cause: unknown) =>
  cause instanceof LinearError && cause.type !== undefined && permanentErrorTypes.has(cause.type);

const isTransientCause = (cause: unknown) =>
  cause instanceof LinearError &&
  (isTransportCause(cause) || (cause.type !== undefined && transientErrorTypes.has(cause.type)));

const finiteOrNull = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : null;

const retryAfterMillisOf = (cause: unknown, nowMillis: number) => {
  if (!(cause instanceof RatelimitedLinearError)) return undefined;
  const retryAfterSeconds = finiteOrNull(cause.retryAfter);
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  const resetAtMillis = finiteOrNull(cause.requestsResetAt);
  return resetAtMillis === null ? undefined : Math.max(0, resetAtMillis - nowMillis);
};

// Reason stays `unavailable` for a permanent refusal on purpose: `auth` makes the credential store
// invalidate a token that is working.
const fromSdkError = (cause: unknown, nowMillis: number) =>
  new IssueTrackerError({
    reason: reasonFor(cause),
    message: cause instanceof Error ? cause.message : String(cause),
    ...(isPermanentCause(cause) ? { retryable: false } : {}),
    retryAfterMillis: retryAfterMillisOf(cause, nowMillis),
  });

class LinearRequestFailure extends Data.TaggedError("LinearRequestFailure")<{
  readonly error: IssueTrackerError;
  readonly retryable: boolean;
}> {}

export const fromSdkFailure = (cause: unknown, nowMillis: number) =>
  new LinearRequestFailure({ error: fromSdkError(cause, nowMillis), retryable: isTransientCause(cause) });

export const nonRetryableFailure = (error: IssueTrackerError) =>
  new LinearRequestFailure({ error, retryable: false });

export const isoMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

export const isTransient = (failure: LinearRequestFailure) => failure.retryable;
export const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);
const transientAttemptDeadline = "30 seconds";
const paginationDeadline = "5 minutes";

export const withTransientAttemptDeadline = <A, R>(attempt: Effect.Effect<A, LinearRequestFailure, R>) =>
  attempt.pipe(
    Effect.timeout(transientAttemptDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new LinearRequestFailure({
          error: new IssueTrackerError({
            reason: "unavailable",
            message: `Linear request timed out after ${transientAttemptDeadline}`,
            retryable: true,
          }),
          retryable: true,
        }),
      ),
    ),
  );

export const withPaginationDeadline = <A, R>(
  kind: string,
  operation: Effect.Effect<A, IssueTrackerError, R>,
) =>
  operation.pipe(
    Effect.timeout(paginationDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(unavailable(`Linear ${kind} pagination timed out after ${paginationDeadline}`)),
    ),
  );
