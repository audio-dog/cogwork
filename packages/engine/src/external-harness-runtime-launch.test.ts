import { RunPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { SandboxDurabilityCapability } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ExternalHarnessDescriptor } from "./external-harness-runtime";
import {
  ControlledAdapter,
  ControlledProbe,
  cancellableAsyncIterable,
  descriptor,
  freshSession,
  harnessRunnerLayer,
  makeHarness,
  request,
  resumedSession,
  runtimeCapabilities,
  terminalEvents,
} from "./external-harness-runtime-fixtures";

describe("external Harness runtime launch", { timeout: 30_000 }, () => {
  it.layer(harnessRunnerLayer)((it) => {
    it.effect("resolves the native session handle before descriptor projection", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(
          descriptor(
            [
              { type: EventType.RUN_STARTED, threadId: resumedSession, runId: request.id },
              { type: EventType.RUN_FINISHED, threadId: resumedSession, runId: request.id },
            ],
            probe,
          ),
        );

        yield* harness
          .run({ plan: request, session: resumedSession, mcpCredentials: new Map() })
          .pipe(Stream.take(1), Stream.runDrain);

        assert.deepNestedInclude(probe.resolved[0]?.request, {
          identity: {
            run: request.id,
            session: resumedSession,
            resumeHandle: "native-session-147",
          },
        });
        assert.strictEqual(probe.chatOptions[0]?.runId, request.id);
        assert.strictEqual(probe.chatOptions[0]?.threadId, resumedSession);
        assert.strictEqual(probe.chatOptions[0]?.modelOptions?.sessionId, "native-session-147");
      }),
    );

    it.effect("keeps the shared external Harness launch nondurable", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor(terminalEvents, probe));

        yield* harness
          .run({ plan: request, session: resumedSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain);

        const options = probe.chatOptions[0];
        if (!options) return yield* Effect.die("external Harness opened no chat");
        assert.isFalse(SandboxDurabilityCapability.has(runtimeCapabilities(options)));
      }),
    );

    it.effect("rejects an external launch without a Cogwork Session", () =>
      Effect.gen(function* () {
        const harness = makeHarness(descriptor(terminalEvents, new ControlledProbe()));

        const error = yield* harness
          .run({ plan: request, session: null, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "launch");
        assert.include(error.message, "requires a Cogwork Session");
      }),
    );

    it.effect("aborts the adapter when the Harness consumer cancels the stream", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const events: ReadonlyArray<StreamChunk> = [
          { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const base = descriptor(events, probe);
        const harness = makeHarness({
          ...base,
          makeAdapter: (resolved) => {
            probe.resolved.push(resolved);
            return new ControlledAdapter(() => cancellableAsyncIterable(events, probe.cancellations), probe);
          },
        });

        yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.take(1), Stream.runDrain);

        assert.deepStrictEqual(probe.cancellations, [true]);
        assert.isTrue(probe.chatOptions[0]?.request?.signal?.aborted);
      }),
    );

    it.effect("maps native launch failures through the descriptor diagnostics", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const nativeFailure = new Error("controlled executable missing");
        const controlledDescriptor: ExternalHarnessDescriptor<ControlledAdapter> = {
          ...descriptor([], probe),
          makeAdapter: () => {
            throw nativeFailure;
          },
        };
        const harness = makeHarness(controlledDescriptor);
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "launch");
        assert.strictEqual(error.retryable, false);
        assert.strictEqual(error.message, nativeFailure.message);
      }),
    );

    it.effect("refuses authentication mismatch without trying another mode", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor([], probe), {
          authentication: Effect.succeed({ mode: "byok", secrets: {} }),
        });
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "credential");
        assert.include(error.message, "requires host authentication, received byok");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects a Run Plan without Sandbox middleware before adapter launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor([], probe));
        const plan = RunPlan.make({
          ...request,
          middleware: [],
        });
        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "sandbox");
        assert.include(error.message, "missing mandatory Sandbox projection");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("rejects a Sandbox policy mismatch before adapter launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor([], probe));
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, policy: "read-only" },
        });
        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "policy");
        assert.include(error.message, "does not match its immutable Harness profile");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );

    it.effect("preserves a run error event before failing through the Harness taxonomy", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const seen: Array<{ readonly [key: string]: unknown; readonly type: string }> = [];
        const harness = makeHarness(
          descriptor(
            [
              { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
              {
                type: EventType.RUN_ERROR,
                message: "controlled turn failed",
                code: "CONTROLLED_FAILURE",
                metadata: { controlled: { retryAfter: 3 } },
              },
            ],
            probe,
          ),
        );
        const error = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(
            Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
            Effect.flip,
          );

        assert.strictEqual(error.reason, "turn");
        assert.strictEqual(error.retryable, true);
        assert.strictEqual(error.message, "controlled turn failed");
        assert.strictEqual(seen[1]?.type, EventType.RUN_ERROR);
        assert.strictEqual(seen[1]?.code, "CONTROLLED_FAILURE");
        assert.deepNestedInclude(seen[1]?.metadata, { controlled: { retryAfter: 3 } });
      }),
    );
  });
});
