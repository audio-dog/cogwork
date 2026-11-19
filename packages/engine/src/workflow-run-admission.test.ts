import { NeedIdentity, WorkflowDocument } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { CoordinationError } from "./coordination";
import { HarnessError } from "./harness";
import { RunLedger } from "./run-ledger";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { Recheck } from "./trigger-source";
import { admission, granolaAdmission, siblingGranolaAdmission } from "./workflow-run-admissions-fixtures";
import {
  document,
  operation,
  siblingWorkflow,
  workflow,
  workflowService,
  workflowServiceWith,
} from "./workflow-run-documents-fixtures";
import { requirements, testProgram } from "./workflow-run-fixtures";

describe("WorkflowRun", () => {
  it.effect("waits for every sibling rejection before processing the source revision", () =>
    Effect.gen(function* () {
      const rejected: TriggerAdmission = {
        ...granolaAdmission,
        event: {
          ...granolaAdmission.event,
          payload: { _tag: "GranolaNoteRejected", reason: "Granola note has no transcript" },
        },
      };
      const sibling = { ...rejected, subscription: siblingGranolaAdmission.subscription };
      const { runner, coordination, observationStore } = yield* testProgram([]);
      yield* observationStore.putAll([rejected, sibling]);
      yield* runner.execute(rejected);

      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
      assert.deepStrictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason, {
        _tag: "PlanRejected",
        reason: "Granola note has no transcript",
        entry: granolaAdmission.event.entry,
      });
      assert.isNull(yield* Ref.get(coordination.processed));

      yield* runner.execute(sibling);

      assert.strictEqual(yield* Ref.get(coordination.processed), rejected.event.revision);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("reports a rejected Granola note as skipped", () =>
    Effect.gen(function* () {
      const rejected: TriggerAdmission = {
        ...granolaAdmission,
        event: {
          ...granolaAdmission.event,
          payload: { _tag: "GranolaNoteRejected", reason: "Granola note has no transcript" },
        },
      };
      const { runner } = yield* testProgram([]);

      assert.strictEqual(yield* runner.execute(rejected), "skipped");
      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("skips an admission whose item no longer matches its Trigger, with no attempt", () =>
    Effect.gen(function* () {
      const { runner, coordination, observationStore } = yield* testProgram([{}], {
        recheck: Recheck.Ended({ reason: "Issue #1 is closed" }),
      });
      yield* observationStore.putAll([admission]);

      assert.strictEqual(yield* runner.execute(admission), "skipped");
      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
      assert.strictEqual(yield* Ref.get(coordination.processed), admission.event.revision);
      assert.deepStrictEqual(
        (yield* observationStore.processed).map(({ event }) => event.payload),
        [{ _tag: "NoLongerMatches", reason: "Issue #1 is closed" }],
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("keeps an admission waiting while its item fails a Trigger filter", () =>
    Effect.gen(function* () {
      const { runner, coordination, observationStore } = yield* testProgram([{}], {
        recheck: Recheck.Waiting({ reason: "#1 fails Issue is not blocked" }),
      });
      yield* observationStore.putAll([admission]);

      assert.strictEqual(yield* runner.execute(admission), "waiting");
      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
      assert.isNull(yield* Ref.get(coordination.processed));
      assert.lengthOf(yield* observationStore.admissions, 1);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("reports a non-exhausted failure as retryable", () =>
    Effect.gen(function* () {
      const { runner, coordination, observationStore } = yield* testProgram([{}]);
      yield* observationStore.putAll([admission]);

      assert.strictEqual(yield* runner.execute(admission), "retry");
      assert.isNull(yield* Ref.get(coordination.processed));
      assert.lengthOf(yield* observationStore.admissions, 1);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("marks a source revision processed after its last sibling Workflow admission", () =>
    Effect.gen(function* () {
      const siblingAdmission = {
        ...admission,
        subscription: { ...admission.subscription, workflow: siblingWorkflow },
      } satisfies TriggerAdmission;
      const { runner, coordination, observationStore } = yield* testProgram([
        {
          summary: "First complete",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "First complete" },
        },
        {
          summary: "Second complete",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Second complete" },
        },
      ]);
      yield* observationStore.putAll([admission, siblingAdmission]);

      yield* runner.execute(admission);
      assert.isNull(yield* Ref.get(coordination.processed));

      yield* runner.execute(siblingAdmission);
      assert.strictEqual(yield* Ref.get(coordination.processed), "1000");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("marks a source revision processed when sibling completions overlap", () =>
    Effect.gen(function* () {
      const siblingAdmission = {
        ...admission,
        subscription: { ...admission.subscription, workflow: siblingWorkflow },
      } satisfies TriggerAdmission;
      const readers = yield* Ref.make(0);
      const bothReading = yield* Deferred.make<void>();
      const { runner, coordination, observationStore } = yield* testProgram(
        [
          {
            summary: "First complete",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "First complete" },
          },
          {
            summary: "Second complete",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Second complete" },
          },
        ],
        {
          observationStore: (service) => ({
            ...service,
            complete: (...args) =>
              Ref.updateAndGet(readers, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2 ? Deferred.succeed(bothReading, undefined) : Deferred.await(bothReading),
                ),
                Effect.andThen(service.complete(...args)),
              ),
          }),
        },
      );
      yield* observationStore.putAll([admission, siblingAdmission]);

      yield* Effect.all([runner.execute(admission), runner.execute(siblingAdmission)], {
        concurrency: "unbounded",
        discard: true,
      });

      assert.strictEqual(yield* Ref.get(coordination.processed), "1000");
      assert.deepStrictEqual(yield* observationStore.admissions, []);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("keeps the last admission pending when source completion fails", () =>
    Effect.gen(function* () {
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Complete",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Complete" },
          },
        ],
        {
          coordination: (service) => ({
            ...service,
            markProcessed: () =>
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
      yield* observationStore.putAll([admission]);

      const result = yield* Effect.result(runner.execute(admission));

      assert.isTrue(Result.isFailure(result));
      assert.deepStrictEqual(yield* observationStore.admissions, [admission]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("keeps a source revision pending after a non-exhausted Workflow failure", () =>
    Effect.gen(function* () {
      const { runner, coordination, observationStore } = yield* testProgram([], {
        run: () =>
          Stream.fail(
            new HarnessError({
              reason: "turn",
              retryable: true,
              message: "Harness failed",
            }),
          ),
      });
      yield* observationStore.putAll([admission]);

      const outcome = yield* runner.execute(admission);

      assert.strictEqual(outcome, "retry");
      assert.isNull(yield* Ref.get(coordination.processed));
      assert.deepStrictEqual(yield* observationStore.admissions, [admission]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  const documentWithOperation = (change: Partial<WorkflowDocument["operations"][number]>) =>
    WorkflowDocument.make({
      ...document,
      operations: document.operations.map((candidate) => ({ ...candidate, ...change })),
    });
  const unreadyCases = [
    {
      name: "no Harness can be selected",
      preflight: () => Effect.void,
      service: {
        ...workflowServiceWith(documentWithOperation({ model: { harness: null, model: null, options: [] } })),
        catalog: workflowService.catalog.pipe(
          Effect.map((result) => ({ ...result, machine: { ...result.machine, defaultHarness: null } })),
        ),
      },
    },
    {
      name: "Harness preflight fails",
      preflight: () =>
        Effect.fail(
          new HarnessError({
            reason: "credential",
            retryable: true,
            message: "Harness unavailable",
          }),
        ),
      service: workflowService,
    },
    {
      name: "a required connection is not ready",
      preflight: () => Effect.void,
      service: workflowServiceWith(
        documentWithOperation({ requires: [NeedIdentity.make("connection:github")] }),
      ),
    },
  ] as const;

  unreadyCases.forEach(({ name, preflight, service }) => {
    it.effect(`declines without a park when ${name}`, () =>
      Effect.gen(function* () {
        const { runner, coordination } = yield* testProgram(
          [],
          { preflight, run: () => Stream.die("unexpected Harness run") },
          service,
        );

        assert.strictEqual(yield* runner.execute(admission), "waiting");
        assert.deepStrictEqual(yield* Ref.get(coordination.parks), []);
        assert.isNull(yield* Ref.get(coordination.processed));
        assert.strictEqual(
          (yield* coordination.service.read(admission.event.key)).gate({ workflow, operation })._tag,
          "Open",
        );
      }).pipe(Effect.provide(requirements), Effect.scoped),
    );
  });
});
