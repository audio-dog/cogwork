import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString, WorkflowId, WorkItemId, WorkspaceId } from "./base-schemas";
import {
  ConnectionBindingId,
  ConnectionEstablishment,
  ConnectionFailure,
  ConnectionId,
  ConnectionMutationResult,
  ConnectionOverview,
} from "./connection";
import { WorkItemRef } from "./coordination";
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
import { DaemonEvent, WorkspaceState } from "./daemon-event";
import { HarnessCatalog, HarnessNotRegistered, HarnessReadiness } from "./harness";
import { IssueTrackerError } from "./issue-tracker";
import { PluginFailure, PluginId, PluginMutationResult, PluginOverview } from "./plugin";
import { PrincipalMiddleware } from "./principal";
import { RunHistory, RunId, RunStatus, RunSummary, RunWatchItem } from "./run";
import {
  ContributionSettingRefused,
  ContributionSettingUpdate,
  OperationSettingBatch,
  OperationSettingRefused,
} from "./settings";
import {
  WorkflowAttention,
  WorkflowCatalogKey,
  WorkflowCatalogResult,
  WorkflowDiagnostic,
  WorkflowDocument,
  WorkflowEditBatch,
  WorkflowFailure,
  WorkflowList,
  WorkflowNotification,
  WorkflowNotificationId,
  WorkflowOptionList,
  WorkflowRecord,
  WorkflowSwitchResult,
  WorkflowTemplate,
  WorkflowTouchpointFailure,
} from "./workflow";
import {
  GitHubPriorityField,
  IssueTrackerPerson,
  WorkspaceRegistration,
  WorkspaceRegistrationError,
  WorkspaceRegistryError,
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

export const GetHarnessCatalogs = Rpc.make("GetHarnessCatalogs", {
  success: Schema.Array(HarnessCatalog),
});

export const GetHarnessReadiness = Rpc.make("GetHarnessReadiness", {
  success: HarnessReadiness,
  error: ControlStoreFailure,
});

export const GetGitHubPriorityFields = Rpc.make("GetGitHubPriorityFields", {
  payload: { workspace: WorkspaceId, connection: ConnectionBindingId },
  success: Schema.Array(GitHubPriorityField),
  error: Schema.Union([WorkspaceRegistryError, IssueTrackerError]),
});

export const GetIssueTrackerPeople = Rpc.make("GetIssueTrackerPeople", {
  payload: { workspace: WorkspaceId, connection: ConnectionBindingId },
  success: Schema.Array(IssueTrackerPerson),
  error: Schema.Union([WorkspaceRegistryError, IssueTrackerError]),
});

export const ListRuns = Rpc.make("ListRuns", { success: Schema.Array(RunSummary) });

export const GetRunEvents = Rpc.make("GetRunEvents", {
  payload: { id: RunId },
  success: RunHistory,
});

export const ResolveWatchTarget = Rpc.make("ResolveWatchTarget", {
  payload: { workItem: WorkItemId },
  success: Schema.NullOr(RunId),
});

export const WatchActivity = Rpc.make("WatchActivity", {
  payload: { id: Schema.optional(RunId) },
  success: RunWatchItem,
  stream: true,
});

export const WatchEvents = Rpc.make("WatchEvents", {
  success: DaemonEvent,
  stream: true,
});

export const ListWorkflows = Rpc.make("ListWorkflows", {
  success: WorkflowList,
  error: ControlStoreFailure,
});

export const ListWorkflowNotifications = Rpc.make("ListWorkflowNotifications", {
  success: Schema.Array(WorkflowNotification),
});

export const ListWorkflowAttention = Rpc.make("ListWorkflowAttention", {
  success: WorkflowAttention,
  error: WorkflowTouchpointFailure,
});

export const GetWorkflow = Rpc.make("GetWorkflow", {
  payload: { id: WorkflowId },
  success: WorkflowRecord,
  error: Schema.Union([ControlStoreFailure, WorkflowFailure]),
});

export const ValidateWorkflow = Rpc.make("ValidateWorkflow", {
  payload: { document: Schema.Unknown },
  success: Schema.Array(WorkflowDiagnostic),
});

export const GetWorkflowCatalog = Rpc.make("GetWorkflowCatalog", {
  success: WorkflowCatalogResult,
});

export const GetWorkflowTemplates = Rpc.make("GetWorkflowTemplates", {
  success: Schema.Array(WorkflowTemplate),
});

export const ListWorkflowOptions = Rpc.make("ListWorkflowOptions", {
  payload: {
    entry: WorkflowCatalogKey,
    parameter: TrimmedNonEmptyString,
    workspaces: Schema.Array(WorkspaceId),
  },
  success: WorkflowOptionList,
});

export const DaemonQueries = RpcGroup.make(
  GetStatus,
  GetMetrics,
  GetControlStore,
  GetPlugins,
  GetConnections,
  GetHarnessCatalogs,
  GetHarnessReadiness,
  GetGitHubPriorityFields,
  GetIssueTrackerPeople,
  ListRuns,
  GetRunEvents,
  ResolveWatchTarget,
  WatchActivity,
  WatchEvents,
  ListWorkflows,
  ListWorkflowNotifications,
  ListWorkflowAttention,
  GetWorkflow,
  ValidateWorkflow,
  GetWorkflowCatalog,
  GetWorkflowTemplates,
  ListWorkflowOptions,
).middleware(PrincipalMiddleware);

export class CancelRunError extends Schema.TaggedError<CancelRunError>()("CancelRunError", {
  reason: Schema.Literals(["not-found", "already-finished"]),
  runId: RunId,
  status: Schema.optional(RunStatus),
}) {}

export class WorkItemNotFound extends Schema.TaggedError<WorkItemNotFound>()("WorkItemNotFound", {
  workspace: WorkspaceId,
  workItem: WorkItemId,
}) {}

export const CancelRun = Rpc.make("CancelRun", {
  payload: { runId: RunId, note: Schema.optional(TrimmedNonEmptyString) },
  success: Schema.Void,
  error: CancelRunError,
});

export const HandBack = Rpc.make("HandBack", {
  payload: {
    item: WorkItemRef,
    note: Schema.optional(TrimmedNonEmptyString),
  },
  success: Schema.Void,
  error: WorkflowTouchpointFailure,
});

export const ApproveWorkflowPlan = Rpc.make("ApproveWorkflowPlan", {
  payload: {
    item: WorkItemRef,
    attempt: RunId,
    digest: TrimmedNonEmptyString,
    edits: Schema.optional(Schema.Record(Schema.String, TrimmedNonEmptyString)),
  },
  success: TrimmedNonEmptyString,
  error: WorkflowTouchpointFailure,
});

export const RejectWorkflowPlan = Rpc.make("RejectWorkflowPlan", {
  payload: {
    item: WorkItemRef,
    attempt: RunId,
    note: Schema.optional(TrimmedNonEmptyString),
  },
  success: Schema.Void,
  error: WorkflowTouchpointFailure,
});

export const ChooseWorkflowAnswer = Rpc.make("ChooseWorkflowAnswer", {
  payload: {
    item: WorkItemRef,
    attempt: RunId,
    answers: Schema.Record(Schema.String, TrimmedNonEmptyString),
    inputs: Schema.Record(Schema.String, TrimmedNonEmptyString),
  },
  success: Schema.Void,
  error: WorkflowTouchpointFailure,
});

export const DismissWorkflowNotification = Rpc.make("DismissWorkflowNotification", {
  payload: { id: WorkflowNotificationId },
  success: Schema.Void,
});

export const SetScheduling = Rpc.make("SetScheduling", {
  payload: { desired: SchedulingState },
  success: SchedulerStats,
});

export const ReportProcessHealth = Rpc.make("ReportProcessHealth", {
  payload: { samples: Schema.Array(DesktopProcessHealthSample) },
  success: Schema.Void,
});

export const CheckHarnesses = Rpc.make("CheckHarnesses", { success: Schema.Void });

export const SetDaemonLimit = Rpc.make("SetDaemonLimit", {
  payload: { update: DaemonLimitUpdate },
  success: ControlStore,
  error: Schema.Union([ControlStoreFailure, StaleControlStoreWrite]),
});

export const SetOperationSetting = Rpc.make("SetOperationSetting", {
  payload: { updates: OperationSettingBatch },
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
  error: Schema.Union([WorkspaceRegistryError, WorkspaceRegistrationError]),
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

export const LoginGranola = Rpc.make("LoginGranola", {
  payload: { account: TrimmedNonEmptyString },
  success: ConnectionMutationResult,
  error: Schema.Union([ConnectionFailure, PluginFailure]),
});

export const LoginSlack = Rpc.make("LoginSlack", {
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
  error: WorkspaceRegistryError,
});

export const RebindWorkspace = Rpc.make("RebindWorkspace", {
  payload: { workspace: WorkspaceId, checkoutPath: TrimmedNonEmptyString },
  success: WorkspaceState,
  error: WorkspaceRegistryError,
});

export const CreateWorkflow = Rpc.make("CreateWorkflow", {
  payload: { document: WorkflowDocument },
  success: WorkflowRecord,
  error: Schema.Union([ControlStoreFailure, WorkflowFailure]),
}).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

export const EditWorkflow = Rpc.make("EditWorkflow", {
  payload: { id: WorkflowId, edits: WorkflowEditBatch },
  success: WorkflowRecord,
  error: Schema.Union([ControlStoreFailure, WorkflowFailure]),
}).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

export const PublishWorkflow = Rpc.make("PublishWorkflow", {
  payload: { id: WorkflowId, revision: Schema.Int },
  success: WorkflowRecord,
  error: Schema.Union([ControlStoreFailure, WorkflowFailure]),
});

export const SwitchWorkflow = Rpc.make("SwitchWorkflow", {
  payload: { id: WorkflowId, enabled: Schema.Boolean },
  success: WorkflowSwitchResult,
  error: Schema.Union([ControlStoreFailure, WorkflowFailure]),
});

export const DeleteWorkflow = Rpc.make("DeleteWorkflow", {
  payload: { id: WorkflowId },
  success: WorkflowId,
  error: Schema.Union([ControlStoreFailure, WorkflowFailure]),
});

export const DaemonCommands = RpcGroup.make(
  CancelRun,
  ApproveWorkflowPlan,
  RejectWorkflowPlan,
  ChooseWorkflowAnswer,
  DismissWorkflowNotification,
  HandBack,
  SetScheduling,
  ReportProcessHealth,
  CheckHarnesses,
  SetDaemonLimit,
  SetContributionSetting,
  SetHarnessEnabled,
  SetOperationSetting,
  RegisterWorkspace,
  UpdateWorkspace,
  InstallPlugin,
  UninstallPlugin,
  EstablishConnection,
  LoginGranola,
  LoginSlack,
  ReconnectConnection,
  RemoveConnection,
  DeregisterWorkspace,
  RebindWorkspace,
  CreateWorkflow,
  EditWorkflow,
  PublishWorkflow,
  SwitchWorkflow,
  DeleteWorkflow,
).middleware(PrincipalMiddleware);

export const DaemonRpcs = DaemonQueries.merge(DaemonCommands);
