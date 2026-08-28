import { createHash } from "node:crypto";
import type {
  ContributionEnabledRow,
  ContributionUnionRow,
  LocalContribution,
  OperationBinding,
  OperationSettingContext,
  OperationSettingName,
  OperationSettingRow,
  SettingLevel,
  SettingScope,
  WorkspaceConfig,
} from "@cogwork/contracts";
import {
  HarnessName,
  type LifecycleStage,
  operationSettingNames,
  type RunId,
  RunPlan,
  RunPlanContentRevision,
  RunPlanContributionMember,
  RunPlanDroppedCandidate,
  RunPlanHarness,
  RunPlanInstruction,
  RunPlanMcpServer,
  RunPlanMember,
  type RunPlanMember as RunPlanMemberType,
  RunPlanMessage,
  RunPlanObservation,
  RunPlanOperatingInstructions,
  RunPlanPersistence,
  RunPlanPolicyProfile,
  RunPlanProjectedName,
  RunPlanProjectionDisposition,
  RunPlanProvenance,
  RunPlanResolutionCandidate,
  RunPlanResolutionTrace,
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
import { type ResolvedStage, resolveStage } from "./playbook";
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

export const resolveEngineContributionEnabled = (
  rows: readonly ContributionEnabledRow[],
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

const settingValue = (
  rows: readonly OperationSettingRow[],
  setting: OperationSettingName,
  context: OperationSettingContext,
) => resolveEngineOperationSetting(rows, setting, context);

const stringValue = (value: unknown, fallback: string | null) =>
  typeof value === "string" ? value : fallback;

const booleanValue = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const isHarnessName = Schema.is(HarnessName);

const harnessValue = (value: unknown, fallback: ResolvedStage["harness"]) =>
  isHarnessName(value) ? value : fallback;

const isPolicyProfile = Schema.is(RunPlanPolicyProfile);

const policyProfileValue = (value: unknown, fallback: RunPlanPolicyProfile) =>
  isPolicyProfile(value) ? value : fallback;

export interface ResolvedRunPlanStage {
  readonly stage: ResolvedStage;
  readonly profile: RunPlanPolicyProfile;
  readonly settings: ReadonlyMap<OperationSettingName, ReturnType<typeof resolveEngineOperationSetting>>;
}

export const resolveRunPlanStage = (
  config: WorkspaceConfig,
  operation: LifecycleStage,
  rows: readonly OperationSettingRow[],
) => {
  const base = resolveStage(config, operation);
  if (!base) return null;
  const context = { workflow: "coding", operation, workspace: config.name };
  const settings = new Map(
    operationSettingNames.map((setting) => [setting, settingValue(rows, setting, context)] as const),
  );
  const settingValueOf = (setting: OperationSettingName) => settings.get(setting)?.value;
  return {
    stage: {
      ...base,
      enabled: booleanValue(settingValueOf("enabled"), base.enabled),
      harness: harnessValue(settingValueOf("harness"), base.harness),
      model: stringValue(settingValueOf("model"), base.model),
      effort: stringValue(settingValueOf("effort"), base.effort),
    },
    profile: policyProfileValue(settingValueOf("permission-profile"), operationPolicyProfile(operation)),
    settings,
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

const effectiveSettingValue = (resolved: ResolvedRunPlanStage, setting: OperationSettingName) => {
  if (setting === "enabled") return resolved.stage.enabled;
  if (setting === "harness") return resolved.stage.harness;
  if (setting === "model") return resolved.stage.model;
  if (setting === "effort") return resolved.stage.effort;
  if (setting === "permission-profile") return resolved.profile;
  return resolved.settings.get("bindings")?.value ?? [];
};

const resolutionTrace = (
  resolved: ResolvedRunPlanStage,
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

const contentStamps = (context: AssembledContext) =>
  [...context.layers, ...context.sources]
    .filter(
      (source, index, sources) =>
        sources.findIndex((candidate) => candidate.source === source.source) === index,
    )
    .map((source) =>
      RunPlanContentRevision.make({ source: source.source, revision: revisionOf(source.content) }),
    );

const projectedName = (identity: string) =>
  `cogwork_${Array.from(identity, (character) => character.codePointAt(0)?.toString(16) ?? "").join("_")}`;

const contributionMembers = (workspace: RegisteredWorkspace, kind: string) =>
  workspace.contributions
    .filter((contribution) => contribution.kind === kind)
    .map((contribution) =>
      RunPlanContributionMember.make({
        identity: contribution.id,
        name: projectedName(contribution.id),
        source: contribution.file,
      }),
    );

export const admittedContributions = (contributions: ReadonlyArray<LocalContribution>) =>
  contributions.filter(
    (contribution) =>
      contribution.kind !== "mcp-server" ||
      resolveEngineContributionEnabled([], contribution.authority).value,
  );

const contributionGateTrace = (contribution: LocalContribution) => {
  const enabled = resolveEngineContributionEnabled([], contribution.authority).value;
  const candidate = RunPlanResolutionCandidate.make({
    scope: contribution.authority,
    level: "Contribution entry gate",
    source: contribution.file,
    value: true,
  });
  return RunPlanResolutionTrace.make({
    key: `contribution:${contribution.id}:enabled`,
    operator: "override-scalar",
    winner: RunPlanResolutionCandidate.make({
      scope: "Engine",
      level: "Contribution entry gate",
      source: `${contribution.authority} default`,
      value: enabled,
    }),
    contributors: [],
    shadowed: [],
    dropped: enabled
      ? []
      : [
          RunPlanDroppedCandidate.make({
            candidate,
            reason: "contribution entry gate disabled by default",
          }),
        ],
  });
};

const instructions = (context: AssembledContext) =>
  context.layers.map((layer) =>
    RunPlanInstruction.make({
      ...layer,
      kind: layer.kind === "playbook" ? "operating-instructions" : layer.kind,
    }),
  );

const deepFreeze = <A>(value: A): A => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

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

const unprojectedLocalMcp = (workspace: RegisteredWorkspace) =>
  contributionMembers(workspace, "mcp-server").map((member) =>
    RunPlanProjectionDisposition.make({
      member: `MCP ${member.identity}`,
      disposition: "not-projected",
      reason: "local MCP contribution has no resolved endpoint",
    }),
  );

const mcpIdentity = (name: string, endpoint: string) =>
  `engine/mcp/${revisionOf(JSON.stringify({ name, endpoint }))}`;

const mcpServers = (resolved: ResolvedRunPlanStage) =>
  resolved.stage.mcpSkills.map((server) => {
    const identity = mcpIdentity(server.name, server.endpoint);
    return RunPlanMcpServer.make({
      identity,
      name: server.name,
      projectedName: projectedName(identity),
      endpoint: server.endpoint,
      authenticated: server.auth !== undefined,
    });
  });

export interface AssembleRunPlanInput {
  readonly runId: RunId;
  readonly workspace: RegisteredWorkspace;
  readonly item: EligibleWork;
  readonly observation: RunPlanObservation;
  readonly resolved: ResolvedRunPlanStage;
  readonly prompt: string;
  readonly checkoutPath: string;
  readonly sessionKind: SessionKind;
  readonly context: AssembledContext;
  readonly projectedMembers: ReadonlyArray<RunPlanMemberType>;
  readonly middleware: ReadonlyArray<string>;
}

export const assembleRunPlan = (input: AssembleRunPlanInput) => {
  const workContext = input.item.workContext;
  const observation = RunPlanObservation.make({ ...input.observation });
  const admittedWorkspace = {
    ...input.workspace,
    contributions: admittedContributions(input.workspace.contributions),
  };
  const mcpServersForRun = mcpServers(input.resolved);
  const localMcp = contributionMembers(admittedWorkspace, "mcp-server");
  const mcp = [...mcpServersForRun, ...localMcp];
  const operationSource = `${input.item.stage} Operation Definition`;
  const operationRevision = revisionOf(
    JSON.stringify({
      operation: input.item.stage,
      stage: input.resolved.stage,
      prompt: input.prompt,
      skillPath: input.context.skillPath,
    }),
  );
  return deepFreeze(
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
        path: input.context.skillPath,
      }),
      messages: [RunPlanMessage.make({ role: "user", content: input.prompt })],
      tools: input.projectedMembers.includes("Tools") ? [...ownedToolNames] : [],
      skills: contributionMembers(admittedWorkspace, "skill"),
      mcp,
      subagents: contributionMembers(admittedWorkspace, "subagent"),
      commands: contributionMembers(admittedWorkspace, "command"),
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
            input.workspace.contributions
              .filter((contribution) => contribution.kind === "mcp-server")
              .map(contributionGateTrace),
          ),
        stamps: [
          ...contentStamps(input.context),
          RunPlanContentRevision.make({ source: operationSource, revision: operationRevision }),
        ],
        projectedNames: input.projectedMembers.includes("MCP")
          ? mcpServersForRun.map((server) =>
              RunPlanProjectedName.make({ identity: server.identity, name: server.projectedName }),
            )
          : [],
        projection: [...projectionFor(input.projectedMembers), ...unprojectedLocalMcp(admittedWorkspace)],
        observation,
      }),
    }),
  );
};
