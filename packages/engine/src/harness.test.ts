import { HarnessName, RunPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { memoryPersistence } from "@tanstack/ai-persistence";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ContextAssembler } from "./context-assembler";
import { CredentialStore } from "./credential-store";
import {
  fullHarnessExecution,
  type HarnessCatalogSource,
  HarnessError,
  type HarnessExecution,
  type HarnessRunner,
  make,
  stageResultSchema,
  staticCatalogSource,
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
  catalogSources: {
    fallback: staticCatalogSource(
      { models: [{ value: "controlled", label: "Controlled" }] },
      { source: "cogwork-fallback", fallbackVersion: "1" },
    ),
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
} satisfies Pick<
  HarnessRunner,
  "authentication" | "capabilities" | "catalogSources" | "preflight" | "readiness"
>;

const request = {
  plan: Schema.decodeSync(RunPlan)({
    id: "run-harness-test",
    operation: "triage",
    harness: { name, model: null, effort: null, profile: "read-only" },
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
    middleware: [],
    structuredOutput: null,
    connections: [],
    messages: [{ role: "user", content: "triage the issue" }],
    workContext: {
      reference: { workItem: "#1", url: null },
      facts: {
        roles: [],
        assignees: [],
        openBlockers: 0,
        claim: null,
        priority: "medium",
        pr: null,
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

const requestFor = (harness: typeof name, model: string | null = null, effort: string | null = null) => ({
  ...request,
  plan: new RunPlan({
    ...request.plan,
    harness: { ...request.plan.harness, name: harness, model, effort },
  }),
});

const unavailableCatalogSource = {
  catalog: Effect.succeed(null),
} satisfies HarnessCatalogSource;

describe("stageResultSchema", () => {
  it.effect("prepares the triage result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("triage");

      const jsonSchema = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      const root = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          type: Schema.Literal("object"),
          properties: Schema.Record(Schema.String, Schema.Unknown),
          required: Schema.Array(Schema.String),
        }),
      )(jsonSchema);
      assert.hasAllKeys(root.properties, ["_tag", "role", "proposal"]);
      assert.deepStrictEqual([...root.required].sort(), ["_tag", "proposal", "role"]);

      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "triage",
            role: "ready-for-agent",
            proposal: "Verified and ready.",
          }),
        ),
      );
      assert.isUndefined(result.issues);

      const invalid = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "triage",
            role: "needs-triage",
            proposal: "Run triage again.",
          }),
        ),
      );
      assert.isDefined(invalid.issues);
    }),
  );

  it.effect("prepares the implement result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("implement");

      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "opened-pr",
            summary: "Opened PR #110.",
            title: null,
            body: null,
          }),
        ),
      );
      assert.isUndefined(result.issues);

      const ready = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "ready-for-pr",
            summary: "Implementation complete.",
            title: "Open pull requests from the engine",
            body: "Closes #474",
          }),
        ),
      );
      assert.isUndefined(ready.issues);

      const invalid = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "opened-pr",
            summary: " ",
            title: null,
            body: null,
          }),
        ),
      );
      assert.isDefined(invalid.issues);
    }),
  );

  it.effect("prepares the follow-up result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("follow-up");

      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "follow-up",
            outcome: "pushed",
            summary: "Fixed the failing check and pushed.",
          }),
        ),
      );
      assert.isUndefined(result.issues);

      const invalid = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "follow-up",
            outcome: "pushed",
            summary: " ",
          }),
        ),
      );
      assert.isDefined(invalid.issues);
    }),
  );
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
    it.effect("uses runtime metadata before native discovery and fallback", () =>
      Effect.gen(function* () {
        const runner = {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          catalogSources: {
            runtime: staticCatalogSource(
              { models: [{ value: "runtime-model", label: "Runtime model" }] },
              { source: "tanstack-runtime", packageVersion: "1.2.3" },
            ),
            native: staticCatalogSource(
              { models: [{ value: "native-model", label: "Native model" }] },
              {
                source: "native-discovery",
                runtimeHost: "host-149",
                harnessVersion: "4.5.6",
              },
            ),
            fallback: staticCatalogSource(
              { models: [{ value: "fallback-model", label: "Fallback model" }] },
              { source: "cogwork-fallback", fallbackVersion: "7" },
            ),
          },
          run: () => Stream.empty,
        } satisfies HarnessRunner;
        const catalog = yield* make([runner]).catalog(name);

        assert.deepStrictEqual(catalog.models, [{ value: "runtime-model", label: "Runtime model" }]);
        assert.deepStrictEqual(catalog.provenance, {
          source: "tanstack-runtime",
          packageVersion: "1.2.3",
        });
      }),
    );

    it.effect("falls through unavailable sources and records native or fallback provenance", () =>
      Effect.gen(function* () {
        const nativeName = yield* Schema.decodeEffect(HarnessName)("native-controlled");
        const fallbackName = yield* Schema.decodeEffect(HarnessName)("fallback-controlled");
        const runners = [
          {
            ...controlledRunnerDefaults,
            name: nativeName,
            sessionKind: "opaque-handle",
            projectedMembers: [],
            planMiddleware: [],
            execution: fullHarnessExecution,
            catalogSources: {
              runtime: unavailableCatalogSource,
              native: staticCatalogSource(
                { models: [{ value: "native", label: "Native" }] },
                {
                  source: "native-discovery",
                  runtimeHost: "host-149",
                  harnessVersion: "2",
                },
              ),
              fallback: controlledRunnerDefaults.catalogSources.fallback,
            },
            run: () => Stream.empty,
          },
          {
            ...controlledRunnerDefaults,
            name: fallbackName,
            sessionKind: "opaque-handle",
            projectedMembers: [],
            planMiddleware: [],
            execution: fullHarnessExecution,
            catalogSources: {
              runtime: unavailableCatalogSource,
              native: unavailableCatalogSource,
              fallback: controlledRunnerDefaults.catalogSources.fallback,
            },
            run: () => Stream.empty,
          },
        ] satisfies ReadonlyArray<HarnessRunner>;
        const harness = make(runners);
        const native = yield* harness.catalog(nativeName);
        const fallback = yield* harness.catalog(fallbackName);

        assert.strictEqual(native.models[0]?.value, "native");
        assert.strictEqual(native.provenance.source, "native-discovery");
        assert.strictEqual(fallback.models[0]?.value, "controlled");
        assert.strictEqual(fallback.provenance.source, "cogwork-fallback");
      }),
    );

    it.effect("preserves retryable native catalog failures", () =>
      Effect.gen(function* () {
        const launches: Array<true> = [];
        const runner = {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          catalogSources: {
            native: {
              catalog: Effect.fail(
                new HarnessError({
                  reason: "launch",
                  retryable: true,
                  message: "native catalog timed out",
                }),
              ),
            },
            fallback: controlledRunnerDefaults.catalogSources.fallback,
          },
          run: () => {
            launches.push(true);
            return Stream.empty;
          },
        } satisfies HarnessRunner;
        const configured = {
          ...request,
          plan: new RunPlan({
            ...request.plan,
            harness: { ...request.plan.harness, model: "native-only" },
          }),
        };
        const error = yield* make([runner]).run(configured).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "launch");
        assert.isTrue(error.retryable);
        assert.strictEqual(error.message, "native catalog timed out");
        assert.deepStrictEqual(launches, []);
      }),
    );

    it.effect("rejects unsupported effort absent from the current catalog", () =>
      Effect.gen(function* () {
        const launches: Array<true> = [];
        const runner = {
          ...controlledRunnerDefaults,
          name,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          catalogSources: {
            fallback: staticCatalogSource(
              { models: [{ value: "runtime-model", label: "Runtime model" }] },
              { source: "cogwork-fallback", fallbackVersion: "1" },
            ),
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
            harness: { ...request.plan.harness, model: "runtime-model", effort: "high" },
          }),
        };
        const error = yield* harness.run(configured).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "stale-selection");
        assert.include(error.message, "effort high");
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
