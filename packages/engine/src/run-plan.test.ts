import {
  type ContributionSettingRow,
  type FileContribution,
  operationSettingNames,
  RunId,
  type SettingResolutionCase,
  settingResolutionCases,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { EligibleWork } from "./classify";
import type { AssembledContext } from "./context-assembler";
import { resolvedMcpSkills } from "./harness";
import type { RegisteredWorkspace } from "./projector";
import {
  assembleRunPlan,
  engineAdmissibleSettingScope,
  engineSettingScopeDirection,
  projectedContributionName,
  resolveEngineContributionEnabled,
  resolveEngineContributionUnion,
  resolveEngineOperationSetting,
  resolveRunPlanStage,
} from "./run-plan";

describe("projectedContributionName", () => {
  it("qualifies identity deterministically with readable Authority inside the Codex budget", () => {
    const pluginName = projectedContributionName("plugin:linear/mcp/linear");
    const localName = projectedContributionName("local:repo/mcp/linear");
    const longName = projectedContributionName(`plugin:${"authority".repeat(40)}/mcp/${"server".repeat(40)}`);

    assert.match(pluginName, /^plugin_linear__/);
    assert.match(localName, /^local_repo__/);
    assert.notStrictEqual(pluginName, localName);
    assert.strictEqual(projectedContributionName("plugin:linear/mcp/linear"), pluginName);
    assert.isAtMost(Buffer.byteLength(longName), 64);
  });
});

const resolvedValue = (testCase: SettingResolutionCase) => {
  if (testCase._tag === "Direction") return engineSettingScopeDirection;
  if (testCase._tag === "Admissible") {
    return engineAdmissibleSettingScope(testCase.family, testCase.setting, testCase.scope);
  }
  if (testCase._tag === "ContributionDefault") {
    return resolveEngineContributionEnabled([], testCase.authority).value;
  }
  if (testCase._tag === "ContributionEnabled") {
    return resolveEngineContributionEnabled(testCase.rows, "local:user").value;
  }
  if (testCase._tag === "ContributionUnion") {
    return resolveEngineContributionUnion(testCase.rows).value;
  }
  return resolveEngineOperationSetting(testCase.rows, testCase.setting, testCase.context).value;
};

describe("engine setting resolution", () => {
  for (const testCase of settingResolutionCases) {
    it(testCase.name, () => {
      assert.deepStrictEqual(resolvedValue(testCase), testCase.expected);
    });
  }
});

const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  contributions: [
    {
      id: "local:private/skill/review",
      authority: "local:private",
      kind: "skill",
      localName: "review",
      file: "/repo/.agents.local/skills/review/SKILL.md",
    },
    {
      id: "local:private/mcp/tools",
      authority: "local:private",
      kind: "mcp-server",
      localName: "tools",
      file: "/repo/.agents/mcp/tools.json",
    },
    {
      id: "local:repo/command/release",
      authority: "local:repo",
      kind: "command",
      localName: "release",
      file: "/repo/.agents/commands/release.md",
    },
    {
      id: "local:repo/mcp/disabled",
      authority: "local:repo",
      kind: "mcp-server",
      localName: "disabled",
      file: "/repo/.agents/mcp/disabled.json",
    },
  ],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "workspace",
    checkoutPath: "/repo",
    issueTracker: { type: "github", repo: "owner/repo" },
    harness: { preferred: "codex" },
    playbook: { implement: { enabled: true, model: "definition-model" } },
  }),
};

const otherWorkspace = Schema.decodeSync(WorkspaceConfig)({
  name: "other-workspace",
  checkoutPath: "/other",
  issueTracker: { type: "github", repo: "owner/other" },
  harness: { preferred: "codex" },
}).name;

const item: EligibleWork = {
  id: Schema.decodeSync(WorkItemId)("#228"),
  title: "Assemble Run Plan",
  url: "https://github.com/owner/repo/issues/228",
  stage: "implement",
  priority: "high",
  priorFailures: 0,
  workContext: {
    reference: {
      workItem: Schema.decodeSync(WorkItemId)("#228"),
      url: "https://github.com/owner/repo/issues/228",
    },
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

const context: AssembledContext = {
  layers: [
    { kind: "repo", source: "/repo/AGENTS.md", content: "repository rules" },
    {
      kind: "operating-instructions",
      source: "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md",
      content: "operating-instructions",
    },
  ],
  operatingInstructionsPath: "/home/.cogwork/run-plans/run-228/operating-instructions/implement-agent",
  operatingInstructionResources: [
    {
      source: "/engine/operating-instructions/implement-agent/CHECKLIST.md",
      content: "verification checklist",
    },
  ],
  sources: [
    {
      source: "/repo/.agents.local/skills/review/SKILL.md",
      content: "review instructions",
    },
    {
      source: "/repo/.agents/mcp/tools.json",
      content: '{"endpoint":"https://mcp.example.test"}',
    },
  ],
};

describe("Run Plan assembly", () => {
  it("projects same-named servers under distinct qualified names recorded in Provenance", () => {
    const runId = Schema.decodeSync(RunId)("run-qualified-mcp");
    const contributions = [
      {
        id: "plugin:linear/mcp/linear",
        authority: "plugin:linear",
        kind: "mcp-server",
        localName: "linear",
        file: "/plugins/linear/mcp/linear.json",
      },
      {
        id: "local:repo/mcp/linear",
        authority: "local:repo",
        kind: "mcp-server",
        localName: "linear",
        file: "/repo/.agents/mcp/linear.json",
      },
    ] satisfies ReadonlyArray<FileContribution>;
    const resolved = resolveRunPlanStage(
      workspace.config,
      "implement",
      [],
      [
        {
          contribution: { id: "local:repo/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
          enabled: true,
        },
      ],
    );
    assert.isNotNull(resolved);
    if (!resolved) return;

    const plan = assembleRunPlan({
      runId,
      workspace,
      item,
      observation: { generation: 12, observedAtMillis: 1000 },
      resolved,
      prompt: "Implement #230",
      checkoutPath: "/worktrees/230",
      sessionKind: "opaque-handle",
      projectedMembers: ["MCP"],
      middleware: [],
      context,
      contributions,
      mcpServers: contributions.map((contribution) => ({
        identity: contribution.id,
        name: contribution.localName,
        endpoint: `https://${contribution.authority}.example.test/mcp`,
        authenticated: false,
      })),
      provenanceStamps: [],
    });

    const projected = plan.mcp.flatMap((server) => ("projectedName" in server ? [server] : []));
    assert.strictEqual(projected.length, 2);
    assert.notStrictEqual(projected[0]?.projectedName, projected[1]?.projectedName);
    assert.deepStrictEqual(
      resolvedMcpSkills({ plan, session: null, mcpCredentials: new Map() }).map(({ name }) => name),
      projected.map(({ projectedName }) => projectedName),
    );
    assert.deepStrictEqual(
      plan.provenance.projectedNames.map(({ identity, name }) => ({ identity, name })),
      projected.map(({ identity, projectedName: name }) => ({ identity, name })),
    );
  });

  it("records optional contributions the selected runner cannot project", () => {
    const runId = Schema.decodeSync(RunId)("run-optional-projection");
    const contribution = {
      id: "plugin:linear/mcp/linear",
      authority: "plugin:linear",
      kind: "mcp-server",
      localName: "linear",
      file: "/plugins/linear/mcp/linear.json",
    } satisfies FileContribution;
    const resolved = resolveRunPlanStage(workspace.config, "implement", [
      {
        setting: "bindings",
        level: { _tag: "Operation", workflow: "coding", operation: "implement" },
        scope: { _tag: "SettingsProfile" },
        value: [{ need: "tracker", contribution: contribution.id }],
      },
    ]);
    assert.isNotNull(resolved);
    if (!resolved) return;

    const plan = assembleRunPlan({
      runId,
      workspace,
      item,
      observation: { generation: 12, observedAtMillis: 1000 },
      resolved,
      prompt: "Implement #230",
      checkoutPath: "/worktrees/230",
      sessionKind: "opaque-handle",
      projectedMembers: [],
      middleware: [],
      context,
      contributions: [contribution],
      mcpServers: [
        {
          identity: contribution.id,
          name: contribution.localName,
          endpoint: "https://linear.example.test/mcp",
          authenticated: false,
        },
      ],
      provenanceStamps: [],
    });

    assert.deepStrictEqual(plan.provenance.projectedNames, []);
    assert.deepStrictEqual(
      {
        ...plan.provenance.projection.find(({ member }) => member === `MCP ${contribution.id}`),
      },
      {
        member: `MCP ${contribution.id}`,
        disposition: "not-projected",
        reason: "selected harness does not project MCP",
      },
    );
  });

  it("freezes Messages, admitting Work Context facts, and provenance", () => {
    const resolved = resolveRunPlanStage(
      workspace.config,
      "implement",
      [
        {
          setting: "model",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: "default-model",
        },
        {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: "profile-model",
        },
        {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspace.config.name },
          value: "private-model",
        },
        {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: otherWorkspace },
          value: "other-workspace-model",
        },
        {
          setting: "permission-profile",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspace.config.name },
          value: "read-only",
        },
        {
          setting: "bindings",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: [{ need: "review", contribution: "local:private/skill/review" }],
        },
      ],
      [
        {
          contribution: { id: "local:private/mcp/tools", kind: "mcp-server" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: otherWorkspace },
          enabled: false,
        },
      ],
    );
    assert.isNotNull(resolved);
    if (!resolved) return;

    const plan = assembleRunPlan({
      runId: Schema.decodeSync(RunId)("run-228"),
      workspace,
      item,
      observation: { generation: 12, observedAtMillis: 1000 },
      resolved,
      prompt: "Implement #228",
      checkoutPath: "/worktrees/228",
      sessionKind: "opaque-handle",
      projectedMembers: ["Instructions", "Messages", "MCP", "Sandbox", "Persistence"],
      middleware: ["sandbox"],
      context,
      contributions: workspace.contributions,
      mcpServers: [],
      provenanceStamps: [{ _tag: "DeclaredVersion", source: "plugin:linear", version: "1.2.3" }],
    });

    assert.deepStrictEqual(
      plan.messages.map(({ role, content }) => ({ role, content })),
      [{ role: "user", content: "Implement #228" }],
    );
    assert.deepStrictEqual({ ...plan.workContext.facts }, item.workContext?.facts);
    assert.deepStrictEqual(
      { ...plan.workContext.observation },
      {
        generation: 12,
        observedAtMillis: 1000,
      },
    );
    assert.strictEqual(plan.harness.model, "private-model");
    assert.strictEqual(plan.harness.profile, "read-only");
    assert.deepStrictEqual(
      plan.provenance.resolution.slice(0, operationSettingNames.length).map((entry) => entry.key),
      [...operationSettingNames],
    );
    const modelTrace = plan.provenance.resolution.find((entry) => entry.key === "model");
    assert.strictEqual(modelTrace?.winner?.source, "Private workspace overlay workspace");
    assert.deepStrictEqual(
      modelTrace?.shadowed.map((candidate) => candidate.value),
      ["profile-model", "default-model"],
    );
    assert.deepStrictEqual(
      modelTrace?.dropped.map(({ candidate, reason }) => ({ value: candidate.value, reason })),
      [
        {
          value: "other-workspace-model",
          reason: "scope does not apply to this workspace",
        },
      ],
    );
    assert.deepStrictEqual(
      plan.provenance.resolution
        .find((entry) => entry.key === "bindings")
        ?.contributors.map((candidate) => candidate.value),
      [[{ need: "review", contribution: "local:private/skill/review" }]],
    );
    assert.deepStrictEqual(
      plan.provenance.stamps.map((stamp) => stamp.source),
      [
        "/repo/AGENTS.md",
        "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md",
        "/engine/operating-instructions/implement-agent/CHECKLIST.md",
        "/repo/.agents.local/skills/review/SKILL.md",
        "/repo/.agents/mcp/tools.json",
        "plugin:linear",
        "implement Operation Definition",
        "Engine Harness Adapter",
        "Engine Messages",
        "Engine Work Context",
        "Engine Tools",
        "Engine Middleware",
        "Engine Sandbox",
        "Engine Structured Output",
        "Engine Persistence",
        "Engine Connections",
      ],
    );
    assert.strictEqual(plan.skills[0]?.identity, "local:private/skill/review");
    assert.strictEqual(
      plan.provenance.resolution.find(({ key }) => key === "contribution:local:private/mcp/tools:enabled")
        ?.dropped[0]?.reason,
      "scope does not apply to this workspace",
    );
    assert.strictEqual(plan.commands[0]?.identity, "local:repo/command/release");
    assert.strictEqual(
      plan.provenance.resolution.find(({ key }) => key === "contribution:local:repo/mcp/disabled:enabled")
        ?.dropped[0]?.reason,
      "contribution entry gate disabled by default",
    );
    assert.strictEqual(plan.mcp[0]?.identity, "local:private/mcp/tools");
    assert.strictEqual(
      plan.provenance.projection.find(({ member }) => member === "MCP local:private/mcp/tools")?.disposition,
      "not-projected",
    );
    assert.isNotNull(plan.structuredOutput);
    assert.deepStrictEqual(plan.provenance.observation, plan.workContext.observation);
    assert.strictEqual(
      plan.provenance.projection.find(({ member }) => member === "Messages")?.disposition,
      "projected",
    );
    assert.strictEqual(
      plan.provenance.projection.find(({ member }) => member === "Tools")?.disposition,
      "not-projected",
    );
    assert.isTrue(Object.isFrozen(plan));
    assert.isTrue(Object.isFrozen(plan.messages));
    assert.isTrue(Object.isFrozen(plan.workContext.facts.roles));
  });

  it("applies workspace MCP settings to resolved servers and their trace", () => {
    const contribution = {
      id: "plugin:linear/mcp/linear",
      authority: "plugin:linear" as const,
      kind: "mcp-server" as const,
      localName: "linear",
      file: "/plugins/linear/mcp/linear.json",
    };
    const contributionSettings: ReadonlyArray<ContributionSettingRow> = [
      {
        contribution: { id: contribution.id, kind: "mcp-server" },
        scope: { _tag: "SettingsProfile" },
        enabled: true,
      },
      {
        contribution: { id: contribution.id, kind: "mcp-server" },
        scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspace.config.name },
        enabled: false,
      },
    ];
    const resolved = resolveRunPlanStage(workspace.config, "implement", [], contributionSettings);
    assert.isNotNull(resolved);
    if (!resolved) return;

    const plan = assembleRunPlan({
      runId: Schema.decodeSync(RunId)("run-mcp-gate"),
      workspace,
      item,
      observation: { generation: 12, observedAtMillis: 1000 },
      resolved,
      prompt: "Implement #228",
      checkoutPath: "/worktrees/228",
      sessionKind: "opaque-handle",
      projectedMembers: ["MCP"],
      middleware: [],
      context,
      contributions: [contribution],
      mcpServers: [
        {
          identity: contribution.id,
          name: contribution.id,
          endpoint: "https://mcp.linear.app/mcp",
          authenticated: false,
        },
      ],
      provenanceStamps: [],
    });

    assert.deepStrictEqual(plan.mcp, []);
    const trace = plan.provenance.resolution.find(
      ({ key }) => key === `contribution:${contribution.id}:enabled`,
    );
    assert.strictEqual(trace?.winner?.source, "Private workspace overlay workspace");
    assert.strictEqual(trace?.winner?.value, false);
    assert.deepStrictEqual(
      trace?.shadowed.map(({ value }) => value),
      [true],
    );
    assert.strictEqual(trace?.dropped[0]?.reason, "contribution entry gate disabled");
  });
});
