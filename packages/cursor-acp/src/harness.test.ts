import {
  AgUiEvent,
  agUiIsStructuredOutputComplete,
  agUiUsage,
  HarnessName,
  RunPlan,
  SessionId,
} from "@cogwork/contracts";
import { ContextAssembler, CredentialStore, Harness, SessionStore } from "@cogwork/engine";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it, layer } from "@effect/vitest";
import type { AcpJsonRpcStream } from "@tanstack/ai-acp";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { cursorModelOptions, cursorRunner, estimatedUsage, interceptCursorTelemetry } from "./harness";
import { cursorCatalog } from "./models.generated";

type AcpMessage = AcpJsonRpcStream extends { readable: ReadableStream<infer Message> } ? Message : never;

const cursorName = Schema.decodeSync(HarnessName)("cursor");
const freshSessionId = Schema.decodeSync(SessionId)("sess-cursor-fresh");
const resumedSessionId = Schema.decodeSync(SessionId)("sess-cursor-resume");

const decodeObservation = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      prompt: Schema.String,
      model: Schema.String,
      mcp: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          url: Schema.String,
          authenticated: Schema.Boolean,
        }),
      ),
      cursorConfigDir: Schema.NullOr(Schema.String),
      windowsEnvironment: Schema.Struct({
        USERPROFILE: Schema.NullOr(Schema.String),
        HOMEDRIVE: Schema.NullOr(Schema.String),
        HOMEPATH: Schema.NullOr(Schema.String),
        APPDATA: Schema.NullOr(Schema.String),
        SYSTEMROOT: Schema.NullOr(Schema.String),
        PATHEXT: Schema.NullOr(Schema.String),
        COMSPEC: Schema.NullOr(Schema.String),
      }),
      networkEnvironment: Schema.Struct({
        HTTP_PROXY: Schema.NullOr(Schema.String),
        HTTPS_PROXY: Schema.NullOr(Schema.String),
        NO_PROXY: Schema.NullOr(Schema.String),
        NODE_USE_ENV_PROXY: Schema.NullOr(Schema.String),
        NODE_EXTRA_CA_CERTS: Schema.NullOr(Schema.String),
      }),
      hasCursorApiKey: Schema.Boolean,
    }),
  ),
);

const decodePermissionOutcome = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ outcome: Schema.String, optionId: Schema.String })),
);

const restoreEnvironment = (name: string, value: string | undefined) =>
  value === undefined ? Reflect.deleteProperty(process.env, name) : Reflect.set(process.env, name, value);

const cursorEnvironmentProbe = {
  CURSOR_CONFIG_DIR: "/tmp/cogwork-cursor-config",
  CURSOR_API_KEY: "inherited-cursor-key",
  USERPROFILE: "C:\\Users\\cogwork",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\cogwork",
  APPDATA: "C:\\Users\\cogwork\\AppData\\Roaming",
  SYSTEMROOT: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  HTTP_PROXY: "http://proxy.example.test:8080",
  HTTPS_PROXY: "https://proxy.example.test:8443",
  NO_PROXY: "localhost,127.0.0.1,.example.test",
  NODE_USE_ENV_PROXY: "1",
  NODE_EXTRA_CA_CERTS: "/tmp/cogwork-enterprise-ca.pem",
};

const cursorWindowsEnvironmentProbe = {
  USERPROFILE: cursorEnvironmentProbe.USERPROFILE,
  HOMEDRIVE: cursorEnvironmentProbe.HOMEDRIVE,
  HOMEPATH: cursorEnvironmentProbe.HOMEPATH,
  APPDATA: cursorEnvironmentProbe.APPDATA,
  SYSTEMROOT: cursorEnvironmentProbe.SYSTEMROOT,
  PATHEXT: cursorEnvironmentProbe.PATHEXT,
  COMSPEC: cursorEnvironmentProbe.COMSPEC,
};

const cursorNetworkEnvironmentProbe = {
  HTTP_PROXY: cursorEnvironmentProbe.HTTP_PROXY,
  HTTPS_PROXY: cursorEnvironmentProbe.HTTPS_PROXY,
  NO_PROXY: cursorEnvironmentProbe.NO_PROXY,
  NODE_USE_ENV_PROXY: cursorEnvironmentProbe.NODE_USE_ENV_PROXY,
  NODE_EXTRA_CA_CERTS: cursorEnvironmentProbe.NODE_EXTRA_CA_CERTS,
};

const withCursorEnvironment = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Object.fromEntries(
        Object.keys(cursorEnvironmentProbe).map((name) => [name, Reflect.get(process.env, name)]),
      ),
    ),
    () => Effect.sync(() => Object.assign(process.env, cursorEnvironmentProbe)).pipe(Effect.andThen(effect)),
    (original) =>
      Effect.sync(() => Object.entries(original).map(([name, value]) => restoreEnvironment(name, value))),
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
  Path.layer,
  FetchHttpClient.layer,
);

const request = (checkoutPath: string, operation = "operate") => {
  const profile = "read-only" as const;
  return {
    plan: Schema.decodeSync(RunPlan)({
      id: "run-cursor-test",
      operation,
      harness: {
        name: cursorName,
        model: "auto",
        options: {},
        profile,
      },
      instructions: [],
      operatingInstructions: {
        name: `${operation}-agent`,
        path: `/operating-instructions/${operation}-agent`,
        resources: [],
      },
      tools: [],
      skills: [],
      mcp: [],
      subagents: [],
      hooks: [],
      middleware: ["sandbox"],
      structuredOutput: { type: "object" },
      connections: [],
      messages: [{ role: "user", content: "triage the issue" }],
      workContext: {
        reference: { workItem: "#1", url: null },
        prose: { body: "", comments: [] },
        facts: { assignees: [], openBlockers: 0, claim: null, priority: "medium" },
        observation: { generation: 1, observedAtMillis: 1 },
      },
      sandbox: { workspace: checkoutPath, policy: profile },
      persistence: { sessionKind: "opaque-handle" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection: [],
        observation: { generation: 1, observedAtMillis: 1 },
      },
    }),
    session: freshSessionId,
    mcpCredentials: new Map(),
  } satisfies Harness.HarnessRequest;
};

const fakeCursorAgent = new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url).pathname;

describe("Cursor Harness registry", { timeout: 30_000 }, () => {
  it("serves generated base models and option descriptors", () => {
    const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });
    const catalog = Harness.make([runner]).catalogs.get(cursorName);

    assert.isNotNull(catalog);
    if (!catalog) return;
    assert.deepStrictEqual(catalog.models, cursorCatalog.models);
    assert.isTrue(catalog.models.some(({ options }) => options?.some(({ id }) => id === "effort")));
    assert.strictEqual(catalog.generatedAgainst, cursorCatalog.generatedAgainst);
    assert.deepStrictEqual(catalog.rawModelIds, cursorCatalog.rawModelIds);
    assert.deepStrictEqual(catalog.rawModelSelections, cursorCatalog.rawModelSelections);
    assert.deepStrictEqual(catalog.provenance, { source: "managed" });
  });

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
      assert.isTrue(
        outdatedReadiness.diagnostics.some((diagnostic) =>
          diagnostic.includes("catalog was generated against"),
        ),
      );
      assert.strictEqual(missingReadiness.installation.status, "missing");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects stale model and model option selections before launch", () =>
    Effect.gen(function* () {
      const harness = Harness.make([cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` })]);
      const staleModel = yield* harness
        .preflight(cursorName, "full", "retired-cursor-model", { effort: "high" })
        .pipe(Effect.flip);
      const staleOption = yield* harness
        .preflight(cursorName, "full", "gpt-5.6-sol", { effort: "extreme" })
        .pipe(Effect.flip);
      const staleComposite = yield* harness
        .preflight(cursorName, "full", "gpt-5.6-luna-high")
        .pipe(Effect.flip);

      assert.strictEqual(staleModel.reason, "stale-selection");
      assert.strictEqual(staleOption.reason, "stale-selection");
      assert.strictEqual(staleComposite.reason, "stale-selection");
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

      const error = yield* Harness.make([runner])
        .run(invalid)
        .pipe(
          Stream.runDrain,
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
          Effect.flip,
        );

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

      const error = yield* Harness.make([runner])
        .run(invalid)
        .pipe(Stream.runDrain, Effect.provideService(FileSystem.FileSystem, unreadable), Effect.flip);

      assert.strictEqual(error.reason, "workspace");
      assert.include(error.message, "cannot read");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );
});

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

layer(harnessRunnerLayer)("cursorRunner", (it) => {
  it("declares programmatic resume, Tools and Skills, and Cursor's lower runtime fidelity", () => {
    const runner = cursorRunner({ name: cursorName });
    assert.strictEqual(runner.sessionKind, "opaque-handle");
    assert.includeMembers([...runner.projectedMembers], ["Tools", "Skills"]);
    assert.deepStrictEqual(runner.capabilities.authenticationModes, ["host"]);
    assert.isFalse(runner.capabilities.session.humanAttach);
    assert.strictEqual(runner.capabilities.structuredOutput, "prompt-and-parse");
    assert.strictEqual(runner.capabilities.policyFidelity, "none");
    assert.strictEqual(runner.capabilities.fileEventFidelity, "absent");
    assert.isFalse(runner.capabilities.journal);
    assert.isFalse(runner.capabilities.takeover);
    assert.isTrue(runner.execution.nonInteractive);
    assert.isFalse(runner.execution.worktreeConfined);
    assert.deepStrictEqual(runner.execution.profiles, ["full"]);
  });

  it.effect(
    "accepts Full and rejects Read only before launching Cursor",
    () =>
      Effect.gen(function* () {
        const harness = Harness.make([
          cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` }),
        ]);
        const readOnly = yield* harness.preflight(cursorName, "read-only", "auto").pipe(Effect.flip);

        assert.strictEqual(readOnly.reason, "policy");
        assert.include(readOnly.message, "read-only operation posture");
        yield* harness.preflight(cursorName, "full", "auto");
      }),
    30_000,
  );

  it.effect(
    "uses host login and projects instructions without touching repo instruction files",
    () =>
      withCursorEnvironment(
        Effect.gen(function* () {
          const checkout = yield* Effect.acquireRelease(
            Effect.promise(() => localProcessSandbox({}).create({})),
            (sandbox) => Effect.promise(() => sandbox.destroy()),
          );
          yield* Effect.promise(() => checkout.fs.write("AGENTS.md", "existing repo agents\n"));
          yield* Effect.promise(() => checkout.fs.write("CLAUDE.md", "existing repo claude\n"));
          const base = request(checkout.id);
          const projectedRequest = {
            ...base,
            plan: new RunPlan({
              ...base.plan,
              harness: {
                ...base.plan.harness,
                model: "gpt-5.6-sol",
                options: { effort: "high" },
              },
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

          const events = yield* Stream.runCollect(runner.run(projectedRequest));
          const output = Array.from(events)
            .filter(AgUiEvent.guards.TEXT_MESSAGE_CONTENT)
            .map(({ delta }) => delta ?? "")
            .join("");
          const observation = decodeObservation(output);

          assert.include(observation.prompt, "Mandatory repository context.");
          assert.include(observation.prompt, "/operating-instructions/triage-agent");
          assert.strictEqual(observation.model, "gpt-5.6-sol-high");
          assert.deepStrictEqual(observation.mcp, [
            {
              name: "linear",
              url: "https://mcp.example.test/readonly",
              authenticated: true,
            },
          ]);
          assert.strictEqual(observation.cursorConfigDir, cursorEnvironmentProbe.CURSOR_CONFIG_DIR);
          assert.deepStrictEqual(observation.windowsEnvironment, cursorWindowsEnvironmentProbe);
          assert.deepStrictEqual(observation.networkEnvironment, cursorNetworkEnvironmentProbe);
          assert.isFalse(observation.hasCursorApiKey);
          assert.notInclude(output, "cursor-mcp-secret");
          assert.strictEqual(
            yield* Effect.promise(() => checkout.fs.read("AGENTS.md")),
            "existing repo agents\n",
          );
          assert.strictEqual(
            yield* Effect.promise(() => checkout.fs.read("CLAUDE.md")),
            "existing repo claude\n",
          );
        }),
      ),
    30_000,
  );

  it.effect(
    "refuses a stale model at dispatch",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const base = request(checkout.id);
        const staleRequest = {
          ...base,
          plan: new RunPlan({
            ...base.plan,
            harness: {
              ...base.plan.harness,
              model: "retired-cursor-model",
            },
          }),
        } satisfies Harness.HarnessRequest;
        const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });

        const failure = yield* Stream.runDrain(runner.run(staleRequest)).pipe(Effect.flip);

        assert.strictEqual(failure.reason, "stale-selection");
        assert.include(failure.message, "retired-cursor-model");
      }),
    30_000,
  );

  it.effect(
    "streams a fresh ACP session, parsed structured result, and estimated terminal usage",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });

        const events = yield* Stream.runCollect(runner.run(request(checkout.id)));
        const session = Array.from(events).find(
          (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
        );
        const structured = Array.from(events).find(agUiIsStructuredOutputComplete);
        const finished = events.at(-1);

        assert.deepStrictEqual(session?.value, { sessionId: "fake-cursor-session" });
        assert.deepNestedInclude(
          Array.from(events).find((event) => event.type === "RUN_STARTED"),
          { runId: "run-cursor-test", threadId: freshSessionId },
        );
        assert.deepStrictEqual(structured?.value.object, {
          _tag: "triage",
          role: "ready-for-agent",
          proposal: "Verified and ready.",
        });
        assert.strictEqual(finished?.type, "RUN_FINISHED");
        assert.isDefined(finished);
        assert.isTrue(agUiUsage(finished)?.estimated);
      }),
    30_000,
  );

  it.effect(
    "projects the persisted opaque handle through modelOptions.sessionId",
    () =>
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
          runner.run(resumedRequest).pipe(Stream.provideService(SessionStore.SessionStore, resumedStore)),
        );
        const session = Array.from(events).find(
          (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
        );

        assert.deepStrictEqual(session?.value, { sessionId: resumeHandle });
        assert.deepNestedInclude(
          Array.from(events).find((event) => event.type === "RUN_STARTED"),
          { runId: "run-cursor-test", threadId: resumedSessionId },
        );
      }),
    30_000,
  );

  it.effect(
    "preserves metered ACP usage instead of estimating it",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --metered`,
        });

        const events = yield* Stream.runCollect(runner.run(request(checkout.id)));
        const finished = events.at(-1);

        assert.deepStrictEqual(finished && agUiUsage(finished), {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        });
      }),
    30_000,
  );

  it.effect(
    "refuses a blocking Cursor extension without hanging the turn",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --blocking-extension`,
        });

        const events = yield* Stream.runCollect(runner.run(request(checkout.id)));

        assert.isTrue(Array.from(events).some(agUiIsStructuredOutputComplete));
        assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
      }),
    30_000,
  );

  it.effect(
    "allows a command Cursor asks permission for, because a headless Run has nobody to answer",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const base = request(checkout.id);
        const fullRequest = {
          ...base,
          plan: new RunPlan({
            ...base.plan,
            harness: { ...base.plan.harness, profile: "full" },
            sandbox: { ...base.plan.sandbox, policy: "full" },
          }),
        } satisfies Harness.HarnessRequest;
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --request-command-permission`,
        });

        const events = yield* Stream.runCollect(runner.run(fullRequest));
        const output = Array.from(events)
          .filter(AgUiEvent.guards.TEXT_MESSAGE_CONTENT)
          .map(({ delta }) => delta ?? "")
          .join("");

        assert.deepStrictEqual(decodePermissionOutcome(output), {
          outcome: "selected",
          optionId: "allow-once",
        });
      }),
    30_000,
  );

  it.effect(
    "exposes a new handle when ACP silently falls back after rejected load",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const resumedRequest = {
          ...request(checkout.id),
          session: resumedSessionId,
        } satisfies Harness.HarnessRequest;
        const resumedStore = {
          ...sessionStore,
          resumeHandle: () => Effect.succeed("missing-cursor-session"),
        };
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --reject-load`,
        });

        const events = yield* Stream.runCollect(
          runner.run(resumedRequest).pipe(Stream.provideService(SessionStore.SessionStore, resumedStore)),
        );
        const session = Array.from(events).find(
          (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
        );

        assert.deepStrictEqual(session?.value, { sessionId: "fake-cursor-session" });
      }),
    30_000,
  );

  it.effect(
    "surfaces post-launch transport failures through the Harness runner",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({ name: cursorName, agentBin: "missing-cursor-agent-151" });

        const error = yield* runner.run(request(checkout.id)).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
      }),
    30_000,
  );

  it.effect(
    "probes an authenticated Cursor Run that loads a Run Plan Skill through load_skill when enabled",
    () =>
      Effect.gen(function* () {
        const enabled = yield* Config.string("COGWORK_LIVE_CURSOR_PROBE").pipe(Config.withDefault("0"));
        if (enabled !== "1") return;
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-cursor-probe-checkout-" });
        const skillRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-cursor-probe-skill-" });
        const skillFile = `${skillRoot}/SKILL.md`;
        yield* fs.writeFileString(
          skillFile,
          "---\nname: probe-canary\ndescription: Holds the secret word for the Cursor probe.\n---\nThe secret word is PERIWINKLE-42.",
        );
        const base = request(checkout);
        const probeRequest = {
          ...base,
          plan: new RunPlan({
            ...base.plan,
            harness: { ...base.plan.harness, profile: "full" },
            sandbox: { workspace: checkout, policy: "full" },
            skills: [{ identity: "local:repo/skill/probe-canary", name: "probe-canary", source: skillFile }],
            messages: [
              {
                role: "user",
                content:
                  "Load the Skill named probe-canary with the load_skill tool. Reply with only the secret word that Skill holds.",
              },
            ],
            structuredOutput: null,
          }),
        } satisfies Harness.HarnessRequest;

        const events = yield* Harness.make([cursorRunner({ name: cursorName })])
          .run(probeRequest)
          .pipe(Stream.runCollect, Effect.timeout("3 minutes"));
        const answer = Array.from(events)
          .filter(AgUiEvent.guards.TEXT_MESSAGE_CONTENT)
          .map(({ delta }) => delta ?? "")
          .join("");

        assert.include(answer, "PERIWINKLE-42");
        assert.deepStrictEqual(yield* fs.readDirectory(checkout), []);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    // A real Cursor turn with a bridged tool call; the 5-second vitest default can never fit it.
    240_000,
  );
});

describe("cursorModelOptions", () => {
  it("turns a resolved handle into Cursor's resume sessionId", () => {
    assert.deepStrictEqual(cursorModelOptions("cursor-abc"), { sessionId: "cursor-abc" });
  });

  it("omits sessionId when there is no handle to resume from", () => {
    assert.deepStrictEqual(cursorModelOptions(null), {});
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
