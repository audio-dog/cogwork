import {
  HarnessName,
  type OperationSettingRow,
  RunId,
  SessionId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { EligibleWork } from "./classify";
import * as OperationResolution from "./operation-resolution";
import type { RegisteredWorkspace } from "./projector";
import { engineTestLayerWithOperationResolution } from "./testing/engine-test-layer";

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

const credential = Redacted.make("tracker-token");

const testLayer = (settings = operationSettings) =>
  engineTestLayerWithOperationResolution({
    harness,
    operationSettings: settings,
    context: {
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
    },
    mcpSkills: [
      {
        name: "tracker",
        endpoint: "https://mcp.example.test",
        bearer: credential,
        unavailableReason: null,
      },
    ],
  });

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
    recoverySession: null,
    latestBranchSession: session?.id ?? null,
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
        assert.isNotEmpty(accepted.session);
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
