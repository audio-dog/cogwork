import { type OperationAvailability, WorkspaceConfig } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { Availability } from "./availability";
import type { RegisteredWorkspace } from "./projector";

const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "workspace",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
  }),
};

const unavailable: OperationAvailability = {
  operation: "implement",
  available: false,
  causes: [
    {
      _tag: "UnsatisfiedNeed",
      need: "review",
      kind: "skill",
      reason: "unbound",
      contribution: null,
      message: "review is unbound",
    },
  ],
};

it.effect("keeps only the current ephemeral availability conclusion", () =>
  Effect.gen(function* () {
    const availability = yield* Availability;
    assert.deepStrictEqual(yield* availability.current(workspace), []);

    yield* availability.record(workspace, unavailable);
    assert.deepStrictEqual(yield* availability.current(workspace), [unavailable]);

    const ready: OperationAvailability = { operation: "implement", available: true, causes: [] };
    yield* availability.record(workspace, ready);
    assert.deepStrictEqual(yield* availability.current(workspace), [ready]);
  }).pipe(Effect.provide(Availability.layer)),
);

it.effect("expires an unavailable conclusion", () =>
  Effect.gen(function* () {
    const availability = yield* Availability;
    yield* availability.record(workspace, unavailable);
    yield* TestClock.adjust("1 minute");

    assert.deepStrictEqual(yield* availability.current(workspace), []);
  }).pipe(Effect.provide(Availability.layer)),
);
