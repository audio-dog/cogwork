import { HarnessName } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { memoryPersistence } from "@tanstack/ai-persistence";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type HarnessExecution, make, stageResultSchema } from "./harness";

const name = Schema.decodeSync(HarnessName)("unsupported");

const harnessServices = {
  sessionStore: {
    persistence: memoryPersistence(),
    resumeHandle: () => Effect.succeed(null),
    mint: () => Effect.die("unexpected mint"),
  },
  contextAssembler: {
    assemble: () => Effect.die("unexpected context assembly"),
  },
  credentialStore: {
    bearerToken: () => Effect.die("unexpected bearer lookup"),
    persist: () => Effect.die("unexpected credential persistence"),
    invalidate: () => Effect.die("unexpected credential invalidation"),
    providerKey: () => Effect.die("unexpected provider key lookup"),
    persistProviderKey: () => Effect.die("unexpected provider key persistence"),
  },
};

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

  it.effect("prepares the follow-up result as a validating Standard JSON Schema", () =>
    Effect.gen(function* () {
      const schema = stageResultSchema("follow-up");
      if (!schema) return assert.fail("follow-up stage has no result schema");

      const result = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "follow-up",
            outcome: "pushed",
            summary: "Fixed the failing check and pushed.",
          }),
        ),
      );
      assert.isUndefined(result.issues);

      const invalid = yield* Effect.promise(() =>
        Promise.resolve(
          schema["~standard"].validate({
            _tag: "follow-up",
            outcome: "pushed",
            summary: " ",
          }),
        ),
      );
      assert.isDefined(invalid.issues);
    }),
  );

  it("does not prepare a structured result for stages still using their existing protocols", () => {
    assert.isUndefined(stageResultSchema("verify"));
  });
});

describe("Harness", () => {
  it.effect("refuses every unsupported hard posture before runner launch", () =>
    Effect.gen(function* () {
      const postures = [
        {
          expected: "non-interactive",
          execution: { nonInteractive: false, worktreeConfined: true, profiles: ["read-only"] },
        },
        {
          expected: "worktree confinement",
          execution: { nonInteractive: true, worktreeConfined: false, profiles: ["read-only"] },
        },
        {
          expected: "read-only operation posture",
          execution: { nonInteractive: true, worktreeConfined: true, profiles: [] },
        },
      ] satisfies ReadonlyArray<{ readonly expected: string; readonly execution: HarnessExecution }>;

      for (const posture of postures) {
        const harness = make(
          [
            {
              name,
              sessionKind: "opaque-handle",
              execution: posture.execution,
              run: () => Stream.succeed({ type: "RUN_STARTED" }),
            },
          ],
          harnessServices,
        );
        const error = yield* harness
          .run({
            harness: name,
            stage: "triage",
            profile: "read-only",
            skill: "triage-agent",
            checkoutPath: "/repo",
            session: null,
            prompt: "triage the issue",
            model: null,
            effort: null,
            mcpSkills: [],
          })
          .pipe(Stream.runDrain, Effect.flip);

        assert.match(error.message, new RegExp(`unsupported.*${posture.expected}`));
      }
    }),
  );
});
