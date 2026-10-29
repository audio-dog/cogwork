import {
  AttemptRecord,
  Claim,
  HarnessName,
  localOwnerId,
  type ParkReason,
  ParkRecord,
  RunId,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { clockEntries } from "./clock-source";
import { ContextAssembler } from "./context-assembler";
import { Coordination, type CoordinationService, fold } from "./coordination";
import * as CredentialStore from "./credential-store";
import {
  fullHarnessExecution,
  Harness,
  HarnessError,
  type HarnessRunner,
  make as makeHarness,
} from "./harness";
import { defaultRunBudget } from "./provider-runner";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { engineTestLayer } from "./testing/engine-test-layer";
import type { TriggerAdmission } from "./trigger-observation";
import { Workflows, type WorkflowsService } from "./workflow";
import { make as makeNotifications, WorkflowNotifications } from "./workflow-notification";
import { make as makeWorkflowRun } from "./workflow-run";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
const decodeNode = Schema.decodeSync(WorkflowNodeId);
const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const decodeRun = Schema.decodeSync(RunId);
const workflow = decodeWorkflow("daily-summary");
const trigger = decodeNode("schedule");
const operation = decodeNode("summarize");
const harnessName = Schema.decodeSync(HarnessName)("scripted");
const notifyEntry = decodeEntry("cogwork.notify");
const scheduleEntry = decodeEntry("schedule.daily");

const document = Schema.decodeSync(WorkflowDocument)({
  name: "Daily summary",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: [{ id: trigger, entry: scheduleEntry, parameters: [], start: operation }],
  operations: [
    {
      id: operation,
      name: "Summarize",
      instructionPackage: "implement-agent",
      instruction: "Summarize the day.",
      permissionProfile: "read-only",
      requires: [],
      model: { harness: harnessName, model: null, options: [] },
      forEach: null,
      questions: [
        { id: decodeNode("done"), text: "Done?", choices: [{ id: decodeNode("yes"), name: "Yes" }] },
      ],
      transitions: [
        {
          when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
          actions: [{ entry: notifyEntry, parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    },
  ],
});

const workflowRecord: WorkflowRecord = {
  id: workflow,
  principal: localOwnerId,
  workingCopy: document,
  workingRevision: 1,
  publishedCopy: document,
  publishedRevision: 1,
  enabled: true,
  diagnostics: [],
  readiness: [],
};

const workflowService: WorkflowsService = {
  create: () => Effect.die("unused"),
  edit: () => Effect.die("unused"),
  publish: () => Effect.die("unused"),
  switch: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: Effect.succeed({ workflows: [workflowRecord], unreadable: [] }),
  get: () => Effect.succeed(workflowRecord),
  validate: () => Effect.succeed([]),
  catalog: Effect.succeed({
    catalog: {
      entries: [
        ...clockEntries,
        {
          key: notifyEntry,
          name: "Notify me",
          kind: "action",
          system: null,
          connection: null,
          requires: [],
          parameters: [],
          itemKind: null,
          actsOn: ["*"],
          requiresWorkspace: false,
          permissionProfile: "read-only",
          agentInputs: ["notification"],
          emits: [],
        },
      ],
      instructionPackages: [],
      harnesses: [],
    },
    machine: {
      workspaces: [],
      connections: [],
      harnesses: [{ name: harnessName, available: true }],
      defaultHarness: harnessName,
      readyNeeds: [],
    },
  }),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
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
    trigger,
    operation,
    entry: scheduleEntry,
    parameters: [],
    workspaces: [],
    catchUp: { since: 0 },
  },
  lineage: {
    root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))("schedule:1000"),
    parent: null,
    hop: 0,
  },
};

const granolaAdmission: TriggerAdmission = {
  ...admission,
  event: {
    ...admission.event,
    key: {
      _tag: "GranolaNote",
      connection: Schema.decodeSync(Schema.String.pipe(Schema.brand("ConnectionId")))(
        "granola/person@example.com",
      ),
      noteId: "note-1",
    },
    revision: "2026-10-29T15:00:00.000Z",
    atMillis: Date.UTC(2026, 9, 29, 15),
    payload: {
      _tag: "GranolaNote",
      title: "Weekly product sync",
      attendees: ["Taylor <taylor@example.com>", "Ari <ari@example.com>"],
      calendarEvent: "Weekly product sync · 2026-10-29 09:00 MDT",
      summary: "Decided to ship the smaller change.",
      transcript: "Taylor: Ship the smaller change.\nAri: Agreed.",
    },
  },
};

const makeCoordination = () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make<ReadonlyArray<AttemptRecord>>([]);
    const parks = yield* Ref.make<ReadonlyArray<ParkRecord>>([]);
    const processed = yield* Ref.make<string | null>(null);
    const read = () =>
      Effect.all([Ref.get(attempts), Ref.get(parks), Ref.get(processed)]).pipe(
        Effect.map(([currentAttempts, currentParks, currentProcessed]) =>
          fold(
            {
              claim: null,
              attempts: currentAttempts,
              handbacks: [],
              parks: currentParks,
              revision: { observed: "1000", processed: currentProcessed },
            },
            "cogwork",
          ),
        ),
      );
    return {
      service: {
        fold,
        read,
        claim: (_ref, input) => Effect.succeed(Claim.make({ ...input, by: "cogwork", claimedAtMillis: 1 })),
        release: () => Effect.void,
        recordAttempt: (_ref, input) =>
          Ref.update(attempts, (current) => [
            ...current,
            AttemptRecord.make({ ...input, atMillis: current.length + 1 }),
          ]).pipe(Effect.andThen(read())),
        park: (_ref, reason: ParkReason) =>
          Ref.update(parks, (current) => [
            ...current,
            ParkRecord.make({ reason, atMillis: current.length + 1 }),
          ]).pipe(Effect.andThen(read())),
        handBack: () => Effect.die("unused"),
        observe: () => Effect.succeed("moved"),
        markProcessed: (_ref, revision) => Ref.set(processed, revision),
      } satisfies CoordinationService,
      attempts,
      parks,
      processed,
    };
  });

const resultEvent = (object: unknown) => ({
  type: "CUSTOM" as const,
  name: "structured-output.complete" as const,
  value: { object, raw: JSON.stringify(object) },
});

const requirements = Layer.mergeAll(
  engineTestLayer(),
  CredentialStore.layerEnv,
  NodeServices.layer,
  FetchHttpClient.layer,
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

interface HarnessBehavior {
  readonly preflight?: HarnessRunner["preflight"];
  readonly run?: HarnessRunner["run"];
}

const testProgram = (objects: ReadonlyArray<unknown>, behavior: HarnessBehavior = {}) =>
  Effect.gen(function* () {
    const output = yield* Ref.make(objects);
    const coordination = yield* makeCoordination();
    const notifications = yield* makeNotifications;
    const harness = makeHarness([
      {
        name: harnessName,
        sessionKind: "owned-transcript",
        projectedMembers: [],
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
      Effect.provideService(Workflows, workflowService),
      Effect.provideService(Coordination, coordination.service),
      Effect.provideService(Harness, harness),
      Effect.provideService(WorkflowNotifications, notifications),
    );
    return { runner, coordination, notifications };
  });

describe("WorkflowRun", () => {
  it.effect("freezes the complete Granola note in Work context", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([
        {
          summary: "Captured",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Captured" },
        },
      ]);
      yield* runner.execute(granolaAdmission);
      const [run] = yield* (yield* RunLedger).listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.strictEqual(
        plan?.workContext.prose.body,
        [
          "# Weekly product sync",
          "",
          "## Attendees",
          "Taylor <taylor@example.com>",
          "Ari <ari@example.com>",
          "",
          "## Calendar event",
          "Weekly product sync · 2026-10-29 09:00 MDT",
          "",
          "## Summary",
          "Decided to ship the smaller change.",
          "",
          "## Transcript",
          "Taylor: Ship the smaller change.\nAri: Agreed.",
        ].join("\n"),
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("records a missing transcript as a Plan rejection without starting a Run", () =>
    Effect.gen(function* () {
      const rejected: TriggerAdmission = {
        ...granolaAdmission,
        event: {
          ...granolaAdmission.event,
          payload: { _tag: "GranolaNoteRejected", reason: "Granola note has no transcript" },
        },
      };
      const { runner, coordination } = yield* testProgram([]);
      yield* runner.execute(rejected);

      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
      assert.deepStrictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason, {
        _tag: "PlanRejected",
        reason: "Granola note has no transcript",
      });
      assert.strictEqual(yield* Ref.get(coordination.processed), rejected.event.revision);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("writes Notify me output and keeps the Run workspace-free", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([
        {
          summary: "All clear",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "All clear" },
        },
      ]);
      yield* runner.execute(admission);
      const ledger = yield* RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* ledger.getRunPlan(run.id);
      yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => index),
        (index) =>
          ledger.insertRun({
            ...run,
            id: decodeRun(`noise-${index}`),
            startedAtMillis: run.startedAtMillis + index + 1,
          }),
        { discard: true },
      );
      const restartedNotifications = yield* makeNotifications;

      assert.strictEqual(run.status, "succeeded");
      assert.isNull(plan?.sandbox.workspace);
      assert.strictEqual(
        plan?.instructions.find(({ source }) => source === "workflow-operation")?.content,
        "implement-agent:Summarize the day.",
      );
      assert.deepStrictEqual(
        (yield* restartedNotifications.list).map(({ summary, answers }) => ({ summary, answers })),
        [{ summary: "All clear", answers: { done: "yes" } }],
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks the item after three invalid results", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([{}, {}, {}]);
      yield* runner.execute(admission);
      yield* runner.execute(admission);
      yield* runner.execute(admission);

      assert.lengthOf(yield* Ref.get(coordination.attempts), 3);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "Exhausted");
      assert.strictEqual(yield* Ref.get(coordination.processed), "1000");
      const ledger = yield* RunLedger;
      const plans = yield* Effect.forEach(yield* ledger.listRuns(10), ({ id }) => ledger.getRunPlan(id));
      assert.isTrue(
        plans.some((plan) =>
          plan?.operatingInstructions.resources.some(({ source }) => source === "previous-result-issues"),
        ),
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks a stuck result immediately", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([
        {
          summary: "Needs a decision",
          stuck: true,
          answers: { done: "yes" },
          inputs: { notification: "Needs a decision" },
        },
      ]);
      yield* runner.execute(admission);

      assert.lengthOf(yield* Ref.get(coordination.attempts), 1);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "Stuck");
      assert.strictEqual(yield* Ref.get(coordination.processed), "1000");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("declines before creating a Run when Harness preflight fails", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([], {
        preflight: () =>
          Effect.fail(
            new HarnessError({
              reason: "credential",
              retryable: true,
              message: "Harness unavailable",
            }),
          ),
        run: () => Stream.die("unexpected Harness run"),
      });
      yield* runner.execute(admission);

      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "MissingOperation");
      assert.strictEqual(yield* Ref.get(coordination.processed), "1000");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("records a failed terminal event when a Workflow Run times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const { runner } = yield* testProgram([], {
        run: () =>
          Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.flatMap(() => Stream.never)),
      });
      const running = yield* Effect.forkChild(runner.execute(admission), { startImmediately: true });
      yield* Deferred.await(started);
      yield* TestClock.adjust(defaultRunBudget("read-only"));
      yield* Fiber.join(running);

      const ledger = yield* RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const recorder = yield* RunRecorder;
      const activities = yield* recorder.replay(run).pipe(Stream.runCollect);

      assert.deepInclude(
        activities.map(({ event }) => event),
        { type: "RUN_FINISHED", finishReason: "failed" },
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
