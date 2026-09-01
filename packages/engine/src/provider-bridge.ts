import { AgUiEvent } from "@cogwork/contracts";
import { EventType, type StreamChunk } from "@tanstack/ai";
import type { SandboxHandle, SandboxLifecycle, SandboxProvider } from "@tanstack/ai-sandbox";
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

const fromThrown = (error: unknown) => {
  const message = messageFromUnknown(error);
  return new HarnessError({ reason: "turn", retryable: true, message });
};

const fromRunError = (chunk: Extract<StreamChunk, { type: EventType.RUN_ERROR }>) =>
  new HarnessError({ reason: "turn", retryable: true, message: chunk.message });

export const perRunSandboxLifecycle = {
  reuse: "none",
  snapshot: "none",
  destroyOnComplete: true,
} satisfies SandboxLifecycle;

const completedIteration = () => ({ done: true, value: undefined }) satisfies IteratorReturnResult<undefined>;

export const abortOnReturn = <Value>(stream: AsyncIterable<Value>, abort: () => void | Promise<void>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = stream[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: (value?: unknown) =>
        Promise.resolve(abort()).then(() => iterator.return?.(value) ?? completedIteration()),
    };
  },
});

export const ownSandboxHandles = (source: SandboxProvider) => {
  const handles = new Map<string, SandboxHandle>();
  const track = (handle: SandboxHandle) => {
    handles.set(handle.id, handle);
    return handle;
  };
  const destroyHandle = (id: string) => {
    const handle = handles.get(id);
    if (!handle) return Promise.resolve(false);
    handles.delete(id);
    return handle.destroy().then(() => true);
  };
  const destroy = () => {
    const active = [...handles.values()];
    handles.clear();
    return Promise.all(active.map((handle) => handle.destroy())).then(() => undefined);
  };
  const restoreSnapshot = source.restoreSnapshot;
  const provider = {
    name: source.name,
    capabilities: () => source.capabilities(),
    create: (input: Parameters<SandboxProvider["create"]>[0]) => source.create(input).then(track),
    resume: (input: Parameters<SandboxProvider["resume"]>[0]) =>
      source.resume(input).then((handle) => (handle ? track(handle) : null)),
    ...(restoreSnapshot
      ? {
          restoreSnapshot: (input: Parameters<typeof restoreSnapshot>[0]) =>
            restoreSnapshot(input).then(track),
        }
      : {}),
    destroy: (input: Parameters<SandboxProvider["destroy"]>[0]) =>
      destroyHandle(input.id).then((destroyed) => (destroyed ? undefined : source.destroy(input))),
  } satisfies SandboxProvider;
  return { provider, destroy };
};

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
