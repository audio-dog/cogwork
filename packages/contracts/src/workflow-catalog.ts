import * as Schema from "effect/Schema";

import { HarnessName, TrimmedNonEmptyString, WorkflowId, WorkspaceId } from "./base-schemas";
import { PrincipalId } from "./principal";
import { RunPlanPolicyProfile } from "./settings";
import { NeedIdentity, WorkflowCatalogKey, WorkflowDocument, WorkflowNodeId } from "./workflow";
import { WorkflowDiagnostic } from "./workflow-diagnostic";

export const WorkflowCatalogParameter = Schema.Struct({
  id: TrimmedNonEmptyString,
  required: Schema.Boolean,
  source: Schema.Literals(["fixed", "live"]),
  values: Schema.Array(Schema.String),
});
export type WorkflowCatalogParameter = typeof WorkflowCatalogParameter.Type;

export const WorkflowWorkspaceSource = Schema.Literals(["item-else-agent", "agent"]);
export type WorkflowWorkspaceSource = typeof WorkflowWorkspaceSource.Type;

export const WorkflowCatalogEntry = Schema.Struct({
  key: WorkflowCatalogKey,
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["trigger", "action", "filter"]),
  system: Schema.NullOr(TrimmedNonEmptyString),
  connection: Schema.NullOr(TrimmedNonEmptyString),
  requires: Schema.Array(NeedIdentity),
  parameters: Schema.Array(WorkflowCatalogParameter),
  itemKind: Schema.NullOr(TrimmedNonEmptyString),
  actsOn: Schema.Array(TrimmedNonEmptyString),
  requiresWorkspace: Schema.Boolean,
  workspaceSource: Schema.NullOr(WorkflowWorkspaceSource),
  permissionProfile: RunPlanPolicyProfile,
  agentInputs: Schema.Array(TrimmedNonEmptyString),
  emits: Schema.Array(WorkflowCatalogKey),
});
export type WorkflowCatalogEntry = typeof WorkflowCatalogEntry.Type;

export const WorkflowCatalogHarness = Schema.Struct({
  name: HarnessName,
  models: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      options: Schema.Array(
        Schema.Struct({
          id: TrimmedNonEmptyString,
          values: Schema.Array(Schema.Union([TrimmedNonEmptyString, Schema.Boolean])),
        }),
      ),
    }),
  ),
});
export type WorkflowCatalogHarness = typeof WorkflowCatalogHarness.Type;

export const WorkflowCatalog = Schema.Struct({
  entries: Schema.Array(WorkflowCatalogEntry),
  instructionPackages: Schema.Array(TrimmedNonEmptyString),
  harnesses: Schema.Array(WorkflowCatalogHarness),
});
export type WorkflowCatalog = typeof WorkflowCatalog.Type;

export const MachineReadiness = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: WorkspaceId, binds: Schema.Array(TrimmedNonEmptyString) })),
  connections: Schema.Array(
    Schema.Struct({
      system: TrimmedNonEmptyString,
      ready: Schema.Boolean,
      reason: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  harnesses: Schema.Array(Schema.Struct({ name: HarnessName, available: Schema.Boolean })),
  defaultHarness: Schema.NullOr(HarnessName),
  readyNeeds: Schema.Array(NeedIdentity),
});
export type MachineReadiness = typeof MachineReadiness.Type;

export const WorkflowCatalogResult = Schema.Struct({
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
});
export type WorkflowCatalogResult = typeof WorkflowCatalogResult.Type;

export const WorkflowAvailability = Schema.TaggedUnion({
  Available: {},
  ConnectionNeeded: {},
  Unavailable: { reason: TrimmedNonEmptyString },
});
export type WorkflowAvailability = typeof WorkflowAvailability.Type;

export const WorkflowTemplate = Schema.Struct({
  id: WorkflowNodeId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  document: WorkflowDocument,
});
export type WorkflowTemplate = typeof WorkflowTemplate.Type;

export const WorkflowOption = Schema.Struct({
  value: Schema.String,
  name: TrimmedNonEmptyString,
  listedIn: Schema.Array(WorkspaceId),
});
export type WorkflowOption = typeof WorkflowOption.Type;

export const WorkflowOptionList = Schema.Array(WorkflowOption);
export type WorkflowOptionList = typeof WorkflowOptionList.Type;

export const WorkflowRecord = Schema.Struct({
  id: WorkflowId,
  principal: PrincipalId,
  workingCopy: WorkflowDocument,
  workingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  publishedCopy: Schema.NullOr(WorkflowDocument),
  publishedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  enabled: Schema.Boolean,
  diagnostics: Schema.Array(WorkflowDiagnostic),
  readiness: Schema.Array(WorkflowDiagnostic),
});
export type WorkflowRecord = typeof WorkflowRecord.Type;

export const WorkflowReadFailure = Schema.Struct({
  id: Schema.String,
  message: TrimmedNonEmptyString,
});
export type WorkflowReadFailure = typeof WorkflowReadFailure.Type;

export const WorkflowList = Schema.Struct({
  workflows: Schema.Array(WorkflowRecord),
  unreadable: Schema.Array(WorkflowReadFailure),
});
export type WorkflowList = typeof WorkflowList.Type;

export const WorkflowSwitchResult = Schema.Struct({
  workflow: WorkflowRecord,
  matchingItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type WorkflowSwitchResult = typeof WorkflowSwitchResult.Type;

export class WorkflowNotFound extends Schema.TaggedError<WorkflowNotFound>()("WorkflowNotFound", {
  id: WorkflowId,
}) {}

export class WorkflowUnreadable extends Schema.TaggedError<WorkflowUnreadable>()("WorkflowUnreadable", {
  id: WorkflowId,
  message: TrimmedNonEmptyString,
}) {}

export class WorkflowEditRefused extends Schema.TaggedError<WorkflowEditRefused>()("WorkflowEditRefused", {
  diagnostics: Schema.Array(WorkflowDiagnostic),
}) {}

export class WorkflowPublishRefused extends Schema.TaggedError<WorkflowPublishRefused>()(
  "WorkflowPublishRefused",
  {
    reason: Schema.Literals(["stale-revision", "incomplete"]),
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
    diagnostics: Schema.Array(WorkflowDiagnostic),
  },
) {}

export class WorkflowSwitchRefused extends Schema.TaggedError<WorkflowSwitchRefused>()(
  "WorkflowSwitchRefused",
  { id: WorkflowId, reason: Schema.Literal("no-published-revision") },
) {}

export const WorkflowFailure = Schema.Union([
  WorkflowNotFound,
  WorkflowUnreadable,
  WorkflowEditRefused,
  WorkflowPublishRefused,
  WorkflowSwitchRefused,
]);
export type WorkflowFailure = typeof WorkflowFailure.Type;
