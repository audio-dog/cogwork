import {
  Claim,
  HandbackRecord,
  HarnessName,
  LineageId,
  type MachineReadiness,
  RunId,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkflowOperation,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ContextAssembler } from "./context-assembler";
import { Coordination, fold } from "./coordination";
import * as CredentialStore from "./credential-store";
import { Harness, HarnessError } from "./harness";
import { RunLedger } from "./run-ledger";
import { RunPlanResolution, resolveRunPlan } from "./run-plan-resolution";
import { make as makeRunPreparation, type PreparedRun, type RunPreparationRequest } from "./run-preparation";
import { engineTestLayer } from "./testing/engine-test-layer";
import type { TriggerAdmission } from "./trigger-observation";
import { memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";

const workflow = Schema.decodeSync(WorkflowId)("daily-summary");
const node = Schema.decodeSync(WorkflowNodeId);
const scheduleEntry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
const harnessName = Schema.decodeSync(HarnessName)("scripted");
const decodeRun = Schema.decodeSync(RunId);

const operation = Schema.decodeSync(WorkflowOperation)({
  id: "summarize",
  name: "Summarize",
  instructionPackage: "implement-agent",
  instruction: "Summarize the day.",
  permissionProfile: "read-only",
  requires: [],
  model: { harness: null, model: null, options: [] },
  forEach: null,
  questions: [],
  transitions: [],
  hints: [],
});

const machine: MachineReadiness = {
  workspaces: [],
  connections: [],
  harnesses: [{ name: harnessName, available: true }],
  defaultHarness: harnessName,
  readyNeeds: [],
};

const admission: TriggerAdmission = {
  event: {
    key: { _tag: "ScheduleInstant", workflow, instantMillis: 1_000 },
    revision: "1000",
    cause: { _tag: "Unknown" },
    atMillis: 1_000,
    entry: scheduleEntry,
    workspace: null,
  },
  subscription: {
    workflow,
    trigger: node("schedule"),
    operation: operation.id,
    entry: scheduleEntry,
    parameters: [],
    filters: [],
    workspaces: [],
    catchUp: { since: 0 },
  },
  lineage: { root: LineageId.make("schedule:1000"), parent: null, hop: 0 },
};

const workflowRecord = { id: workflow, publishedRevision: 1 };

const runWorkspace = Schema.decodeSync(WorkspaceId)(workflow);

const request = (id: string, overrides: Partial<RunPreparationRequest> = {}): RunPreparationRequest => ({
  id: decodeRun(id),
  admission,
  operation,
  machine,
  workspace: null,
  runWorkspace,
  pendingAttempt: null,
  startedAtMillis: 1_000,
  ...overrides,
});

const preparationLayer = (options: {
  readonly preflight?: () => Effect.Effect<void, HarnessError>;
  readonly handbacks?: ReadonlyArray<HandbackRecord>;
}) =>
  Layer.mergeAll(
    engineTestLayer(),
    NodeServices.layer,
    FetchHttpClient.layer,
    CredentialStore.layerEnv,
    workflowArtifactStoreLayer,
    Layer.mock(Harness, {
      signIn: () => null,
      catalogs: new Map(),
      capabilities: () => null,
      projectedMembers: () => [],
      preflight: options.preflight ?? (() => Effect.void),
      sessionKind: () => "owned-transcript",
      planMiddleware: () => [],
    }),
    Layer.mock(Coordination, {
      fold,
      read: () =>
        Effect.succeed(
          fold(
            {
              claim: null,
              attempts: [],
              handbacks: options.handbacks ?? [],
              parks: [],
              revision: { observed: "1000", processed: null },
            },
            "cogwork",
          ),
        ),
    }),
    Layer.mock(ContextAssembler, {
      assemble: () =>
        Effect.succeed({
          layers: [],
          operatingInstructionsName: "workflow-operation",
          operatingInstructionsPath: "/tmp/workflow-operation",
          operatingInstructionResources: [],
          sources: [],
        }),
      cleanup: () => Effect.void,
    }),
  );

const sessionOf = (prepared: PreparedRun) =>
  prepared._tag === "Ready" ? prepared.provisioned.session : null;

const acceptAttempt = Effect.fn("RunPreparationTest.acceptAttempt")(function* (
  prepared: PreparedRun,
  attempt: RunId,
) {
  const resolution = resolveRunPlan({
    id: attempt,
    admission,
    workflow: workflowRecord,
    operation,
    workspace: null,
    catalog: { entries: [], instructionPackages: [], harnesses: [] },
    outputWorkspaces: [],
    claim: Claim.make({
      by: "cogwork",
      claimedAtMillis: 1,
      operation: { workflow, operation: operation.id },
      lineage: admission.lineage,
    }),
    priorIssues: null,
    prepared,
  });
  if (!RunPlanResolution.$is("Accepted")(resolution)) return yield* Effect.die("Run Plan was rejected");
  const ledger = yield* RunLedger;
  yield* ledger.acceptRun(
    {
      id: attempt,
      workspace: runWorkspace,
      workItem: resolution.plan.workContext.reference.workItem,
      workflow,
      operation: operation.id,
      harness: resolution.provisioned.harness,
      branch: null,
      session: resolution.provisioned.session,
      usage: null,
      status: "running",
      startedAtMillis: 1_000,
      endedAtMillis: null,
    },
    resolution.plan,
  );
});

describe("RunPreparation", () => {
  it.effect("mints a new Session for a parked attempt that was not handed back", () =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;
      const parked = request("run-1");
      const first = yield* preparation.prepare(parked);
      yield* acceptAttempt(first, parked.id);

      const next = yield* preparation.prepare(
        request("run-2", {
          admission: { ...admission, lineage: { ...admission.lineage, parent: LineageId.make(parked.id) } },
        }),
      );

      assert.isNotNull(sessionOf(next));
      assert.notStrictEqual(sessionOf(next), sessionOf(first));
    }).pipe(Effect.provide(preparationLayer({})), Effect.scoped),
  );

  it.effect("resumes the Session of a pending plan's attempt", () =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;
      const pending = request("run-1");
      const first = yield* preparation.prepare(pending);
      yield* acceptAttempt(first, pending.id);

      const resumed = yield* preparation.prepare(request("run-2", { pendingAttempt: pending.id }));

      assert.strictEqual(sessionOf(resumed), sessionOf(first));
    }).pipe(Effect.provide(preparationLayer({})), Effect.scoped),
  );

  it.effect("resumes the Session of a handed-back attempt", () =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;
      const parked = request("run-1");
      const first = yield* preparation.prepare(parked);
      yield* acceptAttempt(first, parked.id);

      const resumed = yield* preparation.prepare(
        request("run-2", {
          admission: { ...admission, lineage: { ...admission.lineage, parent: LineageId.make(parked.id) } },
        }),
      );

      assert.strictEqual(sessionOf(resumed), sessionOf(first));
      assert.strictEqual(
        resumed._tag === "Ready" ? resumed.provisioned.handbackNote : null,
        "Use the decision",
      );
    }).pipe(
      Effect.provide(
        preparationLayer({
          handbacks: [HandbackRecord.make({ by: "Taylor", atMillis: 2_000, note: " Use the decision " })],
        }),
      ),
      Effect.scoped,
    ),
  );

  it.effect("reports a failed Harness preflight in its readiness", () =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;
      const prepared = yield* preparation.prepare(request("run-1"));

      assert.deepStrictEqual(prepared._tag === "Unready" ? prepared.readiness : null, {
        harness: harnessName,
        missingNeeds: [],
        preflightFailure: "Harness unavailable",
      });
    }).pipe(
      Effect.provide(
        preparationLayer({
          preflight: () =>
            Effect.fail(
              new HarnessError({ reason: "credential", retryable: true, message: "Harness unavailable" }),
            ),
        }),
      ),
      Effect.scoped,
    ),
  );
});
