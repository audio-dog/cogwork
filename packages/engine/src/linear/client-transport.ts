import { LinearClient as LinearSdk, parseLinearError } from "@linear/sdk";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

import type { Credential, CredentialAccount, CredentialStoreService } from "../credential-store";
import { defaultTrackerCooldown, IssueTrackerError } from "../issue-tracker";
import {
  fromSdkFailure,
  isoMillis,
  isTransient,
  nonRetryableFailure,
  transientBackoff,
  unavailable,
  withTransientAttemptDeadline,
} from "./client-errors";

export interface LinearTeamRef {
  readonly team: string;
  // The whole workspace reads through one Linear credential, so every team ref carries the same
  // account; the team key alone routes writes, decoupled from which credential fetches them.
  readonly account: CredentialAccount;
}

// Linear's request budget is per user and shared across every key that user owns, so every workspace
// reading through the same token has to back off together.
export const rateLimitScopeOf = (tokenEnv: string) => `linear:${tokenEnv}`;

export const requireSuccess = (operation: string, payload: { readonly success: boolean }) =>
  payload.success ? Effect.void : Effect.fail(unavailable(`Linear ${operation} failed`));

// A Linear API key authenticates as itself; an OAuth token is a bearer credential and has to reach
// the SDK as `accessToken` or it is sent without the `Bearer` prefix.
const sdkAuth = (credential: Credential) =>
  credential.source === "env" || credential.source === "stored-key"
    ? { apiKey: Redacted.value(credential.token) }
    : { accessToken: Redacted.value(credential.token) };

export const verifyCredential = Effect.fn("linear.verifyCredential")(function* (credential: Credential) {
  const nowMillis = yield* Clock.currentTimeMillis;
  yield* withTransientAttemptDeadline(
    Effect.tryPromise({
      try: (signal) => new LinearSdk({ ...sdkAuth(credential), signal }).viewer,
      catch: (cause) => fromSdkFailure(cause, nowMillis),
    }),
  ).pipe(Effect.mapError((failure) => failure.error));
});

export const makeTransport = Effect.fn("linear.client.makeTransport")(function* (
  credentials: CredentialStoreService,
) {
  const resumeAt = yield* Ref.make(new Map<string, number>());

  const holdOff = Effect.fn("linear.holdOff")(function* (ref: LinearTeamRef, nowMillis: number) {
    const until = (yield* Ref.get(resumeAt)).get(rateLimitScopeOf(ref.account.tokenEnv));
    if (until === undefined || until <= nowMillis) return;
    return yield* new IssueTrackerError({
      reason: "rate-limited",
      message: `Linear rate limit active; resuming after ${isoMillis(until)}`,
      retryAfterMillis: until - nowMillis,
    });
  });

  const noteRateLimit = (ref: LinearTeamRef, nowMillis: number, error: IssueTrackerError) =>
    Ref.update(resumeAt, (entries) =>
      new Map(entries).set(
        rateLimitScopeOf(ref.account.tokenEnv),
        nowMillis + (error.retryAfterMillis ?? Duration.toMillis(defaultTrackerCooldown)),
      ),
    );

  // Client credentials have no refresh token, so local invalidation mints a replacement. Reconcile
  // also revokes the connection so operators can see and repair the rejected credential.
  const noteFailure = (ref: LinearTeamRef, nowMillis: number, error: IssueTrackerError) => {
    if (error.reason === "rate-limited") return noteRateLimit(ref, nowMillis, error);
    if (error.reason === "auth") return credentials.invalidate(ref.account);
    return Effect.void;
  };

  const credentialFor = (ref: LinearTeamRef) =>
    Effect.mapError(
      credentials.bearerToken(ref.account),
      (error) => new IssueTrackerError({ reason: "auth", message: error.message }),
    );

  const callWithCredential = Effect.fn("linear.callWithCredential")(function* <A>(
    ref: LinearTeamRef,
    credential: Credential,
    run: (sdk: LinearSdk) => PromiseLike<A>,
  ) {
    return yield* Effect.retry(
      Effect.gen(function* () {
        const attemptStartedAt = yield* Clock.currentTimeMillis;
        yield* Effect.mapError(holdOff(ref, attemptStartedAt), nonRetryableFailure);
        return yield* withTransientAttemptDeadline(
          Effect.tryPromise({
            try: (signal) => run(new LinearSdk({ ...sdkAuth(credential), signal })),
            catch: (cause) => fromSdkFailure(cause, attemptStartedAt),
          }),
        );
      }),
      { while: isTransient, schedule: transientBackoff, times: 3 },
    ).pipe(
      Effect.mapError((failure) => failure.error),
      Effect.tapError((error) =>
        Effect.flatMap(Clock.currentTimeMillis, (nowMillis) => noteFailure(ref, nowMillis, error)),
      ),
    );
  });

  const call = Effect.fn("linear.call")(function* <A>(
    ref: LinearTeamRef,
    run: (sdk: LinearSdk) => PromiseLike<A>,
  ) {
    const credential = yield* credentialFor(ref);
    return yield* callWithCredential(ref, credential, run);
  });

  const callOnceWithCredential = Effect.fn("linear.callOnceWithCredential")(function* <A>(
    ref: LinearTeamRef,
    credential: Credential,
    run: (sdk: LinearSdk) => PromiseLike<A>,
  ) {
    const attemptStartedAt = yield* Clock.currentTimeMillis;
    yield* holdOff(ref, attemptStartedAt);
    return yield* withTransientAttemptDeadline(
      Effect.tryPromise({
        try: (signal) => run(new LinearSdk({ ...sdkAuth(credential), signal })),
        catch: (cause) => fromSdkFailure(cause, attemptStartedAt),
      }),
    ).pipe(
      Effect.mapError((failure) => failure.error),
      Effect.tapError((error) =>
        Effect.flatMap(Clock.currentTimeMillis, (nowMillis) => noteFailure(ref, nowMillis, error)),
      ),
    );
  });

  const callOnce = Effect.fn("linear.callOnce")(function* <A>(
    ref: LinearTeamRef,
    run: (sdk: LinearSdk) => PromiseLike<A>,
  ) {
    const credential = yield* credentialFor(ref);
    return yield* callOnceWithCredential(ref, credential, run);
  });

  // The SDK fetches nested models lazily, so typed reads cost two extra requests per issue; observe
  // only stays inside Linear's rate limit while these reads stay single documents.
  const rawData = Effect.fn("linear.rawRequest")(function* (
    ref: LinearTeamRef,
    document: string,
    variables: Record<string, unknown>,
  ) {
    const response = yield* call(ref, (sdk) =>
      sdk.client
        .rawRequest<unknown, Record<string, unknown>>(document, variables)
        .catch((cause) => Promise.reject(parseLinearError(cause))),
    );
    if (response.data === undefined) {
      return yield* unavailable("Linear response missing data");
    }
    return response.data;
  });

  return { credentialFor, callWithCredential, call, callOnce, rawData };
});

export type LinearTransport = Effect.Success<ReturnType<typeof makeTransport>>;
