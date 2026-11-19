import {
  AttemptRecord,
  Claim,
  HandbackRecord,
  localOwnerId,
  type ParkReason,
  ParkRecord,
  type PluginContribution,
  Principal,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ContextAssembler } from "./context-assembler";
import { Coordination, type CoordinationService, fold } from "./coordination";
import * as CredentialStore from "./credential-store";
import { fullHarnessExecution, Harness, type HarnessRunner, make as makeHarness } from "./harness";
import {
  emptyLayer as emptyIssueTrackerLayer,
  IssueTracker,
  type IssueTrackerService,
} from "./issue-tracker";
import { PluginManager } from "./plugin";
import { emptyRegistry, type RegistryState } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { SlackWrite } from "./slack-write";
import {
  emptyService as emptySourceControl,
  SourceControlProvider,
  type SourceControlProviderService,
} from "./source-control";
import { engineTestLayer } from "./testing/engine-test-layer";
import { LogProbe } from "./testing/log-probe";
import { TriggerObservation } from "./trigger-observation";
import {
  makeMemoryTriggerObservationStore,
  TriggerObservationStore,
  type TriggerObservationStoreService,
} from "./trigger-observation-store";
import { Recheck } from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";
import {
  WorkflowActionPlanStore,
  type WorkflowActionPlanStoreService,
  memoryLayer as workflowActionPlanStoreLayer,
} from "./workflow-action-plan-store";
import { memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";
import { make as makeNotifications, WorkflowNotifications } from "./workflow-notification";
import { make as makeWorkflowRun } from "./workflow-run";
import { harnessName, workflowService } from "./workflow-run-documents-fixtures";

const makeCoordination = () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make<ReadonlyArray<AttemptRecord>>([]);
    const parks = yield* Ref.make<ReadonlyArray<ParkRecord>>([]);
    const handbacks = yield* Ref.make<ReadonlyArray<HandbackRecord>>([]);
    const processed = yield* Ref.make<string | null>(null);
    const observed = yield* Ref.make("1000");
    const claims = yield* Ref.make(0);
    const activeClaim = yield* Ref.make<Claim | null>(null);
    const read = (_ref?: unknown) =>
      Effect.all([
        Ref.get(attempts),
        Ref.get(parks),
        Ref.get(processed),
        Ref.get(handbacks),
        Ref.get(observed),
        Ref.get(activeClaim),
      ]).pipe(
        Effect.map(
          ([
            currentAttempts,
            currentParks,
            currentProcessed,
            currentHandbacks,
            currentObserved,
            currentClaim,
          ]) =>
            fold(
              {
                claim: currentClaim,
                attempts: currentAttempts,
                handbacks: currentHandbacks,
                parks: currentParks,
                revision: { observed: currentObserved, processed: currentProcessed },
              },
              "cogwork",
            ),
        ),
      );
    return {
      service: {
        fold,
        read,
        claim: (_ref, input) =>
          Ref.update(claims, (current) => current + 1).pipe(
            Effect.andThen(Effect.sync(() => Claim.make({ ...input, by: "cogwork", claimedAtMillis: 1 }))),
            Effect.tap((claim) => Ref.set(activeClaim, claim)),
          ),
        release: () => Ref.set(activeClaim, null),
        recordAttempt: (_ref, input) =>
          Ref.update(attempts, (current) => [
            ...current,
            AttemptRecord.make({ ...input, atMillis: current.length + 1 }),
          ]).pipe(Effect.andThen(read())),
        park: (_ref, reason: ParkReason, operation) =>
          Ref.update(parks, (current) => [
            ...current,
            ParkRecord.make({
              reason,
              ...(operation ? { operation } : {}),
              atMillis: current.length + 1,
            }),
          ]).pipe(Effect.andThen(read())),
        handBack: (_ref, input = { by: "Taylor" }) =>
          Ref.update(handbacks, (current) => [
            ...current,
            HandbackRecord.make({ by: input.by, atMillis: 2_000, note: input.note ?? null }),
          ]).pipe(Effect.andThen(read())),
        observe: () => Effect.succeed("moved"),
        markProcessed: (_ref, revision) => Ref.set(processed, revision),
      } satisfies CoordinationService,
      attempts,
      parks,
      processed,
      observed,
      claims,
      handbacks,
    };
  });

export const resultEvent = (object: unknown) => ({
  type: "CUSTOM" as const,
  name: "structured-output.complete" as const,
  value: { object, raw: JSON.stringify(object) },
});

export const requirements = Layer.mergeAll(
  engineTestLayer(),
  Layer.succeed(Principal, { id: localOwnerId }),
  emptyIssueTrackerLayer,
  Layer.succeed(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
  workflowActionPlanStoreLayer,
  workflowArtifactStoreLayer,
  CredentialStore.layerEnv,
  NodeServices.layer,
  FetchHttpClient.layer,
  Layer.mock(SlackWrite, {
    sendMessage: () => Effect.die("unused"),
    replyInThread: () => Effect.die("unused"),
    addReaction: () => Effect.die("unused"),
    draftReply: () => Effect.die("unused"),
  }),
  Layer.mock(ContextAssembler, {
    assemble: ({ operatingInstructions }) =>
      Effect.succeed({
        layers: [
          {
            kind: "operating-instructions",
            source: "workflow-operation",
            content:
              typeof operatingInstructions === "string"
                ? operatingInstructions
                : `${operatingInstructions.instructionPackage}:${operatingInstructions.instruction}`,
          },
        ],
        operatingInstructionsName: "workflow-operation",
        operatingInstructionsPath: "/tmp/workflow-operation",
        operatingInstructionResources: [],
        sources: [],
      }),
    cleanup: () => Effect.void,
  }),
);

export interface HarnessBehavior {
  readonly sessionKind?: HarnessRunner["sessionKind"];
  readonly projectedMembers?: HarnessRunner["projectedMembers"];
  readonly preflight?: HarnessRunner["preflight"];
  readonly run?: HarnessRunner["run"];
  readonly coordination?: (service: CoordinationService) => CoordinationService;
  readonly observationStore?: (service: TriggerObservationStoreService) => TriggerObservationStoreService;
  readonly actionPlans?: (service: WorkflowActionPlanStoreService) => WorkflowActionPlanStoreService;
  readonly issueTracker?: IssueTrackerService;
  readonly registry?: RegistryState;
  readonly pluginContributions?: ReadonlyArray<PluginContribution>;
  readonly sourceControl?: SourceControlProviderService;
  readonly recheck?: Recheck;
}

export const probedRequirements = Layer.merge(requirements, LogProbe.captureLayer);

export const refusedRunUpdates = Effect.fn("WorkflowRunTest.refusedRunUpdates")(function* () {
  const entries = yield* (yield* LogProbe).entries;
  return entries.filter(({ message }) => JSON.stringify(message).includes("refused a status change"));
});

export const testProgram = (
  objects: ReadonlyArray<unknown>,
  behavior: HarnessBehavior = {},
  service: WorkflowsService = workflowService,
) =>
  Effect.gen(function* () {
    const output = yield* Ref.make(objects);
    const coordination = yield* makeCoordination();
    const baseObservationStore = yield* makeMemoryTriggerObservationStore;
    const observationStore = behavior.observationStore?.(baseObservationStore) ?? baseObservationStore;
    const baseActionPlans = yield* WorkflowActionPlanStore;
    const notifications = yield* makeNotifications;
    const observation = yield* TriggerObservation;
    const issueTracker = behavior.issueTracker ?? (yield* IssueTracker);
    const registry = readOnlyRegistry(behavior.registry ?? emptyRegistry);
    const harness = makeHarness([
      {
        name: harnessName,
        sessionKind: behavior.sessionKind ?? "owned-transcript",
        projectedMembers: behavior.projectedMembers ?? ["Tools"],
        planMiddleware: ["sandbox", "persistence", "instruction-context"],
        execution: fullHarnessExecution,
        capabilities: {
          authenticationModes: ["host"],
          session: { affinity: "portable", fork: false, humanAttach: false },
          structuredOutput: "native",
          policyFidelity: "exact",
          fileEventFidelity: "absent",
          usageQuality: "none",
          readinessDiagnostics: false,
          journal: false,
          takeover: false,
        },
        authentication: { mode: "host", reference: "test" },
        catalog: { models: [] },
        readiness: () =>
          Effect.succeed({
            operational: { status: "ready", retryable: false, diagnostic: "ready" },
            installation: { status: "installed", version: "1" },
            compatibility: { status: "compatible", requirement: null },
            authentication: { mode: "host", status: "available", diagnostic: "ready" },
            diagnostics: [],
          }),
        preflight: behavior.preflight ?? (() => Effect.void),
        run:
          behavior.run ??
          (() => Stream.fromEffect(Ref.modify(output, ([next, ...rest]) => [resultEvent(next), rest]))),
      },
    ]);
    const runner = yield* makeWorkflowRun.pipe(
      Effect.provideService(Workflows, service),
      Effect.provideService(
        Coordination,
        behavior.coordination?.(coordination.service) ?? coordination.service,
      ),
      Effect.provideService(TriggerObservationStore, observationStore),
      Effect.provideService(
        WorkflowActionPlanStore,
        behavior.actionPlans?.(baseActionPlans) ?? baseActionPlans,
      ),
      Effect.provideService(Harness, harness),
      Effect.provideService(PluginManager, {
        overview: Effect.die("unused"),
        install: () => Effect.die("unused"),
        uninstall: () => Effect.die("unused"),
        contributions: () => Effect.succeed(behavior.pluginContributions ?? []),
      }),
      Effect.provideService(IssueTracker, issueTracker),
      Effect.provideService(WorkspaceRegistry, registry),
      Effect.provideService(WorkflowNotifications, notifications),
      Effect.provideService(SourceControlProvider, behavior.sourceControl ?? emptySourceControl),
      Effect.provideService(TriggerObservation, {
        ...observation,
        recheck: () => Effect.succeed(behavior.recheck ?? Recheck.Matches()),
      }),
    );
    return { runner, coordination, notifications, observationStore };
  });

export const previousResultIssues = Effect.fn("WorkflowRunTest.previousResultIssues")(function* () {
  const ledger = yield* RunLedger;
  const plans = yield* Effect.forEach(yield* ledger.listRuns(10), ({ id }) => ledger.getRunPlan(id));
  return plans
    .flatMap((plan) => plan?.operatingInstructions.resources ?? [])
    .filter(({ source }) => source === "previous-result-issues")
    .map(({ content }) => content);
});

export const runSessions = Effect.fn("WorkflowRunTest.runSessions")(function* () {
  const ledger = yield* RunLedger;
  const runs = yield* ledger.listRuns(10);
  const plans = yield* Effect.forEach(runs, ({ id }) => ledger.getRunPlan(id));
  return {
    sessions: new Set(runs.map(({ session }) => session)).size,
    requests: plans.map((plan) => plan?.messages[0]?.content ?? "").sort(),
  };
});
