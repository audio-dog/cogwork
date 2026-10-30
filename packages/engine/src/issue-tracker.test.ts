import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  IssueTrackerError,
  type IssueTrackerService,
  releaseClaim,
  unsupportedWorkflowActions,
} from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

const id = Schema.decodeSync(WorkItemId);

const workspace: RegisteredWorkspace = {
  source: "a.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "a",
    checkoutPath: "/repos/a",
    issueTracker: { type: "github" },
  }),
};

const stub = (over: Partial<IssueTrackerService>): IssueTrackerService =>
  ({
    rateLimitScope: () => null,
    observe: () => Effect.succeed([]),
    readProse: () => Effect.succeed({ body: "", comments: [] }),
    claim: () => Effect.void,
    release: () => Effect.void,
    note: () => Effect.void,
    triaged: () => Effect.void,
    implemented: () => Effect.void,
    followedUp: () => Effect.void,
    attemptFailed: () => Effect.void,
    handOff: () => Effect.void,
    handBack: () => Effect.void,
    stalled: () => Effect.void,
    reclassify: () => Effect.void,
    ...unsupportedWorkflowActions,
    ...over,
  }) satisfies IssueTrackerService;

const unavailable = new IssueTrackerError({ reason: "unavailable", message: "tracker down" });

describe("releaseClaim", () => {
  it.effect("releases the claim through the tracker", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const tracker = stub({
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
      });
      yield* releaseClaim(tracker)(workspace, id("#1"));
      assert.deepStrictEqual(yield* Ref.get(released), [id("#1")]);
    }),
  );

  it.effect("tolerates a tracker failure with a warning instead of failing", () =>
    Effect.gen(function* () {
      const tracker = stub({ release: () => Effect.fail(unavailable) });
      const exit = yield* releaseClaim(tracker)(workspace, id("#1")).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Success");
    }),
  );
});
