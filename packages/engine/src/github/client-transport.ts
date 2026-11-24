import { connectionAccountOf } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { CredentialStore } from "../credential-store";
import { defaultTrackerCooldown, IssueTrackerError } from "../issue-tracker";
import type { GitHubRepoRef } from "./client";
import { decodeGraphQl, graphQlData } from "./client-graphql";

const baseHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "cogwork",
};

const decodeGitHubError = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

export const unavailable = (message: string, writeMayHaveCommitted?: boolean) =>
  new IssueTrackerError({
    reason: "unavailable",
    message,
    ...(writeMayHaveCommitted === undefined ? {} : { writeMayHaveCommitted }),
  });
export const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

export const isoMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

const rateLimited = (resumeAtMillis: number) =>
  new IssueTrackerError({
    reason: "rate-limited",
    message: `GitHub rate limit exceeded; resuming after ${isoMillis(resumeAtMillis)}`,
    writeMayHaveCommitted: false,
  });

const headerSeconds = (value: string | undefined) => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rateLimitResumeAt = (headers: Headers.Headers, nowMillis: number) => {
  const retryAfter = headerSeconds(headers["retry-after"]);
  if (retryAfter !== null) return nowMillis + retryAfter * 1000;
  if (headers["x-ratelimit-remaining"] !== "0") return null;
  const reset = headerSeconds(headers["x-ratelimit-reset"]);
  return reset === null ? null : reset * 1000;
};

const isTransientStatus = (status: number) => status === 408 || status === 425 || status >= 500;

const classifyGitHubError = (body: unknown) => {
  const error = Option.getOrNull(decodeGitHubError(body));
  if (!error) return "unknown";
  const message = error.message.toLowerCase();
  if (message.includes("secondary rate limit")) return "rate-limited";
  if (message.includes("resource not accessible")) return "permission";
  return "unknown";
};

const transientAttemptDeadline = "30 seconds";

const classifyForbiddenResponse = Effect.fn("github.classifyForbiddenResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
  remaining: string | undefined,
) {
  if (remaining === "0" || response.headers["retry-after"] !== undefined) return "rate-limited";
  const body = yield* response.json.pipe(
    Effect.timeoutOption(transientAttemptDeadline),
    Effect.catchTag("HttpClientError", () => Effect.succeed(Option.none())),
  );
  return Option.match(body, { onNone: () => "unknown", onSome: classifyGitHubError });
});

class GitHubAttemptError extends Data.TaggedError("GitHubAttemptError")<{
  readonly error: IssueTrackerError;
  readonly transient: boolean;
}> {}

const transientAttemptError = (message: string) =>
  new GitHubAttemptError({ error: unavailable(message), transient: true });

const permanentAttemptError = (error: IssueTrackerError) =>
  new GitHubAttemptError({ error, transient: false });

const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);
const paginationDeadline = "5 minutes";

const withTransientAttemptDeadline = <A, R>(attempt: Effect.Effect<A, HttpClientError.HttpClientError, R>) =>
  attempt.pipe(
    Effect.catchTag("HttpClientError", (error) => Effect.fail(transientAttemptError(error.message))),
    Effect.timeout(transientAttemptDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(transientAttemptError(`GitHub request timed out after ${transientAttemptDeadline}`)),
    ),
  );

export const withTransientRetry = <A, R>(attempt: Effect.Effect<A, GitHubAttemptError, R>) =>
  attempt.pipe(
    Effect.retry({ while: (error) => error.transient, schedule: transientBackoff, times: 3 }),
    Effect.mapError((error) => error.error),
  );

export const withPaginationDeadline = <A, R>(operation: Effect.Effect<A, IssueTrackerError, R>) =>
  operation.pipe(
    Effect.timeout(paginationDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(unavailable(`GitHub pagination timed out after ${paginationDeadline}`)),
    ),
  );

interface EtagEntry {
  readonly etag: string;
  readonly body: unknown;
  readonly nextLink: string | null;
}

const responseWithEtag = (body: unknown, etag: string | undefined, nextLink: string | null) => ({
  body,
  etag,
  nextLink,
});

type ConsumeResponse<A> = (
  response: HttpClientResponse.HttpClientResponse,
) => Effect.Effect<A, HttpClientError.HttpClientError>;

export const acceptResponse = () => Effect.void;

export const repoPath = (repo: GitHubRepoRef, suffix: string) =>
  `https://api.github.com/repos/${repo.owner}/${repo.name}${suffix}`;

export const makeTransport = Effect.fn("github.client.makeTransport")(function* (
  client: HttpClient.HttpClient,
) {
  const credentialStore = Option.getOrNull(yield* Effect.serviceOption(CredentialStore));
  const etags = yield* Ref.make(new Map<string, EtagEntry>());
  const resumeAtRef = yield* Ref.make<number | null>(null);

  const execute = Effect.fn("github.execute")(function* <A>(
    request: HttpClientRequest.HttpClientRequest,
    token: Redacted.Redacted<string>,
    consume: ConsumeResponse<A>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cooldownUntil = yield* Ref.get(resumeAtRef);
    if (cooldownUntil !== null && now < cooldownUntil) {
      return yield* permanentAttemptError(rateLimited(cooldownUntil));
    }
    const response = yield* withTransientAttemptDeadline(
      client.execute(
        HttpClientRequest.setHeaders(HttpClientRequest.bearerToken(request, token), {
          ...baseHeaders,
          ...(request.headers.accept ? { accept: request.headers.accept } : {}),
        }),
      ),
    );
    const remaining = response.headers["x-ratelimit-remaining"];
    const resumeAt = rateLimitResumeAt(response.headers, now);
    if (remaining === "0" && resumeAt !== null) {
      yield* Ref.set(resumeAtRef, resumeAt);
    }
    if (response.status === 401) {
      return yield* permanentAttemptError(
        new IssueTrackerError({
          reason: "auth",
          message: "GitHub authentication failed (401)",
          writeMayHaveCommitted: false,
        }),
      );
    }
    const forbidden =
      response.status === 403 ? yield* classifyForbiddenResponse(response, remaining) : "unknown";
    const throttled = response.status === 429 || forbidden === "rate-limited";
    if (throttled) {
      const until = resumeAt ?? now + Duration.toMillis(defaultTrackerCooldown);
      yield* Ref.set(resumeAtRef, until);
      return yield* permanentAttemptError(rateLimited(until));
    }
    if (isTransientStatus(response.status)) {
      return yield* transientAttemptError(`GitHub request failed (${response.status})`);
    }
    if (forbidden === "permission") {
      return yield* permanentAttemptError(
        new IssueTrackerError({
          reason: "unavailable",
          message: `GitHub request failed (${response.status})`,
          retryable: false,
          writeMayHaveCommitted: false,
        }),
      );
    }
    const idempotentDelete = request.method === "DELETE" && response.status === 404;
    if (response.status >= 400 && !idempotentDelete) {
      return yield* permanentAttemptError(unavailable(`GitHub request failed (${response.status})`, false));
    }
    return yield* withTransientAttemptDeadline(consume(response));
  });

  const send = Effect.fn("github.send")(function* <A>(
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    consume: ConsumeResponse<A>,
  ) {
    if (repo.connectionId && credentialStore) {
      const account = connectionAccountOf(repo.connectionId);
      const credential = yield* credentialStore
        .bearerToken({
          connectionId: repo.connectionId,
          key: repo.connectionId,
          issueTracker: "github",
          organization: account === "default" ? null : account,
          tokenEnv: repo.tokenEnv,
          clientCredentials: null,
          oauthClientId: null,
        })
        .pipe(
          Effect.mapError((error) =>
            permanentAttemptError(
              new IssueTrackerError({
                reason: "auth",
                message: error.message,
                writeMayHaveCommitted: false,
              }),
            ),
          ),
        );
      return yield* execute(request, credential.token, consume);
    }
    const token = yield* Effect.mapError(Config.Redacted(repo.tokenEnv), () =>
      permanentAttemptError(
        new IssueTrackerError({
          reason: "auth",
          message: `missing GitHub token in ${repo.tokenEnv}`,
          writeMayHaveCommitted: false,
        }),
      ),
    );
    return yield* execute(request, token, consume);
  });

  const fetchJsonResponse = Effect.fn("github.fetchJsonResponse")(function* (
    repo: GitHubRepoRef,
    path: string,
  ) {
    const cached = (yield* Ref.get(etags)).get(path);
    const base = HttpClientRequest.get(path);
    const request = cached ? HttpClientRequest.setHeader(base, "if-none-match", cached.etag) : base;
    const response = yield* withTransientRetry(
      send(repo, request, (response) => {
        if (response.status === 304 && cached) {
          return Effect.succeed(responseWithEtag(cached.body, undefined, cached.nextLink));
        }
        return Effect.map(response.json, (body) =>
          responseWithEtag(body, response.headers.etag, response.headers.link ?? null),
        );
      }),
    );
    const etag = response.etag;
    if (etag !== undefined) {
      yield* Ref.update(etags, (entries) =>
        new Map(entries).set(path, { etag, body: response.body, nextLink: response.nextLink }),
      );
    }
    return response;
  });

  const fetchJson = Effect.fn("github.fetchJson")(function* (repo: GitHubRepoRef, path: string) {
    return (yield* fetchJsonResponse(repo, path)).body;
  });

  const fetchUncachedJsonResponse = Effect.fn("github.fetchUncachedJsonResponse")(function* (
    repo: GitHubRepoRef,
    path: string,
  ) {
    return yield* withTransientRetry(
      send(repo, HttpClientRequest.get(path), (response) =>
        Effect.map(response.json, (body) => ({ body, nextLink: response.headers.link ?? null })),
      ),
    );
  });

  const linkedPageNumber = Effect.fn("github.linkedPageNumber")(function* (
    header: string | undefined,
    expectedPath: string,
    canonicalPath: RegExp,
    label: string,
  ) {
    const link = header?.split(",").find((part) => part.includes('rel="next"'));
    if (!link) return null;
    const candidateUrl = /^<([^>]+)>/.exec(link.trim())?.[1];
    const url = candidateUrl && URL.canParse(candidateUrl) ? new URL(candidateUrl) : null;
    const page = url?.searchParams.get("page");
    const validLink =
      url?.origin === "https://api.github.com" &&
      (url.pathname === expectedPath || canonicalPath.test(url.pathname)) &&
      typeof page === "string" &&
      /^[1-9]\d*$/.test(page);
    if (!validLink) return yield* unavailable(`GitHub ${label} pagination returned an invalid next link`);
    return page;
  });

  const sendJson = Effect.fn("github.sendJson")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) {
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), toUnavailable);
    yield* withTransientRetry(send(repo, withBody, acceptResponse));
  });

  const sendAcceptedJsonOnce = Effect.fn("github.sendAcceptedJsonOnce")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) {
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), (error) =>
      unavailable(error.message, false),
    );
    const response = yield* send(repo, withBody, Effect.succeed).pipe(
      Effect.mapError((error) => error.error),
    );
    return yield* response.json.pipe(
      Effect.option,
      Effect.timeoutOption(transientAttemptDeadline),
      Effect.map(Option.flatten),
    );
  });

  const sendAcceptedOnce = Effect.fn("github.sendAcceptedOnce")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) {
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), (error) =>
      unavailable(error.message, false),
    );
    yield* send(repo, withBody, acceptResponse).pipe(Effect.mapError((error) => error.error));
  });

  const graphql = Effect.fn("github.graphql")(function* (
    repo: GitHubRepoRef,
    query: string,
    variables: Record<string, unknown>,
  ) {
    const request = HttpClientRequest.post("https://api.github.com/graphql");
    const withBody = yield* Effect.mapError(
      HttpClientRequest.bodyJson(request, { query, variables }),
      toUnavailable,
    );
    const json = yield* withTransientRetry(send(repo, withBody, (response) => response.json));
    const decoded = yield* Effect.mapError(decodeGraphQl(json), toUnavailable);
    const result = graphQlData(decoded);
    if (!result.ok) return yield* unavailable(result.message);
    return result.data;
  });

  return {
    execute,
    send,
    fetchJsonResponse,
    fetchJson,
    fetchUncachedJsonResponse,
    linkedPageNumber,
    sendJson,
    sendAcceptedJsonOnce,
    sendAcceptedOnce,
    graphql,
  };
});

export type GitHubTransport = Effect.Success<ReturnType<typeof makeTransport>>;
