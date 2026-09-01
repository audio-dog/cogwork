import { createHash } from "node:crypto";
import type {
  ContributionEnabledRow,
  ContributionSettingRow,
  ContributionUnionRow,
  FileContribution,
  OperationBinding,
  OperationSettingContext,
  OperationSettingName,
  OperationSettingRow,
  SettingLevel,
  SettingScope,
  WorkspaceConfig,
} from "@cogwork/contracts";
import {
  ContentRevision,
  HarnessName,
  type LifecycleStage,
  operationSettingNames,
  type ProvenanceStamp,
  type RunId,
  RunPlan,
  RunPlanContributionMember,
  RunPlanDroppedCandidate,
  RunPlanHarness,
  RunPlanInstruction,
  RunPlanMcpServer,
  RunPlanMember,
  type RunPlanMember as RunPlanMemberType,
  RunPlanMessage,
  type RunPlanMiddlewareName,
  RunPlanObservation,
  RunPlanOperatingInstructions,
  RunPlanPersistence,
  RunPlanPolicyProfile,
  RunPlanProjectedName,
  RunPlanProjectionDisposition,
  RunPlanProvenance,
  RunPlanResolutionCandidate,
  RunPlanResolutionTrace,
  RunPlanResource,
  RunPlanSandbox,
  RunPlanWorkContext,
  RunPlanWorkContextFacts,
  RunPlanWorkContextReference,
  type SessionKind,
  stageResultJsonSchema,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import type { EligibleWork } from "./classify";
import type { AssembledContext } from "./context-assembler";
import { operationPolicyProfile } from "./operation-policy";
import { type OperationDefinition, resolveStage } from "./playbook";
import type { RegisteredWorkspace } from "./projector";
import { ownedToolNames } from "./tools";

export const engineSettingScopeDirection = [
  "SettingsProfile",
  "RuntimeHost",
  "WorkspaceInput",
  "PrivateWorkspaceOverlay",
] as const satisfies readonly SettingScope["_tag"][];

const scopeRank = (scope: SettingScope) => engineSettingScopeDirection.indexOf(scope._tag);

const levelRank = (level: SettingLevel, context: OperationSettingContext) => {
  if (level._tag === "Default") return 0;
  if (level.workflow !== context.workflow) return -1;
  if (level._tag === "Workflow") return 1;
  return level.operation === context.operation ? 2 : -1;
};

const scopeApplies = (scope: OperationSettingRow["scope"], context: OperationSettingContext) => {
  if (scope._tag !== "PrivateWorkspaceOverlay") return true;
  return context.workspace !== null && scope.workspace === context.workspace;
};

const uniqueBindings = (bindings: readonly OperationBinding[]) =>
  bindings.filter(
    (binding, index) =>
      bindings.findIndex(
        (candidate) => candidate.need === binding.need && candidate.contribution === binding.contribution,
      ) === index,
  );

export const engineAdmissibleSettingScope = (
  family: "contribution" | "operation",
  setting: OperationSettingName | "enabled",
  scope: SettingScope["_tag"],
) => {
  if (family === "contribution") {
    return scope === "SettingsProfile" || scope === "PrivateWorkspaceOverlay";
  }
  if (scope === "WorkspaceInput") return false;
  if (scope === "RuntimeHost") return setting === "harness";
  return true;
};

export const resolveEngineContributionEnabled = <A extends ContributionEnabledRow>(
  rows: readonly A[],
  authority: string,
) => {
  const ordered = rows.toSorted((left, right) => scopeRank(left.scope) - scopeRank(right.scope));
  const winning = ordered.at(-1) ?? null;
  return {
    value: winning?.enabled ?? authority !== "local:repo",
    operator: "override-scalar" as const,
    winning,
    shadowed: winning ? ordered.slice(0, -1).toReversed() : [],
    dropped: [],
  };
};

export const resolveEngineContributionUnion = (rows: readonly ContributionUnionRow[]) => {
  const ordered = rows.toSorted((left, right) => scopeRank(left.scope) - scopeRank(right.scope));
  return {
    value: [...new Set(ordered.flatMap((row) => row.contributions))],
    operator: "union-values" as const,
    winning: ordered,
    shadowed: [],
    dropped: [],
  };
};

const operationRowsForContext = (rows: readonly OperationSettingRow[], context: OperationSettingContext) =>
  rows.filter((row) => scopeApplies(row.scope, context) && levelRank(row.level, context) >= 0);

const droppedReason = (row: OperationSettingRow, context: OperationSettingContext) => {
  if (!scopeApplies(row.scope, context)) return "scope does not apply to this workspace";
  if (levelRank(row.level, context) < 0) return "level does not apply to this operation";
  return null;
};

const selectedOperationRows = (
  rows: readonly OperationSettingRow[],
  setting: OperationSettingName,
  context: OperationSettingContext,
) => {
  const candidates = rows.filter((row) => row.setting === setting);
  const ranked = operationRowsForContext(candidates, context).map((row) => ({
    row,
    rank: levelRank(row.level, context),
  }));
  const selectedRank = Math.max(-1, ...ranked.map(({ rank }) => rank));
  const selected = ranked
    .filter(({ rank }) => rank === selectedRank)
    .map(({ row }) => row)
    .toSorted((left, right) => scopeRank(left.scope) - scopeRank(right.scope));
  const lowerLevel = ranked
    .filter(({ rank }) => rank !== selectedRank)
    .toSorted(
      (left, right) => left.rank - right.rank || scopeRank(left.row.scope) - scopeRank(right.row.scope),
    )
    .map(({ row }) => row);
  const dropped = candidates.flatMap((row) => {
    const reason = droppedReason(row, context);
    return reason ? [{ row, reason }] : [];
  });
  return { selected, lowerLevel, dropped };
};

const scalarResolution = (
  selected: readonly OperationSettingRow[],
  lowerLevel: readonly OperationSettingRow[],
  dropped: ReadonlyArray<{ readonly row: OperationSettingRow; readonly reason: string }>,
) => {
  const winning = selected.at(-1) ?? null;
  return {
    value: winning?.value ?? null,
    operator: "override-scalar" as const,
    winning,
    shadowed: [...selected.slice(0, -1).toReversed(), ...lowerLevel.toReversed()],
    dropped,
  };
};

const bindingResolution = (
  selected: readonly OperationSettingRow[],
  lowerLevel: readonly OperationSettingRow[],
  dropped: ReadonlyArray<{ readonly row: OperationSettingRow; readonly reason: string }>,
) => ({
  value: uniqueBindings(selected.flatMap((row) => (row.setting === "bindings" ? row.value : []))),
  operator: "union-values" as const,
  winning: selected,
  shadowed: lowerLevel.toReversed(),
  dropped,
});

export const resolveEngineOperationSetting = (
  rows: readonly OperationSettingRow[],
  setting: OperationSettingName,
  context: OperationSettingContext,
) => {
  const { selected, lowerLevel, dropped } = selectedOperationRows(rows, setting, context);
  if (setting === "bindings") return bindingResolution(selected, lowerLevel, dropped);
  return scalarResolution(selected, lowerLevel, dropped);
};

export const operatorForSetting = (setting: OperationSettingName) =>
  setting === "bindings" ? "union-values" : "override-scalar";

const stringValue = (value: unknown, fallback: string | null) =>
  typeof value === "string" ? value : fallback;

const booleanValue = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const isHarnessName = Schema.is(HarnessName);

const harnessValue = (value: unknown) => (isHarnessName(value) ? value : null);

const isPolicyProfile = Schema.is(RunPlanPolicyProfile);

const policyProfileValue = (value: unknown, fallback: RunPlanPolicyProfile) =>
  isPolicyProfile(value) ? value : fallback;

export interface ResolvedStage extends OperationDefinition {
  readonly enabled: boolean;
  readonly harness: HarnessName;
  readonly model: string | null;
  readonly effort: string | null;
}

export interface ResolvedOperation {
  readonly stage: ResolvedStage;
  readonly profile: RunPlanPolicyProfile;
  readonly settings: ReadonlyMap<OperationSettingName, ReturnType<typeof resolveEngineOperationSetting>>;
  readonly contributionSettings: ReadonlyArray<ContributionSettingRow>;
}

export const resolveRunPlanStage = (
  config: WorkspaceConfig,
  operation: LifecycleStage,
  rows: readonly OperationSettingRow[],
  contributionSettings: ReadonlyArray<ContributionSettingRow> = [],
) => {
  const base = resolveStage(config, operation);
  if (!base) return null;
  const context = { workflow: "coding", operation, workspace: config.name };
  const settings = new Map(
    operationSettingNames.map(
      (setting) => [setting, resolveEngineOperationSetting(rows, setting, context)] as const,
    ),
  );
  const settingValueOf = (setting: OperationSettingName) => settings.get(setting)?.value;
  const harness = harnessValue(settingValueOf("harness"));
  if (!harness) return null;
  return {
    stage: {
      ...base,
      enabled: booleanValue(settingValueOf("enabled"), false),
      harness,
      model: stringValue(settingValueOf("model"), null),
      effort: stringValue(settingValueOf("effort"), null),
    },
    profile: policyProfileValue(settingValueOf("permission-profile"), operationPolicyProfile(operation)),
    settings,
    contributionSettings,
  };
};

const scopeName = (scope: OperationSettingRow["scope"]) => {
  if (scope._tag === "SettingsProfile") return "Settings profile";
  if (scope._tag === "RuntimeHost") return "Runtime host";
  return `Private workspace overlay ${scope.workspace}`;
};

const levelName = (level: OperationSettingRow["level"]) => {
  if (level._tag === "Default") return "Default";
  if (level._tag === "Workflow") return `Workflow ${level.workflow}`;
  return `Operation ${level.workflow}/${level.operation}`;
};

const snapshotValue = <A>(value: A) => structuredClone(value);

const resolutionCandidate = (row: OperationSettingRow) =>
  RunPlanResolutionCandidate.make({
    scope: scopeName(row.scope),
    level: levelName(row.level),
    source: scopeName(row.scope),
    value: snapshotValue(row.value),
  });

const engineCandidate = (operation: LifecycleStage, value: unknown) =>
  RunPlanResolutionCandidate.make({
    scope: "Engine",
    level: `Operation coding/${operation}`,
    source: `${operation} Operation Definition`,
    value: snapshotValue(value),
  });

const winningRows = (winning: OperationSettingRow | readonly OperationSettingRow[] | null) => {
  if (winning === null) return [];
  return "setting" in winning ? [winning] : winning;
};

const effectiveSettingValue = (resolved: ResolvedOperation, setting: OperationSettingName) => {
  if (setting === "enabled") return resolved.stage.enabled;
  if (setting === "harness") return resolved.stage.harness;
  if (setting === "model") return resolved.stage.model;
  if (setting === "effort") return resolved.stage.effort;
  if (setting === "permission-profile") return resolved.profile;
  return resolved.settings.get("bindings")?.value ?? [];
};

const resolutionTrace = (
  resolved: ResolvedOperation,
  setting: OperationSettingName,
  operation: LifecycleStage,
) => {
  const resolution = resolved.settings.get(setting);
  const winners = resolution ? winningRows(resolution.winning) : [];
  const winner = winners.at(-1);
  const contributors = setting === "bindings" ? winners.map(resolutionCandidate) : [];
  const effective = effectiveSettingValue(resolved, setting);
  return RunPlanResolutionTrace.make({
    key: setting,
    operator: operatorForSetting(setting),
    winner: winner ? resolutionCandidate(winner) : engineCandidate(operation, effective),
    contributors,
    shadowed: resolution?.shadowed.map(resolutionCandidate) ?? [],
    dropped:
      resolution?.dropped.map(({ row, reason }) =>
        RunPlanDroppedCandidate.make({ candidate: resolutionCandidate(row), reason }),
      ) ?? [],
  });
};

const revisionOf = (content: string) => createHash("sha256").update(content).digest("hex");

const contentStamps = (
  context: AssembledContext,
  contributions: ReadonlyArray<FileContribution>,
  supplied: ReadonlyArray<ProvenanceStamp>,
) => {
  const stampedSources = new Set(supplied.map(({ source }) => source));
  const suppliedFiles = new Set(
    contributions.filter(({ authority }) => stampedSources.has(authority)).map(({ file }) => file),
  );
  return [...context.layers, ...context.operatingInstructionResources, ...context.sources]
    .filter(({ source }) => !suppliedFiles.has(source))
    .filter(
      (source, index, sources) =>
        sources.findIndex((candidate) => candidate.source === source.source) === index,
    )
    .map((source) => ContentRevision.make({ source: source.source, revision: revisionOf(source.content) }));
};

const contentStamp = (source: string, content: unknown) =>
  ContentRevision.make({
    source,
    revision: revisionOf(typeof content === "string" ? content : JSON.stringify(content)),
  });

const projectedNamePart = (value: string, maxLength: number) =>
  value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, maxLength) || "unnamed";

export const projectedContributionName = (identity: string) => {
  const parts = identity.split("/");
  const authority = projectedNamePart(parts[0] ?? identity, 18);
  const localName = projectedNamePart(parts.at(-1) ?? identity, 20);
  const identityHash = createHash("sha256").update(identity).digest("base64url").slice(0, 22);
  return `${authority}__${localName}__${identityHash}`;
};

const contributionMembers = (contributions: ReadonlyArray<FileContribution>, kind: string) =>
  contributions
    .filter((contribution) => contribution.kind === kind)
    .map((contribution) =>
      RunPlanContributionMember.make({
        identity: contribution.id,
        name: projectedContributionName(contribution.id),
        source: contribution.file,
      }),
    );

const contributionRows = (
  settings: ReadonlyArray<ContributionSettingRow>,
  contribution: FileContribution,
  workspace: WorkspaceConfig["name"] | null,
) =>
  settings.filter(
    (setting) =>
      setting.contribution.id === contribution.id &&
      (setting.scope._tag === "SettingsProfile" || setting.scope.workspace === workspace),
  );

const droppedContributionSettings = (
  settings: ReadonlyArray<ContributionSettingRow>,
  contribution: FileContribution,
  workspace: WorkspaceConfig["name"],
) =>
  settings
    .filter(
      (setting) =>
        setting.contribution.id === contribution.id &&
        setting.scope._tag === "PrivateWorkspaceOverlay" &&
        setting.scope.workspace !== workspace,
    )
    .map((setting) =>
      RunPlanDroppedCandidate.make({
        candidate: contributionSettingCandidate(setting),
        reason: "scope does not apply to this workspace",
      }),
    );

const contributionGate = (
  contribution: FileContribution,
  settings: ReadonlyArray<ContributionSettingRow>,
  workspace: WorkspaceConfig["name"] | null,
) =>
  resolveEngineContributionEnabled(
    contributionRows(settings, contribution, workspace),
    contribution.authority,
  );

export const admittedContributions = (
  contributions: ReadonlyArray<FileContribution>,
  settings: ReadonlyArray<ContributionSettingRow> = [],
  workspace: WorkspaceConfig["name"] | null = null,
) =>
  contributions.filter(
    (contribution) =>
      contribution.kind !== "mcp-server" || contributionGate(contribution, settings, workspace).value,
  );

const contributionSettingCandidate = (setting: ContributionSettingRow) =>
  RunPlanResolutionCandidate.make({
    scope: scopeName(setting.scope),
    level: "Default",
    source: scopeName(setting.scope),
    value: setting.enabled,
  });

const droppedContribution = (
  contribution: FileContribution,
  resolution: ReturnType<typeof resolveEngineContributionEnabled>,
) => {
  if (resolution.value) return [];
  const reason = resolution.winning
    ? "contribution entry gate disabled"
    : "contribution entry gate disabled by default";
  return [
    RunPlanDroppedCandidate.make({
      candidate: RunPlanResolutionCandidate.make({
        scope: contribution.authority,
        level: "Default",
        source: contribution.file,
        value: true,
      }),
      reason,
    }),
  ];
};

const contributionGateTrace = (
  contribution: FileContribution,
  settings: ReadonlyArray<ContributionSettingRow>,
  workspace: WorkspaceConfig["name"],
) => {
  const resolution = contributionGate(contribution, settings, workspace);
  return RunPlanResolutionTrace.make({
    key: `contribution:${contribution.id}:enabled`,
    operator: "override-scalar",
    winner: resolution.winning
      ? contributionSettingCandidate(resolution.winning)
      : RunPlanResolutionCandidate.make({
          scope: "Engine",
          level: "Default",
          source: `${contribution.authority} default`,
          value: resolution.value,
        }),
    contributors: [],
    shadowed: resolution.shadowed.map(contributionSettingCandidate),
    dropped: [
      ...droppedContributionSettings(settings, contribution, workspace),
      ...droppedContribution(contribution, resolution),
    ],
  });
};

const instructions = (context: AssembledContext) =>
  context.layers.map((layer) =>
    RunPlanInstruction.make({
      ...layer,
    }),
  );

const deepFreeze = <A>(value: A): A => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

export const freezeRunPlan = (plan: RunPlan) => deepFreeze(plan);

const structuredOutput = (operation: LifecycleStage) =>
  stageResultJsonSchema(operation)?.["~standard"].jsonSchema.input({ target: "draft-2020-12" }) ?? null;

const projectionFor = (projectedMembers: ReadonlyArray<RunPlanMemberType>) => {
  const projected = new Set(projectedMembers);
  return RunPlanMember.literals.map((member) =>
    projected.has(member)
      ? RunPlanProjectionDisposition.make({ member, disposition: "projected" })
      : RunPlanProjectionDisposition.make({
          member,
          disposition: "not-projected",
          reason: "selected harness does not project this member",
        }),
  );
};

interface NamedPlanMember {
  readonly identity: string;
  readonly name: string;
}

const projectionReason = (member: RunPlanMemberType) => `selected harness does not project ${member}`;

const namedProjectionFor = (
  member: RunPlanMemberType,
  members: ReadonlyArray<NamedPlanMember>,
  projectedMembers: ReadonlySet<RunPlanMemberType>,
) => {
  if (projectedMembers.has(member)) return [];
  return members.map(({ identity }) =>
    RunPlanProjectionDisposition.make({
      member: `${member} ${identity}`,
      disposition: "not-projected",
      reason: projectionReason(member),
    }),
  );
};

const projectedNamesFor = (
  member: RunPlanMemberType,
  members: ReadonlyArray<NamedPlanMember>,
  projectedMembers: ReadonlySet<RunPlanMemberType>,
) =>
  projectedMembers.has(member)
    ? members.map(({ identity, name }) => RunPlanProjectedName.make({ identity, name }))
    : [];

const unprojectedMcp = (members: ReadonlyArray<RunPlanContributionMember>) =>
  members.map((member) =>
    RunPlanProjectionDisposition.make({
      member: `MCP ${member.identity}`,
      disposition: "not-projected",
      reason: "local MCP contribution has no resolved endpoint",
    }),
  );

const mcpIdentity = (name: string, endpoint: string) =>
  `engine/mcp/${revisionOf(JSON.stringify({ name, endpoint }))}`;

const mcpServers = (servers: ReadonlyArray<RunPlanMcpServerInput>) =>
  servers.map((server) => {
    const identity = server.identity ?? mcpIdentity(server.name, server.endpoint);
    return RunPlanMcpServer.make({
      identity,
      name: server.name,
      projectedName: projectedContributionName(identity),
      endpoint: server.endpoint,
      authenticated: server.authenticated,
    });
  });

export const admittedMcpServers = <A extends { readonly identity: string | null }>(
  servers: ReadonlyArray<A>,
  contributions: ReadonlyArray<FileContribution>,
) => {
  const admittedIdentities = new Set(contributions.map(({ id }) => id));
  return servers.filter(({ identity }) => identity === null || admittedIdentities.has(identity));
};

export interface RunPlanMcpServerInput {
  readonly identity: string | null;
  readonly name: string;
  readonly endpoint: string;
  readonly authenticated: boolean;
}

export interface AssembleRunPlanInput {
  readonly runId: RunId;
  readonly workspace: RegisteredWorkspace;
  readonly item: EligibleWork;
  readonly observation: RunPlanObservation;
  readonly resolved: ResolvedOperation;
  readonly prompt: string;
  readonly checkoutPath: string;
  readonly sessionKind: SessionKind;
  readonly context: AssembledContext;
  readonly projectedMembers: ReadonlyArray<RunPlanMemberType>;
  readonly middleware: ReadonlyArray<RunPlanMiddlewareName>;
  readonly contributions: ReadonlyArray<FileContribution>;
  readonly mcpServers: ReadonlyArray<RunPlanMcpServerInput>;
  readonly provenanceStamps: ReadonlyArray<ProvenanceStamp>;
}

export const assembleRunPlan = (input: AssembleRunPlanInput) => {
  const workContext = input.item.workContext;
  const observation = RunPlanObservation.make({ ...input.observation });
  const admitted = admittedContributions(
    input.contributions,
    input.resolved.contributionSettings,
    input.workspace.config.name,
  );
  const admittedServers = admittedMcpServers(input.mcpServers, admitted);
  const mcpServersForRun = mcpServers(admittedServers);
  const resolvedMcpIdentities = new Set(
    admittedServers.flatMap(({ identity }) => (identity === null ? [] : [identity])),
  );
  const unresolvedMcp = contributionMembers(admitted, "mcp-server").filter(
    ({ identity }) => !resolvedMcpIdentities.has(identity),
  );
  const skills = contributionMembers(admitted, "skill");
  const subagents = contributionMembers(admitted, "subagent");
  const commands = contributionMembers(admitted, "command");
  const projectedMembers = new Set(input.projectedMembers);
  const namedMcpServers = mcpServersForRun.map(({ identity, projectedName: name }) => ({ identity, name }));
  const namedProjection = [
    ...namedProjectionFor("MCP", namedMcpServers, projectedMembers),
    ...namedProjectionFor("Skills", skills, projectedMembers),
    ...namedProjectionFor("Subagents", subagents, projectedMembers),
    ...namedProjectionFor("Commands", commands, projectedMembers),
  ];
  const projectedNames = [
    ...projectedNamesFor("MCP", namedMcpServers, projectedMembers),
    ...projectedNamesFor("Skills", skills, projectedMembers),
    ...projectedNamesFor("Subagents", subagents, projectedMembers),
    ...projectedNamesFor("Commands", commands, projectedMembers),
  ];
  const mcp = [...mcpServersForRun, ...unresolvedMcp];
  const engineStamps = [
    contentStamp(`${input.item.stage} Operation Definition`, {
      operation: input.item.stage,
      operatingInstructions: input.resolved.stage.skill,
    }),
    contentStamp("Engine Harness Adapter", {
      name: input.resolved.stage.harness,
      model: input.resolved.stage.model,
      effort: input.resolved.stage.effort,
      profile: input.resolved.profile,
    }),
    contentStamp("Engine Messages", [{ role: "user", content: input.prompt }]),
    contentStamp("Engine Work Context", { ...workContext, observation }),
    contentStamp("Engine Tools", ownedToolNames),
    contentStamp("Engine Middleware", input.middleware),
    contentStamp("Engine Sandbox", { workspace: input.checkoutPath, policy: input.resolved.profile }),
    contentStamp("Engine Structured Output", structuredOutput(input.item.stage)),
    contentStamp("Engine Persistence", { sessionKind: input.sessionKind }),
    contentStamp(
      "Engine Connections",
      input.resolved.stage.mcpSkills
        .filter((server) => server.auth !== undefined)
        .map((server) => server.name),
    ),
  ];
  return freezeRunPlan(
    RunPlan.make({
      id: input.runId,
      operation: input.item.stage,
      harness: RunPlanHarness.make({
        name: input.resolved.stage.harness,
        model: input.resolved.stage.model,
        effort: input.resolved.stage.effort,
        profile: input.resolved.profile,
      }),
      instructions: instructions(input.context),
      operatingInstructions: RunPlanOperatingInstructions.make({
        name: input.resolved.stage.skill,
        path: input.context.operatingInstructionsPath,
        resources: input.context.operatingInstructionResources.map((resource) =>
          RunPlanResource.make(resource),
        ),
      }),
      messages: [RunPlanMessage.make({ role: "user", content: input.prompt })],
      tools: projectedMembers.has("Tools") ? [...ownedToolNames] : [],
      skills,
      mcp,
      subagents,
      commands,
      hooks: [],
      middleware: [...input.middleware],
      structuredOutput: structuredOutput(input.item.stage),
      connections: input.resolved.stage.mcpSkills
        .filter((server) => server.auth !== undefined)
        .map((server) => server.name),
      workContext: RunPlanWorkContext.make({
        reference: RunPlanWorkContextReference.make({ ...workContext.reference }),
        facts: RunPlanWorkContextFacts.make({
          ...workContext.facts,
          roles: [...workContext.facts.roles],
          assignees: [...workContext.facts.assignees],
          claim: snapshotValue(workContext.facts.claim),
          pr: snapshotValue(workContext.facts.pr),
        }),
        observation,
      }),
      sandbox: RunPlanSandbox.make({
        workspace: input.checkoutPath,
        policy: input.resolved.profile,
      }),
      persistence: RunPlanPersistence.make({ sessionKind: input.sessionKind }),
      provenance: RunPlanProvenance.make({
        resolution: operationSettingNames
          .map((setting) => resolutionTrace(input.resolved, setting, input.item.stage))
          .concat(
            input.contributions
              .filter((contribution) => contribution.kind === "mcp-server")
              .map((contribution) =>
                contributionGateTrace(
                  contribution,
                  input.resolved.contributionSettings,
                  input.workspace.config.name,
                ),
              ),
          ),
        stamps: [
          ...contentStamps(input.context, input.contributions, input.provenanceStamps),
          ...input.provenanceStamps,
          ...engineStamps,
        ],
        projectedNames,
        projection: [
          ...projectionFor(input.projectedMembers),
          ...namedProjection,
          ...unprojectedMcp(unresolvedMcp),
        ],
        observation,
      }),
    }),
  );
};
