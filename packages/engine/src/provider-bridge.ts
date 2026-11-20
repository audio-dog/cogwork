import { AgUiEvent } from "@cogwork/contracts";
import { EventType, type StreamChunk } from "@tanstack/ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { HarnessError } from "./harness";

const decodeEvent = Schema.decodeUnknownOption(AgUiEvent);

export const toEvent = (chunk: StreamChunk) =>
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

export const versionAtLeast = (actual: ReadonlyArray<number>, minimum: ReadonlyArray<number>) =>
  (actual.map((part, index) => Math.sign(part - (minimum[index] ?? 0))).find((part) => part !== 0) ?? 0) >= 0;

const fromThrown = (error: unknown) => {
  const message = messageFromUnknown(error);
  return new HarnessError({ reason: "turn", retryable: true, message });
};

const fromRunError = (chunk: Extract<StreamChunk, { type: EventType.RUN_ERROR }>) =>
  new HarnessError({ reason: "turn", retryable: true, message: chunk.message });

export const bridgeChat = (
  stream: AsyncIterable<StreamChunk>,
  onThrown: (error: unknown) => HarnessError = fromThrown,
  onRunError: (event: Extract<StreamChunk, { type: EventType.RUN_ERROR }>) => HarnessError = fromRunError,
) =>
  Stream.fromAsyncIterable(stream, onThrown).pipe(
    Stream.flatMap((chunk) =>
      chunk.type === EventType.RUN_ERROR
        ? Stream.concat(Stream.succeed(toEvent(chunk)), Stream.fail(onRunError(chunk)))
        : Stream.succeed(toEvent(chunk)),
    ),
  );
