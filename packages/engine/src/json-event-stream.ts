import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class JsonEventStreamError extends Schema.TaggedError<JsonEventStreamError>()("JsonEventStreamError", {
  message: Schema.String,
}) {}

interface BodyAccumulator {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly size: number;
}

const failure = (message: string) => new JsonEventStreamError({ message });

const readLimitedText = (
  response: HttpClientResponse.HttpClientResponse,
  label: string,
  byteLimit: number,
) => {
  const declaredSize = Number(response.headers["content-length"]);
  const declaredSizeTooLarge = Number.isFinite(declaredSize) && declaredSize > byteLimit;
  if (declaredSizeTooLarge) return Effect.fail(failure(`${label} exceeded the size limit`));
  return response.stream.pipe(
    Stream.runFoldEffect(
      (): BodyAccumulator => ({ chunks: [], size: 0 }),
      (accumulator, chunk) => {
        const size = accumulator.size + chunk.byteLength;
        return size > byteLimit
          ? Effect.fail(failure(`${label} exceeded the size limit`))
          : Effect.succeed({ chunks: [...accumulator.chunks, chunk], size });
      },
    ),
    Effect.map(({ chunks }) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")),
    Effect.mapError((error) =>
      error._tag === "JsonEventStreamError" ? error : failure(`${label} was unreadable`),
    ),
  );
};

const parseJson = (text: string, label: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => failure(`${label} contained invalid JSON`)),
  );

const readEventText = (response: HttpClientResponse.HttpClientResponse, label: string, byteLimit: number) =>
  response.stream.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (size, chunk) => {
        const nextSize = size + chunk.byteLength;
        return nextSize > byteLimit
          ? Effect.fail(failure(`${label} exceeded the size limit`))
          : Effect.succeed([nextSize, [chunk]] as const);
      },
    ),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.takeUntil((line) => line === ""),
    Stream.runFold(
      () => "",
      (text, line) => (text === "" ? line : `${text}\n${line}`),
    ),
    Effect.mapError((error) =>
      error._tag === "JsonEventStreamError" ? error : failure(`${label} was unreadable`),
    ),
  );

const bodyReaders = new Map<
  string,
  (
    response: HttpClientResponse.HttpClientResponse,
    label: string,
    byteLimit: number,
  ) => Effect.Effect<unknown, JsonEventStreamError>
>([
  [
    "application/json",
    (response, label, byteLimit) =>
      readLimitedText(response, label, byteLimit).pipe(Effect.flatMap((text) => parseJson(text, label))),
  ],
  [
    "text/event-stream",
    (response, label, byteLimit) =>
      readEventText(response, label, byteLimit).pipe(
        Effect.flatMap((text) => {
          const data = text
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          return data ? parseJson(data, label) : Effect.fail(failure(`${label} was empty`));
        }),
      ),
  ],
]);

export const readJsonEventStream = (
  response: HttpClientResponse.HttpClientResponse,
  label: string,
  byteLimit: number,
) => {
  const mediaType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const readBody = bodyReaders.get(mediaType);
  if (!readBody) return Effect.fail(failure(`${label} used unsupported content type "${mediaType}"`));
  return readBody(response, label, byteLimit);
};
