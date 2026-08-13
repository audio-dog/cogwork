import { AgUiEvent } from "@cogwork/contracts";
import { EventType, type StreamChunk } from "@tanstack/ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HarnessError } from "./harness";

const decodeEvent = Schema.decodeUnknownOption(AgUiEvent);

export const toEvent = (chunk: StreamChunk): AgUiEvent =>
  Option.getOrElse(decodeEvent(chunk), () => ({ type: chunk.type }));

const fromThrown = (error: unknown): HarnessError => {
  const message = error instanceof Error ? error.message : String(error);
  return new HarnessError({ reason: "turn", retryable: true, message });
};

const fromRunError = (chunk: Extract<StreamChunk, { type: EventType.RUN_ERROR }>): HarnessError =>
  new HarnessError({ reason: "turn", retryable: true, message: chunk.message });

// RUN_ERROR is surfaced as an event before failing the stream, so the UI shows
// what happened.
export const bridgeChat = (stream: AsyncIterable<StreamChunk>): Stream.Stream<AgUiEvent, HarnessError> =>
  Stream.fromAsyncIterable(stream, fromThrown).pipe(
    Stream.flatMap((chunk) =>
      chunk.type === EventType.RUN_ERROR
        ? Stream.concat(Stream.succeed(toEvent(chunk)), Stream.fail(fromRunError(chunk)))
        : Stream.succeed(toEvent(chunk)),
    ),
  );
