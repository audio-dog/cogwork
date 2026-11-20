import {
  BranchName,
  type HandbackRecord,
  HarnessName,
  NeedIdentity,
  RunId,
  SessionId,
  WorkflowOperation,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ContextAssembler } from "./context-assembler";
import { Coordination, fold } from "./coordination";
import * as CredentialStore from "./credential-store";
import {
  fullHarnessExecution,
  Harness,
  HarnessError,
  type HarnessRunner,
  make as makeHarness,
} from "./harness";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";
import { RunLedger } from "./run-ledger";
import { HarnessPreflight } from "./run-plan-resolution";
import { make as makeRunPreparation, type RunPreparationInput } from "./run-preparation";
import { engineTestLayer } from "./testing/engine-test-layer";
import { TriggerAdmission } from "./trigger-observation-admission";
import { memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";
import { WorktreeManager } from "./worktree";

const harnessName = Schema.decodeSync(HarnessName)("scripted");
const signedOutHarness = Schema.decodeSync(HarnessName)("signed-out");
const priorAttempt = Schema.decodeSync(RunId)("run-prior");
const priorSession = Schema.decodeSync(SessionId)("session-prior");
const priorWorkItem = Schema.decodeSync(WorkItemId)("issue:cogwork:%2342");
const runWorkspace = Schema.decodeSync(WorkspaceId)("cogwork");

const operation = Schema.decodeSync(WorkflowOperation)({
  id: "implement",
  name: "Implement",
  instructionPackage: "implement-agent",
  instruction: "Build it.",
  permissionProfile: "full",
  requires: [],
  model: { harness: "scripted", model: null, options: [] },
  forEach: null,
  questions: [],
  transitions: [],
  hints: [],
});

const admission = Schema.decodeSync(TriggerAdmission)({
  event: {
    key: { _tag: "Issue", workspace: "cogwork", id: "#42" },
    revision: "r1",
    cause: { _tag: "Unknown" },
    atMillis: 5_000,
    entry: "github.issue-labeled",
    workspace: "cogwork",
  },
  subscription: {
    workflow: "coding",
    trigger: "labeled",
    operation: "implement",
    entry: "github.issue-labeled",
    parameters: [],
    workspaces: [],
    catchUp: null,
  },
  lineage: { root: "issue:cogwork:%2342", parent: priorAttempt, hop: 1 },
});

const workspace: RegisteredWorkspace = {
  source: "test",
  repository: "owner/cogwork",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: "cogwork",
    displayName: "cogwork",
    checkoutPath: "/cogwork",
    issueTracker: { type: "github" },
  }),
};

const scriptedRunner = (name: HarnessName, preflight: HarnessRunner["preflight"]): HarnessRunner => ({
  name,
  sessionKind: "owned-transcript",
  projectedMembers: ["Tools"],
  planMiddleware: ["sandbox"],
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
  preflight,
  run: () => Stream.die("unexpected Harness run"),
});

class EnsuredCheckouts extends Context.Service<EnsuredCheckouts, Ref.Ref<ReadonlyArray<boolean>>>()(
  "@cogwork/engine/run-preparation.test/EnsuredCheckouts",
) {
  static readonly layer = Layer.effect(EnsuredCheckouts, Ref.make<ReadonlyArray<boolean>>([]));
}

const testLayer = (handbacks: ReadonlyArray<HandbackRecord>) =>
  Layer.mergeAll(
    engineTestLayer(),
    Layer.unwrap(
      Effect.gen(function* () {
        const ensured = yield* EnsuredCheckouts;
        return Layer.mock(WorktreeManager, {
          ensure: (_workspace, _item, options) =>
            Ref.update(ensured, (calls) => [...calls, options?.resume ?? false]).pipe(
              Effect.map(() => ({
                branch: BranchName.make("42"),
                path: "/worktrees/42",
                created: false,
                operationInProgress: null,
              })),
            ),
        });
      }),
    ).pipe(Layer.provideMerge(EnsuredCheckouts.layer)),
    workflowArtifactStoreLayer,
    CredentialStore.layerEnv,
    NodeServices.layer,
    FetchHttpClient.layer,
    Layer.succeed(
      Harness,
      makeHarness([
        scriptedRunner(harnessName, () => Effect.void),
        scriptedRunner(signedOutHarness, () =>
          Effect.fail(
            new HarnessError({ reason: "credential", retryable: true, message: "Harness signed out" }),
          ),
        ),
      ]),
    ),
    Layer.mock(Coordination, {
      fold,
      read: () =>
        Effect.succeed(
          fold(
            {
              claim: null,
              attempts: [],
              handbacks,
              parks: [],
              revision: { observed: "r1", processed: null },
            },
            "cogwork",
            0,
          ),
        ),
    }),
    Layer.mock(PluginManager, { contributions: () => Effect.succeed([]) }),
    Layer.mock(ContextAssembler, {
      assemble: () =>
        Effect.succeed({
          layers: [],
          operatingInstructionsName: "implement-agent",
          operatingInstructionsPath: "/instructions/implement-agent",
          operatingInstructionResources: [],
          sources: [],
        }),
      cleanup: () => Effect.void,
    }),
  );

const seedPriorAttempt = Effect.fn("RunPreparationTest.seedPriorAttempt")(function* () {
  const ledger = yield* RunLedger;
  yield* ledger.insertSession({
    kind: "owned-transcript",
    id: priorSession,
    workspace: runWorkspace,
    harness: harnessName,
    createdAtMillis: 1,
  });
  yield* ledger.insertRun({
    id: priorAttempt,
    workspace: runWorkspace,
    workItem: priorWorkItem,
    operation: "implement",
    harness: harnessName,
    branch: null,
    session: priorSession,
    usage: null,
    status: "failed",
    startedAtMillis: 1,
    endedAtMillis: 2,
  });
});

const input = (pendingPlanAttempt: RunId | null): RunPreparationInput => ({
  admission,
  workspace,
  operation,
  harness: harnessName,
  run: { id: Schema.decodeSync(RunId)("run-next"), workspace: runWorkspace, startedAtMillis: 6_000 },
  pendingPlanAttempt,
  resend: null,
});

const handback: HandbackRecord = { by: "taylor", atMillis: 7_000, note: "Use the smaller fix." };

describe("Run preparation", () => {
  it.effect.each([
    { name: "mints a Session when nothing resumes", handbacks: [], pending: null, resumes: false },
    { name: "resumes the Session of a pending plan", handbacks: [], pending: priorAttempt, resumes: true },
    {
      name: "resumes the Session of a handed-back attempt",
      handbacks: [handback],
      pending: null,
      resumes: true,
    },
  ])("$name", ({ handbacks, pending, resumes }) =>
    Effect.gen(function* () {
      yield* seedPriorAttempt();
      const preparation = yield* makeRunPreparation;

      const prepared = yield* preparation.prepare(input(pending));

      assert.deepStrictEqual(
        {
          resumedSession: prepared.session === priorSession,
          ensuredWithResume: yield* Ref.get(yield* EnsuredCheckouts),
          handback: prepared.handback,
        },
        {
          resumedSession: resumes,
          ensuredWithResume: [resumes],
          handback: handbacks[0] ?? null,
        },
      );
    }).pipe(Effect.provide(testLayer(handbacks)), Effect.scoped),
  );

  const githubNeed = Schema.decodeSync(NeedIdentity)("connection:github");
  const requiringOperation = (harness: HarnessName | null) => ({
    ...operation,
    requires: [githubNeed],
    model: { ...operation.model, harness },
  });

  it.effect.each([
    {
      name: "no Harness is selected",
      harness: null,
      readyNeeds: [githubNeed],
      preflight: HarnessPreflight.Unselected(),
    },
    {
      name: "a required need is not ready, without probing the Harness",
      harness: signedOutHarness,
      readyNeeds: [],
      preflight: HarnessPreflight.NeedMissing({ need: githubNeed }),
    },
    {
      name: "the Harness preflight fails",
      harness: signedOutHarness,
      readyNeeds: [githubNeed],
      preflight: HarnessPreflight.Failed({ name: signedOutHarness, message: "Harness signed out" }),
    },
    {
      name: "the Harness preflight passes",
      harness: harnessName,
      readyNeeds: [githubNeed],
      preflight: HarnessPreflight.Passed({
        name: harnessName,
        projectedMembers: ["Tools"],
        middleware: ["sandbox"],
        sessionKind: "owned-transcript",
      }),
    },
  ])("reports $name", ({ harness, readyNeeds, preflight }) =>
    Effect.gen(function* () {
      const preparation = yield* makeRunPreparation;

      assert.deepStrictEqual(
        yield* preparation.preflight(requiringOperation(harness), { defaultHarness: null, readyNeeds }),
        preflight,
      );
    }).pipe(Effect.provide(testLayer([])), Effect.scoped),
  );
});
