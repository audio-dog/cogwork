import { createHash } from "node:crypto";
import type {
  AvailabilityCause,
  ContributionEnabledRow,
  ContributionSettingRow,
  ContributionUnionRow,
  FileContribution,
  OperationBinding,
  OperationNeed,
  OperationNeedKind,
  OperationSettingContext,
  OperationSettingName,
  OperationSettingRow,
  SettingLevel,
  SettingScope,
  WorkspaceConfig,
} from "@cogwork/contracts";
import {
  ContentRevision,
  ContributionSettingScope,
  HarnessName,
  type LifecycleStage,
  OperationBinding as OperationBindingSchema,
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
  type RunPlanPolicyProfile,
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
  SettingLevel as SettingLevelSchema,
  SettingScope as SettingScopeSchema,
  stageResultJsonSchema,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
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

const scopeRank = (scope: SettingScope) =>
  SettingScopeSchema.match(scope, {
    SettingsProfile: () => 0,
    RuntimeHost: () => 1,
    WorkspaceInput: () => 2,
    PrivateWorkspaceOverlay: () => 3,
  });

const levelRank = (level: SettingLevel, context: OperationSettingContext) =>
  SettingLevelSchema.match(level, {
    Default: () => 0,
    Workflow: ({ workflow }) => (workflow === context.workflow ? 1 : -1),
    Operation: ({ workflow, operation }) =>
      workflow === context.workflow && operation === context.operation ? 2 : -1,
  });

const scopeApplies = (scope: OperationSettingRow["scope"], context: OperationSettingContext) =>
  SettingScopeSchema.match(scope, {
    SettingsProfile: () => true,
    RuntimeHost: () => true,
    WorkspaceInput: () => true,
    PrivateWorkspaceOverlay: ({ workspace }) => context.workspace !== null && workspace === context.workspace,
  });

const uniqueBindings = (bindings: readonly OperationBinding[]) =>
  bindings.filter(
    (binding, index) =>
      bindings.findIndex(
        (candidate) => candidate.need === binding.need && candidate.contribution === binding.contribution,
      ) === index,
  );

export interface AvailabilityContribution {
  readonly id: string;
  readonly kind: OperationNeedKind | "rules";
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly reason: string | null;
}

export interface AvailabilityInput {
  readonly needs: ReadonlyArray<OperationNeed>;
  readonly bindings: ReadonlyArray<OperationBinding>;
  readonly contributions: ReadonlyArray<AvailabilityContribution>;
  readonly projectedMembers: ReadonlyArray<RunPlanMemberType>;
}

const memberForNeed = (kind: OperationNeedKind) => {
  if (kind === "mcp-server") return "MCP";
  if (kind === "skill") return "Skills";
  if (kind === "subagent") return "Subagents";
  if (kind === "command") return "Commands";
  if (kind === "hook") return "Hooks";
  return "Connections";
};

const unsatisfiedNeed = (
  need: OperationNeed,
  reason: Extract<AvailabilityCause, { readonly _tag: "UnsatisfiedNeed" }>["reason"],
  contribution: string | null,
  message: string,
) =>
  ({
    _tag: "UnsatisfiedNeed",
    need: need.name,
    kind: need.kind,
    reason,
    contribution,
    message,
  }) satisfies AvailabilityCause;

const contributionCause = (
  need: OperationNeed,
  contribution: AvailabilityContribution,
  projectedMembers: ReadonlyArray<RunPlanMemberType>,
) => {
  if (!contribution.enabled) {
    return unsatisfiedNeed(need, "off", contribution.id, `${contribution.id} is off`);
  }
  if (!contribution.ready) {
    return unsatisfiedNeed(
      need,
      "not-ready",
      contribution.id,
      contribution.reason ?? `${contribution.id} is not ready`,
    );
  }
  const member = memberForNeed(need.kind);
  if (!projectedMembers.includes(member)) {
    return unsatisfiedNeed(need, "not-ready", contribution.id, `selected Harness does not project ${member}`);
  }
  return null;
};

const causesForNeed = (input: AvailabilityInput, need: OperationNeed) => {
  const bindings = input.bindings.filter((binding) => binding.need === need.name);
  if (bindings.length === 0) {
    return [unsatisfiedNeed(need, "unbound", null, `${need.name} is unbound`)];
  }
  const contributions = new Map(input.contributions.map((contribution) => [contribution.id, contribution]));
  const causes = bindings.map(({ contribution: id }) => {
    const contribution = contributions.get(id);
    if (!contribution || contribution.kind !== need.kind) {
      return unsatisfiedNeed(need, "unavailable", id, `${id} is not available as ${need.kind}`);
    }
    return contributionCause(need, contribution, input.projectedMembers);
  });
  return causes.some((cause) => cause === null) ? [] : causes.filter((cause) => cause !== null);
};

export const availabilityCauses = (input: AvailabilityInput) =>
  input.needs.flatMap((need) => causesForNeed(input, need));

export const engineAdmissibleSettingScope = (
  family: "contribution" | "operation",
  setting: OperationSettingName | "enabled",
  scope: SettingScope,
) =>
  SettingScopeSchema.match(scope, {
    SettingsProfile: () => true,
    RuntimeHost: () => family === "operation" && setting === "harness",
    WorkspaceInput: () => false,
    PrivateWorkspaceOverlay: () => true,
  });

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

const isBlankOptionalStringSetting = (row: OperationSettingRow) =>
  (row.setting === "model" || row.setting === "effort") &&
  typeof row.value === "string" &&
  row.value.trim() === "";

const selectedOperationRows = (
  rows: readonly OperationSettingRow[],
  setting: OperationSettingName,
  context: OperationSettingContext,
) => {
  const candidates = rows.filter((row) => row.setting === setting);
  const ranked = operationRowsForContext(candidates, context)
    .filter((row) => !isBlankOptionalStringSetting(row))
    .map((row) => ({
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
    const reason =
      droppedReason(row, context) ?? (isBlankOptionalStringSetting(row) ? "blank value is unset" : null);
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

const trimmedStringValue = (value: unknown, fallback: string | null) => {
  if (typeof value !== "string") return fallback;
  return value.trim() || fallback;
};

const booleanValue = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const isHarnessName = Schema.is(HarnessName);

const harnessValue = (value: unknown) => (isHarnessName(value) ? value : null);

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

const isOperationBindings = Schema.is(Schema.Array(OperationBindingSchema));

export const operationBindingsOf = (resolved: ResolvedOperation) => {
  const value = resolved.settings.get("bindings")?.value;
  return isOperationBindings(value) ? value : [];
};

export const resolveRunPlanStage = (
  config: WorkspaceConfig,
  operation: LifecycleStage,
  rows: readonly OperationSettingRow[],
  contributionSettings: ReadonlyArray<ContributionSettingRow> = [],
) => {
  const base = resolveStage(config, operation);
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
      model: trimmedStringValue(settingValueOf("model"), null),
      effort: trimmedStringValue(settingValueOf("effort"), null),
    },
    profile: operationPolicyProfile(operation),
    settings,
    contributionSettings,
  };
};

const scopeName = (scope: OperationSettingRow["scope"]) =>
  SettingScopeSchema.match(scope, {
    SettingsProfile: () => "Settings profile",
    RuntimeHost: () => "Runtime host",
    WorkspaceInput: ({ workspace }) => `Workspace input ${workspace}`,
    PrivateWorkspaceOverlay: ({ workspace }) => `Private workspace overlay ${workspace}`,
  });

const levelName = (level: OperationSettingRow["level"]) =>
  SettingLevelSchema.match(level, {
    Default: () => "Default",
    Workflow: ({ workflow }) => `Workflow ${workflow}`,
    Operation: ({ workflow, operation }) => `Operation ${workflow}/${operation}`,
  });

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
  const definitionLocked = setting === "permission-profile";
  const winner = definitionLocked ? undefined : winners.at(-1);
  const contributors = setting === "bindings" ? winners.map(resolutionCandidate) : [];
  const effective = effectiveSettingValue(resolved, setting);
  const shadowed = resolution?.shadowed ?? [];
  const lockedRows = definitionLocked ? [...winners, ...shadowed] : [];
  const dropped = [
    ...(resolution?.dropped.map(({ row, reason }) =>
      RunPlanDroppedCandidate.make({ candidate: resolutionCandidate(row), reason }),
    ) ?? []),
    ...lockedRows.map((row) =>
      RunPlanDroppedCandidate.make({
        candidate: resolutionCandidate(row),
        reason: "Operation Definition locks this setting",
      }),
    ),
  ];
  return RunPlanResolutionTrace.make({
    key: setting,
    operator: operatorForSetting(setting),
    winner: winner ? resolutionCandidate(winner) : engineCandidate(operation, effective),
    contributors,
    shadowed: definitionLocked ? [] : shadowed.map(resolutionCandidate),
    dropped,
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

const contributionMembers = (
  contributions: ReadonlyArray<FileContribution>,
  kind: string,
  unavailableReasons: ReadonlyMap<string, string> = new Map(),
) =>
  contributions
    .filter((contribution) => contribution.kind === kind)
    .map((contribution) =>
      RunPlanContributionMember.make({
        identity: contribution.id,
        name: projectedContributionName(contribution.id),
        source: contribution.file,
        ...(unavailableReasons.get(contribution.id)
          ? { unavailableReason: unavailableReasons.get(contribution.id) }
          : {}),
      }),
    );

export const applicableContributionSettings = (
  settings: ReadonlyArray<ContributionSettingRow>,
  contribution: FileContribution,
  workspace: WorkspaceConfig["name"] | null,
) =>
  settings.filter(
    (setting) =>
      setting.contribution.id === contribution.id &&
      (ContributionSettingScope.guards.SettingsProfile(setting.scope) ||
        setting.scope.workspace === workspace),
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
        ContributionSettingScope.guards.PrivateWorkspaceOverlay(setting.scope) &&
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
    applicableContributionSettings(settings, contribution, workspace),
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
  stageResultJsonSchema(operation)["~standard"].jsonSchema.input({ target: "draft-2020-12" });

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

const mcpServer = (server: RunPlanMcpServerInput) => {
  const name = server.name.trim();
  const endpoint = server.endpoint.trim();
  const identity = server.identity ?? mcpIdentity(name, endpoint);
  return RunPlanMcpServer.make({
    identity,
    name,
    projectedName: projectedContributionName(identity),
    endpoint,
    authenticated: server.authenticated,
    unavailableReason: server.unavailableReason ?? null,
  });
};

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
  readonly unavailableReason?: string | null;
}

export interface RunPlanMcpServerCandidate {
  readonly identity: string | null;
  readonly name: string;
  readonly endpoint: string;
  readonly bearer: Redacted.Redacted<string> | null;
  readonly unavailableReason?: string | null;
}

interface RunPlanAssemblyInput {
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
  readonly provenanceStamps: ReadonlyArray<ProvenanceStamp>;
  readonly unavailableContributionReasons?: ReadonlyMap<string, string>;
}

export interface AssembleRunPlanInput extends RunPlanAssemblyInput {
  readonly mcpServers: ReadonlyArray<RunPlanMcpServerInput>;
}

export interface BuildRunPlanInput extends Omit<RunPlanAssemblyInput, "context"> {}

export interface CompleteRunPlanInput {
  readonly context: AssembledContext;
  readonly mcpServers: ReadonlyArray<RunPlanMcpServerCandidate>;
}

export class RunPlanAssemblyError extends Schema.TaggedError<RunPlanAssemblyError>()("RunPlanAssemblyError", {
  message: Schema.String,
  cause: Schema.Defect(),
  retryable: Schema.Boolean,
}) {}

const schemaConstructorNameFromStack = (cause: Error) =>
  cause.stack?.match(/\bnew (RunPlan\w+)/)?.[1] ?? "RunPlan";

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

const formatAssemblyError = (cause: unknown) => {
  if (!(cause instanceof Error) || !SchemaIssue.isIssue(cause.cause)) {
    return `RunPlan: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return `${schemaConstructorNameFromStack(cause)}: ${formatSchemaIssue(cause.cause)}`;
};

export const runPlanAssemblyError = (cause: unknown) =>
  new RunPlanAssemblyError({ message: formatAssemblyError(cause), cause, retryable: true });

interface PreparedRunPlanMcpServer {
  readonly plan: RunPlanMcpServer;
  readonly credential: Redacted.Redacted<string> | null;
}

const preparePlanMcpServer = (server: RunPlanMcpServerInput) => ({
  plan: mcpServer(server),
  credential: null,
});

const prepareCandidateMcpServer = (server: RunPlanMcpServerCandidate) => ({
  plan: mcpServer({
    identity: server.identity,
    name: server.name,
    endpoint: server.endpoint,
    authenticated: server.bearer !== null,
    unavailableReason: server.unavailableReason,
  }),
  credential: server.bearer,
});

const assemble = <McpServer extends { readonly identity: string | null }>(
  input: RunPlanAssemblyInput & { readonly mcpServers: ReadonlyArray<McpServer> },
  prepareMcpServer: (server: McpServer) => PreparedRunPlanMcpServer,
  admitted = admittedContributions(
    input.contributions,
    input.resolved.contributionSettings,
    input.workspace.config.name,
  ),
) => {
  const workContext = input.item.workContext;
  const observation = RunPlanObservation.make({ ...input.observation });
  const admittedServers = admittedMcpServers(input.mcpServers, admitted);
  const preparedMcpServers = admittedServers.map(prepareMcpServer);
  const mcpServersForRun = preparedMcpServers.map(({ plan }) => plan);
  const resolvedMcpIdentities = new Set(
    admittedServers.flatMap(({ identity }) => (identity === null ? [] : [identity])),
  );
  const unresolvedMcp = contributionMembers(
    admitted,
    "mcp-server",
    input.unavailableContributionReasons,
  ).filter(({ identity }) => !resolvedMcpIdentities.has(identity));
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
  const connectionNames = input.resolved.stage.mcpSkills
    .filter((server) => server.auth !== undefined)
    .map((server) => server.name.trim());
  const engineStamps = [
    contentStamp(`${input.item.stage} Operation Definition`, {
      operation: input.item.stage,
      operatingInstructions: input.resolved.stage.skill,
      needs: input.resolved.stage.needs,
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
    contentStamp("Engine Connections", connectionNames),
  ];
  const plan = freezeRunPlan(
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
      connections: connectionNames,
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
  const mcpCredentials: ReadonlyMap<string, Redacted.Redacted<string>> = new Map(
    preparedMcpServers.flatMap(({ plan: server, credential }) =>
      credential === null
        ? []
        : [[server.identity, credential] satisfies readonly [string, Redacted.Redacted<string>]],
    ),
  );
  return { plan, mcpCredentials };
};

export const buildRunPlan = (input: BuildRunPlanInput) => {
  const contributions = deepFreeze(
    admittedContributions(
      input.contributions,
      input.resolved.contributionSettings,
      input.workspace.config.name,
    ).map((contribution) => ({ ...contribution })),
  );
  return {
    contributions,
    complete: ({ context, mcpServers }: CompleteRunPlanInput) =>
      assemble({ ...input, context, mcpServers }, prepareCandidateMcpServer, contributions),
  };
};

export const assembleRunPlan = (input: AssembleRunPlanInput) => assemble(input, preparePlanMcpServer).plan;

export const tryAssembleRunPlan = Effect.fn("RunPlan.tryAssemble")((input: AssembleRunPlanInput) =>
  Effect.try({
    try: () => assembleRunPlan(input),
    catch: runPlanAssemblyError,
  }),
);
