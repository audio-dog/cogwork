import { AgUiEvent } from "@cogwork/contracts";
import { EventType, type StreamChunk } from "@tanstack/ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HarnessError } from "./harness";

const decodeEvent = Schema.decodeUnknownOption(AgUiEvent);

export const toEvent = (chunk: StreamChunk): AgUiEvent =>
  Option.getOrElse(decodeEvent(chunk), () => ({ type: chunk.type }));

export const messageFromUnknown = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
};

const fromThrown = (error: unknown): HarnessError => {
  const message = messageFromUnknown(error);
  return new HarnessError({ reason: "turn", retryable: true, message });
};

// RUN_ERROR is surfaced as an event before failing the stream, so the UI shows
// what happened.
export const bridgeChat = (
  stream: AsyncIterable<StreamChunk>,
  classifyError: (error: unknown) => HarnessError = fromThrown,
): Stream.Stream<AgUiEvent, HarnessError> =>
  Stream.fromAsyncIterable(stream, classifyError).pipe(
    Stream.flatMap((chunk) =>
      chunk.type === EventType.RUN_ERROR
        ? Stream.concat(Stream.succeed(toEvent(chunk)), Stream.fail(classifyError(chunk)))
        : Stream.succeed(toEvent(chunk)),
    ),
  );
