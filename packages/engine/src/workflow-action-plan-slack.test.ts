import { keyOf, WorkflowActionPlan, WorkflowDocument } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { slackActionEntries } from "./slack-write";
import { buildWorkflowActionPlan, executeWorkflowActionPlan } from "./workflow-action-plan";
import {
  ActionPlanProbe,
  decodeEntry,
  decodeRun,
  decodeSlackChannel,
  decodeSlackTarget,
  decodeSlackTs,
  operation,
  plan,
  requirements,
  slackAdmission,
  slackRef,
  slackStep,
  slackTeam,
} from "./workflow-action-plan-fixtures";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";

describe("Workflow action plan", () => {
  it.effect("freezes Slack channel and item targets before writing", () =>
    Effect.gen(function* () {
      const slackOperation = {
        id: operation,
        name: "Write",
        instructionPackage: null,
        instruction: "Respond in Slack.",
        permissionProfile: "read-only",
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [],
        transitions: [
          {
            when: [],
            actions: [
              { entry: decodeEntry("slack.send-message"), parameters: [{ id: "channel", value: "C456" }] },
              { entry: decodeEntry("slack.reply-in-thread"), parameters: [] },
              { entry: decodeEntry("slack.add-reaction"), parameters: [{ id: "emoji", value: "eyes" }] },
              { entry: decodeEntry("slack.draft-reply-in-slack"), parameters: [] },
            ],
            handOff: null,
          },
        ],
        hints: [],
      } as const;
      const document = WorkflowDocument.make({
        name: "Slack writes",
        workspaces: { _tag: "Every" },
        triggers: [],
        operations: [slackOperation],
      });
      const catalog = {
        entries: slackActionEntries,
        instructionPackages: [],
        harnesses: [],
      };

      const built = yield* buildWorkflowActionPlan({
        admission: slackAdmission,
        document,
        operation: slackOperation,
        catalog,
        workspaces: [],
        output: { summary: "Respond", answers: {}, inputs: { message: "Hello", reply: "On it" } },
        attempt: decodeRun("slack-plan"),
        createdAtMillis: 20,
        workflowRevision: 1,
      });

      assert.deepStrictEqual(
        built.steps.map(({ target }) => target),
        [
          decodeSlackTarget({ _tag: "SlackChannel", channel: "C456" }),
          decodeSlackTarget({
            _tag: "SlackMessage",
            team: "T123",
            channel: "C123",
            ts: "900.000",
            threadTs: "900.000",
          }),
          decodeSlackTarget({
            _tag: "SlackMessage",
            team: "T123",
            channel: "C123",
            ts: "900.000",
            threadTs: "900.000",
          }),
          decodeSlackTarget({
            _tag: "SlackMessage",
            team: "T123",
            channel: "C123",
            ts: "900.000",
            threadTs: "900.000",
          }),
        ],
      );
    }),
  );

  it.effect("executes Slack writes in plan order", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([
          slackStep(0, "slack.send-message", { message: "Hello" }),
          slackStep(1, "slack.reply-in-thread", { reply: "On it" }),
          slackStep(2, "slack.add-reaction", {}, [{ id: "emoji", value: "eyes" }]),
          slackStep(3, "slack.draft-reply-in-slack", { reply: "Looks good" }),
        ]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const result = yield* executeWorkflowActionPlan(initial, slackAdmission);

      assert.strictEqual(result._tag, "Complete");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "send:C456:Hello:write-0",
        "reply:900.000:On it:write-1",
        "reaction:900.000:eyes",
        "draft:900.000:Looks good",
      ]);
      assert.isNull(yield* store.pending(initial.item, initial.workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("retries Slack 429 on the next execution with the same plan", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.send-message", { message: "rate-limit" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, slackAdmission);
      const pending = yield* store.pending(initial.item, initial.workflow);
      const second = yield* executeWorkflowActionPlan(pending ?? initial, slackAdmission);

      assert.strictEqual(first._tag, "Retry");
      assert.strictEqual(second._tag, "Complete");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "send:C456:rate-limit:write-0",
        "send:C456:rate-limit:write-0",
      ]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("records the posted timestamp and write origin before the next step retries", () =>
    Effect.gen(function* () {
      const initial = WorkflowActionPlan.make({
        ...plan([
          slackStep(0, "slack.send-message", { message: "Hello" }),
          slackStep(1, "slack.send-message", { message: "rate-limit" }),
        ]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const result = yield* executeWorkflowActionPlan(initial, slackAdmission);
      const saved = yield* store.pending(initial.item, initial.workflow);

      assert.strictEqual(result._tag, "Retry");
      const artifact = saved?.steps[0]?.artifact;
      assert.deepInclude(artifact, {
        team: slackTeam,
        channel: decodeSlackChannel("C456"),
        ts: decodeSlackTs("901.000"),
        threadTs: null,
      });
      assert.strictEqual(artifact?.origin.writeKey, "write-0");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks an unknown draft outcome and never drafts it again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.draft-reply-in-slack", { reply: "unknown" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, slackAdmission);
      const saved = yield* store.pending(initial.item, initial.workflow);
      const second = yield* executeWorkflowActionPlan(saved ?? initial, slackAdmission);

      assert.strictEqual(first._tag, "Parked");
      assert.strictEqual(second._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["draft:900.000:unknown"]);
      assert.deepInclude((yield* Ref.get(probe.parks))[0]?.reason, {
        _tag: "DraftOutcomeUnknown",
        step: "slack.draft-reply-in-slack",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks an in-flight draft after a crash without drafting again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.draft-reply-in-slack", { reply: "crash" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const crashed = yield* Effect.exit(executeWorkflowActionPlan(initial, slackAdmission));
      const inFlight = yield* store.pending(initial.item, initial.workflow);
      const recovered = yield* Effect.exit(executeWorkflowActionPlan(inFlight ?? initial, slackAdmission));

      assert.strictEqual(crashed._tag, "Failure");
      assert.strictEqual(inFlight?.steps[0]?.status, "executing");
      assert.strictEqual(recovered._tag, "Success");
      if (recovered._tag === "Success") assert.strictEqual(recovered.value._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["draft:900.000:crash"]);
      assert.strictEqual((yield* Ref.get(probe.parks))[0]?.reason._tag, "DraftOutcomeUnknown");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("retries the park after an unknown draft outcome without drafting again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.draft-reply-in-slack", { reply: "unknown" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);
      yield* Ref.set(probe.parkFailures, 1);

      const crashed = yield* Effect.exit(executeWorkflowActionPlan(initial, slackAdmission));
      const inFlight = yield* store.pending(initial.item, initial.workflow);
      const recovered = yield* executeWorkflowActionPlan(inFlight ?? initial, slackAdmission);

      assert.strictEqual(crashed._tag, "Failure");
      assert.strictEqual(inFlight?.steps[0]?.status, "executing");
      assert.strictEqual(recovered._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["draft:900.000:unknown"]);
      assert.strictEqual((yield* Ref.get(probe.parks))[0]?.reason._tag, "DraftOutcomeUnknown");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
