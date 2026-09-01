import { HarnessName, RunPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { memoryPersistence } from "@tanstack/ai-persistence";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ContextAssembler } from "./context-assembler";
import { CredentialStore } from "./credential-store";
import { type HarnessExecution, make, stageResultSchema } from "./harness";
import { SessionStore } from "./session-store";

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
  FetchHttpClient.layer,
);

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

describe("stageResultSchema", () => {
  it.effect("prepares the triage result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("triage");
      if (!schema) return assert.fail("triage stage has no result schema");

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
      if (!schema) return assert.fail("implement stage has no result schema");

      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "opened-pr",
            summary: "Opened PR #110.",
          }),
        ),
      );
      assert.isUndefined(result.issues);

      const invalid = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "opened-pr",
            summary: " ",
          }),
        ),
      );
      assert.isDefined(invalid.issues);
    }),
  );

  it.effect("prepares the follow-up result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("follow-up");
      if (!schema) return assert.fail("follow-up stage has no result schema");

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

  it("does not prepare a structured result for stages still using their existing protocols", () => {
    assert.isUndefined(stageResultSchema("verify"));
  });
});

describe("Harness", () => {
  it.layer(harnessRunnerLayer)((it) => {
    it.effect("refuses every unsupported hard posture before runner launch", () =>
      Effect.gen(function* () {
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
              name,
              sessionKind: "opaque-handle",
              projectedMembers: [],
              planMiddleware: [],
              execution: posture.execution,
              run: () => Stream.succeed({ type: "RUN_STARTED" }),
            },
          ]);
          const error = yield* harness.run(request).pipe(Stream.runDrain, Effect.flip);

          assert.match(error.message, new RegExp(`unsupported.*${posture.expected}`));
          assert.strictEqual(error.reason, "policy");
        }
      }),
    );

    it.effect("uses runner services from the caller context", () => {
      const providedCredentialStore = { ...harnessServices.credentialStore };
      const harness = make([
        {
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
