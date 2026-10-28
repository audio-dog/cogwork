import {
  Connection,
  type ConnectionOverview,
  connectionIdOf,
  defaultControlStore,
  type HarnessName,
  type HarnessOptionCatalog,
  type OperationSettingRow,
  type RunPlanPolicyProfile,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Availability from "../availability";
import { ConnectionStore } from "../connection";
import { type AssembledContext, ContextAssembler } from "../context-assembler";
import { ControlStore } from "../control-store";
import * as CredentialStore from "../credential-store";
import * as DaemonEventBus from "../daemon-event-bus";
import { layer as githubClientLayer } from "../github/client";
import { Harness } from "../harness";
import { HarnessReadinessCache } from "../harness-readiness";
import { McpSkillAssembler, type ResolvedMcpSkill } from "../mcp-skill";
import * as OperationResolution from "../operation-resolution";
import { PluginManager } from "../plugin";
import * as RunLedger from "../run-ledger";
import { layer as runRecorderLayer } from "../run-recorder";
import * as SessionStore from "../session-store";

type RunLedgerLayer = Layer.Layer<RunLedger.RunLedger>;

export interface EngineTestLayerOptions {
  readonly coreRunLedger?: Layer.Layer<RunLedger.CoreRunLedger>;
  readonly transformRunLedger?: (layer: RunLedgerLayer) => RunLedgerLayer;
}

export interface EngineOperationResolutionTestLayerOptions {
  readonly harness: HarnessName;
  readonly operationSettings: ReadonlyArray<OperationSettingRow>;
  readonly policyProfiles?: ReadonlyArray<RunPlanPolicyProfile>;
  readonly context?: AssembledContext;
  readonly mcpSkills?: ReadonlyArray<ResolvedMcpSkill>;
}

const keepRunLedger = (layer: RunLedgerLayer) => layer;

const githubConnection = Connection.make({
  id: connectionIdOf("github", "default"),
  system: "github",
  account: "default",
  status: "established",
});

export const engineTestLayer = ({
  coreRunLedger = RunLedger.layerMemoryCore,
  transformRunLedger = keepRunLedger,
}: EngineTestLayerOptions = {}) => {
  const daemonEventBus = DaemonEventBus.layer;
  const runLedger = transformRunLedger(
    RunLedger.publishingLayer.pipe(Layer.provide(coreRunLedger), Layer.provide(daemonEventBus)),
  );
  const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedger), Layer.provide(daemonEventBus));
  const sessionStore = SessionStore.layer.pipe(Layer.provide(runLedger), Layer.provide(runRecorder));
  return Layer.mergeAll(
    Layer.mock(HarnessReadinessCache, {
      readiness: () => Effect.succeed({ harnesses: [], checkedAtMillis: 0 }),
      requestAll: () => Effect.void,
      requestOne: () => Effect.void,
    }),
    daemonEventBus,
    runLedger,
    runRecorder,
    sessionStore,
    githubClientLayer.pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected GitHub request")),
        ),
      ),
    ),
    Path.layer,
  );
};

export const engineTestLayerWithOperationResolution = ({
  harness,
  operationSettings,
  policyProfiles = ["read-only", "full"],
  context = {
    layers: [],
    operatingInstructionsName: "implement-agent",
    operatingInstructionsPath: "/operations",
    operatingInstructionResources: [],
    sources: [],
  },
  mcpSkills = [],
}: EngineOperationResolutionTestLayerOptions) => {
  const engineServices = engineTestLayer();
  const picture = { ...defaultControlStore, operationSettings };
  const controlStore = Layer.mock(ControlStore, {
    health: "available",
    seed: picture,
    picture: Effect.succeed(picture),
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  });
  const contextAssembler = Layer.mock(ContextAssembler, {
    assemble: () => Effect.succeed(context),
  });
  const harnessService = Layer.mock(Harness, {
    signIn: () => null,
    catalogs: new Map<HarnessName, HarnessOptionCatalog>([
      [
        harness,
        {
          models: [],
          policyProfiles,
          provenance: { source: "managed" },
        },
      ],
    ]),
    preflight: () => Effect.void,
    sessionKind: () => "opaque-handle",
    capabilities: () => ({
      authenticationModes: ["host"],
      session: { affinity: "sandbox-lineage", fork: false, humanAttach: false },
      structuredOutput: "native",
      policyFidelity: "exact",
      fileEventFidelity: "best-effort",
      usageQuality: "metered",
      readinessDiagnostics: true,
      journal: false,
      takeover: false,
    }),
    projectedMembers: () => ["Instructions", "Messages", "MCP", "Sandbox", "Persistence"],
    planMiddleware: () => [],
  });
  const requirements = Layer.mergeAll(
    controlStore,
    contextAssembler,
    harnessService,
    Layer.mock(ConnectionStore, {
      overview: Effect.succeed({
        connections: [{ system: "github", connection: githubConnection, readiness: { _tag: "Ready" } }],
      } satisfies ConnectionOverview),
    }),
    Layer.mock(McpSkillAssembler, { assemble: () => Effect.succeed(mcpSkills) }),
    Layer.mock(PluginManager, { overview: Effect.succeed({ plugins: [] }) }),
    CredentialStore.layerEnv,
    FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
    FetchHttpClient.layer,
    Availability.Availability.layer,
    engineServices,
  );
  const operationResolution = OperationResolution.layer.pipe(Layer.provide(requirements));
  return Layer.merge(engineServices, operationResolution);
};
