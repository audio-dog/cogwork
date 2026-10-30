import { WorkflowTouchpointFailure, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestConsole } from "effect/testing";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { cli } from "./cli";
import { formatHandBackResult, handBackError, makeHandBackRequest } from "./hand-back-command";

const workspaceId = Schema.decodeSync(WorkspaceId);
const workItemId = Schema.decodeSync(WorkItemId);
describe("hand-back command", () => {
  it.effect("builds the daemon request with the named Workflow item and note", () =>
    Effect.gen(function* () {
      const request = yield* makeHandBackRequest({
        workspace: "cogwork",
        item: "284",
        note: "worktree setup repaired",
      });

      assert.deepStrictEqual(request, {
        item: {
          _tag: "Issue",
          workspace: workspaceId("cogwork"),
          id: workItemId("284"),
        },
        note: "worktree setup repaired",
      });
      assert.strictEqual(formatHandBackResult(request), "Handed back issue:cogwork:284");
    }),
  );

  it.effect("omits the note when none is given", () =>
    Effect.gen(function* () {
      const request = yield* makeHandBackRequest({
        workspace: "cogwork",
        item: "284",
      });

      assert.deepStrictEqual(request, {
        item: {
          _tag: "Issue",
          workspace: workspaceId("cogwork"),
          id: workItemId("284"),
        },
      });
    }),
  );

  it.effect("rejects an empty workspace as a clear CLI error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeHandBackRequest({ workspace: "", item: "284" }));

      assert.strictEqual(error._tag, "UserError");
      assert.include(error.message, "Invalid hand-back input");
    }),
  );

  it("turns a touchpoint failure into a clear CLI error", () => {
    const error = handBackError(
      new WorkflowTouchpointFailure({ reason: "not-found", message: "No pending Workflow item" }),
    );

    assert.strictEqual(error._tag, "UserError");
    assert.strictEqual(error.message, "Could not hand back the work item: No pending Workflow item");
  });

  it("removes terminal controls from daemon errors", () => {
    const error = handBackError(
      new WorkflowTouchpointFailure({
        reason: "unavailable",
        message: "safe\u001b[2Jmessage\nINJECTED",
      }),
    );

    assert.strictEqual(error.message, "Could not hand back the work item: safe[2Jmessage INJECTED");
  });

  it.effect("appears in root help", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.1" })(["--help"]).pipe(
        Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
      );

      assert.include((yield* TestConsole.logLines).join("\n"), "hand-back");
    }),
  );
});
