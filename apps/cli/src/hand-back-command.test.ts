import {
  ClassifiedItem,
  IssueTrackerError,
  WorkItemId,
  WorkItemNotFound,
  WorkspaceId,
} from "@cogwork/contracts";
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
const classifiedItem = Schema.decodeSync(ClassifiedItem);

const eligible = classifiedItem({
  _tag: "Eligible",
  id: "284",
  title: "Hand back from the CLI",
  stage: "implement",
});

describe("hand-back command", () => {
  it.effect("builds the daemon request with the named item, role, and note", () =>
    Effect.gen(function* () {
      const request = yield* makeHandBackRequest({
        workspace: "cogwork",
        item: "284",
        role: "ready-for-agent",
        note: "worktree setup repaired",
      });

      assert.deepStrictEqual(request, {
        workspace: workspaceId("cogwork"),
        workItem: workItemId("284"),
        role: "ready-for-agent",
        note: "worktree setup repaired",
      });
      assert.strictEqual(
        formatHandBackResult(eligible, request),
        "Handed back implement 284 Hand back from the CLI",
      );
    }),
  );

  it.effect("omits the note when none is given", () =>
    Effect.gen(function* () {
      const request = yield* makeHandBackRequest({
        workspace: "cogwork",
        item: "284",
        role: "ready-for-agent",
      });

      assert.deepStrictEqual(request, {
        workspace: workspaceId("cogwork"),
        workItem: workItemId("284"),
        role: "ready-for-agent",
      });
    }),
  );

  it.effect("rejects an empty workspace as a clear CLI error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        makeHandBackRequest({ workspace: "", item: "284", role: "ready-for-agent" }),
      );

      assert.strictEqual(error._tag, "UserError");
      assert.include(error.message, "Invalid hand-back input");
    }),
  );

  it("turns an unknown workspace or item into a clear CLI error", () => {
    const error = handBackError(
      new WorkItemNotFound({
        workspace: workspaceId("missing-workspace"),
        workItem: workItemId("missing-item"),
      }),
    );

    assert.strictEqual(error._tag, "UserError");
    assert.strictEqual(
      error.message,
      'No parked work item "missing-item" was found in workspace "missing-workspace".',
    );
  });

  it("turns an issue tracker failure into a clear CLI error", () => {
    const error = handBackError(
      new IssueTrackerError({ reason: "unavailable", message: "tracker unavailable" }),
    );

    assert.strictEqual(error._tag, "UserError");
    assert.strictEqual(error.message, "Could not hand back the work item: tracker unavailable");
  });

  it("removes terminal controls from daemon errors", () => {
    const error = handBackError(
      new IssueTrackerError({ reason: "unavailable", message: "safe\u001b[2Jmessage\nINJECTED" }),
    );

    assert.strictEqual(error.message, "Could not hand back the work item: safe[2Jmessage INJECTED");
  });

  it.effect("reports a successful handback that removes the item from classification", () =>
    Effect.gen(function* () {
      const request = yield* makeHandBackRequest({
        workspace: "cogwork",
        item: "284",
        role: "wontfix",
      });

      assert.strictEqual(formatHandBackResult(null, request), "Handed back 284 as wontfix");
    }),
  );

  it.effect("appears in root help", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.1" })(["--help"]).pipe(
        Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
      );

      assert.include((yield* TestConsole.logLines).join("\n"), "hand-back");
    }),
  );
});
