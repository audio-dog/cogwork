import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { Credential } from "./credential-store";
import { readJsonEventStream } from "./json-event-stream";

const responseByteLimit = 16 * 1024 * 1024;
const requestDeadline = "10 seconds";

export class GranolaHttpFailure extends Schema.TaggedError<GranolaHttpFailure>()("GranolaHttpFailure", {
  reason: Schema.Literals(["auth", "unavailable", "rate-limited", "decode"]),
  retryAfterMillis: Schema.NullOr(Schema.Natural),
  message: Schema.String,
}) {}

const failure = (
  reason: GranolaHttpFailure["reason"],
  message: string,
  retryAfterMillis: number | null = null,
) => new GranolaHttpFailure({ reason, retryAfterMillis, message });

const retryAfterMillis = (response: HttpClientResponse.HttpClientResponse) => {
  const seconds = Number(response.headers["retry-after"]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
};

const responseFailures = [
  {
    matches: (response: HttpClientResponse.HttpClientResponse) =>
      response.status === 401 || response.status === 403,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      failure("auth", `Granola returned ${response.status}`),
  },
  {
    matches: (response: HttpClientResponse.HttpClientResponse) => response.status === 429,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      failure("rate-limited", "Granola rate limited the request", retryAfterMillis(response)),
  },
  {
    matches: (response: HttpClientResponse.HttpClientResponse) =>
      response.status < 200 || response.status >= 300,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      failure("unavailable", `Granola returned ${response.status}`),
  },
] satisfies ReadonlyArray<{
  readonly matches: (response: HttpClientResponse.HttpClientResponse) => boolean;
  readonly make: (response: HttpClientResponse.HttpClientResponse) => GranolaHttpFailure;
}>;

const readResponse = Effect.fn("GranolaHttp.readResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const responseFailure = responseFailures.find(({ matches }) => matches(response));
  if (responseFailure) return yield* responseFailure.make(response);
  return yield* readJsonEventStream(response, "Granola response", responseByteLimit).pipe(
    Effect.mapError((error) => failure("decode", error.message)),
  );
});

export const makeGranolaHttp = (client: HttpClient.HttpClient) => ({
  execute: (credential: Credential, request: HttpClientRequest.HttpClientRequest) =>
    client
      .execute(
        request.pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(credential.token)}`),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        ),
      )
      .pipe(
        Effect.mapError(() => failure("unavailable", "Granola could not be reached")),
        Effect.flatMap(readResponse),
        Effect.timeout(requestDeadline),
        Effect.catchTag("TimeoutError", () =>
          failure("unavailable", `Granola did not respond within ${requestDeadline}`),
        ),
      ),
});
