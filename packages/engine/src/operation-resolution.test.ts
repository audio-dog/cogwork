import {
  defaultControlStore,
  HarnessName,
  type OperationSettingRow,
  RunId,
  SessionId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { memoryPersistence } from "@tanstack/ai-persistence";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Availability from "./availability";
import type { EligibleWork } from "./classify";
import { ConnectionStore } from "./connection";
import { ContextAssembler } from "./context-assembler";
import { ControlStore } from "./control-store";
import * as CredentialStore from "./credential-store";
import { Harness } from "./harness";
import { McpSkillAssembler } from "./mcp-skill";
import * as OperationResolution from "./operation-resolution";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";
import { SessionStore } from "./session-store";

const harness = Schema.decodeSync(HarnessName)("cursor");
const runId = Schema.decodeSync(RunId)("run-operation-resolution");
const sessionId = Schema.decodeSync(SessionId)("session-operation-resolution");
const itemId = Schema.decodeSync(WorkItemId)("#491");
const enabledSetting = {
  setting: "enabled",
  level: { _tag: "Default" },
  scope: { _tag: "SettingsProfile" },
  value: true,
} satisfies OperationSettingRow;

const harnessSetting = {
  setting: "harness",
  level: { _tag: "Default" },
  scope: { _tag: "SettingsProfile" },
  value: harness,
} satisfies OperationSettingRow;

const operationSettings: ReadonlyArray<OperationSettingRow> = [enabledSetting, harnessSetting];

const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "workspace",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
    mcpSkills: [
      {
        name: "tracker",
        endpoint: "https://mcp.example.test",
        auth: { type: "credential-store" },
      },
    ],
  }),
};

const item: EligibleWork = {
  id: itemId,
  title: "Land operation resolution",
  url: "https://github.com/colonylabs/cogwork/issues/491",
  stage: "implement",
  priority: "high",
  priorFailures: 0,
  workContext: {
    reference: { workItem: itemId, url: "https://github.com/colonylabs/cogwork/issues/491" },
    facts: {
      roles: ["ready-for-agent"],
      assignees: ["maintainer"],
      openBlockers: 0,
      claim: null,
      priority: "high",
      pr: null,
    },
  },
};

const controlStore = (settings = operationSettings) =>
  Layer.mock(ControlStore, {
    health: "available",
    seed: { ...defaultControlStore, operationSettings: settings },
    picture: Effect.succeed({ ...defaultControlStore, operationSettings: settings }),
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  });

const contextAssembler = Layer.mock(ContextAssembler, {
  assemble: () =>
    Effect.succeed({
      layers: [
        { kind: "repo", source: "/repo/AGENTS.md", content: "repo rules" },
        {
          kind: "operating-instructions",
          source: "/operations/implement-agent/INSTRUCTIONS.md",
          content: "implement instructions",
        },
      ],
      operatingInstructionsPath: "/operations/implement-agent",
      operatingInstructionResources: [],
      sources: [],
    }),
});

const sessionStore = Layer.mock(SessionStore, {
  persistence: memoryPersistence(),
  resumeHandle: () => Effect.succeed(null),
  mint: () => Effect.succeed(sessionId),
});

const harnessService = Layer.mock(Harness, {
  names: [harness],
  signIn: () => null,
  preflight: () => Effect.void,
  sessionKind: () => "opaque-handle",
  capabilities: () => ({
    authenticationModes: ["host"],
    session: { affinity: "runtime-host", fork: false, humanAttach: false },
    structuredOutput: "native",
    policyFidelity: "exact",
    fileEventFidelity: "best-effort",
    usageQuality: "metered",
    readinessDiagnostics: true,
    journal: false,
    takeover: false,
  }),
  projectedMembers: () => ["Instructions", "Messages", "MCP", "Sandbox", "Persistence"],
  planMiddleware: () => [],
});

const connectionStore = Layer.mock(ConnectionStore, {
  overview: Effect.succeed({ connections: [] }),
});

const credential = Redacted.make("tracker-token");
const mcpCredentials = Layer.succeed(McpSkillAssembler, {
  assemble: () =>
    Effect.succeed([
      {
        name: "tracker",
        endpoint: "https://mcp.example.test",
        bearer: credential,
        unavailableReason: null,
      },
    ]),
});

const plugins = Layer.mock(PluginManager, {
  overview: Effect.succeed({ plugins: [] }),
});

const testLayer = (settings = operationSettings) =>
  OperationResolution.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        controlStore(settings),
        contextAssembler,
        sessionStore,
        harnessService,
        connectionStore,
        mcpCredentials,
        plugins,
        CredentialStore.layerEnv,
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        NodePath.layer,
        FetchHttpClient.layer,
        Availability.Availability.layer,
      ),
    ),
  );

const candidateFacts = (session: OperationResolution.CandidateSessionFacts["session"] = null) => ({
  runId,
  workspace,
  item,
  observation: { generation: 12, observedAtMillis: 1000 },
  checkoutPath: "/worktrees/491",
  continuationPrompt: "Continue implementation",
  startedAtMillis: 1000,
  sessionChoice: {
    session,
    applyResumePolicy: false,
    lastRunStartedAtMillis: session?.createdAtMillis ?? null,
    lastRunTotalTokens: session ? 100 : null,
    worktreeRecreated: false,
    fresh: false,
  },
});

describe("OperationResolution", () => {
  it.layer(testLayer())((it) => {
    it.effect("accepts a candidate as a Run Plan with Harness-only MCP credentials", () =>
      Effect.gen(function* () {
        const resolution = yield* OperationResolution.OperationResolution;
        const accepted = yield* resolution.resolve(candidateFacts());
        const [[identity, resolvedCredential]] = [...accepted.mcpCredentials];
        const encodedPlan = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(accepted.plan);

        assert.strictEqual(accepted.plan.operation, "implement");
        assert.strictEqual(accepted.plan.harness.name, harness);
        assert.strictEqual(accepted.session, sessionId);
        assert.strictEqual(Redacted.value(resolvedCredential), "tracker-token");
        assert.strictEqual(accepted.plan.mcp[0]?.identity, identity);
        assert.notInclude(encodedPlan, "tracker-token");
      }),
    );

    it.effect("reports the executor's current availability conclusions", () =>
      Effect.gen(function* () {
        const resolution = yield* OperationResolution.OperationResolution;
        assert.deepStrictEqual(yield* resolution.refreshAvailability(workspace), [
          { operation: "triage", available: true, causes: [] },
          { operation: "implement", available: true, causes: [] },
          { operation: "follow-up", available: true, causes: [] },
        ]);
        assert.deepStrictEqual(yield* resolution.availabilityOf(workspace, item), {
          operation: "implement",
          available: true,
          causes: [],
        });
      }),
    );

    it.effect("continues a compatible session with the prepared continuation message", () =>
      Effect.gen(function* () {
        const resolution = yield* OperationResolution.OperationResolution;
        const accepted = yield* resolution.resolve({
          ...candidateFacts({
            kind: "opaque-handle",
            id: sessionId,
            workspace: workspace.config.name,
            harness,
            createdAtMillis: 500,
            handle: "native-session",
          }),
          continuationPrompt: "Continue from the prepared checkout",
        });

        assert.strictEqual(accepted.session, sessionId);
        assert.strictEqual(accepted.plan.messages[0]?.role, "user");
        assert.strictEqual(accepted.plan.messages[0]?.content, "Continue from the prepared checkout");
      }),
    );
  });

  it.layer(testLayer([{ ...enabledSetting, value: false }, harnessSetting]))((it) => {
    it.effect("reports the executor's disabled-operation conclusion", () =>
      Effect.gen(function* () {
        const resolution = yield* OperationResolution.OperationResolution;
        assert.deepStrictEqual(yield* resolution.availabilityOf(workspace, item), {
          operation: "implement",
          available: false,
          causes: [
            {
              _tag: "PolicyRefusal",
              source: "implement Operation Definition",
              message: "implement is disabled",
            },
          ],
        });
      }),
    );
  });
});
