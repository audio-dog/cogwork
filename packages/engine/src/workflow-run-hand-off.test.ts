import { keyOf, WorkflowDocument } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { RunLedger } from "./run-ledger";
import type { WorkflowsService } from "./workflow";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { admission } from "./workflow-run-admissions-fixtures";
import {
  decodeNode,
  decodeRun,
  document,
  handToMeEntry,
  notifyEntry,
  workflow,
  workflowRecord,
  workflowService,
  workflowServiceFor,
} from "./workflow-run-documents-fixtures";
import { requirements, testProgram } from "./workflow-run-fixtures";

describe("WorkflowRun", () => {
  it.effect("runs a hand-off after the first action plan completes", () =>
    Effect.gen(function* () {
      const publish = decodeNode("publish");
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const handedOffDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [],
                handOff: publish,
              },
            ],
          },
          {
            ...summarize,
            id: publish,
            name: "Publish",
          },
        ],
      });
      const handedOffService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: handedOffDocument,
            publishedCopy: handedOffDocument,
          }),
      };
      const { runner, notifications } = yield* testProgram(
        [
          { summary: "Ready", stuck: false, answers: { done: "yes" }, inputs: {} },
          {
            summary: "Published",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Published" },
          },
        ],
        {},
        handedOffService,
      );

      yield* runner.execute(admission);

      const runs = yield* (yield* RunLedger).listRuns(10);
      assert.lengthOf(runs, 2);
      assert.deepInclude((yield* notifications.list)[0], {
        operation: publish,
        summary: "Published",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("settles a hand-to-me Run and retains its plan for Choose an answer", () =>
    Effect.gen(function* () {
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const handedDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [{ entry: handToMeEntry, parameters: [] }],
                handOff: null,
              },
            ],
          },
        ],
      });
      const handedService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: handedDocument,
            publishedCopy: handedDocument,
          }),
      };
      const { runner, coordination } = yield* testProgram(
        [
          {
            summary: "Needs your review",
            stuck: false,
            answers: { done: "yes" },
            inputs: { hand_off: "Please review" },
          },
        ],
        {},
        handedService,
      );

      yield* runner.execute(admission);

      const [run] = yield* (yield* RunLedger).listRuns(10);
      const pending = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.strictEqual(run?.status, "succeeded");
      assert.strictEqual(pending?.attempt, run?.id);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "HandedToYou");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("runs the chosen answer through the frozen plan executor", () =>
    Effect.gen(function* () {
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (summarize === undefined) return;
      const handedDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            questions: [
              {
                id: decodeNode("done"),
                text: "Done?",
                choices: [
                  { id: decodeNode("yes"), name: "Yes" },
                  { id: decodeNode("no"), name: "No" },
                ],
              },
            ],
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [{ entry: handToMeEntry, parameters: [] }],
                handOff: null,
              },
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("no") }],
                actions: [{ entry: notifyEntry, parameters: [] }],
                handOff: null,
              },
            ],
          },
        ],
      });
      const { runner, notifications, observationStore } = yield* testProgram(
        [
          {
            summary: "Needs your answer",
            stuck: false,
            answers: { done: "yes" },
            inputs: { hand_off: "Choose", notification: "Agent default" },
          },
        ],
        {},
        workflowServiceFor(handedDocument),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      const stale = yield* Effect.flip(
        runner.chooseAnswer({
          item: admission.event.key,
          attempt: decodeRun("stale-attempt"),
          answers: { done: "no" },
          inputs: { notification: "Ignored" },
        }),
      );
      assert.strictEqual(stale.reason, "stale-attempt");

      const invalid = yield* Effect.flip(
        runner.chooseAnswer({
          item: admission.event.key,
          attempt: plan.attempt,
          answers: { done: "later" },
          inputs: { notification: "Ignored" },
        }),
      );
      assert.strictEqual(invalid.reason, "invalid-edits");

      yield* runner.chooseAnswer({
        item: admission.event.key,
        attempt: plan.attempt,
        answers: { done: "no" },
        inputs: { notification: "Person chose no" },
      });

      assert.deepInclude((yield* notifications.list)[0], { summary: "Person chose no" });
      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
