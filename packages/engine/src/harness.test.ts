import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stageResultSchema } from "./harness";

describe("stageResultSchema", () => {
  it.effect("prepares the triage result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("triage");
      if (!schema) return assert.fail("triage stage has no result schema");

      const jsonSchema = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      const root = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          type: Schema.Literal("object"),
          properties: Schema.Record(Schema.String, Schema.Unknown),
          required: Schema.Array(Schema.String),
        }),
      )(jsonSchema);
      assert.hasAllKeys(root.properties, ["_tag", "role", "proposal"]);
      assert.deepStrictEqual([...root.required].sort(), ["_tag", "proposal", "role"]);

      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "triage",
            role: "ready-for-agent",
            proposal: "Verified and ready.",
          }),
        ),
      );
      assert.isUndefined(result.issues);

      const invalid = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "triage",
            role: "needs-triage",
            proposal: "Run triage again.",
          }),
        ),
      );
      assert.isDefined(invalid.issues);
    }),
  );

  it.effect("prepares the implement result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("implement");
      if (!schema) return assert.fail("implement stage has no result schema");

      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "opened-pr",
            summary: "Opened PR #110.",
          }),
        ),
      );
      assert.isUndefined(result.issues);

      const invalid = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "implement",
            outcome: "opened-pr",
            summary: " ",
          }),
        ),
      );
      assert.isDefined(invalid.issues);
    }),
  );

  it("does not prepare a structured result for stages still using their existing protocols", () => {
    assert.isUndefined(stageResultSchema("follow-up"));
    assert.isUndefined(stageResultSchema("verify"));
  });
});
