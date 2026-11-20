import { ControlStoreFailure, LineageId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CoordinationError } from "./coordination";
import { emptyRegistry } from "./projector";
import { defaultRunBudget } from "./provider-runner";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { emptyService as emptySourceControl } from "./source-control";
import { admission } from "./workflow-run-admissions-fixtures";
import {
  postReviewCatalogEntry,
  reviewDocument,
  reviewOutput,
  reviewWorkspace,
  waitForApprovalCatalogEntry,
  workflowServiceFor,
} from "./workflow-run-documents-fixtures";
import { requirements, testProgram } from "./workflow-run-fixtures";

describe("WorkflowRun", () => {
  it.effect("records a failed terminal event when a Workflow Run times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const { runner, coordination } = yield* testProgram([], {
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
      assert.deepStrictEqual(
        (yield* Ref.get(coordination.attempts)).map(({ reason }) => reason),
        ["The Harness stopped before the agent returned a result: the Run used all of its time budget."],
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect(
    "settles the fresh Run once and parks the item when resumed Action plan failures exhaust it",
    () =>
      Effect.gen(function* () {
        const { runner, coordination, observationStore } = yield* testProgram(
          [
            {
              summary: "All clear",
              stuck: false,
              answers: { done: "yes" },
              inputs: { notification: "All clear" },
            },
          ],
          {
            actionPlans: (service) => ({
              ...service,
              save: () =>
                Effect.fail(
                  new ControlStoreFailure({
                    operation: "save Workflow action plan",
                    message: "Control store unavailable",
                    retryable: true,
                  }),
                ),
            }),
          },
        );
        const ledger = yield* RunLedger;

        const results = yield* Effect.forEach([1, 2, 3], () =>
          runner.execute(admission).pipe(
            Effect.flatMap((outcome) =>
              Effect.map(ledger.listRuns(10), (runs) => ({
                outcome,
                statuses: runs.map(({ status }) => status),
              })),
            ),
          ),
        );

        assert.deepStrictEqual(results, [
          { outcome: "retry", statuses: ["failed"] },
          { outcome: "retry", statuses: ["failed"] },
          { outcome: "completed", statuses: ["failed"] },
        ]);
        const attempts = yield* Ref.get(coordination.attempts);
        assert.deepStrictEqual(
          attempts.map(({ outcome }) => outcome),
          ["failed", "failed", "failed"],
        );
        assert.include(attempts[0]?.reason ?? "", "Control store unavailable");
        assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "Exhausted");
        const [run] = yield* ledger.listRuns(10);
        assert.isDefined(run);
        if (!run) return;
        assert.deepStrictEqual(
          (yield* observationStore.admissions).map(({ lineage }) => lineage.parent),
          [LineageId.make(run.id)],
        );
      }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("settles the Run and records a failed attempt when the Action plan build dies", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram(
        [reviewOutput],
        {
          registry: { ...emptyRegistry, workspaces: [reviewWorkspace] },
          sourceControl: {
            ...emptySourceControl,
            readPullRequest: () => Effect.die("pull request read crashed"),
          },
        },
        workflowServiceFor(reviewDocument, [postReviewCatalogEntry, waitForApprovalCatalogEntry]),
      );

      const outcome = yield* runner.execute(admission);

      const runs = yield* (yield* RunLedger).listRuns(10);
      const attempts = yield* Ref.get(coordination.attempts);
      assert.deepStrictEqual(
        {
          outcome,
          statuses: runs.map(({ status }) => status),
          attempts: attempts.map(({ outcome }) => outcome),
        },
        { outcome: "retry", statuses: ["failed"], attempts: ["failed"] },
      );
      assert.strictEqual(attempts[0]?.reason, "pull request read crashed");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("settles the Run without a second attempt when a write fails after its attempt", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram(
        [
          {
            summary: "Needs a decision",
            stuck: true,
            answers: { done: "yes" },
            inputs: { notification: "Wait" },
          },
        ],
        {
          coordination: (service) => ({
            ...service,
            park: () =>
              Effect.fail(
                new CoordinationError({
                  reason: "unavailable",
                  retryable: true,
                  message: "Control store unavailable",
                }),
              ),
          }),
        },
      );

      const result = yield* Effect.result(runner.execute(admission));

      const runs = yield* (yield* RunLedger).listRuns(10);
      assert.isTrue(Result.isFailure(result));
      assert.deepStrictEqual(
        {
          statuses: runs.map(({ status }) => status),
          attempts: (yield* Ref.get(coordination.attempts)).map(({ outcome }) => outcome),
        },
        { statuses: ["failed"], attempts: ["failed"] },
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("settles an interrupted Run as interrupted and records no attempt or park", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const { runner, coordination } = yield* testProgram([], {
        run: () =>
          Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.flatMap(() => Stream.never)),
      });
      const running = yield* Effect.forkChild(runner.execute(admission), { startImmediately: true });
      yield* Deferred.await(started);

      yield* Fiber.interrupt(running);

      const runs = yield* (yield* RunLedger).listRuns(10);
      assert.deepStrictEqual(
        {
          statuses: runs.map(({ status }) => status),
          attempts: yield* Ref.get(coordination.attempts),
          parks: yield* Ref.get(coordination.parks),
        },
        { statuses: ["interrupted"], attempts: [], parks: [] },
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
