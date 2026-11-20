import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, WorkspaceId } from "./base-schemas";

export const SettingsProfileScope = Schema.TaggedStruct("SettingsProfile", {});
export type SettingsProfileScope = typeof SettingsProfileScope.Type;

export const RuntimeHostScope = Schema.TaggedStruct("RuntimeHost", {});
export type RuntimeHostScope = typeof RuntimeHostScope.Type;

export const WorkspaceInputScope = Schema.TaggedStruct("WorkspaceInput", {
  workspace: WorkspaceId,
});
export type WorkspaceInputScope = typeof WorkspaceInputScope.Type;

export const PrivateWorkspaceOverlayScope = Schema.TaggedStruct("PrivateWorkspaceOverlay", {
  workspace: WorkspaceId,
});
export type PrivateWorkspaceOverlayScope = typeof PrivateWorkspaceOverlayScope.Type;

export const SettingScope = Schema.Union([
  SettingsProfileScope,
  RuntimeHostScope,
  WorkspaceInputScope,
  PrivateWorkspaceOverlayScope,
]).pipe(Schema.toTaggedUnion("_tag"));
export type SettingScope = typeof SettingScope.Type;

export const OperationSettingScope = Schema.Union([
  SettingsProfileScope,
  RuntimeHostScope,
  PrivateWorkspaceOverlayScope,
]).pipe(Schema.toTaggedUnion("_tag"));
export type OperationSettingScope = typeof OperationSettingScope.Type;

export const DefaultSettingLevel = Schema.TaggedStruct("Default", {});
export type DefaultSettingLevel = typeof DefaultSettingLevel.Type;

export const OperationSettingName = Schema.Literals(["harness", "model", "model-options"]);
export type OperationSettingName = typeof OperationSettingName.Type;
export const operationSettingNames = OperationSettingName.literals;

export const RunPlanPolicyProfile = Schema.Literals(["read-only", "full"]);
export type RunPlanPolicyProfile = typeof RunPlanPolicyProfile.Type;

export const defaultPermissionProfile = (
  preferredProfile: RunPlanPolicyProfile,
  declaredProfiles: ReadonlyArray<RunPlanPolicyProfile>,
) => declaredProfiles.find((profile) => profile === preferredProfile) ?? declaredProfiles[0] ?? null;

export const ModelOptionSelections = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
);
export type ModelOptionSelections = typeof ModelOptionSelections.Type;

const principalOperationScope = Schema.Union([SettingsProfileScope, PrivateWorkspaceOverlayScope]);
const operationCellFields = { level: DefaultSettingLevel };

const harnessCell = Schema.Struct({
  ...operationCellFields,
  setting: Schema.Literal("harness"),
  scope: OperationSettingScope,
});
const modelCell = Schema.Struct({
  ...operationCellFields,
  setting: Schema.Literal("model"),
  scope: principalOperationScope,
});
const modelOptionsCell = Schema.Struct({
  ...operationCellFields,
  setting: Schema.Literal("model-options"),
  scope: principalOperationScope,
});

export const OperationSettingCell = Schema.Union([harnessCell, modelCell, modelOptionsCell]);
export type OperationSettingCell = typeof OperationSettingCell.Type;

export const OperationSettingRow = Schema.Union([
  Schema.Struct({ ...harnessCell.fields, value: TrimmedNonEmptyString }),
  Schema.Struct({ ...modelCell.fields, value: TrimmedNonEmptyString }),
  Schema.Struct({ ...modelOptionsCell.fields, value: ModelOptionSelections }),
]);
export type OperationSettingRow = typeof OperationSettingRow.Type;

export const OperationSettingUpdate = Schema.Union([
  Schema.TaggedStruct("Set", { row: OperationSettingRow }),
  Schema.TaggedStruct("Clear", { cell: OperationSettingCell }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type OperationSettingUpdate = typeof OperationSettingUpdate.Type;

export const OperationSettingBatch = Schema.NonEmptyArray(OperationSettingUpdate).check(
  Schema.isMaxLength(4),
);
export type OperationSettingBatch = typeof OperationSettingBatch.Type;

const operationSettingScopeKey = OperationSettingScope.match({
  SettingsProfile: () => "SettingsProfile",
  RuntimeHost: () => "RuntimeHost",
  PrivateWorkspaceOverlay: ({ workspace }) => JSON.stringify(["PrivateWorkspaceOverlay", workspace]),
});

const sameOperationSettingCell = (left: OperationSettingCell, right: OperationSettingCell) =>
  left.setting === right.setting &&
  operationSettingScopeKey(left.scope) === operationSettingScopeKey(right.scope);

export const applyOperationSettingBatch = (
  rows: ReadonlyArray<OperationSettingRow>,
  updates: ReadonlyArray<OperationSettingUpdate>,
) =>
  updates.reduce<ReadonlyArray<OperationSettingRow>>(
    (current, update) =>
      OperationSettingUpdate.match(update, {
        Clear: ({ cell }) => current.filter((row) => !sameOperationSettingCell(row, cell)),
        Set: ({ row }) => [
          ...current.filter((currentRow) => !sameOperationSettingCell(currentRow, row)),
          row,
        ],
      }),
    rows,
  );

export const ContributionSettingScope = Schema.Union([
  SettingsProfileScope,
  PrivateWorkspaceOverlayScope,
]).pipe(Schema.toTaggedUnion("_tag"));
export type ContributionSettingScope = typeof ContributionSettingScope.Type;

export const McpContributionRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literal("mcp-server"),
});
export type McpContributionRef = typeof McpContributionRef.Type;

export const ContributionSettingCell = Schema.Struct({
  contribution: McpContributionRef,
  scope: ContributionSettingScope,
});
export type ContributionSettingCell = typeof ContributionSettingCell.Type;

export const ContributionSettingValue = Schema.Struct({
  ...ContributionSettingCell.fields,
  enabled: Schema.Boolean,
});
export type ContributionSettingValue = typeof ContributionSettingValue.Type;

export const ContributionSettingUpdate = Schema.Union([
  Schema.TaggedStruct("Set", { row: ContributionSettingValue }),
  Schema.TaggedStruct("Clear", { cell: ContributionSettingCell }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type ContributionSettingUpdate = typeof ContributionSettingUpdate.Type;

export const ContributionSettingDiagnostic = Schema.TaggedStruct("Dangling", {
  source: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
});
export type ContributionSettingDiagnostic = typeof ContributionSettingDiagnostic.Type;

export const ContributionSettingRow = Schema.Struct({
  ...ContributionSettingValue.fields,
  diagnostic: Schema.optionalKey(ContributionSettingDiagnostic),
});
export type ContributionSettingRow = typeof ContributionSettingRow.Type;

export class ContributionSettingRefused extends Schema.TaggedError<ContributionSettingRefused>()(
  "ContributionSettingRefused",
  {
    contribution: TrimmedNonEmptyString,
    source: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  },
) {}

export class OperationSettingRefused extends Schema.TaggedError<OperationSettingRefused>()(
  "OperationSettingRefused",
  {
    setting: OperationSettingName,
    source: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  },
) {}

export const ResolutionOperator = Schema.Literals(["override-scalar", "union-values"]);
export type ResolutionOperator = typeof ResolutionOperator.Type;

export interface OperationSettingContext {
  readonly workspace: WorkspaceId | null;
}

export interface ContributionEnabledRow {
  readonly scope: SettingsProfileScope | PrivateWorkspaceOverlayScope;
  readonly enabled: boolean;
}

export interface ContributionUnionRow {
  readonly scope: SettingsProfileScope | WorkspaceInputScope | PrivateWorkspaceOverlayScope;
  readonly contributions: readonly string[];
}

export const settingScopeDirection = [
  "SettingsProfile",
  "RuntimeHost",
  "WorkspaceInput",
  "PrivateWorkspaceOverlay",
] as const satisfies readonly SettingScope["_tag"][];

const scopeRank = (scope: SettingScope) =>
  SettingScope.match(scope, {
    SettingsProfile: () => 0,
    RuntimeHost: () => 1,
    WorkspaceInput: () => 2,
    PrivateWorkspaceOverlay: () => 3,
  });

const scopeApplies = (scope: OperationSettingRow["scope"], context: OperationSettingContext) =>
  SettingScope.match(scope, {
    SettingsProfile: () => true,
    RuntimeHost: () => true,
    WorkspaceInput: () => true,
    PrivateWorkspaceOverlay: ({ workspace }) => context.workspace !== null && workspace === context.workspace,
  });

export const operationSettingRowsForContext = (
  rows: readonly OperationSettingRow[],
  context: OperationSettingContext,
) => rows.filter((row) => scopeApplies(row.scope, context));

export const resolveOperationSetting = (
  rows: readonly OperationSettingRow[],
  setting: OperationSettingName,
  context: OperationSettingContext,
) => {
  const selected = operationSettingRowsForContext(
    rows.filter((row) => row.setting === setting),
    context,
  ).toSorted((left, right) => scopeRank(left.scope) - scopeRank(right.scope));
  return selected.at(-1)?.value ?? null;
};

export const resolveContributionEnabled = (rows: readonly ContributionEnabledRow[]) =>
  rows.toSorted((left, right) => scopeRank(left.scope) - scopeRank(right.scope)).at(-1)?.enabled ?? null;

export const resolveContributionUnion = (rows: readonly ContributionUnionRow[]) => {
  const ordered = rows.toSorted((left, right) => scopeRank(left.scope) - scopeRank(right.scope));
  return [...new Set(ordered.flatMap((row) => row.contributions))];
};

export const defaultContributionEnabled = (authority: string) => authority !== "local:repo";

export const contributionSettingApplies = (scope: ContributionSettingScope, workspace: WorkspaceId | null) =>
  ContributionSettingScope.match(scope, {
    SettingsProfile: () => true,
    PrivateWorkspaceOverlay: (overlay) => overlay.workspace === workspace,
  });

export const admissibleSettingScope = (
  family: "contribution" | "operation",
  setting: OperationSettingName | "enabled",
  scope: SettingScope,
) =>
  SettingScope.match(scope, {
    SettingsProfile: () => true,
    RuntimeHost: () => family === "operation" && setting === "harness",
    WorkspaceInput: () => false,
    PrivateWorkspaceOverlay: () => true,
  });

export type SettingResolutionCase =
  | {
      readonly _tag: "Admissible";
      readonly name: string;
      readonly family: "contribution" | "operation";
      readonly setting: OperationSettingName | "enabled";
      readonly scope: SettingScope;
      readonly expected: boolean;
    }
  | {
      readonly _tag: "Direction";
      readonly name: string;
      readonly expected: readonly SettingScope["_tag"][];
    }
  | {
      readonly _tag: "ContributionDefault";
      readonly name: string;
      readonly authority: string;
      readonly expected: boolean;
    }
  | {
      readonly _tag: "ContributionEnabled";
      readonly name: string;
      readonly rows: readonly ContributionEnabledRow[];
      readonly operator: "override-scalar";
      readonly expected: boolean | null;
    }
  | {
      readonly _tag: "ContributionUnion";
      readonly name: string;
      readonly rows: readonly ContributionUnionRow[];
      readonly operator: "union-values";
      readonly expected: readonly string[];
    }
  | {
      readonly _tag: "Operation";
      readonly name: string;
      readonly rows: readonly OperationSettingRow[];
      readonly setting: OperationSettingName;
      readonly operator: ResolutionOperator;
      readonly context: OperationSettingContext;
      readonly expected: string | ModelOptionSelections | null;
    };

const profile: SettingsProfileScope = { _tag: "SettingsProfile" };
const host: RuntimeHostScope = { _tag: "RuntimeHost" };
const workspace = Schema.decodeSync(WorkspaceId)("workspace");
const workspaceInput: WorkspaceInputScope = { _tag: "WorkspaceInput", workspace };
const overlay: PrivateWorkspaceOverlayScope = {
  _tag: "PrivateWorkspaceOverlay",
  workspace,
};
const operationContext = { workflow: "workflow", operation: "operation", workspace };

export const settingResolutionCases: readonly SettingResolutionCase[] = [
  {
    _tag: "Direction",
    name: "orders every Scope from low to high",
    expected: ["SettingsProfile", "RuntimeHost", "WorkspaceInput", "PrivateWorkspaceOverlay"],
  },
  {
    _tag: "Admissible",
    name: "admits a contribution setting at Settings profile",
    family: "contribution",
    setting: "enabled",
    scope: profile,
    expected: true,
  },
  {
    _tag: "Admissible",
    name: "leaves the contribution Workspace input cell empty",
    family: "contribution",
    setting: "enabled",
    scope: workspaceInput,
    expected: false,
  },
  {
    _tag: "Admissible",
    name: "admits a contribution setting at Private workspace overlay",
    family: "contribution",
    setting: "enabled",
    scope: overlay,
    expected: true,
  },
  {
    _tag: "Admissible",
    name: "admits an Operation setting at Settings profile",
    family: "operation",
    setting: "model",
    scope: profile,
    expected: true,
  },
  {
    _tag: "Admissible",
    name: "leaves the contribution Runtime host cell empty",
    family: "contribution",
    setting: "enabled",
    scope: host,
    expected: false,
  },
  {
    _tag: "Admissible",
    name: "leaves non-Harness Operation setting Runtime host cells empty",
    family: "operation",
    setting: "model",
    scope: host,
    expected: false,
  },
  {
    _tag: "Admissible",
    name: "leaves every Operation setting Workspace input cell empty",
    family: "operation",
    setting: "model",
    scope: workspaceInput,
    expected: false,
  },
  {
    _tag: "Admissible",
    name: "admits only the Harness Operation setting at Runtime host",
    family: "operation",
    setting: "harness",
    scope: host,
    expected: true,
  },
  {
    _tag: "Admissible",
    name: "admits an Operation setting at Private workspace overlay",
    family: "operation",
    setting: "model",
    scope: overlay,
    expected: true,
  },
  {
    _tag: "ContributionDefault",
    name: "enables a Settings profile contribution by default",
    authority: "local:user",
    expected: true,
  },
  {
    _tag: "ContributionDefault",
    name: "enables a Private workspace contribution by default",
    authority: "local:private",
    expected: true,
  },
  {
    _tag: "ContributionDefault",
    name: "enables a Plugin contribution by default",
    authority: "plugin:linear",
    expected: true,
  },
  {
    _tag: "ContributionDefault",
    name: "keeps a repository offer off by default",
    authority: "local:repo",
    expected: false,
  },
  {
    _tag: "ContributionEnabled",
    name: "resolves contribution on or off in Scope direction",
    operator: "override-scalar",
    rows: [
      { scope: profile, enabled: false },
      { scope: overlay, enabled: true },
    ],
    expected: true,
  },
  {
    _tag: "ContributionUnion",
    name: "unions contribution identities without reconciling matching local names",
    operator: "union-values",
    rows: [
      { scope: profile, contributions: ["plugin:linear/mcp/linear"] },
      { scope: workspaceInput, contributions: ["local:repo/mcp/linear"] },
      { scope: overlay, contributions: ["local:private/skill/review"] },
    ],
    expected: ["plugin:linear/mcp/linear", "local:repo/mcp/linear", "local:private/skill/review"],
  },
  {
    _tag: "Operation",
    name: "resolves a default in Scope direction",
    setting: "model",
    operator: "override-scalar",
    context: operationContext,
    rows: [
      { setting: "model", level: { _tag: "Default" }, scope: profile, value: "profile-default" },
      { setting: "model", level: { _tag: "Default" }, scope: overlay, value: "overlay-default" },
    ],
    expected: "overlay-default",
  },
  {
    _tag: "Operation",
    name: "uses Runtime host for the default Harness",
    setting: "harness",
    operator: "override-scalar",
    context: operationContext,
    rows: [
      {
        setting: "harness",
        level: { _tag: "Default" },
        scope: profile,
        value: "cursor",
      },
      {
        setting: "harness",
        level: { _tag: "Default" },
        scope: host,
        value: "codex",
      },
    ],
    expected: "codex",
  },
];
