import { agUiIsFileDiffEvent, FILE_DIFF_EVENT, type RunRecord } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { createSecrets, getSandboxPolicy, getWorkspaceProjection } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vitest";
import {
  ControlledProbe,
  checkoutPath,
  descriptor,
  encodeJson,
  freshSession,
  harnessRunnerLayer,
  makeHarness,
  name,
  request,
  runtimeCapabilities,
  secretWorkItem,
  secretWorkspace,
} from "./external-harness-runtime-fixtures";
import * as RunLedger from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { engineTestLayer } from "./testing/engine-test-layer";
import { policyForProfile } from "./tools/policy";

afterEach(() => vi.restoreAllMocks());

describe("external Harness runtime events", { timeout: 30_000 }, () => {
  it.layer(harnessRunnerLayer)((it) => {
    it.effect("launches through Harness and preserves complete AG-UI and structured-result events", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const events: ReadonlyArray<StreamChunk> = [
          { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "message-147", delta: "built" },
          {
            type: EventType.CUSTOM,
            name: "controlled.diagnostic",
            value: { native: true },
            metadata: { controlled: { trace: "trace-147" } },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/file.ts`, diff: "diff --git a/file.ts b/file.ts" },
            metadata: { controlled: { fidelity: "terminal" } },
          },
          {
            type: EventType.CUSTOM,
            name: "structured-output.complete",
            value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
          },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const harness = makeHarness(descriptor(events, probe));
        const output = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);

        const chatOptions = probe.chatOptions[0];
        if (!chatOptions) return assert.fail("adapter received no chat options");
        assert.strictEqual(getSandboxPolicy(runtimeCapabilities(chatOptions)), policyForProfile("full"));
        assert.strictEqual(output.filter((event) => event.name === "structured-output.complete").length, 1);
        const diagnostic = output.find((event) => event.name === "controlled.diagnostic");
        assert.deepStrictEqual(diagnostic?.value, { native: true });
        assert.deepNestedInclude(diagnostic?.metadata, { controlled: { trace: "trace-147" } });
        const fileDiff = output.find((event) => event.name === FILE_DIFF_EVENT);
        assert.deepStrictEqual(fileDiff?.value, {
          path: "file.ts",
          diff: "diff --git a/file.ts b/file.ts",
        });
        assert.deepNestedInclude(fileDiff?.metadata, { controlled: { fidelity: "terminal" } });
        assert.isFalse(output.some((event) => event.name === "file.changed"));
        const finished = output.find((event) => event.type === EventType.RUN_FINISHED);
        assert.deepStrictEqual(finished?.usage, {
          promptTokens: 2,
          completionTokens: 5,
          totalTokens: 7,
          estimated: true,
        });

        const launch = probe.resolved[0];
        assert.strictEqual(launch?.model, "controlled");
        assert.strictEqual(launch?.nativeAuthentication, "host");
        assert.strictEqual(launch?.request.identity.run, request.id);
        assert.strictEqual(launch?.request.identity.session, freshSession);
        assert.strictEqual(launch?.request.policy, "full");
        assert.strictEqual(launch?.request.checkout.path, checkoutPath);
        assert.strictEqual(launch?.request.operatingInstructions.path, "/instructions/implement-agent");
        assert.deepStrictEqual(launch?.request.prompt.slice(1), request.messages);
        assert.include(launch?.request.prompt[0]?.content ?? "", "Ship the external Harness change.");
        assert.include(
          launch?.request.prompt[0]?.content ?? "",
          "Keep this instruction in the admitted snapshot.",
        );
        assert.deepStrictEqual(launch?.request.outputSchema, request.structuredOutput);
        assert.strictEqual(probe.chatOptions[0]?.runId, request.id);
        assert.strictEqual(probe.chatOptions[0]?.threadId, freshSession);
        assert.deepStrictEqual(probe.chatOptions[0]?.modelOptions, {
          effort: "high",
          authentication: "host",
          sessionId: null,
        });
        assert.deepNestedInclude(probe.chatOptions[0]?.outputSchema, request.structuredOutput ?? {});
        const outputSchema = probe.chatOptions[0]?.outputSchema;
        if (!outputSchema || !("additionalProperties" in outputSchema)) {
          return assert.fail("adapter received no converted JSON Schema");
        }
        assert.strictEqual(outputSchema.additionalProperties, false);
      }),
    );

    it.effect("bounds, drops, and hides file diffs on the shared client contract", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const oversized = "d".repeat(80 * 1024);
        const events: ReadonlyArray<StreamChunk> = [
          { type: EventType.RUN_STARTED, threadId: "session-147", runId: "run-external-test" },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/big.ts`, diff: oversized },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/touched.ts`, diff: "" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/.tanstack-projected-abc123`, diff: "diff --git a/x b/x" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: {
              path: `${checkoutPath}/.tanstack-output-schema-run-1.json`,
              diff: "diff --git a/y b/y",
            },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/src/.tanstack-nested.ts`, diff: "diff --git a/n b/n" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: checkoutPath, diff: "diff --git a/z b/z" },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: {
              path: `${checkoutPath}/.repos/effect/packages/effect/src/Stream.ts`,
              diff: "diff --git a/r b/r",
            },
          },
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/node_modules/left-pad/index.js`, diff: "diff --git a/m b/m" },
          },
          // TanStack makes `diff` optional, so a file event with no diff is a real
          // shape. It cannot carry the shared contract and must not survive under
          // its native name.
          {
            type: EventType.CUSTOM,
            name: "file.changed",
            value: { path: `${checkoutPath}/nodiff.ts`, type: "change", timestamp: 1 },
          },
          {
            type: EventType.CUSTOM,
            name: "structured-output.complete",
            value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
          },
          { type: EventType.RUN_FINISHED, threadId: "session-147", runId: "run-external-test" },
        ];
        const output = yield* makeHarness(descriptor(events, probe))
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);
        const diffs = output.filter(agUiIsFileDiffEvent);

        assert.deepStrictEqual(
          diffs.map((event) => event.value.path),
          ["big.ts", "src/.tanstack-nested.ts", "."],
        );
        // Nothing escapes under the native name, whatever the payload was.
        assert.isFalse(output.some((event) => event.name === "file.changed"));
        const big = diffs[0];
        if (!big) return assert.fail("the oversized diff was dropped");
        assert.isBelow(Buffer.byteLength(big.value.diff), Buffer.byteLength(oversized));
        assert.include(big.value.diff, "diff truncated by Cogwork");
      }),
    );

    it.effect("scrubs secrets before output, Workspace serialization, and persistence", () =>
      Effect.gen(function* () {
        const secret = "anthropic-test-key-secret";
        const identifierSecret = "RUN-147";
        const probe = new ControlledProbe();
        const harness = makeHarness(
          descriptor(
            [
              { type: EventType.RUN_STARTED, threadId: identifierSecret, runId: identifierSecret },
              {
                type: EventType.CUSTOM,
                name: identifierSecret,
                value: { message: `rejected ${identifierSecret} and ${secret}` },
              },
              {
                type: EventType.CUSTOM,
                name: "structured-output.complete",
                value: { object: { outcome: "opened-pr" }, raw: '{"outcome":"opened-pr"}' },
              },
              { type: EventType.RUN_FINISHED, threadId: identifierSecret, runId: identifierSecret },
            ],
            probe,
          ),
          {
            authentication: Effect.succeed({
              mode: "host",
              secrets: createSecrets({ LONG_KEY: secret, IDENTIFIER_KEY: identifierSecret }),
            }),
          },
        );
        const output = yield* harness
          .run({ plan: request, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runCollect);
        const options = probe.chatOptions[0];
        if (!options) return yield* Effect.die("external Harness opened no chat");

        assert.strictEqual(output[0]?.type, EventType.RUN_STARTED);
        assert.strictEqual(output[0]?.threadId, identifierSecret);
        assert.strictEqual(output[1]?.name, identifierSecret);
        assert.deepStrictEqual(output[1]?.value, {
          message: "rejected [redacted] and [redacted]",
        });
        // The native adapter's own logger is the one channel cogwork cannot scrub on
        // the way out, so a request carrying secrets has to silence it outright. Drop
        // the `debug: false` wiring and this logger writes the secret to the console.
        const logs: Array<unknown> = [];
        vi.spyOn(console, "error").mockImplementation((...values) => logs.push(values));
        options.logger.errors("native adapter failed", { secret });
        assert.notInclude(yield* encodeJson(logs), secret);
        assert.notInclude(yield* encodeJson(getWorkspaceProjection(runtimeCapabilities(options))), secret);

        const record: RunRecord = {
          id: request.id,
          workspace: secretWorkspace,
          workItem: secretWorkItem,
          operation: "implement",
          harness: name,
          branch: null,
          session: freshSession,
          usage: null,
          status: "running",
          startedAtMillis: 1,
          endedAtMillis: null,
        };
        const recorder = yield* RunRecorder;
        yield* Effect.forEach(output, (event) => recorder.record(record, event));
        const persisted = yield* (yield* RunLedger.RunLedger).events(record.id).pipe(Stream.runCollect);
        assert.notInclude(yield* encodeJson(persisted), secret);
      }).pipe(Effect.provide(engineTestLayer())),
    );
  });
});
