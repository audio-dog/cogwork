import { RequestError } from "@agentclientprotocol/sdk";
import {
  AgUiEvent,
  agUiIsStructuredOutputComplete,
  agUiUsage,
  HarnessName,
  RunPlan,
  SessionId,
  stageResultJsonSchema,
} from "@cogwork/contracts";
import { ContextAssembler, CredentialStore, Harness, SessionStore } from "@cogwork/engine";
import { assert, describe, it, layer } from "@effect/vitest";
import type { AcpJsonRpcStream } from "@tanstack/ai-acp";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  cursorDiagnostics,
  cursorModelOptions,
  cursorRunner,
  estimatedUsage,
  interceptCursorTelemetry,
} from "./harness";
import { cursorModels } from "./models.generated";

type AcpMessage = AcpJsonRpcStream extends { readable: ReadableStream<infer Message> } ? Message : never;

const cursorName = Schema.decodeSync(HarnessName)("cursor");
const resumedSessionId = Schema.decodeSync(SessionId)("sess-cursor-resume");

const decodeObservation = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      instructions: Schema.String,
      model: Schema.String,
      mcp: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          url: Schema.String,
          authenticated: Schema.Boolean,
        }),
      ),
    }),
  ),
);

const sessionStore: SessionStore.SessionStoreService = {
  persistence: memoryPersistence(),
  resumeHandle: () => Effect.succeed(null),
  mint: () => Effect.die(new Error("unexpected mint")),
};

const unexpected = () => Effect.die(new Error("unexpected service access"));

const harnessServices = {
  sessionStore,
  contextAssembler: { assemble: unexpected, cleanup: unexpected },
  credentialStore: {
    bearerToken: unexpected,
    resolveSource: unexpected,
    persist: unexpected,
    invalidate: unexpected,
    providerKey: unexpected,
    persistProviderKey: unexpected,
    configureConnection: unexpected,
    removeConnection: unexpected,
  },
  fileSystem: FileSystem.makeNoop({
    access: () => Effect.void,
    stat: () => Effect.succeed({ type: "Directory" } as FileSystem.File.Info),
  }),
};

const harnessRunnerLayer = Layer.mergeAll(
  Layer.succeed(SessionStore.SessionStore, harnessServices.sessionStore),
  Layer.succeed(ContextAssembler.ContextAssembler, harnessServices.contextAssembler),
  Layer.succeed(CredentialStore.CredentialStore, harnessServices.credentialStore),
  Layer.succeed(FileSystem.FileSystem, harnessServices.fileSystem),
  FetchHttpClient.layer,
);

const request = (checkoutPath: string) =>
  ({
    plan: Schema.decodeSync(RunPlan)({
      id: "run-cursor-test",
      operation: "triage",
      harness: { name: cursorName, model: "auto", effort: null, profile: "read-only" },
      instructions: [],
      operatingInstructions: {
        name: "triage-agent",
        path: "/operating-instructions/triage-agent",
        resources: [],
      },
      tools: [],
      skills: [],
      mcp: [],
      subagents: [],
      commands: [],
      hooks: [],
      middleware: ["sandbox"],
      structuredOutput:
        stageResultJsonSchema("triage")?.["~standard"].jsonSchema.input({
          target: "draft-2020-12",
        }) ?? null,
      connections: [],
      messages: [{ role: "user", content: "triage the issue" }],
      workContext: {
        reference: { workItem: "#1", url: null },
        facts: { roles: [], assignees: [], openBlockers: 0, claim: null, priority: "medium", pr: null },
        observation: { generation: 1, observedAtMillis: 1 },
      },
      sandbox: { workspace: checkoutPath, policy: "read-only" },
      persistence: { sessionKind: "opaque-handle" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection: [],
        observation: { generation: 1, observedAtMillis: 1 },
      },
    }),
    session: null,
    mcpCredentials: new Map(),
  }) satisfies Harness.HarnessRequest;

const fakeCursorAgent = new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url).pathname;

describe("Cursor Harness registry", () => {
  it.effect("uses the generated model tuple for the catalog and every supported effort", () =>
    Effect.gen(function* () {
      const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });
      const catalog = yield* Harness.make([runner]).catalog(cursorName);

      assert.deepStrictEqual(
        catalog.models.map(({ value }) => value),
        Array.from(cursorModels),
      );
      assert.isTrue(catalog.efforts?.some(({ value }) => value === "none"));
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("reports outdated and missing native Harnesses", () =>
    Effect.gen(function* () {
      const outdated = cursorRunner({
        name: cursorName,
        agentBin: `node ${fakeCursorAgent} --fake-version=2025.01.01-old`,
      });
      const missing = cursorRunner({ name: cursorName, agentBin: "missing-cursor-agent-149" });

      const outdatedReadiness = yield* outdated.readiness();
      const missingReadiness = yield* missing.readiness();

      assert.strictEqual(outdatedReadiness.compatibility.status, "incompatible");
      assert.strictEqual(outdatedReadiness.compatibility.requirement, ">=2026.08.11");
      assert.strictEqual(missingReadiness.installation.status, "missing");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects stale model and effort selections before launch", () =>
    Effect.gen(function* () {
      const harness = Harness.make([cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` })]);
      const staleModel = yield* harness
        .preflight(cursorName, "full", "retired-cursor-model", "high")
        .pipe(Effect.flip);
      const staleEffort = yield* harness.preflight(cursorName, "full", "auto", "extreme").pipe(Effect.flip);

      assert.strictEqual(staleModel.reason, "stale-selection");
      assert.strictEqual(staleEffort.reason, "stale-selection");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects a Run Plan without mandatory Sandbox projection", () =>
    Effect.gen(function* () {
      const base = request("/tmp");
      const invalid = {
        ...base,
        plan: new RunPlan({ ...base.plan, middleware: [] }),
      } satisfies Harness.HarnessRequest;
      const runner = cursorRunner({ name: cursorName });

      const error = yield* runner
        .preflight(Harness.HarnessPreflightInput.Launch({ request: invalid }))
        .pipe(Effect.flip);

      assert.strictEqual(error.reason, "sandbox");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects a missing checkout before Cursor launch", () =>
    Effect.gen(function* () {
      const invalid = request("/missing-cursor-checkout");
      const runner = cursorRunner({ name: cursorName });

      const error = yield* runner
        .preflight(Harness.HarnessPreflightInput.Launch({ request: invalid }))
        .pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})), Effect.flip);

      assert.strictEqual(error.reason, "workspace");
      assert.include(error.message, "/missing-cursor-checkout");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects an unreadable checkout before Cursor launch", () =>
    Effect.gen(function* () {
      const invalid = request("/unreadable-cursor-checkout");
      const runner = cursorRunner({ name: cursorName });
      const unreadable = FileSystem.makeNoop({
        stat: () => Effect.succeed({ type: "Directory" } as FileSystem.File.Info),
      });

      const error = yield* runner
        .preflight(Harness.HarnessPreflightInput.Launch({ request: invalid }))
        .pipe(Effect.provideService(FileSystem.FileSystem, unreadable), Effect.flip);

      assert.strictEqual(error.reason, "workspace");
      assert.include(error.message, "cannot read");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );
});

describe("interceptCursorTelemetry", () => {
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

      const messages = yield* Stream.fromReadableStream({
        evaluate: () => interceptCursorTelemetry(base).readable,
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

      const messages = yield* Stream.fromReadableStream({
        evaluate: () => interceptCursorTelemetry(base).readable,
        onError: String,
      }).pipe(Stream.runCollect);

      assert.deepStrictEqual(Array.from(messages), [blockingRequest]);
      assert.deepStrictEqual(replies, [{ jsonrpc: "2.0", id: 1, result: {} }]);
    }),
  );
});

layer(harnessRunnerLayer)("cursorRunner", (it) => {
  it("declares programmatic resume and Cursor's lower runtime fidelity", () => {
    const runner = cursorRunner({ name: cursorName });
    assert.strictEqual(runner.sessionKind, "opaque-handle");
    assert.deepStrictEqual(runner.capabilities.authenticationModes, ["host"]);
    assert.isFalse(runner.capabilities.session.humanAttach);
    assert.strictEqual(runner.capabilities.structuredOutput, "prompt-and-parse");
    assert.strictEqual(runner.capabilities.policyFidelity, "none");
    assert.strictEqual(runner.capabilities.fileEventFidelity, "none");
    assert.isFalse(runner.capabilities.journal);
    assert.isFalse(runner.capabilities.takeover);
  });

  it.effect("uses host login and the shared mandatory Workspace projection", () =>
    Effect.gen(function* () {
      const checkout = yield* Effect.acquireRelease(
        Effect.promise(() => localProcessSandbox({}).create({})),
        (sandbox) => Effect.promise(() => sandbox.destroy()),
      );
      const base = request(checkout.id);
      const projectedRequest = {
        ...base,
        plan: new RunPlan({
          ...base.plan,
          harness: { ...base.plan.harness, effort: "high" },
          instructions: [{ kind: "repo", source: "repo", content: "Mandatory repository context." }],
          operatingInstructions: {
            name: "triage-agent",
            path: "/operating-instructions/triage-agent",
            resources: [],
          },
          mcp: [
            {
              identity: "local:user/mcp-server/linear",
              name: "linear",
              projectedName: "linear",
              endpoint: "https://mcp.example.test/readonly",
              authenticated: true,
              unavailableReason: null,
            },
          ],
          structuredOutput: null,
        }),
        mcpCredentials: new Map([["local:user/mcp-server/linear", Redacted.make("cursor-mcp-secret")]]),
      } satisfies Harness.HarnessRequest;
      const runner = cursorRunner({
        name: cursorName,
        agentBin: `node ${fakeCursorAgent} --observe`,
      });

      const events = yield* Stream.runCollect(Harness.make([runner]).run(projectedRequest));
      const output = Array.from(events)
        .filter(AgUiEvent.guards.TEXT_MESSAGE_CONTENT)
        .map(({ delta }) => delta ?? "")
        .join("");
      const observation = decodeObservation(output);

      assert.include(observation.instructions, "Mandatory repository context.");
      assert.include(observation.instructions, "/operating-instructions/triage-agent");
      assert.strictEqual(observation.model, "auto[effort=high]");
      assert.deepStrictEqual(observation.mcp, [
        {
          name: "linear",
          url: "https://mcp.example.test/readonly",
          authenticated: true,
        },
      ]);
      assert.notInclude(output, "cursor-mcp-secret");
    }),
  );

  it.effect("streams a fresh ACP session, parsed structured result, and estimated terminal usage", () =>
    Effect.gen(function* () {
      const checkout = yield* Effect.acquireRelease(
        Effect.promise(() => localProcessSandbox({}).create({})),
        (sandbox) => Effect.promise(() => sandbox.destroy()),
      );
      const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });

      const events = yield* Stream.runCollect(Harness.make([runner]).run(request(checkout.id)));
      const session = Array.from(events).find(
        (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
      );
      const structured = Array.from(events).find(agUiIsStructuredOutputComplete);
      const finished = events.at(-1);

      assert.deepStrictEqual(session?.value, { sessionId: "fake-cursor-session" });
      assert.deepStrictEqual(structured?.value.object, {
        _tag: "triage",
        role: "ready-for-agent",
        proposal: "Verified and ready.",
      });
      assert.strictEqual(finished?.type, "RUN_FINISHED");
      assert.isDefined(finished);
      assert.isTrue(agUiUsage(finished)?.estimated);
    }),
  );

  it.effect("projects the persisted opaque handle through modelOptions.sessionId", () =>
    Effect.gen(function* () {
      const checkout = yield* Effect.acquireRelease(
        Effect.promise(() => localProcessSandbox({}).create({})),
        (sandbox) => Effect.promise(() => sandbox.destroy()),
      );
      const resumeHandle = "persisted-cursor-session";
      const resumedRequest = {
        ...request(checkout.id),
        session: resumedSessionId,
      } satisfies Harness.HarnessRequest;
      const resumedStore = { ...sessionStore, resumeHandle: () => Effect.succeed(resumeHandle) };
      const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });

      const events = yield* Stream.runCollect(
        Harness.make([runner])
          .run(resumedRequest)
          .pipe(Stream.provideService(SessionStore.SessionStore, resumedStore)),
      );
      const session = Array.from(events).find(
        (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
      );

      assert.deepStrictEqual(session?.value, { sessionId: resumeHandle });
    }),
  );

  it.effect("preserves metered ACP usage instead of estimating it", () =>
    Effect.gen(function* () {
      const checkout = yield* Effect.acquireRelease(
        Effect.promise(() => localProcessSandbox({}).create({})),
        (sandbox) => Effect.promise(() => sandbox.destroy()),
      );
      const runner = cursorRunner({
        name: cursorName,
        agentBin: `node ${fakeCursorAgent} --metered`,
      });

      const events = yield* Stream.runCollect(Harness.make([runner]).run(request(checkout.id)));
      const finished = events.at(-1);

      assert.deepStrictEqual(finished && agUiUsage(finished), {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      });
    }),
  );
});

describe("cursorDiagnostics", () => {
  it("keeps unrecognized failures retryable without reading launch words from the message", () => {
    const error = cursorDiagnostics(new Error("model output says command not found"));
    assert.strictEqual(error.reason, "turn");
    assert.isTrue(error.retryable);
  });

  it("makes missing executables non-retryable launch failures", () => {
    const error = cursorDiagnostics(Object.assign(new Error("Cursor could not start"), { code: "ENOENT" }));
    assert.strictEqual(error.reason, "launch");
    assert.isFalse(error.retryable);
  });

  it("makes unavailable ACP authentication non-retryable", () => {
    const error = cursorDiagnostics(RequestError.authRequired());
    assert.strictEqual(error.reason, "credential");
    assert.isFalse(error.retryable);
    assert.include(error.message, "Sign in to Cursor");
  });

  it("preserves ACP retry classification", () => {
    assert.isTrue(cursorDiagnostics(RequestError.internalError({}, "temporary")).retryable);
    assert.isFalse(cursorDiagnostics(RequestError.methodNotFound("session/prompt")).retryable);
  });
});

describe("cursorModelOptions", () => {
  it("turns a resolved handle into Cursor's resume sessionId", () => {
    assert.deepStrictEqual(cursorModelOptions("cursor-abc", null), { sessionId: "cursor-abc" });
  });

  it("omits sessionId when there is no handle to resume from", () => {
    assert.deepStrictEqual(cursorModelOptions(null, "high"), { effort: "high" });
  });

  it("is empty when the run neither resumes nor sets an effort", () => {
    assert.deepStrictEqual(cursorModelOptions(null, null), {});
  });
});

describe("estimatedUsage", () => {
  it("counts tokens as ceil(chars / 4) and marks the result estimated", () => {
    assert.deepStrictEqual(estimatedUsage(40, 20), {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: true,
    });
  });

  it("rounds partial tokens up so any output still shows a count", () => {
    assert.deepStrictEqual(estimatedUsage(3, 1), {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      estimated: true,
    });
  });
});
