import { fileURLToPath } from "node:url";
import { defaultControlStore, type WorkspaceId } from "@cogwork/contracts";

import type * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import type * as Digest from "effect/crypto/Digest";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as RpcSerialization from "effect/rpc/RpcSerialization";
import type * as RpcServer from "effect/rpc/RpcServer";
import type { SqlError } from "effect/sql/SqlError";
import { makeClockSource } from "./clock-source";
import { ConnectionStore, layer as connectionStoreLayer } from "./connection";
import { layer as connectionVerifierLayer } from "./connection-verify";
import type { ContextAssembler } from "./context-assembler";
import { bootControlStoreLayer, ControlStore } from "./control-store";
import { Coordination } from "./coordination";
import { makeControlStoreCoordination } from "./coordination-control-store";
import type { CredentialStore } from "./credential-store";
import { layer as daemonEventBusLayer } from "./daemon-event-bus";
import { daemonInfoLayer } from "./daemon-handlers";
import { layer as eventPublisherLayer } from "./event-publisher";
import type { Git } from "./git";
import * as GitHub from "./github";
import { makeGranolaSource, makeGranolaSourceAdapters } from "./granola-source";
import * as Harness from "./harness";
import { layer as harnessReadinessLayer } from "./harness-readiness";
import { IssueTracker } from "./issue-tracker";
import { routedLayer as issueTrackerRoutedLayer } from "./issue-tracker-router";
import * as Linear from "./linear";
import * as McpSkill from "./mcp-skill";
import { withParkNotices } from "./park-notice";
import type { PerformanceHealthSource } from "./performance-health-source";
import { layer as performanceRegressionSensorLayer } from "./performance-regression-sensor";
import { pluginManagerLayer } from "./plugin";
import { layer as workspaceRegistryLayer } from "./registry";
import { WorkspaceRegistry } from "./registry-service";
import { layer as runControlLayer } from "./run-control";
import {
  type CoreRunLedger,
  layerMemoryCore as memoryRunLedgerLayer,
  type RunLedger,
  publishingLayer as runLedgerPublishingLayer,
} from "./run-ledger";
import { layer as runRecorderLayer } from "./run-recorder";
import { configFromControlStore, layer as schedulerLayer } from "./scheduler";
import * as SessionStore from "./session-store";
import { make as makeSlackSource, httpClientLayer as slackClientLayer } from "./slack-source";
import { layer as slackWriteLayer } from "./slack-write";
import { SourceControlProvider } from "./source-control";
import { makeTrackerTriggerSource } from "./tracker-trigger-source";
import { layer as triggerObservationLayer } from "./trigger-observation";
import {
  controlStoreTriggerObservationStoreLayer,
  type TriggerObservationStore,
} from "./trigger-observation-store";
import { combineTriggerSources, TriggerSources } from "./trigger-source";
import { layer as workflowsLayer } from "./workflow";
import { controlStoreLayer as workflowActionPlanStoreLayer } from "./workflow-action-plan-store";
import {
  WorkflowArtifactStore,
  controlStoreLayer as workflowArtifactStoreLayer,
} from "./workflow-artifact-store";
import { layer as workflowAttentionLayer } from "./workflow-attention";
import { workflowCatalogContributionsLayer } from "./workflow-catalog";
import { layer as machineReadinessLayer } from "./workflow-machine-readiness";
import { layer as workflowNotificationsLayer } from "./workflow-notification";
import { layer as workflowRunLayer } from "./workflow-run";
import type { WorktreeManager } from "./worktree";

export interface HostAdapters<E = never, R = never> {
  readonly transport: Layer.Layer<RpcServer.Protocol, E, RpcSerialization.RpcSerialization | R>;
  readonly credentials: Layer.Layer<CredentialStore, E, HttpClient.HttpClient | R>;
  readonly granolaLogin?: Layer.Layer<never, E, R | SecureRandom.SecureRandom>;
  readonly slackLogin?: Layer.Layer<
    never,
    E,
    R | SecureRandom.SecureRandom | Digest.Digest | HttpClient.HttpClient
  >;
  readonly contextAssembler: Layer.Layer<ContextAssembler, E, R>;
  readonly runLedger: Layer.Layer<CoreRunLedger, E, SqliteClient.SqliteClient | R>;
  readonly controlStorePath: string;
  readonly userAgentsDir: string;
  readonly pluginCatalogPath?: string;
  readonly pluginProvisionRoot?: string;
  readonly worktrees: Layer.Layer<WorktreeManager, E, R>;
  readonly harnessRunners: ReadonlyArray<Harness.HarnessRunner>;
  readonly appVersion: string;
  readonly performanceEvidenceRoot: string;
  readonly performanceHealth: Layer.Layer<PerformanceHealthSource, E, R>;
  readonly performanceIssueWorkspace?: WorkspaceId;
  readonly triggerObservationStore?: Layer.Layer<TriggerObservationStore, E, R>;
}

const providerTriggerSourcesLayer = <E, R>(
  dependencies: Layer.Layer<
    IssueTracker | SourceControlProvider | WorkspaceRegistry | WorkflowArtifactStore,
    E,
    R
  >,
) =>
  Layer.effect(
    TriggerSources,
    Effect.all([IssueTracker, SourceControlProvider, WorkspaceRegistry, WorkflowArtifactStore]).pipe(
      Effect.map(([tracker, provider, registry, artifacts]) => {
        const sources = [
          makeTrackerTriggerSource("github", tracker, registry.state, artifacts),
          makeTrackerTriggerSource("linear", tracker, registry.state, artifacts),
          ...(provider.triggerSources ?? []),
        ];
        return combineTriggerSources([...sources, makeClockSource(sources)]);
      }),
    ),
  ).pipe(Layer.provide(dependencies));

export function engineLayer<E, R>(adapters: HostAdapters<E, R>) {
  // The credential store is stateful — its refresh gate and its minted-token cache only coordinate
  // within one instance — so the issue-tracker reads and the MCP-skill bearer must draw from the same
  // one, or they would mint and rotate the app-actor token independently.
  const credentials = adapters.credentials;
  const controlStore = bootControlStoreLayer(adapters.controlStorePath);
  const workflowArtifacts = workflowArtifactStoreLayer.pipe(Layer.provide(controlStore));
  // One GitHub client, built once: the issue tracker and the establish-time credential check must
  // share it, or the second instance resolves its own credentials and drifts from the first.
  const githubClient = GitHub.clientLayer.pipe(Layer.provide(credentials));
  const linearClient = Linear.clientLayer.pipe(Layer.provide(credentials));
  const issueTrackerAdapters = Layer.mergeAll(issueTrackerRoutedLayer, GitHub.providerLayer).pipe(
    Layer.provide(githubClient),
    Layer.provide(linearClient),
    Layer.provide(credentials),
  );
  const connections = connectionStoreLayer.pipe(
    Layer.provide(controlStore),
    Layer.provide(credentials),
    Layer.provide(connectionVerifierLayer.pipe(Layer.provide(githubClient))),
  );
  const plugins = pluginManagerLayer({
    catalogPath:
      adapters.pluginCatalogPath ?? fileURLToPath(new URL("../plugins/catalog.json", import.meta.url)),
    provisionRoot: adapters.pluginProvisionRoot ?? `${adapters.controlStorePath}.plugins`,
  }).pipe(Layer.provide(controlStore), Layer.provide(connections));
  const registry = workspaceRegistryLayer(adapters.controlStorePath, adapters.userAgentsDir).pipe(
    Layer.provideMerge(controlStore),
  );
  const issueTracker = issueTrackerAdapters.pipe(Layer.provide(registry));
  const providerTriggerSources = providerTriggerSourcesLayer(
    Layer.mergeAll(issueTracker, registry, workflowArtifacts),
  );
  const performanceIssueFiler = GitHub.performanceIssueFilerLayer(adapters.performanceIssueWorkspace).pipe(
    Layer.provide(githubClient),
    Layer.provide(registry),
  );
  const runLedger: Layer.Layer<
    RunLedger,
    E | PlatformError | SqlError,
    R | FileSystem.FileSystem | Path.Path
  > = runLedgerPublishingLayer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(ControlStore, (store) =>
          store.health === "available" ? adapters.runLedger : memoryRunLedgerLayer,
        ),
      ).pipe(Layer.provide(controlStore)),
    ),
    Layer.provide(daemonEventBusLayer),
  );
  const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedger), Layer.provide(daemonEventBusLayer));
  const sessionStore = SessionStore.layer.pipe(Layer.provide(runLedger), Layer.provide(runRecorder));
  const runnerRequirements = Layer.mergeAll(
    Layer.effect(FileSystem.FileSystem, FileSystem.FileSystem),
    Layer.effect(Path.Path, Path.Path),
    Layer.effect(HttpClient.HttpClient, HttpClient.HttpClient),
  );
  const harness = Harness.layer(adapters.harnessRunners);
  const harnessRuntime = Layer.mergeAll(
    controlStore,
    credentials,
    runnerRequirements,
    sessionStore,
    adapters.contextAssembler,
    harness,
    daemonEventBusLayer,
  );
  const harnessReadiness = harnessReadinessLayer.pipe(Layer.provideMerge(harnessRuntime));
  const machineReadiness = machineReadinessLayer.pipe(
    Layer.provide(Layer.mergeAll(controlStore, registry, connections, harnessReadiness, plugins)),
  );
  const coordination = Layer.effect(Coordination, withParkNotices(makeControlStoreCoordination)).pipe(
    Layer.provide(Layer.mergeAll(controlStore, issueTracker, registry)),
  );
  const workflowActionPlans = workflowActionPlanStoreLayer.pipe(Layer.provide(controlStore));
  const triggerSources: Layer.Layer<
    TriggerSources,
    E | PlatformError | SqlError,
    R | SecureRandom.SecureRandom | FileSystem.FileSystem | Git | HttpClient.HttpClient | Path.Path
  > = Layer.effect(
    TriggerSources,
    Effect.gen(function* () {
      const sources = yield* TriggerSources;
      const connectionStore = yield* ConnectionStore;
      const coordinationService = yield* Coordination;
      const http = yield* HttpClient.HttpClient;
      const slackSource = yield* makeSlackSource;
      return combineTriggerSources([
        ...sources,
        makeGranolaSource(connectionStore, makeGranolaSourceAdapters(http), coordinationService),
        slackSource,
      ]);
    }),
  ).pipe(Layer.provide(Layer.mergeAll(providerTriggerSources, connections, coordination, slackClientLayer)));
  const workflows = workflowsLayer.pipe(
    Layer.provide(
      workflowCatalogContributionsLayer.pipe(Layer.provide(Layer.merge(triggerSources, issueTracker))),
    ),
    Layer.provide(machineReadiness),
    Layer.provide(Layer.mergeAll(controlStore, daemonEventBusLayer, harness)),
  );
  const triggerObservationStore =
    adapters.triggerObservationStore ??
    controlStoreTriggerObservationStoreLayer.pipe(Layer.provide(controlStore));
  const workflowNotifications = workflowNotificationsLayer.pipe(
    Layer.provide(Layer.merge(runLedger, runRecorder)),
  );
  const slackWrite = slackWriteLayer.pipe(Layer.provide(slackClientLayer), Layer.provide(connections));
  const triggerObservation = triggerObservationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workflows,
        coordination,
        triggerSources,
        triggerObservationStore,
        daemonEventBusLayer,
        issueTracker,
        registry,
      ),
    ),
  );
  const workflowRun = workflowRunLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workflows,
        coordination,
        harnessRuntime,
        issueTracker,
        registry,
        plugins,
        runLedger,
        runRecorder,
        workflowActionPlans,
        workflowArtifacts,
        workflowNotifications,
        slackWrite,
        triggerObservationStore,
        triggerObservation,
        adapters.worktrees,
      ),
    ),
  );
  const workflowAttention = workflowAttentionLayer.pipe(
    Layer.provide(
      Layer.mergeAll(workflows, coordination, triggerObservationStore, workflowActionPlans, runLedger),
    ),
  );
  const base = Layer.mergeAll(
    registry,
    plugins,
    connections,
    githubClient,
    linearClient,
    ...(adapters.granolaLogin ? [adapters.granolaLogin] : []),
    ...(adapters.slackLogin ? [adapters.slackLogin] : []),
    daemonInfoLayer,
    issueTracker,
    adapters.performanceHealth,
    performanceIssueFiler,
    runLedger,
    runRecorder,
    harnessReadiness,
    workflows,
    coordination,
    triggerSources,
    triggerObservation,
    workflowNotifications,
    workflowActionPlans,
    workflowArtifacts,
    workflowRun,
    workflowAttention,
    McpSkill.layer.pipe(Layer.provide(credentials)),
    runControlLayer,
    adapters.worktrees,
  );
  return eventPublisherLayer.pipe(
    Layer.provideMerge(
      performanceRegressionSensorLayer({
        appVersion: adapters.appVersion,
        evidenceRoot: adapters.performanceEvidenceRoot,
      }).pipe(
        Layer.provideMerge(
          Layer.unwrap(
            Effect.map(ControlStore, (store) =>
              schedulerLayer(
                configFromControlStore(store.health === "available" ? store.seed : defaultControlStore),
              ),
            ),
          ).pipe(Layer.provideMerge(base)),
        ),
      ),
    ),
  );
}
