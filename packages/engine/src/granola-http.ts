import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { Credential } from "./credential-store";

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

interface BodyAccumulator {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly size: number;
}

const readLimitedText = (response: HttpClientResponse.HttpClientResponse) => {
  const declaredSize = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredSize) && declaredSize > responseByteLimit) {
    return Effect.fail(failure("decode", "Granola response exceeded the size limit"));
  }
  return response.stream.pipe(
    Stream.runFoldEffect(
      (): BodyAccumulator => ({ chunks: [], size: 0 }),
      (accumulator, chunk) => {
        const size = accumulator.size + chunk.byteLength;
        return size > responseByteLimit
          ? Effect.fail(failure("decode", "Granola response exceeded the size limit"))
          : Effect.succeed({ chunks: [...accumulator.chunks, chunk], size });
      },
    ),
    Effect.map(({ chunks }) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")),
    Effect.mapError((error) =>
      error._tag === "GranolaHttpFailure"
        ? error
        : failure("unavailable", "Granola returned an unreadable response"),
    ),
  );
};

const readEventText = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.takeUntil((line) => line === ""),
    Stream.runFoldEffect(
      () => "",
      (text, line) => {
        const next = text === "" ? line : `${text}\n${line}`;
        return next.length > responseByteLimit
          ? Effect.fail(failure("decode", "Granola response exceeded the size limit"))
          : Effect.succeed(next);
      },
    ),
    Effect.mapError((error) =>
      error._tag === "GranolaHttpFailure"
        ? error
        : failure("unavailable", "Granola returned an unreadable response"),
    ),
  );

const parseJson = (text: string, message: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => failure("decode", message)),
  );

const bodyReaders = new Map<
  string,
  (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<unknown, GranolaHttpFailure>
>([
  [
    "application/json",
    (response) =>
      readLimitedText(response).pipe(
        Effect.flatMap((text) => parseJson(text, "Granola returned invalid JSON")),
      ),
  ],
  [
    "text/event-stream",
    (response) =>
      readEventText(response).pipe(
        Effect.flatMap((text) => {
          const data = text
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          return data === ""
            ? Effect.fail(failure("decode", "Granola returned an empty event stream"))
            : parseJson(data, "Granola returned invalid event data");
        }),
      ),
  ],
]);

const readResponse = Effect.fn("GranolaHttp.readResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const responseFailure = responseFailures.find(({ matches }) => matches(response));
  if (responseFailure) return yield* responseFailure.make(response);
  const mediaType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const readBody = bodyReaders.get(mediaType);
  if (!readBody) {
    return yield* failure("decode", `Granola returned unsupported content type "${mediaType}"`);
  }
  return yield* readBody(response);
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
