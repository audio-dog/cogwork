import { HarnessName, RunPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { memoryPersistence } from "@tanstack/ai-persistence";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ContextAssembler } from "./context-assembler";
import { CredentialStore } from "./credential-store";
import {
  fullHarnessExecution,
  HarnessError,
  type HarnessExecution,
  type HarnessRunner,
  make,
} from "./harness";
import { SessionStore } from "./session-store";
import { LogProbe } from "./testing/log-probe";

const name = Schema.decodeSync(HarnessName)("unsupported");

const harnessServices = {
  sessionStore: {
    persistence: memoryPersistence(),
    resumeHandle: () => Effect.succeed(null),
    mint: () => Effect.die("unexpected mint"),
  },
  contextAssembler: {
    assemble: () => Effect.die("unexpected context assembly"),
    cleanup: () => Effect.die("unexpected context cleanup"),
  },
  credentialStore: {
    bearerToken: () => Effect.die("unexpected bearer lookup"),
    resolveSource: () => Effect.die("unexpected credential source resolution"),
    persist: () => Effect.die("unexpected credential persistence"),
    invalidate: () => Effect.die("unexpected credential invalidation"),
    providerKey: () => Effect.die("unexpected provider key lookup"),
    persistProviderKey: () => Effect.die("unexpected provider key persistence"),
    configureConnection: () => Effect.die("unexpected Connection configuration"),
    removeConnection: () => Effect.die("unexpected Connection removal"),
  },
  fileSystem: FileSystem.makeNoop({}),
};

const harnessRunnerLayer = Layer.mergeAll(
  Layer.succeed(SessionStore, harnessServices.sessionStore),
  Layer.succeed(ContextAssembler, harnessServices.contextAssembler),
  Layer.succeed(CredentialStore, harnessServices.credentialStore),
  Layer.succeed(FileSystem.FileSystem, harnessServices.fileSystem),
  Path.layer,
  FetchHttpClient.layer,
);

const controlledRunnerDefaults = {
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "runtime-host", fork: false, humanAttach: "codex-cli" },
    structuredOutput: "none",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: true,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "controlled login" },
  catalog: {
    models: [{ value: "controlled", label: "Controlled" }],
  },
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "Controlled runner is ready" },
      installation: { status: "installed", version: "1.0.0" },
      compatibility: { status: "compatible", requirement: ">=1" },
      authentication: { mode: "host", status: "available", diagnostic: "controlled login is available" },
      diagnostics: [],
    }),
  preflight: () => Effect.void,
} satisfies Pick<HarnessRunner, "authentication" | "capabilities" | "catalog" | "preflight" | "readiness">;

const request = {
  plan: Schema.decodeSync(RunPlan)({
    id: "run-harness-test",
    operation: "triage",
    harness: { name, model: null, options: {}, profile: "read-only" },
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
    hooks: [],
    middleware: [],
    structuredOutput: null,
    connections: [],
    messages: [{ role: "user", content: "triage the issue" }],
    workContext: {
      reference: { workItem: "#1", url: null },
      prose: { body: "", comments: [] },
      facts: {
        assignees: [],
        openBlockers: 0,
        claim: null,
        priority: "medium",
      },
      observation: { generation: 1, observedAtMillis: 1 },
    },
    sandbox: { workspace: "/repo", policy: "read-only" },
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
};

const requestFor = (harness: typeof name, model: string | null = null) => ({
  ...request,
  plan: new RunPlan({
    ...request.plan,
    harness: { ...request.plan.harness, name: harness, model },
  }),
});

describe("Harness", () => {
  it.layer(Layer.merge(harnessRunnerLayer, LogProbe.captureLayer))((it) => {
    it.effect("logs each Harness launch and exit once", () => {
      const failure = new HarnessError({
        reason: "turn",
        retryable: true,
        message: "turn failed",
      });
      const runs = [
        { stream: Stream.empty, outcome: "success" },
        { stream: Stream.fail(failure), outcome: "failure" },
        { stream: Stream.fromEffect(Effect.interrupt), outcome: "interrupt" },
      ] satisfies ReadonlyArray<{
        readonly stream: Stream.Stream<never, HarnessError>;
        readonly outcome: "success" | "failure" | "interrupt";
      }>;

      return Effect.gen(function* () {
        const logs = yield* LogProbe;
        yield* Effect.forEach(
          runs,
          (run) => {
            const runner = {
              ...controlledRunnerDefaults,
              name,
              sessionKind: "opaque-handle",
              projectedMembers: [],
              planMiddleware: [],
              execution: fullHarnessExecution,
              run: () => run.stream,
            } satisfies HarnessRunner;
            return make([runner]).run(request).pipe(Stream.runDrain, Effect.exit);
          },
          { discard: true },
        );

        assert.deepStrictEqual(
          (yield* logs.entries).map(({ message }) => message),
          runs.flatMap(({ outcome }) => [
            ["launched Harness", { harness: name }],
            ["exited Harness", { harness: name, outcome }],
          ]),
        );
      });
    });
  });

  it.layer(harnessRunnerLayer)((it) => {
    it("serves the managed catalog with one provenance shape", () => {
      const runner = {
        ...controlledRunnerDefaults,
        name,
        sessionKind: "opaque-handle",
        projectedMembers: [],
        planMiddleware: [],
        execution: fullHarnessExecution,
        catalog: {
          models: [{ value: "managed-model", label: "Managed model" }],
        },
        run: () => Stream.empty,
      } satisfies HarnessRunner;
      const catalog = make([runner]).catalogs.get(name);

      assert.isNotNull(catalog);
      if (!catalog) return;
      assert.deepStrictEqual(catalog.models, [{ value: "managed-model", label: "Managed model" }]);
      assert.deepStrictEqual(catalog.provenance, { source: "managed" });
    });

    it.effect("rejects saved model options when the current model omits the control", () =>
      Effect.gen(function* () {
        const launches: Array<true> = [];
        const runner = {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          catalog: {
            models: [{ value: "managed-model", label: "Managed model" }],
          },
          run: () => {
            launches.push(true);
            return Stream.empty;
          },
        } satisfies HarnessRunner;
        const harness = make([runner]);
        const configured = {
          ...request,
          plan: new RunPlan({
            ...request.plan,
            harness: { ...request.plan.harness, model: "managed-model", options: { effort: "high" } },
          }),
        };
        const error = yield* harness.run(configured).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "stale-selection");
        assert.include(error.message, 'model option effort="high"');
        assert.deepStrictEqual(launches, []);
      }),
    );

    it.effect("does not fall back from unavailable selected authentication", () =>
      Effect.gen(function* () {
        const launches: Array<true> = [];
        const runner = {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          capabilities: {
            ...controlledRunnerDefaults.capabilities,
            authenticationModes: ["host", "byok"],
          },
          readiness: () =>
            Effect.succeed({
              operational: { status: "ready", retryable: false, diagnostic: "Controlled runner is ready" },
              installation: { status: "installed", version: "1" },
              compatibility: { status: "compatible", requirement: ">=1" },
              authentication: {
                mode: "host",
                status: "unavailable",
                diagnostic: "Run `controlled login`.",
              },
              diagnostics: [],
            }),
          preflight: () =>
            Effect.fail(
              new HarnessError({
                reason: "credential",
                retryable: false,
                message: "Run `controlled login`.",
              }),
            ),
          run: () => {
            launches.push(true);
            return Stream.empty;
          },
        } satisfies HarnessRunner;
        const harness = make([runner]);
        const readiness = yield* harness.readiness(name);
        const error = yield* harness.run(request).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(harness.capabilities(name)?.session.affinity, "runtime-host");
        assert.isTrue(harness.capabilities(name)?.authenticationModes.includes("byok"));
        assert.strictEqual(readiness.authentication.mode, "host");
        assert.strictEqual(error.reason, "credential");
        assert.strictEqual(error.message, "Run `controlled login`.");
        assert.deepStrictEqual(launches, []);
      }),
    );

    it.effect("turns missing installation and incompatible versions into setup failures", () =>
      Effect.gen(function* () {
        const cases = [
          {
            expected: "missing-harness",
            installation: { status: "missing", version: null },
            compatibility: { status: "unknown", requirement: null },
            diagnostic: "Install Controlled Harness.",
          },
          {
            expected: "incompatible-harness",
            installation: { status: "installed", version: "1" },
            compatibility: { status: "incompatible", requirement: ">=2" },
            diagnostic: "Update Controlled Harness to version 2.",
          },
        ] as const;

        for (const testCase of cases) {
          const runner = {
            ...controlledRunnerDefaults,
            name,
            sessionKind: "opaque-handle",
            projectedMembers: [],
            planMiddleware: [],
            execution: fullHarnessExecution,
            readiness: () =>
              Effect.succeed({
                operational: {
                  status: "unavailable",
                  retryable: false,
                  diagnostic: testCase.diagnostic,
                },
                installation: testCase.installation,
                compatibility: testCase.compatibility,
                authentication: { mode: "host", status: "unknown", diagnostic: "Login state is unknown." },
                diagnostics: [testCase.diagnostic],
              }),
            run: () => Stream.empty,
          } satisfies HarnessRunner;
          const error = yield* make([runner]).preflight(name, "read-only", null).pipe(Effect.flip);

          assert.strictEqual(error.reason, testCase.expected);
          assert.strictEqual(error.message, testCase.diagnostic);
        }
      }),
    );

    it.effect("preserves a launch failure after positive readiness", () => {
      const failure = new HarnessError({
        reason: "launch",
        retryable: true,
        message: "native launch disappeared after readiness",
      });
      const runner = {
        ...controlledRunnerDefaults,
        name,
        sessionKind: "opaque-handle",
        projectedMembers: [],
        planMiddleware: [],
        execution: fullHarnessExecution,
        run: () => Stream.fail(failure),
      } satisfies HarnessRunner;
      const harness = make([runner]);

      return Effect.gen(function* () {
        const error = yield* harness.run(request).pipe(Stream.runDrain, Effect.flip);
        assert.strictEqual(error, failure);
      });
    });

    it.effect("runs static preflight before claim inputs and launch preflight before dispatch", () =>
      Effect.gen(function* () {
        const phases: Array<string> = [];
        const runner = {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          preflight: (input) => Effect.sync(() => phases.push(input._tag)),
          run: () => Stream.empty,
        } satisfies HarnessRunner;
        const harness = make([runner]);

        yield* harness.preflight(name, "read-only", null);
        yield* harness.run(requestFor(name)).pipe(Stream.runDrain);

        assert.deepStrictEqual(phases, ["Static", "Launch"]);
      }),
    );

    it.effect("isolates an unknown Harness without dispatch fallback", () =>
      Effect.gen(function* () {
        const unknown = yield* Schema.decodeEffect(HarnessName)("missing-controlled");
        const launches: Array<true> = [];
        const runner = {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          run: () => {
            launches.push(true);
            return Stream.empty;
          },
        } satisfies HarnessRunner;
        const error = yield* make([runner]).run(requestFor(unknown)).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "unknown-harness");
        assert.deepStrictEqual(launches, []);
      }),
    );

    it.effect("refuses every unsupported hard posture before runner launch", () =>
      Effect.gen(function* () {
        const alternativeName = yield* Schema.decodeEffect(HarnessName)("capable-alternative");
        const postures = [
          {
            expected: "non-interactive",
            execution: { nonInteractive: false, worktreeConfined: true, profiles: ["read-only"] },
          },
          {
            expected: "worktree confinement",
            execution: { nonInteractive: true, worktreeConfined: false, profiles: ["read-only"] },
          },
          {
            expected: "read-only operation posture",
            execution: { nonInteractive: true, worktreeConfined: true, profiles: [] },
          },
        ] satisfies ReadonlyArray<{ readonly expected: string; readonly execution: HarnessExecution }>;

        for (const posture of postures) {
          const harness = make([
            {
              ...controlledRunnerDefaults,
              name,
              sessionKind: "opaque-handle",
              projectedMembers: [],
              planMiddleware: [],
              execution: posture.execution,
              run: () => Stream.die("selected incapable Harness launched"),
            },
            {
              ...controlledRunnerDefaults,
              name: alternativeName,
              sessionKind: "opaque-handle",
              projectedMembers: [],
              planMiddleware: [],
              execution: fullHarnessExecution,
              run: () => Stream.die("alternative Harness launched"),
            },
          ]);
          const error = yield* harness.run(request).pipe(Stream.runDrain, Effect.flip);

          assert.match(error.message, new RegExp(`unsupported.*${posture.expected}`));
          assert.strictEqual(error.reason, "policy");
        }
      }),
    );

    it.effect("accepts a Full profile without a worktree-confinement claim", () =>
      Effect.gen(function* () {
        const harness = make([
          {
            ...controlledRunnerDefaults,
            name,
            sessionKind: "opaque-handle",
            projectedMembers: [],
            planMiddleware: [],
            execution: { nonInteractive: true, worktreeConfined: false, profiles: ["full"] },
            run: () => Stream.empty,
          },
        ]);

        yield* harness.preflight(name, "full", null);
      }),
    );

    it.effect("uses runner services from the caller context", () => {
      const providedCredentialStore = { ...harnessServices.credentialStore };
      const harness = make([
        {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: {
            nonInteractive: true,
            worktreeConfined: true,
            profiles: ["read-only"],
          },
          run: () =>
            Stream.fromEffect(
              Effect.map(CredentialStore, (credentials) => {
                assert.strictEqual(credentials, providedCredentialStore);
                return { type: "RUN_STARTED" };
              }),
            ),
        },
      ]);

      return harness
        .run(request)
        .pipe(Stream.runDrain, Effect.provideService(CredentialStore, providedCredentialStore));
    });
  });
});
