import { DaemonRpcs, HarnessCatalog } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";

import {
  cancelRun,
  deregisterWorkspace,
  getGitHubPriorityFields,
  getIssueTrackerPeople,
  handBack,
  installPlugin,
  rebindWorkspace,
  registerWorkspace,
  setContributionSetting,
  setDaemonLimit,
  setHarnessEnabled,
  setOperationSetting,
  setScheduling,
  uninstallPlugin,
  updateWorkspace,
} from "./commands";
import {
  establishConnection,
  loginGranola,
  loginSlack,
  reconnectConnection,
  removeConnection,
} from "./commands-connections";
import { ConnectionStore } from "./connection";
import { ControlStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import { watchActivity, watchEvents } from "./daemon-watch";
import { controlStoreWithDiagnostics, DaemonEventPublisher } from "./event-publisher";
import * as Harness from "./harness";
import { HarnessReadinessCache } from "./harness-readiness";
import { recordProcessHealth } from "./performance-metrics";
import { PluginManager } from "./plugin";
import { schedulerStatsOf, workspaceInfoOf } from "./read-model";
import { WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { Scheduler } from "./scheduler";
import { TriggerObservation } from "./trigger-observation";
import { Workflows } from "./workflow";
import { WorkflowAttention } from "./workflow-attention";
import { WorkflowNotifications } from "./workflow-notification";
import { WorkflowRun } from "./workflow-run";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "@cogwork/engine/daemon-handlers/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

export const handlersLayer = DaemonRpcs.toLayer({
  GetStatus: Effect.fn("Daemon.GetStatus")(function* () {
    const info = yield* DaemonInfo;
    const scheduler = yield* Scheduler;
    const config = yield* scheduler.config;
    const stats = yield* scheduler.stats;
    const now = yield* Clock.currentTimeMillis;
    const bus = yield* DaemonEventBus;
    const controlStore = yield* ControlStore;
    const triggerObservation = yield* TriggerObservation;
    const registry = yield* (yield* WorkspaceRegistry).state;
    const readyToMerge = yield* (yield* DaemonEventPublisher).readyToMerge;
    return {
      health: controlStore.health === "available" ? "running" : "store-unavailable",
      startedAtMillis: info.startedAtMillis,
      uptimeMillis: now - info.startedAtMillis,
      eventBusDroppedEvents: yield* bus.droppedEvents,
      scheduler: schedulerStatsOf(registry, config, stats),
      sources: yield* triggerObservation.health,
      workspaces: registry.workspaces.map((workspace) =>
        workspaceInfoOf(workspace, readyToMerge.get(workspace.config.id)),
      ),
      failures: registry.failures.map(({ id, displayName, source, message }) => ({
        ...(id === undefined ? {} : { id }),
        ...(displayName === undefined ? {} : { displayName }),
        source,
        message,
      })),
    };
  }),
  GetMetrics: Effect.fn("Daemon.GetMetrics")(function* () {
    return yield* Metric.dump;
  }),
  GetControlStore: Effect.fn("Daemon.GetControlStore")(function* () {
    const store = yield* ControlStore;
    const picture = yield* store.picture;
    const registry = yield* (yield* WorkspaceRegistry).state;
    return controlStoreWithDiagnostics(picture, registry);
  }),
  GetPlugins: Effect.fn("Daemon.GetPlugins")(function* () {
    return yield* (yield* PluginManager).overview;
  }),
  GetConnections: Effect.fn("Daemon.GetConnections")(function* () {
    return yield* (yield* ConnectionStore).overview;
  }),
  GetHarnessCatalogs: Effect.fn("Daemon.GetHarnessCatalogs")(function* () {
    const harnesses = yield* Harness.Harness;
    return [...harnesses.catalogs].map(([harness, catalog]) => HarnessCatalog.make({ harness, catalog }));
  }),
  GetHarnessReadiness: Effect.fn("Daemon.GetHarnessReadiness")(function* () {
    const store = yield* ControlStore;
    const picture = yield* store.picture;
    return yield* (yield* HarnessReadinessCache).readiness(picture.harnessSettings);
  }),
  GetGitHubPriorityFields: getGitHubPriorityFields,
  GetIssueTrackerPeople: getIssueTrackerPeople,
  ListRuns: Effect.fn("Daemon.ListRuns")(function* () {
    const ledger = yield* RunLedger;
    return yield* ledger.listRuns(50);
  }),
  GetRunEvents: Effect.fn("Daemon.GetRunEvents")(function* (payload) {
    const ledger = yield* RunLedger;
    return yield* ledger.history(payload.id).pipe(Effect.orDie);
  }),
  ResolveWatchTarget: Effect.fn("Daemon.ResolveWatchTarget")(function* (payload) {
    const ledger = yield* RunLedger;
    const run = yield* ledger.resolveWatchTarget(payload.workItem);
    return run?.id ?? null;
  }),
  WatchActivity: (payload) => Stream.unwrap(watchActivity(payload.id)).pipe(Stream.orDie),
  WatchEvents: () => Stream.unwrap(watchEvents()),
  ListWorkflows: () => Effect.flatMap(Workflows, ({ list }) => list),
  ListWorkflowNotifications: () =>
    Effect.flatMap(WorkflowNotifications, ({ list }) => list).pipe(Effect.orDie),
  ListWorkflowAttention: () => Effect.flatMap(WorkflowAttention, ({ list }) => list),
  GetWorkflow: (payload) => Effect.flatMap(Workflows, ({ get }) => get(payload)),
  ValidateWorkflow: (payload) => Effect.flatMap(Workflows, ({ validate }) => validate(payload)),
  GetWorkflowCatalog: () => Effect.flatMap(Workflows, ({ catalog }) => catalog),
  GetWorkflowTemplates: () => Effect.flatMap(Workflows, ({ templates }) => templates),
  ListWorkflowOptions: (payload) => Effect.flatMap(Workflows, ({ listOptions }) => listOptions(payload)),
  CancelRun: cancelRun,
  ApproveWorkflowPlan: (payload) => Effect.flatMap(WorkflowRun, ({ approve }) => approve(payload)),
  RejectWorkflowPlan: (payload) => Effect.flatMap(WorkflowRun, ({ reject }) => reject(payload)),
  ChooseWorkflowAnswer: (payload) => Effect.flatMap(WorkflowRun, ({ chooseAnswer }) => chooseAnswer(payload)),
  DismissWorkflowNotification: (payload) =>
    Effect.flatMap(WorkflowNotifications, ({ dismiss }) => dismiss(payload.id)).pipe(Effect.orDie),
  HandBack: handBack,
  SetScheduling: setScheduling,
  ReportProcessHealth: Effect.fn("Daemon.ReportProcessHealth")(function* ({ samples }) {
    yield* Effect.forEach(samples, recordProcessHealth, { discard: true });
  }),
  CheckHarnesses: Effect.fn("Daemon.CheckHarnesses")(function* () {
    yield* (yield* HarnessReadinessCache).requestAll();
  }),
  SetDaemonLimit: setDaemonLimit,
  SetContributionSetting: setContributionSetting,
  SetHarnessEnabled: setHarnessEnabled,
  SetOperationSetting: setOperationSetting,
  RegisterWorkspace: registerWorkspace,
  UpdateWorkspace: updateWorkspace,
  InstallPlugin: installPlugin,
  UninstallPlugin: uninstallPlugin,
  EstablishConnection: establishConnection,
  LoginGranola: loginGranola,
  LoginSlack: loginSlack,
  ReconnectConnection: reconnectConnection,
  RemoveConnection: removeConnection,
  DeregisterWorkspace: deregisterWorkspace,
  RebindWorkspace: rebindWorkspace,
  CreateWorkflow: (payload) => Effect.flatMap(Workflows, ({ create }) => create(payload)),
  EditWorkflow: (payload) => Effect.flatMap(Workflows, ({ edit }) => edit(payload)),
  PublishWorkflow: (payload) => Effect.flatMap(Workflows, ({ publish }) => publish(payload)),
  SwitchWorkflow: (payload) =>
    Effect.flatMap(Workflows, ({ switch: switchWorkflow }) => switchWorkflow(payload)),
  DeleteWorkflow: (payload) =>
    Effect.flatMap(Workflows, ({ delete: deleteWorkflow }) => deleteWorkflow(payload)),
});
