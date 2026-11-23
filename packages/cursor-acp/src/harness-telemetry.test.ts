import { assert, describe, it } from "@effect/vitest";
import type { AcpJsonRpcStream } from "@tanstack/ai-acp";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { interceptCursorTelemetry } from "./harness";
import type { AcpMessage } from "./harness-fixtures";

describe("interceptCursorTelemetry", () => {
  it.effect("interrupts pending writes when its runtime scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const runPromise = yield* FiberSet.makeRuntimePromise().pipe(Effect.provideService(Scope.Scope, scope));
      const pendingScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(pendingScope, exit));
      const runPending = yield* FiberSet.makeRuntimePromise().pipe(
        Effect.provideService(Scope.Scope, pendingScope),
      );
      const base = {
        readable: new ReadableStream<AcpMessage>(),
        writable: new WritableStream<AcpMessage>({
          write: () => runPending(Effect.never),
        }),
      } satisfies AcpJsonRpcStream;
      const writer = interceptCursorTelemetry(base, runPromise).writable.getWriter();
      const writeResult = writer.write({ jsonrpc: "2.0", method: "session/cancel" }).then(
        () => "completed",
        () => "interrupted",
      );
      const resultFiber = yield* Effect.promise(() => writeResult).pipe(
        Effect.timeoutOrElse({ duration: "100 millis", orElse: () => Effect.succeed("timed-out") }),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("100 millis");

      const result = yield* Fiber.join(resultFiber);
      assert.strictEqual(result, "interrupted");
    }),
  );

  it.effect("finishes reading when its runtime scope interrupts a pending telemetry acknowledgment", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const runPromise = yield* FiberSet.makeRuntimePromise().pipe(Effect.provideService(Scope.Scope, scope));
      const pendingScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(pendingScope, exit));
      const runPending = yield* FiberSet.makeRuntimePromise().pipe(
        Effect.provideService(Scope.Scope, pendingScope),
      );
      const base = {
        readable: new ReadableStream<AcpMessage>({
          start: (controller) => {
            controller.enqueue({ jsonrpc: "2.0", id: 1, method: "cursor/task" });
            controller.close();
          },
        }),
        writable: new WritableStream<AcpMessage>({
          write: () => runPending(Effect.never),
        }),
      } satisfies AcpJsonRpcStream;
      const readResult = interceptCursorTelemetry(base, runPromise)
        .readable.getReader()
        .read()
        .then(
          () => "completed",
          () => "failed",
        );
      const resultFiber = yield* Effect.promise(() => readResult).pipe(
        Effect.timeoutOrElse({ duration: "100 millis", orElse: () => Effect.succeed("timed-out") }),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("100 millis");

      const result = yield* Fiber.join(resultFiber);
      assert.strictEqual(result, "completed");
    }),
  );

  it.effect("keeps reading after a telemetry acknowledgment fails", () =>
    Effect.gen(function* () {
      const telemetryRequest = { jsonrpc: "2.0", id: 1, method: "cursor/task" } satisfies AcpMessage;
      const sessionNotification = { jsonrpc: "2.0", method: "session/update" } satisfies AcpMessage;
      const base = {
        readable: new ReadableStream<AcpMessage>({
          start: (controller) => {
            controller.enqueue(telemetryRequest);
            controller.enqueue(sessionNotification);
            controller.close();
          },
        }),
        writable: new WritableStream<AcpMessage>({
          write: () => Promise.reject(new Error("transport closed")),
        }),
      } satisfies AcpJsonRpcStream;

      const intercepted = yield* FiberSet.makeRuntimePromise().pipe(
        Effect.map((runPromise) => interceptCursorTelemetry(base, runPromise)),
      );
      const messages = yield* Stream.fromReadableStream({
        evaluate: () => intercepted.readable,
        onError: String,
      }).pipe(Stream.runCollect);

      assert.deepStrictEqual(Array.from(messages), [sessionNotification]);
    }),
  );

  it.effect("acknowledges telemetry and leaves blocking extensions for prompt refusal", () =>
    Effect.gen(function* () {
      const telemetryRequest = { jsonrpc: "2.0", id: 1, method: "cursor/update_todos" } satisfies AcpMessage;
      const blockingRequest = { jsonrpc: "2.0", id: 2, method: "cursor/create_plan" } satisfies AcpMessage;
      const replies: Array<AcpMessage> = [];
      const base = {
        readable: new ReadableStream<AcpMessage>({
          start: (controller) => {
            controller.enqueue(telemetryRequest);
            controller.enqueue(blockingRequest);
            controller.close();
          },
        }),
        writable: new WritableStream<AcpMessage>({
          write: (message) => {
            replies.push(message);
          },
        }),
      } satisfies AcpJsonRpcStream;

      const intercepted = yield* FiberSet.makeRuntimePromise().pipe(
        Effect.map((runPromise) => interceptCursorTelemetry(base, runPromise)),
      );
      const messages = yield* Stream.fromReadableStream({
        evaluate: () => intercepted.readable,
        onError: String,
      }).pipe(Stream.runCollect);

      assert.deepStrictEqual(Array.from(messages), [blockingRequest]);
      assert.deepStrictEqual(replies, [{ jsonrpc: "2.0", id: 1, result: {} }]);
    }),
  );
});
