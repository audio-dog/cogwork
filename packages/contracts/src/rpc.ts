import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { HarnessName, TrimmedNonEmptyString, WorkItemId, WorkspaceId } from "./base-schemas";
import {
  ConnectionEstablishment,
  ConnectionFailure,
  ConnectionId,
  ConnectionMutationResult,
  ConnectionOverview,
} from "./connection";
import {
  ControlStore,
  ControlStoreFailure,
  DaemonLimitUpdate,
  DaemonStatus,
  DesktopProcessHealthSample,
  SchedulerStats,
  SchedulingState,
  StaleControlStoreWrite,
} from "./daemon";
import { ClassifiedItem, DaemonEvent, WorkspaceState } from "./daemon-event";
import { HarnessNotRegistered, HarnessOverview } from "./harness";
import { IssueTrackerError } from "./issue-tracker";
import { PluginFailure, PluginId, PluginMutationResult, PluginOverview } from "./plugin";
import { PrincipalMiddleware } from "./principal";
import { RunActivity, RunEvent, RunId, RunStatus, RunSummary } from "./run";
import {
  ContributionSettingRefused,
  ContributionSettingUpdate,
  OperationSettingRefused,
  OperationSettingUpdate,
} from "./settings";
import { TriageRole } from "./triage";
import {
  WorkspaceManagementError,
  WorkspaceNotFound,
  WorkspaceRegistration,
  WorkspaceRegistrationError,
  WorkspaceUpdate,
} from "./workspace";

export const GetStatus = Rpc.make("GetStatus", { success: DaemonStatus });

export const GetMetrics = Rpc.make("GetMetrics", { success: Schema.String });

export const GetControlStore = Rpc.make("GetControlStore", {
  success: ControlStore,
  error: ControlStoreFailure,
});

export const GetPlugins = Rpc.make("GetPlugins", {
  success: PluginOverview,
  error: PluginFailure,
});

export const GetConnections = Rpc.make("GetConnections", {
  success: ConnectionOverview,
  error: ConnectionFailure,
});

export const GetHarnesses = Rpc.make("GetHarnesses", {
  success: HarnessOverview,
  error: ControlStoreFailure,
});

export const ListRuns = Rpc.make("ListRuns", { success: Schema.Array(RunSummary) });

export const GetRunEvents = Rpc.make("GetRunEvents", {
  payload: { id: RunId },
  success: Schema.Array(RunEvent),
});

export const ResolveWatchTarget = Rpc.make("ResolveWatchTarget", {
  payload: { workItem: WorkItemId },
  success: Schema.NullOr(RunId),
});

export const WatchActivity = Rpc.make("WatchActivity", {
  payload: { id: Schema.optional(RunId) },
  success: RunActivity,
  stream: true,
});

export const WatchEvents = Rpc.make("WatchEvents", {
  success: DaemonEvent,
  stream: true,
});

export const DaemonQueries = RpcGroup.make(
  GetStatus,
  GetMetrics,
  GetControlStore,
  GetPlugins,
  GetConnections,
  GetHarnesses,
  ListRuns,
  GetRunEvents,
  ResolveWatchTarget,
  WatchActivity,
  WatchEvents,
).middleware(PrincipalMiddleware);

export class RunNotFound extends Schema.TaggedError<RunNotFound>()("RunNotFound", {
  runId: RunId,
}) {}

export class RunAlreadyFinished extends Schema.TaggedError<RunAlreadyFinished>()("RunAlreadyFinished", {
  runId: RunId,
  status: RunStatus,
}) {}

export class WorkItemNotFound extends Schema.TaggedError<WorkItemNotFound>()("WorkItemNotFound", {
  workspace: WorkspaceId,
  workItem: WorkItemId,
}) {}

export const CancelRunResult = Schema.TaggedUnion({
  Cancelled: { item: ClassifiedItem },
  StillDraining: { item: ClassifiedItem },
});
export type CancelRunResult = typeof CancelRunResult.Type;

export const CancelRun = Rpc.make("CancelRun", {
  payload: { runId: RunId, note: Schema.optional(TrimmedNonEmptyString) },
  success: CancelRunResult,
  error: Schema.Union([RunNotFound, RunAlreadyFinished]),
});

export const Reclassify = Rpc.make("Reclassify", {
  payload: {
    workspace: WorkspaceId,
    workItem: WorkItemId,
    role: TriageRole,
    note: Schema.optional(TrimmedNonEmptyString),
  },
  success: Schema.NullOr(ClassifiedItem),
  error: Schema.Union([WorkItemNotFound, IssueTrackerError]),
});

export const HandBack = Rpc.make("HandBack", {
  payload: {
    workspace: WorkspaceId,
    workItem: WorkItemId,
    role: TriageRole,
    note: Schema.optional(TrimmedNonEmptyString),
  },
  success: Schema.NullOr(ClassifiedItem),
  error: Schema.Union([WorkItemNotFound, IssueTrackerError]),
});

export const SetScheduling = Rpc.make("SetScheduling", {
  payload: { desired: SchedulingState },
  success: SchedulerStats,
});

export const ReportProcessHealth = Rpc.make("ReportProcessHealth", {
  payload: { samples: Schema.Array(DesktopProcessHealthSample) },
  success: Schema.Void,
});

export const SetDaemonLimit = Rpc.make("SetDaemonLimit", {
  payload: { update: DaemonLimitUpdate },
  success: ControlStore,
  error: Schema.Union([ControlStoreFailure, StaleControlStoreWrite]),
});

export const SetOperationSetting = Rpc.make("SetOperationSetting", {
  payload: { update: OperationSettingUpdate },
  success: ControlStore,
  error: Schema.Union([ControlStoreFailure, OperationSettingRefused]),
});

export const SetHarnessEnabled = Rpc.make("SetHarnessEnabled", {
  payload: { harness: HarnessName, enabled: Schema.Boolean },
  success: ControlStore,
  error: Schema.Union([ControlStoreFailure, HarnessNotRegistered]),
});

export const SetContributionSetting = Rpc.make("SetContributionSetting", {
  payload: { update: ContributionSettingUpdate },
  success: ControlStore,
  error: Schema.Union([ControlStoreFailure, ContributionSettingRefused]),
});

export const RegisterWorkspace = Rpc.make("RegisterWorkspace", {
  payload: { registration: WorkspaceRegistration },
  success: WorkspaceState,
  error: WorkspaceRegistrationError,
});

export const UpdateWorkspace = Rpc.make("UpdateWorkspace", {
  payload: { workspace: WorkspaceId, update: WorkspaceUpdate },
  success: WorkspaceState,
  error: Schema.Union([WorkspaceNotFound, WorkspaceManagementError, WorkspaceRegistrationError]),
});

export const InstallPlugin = Rpc.make("InstallPlugin", {
  payload: { pluginId: PluginId },
  success: PluginMutationResult,
  error: PluginFailure,
});

export const UninstallPlugin = Rpc.make("UninstallPlugin", {
  payload: { pluginId: PluginId },
  success: PluginMutationResult,
  error: PluginFailure,
});

export const EstablishConnection = Rpc.make("EstablishConnection", {
  payload: { establishment: ConnectionEstablishment },
  success: ConnectionMutationResult,
  error: Schema.Union([ConnectionFailure, PluginFailure]),
});

export const ReconnectConnection = Rpc.make("ReconnectConnection", {
  payload: { establishment: ConnectionEstablishment },
  success: ConnectionMutationResult,
  error: Schema.Union([ConnectionFailure, PluginFailure]),
});

export const RemoveConnection = Rpc.make("RemoveConnection", {
  payload: { connectionId: ConnectionId },
  success: ConnectionMutationResult,
  error: Schema.Union([ConnectionFailure, PluginFailure]),
});

export const DeregisterWorkspace = Rpc.make("DeregisterWorkspace", {
  payload: { workspace: WorkspaceId },
  success: WorkspaceId,
  error: Schema.Union([WorkspaceNotFound, WorkspaceManagementError]),
});

export const RebindWorkspace = Rpc.make("RebindWorkspace", {
  payload: { workspace: WorkspaceId, checkoutPath: TrimmedNonEmptyString },
  success: WorkspaceState,
  error: Schema.Union([WorkspaceNotFound, WorkspaceManagementError]),
});

export const DaemonCommands = RpcGroup.make(
  CancelRun,
  HandBack,
  Reclassify,
  SetScheduling,
  ReportProcessHealth,
  SetDaemonLimit,
  SetContributionSetting,
  SetHarnessEnabled,
  SetOperationSetting,
  RegisterWorkspace,
  UpdateWorkspace,
  InstallPlugin,
  UninstallPlugin,
  EstablishConnection,
  ReconnectConnection,
  RemoveConnection,
  DeregisterWorkspace,
  RebindWorkspace,
).middleware(PrincipalMiddleware);

export const DaemonRpcs = DaemonQueries.merge(DaemonCommands);
