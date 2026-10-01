import {
  AvailabilityCause,
  type ContributionSettingRow,
  type FileContribution,
  type OperationSettingRow,
  operationSettingNames,
  RunId,
  RunPlanMcpServer,
  type SettingResolutionCase,
  settingResolutionCases,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { AdmittedWork } from "./classify";
import type { AssembledContext } from "./context-assembler";
import { resolvedMcpSkills } from "./harness";
import type { RegisteredWorkspace } from "./projector";
import {
  assembleRunPlan,
  availabilityCauses,
  type BuildRunPlanInput,
  buildRunPlan,
  engineAdmissibleSettingScope,
  engineSettingScopeDirection,
  operationBindingsOf,
  projectedContributionName,
  resolveEngineContributionEnabled,
  resolveEngineContributionUnion,
  resolveEngineOperationSetting,
  resolveRunPlanStage,
  tryAssembleRunPlan,
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

describe("Operation availability", () => {
  it("reports every unsatisfied declared need", () => {
    const causes = availabilityCauses({
      needs: [
        { name: "review", kind: "skill" },
        { name: "tracker", kind: "mcp-server" },
        { name: "release", kind: "command" },
      ],
      bindings: [
        { need: "review", contribution: "local:repo/skill/review" },
        { need: "tracker", contribution: "plugin:linear/mcp/linear" },
      ],
      contributions: [
        {
          id: "local:repo/skill/review",
          kind: "skill",
          enabled: false,
          ready: true,
          reason: null,
        },
        {
          id: "plugin:linear/mcp/linear",
          kind: "mcp-server",
          enabled: true,
          ready: false,
          reason: "credential unavailable",
        },
      ],
      projectedMembers: ["Skills", "MCP", "Commands"],
    });

    assert.deepStrictEqual(
      causes.flatMap((cause) =>
        AvailabilityCause.guards.UnsatisfiedNeed(cause)
          ? [{ _tag: cause._tag, need: cause.need, reason: cause.reason }]
          : [],
      ),
      [
        { _tag: "UnsatisfiedNeed", need: "review", reason: "off" },
        { _tag: "UnsatisfiedNeed", need: "tracker", reason: "not-ready" },
        { _tag: "UnsatisfiedNeed", need: "release", reason: "unbound" },
      ],
    );
  });

  it("rejects a required contribution the selected Harness cannot project", () => {
    const causes = availabilityCauses({
      needs: [{ name: "review", kind: "skill" }],
      bindings: [{ need: "review", contribution: "local:private/skill/review" }],
      contributions: [
        {
          id: "local:private/skill/review",
          kind: "skill",
          enabled: true,
          ready: true,
          reason: null,
        },
      ],
      projectedMembers: ["MCP"],
    });

    const cause = causes[0];
    assert.isTrue(cause && AvailabilityCause.guards.UnsatisfiedNeed(cause));
    if (!cause || !AvailabilityCause.guards.UnsatisfiedNeed(cause)) return;
    assert.strictEqual(cause.reason, "not-ready");
    assert.include(cause.message, "does not project Skills");
  });

  it("accepts ready Hook and Connection bindings when their sources are available", () => {
    const causes = availabilityCauses({
      needs: [
        { name: "notify", kind: "hook" },
        { name: "tracker", kind: "connection" },
      ],
      bindings: [
        { need: "notify", contribution: "engine/hook/notify" },
        { need: "tracker", contribution: "linear/acme" },
      ],
      contributions: [
        { id: "engine/hook/notify", kind: "hook", enabled: true, ready: true, reason: null },
        { id: "linear/acme", kind: "connection", enabled: true, ready: true, reason: null },
      ],
      projectedMembers: ["Hooks", "Connections"],
    });

    assert.deepStrictEqual(causes, []);
  });
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
    issueTracker: { type: "github", connectionId: "github/maintainer" },
  }),
};

const otherWorkspace = Schema.decodeSync(WorkspaceConfig)({
  name: "other-workspace",
  checkoutPath: "/other",
  issueTracker: { type: "github" },
}).name;

const item: AdmittedWork = {
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
    prose: {
      body: "Build the resolved Run Plan.",
      comments: [
        {
          author: "maintainer",
          authorAssociation: "MEMBER",
          body: "Keep the accepted plan immutable.",
          createdAtMillis: 900,
        },
      ],
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

const bareConfig = Schema.decodeSync(WorkspaceConfig)({
  name: "bare-workspace",
  checkoutPath: "/bare",
  issueTracker: { type: "github" },
});

const profileDefault = { level: { _tag: "Default" }, scope: { _tag: "SettingsProfile" } } as const;

const stageEnabled: OperationSettingRow = { ...profileDefault, setting: "enabled", value: true };
const codexHarness: OperationSettingRow = { ...profileDefault, setting: "harness", value: "codex" };
const hostHarness: OperationSettingRow = {
  level: { _tag: "Default" },
  scope: { _tag: "RuntimeHost" },
  setting: "harness",
  value: "cursor",
};
const solModel: OperationSettingRow = { ...profileDefault, setting: "model", value: "gpt-5.6-sol" };
const highEffort: OperationSettingRow = {
  ...profileDefault,
  setting: "model-options",
  value: { effort: "high" },
};
const invalidPlanRunId = Schema.decodeSync(RunId)("run-invalid-plan");

describe("stage settings come from Operation settings", () => {
  it.each(["triage", "implement", "follow-up"] as const)(
    "%s requires the workspace issue-tracker Connection",
    (stage) => {
      const resolved = resolveRunPlanStage(workspace.config, stage, [stageEnabled, hostHarness]);

      assert.deepStrictEqual(resolved?.stage.needs, [
        { name: "issue-tracker-connection", kind: "connection" },
      ]);
      assert.deepStrictEqual(resolved && operationBindingsOf(resolved), [
        { need: "issue-tracker-connection", contribution: "github/maintainer" },
      ]);
    },
  );

  it("keeps the workspace issue-tracker Connection binding authoritative", () => {
    const resolved = resolveRunPlanStage(workspace.config, "implement", [
      stageEnabled,
      hostHarness,
      {
        ...profileDefault,
        setting: "bindings",
        value: [
          { need: "issue-tracker-connection", contribution: "github/other" },
          { need: "review", contribution: "local:private/skill/review" },
        ],
      },
    ]);

    assert.deepStrictEqual(resolved && operationBindingsOf(resolved), [
      { need: "issue-tracker-connection", contribution: "github/maintainer" },
      { need: "review", contribution: "local:private/skill/review" },
    ]);
  });

  it("enables a stage from an Operation setting rather than the Workspace input", () => {
    const resolved = resolveRunPlanStage(bareConfig, "implement", [stageEnabled, codexHarness]);

    assert.isNotNull(resolved);
    assert.strictEqual(resolved?.stage.enabled, true);
    assert.strictEqual(resolved?.stage.harness, "codex");
  });

  it("leaves a stage disabled when no Operation setting enables it", () => {
    const resolved = resolveRunPlanStage(bareConfig, "implement", [codexHarness]);

    assert.strictEqual(resolved?.stage.enabled, false);
  });

  it("resolves no stage when no harness is configured anywhere", () => {
    const resolved = resolveRunPlanStage(bareConfig, "implement", [stageEnabled]);

    assert.isNull(resolved);
  });

  it("takes the harness from the Runtime host scope", () => {
    const resolved = resolveRunPlanStage(bareConfig, "implement", [stageEnabled, hostHarness]);

    assert.strictEqual(resolved?.stage.harness, "cursor");
  });

  it("uses a Harness profile when it does not declare the Operation default", () => {
    const resolved = resolveRunPlanStage(bareConfig, "triage", [stageEnabled, hostHarness], [], ["full"]);

    assert.strictEqual(resolved?.profile, "full");
  });

  it("attributes a Provider profile fallback to the Harness", () => {
    const resolved = resolveRunPlanStage(
      workspace.config,
      "triage",
      [stageEnabled, hostHarness],
      [],
      ["full"],
    );
    assert.isNotNull(resolved);
    if (!resolved) return;

    const plan = assembleRunPlan({
      runId: Schema.decodeSync(RunId)("run-provider-profile-default"),
      workspace,
      item: { ...item, stage: "triage" },
      observation: { generation: 12, observedAtMillis: 1000 },
      resolved,
      prompt: "Triage #228",
      checkoutPath: "/worktrees/228",
      sessionKind: "opaque-handle",
      projectedMembers: [],
      middleware: [],
      context,
      contributions: [],
      mcpServers: [],
      provenanceStamps: [],
    });

    const trace = plan.provenance.resolution.find(({ key }) => key === "permission-profile");
    assert.strictEqual(trace?.winner?.source, "Harness cursor");
    assert.strictEqual(trace?.winner?.value, "full");
  });

  it("carries model options from Operation settings", () => {
    const resolved = resolveRunPlanStage(bareConfig, "implement", [
      stageEnabled,
      codexHarness,
      solModel,
      highEffort,
    ]);

    assert.strictEqual(resolved?.stage.model, "gpt-5.6-sol");
    assert.strictEqual(resolved?.stage.modelOptions.effort, "high");
  });

  it("trims model and resolves model options", () => {
    const configured = resolveRunPlanStage(bareConfig, "implement", [
      codexHarness,
      { ...profileDefault, setting: "model", value: "  gpt-5.6-sol\n" },
      { ...profileDefault, setting: "model-options", value: { effort: "high" } },
    ]);
    const blank = resolveRunPlanStage(bareConfig, "implement", [
      codexHarness,
      solModel,
      highEffort,
      {
        level: { _tag: "Operation", workflow: "coding", operation: "implement" },
        scope: { _tag: "SettingsProfile" },
        setting: "model",
        value: "  ",
      },
    ]);

    assert.strictEqual(configured?.stage.model, "gpt-5.6-sol");
    assert.strictEqual(configured?.stage.modelOptions.effort, "high");
    assert.strictEqual(blank?.stage.model, "gpt-5.6-sol");
    assert.strictEqual(blank?.stage.modelOptions.effort, "high");
    assert.deepStrictEqual(
      blank?.settings.get("model")?.dropped.map(({ reason }) => reason),
      ["blank value is unset"],
    );
  });
});

describe("Run Plan assembly", () => {
  it("pairs admitted MCP credentials by contribution identity regardless of server order", () => {
    const contributions = [
      {
        id: "plugin:github/mcp/github",
        authority: "plugin:github",
        kind: "mcp-server",
        localName: "github",
        file: "/plugins/github/mcp/github.json",
      },
      {
        id: "local:repo/mcp/disabled",
        authority: "local:repo",
        kind: "mcp-server",
        localName: "disabled",
        file: "/repo/.agents/mcp/disabled.json",
      },
      {
        id: "plugin:linear/mcp/linear",
        authority: "plugin:linear",
        kind: "mcp-server",
        localName: "linear",
        file: "/plugins/linear/mcp/linear.json",
      },
    ] satisfies ReadonlyArray<FileContribution>;
    const resolved = resolveRunPlanStage(workspace.config, "implement", [codexHarness]);
    assert.isNotNull(resolved);
    if (!resolved) return;

    const mcpServers = [
      {
        identity: "plugin:linear/mcp/linear",
        name: "linear",
        endpoint: "https://mcp.linear.app/mcp",
        bearer: Redacted.make("linear-token"),
        unavailableReason: null,
      },
      {
        identity: "local:repo/mcp/disabled",
        name: "disabled",
        endpoint: "https://disabled.example.test/mcp",
        bearer: Redacted.make("disabled-token"),
        unavailableReason: null,
      },
      {
        identity: "plugin:github/mcp/github",
        name: "github",
        endpoint: "https://api.githubcopilot.com/mcp",
        bearer: Redacted.make("github-token"),
        unavailableReason: null,
      },
    ];
    const input: BuildRunPlanInput = {
      runId: Schema.decodeSync(RunId)("run-identity-keyed-mcp"),
      workspace,
      item,
      observation: { generation: 12, observedAtMillis: 1000 },
      resolved,
      prompt: "Implement #228",
      checkoutPath: "/worktrees/228",
      sessionKind: "opaque-handle",
      projectedMembers: ["MCP"],
      middleware: [],
      contributions,
      provenanceStamps: [],
    };

    const builder = buildRunPlan(input);
    assert.isTrue(Object.isFrozen(builder.contributions));
    assert.isTrue(Object.isFrozen(builder.contributions[0]));
    const forward = builder.complete({ context, mcpServers });
    const reversed = builder.complete({ context, mcpServers: mcpServers.toReversed() });
    const credentials = (assembly: typeof forward) =>
      [...assembly.mcpCredentials]
        .map(([identity, credential]) => [identity, Redacted.value(credential)])
        .sort();

    assert.deepStrictEqual(credentials(forward), [
      ["plugin:github/mcp/github", "github-token"],
      ["plugin:linear/mcp/linear", "linear-token"],
    ]);
    assert.deepStrictEqual(credentials(reversed), credentials(forward));
    assert.deepStrictEqual(
      forward.plan.mcp.map(({ identity }) => identity),
      ["plugin:linear/mcp/linear", "plugin:github/mcp/github"],
    );
    assert.deepStrictEqual(
      reversed.plan.mcp.map(({ identity }) => identity),
      ["plugin:github/mcp/github", "plugin:linear/mcp/linear"],
    );
    assert.notInclude(JSON.stringify(forward.plan), "linear-token");
    assert.notInclude(JSON.stringify(forward.plan), "github-token");
    assert.notInclude(JSON.stringify(forward.plan), "disabled-token");
  });

  it("keys workspace MCP credentials by the identity written into the plan", () => {
    const resolved = resolveRunPlanStage(workspace.config, "implement", [codexHarness]);
    assert.isNotNull(resolved);
    if (!resolved) return;

    const builder = buildRunPlan({
      runId: Schema.decodeSync(RunId)("run-workspace-mcp-credential"),
      workspace,
      item,
      observation: { generation: 12, observedAtMillis: 1000 },
      resolved,
      prompt: "Implement #228",
      checkoutPath: "/worktrees/228",
      sessionKind: "opaque-handle",
      projectedMembers: ["MCP"],
      middleware: [],
      contributions: [],
      provenanceStamps: [],
    });
    const { plan, mcpCredentials } = builder.complete({
      context,
      mcpServers: [
        {
          identity: null,
          name: "workspace-tools",
          endpoint: "https://mcp.example.test/tools",
          bearer: Redacted.make("workspace-token"),
          unavailableReason: null,
        },
        {
          identity: null,
          name: "public-tools",
          endpoint: "https://mcp.example.test/public",
          bearer: null,
          unavailableReason: null,
        },
      ],
    });
    const servers = plan.mcp.filter(Schema.is(RunPlanMcpServer));
    const workspaceServer = servers.find(({ name }) => name === "workspace-tools");
    const publicServer = servers.find(({ name }) => name === "public-tools");
    const workspaceCredential = workspaceServer ? mcpCredentials.get(workspaceServer.identity) : undefined;
    assert.isDefined(workspaceServer);
    assert.isDefined(publicServer);
    assert.isDefined(workspaceCredential);
    if (!workspaceServer || !publicServer || !workspaceCredential) return;

    assert.isTrue(workspaceServer.authenticated);
    assert.isFalse(publicServer.authenticated);
    assert.strictEqual(Redacted.value(workspaceCredential), "workspace-token");
    assert.isFalse(mcpCredentials.has(publicServer.identity));
    assert.notInclude(JSON.stringify(plan), "workspace-token");
  });

  it.effect("fails invalid plan input with a typed assembly error", () => {
    const resolved = resolveRunPlanStage(workspace.config, "implement", [codexHarness]);
    assert.isNotNull(resolved);
    if (!resolved) return Effect.void;

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        tryAssembleRunPlan({
          runId: invalidPlanRunId,
          workspace,
          item,
          observation: { generation: 12, observedAtMillis: 1000 },
          resolved,
          prompt: "Implement #228",
          checkoutPath: "/worktrees/228",
          sessionKind: "opaque-handle",
          projectedMembers: ["Instructions", "Messages", "MCP", "Sandbox", "Persistence"],
          middleware: [],
          context: {
            ...context,
            layers: [{ kind: "repo", source: "/repo/AGENTS.md", content: "trailing newline\n" }],
          },
          contributions: workspace.contributions,
          mcpServers: [],
          provenanceStamps: [],
        }),
      );

      assert.strictEqual(error._tag, "RunPlanAssemblyError");
      assert.include(error.message, "RunPlanInstruction");
      assert.include(error.message, "content");
    });
  });

  it("trims workspace and Plugin MCP server names and endpoints", () => {
    const pluginMcp = {
      id: "plugin:linear/mcp/linear",
      authority: "plugin:linear",
      kind: "mcp-server",
      localName: "linear",
      file: "/plugins/linear/mcp/linear.json",
    } satisfies FileContribution;
    const workspaceConfig: WorkspaceConfig = {
      ...workspace.config,
      mcpSkills: [
        {
          name: "  workspace-tools\n",
          endpoint: "  https://mcp.example.test/tools\t",
          auth: { type: "credential-store" },
        },
      ],
    };
    const resolved = resolveRunPlanStage(workspaceConfig, "implement", [codexHarness]);
    assert.isNotNull(resolved);
    if (!resolved) return;

    const plan = assembleRunPlan({
      runId: Schema.decodeSync(RunId)("run-trimmed-mcp"),
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
      contributions: [pluginMcp],
      mcpServers: [
        {
          identity: null,
          name: "  workspace-tools\n",
          endpoint: "  https://mcp.example.test/tools\t",
          authenticated: true,
        },
        {
          identity: pluginMcp.id,
          name: "\tlinear  ",
          endpoint: "\nhttps://mcp.linear.app/mcp  ",
          authenticated: true,
        },
      ],
      provenanceStamps: [],
    });

    assert.deepStrictEqual(
      plan.mcp.map((server) => ({
        name: server.name,
        endpoint: "endpoint" in server ? server.endpoint : null,
      })),
      [
        { name: "workspace-tools", endpoint: "https://mcp.example.test/tools" },
        { name: "linear", endpoint: "https://mcp.linear.app/mcp" },
      ],
    );
    assert.deepStrictEqual(plan.connections, ["github/maintainer", "workspace-tools"]);
  });

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
      [codexHarness],
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
      codexHarness,
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
        codexHarness,
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
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: "full",
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
      {
        ...plan.workContext.prose,
        comments: plan.workContext.prose.comments.map((comment) => ({ ...comment })),
      },
      item.workContext.prose,
    );
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
    const permissionTrace = plan.provenance.resolution.find((entry) => entry.key === "permission-profile");
    assert.strictEqual(permissionTrace?.winner?.source, "Private workspace overlay workspace");
    assert.deepStrictEqual(
      permissionTrace?.shadowed.map((candidate) => candidate.value),
      ["full"],
    );
    assert.deepStrictEqual(permissionTrace?.dropped, []);
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
      [
        [{ need: "review", contribution: "local:private/skill/review" }],
        { need: "issue-tracker-connection", contribution: "github/maintainer" },
      ],
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
    const resolved = resolveRunPlanStage(workspace.config, "implement", [codexHarness], contributionSettings);
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
