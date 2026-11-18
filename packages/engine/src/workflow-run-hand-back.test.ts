import { keyOf, WorkflowActionPlan, WorkflowActionPlanStep, WorkflowDocument } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { RunLedger } from "./run-ledger";
import type { WorkflowsService } from "./workflow";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { admission } from "./workflow-run-admissions-fixtures";
import {
  decodeNode,
  decodeRun,
  decodeSession,
  decodeWorkItem,
  decodeWorkspace,
  document,
  harnessName,
  notifyEntry,
  waitForApprovalEntry,
  workflow,
  workflowRecord,
  workflowService,
} from "./workflow-run-documents-fixtures";
import { probedRequirements, refusedRunUpdates, requirements, testProgram } from "./workflow-run-fixtures";

describe("WorkflowRun", () => {
  it.effect("replans the frozen operation after handback and keeps its prior Run's status", () =>
    Effect.gen(function* () {
      const publish = decodeNode("publish");
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const replannedDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [...document.operations, { ...summarize, id: publish, name: "Publish" }],
      });
      const replannedService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: replannedDocument,
            publishedCopy: replannedDocument,
          }),
      };
      const { runner, coordination, notifications } = yield* testProgram(
        [
          {
            summary: "Published",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Published" },
          },
        ],
        {},
        replannedService,
      );
      const pending = WorkflowActionPlan.make({
        item: keyOf(admission.event.key),
        workflow,
        attempt: decodeRun("publish-plan"),
        operation: publish,
        revision: admission.event.revision,
        createdAtMillis: 1,
        consumedHandbackAtMillis: 0,
        digest: "publish-plan",
        summary: "Waiting for a Workspace",
        answers: {},
        lineage: admission.lineage,
        handOff: null,
        steps: [
          WorkflowActionPlanStep.make({
            position: 0,
            entry: notifyEntry,
            parameters: [],
            inputs: { notification: "stale" },
            target: { _tag: "NoWorkspace" },
            writeKey: "publish-plan:0",
            status: "pending",
            failures: 0,
            artifact: null,
          }),
        ],
      });
      const ledger = yield* RunLedger;
      const priorSession = decodeSession("publish-session");
      yield* ledger.insertSession({
        kind: "owned-transcript",
        id: priorSession,
        workspace: decodeWorkspace(workflow),
        harness: harnessName,
        createdAtMillis: 1,
      });
      yield* ledger.insertRun({
        id: pending.attempt,
        workspace: decodeWorkspace(workflow),
        workItem: decodeWorkItem(keyOf(admission.event.key)),
        operation: "implement",
        harness: harnessName,
        branch: null,
        session: priorSession,
        usage: null,
        status: "failed",
        startedAtMillis: 1,
        endedAtMillis: 2,
      });
      yield* (yield* WorkflowActionPlanStore).create(pending);
      yield* coordination.service.handBack(admission.event.key, {
        by: "Taylor",
        note: "Use the repaired Workspace",
      });

      yield* runner.execute(admission);

      assert.deepInclude((yield* notifications.list)[0], {
        operation: publish,
        summary: "Published",
      });
      assert.deepInclude(yield* ledger.getRun(pending.attempt), {
        status: "failed",
        endedAtMillis: 2,
      });
      const resumed = (yield* ledger.listRuns(10)).find(({ id }) => id !== pending.attempt);
      assert.strictEqual(resumed?.session, priorSession);
      const resumedPlan = resumed === undefined ? null : yield* ledger.getRunPlan(resumed.id);
      assert.include(resumedPlan?.messages[0]?.content ?? "", "Person's note: Use the repaired Workspace");
      assert.strictEqual(yield* Ref.get(coordination.claims), 1);
      assert.isEmpty(yield* refusedRunUpdates());
    }).pipe(Effect.provide(probedRequirements), Effect.scoped),
  );

  it.effect("resumes a stuck Operation session with the person's note", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([
        {
          summary: "Needs a decision",
          stuck: true,
          answers: { done: "yes" },
          inputs: { notification: "Wait" },
        },
        {
          summary: "Recovered",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Recovered" },
        },
      ]);
      const ledger = yield* RunLedger;
      yield* runner.execute(admission);
      const [parked] = yield* ledger.listRuns(10);
      assert.isDefined(parked);
      if (parked === undefined) return;
      assert.lengthOf(yield* Ref.get(coordination.parks), 1);
      assert.isNotNull((yield* coordination.service.read(admission.event.key)).park);

      yield* runner.handBack({ item: admission.event.key, note: "Use the human decision" });
      yield* runner.execute(admission);

      const resumed = (yield* ledger.listRuns(10)).find(({ id }) => id !== parked.id);
      assert.strictEqual(resumed?.session, parked.session);
      const resumedPlan = resumed === undefined ? null : yield* ledger.getRunPlan(resumed.id);
      assert.include(resumedPlan?.messages[0]?.content ?? "", "Person's note: Use the human decision");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses handback without an active park", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([]);

      const failure = yield* Effect.flip(runner.handBack({ item: admission.event.key }));

      assert.strictEqual(failure.reason, "not-found");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("reruns the operation when handback overtakes a new approval plan", () =>
    Effect.gen(function* () {
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const waitingDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [{ entry: waitForApprovalEntry, parameters: [] }],
                handOff: null,
              },
            ],
          },
        ],
      });
      const waitingService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: waitingDocument,
            publishedCopy: waitingDocument,
          }),
        catalog: workflowService.catalog.pipe(
          Effect.map((result) => ({
            ...result,
            catalog: {
              ...result.catalog,
              entries: [
                ...result.catalog.entries,
                {
                  key: waitForApprovalEntry,
                  name: "Wait for my approval",
                  kind: "action",
                  system: null,
                  connection: null,
                  requires: [],
                  parameters: [],
                  itemKind: null,
                  actsOn: ["*"],
                  requiresWorkspace: false,
                  workspaceSource: null,
                  permissionProfile: "read-only",
                  agentInputs: ["approval_request"],
                  emits: [],
                },
              ],
            },
          })),
        ),
      };
      const coordinationReads = yield* Ref.make(0);
      const { runner } = yield* testProgram(
        [
          {
            summary: "First plan",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Approve the first plan" },
          },
          {
            summary: "Second plan",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Approve the second plan" },
          },
        ],
        {
          coordination: (service) => ({
            ...service,
            read: (...args) =>
              Ref.updateAndGet(coordinationReads, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 3
                    ? service
                        .handBack(admission.event.key, { by: "Taylor" })
                        .pipe(
                          Effect.andThen(TestClock.adjust("2001 millis")),
                          Effect.andThen(service.read(...args)),
                        )
                    : service.read(...args),
                ),
              ),
          }),
        },
        waitingService,
      );

      yield* runner.execute(admission);

      const runs = yield* (yield* RunLedger).listRuns(10);
      assert.lengthOf(runs, 2);
      assert.lengthOf(
        runs.filter(({ status }) => status === "interrupted"),
        1,
      );
      assert.lengthOf(
        runs.filter(({ status }) => status === "succeeded"),
        1,
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
