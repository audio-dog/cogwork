import { HandbackRecord, LineageId, type MachineReadiness, RunId, WorkspaceId } from "@cogwork/contracts";
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
import { resolveRunPlan } from "./run-plan-resolution";
import { make as makeRunPreparation, type PreparedRun, type RunPreparationRequest } from "./run-preparation";
import { engineTestLayer } from "./testing/engine-test-layer";
import { admission, claim, harnessName, operation, workflow } from "./testing/run-plan-fixtures";
import { memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";

const decodeRun = Schema.decodeSync(RunId);
const runWorkspace = Schema.decodeSync(WorkspaceId)(workflow);

const machine: MachineReadiness = {
  workspaces: [],
  connections: [],
  harnesses: [{ name: harnessName, available: true }],
  defaultHarness: harnessName,
  readyNeeds: [],
};

const request = (id: string, overrides: Partial<RunPreparationRequest> = {}): RunPreparationRequest => ({
  id: decodeRun(id),
  admission,
  operation,
  harness: harnessName,
  workspace: null,
  runWorkspace,
  pendingAttempt: null,
  startedAtMillis: 1_000,
  ...overrides,
});

const parkedAdmission = (attempt: RunId) => ({
  ...admission,
  lineage: { ...admission.lineage, parent: LineageId.make(attempt) },
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

const acceptAttempt = Effect.fn("RunPreparationTest.acceptAttempt")(function* (
  prepared: PreparedRun,
  attempt: RunId,
) {
  const { plan } = resolveRunPlan({
    id: attempt,
    admission,
    workflow: { id: workflow, publishedRevision: 1 },
    operation,
    workspace: null,
    catalog: { entries: [], instructionPackages: [], harnesses: [] },
    outputWorkspaces: [],
    claim,
    priorIssues: null,
    prepared,
  });
  const ledger = yield* RunLedger;
  yield* ledger.acceptRun(
    {
      id: attempt,
      workspace: runWorkspace,
      workItem: plan.workContext.reference.workItem,
      workflow,
      operation: operation.id,
      harness: prepared.harness,
      branch: null,
      session: prepared.session,
      usage: null,
      status: "running",
      startedAtMillis: 1_000,
      endedAtMillis: null,
    },
    plan,
  );
});

describe("RunPreparation", () => {
  it.effect.each([
    {
      name: "mints a new Session when the parked attempt was not handed back",
      handbacks: [],
      resumes: false,
    },
    {
      name: "resumes the Session of a handed-back attempt",
      handbacks: [HandbackRecord.make({ by: "Taylor", atMillis: 2_000, note: null })],
      resumes: true,
    },
  ])("$name", ({ handbacks, resumes }) =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;
      const parked = request("run-1");
      const first = yield* preparation.prepare(parked);
      yield* acceptAttempt(first, parked.id);

      const next = yield* preparation.prepare(request("run-2", { admission: parkedAdmission(parked.id) }));

      assert.strictEqual(next.session === first.session, resumes);
    }).pipe(Effect.provide(preparationLayer({ handbacks })), Effect.scoped),
  );

  it.effect("resumes the Session of a pending plan's attempt", () =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;
      const pending = request("run-1");
      const first = yield* preparation.prepare(pending);
      yield* acceptAttempt(first, pending.id);

      const resumed = yield* preparation.prepare(request("run-2", { pendingAttempt: pending.id }));

      assert.strictEqual(resumed.session, first.session);
    }).pipe(Effect.provide(preparationLayer({})), Effect.scoped),
  );

  it.effect("reports a failed Harness preflight", () =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;

      assert.deepStrictEqual(yield* preparation.preflight(operation, machine), {
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
