import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defaultPriority,
  FollowUpStageResult,
  FollowUpStageResultCompletion,
  ImplementStageResult,
  LifecycleStage,
  priorityRank,
  resolvePriority,
  StageResult,
  stageResultCompletionSchema,
  stageResultJsonSchema,
  TriageStageResult,
} from "./triage";

describe("StageResult", () => {
  it.effect("decodes a tagged triage result with a canonical role and non-empty proposal", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(StageResult)({
        _tag: "triage",
        role: "ready-for-agent",
        proposal: "  Ship the verified fix.  ",
      });

      assert.isTrue(Schema.is(TriageStageResult)(result));
      if (result._tag !== "triage") return assert.fail("expected a triage result");
      assert.strictEqual(result.role, "ready-for-agent");
      assert.strictEqual(result.proposal, "Ship the verified fix.");
    }),
  );

  it.effect("rejects an empty triage proposal", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Schema.decodeEffect(StageResult)({
          _tag: "triage",
          role: "ready-for-agent",
          proposal: "   ",
        }),
      );

      assert.strictEqual(error._tag, "SchemaError");
    }),
  );

  it.effect("rejects needs-triage as a terminal triage result", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Schema.decodeUnknownEffect(StageResult)({
          _tag: "triage",
          role: "needs-triage",
          proposal: "Run triage again.",
        }),
      );

      assert.strictEqual(error._tag, "SchemaError");
    }),
  );

  it.effect("decodes an implement result with a summary", () =>
    Effect.gen(function* () {
      const encoded: unknown = {
        _tag: "implement",
        outcome: "opened-pr",
        summary: "Opened PR #110.",
        title: null,
        body: null,
      };
      const result = yield* Schema.decodeUnknownEffect(StageResult)(encoded);

      if (!ImplementStageResult.guards["opened-pr"](result)) {
        return assert.fail("expected an opened-pr implement result");
      }
      assert.strictEqual(result.summary, "Opened PR #110.");
    }),
  );

  it.effect("decodes a ready-for-pr implement result with pull request content", () =>
    Effect.gen(function* () {
      const encoded: unknown = {
        _tag: "implement",
        outcome: "ready-for-pr",
        summary: "Implementation complete.",
        title: "Open pull requests from the engine",
        body: "Closes #474",
      };
      const result = yield* Schema.decodeUnknownEffect(StageResult)(encoded);

      if (!ImplementStageResult.guards["ready-for-pr"](result)) {
        return assert.fail("expected a ready-for-pr implement result");
      }
      assert.strictEqual(result.title, "Open pull requests from the engine");
      assert.strictEqual(result.body, "Closes #474");
    }),
  );

  it.effect("rejects an implement result without a summary", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Schema.decodeEffect(StageResult)({
          _tag: "implement",
          outcome: "stuck",
          summary: "   ",
        }),
      );

      assert.strictEqual(error._tag, "SchemaError");
    }),
  );

  it.effect("decodes a follow-up result with a summary", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(StageResult)({
        _tag: "follow-up",
        outcome: "noop",
        summary: "  Checks already green.  ",
        speak: true,
      });

      if (!Schema.is(FollowUpStageResult)(result)) return assert.fail("expected a follow-up result");
      FollowUpStageResult.match(result, {
        pushed: () => assert.fail("expected a noop follow-up result"),
        noop: (noop) => {
          assert.strictEqual(noop.summary, "Checks already green.");
          assert.isTrue(noop.speak);
        },
        stuck: () => assert.fail("expected a noop follow-up result"),
      });
    }),
  );

  it.effect("rejects a noop follow-up result without a speaking decision", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Schema.decodeUnknownEffect(StageResult)({
          _tag: "follow-up",
          outcome: "noop",
          summary: "Checks already green.",
        }),
      );

      assert.strictEqual(error._tag, "SchemaError");
    }),
  );

  it.effect("decodes a structured follow-up completion through the shared schema", () =>
    Effect.gen(function* () {
      const completion = yield* Schema.decodeEffect(FollowUpStageResultCompletion)({
        raw: '{"_tag":"follow-up","outcome":"pushed","summary":"Fixed it."}',
        object: {
          _tag: "follow-up",
          outcome: "pushed",
          summary: "Fixed it.",
        },
      });

      assert.strictEqual(completion.object._tag, "follow-up");
      assert.strictEqual(completion.object.outcome, "pushed");
    }),
  );

  it("returns schemas for every operation", () => {
    for (const operation of LifecycleStage.literals) {
      assert.isDefined(stageResultJsonSchema(operation));
      assert.isDefined(stageResultCompletionSchema(operation));
    }
    assert.strictEqual(stageResultCompletionSchema("follow-up"), FollowUpStageResultCompletion);
  });

  it("projects implement results as a structured-output-compatible root object", () => {
    const schema = stageResultJsonSchema("implement")["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    assert.strictEqual(schema.type, "object");
    assert.notProperty(schema, "anyOf");
    assert.sameMembers(Array.isArray(schema.required) ? schema.required : [], [
      "_tag",
      "outcome",
      "summary",
      "title",
      "body",
    ]);
  });

  it.effect("rejects null pull request content through the structured-output schema", () =>
    Effect.gen(function* () {
      const schema = stageResultJsonSchema("implement");
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "ready-for-pr",
            summary: "Implementation complete.",
            title: null,
            body: null,
          }),
        ),
      );

      assert.isDefined(result.issues);
    }),
  );

  it("projects follow-up results as a structured-output-compatible root object", () => {
    const schema = stageResultJsonSchema("follow-up")["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    assert.strictEqual(schema.type, "object");
    assert.notProperty(schema, "anyOf");
    assert.sameMembers(Array.isArray(schema.required) ? schema.required : [], [
      "_tag",
      "outcome",
      "summary",
      "speak",
    ]);
  });

  it.effect("rejects a null speaking decision for noop through the structured-output schema", () =>
    Effect.gen(function* () {
      const schema = stageResultJsonSchema("follow-up");
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "follow-up",
            outcome: "noop",
            summary: "Checks already green.",
            speak: null,
          }),
        ),
      );

      assert.isDefined(result.issues);
    }),
  );
});

describe("resolvePriority", () => {
  it("maps each canonical name straight through", () => {
    for (const priority of priorityRank) {
      assert.strictEqual(resolvePriority(priority), priority);
    }
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    assert.strictEqual(resolvePriority("Urgent"), "urgent");
    assert.strictEqual(resolvePriority("  HIGH "), "high");
    assert.strictEqual(resolvePriority("Low"), "low");
  });

  it("resolves an absent value to the default", () => {
    assert.strictEqual(resolvePriority(null), defaultPriority);
    assert.strictEqual(resolvePriority(undefined), defaultPriority);
    assert.strictEqual(defaultPriority, "medium");
  });

  it("resolves an unrecognized value to the default", () => {
    assert.strictEqual(resolvePriority("no priority"), "medium");
    assert.strictEqual(resolvePriority("critical"), "medium");
    assert.strictEqual(resolvePriority(""), "medium");
  });

  it("orders urgent highest and low lowest", () => {
    assert.deepStrictEqual([...priorityRank], ["urgent", "high", "medium", "low"]);
  });
});
