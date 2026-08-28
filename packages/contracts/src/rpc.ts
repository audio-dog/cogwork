import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { TrimmedNonEmptyString, WorkItemId, WorkspaceId } from "./base-schemas";
import {
  ControlStore,
  ControlStoreFailure,
  DaemonLimitUpdate,
  DaemonStatus,
  SchedulerStats,
  SchedulingState,
  StaleControlStoreWrite,
} from "./daemon";
import { ClassifiedItem, DaemonEvent, WorkspaceState } from "./daemon-event";
import { IssueTrackerError } from "./issue-tracker";
import { PluginFailure, PluginId, PluginMutationResult, PluginOverview } from "./plugin";
import { PrincipalMiddleware } from "./principal";
import { RunActivity, RunEvent, RunId, RunStatus, RunSummary } from "./run";
import { OperationSettingRefused, OperationSettingUpdate } from "./settings";
import { TriageRole } from "./triage";
import { WorkspaceRegistration, WorkspaceRegistrationError } from "./workspace";

export const GetStatus = Rpc.make("GetStatus", { success: DaemonStatus });

export const GetControlStore = Rpc.make("GetControlStore", {
  success: ControlStore,
  error: ControlStoreFailure,
});

export const GetPlugins = Rpc.make("GetPlugins", {
  success: PluginOverview,
  error: PluginFailure,
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
  GetControlStore,
  GetPlugins,
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

export const CancelRun = Rpc.make("CancelRun", {
  payload: { runId: RunId, note: Schema.optional(TrimmedNonEmptyString) },
  success: ClassifiedItem,
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

export const SetScheduling = Rpc.make("SetScheduling", {
  payload: { desired: SchedulingState },
  success: SchedulerStats,
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

export const RegisterWorkspace = Rpc.make("RegisterWorkspace", {
  payload: { registration: WorkspaceRegistration },
  success: WorkspaceState,
  error: WorkspaceRegistrationError,
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

export const DaemonCommands = RpcGroup.make(
  CancelRun,
  Reclassify,
  SetScheduling,
  SetDaemonLimit,
  SetOperationSetting,
  RegisterWorkspace,
  InstallPlugin,
  UninstallPlugin,
).middleware(PrincipalMiddleware);

export const DaemonRpcs = DaemonQueries.merge(DaemonCommands);
