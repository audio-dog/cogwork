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
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(jsonSchema);
      assert.include(serialized, '"_tag"');
      assert.include(serialized, '"role"');
      assert.include(serialized, '"proposal"');

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
    }),
  );

  it("does not prepare a structured result for stages still using their existing protocols", () => {
    assert.isUndefined(stageResultSchema("implement"));
    assert.isUndefined(stageResultSchema("follow-up"));
    assert.isUndefined(stageResultSchema("verify"));
  });
});
